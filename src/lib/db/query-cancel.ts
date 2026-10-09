/**
 * The one test of whether a provider can cancel a running statement (#1364).
 *
 * Cancellation is optional surface: a provider that can stop its engine's statement
 * implements `cancelQuery(queryId)`, and one that cannot (Cassandra, libSQL) leaves it out.
 * Three readers ask the question: `POST /api/db/query`
 * (whether to hand the run's id to the provider), `POST /api/db/cancel` (whether to refuse
 * with 400) and `POST /api/db/provider-meta` (the `supportsQueryCancel` capability the editor
 * gates its Cancel button on). They ask it here so the answer the editor reads is the one
 * the routes act on.
 */

/** A provider that can be asked to stop the statement it runs under `queryId`. */
export interface QueryCancelProvider {
  /** Resolves true only when the engine stopped the statement; false when it did not or could not. */
  cancelQuery(queryId: string): Promise<boolean>;
}

export function supportsQueryCancel(provider: object): provider is QueryCancelProvider {
  return typeof (provider as { cancelQuery?: unknown }).cancelQuery === "function";
}
