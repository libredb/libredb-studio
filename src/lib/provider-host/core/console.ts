/**
 * The host's console calls (docs/providers/CONTRACT.md, clauses C-48, C-28, C-47, C-57 and C-58), part of the provider
 * host core.
 *
 * `executeCall`, `cancelCall` and `transactionCall` make one console call on a session and answer a record of how it
 * ended. Each call is checked before it is made: `checkCallStart` refuses a call whose deadline passed or whose signal
 * aborted, then `checkExecuteRequest` refuses a request field the session does not honour, or `checkConsoleFacet` a
 * facet it does not offer. Each refusal is answered as a record, `called` false, and the provider is never called. Then the context and
 * the request are frozen in place, `freezeContext` and `freezeData`, so the caller builds both fresh for each call.
 *
 * The call is waited for with `awaitWithin` until the context's signal. An execute's run is the provider's execute,
 * then the first result pumped by the SDK's `pumpPage` within the limits `pumpLimits` sets from the answer, with a
 * turn of the event loop before every pull (`withTurns`, clause C-49) and under the page budget the calls are bound to
 * (`withLargePageSlot`, clause C-53), then every other result closed once. A `CallRefusalError` the pump throws is
 * answered as a record, `called` true. When the run sees the signal aborted after execute answered, it closes every
 * source and pumps nothing.
 *
 * A transaction call answers the session state its session answered, read by `checkTransactionAnswer`, and a statement
 * sent with `transaction` has its answer's session state read by `checkTransactionStatement` right after its execute
 * answered, before the abort check and the pump, its page record carrying that state. An answer the host cannot read
 * is refused as a record, `called` true, never read as any state, and a refused statement's sources are closed once.
 * The core keeps no copy of a session state between calls: every record carries the state its own call answered, and
 * a stopped call carries none (clause C-58).
 *
 * A page record holds its page's large-page slot, if it took one, until the caller calls its `release`, exactly once,
 * after building its answer body. A run that ends without a page gives the slot back before it answers or throws, and a
 * page answered after the wait on its call ended is released by the call's late handler. A stop that ends the call while
 * its page waits for a slot is marked `waitingFor: "large-page-slot"` (clause C-54), one that ends it while its page is
 * read otherwise, from the first pull until the pump answered, `waitingFor: "page"`, and one that ends it after that,
 * while the run closes its other results, `waitingFor: "other-results"`: in each the statement ran.
 *
 * A wait the signal ends answers a stop, the signal's reason by reference: a call is stopped exactly when its signal
 * aborted and the rejection is that signal's reason, so a provider that throws its own signal's reason is stopped too.
 * A stopped execute sends the run's cancel, when the session offers `console.cancel` and the request names a run, under
 * a cleanup context of its own (`cleanupContext`), and a cancel that fails or is cut reaches `ports.cancelFailed`. The
 * run it stopped waiting for keeps its handler: a later failure reaches `ports.late` once, and a later answer has
 * already closed what it held and given back its slot. Every stop's record carries `settled`, which resolves once the
 * call it stopped waiting for has settled either way, so a caller can tell when that call can no longer change the
 * session.
 *
 * Core answers plain records and passes a provider's errors by reference; it constructs no class a caller in another
 * bundle would test with `instanceof`, so the caller's accessor builds its own classes from the records. It imports only
 * the SDK's public subpaths other than `testing`, Node built-ins and its own files, and keeps no module state
 * (tests/unit/lib/provider-host/core-boundary.test.ts).
 */
import {
  awaitWithin,
  type CallContext,
  type CallRefusal,
  CallRefusalError,
  type CancelAnswer,
  type CancelRequest,
  checkCallStart,
  checkConsoleFacet,
  checkExecuteRequest,
  checkTransactionAnswer,
  checkTransactionStatement,
  cleanupContext,
  type ExecuteAnswer,
  type ExecuteRequest,
  freezeContext,
  freezeData,
  type LateOutcome,
  type Page,
  type PumpLimits,
  pumpPage,
  type ResultSource,
  type TransactionAnswer,
  type TransactionRequest,
  type Warning,
} from "@libredb/provider-sdk/calls";
import type { SessionState } from "@libredb/provider-sdk/errors";
import type { Calls } from "@libredb/provider-sdk/manifest";
import { type PageBudget, type PageHold, withLargePageSlot } from "./page-budget";
import { withTurns } from "./turns";

/** One session as the host core calls it: its calls, and its console functions with the handle already bound. */
export interface ConsoleSession {
  readonly calls: Calls;
  execute(request: ExecuteRequest, ctx: CallContext): Promise<ExecuteAnswer>;
  cancel?(request: CancelRequest, ctx: CallContext): Promise<CancelAnswer>;
  transaction?(request: TransactionRequest, ctx: CallContext): Promise<TransactionAnswer>;
}

/**
 * A call the host refused: before the provider was called (`called` false), or of what the provider answered (`called`
 * true). `cause` is the signal's reason, by reference, for a refusal of an aborted signal.
 */
export interface RefusedRecord {
  readonly kind: "refused";
  readonly called: boolean;
  readonly refusals: readonly CallRefusal[];
  readonly cause?: unknown;
}

/**
 * A call whose wait the context's signal ended, with the signal's reason by reference. `waitingFor` names a wait inside
 * the run the stop ended, after its execute answered, so the statement ran: `large-page-slot` when its page was waiting
 * for a large-page slot (clause C-54), `page` when its page was being read otherwise, and `other-results` when its page
 * had been read and the run was closing its other results (clause C-48). `settled` resolves once the call the host
 * stopped waiting for has settled, answered or failed, and never rejects: until then that call may still change the
 * session (clause C-58).
 */
export interface StoppedRecord {
  readonly kind: "stopped";
  readonly reason: unknown;
  readonly waitingFor?: "large-page-slot" | "page" | "other-results";
  readonly settled: Promise<void>;
}

/** An execute that answered a page of its first result. */
export interface PageRecord {
  readonly kind: "page";
  readonly page: Page;
  /** How many results the execute answered. */
  readonly resultCount: number;
  /** The first result's own row count, where the provider gave one. */
  readonly rowCount?: number;
  readonly pageApplied: boolean;
  readonly boundApplied?: true;
  readonly executionTimeMs: number;
  readonly warnings: readonly Warning[];
  readonly explainPlan?: unknown;
  /** The session state the execute answered, present exactly when the request was sent with `transaction`. */
  readonly sessionState?: SessionState;
  /**
   * Ends the page's hold on its large-page slot, if it took one: the caller calls it exactly once, after building its
   * answer body.
   *
   * @throws {Error} For a record already released, a defect of its caller.
   */
  readonly release: () => void;
}

export type ExecuteRecord = RefusedRecord | StoppedRecord | PageRecord;

export type CancelRecord = RefusedRecord | StoppedRecord | { readonly kind: "answered"; readonly cancelled: boolean };

/** A transaction call that answered: the session state after it, and for a begin whether the server reported it. */
export interface AnsweredTransaction {
  readonly kind: "answered";
  readonly sessionState: SessionState;
  readonly stateReported?: boolean;
}

/** How a transaction call ended. A stop carries no state: the caller reads it as `unknown` (clause C-58). */
export type TransactionRecord = RefusedRecord | StoppedRecord | AnsweredTransaction;

/** Where a call hands what it no longer waits for: each called once per failure, never with a detached rejection. */
export interface HostCallPorts {
  /** A failure of a call after its wait ended. */
  readonly late: (error: unknown) => void;
  /** A failure or a cut of the cancel a stopped execute sent. */
  readonly cancelFailed: (error: unknown) => void;
}

const RECORD_RELEASED_TWICE =
  "A page record was released twice, a defect of its caller: each page record is released exactly once, after its answer body is built.";

const EMPTY_PAGE: Page = Object.freeze({ rows: Object.freeze([]), bytes: 0, end: "done" });

/** The record of a call refused before it was made, the signal's reason as its cause when the signal aborted. */
function refusedBefore(refusals: readonly CallRefusal[], ctx: CallContext): RefusedRecord {
  return { kind: "refused", called: false, refusals, ...(ctx.signal.aborted ? { cause: ctx.signal.reason } : {}) };
}

/** Whether `error` is the stop of the call `ctx`: its signal aborted, and `error` is that signal's reason. */
function stoppedBy(ctx: CallContext, error: unknown): boolean {
  return ctx.signal.aborted && error === ctx.signal.reason;
}

/** A late handler that hands a failure after the wait on the call `ctx` ended to `port`, unless it is that call's stop. */
function lateFailure(ctx: CallContext, port: (error: unknown) => void): (outcome: LateOutcome<unknown>) => void {
  return (outcome) => {
    if (outcome.kind === "failed" && !stoppedBy(ctx, outcome.error)) port(outcome.error);
  };
}

/** The late handler of an execute: a page answered after the wait ended is released, a failure goes to `lateFailure`. */
function lateExecute(ctx: CallContext, port: (error: unknown) => void): (outcome: LateOutcome<ExecuteRecord>) => void {
  const failure = lateFailure(ctx, port);
  return (outcome) => {
    if (outcome.kind === "answered") {
      if (outcome.value.kind === "page") outcome.value.release();
      return;
    }
    failure(outcome);
  };
}

/**
 * How far one execute's run got, for the marker of a stop that ends it: `execute` until the provider's execute
 * answered, `page` from the page's first pull until the pump answered, `other-results` while the run closes the rest.
 */
interface RunProgress {
  phase: "execute" | "page" | "other-results";
}

/**
 * Moves `progress` to `phase` only while the call's signal has not aborted, so the phase a stop reads is the one the
 * run was in when the signal aborted, whatever order the abort's reactions run.
 */
function enterPhase(progress: RunProgress, phase: RunProgress["phase"], ctx: CallContext): void {
  if (!ctx.signal.aborted) progress.phase = phase;
}

/**
 * The wait a stop ended, for its record: the slot while the page waits for one, otherwise the run's phase after its
 * execute answered, and none for the execute itself.
 */
function stopMarker(hold: PageHold, progress: RunProgress): Pick<StoppedRecord, "waitingFor"> {
  if (hold.waiting) return { waitingFor: "large-page-slot" };
  if (progress.phase === "execute") return {};
  return { waitingFor: progress.phase };
}

/** Gives back the slot `hold` holds, if any, and forgets it. */
function releaseHold(hold: PageHold): void {
  const { slot } = hold;
  if (slot === undefined) return;
  delete hold.slot;
  slot.release();
}

/** The release of a page record over `hold`: once, and refused by name after that. */
function recordRelease(hold: PageHold): () => void {
  let released = false;
  return () => {
    if (released) throw new Error(RECORD_RELEASED_TWICE);
    released = true;
    releaseHold(hold);
  };
}

/** Resolves once `call` has settled, answered or failed, and never rejects: a stopped record's `settled`. */
function settledOf(call: Promise<unknown>): Promise<void> {
  return call.then(
    () => undefined,
    () => undefined,
  );
}

/** Runs `call`, with a throw before it answers a promise read as its rejection. */
function startCall<T>(call: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(call());
  });
}

/** Closes every one of `sources` once, all at once, and answers the errors of those whose close failed. */
async function closeEach(sources: readonly ResultSource[]): Promise<readonly unknown[]> {
  const settled = await Promise.allSettled(sources.map((source) => startCall(() => source.close())));
  return settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

/** `error`, or, when closing failed too, an `AggregateError` holding `error` first and each close's error after it. */
function withCloseErrors(error: unknown, closeErrors: readonly unknown[]): unknown {
  if (closeErrors.length === 0) return error;
  return new AggregateError(
    [error, ...closeErrors],
    "A console execute call failed, and closing its result sources failed too.",
  );
}

/** The console cancel of `session`, a host defect when the session offers it and holds no function for it. */
function sessionCancel(session: ConsoleSession, request: CancelRequest, ctx: CallContext): Promise<CancelAnswer> {
  if (session.cancel === undefined) {
    throw new Error("The session offers console.cancel and has no cancel function, a defect of the host's session.");
  }
  return session.cancel(request, ctx);
}

/** The console transaction of `session`, a host defect when the session offers it and holds no function for it. */
function sessionTransaction(
  session: ConsoleSession,
  request: TransactionRequest,
  ctx: CallContext,
): Promise<TransactionAnswer> {
  if (session.transaction === undefined) {
    throw new Error(
      "The session offers console.transaction and has no transaction function, a defect of the host's session.",
    );
  }
  return session.transaction(request, ctx);
}

/**
 * The run of an execute call: the provider's execute, its first result pumped under `budget`, every other result
 * closed. The slot the page takes is recorded in `hold`, and given back on every path that answers no page; the phase
 * the run is in is recorded in `progress`.
 */
async function runExecute(
  budget: PageBudget,
  hold: PageHold,
  progress: RunProgress,
  session: ConsoleSession,
  request: ExecuteRequest,
  ctx: CallContext,
  pumpLimits: (answer: ExecuteAnswer) => PumpLimits,
): Promise<ExecuteRecord> {
  const answer = await session.execute(request, ctx);
  const sources = answer.results;
  // A statement sent inside a transaction answers the session state after it, read before anything else of the run.
  const inTransaction = Object.hasOwn(request, "transaction");
  const stateRefusals = inTransaction ? checkTransactionStatement(answer) : [];
  if (stateRefusals.length > 0) {
    const closeErrors = await closeEach(sources);
    if (closeErrors.length > 0) {
      throw new AggregateError(
        closeErrors,
        "Closing the result sources of a statement whose state was refused failed.",
      );
    }
    return { kind: "refused", called: true, refusals: stateRefusals };
  }
  if (ctx.signal.aborted) {
    const closeErrors = await closeEach(sources);
    if (closeErrors.length > 0) throw new AggregateError(closeErrors, "Closing a stopped run's result sources failed.");
    // The run answers this record as it settles, so the call it names has settled.
    return { kind: "stopped", reason: ctx.signal.reason, settled: Promise.resolve() };
  }
  let limits: PumpLimits;
  try {
    limits = pumpLimits(answer);
  } catch (error) {
    throw withCloseErrors(error, await closeEach(sources));
  }
  const [first, ...rest] = sources;
  let page: Page;
  enterPhase(progress, "page", ctx);
  try {
    page =
      first === undefined
        ? EMPTY_PAGE
        : await pumpPage(withLargePageSlot(withTurns(first, ctx), budget, ctx, hold), limits, ctx);
  } catch (error) {
    releaseHold(hold);
    enterPhase(progress, "other-results", ctx);
    const closeErrors = await closeEach(rest);
    if (closeErrors.length > 0) throw withCloseErrors(error, closeErrors);
    if (!(error instanceof CallRefusalError)) throw error;
    return {
      kind: "refused",
      called: true,
      refusals: error.refusals,
      ...(error.cause === undefined ? {} : { cause: error.cause }),
    };
  }
  enterPhase(progress, "other-results", ctx);
  const closeErrors = await closeEach(rest);
  if (closeErrors.length > 0) releaseHold(hold);
  if (closeErrors.length === 1) throw closeErrors[0];
  if (closeErrors.length > 1) throw new AggregateError(closeErrors, "Closing a run's other result sources failed.");
  return {
    kind: "page",
    page,
    resultCount: sources.length,
    ...(first?.rowCount === undefined ? {} : { rowCount: first.rowCount }),
    pageApplied: answer.pageApplied,
    ...(answer.boundApplied === true ? { boundApplied: true as const } : {}),
    executionTimeMs: answer.executionTimeMs,
    warnings: answer.warnings,
    ...(answer.explainPlan === undefined ? {} : { explainPlan: answer.explainPlan }),
    ...(inTransaction ? { sessionState: answer.sessionState as SessionState } : {}),
    release: recordRelease(hold),
  };
}

/**
 * Sends the cancel of the run `request` names, when the session offers `console.cancel` and the request names a run,
 * under a cleanup context of its own; its failure, or its cut at the cleanup deadline, reaches `ports.cancelFailed`.
 */
function cancelStoppedRun(
  session: ConsoleSession,
  request: ExecuteRequest,
  ctx: CallContext,
  ports: HostCallPorts,
): void {
  if (request.runId === undefined || checkConsoleFacet(session.calls, "cancel").length > 0) return;
  const cleanup = freezeContext(cleanupContext(ctx.env));
  const cancelRequest = freezeData({ runId: request.runId });
  awaitWithin(
    startCall(() => sessionCancel(session, cancelRequest, cleanup)),
    cleanup.signal,
    lateFailure(cleanup, ports.cancelFailed),
  ).catch(ports.cancelFailed);
}

/**
 * One console execute on `session`: checked, frozen, waited for until `ctx.signal`, its first result pumped within
 * `pumpLimits(answer)` under `budget`, answered as a record.
 *
 * @throws The provider's error, or a pull's, by reference, after every source is closed once; an `AggregateError` when
 * a close failed beside it.
 */
async function executeCall(
  budget: PageBudget,
  session: ConsoleSession,
  request: ExecuteRequest,
  ctx: CallContext,
  pumpLimits: (answer: ExecuteAnswer) => PumpLimits,
  ports: HostCallPorts,
): Promise<ExecuteRecord> {
  const start = checkCallStart(ctx);
  if (start.length > 0) return refusedBefore(start, ctx);
  const fields = checkExecuteRequest(session.calls, request);
  if (fields.length > 0) return refusedBefore(fields, ctx);
  freezeContext(ctx);
  freezeData(request);
  const hold: PageHold = { waiting: false };
  const progress: RunProgress = { phase: "execute" };
  const run = startCall(() => runExecute(budget, hold, progress, session, request, ctx, pumpLimits));
  try {
    return await awaitWithin(run, ctx.signal, lateExecute(ctx, ports.late));
  } catch (error) {
    if (!stoppedBy(ctx, error)) throw error;
    cancelStoppedRun(session, request, ctx, ports);
    // `waiting` is cleared only when a slot is granted and the phase moves only before the signal aborted, so both are
    // read the same whatever order the abort's reactions run.
    return { kind: "stopped", reason: error, ...stopMarker(hold, progress), settled: settledOf(run) };
  }
}

/**
 * One console cancel on `session`: checked, the facet included, frozen, waited for until `ctx.signal`, answered as a
 * record, the provider's answer by reference. A failure after the wait ended reaches `ports.late` once.
 *
 * @throws The provider's error by reference, or a host defect when the session offers the facet and holds no function.
 */
export async function cancelCall(
  session: ConsoleSession,
  request: CancelRequest,
  ctx: CallContext,
  ports: Pick<HostCallPorts, "late">,
): Promise<CancelRecord> {
  const start = checkCallStart(ctx);
  if (start.length > 0) return refusedBefore(start, ctx);
  const facet = checkConsoleFacet(session.calls, "cancel");
  if (facet.length > 0) return refusedBefore(facet, ctx);
  freezeContext(ctx);
  freezeData(request);
  const call = startCall(() => sessionCancel(session, request, ctx));
  try {
    const answer = await awaitWithin(call, ctx.signal, lateFailure(ctx, ports.late));
    return { kind: "answered", cancelled: answer.cancelled };
  } catch (error) {
    if (!stoppedBy(ctx, error)) throw error;
    return { kind: "stopped", reason: error, settled: settledOf(call) };
  }
}

/**
 * One console transaction call on `session`: checked, the facet included, frozen, waited for until `ctx.signal`, its
 * answer read by `checkTransactionAnswer` and answered as a record built fresh from that answer's data properties. An
 * answer the host cannot read is refused, `called` true; a stop answers no state. A failure after the wait ended
 * reaches `ports.late` once, and a later answer is dropped.
 *
 * @throws The provider's error by reference, or a host defect when the session offers the facet and holds no function.
 */
export async function transactionCall(
  session: ConsoleSession,
  request: TransactionRequest,
  ctx: CallContext,
  ports: Pick<HostCallPorts, "late">,
): Promise<TransactionRecord> {
  const start = checkCallStart(ctx);
  if (start.length > 0) return refusedBefore(start, ctx);
  const facet = checkConsoleFacet(session.calls, "transaction");
  if (facet.length > 0) return refusedBefore(facet, ctx);
  freezeContext(ctx);
  freezeData(request);
  let answer: unknown;
  const call = startCall(() => sessionTransaction(session, request, ctx));
  try {
    answer = await awaitWithin(call, ctx.signal, lateFailure(ctx, ports.late));
  } catch (error) {
    if (!stoppedBy(ctx, error)) throw error;
    return { kind: "stopped", reason: error, settled: settledOf(call) };
  }
  const refusals = checkTransactionAnswer(request, answer);
  if (refusals.length > 0) return { kind: "refused", called: true, refusals };
  // Both are data properties of the state's vocabulary and a boolean once the check passed.
  const { sessionState, stateReported } = answer as TransactionAnswer;
  return { kind: "answered", sessionState, ...(stateReported === undefined ? {} : { stateReported }) };
}

/** A console execute bound to a page budget: the arguments of `executeCall` after its budget. */
export type ExecuteCall = (
  session: ConsoleSession,
  request: ExecuteRequest,
  ctx: CallContext,
  pumpLimits: (answer: ExecuteAnswer) => PumpLimits,
  ports: HostCallPorts,
) => Promise<ExecuteRecord>;

/**
 * The console calls one host core holds: the execute bound to its page budget, and the cancel and the transaction call,
 * which pump nothing.
 */
export interface ConsoleCalls {
  readonly executeCall: ExecuteCall;
  readonly cancelCall: typeof cancelCall;
  readonly transactionCall: typeof transactionCall;
}

/** The console calls with every execute's page run under `budget` (clause C-53). */
export function consoleCalls(budget: PageBudget): ConsoleCalls {
  return {
    executeCall: (session, request, ctx, pumpLimits, ports) =>
      executeCall(budget, session, request, ctx, pumpLimits, ports),
    cancelCall,
    transactionCall,
  };
}
