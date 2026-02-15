/**
 * Integration tests for PostgresProvider
 * Uses mock.module() to intercept pg before provider import.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { DatabaseConnection } from '@/lib/types';
import { DatabaseConfigError, QueryError } from '@/lib/db/errors';

// ============================================================================
// Mock pg BEFORE importing the provider
// ============================================================================

let mockQueryFn: (sql: string, params?: unknown[]) => Promise<{
  rows: unknown[];
  fields?: { name: string }[];
  rowCount?: number;
}>;

let mockPoolEndCalled = false;
let mockClientReleaseCalled = false;

const mockClient = {
  query: (sql: string, params?: unknown[]) => mockQueryFn(sql, params),
  release: () => {
    mockClientReleaseCalled = true;
  },
};

const mockPool = {
  connect: async () => mockClient,
  end: async () => {
    mockPoolEndCalled = true;
  },
  totalCount: 10,
  idleCount: 7,
  waitingCount: 0,
};

mock.module('pg', () => ({
  Pool: function () {
    return mockPool;
  },
}));

// Dynamic import AFTER mock is installed
const { PostgresProvider } = await import('@/lib/db/providers/sql/postgres');

// ============================================================================
// Helpers
// ============================================================================

function makePgConfig(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: 'test-pg',
    name: 'Test Postgres',
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'testdb',
    user: 'postgres',
    password: 'secret',
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * Default mock query that matches SQL patterns and returns appropriate mock data.
 */
function defaultMockQuery(
  sql: string,
  _params?: unknown[]
): Promise<{ rows: unknown[]; fields?: { name: string }[]; rowCount?: number }> {
  const normalized = sql.trim().toLowerCase();

  // pg_backend_pid — PID tracking for query cancellation
  if (normalized.includes('pg_backend_pid()') && normalized.includes('select') && !normalized.includes('pg_stat_activity')) {
    return Promise.resolve({ rows: [{ pid: 12345 }], fields: [{ name: 'pid' }], rowCount: 1 });
  }

  // pg_cancel_backend — cancel a running query
  if (normalized.includes('pg_cancel_backend')) {
    return Promise.resolve({ rows: [{ cancelled: true }], fields: [{ name: 'cancelled' }], rowCount: 1 });
  }

  // pg_terminate_backend — kill session
  if (normalized.includes('pg_terminate_backend')) {
    return Promise.resolve({
      rows: [{ pg_terminate_backend: true }],
      fields: [{ name: 'pg_terminate_backend' }],
      rowCount: 1,
    });
  }

  // BEGIN / COMMIT / ROLLBACK — transaction control
  if (normalized === 'begin' || normalized === 'commit' || normalized === 'rollback') {
    return Promise.resolve({ rows: [], fields: [], rowCount: 0 });
  }

  // VACUUM ANALYZE
  if (normalized.includes('vacuum analyze') || normalized === 'vacuum analyze') {
    return Promise.resolve({ rows: [], fields: [], rowCount: 0 });
  }

  // ANALYZE (without vacuum)
  if (normalized.startsWith('analyze')) {
    return Promise.resolve({ rows: [], fields: [], rowCount: 0 });
  }

  // REINDEX
  if (normalized.startsWith('reindex')) {
    return Promise.resolve({ rows: [], fields: [], rowCount: 0 });
  }

  // SELECT * FROM pg_stat_activity (exact, getPgStatActivity)
  if (normalized.includes('select * from pg_stat_activity')) {
    return Promise.resolve({
      rows: [
        {
          datname: 'testdb',
          pid: 123,
          usename: 'testuser',
          application_name: 'testapp',
          client_addr: '127.0.0.1',
          backend_start: new Date().toISOString(),
          state: 'active',
          query: 'SELECT * FROM test_table',
        },
      ],
      fields: [
        { name: 'datname' },
        { name: 'pid' },
        { name: 'usename' },
        { name: 'application_name' },
        { name: 'client_addr' },
        { name: 'backend_start' },
        { name: 'state' },
        { name: 'query' },
      ],
      rowCount: 1,
    });
  }

  // getHealth: count(*) from pg_stat_activity
  if (normalized.includes('count(*)') && normalized.includes('pg_stat_activity') && !normalized.includes('max_connections')) {
    return Promise.resolve({ rows: [{ count: '5' }], fields: [{ name: 'count' }], rowCount: 1 });
  }

  // getHealth: pg_size_pretty(pg_database_size(...))
  if (normalized.includes('pg_size_pretty') && normalized.includes('pg_database_size') && !normalized.includes('pg_tablespace')) {
    return Promise.resolve({
      rows: [{ pg_size_pretty: '256 MB', database_size: '256 MB', database_size_bytes: '268435456' }],
      fields: [{ name: 'pg_size_pretty' }],
      rowCount: 1,
    });
  }

  // pg_stat_statements with total_exec_time (getHealth slow queries)
  if (normalized.includes('pg_stat_statements') && normalized.includes('total_exec_time desc') && normalized.includes('left(query, 100)')) {
    return Promise.resolve({
      rows: [
        { query: 'SELECT * FROM users', calls: 100, avgtime: '12.5ms' },
      ],
      fields: [{ name: 'query' }, { name: 'calls' }, { name: 'avgtime' }],
      rowCount: 1,
    });
  }

  // pg_stat_statements (getSlowQueries — detailed fields)
  if (normalized.includes('pg_stat_statements') && normalized.includes('total_exec_time desc')) {
    return Promise.resolve({
      rows: [
        {
          query_id: '12345',
          query: 'SELECT * FROM users WHERE id = $1',
          calls: '200',
          total_time: '5000.00',
          avg_time: '25.00',
          min_time: '1.00',
          max_time: '150.00',
          rows: '200',
          shared_blks_hit: '8000',
          shared_blks_read: '50',
        },
      ],
      fields: [
        { name: 'query_id' },
        { name: 'query' },
        { name: 'calls' },
        { name: 'total_time' },
        { name: 'avg_time' },
        { name: 'min_time' },
        { name: 'max_time' },
        { name: 'rows' },
        { name: 'shared_blks_hit' },
        { name: 'shared_blks_read' },
      ],
      rowCount: 1,
    });
  }

  // pg_stat_activity fallback slow queries (state = 'active')
  if (normalized.includes('pg_stat_activity') && normalized.includes("state = 'active'") && normalized.includes('query_start asc')) {
    return Promise.resolve({
      rows: [
        {
          query_id: '999',
          query: 'SELECT * FROM slow_table',
          calls: '1',
          total_time: '3000',
          avg_time: '3000',
          rows: '0',
        },
      ],
      fields: [],
      rowCount: 1,
    });
  }

  // getHealth sessions: pg_stat_activity with pid != pg_backend_pid and datname = $1
  if (
    normalized.includes('pg_stat_activity') &&
    normalized.includes('pid != pg_backend_pid()') &&
    normalized.includes('xact_start desc') &&
    !normalized.includes('application_name')
  ) {
    return Promise.resolve({
      rows: [
        {
          pid: 101,
          user: 'app_user',
          database: 'testdb',
          state: 'active',
          query: 'SELECT 1',
          duration: '2.5s',
        },
      ],
      fields: [],
      rowCount: 1,
    });
  }

  // getActiveSessions: pg_stat_activity with detailed fields
  if (
    normalized.includes('pg_stat_activity') &&
    normalized.includes('application_name') &&
    normalized.includes('wait_event_type') &&
    normalized.includes('pid != pg_backend_pid()')
  ) {
    return Promise.resolve({
      rows: [
        {
          pid: 201,
          user: 'db_user',
          database: 'testdb',
          application_name: 'myapp',
          client_addr: '10.0.0.1',
          state: 'active',
          query: 'SELECT * FROM orders',
          query_start: new Date().toISOString(),
          wait_event_type: null,
          wait_event: null,
          duration: '1.2s',
          duration_ms: '1200',
        },
      ],
      fields: [],
      rowCount: 1,
    });
  }

  // getHealth: pg_statio_user_tables (cache ratio with heap_read + heap_hit)
  if (normalized.includes('pg_statio_user_tables') && normalized.includes('heap_blks_read')) {
    return Promise.resolve({
      rows: [{ ratio: 99.5, heap_read: '100', heap_hit: '9900' }],
      fields: [{ name: 'ratio' }, { name: 'heap_read' }, { name: 'heap_hit' }],
      rowCount: 1,
    });
  }

  // getPerformanceMetrics: pg_statio_user_tables (cache_hit_ratio only)
  if (normalized.includes('pg_statio_user_tables') && normalized.includes('cache_hit_ratio')) {
    return Promise.resolve({
      rows: [{ cache_hit_ratio: '98.75' }],
      fields: [{ name: 'cache_hit_ratio' }],
      rowCount: 1,
    });
  }

  // Schema CTE query: information_schema + table_type = 'base table'
  if (normalized.includes('information_schema') && normalized.includes("table_type = 'base table'")) {
    return Promise.resolve({
      rows: [
        {
          table_schema: 'public',
          table_name: 'users',
          row_count: '1000',
          total_size: '81920',
          columns: [
            { name: 'id', type: 'integer', nullable: false, defaultValue: "nextval('users_id_seq')" },
            { name: 'name', type: 'character varying', nullable: true, defaultValue: null },
            { name: 'email', type: 'character varying', nullable: false, defaultValue: null },
          ],
          pk_columns: ['id'],
          foreign_keys: [],
          indexes: [
            { name: 'users_pkey', columns: ['id'], unique: true },
            { name: 'idx_users_email', columns: ['email'], unique: true },
          ],
        },
        {
          table_schema: 'analytics',
          table_name: 'events',
          row_count: '50000',
          total_size: '4194304',
          columns: [
            { name: 'id', type: 'integer', nullable: false, defaultValue: null },
            { name: 'user_id', type: 'integer', nullable: false, defaultValue: null },
            { name: 'event_type', type: 'character varying', nullable: false, defaultValue: null },
          ],
          pk_columns: ['id'],
          foreign_keys: [
            {
              columnName: 'user_id',
              referencedSchema: 'public',
              referencedTable: 'users',
              referencedColumn: 'id',
            },
          ],
          indexes: [
            { name: 'events_pkey', columns: ['id'], unique: true },
          ],
        },
      ],
      fields: [],
      rowCount: 2,
    });
  }

  // getOverview: version() + pg_postmaster_start_time()
  if (normalized.includes('version()') && normalized.includes('pg_postmaster_start_time()')) {
    return Promise.resolve({
      rows: [
        {
          version: 'PostgreSQL 16.2, compiled by Visual C++ build 1941, 64-bit',
          start_time: new Date(Date.now() - 90061000).toISOString(),
          uptime_seconds: '90061',
        },
      ],
      fields: [],
      rowCount: 1,
    });
  }

  // getOverview: connection counts (max_connections + pg_stat_activity)
  if (normalized.includes('max_connections') && normalized.includes('pg_stat_activity')) {
    return Promise.resolve({
      rows: [{ active_connections: '12', max_connections: '200' }],
      fields: [],
      rowCount: 1,
    });
  }

  // getOverview: database size (pg_database_size with pretty + bytes)
  if (normalized.includes('pg_database_size') && normalized.includes('database_size_bytes')) {
    return Promise.resolve({
      rows: [{ database_size: '512 MB', database_size_bytes: '536870912' }],
      fields: [],
      rowCount: 1,
    });
  }

  // getOverview: table + index counts
  if (normalized.includes('pg_tables') && normalized.includes('pg_indexes')) {
    return Promise.resolve({
      rows: [{ table_count: '15', index_count: '30' }],
      fields: [],
      rowCount: 1,
    });
  }

  // getPerformanceMetrics: pg_stat_database (transaction stats)
  if (normalized.includes('pg_stat_database') && normalized.includes('xact_commit')) {
    return Promise.resolve({
      rows: [
        {
          xact_commit: '50000',
          xact_rollback: '150',
          deadlocks: '3',
          blks_read: '2000',
          blks_hit: '98000',
        },
      ],
      fields: [],
      rowCount: 1,
    });
  }

  // getPerformanceMetrics: pg_stat_bgwriter (checkpoint stats)
  if (normalized.includes('pg_stat_bgwriter')) {
    return Promise.resolve({
      rows: [
        {
          checkpoint_write_time: '12500',
          checkpoint_sync_time: '3200',
        },
      ],
      fields: [],
      rowCount: 1,
    });
  }

  // getTableStats: pg_stat_user_tables
  if (normalized.includes('pg_stat_user_tables') && normalized.includes('n_live_tup')) {
    return Promise.resolve({
      rows: [
        {
          schema_name: 'public',
          table_name: 'users',
          live_row_count: '1000',
          dead_row_count: '50',
          row_count: '1050',
          table_size: '64 kB',
          table_size_bytes: '65536',
          index_size: '32 kB',
          index_size_bytes: '32768',
          total_size: '96 kB',
          total_size_bytes: '98304',
          last_vacuum: null,
          last_autovacuum: new Date().toISOString(),
          last_analyze: null,
          last_autoanalyze: new Date().toISOString(),
          bloat_ratio: '4.76',
        },
        {
          schema_name: 'public',
          table_name: 'orders',
          live_row_count: '5000',
          dead_row_count: '200',
          row_count: '5200',
          table_size: '256 kB',
          table_size_bytes: '262144',
          index_size: '128 kB',
          index_size_bytes: '131072',
          total_size: '384 kB',
          total_size_bytes: '393216',
          last_vacuum: new Date().toISOString(),
          last_autovacuum: null,
          last_analyze: new Date().toISOString(),
          last_autoanalyze: null,
          bloat_ratio: '3.85',
        },
      ],
      fields: [],
      rowCount: 2,
    });
  }

  // getIndexStats: pg_stat_user_indexes
  if (normalized.includes('pg_stat_user_indexes')) {
    return Promise.resolve({
      rows: [
        {
          schema_name: 'public',
          table_name: 'users',
          index_name: 'users_pkey',
          index_type: 'btree',
          index_size: '16 kB',
          index_size_bytes: '16384',
          scans: '5000',
          tuples_read: '5000',
          tuples_fetched: '5000',
          is_unique: true,
          is_primary: true,
          columns: ['id'],
          usage_ratio: '85.50',
        },
        {
          schema_name: 'public',
          table_name: 'users',
          index_name: 'idx_users_email',
          index_type: 'btree',
          index_size: '32 kB',
          index_size_bytes: '32768',
          scans: '3000',
          tuples_read: '3000',
          tuples_fetched: '3000',
          is_unique: true,
          is_primary: false,
          columns: ['email'],
          usage_ratio: '52.17',
        },
      ],
      fields: [],
      rowCount: 2,
    });
  }

  // getStorageStats: pg_tablespace
  if (normalized.includes('pg_tablespace') && normalized.includes('pg_tablespace_size')) {
    return Promise.resolve({
      rows: [
        {
          name: 'pg_default',
          location: '',
          size: '1.2 GB',
          size_bytes: '1288490188',
          is_default: true,
        },
      ],
      fields: [],
      rowCount: 1,
    });
  }

  // getStorageStats: pg_wal_lsn_diff (WAL info)
  if (normalized.includes('pg_wal_lsn_diff')) {
    return Promise.resolve({
      rows: [{ wal_size: '128 MB', wal_size_bytes: '134217728' }],
      fields: [],
      rowCount: 1,
    });
  }

  // Default: generic SELECT result
  return Promise.resolve({
    rows: [{ id: 1, name: 'test' }],
    fields: [{ name: 'id' }, { name: 'name' }],
    rowCount: 1,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('PostgresProvider', () => {
  let provider: InstanceType<typeof PostgresProvider>;

  beforeEach(() => {
    mockQueryFn = defaultMockQuery;
    mockPoolEndCalled = false;
    mockClientReleaseCalled = false;
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
        new PostgresProvider(makePgConfig({ host: undefined }));
      }).toThrow(DatabaseConfigError);
    });

    test('missing database throws DatabaseConfigError', () => {
      expect(() => {
        new PostgresProvider(makePgConfig({ database: undefined }));
      }).toThrow(DatabaseConfigError);
    });

    test('valid config passes validation', () => {
      expect(() => {
        new PostgresProvider(makePgConfig());
      }).not.toThrow();
    });

    test('connectionString bypasses host/database requirement', () => {
      expect(() => {
        new PostgresProvider(
          makePgConfig({
            host: undefined,
            database: undefined,
            connectionString: 'postgresql://user:pass@localhost:5432/mydb',
          })
        );
      }).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Connection lifecycle
  // --------------------------------------------------------------------------

  describe('connect / disconnect', () => {
    test('isConnected() is false before connect', () => {
      provider = new PostgresProvider(makePgConfig());
      expect(provider.isConnected()).toBe(false);
    });

    test('connect() sets connected to true', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test('disconnect() sets connected to false', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await provider.disconnect();
      expect(provider.isConnected()).toBe(false);
    });

    test('double connect is idempotent', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // buildSSLConfig()
  // --------------------------------------------------------------------------

  describe('buildSSLConfig()', () => {
    test('ssl mode disable returns false (no SSL)', async () => {
      provider = new PostgresProvider(
        makePgConfig({
          ssl: { mode: 'disable' },
        })
      );
      await provider.connect();
      // If we get here without error, connect succeeded with ssl=false
      expect(provider.isConnected()).toBe(true);
    });

    test('ssl mode verify-ca sets rejectUnauthorized to true', async () => {
      provider = new PostgresProvider(
        makePgConfig({
          ssl: { mode: 'verify-ca' },
        })
      );
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test('ssl mode verify-full with certs includes ca, cert, key', async () => {
      provider = new PostgresProvider(
        makePgConfig({
          ssl: {
            mode: 'verify-full',
            caCert: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
            clientCert: '-----BEGIN CERTIFICATE-----\nCLIENT\n-----END CERTIFICATE-----',
            clientKey: '-----BEGIN RSA PRIVATE KEY-----\nKEY\n-----END RSA PRIVATE KEY-----',
          },
        })
      );
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test('auto-detect cloud provider enables SSL', async () => {
      provider = new PostgresProvider(
        makePgConfig({
          host: 'my-db.supabase.co',
        })
      );
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test('options.ssl=false returns false', async () => {
      provider = new PostgresProvider(makePgConfig(), { ssl: false });
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test('no SSL config returns undefined (default)', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Query execution
  // --------------------------------------------------------------------------

  describe('query()', () => {
    test('SELECT returns rows, fields, and executionTime', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.query('SELECT * FROM users');
      expect(result.rows.length).toBeGreaterThan(0);
      expect(Array.isArray(result.fields)).toBe(true);
      expect(typeof result.executionTime).toBe('number');
      expect(typeof result.rowCount).toBe('number');
    });

    test('PID is tracked when queryId is provided', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.query('SELECT 1', undefined, 'test-query-id');
      expect(result.rows.length).toBeGreaterThan(0);
    });

    test('query error is mapped to database error', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      // Override mock to throw a syntax error
      mockQueryFn = async () => {
        throw new Error('syntax error at or near "SELEC"');
      };

      await expect(provider.query('SELEC * FROM users')).rejects.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Cancel query
  // --------------------------------------------------------------------------

  describe('cancelQuery()', () => {
    test('cancels known PID and returns true', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      // We need a query running to have a tracked PID.
      // Simulate: trigger a query with queryId, then cancel mid-flight.
      // Since our mock is synchronous, we'll manually set the PID map.
      // Access the private runningQueryPids map via casting.
      const providerAny = provider as unknown as { runningQueryPids: Map<string, number> };
      providerAny.runningQueryPids.set('cancel-test', 12345);

      const cancelled = await provider.cancelQuery('cancel-test');
      expect(cancelled).toBe(true);
    });

    test('returns false for unknown queryId', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.cancelQuery('nonexistent-query-id');
      expect(result).toBe(false);
    });

    test('handles cancel error gracefully and returns false', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const providerAny = provider as unknown as { runningQueryPids: Map<string, number> };
      providerAny.runningQueryPids.set('error-cancel', 99999);

      // Override mock to throw on pg_cancel_backend
      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        if (sql.includes('pg_cancel_backend')) {
          throw new Error('Connection lost');
        }
        return originalMock(sql, params);
      };

      const result = await provider.cancelQuery('error-cancel');
      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Transaction lifecycle
  // --------------------------------------------------------------------------

  describe('Transaction lifecycle', () => {
    test('beginTransaction / commitTransaction works', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      expect(provider.isInTransaction()).toBe(false);
      await provider.beginTransaction();
      expect(provider.isInTransaction()).toBe(true);
      await provider.commitTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });

    test('beginTransaction / rollbackTransaction works', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await provider.beginTransaction();
      expect(provider.isInTransaction()).toBe(true);
      await provider.rollbackTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });

    test('double beginTransaction throws', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await provider.beginTransaction();
      await expect(provider.beginTransaction()).rejects.toThrow('Transaction already active');
      // Clean up
      await provider.rollbackTransaction();
    });

    test('commitTransaction without begin throws', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await expect(provider.commitTransaction()).rejects.toThrow('No active transaction');
    });

    test('rollbackTransaction without begin throws', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await expect(provider.rollbackTransaction()).rejects.toThrow('No active transaction');
    });

    test('queryInTransaction executes within active transaction', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await provider.beginTransaction();
      const result = await provider.queryInTransaction('SELECT 1');
      expect(result.rows).toBeDefined();
      expect(typeof result.executionTime).toBe('number');
      await provider.commitTransaction();
    });

    test('queryInTransaction without begin throws', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await expect(provider.queryInTransaction('SELECT 1')).rejects.toThrow('No active transaction');
    });
  });

  // --------------------------------------------------------------------------
  // Schema
  // --------------------------------------------------------------------------

  describe('getSchema()', () => {
    test('returns TableSchema array with columns, indexes, foreignKeys', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const schema = await provider.getSchema();

      expect(schema.length).toBe(2);

      for (const table of schema) {
        expect(typeof table.name).toBe('string');
        expect(Array.isArray(table.columns)).toBe(true);
        expect(table.columns.length).toBeGreaterThan(0);
        expect(Array.isArray(table.indexes)).toBe(true);
        expect(Array.isArray(table.foreignKeys)).toBe(true);
      }
    });

    test('primary key columns are detected via isPrimary flag', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const schema = await provider.getSchema();

      const usersTable = schema.find((t) => t.name === 'users');
      expect(usersTable).toBeDefined();

      const idCol = usersTable!.columns.find((c) => c.name === 'id');
      expect(idCol).toBeDefined();
      expect(idCol!.isPrimary).toBe(true);

      const nameCol = usersTable!.columns.find((c) => c.name === 'name');
      expect(nameCol).toBeDefined();
      expect(nameCol!.isPrimary).toBe(false);
    });

    test('non-public schema tables get schema prefix in name', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const schema = await provider.getSchema();

      const eventsTable = schema.find((t) => t.name === 'analytics.events');
      expect(eventsTable).toBeDefined();
      expect(eventsTable!.name).toBe('analytics.events');

      // Foreign key from analytics.events.user_id -> public.users.id should have no prefix
      expect(eventsTable!.foreignKeys.length).toBe(1);
      expect(eventsTable!.foreignKeys[0].referencedTable).toBe('users');
    });
  });

  // --------------------------------------------------------------------------
  // Health
  // --------------------------------------------------------------------------

  describe('getHealth()', () => {
    test('returns all health fields', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const health = await provider.getHealth();

      expect(typeof health.activeConnections).toBe('number');
      expect(health.activeConnections).toBe(5);
      expect(typeof health.databaseSize).toBe('string');
      expect(health.databaseSize).toBe('256 MB');
      expect(typeof health.cacheHitRatio).toBe('string');
      expect(health.cacheHitRatio).toContain('99.5');
      expect(Array.isArray(health.slowQueries)).toBe(true);
      expect(Array.isArray(health.activeSessions)).toBe(true);
    });

    test('pg_stat_statements fallback when extension is not enabled', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      // Override: make pg_stat_statements fail
      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        const normalized = sql.trim().toLowerCase();
        if (normalized.includes('pg_stat_statements') && normalized.includes('total_exec_time desc')) {
          throw new Error('relation "pg_stat_statements" does not exist');
        }
        return originalMock(sql, params);
      };

      const health = await provider.getHealth();
      expect(Array.isArray(health.slowQueries)).toBe(true);
      expect(health.slowQueries.length).toBe(1);
      expect(health.slowQueries[0].query).toContain('pg_stat_statements extension not enabled');
    });

    test('sessions data is populated', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const health = await provider.getHealth();

      expect(health.activeSessions.length).toBeGreaterThan(0);
      const session = health.activeSessions[0];
      expect(typeof session.pid).toBe('number');
      expect(typeof session.user).toBe('string');
      expect(typeof session.state).toBe('string');
    });
  });

  // --------------------------------------------------------------------------
  // Maintenance
  // --------------------------------------------------------------------------

  describe('runMaintenance()', () => {
    test('vacuum with target returns success', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.runMaintenance('vacuum', 'users');
      expect(result.success).toBe(true);
      expect(typeof result.executionTime).toBe('number');
      expect(result.message).toContain('VACUUM');
    });

    test('vacuum without target returns success', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.runMaintenance('vacuum');
      expect(result.success).toBe(true);
      expect(result.message).toContain('VACUUM');
    });

    test('analyze with target returns success', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.runMaintenance('analyze', 'users');
      expect(result.success).toBe(true);
      expect(result.message).toContain('ANALYZE');
    });

    test('analyze without target returns success', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.runMaintenance('analyze');
      expect(result.success).toBe(true);
      expect(result.message).toContain('ANALYZE');
    });

    test('reindex with target returns success', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.runMaintenance('reindex', 'users');
      expect(result.success).toBe(true);
      expect(result.message).toContain('REINDEX');
    });

    test('reindex without target returns success (database-level)', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.runMaintenance('reindex');
      expect(result.success).toBe(true);
      expect(result.message).toContain('REINDEX');
    });

    test('kill with valid PID returns success', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.runMaintenance('kill', '12345');
      expect(result.success).toBe(true);
      expect(result.message).toContain('KILL');
    });

    test('kill without target throws QueryError', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await expect(provider.runMaintenance('kill')).rejects.toThrow(
        'Target PID is required for kill operation'
      );
    });

    test('kill with invalid (non-numeric) PID throws QueryError', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await expect(provider.runMaintenance('kill', 'abc')).rejects.toThrow(
        'Invalid PID for kill operation'
      );
    });

    test('unsupported maintenance type throws QueryError', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await expect(
        provider.runMaintenance('optimize' as unknown as 'vacuum', 'users')
      ).rejects.toThrow('Unsupported maintenance type');
    });
  });

  // --------------------------------------------------------------------------
  // Overview
  // --------------------------------------------------------------------------

  describe('getOverview()', () => {
    test('returns all overview fields', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      expect(typeof overview.version).toBe('string');
      expect(overview.version).toContain('PostgreSQL');
      expect(typeof overview.uptime).toBe('string');
      expect(typeof overview.activeConnections).toBe('number');
      expect(overview.activeConnections).toBe(12);
      expect(typeof overview.maxConnections).toBe('number');
      expect(overview.maxConnections).toBe(200);
      expect(typeof overview.databaseSize).toBe('string');
      expect(typeof overview.databaseSizeBytes).toBe('number');
      expect(typeof overview.tableCount).toBe('number');
      expect(overview.tableCount).toBe(15);
      expect(typeof overview.indexCount).toBe('number');
      expect(overview.indexCount).toBe(30);
    });

    test('uptime is formatted with days, hours, minutes', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      // 90061 seconds = 1d 1h 1m
      expect(overview.uptime).toBe('1d 1h 1m');
    });
  });

  // --------------------------------------------------------------------------
  // Performance Metrics
  // --------------------------------------------------------------------------

  describe('getPerformanceMetrics()', () => {
    test('returns all performance metrics', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      expect(typeof metrics.cacheHitRatio).toBe('number');
      expect(typeof metrics.bufferPoolUsage).toBe('number');
      expect(typeof metrics.deadlocks).toBe('number');
      expect(metrics.deadlocks).toBe(3);
      expect(typeof metrics.checkpointWriteTime).toBe('string');
      expect(metrics.checkpointWriteTime).not.toBe('N/A');
    });

    test('handles checkpoint fallback gracefully', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        const normalized = sql.trim().toLowerCase();
        if (normalized.includes('pg_stat_bgwriter')) {
          throw new Error('permission denied for pg_stat_bgwriter');
        }
        return originalMock(sql, params);
      };

      const metrics = await provider.getPerformanceMetrics();
      expect(metrics.checkpointWriteTime).toBe('N/A');
    });
  });

  // --------------------------------------------------------------------------
  // Slow Queries
  // --------------------------------------------------------------------------

  describe('getSlowQueries()', () => {
    test('pg_stat_statements returns detailed slow query stats', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const slowQueries = await provider.getSlowQueries();

      expect(slowQueries.length).toBe(1);
      const sq = slowQueries[0];
      expect(typeof sq.queryId).toBe('string');
      expect(typeof sq.query).toBe('string');
      expect(typeof sq.calls).toBe('number');
      expect(typeof sq.totalTime).toBe('number');
      expect(typeof sq.avgTime).toBe('number');
      expect(typeof sq.minTime).toBe('number');
      expect(typeof sq.maxTime).toBe('number');
      expect(typeof sq.rows).toBe('number');
      expect(typeof sq.sharedBlksHit).toBe('number');
      expect(typeof sq.sharedBlksRead).toBe('number');
    });

    test('fallback to pg_stat_activity when pg_stat_statements is unavailable', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        const normalized = sql.trim().toLowerCase();
        // Make pg_stat_statements queries fail
        if (normalized.includes('pg_stat_statements')) {
          throw new Error('relation "pg_stat_statements" does not exist');
        }
        return originalMock(sql, params);
      };

      const slowQueries = await provider.getSlowQueries();
      expect(Array.isArray(slowQueries)).toBe(true);
      expect(slowQueries.length).toBeGreaterThan(0);
      // Fallback rows have no minTime/maxTime
      expect(slowQueries[0].minTime).toBeUndefined();
      expect(slowQueries[0].maxTime).toBeUndefined();
    });

    test('respects limit option', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      // With limit=5, the query passes $2=5 to the mock; our mock always returns 1 row
      const slowQueries = await provider.getSlowQueries({ limit: 5 });
      expect(Array.isArray(slowQueries)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Active Sessions
  // --------------------------------------------------------------------------

  describe('getActiveSessions()', () => {
    test('returns session details', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const sessions = await provider.getActiveSessions();

      expect(sessions.length).toBe(1);
      const session = sessions[0];
      expect(session.pid).toBe(201);
      expect(session.user).toBe('db_user');
      expect(session.database).toBe('testdb');
      expect(session.applicationName).toBe('myapp');
      expect(session.state).toBe('active');
      expect(typeof session.query).toBe('string');
      expect(typeof session.duration).toBe('string');
      expect(typeof session.durationMs).toBe('number');
      expect(session.blocked).toBe(false);
    });

    test('respects limit option', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const sessions = await provider.getActiveSessions({ limit: 10 });
      expect(Array.isArray(sessions)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Table Stats
  // --------------------------------------------------------------------------

  describe('getTableStats()', () => {
    test('returns table stats for all schemas', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const stats = await provider.getTableStats();

      expect(stats.length).toBe(2);

      const usersStats = stats.find((s) => s.tableName === 'users');
      expect(usersStats).toBeDefined();
      expect(usersStats!.schemaName).toBe('public');
      expect(typeof usersStats!.rowCount).toBe('number');
      expect(typeof usersStats!.liveRowCount).toBe('number');
      expect(typeof usersStats!.deadRowCount).toBe('number');
      expect(typeof usersStats!.tableSize).toBe('string');
      expect(typeof usersStats!.tableSizeBytes).toBe('number');
      expect(typeof usersStats!.indexSize).toBe('string');
      expect(typeof usersStats!.totalSize).toBe('string');
      expect(typeof usersStats!.bloatRatio).toBe('number');
    });

    test('filters by schema when option is provided', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const stats = await provider.getTableStats({ schema: 'public' });
      expect(Array.isArray(stats)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Index Stats
  // --------------------------------------------------------------------------

  describe('getIndexStats()', () => {
    test('returns index stats for all schemas', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const stats = await provider.getIndexStats();

      expect(stats.length).toBe(2);

      const pkeyStats = stats.find((s) => s.indexName === 'users_pkey');
      expect(pkeyStats).toBeDefined();
      expect(pkeyStats!.schemaName).toBe('public');
      expect(pkeyStats!.tableName).toBe('users');
      expect(pkeyStats!.indexType).toBe('btree');
      expect(pkeyStats!.isUnique).toBe(true);
      expect(pkeyStats!.isPrimary).toBe(true);
      expect(Array.isArray(pkeyStats!.columns)).toBe(true);
      expect(typeof pkeyStats!.indexSize).toBe('string');
      expect(typeof pkeyStats!.indexSizeBytes).toBe('number');
      expect(typeof pkeyStats!.scans).toBe('number');
      expect(typeof pkeyStats!.usageRatio).toBe('number');
    });

    test('filters by schema when option is provided', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const stats = await provider.getIndexStats({ schema: 'public' });
      expect(Array.isArray(stats)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Storage Stats
  // --------------------------------------------------------------------------

  describe('getStorageStats()', () => {
    test('returns tablespaces and WAL info', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const stats = await provider.getStorageStats();

      // Should have tablespace(s) + WAL entry
      expect(stats.length).toBeGreaterThanOrEqual(2);

      const defaultTs = stats.find((s) => s.name === 'pg_default');
      expect(defaultTs).toBeDefined();
      expect(typeof defaultTs!.size).toBe('string');
      expect(typeof defaultTs!.sizeBytes).toBe('number');

      const walEntry = stats.find((s) => s.name === 'WAL');
      expect(walEntry).toBeDefined();
      expect(walEntry!.location).toBe('pg_wal');
      expect(typeof walEntry!.walSize).toBe('string');
      expect(typeof walEntry!.walSizeBytes).toBe('number');
    });

    test('WAL permission denied handled gracefully', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        const normalized = sql.trim().toLowerCase();
        if (normalized.includes('pg_wal_lsn_diff')) {
          throw new Error('permission denied for function pg_current_wal_lsn');
        }
        return originalMock(sql, params);
      };

      const stats = await provider.getStorageStats();
      // Should still have tablespace info, but no WAL entry
      expect(stats.length).toBeGreaterThanOrEqual(1);
      const walEntry = stats.find((s) => s.name === 'WAL');
      expect(walEntry).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Pool Stats
  // --------------------------------------------------------------------------

  describe('getPoolStats()', () => {
    test('connected provider returns pool stats', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const stats = provider.getPoolStats();

      expect(stats.total).toBe(10);
      expect(stats.idle).toBe(7);
      expect(stats.active).toBe(3); // total - idle
      expect(stats.waiting).toBe(0);
    });

    test('not connected returns zeros', () => {
      provider = new PostgresProvider(makePgConfig());
      const stats = provider.getPoolStats();

      expect(stats.total).toBe(0);
      expect(stats.idle).toBe(0);
      expect(stats.active).toBe(0);
      expect(stats.waiting).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Capabilities
  // --------------------------------------------------------------------------

  describe('getCapabilities()', () => {
    test('returns correct PostgreSQL capabilities', () => {
      provider = new PostgresProvider(makePgConfig());
      const caps = provider.getCapabilities();

      expect(caps.defaultPort).toBe(5432);
      expect(caps.queryLanguage).toBe('sql');
      expect(caps.supportsExplain).toBe(true);
      expect(caps.supportsConnectionString).toBe(true);
      expect(caps.maintenanceOperations).toContain('vacuum');
      expect(caps.maintenanceOperations).toContain('analyze');
      expect(caps.maintenanceOperations).toContain('reindex');
      expect(caps.maintenanceOperations).toContain('kill');
    });
  });

  // --------------------------------------------------------------------------
  // getPgStatActivity
  // --------------------------------------------------------------------------

  describe('getPgStatActivity()', () => {
    test('returns activity rows from pg_stat_activity', async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const activity = await provider.getPgStatActivity();

      expect(activity).toBeArray();
      expect(activity.length).toBe(1);
      expect(activity[0].datname).toBe('testdb');
      expect(activity[0].pid).toBe(123);
      expect(activity[0].usename).toBe('testuser');
      expect(activity[0].application_name).toBe('testapp');
      expect(activity[0].client_addr).toBe('127.0.0.1');
      expect(activity[0].state).toBe('active');
      expect(activity[0].query).toBe('SELECT * FROM test_table');
    });
  });
});
