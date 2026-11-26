/**
 * The sessions of the engines admitted provider packages serve (docs/providers/CONTRACT.md, clause C-109):
 * opened through the one open function (`openEngine` in src/lib/provider-host/open-engine.ts), which opens a package's
 * record through the package's own `open`, never through a legacy provider class, and kept in a cache of their own.
 *
 * The provider factory's entry points (./factory) answer a `DatabaseProvider`, which a contract session is not, so each
 * refuses an engine whose record offers no legacy provider by name (`assertLegacyProvider` in ./server-catalog) and
 * imports no legacy module for it.
 * This module is the package path beside them: `getOrCreatePackageSession`, the editor's session, cached, and
 * `openPackageSessionOnce`, Test Connection's, never cached. A caller that serves a package's engine resolves its
 * connection with `resolveConnection` (src/lib/seed/resolve-connection.ts), `engines` `bundled-and-package`, and calls
 * one of them.
 *
 * Before anything is read from the host, keyed or opened, the one ordered open check (`assertOpenable` in
 * ./open-check), the check a legacy engine's build runs too, refuses what core cannot hand the package, each as a
 * not-sent `DatabaseConfigError`, reading only the engine's record: a package's record offers no SSH tunnel and no
 * host file, so a tunnel that is on and a host path field its grants name are refused there. `openEngine` runs it again
 * on the context it opens with, which keeps the caller's file-access posture as given, so both read the same.
 *
 * The cache keys a session by the package's name and the frame `frameCacheKey` (./provider-cache-key) computes from the
 * connection, the engine's posture grant, the posture and the owner, which is kept unless the engine's grant keeps one
 * handle per file. Opens run through one open table (`openOnce` in src/lib/provider-host/core/open-once.ts), so two
 * concurrent first opens of one key share one open (clause C-44), a caller's own wait ends only its wait, and an open no
 * caller waits for admits itself once; its deadline is the engine's connect budget from the open's start (clause
 * C-55). An open a removal or a cache close overtook closes the session it opened and answers a not-sent
 * `ConnectionError`, admitting nothing. Every open failure is marked not-sent (`connectPhase`).
 *
 * A session leaves the cache when it goes idle (its own sweep, on the factory's numbers, ./idle-sweep), when a removal
 * names its connection, its owner or its key (`removePackageSessions`, which `removeProvider` calls), and when the
 * caches close (`closePackageSessions`, which `clearProviderCache` and the shutdown reach through the factory). Each
 * goes through `teardownWithin` under the teardown's deadlines (clause C-45), with no rollback step, since no caller
 * opens a transaction on a package's session: a close that never settles is cut at the close deadline, logged by its
 * connection, kind and code, and named as not closed by its connection and its package.
 *
 * Module state of this copy, as the factory's caches are: each Next.js bundle that loads it keeps its own sessions.
 */
import { cleanupContext, deadlineSignal, type EnvReader } from "@libredb/provider-sdk/calls";
import { logger } from "@/lib/logger";
import type { ContractSession } from "@/lib/provider-host/core/contract-session";
import {
  createOpenFlights,
  discardFlights,
  type Flight,
  type OpenWait,
  openOnce,
} from "@/lib/provider-host/core/open-once";
import {
  TEARDOWN_CLOSE_MS,
  TEARDOWN_ROLLBACK_MS,
  type TeardownDeadlines,
  type TeardownOutcome,
  teardownWithin,
} from "@/lib/provider-host/core/teardown";
import { packageConnectBudget } from "@/lib/provider-host/open-context";
import { type OpenedPackageSession, openedSession, openEngine } from "@/lib/provider-host/open-engine";
import { openDeadlineSentence } from "./connect-budget";
import { errorCode, errorKind } from "./error-record";
import { ConnectionError, connectPhase, DatabaseConfigError, markNotSent, StudioTimeoutRefusal } from "./errors";
import { IDLE_TIMEOUT_MS, SWEEP_INTERVAL_MS } from "./idle-sweep";
import { frameCacheKey } from "./provider-cache-key";
import { assertOpenable } from "./open-check";
import { type EngineConnection, type EngineRecord, servedPackage } from "./server-catalog";
import type { EditorExecutionContext } from "./types";

/** A package's session the cache holds, with what its removal, sweep and calls read. */
export interface CachedPackageSession {
  readonly session: ContractSession;
  readonly connectionId: string;
  /** The owner the key frames (docs/GOVERNANCE.md#per-user-providers), or undefined for a session every caller shares. */
  readonly owner?: string;
  /** The frame of the key, `frameCacheKey`'s answer, which a key-scoped removal names. */
  readonly frame: string;
  readonly engine: EngineRecord;
  /** The package's declared environment, which every call of the session is given. */
  readonly env: EnvReader;
  lastUsed: number;
  /** How many calls run on the session now; the idle sweep keeps a session with one running. */
  running: number;
}

/** What an open in flight records about itself. */
interface OpenMeta {
  readonly connectionId: string;
  readonly owner?: string;
  readonly frame: string;
  readonly budget: number;
}

/** The deadlines every teardown of a package's session runs under, the host core's. */
const TEARDOWN_DEADLINES: TeardownDeadlines = Object.freeze({
  rollbackMs: TEARDOWN_ROLLBACK_MS,
  closeMs: TEARDOWN_CLOSE_MS,
});

/** What a caller whose open a removal or a cache close overtook is answered, the factory's sentence. */
const OVERTAKEN_OPEN =
  "The connection was closed while it was opening: a disconnect, a removal, a change of access or a shutdown closed it before it was ready, so nothing was sent to the database. Try again.";

/** Strips the control characters a log line's framing is made of from a caller-supplied value. */
const sanitize = (value: string) => value.replace(/[\r\n]/g, " ").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

/** A not-sent configuration error with `sentence`: nothing was opened. */
function refused(sentence: string): DatabaseConfigError {
  const error = new DatabaseConfigError(sentence);
  markNotSent(error);
  return error;
}

/** Logs a failure of `connectionId`'s session that no caller waits for, by its kind and code, never its text. */
function logLate(connectionId: string, line: string): (error: unknown) => void {
  return (error) => {
    logger.warn(line, { connectionId, kind: errorKind(error), code: errorCode(error) });
  };
}

/**
 * Tears `session` down under `deadlines`: no rollback, then its close under a cleanup context with the package's
 * environment, waited for at most `deadlines.closeMs`. Never rejects. Exported for the bounded child that proves the
 * cut with short deadlines.
 */
export function teardownPackageSession(
  session: Pick<ContractSession, "close">,
  env: EnvReader,
  deadlines: TeardownDeadlines = TEARDOWN_DEADLINES,
): Promise<TeardownOutcome> {
  return teardownWithin({ close: () => session.close(cleanupContext(env)) }, deadlines);
}

/** The name a not-closed list gives a package's session: its connection, and its package as its author. */
function sessionName(connectionId: string, engine: EngineRecord): string {
  const served = servedPackage(engine);
  return `${sanitize(connectionId)} (${served.name} ${served.version})`;
}

/**
 * Tears `entry` down and answers whether it closed: its close cut at the deadline or failed is logged by its
 * connection, kind and code, never its text.
 */
async function closeEntry(entry: Pick<CachedPackageSession, "session" | "env" | "connectionId">): Promise<boolean> {
  const outcome = await teardownPackageSession(entry.session, entry.env);
  if (outcome.close === "done") return true;
  const id = entry.connectionId;
  logger.warn(
    outcome.close === "timed-out"
      ? `[DB] A provider package's session of ${sanitize(id)} did not close within ${TEARDOWN_CLOSE_MS} ms, so it is given up.`
      : `[DB] A provider package's session of ${sanitize(id)} failed to close.`,
    {
      connectionId: id,
      ...(outcome.close === "failed" && { kind: errorKind(outcome.closeError), code: errorCode(outcome.closeError) }),
    },
  );
  return false;
}

const sessions = new Map<string, CachedPackageSession>();

/** Logs an open that failed after every caller stopped waiting for it, by its connection, kind and code. */
function logUnclaimed(error: unknown, flight: Flight<OpenMeta>): void {
  const id = flight.meta.connectionId;
  logLate(
    id,
    `[DB] An open of ${sanitize(id)} failed after every caller stopped waiting for it, so nothing was admitted.`,
  )(error);
}

/** The opens in flight of the package session cache, each ended at its engine's connect budget. */
const flights = createOpenFlights<CachedPackageSession, OpenMeta>(logUnclaimed, {
  signal: (meta) => deadlineSignal(Date.now() + meta.budget),
  expired: (flight) => {
    const error = new StudioTimeoutRefusal(openDeadlineSentence(flight.meta.budget));
    markNotSent(error);
    return error;
  },
});

/** How many closes of the cache are running: an open that settles meanwhile is overtaken. */
let closesRunning = 0;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Starts the idle sweep, unless it runs; it keeps no process alive. */
function startSweep(): void {
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(() => {
    void evictIdlePackageSessions();
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

/** Stops the idle sweep once the cache is empty. */
function stopSweepWhenEmpty(): void {
  if (sessions.size > 0 || sweepTimer === null) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}

/**
 * Tears down every session unused for at least `maxIdleMs` at `now` with no call running on it, and answers how many it
 * tore down. Called by the sweep; exported for the tests.
 */
export async function evictIdlePackageSessions(maxIdleMs: number = IDLE_TIMEOUT_MS, now: number = Date.now()) {
  const idle = [...sessions].filter(([, entry]) => entry.running === 0 && now - entry.lastUsed >= maxIdleMs);
  for (const [key] of idle) sessions.delete(key);
  await Promise.all(idle.map(([, entry]) => closeEntry(entry)));
  stopSweepWhenEmpty();
  return idle.length;
}

/**
 * The open `getOrCreatePackageSession` shares under `flight.key`: it opens the session and admits it, unless a removal
 * or a cache close overtook it, in which case it closes what it opened and fails as overtaken, admitting nothing.
 */
async function openCached(
  connection: EngineConnection,
  engine: EngineRecord,
  execution: EditorExecutionContext,
  flight: Flight<OpenMeta>,
): Promise<CachedPackageSession> {
  let opened: OpenedPackageSession | undefined;
  await connectPhase(async () => {
    try {
      opened = openedSession(
        await openEngine(engine, {
          connection,
          execution,
          purpose: "connect",
          options: {},
          within: { deadline: Date.now() + flight.meta.budget, signal: flight.signal },
        }),
      );
    } catch (error) {
      if (flight.signal.aborted && error === flight.signal.reason) {
        throw new ConnectionError(OVERTAKEN_OPEN);
      }
      throw error;
    }
    if (!flight.signal.aborted && closesRunning === 0) return;
    await closeEntry({ ...(opened as OpenedPackageSession), connectionId: connection.id });
    throw new ConnectionError(OVERTAKEN_OPEN);
  });
  const { session, env } = opened as OpenedPackageSession;
  const entry: CachedPackageSession = {
    session,
    env,
    connectionId: connection.id,
    ...(flight.meta.owner !== undefined && { owner: flight.meta.owner }),
    frame: flight.meta.frame,
    engine,
    lastUsed: Date.now(),
    running: 0,
  };
  sessions.set(flight.key, entry);
  startSweep();
  return entry;
}

/**
 * The editor's session of `engine` for `connection`: checked (`assertOpenable` in ./open-check), keyed, the cached one
 * when the cache holds it, else the open in flight under its key or a new one (clause C-44). With `wait`, the caller
 * stops waiting when `wait.signal` aborts, with its reason, and the open goes on and admits itself.
 *
 * @throws {DatabaseConfigError} Not-sent, for a connection with no id or one a check refuses.
 * @throws {StudioTimeoutRefusal} Not-sent, when the engine's connect budget ended the open.
 * @throws {ConnectionError} Not-sent, when a removal or a cache close overtook the open.
 * @throws The package's error by reference, marked not-sent.
 */
export async function getOrCreatePackageSession(
  connection: EngineConnection,
  engine: EngineRecord,
  execution: EditorExecutionContext,
  wait?: OpenWait,
): Promise<CachedPackageSession> {
  if (!connection.id) throw refused("Connection ID is required");
  assertOpenable(engine, connection, execution, "connect");
  const owner = engine.grants.singleWriterFile ? undefined : execution.owner;
  const allowExternalFileAccess = execution.allowExternalFileAccess === true;
  const frame = await frameCacheKey(connection, {
    readsPosture: engine.grants.readsFileAccessPosture,
    allowExternalFileAccess,
    owner,
  });
  const key = `package\u0000${servedPackage(engine).name}\u0000${frame}`;
  const cached = sessions.get(key);
  if (cached !== undefined) {
    cached.lastUsed = Date.now();
    return cached;
  }
  const meta: OpenMeta = {
    connectionId: connection.id,
    owner,
    frame,
    budget: packageConnectBudget(engine),
  };
  // The open is handed the posture as the caller gave it, so the open check `openEngine` runs reads what the check
  // above read; `packageOpenContext` hands the package the definite boolean. The derived boolean frames the key alone.
  const opened: EditorExecutionContext = {
    ...(execution.allowExternalFileAccess !== undefined && {
      allowExternalFileAccess: execution.allowExternalFileAccess,
    }),
    ...(owner !== undefined && { owner, ownerPoolMax: execution.ownerPoolMax }),
  };
  return openOnce(flights, key, meta, (flight) => openCached(connection, engine, opened, flight), wait);
}

/**
 * Opens a session of `engine` for `connection` once, never cached, for Test Connection: the open's deadline `deadline`
 * and its signal `signal` are the test's own. The caller runs `assertOpenable` (./open-check) first, before its budget
 * starts, and `openEngine` runs it again before the package's `open`. A stop answers the signal's reason, and a
 * session answered after it is closed by the host core.
 *
 * @throws The package's error by reference, marked not-sent.
 */
export async function openPackageSessionOnce(
  connection: EngineConnection,
  engine: EngineRecord,
  execution: EditorExecutionContext,
  deadline: number,
  signal: AbortSignal,
): Promise<OpenedPackageSession> {
  let opened: OpenedPackageSession | undefined;
  await connectPhase(async () => {
    opened = openedSession(
      await openEngine(engine, {
        connection,
        execution,
        purpose: "connect",
        options: {},
        within: { deadline, signal },
      }),
    );
  });
  return opened as OpenedPackageSession;
}

/** A removal's scope: the owner whose sessions it removes, or the frame of the record's key. */
export type PackageRemovalScope =
  | { readonly owner: string; readonly key?: never }
  | { readonly key: string; readonly owner?: never };

/**
 * Removes the sessions of `connectionId` the scope names, as `removeProvider` (./factory) removes its entries: every
 * one without a scope, an owner's own with `{ owner }`, and the record's with `{ key }`, the key `editorCacheKey`
 * answers, which a package's session frames the same way. An open in flight the scope names is overtaken first. The
 * caller checked the scope's form.
 */
export async function removePackageSessions(connectionId: string, scope?: PackageRemovalScope): Promise<void> {
  const removes = (entry: { connectionId: string; owner?: string; frame: string }): boolean =>
    entry.connectionId === connectionId &&
    (scope === undefined || (scope.key !== undefined ? entry.frame === scope.key : entry.owner === scope.owner));
  discardFlights(flights, (flight) => removes(flight.meta), "removeProvider");
  const removed = [...sessions].filter(([, entry]) => removes(entry));
  for (const [key] of removed) sessions.delete(key);
  await Promise.all(removed.map(([, entry]) => closeEntry(entry)));
  stopSweepWhenEmpty();
}

/**
 * Closes every package's session and every open in flight, all at once, and answers the names of the sessions that did
 * not close completely: a close that failed or was cut. An open in flight is overtaken: its wait on the package's open
 * ends at once with the discard (its context's signal is the flight's), and a session the package answers later is
 * closed by the host core, so the close waits for each such flight to settle, which it does at once. An open that
 * settles while the close runs is overtaken too and admits nothing.
 */
export async function closePackageSessions(): Promise<string[]> {
  closesRunning += 1;
  try {
    if (sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    const opens = discardFlights(flights, () => true, "closeCaches").map(async ({ settled }) => {
      await settled;
      return null;
    });
    const entries = [...sessions];
    sessions.clear();
    const closes = entries.map(async ([, entry]) =>
      (await closeEntry(entry)) ? null : sessionName(entry.connectionId, entry.engine),
    );
    return (await Promise.all([...opens, ...closes])).filter((name): name is string => name !== null);
  } finally {
    closesRunning -= 1;
  }
}

/** The package sessions the cache holds: how many, and their connections' ids. */
export function packageSessionStats(): { size: number; connections: string[] } {
  return { size: sessions.size, connections: [...sessions.values()].map((entry) => entry.connectionId) };
}
