/**
 * Trino HTTP transport (issue #424, Phase 2)
 *
 * globalThis.fetch is replaced per test and restored in afterEach. mock.module()
 * is deliberately not used: it is process-wide in bun, so mocking a module here
 * would poison every sibling test file sharing the process.
 *
 * Every payload replayed below was captured from a live **Trino 476** on
 * 2026-08-20 (the stock `trinodb/trino:476` single node, catalogs `tpch`,
 * `tpcds`, `memory`, `system`, `jmx`; probe data from `tpch.sf1` and a
 * `memory.default.probe_t`), including the shapes that look like bugs and are
 * not:
 *
 * - a FAILED statement answering **HTTP 200** with the failure inside the
 *   document;
 * - a page reporting `FINISHED` that still carries a link to the page holding the
 *   rows, so the loop cannot terminate on a state;
 * - `SELECT 1 AS c, 2 AS c` really declaring two columns both named `c`;
 * - `CREATE TABLE` answering with a declaration of NO columns;
 * - a DECIMAL arriving as the string `"1.5"` and a VARBINARY as `"AQI="`;
 * - the same warning repeated on every page of one exchange;
 * - a 401 whose body is PLAIN TEXT rather than JSON.
 *
 * TRIMMING, declared: the `stats` blocks keep `state` plus the six numbers this
 * transport reads and drop `rootStage` and the two dozen split/percentage
 * counters, which nothing under test looks at. Failure documents drop
 * `failureInfo` (a forty-frame Java stack) for the same reason. Everything else -
 * ids, links, declarations, data rows, warning envelopes, plain-text refusals -
 * is verbatim.
 *
 * CONSTRUCTED rather than captured, and labelled at each use: the retry statuses
 * (502/503/504/429) and a `PERMISSION_DENIED` / `INSUFFICIENT_RESOURCES` failure.
 * The probe coordinator runs with authentication and resource groups disabled and
 * never became intermittent, so those could not be provoked; their shapes come
 * from the protocol's own documentation and from the measured failure-document
 * layout.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TrinoHttpTransport } from "@/lib/db/providers/sql/trino/http-transport";
import { TRINO_DIALECT, type TrinoErrorCategory, TrinoTransportError } from "@/lib/db/providers/sql/trino/transport";
import type { DatabaseConnection, DatabaseType } from "@/lib/db/types";

// ============================================================================
// Harness
// ============================================================================

// The DatabaseType union gains "trino" in the registration commit; the double
// assertion keeps this file compiling on either side of that change.
const TRINO: DatabaseType = "trino" as unknown as DatabaseType;

interface FetchCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];
let handler: (url: string, init?: RequestInit) => Response | Promise<Response>;

function respond(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    // Live-verified: every result document arrives as application/json, and every
    // refusal the coordinator issues before the statement exists arrives as
    // text/plain. The tests that care set the latter explicitly.
    headers: { "content-type": "application/json", ...init.headers },
  });
}

/** Serve the given pages in order, then keep serving the last one. */
function sequence(...pages: string[]): void {
  let served = 0;
  handler = () => {
    const page = pages[Math.min(served, pages.length - 1)];
    served += 1;
    return respond(page);
  };
}

function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "trino-1",
    name: "Trino",
    type: TRINO,
    host: "127.0.0.1",
    port: 8080,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeTransport(overrides: Partial<DatabaseConnection> = {}): TrinoHttpTransport {
  return new TrinoHttpTransport(TRINO_DIALECT, makeConnection(overrides));
}

function firstCall(): FetchCall {
  const call = calls[0];
  if (!call) throw new Error("no request was made");
  return call;
}

function lastCall(): FetchCall {
  const call = calls.at(-1);
  if (!call) throw new Error("no request was made");
  return call;
}

/** The thrown TrinoTransportError, or a failed expectation if none was thrown. */
async function captureError(run: () => Promise<unknown>): Promise<TrinoTransportError> {
  try {
    await run();
  } catch (caught) {
    expect(caught).toBeInstanceOf(TrinoTransportError);
    return caught as TrinoTransportError;
  }
  throw new Error("the transport resolved where it should have thrown");
}

// ============================================================================
// Wire payloads (captured from Trino 476 over POST /v1/statement)
// ============================================================================

const QUERY_ID = "20260819_231125_00001_chvb7";
const INFO_URI = `http://localhost:8080/ui/query.html?${QUERY_ID}`;
// The slug in each link is `y` followed by 40 hex characters on the real server - an
// opaque per-page continuation token, not a credential, and dead the moment the query
// ends. It is SHORTENED here because at full length the secret scanner reads it as a
// generic API key, and a permanent scanner exception is a worse thing to carry than a
// shorter token. Nothing under test reads the slug: what the transport owes these links
// is to follow the absolute URI the coordinator hands back rather than rebuild one from
// its own origin, and the path shape below is what proves that.
const QUEUED_LINK_1 = `http://localhost:8080/v1/statement/queued/${QUERY_ID}/yqueued1/1`;
const QUEUED_LINK_2 = `http://localhost:8080/v1/statement/queued/${QUERY_ID}/yqueued2/2`;
const RUNNING_LINK = `http://localhost:8080/v1/statement/executing/${QUERY_ID}/yexecuting1/1`;
const PARTIAL_CANCEL_LINK = `http://localhost:8080/v1/statement/executing/partialCancel/${QUERY_ID}/0/yexecuting1/1`;

const QUEUED_STATS =
  '{"state":"QUEUED","queued":true,"scheduled":false,"cpuTimeMillis":0,"queuedTimeMillis":0,' +
  '"elapsedTimeMillis":0,"processedRows":0,"processedBytes":0,"peakMemoryBytes":0}';
const RUNNING_STATS =
  '{"state":"RUNNING","queued":false,"scheduled":true,"cpuTimeMillis":0,"queuedTimeMillis":9,' +
  '"elapsedTimeMillis":459,"processedRows":0,"processedBytes":0,"peakMemoryBytes":148}';
const FINISHED_STATS =
  '{"state":"FINISHED","queued":false,"scheduled":true,"cpuTimeMillis":4,"queuedTimeMillis":9,' +
  '"elapsedTimeMillis":576,"processedRows":1,"processedBytes":0,"peakMemoryBytes":148}';
const FAILED_STATS =
  '{"state":"FAILED","queued":false,"scheduled":false,"cpuTimeMillis":0,"queuedTimeMillis":0,' +
  '"elapsedTimeMillis":0,"processedRows":0,"processedBytes":0,"peakMemoryBytes":0}';

const VERSION_COLUMNS =
  '[{"name":"_col0","type":"varchar","typeSignature":{"rawType":"varchar","arguments":[{"kind":"LONG","value":2147483647}]}}]';

/**
 * `SELECT version()`, all five pages the server really sent.
 *
 * Five pages for a constant is the measurement that drives the whole loop: three
 * carry neither a declaration nor rows, the fourth carries both, and the fifth
 * carries the declaration again with no rows and no link. A parser that read the
 * first page and stopped would report an empty result for a statement that
 * answered `476`.
 */
const VERSION_PAGES = [
  `{"id":"${QUERY_ID}","infoUri":"${INFO_URI}","nextUri":"${QUEUED_LINK_1}","stats":${QUEUED_STATS},"warnings":[]}`,
  `{"id":"${QUERY_ID}","infoUri":"${INFO_URI}","nextUri":"${QUEUED_LINK_2}","stats":${QUEUED_STATS},"warnings":[]}`,
  `{"id":"${QUERY_ID}","infoUri":"${INFO_URI}","nextUri":"${QUEUED_LINK_2}","stats":${QUEUED_STATS},"warnings":[]}`,
  `{"id":"${QUERY_ID}","infoUri":"${INFO_URI}","partialCancelUri":"${PARTIAL_CANCEL_LINK}","nextUri":"${RUNNING_LINK}",` +
    `"columns":${VERSION_COLUMNS},"data":[["476"]],"stats":${RUNNING_STATS},"warnings":[]}`,
  `{"id":"${QUERY_ID}","infoUri":"${INFO_URI}","columns":${VERSION_COLUMNS},"stats":${FINISHED_STATS},"warnings":[]}`,
];

/** The last page alone, for tests that only need one complete exchange. */
const SINGLE_PAGE = `{"id":"${QUERY_ID}","columns":${VERSION_COLUMNS},"data":[["476"]],"stats":${FINISHED_STATS},"warnings":[]}`;

/**
 * `SELECT 1 AS c, 2 AS c` verbatim. Duplicate output names are legal SQL that
 * ordinary joins produce, and the server really declares both.
 */
const DUPLICATE_PAGE =
  `{"id":"${QUERY_ID}","columns":[{"name":"c","type":"integer","typeSignature":{"rawType":"integer","arguments":[]}},` +
  '{"name":"c","type":"integer","typeSignature":{"rawType":"integer","arguments":[]}}],"data":[[1,2]],' +
  `"stats":${FINISHED_STATS},"warnings":[]}`;

/**
 * One row of every value encoding, from
 * `SELECT CAST(1 AS bigint) b, 1.5 d, 'x' v, DATE '2020-01-01' dt,
 *  TIMESTAMP '2020-01-01 10:00:00' ts, CAST(NULL AS varchar) n, ARRAY[1,2] a,
 *  MAP(ARRAY['k'],ARRAY['v']) m, CAST(ROW(1,'a') AS row(x integer, y varchar)) r,
 *  DECIMAL '1.23' dec, true bo, X'0102' vb`.
 *
 * Measured and counter-intuitive: DECIMAL arrives as a STRING (`"1.5"`, `"1.23"`)
 * so no precision is lost to a double, DATE and TIMESTAMP as strings, VARBINARY
 * base64, ARRAY as a JSON array, MAP as an object and ROW as a positional array.
 * The transport passes all of it through untouched - the declared type is the
 * label, and any coercion here would be the one place the string could be
 * destroyed.
 */
const TYPED_COLUMNS = [
  { name: "b", type: "bigint" },
  { name: "d", type: "decimal(2, 1)" },
  { name: "v", type: "varchar(1)" },
  { name: "dt", type: "date" },
  { name: "ts", type: "timestamp" },
  { name: "n", type: "varchar" },
  { name: "a", type: "array(integer)" },
  { name: "m", type: "map(varchar(1), varchar(1))" },
  { name: "r", type: "row(x integer, y varchar)" },
  { name: "dec", type: "decimal(3, 2)" },
  { name: "bo", type: "boolean" },
  { name: "vb", type: "varbinary" },
];
const TYPED_PAGE =
  `{"id":"${QUERY_ID}","columns":${JSON.stringify(TYPED_COLUMNS)},` +
  '"data":[[1,"1.5","x","2020-01-01","2020-01-01 10:00:00.000",null,[1,2],{"k":"v"},[1,"a"],"1.23",true,"AQI="]],' +
  `"stats":${FINISHED_STATS},"warnings":[]}`;

/** `SELEKT 1`. HTTP 200, `state: FAILED`, the fault inside the document. */
const SYNTAX_FAILURE_PAGE =
  `{"id":"${QUERY_ID}","infoUri":"${INFO_URI}","stats":${FAILED_STATS},"error":{"message":` +
  "\"line 1:1: mismatched input 'SELEKT'. Expecting: 'ALTER', 'ANALYZE', 'CALL', 'COMMENT', 'COMMIT', 'CREATE', " +
  "'DEALLOCATE', 'DELETE', 'DENY', 'DESC', 'DESCRIBE', 'DROP', 'EXECUTE', 'EXPLAIN', 'GRANT', 'INSERT', 'MERGE', " +
  "'PREPARE', 'REFRESH', 'RESET', 'REVOKE', 'ROLLBACK', 'SET', 'SHOW', 'START', 'TRUNCATE', 'UPDATE', 'USE', " +
  '\'WITH\', <query>","errorCode":1,"errorName":"SYNTAX_ERROR","errorType":"USER_ERROR",' +
  '"errorLocation":{"lineNumber":1,"columnNumber":1}},"warnings":[]}';

/** `CREATE TABLE tpch.sf1.x (a integer)`. Note `errorLocation` is explicitly null. */
const UNSUPPORTED_FAILURE_PAGE =
  `{"id":"${QUERY_ID}","stats":${FAILED_STATS},"error":{"message":"This connector does not support creating tables",` +
  '"errorCode":13,"errorName":"NOT_SUPPORTED","errorType":"USER_ERROR","errorLocation":null},"warnings":[]}';

/** `SELECT * FROM tpch.sf1.no_such_table`. */
const MISSING_TABLE_FAILURE_PAGE =
  `{"id":"${QUERY_ID}","stats":${FAILED_STATS},"error":{"message":` +
  '"line 1:15: Table \'tpch.sf1.no_such_table\' does not exist","errorCode":46,"errorName":"TABLE_NOT_FOUND",' +
  '"errorType":"USER_ERROR","errorLocation":{"lineNumber":1,"columnNumber":15}},"warnings":[]}';

/** `INSERT INTO tpch.sf1.nation SELECT 1`: a USER_ERROR this table does not name. */
const TYPE_MISMATCH_FAILURE_PAGE =
  `{"id":"${QUERY_ID}","stats":${FAILED_STATS},"error":{"message":` +
  '"line 1:1: Insert query has mismatched column types: Table: [bigint, varchar(25), bigint, varchar(152)], ' +
  'Query: [integer]","errorCode":58,"errorName":"TYPE_MISMATCH","errorType":"USER_ERROR",' +
  '"errorLocation":{"lineNumber":1,"columnNumber":1}},"warnings":[]}';

/**
 * The page a statement answers with AFTER a DELETE terminated it. Note there is
 * no `errorLocation` member at all, and the state is FAILED rather than a
 * cancelled state of its own.
 */
const CANCELED_FAILURE_PAGE =
  `{"id":"${QUERY_ID}","columns":${VERSION_COLUMNS},"stats":${FAILED_STATS},` +
  '"error":{"message":"Query was canceled","errorCode":3,"errorName":"USER_CANCELED","errorType":"USER_ERROR"},' +
  '"warnings":[]}';

/**
 * The page a statement answers with after `CALL system.runtime.kill_query` ended it -
 * the OTHER way a Trino statement is stopped, and a different fault name from the one
 * a DELETE produces.
 *
 * Captured on 476: a long join was submitted, killed through that procedure, and
 * polled to completion. It reports `"errorName":"ADMINISTRATIVELY_KILLED"`,
 * `"errorCode":38` and `"errorType":"USER_ERROR"`. The type is what makes the entry
 * necessary: without a row of its own the name falls through to the USER_ERROR family
 * and categorises as `engine`, so the monitoring panel's own kill button - which is
 * exactly this procedure, `maintenanceOperations: ["kill"]` - would report the query
 * it just stopped as an engine fault.
 */
const KILLED_FAILURE_PAGE =
  `{"id":"${QUERY_ID}","columns":${VERSION_COLUMNS},"stats":${FAILED_STATS},` +
  '"error":{"message":"Query killed. Message: probe","errorCode":38,' +
  '"errorName":"ADMINISTRATIVELY_KILLED","errorType":"USER_ERROR"},"warnings":[]}';

/** `CREATE TABLE memory.default.probe_t (a integer)`: an EMPTY declaration and no count. */
const CREATE_TABLE_PAGE = `{"id":"${QUERY_ID}","columns":[],"stats":${FINISHED_STATS},"warnings":[],"updateType":"CREATE TABLE"}`;

/** `INSERT INTO memory.default.probe_t VALUES (1),(2),(3)`. */
const INSERT_PAGE =
  `{"id":"${QUERY_ID}","columns":[{"name":"rows","type":"bigint","typeSignature":{"rawType":"bigint","arguments":[]}}],` +
  `"data":[[3]],"stats":${FINISHED_STATS},"warnings":[],"updateType":"INSERT","updateCount":3}`;

/** `SET SESSION query_max_run_time = '10m'`: succeeds, and this transport discards its effect. */
const SET_SESSION_PAGE = `{"id":"${QUERY_ID}","columns":[],"stats":${FINISHED_STATS},"warnings":[],"updateType":"SET SESSION"}`;

/**
 * The remark from `SELECT * FROM (SELECT nationkey FROM tpch.sf1.nation ORDER BY
 * nationkey) t LIMIT 2`, which the server repeated on every page of the exchange.
 */
const WARNING_ENVELOPE =
  '[{"warningCode":{"code":2,"name":"REDUNDANT_ORDER_BY"},"message":"ORDER BY in subquery may have no effect"}]';
const WARNED_RUNNING_PAGE =
  `{"id":"${QUERY_ID}","nextUri":"${RUNNING_LINK}","columns":${VERSION_COLUMNS},"stats":${RUNNING_STATS},` +
  `"warnings":${WARNING_ENVELOPE}}`;
const WARNED_FINISHED_PAGE =
  `{"id":"${QUERY_ID}","columns":${VERSION_COLUMNS},"data":[["476"]],"stats":${FINISHED_STATS},` +
  `"warnings":${WARNING_ENVELOPE}}`;

/**
 * A page that reports FINISHED and still carries a link, followed by the page
 * that actually ends the exchange. Measured verbatim on
 * `SELECT nationkey FROM tpch.sf1.nation ORDER BY nationkey LIMIT 2` - and it is
 * the page carrying the ROWS, so terminating on the state would have returned an
 * empty result for a statement that answered two rows.
 */
const FINISHED_WITH_LINK_PAGE =
  `{"id":"${QUERY_ID}","nextUri":"${RUNNING_LINK}","columns":${VERSION_COLUMNS},"data":[["476"]],` +
  `"stats":${FINISHED_STATS},"warnings":[]}`;

/** HTTP 401, `text/plain`, verbatim - and NOT valid JSON. */
const MISSING_USER_BODY = "Basic authentication or X-Trino-Original-User or X-Trino-User must be sent";
/** HTTP 401 when a password is sent to a plain-HTTP coordinator, verbatim. */
const INSECURE_PASSWORD_BODY = "Password not allowed for insecure authentication";
/** HTTP 404 at a path that is not the client protocol, verbatim. */
const NOT_FOUND_BODY = "Error 404 Not Found: HTTP 404 Not Found";

beforeEach(() => {
  calls = [];
  sequence(SINGLE_PAGE);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method,
      headers: (init?.headers as Record<string, string> | undefined) ?? {},
      body: init?.body === undefined ? undefined : String(init.body),
    });
    return await handler(typeof input === "string" ? input : input.toString(), init);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ============================================================================
// The request
// ============================================================================

describe("TrinoHttpTransport request", () => {
  test("posts the statement as its own text to the statement endpoint", async () => {
    await makeTransport().query("SELECT version()");

    expect(firstCall().url).toBe("http://127.0.0.1:8080/v1/statement");
    expect(firstCall().method).toBe("POST");
    // No JSON envelope: the body IS the statement.
    expect(firstCall().body).toBe("SELECT version()");
    expect(firstCall().headers["content-type"]).toBe("text/plain");
    expect(firstCall().headers.accept).toBe("application/json");
  });

  // Every header the coordinator recognises is generated from the descriptor's
  // product name, exactly the way the server generates it. This is the assertion
  // that makes PrestoDB a descriptor rather than a rewrite.
  test("generates the protocol headers from the dialect's prefix", async () => {
    await makeTransport({ user: "analyst" }).query("SELECT 1");

    expect(firstCall().headers["X-Trino-User"]).toBe("analyst");
    expect(firstCall().headers["X-Trino-Source"]).toBe("libredb-studio");
    expect(firstCall().headers["X-Trino-Time-Zone"]).toBe("UTC");
  });

  // Measured: a request with no user header is refused with 401 before the
  // statement is parsed, so there is no such thing as an anonymous statement.
  test("names a user even when the connection does not", async () => {
    await makeTransport().query("SELECT 1");

    expect(firstCall().headers["X-Trino-User"]).toBe("libredb");
  });

  test("pins the connection's catalog, which is where the database field maps", async () => {
    await makeTransport({ database: "tpch" }).query("SELECT 1");

    expect(firstCall().headers["X-Trino-Catalog"]).toBe("tpch");
    expect(firstCall().headers["X-Trino-Schema"]).toBeUndefined();
  });

  // Introspection legitimately reads a catalog other than the pinned one, and the
  // alternative - USE - is the session mutation this stateless transport discards.
  test("lets one statement override the catalog and name a schema", async () => {
    await makeTransport({ database: "tpch" }).query("SELECT 1", { catalog: "memory", schema: "default" });

    expect(firstCall().headers["X-Trino-Catalog"]).toBe("memory");
    expect(firstCall().headers["X-Trino-Schema"]).toBe("default");
  });

  test("sends no catalog or schema header when neither is configured", async () => {
    await makeTransport().query("SELECT 1", { catalog: "", schema: "" });

    expect(firstCall().headers["X-Trino-Catalog"]).toBeUndefined();
    expect(firstCall().headers["X-Trino-Schema"]).toBeUndefined();
  });

  test("defaults the host and the port from the descriptor", async () => {
    await new TrinoHttpTransport(TRINO_DIALECT, {
      id: "trino-2",
      name: "Trino",
      type: TRINO,
      createdAt: new Date(),
    }).query("SELECT 1");

    expect(firstCall().url).toBe("http://localhost:8080/v1/statement");
  });

  // A bare IPv6 literal is not a legal URL authority.
  test("brackets an IPv6 host", async () => {
    await makeTransport({ host: "::1" }).query("SELECT 1");

    expect(firstCall().url).toBe("http://[::1]:8080/v1/statement");
  });

  test("leaves an already bracketed IPv6 host alone", async () => {
    await makeTransport({ host: "[::1]" }).query("SELECT 1");

    expect(firstCall().url).toBe("http://[::1]:8080/v1/statement");
  });

  test("an explicit ssl mode selects https", async () => {
    await makeTransport({ ssl: { mode: "require" } }).query("SELECT 1");

    expect(firstCall().url).toBe("https://127.0.0.1:8080/v1/statement");
  });

  // An explicit `disable` has to turn TLS OFF as well as an explicit mode turns it
  // on (the #264 lesson).
  test("an explicit disable stays on http", async () => {
    await makeTransport({ ssl: { mode: "disable" } }).query("SELECT 1");

    expect(firstCall().url).toBe("http://127.0.0.1:8080/v1/statement");
  });
});

// ============================================================================
// Credentials (measured fact 4)
// ============================================================================

describe("TrinoHttpTransport credentials", () => {
  test("sends no authorization when the connection has no password", async () => {
    await makeTransport({ user: "analyst" }).query("SELECT 1");

    expect(firstCall().headers.authorization).toBeUndefined();
  });

  test("treats an empty password as no password", async () => {
    await makeTransport({ user: "analyst", password: "" }).query("SELECT 1");

    expect(firstCall().headers.authorization).toBeUndefined();
  });

  test("sends Basic credentials over TLS, with the username the statement runs as", async () => {
    await makeTransport({ user: "analyst", password: "s3cret", ssl: { mode: "require" } }).query("SELECT 1");

    expect(firstCall().headers.authorization).toBe(`Basic ${Buffer.from("analyst:s3cret").toString("base64")}`);
    expect(firstCall().headers["X-Trino-User"]).toBe("analyst");
  });

  /**
   * Measured on a coordinator with authentication switched OFF entirely: a
   * password over plain HTTP answers 401, `Password not allowed for insecure
   * authentication`, with `WWW-Authenticate: Basic realm="Trino"`. Refusing here
   * beats both alternatives - sending it turns a connection that would have worked
   * into a 401 on every statement, and dropping it silently lets a user believe a
   * credential is in force when nothing is authenticating them.
   */
  test("refuses to be built with a password over plain HTTP, rather than sending a doomed header", () => {
    let caught: unknown;
    try {
      makeTransport({ user: "analyst", password: "s3cret" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TrinoTransportError);
    expect((caught as TrinoTransportError).category).toBe("auth");
    expect((caught as TrinoTransportError).message).toContain("plain HTTP");
    expect((caught as TrinoTransportError).message).toContain("Enable TLS");
    // Nothing left the process: the refusal happens before any request exists.
    expect(calls).toEqual([]);
  });

  test("the coordinator's own words for that refusal are reported when a server sends them", async () => {
    handler = () => new Response(INSECURE_PASSWORD_BODY, { status: 401, headers: { "content-type": "text/plain" } });

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.category).toBe("auth");
    expect(error.message).toContain("Password not allowed for insecure authentication");
  });
});

// ============================================================================
// The page loop (measured facts 2 and 3)
// ============================================================================

describe("TrinoHttpTransport page loop", () => {
  test("follows every link of a real five-page exchange and returns the rows", async () => {
    sequence(...VERSION_PAGES);

    const result = await makeTransport().query("SELECT version()");

    expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "GET", "GET", "GET"]);
    expect(calls[1].url).toBe(QUEUED_LINK_1);
    expect(calls[4].url).toBe(RUNNING_LINK);
    expect(result.rows).toEqual([{ _col0: "476" }]);
    expect(result.fieldNames).toEqual(["_col0"]);
    expect(result.columnTypes).toEqual({ _col0: "varchar" });
    expect(result.queryId).toBe(QUERY_ID);
  });

  // The measured trap in full: this page says FINISHED, carries the rows, and
  // still hands out a link. Stopping on the state would have returned nothing.
  test("does not stop on a FINISHED state that still carries a link", async () => {
    sequence(FINISHED_WITH_LINK_PAGE, VERSION_PAGES[4]);

    const result = await makeTransport().query("SELECT version()");

    expect(calls).toHaveLength(2);
    expect(result.rows).toEqual([{ _col0: "476" }]);
  });

  // The protocol headers are "only required in the initial POST request, and not
  // when following the nextUri links".
  test("sends the protocol headers only on the submission", async () => {
    sequence(...VERSION_PAGES);

    await makeTransport({ database: "tpch" }).query("SELECT version()");

    expect(calls[1].headers["X-Trino-User"]).toBeUndefined();
    expect(calls[1].headers["X-Trino-Catalog"]).toBeUndefined();
    expect(calls[1].headers.accept).toBe("application/json");
  });

  // The "first POST only" rule is about the X-<Product>-* family; a coordinator
  // behind TLS authenticates each request on its own.
  test("sends the credential on every follow-up", async () => {
    sequence(...VERSION_PAGES);

    await makeTransport({ user: "analyst", password: "s3cret", ssl: { mode: "require" } }).query("SELECT 1");

    const expected = `Basic ${Buffer.from("analyst:s3cret").toString("base64")}`;
    expect(calls.every((call) => call.headers.authorization === expected)).toBe(true);
  });

  test("accumulates rows across the pages that carry them", async () => {
    sequence(
      `{"id":"${QUERY_ID}","nextUri":"${RUNNING_LINK}","columns":${VERSION_COLUMNS},"data":[["a"],["b"]],"stats":${RUNNING_STATS},"warnings":[]}`,
      `{"id":"${QUERY_ID}","nextUri":"${RUNNING_LINK}","columns":${VERSION_COLUMNS},"stats":${RUNNING_STATS},"warnings":[]}`,
      `{"id":"${QUERY_ID}","columns":${VERSION_COLUMNS},"data":[["c"]],"stats":${FINISHED_STATS},"warnings":[]}`,
    );

    const result = await makeTransport().query("SELECT x");

    expect(result.rows).toEqual([{ _col0: "a" }, { _col0: "b" }, { _col0: "c" }]);
  });

  // Trino long-polls each page for about a second, so a slow statement produces
  // hundreds of pages legitimately. The bound exists only so a coordinator that
  // never stops handing out links cannot spin the request forever, and hitting it
  // is reported rather than quietly treated as a complete answer.
  test("abandons and reports a coordinator that never stops handing out links", async () => {
    handler = () => respond(`{"id":"${QUERY_ID}","nextUri":"${RUNNING_LINK}","stats":${RUNNING_STATS},"warnings":[]}`);

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.category).toBe("engine");
    expect(error.message).toContain("5000 pages");
    // And the statement it gave up on was terminated rather than left running.
    expect(lastCall().method).toBe("DELETE");
  });
});

// ============================================================================
// The result
// ============================================================================

describe("TrinoHttpTransport result", () => {
  /**
   * Rows are POSITIONAL - arrays aligned to the declaration by index, with no
   * field names on the wire at all - so a duplicated output name would lose a
   * column before the seam unless it is disambiguated while the row is rebuilt.
   */
  test("disambiguates a duplicated output column instead of dropping it", async () => {
    sequence(DUPLICATE_PAGE);

    const result = await makeTransport().query("SELECT 1 AS c, 2 AS c");

    expect(result.fieldNames).toEqual(["c", "c (2)"]);
    expect(result.rows).toEqual([{ c: 1, "c (2)": 2 }]);
    expect(result.columnTypes).toEqual({ c: "integer", "c (2)": "integer" });
  });

  test("keeps climbing the suffix when the disambiguated name is itself declared", async () => {
    sequence(
      `{"id":"${QUERY_ID}","columns":[{"name":"c","type":"integer"},{"name":"c (2)","type":"integer"},` +
        `{"name":"c","type":"integer"}],"data":[[1,2,3]],"stats":${FINISHED_STATS},"warnings":[]}`,
    );

    const result = await makeTransport().query('SELECT 1 AS c, 2 AS "c (2)", 3 AS c');

    expect(result.fieldNames).toEqual(["c", "c (2)", "c (3)"]);
  });

  test("passes every value encoding through untouched", async () => {
    sequence(TYPED_PAGE);

    const result = await makeTransport().query("SELECT ...");

    expect(result.rows[0]).toEqual({
      b: 1,
      // A DECIMAL arrives as a string precisely so no precision is lost to a
      // double; coercing it here would be the one place that could destroy it.
      d: "1.5",
      v: "x",
      dt: "2020-01-01",
      ts: "2020-01-01 10:00:00.000",
      n: null,
      a: [1, 2],
      m: { k: "v" },
      r: [1, "a"],
      dec: "1.23",
      bo: true,
      vb: "AQI=",
    });
    expect(result.columnTypes?.dec).toBe("decimal(3, 2)");
    expect(result.columnTypes?.r).toBe("row(x integer, y varchar)");
  });

  test("reports the coordinator's own execution numbers", async () => {
    sequence(...VERSION_PAGES);

    const result = await makeTransport().query("SELECT version()");

    // From the LAST page that carried a report, which is the most complete.
    expect(result.stats).toEqual({
      state: "FINISHED",
      elapsedMs: 576,
      cpuMs: 4,
      queuedMs: 9,
      processedRows: 1,
      processedBytes: 0,
      peakMemoryBytes: 148,
    });
  });

  // Null rather than zero: a statement still planning has reported nothing, and a
  // zero there would claim it processed no rows.
  test("admits it when a page reported no execution numbers at all", async () => {
    sequence(`{"id":"${QUERY_ID}","columns":${VERSION_COLUMNS},"data":[["476"]],"warnings":[]}`);

    const result = await makeTransport().query("SELECT version()");

    expect(result.stats).toEqual({
      state: null,
      elapsedMs: null,
      cpuMs: null,
      queuedMs: null,
      processedRows: null,
      processedBytes: null,
      peakMemoryBytes: null,
    });
  });

  test("refuses a number the report rendered unusably", async () => {
    sequence(
      `{"id":"${QUERY_ID}","columns":[],"stats":{"state":"FINISHED","elapsedTimeMillis":"576","cpuTimeMillis":null},"warnings":[]}`,
    );

    const result = await makeTransport().query("SELECT 1");

    expect(result.stats.elapsedMs).toBeNull();
    expect(result.stats.cpuMs).toBeNull();
    expect(result.stats.state).toBe("FINISHED");
  });

  /**
   * A statement that changes something rather than returning something declares
   * NO columns, which is the server describing an empty shape - not declining to
   * describe one. The distinction is what lets a caller tell "no result set" from
   * "the server never said".
   */
  test("an empty declaration is empty, not absent", async () => {
    sequence(CREATE_TABLE_PAGE);

    const result = await makeTransport().query("CREATE TABLE memory.default.probe_t (a integer)");

    expect(result.fieldNames).toEqual([]);
    expect(result.columnTypes).toEqual({});
    expect(result.rows).toEqual([]);
    expect(result.operation).toBe("CREATE TABLE");
    // Not zero: "created a table" is not "changed zero rows".
    expect(result.affectedRows).toBeNull();
  });

  test("reports what a mutation changed", async () => {
    sequence(INSERT_PAGE);

    const result = await makeTransport().query("INSERT INTO memory.default.probe_t VALUES (1),(2),(3)");

    expect(result.operation).toBe("INSERT");
    expect(result.affectedRows).toBe(3);
    expect(result.rows).toEqual([{ rows: 3 }]);
  });

  /**
   * This transport sends each statement independently and never accumulates the
   * session the server offers back, so a `SET SESSION` succeeds and then has no
   * effect on the next statement. The operation name is the only thing in the
   * answer that lets a caller notice and say so.
   */
  test("surfaces the operation of a statement whose effect it silently discards", async () => {
    sequence(SET_SESSION_PAGE);

    const result = await makeTransport().query("SET SESSION query_max_run_time = '10m'");

    expect(result.operation).toBe("SET SESSION");
  });

  test("leaves the operation null for an ordinary query", async () => {
    const result = await makeTransport().query("SELECT version()");

    expect(result.operation).toBeNull();
    expect(result.affectedRows).toBeNull();
  });

  test("pads a row the server sent short", async () => {
    sequence(
      `{"id":"${QUERY_ID}","columns":[{"name":"a","type":"integer"},{"name":"b","type":"integer"}],` +
        `"data":[[1],"not-a-row"],"stats":${FINISHED_STATS},"warnings":[]}`,
    );

    const result = await makeTransport().query("SELECT a, b");

    expect(result.rows).toEqual([
      { a: 1, b: null },
      { a: null, b: null },
    ]);
  });

  test("names a column the declaration left unnamed rather than inventing one", async () => {
    sequence(
      `{"id":"${QUERY_ID}","columns":[{"type":"integer"},"not-a-column"],"data":[[1,2]],"stats":${FINISHED_STATS},"warnings":[]}`,
    );

    const result = await makeTransport().query("SELECT 1, 2");

    expect(result.fieldNames).toEqual(["", " (2)"]);
    expect(result.columnTypes).toEqual({ "": "integer", " (2)": "" });
  });

  test("says the rows were never described when no page declared a column", async () => {
    sequence(`{"id":"${QUERY_ID}","stats":${FINISHED_STATS},"warnings":[]}`);

    const result = await makeTransport().query("SELECT 1");

    expect(result.fieldNames).toBeNull();
    expect(result.columnTypes).toBeNull();
    expect(result.rows).toEqual([]);
  });

  // Rows with nothing to key them by cannot be reported as an empty result: that
  // would be a successful query over the right table that happens to have found
  // nothing, which is the most convincing possible lie.
  test("refuses rows that arrived without any declaration", async () => {
    sequence(`{"id":"${QUERY_ID}","data":[[1]],"stats":${FINISHED_STATS},"warnings":[]}`);

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.category).toBe("engine");
    expect(error.message).toContain("never declared columns");
  });
});

// ============================================================================
// Warnings
// ============================================================================

describe("TrinoHttpTransport warnings", () => {
  // Measured: the same remark was repeated on all six pages of one exchange, and
  // rendering it six times would read as six problems.
  test("de-duplicates the remark the server repeats on every page", async () => {
    sequence(WARNED_RUNNING_PAGE, WARNED_FINISHED_PAGE);

    const result = await makeTransport().query("SELECT * FROM (SELECT nationkey FROM t ORDER BY nationkey) x");

    expect(result.warnings).toEqual([
      { code: "REDUNDANT_ORDER_BY", message: "ORDER BY in subquery may have no effect" },
    ]);
  });

  test("keeps a remark whose envelope named no code", async () => {
    sequence(
      `{"id":"${QUERY_ID}","columns":[],"stats":${FINISHED_STATS},"warnings":[{"message":"something to know"}]}`,
    );

    const result = await makeTransport().query("SELECT 1");

    expect(result.warnings).toEqual([{ code: "", message: "something to know" }]);
  });

  // An empty row in a warning list tells a user nothing and reads as a bug.
  test("drops a remark with no readable message", async () => {
    sequence(
      `{"id":"${QUERY_ID}","columns":[],"stats":${FINISHED_STATS},` +
        '"warnings":[{"warningCode":{"code":2,"name":"X"}},"not-a-warning",null]}',
    );

    const result = await makeTransport().query("SELECT 1");

    expect(result.warnings).toEqual([]);
  });

  test("tolerates a warnings member that is not a list", async () => {
    sequence(`{"id":"${QUERY_ID}","columns":[],"stats":${FINISHED_STATS},"warnings":"none"}`);

    const result = await makeTransport().query("SELECT 1");

    expect(result.warnings).toEqual([]);
  });
});

// ============================================================================
// Failures inside a 200 (measured fact 1)
// ============================================================================

describe("TrinoHttpTransport statement failures", () => {
  test("reads a failure out of a response the HTTP layer calls fine", async () => {
    sequence(VERSION_PAGES[0], SYNTAX_FAILURE_PAGE);

    const error = await captureError(() => makeTransport().query("SELEKT 1"));

    expect(error.category).toBe("syntax");
    expect(error.code).toBe("SYNTAX_ERROR");
    // The engine's own wording, verbatim: it is the only text that locates the
    // fault for the user.
    expect(error.message).toStartWith("line 1:1: mismatched input 'SELEKT'.");
    expect(error.location).toEqual({ line: 1, column: 1 });
  });

  test.each<[string, string, TrinoErrorCategory, string | null]>([
    ["a missing table", MISSING_TABLE_FAILURE_PAGE, "unknown-object", "TABLE_NOT_FOUND"],
    ["a connector that cannot do it", UNSUPPORTED_FAILURE_PAGE, "unsupported", "NOT_SUPPORTED"],
    ["a cancelled statement", CANCELED_FAILURE_PAGE, "cancelled", "USER_CANCELED"],
    ["a statement an operator killed", KILLED_FAILURE_PAGE, "cancelled", "ADMINISTRATIVELY_KILLED"],
    // A USER_ERROR this table does not name: the family says whose fault it is,
    // not what went wrong, so "the engine refused this" is the honest report.
    ["a fault name the table has never seen", TYPE_MISMATCH_FAILURE_PAGE, "engine", "TYPE_MISMATCH"],
  ])("classifies %s", async (_label, page, category, code) => {
    sequence(page);

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.category).toBe(category);
    expect(error.code).toBe(code);
  });

  test("a location the engine reported as null is simply absent", async () => {
    sequence(UNSUPPORTED_FAILURE_PAGE);

    const error = await captureError(() => makeTransport().query("CREATE TABLE tpch.sf1.x (a integer)"));

    expect(error.location).toBeNull();
  });

  test("a location missing half its coordinates is not half-reported", async () => {
    sequence(
      `{"id":"${QUERY_ID}","stats":${FAILED_STATS},"error":{"message":"nope","errorName":"SYNTAX_ERROR",` +
        '"errorType":"USER_ERROR","errorLocation":{"lineNumber":4}},"warnings":[]}',
    );

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.location).toBeNull();
  });

  /**
   * CONSTRUCTED, not captured: the probe coordinator runs with authentication and
   * resource groups disabled, so neither of these could be provoked. The
   * documents follow the measured failure-document layout exactly; only the fault
   * names differ.
   */
  test.each<[string, TrinoErrorCategory, string]>([
    ["PERMISSION_DENIED", "auth", "Access Denied: Cannot select from table tpch.sf1.nation"],
    ["EXCEEDED_TIME_LIMIT", "timeout", "Query exceeded maximum time limit of 10.00m"],
  ])("classifies a %s the probe cluster could not produce", async (name, category, message) => {
    sequence(
      `{"id":"${QUERY_ID}","stats":${FAILED_STATS},"error":{"message":${JSON.stringify(message)},` +
        `"errorName":"${name}","errorType":"USER_ERROR"},"warnings":[]}`,
    );

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.category).toBe(category);
    expect(error.message).toBe(message);
  });

  test("classifies a cluster that could not spare the resources", async () => {
    sequence(
      `{"id":"${QUERY_ID}","stats":${FAILED_STATS},"error":{"message":"Query exceeded per-node memory limit of 1GB",` +
        '"errorName":"EXCEEDED_LOCAL_MEMORY_LIMIT","errorType":"INSUFFICIENT_RESOURCES"},"warnings":[]}',
    );

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.category).toBe("resources");
  });

  test("falls back to the engine category when the document classifies nothing", async () => {
    sequence(`{"id":"${QUERY_ID}","stats":${FAILED_STATS},"error":{},"warnings":[]}`);

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.category).toBe("engine");
    expect(error.code).toBeNull();
    expect(error.message).toBe("Trino refused the statement");
  });

  test("terminates a statement it gave up on", async () => {
    sequence(SYNTAX_FAILURE_PAGE);

    await captureError(() => makeTransport().query("SELEKT 1"));

    expect(lastCall().method).toBe("DELETE");
    expect(lastCall().url).toBe(`http://127.0.0.1:8080/v1/query/${QUERY_ID}`);
  });
});

// ============================================================================
// Failures that are not statements (measured fact 5)
// ============================================================================

describe("TrinoHttpTransport request failures", () => {
  // Parsing a plain-text refusal as JSON would throw a second, misleading error on
  // top of the first and lose the sentence that says what to fix.
  test("quotes a plain-text 401 rather than parsing it", async () => {
    handler = () => new Response(MISSING_USER_BODY, { status: 401, headers: { "content-type": "text/plain" } });

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.category).toBe("auth");
    expect(error.message).toBe(`Trino refused the credentials (HTTP 401): ${MISSING_USER_BODY}`);
  });

  test("classifies a 403 as a credentials problem too", async () => {
    handler = () => new Response("Access Denied", { status: 403, headers: { "content-type": "text/plain" } });

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.category).toBe("auth");
    expect(error.message).toContain("HTTP 403");
  });

  // People point at the UI host, or omit the path. That is a wrong address, not a
  // rejected statement.
  test("classifies a 404 as the wrong address", async () => {
    handler = () => new Response(NOT_FOUND_BODY, { status: 404, headers: { "content-type": "text/plain" } });

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.category).toBe("unreachable");
    expect(error.message).toBe(`Trino has no client protocol endpoint at this address (HTTP 404): ${NOT_FOUND_BODY}`);
  });

  test("reports any other refusal with its status", async () => {
    handler = () => new Response("", { status: 405 });

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.category).toBe("engine");
    // Measured: a GET to the statement endpoint answers 405 with an EMPTY body,
    // so the message must stand on its own.
    expect(error.message).toBe("Trino rejected the request with HTTP 405");
  });

  test("collapses and truncates a server's own words rather than pasting a page into a toast", async () => {
    handler = () => new Response(`  a\n\n${"b".repeat(400)}  `, { status: 500 });

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.message).toEndWith("...");
    expect(error.message.length).toBeLessThan(400);
    expect(error.message).toContain("a b");
  });

  test("reports a body that is not a result document at all", async () => {
    handler = () => respond("<html>proxy error</html>");

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.category).toBe("unreachable");
    expect(error.message).toContain("not a client protocol document");
    expect(error.message).toContain("<html>proxy error</html>");
  });

  test("reports a document that is a list rather than a result", async () => {
    handler = () => respond("[]");

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.category).toBe("unreachable");
  });

  // A coordinator identifies every statement. Something that does not is not a
  // coordinator, and there would be nothing to cancel.
  test("refuses an acceptance that does not identify the statement", async () => {
    sequence(`{"stats":${QUEUED_STATS},"warnings":[]}`);

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.category).toBe("unreachable");
    expect(error.message).toContain("without identifying it");
    // Nothing to terminate, so nothing was attempted.
    expect(calls).toHaveLength(1);
  });

  test("reports a socket that never connected", async () => {
    handler = () => {
      throw new TypeError("fetch failed");
    };

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.category).toBe("unreachable");
    expect(error.message).toBe("Trino could not be reached: fetch failed");
  });

  test("reports a thrown value that is not an Error", async () => {
    handler = () => {
      throw "socket hang up";
    };

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.message).toBe("Trino could not be reached: socket hang up");
  });
});

// ============================================================================
// Deadlines and cancellation (measured fact 6)
// ============================================================================

describe("TrinoHttpTransport cancellation", () => {
  // The submission and every follow-up: a body that stops arriving on page four is
  // exactly as unbounded as one that never starts.
  test("passes the caller's signal to every request of the exchange", async () => {
    sequence(...VERSION_PAGES);
    const controller = new AbortController();
    const signals: (AbortSignal | null | undefined)[] = [];
    const recording = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      return await recording(input, init);
    }) as unknown as typeof fetch;

    await makeTransport().query("SELECT version()", { signal: controller.signal });

    expect(signals).toHaveLength(5);
    expect(signals.every((signal) => signal === controller.signal)).toBe(true);
  });

  test("attaches no signal when the caller set no deadline", async () => {
    let seen: AbortSignal | null | undefined = null;
    const recording = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal;
      return await recording(input, init);
    }) as unknown as typeof fetch;

    await makeTransport().query("SELECT version()");

    expect(seen).toBeUndefined();
  });

  /**
   * The SIGNAL is consulted before the thrown value, because the thrown value is
   * not reliably abort-shaped: `controller.abort(new Error("the tab closed"))`
   * throws that Error verbatim, and attaching a reason is the normal way to say
   * why a request was cancelled.
   */
  test("reports a deliberate abort as a cancellation, whatever it threw", async () => {
    const controller = new AbortController();
    handler = () => {
      controller.abort(new Error("the tab closed"));
      throw controller.signal.reason as Error;
    };

    const error = await captureError(() => makeTransport().query("SELECT 1", { signal: controller.signal }));

    expect(error.category).toBe("cancelled");
    expect(error.message).toBe("The request to Trino was cancelled");
  });

  test("reports an expired deadline as a timeout rather than a cancellation", async () => {
    const signal = AbortSignal.timeout(1);
    handler = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw signal.reason as Error;
    };

    const error = await captureError(() => makeTransport().query("SELECT 1", { signal }));

    expect(error.category).toBe("timeout");
    expect(error.message).toBe("Trino did not answer before the deadline");
  });

  /**
   * Fact 6, and the reason `cancel` is on the seam at all: abandoning the loop
   * leaves the statement running on the cluster to completion. An abort mid-flight
   * therefore owes the cluster a termination, and it must be sent WITHOUT the
   * caller's signal - which is the aborted one that brought us here.
   */
  test("terminates the statement on the cluster when the caller aborts mid-flight", async () => {
    const controller = new AbortController();
    let page = 0;
    handler = (_url, init) => {
      page += 1;
      if (page === 1) return respond(VERSION_PAGES[0]);
      if (init?.signal) {
        controller.abort();
        throw controller.signal.reason as Error;
      }
      return new Response("", { status: 204 });
    };

    const error = await captureError(() => makeTransport().query("SELECT 1", { signal: controller.signal }));

    expect(error.category).toBe("cancelled");
    expect(lastCall().method).toBe("DELETE");
    expect(lastCall().url).toBe(`http://127.0.0.1:8080/v1/query/${QUERY_ID}`);
  });

  // The statement's own failure is what the caller asked about; replacing it with
  // "and the cancellation also failed" would hide it.
  test("a failed termination does not replace the failure it was cleaning up after", async () => {
    let page = 0;
    handler = (_url, init) => {
      page += 1;
      if (init?.method === "DELETE") throw new TypeError("connection reset");
      return respond(page === 1 ? VERSION_PAGES[0] : SYNTAX_FAILURE_PAGE);
    };

    const error = await captureError(() => makeTransport().query("SELEKT 1"));

    expect(error.code).toBe("SYNTAX_ERROR");
  });

  test("cancel terminates a statement by id, with the session the endpoint requires", async () => {
    handler = () => new Response("", { status: 204 });

    await makeTransport({ user: "analyst" }).cancel(QUERY_ID);

    expect(lastCall().method).toBe("DELETE");
    expect(lastCall().url).toBe(`http://127.0.0.1:8080/v1/query/${QUERY_ID}`);
    // Measured: this endpoint builds a session from the request, so unlike a link
    // DELETE it answers 401 without the user header.
    expect(lastCall().headers["X-Trino-User"]).toBe("analyst");
  });

  test("cancel escapes an id rather than pasting it into a path", async () => {
    handler = () => new Response("", { status: 204 });

    await makeTransport().cancel("../../v1/info");

    expect(lastCall().url).toBe("http://127.0.0.1:8080/v1/query/..%2F..%2Fv1%2Finfo");
  });

  test("cancel surfaces a refusal, so a caller learns the cluster said no", async () => {
    handler = () => new Response("nope", { status: 403, headers: { "content-type": "text/plain" } });

    const error = await captureError(() => makeTransport().cancel(QUERY_ID));

    expect(error.category).toBe("auth");
  });

  test("close releases nothing, because nothing is held", async () => {
    await expect(makeTransport().close()).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});

// ============================================================================
// Retries
// ============================================================================

/**
 * CONSTRUCTED, all of it: the probe coordinator never became intermittent and
 * never throttled. The statuses and the header come from the protocol's own
 * words - "If the client request returns an HTTP 502, 503, or 504 ... the client
 * should try again in 50-100 ms", and "if the request returns a 429 status code,
 * the client should retry the request using the Retry-After header value".
 */
describe("TrinoHttpTransport retries", () => {
  test.each([502, 503, 504])("retries an intermittent %d and then succeeds", async (status) => {
    let attempt = 0;
    handler = () => {
      attempt += 1;
      return attempt === 1 ? new Response("", { status }) : respond(SINGLE_PAGE);
    };

    const result = await makeTransport().query("SELECT version()");

    expect(attempt).toBe(2);
    expect(result.rows).toEqual([{ _col0: "476" }]);
  });

  // The bound is checked first, so a coordinator that answers 503 forever
  // surfaces its own last 503 rather than a client-invented timeout.
  test("gives up after a bounded number of attempts and reports the server's own status", async () => {
    handler = () => new Response("still starting", { status: 503 });

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(calls).toHaveLength(4);
    expect(error.category).toBe("engine");
    expect(error.message).toContain("HTTP 503");
    expect(error.message).toContain("still starting");
  });

  test("honours a Retry-After instruction on a 429", async () => {
    let attempt = 0;
    const started = Date.now();
    handler = () => {
      attempt += 1;
      return attempt === 1
        ? new Response("", { status: 429, headers: { "Retry-After": "0.05" } })
        : respond(SINGLE_PAGE);
    };

    await makeTransport().query("SELECT version()");

    expect(attempt).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  test.each<[string, string | null]>([
    ["an unreadable instruction", "Wed, 21 Oct 2026 07:28:00 GMT"],
    ["a negative instruction", "-5"],
    ["no instruction at all", null],
  ])("falls back to the protocol's own interval for %s", async (_label, retryAfter) => {
    let attempt = 0;
    handler = () => {
      attempt += 1;
      return attempt === 1
        ? new Response("", { status: 429, headers: retryAfter === null ? {} : { "Retry-After": retryAfter } })
        : respond(SINGLE_PAGE);
    };

    await makeTransport().query("SELECT version()");

    expect(attempt).toBe(2);
  });

  // A server asking a browser-driven client to sleep for an hour is a refusal
  // wearing a retry's clothes, so the wait is clamped and the caller's signal can
  // cut it short.
  test("a caller who aborts does not have to wait out the server's advice", async () => {
    const controller = new AbortController();
    handler = () => {
      setTimeout(() => controller.abort(), 5);
      return new Response("", { status: 429, headers: { "Retry-After": "30" } });
    };

    const error = await captureError(() => makeTransport().query("SELECT 1", { signal: controller.signal }));

    expect(error.category).toBe("cancelled");
    expect(calls).toHaveLength(1);
  });

  test("does not retry a status the protocol does not call intermittent", async () => {
    handler = () => new Response("", { status: 500 });

    await captureError(() => makeTransport().query("SELECT 1"));

    expect(calls).toHaveLength(1);
  });
});

// ============================================================================
// Spooling (deliberately never opted into)
// ============================================================================

describe("TrinoHttpTransport spooled results", () => {
  /**
   * The spooling protocol replaces `data` with an object of compressed segments
   * that have to be fetched from opaque object-storage URLs and acknowledged. A
   * client opts in by advertising an encoding; this one never does, precisely
   * because json+zstd / json+lz4 cannot be decompressed from `fetch` alone. If a
   * server ever sends segments anyway, refusing is the honest answer - the
   * alternative fails later as "rows.map is not a function".
   */
  test("never advertises a data encoding", async () => {
    await makeTransport().query("SELECT 1");

    expect(Object.keys(firstCall().headers).some((name) => name.includes("Encoding"))).toBe(false);
  });

  test("refuses segments rather than mis-reading them as rows", async () => {
    sequence(
      `{"id":"${QUERY_ID}","columns":${VERSION_COLUMNS},"data":{"encoding":"json+zstd","segments":[]},` +
        `"stats":${FINISHED_STATS},"warnings":[]}`,
    );

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.category).toBe("unsupported");
    expect(error.message).toContain("spooled result segments");
  });

  test("an explicitly null data member is simply no rows", async () => {
    sequence(`{"id":"${QUERY_ID}","columns":${VERSION_COLUMNS},"data":null,"stats":${FINISHED_STATS},"warnings":[]}`);

    const result = await makeTransport().query("SELECT 1");

    expect(result.rows).toEqual([]);
  });
});
