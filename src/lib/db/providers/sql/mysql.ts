/**
 * MySQL Database Provider
 * Full MySQL support with connection pooling using mysql2
 */

import mysql, { type Pool, type PoolConnection, type RowDataPacket, type FieldPacket } from "mysql2/promise";
import { SQLBaseProvider } from "./sql-base";
import { mysqlColumnTypes } from "./column-types";
import {
  type DatabaseConnection,
  type TableSchema,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type ProviderCapabilities,
  type ProviderLabels,
  type SlowQuery,
  type ActiveSession,
  type DatabaseOverview,
  type PerformanceMetrics,
  type SlowQueryStats,
  type ActiveSessionDetails,
  type TableStats,
  type IndexStats,
  type StorageStats,
} from "../../types";
import { DatabaseConfigError, ConnectionError, QueryError, mapDatabaseError } from "../../errors";
import { formatBytes } from "../../utils/pool-manager";
import { CACHE_HIT_RATIO_UNAVAILABLE, formatCacheHitRatio, measuredNumber } from "@/lib/monitoring-cache-ratio";

/**
 * mysql2 3.23 narrowed `execute`'s values parameter from `any` to a concrete
 * `ExecuteValues` union that excludes `undefined`. The provider interface every
 * driver implements passes `unknown[]` - it cannot be narrowed here without
 * narrowing it for MongoDB and Redis too - so the array is cast at this one
 * boundary.
 *
 * The cast changes nothing about what reaches the server: mysql2 validates
 * every bind value itself and REJECTS `undefined` outright ("Bind parameters
 * must not contain undefined. To pass SQL NULL specify JS null", thrown from
 * lib/base/connection.js). It is not coerced to NULL, before or after this
 * change - callers wanting SQL NULL must pass `null`. The new typing states
 * that rule; this cast keeps the runtime rule as the thing that enforces it.
 *
 * Derived from the method signature rather than importing `ExecuteValues` by
 * name, so a future rename in mysql2 surfaces as a type error here instead of
 * an unresolved import.
 */
type ExecuteParams = Parameters<PoolConnection["execute"]>[1];
const asExecuteParams = (params?: unknown[]): ExecuteParams => params as ExecuteParams;

/**
 * Anything this provider can issue a statement over: the pool, a pooled
 * connection, and the connection a transaction holds. All three are used.
 */
type MySQLQueryable = Pick<PoolConnection, "query" | "execute">;

/**
 * Every statement this provider issues goes through here, and the protocol is
 * chosen by one fact: whether the statement carries parameters.
 *
 * mysql2 offers two: `query` speaks MySQL's TEXT protocol, `execute` the BINARY
 * PREPARED one. Everything here used to call `execute`, parameterless statements
 * included, and three engines refuse whole statement classes on that protocol
 * with `This command is not supported in the prepared statement protocol yet`:
 *
 * - SingleStore 9.1.1 (`ghcr.io/singlestore-labs/singlestoredb-dev:0.2.82`),
 *   measured 2026-08-24 both ways over one connection: `SHOW STATUS`,
 *   `SHOW VARIABLES`, `EXPLAIN`, `EXPLAIN JSON`, `OPTIMIZE TABLE` and
 *   `CHECK TABLE` all fail prepared with `ER_UNSUPPORTED_PS` and all succeed as
 *   text. `EXPLAIN FORMAT=JSON` is NOT in that list: it is `ER_PARSE_ERROR` on
 *   both protocols there, because SingleStore's grammar is `EXPLAIN JSON`, so the
 *   Explain panel is not something this helper recovers.
 * - StarRocks 3.3, whose overview this recovers (measured through the provider,
 *   2026-08-24); its health still fails on a missing
 *   `information_schema.PROCESSLIST`, which is the engine's gap, not the protocol.
 * - MySQL 26.7.0 itself refuses `CHECK TABLE` prepared - measured 2026-08-24 on
 *   `mysql:latest` - so one maintenance action was unavailable on the engine this
 *   provider is named for.
 *
 * A parameterised statement keeps `execute`: the placeholders are what the
 * prepared protocol is for, and binding is what keeps a value out of the SQL text.
 * An empty array carries no parameter and is nothing to bind, so it takes the text
 * path with the parameterless statements.
 *
 * Moving the read path across is safe because the two protocols decode to the same
 * JS shapes. Measured 2026-08-24 on MySQL 26.7.0 over one connection, the same
 * SELECT both ways across TINYINT(1), INT, BIGINT past 2^53, BIGINT UNSIGNED,
 * DECIMAL, FLOAT, DOUBLE, DATE, DATETIME, TIMESTAMP, TIME, YEAR, CHAR, VARCHAR,
 * TEXT, BLOB, BIT(1), BIT(8), JSON, ENUM, SET and NULLs: every value identical by
 * `typeof` and by `JSON.stringify`, every `FieldPacket` identical in `columnType`,
 * `flags`, `characterSet`, `columnLength` and `decimals` - so `columnTypes` names
 * the same types - and a non-result-set statement answers the same
 * `ResultSetHeader`, which is what `buildQueryResult` reads. See
 * `docs/providers/mysql.md` section 3.4.
 */
const runStatement = <T extends RowDataPacket[] = RowDataPacket[]>(
  queryable: MySQLQueryable,
  sql: string,
  params?: unknown[],
): Promise<[T, FieldPacket[]]> =>
  params === undefined || params.length === 0
    ? queryable.query<T>(sql)
    : queryable.execute<T>(sql, asExecuteParams(params));

/**
 * One row of MySQL's answer to `ANALYZE`/`OPTIMIZE`/`CHECK TABLE`. These statements
 * return a RESULT SET, not a header: the outcome is data, and reading it is the only
 * way to know what happened.
 */
interface MaintenanceReportRow extends RowDataPacket {
  Table: string;
  Op: string;
  Msg_type: string;
  Msg_text: string;
}

/**
 * MySQL's verdict on a table maintenance statement, taken from the statement's own
 * answer.
 *
 * The statement does NOT throw when the server refuses it: measured through this
 * provider against MySQL 26.7.0 (`libredb-mysql`) on 2026-08-25, `OPTIMIZE TABLE
 * \`missing\`` resolves normally and answers
 *
 *   [{ Table: 'u9t.missing', Op: 'optimize', Msg_type: 'Error',
 *      Msg_text: "Table 'u9t.missing' doesn't exist" },
 *    { Table: 'u9t.missing', Op: 'optimize', Msg_type: 'status',
 *      Msg_text: 'Operation failed' }]
 *
 * so `await runStatement(...); return { success: true }` reported a completed
 * operation for a statement the server had rejected - and discarded the `Msg_text`
 * that is the entire point of `CHECK TABLE`, whose OK-or-corruption-report is the only
 * thing the user asked for. `Msg_type` is the decision (`'Error'` from the server,
 * matched case-insensitively because the manual documents the set in lower case), and
 * the same read is what SQLite's `check` already does with `PRAGMA integrity_check`.
 *
 * The whole-database form names every table in one statement, so a failing table is
 * quoted WITH its name - it is the only place the failure appears - while a successful
 * run quotes the messages alone and deduplicates them: over forty tables the OK and
 * InnoDB's "doing recreate + analyze instead" note repeat once per table and say the
 * same thing forty times.
 */
function readMaintenanceReport(
  type: MaintenanceType,
  rows: MaintenanceReportRow[],
): { success: boolean; message: string } {
  const failures = rows.filter((row) => String(row.Msg_type).toLowerCase() === "error");
  if (failures.length > 0) {
    return {
      success: false,
      message: `${type.toUpperCase()} failed: ${unique(failures.map((row) => `${row.Table}: ${row.Msg_text}`)).join("; ")}`,
    };
  }

  // A statement that answers no row at all leaves nothing to quote; the generic
  // sentence is then all there is to say.
  if (rows.length === 0) {
    return { success: true, message: `${type.toUpperCase()} completed successfully` };
  }

  return { success: true, message: `${type.toUpperCase()}: ${unique(rows.map((row) => row.Msg_text)).join("; ")}` };
}

const unique = (values: string[]): string[] => [...new Set(values)];

// ============================================================================
// SQL Statements
// ============================================================================
// Multi-line SQL is hoisted to module scope so per-line coverage attribution
// stays stable (repo pattern, see the SCHEMA_*_SQL consts in mssql.ts).

const SCHEMA_TABLES_SQL = `
        SELECT
          TABLE_NAME as table_name,
          TABLE_ROWS as row_count,
          DATA_LENGTH + INDEX_LENGTH as total_size
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME ASC;
      `;

const SCHEMA_COLUMNS_SQL = `
          SELECT
            COLUMN_NAME as column_name,
            DATA_TYPE as data_type,
            IS_NULLABLE as is_nullable,
            COLUMN_DEFAULT as column_default,
            COLUMN_KEY as column_key
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION
          LIMIT 100;
        `;

const SCHEMA_FOREIGN_KEYS_SQL = `
          SELECT
            COLUMN_NAME as column_name,
            REFERENCED_TABLE_NAME as referenced_table,
            REFERENCED_COLUMN_NAME as referenced_column
          FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL;
        `;

const SCHEMA_INDEXES_SQL = `
          SELECT
            INDEX_NAME as index_name,
            GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) as columns,
            NOT NON_UNIQUE as is_unique
          FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = ?
          GROUP BY INDEX_NAME, NON_UNIQUE;
        `;

const DATABASE_SIZE_MB_SQL = `
        SELECT
          ROUND(SUM(DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) as size_mb
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?;
      `;

// Shared by getHealth() and getPerformanceMetrics().
const BUFFER_CACHE_HIT_RATIO_SQL = `
        SELECT
          (1 - (
            (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_reads') /
            NULLIF((SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_read_requests'), 0)
          )) * 100 as hit_ratio;
      `;

const HEALTH_ACTIVE_SESSIONS_SQL = `
        SELECT
          ID as pid,
          USER as user,
          DB as \`database\`,
          COMMAND as state,
          LEFT(COALESCE(INFO, ''), 100) as query,
          CONCAT(TIME, 's') as duration
        FROM information_schema.PROCESSLIST
        WHERE DB = ?
        ORDER BY TIME DESC
        LIMIT 10;
      `;

const MAINTENANCE_TABLES_SQL = `
      SELECT TABLE_NAME
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      AND TABLE_TYPE = 'BASE TABLE'
      LIMIT 50;
    `;

const OVERVIEW_DATABASE_SIZE_SQL = `
        SELECT SUM(DATA_LENGTH + INDEX_LENGTH) as size_bytes
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?;
      `;

const OVERVIEW_OBJECT_COUNTS_SQL = `
        SELECT
          COUNT(DISTINCT TABLE_NAME) as table_count,
          COUNT(DISTINCT INDEX_NAME) as index_count
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ?;
      `;

const OVERVIEW_TABLE_COUNT_SQL = `
        SELECT COUNT(*) as cnt FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE';
      `;

const BUFFER_POOL_PAGES_SQL = `
        SELECT
          (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_pages_data') as data_pages,
          (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_pages_total') as total_pages;
      `;

const QUERIES_PER_SECOND_SQL = `
        SELECT
          (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Queries') as queries,
          (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Uptime') as uptime;
      `;

/**
 * The ONE read of `performance_schema.events_statements_summary_by_digest`, shared by
 * `getSlowQueries()` (the Queries panel) and `getHealth()`'s slow-query line, with only
 * the LIMIT interpolated at each call site.
 *
 * It is shared because the two used to be separate statements and the health one was
 * wrong (#512): it asked for `LEFT(sql_text, 100)`, and this table has no `sql_text`
 * column. `SQL_TEXT` belongs to `events_statements_current`/`_history`; the digest table
 * carries the normalised `DIGEST_TEXT` (MySQL 9.4 manual, "Statement Summary Tables",
 * and the server's own `information_schema.columns` on every build below). So that
 * statement answered
 *
 *   errno=1054 code=ER_BAD_FIELD_ERROR sqlState=42S22
 *   Unknown column 'sql_text' in 'field list'
 *
 * and never once returned a row. Measured 2026-08-27 on MySQL 26.7.0, Percona Server
 * 8.4.11-11, MySQL 26.7.0 started `--performance-schema=OFF` and MariaDB 12.3.2 - all
 * four, whatever `@@performance_schema` said - while this statement answered 5 real rows
 * on the two with the schema on, over the same connection.
 *
 * Two statements for one fact is what drifted, and the copy the health panel used was
 * the one no test ever put in front of a server: the mysql2 mock invented a `query`
 * column for any statement over this table, so the broken read looked like a working one
 * for as long as it was only mocked.
 */
const SLOW_QUERIES_BODY_SQL = `
        SELECT
          DIGEST as query_id,
          LEFT(DIGEST_TEXT, 500) as query,
          COUNT_STAR as calls,
          SUM_TIMER_WAIT / 1000000000 as total_time_ms,
          AVG_TIMER_WAIT / 1000000000 as avg_time_ms,
          MIN_TIMER_WAIT / 1000000000 as min_time_ms,
          MAX_TIMER_WAIT / 1000000000 as max_time_ms,
          SUM_ROWS_EXAMINED as rows_examined
        FROM performance_schema.events_statements_summary_by_digest
        WHERE SCHEMA_NAME = ?
        ORDER BY SUM_TIMER_WAIT DESC`;

/**
 * The five heaviest digests - the LIMIT the health statement this replaced already used,
 * kept so the reading's size does not change with the repair.
 *
 * A CAP, NOT A COUNT, and nothing downstream can tell the difference, which is why it is
 * written here. `SLOW_QUERIES_BODY_SQL` has no slowness predicate at all: its only WHERE
 * term is the connected schema and "slow" is the ORDERING (`SUM_TIMER_WAIT DESC`), so the
 * top five digests for a schema come back whether they took 15 ms or 15 hours. So on any
 * server with five or more digests for this schema, the LENGTH of this list is 5 -
 * permanently, and about statements no threshold has called slow. The agent's curated
 * health reading used to forward that length to the model as `slowQueryCount`; it no
 * longer projects any length at all, because a figure whose value is a cap has no
 * referent (`src/lib/agent/tools.ts`, and #513). The cap is still
 * written here: nothing downstream can tell a cap from a count, so the only place the
 * distinction can be recorded is where the limit is applied.
 *
 * Measured 2026-08-27 on MySQL 26.7.0: the digest table held 59 rows for one connected
 * schema, and the five this statement returns for it were ALL Studio's own introspection
 * statements, with the slow-query read itself first at `avg 79.11ms, calls 3` and the rest
 * between 1.15 ms and 7.78 ms. Nothing in that list is slow and none of it is the user's
 * workload; what the reading honestly reports is "the five heaviest digests recorded for
 * this schema". Raising the limit would move the saturation point without turning the
 * number into a count - only a slowness threshold, or a differently named projection,
 * would - and the projection is in a file this one does not own.
 */
const HEALTH_SLOW_QUERY_LIMIT = 5;

/**
 * One digest row in the Queries panel's shape. Module-level rather than inline in
 * `getSlowQueries()` so `getHealth()` projects the SAME row the panel does: the health
 * line's job is to agree with the panel beside it, and it can only be structurally
 * unable to disagree while there is one statement and one mapper.
 */
function toSlowQueryStats(r: RowDataPacket): SlowQueryStats {
  return {
    queryId: r.query_id || undefined,
    query: r.query || "",
    calls: parseInt(r.calls || "0"),
    totalTime: parseFloat(r.total_time_ms || "0"),
    avgTime: parseFloat(r.avg_time_ms || "0"),
    minTime: parseFloat(r.min_time_ms || "0"),
    maxTime: parseFloat(r.max_time_ms || "0"),
    rows: parseInt(r.rows_examined || "0"),
  };
}

/**
 * The health summary's narrower `SlowQuery` shape, from the panel's row.
 *
 * NOTHING RENDERS THESE TWO FIELDS, and the format is chosen on that basis rather than on
 * an appearance nobody can check. No component reads `HealthInfo.slowQueries` (the
 * monitoring Queries and Overview tabs read `MonitoringData.slowQueries`, a different
 * reading with its own `SlowQueryStats` shape), and the one caller of
 * `POST /api/db/health` - the 60s connection pulse in `src/hooks/use-connection-manager.ts` -
 * reads `res.ok` and discards the body. The agent's curated health reading
 * (`src/lib/agent/tools.ts`) was the last live consumer and read only the list's LENGTH -
 * never `query`, never `avgTime` - and it no longer reads the list at all (#513). So this
 * shape now has no consumer in the app beyond the serialised route body.
 *
 * So `toFixed(2)` plus `"ms"` is here for one reason: it is the string the statement this
 * replaced produced with `CONCAT(ROUND(avg_timer_wait / 1000000000, 2), 'ms')`, and
 * keeping the type's contents identical in form means no consumer added later inherits a
 * silent change of units from this repair. What DID change is the query text: the old
 * statement asked for `LEFT(sql_text, 100)` (and answered ER_BAD_FIELD_ERROR every time,
 * so no consumer ever saw 100 characters of anything), the shared one asks for
 * `LEFT(DIGEST_TEXT, 500)` - the panel's own width, five times wider, and the reason the
 * two readings can no longer disagree about a statement's text.
 */
function toHealthSlowQuery(stats: SlowQueryStats): SlowQuery {
  return { query: stats.query, calls: stats.calls, avgTime: `${stats.avgTime.toFixed(2)}ms` };
}

/**
 * Vendor names that a MySQL-protocol server puts into its own `VERSION()` string.
 *
 * `mysql2` serves MySQL and its wire-compatible relatives alike, and `VERSION()`
 * is the only thing that says which one answered. MySQL returns a bare number
 * ("8.0.35"), so the overview has to supply the vendor; these four supply it
 * themselves, and prefixing "MySQL" onto their answer asserted the wrong vendor
 * outright - a MariaDB 12.3 server read as "MySQL 12.3.2-MariaDB-ubu2404".
 *
 * The list is exactly the self-identifying strings `WIRE_COMPATIBLE_ENGINES`
 * records from a live probe: MariaDB `12.3.2-MariaDB-ubu2404`, TiDB
 * `8.0.11-TiDB-v8.5.1`, Vitess `8.0.43-Vitess`, OceanBase
 * `5.7.25-OceanBase_CE-v4.4.2.1`. StarRocks and SingleStore are deliberately
 * absent: both answer `VERSION()` with a plain MySQL number and nothing to key
 * on, which the compatibility table already records as their behaviour.
 */
const SELF_IDENTIFYING_VERSION = /mariadb|tidb|vitess|oceanbase/i;

/**
 * How the overview names the server: the string as the server gave it when that
 * already names a vendor, `MySQL <version>` when it does not.
 */
function labelServerVersion(version: string): string {
  return SELF_IDENTIFYING_VERSION.test(version) ? version : `MySQL ${version}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// The LIMIT clause is interpolated at the call site in getActiveSessions().
const ACTIVE_SESSIONS_BODY_SQL = `
        SELECT
          ID as pid,
          USER as user,
          DB as database_name,
          HOST as client_addr,
          COMMAND as state,
          LEFT(COALESCE(INFO, ''), 500) as query,
          TIME as duration_seconds
        FROM information_schema.PROCESSLIST
        WHERE DB = ? OR DB IS NULL
        ORDER BY TIME DESC`;

const TABLE_STATS_SQL = `
        SELECT
          TABLE_SCHEMA as schema_name,
          TABLE_NAME as table_name,
          TABLE_ROWS as row_count,
          DATA_LENGTH as table_size_bytes,
          INDEX_LENGTH as index_size_bytes,
          DATA_LENGTH + INDEX_LENGTH as total_size_bytes,
          DATA_FREE as free_space_bytes
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY DATA_LENGTH + INDEX_LENGTH DESC
        LIMIT 100;
      `;

const INDEX_STATS_SQL = `
        SELECT
          TABLE_SCHEMA as schema_name,
          TABLE_NAME as table_name,
          INDEX_NAME as index_name,
          INDEX_TYPE as index_type,
          GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) as columns,
          NOT NON_UNIQUE as is_unique,
          INDEX_NAME = 'PRIMARY' as is_primary,
          MAX(CARDINALITY) as cardinality
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ?
        GROUP BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, INDEX_TYPE, NON_UNIQUE
        ORDER BY TABLE_NAME, INDEX_NAME
        LIMIT 200;
      `;

// Sizes come from the InnoDB persistent-statistics table, not from the INNODB_* views in
// information_schema. Two measurements on 2026-08-23 forced the move: `INNODB_TABLESPACES` has no
// `INDEX_SIZE` column on MySQL 26.7.0 or on the MySQL 8.0 inside Vitess 24.0.2 (both answer
// ER_BAD_FIELD_ERROR), and the old statement's `WHERE t.NAME LIKE 'schema/%'` assumed InnoDB names
// the table after the database you connected to, which Vitess does not — it stores the physical
// shard database, `vt_probe_0/orders`. `stat_value` is the index size in pages, per index rather
// than per tablespace, and the row is keyed on database/table/index columns that
// information_schema.STATISTICS reports the same way, so nothing here parses or guesses a prefix.
const INDEX_SIZES_SQL = `
          SELECT
            database_name,
            table_name,
            index_name,
            stat_value * @@innodb_page_size as size_bytes
          FROM mysql.innodb_index_stats
          WHERE stat_name = 'size' AND database_name = ?;
        `;

const STORAGE_STATS_SQL = `
        SELECT
          TABLE_SCHEMA as name,
          SUM(DATA_LENGTH + INDEX_LENGTH) as size_bytes
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        GROUP BY TABLE_SCHEMA;
      `;

// ============================================================================
// MySQL Provider
// ============================================================================

export class MySQLProvider extends SQLBaseProvider {
  private pool: Pool | null = null;

  // Transaction support: dedicated connection held outside pool
  private txConn: PoolConnection | null = null;
  private txActive = false;
  private txTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly TX_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    this.validate();
  }

  // ============================================================================
  // Provider Metadata
  // ============================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      defaultPort: 3306,
      supportsExplain: true,
      explainFormat: "mysql-json",
      supportsConnectionString: true,
      supportsInlineRowEdit: true,
      // The driver's own connection.beginTransaction() over one held connection.
      supportsTransactions: true,
      maintenanceOperations: ["analyze", "optimize", "check", "kill"],
      // MySQL has no VACUUM, and every statement it does have names tables:
      // `ANALYZE/OPTIMIZE/CHECK TABLE <t>` with a target, the same verb over every
      // table in the database without one (`getAllTablesForMaintenance`). `kill`
      // takes a connection id from the Sessions panel.
      maintenanceOperationSpecs: {
        analyze: { label: "Analyze Table", perEntity: true, global: true },
        optimize: { label: "Optimize Table", perEntity: true, global: true },
        check: { label: "Check Table", perEntity: true, global: true },
        kill: { label: "Kill Connection", perEntity: false, global: false },
      },
    };
  }

  /**
   * The vacuum slot and the slow-query empty state; every other label is the SQL
   * default and right.
   *
   * MySQL rendered the base default *"Vacuum Table"* in the explorer's per-row menu
   * and the base *"Run Vacuum" / "Reclaim Space"* copy on the Operations tab, for an
   * engine whose operations are `analyze`/`optimize`/`check`/`kill` (#U9). The words
   * below name what MySQL actually runs, and `vacuumActionOperation` says which
   * operation the surfaces should send for them.
   *
   * `getSlowQueries()` reads `performance_schema.events_statements_summary_by_digest`,
   * and the panel used to name PostgreSQL's extension in its empty state (#U12) - a
   * statement store MySQL does not have under any name.
   *
   * The sentence describes the SOURCE and what an empty list means about it, and stops
   * there. It cannot do more: `QueriesTab` renders this one fixed string for every empty
   * list whatever produced it, so any instruction in it is addressed to causes it cannot
   * tell apart. It used to end "enable the Performance Schema to see them", which named
   * the one cause that never reaches the failure path at all (off-ness answers 0 rows,
   * measured; see `getSlowQueries()`) and was unactionable advice for the ones that do -
   * a denied grant, or a tenant with no `performance_schema` database. Those now reject
   * instead of emptying, and the panel shows the server's own reason through
   * `PanelUnavailable`, which is a different string on a different branch.
   */
  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      vacuumAction: "Optimize Table",
      vacuumActionOperation: "optimize",
      vacuumGlobalLabel: "Run Optimize",
      vacuumGlobalTitle: "Optimize Tables",
      vacuumGlobalDesc:
        "Runs OPTIMIZE TABLE over every table in the database, rebuilding its storage and reclaiming the space deleted rows left behind.",
      slowQueriesEmptyState:
        "Query stats come from performance_schema.events_statements_summary_by_digest for this database. An empty list means it recorded nothing - the Performance Schema is off, or nothing has run against this database yet.",
    };
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.connectionString) {
      if (!this.config.host) {
        throw new DatabaseConfigError("Host is required for MySQL", "mysql");
      }
      if (!this.config.database) {
        throw new DatabaseConfigError("Database name is required for MySQL", "mysql");
      }
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  public async connect(): Promise<void> {
    if (this.pool) {
      return;
    }

    try {
      // No pool `error` listener here, unlike the PostgreSQL and SQL Server providers
      // (#298): mysql2's pool has no pool-level `error` event to listen for. Audited in
      // the installed package — `mysql2/lib/base/pool.js` emits only `acquire`,
      // `connection`, `enqueue` and `release`, the promise wrapper forwards exactly those
      // four (`lib/promise/pool.js`), and `typings/mysql/lib/Pool.d.ts` types no `error`
      // overload. A connection that fails reports through the call that holds it.
      this.pool = mysql.createPool(this.buildPoolConfig());

      const conn = await this.pool.getConnection();
      conn.release();

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw new ConnectionError(
        `Failed to connect to MySQL: ${error instanceof Error ? error.message : error}`,
        "mysql",
        this.config.host,
        this.config.port,
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.setConnected(false);
    }
  }

  private buildPoolConfig(): mysql.PoolOptions {
    const baseConfig: mysql.PoolOptions = {
      connectionLimit: this.poolConfig.max,
      waitForConnections: true,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    };

    if (this.config.connectionString) {
      return {
        ...baseConfig,
        uri: this.config.connectionString,
      };
    }

    return {
      ...baseConfig,
      host: this.config.host,
      port: this.config.port ?? 3306,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      ssl: this.buildSSLConfig(),
      timezone: this.options.timezone ?? "Z",
    };
  }

  private buildSSLConfig(): mysql.SslOptions | undefined {
    const connSSL = this.config.ssl;

    if (connSSL) {
      if (connSSL.mode === "disable") return undefined;

      const ssl: mysql.SslOptions = {
        // Every mode except `require` verifies (D26): `verify-system` checks the chain against
        // the trust store the runtime already has - no `ca` is set below, so Node's bundled
        // roots decide - while `verify-ca`/`verify-full` check it against the PEM pasted into
        // the form. `require` is the one mode that encrypts without checking anything.
        rejectUnauthorized: connSSL.mode !== "require",
      };

      if (connSSL.caCert) ssl.ca = connSSL.caCert;
      if (connSSL.clientCert) ssl.cert = connSSL.clientCert;
      if (connSSL.clientKey) ssl.key = connSSL.clientKey;

      return ssl;
    }

    if (this.shouldEnableSSL()) {
      return { rejectUnauthorized: false };
    }

    return undefined;
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  /**
   * Build the query envelope from what mysql2 handed back.
   *
   * `execute`'s first return value is an ARRAY of rows only for a statement that
   * produced a result set. For everything else - DDL, INSERT, UPDATE, DELETE - it
   * is a `ResultSetHeader` object and `fields` is `undefined`. Measured verbatim
   * against mysql 26.7.0 on 2026-08-23, `INSERT INTO r5_hdr (note) VALUES
   * ('a'),('b')` answers
   * `{fieldCount:0,affectedRows:2,insertId:1,info:"Records: 2  Duplicates: 0  Warnings: 0",serverStatus:2,warningStatus:0,changedRows:0}`.
   *
   * Calling `.map` on that object threw `result.rows.map is not a function` AFTER
   * the server had already applied the statement, so every DDL and DML statement
   * run from the editor reported a failure for work that had landed - the answer
   * that makes a user retry and double-apply it.
   *
   * The empty-result answer follows what the other SQL providers here already do:
   * no rows, no fields, and the affected-row count in `rowCount` (mssql reports
   * `rowsAffected[0]`, sqlite `changes`, postgres `pg`'s own `rowCount`).
   * `insertId`, `changedRows` and `warningStatus` are deliberately dropped:
   * `QueryResult` models none of them, and `rowCount` is the field the results
   * footer renders. `affectedRows` is the matched count, which is why a no-op
   * UPDATE still reports 1 - matching mssql, whose `rowsAffected` counts the same
   * way.
   */
  private buildQueryResult(rows: unknown, fields: FieldPacket[] | undefined, executionTime: number): QueryResult {
    if (!Array.isArray(rows)) {
      const header = rows as { affectedRows?: number };
      return {
        rows: [],
        fields: [],
        rowCount: header.affectedRows ?? 0,
        executionTime,
      };
    }

    return {
      // The driver's rows are handed on UNCHANGED, binary values included.
      // A `sanitizeRow` used to walk every row and turn a `Buffer` into the string
      // `0x<hex>` (and an empty one into `""`), because the JSON a Buffer serializes
      // to - `{"type":"Buffer","data":[…]}` - was unreadable. `src/lib/export/binary.ts`
      // now READS that exact shape (#469), which is how Postgres's `bytea` reaches the
      // grid, the row sheet, the CSV and the SQL export, so the string was the only
      // thing standing between a MySQL BLOB and the same treatment: the grid showed
      // `0x0102ab` where Postgres showed `\x0102ab`, and the export wrote the eight
      // characters `'0x0102ab'` into a BLOB column rather than the three bytes.
      // Measured against MySQL 26.7.0 on 2026-08-24; see docs/providers/mysql.md §3.3.
      rows: rows as Record<string, unknown>[],
      fields: fields?.map((f: FieldPacket) => f.name) ?? [],
      ...mysqlColumnTypes(fields),
      rowCount: rows.length,
      executionTime,
    };
  }

  // Track running query thread IDs for cancellation
  private runningQueryThreadIds = new Map<string, number>();

  public async query(sql: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        const conn = await this.pool!.getConnection();
        try {
          // Track thread ID for cancellation support
          if (queryId) {
            this.runningQueryThreadIds.set(queryId, conn.threadId);
          }
          const [rows, fields] = await runStatement(conn, sql, params);
          return { rows, fields };
        } catch (error) {
          throw mapDatabaseError(error, "mysql", sql);
        } finally {
          if (queryId) this.runningQueryThreadIds.delete(queryId);
          conn.release();
        }
      });

      return this.buildQueryResult(result.rows, result.fields, executionTime);
    });
  }

  public async cancelQuery(queryId: string): Promise<boolean> {
    const threadId = this.runningQueryThreadIds.get(queryId);
    if (!threadId) return false;

    try {
      await runStatement(this.pool!, `KILL QUERY ${threadId}`);
      return true;
    } catch (error) {
      console.error("[MySQL] Failed to cancel query:", error);
      return false;
    }
  }

  // ============================================================================
  // Transaction Support
  // ============================================================================

  private clearTxTimeout(): void {
    if (this.txTimeout) {
      clearTimeout(this.txTimeout);
      this.txTimeout = null;
    }
  }

  /**
   * Force-expire an active transaction (auto-rollback).
   * Called by the timeout timer, but also available for testing.
   */
  public async expireTransaction(): Promise<void> {
    if (this.txActive && this.txConn) {
      console.warn("[MySQL] Transaction timed out, auto-rolling back");
      try {
        await this.txConn.rollback();
      } catch {
        /* ignore */
      } finally {
        this.txConn.release();
        this.txConn = null;
        this.txActive = false;
        this.clearTxTimeout();
      }
    }
  }

  public async beginTransaction(): Promise<void> {
    this.ensureConnected();
    if (this.txActive) throw new QueryError("Transaction already active", "mysql");
    this.txConn = await this.pool!.getConnection();
    await this.txConn.beginTransaction();
    this.txActive = true;

    // Auto-rollback after timeout to prevent leaked locks
    this.txTimeout = setTimeout(() => {
      void this.expireTransaction();
    }, MySQLProvider.TX_TIMEOUT_MS);
  }

  public async commitTransaction(): Promise<void> {
    if (!this.txConn || !this.txActive) throw new QueryError("No active transaction", "mysql");
    this.clearTxTimeout();
    try {
      await this.txConn.commit();
    } finally {
      this.txConn.release();
      this.txConn = null;
      this.txActive = false;
    }
  }

  public async rollbackTransaction(): Promise<void> {
    if (!this.txConn || !this.txActive) throw new QueryError("No active transaction", "mysql");
    this.clearTxTimeout();
    try {
      await this.txConn.rollback();
    } finally {
      this.txConn.release();
      this.txConn = null;
      this.txActive = false;
    }
  }

  public isInTransaction(): boolean {
    return this.txActive;
  }

  public async queryInTransaction(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.txConn || !this.txActive) throw new QueryError("No active transaction", "mysql");

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          const [rows, fields] = await runStatement(this.txConn!, sql, params);
          return { rows, fields };
        } catch (error) {
          throw mapDatabaseError(error, "mysql", sql);
        }
      });

      return this.buildQueryResult(result.rows, result.fields, executionTime);
    });
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    const conn = await this.pool!.getConnection();
    try {
      const [tablesRows] = await runStatement(conn, SCHEMA_TABLES_SQL, [this.config.database]);

      const schemas: TableSchema[] = [];

      for (const row of tablesRows) {
        const tableName = row.table_name;
        const rowCount = parseInt(row.row_count || "0");
        const sizeBytes = parseInt(row.total_size || "0");

        const [columnsRows] = await runStatement(conn, SCHEMA_COLUMNS_SQL, [this.config.database, tableName]);

        const [fkRows] = await runStatement(conn, SCHEMA_FOREIGN_KEYS_SQL, [this.config.database, tableName]);

        const [indexRows] = await runStatement(conn, SCHEMA_INDEXES_SQL, [this.config.database, tableName]);

        schemas.push({
          name: tableName,
          rowCount,
          size: formatBytes(sizeBytes),
          columns: columnsRows.map((col) => ({
            name: col.column_name,
            type: col.data_type,
            nullable: col.is_nullable === "YES",
            isPrimary: col.column_key === "PRI",
            defaultValue: col.column_default ?? undefined,
          })),
          indexes: indexRows.map((idx) => ({
            name: idx.index_name,
            columns: idx.columns?.split(",") ?? [],
            unique: Boolean(idx.is_unique),
          })),
          foreignKeys: fkRows.map((fk) => ({
            columnName: fk.column_name,
            referencedTable: fk.referenced_table,
            referencedColumn: fk.referenced_column,
          })),
        });
      }

      return schemas;
    } finally {
      conn.release();
    }
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    const conn = await this.pool!.getConnection();
    try {
      const [connRows] = await runStatement(conn, "SHOW STATUS LIKE 'Threads_connected'");
      const activeConnections = parseInt(connRows[0]?.Value || "0");

      const [sizeRows] = await runStatement(conn, DATABASE_SIZE_MB_SQL, [this.config.database]);
      const databaseSize = `${sizeRows[0]?.size_mb || 0} MB`;

      // A tenant can be missing the performance_schema DATABASE rather than merely
      // having the schema off, and then this query does not answer NULLs, it throws:
      // measured 2026-08-20 on OceanBase Community Edition 4.4.2.1 through this
      // provider, and reproduced on mysql:latest as
      // `ERROR 1049 (42000): Unknown database 'performance_schema_absent'`. Uncaught,
      // it took the whole health read down, so the panel showed nothing at all where
      // one unavailable metric was the honest answer.
      let cacheHitRatio = CACHE_HIT_RATIO_UNAVAILABLE;
      try {
        const [hitRows] = await runStatement(conn, BUFFER_CACHE_HIT_RATIO_SQL);
        cacheHitRatio = formatCacheHitRatio(measuredNumber(hitRows[0]?.hit_ratio));
      } catch {
        // Nothing to read, so nothing is reported.
      }

      // The digest rows, or none - never a sentence dressed as a row (#512).
      //
      // This used to report `[{ query: "Performance schema not available", calls: 0,
      // avgTime: "N/A" }]` whenever its statement threw, and the statement threw on every
      // server: it named a column the digest table does not have (see
      // SLOW_QUERIES_BODY_SQL). So the line stated an engine capability as absent on
      // MySQL 26.7.0 and Percona Server 8.4.11-11 where `@@performance_schema` was 1 and
      // `getSlowQueries()` answered 5 rows on the same connection - measured 2026-08-27,
      // both arms.
      //
      // That row was a fabricated measurement rather than a missing number, which is the
      // class the absence rule (#477) exists to prevent: `calls: 0` is a figure nobody
      // took, and it was COUNTED - the agent's curated health reading then forwarded
      // `health.slowQueries.length` as `slowQueryCount` (src/lib/agent/tools.ts), so the
      // invented row told the model "1 slow query" about every MySQL-family server. That
      // projection carries no length any more (#513), so a row invented here would now be
      // silent rather than counted - a reason to keep it out, not a reason it could return.
      //
      // Why an empty list rather than a marker that says "unavailable": the capability
      // being OFF does not raise here at all. Measured on the same pass, MySQL 26.7.0
      // started `--performance-schema=OFF` and MariaDB 12.3.2 (which ships it off) both
      // keep the digest table selectable and answer 0 rows. A marker keyed on the throw
      // would therefore be emitted for something other than off-ness - the same fabrication
      // as the row it replaces, one level up.
      // What remains in the catch is a genuine refusal: no `performance_schema` DATABASE
      // at all (ER_1049 on the OceanBase tenant above), or a grant denied on it.
      //
      // ON THIS PATH THE REASON IS DROPPED, and saying so is the point of this
      // paragraph. `HealthInfo.slowQueries` is a `SlowQuery[]`; it has no error field
      // and no sibling that carries one, so a refusal cannot be represented here at all,
      // and a row saying "Performance schema not available" is what representing it
      // anyway looked like. Empty is the least-wrong shape, not a shape that carries the
      // reason. Nothing renders this list either: no component reads
      // `HealthInfo.slowQueries` (the monitoring Queries and Overview tabs read
      // `MonitoringData.slowQueries`, a different reading), and the one caller of
      // `POST /api/db/health` - the 60s connection pulse in
      // `src/hooks/use-connection-manager.ts` - looks at `res.ok` and discards the body.
      //
      // The operator is not left without the reason, because the SAME refusal reaches
      // them on the path that does have a channel: `getSlowQueries()` below lets it
      // reject, `getMonitoringData()` (src/lib/db/base-provider.ts) records it as
      // `errors.slowQueries`, and `QueriesTab` renders that through `PanelUnavailable`
      // with the server's own sentence. `ProviderLabels.slowQueriesEmptyState` is NOT
      // that channel - it is the same sentence for every empty list regardless of cause,
      // which is why it must not name one cause as the fix.
      let slowQueries: SlowQuery[] = [];
      try {
        const [slowRows] = await runStatement(conn, `${SLOW_QUERIES_BODY_SQL} LIMIT ${HEALTH_SLOW_QUERY_LIMIT};`, [
          this.config.database,
        ]);
        slowQueries = slowRows.map((r) => toHealthSlowQuery(toSlowQueryStats(r)));
      } catch {
        // Nothing was read, so nothing is reported.
      }

      const [sessionRows] = await runStatement(conn, HEALTH_ACTIVE_SESSIONS_SQL, [this.config.database]);

      const activeSessions: ActiveSession[] = sessionRows.map((r) => ({
        pid: r.pid,
        user: r.user || "unknown",
        database: r.database || "",
        state: r.state || "unknown",
        query: r.query || "",
        duration: r.duration || "N/A",
      }));

      return {
        activeConnections,
        databaseSize,
        cacheHitRatio,
        slowQueries,
        activeSessions,
      };
    } finally {
      conn.release();
    }
  }

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  public async runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult> {
    this.ensureConnected();

    const { result, executionTime } = await this.measureExecution(async () => {
      const conn = await this.pool!.getConnection();
      try {
        let sql = "";

        switch (type) {
          // The three table verbs share one shape: `<VERB> TABLE <list>`, where the
          // list is the one table the caller named or every table in the database, and
          // the answer is a RESULT SET carrying the verdict (`readMaintenanceReport`).
          case "analyze":
          case "optimize":
          case "check": {
            const tables = target ? this.escapeIdentifier(target) : await this.getAllTablesForMaintenance(conn);
            // An empty database joined to an empty list, and `OPTIMIZE TABLE ` alone is
            // a syntax error - measured through the provider against a database with no
            // tables on 2026-08-25: "You have an error in your SQL syntax ... near ''".
            // Nothing to do is not a failure, so it is reported as what it is rather
            // than as the engine's complaint about a statement we should not have sent.
            if (!tables) {
              return {
                success: true,
                message: `${type.toUpperCase()}: no tables in ${this.config.database ?? "this database"} to run it on.`,
              };
            }
            const [rows] = await runStatement<MaintenanceReportRow[]>(conn, `${type.toUpperCase()} TABLE ${tables}`);
            return readMaintenanceReport(type, rows);
          }
          case "kill":
            if (!target) {
              throw new QueryError("Target connection ID is required for kill operation", "mysql");
            }
            const connId = parseInt(target, 10);
            if (isNaN(connId)) {
              throw new QueryError("Invalid connection ID for kill operation", "mysql");
            }
            sql = `KILL ${connId}`;
            break;
        }

        // Unsupported types fall through the switch with sql left empty. A
        // `default:` label is deliberately avoided here: bun's coverage emits
        // a 0-hit line record for `default:` that no runtime execution ever
        // credits, which permanently poisons the merged lcov report.
        if (!sql) {
          throw new QueryError(`Unsupported maintenance type for MySQL: ${type}`, "mysql");
        }

        await runStatement(conn, sql);
        return { success: true, message: `${type.toUpperCase()} completed successfully` };
      } finally {
        conn.release();
      }
    });

    return {
      success: result.success,
      executionTime,
      message: result.message,
    };
  }

  private async getAllTablesForMaintenance(conn: PoolConnection): Promise<string> {
    const [rows] = await runStatement(conn, MAINTENANCE_TABLES_SQL, [this.config.database]);

    return rows.map((r) => this.escapeIdentifier(r.TABLE_NAME)).join(", ");
  }

  // ============================================================================
  // Monitoring Operations
  // ============================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();

    const conn = await this.pool!.getConnection();
    try {
      // Get version
      const [versionRows] = await runStatement(conn, "SELECT VERSION() as version");
      const version = versionRows[0]?.version || "Unknown";

      // Get uptime
      const [uptimeRows] = await runStatement(conn, "SHOW STATUS LIKE 'Uptime'");
      const uptimeSeconds = parseInt(uptimeRows[0]?.Value || "0");
      const uptime = this.formatUptimeString(uptimeSeconds);

      // Get active connections
      const [connRows] = await runStatement(conn, "SHOW STATUS LIKE 'Threads_connected'");
      const activeConnections = parseInt(connRows[0]?.Value || "0");

      // Get max connections
      const [maxConnRows] = await runStatement(conn, "SHOW VARIABLES LIKE 'max_connections'");
      const maxConnections = parseInt(maxConnRows[0]?.Value || "151");

      // Get database size
      const [sizeRows] = await runStatement(conn, OVERVIEW_DATABASE_SIZE_SQL, [this.config.database]);
      const databaseSizeBytes = parseInt(sizeRows[0]?.size_bytes || "0");

      // Get table and index count
      const [countRows] = await runStatement(conn, OVERVIEW_OBJECT_COUNTS_SQL, [this.config.database]);

      const [tableCountRows] = await runStatement(conn, OVERVIEW_TABLE_COUNT_SQL, [this.config.database]);

      return {
        version: labelServerVersion(version),
        uptime,
        startTime: new Date(Date.now() - uptimeSeconds * 1000),
        activeConnections,
        maxConnections,
        databaseSize: formatBytes(databaseSizeBytes),
        databaseSizeBytes,
        tableCount: parseInt(tableCountRows[0]?.cnt || "0"),
        indexCount: parseInt(countRows[0]?.index_count || "0"),
      };
    } finally {
      conn.release();
    }
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();

    const conn = await this.pool!.getConnection();
    try {
      // Every reading below is optional on purpose. A server with performance_schema
      // OFF - MariaDB's default - answers each of these with NULL rather than
      // failing, and a metric nobody measured must stay absent instead of arriving
      // as a number the panels would rate (#424, and the rule #448/#452 settled).

      // Calculate cache hit ratio from InnoDB buffer pool
      const [hitRows] = await runStatement(conn, BUFFER_CACHE_HIT_RATIO_SQL);
      const hitRatio = measuredNumber(hitRows[0]?.hit_ratio);

      // Get buffer pool usage
      const [poolRows] = await runStatement(conn, BUFFER_POOL_PAGES_SQL);
      const dataPages = measuredNumber(poolRows[0]?.data_pages);
      const totalPages = measuredNumber(poolRows[0]?.total_pages);

      // Get queries per second
      const [qpsRows] = await runStatement(conn, QUERIES_PER_SECOND_SQL);
      const queries = measuredNumber(qpsRows[0]?.queries);
      const uptime = measuredNumber(qpsRows[0]?.uptime);

      // Get deadlocks. SHOW STATUS answers this with or without performance_schema,
      // so a 0 here is a measurement and is reported as one.
      const [deadlockRows] = await runStatement(conn, "SHOW STATUS LIKE 'Innodb_deadlocks'");
      const deadlocks = measuredNumber(deadlockRows[0]?.Value);

      return {
        ...(hitRatio === undefined ? {} : { cacheHitRatio: Math.min(100, Math.max(0, hitRatio)) }),
        ...(queries === undefined || !uptime ? {} : { queriesPerSecond: round2(queries / uptime) }),
        ...(dataPages === undefined || !totalPages ? {} : { bufferPoolUsage: round2((dataPages / totalPages) * 100) }),
        ...(deadlocks === undefined ? {} : { deadlocks }),
      };
    } catch {
      // performance_schema is absent entirely rather than merely off: nothing was
      // measured, so nothing is reported.
      return {};
    } finally {
      conn.release();
    }
  }

  /**
   * The digests, or the server's refusal - this read does NOT swallow.
   *
   * It used to `return []` on any throw, with a comment saying the reason travelled
   * through `ProviderLabels.slowQueriesEmptyState` instead. It did not: that label is
   * one fixed sentence rendered for every empty list whatever produced it, and the
   * sentence this provider declares names the Performance Schema - the one cause that
   * never reaches here.
   *
   * What never reaches here is off-ness. Measured 2026-08-27, a server with
   * `@@performance_schema` = 0 keeps the digest table selectable and answers 0 rows
   * (MySQL 26.7.0 started `--performance-schema=OFF`, MariaDB 12.3.2 which ships it off),
   * so an unreadable source is the ONLY thing that throws: no `performance_schema`
   * DATABASE at all (ER_1049 on an OceanBase tenant) or the grant denied on it -
   *
   *   errno=1142 code=ER_TABLEACCESS_DENIED_ERROR sqlState=42000
   *   SELECT command denied to user 'nops'@'...' for table
   *   'events_statements_summary_by_digest'
   *
   * measured on MySQL 26.7.0 with a user holding only `SELECT ON d32.*` plus `PROCESS`.
   * Letting that reject is what puts the reason in front of the operator: it becomes
   * `errors.slowQueries` in `getMonitoringData()` (src/lib/db/base-provider.ts), which
   * reads every panel with `Promise.allSettled` and records a rejected one by name, and
   * `QueriesTab` renders it through `PanelUnavailable` carrying the server's own
   * sentence. One rejected panel costs nothing else: that method throws only when all
   * four core reads reject. This is also what the PostgreSQL provider already does - it
   * falls back to `pg_stat_activity` and lets a failure of THAT propagate.
   */
  public async getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 10;

    const conn = await this.pool!.getConnection();
    try {
      const [rows] = await runStatement(conn, `${SLOW_QUERIES_BODY_SQL} LIMIT ${Number(limit)};`, [
        this.config.database,
      ]);

      return rows.map(toSlowQueryStats);
    } finally {
      conn.release();
    }
  }

  public async getActiveSessions(options?: { limit?: number }): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 50;

    const conn = await this.pool!.getConnection();
    try {
      const [rows] = await runStatement(conn, `${ACTIVE_SESSIONS_BODY_SQL} LIMIT ${Number(limit)};`, [
        this.config.database,
      ]);

      return rows.map((r) => {
        const durationSeconds = parseInt(r.duration_seconds || "0");
        return {
          pid: r.pid,
          user: r.user || "unknown",
          database: r.database_name || "",
          clientAddr: r.client_addr?.split(":")[0] || undefined,
          state: r.state || "unknown",
          query: r.query || "",
          duration: this.formatDurationString(durationSeconds * 1000),
          durationMs: durationSeconds * 1000,
        };
      });
    } finally {
      conn.release();
    }
  }

  public async getTableStats(options?: { schema?: string }): Promise<TableStats[]> {
    this.ensureConnected();
    const schema = options?.schema ?? this.config.database;

    const conn = await this.pool!.getConnection();
    try {
      const [rows] = await runStatement(conn, TABLE_STATS_SQL, [schema]);

      return rows.map((r) => {
        const tableSizeBytes = parseInt(r.table_size_bytes || "0");
        const indexSizeBytes = parseInt(r.index_size_bytes || "0");
        const totalSizeBytes = parseInt(r.total_size_bytes || "0");
        const freeSpaceBytes = parseInt(r.free_space_bytes || "0");

        // Estimate bloat ratio from free space
        const bloatRatio = totalSizeBytes > 0 ? (freeSpaceBytes / totalSizeBytes) * 100 : 0;

        return {
          schemaName: r.schema_name || schema || "",
          tableName: r.table_name || "",
          rowCount: parseInt(r.row_count || "0"),
          tableSize: formatBytes(tableSizeBytes),
          tableSizeBytes,
          indexSize: formatBytes(indexSizeBytes),
          // The byte figure was computed and then dropped, so the storage panel had no per-table
          // index total to add up: `INDEX_LENGTH` is what MySQL itself calls index bytes.
          indexSizeBytes,
          totalSize: formatBytes(totalSizeBytes),
          totalSizeBytes,
          bloatRatio: Math.round(bloatRatio * 10) / 10,
        };
      });
    } finally {
      conn.release();
    }
  }

  public async getIndexStats(options?: { schema?: string }): Promise<IndexStats[]> {
    this.ensureConnected();
    const schema = options?.schema ?? this.config.database;

    const conn = await this.pool!.getConnection();
    try {
      const [rows] = await runStatement(conn, INDEX_STATS_SQL, [schema]);

      // Vitess answers information_schema.STATISTICS with the physical shard database
      // (`vt_probe_0`) even though the filter above named the keyspace, so the size lookup asks
      // for the schema the server just reported rather than the one we connected to.
      const physicalSchema = (rows[0]?.schema_name as string | undefined) ?? schema;

      const indexSizes: Record<string, number> = {};
      try {
        const [sizeRows] = await runStatement(conn, INDEX_SIZES_SQL, [physicalSchema]);

        for (const row of sizeRows) {
          indexSizes[`${row.database_name}/${row.table_name}/${row.index_name}`] = parseInt(row.size_bytes || "0");
        }
      } catch {
        // Reading mysql.innodb_index_stats needs SELECT on the mysql schema, which a user granted
        // only its own database does not have (measured ER_TABLEACCESS_DENIED_ERROR). Every index
        // then reports no size at all rather than a fabricated 0 bytes.
      }

      return rows.map((r) => {
        // An absent row is not a zero-byte index: MyISAM tables and InnoDB tables whose
        // persistent statistics were never written have no row here at all.
        const indexSizeBytes = indexSizes[`${r.schema_name}/${r.table_name}/${r.index_name}`];

        return {
          schemaName: r.schema_name || schema || "",
          tableName: r.table_name || "",
          indexName: r.index_name || "",
          indexType: r.index_type || "BTREE",
          columns: r.columns?.split(",") || [],
          isUnique: Boolean(r.is_unique),
          isPrimary: Boolean(r.is_primary),
          indexSize: indexSizeBytes === undefined ? "N/A" : formatBytes(indexSizeBytes),
          indexSizeBytes,
          scans: parseInt(r.cardinality || "0"),
        };
      });
    } finally {
      conn.release();
    }
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();

    const conn = await this.pool!.getConnection();
    try {
      const stats: StorageStats[] = [];

      // Get database size
      const [dbRows] = await runStatement(conn, STORAGE_STATS_SQL, [this.config.database]);

      if (dbRows.length > 0) {
        const sizeBytes = parseInt(dbRows[0].size_bytes || "0");
        stats.push({
          name: "Data",
          location: this.config.database || "default",
          size: formatBytes(sizeBytes),
          sizeBytes,
        });
      }

      // Get binary log size if available
      try {
        const [binlogRows] = await runStatement(conn, "SHOW BINARY LOGS");
        const binlogSize = binlogRows.reduce((sum, r) => sum + parseInt(r.File_size || "0"), 0);
        if (binlogSize > 0) {
          stats.push({
            name: "Binary Logs",
            size: formatBytes(binlogSize),
            sizeBytes: binlogSize,
          });
        }
      } catch {
        // Binary logging not enabled
      }

      // Get InnoDB data file size
      try {
        const [innodbRows] = await runStatement(conn, "SHOW VARIABLES LIKE 'innodb_data_file_path'");
        if (innodbRows.length > 0) {
          stats.push({
            name: "InnoDB",
            location: innodbRows[0].Value || "ibdata1",
            size: "N/A",
            sizeBytes: 0,
          });
        }
      } catch {
        // Could not get InnoDB info
      }

      return stats;
    } finally {
      conn.release();
    }
  }

  private formatUptimeString(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  private formatDurationString(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
  }
}
