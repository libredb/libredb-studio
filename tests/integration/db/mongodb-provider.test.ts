/**
 * MongoDB Provider Integration Tests
 *
 * Uses mock.module() from bun:test to mock the 'mongodb' driver
 * before importing the MongoDBProvider class.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { DatabaseConnection } from '@/lib/types';

// ============================================================================
// Mock Setup — MUST come before provider import
// ============================================================================

// Track mock instances for assertions
let mockCollectionData: Record<string, unknown>[] = [];
let mockCollections: { name: string; type: string }[] = [
  { name: 'users', type: 'collection' },
  { name: 'orders', type: 'collection' },
];

const createMockCursor = (data: Record<string, unknown>[]) => {
  const cursor = {
    project: () => cursor,
    sort: () => cursor,
    skip: () => cursor,
    limit: () => cursor,
    toArray: async () => data,
    close: async () => {},
  };
  return cursor;
};

const createMockCollection = () => ({
  find: () => createMockCursor(mockCollectionData),
  findOne: async () => mockCollectionData[0] || null,
  aggregate: () => ({
    toArray: async () => mockCollectionData,
  }),
  countDocuments: async () => mockCollectionData.length,
  distinct: async (field: string) => mockCollectionData.map(d => d[field]),
  insertOne: async () => ({
    insertedId: 'new-id-123',
    acknowledged: true,
  }),
  insertMany: async (docs: Record<string, unknown>[]) => ({
    insertedCount: docs.length,
    insertedIds: docs.map((_, i) => `id-${i}`),
  }),
  updateOne: async () => ({
    matchedCount: 1,
    modifiedCount: 1,
  }),
  updateMany: async () => ({
    matchedCount: 2,
    modifiedCount: 2,
  }),
  deleteOne: async () => ({ deletedCount: 1 }),
  deleteMany: async () => ({ deletedCount: 3 }),
  estimatedDocumentCount: async () => 42,
  indexes: async () => [
    { name: '_id_', key: { _id: 1 }, unique: true },
    { name: 'email_1', key: { email: 1 }, unique: false },
  ],
});

const mockCommandResults: Record<string, unknown> = {};

const createMockDb = () => ({
  command: async (cmd: Record<string, unknown>) => {
    if (cmd.ping) return { ok: 1 };
    if (cmd.collStats) return { size: 1024, totalIndexSize: 512, count: 42 };
    if (cmd.validate) return { ok: 1, valid: true };
    if (cmd.compact) return { ok: 1 };
    return mockCommandResults;
  },
  listCollections: () => ({
    toArray: async () => mockCollections,
  }),
  collection: () => createMockCollection(),
  stats: async () => ({
    dataSize: 2048,
    indexSize: 512,
    storageSize: 4096,
    collections: 2,
    objects: 100,
  }),
  admin: () => ({
    serverStatus: async () => ({
      connections: { current: 5, available: 95 },
      uptime: 86400,
      wiredTiger: {
        cache: {
          'pages read into cache': 10,
          'pages requested from the cache': 1000,
          'bytes currently in the cache': 5000000,
          'maximum bytes configured': 10000000,
        },
      },
      opcounters: { query: 100, insert: 50, update: 30, delete: 20 },
    }),
    command: async (cmd: Record<string, unknown>) => {
      if (cmd.currentOp) return { inprog: [] };
      if (cmd.buildInfo) return { version: '7.0.0' };
      return {};
    },
  }),
});

class MockObjectId {
  private _str: string;
  constructor(str?: string) {
    this._str = str || 'mock-object-id-123456789012';
  }
  toString() {
    return this._str;
  }
}

class MockBinary {
  private _data: Buffer;
  constructor(data?: Buffer | string) {
    this._data = Buffer.from(data || 'binary-data');
  }
  length() {
    return this._data.length;
  }
}

class MockDecimal128 {
  private _val: string;
  constructor(val?: string) {
    this._val = val || '123.456';
  }
  toString() {
    return this._val;
  }
}

mock.module('mongodb', () => ({
  MongoClient: class MockMongoClient {
    private _uri: string;
    private _opts: unknown;

    constructor(uri: string, opts?: unknown) {
      this._uri = uri;
      this._opts = opts;
    }

    async connect() {
      // noop — connection established
    }

    async close() {
      // noop — connection closed
    }

    db() {
      return createMockDb();
    }
  },
  ObjectId: MockObjectId,
  Binary: MockBinary,
  Decimal128: MockDecimal128,
}));

// ============================================================================
// Provider import — AFTER mock registration
// ============================================================================

const { MongoDBProvider } = await import('@/lib/db/providers/document/mongodb');
const { DatabaseConfigError } = await import('@/lib/db/errors');

// ============================================================================
// Test Config
// ============================================================================

const baseConfig: DatabaseConnection = {
  id: 'test-mongo',
  name: 'Test Mongo',
  type: 'mongodb',
  host: 'localhost',
  port: 27017,
  database: 'testdb',
  createdAt: new Date(),
};

// ============================================================================
// Tests
// ============================================================================

describe('MongoDBProvider', () => {
  let provider: InstanceType<typeof MongoDBProvider>;

  beforeEach(() => {
    mockCollectionData = [
      { _id: new MockObjectId('aaa'), name: 'Alice', email: 'alice@test.com' },
      { _id: new MockObjectId('bbb'), name: 'Bob', email: 'bob@test.com' },
    ];
    mockCollections = [
      { name: 'users', type: 'collection' },
      { name: 'orders', type: 'collection' },
    ];
    provider = new MongoDBProvider({ ...baseConfig });
  });

  afterEach(async () => {
    try {
      await provider.disconnect();
    } catch {
      // ignore
    }
  });

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  describe('validation', () => {
    test('throws when host is missing and no connectionString', () => {
      expect(
        () =>
          new MongoDBProvider({
            ...baseConfig,
            host: undefined,
            connectionString: undefined,
          })
      ).toThrow(DatabaseConfigError);
    });

    test('throws when database is missing and no connectionString', () => {
      expect(
        () =>
          new MongoDBProvider({
            ...baseConfig,
            database: undefined,
            connectionString: undefined,
          })
      ).toThrow(DatabaseConfigError);
    });

    test('connectionString bypasses host/database requirement', () => {
      expect(
        () =>
          new MongoDBProvider({
            ...baseConfig,
            host: undefined,
            database: undefined,
            connectionString: 'mongodb://remote:27017/mydb',
          })
      ).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Connection lifecycle
  // --------------------------------------------------------------------------

  describe('connect / disconnect', () => {
    test('connect succeeds and marks provider as connected', async () => {
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test('disconnect succeeds and marks provider as disconnected', async () => {
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

  // --------------------------------------------------------------------------
  // getCapabilities()
  // --------------------------------------------------------------------------

  describe('getCapabilities()', () => {
    test('returns correct capability metadata', () => {
      const caps = provider.getCapabilities();
      expect(caps.queryLanguage).toBe('json');
      expect(caps.defaultPort).toBe(27017);
      expect(caps.supportsCreateTable).toBe(false);
      expect(caps.supportsConnectionString).toBe(true);
      expect(caps.supportsMaintenance).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // getLabels()
  // --------------------------------------------------------------------------

  describe('getLabels()', () => {
    test('returns correct provider labels', () => {
      const labels = provider.getLabels();
      expect(labels.entityName).toBe('Collection');
      expect(labels.rowName).toBe('document');
      expect(labels.selectAction).toBe('Find Documents');
    });
  });

  // --------------------------------------------------------------------------
  // prepareQuery()
  // --------------------------------------------------------------------------

  describe('prepareQuery()', () => {
    test('returns query unchanged with wasLimited=false', () => {
      const input = '{"collection":"users","operation":"find"}';
      const prepared = provider.prepareQuery(input);
      expect(prepared.query).toBe(input);
      expect(prepared.wasLimited).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // query()
  // --------------------------------------------------------------------------

  describe('query()', () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test('find operation returns rows', async () => {
      const result = await provider.query(
        JSON.stringify({ collection: 'users', operation: 'find', filter: {} })
      );
      expect(result.rows).toBeArray();
      expect(result.rows.length).toBe(2);
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
      // ObjectId should be serialized to string
      expect(typeof result.rows[0]._id).toBe('string');
    });

    test('findOne returns a single document', async () => {
      const result = await provider.query(
        JSON.stringify({ collection: 'users', operation: 'findOne', filter: { name: 'Alice' } })
      );
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].name).toBe('Alice');
    });

    test('aggregate works', async () => {
      const result = await provider.query(
        JSON.stringify({
          collection: 'users',
          operation: 'aggregate',
          pipeline: [{ $group: { _id: null, count: { $sum: 1 } } }],
        })
      );
      expect(result.rows).toBeArray();
    });

    test('count returns document count', async () => {
      const result = await provider.query(
        JSON.stringify({ collection: 'users', operation: 'count', filter: {} })
      );
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].count).toBe(2);
    });

    test('insertOne returns insertedId', async () => {
      const result = await provider.query(
        JSON.stringify({
          collection: 'users',
          operation: 'insertOne',
          documents: [{ name: 'Charlie' }],
        })
      );
      expect(result.rows[0].insertedId).toBe('new-id-123');
      expect(result.rows[0].acknowledged).toBe(true);
      expect(result.rowCount).toBe(1);
    });

    test('unsupported operation throws QueryError', async () => {
      await expect(
        provider.query(
          JSON.stringify({ collection: 'users', operation: 'drop' })
        )
      ).rejects.toThrow();
    });

    test('invalid JSON throws QueryError', async () => {
      await expect(provider.query('not valid json')).rejects.toThrow();
    });

    test('missing collection throws QueryError', async () => {
      await expect(
        provider.query(JSON.stringify({ operation: 'find' }))
      ).rejects.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // getSchema()
  // --------------------------------------------------------------------------

  describe('getSchema()', () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test('returns collections with inferred columns from sampled docs', async () => {
      const schemas = await provider.getSchema();
      expect(schemas).toBeArray();
      expect(schemas.length).toBe(2); // users + orders

      const usersSchema = schemas.find((s) => s.name === 'users');
      expect(usersSchema).toBeDefined();
      expect(usersSchema!.rowCount).toBe(42);
      expect(usersSchema!.columns.length).toBeGreaterThan(0);

      // _id field should be first and marked primary
      const idCol = usersSchema!.columns[0];
      expect(idCol.name).toBe('_id');
      expect(idCol.isPrimary).toBe(true);

      // indexes should be present
      expect(usersSchema!.indexes!.length).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // getHealth()
  // --------------------------------------------------------------------------

  describe('getHealth()', () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test('returns health info with connections and database size', async () => {
      const health = await provider.getHealth();
      expect(health.activeConnections).toBe(5);
      expect(typeof health.databaseSize).toBe('string');
      expect(typeof health.cacheHitRatio).toBe('string');
    });
  });

  // --------------------------------------------------------------------------
  // runMaintenance()
  // --------------------------------------------------------------------------

  describe('runMaintenance()', () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test('analyze validates collections', async () => {
      const result = await provider.runMaintenance('analyze', 'users');
      expect(result.success).toBe(true);
      expect(result.message).toContain('Validated');
    });

    test('vacuum compacts collections', async () => {
      const result = await provider.runMaintenance('vacuum', 'users');
      expect(result.success).toBe(true);
      expect(result.message).toContain('Compacted');
    });

    test('unsupported maintenance type throws', async () => {
      await expect(
        provider.runMaintenance('flush' as never)
      ).rejects.toThrow();
    });
  });
});
