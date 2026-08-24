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

const HEALTH_SLOW_QUERIES_SQL = `
          SELECT
            LEFT(sql_text, 100) as query,
            count_star as calls,
            CONCAT(ROUND(avg_timer_wait / 1000000000, 2), 'ms') as avgTime
          FROM performance_schema.events_statements_summary_by_digest
          WHERE schema_name = ?
          ORDER BY sum_timer_wait DESC
          LIMIT 5;
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

// The LIMIT clause is interpolated at the call site in getSlowQueries().
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
    };
  }

  /**
   * Only the slow-query empty state; every other label is the SQL default and right.
   *
   * `getSlowQueries()` reads `performance_schema.events_statements_summary_by_digest`
   * and answers `[]` when that read fails, which on a server with the Performance
   * Schema off is the ordinary case. The panel used to name PostgreSQL's extension
   * there (#U12) - a statement store MySQL does not have under any name.
   */
  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      slowQueriesEmptyState:
        "Query stats come from performance_schema.events_statements_summary_by_digest - enable the Performance Schema to see them.",
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
        rejectUnauthorized: connSSL.mode === "verify-ca" || connSSL.mode === "verify-full",
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
          const [rows, fields] = await conn.execute<RowDataPacket[]>(sql, asExecuteParams(params));
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
      await this.pool!.execute(`KILL QUERY ${threadId}`);
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
          const [rows, fields] = await this.txConn!.execute<RowDataPacket[]>(sql, asExecuteParams(params));
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
      const [tablesRows] = await conn.execute<RowDataPacket[]>(
        SCHEMA_TABLES_SQL,
        asExecuteParams([this.config.database]),
      );

      const schemas: TableSchema[] = [];

      for (const row of tablesRows) {
        const tableName = row.table_name;
        const rowCount = parseInt(row.row_count || "0");
        const sizeBytes = parseInt(row.total_size || "0");

        const [columnsRows] = await conn.execute<RowDataPacket[]>(SCHEMA_COLUMNS_SQL, [
          this.config.database,
          tableName,
        ]);

        const [fkRows] = await conn.execute<RowDataPacket[]>(SCHEMA_FOREIGN_KEYS_SQL, [
          this.config.database,
          tableName,
        ]);

        const [indexRows] = await conn.execute<RowDataPacket[]>(SCHEMA_INDEXES_SQL, [this.config.database, tableName]);

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
      const [connRows] = await conn.execute<RowDataPacket[]>("SHOW STATUS LIKE 'Threads_connected'");
      const activeConnections = parseInt(connRows[0]?.Value || "0");

      const [sizeRows] = await conn.execute<RowDataPacket[]>(
        DATABASE_SIZE_MB_SQL,
        asExecuteParams([this.config.database]),
      );
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
        const [hitRows] = await conn.execute<RowDataPacket[]>(BUFFER_CACHE_HIT_RATIO_SQL);
        cacheHitRatio = formatCacheHitRatio(measuredNumber(hitRows[0]?.hit_ratio));
      } catch {
        // Nothing to read, so nothing is reported.
      }

      let slowQueries: SlowQuery[] = [];
      try {
        const [slowRows] = await conn.execute<RowDataPacket[]>(
          HEALTH_SLOW_QUERIES_SQL,
          asExecuteParams([this.config.database]),
        );
        slowQueries = slowRows.map((r) => ({
          query: r.query || "",
          calls: parseInt(r.calls || "0"),
          avgTime: r.avgTime || "N/A",
        }));
      } catch {
        slowQueries = [{ query: "Performance schema not available", calls: 0, avgTime: "N/A" }];
      }

      const [sessionRows] = await conn.execute<RowDataPacket[]>(
        HEALTH_ACTIVE_SESSIONS_SQL,
        asExecuteParams([this.config.database]),
      );

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
          case "analyze":
            sql = target
              ? `ANALYZE TABLE ${this.escapeIdentifier(target)}`
              : `ANALYZE TABLE ${await this.getAllTablesForMaintenance(conn)}`;
            break;
          case "optimize":
            sql = target
              ? `OPTIMIZE TABLE ${this.escapeIdentifier(target)}`
              : `OPTIMIZE TABLE ${await this.getAllTablesForMaintenance(conn)}`;
            break;
          case "check":
            sql = target
              ? `CHECK TABLE ${this.escapeIdentifier(target)}`
              : `CHECK TABLE ${await this.getAllTablesForMaintenance(conn)}`;
            break;
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

        await conn.execute(sql);
        return { success: true };
      } finally {
        conn.release();
      }
    });

    return {
      success: result.success,
      executionTime,
      message: `${type.toUpperCase()} completed successfully`,
    };
  }

  private async getAllTablesForMaintenance(conn: PoolConnection): Promise<string> {
    const [rows] = await conn.execute<RowDataPacket[]>(MAINTENANCE_TABLES_SQL, asExecuteParams([this.config.database]));

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
      const [versionRows] = await conn.execute<RowDataPacket[]>("SELECT VERSION() as version");
      const version = versionRows[0]?.version || "Unknown";

      // Get uptime
      const [uptimeRows] = await conn.execute<RowDataPacket[]>("SHOW STATUS LIKE 'Uptime'");
      const uptimeSeconds = parseInt(uptimeRows[0]?.Value || "0");
      const uptime = this.formatUptimeString(uptimeSeconds);

      // Get active connections
      const [connRows] = await conn.execute<RowDataPacket[]>("SHOW STATUS LIKE 'Threads_connected'");
      const activeConnections = parseInt(connRows[0]?.Value || "0");

      // Get max connections
      const [maxConnRows] = await conn.execute<RowDataPacket[]>("SHOW VARIABLES LIKE 'max_connections'");
      const maxConnections = parseInt(maxConnRows[0]?.Value || "151");

      // Get database size
      const [sizeRows] = await conn.execute<RowDataPacket[]>(
        OVERVIEW_DATABASE_SIZE_SQL,
        asExecuteParams([this.config.database]),
      );
      const databaseSizeBytes = parseInt(sizeRows[0]?.size_bytes || "0");

      // Get table and index count
      const [countRows] = await conn.execute<RowDataPacket[]>(
        OVERVIEW_OBJECT_COUNTS_SQL,
        asExecuteParams([this.config.database]),
      );

      const [tableCountRows] = await conn.execute<RowDataPacket[]>(
        OVERVIEW_TABLE_COUNT_SQL,
        asExecuteParams([this.config.database]),
      );

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
      const [hitRows] = await conn.execute<RowDataPacket[]>(BUFFER_CACHE_HIT_RATIO_SQL);
      const hitRatio = measuredNumber(hitRows[0]?.hit_ratio);

      // Get buffer pool usage
      const [poolRows] = await conn.execute<RowDataPacket[]>(BUFFER_POOL_PAGES_SQL);
      const dataPages = measuredNumber(poolRows[0]?.data_pages);
      const totalPages = measuredNumber(poolRows[0]?.total_pages);

      // Get queries per second
      const [qpsRows] = await conn.execute<RowDataPacket[]>(QUERIES_PER_SECOND_SQL);
      const queries = measuredNumber(qpsRows[0]?.queries);
      const uptime = measuredNumber(qpsRows[0]?.uptime);

      // Get deadlocks. SHOW STATUS answers this with or without performance_schema,
      // so a 0 here is a measurement and is reported as one.
      const [deadlockRows] = await conn.execute<RowDataPacket[]>("SHOW STATUS LIKE 'Innodb_deadlocks'");
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

  public async getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 10;

    const conn = await this.pool!.getConnection();
    try {
      const [rows] = await conn.execute<RowDataPacket[]>(
        `${SLOW_QUERIES_BODY_SQL} LIMIT ${Number(limit)};`,
        asExecuteParams([this.config.database]),
      );

      return rows.map((r) => ({
        queryId: r.query_id || undefined,
        query: r.query || "",
        calls: parseInt(r.calls || "0"),
        totalTime: parseFloat(r.total_time_ms || "0"),
        avgTime: parseFloat(r.avg_time_ms || "0"),
        minTime: parseFloat(r.min_time_ms || "0"),
        maxTime: parseFloat(r.max_time_ms || "0"),
        rows: parseInt(r.rows_examined || "0"),
      }));
    } catch {
      // Performance schema not available
      return [];
    } finally {
      conn.release();
    }
  }

  public async getActiveSessions(options?: { limit?: number }): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 50;

    const conn = await this.pool!.getConnection();
    try {
      const [rows] = await conn.execute<RowDataPacket[]>(
        `${ACTIVE_SESSIONS_BODY_SQL} LIMIT ${Number(limit)};`,
        asExecuteParams([this.config.database]),
      );

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
      const [rows] = await conn.execute<RowDataPacket[]>(TABLE_STATS_SQL, asExecuteParams([schema]));

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
      const [rows] = await conn.execute<RowDataPacket[]>(INDEX_STATS_SQL, asExecuteParams([schema]));

      // Vitess answers information_schema.STATISTICS with the physical shard database
      // (`vt_probe_0`) even though the filter above named the keyspace, so the size lookup asks
      // for the schema the server just reported rather than the one we connected to.
      const physicalSchema = (rows[0]?.schema_name as string | undefined) ?? schema;

      const indexSizes: Record<string, number> = {};
      try {
        const [sizeRows] = await conn.execute<RowDataPacket[]>(INDEX_SIZES_SQL, asExecuteParams([physicalSchema]));

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
      const [dbRows] = await conn.execute<RowDataPacket[]>(STORAGE_STATS_SQL, asExecuteParams([this.config.database]));

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
        const [binlogRows] = await conn.execute<RowDataPacket[]>("SHOW BINARY LOGS");
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
        const [innodbRows] = await conn.execute<RowDataPacket[]>("SHOW VARIABLES LIKE 'innodb_data_file_path'");
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
