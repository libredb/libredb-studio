/**
 * What the host refuses of a call or of its answer (docs/providers/CONTRACT.md, clauses C-9, C-10, C-15, C-17, C-27,
 * C-57, C-67, C-71 and C-78).
 *
 * One vocabulary for every such refusal, each naming its rule and a JSON Pointer rooted at the thing it names, stated
 * beside each rule. No refusal and no sentence carries a value of a request, a refinement or a row: a sentence names
 * the rule, the quoted pointer, the field or key, and for a budget the limit and the measured size, which are counts. Mapping a refusal onto Studio's error classes is
 * the host core's.
 */

/** Every rule a call refusal can name. */
export const CALL_REFUSAL_RULES = Object.freeze([
  /** A request field the session's execute does not honour; the pointer is into the request, `name` the field. */
  "request-field-not-honoured",
  /** A `scope` sent to a session that does not offer `console.endScope`; the pointer is into the request. */
  "request-scope-not-offered",
  /** A statement sent inside a transaction to a session that does not offer `console.transaction`; into the request. */
  "request-transaction-not-offered",
  /** A `scope` on a statement sent inside a transaction, which runs on the transaction's session; into the request. */
  "request-scope-in-transaction",
  /** A read-only execute sent to a session not opened under the read-only policy to be sent statements; into the request. */
  "request-read-only-not-opened",
  /** An execute without `readOnly` sent to a session opened under the read-only policy to be sent statements; into the request. */
  "request-read-only-missing",
  /** A maintenance operation the session's maintenance does not list; the pointer is into the request. */
  "request-operation-not-offered",
  /** A maintenance request field that names something sent empty; the pointer is into the request, `name` the field. */
  "request-field-empty",
  /** A maintenance run on a placement its operation's spec in the session's maintenance does not offer; into the request. */
  "request-placement-not-offered",
  /** A maintenance preview of an operation whose spec declares no preview on a row; the pointer is into the request. */
  "request-preview-not-offered",
  /** A monitoring panel the session's engine does not offer, or a request naming no panel; into the request. */
  "request-panel-not-offered",
  /** A facet the session's calls do not offer; the pointer is into the calls, `name` the facet's call name. */
  "facet-not-offered",
  /** A key a refinement cannot have; the pointer is into the refinement, `name` the key. */
  "refinement-key-unknown",
  /** A refinement value of the wrong type, an accessor or a repeated field; the pointer is into the refinement. */
  "refinement-unreadable",
  /** A refinement value that offers or honours more than the manifest declares; the pointer is into the refinement. */
  "refinement-widens",
  /** A batch that is not a plain record of exactly `rows` and `done`, both data; the pointer is into the batch. */
  "batch-malformed",
  /** A batch of more rows than it was asked for; the pointer is `/rows`, with the limit and the count. */
  "batch-over-rows",
  /** A batch of more than one row and more bytes than it was asked for; the pointer is `/rows`, with both sizes. */
  "batch-over-bytes",
  /** A row that is not an array of one cell per column; the pointer is the row's, into the batch. */
  "row-not-positional",
  /** A row larger than a whole page may hold; the pointer is the row's, with the page's bytes and the row's size. */
  "row-over-page",
  /** A batch of no row that does not say the result is done; the pointer is the batch's own. */
  "batch-empty-not-done",
  /** A call whose deadline had passed when it was to start; the pointer is into the call's context. */
  "call-deadline-passed",
  /** A call whose signal had aborted when it was to start; the pointer is into the call's context. */
  "call-signal-aborted",
  /**
   * A session state a transaction call or a statement sent inside the transaction answered that the host cannot read:
   * missing, outside the vocabulary or an accessor, a `stateReported` that is no boolean or answers another action
   * than begin, a key a transaction answer cannot have (`name` the key), or no record at all; the pointer is into the
   * answer.
   */
  "transaction-answer-unreadable",
] as const);

export type CallRefusalRule = (typeof CALL_REFUSAL_RULES)[number];

/** One way a call, or what it answered, is refused. */
export interface CallRefusal {
  readonly rule: CallRefusalRule;
  /** A JSON Pointer into the thing the rule names; the empty string is that thing itself. */
  readonly pointer: string;
  /**
   * The request field, for a field not honoured or sent empty, the facet's call name, for a facet not offered, or the key, for a key
   * a refinement or a transaction answer cannot have.
   */
  readonly name?: string;
  /** For a budget, what was asked for: a count of rows or of bytes. */
  readonly limit?: number;
  /** For a budget, what was measured, in the same unit as `limit`. */
  readonly size?: number;
}

/**
 * Thrown with every refusal of one call, its message their sentences. A call refused because its signal aborted
 * carries the signal's reason as `options.cause`, never in a refusal or the message.
 */
export class CallRefusalError extends Error {
  readonly refusals: readonly CallRefusal[];

  constructor(refusals: readonly CallRefusal[], options?: ErrorOptions) {
    super(refusals.map(callRefusalSentence).join(" "), options);
    this.name = "CallRefusalError";
    this.refusals = Object.freeze([...refusals]);
  }
}

/** `value` of `unit`, or an unstated number of them. */
function count(value: number | undefined, unit: string): string {
  return value === undefined ? `an unstated number of ${unit}` : `${value} ${unit}`;
}

/**
 * A refusal in one sentence for people, naming where it is, quoted as a JSON string, and the field or key it names,
 * so the sentence stays one line; never a value of the request or the refinement.
 */
export function callRefusalSentence(refusal: CallRefusal): string {
  const at = refusal.pointer === "" ? "the top level" : JSON.stringify(refusal.pointer);
  const name = JSON.stringify(refusal.name ?? "");
  switch (refusal.rule) {
    case "request-field-not-honoured":
      return `The request carries the field ${name} at ${at}, which the session's execute does not honour, so the call was not made.`;
    case "request-scope-not-offered":
      return `The request carries a scope at ${at}, and the session does not offer console.endScope, so the call was not made.`;
    case "request-transaction-not-offered":
      return `The request is sent inside a transaction at ${at}, and the session does not offer console.transaction, so the call was not made.`;
    case "request-scope-in-transaction":
      return `The request carries a scope at ${at} on a statement sent inside a transaction, which runs on the transaction's own session, so the call was not made.`;
    case "request-read-only-not-opened":
      return `The request carries a read-only execute at ${at}, and the session was not opened under the read-only policy to be sent statements, so the call was not made.`;
    case "request-read-only-missing":
      return `The request carries no read-only execute at ${at}, and the session was opened under the read-only policy to be sent statements, which takes no other execute, so the call was not made.`;
    case "request-operation-not-offered":
      return `The request names at ${at} an operation the session's maintenance does not list, so the call was not made.`;
    case "request-field-empty":
      return `The request carries the field ${name} at ${at} empty, so it names nothing and the call was not made.`;
    case "request-placement-not-offered":
      return `The request asks at ${at} for a placement the operation's spec in the session's maintenance does not offer, so the call was not made.`;
    case "request-preview-not-offered":
      return `The request at ${at} names an operation whose spec in the session's maintenance declares no preview on a row, so the call was not made.`;
    case "request-panel-not-offered":
      return `The request names at ${at} a monitoring panel the session's engine does not offer, so the call was not made.`;
    case "facet-not-offered":
      return `The session does not offer the facet ${name} at ${at}, so the call was not made.`;
    case "refinement-key-unknown":
      return `The refinement open answered has the key ${name} at ${at}, which a refinement cannot have.`;
    case "refinement-unreadable":
      return `The refinement value at ${at} is an accessor, repeats an earlier item, or is not of the type the provider contract defines there.`;
    case "refinement-widens":
      return `The refinement value at ${at} offers or honours more than the manifest declares, and a refinement only narrows it.`;
    case "batch-malformed":
      return `The batch a result source answered is not a plain record of exactly rows, an array, and done, a boolean, each a data property, at ${at}.`;
    case "batch-over-rows":
      return `The batch a result source answered holds ${count(refusal.size, "rows")} at ${at}, over its limit of ${count(refusal.limit, "rows")}.`;
    case "batch-over-bytes":
      return `The batch a result source answered holds ${count(refusal.size, "bytes")} of rows at ${at}, in more than one row, over its limit of ${count(refusal.limit, "bytes")}.`;
    case "row-not-positional":
      return `The row at ${at} of a batch is not an array with one cell for each column of its result.`;
    case "row-over-page":
      return `The row at ${at} of a batch is ${count(refusal.size, "bytes")}, over a whole page's limit of ${count(refusal.limit, "bytes")}, so no page can hold it.`;
    case "batch-empty-not-done":
      return `The batch a result source answered at ${at} holds no row and does not say the result is done, so it is not pulled again.`;
    case "call-deadline-passed":
      return `The call's deadline at ${at} had passed when the call was to start, so the provider was not called.`;
    case "call-signal-aborted":
      return `The call's signal at ${at} had aborted when the call was to start, so the provider was not called.`;
    case "transaction-answer-unreadable":
      return refusal.name === undefined
        ? `The transaction answer value at ${at} is missing, an accessor, or not what the provider contract defines there for the call's action, so no session state was read from it.`
        : `The transaction answer has the key ${name} at ${at}, which a transaction answer cannot have, so no session state was read from it.`;
  }
}
