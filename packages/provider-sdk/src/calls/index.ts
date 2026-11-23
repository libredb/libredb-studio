/**
 * The provider contract's calls (docs/providers/CONTRACT.md, the calls chapter): the shapes of the mandatory calls and
 * the optional console facets, the contexts the host passes them, `defineProvider` and `checkProviderModule`, which
 * make and check the record a package's entry default-exports, `envReader`, the declared environment behind
 * `ctx.env`, and the host's checks of a call: `checkExecuteRequest`, which refuses a request field the session does not
 * honour, `checkConsoleFacet`, which refuses a console facet the session does not offer, `checkRefinement` and
 * `sessionCalls`, which narrow a session's calls by the refinement `open` answers, and `freezeContext` and
 * `freezeData`, which deep-freeze the contexts and requests the host passes; and the byte budgets
 * of a result, `BATCH_MAX_BYTES` and `PAGE_MAX_BYTES`, with `encodedRowBytes`, the row measure, `rowsSource`, a batch
 * holder for rows already in memory, and `pumpPage`, the host's pump that cuts a page by size and hands each pull its
 * own row measure, so each row is measured once; and a call's deadline:
 * `deadlineSignal`, the signal that aborts at it, `checkCallStart`, which refuses a call that would start after its
 * deadline passed or its signal aborted, and `awaitWithin`, the host's wait on an answer, ended by that signal, which
 * hands an abandoned answer's late outcome to the host; and `cleanupContext`, the context of a cleanup call of its own,
 * `CLEANUP_DEADLINE_MS` ahead; and `DEFAULT_CONNECT_BUDGET_MS`, how long the host waits for an open of an engine that
 * declares no connect budget of its own.
 */
export {
  checkProviderModule,
  DEFINITION_REFUSAL_RULES,
  type DefinitionRefusal,
  type DefinitionRefusalRule,
  defineProvider,
  definitionRefusalSentence,
  ProviderDefinitionError,
} from "./define-provider";
export {
  awaitWithin,
  CLEANUP_DEADLINE_MS,
  checkCallStart,
  cleanupContext,
  DEFAULT_CONNECT_BUDGET_MS,
  deadlineSignal,
  type LateOutcome,
} from "./deadline";
export { type EnvReader, envReader, UndeclaredEnvironmentError } from "./env";
export { freezeContext, freezeData } from "./freeze";
export {
  CALL_REFUSAL_RULES,
  type CallRefusal,
  CallRefusalError,
  type CallRefusalRule,
  callRefusalSentence,
} from "./refusals";
export {
  BATCH_MAX_BYTES,
  encodedRowBytes,
  PAGE_ENDS,
  PAGE_MAX_BYTES,
  type Page,
  type PageEnd,
  type PumpLimits,
  pumpPage,
  rowsSource,
} from "./results";
export { checkConsoleFacet, checkExecuteRequest, checkRefinement, sessionCalls } from "./session";
export * from "./types";
