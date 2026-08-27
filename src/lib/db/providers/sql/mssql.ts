/**
 * Microsoft SQL Server Database Provider
 * Full MSSQL support with connection pooling (SQL Authentication)
 */

import mssql from "mssql";
import { SQLBaseProvider } from "./sql-base";
import { mssqlColumnTypes } from "./column-types";
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
  type PreparedQuery,
  type QueryPrepareOptions,
} from "../../types";
import { DatabaseConfigError, ConnectionError, QueryError, mapDatabaseError } from "../../errors";
import { formatBytes } from "../../utils/pool-manager";
import { analyzeQuery, DEFAULT_QUERY_LIMIT, MAX_UNLIMITED_ROWS } from "../../utils/query-limiter";
import { readLeadingKeyword } from "@/lib/sql/leading-keyword";
import { resolveSqlGrammar, type SqlGrammar } from "@/lib/sql/grammar";
import { readStatementEnd } from "@/lib/sql/statement-end";
import { CACHE_HIT_RATIO_UNAVAILABLE, formatCacheHitRatio, measuredNumber } from "@/lib/monitoring-cache-ratio";

// Row shape used to group foreign keys per table in getSchema().
type ForeignKeyInfo = { columnName: string; referencedTable: string; referencedColumn: string };

/**
 * `SELECT ... ` with `TOP n` spliced in where T-SQL wants it, or `null` when this
 * statement has no leading `SELECT` to splice after.
 *
 * The insertion point comes from `readLeadingKeyword` rather than from a
 * `^\s*SELECT\s+` rewrite, because that pattern silently matched nothing behind a
 * leading comment while the caller had already committed to `wasLimited: true`
 * (#275). `DISTINCT` is found the same way, so `SELECT /* c *\/ DISTINCT a` places
 * `TOP` after the `DISTINCT` and not between the two - `SELECT TOP n DISTINCT ...`
 * is a syntax error in T-SQL.
 *
 * Every one of those three reads takes T-SQL's grammar, because this is a HEAD
 * rewrite and the index comes from the reading: T-SQL nests block comments, so a
 * flat reading of `SELECT /* a /* b *\/ DISTINCT *\/ name FROM t` found a
 * `DISTINCT` that is inside the comment and spliced the `TOP` in after it - inside
 * the comment too. SQL Server then ran the statement unbounded while this provider
 * reported a limit, which is #280's shape rather than a missed bound (#300).
 *
 * The two SUFFIX slices are safe under this dialect's grammar specifically: only
 * the alternate-quote tag reads the character before its index (see `readSqlSpan`),
 * and T-SQL does not have that form.
 */
function injectTop(sql: string, limit: number, grammar: SqlGrammar): string | null {
  const select = readLeadingKeyword(sql, grammar);
  if (select === null || select.keyword !== "SELECT") return null;

  const next = readLeadingKeyword(sql.slice(select.end), grammar);
  const insertAt = next?.keyword === "DISTINCT" ? select.end + next.end : select.end;

  // A `TOP` already sitting where this one would go means the statement carries its
  // own bound and `analyzeQuery`'s probe missed it - that probe wants literal
  // whitespace between the two words, so a comment between them defeats it, as does
  // a `DISTINCT`. Splicing anyway yields `SELECT TOP 50 TOP 10` and a syntax error,
  // so decline and let the caller report that nothing was limited.
  if (readLeadingKeyword(sql.slice(insertAt), grammar)?.keyword === "TOP") return null;

  return `${sql.slice(0, insertAt)} TOP ${limit}${sql.slice(insertAt)}`;
}

/**
 * A T-SQL page written as `OFFSET n ROW[S]`, at the end of the statement.
 *
 * That is a complete page here - "skip n rows and return the rest" - and it is
 * the one bound form the shared probes in `query-limiter.ts` cannot see: they
 * want a `FETCH … ROWS ONLY` tail or a bare `OFFSET n`, and `OFFSET 10 ROWS` is
 * neither. Unseen, the statement looked unbounded and collected a clause beside
 * its own page, which SQL Server rejects outright (Msg 10741) - so the statement
 * FAILED rather than returning too many rows, and this method reported a limit
 * for it. The form belongs to this dialect, so it is read here rather than in the
 * shared limiter, where it would move every other dialect's probes (#293).
 *
 * Anchored at the end of the statement for the same reason the shared probes
 * are: an `OFFSET` inside a subquery (`… FROM (SELECT … OFFSET 10 ROWS) x`) is a
 * different query expression, which a `TOP` on the outer one may legally join,
 * and one written in a trailing comment is not a page at all. A digit count only,
 * as the shared probes read: `OFFSET @skip ROWS` is not recognised, which is the
 * limitation `docs/providers/mssql.md` records.
 */
const TSQL_PAGE_TAIL = /\bOFFSET\s+\d+\s+ROWS?\s*$/i;

/**
 * Whether text mentions a clause a row-count clause may not sit beside.
 *
 * Consulted ONLY where the statement's end may not be cut. Every already-bounded
 * probe - the shared ones and `TSQL_PAGE_TAIL` above - is anchored at the end of
 * the statement's own text, and where the cut is refused that text still carries
 * the trailing trivia: a real page written before a trailing comment then sits
 * away from the anchor and reads as absent. An anchor that may be reading trivia
 * is not an answer a decision that ADDS a clause may rest on, so this asks the
 * weaker question the situation allows - is there anything here that could be a
 * page? - and the branch declines when there is.
 *
 * Unanchored and deliberately blunt: it also fires on a column named `offset`
 * and on a subquery's own page, so such a statement loses its bound. That is the
 * trade the whole of `src/lib/sql/` makes for text it cannot resolve - an
 * over-large read reported honestly as unbounded, never a statement the server
 * refuses - and both halves are pinned in this provider's suite.
 */
const TSQL_ROW_BOUND_MENTION = /\b(?:OFFSET|FETCH)\b/i;

// ============================================================================
// SQL Statements
// ============================================================================
// Multi-line SQL is hoisted to module scope so per-line coverage attribution
// stays stable (repo pattern, see the SCHEMA_*_SQL consts in postgres.ts).

const SCHEMA_TABLES_SQL = `
        SELECT
          s.name AS schema_name,
          t.name AS table_name,
          SUM(p.rows) AS row_count
        FROM sys.tables t
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        LEFT JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
        WHERE t.type = 'U'
        GROUP BY s.name, t.name
        ORDER BY s.name, t.name
      `;

const SCHEMA_COLUMNS_SQL = `
        SELECT
          TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE,
          IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION
        FROM INFORMATION_SCHEMA.COLUMNS
        ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
      `;

const SCHEMA_PRIMARY_KEYS_SQL = `
        SELECT
          s.name AS schema_name,
          t.name AS table_name,
          c.name AS column_name
        FROM sys.indexes i
        JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        JOIN sys.tables t ON i.object_id = t.object_id
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE i.is_primary_key = 1
      `;

const SCHEMA_FOREIGN_KEYS_SQL = `
        SELECT
          OBJECT_SCHEMA_NAME(fk.parent_object_id) AS schema_name,
          OBJECT_NAME(fk.parent_object_id) AS table_name,
          COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS column_name,
          OBJECT_NAME(fk.referenced_object_id) AS ref_table,
          COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS ref_column
        FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
      `;

const SCHEMA_INDEXES_SQL = `
        SELECT
          s.name AS schema_name,
          t.name AS table_name,
          i.name AS index_name,
          i.is_unique,
          c.name AS column_name,
          ic.key_ordinal
        FROM sys.indexes i
        JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        JOIN sys.tables t ON i.object_id = t.object_id
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE i.name IS NOT NULL AND i.is_primary_key = 0
        ORDER BY s.name, t.name, i.name, ic.key_ordinal
      `;

const DATABASE_SIZE_MB_SQL = `
          SELECT
            CAST(SUM(size) * 8.0 / 1024 AS DECIMAL(10,2)) AS size_mb
          FROM sys.database_files
        `;

// Shared by getHealth() and getPerformanceMetrics().
const BUFFER_CACHE_HIT_RATIO_SQL = `
          SELECT
            CAST(
              (a.cntr_value * 1.0 / NULLIF(b.cntr_value, 0)) * 100
              AS DECIMAL(5,2)
            ) AS hit_ratio
          FROM sys.dm_os_performance_counters a
          CROSS JOIN sys.dm_os_performance_counters b
          WHERE a.counter_name = 'Buffer cache hit ratio'
            AND a.object_name LIKE '%Buffer Manager%'
            AND b.counter_name = 'Buffer cache hit ratio base'
            AND b.object_name LIKE '%Buffer Manager%'
        `;

const HEALTH_SLOW_QUERIES_SQL = `
          SELECT TOP 5
            SUBSTRING(qt.text, 1, 100) AS query,
            qs.execution_count AS calls,
            CAST(qs.total_elapsed_time / NULLIF(qs.execution_count, 0) / 1000.0 AS DECIMAL(10,2)) AS avg_time_ms
          FROM sys.dm_exec_query_stats qs
          CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) qt
          WHERE qs.execution_count > 0
          ORDER BY qs.total_elapsed_time DESC
        `;

const HEALTH_ACTIVE_SESSIONS_SQL = `
          SELECT TOP 10
            s.session_id AS pid,
            s.login_name AS [user],
            DB_NAME(s.database_id) AS [database],
            s.status AS state,
            ISNULL(SUBSTRING(t.text, 1, 100), '') AS query,
            ISNULL(CAST(DATEDIFF(SECOND, s.last_request_start_time, GETDATE()) AS VARCHAR) + 's', 'N/A') AS duration
          FROM sys.dm_exec_sessions s
          LEFT JOIN sys.dm_exec_requests r ON s.session_id = r.session_id
          OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
          WHERE s.is_user_process = 1
          ORDER BY s.last_request_start_time DESC
        `;

// Rebuild all indexes on all tables.
const REBUILD_ALL_INDEXES_SQL = `
                DECLARE @sql NVARCHAR(MAX) = '';
                SELECT @sql = @sql + 'ALTER INDEX ALL ON [' + s.name + '].[' + t.name + '] REBUILD;'
                FROM sys.tables t
                JOIN sys.schemas s ON t.schema_id = s.schema_id
                WHERE t.type = 'U';
                EXEC sp_executesql @sql;
              `;

const OVERVIEW_UPTIME_SQL = `
          SELECT sqlserver_start_time,
                 DATEDIFF(SECOND, sqlserver_start_time, GETDATE()) AS uptime_seconds
          FROM sys.dm_os_sys_info
        `;

const OVERVIEW_CONNECTIONS_SQL = `
          SELECT
            COUNT(*) AS active_connections,
            (SELECT CAST(value_in_use AS INT) FROM sys.configurations WHERE name = 'user connections') AS max_connections
          FROM sys.dm_exec_sessions
          WHERE is_user_process = 1
        `;

const OVERVIEW_DATABASE_SIZE_SQL = `
          SELECT SUM(CAST(size AS BIGINT)) * 8 * 1024 AS size_bytes FROM sys.database_files
        `;

const OVERVIEW_OBJECT_COUNTS_SQL = `
          SELECT
            (SELECT COUNT(*) FROM sys.tables WHERE type = 'U') AS table_count,
            (SELECT COUNT(*) FROM sys.indexes WHERE object_id IN (SELECT object_id FROM sys.tables WHERE type = 'U') AND name IS NOT NULL) AS index_count
        `;

// Interpolated after "SELECT TOP <limit>" in getSlowQueries().
const SLOW_QUERIES_BODY_SQL = `
          CAST(qs.query_hash AS VARCHAR(50)) AS query_id,
          SUBSTRING(qt.text, 1, 500) AS query,
          qs.execution_count AS calls,
          CAST(qs.total_elapsed_time / 1000.0 AS DECIMAL(18,2)) AS total_time,
          CAST(qs.total_elapsed_time / NULLIF(qs.execution_count, 0) / 1000.0 AS DECIMAL(18,2)) AS avg_time,
          CAST(qs.min_elapsed_time / 1000.0 AS DECIMAL(18,2)) AS min_time,
          CAST(qs.max_elapsed_time / 1000.0 AS DECIMAL(18,2)) AS max_time,
          qs.total_rows AS row_cnt,
          qs.total_logical_reads AS logical_reads,
          qs.total_physical_reads AS physical_reads
        FROM sys.dm_exec_query_stats qs
        CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) qt
        WHERE qs.execution_count > 0
        ORDER BY qs.total_elapsed_time DESC
      `;

// Interpolated after "SELECT TOP <limit>" in getActiveSessions().
const ACTIVE_SESSIONS_BODY_SQL = `
          s.session_id AS pid,
          s.login_name AS [user],
          DB_NAME(s.database_id) AS [database],
          s.program_name AS application_name,
          s.host_name AS client_addr,
          s.status AS state,
          ISNULL(SUBSTRING(t.text, 1, 500), '') AS query,
          s.last_request_start_time AS query_start,
          ISNULL(CAST(DATEDIFF(SECOND, s.last_request_start_time, GETDATE()) AS VARCHAR) + 's', 'N/A') AS duration,
          ISNULL(DATEDIFF(MILLISECOND, s.last_request_start_time, GETDATE()), 0) AS duration_ms,
          r.wait_type,
          r.last_wait_type,
          CASE WHEN r.blocking_session_id > 0 THEN 1 ELSE 0 END AS is_blocked
        FROM sys.dm_exec_sessions s
        LEFT JOIN sys.dm_exec_requests r ON s.session_id = r.session_id
        OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
        WHERE s.is_user_process = 1
        ORDER BY
          CASE s.status WHEN 'running' THEN 0 WHEN 'sleeping' THEN 1 ELSE 2 END,
          s.last_request_start_time DESC
      `;

const TABLE_STATS_SQL = `
        SELECT
          s.name AS schema_name,
          t.name AS table_name,
          SUM(p.rows) AS row_count,
          SUM(a.total_pages) * 8 * 1024 AS total_size_bytes,
          SUM(a.used_pages) * 8 * 1024 AS used_size_bytes,
          SUM(CASE WHEN i.type IN (0, 1) THEN a.total_pages ELSE 0 END) * 8 * 1024 AS table_size_bytes,
          SUM(CASE WHEN i.type > 1 THEN a.total_pages ELSE 0 END) * 8 * 1024 AS index_size_bytes,
          STATS_DATE(t.object_id, 1) AS last_stats_update
        FROM sys.tables t
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        JOIN sys.indexes i ON t.object_id = i.object_id
        JOIN sys.partitions p ON i.object_id = p.object_id AND i.index_id = p.index_id
        JOIN sys.allocation_units a ON p.partition_id = a.container_id
        WHERE t.type = 'U'
        GROUP BY s.name, t.name, t.object_id
        ORDER BY SUM(a.total_pages) DESC
      `;

const INDEX_STATS_SQL = `
        SELECT
          s.name AS schema_name,
          t.name AS table_name,
          i.name AS index_name,
          i.type_desc AS index_type,
          i.is_unique,
          i.is_primary_key,
          SUM(a.total_pages) * 8 * 1024 AS index_size_bytes,
          ISNULL(u.user_seeks + u.user_scans + u.user_lookups, 0) AS scans
        FROM sys.indexes i
        JOIN sys.tables t ON i.object_id = t.object_id
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        LEFT JOIN sys.partitions p ON i.object_id = p.object_id AND i.index_id = p.index_id
        LEFT JOIN sys.allocation_units a ON p.partition_id = a.container_id
        LEFT JOIN sys.dm_db_index_usage_stats u ON i.object_id = u.object_id AND i.index_id = u.index_id AND u.database_id = DB_ID()
        WHERE i.name IS NOT NULL AND t.type = 'U'
        GROUP BY s.name, t.name, i.name, i.type_desc, i.is_unique, i.is_primary_key,
                 i.object_id, i.index_id, u.user_seeks, u.user_scans, u.user_lookups
        ORDER BY SUM(a.total_pages) DESC
      `;

const INDEX_COLUMNS_SQL = `
        SELECT
          s.name AS schema_name,
          t.name AS table_name,
          i.name AS index_name,
          c.name AS column_name,
          ic.key_ordinal
        FROM sys.index_columns ic
        JOIN sys.indexes i ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
        JOIN sys.tables t ON i.object_id = t.object_id
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        WHERE i.name IS NOT NULL AND t.type = 'U'
        ORDER BY s.name, t.name, i.name, ic.key_ordinal
      `;

const STORAGE_STATS_SQL = `
        SELECT
          name,
          physical_name AS location,
          CAST(size AS BIGINT) * 8 * 1024 AS size_bytes,
          type_desc
        FROM sys.database_files
        ORDER BY size DESC
      `;

// ============================================================================
// MSSQL Provider
// ============================================================================

export class MSSQLProvider extends SQLBaseProvider {
  private pool: mssql.ConnectionPool | null = null;

  // Transaction support
  private txTransaction: mssql.Transaction | null = null;
  private txActive = false;

  // Track running requests for cancellation
  private runningRequests = new Map<string, mssql.Request>();

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
      defaultPort: 1433,
      // Disabled until a SQL Server dialect wrapper exists (#126): a real plan flow needs
      // session-level SET SHOWPLAN_*, which the single-statement explain path cannot express.
      supportsExplain: false,
      supportsConnectionString: true,
      supportsInlineRowEdit: true,
      // The mssql package's Transaction object over one held pool connection.
      supportsTransactions: true,
      maintenanceOperations: ["analyze", "check", "optimize", "kill"],
      // `optimize` is `ALTER INDEX ALL ON [<t>] REBUILD`, so its target is a TABLE
      // even though the wording says indexes - the same words Oracle uses for an
      // operation that needed a different kind of name (#U9). `check` is
      // `DBCC CHECKDB`, which takes no object: `runMaintenance` ignores the target,
      // so only a global control can honestly offer it.
      maintenanceOperationSpecs: {
        analyze: { label: "Update Statistics", perEntity: true, global: true },
        check: { label: "Check Database", perEntity: false, global: true },
        optimize: { label: "Rebuild Indexes", perEntity: true, global: true },
        kill: { label: "Kill Session", perEntity: false, global: false },
      },
    };
  }

  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      analyzeAction: "Update Statistics",
      vacuumAction: "Rebuild Indexes",
      // The vacuum slot has said "Rebuild Indexes" since this provider shipped, and
      // that is `optimize`, not `vacuum` - so the global card gated on the literal
      // `vacuum` never rendered these words at all (#U9).
      vacuumActionOperation: "optimize",
      analyzeGlobalLabel: "Update Stats",
      analyzeGlobalTitle: "Update Statistics",
      analyzeGlobalDesc: "Updates query optimizer statistics for all tables to improve query performance.",
      vacuumGlobalLabel: "Rebuild Indexes",
      vacuumGlobalTitle: "Rebuild All Indexes",
      vacuumGlobalDesc: "Rebuilds all indexes to reclaim space and reduce fragmentation.",
      // `getSlowQueries()` reads sys.dm_exec_query_stats, and a login without VIEW
      // SERVER STATE gets `[]` from the swallowed failure. The panel used to name a
      // PostgreSQL extension there (#U12); the permission is what a DBA can act on.
      slowQueriesEmptyState:
        "Query stats come from sys.dm_exec_query_stats, which needs the VIEW SERVER STATE permission.",
    };
  }

  // ============================================================================
  // SQL Dialect Overrides
  // ============================================================================

  protected override escapeIdentifier(identifier: string): string {
    const escaped = identifier.replace(/\]/g, "]]");
    return `[${escaped}]`;
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.connectionString) {
      if (!this.config.host) {
        throw new DatabaseConfigError("Host is required for SQL Server", "mssql");
      }
      if (!this.config.database) {
        throw new DatabaseConfigError("Database name is required for SQL Server", "mssql");
      }
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  private buildConfig(): mssql.config {
    const host = this.config.host || "localhost";
    const port = this.config.port || 1433;
    const isAzure = host.endsWith(".database.windows.net");

    const sslConfig = this.config.ssl;
    // SQL Server 2022+ enforces encryption by default; always encrypt and trust self-signed certs for non-Azure
    let encrypt = true;
    let trustServerCertificate = !isAzure;

    if (sslConfig) {
      if (sslConfig.mode === "disable") {
        encrypt = false;
      } else {
        encrypt = true;
        trustServerCertificate = sslConfig.mode === "require";
      }
    }

    const config: mssql.config = {
      user: this.config.user,
      password: this.config.password,
      server: host,
      port,
      database: this.config.database,
      pool: {
        min: this.poolConfig.min,
        max: this.poolConfig.max,
        idleTimeoutMillis: this.poolConfig.idleTimeout,
      },
      options: {
        encrypt,
        trustServerCertificate,
        connectTimeout: this.poolConfig.acquireTimeout,
        requestTimeout: this.queryTimeout,
      },
    };

    // Named instance support
    if (this.config.instanceName) {
      config.options = {
        ...config.options,
        instanceName: this.config.instanceName,
      };
      // When using instance name, port is auto-negotiated via SQL Server Browser
      delete (config as Record<string, unknown>).port;
    }

    return config;
  }

  public async connect(): Promise<void> {
    if (this.pool) {
      return;
    }

    try {
      const config = this.buildConfig();
      this.pool = new mssql.ConnectionPool(config);

      // `mssql`'s ConnectionPool is an EventEmitter that emits `error` for a background
      // connection failure (a non-ESOCKET tedious error) and for a failed acquire. An
      // `error` event with no listener is an uncaught exception, so without this handler
      // one of those takes the server process down (#298). A failed acquire ALSO rejects
      // the caller's promise, so this handler must only log — swallowing nothing.
      this.pool.on("error", (error: unknown) => {
        console.error("[MSSQL] Pool error:", error);
      });

      await this.pool.connect();

      // Test the connection
      await this.pool.request().query("SELECT 1 AS test");

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw new ConnectionError(
        `Failed to connect to SQL Server: ${error instanceof Error ? error.message : error}`,
        "mssql",
        this.config.host,
        this.config.port,
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.pool) {
      try {
        await this.pool.close();
      } catch {
        // Force close on error
      }
      this.pool = null;
      this.setConnected(false);
    }
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  public async query(sql: string, params?: unknown[], queryId?: string): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          const request = this.pool!.request();

          if (queryId) {
            this.runningRequests.set(queryId, request);
          }

          // Add parameters
          if (params && params.length > 0) {
            params.forEach((p, i) => {
              request.input(`p${i + 1}`, p);
            });
          }

          const res = await request.query(sql);
          return res;
        } catch (error) {
          throw mapDatabaseError(error, "mssql", sql);
        } finally {
          if (queryId) this.runningRequests.delete(queryId);
        }
      });

      const recordset = result.recordset || [];
      const fields = recordset.columns
        ? Object.keys(recordset.columns)
        : recordset.length > 0
          ? Object.keys(recordset[0])
          : [];

      return {
        rows: recordset as Record<string, unknown>[],
        fields,
        rowCount: result.rowsAffected?.[0] ?? recordset.length,
        executionTime,
        ...mssqlColumnTypes(recordset.columns),
      };
    });
  }

  public async cancelQuery(queryId: string): Promise<boolean> {
    const request = this.runningRequests.get(queryId);
    if (!request) return false;

    try {
      request.cancel();
      return true;
    } catch (error) {
      console.error("[MSSQL] Failed to cancel query:", error);
      return false;
    }
  }

  // ============================================================================
  // Query Preparation (MSSQL TOP / OFFSET FETCH)
  // ============================================================================

  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    const { limit = DEFAULT_QUERY_LIMIT, offset = 0, unlimited = false } = options;
    const effectiveLimit = unlimited ? MAX_UNLIMITED_ROWS : limit;
    const queryInfo = analyzeQuery(query, this.type);

    if (queryInfo.type === "SELECT" && !queryInfo.hasLimit) {
      // The `TOP` branch writes into the HEAD and was never reachable by a
      // trailing comment, but the pagination branch below appends at the tail
      // exactly as PostgreSQL's and Oracle's do, so it shared #280: the clause
      // landed inside the comment while this method reported a limit. Both
      // branches now build on the statement's own text and re-attach whatever
      // trailed it, which leaves the `TOP` output unchanged except that
      // whitespace before a terminating `;` is preserved instead of dropped.
      //
      // Splitting and rejoining is lossless and the splice does not depend on
      // where the statement ends, so the `TOP` branch stays correct even where
      // the tail may not be CUT. Only the appending branch has to decline there.
      //
      // The end is read under T-SQL's grammar (#292), where `#` opens no comment
      // at all - `#name` and `##name` are temp tables. That is what makes a temp
      // table an ordinary statement here rather than the special case it used to
      // be: `SELECT * FROM #tmp` is cuttable, so BOTH branches are reachable for
      // it, and the already-bounded probe sees a `FETCH NEXT` written after the
      // `#` even when trailing trivia follows it.
      const source = query.trim();
      // Resolved once and handed to both readers below, so the head splice and the
      // end reader cannot disagree about where a comment ends (#300).
      const grammar = resolveSqlGrammar(this.type);
      const { end, rewritable } = readStatementEnd(source, grammar);
      let modifiedSql = source.slice(0, end);
      const trailing = source.slice(end);

      // Two pages the shared probes cannot see, and a clause beside either is a
      // statement SQL Server refuses (Msg 10741) rather than one that returns too
      // many rows - so both decline here, before either branch commits to a
      // `wasLimited: true` (#293). The first is this dialect's own `OFFSET n ROWS`
      // form; the second is every statement whose end may not be cut, where no
      // end anchor is reading the statement's real tail and the honest answer is
      // that a page cannot be ruled out. Neither is the hash the paragraph above
      // describes: that half is closed at the root by naming the dialect.
      if (TSQL_PAGE_TAIL.test(modifiedSql) || (!rewritable && TSQL_ROW_BOUND_MENTION.test(modifiedSql))) {
        return { query, wasLimited: false, limit: effectiveLimit, offset };
      }

      if (offset > 0) {
        if (!rewritable) {
          return { query, wasLimited: false, limit: effectiveLimit, offset };
        }

        // OFFSET FETCH requires ORDER BY
        const hasOrderBy = /\bORDER\s+BY\b/i.test(modifiedSql);
        if (!hasOrderBy) {
          modifiedSql = `${modifiedSql} ORDER BY (SELECT NULL)`;
        }
        modifiedSql = `${modifiedSql} OFFSET ${offset} ROWS FETCH NEXT ${effectiveLimit} ROWS ONLY`;
      } else {
        // Inject TOP N after SELECT
        const injected = injectTop(modifiedSql, effectiveLimit, grammar);

        // Nothing to inject into: report the truth rather than a limit that is not
        // there. `analyzeQuery` also calls a CTE a SELECT, and `TOP` belongs to the
        // SELECT at its tail, which finding needs a parser this provider does not
        // have. The old head-rewrite silently produced this same non-edit behind a
        // leading comment while still claiming `wasLimited: true` (#275).
        if (injected === null) {
          return { query, wasLimited: false, limit: effectiveLimit, offset };
        }
        modifiedSql = injected;
      }

      return {
        query: `${modifiedSql}${trailing}`,
        wasLimited: true,
        limit: effectiveLimit,
        offset,
      };
    }

    return { query, wasLimited: false, limit: effectiveLimit, offset };
  }

  // ============================================================================
  // Transaction Support
  // ============================================================================

  public async beginTransaction(): Promise<void> {
    this.ensureConnected();
    if (this.txActive) throw new QueryError("Transaction already active", "mssql");
    this.txTransaction = new mssql.Transaction(this.pool!);
    await this.txTransaction.begin();
    this.txActive = true;
  }

  public async commitTransaction(): Promise<void> {
    if (!this.txTransaction || !this.txActive) throw new QueryError("No active transaction", "mssql");
    try {
      await this.txTransaction.commit();
    } finally {
      this.txTransaction = null;
      this.txActive = false;
    }
  }

  public async rollbackTransaction(): Promise<void> {
    if (!this.txTransaction || !this.txActive) throw new QueryError("No active transaction", "mssql");
    try {
      await this.txTransaction.rollback();
    } finally {
      this.txTransaction = null;
      this.txActive = false;
    }
  }

  public isInTransaction(): boolean {
    return this.txActive;
  }

  public async queryInTransaction(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.txTransaction || !this.txActive) throw new QueryError("No active transaction", "mssql");

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          const request = new mssql.Request(this.txTransaction!);
          if (params && params.length > 0) {
            params.forEach((p, i) => {
              request.input(`p${i + 1}`, p);
            });
          }
          return await request.query(sql);
        } catch (error) {
          throw mapDatabaseError(error, "mssql", sql);
        }
      });

      const recordset = result.recordset || [];
      const fields = recordset.length > 0 ? Object.keys(recordset[0]) : [];

      return {
        rows: recordset as Record<string, unknown>[],
        fields,
        rowCount: result.rowsAffected?.[0] ?? recordset.length,
        executionTime,
        ...mssqlColumnTypes(recordset.columns),
      };
    });
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    try {
      // Get tables
      const tablesRes = await this.pool!.request().query(SCHEMA_TABLES_SQL);
      const tables = tablesRes.recordset || [];

      // Get columns
      const colsRes = await this.pool!.request().query(SCHEMA_COLUMNS_SQL);
      const allCols = colsRes.recordset || [];

      // Get primary keys
      const pkRes = await this.pool!.request().query(SCHEMA_PRIMARY_KEYS_SQL);
      const pkMap = new Map<string, Set<string>>();
      for (const row of pkRes.recordset || []) {
        const key = `${row.schema_name}.${row.table_name}`;
        if (!pkMap.has(key)) pkMap.set(key, new Set());
        pkMap.get(key)!.add(row.column_name);
      }

      // Get foreign keys
      const fkRes = await this.pool!.request().query(SCHEMA_FOREIGN_KEYS_SQL);
      const fksByTable = new Map<string, ForeignKeyInfo[]>();
      for (const row of fkRes.recordset || []) {
        const key = `${row.schema_name}.${row.table_name}`;
        if (!fksByTable.has(key)) fksByTable.set(key, []);
        fksByTable.get(key)!.push({
          columnName: row.column_name,
          referencedTable: row.ref_table,
          referencedColumn: row.ref_column,
        });
      }

      // Get indexes
      const idxRes = await this.pool!.request().query(SCHEMA_INDEXES_SQL);

      const idxByTable = new Map<string, Map<string, { unique: boolean; columns: string[] }>>();
      for (const row of idxRes.recordset || []) {
        const key = `${row.schema_name}.${row.table_name}`;
        if (!idxByTable.has(key)) idxByTable.set(key, new Map());
        const tableIdxs = idxByTable.get(key)!;
        if (!tableIdxs.has(row.index_name)) {
          tableIdxs.set(row.index_name, { unique: row.is_unique, columns: [] });
        }
        tableIdxs.get(row.index_name)!.columns.push(row.column_name);
      }

      // Group columns by table
      const colsByTable = new Map<string, typeof allCols>();
      for (const c of allCols) {
        const key = `${c.TABLE_SCHEMA}.${c.TABLE_NAME}`;
        if (!colsByTable.has(key)) colsByTable.set(key, []);
        colsByTable.get(key)!.push(c);
      }

      return tables.map((t: Record<string, unknown>) => {
        const schemaName = String(t.schema_name || "dbo");
        const tableName = String(t.table_name || "");
        const key = `${schemaName}.${tableName}`;
        const displayName = schemaName === "dbo" ? tableName : `${schemaName}.${tableName}`;
        const pks = pkMap.get(key) || new Set();

        const columns = (colsByTable.get(key) || []).map((c: Record<string, unknown>) => ({
          name: String(c.COLUMN_NAME || ""),
          type: String(c.DATA_TYPE || ""),
          nullable: String(c.IS_NULLABLE || "") === "YES",
          isPrimary: pks.has(String(c.COLUMN_NAME || "")),
          defaultValue: c.COLUMN_DEFAULT ? String(c.COLUMN_DEFAULT) : undefined,
        }));

        const foreignKeys = fksByTable.get(key) || [];

        const tableIdxs = idxByTable.get(key) || new Map();
        const indexes = Array.from(tableIdxs.entries()).map(([name, info]) => ({
          name,
          columns: info.columns,
          unique: info.unique,
        }));

        return {
          name: displayName,
          rowCount: Number(t.row_count || 0),
          columns,
          indexes,
          foreignKeys,
        };
      });
    } catch (error) {
      throw mapDatabaseError(error, "mssql");
    }
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    try {
      // Left UNDEFINED, and spread conditionally into the return below.
      // `HealthInfo.activeConnections` is optional precisely so a server whose session
      // DMV was denied omits the figure instead of sending a fabricated 0, and this is
      // the reading the agent forwards to the model (`src/lib/agent/tools.ts` projects
      // it with `?? null`), so an initial 0 made a denial indistinguishable from an
      // idle instance. Reading every session from sys.dm_exec_sessions needs
      // VIEW SERVER STATE on SQL Server 2019 and earlier and VIEW SERVER PERFORMANCE
      // STATE on 2022 and later (Microsoft's reference for the view; VIEW SERVER STATE
      // implies the newer grant, so it still covers this) - on the 2022 CU26 instance
      // whose refusal was measured 2026-08-23 that is the SAME permission the
      // performance-counter DMV wanted, not a sibling grant (`Msg 300 ... VIEW SERVER
      // PERFORMANCE STATE permission was denied on object 'server', database
      // 'master'`). Azure SQL Database wants VIEW DATABASE STATE and restricts the
      // same server-scoped DMVs. See docs/providers/mssql.md section 7.2.
      let activeConnections: number | undefined;
      let databaseSize = "N/A";
      let cacheHitRatio: string = CACHE_HIT_RATIO_UNAVAILABLE;
      const slowQueries: SlowQuery[] = [];
      const activeSessions: ActiveSession[] = [];

      // Active connections
      try {
        const connRes = await this.pool!.request().query(
          `SELECT COUNT(*) AS cnt FROM sys.dm_exec_sessions WHERE is_user_process = 1`,
        );
        // measuredNumber, not `|| 0`: a genuinely idle instance answers 0 and that 0 is
        // a reading, so the falsy test would have thrown away the very figure it was
        // meant to publish. Only an unanswered COUNT stays absent.
        activeConnections = measuredNumber(connRes.recordset[0]?.cnt);
      } catch {
        /* The figure stays absent, never 0. Which grant this DMV wants is in the note
           above; that an ungranted login is documented as row-filtered rather than
           refused - so this guard may never run for one - is in section 7.2. */
      }

      // Database size
      try {
        const sizeRes = await this.pool!.request().query(DATABASE_SIZE_MB_SQL);
        const mb = Number(sizeRes.recordset[0]?.size_mb || 0);
        databaseSize = mb > 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb} MB`;
      } catch {
        /* ignore */
      }

      // Cache hit ratio. `|| 0` used to publish "0%" for a reading SQL Server never
      // gave, and the Overview card rates 0 as "Needs tuning". Both absences are
      // ordinary and both were measured 2026-08-23 on SQL Server 2022 CU26: a login
      // with only CONNECT gets `Msg 300 ... VIEW SERVER PERFORMANCE STATE permission
      // was denied on object 'server', database 'master'` (the catch below), and a
      // zero counter base gives one `NULL` row through NULLIF (measuredNumber).
      try {
        const cacheRes = await this.pool!.request().query(BUFFER_CACHE_HIT_RATIO_SQL);
        const ratio = measuredNumber(cacheRes.recordset[0]?.hit_ratio);
        if (ratio !== undefined) cacheHitRatio = `${formatCacheHitRatio(ratio)}%`;
      } catch {
        /* The DMV needs VIEW SERVER PERFORMANCE STATE; the initial "N/A" stands. */
      }

      // Slow queries
      try {
        const slowRes = await this.pool!.request().query(HEALTH_SLOW_QUERIES_SQL);
        for (const row of slowRes.recordset || []) {
          slowQueries.push({
            query: String(row.query || ""),
            calls: Number(row.calls || 0),
            avgTime: `${row.avg_time_ms}ms`,
          });
        }
      } catch {
        /* DMV permissions */
      }

      // Active sessions
      try {
        const sessRes = await this.pool!.request().query(HEALTH_ACTIVE_SESSIONS_SQL);
        for (const row of sessRes.recordset || []) {
          activeSessions.push({
            pid: Number(row.pid || 0),
            user: String(row.user || "unknown"),
            database: String(row.database || ""),
            state: String(row.state || "unknown"),
            query: String(row.query || ""),
            duration: String(row.duration || "N/A"),
          });
        }
      } catch {
        /* ignore */
      }

      return {
        ...(activeConnections === undefined ? {} : { activeConnections }),
        databaseSize,
        cacheHitRatio,
        slowQueries,
        activeSessions,
      };
    } catch (error) {
      throw mapDatabaseError(error, "mssql");
    }
  }

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  public async runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult> {
    this.ensureConnected();

    const { result, executionTime } = await this.measureExecution(async () => {
      try {
        let sql = "";

        switch (type) {
          case "analyze":
            if (target) {
              sql = `UPDATE STATISTICS [${target.replace(/\]/g, "]]")}]`;
            } else {
              sql = `EXEC sp_updatestats`;
            }
            break;
          case "check":
            sql = `DBCC CHECKDB WITH NO_INFOMSGS`;
            break;
          case "optimize":
            if (target) {
              sql = `ALTER INDEX ALL ON [${target.replace(/\]/g, "]]")}] REBUILD`;
            } else {
              sql = REBUILD_ALL_INDEXES_SQL;
            }
            break;
          case "kill":
            if (!target) {
              throw new QueryError("Target SPID is required for kill operation", "mssql");
            }
            const spid = parseInt(target, 10);
            if (isNaN(spid)) {
              throw new QueryError("Invalid SPID for kill operation", "mssql");
            }
            sql = `KILL ${spid}`;
            break;
        }

        // Unsupported types leave sql empty and are rejected here; every supported
        // case above assigns a non-empty statement or throws before reaching this.
        if (!sql) {
          throw new QueryError(`Unsupported maintenance type: ${type}`, "mssql");
        }

        await this.pool!.request().query(sql);
        return { success: true };
      } catch (error) {
        throw mapDatabaseError(error, "mssql");
      }
    });

    return {
      success: result.success,
      executionTime,
      message: `${type.toUpperCase()} completed successfully`,
    };
  }

  // ============================================================================
  // Pool Statistics
  // ============================================================================

  public getPoolStats() {
    if (!this.pool) {
      return { total: 0, idle: 0, active: 0, waiting: 0 };
    }

    return {
      total: this.pool.size,
      idle: this.pool.available,
      active: this.pool.size - this.pool.available,
      waiting: this.pool.pending,
    };
  }

  // ============================================================================
  // Extended Monitoring Methods
  // ============================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();

    try {
      let version = "SQL Server";
      let uptime = "N/A";
      let startTime: Date | undefined;
      // Left UNDEFINED and spread conditionally into the return below, mirroring
      // getHealth() above: `DatabaseOverview.activeConnections` is optional for the
      // same reason, so a server whose session DMV was denied omits the figure
      // instead of publishing a fabricated 0. getHealth() does NOT compose from this
      // reading - it runs its own COUNT over the same DMV - and the agent's curated
      // `health` reading is getHealth() too (`method: "getHealth"` in
      // src/lib/agent/tools.ts; nothing under src/lib/agent reads getOverview()). This
      // count's readers are the monitoring Connections card, its trend chart and the
      // connection-threshold rating over them, so an initial 0 made a denial
      // indistinguishable from an idle instance for all three.
      // OverviewTab.tsx renders "N/A" over "not published" for the absence and drops
      // the sample from the connection trend; the 0 printed as the figure 0 on that
      // card and each refresh added a real 0 point to the trend. No percentage was
      // involved: the ceiling comes from the SAME statement, so a refused read left
      // maxConnections at its 0 initialiser and the card said "no limit published",
      // with no "/32767" and no bar. See docs/providers/mssql.md section 7.2.
      let activeConnections: number | undefined;
      // maxConnections stays a required number: 0 MEANS "no limit published" here,
      // so unlike the count above, 0 and absence are the SAME fact for the ceiling.
      let maxConnections = 0;
      let databaseSize = "0 bytes";
      let databaseSizeBytes = 0;
      let tableCount = 0;
      let indexCount = 0;

      // Version
      try {
        const vRes = await this.pool!.request().query(`SELECT @@VERSION AS version`);
        version = String(vRes.recordset[0]?.version || "").split("\n")[0];
      } catch {
        /* ignore */
      }

      // Uptime
      try {
        const upRes = await this.pool!.request().query(OVERVIEW_UPTIME_SQL);
        if (upRes.recordset[0]) {
          const secs = Number(upRes.recordset[0].uptime_seconds || 0);
          const days = Math.floor(secs / 86400);
          const hours = Math.floor((secs % 86400) / 3600);
          const minutes = Math.floor((secs % 3600) / 60);
          uptime = days > 0 ? `${days}d ${hours}h ${minutes}m` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
          startTime = new Date(upRes.recordset[0].sqlserver_start_time);
        }
      } catch {
        /* ignore */
      }

      // Connections
      try {
        const connRes = await this.pool!.request().query(OVERVIEW_CONNECTIONS_SQL);
        // measuredNumber, not `|| 0`: an idle instance answers COUNT(*) = 0 and that
        // 0 is a reading, so the falsy test threw away the very figure it published.
        // Only an unanswered COUNT stays absent.
        activeConnections = measuredNumber(connRes.recordset[0]?.active_connections);
        maxConnections = Number(connRes.recordset[0]?.max_connections || 32767);
        if (maxConnections === 0) maxConnections = 32767; // 0 means unlimited
      } catch {
        /* The count stays absent, never 0, and the ceiling stays 0, which already
           reads as "no limit published". Which half of this statement refuses is
           version-dependent, and Microsoft documents only one of them plainly:
           sys.configurations requires membership in `public` on SQL Server 2019 and
           earlier but VIEW SERVER PERFORMANCE STATE on 2022 and later, so on 2022+ an
           ungranted login lands here on the ceiling lookup alone. sys.dm_exec_sessions
           is documented as row-filtered rather than refused - "Everyone can see their
           own session information", the server-state grant only widening that to ALL
           sessions - so on 2019 and earlier the same login may instead SUCCEED with a
           COUNT of its own session, an under-reading no guard here can see because
           nothing failed. That case is unmeasured and unfixed; see
           docs/providers/mssql.md section 7.2. */
      }

      // Database size
      try {
        const sizeRes = await this.pool!.request().query(OVERVIEW_DATABASE_SIZE_SQL);
        databaseSizeBytes = Number(sizeRes.recordset[0]?.size_bytes || 0);
        databaseSize = formatBytes(databaseSizeBytes);
      } catch {
        /* ignore */
      }

      // Table/index counts
      try {
        const cntRes = await this.pool!.request().query(OVERVIEW_OBJECT_COUNTS_SQL);
        tableCount = Number(cntRes.recordset[0]?.table_count || 0);
        indexCount = Number(cntRes.recordset[0]?.index_count || 0);
      } catch {
        /* ignore */
      }

      return {
        version,
        uptime,
        startTime,
        ...(activeConnections === undefined ? {} : { activeConnections }),
        maxConnections,
        databaseSize,
        databaseSizeBytes,
        tableCount,
        indexCount,
      };
    } catch (error) {
      throw mapDatabaseError(error, "mssql");
    }
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();

    try {
      let cacheHitRatio: number | undefined;

      try {
        const cacheRes = await this.pool!.request().query(BUFFER_CACHE_HIT_RATIO_SQL);
        cacheHitRatio = measuredNumber(cacheRes.recordset[0]?.hit_ratio);
      } catch {
        /* DMV permissions; nothing was measured, so nothing is reported. */
      }

      return {
        ...(cacheHitRatio === undefined ? {} : { cacheHitRatio }),
        // bufferPoolUsage is gone rather than merely absent. It used to be assigned
        // `cacheHitRatio` itself - the same number under a second name, drawn and
        // rated as a separate gauge. SQL Server does publish pool occupancy, through
        // sys.dm_os_buffer_descriptors against max server memory, but this method
        // does not query it and that scan is not free; until it does there is nothing
        // here to report.
      };
    } catch (error) {
      throw mapDatabaseError(error, "mssql");
    }
  }

  public async getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 10;

    try {
      const res = await this.pool!.request().query(
        `SELECT TOP ${Math.max(1, Math.trunc(Number(limit)) || 1)} ${SLOW_QUERIES_BODY_SQL}`,
      );

      return (res.recordset || []).map((r: Record<string, unknown>) => ({
        queryId: String(r.query_id || ""),
        query: String(r.query || ""),
        calls: Number(r.calls || 0),
        totalTime: Number(r.total_time || 0),
        avgTime: Number(r.avg_time || 0),
        minTime: Number(r.min_time || 0),
        maxTime: Number(r.max_time || 0),
        rows: Number(r.row_cnt || 0),
        sharedBlksHit: Number(r.logical_reads || 0),
        sharedBlksRead: Number(r.physical_reads || 0),
      }));
    } catch {
      return [];
    }
  }

  public async getActiveSessions(options?: { limit?: number }): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 50;

    try {
      const res = await this.pool!.request().query(
        `SELECT TOP ${Math.max(1, Math.trunc(Number(limit)) || 1)} ${ACTIVE_SESSIONS_BODY_SQL}`,
      );

      return (res.recordset || []).map((r: Record<string, unknown>) => ({
        pid: Number(r.pid || 0),
        user: String(r.user || "unknown"),
        database: String(r.database || ""),
        applicationName: r.application_name ? String(r.application_name) : undefined,
        clientAddr: r.client_addr ? String(r.client_addr) : undefined,
        state: String(r.state || "unknown"),
        query: String(r.query || ""),
        queryStart: r.query_start ? new Date(String(r.query_start)) : undefined,
        duration: String(r.duration || "N/A"),
        durationMs: Number(r.duration_ms || 0),
        waitEventType: r.wait_type ? String(r.wait_type) : undefined,
        waitEvent: r.last_wait_type ? String(r.last_wait_type) : undefined,
        blocked: Boolean(r.is_blocked),
      }));
    } catch {
      return [];
    }
  }

  public async getTableStats(): Promise<TableStats[]> {
    this.ensureConnected();

    try {
      const res = await this.pool!.request().query(TABLE_STATS_SQL);

      return (res.recordset || []).map((r: Record<string, unknown>) => {
        const tableSizeBytes = Number(r.table_size_bytes || 0);
        const indexSizeBytes = Number(r.index_size_bytes || 0);
        const totalSizeBytes = Number(r.total_size_bytes || 0);
        return {
          schemaName: String(r.schema_name || "dbo"),
          tableName: String(r.table_name || ""),
          rowCount: Number(r.row_count || 0),
          tableSize: formatBytes(tableSizeBytes),
          tableSizeBytes,
          indexSize: formatBytes(indexSizeBytes),
          indexSizeBytes,
          totalSize: formatBytes(totalSizeBytes),
          totalSizeBytes,
          lastAnalyze: r.last_stats_update ? new Date(String(r.last_stats_update)) : undefined,
        };
      });
    } catch {
      return [];
    }
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    this.ensureConnected();

    try {
      const res = await this.pool!.request().query(INDEX_STATS_SQL);

      // Get columns for each index
      const colRes = await this.pool!.request().query(INDEX_COLUMNS_SQL);

      const colMap = new Map<string, string[]>();
      for (const c of colRes.recordset || []) {
        const key = `${c.schema_name}.${c.table_name}.${c.index_name}`;
        if (!colMap.has(key)) colMap.set(key, []);
        colMap.get(key)!.push(String(c.column_name));
      }

      return (res.recordset || []).map((r: Record<string, unknown>) => {
        const key = `${r.schema_name}.${r.table_name}.${r.index_name}`;
        const idxSizeBytes = Number(r.index_size_bytes || 0);
        return {
          schemaName: String(r.schema_name || "dbo"),
          tableName: String(r.table_name || ""),
          indexName: String(r.index_name || ""),
          indexType: String(r.index_type || ""),
          columns: colMap.get(key) || [],
          isUnique: Boolean(r.is_unique),
          isPrimary: Boolean(r.is_primary_key),
          indexSize: formatBytes(idxSizeBytes),
          indexSizeBytes: idxSizeBytes,
          scans: Number(r.scans || 0),
        };
      });
    } catch {
      return [];
    }
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();

    try {
      const res = await this.pool!.request().query(STORAGE_STATS_SQL);

      return (res.recordset || []).map((r: Record<string, unknown>) => {
        const sizeBytes = Number(r.size_bytes || 0);
        return {
          name: String(r.name || ""),
          location: String(r.location || ""),
          size: formatBytes(sizeBytes),
          sizeBytes,
        };
      });
    } catch {
      return [];
    }
  }
}
