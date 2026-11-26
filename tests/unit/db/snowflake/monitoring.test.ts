import { describe, expect, test } from "bun:test";
import { SNOWFLAKE_ERROR_SENTENCES, SnowflakeError } from "@/lib/db/providers/sql/snowflake/errors";
import { SNOWFLAKE_INTROSPECT_SENTENCES } from "@/lib/db/providers/sql/snowflake/introspect";
import {
  createSnowflakeMonitoring,
  SNOWFLAKE_MONITORING_LABELS,
  SNOWFLAKE_MONITORING_SENTENCES,
  SNOWFLAKE_MONITORING_TTL_MS,
} from "@/lib/db/providers/sql/snowflake/monitoring";
import { SNOWFLAKE_QUERY_TAGS } from "@/lib/db/providers/sql/snowflake/statements";
import { fakeRunner, type RunnerAnswer, showResult } from "../../../helpers/snowflake-runner";

const ROLE = "STUDIO_RO";
const STATE_SQL = "SHOW WAREHOUSES LIKE 'studio_wh'";
const IS = '"SALES".INFORMATION_SCHEMA';
const WH = `'"STUDIO_WH"'`;
const SLOW_SQL = `SELECT query_id, query_text, total_elapsed_time, rows_produced FROM TABLE(${IS}.QUERY_HISTORY_BY_WAREHOUSE(WAREHOUSE_NAME => ${WH}, END_TIME_RANGE_START => DATEADD('hour', -1, CURRENT_TIMESTAMP()), RESULT_LIMIT => 100)) WHERE execution_status = 'SUCCESS' ORDER BY total_elapsed_time DESC LIMIT 20`;
const RUNNING_SQL = `SELECT query_id, user_name, database_name, execution_status, query_text, start_time, DATEDIFF('millisecond', start_time, CURRENT_TIMESTAMP()) AS ms FROM TABLE(${IS}.QUERY_HISTORY_BY_WAREHOUSE(WAREHOUSE_NAME => ${WH}, RESULT_LIMIT => 100)) WHERE execution_status IN ('RUNNING', 'QUEUED') ORDER BY start_time LIMIT 50`;
const PERFORMANCE_SQL = `SELECT COUNT(*) AS n FROM TABLE(${IS}.QUERY_HISTORY_BY_WAREHOUSE(WAREHOUSE_NAME => ${WH}, END_TIME_RANGE_START => DATEADD('hour', -1, CURRENT_TIMESTAMP()), RESULT_LIMIT => 10000))`;
const IS_READ = /INFORMATION_SCHEMA/;

const warehouseAnswer =
  (...rows: [name: string, state: string][]) =>
  () =>
    showResult(
      ["name", "state", "size", "running", "queued", "auto_resume"],
      rows.map(([name, state]) => [name, state, "X-Small", "2", "1", "true"]),
    );

const SLOW_ROWS = () =>
  showResult(
    ["QUERY_ID", "QUERY_TEXT", "TOTAL_ELAPSED_TIME", "ROWS_PRODUCED"],
    [
      ["01b2-1", "SELECT 1", "4200", "1"],
      ["01b2-2", "SELECT 2", "900", "10"],
    ],
  );
const RUNNING_ROWS = () =>
  showResult(
    ["QUERY_ID", "USER_NAME", "DATABASE_NAME", "EXECUTION_STATUS", "QUERY_TEXT", "START_TIME", "MS"],
    [["01b2-9", "ANA", "SALES", "RUNNING", "SELECT SLEEP", "2026-10-12 08:00:00", "65000"]],
  );
const PERFORMANCE_ROWS = () => showResult(["N"], [["7200"]]);

/** A monitoring object over a scripted runner whose warehouse state can change between calls. */
function setup(
  options: { warehouse?: string; database?: string; schema?: string; extra?: [RegExp, RunnerAnswer][] } = {},
) {
  let state = "STARTED";
  let clock = 0;
  const { run, calls } = fakeRunner([
    ...(options.extra ?? []),
    [/^SHOW WAREHOUSES /, () => warehouseAnswer(["STUDIO_WH", state])()],
    [/^SHOW DATABASES /, () => showResult(["name"], [["SALES"], ["ANALYTICS"]])],
    [/^SHOW TERSE TABLES /, () => showResult(["name"], [["ORDERS"], ["ITEMS"], ["USERS"]])],
    [/^SHOW INDEXES /, () => showResult(["name"], [["ORDERS_IDX"]])],
    [/QUERY_HISTORY_BY_WAREHOUSE.*total_elapsed_time DESC/, SLOW_ROWS],
    [/QUERY_HISTORY_BY_WAREHOUSE.*'RUNNING', 'QUEUED'/, RUNNING_ROWS],
    [/^SELECT COUNT\(\*\) AS n /, PERFORMANCE_ROWS],
  ]);
  const monitoring = createSnowflakeMonitoring({
    run,
    warehouse: "warehouse" in options ? options.warehouse : "studio_wh",
    database: "database" in options ? options.database : "SALES",
    schema: "schema" in options ? options.schema : "PUBLIC",
    role: ROLE,
    now: () => clock,
  });
  return {
    monitoring,
    calls,
    sql: () => calls.map((call) => call.sql),
    suspend: () => {
      state = "SUSPENDED";
    },
    setState: (next: string) => {
      state = next;
    },
    at: (ms: number) => {
      clock = ms;
    },
  };
}

describe("the sentences and labels", () => {
  test("exactly", () => {
    expect(SNOWFLAKE_MONITORING_TTL_MS).toBe(60_000);
    expect(SNOWFLAKE_MONITORING_SENTENCES.suspended("WH")).toBe(
      "Warehouse WH is suspended, and Studio does not start it to fill this panel. Run a query, then Refresh.",
    );
    expect(SNOWFLAKE_MONITORING_SENTENCES.noWarehouse).toBe(
      "Set Warehouse on the connection to see its load and queries.",
    );
    expect(SNOWFLAKE_MONITORING_SENTENCES.needsMonitor("WH")).toBe("Needs MONITOR on warehouse WH or MONITOR USAGE.");
    expect(SNOWFLAKE_MONITORING_SENTENCES.storage).toBe(
      "Snowflake storage needs ACCOUNTADMIN; Studio does not read it.",
    );
    expect(SNOWFLAKE_MONITORING_SENTENCES.noIndexes).toBe(
      "Snowflake has indexes only on hybrid tables; this schema has none.",
    );
    expect(SNOWFLAKE_MONITORING_LABELS).toEqual({
      slowQueriesEmptyState: "Without MONITOR or OPERATE on the warehouse, Snowflake shows only this user's queries.",
      sessionsEmptyState: "Snowflake exposes no live session list here; these are running statements.",
    });
  });
});

describe("each panel's statement", () => {
  test("slow queries: a fresh state read, then the history, both tagged monitoring", async () => {
    const harness = setup();
    const slow = await harness.monitoring.getSlowQueries();
    expect(harness.calls).toEqual([
      { sql: STATE_SQL, tag: SNOWFLAKE_QUERY_TAGS.monitoring },
      { sql: SLOW_SQL, tag: SNOWFLAKE_QUERY_TAGS.monitoring },
    ]);
    expect(slow).toEqual([
      { queryId: "01b2-1", query: "SELECT 1", calls: 1, totalTime: 4200, avgTime: 4200, rows: 1 },
      { queryId: "01b2-2", query: "SELECT 2", calls: 1, totalTime: 900, avgTime: 900, rows: 10 },
    ]);
  });

  test("slow queries clamp the limit to 1 through 100", async () => {
    const high = setup();
    await high.monitoring.getSlowQueries({ limit: 500 });
    expect(high.sql()[1]).toEndWith("LIMIT 100");
    const low = setup();
    await low.monitoring.getSlowQueries({ limit: 0 });
    expect(low.sql()[1]).toEndWith("LIMIT 1");
  });

  test("running statements", async () => {
    const harness = setup();
    const sessions = await harness.monitoring.getActiveSessions();
    expect(harness.sql()).toEqual([STATE_SQL, RUNNING_SQL]);
    expect(sessions).toEqual([
      {
        pid: "01b2-9",
        user: "ANA",
        database: "SALES",
        state: "running",
        query: "SELECT SLEEP",
        duration: "1.08m",
        durationMs: 65_000,
      },
    ]);
    const capped = setup();
    await capped.monitoring.getActiveSessions({ limit: 1_000 });
    expect(capped.sql()[1]).toEndWith("LIMIT 100");
  });

  test("performance: queries per second over the last hour, and nothing else", async () => {
    const harness = setup();
    expect(await harness.monitoring.getPerformanceMetrics()).toEqual({ queriesPerSecond: 2 });
    expect(harness.sql()).toEqual([STATE_SQL, PERFORMANCE_SQL]);
  });

  test("with Database empty the history is read unqualified", async () => {
    const harness = setup({ database: undefined });
    await harness.monitoring.getPerformanceMetrics();
    expect(harness.sql()[1]).toContain("FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_WAREHOUSE(");
  });

  test("a quoted warehouse is passed to the history in its quotes", async () => {
    const harness = setup({
      warehouse: '"My WH"',
      extra: [[/^SHOW WAREHOUSES /, warehouseAnswer(["MY WH", "SUSPENDED"], ["My WH", "STARTED"])]],
    });
    await harness.monitoring.getPerformanceMetrics();
    expect(harness.sql()).toEqual(["SHOW WAREHOUSES LIKE 'My WH'", PERFORMANCE_SQL.replace(WH, `'"My WH"'`)]);
  });

  test("overview: the warehouse row, the database count, and the tables and indexes it measured (SF-036)", async () => {
    const harness = setup();
    const overview = await harness.monitoring.getOverview();
    expect(harness.calls).toEqual([
      { sql: STATE_SQL, tag: SNOWFLAKE_QUERY_TAGS.monitoring },
      { sql: "SHOW DATABASES LIMIT 10000", tag: SNOWFLAKE_QUERY_TAGS.monitoring },
      { sql: 'SHOW TERSE TABLES IN DATABASE "SALES" LIMIT 10000', tag: SNOWFLAKE_QUERY_TAGS.monitoring },
      { sql: 'SHOW INDEXES IN DATABASE "SALES"', tag: SNOWFLAKE_QUERY_TAGS.monitoring },
    ]);
    expect(overview).toEqual({
      version: `Snowflake: 2 databases visible to role ${ROLE}; warehouse studio_wh STARTED, X-Small, 2 running and 1 queued, Studio's own reads included`,
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 3,
      indexCount: 1,
    });
  });

  test("overview of a suspended warehouse names no running or queued count (SF-036)", async () => {
    const harness = setup();
    harness.suspend();
    expect((await harness.monitoring.getOverview()).version).toBe(
      `Snowflake: 2 databases visible to role ${ROLE}; warehouse studio_wh SUSPENDED, X-Small`,
    );
    harness.setState("RESIZING");
    harness.at(SNOWFLAKE_MONITORING_TTL_MS + 1);
    expect((await harness.monitoring.getOverview()).version).toContain("RESIZING, X-Small, 2 running and 1 queued");
  });

  test("overview with Database empty counts the account's tables and indexes", async () => {
    const harness = setup({ database: undefined });
    await harness.monitoring.getOverview();
    expect(harness.sql().slice(2)).toEqual(["SHOW TERSE TABLES IN ACCOUNT LIMIT 10000", "SHOW INDEXES IN ACCOUNT"]);
  });

  test("overview counts 10,000 tables as a floor and says what it counted", async () => {
    const many = Array.from({ length: 10_000 }, (_, index) => [`T${index}`]);
    const inDatabase = setup({ extra: [[/^SHOW TERSE TABLES /, () => showResult(["name"], many)]] });
    expect(await inDatabase.monitoring.getOverview()).toMatchObject({
      tableCount: 10_000,
      tableCountSampledFrom: "the first 10,000 tables Snowflake listed in database SALES",
    });
    const inAccount = setup({
      database: undefined,
      extra: [[/^SHOW TERSE TABLES /, () => showResult(["name"], many)]],
    });
    expect((await inAccount.monitoring.getOverview()).tableCountSampledFrom).toBe(
      "the first 10,000 tables Snowflake listed in the account",
    );
    expect((await setup().monitoring.getOverview()).tableCountSampledFrom).toBeUndefined();
  });

  test("overview of a warehouse the role does not see says so", async () => {
    const harness = setup({ extra: [[/^SHOW WAREHOUSES /, warehouseAnswer(["OTHER", "STARTED"])]] });
    const overview = await harness.monitoring.getOverview();
    expect(overview.version).toBe(
      `Snowflake: 2 databases visible to role ${ROLE}; no warehouse named studio_wh is visible to this role`,
    );
  });

  test("overview counts 10,000 databases as a floor", async () => {
    const many = Array.from({ length: 10_000 }, (_, index) => [`D${index}`]);
    const harness = setup({ warehouse: undefined, extra: [[/^SHOW DATABASES /, () => showResult(["name"], many)]] });
    expect((await harness.monitoring.getOverview()).version).toBe(
      `Snowflake: at least 10,000 databases visible to role ${ROLE}`,
    );
  });

  test("table stats: SHOW TABLES in the configured schema, bytes labelled as scanned", async () => {
    const harness = setup({
      extra: [
        [
          /^SHOW TABLES /,
          () =>
            showResult(
              ["name", "rows", "bytes"],
              [
                ["ORDERS", "12", "2048"],
                ["EXT", null, null],
              ],
            ),
        ],
      ],
    });
    const stats = await harness.monitoring.getTableStats();
    expect(harness.calls).toEqual([
      { sql: 'SHOW TABLES IN SCHEMA "SALES"."PUBLIC" LIMIT 10000', tag: SNOWFLAKE_QUERY_TAGS.monitoring },
    ]);
    expect(stats).toEqual([
      { schemaName: "PUBLIC", tableName: "ORDERS", rowCount: 12, totalSize: "2 KB scanned", totalSizeBytes: 2048 },
      { schemaName: "PUBLIC", tableName: "EXT", rowCount: 0, totalSize: "0 B scanned", totalSizeBytes: 0 },
    ]);
  });

  test("table stats take the asked schema, and answer none with no database or schema", async () => {
    const asked = setup({ extra: [[/^SHOW TABLES /, () => showResult(["name"], [])]] });
    await asked.monitoring.getTableStats({ schema: "raw" });
    expect(asked.sql()).toEqual(['SHOW TABLES IN SCHEMA "SALES"."raw" LIMIT 10000']);
    const none = setup({ schema: undefined });
    expect(await none.monitoring.getTableStats()).toEqual([]);
    const noDatabase = setup({ database: undefined });
    expect(await noDatabase.monitoring.getIndexStats()).toEqual([]);
    expect([...none.calls, ...noDatabase.calls]).toEqual([]);
  });

  test("index stats: hybrid indexes, or the sentence when the schema has none", async () => {
    const harness = setup({
      extra: [
        [
          /^SHOW INDEXES /,
          () =>
            showResult(
              ["name", "table", "kind", "is_unique", "columns"],
              [["BY_ID", "HT", "KEY_VALUE_INDEX", "Y", "[ID]"]],
            ),
        ],
      ],
    });
    expect(await harness.monitoring.getIndexStats()).toEqual([
      {
        schemaName: "PUBLIC",
        tableName: "HT",
        indexName: "BY_ID",
        indexType: "KEY_VALUE_INDEX",
        columns: ["ID"],
        isUnique: true,
        isPrimary: false,
        indexSize: "N/A",
        scans: 0,
      },
    ]);
    expect(harness.sql()).toEqual(['SHOW INDEXES IN SCHEMA "SALES"."PUBLIC"']);
    const empty = setup({ extra: [[/^SHOW INDEXES /, () => showResult(["name"], [])]] });
    await expect(empty.monitoring.getIndexStats()).rejects.toThrow(SNOWFLAKE_MONITORING_SENTENCES.noIndexes);
  });

  test("storage answers its sentence and sends nothing", async () => {
    const harness = setup();
    await expect(harness.monitoring.getStorageStats()).rejects.toThrow(SNOWFLAKE_MONITORING_SENTENCES.storage);
    expect(harness.calls).toEqual([]);
  });
});

describe("the warehouse-state gate (SR18)", () => {
  const gated = ["getPerformanceMetrics", "getSlowQueries", "getActiveSessions"] as const;

  test("SUSPENDED: no Information Schema statement, and the suspended sentence", async () => {
    const harness = setup();
    harness.suspend();
    for (const panel of gated) {
      // oxlint-disable-next-line no-await-in-loop -- one panel at a time keeps the recorded order.
      const error = await harness.monitoring[panel]().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SnowflakeError);
      expect((error as SnowflakeError).category).toBe("query");
      expect((error as SnowflakeError).message).toBe(SNOWFLAKE_MONITORING_SENTENCES.suspended("studio_wh"));
    }
    expect(harness.sql()).toEqual([STATE_SQL, STATE_SQL, STATE_SQL]);
  });

  test("RESIZING counts as running", async () => {
    const harness = setup();
    harness.setState("RESIZING");
    await harness.monitoring.getSlowQueries();
    expect(harness.sql()).toEqual([STATE_SQL, SLOW_SQL]);
  });

  test("a warehouse the role does not see sends no Information Schema statement", async () => {
    const harness = setup({ extra: [[/^SHOW WAREHOUSES /, warehouseAnswer(["OTHER", "STARTED"])]] });
    await expect(harness.monitoring.getSlowQueries()).rejects.toThrow(
      SNOWFLAKE_INTROSPECT_SENTENCES.noWarehouseRow("studio_wh", ROLE),
    );
    expect(harness.calls.some((call) => IS_READ.test(call.sql))).toBe(false);
  });

  test("STARTED: each read once; 30 s later a cache hit sends nothing; after 61 s the state is read fresh first", async () => {
    const harness = setup();
    for (const panel of gated) await harness.monitoring[panel](); // oxlint-disable-line no-await-in-loop
    expect(harness.sql()).toEqual([STATE_SQL, PERFORMANCE_SQL, STATE_SQL, SLOW_SQL, STATE_SQL, RUNNING_SQL]);
    harness.at(30_000);
    for (const panel of gated) await harness.monitoring[panel](); // oxlint-disable-line no-await-in-loop
    expect(harness.calls).toHaveLength(6);
    harness.at(61_000);
    harness.suspend();
    await expect(harness.monitoring.getSlowQueries()).rejects.toThrow(
      SNOWFLAKE_MONITORING_SENTENCES.suspended("studio_wh"),
    );
    expect(harness.sql().slice(6)).toEqual([STATE_SQL]);
  });

  test("a cached STARTED overview row does not open the gate after the warehouse suspends", async () => {
    const harness = setup();
    await harness.monitoring.getOverview();
    harness.suspend();
    harness.at(10_000);
    const overview = await harness.monitoring.getOverview();
    expect(overview.version).toContain("STARTED");
    await expect(harness.monitoring.getSlowQueries()).rejects.toThrow(
      SNOWFLAKE_MONITORING_SENTENCES.suspended("studio_wh"),
    );
    // The overview's second call reused its row; the gate read the state fresh.
    const counts = [
      "SHOW DATABASES LIMIT 10000",
      'SHOW TERSE TABLES IN DATABASE "SALES" LIMIT 10000',
      'SHOW INDEXES IN DATABASE "SALES"',
    ];
    expect(harness.sql()).toEqual([STATE_SQL, ...counts, ...counts, STATE_SQL]);
    expect(harness.calls.some((call) => IS_READ.test(call.sql))).toBe(false);
  });

  test("the warehouse row is picked by exact name from an answer holding A_B and AXB", async () => {
    const harness = setup({
      warehouse: "A_B",
      extra: [[/^SHOW WAREHOUSES /, warehouseAnswer(["AXB", "STARTED"], ["A_B", "SUSPENDED"])]],
    });
    await expect(harness.monitoring.getSlowQueries()).rejects.toThrow(SNOWFLAKE_MONITORING_SENTENCES.suspended("A_B"));
    expect((await harness.monitoring.getOverview()).version).toContain("warehouse A_B SUSPENDED");
    expect(harness.calls.some((call) => IS_READ.test(call.sql))).toBe(false);
  });

  test("Warehouse empty: the three answer the no-warehouse sentence and send nothing; the overview omits the warehouse", async () => {
    const harness = setup({ warehouse: undefined });
    for (const panel of gated) {
      // oxlint-disable-next-line no-await-in-loop -- one panel at a time keeps the recorded order.
      await expect(harness.monitoring[panel]()).rejects.toThrow(SNOWFLAKE_MONITORING_SENTENCES.noWarehouse);
    }
    expect(harness.calls).toEqual([]);
    const overview = await harness.monitoring.getOverview();
    expect(harness.sql()).toEqual([
      "SHOW DATABASES LIMIT 10000",
      'SHOW TERSE TABLES IN DATABASE "SALES" LIMIT 10000',
      'SHOW INDEXES IN DATABASE "SALES"',
    ]);
    expect(overview.version).toBe(`Snowflake: 2 databases visible to role ${ROLE}`);
  });

  test("two calls a minute apart build byte-identical statement text", async () => {
    const harness = setup();
    await harness.monitoring.getSlowQueries();
    harness.at(SNOWFLAKE_MONITORING_TTL_MS + 1);
    await harness.monitoring.getSlowQueries();
    const reads = harness.sql().filter((sql) => IS_READ.test(sql));
    expect(reads).toHaveLength(2);
    expect(reads[0]).toBe(reads[1]);
  });

  test("a privilege refusal on performance is the grant sentence, and is not cached", async () => {
    let refuse = true;
    const harness = setup({
      extra: [
        [
          /^SELECT COUNT\(\*\) AS n /,
          () =>
            refuse
              ? new SnowflakeError("query", SNOWFLAKE_ERROR_SENTENCES.privileges(ROLE, "Insufficient privileges."))
              : PERFORMANCE_ROWS(),
        ],
      ],
    });
    await expect(harness.monitoring.getPerformanceMetrics()).rejects.toThrow(
      SNOWFLAKE_MONITORING_SENTENCES.needsMonitor("studio_wh"),
    );
    refuse = false;
    expect(await harness.monitoring.getPerformanceMetrics()).toEqual({ queriesPerSecond: 2 });
    expect(harness.sql().filter((sql) => IS_READ.test(sql))).toHaveLength(2);
  });

  test("any other failure is not cached and travels as it is", async () => {
    const failure = new SnowflakeError("unavailable", "down");
    let fail = true;
    const harness = setup({ extra: [[/total_elapsed_time DESC/, () => (fail ? failure : SLOW_ROWS())]] });
    await expect(harness.monitoring.getSlowQueries()).rejects.toBe(failure);
    fail = false;
    expect(await harness.monitoring.getSlowQueries()).toHaveLength(2);
  });
});

describe("the Overview's warehouse load", () => {
  test("the Overview's version ends with the warehouse's state, size and load, Studio's reads included (SF-036)", async () => {
    const answers: Record<string, string[][]> = {
      "SHOW WAREHOUSES": [["WH", "STARTED", "X-Small", "2", "0"]],
      "SHOW DATABASES": [["DB"]],
      "SHOW TERSE TABLES": [["T"]],
      "SHOW INDEXES": [],
    };
    const monitoring = createSnowflakeMonitoring({
      run: async (sql) => {
        const key = Object.keys(answers).find((prefix) => sql.startsWith(prefix)) ?? "";
        const columns = ["name", "state", "size", "running", "queued"];
        const rows = answers[key].map((row) => Object.fromEntries(row.map((cell, index) => [columns[index], cell])));
        return { rows, fields: columns, columnTypes: {}, warnings: [], cut: false, numRows: rows.length };
      },
      warehouse: "WH",
      database: "DB",
      schema: undefined,
      role: "R",
      now: () => 0,
    });
    const overview = await monitoring.getOverview();
    expect(overview.version).toEndWith("STARTED, X-Small, 2 running and 0 queued, Studio's own reads included");
  });
});
