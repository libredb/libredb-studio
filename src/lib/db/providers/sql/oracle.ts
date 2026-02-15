/**
 * Oracle Database Provider
 * Full Oracle support with connection pooling (Thin mode - no Instant Client needed)
 */

import oracledb from 'oracledb';
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
// Oracle Provider
// ============================================================================

export class OracleProvider extends SQLBaseProvider {
  private pool: oracledb.Pool | null = null;

  // Transaction support: dedicated connection held outside pool
  private txConn: oracledb.Connection | null = null;
  private txActive = false;

  // Track running connections for cancellation
  private runningConns = new Map<string, oracledb.Connection>();

  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
    // Use thin mode (pure JS, no Oracle Instant Client)
    oracledb.initOracleClient = undefined as unknown as typeof oracledb.initOracleClient;
    oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
    oracledb.autoCommit = true;
    this.validate();
  }

  // ============================================================================
  // Provider Metadata
  // ============================================================================

  public override getCapabilities(): ProviderCapabilities {
    return {
      ...super.getCapabilities(),
      defaultPort: 1521,
      supportsExplain: true,
      supportsConnectionString: true,
      maintenanceOperations: ['analyze', 'optimize', 'kill'],
    };
  }

  public override getLabels(): ProviderLabels {
    return {
      ...super.getLabels(),
      analyzeAction: 'Gather Statistics',
      vacuumAction: 'Rebuild Indexes',
      analyzeGlobalLabel: 'Gather Stats',
      analyzeGlobalTitle: 'Gather Statistics',
      analyzeGlobalDesc: 'Collects optimizer statistics for all tables to improve query performance.',
      vacuumGlobalLabel: 'Rebuild Indexes',
      vacuumGlobalTitle: 'Rebuild All Indexes',
      vacuumGlobalDesc: 'Rebuilds all indexes to reclaim space and improve performance.',
    };
  }

  // ============================================================================
  // Validation
  // ============================================================================

  public validate(): void {
    super.validate();

    if (!this.config.connectionString) {
      if (!this.config.host) {
        throw new DatabaseConfigError('Host is required for Oracle', 'oracle');
      }
    }
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  private getConnectString(): string {
    if (this.config.connectionString) {
      return this.config.connectionString;
    }

    const host = this.config.host || 'localhost';
    const port = this.config.port || 1521;
    const serviceName = this.config.serviceName || this.config.database || 'ORCL';

    return `${host}:${port}/${serviceName}`;
  }

  public async connect(): Promise<void> {
    if (this.pool) {
      return;
    }

    try {
      this.pool = await oracledb.createPool({
        user: this.config.user,
        password: this.config.password,
        connectString: this.getConnectString(),
        poolMin: this.poolConfig.min,
        poolMax: this.poolConfig.max,
        poolTimeout: Math.floor(this.poolConfig.idleTimeout / 1000),
      });

      // Test the connection
      const conn = await this.pool.getConnection();
      await conn.close();

      this.setConnected(true);
    } catch (error) {
      this.setError(error instanceof Error ? error : new Error(String(error)));
      throw new ConnectionError(
        `Failed to connect to Oracle: ${error instanceof Error ? error.message : error}`,
        'oracle',
        this.config.host,
        this.config.port
      );
    }
  }

  public async disconnect(): Promise<void> {
    if (this.pool) {
      try {
        await this.pool.close(0);
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
        let conn: oracledb.Connection | undefined;
        try {
          conn = await this.pool!.getConnection();

          if (queryId) {
            this.runningConns.set(queryId, conn);
          }

          const bindParams = params || [];
          const res = await conn.execute(sql, bindParams, {
            outFormat: oracledb.OUT_FORMAT_OBJECT,
            autoCommit: true,
          });

          return res;
        } catch (error) {
          throw mapDatabaseError(error, 'oracle', sql);
        } finally {
          if (queryId) this.runningConns.delete(queryId);
          if (conn) {
            try { await conn.close(); } catch { /* ignore */ }
          }
        }
      });

      const rows = (result.rows || []) as Record<string, unknown>[];
      const fields = result.metaData?.map((m: { name: string }) => m.name) ?? [];

      return {
        rows,
        fields,
        rowCount: rows.length,
        executionTime,
      };
    });
  }

  public async cancelQuery(queryId: string): Promise<boolean> {
    const conn = this.runningConns.get(queryId);
    if (!conn) return false;

    try {
      await conn.break();
      return true;
    } catch (error) {
      console.error('[Oracle] Failed to cancel query:', error);
      return false;
    }
  }

  // ============================================================================
  // Query Preparation (Oracle FETCH FIRST instead of LIMIT)
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
        modifiedSql = `${modifiedSql} OFFSET ${offset} ROWS FETCH NEXT ${effectiveLimit} ROWS ONLY`;
      } else {
        modifiedSql = `${modifiedSql} FETCH FIRST ${effectiveLimit} ROWS ONLY`;
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
    if (this.txActive) throw new QueryError('Transaction already active', 'oracle');
    this.txConn = await this.pool!.getConnection();
    // Oracle auto-starts a transaction; we just hold the connection
    this.txActive = true;
  }

  public async commitTransaction(): Promise<void> {
    if (!this.txConn || !this.txActive) throw new QueryError('No active transaction', 'oracle');
    try {
      await this.txConn.commit();
    } finally {
      await this.txConn.close();
      this.txConn = null;
      this.txActive = false;
    }
  }

  public async rollbackTransaction(): Promise<void> {
    if (!this.txConn || !this.txActive) throw new QueryError('No active transaction', 'oracle');
    try {
      await this.txConn.rollback();
    } finally {
      await this.txConn.close();
      this.txConn = null;
      this.txActive = false;
    }
  }

  public isInTransaction(): boolean {
    return this.txActive;
  }

  public async queryInTransaction(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.txConn || !this.txActive) throw new QueryError('No active transaction', 'oracle');

    return this.trackQuery(async () => {
      const { result, executionTime } = await this.measureExecution(async () => {
        try {
          return await this.txConn!.execute(sql, params || [], {
            outFormat: oracledb.OUT_FORMAT_OBJECT,
            autoCommit: false,
          });
        } catch (error) {
          throw mapDatabaseError(error, 'oracle', sql);
        }
      });

      const rows = (result.rows || []) as Record<string, unknown>[];
      const fields = result.metaData?.map((m: { name: string }) => m.name) ?? [];

      return {
        rows,
        fields,
        rowCount: rows.length,
        executionTime,
      };
    });
  }

  // ============================================================================
  // Schema Operations
  // ============================================================================

  public async getSchema(): Promise<TableSchema[]> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();
      const owner = this.config.user?.toUpperCase() || '';

      // Get tables
      const tablesRes = await conn.execute(
        `SELECT TABLE_NAME, NUM_ROWS FROM ALL_TABLES WHERE OWNER = :1 ORDER BY TABLE_NAME`,
        [owner],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const tables = (tablesRes.rows || []) as Record<string, unknown>[];

      // Get columns
      const colsRes = await conn.execute(
        `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, NULLABLE, DATA_DEFAULT, COLUMN_ID
         FROM ALL_TAB_COLUMNS WHERE OWNER = :1
         ORDER BY TABLE_NAME, COLUMN_ID`,
        [owner],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const allCols = (colsRes.rows || []) as Record<string, unknown>[];

      // Get primary keys
      const pkRes = await conn.execute(
        `SELECT ac.TABLE_NAME, acc.COLUMN_NAME
         FROM ALL_CONSTRAINTS ac
         JOIN ALL_CONS_COLUMNS acc ON ac.CONSTRAINT_NAME = acc.CONSTRAINT_NAME AND ac.OWNER = acc.OWNER
         WHERE ac.OWNER = :1 AND ac.CONSTRAINT_TYPE = 'P'`,
        [owner],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const pkRows = (pkRes.rows || []) as Record<string, unknown>[];
      const pkMap = new Map<string, Set<string>>();
      for (const row of pkRows) {
        const tbl = String(row.TABLE_NAME || '');
        const col = String(row.COLUMN_NAME || '');
        if (!pkMap.has(tbl)) pkMap.set(tbl, new Set());
        pkMap.get(tbl)!.add(col);
      }

      // Get foreign keys
      const fkRes = await conn.execute(
        `SELECT ac.TABLE_NAME,
                acc.COLUMN_NAME,
                rc.TABLE_NAME AS REF_TABLE,
                rcc.COLUMN_NAME AS REF_COLUMN
         FROM ALL_CONSTRAINTS ac
         JOIN ALL_CONS_COLUMNS acc ON ac.CONSTRAINT_NAME = acc.CONSTRAINT_NAME AND ac.OWNER = acc.OWNER
         JOIN ALL_CONSTRAINTS rc ON ac.R_CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND ac.R_OWNER = rc.OWNER
         JOIN ALL_CONS_COLUMNS rcc ON rc.CONSTRAINT_NAME = rcc.CONSTRAINT_NAME AND rc.OWNER = rcc.OWNER
         WHERE ac.OWNER = :1 AND ac.CONSTRAINT_TYPE = 'R'`,
        [owner],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const fkRows = (fkRes.rows || []) as Record<string, unknown>[];

      // Get indexes
      const idxRes = await conn.execute(
        `SELECT ai.TABLE_NAME, ai.INDEX_NAME, ai.UNIQUENESS, aic.COLUMN_NAME, aic.COLUMN_POSITION
         FROM ALL_INDEXES ai
         JOIN ALL_IND_COLUMNS aic ON ai.INDEX_NAME = aic.INDEX_NAME AND ai.OWNER = aic.INDEX_OWNER
         WHERE ai.OWNER = :1
         ORDER BY ai.TABLE_NAME, ai.INDEX_NAME, aic.COLUMN_POSITION`,
        [owner],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      const idxRows = (idxRes.rows || []) as Record<string, unknown>[];

      // Group columns, indexes, foreign keys by table
      const colsByTable = new Map<string, Record<string, unknown>[]>();
      for (const c of allCols) {
        const tbl = String(c.TABLE_NAME || '');
        if (!colsByTable.has(tbl)) colsByTable.set(tbl, []);
        colsByTable.get(tbl)!.push(c);
      }

      const fksByTable = new Map<string, Record<string, unknown>[]>();
      for (const fk of fkRows) {
        const tbl = String(fk.TABLE_NAME || '');
        if (!fksByTable.has(tbl)) fksByTable.set(tbl, []);
        fksByTable.get(tbl)!.push(fk);
      }

      const idxByTable = new Map<string, Map<string, { unique: boolean; columns: string[] }>>();
      for (const idx of idxRows) {
        const tbl = String(idx.TABLE_NAME || '');
        const idxName = String(idx.INDEX_NAME || '');
        if (!idxByTable.has(tbl)) idxByTable.set(tbl, new Map());
        const tableIdxs = idxByTable.get(tbl)!;
        if (!tableIdxs.has(idxName)) {
          tableIdxs.set(idxName, {
            unique: String(idx.UNIQUENESS || '') === 'UNIQUE',
            columns: [],
          });
        }
        tableIdxs.get(idxName)!.columns.push(String(idx.COLUMN_NAME || ''));
      }

      return tables.map((t) => {
        const tableName = String(t.TABLE_NAME || '');
        const pks = pkMap.get(tableName) || new Set();

        const columns = (colsByTable.get(tableName) || []).map((c) => ({
          name: String(c.COLUMN_NAME || ''),
          type: String(c.DATA_TYPE || ''),
          nullable: String(c.NULLABLE || '') === 'Y',
          isPrimary: pks.has(String(c.COLUMN_NAME || '')),
          defaultValue: c.DATA_DEFAULT ? String(c.DATA_DEFAULT).trim() : undefined,
        }));

        const foreignKeys = (fksByTable.get(tableName) || []).map((fk) => ({
          columnName: String(fk.COLUMN_NAME || ''),
          referencedTable: String(fk.REF_TABLE || ''),
          referencedColumn: String(fk.REF_COLUMN || ''),
        }));

        const tableIdxs = idxByTable.get(tableName) || new Map();
        const indexes = Array.from(tableIdxs.entries()).map(([name, info]) => ({
          name,
          columns: info.columns,
          unique: info.unique,
        }));

        return {
          name: tableName,
          rowCount: Number(t.NUM_ROWS || 0),
          columns,
          indexes,
          foreignKeys,
        };
      });
    } finally {
      if (conn) await conn.close();
    }
  }

  // ============================================================================
  // Health & Monitoring
  // ============================================================================

  public async getHealth(): Promise<HealthInfo> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();

      let activeConnections = 0;
      let databaseSize = 'N/A';
      let cacheHitRatio = 'N/A';
      const slowQueries: SlowQuery[] = [];
      const activeSessions: ActiveSession[] = [];

      // Active connections
      try {
        const connRes = await conn.execute(
          `SELECT COUNT(*) AS CNT FROM V$SESSION WHERE STATUS = 'ACTIVE'`,
          [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        const rows = (connRes.rows || []) as Record<string, unknown>[];
        activeConnections = Number(rows[0]?.CNT || 0);
      } catch { /* V$ requires privileges */ }

      // Database size
      try {
        const sizeRes = await conn.execute(
          `SELECT ROUND(SUM(BYTES) / 1024 / 1024, 2) AS SIZE_MB FROM USER_SEGMENTS`,
          [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        const sizeRows = (sizeRes.rows || []) as Record<string, unknown>[];
        const mb = Number(sizeRows[0]?.SIZE_MB || 0);
        databaseSize = mb > 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb} MB`;
      } catch { /* ignore */ }

      // Cache hit ratio
      try {
        const cacheRes = await conn.execute(
          `SELECT ROUND(
            (1 - (SUM(DECODE(NAME, 'physical reads', VALUE, 0)) /
                  NULLIF(SUM(DECODE(NAME, 'db block gets', VALUE, 0)) + SUM(DECODE(NAME, 'consistent gets', VALUE, 0)), 0)
            )) * 100, 2) AS HIT_RATIO
           FROM V$SYSSTAT
           WHERE NAME IN ('db block gets', 'consistent gets', 'physical reads')`,
          [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        const cacheRows = (cacheRes.rows || []) as Record<string, unknown>[];
        cacheHitRatio = `${cacheRows[0]?.HIT_RATIO || 0}%`;
      } catch { /* ignore */ }

      // Slow queries
      try {
        const slowRes = await conn.execute(
          `SELECT * FROM (
            SELECT SUBSTR(SQL_TEXT, 1, 100) AS QUERY,
                   EXECUTIONS AS CALLS,
                   ROUND(ELAPSED_TIME / NULLIF(EXECUTIONS, 0) / 1000, 2) || 'ms' AS AVGTIME
            FROM V$SQL
            WHERE EXECUTIONS > 0
            ORDER BY ELAPSED_TIME DESC
          ) WHERE ROWNUM <= 5`,
          [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        for (const row of (slowRes.rows || []) as Record<string, unknown>[]) {
          slowQueries.push({
            query: String(row.QUERY || ''),
            calls: Number(row.CALLS || 0),
            avgTime: String(row.AVGTIME || 'N/A'),
          });
        }
      } catch { /* V$SQL requires privileges */ }

      // Active sessions
      try {
        const sessRes = await conn.execute(
          `SELECT * FROM (
            SELECT SID, USERNAME, STATUS, SUBSTR(NVL(SQL_ID, ''), 1, 100) AS QUERY,
                   SCHEMANAME AS "DATABASE",
                   NVL(TO_CHAR(LOGON_TIME, 'HH24:MI:SS'), 'N/A') AS DURATION
            FROM V$SESSION
            WHERE TYPE = 'USER' AND STATUS = 'ACTIVE'
            ORDER BY LOGON_TIME DESC
          ) WHERE ROWNUM <= 10`,
          [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        for (const row of (sessRes.rows || []) as Record<string, unknown>[]) {
          activeSessions.push({
            pid: String(row.SID || ''),
            user: String(row.USERNAME || 'unknown'),
            database: String(row.DATABASE || ''),
            state: String(row.STATUS || 'unknown'),
            query: String(row.QUERY || ''),
            duration: String(row.DURATION || 'N/A'),
          });
        }
      } catch { /* ignore */ }

      return { activeConnections, databaseSize, cacheHitRatio, slowQueries, activeSessions };
    } finally {
      if (conn) await conn.close();
    }
  }

  // ============================================================================
  // Maintenance Operations
  // ============================================================================

  public async runMaintenance(type: MaintenanceType, target?: string): Promise<MaintenanceResult> {
    this.ensureConnected();

    const { result, executionTime } = await this.measureExecution(async () => {
      let conn: oracledb.Connection | undefined;
      try {
        conn = await this.pool!.getConnection();
        let sql = '';

        switch (type) {
          case 'analyze':
            if (target) {
              sql = `BEGIN DBMS_STATS.GATHER_TABLE_STATS(USER, '${target.replace(/'/g, "''")}'); END;`;
            } else {
              sql = `BEGIN DBMS_STATS.GATHER_SCHEMA_STATS(USER); END;`;
            }
            break;
          case 'optimize':
            if (target) {
              sql = `ALTER INDEX "${target.replace(/"/g, '""')}" REBUILD`;
            } else {
              // Rebuild all indexes for user
              const idxRes = await conn.execute(
                `SELECT INDEX_NAME FROM USER_INDEXES WHERE INDEX_TYPE = 'NORMAL'`,
                [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
              );
              for (const row of (idxRes.rows || []) as Record<string, unknown>[]) {
                try {
                  await conn.execute(`ALTER INDEX "${String(row.INDEX_NAME)}" REBUILD`);
                } catch { /* individual index rebuild may fail */ }
              }
              return { success: true };
            }
            break;
          case 'kill':
            if (!target) {
              throw new QueryError('Target SID,SERIAL# is required for kill operation', 'oracle');
            }
            sql = `ALTER SYSTEM KILL SESSION '${target.replace(/'/g, "''")}'`;
            break;
          default:
            throw new QueryError(`Unsupported maintenance type: ${type}`, 'oracle');
        }

        if (sql) {
          await conn.execute(sql);
        }
        return { success: true };
      } finally {
        if (conn) await conn.close();
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
      total: this.pool.connectionsOpen,
      idle: this.pool.connectionsOpen - this.pool.connectionsInUse,
      active: this.pool.connectionsInUse,
      waiting: 0,
    };
  }

  // ============================================================================
  // Extended Monitoring Methods
  // ============================================================================

  public async getOverview(): Promise<DatabaseOverview> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();

      let version = 'Oracle';
      let uptime = 'N/A';
      let startTime: Date | undefined;
      let activeConnections = 0;
      let maxConnections = 0;
      let databaseSize = '0 bytes';
      let databaseSizeBytes = 0;
      let tableCount = 0;
      let indexCount = 0;

      // Version and uptime
      try {
        const vRes = await conn.execute(
          `SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1`,
          [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        const vRows = (vRes.rows || []) as Record<string, unknown>[];
        if (vRows[0]?.BANNER) version = String(vRows[0].BANNER);
      } catch { /* ignore */ }

      try {
        const upRes = await conn.execute(
          `SELECT STARTUP_TIME, (SYSDATE - STARTUP_TIME) * 86400 AS UPTIME_SECS FROM V$INSTANCE`,
          [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        const upRows = (upRes.rows || []) as Record<string, unknown>[];
        if (upRows[0]) {
          const secs = Number(upRows[0].UPTIME_SECS || 0);
          const days = Math.floor(secs / 86400);
          const hours = Math.floor((secs % 86400) / 3600);
          const minutes = Math.floor((secs % 3600) / 60);
          uptime = days > 0 ? `${days}d ${hours}h ${minutes}m` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
          if (upRows[0].STARTUP_TIME) startTime = new Date(String(upRows[0].STARTUP_TIME));
        }
      } catch { /* ignore */ }

      // Connections
      try {
        const sessRes = await conn.execute(
          `SELECT COUNT(*) AS CNT FROM V$SESSION WHERE TYPE = 'USER'`,
          [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        activeConnections = Number(((sessRes.rows || []) as Record<string, unknown>[])[0]?.CNT || 0);

        const maxRes = await conn.execute(
          `SELECT VALUE FROM V$PARAMETER WHERE NAME = 'sessions'`,
          [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        maxConnections = Number(((maxRes.rows || []) as Record<string, unknown>[])[0]?.VALUE || 0);
      } catch { /* ignore */ }

      // Database size
      try {
        const sizeRes = await conn.execute(
          `SELECT SUM(BYTES) AS TOTAL FROM USER_SEGMENTS`,
          [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        databaseSizeBytes = Number(((sizeRes.rows || []) as Record<string, unknown>[])[0]?.TOTAL || 0);
        databaseSize = formatBytes(databaseSizeBytes);
      } catch { /* ignore */ }

      // Table and index counts
      try {
        const cntRes = await conn.execute(
          `SELECT
            (SELECT COUNT(*) FROM USER_TABLES) AS TABLE_COUNT,
            (SELECT COUNT(*) FROM USER_INDEXES) AS INDEX_COUNT
           FROM DUAL`,
          [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        const cntRows = (cntRes.rows || []) as Record<string, unknown>[];
        tableCount = Number(cntRows[0]?.TABLE_COUNT || 0);
        indexCount = Number(cntRows[0]?.INDEX_COUNT || 0);
      } catch { /* ignore */ }

      return {
        version, uptime, startTime, activeConnections, maxConnections,
        databaseSize, databaseSizeBytes, tableCount, indexCount,
      };
    } finally {
      if (conn) await conn.close();
    }
  }

  public async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();

      let cacheHitRatio = 100;
      let bufferPoolUsage: number | undefined;

      try {
        const cacheRes = await conn.execute(
          `SELECT ROUND(
            (1 - (SUM(DECODE(NAME, 'physical reads', VALUE, 0)) /
                  NULLIF(SUM(DECODE(NAME, 'db block gets', VALUE, 0)) + SUM(DECODE(NAME, 'consistent gets', VALUE, 0)), 0)
            )) * 100, 2) AS HIT_RATIO
           FROM V$SYSSTAT
           WHERE NAME IN ('db block gets', 'consistent gets', 'physical reads')`,
          [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        const rows = (cacheRes.rows || []) as Record<string, unknown>[];
        cacheHitRatio = Number(rows[0]?.HIT_RATIO || 100);
        bufferPoolUsage = cacheHitRatio;
      } catch { /* ignore */ }

      return {
        cacheHitRatio,
        bufferPoolUsage,
      };
    } finally {
      if (conn) await conn.close();
    }
  }

  public async getSlowQueries(options?: { limit?: number }): Promise<SlowQueryStats[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 10;

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();

      const res = await conn.execute(
        `SELECT * FROM (
          SELECT SQL_ID AS QUERY_ID,
                 SUBSTR(SQL_TEXT, 1, 500) AS QUERY,
                 EXECUTIONS AS CALLS,
                 ROUND(ELAPSED_TIME / 1000, 2) AS TOTAL_TIME,
                 ROUND(ELAPSED_TIME / NULLIF(EXECUTIONS, 0) / 1000, 2) AS AVG_TIME,
                 ROWS_PROCESSED AS ROW_CNT,
                 BUFFER_GETS AS BUF_GETS,
                 DISK_READS
          FROM V$SQL
          WHERE EXECUTIONS > 0
          ORDER BY ELAPSED_TIME DESC
        ) WHERE ROWNUM <= ${limit}`,
        [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      return ((res.rows || []) as Record<string, unknown>[]).map((r) => ({
        queryId: String(r.QUERY_ID || ''),
        query: String(r.QUERY || ''),
        calls: Number(r.CALLS || 0),
        totalTime: Number(r.TOTAL_TIME || 0),
        avgTime: Number(r.AVG_TIME || 0),
        rows: Number(r.ROW_CNT || 0),
        sharedBlksHit: Number(r.BUF_GETS || 0),
        sharedBlksRead: Number(r.DISK_READS || 0),
      }));
    } catch {
      return [];
    } finally {
      if (conn) await conn.close();
    }
  }

  public async getActiveSessions(options?: { limit?: number }): Promise<ActiveSessionDetails[]> {
    this.ensureConnected();
    const limit = options?.limit ?? 50;

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();

      const res = await conn.execute(
        `SELECT * FROM (
          SELECT s.SID, s.SERIAL#, s.USERNAME, s.SCHEMANAME, s.PROGRAM,
                 s.MACHINE, s.STATUS, s.SQL_ID,
                 SUBSTR(sq.SQL_TEXT, 1, 500) AS QUERY,
                 s.LOGON_TIME,
                 ROUND((SYSDATE - s.LOGON_TIME) * 86400) AS DURATION_SECS,
                 s.WAIT_CLASS, s.EVENT
          FROM V$SESSION s
          LEFT JOIN V$SQL sq ON s.SQL_ID = sq.SQL_ID AND s.SQL_CHILD_NUMBER = sq.CHILD_NUMBER
          WHERE s.TYPE = 'USER'
          ORDER BY CASE s.STATUS WHEN 'ACTIVE' THEN 0 ELSE 1 END, s.LOGON_TIME DESC
        ) WHERE ROWNUM <= ${limit}`,
        [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      return ((res.rows || []) as Record<string, unknown>[]).map((r) => {
        const secs = Number(r.DURATION_SECS || 0);
        const durationStr = secs > 3600 ? `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
          : secs > 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s`
          : `${secs}s`;

        return {
          pid: `${r.SID},${r['SERIAL#']}`,
          user: String(r.USERNAME || 'unknown'),
          database: String(r.SCHEMANAME || ''),
          applicationName: String(r.PROGRAM || ''),
          clientAddr: String(r.MACHINE || ''),
          state: String(r.STATUS || 'unknown'),
          query: String(r.QUERY || r.SQL_ID || ''),
          queryStart: r.LOGON_TIME ? new Date(String(r.LOGON_TIME)) : undefined,
          duration: durationStr,
          durationMs: secs * 1000,
          waitEventType: r.WAIT_CLASS ? String(r.WAIT_CLASS) : undefined,
          waitEvent: r.EVENT ? String(r.EVENT) : undefined,
          blocked: false,
        };
      });
    } catch {
      return [];
    } finally {
      if (conn) await conn.close();
    }
  }

  public async getTableStats(): Promise<TableStats[]> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();
      const owner = this.config.user?.toUpperCase() || '';

      const res = await conn.execute(
        `SELECT t.TABLE_NAME,
                NVL(t.NUM_ROWS, 0) AS ROW_COUNT,
                NVL(s.BYTES, 0) AS TABLE_SIZE_BYTES,
                NVL(idx_size.BYTES, 0) AS INDEX_SIZE_BYTES,
                t.LAST_ANALYZED
         FROM ALL_TABLES t
         LEFT JOIN USER_SEGMENTS s ON s.SEGMENT_NAME = t.TABLE_NAME AND s.SEGMENT_TYPE = 'TABLE'
         LEFT JOIN (
           SELECT TABLE_NAME, SUM(BYTES) AS BYTES
           FROM USER_SEGMENTS
           WHERE SEGMENT_TYPE = 'INDEX'
           GROUP BY TABLE_NAME
         ) idx_size ON idx_size.TABLE_NAME = t.TABLE_NAME
         WHERE t.OWNER = :1
         ORDER BY NVL(s.BYTES, 0) DESC`,
        [owner],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      return ((res.rows || []) as Record<string, unknown>[]).map((r) => {
        const tableSizeBytes = Number(r.TABLE_SIZE_BYTES || 0);
        const indexSizeBytes = Number(r.INDEX_SIZE_BYTES || 0);
        return {
          schemaName: owner,
          tableName: String(r.TABLE_NAME || ''),
          rowCount: Number(r.ROW_COUNT || 0),
          tableSize: formatBytes(tableSizeBytes),
          tableSizeBytes,
          indexSize: formatBytes(indexSizeBytes),
          indexSizeBytes,
          totalSize: formatBytes(tableSizeBytes + indexSizeBytes),
          totalSizeBytes: tableSizeBytes + indexSizeBytes,
          lastAnalyze: r.LAST_ANALYZED ? new Date(String(r.LAST_ANALYZED)) : undefined,
        };
      });
    } catch {
      return [];
    } finally {
      if (conn) await conn.close();
    }
  }

  public async getIndexStats(): Promise<IndexStats[]> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();
      const owner = this.config.user?.toUpperCase() || '';

      const res = await conn.execute(
        `SELECT ai.TABLE_NAME, ai.INDEX_NAME, ai.INDEX_TYPE, ai.UNIQUENESS,
                NVL(us.BYTES, 0) AS INDEX_SIZE_BYTES,
                ai.LEAF_BLOCKS, ai.DISTINCT_KEYS
         FROM ALL_INDEXES ai
         LEFT JOIN USER_SEGMENTS us ON us.SEGMENT_NAME = ai.INDEX_NAME AND us.SEGMENT_TYPE = 'INDEX'
         WHERE ai.OWNER = :1
         ORDER BY NVL(us.BYTES, 0) DESC`,
        [owner],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      // Get columns for each index
      const colRes = await conn.execute(
        `SELECT INDEX_NAME, COLUMN_NAME, COLUMN_POSITION
         FROM ALL_IND_COLUMNS WHERE INDEX_OWNER = :1
         ORDER BY INDEX_NAME, COLUMN_POSITION`,
        [owner],
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const colMap = new Map<string, string[]>();
      for (const c of (colRes.rows || []) as Record<string, unknown>[]) {
        const idxName = String(c.INDEX_NAME || '');
        if (!colMap.has(idxName)) colMap.set(idxName, []);
        colMap.get(idxName)!.push(String(c.COLUMN_NAME || ''));
      }

      return ((res.rows || []) as Record<string, unknown>[]).map((r) => {
        const idxName = String(r.INDEX_NAME || '');
        const idxSizeBytes = Number(r.INDEX_SIZE_BYTES || 0);
        return {
          schemaName: owner,
          tableName: String(r.TABLE_NAME || ''),
          indexName: idxName,
          indexType: String(r.INDEX_TYPE || ''),
          columns: colMap.get(idxName) || [],
          isUnique: String(r.UNIQUENESS || '') === 'UNIQUE',
          isPrimary: false,
          indexSize: formatBytes(idxSizeBytes),
          indexSizeBytes: idxSizeBytes,
          scans: 0,
        };
      });
    } catch {
      return [];
    } finally {
      if (conn) await conn.close();
    }
  }

  public async getStorageStats(): Promise<StorageStats[]> {
    this.ensureConnected();

    let conn: oracledb.Connection | undefined;
    try {
      conn = await this.pool!.getConnection();
      const results: StorageStats[] = [];

      // Try DBA tablespaces first, fallback to USER
      try {
        const tsRes = await conn.execute(
          `SELECT TABLESPACE_NAME AS NAME,
                  SUM(BYTES) AS SIZE_BYTES
           FROM DBA_DATA_FILES
           GROUP BY TABLESPACE_NAME
           ORDER BY SUM(BYTES) DESC`,
          [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        for (const row of (tsRes.rows || []) as Record<string, unknown>[]) {
          const sizeBytes = Number(row.SIZE_BYTES || 0);
          results.push({
            name: String(row.NAME || ''),
            size: formatBytes(sizeBytes),
            sizeBytes,
          });
        }
      } catch {
        // Fallback: user segments
        try {
          const segRes = await conn.execute(
            `SELECT TABLESPACE_NAME AS NAME,
                    SUM(BYTES) AS SIZE_BYTES
             FROM USER_SEGMENTS
             GROUP BY TABLESPACE_NAME
             ORDER BY SUM(BYTES) DESC`,
            [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
          );

          for (const row of (segRes.rows || []) as Record<string, unknown>[]) {
            const sizeBytes = Number(row.SIZE_BYTES || 0);
            results.push({
              name: String(row.NAME || ''),
              size: formatBytes(sizeBytes),
              sizeBytes,
            });
          }
        } catch { /* ignore */ }
      }

      return results;
    } finally {
      if (conn) await conn.close();
    }
  }
}
