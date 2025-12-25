/**
 * MySQL Database Provider
 * Full MySQL support with connection pooling using mysql2
 */

import mysql, { type Pool, type PoolConnection, type RowDataPacket, type FieldPacket } from 'mysql2/promise';
import { SQLBaseProvider } from './sql-base';
import {
  type DatabaseConnection,
  type TableSchema,
  type QueryResult,
  type HealthInfo,
  type MaintenanceType,
  type MaintenanceResult,
  type ProviderOptions,
  type SlowQuery,
  type ActiveSession,
  type DatabaseOverview,
  type PerformanceMetrics,
  type SlowQueryStats,
  type ActiveSessionDetails,
  type TableStats,
  type IndexStats,
  type StorageStats,
} from '../../types';
import {
  DatabaseConfigError,
  ConnectionError,
  QueryError,
  mapDatabaseError,
} from '../../errors';
import { formatBytes } from '../../utils/pool-manager';

// ============================================================================
// MySQL Provider
// ============================================================================

export class MySQLProvider extends SQLBaseProvider {
  private pool: Pool | null = null;

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    this.validate();
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.connectionString) {
      if (!this.config.host) {
        throw new DatabaseConfigError('Host is required for MySQL', 'mysql');
      }
      if (!this.config.database) {
        throw new DatabaseConfigError('Database name is required for MySQL', 'mysql');
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
      this.pool = mysql.createPool(this.buildPoolConfig());

      const conn = await this.pool.getConnection();
      conn.release();

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw new ConnectionError(
        `Failed to connect to MySQL: ${error instanceof Error ? error.message : error}`,
        'mysql',
        this.config.host,
        this.config.port
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
      ssl: this.shouldEnableSSL() ? { rejectUnauthorized: false } : undefined,
      timezone: this.options.timezone ?? 'Z',
    };
  }

  // ============================================================================
  // Query Execution
  // ============================================================================

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    this.ensureConnected();

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          const [rows, fields] = await this.pool!.execute<RowDataPacket[]>(sql, params);
          return { rows, fields };
        } catch (error) {
          throw mapDatabaseError(error, 'mysql', sql);
        }
      });

      return {
        rows: result.rows as unknown[],
        fields: result.fields?.map((f: FieldPacket) => f.name) ?? [],
        rowCount: Array.isArray(result.rows) ? result.rows.length : 0,
        executionTime,
      };
    });
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    const conn = await this.pool!.getConnection();
    try {
      const [tablesRows] = await conn.execute<RowDataPacket[]>(`
        SELECT
          TABLE_NAME as table_name,
          TABLE_ROWS as row_count,
          DATA_LENGTH + INDEX_LENGTH as total_size
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME ASC;
      `, [this.config.database]);

      const schemas: TableSchema[] = [];

      for (const row of tablesRows) {
        const tableName = row.table_name;
        const rowCount = parseInt(row.row_count || '0');
        const sizeBytes = parseInt(row.total_size || '0');

        const [columnsRows] = await conn.execute<RowDataPacket[]>(`
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
        `, [this.config.database, tableName]);

        const [fkRows] = await conn.execute<RowDataPacket[]>(`
          SELECT
            COLUMN_NAME as column_name,
            REFERENCED_TABLE_NAME as referenced_table,
            REFERENCED_COLUMN_NAME as referenced_column
          FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL;
        `, [this.config.database, tableName]);

        const [indexRows] = await conn.execute<RowDataPacket[]>(`
          SELECT
            INDEX_NAME as index_name,
            GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) as columns,
            NOT NON_UNIQUE as is_unique
          FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = ?
          GROUP BY INDEX_NAME, NON_UNIQUE;
        `, [this.config.database, tableName]);

        schemas.push({
          name: tableName,
          rowCount,
          size: formatBytes(sizeBytes),
          columns: columnsRows.map((col) => ({
            name: col.column_name,
            type: col.data_type,
            nullable: col.is_nullable === 'YES',
            isPrimary: col.column_key === 'PRI',
            defaultValue: col.column_default ?? undefined,
          })),
          indexes: indexRows.map((idx) => ({
            name: idx.index_name,
            columns: idx.columns?.split(',') ?? [],
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
      const [connRows] = await conn.execute<RowDataPacket[]>(
        "SHOW STATUS LIKE 'Threads_connected'"
      );
      const activeConnections = parseInt(connRows[0]?.Value || '0');

      const [sizeRows] = await conn.execute<RowDataPacket[]>(`
        SELECT
          ROUND(SUM(DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) as size_mb
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?;
      `, [this.config.database]);
      const databaseSize = `${sizeRows[0]?.size_mb || 0} MB`;

      const [hitRows] = await conn.execute<RowDataPacket[]>(`
        SELECT
          (1 - (
            (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_reads') /
            NULLIF((SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_read_requests'), 0)
          )) * 100 as hit_ratio;
      `);
      const cacheHitRatio = `${(hitRows[0]?.hit_ratio || 99).toFixed(1)}%`;

      let slowQueries: SlowQuery[] = [];
      try {
        const [slowRows] = await conn.execute<RowDataPacket[]>(`
          SELECT
            LEFT(sql_text, 100) as query,
            count_star as calls,
            CONCAT(ROUND(avg_timer_wait / 1000000000, 2), 'ms') as avgTime
          FROM performance_schema.events_statements_summary_by_digest
          WHERE schema_name = ?
          ORDER BY sum_timer_wait DESC
          LIMIT 5;
        `, [this.config.database]);
        slowQueries = slowRows.map((r) => ({
          query: r.query || '',
          calls: parseInt(r.calls || '0'),
          avgTime: r.avgTime || 'N/A',
        }));
      } catch {
        slowQueries = [{ query: 'Performance schema not available', calls: 0, avgTime: 'N/A' }];
      }

      const [sessionRows] = await conn.execute<RowDataPacket[]>(`
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
      `, [this.config.database]);

      const activeSessions: ActiveSession[] = sessionRows.map((r) => ({
        pid: r.pid,
        user: r.user || 'unknown',
        database: r.database || '',
        state: r.state || 'unknown',
        query: r.query || '',
        duration: r.duration || 'N/A',
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

  public async runMaintenance(
    type: MaintenanceType,
    target?: string
  ): Promise<MaintenanceResult> {
    this.ensureConnected();

    const { result, executionTime } = await this.measureExecution(async () => {
      const conn = await this.pool!.getConnection();
      try {
        let sql = '';

        switch (type) {
          case 'analyze':
            sql = target
              ? `ANALYZE TABLE ${this.escapeIdentifier(target)}`
              : `ANALYZE TABLE ${await this.getAllTablesForMaintenance(conn)}`;
            break;
          case 'optimize':
            sql = target
              ? `OPTIMIZE TABLE ${this.escapeIdentifier(target)}`
              : `OPTIMIZE TABLE ${await this.getAllTablesForMaintenance(conn)}`;
            break;
          case 'check':
            sql = target
              ? `CHECK TABLE ${this.escapeIdentifier(target)}`
              : `CHECK TABLE ${await this.getAllTablesForMaintenance(conn)}`;
            break;
          case 'kill':
            if (!target) {
              throw new QueryError('Target connection ID is required for kill operation', 'mysql');
            }
            const connId = parseInt(target, 10);
            if (isNaN(connId)) {
              throw new QueryError('Invalid connection ID for kill operation', 'mysql');
            }
            sql = `KILL ${connId}`;
            break;
          default:
            throw new QueryError(`Unsupported maintenance type for MySQL: ${type}`, 'mysql');
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
    const [rows] = await conn.execute<RowDataPacket[]>(`
      SELECT TABLE_NAME
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      AND TABLE_TYPE = 'BASE TABLE'
      LIMIT 50;
    `, [this.config.database]);

    return rows.map((r) => this.escapeIdentifier(r.TABLE_NAME)).join(', ');
  }

  // ============================================================================
  // Monitoring Operations
  // ============================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();

    const conn = await this.pool!.getConnection();
    try {
      // Get version
      const [versionRows] = await conn.execute<RowDataPacket[]>('SELECT VERSION() as version');
      const version = versionRows[0]?.version || 'Unknown';

      // Get uptime
      const [uptimeRows] = await conn.execute<RowDataPacket[]>(
        "SHOW STATUS LIKE 'Uptime'"
      );
      const uptimeSeconds = parseInt(uptimeRows[0]?.Value || '0');
      const uptime = this.formatUptimeString(uptimeSeconds);

      // Get active connections
      const [connRows] = await conn.execute<RowDataPacket[]>(
        "SHOW STATUS LIKE 'Threads_connected'"
      );
      const activeConnections = parseInt(connRows[0]?.Value || '0');

      // Get max connections
      const [maxConnRows] = await conn.execute<RowDataPacket[]>(
        "SHOW VARIABLES LIKE 'max_connections'"
      );
      const maxConnections = parseInt(maxConnRows[0]?.Value || '151');

      // Get database size
      const [sizeRows] = await conn.execute<RowDataPacket[]>(`
        SELECT SUM(DATA_LENGTH + INDEX_LENGTH) as size_bytes
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?;
      `, [this.config.database]);
      const databaseSizeBytes = parseInt(sizeRows[0]?.size_bytes || '0');

      // Get table and index count
      const [countRows] = await conn.execute<RowDataPacket[]>(`
        SELECT
          COUNT(DISTINCT TABLE_NAME) as table_count,
          COUNT(DISTINCT INDEX_NAME) as index_count
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ?;
      `, [this.config.database]);

      const [tableCountRows] = await conn.execute<RowDataPacket[]>(`
        SELECT COUNT(*) as cnt FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE';
      `, [this.config.database]);

      return {
        version: `MySQL ${version}`,
        uptime,
        startTime: new Date(Date.now() - uptimeSeconds * 1000),
        activeConnections,
        maxConnections,
        databaseSize: formatBytes(databaseSizeBytes),
        databaseSizeBytes,
        tableCount: parseInt(tableCountRows[0]?.cnt || '0'),
        indexCount: parseInt(countRows[0]?.index_count || '0'),
      };
    } finally {
      conn.release();
    }
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();

    const conn = await this.pool!.getConnection();
    try {
      // Calculate cache hit ratio from InnoDB buffer pool
      const [hitRows] = await conn.execute<RowDataPacket[]>(`
        SELECT
          (1 - (
            (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_reads') /
            NULLIF((SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_read_requests'), 0)
          )) * 100 as hit_ratio;
      `);
      const cacheHitRatio = parseFloat(hitRows[0]?.hit_ratio || '99');

      // Get buffer pool usage
      const [poolRows] = await conn.execute<RowDataPacket[]>(`
        SELECT
          (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_pages_data') as data_pages,
          (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Innodb_buffer_pool_pages_total') as total_pages;
      `);
      const dataPages = parseInt(poolRows[0]?.data_pages || '0');
      const totalPages = parseInt(poolRows[0]?.total_pages || '1');
      const bufferPoolUsage = (dataPages / totalPages) * 100;

      // Get queries per second
      const [qpsRows] = await conn.execute<RowDataPacket[]>(`
        SELECT
          (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Queries') as queries,
          (SELECT VARIABLE_VALUE FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Uptime') as uptime;
      `);
      const queries = parseInt(qpsRows[0]?.queries || '0');
      const uptime = parseInt(qpsRows[0]?.uptime || '1');
      const queriesPerSecond = queries / uptime;

      // Get deadlocks
      const [deadlockRows] = await conn.execute<RowDataPacket[]>(
        "SHOW STATUS LIKE 'Innodb_deadlocks'"
      );
      const deadlocks = parseInt(deadlockRows[0]?.Value || '0');

      return {
        cacheHitRatio: Math.min(100, Math.max(0, cacheHitRatio)),
        queriesPerSecond: Math.round(queriesPerSecond * 100) / 100,
        bufferPoolUsage: Math.round(bufferPoolUsage * 100) / 100,
        deadlocks,
      };
    } catch {
      // Fallback if performance_schema is not available
      return {
        cacheHitRatio: 99,
        queriesPerSecond: 0,
        bufferPoolUsage: 0,
        deadlocks: 0,
      };
    } finally {
      conn.release();
    }
  }

  public async getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 10;

    const conn = await this.pool!.getConnection();
    try {
      const [rows] = await conn.execute<RowDataPacket[]>(`
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
        ORDER BY SUM_TIMER_WAIT DESC
        LIMIT ?;
      `, [this.config.database, limit]);

      return rows.map((r) => ({
        queryId: r.query_id || undefined,
        query: r.query || '',
        calls: parseInt(r.calls || '0'),
        totalTime: parseFloat(r.total_time_ms || '0'),
        avgTime: parseFloat(r.avg_time_ms || '0'),
        minTime: parseFloat(r.min_time_ms || '0'),
        maxTime: parseFloat(r.max_time_ms || '0'),
        rows: parseInt(r.rows_examined || '0'),
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
      const [rows] = await conn.execute<RowDataPacket[]>(`
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
        ORDER BY TIME DESC
        LIMIT ?;
      `, [this.config.database, limit]);

      return rows.map((r) => {
        const durationSeconds = parseInt(r.duration_seconds || '0');
        return {
          pid: r.pid,
          user: r.user || 'unknown',
          database: r.database_name || '',
          clientAddr: r.client_addr?.split(':')[0] || undefined,
          state: r.state || 'unknown',
          query: r.query || '',
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
      const [rows] = await conn.execute<RowDataPacket[]>(`
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
      `, [schema]);

      return rows.map((r) => {
        const tableSizeBytes = parseInt(r.table_size_bytes || '0');
        const indexSizeBytes = parseInt(r.index_size_bytes || '0');
        const totalSizeBytes = parseInt(r.total_size_bytes || '0');
        const freeSpaceBytes = parseInt(r.free_space_bytes || '0');

        // Estimate bloat ratio from free space
        const bloatRatio = totalSizeBytes > 0 ? (freeSpaceBytes / totalSizeBytes) * 100 : 0;

        return {
          schemaName: r.schema_name || schema || '',
          tableName: r.table_name || '',
          rowCount: parseInt(r.row_count || '0'),
          tableSize: formatBytes(tableSizeBytes),
          tableSizeBytes,
          indexSize: formatBytes(indexSizeBytes),
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
      const [rows] = await conn.execute<RowDataPacket[]>(`
        SELECT
          TABLE_SCHEMA as schema_name,
          TABLE_NAME as table_name,
          INDEX_NAME as index_name,
          INDEX_TYPE as index_type,
          GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) as columns,
          NOT NON_UNIQUE as is_unique,
          INDEX_NAME = 'PRIMARY' as is_primary,
          CARDINALITY as cardinality
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ?
        GROUP BY TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, INDEX_TYPE, NON_UNIQUE
        ORDER BY TABLE_NAME, INDEX_NAME
        LIMIT 200;
      `, [schema]);

      // Get index sizes from INNODB_SYS_INDEXES if available
      const indexSizes: Record<string, number> = {};
      try {
        const [sizeRows] = await conn.execute<RowDataPacket[]>(`
          SELECT
            CONCAT(t.NAME) as full_name,
            SUM(s.INDEX_SIZE * @@innodb_page_size) as size_bytes
          FROM information_schema.INNODB_INDEXES i
          JOIN information_schema.INNODB_TABLES t ON i.TABLE_ID = t.TABLE_ID
          JOIN information_schema.INNODB_TABLESPACES s ON t.SPACE = s.SPACE
          WHERE t.NAME LIKE ?
          GROUP BY t.NAME, i.NAME;
        `, [`${schema}/%`]);

        for (const row of sizeRows) {
          indexSizes[row.full_name] = parseInt(row.size_bytes || '0');
        }
      } catch {
        // INNODB_SYS tables not available
      }

      return rows.map((r) => {
        const indexKey = `${r.schema_name}/${r.table_name}`;
        const indexSizeBytes = indexSizes[indexKey] || 0;

        return {
          schemaName: r.schema_name || schema || '',
          tableName: r.table_name || '',
          indexName: r.index_name || '',
          indexType: r.index_type || 'BTREE',
          columns: r.columns?.split(',') || [],
          isUnique: Boolean(r.is_unique),
          isPrimary: Boolean(r.is_primary),
          indexSize: formatBytes(indexSizeBytes),
          indexSizeBytes,
          scans: parseInt(r.cardinality || '0'),
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
      const [dbRows] = await conn.execute<RowDataPacket[]>(`
        SELECT
          TABLE_SCHEMA as name,
          SUM(DATA_LENGTH + INDEX_LENGTH) as size_bytes
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        GROUP BY TABLE_SCHEMA;
      `, [this.config.database]);

      if (dbRows.length > 0) {
        const sizeBytes = parseInt(dbRows[0].size_bytes || '0');
        stats.push({
          name: 'Data',
          location: this.config.database || 'default',
          size: formatBytes(sizeBytes),
          sizeBytes,
        });
      }

      // Get binary log size if available
      try {
        const [binlogRows] = await conn.execute<RowDataPacket[]>('SHOW BINARY LOGS');
        const binlogSize = binlogRows.reduce((sum, r) => sum + parseInt(r.File_size || '0'), 0);
        if (binlogSize > 0) {
          stats.push({
            name: 'Binary Logs',
            size: formatBytes(binlogSize),
            sizeBytes: binlogSize,
          });
        }
      } catch {
        // Binary logging not enabled
      }

      // Get InnoDB data file size
      try {
        const [innodbRows] = await conn.execute<RowDataPacket[]>(
          "SHOW VARIABLES LIKE 'innodb_data_file_path'"
        );
        if (innodbRows.length > 0) {
          stats.push({
            name: 'InnoDB',
            location: innodbRows[0].Value || 'ibdata1',
            size: 'N/A',
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
