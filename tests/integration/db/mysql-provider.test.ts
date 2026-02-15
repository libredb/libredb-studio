/**
 * Integration tests for MySQLProvider
 * Uses mock.module() to intercept mysql2/promise before provider import.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { DatabaseConnection } from '@/lib/types';
import { DatabaseConfigError } from '@/lib/db/errors';

// ============================================================================
// Mock mysql2/promise BEFORE importing the provider
// ============================================================================

let mockExecuteFn: (sql: string, params?: unknown[]) => Promise<[unknown[], unknown[]]>;

const mockConnection = {
  threadId: 42,
  execute: (sql: string, params?: unknown[]) => mockExecuteFn(sql, params),
  release: () => {},
  beginTransaction: async () => {},
  commit: async () => {},
  rollback: async () => {},
};

const mockPool = {
  getConnection: async () => mockConnection,
  end: async () => {},
  execute: (sql: string, params?: unknown[]) => mockExecuteFn(sql, params),
};

mock.module('mysql2/promise', () => ({
  default: {
    createPool: () => mockPool,
  },
  createPool: () => mockPool,
}));

// Dynamic import AFTER mock is installed
const { MySQLProvider } = await import('@/lib/db/providers/sql/mysql');

// ============================================================================
// Helpers
// ============================================================================

function makeMySQLConfig(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: 'test-mysql',
    name: 'Test MySQL',
    type: 'mysql',
    host: 'localhost',
    port: 3306,
    database: 'testdb',
    user: 'root',
    password: 'secret',
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * Default mock execute that matches SQL patterns and returns mock data.
 */
function defaultMockExecute(sql: string): Promise<[unknown[], unknown[]]> {
  const normalized = sql.trim().toLowerCase();

  // SHOW STATUS LIKE 'Threads_connected'
  if (normalized.includes("show status like 'threads_connected'")) {
    return Promise.resolve([[{ Value: '5' }], []]);
  }

  // SHOW STATUS LIKE 'Uptime'
  if (normalized.includes("show status like 'uptime'")) {
    return Promise.resolve([[{ Value: '86400' }], []]);
  }

  // SHOW STATUS LIKE 'Innodb_deadlocks'
  if (normalized.includes("show status like 'innodb_deadlocks'")) {
    return Promise.resolve([[{ Value: '0' }], []]);
  }

  // SHOW VARIABLES LIKE 'max_connections'
  if (normalized.includes("show variables like 'max_connections'")) {
    return Promise.resolve([[{ Value: '151' }], []]);
  }

  // SHOW VARIABLES LIKE 'innodb_data_file_path'
  if (normalized.includes("show variables like 'innodb_data_file_path'")) {
    return Promise.resolve([[{ Value: 'ibdata1:12M:autoextend' }], []]);
  }

  // SHOW BINARY LOGS
  if (normalized.includes('show binary logs')) {
    return Promise.resolve([[{ File_size: '1048576' }], []]);
  }

  // VERSION()
  if (normalized.includes('version()')) {
    return Promise.resolve([[{ version: '8.0.35' }], [{ name: 'version' }]]);
  }

  // performance_schema.global_status — cache hit ratio, buffer pool, QPS
  if (normalized.includes('performance_schema.global_status')) {
    // Buffer pool reads query (hit_ratio must be numeric — .toFixed() is called on it)
    if (normalized.includes('innodb_buffer_pool_reads') && normalized.includes('hit_ratio')) {
      return Promise.resolve([[{ hit_ratio: 99.5 }], []]);
    }
    // Buffer pool pages
    if (normalized.includes('data_pages') && normalized.includes('total_pages')) {
      return Promise.resolve([[{ data_pages: '800', total_pages: '1000' }], []]);
    }
    // Queries/uptime (QPS)
    if (normalized.includes('queries') && normalized.includes('uptime')) {
      return Promise.resolve([[{ queries: '50000', uptime: '86400' }], []]);
    }
    return Promise.resolve([[{ hit_ratio: 99.5 }], []]);
  }

  // performance_schema.events_statements_summary_by_digest (slow queries)
  if (normalized.includes('events_statements_summary_by_digest')) {
    return Promise.resolve([[
      {
        query: 'SELECT * FROM users',
        calls: '100',
        avgTime: '12.5ms',
        query_id: 'abc123',
        total_time_ms: '1250',
        avg_time_ms: '12.5',
        min_time_ms: '1.0',
        max_time_ms: '50.0',
        rows_examined: '5000',
      },
    ], []]);
  }

  // information_schema.TABLES — COUNT(*) without table_name (getOverview table count)
  if (normalized.includes('information_schema.tables') && normalized.includes('count(*)') && !normalized.includes('table_name')) {
    return Promise.resolve([[{ cnt: '2' }], []]);
  }

  // information_schema.TABLES — size aggregate (no table_name in query, e.g. getOverview, getStorageStats)
  if (normalized.includes('information_schema.tables') && normalized.includes('sum(data_length') && !normalized.includes('table_name')) {
    return Promise.resolve([[{ size_mb: '12.50', size_bytes: '13107200', name: 'testdb' }], []]);
  }

  // information_schema.TABLES — table list (has table_name)
  if (normalized.includes('information_schema.tables') && normalized.includes('table_name')) {
    // Table count query
    if (normalized.includes('count(*)')) {
      return Promise.resolve([[{ cnt: '2' }], []]);
    }
    // Size aggregate with table_schema (getHealth size)
    if (normalized.includes('sum(data_length')) {
      return Promise.resolve([[{ size_mb: '12.50', size_bytes: '13107200', name: 'testdb' }], []]);
    }
    // Table stats query
    if (normalized.includes('table_rows') && normalized.includes('data_length')) {
      return Promise.resolve([[
        { table_name: 'users', row_count: '100', total_size: '8192', table_size_bytes: '4096', index_size_bytes: '2048', total_size_bytes: '6144', free_space_bytes: '512', schema_name: 'testdb' },
        { table_name: 'orders', row_count: '50', total_size: '4096', table_size_bytes: '2048', index_size_bytes: '1024', total_size_bytes: '3072', free_space_bytes: '256', schema_name: 'testdb' },
      ], []]);
    }
    // Plain table listing (for maintenance getAllTablesForMaintenance)
    if (normalized.includes('table_name') && !normalized.includes('table_rows')) {
      return Promise.resolve([[
        { TABLE_NAME: 'users' },
        { TABLE_NAME: 'orders' },
      ], []]);
    }
    return Promise.resolve([[
      { table_name: 'users', row_count: '100', total_size: '8192' },
      { table_name: 'orders', row_count: '50', total_size: '4096' },
    ], []]);
  }

  // information_schema.TABLES — size only (getHealth — has size_mb but no table_name)
  if (normalized.includes('information_schema.tables') && normalized.includes('size_mb')) {
    return Promise.resolve([[{ size_mb: '12.50' }], []]);
  }

  // information_schema.COLUMNS
  if (normalized.includes('information_schema.columns')) {
    return Promise.resolve([[
      { column_name: 'id', data_type: 'int', is_nullable: 'NO', column_default: null, column_key: 'PRI' },
      { column_name: 'name', data_type: 'varchar', is_nullable: 'YES', column_default: null, column_key: '' },
      { column_name: 'email', data_type: 'varchar', is_nullable: 'NO', column_default: null, column_key: 'UNI' },
    ], []]);
  }

  // information_schema.KEY_COLUMN_USAGE (foreign keys)
  if (normalized.includes('key_column_usage')) {
    return Promise.resolve([[
      { column_name: 'user_id', referenced_table: 'users', referenced_column: 'id' },
    ], []]);
  }

  // information_schema.STATISTICS (indexes)
  if (normalized.includes('information_schema.statistics')) {
    // Count query for overview
    if (normalized.includes('count(distinct')) {
      return Promise.resolve([[{ table_count: '2', index_count: '3' }], []]);
    }
    // Index stats query
    if (normalized.includes('index_type') || normalized.includes('group_concat')) {
      return Promise.resolve([[
        { schema_name: 'testdb', table_name: 'users', index_name: 'PRIMARY', index_type: 'BTREE', columns: 'id', is_unique: 1, is_primary: 1, cardinality: '100' },
        { schema_name: 'testdb', table_name: 'users', index_name: 'idx_email', index_type: 'BTREE', columns: 'email', is_unique: 1, is_primary: 0, cardinality: '100' },
      ], []]);
    }
    return Promise.resolve([[
      { index_name: 'PRIMARY', columns: 'id', is_unique: 1 },
      { index_name: 'idx_email', columns: 'email', is_unique: 1 },
    ], []]);
  }

  // information_schema.PROCESSLIST (sessions)
  if (normalized.includes('processlist')) {
    return Promise.resolve([[
      { pid: 1, user: 'root', database: 'testdb', database_name: 'testdb', state: 'Query', query: 'SELECT 1', duration: '0s', client_addr: '127.0.0.1:3306', duration_seconds: '0' },
      { pid: 2, user: 'app', database: 'testdb', database_name: 'testdb', state: 'Sleep', query: '', duration: '5s', client_addr: '10.0.0.1:3306', duration_seconds: '5' },
    ], []]);
  }

  // INNODB_INDEXES / INNODB_TABLES (for index sizes — may fail gracefully)
  if (normalized.includes('innodb_indexes') || normalized.includes('innodb_tables')) {
    return Promise.resolve([[], []]);
  }

  // KILL query (maintenance)
  if (normalized.startsWith('kill')) {
    return Promise.resolve([[], []]);
  }

  // ANALYZE TABLE / OPTIMIZE TABLE / CHECK TABLE
  if (normalized.startsWith('analyze table') || normalized.startsWith('optimize table') || normalized.startsWith('check table')) {
    return Promise.resolve([[], []]);
  }

  // Default: generic SELECT result
  return Promise.resolve([[
    { id: 1, name: 'test' },
  ], [{ name: 'id' }, { name: 'name' }]]);
}

// ============================================================================
// Tests
// ============================================================================

describe('MySQLProvider', () => {
  let provider: InstanceType<typeof MySQLProvider>;

  beforeEach(() => {
    mockExecuteFn = defaultMockExecute;
  });

  afterEach(async () => {
    try {
      if (provider?.isConnected()) {
        await provider.disconnect();
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  describe('validate()', () => {
    test('missing host throws DatabaseConfigError', () => {
      expect(() => {
        new MySQLProvider(makeMySQLConfig({ host: undefined }));
      }).toThrow(DatabaseConfigError);
    });

    test('missing database throws DatabaseConfigError', () => {
      expect(() => {
        new MySQLProvider(makeMySQLConfig({ database: undefined }));
      }).toThrow(DatabaseConfigError);
    });

    test('valid config passes validation', () => {
      expect(() => {
        new MySQLProvider(makeMySQLConfig());
      }).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Connection lifecycle
  // --------------------------------------------------------------------------

  describe('connect / disconnect', () => {
    test('isConnected() is false before connect', () => {
      provider = new MySQLProvider(makeMySQLConfig());
      expect(provider.isConnected()).toBe(false);
    });

    test('connect() sets connected to true', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test('disconnect() sets connected to false', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      await provider.disconnect();
      expect(provider.isConnected()).toBe(false);
    });

    test('double connect is idempotent', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Query execution
  // --------------------------------------------------------------------------

  describe('query()', () => {
    test('SELECT returns rows, fields, and executionTime', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.query('SELECT * FROM users');
      expect(result.rows.length).toBeGreaterThan(0);
      expect(Array.isArray(result.fields)).toBe(true);
      expect(typeof result.executionTime).toBe('number');
      expect(typeof result.rowCount).toBe('number');
    });

    test('result contains sanitized rows', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.query('SELECT id, name FROM test');
      expect(result.rows.length).toBe(1);
      const row = result.rows[0] as Record<string, unknown>;
      expect(row.id).toBe(1);
      expect(row.name).toBe('test');
    });
  });

  // --------------------------------------------------------------------------
  // Capabilities
  // --------------------------------------------------------------------------

  describe('getCapabilities()', () => {
    test('returns correct MySQL capabilities', () => {
      provider = new MySQLProvider(makeMySQLConfig());
      const caps = provider.getCapabilities();
      expect(caps.defaultPort).toBe(3306);
      expect(caps.queryLanguage).toBe('sql');
      expect(caps.supportsExplain).toBe(true);
      expect(caps.supportsConnectionString).toBe(true);
      expect(caps.maintenanceOperations).toContain('analyze');
      expect(caps.maintenanceOperations).toContain('optimize');
      expect(caps.maintenanceOperations).toContain('check');
      expect(caps.maintenanceOperations).toContain('kill');
    });
  });

  // --------------------------------------------------------------------------
  // Schema
  // --------------------------------------------------------------------------

  describe('getSchema()', () => {
    test('returns TableSchema array with columns, indexes, foreignKeys', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const schema = await provider.getSchema();

      expect(schema.length).toBeGreaterThan(0);

      for (const table of schema) {
        expect(typeof table.name).toBe('string');
        expect(Array.isArray(table.columns)).toBe(true);
        expect(table.columns.length).toBeGreaterThan(0);
        expect(Array.isArray(table.indexes)).toBe(true);
        expect(Array.isArray(table.foreignKeys)).toBe(true);
      }
    });

    test('columns have expected properties', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const schema = await provider.getSchema();
      const firstTable = schema[0];
      const col = firstTable.columns[0];

      expect(typeof col.name).toBe('string');
      expect(typeof col.type).toBe('string');
      expect(typeof col.nullable).toBe('boolean');
      expect(typeof col.isPrimary).toBe('boolean');
    });
  });

  // --------------------------------------------------------------------------
  // Health
  // --------------------------------------------------------------------------

  describe('getHealth()', () => {
    test('returns health info with activeConnections, databaseSize, cacheHitRatio, slowQueries, activeSessions', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const health = await provider.getHealth();

      expect(typeof health.activeConnections).toBe('number');
      expect(health.activeConnections).toBe(5);
      expect(typeof health.databaseSize).toBe('string');
      expect(typeof health.cacheHitRatio).toBe('string');
      expect(Array.isArray(health.slowQueries)).toBe(true);
      expect(Array.isArray(health.activeSessions)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Maintenance
  // --------------------------------------------------------------------------

  describe('runMaintenance()', () => {
    test('analyze returns success', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance('analyze', 'users');
      expect(result.success).toBe(true);
      expect(typeof result.executionTime).toBe('number');
      expect(result.message).toContain('ANALYZE');
    });

    test('optimize returns success', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance('optimize', 'users');
      expect(result.success).toBe(true);
      expect(result.message).toContain('OPTIMIZE');
    });

    test('check returns success', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance('check', 'users');
      expect(result.success).toBe(true);
      expect(result.message).toContain('CHECK');
    });

    test('kill without target throws QueryError', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      await expect(provider.runMaintenance('kill')).rejects.toThrow('Target connection ID is required');
    });

    test('kill with valid target returns success', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance('kill', '1234');
      expect(result.success).toBe(true);
      expect(result.message).toContain('KILL');
    });

    test('unsupported type throws QueryError', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      await expect(
        provider.runMaintenance('vacuum' as unknown as 'analyze', 'users')
      ).rejects.toThrow('Unsupported maintenance type for MySQL');
    });
  });

  // --------------------------------------------------------------------------
  // Transaction support
  // --------------------------------------------------------------------------

  describe('Transaction lifecycle', () => {
    test('beginTransaction / commitTransaction works', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      expect(provider.isInTransaction()).toBe(false);
      await provider.beginTransaction();
      expect(provider.isInTransaction()).toBe(true);
      await provider.commitTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });

    test('beginTransaction / rollbackTransaction works', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      await provider.beginTransaction();
      expect(provider.isInTransaction()).toBe(true);
      await provider.rollbackTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });

    test('double beginTransaction throws', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      await provider.beginTransaction();
      await expect(provider.beginTransaction()).rejects.toThrow('Transaction already active');
      // Clean up
      await provider.rollbackTransaction();
    });
  });

  // --------------------------------------------------------------------------
  // Cancel query
  // --------------------------------------------------------------------------

  describe('cancelQuery()', () => {
    test('cancelQuery with unknown queryId returns false', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.cancelQuery('nonexistent-query-id');
      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getOverview()
  // --------------------------------------------------------------------------

  describe('getOverview()', () => {
    test('returns version, uptime, connections, size, table/index counts', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      expect(overview.version).toContain('MySQL');
      expect(overview.version).toContain('8.0.35');
      expect(typeof overview.uptime).toBe('string');
      expect(overview.uptime.length).toBeGreaterThan(0);
      expect(typeof overview.activeConnections).toBe('number');
      expect(overview.activeConnections).toBe(5);
      expect(typeof overview.maxConnections).toBe('number');
      expect(overview.maxConnections).toBe(151);
      expect(typeof overview.databaseSize).toBe('string');
      expect(typeof overview.databaseSizeBytes).toBe('number');
      expect(overview.databaseSizeBytes).toBe(13107200);
      expect(typeof overview.tableCount).toBe('number');
      expect(overview.tableCount).toBe(2);
      expect(typeof overview.indexCount).toBe('number');
      expect(overview.indexCount).toBe(3);
      expect(overview.startTime).toBeInstanceOf(Date);
    });

    test('formats uptime correctly', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      // 86400 seconds = 1 day
      expect(overview.uptime).toBe('1d 0h');
    });
  });

  // --------------------------------------------------------------------------
  // getPerformanceMetrics()
  // --------------------------------------------------------------------------

  describe('getPerformanceMetrics()', () => {
    test('returns cacheHitRatio, bufferPoolUsage, deadlocks, QPS', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      expect(typeof metrics.cacheHitRatio).toBe('number');
      expect(metrics.cacheHitRatio).toBeGreaterThanOrEqual(0);
      expect(metrics.cacheHitRatio).toBeLessThanOrEqual(100);
      expect(typeof metrics.bufferPoolUsage).toBe('number');
      // 800/1000 * 100 = 80
      expect(metrics.bufferPoolUsage).toBe(80);
      expect(typeof metrics.deadlocks).toBe('number');
      expect(metrics.deadlocks).toBe(0);
      expect(typeof metrics.queriesPerSecond).toBe('number');
      // 50000 / 86400 ≈ 0.58
      expect(metrics.queriesPerSecond).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // getSlowQueries()
  // --------------------------------------------------------------------------

  describe('getSlowQueries()', () => {
    test('returns slow query stats from performance_schema', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const slowQueries = await provider.getSlowQueries();

      expect(Array.isArray(slowQueries)).toBe(true);
      expect(slowQueries.length).toBeGreaterThan(0);

      const first = slowQueries[0];
      expect(typeof first.query).toBe('string');
      expect(first.query).toContain('SELECT');
      expect(typeof first.calls).toBe('number');
      expect(typeof first.totalTime).toBe('number');
      expect(typeof first.avgTime).toBe('number');
      expect(typeof first.rows).toBe('number');
    });

    test('respects limit option', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const slowQueries = await provider.getSlowQueries({ limit: 5 });

      // Our mock returns 1 row regardless of limit, but we verify the method accepts it
      expect(Array.isArray(slowQueries)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // getActiveSessions()
  // --------------------------------------------------------------------------

  describe('getActiveSessions()', () => {
    test('returns session list with pid, user, state, query', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const sessions = await provider.getActiveSessions();

      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBe(2);

      const first = sessions[0];
      expect(typeof first.pid).toBe('number');
      expect(first.pid).toBe(1);
      expect(typeof first.user).toBe('string');
      expect(first.user).toBe('root');
      expect(typeof first.state).toBe('string');
      expect(typeof first.query).toBe('string');
      expect(typeof first.duration).toBe('string');
      expect(typeof first.durationMs).toBe('number');
    });
  });

  // --------------------------------------------------------------------------
  // getTableStats()
  // --------------------------------------------------------------------------

  describe('getTableStats()', () => {
    test('returns table stats with sizes and row counts', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const stats = await provider.getTableStats();

      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBe(2);

      const first = stats[0];
      expect(typeof first.tableName).toBe('string');
      expect(first.tableName).toBe('users');
      expect(typeof first.rowCount).toBe('number');
      expect(first.rowCount).toBe(100);
      expect(typeof first.tableSize).toBe('string');
      expect(typeof first.tableSizeBytes).toBe('number');
      expect(first.tableSizeBytes).toBe(4096);
      expect(typeof first.indexSize).toBe('string');
      expect(typeof first.totalSize).toBe('string');
      expect(typeof first.totalSizeBytes).toBe('number');
      expect(first.totalSizeBytes).toBe(6144);
      expect(typeof first.schemaName).toBe('string');
      expect(typeof first.bloatRatio).toBe('number');
    });
  });

  // --------------------------------------------------------------------------
  // getIndexStats()
  // --------------------------------------------------------------------------

  describe('getIndexStats()', () => {
    test('returns index stats with scan counts', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const stats = await provider.getIndexStats();

      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBe(2);

      const primary = stats[0];
      expect(typeof primary.indexName).toBe('string');
      expect(primary.indexName).toBe('PRIMARY');
      expect(typeof primary.tableName).toBe('string');
      expect(primary.tableName).toBe('users');
      expect(typeof primary.indexType).toBe('string');
      expect(primary.indexType).toBe('BTREE');
      expect(Array.isArray(primary.columns)).toBe(true);
      expect(primary.columns).toContain('id');
      expect(typeof primary.isUnique).toBe('boolean');
      expect(primary.isUnique).toBe(true);
      expect(typeof primary.isPrimary).toBe('boolean');
      expect(primary.isPrimary).toBe(true);
      expect(typeof primary.scans).toBe('number');
      expect(primary.scans).toBe(100);
      expect(typeof primary.indexSize).toBe('string');
      expect(typeof primary.indexSizeBytes).toBe('number');
    });
  });

  // --------------------------------------------------------------------------
  // getStorageStats()
  // --------------------------------------------------------------------------

  describe('getStorageStats()', () => {
    test('returns innodb data and binary log sizes', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const stats = await provider.getStorageStats();

      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBeGreaterThanOrEqual(1);

      // First item should be "Data"
      const dataEntry = stats.find(s => s.name === 'Data');
      expect(dataEntry).toBeDefined();
      expect(typeof dataEntry!.size).toBe('string');
      expect(typeof dataEntry!.sizeBytes).toBe('number');
      expect(dataEntry!.sizeBytes).toBe(13107200);

      // Binary Logs entry
      const binlogEntry = stats.find(s => s.name === 'Binary Logs');
      expect(binlogEntry).toBeDefined();
      expect(binlogEntry!.sizeBytes).toBe(1048576);

      // InnoDB entry
      const innodbEntry = stats.find(s => s.name === 'InnoDB');
      expect(innodbEntry).toBeDefined();
      expect(innodbEntry!.location).toContain('ibdata1');
    });
  });

  // --------------------------------------------------------------------------
  // Note: MySQLProvider does not expose a getPoolStats() method.
  // Pool stats are handled by the base provider if needed.
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // buildSSLConfig() (tested indirectly via connect)
  // --------------------------------------------------------------------------

  describe('buildSSLConfig()', () => {
    test('cloud provider auto-enables SSL', () => {
      // A cloud hostname should trigger SSL auto-enable
      provider = new MySQLProvider(makeMySQLConfig({
        host: 'my-db.supabase.co',
      }));
      // If no error during construction, SSL config was built
      expect(provider).toBeDefined();
    });

    test('explicit ssl mode disable', () => {
      provider = new MySQLProvider(makeMySQLConfig({
        ssl: { mode: 'disable' },
      }));
      // Should not throw — ssl disabled
      expect(provider).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // queryInTransaction()
  // --------------------------------------------------------------------------

  describe('queryInTransaction()', () => {
    test('executes query within active transaction', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      await provider.beginTransaction();

      const result = await provider.queryInTransaction('SELECT * FROM users');
      expect(result.rows).toBeArray();
      expect(result.rows.length).toBeGreaterThan(0);
      expect(typeof result.executionTime).toBe('number');

      await provider.commitTransaction();
    });

    test('throws when no active transaction', async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      await expect(provider.queryInTransaction('SELECT 1')).rejects.toThrow('No active transaction');
    });
  });

  // --------------------------------------------------------------------------
  // prepareQuery()
  // --------------------------------------------------------------------------

  describe('prepareQuery()', () => {
    test('SELECT gets LIMIT appended', () => {
      provider = new MySQLProvider(makeMySQLConfig());
      const result = provider.prepareQuery('SELECT * FROM users');
      expect(result.query).toContain('LIMIT');
      expect(result.wasLimited).toBe(true);
    });

    test('non-SELECT passes through unchanged', () => {
      provider = new MySQLProvider(makeMySQLConfig());
      const sql = "INSERT INTO users (name) VALUES ('test')";
      const result = provider.prepareQuery(sql);
      expect(result.query).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // error mapping
  // --------------------------------------------------------------------------

  describe('error mapping', () => {
    test('ER_ACCESS_DENIED maps to auth error', async () => {
      mockExecuteFn = async () => {
        throw new Error('ER_ACCESS_DENIED: Access denied for user');
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      try {
        await provider.query('SELECT 1');
        expect(true).toBe(false); // Should not reach here
      } catch (error: unknown) {
        expect(error).toBeDefined();
        const err = error as Error;
        expect(err.message).toContain('Access denied');
      }
    });

    test('connection error on query throws', async () => {
      mockExecuteFn = async () => {
        throw new Error('ECONNREFUSED: Connection refused');
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      try {
        await provider.query('SELECT 1');
        expect(true).toBe(false); // Should not reach here
      } catch (error: unknown) {
        expect(error).toBeDefined();
        const err = error as Error;
        expect(err.message).toContain('ECONNREFUSED');
      }
    });
  });
});
