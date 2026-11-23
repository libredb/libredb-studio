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
 * turn of the event loop before every pull (`withTurns`, clause C-49), then every other result closed once. A
 * `CallRefusalError` the pump throws is answered as a record, `called` true. When the run sees the signal aborted after
 * execute answered, it closes every source and pumps nothing.
 *
 * A wait the signal ends answers a stop, the signal's reason by reference: a call is stopped exactly when its signal
 * aborted and the rejection is that signal's reason, so a provider that throws its own signal's reason is stopped too.
 * A stopped execute sends the run's cancel, when the session offers `console.cancel` and the request names a run, under
 * a cleanup context of its own (`cleanupContext`), and a cancel that fails or is cut reaches `ports.cancelFailed`. The
 * run it stopped waiting for keeps its handler: a later failure reaches `ports.late` once, and a later answer has
 * already closed what it held.
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

/** A call whose wait the context's signal ended, with the signal's reason by reference. */
export interface StoppedRecord {
  readonly kind: "stopped";
  readonly reason: unknown;
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

/** The run of an execute call: the provider's execute, its first result pumped, every other result closed. */
async function runExecute(
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
  try {
    page = first === undefined ? EMPTY_PAGE : await pumpPage(withTurns(first, ctx), limits, ctx);
  } catch (error) {
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
  const closeErrors = await closeEach(rest);
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
 * `pumpLimits(answer)`, answered as a record.
 *
 * @throws The provider's error, or a pull's, by reference, after every source is closed once; an `AggregateError` when
 * a close failed beside it.
 */
export async function executeCall(
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
  try {
    return await awaitWithin(
      startCall(() => runExecute(session, request, ctx, pumpLimits)),
      ctx.signal,
      lateFailure(ctx, ports.late),
    );
  } catch (error) {
    if (!stoppedBy(ctx, error)) throw error;
    cancelStoppedRun(session, request, ctx, ports);
    return { kind: "stopped", reason: error };
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
