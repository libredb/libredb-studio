/**
 * ClickHouse HTTP transport (issue #264, design spec 1.1, 1.2, 2.1 and 2.2)
 *
 * globalThis.fetch is replaced per test and restored in afterEach. mock.module()
 * is deliberately not used: it is process-wide in bun, so mocking a module here
 * would poison every sibling test file sharing the process.
 *
 * Every response replayed below was captured verbatim from ClickHouse 26.7.1.1315
 * over its HTTP interface, including the shapes that look like bugs and are not:
 * an error body that is plain text under an `application/json` content type, a
 * successful write with no body at all, and a DDL response that carries no format
 * header. Those are the cases a hand-written envelope parser gets wrong, so they
 * are pinned here rather than assumed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ClickHouseHttpTransport } from "@/lib/db/providers/sql/clickhouse/http-transport";
import { CLICKHOUSE_UNKNOWN_ERROR_NAME, ClickHouseTransportError } from "@/lib/db/providers/sql/clickhouse/transport";
import type { DatabaseConnection, DatabaseType } from "@/lib/db/types";

// ============================================================================
// Harness
// ============================================================================

// The DatabaseType union gains "clickhouse" in the registration commit; the
// double assertion keeps this file compiling on either side of that change.
const CLICKHOUSE: DatabaseType = "clickhouse" as unknown as DatabaseType;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];
let handler: (url: string, init?: RequestInit) => Response;

/** A captured summary header: every value is a string, never a number (spec 2.2). */
function summaryHeader(overrides: Record<string, string> = {}): string {
  return JSON.stringify({ read_rows: "2", written_rows: "2", elapsed_ns: "58781261", ...overrides });
}

/** Headers a JSON-format 200 really carries. */
function jsonHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json; charset=UTF-8",
    "x-clickhouse-format": "JSON",
    "x-clickhouse-summary": summaryHeader(),
    ...overrides,
  };
}

function respond(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, { status: init.status ?? 200, headers: init.headers });
}

/**
 * `SELECT id, big FROM tx_probe LIMIT 1` as the server returned it: UInt64 quoted
 * because of `output_format_json_quote_64bit_integers` (spec 2.1), `statistics`
 * in seconds, and the `rows_before_limit_at_least` a LIMIT adds (spec 2.6).
 */
const SELECT_BODY = JSON.stringify({
  meta: [
    { name: "id", type: "Int32" },
    { name: "big", type: "UInt64" },
  ],
  data: [{ id: 1, big: "18446744073709551615" }],
  rows: 1,
  rows_before_limit_at_least: 2,
  statistics: { elapsed: 0.001164102, rows_read: 2, bytes_read: 12 },
});

function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "ch-1",
    name: "ClickHouse",
    type: CLICKHOUSE,
    host: "127.0.0.1",
    port: 18123,
    user: "libredb",
    password: "password123",
    database: "demo",
    createdAt: new Date(),
    ...overrides,
  };
}

function makeTransport(overrides: Partial<DatabaseConnection> = {}): ClickHouseHttpTransport {
  return new ClickHouseHttpTransport(makeConnection(overrides));
}

function lastCall(): FetchCall {
  const call = calls.at(-1);
  if (!call) throw new Error("no request was made");
  return call;
}

function lastUrl(): URL {
  return new URL(lastCall().url);
}

function lastParam(name: string): string | null {
  return lastUrl().searchParams.get(name);
}

function lastHeader(name: string): string | undefined {
  return (lastCall().init?.headers as Record<string, string> | undefined)?.[name];
}

/** The thrown ClickHouseTransportError, or a failed expectation if none was thrown. */
async function captureError(run: () => Promise<unknown>): Promise<ClickHouseTransportError> {
  try {
    await run();
  } catch (caught) {
    expect(caught).toBeInstanceOf(ClickHouseTransportError);
    return caught as ClickHouseTransportError;
  }
  throw new Error("the transport resolved where it should have thrown");
}

beforeEach(() => {
  calls = [];
  handler = () => respond(SELECT_BODY, { headers: jsonHeaders() });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ============================================================================
// The request
// ============================================================================

describe("ClickHouseHttpTransport request", () => {
  // Spec 1.2: the statement is the body of a POST to "/" and is never rewritten
  // to carry a FORMAT clause, so what the user typed is what the server parses.
  test("posts the statement verbatim as the body of a request to /", async () => {
    await makeTransport().query("SELECT id, big FROM tx_probe LIMIT 1");

    expect(lastCall().init?.method).toBe("POST");
    expect(lastCall().init?.body).toBe("SELECT id, big FROM tx_probe LIMIT 1");
    expect(lastUrl().pathname).toBe("/");
  });

  test("asks for the JSON envelope through default_format", async () => {
    await makeTransport().query("SELECT 1");

    expect(lastParam("default_format")).toBe("JSON");
  });

  // Spec 2.1: without this, `SELECT toUInt64(18446744073709551615)` arrives as an
  // unquoted JSON number and JSON.parse silently rounds it to ...552000.
  test("always quotes 64-bit integers so JSON.parse cannot round them", async () => {
    await makeTransport().query("SELECT toUInt64(18446744073709551615)");

    expect(lastParam("output_format_json_quote_64bit_integers")).toBe("1");
  });

  test("sends the connection's database as a URL parameter", async () => {
    await makeTransport().query("SELECT 1");

    expect(lastParam("database")).toBe("demo");
  });

  test("lets one statement target another database without rewriting its SQL", async () => {
    await makeTransport().query("SELECT 1", { database: "system" });

    expect(lastParam("database")).toBe("system");
  });

  test("omits the database parameter when the connection pins none", async () => {
    await makeTransport({ database: undefined }).query("SELECT 1");

    expect(lastParam("database")).toBeNull();
  });

  test("passes per-statement settings through as URL parameters", async () => {
    await makeTransport().query("SELECT 1", {
      settings: { max_execution_time: 5, allow_experimental_analyzer: true, log_comment: "probe" },
    });

    expect(lastParam("max_execution_time")).toBe("5");
    expect(lastParam("allow_experimental_analyzer")).toBe("true");
    expect(lastParam("log_comment")).toBe("probe");
  });

  // max_execution_time only bounds execution AFTER ClickHouse has accepted the
  // statement. A stalled DNS/TCP/TLS handshake, or a response body that never
  // finishes arriving, is not covered by it, so the deadline the provider
  // advertises has to be armed on the client too.
  test("arms a client-side deadline when one is given", async () => {
    await makeTransport().query("SELECT 1", { timeoutMs: 5000 });

    const signal = lastCall().init?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  test("sends no signal when no deadline is given", async () => {
    await makeTransport().query("SELECT 1");

    expect(lastCall().init?.signal).toBeUndefined();
  });

  test("reports a client-side timeout as a timeout, so the shared mapping classifies it", async () => {
    // src/lib/db/errors.ts keys on "timeout"/"timed out" in the message, and a
    // transport-level stall has no ClickHouse exception code to key on instead.
    handler = () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };

    const error = await captureError(() => makeTransport().query("SELECT 1", { timeoutMs: 5 }));

    expect(error.code).toBe(0);
    expect(error.message.toLowerCase()).toContain("timed out");
  });

  test("aborts the in-flight request once the deadline passes", async () => {
    // Proves the signal is live rather than merely attached: the handler waits on
    // it instead of answering.
    handler = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }) as unknown as Response;

    const error = await captureError(() => makeTransport().query("SELECT 1", { timeoutMs: 10 }));

    expect(error.message.toLowerCase()).toContain("timed out");
  });

  // The parser below assumes the envelope it asked for. A caller that could set
  // the format through settings would silently turn every result into raw text.
  test("does not let a setting hijack the response format", async () => {
    await makeTransport().query("SELECT 1", {
      settings: { default_format: "TSV", output_format_json_quote_64bit_integers: 0, database: "other" },
    });

    expect(lastParam("default_format")).toBe("JSON");
    expect(lastParam("output_format_json_quote_64bit_integers")).toBe("1");
    expect(lastParam("database")).toBe("demo");
  });

  test("authenticates with HTTP Basic", async () => {
    await makeTransport().query("SELECT 1");

    expect(lastHeader("authorization")).toBe(`Basic ${Buffer.from("libredb:password123").toString("base64")}`);
  });

  test("sends an empty password rather than dropping the header", async () => {
    await makeTransport({ password: undefined }).query("SELECT 1");

    expect(lastHeader("authorization")).toBe(`Basic ${Buffer.from("libredb:").toString("base64")}`);
  });

  // Live-verified: an empty Basic username is a hard failure - "Code: 516 ... Got
  // an empty user name from Authorization HTTP header" - whereas sending no
  // header at all resolves to the `default` user, which is what a stock local
  // install expects. So a connection without a user must send no header.
  test("sends no authorization header when the connection names no user", async () => {
    await makeTransport({ user: undefined }).query("SELECT 1");

    expect(lastHeader("authorization")).toBeUndefined();
  });
});

// ============================================================================
// The endpoint
// ============================================================================

describe("ClickHouseHttpTransport endpoint", () => {
  test("defaults to the documented HTTP port on localhost", async () => {
    await new ClickHouseHttpTransport({
      id: "ch-2",
      name: "ClickHouse",
      type: CLICKHOUSE,
      createdAt: new Date(),
    }).query("SELECT 1");

    expect(lastUrl().origin).toBe("http://localhost:8123");
  });

  test("uses the TLS port and scheme when the connection asks for SSL", async () => {
    await makeTransport({ port: undefined, ssl: { mode: "require" } }).query("SELECT 1");

    expect(lastUrl().origin).toBe("https://127.0.0.1:8443");
  });

  test("keeps plain HTTP when SSL is explicitly disabled", async () => {
    await makeTransport({ port: undefined, ssl: { mode: "disable" } }).query("SELECT 1");

    expect(lastUrl().origin).toBe("http://127.0.0.1:8123");
  });

  test("an explicit port wins over the scheme's default", async () => {
    await makeTransport({ port: 9000, ssl: { mode: "verify-full" } }).query("SELECT 1");

    expect(lastUrl().origin).toBe("https://127.0.0.1:9000");
  });

  // A bare IPv6 literal is not a legal URL authority, so it has to be bracketed
  // or the request never leaves the process.
  test("brackets a bare IPv6 host", async () => {
    await makeTransport({ host: "::1" }).query("SELECT 1");

    expect(lastUrl().origin).toBe("http://[::1]:18123");
  });

  test("leaves an already-bracketed IPv6 host alone", async () => {
    await makeTransport({ host: "[::1]" }).query("SELECT 1");

    expect(lastUrl().origin).toBe("http://[::1]:18123");
  });
});

// ============================================================================
// A tabular result
// ============================================================================

describe("ClickHouseHttpTransport JSON results", () => {
  test("describes the rows from meta, in the order the statement projected them", async () => {
    const result = await makeTransport().query("SELECT id, big FROM tx_probe LIMIT 1");

    expect(result.rows).toEqual([{ id: 1, big: "18446744073709551615" }]);
    expect(result.fieldNames).toEqual(["id", "big"]);
    expect(result.columnTypes).toEqual({ id: "Int32", big: "UInt64" });
    expect(result.rawText).toBeNull();
  });

  // Spec 1.7: the declared type is carried through untouched, wrappers included,
  // because the wrapper is what tells the user it is nullable or low-cardinality.
  test("carries declared types verbatim, wrappers and all", async () => {
    handler = () =>
      respond(
        JSON.stringify({
          meta: [
            { name: "a", type: "Nullable(String)" },
            { name: "b", type: "Map(String, UInt8)" },
            { name: "c", type: "Enum8('x' = 1, 'y' = 2)" },
            { name: "d", type: "LowCardinality(String)" },
          ],
          data: [],
        }),
        { headers: jsonHeaders() },
      );

    const result = await makeTransport().query("SELECT a, b, c, d FROM wrapped");

    expect(result.columnTypes).toEqual({
      a: "Nullable(String)",
      b: "Map(String, UInt8)",
      c: "Enum8('x' = 1, 'y' = 2)",
      d: "LowCardinality(String)",
    });
  });

  test("reports the mutation count and elapsed time the summary header carries", async () => {
    const result = await makeTransport().query("SELECT 1");

    expect(result.mutationCount).toBe(2);
    expect(result.executionTimeMs).toBeCloseTo(58.781261, 6);
  });

  // The header is the authority because it is present on every response; the
  // in-body statistics only exist on a JSON result. But a reverse proxy can drop
  // an unknown header, and losing the timing entirely is worse than reading the
  // body's own number.
  test("falls back to the envelope's own elapsed seconds when the header is missing", async () => {
    handler = () => respond(SELECT_BODY, { headers: jsonHeaders({ "x-clickhouse-summary": "" }) });

    const result = await makeTransport().query("SELECT 1");

    expect(result.executionTimeMs).toBeCloseTo(1.164102, 6);
    expect(result.mutationCount).toBe(0);
  });

  test("reports no elapsed time rather than a guess when neither source has one", async () => {
    handler = () => respond(JSON.stringify({ meta: [], data: [] }), { headers: { "x-clickhouse-format": "JSON" } });

    const result = await makeTransport().query("SELECT 1");

    expect(result.executionTimeMs).toBe(0);
  });

  // Spec 2.6: nothing in the UI consumes it, so it is deliberately not surfaced.
  // Asserted so a future widening of the seam is a decision, not an accident.
  test("does not surface the row-count estimate a LIMIT adds", async () => {
    const result = await makeTransport().query("SELECT * FROM tx_probe LIMIT 1");

    expect(Object.keys(result).sort()).toEqual([
      "columnTypes",
      "executionTimeMs",
      "fieldNames",
      "mutationCount",
      "rawText",
      "rows",
    ]);
  });

  test("describes nothing when the envelope carries no meta", async () => {
    handler = () => respond(JSON.stringify({ data: [{ x: 1 }] }), { headers: jsonHeaders() });

    const result = await makeTransport().query("SELECT 1");

    expect(result.rows).toEqual([{ x: 1 }]);
    expect(result.fieldNames).toBeNull();
    expect(result.columnTypes).toBeNull();
  });

  test("yields no rows when the envelope carries no data array", async () => {
    handler = () => respond(JSON.stringify({ meta: [{ name: "x", type: "UInt8" }] }), { headers: jsonHeaders() });

    const result = await makeTransport().query("SELECT 1");

    expect(result.rows).toEqual([]);
    expect(result.fieldNames).toEqual(["x"]);
  });
});

// ============================================================================
// A write
// ============================================================================

describe("ClickHouseHttpTransport writes", () => {
  // Spec 2.2: an INSERT is a 200 with NO body. Treating an empty body as a
  // failure - the reflex a JSON API teaches - would report every write as broken.
  test("treats an empty body as the success a write really is", async () => {
    handler = () =>
      respond("", {
        headers: { "content-type": "text/plain; charset=UTF-8", "x-clickhouse-summary": summaryHeader() },
      });

    const result = await makeTransport().query("INSERT INTO tx_probe VALUES (1,'a'),(2,'b')");

    expect(result.mutationCount).toBe(2);
    expect(result.executionTimeMs).toBeCloseTo(58.781261, 6);
    expect(result.rows).toEqual([]);
    expect(result.fieldNames).toBeNull();
    expect(result.columnTypes).toBeNull();
    expect(result.rawText).toBeNull();
  });

  // Live-verified: a DDL statement answers 200 with an empty body and no format
  // header at all, so the empty-body check has to come before any format check.
  test("accepts a DDL response that carries neither body nor format header", async () => {
    handler = () => respond("", { headers: { "x-clickhouse-summary": summaryHeader({ written_rows: "0" }) } });

    const result = await makeTransport().query("CREATE TABLE tx_probe (id Int32) ENGINE = MergeTree ORDER BY id");

    expect(result.mutationCount).toBe(0);
    expect(result.rawText).toBeNull();
  });

  // Spec 2.2, the honesty caveat: an ALTER ... UPDATE really did change the row
  // and still reports written_rows 0. Reporting the server's zero is the point -
  // a fabricated "1 row affected" would be a lie on screen.
  test("reports the server's zero for a mutation it queued in the background", async () => {
    handler = () => respond("", { headers: { "x-clickhouse-summary": summaryHeader({ written_rows: "0" }) } });

    const result = await makeTransport().query("ALTER TABLE tx_probe UPDATE name = 'z' WHERE id = 1");

    expect(result.mutationCount).toBe(0);
  });
});

// ============================================================================
// A format the user chose
// ============================================================================

describe("ClickHouseHttpTransport non-JSON formats", () => {
  // Spec 1.2: an explicit FORMAT in the user's SQL beats default_format, so the
  // response really is TSV. Parsing it would throw on something the user asked
  // for deliberately.
  test("returns the body as text when the server reports a format other than JSON", async () => {
    handler = () =>
      respond("1\n", {
        headers: {
          "content-type": "text/tab-separated-values; charset=UTF-8",
          "x-clickhouse-format": "TSV",
          "x-clickhouse-summary": summaryHeader(),
        },
      });

    const result = await makeTransport().query("SELECT 1 FORMAT TSV");

    expect(result.rawText).toBe("1\n");
    expect(result.rows).toEqual([]);
    expect(result.fieldNames).toBeNull();
    expect(result.columnTypes).toBeNull();
    expect(result.mutationCount).toBe(2);
    expect(result.executionTimeMs).toBeCloseTo(58.781261, 6);
  });

  test.each(["TSV", "CSV", "JSONEachRow", "Pretty"])("does not parse a %s response", async (format) => {
    handler = () => respond("payload", { headers: { "x-clickhouse-format": format } });

    expect((await makeTransport().query(`SELECT 1 FORMAT ${format}`)).rawText).toBe("payload");
  });

  // Defensive: a body with no format header is not JSON on the server's own
  // account, so handing it back as text beats parsing it and throwing.
  test("returns text when a non-empty body arrives with no format header", async () => {
    handler = () => respond("unlabelled", { headers: { "x-clickhouse-summary": summaryHeader() } });

    expect((await makeTransport().query("SELECT 1")).rawText).toBe("unlabelled");
  });
});

// ============================================================================
// The summary header
// ============================================================================

describe("ClickHouseHttpTransport summary header", () => {
  test.each<[string, string]>([
    ["malformed JSON", "{not json"],
    ["a JSON array", "[]"],
    ["a JSON scalar", '"58781261"'],
    ["JSON null", "null"],
  ])("degrades to zeroes when the header is %s", async (_label, summary) => {
    handler = () => respond("", { headers: { "x-clickhouse-summary": summary } });

    const result = await makeTransport().query("INSERT INTO tx_probe VALUES (1,'a')");

    expect(result.mutationCount).toBe(0);
    expect(result.executionTimeMs).toBe(0);
  });

  test("degrades to zeroes when the header is absent entirely", async () => {
    handler = () => respond("");

    const result = await makeTransport().query("INSERT INTO tx_probe VALUES (1,'a')");

    expect(result.mutationCount).toBe(0);
    expect(result.executionTimeMs).toBe(0);
  });

  test.each<[string, string]>([
    ["non-numeric", '{"written_rows":"lots","elapsed_ns":"ages"}'],
    ["absent", '{"read_rows":"2"}'],
  ])("degrades to zeroes when the counters are %s", async (_label, summary) => {
    handler = () => respond("", { headers: { "x-clickhouse-summary": summary } });

    const result = await makeTransport().query("INSERT INTO tx_probe VALUES (1,'a')");

    expect(result.mutationCount).toBe(0);
    expect(result.executionTimeMs).toBe(0);
  });
});

// ============================================================================
// Failures
// ============================================================================

describe("ClickHouseHttpTransport failures", () => {
  /** The body a real exception carries, version suffix included. */
  function exceptionBody(code: number, text: string, name: string): string {
    return `Code: ${code}. DB::Exception: ${text}. (${name}) (version 26.7.1.1315 (official build))`;
  }

  function failWith(status: number, body: string, headers: Record<string, string> = {}): void {
    handler = () =>
      respond(body, {
        status,
        // Live-verified: the content type claims JSON while the body is plain
        // text, which is exactly the trap this pins.
        headers: { "content-type": "application/json; charset=UTF-8", ...headers },
      });
  }

  // Spec 1.1: ClickHouse uses real status codes, so !response.ok is the whole
  // test. Inspecting the payload for an error - the Couchbase rule - is wrong
  // here, and would misread a row whose text happens to mention an exception.
  test("a 200 is a success even when a value looks like an exception", async () => {
    handler = () =>
      respond(
        JSON.stringify({
          meta: [{ name: "query", type: "String" }],
          data: [{ query: "Code: 62. DB::Exception: Syntax error (SYNTAX_ERROR)" }],
        }),
        { headers: jsonHeaders() },
      );

    const result = await makeTransport().query("SELECT query FROM system.query_log");

    expect(result.rows).toEqual([{ query: "Code: 62. DB::Exception: Syntax error (SYNTAX_ERROR)" }]);
  });

  test("any non-2xx status is a failure", async () => {
    failWith(400, exceptionBody(62, "Syntax error: failed at position 8", "SYNTAX_ERROR"), {
      "x-clickhouse-exception-code": "62",
    });

    const error = await captureError(() => makeTransport().query("SELECT FROM"));

    expect(error.code).toBe(62);
    expect(error.is("SYNTAX_ERROR")).toBe(true);
  });

  // The trailing "(version ...)" is build metadata, not information for the
  // person who mistyped a table name.
  test("strips the version suffix from the message the user sees", async () => {
    failWith(404, exceptionBody(60, "Table demo.nope does not exist", "UNKNOWN_TABLE"), {
      "x-clickhouse-exception-code": "60",
    });

    const error = await captureError(() => makeTransport().query("SELECT * FROM nope"));

    expect(error.message).toBe("Code: 60. DB::Exception: Table demo.nope does not exist. (UNKNOWN_TABLE)");
    expect(error.name).toBe("UNKNOWN_TABLE");
  });

  // Live-verified: an authentication failure carries no version suffix at all.
  test("leaves a message that has no version suffix untouched", async () => {
    failWith(
      403,
      "Code: 516. DB::Exception: libredb: Authentication failed: password is incorrect, or there is no user with such name. (AUTHENTICATION_FAILED)",
      { "x-clickhouse-exception-code": "516" },
    );

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.is("AUTHENTICATION_FAILED")).toBe(true);
    expect(error.message).toContain("password is incorrect");
    expect(error.message).toContain("(AUTHENTICATION_FAILED)");
  });

  // Live-verified: sending no credentials at all produces a multi-line body with
  // the exception name after a blank line, so the name has to be found at the end
  // of the whole string rather than on the first line.
  test("finds the exception name at the end of a multi-line body", async () => {
    failWith(
      403,
      [
        "Code: 194. DB::Exception: default: Authentication failed: password is incorrect, or there is no user with such name",
        "",
        "If you use ClickHouse Cloud, the password can be reset at https://clickhouse.cloud/",
        "",
        ". (REQUIRED_PASSWORD)",
      ].join("\n"),
    );

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.name).toBe("REQUIRED_PASSWORD");
    expect(error.code).toBe(194);
  });

  // The header is a discrete integer; the "Code: NN." prefix has to be scraped
  // out of prose. Prefer the header, but do not lose the code when it is absent -
  // a proxy that strips unknown headers would otherwise turn every failure into
  // an unclassifiable one.
  test("takes the code from the exception header when it is present", async () => {
    failWith(404, exceptionBody(81, "Database nosuchdb does not exist", "UNKNOWN_DATABASE"), {
      "x-clickhouse-exception-code": "81",
    });

    expect((await captureError(() => makeTransport().query("SELECT 1"))).is("UNKNOWN_DATABASE")).toBe(true);
  });

  test("falls back to the Code: prefix when the header is absent", async () => {
    failWith(501, exceptionBody(48, "Mutations are not supported", "NOT_IMPLEMENTED"));

    expect((await captureError(() => makeTransport().query("UPDATE t SET a = 1"))).is("NOT_IMPLEMENTED")).toBe(true);
  });

  test("falls back to the Code: prefix when the header is not a number", async () => {
    failWith(400, exceptionBody(62, "Syntax error", "SYNTAX_ERROR"), { "x-clickhouse-exception-code": "unknown" });

    expect((await captureError(() => makeTransport().query("SELECT FROM"))).code).toBe(62);
  });

  test("reports no code rather than a wrong one when nothing carries it", async () => {
    failWith(502, "<html>Bad Gateway</html>");

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.code).toBe(0);
    expect(error.name).toBe(CLICKHOUSE_UNKNOWN_ERROR_NAME);
    expect(error.message).toBe("<html>Bad Gateway</html>");
  });

  // A gateway can fail with nothing in the body. The status is then the only
  // thing there is to say, and saying it beats an empty message.
  test("describes the status when the body is empty", async () => {
    failWith(503, "");

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.message).toBe("ClickHouse request failed with HTTP 503");
    expect(error.code).toBe(0);
  });

  // The one thing that must never happen: the error body is plain text under an
  // application/json content type, so JSON.parse would throw a SyntaxError over
  // the real message.
  test("never parses an error body, whatever the content type claims", async () => {
    failWith(404, exceptionBody(60, "Unknown table expression identifier 'probe'", "UNKNOWN_TABLE"), {
      "x-clickhouse-exception-code": "60",
    });

    const error = await captureError(() => makeTransport().query("SELECT * FROM probe"));

    expect(error).not.toBeInstanceOf(SyntaxError);
    expect(error.message).toContain("Unknown table expression identifier 'probe'");
  });
});

// ============================================================================
// Mid-stream failures (issue #264, spec 2.8)
// ============================================================================

/**
 * A statement that throws after the response has already started streaming.
 * Live-verified on 26.7.1: the status is 200, no exception-code header is sent,
 * the JSON body is truncated mid-array, and the real exception arrives as a
 * trailer fenced by `__exception__` and the per-request tag from
 * `X-ClickHouse-Exception-Tag`.
 *
 * Repro: POST `SELECT number, throwIf(number = 200000, 'boom') FROM
 * numbers(1000000)` to `/?default_format=JSON&max_block_size=1000`.
 */
const MIDSTREAM_TAG = "rdlnavwamgbwoyjw";
const MIDSTREAM_MESSAGE =
  "Code: 395. DB::Exception: boom: while executing 'FUNCTION throwIf(equals(__table1.number, " +
  "200000_UInt32) :: 0, 'boom'_String :: 2) -> throwIf(equals(__table1.number, 200000_UInt32), " +
  "'boom'_String) UInt8 : 3'. (FUNCTION_THROW_IF_VALUE_IS_NON_ZERO) (version 26.7.1.1315 (official build))";

function midstreamBody(tag: string = MIDSTREAM_TAG, message: string = MIDSTREAM_MESSAGE): string {
  return [
    '{\n\t"meta":\n\t[\n\t\t{ "name": "number", "type": "UInt64" }\n\t],\n\n\t"data":\n\t[',
    '\t\t{ "number": 180999 }',
    "__exception__",
    tag,
    message,
    `286 ${tag}`,
    "__exception__",
  ].join("\n");
}

/** Headers such a response really carries: JSON format, a tag, and NO exception code. */
function midstreamHeaders(tag: string = MIDSTREAM_TAG): Record<string, string> {
  return jsonHeaders({ "x-clickhouse-exception-tag": tag });
}

describe("ClickHouseHttpTransport mid-stream exceptions", () => {
  test("reports the trailer's exception rather than a parse failure", async () => {
    handler = () => respond(midstreamBody(), { headers: midstreamHeaders() });

    const error = await captureError(() => makeTransport().query("SELECT throwIf(1, 'boom')"));

    expect(error.code).toBe(395);
    expect(error.name).toBe("FUNCTION_THROW_IF_VALUE_IS_NON_ZERO");
    expect(error.message).toContain("boom");
    // The build metadata is noise to the person who wrote the statement.
    expect(error.message).not.toContain("official build");
    // A parse complaint here would bury the only useful part of the failure.
    expect(error.message).not.toContain("could not parse");
  });

  test("keeps a literal __exception__ in the data a success, because the tag does not match", async () => {
    // `SELECT '__exception__' AS x` is a legal statement. Only the per-request
    // tag distinguishes a real trailer from user data that happens to say this.
    handler = () =>
      respond(JSON.stringify({ meta: [{ name: "x", type: "String" }], data: [{ x: "__exception__" }] }), {
        headers: midstreamHeaders(),
      });

    const result = await makeTransport().query("SELECT '__exception__' AS x");

    expect(result.rows).toEqual([{ x: "__exception__" }]);
  });

  test("reports the trailer even when the statement chose a non-JSON format", async () => {
    // Live-reproduced: `... FROM numbers(1000000) FORMAT TSV` that throws part-way
    // answers 200 with X-ClickHouse-Format: TSV, the tag, no exception-code header,
    // 195000 of 1000000 rows, and the fence. The fence is format-independent, so
    // checking it only for JSON reports 805000 lost rows as a success.
    const body = [
      "1\t0",
      "2\t0",
      "__exception__",
      MIDSTREAM_TAG,
      MIDSTREAM_MESSAGE,
      `286 ${MIDSTREAM_TAG}`,
      "__exception__",
    ].join("\n");
    handler = () =>
      respond(body, {
        headers: { "x-clickhouse-format": "TSV", "x-clickhouse-exception-tag": MIDSTREAM_TAG },
      });

    const error = await captureError(() => makeTransport().query("SELECT 1 FORMAT TSV"));

    expect(error.code).toBe(395);
    expect(error.name).toBe("FUNCTION_THROW_IF_VALUE_IS_NON_ZERO");
  });

  test("still returns raw text for a non-JSON format that did NOT fail", async () => {
    // The tag is on every response, so the trailer check must key on the fence and
    // not merely on the tag being present, or every FORMAT query becomes an error.
    handler = () =>
      respond("1\t0\n2\t0\n", {
        headers: { "x-clickhouse-format": "TSV", "x-clickhouse-exception-tag": MIDSTREAM_TAG },
      });

    const result = await makeTransport().query("SELECT 1 FORMAT TSV");

    expect(result.rawText).toBe("1\t0\n2\t0\n");
    expect(result.fieldNames).toBeNull();
  });

  test("strips a partial result body that precedes the exception", async () => {
    // The buffered-output variant: JSON output is accumulated so the server can count
    // `rows`, which means a failure part-way through can still be sent with a real
    // error STATUS and the partially built body ahead of the exception. Live-observed
    // through the app as an error message with ~400 characters of meta/data JSON in
    // front of the only useful line.
    const partial = '{\n\t"meta":\n\t[\n\t\t{ "name": "number", "type": "UInt64" }\n\t],\n\n\t"data":\n\t[\n';
    handler = () =>
      respond(`${partial}${MIDSTREAM_MESSAGE}`, {
        status: 500,
        headers: { "content-type": "application/json; charset=UTF-8", "x-clickhouse-exception-code": "395" },
      });

    const error = await captureError(() => makeTransport().query("SELECT throwIf(1, 'boom')"));

    expect(error.code).toBe(395);
    expect(error.name).toBe("FUNCTION_THROW_IF_VALUE_IS_NON_ZERO");
    expect(error.message.startsWith("Code: 395.")).toBe(true);
    expect(error.message).not.toContain('"meta"');
  });

  test("strips a partial body even when no newline precedes the exception", async () => {
    // The live shape when rows had already been written: the exception is appended
    // straight onto the truncated row, so a line-anchored match misses it - and those
    // are the longest, noisiest bodies of all.
    handler = () =>
      respond(`{"meta":[],"data":[{"number": "2"${MIDSTREAM_MESSAGE}`, {
        status: 500,
        headers: { "x-clickhouse-exception-code": "395" },
      });

    const error = await captureError(() => makeTransport().query("SELECT throwIf(1, 'boom')"));

    expect(error.message.startsWith("Code: 395.")).toBe(true);
    expect(error.message).not.toContain('"meta"');
  });

  test("leaves an ordinary error message that already starts with its code alone", async () => {
    handler = () =>
      respond("Code: 60. DB::Exception: Unknown table expression identifier 'nope'. (UNKNOWN_TABLE)", {
        status: 404,
        headers: { "x-clickhouse-exception-code": "60" },
      });

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.message).toBe("Code: 60. DB::Exception: Unknown table expression identifier 'nope'. (UNKNOWN_TABLE)");
  });

  test("falls back to the parse failure when the response carries no tag", async () => {
    handler = () => respond(midstreamBody(), { headers: jsonHeaders() });

    expect((await captureError(() => makeTransport().query("SELECT 1"))).code).toBe(0);
  });

  test("still reports the exception when the truncated body happens to stay parseable", async () => {
    // The trailer is authoritative on its own: a plan that fails after emitting a
    // complete-looking envelope must not be reported as a successful empty result.
    handler = () =>
      respond(`${JSON.stringify({ meta: [], data: [] })}\n__exception__\n${MIDSTREAM_TAG}\n${MIDSTREAM_MESSAGE}`, {
        headers: midstreamHeaders(),
      });

    expect((await captureError(() => makeTransport().query("SELECT 1"))).code).toBe(395);
  });

  test("degrades to a normalized error when the trailer carries no recognizable code", async () => {
    handler = () =>
      respond(midstreamBody(MIDSTREAM_TAG, "truncated beyond recognition"), {
        headers: midstreamHeaders(),
      });

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.code).toBe(0);
    expect(error.name).toBe(CLICKHOUSE_UNKNOWN_ERROR_NAME);
  });
});

// ============================================================================
// Failures that are not the server's
// ============================================================================

describe("ClickHouseHttpTransport transport failures", () => {
  test("normalizes a body that claims to be JSON and is not", async () => {
    handler = () => respond("{not json", { headers: jsonHeaders() });

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.code).toBe(0);
    expect(error.name).toBe(CLICKHOUSE_UNKNOWN_ERROR_NAME);
    expect(error.message).toContain("JSON");
  });

  test("normalizes a JSON body that is not an envelope object", async () => {
    handler = () => respond("[1, 2]", { headers: jsonHeaders() });

    expect((await captureError(() => makeTransport().query("SELECT 1"))).code).toBe(0);
  });

  // Every throw out of the seam has to be a ClickHouseTransportError or the
  // provider's `instanceof` branches fall through to a generic message.
  test("normalizes a refused connection", async () => {
    handler = () => {
      throw new Error("fetch failed");
    };

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.code).toBe(0);
    expect(error.name).toBe(CLICKHOUSE_UNKNOWN_ERROR_NAME);
    expect(error.message).toBe("ClickHouse request failed: fetch failed");
  });

  test("normalizes an aborted request", async () => {
    handler = () => {
      const abort = new Error("The operation was aborted.");
      abort.name = "AbortError";
      throw abort;
    };

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error).toBeInstanceOf(ClickHouseTransportError);
    expect(error.message).toBe("ClickHouse request failed: The operation was aborted.");
  });

  test("normalizes a rejection that is not an Error at all", async () => {
    handler = () => {
      throw "socket hang up";
    };

    expect((await captureError(() => makeTransport().query("SELECT 1"))).message).toBe(
      "ClickHouse request failed: socket hang up",
    );
  });
});

// ============================================================================
// The seam
// ============================================================================

describe("ClickHouseHttpTransport seam", () => {
  test("announces itself as the HTTP implementation", () => {
    expect(makeTransport().kind).toBe("http");
  });

  // Spec 1.4: one request per statement, no session pinned, so there is nothing
  // to release. close() exists because every implementation of the seam has it.
  test("closes without holding anything open", async () => {
    const transport = makeTransport();

    await transport.close();

    await expect(transport.query("SELECT 1")).resolves.toBeDefined();
  });
});
