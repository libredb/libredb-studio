/**
 * The cancel and disconnect routes on an engine an admitted provider package serves, through the real
 * `resolveServedConnection`, the provider factory's real caches, the real host core and the real cancel facade
 * (docs/providers/CONTRACT.md, clauses C-30, C-107, C-111 and C-112): a query's run on the package's editor session is
 * cancelled through the package's `console.cancel`, sent the run id the execute was sent with the session's handle
 * first; a session that does not offer the cancel answers the route's one refusal for every engine, calling nothing; a
 * package's open failure, its cancel's failure and a malformed cancel answer answer the one answer, logged once; and a
 * disconnect closes every cache entry the record's key names, and no other; under governance each user's cancel and
 * disconnect reach only that user's own session.
 *
 * The packages are written into a scratch providers directory and admitted by Studio's boot admission
 * (tests/helpers/package-session-fixture.ts); each function calls the hook a case sets. Only `@/lib/auth` is mocked.
 * Paths are built with `path.join` by the fixture, no file mode, link or line ending is read, and nothing awaits a
 * timer: a cancel case waits on a promise the package's execute resolves when it starts, so every platform reaches the
 * same step.
 */
// oxlint-disable no-await-in-loop -- each post runs after the one before, on one rate limiter cleared per post.
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CallContext } from "@libredb/provider-sdk/calls";
import type { ObjectModel } from "@libredb/provider-sdk/manifest";
import { PACKAGE_DEFECT_PREFIX } from "@/lib/api/package-errors";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { PROVIDER_TEXT_WITHHELD, withheldErrorMessage } from "@/lib/db/operations/provider-text";
import { consoleTextOverLimit } from "@/lib/db/statement-language-row";
import { logger } from "@/lib/logger";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { installHostCore } from "@/lib/provider-host/instance";
import { parseResponseJSON } from "../../helpers/mock-next";
import { admitSessionPackages, setHooks } from "../../helpers/package-session-fixture";
import { removeScratch, scratchDirectory } from "../../helpers/provider-artifacts";
import { ACME_LANGUAGE_DATA, withStatementLanguageData } from "../../helpers/package-catalog";
import { admittedConnection, grantedSnapshot, WRITE_CREDENTIAL } from "../../helpers/governance/granted-snapshot";

/** The session every request is read as: an admin, or a governed user a governance case sets. */
let caller: Record<string, unknown> = { role: "admin", username: "admin", iat: 1_700_000_000 };
const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => caller),
  readSession: mock(async () => ({ kind: "authenticated", session: caller })),
}));

/** Each route under test, by its path under /api/db. */
const ROUTES: Readonly<Record<string, { POST: (req: never) => Promise<Response> }>> = {
  query: await import("@/app/api/db/query/route"),
  cancel: await import("@/app/api/db/cancel/route"),
  transaction: await import("@/app/api/db/transaction/route"),
  disconnect: await import("@/app/api/db/disconnect/route"),
  health: await import("@/app/api/db/health/route"),
  profile: await import("@/app/api/db/profile/route"),
  "provider-meta": await import("@/app/api/db/provider-meta/route"),
  "statement/analyze": await import("@/app/api/db/statement/analyze/route"),
};
const factory = await import("@/lib/db/factory");
const { recordGovernanceSnapshot, resetGovernanceState } = await import("@/lib/governance/state");

/**
 * A package offering the cancel and the transaction, granted no words; one offering both, granted its words; one
 * offering neither; and one offering both whose register row lets a caller whose file access is denied open it, as a
 * governed user's is.
 */
const REST = "acmerest";
const WORDS = "acmerestwords";
const PLAIN = "acmeplain";
const GOVERNED = "acmerestgoverned";
/** A package whose engine states no SQL text, and one whose engine declares an object model. */
const NOSQL = "acmerestnosql";
const MODELLED = "acmerestmodelled";
/** A package whose engine states no SQL text and a console text bound, as NOSQL's does, offering no transaction. */
const BOUNDED = "acmerestbounded";
const providers = scratchDirectory("studio-package-engine-rest-");

/** A tree with one container level and one kind of objects with columns: names no engine of Studio's. */
const DECLARED_MODEL: ObjectModel = {
  containerLevels: [{ id: "schema", label: "Folder", labelPlural: "Folders" }],
  containerPathShapes: "exact",
  containerNameSpelling: null,
  objectKinds: [
    {
      id: "item",
      role: "relation",
      label: "Item",
      labelPlural: "Items",
      hasSource: false,
      sourceLanguage: null,
      hasColumns: true,
      acceptsSourceEdits: false,
      childKinds: [],
      attachedTo: null,
      acceptsRowWrites: false,
      enumeratedBy: null,
      countIsListing: false,
      machineNames: null,
      group: null,
    },
  ],
  rowActions: [],
  containersNameKinds: false,
  tablesNeedContainer: false,
  tablesAreDerivedGroupings: false,
  agentWalkScope: null,
  schemaDiffScope: null,
  maskedNameKinds: [],
};

beforeAll(async () => {
  installHostCore(createHostCore(), "test");
  await admitSessionPackages(
    providers,
    [
      { name: "acme-rest", engine: REST, offered: ["console.cancel", "console.transaction"] },
      { name: "acme-rest-words", engine: WORDS, offered: ["console.cancel", "console.transaction"] },
      { name: "acme-plain", engine: PLAIN },
      { name: "acme-rest-governed", engine: GOVERNED, offered: ["console.cancel", "console.transaction"] },
      {
        name: "acme-rest-nosql",
        engine: NOSQL,
        offered: ["console.transaction"],
        edit: (engine) => {
          withStatementLanguageData(engine);
          const members = engine as Record<string, unknown>;
          members.sqlText = null;
          members.sqlWriting = null;
          members.migrationDdl = null;
        },
      },
      {
        name: "acme-rest-bounded",
        engine: BOUNDED,
        edit: (engine) => {
          withStatementLanguageData(engine);
          const members = engine as Record<string, unknown>;
          members.sqlText = null;
          members.sqlWriting = null;
          members.migrationDdl = null;
        },
      },
      {
        name: "acme-rest-modelled",
        engine: MODELLED,
        offered: ["objects.tree"],
        edit: (engine) => {
          (engine as Record<string, unknown>).objects = structuredClone(DECLARED_MODEL);
        },
      },
    ],
    { [WORDS]: { ownWords: "scrubbed" }, [GOVERNED]: { deniedFileAccessRefusal: null } },
  );
});
afterAll(async () => {
  await factory.clearProviderCache();
  removeScratch(providers);
});

let spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
});

/** What one package's hooks saw, by call name, with each call's arguments. */
interface Seen {
  readonly calls: { name: string; args: unknown[] }[];
}

/** A result source answering one row. */
function source() {
  let done = false;
  return {
    columns: [{ name: "key" }],
    next: () => {
      const rows = done ? [] : [["alpha"]];
      done = true;
      return Promise.resolve({ rows, done: true });
    },
    close: () => Promise.resolve(),
  };
}

/** An execute answer of one row. */
const ROWS = () => ({ results: [source()], warnings: [], executionTimeMs: 1, pageApplied: false });

/** A transaction request as the package's `transaction` receives it. */
interface TransactionRequest {
  readonly action: "begin" | "commit" | "rollback" | "state";
  readonly requireReportedState?: true;
}

/**
 * Hooks for `engine`'s package: open a fresh handle, close, read health, answer one row, cancel, and hold one
 * transaction per handle, whose state a begin opens and a COMMIT or ROLLBACK closes; a statement sent inside it answers
 * that state too. A case's `transaction` answers instead where it answers anything but undefined.
 */
function hooksFor(
  engine: string,
  options: {
    open?: () => Promise<unknown>;
    execute?: (request: Record<string, unknown>) => Promise<unknown>;
    cancel?: (request: unknown, handle: unknown) => Promise<unknown>;
    transaction?: (request: TransactionRequest) => Promise<unknown> | undefined;
  } = {},
): Seen {
  const states = new Map<unknown, string>();
  const stateOf = (handle: unknown) => states.get(handle) ?? "not-in-transaction";
  const seen: Seen = { calls: [] };
  const push =
    (name: string, answer: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      seen.calls.push({ name, args });
      return answer(...args);
    };
  setHooks(engine, {
    open: push("open", options.open ?? (() => Promise.resolve({ handle: { session: randomUUID() } }))),
    close: push("close", () => Promise.resolve()),
    health: push("health", () =>
      Promise.resolve({ databaseSize: "1 MB", cacheHitRatio: "99%", slowQueries: [], activeSessions: [] }),
    ),
    execute: push("execute", async (handle, request) => {
      const sent = request as Record<string, unknown>;
      const answer = (await (options.execute ?? (() => Promise.resolve(ROWS())))(sent)) as Record<string, unknown>;
      return sent.transaction === true ? { sessionState: stateOf(handle), ...answer } : answer;
    }),
    cancel: push("cancel", (handle, request) =>
      (options.cancel ?? (() => Promise.resolve({ cancelled: false })))(request, handle),
    ),
    transaction: push("transaction", (handle, request) => {
      const sent = request as TransactionRequest;
      const own = options.transaction?.(sent);
      if (own !== undefined) return own;
      if (sent.action === "begin") states.set(handle, "in-transaction");
      if (sent.action === "commit" || sent.action === "rollback") states.set(handle, "not-in-transaction");
      return Promise.resolve({
        sessionState: stateOf(handle),
        ...(sent.requireReportedState === true ? { stateReported: true } : {}),
      });
    }),
  });
  return seen;
}

/** The names of the calls `seen` recorded. */
const names = (seen: Seen) => seen.calls.map(({ name }) => name);

/** The calls `seen` recorded of `name`. */
const callsNamed = (seen: Seen, name: string) => seen.calls.filter((call) => call.name === name);

/** A connection of `engine` with its own id and a generated secret. */
function connectionOf(engine: string, id = `conn-${randomUUID()}`): Record<string, unknown> {
  return { id, name: "Rest", type: engine, host: "rest.local", password: randomUUID() };
}

/** The status and body `route` answers for `body`. */
async function post(route: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  clearRateLimitState();
  const handler = ROUTES[route] as { POST: (req: never) => Promise<Response> };
  const response = await handler.POST(
    new Request(`http://localhost:3000/api/db/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
  return { status: response.status, body: await parseResponseJSON<unknown>(response) };
}

/** The lines `logger.error` and `logger.warn` write while the case runs, each as its message and its error's words. */
function loggedLines(): () => [string, string][] {
  const lines: [string, string][] = [];
  const record = (message: unknown, payload?: unknown) => {
    lines.push([String(message), payload instanceof Error ? payload.message : JSON.stringify(payload ?? null)]);
  };
  spies.push(
    spyOn(logger, "error").mockImplementation(record),
    spyOn(logger, "warn").mockImplementation(record),
    spyOn(logger, "info").mockImplementation(() => undefined),
  );
  return () => lines.splice(0);
}

describe("the cancel route on a provider package's engine", () => {
  test("cancel runs on a package engine's session through the console's cancel", async () => {
    const connection = connectionOf(REST);
    let started!: () => void;
    const executing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const seen = hooksFor(REST, {
      execute: () => {
        started();
        return new Promise((resolve) => {
          release = () => resolve(ROWS());
        });
      },
      cancel: () => {
        release();
        return Promise.resolve({ cancelled: true });
      },
    });
    const queryId = randomUUID();
    const running = post("query", { connection, sql: "SELECT 1", queryId });
    await executing;

    expect(await post("cancel", { connection, queryId })).toEqual({ status: 200, body: { cancelled: true } });
    expect((await running).status).toBe(200);
    // One session: the cancel found the run on the editor's session the query opened, its handle first.
    expect(names(seen)).toEqual(["open", "execute", "cancel"]);
    const [execute] = callsNamed(seen, "execute").map(({ args }) => args);
    const [cancel] = callsNamed(seen, "cancel").map(({ args }) => args);
    if (execute === undefined || cancel === undefined) throw new Error("the package saw no execute or no cancel");
    expect(cancel[0]).toBe(execute[0]);
    expect(cancel[1]).toEqual({ runId: queryId });
    expect((execute[1] as { runId?: string }).runId).toBe(queryId);
    expect((cancel[2] as CallContext).signal.aborted).toBe(false);

    // A run the package does not know answers not cancelled, on the same session.
    hooksFor(REST);
    expect(await post("cancel", { connection, queryId: randomUUID() })).toEqual({
      status: 200,
      body: { cancelled: false },
    });
  });

  test("a package engine whose session does not offer console.cancel answers the cancel route's one refusal, cancelled false, calling nothing", async () => {
    const seen = hooksFor(PLAIN);
    const answer = await post("cancel", { connection: connectionOf(PLAIN), queryId: randomUUID() });
    expect(answer).toEqual({
      status: 400,
      body: { error: "Query cancellation is not supported for this database type", cancelled: false },
    });
    expect(names(seen)).toEqual(["open"]);

    // The queryId is checked after the connection resolves, as for every engine, and before any open.
    const missing = await post("cancel", { connection: connectionOf(PLAIN) });
    expect(missing).toEqual({ status: 400, body: { error: "Connection and queryId are required" } });
    expect(names(seen)).toEqual(["open"]);
  });

  test("the cancel route answers a package's open failure as not-sent, its cancel failure by its grant, and a malformed cancel answer as the package's defect", async () => {
    const lines = loggedLines();
    for (const engine of [REST, WORDS]) {
      const granted = engine === WORDS;

      // The open fails, its words naming the connection's secret: not-sent, logged once.
      const refusedOpen = connectionOf(engine);
      const words = `the store is away for ${String(refusedOpen.password)}`;
      hooksFor(engine, { open: () => Promise.reject(new Error(words)) });
      const opened = await post("cancel", { connection: refusedOpen, queryId: randomUUID() });
      expect(opened.status).toBe(503);
      expect(opened.body).toMatchObject({ code: "CONNECTION_ERROR", outcome: "not-sent" });
      const sentence = (opened.body as { error: string }).error;
      if (granted) expect(sentence).toBe(PROVIDER_TEXT_WITHHELD);
      else expect(sentence).toMatch(/^The provider package's open failed \(.+\); the server's log holds its words\.$/);
      expect(lines().map(([message]) => message)).toEqual(["A provider package's open failed"]);

      // The cancel rejects: Studio's sentence naming its code, or the words as raised, logged once.
      const connection = connectionOf(engine);
      const own = `the cancel failed ${randomUUID()}`;
      hooksFor(engine, { cancel: () => Promise.reject(new Error(own)) });
      const failed = await post("cancel", { connection, queryId: randomUUID() });
      expect(failed.status).toBe(500);
      expect((failed.body as { error: string }).error).toBe(
        granted ? own : "The provider package's cancel failed (INTERNAL_ERROR); the server's log holds its words.",
      );
      expect(lines().map(([message]) => message)).toEqual(["A provider package's cancel failed"]);

      // A cancel answer outside its form is the package's defect, named by its rule, logged once.
      hooksFor(engine, { cancel: () => Promise.resolve({ cancelled: "yes" }) });
      const malformed = await post("cancel", { connection, queryId: randomUUID() });
      expect(malformed.status).toBe(500);
      const defect = (malformed.body as { error: string }).error;
      expect(defect.startsWith(PACKAGE_DEFECT_PREFIX)).toBe(true);
      if (!granted) {
        expect(defect).toBe(
          `${PACKAGE_DEFECT_PREFIX} it broke the rule cancel-answer-unreadable; the server's log names where.`,
        );
      }
      const defectLines = lines();
      expect(defectLines.map(([message]) => message)).toEqual(["A provider package's cancel failed"]);
      expect(defectLines[0]?.[1].startsWith(PACKAGE_DEFECT_PREFIX)).toBe(true);
      expect(JSON.stringify([opened.body, failed.body, malformed.body, defectLines])).not.toContain(
        String(refusedOpen.password),
      );
    }

    // No case answers a package engine 501.
    for (const engine of [REST, WORDS, PLAIN]) {
      hooksFor(engine);
      const answer = await post("cancel", { connection: connectionOf(engine), queryId: randomUUID() });
      expect([engine, answer.status === 501]).toEqual([engine, false]);
    }
  });
});

describe("the transaction route on a provider package's engine", () => {
  /** The transaction calls `seen` recorded, each as its action and whether it reached the session `handle` names. */
  const transactionCalls = (seen: Seen, handle: unknown) =>
    callsNamed(seen, "transaction").map(({ args }) => [(args[1] as TransactionRequest).action, args[0] === handle]);
  /** How many sessions the package opened. */
  const opens = (seen: Seen) => callsNamed(seen, "open").length;
  const NOT_SUPPORTED = { error: "Transaction control is not supported for this database type" };
  /**
   * The messages of `lines` but the confirmation gate's own warning, which it writes for each statement of an engine
   * whose grammar no register row reviews that runs unconfirmed (`ranUnconfirmed` in src/lib/api/run-confirmation.ts).
   */
  const routeLines = (lines: [string, string][]) =>
    lines
      .map(([message]) => message)
      .filter((message) => message !== "A statement that needs a confirmation ran without one");

  test("a transaction runs on a package engine's session through the console's transaction calls", async () => {
    const connection = connectionOf(REST);
    const handle = { session: randomUUID() };
    const seen = hooksFor(REST, { open: () => Promise.resolve({ handle }) });

    expect(await post("transaction", { connection, action: "begin", requireReportedState: true })).toEqual({
      status: 200,
      body: { status: "active", message: "Transaction started", stateReported: true },
    });
    expect(await post("transaction", { connection, action: "status" })).toEqual({
      status: 200,
      body: { inTransaction: true, ownedByYou: true, heldByAnotherSession: false, startedAt: expect.any(String) },
    });
    const ran = await post("transaction", { connection, action: "query", sql: "SELECT 1", options: { limit: 5 } });
    expect(ran).toMatchObject({
      status: 200,
      body: { rows: [{ key: "alpha" }], fields: ["key"], rowCount: 1, inTransaction: true },
    });
    expect(await post("transaction", { connection, action: "commit" })).toEqual({
      status: 200,
      body: { status: "committed", message: "Transaction committed" },
    });
    expect((await post("transaction", { connection, action: "begin" })).body).toEqual({
      status: "active",
      message: "Transaction started",
      stateReported: null,
    });
    expect(await post("transaction", { connection, action: "rollback" })).toEqual({
      status: 200,
      body: { status: "rolled_back", message: "Transaction rolled back" },
    });

    // One session, opened once: every request reads the state first, then sends its own call, its handle first.
    expect(opens(seen)).toBe(1);
    expect(transactionCalls(seen, handle)).toEqual([
      ["state", true],
      ["begin", true],
      ["state", true],
      ["state", true],
      ["state", true],
      ["commit", true],
      ["state", true],
      ["begin", true],
      ["state", true],
      ["rollback", true],
    ]);
    expect(callsNamed(seen, "transaction")[1]?.args[1]).toEqual({ action: "begin", requireReportedState: true });
    // The statement is sent to the package's execute inside the transaction, with the request's page.
    const [execute] = callsNamed(seen, "execute").map(({ args }) => args);
    expect(execute?.[0]).toBe(handle);
    // The request's page, and the one probe row that tells whether there is more.
    expect(execute?.[1]).toMatchObject({ statement: "SELECT 1", page: { limit: 6, offset: 0 }, transaction: true });
  });

  test("a script inside a package engine's transaction runs each unit through the host core's execute", async () => {
    const lines = loggedLines();
    const connection = connectionOf(REST);
    const seen = hooksFor(REST);
    expect((await post("transaction", { connection, action: "begin" })).status).toBe(200);

    const script = await post("transaction", {
      connection,
      action: "query",
      sql: "SELECT 1; SELECT 2",
      options: { limit: 5 },
    });
    expect(script).toMatchObject({
      status: 200,
      body: {
        rows: [{ key: "alpha" }],
        multiStatement: true,
        statementCount: 2,
        executedCount: 2,
        hasError: false,
        inTransaction: true,
      },
    });
    // Each unit is sent inside the transaction: every row of the first, the request's page for the last.
    expect(callsNamed(seen, "execute").map(({ args }) => args[1])).toEqual([
      expect.objectContaining({ statement: "SELECT 1", page: { unlimited: true }, transaction: true }),
      expect.objectContaining({ statement: "SELECT 2", page: { limit: 5, offset: 0 }, transaction: true }),
    ]);

    // A failing unit ends the run with Studio's sentence naming its code in the script's answer, logged once.
    let units = 0;
    hooksFor(REST, {
      execute: () => {
        units += 1;
        return units === 2 ? Promise.reject(new Error(`the store refused ${randomUUID()}`)) : Promise.resolve(ROWS());
      },
      // The session still holds the transaction the begin above opened.
      transaction: () => Promise.resolve({ sessionState: "in-transaction" }),
    });
    const failed = await post("transaction", { connection, action: "query", sql: "SELECT 1; SELECT 2; SELECT 3" });
    expect(failed).toMatchObject({
      status: 200,
      body: { executedCount: 2, hasError: true, inTransaction: true },
    });
    const statements = (failed.body as { statements: { status: string; error?: string }[] }).statements;
    expect(statements.map(({ status, error }) => [status, error])).toEqual([
      ["success", undefined],
      ["error", "The provider package's execute failed (INTERNAL_ERROR); the server's log holds its words."],
    ]);
    expect(routeLines(lines())).toEqual(["A provider package's execute failed"]);
    hooksFor(REST);
    expect((await post("transaction", { connection, action: "rollback" })).status).toBe(200);

    // A record stating no SQL text sends the text as one statement.
    const nosql = connectionOf(NOSQL);
    const plain = hooksFor(NOSQL);
    expect((await post("transaction", { connection: nosql, action: "begin" })).status).toBe(200);
    expect((await post("transaction", { connection: nosql, action: "query", sql: "a; b" })).status).toBe(200);
    expect(callsNamed(plain, "execute").map(({ args }) => (args[1] as { statement: string }).statement)).toEqual([
      "a; b",
    ]);
    expect((await post("transaction", { connection: nosql, action: "rollback" })).status).toBe(200);
  });

  test("a package engine whose session does not offer console.transaction answers the transaction route's one refusal, calling nothing", async () => {
    const seen = hooksFor(PLAIN);
    const connection = connectionOf(PLAIN);
    for (const body of [{ action: "begin" }, { action: "status" }, { action: "query", sql: "SELECT 1" }]) {
      expect(await post("transaction", { connection, ...body })).toEqual({ status: 400, body: NOT_SUPPORTED });
    }
    // The open is the only call: no transaction call and no statement reached the package.
    expect(names(seen)).toEqual(["open"]);
  });

  test("the transaction route answers a package's open failure as not-sent, its transaction and statement failures by its grant, logged once, and a malformed transaction answer as the package's defect", async () => {
    const lines = loggedLines();
    for (const engine of [REST, WORDS]) {
      const granted = engine === WORDS;
      const sentence = (call: string, words: string) =>
        granted ? words : `The provider package's ${call} failed (INTERNAL_ERROR); the server's log holds its words.`;

      // The open fails, its words naming the connection's secret: not-sent, logged once.
      const refusedOpen = connectionOf(engine);
      hooksFor(engine, {
        open: () => Promise.reject(new Error(`the store is away for ${String(refusedOpen.password)}`)),
      });
      const opened = await post("transaction", { connection: refusedOpen, action: "begin" });
      expect(opened.status).toBe(503);
      expect(opened.body).toMatchObject({ code: "CONNECTION_ERROR", outcome: "not-sent" });
      if (granted) expect((opened.body as { error: string }).error).toBe(PROVIDER_TEXT_WITHHELD);
      expect(lines().map(([message]) => message)).toEqual(["A provider package's open failed"]);

      // The begin rejects: Studio's sentence naming its code, or the words as raised, logged once.
      const connection = connectionOf(engine);
      const begin = `the begin failed ${randomUUID()}`;
      hooksFor(engine, {
        transaction: (request) => (request.action === "begin" ? Promise.reject(new Error(begin)) : undefined),
      });
      const begun = await post("transaction", { connection, action: "begin" });
      expect([begun.status, (begun.body as { error: string }).error]).toEqual([500, sentence("transaction", begin)]);
      expect(lines().map(([message]) => message)).toEqual(["A provider package's transaction failed"]);

      // A begun transaction's COMMIT and statement reject: each answered by the grant, logged once.
      const commit = `the commit failed ${randomUUID()}`;
      const statement = `the statement failed ${randomUUID()}`;
      hooksFor(engine, {
        execute: () => Promise.reject(new Error(statement)),
        transaction: (request) => (request.action === "commit" ? Promise.reject(new Error(commit)) : undefined),
      });
      expect((await post("transaction", { connection, action: "begin" })).status).toBe(200);
      const ran = await post("transaction", { connection, action: "query", sql: "SELECT 1" });
      expect([ran.status, (ran.body as { error: string }).error]).toEqual([500, sentence("execute", statement)]);
      expect(routeLines(lines())).toEqual(["A provider package's execute failed"]);
      const committed = await post("transaction", { connection, action: "commit" });
      expect([committed.status, (committed.body as { error: string }).error]).toEqual([
        500,
        sentence("transaction", commit),
      ]);
      expect(lines().map(([message]) => message)).toEqual(["A provider package's transaction failed"]);

      // A state answer outside the vocabulary is the package's defect, named by its rule, logged once.
      hooksFor(engine, { transaction: () => Promise.resolve({ sessionState: "maybe" }) });
      const malformed = await post("transaction", { connection, action: "status" });
      expect(malformed.status).toBe(500);
      const defect = (malformed.body as { error: string }).error;
      expect(defect.startsWith(PACKAGE_DEFECT_PREFIX)).toBe(true);
      if (!granted) {
        expect(defect).toBe(
          `${PACKAGE_DEFECT_PREFIX} it broke the rule transaction-answer-unreadable; the server's log names where.`,
        );
      }
      const defectLines = lines();
      expect(defectLines.map(([message]) => message)).toEqual(["A provider package's transaction failed"]);
      expect(defectLines[0]?.[1].startsWith(PACKAGE_DEFECT_PREFIX)).toBe(true);
      expect(JSON.stringify([opened.body, begun.body, ran.body, committed.body, defectLines])).not.toContain(
        String(refusedOpen.password),
      );

      // The session still holds the begun transaction. Its ROLLBACK rejects: answered by the grant, logged once,
      // and a code-only package's words reach no answer.
      const rollback = `the rollback failed ${randomUUID()}`;
      hooksFor(engine, {
        transaction: (request) => (request.action === "rollback" ? Promise.reject(new Error(rollback)) : undefined),
      });
      const rolledBack = await post("transaction", { connection, action: "rollback" });
      expect([rolledBack.status, (rolledBack.body as { error: string }).error]).toEqual([
        500,
        sentence("transaction", rollback),
      ]);
      expect(lines().map(([message]) => message)).toEqual(["A provider package's transaction failed"]);
      if (!granted) expect(JSON.stringify(rolledBack.body)).not.toContain(rollback);

      // A begun transaction's ROLLBACK that the package answers ends it.
      hooksFor(engine);
      expect((await post("transaction", { connection, action: "begin" })).status).toBe(200);
      expect((await post("transaction", { connection, action: "rollback" })).status).toBe(200);
    }
  });

  test("the transaction route refuses a catalog and an unbounded page a package engine's record does not offer, by name, not-sent, before any open", async () => {
    const seen = hooksFor(REST);
    const connection = connectionOf(REST);
    const notOffered = (sentence: string) => ({
      status: 400,
      body: expect.objectContaining({ error: sentence, code: "FACET_NOT_OFFERED", outcome: "not-sent" }),
    });

    for (const action of ["begin", "status", "commit", "rollback", "query"]) {
      expect([action, await post("transaction", { connection, action, sql: "SELECT 1", catalog: "other" })]).toEqual([
        action,
        notOffered(
          "This connection's engine offers no catalog session in this LibreDB Studio, so Studio opened nothing.",
        ),
      ]);
    }
    expect(
      await post("transaction", { connection, action: "query", sql: "SELECT 1", options: { unlimited: true } }),
    ).toEqual(
      notOffered(
        "This connection's engine does not offer the request field options.unlimited in this LibreDB Studio, so Studio opened nothing.",
      ),
    );
    // A malformed field keeps its 400, before any refusal by name.
    expect(await post("transaction", { connection, action: "begin", catalog: "" })).toMatchObject({
      status: 400,
      body: { code: "CONFIG_ERROR" },
    });
    expect(
      await post("transaction", {
        connection,
        action: "query",
        sql: "SELECT 1",
        options: { unlimited: true, limit: -1 },
      }),
    ).toEqual({ status: 400, body: { error: "options.limit must be a non-negative integer" } });

    // Nothing opened, and no answer was 501.
    expect(names(seen)).toEqual([]);

    // An unbounded page is a field of the statement a query action sends; no other action reads it.
    expect(await post("transaction", { connection, action: "status", options: { unlimited: true } })).toMatchObject({
      status: 200,
      body: { inTransaction: false },
    });
  });

  test("the transaction route holds a package engine's query action to its record's console text bound after the facet check, 413 before any call on its session", async () => {
    const connection = connectionOf(NOSQL);
    const seen = hooksFor(NOSQL);
    expect((await post("transaction", { connection, action: "begin" })).status).toBe(200);
    const before = seen.calls.length;

    // One byte over the record's bound: 413 in the bound's sentence, after the open and before any call.
    const bound = ACME_LANGUAGE_DATA.confirmation.maxTextBytes;
    if (bound === null) throw new Error("the fixture's statement language data states no text bound");
    const oversize = "a".repeat(bound + 1);
    expect(await post("transaction", { connection, action: "query", sql: oversize })).toEqual({
      status: 413,
      body: { error: consoleTextOverLimit(oversize, bound) },
    });
    expect(seen.calls.slice(before)).toEqual([]);

    // A text within the bound runs inside the transaction.
    const within = "a".repeat(bound);
    expect(await post("transaction", { connection, action: "query", sql: within })).toMatchObject({
      status: 200,
      body: { inTransaction: true },
    });
    expect(callsNamed(seen, "execute").map(({ args }) => (args[1] as { statement: string }).statement)).toEqual([
      within,
    ]);
    expect((await post("transaction", { connection, action: "rollback" })).status).toBe(200);

    // A session that does not offer console.transaction answers the facet's 400 first, whatever the text's size.
    const bounded = hooksFor(BOUNDED);
    expect(await post("transaction", { connection: connectionOf(BOUNDED), action: "query", sql: oversize })).toEqual({
      status: 400,
      body: NOT_SUPPORTED,
    });
    expect(names(bounded)).toEqual(["open"]);
  });
});

describe("the disconnect route on a provider package's engine", () => {
  test("disconnect removes every cache entry of a package engine's record, and no other record's", async () => {
    const id = `conn-${randomUUID()}`;
    const connection = connectionOf(REST, id);
    // The same id with other credentials frames other entries.
    const other = connectionOf(REST, id);
    const seen = hooksFor(REST);
    // The query opens the editor's session and the health read the metadata session, of each record.
    for (const record of [connection, other]) {
      expect((await post("query", { connection: record, sql: "SELECT 1" })).status).toBe(200);
      expect((await post("health", { connection: record })).status).toBe(200);
    }
    expect(callsNamed(seen, "open")).toHaveLength(4);
    const handles = callsNamed(seen, "open").length;

    expect(await post("disconnect", { connection })).toEqual({ status: 200, body: { success: true } });
    // Both of the record's sessions closed, each once; the other record's sessions stay.
    expect(callsNamed(seen, "close")).toHaveLength(2);
    expect(await post("query", { connection: other, sql: "SELECT 1" })).toMatchObject({ status: 200 });
    expect(callsNamed(seen, "open")).toHaveLength(handles);
    // The record's next query opens a new session.
    expect(await post("query", { connection, sql: "SELECT 1" })).toMatchObject({ status: 200 });
    expect(callsNamed(seen, "open")).toHaveLength(handles + 1);

    // A seed id removes nothing: one session serves every user of a seed, and the idle sweep closes it.
    expect(await post("disconnect", { connectionId: `seed:${randomUUID()}` })).toEqual({
      status: 200,
      body: { success: true },
    });
    expect(callsNamed(seen, "close")).toHaveLength(2);
  });
});

describe("the record readers on a provider package's engine", () => {
  /** The not-sent refusal by the record's offer, with `sentence`. */
  const notOffered = (sentence: string) => ({
    status: 400,
    body: expect.objectContaining({ error: sentence, code: "FACET_NOT_OFFERED", outcome: "not-sent" }),
  });
  const NO_PROFILE =
    "This connection's engine offers no column profile in this LibreDB Studio, so Studio opened nothing.";
  const NO_DECLARATIONS =
    "Statement analysis reads the engine's statement terminator and editor language from a provider Studio builds without connecting, which this connection's engine does not offer in this LibreDB Studio, so Studio analysed nothing.";
  const NO_SQL_TEXT =
    "This connection's engine states no SQL text, so Studio has no statement to analyse and analysed nothing.";
  const ANALYSIS = { text: "SELECT 1", selection: { start: 0, end: 0 }, cursor: 0 };

  test("the profile route and the statement analysis refuse a package engine by the record's offer, by name", async () => {
    const seen = hooksFor(REST);
    const nosql = hooksFor(NOSQL);
    const connection = connectionOf(REST);

    expect(await post("profile", { connection, tablePath: ["s1", "thing"], columns: ["key"] })).toEqual(
      notOffered(NO_PROFILE),
    );
    // A malformed field is still the caller's, answered first.
    expect(await post("profile", { connection, tablePath: "s1.thing" })).toEqual({
      status: 400,
      body: { error: "tablePath is required: the object address, one segment per element" },
    });

    // An engine that states SQL text is refused by the declarations it cannot offer, one that states none by that.
    expect(await post("statement/analyze", { connection, ...ANALYSIS })).toEqual(notOffered(NO_DECLARATIONS));
    expect(await post("statement/analyze", { connection: connectionOf(NOSQL), ...ANALYSIS })).toEqual(
      notOffered(NO_SQL_TEXT),
    );
    // The analysis reads its fields before the record's offer, as before the provider is built.
    expect(await post("statement/analyze", { connection, text: 1 })).toEqual({
      status: 400,
      body: { error: "text must be a string" },
    });

    // Nothing opened, and no route answered 501.
    expect([names(seen), names(nosql)]).toEqual([[], []]);
  });

  test("provider-meta answers a package engine from its record", async () => {
    const seen = hooksFor(MODELLED);
    const plain = hooksFor(REST);
    const before = factory.getProviderCacheStats().size;

    expect(await post("provider-meta", { connection: connectionOf(MODELLED) })).toEqual({
      status: 200,
      body: { engine: { id: MODELLED, displayName: expect.any(String) }, objectModel: DECLARED_MODEL },
    });
    expect(await post("provider-meta", connectionOf(REST))).toEqual({
      status: 200,
      body: { engine: { id: REST, displayName: expect.any(String) }, objectModel: null },
    });
    // The record's body is read without opening a session or keeping a cache entry.
    expect([names(seen), names(plain), factory.getProviderCacheStats().size]).toEqual([[], [], before]);
  });

  test("provider-meta refuses a package engine's connection that core's open check refuses, by name, before anything is answered", async () => {
    const seen = hooksFor(REST);
    const cases: [Record<string, unknown>, string][] = [
      [
        { sshTunnel: { enabled: true, host: "b", port: 22, username: "u", authMethod: "password" } },
        "This LibreDB Studio opens no SSH tunnel for an engine of a provider package, so it does not open this connection. Turn the tunnel off.",
      ],
      [
        { readOnly: true },
        `readOnly: true is refused for ${REST}: its provider package's engine does not enforce a read-only mode in this LibreDB Studio, so the connection would open able to write. Remove readOnly from the connection, or connect with a database role that cannot write.`,
      ],
    ];
    for (const [fields, sentence] of cases) {
      const answer = await post("provider-meta", { connection: { ...connectionOf(REST), ...fields } });
      expect(answer).toEqual({
        status: 400,
        body: expect.objectContaining({ error: sentence, code: "CONFIG_ERROR", outcome: "not-sent" }),
      });
    }
    expect(names(seen)).toEqual([]);
  });
});

describe("the cancel and disconnect routes on a provider package's engine under governance", () => {
  const ISSUER = "https://idp.example.com/realms/libredb";
  const user = (name: string) => ({
    role: "user",
    username: `${name}@example.com`,
    idpSubject: `${name}-subject`,
    idpIssuer: ISSUER,
    iat: 1_700_000_000,
  });
  const ALICE = user("alice");
  const BOB = user("bob");
  /** One governed connection of the package's engine, the same write grant to both users. */
  const SHOP = admittedConnection("shop", {
    write: true,
    extra: { type: GOVERNED, environment: "development" } as never,
  });
  let savedSource: string | undefined;
  beforeAll(() => {
    savedSource = process.env.GOVERNANCE_SOURCE;
    process.env.GOVERNANCE_SOURCE = "postgres";
    recordGovernanceSnapshot(
      grantedSnapshot(
        [SHOP],
        [ALICE, BOB].map((user) => ({ subject: user.idpSubject, connection: SHOP, level: "write" as const })),
      ),
    );
  });
  afterAll(async () => {
    await factory.clearProviderCache();
    resetGovernanceState();
    if (savedSource === undefined) delete process.env.GOVERNANCE_SOURCE;
    else process.env.GOVERNANCE_SOURCE = savedSource;
    caller = { role: "admin", username: "admin", iat: 1_700_000_000 };
  });

  /** The actions of the transaction calls `seen` recorded on the session `handle` names. */
  const transactionCallsOf = (seen: Seen, handle: unknown) =>
    callsNamed(seen, "transaction")
      .filter(({ args }) => args[0] === handle)
      .map(({ args }) => (args[1] as TransactionRequest).action);

  /** `route`'s answer to `body` sent as `user`. */
  const as = (user: Record<string, unknown>, route: string, body: Record<string, unknown>) => {
    caller = user;
    return post(route, { connectionId: "seed:shop", ...body });
  };

  test("under governance a package engine's transaction is rolled back through its own session when its owner's credential changed", async () => {
    const handles: unknown[] = [];
    const seen = hooksFor(GOVERNED, {
      open: () => {
        const handle = { session: randomUUID() };
        handles.push(handle);
        return Promise.resolve({ handle });
      },
    });
    const regrant = (aliceLevel: "read" | "write") =>
      recordGovernanceSnapshot(
        grantedSnapshot(
          [SHOP],
          [
            { subject: ALICE.idpSubject, connection: SHOP, level: aliceLevel },
            { subject: BOB.idpSubject, connection: SHOP, level: "write" as const },
          ],
        ),
      );
    try {
      expect((await as(ALICE, "transaction", { action: "begin" })).status).toBe(200);
      const [writeSession] = handles;

      // Her grant is now read: her next request resolves the read credential's session, and her transaction is
      // rolled back on the session it began on.
      regrant("read");
      const answer = await as(ALICE, "transaction", { action: "status" });
      expect(answer).toMatchObject({
        status: 409,
        body: { code: "TRANSACTION_CREDENTIAL_CHANGED", rolledBack: true },
      });
      expect(transactionCallsOf(seen, writeSession)).toEqual(["state", "begin", "state", "rollback"]);
      // The rollback opened nothing: the read credential's session is opened by her next request only.
      expect(handles).toHaveLength(1);

      // A rollback the package fails is answered unconfirmed, its failure logged once as the package's through the scrub
      // of the credential the transaction began on, which this request no longer resolves, and the route's own line
      // carries no second copy of it.
      regrant("write");
      hooksFor(GOVERNED, {
        open: () => Promise.reject(new Error("the write credential's session is still cached")),
        transaction: (request) =>
          request.action === "rollback"
            ? Promise.reject(new Error(`the rollback failed as ${WRITE_CREDENTIAL.password}`))
            : undefined,
      });
      expect((await as(ALICE, "transaction", { action: "begin" })).status).toBe(200);
      regrant("read");
      const lines = loggedLines();
      expect(await as(ALICE, "transaction", { action: "status" })).toMatchObject({
        status: 409,
        body: { code: "TRANSACTION_CREDENTIAL_CHANGED", rolledBack: false },
      });
      // This file records no query event (no governance instance id), which the sink logs on its own line.
      const logged = lines().filter(([message]) => !message.startsWith("Query event not recorded"));
      expect(logged).toEqual([
        ["A provider package's transaction failed", withheldErrorMessage("Error")],
        ["A transaction whose credential changed was released without a confirmed rollback", "null"],
      ]);
      expect(JSON.stringify(logged)).not.toContain(WRITE_CREDENTIAL.password);
    } finally {
      regrant("write");
      await factory.clearProviderCache();
    }
  });

  test("under governance a second user's cancel opens that user's own session and cancels nothing of the first's, and a disconnect closes the caller's sessions only", async () => {
    let started!: () => void;
    const executing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    let aliceHandle: unknown;
    const seen = hooksFor(GOVERNED, {
      execute: () => {
        started();
        return new Promise((resolve) => {
          release = () => resolve(ROWS());
        });
      },
      // The cancel stops the run only on the session that runs it.
      cancel: (_request, handle) => {
        if (handle !== aliceHandle) return Promise.resolve({ cancelled: false });
        release();
        return Promise.resolve({ cancelled: true });
      },
    });
    const queryId = randomUUID();
    const aliceRun = as(ALICE, "query", { sql: "SELECT 1", queryId });
    await executing;
    aliceHandle = callsNamed(seen, "execute")[0]?.args[0];

    // Bob naming Alice's run id opens his own session and stops nothing.
    expect(await as(BOB, "cancel", { queryId })).toEqual({ status: 200, body: { cancelled: false } });
    expect(callsNamed(seen, "open")).toHaveLength(2);
    expect(callsNamed(seen, "cancel").map(({ args }) => args[0] === aliceHandle)).toEqual([false]);

    // Bob's disconnect closes his session and nothing of Alice's, whose run goes on.
    expect(await as(BOB, "disconnect", {})).toEqual({ status: 200, body: { success: true } });
    expect(callsNamed(seen, "close").map(({ args }) => args[0] === aliceHandle)).toEqual([false]);

    // Alice's own cancel reaches her run on her session.
    expect(await as(ALICE, "cancel", { queryId })).toEqual({ status: 200, body: { cancelled: true } });
    expect((await aliceRun).status).toBe(200);
    expect(callsNamed(seen, "cancel").map(({ args }) => args[0] === aliceHandle)).toEqual([false, true]);
    expect(callsNamed(seen, "open")).toHaveLength(2);
  });
});
