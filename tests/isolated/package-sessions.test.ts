/**
 * The sessions of an admitted provider package's engine (src/lib/db/package-sessions.ts; docs/providers/CONTRACT.md,
 * clauses C-109 and C-111): opened through the package's own `open` with the context core builds, never through a
 * legacy provider class, once per key, torn down under the teardown's deadlines, and refused before the open by every
 * check core holds for what it cannot hand a package.
 *
 * Fixture packages are written into a scratch providers directory and admitted by Studio's boot admission
 * (tests/helpers/package-session-fixture.ts); each function of a package calls the hook the case sets. Every module the
 * legacy adapter's open (src/lib/provider-host/legacy-adapter/open.ts) imports a legacy provider from is replaced by a
 * module that records its import, so a case reads whether the legacy path was reached. Nothing awaits a timer: every
 * wait settles on a promise a case resolves, the deadline cases run on a record whose budget is 50 ms, and the cut of a
 * close is read under fake timers here and in a bounded child. The child prints JSON lines, read after `trimEnd()`
 * (CRLF on Windows); no file mode or link is used.
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
import { admitSessionPackages, hooksKey, type SessionHooks, setHooks } from "../helpers/package-session-fixture";
import { removeScratch, scratchDirectory } from "../helpers/provider-artifacts";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..", "..");
const OPEN_SOURCE = readFileSync(
  path.join(REPOSITORY_ROOT, "src", "lib", "provider-host", "legacy-adapter", "open.ts"),
  "utf8",
);

/** Every module the legacy adapter's open imports a legacy provider from, as the open module names it. */
const LEGACY_MODULES = [...OPEN_SOURCE.matchAll(/await import\("(@\/lib\/db\/providers\/[^"]+)"\)/g)].map(
  (match) => match[1] as string,
);
const imported: string[] = [];
for (const specifier of LEGACY_MODULES) {
  mock.module(specifier, () => {
    imported.push(specifier);
    return {};
  });
}

const factory = await import("@/lib/db/factory");
const sessions = await import("@/lib/db/package-sessions");
const { assertOpenable } = await import("@/lib/db/open-check");
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
const { installHostCore } = await import("@/lib/provider-host/instance");
const { runPackageEditorQuery } = await import("@/lib/api/package-editor-query");
const { providerTextScrub } = await import("@/lib/db/operations/provider-text");
const { encodeValue } = await import("@libredb/provider-sdk/values");
type EngineRecord = import("@/lib/db/server-catalog").EngineRecord;
type EngineConnection = import("@/lib/db/server-catalog").EngineConnection;

const MAIN = "acmepsmain";
const BARE = "acmepsbare";
const ROWS = "acmepsrows";
const SCOPE = "acmepsscope";
const providers = scratchDirectory("studio-package-sessions-");
let engines: Map<string, EngineRecord>;

beforeAll(async () => {
  engines = await admitSessionPackages(providers, [
    { name: "acme-ps-main", engine: MAIN, offered: ["console.cancel"] },
    { name: "acme-ps-bare", engine: BARE },
    { name: "acme-ps-rows", engine: ROWS, honours: ["offset"], env: ["LIBREDB_TEST_PS_ROWS"] },
    { name: "acme-ps-scope", engine: SCOPE, offered: ["console.endScope"] },
  ]);
  installHostCore(createHostCore(), "test");
});
afterAll(async () => {
  await factory.clearProviderCache();
  removeScratch(providers);
});

/** The engine `id` as the catalog holds it. */
function engineOf(id: string): EngineRecord {
  return engines.get(id) as EngineRecord;
}

/** A connection of `id`'s engine with a generated secret and `fields`. */
function connectionOf(id: string, fields: Record<string, unknown> = {}): EngineConnection {
  return {
    id: `conn-${randomUUID()}`,
    name: "PS",
    type: id,
    host: "db.local",
    password: randomUUID(),
    ...fields,
  } as unknown as EngineConnection;
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

/** The arguments of the first call named `name` that `recorder` saw. */
function argsOf(recorder: Recorder, name: string): unknown[] {
  const call = recorder.calls.find((seen) => seen.name === name);
  if (call === undefined) throw new Error(`the package saw no ${name}`);
  return call.args;
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
    expect(imported).toEqual(["@/lib/db/providers/sql/postgres"]);
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

  test("a console execute on a package session answers the package's rows through the host core", async () => {
    const columns = [{ name: "key" }, { name: "value", type: "text" }];
    const rows = [
      ["alpha", 1],
      ["beta", BigInt(10)],
      ["gamma", null],
    ];
    /** A result source that answers `rows` in batches no larger than the pump asks for, and records its close. */
    const source = () => {
      let at = 0;
      return {
        columns,
        next: (limit: { maxRows: number }) => {
          const batch = rows.slice(at, at + limit.maxRows);
          at += batch.length;
          return Promise.resolve({ rows: batch, done: at >= rows.length });
        },
        close: () => Promise.resolve(),
      };
    };
    const scrub = providerTextScrub(connectionOf(BARE) as never, "any");
    const run = (queryId: string) => ({
      statement: "list",
      options: { limit: 2 },
      queryId,
      signal: new AbortController().signal,
      route: "test",
      scrub,
      queryTimeout: undefined,
    });

    for (const [id, honoursOffset] of [
      [BARE, false],
      [ROWS, true],
    ] as const) {
      const hooks = record(id);
      let running = -1;
      const cached = await sessions.getOrCreatePackageSession(connectionOf(id), engineOf(id), ADMIN);
      setHooks(id, {
        ...((globalThis as Record<symbol, unknown>)[hooksKey(id)] as SessionHooks),
        execute: (...args) => {
          hooks.calls.push({ name: "execute", args });
          running = cached.running;
          return Promise.resolve({ results: [source()], warnings: [], executionTimeMs: 7, pageApplied: false });
        },
      });
      const queryId = randomUUID();
      const { body } = await runPackageEditorQuery(cached, run(queryId));
      expect(body).toEqual({
        rows: [
          { key: "alpha", value: 1 },
          { key: "beta", value: encodeValue(BigInt(10)) },
        ],
        fields: ["key", "value"],
        columnTypes: { value: "text" },
        rowCount: 2,
        executionTime: 7,
        // The probe row came back, so the page was bounded; a next page only where the package takes an offset.
        pagination: { limit: 2, offset: 0, hasMore: honoursOffset, totalReturned: 2, wasLimited: true },
      });
      // The package was asked for one row past the page under the run's id, with its declared environment.
      const [request, ctx] = argsOf(hooks, "execute").slice(1) as [Record<string, unknown>, CallContext];
      expect(request).toEqual({ statement: "list", page: { limit: 3, offset: 0 }, runId: queryId });
      if (id === ROWS) expect(ctx.env.get("LIBREDB_TEST_PS_ROWS")).toBeUndefined();
      expect(() => ctx.env.get("PATH")).toThrow();
      // The run was counted while its call ran, so the idle sweep kept the session, and is not counted after it.
      expect([running, cached.running]).toEqual([1, 0]);
    }
  });

  test("a session that offers endScope is sent the run's scope and its rollback is answered, and columns that cannot key a row are the package's defect", async () => {
    const hooks = record(SCOPE);
    const cached = await sessions.getOrCreatePackageSession(connectionOf(SCOPE), engineOf(SCOPE), ADMIN);
    let columns: unknown[] = [{ name: "key" }];
    const emptySource = () => ({
      columns,
      next: () => Promise.resolve({ rows: [], done: true }),
      close: () => Promise.resolve(),
    });
    setHooks(SCOPE, {
      ...((globalThis as Record<symbol, unknown>)[hooksKey(SCOPE)] as SessionHooks),
      execute: (...args) => {
        hooks.calls.push({ name: "execute", args });
        return Promise.resolve({ results: [emptySource()], warnings: [], executionTimeMs: 1, pageApplied: false });
      },
      endScope: (...args) => {
        hooks.calls.push({ name: "endScope", args });
        return Promise.resolve({ openTransaction: "rolled-back" });
      },
    });
    const run = {
      statement: "BEGIN",
      options: {},
      signal: new AbortController().signal,
      route: "test",
      scrub: providerTextScrub(connectionOf(SCOPE) as never, "any"),
      queryTimeout: 30_000,
    };
    const { body } = await runPackageEditorQuery(cached, run);
    expect(body).toMatchObject({ rows: [], fields: ["key"], openTransaction: "rolled-back" });
    const { scope } = argsOf(hooks, "execute")[1] as { scope: string };
    expect(typeof scope).toBe("string");
    expect(hooks.calls.find(({ name }) => name === "endScope")?.args[1]).toEqual({ scope });

    for (const [answered, defect] of [
      [[{ name: "key" }, { name: "key" }], "two columns of one name"],
      [[{ name: "" }], "a column with no name"],
      [[{ name: 7 }], "a column with no name"],
    ] as const) {
      columns = [...answered];
      const failure = await rejection(runPackageEditorQuery(cached, run));
      expect((failure as Error).message).toBe(
        `The provider package answered ${defect}, so Studio cannot key its rows; this is its defect.`,
      );
    }
    expect(cached.running).toBe(0);
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
      (connection: EngineConnection) => factory.removeProvider(connection.id),
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
    const brief = { ...main, catalog: { ...main.catalog, connectBudgetMs: 50 } } as EngineRecord;
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
    const cases: [EngineConnection, EngineRecord, Record<string, unknown>, string][] = [
      [connectionOf(MAIN, { readOnly: "yes" }), main, ADMIN, "readOnly must be true or false."],
      [
        connectionOf(MAIN, { readOnly: true }),
        main,
        ADMIN,
        `readOnly: true is refused for ${MAIN}: its provider package's engine does not enforce a read-only mode in this LibreDB Studio, so the connection would open able to write. Remove readOnly from the connection, or connect with a database role that cannot write.`,
      ],
      [
        connectionOf(MAIN),
        { ...main, grants: { ...main.grants, ungrantedRefusals: "Refused by its grants." } } as EngineRecord,
        ADMIN,
        "Refused by its grants.",
      ],
      [
        new NotPlain() as unknown as EngineConnection,
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
        { ...main, grants: { ...main.grants, hostPathFields: ["clientCertificatePath"] } } as EngineRecord,
        ADMIN,
        "This LibreDB Studio admits no host file for an engine of a provider package, so it does not hand on clientCertificatePath.",
      ],
      [
        connectionOf(MAIN, { database: "d" }),
        {
          ...main,
          connection: { ...main.connection, refused: { database: "This engine takes no database." } },
        } as EngineRecord,
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
        } as EngineRecord,
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
    expect(() => assertOpenable(main, connectionOf(MAIN), Object.create(ADMIN), "connect")).toThrow(
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

  test("a package engine's cached session and Test Connection's session open through the one open function with the engine's record", async () => {
    const openEngineModule = await import("@/lib/provider-host/open-engine");
    const open = spyOn(openEngineModule, "openEngine");
    const connection = connectionOf(MAIN);
    try {
      record(MAIN);
      await sessions.getOrCreatePackageSession(connection, engineOf(MAIN), ADMIN);
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0]?.[0]).toBe(engineOf(MAIN));
      expect(open.mock.calls[0]?.[1].connection).toBe(connection);

      const once = connectionOf(MAIN);
      await sessions.openPackageSessionOnce(
        once,
        engineOf(MAIN),
        ADMIN,
        Date.now() + 1_000,
        new AbortController().signal,
      );
      expect(open).toHaveBeenCalledTimes(2);
      expect(open.mock.calls[1]?.[0]).toBe(engineOf(MAIN));
      expect(open.mock.calls[1]?.[1].connection).toBe(once);
    } finally {
      open.mockRestore();
      await sessions.removePackageSessions(connection.id);
    }
  });

  test("an absent file-access posture is not refused by the open check and reaches the package's open as false, as before", async () => {
    const hooks = record(MAIN);
    const connection = connectionOf(MAIN);
    try {
      await sessions.getOrCreatePackageSession(connection, engineOf(MAIN), {});
      expect(names(hooks)).toEqual(["open"]);
      expect((argsOf(hooks, "open")[0] as OpenContext).policy.allowExternalFileAccess).toBe(false);
    } finally {
      await sessions.removePackageSessions(connection.id);
    }
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

/**
 * The one open function the child bundles in place of the real one: the real one reaches the legacy adapter's open,
 * whose provider modules reach native addons the child's bundle cannot load, and the child tears a session down and
 * opens none.
 */
const OPEN_ENGINE_STUB = `
const notHere = () => {
  throw new Error("No engine opens in this child: it tears a package's session down.");
};
export const openEngine = notHere;
export const openedSession = notHere;
`;

const child = boundedChild({
  label: "package-session-teardown",
  imports: [{ from: path.join(SOURCE, "lib", "db", "package-sessions.ts"), names: ["teardownPackageSession"] }],
  stubs: [{ specifier: "@/lib/provider-host/open-engine", source: OPEN_ENGINE_STUB }],
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
