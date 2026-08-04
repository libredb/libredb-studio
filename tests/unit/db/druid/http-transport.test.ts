/**
 * Druid HTTP transport (issue #265, design spec sections 2, 3, 5, 6, 11 and 13)
 *
 * globalThis.fetch is replaced per test and restored in afterEach. mock.module()
 * is deliberately not used: it is process-wide in bun, so mocking a module here
 * would poison every sibling test file sharing the process.
 *
 * Every response replayed below was captured verbatim from Apache Druid 37.0.0
 * over `POST /druid/v2/sql`, including the shapes that look like bugs and are not:
 * a 64-bit integer sent as an UNQUOTED JSON number that JSON.parse silently
 * rounds, an error whose `error` field is the literal string "druidException"
 * rather than a message, an HTTP 500 for `SELECT 1/0` that is an ordinary user
 * mistake, and a cancelled query that answers 200 and then truncates its own
 * body. Those are the cases a hand-written envelope parser gets wrong, so they
 * are pinned here rather than assumed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DruidHttpTransport } from "@/lib/db/providers/sql/druid/http-transport";
import { DRUID_TRANSPORT_FAILURE, DruidTransportError } from "@/lib/db/providers/sql/druid/transport";
import type { DatabaseConnection, DatabaseType } from "@/lib/db/types";

// ============================================================================
// Harness
// ============================================================================

// The DatabaseType union gains "druid" in the registration commit; the double
// assertion keeps this file compiling on either side of that change.
const DRUID: DatabaseType = "druid" as unknown as DatabaseType;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];
let handler: (url: string, init?: RequestInit) => Response | Promise<Response>;

function respond(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    // Live-verified: every answer, success and failure alike, is
    // `Content-Type: application/json`.
    headers: { "content-type": "application/json", ...init.headers },
  });
}

/**
 * `SELECT id, name, snowflake_id FROM libredb_demo WHERE region = ? LIMIT 1` as
 * the server returned it: three header rows (names, NATIVE types, SQL types) and
 * then the data, with the BIGINT unquoted - the exact 2^53+1 value that
 * JSON.parse rounds to ...992 (spec section 3).
 */
const SELECT_BODY =
  '[["id","name","snowflake_id"],["LONG","STRING","LONG"],["BIGINT","VARCHAR","BIGINT"],[1030,"alpha",9007199254740993]]';

/**
 * `SELECT CURRENT_TIMESTAMP AS t, (1 = 1) AS b, ARRAY[1,2] AS nums,
 *  ARRAY['alpha'] AS words, 1.5 AS d, CAST(NULL AS VARCHAR) AS n` verbatim.
 *
 * The two rows spec section 2 calls out are both here: the native type LIES for
 * `t` (LONG for an ISO string) and for `b` (LONG for `true`), and an ARRAY cell
 * arrives as a JSON STRING because `sqlStringifyArrays` defaults to true.
 */
const TYPED_BODY =
  '[["t","b","nums","words","d","n"],["LONG","LONG","ARRAY<LONG>","ARRAY<STRING>","DOUBLE","STRING"],' +
  '["TIMESTAMP","BOOLEAN","ARRAY","ARRAY","DECIMAL","VARCHAR"],' +
  '["2026-08-03T15:17:00.549Z",true,"[1,2]","[\\"alpha\\"]",1.5,null]]';

function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "druid-1",
    name: "Druid",
    type: DRUID,
    host: "127.0.0.1",
    port: 8888,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeTransport(overrides: Partial<DatabaseConnection> = {}): DruidHttpTransport {
  return new DruidHttpTransport(makeConnection(overrides));
}

function lastCall(): FetchCall {
  const call = calls.at(-1);
  if (!call) throw new Error("no request was made");
  return call;
}

/** The request body as text, which is what the 64-bit assertions have to read. */
function lastBodyText(): string {
  return String(lastCall().init?.body);
}

function lastBody(): Record<string, unknown> {
  return JSON.parse(lastBodyText()) as Record<string, unknown>;
}

function lastHeader(name: string): string | undefined {
  return (lastCall().init?.headers as Record<string, string> | undefined)?.[name];
}

/** The thrown DruidTransportError, or a failed expectation if none was thrown. */
async function captureError(run: () => Promise<unknown>): Promise<DruidTransportError> {
  try {
    await run();
  } catch (caught) {
    expect(caught).toBeInstanceOf(DruidTransportError);
    return caught as DruidTransportError;
  }
  throw new Error("the transport resolved where it should have thrown");
}

beforeEach(() => {
  calls = [];
  handler = () => respond(SELECT_BODY);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return await handler(url, init);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ============================================================================
// The request
// ============================================================================

describe("DruidHttpTransport request", () => {
  test("posts the statement verbatim to the SQL endpoint", async () => {
    await makeTransport().query('SELECT id FROM "libredb_demo"');

    expect(lastCall().url).toBe("http://127.0.0.1:8888/druid/v2/sql");
    expect(lastCall().init?.method).toBe("POST");
    expect(lastBody().query).toBe('SELECT id FROM "libredb_demo"');
  });

  // Live-verified: without this header the endpoint answers HTTP 400 before it
  // ever looks at the statement.
  test("declares the body as JSON, which the endpoint requires", async () => {
    await makeTransport().query("SELECT 1");

    expect(lastHeader("content-type")).toBe("application/json");
  });

  /**
   * Spec section 2, and a correctness decision rather than a preference.
   * Live-verified on 37.0.0:
   *   SELECT 1 AS c, 2 AS c  with resultFormat "object" -> [{"c":{...}},{"c":2}]
   * The object form silently drops every duplicate column but the last, and
   * duplicate output names are legal SQL that real joins produce.
   */
  test('asks for the array result format, never "object"', async () => {
    await makeTransport().query("SELECT 1 AS c, 2 AS c");

    expect(lastBody().resultFormat).toBe("array");
  });

  // All three, because the array form is positional: without them the response
  // carries no names and no types at all.
  test("asks for all three header rows", async () => {
    await makeTransport().query("SELECT 1");

    expect(lastBody()).toMatchObject({ header: true, typesHeader: true, sqlTypesHeader: true });
  });

  // Spec section 6, first half: verified, `timeout: 1` answers 504 with
  // `category: TIMEOUT` on a statement that otherwise takes milliseconds. Asking
  // the server to stop is what frees the cluster; abandoning the request
  // client-side leaves the query running.
  test("asks the server to stop at the deadline it was given", async () => {
    await makeTransport().query("SELECT 1", { timeoutMs: 30_000 });

    expect(lastBody().context).toEqual({ timeout: 30_000 });
  });

  test("sends no query context when no server deadline was given", async () => {
    await makeTransport().query("SELECT 1");

    expect(lastBody()).not.toHaveProperty("context");
  });

  test("sends no parameters array for a statement that has no placeholders", async () => {
    await makeTransport().query("SELECT 1");

    expect(lastBody()).not.toHaveProperty("parameters");
    await makeTransport().query("SELECT 1", { parameters: [] });

    expect(lastBody()).not.toHaveProperty("parameters");
  });

  // Spec section 6, second half (the #264 lesson): a server-side deadline only
  // starts counting once the server accepts the statement, so it cannot bound a
  // stalled connect, a TLS handshake, or a body that stops arriving part-way.
  test("arms a client-side deadline when one is given", async () => {
    await makeTransport().query("SELECT 1", { clientDeadlineMs: 5000 });

    const signal = lastCall().init?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  test("sends no signal when no client deadline is given", async () => {
    await makeTransport().query("SELECT 1", { timeoutMs: 1000 });

    expect(lastCall().init?.signal).toBeUndefined();
  });

  test("aborts the in-flight request once the client deadline passes", async () => {
    // Proves the signal is live rather than merely attached: the handler waits on
    // it instead of answering, which is the stalled-body case a server-side
    // deadline cannot reach.
    handler = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });

    const error = await captureError(() => makeTransport().query("SELECT 1", { clientDeadlineMs: 10 }));

    expect(error.message.toLowerCase()).toContain("timed out");
    expect(error.category).toBe(DRUID_TRANSPORT_FAILURE);
  });

  // Spec section 1, live-verified: a default install loads no security extension
  // and ignores an Authorization header entirely - a bogus Basic header still
  // answers 200 - so credentials are optional and only sent when configured, for
  // the druid-basic-security extension.
  test("authenticates with HTTP Basic when the connection carries credentials", async () => {
    await makeTransport({ user: "admin", password: "password1" }).query("SELECT 1");

    expect(lastHeader("authorization")).toBe(`Basic ${Buffer.from("admin:password1").toString("base64")}`);
  });

  test("sends an empty password rather than dropping the header", async () => {
    await makeTransport({ user: "admin" }).query("SELECT 1");

    expect(lastHeader("authorization")).toBe(`Basic ${Buffer.from("admin:").toString("base64")}`);
  });

  test("sends no authorization header when the connection names no user", async () => {
    await makeTransport().query("SELECT 1");

    expect(lastHeader("authorization")).toBeUndefined();
  });
});

// ============================================================================
// The endpoint
// ============================================================================

describe("DruidHttpTransport endpoint", () => {
  test("defaults to the Router's port on localhost", async () => {
    await new DruidHttpTransport({ id: "druid-2", name: "Druid", type: DRUID, createdAt: new Date() }).query(
      "SELECT 1",
    );

    expect(lastCall().url).toBe("http://localhost:8888/druid/v2/sql");
  });

  // Spec section 11: the Broker on 8082 serves the same endpoint with the same
  // envelope, so a Broker-only deployment needs nothing but its port.
  test("talks to a Broker exactly as it talks to a Router", async () => {
    await makeTransport({ port: 8082 }).query("SELECT 1");

    expect(lastCall().url).toBe("http://127.0.0.1:8082/druid/v2/sql");
  });

  test("uses TLS when the connection asks for it", async () => {
    await makeTransport({ ssl: { mode: "require" } }).query("SELECT 1");

    expect(lastCall().url).toBe("https://127.0.0.1:8888/druid/v2/sql");
  });

  // The #264 lesson: the scheme must be able to turn TLS OFF as well as on, or a
  // connection that explicitly disables it still tries to handshake.
  test("keeps plain HTTP when SSL is explicitly disabled", async () => {
    await makeTransport({ ssl: { mode: "disable" } }).query("SELECT 1");

    expect(lastCall().url).toBe("http://127.0.0.1:8888/druid/v2/sql");
  });

  // A bare IPv6 literal is not a legal URL authority, so it has to be bracketed
  // or the request never leaves the process.
  test("brackets a bare IPv6 host", async () => {
    await makeTransport({ host: "::1" }).query("SELECT 1");

    expect(lastCall().url).toBe("http://[::1]:8888/druid/v2/sql");
  });

  test("leaves an already-bracketed IPv6 host alone", async () => {
    await makeTransport({ host: "[::1]" }).query("SELECT 1");

    expect(lastCall().url).toBe("http://[::1]:8888/druid/v2/sql");
  });
});

// ============================================================================
// A tabular result
// ============================================================================

describe("DruidHttpTransport results", () => {
  test("drops the three header rows and rebuilds the rows from the declared names", async () => {
    const result = await makeTransport().query("SELECT id, name, snowflake_id FROM libredb_demo");

    expect(result.rows).toEqual([{ id: 1030, name: "alpha", snowflake_id: "9007199254740993" }]);
    expect(result.fieldNames).toEqual(["id", "name", "snowflake_id"]);
  });

  test("keeps both type vocabularies, keyed by the same names", async () => {
    const result = await makeTransport().query("SELECT id, name, snowflake_id FROM libredb_demo");

    expect(result.sqlTypes).toEqual({ id: "BIGINT", name: "VARCHAR", snowflake_id: "BIGINT" });
    expect(result.nativeTypes).toEqual({ id: "LONG", name: "STRING", snowflake_id: "LONG" });
  });

  // Spec section 2: the native type is the one that lies, which is why both are
  // carried and why the SQL type is the one the grid labels a column with.
  test("carries the SQL type that disagrees with the native one", async () => {
    handler = () => respond(TYPED_BODY);

    const result = await makeTransport().query("SELECT CURRENT_TIMESTAMP AS t, (1 = 1) AS b");

    expect(result.sqlTypes).toMatchObject({ t: "TIMESTAMP", b: "BOOLEAN", nums: "ARRAY", d: "DECIMAL" });
    expect(result.nativeTypes).toMatchObject({ t: "LONG", b: "LONG", nums: "ARRAY<LONG>", d: "DOUBLE" });
  });

  // `sqlStringifyArrays` defaults to true, so an ARRAY cell really is a JSON
  // string on the wire. Parsing it back would invent a shape no Druid client
  // shows, so the value is carried verbatim.
  test("carries an ARRAY cell as the JSON string Druid sent", async () => {
    handler = () => respond(TYPED_BODY);

    const result = await makeTransport().query("SELECT ARRAY[1,2] AS nums");

    expect(result.rows[0].nums).toBe("[1,2]");
    expect(result.rows[0].words).toBe('["alpha"]');
    expect(result.rows[0].b).toBe(true);
    expect(result.rows[0].n).toBeNull();
  });

  /**
   * Spec section 2, live-verified:
   *   SELECT 1 AS c, 2 AS c -> [["c","c"],["LONG","LONG"],["INTEGER","INTEGER"],[1,2]]
   * Rows are records, so the repeat has to be disambiguated as the row is built
   * or the second column is lost before the seam rather than after it.
   */
  test("disambiguates a duplicated output name so both columns survive", async () => {
    handler = () => respond('[["c","c"],["LONG","LONG"],["INTEGER","INTEGER"],[1,2]]');

    const result = await makeTransport().query("SELECT 1 AS c, 2 AS c");

    expect(result.fieldNames).toEqual(["c", "c (2)"]);
    expect(result.rows).toEqual([{ c: 1, "c (2)": 2 }]);
    expect(result.sqlTypes).toEqual({ c: "INTEGER", "c (2)": "INTEGER" });
    expect(result.nativeTypes).toEqual({ c: "LONG", "c (2)": "LONG" });
  });

  test("disambiguates a third repeat too", async () => {
    handler = () => respond('[["c","c","c"],["LONG","LONG","LONG"],["INTEGER","INTEGER","INTEGER"],[1,2,3]]');

    const result = await makeTransport().query("SELECT 1 AS c, 2 AS c, 3 AS c");

    expect(result.fieldNames).toEqual(["c", "c (2)", "c (3)"]);
    expect(result.rows).toEqual([{ c: 1, "c (2)": 2, "c (3)": 3 }]);
  });

  // `SELECT 1 AS c, 2 AS "c (2)", 3 AS c` is legal, and the obvious spelling for
  // the third column is already taken by the second. Uniqueness is the seam's
  // invariant, so the suffix keeps climbing until it is free.
  test("keeps climbing when the disambiguated name is itself declared", async () => {
    handler = () => respond('[["c","c (2)","c"],["LONG","LONG","LONG"],["INTEGER","INTEGER","INTEGER"],[1,2,3]]');

    const result = await makeTransport().query('SELECT 1 AS c, 2 AS "c (2)", 3 AS c');

    expect(result.fieldNames).toEqual(["c", "c (2)", "c (3)"]);
    expect(result.rows).toEqual([{ c: 1, "c (2)": 2, "c (3)": 3 }]);
  });

  // Live-verified: `SELECT id FROM libredb_demo WHERE id = -1` answers
  // `[["id"],["LONG"],["BIGINT"]]` - all three header rows, no data.
  test("describes the columns of a result set with no rows", async () => {
    handler = () => respond('[["id"],["LONG"],["BIGINT"]]');

    const result = await makeTransport().query("SELECT id FROM libredb_demo WHERE id = -1");

    expect(result.rows).toEqual([]);
    expect(result.fieldNames).toEqual(["id"]);
    expect(result.sqlTypes).toEqual({ id: "BIGINT" });
  });

  // An empty array carries no header at all, and with all three flags set even a
  // zero-row result answers `[["id"],["LONG"],["BIGINT"]]` (live-verified). So this
  // cannot be a healthy answer - it is a truncated body or a proxy rewrite - and
  // reporting it as `{ rows: [] }` would render the most convincing possible lie: a
  // successful query over the right datasource that simply found nothing.
  test("raises on an empty array rather than reporting an empty result", async () => {
    handler = () => respond("[]");

    await expect(makeTransport().query("SELECT 1")).rejects.toThrow(/incomplete/i);
  });

  // Same reasoning as the empty array: a result set with no rows still carries all
  // three header rows, and a bare `SET` - the only other statement form Druid's
  // grammar accepts - is rejected outright rather than answering short. There is no
  // legitimate way to receive fewer than three, so data loss surfaces as a failure.
  test.each<[string, string]>([
    ["one row", '[["id"]]'],
    ["two rows", '[["id"],["LONG"]]'],
    ["a header that is not a row", '["id",["LONG"],["BIGINT"],[1]]'],
  ])("raises when the header is %s", async (_label, body) => {
    handler = () => respond(body);

    await expect(makeTransport().query("SELECT id FROM libredb_demo")).rejects.toThrow(/incomplete/i);
  });

  test("fills a short data row with nulls rather than dropping the row", async () => {
    handler = () => respond('[["a","b"],["LONG","LONG"],["BIGINT","BIGINT"],[1]]');

    const result = await makeTransport().query("SELECT a, b FROM t");

    expect(result.rows).toEqual([{ a: 1, b: null }]);
  });

  test("reads a row that is not an array as one with no values", async () => {
    handler = () => respond('[["a"],["LONG"],["BIGINT"],7]');

    const result = await makeTransport().query("SELECT a FROM t");

    expect(result.rows).toEqual([{ a: null }]);
  });

  // Never fabricate a type: a types row something rewrote describes fewer columns
  // rather than more, and the names still describe the rows.
  test("omits a type it was not told rather than inventing one", async () => {
    handler = () => respond('[["a","b"],["LONG"],"nope",[1,2]]');

    const result = await makeTransport().query("SELECT a, b FROM t");

    expect(result.nativeTypes).toEqual({ a: "LONG" });
    expect(result.sqlTypes).toEqual({});
    expect(result.rows).toEqual([{ a: 1, b: 2 }]);
  });

  // Spec section 0 and the seam: live-verified on 37.0.0, the endpoint answers
  // with the rows and nothing else - no timing anywhere in the body or the
  // response metadata - so the transport times its own exchange and never
  // pretends the number came from the server.
  test("times the exchange itself", async () => {
    handler = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return respond(SELECT_BODY);
    };

    const result = await makeTransport().query("SELECT 1");

    expect(Number.isFinite(result.executionTimeMs)).toBe(true);
    expect(result.executionTimeMs).toBeGreaterThan(0);
  });

  test("describes exactly the neutral result and nothing else", async () => {
    const result = await makeTransport().query("SELECT 1");

    expect(Object.keys(result).sort()).toEqual([
      "executionTimeMs",
      "fieldNames",
      "nativeTypes",
      "rows",
      "sqlTypes",
      "unavailableSegments",
    ]);
  });
});

// ============================================================================
// Segment availability (#273)
// ============================================================================

/**
 * A 200 whose row set is INCOMPLETE. Druid reports that in the response context
 * header rather than in the body, so a transport that reads only the body
 * cannot tell this apart from a complete answer that found fewer rows.
 *
 * Only the LENGTH of the array is read, never an entry's shape - the descriptor
 * below is illustrative, and a future Druid that spells one differently must not
 * change what this reports.
 */
const MISSING_SEGMENTS_CONTEXT =
  '{"missingSegments":[{"itvl":"2026-08-01T00:00:00.000Z/2026-08-02T00:00:00.000Z","ver":"v1","part":0},' +
  '{"itvl":"2026-08-02T00:00:00.000Z/2026-08-03T00:00:00.000Z","ver":"v1","part":0}]}';

describe("DruidHttpTransport segment availability", () => {
  function respondWithContext(context: string): void {
    handler = () => respond(SELECT_BODY, { headers: { "x-druid-response-context": context } });
  }

  test("counts the segments the cluster could not reach", async () => {
    respondWithContext(MISSING_SEGMENTS_CONTEXT);

    const result = await makeTransport().query("SELECT * FROM libredb_demo");

    expect(result.unavailableSegments).toBe(2);
    // The rows still arrive: the answer is partial, not failed.
    expect(result.rows).toHaveLength(1);
  });

  test("reports zero when the cluster said every segment was there", async () => {
    respondWithContext('{"missingSegments":[]}');

    const result = await makeTransport().query("SELECT * FROM libredb_demo");

    expect(result.unavailableSegments).toBe(0);
  });

  test("reports nothing rather than zero when the answer said nothing about availability", async () => {
    // "The source did not say" and "the source said none" are different facts,
    // and only the second one licenses calling a result complete.
    handler = () => respond(SELECT_BODY);

    const result = await makeTransport().query("SELECT * FROM libredb_demo");

    expect(result.unavailableSegments).toBeNull();
  });

  test("reports nothing when the response context is not readable", async () => {
    respondWithContext("<html>proxied</html>");

    const result = await makeTransport().query("SELECT * FROM libredb_demo");

    expect(result.unavailableSegments).toBeNull();
  });

  test("reports nothing when the context carries no segment list", async () => {
    respondWithContext('{"queryId":"abc-123"}');

    const result = await makeTransport().query("SELECT * FROM libredb_demo");

    expect(result.unavailableSegments).toBeNull();
  });
});

describe("DruidHttpTransport 64-bit integers", () => {
  test("hands a BIGINT beyond the safe range to the caller as an exact string", async () => {
    const result = await makeTransport().query("SELECT snowflake_id FROM libredb_demo");

    expect(result.rows[0].snowflake_id).toBe("9007199254740993");
    // The same thing the `pg` driver already does for int8: a value the UI can
    // display and copy exactly, rather than a number rounded on arrival.
    expect(typeof result.rows[0].snowflake_id).toBe("string");
  });

  test("leaves a safe integer a number, so the grid can still sort it", async () => {
    const result = await makeTransport().query("SELECT id FROM libredb_demo");

    expect(result.rows[0].id).toBe(1030);
  });
});

// ============================================================================
// Failures (spec section 5)
// ============================================================================

describe("DruidHttpTransport failures", () => {
  function failWith(status: number, body: string): void {
    handler = () => respond(body, { status });
  }

  /**
   * The modern envelope, captured from `SELECT * FROM nope`. `error` is a
   * DISCRIMINATOR here - its value is the literal string "druidException" - so a
   * transport that shows `error` prints that to the person who mistyped the name.
   */
  const DRUID_EXCEPTION =
    '{"error":"druidException","errorCode":"invalidInput","persona":"USER","category":"INVALID_INPUT",' +
    '"errorMessage":"Object \'nope\' not found (line [1], column [15])",' +
    '"context":{"sourceType":"sql","line":"1","column":"15","endLine":"1","endColumn":"18"}}';

  /** The legacy wrapper, captured from a `context.timeout` of 1 ms. */
  const LEGACY_TIMEOUT =
    '{"error":"Query timeout","errorClass":"org.apache.druid.query.QueryTimeoutException",' +
    '"host":"172.18.0.5:8083","errorCode":"legacyQueryException","persona":"OPERATOR","category":"TIMEOUT",' +
    '"errorMessage":"url[http://172.18.0.5:8083/druid/v2/] timed out",' +
    '"context":{"host":"172.18.0.5:8083","errorClass":"org.apache.druid.query.QueryTimeoutException",' +
    '"legacyErrorCode":"Query timeout"}}';

  test("reads the message out of errorMessage, never out of the discriminator", async () => {
    failWith(400, DRUID_EXCEPTION);

    const error = await captureError(() => makeTransport().query("SELECT * FROM nope"));

    expect(error.message).toBe("Object 'nope' not found (line [1], column [15])");
    expect(error.message).not.toContain("druidException");
    expect(error.is("INVALID_INPUT")).toBe(true);
    expect(error.errorCode).toBe("invalidInput");
    expect(error.persona).toBe("USER");
  });

  test("classifies the legacy wrapper the same way", async () => {
    failWith(504, LEGACY_TIMEOUT);

    const error = await captureError(() => makeTransport().query("SELECT COUNT(*) FROM libredb_demo"));

    // The specific message, not the legacy `error` field's "Query timeout".
    expect(error.message).toBe("url[http://172.18.0.5:8083/druid/v2/] timed out");
    expect(error.is("TIMEOUT")).toBe(true);
    expect(error.errorCode).toBe("legacyQueryException");
    expect(error.persona).toBe("OPERATOR");
  });

  /**
   * Spec section 5, point 3, and the reason nothing here branches on the status:
   * `SELECT 1/0` answers HTTP 500 with `persona: "ADMIN"` and
   * `category: "UNCATEGORIZED"` for what is an ordinary user mistake. Reading 5xx
   * as "the cluster is broken" would tell the user the wrong thing entirely.
   */
  test("does not classify on the HTTP status", async () => {
    failWith(
      500,
      '{"error":"druidException","errorCode":"general","persona":"ADMIN","category":"UNCATEGORIZED","errorMessage":"/ by zero","context":{}}',
    );

    const error = await captureError(() => makeTransport().query("SELECT 1/0 AS z"));

    expect(error.message).toBe("/ by zero");
    expect(error.is("UNCATEGORIZED")).toBe(true);
    expect(error.isMonitoringUnavailable()).toBe(false);
    expect(error.persona).toBe("ADMIN");
  });

  // Live-verified: an unsupported statement is a 400 whose message already names
  // both the reason and the alternative, which is more useful than anything the
  // provider could substitute (spec section 8).
  test("passes an unsupported statement's own explanation through", async () => {
    failWith(
      400,
      '{"error":"druidException","errorCode":"general","persona":"USER","category":"INVALID_INPUT",' +
        '"errorMessage":"INSERT operations are not supported by requested SQL engine [native], consider using MSQ.",' +
        '"context":{}}',
    );

    const error = await captureError(() => makeTransport().query("INSERT INTO t SELECT 1"));

    expect(error.message).toContain("consider using MSQ");
  });

  // The legacy shape puts a real message in `error` as well as in `errorMessage`,
  // so it is the right fallback - but only when errorMessage is missing.
  test("falls back to the error field when the envelope carries no errorMessage", async () => {
    failWith(500, '{"error":"Unknown exception","errorCode":"legacyQueryException","category":"RUNTIME_FAILURE"}');

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.message).toBe("Unknown exception");
    expect(error.is("RUNTIME_FAILURE")).toBe(true);
  });

  // The one thing that must never reach a user: the discriminator as a message.
  test("never falls back to the discriminator itself", async () => {
    failWith(400, '{"error":"druidException","errorCode":"invalidInput","category":"INVALID_INPUT"}');

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.message).toBe("Druid request failed with HTTP 400");
    expect(error.is("INVALID_INPUT")).toBe(true);
  });

  test("describes the status when the envelope classified nothing", async () => {
    failWith(503, "{}");

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.message).toBe("Druid request failed with HTTP 503");
    expect(error.category).toBe(DRUID_TRANSPORT_FAILURE);
    expect(error.errorCode).toBe(DRUID_TRANSPORT_FAILURE);
    expect(error.persona).toBeNull();
  });

  // Spec section 5, point 4: a proxy's HTML page and an empty body carry nothing
  // to classify, and they must still leave as the seam's own error type - a raw
  // SyntaxError would slip past every instanceof branch in the provider.
  test.each<[string, string]>([
    ["a proxy's HTML error page", "<html><head><title>502 Bad Gateway</title></head></html>"],
    ["an empty body", ""],
    ["a JSON array", "[]"],
    ["a JSON scalar", '"nope"'],
    ["JSON null", "null"],
  ])("normalizes %s", async (_label, body) => {
    failWith(502, body);

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error).toBeInstanceOf(DruidTransportError);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect(error.message).toBe("Druid request failed with HTTP 502");
    expect(error.category).toBe(DRUID_TRANSPORT_FAILURE);
  });

  test("ignores an envelope field that is not a string", async () => {
    failWith(400, '{"errorMessage":42,"category":["INVALID_INPUT"],"errorCode":null,"persona":false}');

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.message).toBe("Druid request failed with HTTP 400");
    expect(error.category).toBe(DRUID_TRANSPORT_FAILURE);
    expect(error.persona).toBeNull();
  });

  test("ignores an empty message rather than showing a blank error", async () => {
    failWith(400, '{"errorMessage":"","error":"","category":"INVALID_INPUT"}');

    expect((await captureError(() => makeTransport().query("SELECT 1"))).message).toBe(
      "Druid request failed with HTTP 400",
    );
  });
});

// ============================================================================
// Mid-stream failures (spec section 5, and the #264 lesson)
// ============================================================================

/**
 * Druid CAN fail after it has started answering, and this is what it looks like.
 *
 * Live-reproduced on 37.0.0: a large streamed result (`SELECT REPEAT(name,
 * 200000) FROM libredb_demo` read slowly) cancelled through
 * `DELETE /druid/v2/sql/{sqlQueryId}` mid-flight answers HTTP **200**, streams
 * 3.6 MB, and then simply stops - the body is cut mid-value with no closing
 * bracket. Druid signals it by WITHHOLDING the `X-Druid-Response-Complete: true`
 * trailer it otherwise sends, and an HTTP trailer is not reachable through
 * `fetch` at all, so the truncated body is the only evidence the client has.
 *
 * The failure the ClickHouse work warned about is therefore real here too, only
 * with a different shape: no fence to cut on, just an unparseable tail. Reporting
 * a JSON complaint would tell the person who ran the query nothing; reporting an
 * empty success would be worse.
 *
 * Verified NOT to happen, so it is deliberately not handled: a failure that the
 * Broker learns about before it commits the status - `SELECT 1/(id-1005)` over 35
 * MB of already-transferred rows - still answers a clean 500 whose body is the
 * error envelope ALONE, with no partial result in front of it (the opposite of
 * ClickHouse's buffered case).
 */
describe("DruidHttpTransport mid-stream failures", () => {
  test("reports a truncated body as the incomplete response it is", async () => {
    handler = () => respond('[["pad"],["STRING"],["VARCHAR"],["gammagammagam');

    const error = await captureError(() => makeTransport().query("SELECT REPEAT(name, 200000) FROM libredb_demo"));

    expect(error).not.toBeInstanceOf(SyntaxError);
    expect(error.message).toContain("incomplete");
    expect(error.category).toBe(DRUID_TRANSPORT_FAILURE);
    // A parse complaint would bury the only useful part of the failure.
    expect(error.message).not.toContain("JSON.parse");
  });

  // Reporting no rows would be the worst outcome of the three: the person who ran
  // the query would read a truncated answer as the whole answer.
  test.each<[string, string]>([
    ["cut at a row boundary", '[["pad"],["STRING"],["VARCHAR"],['],
    ["cut inside the header", '[["pad"],["STRING"'],
    ["a 200 with no body at all", ""],
  ])("does not report an empty success for a body %s", async (_label, body) => {
    handler = () => respond(body);

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.message).toContain("incomplete");
  });

  // An envelope where an array was promised is either an error Druid committed
  // after the status or a proxy rewriting the body. Reading it as an error beats
  // reporting a parse failure, and beats reporting no rows.
  test("classifies an error envelope that arrives with a 200", async () => {
    handler = () =>
      respond(
        '{"error":"druidException","errorCode":"invalidInput","persona":"USER","category":"CANCELED","errorMessage":"Query cancelled"}',
      );

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.message).toBe("Query cancelled");
    expect(error.is("CANCELED")).toBe(true);
  });

  test("normalizes a 200 body that is neither an array nor an envelope", async () => {
    handler = () => respond('"unexpected"');

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.message).toContain("array");
    expect(error.category).toBe(DRUID_TRANSPORT_FAILURE);
  });
});

// ============================================================================
// Failures that are not the server's
// ============================================================================

describe("DruidHttpTransport transport failures", () => {
  // Every throw out of the seam has to be a DruidTransportError or the provider's
  // instanceof branches fall through to a generic message.
  test("normalizes a refused connection", async () => {
    handler = () => {
      throw new Error("fetch failed");
    };

    const error = await captureError(() => makeTransport().query("SELECT 1"));

    expect(error.message).toBe("Druid request failed: fetch failed");
    expect(error.category).toBe(DRUID_TRANSPORT_FAILURE);
    expect(error.errorCode).toBe(DRUID_TRANSPORT_FAILURE);
  });

  test("normalizes an aborted request", async () => {
    handler = () => {
      const abort = new Error("The operation was aborted.");
      abort.name = "AbortError";
      throw abort;
    };

    expect((await captureError(() => makeTransport().query("SELECT 1"))).message).toBe(
      "Druid request failed: The operation was aborted.",
    );
  });

  test("normalizes a rejection that is not an Error at all", async () => {
    handler = () => {
      throw "socket hang up";
    };

    expect((await captureError(() => makeTransport().query("SELECT 1"))).message).toBe(
      "Druid request failed: socket hang up",
    );
  });

  // src/lib/db/errors.ts keys on "timeout"/"timed out" in the message, and a
  // transport-level stall has no Druid category to key on instead.
  test("reports a client-side timeout as a timeout, so the shared mapping classifies it", async () => {
    handler = () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };

    expect(
      (await captureError(() => makeTransport().query("SELECT 1", { clientDeadlineMs: 5 }))).message.toLowerCase(),
    ).toContain("timed out");
  });
});

// ============================================================================
// Parameters (spec section 13)
// ============================================================================

/**
 * Live-verified: `?` placeholders with `parameters: [{type, value}]` really
 * execute on Druid, so unlike ClickHouse (#264, whose endpoint has no
 * equivalent) a parameterized statement is a first-class case here.
 */
describe("DruidHttpTransport parameters", () => {
  async function sendParameters(...parameters: unknown[]): Promise<{ type: string; value: unknown }[]> {
    await makeTransport().query("SELECT 1 WHERE x = ?", { parameters });
    return lastBody().parameters as { type: string; value: unknown }[];
  }

  test.each<[string, unknown, { type: string; value: unknown }]>([
    ["a string", "emea", { type: "VARCHAR", value: "emea" }],
    ["an integral number", 5, { type: "BIGINT", value: 5 }],
    ["an integral float", 5.0, { type: "BIGINT", value: 5 }],
    ["a fractional number", 1.5, { type: "DOUBLE", value: 1.5 }],
    ["a negative fraction", -0.25, { type: "DOUBLE", value: -0.25 }],
    ["true", true, { type: "BOOLEAN", value: true }],
    ["false", false, { type: "BOOLEAN", value: false }],
    ["null", null, { type: "VARCHAR", value: null }],
    ["undefined", undefined, { type: "VARCHAR", value: null }],
  ])("maps %s onto the type Druid expects", async (_label, value, expected) => {
    expect(await sendParameters(value)).toEqual([expected]);
  });

  // Live-verified: `{"type":"TIMESTAMP","value":0}` against `__time > ?` matches
  // all 50 rows, so epoch millis is the encoding.
  test("maps a Date onto epoch millis", async () => {
    expect(await sendParameters(new Date("2026-08-03T15:17:00.549Z"))).toEqual([
      { type: "TIMESTAMP", value: 1785770220549 },
    ]);
  });

  test("keeps the parameters in the order the placeholders appear", async () => {
    await makeTransport().query("SELECT 1 WHERE a = ? AND b = ?", { parameters: ["emea", 5] });

    expect(lastBody().parameters).toEqual([
      { type: "VARCHAR", value: "emea" },
      { type: "BIGINT", value: 5 },
    ]);
  });

  /**
   * A bigint has no JSON form, and the obvious workaround is REFUSED by the
   * server. Live-verified on 37.0.0:
   *   {"type":"BIGINT","value":"1"}   (a string) -> 500 {"errorCode":"general",
   *      "category":"RUNTIME_FAILURE","errorMessage":"Cannot handle query"}
   *   {"type":"BIGINT","value":9007199254740993} (unquoted) -> matches the row
   * So the literal has to reach the body unquoted, which is the whole reason
   * JSON.rawJSON is used. Design spec section 13 says "as a string value"; that
   * is the one line of the spec the live cluster contradicts.
   */
  // Built with BigInt() rather than a `9007199254740993n` literal: tsconfig targets
  // ES2017, where the literal syntax is a compile error and the global is not.
  test("sends a bigint as an unquoted JSON literal, which is what the server accepts", async () => {
    await makeTransport().query("SELECT 1 WHERE snowflake_id = ?", { parameters: [BigInt("9007199254740993")] });

    expect(lastBodyText()).toContain('{"type":"BIGINT","value":9007199254740993}');
    expect(lastBodyText()).not.toContain('"9007199254740993"');
  });

  test("sends a negative bigint the same way", async () => {
    await makeTransport().query("SELECT 1 WHERE n = ?", { parameters: [BigInt("-9007199254740993")] });

    expect(lastBodyText()).toContain('{"type":"BIGINT","value":-9007199254740993}');
  });

  /**
   * The parameters array is serialized structurally, not by marking the digits and
   * substituting them back over the finished body. A marker is only as private as the
   * values flowing through it: a caller whose VARCHAR parameter happened to contain the
   * sentinel would have had that string silently unquoted into a number, changing its
   * JSON type. These are the exact strings the previous NUL-marker version would have
   * corrupted, and they must now survive as strings.
   */
  test.each<[string, string]>([
    ["a NUL-wrapped digit run", "\u0000123\u0000"],
    ["a NUL-wrapped negative digit run", "\u0000-9007199254740993\u0000"],
    ["the literal escape text", "\\u0000123\\u0000"],
  ])("keeps %s as a VARCHAR string rather than unquoting it into a number", async (_label, value) => {
    const sent = await sendParameters(value);

    expect(sent).toEqual([{ type: "VARCHAR", value }]);
    // Round-trips as JSON, so nothing downstream sees a malformed body.
    expect(JSON.parse(lastBodyText())).toBeTruthy();
  });

  test("still emits a bigint literal when a marker-looking string travels beside it", async () => {
    await makeTransport().query("SELECT 1 WHERE a = ? AND b = ?", {
      parameters: ["\u0000123\u0000", BigInt("9007199254740993")],
    });

    expect(lastBodyText()).toContain('{"type":"BIGINT","value":9007199254740993}');
    // Number("...") rather than a literal: oxlint's no-loss-of-precision is right that
    // a literal this wide cannot be held exactly, and JSON.parse produces the same
    // rounded double, so this compares like with like. The EXACT value is asserted
    // against the wire TEXT above, which is the only place it survives.
    expect(lastBody().parameters).toEqual([
      { type: "VARCHAR", value: "\u0000123\u0000" },
      { type: "BIGINT", value: Number("9007199254740993") },
    ]);
  });

  /**
   * An integral `number` outside the safe range is ALREADY wrong by the time it
   * arrives: `9007199254740993` written as a number literal is `...992` before the
   * transport sees it, and no code here can recover the digit. Sending it would filter
   * on a value the user never wrote and return a plausible wrong row set, so the
   * refusal names the fix. `bigint` is the exact path and is unaffected.
   */
  // Built with Number("...") rather than literals: oxlint's no-loss-of-precision flags
  // a literal this wide, and it is correct - which is precisely the point being tested.
  // The parse yields the same already-rounded double a caller's literal would have.
  test.each<[string, number]>([
    ["2^53 + 1 rounded down by the parser", Number("9007199254740993")],
    ["a negative unsafe integer", Number("-9007199254740993")],
    ["an integral double far past Druid's BIGINT range", 1e21],
  ])("refuses %s rather than filtering on a value the caller never wrote", async (_label, value) => {
    const error = await captureError(() => makeTransport().query("SELECT 1 WHERE x = ?", { parameters: [value] }));

    expect(error.message).toContain("already rounded");
    expect(error.message).toContain("pass a bigint instead");
    expect(calls).toEqual([]);
  });

  // The boundary itself is exact, so it must still go through.
  test("accepts the largest safe integer", async () => {
    expect(await sendParameters(Number.MAX_SAFE_INTEGER)).toEqual([{ type: "BIGINT", value: 9007199254740991 }]);
  });

  // Refusing beats sending a value the server would misread: JSON.stringify turns
  // NaN and Infinity into `null`, which Druid would compare against as a null.
  test.each<[string, unknown, string]>([
    ["NaN", Number.NaN, "the non-finite number NaN"],
    ["Infinity", Number.POSITIVE_INFINITY, "the non-finite number Infinity"],
    ["an invalid Date", new Date("nope"), "an invalid Date"],
    ["a symbol", Symbol("s"), "a value of type symbol"],
    ["a function", () => 1, "a value of type function"],
    ["an array", [1, 2], "a value of type Array"],
    ["a plain object", { a: 1 }, "a value of type Object"],
    ["a Map", new Map(), "a value of type Map"],
    ["a prototype-less object", Object.create(null), "a value of type object"],
  ])("refuses %s rather than sending something the server would misread", async (_label, value, detail) => {
    const error = await captureError(() => makeTransport().query("SELECT 1 WHERE x = ?", { parameters: [value] }));

    expect(error.message).toBe(`Druid has no parameter type for ${detail}`);
    expect(error.category).toBe(DRUID_TRANSPORT_FAILURE);
    // Refused before anything left the process.
    expect(calls).toEqual([]);
  });
});

// ============================================================================
// The seam
// ============================================================================

describe("DruidHttpTransport seam", () => {
  test("announces itself as the HTTP implementation", () => {
    expect(makeTransport().kind).toBe("http");
  });

  // One request per statement and no session pinned, so there is nothing to
  // release. close() exists because every implementation of the seam has it.
  test("closes without holding anything open", async () => {
    const transport = makeTransport();

    await transport.close();

    await expect(transport.query("SELECT 1")).resolves.toBeDefined();
  });
});
