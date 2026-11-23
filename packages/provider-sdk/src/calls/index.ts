/**
 * The provider contract's calls (docs/providers/CONTRACT.md, the calls chapter): the shapes of the mandatory calls and
 * the optional console facets, the contexts the host passes them, `defineProvider` and `checkProviderModule`, which
 * make and check the record a package's entry default-exports, `envReader`, the declared environment behind
 * `ctx.env`, and the host's checks of a call: `checkExecuteRequest`, which refuses a request field the session does not
 * honour, `checkRefinement` and `sessionCalls`, which narrow a session's calls by the refinement `open` answers, and
 * `freezeContext` and `freezeData`, which deep-freeze the contexts and requests the host passes; and the byte budgets
 * of a result, `BATCH_MAX_BYTES` and `PAGE_MAX_BYTES`, with `encodedRowBytes`, the row measure, `rowsSource`, a batch
 * holder for rows already in memory, and `pumpPage`, the host's pump that cuts a page by size.
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
export { checkExecuteRequest, checkRefinement, sessionCalls } from "./session";
export * from "./types";
