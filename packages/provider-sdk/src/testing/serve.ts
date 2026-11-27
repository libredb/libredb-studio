/**
 * The memory test transport (docs/providers/CONTRACT.md, clauses C-19, C-22 to C-25, C-27, C-31 to C-33 and M-89): `serve`
 * puts a provider module record behind JSON frames, so a test calls a provider exactly as the contract says calls
 * look.
 *
 * Every call crosses as one request frame and one answer frame, each the JSON text of values `encodeValue` wrote; a call
 * with no request part, `health` and `monitoring.poolStats`, carries only its context in its request frame. Each frame
 * is parsed and decoded with `decodeValue` on the other side, read as the closed shape of its call type (`readFrame`)
 * and compared with what the sending side handed (`roundTripRefusals`); a frame either refuses is thrown as one
 * `FrameRefusalError`. The provider's side passes the implementation decoded copies, its context frozen by
 * `freezeContext` with the host's `signal` and `env` attached by reference, its request by `freezeData`, and a pull's
 * limit frozen with the host's `measure` attached by reference: a frame carries only the limit's numbers. The host
 * receives decoded copies of each answer, so a row that crossed is a new array, which the host's pump measures itself.
 * A value outside the codec's domain fails where it is encoded, with the codec's own `ValueCodecError`, before the
 * other side is called, and an error either side throws crosses by reference.
 *
 * A session handle and a result source never cross. The served instance keeps them in tables of its own: on the
 * provider's side, each session id to the provider's handle and each result id to the provider's source; on the host's
 * side, a frozen token to the session's id and calls, and each served source holds its own id and whether it is open.
 * A token is looked up by identity, so a copy of one is foreign. A closed or foreign token, and a closed source, are
 * refused before any frame; a close takes its entry out of both tables whatever the provider's close answers.
 *
 * The host's side refuses, before any frame and before anything else it checks, a call whose deadline has passed or
 * whose signal has aborted (`checkCallStart`), the signal's reason as the error's cause, so the provider is never
 * called and the tables are unchanged. It holds every call to the session's calls before any frame
 * (`checkExecuteRequest`, `checkConsoleFacet`, `checkObjectsFacet`, `checkMaintenanceFacet`, `checkMonitoringFacet`),
 * every execute to the read-only policy its session was opened under (`checkReadOnlyRequest`, clause C-78), read from
 * the open context's `policy` and kept with the session,
 * every maintenance request to the session's maintenance (`checkMaintenanceRunRequest`,
 * `checkMaintenancePreviewRequest`), every monitoring panel request to the panels the session's engine offers
 * (`checkMonitoringPanelRequest`) and every tree request to the object model the session's engine states
 * (`checkTreeRequest`, clause M-89), reads `open`'s refinement with `sessionCalls` and `sessionMaintenance`, the latter
 * against the maintenance of the engine the open context names, which it refuses before any frame when the module's
 * manifest does not declare it,
 * and closes what an answer it refuses handed over: the session through the provider's `close`, under a cleanup
 * context of its own (`cleanupContext`), never the open's, which may have aborted, and each source through its own,
 * every close run and no failure lost.
 * The host's side reads a decoded execute answer as the host core does (`checkExecuteAnswer`, clause C-112) and throws
 * a member outside the SDK's types as a `CallRefusalError`, after closing the answer's sources, so a provider's own
 * test refuses what Studio refuses.
 * Every loop over a provider's array stops at its first hole, an execute answer's result that is not an object is
 * refused at its index like a hole, and a served source asks the provider for exactly the limit it is pulled with, so
 * a frame never grows past what the provider holds.
 *
 * `serve` races nothing: the host owns the deadline, and an answer the host stopped waiting for (`awaitWithin`) is
 * delivered whole, its token and served sources included, for the host's late handler to close. Each served instance
 * keeps its sessions in its own tables, so a token of one is foreign to another.
 */
import type { Calls, MonitoringPanels, ObjectModel, ProviderManifest } from "../manifest/manifest-types.generated";
import { cleanupContext, refuseCallStart } from "../calls/deadline";
import { checkProviderModule, ProviderDefinitionError } from "../calls/define-provider";
import { freezeContext, freezeData } from "../calls/freeze";
import { isPlainRecord, pointerTo, readOwn } from "../calls/records";
import { checkExecuteAnswer } from "../calls/answers";
import { type CallRefusal, CallRefusalError } from "../calls/refusals";
import {
  checkConsoleFacet,
  checkExecuteRequest,
  checkMaintenanceFacet,
  checkMaintenancePreviewRequest,
  checkMaintenanceRunRequest,
  checkMonitoringFacet,
  checkMonitoringPanelRequest,
  checkObjectsFacet,
  checkReadOnlyRequest,
  checkTreeRequest,
  sessionCalls,
  sessionMaintenance,
} from "../calls/session";
import type {
  BatchLimit,
  CallContext,
  CancelAnswer,
  CancelRequest,
  ConsoleFacet,
  ConsoleImpl,
  EndScopeAnswer,
  EngineMaintenance,
  EndScopeRequest,
  ExecuteAnswer,
  ExecuteRequest,
  HealthInfo,
  MaintenanceFacet,
  MaintenanceImpl,
  MaintenancePreview,
  MaintenancePreviewRequest,
  MaintenanceRunAnswer,
  MaintenanceRunRequest,
  MonitoringImpl,
  MonitoringPanelAnswer,
  MonitoringPanelRequest,
  ObjectsImpl,
  OpenAnswer,
  OpenContext,
  PoolStats,
  ProviderImpl,
  ProviderModule,
  ResultSource,
  RowBatch,
  TransactionAnswer,
  TransactionRequest,
  TreeAnswer,
  TreeRequest,
} from "../calls/types";
import { decodeValue, encodeValue } from "../values/codec";
import { type FramePart, type FrameRefusal, FrameRefusalError, type ServedCall } from "./frames";
import { roundTripRefusals } from "./round-trip";
import { type BatchLimitData, type FramePartOf, readFrame } from "./shapes";

/** One frame, as the observer sees it before the other side reads it. */
export interface ServedFrame {
  readonly call: ServedCall;
  readonly direction: "to-provider" | "to-host";
  /** The frame's JSON text. */
  readonly text: string;
}

export interface ServeOptions {
  /** Sees every frame, frozen, before the other side reads it; a throw propagates by reference. */
  readonly observe?: (frame: ServedFrame) => void;
}

/** The host's token for a served session: frozen, looked up by identity, its id the only thing that names it. */
export interface ServedHandle {
  readonly session: string;
}

/** The context members that are host services, never framed. */
const SERVICES: readonly string[] = Object.freeze(["signal", "env"] satisfies (keyof CallContext)[]);

/**
 * What the host's side keeps of an open session: its calls and its maintenance, narrowed as its open answered, the
 * monitoring panels and the object model of the engine it was opened as, the latter absent where the engine states
 * none, and whether its open policy made it a read-only statement session, `policy.readOnly` and
 * `policy.sendsStatements` both true.
 */
interface HostSession {
  readonly id: string;
  readonly calls: Calls;
  readonly readOnlyStatements: boolean;
  readonly maintenance: EngineMaintenance;
  readonly monitoring: MonitoringPanels;
  readonly objectModel?: ObjectModel;
}

/** The maintenance each engine of `manifest` declares, by its id: the two maintenance members of its facets. */
function engineMaintenance(manifest: ProviderManifest): ReadonlyMap<string, EngineMaintenance> {
  return new Map(
    manifest.engines.map((engine) => [
      engine.id,
      { maintenance: engine.facets.maintenance, maintenanceSpecs: engine.facets.maintenanceSpecs },
    ]),
  );
}

/** The monitoring panels each engine of `manifest` declares, by its id. */
function enginePanels(manifest: ProviderManifest): ReadonlyMap<string, MonitoringPanels> {
  return new Map(manifest.engines.map((engine) => [engine.id, engine.facets.monitoring]));
}

/** The object model each engine of `manifest` states, by its id; an engine that states none has no entry. */
function engineObjectModels(manifest: ProviderManifest): ReadonlyMap<string, ObjectModel> {
  return new Map(
    manifest.engines.flatMap((engine) => (engine.objects === undefined ? [] : [[engine.id, engine.objects]])),
  );
}

/**
 * The refusals of a tree request on `session`: `objects.tree` not offered, else every way the request names what the
 * engine's object model does not state (`checkTreeRequest`).
 *
 * @throws {Error} When the session offers `objects.tree` and its engine states no object model, which the validator's
 * `object-model-missing` refuses in an admitted manifest, so only a manifest no validator read reaches it: the host's
 * defect.
 */
function treeRefusals(session: HostSession, request: TreeRequest): readonly CallRefusal[] {
  const offered = checkObjectsFacet(session.calls, "tree");
  if (offered.length > 0) return offered;
  if (session.objectModel === undefined) {
    throw new Error(
      "The session offers objects.tree and its engine states no object model, a defect of the host's session.",
    );
  }
  return checkTreeRequest(session.objectModel, request);
}

/** The limit's data, the copy the encoder is handed: its numbers, without the host's measure. */
function limitData(limit: BatchLimit): BatchLimitData {
  return { maxRows: limit.maxRows, maxBytes: limit.maxBytes };
}

/** The context's data, the copy the encoder is handed: its own enumerable string keys but the host services. */
function contextData(ctx: CallContext): Readonly<Record<string, unknown>> {
  const fields = ctx as unknown as Readonly<Record<string, unknown>>;
  return Object.fromEntries(Object.keys(ctx).flatMap((key) => (SERVICES.includes(key) ? [] : [[key, fields[key]]])));
}

/** `refusals` thrown as one `FrameRefusalError`, when there is any. */
function refuseFrame(refusals: readonly FrameRefusal[]): void {
  if (refusals.length > 0) throw new FrameRefusalError(refusals);
}

/** One refusal of `call`'s `part` at `pointer`. */
function refused(rule: FrameRefusal["rule"], call: ServedCall, part: FramePart, pointer: string): FrameRefusal {
  return { rule, call, part, pointer };
}

/**
 * `error`, thrown after every one of `closes` has run: alone when each close succeeded, or in an `AggregateError` with
 * every close error after it, so no failure is lost.
 */
async function throwAfterClosing(error: unknown, closes: readonly (() => Promise<void>)[]): Promise<never> {
  const settled = await Promise.allSettled(closes.map((close) => close()));
  const failures = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (failures.length === 0) throw error;
  throw new AggregateError(
    [error, ...failures],
    "The host refused an answer, and closing what the answer handed over failed too.",
  );
}

/**
 * `module` served over the memory test transport: an implementation of the same manifest whose every call crosses as
 * frames, its handles and result sources kept in tables the served instance owns. The module is checked first, and
 * its declared calls and its implementation's functions are read once, so a later change to the record changes nothing
 * served.
 *
 * @throws {ProviderDefinitionError} With every refusal `checkProviderModule` answers, before anything is served.
 */
export function serve(module: ProviderModule, options: ServeOptions = {}): ProviderImpl<ServedHandle> {
  const definitionRefusals = checkProviderModule(module);
  if (definitionRefusals.length > 0) throw new ProviderDefinitionError(definitionRefusals);
  const manifest = module.manifest as ProviderManifest;
  const declared = sessionCalls(manifest.calls, undefined);
  const engines = engineMaintenance(manifest);
  const panels = enginePanels(manifest);
  const objectModels = engineObjectModels(manifest);
  const impl = module.impl;
  const consoleImpl = impl.console;
  const objectsImpl = impl.objects;
  const maintenanceImpl = impl.maintenance;
  const monitoringImpl = impl.monitoring;
  const provider = Object.freeze({
    open: impl.open,
    close: impl.close,
    health: impl.health,
    execute: consoleImpl.execute,
    cancel: consoleImpl.cancel,
    endScope: consoleImpl.endScope,
    transaction: consoleImpl.transaction,
    tree: objectsImpl?.tree,
    run: maintenanceImpl?.run,
    preview: maintenanceImpl?.preview,
    panel: monitoringImpl?.panel,
    poolStats: monitoringImpl?.poolStats,
  });
  const observe = options.observe;

  /** The provider's side: each session id to the provider's handle, each result id to the provider's source. */
  const handles = new Map<string, unknown>();
  const sources = new Map<string, ResultSource>();
  /** The host's side: each token to its session. */
  const sessions = new Map<unknown, HostSession>();
  let sessionCount = 0;
  let resultCount = 0;

  /** `frame` as JSON text, shown to the observer, and parsed as the other side reads it. */
  function cross(call: ServedCall, direction: ServedFrame["direction"], frame: object): Record<string, unknown> {
    const text = JSON.stringify(frame);
    observe?.(Object.freeze({ call, direction, text }));
    return JSON.parse(text) as Record<string, unknown>;
  }

  /**
   * The decoded `part` of a parsed frame, read as the closed shape of `call`'s part and compared with `sent`.
   *
   * @throws {FrameRefusalError} With every refusal of either.
   */
  function receive<Call extends ServedCall>(
    call: Call,
    part: FramePartOf<Call> & FramePart,
    wire: unknown,
    sent: unknown,
    skip: readonly string[] = [],
  ): unknown {
    const decoded = decodeValue(wire);
    refuseFrame([...readFrame(call, part, decoded), ...roundTripRefusals(sent, decoded, { call, part, skip })]);
    return decoded;
  }

  /** The provider's copy of a call context the host passed: decoded, frozen, with the host's services attached. */
  function providerContext<C extends CallContext>(decoded: unknown, ctx: CallContext): C {
    return freezeContext({ ...(decoded as object), signal: ctx.signal, env: ctx.env } as unknown as C);
  }

  /**
   * The host's session for `handle`.
   *
   * @throws {FrameRefusalError} As `session-not-open` when the served instance holds no open session for it.
   */
  function hostSession(call: ServedCall, handle: unknown): HostSession {
    const session = sessions.get(handle);
    if (session === undefined) throw new FrameRefusalError([refused("session-not-open", call, "handle", "")]);
    return session;
  }

  /** Closes the provider's session `id` on the provider's side, taking it out of the table first. */
  async function closeProviderSession(id: string, ctx: CallContext): Promise<void> {
    const handle = handles.get(id);
    handles.delete(id);
    await provider.close.call(impl, handle, ctx);
  }

  /** Closes the provider's source `id` on the provider's side, taking it out of the table first. */
  async function closeProviderSource(id: string): Promise<void> {
    const source = sources.get(id) as ResultSource;
    sources.delete(id);
    await source.close();
  }

  /**
   * One facet call on the session `handle` with `request`, held first to the host's session by `check`: the request
   * and context frame, the provider's call `fn` on decoded copies, with `owner` as its `this`, and the answer frame,
   * read and compared, decoded for the host.
   */
  async function facetCall<Answer>(
    call:
      | "console.cancel"
      | "console.endScope"
      | "console.transaction"
      | "objects.tree"
      | "maintenance.run"
      | "maintenance.preview"
      | "monitoring.panel",
    check: (session: HostSession) => readonly CallRefusal[],
    fn: (handle: unknown, request: unknown, ctx: CallContext) => Promise<unknown>,
    owner: unknown,
    handle: unknown,
    request:
      | CancelRequest
      | EndScopeRequest
      | TransactionRequest
      | TreeRequest
      | MaintenanceRunRequest
      | MaintenancePreviewRequest
      | MonitoringPanelRequest,
    ctx: CallContext,
  ): Promise<Answer> {
    refuseCallStart(ctx);
    const session = hostSession(call, handle);
    const refusals = check(session);
    if (refusals.length > 0) throw new CallRefusalError(refusals);
    const sent = cross(call, "to-provider", {
      call,
      session: session.id,
      context: encodeValue(contextData(ctx)),
      request: encodeValue(request),
    });
    const providerCtx = providerContext<CallContext>(receive(call, "context", sent.context, ctx, SERVICES), ctx);
    const providerRequest = freezeData(receive(call, "request", sent.request, request));
    const answer = await fn.call(owner, handles.get(session.id), providerRequest, providerCtx);
    const received = cross(call, "to-host", { answer: encodeValue(answer) });
    return receive(call, "answer", received.answer, answer) as Answer;
  }

  /**
   * One call on the session `handle` with no request part, held first to the host's session by `check`: the context
   * frame, the provider's call `fn` on its decoded copy, with `owner` as its `this`, and the answer frame, read and
   * compared, decoded for the host.
   */
  async function contextCall<Answer>(
    call: "health" | "monitoring.poolStats",
    check: (session: HostSession) => readonly CallRefusal[],
    fn: (handle: unknown, ctx: CallContext) => Promise<unknown>,
    owner: unknown,
    handle: unknown,
    ctx: CallContext,
  ): Promise<Answer> {
    refuseCallStart(ctx);
    const session = hostSession(call, handle);
    const refusals = check(session);
    if (refusals.length > 0) throw new CallRefusalError(refusals);
    const sent = cross(call, "to-provider", { call, session: session.id, context: encodeValue(contextData(ctx)) });
    const providerCtx = providerContext<CallContext>(receive(call, "context", sent.context, ctx, SERVICES), ctx);
    const answer = await fn.call(owner, handles.get(session.id), providerCtx);
    const received = cross(call, "to-host", { answer: encodeValue(answer) });
    return receive(call, "answer", received.answer, answer) as Answer;
  }

  /** One console facet call: a facet call held to the session's console calls, on the provider's console. */
  function consoleCall<Answer>(
    call: "console.cancel" | "console.endScope" | "console.transaction",
    facet: ConsoleFacet,
    handle: unknown,
    request: CancelRequest | EndScopeRequest | TransactionRequest,
    ctx: CallContext,
  ): Promise<Answer> {
    const fn = provider[facet] as (handle: unknown, request: unknown, ctx: CallContext) => Promise<unknown>;
    const check = (session: HostSession) => checkConsoleFacet(session.calls, facet);
    return facetCall<Answer>(call, check, fn, consoleImpl, handle, request, ctx);
  }

  /**
   * One maintenance facet call: a facet call held to the session's maintenance calls and its request to the session's
   * maintenance by `checkRequest`, the facet first, on the provider's maintenance.
   */
  function maintenanceCall<Answer>(
    call: "maintenance.run" | "maintenance.preview",
    facet: MaintenanceFacet,
    checkRequest: (maintenance: EngineMaintenance) => readonly CallRefusal[],
    handle: unknown,
    request: MaintenanceRunRequest | MaintenancePreviewRequest,
    ctx: CallContext,
  ): Promise<Answer> {
    const fn = provider[facet] as (handle: unknown, request: unknown, ctx: CallContext) => Promise<unknown>;
    const check = (session: HostSession) => {
      const offered = checkMaintenanceFacet(session.calls, facet);
      return offered.length > 0 ? offered : checkRequest(session.maintenance);
    };
    return facetCall<Answer>(call, check, fn, maintenanceImpl, handle, request, ctx);
  }

  /** A served source over the provider's source `id`, with the columns and the row count its descriptor carried. */
  function servedSource(id: string, descriptor: Readonly<Record<string, unknown>>): ResultSource {
    let open = true;
    const notOpen = (call: ServedCall) => new FrameRefusalError([refused("result-not-open", call, "handle", "")]);
    return Object.freeze({
      columns: descriptor.columns as ResultSource["columns"],
      ...(descriptor.rowCount === undefined ? {} : { rowCount: descriptor.rowCount as number }),
      async next(limit: BatchLimit): Promise<RowBatch> {
        if (!open) throw notOpen("result.next");
        const sent = cross("result.next", "to-provider", {
          call: "result.next",
          result: id,
          request: encodeValue(limitData(limit)),
        });
        const decoded = receive("result.next", "request", sent.request, limit, ["measure"]) as BatchLimitData;
        const providerLimit: BatchLimit = Object.freeze({ ...freezeData(decoded), measure: limit.measure });
        const batch = await (sources.get(id) as ResultSource).next(providerLimit);
        const received = cross("result.next", "to-host", { answer: encodeValue(batch) });
        return receive("result.next", "answer", received.answer, batch) as RowBatch;
      },
      async close(): Promise<void> {
        if (!open) throw notOpen("result.close");
        open = false;
        cross("result.close", "to-provider", { call: "result.close", result: id });
        const source = sources.get(id) as ResultSource;
        sources.delete(id);
        const answer: unknown = await source.close();
        if (answer !== undefined) refuseFrame([refused("frame-value-unreadable", "result.close", "answer", "")]);
        cross("result.close", "to-host", {});
      },
    });
  }

  /**
   * The descriptors of the sources `results` holds, each registered in the provider's table under a new id pushed to
   * `ids`, in order, before its `columns` and `rowCount` are read, so the caller closes it when a read throws; the walk
   * stops at the first hole, accessor or item that is not an object, refused at its index.
   */
  function registerSources(
    results: readonly unknown[],
    ids: string[],
  ): {
    readonly descriptors: readonly Readonly<Record<string, unknown>>[];
    readonly refusal?: FrameRefusal;
  } {
    const descriptors: Readonly<Record<string, unknown>>[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const read = readOwn(results, String(index));
      if (read.kind !== "data" || typeof read.value !== "object" || read.value === null) {
        const pointer = pointerTo("/results", index);
        return { descriptors, refusal: refused("frame-value-unreadable", "console.execute", "answer", pointer) };
      }
      const source = read.value as ResultSource;
      resultCount += 1;
      const id = `result-${resultCount}`;
      sources.set(id, source);
      ids.push(id);
      const rowCount = source.rowCount;
      descriptors.push({ result: id, columns: source.columns, ...(rowCount === undefined ? {} : { rowCount }) });
    }
    return { descriptors };
  }

  async function open(ctx: OpenContext): Promise<OpenAnswer<ServedHandle>> {
    refuseCallStart(ctx);
    const engine = engines.get(ctx.engine);
    if (engine === undefined) {
      throw new Error(
        `The open context names the engine ${JSON.stringify(ctx.engine)}, which the served module's manifest does not declare, so the provider was not called.`,
      );
    }
    const sent = cross("open", "to-provider", { call: "open", context: encodeValue(contextData(ctx)) });
    const providerCtx = providerContext<OpenContext>(receive("open", "context", sent.context, ctx, SERVICES), ctx);
    const answer: unknown = await provider.open.call(impl, providerCtx);
    if (!isPlainRecord(answer)) {
      throw new FrameRefusalError([refused("frame-value-unreadable", "open", "answer", "")]);
    }
    const handleRead = readOwn(answer, "handle");
    if (handleRead.kind !== "data") {
      throw new FrameRefusalError([
        handleRead.kind === "absent"
          ? { rule: "frame-key-missing", call: "open", part: "answer", pointer: "/handle", name: "handle" }
          : refused("frame-value-unreadable", "open", "answer", "/handle"),
      ]);
    }
    sessionCount += 1;
    const id = `session-${sessionCount}`;
    handles.set(id, handleRead.value);
    // The open's own context may have aborted, so the close a refused answer needs runs under one of its own.
    const closeSession = () => {
      const cleanup = cleanupContext(ctx.env);
      return closeProviderSession(id, providerContext<CallContext>({ deadline: cleanup.deadline }, cleanup));
    };
    try {
      const fields = answer as Readonly<Record<string, unknown>>;
      const framed = Object.fromEntries(
        Object.keys(answer).flatMap((key) => (key === "handle" ? [] : [[key, fields[key]]])),
      );
      const received = cross("open", "to-host", { session: id, answer: encodeValue(framed) });
      const decoded = receive("open", "answer", received.answer, answer, ["handle"]) as Record<string, unknown>;
      const refine = decoded.refine as OpenAnswer<unknown>["refine"];
      const calls = sessionCalls(declared, refine);
      const maintenance = sessionMaintenance(engine, refine);
      const token: ServedHandle = Object.freeze({ session: id });
      const readOnlyStatements = ctx.policy.readOnly && ctx.policy.sendsStatements;
      const monitoring = panels.get(ctx.engine) as MonitoringPanels;
      const objectModel = objectModels.get(ctx.engine);
      sessions.set(token, {
        id,
        calls,
        readOnlyStatements,
        maintenance,
        monitoring,
        ...(objectModel === undefined ? {} : { objectModel }),
      });
      return { ...decoded, handle: token };
    } catch (error) {
      return throwAfterClosing(error, [closeSession]);
    }
  }

  async function close(handle: ServedHandle, ctx: CallContext): Promise<void> {
    refuseCallStart(ctx);
    const session = hostSession("close", handle);
    const sent = cross("close", "to-provider", {
      call: "close",
      session: session.id,
      context: encodeValue(contextData(ctx)),
    });
    const providerCtx = providerContext<CallContext>(receive("close", "context", sent.context, ctx, SERVICES), ctx);
    const providerHandle = handles.get(session.id);
    sessions.delete(handle);
    handles.delete(session.id);
    const answer: unknown = await provider.close.call(impl, providerHandle, providerCtx);
    if (answer !== undefined) refuseFrame([refused("frame-value-unreadable", "close", "answer", "")]);
    cross("close", "to-host", {});
  }

  async function execute(handle: ServedHandle, request: ExecuteRequest, ctx: CallContext): Promise<ExecuteAnswer> {
    const call = "console.execute";
    refuseCallStart(ctx);
    const session = hostSession(call, handle);
    const requestRefusals = checkExecuteRequest(session.calls, request);
    if (requestRefusals.length > 0) throw new CallRefusalError(requestRefusals);
    const policyRefusals = checkReadOnlyRequest(session.readOnlyStatements, request);
    if (policyRefusals.length > 0) throw new CallRefusalError(policyRefusals);
    const sent = cross(call, "to-provider", {
      call,
      session: session.id,
      context: encodeValue(contextData(ctx)),
      request: encodeValue(request),
    });
    const providerCtx = providerContext<CallContext>(receive(call, "context", sent.context, ctx, SERVICES), ctx);
    const providerRequest = freezeData(receive(call, "request", sent.request, request) as ExecuteRequest);
    const answer: unknown = await provider.execute.call(
      consoleImpl,
      handles.get(session.id),
      providerRequest,
      providerCtx,
    );
    if (!isPlainRecord(answer)) throw new FrameRefusalError([refused("frame-value-unreadable", call, "answer", "")]);
    const resultsRead = readOwn(answer, "results");
    const results = resultsRead.kind === "data" ? resultsRead.value : undefined;
    const ids: string[] = [];
    try {
      const registered = Array.isArray(results) ? registerSources(results, ids) : { descriptors: [] };
      if (registered.refusal !== undefined) throw new FrameRefusalError([registered.refusal]);
      const fields = answer as Readonly<Record<string, unknown>>;
      const framed = Object.fromEntries(
        Object.keys(answer).map((key) => [
          key,
          key === "results" && Array.isArray(results) ? registered.descriptors : fields[key],
        ]),
      );
      const received = cross(call, "to-host", { answer: encodeValue(framed) });
      const decoded = decodeValue(received.answer) as Record<string, unknown>;
      const descriptors = Array.isArray(decoded.results)
        ? (decoded.results as Readonly<Record<string, unknown>>[])
        : [];
      refuseFrame([
        ...readFrame(call, "answer", decoded),
        ...roundTripRefusals(answer, decoded, {
          call,
          part: "answer",
          skip: Array.isArray(results) ? ["results"] : [],
        }),
        ...registered.descriptors.flatMap((descriptor, index) =>
          roundTripRefusals(descriptor, descriptors[index], { call, part: "answer" }).map((item) =>
            refused(item.rule, call, "answer", `${pointerTo("/results", index)}${item.pointer}`),
          ),
        ),
      ]);
      const crossed: ExecuteAnswer = {
        ...(decoded as unknown as ExecuteAnswer),
        results: ids.map((id, index) => servedSource(id, descriptors[index] as Record<string, unknown>)),
      };
      const answerRefusals = checkExecuteAnswer(crossed);
      if (answerRefusals.length > 0) throw new CallRefusalError(answerRefusals);
      return crossed;
    } catch (error) {
      return throwAfterClosing(
        error,
        ids.map((id) => () => closeProviderSource(id)),
      );
    }
  }

  const served: ConsoleImpl<ServedHandle> = {
    execute,
    ...(provider.cancel === undefined
      ? {}
      : {
          cancel: (handle: ServedHandle, request: CancelRequest, ctx: CallContext) =>
            consoleCall<CancelAnswer>("console.cancel", "cancel", handle, request, ctx),
        }),
    ...(provider.endScope === undefined
      ? {}
      : {
          endScope: (handle: ServedHandle, request: EndScopeRequest, ctx: CallContext) =>
            consoleCall<EndScopeAnswer>("console.endScope", "endScope", handle, request, ctx),
        }),
    ...(provider.transaction === undefined
      ? {}
      : {
          transaction: (handle: ServedHandle, request: TransactionRequest, ctx: CallContext) =>
            consoleCall<TransactionAnswer>("console.transaction", "transaction", handle, request, ctx),
        }),
  };
  const tree = provider.tree;
  const servedObjects: ObjectsImpl<ServedHandle> =
    tree === undefined
      ? {}
      : {
          tree: (handle: ServedHandle, request: TreeRequest, ctx: CallContext) =>
            facetCall<TreeAnswer>(
              "objects.tree",
              (session) => treeRefusals(session, request),
              tree as (handle: unknown, request: unknown, ctx: CallContext) => Promise<unknown>,
              objectsImpl,
              handle,
              request,
              ctx,
            ),
        };
  const servedMaintenance: MaintenanceImpl<ServedHandle> = {
    ...(provider.run === undefined
      ? {}
      : {
          run: (handle: ServedHandle, request: MaintenanceRunRequest, ctx: CallContext) =>
            maintenanceCall<MaintenanceRunAnswer>(
              "maintenance.run",
              "run",
              (maintenance) => checkMaintenanceRunRequest(maintenance, request),
              handle,
              request,
              ctx,
            ),
        }),
    ...(provider.preview === undefined
      ? {}
      : {
          preview: (handle: ServedHandle, request: MaintenancePreviewRequest, ctx: CallContext) =>
            maintenanceCall<MaintenancePreview>(
              "maintenance.preview",
              "preview",
              (maintenance) => checkMaintenancePreviewRequest(maintenance, request),
              handle,
              request,
              ctx,
            ),
        }),
  };
  const { panel, poolStats } = provider;
  const servedMonitoring: MonitoringImpl<ServedHandle> = {
    ...(panel === undefined
      ? {}
      : {
          panel: (handle: ServedHandle, request: MonitoringPanelRequest, ctx: CallContext) =>
            facetCall<MonitoringPanelAnswer>(
              "monitoring.panel",
              (session) => {
                const offered = checkMonitoringFacet(session.calls, "panel");
                return offered.length > 0 ? offered : checkMonitoringPanelRequest(session.monitoring, request);
              },
              panel as (handle: unknown, request: unknown, ctx: CallContext) => Promise<unknown>,
              monitoringImpl,
              handle,
              request,
              ctx,
            ),
        }),
    ...(poolStats === undefined
      ? {}
      : {
          poolStats: (handle: ServedHandle, ctx: CallContext) =>
            contextCall<PoolStats>(
              "monitoring.poolStats",
              (session) => checkMonitoringFacet(session.calls, "poolStats"),
              poolStats as (handle: unknown, ctx: CallContext) => Promise<unknown>,
              monitoringImpl,
              handle,
              ctx,
            ),
        }),
  };
  return Object.freeze({
    open,
    close,
    health: (handle: ServedHandle, ctx: CallContext) =>
      contextCall<HealthInfo>("health", () => [], provider.health, impl, handle, ctx),
    console: Object.freeze(served),
    objects: Object.freeze(servedObjects),
    maintenance: Object.freeze(servedMaintenance),
    monitoring: Object.freeze(servedMonitoring),
  });
}
