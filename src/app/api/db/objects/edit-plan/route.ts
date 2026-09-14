import { NextRequest } from "next/server";
import {
  ObjectRouteError,
  handleObjectRequest,
  readBoundedJson,
  requireObjectPath,
  requireString,
} from "@/lib/api/object-route";
import { isObjectEditPlanShape } from "@/lib/api/object-edit-wire";
import { mintPlanToken } from "@/lib/api/object-edit-plan-token";
import {
  EDIT_BODY_BYTE_LIMIT,
  EDIT_CHARACTER_LIMIT,
  EDIT_PLAN_EXECUTABLE_LIMIT,
  planExecutableLength,
} from "@/lib/db/object-edit";
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
import { requireEditableKind } from "@/lib/db/object-kinds";

export const dynamic = "force-dynamic";

/**
 * `POST /api/db/objects/edit-plan`: the BUILD half of the object edit path (#789 Phase 3,
 * discussion #778).
 *
 * It takes the reader's edited text for ONE part and answers what an apply WOULD send: a plan
 * pinning the exact bytes, the definition the build read, and a token sealing the two together.
 * It executes nothing, it writes nothing, and it EMITS NO AUDIT EVENT: it is a read, every other
 * read in this product is unaudited, and auditing one read of nine would be a signal an operator
 * would misread. The apply route is where this product's first record of a user's write lives.
 *
 * TWO ROUTES RATHER THAN ONE WITH A `phase` FIELD, so the audit's two events are a property of
 * WHICH HANDLER RAN rather than of a runtime branch, and so `edit-apply/route.ts` can be read on
 * its own to see everything it does.
 *
 * A FLAT SIBLING OF THE OTHER EIGHT and never `objects/edit/plan`. The census in
 * `tests/api/db-objects.test.ts` enumerates DIRECT children of `src/app/api/db/objects/` that hold
 * a `route.ts`, so a nested pair would leave `edit/` with no `route.ts`, the census would filter it
 * out, and two new provider-reaching routes would be uncensused and unasserted for the 401 path
 * while the census kept passing.
 *
 * NO ADMIN GATE, and the ruling is MEASURED rather than preferred. Measured end to end with three
 * controls: a `user`-role session created and dropped a function through `POST /api/db/query`, both
 * with an inline caller-supplied connection carrying superuser credentials and with a managed seed
 * connection whose roles admit `*`, while the same cookie was refused 403 at
 * `POST /api/db/maintenance` and a seed scoped to `admin` refused it 403. So the role decides WHICH
 * connection may be opened and nothing about what may be done with it, and an admin gate here would
 * remove no capability while teaching an operator that Studio restricts DDL. This route inherits
 * the seed role filter FOR FREE by going through `resolveConnection`, and it adds no role test of
 * its own. `POST /api/db/maintenance` stays the only admin-gated route that reaches a user's
 * database. THE LIMIT IS RECORDED WITH THE RULING: that measurement covers SQL engines, which is
 * two of the three day-one engines, and Redis was NOT probed, so for Redis the ruling is inherited
 * rather than measured and the plan token is doing real work there.
 *
 * `readBoundedJson` rather than the handler's default body read, because the default answers
 * `{ error: "Empty request body" }` at 400 for a body the framework TRUNCATED at 10,485,760 bytes.
 * A caller reading that sentence has no way to learn that the fix is to send less.
 */
export async function POST(req: NextRequest) {
  return handleObjectRequest(
    req,
    "api/db/objects/edit-plan",
    async (provider, body, context) => {
      const path = requireObjectPath(body);
      const kind = requireString(body, "kind");
      const partId = requireString(body, "partId");
      const text = requireString(body, "text");

      // The CHARACTER bound and not the byte bound: `readBoundedJson` above has already held the
      // whole body to `EDIT_BODY_BYTE_LIMIT`, and this is the separate question of how long ONE
      // part may be. The two are different numbers for a measured reason: one part of 1,000,000
      // UTF-16 code units is up to 6 MB once JSON-escaped, so a body inside the byte bound can
      // still carry a part above this one.
      if (text.length > EDIT_CHARACTER_LIMIT) {
        throw new ObjectRouteError(
          `this edit is ${text.length} characters and this route carries at most ${EDIT_CHARACTER_LIMIT}`,
          413,
        );
      }

      // EDITABILITY IS RE-RESOLVED ON THE CONNECTED PROVIDER, which is D57 closed on the write
      // path. The `edit` affordance the source read shipped is an AFFORDANCE and not a gate: a
      // tampered client, an old client holding a stale menu, or an embedded host that lies all
      // reach here, and `src/lib/api/object-route.ts`'s `stripEdit` says by name that deleting a
      // field from a READ response cannot bind a caller. `requireEditableKind` throws a
      // `QueryError`, which `createErrorResponse` already answers 400 with the refusal's own
      // sentence, so it is NOT re-wrapped here: two mappings of one refusal is how the two
      // sentences drift.
      requireEditableKind(provider.getCapabilities(), kind, { displayName: provider.type, type: provider.type });

      // TWO CONJUNCTS' worth of state in one branch, and the same 400 grammar `requireSourceReader`
      // uses. `buildObjectEdit` is OPTIONAL on `DatabaseProvider`, so a provider that declares an
      // editable kind and holds no method is representable, and this is the only thing that makes
      // it a refusal a caller can read rather than a `TypeError`. BOUND to the provider, because it
      // is read off the instance as a value and a method that reaches its own pool through `this`
      // would otherwise be called with no receiver.
      const build = provider.buildObjectEdit;
      if (build === undefined) {
        throw new ObjectRouteError(`${provider.type} declares no edit builder for kind "${kind}"`, 400);
      }
      const answer = await build.call(provider, { path, kind, partId, text });

      // THE HYBRID ANSWER, refused before either arm is read. `ObjectEditBuild` narrows on the
      // literal `built`, and MEASURED against tsc 6.0.3 the excess-property check on a union admits
      // any property declared on ANY member, so an answer carrying a plan AND a refusal compiles
      // with no cast. A consumer testing property presence would pick whichever it tested first,
      // and the two answers are opposite facts about the same request.
      if (Object.hasOwn(answer, "plan") && Object.hasOwn(answer, "refusal")) {
        throw new ObjectRouteError(
          "the build answered both a plan and a refusal; those are opposite facts about one request and this " +
            "route will not choose between them",
          400,
        );
      }

      if (!answer.built) return { built: false, refusal: answer.refusal };

      // THE ORDER OF THE FOUR CHECKS BELOW IS THE GUARD, and it is pinned by the suite.
      //
      // 1. THE SHAPE, before anything measures the unit. This is design 7.9's producer: the hybrid
      //    this route has to catch is not only the two-armed ANSWER above but the PLAN's own unit,
      //    a `command` carrying `steps`, which tsc admits and which the type cannot stop. Running
      //    it only on the apply route would mean a provider defect gets a sealed plan, a 200 and a
      //    token, and is refused ninety seconds later at a seam that has already emitted an audit
      //    event.
      if (!isObjectEditPlanShape(answer.plan)) {
        throw new ObjectRouteError("the build answered a plan this server cannot read as a plan", 400);
      }
      const plan = answer.plan;

      // 2. THE EXECUTABLE BOUND, which is `EDIT_PLAN_EXECUTABLE_LIMIT` and NEVER
      //    `EDIT_CHARACTER_LIMIT`. Those two answer different questions and `object-edit.ts` says
      //    so at length: a maximal readable part is 1,000,000 characters and every day-one unit
      //    WRAPS it, so a plan bound equal to the read bound refuses this route's own plan for any
      //    part within a guard block's distance of that edge. Refusing here rather than at the
      //    apply is the point: this route declines to issue a plan it already knows it will not
      //    take back. The same number is re-checked on the apply route, and the sentence is the
      //    same sentence there; the two literals are in two files because a route module may
      //    export nothing but a handler.
      const executable = planExecutableLength(plan.unit);
      if (executable > EDIT_PLAN_EXECUTABLE_LIMIT) {
        throw new ObjectRouteError(
          `this apply would send ${executable} characters and this server sends at most ` +
            `${EDIT_PLAN_EXECUTABLE_LIMIT}`,
          400,
        );
      }

      // 3. THE FINGERPRINT, computed HERE from the connection THIS request resolved and compared
      //    against the provider's. A provider cannot see the resolved connection, so a plan whose
      //    fingerprint the route did not verify would seal a value nobody checked, and the apply
      //    route's different-server refusal would be comparing two numbers that came from the same
      //    unverified source. `context.connection` and never a second `resolveConnection`: a second
      //    resolution can answer a different connection.
      if (plan.connectionFingerprint !== (await connectionFingerprint(context.connection))) {
        throw new ObjectRouteError(
          "the build answered a plan sealed against a different server than this request resolved",
          400,
        );
      }

      // 4. THE MINT, last, so no token is ever issued for a plan this route would not accept back.
      return { built: true, plan, preimage: answer.preimage, planToken: await mintPlanToken(plan) };
    },
    { readBody: (request) => readBoundedJson(request, EDIT_BODY_BYTE_LIMIT) },
  );
}
