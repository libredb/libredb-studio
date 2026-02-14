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

  if (upper.includes('V$SESSION')) {
    return {
      rows: [
        { CNT: 8, SID: 101, USERNAME: 'TEST_USER', STATUS: 'ACTIVE', QUERY: 'sel1', DATABASE: 'ORCL', DURATION: '00:01:23' },
      ],
      metaData: [{ name: 'CNT' }, { name: 'SID' }],
    };
  }

  if (upper.includes('USER_SEGMENTS')) {
    return {
      rows: [{ SIZE_MB: 256, TOTAL: 268435456 }],
      metaData: [{ name: 'SIZE_MB' }],
    };
  }

  if (upper.includes('V$SYSSTAT')) {
    return {
      rows: [{ HIT_RATIO: 97.5 }],
      metaData: [{ name: 'HIT_RATIO' }],
    };
  }

  if (upper.includes('V$SQL')) {
    return {
      rows: [{ QUERY: 'SELECT * FROM big_table', CALLS: 42, AVGTIME: '150ms', QUERY_ID: 'abc', TOTAL_TIME: 6300, AVG_TIME: 150, ROW_CNT: 1000, BUF_GETS: 500, DISK_READS: 20 }],
      metaData: [{ name: 'QUERY' }, { name: 'CALLS' }, { name: 'AVGTIME' }],
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
});
