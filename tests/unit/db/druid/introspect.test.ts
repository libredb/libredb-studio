/**
 * Druid schema introspection and monitoring (issue #265, design spec sections 9 and 10)
 *
 * Driven entirely through a hand-built query runner - the point of the seam: no
 * fetch mocking, no `mock.module()` (process-wide in bun) and no server. Every
 * row shape below was captured from a live Apache Druid 37.0.0 cluster, so the
 * fake speaks exactly what the server speaks, including the four shapes that
 * break a naive mapper:
 *
 * 1. A grouping-less aggregate over zero matching rows returns ZERO ROWS, not a
 *    row of zeros - live-verified, `SELECT COUNT(*) FROM sys.tasks WHERE status
 *    = 'RUNNING'` answers `[["runningTasks"]]` with no data row when nothing is
 *    running. Every scalar read therefore has to survive an absent row.
 * 2. A RUNNING task reports `duration = -1`, so the elapsed time has to come
 *    from `CURRENT_TIMESTAMP` minus `created_time` instead.
 * 3. `sys.servers` reports `max_size = 0` for every process that is not a
 *    historical, so the usage division meets a zero denominator in ordinary
 *    operation rather than only in a contrived one.
 * 4. A `SUM(size)` big enough to leave the safe-integer range arrives QUOTED,
 *    because the transport rewrites unsafe integer literals before parsing
 *    (spec section 3). Both encodings reach these mappers.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_THRESHOLDS, evaluateThreshold } from "@/lib/monitoring-thresholds";
import {
  DRUID_ACTIVE_TASK_SQL,
  DRUID_CACHE_HIT_RATIO_UNAVAILABLE,
  DRUID_COLUMN_LIST_SQL,
  DRUID_DATASOURCE_COUNT_SQL,
  DRUID_DATASOURCE_STATS_SQL,
  DRUID_DEFAULT_SESSION_LIMIT,
  DRUID_HISTORICAL_STORAGE_SQL,
  DRUID_RUNNING_TASK_COUNT_SQL,
  DRUID_SCHEMA_NAME,
  DRUID_SEGMENT_TOTALS_SQL,
  DRUID_SERVER_IDENTITY_SQL,
  DRUID_SYSTEM_READ_TIMEOUT_MS,
  DRUID_TABLE_LIST_SQL,
  DRUID_TASK_APPLICATION_NAME,
  DRUID_TIME_COLUMN,
  DRUID_UNKNOWN_TEXT,
  type DruidQueryRunner,
  getActiveSessions,
  getHealth,
  getIndexStats,
  getOverview,
  getPerformanceMetrics,
  getSchema,
  getSlowQueries,
  getStorageStats,
  getTableStats,
} from "@/lib/db/providers/sql/druid/introspect";
import {
  DRUID_CLIENT_DEADLINE_GRACE_MS,
  DRUID_ERROR_CATEGORIES,
  type DruidErrorCategory,
  type DruidQueryOptions,
  type DruidRow,
  DruidTransportError,
} from "@/lib/db/providers/sql/druid/transport";

// ============================================================================
// Fake query runner
// ============================================================================

/** Which catalog or `sys` read a recorded statement is. */
type Surface =
  | "tableList"
  | "columnList"
  | "identity"
  | "segmentTotals"
  | "datasourceCount"
  | "runningTasks"
  | "activeTasks"
  | "datasourceStats"
  | "historicalStorage";

/**
 * The statement each surface must send, so a read is identified by the constant
 * it came from rather than by a substring. A statement the module invents that
 * matches none of these fails the test loudly instead of silently returning the
 * rows of a different surface.
 */
const SURFACE_SQL: Record<Surface, string> = {
  tableList: DRUID_TABLE_LIST_SQL,
  columnList: DRUID_COLUMN_LIST_SQL,
  identity: DRUID_SERVER_IDENTITY_SQL,
  segmentTotals: DRUID_SEGMENT_TOTALS_SQL,
  datasourceCount: DRUID_DATASOURCE_COUNT_SQL,
  runningTasks: DRUID_RUNNING_TASK_COUNT_SQL,
  activeTasks: DRUID_ACTIVE_TASK_SQL,
  datasourceStats: DRUID_DATASOURCE_STATS_SQL,
  historicalStorage: DRUID_HISTORICAL_STORAGE_SQL,
};

const SURFACES = Object.keys(SURFACE_SQL) as Surface[];

interface RecordedCall {
  sql: string;
  opts: DruidQueryOptions | undefined;
}

interface FakeOptions {
  rows?: Partial<Record<Surface, DruidRow[]>>;
  /** Raised instead of returning rows, per surface. */
  failures?: Partial<Record<Surface, Error>>;
}

/** `startsWith` because a row cap is appended to the session read. */
function surfaceOf(sql: string): Surface {
  const surface = SURFACES.find((candidate) => sql.startsWith(SURFACE_SQL[candidate]));
  if (surface === undefined) throw new Error(`unexpected statement: ${sql}`);
  return surface;
}

function createRunner(options: FakeOptions = {}) {
  const calls: RecordedCall[] = [];

  const runner = {
    query: async (sql: string, opts?: DruidQueryOptions) => {
      calls.push({ sql, opts });
      const surface = surfaceOf(sql);
      const failure = options.failures?.[surface];
      if (failure) throw failure;
      return {
        rows: options.rows?.[surface] ?? [],
        fieldNames: null,
        sqlTypes: null,
        nativeTypes: null,
        executionTimeMs: 1,
        // The seam requires an answer about segment availability from every
        // source; a fake that never speaks HTTP has nothing to report (#273).
        unavailableSegments: null,
      };
    },
  };

  return { runner, calls };
}

function sqlFor(calls: RecordedCall[], surface: Surface): string {
  const call = calls.find((entry) => surfaceOf(entry.sql) === surface);
  if (!call) throw new Error(`no ${surface} statement was sent`);
  return call.sql;
}

// ============================================================================
// Row builders (shapes captured from Druid 37.0.0)
// ============================================================================

function tableRow(overrides: Partial<DruidRow> = {}): DruidRow {
  return { tableName: "libredb_demo", ...overrides };
}

function columnRow(overrides: Partial<DruidRow> = {}): DruidRow {
  return {
    tableName: "libredb_demo",
    columnName: "id",
    dataType: "BIGINT",
    isNullable: "YES",
    ...overrides,
  };
}

/** The mandatory primary timestamp - the one column Druid reports as NOT NULL. */
function timeColumnRow(overrides: Partial<DruidRow> = {}): DruidRow {
  return columnRow({ columnName: DRUID_TIME_COLUMN, dataType: "TIMESTAMP", isNullable: "NO", ...overrides });
}

/** The coordinator row, which is what the identity read's ordering puts first. */
function identityRow(overrides: Partial<DruidRow> = {}): DruidRow {
  return {
    version: "37.0.0",
    startTime: "2026-08-03T14:29:00.534Z",
    serverNow: "2026-08-03T15:09:26.292Z",
    ...overrides,
  };
}

/** `2026-08-03T15:09:26.292Z` minus `2026-08-03T14:29:00.534Z`. */
const IDENTITY_UPTIME_MS = 2_425_758;
const IDENTITY_UPTIME_TEXT = "40.43m";

/**
 * A live `noop` task, submitted to the running cluster to capture what an
 * unfinished task actually reports: `duration` came back as -1, which is why the
 * elapsed time is computed from these two timestamps instead.
 */
function taskRow(overrides: Partial<DruidRow> = {}): DruidRow {
  return {
    taskId: "noop_2026-08-03T15:09:03.006Z_406ac936",
    taskType: "index_parallel",
    datasource: "libredb_demo",
    status: "RUNNING",
    createdTime: "2026-08-03T15:09:03.007Z",
    serverNow: "2026-08-03T15:09:26.268Z",
    ...overrides,
  };
}

/** `2026-08-03T15:09:26.268Z` minus `2026-08-03T15:09:03.007Z`. */
const TASK_ELAPSED_MS = 23_261;
const TASK_ELAPSED_TEXT = "23.26s";

function statsRow(overrides: Partial<DruidRow> = {}): DruidRow {
  return { datasource: "libredb_demo", rowCount: 50, sizeBytes: 10203, ...overrides };
}

function storageRow(overrides: Partial<DruidRow> = {}): DruidRow {
  return {
    server: "172.18.0.5:8083",
    host: "172.18.0.5",
    currSize: 19617,
    maxSize: 300000000000,
    ...overrides,
  };
}

// ============================================================================
// The datasource filter
// ============================================================================

describe("the datasource filter", () => {
  test.each<[Surface]>([
    ["tableList"],
    ["columnList"],
  ])("restricts the %s read to the druid schema", async (surface) => {
    const { runner, calls } = createRunner();

    await getSchema(runner);

    expect(sqlFor(calls, surface)).toContain(`TABLE_SCHEMA = '${DRUID_SCHEMA_NAME}'`);
  });

  // Live-verified: INFORMATION_SCHEMA.TABLES also lists the four
  // INFORMATION_SCHEMA views and the six sys tables, all as SYSTEM_TABLE, and a
  // cluster with lookups or views carries a `lookup` / `view` schema too. The
  // schema predicate is the whole mechanism that keeps them out of the sidebar,
  // so nothing else may be named.
  test("never names another schema", () => {
    for (const sql of [DRUID_TABLE_LIST_SQL, DRUID_COLUMN_LIST_SQL]) {
      expect(sql).not.toContain("sys");
      expect(sql).not.toContain("lookup");
      expect(sql).not.toContain("SYSTEM_TABLE");
    }
  });

  test("reads INFORMATION_SCHEMA rather than a sys table", () => {
    expect(DRUID_TABLE_LIST_SQL).toContain("INFORMATION_SCHEMA.TABLES");
    expect(DRUID_COLUMN_LIST_SQL).toContain("INFORMATION_SCHEMA.COLUMNS");
  });

  test("bounds both catalog reads with a deadline on each half of the exchange", async () => {
    const { runner, calls } = createRunner();

    await getSchema(runner);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.opts).toEqual({
        timeoutMs: DRUID_SYSTEM_READ_TIMEOUT_MS,
        // Strictly LATER than the server deadline. Equal deadlines are a race the
        // client wins - the server's 504 still has to travel back - and winning it
        // replaces Druid's classified TIMEOUT envelope with a bare abort that says
        // nothing useful. The provider follows the same rule for user queries.
        clientDeadlineMs: DRUID_SYSTEM_READ_TIMEOUT_MS + DRUID_CLIENT_DEADLINE_GRACE_MS,
      });
      expect(call.opts?.clientDeadlineMs).toBeGreaterThan(call.opts?.timeoutMs as number);
    }
  });
});

// ============================================================================
// getSchema
// ============================================================================

describe("getSchema", () => {
  test("names a datasource by its bare name", async () => {
    const { runner } = createRunner({ rows: { tableList: [tableRow(), tableRow({ tableName: "libredb_rollup" })] } });

    const schema = await getSchema(runner);

    expect(schema.map((table) => table.name)).toEqual(["libredb_demo", "libredb_rollup"]);
  });

  test("carries the columns of each datasource in the order the server declared", async () => {
    const { runner } = createRunner({
      rows: {
        tableList: [tableRow()],
        columnList: [
          timeColumnRow(),
          columnRow({ columnName: "snowflake_id" }),
          columnRow({ columnName: "region", dataType: "VARCHAR" }),
        ],
      },
    });

    const [demo] = await getSchema(runner);

    expect(demo.columns.map((column) => column.name)).toEqual([DRUID_TIME_COLUMN, "snowflake_id", "region"]);
  });

  // The projection leaves ORDINAL_POSITION out and orders by it instead: it IS
  // the declared column order, so it has no separate value to carry.
  test("orders the column read by ordinal position", () => {
    expect(DRUID_COLUMN_LIST_SQL).toContain("ORDER BY TABLE_NAME, ORDINAL_POSITION");
    expect(DRUID_COLUMN_LIST_SQL).not.toContain('AS "ordinalPosition"');
  });

  test("takes the column type from DATA_TYPE, which is the SQL type", async () => {
    const { runner } = createRunner({
      rows: { tableList: [tableRow()], columnList: [columnRow({ dataType: "DOUBLE" })] },
    });

    const [demo] = await getSchema(runner);

    expect(demo.columns[0]?.type).toBe("DOUBLE");
    expect(DRUID_COLUMN_LIST_SQL).toContain("DATA_TYPE");
  });

  // Never observed empty, so this is the defensive branch - and OTHER is Druid's
  // own token for a type its SQL layer cannot name, so the fallback stays inside
  // the vocabulary the rest of the column list uses.
  test("falls back to Druid's own OTHER type when DATA_TYPE says nothing", async () => {
    const { runner } = createRunner({
      rows: { tableList: [tableRow()], columnList: [columnRow({ dataType: "" }), columnRow({ dataType: null })] },
    });

    const [demo] = await getSchema(runner);

    expect(demo.columns.map((column) => column.type)).toEqual(["OTHER", "OTHER"]);
  });

  // Nothing in a Druid datasource is a primary key, `__time` included. It is
  // mandatory, it is the partition and sort key, and it is the only column Druid
  // reports NOT NULL - but it is not UNIQUE, and `isPrimary` is read as PRIMARY KEY by
  // autocomplete ("(PK)"), by the AI schema context (", PK") and by the schema differ
  // ("Primary key changed"). Live-verified on the fixture datasource: 50 rows carry 30
  // distinct `__time` values.
  test("marks no column as primary, not even __time", async () => {
    const { runner } = createRunner({
      rows: {
        tableList: [tableRow()],
        columnList: [timeColumnRow(), columnRow(), columnRow({ columnName: "region" })],
      },
    });

    const [demo] = await getSchema(runner);

    expect(demo.columns.filter((column) => column.isPrimary)).toEqual([]);
    // The time column is still recognisable by name and by being the one NOT NULL
    // column, which is the honest way to find it.
    expect(demo.columns.find((column) => column.name === DRUID_TIME_COLUMN)?.nullable).toBe(false);
  });

  // isPrimary is keyed on the NAME, not on IS_NULLABLE = 'NO'. Today __time is
  // the only column Druid reports as NOT NULL, but that is a consequence of it
  // being mandatory rather than the definition of the key - so a Druid that ever
  // marks a second column NOT NULL must not grow a second primary column.
  test("does not promote a NOT NULL column to primary either", async () => {
    const { runner } = createRunner({
      rows: {
        tableList: [tableRow()],
        columnList: [timeColumnRow(), columnRow({ columnName: "id", isNullable: "NO" })],
      },
    });

    const [demo] = await getSchema(runner);

    expect(demo.columns.map((column) => [column.name, column.isPrimary, column.nullable])).toEqual([
      [DRUID_TIME_COLUMN, false, false],
      ["id", false, false],
    ]);
  });

  test.each<[string, unknown, boolean]>([
    ["YES", "YES", true],
    ["NO", "NO", false],
  ])("reads IS_NULLABLE %s as nullable=%p", async (_label, value, expected) => {
    const { runner } = createRunner({
      rows: { tableList: [tableRow()], columnList: [columnRow({ isNullable: value })] },
    });

    const [demo] = await getSchema(runner);

    expect(demo.columns[0]?.nullable).toBe(expected);
  });

  // Nullable is the safe reading of an unreadable flag: claiming NOT NULL would
  // put a mandatory marker on a column that may well accept nulls, and Druid
  // marks all but one column YES.
  test.each<[string, unknown]>([
    ["an absent flag", undefined],
    ["a null flag", null],
    ["an unexpected word", "MAYBE"],
  ])("treats %s as nullable", async (_label, value) => {
    const { runner } = createRunner({
      rows: { tableList: [tableRow()], columnList: [columnRow({ isNullable: value })] },
    });

    const [demo] = await getSchema(runner);

    expect(demo.columns[0]?.nullable).toBe(true);
  });

  // Druid has no user-defined indexes - every dimension is indexed by
  // construction - and no foreign keys anywhere. Both lists are a fact about the
  // engine, not a load that failed.
  test("reports no indexes and no foreign keys", async () => {
    const { runner } = createRunner({ rows: { tableList: [tableRow()], columnList: [timeColumnRow()] } });

    const [demo] = await getSchema(runner);

    expect(demo.indexes).toEqual([]);
    expect(demo.foreignKeys).toEqual([]);
  });

  // getSchema reads INFORMATION_SCHEMA only. A row count would have to come from
  // sys.segments, which is separately permission-gated, so asking for it would
  // make the whole sidebar fail on a cluster that only denies `sys` - and the
  // per-datasource counts are already in getTableStats.
  test("leaves the row count and size unset rather than reading sys.segments", async () => {
    const { runner, calls } = createRunner({ rows: { tableList: [tableRow()] } });

    const [demo] = await getSchema(runner);

    expect(demo.rowCount).toBeUndefined();
    expect(demo.size).toBeUndefined();
    expect(calls.map((call) => surfaceOf(call.sql)).sort()).toEqual(["columnList", "tableList"]);
  });

  test("gives a datasource with no column rows an empty column list", async () => {
    const { runner } = createRunner({
      rows: { tableList: [tableRow(), tableRow({ tableName: "libredb_rollup" })], columnList: [columnRow()] },
    });

    const [, rollup] = await getSchema(runner);

    expect(rollup.columns).toEqual([]);
  });

  test("drops a column row belonging to no listed datasource", async () => {
    const { runner } = createRunner({
      rows: { tableList: [tableRow()], columnList: [columnRow({ tableName: "gone" }), columnRow()] },
    });

    const schema = await getSchema(runner);

    expect(schema).toHaveLength(1);
    expect(schema[0]?.columns.map((column) => column.name)).toEqual(["id"]);
  });

  test.each<[string, unknown]>([
    ["an absent name", undefined],
    ["a null name", null],
    ["an empty name", ""],
    ["a non-string name", 7],
  ])("drops a datasource row carrying %s", async (_label, value) => {
    const { runner } = createRunner({ rows: { tableList: [tableRow({ tableName: value }), tableRow()] } });

    const schema = await getSchema(runner);

    expect(schema.map((table) => table.name)).toEqual(["libredb_demo"]);
  });

  test.each<[string, "tableName" | "columnName"]>([
    ["an unusable table name", "tableName"],
    ["an unusable column name", "columnName"],
  ])("drops a column row carrying %s", async (_label, field) => {
    const { runner } = createRunner({
      rows: { tableList: [tableRow()], columnList: [columnRow({ [field]: "" }), columnRow()] },
    });

    const [demo] = await getSchema(runner);

    expect(demo.columns.map((column) => column.name)).toEqual(["id"]);
  });

  // A datasource whose segments are all unused disappears from
  // INFORMATION_SCHEMA.TABLES entirely (live-verified with the Coordinator's
  // markUnused), so an empty catalog means "no datasources", never "a datasource
  // with nothing in it".
  test("returns nothing when the catalog lists no datasource", async () => {
    const { runner } = createRunner();

    expect(await getSchema(runner)).toEqual([]);
  });
});

// ============================================================================
// Degradation
// ============================================================================

/**
 * The three categories that mean "this surface is not available here" - a
 * locked-down cluster's ordinary configurations. Every monitoring and catalog
 * read degrades to empty or zero on these, and on nothing else: an empty panel
 * standing in for a real error hides it forever.
 */
const DEGRADING: DruidErrorCategory[] = ["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"];

/** Driven off the frozen table, so a category Druid adds cannot escape the matrix. */
const PROPAGATING = (Object.keys(DRUID_ERROR_CATEGORIES) as DruidErrorCategory[]).filter(
  (category) => !DEGRADING.includes(category),
);

function transportError(category: DruidErrorCategory): DruidTransportError {
  return new DruidTransportError("probe", DRUID_ERROR_CATEGORIES[category], "general", "OPERATOR");
}

/** Each read, the surface it depends on, and what it must answer with that surface gone. */
const READS: [name: string, surface: Surface, run: (runner: DruidQueryRunner) => Promise<unknown>][] = [
  ["getSchema", "tableList", (runner) => getSchema(runner)],
  ["getActiveSessions", "activeTasks", (runner) => getActiveSessions(runner)],
  ["getTableStats", "datasourceStats", (runner) => getTableStats(runner)],
  ["getStorageStats", "historicalStorage", (runner) => getStorageStats(runner)],
];

describe("degradation", () => {
  test.each(READS)("%s degrades to empty when the surface is unavailable", async (_name, surface, run) => {
    const answers = await Promise.all(
      DEGRADING.map((category) => run(createRunner({ failures: { [surface]: transportError(category) } }).runner)),
    );

    expect(answers).toEqual(DEGRADING.map(() => []));
  });

  test.each(READS)("%s propagates every other category", async (_name, surface, run) => {
    await Promise.all(
      PROPAGATING.map(async (category) => {
        const { runner } = createRunner({ failures: { [surface]: transportError(category) } });

        await expect(run(runner)).rejects.toThrow("probe");
      }),
    );
  });

  // A failure that never reached the server - a refused socket, an aborted
  // request - is not a DruidTransportError at all, and must not be mistaken for
  // an absent surface either.
  test.each(READS)("%s propagates a failure that is not a transport error", async (_name, surface, run) => {
    const { runner } = createRunner({ failures: { [surface]: new Error("socket hang up") } });

    await expect(run(runner)).rejects.toThrow("socket hang up");
  });

  test("keeps the columns of a schema whose column read is denied", async () => {
    const { runner } = createRunner({
      rows: { tableList: [tableRow()] },
      failures: { columnList: transportError("FORBIDDEN") },
    });

    const [demo] = await getSchema(runner);

    expect(demo.name).toBe("libredb_demo");
    expect(demo.columns).toEqual([]);
  });

  // Each overview read is separate for exactly this reason: `sys` permissions are
  // granted per table, so a cluster that denies sys.tasks must still report the
  // datasource count that INFORMATION_SCHEMA answers happily.
  test("zeroes only the overview halves whose surface is unavailable", async () => {
    const { runner } = createRunner({
      rows: { identity: [identityRow()], datasourceCount: [{ datasourceCount: 2 }] },
      failures: {
        segmentTotals: transportError("FORBIDDEN"),
        runningTasks: transportError("UNAUTHORIZED"),
      },
    });

    const overview = await getOverview(runner);

    expect(overview.version).toBe("37.0.0");
    expect(overview.tableCount).toBe(2);
    expect(overview.databaseSizeBytes).toBe(0);
    expect(overview.activeConnections).toBe(0);
  });

  test("propagates an overview failure that is not a missing surface", async () => {
    const { runner } = createRunner({ failures: { identity: transportError("INVALID_INPUT") } });

    await expect(getOverview(runner)).rejects.toThrow("probe");
  });
});

// ============================================================================
// getOverview
// ============================================================================

describe("getOverview", () => {
  function overviewRunner(rows: FakeOptions["rows"] = {}) {
    return createRunner({
      rows: {
        identity: [identityRow()],
        segmentTotals: [{ sizeBytes: 19617 }],
        datasourceCount: [{ datasourceCount: 2 }],
        runningTasks: [{ runningTasks: 1 }],
        ...rows,
      },
    });
  }

  test("reports the cluster as the live cluster describes itself", async () => {
    const { runner } = overviewRunner();

    expect(await getOverview(runner)).toEqual({
      version: "37.0.0",
      uptime: IDENTITY_UPTIME_TEXT,
      startTime: new Date("2026-08-03T14:29:00.534Z"),
      activeConnections: 1,
      maxConnections: 0,
      databaseSize: "19.16 KB",
      databaseSizeBytes: 19617,
      tableCount: 2,
      indexCount: 0,
    });
  });

  // Both timestamps come from the server, in one statement: the editor's own
  // clock may be skewed from the cluster's, and an uptime is a difference of two
  // readings of the SAME clock or it is nothing.
  test("computes the uptime from the server's own clock, not the editor's", async () => {
    expect(DRUID_SERVER_IDENTITY_SQL).toContain("CURRENT_TIMESTAMP");
    const { runner } = overviewRunner();

    const overview = await getOverview(runner);

    expect(overview.uptime).toBe(IDENTITY_UPTIME_TEXT);
    expect(IDENTITY_UPTIME_MS).toBe(
      new Date("2026-08-03T15:09:26.292Z").getTime() - new Date("2026-08-03T14:29:00.534Z").getTime(),
    );
  });

  // Live `sys.servers` reports the Coordinator/Overlord pair, a Broker, a Router,
  // a MiddleManager and a Historical, all with the same version but different
  // start times. The Coordinator is the cluster's brain, so its start time is the
  // one that reads as "the cluster came up"; the Broker is next because a
  // Broker-only deployment is a supported way to reach Druid (spec section 11).
  test("prefers the coordinator, then the broker, for the identity read", () => {
    expect(DRUID_SERVER_IDENTITY_SQL).toContain("CASE server_type WHEN 'coordinator' THEN 0 WHEN 'broker' THEN 1");
    expect(DRUID_SERVER_IDENTITY_SQL).toContain("LIMIT 1");
  });

  test("reports an unknown version and uptime when no server row came back", async () => {
    const { runner } = overviewRunner({ identity: [] });

    const overview = await getOverview(runner);

    expect(overview.version).toBe(DRUID_UNKNOWN_TEXT);
    expect(overview.uptime).toBe(DRUID_UNKNOWN_TEXT);
    expect(overview.startTime).toBeUndefined();
  });

  test.each<[string, unknown]>([
    ["an absent start time", undefined],
    ["a null start time", null],
    ["an unparseable start time", "not-a-timestamp"],
    ["a non-string start time", 1_754_231_340_534],
  ])("reports an unknown uptime for %s rather than inventing one", async (_label, value) => {
    const { runner } = overviewRunner({ identity: [identityRow({ startTime: value })] });

    const overview = await getOverview(runner);

    expect(overview.startTime).toBeUndefined();
    expect(overview.uptime).toBe(DRUID_UNKNOWN_TEXT);
  });

  test("reports an unknown uptime when the server's clock is unreadable", async () => {
    const { runner } = overviewRunner({ identity: [identityRow({ serverNow: "" })] });

    const overview = await getOverview(runner);

    expect(overview.startTime).toEqual(new Date("2026-08-03T14:29:00.534Z"));
    expect(overview.uptime).toBe(DRUID_UNKNOWN_TEXT);
  });

  // Spec section 3: the transport wraps any integer literal outside the safe
  // range in quotes before parsing, so a large SUM(size) reaches this mapper as a
  // decimal STRING while a small one stays a number. Both encodings are real, and
  // a string that fell through as 0 would report an empty cluster.
  test.each<[string, unknown, number]>([
    ["a quoted size", "1099511627776", 1099511627776],
    ["an unquoted size", 1099511627776, 1099511627776],
  ])("parses %s", async (_label, value, expected) => {
    const { runner } = overviewRunner({ segmentTotals: [{ sizeBytes: value }] });

    expect((await getOverview(runner)).databaseSizeBytes).toBe(expected);
  });

  // Live-verified: a grouping-less aggregate over no matching rows returns zero
  // ROWS, so `SUM(size)` over an empty cluster is an absent row rather than a
  // null, and every scalar read has to survive that.
  test.each<[string, DruidRow[]]>([
    ["no row at all", []],
    ["a row with a null total", [{ sizeBytes: null }]],
    ["a row with a non-numeric total", [{ sizeBytes: "" }]],
  ])("reports a zero size for %s", async (_label, rows) => {
    const { runner } = overviewRunner({ segmentTotals: rows });

    const overview = await getOverview(runner);

    expect(overview.databaseSizeBytes).toBe(0);
    expect(overview.databaseSize).toBe("0 B");
  });

  test("counts a RUNNING ingestion task as an active connection", async () => {
    const { runner } = overviewRunner({ runningTasks: [{ runningTasks: 4 }] });

    expect((await getOverview(runner)).activeConnections).toBe(4);
  });

  // Druid has no connection pool and publishes no connection limit anywhere in
  // SQL, so a maximum would be a number the editor made up. Same for the index
  // count: there are no index objects to count.
  test("reports no connection limit and no indexes rather than guessing", async () => {
    const { runner } = overviewRunner();

    const overview = await getOverview(runner);

    expect(overview.maxConnections).toBe(0);
    expect(overview.indexCount).toBe(0);
  });

  test("reads the four sources separately so one denial cannot empty the rest", async () => {
    const { runner, calls } = overviewRunner();

    await getOverview(runner);

    expect(calls.map((call) => surfaceOf(call.sql)).sort()).toEqual([
      "datasourceCount",
      "identity",
      "runningTasks",
      "segmentTotals",
    ]);
  });
});

// ============================================================================
// The honest empties
// ============================================================================

/** The real threshold the monitoring UI evaluates this metric against. */
const CACHE_HIT_RATIO_THRESHOLD = DEFAULT_THRESHOLDS.find((t) => t.metric === "cacheHitRatio")!;

describe("getPerformanceMetrics", () => {
  // Druid's cache and query metrics go to a metrics emitter (statsd, Kafka, the
  // log), never to a SQL-readable table. There is nothing to read, so there is
  // nothing to report.
  test("reports nothing at all", () => {
    expect(getPerformanceMetrics()).toEqual({});
  });

  // Regression guard. A "neutral" 0 here was not neutral: DEFAULT_THRESHOLDS scores
  // cacheHitRatio `direction: "below"` with `critical: 80`, so a zero made every
  // healthy Druid cluster render a red critical cache fault. Absence is the only
  // value that raises no alarm, and the monitoring tabs default the THRESHOLD to a
  // healthy 100 when the field is missing.
  test("omits cacheHitRatio rather than reporting a zero the threshold reads as critical", () => {
    const metrics = getPerformanceMetrics();

    expect(metrics.cacheHitRatio).toBeUndefined();
    expect("cacheHitRatio" in metrics).toBe(false);
    expect(evaluateThreshold(metrics.cacheHitRatio ?? 100, CACHE_HIT_RATIO_THRESHOLD)).toBe("healthy");
    expect(evaluateThreshold(0, CACHE_HIT_RATIO_THRESHOLD)).toBe("critical");
  });

  // Every metric is optional in the type, so absence is expressible for all of them
  // and means "not reported"; a zero would read as a measurement of zero.
  test("leaves every optional metric absent rather than zeroing it", () => {
    expect(Object.keys(getPerformanceMetrics())).toEqual([]);
  });

  test("hands out a fresh object each call", () => {
    expect(getPerformanceMetrics()).not.toBe(getPerformanceMetrics());
  });
});

describe("getSlowQueries", () => {
  // Druid has no query log at all: no sys table, no endpoint, nothing on disk.
  // The panel is empty because there is nothing to read, not because a read
  // failed - and no statement is sent to discover that.
  test("reports no slow queries, without asking the cluster", () => {
    expect(getSlowQueries()).toEqual([]);
  });

  test("hands out a fresh array each call", () => {
    expect(getSlowQueries()).not.toBe(getSlowQueries());
  });
});

describe("getIndexStats", () => {
  // No user-defined indexes exist to have statistics about. Druid indexes every
  // dimension by construction, and those indexes are inside a segment with no
  // name, no size and no usage counter of their own.
  test("reports no indexes, without asking the cluster", () => {
    expect(getIndexStats()).toEqual([]);
  });

  test("hands out a fresh array each call", () => {
    expect(getIndexStats()).not.toBe(getIndexStats());
  });
});

// ============================================================================
// getActiveSessions
// ============================================================================

describe("getActiveSessions", () => {
  function taskRunner(rows: DruidRow[] = [taskRow()]) {
    return createRunner({ rows: { activeTasks: rows } });
  }

  // Druid has no query sessions - no sys.queries, no connection catalog - so the
  // only activity it can describe is its tasks. Returning [] while a multi-hour
  // ingestion runs would hide the one thing happening on the cluster, and the
  // application name is what stops the row being mistaken for a client session.
  test("describes a running ingestion task as the session it is", async () => {
    const { runner } = taskRunner();

    expect(await getActiveSessions(runner)).toEqual([
      {
        pid: "noop_2026-08-03T15:09:03.006Z_406ac936",
        user: DRUID_UNKNOWN_TEXT,
        database: "libredb_demo",
        applicationName: DRUID_TASK_APPLICATION_NAME,
        state: "RUNNING",
        query: "index_parallel",
        queryStart: new Date("2026-08-03T15:09:03.007Z"),
        duration: TASK_ELAPSED_TEXT,
        durationMs: TASK_ELAPSED_MS,
      },
    ]);
  });

  test("reads the pending tasks as well as the running ones", () => {
    expect(DRUID_ACTIVE_TASK_SQL).toContain("status IN ('RUNNING', 'PENDING')");
  });

  // THE correctness requirement of this read. Live-verified against a `noop` task
  // submitted to the running cluster: sys.tasks reports `duration = -1` for a task
  // that has not finished, which is every task this statement selects. Reporting
  // that column would put "-1ms" on every row, so the elapsed time is computed
  // from the server's clock minus the task's creation instant instead - and the
  // column is left out of the projection so nobody reaches for it later.
  test("never reads the duration column, which is -1 for an unfinished task", () => {
    expect(DRUID_ACTIVE_TASK_SQL).not.toContain("duration");
    expect(DRUID_ACTIVE_TASK_SQL).toContain("CURRENT_TIMESTAMP");
  });

  test("computes the elapsed time from the two timestamps in the row", async () => {
    const { runner } = taskRunner([
      taskRow({ createdTime: "2026-08-03T15:00:00.000Z", serverNow: "2026-08-03T15:00:02.500Z" }),
    ]);

    const [session] = await getActiveSessions(runner);

    expect(session?.durationMs).toBe(2500);
    expect(session?.duration).toBe("2.50s");
  });

  test.each<[string, Partial<DruidRow>]>([
    ["the creation time is absent", { createdTime: undefined }],
    ["the creation time is unparseable", { createdTime: "soon" }],
    ["the server clock is absent", { serverNow: null }],
    ["the server clock is unparseable", { serverNow: "now" }],
  ])("reports a zero elapsed time when %s", async (_label, overrides) => {
    const { runner } = taskRunner([taskRow(overrides)]);

    const [session] = await getActiveSessions(runner);

    expect(session?.durationMs).toBe(0);
    expect(session?.duration).toBe("0ms");
  });

  test("leaves the start unset when the creation time is unreadable", async () => {
    const { runner } = taskRunner([taskRow({ createdTime: "" })]);

    const [session] = await getActiveSessions(runner);

    expect(session?.queryStart).toBeUndefined();
  });

  // A clock that ran backwards between the two readings - the row is a snapshot,
  // but a cluster with a skewed metadata store can still produce it - must not
  // report a negative age.
  test("never reports a negative elapsed time", async () => {
    const { runner } = taskRunner([
      taskRow({ createdTime: "2026-08-03T15:00:05.000Z", serverNow: "2026-08-03T15:00:00.000Z" }),
    ]);

    expect((await getActiveSessions(runner))[0]?.durationMs).toBe(0);
  });

  // Live-verified: a task with no datasource - a `noop` task, or a compaction
  // that has not resolved one yet - reports the literal string "none" rather
  // than null, so the field is never empty in practice.
  test.each<[string, unknown, string]>([
    ["a datasource", "libredb_rollup", "libredb_rollup"],
    ["Druid's own placeholder", "none", "none"],
    ["an absent datasource", undefined, ""],
  ])("passes through %s", async (_label, value, expected) => {
    const { runner } = taskRunner([taskRow({ datasource: value })]);

    expect((await getActiveSessions(runner))[0]?.database).toBe(expected);
  });

  test.each<[string, Partial<DruidRow>, Partial<Record<"pid" | "state" | "query", string>>]>([
    ["an absent task id", { taskId: undefined }, { pid: "" }],
    ["an absent status", { status: null }, { state: "" }],
    ["an absent task type", { taskType: undefined }, { query: "" }],
  ])("survives %s", async (_label, overrides, expected) => {
    const { runner } = taskRunner([taskRow(overrides)]);

    expect((await getActiveSessions(runner))[0]).toMatchObject(expected);
  });

  // Druid records no submitter identity in sys.tasks - a basic-security cluster
  // puts it in the audit log, not here - so the user is unknown rather than
  // borrowed from the connection, which did not submit the task.
  test("does not claim the connection's user submitted the task", async () => {
    const { runner } = taskRunner();

    expect((await getActiveSessions(runner))[0]?.user).toBe(DRUID_UNKNOWN_TEXT);
  });

  test("caps the read at the requested number of rows", async () => {
    const { runner, calls } = taskRunner();

    await getActiveSessions(runner, { limit: 3 });

    expect(sqlFor(calls, "activeTasks")).toBe(`${DRUID_ACTIVE_TASK_SQL} LIMIT 3`);
  });

  test.each<[string, number | undefined]>([
    ["no limit", undefined],
    ["a zero limit", 0],
    ["a negative limit", -5],
  ])("falls back to the default cap for %s", async (_label, limit) => {
    const { runner, calls } = taskRunner();

    await getActiveSessions(runner, { limit });

    expect(sqlFor(calls, "activeTasks")).toBe(`${DRUID_ACTIVE_TASK_SQL} LIMIT ${DRUID_DEFAULT_SESSION_LIMIT}`);
  });

  test("truncates a fractional cap rather than putting it in the statement", async () => {
    const { runner, calls } = taskRunner();

    await getActiveSessions(runner, { limit: 7.9 });

    expect(sqlFor(calls, "activeTasks")).toBe(`${DRUID_ACTIVE_TASK_SQL} LIMIT 7`);
  });

  test("reports nothing when no task is running", async () => {
    const { runner } = taskRunner([]);

    expect(await getActiveSessions(runner)).toEqual([]);
  });
});

// ============================================================================
// getTableStats
// ============================================================================

describe("getTableStats", () => {
  test("groups the active segments of each datasource", async () => {
    const { runner } = createRunner({ rows: { datasourceStats: [statsRow()] } });

    expect(await getTableStats(runner)).toEqual([
      {
        schemaName: DRUID_SCHEMA_NAME,
        tableName: "libredb_demo",
        rowCount: 50,
        tableSize: "9.96 KB",
        tableSizeBytes: 10203,
        totalSize: "9.96 KB",
        totalSizeBytes: 10203,
      },
    ]);
  });

  // An index size of 0 would be a measurement of something that does not exist,
  // and the field is optional, so it stays absent.
  test("leaves the index size absent, since there are no index objects", async () => {
    const { runner } = createRunner({ rows: { datasourceStats: [statsRow()] } });

    const [stats] = await getTableStats(runner);

    expect(stats).not.toHaveProperty("indexSize");
    expect(stats).not.toHaveProperty("indexSizeBytes");
  });

  // Only the ACTIVE segments count: sys.segments also carries overshadowed and
  // unused rows, and summing those double-counts both rows and bytes.
  test("counts only the active segments", () => {
    expect(DRUID_DATASOURCE_STATS_SQL).toContain("is_active = 1");
    expect(DRUID_DATASOURCE_STATS_SQL).toContain("GROUP BY datasource");
  });

  test("passes the read through for the one schema Druid has", async () => {
    const { runner, calls } = createRunner({ rows: { datasourceStats: [statsRow()] } });

    expect(await getTableStats(runner, { schema: DRUID_SCHEMA_NAME })).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  // `druid` is the only schema holding datasources, so a filter naming any other
  // one selects nothing - and answering that without a round trip is both faster
  // and more obviously right than a predicate that can never match.
  test("answers a filter for any other schema with nothing, and no statement", async () => {
    const { runner, calls } = createRunner({ rows: { datasourceStats: [statsRow()] } });

    expect(await getTableStats(runner, { schema: "sys" })).toEqual([]);
    expect(calls).toEqual([]);
  });

  test.each<[string, Partial<DruidRow>]>([
    ["a null row count", { rowCount: null }],
    ["a null size", { sizeBytes: null }],
    ["an absent datasource", { datasource: undefined }],
  ])("survives %s", async (_label, overrides) => {
    const { runner } = createRunner({ rows: { datasourceStats: [statsRow(overrides)] } });

    const [stats] = await getTableStats(runner);

    expect(stats?.rowCount).toBeGreaterThanOrEqual(0);
    expect(stats?.totalSizeBytes).toBeGreaterThanOrEqual(0);
    expect(typeof stats?.tableName).toBe("string");
  });

  test("parses a quoted size", async () => {
    const { runner } = createRunner({ rows: { datasourceStats: [statsRow({ sizeBytes: "1048576" })] } });

    const [stats] = await getTableStats(runner);

    expect(stats?.tableSizeBytes).toBe(1048576);
    expect(stats?.tableSize).toBe("1 MB");
  });

  test("reports nothing for a cluster with no segments", async () => {
    const { runner } = createRunner();

    expect(await getTableStats(runner)).toEqual([]);
  });
});

// ============================================================================
// getStorageStats
// ============================================================================

describe("getStorageStats", () => {
  test("describes each historical's segment cache", async () => {
    const { runner } = createRunner({
      rows: { historicalStorage: [storageRow({ currSize: 25000, maxSize: 100000 })] },
    });

    expect(await getStorageStats(runner)).toEqual([
      {
        name: "172.18.0.5:8083",
        location: "172.18.0.5",
        size: "24.41 KB",
        sizeBytes: 25000,
        usagePercent: 25,
      },
    ]);
  });

  // The historicals are the only processes that hold segments. Every other
  // process in sys.servers reports curr_size 0 and max_size 0 (live-verified for
  // the Coordinator, Overlord, Broker, Router and MiddleManager), so listing them
  // would fill the panel with rows describing no storage.
  test("reads only the historicals", () => {
    expect(DRUID_HISTORICAL_STORAGE_SQL).toContain("server_type = 'historical'");
  });

  // The zero really is in this column: the Coordinator and Broker rows of the
  // same table report max_size 0 live, and a historical with no segment cache
  // configured reports it too. Dividing by it would put NaN on the panel.
  test("reports zero usage rather than dividing by a zero capacity", async () => {
    const { runner } = createRunner({ rows: { historicalStorage: [storageRow({ maxSize: 0 })] } });

    const [storage] = await getStorageStats(runner);

    expect(storage?.usagePercent).toBe(0);
    expect(storage?.sizeBytes).toBe(19617);
  });

  test.each<[string, unknown]>([
    ["a null capacity", null],
    ["an absent capacity", undefined],
    ["a non-numeric capacity", "unbounded"],
  ])("reports zero usage for %s", async (_label, value) => {
    const { runner } = createRunner({ rows: { historicalStorage: [storageRow({ maxSize: value })] } });

    expect((await getStorageStats(runner))[0]?.usagePercent).toBe(0);
  });

  test("rounds the usage to two decimals", async () => {
    const { runner } = createRunner({
      rows: { historicalStorage: [storageRow({ currSize: 1, maxSize: 3 })] },
    });

    expect((await getStorageStats(runner))[0]?.usagePercent).toBe(33.33);
  });

  test.each<[string, Partial<DruidRow>]>([
    ["an absent server address", { server: undefined }],
    ["an absent host", { host: null }],
    ["a null used size", { currSize: null }],
  ])("survives %s", async (_label, overrides) => {
    const { runner } = createRunner({ rows: { historicalStorage: [storageRow(overrides)] } });

    const [storage] = await getStorageStats(runner);

    expect(typeof storage?.name).toBe("string");
    expect(typeof storage?.location).toBe("string");
    expect(storage?.sizeBytes).toBeGreaterThanOrEqual(0);
  });

  test("reports nothing for a cluster with no historical", async () => {
    const { runner } = createRunner();

    expect(await getStorageStats(runner)).toEqual([]);
  });
});

// ============================================================================
// getHealth
// ============================================================================

describe("getHealth", () => {
  function healthRunner() {
    return createRunner({
      rows: {
        identity: [identityRow()],
        segmentTotals: [{ sizeBytes: 19617 }],
        datasourceCount: [{ datasourceCount: 2 }],
        runningTasks: [{ runningTasks: 1 }],
        activeTasks: [taskRow()],
      },
    });
  }

  test("composes the panel from the reads that have a source", async () => {
    const { runner } = healthRunner();

    expect(await getHealth(runner)).toEqual({
      activeConnections: 1,
      databaseSize: "19.16 KB",
      cacheHitRatio: DRUID_CACHE_HIT_RATIO_UNAVAILABLE,
      slowQueries: [],
      activeSessions: [
        {
          pid: "noop_2026-08-03T15:09:03.006Z_406ac936",
          user: DRUID_UNKNOWN_TEXT,
          database: "libredb_demo",
          state: "RUNNING",
          query: "index_parallel",
          duration: TASK_ELAPSED_TEXT,
        },
      ],
    });
  });

  // The field is a string, so it can say "not available" - which is the truth,
  // Druid publishing no cache statistics in SQL - instead of a number that would
  // be read as a measurement and would trip the cache-ratio threshold alert.
  test("says the cache hit ratio is unavailable rather than sending a number", async () => {
    const { runner } = healthRunner();

    const health = await getHealth(runner);

    expect(health.cacheHitRatio).toBe(DRUID_CACHE_HIT_RATIO_UNAVAILABLE);
    expect(Number.isNaN(Number(health.cacheHitRatio))).toBe(true);
  });

  test("caps the session list so the panel stays readable", async () => {
    const { runner, calls } = healthRunner();

    await getHealth(runner);

    expect(sqlFor(calls, "activeTasks")).toMatch(/ LIMIT \d+$/);
  });

  test("degrades to an empty panel on a cluster that denies every sys table", async () => {
    const { runner } = createRunner({
      failures: {
        identity: transportError("FORBIDDEN"),
        segmentTotals: transportError("FORBIDDEN"),
        runningTasks: transportError("FORBIDDEN"),
        activeTasks: transportError("FORBIDDEN"),
      },
      rows: { datasourceCount: [{ datasourceCount: 2 }] },
    });

    expect(await getHealth(runner)).toEqual({
      activeConnections: 0,
      databaseSize: "0 B",
      cacheHitRatio: DRUID_CACHE_HIT_RATIO_UNAVAILABLE,
      slowQueries: [],
      activeSessions: [],
    });
  });
});
