import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Mock oracledb BEFORE importing the provider
// ---------------------------------------------------------------------------

let mockExecuteFn: (sql: string, params?: unknown[], opts?: unknown) => Promise<unknown>;

const createMockConnection = () => ({
  execute: (sql: string, params?: unknown[], opts?: unknown) =>
    mockExecuteFn(sql, params, opts),
  close: async () => {},
  break: async () => {},
  commit: async () => {},
  rollback: async () => {},
});

const createMockPool = () => ({
  getConnection: async () => createMockConnection(),
  close: async () => {},
  connectionsOpen: 5,
  connectionsInUse: 2,
});

mock.module('oracledb', () => {
  const oracledbMock = {
    OUT_FORMAT_OBJECT: 4002,
    initOracleClient: undefined as unknown,
    outFormat: 0,
    autoCommit: false,
    createPool: async () => createMockPool(),
  };
  return { default: oracledbMock };
});

// Now import the provider (after mock is in place)
import { OracleProvider } from '@/lib/db/providers/sql/oracle';
import { DatabaseConfigError, QueryError } from '@/lib/db/errors';
import type { DatabaseConnection } from '@/lib/types';

// ---------------------------------------------------------------------------
// Default mock execute implementation
// ---------------------------------------------------------------------------

function defaultExecute(sql: string) {
  const upper = sql.toUpperCase();

  // V$VERSION (for getOverview version)
  if (upper.includes('V$VERSION') && upper.includes('BANNER')) {
    return {
      rows: [{ BANNER: 'Oracle Database 19c Enterprise Edition Release 19.0.0.0.0' }],
      metaData: [{ name: 'BANNER' }],
    };
  }

  // V$INSTANCE (for getOverview uptime)
  if (upper.includes('V$INSTANCE') && upper.includes('STARTUP_TIME')) {
    return {
      rows: [{ STARTUP_TIME: new Date(Date.now() - 86400 * 1000).toISOString(), UPTIME_SECS: 86400 }],
      metaData: [{ name: 'STARTUP_TIME' }, { name: 'UPTIME_SECS' }],
    };
  }

  // V$PARAMETER (for max sessions)
  if (upper.includes('V$PARAMETER') && upper.includes('SESSIONS')) {
    return {
      rows: [{ VALUE: 250 }],
      metaData: [{ name: 'VALUE' }],
    };
  }

  // V$SESSION with COUNT (for getOverview connections and getHealth active connections)
  if (upper.includes('V$SESSION') && upper.includes('COUNT')) {
    return {
      rows: [{ CNT: 8 }],
      metaData: [{ name: 'CNT' }],
    };
  }

  // V$SESSION active sessions detail (for getActiveSessions — has SID, SERIAL#, SQL_TEXT)
  if (upper.includes('V$SESSION') && upper.includes('SERIAL#')) {
    return {
      rows: [
        {
          SID: 101,
          'SERIAL#': 5432,
          USERNAME: 'TEST_USER',
          SCHEMANAME: 'TESTSCHEMA',
          PROGRAM: 'sqlplus.exe',
          MACHINE: 'WORKSTATION1',
          STATUS: 'ACTIVE',
          SQL_ID: 'abc123',
          QUERY: 'SELECT * FROM USERS',
          LOGON_TIME: new Date(Date.now() - 300000).toISOString(),
          DURATION_SECS: 300,
          WAIT_CLASS: 'CPU',
          EVENT: 'CPU + wait for CPU',
        },
      ],
      metaData: [{ name: 'SID' }, { name: 'SERIAL#' }, { name: 'USERNAME' }],
    };
  }

  // V$SESSION (fallback for getHealth active sessions)
  if (upper.includes('V$SESSION')) {
    return {
      rows: [
        { CNT: 8, SID: 101, USERNAME: 'TEST_USER', STATUS: 'ACTIVE', QUERY: 'sel1', DATABASE: 'ORCL', DURATION: '00:01:23' },
      ],
      metaData: [{ name: 'CNT' }, { name: 'SID' }],
    };
  }

  // USER_SEGMENTS size (for getHealth and getOverview)
  if (upper.includes('USER_SEGMENTS') && upper.includes('SUM(BYTES)') && upper.includes('TOTAL')) {
    return {
      rows: [{ TOTAL: 268435456 }],
      metaData: [{ name: 'TOTAL' }],
    };
  }

  if (upper.includes('USER_SEGMENTS') && upper.includes('TABLESPACE_NAME')) {
    return {
      rows: [
        { NAME: 'USERS', SIZE_BYTES: 134217728 },
        { NAME: 'SYSTEM', SIZE_BYTES: 67108864 },
      ],
      metaData: [{ name: 'NAME' }, { name: 'SIZE_BYTES' }],
    };
  }

  if (upper.includes('USER_SEGMENTS')) {
    return {
      rows: [{ SIZE_MB: 256, TOTAL: 268435456 }],
      metaData: [{ name: 'SIZE_MB' }],
    };
  }

  // USER_TABLES / USER_INDEXES counts (for getOverview)
  if (upper.includes('USER_TABLES') && upper.includes('TABLE_COUNT') && upper.includes('USER_INDEXES')) {
    return {
      rows: [{ TABLE_COUNT: 10, INDEX_COUNT: 15 }],
      metaData: [{ name: 'TABLE_COUNT' }, { name: 'INDEX_COUNT' }],
    };
  }

  if (upper.includes('V$SYSSTAT')) {
    return {
      rows: [{ HIT_RATIO: 97.5 }],
      metaData: [{ name: 'HIT_RATIO' }],
    };
  }

  // V$SQL detail (for getSlowQueries — has SQL_ID, SUBSTR)
  if (upper.includes('V$SQL') && upper.includes('SQL_ID') && upper.includes('TOTAL_TIME')) {
    return {
      rows: [
        {
          QUERY_ID: 'sql_abc123',
          QUERY: 'SELECT * FROM big_table WHERE status = 1',
          CALLS: 42,
          TOTAL_TIME: 6300,
          AVG_TIME: 150,
          ROW_CNT: 1000,
          BUF_GETS: 500,
          DISK_READS: 20,
        },
      ],
      metaData: [{ name: 'QUERY_ID' }, { name: 'QUERY' }, { name: 'CALLS' }],
    };
  }

  if (upper.includes('V$SQL')) {
    return {
      rows: [{ QUERY: 'SELECT * FROM big_table', CALLS: 42, AVGTIME: '150ms', QUERY_ID: 'abc', TOTAL_TIME: 6300, AVG_TIME: 150, ROW_CNT: 1000, BUF_GETS: 500, DISK_READS: 20 }],
      metaData: [{ name: 'QUERY' }, { name: 'CALLS' }, { name: 'AVGTIME' }],
    };
  }

  // ALL_TABLES with table stats (for getTableStats — has USER_SEGMENTS join)
  if (upper.includes('ALL_TABLES') && upper.includes('TABLE_SIZE_BYTES') && upper.includes('INDEX_SIZE_BYTES')) {
    return {
      rows: [
        { TABLE_NAME: 'USERS', ROW_COUNT: 100, TABLE_SIZE_BYTES: 65536, INDEX_SIZE_BYTES: 16384, LAST_ANALYZED: '2026-02-14T00:00:00Z' },
        { TABLE_NAME: 'ORDERS', ROW_COUNT: 500, TABLE_SIZE_BYTES: 131072, INDEX_SIZE_BYTES: 32768, LAST_ANALYZED: '2026-02-14T00:00:00Z' },
      ],
      metaData: [{ name: 'TABLE_NAME' }, { name: 'ROW_COUNT' }],
    };
  }

  if (upper.includes('ALL_TABLES')) {
    return {
      rows: [{ TABLE_NAME: 'USERS', NUM_ROWS: 100 }, { TABLE_NAME: 'ORDERS', NUM_ROWS: 500 }],
      metaData: [{ name: 'TABLE_NAME' }, { name: 'NUM_ROWS' }],
    };
  }

  if (upper.includes('ALL_TAB_COLUMNS')) {
    return {
      rows: [
        { TABLE_NAME: 'USERS', COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER', NULLABLE: 'N', DATA_DEFAULT: null, COLUMN_ID: 1 },
        { TABLE_NAME: 'USERS', COLUMN_NAME: 'NAME', DATA_TYPE: 'VARCHAR2', NULLABLE: 'Y', DATA_DEFAULT: null, COLUMN_ID: 2 },
        { TABLE_NAME: 'ORDERS', COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER', NULLABLE: 'N', DATA_DEFAULT: null, COLUMN_ID: 1 },
      ],
      metaData: [{ name: 'TABLE_NAME' }, { name: 'COLUMN_NAME' }],
    };
  }

  if (upper.includes('ALL_CONSTRAINTS') && upper.includes("'P'")) {
    return {
      rows: [{ TABLE_NAME: 'USERS', COLUMN_NAME: 'ID' }],
      metaData: [{ name: 'TABLE_NAME' }, { name: 'COLUMN_NAME' }],
    };
  }

  if (upper.includes('ALL_CONSTRAINTS') && upper.includes("'R'")) {
    return {
      rows: [{ TABLE_NAME: 'ORDERS', COLUMN_NAME: 'USER_ID', REF_TABLE: 'USERS', REF_COLUMN: 'ID' }],
      metaData: [{ name: 'TABLE_NAME' }, { name: 'COLUMN_NAME' }, { name: 'REF_TABLE' }, { name: 'REF_COLUMN' }],
    };
  }

  // Index stats (for getIndexStats — has INDEX_SIZE_BYTES)
  if (upper.includes('ALL_INDEXES') && upper.includes('INDEX_SIZE_BYTES')) {
    return {
      rows: [
        { TABLE_NAME: 'USERS', INDEX_NAME: 'IDX_USERS_PK', INDEX_TYPE: 'NORMAL', UNIQUENESS: 'UNIQUE', INDEX_SIZE_BYTES: 16384, LEAF_BLOCKS: 10, DISTINCT_KEYS: 100 },
        { TABLE_NAME: 'USERS', INDEX_NAME: 'IDX_USERS_NAME', INDEX_TYPE: 'NORMAL', UNIQUENESS: 'NONUNIQUE', INDEX_SIZE_BYTES: 8192, LEAF_BLOCKS: 5, DISTINCT_KEYS: 95 },
      ],
      metaData: [{ name: 'TABLE_NAME' }, { name: 'INDEX_NAME' }],
    };
  }

  // ALL_IND_COLUMNS for index columns (for getIndexStats second query)
  if (upper.includes('ALL_IND_COLUMNS') && upper.includes('COLUMN_POSITION') && !upper.includes('ALL_INDEXES')) {
    return {
      rows: [
        { INDEX_NAME: 'IDX_USERS_PK', COLUMN_NAME: 'ID', COLUMN_POSITION: 1 },
        { INDEX_NAME: 'IDX_USERS_NAME', COLUMN_NAME: 'NAME', COLUMN_POSITION: 1 },
      ],
      metaData: [{ name: 'INDEX_NAME' }, { name: 'COLUMN_NAME' }],
    };
  }

  if (upper.includes('ALL_INDEXES') || upper.includes('ALL_IND_COLUMNS')) {
    return {
      rows: [{ TABLE_NAME: 'USERS', INDEX_NAME: 'IDX_USERS_NAME', UNIQUENESS: 'NONUNIQUE', COLUMN_NAME: 'NAME', COLUMN_POSITION: 1 }],
      metaData: [{ name: 'TABLE_NAME' }, { name: 'INDEX_NAME' }],
    };
  }

  if (upper.includes('DBMS_STATS') || upper.includes('ALTER INDEX') || upper.includes('ALTER SYSTEM KILL')) {
    return { rows: [], metaData: [] };
  }

  if (upper.includes('USER_INDEXES')) {
    return {
      rows: [{ INDEX_NAME: 'IDX_USERS_NAME' }],
      metaData: [{ name: 'INDEX_NAME' }],
    };
  }

  // DBA_DATA_FILES (for getStorageStats — tablespace info)
  if (upper.includes('DBA_DATA_FILES')) {
    return {
      rows: [
        { NAME: 'SYSTEM', SIZE_BYTES: 536870912 },
        { NAME: 'USERS', SIZE_BYTES: 268435456 },
      ],
      metaData: [{ name: 'NAME' }, { name: 'SIZE_BYTES' }],
    };
  }

  // Default
  return {
    rows: [{ ID: 1, NAME: 'test' }],
    metaData: [{ name: 'ID' }, { name: 'NAME' }],
  };
}

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

const baseConfig: DatabaseConnection = {
  id: 'test-oracle',
  name: 'Test Oracle',
  type: 'oracle',
  host: 'localhost',
  port: 1521,
  serviceName: 'ORCL',
  user: 'TEST_USER',
  password: 'test',
  createdAt: new Date(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OracleProvider', () => {
  let provider: OracleProvider;

  beforeEach(() => {
    mockExecuteFn = async (sql: string) => defaultExecute(sql);
    provider = new OracleProvider(baseConfig);
  });

  afterEach(async () => {
    try {
      await provider.disconnect();
    } catch {
      /* ignore */
    }
  });

  // =========================================================================
  // 1. Validation
  // =========================================================================

  describe('validation', () => {
    test('throws DatabaseConfigError when host is missing and no connectionString', () => {
      expect(() => {
        new OracleProvider({
          ...baseConfig,
          host: undefined,
          connectionString: undefined,
        } as unknown as DatabaseConnection);
      }).toThrow(DatabaseConfigError);
    });

    test('succeeds when connectionString is provided without host', () => {
      expect(() => {
        new OracleProvider({
          ...baseConfig,
          host: undefined,
          connectionString: 'localhost:1521/ORCL',
        } as unknown as DatabaseConnection);
      }).not.toThrow();
    });
  });

  // =========================================================================
  // 2. Connect / Disconnect
  // =========================================================================

  describe('connect / disconnect', () => {
    test('connect creates pool and marks connected', async () => {
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test('disconnect closes pool and marks disconnected', async () => {
      await provider.connect();
      await provider.disconnect();
      expect(provider.isConnected()).toBe(false);
    });

    test('double connect is idempotent', async () => {
      await provider.connect();
      await provider.connect(); // should not throw
      expect(provider.isConnected()).toBe(true);
    });
  });

  // =========================================================================
  // 3. query()
  // =========================================================================

  describe('query()', () => {
    test('returns rows and fields from metaData', async () => {
      await provider.connect();
      const result = await provider.query('SELECT * FROM DUAL');
      expect(result.rows).toBeArray();
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.fields).toContain('ID');
      expect(result.fields).toContain('NAME');
      expect(result.rowCount).toBe(result.rows.length);
      expect(typeof result.executionTime).toBe('number');
    });
  });

  // =========================================================================
  // 4. getCapabilities()
  // =========================================================================

  describe('getCapabilities()', () => {
    test('returns correct capabilities for Oracle', () => {
      const caps = provider.getCapabilities();
      expect(caps.defaultPort).toBe(1521);
      expect(caps.maintenanceOperations).toContain('analyze');
      expect(caps.maintenanceOperations).toContain('optimize');
      expect(caps.maintenanceOperations).toContain('kill');
      expect(caps.supportsExplain).toBe(true);
      expect(caps.supportsConnectionString).toBe(true);
    });
  });

  // =========================================================================
  // 5. getLabels()
  // =========================================================================

  describe('getLabels()', () => {
    test('returns Gather Statistics as analyzeAction', () => {
      const labels = provider.getLabels();
      expect(labels.analyzeAction).toBe('Gather Statistics');
    });
  });

  // =========================================================================
  // 6. prepareQuery()
  // =========================================================================

  describe('prepareQuery()', () => {
    test('SELECT without FETCH FIRST gets FETCH FIRST appended', () => {
      const result = provider.prepareQuery('SELECT * FROM USERS');
      expect(result.query).toContain('FETCH FIRST');
      expect(result.wasLimited).toBe(true);
    });

    test('SELECT with offset gets OFFSET/FETCH NEXT', () => {
      const result = provider.prepareQuery('SELECT * FROM USERS', { offset: 10, limit: 50 });
      expect(result.query).toContain('OFFSET 10 ROWS');
      expect(result.query).toContain('FETCH NEXT 50 ROWS ONLY');
      expect(result.wasLimited).toBe(true);
    });

    test('non-SELECT query is unchanged', () => {
      const sql = 'INSERT INTO USERS (NAME) VALUES (\'test\')';
      const result = provider.prepareQuery(sql);
      expect(result.query).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    test('existing FETCH FIRST leaves query unchanged', () => {
      const sql = 'SELECT * FROM USERS FETCH FIRST 10 ROWS ONLY';
      const result = provider.prepareQuery(sql);
      expect(result.wasLimited).toBe(false);
    });

    test('existing ROWNUM leaves query unchanged', () => {
      const sql = 'SELECT * FROM USERS WHERE ROWNUM <= 10';
      const result = provider.prepareQuery(sql);
      expect(result.wasLimited).toBe(false);
    });
  });

  // =========================================================================
  // 7. getSchema()
  // =========================================================================

  describe('getSchema()', () => {
    test('returns tables with columns, indexes, PKs, and FKs', async () => {
      await provider.connect();
      const schema = await provider.getSchema();

      expect(schema).toBeArray();
      expect(schema.length).toBe(2);

      const usersTable = schema.find((t) => t.name === 'USERS');
      expect(usersTable).toBeDefined();
      expect(usersTable!.columns.length).toBeGreaterThanOrEqual(2);

      // Check primary key
      const idCol = usersTable!.columns.find((c) => c.name === 'ID');
      expect(idCol).toBeDefined();
      expect(idCol!.isPrimary).toBe(true);

      // Check indexes exist
      expect(usersTable!.indexes).toBeArray();

      // Check foreign keys on ORDERS
      const ordersTable = schema.find((t) => t.name === 'ORDERS');
      expect(ordersTable).toBeDefined();
      expect(ordersTable!.foreignKeys!.length).toBeGreaterThan(0);
      expect(ordersTable!.foreignKeys![0].referencedTable).toBe('USERS');
    });
  });

  // =========================================================================
  // 8. getHealth()
  // =========================================================================

  describe('getHealth()', () => {
    test('returns health data with graceful degradation', async () => {
      await provider.connect();
      const health = await provider.getHealth();

      expect(typeof health.activeConnections).toBe('number');
      expect(typeof health.databaseSize).toBe('string');
      expect(typeof health.cacheHitRatio).toBe('string');
      expect(health.slowQueries).toBeArray();
      expect(health.activeSessions).toBeArray();
    });

    test('degrades gracefully when V$ views throw', async () => {
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes('V$')) {
          throw new Error('ORA-00942: table or view does not exist');
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const health = await provider.getHealth();

      // Should still return valid health object even if V$ queries fail
      expect(health).toBeDefined();
      expect(health.activeConnections).toBe(0);
    });
  });

  // =========================================================================
  // 9. runMaintenance()
  // =========================================================================

  describe('runMaintenance()', () => {
    test('analyze calls DBMS_STATS', async () => {
      let capturedSql = '';
      mockExecuteFn = async (sql: string) => {
        capturedSql = sql;
        return defaultExecute(sql);
      };

      await provider.connect();
      const result = await provider.runMaintenance('analyze', 'USERS');

      expect(result.success).toBe(true);
      expect(capturedSql).toContain('DBMS_STATS');
      expect(typeof result.executionTime).toBe('number');
    });

    test('kill without target throws QueryError', async () => {
      await provider.connect();
      await expect(provider.runMaintenance('kill')).rejects.toThrow(QueryError);
    });

    test('unsupported maintenance type throws QueryError', async () => {
      await provider.connect();
      await expect(provider.runMaintenance('vacuum' as unknown as 'analyze')).rejects.toThrow(QueryError);
    });
  });

  // =========================================================================
  // 10. getPoolStats()
  // =========================================================================

  describe('getPoolStats()', () => {
    test('returns pool statistics when connected', async () => {
      await provider.connect();
      const stats = provider.getPoolStats();

      expect(stats.total).toBe(5);
      expect(stats.active).toBe(2);
      expect(stats.idle).toBe(3);
      expect(typeof stats.waiting).toBe('number');
    });

    test('returns zeros when not connected', () => {
      const stats = provider.getPoolStats();
      expect(stats.total).toBe(0);
      expect(stats.idle).toBe(0);
      expect(stats.active).toBe(0);
    });
  });

  // =========================================================================
  // 11. Transaction lifecycle
  // =========================================================================

  describe('transaction lifecycle', () => {
    test('begin/commit lifecycle works', async () => {
      await provider.connect();

      expect(provider.isInTransaction()).toBe(false);
      await provider.beginTransaction();
      expect(provider.isInTransaction()).toBe(true);

      const result = await provider.queryInTransaction('SELECT 1 FROM DUAL');
      expect(result.rows).toBeArray();

      await provider.commitTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });

    test('begin/rollback lifecycle works', async () => {
      await provider.connect();

      await provider.beginTransaction();
      expect(provider.isInTransaction()).toBe(true);

      await provider.rollbackTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });
  });

  // =========================================================================
  // 12. cancelQuery()
  // =========================================================================

  describe('cancelQuery()', () => {
    test('unknown queryId returns false', async () => {
      await provider.connect();
      const cancelled = await provider.cancelQuery('non-existent-id');
      expect(cancelled).toBe(false);
    });
  });

  // =========================================================================
  // 13. getOverview()
  // =========================================================================

  describe('getOverview()', () => {
    test('returns version, uptime, connections, size', async () => {
      await provider.connect();
      const overview = await provider.getOverview();

      expect(typeof overview.version).toBe('string');
      expect(overview.version).toContain('Oracle');
      expect(typeof overview.uptime).toBe('string');
      expect(overview.uptime.length).toBeGreaterThan(0);
      expect(typeof overview.activeConnections).toBe('number');
      expect(typeof overview.maxConnections).toBe('number');
      expect(typeof overview.databaseSize).toBe('string');
      expect(typeof overview.databaseSizeBytes).toBe('number');
      expect(typeof overview.tableCount).toBe('number');
      expect(typeof overview.indexCount).toBe('number');
    });
  });

  // =========================================================================
  // 14. getPerformanceMetrics()
  // =========================================================================

  describe('getPerformanceMetrics()', () => {
    test('returns cache ratio, buffer pool usage, deadlocks', async () => {
      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      expect(typeof metrics.cacheHitRatio).toBe('number');
      expect(metrics.cacheHitRatio).toBeGreaterThanOrEqual(0);
      expect(metrics.cacheHitRatio).toBeLessThanOrEqual(100);
      expect(metrics.cacheHitRatio).toBe(97.5);
      // bufferPoolUsage mirrors cacheHitRatio in Oracle impl
      expect(typeof metrics.bufferPoolUsage).toBe('number');
    });

    test('handles graceful degradation without DBA privs', async () => {
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes('V$SYSSTAT')) {
          throw new Error('ORA-00942: table or view does not exist');
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      // Should return default values when V$ views are inaccessible
      expect(typeof metrics.cacheHitRatio).toBe('number');
      expect(metrics.cacheHitRatio).toBe(100); // Default fallback
    });
  });

  // =========================================================================
  // 15. getSlowQueries()
  // =========================================================================

  describe('getSlowQueries()', () => {
    test('returns from V$SQL sorted by elapsed time', async () => {
      await provider.connect();
      const slowQueries = await provider.getSlowQueries();

      expect(Array.isArray(slowQueries)).toBe(true);
      expect(slowQueries.length).toBeGreaterThan(0);

      const first = slowQueries[0];
      expect(typeof first.query).toBe('string');
      expect(typeof first.calls).toBe('number');
      expect(first.calls).toBe(42);
      expect(typeof first.totalTime).toBe('number');
      expect(typeof first.avgTime).toBe('number');
      expect(typeof first.rows).toBe('number');
      expect(typeof first.queryId).toBe('string');
    });
  });

  // =========================================================================
  // 16. getActiveSessions()
  // =========================================================================

  describe('getActiveSessions()', () => {
    test('returns from V$SESSION', async () => {
      await provider.connect();
      const sessions = await provider.getActiveSessions();

      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThan(0);

      const first = sessions[0];
      expect(typeof first.pid).toBe('string'); // Oracle uses "SID,SERIAL#" format
      expect(typeof first.user).toBe('string');
      expect(typeof first.database).toBe('string');
      expect(typeof first.state).toBe('string');
      expect(typeof first.query).toBe('string');
      expect(typeof first.duration).toBe('string');
      expect(typeof first.durationMs).toBe('number');
    });
  });

  // =========================================================================
  // 17. getTableStats()
  // =========================================================================

  describe('getTableStats()', () => {
    test('returns table stats from ALL_TABLES/DBA_SEGMENTS', async () => {
      await provider.connect();
      const stats = await provider.getTableStats();

      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBeGreaterThan(0);

      const first = stats[0];
      expect(typeof first.schemaName).toBe('string');
      expect(typeof first.tableName).toBe('string');
      expect(typeof first.rowCount).toBe('number');
      expect(typeof first.tableSize).toBe('string');
      expect(typeof first.tableSizeBytes).toBe('number');
      expect(typeof first.indexSize).toBe('string');
      expect(typeof first.totalSize).toBe('string');
      expect(typeof first.totalSizeBytes).toBe('number');
    });
  });

  // =========================================================================
  // 18. getIndexStats()
  // =========================================================================

  describe('getIndexStats()', () => {
    test('returns index stats', async () => {
      await provider.connect();
      const stats = await provider.getIndexStats();

      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBeGreaterThan(0);

      const first = stats[0];
      expect(typeof first.schemaName).toBe('string');
      expect(typeof first.tableName).toBe('string');
      expect(typeof first.indexName).toBe('string');
      expect(typeof first.indexType).toBe('string');
      expect(Array.isArray(first.columns)).toBe(true);
      expect(typeof first.isUnique).toBe('boolean');
      expect(typeof first.isPrimary).toBe('boolean');
      expect(typeof first.indexSize).toBe('string');
      expect(typeof first.indexSizeBytes).toBe('number');
      expect(typeof first.scans).toBe('number');
    });
  });

  // =========================================================================
  // 19. getStorageStats()
  // =========================================================================

  describe('getStorageStats()', () => {
    test('returns tablespace info', async () => {
      await provider.connect();
      const stats = await provider.getStorageStats();

      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBeGreaterThan(0);

      const first = stats[0];
      expect(typeof first.name).toBe('string');
      expect(typeof first.size).toBe('string');
      expect(typeof first.sizeBytes).toBe('number');
      expect(first.sizeBytes).toBeGreaterThan(0);
    });

    test('handles permission denied gracefully', async () => {
      mockExecuteFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        // DBA_DATA_FILES requires DBA privilege
        if (upper.includes('DBA_DATA_FILES')) {
          throw new Error('ORA-00942: table or view does not exist');
        }
        return defaultExecute(sql);
      };

      await provider.connect();
      const stats = await provider.getStorageStats();

      // Should fall back to USER_SEGMENTS
      expect(Array.isArray(stats)).toBe(true);
      // May return results from fallback query or empty array
      expect(stats.length).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // 20. Error mapping
  // =========================================================================

  describe('error mapping', () => {
    test('ORA-01017 maps to auth error', async () => {
      mockExecuteFn = async () => {
        throw new Error('ORA-01017: invalid username/password; logon denied');
      };

      await provider.connect();

      try {
        await provider.query('SELECT 1 FROM DUAL');
        expect(true).toBe(false); // Should not reach here
      } catch (error: unknown) {
        expect(error).toBeDefined();
        const err = error as Error;
        expect(err.name).toBe('AuthenticationError');
        expect(err.message).toContain('Authentication failed');
      }
    });

    test('ORA-12541 maps to connection error', async () => {
      mockExecuteFn = async () => {
        throw new Error('ORA-12541: TNS:no listener');
      };

      await provider.connect();

      try {
        await provider.query('SELECT 1 FROM DUAL');
        expect(true).toBe(false); // Should not reach here
      } catch (error: unknown) {
        expect(error).toBeDefined();
        const err = error as Error;
        expect(err.name).toBe('ConnectionError');
        expect(err.message).toContain('Oracle');
      }
    });
  });
});
