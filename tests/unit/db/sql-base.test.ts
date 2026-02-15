/**
 * Unit tests for SQLBaseProvider
 * Uses a concrete TestSQLProvider to expose protected methods
 */

import { describe, test, expect } from 'bun:test';
import { SQLBaseProvider } from '@/lib/db/providers/sql/sql-base';
import type {
  DatabaseConnection,
  QueryResult,
  TableSchema,
  HealthInfo,
  MaintenanceType,
  MaintenanceResult,
  ProviderOptions,
  DatabaseOverview,
  PerformanceMetrics,
  SlowQueryStats,
  ActiveSessionDetails,
  TableStats,
  IndexStats,
  StorageStats,
} from '@/lib/db/types';

// ============================================================================
// Concrete test provider
// ============================================================================

class TestSQLProvider extends SQLBaseProvider {
  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
  }

  async connect(): Promise<void> { this.setConnected(true); }
  async disconnect(): Promise<void> { this.setConnected(false); }
  async query(): Promise<QueryResult> { return { rows: [], fields: [], rowCount: 0, executionTime: 0 }; }
  async getSchema(): Promise<TableSchema[]> { return []; }
  async getHealth(): Promise<HealthInfo> { return { activeConnections: 0, databaseSize: '0', cacheHitRatio: '0%', slowQueries: [], activeSessions: [] }; }
  async runMaintenance(_type: MaintenanceType, _target?: string): Promise<MaintenanceResult> { return { success: true, executionTime: 0, message: 'ok' }; }
  async getOverview(): Promise<DatabaseOverview> { return { version: '', uptime: '', activeConnections: 0, maxConnections: 0, databaseSize: '', databaseSizeBytes: 0, tableCount: 0, indexCount: 0 }; }
  async getPerformanceMetrics(): Promise<PerformanceMetrics> { return { cacheHitRatio: 0 }; }
  async getSlowQueries(): Promise<SlowQueryStats[]> { return []; }
  async getActiveSessions(): Promise<ActiveSessionDetails[]> { return []; }
  async getTableStats(): Promise<TableStats[]> { return []; }
  async getIndexStats(): Promise<IndexStats[]> { return []; }
  async getStorageStats(): Promise<StorageStats[]> { return []; }

  // Expose protected methods
  public callEscapeIdentifier(id: string): string { return this.escapeIdentifier(id); }
  public callEscapeString(val: string): string { return this.escapeString(val); }
  public callBuildLimitClause(limit: number, offset?: number): string { return this.buildLimitClause(limit, offset); }
  public callGetPlaceholder(index: number): string { return this.getPlaceholder(index); }
  public callShouldEnableSSL(): boolean { return this.shouldEnableSSL(); }
  public callGetInformationSchemaName(): string { return this.getInformationSchemaName(); }
  public callGetDefaultSchema(): string { return this.getDefaultSchema(); }
  public callIsReadOnlyQuery(sql: string): boolean { return this.isReadOnlyQuery(sql); }
  public callIsSchemaModifyingQuery(sql: string): boolean { return this.isSchemaModifyingQuery(sql); }
}

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(type: DatabaseConnection['type'], overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: 'test-1',
    name: 'Test DB',
    type,
    host: 'localhost',
    port: 5432,
    database: 'testdb',
    user: 'testuser',
    password: 'secret',
    createdAt: new Date(),
    ...overrides,
  } as DatabaseConnection;
}

// ============================================================================
// Tests
// ============================================================================

describe('SQLBaseProvider', () => {
  // --------------------------------------------------------------------------
  // escapeIdentifier
  // --------------------------------------------------------------------------

  describe('escapeIdentifier()', () => {
    test('postgres wraps in double quotes', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callEscapeIdentifier('users')).toBe('"users"');
    });

    test('mysql wraps in backticks', () => {
      const p = new TestSQLProvider(makeConfig('mysql'));
      expect(p.callEscapeIdentifier('users')).toBe('`users`');
    });

    test('sqlite wraps in double quotes', () => {
      const p = new TestSQLProvider(makeConfig('sqlite'));
      expect(p.callEscapeIdentifier('users')).toBe('"users"');
    });

    test('mssql wraps in square brackets', () => {
      const p = new TestSQLProvider(makeConfig('mssql'));
      expect(p.callEscapeIdentifier('users')).toBe('[users]');
    });

    test('mssql escapes ] in identifier', () => {
      const p = new TestSQLProvider(makeConfig('mssql'));
      expect(p.callEscapeIdentifier('my]table')).toBe('[my]]table]');
    });

    test('postgres escapes embedded double quotes', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callEscapeIdentifier('my"table')).toBe('"my""table"');
    });

    test('mysql escapes embedded backticks', () => {
      const p = new TestSQLProvider(makeConfig('mysql'));
      expect(p.callEscapeIdentifier('my`table')).toBe('`my``table`');
    });
  });

  // --------------------------------------------------------------------------
  // escapeString
  // --------------------------------------------------------------------------

  describe('escapeString()', () => {
    test('escapes single quotes', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callEscapeString("O'Brien")).toBe("O''Brien");
    });

    test('no change for strings without quotes', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callEscapeString('hello')).toBe('hello');
    });
  });

  // --------------------------------------------------------------------------
  // buildLimitClause
  // --------------------------------------------------------------------------

  describe('buildLimitClause()', () => {
    test('builds LIMIT without offset', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callBuildLimitClause(100)).toBe('LIMIT 100');
    });

    test('builds LIMIT OFFSET when offset > 0', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callBuildLimitClause(50, 10)).toBe('LIMIT 50 OFFSET 10');
    });

    test('LIMIT only when offset is 0', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callBuildLimitClause(50, 0)).toBe('LIMIT 50');
    });
  });

  // --------------------------------------------------------------------------
  // getPlaceholder
  // --------------------------------------------------------------------------

  describe('getPlaceholder()', () => {
    test('postgres returns $N', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callGetPlaceholder(1)).toBe('$1');
      expect(p.callGetPlaceholder(3)).toBe('$3');
    });

    test('mysql returns ?', () => {
      const p = new TestSQLProvider(makeConfig('mysql'));
      expect(p.callGetPlaceholder(1)).toBe('?');
    });

    test('sqlite returns ?', () => {
      const p = new TestSQLProvider(makeConfig('sqlite'));
      expect(p.callGetPlaceholder(1)).toBe('?');
    });

    test('oracle returns :N', () => {
      const p = new TestSQLProvider(makeConfig('oracle'));
      expect(p.callGetPlaceholder(1)).toBe(':1');
      expect(p.callGetPlaceholder(5)).toBe(':5');
    });

    test('mssql returns @pN', () => {
      const p = new TestSQLProvider(makeConfig('mssql'));
      expect(p.callGetPlaceholder(1)).toBe('@p1');
      expect(p.callGetPlaceholder(2)).toBe('@p2');
    });
  });

  // --------------------------------------------------------------------------
  // shouldEnableSSL
  // --------------------------------------------------------------------------

  describe('shouldEnableSSL()', () => {
    test('returns false for localhost', () => {
      const p = new TestSQLProvider(makeConfig('postgres', { host: 'localhost' }));
      expect(p.callShouldEnableSSL()).toBe(false);
    });

    test('returns true for supabase host', () => {
      const p = new TestSQLProvider(makeConfig('postgres', { host: 'db.supabase.co' }));
      expect(p.callShouldEnableSSL()).toBe(true);
    });

    test('returns true for neon host', () => {
      const p = new TestSQLProvider(makeConfig('postgres', { host: 'ep-cool-neon.neon.tech' }));
      expect(p.callShouldEnableSSL()).toBe(true);
    });

    test('returns true for render host', () => {
      const p = new TestSQLProvider(makeConfig('postgres', { host: 'mydb.render.com' }));
      expect(p.callShouldEnableSSL()).toBe(true);
    });

    test('returns true for aws host', () => {
      const p = new TestSQLProvider(makeConfig('postgres', { host: 'mydb.aws.rds.amazonaws.com' }));
      expect(p.callShouldEnableSSL()).toBe(true);
    });

    test('returns true for azure host', () => {
      const p = new TestSQLProvider(makeConfig('postgres', { host: 'mydb.azure.postgres.database.com' }));
      expect(p.callShouldEnableSSL()).toBe(true);
    });

    test('returns true when options.ssl is true', () => {
      const p = new TestSQLProvider(makeConfig('postgres', { host: 'localhost' }), { ssl: true });
      expect(p.callShouldEnableSSL()).toBe(true);
    });

    test('returns false for plain hostname', () => {
      const p = new TestSQLProvider(makeConfig('postgres', { host: 'mydb.internal.company.com' }));
      expect(p.callShouldEnableSSL()).toBe(false);
    });

    test('returns true for planetscale host', () => {
      const p = new TestSQLProvider(makeConfig('mysql', { host: 'mydb.planetscale.host' }));
      expect(p.callShouldEnableSSL()).toBe(true);
    });

    test('returns true for gcp host', () => {
      const p = new TestSQLProvider(makeConfig('postgres', { host: 'mydb.gcp.cloudsql.com' }));
      expect(p.callShouldEnableSSL()).toBe(true);
    });

    test('returns true for generic cloud host', () => {
      const p = new TestSQLProvider(makeConfig('postgres', { host: 'mydb.cloud.provider.com' }));
      expect(p.callShouldEnableSSL()).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // getInformationSchemaName
  // --------------------------------------------------------------------------

  describe('getInformationSchemaName()', () => {
    test('returns information_schema', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callGetInformationSchemaName()).toBe('information_schema');
    });
  });

  // --------------------------------------------------------------------------
  // getDefaultSchema
  // --------------------------------------------------------------------------

  describe('getDefaultSchema()', () => {
    test('postgres returns public', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callGetDefaultSchema()).toBe('public');
    });

    test('mysql returns database name', () => {
      const p = new TestSQLProvider(makeConfig('mysql', { database: 'mydb' }));
      expect(p.callGetDefaultSchema()).toBe('mydb');
    });

    test('oracle returns uppercased user', () => {
      const p = new TestSQLProvider(makeConfig('oracle', { user: 'scott' }));
      expect(p.callGetDefaultSchema()).toBe('SCOTT');
    });

    test('mssql returns dbo', () => {
      const p = new TestSQLProvider(makeConfig('mssql'));
      expect(p.callGetDefaultSchema()).toBe('dbo');
    });

    test('sqlite returns empty string', () => {
      const p = new TestSQLProvider(makeConfig('sqlite'));
      expect(p.callGetDefaultSchema()).toBe('');
    });
  });

  // --------------------------------------------------------------------------
  // isReadOnlyQuery
  // --------------------------------------------------------------------------

  describe('isReadOnlyQuery()', () => {
    test('SELECT is read-only', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callIsReadOnlyQuery('SELECT * FROM users')).toBe(true);
    });

    test('SHOW is read-only', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callIsReadOnlyQuery('SHOW DATABASES')).toBe(true);
    });

    test('DESCRIBE is read-only', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callIsReadOnlyQuery('DESCRIBE users')).toBe(true);
    });

    test('EXPLAIN is read-only', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callIsReadOnlyQuery('EXPLAIN SELECT 1')).toBe(true);
    });

    test('PRAGMA is read-only', () => {
      const p = new TestSQLProvider(makeConfig('sqlite'));
      expect(p.callIsReadOnlyQuery('PRAGMA table_info(users)')).toBe(true);
    });

    test('INSERT is NOT read-only', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callIsReadOnlyQuery("INSERT INTO users VALUES (1, 'test')")).toBe(false);
    });

    test('UPDATE is NOT read-only', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callIsReadOnlyQuery('UPDATE users SET name = \'x\'')).toBe(false);
    });

    test('DELETE is NOT read-only', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callIsReadOnlyQuery('DELETE FROM users')).toBe(false);
    });

    test('case insensitive', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callIsReadOnlyQuery('select * from users')).toBe(true);
    });

    test('leading whitespace handled', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callIsReadOnlyQuery('  SELECT 1')).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // isSchemaModifyingQuery
  // --------------------------------------------------------------------------

  describe('isSchemaModifyingQuery()', () => {
    test('CREATE is schema-modifying', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callIsSchemaModifyingQuery('CREATE TABLE users (id int)')).toBe(true);
    });

    test('DROP is schema-modifying', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callIsSchemaModifyingQuery('DROP TABLE users')).toBe(true);
    });

    test('ALTER is schema-modifying', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callIsSchemaModifyingQuery('ALTER TABLE users ADD col text')).toBe(true);
    });

    test('TRUNCATE is schema-modifying', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callIsSchemaModifyingQuery('TRUNCATE TABLE users')).toBe(true);
    });

    test('SELECT is NOT schema-modifying', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callIsSchemaModifyingQuery('SELECT * FROM users')).toBe(false);
    });

    test('INSERT is NOT schema-modifying', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callIsSchemaModifyingQuery("INSERT INTO users VALUES (1)")).toBe(false);
    });

    test('case insensitive', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      expect(p.callIsSchemaModifyingQuery('create table t(id int)')).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // prepareQuery (override from SQLBaseProvider)
  // --------------------------------------------------------------------------

  describe('prepareQuery()', () => {
    test('SELECT gets LIMIT applied', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      const result = p.prepareQuery('SELECT * FROM users');
      expect(result.wasLimited).toBe(true);
      expect(result.query).toContain('LIMIT');
    });

    test('non-SELECT passes through unchanged', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      const sql = "INSERT INTO users (name) VALUES ('test')";
      const result = p.prepareQuery(sql);
      expect(result.query).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    test('respects custom limit', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      const result = p.prepareQuery('SELECT * FROM users', { limit: 25 });
      expect(result.limit).toBe(25);
    });

    test('respects offset', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      const result = p.prepareQuery('SELECT * FROM users', { limit: 50, offset: 100 });
      expect(result.offset).toBe(100);
    });

    test('unlimited mode uses MAX_UNLIMITED_ROWS', () => {
      const p = new TestSQLProvider(makeConfig('postgres'));
      const result = p.prepareQuery('SELECT * FROM users', { unlimited: true });
      expect(result.limit).toBeGreaterThan(500);
    });
  });
});
