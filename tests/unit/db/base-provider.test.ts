import { describe, test, expect } from 'bun:test';
import { BaseDatabaseProvider } from '@/lib/db/base-provider';
import { DatabaseConfigError } from '@/lib/db/errors';
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
// Concrete TestProvider extending the abstract BaseDatabaseProvider
// ============================================================================

class TestProvider extends BaseDatabaseProvider {
  constructor(config: DatabaseConnection, options: ProviderOptions = {}) {
    super(config, options);
  }

  async connect(): Promise<void> {
    this.setConnected(true);
  }

  async disconnect(): Promise<void> {
    this.setConnected(false);
  }

  async query(): Promise<QueryResult> {
    return { rows: [], fields: [], rowCount: 0, executionTime: 0 };
  }

  async getSchema(): Promise<TableSchema[]> {
    return [
      { name: 'users', columns: [], indexes: [], foreignKeys: [] },
      { name: 'orders', columns: [], indexes: [], foreignKeys: [] },
    ];
  }

  async getHealth(): Promise<HealthInfo> {
    return {
      activeConnections: 0,
      databaseSize: '0',
      cacheHitRatio: '0%',
      slowQueries: [],
      activeSessions: [],
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async runMaintenance(_type: MaintenanceType, _target?: string): Promise<MaintenanceResult> {
    return { success: true, executionTime: 0, message: 'ok' };
  }

  async getOverview(): Promise<DatabaseOverview> {
    return {
      version: 'test',
      uptime: '0',
      activeConnections: 0,
      maxConnections: 0,
      databaseSize: '0',
      databaseSizeBytes: 0,
      tableCount: 0,
      indexCount: 0,
    };
  }

  async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    return { cacheHitRatio: 99 };
  }

  async getSlowQueries(): Promise<SlowQueryStats[]> {
    return [];
  }

  async getActiveSessions(): Promise<ActiveSessionDetails[]> {
    return [];
  }

  async getTableStats(): Promise<TableStats[]> {
    return [];
  }

  async getIndexStats(): Promise<IndexStats[]> {
    return [];
  }

  async getStorageStats(): Promise<StorageStats[]> {
    return [];
  }

  // ── Expose protected methods for testing ──────────────────────────────
  public callEnsureConnected(): void {
    this.ensureConnected();
  }

  public callTrackQuery<T>(fn: () => Promise<T>): Promise<T> {
    return this.trackQuery(fn);
  }

  public callMeasureExecution<T>(
    fn: () => Promise<T>,
  ): Promise<{ result: T; executionTime: number }> {
    return this.measureExecution(fn);
  }

  public callSetConnected(connected: boolean): void {
    this.setConnected(connected);
  }

  public callSetError(error: Error): void {
    this.setError(error);
  }

  public callGetSafeConfig(): Record<string, unknown> {
    return this.getSafeConfig();
  }

  public callGetConnectionInfo(): string {
    return this.getConnectionInfo();
  }

  public getState() {
    return this.state;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: 'test-1',
    name: 'Test DB',
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'testdb',
    user: 'testuser',
    password: 'secret123',
    createdAt: new Date(),
    ...overrides,
  } as DatabaseConnection;
}

// ============================================================================
// Tests
// ============================================================================

describe('BaseDatabaseProvider', () => {
  // ─── isConnected ───────────────────────────────────────────────────────

  describe('isConnected', () => {
    test('returns false initially', () => {
      const provider = new TestProvider(makeConfig());
      expect(provider.isConnected()).toBe(false);
    });

    test('returns true after connect', async () => {
      const provider = new TestProvider(makeConfig());
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test('returns false after disconnect', async () => {
      const provider = new TestProvider(makeConfig());
      await provider.connect();
      await provider.disconnect();
      expect(provider.isConnected()).toBe(false);
    });
  });

  // ─── validate ──────────────────────────────────────────────────────────

  describe('validate', () => {
    test('throws DatabaseConfigError when id is missing', () => {
      const provider = new TestProvider(makeConfig({ id: '' }));
      expect(() => provider.validate()).toThrow(DatabaseConfigError);
      expect(() => provider.validate()).toThrow('Connection ID is required');
    });

    test('throws DatabaseConfigError when type is missing', () => {
      const provider = new TestProvider(makeConfig({ type: '' as DatabaseConnection['type'] }));
      expect(() => provider.validate()).toThrow(DatabaseConfigError);
      expect(() => provider.validate()).toThrow('Database type is required');
    });

    test('does not throw for valid config', () => {
      const provider = new TestProvider(makeConfig());
      expect(() => provider.validate()).not.toThrow();
    });
  });

  // ─── getCapabilities ──────────────────────────────────────────────────

  describe('getCapabilities', () => {
    test('returns default capabilities', () => {
      const provider = new TestProvider(makeConfig());
      const caps = provider.getCapabilities();

      expect(caps.queryLanguage).toBe('sql');
      expect(caps.supportsExplain).toBe(true);
      expect(caps.supportsExternalQueryLimiting).toBe(true);
      expect(caps.supportsCreateTable).toBe(true);
      expect(caps.supportsMaintenance).toBe(true);
      expect(caps.maintenanceOperations).toBeArray();
      expect(caps.maintenanceOperations).toContain('vacuum');
      expect(caps.maintenanceOperations).toContain('analyze');
      expect(caps.supportsConnectionString).toBe(false);
      expect(caps.defaultPort).toBeNull();
      expect(caps.schemaRefreshPattern).toBeDefined();
    });
  });

  // ─── getLabels ────────────────────────────────────────────────────────

  describe('getLabels', () => {
    test('returns default labels', () => {
      const provider = new TestProvider(makeConfig());
      const labels = provider.getLabels();

      expect(labels.entityName).toBe('Table');
      expect(labels.entityNamePlural).toBe('Tables');
      expect(labels.rowName).toBe('row');
      expect(labels.rowNamePlural).toBe('rows');
      expect(labels.selectAction).toBe('Select Top 100');
      expect(labels.searchPlaceholder).toBe('Search tables or columns...');
    });
  });

  // ─── prepareQuery ────────────────────────────────────────────────────

  describe('prepareQuery', () => {
    test('returns query unchanged with wasLimited=false', () => {
      const provider = new TestProvider(makeConfig());
      const result = provider.prepareQuery('SELECT * FROM users');

      expect(result.query).toBe('SELECT * FROM users');
      expect(result.wasLimited).toBe(false);
      expect(result.limit).toBe(500);
      expect(result.offset).toBe(0);
    });

    test('respects custom limit and offset options', () => {
      const provider = new TestProvider(makeConfig());
      const result = provider.prepareQuery('SELECT 1', { limit: 100, offset: 50 });

      expect(result.limit).toBe(100);
      expect(result.offset).toBe(50);
    });
  });

  // ─── getTables ────────────────────────────────────────────────────────

  describe('getTables', () => {
    test('calls getSchema and returns table names', async () => {
      const provider = new TestProvider(makeConfig());
      const tables = await provider.getTables();

      expect(tables).toEqual(['users', 'orders']);
    });
  });

  // ─── ensureConnected ──────────────────────────────────────────────────

  describe('ensureConnected', () => {
    test('throws when not connected', () => {
      const provider = new TestProvider(makeConfig());
      expect(() => provider.callEnsureConnected()).toThrow(
        'Provider is not connected. Call connect() first.',
      );
    });

    test('does not throw when connected', async () => {
      const provider = new TestProvider(makeConfig());
      await provider.connect();
      expect(() => provider.callEnsureConnected()).not.toThrow();
    });
  });

  // ─── trackQuery ───────────────────────────────────────────────────────

  describe('trackQuery', () => {
    test('increments and decrements activeQueries', async () => {
      const provider = new TestProvider(makeConfig());

      expect(provider.getState().activeQueries).toBe(0);

      let insideCount: number | undefined;
      await provider.callTrackQuery(async () => {
        insideCount = provider.getState().activeQueries;
        return 'done';
      });

      expect(insideCount).toBe(1);
      expect(provider.getState().activeQueries).toBe(0);
    });

    test('decrements activeQueries even if fn throws', async () => {
      const provider = new TestProvider(makeConfig());

      try {
        await provider.callTrackQuery(async () => {
          throw new Error('boom');
        });
      } catch {
        // expected
      }

      expect(provider.getState().activeQueries).toBe(0);
    });
  });

  // ─── measureExecution ─────────────────────────────────────────────────

  describe('measureExecution', () => {
    test('returns result and executionTime >= 0', async () => {
      const provider = new TestProvider(makeConfig());

      const { result, executionTime } = await provider.callMeasureExecution(async () => {
        return 42;
      });

      expect(result).toBe(42);
      expect(executionTime).toBeGreaterThanOrEqual(0);
      expect(typeof executionTime).toBe('number');
    });
  });

  // ─── setConnected / setError ──────────────────────────────────────────

  describe('setConnected / setError', () => {
    test('setConnected(true) sets connected and lastConnected', () => {
      const provider = new TestProvider(makeConfig());
      provider.callSetConnected(true);

      expect(provider.getState().connected).toBe(true);
      expect(provider.getState().lastConnected).toBeInstanceOf(Date);
      expect(provider.getState().lastError).toBeUndefined();
    });

    test('setError records error and sets connected=false', () => {
      const provider = new TestProvider(makeConfig());
      provider.callSetConnected(true);

      const err = new Error('connection lost');
      provider.callSetError(err);

      expect(provider.getState().connected).toBe(false);
      expect(provider.getState().lastError).toBe(err);
    });
  });

  // ─── getSafeConfig ────────────────────────────────────────────────────

  describe('getSafeConfig', () => {
    test('excludes password and connectionString', () => {
      const provider = new TestProvider(
        makeConfig({ password: 'supersecret', connectionString: 'postgres://user:pass@host/db' }),
      );
      const safe = provider.callGetSafeConfig();

      expect(safe).toHaveProperty('id');
      expect(safe).toHaveProperty('name');
      expect(safe).toHaveProperty('type');
      expect(safe).toHaveProperty('host');
      expect(safe).toHaveProperty('port');
      expect(safe).toHaveProperty('database');
      expect(safe).toHaveProperty('user');
      expect(safe).not.toHaveProperty('password');
      expect(safe).not.toHaveProperty('connectionString');
    });
  });

  // ─── getConnectionInfo ────────────────────────────────────────────────

  describe('getConnectionInfo', () => {
    test('returns host:port/database when no connectionString', () => {
      const provider = new TestProvider(makeConfig());
      const info = provider.callGetConnectionInfo();
      expect(info).toBe('localhost:5432/testdb');
    });

    test('masks password in connection string', () => {
      const provider = new TestProvider(
        makeConfig({ connectionString: 'postgres://admin:s3cret@db.example.com:5432/mydb' }),
      );
      const info = provider.callGetConnectionInfo();

      expect(info).not.toContain('s3cret');
      expect(info).toContain(':***@');
      expect(info).toContain('db.example.com');
    });
  });
});
