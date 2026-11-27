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
 * Three rows are reached only by a provider package's session, which may offer less than Studio's bridge (clause C-111),
 * each refused before the call and answered `not-sent`: a non-zero offset the session does not honour is
 * `StudioOffsetRefusal`, Studio's own offset refusal, bound params it does not honour are `FacetNotOfferedError` naming the field, and a facet it
 * does not offer is `FacetNotOfferedError` naming the call by its contract name, never a value of the package's.
 *
 * A tree request naming a container level or an object kind the session's object model does not state
 * (`request-level-not-stated`, `request-kind-not-stated`, clause M-89), on a package's session or the bridge's, is
 * `StudioObjectModelRefusal`, Studio's own, one sentence per refusal in order and never a value of the request,
 * answered `not-sent`. A record holding such a refusal beside a rule no row reads is the host defect below, naming
 * every refusal it holds.
 *
 * Every other refusal is a defect of Studio's own code: its bridge honours every request field, offers every facet a
 * legacy caller asks for and is sent a scope only where it offers `console.endScope`, and a legacy provider whose
 * execute answer the host core refuses (`checkExecuteAnswer`) is Studio's own provider. It is a `HostDefectError`
 * naming each refusal's sentence and carrying the refusals, and the errors of the closes that failed after a refused
 * execute answer, answered 500. On a provider package's session a refusal of what the package answered (an execute
 * answer's member, a batch, a row) is the package's defect instead, as is a refinement its open answered, which the one
 * open function raises as a `HostDefectError` carrying those refusals (`openEngine` in ./open-engine.ts); every route
 * reads the package's defect from the refusals (`packageFailureAnswer` in src/lib/api/package-errors.ts).
 */
import { type CallRefusal, callRefusalSentence } from "@libredb/provider-sdk/calls";
import {
  type DeclaredFacet,
  FacetNotOfferedError,
  markNotSent,
  QueryCancelledError,
  StudioByteBudgetRefusal,
  StudioObjectModelRefusal,
  StudioOffsetRefusal,
  StudioTimeoutRefusal,
} from "@/lib/db/errors";
import type { RefusedRecord } from "@/lib/provider-host/core/console";

/** The sentence a cancelled query has always been answered with. */
const QUERY_CANCELLED_SENTENCE = "The query was cancelled.";

/** The words that open the message of a refusal only a defect of Studio's own bridge can cause. */
export const HOST_DEFECT_PREFIX =
  "Studio's provider bridge made a call the provider host refused, which is a defect of Studio:";

/**
 * The error of a refusal no row of the accessor reads, its message `HOST_DEFECT_PREFIX` and each refusal's sentence.
 * Its class is Studio's own and outside a provider package's closure, so a package cannot build one.
 */
export class HostDefectError extends Error {
  /** The refusals the host core answered, each naming its rule. */
  readonly refusals: readonly CallRefusal[];
  /** The error of each result source whose close failed after a refused execute answer, by reference; none otherwise. */
  readonly closeFailures: readonly unknown[];

  constructor(refusals: readonly CallRefusal[], closeFailures: readonly unknown[] = []) {
    super(`${HOST_DEFECT_PREFIX} ${refusals.map((refusal) => callRefusalSentence(refusal)).join(" ")}`);
    this.refusals = refusals;
    this.closeFailures = closeFailures;
  }
}

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

/** Studio's sentence for a non-zero offset a provider package's session does not honour. */
const OFFSET_NOT_HONOURED =
  "This connection's provider package does not take an offset, so Studio asks for no page after the first.";

/** Studio's sentence for bound params a provider package's session does not honour. */
const PARAMS_NOT_HONOURED = "This connection's provider package takes no bound parameters, so Studio sent nothing.";

/**
 * The error of a request field or a facet a provider package's session does not offer, refused before the call and
 * marked not-sent, or undefined for any other refusal: the three rows of clause C-111. A facet's `name` is the SDK's
 * own call name, `<group>.<call>`, never a value of the package's.
 */
function notOfferedError(refusals: readonly CallRefusal[]): Error | undefined {
  const field = refusals.find((refusal) => refusal.rule === "request-field-not-honoured");
  const facet = refusals.find((refusal) => refusal.rule === "facet-not-offered");
  let error: Error;
  if (field?.name === "offset") error = new StudioOffsetRefusal(OFFSET_NOT_HONOURED);
  else if (field?.name === "params")
    error = new FacetNotOfferedError(PARAMS_NOT_HONOURED, undefined, "console", "params");
  else if (facet?.name !== undefined) {
    const [group, call] = facet.name.split(".") as [DeclaredFacet, string];
    error = new FacetNotOfferedError(
      `This connection's provider package does not offer ${facet.name}, so Studio did not call it.`,
      undefined,
      group,
      call,
    );
  } else return undefined;
  markNotSent(error);
  return error;
}

/** Studio's sentence for each refusal of a tree request the session's object model does not state. */
const MODEL_REFUSAL_SENTENCES: Readonly<Partial<Record<CallRefusal["rule"], string>>> = Object.freeze({
  "request-level-not-stated":
    "The request names a container path whose levels this connection's object model does not state, so Studio did not call the provider.",
  "request-kind-not-stated":
    "The request names an object kind this connection's object model does not state, so Studio did not call the provider.",
});

/**
 * The error of a tree request naming a level or a kind the session's object model does not state, refused before the
 * call and marked not-sent: one of Studio's sentences per such refusal, in order; undefined when the record holds none.
 * A record holding such a refusal beside any other rule is the host defect of every refusal it holds, so no rule is
 * dropped from the answer.
 */
function objectModelError(refusals: readonly CallRefusal[]): StudioObjectModelRefusal | HostDefectError | undefined {
  const sentences = refusals.flatMap((refusal) => {
    const sentence = MODEL_REFUSAL_SENTENCES[refusal.rule];
    return sentence === undefined ? [] : [sentence];
  });
  if (sentences.length === 0) return undefined;
  if (sentences.length < refusals.length) return new HostDefectError(refusals);
  return new StudioObjectModelRefusal(sentences.join(" "));
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
  const notOffered = notOfferedError(refusals);
  if (notOffered !== undefined) return notOffered;
  const unstated = objectModelError(refusals);
  if (unstated !== undefined) return unstated;
  return new HostDefectError(refusals, record.closeFailures);
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
