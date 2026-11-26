/**
 * `POST /api/db/query` on an engine an admitted provider package serves (`runEditorQuery` in src/lib/api/editor-query.ts),
 * through the real `resolveServedConnection`, the provider factory's real editor cache, the real confirmation gate and
 * the real host core: the statement is read under the grammar the package declares, with every claim that loosens the
 * gate uncounted; the session opens once per key through the package; the run answers the package's rows keyed by
 * column name; a request field the package does not honour, and one the route does not serve for such an engine, is
 * refused before any call; a caller that leaves sends the package's cancel; and a package's own words never reach the
 * client.
 *
 * The packages are written into a scratch providers directory and admitted by Studio's boot admission
 * (tests/helpers/package-session-fixture.ts); each function calls the hook a case sets. Only `@/lib/auth` is mocked.
 * Nothing awaits a timer: the cancel case waits on a promise the package's execute resolves when it starts, and on one
 * its cancel resolves.
 */
// oxlint-disable no-await-in-loop -- each post runs after the one before, on one rate limiter cleared per post.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { consoleTextByteLimit } from "@/lib/db/destructive-commands";
import { type EngineRecord, forgetServerCatalog, installServerCatalog } from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { logger } from "@/lib/logger";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { installHostCore } from "@/lib/provider-host/instance";
import { parseResponseJSON } from "../../helpers/mock-next";
import { admitSessionPackages, setHooks } from "../../helpers/package-session-fixture";
import { removeScratch, scratchDirectory } from "../../helpers/provider-artifacts";

const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => ({ role: "admin", username: "admin", iat: 1_700_000_000 })),
  readSession: mock(async () => ({
    kind: "authenticated",
    session: { role: "admin", username: "admin", iat: 1_700_000_000 },
  })),
}));

const { POST } = await import("@/app/api/db/query/route");
const { clearProviderCache } = await import("@/lib/db/factory");

const MAIN = "acmeqmain";
const BARE = "acmeqbare";
const LOOSE = "acmeqloose";
const providers = scratchDirectory("studio-query-package-");
let engines: Map<string, EngineRecord>;

beforeAll(async () => {
  installHostCore(createHostCore(), "test");
  engines = await admitSessionPackages(providers, [
    { name: "acme-q-main", engine: MAIN, offered: ["console.cancel"] },
    { name: "acme-q-bare", engine: BARE },
    {
      name: "acme-q-loose",
      engine: LOOSE,
      // Two claims that would loosen the gate, which Studio's review record lists for no engine it does not ship.
      edit: (engine) => {
        const sqlText = engine.sqlText as { readsSqlText: boolean; grammar: { confirmExemptForms: string[][] } };
        sqlText.readsSqlText = false;
        sqlText.grammar.confirmExemptForms = [["ALTER", "SESSION", "SET"]];
      },
    },
  ]);
});
afterAll(async () => {
  await clearProviderCache();
  removeScratch(providers);
});

/** What one package's hooks saw, by call name, with each call's arguments. */
interface Seen {
  readonly calls: { name: string; args: unknown[] }[];
}

const COLUMNS = [{ name: "key" }, { name: "value", type: "text" }];

/** A result source answering `rows` under `COLUMNS`, in batches no larger than the pump asks for. */
function source(rows: unknown[][]) {
  let at = 0;
  return {
    columns: COLUMNS,
    next: (limit: { maxRows: number }) => {
      const batch = rows.slice(at, at + limit.maxRows);
      at += batch.length;
      return Promise.resolve({ rows: batch, done: at >= rows.length });
    },
    close: () => Promise.resolve(),
  };
}

/** Hooks for `engine`'s package that open, answer `rows` to every execute and close; `execute` replaces the answer. */
function hooksFor(
  engine: string,
  options: { execute?: (...args: unknown[]) => Promise<unknown>; cancel?: (...args: unknown[]) => unknown } = {},
): Seen {
  const seen: Seen = { calls: [] };
  const push =
    (name: string, answer: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      seen.calls.push({ name, args });
      return answer(...args);
    };
  setHooks(engine, {
    open: push("open", () => Promise.resolve({ handle: { session: randomUUID() } })),
    close: push("close", () => Promise.resolve()),
    health: push("health", () => Promise.resolve({})),
    execute: push(
      "execute",
      options.execute ??
        (() =>
          Promise.resolve({
            results: [
              source([
                ["alpha", 1],
                ["beta", "two"],
              ]),
            ],
            warnings: [],
            executionTimeMs: 3,
            pageApplied: false,
          })),
    ),
    cancel: push("cancel", options.cancel ?? (() => Promise.resolve({ cancelled: true }))),
  });
  return seen;
}

/** The names of the calls `seen` recorded. */
const names = (seen: Seen) => seen.calls.map(({ name }) => name);

/** A connection of `engine` with its own id and a generated secret. */
function connectionOf(engine: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `conn-${randomUUID()}`,
    name: "Keys",
    type: engine,
    host: "kv.local",
    password: randomUUID(),
    ...fields,
  };
}

/** The route's status and body for `body`, under `signal` when given. */
async function post(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ status: number; body: Record<string, unknown> }> {
  clearRateLimitState();
  const response = await POST(
    new Request("http://localhost:3000/api/db/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    }) as never,
  );
  return { status: response.status, body: await parseResponseJSON<Record<string, unknown>>(response) };
}

beforeEach(() => {
  delete process.env.LIBREDB_RUN_CONFIRMATION;
});

describe("POST /api/db/query on an engine a provider package serves", () => {
  test("a query on an admitted engine answers the package's rows through the host core", async () => {
    const seen = hooksFor(MAIN);
    const { status, body } = await post({ connection: connectionOf(MAIN), sql: "SELECT 1", options: { limit: 5 } });
    expect(status).toBe(200);
    expect(body).toEqual({
      rows: [
        { key: "alpha", value: 1 },
        { key: "beta", value: "two" },
      ],
      fields: ["key", "value"],
      columnTypes: { value: "text" },
      rowCount: 2,
      executionTime: 3,
      pagination: { limit: 5, offset: 0, hasMore: false, totalReturned: 2, wasLimited: false },
    });
    expect(names(seen)).toEqual(["open", "execute"]);
    expect(seen.calls[1]?.args[1]).toEqual({ statement: "SELECT 1", page: { limit: 6, offset: 0 } });
  });

  test("the statement is read under the package's declared grammar, and a write asks for a confirmation", async () => {
    const seen = hooksFor(MAIN);
    const connection = connectionOf(MAIN);
    const asked = await post({ connection, sql: "DELETE FROM t", confirmation: "ask" });
    expect(asked.status).toBe(428);
    expect(asked.body).toMatchObject({ code: "CONFIRMATION_REQUIRED", confirmation: { typedConfirmation: null } });
    expect(names(seen)).toEqual([]);
    const token = (asked.body.confirmation as { token: string }).token;
    const confirmed = await post({ connection, sql: "DELETE FROM t", confirmation: { token } });
    expect(confirmed.status).toBe(200);
    expect(names(seen)).toEqual(["open", "execute"]);

    // The minimal manifest declares that EXPLAIN never executes; the gate reads the claim both ways, so an analyzed
    // write asks, and nothing is opened before the confirmation.
    const analyzed = await post({ connection, sql: "EXPLAIN ANALYZE DELETE FROM t", confirmation: "ask" });
    expect(analyzed.status).toBe(428);
    expect(names(seen)).toEqual(["open", "execute"]);

    // A declaration that claims its text is not SQL and exempts a form: neither claim is counted.
    const loose = hooksFor(LOOSE);
    for (const sql of ["ALTER SESSION SET x = 1", "DELETE FROM t", "SELECT 1; DROP TABLE x"]) {
      const answer = await post({ connection: connectionOf(LOOSE), sql, confirmation: "ask" });
      expect([sql, answer.status]).toEqual([sql, 428]);
    }
    expect((await post({ connection: connectionOf(LOOSE), sql: "SELECT 1", confirmation: "ask" })).status).toBe(200);
    expect(names(loose)).toEqual(["open", "execute"]);
  });

  test("bound params and an offset the package does not honour are refused before the call, not-sent", async () => {
    const seen = hooksFor(MAIN);
    const connection = connectionOf(MAIN);
    const params = await post({ connection, sql: "SELECT 1", params: [1] });
    expect([params.status, params.body.code, params.body.outcome, params.body.error]).toEqual([
      400,
      "FACET_NOT_OFFERED",
      "not-sent",
      "This connection's provider package takes no bound parameters, so Studio sent nothing.",
    ]);
    const offset = await post({ connection, sql: "SELECT 1", options: { limit: 2, offset: 2 } });
    expect([offset.status, offset.body.outcome, offset.body.error]).toEqual([
      400,
      "not-sent",
      "This connection's provider package does not take an offset, so Studio asks for no page after the first.",
    ]);
    expect(names(seen)).toEqual(["open"]);
  });

  test("a query whose caller leaves sends the package's cancel through the host core", async () => {
    for (const engine of [MAIN, BARE]) {
      let started!: () => void;
      const executing = new Promise<void>((resolve) => {
        started = resolve;
      });
      let settle!: (error: unknown) => void;
      let cancelled!: () => void;
      const cancelSent = new Promise<void>((resolve) => {
        cancelled = resolve;
      });
      const seen = hooksFor(engine, {
        execute: () => {
          started();
          return new Promise((_resolve, reject) => {
            settle = reject;
          });
        },
        cancel: () => {
          cancelled();
          return Promise.resolve({ cancelled: true });
        },
      });
      const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        const queryId = randomUUID();
        const controller = new AbortController();
        const answer = post(
          { connection: connectionOf(engine), sql: "SELECT pg_sleep(60)", queryId },
          controller.signal,
        );
        await executing;
        controller.abort();
        const { status, body } = await answer;
        expect([status, body.code]).toEqual([499, "QUERY_CANCELLED"]);
        if (engine === MAIN) {
          await cancelSent;
          expect(seen.calls.filter(({ name }) => name === "cancel").map(({ args }) => args[1])).toEqual([
            { runId: queryId },
          ]);
        }
        settle(new Error("the run was cancelled"));
        // A package without console.cancel is sent no cancel: the run is reported still running.
        if (engine === BARE) expect(names(seen)).toEqual(["open", "execute"]);
      } finally {
        warn.mockRestore();
      }
    }
  });

  test("explain, database, catalog and unlimited are refused by name before any open", async () => {
    const seen = hooksFor(MAIN);
    const connection = connectionOf(MAIN);
    for (const [fields, field] of [
      [{ explain: { mode: "estimate" } }, "explain"],
      [{ database: 2 }, "database"],
      [{ catalog: "other" }, "catalog"],
      [{ options: { unlimited: true } }, "options.unlimited"],
    ] as const) {
      const { status, body } = await post({ connection, sql: "SELECT 1", ...fields });
      expect([status, body.code, body.error]).toEqual([
        501,
        "PACKAGE_ENGINE_UNSUPPORTED",
        `This LibreDB Studio does not serve ${field} in a query on an engine of a provider package yet.`,
      ]);
    }
    // A malformed field keeps its 400.
    for (const fields of [
      { explain: { mode: "plan" } },
      { database: -1 },
      { catalog: "" },
      { options: { limit: -1 } },
    ]) {
      expect((await post({ connection, sql: "SELECT 1", ...fields })).status).toBe(400);
    }
    expect(names(seen)).toEqual([]);
  });

  test("a field the record does not offer is refused by name with today's 501, after the malformed-field 400s", async () => {
    const seen = hooksFor(MAIN);
    const connection = connectionOf(MAIN);
    const answer = async (fields: Record<string, unknown>, onto: Record<string, unknown> = connection) => {
      const { status, body } = await post({ connection: onto, sql: "SELECT 1", ...fields });
      return { status, body };
    };
    // The package's record offers none of the four, each refused by the name the answer gives it.
    for (const [fields, field] of [
      [{ explain: { mode: "estimate" } }, "explain"],
      [{ database: 2 }, "database"],
      [{ catalog: "other" }, "catalog"],
      [{ options: { unlimited: true } }, "options.unlimited"],
    ] as const) {
      const { status, body } = await answer(fields);
      expect([field, status, body.code, body.error]).toEqual([
        field,
        501,
        "PACKAGE_ENGINE_UNSUPPORTED",
        `This LibreDB Studio does not serve ${field} in a query on an engine of a provider package yet.`,
      ]);
    }
    // Each malformed field answers its own 400 before any 501, alone and beside a field the record does not offer.
    const explain400 = { error: 'explain must be { "mode": "estimate" } or { "mode": "analyze" }' };
    const database400 = { error: '"database" must be a non-negative integer' };
    const catalog400 = {
      error: '"catalog" must be a non-empty string naming a database',
      code: "CONFIG_ERROR",
      statusCode: 400,
      kind: "config",
      outcome: "unknown",
    };
    for (const [fields, body] of [
      [{ explain: { mode: "plan" } }, explain400],
      [{ explain: { mode: "plan" }, database: 2 }, explain400],
      [{ database: -1 }, database400],
      [{ explain: { mode: "estimate" }, database: -1 }, database400],
      [{ catalog: "" }, catalog400],
      [{ explain: { mode: "estimate" }, catalog: "" }, catalog400],
      [{ options: { limit: -1 } }, { error: "options.limit must be a non-negative integer" }],
    ] as const) {
      expect([fields, await answer(fields)]).toEqual([fields, { status: 400, body }]);
    }
    expect(names(seen)).toEqual([]);

    // The package's record offers no console text bound: a text over the smallest bound a shipped engine declares runs.
    const bounds = EXTERNAL_DATABASE_TYPES.map((type) => consoleTextByteLimit(type)).filter(
      (bound): bound is number => bound !== undefined,
    );
    const over = `SELECT 1 -- ${"x".repeat(Math.min(...bounds))}`;
    expect((await post({ connection, sql: over })).status).toBe(200);
    expect(names(seen)).toEqual(["open", "execute"]);

    // A legacy engine's record offers all four, so none is refused by name: each answers as the engine answers it.
    const sqlite = { id: `conn-${randomUUID()}`, name: "Local", type: "sqlite", database: ":memory:" };
    const legacy = async (fields: Record<string, unknown>) => answer(fields, sqlite);
    expect(await legacy({ options: { unlimited: true } })).toMatchObject({
      status: 200,
      body: { rows: [{ "1": 1 }], pagination: { limit: 100_000, hasMore: false } },
    });
    expect(await legacy({ database: 2 })).toEqual({
      status: 400,
      body: {
        error:
          'sqlite declares no key-space walk: "database" names the database a key was walked in, and only an engine that needs such a name accepts it',
      },
    });
    expect(await legacy({ catalog: "other" })).toEqual({
      status: 400,
      body: {
        error: 'This sqlite connection runs every request in its own database and cannot run one in "other"',
        code: "CONFIG_ERROR",
        statusCode: 400,
        kind: "config",
        outcome: "unknown",
      },
    });
    expect(await legacy({ explain: { mode: "estimate" } })).toMatchObject({
      status: 200,
      body: {
        rows: [{ id: 1, parent: 0, notused: 0, detail: "SCAN CONSTANT ROW" }],
        fields: ["id", "parent", "notused", "detail"],
        explainFormat: "sqlite-queryplan",
      },
    });
  });

  test("a package's error answers Studio's sentence naming its code, and its words go to the log only", async () => {
    const connection = connectionOf(MAIN);
    const secret = connection.password as string;
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      hooksFor(MAIN, { execute: () => Promise.reject(new Error(`no such key, as ${secret} said`)) });
      const failed = await post({ connection, sql: "SELECT 1" });
      // A plain Error of Studio's: kind internal, outcome unknown, since the statement may have run.
      expect([failed.status, failed.body.code, failed.body.error]).toEqual([
        500,
        "INTERNAL_ERROR",
        "The provider package's execute failed (INTERNAL_ERROR); the server's log holds its words.",
      ]);

      // An open that fails is answered as a connection error, not-sent: nothing was sent.
      setHooks(MAIN, { open: () => Promise.reject(new Error(`refused ${secret}`)) });
      const refused = await post({ connection: connectionOf(MAIN, { password: secret }), sql: "SELECT 1" });
      expect([refused.status, refused.body.code, refused.body.outcome, refused.body.error]).toEqual([
        503,
        "CONNECTION_ERROR",
        "not-sent",
        "The provider package's open failed (INTERNAL_ERROR); the server's log holds its words.",
      ]);
      expect(JSON.stringify([failed.body, refused.body])).not.toContain(secret);
      // Each logged once, through core's scrub of the connection: the secret is withheld there too.
      // Each package error logged once, through core's scrub of the connection, so the secret is withheld there too;
      // the route's own line of the answer carries Studio's sentence.
      const packageLines = error.mock.calls.filter(([message]) => String(message).startsWith("A provider package's"));
      expect(packageLines.map(([message]) => message)).toEqual([
        "A provider package's execute failed",
        "A provider package's open failed",
      ]);
      expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(error.mock.calls)).not.toContain("no such key");
    } finally {
      error.mockRestore();
      hooksFor(MAIN);
    }
  });

  test("a package's warnings reach the client only as Studio's sentence with their count, each logged once through core's scrub", async () => {
    const connection = connectionOf(MAIN);
    const secret = connection.password as string;
    const words = `words the package wrote ${randomUUID()}`;
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      hooksFor(MAIN, {
        execute: () =>
          Promise.resolve({
            results: [source([["alpha", 1]])],
            warnings: [
              { message: `deprecated, as ${secret} said`, code: "W01", severity: "WARNING" },
              { message: words },
            ],
            executionTimeMs: 1,
            pageApplied: false,
          }),
      });
      const answered = await post({ connection, sql: "SELECT 1" });
      expect(answered.status).toBe(200);
      expect(answered.body.warnings).toEqual([
        { message: "The provider package returned 2 warnings; the server's log holds their words." },
      ]);
      expect(JSON.stringify(answered.body)).not.toContain(words);
      expect(JSON.stringify(answered.body)).not.toContain(secret);

      const lines = warn.mock.calls.filter(([message]) => String(message).startsWith("A provider package's"));
      expect(lines.map(([message]) => message)).toEqual([
        "A provider package's execute returned a warning",
        "A provider package's execute returned a warning",
      ]);
      expect(JSON.stringify(lines)).toContain(words);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    } finally {
      warn.mockRestore();
      hooksFor(MAIN);
    }
  });

  test("the session is opened once per key and reused by the next query", async () => {
    const seen = hooksFor(BARE);
    const connection = connectionOf(BARE);
    for (let run = 0; run < 3; run += 1) {
      expect((await post({ connection, sql: "SELECT 1" })).status).toBe(200);
    }
    expect(names(seen)).toEqual(["open", "execute", "execute", "execute"]);
  });

  test("a refused package's engine and an unknown type answer as the server catalog answers them", async () => {
    forgetServerCatalog();
    installServerCatalog({
      engines: new Map([...composeServerCatalog([], []).engines, ...engines]),
      unavailable: new Map([["acmeqgone", Object.freeze(["PROVIDER_LOAD_FAILED"])]]),
    });
    const gone = await post({ connection: connectionOf("acmeqgone"), sql: "SELECT 1" });
    expect([gone.status, gone.body.code]).toEqual([503, "PROVIDER_UNAVAILABLE"]);
    expect(String(gone.body.error)).toContain("(PROVIDER_LOAD_FAILED)");
    const unknown = await post({ connection: connectionOf("acmeqnone"), sql: "SELECT 1" });
    expect([unknown.status, unknown.body.code]).toEqual([400, "PROVIDER_UNKNOWN"]);
  });
});
