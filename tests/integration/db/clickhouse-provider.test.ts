/**
 * ClickHouse Provider Integration Tests (issue #264)
 *
 * globalThis.fetch is replaced per test and restored in afterEach, so the real
 * transport, the real introspection and the real provider all run - only the
 * server is fake. mock.module() is deliberately not used: it is process-wide in
 * bun and would poison sibling test files.
 *
 * Every payload below was captured from a live ClickHouse 26.7.1.1315 server
 * (database `demo`), so the fake speaks exactly what the server speaks. That
 * matters more here than in a typical mock, because four behaviours the provider
 * depends on are the opposite of what a JSON API teaches:
 *
 * - Failures are real HTTP status codes, but a permission denial arrives as 500
 *   and must be classified by `X-ClickHouse-Exception-Code`, never by status.
 * - A `UInt64` arrives as a decimal STRING (the transport asks for 64-bit
 *   quoting) while a `Float64` stays a number, so both encodings appear below.
 * - A write answers 200 with NO body and reports its row count in a header - and
 *   for `ALTER TABLE ... UPDATE` that count is 0 even though the mutation
 *   applied.
 * - `FORMAT`/`SETTINGS` are TRAILING clauses, so appending `LIMIT n` after one
 *   is a hard syntax error.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import { ClickHouseProvider } from "@/lib/db/providers/sql/clickhouse";
import { maintenanceControl } from "@/lib/db/types";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";

// ============================================================================
// Connection
// ============================================================================

const CLICKHOUSE: DatabaseType = "clickhouse";

const DATABASE = "demo";

function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "ch-1",
    name: "ClickHouse",
    type: CLICKHOUSE,
    host: "127.0.0.1",
    port: 8123,
    user: "libredb",
    password: "password123",
    database: DATABASE,
    createdAt: new Date(),
    ...overrides,
  };
}

// ============================================================================
// Exception codes, read back from the live server's own numbering
// (SELECT number, errorCodeToName(toUInt32(number)) FROM numbers(1500))
// ============================================================================

const NOT_IMPLEMENTED = 48;
const UNKNOWN_TABLE = 60;
const SYNTAX_ERROR = 62;
const UNKNOWN_DATABASE = 81;
const TIMEOUT_EXCEEDED = 159;
const NETWORK_ERROR = 210;
const QUERY_WAS_CANCELLED = 394;
const ACCESS_DENIED = 497;
const AUTHENTICATION_FAILED = 516;

// ============================================================================
// Catalog payloads (captured from ClickHouse 26.7.1.1315, trimmed)
// ----------------------------------------------------------------------------
// `default.audit` is the one row not captured live: it is the table outside the
// pinned database, and its sorting key extends its primary key, which is what
// makes the qualified display name and the synthesized ORDER BY entry testable.
// ============================================================================

const TABLE_ROWS = [
  {
    database: "default",
    name: "audit",
    total_rows: "12",
    total_bytes: "4096",
    sorting_key: "tenant, ts",
    primary_key: "tenant",
  },
  // A view reports NULL for both counters - unknown, never zero.
  { database: DATABASE, name: "daily_events", total_rows: null, total_bytes: null, sorting_key: "", primary_key: "" },
  {
    database: DATABASE,
    name: "orders",
    total_rows: "5",
    total_bytes: "2613",
    sorting_key: "user_id, order_id",
    primary_key: "user_id, order_id",
  },
  { database: DATABASE, name: "users", total_rows: "3", total_bytes: "2506", sorting_key: "id", primary_key: "id" },
];

const COLUMN_ROWS = [
  {
    database: "default",
    table: "audit",
    name: "tenant",
    type: "String",
    is_in_primary_key: 1,
    default_kind: "",
    default_expression: "",
  },
  {
    database: DATABASE,
    table: "daily_events",
    name: "day",
    type: "Date",
    is_in_primary_key: 0,
    default_kind: "",
    default_expression: "",
  },
  {
    database: DATABASE,
    table: "orders",
    name: "order_id",
    type: "UInt64",
    is_in_primary_key: 1,
    default_kind: "",
    default_expression: "",
  },
  {
    database: DATABASE,
    table: "orders",
    name: "status",
    type: "LowCardinality(String)",
    is_in_primary_key: 0,
    default_kind: "",
    default_expression: "",
  },
  {
    database: DATABASE,
    table: "users",
    name: "id",
    type: "UInt32",
    is_in_primary_key: 1,
    default_kind: "",
    default_expression: "",
  },
  {
    database: DATABASE,
    table: "users",
    name: "full_name",
    type: "Nullable(String)",
    is_in_primary_key: 0,
    default_kind: "",
    default_expression: "",
  },
];

const SKIPPING_INDEX_ROWS = [{ database: DATABASE, table: "orders", name: "idx_status", expr: "status" }];

// ============================================================================
// Monitoring payloads (captured live)
// ============================================================================

const IDENTITY_ROW = { version: "26.7.1.1315", uptimeSeconds: "1898" };
const CONNECTION_ROW = { connections: "1", maxConnections: "4096" };
const DATABASE_SIZE_ROW = { databaseSizeBytes: "3959" };
const TABLE_COUNT_ROW = { tableCount: "3" };
const INDEX_COUNT_ROW = { indexCount: "1" };

const EVENT_ROW = { cacheHits: "4", cacheMisses: "7", queryCount: "145", uptimeSeconds: "1898" };
// system.asynchronous_metrics is Float64, so these arrive unquoted - the readers
// have to accept both encodings.
const MEMORY_ROW = { memoryBytes: 1026949120, memoryTotalBytes: 67118129152 };

const SLOW_QUERY_ROWS = [
  {
    queryId: "7283842689206104996",
    query: "SELECT count() FROM orders WHERE status = 'paid'",
    calls: "3",
    totalMs: "1179",
    avgMs: 393,
    minMs: "281",
    maxMs: "505",
    resultRows: "3",
  },
];

const SESSION_ROWS = [
  {
    queryId: "1b39563e-105b-42dd-9a49-7fb7e0618f94",
    user: "libredb",
    database: DATABASE,
    clientAddr: "::ffff:172.17.0.1",
    elapsedSeconds: 12.5,
    query: "SELECT * FROM orders",
  },
  {
    queryId: "8a45dcda-0000-0000-0000-000000000000",
    user: "libredb",
    database: DATABASE,
    clientAddr: "::ffff:172.17.0.1",
    elapsedSeconds: 0.000923,
    query: "SELECT 1",
  },
];

const TABLE_STAT_ROWS = [
  { database: DATABASE, table: "orders", rowCount: "5", dataBytes: "621", indexBytes: "228", totalBytes: "2613" },
  { database: DATABASE, table: "users", rowCount: "3", dataBytes: "597", indexBytes: "132", totalBytes: "1346" },
];

const INDEX_STAT_ROWS = [
  {
    database: DATABASE,
    table: "orders",
    indexName: "idx_status",
    indexType: "set",
    expr: "status",
    indexSizeBytes: "219",
  },
  // A skipping index is declared over an EXPRESSION, and the expression may
  // carry commas of its own - which is why it is reported as one entry.
  {
    database: DATABASE,
    table: "orders",
    indexName: "idx_bucket",
    indexType: "minmax",
    expr: "cityHash64(user_id, status)",
    indexSizeBytes: "96",
  },
];

const DISK_ROWS = [
  {
    name: "default",
    path: "/var/lib/clickhouse/",
    totalBytes: "294147883008",
    freeBytes: "198620180480",
  },
];

const PART_SUMMARY_ROW = { partCount: "2", rowCount: "5", totalBytes: "2613" };

// ============================================================================
// fetch harness
// ============================================================================

/** One canned HTTP answer. Defaults describe a successful JSON result. */
interface Reply {
  status?: number;
  body?: string;
  /** What the server says it USED; null omits the header, as a DDL answer does. */
  format?: string | null;
  summary?: Record<string, string> | null;
  exceptionCode?: number;
}

const originalFetch = globalThis.fetch;

let sentSql: string[] = [];
let sentUrls: string[] = [];
let sentAuth: (string | null)[] = [];
let networkFailure: Error | null = null;
let replyFor: (sql: string) => Reply;

/** The JSON envelope, verbatim in shape: meta, data, rows, statistics. */
function envelope(rows: Record<string, unknown>[], meta?: { name: string; type: string }[]): string {
  const columns = meta ?? Object.keys(rows[0] ?? {}).map((name) => ({ name, type: "String" }));
  return JSON.stringify({ meta: columns, data: rows, rows: rows.length, statistics: { elapsed: 0.0012 } });
}

function jsonReply(rows: Record<string, unknown>[], meta?: { name: string; type: string }[]): Reply {
  return { body: envelope(rows, meta) };
}

/**
 * A write: 200, empty body, counters in the summary header only. `writtenRows`
 * is what the server reported, which for a mutation is honestly zero.
 */
function writeReply(writtenRows: string): Reply {
  return { body: "", format: null, summary: { written_rows: writtenRows, elapsed_ns: "1200000" } };
}

/** An exception: the body is plain TEXT even under an application/json content type. */
function exceptionReply(code: number, name: string, message: string, status = 400): Reply {
  return {
    status,
    exceptionCode: code,
    body: `Code: ${code}. DB::Exception: ${message}. (${name}) (version 26.7.1.1315 (official build))`,
  };
}

const DENIED = () =>
  exceptionReply(
    ACCESS_DENIED,
    "ACCESS_DENIED",
    "libredb: Not enough privileges. To execute this query, it's necessary to have grant SELECT",
    500,
  );

function toResponse(reply: Reply): Response {
  const headers = new Headers({ "content-type": "application/json" });
  const format = reply.format === undefined ? "JSON" : reply.format;
  if (format !== null) headers.set("x-clickhouse-format", format);
  const summary = reply.summary === undefined ? { written_rows: "0", elapsed_ns: "1200000" } : reply.summary;
  if (summary !== null) headers.set("x-clickhouse-summary", JSON.stringify(summary));
  if (reply.exceptionCode !== undefined) headers.set("x-clickhouse-exception-code", String(reply.exceptionCode));

  return new Response(reply.body ?? "", { status: reply.status ?? 200, headers });
}

/**
 * Route a statement onto the fixtures above. Keyed on the column aliases the
 * provider itself chose, so a routing miss is a renamed alias rather than a
 * fragile substring.
 */
function defaultReply(sql: string): Reply {
  if (sql === "SELECT 1") return jsonReply([{ "1": 1 }]);

  if (sql.includes("version()")) return jsonReply([IDENTITY_ROW]);
  if (sql.includes("system.metrics")) return jsonReply([CONNECTION_ROW]);
  if (sql.includes("system.events")) return jsonReply([EVENT_ROW]);
  if (sql.includes("system.asynchronous_metrics")) return jsonReply([MEMORY_ROW]);
  if (sql.includes("system.query_log")) return jsonReply(SLOW_QUERY_ROWS);
  if (sql.includes("system.processes")) return jsonReply(SESSION_ROWS);
  if (sql.includes("system.disks")) return jsonReply(DISK_ROWS);

  if (sql.includes("system.tables")) {
    return sql.includes("tableCount") ? jsonReply([TABLE_COUNT_ROW]) : jsonReply(TABLE_ROWS);
  }
  if (sql.includes("system.columns")) return jsonReply(COLUMN_ROWS);
  if (sql.includes("system.data_skipping_indices")) {
    if (sql.includes("indexCount")) return jsonReply([INDEX_COUNT_ROW]);
    return sql.includes("indexName") ? jsonReply(INDEX_STAT_ROWS) : jsonReply(SKIPPING_INDEX_ROWS);
  }
  if (sql.includes("system.parts")) {
    if (sql.includes("partCount")) return jsonReply([PART_SUMMARY_ROW]);
    return sql.includes("databaseSizeBytes") ? jsonReply([DATABASE_SIZE_ROW]) : jsonReply(TABLE_STAT_ROWS);
  }

  // OPTIMIZE and KILL QUERY both answer 200 with no body (live-verified).
  return writeReply("0");
}

function installFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (networkFailure) throw networkFailure;
    const sql = String(init?.body);
    sentUrls.push(String(input));
    sentSql.push(sql);
    sentAuth.push(new Headers(init?.headers).get("authorization"));
    return toResponse(replyFor(sql));
  }) as typeof fetch;
}

/** The credentials the transport put on the wire, decoded back into `user:password`. */
function credentialsOf(match: string): string {
  const index = sentSql.findIndex((statement) => statement.includes(match));
  return Buffer.from((sentAuth[index] ?? "").replace("Basic ", ""), "base64").toString();
}

/** The statement the provider sent that mentions `match`, or a failure naming it. */
function sqlWith(match: string): string {
  const sql = sentSql.find((statement) => statement.includes(match));
  if (sql === undefined) throw new Error(`no statement matching "${match}" was sent`);
  return sql;
}

function urlWith(match: string): string {
  const index = sentSql.findIndex((statement) => statement.includes(match));
  if (index === -1) throw new Error(`no statement matching "${match}" was sent`);
  return sentUrls[index];
}

async function connectProvider(overrides: Partial<DatabaseConnection> = {}): Promise<ClickHouseProvider> {
  const provider = new ClickHouseProvider(makeConnection(overrides));
  await provider.connect();
  return provider;
}

/** Every read fails the way a user without monitoring grants sees it. */
function denyEverything(): void {
  replyFor = () => DENIED();
}

beforeEach(() => {
  sentSql = [];
  sentUrls = [];
  sentAuth = [];
  networkFailure = null;
  replyFor = defaultReply;
  installFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ============================================================================
// Metadata
// ============================================================================

describe("ClickHouseProvider metadata", () => {
  // #U9: "Optimize Table" is `optimize`, not a vacuum ClickHouse does not have. The
  // global card stays withheld even so, because OPTIMIZE names one table - the
  // redirection is what stops the surface sending a `vacuum` this provider rejects.
  test("the vacuum label names OPTIMIZE, whose global form is still withheld", () => {
    const provider = new ClickHouseProvider(makeConnection());
    const labels = provider.getLabels();

    expect(labels.vacuumAction).toBe("Optimize Table");
    expect(labels.vacuumActionOperation).toBe("optimize");
    expect(provider.getCapabilities().maintenanceOperations).toContain("optimize");
    expect(provider.getCapabilities().maintenanceOperationSpecs?.optimize?.global).toBe(false);
  });
  test("declares the capabilities the design spec settled on", () => {
    const capabilities = new ClickHouseProvider(makeConnection()).getCapabilities();

    expect(capabilities).toEqual({
      queryLanguage: "sql",
      supportsExplain: true,
      explainFormat: "clickhouse-json",
      supportsExternalQueryLimiting: true,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      supportsMaintenance: true,
      maintenanceOperations: ["optimize", "analyze", "kill"],
      // OPTIMIZE names one table and `dispatchMaintenance` requires that target, so
      // there is no whole-database form to offer; `describeParts` accepts both (#496).
      maintenanceOperationSpecs: {
        optimize: { label: "Optimize Table", perEntity: true, global: false },
        analyze: { label: "Table Statistics", perEntity: true, global: true },
        kill: { label: "Cancel Query", perEntity: false, global: false },
      },
      supportsConnectionString: true,
      defaultPort: 8123,
      schemaRefreshPattern: "\\b(CREATE|DROP|ALTER|RENAME|TRUNCATE|ATTACH|DETACH)\\b",
    });
  });

  test("keeps supportsCreateTable false because the modal's default output is invalid here", () => {
    // Live-verified, and the reason the flag is not an oversight: the modal's
    // default column emits `id SERIAL PRIMARY KEY` (code 50, unknown data type
    // family) and its UNIQUE checkbox emits `UNIQUE` (code 62, syntax error).
    expect(new ClickHouseProvider(makeConnection()).getCapabilities().supportsCreateTable).toBe(false);
  });

  test("keeps supportsInlineRowEdit false because a bare UPDATE ... SET is not implemented here", () => {
    // ClickHouse spells a row mutation `ALTER TABLE t UPDATE c = v WHERE ...`; the
    // bare `UPDATE ... SET` the inline row editor builds answers code 48
    // NOT_IMPLEMENTED (documented in docs/providers/clickhouse.md §13).
    expect(new ClickHouseProvider(makeConnection()).getCapabilities().supportsInlineRowEdit).toBe(false);
  });

  test("declares declaresForeignKeys false because no constraint catalog exists here", () => {
    // ClickHouse parses REFERENCES in a column definition and enforces nothing by it,
    // and `system.*` holds no constraint table to read one back from (#414).
    expect(new ClickHouseProvider(makeConnection()).getCapabilities().declaresForeignKeys).toBe(false);
  });

  test("labels the maintenance actions ClickHouse actually has", () => {
    const labels = new ClickHouseProvider(makeConnection()).getLabels();

    expect(labels.entityName).toBe("Table");
    expect(labels.rowName).toBe("row");
    expect(labels.analyzeAction).toBe("Table Statistics");
    expect(labels.vacuumAction).toBe("Optimize Table");
    expect(labels.vacuumGlobalDesc).toContain("OPTIMIZE");
    expect(labels.analyzeGlobalDesc).toContain("no ANALYZE");
  });

  // The `vacuumGlobal*` triad above is DELIBERATELY unreachable, which is a claim that
  // has to be executable rather than a comment: the global vacuum card follows
  // `vacuumActionOperation`, and that operation declares no whole-database form here.
  // Written-and-never-shown wording is the condition #U9 set out to remove, so if a
  // future spec change makes `optimize` global, this test says the words are live again
  // and must be checked against what the card would then run.
  test("the global vacuum card cannot render, so its wording is unreachable by design", () => {
    const provider = new ClickHouseProvider(makeConnection());
    const capabilities = provider.getCapabilities();
    const vacuumOperation = provider.getLabels().vacuumActionOperation ?? "vacuum";

    expect(vacuumOperation).toBe("optimize");
    expect(maintenanceControl(capabilities, vacuumOperation, "global").offered).toBe(false);
    // The per-row control IS reachable, so this is not a provider with no maintenance.
    expect(maintenanceControl(capabilities, vacuumOperation, "perEntity").offered).toBe(true);
  });

  // Until #U12 the monitoring Queries panel told a ClickHouse operator to install a
  // PostgreSQL extension. `getSlowQueries()` reads system.query_log, which records
  // nothing while `log_queries` is off, so that is the setting the sentence must name.
  test("names system.query_log, not a Postgres extension, as where query stats come from", () => {
    const { slowQueriesEmptyState } = new ClickHouseProvider(makeConnection()).getLabels();

    expect(slowQueriesEmptyState).toContain("system.query_log");
    expect(slowQueriesEmptyState).toContain("log_queries");
    expect(slowQueriesEmptyState).not.toContain("pg_stat_statements");
  });
});

// ============================================================================
// Validation and the connection model
// ============================================================================

describe("ClickHouseProvider validation", () => {
  test("requires a host or a connection string", () => {
    expect(() => new ClickHouseProvider(makeConnection({ host: undefined }))).toThrow(DatabaseConfigError);
  });

  test("does not require a database, because the server always has `default`", async () => {
    const provider = await connectProvider({ database: undefined });

    expect(urlWith("SELECT 1")).not.toContain("database=");
    await provider.disconnect();
  });

  test("sends the pinned database as a request parameter", async () => {
    const provider = await connectProvider();

    expect(urlWith("SELECT 1")).toContain(`database=${DATABASE}`);
    await provider.disconnect();
  });

  test("lifts a hand-typed connection string into host, credentials and database", async () => {
    // The URI tab clears host/port/user/password, so the URL is the only source
    // for all four; the provider has to honour it or the connection has no target.
    const provider = await connectProvider({
      host: undefined,
      port: undefined,
      user: undefined,
      password: undefined,
      database: undefined,
      connectionString: "http://reader:s3cret@ch.internal:9123/analytics",
    });

    const url = urlWith("SELECT 1");
    expect(url).toContain("http://ch.internal:9123/");
    expect(url).toContain("database=analytics");
    expect(credentialsOf("SELECT 1")).toBe("reader:s3cret");
    await provider.disconnect();
  });

  test("decodes percent-encoded credentials out of a clickhouse:// string", async () => {
    // A password with a reserved character has to be encoded to survive the URL,
    // so sending it verbatim would authenticate as the wrong secret.
    const provider = await connectProvider({
      host: undefined,
      user: undefined,
      password: undefined,
      connectionString: "clickhouse://reader:p%40ss%2Fword@ch.internal:8123/demo",
    });

    expect(credentialsOf("SELECT 1")).toBe("reader:p@ss/word");
    await provider.disconnect();
  });

  test("an https connection string switches scheme and takes the TLS default port", async () => {
    const provider = await connectProvider({
      host: undefined,
      port: undefined,
      connectionString: "https://abc.clickhouse.cloud/default",
    });

    expect(urlWith("SELECT 1")).toContain("https://abc.clickhouse.cloud:8443/");
    await provider.disconnect();
  });

  // The scheme is the more specific statement of intent: it names the transport,
  // while the ssl setting is a separate field that may be left over from an earlier
  // edit. An explicit http:// URL that deferred to it would send HTTPS to a
  // plaintext endpoint and fail with a bare "fetch failed".
  test("an explicit http connection string overrides a leftover TLS setting", async () => {
    const provider = await connectProvider({
      host: undefined,
      port: undefined,
      ssl: { mode: "require" },
      connectionString: "http://ch.internal:8123/demo",
    });

    expect(urlWith("SELECT 1")).toContain("http://ch.internal:8123/");
    await provider.disconnect();
  });

  // clickhouse:// names no transport, so it is the one scheme that must defer.
  test("a clickhouse:// connection string defers to the configured TLS setting", async () => {
    const provider = await connectProvider({
      host: undefined,
      port: undefined,
      ssl: { mode: "require" },
      connectionString: "clickhouse://ch.internal/demo",
    });

    expect(urlWith("SELECT 1")).toContain("https://ch.internal:8443/");
    await provider.disconnect();
  });

  test("keeps the configured fields when the connection string is unparsable", async () => {
    const provider = await connectProvider({ connectionString: "not a url" });

    expect(urlWith("SELECT 1")).toContain("http://127.0.0.1:8123/");
    await provider.disconnect();
  });
});

// ============================================================================
// Lifecycle
// ============================================================================

describe("ClickHouseProvider lifecycle", () => {
  test("connect proves the server, the credentials and the database with SELECT 1", async () => {
    const provider = await connectProvider();

    expect(provider.isConnected()).toBe(true);
    expect(sentSql[0]).toBe("SELECT 1");
  });

  test("connect reports a non-existent database immediately rather than at first query", async () => {
    // Live-verified: a bad `database` parameter is not rejected when the
    // connection is made - it fails 404 / code 81 on the first statement - so
    // without the probe the user would see it much later and somewhere else.
    replyFor = () => exceptionReply(UNKNOWN_DATABASE, "UNKNOWN_DATABASE", "Database nope does not exist", 404);
    const provider = new ClickHouseProvider(makeConnection({ database: "nope" }));

    await expect(provider.connect()).rejects.toBeInstanceOf(ConnectionError);
    expect(provider.isConnected()).toBe(false);
  });

  test("connect maps rejected credentials to an AuthenticationError", async () => {
    replyFor = () => exceptionReply(AUTHENTICATION_FAILED, "AUTHENTICATION_FAILED", "Authentication failed", 403);
    const provider = new ClickHouseProvider(makeConnection());

    await expect(provider.connect()).rejects.toBeInstanceOf(AuthenticationError);
    expect(provider.isConnected()).toBe(false);
  });

  test("connect maps an unreachable server to a ConnectionError", async () => {
    networkFailure = new Error("connect ECONNREFUSED 127.0.0.1:8123");
    const provider = new ClickHouseProvider(makeConnection());

    await expect(provider.connect()).rejects.toBeInstanceOf(ConnectionError);
  });

  test("disconnect releases the transport and is safe to call twice", async () => {
    const provider = await connectProvider();

    await provider.disconnect();
    await provider.disconnect();

    expect(provider.isConnected()).toBe(false);
  });

  test("query before connect is refused", async () => {
    const provider = new ClickHouseProvider(makeConnection());

    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(DatabaseConfigError);
  });
});

// ============================================================================
// Query execution
// ============================================================================

describe("ClickHouseProvider query", () => {
  test("returns rows, the declared column order and the server's own duration", async () => {
    const provider = await connectProvider();
    replyFor = () =>
      jsonReply(
        [{ id: 1, email: "a@b.c" }],
        [
          { name: "id", type: "UInt32" },
          { name: "email", type: "String" },
        ],
      );

    const result = await provider.query("SELECT id, email FROM users");

    expect(result.rows).toEqual([{ id: 1, email: "a@b.c" }]);
    expect(result.fields).toEqual(["id", "email"]);
    expect(result.rowCount).toBe(1);
    expect(result.executionTime).toBe(1);
  });

  test("gives the server a deadline so a runaway statement cannot hang the editor", async () => {
    const provider = await connectProvider();

    await provider.query("SELECT count() FROM orders");

    expect(urlWith("count()")).toContain("max_execution_time=60");
  });

  test("reports an INSERT row count from what the server said it wrote", async () => {
    const provider = await connectProvider();
    replyFor = () => writeReply("2");

    const result = await provider.query("INSERT INTO users VALUES (1, 'a@b.c'), (2, 'd@e.f')");

    expect(result.rowCount).toBe(2);
    expect(result.rows).toEqual([]);
    expect(result.fields).toEqual([]);
  });

  test("reports zero for an ALTER TABLE UPDATE, because that is what the server reports", async () => {
    // Live-verified honesty caveat: the mutation really applies, but it is queued
    // as a background mutation and the server counts no written rows for it.
    // Fabricating a plausible count here would put a wrong number on screen.
    const provider = await connectProvider();
    replyFor = () => writeReply("0");

    const result = await provider.query("ALTER TABLE users UPDATE email = 'x@y.z' WHERE id = 1");

    expect(result.rowCount).toBe(0);
  });

  test("surfaces a format the user chose as one synthetic text column", async () => {
    // Live-verified: an explicit FORMAT in the user's SQL beats the JSON the
    // transport asked for, so the body is TSV. The user asked for that
    // deliberately, so it is shown rather than thrown away or parsed.
    const provider = await connectProvider();
    replyFor = () => ({ body: "1\ta@b.c\n2\td@e.f\n", format: "TSV" });

    const result = await provider.query("SELECT id, email FROM users FORMAT TSV");

    expect(result.fields).toEqual(["__text"]);
    expect(result.rows).toEqual([{ __text: "1\ta@b.c\n2\td@e.f\n" }]);
    expect(result.rowCount).toBe(1);
  });

  test("falls back to the measured duration when the server reported none", async () => {
    const provider = await connectProvider();
    replyFor = () => ({ body: JSON.stringify({ meta: [], data: [] }), summary: null });

    const result = await provider.query("SELECT 1");

    expect(result.executionTime).toBeGreaterThanOrEqual(0);
  });

  test("refuses positional parameters instead of silently ignoring them", async () => {
    // The HTTP interface binds only named `{name:Type}` parameters, so a caller
    // that passed positional ones would otherwise get a statement run with the
    // placeholders unbound.
    const provider = await connectProvider();

    await expect(provider.query("SELECT * FROM users WHERE id = ?", [1])).rejects.toBeInstanceOf(QueryError);
  });

  test("accepts an empty parameter array, which is how the app calls every provider", async () => {
    const provider = await connectProvider();

    await expect(provider.query("SELECT 1", [])).resolves.toBeDefined();
  });

  test("carries the declared type of each column, keyed by the field name it reported (#273)", async () => {
    // The wrapper is the point: `Nullable(String)` is what tells the user the
    // column accepts nulls, and the schema tree cannot answer for a computed
    // column like `count()` because no catalog entry exists for it.
    const provider = await connectProvider();
    replyFor = () =>
      jsonReply(
        [{ id: 1, email: null, total: "7" }],
        [
          { name: "id", type: "UInt32" },
          { name: "email", type: "Nullable(String)" },
          { name: "total", type: "UInt64" },
        ],
      );

    const result = await provider.query("SELECT id, email, count() AS total FROM users GROUP BY id, email");

    expect(result.columnTypes).toEqual({ id: "UInt32", email: "Nullable(String)", total: "UInt64" });
    expect(Object.keys(result.columnTypes ?? {})).toEqual(result.fields);
  });

  test("leaves the type channel absent for a write, which declares no columns", async () => {
    const provider = await connectProvider();
    replyFor = () => writeReply("2");

    const result = await provider.query("INSERT INTO users VALUES (1, 'a@b.c'), (2, 'd@e.f')");

    expect(result.columnTypes).toBeUndefined();
    expect("columnTypes" in result).toBe(false);
  });

  test("leaves the type channel absent for a format the user chose", async () => {
    // The synthetic `__text` column is this provider's own invention, so there is
    // no declared type to report for it.
    const provider = await connectProvider();
    replyFor = () => ({ body: "1\ta@b.c\n", format: "TSV" });

    const result = await provider.query("SELECT id, email FROM users FORMAT TSV");

    expect(result.fields).toEqual(["__text"]);
    expect(result.columnTypes).toBeUndefined();
  });

  test("leaves the type channel absent when the envelope described no columns at all", async () => {
    const provider = await connectProvider();
    replyFor = () => ({ body: JSON.stringify({ meta: [], data: [] }) });

    const result = await provider.query("SELECT 1");

    expect(result.columnTypes).toBeUndefined();
  });
});

// ============================================================================
// Error mapping
// ============================================================================

describe("ClickHouseProvider error mapping", () => {
  test("a missing grant becomes an AuthenticationError even though its prose says neither denied nor permission", async () => {
    // The 497 message reads "Not enough privileges. To execute this query, it's
    // necessary to have grant ...", so message sniffing would miss it entirely.
    // Classification is by code for exactly this reason.
    const provider = await connectProvider();
    replyFor = () => DENIED();

    await expect(provider.query("SELECT * FROM system.query_log")).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("bad credentials become an AuthenticationError", async () => {
    const provider = await connectProvider();
    replyFor = () => exceptionReply(AUTHENTICATION_FAILED, "AUTHENTICATION_FAILED", "Authentication failed", 403);

    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("a syntax error becomes a QueryError carrying the statement", async () => {
    const provider = await connectProvider();
    replyFor = () => exceptionReply(SYNTAX_ERROR, "SYNTAX_ERROR", "Syntax error: failed at position 1", 400);

    const failure = provider.query("SELEC 1");

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow("Syntax error");
  });

  test("an unknown table becomes a QueryError", async () => {
    const provider = await connectProvider();
    replyFor = () => exceptionReply(UNKNOWN_TABLE, "UNKNOWN_TABLE", "Unknown table expression identifier", 404);

    await expect(provider.query("SELECT * FROM nope")).rejects.toBeInstanceOf(QueryError);
  });

  test("a bare UPDATE surfaces the server's own explanation of why it is unsupported", async () => {
    // Live-verified on 26.7.1: `UPDATE ... SET` is code 48, and its message names
    // the exact precondition, which is far more useful than any wording here.
    const provider = await connectProvider();
    replyFor = () =>
      exceptionReply(
        NOT_IMPLEMENTED,
        "NOT_IMPLEMENTED",
        "Lightweight updates are not supported. Lightweight updates are supported only for tables with materialized _block_number column",
        501,
      );

    const failure = provider.query("UPDATE users SET email = 'x@y.z' WHERE id = 1");

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow("Lightweight updates are not supported");
  });

  test("an exceeded deadline becomes a TimeoutError", async () => {
    const provider = await connectProvider();
    replyFor = () => exceptionReply(TIMEOUT_EXCEEDED, "TIMEOUT_EXCEEDED", "Timeout exceeded: elapsed 60s", 500);

    await expect(provider.query("SELECT sleep(3)")).rejects.toBeInstanceOf(TimeoutError);
  });

  test("a killed query becomes a QueryCancelledError", async () => {
    const provider = await connectProvider();
    replyFor = () => exceptionReply(QUERY_WAS_CANCELLED, "QUERY_WAS_CANCELLED", "Query was cancelled", 500);

    await expect(provider.query("SELECT count() FROM orders")).rejects.toBeInstanceOf(QueryCancelledError);
  });

  test("a server-side network fault becomes a ConnectionError", async () => {
    const provider = await connectProvider();
    replyFor = () => exceptionReply(NETWORK_ERROR, "NETWORK_ERROR", "All connection tries failed", 500);

    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(ConnectionError);
  });

  test("a failure that never reached the server is classified from the socket error", async () => {
    const provider = await connectProvider();
    networkFailure = new Error("connect ECONNREFUSED 127.0.0.1:8123");

    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(ConnectionError);
  });

  test("a client-side abort with no server code still surfaces as a database error", async () => {
    const provider = await connectProvider();
    networkFailure = new Error("The operation was aborted");

    await expect(provider.query("SELECT 1")).rejects.toThrow(/aborted/);
  });
});

// ============================================================================
// Query preparation (the trailing-clause override)
// ============================================================================

describe("ClickHouseProvider query preparation", () => {
  const provider = () => new ClickHouseProvider(makeConnection());

  test("applies the external row limit to a plain SELECT", () => {
    const prepared = provider().prepareQuery("SELECT * FROM users", { limit: 25 });

    expect(prepared.query).toBe("SELECT * FROM users LIMIT 25");
    expect(prepared.wasLimited).toBe(true);
    expect(prepared.limit).toBe(25);
  });

  test.each([
    ["a trailing FORMAT clause", "SELECT * FROM users FORMAT TSV"],
    ["a trailing FORMAT clause and a semicolon", "SELECT * FROM users FORMAT JSONEachRow;"],
    ["a trailing SETTINGS clause", "SELECT * FROM users SETTINGS max_threads = 1"],
    ["several settings", "SELECT * FROM users SETTINGS max_threads=1, max_block_size=100"],
    ["FORMAT followed by SETTINGS", "SELECT * FROM users FORMAT TSV SETTINGS max_threads=1"],
    ["an existing LIMIT before FORMAT", "SELECT * FROM users LIMIT 1 FORMAT TSV"],
  ])("leaves %s untouched, because LIMIT after either is a hard syntax error", (_label, sql) => {
    // Live-verified: `SELECT * FROM probe FORMAT TSV LIMIT 1` and
    // `... SETTINGS max_threads=1 LIMIT 1` both answer 400 / code 62. The
    // inherited limiter appends LIMIT at the very END, so it must not run here.
    const prepared = provider().prepareQuery(sql, { limit: 25 });

    expect(prepared.query).toBe(sql);
    expect(prepared.wasLimited).toBe(false);
    expect(prepared.limit).toBe(25);
  });

  test.each([
    ["the word format inside a string literal", "SELECT * FROM users WHERE note = 'format'"],
    ["a whole clause quoted inside a literal", "SELECT * FROM users WHERE note = 'FORMAT TSV'"],
    ["the settings table itself", "SELECT name, value FROM system.settings"],
    ["a filtered read of the settings table", "SELECT name FROM system.settings WHERE name = 'max_threads'"],
    ["a column named settings", "SELECT settings FROM system.columns WHERE database = 'demo'"],
    ["a comparison against a settings column", "SELECT * FROM audit WHERE settings = 1"],
  ])("still limits %s", (_label, sql) => {
    const prepared = provider().prepareQuery(sql, { limit: 25 });

    expect(prepared.query).toBe(`${sql} LIMIT 25`);
    expect(prepared.wasLimited).toBe(true);
  });

  test("accepts one false positive: an assignment inside a trailing string literal", () => {
    // Documented trade-off, not an oversight. Ruling this out needs a
    // string-literal-aware tokenizer; the cost of being wrong in THIS direction is
    // only a missing row limit, while the opposite error produces a hard syntax
    // error. If a tokenizer ever lands, this expectation should flip deliberately.
    const sql = "SELECT * FROM audit WHERE note = 'SETTINGS foo = 1'";

    const prepared = provider().prepareQuery(sql, { limit: 25 });

    expect(prepared.query).toBe(sql);
    expect(prepared.wasLimited).toBe(false);
  });

  // ── Trailing comments (#280) ──────────────────────────────────────────────
  //
  // The trailing-clause patterns are anchored at the end of the statement, and
  // until the limiter learned where a statement ends, a line comment after the
  // clause hid it from them. That was harmless only for as long as the inherited
  // bound landed inside the same comment: once it is placed before the comment,
  // `... FORMAT TSV LIMIT 25 -- note` is the 400 / code 62 this override exists
  // to prevent. Detection and placement have to read the same end.
  test.each([
    ["FORMAT before a line comment", "SELECT * FROM users FORMAT TSV -- exported nightly"],
    ["FORMAT before a semicolon and a comment", "SELECT * FROM users FORMAT JSONEachRow; -- exported nightly"],
    ["SETTINGS before a line comment", "SELECT * FROM users SETTINGS max_threads = 1 -- tuned"],
    ["FORMAT before a block comment", "SELECT * FROM users FORMAT TSV /* exported nightly */"],
    // Two reasons agree here: the pattern still matches (a refused cut reports
    // the whole text as the end) AND the shared limiter declines on its own,
    // because a literal it cannot close is one it will not rewrite.
    ["a statement whose end may not be cut", "SELECT * FROM users WHERE path = 'C:\\' FORMAT TSV"],
  ])("still refuses to rewrite %s", (_label, sql) => {
    const prepared = provider().prepareQuery(sql, { limit: 25 });

    expect(prepared.query).toBe(sql);
    expect(prepared.wasLimited).toBe(false);
  });

  test("bounds an ordinary statement that ends in a comment, before the comment", () => {
    const prepared = provider().prepareQuery("SELECT * FROM users -- daily check", { limit: 25 });

    expect(prepared.query).toBe("SELECT * FROM users LIMIT 25 -- daily check");
    expect(prepared.wasLimited).toBe(true);
  });

  // ── `//` is a line comment here too (S1) ──────────────────────────────────
  //
  // The fourth form of the same record. Reading the two slashes as code put the
  // bound INSIDE the comment, so the server saw an unbounded query: measured on
  // ClickHouse 26.7.1, `SELECT number FROM numbers(1000) // note` emitted with
  // `... // note LIMIT 5` returned all 1000 rows while `wasLimited` said 5. The
  // grammar fact is shared with Apache Cassandra and with no other dialect here.

  test("bounds a statement that ends in a `//` comment, before the comment", () => {
    const prepared = provider().prepareQuery("SELECT number FROM numbers(1000) // note", { limit: 5 });

    expect(prepared.query).toBe("SELECT number FROM numbers(1000) LIMIT 5 // note");
    expect(prepared.wasLimited).toBe(true);
  });

  test("reads a `//` comment as ending at its newline, not at the end of the buffer", () => {
    const prepared = provider().prepareQuery("SELECT number // note\nFROM numbers(1000)", { limit: 5 });

    expect(prepared.query).toBe("SELECT number // note\nFROM numbers(1000) LIMIT 5");
    expect(prepared.wasLimited).toBe(true);
  });

  // ── The `#` grammar is ClickHouse's here (#292) ────────────────────────────
  //
  // ClickHouse's syntax reference lists `#` and `#!` alongside `--` as line
  // comments. The shared reader had to guess, and the rule it guessed was
  // PostgreSQL's - a hash followed by an operator character is code - so a
  // ClickHouse comment written that way was read as SQL, and an ordinary one at
  // the end of a statement made the bound unplaceable. Named, the dialect gets
  // the bound written before the comment, exactly as the `--` form does.

  test.each<[string, string, string]>([
    ["a plain hash comment", "SELECT * FROM users # daily check", "SELECT * FROM users LIMIT 25 # daily check"],
    ["a hashbang comment", "SELECT * FROM users #! daily check", "SELECT * FROM users LIMIT 25 #! daily check"],
    // The clause commented out with a hash is not a clause: reading it as one
    // would leave the statement unbounded, and reading the comment as code would
    // put the bound after a `FORMAT` this provider refuses to write past.
    ["a commented-out FORMAT", "SELECT * FROM users # FORMAT TSV", "SELECT * FROM users LIMIT 25 # FORMAT TSV"],
  ])("bounds a statement ending in %s, before the comment", (_label, sql, expected) => {
    const prepared = provider().prepareQuery(sql, { limit: 25 });

    expect(prepared.query).toBe(expected);
    expect(prepared.wasLimited).toBe(true);
  });

  // Fixture discipline: a hash beside ClickHouse's array literal — two facts of
  // the same grammar record meeting inside one statement. The bound must land
  // before the comment and leave the array untouched; a bound spliced into `[…]`
  // is the statement-corrupting shape this suite exists to catch.
  test("bounds a statement carrying an array literal and a trailing hash comment", () => {
    const prepared = provider().prepareQuery("SELECT [1,2] AS a FROM t # daily", { limit: 25 });

    expect(prepared.query).toBe("SELECT [1,2] AS a FROM t LIMIT 25 # daily");
    expect(prepared.wasLimited).toBe(true);
  });

  // ── `[…]` is an array here, not a quoted name (#295) ──────────────────────
  //
  // The shared span reader used to read every bracketed run as SQL Server's
  // quoted identifier: the run ended at the first unpaired `]` and a doubled one
  // was an escape. Both are wrong for ClickHouse, where `[…]` nests and nothing
  // inside it is escaped, and both cost the statement its bound — a `]` inside a
  // subscript key ended the run early (so the CTE element could not be crossed and
  // the statement typed OTHER), and a nested array's `]]` was read as an escape,
  // so the run never closed and the end was not cuttable. Named, the dialect gets
  // the array reading; SQL Server and SQLite keep the name one.
  test.each<[string, string]>([
    ["a nested array in the select list", "SELECT [[1,2],[3,4]] AS a FROM t"],
    ["a map subscript whose key carries a close bracket", "WITH m['a]b'] AS v SELECT v FROM t"],
    ["a nested array CTE element", "WITH [[1,2],[3,4]] AS a SELECT arrayJoin(a)"],
    ["an array holding a close bracket in a literal", "WITH ['a]', 'b'] AS a SELECT a"],
    // Syntax the reader models as neither of its two bracket shapes: a lambda
    // inside an array, a map literal whose key carries a close bracket, and a
    // chained subscript.
    ["a lambda inside an array", "WITH arrayMap(x -> x, [[1],[2]]) AS a SELECT a"],
    ["a map literal subscripted by a bracketed key", "WITH map('a]b', 1)['a]b'] AS v SELECT v"],
    ["a subscript chain", "SELECT m['k']['j]'] AS v FROM t"],
    // The rows where the run is the statement's LAST token are the ones that pin
    // it as the statement's own TEXT: with code after the run, the end reaches the
    // input's length whether the run is read as text or as trivia, so the emitted
    // SQL is the same either way. Read as trivia, these three come back as
    // `SELECT LIMIT 25 [1,2]` and `SELECT m LIMIT 25['a]b']` — a corrupted
    // statement reported as limited. Reported by review on this task.
    ["an array literal that ends the statement", "SELECT [1,2]"],
    ["a nested array that ends the statement", "SELECT [[1,2],[3,4]]"],
    ["a subscript that ends the statement", "SELECT m['a]b']"],
  ])("bounds %s, emitted intact", (_label, sql) => {
    const prepared = provider().prepareQuery(sql, { limit: 25 });

    expect(prepared.query).toBe(`${sql} LIMIT 25`);
    expect(prepared.wasLimited).toBe(true);
  });

  test("refuses to rewrite a statement whose array literal never closes", () => {
    // The fail-safe direction is unchanged: a run the reader cannot close is
    // undeterminable, and an undeterminable end is not cut.
    const sql = "SELECT [[1,2] AS a FROM t";

    const prepared = provider().prepareQuery(sql, { limit: 25 });

    expect(prepared.query).toBe(sql);
    expect(prepared.wasLimited).toBe(false);
  });

  // ── Block comments NEST here too (#300) ───────────────────────────────────
  //
  // ClickHouse's syntax reference states C-style comments can be nested and gives
  // a nested example. Read flat, the run between the inner `*/` and the comment's
  // real end reaches the readers as code, which costs a statement carrying one its
  // bound - the entire cost on this engine, which has no data-modifying CTE.

  test.each<[string, string]>([
    ["a leading nested comment", "/* a /* b */ x */ SELECT arrayJoin([1, 2]) AS n"],
    ["a nested comment inside a CTE element", "WITH /* a /* b */ x */ 1 AS one SELECT one FROM events"],
    ["a nested comment carrying a close bracket and a paren", "SELECT /* a /* ] ) */ x */ [1,2] AS a FROM t"],
  ])("bounds a statement carrying %s, emitted intact", (_label, sql) => {
    const prepared = provider().prepareQuery(sql, { limit: 25 });

    expect(prepared.query).toBe(`${sql} LIMIT 25`);
    expect(prepared.wasLimited).toBe(true);
  });

  test("places the bound before a trailing nested comment, not inside it", () => {
    const prepared = provider().prepareQuery("SELECT n FROM events /* a /* b */ c */", { limit: 25 });

    expect(prepared.query).toBe("SELECT n FROM events LIMIT 25 /* a /* b */ c */");
    expect(prepared.wasLimited).toBe(true);
  });

  test("refuses to rewrite a statement whose nested comment never closes", () => {
    const sql = "/* a /* b */ SELECT n FROM events";

    const prepared = provider().prepareQuery(sql, { limit: 25 });

    expect(prepared.query).toBe(sql);
    expect(prepared.wasLimited).toBe(false);
  });

  // ── Expression-form CTEs (#291) ───────────────────────────────────────────
  //
  // `WITH <expr> AS <alias>` is how a CTE is ordinarily written here, and it is
  // not the `name AS (body)` shape the statement typer walks. While that walk
  // recognised only the standard shape, these statements typed OTHER and reached
  // the server with no bound at all - on the engine whose whole point is scanning
  // more rows than a browser can hold. ClickHouse has no data-modifying CTE, so
  // the missing bound was the entire cost, and the entire fix.
  test.each([
    ["a scalar alias", "WITH 1 AS one SELECT one, count(*) FROM events GROUP BY one"],
    ["a function alias", "WITH now() AS t SELECT * FROM events WHERE ts < t"],
    ["an array alias", "WITH [1, 2, 3] AS arr SELECT arrayJoin(arr)"],
    ["a subquery alias", "WITH (SELECT max(id) FROM events) AS m SELECT m"],
    ["a mixed CTE list", "WITH 1 AS one, t AS (SELECT 2 AS two) SELECT one, two FROM t"],
    ["a standard read-only CTE", "WITH t AS (SELECT 1 AS one) SELECT one FROM t"],
  ])("bounds a CTE written with %s", (_label, sql) => {
    const prepared = provider().prepareQuery(sql, { limit: 25 });

    expect(prepared.query).toBe(`${sql} LIMIT 25`);
    expect(prepared.wasLimited).toBe(true);
  });

  test("keeps a trailing FORMAT clause safe on an expression CTE", () => {
    // The two readings have to agree on the same statement: typed as a SELECT by
    // the CTE reader, refused by the trailing-clause override.
    const sql = "WITH 1 AS one SELECT one FORMAT TSV";

    const prepared = provider().prepareQuery(sql, { limit: 25 });

    expect(prepared.query).toBe(sql);
    expect(prepared.wasLimited).toBe(false);
  });

  test("leaves a write untouched", () => {
    const prepared = provider().prepareQuery("INSERT INTO users VALUES (1, 'a@b.c')");

    expect(prepared.query).toBe("INSERT INTO users VALUES (1, 'a@b.c')");
    expect(prepared.wasLimited).toBe(false);
  });

  test("lifts the ceiling for an unlimited export", () => {
    const prepared = provider().prepareQuery("SELECT * FROM users", { unlimited: true });

    expect(prepared.query).toBe("SELECT * FROM users LIMIT 100000");
    expect(prepared.limit).toBe(100000);
  });
});

// ============================================================================
// Schema
// ============================================================================

describe("ClickHouseProvider schema", () => {
  test("getSchema reports every non-system database, qualifying only the ones outside the pin", async () => {
    const provider = await connectProvider();

    const schema = await provider.getSchema();

    expect(schema.map((table) => table.name)).toEqual(["default.audit", "daily_events", "orders", "users"]);
    expect(schema[3].columns).toEqual([
      { name: "id", type: "UInt32", nullable: false, isPrimary: true, defaultValue: undefined },
      { name: "full_name", type: "Nullable(String)", nullable: true, isPrimary: false, defaultValue: undefined },
    ]);
  });

  test("getSchema reports the sparse primary index and the data-skipping indexes, none of them unique", async () => {
    // ClickHouse's primary key is a real sparse index but enforces nothing
    // (live-verified: three identical values were accepted into a table declared
    // PRIMARY KEY (a)), and a data-skipping index only prunes granules.
    const provider = await connectProvider();

    const schema = await provider.getSchema();

    expect(schema[2].indexes).toEqual([
      { name: "PRIMARY KEY", columns: ["user_id", "order_id"], unique: false },
      { name: "idx_status", columns: ["status"], unique: false },
    ]);
  });

  test("getSchema reports ORDER BY separately only when the sorting key extends the primary key", async () => {
    const provider = await connectProvider();

    const schema = await provider.getSchema();

    expect(schema[0].indexes).toEqual([
      { name: "PRIMARY KEY", columns: ["tenant"], unique: false },
      { name: "ORDER BY", columns: ["tenant", "ts"], unique: false },
    ]);
  });

  test("getSchema leaves a view's row count and size unknown rather than zero", async () => {
    const provider = await connectProvider();

    const schema = await provider.getSchema();

    expect(schema[1].rowCount).toBeUndefined();
    expect(schema[1].size).toBeUndefined();
    expect(schema[2].rowCount).toBe(5);
    expect(schema[2].size).toBe("2.55 KB");
  });

  test("getSchema never invents a foreign key, because ClickHouse has none", async () => {
    const provider = await connectProvider();

    const schema = await provider.getSchema();

    expect(schema.every((table) => table.foreignKeys?.length === 0)).toBe(true);
  });

  test("getSchemaList skips the index catalog so the table list is never blocked by it", async () => {
    const provider = await connectProvider();

    const tables = await provider.getSchemaList();

    expect(tables.map((table) => table.name)).toEqual(["default.audit", "daily_events", "orders", "users"]);
    expect(tables.every((table) => table.indexes.length === 0)).toBe(true);
    expect(sentSql.some((sql) => sql.includes("system.data_skipping_indices"))).toBe(false);
  });

  test("getSchemaRelations returns an entry for every table, empty lists included", async () => {
    const provider = await connectProvider();

    const relations = await provider.getSchemaRelations();

    expect(relations.map((relation) => relation.name)).toEqual(["default.audit", "daily_events", "orders", "users"]);
    expect(relations[1].indexes).toEqual([]);
    expect(relations[1].foreignKeys).toEqual([]);
  });

  test("getTables lists the display names", async () => {
    const provider = await connectProvider();

    expect(await provider.getTables()).toEqual(["default.audit", "daily_events", "orders", "users"]);
  });

  test("a denied index catalog still yields a schema tree", async () => {
    // Live-verified: system.tables and system.columns are pre-filtered to what
    // the user may read, but system.data_skipping_indices needs its own grant.
    // Losing the whole tree over that would punish a usable connection.
    const provider = await connectProvider();
    replyFor = (sql) => (sql.includes("system.data_skipping_indices") ? DENIED() : defaultReply(sql));

    const schema = await provider.getSchema();

    expect(schema[2].indexes).toEqual([{ name: "PRIMARY KEY", columns: ["user_id", "order_id"], unique: false }]);
  });

  test("a real catalog failure propagates instead of showing an empty tree", async () => {
    const provider = await connectProvider();
    replyFor = () => exceptionReply(SYNTAX_ERROR, "SYNTAX_ERROR", "Syntax error", 400);

    await expect(provider.getSchema()).rejects.toBeInstanceOf(QueryError);
  });
});

// ============================================================================
// Monitoring
// ============================================================================

describe("ClickHouseProvider monitoring", () => {
  test("getOverview combines the ungated identity read with the gated catalogs", async () => {
    const provider = await connectProvider();

    const overview = await provider.getOverview();

    expect(overview.version).toBe("26.7.1.1315");
    expect(overview.uptime).toBe("31.63m");
    expect(overview.startTime).toBeInstanceOf(Date);
    expect(overview.activeConnections).toBe(1);
    expect(overview.maxConnections).toBe(4096);
    expect(overview.databaseSizeBytes).toBe(3959);
    expect(overview.databaseSize).toBe("3.87 KB");
    expect(overview.tableCount).toBe(3);
    expect(overview.indexCount).toBe(1);
  });

  test("getOverview zeroes out rather than throwing when every source is denied", async () => {
    const provider = await connectProvider();
    denyEverything();

    const overview = await provider.getOverview();

    expect(overview.version).toBe("unknown");
    expect(overview.startTime).toBeUndefined();
    expect(overview.activeConnections).toBe(0);
    expect(overview.maxConnections).toBe(0);
    expect(overview.databaseSizeBytes).toBe(0);
    expect(overview.tableCount).toBe(0);
    expect(overview.indexCount).toBe(0);
  });

  test("getPerformanceMetrics derives the ratios the server does not publish directly", async () => {
    const provider = await connectProvider();

    const performance = await provider.getPerformanceMetrics();

    expect(performance.cacheHitRatio).toBe(36.36);
    expect(performance.queriesPerSecond).toBe(0.08);
    expect(performance.bufferPoolUsage).toBe(1.53);
  });

  test("getPerformanceMetrics reports zero rather than a flattering score when denied", async () => {
    const provider = await connectProvider();
    denyEverything();

    const performance = await provider.getPerformanceMetrics();

    expect(performance.cacheHitRatio).toBe(0);
    expect(performance.queriesPerSecond).toBe(0);
    expect(performance.bufferPoolUsage).toBe(0);
  });

  test("getSlowQueries aggregates system.query_log by normalized statement", async () => {
    const provider = await connectProvider();

    const slow = await provider.getSlowQueries({ limit: 5 });

    expect(slow).toEqual([
      {
        queryId: "7283842689206104996",
        query: "SELECT count() FROM orders WHERE status = 'paid'",
        calls: 3,
        totalTime: 1179,
        avgTime: 393,
        minTime: 281,
        maxTime: 505,
        rows: 3,
      },
    ]);
    expect(sqlWith("system.query_log")).toContain("LIMIT 5");
  });

  test("getSlowQueries returns empty when query_log is switched off or ungranted", async () => {
    // Both are ordinary deployments: query_log is permission-gated AND absent on
    // some servers, so an empty panel is the honest answer, not a failure.
    const provider = await connectProvider();
    denyEverything();

    expect(await provider.getSlowQueries()).toEqual([]);
  });

  test("getSlowQueries returns empty when the table does not exist at all", async () => {
    const provider = await connectProvider();
    replyFor = () => exceptionReply(UNKNOWN_TABLE, "UNKNOWN_TABLE", "Table system.query_log does not exist", 404);

    expect(await provider.getSlowQueries()).toEqual([]);
  });

  test("a limit that is not a positive whole number falls back to the default", async () => {
    // The row cap is inlined into the statement rather than bound, so it has to
    // be a positive integer before it gets there.
    const provider = await connectProvider();

    await provider.getSlowQueries({ limit: 0 });

    expect(sqlWith("system.query_log")).toContain("LIMIT 10");
  });

  test("getActiveSessions reads system.processes and hides its own read", async () => {
    const provider = await connectProvider();

    const sessions = await provider.getActiveSessions({ limit: 7 });

    expect(sessions[0].pid).toBe("1b39563e-105b-42dd-9a49-7fb7e0618f94");
    expect(sessions[0].user).toBe("libredb");
    expect(sessions[0].database).toBe(DATABASE);
    expect(sessions[0].clientAddr).toBe("::ffff:172.17.0.1");
    expect(sessions[0].state).toBe("active");
    expect(sessions[0].durationMs).toBe(12500);
    expect(sessions[0].duration).toBe("12.50s");
    expect(sessions[1].durationMs).toBe(1);
    expect(sqlWith("system.processes")).toContain("NOT LIKE");
    expect(sqlWith("system.processes")).toContain("LIMIT 7");
  });

  test("getActiveSessions returns empty when the process list is denied", async () => {
    const provider = await connectProvider();
    denyEverything();

    expect(await provider.getActiveSessions()).toEqual([]);
  });

  test("getTableStats groups the active parts by table", async () => {
    const provider = await connectProvider();

    const stats = await provider.getTableStats();

    expect(stats[0]).toEqual({
      schemaName: DATABASE,
      tableName: "orders",
      rowCount: 5,
      tableSize: "621 B",
      tableSizeBytes: 621,
      indexSize: "228 B",
      indexSizeBytes: 228,
      totalSize: "2.55 KB",
      totalSizeBytes: 2613,
    });
    expect(stats).toHaveLength(2);
  });

  test("getTableStats narrows to one database when asked", async () => {
    const provider = await connectProvider();

    await provider.getTableStats({ schema: "demo" });

    expect(sqlWith("system.parts")).toContain("database = 'demo'");
  });

  test("getTableStats excludes the server's own databases when not narrowed", async () => {
    const provider = await connectProvider();

    await provider.getTableStats();

    expect(sqlWith("system.parts")).toContain("database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')");
  });

  test("getTableStats returns empty when system.parts is denied", async () => {
    const provider = await connectProvider();
    denyEverything();

    expect(await provider.getTableStats()).toEqual([]);
  });

  test("getIndexStats lists the data-skipping indexes with no scan counters", async () => {
    // ClickHouse publishes no per-index usage statistics anywhere, so a scan
    // count is reported as zero rather than guessed, and no index is unique.
    const provider = await connectProvider();

    const stats = await provider.getIndexStats();

    expect(stats[0]).toEqual({
      schemaName: DATABASE,
      tableName: "orders",
      indexName: "idx_status",
      indexType: "set",
      columns: ["status"],
      isUnique: false,
      isPrimary: false,
      indexSize: "219 B",
      indexSizeBytes: 219,
      scans: 0,
    });
    // The expression stays one entry: splitting on its commas would invent two
    // columns named `cityHash64(user_id` and `status)`, neither of which exists.
    expect(stats[1].columns).toEqual(["cityHash64(user_id, status)"]);
  });

  test("getIndexStats narrows to one database when asked", async () => {
    const provider = await connectProvider();

    await provider.getIndexStats({ schema: "demo" });

    expect(sqlWith("indexName")).toContain("database = 'demo'");
  });

  test("getIndexStats returns empty when the index catalog is denied", async () => {
    const provider = await connectProvider();
    denyEverything();

    expect(await provider.getIndexStats()).toEqual([]);
  });

  test("getStorageStats reports the disks the server stores parts on", async () => {
    const provider = await connectProvider();

    const storage = await provider.getStorageStats();

    expect(storage).toEqual([
      {
        name: "default",
        location: "/var/lib/clickhouse/",
        size: "273.95 GB",
        sizeBytes: 294147883008,
        usagePercent: 32.48,
      },
    ]);
  });

  test("getStorageStats returns empty when system.disks is denied", async () => {
    const provider = await connectProvider();
    denyEverything();

    expect(await provider.getStorageStats()).toEqual([]);
  });

  test("getHealth composes the degrading sources", async () => {
    const provider = await connectProvider();

    const health = await provider.getHealth();

    expect(health.activeConnections).toBe(1);
    expect(health.databaseSize).toBe("3.87 KB");
    expect(health.cacheHitRatio).toBe("36.4");
    expect(health.slowQueries[0].calls).toBe(3);
    expect(health.slowQueries[0].avgTime).toBe("393ms");
    expect(health.activeSessions[0].pid).toBe("1b39563e-105b-42dd-9a49-7fb7e0618f94");
  });

  test("getMonitoringData survives a user who may read nothing", async () => {
    const provider = await connectProvider();
    denyEverything();

    const data = await provider.getMonitoringData();

    expect(data.slowQueries).toEqual([]);
    expect(data.activeSessions).toEqual([]);
    expect(data.tables).toEqual([]);
    expect(data.indexes).toEqual([]);
    expect(data.storage).toEqual([]);
    expect(data.performance?.cacheHitRatio).toBe(0);
    expect(data.overview?.version).toBe("unknown");
  });

  test("a monitoring failure that is not a denial propagates, so no panel hides a bug", async () => {
    const provider = await connectProvider();
    replyFor = () => exceptionReply(SYNTAX_ERROR, "SYNTAX_ERROR", "Syntax error", 400);

    await expect(provider.getSlowQueries()).rejects.toBeInstanceOf(QueryError);
  });
});

// ============================================================================
// Maintenance
// ============================================================================

describe("ClickHouseProvider maintenance", () => {
  test("optimize merges the parts of one table", async () => {
    const provider = await connectProvider();

    const result = await provider.runMaintenance("optimize", "users");

    expect(result.success).toBe(true);
    expect(result.message).toContain("users");
    expect(sqlWith("OPTIMIZE")).toBe('OPTIMIZE TABLE "demo"."users" FINAL');
  });

  test("optimize keeps a qualified target in its own database", async () => {
    const provider = await connectProvider();

    await provider.runMaintenance("optimize", "default.audit");

    expect(sqlWith("OPTIMIZE")).toBe('OPTIMIZE TABLE "default"."audit" FINAL');
  });

  test("optimize quotes an identifier that carries a quote", async () => {
    const provider = await connectProvider();

    await provider.runMaintenance("optimize", 'we"ird');

    expect(sqlWith("OPTIMIZE")).toBe('OPTIMIZE TABLE "demo"."we""ird" FINAL');
  });

  test("analyze reports the part statistics ClickHouse keeps instead of computing new ones", async () => {
    // There is no ANALYZE: a MergeTree's statistics are its parts, and they are
    // always current. Reporting them is the honest equivalent of the operation.
    const provider = await connectProvider();

    const result = await provider.runMaintenance("analyze", "orders");

    expect(result.success).toBe(true);
    expect(result.message).toBe("orders: 2 active parts, 5 rows, 2.55 KB on disk");
    expect(sqlWith("partCount")).toContain("database = 'demo' AND table = 'orders'");
  });

  test("analyze reports honestly when the table has no parts at all", async () => {
    const provider = await connectProvider();
    replyFor = (sql) =>
      sql.includes("partCount") ? jsonReply([{ partCount: "0", rowCount: "0", totalBytes: "0" }]) : defaultReply(sql);

    const result = await provider.runMaintenance("analyze", "daily_events");

    expect(result.success).toBe(true);
    expect(result.message).toBe("daily_events: no active parts (a view or a non-MergeTree engine keeps none)");
  });

  test("analyze without a target reports the whole pinned database", async () => {
    // MaintenanceModal's global Analyze button sends no target (it is what
    // `analyzeGlobalLabel` labels), and a live run showed it failing with
    // "requires a target" - a control the UI offers that could never work.
    // Reporting the database's parts is well defined and is what the label says.
    const provider = await connectProvider();

    const result = await provider.runMaintenance("analyze");

    expect(result.success).toBe(true);
    expect(result.message).toBe("demo: 2 active parts, 5 rows, 2.55 KB on disk");
    expect(sqlWith("partCount")).toContain("database = 'demo'");
    expect(sqlWith("partCount")).not.toContain("table =");
  });

  test("analyze without a target reports honestly when the database has no parts", async () => {
    const provider = await connectProvider();
    replyFor = (sql) =>
      sql.includes("partCount") ? jsonReply([{ partCount: "0", rowCount: "0", totalBytes: "0" }]) : defaultReply(sql);

    const result = await provider.runMaintenance("analyze");

    expect(result.success).toBe(true);
    expect(result.message).toContain("no active parts");
  });

  test("optimize still requires a target, because OPTIMIZE needs a table", async () => {
    const provider = await connectProvider();

    await expect(provider.runMaintenance("optimize")).rejects.toThrow(/requires a target/);
  });

  test("kill cancels one running query by id", async () => {
    const provider = await connectProvider();

    const result = await provider.runMaintenance("kill", "1b39563e-105b-42dd-9a49-7fb7e0618f94");

    expect(result.success).toBe(true);
    expect(sqlWith("KILL QUERY")).toBe("KILL QUERY WHERE query_id = '1b39563e-105b-42dd-9a49-7fb7e0618f94' SYNC");
  });

  test("kill escapes a target that tries to close the literal", async () => {
    const provider = await connectProvider();

    await provider.runMaintenance("kill", "a' OR 1 = 1 --");

    expect(sqlWith("KILL QUERY")).toBe("KILL QUERY WHERE query_id = 'a'' OR 1 = 1 --' SYNC");
  });

  // A backslash is the other escape character in a ClickHouse literal, and doubling
  // the quote alone would leave `\'` reading as an escaped quote rather than a
  // terminator. Live-verified on 26.7.1: with the doubled backslash,
  // `name = 'back\\slash'` matches a table genuinely named `back\slash`.
  test("escapes a backslash in a target, not only the quote", async () => {
    const provider = await connectProvider();

    await provider.runMaintenance("analyze", "back\\slash");

    expect(sqlWith("partCount")).toContain("table = 'back\\\\slash'");
  });

  test("escapes a target combining a backslash and a quote", async () => {
    const provider = await connectProvider();

    await provider.runMaintenance("kill", "a\\' OR 1 = 1");

    expect(sqlWith("KILL QUERY")).toBe("KILL QUERY WHERE query_id = 'a\\\\'' OR 1 = 1' SYNC");
  });

  test("an operation without a target is refused", async () => {
    const provider = await connectProvider();

    await expect(provider.runMaintenance("optimize")).rejects.toBeInstanceOf(QueryError);
  });

  test("an operation ClickHouse has no equivalent for is refused", async () => {
    const provider = await connectProvider();

    await expect(provider.runMaintenance("vacuum", "users")).rejects.toThrow(/vacuum/);
  });

  test("a denied maintenance statement is mapped like any other failure", async () => {
    // Live-verified: OPTIMIZE and KILL QUERY both answer 500 / code 497 without
    // the grant, so the status alone would read as a server fault.
    const provider = await connectProvider();
    denyEverything();

    await expect(provider.runMaintenance("optimize", "users")).rejects.toBeInstanceOf(AuthenticationError);
  });
});
