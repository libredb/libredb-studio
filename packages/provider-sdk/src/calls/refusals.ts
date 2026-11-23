/**
 * What the host refuses of a call or of its answer (docs/providers/CONTRACT.md, clauses C-9, C-10 and C-15).
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
] as const);

export type CallRefusalRule = (typeof CALL_REFUSAL_RULES)[number];

/** One way a call, or what it answered, is refused. */
export interface CallRefusal {
  readonly rule: CallRefusalRule;
  /** A JSON Pointer into the thing the rule names; the empty string is that thing itself. */
  readonly pointer: string;
  /** The request field, for a field not honoured, or the key, for a key a refinement cannot have. */
  readonly name?: string;
  /** For a budget, what was asked for: a count of rows or of bytes. */
  readonly limit?: number;
  /** For a budget, what was measured, in the same unit as `limit`. */
  readonly size?: number;
}

/** Thrown with every refusal of one call, its message their sentences. */
export class CallRefusalError extends Error {
  readonly refusals: readonly CallRefusal[];

  constructor(refusals: readonly CallRefusal[]) {
    super(refusals.map(callRefusalSentence).join(" "));
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
  }
}
