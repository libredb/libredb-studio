import { NextRequest } from "next/server";
import {
  ObjectRouteError,
  handleObjectRequest,
  optionalStringArray,
  readBoundedJson,
  requireString,
} from "@/lib/api/object-route";
import { isObjectEditOutcomeShape, isObjectEditPlanShape } from "@/lib/api/object-edit-wire";
import { verifyPlanToken } from "@/lib/api/object-edit-plan-token";
import { ApiErrorCode } from "@/lib/api/error-codes";
import {
  EDIT_BODY_BYTE_LIMIT,
  EDIT_PLAN_EXECUTABLE_LIMIT,
  auditReadingFor,
  planExecutableLength,
} from "@/lib/db/object-edit";
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
import { requireEditableKind } from "@/lib/db/object-kinds";
import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { ObjectEditOutcome, ObjectEditPlan } from "@/lib/db/types";

export const dynamic = "force-dynamic";

const ROUTE = "api/db/objects/edit-apply";

/**
 * `POST /api/db/objects/edit-apply`: the half that WRITES (#789 Phase 3, discussion #778).
 *
 * IT TAKES THE PLAN AND NEVER THE TEXT AGAIN, which is ruling 1a in the letter: the bytes the user
 * approved in the preview are `plan.unit`, and `plan.unit` is what the engine receives. The seal
 * (`planToken`) is what makes that binding unforgeable while leaving the plan READABLE, which is
 * adjudication 2d: "opaque" means sealed, not unreadable.
 *
 * THIS IS THE FIRST RECORD OF A USER'S WRITE ANYWHERE IN THIS PRODUCT, and ruling 1c is why it is a
 * new `AuditEventType` arm rather than a reused `query_execution`: MEASURED, three DDL statements
 * through `POST /api/db/query` added ZERO events to the ring while one VACUUM on the same
 * connection in the same minute added exactly one.
 *
 * THE TWO EVENTS AND WHY THEY ARE TWO. The DECISION event is emitted BEFORE the provider is called
 * and is NOT wrapped in a try/catch, so any audit-sink failure propagates and the apply never
 * happens: the path fails closed on an unauditable write rather than performing it silently. That
 * is `src/lib/db/operations/execution.ts:11-20`'s rule for the agent path, applied here for the
 * same reason. The OUTCOME event is emitted after and IS wrapped, which is
 * `src/app/api/db/maintenance/route.ts:108-131`'s rule and its stated reason: the engine has
 * already acted, and a broken sink must never turn a completed apply into a 500 that invites a
 * retry that would be a SECOND DDL.
 *
 * WHAT AN EVENT MAY NEVER CARRY: the statement, the command payload, the reader's text, the
 * pre-image, the engine's message, the engine's code, the revision token, the plan token, or any
 * other part of the plan. `src/lib/audit.ts:456-461` forbids SQL text, request bodies and raw
 * `Error.message` by name, `AuditReason` is closed precisely so no path can put a driver string
 * into a record, and `MAX_AUDIT_FIELD_LENGTH` is 254, so an unvalidated string would be TRUNCATED
 * rather than refused. What the two events carry instead is the object address, the kind, the part,
 * the resolved strategy and one correlation id, which is `plan.planId`.
 *
 * `target` IS `plan.path.join("/")`, which is design 5.5's own spelling and is used here unchanged,
 * with its limit named rather than discovered: it is a FOURTH spelling of a path key in a
 * repository whose `pathKey` docblock says by name that a slash collides, so `["a/b"]` and
 * `["a","b"]` produce the same audit target. It is inherited rather than introduced, the audit
 * target is a human-readable label and never a lookup key, and changing it here would put the
 * audit's spelling out of step with the design.
 *
 * NO ADMIN GATE, and the ruling is MEASURED rather than preferred: it is recorded in full on
 * `edit-plan/route.ts` beside the same decision, with the limit that the measurement covers SQL
 * engines and Redis was not probed. This route inherits the seed role filter for free by going
 * through `resolveConnection` and adds no role test of its own.
 *
 * ONCE `applyObjectEdit` HAS BEEN CALLED, NO ERROR ESCAPES AS AN HTTP ERROR. Every throw becomes
 * `{ outcome: "interrupted", committed: "unknown" }` at 200, and so does an answer the outcome
 * predicate cannot read. That one rule closes three measured defects at once: a deliberate engine
 * refusal can never be a 500, a timeout can never answer `retryable: true`, and a provider that
 * forgets to classify one of its engine's errors degrades to "the disposition is unknown" rather
 * than to a false success. There is NO `retryable` on this route at any status: a client that
 * retries an apply whose disposition is unknown applies twice.
 */
export async function POST(req: NextRequest) {
  return handleObjectRequest(
    req,
    ROUTE,
    async (provider, body, context) => {
      // 1. THE SHAPE, BEFORE THE SEAL. The seal's own refusal emits an audit event that reads
      //    `plan.kind`, `plan.path` and `plan.planId`, and a body that is not a plan has none of
      //    them, so checking the seal first would write `undefined:undefined:undefined` into an
      //    operator's log. It is also design 7.9's second seam: a `command` unit carrying `steps`
      //    compiles, and only this predicate stops it.
      const plan: unknown = body.plan;
      if (!isObjectEditPlanShape(plan)) {
        throw new ObjectRouteError('"plan" must be an object edit plan this server can read', 400);
      }
      const planToken = requireString(body, "planToken");
      const audit = auditFields(plan, context);

      // 2. THE SEAL, against the fingerprint of the connection THIS request resolved. The
      //    fingerprint is recomputed here and never taken from the plan, which is the whole of the
      //    different-server check: a plan is bound to a SERVER and never to `connection.id`, and
      //    MEASURED, `resolveConnection` returns an inline connection object verbatim, id included,
      //    so an id check is satisfied by a caller typing the id it wants.
      const verdict = await verifyPlanToken(planToken, plan, await connectionFingerprint(context.connection));
      if (!verdict.valid) {
        // ONE event, and no provider call. A refused plan is a decision this route made about a
        // write that never happened, and it is the one an operator most needs to see.
        emitAuditEvent({ ...audit, result: "failure", reason: "object_edit_plan_invalid" });
        throw new ObjectRouteError(verdict.reason, 400, ApiErrorCode.EDIT_PLAN_INVALID);
      }

      // 3. THE EXECUTABLE BOUND, RE-CHECKED HERE, enforcing rather than trusting (design 5.2). A
      //    valid token proves the plan is the one this server issued; it proves NOTHING about what
      //    this server's bound is TODAY. A plan minted before the bound moved, or by a build path a
      //    later phase adds, meets the number here rather than the framework's silent truncation.
      //    The sentence is the same sentence `edit-plan/route.ts` answers, written out in both
      //    files because a Next route module may export nothing but its handler.
      const executable = planExecutableLength(plan.unit);
      if (executable > EDIT_PLAN_EXECUTABLE_LIMIT) {
        throw new ObjectRouteError(
          `this apply would send ${executable} characters and this server sends at most ` +
            `${EDIT_PLAN_EXECUTABLE_LIMIT}`,
          400,
        );
      }

      // 4. THE ACKNOWLEDGEMENT, enforced by the SERVER. A client-only confirmation satisfies
      //    nothing a server can assert: the shipped query confirmation is a client modal with a
      //    `skipSafety` bypass. Every consequence class the plan names must be in `acknowledged`,
      //    and an acknowledgement of some other class is not an acknowledgement of this one.
      const acknowledged = optionalStringArray(body, "acknowledged") ?? [];
      const unacknowledged = plan.consequences.filter((consequence) => !acknowledged.includes(consequence.loses));
      if (unacknowledged.length > 0) {
        throw new ObjectRouteError(
          `this apply destroys something the plan warned about and the request did not acknowledge: ` +
            `${unacknowledged.map((consequence) => consequence.loses).join(", ")}`,
          400,
        );
      }

      // 5. EDITABILITY, re-resolved on the CONNECTED provider (D57). `requireEditableKind` throws a
      //    `QueryError`, which `createErrorResponse` already answers 400 with the refusal's own
      //    sentence, so it is not re-wrapped: two mappings of one refusal is how two sentences
      //    drift apart.
      requireEditableKind(provider.getCapabilities(), plan.kind, {
        displayName: provider.type,
        type: provider.type,
      });
      // BOUND to the provider, for `requireSourceReader`'s reason: read off the instance as a
      // value, a method reaching its own pool through `this` would be called with no receiver. The
      // absence is refused BEFORE the decision event, so an apply that could never run leaves no
      // record claiming it was about to.
      const applyEdit = provider.applyObjectEdit;
      if (applyEdit === undefined) {
        throw new ObjectRouteError(`${provider.type} declares no edit applier for kind "${plan.kind}"`, 400);
      }

      // 6. THE DECISION EVENT, NOT WRAPPED, so an unauditable apply never happens.
      emitAuditEvent({ ...audit, action: "PLAN", result: "success" });

      // 7. THE APPLY. Everything below answers 200.
      const started = Date.now();
      let outcome: ObjectEditOutcome;
      try {
        outcome = await applyEdit.call(provider, plan);
      } catch (error) {
        logger.error("Object edit apply threw", error, { route: ROUTE });
        outcome = interrupted(Date.now() - started);
      }
      if (!isObjectEditOutcomeShape(outcome)) {
        // The engine has already acted, so the honest answer is that the disposition is unknown. A
        // 400 would say the CALLER made a mistake, and a success would be the lie this arm exists
        // to prevent.
        logger.error("Object edit apply answered an outcome this server cannot read", undefined, { route: ROUTE });
        outcome = interrupted(Date.now() - started);
      }

      // 8. THE OUTCOME EVENT, in its OWN try/catch.
      try {
        const reading = auditReadingFor(outcome);
        emitAuditEvent({
          ...audit,
          action: plan.strategy,
          result: reading.result,
          ...(reading.reason === undefined ? {} : { reason: reading.reason }),
          duration: outcome.duration,
        });
      } catch (auditError) {
        logger.error("Failed to record object edit outcome audit event", auditError, { route: ROUTE });
      }

      return outcome;
    },
    { readBody: (request) => readBoundedJson(request, EDIT_BODY_BYTE_LIMIT) },
  );
}

/**
 * The fields both events share, built once so the two records cannot disagree about which object
 * was addressed or which edit they belong to.
 *
 * `action` and `result` are supplied per event and `reason` and `duration` only by the outcome, so
 * they are not here: a shared default for either would be a value one of the two events did not
 * mean.
 *
 * THE TWO FALLBACKS ARE NOT THE SAME KIND OF THING, and the difference is measured rather than
 * assumed. `connectionName`'s two arms both have a live population: `resolveConnection` returns an
 * INLINE caller-supplied connection object verbatim, so a connection whose `name` is empty is the
 * caller's to send, and both the database arm and the `"unknown"` arm are driven by
 * `tests/api/db/objects/edit-apply.test.ts`. `user`'s arm has NONE: `guardRoute` keys the rate
 * limiter on `session.username` before this handler runs, and a session without one dies at
 * `truncatedKey` in `src/lib/api/rate-limit.ts` with
 * `TypeError: undefined is not an object (evaluating 'key.slice')`, which is what a draft of that
 * test MEASURED. `SessionPayload.username` is a required `string`, so the fallback here is an
 * obligation of `ObjectRouteContext`'s looser `username?: string` and nothing more; it is kept
 * because the type requires it and because `src/app/api/db/maintenance/route.ts` spells the same
 * expression the same way.
 */
function auditFields(
  plan: ObjectEditPlan,
  context: { readonly connection: { name?: string; database?: string }; readonly session: { username?: string } },
) {
  return {
    type: "object_edit",
    action: "PLAN",
    target: `${plan.kind}:${plan.path.join("/")}:${plan.partId}`,
    details: plan.strategy,
    correlationId: plan.planId,
    connectionName: context.connection.name || context.connection.database || "unknown",
    user: context.session.username || "unknown",
  } as const;
}

/**
 * The one outcome this ROUTE may mint, and the only one it ever does.
 *
 * `committed: "unknown"` and never `"rolled-back"`: that claim may be made ONLY by a provider that
 * opened and closed the transaction itself, and this route opened nothing. The sentence carries no
 * engine words, because it is not the engine speaking: nothing arrived.
 */
function interrupted(duration: number): ObjectEditOutcome {
  return {
    outcome: "interrupted",
    committed: "unknown",
    sentence:
      "This apply was sent and no answer this server could read came back, so whether it was applied is unknown. " +
      "Re-read the object before trying again: a retry would be a second apply.",
    duration,
  };
}
