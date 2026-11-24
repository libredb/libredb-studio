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
 * A caller whose time refusal is its own, the agent's read-only execute, reads the records through a `BudgetView`
 * (`budgetStopError`, `budgetRefusalError`): the caller leaving is `QueryCancelledError` as above, and a call its
 * deadline ended, at any wait of the run, is the view's own time refusal, built fresh for the call; every other refusal
 * answers as `refusalError` answers it.
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

/**
 * What the accessor reads of a call whose time refusal is the caller's own (clause C-51): the caller's signal, and the
 * error a call its deadline ended answers, built fresh for each call, whatever wait the stop ended.
 */
export interface BudgetView {
  /** The caller's own signal: a refusal or a stop with its reason is the caller leaving. */
  readonly caller: AbortSignal;
  /** The caller's own refusal of a call its deadline ended. */
  readonly timeRefusal: () => Error;
}

/** Whether `reason` is the caller's own: `caller` aborted with exactly this reason. */
function callerLeft(reason: unknown, caller: AbortSignal): boolean {
  return caller.aborted && reason === caller.reason;
}

function hasRule(refusals: readonly CallRefusal[], rule: CallRefusal["rule"]): boolean {
  return refusals.some((refusal) => refusal.rule === rule);
}

/** The error a call answers when its caller left. */
function cancelledError(): QueryCancelledError {
  return new QueryCancelledError(QUERY_CANCELLED_SENTENCE);
}

/**
 * The error a call that ended with `reason` answers: `QueryCancelledError` when the reason is the caller's own,
 * otherwise `timeRefusal()`.
 */
function endedError<E extends Error>(
  reason: unknown,
  caller: AbortSignal,
  timeRefusal: () => E,
): QueryCancelledError | E {
  return callerLeft(reason, caller) ? cancelledError() : timeRefusal();
}

/** The `StudioTimeoutRefusal` a call `view` reads answers at its deadline, with the caller's sentence. */
function timeoutOf(view: CallerView): () => StudioTimeoutRefusal {
  return () => new StudioTimeoutRefusal(view.deadlineSentence);
}

/** The error a refused record answers, `timeRefusal()` when its deadline or a signal not the caller's ended it. */
function refusalOf(record: RefusedRecord, caller: AbortSignal, timeRefusal: () => Error): Error {
  const { refusals } = record;
  if (hasRule(refusals, "call-signal-aborted") || hasRule(refusals, "call-deadline-passed")) {
    const left = hasRule(refusals, "call-signal-aborted") && callerLeft(record.cause, caller);
    const error = left ? cancelledError() : timeRefusal();
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

/** The error a refused record answers, this bundle's class. */
export function refusalError(record: RefusedRecord, view: CallerView): Error {
  return refusalOf(record, view.caller, timeoutOf(view));
}

/** The error a stopped record answers, this bundle's class, outcome unknown: the statement may have run. */
export function stopError(reason: unknown, view: CallerView): QueryCancelledError | StudioTimeoutRefusal {
  return endedError(reason, view.caller, timeoutOf(view));
}

/**
 * The error a refused record answers under a budget view: as `refusalError`, except that a call its deadline ended, or
 * a signal not the caller's, answers the view's own time refusal.
 */
export function budgetRefusalError(record: RefusedRecord, view: BudgetView): Error {
  return refusalOf(record, view.caller, view.timeRefusal);
}

/**
 * The error a stopped record answers under a budget view, outcome unknown: `QueryCancelledError` when the reason is
 * the caller's own, otherwise the view's own time refusal, by reference, whatever wait the stop ended.
 */
export function budgetStopError(reason: unknown, view: BudgetView): Error {
  return endedError(reason, view.caller, view.timeRefusal);
}

/**
 * The error a call's wait for its provider's open answers when that wait ended with `reason`, this bundle's class:
 * `QueryCancelledError` when the reason is the caller's own, otherwise `StudioTimeoutRefusal` with the caller's
 * sentence, which names the open's allowance. Both are outcome not-sent: the provider was never handed the statement.
 */
export function openStopError(reason: unknown, view: CallerView): QueryCancelledError | StudioTimeoutRefusal {
  const error = endedError(reason, view.caller, timeoutOf(view));
  markNotSent(error);
  return error;
}
