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
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
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
import {
  TRINO_MATERIALIZED_VIEW_KIND,
  trinoBulkColumnsSql,
  trinoFunctionListSql,
  trinoObjectTargetSql,
  trinoMaterializedViewListSql,
  trinoObjectColumnsSql,
  trinoObjectCountsSql,
  trinoRelationListSql,
  trinoSchemaListSql,
} from "@/lib/db/providers/sql/trino/objects";
import { TrinoProvider } from "@/lib/db/providers/sql/trino/index";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
import { comparePaths } from "@/lib/db/object-path";

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

/**
 * Serve ONE exact statement differently and leave every other read on whatever was routing
 * before, so two overrides compose instead of the second erasing the first.
 *
 * Exact and not a substring, unlike `overrideSurface`: the object surface (#789) sends
 * several statements that differ only in a `WHERE` clause inserted mid-statement, so a
 * fragment match would hand a schema-level read the catalog-level answer and the test would
 * still pass.
 */
function serveInstead(statement: string, answer: (id: string) => Reply): void {
  const previous = replyFor;
  replyFor = (sql) => (sql === statement ? answer : previous(sql));
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
  test.each(["SELECT * FROM widgets", "CREATE TABLE t (id INTEGER NOT NULL)"])(
    "sends the pinned schema for %s",
    async (sql) => {
      const provider = await connectProvider({ database: "memory", schema: "default" });
      await provider.query(sql);
      const submissions = sentHeaders.filter((_, index) => sentMethods[index]?.method === "POST");
      expect(submissions.length).toBeGreaterThan(1);
      for (const headers of submissions) {
        expect(headers.get("X-Trino-Catalog")).toBe("memory");
        expect(headers.get("X-Trino-Schema")).toBe("default");
      }
    },
  );

  test.each([undefined, ""])("omits the schema header when the connection schema is %s", async (schema) => {
    const provider = await connectProvider({ schema });
    await provider.query("SELECT 1");
    expect(sentHeaders.every((headers) => !headers.has("X-Trino-Schema"))).toBe(true);
  });

  test("probes the cluster with the cheapest statement there is", async () => {
    const provider = await connectProvider();

    expect(sentSql[0]).toBe("SELECT 1");
    expect(provider.isConnected()).toBe(true);
  });

  test("disconnect closes the transport and forgets what was running", async () => {
    // The tail of a successful connect and the whole of `disconnect()`: the provider is
    // connected after `connect()` resolves, and afterwards it holds no transport, reports
    // itself disconnected, and has dropped every query id it was tracking for cancellation.
    const provider = await connectProvider();
    expect(provider.isConnected()).toBe(true);

    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);

    // Idempotent: a second disconnect on a provider holding no transport is a no-op rather
    // than a throw, which is what the pool's teardown path relies on.
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
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
    expect(result.warnings?.[0]?.message).toContain("Set Catalog Name and Schema Name");
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

describe("TrinoProvider schema", () => {});

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

// ============================================================================
// The object surface (#789)
// ----------------------------------------------------------------------------
// Every payload below was captured on 2026-09-11 from a live Trino 476 carrying the
// `memory` and `tpch` catalogs `database-compose.yml` configures plus an `iceberg` catalog
// on an Apache Hive 4.0.1 standalone metastore, which is the only catalog type this release
// creates a materialized view on: the Iceberg JDBC and REST catalogs both answer
// `createMaterializedView is not supported`.
//
// The fixture behind them, in full:
//   iceberg.warehouse  table `orders`, materialized view `order_totals` over it
//   iceberg.system     table `iceberg_tables`, published by the connector itself
//   memory.app         tables `customers` and `orders`, view `customer_names`,
//                      functions plus_one(bigint), plus_one(double), label(bigint, varchar)
//   memory.default     empty
// ============================================================================

const OBJECT_CATALOG_ROWS: unknown[][] = [
  ["iceberg", "iceberg"],
  ["jmx", "jmx"],
  ["memory", "memory"],
  ["system", "system"],
  ["tpcds", "tpcds"],
  ["tpch", "tpch"],
];

/** Every catalog `listContainers()` answers with, in the order the cluster listed them. */
const FIXTURE_CATALOGS = [["iceberg"], ["jmx"], ["memory"], ["system"], ["tpcds"], ["tpch"]];

const SCHEMA_LIST_COLUMNS: Column[] = [{ name: "schemaName", type: "varchar" }];
const KIND_COUNT_COLUMNS: Column[] = [
  { name: "kind", type: "varchar" },
  { name: "n", type: "bigint" },
];
const OBJECT_NAME_COLUMNS: Column[] = [
  { name: "schemaName", type: "varchar" },
  { name: "objectName", type: "varchar" },
];
const OBJECT_COLUMN_COLUMNS: Column[] = [
  { name: "columnName", type: "varchar" },
  { name: "dataType", type: "varchar" },
  { name: "isNullable", type: "varchar" },
];

/** The bulk column read's projection: the object's address, then the column (#789). */
const BULK_COLUMN_COLUMNS: Column[] = [
  { name: "schemaName", type: "varchar" },
  { name: "objectName", type: "varchar" },
  { name: "columnName", type: "varchar" },
  { name: "dataType", type: "varchar" },
  { name: "isNullable", type: "varchar" },
];

/** `SHOW FUNCTIONS` output, verbatim: six columns, two of whose names carry a space. */
const FUNCTION_COLUMNS: Column[] = [
  { name: "Function", type: "varchar" },
  { name: "Return Type", type: "varchar" },
  { name: "Argument Types", type: "varchar" },
  { name: "Function Type", type: "varchar" },
  { name: "Deterministic", type: "boolean" },
  { name: "Description", type: "varchar" },
];

/** Two overloads of one name, which is why a function's path segment carries its types. */
const MEMORY_APP_FUNCTION_ROWS: unknown[][] = [
  ["label", "varchar", "bigint, varchar", "scalar", true, ""],
  ["plus_one", "bigint", "bigint", "scalar", true, ""],
  ["plus_one", "double", "double", "scalar", true, ""],
];

const ICEBERG = { catalog: "iceberg" } as const;
const ICEBERG_WAREHOUSE = { catalog: "iceberg", schema: "warehouse" } as const;
const MEMORY_APP = { catalog: "memory", schema: "app" } as const;

/**
 * The object-surface answers, keyed on the exported statement each read actually sends.
 *
 * Registered per test rather than in `SURFACE_ANSWERS` because the catalog list has to be
 * replaced as well, and the five-catalog capture the monitoring tests pin is asserted by
 * name in `getStorageStats`.
 */
function serveObjectSurface(): void {
  serveInstead(TRINO_CATALOG_LIST_SQL, rows(CATALOG_LIST_COLUMNS, OBJECT_CATALOG_ROWS));
  serveInstead(trinoSchemaListSql("iceberg"), rows(SCHEMA_LIST_COLUMNS, [["default"], ["system"], ["warehouse"]]));
  serveInstead(trinoSchemaListSql("memory"), rows(SCHEMA_LIST_COLUMNS, [["app"], ["default"]]));
  // The catalog holding a materialized view: `order_totals` is counted ONCE, as a
  // materialized view, even though `information_schema.tables` calls it a BASE TABLE.
  serveInstead(
    trinoObjectCountsSql(ICEBERG, true),
    rows(KIND_COUNT_COLUMNS, [
      ["table", 2],
      ["materialized_view", 1],
    ]),
  );
  serveInstead(
    trinoObjectCountsSql(ICEBERG_WAREHOUSE, true),
    rows(KIND_COUNT_COLUMNS, [
      ["table", 1],
      ["materialized_view", 1],
    ]),
  );
  serveInstead(
    trinoObjectCountsSql(MEMORY_APP, true),
    rows(KIND_COUNT_COLUMNS, [
      ["view", 1],
      ["table", 2],
    ]),
  );
  serveInstead(
    trinoRelationListSql(ICEBERG, "table"),
    rows(OBJECT_NAME_COLUMNS, [
      ["system", "iceberg_tables"],
      ["warehouse", "orders"],
    ]),
  );
  serveInstead(trinoRelationListSql(ICEBERG, "view"), rows(OBJECT_NAME_COLUMNS, []));
  serveInstead(trinoRelationListSql(ICEBERG_WAREHOUSE, "table"), rows(OBJECT_NAME_COLUMNS, [["warehouse", "orders"]]));
  serveInstead(
    trinoRelationListSql(MEMORY_APP, "table"),
    rows(OBJECT_NAME_COLUMNS, [
      ["app", "orders"],
      ["app", "customers"],
    ]),
  );
  serveInstead(trinoRelationListSql(MEMORY_APP, "view"), rows(OBJECT_NAME_COLUMNS, [["app", "customer_names"]]));
  serveInstead(trinoMaterializedViewListSql(ICEBERG), rows(OBJECT_NAME_COLUMNS, [["warehouse", "order_totals"]]));
  serveInstead(
    trinoMaterializedViewListSql(ICEBERG_WAREHOUSE),
    rows(OBJECT_NAME_COLUMNS, [["warehouse", "order_totals"]]),
  );
  serveInstead(trinoMaterializedViewListSql(MEMORY_APP), rows(OBJECT_NAME_COLUMNS, []));
  serveInstead(trinoFunctionListSql("iceberg", "warehouse"), rows(FUNCTION_COLUMNS, []));
  serveInstead(trinoFunctionListSql("memory", "app"), rows(FUNCTION_COLUMNS, MEMORY_APP_FUNCTION_ROWS));
  serveInstead(
    trinoObjectColumnsSql("iceberg", "warehouse", "orders"),
    rows(OBJECT_COLUMN_COLUMNS, [
      ["id", "bigint", "YES"],
      ["total", "double", "YES"],
    ]),
  );
  serveInstead(
    trinoObjectColumnsSql("iceberg", "warehouse", "order_totals"),
    rows(OBJECT_COLUMN_COLUMNS, [
      ["id", "bigint", "YES"],
      ["total", "double", "YES"],
    ]),
  );
  serveInstead(
    trinoObjectColumnsSql("memory", "app", "customer_names"),
    rows(OBJECT_COLUMN_COLUMNS, [["name", "varchar", "YES"]]),
  );
  serveInstead(trinoObjectColumnsSql("memory", "app", "gone"), rows(OBJECT_COLUMN_COLUMNS, []));

  // The FLAT reading, over the SAME objects the object reading publishes (#789).
  //
  // Without these two the double does not serve `getSchema()` for the object fixture's
  // catalog AT ALL, so the conformance helper's join guard has nothing to join and can only
  // report the two readings as two populations. The flat reading spells a table
  // `schema.table` against a three-segment object path, which is the exact shape that made
  // Trino join nothing before the address rule was fixed, so this is the join worth guarding
  // rather than a formality.
  //
  // One row is deliberately NOT the object reading's: `warehouse.order_totals` is a
  // MATERIALIZED VIEW, and `information_schema.tables` reports it as a BASE TABLE (measured
  // on 476), which is why the object surface anti-joins `system.metadata.materialized_views`
  // and the flat surface does not.
  serveInstead(
    trinoTableListSql("iceberg"),
    rows(TABLE_LIST_COLUMNS, [
      ["system", "iceberg_tables"],
      ["warehouse", "order_totals"],
      ["warehouse", "orders"],
    ]),
  );
  serveInstead(
    trinoColumnListSql("iceberg"),
    rows(COLUMN_LIST_COLUMNS, [
      ["system", "iceberg_tables", "table_name", "varchar", "YES", null],
      ["warehouse", "order_totals", "id", "bigint", "YES", null],
      ["warehouse", "order_totals", "total", "double", "YES", null],
      ["warehouse", "orders", "id", "bigint", "YES", null],
      ["warehouse", "orders", "total", "double", "YES", null],
    ]),
  );

  // The BULK column read (#789), keyed on the exported statement each read sends, over the
  // same objects the listings above publish.
  serveInstead(
    trinoObjectTargetSql(ICEBERG, "table"),
    rows(OBJECT_NAME_COLUMNS, [
      ["system", "iceberg_tables"],
      ["warehouse", "orders"],
    ]),
  );
  // `LIMIT 2` is what a caller's limit of 1 sends, and the catalog holds two tables, so it
  // comes back saturated - which is the whole point of asking for one more than the bound.
  serveInstead(
    trinoObjectTargetSql(ICEBERG, "table", 2),
    rows(OBJECT_NAME_COLUMNS, [
      ["system", "iceberg_tables"],
      ["warehouse", "orders"],
    ]),
  );
  serveInstead(
    trinoObjectTargetSql(ICEBERG, "table", 3),
    rows(OBJECT_NAME_COLUMNS, [
      ["system", "iceberg_tables"],
      ["warehouse", "orders"],
    ]),
  );
  serveInstead(trinoObjectTargetSql(ICEBERG, "view"), rows(OBJECT_NAME_COLUMNS, []));
  serveInstead(
    trinoObjectTargetSql(ICEBERG, TRINO_MATERIALIZED_VIEW_KIND),
    rows(OBJECT_NAME_COLUMNS, [["warehouse", "order_totals"]]),
  );
  serveInstead(
    trinoObjectTargetSql(MEMORY_APP, "table"),
    rows(OBJECT_NAME_COLUMNS, [
      ["app", "customers"],
      ["app", "orders"],
    ]),
  );
  serveInstead(
    trinoBulkColumnsSql(ICEBERG, "table"),
    rows(BULK_COLUMN_COLUMNS, [
      ["system", "iceberg_tables", "table_name", "varchar", "YES"],
      ["warehouse", "orders", "id", "bigint", "YES"],
      ["warehouse", "orders", "total", "double", "YES"],
    ]),
  );
  serveInstead(
    trinoBulkColumnsSql(ICEBERG, "table", 2),
    rows(BULK_COLUMN_COLUMNS, [
      ["system", "iceberg_tables", "table_name", "varchar", "YES"],
      ["warehouse", "orders", "id", "bigint", "YES"],
      ["warehouse", "orders", "total", "double", "YES"],
    ]),
  );
  serveInstead(
    trinoBulkColumnsSql(ICEBERG, "table", 3),
    rows(BULK_COLUMN_COLUMNS, [
      ["system", "iceberg_tables", "table_name", "varchar", "YES"],
      ["warehouse", "orders", "id", "bigint", "YES"],
      ["warehouse", "orders", "total", "double", "YES"],
    ]),
  );
  serveInstead(trinoBulkColumnsSql(ICEBERG, "view"), rows(BULK_COLUMN_COLUMNS, []));
  serveInstead(
    trinoBulkColumnsSql(ICEBERG, TRINO_MATERIALIZED_VIEW_KIND),
    rows(BULK_COLUMN_COLUMNS, [
      ["warehouse", "order_totals", "id", "bigint", "YES"],
      ["warehouse", "order_totals", "total", "double", "YES"],
    ]),
  );
  serveInstead(
    trinoBulkColumnsSql(MEMORY_APP, "table"),
    rows(BULK_COLUMN_COLUMNS, [
      ["app", "customers", "id", "bigint", "YES"],
      ["app", "customers", "name", "varchar", "YES"],
      ["app", "orders", "id", "bigint", "YES"],
      ["app", "orders", "customer_id", "bigint", "YES"],
      ["app", "orders", "total", "double", "YES"],
    ]),
  );
}

/** A provider pinned at the catalog AND the schema the fixture's objects live in. */
async function objectProvider(overrides: Partial<DatabaseConnection> = {}): Promise<TrinoProvider> {
  const provider = await connectProvider({ database: "iceberg", schema: "warehouse", ...overrides });
  serveObjectSurface();
  return provider;
}

describe("object surface", () => {
  test("declares the kinds Trino has, at two container levels", () => {
    const capabilities = new TrinoProvider(makeConnection()).getCapabilities();
    const kinds = capabilities.objectKinds ?? [];

    expect(kinds.map((kind) => kind.id).sort()).toEqual(["function", "materialized_view", "table", "view"]);
    // Measured on 476: a table takes an INSERT on a connector that supports one, a view
    // answers "Inserting into views is not supported" and a materialized view answers
    // "Inserting into materialized views is not supported".
    expect(kinds.find((kind) => kind.id === "table")?.acceptsRowWrites).toBe(true);
    expect(kinds.find((kind) => kind.id === "view")?.acceptsRowWrites).toBeUndefined();
    expect(kinds.find((kind) => kind.id === "materialized_view")?.acceptsRowWrites).toBeUndefined();
    expect(kinds.find((kind) => kind.id === "function")?.role).toBe("routine");
    // Trino has no trigger, no stored procedure and no user-facing index anywhere in its
    // model - `information_schema` holds eight views and none of them is a constraint, key
    // or index catalog - so none of the three is declared. A folder for a concept the
    // engine does not have is a lie its zero badge makes look like a fact.
    for (const absent of ["trigger", "procedure", "index", "sequence"]) {
      expect(kinds.find((kind) => kind.id === absent)).toBeUndefined();
    }

    expect(capabilities.containerLevels).toEqual([
      { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
      { id: "schema", label: "Schema", labelPlural: "Schemas" },
    ]);
  });

  test("satisfies the shared object surface contract", async () => {
    const provider = await objectProvider();

    await assertObjectSurface(provider, {
      containers: FIXTURE_CATALOGS,
      // `view` at 0 is not padding: it is the declared-and-empty case, which only renders
      // as a 0 badge because every declared kind is seeded before the rows overwrite it.
      kinds: { table: 2, materialized_view: 1, view: 0 },
      sampleObject: { path: ["iceberg", "warehouse", "orders"], kind: "table" },
    });
  });
});

/**
 * The rest of the object surface. Kept out of the block above so `-t "object surface"` still
 * runs the shared contract on its own.
 */
describe("Trino object containers, listings and detail", () => {
  test("the top level is every catalog the cluster has, with the connection's own marked", async () => {
    const provider = await objectProvider();
    const catalogs = await provider.listContainers!();

    expect(catalogs.map((container) => container.path)).toEqual(FIXTURE_CATALOGS);
    expect(catalogs.every((container) => container.level === 0)).toBe(true);
    // `system` and `jmx` are listed rather than filtered out. Both are real catalogs a user
    // can query, Trino publishes no "internal" flag to tell them apart from a data catalog,
    // and a name denylist is a boundary this repo has already found unmaintainable (#424).
    expect(catalogs.map((container) => container.name)).toContain("system");
    expect(catalogs.filter((container) => container.isSessionDefault).map((c) => c.name)).toEqual(["iceberg"]);
  });

  test("a nested list is the catalog's schemas, and the session's own schema is marked too", async () => {
    const provider = await objectProvider();
    const schemas = await provider.listContainers!(["iceberg"]);

    expect(schemas.map((container) => container.path)).toEqual([
      ["iceberg", "default"],
      ["iceberg", "system"],
      ["iceberg", "warehouse"],
    ]);
    expect(schemas.every((container) => container.level === 1)).toBe(true);
    // Standing ruling 5a2 (#789): first paint walks the container chain to the session
    // default at the DEEPEST declared level, so a two-level engine that marked only its
    // catalogs would open a catalog and stop, having read no counts at all.
    expect(schemas.filter((container) => container.isSessionDefault).map((c) => c.name)).toEqual(["warehouse"]);
    // `information_schema` is excluded, the same exclusion getSchema() already makes: every
    // catalog carries one and it holds only the tree's own plumbing.
    expect(schemas.map((container) => container.name)).not.toContain("information_schema");
  });

  test("a schema in a catalog the connection is not pinned to is never the session default", async () => {
    // Pinned at `iceberg`.`default`, and `memory` has a schema called `default` too. That
    // collision is measured rather than contrived: several Trino connectors create a
    // `default` schema, so BOTH halves of the predicate are load-bearing and a provider
    // comparing the schema name alone marks a row in every catalog on the cluster.
    const provider = await objectProvider({ schema: "default" });

    expect((await provider.listContainers!(["iceberg"])).filter((c) => c.isSessionDefault).map((c) => c.name)).toEqual([
      "default",
    ]);
    const elsewhere = await provider.listContainers!(["memory"]);
    expect(elsewhere.map((container) => container.name)).toEqual(["app", "default"]);
    expect(elsewhere.some((container) => container.isSessionDefault)).toBe(false);
  });

  test("nothing nests under a schema, which is a fact about Trino rather than a refusal", async () => {
    const provider = await objectProvider();

    expect(await provider.listContainers!(["iceberg", "warehouse"])).toEqual([]);
  });

  /**
   * Four properties of the statements themselves, asserted as TEXT rather than through a
   * behaviour, and the reason is a real limit of this harness rather than a preference.
   *
   * Every other assertion in this file routes a canned answer by the exact statement the
   * provider sends, and the test builds that statement with the SAME exported builder the
   * provider uses. So a change to a statement's meaning moves both sides together and no
   * behavioural assertion here can see it: measured, deleting the materialized-view
   * anti-join leaves all 103 tests green. So properties 1, 3 and 4 were each mutated
   * against a LIVE Trino 476 instead, and each one produced a wrong answer there - recorded
   * per property below. Property 2 is the one that cannot be live-verified, because no
   * `table_type` outside the two spellings exists on 476 to produce; it is pinned here as
   * the guard for the release that adds one.
   */
  test("the statements carry the four properties a replayed page cannot show", () => {
    const counts = trinoObjectCountsSql(ICEBERG_WAREHOUSE, true);

    // 1. The anti-join. Live with it removed, the `iceberg` catalog counts three tables and
    // one materialized view for two objects, and `order_totals` is listed under BOTH
    // folders - `information_schema.tables` calls a materialized view a BASE TABLE.
    expect(counts).toContain(
      "AND NOT EXISTS (SELECT 1 FROM system.metadata.materialized_views mv WHERE mv.catalog_name = 'iceberg' AND mv.schema_name = t.table_schema AND mv.name = t.table_name)",
    );
    // 2. The ELSE arm that makes an unmodelled `table_type` loud. Dropping it maps the
    // unknown spelling onto a declared kind, which is the silent miscount ruling 5a is
    // about.
    expect(counts).toContain(
      "CASE t.table_type WHEN 'BASE TABLE' THEN 'table' WHEN 'VIEW' THEN 'view' ELSE 'unknown:' || t.table_type END",
    );
    // 3. The materialized-view read is filtered to ONE catalog, and that is isolation
    // rather than an optimisation. Live with the filter removed, the `memory` catalog lists
    // `["memory", "warehouse", "order_totals"]` - a materialized view that lives in
    // `iceberg`, handed a path in `memory` that resolves to nothing. And against a
    // deliberately broken Iceberg catalog on the same cluster, the unfiltered read answers
    // `Error listing materialized views for catalog brokenice: Failed to connect: ...`
    // while this one still answers its row.
    expect(trinoMaterializedViewListSql(ICEBERG)).toContain("WHERE catalog_name = 'iceberg'");
    // 4. `information_schema` is excluded from the schema list. Live with the exclusion
    // removed, `memory` answers `["app", "default", "information_schema"]`: it is a schema
    // of EVERY catalog, so every catalog on the cluster would open onto a folder holding
    // the tree's own plumbing.
    expect(trinoSchemaListSql("memory")).toContain("WHERE schema_name <> 'information_schema'");
  });

  test("a materialized view is counted ONCE, even though information_schema calls it a table", async () => {
    const provider = await objectProvider();

    // Measured: `iceberg.information_schema.tables` reports `order_totals` as
    // `table_type = 'BASE TABLE'`, exactly like `orders`. Without the anti-join the schema
    // would count two tables and one materialized view for two objects, and the tree would
    // draw `order_totals` in both folders.
    expect(await provider.countObjects!(["iceberg", "warehouse"])).toEqual({
      table: { count: 1 },
      view: { count: 0 },
      materialized_view: { count: 1 },
      function: { count: 0 },
    });
  });

  test("a catalog-level count covers every schema, and says why it cannot count functions", async () => {
    const provider = await objectProvider();
    const counts = await provider.countObjects!(["iceberg"]);

    expect(counts).toMatchObject({ table: { count: 2 }, view: { count: 0 }, materialized_view: { count: 1 } });
    // Three facts, not two (#789). A function count for a whole catalog would need one
    // `SHOW FUNCTIONS` per schema, and `SHOW` is not composable - measured,
    // `SELECT * FROM (SHOW FUNCTIONS FROM memory.app)` is a syntax error - so the honest
    // answer is the engine's own limitation rather than a zero nobody measured.
    expect(counts.function).toEqual({ unavailable: expect.stringContaining("SHOW FUNCTIONS") });
    expect(sentAnything("SHOW FUNCTIONS")).toBe(false);
  });

  test("a schema-level count asks SHOW FUNCTIONS and counts the overloads separately", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });

    expect(await provider.countObjects!(["memory", "app"])).toEqual({
      table: { count: 2 },
      view: { count: 1 },
      materialized_view: { count: 0 },
      function: { count: 3 },
    });
  });

  test("a table_type this provider has no kind for RAISES out of countObjects, by name", async () => {
    const provider = await objectProvider();
    // Standing ruling 5a (#789). The `CASE`'s ELSE arm labels an unmodelled spelling
    // `unknown:<type>`, so a future `table_type` reaches the reader as a kind nothing
    // declares instead of falling out of the count AND the listing together, which is the
    // shape of defect that leaves ruling 5f satisfied while the object is invisible.
    //
    // It RAISES rather than being rewritten as `{ unavailable }`, which is the fix round's
    // decision and the one the doc and the two source docblocks already claimed. The two
    // states are different facts: `{ unavailable }` is the ENGINE refusing a read and the
    // tree renders the engine's sentence in a folder, while this is THIS PROVIDER meeting a
    // spelling its declaration has no kind for. Rendering the second as the first files a
    // provider defect in a folder badge nobody reads.
    serveInstead(
      trinoObjectCountsSql(ICEBERG_WAREHOUSE, true),
      rows(KIND_COUNT_COLUMNS, [
        ["table", 1],
        ["unknown:LOCAL TEMPORARY", 4],
      ]),
    );

    await expect(provider.countObjects!(["iceberg", "warehouse"])).rejects.toThrow(
      'Trino counted objects under "unknown:LOCAL TEMPORARY"',
    );
  });

  test("one kind's unmodelled spelling does not erase a kind counted from another source", async () => {
    const provider = await objectProvider();
    // The narrowing half of the same fix. `materialized_view` is counted from
    // `system.metadata.materialized_views` and `table` from `information_schema.tables`;
    // they ride one `UNION ALL` but they are two sources, and the old blanket catch turned
    // an information_schema surprise into `{ unavailable }` for the materialized-view count
    // as well - a kind whose own source answered perfectly well.
    //
    // The catch now wraps the READ alone, so the only thing that blanks every relation kind
    // is the statement itself failing, which genuinely does lose all of them.
    serveInstead(
      trinoObjectCountsSql(ICEBERG_WAREHOUSE, true),
      rows(KIND_COUNT_COLUMNS, [
        ["materialized_view", 1],
        ["unknown:LOCAL TEMPORARY", 4],
      ]),
    );

    const error = await provider.countObjects!(["iceberg", "warehouse"]).then(
      (counts) => counts,
      (raised: unknown) => raised,
    );
    // No `{ unavailable }` anywhere: the caller gets the defect, not a record with the
    // materialized-view count quietly replaced by a sentence about a table_type.
    expect(error).toBeInstanceOf(QueryError);
    expect(JSON.stringify(error)).not.toContain("unavailable");
  });

  test("lists tables and materialized views from their own sources, each path inside its container", async () => {
    const provider = await objectProvider();

    expect(await provider.listObjects!(["iceberg"], "table")).toEqual([
      { path: ["iceberg", "system", "iceberg_tables"], name: "iceberg_tables", kind: "table" },
      { path: ["iceberg", "warehouse", "orders"], name: "orders", kind: "table" },
    ]);
    expect(await provider.listObjects!(["iceberg"], "materialized_view")).toEqual([
      { path: ["iceberg", "warehouse", "order_totals"], name: "order_totals", kind: "materialized_view" },
    ]);
    // Sorted here rather than with an ORDER BY, so one rule covers four kinds read from two
    // different catalogs: the server returned `orders` before `customers`.
    expect((await provider.listObjects!(["memory", "app"], "table")).map((object) => object.name)).toEqual([
      "customers",
      "orders",
    ]);
  });

  test("a function's path segment carries its argument types, and its label does not", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });

    // Standing ruling 2 (#789): `path` addresses and `name` labels, and here they must
    // differ. Measured on 476, `plus_one(bigint)` and `plus_one(double)` coexist in one
    // schema, so a bare `plus_one` would give two objects one address.
    expect(await provider.listObjects!(["memory", "app"], "function")).toEqual([
      { path: ["memory", "app", "label(bigint, varchar)"], name: "label", kind: "function" },
      { path: ["memory", "app", "plus_one(bigint)"], name: "plus_one", kind: "function" },
      { path: ["memory", "app", "plus_one(double)"], name: "plus_one", kind: "function" },
    ]);
  });

  test("a catalog-level function listing refuses with the reason rather than fanning out", async () => {
    const provider = await objectProvider();

    await expect(provider.listObjects!(["iceberg"], "function")).rejects.toThrow("SHOW FUNCTIONS");
    expect(sentAnything("SHOW FUNCTIONS")).toBe(false);
  });

  test("refuses a kind it does not declare, from both methods", async () => {
    const provider = await objectProvider();

    await expect(provider.listObjects!(["iceberg"], "trigger")).rejects.toThrow(
      'Trino declares no object kind "trigger"',
    );
    await expect(provider.describeObject!(["iceberg", "warehouse", "t"], "trigger")).rejects.toThrow(
      'Trino declares no object kind "trigger"',
    );
  });

  test("describes a table and a materialized view, and declares neither index nor foreign key", async () => {
    const provider = await objectProvider();

    expect(await provider.describeObject!(["iceberg", "warehouse", "orders"], "table")).toEqual({
      path: ["iceberg", "warehouse", "orders"],
      columns: [
        { name: "id", type: "bigint", nullable: true, isPrimary: false },
        { name: "total", type: "double", nullable: true, isPrimary: false },
      ],
      // Not an empty schema but an empty MODEL: Trino's `information_schema` holds no
      // `table_constraints` and no `key_column_usage`, so there is nothing to read in any
      // catalog of any connector (#414).
      indexes: [],
      foreignKeys: [],
    });
    const detail = await provider.describeObject!(["iceberg", "warehouse", "order_totals"], "materialized_view");
    expect(detail.columns.map((column) => column.name)).toEqual(["id", "total"]);
  });

  test("a view's columns come from the same read, because information_schema carries them", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });
    const detail = await provider.describeObject!(["memory", "app", "customer_names"], "view");

    expect(detail.columns.map((column) => column.name)).toEqual(["name"]);
  });

  test("a function answers three empty arrays without asking the cluster anything", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });
    sentSql = [];

    // A routine legitimately has no columns, no indexes and no foreign keys, so the answer
    // is a fact about the kind rather than a failed read. The kind decides it: nothing here
    // reads the name to work out what it is holding.
    expect(await provider.describeObject!(["memory", "app", "plus_one(bigint)"], "function")).toEqual({
      path: ["memory", "app", "plus_one(bigint)"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    expect(sentSql).toEqual([]);
  });

  test("a relation with no column row is a relation that is not there", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });

    // `CREATE TABLE t ()` is a syntax error on this engine, so a relation with zero columns
    // cannot exist. Answering `{ columns: [] }` would render a dropped table as a table
    // with no columns.
    await expect(provider.describeObject!(["memory", "app", "gone"], "table")).rejects.toThrow(
      "No column row for memory.app.gone",
    );
  });

  test("a kind spelled like a prototype member is refused, not read off the prototype chain", async () => {
    const provider = await objectProvider();
    // Standing ruling 5g (#789): a kind id is an OPEN string, so `"toString" in counts` is
    // true for every object in JavaScript and a catalog row spelled that way would be
    // accepted as a declared kind. `Object.hasOwn` is the same length and asks the question
    // that was meant.
    serveInstead(trinoObjectCountsSql(ICEBERG_WAREHOUSE, true), rows(KIND_COUNT_COLUMNS, [["toString", 5]]));

    await expect(provider.countObjects!(["iceberg", "warehouse"])).rejects.toThrow(
      'Trino counted objects under "toString"',
    );
  });

  test("a count nobody could read stays at the seeded zero rather than becoming NaN", async () => {
    const provider = await objectProvider();
    serveInstead(
      trinoObjectCountsSql(ICEBERG_WAREHOUSE, true),
      rows(KIND_COUNT_COLUMNS, [
        ["table", null],
        ["materialized_view", 1],
      ]),
    );

    // `Number(null)` is 0 and `Number(undefined)` is NaN, and a NaN renders as a blank
    // badge that looks like a read nobody took. Leaving the kind at its seeded value is the
    // one answer that stays a number without inventing one.
    const counts = await provider.countObjects!(["iceberg", "warehouse"]);
    expect(counts).toMatchObject({ table: { count: 0 }, materialized_view: { count: 1 } });
  });

  test("a row whose kind is not a string is skipped rather than counted under it", async () => {
    const provider = await objectProvider();
    serveInstead(
      trinoObjectCountsSql(ICEBERG_WAREHOUSE, true),
      rows(KIND_COUNT_COLUMNS, [
        [null, 9],
        ["table", 1],
      ]),
    );

    expect(await provider.countObjects!(["iceberg", "warehouse"])).toMatchObject({ table: { count: 1 } });
  });

  test("a relation kind with no information_schema table_type behind it is refused by name", async () => {
    const provider = await objectProvider();
    const real = new TrinoProvider(makeConnection()).getCapabilities();
    // A DECLARATION defect rather than an engine one: `table_type` answers `BASE TABLE` and
    // `VIEW` and nothing else, so a relation kind outside that vocabulary would draw a
    // folder no statement can fill. Saying so names what is missing.
    spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      objectKinds: [{ id: "sequence", role: "relation", label: "Sequence", labelPlural: "Sequences" }],
    });

    await expect(provider.listObjects!(["iceberg", "warehouse"], "sequence")).rejects.toThrow(
      'Trino declares the kind "sequence" but no information_schema table_type answers for it',
    );
  });

  test("a refused read carries the engine's own sentence rather than a zero nobody measured", async () => {
    const provider = await objectProvider();
    serveInstead(trinoObjectCountsSql(ICEBERG_WAREHOUSE, true), refusal(CATALOG_NOT_FOUND));

    const counts = await provider.countObjects!(["iceberg", "warehouse"]);
    expect(counts.table).toEqual({ unavailable: expect.stringContaining("Catalog 'nosuchcat' not found") });
    // The function count came from its OWN read and survives, because the two reads have
    // independent failure modes: one is `system.metadata`, the other is a connector feature.
    expect(counts.function).toEqual({ count: 0 });
  });
});

/**
 * Standing ruling 5g (#789): every derivation over the declaration, pinned by handing the
 * provider a declaration its engine does not have.
 *
 * Driven to a BOUND VALUE and never to a refusal. A test that stops at the refusal path is
 * how the third spelling of this defect survived two providers and a review round, so the
 * crossed fixture below holds two DIFFERENT relations at the two spellings -
 * `alpha.beta.pin` and `beta.alpha.pin`, with different columns - and the assertions read
 * the column names back.
 */
/**
 * The bulk column read (#789).
 *
 * The double answers the exported statement each read sends, over the SAME objects the
 * listings publish, so every "the two readings agree" assertion compares two answers the
 * provider produced. What a double keyed on statement text cannot see is a rewrite of that
 * text (standing ruling 5b), so the whole method was also run against a live Trino 476
 * holding `docker/trino-init/01-object-fixture.sql`; what that measured is in
 * docs/providers/trino.md.
 */
describe("Trino bulk column read", () => {
  test("describes every table in a CATALOG, across both its schemas, and each detail is the single read's", async () => {
    const provider = await objectProvider();

    const batch = await provider.describeObjects(["iceberg"], "table");

    expect(batch.truncated).toBeUndefined();
    expect(batch.details.map((detail) => detail.path)).toEqual([
      ["iceberg", "system", "iceberg_tables"],
      ["iceberg", "warehouse", "orders"],
    ]);
    // One mapper serves both reads, so a divergence here is the bulk read spelling a column
    // differently from the single read of the same object.
    expect(batch.details[1]!.columns).toEqual([
      { name: "id", type: "bigint", nullable: true, isPrimary: false },
      { name: "total", type: "double", nullable: true, isPrimary: false },
    ]);
    expect(batch.details[1]).toEqual(await provider.describeObject(["iceberg", "warehouse", "orders"], "table"));
    // No index and no foreign key anywhere, in any catalog of any connector: Trino's
    // `information_schema` holds eight views and neither `table_constraints` nor
    // `key_column_usage` is among them.
    expect(batch.details.every((detail) => detail.indexes.length === 0 && detail.foreignKeys.length === 0)).toBe(true);
  });

  test("every described path is one listObjects produced, for both relation sources", async () => {
    const provider = await objectProvider();

    for (const kind of ["table", TRINO_MATERIALIZED_VIEW_KIND]) {
      const listed = await provider.listObjects(["iceberg"], kind);
      const batch = await provider.describeObjects(["iceberg"], kind);
      expect(batch.details.map((detail) => detail.path)).toEqual(listed.map((object) => object.path));
    }
  });

  test("a materialized view describes from information_schema.columns, addressed by the OTHER catalog's listing", async () => {
    // The two sources really are different catalogs: the target comes from
    // `system.metadata.materialized_views`, which is the only place a materialized view is
    // published as one, and the columns come from `information_schema.columns`, which
    // answers for it (measured on 476) while calling it a BASE TABLE.
    const provider = await objectProvider();

    const batch = await provider.describeObjects(["iceberg"], TRINO_MATERIALIZED_VIEW_KIND);

    expect(batch.details.map((detail) => detail.path)).toEqual([["iceberg", "warehouse", "order_totals"]]);
    expect(batch.details[0]!.columns.map((column) => column.name)).toEqual(["id", "total"]);
  });

  test("a whole folder costs two statements, whatever it holds", async () => {
    const provider = await objectProvider();
    sentSql = [];

    const batch = await provider.describeObjects(["iceberg"], "table");

    // The target read and the column read. The single read is one statement PER OBJECT, so
    // the alternative for these two objects was two - and for a 200-table catalog, 200.
    expect(batch.details).toHaveLength(2);
    expect(sentSql).toHaveLength(2);
  });

  test("a function answers an empty batch with no round trip at all, at either container depth", async () => {
    const provider = await objectProvider();
    sentSql = [];

    await expect(provider.describeObjects(["iceberg", "warehouse"], "function")).resolves.toEqual({ details: [] });
    // And at CATALOG level too, where `listObjects` refuses: the refusal is about the
    // fan-out `SHOW FUNCTIONS` would need, and there is no fan-out here because a routine
    // has no columns to read in the first place.
    await expect(provider.describeObjects(["iceberg"], "function")).resolves.toEqual({ details: [] });

    expect(sentSql).toEqual([]);
    // The control: a kind that DOES have columns still reaches the cluster.
    await provider.describeObjects(["iceberg"], "table");
    expect(sentSql.length).toBeGreaterThan(0);
  });

  test("an undeclared kind raises, naming the engine and the kind", async () => {
    const provider = await objectProvider();

    await expect(provider.describeObjects(["iceberg"], "sequence")).rejects.toThrow(
      /Trino declares no object kind "sequence"/,
    );
  });

  test("a container path of the wrong shape raises through the declaration, not a literal depth", async () => {
    const provider = await objectProvider();

    await expect(provider.describeObjects([], "table")).rejects.toThrow(/A Trino container path is/);
    await expect(provider.describeObjects(["iceberg", "warehouse", "orders"], "table")).rejects.toThrow(
      /A Trino container path is/,
    );
  });

  test("the container segments are read BY LEVEL, which a SCHEMA-level read shows", async () => {
    // Standing ruling 5g, driven to a BOUND VALUE. `container[0]` is the CATALOG and
    // `container[1]` the SCHEMA, and the two reach different parts of the statement: the
    // catalog is a three-part name prefix and the schema is a quoted literal in a predicate.
    const provider = await objectProvider();

    const batch = await provider.describeObjects(["memory", "app"], "table");

    expect(batch.details.map((detail) => detail.path)).toEqual([
      ["memory", "app", "customers"],
      ["memory", "app", "orders"],
    ]);
    expect(batch.details[1]!.columns.map((column) => column.name)).toEqual(["id", "customer_id", "total"]);
    expect(sqlWith("JOIN (SELECT t.table_schema")).toContain('"memory".information_schema.columns');
    expect(sqlWith("JOIN (SELECT t.table_schema")).toContain("t.table_schema = 'app'");
  });

  /**
   * `truncated` is computed from the READ, never from what survived the row filter (#789
   * bulk-read review, Minor 8).
   *
   * The target read asks for `limit + 1` rows precisely so a saturated read is told from an
   * exact one. Counting the filtered list instead means a row this provider cannot read back
   * both drops the object and suppresses the flag: `limit` details handed over as complete
   * while `limit + 1` objects exist. Unreachable on today's row shapes -
   * `readObjectIdentifier` rejects only a non-string or an empty string, and no Trino
   * catalog column answers either - so the fake cluster answers one.
   */
  test("a target row this provider cannot read still counts towards the truncation flag", async () => {
    const provider = await objectProvider();
    // AFTER the surface is served, so this reply is the one that wins: `objectProvider()`
    // reinstalls the whole fixture and would otherwise overwrite it.
    serveInstead(
      trinoObjectTargetSql(ICEBERG, "table", 2),
      rows(OBJECT_NAME_COLUMNS, [
        ["system", "iceberg_tables"],
        ["warehouse", ""],
      ]),
    );

    const batch = await provider.describeObjects(["iceberg"], "table", 1);

    expect(batch.details.map((detail) => detail.path)).toEqual([["iceberg", "system", "iceberg_tables"]]);
    expect(batch.truncated).toEqual({ limit: 1, reason: callerBoundTruncationReason(1) });
  });

  test("a limit that is not a positive whole number raises rather than clamping", async () => {
    const provider = await objectProvider();
    sentSql = [];

    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(provider.describeObjects(["iceberg"], "table", limit)).rejects.toThrow(
        /A Trino bulk column read limit must be a positive whole number/,
      );
    }
    // Nothing was sent for any of them: the guard is before the read, and the value is
    // interpolated into a `LIMIT` clause, so a fraction would be a syntax error rather than
    // a bound.
    expect(sentSql).toEqual([]);
  });

  test("a bound that bites reports the caller's own limit, and one that does not never reports", async () => {
    const provider = await objectProvider();

    const bounded = await provider.describeObjects(["iceberg"], "table", 1);
    expect(bounded.details.map((detail) => detail.path)).toEqual([["iceberg", "system", "iceberg_tables"]]);
    expect(bounded.truncated?.limit).toBe(1);
    expect(bounded.truncated?.reason.length).toBeGreaterThan(0);
    // The bound cuts OBJECTS and never columns.
    expect(bounded.details[0]!.columns.map((column) => column.name)).toEqual(["table_name"]);
    // `limit + 1` is what the statement carries, so a saturated read is told from an exact
    // one with no second count: a limit of 1 sent `LIMIT 2`.
    expect(sqlWith("LIMIT 2")).toContain('ORDER BY "schemaName", "objectName" LIMIT 2');

    const exact = await provider.describeObjects(["iceberg"], "table", 2);
    expect(exact.details).toHaveLength(2);
    expect(exact.truncated).toBeUndefined();

    const unbounded = await provider.describeObjects(["iceberg"], "table");
    expect(unbounded.details).toHaveLength(2);
    expect(unbounded.truncated).toBeUndefined();
  });

  test("an empty folder answers an empty batch rather than raising", async () => {
    const provider = await objectProvider();

    // The iceberg catalog holds no view at all, and "this container holds none" is a true
    // answer rather than the single read's "no column row", which means the object is not
    // there under the name it was asked for.
    await expect(provider.describeObjects(["iceberg"], "view")).resolves.toEqual({ details: [] });
  });

  test("a row with no usable address or column name is skipped, as it is in the single read", async () => {
    const provider = await objectProvider();
    // `serveInstead` and not `overrideSurface`: this has to compose with the object surface
    // already registered, and a substring override would replace all of it.
    serveInstead(
      trinoBulkColumnsSql(ICEBERG, "table"),
      rows(BULK_COLUMN_COLUMNS, [
        [null, "orders", "dropped", "bigint", "YES"],
        ["warehouse", null, "dropped", "bigint", "YES"],
        ["warehouse", "orders", null, "bigint", "YES"],
        ["warehouse", "orders", "kept", "bigint", "NO"],
      ]),
    );

    const batch = await provider.describeObjects(["iceberg"], "table");
    const orders = batch.details.find((detail) => detail.path[2] === "orders")!;

    expect(orders.columns).toEqual([{ name: "kept", type: "bigint", nullable: false, isPrimary: false }]);
    // The object with no address contributed nothing, and the object that WAS listed still
    // came back: membership is the target read's answer and never the column read's.
    expect(batch.details.map((detail) => detail.path)).toEqual([
      ["iceberg", "system", "iceberg_tables"],
      ["iceberg", "warehouse", "orders"],
    ]);
  });

  test("the answer is sorted by path, which is not the order the cluster cut by", async () => {
    // The two orders are separated deliberately. Trino's `ORDER BY` compares varchars as
    // UTF-8 BYTES - measured on 476, `U&'\+00E000' < U&'\+01F600'` is true, bytes
    // `ee 80 80` below `f0 9f 98 80` - while `comparePaths` compares UTF-16 code units,
    // where the surrogate `0xD83D` sorts below `0xE000`. So the MEMBERSHIP of a bounded cut
    // is the cluster's and the ORDER of the answer is ours.
    const provider = await objectProvider();
    serveInstead(
      trinoObjectTargetSql(ICEBERG, "table"),
      rows(OBJECT_NAME_COLUMNS, [
        ["warehouse", ""],
        ["warehouse", "\u{1F600}"],
      ]),
    );
    serveInstead(
      trinoBulkColumnsSql(ICEBERG, "table"),
      rows(BULK_COLUMN_COLUMNS, [
        ["warehouse", "", "a", "bigint", "YES"],
        ["warehouse", "\u{1F600}", "b", "bigint", "YES"],
      ]),
    );

    const batch = await provider.describeObjects(["iceberg"], "table");

    expect(batch.details.map((detail) => detail.path)).toEqual([
      ["iceberg", "warehouse", "\u{1F600}"],
      ["iceberg", "warehouse", ""],
    ]);
  });
});

describe("Trino object paths are derived from the declaration, never from a position", () => {
  const CROSSED = [
    ["alpha", "beta", "from_alpha_beta"],
    ["beta", "alpha", "from_beta_alpha"],
  ] as const;

  function serveCrossed(): void {
    for (const [catalog, schema, column] of CROSSED) {
      serveInstead(
        trinoObjectColumnsSql(catalog, schema, "pin"),
        rows(OBJECT_COLUMN_COLUMNS, [[column, "bigint", "YES"]]),
      );
      serveInstead(trinoObjectCountsSql({ catalog, schema }, true), rows(KIND_COUNT_COLUMNS, [["table", 1]]));
      serveInstead(trinoRelationListSql({ catalog, schema }, "table"), rows(OBJECT_NAME_COLUMNS, [[schema, "pin"]]));
      serveInstead(trinoFunctionListSql(catalog, schema), rows(FUNCTION_COLUMNS, []));
      serveInstead(trinoObjectCountsSql({ catalog }, true), rows(KIND_COUNT_COLUMNS, [["table", 2]]));
      // Two DIFFERENT names, because a catalog-level listing on a ONE-level declaration
      // drops the schema out of the path: two rows called `pin` would then answer one
      // address and the assertion below could not tell a derived path from a truncated one.
      serveInstead(
        trinoRelationListSql({ catalog }, "table"),
        rows(OBJECT_NAME_COLUMNS, [
          [schema, "pin"],
          ["extra", "other"],
        ]),
      );
    }
  }

  /** The real declaration, with `containerLevels` replaced and nothing else. */
  function withLevels(provider: TrinoProvider, containerLevels: ProviderCapabilities["containerLevels"]): void {
    const real = new TrinoProvider(makeConnection()).getCapabilities();
    spyOn(provider, "getCapabilities").mockReturnValue({ ...real, containerLevels });
  }

  test("the crossed fixture really does hold two different relations at the two spellings", async () => {
    const provider = await connectProvider();
    serveCrossed();

    // The control for everything below. Without it a positional read and a derived one
    // could agree by accident, and the pin would certify nothing.
    expect((await provider.describeObject!(["alpha", "beta", "pin"], "table")).columns.map((c) => c.name)).toEqual([
      "from_alpha_beta",
    ]);
    expect((await provider.describeObject!(["beta", "alpha", "pin"], "table")).columns.map((c) => c.name)).toEqual([
      "from_beta_alpha",
    ]);
  });

  test("a declaration listing schema BEFORE catalog moves every read with it", async () => {
    const provider = await connectProvider();
    serveCrossed();
    withLevels(provider, [
      { id: "schema", label: "Schema", labelPlural: "Schemas" },
      { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
    ]);

    // `["beta", "alpha", "pin"]` now means schema `beta` in catalog `alpha`, so the object
    // it addresses is `alpha.beta.pin` and its column is `from_alpha_beta`. A provider
    // binding `path[0]` as the catalog answers `from_beta_alpha` here, which is a different
    // real relation rather than an error - exactly the silent case this ruling exists for.
    const detail = await provider.describeObject!(["beta", "alpha", "pin"], "table");
    expect(detail.columns.map((column) => column.name)).toEqual(["from_alpha_beta"]);

    // The container reads move with it too, and the path a listing CONSTRUCTS is written in
    // the declared order, so `describeObject` reads it back as the same object. That round
    // trip is what the conformance helper does.
    expect(await provider.countObjects!(["beta", "alpha"])).toMatchObject({ table: { count: 1 } });
    const listed = await provider.listObjects!(["beta", "alpha"], "table");
    expect(listed.map((object) => object.path)).toEqual([["beta", "alpha", "pin"]]);
    expect((await provider.describeObject!(listed[0].path, "table")).columns.map((c) => c.name)).toEqual([
      "from_alpha_beta",
    ]);

    // And the refusal names the declared level IDS in the declared order, so a person
    // reading it is told the shape this declaration actually accepts.
    await expect(provider.describeObject!(["alpha", "pin"], "table")).rejects.toThrow(
      'A Trino "table" path is [schema, catalog, name], received ["alpha","pin"]',
    );
  });

  test("a refusal spells the level ID, the same field every read binds by", async () => {
    const provider = await connectProvider();
    serveCrossed();
    // The two message builders used to spell the path shape from `level.label`, while every
    // READ resolves its segment by `level.id`. On the real declaration the two are the same
    // word, so the divergence is invisible; a declaration whose label is prose makes it
    // visible, and then the refusal describes a shape no read accepts.
    withLevels(provider, [
      { id: "catalog", label: "Data source", labelPlural: "Data sources" },
      { id: "schema", label: "Namespace", labelPlural: "Namespaces" },
    ]);

    await expect(provider.describeObject!(["alpha", "pin"], "table")).rejects.toThrow(
      'A Trino "table" path is [catalog, schema, name], received ["alpha","pin"]',
    );
    await expect(provider.countObjects!(["alpha", "beta", "pin"])).rejects.toThrow(
      'A Trino container path is [catalog] or [catalog, schema], received ["alpha","beta","pin"]',
    );

    // The control, and the reason the two assertions above are about a divergence rather
    // than about a string: with this same declaration the reads still resolve, because they
    // bind by `id`. So the message is the only thing that was ever spelled from `label`.
    expect(await provider.countObjects!(["alpha", "beta"])).toMatchObject({ table: { count: 1 } });
  });

  test("container depth is derived, so a ONE-level declaration binds one segment and refuses two", async () => {
    const provider = await connectProvider();
    serveCrossed();
    withLevels(provider, [{ id: "catalog", label: "Catalog", labelPlural: "Catalogs" }]);

    // Driven to a BOUND VALUE: at one level the whole catalog is the container, so the
    // statement carries no schema filter and the listing carries two-segment paths. A
    // provider that cut the path at a literal 2 would ask about a schema called `undefined`.
    expect(await provider.countObjects!(["alpha"])).toMatchObject({ table: { count: 2 } });
    expect((await provider.listObjects!(["alpha"], "table")).map((object) => object.path)).toEqual([
      ["alpha", "other"],
      ["alpha", "pin"],
    ]);

    expect(await provider.listContainers!(["alpha"])).toEqual([]);
    await expect(provider.countObjects!(["alpha", "beta"])).rejects.toThrow(
      'A Trino container path is [catalog], received ["alpha","beta"]',
    );
    // And a detail read has no schema segment to bind at all, so it raises NAMING the level
    // rather than asking the cluster about a schema called `undefined`.
    await expect(provider.describeObject!(["alpha", "pin"], "table")).rejects.toThrow(
      "Trino declares no schema level to read this path's segment from",
    );
  });

  test("a declaration carrying MORE levels than the model has is cut to the declared depth", async () => {
    const provider = await connectProvider();
    serveCrossed();
    // `containerDepth()` answers at most 2 and is the ONLY reader of how deep a declaration
    // goes (standing ruling 1, #789): `containerLevels.length` is not. A third entry must
    // widen nothing - not the accepted container shapes, not the segment lookup, not the
    // object path.
    withLevels(provider, [
      { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
      { id: "schema", label: "Schema", labelPlural: "Schemas" },
      { id: "schema", label: "Sub-schema", labelPlural: "Sub-schemas" },
    ]);

    await expect(provider.countObjects!(["alpha", "beta", "extra"])).rejects.toThrow(
      'A Trino container path is [catalog] or [catalog, schema], received ["alpha","beta","extra"]',
    );
    expect(await provider.countObjects!(["alpha", "beta"])).toMatchObject({ table: { count: 1 } });
    expect((await provider.listObjects!(["alpha", "beta"], "table")).map((object) => object.path)).toEqual([
      ["alpha", "beta", "pin"],
    ]);
    expect(await provider.listContainers!(["alpha", "beta"])).toEqual([]);
  });

  test("a declaration with NO container level refuses every container path", async () => {
    const provider = await connectProvider();
    withLevels(provider, []);

    // `containerDepth()` reads absent and empty as the same zero, so there is no shape at
    // all and the message says so rather than accepting `[]` as "the root".
    await expect(provider.countObjects!([])).rejects.toThrow(
      "A Trino container path is nothing: this declaration carries no container level, received []",
    );
    expect(await provider.listContainers!(["alpha"])).toEqual([]);
  });

  test("a kind declaring attachedTo is refused, because Trino holds no attached object", async () => {
    const provider = await connectProvider();
    const real = new TrinoProvider(makeConnection()).getCapabilities();
    spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      objectKinds: [
        { id: "trigger", role: "attached", label: "Trigger", labelPlural: "Triggers", attachedTo: "table" },
      ],
    });

    await expect(provider.describeObject!(["alpha", "beta", "pin", "stamp"], "trigger")).rejects.toThrow(
      'Trino holds no object attached to another, so the kind "trigger" cannot declare attachedTo "table"',
    );
  });
});

/**
 * `comparePaths` at the one depth a Trino listing cannot produce.
 *
 * Every kind here sits at exactly `[catalog, schema, name]`, so a listing never hands the
 * comparator two paths where one is a prefix of the other and the sort always returns from
 * inside the loop. The prefix case is still real for the comparator: standing ruling 5f
 * (#789) has kinds at mixed depth on other engines, and this is the fifth copy of the
 * function, about to be hoisted into `src/lib/db/object-kinds.ts` by Task 28's sweep. So it
 * is pinned directly rather than left as an arm no payload reaches - an unfolded arm is
 * reported as covered while dead (ruling 5b).
 */
describe("Trino path ordering", () => {
  test("orders segment by segment, shorter first where one path is a prefix of the other", () => {
    expect(comparePaths(["a", "b"], ["a", "c"])).toBeLessThan(0);
    expect(comparePaths(["a", "c"], ["a", "b"])).toBeGreaterThan(0);
    expect(comparePaths(["a"], ["a", "b"])).toBeLessThan(0);
    expect(comparePaths(["a", "b"], ["a"])).toBeGreaterThan(0);
    expect(comparePaths(["a", "b"], ["a", "b"])).toBe(0);
    // Never `JSON.stringify`: serialised, the deeper path sorts FIRST because `,` is below
    // `]`, which is the defect standing ruling 5g rules out as a path key.
    expect(JSON.stringify(["a", "b"]) < JSON.stringify(["a"])).toBe(true);
  });
});
