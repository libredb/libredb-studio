/**
 * The host's monitoring calls (docs/providers/CONTRACT.md, clauses C-73, C-17, C-27 and C-28), part of the provider
 * host core.
 *
 * `panelCall` makes one `monitoring.panel` call on a session and `poolStatsCall` one `monitoring.poolStats` call, and
 * each answers a record of how it ended. Each is checked before it is made: `checkCallStart` refuses a call whose
 * deadline passed or whose signal aborted, then `checkMonitoringFacet` a session that does not offer the facet, then,
 * for a panel, `checkMonitoringPanelRequest` a request for a panel the session's engine does not offer. Each refusal
 * is answered as a record, `called` false, and the provider is never called. Then the context and the panel request
 * are frozen in place, `freezeContext` and `freezeData`, so the caller builds both fresh for each call.
 *
 * The call is waited for with `awaitWithin` until the context's signal. An answer is the session's own, by reference:
 * the core does not read a panel answer's form, and the caller reads the member its request names (clause C-74). A
 * wait the signal ends answers a stop, the signal's reason by reference, and `settled`, which resolves once the call
 * the host stopped waiting for has settled either way; a failure after the stop reaches `ports.late` once and a later
 * answer is dropped, so no promise the host stopped waiting for is left without a handler. A provider's error passes
 * by reference.
 *
 * Both calls share one private helper, `monitoringCall`, and read the core's call machinery from the console calls
 * (src/lib/provider-host/core/console.ts): `refusedBefore`, `stoppedBy`, `lateFailure`, `settledOf` and `startCall`,
 * one definition for every call the core makes, as the tree and maintenance calls read them. Like them they construct
 * no class and keep no module state.
 */
import {
  awaitWithin,
  type CallContext,
  type CallRefusal,
  checkCallStart,
  checkMonitoringFacet,
  checkMonitoringPanelRequest,
  freezeContext,
  freezeData,
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

/** How a panel call ended: answered with the session's own answer, refused before the call, or stopped. */
export type PanelRecord =
  | RefusedRecord
  | StoppedRecord
  | { readonly kind: "answered"; readonly answer: MonitoringPanelAnswer };

/** How a pool statistics call ended: answered with the session's own statistics, refused before the call, or stopped. */
export type PoolStatsRecord = RefusedRecord | StoppedRecord | { readonly kind: "answered"; readonly answer: PoolStats };

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
 * otherwise `ctx` and `request` frozen, `call` started and waited for until `ctx.signal`, answered as a record with what
 * it answered by reference.
 */
async function monitoringCall<Answer>(
  checks: readonly (() => readonly CallRefusal[])[],
  call: () => Promise<Answer>,
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
    const answer = await awaitWithin(running, ctx.signal, lateFailure(ctx, ports.late));
    return { kind: "answered", answer };
  } catch (error) {
    if (!stoppedBy(ctx, error)) throw error;
    return { kind: "stopped", reason: error, settled: settledOf(running) };
  }
}

/**
 * One `monitoring.panel` call on `session`: checked, the facet and the request against the session's panels included,
 * frozen, waited for until `ctx.signal`, answered as a record with the session's answer by reference. A failure after
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
    request,
    ctx,
    ports,
  );
}

/**
 * One `monitoring.poolStats` call on `session`: checked, the facet included, frozen, waited for until `ctx.signal`,
 * answered as a record with the session's statistics by reference. A failure after the wait ended reaches `ports.late`
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
    undefined,
    ctx,
    ports,
  );
}

/** The monitoring calls one host core holds. */
export interface MonitoringCalls {
  readonly panelCall: typeof panelCall;
  readonly poolStatsCall: typeof poolStatsCall;
}
