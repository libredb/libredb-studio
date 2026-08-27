/**
 * Trino schema introspection and monitoring (issue #424, Phase 2)
 *
 * Driven entirely through a hand-built query runner - the point of the seam: no
 * fetch mocking, no `mock.module()` (process-wide in bun) and no cluster. Every
 * row below is the record the transport rebuilds from a payload captured on
 * 2026-08-20 from a live Trino 476 (catalogs `tpch`, `tpcds`, `memory`, `system`,
 * `jmx`; schema tree read against `tpch`), so the fake speaks exactly what the
 * server speaks - including the shapes that break a naive mapper:
 *
 * 1. `SHOW STATS FOR "tpch"."tiny"."region"` answers one row per column PLUS a
 *    summary row whose `column_name` is null and whose `row_count` is the table's.
 *    Neither kind of row can be read without the other.
 * 2. In that same answer `data_size` is null for the `bigint` column and 34/330
 *    for the two varchars, so summing it yields the variable-width footprint and
 *    not the table's size.
 * 3. `SHOW STATS FOR "system"."runtime"."nodes"` answers the identical six-column
 *    shape with EVERY value null, summary row included - the ordinary answer from
 *    a connector that publishes no statistics.
 * 4. `system.runtime.queries` reports `source` as null for a client that sent no
 *    source header, and has no catalog column at all.
 * 5. The active-session read sees ITSELF as a RUNNING row, because the coordinator
 *    really is running it.
 */
import { describe, expect, test } from "bun:test";
import {
  getActiveSessions,
  getHealth,
  getIndexStats,
  getOverview,
  getPerformanceMetrics,
  getSchema,
  getSlowQueries,
  getStorageStats,
  getTableStats,
  TRINO_ACTIVE_QUERY_COUNT_SQL,
  TRINO_ACTIVE_QUERY_SQL,
  TRINO_CATALOG_LIST_SQL,
  TRINO_DEFAULT_SESSION_LIMIT,
  TRINO_DEFAULT_SLOW_QUERY_LIMIT,
  TRINO_JVM_RUNTIME_SQL,
  TRINO_MAX_STATS_TABLES,
  TRINO_METADATA_SCHEMA,
  TRINO_NODE_LIST_SQL,
  TRINO_QUERY_RATE_SQL,
  TRINO_SLOW_QUERY_SQL,
  TRINO_UNAVAILABLE_TEXT,
  TRINO_UNKNOWN_TEXT,
  type TrinoQueryRunner,
  trinoColumnListSql,
  trinoKillQuerySql,
  trinoTableCountSql,
  trinoTableListSql,
  trinoTableStatsSql,
} from "@/lib/db/providers/sql/trino/introspect";
import {
  type TrinoErrorCategory,
  type TrinoQueryResult,
  type TrinoRow,
  TrinoTransportError,
} from "@/lib/db/providers/sql/trino/transport";

const CATALOG = "tpch";

// ============================================================================
// Live-captured rows
// ============================================================================

/** `information_schema.tables`, trimmed from 72 rows to two schemas for length. */
const TABLE_ROWS: TrinoRow[] = [
  { schemaName: "tiny", tableName: "nation" },
  { schemaName: "tiny", tableName: "region" },
  { schemaName: "sf1", tableName: "customer" },
];

/**
 * `information_schema.columns`, captured with the schema narrowed to `tiny` for
 * length and trimmed to two tables. `columnDefault` is null on every row every
 * connector on the probe cluster returned.
 */
const COLUMN_ROWS: TrinoRow[] = [
  {
    schemaName: "tiny",
    tableName: "nation",
    columnName: "nationkey",
    dataType: "bigint",
    isNullable: "NO",
    columnDefault: null,
  },
  {
    schemaName: "tiny",
    tableName: "nation",
    columnName: "name",
    dataType: "varchar(25)",
    isNullable: "NO",
    columnDefault: null,
  },
  {
    schemaName: "tiny",
    tableName: "region",
    columnName: "regionkey",
    dataType: "bigint",
    isNullable: "NO",
    columnDefault: null,
  },
  {
    schemaName: "tiny",
    tableName: "region",
    columnName: "comment",
    dataType: "varchar(152)",
    isNullable: "YES",
    columnDefault: null,
  },
];

/** `SHOW STATS FOR "tpch"."tiny"."region"`, verbatim: three column rows and the summary. */
const REGION_STATS_ROWS: TrinoRow[] = [
  {
    column_name: "regionkey",
    data_size: null,
    distinct_values_count: 5,
    nulls_fraction: 0,
    row_count: null,
    low_value: "0",
    high_value: "4",
  },
  {
    column_name: "name",
    data_size: 34,
    distinct_values_count: 5,
    nulls_fraction: 0,
    row_count: null,
    low_value: null,
    high_value: null,
  },
  {
    column_name: "comment",
    data_size: 330,
    distinct_values_count: 5,
    nulls_fraction: 0,
    row_count: null,
    low_value: null,
    high_value: null,
  },
  {
    column_name: null,
    data_size: null,
    distinct_values_count: null,
    nulls_fraction: null,
    row_count: 5,
    low_value: null,
    high_value: null,
  },
];

/** `SHOW STATS FOR "tpch"."tiny"."nation"`, verbatim, trimmed to two column rows. */
const NATION_STATS_ROWS: TrinoRow[] = [
  {
    column_name: "nationkey",
    data_size: null,
    distinct_values_count: 25,
    nulls_fraction: 0,
    row_count: null,
    low_value: "0",
    high_value: "24",
  },
  {
    column_name: "name",
    data_size: 177,
    distinct_values_count: 25,
    nulls_fraction: 0,
    row_count: null,
    low_value: null,
    high_value: null,
  },
  {
    column_name: null,
    data_size: null,
    distinct_values_count: null,
    nulls_fraction: null,
    row_count: 25,
    low_value: null,
    high_value: null,
  },
];

/** A connector that publishes no statistics: every value null, summary row included. */
const NO_STATS_ROWS: TrinoRow[] = [
  {
    column_name: "custkey",
    data_size: null,
    distinct_values_count: null,
    nulls_fraction: null,
    row_count: null,
    low_value: null,
    high_value: null,
  },
  {
    column_name: null,
    data_size: null,
    distinct_values_count: null,
    nulls_fraction: null,
    row_count: null,
    low_value: null,
    high_value: null,
  },
];

/** `system.metadata.catalogs`, verbatim. */
const CATALOG_ROWS: TrinoRow[] = [
  { catalogName: "jmx", connectorName: "jmx" },
  { catalogName: "memory", connectorName: "memory" },
  { catalogName: "system", connectorName: "system" },
  { catalogName: "tpcds", connectorName: "tpcds" },
  { catalogName: "tpch", connectorName: "tpch" },
];

/** `system.runtime.nodes`, verbatim from the single-node probe cluster. */
const NODE_ROWS: TrinoRow[] = [
  { nodeId: "ba8be21e377c", nodeVersion: "476", isCoordinator: true, nodeState: "active" },
];

/** `jmx.current."java.lang:type=runtime"`, verbatim. */
const JVM_ROWS: TrinoRow[] = [{ startedAtMillis: 1787180899080, uptimeMs: 4284672 }];

/** `jmx.current."trino.execution:name=querymanager"`, verbatim. */
const RATE_ROWS: TrinoRow[] = [{ completedPerSecond: 0.10457480807630157 }];

const ACTIVE_COUNT_ROWS: TrinoRow[] = [{ activeQueries: 1 }];
const TABLE_COUNT_ROWS: TrinoRow[] = [{ tableCount: 72 }];

/** The active-session read seeing itself, `source` null because the client sent none. */
const SESSION_ROWS: TrinoRow[] = [
  {
    queryId: "20260820_001943_00041_chvb7",
    state: "RUNNING",
    userName: "libredb",
    source: null,
    statement: 'SELECT query_id AS "queryId" FROM system.runtime.queries',
    createdAt: "2026-08-20T00:19:43.765Z",
    elapsedMs: 0,
  },
];

/** `system.runtime.queries`, verbatim, trimmed from ten rows to two. */
const SLOW_ROWS: TrinoRow[] = [
  {
    queryId: "20260819_231130_00006_chvb7",
    statement: "SELECT nationkey, name, regionkey FROM tpch.sf1.nation ORDER BY nationkey LIMIT 5",
    elapsedMs: 1543,
    queuedMs: 0,
  },
  {
    queryId: "20260819_231141_00019_chvb7",
    statement: "SELECT * FROM system.runtime.nodes",
    elapsedMs: 641,
    queuedMs: 0,
  },
];

// ============================================================================
// Fake query runner
// ============================================================================

/** Which read a recorded statement is. */
type Surface =
  | "tableList"
  | "columnList"
  | "tableCount"
  | "catalogList"
  | "nodeList"
  | "jvmRuntime"
  | "queryRate"
  | "activeCount"
  | "activeQueries"
  | "slowQueries"
  | "regionStats"
  | "nationStats"
  | "customerStats";

/**
 * The statement each surface must send, so a read is identified by the builder it
 * came from rather than by a substring. A statement the module invents that
 * matches none of these fails the test loudly instead of silently being served
 * another surface's rows.
 */
const SURFACE_SQL: Record<Surface, string> = {
  tableList: trinoTableListSql(CATALOG),
  columnList: trinoColumnListSql(CATALOG),
  tableCount: trinoTableCountSql(CATALOG),
  catalogList: TRINO_CATALOG_LIST_SQL,
  nodeList: TRINO_NODE_LIST_SQL,
  jvmRuntime: TRINO_JVM_RUNTIME_SQL,
  queryRate: TRINO_QUERY_RATE_SQL,
  activeCount: TRINO_ACTIVE_QUERY_COUNT_SQL,
  activeQueries: TRINO_ACTIVE_QUERY_SQL,
  slowQueries: TRINO_SLOW_QUERY_SQL,
  regionStats: trinoTableStatsSql(CATALOG, "tiny", "region"),
  nationStats: trinoTableStatsSql(CATALOG, "tiny", "nation"),
  customerStats: trinoTableStatsSql(CATALOG, "sf1", "customer"),
};

const SURFACES = Object.keys(SURFACE_SQL) as Surface[];

const DEFAULT_ROWS: Record<Surface, TrinoRow[]> = {
  tableList: TABLE_ROWS,
  columnList: COLUMN_ROWS,
  tableCount: TABLE_COUNT_ROWS,
  catalogList: CATALOG_ROWS,
  nodeList: NODE_ROWS,
  jvmRuntime: JVM_ROWS,
  queryRate: RATE_ROWS,
  activeCount: ACTIVE_COUNT_ROWS,
  activeQueries: SESSION_ROWS,
  slowQueries: SLOW_ROWS,
  regionStats: REGION_STATS_ROWS,
  nationStats: NATION_STATS_ROWS,
  customerStats: NO_STATS_ROWS,
};

/** `startsWith` because a row cap is appended to the two windowed reads. */
function surfaceOf(sql: string): Surface {
  // Longest first, so `SHOW STATS FOR "tpch"."tiny"."nation"` never matches a
  // shorter statement that happens to be its prefix.
  const matches = SURFACES.filter((surface) => sql.startsWith(SURFACE_SQL[surface])).sort(
    (left, right) => SURFACE_SQL[right].length - SURFACE_SQL[left].length,
  );
  if (matches.length === 0) throw new Error(`Unrecognised statement: ${sql}`);

  return matches[0] as Surface;
}

interface FakeOptions {
  rows?: Partial<Record<Surface, TrinoRow[]>>;
  /** Raised instead of returning rows, per surface. */
  failures?: Partial<Record<Surface, Error>>;
}

interface Fake {
  runner: TrinoQueryRunner;
  sent: string[];
}

function fakeRunner(options: FakeOptions = {}): Fake {
  const sent: string[] = [];

  return {
    sent,
    runner: {
      query(sql: string): Promise<TrinoQueryResult> {
        sent.push(sql);
        const surface = surfaceOf(sql);
        const failure = options.failures?.[surface];
        if (failure) return Promise.reject(failure);

        return Promise.resolve({
          rows: options.rows?.[surface] ?? DEFAULT_ROWS[surface],
          fieldNames: [],
          columnTypes: {},
          queryId: "20260820_000000_00000_chvb7",
          operation: null,
          affectedRows: null,
          warnings: [],
          stats: {
            state: "FINISHED",
            elapsedMs: 12,
            cpuMs: 3,
            queuedMs: 0,
            processedRows: 0,
            processedBytes: 0,
            peakMemoryBytes: 132,
          },
        });
      },
    },
  };
}

function unavailable(category: TrinoErrorCategory): TrinoTransportError {
  return new TrinoTransportError(category, "Catalog 'jmx' not found", "CATALOG_NOT_FOUND");
}

// ============================================================================
// Statements
// ============================================================================

describe("Trino introspection statements", () => {
  test("the table list excludes the metadata schema every catalog carries", () => {
    expect(trinoTableListSql(CATALOG)).toBe(
      'SELECT table_schema AS "schemaName", table_name AS "tableName" ' +
        'FROM "tpch".information_schema.tables ' +
        "WHERE table_schema <> 'information_schema' " +
        "ORDER BY table_schema, table_name",
    );
    expect(TRINO_METADATA_SCHEMA).toBe("information_schema");
  });

  test("the column list orders by declared position without projecting it", () => {
    const sql = trinoColumnListSql(CATALOG);
    expect(sql).toContain("ORDER BY table_schema, table_name, ordinal_position");
    expect(sql).not.toContain('ordinal_position AS "');
  });

  test("a catalog name carrying a double quote is escaped rather than closing the identifier", () => {
    expect(trinoTableListSql('we"ird')).toContain('FROM "we""ird".information_schema.tables');
  });

  test("the stats statement addresses all three levels, each quoted", () => {
    expect(trinoTableStatsSql(CATALOG, "tiny", "region")).toBe('SHOW STATS FOR "tpch"."tiny"."region"');
  });

  test("a kill target carrying an apostrophe is escaped rather than closing the literal", () => {
    expect(trinoKillQuerySql("it's_not_an_id", "bye")).toBe(
      "CALL system.runtime.kill_query(query_id => 'it''s_not_an_id', message => 'bye')",
    );
  });

  test("the catalog list reads system.metadata rather than SHOW CATALOGS, whose column cannot be aliased", () => {
    expect(TRINO_CATALOG_LIST_SQL).toContain("FROM system.metadata.catalogs");
    expect(TRINO_CATALOG_LIST_SQL).not.toContain("SHOW CATALOGS");
  });

  test("active statements are the complement of the two terminal states", () => {
    expect(TRINO_ACTIVE_QUERY_SQL).toContain("WHERE state <> 'FINISHED' AND state <> 'FAILED'");
    expect(TRINO_ACTIVE_QUERY_COUNT_SQL).toContain("WHERE state <> 'FINISHED' AND state <> 'FAILED'");
  });

  test("the slow-query read measures execution and not the queue wait", () => {
    expect(TRINO_SLOW_QUERY_SQL).toContain("date_diff('millisecond', started, \"end\")");
    expect(TRINO_SLOW_QUERY_SQL).toContain('ORDER BY "elapsedMs" DESC');
  });
});

// ============================================================================
// Schema
// ============================================================================

describe("Trino getSchema", () => {
  test("names every table schema-qualified, because a bare name resolves against no session schema", async () => {
    const { runner } = fakeRunner();
    const schema = await getSchema(runner, CATALOG);

    expect(schema.map((table) => table.name)).toEqual(["tiny.nation", "tiny.region", "sf1.customer"]);
  });

  test("places each column against its own table, keyed by schema and name together", async () => {
    const { runner } = fakeRunner();
    const schema = await getSchema(runner, CATALOG);

    expect(schema[0]?.columns).toEqual([
      { name: "nationkey", type: "bigint", nullable: false, isPrimary: false },
      { name: "name", type: "varchar(25)", nullable: false, isPrimary: false },
    ]);
    expect(schema[1]?.columns.map((column) => column.name)).toEqual(["regionkey", "comment"]);
  });

  test("reads IS_NULLABLE, and treats anything but NO as nullable", async () => {
    const { runner } = fakeRunner();
    const schema = await getSchema(runner, CATALOG);

    expect(schema[1]?.columns[1]?.nullable).toBe(true);
  });

  test("carries a column default when the connector published one", async () => {
    const { runner } = fakeRunner({
      rows: {
        columnList: [
          {
            schemaName: "tiny",
            tableName: "nation",
            columnName: "n",
            dataType: "integer",
            isNullable: "YES",
            columnDefault: "42",
          },
        ],
      },
    });
    const schema = await getSchema(runner, CATALOG);

    expect(schema[0]?.columns[0]?.defaultValue).toBe("42");
  });

  test("declares no index and no foreign key, because Trino publishes neither anywhere", async () => {
    const { runner } = fakeRunner();
    const schema = await getSchema(runner, CATALOG);

    expect(schema.every((table) => table.indexes.length === 0)).toBe(true);
    expect(schema.every((table) => table.foreignKeys?.length === 0)).toBe(true);
    expect(schema.every((table) => table.columns.every((column) => !column.isPrimary))).toBe(true);
  });

  test("a table with no column rows is still listed, with no columns", async () => {
    const { runner } = fakeRunner({ rows: { columnList: [] } });
    const schema = await getSchema(runner, CATALOG);

    expect(schema).toHaveLength(3);
    expect(schema[0]?.columns).toEqual([]);
  });

  test("drops a row it cannot place rather than failing the whole tree", async () => {
    const { runner } = fakeRunner({
      rows: {
        tableList: [{ schemaName: "tiny", tableName: null }, ...TABLE_ROWS],
        columnList: [{ schemaName: "tiny", tableName: "nation", columnName: "" }, ...COLUMN_ROWS],
      },
    });
    const schema = await getSchema(runner, CATALOG);

    expect(schema).toHaveLength(3);
    expect(schema[0]?.columns).toHaveLength(2);
  });

  test("propagates a failure rather than showing an empty tree", async () => {
    const { runner } = fakeRunner({ failures: { tableList: unavailable("unknown-object") } });

    await expect(getSchema(runner, CATALOG)).rejects.toThrow("Catalog 'jmx' not found");
  });
});

// ============================================================================
// Overview
// ============================================================================

describe("Trino getOverview", () => {
  test("reports the coordinator's version, its uptime and the tables of the pinned catalog", async () => {
    const { runner } = fakeRunner();
    const overview = await getOverview(runner, CATALOG);

    expect(overview.version).toBe("476");
    expect(overview.uptime).not.toBe(TRINO_UNKNOWN_TEXT);
    expect(overview.startTime).toEqual(new Date(1787180899080));
    expect(overview.tableCount).toBe(72);
    expect(overview.activeConnections).toBe(1);
  });

  test("prefers the row that says it is the coordinator over the first row", async () => {
    const { runner } = fakeRunner({
      rows: {
        nodeList: [
          { nodeId: "worker-1", nodeVersion: "475", isCoordinator: false, nodeState: "active" },
          { nodeId: "coord", nodeVersion: "476", isCoordinator: true, nodeState: "active" },
        ],
      },
    });

    expect((await getOverview(runner, CATALOG)).version).toBe("476");
  });

  test("falls back to the first node when no row claims to be the coordinator", async () => {
    const { runner } = fakeRunner({
      rows: { nodeList: [{ nodeId: "worker-1", nodeVersion: "475", isCoordinator: false, nodeState: "active" }] },
    });

    expect((await getOverview(runner, CATALOG)).version).toBe("475");
  });

  test("publishes no size, because Trino stores nothing", async () => {
    const { runner } = fakeRunner();
    const overview = await getOverview(runner, CATALOG);

    expect(overview.databaseSize).toBe(TRINO_UNAVAILABLE_TEXT);
    // The key is ABSENT, which is what this test's name has always said. It used to
    // assert 0 - a measurement, in the same object whose `databaseSize` said the figure
    // is unavailable (docs/BACKLOG.md D44). `in` is the assertion that distinguishes a
    // missing key from one present holding `undefined`; `toBeUndefined()` passes for both.
    expect("databaseSizeBytes" in overview).toBe(false);
  });

  test("publishes no connection ceiling and no index count", async () => {
    const { runner } = fakeRunner();
    const overview = await getOverview(runner, CATALOG);

    expect(overview.maxConnections).toBe(0);
    expect(overview.indexCount).toBe(0);
  });

  test("says the uptime is unknown rather than zero when the jmx catalog is not configured", async () => {
    const { runner } = fakeRunner({ failures: { jvmRuntime: unavailable("unknown-object") } });
    const overview = await getOverview(runner, CATALOG);

    expect(overview.uptime).toBe(TRINO_UNKNOWN_TEXT);
    expect(overview.startTime).toBeUndefined();
  });

  test("says the version is unknown when the cluster declines to describe its nodes", async () => {
    const { runner } = fakeRunner({ failures: { nodeList: unavailable("auth") } });

    expect((await getOverview(runner, CATALOG)).version).toBe(TRINO_UNKNOWN_TEXT);
  });

  test("reads an absent scalar row as zero rather than NaN", async () => {
    const { runner } = fakeRunner({ rows: { tableCount: [], activeCount: [] } });
    const overview = await getOverview(runner, CATALOG);

    expect(overview.tableCount).toBe(0);
    expect(overview.activeConnections).toBe(0);
  });

  test("reads a count the wire had to quote to keep it exact", async () => {
    // A `bigint` past 2^53 cannot survive JSON.parse as a number, so a catalog that
    // really holds that many tables can only arrive as text.
    const { runner } = fakeRunner({ rows: { tableCount: [{ tableCount: "9007199254740993" }] } });

    // Written as an expression rather than as the literal `9007199254740993`: that
    // literal is not representable as a double, so `no-loss-of-precision` refuses it -
    // which is the very fact this test is about.
    expect((await getOverview(runner, CATALOG)).tableCount).toBe(Number("9007199254740993"));
  });

  test("reads unparseable text as nothing rather than as NaN", async () => {
    const { runner } = fakeRunner({ rows: { tableCount: [{ tableCount: "many" }] } });

    expect((await getOverview(runner, CATALOG)).tableCount).toBe(0);
  });

  test("propagates a failure that is not an availability failure", async () => {
    const { runner } = fakeRunner({ failures: { tableCount: unavailable("timeout") } });

    await expect(getOverview(runner, CATALOG)).rejects.toThrow("Catalog 'jmx' not found");
  });
});

// ============================================================================
// Performance
// ============================================================================

describe("Trino getPerformanceMetrics", () => {
  test("reports the coordinator's own completed-query rate, rounded", async () => {
    const { runner } = fakeRunner();

    expect(await getPerformanceMetrics(runner)).toEqual({ queriesPerSecond: 0.1 });
  });

  test("omits every metric this engine does not measure, rather than reporting a zero", async () => {
    const { runner } = fakeRunner();
    const metrics = await getPerformanceMetrics(runner);

    expect(metrics.cacheHitRatio).toBeUndefined();
    expect(metrics.transactionsPerSecond).toBeUndefined();
    expect(metrics.bufferPoolUsage).toBeUndefined();
    expect(metrics.deadlocks).toBeUndefined();
    expect(metrics.checkpointWriteTime).toBeUndefined();
  });

  test("answers nothing at all when the jmx catalog is not configured", async () => {
    const { runner } = fakeRunner({ failures: { queryRate: unavailable("unknown-object") } });

    expect(await getPerformanceMetrics(runner)).toEqual({});
  });

  test("answers nothing when the row carries no readable rate", async () => {
    const { runner } = fakeRunner({ rows: { queryRate: [{ completedPerSecond: null }] } });

    expect(await getPerformanceMetrics(runner)).toEqual({});
  });
});

// ============================================================================
// Slow queries and sessions
// ============================================================================

describe("Trino getSlowQueries", () => {
  test("reports one execution per row, so the total and the average are the same number", async () => {
    const { runner } = fakeRunner();
    const slow = await getSlowQueries(runner);

    expect(slow[0]).toEqual({
      queryId: "20260819_231130_00006_chvb7",
      query: "SELECT nationkey, name, regionkey FROM tpch.sf1.nation ORDER BY nationkey LIMIT 5",
      calls: 1,
      totalTime: 1543,
      avgTime: 1543,
      rows: 0,
    });
  });

  test("caps the window at the caller's limit, and at its own when the caller names none", async () => {
    const { runner, sent } = fakeRunner();
    await getSlowQueries(runner);
    await getSlowQueries(runner, { limit: 3 });
    await getSlowQueries(runner, { limit: 0 });

    expect(sent[0]?.endsWith(` LIMIT ${TRINO_DEFAULT_SLOW_QUERY_LIMIT}`)).toBe(true);
    expect(sent[1]?.endsWith(" LIMIT 3")).toBe(true);
    expect(sent[2]?.endsWith(` LIMIT ${TRINO_DEFAULT_SLOW_QUERY_LIMIT}`)).toBe(true);
  });

  test("degrades to nothing when system.runtime is not granted", async () => {
    const { runner } = fakeRunner({ failures: { slowQueries: unavailable("auth") } });

    expect(await getSlowQueries(runner)).toEqual([]);
  });

  test("never reports a negative elapsed time, however the clocks read", async () => {
    const { runner } = fakeRunner({ rows: { slowQueries: [{ queryId: "q", statement: "s", elapsedMs: -26 }] } });

    expect((await getSlowQueries(runner))[0]?.avgTime).toBe(0);
  });
});

describe("Trino getActiveSessions", () => {
  test("describes a statement in flight, with the coordinator's own elapsed time", async () => {
    const { runner } = fakeRunner();
    const sessions = await getActiveSessions(runner);

    expect(sessions[0]?.pid).toBe("20260820_001943_00041_chvb7");
    expect(sessions[0]?.user).toBe("libredb");
    expect(sessions[0]?.state).toBe("RUNNING");
    expect(sessions[0]?.queryStart).toEqual(new Date("2026-08-20T00:19:43.765Z"));
    expect(sessions[0]?.durationMs).toBe(0);
  });

  test("leaves the database blank, because the coordinator records no catalog for a statement", async () => {
    const { runner } = fakeRunner();

    expect((await getActiveSessions(runner))[0]?.database).toBe("");
  });

  test("leaves the application blank for a client that sent no source header", async () => {
    const { runner } = fakeRunner();

    expect((await getActiveSessions(runner))[0]?.applicationName).toBe("");
  });

  test("reports the source a client did send", async () => {
    const { runner } = fakeRunner({
      rows: { activeQueries: [{ ...SESSION_ROWS[0], source: "trino-cli" }] },
    });

    expect((await getActiveSessions(runner))[0]?.applicationName).toBe("trino-cli");
  });

  test("leaves the start time undefined when the server rendered nothing readable", async () => {
    const { runner } = fakeRunner({
      rows: { activeQueries: [{ ...SESSION_ROWS[0], createdAt: "not a timestamp" }] },
    });

    expect((await getActiveSessions(runner))[0]?.queryStart).toBeUndefined();
  });

  test("caps the window at the caller's limit, and at its own when the caller names none", async () => {
    const { runner, sent } = fakeRunner();
    await getActiveSessions(runner);
    await getActiveSessions(runner, { limit: 5 });

    expect(sent[0]?.endsWith(` LIMIT ${TRINO_DEFAULT_SESSION_LIMIT}`)).toBe(true);
    expect(sent[1]?.endsWith(" LIMIT 5")).toBe(true);
  });

  test("degrades to nothing when system.runtime is not granted", async () => {
    const { runner } = fakeRunner({ failures: { activeQueries: unavailable("auth") } });

    expect(await getActiveSessions(runner)).toEqual([]);
  });
});

// ============================================================================
// Table stats
// ============================================================================

describe("Trino getTableStats", () => {
  test("reads the summary row for the count and the column rows for the size", async () => {
    const { runner } = fakeRunner();
    const { tables, refusal } = await getTableStats(runner, CATALOG, { schema: "tiny" });

    expect(refusal).toBeUndefined();
    expect(tables).toEqual([
      {
        schemaName: "tiny",
        tableName: "nation",
        rowCount: 25,
        tableSize: "177 B",
        tableSizeBytes: 177,
        totalSize: "177 B",
        totalSizeBytes: 177,
      },
      {
        schemaName: "tiny",
        tableName: "region",
        rowCount: 5,
        tableSize: "364 B",
        tableSizeBytes: 364,
        totalSize: "364 B",
        totalSizeBytes: 364,
      },
    ]);
  });

  test("omits a table whose connector published no row count, rather than calling it empty", async () => {
    const { runner } = fakeRunner();
    const { tables } = await getTableStats(runner, CATALOG);

    expect(tables.map((table) => table.tableName)).toEqual(["nation", "region"]);
  });

  test("asks SHOW STATS once per table, never a catalog-wide aggregate", async () => {
    const { runner, sent } = fakeRunner();
    await getTableStats(runner, CATALOG, { schema: "tiny" });

    expect(sent.filter((sql) => sql.startsWith("SHOW STATS FOR"))).toEqual([
      'SHOW STATS FOR "tpch"."tiny"."nation"',
      'SHOW STATS FOR "tpch"."tiny"."region"',
    ]);
  });

  /*
    #515: the pass used to describe the first 25 tables of an oversized scope and return
    them as the answer, and no consumer could see that anything had been dropped -
    `TableStats[]` has no field for "there were more", `MonitoringData.tables` is that
    same array, and the agent's curated reading published its length as `rowCount`. A cap
    read as a count is the absence lie one size up, so an oversized scope now REFUSES,
    which is the answer the agent's own row bound already gives (`READING_OVER_BUDGET` in
    src/lib/agent/tools.ts) and for the same reason.

    Measured 2026-08-27 against Trino 476: every built-in catalog but `memory` is over the
    bound (`tpch` 72 tables, `system` 26, `tpcds` 250, `jmx` 379), and the tpch pass never
    reached the `tiny` schema at all - it sorts last, so the 25 statements went to sf1,
    sf100, sf1000 and sf10000.customer, of which only sf1 publishes row counts. The panel
    therefore answered 8 rows for a 72-table catalog and named none of the tables the
    fixtures use.
  */
  test("refuses a scope larger than one pass rather than describing the first 25 of it", async () => {
    const many: TrinoRow[] = Array.from({ length: TRINO_MAX_STATS_TABLES + 1 }, () => ({
      schemaName: "tiny",
      tableName: "region",
    }));
    const { runner } = fakeRunner({ rows: { tableList: many } });
    const { tables, refusal } = await getTableStats(runner, CATALOG);

    expect(tables).toEqual([]);
    expect(refusal).toContain(`Catalog "tpch" holds ${TRINO_MAX_STATS_TABLES + 1} tables`);
    expect(refusal).toContain(`more than the ${TRINO_MAX_STATS_TABLES} one pass describes`);
    // The scope word, not just the scope's name: an unnarrowed read is refused because
    // 25 rows would be read as the CATALOG's table count. The narrowed test below pins
    // the other arm of the same ternary, which one line of coverage cannot tell apart.
    expect(refusal).toContain("read as the catalog's table count");
  });

  /*
    The catalog-scope advice used to read "Ask for a single schema and the whole of it is
    described", and that is not true of a schema which is itself over the bound - this
    provider's own measurements name one, jmx holding 379 tables in schema `current`. The
    advice is now conditional on a figure the reading already has: the table list is a
    single uncapped read that has already answered for the whole catalog, so which
    schemas a narrowed pass would describe is known before any SHOW STATS is sent.
  */
  test("names how many schemas a narrowed pass would describe, rather than promising all of them", async () => {
    // Eight tables in each of nine schemas is the shape the tpch connector publishes -
    // tiny, sf1, sf100, sf300, sf1000, sf3000, sf10000, sf30000, sf100000, of customer,
    // lineitem, nation, orders, part, partsupp, region, supplier - and is where the
    // measured 72 comes from. Two more schemas are added to pin the boundary of the
    // figure itself: one of exactly the bound, which IS describable, and one of one
    // more, which is not and must not be counted among the narrowings offered.
    const eight = ["customer", "lineitem", "nation", "orders", "part", "partsupp", "region", "supplier"];
    const nine = ["tiny", "sf1", "sf100", "sf300", "sf1000", "sf3000", "sf10000", "sf30000", "sf100000"];
    const listed: TrinoRow[] = [
      ...nine.flatMap((schemaName) => eight.map((tableName) => ({ schemaName, tableName }))),
      ...Array.from({ length: TRINO_MAX_STATS_TABLES }, (_unused, index) => ({
        schemaName: "at_the_bound",
        tableName: `t${index}`,
      })),
      ...Array.from({ length: TRINO_MAX_STATS_TABLES + 1 }, (_unused, index) => ({
        schemaName: "over_the_bound",
        tableName: `t${index}`,
      })),
    ];
    const { runner } = fakeRunner({ rows: { tableList: listed } });
    const { tables, refusal } = await getTableStats(runner, CATALOG);

    expect(tables).toEqual([]);
    expect(refusal).toContain('Catalog "tpch" holds 123 tables'); // 72 + 25 + 26
    expect(refusal).toContain("Narrowing to one schema describes the whole of it when");
    expect(refusal).toContain("which holds for 10 of the schemas this catalog's tables are in");
    expect(refusal).toContain('SHOW STATS FOR "tpch"."<schema>"."<table>"');
  });

  test("says plainly that no narrowing is left when every schema is over the bound as well", async () => {
    // The shape jmx has: measured 2026-08-27 against Trino 476 it holds 379 tables and
    // every one of them is in `current`, so the narrowing the advice used to offer lands
    // on this same refusal one level down. Advice pointing at a scope that is also
    // refused is worse than no advice, so the sentence offers the per-table statement -
    // the one route that answers for any scope - and says so instead.
    const many: TrinoRow[] = Array.from({ length: TRINO_MAX_STATS_TABLES + 1 }, (_unused, index) => ({
      schemaName: "current",
      tableName: `mbean${index}`,
    }));
    const { runner } = fakeRunner({ rows: { tableList: many } });
    const { refusal } = await getTableStats(runner, CATALOG);

    expect(refusal).toContain("Narrowing to one schema does not help here");
    expect(refusal).toContain("every schema this catalog's tables are in is over the bound as well");
    expect(refusal).toContain('SHOW STATS FOR "tpch"."<schema>"."<table>"');
  });

  test("sends no SHOW STATS at all for a scope it refuses, so the refusal costs less than the cut did", async () => {
    const many: TrinoRow[] = Array.from({ length: TRINO_MAX_STATS_TABLES + 1 }, () => ({
      schemaName: "tiny",
      tableName: "region",
    }));
    const { runner, sent } = fakeRunner({ rows: { tableList: many } });
    await getTableStats(runner, CATALOG);

    expect(sent.filter((sql) => sql.startsWith("SHOW STATS FOR"))).toEqual([]);
  });

  test("describes a scope exactly at the bound in full, because nothing is dropped there", async () => {
    const exactly: TrinoRow[] = Array.from({ length: TRINO_MAX_STATS_TABLES }, () => ({
      schemaName: "tiny",
      tableName: "region",
    }));
    const { runner, sent } = fakeRunner({ rows: { tableList: exactly } });
    const { tables, refusal } = await getTableStats(runner, CATALOG);

    expect(refusal).toBeUndefined();
    expect(tables).toHaveLength(TRINO_MAX_STATS_TABLES);
    expect(sent.filter((sql) => sql.startsWith("SHOW STATS FOR"))).toHaveLength(TRINO_MAX_STATS_TABLES);
  });

  test("answers a narrowed schema that fits even when its catalog does not", async () => {
    // The bound is applied to what was ASKED for, not to what the catalog holds: the
    // schema filter runs first, so `tiny` is describable in a catalog of any size. That
    // is what makes the refusal's advice something a caller can act on - the agent's
    // curated reading takes a `schema` - and it is the ONLY way to see `tiny` at all:
    // measured, it sorts last in tpch, so the catalog-wide pass spent its 25 statements
    // 64 tables short of it.
    const many: TrinoRow[] = Array.from({ length: TRINO_MAX_STATS_TABLES + 5 }, () => ({
      schemaName: "sf1",
      tableName: "customer",
    }));
    const { runner } = fakeRunner({
      rows: { tableList: [...many, { schemaName: "tiny", tableName: "region" }] },
    });
    const { tables, refusal } = await getTableStats(runner, CATALOG, { schema: "tiny" });

    expect(refusal).toBeUndefined();
    expect(tables.map((table) => table.tableName)).toEqual(["region"]);
  });

  test("names the schema, and advises no further narrowing, when the caller already narrowed", async () => {
    // Advice a caller cannot act on is worse than none, and there IS no narrower
    // selection than one schema here, so the sentence offers the per-table statement
    // instead of asking again for something it already has.
    const many: TrinoRow[] = Array.from({ length: TRINO_MAX_STATS_TABLES + 1 }, () => ({
      schemaName: "tiny",
      tableName: "region",
    }));
    const { runner } = fakeRunner({ rows: { tableList: many } });
    const { tables, refusal } = await getTableStats(runner, CATALOG, { schema: "tiny" });

    expect(tables).toEqual([]);
    expect(refusal).toContain(`Schema "tiny" of catalog "tpch" holds ${TRINO_MAX_STATS_TABLES + 1} tables`);
    expect(refusal).toContain('SHOW STATS FOR "tpch"."tiny"."<table>"');
    expect(refusal).toContain("read as the schema's table count");
    // Not vacuous: "Narrowing to one schema" is the opening of BOTH catalog-scope arms,
    // each pinned positively above, so renaming it turns those two red before this one
    // could quietly start passing on a string that no longer exists anywhere.
    expect(refusal).not.toContain("Narrowing to one schema");
  });

  test("degrades one table's failure to that table alone", async () => {
    const { runner } = fakeRunner({ failures: { nationStats: unavailable("unknown-object") } });
    const { tables } = await getTableStats(runner, CATALOG, { schema: "tiny" });

    expect(tables.map((table) => table.tableName)).toEqual(["region"]);
  });

  /*
    D24: an empty reading has three causes and only ONE of them is a measurement. The
    three tests below pin each cause to its own answer, because the panel renders them
    differently: a refusal is an ABSENT panel carrying the sentence, an empty catalog is
    an empty panel.
  */
  test("a refused table list is a refusal carrying the server's wording, not no tables", async () => {
    const { runner } = fakeRunner({ failures: { tableList: unavailable("auth") } });
    const { tables, refusal } = await getTableStats(runner, CATALOG);

    expect(tables).toEqual([]);
    expect(refusal).toContain('refused the table list for catalog "tpch"');
  });

  test("a catalog whose tables publish no statistics is a refusal naming how many were asked", async () => {
    // Measured 2026-08-25 against Trino 476: all 379 tables of the jmx catalog answer
    // SHOW STATS with an empty row_count, so this panel reported nothing at all about a
    // catalog full of data.
    const { runner } = fakeRunner({ rows: { tableList: [{ schemaName: "sf1", tableName: "customer" }] } });
    const { tables, refusal } = await getTableStats(runner, CATALOG);

    expect(tables).toEqual([]);
    expect(refusal).toContain("None of the 1 tables examined");
    expect(refusal).toContain("SHOW STATS with a null row count until ANALYZE has run");
  });

  test("a table list that fails for any other reason still propagates", async () => {
    // The refusal arm is narrow on purpose: a timeout or a cancelled query says nothing
    // about what the catalog holds, and a panel that reported it as "no statistics
    // published" would hide the fault behind a sentence that sounds settled.
    const { runner } = fakeRunner({ failures: { tableList: unavailable("timeout") } });

    await expect(getTableStats(runner, CATALOG)).rejects.toThrow(TrinoTransportError);
  });

  test("a catalog that really holds no table stays an EMPTY measurement", async () => {
    // The one empty reading that is honest: nothing was examined, so nothing was
    // refused, and an absent panel here would claim the engine could not answer.
    const { runner } = fakeRunner({ rows: { tableList: [] } });
    const { tables, refusal } = await getTableStats(runner, CATALOG);

    expect(tables).toEqual([]);
    expect(refusal).toBeUndefined();
  });
});

// ============================================================================
// Storage, indexes, health
// ============================================================================

describe("Trino getStorageStats", () => {
  test("names each catalog and the connector behind it, because that is where the data is", async () => {
    const { runner } = fakeRunner();
    const storage = await getStorageStats(runner);

    expect(storage).toHaveLength(5);
    expect(storage[0]).toEqual({ name: "jmx", location: "jmx", size: TRINO_UNAVAILABLE_TEXT, sizeBytes: 0 });
  });

  test("declines to report bytes rather than formatting a zero, and offers no usage fraction", async () => {
    const { runner } = fakeRunner();
    const storage = await getStorageStats(runner);

    expect(storage.every((row) => row.size === TRINO_UNAVAILABLE_TEXT)).toBe(true);
    expect(storage.every((row) => row.usagePercent === undefined)).toBe(true);
  });

  test("drops a row with no catalog name rather than showing a blank one", async () => {
    const { runner } = fakeRunner({ rows: { catalogList: [{ catalogName: null, connectorName: "x" }] } });

    expect(await getStorageStats(runner)).toEqual([]);
  });

  test("degrades to nothing when system.metadata is not granted", async () => {
    const { runner } = fakeRunner({ failures: { catalogList: unavailable("auth") } });

    expect(await getStorageStats(runner)).toEqual([]);
  });
});

describe("Trino getIndexStats", () => {
  test("is empty and sends nothing, because no index object exists in any catalog", () => {
    expect(getIndexStats()).toEqual([]);
  });
});

describe("Trino getHealth", () => {
  test("composes the summary from the reads that have a source", async () => {
    const { runner } = fakeRunner();
    const health = await getHealth(runner, CATALOG);

    expect(health.activeConnections).toBe(1);
    expect(health.databaseSize).toBe(TRINO_UNAVAILABLE_TEXT);
    expect(health.cacheHitRatio).toBe(TRINO_UNAVAILABLE_TEXT);
    expect(health.slowQueries[0]).toEqual({
      query: "SELECT nationkey, name, regionkey FROM tpch.sf1.nation ORDER BY nationkey LIMIT 5",
      calls: 1,
      avgTime: "1.54s",
    });
    expect(health.activeSessions[0]).toEqual({
      pid: "20260820_001943_00041_chvb7",
      user: "libredb",
      database: "",
      state: "RUNNING",
      query: 'SELECT query_id AS "queryId" FROM system.runtime.queries',
      duration: "0ms",
    });
  });
});
