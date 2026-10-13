/**
 * The Snowflake monitoring panels, built so that opening the dashboard never starts a suspended warehouse.
 *
 * The Overview, table stats, index stats and health read only `SHOW`, which needs no running warehouse. Performance,
 * slow queries and running statements read Information Schema's `QUERY_HISTORY_BY_WAREHOUSE`, which does, so before
 * each such read that misses the cache a fresh `SHOW WAREHOUSES LIKE` is sent, never served from the cache, and the
 * Information Schema statement goes out only when that row's `state` is `STARTED` or `RESIZING`. A cached state is
 * not trusted for this: an administrator, or an `AUTO_SUSPEND` under a minute, can suspend the warehouse inside the
 * cache's 60 s. Only the Overview's display reuses a cached warehouse row.
 *
 * Information Schema answers are cached for 60 s by statement text, and every time window is written relative to
 * `CURRENT_TIMESTAMP()`, so the text is the same on every poll and the cache hits. A failed read is not cached.
 *
 * A degraded panel throws `SnowflakeError("query", <sentence>)`, which the dashboard shows under that panel.
 */
import type {
  DatabaseOverview,
  IndexStats,
  PerformanceMetrics,
  SlowQueryStats,
  StorageStats,
  TableStats,
  ActiveSessionDetails,
} from "@/lib/db/types";
import { formatBytes, formatDuration } from "@/lib/db/utils/pool-manager";
import { quoteLiteral } from "@/lib/sql/values";
import { SNOWFLAKE, SNOWFLAKE_ERROR_SENTENCES, SnowflakeError } from "./errors";
import {
  cellFlag,
  cellText,
  cellWholeNumber,
  connectStatement,
  indexColumns,
  quoteIdent,
  SNOWFLAKE_INTROSPECT_SENTENCES,
  SNOWFLAKE_SHOW_PAGE_ROWS,
  warehouseRow,
} from "./introspect";
import {
  foldIdentifier,
  SNOWFLAKE_QUERY_TAGS,
  type SnowflakeResult,
  type SnowflakeStatementRunner,
} from "./statements";

export const SNOWFLAKE_MONITORING_TTL_MS = 60_000;

export const SNOWFLAKE_MONITORING_SENTENCES = Object.freeze({
  suspended: (wh: string) =>
    `Warehouse ${wh} is suspended, and Studio does not start it to fill this panel. Run a query, then Refresh.`,
  noWarehouse: "Set Warehouse on the connection to see its load and queries.",
  needsMonitor: (wh: string) => `Needs MONITOR on warehouse ${wh} or MONITOR USAGE.`,
  storage: "Snowflake storage needs ACCOUNTADMIN; Studio does not read it.",
  noIndexes: "Snowflake has indexes only on hybrid tables; this schema has none.",
});

/** The empty-state words of the two panels whose rows depend on the role's grants on the warehouse. */
export const SNOWFLAKE_MONITORING_LABELS = Object.freeze({
  slowQueriesEmptyState: "Without MONITOR or OPERATE on the warehouse, Snowflake shows only this user's queries.",
  sessionsEmptyState: "Snowflake exposes no live session list here; these are running statements.",
});

export interface SnowflakeMonitoring {
  getOverview(): Promise<DatabaseOverview>;
  getPerformanceMetrics(): Promise<PerformanceMetrics>;
  getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]>;
  getActiveSessions(options?: { limit?: number }): Promise<ActiveSessionDetails[]>;
  getTableStats(options?: { schema?: string }): Promise<TableStats[]>;
  getIndexStats(options?: { schema?: string }): Promise<IndexStats[]>;
  getStorageStats(): Promise<StorageStats[]>;
}

/** The warehouse states in which an Information Schema read resumes nothing. */
const RUNNING_STATES: ReadonlySet<string> = new Set(["STARTED", "RESIZING"]);
/** The history's own row cap for the slow and running reads. */
const HISTORY_RESULT_LIMIT = 100;
const SLOW_QUERY_DEFAULT_LIMIT = 20;
const RUNNING_DEFAULT_LIMIT = 50;
const SECONDS_PER_HOUR = 3_600;
const LAST_HOUR = "DATEADD('hour', -1, CURRENT_TIMESTAMP())";

function literal(value: string): string {
  return quoteLiteral(value, SNOWFLAKE);
}

/** A caller's row limit as a whole number from 1 to the history's cap, or the panel's default. */
function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), HISTORY_RESULT_LIMIT);
}

function count(value: Parameters<typeof cellWholeNumber>[0]): number {
  return cellWholeNumber(value) ?? 0;
}

export function createSnowflakeMonitoring(input: {
  readonly run: SnowflakeStatementRunner;
  readonly warehouse: string | undefined;
  readonly database: string | undefined;
  readonly schema: string | undefined;
  readonly role: string;
  readonly now: () => number;
}): SnowflakeMonitoring {
  const { run, role, now } = input;
  const warehouse = input.warehouse === "" ? undefined : input.warehouse;
  const tag = SNOWFLAKE_QUERY_TAGS.monitoring;
  const cache = new Map<string, { readonly at: number; readonly result: Promise<SnowflakeResult> }>();

  /** A cached answer younger than the TTL; older entries are dropped on every read. */
  function cached(sql: string): Promise<SnowflakeResult> | undefined {
    const at = now();
    for (const [key, entry] of cache) if (at - entry.at >= SNOWFLAKE_MONITORING_TTL_MS) cache.delete(key);
    return cache.get(sql)?.result;
  }

  /** Sends `sql` and caches its answer; a failed read is dropped, so the next poll sends it again. */
  function store(sql: string): Promise<SnowflakeResult> {
    const result = run(sql, tag);
    cache.set(sql, { at: now(), result });
    result.catch(() => {
      if (cache.get(sql)?.result === result) cache.delete(sql);
    });
    return result;
  }

  /** The configured database's Information Schema; unqualified with Database empty, the user's default namespace. */
  function informationSchema(): string {
    return input.database ? `${quoteIdent(foldIdentifier(input.database))}.INFORMATION_SCHEMA` : "INFORMATION_SCHEMA";
  }

  /**
   * The warehouse as `QUERY_HISTORY_BY_WAREHOUSE` takes it: a string holding the identifier, double-quoted so a
   * mixed-case or spaced name is matched exactly, as Snowflake asks for those.
   */
  function warehouseArgument(wh: string): string {
    return literal(quoteIdent(foldIdentifier(wh)));
  }

  /** The gate: a cache hit, or a fresh state read showing the warehouse running, then the read itself. */
  async function informationSchemaRead(build: (wh: string) => string): Promise<SnowflakeResult> {
    if (warehouse === undefined) throw new SnowflakeError("query", SNOWFLAKE_MONITORING_SENTENCES.noWarehouse);
    const sql = build(warehouseArgument(warehouse));
    const hit = cached(sql);
    if (hit !== undefined) return hit;
    const row = warehouseRow(await run(connectStatement(warehouse), tag), warehouse);
    if (row === null) {
      throw new SnowflakeError("query", SNOWFLAKE_INTROSPECT_SENTENCES.noWarehouseRow(warehouse, role));
    }
    if (!RUNNING_STATES.has(cellText(row.state))) {
      throw new SnowflakeError("query", SNOWFLAKE_MONITORING_SENTENCES.suspended(warehouse));
    }
    return store(sql);
  }

  /** The schema a stats panel reads: the asked one in the configured database, or the configured one; else none. */
  function statsSchema(schema: string | undefined): string | null {
    if (!input.database) return null;
    const name = schema ?? (input.schema ? foldIdentifier(input.schema) : undefined);
    if (name === undefined || name === "") return null;
    return `${quoteIdent(foldIdentifier(input.database))}.${quoteIdent(name)}`;
  }

  function schemaName(schema: string | undefined): string {
    return schema ?? (input.schema ? foldIdentifier(input.schema) : "");
  }

  const privilegeRefusal = SNOWFLAKE_ERROR_SENTENCES.privileges(role, "");

  return {
    async getOverview() {
      let warehousePart = "";
      if (warehouse !== undefined) {
        const sql = connectStatement(warehouse);
        const row = warehouseRow(await (cached(sql) ?? store(sql)), warehouse);
        warehousePart =
          row === null
            ? `; no warehouse named ${warehouse} is visible to this role`
            : `; warehouse ${warehouse} ${cellText(row.state)}, ${cellText(row.size)}, ${count(row.running)} running, ${count(row.queued)} queued`;
      }
      const databases = await run(`SHOW DATABASES LIMIT ${SNOWFLAKE_SHOW_PAGE_ROWS}`, tag);
      const total = databases.rows.length;
      const counted =
        total >= SNOWFLAKE_SHOW_PAGE_ROWS
          ? `at least ${SNOWFLAKE_SHOW_PAGE_ROWS.toLocaleString("en-US")}`
          : total.toLocaleString("en-US");
      return {
        version: `Snowflake: ${counted} databases visible to role ${role}${warehousePart}`,
        uptime: "N/A",
        maxConnections: 0,
        databaseSize: "N/A",
        tableCount: 0,
        indexCount: 0,
      };
    },

    async getPerformanceMetrics() {
      let result: SnowflakeResult;
      try {
        result = await informationSchemaRead(
          (wh) =>
            `SELECT COUNT(*) AS n FROM TABLE(${informationSchema()}.QUERY_HISTORY_BY_WAREHOUSE(WAREHOUSE_NAME => ${wh}, END_TIME_RANGE_START => ${LAST_HOUR}, RESULT_LIMIT => 10000))`,
        );
      } catch (error) {
        if (warehouse !== undefined && error instanceof SnowflakeError && error.message.startsWith(privilegeRefusal)) {
          throw new SnowflakeError("query", SNOWFLAKE_MONITORING_SENTENCES.needsMonitor(warehouse));
        }
        throw error;
      }
      const queries = count(result.rows[0]?.N);
      return { queriesPerSecond: Math.round((queries / SECONDS_PER_HOUR) * 100) / 100 };
    },

    async getSlowQueries(options) {
      const limit = clampLimit(options?.limit, SLOW_QUERY_DEFAULT_LIMIT);
      const result = await informationSchemaRead(
        (wh) =>
          `SELECT query_id, query_text, total_elapsed_time, rows_produced FROM TABLE(${informationSchema()}.QUERY_HISTORY_BY_WAREHOUSE(WAREHOUSE_NAME => ${wh}, END_TIME_RANGE_START => ${LAST_HOUR}, RESULT_LIMIT => ${HISTORY_RESULT_LIMIT})) WHERE execution_status = 'SUCCESS' ORDER BY total_elapsed_time DESC LIMIT ${limit}`,
      );
      return result.rows.map((row) => {
        const elapsed = count(row.TOTAL_ELAPSED_TIME);
        return {
          queryId: cellText(row.QUERY_ID),
          query: cellText(row.QUERY_TEXT),
          calls: 1,
          totalTime: elapsed,
          avgTime: elapsed,
          rows: count(row.ROWS_PRODUCED),
        };
      });
    },

    async getActiveSessions(options) {
      const limit = clampLimit(options?.limit, RUNNING_DEFAULT_LIMIT);
      const result = await informationSchemaRead(
        (wh) =>
          `SELECT query_id, user_name, database_name, execution_status, query_text, start_time, DATEDIFF('millisecond', start_time, CURRENT_TIMESTAMP()) AS ms FROM TABLE(${informationSchema()}.QUERY_HISTORY_BY_WAREHOUSE(WAREHOUSE_NAME => ${wh}, RESULT_LIMIT => ${HISTORY_RESULT_LIMIT})) WHERE execution_status IN ('RUNNING', 'QUEUED') ORDER BY start_time LIMIT ${limit}`,
      );
      return result.rows.map((row) => {
        const durationMs = count(row.MS);
        return {
          pid: cellText(row.QUERY_ID),
          user: cellText(row.USER_NAME),
          database: cellText(row.DATABASE_NAME),
          state: cellText(row.EXECUTION_STATUS).toLowerCase(),
          query: cellText(row.QUERY_TEXT),
          duration: formatDuration(durationMs),
          durationMs,
        };
      });
    },

    async getTableStats(options) {
      const qualified = statsSchema(options?.schema);
      if (qualified === null) return [];
      // SHOW TABLES answered all 10,250 rows of a schema without a LIMIT on the trial; the panel reads the first
      // 10,000 to stay bounded.
      const result = await run(`SHOW TABLES IN SCHEMA ${qualified} LIMIT ${SNOWFLAKE_SHOW_PAGE_ROWS}`, tag);
      const schema = schemaName(options?.schema);
      return result.rows.map((row) => {
        const bytes = count(row.bytes);
        return {
          schemaName: schema,
          tableName: cellText(row.name),
          rowCount: count(row.rows),
          // Scan bytes, not storage, so labelled as such.
          totalSize: `${formatBytes(bytes)} scanned`,
          totalSizeBytes: bytes,
        };
      });
    },

    async getIndexStats(options) {
      const qualified = statsSchema(options?.schema);
      if (qualified === null) return [];
      const result = await run(`SHOW INDEXES IN SCHEMA ${qualified}`, tag);
      if (result.rows.length === 0) throw new SnowflakeError("query", SNOWFLAKE_MONITORING_SENTENCES.noIndexes);
      const schema = schemaName(options?.schema);
      return result.rows.map((row) => ({
        schemaName: schema,
        tableName: cellText(row.table),
        indexName: cellText(row.name),
        indexType: cellText(row.kind),
        columns: indexColumns(row.columns),
        isUnique: cellFlag(row.is_unique),
        isPrimary: false,
        // Snowflake publishes no per-index size or scan count; `scans` is the zero the type requires.
        indexSize: "N/A",
        scans: 0,
      }));
    },

    async getStorageStats() {
      throw new SnowflakeError("query", SNOWFLAKE_MONITORING_SENTENCES.storage);
    },
  };
}
