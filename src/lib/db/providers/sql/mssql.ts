/**
 * Microsoft SQL Server Database Provider
 * Full MSSQL support with connection pooling (SQL Authentication)
 */

import mssql from 'mssql';
import { SQLBaseProvider } from './sql-base';
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
} from '../../types';
import {
  DatabaseConfigError,
  ConnectionError,
  QueryError,
  mapDatabaseError,
} from '../../errors';
import { formatBytes } from '../../utils/pool-manager';
import {
  analyzeQuery,
  DEFAULT_QUERY_LIMIT,
  MAX_UNLIMITED_ROWS,
} from '../../utils/query-limiter';

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
      supportsExplain: true,
      supportsConnectionString: true,
      maintenanceOperations: ['analyze', 'check', 'optimize', 'kill'],
    };
  }

  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      analyzeAction: 'Update Statistics',
      vacuumAction: 'Rebuild Indexes',
      analyzeGlobalLabel: 'Update Stats',
      analyzeGlobalTitle: 'Update Statistics',
      analyzeGlobalDesc: 'Updates query optimizer statistics for all tables to improve query performance.',
      vacuumGlobalLabel: 'Rebuild Indexes',
      vacuumGlobalTitle: 'Rebuild All Indexes',
      vacuumGlobalDesc: 'Rebuilds all indexes to reclaim space and reduce fragmentation.',
    };
  }

  // ============================================================================
  // SQL Dialect Overrides
  // ============================================================================

  protected override escapeIdentifier(identifier: string): string {
    const escaped = identifier.replace(/\]/g, ']]');
    return `[${escaped}]`;
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.connectionString) {
      if (!this.config.host) {
        throw new DatabaseConfigError('Host is required for SQL Server', 'mssql');
      }
      if (!this.config.database) {
        throw new DatabaseConfigError('Database name is required for SQL Server', 'mssql');
      }
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  private buildConfig(): mssql.config {
    const host = this.config.host || 'localhost';
    const port = this.config.port || 1433;
    const isAzure = host.includes('.database.windows.net');

    const sslConfig = this.config.ssl;
    // SQL Server 2022+ enforces encryption by default; always encrypt and trust self-signed certs for non-Azure
    let encrypt = true;
    let trustServerCertificate = !isAzure;

    if (sslConfig) {
      if (sslConfig.mode === 'disable') {
        encrypt = false;
      } else {
        encrypt = true;
        trustServerCertificate = sslConfig.mode === 'require';
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
      await this.pool.connect();

      // Test the connection
      await this.pool.request().query('SELECT 1 AS test');

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw new ConnectionError(
        `Failed to connect to SQL Server: ${error instanceof Error ? error.message : error}`,
        'mssql',
        this.config.host,
        this.config.port
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
          throw mapDatabaseError(error, 'mssql', sql);
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
      console.error('[MSSQL] Failed to cancel query:', error);
      return false;
    }
  }

  // ============================================================================
  // Query Preparation (MSSQL TOP / OFFSET FETCH)
  // ============================================================================

  public override prepareQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
    const { limit = DEFAULT_QUERY_LIMIT, offset = 0, unlimited = false } = options;
    const effectiveLimit = unlimited ? MAX_UNLIMITED_ROWS : limit;
    const queryInfo = analyzeQuery(query);

    if (queryInfo.type === 'SELECT' && !queryInfo.hasLimit) {
      let modifiedSql = query.trim();
      const hasSemicolon = modifiedSql.endsWith(';');
      if (hasSemicolon) modifiedSql = modifiedSql.slice(0, -1).trim();

      if (offset > 0) {
        // OFFSET FETCH requires ORDER BY
        const hasOrderBy = /\bORDER\s+BY\b/i.test(modifiedSql);
        if (!hasOrderBy) {
          modifiedSql = `${modifiedSql} ORDER BY (SELECT NULL)`;
        }
        modifiedSql = `${modifiedSql} OFFSET ${offset} ROWS FETCH NEXT ${effectiveLimit} ROWS ONLY`;
      } else {
        // Inject TOP N after SELECT
        modifiedSql = modifiedSql.replace(
          /^(\s*SELECT\s+)(DISTINCT\s+)?/i,
          `$1$2TOP ${effectiveLimit} `
        );
      }

      if (hasSemicolon) modifiedSql += ';';

      return {
        query: modifiedSql,
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
    if (this.txActive) throw new QueryError('Transaction already active', 'mssql');
    this.txTransaction = new mssql.Transaction(this.pool!);
    await this.txTransaction.begin();
    this.txActive = true;
  }

  public async commitTransaction(): Promise<void> {
    if (!this.txTransaction || !this.txActive) throw new QueryError('No active transaction', 'mssql');
    try {
      await this.txTransaction.commit();
    } finally {
      this.txTransaction = null;
      this.txActive = false;
    }
  }

  public async rollbackTransaction(): Promise<void> {
    if (!this.txTransaction || !this.txActive) throw new QueryError('No active transaction', 'mssql');
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
    if (!this.txTransaction || !this.txActive) throw new QueryError('No active transaction', 'mssql');

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
          throw mapDatabaseError(error, 'mssql', sql);
        }
      });

      const recordset = result.recordset || [];
      const fields = recordset.length > 0 ? Object.keys(recordset[0]) : [];

      return {
        rows: recordset as Record<string, unknown>[],
        fields,
        rowCount: result.rowsAffected?.[0] ?? recordset.length,
        executionTime,
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
      const tablesRes = await this.pool!.request().query(`
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
      `);
      const tables = tablesRes.recordset || [];

      // Get columns
      const colsRes = await this.pool!.request().query(`
        SELECT
          TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE,
          IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION
        FROM INFORMATION_SCHEMA.COLUMNS
        ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
      `);
      const allCols = colsRes.recordset || [];

      // Get primary keys
      const pkRes = await this.pool!.request().query(`
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
      `);
      const pkMap = new Map<string, Set<string>>();
      for (const row of pkRes.recordset || []) {
        const key = `${row.schema_name}.${row.table_name}`;
        if (!pkMap.has(key)) pkMap.set(key, new Set());
        pkMap.get(key)!.add(row.column_name);
      }

      // Get foreign keys
      const fkRes = await this.pool!.request().query(`
        SELECT
          OBJECT_SCHEMA_NAME(fk.parent_object_id) AS schema_name,
          OBJECT_NAME(fk.parent_object_id) AS table_name,
          COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS column_name,
          OBJECT_NAME(fk.referenced_object_id) AS ref_table,
          COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS ref_column
        FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
      `);
      const fksByTable = new Map<string, Array<{ columnName: string; referencedTable: string; referencedColumn: string }>>();
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
      const idxRes = await this.pool!.request().query(`
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
      `);

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
        const schemaName = String(t.schema_name || 'dbo');
        const tableName = String(t.table_name || '');
        const key = `${schemaName}.${tableName}`;
        const displayName = schemaName === 'dbo' ? tableName : `${schemaName}.${tableName}`;
        const pks = pkMap.get(key) || new Set();

        const columns = (colsByTable.get(key) || []).map((c: Record<string, unknown>) => ({
          name: String(c.COLUMN_NAME || ''),
          type: String(c.DATA_TYPE || ''),
          nullable: String(c.IS_NULLABLE || '') === 'YES',
          isPrimary: pks.has(String(c.COLUMN_NAME || '')),
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
      throw mapDatabaseError(error, 'mssql');
    }
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    try {
      let activeConnections = 0;
      let databaseSize = 'N/A';
      let cacheHitRatio = 'N/A';
      const slowQueries: SlowQuery[] = [];
      const activeSessions: ActiveSession[] = [];

      // Active connections
      try {
        const connRes = await this.pool!.request().query(
          `SELECT COUNT(*) AS cnt FROM sys.dm_exec_sessions WHERE is_user_process = 1`
        );
        activeConnections = connRes.recordset[0]?.cnt || 0;
      } catch { /* DMV may require permissions */ }

      // Database size
      try {
        const sizeRes = await this.pool!.request().query(`
          SELECT
            CAST(SUM(size) * 8.0 / 1024 AS DECIMAL(10,2)) AS size_mb
          FROM sys.database_files
        `);
        const mb = Number(sizeRes.recordset[0]?.size_mb || 0);
        databaseSize = mb > 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb} MB`;
      } catch { /* ignore */ }

      // Cache hit ratio
      try {
        const cacheRes = await this.pool!.request().query(`
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
        `);
        cacheHitRatio = `${cacheRes.recordset[0]?.hit_ratio || 0}%`;
      } catch { /* ignore */ }

      // Slow queries
      try {
        const slowRes = await this.pool!.request().query(`
          SELECT TOP 5
            SUBSTRING(qt.text, 1, 100) AS query,
            qs.execution_count AS calls,
            CAST(qs.total_elapsed_time / NULLIF(qs.execution_count, 0) / 1000.0 AS DECIMAL(10,2)) AS avg_time_ms
          FROM sys.dm_exec_query_stats qs
          CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) qt
          WHERE qs.execution_count > 0
          ORDER BY qs.total_elapsed_time DESC
        `);
        for (const row of slowRes.recordset || []) {
          slowQueries.push({
            query: String(row.query || ''),
            calls: Number(row.calls || 0),
            avgTime: `${row.avg_time_ms}ms`,
          });
        }
      } catch { /* DMV permissions */ }

      // Active sessions
      try {
        const sessRes = await this.pool!.request().query(`
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
        `);
        for (const row of sessRes.recordset || []) {
          activeSessions.push({
            pid: Number(row.pid || 0),
            user: String(row.user || 'unknown'),
            database: String(row.database || ''),
            state: String(row.state || 'unknown'),
            query: String(row.query || ''),
            duration: String(row.duration || 'N/A'),
          });
        }
      } catch { /* ignore */ }

      return { activeConnections, databaseSize, cacheHitRatio, slowQueries, activeSessions };
    } catch (error) {
      throw mapDatabaseError(error, 'mssql');
    }
  }

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  public async runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult> {
    this.ensureConnected();

    const { result, executionTime } = await this.measureExecution(async () => {
      try {
        let sql = '';

        switch (type) {
          case 'analyze':
            if (target) {
              sql = `UPDATE STATISTICS [${target.replace(/\]/g, ']]')}]`;
            } else {
              sql = `EXEC sp_updatestats`;
            }
            break;
          case 'check':
            sql = `DBCC CHECKDB WITH NO_INFOMSGS`;
            break;
          case 'optimize':
            if (target) {
              sql = `ALTER INDEX ALL ON [${target.replace(/\]/g, ']]')}] REBUILD`;
            } else {
              // Rebuild all indexes on all tables
              sql = `
                DECLARE @sql NVARCHAR(MAX) = '';
                SELECT @sql = @sql + 'ALTER INDEX ALL ON [' + s.name + '].[' + t.name + '] REBUILD;'
                FROM sys.tables t
                JOIN sys.schemas s ON t.schema_id = s.schema_id
                WHERE t.type = 'U';
                EXEC sp_executesql @sql;
              `;
            }
            break;
          case 'kill':
            if (!target) {
              throw new QueryError('Target SPID is required for kill operation', 'mssql');
            }
            const spid = parseInt(target, 10);
            if (isNaN(spid)) {
              throw new QueryError('Invalid SPID for kill operation', 'mssql');
            }
            sql = `KILL ${spid}`;
            break;
          default:
            throw new QueryError(`Unsupported maintenance type: ${type}`, 'mssql');
        }

        await this.pool!.request().query(sql);
        return { success: true };
      } catch (error) {
        throw mapDatabaseError(error, 'mssql');
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
      let version = 'SQL Server';
      let uptime = 'N/A';
      let startTime: Date | undefined;
      let activeConnections = 0;
      let maxConnections = 0;
      let databaseSize = '0 bytes';
      let databaseSizeBytes = 0;
      let tableCount = 0;
      let indexCount = 0;

      // Version
      try {
        const vRes = await this.pool!.request().query(`SELECT @@VERSION AS version`);
        version = String(vRes.recordset[0]?.version || '').split('\n')[0];
      } catch { /* ignore */ }

      // Uptime
      try {
        const upRes = await this.pool!.request().query(`
          SELECT sqlserver_start_time,
                 DATEDIFF(SECOND, sqlserver_start_time, GETDATE()) AS uptime_seconds
          FROM sys.dm_os_sys_info
        `);
        if (upRes.recordset[0]) {
          const secs = Number(upRes.recordset[0].uptime_seconds || 0);
          const days = Math.floor(secs / 86400);
          const hours = Math.floor((secs % 86400) / 3600);
          const minutes = Math.floor((secs % 3600) / 60);
          uptime = days > 0 ? `${days}d ${hours}h ${minutes}m` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
          startTime = new Date(upRes.recordset[0].sqlserver_start_time);
        }
      } catch { /* ignore */ }

      // Connections
      try {
        const connRes = await this.pool!.request().query(`
          SELECT
            COUNT(*) AS active_connections,
            (SELECT CAST(value_in_use AS INT) FROM sys.configurations WHERE name = 'user connections') AS max_connections
          FROM sys.dm_exec_sessions
          WHERE is_user_process = 1
        `);
        activeConnections = Number(connRes.recordset[0]?.active_connections || 0);
        maxConnections = Number(connRes.recordset[0]?.max_connections || 32767);
        if (maxConnections === 0) maxConnections = 32767; // 0 means unlimited
      } catch { /* ignore */ }

      // Database size
      try {
        const sizeRes = await this.pool!.request().query(`
          SELECT SUM(CAST(size AS BIGINT)) * 8 * 1024 AS size_bytes FROM sys.database_files
        `);
        databaseSizeBytes = Number(sizeRes.recordset[0]?.size_bytes || 0);
        databaseSize = formatBytes(databaseSizeBytes);
      } catch { /* ignore */ }

      // Table/index counts
      try {
        const cntRes = await this.pool!.request().query(`
          SELECT
            (SELECT COUNT(*) FROM sys.tables WHERE type = 'U') AS table_count,
            (SELECT COUNT(*) FROM sys.indexes WHERE object_id IN (SELECT object_id FROM sys.tables WHERE type = 'U') AND name IS NOT NULL) AS index_count
        `);
        tableCount = Number(cntRes.recordset[0]?.table_count || 0);
        indexCount = Number(cntRes.recordset[0]?.index_count || 0);
      } catch { /* ignore */ }

      return {
        version, uptime, startTime, activeConnections, maxConnections,
        databaseSize, databaseSizeBytes, tableCount, indexCount,
      };
    } catch (error) {
      throw mapDatabaseError(error, 'mssql');
    }
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();

    try {
      let cacheHitRatio = 100;
      let bufferPoolUsage: number | undefined;

      try {
        const cacheRes = await this.pool!.request().query(`
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
        `);
        cacheHitRatio = Number(cacheRes.recordset[0]?.hit_ratio || 100);
        bufferPoolUsage = cacheHitRatio;
      } catch { /* ignore */ }

      return {
        cacheHitRatio,
        bufferPoolUsage,
      };
    } catch (error) {
      throw mapDatabaseError(error, 'mssql');
    }
  }

  public async getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 10;

    try {
      const res = await this.pool!.request().query(`
        SELECT TOP ${limit}
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
      `);

      return (res.recordset || []).map((r: Record<string, unknown>) => ({
        queryId: String(r.query_id || ''),
        query: String(r.query || ''),
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
      const res = await this.pool!.request().query(`
        SELECT TOP ${limit}
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
      `);

      return (res.recordset || []).map((r: Record<string, unknown>) => ({
        pid: Number(r.pid || 0),
        user: String(r.user || 'unknown'),
        database: String(r.database || ''),
        applicationName: r.application_name ? String(r.application_name) : undefined,
        clientAddr: r.client_addr ? String(r.client_addr) : undefined,
        state: String(r.state || 'unknown'),
        query: String(r.query || ''),
        queryStart: r.query_start ? new Date(String(r.query_start)) : undefined,
        duration: String(r.duration || 'N/A'),
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
      const res = await this.pool!.request().query(`
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
      `);

      return (res.recordset || []).map((r: Record<string, unknown>) => {
        const tableSizeBytes = Number(r.table_size_bytes || 0);
        const indexSizeBytes = Number(r.index_size_bytes || 0);
        const totalSizeBytes = Number(r.total_size_bytes || 0);
        return {
          schemaName: String(r.schema_name || 'dbo'),
          tableName: String(r.table_name || ''),
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
      const res = await this.pool!.request().query(`
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
      `);

      // Get columns for each index
      const colRes = await this.pool!.request().query(`
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
      `);

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
          schemaName: String(r.schema_name || 'dbo'),
          tableName: String(r.table_name || ''),
          indexName: String(r.index_name || ''),
          indexType: String(r.index_type || ''),
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
      const res = await this.pool!.request().query(`
        SELECT
          name,
          physical_name AS location,
          CAST(size AS BIGINT) * 8 * 1024 AS size_bytes,
          type_desc
        FROM sys.database_files
        ORDER BY size DESC
      `);

      return (res.recordset || []).map((r: Record<string, unknown>) => {
        const sizeBytes = Number(r.size_bytes || 0);
        return {
          name: String(r.name || ''),
          location: String(r.location || ''),
          size: formatBytes(sizeBytes),
          sizeBytes,
        };
      });
    } catch {
      return [];
    }
  }
}
