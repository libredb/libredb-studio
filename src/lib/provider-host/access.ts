/**
 * The accessor (docs/providers/CONTRACT.md, clause C-51): how the records the host core answers become Studio's error
 * classes, in the calling bundle.
 *
 * Core answers records and constructs no class, so a class a caller tests with `instanceof` is always built here, by
 * the bundle that tests it. A call the caller left is `QueryCancelledError` with today's sentence. A call its deadline
 * ended is `StudioTimeoutRefusal` with the caller's sentence, which names the wait. A row no page can hold is
 * `StudioByteBudgetRefusal`, naming the page's bytes and the row's size. A refusal before the call was made answers
 * outcome `not-sent`, written with `markNotSent`, since nothing reached the database; once the provider was called the
 * outcome stays `unknown`, since the statement may have run. A wait for the provider's open that ended
 * (`openStopError`) is `QueryCancelledError` when the caller left and `StudioTimeoutRefusal` with the caller's sentence
 * otherwise, both `not-sent`, since no statement was sent.
 *
 * Every other refusal is a defect of Studio's own bridge, which honours every request field and is sent a scope only
 * where it offers `console.endScope`, so no provider can cause one: a plain `Error` naming each refusal's sentence, answered 500. Two rows of the host's mapping
 * wait for the first session that refuses a request field, a native provider: a refused offset as
 * `OffsetUnsupportedError` and refused params as `FacetNotOfferedError`.
 */
import { type CallRefusal, callRefusalSentence } from "@libredb/provider-sdk/calls";
import { markNotSent, QueryCancelledError, StudioByteBudgetRefusal, StudioTimeoutRefusal } from "@/lib/db/errors";
import type { RefusedRecord } from "@/lib/provider-host/core/console";

/** The sentence a cancelled query has always been answered with. */
const QUERY_CANCELLED_SENTENCE = "The query was cancelled.";

/** The words that open the message of a refusal only a defect of Studio's own bridge can cause. */
export const HOST_DEFECT_PREFIX =
  "Studio's provider bridge made a call the provider host refused, which is a defect of Studio:";

/** What the accessor reads of the call's caller. */
export interface CallerView {
  /** The caller's own signal: a refusal or a stop with its reason is the caller leaving. */
  readonly caller: AbortSignal;
  /** Studio's sentence for a call its deadline ended, naming the wait. */
  readonly deadlineSentence: string;
}

/** Whether `reason` is the caller's own: its signal aborted with exactly this reason. */
function callerLeft(reason: unknown, view: CallerView): boolean {
  return view.caller.aborted && reason === view.caller.reason;
}

function hasRule(refusals: readonly CallRefusal[], rule: CallRefusal["rule"]): boolean {
  return refusals.some((refusal) => refusal.rule === rule);
}

/** The class a call that ended with the caller gone, or at its deadline, answers. */
function endedError(left: boolean, view: CallerView): QueryCancelledError | StudioTimeoutRefusal {
  return left ? new QueryCancelledError(QUERY_CANCELLED_SENTENCE) : new StudioTimeoutRefusal(view.deadlineSentence);
}

/** The error a refused record answers, this bundle's class. */
export function refusalError(record: RefusedRecord, view: CallerView): Error {
  const { refusals } = record;
  if (hasRule(refusals, "call-signal-aborted") || hasRule(refusals, "call-deadline-passed")) {
    const left = hasRule(refusals, "call-signal-aborted") && callerLeft(record.cause, view);
    const error = endedError(left, view);
    if (!record.called) markNotSent(error);
    return error;
  }
  const overPage = refusals.find((refusal) => refusal.rule === "row-over-page");
  if (overPage !== undefined) {
    return new StudioByteBudgetRefusal(
      `A row of the result is ${overPage.size} bytes, over the ${overPage.limit} bytes one page of a result may hold, so Studio answers no page of it.`,
    );
  }
  return new Error(`${HOST_DEFECT_PREFIX} ${refusals.map((refusal) => callRefusalSentence(refusal)).join(" ")}`);
}

/** The error a stopped record answers, this bundle's class, outcome unknown: the statement may have run. */
export function stopError(reason: unknown, view: CallerView): QueryCancelledError | StudioTimeoutRefusal {
  return endedError(callerLeft(reason, view), view);
}

/**
 * The error a call's wait for its provider's open answers when that wait ended with `reason`, this bundle's class:
 * `QueryCancelledError` when the reason is the caller's own, otherwise `StudioTimeoutRefusal` with the caller's
 * sentence, which names the open's allowance. Both are outcome not-sent: the provider was never handed the statement.
 */
export function openStopError(reason: unknown, view: CallerView): QueryCancelledError | StudioTimeoutRefusal {
  const error = endedError(callerLeft(reason, view), view);
  markNotSent(error);
  return error;
}
