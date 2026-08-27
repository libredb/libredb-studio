/**
 * Apache Trino provider, end to end (issue #424, Phase 2)
 *
 * Every payload below was captured on 2026-08-20 from a live Apache Trino 476
 * coordinator (catalogs `tpch`, `tpcds`, `memory`, `system`, `jmx`; the schema
 * tree read against `tpch`, statistics against `tpch.tiny`). `globalThis.fetch` is
 * REPLACED per test and restored afterwards - `mock.module()` is refused, being
 * process-wide in bun and able to poison sibling files - so the real provider, the
 * real introspection and the real HTTP transport all execute here and only the
 * cluster is fake.
 *
 * One declared trimming: a live exchange takes six to eight pages, of which the
 * first four are empty QUEUED shells. The harness replays TWO - a verbatim QUEUED
 * page and the page that carries the answer - because the page loop itself is
 * exhaustively covered in `tests/unit/db/trino/http-transport.test.ts`, and the
 * only page shapes this file needs are the two that differ.
 *
 * Five measured behaviours drive what is asserted:
 *
 * 1. A FAILED STATEMENT IS AN HTTP 200 with the failure inside the document. The
 *    error payload below is verbatim and carries the real `failureInfo` - 19 stack
 *    frames, 3.3 KB - so "the provider does not surface the Java stack" is proved
 *    against the thing it must not surface rather than against an empty object.
 * 2. `state: "FINISHED"` ARRIVES WITH A `nextUri` STILL ATTACHED, on the page that
 *    carries the rows. The probe payload is that page verbatim.
 * 3. `SELECT 1;` IS A SYNTAX ERROR: the trailing semicolon is not in the grammar.
 * 4. `LIMIT n OFFSET m` IS A SYNTAX ERROR; `OFFSET m LIMIT n` returns the rows.
 * 5. `DELETE /v1/query/{id}` ANSWERS 204 for an id that never existed, so a
 *    cancellation is idempotent and its success proves nothing about the target.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
} from "@/lib/db/errors";
import {
  TRINO_ACTIVE_QUERY_COUNT_SQL,
  TRINO_ACTIVE_QUERY_SQL,
  TRINO_CATALOG_LIST_SQL,
  TRINO_JVM_RUNTIME_SQL,
  TRINO_NODE_LIST_SQL,
  TRINO_QUERY_RATE_SQL,
  TRINO_SLOW_QUERY_SQL,
  trinoColumnListSql,
  trinoTableCountSql,
  trinoTableListSql,
  trinoTableStatsSql,
} from "@/lib/db/providers/sql/trino/introspect";
import { TrinoProvider } from "@/lib/db/providers/sql/trino/index";
import type { DatabaseConnection } from "@/lib/types";

const CATALOG = "tpch";
const ORIGIN = "http://trino.test:8080";

function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "trino-1",
    name: "Probe cluster",
    type: "trino",
    host: "trino.test",
    port: 8080,
    user: "libredb",
    database: CATALOG,
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    ...overrides,
  };
}

// ============================================================================
// Wire payloads (captured from Apache Trino 476 over POST /v1/statement)
// ----------------------------------------------------------------------------
// The envelope below is `SELECT 1`'s own answer, verbatim, and `page()` rebuilds
// exactly that shape around a different column declaration and a different row
// set. The declarations and rows themselves are all verbatim captures.
// ============================================================================

interface Column {
  name: string;
  type: string;
}

/**
 * The execution report every page carries, captured from `SELECT 1`'s final page.
 * Trimmed of `rootStage`, which nothing above the seam reads.
 */
const STATS = {
  state: "FINISHED",
  queued: false,
  scheduled: true,
  nodes: 1,
  totalSplits: 1,
  queuedSplits: 1,
  runningSplits: 0,
  completedSplits: 0,
  planningTimeMillis: 2,
  analysisTimeMillis: 0,
  cpuTimeMillis: 0,
  wallTimeMillis: 0,
  queuedTimeMillis: 0,
  elapsedTimeMillis: 9,
  finishingTimeMillis: 1,
  physicalInputTimeMillis: 0,
  processedRows: 0,
  processedBytes: 0,
  physicalInputBytes: 0,
  physicalWrittenBytes: 0,
  internalNetworkInputBytes: 0,
  peakMemoryBytes: 132,
  spilledBytes: 0,
};

/**
 * The QUEUED page a submission answers with, verbatim.
 *
 * Its `stats` differs from the one above - no `scheduled`, no `progressPercentage`
 * - and it is reproduced because the transport reads `state` from whichever page
 * carries one last, so the QUEUED shape has to be real too.
 */
const QUEUED_STATS = { ...STATS, state: "QUEUED", queued: true, scheduled: false, planningTimeMillis: 0 };

/** The answer page: columns, rows, and - measured - a `nextUri` beside FINISHED. */
function page(id: string, columns: Column[], data: unknown[][], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    infoUri: `${ORIGIN}/ui/query.html?${id}`,
    columns,
    data,
    stats: STATS,
    warnings: [],
    ...extra,
  });
}

const PROBE_COLUMNS: Column[] = [{ name: "_col0", type: "integer" }];

const TABLE_LIST_COLUMNS: Column[] = [
  { name: "schemaName", type: "varchar" },
  { name: "tableName", type: "varchar" },
];

/** Trimmed from 72 rows for length; nothing the tree reads is affected. */
const TABLE_LIST_ROWS: unknown[][] = [
  ["sf1", "customer"],
  ["tiny", "nation"],
  ["tiny", "region"],
];

const COLUMN_LIST_COLUMNS: Column[] = [
  { name: "schemaName", type: "varchar" },
  { name: "tableName", type: "varchar" },
  { name: "columnName", type: "varchar" },
  { name: "dataType", type: "varchar" },
  { name: "isNullable", type: "varchar" },
  { name: "columnDefault", type: "varchar" },
];

/** Captured with the schema narrowed to `tiny` for length, then trimmed to two tables. */
const COLUMN_LIST_ROWS: unknown[][] = [
  ["tiny", "nation", "nationkey", "bigint", "NO", null],
  ["tiny", "nation", "name", "varchar(25)", "NO", null],
  ["tiny", "region", "regionkey", "bigint", "NO", null],
  ["tiny", "region", "comment", "varchar(152)", "NO", null],
];

const STATS_COLUMNS: Column[] = [
  { name: "column_name", type: "varchar" },
  { name: "data_size", type: "double" },
  { name: "distinct_values_count", type: "double" },
  { name: "nulls_fraction", type: "double" },
  { name: "row_count", type: "double" },
  { name: "low_value", type: "varchar" },
  { name: "high_value", type: "varchar" },
];

/** `SHOW STATS FOR "tpch"."tiny"."region"`, verbatim: null data_size on the bigint, null column_name on the summary. */
const REGION_STATS_ROWS: unknown[][] = [
  ["regionkey", null, 5.0, 0.0, null, "0", "4"],
  ["name", 34.0, 5.0, 0.0, null, null, null],
  ["comment", 330.0, 5.0, 0.0, null, null, null],
  [null, null, null, null, 5.0, null, null],
];

/** `SHOW STATS FOR "tpch"."tiny"."nation"`, verbatim, trimmed to two column rows. */
const NATION_STATS_ROWS: unknown[][] = [
  ["nationkey", null, 25.0, 0.0, null, "0", "24"],
  ["name", 177.0, 25.0, 0.0, null, null, null],
  [null, null, null, null, 25.0, null, null],
];

/** A connector that publishes no statistics answers the same shape, all null. */
const NO_STATS_ROWS: unknown[][] = [
  ["custkey", null, null, null, null, null, null],
  [null, null, null, null, null, null, null],
];

const CATALOG_LIST_COLUMNS: Column[] = [
  { name: "catalogName", type: "varchar" },
  { name: "connectorName", type: "varchar" },
];

const CATALOG_LIST_ROWS: unknown[][] = [
  ["jmx", "jmx"],
  ["memory", "memory"],
  ["system", "system"],
  ["tpcds", "tpcds"],
  ["tpch", "tpch"],
];

const NODE_LIST_COLUMNS: Column[] = [
  { name: "nodeId", type: "varchar" },
  { name: "nodeVersion", type: "varchar" },
  { name: "isCoordinator", type: "boolean" },
  { name: "nodeState", type: "varchar" },
];

const NODE_LIST_ROWS: unknown[][] = [["ba8be21e377c", "476", true, "active"]];

const JVM_COLUMNS: Column[] = [
  { name: "startedAtMillis", type: "bigint" },
  { name: "uptimeMs", type: "bigint" },
];

const JVM_ROWS: unknown[][] = [[1787180899080, 4284672]];

const RATE_COLUMNS: Column[] = [{ name: "completedPerSecond", type: "double" }];
const RATE_ROWS: unknown[][] = [[0.10457480807630157]];

const SESSION_COLUMNS: Column[] = [
  { name: "queryId", type: "varchar" },
  { name: "state", type: "varchar" },
  { name: "userName", type: "varchar" },
  { name: "source", type: "varchar" },
  { name: "statement", type: "varchar" },
  { name: "createdAt", type: "varchar(32)" },
  { name: "elapsedMs", type: "bigint" },
];

/** The active-session read seeing itself; `source` null because that client sent none. */
const SESSION_ROWS: unknown[][] = [
  [
    "20260820_001943_00041_chvb7",
    "RUNNING",
    "libredb",
    null,
    'SELECT query_id AS "queryId" FROM system.runtime.queries',
    "2026-08-20T00:19:43.765Z",
    0,
  ],
];

const SLOW_COLUMNS: Column[] = [
  { name: "queryId", type: "varchar" },
  { name: "statement", type: "varchar" },
  { name: "elapsedMs", type: "bigint" },
  { name: "queuedMs", type: "bigint" },
];

/** Trimmed from ten rows to two. */
const SLOW_ROWS: unknown[][] = [
  [
    "20260819_231130_00006_chvb7",
    "SELECT nationkey, name, regionkey FROM tpch.sf1.nation ORDER BY nationkey LIMIT 5",
    1543,
    0,
  ],
  ["20260819_231141_00019_chvb7", "SELECT * FROM system.runtime.nodes", 641, 0],
];

/** The demo rows a statement this harness does not recognise answers with. */
const DEMO_COLUMNS: Column[] = [
  { name: "nationkey", type: "bigint" },
  { name: "name", type: "varchar(25)" },
];

const DEMO_ROWS: unknown[][] = [
  [0, "ALGERIA"],
  [1, "ARGENTINA"],
];

/**
 * `SELEKT 1`, verbatim, INCLUDING the failure document's Java stack.
 *
 * The real answer carried 19 frames and 3.3 KB of `failureInfo`; three frames are
 * kept, because the assertion is that NONE of it reaches the user and three prove
 * that as well as nineteen. The `message` is the engine's own, untouched: it is
 * the only text that locates the fault.
 */
const SYNTAX_ERROR = {
  message:
    "line 1:1: mismatched input 'SELEKT'. Expecting: 'ALTER', 'ANALYZE', 'CALL', 'COMMENT', 'COMMIT', 'CREATE', <query>",
  errorCode: 1,
  errorName: "SYNTAX_ERROR",
  errorType: "USER_ERROR",
  errorLocation: { lineNumber: 1, columnNumber: 1 },
  failureInfo: {
    type: "io.trino.spi.TrinoException",
    message: "line 1:1: mismatched input 'SELEKT'.",
    suppressed: [],
    stack: [
      "io.trino.sql.parser.ErrorHandler.syntaxError(ErrorHandler.java:108)",
      "org.antlr.v4.runtime.ProxyErrorListener.syntaxError(ProxyErrorListener.java:41)",
      "org.antlr.v4.runtime.Parser.notifyErrorListeners(Parser.java:544)",
    ],
    errorInfo: { code: 1, name: "SYNTAX_ERROR", type: "USER_ERROR" },
  },
};

/** `SELECT 1 FROM nosuchcat.information_schema.tables`, verbatim minus the stack. */
const CATALOG_NOT_FOUND = {
  message: "line 1:15: Catalog 'nosuchcat' not found",
  errorCode: 44,
  errorName: "CATALOG_NOT_FOUND",
  errorType: "USER_ERROR",
  errorLocation: { lineNumber: 1, columnNumber: 15 },
};

/** `CREATE TABLE tpch.tiny.t (id integer)`, verbatim: the location really is absent. */
const NOT_SUPPORTED = {
  message: "This connector does not support creating tables",
  errorCode: 13,
  errorName: "NOT_SUPPORTED",
  errorType: "USER_ERROR",
};

/** A DELETE against the running statement, verbatim. */
const USER_CANCELED = {
  message: "Query was canceled",
  errorCode: 6,
  errorName: "USER_CANCELED",
  errorType: "USER_ERROR",
};

/**
 * A missing `X-Trino-User`, verbatim: 401 with a PLAIN-TEXT body, not JSON.
 * Anything that JSON.parses an error body throws a second, misleading error here.
 */
const UNAUTHENTICATED_TEXT = "Basic authentication or X-Trino-Original-User or X-Trino-User must be sent";

// ============================================================================
// fetch harness
// ============================================================================

/**
 * A union rather than one shape with two optional members, because the harness
 * answers with EITHER a serialized page OR one of the plain-text refusals that
 * never become documents - and the reader below picks between them. Written as a
 * single optional pair, a reply carrying neither would typecheck and answer an
 * empty body, which is the one thing the real coordinator never does.
 */
type Reply = { status?: number; body: string; text?: undefined } | { status?: number; text: string; body?: undefined };

/** The answer to one statement, as the two pages the harness replays. */
function rows(columns: Column[], data: unknown[][]): (id: string) => Reply {
  return (id) => ({ body: page(id, columns, data) });
}

/** A statement the engine refused: HTTP 200, failure inside the document. */
function refusal(error: Record<string, unknown>): (id: string) => Reply {
  return (id) => ({
    body: JSON.stringify({ id, infoUri: `${ORIGIN}/ui/query.html?${id}`, stats: { ...STATS, state: "FAILED" }, error }),
  });
}

const originalFetch = globalThis.fetch;

let sentSql: string[] = [];
let sentHeaders: Headers[] = [];
let sentMethods: { method: string; url: string }[] = [];
let networkFailure: Error | null = null;
/**
 * The answer waiting for each statement's follow-up, keyed by the id the harness
 * minted for it. A map and not one variable, because the provider legitimately
 * runs several statements CONCURRENTLY - `getOverview` fans out over four - so a
 * single slot is overwritten by the next submission before the first page is
 * fetched, and every panel then reads another surface's rows.
 */
let repliesById: Map<string, (id: string) => Reply>;
let replyFor: (sql: string) => (id: string) => Reply;

/**
 * Which canned answer each read gets, keyed on the exported statement the read
 * actually sends. Keying on the builder rather than on a substring makes a routing
 * miss impossible: a renamed projection cannot silently be served another
 * surface's rows.
 */
const SURFACE_ANSWERS: [statement: string, answer: (id: string) => Reply][] = [
  [trinoTableListSql(CATALOG), rows(TABLE_LIST_COLUMNS, TABLE_LIST_ROWS)],
  [trinoColumnListSql(CATALOG), rows(COLUMN_LIST_COLUMNS, COLUMN_LIST_ROWS)],
  [trinoTableCountSql(CATALOG), rows([{ name: "tableCount", type: "bigint" }], [[72]])],
  [TRINO_CATALOG_LIST_SQL, rows(CATALOG_LIST_COLUMNS, CATALOG_LIST_ROWS)],
  [TRINO_NODE_LIST_SQL, rows(NODE_LIST_COLUMNS, NODE_LIST_ROWS)],
  [TRINO_JVM_RUNTIME_SQL, rows(JVM_COLUMNS, JVM_ROWS)],
  [TRINO_QUERY_RATE_SQL, rows(RATE_COLUMNS, RATE_ROWS)],
  [TRINO_ACTIVE_QUERY_COUNT_SQL, rows([{ name: "activeQueries", type: "bigint" }], [[1]])],
  [TRINO_ACTIVE_QUERY_SQL, rows(SESSION_COLUMNS, SESSION_ROWS)],
  [TRINO_SLOW_QUERY_SQL, rows(SLOW_COLUMNS, SLOW_ROWS)],
  [trinoTableStatsSql(CATALOG, "tiny", "nation"), rows(STATS_COLUMNS, NATION_STATS_ROWS)],
  [trinoTableStatsSql(CATALOG, "tiny", "region"), rows(STATS_COLUMNS, REGION_STATS_ROWS)],
  [trinoTableStatsSql(CATALOG, "sf1", "customer"), rows(STATS_COLUMNS, NO_STATS_ROWS)],
];

function defaultReply(sql: string): (id: string) => Reply {
  if (sql === "SELECT 1") return rows(PROBE_COLUMNS, [[1]]);

  // Longest first, so `SHOW STATS FOR "tpch"."tiny"."nation"` never matches a
  // shorter statement that happens to be its prefix; `startsWith` because the two
  // windowed reads append their own row cap.
  const matches = SURFACE_ANSWERS.filter(([statement]) => sql.startsWith(statement)).sort(
    (left, right) => right[0].length - left[0].length,
  );

  return matches[0]?.[1] ?? rows(DEMO_COLUMNS, DEMO_ROWS);
}

/**
 * Serve every statement mentioning `fragment` differently, and leave every other
 * read alone. A substring and not a prefix, because two of the surfaces this has
 * to reroute are distinguished by their FROM clause rather than by how they open.
 */
function overrideSurface(fragment: string, answer: (id: string) => Reply): void {
  replyFor = (sql) => (sql.includes(fragment) ? answer : defaultReply(sql));
}

/** Every read fails the way a locked-down cluster's ordinary user sees it. */
function denyEverything(): void {
  replyFor = () => () => ({ status: 401, text: UNAUTHENTICATED_TEXT });
}

let nextId = 0;

function installFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (networkFailure) throw networkFailure;
    const url = String(input);
    const method = init?.method ?? "GET";
    sentMethods.push({ method, url });
    sentHeaders.push(new Headers(init?.headers));

    if (method === "DELETE") return new Response(null, { status: 204 });

    if (method === "POST") {
      const sql = String(init?.body);
      sentSql.push(sql);
      nextId += 1;
      const id = `20260820_000000_${String(nextId).padStart(5, "0")}_libre`;
      repliesById.set(id, replyFor(sql));

      return new Response(
        JSON.stringify({
          id,
          infoUri: `${ORIGIN}/ui/query.html?${id}`,
          nextUri: `${ORIGIN}/v1/statement/executing/${id}/token/1`,
          stats: QUEUED_STATS,
          warnings: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // A follow-up. The id travels in the path exactly as the coordinator puts it
    // there, so the answer is looked up rather than guessed.
    const id = url.split("/")[6] as string;
    const answer = repliesById.get(id);
    if (answer === undefined) throw new Error(`no statement was submitted under ${id}`);
    const reply = answer(id);

    return new Response(reply.text ?? reply.body, {
      status: reply.status ?? 200,
      headers: { "content-type": reply.text === undefined ? "application/json" : "text/plain" },
    });
  }) as typeof fetch;
}

function indexOfStatement(match: string): number {
  const index = sentSql.findIndex((statement) => statement.includes(match));
  if (index === -1) throw new Error(`no statement matching "${match}" was sent`);
  return index;
}

/** The statement the provider sent that mentions `match`, or a failure naming it. */
function sqlWith(match: string): string {
  return sentSql[indexOfStatement(match)] as string;
}

function sentAnything(match: string): boolean {
  return sentSql.some((statement) => statement.includes(match));
}

async function connectProvider(overrides: Partial<DatabaseConnection> = {}): Promise<TrinoProvider> {
  const provider = new TrinoProvider(makeConnection(overrides));
  await provider.connect();
  return provider;
}

beforeEach(() => {
  sentSql = [];
  sentHeaders = [];
  sentMethods = [];
  networkFailure = null;
  nextId = 0;
  repliesById = new Map();
  replyFor = defaultReply;
  installFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ============================================================================
// Metadata
// ============================================================================

describe("TrinoProvider metadata", () => {
  // #U9: the only operation Trino has is terminating a statement, and that needs the
  // query id the Sessions panel lists - neither a table nor a whole database. So no
  // maintenance control is offered anywhere, which is what the two `false`s say.
  test("declares its one maintenance operation as neither per-table nor global", () => {
    const caps = new TrinoProvider(makeConnection()).getCapabilities();

    expect(caps.maintenanceOperationSpecs).toEqual({
      kill: { label: "Terminate Query", perEntity: false, global: false },
    });
    expect(Object.keys(caps.maintenanceOperationSpecs ?? {}).sort()).toEqual([...caps.maintenanceOperations].sort());
    // "Reclaim Space" and "Table Statistics" name nothing this engine can run, and
    // both stay unshown because the operations behind them are undeclared - not
    // because the wording is redirected anywhere.
    expect(new TrinoProvider(makeConnection()).getLabels().vacuumActionOperation).toBeUndefined();
    expect(caps.maintenanceOperations).toEqual(["kill"]);
  });
  test("declares SQL on port 8080, with double-quoted identifiers and no statement terminator", () => {
    const capabilities = new TrinoProvider(makeConnection()).getCapabilities();

    expect(capabilities.queryLanguage).toBe("sql");
    expect(capabilities.defaultPort).toBe(8080);
    expect(capabilities.identifierQuoting).toBe("double");
    // Measured: `SELECT 1;` answers "line 1:9: mismatched input ';'".
    expect(capabilities.statementTerminator).toBe("none");
  });

  test("declares no foreign keys and no inline row edit, because it declares no keys at all", () => {
    const capabilities = new TrinoProvider(makeConnection()).getCapabilities();

    expect(capabilities.declaresForeignKeys).toBe(false);
    expect(capabilities.supportsInlineRowEdit).toBe(false);
    // Trino has START TRANSACTION, but a transaction lives in an HTTP session header
    // this provider does not carry between statements, so the trio is withheld (#464).
    expect(capabilities.supportsTransactions).toBe(false);
    // These rows are real tables, not groupings this server derived.
    expect(capabilities.tablesAreDerivedGroupings).toBeUndefined();
  });

  test("offers exactly one maintenance operation, and it is one the engine itself performs", () => {
    const capabilities = new TrinoProvider(makeConnection()).getCapabilities();

    expect(capabilities.supportsMaintenance).toBe(true);
    expect(capabilities.maintenanceOperations).toEqual(["kill"]);
  });

  test("explains through the JSON form, and offers no connection string", () => {
    const capabilities = new TrinoProvider(makeConnection()).getCapabilities();

    // The format is the plan-only one. Measured on 476, that distinction is the whole
    // decision: `EXPLAIN (FORMAT JSON) INSERT INTO memory.default.probe VALUES (42)`
    // left the table at 0 rows, while `EXPLAIN ANALYZE INSERT …` took it to 1 - and
    // the background estimate runs on every SELECT a user executes.
    expect(capabilities.supportsExplain).toBe(true);
    expect(capabilities.explainFormat).toBe("trino-json");
    // `jdbc:trino://host:port/catalog/schema` is a JDBC URL, not a URI the shared
    // parser reads, and `http(s)://` is already ClickHouse's.
    expect(capabilities.supportsConnectionString).toBe(false);
  });

  test("refreshes the tree on DDL and not on an insert", () => {
    const pattern = new RegExp(new TrinoProvider(makeConnection()).getCapabilities().schemaRefreshPattern, "i");

    expect(pattern.test("CREATE TABLE memory.default.t (id integer)")).toBe(true);
    expect(pattern.test("DROP TABLE memory.default.t")).toBe(true);
    expect(pattern.test("INSERT INTO memory.default.t VALUES (1)")).toBe(false);
  });

  test("keeps the inherited table and row nouns, and rewrites only the maintenance copy", () => {
    const labels = new TrinoProvider(makeConnection()).getLabels();

    expect(labels.entityName).toBe("Table");
    expect(labels.rowNamePlural).toBe("rows");
    expect(labels.analyzeGlobalDesc).toContain("connector");
    expect(labels.vacuumGlobalDesc).toContain("query engine");
  });

  // Until #U12 the monitoring Queries panel told a Trino operator to install a
  // PostgreSQL extension. `getSlowQueries()` reads system.runtime.queries, which is the
  // coordinator's own bounded history rather than a persisted store.
  test("names system.runtime.queries, not a Postgres extension, as where query stats come from", () => {
    const { slowQueriesEmptyState } = new TrinoProvider(makeConnection()).getLabels();

    expect(slowQueriesEmptyState).toContain("system.runtime.queries");
    expect(slowQueriesEmptyState).not.toContain("pg_stat_statements");
  });
});

// ============================================================================
// Validation and lifecycle
// ============================================================================

describe("TrinoProvider validation", () => {
  test("requires a host", () => {
    expect(() => new TrinoProvider(makeConnection({ host: undefined }))).toThrow(DatabaseConfigError);
  });

  test("does not require a catalog, because a fully qualified statement needs none", () => {
    expect(() => new TrinoProvider(makeConnection({ database: undefined }))).not.toThrow();
  });
});

describe("TrinoProvider lifecycle", () => {
  test("probes the cluster with the cheapest statement there is", async () => {
    const provider = await connectProvider();

    expect(sentSql[0]).toBe("SELECT 1");
    expect(provider.isConnected()).toBe(true);
  });

  test("names itself to the coordinator, so its statements are attributable", async () => {
    await connectProvider();

    expect(sentHeaders[0]?.get("X-Trino-User")).toBe("libredb");
    expect(sentHeaders[0]?.get("X-Trino-Source")).toBe("libredb-studio");
    expect(sentHeaders[0]?.get("X-Trino-Catalog")).toBe(CATALOG);
  });

  test("reports an unreachable coordinator as a connection failure", async () => {
    networkFailure = new TypeError("fetch failed");
    const provider = new TrinoProvider(makeConnection());

    await expect(provider.connect()).rejects.toBeInstanceOf(ConnectionError);
  });

  test("reports a refused credential as an authentication failure, not a connectivity one", async () => {
    denyEverything();
    const provider = new TrinoProvider(makeConnection());

    await expect(provider.connect()).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("refuses a password over plain HTTP, which the coordinator rejects even with auth disabled", async () => {
    const provider = new TrinoProvider(makeConnection({ password: "secret" }));

    await expect(provider.connect()).rejects.toThrow("plain HTTP");
    expect(sentSql).toEqual([]);
  });

  test("sends the credential once TLS is on", async () => {
    await connectProvider({ password: "secret", ssl: { mode: "require" } });

    expect(sentHeaders[0]?.get("authorization")).toBe(`Basic ${Buffer.from("libredb:secret").toString("base64")}`);
    expect(sentMethods[0]?.url.startsWith("https://")).toBe(true);
  });

  test("refuses every read before connect, and again after disconnect", async () => {
    const provider = new TrinoProvider(makeConnection());
    await expect(provider.query("SELECT 1")).rejects.toBeInstanceOf(DatabaseConfigError);

    await provider.connect();
    await provider.disconnect();

    expect(provider.isConnected()).toBe(false);
    await expect(provider.getSchema()).rejects.toBeInstanceOf(DatabaseConfigError);
  });
});

// ============================================================================
// Query
// ============================================================================

describe("TrinoProvider query", () => {
  test("returns the rows, the declared fields and the coordinator's own elapsed time", async () => {
    const provider = await connectProvider();
    const result = await provider.query("SELECT nationkey, name FROM tpch.tiny.nation");

    expect(result.rows).toEqual([
      { nationkey: 0, name: "ALGERIA" },
      { nationkey: 1, name: "ARGENTINA" },
    ]);
    expect(result.fields).toEqual(["nationkey", "name"]);
    expect(result.rowCount).toBe(2);
    // 9, from the payload's `elapsedTimeMillis` - not a clock read in this process.
    expect(result.executionTime).toBe(9);
  });

  test("labels each column with the type the engine rendered", async () => {
    const provider = await connectProvider();
    const result = await provider.query("SELECT nationkey, name FROM tpch.tiny.nation");

    expect(result.columnTypes).toEqual({ nationkey: "bigint", name: "varchar(25)" });
  });

  test("follows the link even on a page that already says FINISHED", async () => {
    const provider = await connectProvider();
    await provider.query("SELECT nationkey, name FROM tpch.tiny.nation");

    // Two requests per statement: the submission and the one page it links to.
    const forThisStatement = sentMethods.slice(2);
    expect(forThisStatement.map((call) => call.method)).toEqual(["POST", "GET"]);
  });

  test("keeps both columns when the engine declares the same output name twice", async () => {
    const provider = await connectProvider();
    overrideSurface(
      "SELECT 1 AS c",
      rows(
        [
          { name: "c", type: "integer" },
          { name: "c", type: "integer" },
        ],
        [[1, 2]],
      ),
    );
    const result = await provider.query("SELECT 1 AS c, 2 AS c");

    expect(result.fields).toEqual(["c", "c (2)"]);
    expect(result.rows).toEqual([{ c: 1, "c (2)": 2 }]);
  });

  /**
   * The one value the transport rewrites, proved through the PROVIDER rather than
   * through the seam alone, because this is the layer a caller actually reads.
   *
   * The page is verbatim TEXT and not a `page()` call, and that is the whole point:
   * `JSON.stringify` would round both endpoints while building the fixture, so a
   * test written the ordinary way here would pass while proving nothing at all.
   *
   * Captured 2026-08-22 from `memory.fix.t`, written through this provider and read
   * back. Before the rewrite the max returned 9223372036854776000, so a row the
   * database held correctly reached the caller wrong, with nothing to catch.
   */
  test("hands a 64-bit id back exactly as the database holds it", async () => {
    const provider = await connectProvider();
    overrideSurface("memory.fix.t", (id) => ({
      body:
        `{"id":"${id}","infoUri":"${ORIGIN}/ui/query.html?${id}",` +
        '"columns":[{"name":"id","type":"bigint"},{"name":"note","type":"varchar"}],' +
        '"data":[[9223372036854775807,"max"],[-9223372036854775808,"min"],[42,"safe"]],' +
        `"stats":${JSON.stringify(STATS)},"warnings":[]}`,
    }));
    const result = await provider.query("SELECT id, note FROM memory.fix.t ORDER BY note");

    expect(result.rows).toEqual([
      { id: "9223372036854775807", note: "max" },
      { id: "-9223372036854775808", note: "min" },
      // A double holds 42 exactly, so nothing touches it: the rewrite is keyed on
      // the digits, not on the column's declared type.
      { id: 42, note: "safe" },
    ]);
    expect(result.columnTypes).toEqual({ id: "bigint", note: "varchar" });
  });

  /**
   * D5, proved through the PROVIDER because that is the surface it is reachable
   * from: nothing typed in the editor carries a terminator to a provider
   * (`splitStatements()` eats it), so the caller who hits this is a library consumer
   * calling `query()` with the statement they wrote. Measured on 476, `SELECT 1;` is
   * `SYNTAX_ERROR, line 1:9: mismatched input ';'` - the one engine here that
   * refuses what every other one accepts.
   */
  test("runs a statement a library caller terminated with a semicolon", async () => {
    const provider = await connectProvider();
    const result = await provider.query("SELECT nationkey, name FROM tpch.tiny.nation;\n");

    expect(sqlWith("nationkey")).toBe("SELECT nationkey, name FROM tpch.tiny.nation");
    expect(result.rowCount).toBe(2);
    // Not just this statement: no request in the exchange carried a terminator.
    expect(sentAnything(";")).toBe(false);
  });

  test("counts the rows a statement changed when it returned none", async () => {
    const provider = await connectProvider();
    overrideSurface("INSERT", (id) => ({
      body: page(id, [], [], { updateType: "INSERT", updateCount: 3 }),
    }));
    const result = await provider.query("INSERT INTO memory.default.t VALUES (1),(2),(3)");

    expect(result.rowCount).toBe(3);
    expect(result.fields).toEqual([]);
  });

  test("warns that a session statement cannot outlive its own request", async () => {
    const provider = await connectProvider();
    overrideSurface("SET SESSION", (id) => ({ body: page(id, [], [], { updateType: "SET SESSION" }) }));
    const result = await provider.query("SET SESSION query_max_run_time = '10m'");

    expect(result.warnings?.[0]?.message).toContain("will not affect the next one");
  });

  test("carries the engine's own remarks through", async () => {
    const provider = await connectProvider();
    overrideSurface("SELECT * FROM (SELECT 1 ORDER BY 1)", (id) => ({
      body: page(id, DEMO_COLUMNS, DEMO_ROWS, {
        warnings: [
          {
            warningCode: { code: 3, name: "REDUNDANT_ORDER_BY" },
            message: "ORDER BY in subquery may have no effect",
          },
        ],
      }),
    }));
    const result = await provider.query("SELECT * FROM (SELECT 1 ORDER BY 1)");

    expect(result.warnings).toEqual([{ message: "ORDER BY in subquery may have no effect" }]);
  });

  test("attaches no warnings field at all when the engine reported none", async () => {
    const provider = await connectProvider();
    const result = await provider.query("SELECT nationkey, name FROM tpch.tiny.nation");

    expect(result.warnings).toBeUndefined();
  });

  test("refuses positional parameters rather than sending a statement with them unbound", async () => {
    const provider = await connectProvider();

    await expect(provider.query("SELECT * FROM t WHERE id = ?", [1])).rejects.toThrow("PREPARE/EXECUTE");
    expect(sentAnything("WHERE id")).toBe(false);
  });

  test("accepts an empty parameter list, which is what a statement with no values sends", async () => {
    const provider = await connectProvider();

    await expect(provider.query("SELECT nationkey, name FROM tpch.tiny.nation", [])).resolves.toBeDefined();
  });
});

// ============================================================================
// Cancellation
// ============================================================================

describe("TrinoProvider cancellation", () => {
  test("terminates the statement it started, named by the client's own token", async () => {
    const provider = await connectProvider();
    // Seeded with the failing answer rather than with null: the assignment happens
    // inside the harness callback, so a seed of null would both narrow to null here
    // and let a callback that never ran pass unnoticed.
    let cancelled: Promise<boolean> = Promise.resolve(false);

    overrideSurface("SELECT nationkey", (id) => {
      cancelled = provider.cancelQuery("client-token");
      return { body: page(id, DEMO_COLUMNS, DEMO_ROWS) };
    });
    await provider.query("SELECT nationkey, name FROM tpch.tiny.nation", undefined, "client-token");

    expect(await cancelled).toBe(true);
    const deletes = sentMethods.filter((call) => call.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.url).toContain("/v1/query/20260820_000000_00002_libre");
  });

  test("answers false for a token it never recorded, rather than cancelling something else", async () => {
    const provider = await connectProvider();

    expect(await provider.cancelQuery("never-seen")).toBe(false);
    expect(sentMethods.some((call) => call.method === "DELETE")).toBe(false);
  });

  test("forgets the token once the statement has answered, so a late cancel is a no-op", async () => {
    const provider = await connectProvider();
    await provider.query("SELECT nationkey, name FROM tpch.tiny.nation", undefined, "client-token");

    expect(await provider.cancelQuery("client-token")).toBe(false);
  });

  test("records nothing when the caller brought no token", async () => {
    const provider = await connectProvider();
    await provider.query("SELECT nationkey, name FROM tpch.tiny.nation");

    expect(await provider.cancelQuery("client-token")).toBe(false);
  });

  test("reports a statement the cluster cancelled as a cancellation", async () => {
    const provider = await connectProvider();
    overrideSurface("SELECT nationkey", refusal(USER_CANCELED));

    await expect(provider.query("SELECT nationkey, name FROM tpch.tiny.nation")).rejects.toBeInstanceOf(
      QueryCancelledError,
    );
  });
});

// ============================================================================
// Error mapping
// ============================================================================

/**
 * The error a statement rejected with.
 *
 * Resolving the promise is itself a failure: these cases exist because the
 * coordinator answers a refusal with HTTP 200, so a provider that read the status
 * would return a perfectly ordinary result here and a `.catch()` alone would never
 * run to notice.
 */
async function refusalOf(statement: Promise<unknown>): Promise<Error> {
  return statement.then(
    () => {
      throw new Error("the statement resolved, but the coordinator refused it");
    },
    (error: Error) => error,
  );
}

describe("TrinoProvider error mapping", () => {
  test("surfaces the engine's own wording for a refused statement, and never its Java stack", async () => {
    const provider = await connectProvider();
    overrideSurface("SELEKT", refusal(SYNTAX_ERROR));

    const failure = await refusalOf(provider.query("SELEKT 1"));

    expect(failure).toBeInstanceOf(QueryError);
    expect(failure.message).toContain("line 1:1: mismatched input 'SELEKT'");
    expect(failure.message).not.toContain("io.trino");
    expect(failure.message).not.toContain("antlr");
    expect(failure.message).not.toContain("TrinoException");
  });

  test("treats a refused statement as a query error even though the status was 200", async () => {
    const provider = await connectProvider();
    overrideSurface("CREATE TABLE", refusal(NOT_SUPPORTED));

    const failure = await refusalOf(provider.query("CREATE TABLE tpch.tiny.t (id integer)"));

    expect(failure).toBeInstanceOf(QueryError);
    expect(failure.message).toBe("This connector does not support creating tables");
  });

  test("reports a plain-text refusal as authentication without parsing it as JSON", async () => {
    const provider = await connectProvider();
    overrideSurface("SELECT nationkey", () => ({ status: 401, text: UNAUTHENTICATED_TEXT }));

    const failure = await refusalOf(provider.query("SELECT nationkey, name FROM tpch.tiny.nation"));

    expect(failure).toBeInstanceOf(AuthenticationError);
    expect(failure.message).toContain("X-Trino-User must be sent");
  });

  test("reports a coordinator that vanished mid-statement as a connection failure", async () => {
    const provider = await connectProvider();
    overrideSurface("SELECT nationkey", () => ({ status: 404, text: "Error 404 Not Found" }));

    await expect(provider.query("SELECT nationkey, name FROM tpch.tiny.nation")).rejects.toBeInstanceOf(
      ConnectionError,
    );
  });
});

// ============================================================================
// Query preparation
// ============================================================================

describe("TrinoProvider query preparation", () => {
  test("appends a bound to an unbounded SELECT", () => {
    const provider = new TrinoProvider(makeConnection());

    expect(provider.prepareQuery("SELECT * FROM tpch.tiny.nation", { limit: 50 }).query).toBe(
      "SELECT * FROM tpch.tiny.nation LIMIT 50",
    );
  });

  test("puts OFFSET before LIMIT, which is the only order Trino's grammar has", () => {
    const provider = new TrinoProvider(makeConnection());
    const prepared = provider.prepareQuery("SELECT * FROM tpch.tiny.nation", { limit: 50, offset: 100 });

    expect(prepared.query).toBe("SELECT * FROM tpch.tiny.nation OFFSET 100 LIMIT 50");
    expect(prepared.wasLimited).toBe(true);
  });

  test("transposes the bound it appended and not an identical pair inside the statement", () => {
    const provider = new TrinoProvider(makeConnection());
    const prepared = provider.prepareQuery("SELECT * FROM (SELECT 1) t /* LIMIT 50 OFFSET 100 */", {
      limit: 50,
      offset: 100,
    });

    expect(prepared.query).toBe("SELECT * FROM (SELECT 1) t OFFSET 100 LIMIT 50 /* LIMIT 50 OFFSET 100 */");
  });

  test("leaves a statement the limiter did not touch exactly as the user wrote it", () => {
    const provider = new TrinoProvider(makeConnection());

    expect(provider.prepareQuery("SHOW CATALOGS", { limit: 50, offset: 100 }).query).toBe("SHOW CATALOGS");
  });

  test("leaves a statement that already carries its own bound alone", () => {
    const provider = new TrinoProvider(makeConnection());
    const prepared = provider.prepareQuery("SELECT * FROM tpch.tiny.nation OFFSET 1 LIMIT 3", { limit: 50 });

    expect(prepared.wasLimited).toBe(false);
    expect(prepared.query).toBe("SELECT * FROM tpch.tiny.nation OFFSET 1 LIMIT 3");
  });
});

// ============================================================================
// Schema
// ============================================================================

describe("TrinoProvider schema", () => {
  test("lists every table of the pinned catalog, schema-qualified", async () => {
    const provider = await connectProvider();
    const schema = await provider.getSchema();

    expect(schema.map((table) => table.name)).toEqual(["sf1.customer", "tiny.nation", "tiny.region"]);
  });

  test("reads only the pinned catalog, and never fans out across the others", async () => {
    const provider = await connectProvider();
    await provider.getSchema();

    expect(sqlWith("information_schema.tables")).toContain('"tpch".information_schema.tables');
    expect(sentAnything("jmx.information_schema")).toBe(false);
    expect(sentAnything("tpcds.information_schema")).toBe(false);
  });

  test("carries the engine's rendered column types", async () => {
    const provider = await connectProvider();
    const schema = await provider.getSchema();

    expect(schema[1]?.columns).toEqual([
      { name: "nationkey", type: "bigint", nullable: false, isPrimary: false },
      { name: "name", type: "varchar(25)", nullable: false, isPrimary: false },
    ]);
  });

  test("refuses to guess a catalog when the connection pins none", async () => {
    const provider = await connectProvider({ database: undefined });

    await expect(provider.getSchema()).rejects.toThrow("pins no Trino catalog");
  });

  test("surfaces a pinned catalog that does not exist rather than showing an empty tree", async () => {
    const provider = await connectProvider();
    overrideSurface("SELECT table_schema", refusal(CATALOG_NOT_FOUND));

    await expect(provider.getSchema()).rejects.toThrow("Catalog 'nosuchcat' not found");
  });
});

// ============================================================================
// Monitoring
// ============================================================================

describe("TrinoProvider monitoring", () => {
  test("reports the coordinator's version, uptime and the tables of the pinned catalog", async () => {
    const provider = await connectProvider();
    const overview = await provider.getOverview();

    expect(overview.version).toBe("476");
    expect(overview.startTime).toEqual(new Date(1787180899080));
    expect(overview.tableCount).toBe(72);
    expect(overview.activeConnections).toBe(1);
  });

  test("declines to report a database size, because Trino stores nothing", async () => {
    const provider = await connectProvider();
    const overview = await provider.getOverview();

    expect(overview.databaseSize).toBe("N/A");
    expect(overview.indexCount).toBe(0);
  });

  test("states no size in bytes at all, rather than a zero that reads as a measurement", async () => {
    const provider = await connectProvider();
    const overview = await provider.getOverview();

    // The KEY IS ABSENT, not undefined-valued and not zero. `databaseSizeBytes` is
    // optional exactly so a provider with no byte figure to publish can omit it, and
    // Trino has none: the bytes live in the systems its connectors reach, and
    // `SHOW STATS` is a per-table logical estimate covering variable-width columns
    // only. `toBeUndefined()` alone would pass for a `databaseSizeBytes: undefined`
    // that still ships the key, so `in` is what pins the absence (docs/BACKLOG.md D44).
    expect("databaseSizeBytes" in overview).toBe(false);
    expect(overview.databaseSizeBytes).toBeUndefined();
    // The string keeps saying the figure is unavailable; only the number is gone.
    expect(overview.databaseSize).toBe("N/A");
  });

  test("reports the cluster's own completed-query rate and invents no other metric", async () => {
    const provider = await connectProvider();

    expect(await provider.getPerformanceMetrics()).toEqual({ queriesPerSecond: 0.1 });
  });

  test("survives a cluster with no jmx catalog, losing only the readings jmx owns", async () => {
    const provider = await connectProvider();
    overrideSurface("FROM jmx.current", refusal(CATALOG_NOT_FOUND));

    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect((await provider.getOverview()).uptime).toBe("unknown");
  });

  test("lists the statements in flight, with no catalog claimed for any of them", async () => {
    const provider = await connectProvider();
    const sessions = await provider.getActiveSessions({ limit: 5 });

    expect(sessions[0]?.pid).toBe("20260820_001943_00041_chvb7");
    expect(sessions[0]?.state).toBe("RUNNING");
    expect(sessions[0]?.database).toBe("");
    expect(sqlWith("system.runtime.queries").endsWith(" LIMIT 5")).toBe(true);
  });

  test("reports each remembered execution once, never aggregated across executions", async () => {
    const provider = await connectProvider();
    const slow = await provider.getSlowQueries({ limit: 2 });

    expect(slow[0]?.calls).toBe(1);
    expect(slow[0]?.totalTime).toBe(1543);
    expect(slow[0]?.avgTime).toBe(1543);
  });

  test("reads SHOW STATS per table, and drops the table whose connector published none", async () => {
    const provider = await connectProvider();
    const stats = await provider.getTableStats();

    expect(stats.map((table) => `${table.schemaName}.${table.tableName}`)).toEqual(["tiny.nation", "tiny.region"]);
    expect(stats[1]?.rowCount).toBe(5);
    // 34 + 330; the bigint column reports no data_size at all.
    expect(stats[1]?.tableSizeBytes).toBe(364);
    expect(stats[1]?.indexSizeBytes).toBeUndefined();
  });

  test("narrows the stats pass to one schema when asked", async () => {
    const provider = await connectProvider();
    // `sf1.customer` is the fixture's one table whose connector published no row count,
    // so narrowing to that schema examines a table and gets nothing back - a refusal
    // (D24), not an empty schema. The assertion here is about WHICH statements went out.
    await expect(provider.getTableStats({ schema: "sf1" })).rejects.toThrow(/None of the 1 tables examined/);

    expect(sentAnything('SHOW STATS FOR "tpch"."tiny"')).toBe(false);
    expect(sentAnything('SHOW STATS FOR "tpch"."sf1"."customer"')).toBe(true);
  });

  /*
    #515: the pass used to describe the first 25 tables of a bigger catalog and hand those
    rows back as the reading. Nothing in `TableStats[]` or in `MonitoringData.tables`
    could say more had been dropped, so the panel's count and the agent's `rowCount` both
    read 25 for a catalog of any size. The provider now refuses the oversized scope, which
    is why these two tests assert the same sentence in the two shapes it travels in: a
    thrown `QueryError` for a direct caller, and `errors.tables` beside an absent panel for
    the dashboard.

    Live-verified 2026-08-27 against Trino 476 through this provider's own transport: the
    real `tpch` holds 72 user tables and refuses, while `getTableStats({ schema: "tiny" })`
    answers all 8 of them (lineitem 60175, nation 25) - a reading the catalog-wide pass
    could never return, `tiny` sorting last behind 64 tables it never reached.
  */
  // The 72 in the shape it really has: the tpch connector publishes these nine schemas of
  // the same eight tables, which is both where the number comes from and why the refusal
  // can tell this caller that narrowing WILL work - every one of the nine is inside the
  // bound. A catalog whose schemas are all oversized is told the opposite, in the unit
  // tests, because there is no fixture shape that makes both sentences true at once.
  const SEVENTY_TWO = ["tiny", "sf1", "sf100", "sf300", "sf1000", "sf3000", "sf10000", "sf30000", "sf100000"].flatMap(
    (schema) =>
      ["customer", "lineitem", "nation", "orders", "part", "partsupp", "region", "supplier"].map((table) => [
        schema,
        table,
      ]),
  );

  test("a catalog bigger than one stats pass is refused with the number of tables it holds", async () => {
    const provider = await connectProvider();
    overrideSurface(trinoTableListSql(CATALOG), rows(TABLE_LIST_COLUMNS, SEVENTY_TWO));
    sentSql = [];

    await expect(provider.getTableStats()).rejects.toThrow(/Catalog "tpch" holds 72 tables/);
    // Not one statement per table up to the bound either: the refusal is cheaper than the
    // truncation it replaces, because the table list already answered the whole question.
    expect(sentAnything("SHOW STATS FOR")).toBe(false);
  });

  test("the oversized table panel is ABSENT in the dashboard, carrying the size sentence", async () => {
    const provider = await connectProvider();
    overrideSurface(trinoTableListSql(CATALOG), rows(TABLE_LIST_COLUMNS, SEVENTY_TWO));
    const data = await provider.getMonitoringData({ includeIndexes: false, includeStorage: false });

    expect(data.tables).toBeUndefined();
    expect(data.errors?.tables).toContain('Catalog "tpch" holds 72 tables');
    // The advice reaches the dashboard intact, and it is the advice that is TRUE of this
    // catalog: nine schemas, every one of them describable on its own.
    expect(data.errors?.tables).toContain("which holds for 9 of the schemas this catalog's tables are in");
    expect(data.overview).toBeDefined();
  });

  test("the refused table panel is ABSENT with its sentence while the rest of the dashboard answers", async () => {
    // The whole point of the conversion: one panel that cannot be answered costs that
    // panel and carries its reason, instead of rendering as a table of no rows.
    const provider = await connectProvider();
    const data = await provider.getMonitoringData({
      schemaFilter: "sf1",
      includeIndexes: false,
      includeStorage: false,
    });

    expect(data.tables).toBeUndefined();
    expect(data.errors?.tables).toContain("None of the 1 tables examined");
    expect(data.overview).toBeDefined();
  });

  test("describes the catalogs as the storage, because that is where the data is", async () => {
    const provider = await connectProvider();
    const storage = await provider.getStorageStats();

    expect(storage.map((row) => row.name)).toEqual(["jmx", "memory", "system", "tpcds", "tpch"]);
    expect(storage[4]).toEqual({ name: "tpch", location: "tpch", size: "N/A", sizeBytes: 0 });
  });

  test("reports no indexes, and asks the cluster nothing to find that out", async () => {
    const provider = await connectProvider();
    sentSql = [];

    expect(await provider.getIndexStats()).toEqual([]);
    expect(sentSql).toEqual([]);
  });

  test("composes a health summary from the reads that have a source", async () => {
    const provider = await connectProvider();
    const health = await provider.getHealth();

    expect(health.activeConnections).toBe(1);
    expect(health.cacheHitRatio).toBe("N/A");
    expect(health.slowQueries).toHaveLength(2);
    expect(health.activeSessions[0]?.user).toBe("libredb");
  });
});

// ============================================================================
// Maintenance
// ============================================================================

describe("TrinoProvider maintenance", () => {
  test("kills the statement whose id it was given", async () => {
    const provider = await connectProvider();
    overrideSurface("CALL system.runtime.kill_query", (id) => ({
      body: page(id, [], [], { updateType: "CALL" }),
    }));
    const result = await provider.runMaintenance("kill", "20260820_001943_00041_chvb7");

    expect(result.success).toBe(true);
    expect(sqlWith("kill_query")).toBe(
      "CALL system.runtime.kill_query(query_id => '20260820_001943_00041_chvb7', " +
        "message => 'Terminated from LibreDB Studio')",
    );
  });

  test("says it only asked, because the target's own exchange is what observes the kill", async () => {
    const provider = await connectProvider();
    overrideSurface("CALL system.runtime.kill_query", (id) => ({ body: page(id, [], [], { updateType: "CALL" }) }));
    const result = await provider.runMaintenance("kill", "20260820_001943_00041_chvb7");

    expect(result.message).toContain("Asked Trino to terminate");
  });

  test("refuses a kill with no target rather than guessing one", async () => {
    const provider = await connectProvider();

    await expect(provider.runMaintenance("kill")).rejects.toThrow("needs its query id");
    expect(sentAnything("kill_query")).toBe(false);
  });

  test("surfaces the engine's refusal for an id that is no longer running", async () => {
    const provider = await connectProvider();
    overrideSurface(
      "CALL system.runtime.kill_query",
      refusal({
        message: "Target query not found: nosuch",
        errorCode: 5,
        errorName: "NOT_FOUND",
        errorType: "USER_ERROR",
      }),
    );

    await expect(provider.runMaintenance("kill", "nosuch")).rejects.toThrow("Target query not found");
  });

  test("refuses every other operation with the reason, and sends nothing", async () => {
    const provider = await connectProvider();

    await expect(provider.runMaintenance("vacuum")).rejects.toThrow("owns no storage");
    await expect(provider.runMaintenance("analyze")).rejects.toThrow("computes no statistics of its own");
    expect(sentSql).toEqual(["SELECT 1"]);
  });
});
