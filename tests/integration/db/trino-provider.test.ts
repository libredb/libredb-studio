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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
import { renderSegments } from "@/lib/db/object-edit";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
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
  TRINO_SOURCE_PART_ID,
  trinoArgumentSignature,
  trinoBulkColumnsSql,
  trinoFunctionListSql,
  trinoObjectTargetSql,
  trinoMaterializedViewListSql,
  trinoObjectColumnsSql,
  trinoObjectCountsSql,
  trinoCreateSignature,
  functionSegment,
  sha256Hex,
  trinoFunctionSegmentParts,
  trinoObjectSourceSql,
  trinoSentOffsetOf,
  trinoSpliceAt,
  trinoRelationListSql,
  trinoSchemaListSql,
  trinoSourceStatementFor,
} from "@/lib/db/providers/sql/trino/objects";
import { TrinoProvider } from "@/lib/db/providers/sql/trino/index";
import type {
  DatabaseProvider,
  ObjectEditBuild,
  ObjectEditOutcome,
  ObjectEditPlan,
  ProviderCapabilities,
} from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
import { isSourcePartUnavailable } from "@/lib/db/object-kinds";
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
    expect(capabilities.supportsResultPagination).toBe(true);
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

/**
 * `memory.app`'s functions, captured VERBATIM from `SHOW FUNCTIONS FROM memory.app` on a live
 * trinodb/trino:476 on 2026-09-13 after applying `docker/trino-init/01-object-fixture.sql`.
 *
 * Six rows and not one of them is padding. `plus_one` twice is why a path segment carries its
 * argument types at all. `hard` is the row whose `Argument Types` rendering DIFFERS from the
 * one `SHOW CREATE FUNCTION` prints for the same overload, which is what the source read's
 * signature comparison exists for. `answer` is the empty argument list. `we(ird` is a name
 * holding an open parenthesis, so the first `(` in its segment belongs to the NAME.
 */
const MEMORY_APP_FUNCTION_ROWS: unknown[][] = [
  ["answer", "bigint", "", "scalar", true, ""],
  ["hard", "varchar", 'decimal(10,2), array(varchar), row("a" bigint,"b" varchar)', "scalar", true, ""],
  ["label", "varchar", "bigint, varchar", "scalar", true, ""],
  // The body holding the word CREATE, which is the population an ANCHORED splice needs (#789
  // Phase 3), and the object whose read is OVER the 1,000,000-character bound.
  ["mentions_create", "varchar", "bigint", "scalar", true, ""],
  ["over_limit_fn", "array(decimal(38,1))", "bigint", "scalar", true, ""],
  ["plus_one", "bigint", "bigint", "scalar", true, ""],
  ["plus_one", "double", "double", "scalar", true, ""],
  ["rowparen", "bigint", 'row("a)b" bigint,"c" varchar)', "scalar", true, ""],
  ["we(ird", "bigint", "bigint", "scalar", true, ""],
];

// ----------------------------------------------------------------------------
// The source read (#789)
// ----------------------------------------------------------------------------
// Every definition below is the VERBATIM reply of the statement above it, captured from the
// same live trinodb/trino:476 on 2026-09-13. They are what makes the reply-column spelling,
// the whitespace and the overload rendering facts rather than guesses.

/** `SHOW CREATE` answers exactly one column, and its name is also the part's label. */
const SOURCE_COLUMNS: Record<string, Column[]> = {
  "Create Table": [{ name: "Create Table", type: "varchar" }],
  "Create View": [{ name: "Create View", type: "varchar" }],
  "Create Materialized View": [{ name: "Create Materialized View", type: "varchar" }],
  "Create Function": [{ name: "Create Function", type: "varchar" }],
};

const CREATE_CUSTOMERS = "CREATE TABLE memory.app.customers (\n   id bigint,\n   name varchar\n)";
const CREATE_ORDERS = "CREATE TABLE memory.app.orders (\n   id bigint,\n   customer_id bigint,\n   total double\n)";
/** `SECURITY DEFINER` is the engine's, not the author's: the fixture never wrote it. */
const CREATE_CUSTOMER_NAMES =
  "CREATE VIEW memory.app.customer_names SECURITY DEFINER AS\nSELECT\n  id\n, name\nFROM\n  memory.app.customers";
const CREATE_ORDER_TOTALS =
  "CREATE MATERIALIZED VIEW iceberg.warehouse.order_totals\nWITH (\n   format = 'PARQUET',\n   format_version = 2,\n   location = 'file:/data/warehouse/hive/order_totals-8d3c899bf07c4dff8ce49fbc3cf87bde',\n   max_commit_retry = 4,\n   storage_schema = 'warehouse'\n) AS\nSELECT\n  id\n, total\nFROM\n  hivelake.warehouse.orders";
/** The DOUBLE overload comes back FIRST, which is why "take the first row" is wrong. */
const CREATE_PLUS_ONE_DOUBLE =
  "CREATE FUNCTION memory.app.plus_one(x double)\nRETURNS double\nRETURN (x + DECIMAL '1.0')";
const CREATE_PLUS_ONE_BIGINT = "CREATE FUNCTION memory.app.plus_one(x bigint)\nRETURNS bigint\nRETURN (x + 1)";
/**
 * The renderings that DIFFER. `SHOW FUNCTIONS` says
 * `decimal(10,2), array(varchar), row("a" bigint,"b" varchar)` for this very overload, so a
 * raw string comparison of the two matches nothing.
 */
const CREATE_HARD =
  "CREATE FUNCTION memory.app.hard(amount decimal(10, 2), tags array(varchar), r ROW(a bigint, b varchar))\nRETURNS varchar\nRETURN CAST(amount AS varchar)";
const CREATE_ANSWER = "CREATE FUNCTION memory.app.answer()\nRETURNS bigint\nRETURN 42";
/**
 * A ROW FIELD name holding a CLOSE PARENTHESIS, which round-trips through both renderings.
 * A scan for the parameter list's matching `)` that was not quote aware stops at the one
 * inside `"a)b"` and reads the parameter list as `r ROW("a`.
 */
const CREATE_ROWPAREN = 'CREATE FUNCTION memory.app.rowparen(r ROW("a)b" bigint, c varchar))\nRETURNS bigint\nRETURN 1';
/** The first `(` in this statement is inside the quoted NAME, not the parameter list. */
const CREATE_WEIRD = 'CREATE FUNCTION memory.app."we(ird"(x bigint)\nRETURNS bigint\nRETURN x';
/**
 * A body carrying the word CREATE, verbatim from 476 (#789 Phase 3).
 *
 * The apply splices ` OR REPLACE` after the FIRST TOKEN, and this is the object that makes that
 * anchoring observable: a global replace of the word rewrites the literal in the body too.
 */
const CREATE_MENTIONS_CREATE =
  "CREATE FUNCTION memory.app.mentions_create(x bigint)\nRETURNS varchar\nRETURN 'CREATE TABLE'";
/**
 * The object OVER the source bound, rebuilt rather than pasted (#789 Phase 3).
 *
 * `docker/trino-init/01-object-fixture.sql` creates it and `SHOW CREATE FUNCTION` answered
 * 1,001,094 characters for it on trinodb/trino:476 on 2026-09-14. The text is generated here
 * because a megabyte of `DECIMAL '.1',` in a test file is unreadable and unreviewable, and the
 * assertion below pins the length the live coordinator produced, so a generator that drifted from
 * the fixture fails by number.
 */
function overLimitDefinition(): string {
  const elements = Array.from({ length: 77_000 }, () => "DECIMAL '.1'").join(",");
  return `CREATE FUNCTION memory.app.over_limit_fn(x bigint)\nRETURNS array(decimal(38, 1))\nRETURN ARRAY[${elements}]`;
}

/** One `SHOW CREATE` reply, in the shape the coordinator sends it. */
function sourceRows(column: string, definitions: readonly string[]): (id: string) => Reply {
  return rows(
    SOURCE_COLUMNS[column],
    definitions.map((definition) => [definition]),
  );
}

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
  // The bounded pair the conformance helper's bulk probe sends: a caller limit of 1 asks the
  // cluster for `LIMIT 2`, so the read itself says it stopped short.
  serveInstead(
    trinoObjectTargetSql(MEMORY_APP, "table", 2),
    rows(OBJECT_NAME_COLUMNS, [
      ["app", "customers"],
      ["app", "orders"],
    ]),
  );
  serveInstead(
    trinoBulkColumnsSql(MEMORY_APP, "table", 2),
    rows(BULK_COLUMN_COLUMNS, [
      ["app", "customers", "id", "bigint", "YES"],
      ["app", "customers", "name", "varchar", "YES"],
      ["app", "orders", "id", "bigint", "YES"],
      ["app", "orders", "customer_id", "bigint", "YES"],
      ["app", "orders", "total", "double", "YES"],
    ]),
  );
  serveInstead(trinoObjectTargetSql(MEMORY_APP, "view"), rows(OBJECT_NAME_COLUMNS, [["app", "customer_names"]]));
  serveInstead(
    trinoBulkColumnsSql(MEMORY_APP, "view"),
    rows(BULK_COLUMN_COLUMNS, [
      ["app", "customer_names", "id", "bigint", "YES"],
      ["app", "customer_names", "name", "varchar", "YES"],
    ]),
  );
  serveInstead(trinoObjectTargetSql(MEMORY_APP, TRINO_MATERIALIZED_VIEW_KIND), rows(OBJECT_NAME_COLUMNS, []));
  serveInstead(trinoBulkColumnsSql(MEMORY_APP, TRINO_MATERIALIZED_VIEW_KIND), rows(BULK_COLUMN_COLUMNS, []));

  // The flat reading for `memory`, which the conformance helper's join guard needs at the
  // container the contract now runs in.
  serveInstead(
    trinoTableListSql("memory"),
    rows(TABLE_LIST_COLUMNS, [
      ["app", "customer_names"],
      ["app", "customers"],
      ["app", "orders"],
    ]),
  );
  serveInstead(
    trinoColumnListSql("memory"),
    rows(COLUMN_LIST_COLUMNS, [
      ["app", "customer_names", "id", "bigint", "YES", null],
      ["app", "customer_names", "name", "varchar", "YES", null],
      ["app", "customers", "id", "bigint", "YES", null],
      ["app", "customers", "name", "varchar", "YES", null],
      ["app", "orders", "id", "bigint", "YES", null],
      ["app", "orders", "customer_id", "bigint", "YES", null],
      ["app", "orders", "total", "double", "YES", null],
    ]),
  );

  serveSourceReads();
}

/**
 * The source reads (#789), keyed on the exported statement each one sends.
 *
 * Registered by object and never by fragment, so a `SHOW CREATE VIEW` cannot be answered a
 * `SHOW CREATE TABLE`'s page: the four forms differ only in a keyword mid-statement, which is
 * exactly the shape `serveInstead` exists for.
 */
function serveSourceReads(): void {
  const at = (kind: string, catalog: string, schema: string, name: string): string =>
    trinoObjectSourceSql(trinoSourceStatementFor(kind), catalog, schema, name);

  serveInstead(at("table", "memory", "app", "customers"), sourceRows("Create Table", [CREATE_CUSTOMERS]));
  serveInstead(at("table", "memory", "app", "orders"), sourceRows("Create Table", [CREATE_ORDERS]));
  serveInstead(at("view", "memory", "app", "customer_names"), sourceRows("Create View", [CREATE_CUSTOMER_NAMES]));
  serveInstead(
    at(TRINO_MATERIALIZED_VIEW_KIND, "iceberg", "warehouse", "order_totals"),
    sourceRows("Create Materialized View", [CREATE_ORDER_TOTALS]),
  );
  // ONE statement, TWO rows, and the one the caller did not ask for comes back first.
  serveInstead(
    at("function", "memory", "app", "plus_one"),
    sourceRows("Create Function", [CREATE_PLUS_ONE_DOUBLE, CREATE_PLUS_ONE_BIGINT]),
  );
  serveInstead(at("function", "memory", "app", "hard"), sourceRows("Create Function", [CREATE_HARD]));
  serveInstead(at("function", "memory", "app", "answer"), sourceRows("Create Function", [CREATE_ANSWER]));
  serveInstead(at("function", "memory", "app", "rowparen"), sourceRows("Create Function", [CREATE_ROWPAREN]));
  serveInstead(at("function", "memory", "app", "we(ird"), sourceRows("Create Function", [CREATE_WEIRD]));
  serveInstead(
    at("function", "memory", "app", "mentions_create"),
    sourceRows("Create Function", [CREATE_MENTIONS_CREATE]),
  );
  serveInstead(
    at("function", "memory", "app", "over_limit_fn"),
    sourceRows("Create Function", [overLimitDefinition()]),
  );

  // The two ABSENCES, each carrying the engine's own verbatim refusal rather than a page the
  // provider would then have to interpret. Both were measured on 476 on 2026-09-13.
  serveInstead(
    at("table", "memory", "app", "no_such_table"),
    refusal({
      message: "line 1:1: Table 'memory.app.no_such_table' does not exist",
      errorCode: 44,
      errorName: "TABLE_NOT_FOUND",
      errorType: "USER_ERROR",
      errorLocation: { lineNumber: 1, columnNumber: 1 },
    }),
  );
  serveInstead(
    at("table", "memory", "app", "customer_names"),
    refusal({
      message: "line 1:1: Relation 'memory.app.customer_names' is a view, not a table",
      errorCode: 44,
      errorName: "TABLE_NOT_FOUND",
      errorType: "USER_ERROR",
      errorLocation: { lineNumber: 1, columnNumber: 1 },
    }),
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

  /**
   * The shared contract, run in `memory.app` rather than in a catalog (#789).
   *
   * The container is NAMED, and it has to be, because `function` gained `hasSource`. A
   * catalog-level function count is `{ unavailable }` by design here - `SHOW FUNCTIONS` takes
   * a schema and cannot be aggregated - and a `hasSource` kind answering that arm is a dead
   * end the helper itself names: naming the kind throws on the unavailable count and omitting
   * it throws as unexercised. The engine's honest answer is a real number one level down.
   */
  test("satisfies the shared object surface contract", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });

    await assertObjectSurface(provider, {
      containers: FIXTURE_CATALOGS,
      container: ["memory", "app"],
      kinds: { table: 2, view: 1, function: 9, materialized_view: 0 },
      sampleObject: { path: ["memory", "app", "orders"], kind: "table" },
      emptyKinds: {
        // THIS DEPLOYMENT CANNOT HOLD ONE, which is the stronger of the two absences the
        // helper asks to be told apart, and it is measured rather than assumed. A
        // materialized view needs an Iceberg catalog, and on 476 only a HIVE-METASTORE-backed
        // one will create it: probed for #789 on 2026-09-13 against a fully working Iceberg
        // JDBC catalog on a PostgreSQL 18 - schema created, table created, two rows inserted
        // - `CREATE MATERIALIZED VIEW` still answered
        // `createMaterializedView is not supported for Iceberg JDBC catalogs`. The compose
        // cluster configures no Iceberg catalog at all, so `memory.app` holds none and no
        // container on it can. docs/providers/trino.md carries the commands that build a
        // cluster which can.
        materialized_view:
          "The compose cluster configures no Iceberg catalog, and a materialized view needs one: " +
          "measured on 476, the Iceberg JDBC and REST catalog types both refuse createMaterializedView " +
          "and only a Hive-metastore-backed Iceberg catalog creates one.",
      },
      // An authored path whose last segment names nothing, under a kind the source loop
      // really read, so the raise it drives has a positive control. Measured on 476, the
      // engine's own sentence is `Table 'memory.app.no_such_table' does not exist`.
      absentSource: { path: ["memory", "app", "no_such_table"], kind: "table" },
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
      function: { count: 9 },
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
      { path: ["memory", "app", "answer()"], name: "answer", kind: "function" },
      {
        path: ["memory", "app", 'hard(decimal(10,2), array(varchar), row("a" bigint,"b" varchar))'],
        name: "hard",
        kind: "function",
      },
      { path: ["memory", "app", "label(bigint, varchar)"], name: "label", kind: "function" },
      { path: ["memory", "app", "mentions_create(bigint)"], name: "mentions_create", kind: "function" },
      { path: ["memory", "app", "over_limit_fn(bigint)"], name: "over_limit_fn", kind: "function" },
      { path: ["memory", "app", "plus_one(bigint)"], name: "plus_one", kind: "function" },
      { path: ["memory", "app", "plus_one(double)"], name: "plus_one", kind: "function" },
      {
        path: ["memory", "app", 'rowparen(row("a)b" bigint,"c" varchar))'],
        name: "rowparen",
        kind: "function",
      },
      // The name's own parenthesis is carried into the segment untouched, so the FIRST `(`
      // here belongs to the name and the last `)` closes the argument list.
      { path: ["memory", "app", "we(ird(bigint)"], name: "we(ird", kind: "function" },
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
    // Cast, because `ContainerLevels` is a two-level tuple union since #789 and a third level
    // is now a compile error where a provider would write one. The RUNTIME rule is what this
    // pins, and it has to be reachable from a declaration the type forbids.
    withLevels(provider, [
      { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
      { id: "schema", label: "Schema", labelPlural: "Schemas" },
      { id: "schema", label: "Sub-schema", labelPlural: "Sub-schemas" },
    ] as unknown as ProviderCapabilities["containerLevels"]);

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

/**
 * The source read (#789).
 *
 * Every payload these drive was captured verbatim from a live trinodb/trino:476 on
 * 2026-09-13 after applying `docker/trino-init/01-object-fixture.sql`, plus one materialized
 * view built on the Hive-metastore cluster `docs/providers/trino.md` writes out in full,
 * because the compose cluster cannot hold one.
 *
 * The population of every per-kind assertion below comes from the DECLARATION and never from
 * a number typed here: a wrong reply column reads as `undefined`, the provider correctly
 * turns that into a REFUSAL, and a refusal passes the conformance walk, passes a
 * whole-statement pin and passes every count and length assertion. So the text itself is
 * pinned per kind, over the kinds `getCapabilities()` says are readable.
 */
describe("Trino object source", () => {
  /** Every source-bearing kind the declaration holds, with the first object of each. */
  const FIXTURE_SOURCES: { kind: string; path: readonly string[]; definition: string }[] = [
    { kind: "table", path: ["memory", "app", "customers"], definition: CREATE_CUSTOMERS },
    { kind: "view", path: ["memory", "app", "customer_names"], definition: CREATE_CUSTOMER_NAMES },
    {
      kind: "materialized_view",
      path: ["iceberg", "warehouse", "order_totals"],
      definition: CREATE_ORDER_TOTALS,
    },
    { kind: "function", path: ["memory", "app", "plus_one(bigint)"], definition: CREATE_PLUS_ONE_BIGINT },
  ];

  test("declares source on exactly the kinds that have a definition text", () => {
    const kinds = new TrinoProvider(makeConnection()).getCapabilities().objectKinds ?? [];
    const declared = kinds
      .filter((kind) => kind.hasSource === true)
      .map((kind) => [kind.id, kind.sourceLanguage] as const)
      .sort();

    // All four, all `sql`. Every one of them is read with a `SHOW CREATE` form that answers a
    // runnable Trino statement, so there is no kind here whose text is a body or a fragment.
    expect(declared).toEqual([
      ["function", "sql"],
      ["materialized_view", "sql"],
      ["table", "sql"],
      ["view", "sql"],
    ]);
    // The other direction, so a kind added later cannot quietly gain a Source tab. Trino
    // declares NO kind without a definition text: there is no `index`, no `trigger` and no
    // `procedure` in its model at all.
    expect(
      kinds
        .filter((kind) => kind.hasSource !== true)
        .map((kind) => kind.id)
        .sort(),
    ).toEqual([]);
  });

  /**
   * The population is the DECLARATION's, so a kind that gains `hasSource` without a fixture
   * entry fails here by name rather than going unread.
   */
  test("the fixture holds an object of every source-bearing kind", () => {
    const declared = (new TrinoProvider(makeConnection()).getCapabilities().objectKinds ?? [])
      .filter((kind) => kind.hasSource === true)
      .map((kind) => kind.id)
      .sort();

    expect(FIXTURE_SOURCES.map((entry) => entry.kind).sort()).toEqual(declared);
  });

  test.each(FIXTURE_SOURCES)(
    "reads the whole definition of a $kind, and says what the text is",
    async ({ kind, path, definition }) => {
      const provider = await objectProvider({ database: "memory", schema: "app" });
      const document = await provider.readObjectSource!(path, kind);

      expect(document.path).toEqual([...path]);
      expect(document.kind).toBe(kind);
      expect(document.parts).toHaveLength(1);
      const [part] = document.parts;
      expect(isSourcePartUnavailable(part)).toBe(false);
      if (isSourcePartUnavailable(part)) throw new Error("narrowing");
      // THE WHOLE TEXT, byte for byte, and not a distinctive substring. A wrong reply column
      // reads as `undefined` and becomes a refusal, which the narrowing above catches; a
      // reply column that is right but a statement that is wrong answers ANOTHER object's
      // definition, which only the whole text can see.
      expect(part.text).toBe(definition);
      expect(part.language).toBe("sql");
      // Every `SHOW CREATE` form answers a statement that runs as given, so none of them is
      // `partial`; and none of them is the author's own bytes, so none is `stored`. The view
      // is the proof of the second: the fixture never wrote `SECURITY DEFINER`.
      expect(part.form).toBe("complete");
      expect(part.origin).toBe("regenerated");
      expect(part.truncated).toBeUndefined();
    },
  );

  test("the part's label is the engine's own name for the column it came from", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });
    const labels = [];
    for (const { kind, path } of FIXTURE_SOURCES) {
      labels.push([kind, (await provider.readObjectSource!(path, kind)).parts[0].label]);
    }

    // Not a friendlier word of this product's own: `SHOW CREATE` is a statement rather than a
    // projection, so these names cannot be aliased and they are what the engine calls the
    // text. Binding the label to the same constant the READ keys on also makes a wrong reply
    // column visible, instead of it turning a definition into a refusal in silence.
    expect(labels).toEqual([
      ["table", "Create Table"],
      ["view", "Create View"],
      ["materialized_view", "Create Materialized View"],
      ["function", "Create Function"],
    ]);
  });

  test("sends the three-part name with every segment quoted, per kind", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });
    for (const { kind, path } of FIXTURE_SOURCES) {
      await provider.readObjectSource!(path, kind);
    }

    // The statement whole, per kind, and not a token out of it. The name is an IDENTIFIER
    // position with no bind channel on this transport at all, so the quoting is the only
    // thing between a caller-supplied segment and statement text.
    expect(sqlWith("SHOW CREATE TABLE")).toBe('SHOW CREATE TABLE "memory"."app"."customers"');
    expect(sqlWith("SHOW CREATE VIEW")).toBe('SHOW CREATE VIEW "memory"."app"."customer_names"');
    expect(sqlWith("SHOW CREATE MATERIALIZED VIEW")).toBe(
      'SHOW CREATE MATERIALIZED VIEW "iceberg"."warehouse"."order_totals"',
    );
    // The BARE name, never the segment: `SHOW CREATE FUNCTION` takes a name and answers one
    // row per overload.
    expect(sqlWith("SHOW CREATE FUNCTION")).toBe('SHOW CREATE FUNCTION "memory"."app"."plus_one"');
  });

  test("a name holding a double quote cannot close the identifier it is inside", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });

    await provider.readObjectSource!(["memory", "app", 'ev"il'], "table").catch(() => undefined);

    expect(sqlWith("SHOW CREATE TABLE")).toBe('SHOW CREATE TABLE "memory"."app"."ev""il"');
  });

  // --------------------------------------------------------------------------
  // Overload resolution
  // --------------------------------------------------------------------------

  test("picks the overload the path names, which is NOT the first row the engine sent", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });

    // Measured on 476: `SHOW CREATE FUNCTION memory.app.plus_one` answers the DOUBLE overload
    // first and the BIGINT one second, so a provider taking `rows[0]` would hand every caller
    // of `plus_one(bigint)` the other function's body.
    const bigint = await provider.readObjectSource!(["memory", "app", "plus_one(bigint)"], "function");
    const double = await provider.readObjectSource!(["memory", "app", "plus_one(double)"], "function");

    expect((bigint.parts[0] as { text: string }).text).toBe(CREATE_PLUS_ONE_BIGINT);
    expect((double.parts[0] as { text: string }).text).toBe(CREATE_PLUS_ONE_DOUBLE);
  });

  test("matches an overload whose two renderings are not the same text", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });
    const segment = 'hard(decimal(10,2), array(varchar), row("a" bigint,"b" varchar))';

    const document = await provider.readObjectSource!(["memory", "app", segment], "function");

    // The whole point of the signature form. `SHOW FUNCTIONS` renders this overload as
    // `decimal(10,2), array(varchar), row("a" bigint,"b" varchar)` and `SHOW CREATE FUNCTION`
    // renders the SAME overload as
    // `amount decimal(10, 2), tags array(varchar), r ROW(a bigint, b varchar)`: a space, a
    // case change and a quoting change, all in one signature.
    expect((document.parts[0] as { text: string }).text).toBe(CREATE_HARD);
    expect(CREATE_HARD).toContain("ROW(a bigint, b varchar)");
    expect(segment).toContain('row("a" bigint,"b" varchar)');
  });

  test("matches the empty argument list and a name whose first parenthesis is its own", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });

    expect(
      ((await provider.readObjectSource!(["memory", "app", "answer()"], "function")).parts[0] as { text: string }).text,
    ).toBe(CREATE_ANSWER);
    // `we(ird(bigint)`: the first `(` belongs to the NAME on both sides of the comparison, so
    // a scan that was not quote aware would read the parameter list as `ird"(x bigint`.
    expect(
      ((await provider.readObjectSource!(["memory", "app", "we(ird(bigint)"], "function")).parts[0] as { text: string })
        .text,
    ).toBe(CREATE_WEIRD);
  });

  test("matches an overload whose ROW field name holds a close parenthesis", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });

    // The object that proves both quote-aware scans are load-bearing. Measured on 476: a
    // top-level PARAMETER name may be quoted but may hold no space, comma or parenthesis -
    // all three are refused at creation with a bare `Internal error` - while a ROW FIELD name
    // may hold all of them, and this one round-trips. Without it in the fixture, deleting the
    // quote awareness left the whole suite green.
    const document = await provider.readObjectSource!(
      ["memory", "app", 'rowparen(row("a)b" bigint,"c" varchar))'],
      "function",
    );

    expect((document.parts[0] as { text: string }).text).toBe(CREATE_ROWPAREN);
    expect(trinoCreateSignature(CREATE_ROWPAREN)).toBe("row(a)bbigint,cvarchar)");
  });

  test("the signature form is what the two renderings agree on, and nothing more", () => {
    // Pinned directly as well as through the reads above, because this is the derivation the
    // whole function read rests on and the reads would still pass if it were accidentally
    // an identity on the fixture's simpler overloads.
    expect(trinoArgumentSignature('decimal(10,2), array(varchar), row("a" bigint,"b" varchar)')).toBe(
      "decimal(10,2),array(varchar),row(abigint,bvarchar)",
    );
    expect(trinoCreateSignature(CREATE_HARD)).toBe("decimal(10,2),array(varchar),row(abigint,bvarchar)");
    expect(trinoArgumentSignature("")).toBe("");
    expect(trinoCreateSignature(CREATE_ANSWER)).toBe("");
    expect(trinoCreateSignature(CREATE_WEIRD)).toBe("bigint");
    expect(trinoCreateSignature(CREATE_PLUS_ONE_DOUBLE)).toBe("double");
    // A reply value that is not text, and a statement with no parameter list at all, are both
    // "no signature" rather than an empty one: an empty signature is the zero-argument
    // function, and conflating the two would match `answer()` to a row that is not a function.
    expect(trinoCreateSignature(42)).toBeNull();
    expect(trinoCreateSignature("CREATE FUNCTION memory.app.broken")).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Absence RAISES, and only the translation failure refuses
  // --------------------------------------------------------------------------

  test("an object that is not there RAISES, naming the segment, and never answers a refusal", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });

    await expect(provider.readObjectSource!(["memory", "app", "no_such_table"], "table")).rejects.toThrow(
      "Table 'memory.app.no_such_table' does not exist",
    );
    // A relation of the WRONG kind is absence too, and the engine says which: measured on
    // 476, `SHOW CREATE TABLE` on a view answers "is a view, not a table".
    await expect(provider.readObjectSource!(["memory", "app", "customer_names"], "table")).rejects.toThrow(
      "is a view, not a table",
    );
  });

  test("a function segment no listing reconstructs RAISES naming the segment", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });

    // The engine's own sentence would not do here. Measured on 476, `SHOW CREATE FUNCTION`
    // answers the bare `Function not found`, which names neither the function nor the schema.
    await expect(provider.readObjectSource!(["memory", "app", "plus_one(varchar)"], "function")).rejects.toThrow(
      "No Trino function plus_one(varchar) in memory.app",
    );
    // And it never reached `SHOW CREATE FUNCTION` at all: the listing already said so.
    expect(sentAnything("SHOW CREATE FUNCTION")).toBe(false);
  });

  test("a Hive view that cannot be translated is a REFUSAL carrying the engine's own sentence", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });
    // DOCUMENTED AND NOT MEASURED ON THIS CLUSTER, stated in advance rather than reported
    // around: reaching a Hive-NATIVE view needs a `hive` connector catalog holding a view
    // that Hive itself created, which `database-compose.yml` does not configure and which no
    // statement this provider can send will produce. The sentence is Trino's own
    // `HIVE_VIEW_TRANSLATION_ERROR` message, and the branch is keyed on that fault NAME
    // rather than on the wording: see the two tests below it.
    const sentence =
      "Failed to translate Hive view 'legacy.daily_totals': line 1:8: mismatched input 'FROM'. Expecting: '.', 'AS'";
    serveInstead(
      trinoObjectSourceSql(trinoSourceStatementFor("view"), "memory", "app", "customer_names"),
      refusal({ message: sentence, errorCode: 65551, errorName: "HIVE_VIEW_TRANSLATION_ERROR", errorType: "EXTERNAL" }),
    );

    const document = await provider.readObjectSource!(["memory", "app", "customer_names"], "view");

    expect(document.parts).toHaveLength(1);
    const [part] = document.parts;
    expect(isSourcePartUnavailable(part)).toBe(true);
    if (!isSourcePartUnavailable(part)) throw new Error("narrowing");
    // UNPREFIXED, so the engine's words reach the reader rather than this product's.
    expect(part.unavailable).toBe(sentence);
    // A refusal part carrying a TEXT as well would narrow to this arm and satisfy the
    // assertion above while putting the refusal over a definition the engine returned. The
    // union does not make that shape a compile error (#789), so it is asserted.
    expect(Object.hasOwn(part, "text")).toBe(false);
  });

  /**
   * The SAME refusal, with the coordinator's source-location prefix on the message (#789).
   *
   * The wording of a Trino failure message is NOT a stable shape, and this file's own
   * verbatim 476 captures are the proof: `line 1:1: mismatched input 'SELEKT'.`,
   * `line 1:15: Catalog 'nosuchcat' not found` and
   * `line 1:1: Table 'memory.app.no_such_table' does not exist` all carry the location the
   * analyzer attached, while `This connector does not support creating tables` and
   * `Query was canceled` are bare. Which shape a message takes is a property of WHERE the
   * throw came from, and the Hive-native view is the one branch here that cannot be reached
   * on any cluster this repository can start, so that property is unmeasurable for it.
   *
   * `errorName` is not unmeasurable. It is on the wire on every failure, the transport
   * already parses it into `TrinoTransportError.code`, and it does not move when a release
   * rewords a sentence or when the analyzer prepends a location. So the branch is keyed on
   * the fault NAME and the engine's sentence is carried through whichever shape it arrives
   * in.
   */
  test("the translation refusal survives a message the coordinator prefixed with a location", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });
    const sentence = "line 1:1: Failed to translate Hive view 'legacy.daily_totals': line 1:8: mismatched input 'FROM'";
    serveInstead(
      trinoObjectSourceSql(trinoSourceStatementFor("view"), "memory", "app", "customer_names"),
      refusal({ message: sentence, errorCode: 65551, errorName: "HIVE_VIEW_TRANSLATION_ERROR", errorType: "EXTERNAL" }),
    );

    const document = await provider.readObjectSource!(["memory", "app", "customer_names"], "view");

    const [part] = document.parts;
    if (!isSourcePartUnavailable(part)) throw new Error("narrowing");
    expect(part.unavailable).toBe(sentence);
    expect(Object.hasOwn(part, "text")).toBe(false);
  });

  test("a failure that only READS like the translation one still RAISES, because its fault name differs", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });
    // The control the assertion above owes. A branch keyed on the fault name must refuse a
    // message wearing the same words under another name, or the two tests together would
    // pass for an implementation that answers a refusal to everything.
    serveInstead(
      trinoObjectSourceSql(trinoSourceStatementFor("view"), "memory", "app", "customer_names"),
      refusal({
        message: "Failed to translate Hive view 'legacy.daily_totals': the metastore is unreachable",
        errorCode: 65536,
        errorName: "HIVE_METASTORE_ERROR",
        errorType: "EXTERNAL",
      }),
    );

    await expect(provider.readObjectSource!(["memory", "app", "customer_names"], "view")).rejects.toThrow(
      "the metastore is unreachable",
    );
  });

  test("a reply that is not a definition is a refusal that says which shape it was", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });
    const statement = trinoObjectSourceSql(trinoSourceStatementFor("table"), "memory", "app", "customers");

    for (const [value, expected] of [
      ["   \n  ", "with a text holding nothing but whitespace"],
      [42, "as number rather than as text"],
      [null, "as null rather than as text"],
    ] as const) {
      serveInstead(statement, rows(SOURCE_COLUMNS["Create Table"], [[value]]));
      const document = await provider.readObjectSource!(["memory", "app", "customers"], "table");
      const [part] = document.parts;
      if (!isSourcePartUnavailable(part)) throw new Error(`expected a refusal for ${String(value)}`);
      expect(part.unavailable).toContain(expected);
      // Names the column AND the statement form, so a refusal caused by a wrong reply column
      // reads as the mistake it is rather than as a fact about the object.
      expect(part.unavailable).toContain('the "Create Table" column of SHOW CREATE TABLE for customers');
      expect(Object.hasOwn(part, "text")).toBe(false);
    }
  });

  test("a statement answering no row at all RAISES rather than answering an empty document", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });
    serveInstead(
      trinoObjectSourceSql(trinoSourceStatementFor("table"), "memory", "app", "customers"),
      rows(SOURCE_COLUMNS["Create Table"], []),
    );

    await expect(provider.readObjectSource!(["memory", "app", "customers"], "table")).rejects.toThrow(
      "No Trino table named customers in memory.app",
    );
  });

  // --------------------------------------------------------------------------
  // The bound
  // --------------------------------------------------------------------------

  test("a caller's bound cuts the text and is reported with the caller's own number", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });

    const document = await provider.readObjectSource!(["memory", "app", "customers"], "table", 12);

    const [part] = document.parts;
    if (isSourcePartUnavailable(part)) throw new Error("narrowing");
    expect(part.text).toBe(CREATE_CUSTOMERS.slice(0, 12));
    expect(part.truncated?.limit).toBe(12);
    // And an unbounded read of the same object reports nothing, so the mark is never on a
    // text that was read whole.
    const whole = await provider.readObjectSource!(["memory", "app", "customers"], "table");
    expect((whole.parts[0] as { truncated?: unknown }).truncated).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // The derivations, which no fixture of this engine's own shape can distinguish
  // --------------------------------------------------------------------------

  test("derives the object name and the container from the DECLARATION, not from a position", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });
    const real = provider.getCapabilities();
    const spy = spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      containerLevels: [
        { id: "catalog", label: "Database", labelPlural: "Databases" },
        { id: "schema", label: "Namespace", labelPlural: "Namespaces" },
      ],
    });

    try {
      await provider.readObjectSource!(["cat", "sch", "obj"], "table").catch(() => undefined);
      expect(sqlWith("SHOW CREATE TABLE")).toBe('SHOW CREATE TABLE "cat"."sch"."obj"');
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * The SAME derivation against a declaration whose two levels are SWAPPED.
   *
   * The test above cannot kill a hardcoded `catalog = path[0]`, because Trino's real
   * declaration is already catalog-then-schema and the swapped-in one matches it. This one
   * can: the levels are declared schema first, the path is fed in that order, and the same
   * three values must still reach the server in the server's own order.
   */
  test("reads each container segment by its declared LEVEL, not by its position in the path", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });
    const real = provider.getCapabilities();
    const spy = spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      containerLevels: [
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
        { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
      ],
    });

    try {
      await provider.readObjectSource!(["sch", "cat", "obj"], "table").catch(() => undefined);
      // `cat` is the CATALOG because the declaration says the second level is the catalog,
      // and it reaches the statement's first position because that is where Trino's three-part
      // name puts a catalog.
      expect(sqlWith("SHOW CREATE TABLE")).toBe('SHOW CREATE TABLE "cat"."sch"."obj"');
    } finally {
      spy.mockRestore();
    }
  });

  test("refuses a kind it does not declare, a kind with no source, and a kind with no language", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });
    const real = provider.getCapabilities();

    await expect(provider.readObjectSource!(["memory", "app", "x"], "trigger")).rejects.toThrow(
      'Trino declares no object kind "trigger"',
    );

    const noSource = spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
    });
    await expect(provider.readObjectSource!(["memory", "app", "customers"], "table")).rejects.toThrow(
      'Trino publishes no definition text for the kind "table"',
    );
    noSource.mockRestore();

    // An unregistered or absent Monaco id degrades to plain text with no throw and nothing
    // observable, so a kind declaring source and no language would ship a Source tab that
    // silently stopped highlighting.
    const noLanguage = spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasSource: true }],
    });
    // The engine's name is part of the refusal and it now reaches the shared guard as an argument
    // (#789), so a provider passing the wrong literal would attribute Trino's refusal to another
    // engine. Pin it here as well as on the two arms above.
    await expect(provider.readObjectSource!(["memory", "app", "customers"], "table")).rejects.toThrow(
      'Trino declares readable source for the kind "table" and no sourceLanguage to render it with',
    );
    noLanguage.mockRestore();
  });

  test("a source-bearing kind with no SHOW CREATE form of its own is refused by name", async () => {
    const provider = await objectProvider({ database: "memory", schema: "app" });
    const real = provider.getCapabilities();
    const spy = spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      objectKinds: [
        {
          id: "sequence",
          role: "relation",
          label: "Sequence",
          labelPlural: "Sequences",
          hasSource: true,
          sourceLanguage: "sql",
        },
      ],
    });

    try {
      await expect(provider.readObjectSource!(["memory", "app", "s"], "sequence")).rejects.toThrow(
        'Trino declares readable source for the kind "sequence" and no SHOW CREATE form for it',
      );
    } finally {
      spy.mockRestore();
    }

    // `Object.hasOwn` and not `in`: a kind id is an OPEN string, so `in` walks the prototype
    // chain and a DECLARED kind spelled `toString` would be accepted as readable, reaching a
    // statement built from a function off `Object.prototype`. The kind has to be declared to
    // get here at all, which is what the first spy above could not do.
    const prototypeKind = spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      objectKinds: [
        {
          id: "toString",
          role: "relation",
          label: "To String",
          labelPlural: "To Strings",
          hasSource: true,
          sourceLanguage: "sql",
        },
      ],
    });
    try {
      await expect(provider.readObjectSource!(["memory", "app", "s"], "toString")).rejects.toThrow(
        'Trino declares readable source for the kind "toString" and no SHOW CREATE form for it',
      );
      expect(sentAnything("SHOW CREATE")).toBe(false);
    } finally {
      prototypeKind.mockRestore();
    }
  });
});

/**
 * Every function COUNT this engine's shipped files state, checked against the fixture that
 * decides it (#789).
 *
 * WHY THIS GUARD EXISTS. Three shipped files carried the sentence "`system.jdbc.procedures`
 * answers zero rows for a schema holding three functions". It was true when `memory.app`
 * held three functions and this task's own fixture work made it false by adding four more,
 * so one shipped document contradicted itself: `docs/providers/trino.md` said three in one
 * paragraph and seven in another. A reviewer found two of the three by grep and missed the
 * third, because a docblock wraps `three\n * functions` across a line and no grep for
 * "three functions" can see it. That is the whole reason this is a test rather than a
 * careful read: the population is every file the engine ships, the number is derived from
 * the fixture, and a line wrap does not hide anything from it.
 *
 * The rule it enforces is the ledger's standing remedy for a stale numeral, which is to fix
 * what the numeral COUNTS rather than the digit. A sentence in one of these files that
 * counts functions must count the fixture's functions. If you need to count something else,
 * name that thing instead: "two overloads", "three parameters", "four reply columns".
 */
describe("Trino function counts stated in shipped files", () => {
  const TRINO_FIXTURE_FILE = join(import.meta.dir, "..", "..", "..", "docker", "trino-init", "01-object-fixture.sql");
  const TRINO_PROVIDER_DIR = join(import.meta.dir, "..", "..", "..", "src", "lib", "db", "providers", "sql", "trino");
  const TRINO_PROVIDER_DOC = join(import.meta.dir, "..", "..", "..", "docs", "providers", "trino.md");

  /** Spelled-out numbers, because prose in this repository writes a small count as a word. */
  const NUMBER_WORDS: Record<string, number> = {
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };

  /**
   * A claim wrapped across two lines is still one claim.
   *
   * A TypeScript docblock continues with ` * `, a SQL comment with `-- ` and Markdown with
   * nothing at all, so all three continuations collapse to a single space before the scan.
   * Without this the guard is blind to exactly the instance the reviewer's grep missed.
   */
  function flatten(text: string): string {
    return text.replace(/\r?\n[ \t]*(\*|--|\/\/)?[ \t]*/g, " ");
  }

  function countClaims(text: string): { phrase: string; count: number }[] {
    // Up to two words may sit between the number and the noun, because a claim is written
    // "three functions" in one file and "Three catalog-stored functions" in another. Measured
    // over this engine's whole corpus, the wider form adds no false positive and adds the one
    // claim the narrow form missed.
    const pattern =
      /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:[A-Za-z-]+\s+){0,2}functions?\b/gi;
    return [...flatten(text).matchAll(pattern)].map((match) => {
      const token = match[1].toLowerCase();
      const count = Object.hasOwn(NUMBER_WORDS, token) ? NUMBER_WORDS[token] : Number(token);
      return { phrase: match[0], count };
    });
  }

  test("no shipped file states a function count the fixture does not hold", () => {
    const fixture = readFileSync(TRINO_FIXTURE_FILE, "utf8");
    // Statements only. `SHOW CREATE FUNCTION` appears several times in this file's own
    // comments, and counting those would make the fixture disagree with itself.
    const created = fixture.split(/\r?\n/).filter((line) => /^CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i.test(line));
    if (created.length === 0) {
      throw new Error(
        "docker/trino-init/01-object-fixture.sql creates no function, so this guard would certify every count as correct",
      );
    }
    // The served rows are the fake's copy of the same fixture (standing ruling 5i): if they
    // drift apart, every count assertion below is measuring the wrong cluster.
    expect(MEMORY_APP_FUNCTION_ROWS).toHaveLength(created.length);

    const shipped = readdirSync(TRINO_PROVIDER_DIR)
      .filter((entry) => entry.endsWith(".ts"))
      .map((entry) => ({ name: `src/lib/db/providers/sql/trino/${entry}`, path: join(TRINO_PROVIDER_DIR, entry) }));
    if (shipped.length === 0) {
      throw new Error("no Trino provider source file was scanned, so this guard read nothing");
    }
    const scanned = [
      ...shipped,
      { name: "docs/providers/trino.md", path: TRINO_PROVIDER_DOC },
      { name: "docker/trino-init/01-object-fixture.sql", path: TRINO_FIXTURE_FILE },
    ];

    const wrong: string[] = [];
    const claims: string[] = [];
    for (const file of scanned) {
      for (const claim of countClaims(readFileSync(file.path, "utf8"))) {
        claims.push(`${file.name}: ${claim.phrase}`);
        if (claim.count !== created.length) wrong.push(`${file.name}: ${claim.phrase}`);
      }
    }

    expect(wrong).toEqual([]);
    // The inventory, so the guard cannot go quiet. A claim that disappears is as visible
    // here as a claim that arrives, and a run that matched nothing at all fails by name
    // rather than passing over an empty loop.
    expect(claims).toEqual(["docs/providers/trino.md: nine functions"]);
  });
});

// ============================================================================
// The object edit (#789 Phase 3)
// ----------------------------------------------------------------------------
// Every behaviour asserted below was measured on a live trinodb/trino:476 on 2026-09-14,
// against the `memory` catalog `docker/trino-init/01-object-fixture.sql` seeds, and the
// measurements are recorded beside the assertions that carry them rather than in a heading:
//
//   * `CREATE OR REPLACE FUNCTION` with a changed BODY replaces the addressed overload and
//     the re-read comes back byte-identical to what was sent minus ` OR REPLACE`;
//   * a changed RETURN TYPE and a renamed PARAMETER are both replaced IN PLACE, so only the
//     ARGUMENT TYPE LIST forks, and a fork leaves three rows where there were two;
//   * a FAILED replace leaves the previous object byte-identical, with no transaction;
//   * `SECURITY DEFINER` is in a view's read text although the fixture never typed it, which
//     is why the header is SPLICED and never ASSEMBLED;
//   * the `memory` connector answers `NOT_SUPPORTED`, errorCode 13, for
//     `CREATE OR REPLACE MATERIALIZED VIEW` ("This connector does not support creating
//     materialized views") and for `CREATE OR REPLACE TABLE` ("This connector does not
//     support replacing tables");
//   * a body error's `errorLocation` is `line 3:8` BOTH bare and spliced, which is what makes
//     "subtract eleven columns from every line" wrong and the offset conversion right.
// ============================================================================

const EDIT_KIND = "function";
const EDIT_PATH: readonly string[] = ["memory", "app", "plus_one(bigint)"];
/** The bigint overload's definition, verbatim from 476. The formatter parenthesises the body. */
const READ_TEXT = CREATE_PLUS_ONE_BIGINT;
const EDITED = READ_TEXT.replace("RETURN (x + 1)", "RETURN (x + 2)");
/** What the apply sends: eleven characters spliced in after the first token and nothing else. */
const PLAN_TEXT = `${EDITED.slice(0, 6)} OR REPLACE${EDITED.slice(6)}`;
/**
 * A LEGITIMATE edit the formatter canonicalizes straight back to the pre-image.
 *
 * MEASURED on trinodb/trino:476 on 2026-09-14, container `libredb-trino-t08fix`, host port 18509:
 * with `plus_one(x bigint)` in place, applying this text SUCCEEDED and `SHOW CREATE FUNCTION`
 * came back byte-identical to the pre-image, two rows before and two after. The comment is
 * dropped and the doubled parentheses and spaces are re-rendered, which is the same
 * canonicalization this file's identity docblock records. It is the population that made a
 * post-apply comparison of the two RENDERINGS report a successful in-place apply as a fork.
 */
const CANONICALIZED = READ_TEXT.replace(
  "RETURN (x + 1)",
  "RETURN ((x  +  1)) -- I reformatted this and added a comment",
);
/**
 * A header edit the identity reading calls harmless and the BYTES do not, which is the population
 * the post-apply control's own question is asked over.
 *
 * MEASURED on trinodb/trino:476 in container `trino-t32r1` on host port 18633 on 2026-09-15:
 * `CREATE OR REPLACE FUNCTION memory.app.plus_one(x BIGINT) RETURNS bigint RETURN x + 9` over
 * `plus_one(x bigint)` replaced it IN PLACE, one row before and one after, and `SHOW CREATE
 * FUNCTION` came back carrying the reader's own capitals while `SHOW FUNCTIONS` still published
 * `bigint`. So an unfolded type rendering is not a fork, and the control below is what asks the
 * engine whether this design is right about that for a given text.
 */
const RECASED = READ_TEXT.replace("(x bigint)", "(x BIGINT)").replace("RETURN (x + 1)", "RETURN (x + 9)");
/**
 * The same population on the NAME half, and it is the half a type-only shape cannot reach.
 *
 * Driven through the shipped provider against `trino-t32r1` on 2026-09-15: reading
 * `plus_one(bigint)`, re-casing the qualified name to `memory.app.PLUS_ONE` and applying answered
 * `{"outcome":"applied"}` and left ONE `plus_one` row, the engine echoing the reader's capitals
 * back in `SHOW CREATE FUNCTION`.
 */
const RECASED_NAME = READ_TEXT.replace("memory.app.plus_one", "memory.app.PLUS_ONE").replace(
  "RETURN (x + 1)",
  "RETURN (x + 4)",
);
/** The one edit that FORKS on 476, and the row the coordinator then answers for it, verbatim. */
const FORKING_TEXT = READ_TEXT.replace("(x bigint)", "(x varchar)").replace("RETURN (x + 1)", "RETURN (length(x) + 1)");
const CREATE_PLUS_ONE_VARCHAR =
  "CREATE FUNCTION memory.app.plus_one(x varchar)\nRETURNS bigint\nRETURN (length(x) + 1)";

/**
 * A fork whose parameter list is the fixture's own `hard` shape, verbatim from 476's formatter.
 *
 * The three places the two renderings of one signature DISAGREE are all in it: a space inside
 * `decimal(10, 2)`, `ROW` in upper case, and row-field names unquoted. That is what makes it the
 * one shape that can tell the comparison form apart from the rendering the statement declares,
 * which two `varchar`s cannot.
 */
const FORKING_HARD_TEXT = CREATE_HARD.replace("memory.app.hard(", "memory.app.plus_one(");
const SHOW_PLUS_ONE = trinoObjectSourceSql(trinoSourceStatementFor(EDIT_KIND), "memory", "app", "plus_one");

/**
 * A read text OVER the 1,000,000-character bound, in the shape this engine can actually
 * produce.
 *
 * THE BRIEF'S OWN `"x".repeat(1_000_001)` CANNOT REACH THE BOUND CHECK ON TRINO and that is a
 * property of the engine's overload resolution rather than of this test. `SHOW CREATE
 * FUNCTION` answers ONE ROW PER OVERLOAD and carries no argument-type column, so the row
 * belonging to a path segment is found by comparing the parameter list rendered inside each
 * CREATE statement; a reply with no parameter list at all matches no segment and the read
 * raises naming the segment BEFORE any bound is consulted. The test below drives the brief's
 * literal too, and pins that raise, so the divergence is asserted rather than hidden.
 *
 * The length is exactly 1,000,001, which is exactly one character past
 * `EDIT_CHARACTER_LIMIT`, and the shape is the one `over_limit_fn` produces on a live 476.
 */
const OVER_LIMIT_HEAD = "CREATE FUNCTION memory.app.plus_one(x bigint)\nRETURNS varchar\nRETURN '";
const OVER_LIMIT_TEXT = `${OVER_LIMIT_HEAD}${"x".repeat(1_000_001 - OVER_LIMIT_HEAD.length - 1)}'`;

/**
 * A definition whose PARAMETER LIST the server's own formatter splits across two lines.
 *
 * MEASURED on trinodb/trino:476 in container `trino-t32` on host port 18532 on 2026-09-15, and
 * every byte below is verbatim from `SHOW CREATE FUNCTION memory.app.nlrow`. It is created by
 *
 *   CREATE OR REPLACE FUNCTION memory.app.nlrow(r row("a<newline>b" bigint), y bigint)
 *     RETURNS bigint
 *     RETURN y;
 *
 * with a real newline inside the quoted ROW field name, and the coordinator accepts it.
 *
 * WHY THIS SHAPE AND NOT A LONG PARAMETER LIST. The brief for this repair expected the formatter
 * to WRAP a long list, and it does not: a function with 200 parameters and deliberately long
 * names answered 11,845 characters on ONE line on the same container. What splits a header is an
 * IDENTIFIER holding a newline, which the formatter renders verbatim between its quotes. So the
 * population exists, it is produced by the SERVER rather than by the reader, and the mechanism is
 * not the one that was expected.
 *
 * The object is NOT in `docker/trino-init/01-object-fixture.sql`: this task owns the provider and
 * this suite and not that file, and the statement above is recorded in its report so the fixture
 * can gain it in one pass with the count assertion beside it.
 */
const CREATE_NLROW = 'CREATE FUNCTION memory.app.nlrow(r ROW("a\nb" bigint), y bigint)\nRETURNS bigint\nRETURN y';
/** Its `SHOW FUNCTIONS` row, verbatim from the same container, and its path segment. */
const NLROW_FUNCTION_ROW: unknown[] = ["nlrow", "bigint", 'row("a\nb" bigint), bigint', "scalar", true, ""];
const NLROW_PATH: readonly string[] = ["memory", "app", 'nlrow(row("a\nb" bigint), bigint)'];

/**
 * THE FORK THE COMPARISON FORM CANNOT SEE: two objects whose renderings differ only INSIDE a
 * quoted identifier.
 *
 * Every byte below is verbatim from trinodb/trino:476 in container `trino-t32r1` on host port
 * 18633 on 2026-09-15, and the three pairs were all driven on that coordinator:
 *
 *   * `rowf(r row("a b" bigint))` and `rowf(r row("ab" bigint))` COEXIST, two rows in
 *     `SHOW FUNCTIONS FROM memory.app` where there was one, so deleting the space is a fork;
 *   * `rowf(r row("Ab" bigint))` beside `rowf(r row("ab" bigint))` COEXIST too, so the CASE of
 *     a quoted field name is part of the identity;
 *   * `dq(r row("a""b" bigint))` and `dq(r row(ab bigint))` COEXIST, so a doubled quote is one
 *     field named `a"b` and never two identifiers.
 *
 * `trinoNormalisedSignature` lower-cases each rendered type and strips every space and every
 * double quote, which is the only form the engine's TWO renderings of one signature agree on
 * and is therefore what the overload RESOLUTION must compare. It maps each pair above onto ONE
 * string, so an identity check built on it certifies nothing for any of them. Measured through
 * the shipped provider against that coordinator before this repair: reading
 * `rowf(row("a b" bigint))`, deleting the one space and applying answered
 * `{"outcome":"applied","revision":{"check":"compared","token":"7b3ae7ef25d1..."}}` and left TWO
 * `rowf` rows. The reader was told their edit had landed while the catalog had forked.
 *
 * The three objects are NOT in `docker/trino-init/01-object-fixture.sql`: this task owns the
 * provider and this suite and not that file, so they are served here and recorded in the report.
 */
const CREATE_ROWF_SPACED = 'CREATE FUNCTION memory.app.rowf(r ROW("a b" bigint))\nRETURNS bigint\nRETURN 1';
const ROWF_SPACED_ROW: unknown[] = ["rowf", "bigint", 'row("a b" bigint)', "scalar", true, ""];
const ROWF_SPACED_SEGMENT = 'rowf(row("a b" bigint))';
const CREATE_ROWF_QUOTED = 'CREATE FUNCTION memory.app.rowf(r ROW("ab" bigint))\nRETURNS bigint\nRETURN 2';
const ROWF_QUOTED_ROW: unknown[] = ["rowf", "bigint", 'row("ab" bigint)', "scalar", true, ""];
const ROWF_QUOTED_SEGMENT = 'rowf(row("ab" bigint))';
const CREATE_DQ = 'CREATE FUNCTION memory.app.dq(r ROW("a""b" bigint))\nRETURNS bigint\nRETURN 1';
/**
 * The one lossy step the identity reading keeps, and the measurement that says it must.
 *
 * `SHOW CREATE FUNCTION memory.app.dec` answers `decimal(10, 2)` with a space and `SHOW FUNCTIONS`
 * publishes `decimal(10,2)` without one, both verbatim from `trino-t32r1` on 2026-09-15, and
 * `CREATE OR REPLACE FUNCTION memory.app.dec(x decimal(10,2))` over the spaced one replaced it IN
 * PLACE, one row before and one after, re-rendered back with the space. So whitespace outside a
 * quoted identifier is not part of the identity, and dropping it is what stops a reader who closed
 * a gap inside a type from being refused.
 */
const CREATE_DEC = "CREATE FUNCTION memory.app.dec(x decimal(10, 2))\nRETURNS bigint\nRETURN 2";
const DEC_ROW: unknown[] = ["dec", "bigint", "decimal(10,2)", "scalar", true, ""];
const DEC_SEGMENT = "dec(decimal(10,2))";
const DQ_ROW: unknown[] = ["dq", "bigint", 'row("a""b" bigint)', "scalar", true, ""];
const DQ_SEGMENT = 'dq(row("a""b" bigint))';

/**
 * Build against an object the fixture does not hold, with the listing carrying it beside the
 * fixture's own.
 *
 * The listing is EXTENDED rather than replaced, because the build resolves the overload the way
 * the pane's read does and a one-row listing would not be a reply this coordinator sends.
 */
async function buildAgainstExtra(options: {
  bare: string;
  row: unknown[];
  segment: string;
  readText: string;
  submitted: string;
}): Promise<ObjectEditBuild> {
  const provider = await editProvider();
  serveInstead(
    trinoFunctionListSql("memory", "app"),
    rows(FUNCTION_COLUMNS, [...MEMORY_APP_FUNCTION_ROWS, options.row]),
  );
  serveInstead(
    trinoObjectSourceSql(trinoSourceStatementFor(EDIT_KIND), "memory", "app", options.bare),
    sourceRows("Create Function", [options.readText]),
  );
  return await buildOn(provider, options.submitted, ["memory", "app", options.segment]);
}

async function buildAgainstNlrow(readText: string, submitted: string): Promise<ObjectEditBuild> {
  return await buildAgainstExtra({
    bare: "nlrow",
    row: NLROW_FUNCTION_ROW,
    segment: NLROW_PATH[2] as string,
    readText,
    submitted,
  });
}

/** The `SHOW CREATE FUNCTION` reply, one queued answer per call, the last one repeating. */
function sourceQueue(replies: readonly (readonly string[])[]): (id: string) => Reply {
  let call = 0;
  return (id) => {
    const definitions = replies[Math.min(call, replies.length - 1)];
    call += 1;
    return sourceRows("Create Function", definitions)(id);
  };
}

/** One statement whose SUBMISSION throws, which is what an exchange that never answers is. */
function throwInstead(statement: string, error: Error): void {
  const previous = replyFor;
  replyFor = (sql) => {
    if (sql === statement) throw error;
    return previous(sql);
  };
}

async function editProvider(): Promise<TrinoProvider> {
  return await objectProvider({ database: "memory", schema: "app" });
}

async function buildOn(
  provider: TrinoProvider,
  submitted: string,
  path: readonly string[] = EDIT_PATH,
): Promise<ObjectEditBuild> {
  return await provider.buildObjectEdit!({
    path,
    kind: EDIT_KIND,
    partId: TRINO_SOURCE_PART_ID,
    text: submitted,
  });
}

/** Build against a chosen read text, which is what the coordinator answers for the overload. */
async function buildAgainst(readText: string, submitted: string): Promise<ObjectEditBuild> {
  const provider = await editProvider();
  serveInstead(SHOW_PLUS_ONE, sourceRows("Create Function", [readText]));
  return await buildOn(provider, submitted);
}

async function planOn(provider: TrinoProvider, submitted: string): Promise<ObjectEditPlan> {
  const build = await buildOn(provider, submitted);
  if (!build.built) throw new Error(build.refusal.sentence);
  return build.plan;
}

/**
 * A plan this test builds BY HAND, to reach an arm the build's own checks refuse.
 *
 * A legitimate unit-level construction and not a shortcut: the route refuses a plan it did
 * not seal, the provider is the thing under test, and `applied-elsewhere` exists precisely
 * for a first-line rule this design got wrong, which by definition no build can produce.
 */
async function forcedPlan(submitted: string): Promise<ObjectEditPlan> {
  const text = `${submitted.slice(0, 6)} OR REPLACE${submitted.slice(6)}`;
  return {
    planVersion: 1,
    planId: "forced-plan-for-the-post-apply-control",
    issuedAt: "2026-09-14T00:00:00.000Z",
    connectionFingerprint: await connectionFingerprint(makeConnection({ database: "memory", schema: "app" })),
    type: "trino",
    path: [...EDIT_PATH],
    kind: EDIT_KIND,
    partId: TRINO_SOURCE_PART_ID,
    strategy: "replace-in-place-statement",
    unit: {
      medium: "statement",
      steps: [
        {
          text,
          language: "sql",
          segments: [
            { from: "user", start: 0, end: 6 },
            { from: "provider", text: " OR REPLACE" },
            { from: "user", start: 6, end: submitted.length },
          ],
        },
      ],
    },
    session: [],
    revision: { check: "compared", token: await sha256Hex(READ_TEXT), basis: "SHOW CREATE FUNCTION", scope: "server" },
    consequences: [],
  };
}

/**
 * Apply, with the coordinator answering `before` to the apply's own re-read and `then` to the
 * post-apply verification.
 *
 * TWO SEPARATE ANSWERS AND NOT ONE, because the two reads ask different questions and a
 * harness that could not tell them apart could not drive either the conflict arm or the fork
 * arm. `then` defaults to the reader's own text on a normal apply, which is what a successful
 * replace leaves on the server, and to `before` on a forced one, which is what a FORK leaves.
 */
async function applyAgainst(options: {
  before: string;
  after: string;
  then?: string;
  /**
   * The OTHER overloads of the same name, in BOTH replies.
   *
   * `SHOW CREATE FUNCTION memory.app.plus_one` answers ONE ROW PER OVERLOAD and the fixture has
   * two, so a one-row reply is not a shape this coordinator produces: measured on 476 the reply
   * carries the `double` row beside the `bigint` one. It defaults to that pair rather than to a
   * single row so every apply test below drives the multi-row reply the post-apply verification
   * has to read.
   */
  siblings?: readonly string[];
  /**
   * Rows only the POST-APPLY reply carries, which is what a FORK leaves behind.
   *
   * MEASURED on trinodb/trino:476 on 2026-09-14, container `libredb-trino-t08fix`, host port
   * 18509: `memory.app.plus_one` answered two rows, `CREATE OR REPLACE FUNCTION
   * memory.app.plus_one(x varchar)` succeeded, and the reply then carried three with the
   * addressed `(x bigint)` row byte-identical. They are served FIRST because that is where the
   * coordinator put the new row in that measurement. A gained row is ALSO what an unrelated
   * session creating another overload of the same name leaves, which is why the provider does
   * not read one as a fork.
   */
  gained?: readonly string[];
  capture?: string[];
  forced?: boolean;
}): Promise<ObjectEditOutcome> {
  const provider = await editProvider();
  serveInstead(SHOW_PLUS_ONE, sourceRows("Create Function", [READ_TEXT]));
  const plan = options.forced ? await forcedPlan(options.after) : await planOn(provider, options.after);
  const then = options.then ?? (options.forced ? options.before : options.after);
  const siblings = options.siblings ?? [CREATE_PLUS_ONE_DOUBLE];
  serveInstead(
    SHOW_PLUS_ONE,
    sourceQueue([
      [options.before, ...siblings],
      [...(options.gained ?? []), then, ...siblings],
    ]),
  );
  const mark = sentSql.length;
  const outcome = await provider.applyObjectEdit!(plan);
  options.capture?.push(...sentSql.slice(mark));
  return outcome;
}

/** Apply against a write the coordinator refuses, or an exchange that never answers at all. */
async function applyWithTrinoError(fault: Record<string, unknown> | Error): Promise<ObjectEditOutcome> {
  const provider = await editProvider();
  serveInstead(SHOW_PLUS_ONE, sourceRows("Create Function", [READ_TEXT]));
  const plan = await planOn(provider, EDITED);
  if (fault instanceof Error) throwInstead(PLAN_TEXT, fault);
  else serveInstead(PLAN_TEXT, refusal(fault));
  return await provider.applyObjectEdit!(plan);
}

describe("Trino object edit: the declaration and the affordance", () => {
  test("declares acceptsSourceEdits on exactly one kind", () => {
    const provider = new TrinoProvider(makeConnection());
    const kinds = provider.getCapabilities().objectKinds ?? [];
    expect(kinds.filter((kind) => kind.acceptsSourceEdits === true).map((kind) => kind.id)).toEqual(["function"]);
    // `view` is DEFERRED and not refused: MEASURED on 476, `CREATE OR REPLACE VIEW` works and a
    // failed apply leaves the previous view byte-identical. It is held back only because
    // SECURITY DEFINER is in the read text although the author never typed it, and the consequence
    // class for a changed security principal has no test on this engine yet. `table` and
    // `materialized_view` are REFUSED BY THE ENGINE: NOT_SUPPORTED, errorCode 13, on the memory
    // connector.
    expect(
      kinds
        .filter((kind) => kind.acceptsSourceEdits !== true)
        .map((kind) => kind.id)
        .sort(),
    ).toEqual(["materialized_view", "table", "view"]);
  });

  test("every readable function part is offered, because possibility is a per-CATALOG fact", async () => {
    // No pre-flight exists on this engine and none is invented: measured on 476, one of five
    // catalogs takes a function and one takes a view, and the only way to know is to try.
    const provider = await editProvider();
    const document = await provider.readObjectSource!(["memory", "app", "plus_one(bigint)"], "function");
    const [part] = document.parts;
    if (isSourcePartUnavailable(part)) throw new Error("narrowing");
    expect(part.edit).toEqual({ offered: true });
  });

  test("a kind this provider never declared editable carries no affordance at all", async () => {
    // The other half of the population, and it is the half a single-kind assertion cannot see:
    // an `edit` field written unconditionally would offer an edit on a `table`, which the
    // connector answers NOT_SUPPORTED for, and the route would then have to strip what the
    // provider should never have written.
    const provider = await editProvider();
    for (const [path, kind] of [
      [["memory", "app", "customers"], "table"],
      [["memory", "app", "customer_names"], "view"],
    ] as const) {
      const [part] = (await provider.readObjectSource!(path, kind)).parts;
      if (isSourcePartUnavailable(part)) throw new Error("narrowing");
      expect(part.edit).toBeUndefined();
    }
  });
});

describe("Trino object edit: the build", () => {
  test("the splice is ANCHORED TO THE FIRST TOKEN and is never a global replace", async () => {
    const build = await buildAgainst(READ_TEXT, EDITED);
    if (!build.built) throw new Error(build.refusal.sentence);
    if (build.plan.unit.medium !== "statement") throw new Error("narrowing");
    const [step] = build.plan.unit.steps;
    // For the fixture's own shape that is `{ at: 6, inserted: " OR REPLACE" }`, which is why a
    // scalar prefix length cannot describe this engine: the user's text is not a suffix of the sent
    // text and the insertion is INSIDE the first line.
    expect(step.segments).toEqual([
      { from: "user", start: 0, end: 6 },
      { from: "provider", text: " OR REPLACE" },
      { from: "user", start: 6, end: EDITED.length },
    ]);
    expect(renderSegments(EDITED, step.segments)).toBe(step.text);
    expect(step.text.startsWith("CREATE OR REPLACE FUNCTION")).toBe(true);
    // The header is SPLICED and never ASSEMBLED, because MEASURED on 476 `SECURITY DEFINER` lives
    // in the read text although the author never typed it, and an assembled header would silently
    // change who a view runs as.
    expect(step.text).toContain(EDITED.slice(6));
  });

  test("a body holding the word CREATE is spliced ONCE, at the first token", async () => {
    // The population a global replace needs, and the fixture holds it: `mentions_create` returns
    // the literal 'CREATE TABLE', so `replaceAll("CREATE", "CREATE OR REPLACE")` rewrites the
    // BODY as well and the render invariant stops holding.
    const edited = CREATE_MENTIONS_CREATE.replace("RETURN 'CREATE TABLE'", "RETURN 'CREATE VIEW'");
    const provider = await editProvider();
    serveInstead(
      trinoObjectSourceSql(trinoSourceStatementFor(EDIT_KIND), "memory", "app", "mentions_create"),
      sourceRows("Create Function", [CREATE_MENTIONS_CREATE]),
    );
    const build = await buildOn(provider, edited, ["memory", "app", "mentions_create(bigint)"]);
    if (!build.built) throw new Error(build.refusal.sentence);
    if (build.plan.unit.medium !== "statement") throw new Error("narrowing");
    const [step] = build.plan.unit.steps;
    expect(renderSegments(edited, step.segments)).toBe(step.text);
    expect(step.text).toContain("RETURN 'CREATE VIEW'");
    expect(step.text.split(" OR REPLACE").length).toBe(2);
  });

  test("a text whose first token is not CREATE is refused rather than spliced", async () => {
    const build = await buildAgainst(READ_TEXT, "ALTER FUNCTION memory.app.plus_one(x bigint) ...");
    if (build.built) throw new Error("expected a refusal");
    expect(build.refusal.refusal).toBe("identity");
    // The SENTENCE and not only the class, because the first-line check below refuses the same
    // text with the same class: without this the first-token guard is unkillable.
    expect(build.refusal.sentence).toContain("does not begin with CREATE");
    expect(build.refusal.sentence).toContain("ALTER");
  });

  test("the identity survives a header the SERVER ITSELF split across lines, which a first-line check does not", async () => {
    // THE POPULATION, and it is server-produced rather than reader-supplied. MEASURED on
    // trinodb/trino:476 in container `trino-t32` on host port 18532 on 2026-09-15: the formatter
    // does NOT wrap on width, a 200-parameter function answering 11,845 characters on ONE line,
    // but it renders an identifier VERBATIM, so a ROW field name holding a newline puts the rest
    // of the parameter list on line two of the engine's own text.
    const submitted = CREATE_NLROW.replace("), y bigint)", "), y varchar)").replace("RETURN y", "RETURN 1");
    // The CONTROL that makes this test about the parameter list and not about the first line: the
    // two first lines are byte-identical, so a first-line check certifies nothing here.
    expect(submitted.split("\n")[0]).toBe(CREATE_NLROW.split("\n")[0]);
    const build = await buildAgainstNlrow(CREATE_NLROW, submitted);
    if (build.built) throw new Error("expected a refusal");
    expect(build.refusal.refusal).toBe("identity");
    // MEASURED end to end through this provider against that container: the first-line check
    // ACCEPTED this text, the apply SUCCEEDED, and `SHOW FUNCTIONS FROM memory.app` answered TWO
    // `nlrow` rows where it had answered one, with the outcome `applied-elsewhere` and
    // `undone: false`, so nothing in this product removes the second one.
    expect(build.refusal.sentence).toContain('nlrow(ROW("a\nb" bigint), varchar)');
    expect(build.refusal.sentence).toContain('memory.app.nlrow(row("a\nb" bigint), bigint)');
  });

  test("the same split header BUILDS when only the body below it moved", async () => {
    // The other half of the population, and without it the test above is a guard that refuses
    // everything. A body edit on the very same object, with the identity untouched, is applied.
    const submitted = CREATE_NLROW.replace("RETURN y", "RETURN y + 1");
    const build = await buildAgainstNlrow(CREATE_NLROW, submitted);
    if (build.built !== true) throw new Error(build.refusal.sentence);
    if (build.plan.unit.medium !== "statement") throw new Error("narrowing");
    expect(build.plan.unit.steps[0]?.text).toBe(`CREATE OR REPLACE${submitted.slice(6)}`);
  });

  test("a SPACE deleted inside a quoted ROW field name is refused, which the comparison form cannot see", async () => {
    // THE REGRESSION THIS TEST EXISTS FOR, measured live on trinodb/trino:476 in container
    // `trino-t32r1` on host port 18633 on 2026-09-15: with ONE `rowf` overload present, reading
    // it through this provider, deleting the one space inside the quoted ROW field name and
    // applying answered `applied` with a revision token, and `SHOW FUNCTIONS FROM memory.app`
    // then answered TWO `rowf` rows. The reader was told the edit landed and was never shown the
    // `applied-elsewhere` sentence at all.
    const submitted = CREATE_ROWF_SPACED.replace('"a b"', '"ab"');
    // THE CONTROL, and it is what makes this a test about the identity reading rather than about
    // any difference at all: the two texts are ONE string under the comparison form the overload
    // resolution has to use, so a key built on that form certifies nothing here.
    expect(trinoCreateSignature(submitted)).toBe(trinoCreateSignature(CREATE_ROWF_SPACED));
    const build = await buildAgainstExtra({
      bare: "rowf",
      row: ROWF_SPACED_ROW,
      segment: ROWF_SPACED_SEGMENT,
      readText: CREATE_ROWF_SPACED,
      submitted,
    });
    if (build.built) throw new Error("expected a refusal");
    expect(build.refusal.refusal).toBe("identity");
    expect(build.refusal.sentence).toContain('rowf(ROW("ab" bigint))');
  });

  test("the CASE of a quoted ROW field name is part of the identity, and is refused", async () => {
    // MEASURED on the same container: `rowf(r row("Ab" bigint))` created a THIRD row beside
    // `row("a b" bigint)` and `row("ab" bigint)`. A quoted identifier keeps its case on this
    // engine, so this is a different type and a different overload.
    const submitted = CREATE_ROWF_QUOTED.replace('"ab"', '"Ab"');
    expect(trinoCreateSignature(submitted)).toBe(trinoCreateSignature(CREATE_ROWF_QUOTED));
    const build = await buildAgainstExtra({
      bare: "rowf",
      row: ROWF_QUOTED_ROW,
      segment: ROWF_QUOTED_SEGMENT,
      readText: CREATE_ROWF_QUOTED,
      submitted,
    });
    if (build.built) throw new Error("expected a refusal");
    expect(build.refusal.refusal).toBe("identity");
    expect(build.refusal.sentence).toContain('rowf(ROW("Ab" bigint))');
  });

  test("a DOUBLED quote is one field name and not two, so dropping it is refused", async () => {
    // MEASURED on the same container: `dq(r row("a""b" bigint))` and `dq(r row(ab bigint))` are
    // TWO rows, so `a""b` is the single field name `a"b` and reducing it to `ab` forks. A reader
    // that toggled on every quote without pairing them would read `"a""b"` as the two identifiers
    // `a` and `b`, and would then call this edit harmless.
    const submitted = CREATE_DQ.replace('"a""b"', "ab");
    expect(trinoCreateSignature(submitted)).toBe(trinoCreateSignature(CREATE_DQ));
    const build = await buildAgainstExtra({
      bare: "dq",
      row: DQ_ROW,
      segment: DQ_SEGMENT,
      readText: CREATE_DQ,
      submitted,
    });
    if (build.built) throw new Error("expected a refusal");
    expect(build.refusal.refusal).toBe("identity");
    expect(build.refusal.sentence).toContain("dq(ROW(ab bigint))");
  });

  test("the quoting and the case Trino ITSELF folds away are not a fork, and build", async () => {
    // THE OTHER HALF OF THE POPULATION, without which the three refusals above are a guard that
    // refuses every header edit. All four rows were driven on trinodb/trino:476 in container
    // `trino-t32r1` on host port 18633 on 2026-09-15 and every one of them replaced the object IN
    // PLACE, the row count unchanged:
    //
    //   * `row(ab bigint)` over `row("ab" bigint)`: one row, re-rendered `ROW(ab bigint)`, so a
    //     delimited identifier that needs no delimiters names the same field as the bare one;
    //   * `row(Ab bigint)` over the same: still one row, so an UNQUOTED identifier folds to lower
    //     case while a quoted one does not;
    //   * `memory.app.PLUS_ONE(x bigint)` over `plus_one`: one row, re-rendered with the reader's
    //     own capitals;
    //   * `memory.app."Plus_One"(x bigint)` over `plus_one`: one row, and `CREATE FUNCTION
    //     memory.app.casefn` over an existing `memory.app."CaseFn"` answers ALREADY_EXISTS,
    //     errorCode 12. A FUNCTION NAME folds its case even when it is delimited, which is the
    //     one place this engine's two identifier rules differ, and it is why the name half and
    //     the type half of the identity are folded by different rules rather than by one.
    const typeShapes = [CREATE_ROWF_QUOTED.replace('"ab"', "ab"), CREATE_ROWF_QUOTED.replace('"ab"', "Ab")];
    for (const submitted of typeShapes) {
      const build = await buildAgainstExtra({
        bare: "rowf",
        row: ROWF_QUOTED_ROW,
        segment: ROWF_QUOTED_SEGMENT,
        readText: CREATE_ROWF_QUOTED,
        submitted,
      });
      if (!build.built) throw new Error(build.refusal.sentence);
    }
    const nameShapes = [
      READ_TEXT.replace("memory.app.plus_one", "memory.app.PLUS_ONE"),
      READ_TEXT.replace("memory.app.plus_one", 'memory.app."plus_one"'),
      READ_TEXT.replace("memory.app.plus_one", 'memory.app."Plus_One"'),
    ];
    for (const submitted of nameShapes) {
      const build = await buildAgainst(READ_TEXT, submitted);
      if (!build.built) throw new Error(build.refusal.sentence);
    }
    // Neither loop asserts anything if it runs zero times, so both populations are pinned by
    // count.
    expect(typeShapes).toHaveLength(2);
    expect(nameShapes).toHaveLength(3);
  });

  test("whitespace closed up INSIDE a rendered type is not a fork, and builds", async () => {
    // The other lossy step, and the only one left in the identity reading. MEASURED on 476 in
    // container `trino-t32r1` on 2026-09-15: `decimal(10,2)` applied over `decimal(10, 2)` left
    // ONE row and came back re-rendered with the space, so the gap the reader closed is not part
    // of the identity. Without this the suite cannot tell a reading that drops that whitespace
    // from one that keeps it, and a reader who tidied a type list would be refused.
    const build = await buildAgainstExtra({
      bare: "dec",
      row: DEC_ROW,
      segment: DEC_SEGMENT,
      readText: CREATE_DEC,
      submitted: CREATE_DEC.replace("decimal(10, 2)", "decimal(10,2)").replace("RETURN 2", "RETURN 3"),
    });
    if (!build.built) throw new Error(build.refusal.sentence);
    if (build.plan.unit.medium !== "statement") throw new Error("narrowing");
    expect(build.plan.unit.steps[0]?.text).toContain("memory.app.dec(x decimal(10,2))");
  });

  test("a qualified name that differs INSIDE its quotes is still refused", async () => {
    // The fail-safe edge of the rule above, and the reason the name is folded by a rule rather
    // than by stripping its quotes: `memory.app."plus one"` is a name a reader can type and
    // `memory.app."sp ace"(x bigint)` is a function this coordinator really holds, created and
    // read back on `trino-t32r1`. A space inside the quotes is a different name, and dropping
    // the quote characters would make it the same one.
    const build = await buildAgainst(READ_TEXT, READ_TEXT.replace("memory.app.plus_one", 'memory.app."plus one"'));
    if (build.built) throw new Error("expected a refusal");
    expect(build.refusal.refusal).toBe("identity");
    expect(build.refusal.sentence).toContain('memory.app."plus one"(bigint)');
  });

  test("a RENAMED parameter builds, because on 476 a rename is replaced in place", async () => {
    // The widening this repair carries, and it is measured rather than argued. On the same
    // container: `CREATE OR REPLACE FUNCTION memory.app.rename_probe(  renamed   bigint  )` over
    // `rename_probe(x bigint)` answered CREATE FUNCTION and `SHOW FUNCTIONS` held ONE row before
    // and ONE after, rendered back as `rename_probe(renamed bigint)`. A parameter name is not part
    // of the identity on this engine, `SHOW FUNCTIONS` publishes none, and the path segment this
    // provider mints carries none, so refusing a rename was a false refusal.
    const submitted = READ_TEXT.replace("(x bigint)", "(  renamed   bigint  )").replace(
      "RETURN (x + 1)",
      "RETURN (renamed + 1)",
    );
    const build = await buildAgainst(READ_TEXT, submitted);
    if (!build.built) throw new Error(build.refusal.sentence);
    if (build.plan.unit.medium !== "statement") throw new Error("narrowing");
    expect(build.plan.unit.steps[0]?.text).toContain(
      "CREATE OR REPLACE FUNCTION memory.app.plus_one(  renamed   bigint  )",
    );
  });

  test("a changed argument TYPE is refused even when nothing else in the header moves", async () => {
    // The edit that FORKS, measured on 476, in its plainest form: same name, one type. The
    // first-line check caught this one too, and the signature check has to keep catching it, so
    // this is the regression that stops the repair from widening past what it meant to.
    const build = await buildAgainst(READ_TEXT, FORKING_TEXT);
    if (build.built) throw new Error("expected a refusal");
    expect(build.refusal.refusal).toBe("identity");
    expect(build.refusal.sentence).toContain("memory.app.plus_one(varchar)");
  });

  test("a changed qualified NAME is refused although the argument types are unchanged", async () => {
    // MEASURED on 476: `CREATE OR REPLACE FUNCTION memory.app.rename_probe2(renamed bigint)` over
    // `rename_probe(renamed bigint)` left TWO functions, so a name change forks exactly as an
    // argument-type change does, and the identity is the NAME and the types together.
    const renamed = READ_TEXT.replace("plus_one", "plus_two");
    const build = await buildAgainst(READ_TEXT, renamed);
    if (build.built) throw new Error("expected a refusal");
    expect(build.refusal.refusal).toBe("identity");
    expect(build.refusal.sentence).toContain("memory.app.plus_two(bigint)");
    expect(build.refusal.sentence).toContain("memory.app.plus_one(bigint)");
  });

  test("a text LibreDB cannot read a CREATE FUNCTION header out of is refused by that fact", async () => {
    // `CREATE OR REPLACE FUNCTION ...` is the population, and it is a real paste: the first token
    // IS CREATE, so check 3 passes it, and the apply would then splice a SECOND ` OR REPLACE` into
    // it and send a statement no engine parses. The old first-line comparison refused it as a
    // changed header, which was the right answer for the wrong reason.
    const build = await buildAgainst(
      READ_TEXT,
      "CREATE OR REPLACE FUNCTION memory.app.plus_one(x bigint)\nRETURNS bigint\nRETURN (x + 2)",
    );
    if (build.built) throw new Error("expected a refusal");
    expect(build.refusal.refusal).toBe("identity");
    expect(build.refusal.sentence).toContain("could not read a CREATE FUNCTION header");
    expect(build.refusal.sentence).toContain("memory.app.plus_one(bigint)");
  });

  test("the three shapes a CREATE FUNCTION header cannot be read out of all answer the SAME fact", async () => {
    // Enumerated from the reader itself rather than sampled, because each one is a different line
    // of it and this suite is the only thing that can tell them apart from the outside. All three
    // are texts a reader can type into the pane, and all three open with CREATE, so check 3 passes
    // them on.
    const shapes = [
      // No parenthesis pair ANYWHERE, which is the arm that would throw on `span.open`. The
      // parentheses have to be gone from the BODY too, and that is a fact about the scan worth
      // stating: it takes the first TOP-LEVEL pair in the whole statement, which for every text
      // this engine prints is the parameter list, and for a text with no parameter list is
      // whatever the body brackets. The refusal is the same either way, by a different line.
      "CREATE FUNCTION memory.app.plus_one RETURNS bigint RETURN x + 2",
      // Keywords and then nothing: the parenthesis is there and the name is not.
      "CREATE FUNCTION(x bigint)\nRETURNS bigint\nRETURN (x + 2)",
      // A second keyword that is not the object's, which is what `CREATE OR REPLACE` is.
      "CREATE TABLE memory.app.plus_one(x bigint)\nRETURNS bigint\nRETURN (x + 2)",
    ];
    for (const shape of shapes) {
      const build = await buildAgainst(READ_TEXT, shape);
      if (build.built) throw new Error(`expected a refusal for ${shape}`);
      expect(build.refusal.refusal).toBe("identity");
      expect(build.refusal.sentence).toContain("could not read a CREATE FUNCTION header");
    }
    // The loop asserts nothing if it runs zero times, so the population is pinned by count.
    expect(shapes).toHaveLength(3);
  });

  test("a SERVER definition whose header cannot be read refuses rather than builds", async () => {
    // The fail-safe direction of the same reading, driven from the other side. Unmeasured on 476
    // and named as such: every `SHOW CREATE FUNCTION` reply this phase captured opens with
    // `CREATE FUNCTION`. It is asserted because the alternative to refusing is applying against a
    // definition this provider could not identify.
    //
    // The first token still has to be CREATE, or check 3 answers first: this is a reply that opens
    // with CREATE and then says something this provider cannot parse a name and a list out of.
    const served = READ_TEXT.replace("CREATE FUNCTION", "CREATE ROUTINE");
    const build = await buildAgainst(served, READ_TEXT);
    if (build.built) throw new Error("expected a refusal");
    expect(build.refusal.refusal).toBe("identity");
    expect(build.refusal.sentence).toContain("memory.app.plus_one(bigint)");
  });

  test("the revision is a COMPARISON, because Trino publishes no readable token anywhere", async () => {
    const build = await buildAgainst(READ_TEXT, EDITED);
    if (!build.built) throw new Error(build.refusal.sentence);
    expect(build.plan.revision).toEqual({
      check: "compared",
      token: await sha256Hex(READ_TEXT),
      basis: "SHOW CREATE FUNCTION",
      scope: "server",
    });
    // No session pins: the statement is fully qualified by the catalog and schema segments of its
    // own path. No consequences: nothing measured on 476 is destroyed by a successful replace of a
    // function.
    expect(build.plan.session).toEqual([]);
    expect(build.plan.consequences).toEqual([]);
    expect(build.plan.strategy).toBe("replace-in-place-statement");
  });

  test("a truncated read refuses before anything is built, and a byte-identical text does too", async () => {
    expect((await buildAgainst(OVER_LIMIT_TEXT, EDITED)).built).toBe(false);
    expect((await buildAgainst(READ_TEXT, READ_TEXT)).built).toBe(false);
  });

  test("the two refusals above are DIFFERENT facts and say so", async () => {
    const bounded = await buildAgainst(OVER_LIMIT_TEXT, EDITED);
    if (bounded.built) throw new Error("expected a refusal");
    expect(bounded.refusal.refusal).toBe("guard");
    expect(bounded.refusal.sentence).toContain("1,000,001");
    const identical = await buildAgainst(READ_TEXT, READ_TEXT);
    if (identical.built) throw new Error("expected a refusal");
    expect(identical.refusal.refusal).toBe("definition");
    // Nothing was sent for either, so no engine reported a position and there is no coordinate.
    expect(bounded.refusal.at).toEqual({ within: "none" });
    expect(identical.refusal.at).toEqual({ within: "none" });
  });

  test("the brief's own bare over-length text RAISES, because no overload matches it", async () => {
    // Pinned rather than hidden. A reply with no parameter list at all belongs to no segment, and
    // the read says so naming the segment before any bound is consulted. That is why
    // `OVER_LIMIT_TEXT` above carries the addressed parameter list.
    await expect(buildAgainst("x".repeat(1_000_001), EDITED)).rejects.toThrow(
      "No Trino function named plus_one(bigint) in memory.app",
    );
  });

  test("the build selects the ADDRESSED overload out of a reply carrying every one of them", async () => {
    // The default reply is the live one: the DOUBLE overload comes back FIRST, so a build that
    // took `rows[0]` would compute its revision over the wrong object and refuse a correct edit.
    const provider = await editProvider();
    const build = await buildOn(provider, EDITED);
    if (!build.built) throw new Error(build.refusal.sentence);
    expect(build.preimage.text).toBe(READ_TEXT);
    expect(build.plan.revision).toEqual({
      check: "compared",
      token: await sha256Hex(READ_TEXT),
      basis: "SHOW CREATE FUNCTION",
      scope: "server",
    });
  });

  test("the plan carries the connection fingerprint, the path and the part it was built for", async () => {
    const build = await buildAgainst(READ_TEXT, EDITED);
    if (!build.built) throw new Error(build.refusal.sentence);
    expect(build.plan.connectionFingerprint).toBe(
      await connectionFingerprint(makeConnection({ database: "memory", schema: "app" })),
    );
    expect(build.plan.path).toEqual([...EDIT_PATH]);
    expect(build.plan.kind).toBe(EDIT_KIND);
    expect(build.plan.partId).toBe(TRINO_SOURCE_PART_ID);
    expect(build.plan.type).toBe("trino");
    expect(build.plan.planVersion).toBe(1);
    // Minted here and nowhere else: the audit's correlation id identifies ONE edit.
    expect(build.plan.planId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(Number.isNaN(Date.parse(build.plan.issuedAt))).toBe(false);
  });

  test("a part id this provider never wrote RAISES rather than refusing", async () => {
    const provider = await editProvider();
    await expect(
      provider.buildObjectEdit!({ path: [...EDIT_PATH], kind: EDIT_KIND, partId: "body", text: EDITED }),
    ).rejects.toThrow('A Trino function has one source part, "definition", received "body"');
  });

  test("a kind this provider does not apply an edited definition for RAISES by name", async () => {
    const provider = await editProvider();
    await expect(
      provider.buildObjectEdit!({
        path: ["memory", "app", "customer_names"],
        kind: "view",
        partId: TRINO_SOURCE_PART_ID,
        text: CREATE_CUSTOMER_NAMES,
      }),
    ).rejects.toThrow('Trino does not apply an edited definition for the kind "view"');
  });
});

describe("Trino object edit: the apply", () => {
  test("the apply RE-READS and compares before it writes, which is what `compared` means", async () => {
    const sent: string[] = [];
    // The re-read and the write are two round trips, so the window is NARROWED and not closed, and
    // this design does not let the provider close it by inventing a transaction Trino does not have.
    const outcome = await applyAgainst({ before: READ_TEXT, after: EDITED, capture: sent });
    expect(sent[0]).toContain("SHOW CREATE FUNCTION");
    expect(sent[1]).toBe(PLAN_TEXT);
    expect(outcome.outcome).toBe("applied");
  });

  test("the re-read addresses the SAME statement the build read", async () => {
    // The build resolves the overload through SHOW FUNCTIONS; the apply holds the plan alone and
    // takes the bare name back out of the path segment. This is the guard that the two agree.
    const sent: string[] = [];
    await applyAgainst({ before: READ_TEXT, after: EDITED, capture: sent });
    expect(sent[0]).toBe(SHOW_PLUS_ONE);
  });

  test("a successful apply answers the NEW revision and never the token the plan carried", async () => {
    const outcome = await applyAgainst({ before: READ_TEXT, after: EDITED });
    if (outcome.outcome !== "applied") throw new Error("narrowing");
    expect(outcome.revision).toEqual({
      check: "compared",
      token: await sha256Hex(EDITED),
      basis: "SHOW CREATE FUNCTION",
      scope: "server",
    });
    expect(outcome.duration).toBeGreaterThanOrEqual(0);
  });

  test("a definition that MOVED between the build and the apply is a conflict with the current text", async () => {
    const outcome = await applyAgainst({ before: `${READ_TEXT} -- somebody else`, after: EDITED });
    if (outcome.outcome !== "conflict" || outcome.conflict !== "object-changed") throw new Error("narrowing");
    expect(outcome.current.text).toBe(`${READ_TEXT} -- somebody else`);
  });

  test("a conflict SENDS NOTHING, which is what makes it a detection rather than a report", async () => {
    const sent: string[] = [];
    await applyAgainst({ before: `${READ_TEXT} -- somebody else`, after: EDITED, capture: sent });
    expect(sent).toEqual([SHOW_PLUS_ONE]);
  });

  test("the object the SENT statement wrote is verified AFTER the apply: a fork is `applied-elsewhere`", async () => {
    // MEASURED why this arm is reachable: only the ARGUMENT TYPE LIST forks on 476, a changed
    // return type and a renamed parameter are replaced in place, so a fork needs an argument-type
    // edit, which the build's first-line check already refuses. This post-apply check is the
    // CONTROL that catches a first-line rule this design got wrong.
    //
    // MEASURED on trinodb/trino:476 on 2026-09-14, container `libredb-trino-t08fix`, host port
    // 18509: `SHOW CREATE FUNCTION memory.app.plus_one` answered TWO rows, a
    // `CREATE OR REPLACE FUNCTION memory.app.plus_one(x varchar)` succeeded, and the reply then
    // answered THREE with the addressed `(x bigint)` row byte-identical. That measurement is why
    // a fork is REACHABLE; it is not the question this guard asks. The guard compares the
    // parameter list the SENT statement declares against the signature the addressed row was
    // FOUND by, and it never looks at the row SET: the row-set question is unsound in both
    // directions and the two tests below measure both of its failures, an existing overload that
    // gains no row and another session's sibling that gains one without any fork. It is also not
    // the addressed row's RENDERING, which is the formatter's output and moves for reasons that
    // are not a fork.
    const outcome = await applyAgainst({
      before: READ_TEXT,
      after: FORKING_TEXT,
      forced: true,
      gained: [CREATE_PLUS_ONE_VARCHAR],
    });
    if (outcome.outcome !== "applied-elsewhere") throw new Error("narrowing");
    // Trino has no transaction to take it back and this design will not issue a DROP to clean up.
    expect(outcome.undone).toBe(false);
    // NOT the engine's own name for what it wrote: neither half of this string comes from the
    // coordinator. BOTH halves are the SENT statement's own, the qualified name it declares and
    // the parameter list it declares, minted in the shape a path segment addresses an overload
    // with, so the dialog can say WHICH object is now there instead of only that one is. The name
    // is the declared one and not the addressed one because a NAME fork is one of the two ways
    // this arm is reached, and there the addressed name is the object that was NOT written.
    expect(outcome.wrote).toBe("memory.app.plus_one(varchar)");
  });

  test("`wrote` carries the parameter list the SENT statement declares, not the comparison form", async () => {
    // THE READER IS SENT LOOKING FOR AN OBJECT, so this string has to be one they can look up.
    // The comparison form is lower-cased and has its whitespace and its quotes stripped, which is
    // the only form the engine's two renderings of one signature agree on and is therefore the
    // right thing to COMPARE with, and it destroys the boundary between a ROW field's NAME and its
    // TYPE. Measured with the shipped helper on this same text, `trinoCreateSignature` answers
    // `decimal(10,2),array(varchar),row(abigint,bvarchar)`, so a `wrote` built from it prints
    // `row(abigint,bvarchar)` at the reader, which names no type Trino will parse.
    const outcome = await applyAgainst({ before: READ_TEXT, after: FORKING_HARD_TEXT, forced: true });
    if (outcome.outcome !== "applied-elsewhere") throw new Error("narrowing");
    expect(outcome.wrote).toBe("memory.app.plus_one(decimal(10, 2), array(varchar), ROW(a bigint, b varchar))");
    // AND IT IS AN ADDRESS RATHER THAN A LABEL, which is what the claim beside it says it is: the
    // segment reader takes it apart and the signature it yields is the one the written row would
    // be FOUND by, so the reader can put it in an object path and reach what was written.
    const parts = trinoFunctionSegmentParts(outcome.wrote ?? "");
    if (parts === null) throw new Error("narrowing");
    expect(parts.name).toBe("memory.app.plus_one");
    const COMPARISON_FORM = "decimal(10,2),array(varchar),row(abigint,bvarchar)";
    expect(trinoArgumentSignature(parts.argumentTypes)).toBe(COMPARISON_FORM);
    // And the form the comment above names, pinned by value rather than left as prose: this is
    // what the reader WOULD have been shown, and it is what the check itself runs on.
    expect(trinoCreateSignature(FORKING_HARD_TEXT)).toBe(COMPARISON_FORM);
  });

  test("a fork onto a different NAME with the SAME argument types is caught too", async () => {
    // THE HOLE THE SIGNATURE COMPARISON LEFT IN THIS CONTROL, and it is the same class as the
    // first-line identity check it is a control on: a signature is the ARGUMENT TYPES alone, so a
    // statement naming `plus_two(x bigint)` over a plan addressed to `plus_one(bigint)` compared
    // EQUAL, the addressed row came back unchanged, and the reader was told `applied` with a
    // revision token over text their edit never reached. MEASURED on trinodb/trino:476 in
    // container `trino-t32` on host port 18532 on 2026-09-15 that a name change forks:
    // `CREATE OR REPLACE FUNCTION memory.app.rename_probe2(renamed bigint)` over
    // `rename_probe(renamed bigint)` left TWO functions.
    const outcome = await applyAgainst({
      before: READ_TEXT,
      after: READ_TEXT.replace("plus_one", "plus_two").replace("RETURN (x + 1)", "RETURN (x + 3)"),
      forced: true,
    });
    if (outcome.outcome !== "applied-elsewhere") throw new Error("narrowing");
    expect(outcome.undone).toBe(false);
    // The name is the one the SENT statement declared and not the one the plan addresses, which is
    // the whole point: on a name fork the addressed name is the object that was NOT written.
    expect(outcome.wrote).toBe("memory.app.plus_two(bigint)");
  });

  test("a fork onto an overload that ALREADY EXISTS adds no row and is still `applied-elsewhere`", async () => {
    // THE MEASURED FALSE NEGATIVE of the row-set question, which is why the provider asks the
    // sent statement's own parameter list instead. MEASURED through this provider against the
    // live container above with a hand-built plan: with `plus_one(varchar)` already present, a
    // plan whose statement declares `(x varchar)` gains NO row, the reply holds the same three
    // signatures before and after, and `plus_one(bigint)` was never touched.
    const outcome = await applyAgainst({
      before: READ_TEXT,
      after: FORKING_TEXT,
      forced: true,
      siblings: [CREATE_PLUS_ONE_DOUBLE, CREATE_PLUS_ONE_VARCHAR],
    });
    if (outcome.outcome !== "applied-elsewhere") throw new Error("narrowing");
    expect(outcome.wrote).toBe("memory.app.plus_one(varchar)");
  });

  test("a plan whose statement carries no readable header says so and names nothing", async () => {
    // The other way this arm is reached, and it is the honest end of the same reading: a plan this
    // provider did not build can carry any bytes, and a statement no header can be read out of
    // cannot be claimed to have written the addressed object either. It says the first and omits
    // `wrote`, which is the sentence the dialog already renders without a name. Unreachable
    // through the product: the build refuses such a text before a plan exists, and the route
    // refuses a plan it did not seal, so this is driven with a hand-built plan exactly as the
    // fork arm above it is.
    const outcome = await applyAgainst({
      before: READ_TEXT,
      after: READ_TEXT.replace("CREATE FUNCTION", "CREATE ROUTINE"),
      forced: true,
    });
    if (outcome.outcome !== "applied-elsewhere") throw new Error("narrowing");
    expect(outcome.undone).toBe(false);
    expect(outcome.wrote).toBeUndefined();
  });

  test("another session creating a SIBLING overload in the window is not a fork", async () => {
    // THE FALSE POSITIVE of the row-set question, and the reason this provider does not ask it:
    // the re-read happens AFTER the write, so any other session that creates another overload of
    // the same NAME in that window adds a row to the reply. This apply is an ordinary in-place
    // edit and the reader must be told it landed.
    const outcome = await applyAgainst({ before: READ_TEXT, after: EDITED, gained: [CREATE_PLUS_ONE_VARCHAR] });
    expect(outcome.outcome).toBe("applied");
  });

  test("a header edit the reading calls harmless, plus a row that write should not have added, is a fork", async () => {
    // THE CONTROL ON THE IDENTITY READING, and it is a DIFFERENT question rather than the same
    // one asked twice. The arm above it compares the SENT statement's identity against the
    // addressed one with `trinoCreateFunctionIdentity`, which is the reader the BUILD refuses
    // with: sharing it means the control is blind to exactly the population the rule is blind to,
    // and that is how a live fork on 476 answered `applied` rather than `applied-elsewhere`
    // before this repair.
    //
    // So the control asks the ENGINE instead, and only where the two readings of the sent text
    // disagree: the reader changed the header, the identity reading called the change
    // identity-preserving, and the write nonetheless left `SHOW CREATE FUNCTION` answering MORE
    // rows than it did before. A parameter rename is that population, MEASURED in place on 476,
    // and a gained row there says the reading was wrong about this text.
    // BOTH HALVES OF THE IDENTITY, because the trigger compares the name and the types and a
    // shape that moves only one of them cannot tell a reading of both from a reading of one.
    const shapes = [RECASED, RECASED_NAME];
    for (const after of shapes) {
      const forked = await applyAgainst({ before: READ_TEXT, after, gained: [CREATE_PLUS_ONE_VARCHAR] });
      if (forked.outcome !== "applied-elsewhere") throw new Error(`narrowing: ${forked.outcome}`);
      expect(forked.undone).toBe(false);
      expect(forked.wrote).toBeUndefined();
    }
    expect(shapes).toHaveLength(2);
    const outcome = await applyAgainst({ before: READ_TEXT, after: RECASED, gained: [CREATE_PLUS_ONE_VARCHAR] });
    if (outcome.outcome !== "applied-elsewhere") throw new Error("narrowing");
    expect(outcome.undone).toBe(false);
    // NOTHING IS NAMED, and that is the honest end of this arm rather than an omission: the sent
    // statement declares the identity the plan addresses, so the only name this reading holds is
    // the addressed object's, which is precisely the object that was not written.
    expect(outcome.wrote).toBeUndefined();
  });

  test("the same header edit with no row gained is `applied`, so the control is not a blanket refusal", async () => {
    // The other half of that population. Without it the arm above would fire on every header edit
    // this design deliberately widened to allow, and a reader who renamed a parameter would be
    // told their edit went somewhere else. MEASURED on 476: a rename is replaced in place, one row
    // before and one after.
    const shapes = [RECASED, RECASED_NAME];
    for (const after of shapes) {
      const outcome = await applyAgainst({ before: READ_TEXT, after });
      expect(outcome.outcome).toBe("applied");
    }
    expect(shapes).toHaveLength(2);
  });

  test("an edit the FORMATTER canonicalizes back to the pre-image is `applied`, not a fork", async () => {
    // THE DEFECT THIS TEST PINS, measured end to end on trinodb/trino:476 on 2026-09-14 in
    // container `libredb-trino-t08fix`, host port 18509: applying CANONICALIZED over the fixture's
    // `plus_one(x bigint)` SUCCEEDS and `SHOW CREATE FUNCTION` comes back byte-identical to the
    // pre-image. A post-apply check that compared the two renderings answered `applied-elsewhere`
    // for it, so the dialog printed "This text does not name `plus_one(bigint)`, so that object
    // was not changed" and "A different object was created and LibreDB did not remove it" over a
    // change that had landed, the audit recorded `object_edit_applied_elsewhere`, and the draft
    // and its dirty mark stayed. It is the same defect `6fdcc8bb` repaired on PostgreSQL.
    const outcome = await applyAgainst({ before: READ_TEXT, after: CANONICALIZED, then: READ_TEXT });
    if (outcome.outcome !== "applied") throw new Error("narrowing");
    // The token of what is REALLY on the server, which after a canonicalizing apply is the
    // pre-image's own bytes. MEASURED live through the shipped provider on the container above:
    // `d7062c697f432ce5bb6743b59f6fe84c53db7b333181658038ed013339b80d3d`, which is that digest.
    expect(outcome.revision).toEqual({
      check: "compared",
      token: await sha256Hex(READ_TEXT),
      basis: "SHOW CREATE FUNCTION",
      scope: "server",
    });
  });

  test("NOT_SUPPORTED errorCode 13 is `unsupported` and carries the coordinator's own name", async () => {
    const outcome = await applyWithTrinoError({
      errorName: "NOT_SUPPORTED",
      errorCode: 13,
      message: "This connector does not support creating functions",
    });
    if (outcome.outcome !== "refused") throw new Error("narrowing");
    expect(outcome.refusal.refusal).toBe("unsupported");
    expect(outcome.refusal.code).toBe("NOT_SUPPORTED");
  });

  test("errorLocation is converted by SUBTRACTING the splice, which on line 1 is exactly 11 columns", async () => {
    const outcome = await applyWithTrinoError({
      errorName: "COLUMN_NOT_FOUND",
      errorCode: 46,
      message: "line 1:34: Column 'nope' cannot be resolved",
      errorLocation: { lineNumber: 1, columnNumber: 34 },
    });
    if (outcome.outcome !== "refused") throw new Error("narrowing");
    expect(outcome.refusal.at).toEqual({ within: "user", line: 1, column: 23 });
  });

  test("a body error on a LATER line is NOT shifted, because the splice is on line 1", async () => {
    // MEASURED on 476: `RETURN nope` answers `line 3:8` BOTH bare and spliced, so a rule that
    // subtracted eleven columns everywhere would put the marker eleven characters to the left of
    // the token. The real fault name and errorCode for that reply are COLUMN_NOT_FOUND and 47.
    const outcome = await applyWithTrinoError({
      errorName: "COLUMN_NOT_FOUND",
      errorCode: 47,
      message: "line 3:8: Column 'nope' cannot be resolved",
      errorLocation: { lineNumber: 3, columnNumber: 8 },
    });
    if (outcome.outcome !== "refused") throw new Error("narrowing");
    expect(outcome.refusal.at).toEqual({ within: "user", line: 3, column: 8 });
  });

  test("a coordinate on the KEYWORD ITSELF stays in the reader's text at line 1 column 1", async () => {
    // The arm that distinguishes an ANCHORED splice from one at offset zero, and nothing else
    // does: every coordinate past the clause converts identically either way, because the same
    // eleven characters sit in front of it. MEASURED on 476, an already-exists refusal points at
    // `1:1`, so this is the live shape and not a constructed one.
    const outcome = await applyWithTrinoError({
      errorName: "ALREADY_EXISTS",
      errorCode: 2,
      message: "line 1:1: Function 'memory.app.plus_one' already exists",
      errorLocation: { lineNumber: 1, columnNumber: 1 },
    });
    if (outcome.outcome !== "refused") throw new Error("narrowing");
    expect(outcome.refusal.at).toEqual({ within: "user", line: 1, column: 1 });
  });

  test("a coordinate landing INSIDE the spliced clause is `outside` and never a clamped number", async () => {
    const outcome = await applyWithTrinoError({
      errorName: "SYNTAX_ERROR",
      errorCode: 1,
      message: "line 1:9: mismatched input 'OR'",
      errorLocation: { lineNumber: 1, columnNumber: 9 },
    });
    if (outcome.outcome !== "refused") throw new Error("narrowing");
    expect(outcome.refusal.at).toEqual({ within: "outside" });
  });

  test("an <EOF> coordinate, which is one past the last character, is `outside`", async () => {
    // MEASURED on trinodb/trino:476 on 2026-09-14, container `libredb-trino-t08fix`, host port
    // 18509: a truncated `RETURN (x +` answers `line 3:12: mismatched input '<EOF>'. Expecting:
    // <expression>` on an 83-character statement whose third line is 11 characters, so the
    // coordinate the coordinator reports at end of input is exactly `lastLine.length + 1`. The
    // statement THIS test sends has a 14-character third line, so the same rule puts it at 3:15
    // and the offset at 86 of 86. The fault name and the coordinate rule are measured; this
    // document is assembled from them, because the harness sends one fixed statement.
    const outcome = await applyWithTrinoError({
      errorName: "SYNTAX_ERROR",
      errorCode: 1,
      message: "line 3:15: mismatched input '<EOF>'. Expecting: <expression>",
      errorLocation: { lineNumber: 3, columnNumber: 15 },
    });
    if (outcome.outcome !== "refused") throw new Error("narrowing");
    expect(outcome.refusal.at).toEqual({ within: "outside" });
  });

  test("a coordinate whose LINE is not a line at all is `outside` and never a placed marker", async () => {
    // THE POPULATION IS THIS PROVIDER'S OWN TRANSPORT, not a reply measured on 476: `readLocation`
    // in `http-transport.ts` takes any FINITE number, so a `lineNumber` of 0 crosses the seam. It
    // matters because 0 is not merely rejected downstream: without the coordinate validation the
    // offset is 72 of 86 and lands in the reader's THIRD line, so the product would underline a
    // token the engine never named and Monaco would accept it in silence.
    const outcome = await applyWithTrinoError({
      errorName: "SYNTAX_ERROR",
      errorCode: 1,
      message: "mismatched input",
      errorLocation: { lineNumber: 0, columnNumber: 1 },
    });
    if (outcome.outcome !== "refused") throw new Error("narrowing");
    expect(outcome.refusal.at).toEqual({ within: "outside" });
  });

  test("a FRACTIONAL line is `outside` too, and without the check it would point at line 1", async () => {
    const outcome = await applyWithTrinoError({
      errorName: "SYNTAX_ERROR",
      errorCode: 1,
      message: "mismatched input",
      errorLocation: { lineNumber: 1.5, columnNumber: 1 },
    });
    if (outcome.outcome !== "refused") throw new Error("narrowing");
    expect(outcome.refusal.at).toEqual({ within: "outside" });
  });

  test("a refusal the coordinator sent with NO location at all carries no coordinate", async () => {
    const outcome = await applyWithTrinoError({
      errorName: "NOT_SUPPORTED",
      errorCode: 13,
      message: "This connector does not support creating functions",
    });
    if (outcome.outcome !== "refused") throw new Error("narrowing");
    expect(outcome.refusal.at).toEqual({ within: "none" });
    // The engine's own sentence, unprefixed, and never a word of this product's own.
    expect(outcome.refusal.sentence).toBe("This connector does not support creating functions");
  });

  test("PERMISSION_DENIED is `privilege` and never the 401 the shipped mapper would make of it", async () => {
    const outcome = await applyWithTrinoError({
      errorName: "PERMISSION_DENIED",
      errorCode: 4,
      message: "Access Denied: Cannot create function memory.app.plus_one",
    });
    if (outcome.outcome !== "refused") throw new Error("narrowing");
    expect(outcome.refusal.refusal).toBe("privilege");
  });

  test("a fault name the classifier has never seen is `definition` with the engine's own sentence", async () => {
    const outcome = await applyWithTrinoError({
      errorName: "TYPE_MISMATCH",
      errorCode: 43,
      message: "line 3:8: Cannot cast varchar to bigint",
    });
    if (outcome.outcome !== "refused") throw new Error("narrowing");
    expect(outcome.refusal.refusal).toBe("definition");
    expect(outcome.refusal.code).toBe("TYPE_MISMATCH");
  });

  test("a timeout is INTERRUPTED and never a TimeoutError", async () => {
    // `trino/index.ts:680` mints a TimeoutError directly, and `src/lib/api/errors.ts:108-120`
    // answers that 408 `retryable: true`. A client that retries an apply whose disposition is
    // unknown applies twice.
    const outcome = await applyWithTrinoError(new TimeoutError("Query timed out"));
    if (outcome.outcome !== "interrupted") throw new Error("narrowing");
    expect(outcome.committed).toBe("unknown");
  });

  test("the engine's OWN timeout fault is interrupted too, which is the arm the mapper would 408", async () => {
    // The wire shape a real deadline produces: EXCEEDED_TIME_LIMIT is the fault name the transport
    // categorises `timeout`, and that category is what `mapTrinoError` turns into a TimeoutError.
    const outcome = await applyWithTrinoError({
      errorName: "EXCEEDED_TIME_LIMIT",
      errorCode: 66,
      message: "Query exceeded maximum time limit of 1.00m",
    });
    if (outcome.outcome !== "interrupted") throw new Error("narrowing");
    expect(outcome.committed).toBe("unknown");
    expect(outcome.sentence).toContain("Query exceeded maximum time limit");
  });

  test("a cancelled apply is interrupted, because the disposition of the write is unknown", async () => {
    const outcome = await applyWithTrinoError({
      errorName: "USER_CANCELED",
      errorCode: 6,
      message: "Query was canceled",
    });
    if (outcome.outcome !== "interrupted") throw new Error("narrowing");
    expect(outcome.committed).toBe("unknown");
  });

  test("a command unit is not a shape this provider ever issues, and it RAISES", async () => {
    const provider = await editProvider();
    const plan = await forcedPlan(EDITED);
    if (plan.unit.medium !== "statement") throw new Error("narrowing");
    const [payload] = plan.unit.steps;
    await expect(
      provider.applyObjectEdit!({
        ...plan,
        unit: { medium: "command", name: "FUNCTION", arguments: ["LOAD"], payload },
      }),
    ).rejects.toThrow("A Trino object edit plan carries a statement unit, received a command");
  });

  test("a re-read that answers NO ROW for the addressed overload is a conflict with an empty text", async () => {
    // The object was DROPPED between the build and the apply. Nothing is sent, and the diff H3
    // requires shows the reader their text against nothing, which is what is there.
    const provider = await editProvider();
    serveInstead(SHOW_PLUS_ONE, sourceRows("Create Function", [READ_TEXT]));
    const plan = await planOn(provider, EDITED);
    const mark = sentSql.length;
    serveInstead(SHOW_PLUS_ONE, sourceRows("Create Function", [CREATE_PLUS_ONE_DOUBLE]));
    const outcome = await provider.applyObjectEdit!(plan);
    if (outcome.outcome !== "conflict" || outcome.conflict !== "object-changed") throw new Error("narrowing");
    expect(outcome.current.text).toBe("");
    expect(sentSql.slice(mark)).toEqual([SHOW_PLUS_ONE]);
  });
});

describe("Trino object edit: the derivations, driven to their BOUND values", () => {
  /**
   * Standing ruling 5g (#789), and Trino needs BOTH halves of it.
   *
   * A two-level engine makes the naive test pass for an implementation that hardcodes
   * `catalog = path[0]`, because on the declared order that bind is right. The second
   * declaration SWAPS the two levels and feeds a path in the swapped order, where the same
   * three values must still reach the coordinator.
   */
  const LEVELS = {
    declared: [
      { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
      { id: "schema", label: "Schema", labelPlural: "Schemas" },
    ],
    swapped: [
      { id: "schema", label: "Schema", labelPlural: "Schemas" },
      { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
    ],
  } as const;

  for (const [shape, path] of [
    ["declared", ["memory", "app", "plus_one(bigint)"]],
    ["swapped", ["app", "memory", "plus_one(bigint)"]],
  ] as const) {
    test(`the ${shape} declaration sends the same three values to the coordinator`, async () => {
      const provider = await editProvider();
      const real = provider.getCapabilities();
      spyOn(provider, "getCapabilities").mockReturnValue({
        ...real,
        containerLevels: [...LEVELS[shape]],
      } as ProviderCapabilities);
      serveInstead(SHOW_PLUS_ONE, sourceRows("Create Function", [READ_TEXT]));
      const build = await buildOn(provider, EDITED, path);
      if (!build.built) throw new Error(build.refusal.sentence);
      // The BOUND value and not a refusal: the statement that reached the cluster.
      expect(sqlWith("SHOW CREATE FUNCTION")).toBe('SHOW CREATE FUNCTION "memory"."app"."plus_one"');
      expect(sqlWith("SHOW FUNCTIONS")).toBe('SHOW FUNCTIONS FROM "memory"."app"');
      expect(build.plan.path).toEqual([...path]);
    });
  }

  /**
   * A plan addressed at one path and nothing else, built by hand so the apply's FIRST round trip
   * can be observed for a function the build's own checks would never issue a plan for.
   *
   * The revision token is deliberately not any definition's digest, so the apply answers
   * `conflict` after its re-read and sends nothing. The statement that re-read sent is the whole
   * subject of the test below.
   */
  function addressedPlan(path: readonly string[]): ObjectEditPlan {
    const text = "CREATE OR REPLACE FUNCTION memory.app.unused() RETURNS bigint RETURN 1";
    return {
      planVersion: 1,
      planId: "the-cross-resolver-probe",
      issuedAt: "2026-09-14T00:00:00.000Z",
      connectionFingerprint: "not-checked-by-the-provider",
      type: "trino",
      path: [...path],
      kind: EDIT_KIND,
      partId: TRINO_SOURCE_PART_ID,
      strategy: "replace-in-place-statement",
      unit: {
        medium: "statement",
        steps: [{ text, language: "sql", segments: [{ from: "user", start: 0, end: text.length }] }],
      },
      session: [],
      revision: {
        check: "compared",
        token: "no-definition-hashes-to-this",
        basis: "SHOW CREATE FUNCTION",
        scope: "server",
      },
      consequences: [],
    };
  }

  test("the BUILD's resolver and the APPLY's address the same statement, over every function in the fixture", async () => {
    /*
     * THE TWO RESOLVERS, DRIVEN AGAINST EACH OTHER RATHER THAN READ (#789, external review of PR
     * #831, item 6). This provider resolves an overload TWICE by two different routes, and until
     * this test nothing compared them: `buildObjectEdit` calls `resolveOverload`, which matches
     * `functionSegment(name, argumentTypes)` against the live `SHOW FUNCTIONS` reply, and
     * `applyObjectEdit` calls `readOverload`, which PARSES the path segment with
     * `trinoFunctionSegmentParts` so its re-read can be its first round trip. If those two ever
     * name different functions, the plan is built against one object and the apply re-reads
     * another, which is ruling 1a failing on its own terms.
     *
     * MEASURED, and it is the reason this is a statement comparison rather than a round trip of
     * the helper: with the parse mutated to a LEFT-TO-RIGHT scan, the pre-existing round-trip
     * test below is the ONLY test in this file that turns red, 187 pass 1 fail, so nothing
     * measured what the drift does to the APPLY. Under the same mutation this test fails on
     * `we(ird`, where the build sends `SHOW CREATE FUNCTION "memory"."app"."we(ird"` and the
     * apply sends `..."we"`.
     *
     * Both calls are expected to end badly and that is deliberate: the build finds no row whose
     * parameter list matches and raises, and the apply's re-read answers a conflict. Neither
     * outcome is the subject. The STATEMENT each sent is.
     */
    const statement = trinoSourceStatementFor(EDIT_KIND);
    for (const row of MEMORY_APP_FUNCTION_ROWS) {
      const [name, , argumentTypes] = row as [string, string, string];
      const path = ["memory", "app", functionSegment(name, argumentTypes)];
      const provider = await editProvider();

      const beforeBuild = sentSql.length;
      await buildOn(provider, "CREATE FUNCTION not_the_definition()", path).catch(() => undefined);
      const built = sentSql.slice(beforeBuild).filter((sql) => sql.startsWith("SHOW CREATE FUNCTION"));

      const beforeApply = sentSql.length;
      await provider.applyObjectEdit!(addressedPlan(path)).catch(() => undefined);
      const applied = sentSql.slice(beforeApply).filter((sql) => sql.startsWith("SHOW CREATE FUNCTION"));

      // The BOUND value on both sides, so a test that stopped sending anything cannot pass by
      // comparing two empty lists.
      expect(built).toEqual([trinoObjectSourceSql(statement, "memory", "app", name)]);
      expect(applied).toEqual(built);
    }
  });

  test("the path segment inverse round-trips every function the fixture holds", async () => {
    // `trinoFunctionSegmentParts` is what lets the apply address the object from the plan alone,
    // and the fixture is what makes it non-vacuous: `we(ird` puts a parenthesis inside the NAME,
    // `rowparen` puts one inside a QUOTED row field, `hard` nests three levels and `answer` has an
    // empty list.
    for (const row of MEMORY_APP_FUNCTION_ROWS) {
      const [name, , argumentTypes] = row as [string, string, string];
      const segment = functionSegment(name, argumentTypes);
      expect(trinoFunctionSegmentParts(segment)).toEqual({ name, argumentTypes });
    }
  });

  test("the path segment inverse round-trips shapes BEYOND the fixture, name and type list alike", () => {
    /*
     * THE FIXTURE IS NINE ROWS AND THE PROPERTY IS UNIVERSAL, so the population is widened here
     * rather than left at whatever `docker/trino-init/01-object-fixture.sql` happens to create
     * (#789, external review of PR #831, item 6). Everything below is a shape a quoted Trino
     * identifier can hold: `CREATE FUNCTION memory.app."we(ird"(x bigint)` is in the fixture and
     * is the measured proof that a delimited name reaches `SHOW FUNCTIONS` with its punctuation
     * intact, and the same delimiter admits `)`, `"` and a trailing `(`.
     *
     * WHAT THE PROPERTY IS, stated so a later reader can see why the list is a list and not a
     * proof: for any `name` and any `argumentTypes` whose parentheses and quotes BALANCE, the
     * close parenthesis `functionSegment` appends is matched by the open parenthesis
     * `functionSegment` appends, so a right-to-left depth scan can only stop there. A name's own
     * punctuation is never reached, because the scan returns before entering it. That is an
     * argument and not a measurement, which is exactly why the cases below are RUN.
     *
     * A LEFT-TO-RIGHT SCAN IS THE DRIFT THIS GUARDS, and it is measured: mutated that way, this
     * file is 187 pass 3 fail, the fixture round trip above fails on `we(ird`, and this one fails
     * on the SECOND row, `a(b)c`, which comes back as `{name: "a", argumentTypes: "b)c(bigint"}`.
     * The FIRST row is not the one that kills it and the round-1 spelling of this line said it
     * was: `we)ird(bigint)` has its first `(` at index 6, so a left-to-right scan round-trips it
     * correctly. Row two is load-bearing and row one is not; do not trim the list to row one.
     */
    const beyond: readonly (readonly [string, string])[] = [
      // A close parenthesis in the NAME, which the fixture has no example of.
      ["we)ird", "bigint"],
      // Both, and balanced, so a scan that counted the name's parentheses would come out even
      // and still be wrong.
      ["a(b)c", "bigint"],
      // A name that ENDS with the character the scan is looking for.
      ["trail(", "bigint"],
      // A name that BEGINS with the character that raises the depth.
      [")lead", "bigint"],
      // A bare double quote in the name, which flips the scan's quote state if it is reached.
      ['q"uote', "bigint"],
      // An empty argument list behind a name holding a parenthesis: the segment then ends
      // `((` `)` with nothing between, which is the shortest ambiguous-looking shape there is.
      ["we(ird", ""],
      // Three levels of nesting inside the type list, with a quoted `)` at the deepest one.
      ["nested", 'array(row("a)b" bigint,"c" array(varchar)))'],
      // The fixture's hardest name and its hardest type list at once, which it never combines.
      ["we(ird", 'decimal(10,2), array(varchar), row("a)b" bigint,"c" varchar)'],
      // Trino's doubled-quote escape inside a row field name, which toggles twice either way.
      ["doubled", 'row("a""b" bigint)'],
    ];
    for (const [name, argumentTypes] of beyond) {
      expect(trinoFunctionSegmentParts(functionSegment(name, argumentTypes))).toEqual({ name, argumentTypes });
    }
  });

  test("a segment that is not a segment shape at all answers null rather than a wrong name", async () => {
    // `bigint)` is the case the loop EXHAUSTS on: it ends with a close parenthesis, so the scan
    // starts, and no open parenthesis ever brings the depth back to zero.
    for (const notASegment of ["plus_one", "", "(bigint)", "plus_one(bigint", ")(", "bigint)"]) {
      expect(trinoFunctionSegmentParts(notASegment)).toBeNull();
    }
  });

  test("the splice anchor is the end of the FIRST TOKEN, whitespace and case included", () => {
    expect(trinoSpliceAt("CREATE FUNCTION f()")).toBe(6);
    expect(trinoSpliceAt("  create\nFUNCTION f()")).toBe(8);
    expect(trinoSpliceAt("CREATE")).toBe(6);
    expect(trinoSpliceAt("ALTER FUNCTION f()")).toBeNull();
    expect(trinoSpliceAt("   ")).toBeNull();
    expect(trinoSpliceAt("")).toBeNull();
  });

  test("the coordinate conversion answers null for every coordinate that is not IN the text", () => {
    // THE CONTRACT OF THE EXPORTED FUNCTION, and it is asserted here because the caller hides
    // two of these three shapes: `userPositionOf` answers `outside` for a negative, a fractional
    // and an out-of-range offset on its own, so at the provider they are indistinguishable from
    // a correct null. WHICH ONE THE PRODUCT DEPENDS ON is separated out rather than blurred: the
    // `lineNumber` shapes are pinned end to end in "the apply" above, because without them the
    // offset is a REAL position and the reader gets a marker on a token the engine never named.
    const text = "one\ntwo\nthree";
    expect(trinoSentOffsetOf(text, 1, 1)).toBe(0);
    expect(trinoSentOffsetOf(text, 2, 3)).toBe(6);
    expect(trinoSentOffsetOf(text, 3, 5)).toBe(12);
    // End of input, which is the coordinate a `mismatched input '<EOF>'` reports: measured on
    // 476, `lastLine.length + 1`, resolving to exactly `text.length`.
    expect(trinoSentOffsetOf(text, 3, 6)).toBeNull();
    expect(trinoSentOffsetOf(text, 4, 1)).toBeNull();
    expect(trinoSentOffsetOf(text, 0, 1)).toBeNull();
    expect(trinoSentOffsetOf(text, 1.5, 1)).toBeNull();
    expect(trinoSentOffsetOf(text, 1, 0)).toBeNull();
    expect(trinoSentOffsetOf(text, 1, 1.5)).toBeNull();
  });
});

// ============================================================================
// endOpenQueryTransaction(): the absence is declared, not accidental (D75)
// ============================================================================

describe("endOpenQueryTransaction()", () => {
  /** The only three answers D75 accepts from a provider that does not implement the surface. */
  const ABSENCES = [
    "the engine has no transaction to leave open",
    "the driver cannot be asked",
    "nobody has measured it yet",
  ] as const;

  test("is not implemented, and the doc names WHICH absence that is", () => {
    const provider: DatabaseProvider = new TrinoProvider(makeConnection());

    expect(provider.endOpenQueryTransaction).toBeUndefined();

    // A boundary nobody wrote down becomes a fallback the next reader trusts, so the
    // absence has to be readable in the doc as well as in the type. Exactly one of the
    // three: "one of these two" is not an answer, and a doc that names none has not
    // declared anything.
    const doc = readFileSync(join(import.meta.dir, "../../../docs/providers/trino.md"), "utf8");
    expect(doc).toContain("endOpenQueryTransaction");

    // The set that DOES implement the surface is read from the type, never enumerated
    // here: a closed list repeated across the provider docs went stale the day a further
    // provider implemented the surface, which is exactly what happened during D75.
    expect(doc).not.toContain("`postgres`, `sqlite` and `duckdb`");
    expect(ABSENCES.filter((absence) => doc.includes(absence))).toEqual(["nobody has measured it yet"]);
  });

  test("the transport neither sends nor reads a transaction header, which is what leaves the question open", () => {
    // The code half of the doc's claim, pinned here so a future transport that DOES
    // carry the header cannot leave the doc saying nobody measured it.
    const transport = readFileSync(
      join(import.meta.dir, "../../../src/lib/db/providers/sql/trino/http-transport.ts"),
      "utf8",
    );

    expect(transport).not.toContain("Transaction-Id");
  });
});
