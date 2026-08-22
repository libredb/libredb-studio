import { describe, test, expect, mock, beforeEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseConnection, ReadOnlyStatementBudget } from "@/lib/db/types";
import { ExecutionProfileError } from "@/lib/db/errors";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";

/** Enforcement caps for the sqlite agent-profile assertions below. */
const AGENT_BUDGET: ReadOnlyStatementBudget = {
  statementTimeoutMs: 5_000,
  maxResultRows: 100,
  maxResultBytes: 64 * 1024,
};

// ============================================================================
// Helper: build a minimal DatabaseConnection for a given type
// ============================================================================

function makeConnection(type: string, overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: `test-${type}`,
    name: `Test ${type}`,
    type,
    host: "localhost",
    port: 5432,
    database: "testdb",
    user: "test",
    password: "test",
    createdAt: new Date(),
    ...overrides,
  } as DatabaseConnection;
}

// ============================================================================
// Mock native driver packages so providers can construct without real DBs.
// We do NOT mock provider module paths — that would poison other test files.
// ============================================================================

/**
 * The privileges the mocked PostgreSQL role reports to the agent profile's
 * open-time check. All false = a least-privilege role, which is what the profile
 * requires: a read-only transaction does not stop server-side file access or
 * program execution, so the role is part of that boundary (#328).
 */
let mockPgRolePrivileges: Record<string, boolean> = {
  is_superuser: false,
  reads_server_files: false,
  writes_server_files: false,
  executes_programs: false,
};

const mockPgQuery = async (sql?: string) =>
  typeof sql === "string" && /is_superuser/i.test(sql)
    ? { rows: [{ ...mockPgRolePrivileges }], fields: [] }
    : { rows: [], fields: [] };

const mockPgPool = {
  query: mockPgQuery,
  connect: async () => ({ query: mockPgQuery, release: () => {} }),
  end: async () => {},
  on: () => {},
};

mock.module("pg", () => ({
  default: {
    Pool: class {
      constructor() {
        return mockPgPool;
      }
    },
  },
  Pool: class {
    constructor() {
      return mockPgPool;
    }
  },
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

mock.module("mysql2/promise", () => ({
  default: { createPool: () => mockMysqlPool },
  createPool: () => mockMysqlPool,
}));

mock.module("oracledb", () => ({
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

mock.module("mssql", () => {
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
    async connect() {
      return this;
    }
    async close() {}
    request() {
      return mockRequest;
    }
    transaction() {
      return mockTransaction;
    }
  };
  return {
    default: { ConnectionPool: MockConnectionPool },
    ConnectionPool: MockConnectionPool,
  };
});

mock.module("mongodb", () => {
  const mockCollection = {
    find: () => ({ limit: () => ({ toArray: async () => [] }), toArray: async () => [] }),
    findOne: async () => ({}),
    aggregate: () => ({ toArray: async () => [] }),
    countDocuments: async () => 0,
    insertOne: async () => ({ insertedId: "test-id" }),
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
        storageEngine: { name: "wiredTiger" },
        version: "6.0.0",
      }),
      listDatabases: async () => ({ databases: [] }),
    }),
  };
  return {
    MongoClient: class {
      async connect() {
        return this;
      }
      async close() {}
      db() {
        return mockDb;
      }
    },
    ObjectId: class {
      toString() {
        return "test-id";
      }
    },
    Binary: class {
      toString() {
        return "";
      }
    },
    Decimal128: class {
      toString() {
        return "0";
      }
    },
  };
});

mock.module("ioredis", () => ({
  default: class {
    status = "ready";
    async connect() {}
    async quit() {}
    async ping() {
      return "PONG";
    }
    async info() {
      return "redis_version:7.0.0\r\nconnected_clients:1\r\nused_memory_human:1M\r\n";
    }
    async dbsize() {
      return 0;
    }
    async scan() {
      return ["0", []];
    }
    async get() {
      return null;
    }
    async set() {
      return "OK";
    }
    async del() {
      return 1;
    }
    on() {
      return this;
    }
  },
}));

const mockCreateSSHTunnel = mock(async () => ({
  localHost: "127.0.0.1",
  localPort: 54321,
  close: mock(async () => {}),
}));

const mockCloseSSHTunnel = mock(async () => {});

const mockHasTunnel = mock(() => false);

mock.module("@/lib/ssh/tunnel", () => ({
  createSSHTunnel: mockCreateSSHTunnel,
  closeSSHTunnel: mockCloseSSHTunnel,
  hasTunnel: mockHasTunnel,
  getTunnelInfo: mock(() => undefined),
}));

// ============================================================================
// Import factory AFTER mocking native drivers.
// NODE_ENV is temporarily overridden so the module-level auto-registration
// (registerShutdownHandlers) executes on import; the SIGTERM/SIGINT handlers
// it registers are captured by diffing the process listeners.
// ============================================================================

const sigtermListenersBefore = process.listeners("SIGTERM");
const sigintListenersBefore = process.listeners("SIGINT");

const nodeEnvBefore = process.env.NODE_ENV;
(process.env as Record<string, string>).NODE_ENV = "production";
const {
  createDatabaseProvider,
  getOrCreateProvider,
  removeProvider,
  clearProviderCache,
  getProviderCacheStats,
  evictIdleProviders,
  registerShutdownHandlers,
  acquireExecutionProfileProvider,
  getExecutionProfileCacheStats,
  withOneShotTunnel,
} = await import("@/lib/db/factory");
if (nodeEnvBefore === undefined) {
  delete (process.env as Record<string, string>).NODE_ENV;
} else {
  (process.env as Record<string, string>).NODE_ENV = nodeEnvBefore;
}

const sigtermHandler = process.listeners("SIGTERM").find((l) => !sigtermListenersBefore.includes(l));
const sigintHandler = process.listeners("SIGINT").find((l) => !sigintListenersBefore.includes(l));

// Detach the captured handlers immediately: the tests below invoke the
// function references directly, and leaving them attached would leak
// factory shutdown behavior into other tests sharing this process.
if (sigtermHandler) process.removeListener("SIGTERM", sigtermHandler);
if (sigintHandler) process.removeListener("SIGINT", sigintHandler);

// ============================================================================
// Tests
// ============================================================================

beforeEach(async () => {
  await clearProviderCache();
  mockCreateSSHTunnel.mockClear();
  mockCloseSSHTunnel.mockClear();
});

// ─── createDatabaseProvider ────────────────────────────────────────────────

describe("createDatabaseProvider", () => {
  test("throws DatabaseConfigError for unknown type", async () => {
    const conn = makeConnection("unknown");
    await expect(createDatabaseProvider(conn)).rejects.toThrow(/Unknown database type: unknown/);
  });

  test("the unknown-type error lists every supported type", async () => {
    // The list inside that message is a hand-written string literal, not something
    // TypeScript checks, so a new provider is only named there because a test pins it.
    // Every SHIPPED type is pinned here rather than a sample of them: the surface that
    // silently drifts is exactly the one nobody notices.
    const conn = makeConnection("unknown");
    for (const type of SHIPPED_DATABASE_TYPES) {
      await expect(createDatabaseProvider(conn)).rejects.toThrow(new RegExp(type));
    }
  });

  test('creates provider for type "postgres"', async () => {
    const conn = makeConnection("postgres");
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("postgres");
  });

  test('creates provider for type "mysql"', async () => {
    const conn = makeConnection("mysql");
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("mysql");
  });

  test('creates provider for type "sqlite"', async () => {
    const conn = makeConnection("sqlite", { database: ":memory:" });
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("sqlite");
  });

  test('creates provider for type "mongodb"', async () => {
    const conn = makeConnection("mongodb", { connectionString: "mongodb://localhost/test" });
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("mongodb");
  });

  test('creates provider for type "redis"', async () => {
    const conn = makeConnection("redis");
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("redis");
  });

  test('creates provider for type "oracle"', async () => {
    const conn = makeConnection("oracle", { serviceName: "ORCL" } as Partial<DatabaseConnection>);
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("oracle");
  });

  test('creates provider for type "mssql"', async () => {
    const conn = makeConnection("mssql");
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("mssql");
  });

  test('creates provider for type "couchbase"', async () => {
    // The bucket is the `database` field; the provider refuses a connection without one.
    const conn = makeConnection("couchbase", { port: 8091, database: "travel" });
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("couchbase");
  });

  test('creates provider for type "elasticsearch"', async () => {
    // Two type-ids resolve to ONE module (`providers/sql/search/index`), which is the
    // first time that happens here - so both cases are asserted, and each is asserted
    // to produce its OWN class. A copy-paste that returned the same provider for both
    // would otherwise pass every other test in the suite.
    const conn = makeConnection("elasticsearch", { port: 9200 });
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("elasticsearch");
  });

  test('creates provider for type "opensearch"', async () => {
    const conn = makeConnection("opensearch", { port: 9200 });
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("opensearch");
  });

  test('creates provider for type "clickhouse"', async () => {
    const conn = makeConnection("clickhouse", { port: 8123, database: "demo" });
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("clickhouse");
  });

  test('creates provider for type "druid"', async () => {
    // No `database` field: Druid reports exactly one catalog, always named
    // `druid`, so the provider ignores the connection's database entirely.
    const conn = makeConnection("druid", { port: 8888 });
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("druid");
  });

  test('creates provider for type "trino"', async () => {
    // `database` carries the CATALOG, the way a PostgreSQL connection carries a
    // database: a coordinator fronts many of them and a connection pins one.
    const conn = makeConnection("trino", { port: 8080, database: "tpch" });
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("trino");
  });

  test('creates provider for type "cassandra"', async () => {
    // `database` carries the KEYSPACE and `localDataCenter` is required by the
    // driver, so a connection missing it cannot be constructed at all.
    const conn = makeConnection("cassandra", { port: 9042, database: "probe", localDataCenter: "datacenter1" });
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("cassandra");
  });

  test('creates provider for type "libredb"', async () => {
    const conn = makeConnection("libredb", { database: "/tmp/test.libredb" });
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("libredb");
  });
});

// ─── getOrCreateProvider — uses 'sqlite' for lightweight testing ─────

describe("getOrCreateProvider", () => {
  test("creates and caches a provider", async () => {
    const conn = makeConnection("sqlite");
    const provider = await getOrCreateProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.isConnected()).toBe(true);

    const stats = getProviderCacheStats();
    expect(stats.size).toBe(1);
    expect(stats.connections).toContain("test-sqlite");
  });

  test("returns cached provider on second call", async () => {
    const conn = makeConnection("sqlite");
    const first = await getOrCreateProvider(conn);
    const second = await getOrCreateProvider(conn);
    expect(first).toBe(second);
  });

  test("creates new provider if cached one is disconnected", async () => {
    const conn = makeConnection("sqlite");
    const first = await getOrCreateProvider(conn);
    await first.disconnect();
    expect(first.isConnected()).toBe(false);

    const second = await getOrCreateProvider(conn);
    expect(second).not.toBe(first);
    expect(second.isConnected()).toBe(true);
  });

  test("creates SSH tunnel when sshTunnel is configured", async () => {
    const conn = makeConnection("sqlite", {
      id: "ssh-conn",
      host: "remote-db.example.com",
      port: 5432,
      sshTunnel: {
        enabled: true,
        host: "bastion.example.com",
        port: 22,
        username: "admin",
        authMethod: "password",
        password: "secret",
      },
    } as Partial<DatabaseConnection>);

    await getOrCreateProvider(conn);
    expect(mockCreateSSHTunnel).toHaveBeenCalledTimes(1);
  });

  test("closes SSH tunnel when provider connect fails", async () => {
    // NUL byte in the path makes SQLiteProvider.connect() throw after the tunnel is created
    const conn = makeConnection("sqlite", {
      id: "ssh-connect-fail",
      database: "bad\u0000path.db",
      sshTunnel: {
        enabled: true,
        host: "bastion.example.com",
        port: 22,
        username: "admin",
        authMethod: "password",
        password: "secret",
      },
    } as Partial<DatabaseConnection>);

    await expect(getOrCreateProvider(conn)).rejects.toThrow(/NUL bytes/);

    expect(mockCreateSSHTunnel).toHaveBeenCalledTimes(1);
    const tunnel = (await mockCreateSSHTunnel.mock.results[0]?.value) as { close: ReturnType<typeof mock> } | undefined;
    expect(tunnel?.close).toHaveBeenCalledTimes(1);
    expect(getProviderCacheStats().size).toBe(0);
  });

  test("does not close a pre-existing tunnel when provider connect fails", async () => {
    // createSSHTunnel returns the existing tunnel for the connection id, so a
    // failed connect must not tear down a tunnel another provider (e.g. an
    // execution-profile one) is still using.
    const conn = makeConnection("sqlite", {
      id: "ssh-connect-fail-shared",
      database: "bad\u0000path.db",
      sshTunnel: {
        enabled: true,
        host: "bastion.example.com",
        port: 22,
        username: "admin",
        authMethod: "password",
        password: "secret",
      },
    } as Partial<DatabaseConnection>);
    mockHasTunnel.mockReturnValueOnce(true);

    await expect(getOrCreateProvider(conn)).rejects.toThrow(/NUL bytes/);

    const tunnel = (await mockCreateSSHTunnel.mock.results[0]?.value) as { close: ReturnType<typeof mock> } | undefined;
    expect(tunnel?.close).not.toHaveBeenCalled();
    expect(getProviderCacheStats().size).toBe(0);
  });
});

// ─── removeProvider ────────────────────────────────────────────────────────

describe("removeProvider", () => {
  test("removes provider from cache and calls disconnect", async () => {
    const conn = makeConnection("sqlite");
    const provider = await getOrCreateProvider(conn);
    expect(provider.isConnected()).toBe(true);

    await removeProvider(conn.id);

    const stats = getProviderCacheStats();
    expect(stats.size).toBe(0);
    expect(stats.connections).not.toContain("test-sqlite");
  });

  test("calls closeSSHTunnel", async () => {
    const conn = makeConnection("sqlite");
    await getOrCreateProvider(conn);
    await removeProvider(conn.id);
    expect(mockCloseSSHTunnel).toHaveBeenCalledWith(conn.id);
  });

  test("logs and continues when disconnect fails during removal", async () => {
    const conn = makeConnection("sqlite", { id: "remove-disconnect-err", database: ":memory:" });
    const provider = await getOrCreateProvider(conn);
    provider.disconnect = async () => {
      throw new Error("disconnect failed");
    };

    // Should not throw — the error is caught and logged
    await removeProvider("remove-disconnect-err");
    expect(getProviderCacheStats().size).toBe(0);
  });

  test("logs and continues when SSH tunnel close fails", async () => {
    mockCloseSSHTunnel.mockImplementationOnce(async () => {
      throw new Error("tunnel close failed");
    });

    // Should not throw — the error is caught and logged
    await removeProvider("no-such-connection");
    expect(mockCloseSSHTunnel).toHaveBeenCalledWith("no-such-connection");
  });
});

// ─── clearProviderCache ────────────────────────────────────────────────────

describe("clearProviderCache", () => {
  test("clears all cached providers and disconnects each", async () => {
    const d1 = makeConnection("sqlite", { id: "sqlite-a" });
    const d2 = makeConnection("sqlite", { id: "sqlite-b" });

    const prov1 = await getOrCreateProvider(d1);
    const prov2 = await getOrCreateProvider(d2);

    expect(getProviderCacheStats().size).toBe(2);

    await clearProviderCache();

    expect(getProviderCacheStats().size).toBe(0);
    expect(prov1.isConnected()).toBe(false);
    expect(prov2.isConnected()).toBe(false);
  });

  test("logs and continues when a provider disconnect rejects during clear", async () => {
    const conn = makeConnection("sqlite", { id: "clear-disconnect-err", database: ":memory:" });
    const provider = await getOrCreateProvider(conn);
    provider.disconnect = async () => {
      throw new Error("disconnect failed");
    };

    // Should not throw — rejections are caught per provider
    await clearProviderCache();
    expect(getProviderCacheStats().size).toBe(0);
  });
});

// ─── getProviderCacheStats ─────────────────────────────────────────────────

describe("getProviderCacheStats", () => {
  test("returns correct size and connection IDs", async () => {
    expect(getProviderCacheStats()).toEqual({ size: 0, connections: [] });

    await getOrCreateProvider(makeConnection("sqlite", { id: "sqlite-x" }));
    await getOrCreateProvider(makeConnection("sqlite", { id: "sqlite-y" }));
    await getOrCreateProvider(makeConnection("sqlite", { id: "sqlite-z" }));

    const stats = getProviderCacheStats();
    expect(stats.size).toBe(3);
    expect(stats.connections).toContain("sqlite-x");
    expect(stats.connections).toContain("sqlite-y");
    expect(stats.connections).toContain("sqlite-z");
  });
});

// ─── evictIdleProviders ──────────────────────────────────────────────────

describe("evictIdleProviders", () => {
  test("evicts providers idle longer than maxIdleMs", async () => {
    await getOrCreateProvider(makeConnection("sqlite", { id: "idle-a" }));
    await getOrCreateProvider(makeConnection("sqlite", { id: "idle-b" }));

    expect(getProviderCacheStats().size).toBe(2);

    // Use maxIdleMs=0 so all providers are considered idle immediately
    const evicted = await evictIdleProviders(0);
    expect(evicted).toBe(2);
    expect(getProviderCacheStats().size).toBe(0);
  });

  test("does not evict recently used providers", async () => {
    await getOrCreateProvider(makeConnection("sqlite", { id: "fresh-a" }));

    // Use a very large maxIdleMs — nothing should be evicted
    const evicted = await evictIdleProviders(999_999_999);
    expect(evicted).toBe(0);
    expect(getProviderCacheStats().size).toBe(1);
  });

  test("returns 0 when cache is empty", async () => {
    const evicted = await evictIdleProviders(0);
    expect(evicted).toBe(0);
  });

  test("closes SSH tunnel for evicted providers", async () => {
    await getOrCreateProvider(makeConnection("sqlite", { id: "tunnel-evict" }));
    await evictIdleProviders(0);
    expect(mockCloseSSHTunnel).toHaveBeenCalledWith("tunnel-evict");
  });

  test("handles disconnect errors gracefully during eviction", async () => {
    const conn = makeConnection("sqlite", { id: "err-evict" });
    const provider = await getOrCreateProvider(conn);
    // Make disconnect throw
    const origDisconnect = provider.disconnect.bind(provider);
    provider.disconnect = async () => {
      await origDisconnect();
      throw new Error("disconnect failed");
    };

    // Should not throw — errors are caught internally
    const evicted = await evictIdleProviders(0);
    expect(evicted).toBe(1);
    expect(getProviderCacheStats().size).toBe(0);
  });
});

// ─── idle sweep timer ─────────────────────────────────────────────────────

describe("idle sweep timer", () => {
  test("sweep interval callback invokes evictIdleProviders", async () => {
    const originalSetInterval = globalThis.setInterval;
    let sweepCallback: (() => void) | undefined;
    globalThis.setInterval = ((handler: () => void) => {
      sweepCallback = handler;
      // Return a real (far-future) timer so unref/clearInterval behave normally
      return originalSetInterval(() => {}, 2_147_000_000);
    }) as typeof globalThis.setInterval;

    try {
      // Cache is empty (beforeEach), so this starts a fresh sweep timer
      await getOrCreateProvider(makeConnection("sqlite", { id: "sweep-cb", database: ":memory:" }));
      expect(sweepCallback).toBeDefined();

      // Fire the captured sweep callback; the default idle timeout evicts nothing
      sweepCallback?.();
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(getProviderCacheStats().size).toBe(1);
    } finally {
      globalThis.setInterval = originalSetInterval;
      await clearProviderCache();
    }
  });
});

// ─── registerShutdownHandlers ─────────────────────────────────────────────

describe("registerShutdownHandlers", () => {
  test("can be called multiple times without error (idempotent)", () => {
    // Should not throw even when called repeatedly
    registerShutdownHandlers();
    registerShutdownHandlers();
    registerShutdownHandlers();
  });
});

// ─── shutdown signal handlers ─────────────────────────────────────────────
// The handlers were auto-registered at import time (NODE_ENV override above)
// and captured by diffing the process listeners.

/** Stub process.exit with a spy whose promise resolves on the first call. */
function stubProcessExit(): { exitCalls: Array<number | undefined>; exited: Promise<void>; restore: () => void } {
  const originalExit = process.exit;
  const exitCalls: Array<number | undefined> = [];
  let resolveExited: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  process.exit = ((code?: number) => {
    exitCalls.push(code);
    resolveExited();
  }) as unknown as typeof process.exit;
  return {
    exitCalls,
    exited,
    restore: () => {
      process.exit = originalExit;
    },
  };
}

describe("shutdown signal handlers", () => {
  test("auto-registration on import captured SIGTERM and SIGINT handlers", () => {
    expect(sigtermHandler).toBeDefined();
    expect(sigintHandler).toBeDefined();
  });

  test("SIGTERM handler clears the provider cache and exits with code 0", async () => {
    await getOrCreateProvider(makeConnection("sqlite", { id: "shutdown-term", database: ":memory:" }));

    const { exitCalls, exited, restore } = stubProcessExit();
    try {
      sigtermHandler?.("SIGTERM");
      await exited;
      expect(exitCalls).toEqual([0]);
      expect(getProviderCacheStats().size).toBe(0);
    } finally {
      restore();
    }
  });

  test("SIGINT handler logs the error and still exits when cache clear fails", async () => {
    const conn = makeConnection("sqlite", { id: "shutdown-int", database: ":memory:" });
    const provider = await getOrCreateProvider(conn);
    const realDisconnect = provider.disconnect.bind(provider);
    // Return a non-promise so clearProviderCache rejects inside the handler
    (provider as unknown as { disconnect: () => undefined }).disconnect = () => undefined;

    const { exitCalls, exited, restore } = stubProcessExit();
    try {
      sigintHandler?.("SIGINT");
      await exited;
      expect(exitCalls).toEqual([0]);
    } finally {
      restore();
      provider.disconnect = realDisconnect;
      await clearProviderCache();
    }
  });
});

// ─── acquireExecutionProfileProvider — agent read-only profile (#328) ──────

describe("acquireExecutionProfileProvider", () => {
  const pgConn = (overrides: Partial<DatabaseConnection> = {}) =>
    makeConnection("postgres", { id: "pg-profile", ...overrides });

  /**
   * Deterministic clock for the two cross-cache eviction assertions below.
   *
   * Those tests need one cache entry to be older than `evictIdleProviders`'
   * threshold while the other is younger. Sleeping for the gap makes that a race
   * with CI scheduling jitter from BOTH sides: any delay between the second
   * acquisition and the evict call ages the younger entry past the threshold too,
   * and then both entries evict for a reason unrelated to the invariant under
   * test. Both cache entries are stamped from `Date.now()` (the `set` calls in
   * `getOrCreateProvider` and `acquireExecutionProfileProvider`) and compared
   * against it in `evictIdleProviders`, so freezing it makes the age gap exact
   * instead of probable — and keeps a security-relevant suite free of a flake
   * class that would train maintainers to re-run it.
   *
   * This does NOT control the idle sweep: `startIdleSweep` runs on a real
   * `setInterval` and is unaffected. Deliberately a local patch rather than
   * bun:test's `setSystemTime`, which also moves `new Date()` — the narrower
   * blast radius matches this file's other stub-and-restore helpers.
   */
  function installFakeClock(): { advance: (ms: number) => void; restore: () => void } {
    const realNow = Date.now;
    let current = realNow();
    Date.now = () => current;
    return {
      advance: (ms: number) => {
        current += ms;
      },
      restore: () => {
        Date.now = realNow;
      },
    };
  }

  test("acquires a dedicated provider without touching the shared writable cache", async () => {
    const shared = await getOrCreateProvider(pgConn());
    const statsBefore = getProviderCacheStats();

    const agent = await acquireExecutionProfileProvider(pgConn(), "agent-read-only");

    expect(agent).not.toBe(shared);
    expect(getProviderCacheStats()).toEqual(statsBefore);
    expect(getExecutionProfileCacheStats().size).toBe(1);
  });

  test("caches per (connection id, profile) and reuses the dedicated instance", async () => {
    const first = await acquireExecutionProfileProvider(pgConn(), "agent-read-only");
    const second = await acquireExecutionProfileProvider(pgConn(), "agent-read-only");

    expect(second).toBe(first);
    expect(getExecutionProfileCacheStats()).toEqual({ size: 1, connections: ["pg-profile"] });
    expect(getProviderCacheStats().size).toBe(0);
  });

  test("shared-cache acquisitions leave the profile cache untouched", async () => {
    await getOrCreateProvider(pgConn());
    expect(getExecutionProfileCacheStats().size).toBe(0);
  });

  test("re-acquires when the cached profile provider is disconnected", async () => {
    const first = await acquireExecutionProfileProvider(pgConn(), "agent-read-only");
    await first.disconnect();

    const second = await acquireExecutionProfileProvider(pgConn(), "agent-read-only");

    expect(second).not.toBe(first);
    expect(second.isConnected()).toBe(true);
  });

  test("refuses an unknown execution profile (fail closed)", async () => {
    const error: unknown = await acquireExecutionProfileProvider(pgConn(), "agent-read-write" as never).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as InstanceType<typeof ExecutionProfileError>).reasonCode).toBe("UNSUPPORTED_PROFILE");
    expect(getExecutionProfileCacheStats().size).toBe(0);
  });

  test("refuses a provider type without a database-native read-only wrapper", async () => {
    const error: unknown = await acquireExecutionProfileProvider(
      makeConnection("redis", { id: "redis-profile" }),
      "agent-read-only",
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as InstanceType<typeof ExecutionProfileError>).reasonCode).toBe("PROFILE_UNSUPPORTED_BY_PROVIDER");
    expect(getExecutionProfileCacheStats().size).toBe(0);
  });

  test("serves the SAME engine under the operations profile, which needs no read-only statement path", async () => {
    // Both directions of the workflow-aware engine gate, on one connection. The
    // restriction is a property of the PROFILE, not of the factory: `agent-read-only`
    // sends model-authored statements and is served only where the engine can bound
    // one, while `agent-operations` sends none and calls the curated reporting methods
    // every provider implements. Asserting them together is what keeps a later
    // simplification from collapsing the two.
    const connection = makeConnection("redis", { id: "redis-operations" });

    const refused: unknown = await acquireExecutionProfileProvider(connection, "agent-read-only").catch(
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ExecutionProfileError);

    const provider = await acquireExecutionProfileProvider(connection, "agent-operations");

    expect(provider.isConnected()).toBe(true);
    expect(typeof provider.queryReadOnly).not.toBe("function");
    // It is still a PROFILED acquisition: the operations path may not be handed the
    // editor's writable pool, which is the invariant the profiled cache carries.
    expect(getExecutionProfileCacheStats().size).toBe(1);
  });

  test("the hand-over profile takes the same engine gate, and caches apart from the run's own", async () => {
    // #373 review. `agent-handover` serves the editor replay of a statement a run
    // already answered with, so it SENDS a statement and must be refused wherever the
    // engine cannot bound one — the same rule as `agent-read-only`, from the same
    // table. Its own key in the profiled cache is the other half: two profiles are two
    // entries, so a later change to one path's lifecycle cannot reach the other, and
    // neither is ever the editor's writable pool.
    const refused: unknown = await acquireExecutionProfileProvider(
      makeConnection("redis", { id: "redis-handover" }),
      "agent-handover",
    ).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ExecutionProfileError);
    expect((refused as InstanceType<typeof ExecutionProfileError>).reasonCode).toBe("PROFILE_UNSUPPORTED_BY_PROVIDER");

    const agent = await acquireExecutionProfileProvider(pgConn(), "agent-read-only");
    const handover = await acquireExecutionProfileProvider(pgConn(), "agent-handover");

    expect(typeof handover.queryReadOnly).toBe("function");
    expect(handover).not.toBe(agent);
    expect(getExecutionProfileCacheStats().size).toBe(2);
  });

  test("refuses to vend a PostgreSQL profile whose role is too privileged, and caches nothing", async () => {
    // The provider verifies the role at open (a read-only transaction does not
    // stop COPY TO PROGRAM or pg_read_file), and the refusal has to reach the
    // caller intact — not as a generic connection failure — with no half-built
    // entry left in the profiled cache.
    mockPgRolePrivileges = { ...mockPgRolePrivileges, executes_programs: true };
    try {
      const error: unknown = await acquireExecutionProfileProvider(pgConn({ id: "pg-privileged" }), "agent-read-only")
        .then(() => null)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ExecutionProfileError);
      expect((error as InstanceType<typeof ExecutionProfileError>).reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(getExecutionProfileCacheStats().size).toBe(0);
    } finally {
      mockPgRolePrivileges = { ...mockPgRolePrivileges, executes_programs: false };
    }

    // The same connection is still usable on the editor path: the profile's
    // requirement must not gate ordinary queries.
    const shared = await getOrCreateProvider(pgConn({ id: "pg-privileged" }));
    expect(shared.isConnected()).toBe(true);
  });

  test("uses the least-privilege agent credential for the profile provider only", async () => {
    const conn = pgConn({ id: "pg-cred", agentUser: "agent_ro", agentPassword: "agent-secret" });

    const agent = await acquireExecutionProfileProvider(conn, "agent-read-only");
    const shared = await getOrCreateProvider(conn);

    expect(agent.config.user).toBe("agent_ro");
    expect(agent.config.password).toBe("agent-secret");
    expect(shared.config.user).toBe("test");
  });

  test("denies when the agent credential is configured but unresolvable (fail closed)", async () => {
    // "v9:a:b" carries an envelope version tag this build does not recognise —
    // readSecret classifies it undecryptable, never plaintext.
    const conn = pgConn({ id: "pg-bad-cred", agentUser: "agent_ro", agentPassword: "v9:a:b" });

    const error: unknown = await acquireExecutionProfileProvider(conn, "agent-read-only").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as InstanceType<typeof ExecutionProfileError>).reasonCode).toBe("AGENT_CREDENTIAL_UNRESOLVABLE");
    expect(getExecutionProfileCacheStats().size).toBe(0);
  });

  test("denies an agent user without a password (fail closed)", async () => {
    const conn = pgConn({ id: "pg-user-only", agentUser: "agent_ro" });

    const error: unknown = await acquireExecutionProfileProvider(conn, "agent-read-only").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as InstanceType<typeof ExecutionProfileError>).reasonCode).toBe("AGENT_CREDENTIAL_UNRESOLVABLE");
  });

  test("denies an agent password without a user (fail closed)", async () => {
    const conn = pgConn({ id: "pg-password-only", agentPassword: "agent-secret" });

    const error: unknown = await acquireExecutionProfileProvider(conn, "agent-read-only").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as InstanceType<typeof ExecutionProfileError>).reasonCode).toBe("AGENT_CREDENTIAL_UNRESOLVABLE");
  });

  test("denies an agent credential on a connection-string connection", async () => {
    // buildPoolConfig ignores user/password fields when a connection string is
    // present, so the credential would be silently dropped — running the agent
    // as the MORE privileged embedded user. Denying is the fail-closed choice.
    const conn = pgConn({
      id: "pg-cs-cred",
      connectionString: "postgresql://app:pw@db.internal:5432/prod",
      agentUser: "agent_ro",
      agentPassword: "agent-secret",
    });

    const error: unknown = await acquireExecutionProfileProvider(conn, "agent-read-only").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as InstanceType<typeof ExecutionProfileError>).reasonCode).toBe(
      "AGENT_CREDENTIAL_WITH_CONNECTION_STRING",
    );
    expect(getExecutionProfileCacheStats().size).toBe(0);
  });

  test("does not cache a profile provider whose connection failed", async () => {
    const originalConnect = mockPgPool.connect;
    mockPgPool.connect = async () => {
      throw new Error("connection refused");
    };
    try {
      await expect(acquireExecutionProfileProvider(pgConn(), "agent-read-only")).rejects.toThrow(
        /connection refused|Failed to connect/,
      );
      expect(getExecutionProfileCacheStats().size).toBe(0);
    } finally {
      mockPgPool.connect = originalConnect;
    }
  });

  test("creates the connection's SSH tunnel and connects the profile provider through it", async () => {
    const conn = pgConn({
      id: "pg-tunnel-profile",
      host: "remote-db.example.com",
      sshTunnel: {
        enabled: true,
        host: "bastion.example.com",
        port: 22,
        username: "admin",
        authMethod: "password",
        password: "secret",
      },
    });

    const agent = await acquireExecutionProfileProvider(conn, "agent-read-only");

    expect(mockCreateSSHTunnel).toHaveBeenCalledTimes(1);
    expect(agent.config.host).toBe("127.0.0.1");
    expect(agent.config.port).toBe(54321);
  });

  test("tears down a freshly created tunnel when the profile connection fails", async () => {
    const conn = pgConn({
      id: "pg-tunnel-fail",
      sshTunnel: {
        enabled: true,
        host: "bastion.example.com",
        port: 22,
        username: "admin",
        authMethod: "password",
        password: "secret",
      },
    });
    const originalConnect = mockPgPool.connect;
    mockPgPool.connect = async () => {
      throw new Error("connection refused");
    };
    try {
      await expect(acquireExecutionProfileProvider(conn, "agent-read-only")).rejects.toThrow(
        /connection refused|Failed to connect/,
      );
      const tunnel = (await mockCreateSSHTunnel.mock.results[0]?.value) as
        | { close: ReturnType<typeof mock> }
        | undefined;
      expect(tunnel?.close).toHaveBeenCalledTimes(1);
      expect(getExecutionProfileCacheStats().size).toBe(0);
    } finally {
      mockPgPool.connect = originalConnect;
    }
  });

  test("evicting an idle shared provider keeps the tunnel of a live profile provider", async () => {
    const clock = installFakeClock();
    try {
      await getOrCreateProvider(pgConn());
      // The profiled provider arrives later, so only the shared entry is idle
      // beyond the threshold below. The gap is injected, never slept for.
      clock.advance(60);
      await acquireExecutionProfileProvider(pgConn(), "agent-read-only");
      mockCloseSSHTunnel.mockClear();

      const evicted = await evictIdleProviders(30);

      expect(evicted).toBe(1);
      expect(getProviderCacheStats().size).toBe(0);
      expect(getExecutionProfileCacheStats().size).toBe(1);
      expect(mockCloseSSHTunnel).not.toHaveBeenCalled();
    } finally {
      clock.restore();
    }
  });

  test("evicting an idle profile provider keeps the tunnel of a still-served connection", async () => {
    const clock = installFakeClock();
    try {
      await acquireExecutionProfileProvider(pgConn(), "agent-read-only");
      // The writable provider arrives later, so only the profiled entry is idle
      // beyond the threshold below. The gap is injected, never slept for.
      clock.advance(60);
      await getOrCreateProvider(pgConn());
      mockCloseSSHTunnel.mockClear();

      const evicted = await evictIdleProviders(30);

      expect(evicted).toBe(1);
      expect(getExecutionProfileCacheStats().size).toBe(0);
      expect(getProviderCacheStats().size).toBe(1);
      expect(mockCloseSSHTunnel).not.toHaveBeenCalled();
    } finally {
      clock.restore();
    }
  });

  test("eviction logs and continues when a profile provider disconnect fails", async () => {
    const agent = await acquireExecutionProfileProvider(pgConn(), "agent-read-only");
    agent.disconnect = async () => {
      throw new Error("disconnect failed");
    };

    const evicted = await evictIdleProviders(0);

    expect(evicted).toBe(1);
    expect(getExecutionProfileCacheStats().size).toBe(0);
  });

  test("removeProvider logs and continues when a profile provider disconnect fails", async () => {
    const agent = await acquireExecutionProfileProvider(pgConn(), "agent-read-only");
    agent.disconnect = async () => {
      throw new Error("disconnect failed");
    };

    await removeProvider("pg-profile");

    expect(getExecutionProfileCacheStats().size).toBe(0);
  });

  test("clearProviderCache logs and continues when a profile provider disconnect rejects", async () => {
    const agent = await acquireExecutionProfileProvider(pgConn(), "agent-read-only");
    agent.disconnect = async () => {
      throw new Error("disconnect failed");
    };

    await clearProviderCache();

    expect(getExecutionProfileCacheStats().size).toBe(0);
  });

  test("removeProvider also removes the connection's profile providers", async () => {
    const agent = await acquireExecutionProfileProvider(pgConn(), "agent-read-only");

    await removeProvider("pg-profile");

    expect(getExecutionProfileCacheStats().size).toBe(0);
    expect(agent.isConnected()).toBe(false);
  });

  test("evictIdleProviders sweeps idle profile providers and closes the connection's tunnel", async () => {
    await acquireExecutionProfileProvider(pgConn(), "agent-read-only");

    const evicted = await evictIdleProviders(0);

    expect(evicted).toBe(1);
    expect(getExecutionProfileCacheStats().size).toBe(0);
    expect(mockCloseSSHTunnel).toHaveBeenCalledWith("pg-profile");
  });

  test("clearProviderCache clears the profile cache too", async () => {
    const agent = await acquireExecutionProfileProvider(pgConn(), "agent-read-only");

    await clearProviderCache();

    expect(getExecutionProfileCacheStats().size).toBe(0);
    expect(agent.isConnected()).toBe(false);
  });

  // ─── SQLite: read-only intent is injected server-side, never by a caller ──
  // sqlite runs on the real driver here (no mock), so these assert the actual
  // database boundary rather than factory bookkeeping.

  describe("sqlite", () => {
    let sqliteTmpDir: string;
    let seeded = 0;

    beforeAll(() => {
      sqliteTmpDir = mkdtempSync(join(tmpdir(), "libredb-factory-sqlite-"));
    });

    afterAll(() => {
      rmSync(sqliteTmpDir, { recursive: true, force: true });
    });

    /** A real on-disk sqlite connection with one seeded row. */
    async function seedFileConnection(): Promise<DatabaseConnection> {
      const conn = makeConnection("sqlite", {
        id: `sqlite-agent-${++seeded}`,
        database: join(sqliteTmpDir, `agent-${seeded}.db`),
      });
      const writer = await getOrCreateProvider(conn);
      await writer.query("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      await writer.query("INSERT INTO t (id, v) VALUES (1, 'seeded')");
      await removeProvider(conn.id);
      return conn;
    }

    test("acquires a sqlite agent provider whose writes the database rejects", async () => {
      const conn = await seedFileConnection();

      const agent = await acquireExecutionProfileProvider(conn, "agent-read-only");

      expect(await agent.queryReadOnly!("SELECT v FROM t", { ...AGENT_BUDGET })).toMatchObject({
        rows: [{ v: "seeded" }],
      });
      await expect(agent.queryReadOnly!("INSERT INTO t (id, v) VALUES (2, 'agent')", AGENT_BUDGET)).rejects.toThrow();
      expect(getExecutionProfileCacheStats()).toEqual({ size: 1, connections: [conn.id] });
      expect(getProviderCacheStats().size).toBe(0);
    });

    test("a caller-supplied options object cannot put the shared provider into the read-only profile", async () => {
      const conn = await seedFileConnection();

      // ProviderOptions is caller-supplied and flows through getOrCreateProvider;
      // the execution profile must be unreachable from it in either direction.
      const shared = await getOrCreateProvider(conn, { readOnly: true } as never);

      const insert = await shared.query("INSERT INTO t (id, v) VALUES (2, 'editor')");
      expect(insert.rowCount).toBe(1);
      expect(getExecutionProfileCacheStats().size).toBe(0);
    });

    test("refuses an in-memory sqlite target for the agent profile (fail closed)", async () => {
      const conn = makeConnection("sqlite", { id: "sqlite-memory-agent", database: ":memory:" });

      // Refused for being an in-memory target, not for the provider type
      // lacking a read-only profile — the deny code has to say which.
      const error: unknown = await acquireExecutionProfileProvider(conn, "agent-read-only").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ExecutionProfileError);
      expect((error as ExecutionProfileError).reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
      expect(getExecutionProfileCacheStats().size).toBe(0);
    });
  });
});

// ============================================================================
// One-shot tunnel scope (#457)
// ----------------------------------------------------------------------------
// The routes that build a provider outside both caches - test-connection and
// schema-snapshot - reach the database through here. Every assertion below is
// about lifecycle rather than transport: the tunnel must be unshared, and it
// must close on every exit path, because no cache eviction will ever do it.
// ============================================================================

describe("withOneShotTunnel", () => {
  // `mockHasTunnel` is not reset by the file-level beforeEach, and one assertion below
  // is that this scope never consults the shared pool - a negative that only means
  // anything against a counter this describe owns.
  beforeEach(() => {
    mockHasTunnel.mockClear();
  });

  const tunnelled = () =>
    makeConnection("postgres", {
      id: "one-shot-conn",
      host: "db.internal",
      port: 5432,
      sshTunnel: {
        enabled: true,
        host: "bastion.example.com",
        port: 22,
        username: "jump",
        authMethod: "password",
        password: "pw",
      },
    });

  const closeOf = async (call: number) =>
    ((await mockCreateSSHTunnel.mock.results[call]?.value) as { close: ReturnType<typeof mock> } | undefined)?.close;

  test("runs the callback against the local tunnel endpoint", async () => {
    const seen: Array<{ host?: string; port?: number }> = [];

    const result = await withOneShotTunnel(tunnelled(), async (effective) => {
      seen.push({ host: effective.host, port: effective.port });
      return "done";
    });

    expect(result).toBe("done");
    expect(seen).toEqual([{ host: "127.0.0.1", port: 54321 }]);
    expect(mockCreateSSHTunnel).toHaveBeenCalledTimes(1);
  });

  test("asks for an unshared tunnel so nothing pools it under the connection id", async () => {
    await withOneShotTunnel(tunnelled(), async () => undefined);

    expect(mockCreateSSHTunnel).toHaveBeenCalledWith(
      "one-shot-conn",
      expect.objectContaining({ host: "bastion.example.com" }),
      "db.internal",
      5432,
      { shared: false },
    );
    // The shared pool is never consulted: a one-shot scope must not adopt, or be
    // mistaken for, the tunnel serving a cached provider of the same connection.
    expect(mockHasTunnel).not.toHaveBeenCalled();
  });

  test("closes the tunnel after the callback succeeds", async () => {
    await withOneShotTunnel(tunnelled(), async () => undefined);

    expect(await closeOf(0)).toHaveBeenCalledTimes(1);
  });

  test("closes the tunnel and rethrows when the callback fails", async () => {
    await expect(
      withOneShotTunnel(tunnelled(), async () => {
        throw new Error("connect refused");
      }),
    ).rejects.toThrow("connect refused");

    expect(await closeOf(0)).toHaveBeenCalledTimes(1);
  });

  test("propagates the callback failure even when closing the tunnel throws", async () => {
    mockCreateSSHTunnel.mockImplementationOnce(async () => ({
      localHost: "127.0.0.1",
      localPort: 54321,
      close: mock(async () => {
        throw new Error("close failed");
      }),
    }));

    await expect(
      withOneShotTunnel(tunnelled(), async () => {
        throw new Error("connect refused");
      }),
    ).rejects.toThrow("connect refused");
  });

  test("opens no tunnel when the connection has none configured", async () => {
    const plain = makeConnection("postgres", { id: "no-tunnel-conn" });

    const seen = await withOneShotTunnel(plain, async (effective) => effective);

    expect(mockCreateSSHTunnel).not.toHaveBeenCalled();
    expect(seen).toBe(plain);
  });

  test("opens no tunnel when the SSH config is present but disabled", async () => {
    const off = tunnelled();
    off.sshTunnel!.enabled = false;

    await withOneShotTunnel(off, async (effective) => {
      expect(effective.host).toBe("db.internal");
    });

    expect(mockCreateSSHTunnel).not.toHaveBeenCalled();
  });

  test("opens no tunnel for a connection with no host and port to forward to", async () => {
    // A connection-string connection (MongoDB, Couchbase, ClickHouse) and SQLite carry
    // neither, so there is no endpoint to rewrite - the same rule the pooled paths apply.
    const stringOnly = tunnelled();
    delete stringOnly.host;
    delete stringOnly.port;

    await withOneShotTunnel(stringOnly, async () => undefined);

    expect(mockCreateSSHTunnel).not.toHaveBeenCalled();
  });
});
