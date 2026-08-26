/**
 * libSQL Hrana HTTP transport (issue #424 Phase 5)
 *
 * globalThis.fetch is replaced per test and restored in afterEach. mock.module()
 * is deliberately not used: it is process-wide in bun, so mocking a module here
 * would poison every sibling test file sharing the process.
 *
 * Every envelope replayed below was captured verbatim on 2026-08-27 from BOTH
 * deployments - a self-hosted `ghcr.io/tursodatabase/libsql-server` (sqld 0.24.33,
 * SQLite 3.47.0) and a Turso Cloud database - including the shapes a hand-written
 * client gets wrong:
 *
 * - a failed statement answers HTTP **200** with the error inside `results[]`,
 * - an auth failure answers 401 (no token) or 400 (bad token) with a DIFFERENT
 *   envelope whose `error` is a bare string rather than `{ message, code }`,
 * - every integer arrives as a decimal STRING, so a naive read rounds a 64-bit
 *   rowid,
 * - `GET /version` exists on sqld and does not exist on Turso Cloud.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LibSQLHranaTransport } from "@/lib/db/providers/sql/libsql/hrana-transport";
import { LibSQLTransportError } from "@/lib/db/providers/sql/libsql/transport";
import type { DatabaseConnection, DatabaseType } from "@/lib/db/types";

// ============================================================================
// Harness
// ============================================================================

// The DatabaseType union gains "libsql" in the registration commit; the double
// assertion keeps this file compiling on either side of that change.
const LIBSQL: DatabaseType = "libsql" as unknown as DatabaseType;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];
let handler: (url: string, init?: RequestInit) => Response;

function respond(body: unknown, init: { status?: number } = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

/** The `ok` wrapper every successful pipeline step carries. */
function okStep(result: Record<string, unknown>): Record<string, unknown> {
  return { type: "ok", response: { type: "execute", result } };
}

/** A captured result for `SELECT name, type FROM sqlite_master`. */
function masterResult(): Record<string, unknown> {
  return {
    cols: [
      { name: "name", decltype: "TEXT" },
      { name: "type", decltype: "TEXT" },
    ],
    rows: [
      [
        { type: "text", value: "probe_customers" },
        { type: "text", value: "table" },
      ],
    ],
    affected_row_count: 0,
    last_insert_rowid: null,
    replication_index: "1",
    rows_read: 1,
    rows_written: 0,
    query_duration_ms: 0.107,
  };
}

function pipeline(...steps: Record<string, unknown>[]): Record<string, unknown> {
  return { baton: null, base_url: null, results: [...steps, { type: "ok", response: { type: "close" } }] };
}

function connection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "libsql-1",
    name: "libSQL probe",
    type: LIBSQL,
    host: "127.0.0.1",
    port: 18081,
    createdAt: new Date("2026-08-27T00:00:00.000Z"),
    ...overrides,
  };
}

function transport(overrides: Partial<DatabaseConnection> = {}): LibSQLHranaTransport {
  return new LibSQLHranaTransport(connection(overrides));
}

/** The parsed request body of the nth fetch call. */
function sentBody(index = 0): Record<string, unknown> {
  const raw = calls[index]?.init?.body;
  return JSON.parse(String(raw)) as Record<string, unknown>;
}

/** The `sql` of the first statement in the nth request. */
function sentSql(index = 0): string {
  const requests = sentBody(index).requests as { type: string; stmt?: { sql?: string } }[];
  return String(requests[0]?.stmt?.sql);
}

/** The `args` of the first statement in the nth request. */
function sentArgs(index = 0): Record<string, unknown>[] {
  const requests = sentBody(index).requests as { stmt?: { args?: Record<string, unknown>[] } }[];
  return requests[0]?.stmt?.args ?? [];
}

beforeEach(() => {
  calls = [];
  handler = () => respond(pipeline(okStep(masterResult())));
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(handler(String(input), init));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ============================================================================
// Endpoint
// ============================================================================

describe("LibSQLHranaTransport endpoint", () => {
  test("posts the pipeline to the plain-HTTP origin built from host and port", async () => {
    await transport().execute("SELECT 1");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:18081/v2/pipeline");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  test("uses https and the TLS default port when the connection carries ssl", async () => {
    await transport({
      host: "libredb-probe-424-cevheri.aws-eu-west-1.turso.io",
      port: undefined,
      ssl: { mode: "require" },
    }).execute("SELECT 1");

    expect(calls[0]?.url).toBe("https://libredb-probe-424-cevheri.aws-eu-west-1.turso.io:443/v2/pipeline");
  });

  test("brackets an IPv6 literal so the URL stays parseable", async () => {
    await transport({ host: "::1" }).execute("SELECT 1");

    expect(calls[0]?.url).toBe("http://[::1]:18081/v2/pipeline");
  });

  test("sends the auth token as a bearer credential", async () => {
    await transport({ password: "tok-123" }).execute("SELECT 1");

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok-123");
  });

  test("sends no authorization header at all when the connection carries no token", async () => {
    await transport().execute("SELECT 1");

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.has("authorization")).toBe(false);
  });
});

// ============================================================================
// Statements and results
// ============================================================================

describe("LibSQLHranaTransport execute", () => {
  test("closes the connection in the same pipeline as the statement", async () => {
    await transport().execute("SELECT 1");

    const requests = sentBody().requests as { type: string }[];
    expect(requests.map((r) => r.type)).toEqual(["execute", "close"]);
  });

  test("maps declared columns onto object rows and keeps the declared order", async () => {
    const result = await transport().execute("SELECT name, type FROM sqlite_master");

    expect(result.fieldNames).toEqual(["name", "type"]);
    expect(result.rows).toEqual([{ name: "probe_customers", type: "table" }]);
    expect(result.columnTypes).toEqual({ name: "TEXT", type: "TEXT" });
  });

  test("reports an engine that declared no column types as an empty record, not a guess", async () => {
    handler = () =>
      respond(
        pipeline(
          okStep({
            cols: [{ name: "v", decltype: null }],
            rows: [[{ type: "text", value: "3.47.0" }]],
            affected_row_count: 0,
            last_insert_rowid: null,
            rows_read: 0,
            rows_written: 0,
            query_duration_ms: 0.022,
          }),
        ),
      );

    const result = await transport().execute("SELECT sqlite_version() AS v");

    expect(result.columnTypes).toEqual({});
    expect(result.rows).toEqual([{ v: "3.47.0" }]);
  });

  test("carries the engine's own duration and affected-row count", async () => {
    handler = () =>
      respond(
        pipeline(
          okStep({
            cols: [],
            rows: [],
            affected_row_count: 2,
            last_insert_rowid: "7",
            rows_read: 1,
            rows_written: 2,
            query_duration_ms: 5.014,
          }),
        ),
      );

    const result = await transport().execute("INSERT INTO probe_customers(name) VALUES ('x')");

    expect(result.affectedRowCount).toBe(2);
    expect(result.lastInsertRowId).toBe(7);
    expect(result.executionTimeMs).toBe(5.014);
    expect(result.fieldNames).toEqual([]);
  });
});

// ============================================================================
// Value codec
// ============================================================================

describe("LibSQLHranaTransport value decoding", () => {
  function scalar(value: Record<string, unknown>): Promise<unknown> {
    handler = () =>
      respond(
        pipeline(
          okStep({
            cols: [{ name: "v", decltype: null }],
            rows: [[value]],
            affected_row_count: 0,
            last_insert_rowid: null,
            rows_read: 0,
            rows_written: 0,
            query_duration_ms: 0.01,
          }),
        ),
      );
    return transport()
      .execute("SELECT ? AS v")
      .then((r) => r.rows[0]?.v);
  }

  test("decodes an integer that fits a double as a number", async () => {
    expect(await scalar({ type: "integer", value: "2000" })).toBe(2000);
  });

  test("keeps an integer past 2^53 as its exact decimal string rather than rounding it", async () => {
    // 9007199254740993 is 2^53 + 1: the first integer a double cannot hold, and
    // Number() would silently answer 9007199254740992. A rounded id is a
    // corruption nothing downstream can detect (#460, Trino's own bigint lesson).
    expect(await scalar({ type: "integer", value: "9007199254740993" })).toBe("9007199254740993");
  });

  test("decodes a float as a number", async () => {
    expect(await scalar({ type: "float", value: 1.5 })).toBe(1.5);
  });

  test("decodes null", async () => {
    expect(await scalar({ type: "null" })).toBeNull();
  });

  test("decodes a blob from base64 into bytes", async () => {
    const decoded = await scalar({ type: "blob", base64: "AQID" });
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded as Uint8Array)).toEqual([1, 2, 3]);
  });

  test("passes an unrecognised value type through as null rather than inventing a reading", async () => {
    expect(await scalar({ type: "future-type", value: "x" })).toBeNull();
  });
});

describe("LibSQLHranaTransport parameter encoding", () => {
  test("encodes an integer parameter as a decimal string, the way the protocol requires", async () => {
    await transport().execute("SELECT ? AS a", { params: [7] });

    expect(sentArgs()).toEqual([{ type: "integer", value: "7" }]);
  });

  test("encodes a non-integral number as a float", async () => {
    await transport().execute("SELECT ? AS a", { params: [1.5] });

    expect(sentArgs()).toEqual([{ type: "float", value: 1.5 }]);
  });

  test("encodes a bigint parameter without going through a double", async () => {
    await transport().execute("SELECT ? AS a", { params: [BigInt("9007199254740993")] });

    expect(sentArgs()).toEqual([{ type: "integer", value: "9007199254740993" }]);
  });

  test("encodes text, null and undefined", async () => {
    await transport().execute("SELECT ?, ?, ?", { params: ["tr", null, undefined] });

    expect(sentArgs()).toEqual([{ type: "text", value: "tr" }, { type: "null" }, { type: "null" }]);
  });

  test("encodes a boolean as SQLite's own 1 and 0, which is what SQLite stores", async () => {
    await transport().execute("SELECT ?, ?", { params: [true, false] });

    expect(sentArgs()).toEqual([
      { type: "integer", value: "1" },
      { type: "integer", value: "0" },
    ]);
  });

  test("encodes bytes as base64", async () => {
    await transport().execute("SELECT ?", { params: [new Uint8Array([1, 2, 3])] });

    expect(sentArgs()).toEqual([{ type: "blob", base64: "AQID" }]);
  });

  test("encodes a Date as an ISO string, the only reading SQLite's date functions accept", async () => {
    await transport().execute("SELECT ?", { params: [new Date("2026-08-27T00:00:00.000Z")] });

    expect(sentArgs()).toEqual([{ type: "text", value: "2026-08-27T00:00:00.000Z" }]);
  });

  test("sends no args member when the statement has no parameters", async () => {
    await transport().execute("SELECT 1");

    const requests = sentBody().requests as { stmt?: Record<string, unknown> }[];
    expect(requests[0]?.stmt && "args" in requests[0].stmt).toBe(false);
  });
});

// ============================================================================
// Failure paths
// ============================================================================

describe("LibSQLHranaTransport failures", () => {
  test("a statement the engine rejected arrives as HTTP 200 and still raises the engine's message", async () => {
    // Captured verbatim from both deployments: the status is 200 and the failure
    // is inside the envelope, so `response.ok` is not the test.
    handler = () =>
      respond({
        baton: null,
        base_url: null,
        results: [
          { type: "error", error: { message: "SQLite error: no such table: no_such_table", code: "SQLITE_UNKNOWN" } },
          { type: "ok", response: { type: "close" } },
        ],
      });

    const failure = transport().execute("SELECT * FROM no_such_table");

    await expect(failure).rejects.toThrow("SQLite error: no such table: no_such_table");
    await expect(failure).rejects.toMatchObject({ status: 200, code: "SQLITE_UNKNOWN" });
  });

  test("a statement sqld refuses to parse carries the refusal wording of its own deployment", async () => {
    handler = () =>
      respond({
        baton: null,
        base_url: null,
        results: [
          {
            type: "error",
            error: {
              message: "SQL string could not be parsed: unsupported statement: VACUUM",
              code: "SQL_PARSE_ERROR",
            },
          },
        ],
      });

    await expect(transport().execute("VACUUM")).rejects.toMatchObject({ code: "SQL_PARSE_ERROR" });
  });

  test("Turso Cloud's different wording for the same refusal maps to the same code", async () => {
    handler = () =>
      respond({
        baton: null,
        base_url: null,
        results: [{ type: "error", error: { message: "SQL not allowed statement: VACUUM", code: "SQL_PARSE_ERROR" } }],
      });

    const failure = transport().execute("VACUUM");

    await expect(failure).rejects.toMatchObject({ code: "SQL_PARSE_ERROR" });
    await expect(failure).rejects.toThrow("SQL not allowed statement: VACUUM");
  });

  test("a missing token answers 401 with a bare string error and is reported as that", async () => {
    handler = () =>
      respond({ error: "Unauthorized: `unauthorized access attempt on database: empty JWT token`" }, { status: 401 });

    const failure = transport().execute("SELECT 1");

    await expect(failure).rejects.toBeInstanceOf(LibSQLTransportError);
    await expect(failure).rejects.toThrow(/empty JWT token/);
    await expect(failure).rejects.toMatchObject({ status: 401 });
  });

  test("a malformed token answers 400 rather than 401, and the status is passed through", async () => {
    handler = () => respond({ error: "JWT error: InvalidToken" }, { status: 400 });

    await expect(transport({ password: "notatoken" }).execute("SELECT 1")).rejects.toMatchObject({
      status: 400,
    });
  });

  test("a body that is not a libSQL envelope is reported as such rather than parsed further", async () => {
    handler = () => respond("<html>proxy</html>");

    await expect(transport().execute("SELECT 1")).rejects.toThrow(/not a libSQL answer/);
  });

  test("an envelope with no results at all is reported rather than read as an empty success", async () => {
    handler = () => respond({ baton: null, base_url: null, results: [] });

    await expect(transport().execute("SELECT 1")).rejects.toThrow(/no result/);
  });

  test("a request that never reached a server is reported with status 0", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch;

    const failure = transport().execute("SELECT 1");

    await expect(failure).rejects.toMatchObject({ status: 0 });
    await expect(failure).rejects.toThrow(/connect ECONNREFUSED/);
  });
});

// ============================================================================
// Server version
// ============================================================================

describe("LibSQLHranaTransport serverVersion", () => {
  test("reads the version sqld publishes as plain text", async () => {
    handler = (url) =>
      url.endsWith("/version")
        ? new Response("sqld 0.24.33 (f8fb14f3 2026-08-11)", { status: 200 })
        : respond(pipeline(okStep(masterResult())));

    expect(await transport().serverVersion()).toBe("sqld 0.24.33 (f8fb14f3 2026-08-11)");
  });

  test("answers null on Turso Cloud, where the route does not exist", async () => {
    // Measured 2026-08-27: `{"error":"route not found: [\"version\"]"}` with a
    // non-2xx status. A deployment that publishes no version is not a failed
    // connection, so this is null rather than a throw (#477's absence rule).
    handler = () => respond({ error: 'route not found: ["version"]' }, { status: 404 });

    expect(await transport().serverVersion()).toBeNull();
  });

  test("answers null when the version route cannot be reached at all", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("socket hang up"))) as unknown as typeof fetch;

    expect(await transport().serverVersion()).toBeNull();
  });

  test("answers null rather than an empty string when the route answers nothing", async () => {
    handler = () => new Response("   ", { status: 200 });

    expect(await transport().serverVersion()).toBeNull();
  });
});

describe("LibSQLHranaTransport close", () => {
  test("is a no-op that issues no request, because every pipeline closes itself", async () => {
    const t = transport();
    await t.execute("SELECT 1");
    await t.close();

    expect(calls).toHaveLength(1);
  });

  test("declares the transport kind", () => {
    expect(transport().kind).toBe("hrana-http");
  });
});

// ============================================================================
// Shapes a proxy or a future protocol version can produce
// ----------------------------------------------------------------------------
// Everything below is a guard rather than a captured reading: the protocol is
// free to change and a reverse proxy is free to mangle, and each of these is a
// branch that would otherwise be reached first in production.
// ============================================================================

describe("LibSQLHranaTransport tolerances", () => {
  function withResult(result: Record<string, unknown>): void {
    handler = () => respond(pipeline(okStep(result)));
  }

  test("aborts a statement that outruns its timeout", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      // The signal is what carries the timeout; asserting on its presence is the
      // only way to tell a real deadline from an unbounded request.
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(respond(pipeline(okStep(masterResult()))));
    }) as unknown as typeof fetch;

    await transport().execute("SELECT 1", { timeoutMs: 250 });
  });

  test("names a column the engine left unnamed by its position rather than dropping it", async () => {
    withResult({
      cols: [{ decltype: null }, { name: "", decltype: "TEXT" }],
      rows: [
        [
          { type: "integer", value: "1" },
          { type: "text", value: "x" },
        ],
      ],
      affected_row_count: 0,
      last_insert_rowid: null,
      query_duration_ms: 0.01,
    });

    const result = await transport().execute("SELECT 1, 'x'");

    expect(result.fieldNames).toEqual(["column_1", "column_2"]);
    expect(result.rows).toEqual([{ column_1: 1, column_2: "x" }]);
    // The empty name is not a declared type either: the second column's TEXT
    // lands under the positional name, never under "".
    expect(result.columnTypes).toEqual({ column_2: "TEXT" });
  });

  test("reads a column declaration that is not a list as no columns at all", async () => {
    withResult({ cols: null, rows: null, affected_row_count: null, query_duration_ms: null });

    const result = await transport().execute("SELECT 1");

    expect(result).toMatchObject({ fieldNames: [], rows: [], affectedRowCount: 0, executionTimeMs: 0 });
  });

  test("reads a row that is not a list as a row of nulls, keeping the column count", async () => {
    withResult({
      cols: [{ name: "a" }, { name: "b" }],
      rows: [null],
      affected_row_count: 0,
      query_duration_ms: 0,
    });

    expect((await transport().execute("SELECT a, b FROM t")).rows).toEqual([{ a: null, b: null }]);
  });

  test("decodes a float the protocol quoted, and a text value it did not", async () => {
    withResult({
      cols: [{ name: "f" }, { name: "t" }, { name: "u" }],
      rows: [[{ type: "float", value: "2.5" }, { type: "text", value: 7 }, { type: "text" }]],
      affected_row_count: 0,
      query_duration_ms: 0,
    });

    expect((await transport().execute("SELECT 1")).rows[0]).toEqual({ f: 2.5, t: "7", u: "" });
  });

  test("decodes a value that is not an object at all as null", async () => {
    withResult({
      cols: [{ name: "v" }],
      rows: [["bare"]],
      affected_row_count: 0,
      query_duration_ms: 0,
    });

    expect((await transport().execute("SELECT 1")).rows[0]).toEqual({ v: null });
  });

  test("decodes an integer sent as a number, and one sent as an unsafe number, without rounding silently", async () => {
    withResult({
      cols: [{ name: "safe" }, { name: "wide" }, { name: "blank" }, { name: "junk" }],
      rows: [
        [
          { type: "integer", value: 2000 },
          // Computed rather than written as a literal: a source literal that wide is
          // a lint error, and JSON.parse would have rounded it here anyway - which is
          // exactly the shape this row is about, an UNQUOTED integer past 2^53 that
          // arrived already rounded and must not be rounded twice or silently kept.
          { type: "integer", value: Number("9007199254740993") },
          { type: "integer", value: "  " },
          { type: "integer", value: "not-a-number" },
        ],
      ],
      affected_row_count: 0,
      query_duration_ms: 0,
    });

    // The third and fourth are absences rather than zeros: a value this layer
    // cannot read must not become a number a reader would trust.
    expect((await transport().execute("SELECT 1")).rows[0]).toEqual({
      safe: 2000,
      wide: "9007199254740992",
      blank: null,
      junk: null,
    });
  });

  test("decodes a blob whose base64 is missing as null rather than as empty bytes", async () => {
    withResult({
      cols: [{ name: "b" }],
      rows: [[{ type: "blob" }]],
      affected_row_count: 0,
      query_duration_ms: 0,
    });

    expect((await transport().execute("SELECT 1")).rows[0]).toEqual({ b: null });
  });

  test("carries a rowid too wide for a double as its exact decimal string", async () => {
    withResult({
      cols: [],
      rows: [],
      affected_row_count: 1,
      last_insert_rowid: "9007199254740993",
      query_duration_ms: 0.4,
    });

    expect((await transport().execute("INSERT INTO t VALUES (1)")).lastInsertRowId).toBe("9007199254740993");
  });

  test("reports the nested error shape a non-2xx response may carry", async () => {
    handler = () =>
      respond({ error: { message: "namespace not found", code: "NAMESPACE_NOT_FOUND" } }, { status: 404 });

    const failure = transport().execute("SELECT 1");

    await expect(failure).rejects.toThrow("namespace not found");
    await expect(failure).rejects.toMatchObject({ status: 404, code: "NAMESPACE_NOT_FOUND" });
  });

  test("falls back to the status when a non-2xx response carries no body", async () => {
    handler = () => new Response("", { status: 502 });

    await expect(transport().execute("SELECT 1")).rejects.toThrow("HTTP 502");
  });

  test("falls back to the raw body when a non-2xx response is not JSON at all", async () => {
    handler = () => new Response("<html>502 Bad Gateway</html>", { status: 502 });

    await expect(transport().execute("SELECT 1")).rejects.toThrow("<html>502 Bad Gateway</html>");
  });

  test("reports a statement error the engine sent without a message", async () => {
    handler = () => respond({ baton: null, results: [{ type: "error", error: {} }] });

    const failure = transport().execute("SELECT 1");

    await expect(failure).rejects.toThrow("the statement failed");
    await expect(failure).rejects.toMatchObject({ code: null });
  });

  test("reports a step that is not an object as no result", async () => {
    handler = () => respond({ baton: null, results: [null] });

    await expect(transport().execute("SELECT 1")).rejects.toThrow(/no result/);
  });

  test("reads a success whose result member is missing as an empty result", async () => {
    handler = () => respond({ baton: null, results: [{ type: "ok", response: { type: "execute" } }] });

    expect(await transport().execute("SELECT 1")).toMatchObject({ rows: [], fieldNames: [] });
  });

  test("sends the token on the version route as well, since a private database refuses it otherwise", async () => {
    handler = (url) => (url.endsWith("/version") ? new Response("sqld 0.24.33", { status: 200 }) : respond(pipeline()));

    await transport({ password: "tok-123" }).serverVersion();

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok-123");
  });
});

// ============================================================================
// Batches
// ----------------------------------------------------------------------------
// Captured 2026-08-27 on sqld 0.24.33: a pipeline whose SECOND statement fails
// still runs the third, and every step carries its own outcome. That measurement
// is the reason executeBatch hands failures back individually.
// ============================================================================

describe("LibSQLHranaTransport executeBatch", () => {
  function scalarStep(value: string): Record<string, unknown> {
    return okStep({
      cols: [{ name: "a", decltype: null }],
      rows: [[{ type: "integer", value }]],
      affected_row_count: 0,
      last_insert_rowid: null,
      query_duration_ms: 0.01,
    });
  }

  test("sends every statement in one request and closes once", async () => {
    handler = () => respond(pipeline(scalarStep("1"), scalarStep("2")));

    const outcomes = await transport().executeBatch([{ sql: "SELECT 1 AS a" }, { sql: "SELECT 2 AS a" }]);

    expect(calls).toHaveLength(1);
    const requests = sentBody().requests as { type: string }[];
    expect(requests.map((r) => r.type)).toEqual(["execute", "execute", "close"]);
    expect(outcomes.map((o) => (o.ok ? o.result.rows[0]?.a : null))).toEqual([1, 2]);
  });

  test("a failing statement costs its own outcome and nothing else", async () => {
    handler = () =>
      respond({
        baton: null,
        base_url: null,
        results: [
          scalarStep("1"),
          { type: "error", error: { message: "SQLite error: no such table: nope", code: "SQLITE_UNKNOWN" } },
          scalarStep("3"),
          { type: "ok", response: { type: "close" } },
        ],
      });

    const outcomes = await transport().executeBatch([
      { sql: "SELECT 1 AS a" },
      { sql: "SELECT * FROM nope" },
      { sql: "SELECT 3 AS a" },
    ]);

    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true]);
    expect(outcomes[1]).toMatchObject({ ok: false });
    if (!outcomes[1]?.ok) {
      expect(outcomes[1]?.error).toBeInstanceOf(LibSQLTransportError);
      expect(outcomes[1]?.error.message).toContain("no such table: nope");
      expect(outcomes[1]?.error.code).toBe("SQLITE_UNKNOWN");
    }
  });

  test("binds each statement's own parameters", async () => {
    handler = () => respond(pipeline(scalarStep("1"), scalarStep("2")));

    await transport().executeBatch([
      { sql: "SELECT ? AS a", params: [1] },
      { sql: "SELECT ? AS a", params: ["tr"] },
    ]);

    const requests = sentBody().requests as { stmt?: { args?: unknown[] } }[];
    expect(requests[0]?.stmt?.args).toEqual([{ type: "integer", value: "1" }]);
    expect(requests[1]?.stmt?.args).toEqual([{ type: "text", value: "tr" }]);
  });

  test("answers an empty list without touching the network", async () => {
    expect(await transport().executeBatch([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("reports a step the server never sent as that statement's own failure", async () => {
    // A pipeline answered with fewer results than it carried statements: the
    // missing ones become failures of their own rather than shifting every later
    // result onto the wrong statement.
    handler = () => respond({ baton: null, base_url: null, results: [scalarStep("1")] });

    const outcomes = await transport().executeBatch([{ sql: "SELECT 1 AS a" }, { sql: "SELECT 2 AS a" }]);

    expect(outcomes.map((o) => o.ok)).toEqual([true, false]);
    if (!outcomes[1]?.ok) expect(outcomes[1]?.error.message).toMatch(/no result/);
  });

  test("a transport failure fails the whole batch, because no statement ran", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch;

    await expect(transport().executeBatch([{ sql: "SELECT 1" }])).rejects.toMatchObject({ status: 0 });
  });

  test("a body that is not an envelope fails the whole batch rather than each statement", async () => {
    handler = () => respond("<html>proxy</html>");

    await expect(transport().executeBatch([{ sql: "SELECT 1" }])).rejects.toThrow(/not a libSQL answer/);
  });
});
