/**
 * Integration tests for DemoProvider
 * No native dependencies — direct import is fine.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { DemoProvider } from '@/lib/db/providers/demo';
import type { DatabaseConnection } from '@/lib/types';

// ============================================================================
// Helpers
// ============================================================================

function makeDemoConfig(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: 'demo-1',
    name: 'Demo',
    type: 'demo',
    createdAt: new Date(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('DemoProvider', () => {
  let provider: DemoProvider;

  beforeEach(() => {
    provider = new DemoProvider(makeDemoConfig());
  });

  // --------------------------------------------------------------------------
  // Connection lifecycle
  // --------------------------------------------------------------------------

  describe('connect / disconnect', () => {
    test('isConnected() is false before connect', () => {
      expect(provider.isConnected()).toBe(false);
    });

    test('connect() sets connected to true', async () => {
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test('disconnect() sets connected to false', async () => {
      await provider.connect();
      await provider.disconnect();
      expect(provider.isConnected()).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Query execution
  // --------------------------------------------------------------------------

  describe('query()', () => {
    test('SELECT * FROM users returns 5 rows with correct fields', async () => {
      await provider.connect();
      const result = await provider.query('SELECT * FROM users');
      expect(result.rows.length).toBe(5);
      expect(result.fields).toEqual(['id', 'email', 'full_name', 'created_at']);
      expect(result.rowCount).toBe(5);
      expect(typeof result.executionTime).toBe('number');
    });

    test('SELECT * FROM products returns 5 rows', async () => {
      await provider.connect();
      const result = await provider.query('SELECT * FROM products');
      expect(result.rows.length).toBe(5);
      expect(result.fields).toEqual(['id', 'name', 'price', 'stock', 'category']);
    });

    test('SELECT * FROM orders returns 5 rows', async () => {
      await provider.connect();
      const result = await provider.query('SELECT * FROM orders');
      expect(result.rows.length).toBe(5);
      expect(result.fields).toEqual(['id', 'user_id', 'total_amount', 'status', 'order_date']);
    });

    test('WHERE clause filters users by id', async () => {
      await provider.connect();
      const result = await provider.query('SELECT * FROM users WHERE id = 1');
      expect(result.rows.length).toBe(1);
      expect((result.rows[0] as Record<string, unknown>).id).toBe(1);
    });

    test('LIMIT restricts returned rows', async () => {
      await provider.connect();
      const result = await provider.query('SELECT * FROM users LIMIT 2');
      expect(result.rows.length).toBe(2);
    });

    test('COUNT(*) returns { count: 100 }', async () => {
      await provider.connect();
      const result = await provider.query('SELECT COUNT(*) FROM anything');
      expect(result.rows.length).toBe(1);
      expect((result.rows[0] as Record<string, unknown>).count).toBe(100);
      expect(result.fields).toEqual(['count']);
    });

    test('unknown table returns hint message', async () => {
      await provider.connect();
      const result = await provider.query('SELECT * FROM unknown_table');
      expect(result.rows.length).toBe(1);
      expect((result.rows[0] as Record<string, unknown>).message).toBeDefined();
      expect((result.rows[0] as Record<string, unknown>).hint).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Schema
  // --------------------------------------------------------------------------

  describe('getSchema()', () => {
    test('returns 3 tables: users, products, orders', async () => {
      await provider.connect();
      const schema = await provider.getSchema();
      expect(schema.length).toBe(3);

      const names = schema.map((t) => t.name);
      expect(names).toContain('users');
      expect(names).toContain('products');
      expect(names).toContain('orders');
    });

    test('each table has columns, indexes, and foreignKeys', async () => {
      await provider.connect();
      const schema = await provider.getSchema();
      for (const table of schema) {
        expect(table.columns.length).toBeGreaterThan(0);
        expect(Array.isArray(table.indexes)).toBe(true);
        expect(Array.isArray(table.foreignKeys)).toBe(true);
      }
    });

    test('orders table has foreignKey referencing users', async () => {
      await provider.connect();
      const schema = await provider.getSchema();
      const orders = schema.find((t) => t.name === 'orders')!;
      expect(orders.foreignKeys!.length).toBe(1);
      expect(orders.foreignKeys![0].columnName).toBe('user_id');
      expect(orders.foreignKeys![0].referencedTable).toBe('users');
      expect(orders.foreignKeys![0].referencedColumn).toBe('id');
    });
  });

  // --------------------------------------------------------------------------
  // Health
  // --------------------------------------------------------------------------

  describe('getHealth()', () => {
    test('returns health info with required fields', async () => {
      await provider.connect();
      const health = await provider.getHealth();
      expect(typeof health.activeConnections).toBe('number');
      expect(typeof health.databaseSize).toBe('string');
      expect(typeof health.cacheHitRatio).toBe('string');
      expect(Array.isArray(health.slowQueries)).toBe(true);
      expect(Array.isArray(health.activeSessions)).toBe(true);
      expect(health.slowQueries.length).toBe(3);
      expect(health.activeSessions.length).toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  // Maintenance
  // --------------------------------------------------------------------------

  describe('runMaintenance()', () => {
    test('vacuum returns success', async () => {
      await provider.connect();
      const result = await provider.runMaintenance('vacuum', 'users');
      expect(result.success).toBe(true);
      expect(typeof result.executionTime).toBe('number');
      expect(result.message).toContain('VACUUM');
    });

    test('analyze returns success', async () => {
      await provider.connect();
      const result = await provider.runMaintenance('analyze');
      expect(result.success).toBe(true);
      expect(result.message).toContain('ANALYZE');
    });

    test('reindex returns success', async () => {
      await provider.connect();
      const result = await provider.runMaintenance('reindex');
      expect(result.success).toBe(true);
      expect(result.message).toContain('REINDEX');
    });

    test('kill returns success', async () => {
      await provider.connect();
      const result = await provider.runMaintenance('kill', '1234');
      expect(result.success).toBe(true);
      expect(result.message).toContain('1234');
    });

    test('optimize returns success', async () => {
      await provider.connect();
      const result = await provider.runMaintenance('optimize');
      expect(result.success).toBe(true);
      expect(result.message).toContain('OPTIMIZE');
    });

    test('check returns success', async () => {
      await provider.connect();
      const result = await provider.runMaintenance('check');
      expect(result.success).toBe(true);
      expect(result.message).toContain('CHECK');
    });
  });

  // --------------------------------------------------------------------------
  // Capabilities
  // --------------------------------------------------------------------------

  describe('getCapabilities()', () => {
    test('returns capabilities with defaultPort null and supportsConnectionString false', () => {
      const caps = provider.getCapabilities();
      expect(caps.defaultPort).toBeNull();
      expect(caps.supportsConnectionString).toBe(false);
      expect(caps.queryLanguage).toBe('sql');
      expect(caps.supportsExplain).toBe(true);
      expect(caps.supportsMaintenance).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Monitoring methods
  // --------------------------------------------------------------------------

  describe('getOverview()', () => {
    test('returns database overview', async () => {
      await provider.connect();
      const overview = await provider.getOverview();
      expect(overview.version).toContain('Demo');
      expect(typeof overview.activeConnections).toBe('number');
      expect(typeof overview.maxConnections).toBe('number');
      expect(typeof overview.databaseSize).toBe('string');
      expect(overview.tableCount).toBe(3);
      expect(overview.indexCount).toBe(8);
    });
  });

  describe('getPerformanceMetrics()', () => {
    test('returns performance metrics', async () => {
      await provider.connect();
      const perf = await provider.getPerformanceMetrics();
      expect(typeof perf.cacheHitRatio).toBe('number');
      expect(typeof perf.queriesPerSecond).toBe('number');
      expect(typeof perf.bufferPoolUsage).toBe('number');
      expect(perf.deadlocks).toBe(0);
    });
  });

  describe('getSlowQueries()', () => {
    test('returns slow query list', async () => {
      await provider.connect();
      const slow = await provider.getSlowQueries();
      expect(slow.length).toBe(5);
      for (const q of slow) {
        expect(typeof q.query).toBe('string');
        expect(typeof q.calls).toBe('number');
        expect(typeof q.avgTime).toBe('number');
        expect(typeof q.totalTime).toBe('number');
      }
    });
  });

  describe('getActiveSessions()', () => {
    test('returns active sessions', async () => {
      await provider.connect();
      const sessions = await provider.getActiveSessions();
      expect(sessions.length).toBe(5);
      for (const s of sessions) {
        expect(typeof s.pid).toBe('number');
        expect(typeof s.user).toBe('string');
        expect(typeof s.state).toBe('string');
      }
    });
  });

  describe('getTableStats()', () => {
    test('returns stats for 3 tables', async () => {
      await provider.connect();
      const stats = await provider.getTableStats();
      expect(stats.length).toBe(3);
      const tableNames = stats.map((s) => s.tableName);
      expect(tableNames).toContain('users');
      expect(tableNames).toContain('products');
      expect(tableNames).toContain('orders');
    });
  });

  describe('getIndexStats()', () => {
    test('returns stats for 8 indexes', async () => {
      await provider.connect();
      const stats = await provider.getIndexStats();
      expect(stats.length).toBe(8);
      for (const idx of stats) {
        expect(typeof idx.indexName).toBe('string');
        expect(typeof idx.scans).toBe('number');
      }
    });
  });

  describe('getStorageStats()', () => {
    test('returns 3 storage entries', async () => {
      await provider.connect();
      const storage = await provider.getStorageStats();
      expect(storage.length).toBe(3);
      const names = storage.map((s) => s.name);
      expect(names).toContain('pg_default');
      expect(names).toContain('pg_global');
      expect(names).toContain('WAL');
    });
  });
});
