import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Mock mssql BEFORE importing the provider
// ---------------------------------------------------------------------------

let mockQueryFn: (sql: string) => Promise<unknown>;

class MockRequest {
  private _transaction: unknown;

  constructor(transaction?: unknown) {
    this._transaction = transaction;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  input(_name: string, _val: unknown) {
    return this;
  }

  async query(sql: string) {
    return mockQueryFn(sql);
  }

  cancel() {}
}

class MockTransaction {
  private _pool: unknown;

  constructor(pool: unknown) {
    this._pool = pool;
  }

  async begin() {}
  async commit() {}
  async rollback() {}
}

class MockConnectionPool {
  private _config: unknown;
  public size = 10;
  public available = 7;
  public pending = 0;

  constructor(config: unknown) {
    this._config = config;
  }

  async connect() {
    return this;
  }

  async close() {}

  request() {
    return new MockRequest();
  }
}

mock.module('mssql', () => {
  return {
    default: {
      ConnectionPool: MockConnectionPool,
      Transaction: MockTransaction,
      Request: MockRequest,
    },
  };
});

// Now import the provider (after mock is in place)
import { MSSQLProvider } from '@/lib/db/providers/sql/mssql';
import { DatabaseConfigError, QueryError } from '@/lib/db/errors';
import type { DatabaseConnection } from '@/lib/types';

// ---------------------------------------------------------------------------
// Default mock query implementation
// ---------------------------------------------------------------------------

function defaultQuery(sql: string) {
  const upper = sql.toUpperCase();

  if (upper.includes('SELECT 1 AS TEST')) {
    return { recordset: [{ test: 1 }], rowsAffected: [1] };
  }

  if (upper.includes('SYS.DM_EXEC_SESSIONS') && upper.includes('COUNT')) {
    return { recordset: [{ cnt: 12 }], rowsAffected: [1] };
  }

  // Active sessions detail query (for getActiveSessions — matches DM_EXEC_SESSIONS with TOP but not COUNT)
  if (upper.includes('SYS.DM_EXEC_SESSIONS') && upper.includes('TOP') && !upper.includes('COUNT')) {
    return {
      recordset: [
        {
          pid: 55,
          user: 'sa',
          database: 'testdb',
          application_name: 'SSMS',
          client_addr: 'WORKSTATION1',
          state: 'sleeping',
          query: 'SELECT * FROM users',
          query_start: new Date().toISOString(),
          duration: '10s',
          duration_ms: 10000,
          wait_type: null,
          last_wait_type: 'ASYNC_NETWORK_IO',
          is_blocked: 0,
        },
      ],
      rowsAffected: [1],
    };
  }

  if (upper.includes('SYS.DM_EXEC_SESSIONS') && !upper.includes('COUNT')) {
    return {
      recordset: [
        { pid: 55, user: 'sa', database: 'testdb', state: 'sleeping', query: '', duration: '10s' },
      ],
      rowsAffected: [1],
    };
  }

  if (upper.includes('SYS.DATABASE_FILES') && upper.includes('SIZE_MB')) {
    return { recordset: [{ size_mb: 512 }], rowsAffected: [1] };
  }

  // Storage stats query (physical_name AS location)
  if (upper.includes('SYS.DATABASE_FILES') && upper.includes('PHYSICAL_NAME')) {
    return {
      recordset: [
        { name: 'testdb', location: '/data/testdb.mdf', size_bytes: 536870912, type_desc: 'ROWS' },
        { name: 'testdb_log', location: '/data/testdb_log.ldf', size_bytes: 67108864, type_desc: 'LOG' },
      ],
      rowsAffected: [2],
    };
  }

  if (upper.includes('SYS.DATABASE_FILES')) {
    return {
      recordset: [{ name: 'testdb', size_bytes: 536870912, location: '/data/testdb.mdf', type_desc: 'ROWS' }],
      rowsAffected: [1],
    };
  }

  if (upper.includes('SYS.DM_OS_PERFORMANCE_COUNTERS')) {
    return { recordset: [{ hit_ratio: 99.5 }], rowsAffected: [1] };
  }

  // Slow queries detail query (for getSlowQueries — has query_hash)
  if (upper.includes('SYS.DM_EXEC_QUERY_STATS') && upper.includes('QUERY_HASH')) {
    return {
      recordset: [
        {
          query_id: '0xABC123',
          query: 'SELECT * FROM big_table WHERE id > 1000',
          calls: 100,
          total_time: 5550.00,
          avg_time: 55.50,
          min_time: 10.00,
          max_time: 200.00,
          row_cnt: 500,
          logical_reads: 1000,
          physical_reads: 50,
        },
      ],
      rowsAffected: [1],
    };
  }

  if (upper.includes('SYS.DM_EXEC_QUERY_STATS')) {
    return {
      recordset: [{ query: 'SELECT * FROM big_table', calls: 100, avg_time_ms: 55.5, query_id: 'abc', total_time: 5550, avg_time: 55.5, row_cnt: 500, logical_reads: 1000, physical_reads: 50 }],
      rowsAffected: [1],
    };
  }

  if (upper.includes('INFORMATION_SCHEMA.COLUMNS')) {
    return {
      recordset: [
        { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'users', COLUMN_NAME: 'id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, ORDINAL_POSITION: 1 },
        { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'users', COLUMN_NAME: 'name', DATA_TYPE: 'nvarchar', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, ORDINAL_POSITION: 2 },
        { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'orders', COLUMN_NAME: 'id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, ORDINAL_POSITION: 1 },
      ],
      rowsAffected: [3],
    };
  }

  if (upper.includes('SYS.TABLES') && upper.includes('SYS.SCHEMAS') && upper.includes('SYS.PARTITIONS')) {
    return {
      recordset: [
        { schema_name: 'dbo', table_name: 'users', row_count: 100 },
        { schema_name: 'dbo', table_name: 'orders', row_count: 500 },
      ],
      rowsAffected: [2],
    };
  }

  // Table stats (for getTableStats — SYS.ALLOCATION_UNITS)
  if (upper.includes('SYS.TABLES') && upper.includes('SYS.ALLOCATION_UNITS')) {
    return {
      recordset: [
        { schema_name: 'dbo', table_name: 'users', row_count: 100, total_size_bytes: 81920, used_size_bytes: 65536, table_size_bytes: 49152, index_size_bytes: 16384, last_stats_update: '2026-02-14T00:00:00Z' },
        { schema_name: 'dbo', table_name: 'orders', row_count: 500, total_size_bytes: 163840, used_size_bytes: 131072, table_size_bytes: 98304, index_size_bytes: 32768, last_stats_update: '2026-02-14T00:00:00Z' },
      ],
      rowsAffected: [2],
    };
  }

  if (upper.includes('SYS.INDEXES') && upper.includes('IS_PRIMARY_KEY = 1')) {
    return {
      recordset: [{ schema_name: 'dbo', table_name: 'users', column_name: 'id' }],
      rowsAffected: [1],
    };
  }

  if (upper.includes('SYS.FOREIGN_KEYS')) {
    return {
      recordset: [{ schema_name: 'dbo', table_name: 'orders', column_name: 'user_id', ref_table: 'users', ref_column: 'id' }],
      rowsAffected: [1],
    };
  }

  // Index stats (for getIndexStats — SYS.DM_DB_INDEX_USAGE_STATS)
  if (upper.includes('SYS.INDEXES') && upper.includes('SYS.DM_DB_INDEX_USAGE_STATS')) {
    return {
      recordset: [
        { schema_name: 'dbo', table_name: 'users', index_name: 'PK_users', index_type: 'CLUSTERED', is_unique: true, is_primary_key: true, index_size_bytes: 16384, scans: 250 },
        { schema_name: 'dbo', table_name: 'users', index_name: 'IX_users_name', index_type: 'NONCLUSTERED', is_unique: false, is_primary_key: false, index_size_bytes: 8192, scans: 120 },
      ],
      rowsAffected: [2],
    };
  }

  // Index columns (for getIndexStats second query)
  if (upper.includes('SYS.INDEX_COLUMNS') && upper.includes('SYS.COLUMNS') && upper.includes('KEY_ORDINAL')) {
    return {
      recordset: [
        { schema_name: 'dbo', table_name: 'users', index_name: 'PK_users', column_name: 'id', key_ordinal: 1 },
        { schema_name: 'dbo', table_name: 'users', index_name: 'IX_users_name', column_name: 'name', key_ordinal: 1 },
      ],
      rowsAffected: [2],
    };
  }

  if (upper.includes('SYS.INDEXES') && upper.includes('IS_PRIMARY_KEY = 0')) {
    return {
      recordset: [{ schema_name: 'dbo', table_name: 'users', index_name: 'IX_users_name', is_unique: false, column_name: 'name', key_ordinal: 1 }],
      rowsAffected: [1],
    };
  }

  if (upper.includes('UPDATE STATISTICS') || upper.includes('SP_UPDATESTATS') || upper.includes('DBCC CHECKDB') || upper.includes('ALTER INDEX') || upper.includes('KILL')) {
    return { recordset: [], rowsAffected: [0] };
  }

  if (upper.includes('@@VERSION')) {
    return { recordset: [{ version: 'Microsoft SQL Server 2022 - 16.0.1000.6' }], rowsAffected: [1] };
  }

  if (upper.includes('SYS.DM_OS_SYS_INFO')) {
    return { recordset: [{ sqlserver_start_time: new Date(Date.now() - 86400 * 1000).toISOString(), uptime_seconds: 86400 }], rowsAffected: [1] };
  }

  // Overview connections query (active_connections + max_connections)
  if (upper.includes('SYS.CONFIGURATIONS') && upper.includes('USER CONNECTIONS')) {
    return { recordset: [{ active_connections: 5, max_connections: 32767 }], rowsAffected: [1] };
  }

  if (upper.includes('SYS.CONFIGURATIONS')) {
    return { recordset: [{ active_connections: 5, max_connections: 32767 }], rowsAffected: [1] };
  }

  // Table/index counts for overview
  if (upper.includes('SYS.TABLES') && upper.includes('TABLE_COUNT') && upper.includes('INDEX_COUNT')) {
    return { recordset: [{ table_count: 5, index_count: 12 }], rowsAffected: [1] };
  }

  // Database size bytes for overview
  if (upper.includes('SYS.DATABASE_FILES') && upper.includes('SIZE_BYTES')) {
    return { recordset: [{ size_bytes: 536870912 }], rowsAffected: [1] };
  }

  // Default
  return { recordset: [{ id: 1, name: 'test' }], rowsAffected: [1] };
}

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

const baseConfig: DatabaseConnection = {
  id: 'test-mssql',
  name: 'Test MSSQL',
  type: 'mssql',
  host: 'localhost',
  port: 1433,
  database: 'testdb',
  user: 'sa',
  password: 'test',
  createdAt: new Date(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MSSQLProvider', () => {
  let provider: MSSQLProvider;

  beforeEach(() => {
    mockQueryFn = async (sql: string) => defaultQuery(sql);
    provider = new MSSQLProvider(baseConfig);
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
    test('throws DatabaseConfigError when host is missing', () => {
      expect(() => {
        new MSSQLProvider({
          ...baseConfig,
          host: undefined,
          connectionString: undefined,
        } as unknown as DatabaseConnection);
      }).toThrow(DatabaseConfigError);
    });

    test('throws DatabaseConfigError when database is missing', () => {
      expect(() => {
        new MSSQLProvider({
          ...baseConfig,
          database: undefined,
          connectionString: undefined,
        } as unknown as DatabaseConnection);
      }).toThrow(DatabaseConfigError);
    });

    test('connectionString bypasses host/database validation', () => {
      expect(() => {
        new MSSQLProvider({
          ...baseConfig,
          host: undefined,
          database: undefined,
          connectionString: 'Server=localhost;Database=testdb;User Id=sa;Password=test;',
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
    test('returns rows from recordset', async () => {
      await provider.connect();
      const result = await provider.query('SELECT id, name FROM users');

      expect(result.rows).toBeArray();
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.fields).toBeArray();
      expect(typeof result.executionTime).toBe('number');
    });
  });

  // =========================================================================
  // 4. getCapabilities()
  // =========================================================================

  describe('getCapabilities()', () => {
    test('returns correct capabilities for MSSQL', () => {
      const caps = provider.getCapabilities();
      expect(caps.defaultPort).toBe(1433);
      expect(caps.maintenanceOperations).toContain('analyze');
      expect(caps.maintenanceOperations).toContain('check');
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
    test('returns Update Statistics as analyzeAction', () => {
      const labels = provider.getLabels();
      expect(labels.analyzeAction).toBe('Update Statistics');
    });
  });

  // =========================================================================
  // 6. prepareQuery()
  // =========================================================================

  describe('prepareQuery()', () => {
    test('SELECT gets TOP N', () => {
      const result = provider.prepareQuery('SELECT * FROM users');
      expect(result.query).toMatch(/SELECT\s+TOP\s+\d+/i);
      expect(result.wasLimited).toBe(true);
    });

    test('SELECT with offset gets OFFSET FETCH and ORDER BY injected', () => {
      const result = provider.prepareQuery('SELECT * FROM users', { offset: 10, limit: 50 });
      expect(result.query).toContain('ORDER BY');
      expect(result.query).toContain('OFFSET 10 ROWS');
      expect(result.query).toContain('FETCH NEXT 50 ROWS ONLY');
      expect(result.wasLimited).toBe(true);
    });

    test('non-SELECT query is unchanged', () => {
      const sql = "INSERT INTO users (name) VALUES ('test')";
      const result = provider.prepareQuery(sql);
      expect(result.query).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    test('existing TOP leaves query unchanged', () => {
      const sql = 'SELECT TOP 10 * FROM users';
      const result = provider.prepareQuery(sql);
      expect(result.wasLimited).toBe(false);
    });
  });

  // =========================================================================
  // 7. getSchema()
  // =========================================================================

  describe('getSchema()', () => {
    test('returns tables with schema prefix handling', async () => {
      await provider.connect();
      const schema = await provider.getSchema();

      expect(schema).toBeArray();
      expect(schema.length).toBe(2);

      // dbo schema should not have prefix for display name
      const usersTable = schema.find((t) => t.name === 'users');
      expect(usersTable).toBeDefined();
      expect(usersTable!.columns.length).toBeGreaterThanOrEqual(2);

      // Check PK
      const idCol = usersTable!.columns.find((c) => c.name === 'id');
      expect(idCol).toBeDefined();
      expect(idCol!.isPrimary).toBe(true);

      // Check FK on orders
      const ordersTable = schema.find((t) => t.name === 'orders');
      expect(ordersTable).toBeDefined();
      expect(ordersTable!.foreignKeys!.length).toBeGreaterThan(0);
      expect(ordersTable!.foreignKeys![0].referencedTable).toBe('users');
    });
  });

  // =========================================================================
  // 8. getHealth()
  // =========================================================================

  describe('getHealth()', () => {
    test('returns health data', async () => {
      await provider.connect();
      const health = await provider.getHealth();

      expect(typeof health.activeConnections).toBe('number');
      expect(typeof health.databaseSize).toBe('string');
      expect(typeof health.cacheHitRatio).toBe('string');
      expect(health.slowQueries).toBeArray();
      expect(health.activeSessions).toBeArray();
    });
  });

  // =========================================================================
  // 9. runMaintenance()
  // =========================================================================

  describe('runMaintenance()', () => {
    test('analyze with target calls UPDATE STATISTICS', async () => {
      let capturedSql = '';
      mockQueryFn = async (sql: string) => {
        capturedSql = sql;
        return defaultQuery(sql);
      };

      await provider.connect();
      const result = await provider.runMaintenance('analyze', 'users');

      expect(result.success).toBe(true);
      expect(capturedSql).toContain('UPDATE STATISTICS');
    });

    test('analyze without target calls sp_updatestats', async () => {
      let capturedSql = '';
      mockQueryFn = async (sql: string) => {
        capturedSql = sql;
        return defaultQuery(sql);
      };

      await provider.connect();
      const result = await provider.runMaintenance('analyze');

      expect(result.success).toBe(true);
      expect(capturedSql).toContain('sp_updatestats');
    });

    test('check calls DBCC CHECKDB', async () => {
      let capturedSql = '';
      mockQueryFn = async (sql: string) => {
        capturedSql = sql;
        return defaultQuery(sql);
      };

      await provider.connect();
      const result = await provider.runMaintenance('check');

      expect(result.success).toBe(true);
      expect(capturedSql).toContain('DBCC CHECKDB');
    });

    test('kill without target throws QueryError', async () => {
      await provider.connect();
      await expect(provider.runMaintenance('kill')).rejects.toThrow(QueryError);
    });

    test('unsupported maintenance type throws', async () => {
      await provider.connect();
      await expect(provider.runMaintenance('vacuum' as unknown as 'analyze')).rejects.toThrow();
    });
  });

  // =========================================================================
  // 10. getPoolStats()
  // =========================================================================

  describe('getPoolStats()', () => {
    test('returns pool size, available, pending when connected', async () => {
      await provider.connect();
      const stats = provider.getPoolStats();

      expect(stats.total).toBe(10);
      expect(stats.idle).toBe(7);
      expect(stats.active).toBe(3);
      expect(stats.waiting).toBe(0);
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

      const result = await provider.queryInTransaction('SELECT 1 AS test');
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
    test('returns version, uptime, connections, size, counts', async () => {
      await provider.connect();
      const overview = await provider.getOverview();

      expect(typeof overview.version).toBe('string');
      expect(overview.version).toContain('Microsoft SQL Server');
      expect(typeof overview.uptime).toBe('string');
      expect(overview.uptime.length).toBeGreaterThan(0);
      expect(typeof overview.activeConnections).toBe('number');
      expect(typeof overview.maxConnections).toBe('number');
      expect(typeof overview.databaseSize).toBe('string');
      expect(typeof overview.databaseSizeBytes).toBe('number');
      expect(typeof overview.tableCount).toBe('number');
      expect(typeof overview.indexCount).toBe('number');
    });

    test('Azure SQL detection from hostname', () => {
      const azureProvider = new MSSQLProvider({
        ...baseConfig,
        host: 'myserver.database.windows.net',
      });
      // Azure host should not throw; the buildConfig should detect it
      expect(azureProvider).toBeDefined();
    });
  });

  // =========================================================================
  // 14. getPerformanceMetrics()
  // =========================================================================

  describe('getPerformanceMetrics()', () => {
    test('returns cache hit ratio and deadlocks', async () => {
      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      expect(typeof metrics.cacheHitRatio).toBe('number');
      expect(metrics.cacheHitRatio).toBeGreaterThanOrEqual(0);
      expect(metrics.cacheHitRatio).toBeLessThanOrEqual(100);
      expect(metrics.cacheHitRatio).toBe(99.5);
      // bufferPoolUsage mirrors cacheHitRatio in MSSQL impl
      expect(typeof metrics.bufferPoolUsage).toBe('number');
    });
  });

  // =========================================================================
  // 15. getSlowQueries()
  // =========================================================================

  describe('getSlowQueries()', () => {
    test('returns from dm_exec_query_stats', async () => {
      await provider.connect();
      const slowQueries = await provider.getSlowQueries();

      expect(Array.isArray(slowQueries)).toBe(true);
      expect(slowQueries.length).toBeGreaterThan(0);

      const first = slowQueries[0];
      expect(typeof first.query).toBe('string');
      expect(typeof first.calls).toBe('number');
      expect(first.calls).toBe(100);
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
    test('returns sessions from dm_exec_sessions', async () => {
      await provider.connect();
      const sessions = await provider.getActiveSessions();

      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThan(0);

      const first = sessions[0];
      expect(typeof first.pid).toBe('number');
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
    test('returns table sizes and row counts', async () => {
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
    test('returns index usage stats', async () => {
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
    test('returns database file info', async () => {
      await provider.connect();
      const stats = await provider.getStorageStats();

      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBeGreaterThan(0);

      const first = stats[0];
      expect(typeof first.name).toBe('string');
      expect(typeof first.location).toBe('string');
      expect(typeof first.size).toBe('string');
      expect(typeof first.sizeBytes).toBe('number');
      expect(first.sizeBytes).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 20. Error mapping
  // =========================================================================

  describe('error mapping', () => {
    test('Login failed maps to auth error', async () => {
      // Connect first with default mock, then swap to error mock
      await provider.connect();

      mockQueryFn = async () => {
        throw new Error('Login failed for user "sa"');
      };

      try {
        await provider.query('SELECT 1');
        expect(true).toBe(false); // Should not reach here
      } catch (error: unknown) {
        expect(error).toBeDefined();
        const err = error as Error;
        expect(err.name).toBe('AuthenticationError');
        expect(err.message).toContain('Authentication failed');
      }
    });

    test('Cannot open database maps to config error', async () => {
      // Connect first with default mock, then swap to error mock
      await provider.connect();

      mockQueryFn = async () => {
        throw new Error('Cannot open database "baddb" requested by the login');
      };

      try {
        await provider.query('SELECT 1');
        expect(true).toBe(false); // Should not reach here
      } catch (error: unknown) {
        expect(error).toBeDefined();
        const err = error as Error;
        expect(err.name).toBe('ConnectionError');
        expect(err.message).toContain('Database not found');
      }
    });
  });
});
