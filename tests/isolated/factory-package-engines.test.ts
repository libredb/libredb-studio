/**
 * The provider factory's entry points with a server catalog installed (src/lib/db/server-catalog.ts): an engine whose
 * provider package was refused at boot answers `PROVIDER_UNAVAILABLE` naming the refusal code, and an admitted
 * package's engine is refused at each entry point that answers a legacy provider, as the first statement of the entry
 * point, before any cache, tunnel or build (docs/providers/CONTRACT.md, clause C-107).
 *
 * Each connection of those cases carries no id and an SSH tunnel that is on, so a check that ran after the type check
 * would answer another refusal (the id's, the tunnel's), and the callback a tunnel scope runs records its call.
 *
 * An admitted package's session lives in the factory's editor cache beside every legacy provider: cached under its
 * frame and its package's name, swept, removed, closed and counted as every entry is, its teardown read from the
 * entry's form. The package here is an in-memory record whose functions call the hooks a case sets, and the legacy
 * engine beside it is SQLite on an anonymous in-memory database. The cut of a close that never settles is read under
 * fake timers, advanced past the close deadline before the case awaits the close; no case awaits a timer.
 */
// oxlint-disable no-await-in-loop -- each entry point runs after the one before, so the cache is read after each.
import { afterAll, beforeAll, describe, expect, jest, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CLEANUP_DEADLINE_MS, type ProviderImpl } from "@libredb/provider-sdk/calls";
import { DatabaseConfigError, PackageEngineUnsupportedError, ProviderUnavailableError } from "@/lib/db/errors";
import {
  acquireExecutionProfileProvider,
  clearProviderCache,
  createDatabaseProvider,
  editorCacheKey,
  findCachedProvider,
  getExecutionProfileCacheStats,
  getOrCreateEditorSession,
  getOrCreateMetadataProvider,
  getOrCreateProvider,
  getProviderCacheStats,
  openEngineOnce,
  readProviderDeclarations,
  removeProvider,
  withOneShotTunnel,
} from "@/lib/db/factory";
import { frameCacheKey } from "@/lib/db/provider-cache-key";
import {
  type EngineConnection,
  type EngineRecord,
  forgetServerCatalog,
  installServerCatalog,
  serverEngine,
} from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { logger } from "@/lib/logger";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { TEARDOWN_CLOSE_MS } from "@/lib/provider-host/core/teardown";
import { installHostCore } from "@/lib/provider-host/instance";
import { openedProvider, openedSession } from "@/lib/provider-host/open-engine";
import { closeProviderCaches, resetShutdownHooks } from "@/lib/shutdown";
import type { DatabaseConnection } from "@/lib/types";
import { admittedFor, admittedManifest } from "../helpers/package-catalog";

/** The hooks the cached package's functions call, set per case. */
let hooks: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
/** The names of the package calls a case saw, in order. */
const seen: string[] = [];

/** An implementation whose every function records its name and calls the case's hook. */
function hookImpl(): ProviderImpl<unknown> {
  const call =
    (name: string) =>
    (...args: unknown[]) => {
      seen.push(name);
      return (hooks[name] ?? (() => Promise.resolve(undefined)))(...args);
    };
  return {
    open: call("open"),
    close: call("close"),
    health: call("health"),
    console: { execute: call("execute") },
    monitoring: { panel: call("panel") },
  } as unknown as ProviderImpl<unknown>;
}

/** Hooks of a package that opens a fresh handle and closes it, or never closes it with `closes` false. */
function packageHooks(closes = true): typeof hooks {
  return {
    open: () => Promise.resolve({ handle: { session: randomUUID() } }),
    close: () => (closes ? Promise.resolve() : new Promise<void>(() => undefined)),
  };
}

beforeAll(() => {
  installHostCore(createHostCore(), "test");
  const cached = admittedFor("acme-cached", admittedManifest("acmecached"));
  installServerCatalog(
    composeServerCatalog(
      [
        admittedFor("acme-factory", admittedManifest("acmefactory")),
        { ...cached, record: { ...cached.record, impl: hookImpl() } },
      ],
      [{ name: "acme-factory-gone", version: "1.0.0", engines: ["acmefactorygone"], code: "PROVIDER_LOAD_FAILED" }],
    ),
  );
});
afterAll(async () => {
  await clearProviderCache();
  forgetServerCatalog();
});

/** A connection of `type` with no id and a tunnel that is on. */
function connectionOf(type: string): DatabaseConnection {
  return {
    name: "c",
    type,
    host: "db.local",
    port: 7000,
    sshTunnel: { enabled: true, host: "bastion.local", port: 22, username: "u", authMethod: "password" },
  } as unknown as DatabaseConnection;
}

/** What each entry point answers for `type`, and whether a tunnel scope ran its callback. */
async function refusals(type: string): Promise<{ errors: unknown[]; ran: number }> {
  const connection = connectionOf(type);
  let ran = 0;
  const entries: (() => Promise<unknown>)[] = [
    () => createDatabaseProvider(connection),
    () => readProviderDeclarations(connection),
    () =>
      withOneShotTunnel(connection, async () => {
        ran += 1;
      }),
    () => getOrCreateProvider(connection),
    () => getOrCreateMetadataProvider(connection),
    () => acquireExecutionProfileProvider(connection, "agent-read-only"),
  ];
  const errors: unknown[] = [];
  for (const entry of entries) errors.push(await entry().catch((error: unknown) => error));
  return { errors, ran };
}

describe("the factory and a provider package's engine", () => {
  test("an engine whose package was refused answers PROVIDER_UNAVAILABLE naming the refusal at each factory entry point, before any cache, tunnel or build", async () => {
    const { errors, ran } = await refusals("acmefactorygone");
    expect(errors.length).toBe(6);
    for (const error of errors) {
      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect((error as ProviderUnavailableError).codes).toEqual(["PROVIDER_LOAD_FAILED"]);
    }
    expect(ran).toBe(0);
    expect(getProviderCacheStats().size).toBe(0);
    expect(getExecutionProfileCacheStats().size).toBe(0);
  });

  test("an admitted package's engine is refused at each factory entry point that answers a legacy provider, its session opening through the factory's editor session", async () => {
    const { errors, ran } = await refusals("acmefactory");
    for (const error of errors) {
      expect(error).toBeInstanceOf(PackageEngineUnsupportedError);
      expect(error).not.toBeInstanceOf(DatabaseConfigError);
      expect((error as Error).message).toBe(
        "LibreDB Studio's provider factory builds no provider for an engine of a provider package; that engine's session opens through its package, and this caller does not serve one.",
      );
    }
    expect(ran).toBe(0);
    expect(getProviderCacheStats().size).toBe(0);
  });
});

/** An admin's execution context: full file access, no owner. */
const ADMIN = Object.freeze({ allowExternalFileAccess: true });

/** The served record of engine `id`. */
function engineOf(id: string): EngineRecord {
  const served = serverEngine(id);
  if (served.kind !== "served") throw new Error(`the catalog serves no ${id}`);
  return served.engine;
}

/** A connection of the cached package's engine with a fresh id. */
function packageConnection(): EngineConnection {
  return { id: `conn-${randomUUID()}`, name: "P", type: "acmecached", host: "db.local" } as unknown as EngineConnection;
}

/** A connection of SQLite on an anonymous in-memory database with a fresh id. */
function sqliteConnection(): DatabaseConnection {
  return { id: `sqlite-${randomUUID()}`, name: "S", type: "sqlite", database: ":memory:" } as DatabaseConnection;
}

/** The warnings `warn` saw, as their lines and payloads. */
function warnings(warn: { mock: { calls: unknown[][] } }): unknown[][] {
  return warn.mock.calls.map((call) => call.slice(0, 2));
}

/** The line a package session's close cut at the close deadline is logged with. */
function cutLine(connectionId: string): string {
  return `[DB] A provider package's session of ${connectionId} did not close within ${TEARDOWN_CLOSE_MS} ms, so it is given up.`;
}

describe("the factory's editor cache and a provider package's engine", () => {
  test("a package engine's session is cached in the factory's editor cache under its frame and its package's identity, beside a legacy engine's provider", async () => {
    await clearProviderCache();
    hooks = packageHooks();
    const connection = packageConnection();
    const engine = engineOf("acmecached");
    const entry = await getOrCreateEditorSession(connection, engine, ADMIN);
    const sqlite = sqliteConnection();
    const provider = await getOrCreateProvider(sqlite, {}, ADMIN);

    expect(getProviderCacheStats().size).toBe(2);
    expect(getProviderCacheStats().connections.toSorted()).toEqual([connection.id, sqlite.id].toSorted());
    const frame = await frameCacheKey(connection, {
      readsPosture: engine.grants.readsFileAccessPosture,
      allowExternalFileAccess: true,
      owner: undefined,
    });
    expect(entry.frame).toBe(frame);
    expect([entry.connectionId, entry.engine, entry.running]).toEqual([connection.id, engine, 0]);
    expect(openedSession(entry.opened).session.calls.console.execute).toBeDefined();
    // The package's key reads a legacy provider of a session's entry: a host defect, raised by name.
    expect(() => findCachedProvider(`package\u0000acme-cached\u0000${frame}`)).toThrow(
      "The factory's cache holds a provider package's session under this key, and this caller reads a legacy provider of it: a host defect.",
    );
    // The legacy key is the editor key, byte for byte.
    expect(findCachedProvider(await editorCacheKey(sqlite, ADMIN))).toBe(provider);
    // A second call reads the cache: no second open.
    expect(await getOrCreateEditorSession(connection, engine, ADMIN)).toBe(entry);
    expect(seen.filter((name) => name === "open")).toHaveLength(1);
    await clearProviderCache();
  });

  test("the editor session of a legacy record is the provider getOrCreateProvider answers, in one entry", async () => {
    await clearProviderCache();
    const sqlite = sqliteConnection();
    const entry = await getOrCreateEditorSession(sqlite, engineOf("sqlite"), ADMIN);
    expect(openedProvider(entry.opened)).toBe(await getOrCreateProvider(sqlite, {}, ADMIN));
    expect(entry.frame).toBe(await editorCacheKey(sqlite, ADMIN));
    expect(getProviderCacheStats()).toEqual({ size: 1, connections: [sqlite.id] });
    await clearProviderCache();
  });

  test("openEngineOnce answers a legacy record's provider built and not connected, and a package's connected session, never cached", async () => {
    await clearProviderCache();
    const within = () => ({ deadline: Date.now() + 1_000, signal: new AbortController().signal });
    const legacy = openedProvider(await openEngineOnce(sqliteConnection(), engineOf("sqlite"), ADMIN, within()));
    expect(legacy.isConnected()).toBe(false);

    hooks = packageHooks();
    seen.length = 0;
    const { session } = openedSession(
      await openEngineOnce(packageConnection(), engineOf("acmecached"), ADMIN, within()),
    );
    expect(typeof session.health).toBe("function");
    expect(seen).toEqual(["open"]);
    expect(getProviderCacheStats().size).toBe(0);
  });

  test("removeProvider by connection, by owner and by key closes a package engine's cached session with today's teardown deadlines", async () => {
    await clearProviderCache();
    const engine = engineOf("acmecached");
    const owned = (connection: EngineConnection, owner: string) =>
      getOrCreateEditorSession(connection, engine, { ...ADMIN, owner, ownerPoolMax: 2 });
    const scopes: [string, (connection: EngineConnection) => Promise<() => Promise<void>>][] = [
      [
        "connection",
        async (connection) => {
          await getOrCreateEditorSession(connection, engine, ADMIN);
          return () => removeProvider(connection.id);
        },
      ],
      [
        "owner",
        async (connection) => {
          await owned(connection, "bob");
          await owned(connection, "alice");
          return () => removeProvider(connection.id, { owner: "alice" });
        },
      ],
      [
        "key",
        async (connection) => {
          const entry = await getOrCreateEditorSession(connection, engine, ADMIN);
          return () => removeProvider(connection.id, { key: entry.frame });
        },
      ],
    ];
    for (const [scope, open] of scopes) {
      // Every close never settles, read when the close is called, so each removal is cut at the close deadline.
      hooks = packageHooks(false);
      const connection = packageConnection();
      const remove = await open(connection);
      seen.length = 0;
      const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
      jest.useFakeTimers();
      try {
        const removal = remove();
        expect(seen).toEqual(["close"]);
        jest.advanceTimersByTime(CLEANUP_DEADLINE_MS);
        await removal;
        expect(warnings(warn)).toEqual([[cutLine(connection.id), { connectionId: connection.id }]]);
      } finally {
        jest.useRealTimers();
        warn.mockRestore();
      }
      // The owner scope leaves the other owner's session; every other scope leaves nothing of the connection.
      expect(getProviderCacheStats().connections).toEqual(scope === "owner" ? [connection.id] : []);
      hooks = packageHooks();
      await clearProviderCache();
    }
  });

  test("clearProviderCache closes package sessions and names a close that never settles as not closed, by connection and package", async () => {
    await clearProviderCache();
    hooks = packageHooks(false);
    const cleared = packageConnection();
    await getOrCreateEditorSession(cleared, engineOf("acmecached"), ADMIN);
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    jest.useFakeTimers();
    try {
      const clearing = clearProviderCache();
      jest.advanceTimersByTime(CLEANUP_DEADLINE_MS);
      await clearing;
      expect(warnings(warn)).toEqual([[cutLine(cleared.id), { connectionId: cleared.id }]]);
    } finally {
      jest.useRealTimers();
      warn.mockRestore();
    }
    expect(getProviderCacheStats().size).toBe(0);

    const named = packageConnection();
    await getOrCreateEditorSession(named, engineOf("acmecached"), ADMIN);
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    const quiet = spyOn(logger, "warn").mockImplementation(() => undefined);
    resetShutdownHooks();
    jest.useFakeTimers();
    try {
      const closing = closeProviderCaches();
      jest.advanceTimersByTime(CLEANUP_DEADLINE_MS);
      expect(await closing).toEqual({ cut: 0, failed: 1 });
      expect(error).toHaveBeenCalledWith(
        "Provider cache close failed",
        expect.objectContaining({ message: `Providers not closed: ${named.id} (acme-cached 1.0.0)` }),
        { route: "shutdown" },
      );
    } finally {
      jest.useRealTimers();
      resetShutdownHooks();
      error.mockRestore();
      quiet.mockRestore();
    }
    expect(getProviderCacheStats().size).toBe(0);
  });

  test("getProviderCacheStats counts a package engine's session", async () => {
    await clearProviderCache();
    hooks = packageHooks();
    const connection = packageConnection();
    await getOrCreateEditorSession(connection, engineOf("acmecached"), ADMIN);
    expect(getProviderCacheStats()).toEqual({ size: 1, connections: [connection.id] });
    await clearProviderCache();
  });
});
