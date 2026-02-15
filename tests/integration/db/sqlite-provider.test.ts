/**
 * Integration tests for SQLiteProvider
 * Uses real bun:sqlite with :memory: database — no mocking needed.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { SQLiteProvider } from '@/lib/db/providers/sql/sqlite';
import type { DatabaseConnection } from '@/lib/types';
import { DatabaseConfigError } from '@/lib/db/errors';

// ============================================================================
// Helpers
// ============================================================================

function makeSQLiteConfig(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: 'test-sqlite',
    name: 'Test SQLite',
    type: 'sqlite',
    database: ':memory:',
    createdAt: new Date(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('SQLiteProvider', () => {
  let provider: SQLiteProvider;

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
    test('missing database throws DatabaseConfigError', () => {
      expect(() => {
        new SQLiteProvider(makeSQLiteConfig({ database: undefined }));
      }).toThrow(DatabaseConfigError);
    });

    test('valid config with :memory: passes validation', () => {
      expect(() => {
        new SQLiteProvider(makeSQLiteConfig());
      }).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Connection lifecycle
  // --------------------------------------------------------------------------

  describe('connect / disconnect', () => {
    test('connect to :memory: sets isConnected to true', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      expect(provider.isConnected()).toBe(false);
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test('disconnect sets isConnected to false', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      await provider.disconnect();
      expect(provider.isConnected()).toBe(false);
    });

    test('double connect is idempotent', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Query execution
  // --------------------------------------------------------------------------

  describe('query()', () => {
    test('CREATE TABLE + INSERT + SELECT works end-to-end', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      // Create table
      await provider.query('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)');

      // Insert rows
      await provider.query("INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@example.com')");
      await provider.query("INSERT INTO users (id, name, email) VALUES (2, 'Bob', 'bob@example.com')");

      // Select all
      const result = await provider.query('SELECT * FROM users');
      expect(result.rows.length).toBe(2);
      expect(result.fields).toEqual(['id', 'name', 'email']);
      expect(result.rowCount).toBe(2);
      expect(typeof result.executionTime).toBe('number');
    });

    test('SELECT returns correct row data', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, price REAL)');
      await provider.query("INSERT INTO items VALUES (1, 'Widget', 9.99)");

      const result = await provider.query('SELECT * FROM items WHERE id = 1');
      expect(result.rows.length).toBe(1);
      const row = result.rows[0] as Record<string, unknown>;
      expect(row.id).toBe(1);
      expect(row.name).toBe('Widget');
      expect(row.price).toBe(9.99);
    });

    test('INSERT returns rowCount as changes', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query('CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)');
      const result = await provider.query("INSERT INTO test VALUES (1, 'a')");
      expect(result.rowCount).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Capabilities
  // --------------------------------------------------------------------------

  describe('getCapabilities()', () => {
    test('returns correct SQLite capabilities', () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      const caps = provider.getCapabilities();

      expect(caps.defaultPort).toBeNull();
      expect(caps.queryLanguage).toBe('sql');
      expect(caps.supportsExplain).toBe(false);
      expect(caps.supportsConnectionString).toBe(false);
      expect(caps.maintenanceOperations).toContain('vacuum');
      expect(caps.maintenanceOperations).toContain('analyze');
      expect(caps.maintenanceOperations).toContain('reindex');
      expect(caps.maintenanceOperations).toContain('check');
    });
  });

  // --------------------------------------------------------------------------
  // Schema
  // --------------------------------------------------------------------------

  describe('getSchema()', () => {
    test('returns correct schema after CREATE TABLE', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await provider.query('CREATE INDEX idx_users_email ON users(email)');

      const schema = await provider.getSchema();
      expect(schema.length).toBe(1);

      const table = schema[0];
      expect(table.name).toBe('users');
      expect(table.columns.length).toBe(4);

      // Check column properties
      const idCol = table.columns.find(c => c.name === 'id')!;
      expect(idCol.type).toBe('INTEGER');
      expect(idCol.isPrimary).toBe(true);

      const nameCol = table.columns.find(c => c.name === 'name')!;
      expect(nameCol.nullable).toBe(false);

      const emailCol = table.columns.find(c => c.name === 'email')!;
      expect(emailCol.nullable).toBe(true);

      // Check indexes
      expect(table.indexes.length).toBeGreaterThanOrEqual(1);
      const emailIdx = table.indexes.find(i => i.name === 'idx_users_email');
      expect(emailIdx).toBeDefined();
      expect(emailIdx!.columns).toContain('email');
    });

    test('schema includes foreign keys', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query('CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT)');
      await provider.query(`
        CREATE TABLE books (
          id INTEGER PRIMARY KEY,
          title TEXT,
          author_id INTEGER REFERENCES authors(id)
        )
      `);

      const schema = await provider.getSchema();
      const books = schema.find(t => t.name === 'books')!;
      expect(books.foreignKeys).toBeDefined();
      expect(books.foreignKeys!.length).toBe(1);
      expect(books.foreignKeys![0].columnName).toBe('author_id');
      expect(books.foreignKeys![0].referencedTable).toBe('authors');
      expect(books.foreignKeys![0].referencedColumn).toBe('id');
    });
  });

  // --------------------------------------------------------------------------
  // Health
  // --------------------------------------------------------------------------

  describe('getHealth()', () => {
    test('returns health info with integrity check OK', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      const health = await provider.getHealth();
      expect(health.activeConnections).toBe(1);
      expect(typeof health.databaseSize).toBe('string');
      expect(typeof health.cacheHitRatio).toBe('string');
      expect(Array.isArray(health.slowQueries)).toBe(true);
      expect(Array.isArray(health.activeSessions)).toBe(true);

      // Integrity check should appear in slowQueries info
      const integrityInfo = health.slowQueries.find(sq => sq.query.includes('Integrity'));
      expect(integrityInfo).toBeDefined();
      expect(integrityInfo!.query).toContain('OK');
    });
  });

  // --------------------------------------------------------------------------
  // Maintenance
  // --------------------------------------------------------------------------

  describe('runMaintenance()', () => {
    test('vacuum succeeds', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      const result = await provider.runMaintenance('vacuum');
      expect(result.success).toBe(true);
      expect(typeof result.executionTime).toBe('number');
      expect(result.message).toContain('VACUUM');
    });

    test('analyze succeeds', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      const result = await provider.runMaintenance('analyze');
      expect(result.success).toBe(true);
      expect(result.message).toContain('ANALYZE');
    });

    test('check returns integrity result (ok)', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      const result = await provider.runMaintenance('check');
      expect(result.success).toBe(true);
      expect(result.message).toBe('ok');
    });

    test('reindex succeeds', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      await provider.query('CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)');
      await provider.query('CREATE INDEX idx_val ON test(val)');
      const result = await provider.runMaintenance('reindex');
      expect(result.success).toBe(true);
      expect(result.message).toContain('REINDEX');
    });

    test('unsupported type throws QueryError', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      await expect(
        provider.runMaintenance('kill' as unknown as 'analyze')
      ).rejects.toThrow('Unsupported maintenance type for SQLite');
    });
  });

  // --------------------------------------------------------------------------
  // Overview
  // --------------------------------------------------------------------------

  describe('getOverview()', () => {
    test('returns SQLite version, tableCount, indexCount', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query('CREATE TABLE t1 (id INTEGER PRIMARY KEY)');
      await provider.query('CREATE TABLE t2 (id INTEGER PRIMARY KEY, ref INTEGER)');
      await provider.query('CREATE INDEX idx_ref ON t2(ref)');

      const overview = await provider.getOverview();
      expect(overview.version).toContain('SQLite');
      expect(overview.tableCount).toBe(2);
      expect(overview.indexCount).toBe(1);
      expect(typeof overview.databaseSize).toBe('string');
      expect(typeof overview.databaseSizeBytes).toBe('number');
      expect(overview.activeConnections).toBe(1);
      expect(overview.maxConnections).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Performance metrics
  // --------------------------------------------------------------------------

  describe('getPerformanceMetrics()', () => {
    test('returns cacheHitRatio as a number', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      const perf = await provider.getPerformanceMetrics();
      expect(typeof perf.cacheHitRatio).toBe('number');
      expect(perf.cacheHitRatio).toBeGreaterThanOrEqual(0);
      expect(perf.deadlocks).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Active sessions
  // --------------------------------------------------------------------------

  describe('getActiveSessions()', () => {
    test('returns single session with process pid', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      const sessions = await provider.getActiveSessions();
      expect(sessions.length).toBe(1);

      const session = sessions[0];
      expect(session.pid).toBe(process.pid);
      expect(session.user).toBe('sqlite');
      expect(session.state).toBe('active');
    });
  });

  // --------------------------------------------------------------------------
  // Slow queries
  // --------------------------------------------------------------------------

  describe('getSlowQueries()', () => {
    test('returns empty array (SQLite has no slow query stats)', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      const slow = await provider.getSlowQueries();
      expect(slow).toBeArray();
    });
  });

  // --------------------------------------------------------------------------
  // Table stats
  // --------------------------------------------------------------------------

  describe('getTableStats()', () => {
    test('returns table stats for created tables', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
      await provider.query("INSERT INTO users VALUES (1, 'Alice')");
      await provider.query("INSERT INTO users VALUES (2, 'Bob')");

      const stats = await provider.getTableStats();
      expect(stats).toBeArray();

      const usersStats = stats.find((s) => s.tableName === 'users');
      expect(usersStats).toBeDefined();
      expect(typeof usersStats!.tableName).toBe('string');
    });
  });

  // --------------------------------------------------------------------------
  // Index stats
  // --------------------------------------------------------------------------

  describe('getIndexStats()', () => {
    test('returns index info for created indexes', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, code TEXT)');
      await provider.query('CREATE INDEX idx_name ON items(name)');
      await provider.query('CREATE UNIQUE INDEX idx_code ON items(code)');

      const stats = await provider.getIndexStats();
      expect(stats).toBeArray();
      expect(stats.length).toBeGreaterThanOrEqual(2);
    });
  });

  // --------------------------------------------------------------------------
  // Storage stats
  // --------------------------------------------------------------------------

  describe('getStorageStats()', () => {
    test('returns storage info', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      const stats = await provider.getStorageStats();
      expect(stats).toBeArray();
      expect(stats.length).toBeGreaterThan(0);
      expect(typeof stats[0].name).toBe('string');
      expect(typeof stats[0].size).toBe('string');
    });
  });

  // --------------------------------------------------------------------------
  // Monitoring data (via base getMonitoringData)
  // --------------------------------------------------------------------------

  describe('getMonitoringData()', () => {
    test('returns monitoring data with all sections', async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query('CREATE TABLE md_test (id INTEGER PRIMARY KEY)');

      const data = await provider.getMonitoringData();
      expect(data.timestamp).toBeInstanceOf(Date);
      expect(data.overview).toBeDefined();
      expect(data.performance).toBeDefined();
      expect(data.slowQueries).toBeArray();
      expect(data.activeSessions).toBeArray();
    });
  });

  // --------------------------------------------------------------------------
  // prepareQuery
  // --------------------------------------------------------------------------

  describe('prepareQuery()', () => {
    test('SELECT gets LIMIT appended', () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      const result = provider.prepareQuery('SELECT * FROM users');
      expect(result.wasLimited).toBe(true);
      expect(result.query).toContain('LIMIT');
    });

    test('non-SELECT passes through unchanged', () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      const sql = "INSERT INTO users VALUES (1, 'test')";
      const result = provider.prepareQuery(sql);
      expect(result.query).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Labels
  // --------------------------------------------------------------------------

  describe('getLabels()', () => {
    test('returns correct SQLite labels', () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      const labels = provider.getLabels();
      expect(labels.entityName).toBe('Table');
      expect(typeof labels.selectAction).toBe('string');
    });
  });
});
