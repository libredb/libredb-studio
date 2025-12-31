/**
 * PostgreSQL Database Provider
 * Full PostgreSQL support with connection pooling
 */

import { Pool, type PoolConfig as PgPoolConfig } from 'pg';
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
// Type Definitions
// ============================================================================

interface PgStatActivityRow {
  datname?: string;
  pid?: number;
  usename?: string;
  application_name?: string;
  client_addr?: string;
  backend_start?: string | Date;
  state?: string;
  query?: string;
  [key: string]: unknown;
}

// ============================================================================
// PostgreSQL Provider
// ============================================================================

export class PostgresProvider extends SQLBaseProvider {
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
        throw new DatabaseConfigError('Host is required for PostgreSQL', 'postgres');
      }
      if (!this.config.database) {
        throw new DatabaseConfigError('Database name is required for PostgreSQL', 'postgres');
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
      const poolConfig = this.buildPoolConfig();
      this.pool = new Pool(poolConfig);

      const client = await this.pool.connect();
      client.release();

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw new ConnectionError(
        `Failed to connect to PostgreSQL: ${error instanceof Error ? error.message : error}`,
        'postgres',
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

  private buildPoolConfig(): PgPoolConfig {
    const needsSSL = this.shouldEnableSSL();

    const sslConfig = needsSSL
      ? { rejectUnauthorized: false }
      : this.options.ssl === false
        ? false
        : undefined;

    const baseConfig: PgPoolConfig = {
      min: this.poolConfig.min,
      max: this.poolConfig.max,
      idleTimeoutMillis: this.poolConfig.idleTimeout,
      connectionTimeoutMillis: this.poolConfig.acquireTimeout,
      statement_timeout: this.queryTimeout,
      ssl: sslConfig,
    };

    if (this.config.connectionString) {
      return {
        ...baseConfig,
        connectionString: this.config.connectionString,
      };
    }

    return {
      ...baseConfig,
      host: this.config.host,
      port: this.config.port ?? 5432,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
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
          const client = await this.pool!.connect();
          try {
            const res = await client.query(sql, params);
            return res;
          } finally {
            client.release();
          }
        } catch (error) {
          throw mapDatabaseError(error, 'postgres', sql);
        }
      });

      return {
        rows: result.rows,
        fields: result.fields?.map((f) => f.name) ?? [],
        rowCount: result.rowCount ?? 0,
        executionTime,
      };
    });
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    const client = await this.pool!.connect();
    try {
      // Optimized single query to fetch all schema information
      // This replaces the N+1 pattern (1 + N*4 queries) with a single query
      const result = await client.query(`
        WITH tables_info AS (
          SELECT
            t.table_schema,
            t.table_name,
            COALESCE(c.reltuples::bigint, 0) as row_count,
            COALESCE(pg_total_relation_size(c.oid), 0) as total_size
          FROM information_schema.tables t
          LEFT JOIN pg_class c ON c.oid = (quote_ident(t.table_schema) || '.' || quote_ident(t.table_name))::regclass
          WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND t.table_type = 'BASE TABLE'
        ),
        columns_info AS (
          SELECT
            c.table_schema,
            c.table_name,
            json_agg(
              json_build_object(
                'name', c.column_name,
                'type', c.data_type,
                'nullable', c.is_nullable = 'YES',
                'defaultValue', c.column_default
              ) ORDER BY c.ordinal_position
            ) FILTER (WHERE c.ordinal_position <= 100) as columns
          FROM information_schema.columns c
          WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          GROUP BY c.table_schema, c.table_name
        ),
        pk_info AS (
          SELECT
            tc.table_schema,
            tc.table_name,
            array_agg(kcu.column_name) as pk_columns
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
          GROUP BY tc.table_schema, tc.table_name
        ),
        fk_info AS (
          SELECT
            tc.table_schema,
            tc.table_name,
            json_agg(
              json_build_object(
                'columnName', kcu.column_name,
                'referencedSchema', ccu.table_schema,
                'referencedTable', ccu.table_name,
                'referencedColumn', ccu.column_name
              )
            ) as foreign_keys
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
            AND ccu.table_schema = tc.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
          GROUP BY tc.table_schema, tc.table_name
        ),
        index_info AS (
          SELECT
            n.nspname as table_schema,
            t.relname as table_name,
            json_agg(
              json_build_object(
                'name', i.relname,
                'columns', (
                  SELECT array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum))
                  FROM pg_attribute a
                  WHERE a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
                ),
                'unique', ix.indisunique
              )
            ) as indexes
          FROM pg_index ix
          JOIN pg_class t ON t.oid = ix.indrelid
          JOIN pg_class i ON i.oid = ix.indexrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          GROUP BY n.nspname, t.relname
        )
        SELECT
          ti.table_schema,
          ti.table_name,
          ti.row_count,
          ti.total_size,
          COALESCE(ci.columns, '[]'::json) as columns,
          COALESCE(pk.pk_columns, ARRAY[]::text[]) as pk_columns,
          COALESCE(fk.foreign_keys, '[]'::json) as foreign_keys,
          COALESCE(ii.indexes, '[]'::json) as indexes
        FROM tables_info ti
        LEFT JOIN columns_info ci ON ci.table_schema = ti.table_schema AND ci.table_name = ti.table_name
        LEFT JOIN pk_info pk ON pk.table_schema = ti.table_schema AND pk.table_name = ti.table_name
        LEFT JOIN fk_info fk ON fk.table_schema = ti.table_schema AND fk.table_name = ti.table_name
        LEFT JOIN index_info ii ON ii.table_schema = ti.table_schema AND ii.table_name = ti.table_name
        ORDER BY ti.table_schema, ti.table_name ASC;
      `);

      interface SchemaRow {
        table_schema: string;
        table_name: string;
        row_count: string;
        total_size: string;
        pk_columns: string[];
        columns?: Array<{
          name: string;
          type: string;
          nullable: boolean;
          defaultValue?: string | null;
        }>;
        indexes?: Array<{
          name: string;
          columns: string[];
          unique: boolean;
        }>;
        foreign_keys?: Array<{
          columnName: string;
          referencedSchema: string;
          referencedTable: string;
          referencedColumn: string;
        }>;
      }

      return result.rows.map((row: SchemaRow) => {
        const schemaName = row.table_schema;
        const tableName = row.table_name;
        const displayName = schemaName === 'public' ? tableName : `${schemaName}.${tableName}`;
        const rowCount = Math.max(0, parseInt(row.row_count || '0'));
        const sizeBytes = parseInt(row.total_size || '0');
        const pkColumns: string[] = row.pk_columns || [];

        // Parse columns and add isPrimary flag
        const columns = (row.columns || []).map((col) => ({
          name: col.name,
          type: col.type,
          nullable: col.nullable,
          isPrimary: pkColumns.includes(col.name),
          defaultValue: col.defaultValue ?? undefined,
        }));

        // Parse indexes
        const indexes = (row.indexes || []).map((idx) => ({
          name: idx.name,
          columns: Array.isArray(idx.columns) ? idx.columns : [],
          unique: idx.unique,
        }));

        // Parse foreign keys
        const foreignKeys = (row.foreign_keys || []).map((fk) => ({
          columnName: fk.columnName,
          referencedTable: fk.referencedSchema === 'public'
            ? fk.referencedTable
            : `${fk.referencedSchema}.${fk.referencedTable}`,
          referencedColumn: fk.referencedColumn,
        }));

        return {
          name: displayName,
          rowCount,
          size: formatBytes(sizeBytes),
          columns,
          indexes,
          foreignKeys,
        };
      });
    } finally {
      client.release();
    }
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    const client = await this.pool!.connect();
    try {
      const connRes = await client.query('SELECT count(*) FROM pg_stat_activity');

      const sizeRes = await client.query('SELECT pg_size_pretty(pg_database_size($1))', [
        this.config.database,
      ]);

      const cacheRes = await client.query(`
        SELECT
          sum(heap_blks_read) as heap_read,
          sum(heap_blks_hit)  as heap_hit,
          COALESCE(
            ROUND((sum(heap_blks_hit) * 100.0 / NULLIF(sum(heap_blks_hit) + sum(heap_blks_read), 0)), 1),
            100
          ) as ratio
        FROM pg_statio_user_tables;
      `);

      let slowQueries: SlowQuery[] = [];
      try {
        const slowRes = await client.query(`
          SELECT
            LEFT(query, 100) as query,
            calls,
            ROUND((mean_exec_time)::numeric, 2)::text || 'ms' as avgTime
          FROM pg_stat_statements
          WHERE calls > 0
          ORDER BY total_exec_time DESC
          LIMIT 5;
        `);
        slowQueries = slowRes.rows.map((r) => ({
          query: r.query,
          calls: r.calls,
          avgTime: r.avgtime,
        }));
      } catch {
        slowQueries = [
          { query: 'pg_stat_statements extension not enabled', calls: 0, avgTime: 'N/A' },
        ];
      }

      const sessionsRes = await client.query(`
        SELECT
          pid,
          usename as user,
          datname as database,
          COALESCE(state, 'unknown') as state,
          LEFT(COALESCE(query, ''), 100) as query,
          CASE
            WHEN xact_start IS NOT NULL THEN
              EXTRACT(EPOCH FROM (NOW() - xact_start))::text || 's'
            ELSE 'N/A'
          END as duration
        FROM pg_stat_activity
        WHERE datname = $1
        AND pid != pg_backend_pid()
        ORDER BY xact_start DESC NULLS LAST
        LIMIT 10;
      `, [this.config.database]);

      const activeSessions: ActiveSession[] = sessionsRes.rows.map((r) => ({
        pid: r.pid,
        user: r.user || 'unknown',
        database: r.database || '',
        state: r.state,
        query: r.query || '',
        duration: r.duration,
      }));

      return {
        activeConnections: parseInt(connRes.rows[0].count),
        databaseSize: sizeRes.rows[0].pg_size_pretty,
        cacheHitRatio: `${cacheRes.rows[0].ratio}%`,
        slowQueries,
        activeSessions,
      };
    } finally {
      client.release();
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
      const client = await this.pool!.connect();
      try {
        let sql = '';

        switch (type) {
          case 'vacuum':
            sql = target
              ? `VACUUM ANALYZE public.${this.escapeIdentifier(target)}`
              : 'VACUUM ANALYZE';
            break;
          case 'analyze':
            sql = target
              ? `ANALYZE public.${this.escapeIdentifier(target)}`
              : 'ANALYZE';
            break;
          case 'reindex':
            sql = target
              ? `REINDEX TABLE public.${this.escapeIdentifier(target)}`
              : `REINDEX DATABASE ${this.escapeIdentifier(this.config.database || '')}`;
            break;
          case 'kill':
            if (!target) {
              throw new QueryError('Target PID is required for kill operation', 'postgres');
            }
            const pid = parseInt(target, 10);
            if (isNaN(pid)) {
              throw new QueryError('Invalid PID for kill operation', 'postgres');
            }
            sql = `SELECT pg_terminate_backend(${pid})`;
            break;
          default:
            throw new QueryError(`Unsupported maintenance type: ${type}`, 'postgres');
        }

        await client.query(sql);
        return { success: true };
      } finally {
        client.release();
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
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      active: this.pool.totalCount - this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  // ============================================================================
  // Extended Monitoring Methods
  // ============================================================================

  /**
   * Get database overview metrics
   */
  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();

    const client = await this.pool!.connect();
    try {
      // Get version and uptime
      const infoRes = await client.query(`
        SELECT
          version() as version,
          pg_postmaster_start_time() as start_time,
          EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint as uptime_seconds
      `);

      // Get connection counts
      const connRes = await client.query(`
        SELECT
          count(*) as active_connections,
          (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') as max_connections
        FROM pg_stat_activity
        WHERE datname = $1
      `, [this.config.database]);

      // Get database size
      const sizeRes = await client.query(`
        SELECT
          pg_size_pretty(pg_database_size($1)) as database_size,
          pg_database_size($1) as database_size_bytes
      `, [this.config.database]);

      // Get table and index counts (all user schemas)
      const countRes = await client.query(`
        SELECT
          (SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')) as table_count,
          (SELECT count(*) FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')) as index_count
      `);

      const uptimeSeconds = parseInt(infoRes.rows[0].uptime_seconds || '0');
      const days = Math.floor(uptimeSeconds / 86400);
      const hours = Math.floor((uptimeSeconds % 86400) / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const uptime = days > 0
        ? `${days}d ${hours}h ${minutes}m`
        : hours > 0
          ? `${hours}h ${minutes}m`
          : `${minutes}m`;

      return {
        version: infoRes.rows[0].version?.split(',')[0] || 'PostgreSQL',
        uptime,
        startTime: infoRes.rows[0].start_time ? new Date(infoRes.rows[0].start_time) : undefined,
        activeConnections: parseInt(connRes.rows[0].active_connections || '0'),
        maxConnections: parseInt(connRes.rows[0].max_connections || '100'),
        databaseSize: sizeRes.rows[0].database_size || '0 bytes',
        databaseSizeBytes: parseInt(sizeRes.rows[0].database_size_bytes || '0'),
        tableCount: parseInt(countRes.rows[0].table_count || '0'),
        indexCount: parseInt(countRes.rows[0].index_count || '0'),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get performance metrics
   */
  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();

    const client = await this.pool!.connect();
    try {
      // Get cache hit ratio
      const cacheRes = await client.query(`
        SELECT
          COALESCE(
            ROUND(sum(heap_blks_hit) * 100.0 / NULLIF(sum(heap_blks_hit) + sum(heap_blks_read), 0), 2),
            100
          ) as cache_hit_ratio
        FROM pg_statio_user_tables
      `);

      // Get transaction stats
      const txRes = await client.query(`
        SELECT
          xact_commit,
          xact_rollback,
          deadlocks,
          blks_read,
          blks_hit
        FROM pg_stat_database
        WHERE datname = $1
      `, [this.config.database]);

      // Get checkpoint stats (optional - columns may not exist in older PG versions)
      let checkpointWriteTime = '0';
      try {
        const checkpointRes = await client.query(`
          SELECT
            checkpoint_write_time,
            checkpoint_sync_time
          FROM pg_stat_bgwriter
        `);
        const checkpointRow = checkpointRes.rows[0] || {};
        const writeTime = parseFloat(checkpointRow.checkpoint_write_time || '0');
        const syncTime = parseFloat(checkpointRow.checkpoint_sync_time || '0');
        checkpointWriteTime = `${((writeTime + syncTime) / 1000).toFixed(1)}s`;
      } catch {
        // checkpoint_write_time doesn't exist in older PostgreSQL versions
        checkpointWriteTime = 'N/A';
      }

      const txRow = txRes.rows[0] || {};
      const blksHit = parseInt(txRow.blks_hit || '0');
      const blksRead = parseInt(txRow.blks_read || '0');
      const bufferPoolUsage = blksHit + blksRead > 0
        ? Math.round((blksHit / (blksHit + blksRead)) * 100)
        : 100;

      return {
        cacheHitRatio: parseFloat(cacheRes.rows[0].cache_hit_ratio || '100'),
        transactionsPerSecond: undefined, // Would need time-based sampling
        queriesPerSecond: undefined, // Would need time-based sampling
        bufferPoolUsage,
        deadlocks: parseInt(txRow.deadlocks || '0'),
        checkpointWriteTime,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get slow query statistics from pg_stat_statements
   */
  public async getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 10;

    const client = await this.pool!.connect();
    try {
      // Try pg_stat_statements first (requires extension)
      try {
        const res = await client.query(`
          SELECT
            queryid::text as query_id,
            LEFT(query, 500) as query,
            calls,
            ROUND(total_exec_time::numeric, 2) as total_time,
            ROUND(mean_exec_time::numeric, 2) as avg_time,
            ROUND(min_exec_time::numeric, 2) as min_time,
            ROUND(max_exec_time::numeric, 2) as max_time,
            rows,
            shared_blks_hit,
            shared_blks_read
          FROM pg_stat_statements
          WHERE calls > 0
            AND dbid = (SELECT oid FROM pg_database WHERE datname = $1)
          ORDER BY total_exec_time DESC
          LIMIT $2
        `, [this.config.database, limit]);

        return res.rows.map((r) => ({
          queryId: r.query_id,
          query: r.query || '',
          calls: parseInt(r.calls || '0'),
          totalTime: parseFloat(r.total_time || '0'),
          avgTime: parseFloat(r.avg_time || '0'),
          minTime: parseFloat(r.min_time || '0'),
          maxTime: parseFloat(r.max_time || '0'),
          rows: parseInt(r.rows || '0'),
          sharedBlksHit: parseInt(r.shared_blks_hit || '0'),
          sharedBlksRead: parseInt(r.shared_blks_read || '0'),
        }));
      } catch {
        // Fallback: use pg_stat_activity for currently running queries
        // This doesn't provide historical stats, but shows active queries
        const fallbackRes = await client.query(`
          SELECT
            pid::text as query_id,
            LEFT(COALESCE(query, ''), 500) as query,
            1 as calls,
            COALESCE(EXTRACT(EPOCH FROM (now() - query_start)) * 1000, 0) as total_time,
            COALESCE(EXTRACT(EPOCH FROM (now() - query_start)) * 1000, 0) as avg_time,
            0 as rows
          FROM pg_stat_activity
          WHERE datname = $1
            AND pid != pg_backend_pid()
            AND state = 'active'
            AND query IS NOT NULL
            AND query != ''
            AND query NOT LIKE '%pg_stat_activity%'
          ORDER BY query_start ASC NULLS LAST
          LIMIT $2
        `, [this.config.database, limit]);

        return fallbackRes.rows.map((r) => ({
          queryId: r.query_id,
          query: r.query || '',
          calls: parseInt(r.calls || '1'),
          totalTime: parseFloat(r.total_time || '0'),
          avgTime: parseFloat(r.avg_time || '0'),
          minTime: undefined,
          maxTime: undefined,
          rows: parseInt(r.rows || '0'),
          sharedBlksHit: undefined,
          sharedBlksRead: undefined,
        }));
      }
    } finally {
      client.release();
    }
  }

  /**
   * Get active sessions with detailed information
   */
  public async getActiveSessions(options?: { limit?: number }): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 50;

    const client = await this.pool!.connect();
    try {
      const res = await client.query(`
        SELECT
          pid,
          usename as user,
          datname as database,
          application_name,
          client_addr::text,
          COALESCE(state, 'unknown') as state,
          LEFT(COALESCE(query, ''), 500) as query,
          query_start,
          wait_event_type,
          wait_event,
          CASE
            WHEN state = 'active' THEN
              EXTRACT(EPOCH FROM (now() - query_start))::text || 's'
            WHEN xact_start IS NOT NULL THEN
              EXTRACT(EPOCH FROM (now() - xact_start))::text || 's'
            ELSE 'N/A'
          END as duration,
          CASE
            WHEN state = 'active' THEN
              EXTRACT(EPOCH FROM (now() - query_start)) * 1000
            WHEN xact_start IS NOT NULL THEN
              EXTRACT(EPOCH FROM (now() - xact_start)) * 1000
            ELSE 0
          END as duration_ms
        FROM pg_stat_activity
        WHERE datname = $1
          AND pid != pg_backend_pid()
        ORDER BY
          CASE state WHEN 'active' THEN 0 ELSE 1 END,
          query_start DESC NULLS LAST
        LIMIT $2
      `, [this.config.database, limit]);

      return res.rows.map((r) => ({
        pid: r.pid,
        user: r.user || 'unknown',
        database: r.database || '',
        applicationName: r.application_name || undefined,
        clientAddr: r.client_addr || undefined,
        state: r.state,
        query: r.query || '',
        queryStart: r.query_start ? new Date(r.query_start) : undefined,
        duration: r.duration,
        durationMs: parseFloat(r.duration_ms || '0'),
        waitEventType: r.wait_event_type || undefined,
        waitEvent: r.wait_event || undefined,
        blocked: false, // Could be enhanced with pg_locks query
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Get table statistics
   */
  public async getTableStats(options?: { schema?: string }): Promise<TableStats[]> {
    this.ensureConnected();
    const schema = options?.schema;

    const client = await this.pool!.connect();
    try {
      // If schema is specified, filter by it; otherwise get all user schemas
      const whereClause = schema
        ? `WHERE schemaname = $1`
        : `WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`;
      const params = schema ? [schema] : [];

      const res = await client.query(`
        SELECT
          schemaname as schema_name,
          relname as table_name,
          n_live_tup as live_row_count,
          n_dead_tup as dead_row_count,
          n_live_tup + n_dead_tup as row_count,
          pg_size_pretty(pg_table_size(schemaname || '.' || relname)) as table_size,
          pg_table_size(schemaname || '.' || relname) as table_size_bytes,
          pg_size_pretty(pg_indexes_size(schemaname || '.' || relname)) as index_size,
          pg_indexes_size(schemaname || '.' || relname) as index_size_bytes,
          pg_size_pretty(pg_total_relation_size(schemaname || '.' || relname)) as total_size,
          pg_total_relation_size(schemaname || '.' || relname) as total_size_bytes,
          last_vacuum,
          last_autovacuum,
          last_analyze,
          last_autoanalyze,
          CASE
            WHEN n_live_tup > 0 THEN
              ROUND(n_dead_tup * 100.0 / (n_live_tup + n_dead_tup), 2)
            ELSE 0
          END as bloat_ratio
        FROM pg_stat_user_tables
        ${whereClause}
        ORDER BY pg_total_relation_size(schemaname || '.' || relname) DESC
      `, params);

      return res.rows.map((r) => ({
        schemaName: r.schema_name,
        tableName: r.table_name,
        rowCount: parseInt(r.row_count || '0'),
        liveRowCount: parseInt(r.live_row_count || '0'),
        deadRowCount: parseInt(r.dead_row_count || '0'),
        tableSize: r.table_size || '0 bytes',
        tableSizeBytes: parseInt(r.table_size_bytes || '0'),
        indexSize: r.index_size || '0 bytes',
        indexSizeBytes: parseInt(r.index_size_bytes || '0'),
        totalSize: r.total_size || '0 bytes',
        totalSizeBytes: parseInt(r.total_size_bytes || '0'),
        lastVacuum: r.last_vacuum || r.last_autovacuum
          ? new Date(r.last_vacuum || r.last_autovacuum)
          : undefined,
        lastAnalyze: r.last_analyze || r.last_autoanalyze
          ? new Date(r.last_analyze || r.last_autoanalyze)
          : undefined,
        bloatRatio: parseFloat(r.bloat_ratio || '0'),
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Get index statistics
   */
  public async getIndexStats(options?: { schema?: string }): Promise<IndexStats[]> {
    this.ensureConnected();
    const schema = options?.schema;

    const client = await this.pool!.connect();
    try {
      // If schema is specified, filter by it; otherwise get all user schemas
      const whereClause = schema
        ? `WHERE s.schemaname = $1`
        : `WHERE s.schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`;
      const params = schema ? [schema] : [];

      const res = await client.query(`
        SELECT
          s.schemaname as schema_name,
          s.relname as table_name,
          s.indexrelname as index_name,
          am.amname as index_type,
          pg_size_pretty(pg_relation_size(s.indexrelid)) as index_size,
          pg_relation_size(s.indexrelid) as index_size_bytes,
          s.idx_scan as scans,
          s.idx_tup_read as tuples_read,
          s.idx_tup_fetch as tuples_fetched,
          ix.indisunique as is_unique,
          ix.indisprimary as is_primary,
          array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) as columns,
          CASE
            WHEN (SELECT seq_scan + idx_scan FROM pg_stat_user_tables t WHERE t.relid = s.relid) > 0
            THEN ROUND(
              s.idx_scan * 100.0 /
              (SELECT seq_scan + idx_scan FROM pg_stat_user_tables t WHERE t.relid = s.relid),
              2
            )
            ELSE 0
          END as usage_ratio
        FROM pg_stat_user_indexes s
        JOIN pg_index ix ON ix.indexrelid = s.indexrelid
        JOIN pg_class i ON i.oid = s.indexrelid
        JOIN pg_am am ON am.oid = i.relam
        JOIN pg_attribute a ON a.attrelid = s.relid AND a.attnum = ANY(ix.indkey)
        ${whereClause}
        GROUP BY s.schemaname, s.relname, s.indexrelname, am.amname,
                 s.indexrelid, s.idx_scan, s.idx_tup_read, s.idx_tup_fetch,
                 ix.indisunique, ix.indisprimary, s.relid
        ORDER BY s.idx_scan DESC
      `, params);

      return res.rows.map((r) => ({
        schemaName: r.schema_name,
        tableName: r.table_name,
        indexName: r.index_name,
        indexType: r.index_type,
        columns: Array.isArray(r.columns) ? r.columns : [],
        isUnique: r.is_unique || false,
        isPrimary: r.is_primary || false,
        indexSize: r.index_size || '0 bytes',
        indexSizeBytes: parseInt(r.index_size_bytes || '0'),
        scans: parseInt(r.scans || '0'),
        usageRatio: parseFloat(r.usage_ratio || '0'),
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Get storage statistics including tablespaces and WAL
   */
  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();

    const client = await this.pool!.connect();
    try {
      const results: StorageStats[] = [];

      // Get tablespace info
      const tsRes = await client.query(`
        SELECT
          spcname as name,
          pg_tablespace_location(oid) as location,
          pg_size_pretty(pg_tablespace_size(oid)) as size,
          pg_tablespace_size(oid) as size_bytes,
          spcname = 'pg_default' as is_default
        FROM pg_tablespace
        WHERE spcname NOT LIKE 'pg_global'
      `);

      for (const row of tsRes.rows) {
        results.push({
          name: row.name,
          location: row.location || 'default',
          size: row.size || '0 bytes',
          sizeBytes: parseInt(row.size_bytes || '0'),
          usagePercent: undefined, // Would need disk space info
        });
      }

      // Get WAL info (if superuser or has permissions)
      try {
        const walRes = await client.query(`
          SELECT
            pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')) as wal_size,
            pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0') as wal_size_bytes
        `);

        if (walRes.rows.length > 0) {
          results.push({
            name: 'WAL',
            location: 'pg_wal',
            size: walRes.rows[0].wal_size || '0 bytes',
            sizeBytes: parseInt(walRes.rows[0].wal_size_bytes || '0'),
            walSize: walRes.rows[0].wal_size || '0 bytes',
            walSizeBytes: parseInt(walRes.rows[0].wal_size_bytes || '0'),
          });
        }
      } catch {
        // WAL info requires superuser, ignore if not available
      }

      return results;
    } finally {
      client.release();
    }
  }

  public async getPgStatActivity(): Promise<PgStatActivityRow[]> {
    this.ensureConnected();
    const client = await this.pool!.connect();
    try {
      const res = await client.query('SELECT * FROM pg_stat_activity');
      return res.rows as PgStatActivityRow[];
    } finally {
      client.release();
    }
  }
}
