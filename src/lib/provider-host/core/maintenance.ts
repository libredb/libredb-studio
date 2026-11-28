/**
 * The host's maintenance calls (docs/providers/CONTRACT.md, clauses C-69, C-68, C-17, C-27 and C-28), part of the
 * provider host core.
 *
 * `maintenanceRunCall` makes one `maintenance.run` call on a session and `maintenancePreviewCall` one
 * `maintenance.preview` call, and each answers a record of how it ended. Each is checked before it is made:
 * `checkCallStart` refuses a call whose deadline passed or whose signal aborted, then `checkMaintenanceFacet` a session
 * that does not offer the facet, then `checkMaintenanceRunRequest` or `checkMaintenancePreviewRequest` a request the
 * session's maintenance does not take, the engine's declaration narrowed by what its server accepts (clause C-68). Each
 * refusal is answered as a record, `called` false, and the provider is never called. Then the context and the request
 * are frozen in place, `freezeContext` and `freezeData`, so the caller builds both fresh for each call.
 *
 * The call is waited for with `awaitWithin` until the context's signal. An answer is read once with the SDK's check of
 * its call (clause C-112), whatever session answered it, a package's or the bridge's: `checkMaintenanceRunAnswer` and
 * `checkMaintenancePreviewAnswer`. One outside the SDK's types is refused as a record, `called` true, each refusal
 * naming its call's rule and its pointer, never a value. Past the check the answer is the session's own, by reference,
 * typed as the check answers it, read under operator trust as the tree call reads its answer. A wait the signal ends answers a stop, the signal's reason by reference, and `settled`, which resolves once the call
 * the host stopped waiting for has settled either way; a failure after the stop reaches `ports.late` once and a later
 * answer is dropped, so no promise the host stopped waiting for is left without a handler. A provider's error passes
 * by reference.
 *
 * Both calls share one private helper, `maintenanceCall`, and read the core's call machinery from the console calls
 * (src/lib/provider-host/core/console.ts): `refusedBefore`, `stoppedBy`, `lateFailure`, `settledOf` and `startCall`,
 * one definition for every call the core makes, as the tree call reads them. Like them they construct no class and
 * keep no module state.
 */
import {
  type AnswerCheck,
  awaitWithin,
  type CallContext,
  type CallRefusal,
  checkCallStart,
  checkMaintenanceFacet,
  checkMaintenancePreviewAnswer,
  checkMaintenancePreviewRequest,
  checkMaintenanceRunAnswer,
  checkMaintenanceRunRequest,
  type EngineMaintenance,
  freezeContext,
  freezeData,
  type MaintenanceFacet,
  type MaintenancePreview,
  type MaintenancePreviewRequest,
  type MaintenanceRunAnswer,
  type MaintenanceRunRequest,
} from "@libredb/provider-sdk/calls";
import type { Calls } from "@libredb/provider-sdk/manifest";
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
 * One session as the host core calls its maintenance facets: its calls, its maintenance as narrowed for it, and its run
 * and preview functions with the handle already bound.
 */
export interface MaintenanceSession {
  readonly calls: Calls;
  readonly maintenance: EngineMaintenance;
  run?(request: MaintenanceRunRequest, ctx: CallContext): Promise<MaintenanceRunAnswer>;
  preview?(request: MaintenancePreviewRequest, ctx: CallContext): Promise<MaintenancePreview>;
}

/**
 * How a maintenance run call ended: answered with the session's own answer, refused before or after the call, or
 * stopped.
 */
export type MaintenanceRunRecord =
  | RefusedRecord
  | StoppedRecord
  | { readonly kind: "answered"; readonly answer: MaintenanceRunAnswer };

/**
 * How a maintenance preview call ended: answered with the session's own preview, refused before or after the call, or
 * stopped.
 */
export type MaintenancePreviewRecord =
  | RefusedRecord
  | StoppedRecord
  | { readonly kind: "answered"; readonly answer: MaintenancePreview };

/**
 * `fn`, the session's function for `facet`, called on `session` with `request` and `ctx`; a host defect when the session
 * offers the facet and holds no function for it.
 */
function callSession<Request, Answer>(
  session: MaintenanceSession,
  facet: MaintenanceFacet,
  fn: ((request: Request, ctx: CallContext) => Promise<Answer>) | undefined,
  request: Request,
  ctx: CallContext,
): Promise<Answer> {
  if (fn === undefined) {
    throw new Error(
      `The session offers maintenance.${facet} and has no ${facet} function, a defect of the host's session.`,
    );
  }
  return fn.call(session, request, ctx);
}

/**
 * One maintenance call of `facet` on `session`: checked, the facet and then `checkRequest` included, frozen, waited for
 * until `ctx.signal`, what `call` answered read with `checkAnswer`, and answered as a record: refused, `called` true,
 * with the check's refusals, or answered with the answer by reference.
 */
async function maintenanceCall<Request extends object, Answer>(
  session: MaintenanceSession,
  facet: MaintenanceFacet,
  checkRequest: (maintenance: EngineMaintenance, request: Request) => readonly CallRefusal[],
  call: () => Promise<unknown>,
  checkAnswer: (answer: unknown) => AnswerCheck<Answer>,
  request: Request,
  ctx: CallContext,
  ports: Pick<HostCallPorts, "late">,
): Promise<RefusedRecord | StoppedRecord | { readonly kind: "answered"; readonly answer: Answer }> {
  const start = checkCallStart(ctx);
  if (start.length > 0) return refusedBefore(start, ctx);
  const offered = checkMaintenanceFacet(session.calls, facet);
  if (offered.length > 0) return refusedBefore(offered, ctx);
  const taken = checkRequest(session.maintenance, request);
  if (taken.length > 0) return refusedBefore(taken, ctx);
  freezeContext(ctx);
  freezeData(request);
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
 * One `maintenance.run` call on `session`: checked, the facet and the request against the session's maintenance
 * included, frozen, waited for until `ctx.signal`, its answer read with `checkMaintenanceRunAnswer`, answered as a
 * record with the session's answer by reference, or refused, `called` true, when it is not the SDK's
 * `MaintenanceRunAnswer`. A failure after the wait ended reaches `ports.late` once, and a later answer is dropped.
 *
 * @throws The provider's error by reference, or a host defect when the session offers the facet and holds no function.
 */
export function maintenanceRunCall(
  session: MaintenanceSession,
  request: MaintenanceRunRequest,
  ctx: CallContext,
  ports: Pick<HostCallPorts, "late">,
): Promise<MaintenanceRunRecord> {
  const call = () => callSession(session, "run", session.run, request, ctx);
  return maintenanceCall(
    session,
    "run",
    checkMaintenanceRunRequest,
    call,
    checkMaintenanceRunAnswer,
    request,
    ctx,
    ports,
  );
}

/**
 * One `maintenance.preview` call on `session`: checked, the facet and the request against the session's maintenance
 * included, frozen, waited for until `ctx.signal`, its answer read with `checkMaintenancePreviewAnswer`, answered as a
 * record with the session's preview by reference, or refused, `called` true, when it is not the SDK's
 * `MaintenancePreview`. A failure after the wait ended reaches `ports.late` once, and a later answer is dropped.
 *
 * @throws The provider's error by reference, or a host defect when the session offers the facet and holds no function.
 */
export function maintenancePreviewCall(
  session: MaintenanceSession,
  request: MaintenancePreviewRequest,
  ctx: CallContext,
  ports: Pick<HostCallPorts, "late">,
): Promise<MaintenancePreviewRecord> {
  const call = () => callSession(session, "preview", session.preview, request, ctx);
  return maintenanceCall(
    session,
    "preview",
    checkMaintenancePreviewRequest,
    call,
    checkMaintenancePreviewAnswer,
    request,
    ctx,
    ports,
  );
}

/** The maintenance calls one host core holds. */
export interface MaintenanceCalls {
  readonly maintenanceRunCall: typeof maintenanceRunCall;
  readonly maintenancePreviewCall: typeof maintenancePreviewCall;
}
