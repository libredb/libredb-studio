/**
 * The open of a session on an admitted provider package (docs/providers/CONTRACT.md, clauses C-109 and C-111), part of
 * the provider host core.
 *
 * `openContractSession` calls a package's `open` with the context core built and answers a record of how it ended, in
 * this order:
 * 1. `checkCallStart` refuses an open whose deadline passed or whose signal aborted, `called` false, and the package is
 *    never called (clause C-27).
 * 2. The context is frozen in place (`freezeContext`, clause C-11), so the caller builds it fresh for each open.
 * 3. The open is waited for with `awaitWithin` until the context's signal. A wait the signal ends answers a stop with the
 *    signal's reason by reference and `settled`. An open that answers after the stop is never admitted: its handle, when
 *    it has one, is closed once under a cleanup context of its own (clause C-47), and a failure of that close, or of
 *    the open itself after the stop, reaches the caller's `late` port.
 * 4. The answer is read by own data property, never through a getter: an answer that is no plain record, or holds no own
 *    data `handle`, throws a `TypeError` naming the package's defect, and the call fails alone (clause C-31). An answer
 *    with a handle whose `serverVersion` or `engineUser` is present and no text throws the same way, once its handle is
 *    closed.
 * 5. The refinement it answered is read against the manifest's calls (`checkRefinement`) and the engine's maintenance
 *    (`sessionMaintenance`): a refusal closes the handle under a cleanup context and answers `called` true with the
 *    refusals (clause C-10).
 * 6. The session's calls are `sessionCalls` of the manifest's calls and the refinement, its maintenance
 *    `sessionMaintenance` of the engine's, and it is a read-only statement session exactly when the open policy says
 *    `readOnly` and `sendsStatements` (clause C-78). A session that offers `objects.tree` or `objects.source` states the
 *    object model the engine's admitted declaration states, by reference, which the host core holds every tree and
 *    source call to (clauses M-89 and C-115); one that offers neither states none, since nothing reads it.
 *
 * `teardownContractSession` tears a session down under the teardown's deadlines (clause C-45): its close under a cleanup
 * context with the package's environment, waited for at most the close deadline, with no rollback step, since a contract
 * session holds no transaction the host reads. The provider factory (src/lib/db/factory.ts) tears its cached sessions
 * down with it, and Test Connection its one session.
 *
 * The session (`ContractSession`) is the object the host core's calls take: frozen, each member present exactly when its
 * calls offer it, each calling the package's own function as a method of the object that holds it, with the handle
 * first, as a served module calls `open` as a method of its implementation. `execute`, `health` and `close` are always
 * present. The host core's calls check every call against the session's `calls` before it is made, so a facet the
 * package does not offer is refused as a record and the package is never called.
 *
 * Core imports only the SDK's public subpaths other than `testing`, Node built-ins and its own files, constructs no
 * class and keeps no module state (tests/unit/lib/provider-host/core-boundary.test.ts).
 */
import {
  awaitWithin,
  type CallContext,
  type CallRefusal,
  CallRefusalError,
  CLEANUP_DEADLINE_MS,
  checkCallStart,
  checkConsoleFacet,
  checkMaintenanceFacet,
  checkMonitoringFacet,
  checkObjectsFacet,
  checkRefinement,
  cleanupContext,
  type EngineMaintenance,
  type EnvReader,
  freezeContext,
  type LateOutcome,
  type OpenContext,
  type ProviderImpl,
  type Refinement,
  sessionCalls,
  sessionMaintenance,
} from "@libredb/provider-sdk/calls";
import type { Calls, MonitoringPanels, ObjectModel } from "@libredb/provider-sdk/manifest";
import {
  type ConsoleSession,
  type RefusedRecord,
  type StoppedRecord,
  settledOf,
  startCall,
  stoppedBy,
} from "./console";
import type { MaintenanceSession } from "./maintenance";
import type { HealthSession, MonitoringSession } from "./monitoring";
import type { ObjectsSession } from "./objects";
import {
  settleWithin,
  TEARDOWN_CLOSE_MS,
  TEARDOWN_ROLLBACK_MS,
  type TeardownDeadlines,
  type TeardownOutcome,
  teardownWithin,
} from "./teardown";

/** A session of an admitted package as the host core's calls take it, and its close. */
export interface ContractSession
  extends ConsoleSession,
    ObjectsSession,
    MaintenanceSession,
    MonitoringSession,
    HealthSession {
  /** Closes the session's handle; called once, under a cleanup context. */
  close(ctx: CallContext): Promise<void>;
}

/** What the package's manifest declares for the engine the session opens as. */
export interface DeclaredSession {
  readonly calls: Calls;
  readonly maintenance: EngineMaintenance;
  readonly panels: MonitoringPanels;
  /** The engine's object model, absent where its declaration states none. */
  readonly objectModel?: ObjectModel;
}

/** An open that answered a session, with what the package reported beside its handle. */
export interface OpenedRecord {
  readonly kind: "opened";
  readonly session: ContractSession;
  readonly serverVersion?: string;
  readonly engineUser?: string;
}

/** How an open ended: a session, refused before the call or of what it answered, or stopped. */
export type ContractOpenRecord = OpenedRecord | RefusedRecord | StoppedRecord;

/** The package's defect when its open answered no session handle. */
const NO_HANDLE = "The provider package's open answered no session handle, a defect of the package.";

/** How an own property of `target` reads: absent, a data value, or an accessor, which is never called. */
type OwnRead = { readonly kind: "absent" } | { readonly kind: "data"; readonly value: unknown } | { kind: "accessor" };

/** Reads `key` of `target` by its own descriptor, so a getter is never called. */
function readOwn(target: object, key: string): OwnRead {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) return { kind: "absent" };
  if ("value" in descriptor) return { kind: "data", value: descriptor.value };
  return { kind: "accessor" };
}

/** Whether `value` is a plain record: an object whose prototype is `Object.prototype` or null. */
function isPlainRecord(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The text an optional member of the answer reports, or undefined when the answer leaves it out.
 *
 * @throws {TypeError} For a member that is present and no own data text, naming it.
 */
function optionalText(answer: object, key: "serverVersion" | "engineUser"): string | undefined {
  const read = readOwn(answer, key);
  if (read.kind === "absent") return undefined;
  if (read.kind === "data" && typeof read.value === "string") return read.value;
  throw new TypeError(`The provider package's open answered a ${key} that is not text, a defect of the package.`);
}

/** The refinement the answer holds: its own data value, or a refusal of an accessor in its place. */
function refinementOf(answer: object): { readonly refine: unknown } | { readonly refusals: readonly CallRefusal[] } {
  const read = readOwn(answer, "refine");
  if (read.kind === "accessor") return { refusals: [{ rule: "refinement-unreadable", pointer: "" }] };
  return { refine: read.kind === "data" ? read.value : undefined };
}

/**
 * The refinement `answer` holds, read against `declared`: its refusals, by `checkRefinement` and then by
 * `sessionMaintenance`, or the refinement and the session's maintenance it narrows.
 */
function narrowed(
  declared: DeclaredSession,
  answer: object,
):
  | { readonly refusals: readonly CallRefusal[] }
  | { readonly refine: Refinement | undefined; readonly maintenance: EngineMaintenance } {
  const read = refinementOf(answer);
  if ("refusals" in read) return read;
  const refusals = checkRefinement(declared.calls, read.refine);
  if (refusals.length > 0) return { refusals };
  const refine = read.refine as Refinement | undefined;
  try {
    return { refine, maintenance: sessionMaintenance(declared.maintenance, refine) };
  } catch (error) {
    if (!(error instanceof CallRefusalError)) throw error;
    return { refusals: error.refusals };
  }
}

/**
 * The session over `handle` of `impl`, with `calls`, `maintenance` and `panels` as narrowed for it: each member present
 * exactly when `calls` offers it, each calling the package's function as a method of the object that holds it, and
 * `objectModel`, the declaration's, where the declaration states one and `calls` offers `objects.tree` or
 * `objects.source`.
 */
function bindSession(
  impl: ProviderImpl<unknown>,
  handle: unknown,
  calls: Calls,
  maintenance: EngineMaintenance,
  panels: MonitoringPanels,
  objectModel: ObjectModel | undefined,
  readOnlyStatements: boolean,
): ContractSession {
  const { console: consoleImpl, objects, maintenance: maintenanceImpl, monitoring } = impl;
  const offered = (refusals: readonly CallRefusal[]) => refusals.length === 0;
  return Object.freeze({
    calls,
    readOnlyStatements,
    maintenance,
    panels,
    execute: (request, ctx) => consoleImpl.execute(handle, request, ctx),
    ...(offered(checkConsoleFacet(calls, "cancel")) && {
      cancel: (request, ctx) => consoleImpl.cancel?.(handle, request, ctx),
    }),
    ...(offered(checkConsoleFacet(calls, "endScope")) && {
      endScope: (request, ctx) => consoleImpl.endScope?.(handle, request, ctx),
    }),
    ...(offered(checkConsoleFacet(calls, "transaction")) && {
      transaction: (request, ctx) => consoleImpl.transaction?.(handle, request, ctx),
    }),
    ...((offered(checkObjectsFacet(calls, "tree")) || offered(checkObjectsFacet(calls, "source"))) &&
      objectModel !== undefined && { objectModel }),
    ...(offered(checkObjectsFacet(calls, "tree")) && {
      tree: (request, ctx) => objects?.tree?.(handle, request, ctx),
    }),
    ...(offered(checkObjectsFacet(calls, "source")) && {
      source: (request, ctx) => objects?.source?.(handle, request, ctx),
    }),
    ...(offered(checkMaintenanceFacet(calls, "run")) && {
      run: (request, ctx) => maintenanceImpl?.run?.(handle, request, ctx),
    }),
    ...(offered(checkMaintenanceFacet(calls, "preview")) && {
      preview: (request, ctx) => maintenanceImpl?.preview?.(handle, request, ctx),
    }),
    ...(offered(checkMonitoringFacet(calls, "panel")) && {
      panel: (request, ctx) => monitoring?.panel?.(handle, request, ctx),
    }),
    ...(offered(checkMonitoringFacet(calls, "poolStats")) && {
      poolStats: (ctx) => monitoring?.poolStats?.(handle, ctx),
    }),
    health: (ctx) => impl.health(handle, ctx),
    close: (ctx) => impl.close(handle, ctx),
  } as ContractSession);
}

/** Studio's sentence for a close of a handle it did not admit that its cleanup deadline cut. */
const CLOSE_CUT = `The provider package's close of a session Studio did not admit did not answer within ${CLEANUP_DEADLINE_MS} ms.`;

/**
 * Closes `handle`, which Studio does not admit, once, under a cleanup context of its own (clause C-47), waited for at
 * most that context's deadline; answers once it settled or was cut, and never rejects. A close that fails reaches
 * `late` with its error by reference, and one the deadline cut with Studio's sentence.
 */
async function closeUnadmitted(
  impl: ProviderImpl<unknown>,
  handle: unknown,
  ctx: OpenContext,
  late: (error: unknown) => void,
): Promise<void> {
  const cleanup = freezeContext(cleanupContext(ctx.env));
  const settled = await settleWithin(
    startCall(() => impl.close(handle, cleanup)),
    CLEANUP_DEADLINE_MS,
  );
  if (settled.state === "failed") late(settled.error);
  else if (settled.state === "timed-out") late(new Error(CLOSE_CUT));
}

/** The late handler of an open: a handle answered after the stop is closed, a failure goes to `late`. */
function lateOpen(
  impl: ProviderImpl<unknown>,
  ctx: OpenContext,
  late: (error: unknown) => void,
): (outcome: LateOutcome<unknown>) => void {
  return (outcome) => {
    if (outcome.kind === "failed") {
      if (!stoppedBy(ctx, outcome.error)) late(outcome.error);
      return;
    }
    if (!isPlainRecord(outcome.value)) return;
    const read = readOwn(outcome.value, "handle");
    if (read.kind === "data") void closeUnadmitted(impl, read.value, ctx, late);
  };
}

/**
 * Opens a session of `impl` with `ctx` and answers how the open ended; see the module's docblock for its steps.
 * `declared` is what the manifest declares for `ctx.engine`, and `late` takes every failure the caller no longer waits
 * for: an open that failed after its stop, and a close of an abandoned or refused handle that failed or was cut.
 *
 * @throws The package's error by reference; a `TypeError` naming the package's defect for an answer the host cannot read.
 */
export async function openContractSession(
  impl: ProviderImpl<unknown>,
  ctx: OpenContext,
  declared: DeclaredSession,
  late: (error: unknown) => void,
): Promise<ContractOpenRecord> {
  const start = checkCallStart(ctx);
  if (start.length > 0) {
    return { kind: "refused", called: false, refusals: start, ...(ctx.signal.aborted && { cause: ctx.signal.reason }) };
  }
  freezeContext(ctx);
  const call = startCall(() => impl.open(ctx));
  let answer: unknown;
  try {
    answer = await awaitWithin(call, ctx.signal, lateOpen(impl, ctx, late));
  } catch (error) {
    if (!stoppedBy(ctx, error)) throw error;
    return { kind: "stopped", reason: error, settled: settledOf(call) };
  }
  const handleRead = isPlainRecord(answer) ? readOwn(answer, "handle") : ({ kind: "absent" } as const);
  if (handleRead.kind !== "data") throw new TypeError(NO_HANDLE);
  const handle = handleRead.value;
  const record = answer as object;
  let serverVersion: string | undefined;
  let engineUser: string | undefined;
  try {
    serverVersion = optionalText(record, "serverVersion");
    engineUser = optionalText(record, "engineUser");
  } catch (error) {
    await closeUnadmitted(impl, handle, ctx, late);
    throw error;
  }
  const narrowing = narrowed(declared, record);
  if ("refusals" in narrowing) {
    await closeUnadmitted(impl, handle, ctx, late);
    return { kind: "refused", called: true, refusals: narrowing.refusals };
  }
  const session = bindSession(
    impl,
    handle,
    sessionCalls(declared.calls, narrowing.refine),
    narrowing.maintenance,
    declared.panels,
    declared.objectModel,
    ctx.policy.readOnly && ctx.policy.sendsStatements,
  );
  return {
    kind: "opened",
    session,
    ...(serverVersion !== undefined && { serverVersion }),
    ...(engineUser !== undefined && { engineUser }),
  };
}

/**
 * Tears `session` down under `deadlines`, the teardown's own by default: no rollback, then its close under a cleanup
 * context with the package's environment `env`, waited for at most `deadlines.closeMs`. Answers how the close ended and
 * never rejects; the caller logs a close that failed or was cut.
 */
export function teardownContractSession(
  session: Pick<ContractSession, "close">,
  env: EnvReader,
  deadlines: TeardownDeadlines = { rollbackMs: TEARDOWN_ROLLBACK_MS, closeMs: TEARDOWN_CLOSE_MS },
): Promise<TeardownOutcome> {
  return teardownWithin({ close: () => session.close(cleanupContext(env)) }, deadlines);
}
