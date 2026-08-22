/**
 * Apache Druid Provider Integration Tests (issue #265)
 *
 * globalThis.fetch is replaced per test and restored in afterEach, so the real
 * transport, the real introspection, the real explain strategy and the real
 * provider all run - only the cluster is fake. mock.module() is deliberately not
 * used: it is process-wide in bun and would poison sibling test files.
 *
 * Every payload below was captured from a live Apache Druid 37.0.0 cluster
 * (datasources `libredb_demo`, 50 rows, and `libredb_rollup`, 20 rows), so the
 * fake speaks exactly what the server speaks. That matters more here than in a
 * typical mock, because six behaviours the provider depends on are the opposite
 * of what a JSON API teaches:
 *
 * - A result is a POSITIONAL array behind THREE header rows (names, native types,
 *   SQL types), and a result set with no rows still carries all three. The object
 *   format was rejected because it silently drops duplicate columns.
 * - A 64-bit integer arrives as an UNQUOTED JSON number that `JSON.parse` rounds,
 *   so the transport quotes it and the value reaches the grid as an exact string.
 * - The error body's `error` field is a DISCRIMINATOR whose value is the literal
 *   string "druidException"; the message lives elsewhere in the envelope, and the
 *   HTTP status misclassifies - `SELECT 1/0` is a 500 for a user's own typo.
 * - `sys.tasks.duration` is -1 for every task that has not finished, so a
 *   session's age is `CURRENT_TIMESTAMP` minus `created_time` instead.
 * - A grouping-less aggregate over zero matching rows returns NO DATA ROW at all,
 *   so every scalar read has to survive an absent row rather than a null.
 * - Appending `LIMIT n` to a statement that ends in `OFFSET n` is a hard 400, so
 *   the shared limiter must not run on one.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import type { DatabaseProvider } from "@/lib/db/types";
import { DruidProvider } from "@/lib/db/providers/sql/druid";
import {
  DRUID_ACTIVE_TASK_SQL,
  DRUID_COLUMN_LIST_SQL,
  DRUID_DATASOURCE_COUNT_SQL,
  DRUID_DATASOURCE_STATS_SQL,
  DRUID_HISTORICAL_STORAGE_SQL,
  DRUID_RUNNING_TASK_COUNT_SQL,
  DRUID_SEGMENT_TOTALS_SQL,
  DRUID_SERVER_IDENTITY_SQL,
  DRUID_TABLE_LIST_SQL,
} from "@/lib/db/providers/sql/druid/introspect";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  DatabaseError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { getExplainStrategy } from "@/lib/explain";
import type { ExplainTreeNode } from "@/lib/explain/types";

// ============================================================================
// Connection
// ============================================================================

const DRUID: DatabaseType = "druid";

/** The statement `connect()` proves the cluster with, live-verified as valid. */
const CONNECT_PROBE = "SELECT 1";

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

// ============================================================================
// Wire payloads (captured from Apache Druid 37.0.0 over POST /druid/v2/sql)
// ----------------------------------------------------------------------------
// Written as raw text rather than built from objects, for one reason that only
// applies to Druid: the BIGINT below is 2^53 + 1, and a JavaScript number literal
// would already have rounded it before any code under test ran.
// ============================================================================

/** `SELECT 1` - Druid names an unaliased expression EXPR$0. */
const PROBE_BODY = '[["EXPR$0"],["LONG"],["INTEGER"],[1]]';

/** `SELECT id, region, qty FROM "libredb_demo" WHERE region = ? LIMIT 2`. */
const DEMO_BODY =
  '[["id","region","qty"],["LONG","STRING","LONG"],["BIGINT","VARCHAR","BIGINT"],[1000,"emea",0],[1030,"emea",90]]';

/**
 * `SELECT id, name, snowflake_id FROM "libredb_demo" WHERE region = ? LIMIT 1`.
 * `snowflake_id` really holds 9007199254740993 and really arrives unquoted.
 */
const BIGINT_BODY =
  '[["id","name","snowflake_id"],["LONG","STRING","LONG"],["BIGINT","VARCHAR","BIGINT"],[1000,"alpha",9007199254740993]]';

/** `SELECT 1 AS c, 2 AS c` - two columns, one declared name, both preserved. */
const DUPLICATE_COLUMN_BODY = '[["c","c"],["LONG","LONG"],["INTEGER","INTEGER"],[1,2]]';

/** `SELECT id FROM libredb_demo WHERE id = -1` - all three headers, no data. */
const NO_ROWS_BODY = '[["id"],["LONG"],["BIGINT"]]';

/**
 * Three header rows, but the SQL type row is not the array it has to be - what a
 * proxy that rewrote the response, or a Druid that stopped sending the flag,
 * would produce. The transport omits a type it was not told rather than
 * inventing one, so nothing downstream may label the column.
 */
const UNTYPED_BODY = '[["id"],["LONG"],"nope",[1000]]';

/** `INFORMATION_SCHEMA.TABLES` filtered to the `druid` schema. */
const TABLE_LIST_BODY = '[["tableName"],["STRING"],["VARCHAR"],["libredb_demo"],["libredb_rollup"]]';

/**
 * `INFORMATION_SCHEMA.COLUMNS` for both datasources, in ORDINAL_POSITION order.
 * `libredb_rollup` is trimmed to its first three columns for length; nothing the
 * schema tree reads is affected. `__time` is the only column reported NOT NULL.
 */
const COLUMN_LIST_BODY = JSON.stringify([
  ["tableName", "columnName", "dataType", "isNullable"],
  ["STRING", "STRING", "STRING", "STRING"],
  ["VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR"],
  ["libredb_demo", "__time", "TIMESTAMP", "NO"],
  ["libredb_demo", "snowflake_id", "BIGINT", "YES"],
  ["libredb_demo", "id", "BIGINT", "YES"],
  ["libredb_demo", "name", "VARCHAR", "YES"],
  ["libredb_demo", "region", "VARCHAR", "YES"],
  ["libredb_demo", "qty", "BIGINT", "YES"],
  ["libredb_demo", "amount", "DOUBLE", "YES"],
  ["libredb_demo", "row_count", "BIGINT", "YES"],
  ["libredb_rollup", "__time", "TIMESTAMP", "NO"],
  ["libredb_rollup", "id", "BIGINT", "YES"],
  ["libredb_rollup", "qty", "BIGINT", "YES"],
]);

/**
 * `sys.servers`, Coordinator first. `serverNow` rides along so the uptime is a
 * difference of two readings of the SAME clock: 1h 8m 34.559s here.
 */
const IDENTITY_BODY =
  '[["version","startTime","serverNow"],["STRING","STRING","LONG"],["VARCHAR","VARCHAR","TIMESTAMP"],' +
  '["37.0.0","2026-08-03T14:29:00.534Z","2026-08-03T15:37:35.093Z"]]';

/** `SUM("size")` over the active segments of the whole cluster. */
const SEGMENT_TOTALS_BODY = '[["sizeBytes"],["LONG"],["BIGINT"],[19617]]';

const DATASOURCE_COUNT_BODY = '[["datasourceCount"],["LONG"],["BIGINT"],[2]]';

/**
 * The absent-row case, and it is the ORDINARY one: live-verified, a quiet cluster
 * answers `SELECT COUNT(*) FROM sys.tasks WHERE status = 'RUNNING'` with the
 * column-name rows and no data row whatsoever, not with a row holding 0.
 */
const NO_RUNNING_TASKS_BODY = '[["runningTasks"],["LONG"],["BIGINT"]]';

const ONE_RUNNING_TASK_BODY = '[["runningTasks"],["LONG"],["BIGINT"],[1]]';

/** The unfinished-task read on a quiet cluster: three header rows, no data. */
const NO_ACTIVE_TASKS_BODY = JSON.stringify([
  ["taskId", "taskType", "datasource", "status", "createdTime", "serverNow"],
  ["STRING", "STRING", "STRING", "STRING", "STRING", "LONG"],
  ["VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "TIMESTAMP"],
]);

/**
 * Two real rows of this cluster's `sys.tasks`, read while the first was RUNNING.
 *
 * The noop task is the live snapshot verbatim - and it is what disproved the
 * design spec's `durationMs = duration` mapping: the same row reports
 * `duration = -1` because the task has not finished, so the age can only come
 * from `serverNow` minus `createdTime` (22.86s here). Its `datasource` is the
 * literal string "none", not null.
 *
 * The ingestion row is this cluster's real `index_parallel` task for
 * `libredb_demo`, shown with the RUNNING status it carried while it ran.
 */
const ACTIVE_TASKS_BODY = JSON.stringify([
  ["taskId", "taskType", "datasource", "status", "createdTime", "serverNow"],
  ["STRING", "STRING", "STRING", "STRING", "STRING", "LONG"],
  ["VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "VARCHAR", "TIMESTAMP"],
  [
    "noop_2026-08-03T15:41:40.345Z_166088c6-0e19-4ba0-8b75-873392f4ce34",
    "noop",
    "none",
    "RUNNING",
    "2026-08-03T15:41:40.346Z",
    "2026-08-03T15:42:03.210Z",
  ],
  [
    "index_parallel_libredb_demo_onmdflbc_2026-08-03T14:33:59.465Z",
    "index_parallel",
    "libredb_demo",
    "RUNNING",
    "2026-08-03T14:33:59.480Z",
    "2026-08-03T15:42:03.210Z",
  ],
]);

/** `sys.segments` grouped by datasource, active segments only. */
const DATASOURCE_STATS_BODY =
  '[["datasource","rowCount","sizeBytes"],["STRING","LONG","LONG"],["VARCHAR","BIGINT","BIGINT"],' +
  '["libredb_demo",50,10203],["libredb_rollup",20,9414]]';

/**
 * The one historical of this cluster: a 300 GB segment cache holding 19 KB, so
 * the honest rounded usage really is 0%.
 */
const HISTORICAL_STORAGE_BODY =
  '[["server","host","currSize","maxSize"],["STRING","STRING","LONG","LONG"],["VARCHAR","VARCHAR","BIGINT","BIGINT"],' +
  '["172.18.0.5:8083","172.18.0.5",19617,300000000000]]';

// ============================================================================
// EXPLAIN payload
// ============================================================================

/** Druid stamps every plan with the same all-of-time interval. */
const ETERNITY = "-146136543-09-08T08:23:32.096Z/146140482-04-24T15:36:27.903Z";

/**
 * `EXPLAIN PLAN FOR SELECT * FROM libredb_demo LIMIT 500` verbatim, minus the
 * per-request `context` (a fresh UUID pair that describes the request rather than
 * the plan) and with `signature`/`columnMappings` trimmed to one entry each -
 * neither is walked by the tree.
 */
const EXPLAIN_PLAN = [
  {
    query: {
      queryType: "scan",
      dataSource: { type: "table", name: "libredb_demo" },
      intervals: { type: "intervals", intervals: [ETERNITY] },
      resultFormat: "compactedList",
      limit: 500,
      columns: ["__time", "snowflake_id", "id", "name", "region", "qty", "amount", "row_count"],
      columnTypes: ["LONG", "LONG", "LONG", "STRING", "STRING", "LONG", "DOUBLE", "LONG"],
      granularity: { type: "all" },
      legacy: false,
    },
    signature: [{ name: "id", type: "LONG" }],
    columnMappings: [{ queryColumn: "id", outputColumn: "id" }],
  },
];

const EXPLAIN_RESOURCES = [{ name: "libredb_demo", type: "DATASOURCE" }];
const EXPLAIN_ATTRIBUTES = { statementType: "SELECT" };

/**
 * The wire shape of an EXPLAIN answer: one row, three columns, and every cell is
 * JSON TEXT rather than JSON. The column names really are upper case.
 */
const EXPLAIN_BODY = JSON.stringify([
  ["PLAN", "RESOURCES", "ATTRIBUTES"],
  ["STRING", "STRING", "STRING"],
  ["VARCHAR", "VARCHAR", "VARCHAR"],
  [JSON.stringify(EXPLAIN_PLAN), JSON.stringify(EXPLAIN_RESOURCES), JSON.stringify(EXPLAIN_ATTRIBUTES)],
]);

// ============================================================================
// Error envelopes
// ----------------------------------------------------------------------------
// Both shapes are live. `error` is a DISCRIMINATOR in the modern one - its value
// is the literal string "druidException" - which is why a provider that shows it
// prints that word to the person who mistyped a datasource name.
// ============================================================================

/** `SELECT * FROM nope` - HTTP 400. */
const UNKNOWN_DATASOURCE =
  '{"error":"druidException","errorCode":"invalidInput","persona":"USER","category":"INVALID_INPUT",' +
  '"errorMessage":"Object \'nope\' not found (line [1], column [15])",' +
  '"context":{"sourceType":"sql","line":"1","column":"15","endLine":"1","endColumn":"18"}}';

/** `SELECT 1/0 AS z` - HTTP **500**, `persona: ADMIN`, for an ordinary user mistake. */
const DIVIDE_BY_ZERO =
  '{"error":"druidException","errorCode":"general","persona":"ADMIN","category":"UNCATEGORIZED",' +
  '"errorMessage":"/ by zero","context":{}}';

/** The legacy wrapper a data server produces, here from `context.timeout` of 1 ms - HTTP 504. */
const LEGACY_TIMEOUT =
  '{"error":"Query timeout","errorClass":"org.apache.druid.query.QueryTimeoutException",' +
  '"host":"172.18.0.5:8083","errorCode":"legacyQueryException","persona":"OPERATOR","category":"TIMEOUT",' +
  '"errorMessage":"url[http://172.18.0.5:8083/druid/v2/] timed out",' +
  '"context":{"host":"172.18.0.5:8083","errorClass":"org.apache.druid.query.QueryTimeoutException",' +
  '"legacyErrorCode":"Query timeout"}}';

/** `INSERT INTO libredb_demo SELECT * FROM libredb_rollup` - HTTP 400. */
const UNSUPPORTED_INSERT =
  '{"error":"druidException","errorCode":"invalidInput","persona":"USER","category":"INVALID_INPUT",' +
  '"errorMessage":"INSERT operations are not supported by requested SQL engine [native], consider using MSQ.",' +
  '"context":{"sourceType":"sql"}}';

/** `UPDATE libredb_demo SET qty = 1 WHERE id = 1` - HTTP 400. UPDATE is not in the grammar. */
const UNSUPPORTED_UPDATE =
  '{"error":"druidException","errorCode":"invalidInput","persona":"USER","category":"INVALID_INPUT",' +
  '"errorMessage":"Unsupported SQL statement [UPDATE]","context":{"sourceType":"sql"}}';

/**
 * A denial, CONSTRUCTED - and the one envelope here that is not a live capture,
 * because it cannot be: this cluster loads no security extension and ignores
 * credentials entirely (live-verified, a bogus header still answers 200). The
 * `category` values are Druid's own (transport.ts records the closed enum) and
 * the envelope shape is the live one; only the denial itself is synthesized.
 */
function deniedBody(category: "FORBIDDEN" | "UNAUTHORIZED" | "NOT_FOUND"): string {
  return JSON.stringify({
    error: "druidException",
    errorCode: "forbidden",
    persona: "USER",
    category,
    errorMessage: "Unauthorized",
    context: {},
  });
}

/**
 * A cancellation, CONSTRUCTED for the same reason in reverse: a cancel that lands
 * mid-stream answers 200 and truncates the body instead of sending an envelope
 * (proven in the transport's own tests), so an envelope-shaped CANCELED is the
 * shape a cancel BEFORE streaming would take. The category is Druid's own.
 */
const CANCELED_BODY = JSON.stringify({
  error: "druidException",
  errorCode: "general",
  persona: "USER",
  category: "CANCELED",
  errorMessage: "Query cancelled",
});

// ============================================================================
// fetch harness
// ============================================================================

interface Reply {
  status?: number;
  body: string;
  /** Response headers beyond the content type every answer carries. */
  headers?: Record<string, string>;
}

function ok(body: string): Reply {
  return { body };
}

/**
 * A 200 whose row set is INCOMPLETE: Druid reports unreachable segments in the
 * response context header, never in the body. Only the array's LENGTH is read,
 * so the descriptor below is illustrative.
 */
function withUnavailableSegments(body: string, count: number): Reply {
  const missing = Array.from({ length: count }, (_unused, index) => ({ itvl: "2026-08-0/2026-08-0", part: index }));
  return { body, headers: { "x-druid-response-context": JSON.stringify({ missingSegments: missing }) } };
}

function fail(status: number, body: string): Reply {
  return { status, body };
}

const originalFetch = globalThis.fetch;
const originalAbortTimeout = AbortSignal.timeout;

let sentSql: string[] = [];
let sentBodies: Record<string, unknown>[] = [];
let sentUrls: string[] = [];
let sentAuth: (string | null)[] = [];
/** Every client-side deadline the transport armed, in the order it armed them. */
let armedDeadlines: number[] = [];
let networkFailure: Error | null = null;
let replyFor: (sql: string) => Reply;

/**
 * Which canned body each catalog or `sys` read gets, keyed on the exported
 * statement the read actually sends. Keying on the constant rather than on a
 * substring means a routing miss is impossible: a renamed projection cannot
 * silently serve another surface's rows.
 */
const SURFACE_BODIES: [statement: string, body: string][] = [
  [DRUID_TABLE_LIST_SQL, TABLE_LIST_BODY],
  [DRUID_COLUMN_LIST_SQL, COLUMN_LIST_BODY],
  [DRUID_SERVER_IDENTITY_SQL, IDENTITY_BODY],
  [DRUID_SEGMENT_TOTALS_SQL, SEGMENT_TOTALS_BODY],
  [DRUID_DATASOURCE_COUNT_SQL, DATASOURCE_COUNT_BODY],
  [DRUID_RUNNING_TASK_COUNT_SQL, NO_RUNNING_TASKS_BODY],
  [DRUID_ACTIVE_TASK_SQL, NO_ACTIVE_TASKS_BODY],
  [DRUID_DATASOURCE_STATS_SQL, DATASOURCE_STATS_BODY],
  [DRUID_HISTORICAL_STORAGE_SQL, HISTORICAL_STORAGE_BODY],
];

function defaultReply(sql: string): Reply {
  if (sql === CONNECT_PROBE) return ok(PROBE_BODY);

  // `startsWith` because the session read appends its own row cap.
  const surface = SURFACE_BODIES.find(([statement]) => sql.startsWith(statement));
  if (surface) return ok(surface[1]);

  if (sql.startsWith("EXPLAIN")) return ok(EXPLAIN_BODY);
  return ok(DEMO_BODY);
}

/** Every read fails the way a locked-down cluster's ordinary user sees it. */
function denyEverything(): void {
  replyFor = () => fail(403, deniedBody("FORBIDDEN"));
}

/** Serve one surface differently and leave every other read alone. */
function overrideSurface(statement: string, reply: Reply): void {
  replyFor = (sql) => (sql.startsWith(statement) ? reply : defaultReply(sql));
}

function installFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (networkFailure) throw networkFailure;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const sql = String(body.query);
    sentUrls.push(String(input));
    sentBodies.push(body);
    sentSql.push(sql);
    sentAuth.push(new Headers(init?.headers).get("authorization"));

    const reply = replyFor(sql);
    return new Response(reply.body, {
      status: reply.status ?? 200,
      // Live-verified: every answer, success and failure alike, is JSON.
      headers: { "content-type": "application/json", ...reply.headers },
    });
  }) as typeof fetch;
}

/**
 * Record every client-side deadline instead of only proving a signal was
 * attached. The grace above the server's own deadline is the whole point of
 * having two (the #264 lesson), and it is otherwise unobservable.
 */
function installAbortRecorder(): void {
  AbortSignal.timeout = ((ms: number) => {
    armedDeadlines.push(ms);
    return originalAbortTimeout.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
}

function indexOfStatement(match: string): number {
  const index = sentSql.findIndex((statement) => statement.includes(match));
  if (index === -1) throw new Error(`no statement matching "${match}" was sent`);
  return index;
}

/** The statement the provider sent that mentions `match`, or a failure naming it. */
function sqlWith(match: string): string {
  return sentSql[indexOfStatement(match)];
}

/** The whole request the provider sent for that statement. */
function bodyWith(match: string): Record<string, unknown> {
  return sentBodies[indexOfStatement(match)];
}

function urlWith(match: string): string {
  return sentUrls[indexOfStatement(match)];
}

function sentAnything(match: string): boolean {
  return sentSql.some((statement) => statement.includes(match));
}

async function connectProvider(overrides: Partial<DatabaseConnection> = {}): Promise<DruidProvider> {
  const provider = new DruidProvider(makeConnection(overrides));
  await provider.connect();
  return provider;
}

beforeEach(() => {
  sentSql = [];
  sentBodies = [];
  sentUrls = [];
  sentAuth = [];
  armedDeadlines = [];
  networkFailure = null;
  replyFor = defaultReply;
  installFetch();
  installAbortRecorder();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalAbortTimeout;
});

// ============================================================================
// Metadata
// ============================================================================

describe("DruidProvider metadata", () => {
  test("declares the capabilities the design spec settled on", () => {
    const capabilities = new DruidProvider(makeConnection()).getCapabilities();

    expect(capabilities).toEqual({
      queryLanguage: "sql",
      supportsExplain: true,
      explainFormat: "druid-native",
      supportsExternalQueryLimiting: true,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      declaresForeignKeys: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: 8888,
      schemaRefreshPattern: "\\b(INSERT|REPLACE)\\b",
    });
  });

  test("keeps supportsCreateTable false because CREATE is not in Druid's grammar", () => {
    // Live-verified, and stronger than "unimplemented": `CREATE TABLE t (id
    // BIGINT)` answers HTTP 400 "Incorrect syntax near the keyword 'CREATE' at
    // line 1, column 1" - the parser lists the statements it expected, and no
    // form of CREATE is among them. Datasources are created by ingestion.
    expect(new DruidProvider(makeConnection()).getCapabilities().supportsCreateTable).toBe(false);
  });

  test("keeps supportsInlineRowEdit false because UPDATE is not in Druid's grammar either", () => {
    // Same class of answer as CREATE: `UPDATE t SET ...` is rejected as
    // `Unsupported SQL statement [UPDATE]`, so the inline row editor's statement
    // could never run. Druid SQL has no row-level DML at all.
    expect(new DruidProvider(makeConnection()).getCapabilities().supportsInlineRowEdit).toBe(false);
  });

  test("declares declaresForeignKeys false because a datasource cannot reference another", () => {
    // Druid has no constraints at all - which is also why `isPrimary` is hardwired
    // false in the introspection. An empty relations list here is the engine, not
    // the schema (#414).
    expect(new DruidProvider(makeConnection()).getCapabilities().declaresForeignKeys).toBe(false);
  });

  test("offers no maintenance operation, because SQL reaches none of them", () => {
    // Compaction and retention are Coordinator and task concerns, and `kill` has
    // a second problem: there is no `sys.queries` catalog, so there is nowhere
    // honest for a user to read a cancellable query id from.
    const capabilities = new DruidProvider(makeConnection()).getCapabilities();

    expect(capabilities.supportsMaintenance).toBe(false);
    expect(capabilities.maintenanceOperations).toEqual([]);
  });

  test("declares no connection string, because Druid's SQL endpoint has no URI form", () => {
    // Its JDBC driver addresses Avatica (jdbc:avatica:remote:url=...), and
    // http:// / https:// already resolve to ClickHouse in the shared parser.
    expect(new DruidProvider(makeConnection()).getCapabilities().supportsConnectionString).toBe(false);
  });

  test("calls a table a Datasource, and a row a row", () => {
    // Datasource is the Druid word and the sidebar is where a user meets it. The
    // rest is inherited on purpose: a Druid row IS a row, and the maintenance
    // labels name work this provider does not offer.
    const labels = new DruidProvider(makeConnection()).getLabels();

    expect(labels.entityName).toBe("Datasource");
    expect(labels.entityNamePlural).toBe("Datasources");
    expect(labels.rowName).toBe("row");
    expect(labels.rowNamePlural).toBe("rows");
    expect(labels.selectAction).toBe("Select Top 50");
    expect(labels.generateAction).toBe("Generate Query");
  });

  test("the empty slow-query panel says Druid keeps no query log", () => {
    // `getSlowQueries()` is empty by design here, so this panel is ALWAYS empty - and
    // until #U12 it told the reader to enable a PostgreSQL extension.
    const { slowQueriesEmptyState } = new DruidProvider(makeConnection()).getLabels();

    expect(slowQueriesEmptyState).toContain("no query log");
    expect(slowQueriesEmptyState).not.toContain("pg_stat_statements");
  });
});

// ============================================================================
// Validation and the connection model
// ============================================================================

describe("DruidProvider validation", () => {
  test("requires a host", () => {
    expect(() => new DruidProvider(makeConnection({ host: undefined }))).toThrow(DatabaseConfigError);
  });

  test("ignores the connection's database field entirely", async () => {
    // The connection form still renders a Database Name input for every
    // non-file-based type, so a Druid connection CAN carry one. Druid reports
    // exactly one catalog, always `druid`, so the field can only ever be noise -
    // and the request has nowhere to put it.
    const provider = await connectProvider({ database: "nope" });

    expect(urlWith(CONNECT_PROBE)).toBe("http://127.0.0.1:8888/druid/v2/sql");
    expect(sqlWith(CONNECT_PROBE)).toBe(CONNECT_PROBE);
    await provider.disconnect();
  });

  test("falls back to the Router's port when the connection names none", async () => {
    const provider = await connectProvider({ port: undefined });

    expect(urlWith(CONNECT_PROBE)).toBe("http://127.0.0.1:8888/druid/v2/sql");
    await provider.disconnect();
  });

  test("speaks TLS when the connection asks for it, on the port it was given", async () => {
    // One default port for both schemes on purpose: a TLS Druid serves on
    // whatever `druid.tlsPort` the deployment chose, so there is no well-known
    // HTTPS port to guess at.
    const provider = await connectProvider({ ssl: { mode: "require" }, port: 9088 });

    expect(urlWith(CONNECT_PROBE)).toBe("https://127.0.0.1:9088/druid/v2/sql");
    await provider.disconnect();
  });

  test("sends no credentials when the connection carries none", async () => {
    // A default install loads no security extension and ignores the header
    // entirely (live-verified: a bogus one still answers 200), so credentials are
    // optional and sending none is the normal case.
    const provider = await connectProvider();

    expect(sentAuth[0]).toBeNull();
    await provider.disconnect();
  });

  test("sends configured credentials as HTTP basic auth", async () => {
    const provider = await connectProvider({ user: "reader", password: "s3cret" });

    const header = sentAuth[0] ?? "";
    expect(Buffer.from(header.replace("Basic ", ""), "base64").toString()).toBe("reader:s3cret");
    await provider.disconnect();
  });
});

// ============================================================================
// Lifecycle
// ============================================================================

describe("DruidProvider lifecycle", () => {
  test("connect proves the cluster with the cheapest statement there is", async () => {
    const provider = await connectProvider();

    expect(provider.isConnected()).toBe(true);
    expect(sentSql).toEqual([CONNECT_PROBE]);
  });

  test("connect bounds both halves of the exchange", async () => {
    // Two deadlines, not one duplicated: the server-side one is what actually
    // frees the cluster's resources, while the client-side one also bounds a
    // stalled connect, a TLS handshake and a body that stops arriving part-way.
    const provider = await connectProvider();

    expect(bodyWith(CONNECT_PROBE).context).toEqual({ timeout: 60_000 });
    expect(armedDeadlines).toEqual([65_000]);
    await provider.disconnect();
  });

  test("connect maps a denial to an AuthenticationError", async () => {
    replyFor = () => fail(403, deniedBody("FORBIDDEN"));
    const provider = new DruidProvider(makeConnection({ user: "reader", password: "wrong" }));

    await expect(provider.connect()).rejects.toBeInstanceOf(AuthenticationError);
    expect(provider.isConnected()).toBe(false);
  });

  test("connect maps a rejected credential to an AuthenticationError too", async () => {
    replyFor = () => fail(401, deniedBody("UNAUTHORIZED"));
    const provider = new DruidProvider(makeConnection({ user: "reader", password: "wrong" }));

    await expect(provider.connect()).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("connect maps an unreachable cluster to a ConnectionError naming the target", async () => {
    networkFailure = new Error("connect ECONNREFUSED 127.0.0.1:8888");
    const provider = new DruidProvider(makeConnection());

    const failure = provider.connect();

    await expect(failure).rejects.toBeInstanceOf(ConnectionError);
    await expect(failure).rejects.toThrow(/ECONNREFUSED/);
  });

  test("connect reports a cluster that answers something else as a ConnectionError", async () => {
    // A proxy in front of the Broker, a wrong port, a Druid process that is not
    // the SQL endpoint: the probe is what turns all of those into one failure at
    // the moment the user is looking at the connection form.
    replyFor = () => fail(404, "<html><head><title>404 Not Found</title></head></html>");
    const provider = new DruidProvider(makeConnection({ port: 8081 }));

    await expect(provider.connect()).rejects.toBeInstanceOf(ConnectionError);
    expect(provider.isConnected()).toBe(false);
  });

  test("a failed connect leaves nothing open behind it", async () => {
    replyFor = () => fail(400, UNKNOWN_DATASOURCE);
    const provider = new DruidProvider(makeConnection());

    await expect(provider.connect()).rejects.toBeInstanceOf(ConnectionError);
    await expect(provider.query(CONNECT_PROBE)).rejects.toBeInstanceOf(DatabaseConfigError);
  });

  test("disconnect releases the transport and is safe to call twice", async () => {
    const provider = await connectProvider();

    await provider.disconnect();
    await provider.disconnect();

    expect(provider.isConnected()).toBe(false);
  });

  test("every read before connect is refused rather than answered", async () => {
    const provider = new DruidProvider(makeConnection());

    await expect(provider.query(CONNECT_PROBE)).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(provider.getSchema()).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(provider.getOverview()).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(provider.getActiveSessions()).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(provider.getTableStats()).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(provider.getStorageStats()).rejects.toBeInstanceOf(DatabaseConfigError);
    await expect(provider.getHealth()).rejects.toBeInstanceOf(DatabaseConfigError);
    expect(sentSql).toEqual([]);
  });

  test("the three constant reads answer without a connection, because they read nothing", async () => {
    // Deliberately not guarded by the connection check above: Druid publishes no
    // cache metrics, no query log and no index objects anywhere in SQL, so there
    // is no statement to send and no answer a socket could change. Requiring one
    // would only turn an honest empty into an error.
    const provider = new DruidProvider(makeConnection());

    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    expect(sentSql).toEqual([]);
  });
});

// ============================================================================
// Query execution
// ============================================================================

describe("DruidProvider query", () => {
  test("returns the rows, the declared column order and a measured duration", async () => {
    const provider = await connectProvider();

    const result = await provider.query('SELECT id, region, qty FROM "libredb_demo" LIMIT 2');

    expect(result.rows).toEqual([
      { id: 1000, region: "emea", qty: 0 },
      { id: 1030, region: "emea", qty: 90 },
    ]);
    expect(result.fields).toEqual(["id", "region", "qty"]);
    expect(result.rowCount).toBe(2);
    expect(result.executionTime).toBeGreaterThanOrEqual(0);
  });

  test("gives the server a deadline and keeps a client-side one slightly above it", async () => {
    const provider = await connectProvider();
    armedDeadlines = [];

    await provider.query("SELECT COUNT(*) FROM libredb_demo");

    expect(bodyWith("COUNT(*)").context).toEqual({ timeout: 60_000 });
    expect(armedDeadlines).toEqual([65_000]);
  });

  test("honours a configured query timeout on both halves", async () => {
    const provider = new DruidProvider(makeConnection(), { queryTimeout: 5_000 });
    await provider.connect();
    armedDeadlines = [];

    await provider.query("SELECT COUNT(*) FROM libredb_demo");

    expect(bodyWith("COUNT(*)").context).toEqual({ timeout: 5_000 });
    expect(armedDeadlines).toEqual([10_000]);
  });

  test("binds positional parameters, which Druid genuinely supports", async () => {
    // Unlike ClickHouse (#264), whose HTTP interface binds only named parameters
    // and whose provider therefore throws, `?` placeholders really execute here.
    const provider = await connectProvider();

    const result = await provider.query('SELECT id, region, qty FROM "libredb_demo" WHERE region = ?', ["emea"]);

    expect(bodyWith("region = ?").parameters).toEqual([{ type: "VARCHAR", value: "emea" }]);
    expect(result.rows).toHaveLength(2);
  });

  test("maps each parameter onto the type Druid expects, in order", async () => {
    const provider = await connectProvider();

    await provider.query("SELECT 1 WHERE a = ? AND b = ? AND c = ? AND d = ?", ["emea", 5, 1.5, true]);

    expect(bodyWith("a = ?").parameters).toEqual([
      { type: "VARCHAR", value: "emea" },
      { type: "BIGINT", value: 5 },
      { type: "DOUBLE", value: 1.5 },
      { type: "BOOLEAN", value: true },
    ]);
  });

  test("sends no parameters for a statement that has none", async () => {
    const provider = await connectProvider();

    await provider.query("SELECT COUNT(*) FROM libredb_demo");

    expect(bodyWith("COUNT(*)")).not.toHaveProperty("parameters");
  });

  test("accepts an empty parameter array, which is how the app calls every provider", async () => {
    const provider = await connectProvider();

    await expect(provider.query("SELECT COUNT(*) FROM libredb_demo", [])).resolves.toBeDefined();
    expect(bodyWith("COUNT(*)")).not.toHaveProperty("parameters");
  });

  test("keeps both columns of a duplicated output name", async () => {
    // Live-verified and the reason the array result format was chosen: with the
    // object format `SELECT 1 AS c, 2 AS c` answers [{"c":...},{"c":2}] and the
    // first column is simply gone. A record cannot hold the repeat either, so the
    // second one is disambiguated as the row is built.
    const provider = await connectProvider();
    replyFor = () => ok(DUPLICATE_COLUMN_BODY);

    const result = await provider.query("SELECT 1 AS c, 2 AS c");

    expect(result.fields).toEqual(["c", "c (2)"]);
    expect(result.rows).toEqual([{ c: 1, "c (2)": 2 }]);
    expect(result.rowCount).toBe(1);
  });

  test("delivers a 64-bit id exactly, as the string it has to become", async () => {
    // The value on the wire is the unquoted number 9007199254740993, which
    // JSON.parse turns into ...992 with no error at all. Druid has no
    // server-side quoting setting, so the raw body is rewritten before parsing
    // and the value reaches the grid as an exact string - the same thing the `pg`
    // driver already does for int8.
    const provider = await connectProvider();
    replyFor = () => ok(BIGINT_BODY);

    const result = await provider.query('SELECT id, name, snowflake_id FROM "libredb_demo" LIMIT 1');

    expect(result.rows[0].snowflake_id).toBe("9007199254740993");
    expect(result.rows[0].id).toBe(1000);
  });

  test("describes the columns of a result set with no rows", async () => {
    // Live-verified: `WHERE id = -1` still answers all three header rows, so an
    // empty grid still knows what it would have shown.
    const provider = await connectProvider();
    replyFor = () => ok(NO_ROWS_BODY);

    const result = await provider.query("SELECT id FROM libredb_demo WHERE id = -1");

    expect(result.rows).toEqual([]);
    expect(result.fields).toEqual(["id"]);
    expect(result.rowCount).toBe(0);
  });

  test("counts the rows it returned, because no Druid statement mutates", async () => {
    // There is no written-row count to fall back on: UPDATE and DELETE are not in
    // the grammar and INSERT/REPLACE need the MSQ task engine, so the row count
    // is the number of rows returned and nothing else.
    const provider = await connectProvider();

    const result = await provider.query('SELECT id FROM "libredb_demo"');

    expect(result.rowCount).toBe(result.rows.length);
  });

  test("labels each column with its SQL type, the trustworthy half of the pair (#273)", async () => {
    // The native type LIES for an expression - `CURRENT_TIMESTAMP` is native LONG
    // for an ISO string and `(1 = 1)` is native LONG for a boolean - so the SQL
    // type is the one a column may be labelled with. The two disagree even here
    // (native LONG against SQL BIGINT), which is what proves which map travels.
    const provider = await connectProvider();

    const result = await provider.query('SELECT id, region, qty FROM "libredb_demo"');

    expect(result.columnTypes).toEqual({ id: "BIGINT", region: "VARCHAR", qty: "BIGINT" });
    expect(Object.values(result.columnTypes ?? {})).not.toContain("LONG");
    expect(Object.keys(result.columnTypes ?? {})).toEqual(result.fields);
  });

  test("leaves the type channel absent when the payload declared no types", async () => {
    const provider = await connectProvider();
    replyFor = () => ok(UNTYPED_BODY);

    const result = await provider.query("SELECT id FROM libredb_demo");

    expect(result.fields).toEqual(["id"]);
    expect(result.columnTypes).toBeUndefined();
    expect("columnTypes" in result).toBe(false);
  });

  test("warns that a 200 is incomplete when the cluster could not reach every segment (#273)", async () => {
    // The hazard this channel exists for: the status is 200, the rows look like a
    // complete answer, and part of the data was simply not there. Needs a
    // multi-server cluster to provoke live, so the declaring response is fed here.
    const provider = await connectProvider();
    replyFor = () => withUnavailableSegments(DEMO_BODY, 2);

    const result = await provider.query('SELECT id, region, qty FROM "libredb_demo"');

    expect(result.warnings).toEqual([
      { message: "This result is incomplete: 2 segments of the queried data were unavailable." },
    ]);
    expect(result.rows).toHaveLength(2);
  });

  test("says one segment in the singular", async () => {
    const provider = await connectProvider();
    replyFor = () => withUnavailableSegments(DEMO_BODY, 1);

    const result = await provider.query('SELECT id FROM "libredb_demo"');

    expect(result.warnings).toEqual([
      { message: "This result is incomplete: 1 segment of the queried data was unavailable." },
    ]);
  });

  test("leaves the warnings channel absent when the cluster answered completely", async () => {
    const provider = await connectProvider();
    replyFor = () => withUnavailableSegments(DEMO_BODY, 0);

    const result = await provider.query('SELECT id FROM "libredb_demo"');

    expect(result.warnings).toBeUndefined();
    expect("warnings" in result).toBe(false);
  });

  test("leaves the warnings channel absent when the answer said nothing about availability", async () => {
    const provider = await connectProvider();
    replyFor = () => ok(DEMO_BODY);

    const result = await provider.query('SELECT id FROM "libredb_demo"');

    expect(result.warnings).toBeUndefined();
  });
});

// ============================================================================
// Error mapping
// ============================================================================

describe("DruidProvider error mapping", () => {
  test("a mistyped datasource becomes a QueryError carrying Druid's own message", async () => {
    const provider = await connectProvider();
    replyFor = () => fail(400, UNKNOWN_DATASOURCE);

    const failure = provider.query("SELECT * FROM nope");

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow("Object 'nope' not found (line [1], column [15])");
  });

  test("the message never degrades to the envelope's discriminator", async () => {
    // `error` holds the literal string "druidException" in the modern envelope,
    // so showing it would print that word to the person who mistyped a name.
    const provider = await connectProvider();
    replyFor = () => fail(400, UNKNOWN_DATASOURCE);

    await expect(provider.query("SELECT * FROM nope")).rejects.not.toThrow(/druidException/);
  });

  test("an HTTP 500 for a divide by zero is still the user's own error", async () => {
    // Live-verified and the reason nothing here classifies on the status:
    // `SELECT 1/0` answers 500 with `persona: ADMIN` and `category:
    // UNCATEGORIZED` for an ordinary mistake. Reading 5xx as "the cluster is
    // broken" would tell the user something false.
    const provider = await connectProvider();
    replyFor = () => fail(500, DIVIDE_BY_ZERO);

    const failure = provider.query("SELECT 1/0 AS z");

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.not.toBeInstanceOf(ConnectionError);
    await expect(failure).rejects.toThrow("/ by zero");
  });

  test("an exceeded deadline becomes a TimeoutError, from the legacy envelope", async () => {
    const provider = await connectProvider();
    replyFor = () => fail(504, LEGACY_TIMEOUT);

    const failure = provider.query("SELECT COUNT(*) FROM libredb_demo");

    await expect(failure).rejects.toBeInstanceOf(TimeoutError);
    await expect(failure).rejects.toThrow(/timed out/);
  });

  test("a cancelled query becomes a QueryCancelledError", async () => {
    const provider = await connectProvider();
    replyFor = () => fail(500, CANCELED_BODY);

    await expect(provider.query("SELECT COUNT(*) FROM libredb_demo")).rejects.toBeInstanceOf(QueryCancelledError);
  });

  test("a denial becomes an AuthenticationError", async () => {
    const provider = await connectProvider();
    denyEverything();

    await expect(provider.query("SELECT * FROM sys.segments")).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("a socket that never reached the cluster becomes a ConnectionError", async () => {
    const provider = await connectProvider();
    networkFailure = new Error("connect ECONNREFUSED 127.0.0.1:8888");

    await expect(provider.query(CONNECT_PROBE)).rejects.toBeInstanceOf(ConnectionError);
  });

  test("a client-side stall becomes a TimeoutError", async () => {
    const provider = await connectProvider();
    networkFailure = new DOMException("The operation timed out.", "TimeoutError");

    await expect(provider.query(CONNECT_PROBE)).rejects.toBeInstanceOf(TimeoutError);
  });

  test("a truncated response reports the incomplete answer it is", async () => {
    // Live-reproduced: a large streamed result cancelled mid-flight answers 200,
    // streams megabytes and then simply stops. Druid signals it by withholding a
    // response TRAILER, which fetch cannot read, so the cut body is the only
    // evidence there is - and reporting an empty success would be far worse.
    const provider = await connectProvider();
    replyFor = () => ok('[["pad"],["STRING"],["VARCHAR"],["gammagammagam');

    const failure = provider.query("SELECT REPEAT(name, 200000) FROM libredb_demo");

    await expect(failure).rejects.toBeInstanceOf(DatabaseError);
    await expect(failure).rejects.toThrow(/incomplete/);
  });

  test("a proxy's HTML error page still surfaces as a database error naming the status", async () => {
    const provider = await connectProvider();
    replyFor = () => fail(502, "<html><head><title>502 Bad Gateway</title></head></html>");

    await expect(provider.query(CONNECT_PROBE)).rejects.toThrow(/HTTP 502/);
  });

  test("an unmappable parameter is refused before anything leaves the process", async () => {
    // Sending a value the server would misread is worse than refusing it:
    // JSON.stringify turns NaN and Infinity into `null`, which Druid would
    // compare against as a null.
    const provider = await connectProvider();
    sentSql = [];

    const failure = provider.query("SELECT 1 WHERE x = ?", [Symbol("s")]);

    await expect(failure).rejects.toBeInstanceOf(DatabaseError);
    await expect(failure).rejects.toThrow("Druid has no parameter type for a value of type symbol");
    expect(sentSql).toEqual([]);
  });

  test.each<[string, string, string]>([
    ["INSERT", "INSERT INTO libredb_demo SELECT * FROM libredb_rollup", UNSUPPORTED_INSERT],
    ["UPDATE", "UPDATE libredb_demo SET qty = 1 WHERE id = 1", UNSUPPORTED_UPDATE],
  ])("surfaces Druid's own explanation of why %s is unsupported", async (_label, sql, envelope) => {
    // Deliberately NOT special-cased: the server's message already names both the
    // reason and the alternative ("consider using MSQ"), which is more useful
    // than anything the provider could substitute.
    const provider = await connectProvider();
    replyFor = () => fail(400, envelope);

    const failure = provider.query(sql);

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow(JSON.parse(envelope).errorMessage as string);
  });
});

// ============================================================================
// Query preparation (the OFFSET override)
// ============================================================================

describe("DruidProvider query preparation", () => {
  const provider = () => new DruidProvider(makeConnection());

  test("applies the external row limit to a plain SELECT", () => {
    const prepared = provider().prepareQuery('SELECT * FROM "libredb_demo"', { limit: 25 });

    expect(prepared.query).toBe('SELECT * FROM "libredb_demo" LIMIT 25');
    expect(prepared.wasLimited).toBe(true);
    expect(prepared.limit).toBe(25);
  });

  // Druid's override only decides whether the shared limiter's answer survives, so
  // it inherits the comment tolerance rather than implementing any of its own (#275).
  test("applies the external row limit to a comment-led SELECT", () => {
    const prepared = provider().prepareQuery('-- annotated\nSELECT * FROM "libredb_demo"', { limit: 25 });

    expect(prepared.query).toBe('-- annotated\nSELECT * FROM "libredb_demo" LIMIT 25');
    expect(prepared.wasLimited).toBe(true);
  });

  test("keeps a trailing semicolon, which Druid accepts", () => {
    const prepared = provider().prepareQuery('SELECT * FROM "libredb_demo";', { limit: 25 });

    expect(prepared.query).toBe('SELECT * FROM "libredb_demo" LIMIT 25;');
  });

  test.each([
    ["OFFSET as the last clause", "SELECT id FROM libredb_demo ORDER BY __time OFFSET 2"],
    ["OFFSET followed by a semicolon", "SELECT id FROM libredb_demo ORDER BY __time OFFSET 2;"],
    ["OFFSET padded with whitespace", "SELECT id FROM libredb_demo OFFSET 2  "],
  ])("leaves a statement ending in %s untouched", (_label, sql) => {
    // Live-verified: `SELECT id FROM libredb_demo OFFSET 2 LIMIT 3` answers 400
    // "'OFFSET start LIMIT count' is not allowed under the current SQL
    // conformance level". Same bias as ClickHouse's trailing-clause case -
    // rewriting wrongly fails the query outright, while leaving it alone only
    // returns more rows.
    const prepared = provider().prepareQuery(sql, { limit: 25 });

    expect(prepared.query).toBe(sql);
    expect(prepared.wasLimited).toBe(false);
    expect(prepared.limit).toBe(25);
  });

  // #280. This override reads `analyzeQuery`'s `hasOffset`, which was anchored at
  // the end of the raw text: a trailing comment hid the OFFSET, the shared limiter
  // appended a bound, and Druid answered 400. It inherits the fix rather than
  // implementing one - the point of routing the decision through the shared probe.
  test.each([
    ["OFFSET before a line comment", "SELECT id FROM libredb_demo ORDER BY __time OFFSET 2 -- paged"],
    ["OFFSET before a semicolon and a comment", "SELECT id FROM libredb_demo OFFSET 2; -- paged"],
  ])("leaves a statement ending in %s untouched", (_label, sql) => {
    const prepared = provider().prepareQuery(sql, { limit: 25 });

    expect(prepared.query).toBe(sql);
    expect(prepared.wasLimited).toBe(false);
  });

  test("bounds a statement ending in a comment, before the comment", () => {
    const prepared = provider().prepareQuery('SELECT * FROM "libredb_demo" -- daily check', { limit: 25 });

    expect(prepared.query).toBe('SELECT * FROM "libredb_demo" LIMIT 25 -- daily check');
    expect(prepared.wasLimited).toBe(true);
  });

  test("still limits a statement that merely mentions an offset column", () => {
    const sql = "SELECT offset_minutes FROM libredb_demo WHERE region = 'emea'";

    const prepared = provider().prepareQuery(sql, { limit: 25 });

    expect(prepared.query).toBe(`${sql} LIMIT 25`);
    expect(prepared.wasLimited).toBe(true);
  });

  test("preserves a LIMIT the user wrote, with or without an OFFSET after it", () => {
    // `LIMIT 5 LIMIT 25` is a syntax error; the shared limiter never produces it
    // because it leaves an existing LIMIT alone.
    const withOffset = provider().prepareQuery("SELECT id FROM libredb_demo LIMIT 3 OFFSET 2", { limit: 25 });
    const withoutOffset = provider().prepareQuery("SELECT id FROM libredb_demo LIMIT 3", { limit: 25 });

    expect(withOffset.query).toBe("SELECT id FROM libredb_demo LIMIT 3 OFFSET 2");
    expect(withOffset.wasLimited).toBe(false);
    expect(withoutOffset.query).toBe("SELECT id FROM libredb_demo LIMIT 3");
    expect(withoutOffset.wasLimited).toBe(false);
  });

  test("paginates with LIMIT n OFFSET m, which is correct Druid SQL in that order", () => {
    const prepared = provider().prepareQuery('SELECT * FROM "libredb_demo"', { limit: 25, offset: 50 });

    expect(prepared.query).toBe('SELECT * FROM "libredb_demo" LIMIT 25 OFFSET 50');
    expect(prepared.wasLimited).toBe(true);
  });

  test("lifts the ceiling for an unlimited export", () => {
    const prepared = provider().prepareQuery('SELECT * FROM "libredb_demo"', { unlimited: true });

    expect(prepared.query).toBe('SELECT * FROM "libredb_demo" LIMIT 100000');
    expect(prepared.limit).toBe(100000);
  });

  test("leaves a statement that is not a SELECT alone", () => {
    const prepared = provider().prepareQuery("INSERT INTO libredb_demo SELECT * FROM libredb_rollup");

    expect(prepared.query).toBe("INSERT INTO libredb_demo SELECT * FROM libredb_rollup");
    expect(prepared.wasLimited).toBe(false);
  });

  test("never appends a limit to an EXPLAIN, so the double-limit syntax error cannot happen", () => {
    // `EXPLAIN PLAN FOR SELECT * FROM libredb_demo LIMIT 500` plans fine, but
    // `... LIMIT 5 LIMIT 500` is a 400. The explain statement is not a SELECT, so
    // the limiter never touches it.
    const prepared = provider().prepareQuery("EXPLAIN PLAN FOR SELECT * FROM libredb_demo LIMIT 5");

    expect(prepared.query).toBe("EXPLAIN PLAN FOR SELECT * FROM libredb_demo LIMIT 5");
    expect(prepared.wasLimited).toBe(false);
  });
});

// ============================================================================
// Schema
// ============================================================================

describe("DruidProvider schema", () => {
  test("getSchema lists the datasources by their bare names, with their columns", async () => {
    // `druid` is the default schema, so `SELECT * FROM "libredb_demo"` resolves
    // and no qualification is needed anywhere.
    const provider = await connectProvider();

    const schema = await provider.getSchema();

    expect(schema.map((table) => table.name)).toEqual(["libredb_demo", "libredb_rollup"]);
    expect(schema[1].columns).toEqual([
      { name: "__time", type: "TIMESTAMP", nullable: false, isPrimary: false },
      { name: "id", type: "BIGINT", nullable: true, isPrimary: false },
      { name: "qty", type: "BIGINT", nullable: true, isPrimary: false },
    ]);
  });

  test("getSchema marks no column primary, and __time is the one NOT NULL column", async () => {
    // `__time` is mandatory, it is the partitioning and sort key, and it is the only
    // column Druid reports as IS_NULLABLE = 'NO' - but it is not UNIQUE (50 rows, 30
    // distinct values live), and `isPrimary` is read as PRIMARY KEY by autocomplete,
    // by the AI schema context and by the schema differ. Nullability is how the time
    // column is identified instead.
    const provider = await connectProvider();

    const schema = await provider.getSchema();

    expect(schema[0].columns.filter((column) => column.isPrimary)).toEqual([]);
    expect(schema[0].columns.filter((column) => !column.nullable).map((column) => column.name)).toEqual(["__time"]);
    expect(schema[0].columns.map((column) => column.name)).toEqual([
      "__time",
      "snowflake_id",
      "id",
      "name",
      "region",
      "qty",
      "amount",
      "row_count",
    ]);
  });

  test("getSchema reports no indexes and no foreign keys, because Druid has neither", async () => {
    // Every dimension is indexed inside the segment, with no name, no size and no
    // usage counter of its own, and there is no DDL that could declare a key.
    const provider = await connectProvider();

    const schema = await provider.getSchema();

    expect(schema.every((table) => table.indexes.length === 0)).toBe(true);
    expect(schema.every((table) => table.foreignKeys?.length === 0)).toBe(true);
  });

  test("getSchema leaves row counts and sizes unset rather than reading them from sys", async () => {
    // Deliberate: `sys.segments` is permission-gated separately from the
    // catalogs, so reading counts there would make the whole sidebar fail on a
    // cluster that merely declines to describe its servers. The counts live in
    // getTableStats(), where a denial costs one panel.
    const provider = await connectProvider();

    const schema = await provider.getSchema();

    expect(schema.every((table) => table.rowCount === undefined)).toBe(true);
    expect(schema.every((table) => table.size === undefined)).toBe(true);
    expect(sentAnything("sys.segments")).toBe(false);
  });

  test("getSchema reads the catalogs and nothing else", async () => {
    const provider = await connectProvider();

    await provider.getSchema();

    expect(sqlWith("INFORMATION_SCHEMA.TABLES")).toBe(DRUID_TABLE_LIST_SQL);
    expect(sqlWith("INFORMATION_SCHEMA.COLUMNS")).toBe(DRUID_COLUMN_LIST_SQL);
    expect(sentSql).toHaveLength(3);
  });

  test("getTables lists the datasource names", async () => {
    const provider = await connectProvider();

    expect(await provider.getTables()).toEqual(["libredb_demo", "libredb_rollup"]);
  });

  test("a datasource with no segments left is simply absent", async () => {
    // Live-verified through the Coordinator's markUnused: a datasource whose
    // segments are all unused disappears from INFORMATION_SCHEMA.TABLES
    // entirely, so there is no empty-datasource row to render.
    const provider = await connectProvider();
    overrideSurface(DRUID_TABLE_LIST_SQL, ok('[["tableName"],["STRING"],["VARCHAR"]]'));

    expect(await provider.getSchema()).toEqual([]);
  });

  test("a denied catalog yields an empty tree instead of an error page", async () => {
    const provider = await connectProvider();
    denyEverything();

    expect(await provider.getSchema()).toEqual([]);
  });

  test("a catalog failure that is not a denial propagates", async () => {
    // An empty sidebar in place of a real error hides it forever.
    const provider = await connectProvider();
    replyFor = () => fail(400, UNKNOWN_DATASOURCE);

    await expect(provider.getSchema()).rejects.toBeInstanceOf(QueryError);
  });

  test("declares neither getSchemaList nor getSchemaRelations", async () => {
    // Both are optional, and the split does not fit Druid: with no user-defined
    // indexes and no foreign keys, getSchemaList would be byte-identical to
    // getSchema and getSchemaRelations would spend a round trip to answer
    // `{ indexes: [], foreignKeys: [] }` per datasource. The client falls back to
    // getSchema(), so declaring them would only add two network calls.
    const provider = await connectProvider();
    const surface = provider as unknown as Record<string, unknown>;

    expect(surface.getSchemaList).toBeUndefined();
    expect(surface.getSchemaRelations).toBeUndefined();
  });
});

// ============================================================================
// Monitoring
// ============================================================================

describe("DruidProvider monitoring", () => {
  test("getOverview describes the cluster from four separate reads", async () => {
    // Four rather than one joined statement: `sys` permissions are granted per
    // table, so a cluster that declines sys.tasks must still report the
    // datasource count INFORMATION_SCHEMA answers happily.
    const provider = await connectProvider();

    const overview = await provider.getOverview();

    expect(overview.version).toBe("37.0.0");
    expect(overview.uptime).toBe("1.14h");
    expect(overview.startTime).toEqual(new Date("2026-08-03T14:29:00.534Z"));
    expect(overview.databaseSizeBytes).toBe(19617);
    expect(overview.databaseSize).toBe("19.16 KB");
    expect(overview.tableCount).toBe(2);
    // No index objects exist, and Druid publishes no connection limit anywhere in
    // SQL - it has no pool - so both would be numbers the editor made up.
    expect(overview.indexCount).toBe(0);
    expect(overview.maxConnections).toBe(0);
  });

  test("getOverview reads an absent row as zero running tasks", async () => {
    // The ordinary case on a quiet cluster: the aggregate answers with the column
    // rows and NO data row, which is not the same as a row holding 0.
    const provider = await connectProvider();

    expect((await provider.getOverview()).activeConnections).toBe(0);
  });

  test("getOverview counts a running ingestion task as the occupied slot it is", async () => {
    // Druid has no query sessions to count, so a running task is the only
    // activity it can report.
    const provider = await connectProvider();
    overrideSurface(DRUID_RUNNING_TASK_COUNT_SQL, ok(ONE_RUNNING_TASK_BODY));

    expect((await provider.getOverview()).activeConnections).toBe(1);
  });

  test("getOverview degrades to unknown rather than claiming the cluster just booted", async () => {
    const provider = await connectProvider();
    denyEverything();

    const overview = await provider.getOverview();

    expect(overview.version).toBe("unknown");
    expect(overview.uptime).toBe("unknown");
    expect(overview.startTime).toBeUndefined();
    expect(overview.activeConnections).toBe(0);
    expect(overview.databaseSizeBytes).toBe(0);
    expect(overview.tableCount).toBe(0);
  });

  test("a monitoring failure that is not a denial propagates", async () => {
    const provider = await connectProvider();
    replyFor = () => fail(500, DIVIDE_BY_ZERO);

    await expect(provider.getOverview()).rejects.toBeInstanceOf(QueryError);
  });

  test("getPerformanceMetrics reports only the ratio the type demands, and asks nothing", async () => {
    // Druid's cache and query metrics reach a metrics emitter - statsd, Kafka, the
    // log - and never a SQL-readable table. Every other field is optional, so
    // absence expresses "not reported"; a 0 would read as a measurement of zero.
    const provider = await connectProvider();
    sentSql = [];

    const performance = await provider.getPerformanceMetrics();

    expect(performance).toEqual({});
    expect(sentSql).toEqual([]);
  });

  test("getSlowQueries is empty and sends no statement, because there is no query log", async () => {
    // Not a switched-off feature and not a permission gate: there is no sys
    // table, no endpoint and no file holding finished queries, so unlike
    // ClickHouse's system.query_log there is nothing to ask.
    const provider = await connectProvider();
    sentSql = [];
    // Also called the way the monitoring panel calls it - through the interface,
    // with a row cap. The provider declares no parameter at all, because a list
    // that is always empty has nothing to cap, and the narrower signature still
    // satisfies every caller.
    const monitored: DatabaseProvider = provider;

    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await monitored.getSlowQueries({ limit: 5 })).toEqual([]);
    expect(sentSql).toEqual([]);
  });

  test("getIndexStats is empty and sends no statement, because no index objects exist", async () => {
    const provider = await connectProvider();
    sentSql = [];
    const monitored: DatabaseProvider = provider;

    expect(await provider.getIndexStats()).toEqual([]);
    expect(await monitored.getIndexStats({ schema: "druid" })).toEqual([]);
    expect(sentSql).toEqual([]);
  });

  test("getActiveSessions describes the unfinished tasks, timed against the server's own clock", async () => {
    // `sys.tasks.duration` is -1 for every task this read selects (live-verified
    // against a noop task submitted to the running cluster), so the age is
    // CURRENT_TIMESTAMP minus created_time - both values from the server, since
    // the editor's clock may be skewed and no expression over a sys column plans.
    const provider = await connectProvider();
    overrideSurface(DRUID_ACTIVE_TASK_SQL, ok(ACTIVE_TASKS_BODY));

    const sessions = await provider.getActiveSessions();

    expect(sessions[0]).toEqual({
      pid: "noop_2026-08-03T15:41:40.345Z_166088c6-0e19-4ba0-8b75-873392f4ce34",
      // sys.tasks records no submitter identity - a druid-basic-security cluster
      // puts it in the audit log - and borrowing the connection's user would
      // credit it with a task it did not submit.
      user: "unknown",
      // Live-verified: a task with no datasource reports the literal "none".
      database: "none",
      applicationName: "Druid ingestion task",
      state: "RUNNING",
      // The task TYPE, which is the closest thing a task has to a statement.
      query: "noop",
      queryStart: new Date("2026-08-03T15:41:40.346Z"),
      duration: "22.86s",
      durationMs: 22864,
    });
    expect(sessions[1].database).toBe("libredb_demo");
    expect(sessions[1].query).toBe("index_parallel");
    expect(sessions[1].durationMs).toBe(4083730);
  });

  test("getActiveSessions never prints the -1 the duration column carries", async () => {
    const provider = await connectProvider();
    overrideSurface(DRUID_ACTIVE_TASK_SQL, ok(ACTIVE_TASKS_BODY));

    const sessions = await provider.getActiveSessions();

    expect(sessions.every((session) => session.durationMs > 0)).toBe(true);
    expect(sessions.map((session) => session.duration)).not.toContain("-1ms");
  });

  test("getActiveSessions caps the rows, defaulting to 50", async () => {
    const provider = await connectProvider();

    await provider.getActiveSessions({ limit: 7 });
    await provider.getActiveSessions();
    await provider.getActiveSessions({ limit: 0 });

    const reads = sentSql.filter((sql) => sql.startsWith(DRUID_ACTIVE_TASK_SQL));
    expect(reads[0]).toBe(`${DRUID_ACTIVE_TASK_SQL} LIMIT 7`);
    expect(reads[1]).toBe(`${DRUID_ACTIVE_TASK_SQL} LIMIT 50`);
    expect(reads[2]).toBe(`${DRUID_ACTIVE_TASK_SQL} LIMIT 50`);
  });

  test("getActiveSessions is empty on a quiet cluster and on a denied one", async () => {
    const provider = await connectProvider();

    expect(await provider.getActiveSessions()).toEqual([]);
    denyEverything();
    expect(await provider.getActiveSessions()).toEqual([]);
  });

  test("getTableStats reports rows and bytes per datasource, from the active segments", async () => {
    // Active only: `sys.segments` still lists a segment that a compaction or a
    // re-ingestion superseded, so summing everything would double-count both the
    // rows and the bytes.
    const provider = await connectProvider();

    const stats = await provider.getTableStats();

    expect(stats).toEqual([
      {
        schemaName: "druid",
        tableName: "libredb_demo",
        rowCount: 50,
        // The dimension indexes are inside the segment, so the table size and the
        // total size are the same number rather than one being the other plus an
        // index total - and the optional index size stays absent.
        tableSize: "9.96 KB",
        tableSizeBytes: 10203,
        totalSize: "9.96 KB",
        totalSizeBytes: 10203,
      },
      {
        schemaName: "druid",
        tableName: "libredb_rollup",
        rowCount: 20,
        tableSize: "9.19 KB",
        tableSizeBytes: 9414,
        totalSize: "9.19 KB",
        totalSizeBytes: 9414,
      },
    ]);
  });

  test("getTableStats answers a foreign schema without a round trip", async () => {
    // `druid` is the only schema holding datasources, so any other value selects
    // nothing, and a predicate that can never match is slower and less obviously
    // right than not asking.
    const provider = await connectProvider();
    sentSql = [];

    expect(await provider.getTableStats({ schema: "sys" })).toEqual([]);
    expect(sentSql).toEqual([]);
    expect(await provider.getTableStats({ schema: "druid" })).toHaveLength(2);
    expect(sentSql).toHaveLength(1);
  });

  test("getTableStats returns empty when sys.segments is denied", async () => {
    const provider = await connectProvider();
    denyEverything();

    expect(await provider.getTableStats()).toEqual([]);
  });

  test("getStorageStats reports each historical's segment cache", async () => {
    // The historicals are the only processes that hold segments: live-verified,
    // the Coordinator, Overlord, Broker, Router and MiddleManager rows of this
    // same table all report curr_size 0 and max_size 0.
    const provider = await connectProvider();

    const storage = await provider.getStorageStats();

    expect(storage).toEqual([
      {
        name: "172.18.0.5:8083",
        location: "172.18.0.5",
        size: "19.16 KB",
        sizeBytes: 19617,
        // 19 KB in a 300 GB cache: the honest rounded percentage really is 0.
        usagePercent: 0,
      },
    ]);
  });

  test("getStorageStats divides by the configured capacity when there is some in use", async () => {
    // Constructed rather than captured: this cluster's historical is nearly
    // empty, so a meaningful percentage needs a fuller cache than it has.
    const provider = await connectProvider();
    overrideSurface(
      DRUID_HISTORICAL_STORAGE_SQL,
      ok(
        '[["server","host","currSize","maxSize"],["STRING","STRING","LONG","LONG"],' +
          '["VARCHAR","VARCHAR","BIGINT","BIGINT"],["172.18.0.5:8083","172.18.0.5",150000000000,300000000000]]',
      ),
    );

    expect((await provider.getStorageStats())[0].usagePercent).toBe(50);
  });

  test("getStorageStats survives a historical with no configured capacity", async () => {
    // A zero denominator is real data here rather than a defensive guess, and a
    // flattering 100% would report a fault that does not exist.
    const provider = await connectProvider();
    overrideSurface(
      DRUID_HISTORICAL_STORAGE_SQL,
      ok(
        '[["server","host","currSize","maxSize"],["STRING","STRING","LONG","LONG"],' +
          '["VARCHAR","VARCHAR","BIGINT","BIGINT"],["172.18.0.5:8083","172.18.0.5",0,0]]',
      ),
    );

    expect((await provider.getStorageStats())[0].usagePercent).toBe(0);
  });

  test("getStorageStats returns empty when sys.servers is denied", async () => {
    const provider = await connectProvider();
    denyEverything();

    expect(await provider.getStorageStats()).toEqual([]);
  });

  test("getHealth says the cache ratio is unavailable rather than inventing one", async () => {
    // The field is a STRING, so it can say so - and a fabricated low number would
    // trip the cache-ratio threshold into reporting a fault that does not exist.
    // sqlite.ts and oracle.ts already spell an unavailable ratio this way.
    const provider = await connectProvider();
    overrideSurface(DRUID_ACTIVE_TASK_SQL, ok(ACTIVE_TASKS_BODY));

    const health = await provider.getHealth();

    expect(health.cacheHitRatio).toBe("N/A");
    expect(health.activeConnections).toBe(0);
    expect(health.databaseSize).toBe("19.16 KB");
    expect(health.slowQueries).toEqual([]);
    expect(health.activeSessions[0]).toEqual({
      pid: "noop_2026-08-03T15:41:40.345Z_166088c6-0e19-4ba0-8b75-873392f4ce34",
      user: "unknown",
      database: "none",
      state: "RUNNING",
      query: "noop",
      duration: "22.86s",
    });
  });

  test("getHealth reads at most ten sessions", async () => {
    const provider = await connectProvider();

    await provider.getHealth();

    expect(sqlWith(DRUID_ACTIVE_TASK_SQL)).toBe(`${DRUID_ACTIVE_TASK_SQL} LIMIT 10`);
  });

  test("getMonitoringData survives a user who may read nothing", async () => {
    const provider = await connectProvider();
    denyEverything();

    const data = await provider.getMonitoringData();

    expect(data.overview.version).toBe("unknown");
    expect(data.performance).toEqual({});
    expect(data.slowQueries).toEqual([]);
    expect(data.activeSessions).toEqual([]);
    expect(data.tables).toEqual([]);
    expect(data.indexes).toEqual([]);
    expect(data.storage).toEqual([]);
  });

  test("getMonitoringData fills every panel on a healthy cluster", async () => {
    const provider = await connectProvider();
    overrideSurface(DRUID_ACTIVE_TASK_SQL, ok(ACTIVE_TASKS_BODY));

    const data = await provider.getMonitoringData();

    expect(data.overview.version).toBe("37.0.0");
    expect(data.activeSessions).toHaveLength(2);
    expect(data.tables).toHaveLength(2);
    expect(data.storage).toHaveLength(1);
  });
});

// ============================================================================
// Maintenance
// ============================================================================

describe("DruidProvider maintenance", () => {
  test.each<[string]>([["vacuum"], ["analyze"], ["reindex"], ["kill"], ["optimize"], ["check"]])(
    "refuses %s, because SQL reaches no Druid equivalent",
    async (operation) => {
      // Absent from maintenanceOperations, so the UI never offers any of these;
      // the refusal exists so a direct API call gets an explanation rather than a
      // statement the server would reject.
      const provider = await connectProvider();

      const failure = provider.runMaintenance(operation as "vacuum");

      await expect(failure).rejects.toBeInstanceOf(QueryError);
      await expect(failure).rejects.toThrow(operation);
      expect(sentSql).toEqual([CONNECT_PROBE]);
    },
  );
});

// ============================================================================
// EXPLAIN (the round trip the provider's capability promises)
// ============================================================================

function walk(node: ExplainTreeNode, seen: ExplainTreeNode[] = []): ExplainTreeNode[] {
  seen.push(node);
  for (const child of node.children) walk(child, seen);
  return seen;
}

describe("DruidProvider explain", () => {
  test("the declared format resolves to a registered strategy", () => {
    const capabilities = new DruidProvider(makeConnection()).getCapabilities();

    expect(getExplainStrategy(capabilities.explainFormat)?.format).toBe("druid-native");
  });

  test("runs the strategy's statement and renders the plan Druid answered with", async () => {
    const provider = await connectProvider();
    const strategy = getExplainStrategy(provider.getCapabilities().explainFormat);
    const sql = strategy?.buildSql('SELECT * FROM "libredb_demo" LIMIT 500', "analyze");

    const result = await provider.query(sql ?? "");
    const stored = strategy?.extractPlan({ rows: result.rows });
    const model = strategy?.toRenderModel(stored);

    expect(sql).toBe('EXPLAIN PLAN FOR SELECT * FROM "libredb_demo" LIMIT 500');
    // The three columns arrive as JSON TEXT, so the envelope parse leaves three
    // escaped blobs behind; parsing them here is what gives the raw-JSON and AI
    // tabs a structure rather than one long escaped string.
    expect(stored).toEqual({ plan: EXPLAIN_PLAN, resources: EXPLAIN_RESOURCES, attributes: EXPLAIN_ATTRIBUTES });
    expect(model?.kind).toBe("tree");

    const root = (model as { root: ExplainTreeNode }).root;
    expect(root.label).toBe("scan");
    expect(root.children.map((child) => child.label)).toEqual(["table libredb_demo", "granularity: all"]);
    // No cost and no row estimate on any node: Druid's planner emits neither, and
    // an empty metrics column is the honest render rather than a fabricated zero.
    expect(walk(root).every((node) => node.metrics === undefined)).toBe(true);
  });

  test("the upper-case column names the Broker sends are what the strategy reads", async () => {
    // If the transport ever lower-cased or renamed the header row, extractPlan
    // would fall back to the raw rows and no tree would ever render.
    const provider = await connectProvider();

    const result = await provider.query("EXPLAIN PLAN FOR SELECT 1");

    expect(result.fields).toEqual(["PLAN", "RESOURCES", "ATTRIBUTES"]);
  });

  test("an EXPLAIN of a statement Druid cannot run is never built", async () => {
    // UPDATE and DELETE are not in the grammar and INSERT/REPLACE need the MSQ
    // task engine, so none of them is explainable through this endpoint.
    const provider = await connectProvider();
    const strategy = getExplainStrategy(provider.getCapabilities().explainFormat);

    expect(strategy?.buildSql("UPDATE libredb_demo SET qty = 1", "analyze")).toBeNull();
  });
});
