/**
 * The host's console calls (docs/providers/CONTRACT.md, clauses C-48, C-28 and C-47), part of the provider host core.
 *
 * `executeCall` and `cancelCall` make one console call on a session and answer a record of how it ended. Each call is
 * checked before it is made: `checkCallStart` refuses a call whose deadline passed or whose signal aborted, then
 * `checkExecuteRequest` refuses a request field the session does not honour, or `checkConsoleFacet` a facet it does not
 * offer. Each refusal is answered as a record, `called` false, and the provider is never called. Then the context and
 * the request are frozen in place, `freezeContext` and `freezeData`, so the caller builds both fresh for each call.
 *
 * The call is waited for with `awaitWithin` until the context's signal. An execute's run is the provider's execute,
 * then the first result pumped by the SDK's `pumpPage` within the limits `pumpLimits` sets from the answer, with a
 * turn of the event loop before every pull (`withTurns`, clause C-49) and under the page budget the calls are bound to
 * (`withLargePageSlot`, clause C-53), then every other result closed once. A `CallRefusalError` the pump throws is
 * answered as a record, `called` true. When the run sees the signal aborted after execute answered, it closes every
 * source and pumps nothing.
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
 * already closed what it held and given back its slot.
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
  type Warning,
} from "@libredb/provider-sdk/calls";
import type { Calls } from "@libredb/provider-sdk/manifest";
import { type PageBudget, type PageHold, withLargePageSlot } from "./page-budget";
import { withTurns } from "./turns";

/** One session as the host core calls it: its calls, and its console functions with the handle already bound. */
export interface ConsoleSession {
  readonly calls: Calls;
  execute(request: ExecuteRequest, ctx: CallContext): Promise<ExecuteAnswer>;
  cancel?(request: CancelRequest, ctx: CallContext): Promise<CancelAnswer>;
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
 * had been read and the run was closing its other results (clause C-48).
 */
export interface StoppedRecord {
  readonly kind: "stopped";
  readonly reason: unknown;
  readonly waitingFor?: "large-page-slot" | "page" | "other-results";
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
  if (ctx.signal.aborted) {
    const closeErrors = await closeEach(sources);
    if (closeErrors.length > 0) throw new AggregateError(closeErrors, "Closing a stopped run's result sources failed.");
    return { kind: "stopped", reason: ctx.signal.reason };
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
  try {
    return await awaitWithin(
      startCall(() => runExecute(budget, hold, progress, session, request, ctx, pumpLimits)),
      ctx.signal,
      lateExecute(ctx, ports.late),
    );
  } catch (error) {
    if (!stoppedBy(ctx, error)) throw error;
    cancelStoppedRun(session, request, ctx, ports);
    // `waiting` is cleared only when a slot is granted and the phase moves only before the signal aborted, so both are
    // read the same whatever order the abort's reactions run.
    return { kind: "stopped", reason: error, ...stopMarker(hold, progress) };
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
  try {
    const answer = await awaitWithin(
      startCall(() => sessionCancel(session, request, ctx)),
      ctx.signal,
      lateFailure(ctx, ports.late),
    );
    return { kind: "answered", cancelled: answer.cancelled };
  } catch (error) {
    if (!stoppedBy(ctx, error)) throw error;
    return { kind: "stopped", reason: error };
  }
}

/** A console execute bound to a page budget: the arguments of `executeCall` after its budget. */
export type ExecuteCall = (
  session: ConsoleSession,
  request: ExecuteRequest,
  ctx: CallContext,
  pumpLimits: (answer: ExecuteAnswer) => PumpLimits,
  ports: HostCallPorts,
) => Promise<ExecuteRecord>;

/** The console calls one host core holds: the execute bound to its page budget, and the cancel, which pumps nothing. */
export interface ConsoleCalls {
  readonly executeCall: ExecuteCall;
  readonly cancelCall: typeof cancelCall;
}

/** The console calls with every execute's page run under `budget` (clause C-53). */
export function consoleCalls(budget: PageBudget): ConsoleCalls {
  return {
    executeCall: (session, request, ctx, pumpLimits, ports) =>
      executeCall(budget, session, request, ctx, pumpLimits, ports),
    cancelCall,
  };
}
