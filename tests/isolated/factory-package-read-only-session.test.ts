/**
 * A provider package's read-only statement session in the provider factory's profiled cache (src/lib/db/factory.ts,
 * `getOrCreateReadOnlyStatementSession`; docs/providers/CONTRACT.md, clauses C-78 and C-109): opened through the
 * package's own `open` under the read-only statement policy, once per package and frame, beside the editor's session,
 * swept, removed and torn down with every other profiled entry, and refused by name before the package opens for every
 * engine the factory opens none for, in the gates' order.
 *
 * Fixture packages are written into a scratch providers directory and admitted by Studio's boot admission
 * (tests/helpers/package-session-fixture.ts), each with a register row the case states; each function of a package
 * calls the hook the case sets. Nothing awaits a timer: every wait settles on a promise a hook resolves. Paths are the
 * scratch directory's real paths, so the same step is reached on every platform; no file mode, link or line ending is
 * relied on. Every password is generated at run time.
 */
// oxlint-disable no-await-in-loop -- each refusal is read after the one before, so its hooks read one open at a time.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { OpenContext } from "@libredb/provider-sdk/calls";
import {
  clearProviderCache,
  evictIdleProviders,
  getExecutionProfileCacheStats,
  getOrCreateEditorSession,
  getOrCreateMetadataSession,
  getOrCreateReadOnlyStatementSession,
  getProviderCacheStats,
  removeProvider,
} from "@/lib/db/factory";
import { IDLE_TIMEOUT_MS } from "@/lib/db/idle-sweep";
import { ConnectionError, DatabaseConfigError, StudioProfileRefusal } from "@/lib/db/errors";
import { errorOutcome } from "@/lib/db/error-record";
import { type EngineConnection, type EngineRecord, servedEngineRecord } from "@/lib/db/server-catalog";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { installHostCore } from "@/lib/provider-host/instance";
import { readOnlyStatementSession } from "@/lib/api/editor-provider";
import { runReadOnlyExecute } from "@/lib/api/read-only-execute";
import { PROVIDER_TEXT_WITHHELD, scrubProviderText } from "@/lib/db/operations/provider-text";
import { admitSessionPackages, setHooks } from "../helpers/package-session-fixture";
import { removeScratch, scratchDirectory } from "../helpers/provider-artifacts";

/** A package that honours readOnly, granted agent execution by a row that requires no read roots. */
const MAIN = "acmerosmain";
/** One that honours no request field, under the same row. */
const BARE = "acmerosbare";
/** One that honours readOnly and has no register row. */
const NO_ROW = "acmerosnorow";
/** One that honours readOnly under a row that does not grant agent execution. */
const UNREVIEWED = "acmerosunrev";
/** One that honours readOnly under a row that grants agent execution and requires read roots. */
const ROOTS = "acmerosroots";
/** One that honours readOnly under a row that grants agent execution and names a one-session reason. */
const ONE = "acmerosone";
/** One that honours no request field and has no register row. */
const NEITHER = "acmerosneither";
/** One that honours readOnly under a row that neither grants agent execution nor waives read roots. */
const UNREVIEWED_ROOTS = "acmerosunroots";

const REVIEWED = Object.freeze({ agentExecution: true, readRootsRequired: false });

const providers = scratchDirectory("studio-factory-package-read-only-session-");
let engines: Map<string, EngineRecord>;

beforeAll(async () => {
  engines = await admitSessionPackages(
    providers,
    [
      { name: "acme-ros-main", engine: MAIN, honours: ["readOnly"] },
      { name: "acme-ros-bare", engine: BARE },
      { name: "acme-ros-norow", engine: NO_ROW, honours: ["readOnly"] },
      { name: "acme-ros-unrev", engine: UNREVIEWED, honours: ["readOnly"] },
      { name: "acme-ros-roots", engine: ROOTS, honours: ["readOnly"] },
      { name: "acme-ros-one", engine: ONE, honours: ["readOnly"] },
      { name: "acme-ros-neither", engine: NEITHER },
      { name: "acme-ros-unroots", engine: UNREVIEWED_ROOTS, honours: ["readOnly"] },
    ],
    {
      [MAIN]: REVIEWED,
      [BARE]: REVIEWED,
      [UNREVIEWED]: { agentExecution: false, readRootsRequired: false },
      [ROOTS]: { agentExecution: true },
      [ONE]: { ...REVIEWED, servesOneSession: "The engine answers one session per connection." },
      [UNREVIEWED_ROOTS]: {},
    },
  );
  installHostCore(createHostCore(), "test");
});
afterAll(async () => {
  await clearProviderCache();
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
    name: "ROS",
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
}

/**
 * Hooks for `id` that record every call: `open` answers a fresh handle, or, when `hold` is set, waits for the case on
 * its first call and answers every later one at once.
 */
function record(id: string, options: { hold?: boolean } = {}): Recorder {
  const opened = Promise.withResolvers<void>();
  const recorder: Recorder = { calls: [], opened: opened.promise, answer: () => undefined };
  let held = options.hold === true;
  const push =
    (name: string, answer: unknown) =>
    (...args: unknown[]) => {
      recorder.calls.push({ name, args });
      return Promise.resolve(answer);
    };
  setHooks(id, {
    open: (...args) => {
      recorder.calls.push({ name: "open", args });
      opened.resolve();
      if (!held) return Promise.resolve({ handle: { session: randomUUID() } });
      held = false;
      return new Promise((resolve) => {
        recorder.answer = resolve;
      });
    },
    close: push("close", undefined),
    health: push("health", { databaseSize: "1", cacheHitRatio: "1", slowQueries: [], activeSessions: [] }),
    execute: push("execute", { results: [], warnings: [], executionTimeMs: 0, pageApplied: false }),
  });
  return recorder;
}

/** The names of the calls `recorder` saw. */
const names = (recorder: Recorder) => recorder.calls.map(({ name }) => name);

/** The open contexts `recorder`'s opens were handed, in order. */
const openContexts = (recorder: Recorder) =>
  recorder.calls.filter(({ name }) => name === "open").map(({ args }) => args[0] as OpenContext);

/** What `work` rejected with. */
async function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("a provider package's read-only statement session", () => {
  test("a package's read-only statement session opens through its package under the read-only statement policy, once per package and frame, beside the editor's session", async () => {
    await clearProviderCache();
    const hooks = record(MAIN, { hold: true });
    const connection = connectionOf(MAIN);
    const first = getOrCreateReadOnlyStatementSession(connection, engineOf(MAIN), ADMIN);
    const second = getOrCreateReadOnlyStatementSession(connection, engineOf(MAIN), ADMIN);
    // Both reach the open table before the open answers: the key is computed asynchronously.
    await hooks.opened;
    hooks.answer({ handle: { session: randomUUID() } });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(names(hooks)).toEqual(["open"]);
    const [ctx] = openContexts(hooks);
    expect(ctx?.policy).toMatchObject({ readOnly: true, sendsStatements: true, allowExternalFileAccess: true });
    expect(a.opened.form).toBe("session");
    if (a.opened.form !== "session") throw new Error("not a session");
    expect(a.opened.session.readOnlyStatements).toBe(true);
    expect(a.engine).toBe(engineOf(MAIN));
    // A later call reads the cache.
    expect(await getOrCreateReadOnlyStatementSession(connection, engineOf(MAIN), ADMIN)).toBe(a);
    expect(names(hooks)).toEqual(["open"]);
    // The profiled cache holds it; the editor cache does not.
    expect(getExecutionProfileCacheStats()).toEqual({ size: 1, connections: [connection.id] });
    expect(getProviderCacheStats().size).toBe(0);

    // The editor's and the metadata session of the same connection are other entries, each opened with the editor's
    // policy, which is no read-only statement session (clause C-78).
    const editor = await getOrCreateEditorSession(connection, engineOf(MAIN), ADMIN);
    const metadata = await getOrCreateMetadataSession(connection, engineOf(MAIN), ADMIN);
    expect(new Set([a, editor, metadata]).size).toBe(3);
    expect(names(hooks)).toEqual(["open", "open", "open"]);
    for (const opened of openContexts(hooks).slice(1)) {
      expect(opened.policy).toMatchObject({ readOnly: false, sendsStatements: false });
    }
    if (editor.opened.form !== "session") throw new Error("not a session");
    expect(editor.opened.session.readOnlyStatements).toBe(false);
    // Its frame is the editor's key, by which a removal's key scope names it.
    expect(a.frame).toBe(editor.frame);
    expect(getProviderCacheStats()).toEqual({ size: 1, connections: [connection.id] });
    expect(getExecutionProfileCacheStats().size).toBe(1);
    await removeProvider(connection.id);
  });

  test("a package's read-only statement session leaves with every removal that names its connection, its owner or its record's key, with the idle sweep and with the caches' teardown", async () => {
    await clearProviderCache();
    const hooks = record(MAIN);
    const closes = () => names(hooks).filter((name) => name === "close").length;

    // By connection.
    const byConnection = connectionOf(MAIN);
    await getOrCreateReadOnlyStatementSession(byConnection, engineOf(MAIN), ADMIN);
    await removeProvider(byConnection.id);
    expect(getExecutionProfileCacheStats().size).toBe(0);
    expect(closes()).toBe(1);

    // By owner: only that owner's session leaves; by the record's key: the other one.
    const owned = connectionOf(MAIN);
    const ownerContext = (owner: string) => ({ ...ADMIN, owner, ownerPoolMax: 2 });
    const alice = await getOrCreateReadOnlyStatementSession(owned, engineOf(MAIN), ownerContext("alice"));
    const bob = await getOrCreateReadOnlyStatementSession(owned, engineOf(MAIN), ownerContext("bob"));
    expect(alice).not.toBe(bob);
    expect(openContexts(hooks).at(-1)?.pool).toMatchObject({ min: 0, max: 2 });
    await removeProvider(owned.id, { owner: "alice" });
    expect(getExecutionProfileCacheStats()).toEqual({ size: 1, connections: [owned.id] });
    expect(closes()).toBe(2);
    await removeProvider(owned.id, { key: bob.frame });
    expect(getExecutionProfileCacheStats().size).toBe(0);
    expect(closes()).toBe(3);

    // The idle sweep keeps it while a call runs on it, and tears it down once none does.
    const idle = await getOrCreateReadOnlyStatementSession(connectionOf(MAIN), engineOf(MAIN), ADMIN);
    idle.lastUsed = Date.now() - IDLE_TIMEOUT_MS;
    idle.running = 1;
    expect(await evictIdleProviders()).toBe(0);
    idle.running = 0;
    expect(await evictIdleProviders()).toBe(1);
    expect(getExecutionProfileCacheStats().size).toBe(0);
    expect(closes()).toBe(4);

    // The caches' teardown.
    await getOrCreateReadOnlyStatementSession(connectionOf(MAIN), engineOf(MAIN), ADMIN);
    await clearProviderCache();
    expect(getExecutionProfileCacheStats().size).toBe(0);
    expect(closes()).toBe(5);

    // An open a removal overtook is closed and not admitted.
    const held = record(MAIN, { hold: true });
    const overtaken = connectionOf(MAIN);
    const opening = getOrCreateReadOnlyStatementSession(overtaken, engineOf(MAIN), ADMIN);
    await held.opened;
    const removal = removeProvider(overtaken.id);
    const handle = { session: randomUUID() };
    held.answer({ handle });
    const error = await rejection(opening);
    await removal;
    expect(error).toBeInstanceOf(ConnectionError);
    expect(errorOutcome(error)).toBe("not-sent");
    expect(held.calls.filter(({ name, args }) => name === "close" && args[0] === handle)).toHaveLength(1);
    expect(getExecutionProfileCacheStats().size).toBe(0);

    // A caller whose wait ends is released with its reason, and the open admits itself for the next caller.
    const waited = record(MAIN, { hold: true });
    const released = connectionOf(MAIN);
    const caller = new AbortController();
    const waiting = getOrCreateReadOnlyStatementSession(released, engineOf(MAIN), ADMIN, { signal: caller.signal });
    await waited.opened;
    const reason = new Error(randomUUID());
    caller.abort(reason);
    expect(await rejection(waiting)).toBe(reason);
    waited.answer({ handle: { session: randomUUID() } });
    await getOrCreateReadOnlyStatementSession(released, engineOf(MAIN), ADMIN);
    expect(names(waited)).toEqual(["open"]);
    expect(getExecutionProfileCacheStats()).toEqual({ size: 1, connections: [released.id] });
    await clearProviderCache();
  });

  test("readOnlyStatementSession answers the read-only execute's target and the tree target of one read-only statement session, its failures read through core's scrub of the connection", async () => {
    await clearProviderCache();
    const hooks = record(MAIN);
    const connection = connectionOf(MAIN);
    const { statements, tree } = await readOnlyStatementSession({ role: "admin" }, connection, engineOf(MAIN));
    if (statements.form !== "session") throw new Error("not a session target");
    expect(statements.engine).toBe(engineOf(MAIN));
    expect(tree.session).toBe(statements.session);
    expect(tree.wholeServer()).toBeNull();
    expect(statements.session.readOnlyStatements).toBe(true);
    // The scrub reads every field the package receives, the connection's own password among them.
    expect(scrubProviderText(statements.scrub, `denied ${connection.password}`)).toBe(PROVIDER_TEXT_WITHHELD);
    const result = await runReadOnlyExecute(statements, {
      type: MAIN,
      statement: "list",
      budget: { statementTimeoutMs: 60_000, maxResultRows: 10, maxResultBytes: 4096 },
      caller: new AbortController().signal,
      route: "test",
    });
    expect(result).toEqual({ rows: [], fields: [], rowCount: 0, executionTime: 0 });
    expect(names(hooks)).toEqual(["open", "execute"]);
    expect(openContexts(hooks)[0]?.policy).toMatchObject({ readOnly: true, sendsStatements: true });
    expect(getExecutionProfileCacheStats()).toEqual({ size: 1, connections: [connection.id] });
    await clearProviderCache();
  });

  test("a package engine the factory opens no read-only statement session for is refused by name before its package opens, in the gates' order", async () => {
    await clearProviderCache();
    /** The refusal of `id`'s connection with `fields`, checked to have opened and cached nothing. */
    const refusalOf = async (id: string, fields: Record<string, unknown> = {}) => {
      const hooks = record(id);
      const error = await rejection(getOrCreateReadOnlyStatementSession(connectionOf(id, fields), engineOf(id), ADMIN));
      expect([id, names(hooks)]).toEqual([id, []]);
      expect(getExecutionProfileCacheStats().size).toBe(0);
      return error as Error;
    };
    const profileRefusal = (error: Error) => {
      expect(error).toBeInstanceOf(StudioProfileRefusal);
      expect(errorOutcome(error)).toBe("not-sent");
      return [(error as StudioProfileRefusal).reasonCode, error.message];
    };
    const label = (id: string) => engineOf(id).displayName;

    // A legacy record's statements go through the execution-profile acquisition: a host defect here.
    const legacy = servedEngineRecord("postgres");
    const defect = await rejection(
      getOrCreateReadOnlyStatementSession(
        { id: "conn-legacy", name: "L", type: "postgres", host: "h" } as EngineConnection,
        legacy,
        ADMIN,
      ),
    );
    expect(defect).not.toBeInstanceOf(StudioProfileRefusal);
    expect((defect as Error).message).toBe(
      "The factory opens a read-only statement session only through a provider package, and this caller handed it a legacy engine's record, whose statements go through the execution-profile acquisition: a host defect.",
    );

    const unoffered = `The provider package of ${label(BARE)} takes no read-only execute (it does not list readOnly among the request fields it honours), so Studio opens no read-only statement session on it.`;
    expect(profileRefusal(await refusalOf(BARE))).toEqual(["PROFILE_UNSUPPORTED_BY_PROVIDER", unoffered]);
    const unreviewed = (id: string) =>
      `Provider type "${id}" is not on the review record of engines that run agent and MCP statements, so no statement is sent on it, whatever its provider implements`;
    for (const id of [NO_ROW, UNREVIEWED]) {
      expect(profileRefusal(await refusalOf(id))).toEqual(["PROFILE_ENGINE_NOT_REVIEWED", unreviewed(id)]);
    }
    expect(profileRefusal(await refusalOf(ROOTS))).toEqual([
      "PROFILE_UNSUPPORTED_BY_PROVIDER",
      `${label(ROOTS)} reads only beneath the read roots a seed declares, and a provider package's open receives no read roots, so Studio opens no read-only statement session on it.`,
    ]);
    expect(profileRefusal(await refusalOf(ONE))).toEqual([
      "PROFILE_UNSUPPORTED_BY_PROVIDER",
      `${label(ONE)} serves one session per connection, which the editor holds, so Studio opens no second, read-only statement session on it.`,
    ]);
    for (const credential of [{ agentUser: "agent" }, { agentPassword: randomUUID() }]) {
      const error = await refusalOf(MAIN, { id: "conn-agent", ...credential });
      expect(profileRefusal(error)).toEqual([
        "AGENT_CREDENTIAL_NOT_TAKEN",
        `Connection "conn-agent" configures an agent credential, and its engine's session opens through its provider package with the connection's own credential, which receives no agent credential, so no read-only statement session opens on it.`,
      ]);
      if ("agentPassword" in credential) expect(error.message).not.toContain(credential.agentPassword);
    }
    // Core's one ordered open check refuses what it refuses for every open: a read-only connection of an engine that
    // enforces no read-only mode.
    const openCheck = await refusalOf(MAIN, { readOnly: true });
    expect(openCheck).toBeInstanceOf(DatabaseConfigError);
    expect(errorOutcome(openCheck)).toBe("not-sent");
    expect(openCheck.message).toStartWith("readOnly: true is refused for");

    // The order: unoffered before unreviewed, unreviewed before the read roots.
    expect(profileRefusal(await refusalOf(NEITHER))[0]).toBe("PROFILE_UNSUPPORTED_BY_PROVIDER");
    expect(profileRefusal(await refusalOf(UNREVIEWED_ROOTS))[0]).toBe("PROFILE_ENGINE_NOT_REVIEWED");
  });

  test("a package's read-only statement session whose open withdrew readOnly from its honours is closed and refused by name, and never cached", async () => {
    await clearProviderCache();
    /** Hooks for MAIN whose open answers `honours` as the refinement of execute's request fields. */
    const refining = (honours: string[]) => {
      const calls: string[] = [];
      setHooks(MAIN, {
        open: () => {
          calls.push("open");
          return Promise.resolve({
            handle: { session: randomUUID() },
            refine: { calls: { console: { execute: { honours } } } },
          });
        },
        close: () => {
          calls.push("close");
          return Promise.resolve();
        },
        health: () => Promise.resolve({ databaseSize: "1", cacheHitRatio: "1", slowQueries: [], activeSessions: [] }),
        execute: () => Promise.resolve({ results: [], warnings: [], executionTimeMs: 0, pageApplied: false }),
      });
      return calls;
    };
    const connection = connectionOf(MAIN);
    const withdrawn = refining([]);
    for (const round of [1, 2]) {
      const error = await rejection(getOrCreateReadOnlyStatementSession(connection, engineOf(MAIN), ADMIN));
      expect(error).toBeInstanceOf(StudioProfileRefusal);
      expect((error as StudioProfileRefusal).reasonCode).toBe("PROFILE_UNSUPPORTED_BY_PROVIDER");
      expect(errorOutcome(error)).toBe("not-sent");
      expect((error as Error).message).toBe(
        `The provider package of ${engineOf(MAIN).displayName} withdrew readOnly from the request fields its session honours when it opened, so Studio opens no read-only statement session on it.`,
      );
      // Each call opens again, closes what it opened, and caches nothing.
      expect([round, withdrawn]).toEqual([round, Array.from({ length: round }, () => ["open", "close"]).flat()]);
      expect(getExecutionProfileCacheStats()).toEqual({ size: 0, connections: [] });
    }

    // A refinement that keeps readOnly is admitted and cached.
    const kept = refining(["readOnly"]);
    const entry = await getOrCreateReadOnlyStatementSession(connection, engineOf(MAIN), ADMIN);
    expect(kept).toEqual(["open"]);
    expect(entry.opened.form).toBe("session");
    expect(getExecutionProfileCacheStats()).toEqual({ size: 1, connections: [connection.id] });
    await clearProviderCache();
  });
});
