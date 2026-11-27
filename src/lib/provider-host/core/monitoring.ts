/**
 * The host's monitoring calls and its health call (docs/providers/CONTRACT.md, clauses C-73, C-72, C-17, C-27 and
 * C-28), part of the provider host core.
 *
 * `panelCall` makes one `monitoring.panel` call on a session and `poolStatsCall` one `monitoring.poolStats` call, and
 * each answers a record of how it ended. Each is checked before it is made: `checkCallStart` refuses a call whose
 * deadline passed or whose signal aborted, then `checkMonitoringFacet` a session that does not offer the facet, then,
 * for a panel, `checkMonitoringPanelRequest` a request for a panel the session's engine does not offer. Each refusal
 * is answered as a record, `called` false, and the provider is never called. Then the context and the panel request
 * are frozen in place, `freezeContext` and `freezeData`, so the caller builds both fresh for each call.
 *
 * The call is waited for with `awaitWithin` until the context's signal. An answer is read once with the SDK's check of
 * its call (clause C-112), whatever session answered it, a package's or the bridge's: `checkPanelAnswer` against the
 * form of the panel its request names, `checkPoolStatsAnswer` and `checkHealthAnswer`. One outside the SDK's types is
 * refused as a record, `called` true, each refusal naming its call's rule and its pointer, never a value. Past the
 * check the answer is the session's own, by reference, typed as the check answers it, and the caller reads the member
 * its request names (clause C-74) and checks nothing of its own; it is read by reference under operator trust, as the
 * tree call reads its answer. A wait the signal ends answers a stop, the signal's reason by reference, and `settled`, which resolves once the call
 * the host stopped waiting for has settled either way; a failure after the stop reaches `ports.late` once and a later
 * answer is dropped, so no promise the host stopped waiting for is left without a handler. A provider's error passes
 * by reference.
 *
 * `healthCall` makes one `health` call on a session, the mandatory call every session answers (clause C-72), so it is
 * checked only by `checkCallStart`: it reads no facet and has no request. Its context is frozen, it is waited for as
 * the monitoring calls are, and it answers the session's health, read with `checkHealthAnswer`, by reference, a refusal
 * of it, a stop with its reason and `settled`, or a provider's error by reference, a later failure reaching
 * `ports.late` once.
 *
 * The three calls share one private helper, `monitoringCall`, and read the core's call machinery from the console calls
 * (src/lib/provider-host/core/console.ts): `refusedBefore`, `stoppedBy`, `lateFailure`, `settledOf` and `startCall`,
 * one definition for every call the core makes, as the tree and maintenance calls read them. Like them they construct
 * no class and keep no module state.
 */
import {
  type AnswerCheck,
  awaitWithin,
  type CallContext,
  type CallRefusal,
  checkCallStart,
  checkHealthAnswer,
  checkMonitoringFacet,
  checkMonitoringPanelRequest,
  checkPanelAnswer,
  checkPoolStatsAnswer,
  freezeContext,
  freezeData,
  type HealthInfo,
  type MonitoringFacet,
  type MonitoringPanelAnswer,
  type MonitoringPanelRequest,
  type PoolStats,
} from "@libredb/provider-sdk/calls";
import type { Calls, MonitoringPanels } from "@libredb/provider-sdk/manifest";
import {
  type HostCallPorts,
  lateFailure,
  type RefusedRecord,
  refusedBefore,
  type StoppedRecord,
  settledOf,
  startCall,
  stoppedBy,
} from "./console";

/**
 * One session as the host core calls its monitoring facets: its calls, the monitoring panels of its engine, and its
 * panel and pool statistics functions with the handle already bound.
 */
export interface MonitoringSession {
  readonly calls: Calls;
  readonly panels: MonitoringPanels;
  panel?(request: MonitoringPanelRequest, ctx: CallContext): Promise<MonitoringPanelAnswer>;
  poolStats?(ctx: CallContext): Promise<PoolStats>;
}

/**
 * One session as the host core calls its health: its health function with the handle already bound. Required, since
 * every session answers `health` (clause C-72).
 */
export interface HealthSession {
  health(ctx: CallContext): Promise<HealthInfo>;
}

/** How a panel call ended: answered with the session's own answer, refused before or after the call, or stopped. */
export type PanelRecord =
  | RefusedRecord
  | StoppedRecord
  | { readonly kind: "answered"; readonly answer: MonitoringPanelAnswer };

/**
 * How a pool statistics call ended: answered with the session's own statistics, refused before or after the call, or
 * stopped.
 */
export type PoolStatsRecord = RefusedRecord | StoppedRecord | { readonly kind: "answered"; readonly answer: PoolStats };

/** How a health call ended: answered with the session's own health, refused before or after the call, or stopped. */
export type HealthRecord = RefusedRecord | StoppedRecord | { readonly kind: "answered"; readonly answer: HealthInfo };

/** `fn`, the session's function for `facet`; a host defect when the session offers the facet and holds no function. */
function offeredFunction<Fn>(fn: Fn | undefined, facet: MonitoringFacet): Fn {
  if (fn === undefined) {
    throw new Error(
      `The session offers monitoring.${facet} and has no ${facet} function, a defect of the host's session.`,
    );
  }
  return fn;
}

/**
 * One monitoring call: refused as a record by the first of `checks` that refuses, after the context's own check;
 * otherwise `ctx` and `request` frozen, `call` started and waited for until `ctx.signal`, what it answered read with
 * `checkAnswer`, and answered as a record: refused, `called` true, with the check's refusals, or answered with the
 * answer by reference.
 */
async function monitoringCall<Answer>(
  checks: readonly (() => readonly CallRefusal[])[],
  call: () => Promise<unknown>,
  checkAnswer: (answer: unknown) => AnswerCheck<Answer>,
  request: object | undefined,
  ctx: CallContext,
  ports: Pick<HostCallPorts, "late">,
): Promise<RefusedRecord | StoppedRecord | { readonly kind: "answered"; readonly answer: Answer }> {
  for (const check of [() => checkCallStart(ctx), ...checks]) {
    const refusals = check();
    if (refusals.length > 0) return refusedBefore(refusals, ctx);
  }
  freezeContext(ctx);
  if (request !== undefined) freezeData(request);
  const running = startCall(call);
  try {
    const check = checkAnswer(await awaitWithin(running, ctx.signal, lateFailure(ctx, ports.late)));
    if (check.kind === "refused") return { kind: "refused", called: true, refusals: check.refusals };
    return { kind: "answered", answer: check.answer };
  } catch (error) {
    if (!stoppedBy(ctx, error)) throw error;
    return { kind: "stopped", reason: error, settled: settledOf(running) };
  }
}

/**
 * One `monitoring.panel` call on `session`: checked, the facet and the request against the session's panels included,
 * frozen, waited for until `ctx.signal`, its answer read with `checkPanelAnswer`, answered as a record with the
 * session's answer by reference, or refused, `called` true, when it is not its panel's form. A failure after
 * the wait ended reaches `ports.late` once, and a later answer is dropped.
 *
 * @throws The provider's error by reference, or a host defect when the session offers the facet and holds no function.
 */
export function panelCall(
  session: MonitoringSession,
  request: MonitoringPanelRequest,
  ctx: CallContext,
  ports: Pick<HostCallPorts, "late">,
): Promise<PanelRecord> {
  return monitoringCall(
    [() => checkMonitoringFacet(session.calls, "panel"), () => checkMonitoringPanelRequest(session.panels, request)],
    () => offeredFunction(session.panel, "panel").call(session, request, ctx),
    (answer) => checkPanelAnswer(request, answer),
    request,
    ctx,
    ports,
  );
}

/**
 * One `monitoring.poolStats` call on `session`: checked, the facet included, frozen, waited for until `ctx.signal`,
 * its answer read with `checkPoolStatsAnswer`, answered as a record with the session's statistics by reference, or
 * refused, `called` true, when it is not the SDK's `PoolStats`. A failure after the wait ended reaches `ports.late`
 * once, and a later answer is dropped.
 *
 * @throws The provider's error by reference, or a host defect when the session offers the facet and holds no function.
 */
export function poolStatsCall(
  session: MonitoringSession,
  ctx: CallContext,
  ports: Pick<HostCallPorts, "late">,
): Promise<PoolStatsRecord> {
  return monitoringCall(
    [() => checkMonitoringFacet(session.calls, "poolStats")],
    () => offeredFunction(session.poolStats, "poolStats").call(session, ctx),
    checkPoolStatsAnswer,
    undefined,
    ctx,
    ports,
  );
}

/**
 * One `health` call on `session`: checked for its context only, since every session answers it, frozen, waited for
 * until `ctx.signal`, its answer read with `checkHealthAnswer`, answered as a record with the session's health by
 * reference, or refused, `called` true, when it is not the SDK's `HealthInfo`. A failure after the wait ended
 * reaches `ports.late` once, and a later answer is dropped.
 *
 * @throws The provider's error by reference.
 */
export function healthCall(
  session: HealthSession,
  ctx: CallContext,
  ports: Pick<HostCallPorts, "late">,
): Promise<HealthRecord> {
  return monitoringCall([], () => session.health(ctx), checkHealthAnswer, undefined, ctx, ports);
}

/** The monitoring calls one host core holds, the health call among them. */
export interface MonitoringCalls {
  readonly panelCall: typeof panelCall;
  readonly poolStatsCall: typeof poolStatsCall;
  readonly healthCall: typeof healthCall;
}
