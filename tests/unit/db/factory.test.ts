import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { DatabaseConnection } from '@/lib/db/types';

// ============================================================================
// Helper: build a minimal DatabaseConnection for a given type
// ============================================================================

function makeConnection(
  type: string,
  overrides: Partial<DatabaseConnection> = {},
): DatabaseConnection {
  return {
    id: `test-${type}`,
    name: `Test ${type}`,
    type,
    host: 'localhost',
    port: 5432,
    database: 'testdb',
    user: 'test',
    password: 'test',
    createdAt: new Date(),
    ...overrides,
  } as DatabaseConnection;
}

// ============================================================================
// Mock native driver packages so providers can construct without real DBs.
// We do NOT mock provider module paths — that would poison other test files.
// ============================================================================

const mockPgPool = {
  query: async () => ({ rows: [], fields: [] }),
  connect: async () => ({ query: async () => ({ rows: [], fields: [] }), release: () => {} }),
  end: async () => {},
  on: () => {},
};

mock.module('pg', () => ({
  default: { Pool: class { constructor() { return mockPgPool; } } },
  Pool: class { constructor() { return mockPgPool; } },
}));

const mockMysqlPool = {
  getConnection: async () => ({
    threadId: 42,
    execute: async () => [[], []],
    release: () => {},
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
  }),
  end: async () => {},
  execute: async () => [[], []],
};

mock.module('mysql2/promise', () => ({
  default: { createPool: () => mockMysqlPool },
  createPool: () => mockMysqlPool,
}));

mock.module('oracledb', () => ({
  default: {
    THIN: 0,
    initOracleClient: () => {},
    createPool: async () => ({
      getConnection: async () => ({
        execute: async () => ({ rows: [], metaData: [] }),
        close: async () => {},
        commit: async () => {},
        rollback: async () => {},
      }),
      close: async () => {},
      connectionsOpen: 0,
      connectionsInUse: 0,
    }),
    OUT_FORMAT_OBJECT: 4002,
    BIND_OUT: 3003,
    STRING: 2001,
    NUMBER: 2010,
    DATE: 2014,
  },
}));

mock.module('mssql', () => {
  const mockRequest = {
    query: async () => ({ recordset: [], recordsets: [[]], columns: {} }),
    cancel: () => {},
  };
  const mockTransaction = {
    begin: async () => {},
    commit: async () => {},
    rollback: async () => {},
    request: () => mockRequest,
  };
  const MockConnectionPool = class {
    connected = true;
    async connect() { return this; }
    async close() {}
    request() { return mockRequest; }
    transaction() { return mockTransaction; }
  };
  return {
    default: { ConnectionPool: MockConnectionPool },
    ConnectionPool: MockConnectionPool,
  };
});

mock.module('mongodb', () => {
  const mockCollection = {
    find: () => ({ limit: () => ({ toArray: async () => [] }), toArray: async () => [] }),
    findOne: async () => ({}),
    aggregate: () => ({ toArray: async () => [] }),
    countDocuments: async () => 0,
    insertOne: async () => ({ insertedId: 'test-id' }),
    insertMany: async () => ({ insertedCount: 0 }),
    updateOne: async () => ({ modifiedCount: 0 }),
    updateMany: async () => ({ modifiedCount: 0 }),
    deleteOne: async () => ({ deletedCount: 0 }),
    deleteMany: async () => ({ deletedCount: 0 }),
    distinct: async () => [],
  };
  const mockDb = {
    collection: () => mockCollection,
    listCollections: () => ({ toArray: async () => [] }),
    command: async () => ({}),
    admin: () => ({
      serverStatus: async () => ({
        connections: { current: 1 },
        storageEngine: { name: 'wiredTiger' },
        version: '6.0.0',
      }),
      listDatabases: async () => ({ databases: [] }),
    }),
  };
  return {
    MongoClient: class {
      async connect() { return this; }
      async close() {}
      db() { return mockDb; }
    },
    ObjectId: class { toString() { return 'test-id'; } },
    Binary: class { toString() { return ''; } },
    Decimal128: class { toString() { return '0'; } },
  };
});

mock.module('ioredis', () => ({
  default: class {
    status = 'ready';
    async connect() {}
    async quit() {}
    async ping() { return 'PONG'; }
    async info() { return 'redis_version:7.0.0\r\nconnected_clients:1\r\nused_memory_human:1M\r\n'; }
    async dbsize() { return 0; }
    async scan() { return ['0', []]; }
    async get() { return null; }
    async set() { return 'OK'; }
    async del() { return 1; }
    on() { return this; }
  },
}));

const mockCreateSSHTunnel = mock(async () => ({
  localHost: '127.0.0.1',
  localPort: 54321,
  close: mock(async () => {}),
}));

const mockCloseSSHTunnel = mock(async () => {});

mock.module('@/lib/ssh/tunnel', () => ({
  createSSHTunnel: mockCreateSSHTunnel,
  closeSSHTunnel: mockCloseSSHTunnel,
  hasTunnel: mock(() => false),
  getTunnelInfo: mock(() => undefined),
}));

// ============================================================================
// Import factory AFTER mocking native drivers
// ============================================================================

const {
  createDatabaseProvider,
  getOrCreateProvider,
  removeProvider,
  clearProviderCache,
  getProviderCacheStats,
} = await import('@/lib/db/factory');

// ============================================================================
// Tests
// ============================================================================

beforeEach(async () => {
  await clearProviderCache();
  mockCreateSSHTunnel.mockClear();
  mockCloseSSHTunnel.mockClear();
});

// ─── createDatabaseProvider ────────────────────────────────────────────────

describe('createDatabaseProvider', () => {
  test('creates DemoProvider for type "demo"', async () => {
    const conn = makeConnection('demo');
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe('demo');
  });

  test('throws DatabaseConfigError for unknown type', async () => {
    const conn = makeConnection('unknown');
    await expect(createDatabaseProvider(conn)).rejects.toThrow(
      /Unknown database type: unknown/,
    );
  });

  test('creates provider for type "postgres"', async () => {
    const conn = makeConnection('postgres');
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe('postgres');
  });

  test('creates provider for type "mysql"', async () => {
    const conn = makeConnection('mysql');
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe('mysql');
  });

  test('creates provider for type "sqlite"', async () => {
    const conn = makeConnection('sqlite', { database: ':memory:' });
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe('sqlite');
  });

  test('creates provider for type "mongodb"', async () => {
    const conn = makeConnection('mongodb', { connectionString: 'mongodb://localhost/test' });
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe('mongodb');
  });

  test('creates provider for type "redis"', async () => {
    const conn = makeConnection('redis');
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe('redis');
  });

  test('creates provider for type "oracle"', async () => {
    const conn = makeConnection('oracle', { serviceName: 'ORCL' } as Partial<DatabaseConnection>);
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe('oracle');
  });

  test('creates provider for type "mssql"', async () => {
    const conn = makeConnection('mssql');
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe('mssql');
  });
});

// ─── getOrCreateProvider — uses 'demo' to avoid native driver issues ─────

describe('getOrCreateProvider', () => {
  test('creates and caches a provider', async () => {
    const conn = makeConnection('demo');
    const provider = await getOrCreateProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.isConnected()).toBe(true);

    const stats = getProviderCacheStats();
    expect(stats.size).toBe(1);
    expect(stats.connections).toContain('test-demo');
  });

  test('returns cached provider on second call', async () => {
    const conn = makeConnection('demo');
    const first = await getOrCreateProvider(conn);
    const second = await getOrCreateProvider(conn);
    expect(first).toBe(second);
  });

  test('creates new provider if cached one is disconnected', async () => {
    const conn = makeConnection('demo');
    const first = await getOrCreateProvider(conn);
    await first.disconnect();
    expect(first.isConnected()).toBe(false);

    const second = await getOrCreateProvider(conn);
    expect(second).not.toBe(first);
    expect(second.isConnected()).toBe(true);
  });

  test('creates SSH tunnel when sshTunnel is configured', async () => {
    const conn = makeConnection('demo', {
      id: 'ssh-conn',
      host: 'remote-db.example.com',
      port: 5432,
      sshTunnel: {
        enabled: true,
        host: 'bastion.example.com',
        port: 22,
        username: 'admin',
        authMethod: 'password',
        password: 'secret',
      },
    } as Partial<DatabaseConnection>);

    await getOrCreateProvider(conn);
    expect(mockCreateSSHTunnel).toHaveBeenCalledTimes(1);
  });
});

// ─── removeProvider ────────────────────────────────────────────────────────

describe('removeProvider', () => {
  test('removes provider from cache and calls disconnect', async () => {
    const conn = makeConnection('demo');
    const provider = await getOrCreateProvider(conn);
    expect(provider.isConnected()).toBe(true);

    await removeProvider(conn.id);

    const stats = getProviderCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.connections).not.toContain('test-demo');
  });

  test('calls closeSSHTunnel', async () => {
    const conn = makeConnection('demo');
    await getOrCreateProvider(conn);
    await removeProvider(conn.id);
    expect(mockCloseSSHTunnel).toHaveBeenCalledWith(conn.id);
  });
});

// ─── clearProviderCache ────────────────────────────────────────────────────

describe('clearProviderCache', () => {
  test('clears all cached providers and disconnects each', async () => {
    const d1 = makeConnection('demo', { id: 'demo-a' });
    const d2 = makeConnection('demo', { id: 'demo-b' });

    const prov1 = await getOrCreateProvider(d1);
    const prov2 = await getOrCreateProvider(d2);

    expect(getProviderCacheStats().size).toBe(2);

    await clearProviderCache();

    expect(getProviderCacheStats().size).toBe(0);
    expect(prov1.isConnected()).toBe(false);
    expect(prov2.isConnected()).toBe(false);
  });
});

// ─── getProviderCacheStats ─────────────────────────────────────────────────

describe('getProviderCacheStats', () => {
  test('returns correct size and connection IDs', async () => {
    expect(getProviderCacheStats()).toEqual({ size: 0, connections: [] });

    await getOrCreateProvider(makeConnection('demo', { id: 'demo-x' }));
    await getOrCreateProvider(makeConnection('demo', { id: 'demo-y' }));
    await getOrCreateProvider(makeConnection('demo', { id: 'demo-z' }));

    const stats = getProviderCacheStats();
    expect(stats.size).toBe(3);
    expect(stats.connections).toContain('demo-x');
    expect(stats.connections).toContain('demo-y');
    expect(stats.connections).toContain('demo-z');
  });
});
