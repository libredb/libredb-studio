import { buildConnectionPayload } from "@/hooks/use-connection-payload";
import { appFetch } from "@/lib/config/base-path";
import type { ObjectEditConsequenceClass, ObjectEditPlan, ObjectEditRequest } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/**
 * Who performs an object edit, and what a dialog is allowed to believe about the answer (#789
 * Phase 3, from discussion #778).
 *
 * The shape is `ObjectSourceReader`'s, in `source-reader.ts`, for the same reasons and with one
 * difference: this seam has TWO methods rather than one, because ruling 1a splits the edit into a
 * BUILD that issues a plan and an APPLY that sends that plan back and never the source text
 * again. Sealing the preview to the apply is the whole safety argument of this phase, and a
 * single-method seam could not express it.
 *
 * THE RETURN IS `unknown` ON BOTH METHODS, for both shells rather than for the embedded one
 * alone, which is exactly the reader's own reason: a route's body and a host callback's return
 * value are both ordinary values a component is about to dereference, and only one of them has a
 * type declaration. The caller narrows with `isObjectEditBuildResponseShape` and
 * `isObjectEditOutcomeShape` from `src/lib/api/object-edit-wire.ts`. Narrowing here would put a
 * second copy of those predicates on the standalone path and none at all on the embedded one,
 * where a host supplies the applier and this module never runs.
 *
 * WHAT THIS SEAM DOES WITH A HOST-SUPPLIED VALUE OF ARBITRARY SIZE, stated because it is the one
 * boundary in this phase with no second line of defence, and because leaving it unstated is how
 * an accident reads as a decision. `httpSourceApplier` NEVER sees a host value: it speaks only to
 * this application's own two routes, and both of them bound what they answer with
 * `EDIT_PLAN_EXECUTABLE_LIMIT`. On the EMBEDDED shell the applier is the host's own object, so
 * nothing in this file is on that path at all, and the value the host returns is bounded by
 * whoever narrows it. As measured at this commit, that is nobody:
 * `src/lib/api/object-edit-wire.ts` bounds no string in any of its four predicates, so the
 * unbounded arm is closed downstream by `ApplyPreviewDialog`, which refuses to draw a diff above
 * `EDIT_PLAN_EXECUTABLE_LIMIT`, and is still OPEN for every other string a host can supply
 * (`refusal.sentence`, `refusal.hint`, `plan.revision.reason`, each consequence's `fact`). That
 * is a gap this task reports and does not close here, because a bound invented at a seam that
 * only ever talks to a bounded route would be a number no host path passes through.
 *
 * `planToken` is `string | undefined` BECAUSE A HOST HAS NO KEY. The binding between a host's
 * preview and a host's apply is the host's own; this server's token does not exist there and is
 * not asked for. The client never reads the token and never constructs one: it posts back the
 * string it was given.
 */
export interface ObjectSourceApplier {
  build(connection: DatabaseConnection, request: ObjectEditRequest): Promise<unknown>;
  apply(
    connection: DatabaseConnection,
    plan: ObjectEditPlan,
    planToken: string | undefined,
    acknowledged: readonly ObjectEditConsequenceClass[],
  ): Promise<unknown>;
}

/**
 * A failed request to one of the two edit routes, carrying the route's own error CODE.
 *
 * The code is what lets a reader be told an expired plan apart from a failure: the routes answer
 * `EDIT_PLAN_INVALID` for a plan that no longer verifies, and the dialog's response to that is to
 * rebuild the preview rather than to report that the edit failed. A plain `Error` collapses the
 * two into one sentence, and the sentence alone cannot be branched on: it is prose, it is
 * localisable, and matching substrings against it is the defect this repository already carries
 * in its own error mapper (MEASURED on PostgreSQL 18.4, an ownership refusal answers HTTP 500
 * because its message matches none of the mapper's substrings).
 *
 * The code is OPTIONAL because most failures have none: a 502 from a proxy, a 413 whose status
 * already carries the fact, and every route answer whose sentence is the whole of it.
 */
export class ObjectEditRequestError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "ObjectEditRequestError";
    this.code = code;
  }
}

/** A string that carries a fact, rather than one that is present and says nothing. */
function isFilledString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * POST a JSON body to one of the two edit routes and answer the parsed body, unnarrowed.
 *
 * A route that answered with no body at all still answered something worth showing, so the status
 * stands in for the sentence rather than the request being reported as a parse error. The same
 * rule the source read uses, and the reason is the same: a proxy's HTML 502 is a real answer.
 *
 * `error` and `code` are read only when they are STRINGS, and the population is an INTERMEDIARY
 * rather than our own route: a gateway can answer JSON of its own shape, and `{ error: { message
 * } }` is a common one. A message built from a non-string prints `[object Object]` in the
 * dialog's failure region, and the code is rendered there as data.
 */
async function postJson(path: string, body: unknown, whenSilent: (status: number) => string): Promise<unknown> {
  const response = await appFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  if (!response.ok) {
    const sentence = isFilledString(parsed.error) ? parsed.error : whenSilent(response.status);
    throw new ObjectEditRequestError(sentence, isFilledString(parsed.code) ? parsed.code : undefined);
  }
  return parsed;
}

/**
 * The default applier: this application's own two routes.
 *
 * `buildConnectionPayload` sends a managed seed by id and anything else in full, which is how
 * every other db route is called and the only way a connection the server has never heard of can
 * be reached at all.
 */
export const httpSourceApplier: ObjectSourceApplier = {
  build(connection, request) {
    return postJson(
      "/api/db/objects/edit-plan",
      {
        ...buildConnectionPayload(connection),
        path: request.path,
        kind: request.kind,
        partId: request.partId,
        text: request.text,
      },
      (status) => `The apply preview could not be built: HTTP ${status}.`,
    );
  },
  apply(connection, plan, planToken, acknowledged) {
    return postJson(
      "/api/db/objects/edit-apply",
      { ...buildConnectionPayload(connection), plan, planToken, acknowledged },
      (status) => `The apply failed: HTTP ${status}.`,
    );
  },
};
