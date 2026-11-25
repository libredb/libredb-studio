/**
 * The sessions of an admitted provider package's engine (src/lib/db/package-sessions.ts; docs/providers/CONTRACT.md,
 * clauses C-109 to C-111): opened through the package's own `open` with the context core builds, never through a
 * legacy provider class, once per key, torn down under the teardown's deadlines, and refused before the open by every
 * check core holds for what it cannot hand a package.
 *
 * Fixture packages are written into a scratch providers directory and admitted by Studio's boot admission
 * (tests/helpers/package-session-fixture.ts); each function of a package calls the hook the case sets. Every module the
 * factory's switch imports a legacy provider from is replaced by a module that records its import, so a case reads
 * whether the legacy path was reached. Nothing awaits a timer: every wait settles on a promise a case resolves, the
 * deadline cases run on a record whose budget is 50 ms, and the cut of a close is read under fake timers here and in a
 * bounded child. The child prints JSON lines, read after `trimEnd()` (CRLF on Windows); no file mode or link is used.
 */
// oxlint-disable no-await-in-loop -- each check runs after the one before, so its hooks read one open at a time.
import { afterAll, beforeAll, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type CallContext,
  CLEANUP_DEADLINE_MS,
  DEFAULT_CONNECT_BUDGET_MS,
  type OpenContext,
} from "@libredb/provider-sdk/calls";
import { boundedChild } from "../helpers/bounded-node-child";
import { admitSessionPackages, setHooks } from "../helpers/package-session-fixture";
import { removeScratch, scratchDirectory } from "../helpers/provider-artifacts";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..", "..");
const FACTORY_SOURCE = readFileSync(path.join(REPOSITORY_ROOT, "src", "lib", "db", "factory.ts"), "utf8");

/** Every module the factory's switch imports a legacy provider from, as the factory names it. */
const LEGACY_MODULES = [...FACTORY_SOURCE.matchAll(/await import\("(\.\/providers\/[^"]+)"\)/g)].map(
  (match) => match[1] as string,
);
const imported: string[] = [];
for (const specifier of LEGACY_MODULES) {
  mock.module(`@/lib/db/${specifier.slice(2)}`, () => {
    imported.push(specifier);
    return {};
  });
}

const factory = await import("@/lib/db/factory");
const sessions = await import("@/lib/db/package-sessions");
const {
  DatabaseConfigError,
  ConnectionError,
  FacetNotOfferedError,
  PackageEngineUnsupportedError,
  StudioTimeoutRefusal,
} = await import("@/lib/db/errors");
const { errorKind, errorOutcome } = await import("@/lib/db/error-record");
const { openDeadlineSentence } = await import("@/lib/db/connect-budget");
const { createHostCore } = await import("@/lib/provider-host/core/host-core");
const { refusalError } = await import("@/lib/provider-host/access");
const { logger } = await import("@/lib/logger");
type PackageEngine = import("@/lib/db/server-catalog").PackageEngine;
type PackageConnection = import("@/lib/db/server-catalog").PackageConnection;

const MAIN = "acmepsmain";
const BARE = "acmepsbare";
const providers = scratchDirectory("studio-package-sessions-");
let engines: Map<string, PackageEngine>;

beforeAll(async () => {
  engines = await admitSessionPackages(providers, [
    { name: "acme-ps-main", engine: MAIN, offered: ["console.cancel"] },
    { name: "acme-ps-bare", engine: BARE },
  ]);
});
afterAll(async () => {
  await factory.clearProviderCache();
  removeScratch(providers);
});

/** The engine `id` as the catalog holds it. */
function engineOf(id: string): PackageEngine {
  return engines.get(id) as PackageEngine;
}

/** A connection of `id`'s engine with a generated secret and `fields`. */
function connectionOf(id: string, fields: Record<string, unknown> = {}): PackageConnection {
  return {
    id: `conn-${randomUUID()}`,
    name: "PS",
    type: id,
    host: "db.local",
    password: randomUUID(),
    ...fields,
  } as unknown as PackageConnection;
}

/** An admin's execution context: full file access, no owner. */
const ADMIN = Object.freeze({ allowExternalFileAccess: true });

/** What the hooks of one case recorded. */
interface Recorder {
  readonly calls: { name: string; args: unknown[] }[];
  /** Resolves once the package's open was called. */
  readonly opened: Promise<void>;
  /** Resolves the open the case holds, when it holds one. */
  answer: (value: unknown) => void;
  fail: (error: unknown) => void;
}

/** Hooks for `id` that record every call: `open` answers a fresh handle, or waits for the case when `hold` is set. */
function record(id: string, options: { hold?: boolean; close?: () => Promise<void> } = {}): Recorder {
  let opened!: () => void;
  const recorder: Recorder = {
    calls: [],
    opened: new Promise<void>((resolve) => {
      opened = resolve;
    }),
    answer: () => undefined,
    fail: () => undefined,
  };
  const push =
    (name: string) =>
    (...args: unknown[]) => {
      recorder.calls.push({ name, args });
      return undefined;
    };
  setHooks(id, {
    open: (...args) => {
      push("open")(...args);
      opened();
      if (options.hold !== true) return Promise.resolve({ handle: { session: randomUUID() } });
      return new Promise((resolve, reject) => {
        recorder.answer = resolve;
        recorder.fail = reject;
      });
    },
    close: (...args) => {
      push("close")(...args);
      return options.close?.() ?? Promise.resolve();
    },
    health: (...args) => {
      push("health")(...args);
      return Promise.resolve({ databaseSize: "1", cacheHitRatio: "1", slowQueries: [], activeSessions: [] });
    },
    execute: (...args) => {
      push("execute")(...args);
      return Promise.resolve({ results: [], warnings: [], executionTimeMs: 0, pageApplied: false });
    },
    cancel: (...args) => {
      push("cancel")(...args);
      return Promise.resolve({ cancelled: true });
    },
  });
  return recorder;
}

/** The names of the calls `recorder` saw. */
const names = (recorder: Recorder) => recorder.calls.map(({ name }) => name);

/** What `work` rejected with. */
async function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("the sessions of a provider package's engine", () => {
  test("an engine an admitted package serves opens through the package's open with core's context, and no legacy class is built", async () => {
    expect(LEGACY_MODULES.length).toBeGreaterThan(30);
    const connection = connectionOf(MAIN, {
      user: "writer",
      sshTunnel: { enabled: false, host: "bastion", port: 22, username: "u", authMethod: "password" },
    });
    const asLegacy = connection as never;
    const entries: (() => Promise<unknown>)[] = [
      () => factory.createDatabaseProvider(asLegacy),
      () => factory.readProviderDeclarations(asLegacy),
      () => factory.withOneShotTunnel(asLegacy, async () => undefined),
      () => factory.getOrCreateProvider(asLegacy),
      () => factory.getOrCreateMetadataProvider(asLegacy),
      () => factory.acquireExecutionProfileProvider(asLegacy, "agent-read-only"),
    ];
    for (const entry of entries) {
      const error = await rejection(entry());
      expect(error).toBeInstanceOf(PackageEngineUnsupportedError);
      expect((error as Error).message).toBe(
        "LibreDB Studio's provider factory builds no provider for an engine of a provider package; that engine's session opens through its package, and this caller does not serve one.",
      );
    }
    expect(imported).toEqual([]);

    const hooks = record(MAIN);
    const start = Date.now();
    const cached = await sessions.getOrCreatePackageSession(connection, engineOf(MAIN), ADMIN);
    const end = Date.now();
    expect(names(hooks)).toEqual(["open"]);
    const ctx = hooks.calls[0]?.args[0] as OpenContext;
    expect(Object.isFrozen(ctx)).toBe(true);
    expect([ctx.engine, ctx.connectionId]).toEqual([MAIN, connection.id]);
    expect(ctx.connection).toEqual({ host: "db.local", user: "writer", password: connection.password });
    expect(ctx.deadline).toBeGreaterThanOrEqual(start + DEFAULT_CONNECT_BUDGET_MS);
    expect(ctx.deadline).toBeLessThanOrEqual(end + DEFAULT_CONNECT_BUDGET_MS);
    expect(ctx.policy).toMatchObject({ readOnly: false, sendsStatements: false, allowExternalFileAccess: true });
    expect(cached.connectionId).toBe(connection.id);
    expect(imported).toEqual([]);

    // The control: a bundled engine's build imports its own legacy module.
    await rejection(factory.createDatabaseProvider({ id: "c", name: "c", type: "postgres", host: "h" } as never));
    expect(imported).toEqual(["./providers/sql/postgres"]);
    imported.length = 0;
  });

  test("two concurrent first opens open one session", async () => {
    const hooks = record(MAIN, { hold: true });
    const connection = connectionOf(MAIN);
    const before = sessions.packageSessionStats().size;
    const first = sessions.getOrCreatePackageSession(connection, engineOf(MAIN), ADMIN);
    const second = sessions.getOrCreatePackageSession(connection, engineOf(MAIN), ADMIN);
    // Both reach the open table before the open answers: the key is computed asynchronously.
    await hooks.opened;
    hooks.answer({ handle: { session: randomUUID() } });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(names(hooks)).toEqual(["open"]);
    expect(sessions.packageSessionStats().size).toBe(before + 1);
    expect(await sessions.getOrCreatePackageSession(connection, engineOf(MAIN), ADMIN)).toBe(a);
    expect(names(hooks)).toEqual(["open"]);
  });

  test("teardown cuts a close that never settles at the deadline", async () => {
    const hooks = record(MAIN, { close: () => new Promise<void>(() => undefined) });
    const connection = connectionOf(MAIN);
    await sessions.getOrCreatePackageSession(connection, engineOf(MAIN), ADMIN);
    const warn = spyOn(logger, "warn");
    jest.useFakeTimers();
    try {
      const closing = sessions.closePackageSessions();
      expect(names(hooks)).toContain("close");
      jest.advanceTimersByTime(CLEANUP_DEADLINE_MS);
      const unclosed = await closing;
      expect(unclosed).toContain(`${connection.id} (acme-ps-main 1.0.0)`);
    } finally {
      jest.useRealTimers();
      warn.mockRestore();
    }
    expect(sessions.packageSessionStats().size).toBe(0);
    const closeCtx = hooks.calls.find(({ name }) => name === "close")?.args[1] as CallContext;
    expect(() => closeCtx.env.get("PATH")).toThrow();

    // The factory's cache clear reaches the package sessions too.
    record(MAIN);
    await sessions.getOrCreatePackageSession(connectionOf(MAIN), engineOf(MAIN), ADMIN);
    expect(sessions.packageSessionStats().size).toBe(1);
    await factory.clearProviderCache();
    expect(sessions.packageSessionStats().size).toBe(0);
  });

  test("a call the package does not offer is refused before the call", async () => {
    const hooks = record(BARE);
    const { session } = await sessions.getOrCreatePackageSession(connectionOf(BARE), engineOf(BARE), ADMIN);
    const core = createHostCore();
    const ports = { late: () => undefined, cancelFailed: () => undefined };
    const ctx = () => ({ deadline: Date.now() + 60_000, signal: new AbortController().signal, env: hooksEnv() });
    const records = [
      await core.treeCall(session, { action: "containers" } as never, ctx(), ports),
      await core.panelCall(session, { panel: "overview" }, ctx(), ports),
      await core.poolStatsCall(session, ctx(), ports),
      await core.cancelCall(session, { runId: "r" }, ctx(), ports),
    ];
    const view = { caller: new AbortController().signal, deadlineSentence: "d" };
    expect(records.map((answer) => answer.kind === "refused" && answer.refusals[0]?.name)).toEqual([
      "objects.tree",
      "monitoring.panel",
      "monitoring.poolStats",
      "console.cancel",
    ]);
    for (const answer of records) {
      if (answer.kind !== "refused") throw new Error(answer.kind);
      expect(answer.called).toBe(false);
      const error = refusalError(answer, view);
      expect(error).toBeInstanceOf(FacetNotOfferedError);
      expect([(error as InstanceType<typeof FacetNotOfferedError>).code, errorOutcome(error)]).toEqual([
        "FACET_NOT_OFFERED",
        "not-sent",
      ]);
    }
    expect(names(hooks)).toEqual(["open"]);
  });

  test("a caller whose wait ends stops waiting, and an open no caller waits for is admitted once", async () => {
    const hooks = record(MAIN, { hold: true });
    const connection = connectionOf(MAIN);
    const caller = new AbortController();
    const waiting = sessions.getOrCreatePackageSession(connection, engineOf(MAIN), ADMIN, { signal: caller.signal });
    await hooks.opened;
    const reason = new Error(randomUUID());
    caller.abort(reason);
    expect(await rejection(waiting)).toBe(reason);
    const handle = { session: randomUUID() };
    hooks.answer({ handle });
    // A later call joins the open in flight or reads the cache, so it waits for the admission without opening again.
    await sessions.getOrCreatePackageSession(connection, engineOf(MAIN), ADMIN);
    expect(sessions.packageSessionStats().connections.filter((id) => id === connection.id)).toHaveLength(1);
    expect(names(hooks)).toEqual(["open"]);

    // An open that fails with no caller left is logged by kind and code, never its text.
    const failing = record(MAIN, { hold: true });
    let logged!: () => void;
    const loggedOnce = new Promise<void>((resolve) => {
      logged = resolve;
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => logged());
    try {
      const left = new AbortController();
      const gone = sessions.getOrCreatePackageSession(connectionOf(MAIN), engineOf(MAIN), ADMIN, {
        signal: left.signal,
      });
      await failing.opened;
      left.abort(new Error(randomUUID()));
      await rejection(gone);
      const secret = randomUUID();
      failing.fail(new Error(secret));
      await loggedOnce;
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
      expect(warn.mock.calls[0]?.[1]).toMatchObject({ kind: "internal", code: "INTERNAL_ERROR" });
    } finally {
      warn.mockRestore();
    }
  });

  test("a removal or a cache clear closes an open it overtook, once, and caches nothing", async () => {
    for (const overtake of [
      (connection: PackageConnection) => factory.removeProvider(connection.id),
      () => factory.clearProviderCache(),
    ]) {
      const hooks = record(MAIN, { hold: true });
      const connection = connectionOf(MAIN);
      const opening = sessions.getOrCreatePackageSession(connection, engineOf(MAIN), ADMIN);
      await hooks.opened;
      const removal = overtake(connection);
      const handle = { session: randomUUID() };
      hooks.answer({ handle });
      const error = await rejection(opening);
      await removal;
      expect(error).toBeInstanceOf(ConnectionError);
      expect(errorOutcome(error)).toBe("not-sent");
      expect((error as Error).message).toStartWith("The connection was closed while it was opening");
      expect(hooks.calls.filter(({ name, args }) => name === "close" && args[0] === handle)).toHaveLength(1);
      expect(sessions.packageSessionStats().connections).not.toContain(connection.id);
    }
  });

  test("an open that answers while the caches close is overtaken, a failed close is logged by kind and code, and the sweep runs on its interval", async () => {
    await sessions.closePackageSessions();
    let release!: () => void;
    const held = record(MAIN, {
      close: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    await sessions.getOrCreatePackageSession(connectionOf(MAIN), engineOf(MAIN), ADMIN);
    const closing = sessions.closePackageSessions();
    const during = record(MAIN);
    const error = await rejection(sessions.getOrCreatePackageSession(connectionOf(MAIN), engineOf(MAIN), ADMIN));
    expect(error).toBeInstanceOf(ConnectionError);
    expect(names(during)).toEqual(["open", "close"]);
    release();
    expect(await closing).toEqual([]);
    expect(names(held)).toEqual(["open", "close"]);

    const secret = randomUUID();
    record(MAIN, { close: () => Promise.reject(new Error(secret)) });
    const connection = connectionOf(MAIN);
    await sessions.getOrCreatePackageSession(connection, engineOf(MAIN), ADMIN);
    const warn = spyOn(logger, "warn");
    try {
      expect(await sessions.closePackageSessions()).toEqual([`${connection.id} (acme-ps-main 1.0.0)`]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
      expect(warn.mock.calls.at(-1)?.[1]).toMatchObject({ kind: "internal", code: "INTERNAL_ERROR" });
    } finally {
      warn.mockRestore();
    }

    jest.useFakeTimers();
    try {
      record(MAIN);
      const swept = await sessions.getOrCreatePackageSession(connectionOf(MAIN), engineOf(MAIN), ADMIN);
      swept.lastUsed = 0;
      jest.advanceTimersByTime(5 * 60 * 1000);
    } finally {
      jest.useRealTimers();
    }
    await sessions.closePackageSessions();
  });

  test("an idle package session is torn down by its own sweep, and removeProvider by owner or key removes package sessions", async () => {
    const hooks = record(MAIN);
    const idle = await sessions.getOrCreatePackageSession(connectionOf(MAIN), engineOf(MAIN), ADMIN);
    idle.running = 1;
    expect(await sessions.evictIdlePackageSessions(0, Date.now() + 1)).toBe(0);
    idle.running = 0;
    expect(await sessions.evictIdlePackageSessions(0, Date.now() + 1)).toBe(1);
    expect(names(hooks)).toEqual(["open", "close"]);
    expect(sessions.packageSessionStats().size).toBe(0);

    const connection = connectionOf(MAIN);
    const owned = (owner: string) =>
      sessions.getOrCreatePackageSession(connection, engineOf(MAIN), { ...ADMIN, owner, ownerPoolMax: 2 });
    const [alice, bob] = [await owned("alice"), await owned("bob")];
    expect(alice).not.toBe(bob);
    const lastOpen = hooks.calls.at(-1) as { args: unknown[] };
    expect((lastOpen.args[0] as OpenContext).pool).toMatchObject({ min: 0, max: 2 });
    await factory.removeProvider(connection.id, { owner: "alice" });
    expect(sessions.packageSessionStats().connections).toEqual([connection.id]);
    await factory.removeProvider(connection.id, { key: bob.frame });
    expect(sessions.packageSessionStats().size).toBe(0);
  });

  test("the open's own deadline is the engine's connect budget: an open that never settles answers StudioTimeoutRefusal naming it, not-sent, and is closed once it settles", async () => {
    let closed!: () => void;
    const closing = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const hooks = record(MAIN, {
      hold: true,
      close: () => {
        closed();
        return Promise.resolve();
      },
    });
    const main = engineOf(MAIN);
    const brief = { ...main, catalog: { ...main.catalog, connectBudgetMs: 50 } } as PackageEngine;
    const error = await rejection(sessions.getOrCreatePackageSession(connectionOf(MAIN), brief, ADMIN));
    expect(error).toBeInstanceOf(StudioTimeoutRefusal);
    expect((error as Error).message).toBe(openDeadlineSentence(50));
    expect(errorOutcome(error)).toBe("not-sent");
    const handle = { session: randomUUID() };
    hooks.answer({ handle });
    await closing;
    expect(hooks.calls.filter(({ name }) => name === "close").map(({ args }) => args[0])).toEqual([handle]);
    expect(sessions.packageSessionStats().size).toBe(0);
  });

  test("each open check refuses before the package's open is called and before any file is read", async () => {
    const hooks = record(MAIN);
    const main = engineOf(MAIN);
    const owner = { ...ADMIN, owner: "o" };
    class NotPlain {
      readonly id = "c";
    }
    const cases: [PackageConnection, PackageEngine, Record<string, unknown>, string][] = [
      [connectionOf(MAIN, { readOnly: "yes" }), main, ADMIN, "readOnly must be true or false."],
      [
        connectionOf(MAIN, { readOnly: true }),
        main,
        ADMIN,
        `readOnly: true is refused for ${MAIN}: its provider package's engine does not enforce a read-only mode in this LibreDB Studio, so the connection would open able to write. Remove readOnly from the connection, or connect with a database role that cannot write.`,
      ],
      [
        connectionOf(MAIN),
        { ...main, grants: { ...main.grants, ungrantedRefusals: "Refused by its grants." } } as PackageEngine,
        ADMIN,
        "Refused by its grants.",
      ],
      [
        new NotPlain() as unknown as PackageConnection,
        main,
        ADMIN,
        "A connection must be a plain object of data fields; no provider was built.",
      ],
      [
        connectionOf(MAIN),
        main,
        owner,
        "ownerPoolMax must be a whole number from 1 when an owner is given: it is the most connections the owner's session may open.",
      ],
      [connectionOf(MAIN), main, { allowExternalFileAccess: false }, main.grants.deniedFileAccessRefusal as string],
      [
        connectionOf(MAIN, {
          sshTunnel: { enabled: true, host: "b", port: 22, username: "u", authMethod: "password" },
        }),
        main,
        ADMIN,
        "This LibreDB Studio opens no SSH tunnel for an engine of a provider package, so it does not open this connection. Turn the tunnel off.",
      ],
      [
        connectionOf(MAIN, { clientCertificatePath: "/etc/x.pem" }),
        { ...main, grants: { ...main.grants, hostPathFields: ["clientCertificatePath"] } } as PackageEngine,
        ADMIN,
        "This LibreDB Studio admits no host file for an engine of a provider package, so it does not hand on clientCertificatePath.",
      ],
      [
        connectionOf(MAIN, { database: "d" }),
        {
          ...main,
          connection: { ...main.connection, refused: { database: "This engine takes no database." } },
        } as PackageEngine,
        ADMIN,
        "This engine takes no database.",
      ],
      [
        connectionOf(MAIN, { password: " " }),
        {
          ...main,
          fieldRules: {
            connectionFields: ["password"],
            fieldRules: { password: { required: "Enter the password. Nothing was sent." } },
          },
        } as PackageEngine,
        ADMIN,
        "Enter the password. Nothing was sent.",
      ],
      [connectionOf(MAIN, { id: "" }), main, ADMIN, "Connection ID is required"],
      [
        connectionOf(MAIN, { sshTunnel: { enabled: false } }),
        main,
        ADMIN,
        "The connection's sshTunnel.host and sshTunnel.username must be text; nothing was sent.",
      ],
    ];
    for (const [connection, engine, execution, sentence] of cases) {
      const error = await rejection(sessions.getOrCreatePackageSession(connection, engine, execution));
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect((error as Error).message).toBe(sentence);
      expect(errorOutcome(error)).toBe("not-sent");
    }
    expect(() => sessions.assertPackageOpenable(connectionOf(MAIN), main, Object.create(ADMIN))).toThrow(
      "The execution context must be a plain object of data fields; no provider was built.",
    );

    process.env.LIBREDB_ENABLED_PROVIDERS = "postgres";
    try {
      const error = await rejection(sessions.getOrCreatePackageSession(connectionOf(MAIN), main, ADMIN));
      expect((error as Error).message).toBe(
        `The ${MAIN} provider is not available in this distribution of LibreDB Studio.`,
      );
    } finally {
      delete process.env.LIBREDB_ENABLED_PROVIDERS;
    }
    expect(names(hooks)).toEqual([]);
  });

  test("a refinement the host refuses fails the open as the package's defect, and Test Connection's one open is never cached", async () => {
    record(MAIN);
    setHooks(MAIN, {
      ...currentHooks(MAIN),
      open: () => Promise.resolve({ handle: 1, refine: { calls: { console: { endScope: "offered" } } } }),
    });
    const error = await rejection(sessions.getOrCreatePackageSession(connectionOf(MAIN), engineOf(MAIN), ADMIN));
    expect((error as Error).message).toStartWith("The provider package's open was refused:");
    expect(errorKind(error)).toBe("internal");

    record(MAIN);
    const once = await sessions.openPackageSessionOnce(
      connectionOf(MAIN),
      engineOf(MAIN),
      ADMIN,
      Date.now() + 1_000,
      new AbortController().signal,
    );
    expect(typeof once.session.health).toBe("function");
    expect(sessions.packageSessionStats().size).toBe(0);
  });
});

/** The hooks `id`'s package calls now. */
function currentHooks(id: string): Record<string, (...args: unknown[]) => unknown> {
  return (globalThis as Record<symbol, unknown>)[Symbol.for(`libredb-test.${id}`)] as Record<
    string,
    (...args: unknown[]) => unknown
  >;
}

/** An environment reader of no declared name. */
function hooksEnv() {
  return {
    get: (name: string): string | undefined => {
      throw new Error(`undeclared ${name}`);
    },
  };
}

const SOURCE = path.join(REPOSITORY_ROOT, "src");
const child = boundedChild({
  label: "package-session-teardown",
  imports: [{ from: path.join(SOURCE, "lib", "db", "package-sessions.ts"), names: ["teardownPackageSession"] }],
  runCase: async (deps: { teardownPackageSession: (...args: unknown[]) => Promise<unknown> }) => {
    const env = { get: () => undefined };
    const session = { close: () => new Promise<void>(() => {}) };
    return deps.teardownPackageSession(session, env, { rollbackMs: 50, closeMs: 100 });
  },
  heapLimitMiB: 128,
  timeoutMs: 3_000,
});

describe("the teardown of a package's session in a bounded child", () => {
  beforeAll(async () => {
    await child.build();
  });
  afterAll(() => {
    child.remove();
  });

  test("teardown cuts a close that never settles at the deadline, in a child with its own heap and timeout", async () => {
    expect(await child.run("cut")).toEqual({ rollback: "none", close: "timed-out" });
  });
});
