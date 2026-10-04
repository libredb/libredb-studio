/**
 * How long the Query Safety Check waits for the AI's opinion of a statement.
 *
 * The analysis is advisory: the dialog asks before a write because the editor's own reading of the
 * statement said so, and the model only adds a risk verdict. It used to hold "Execute Query" disabled
 * for as long as the model took, with no bound, so a slow, busy or hung model kept every write from
 * running at all, while a model that failed outright let it run at once. Both ends are bounded now.
 */

/**
 * How long the dialog waits before it gives up on the analysis, aborts the request, says the analysis
 * could not be completed and enables Execute. The dialog also offers "Skip analysis" for the whole wait.
 */
export const QUERY_SAFETY_ANALYSIS_TIMEOUT_MS = 15_000;

/**
 * How long `POST /api/ai/query-safety` lets the model take before it aborts the provider request and
 * answers 504 `TIMEOUT_ERROR`, or, once the stream has started, ends it.
 *
 * Longer than the dialog's wait on purpose: the dialog aborts its own request at its deadline, so this
 * bound is the backstop for a caller that does not, and it must never cut an analysis the dialog is
 * still waiting for. Not configurable, because no caller of this route waits longer than this.
 */
export const QUERY_SAFETY_ROUTE_TIMEOUT_MS = 30_000;
