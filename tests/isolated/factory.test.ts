/**
 * The provider factory's cache, execution profiles, single-writer borrow and shutdown handlers.
 *
 * WHY THIS FILE LIVES UNDER `tests/isolated/` AND NOT `tests/unit/db/` (#789).
 *
 * It can only pass while it is the FIRST thing in its bun process to evaluate
 * `@/lib/db/factory`. Two of its setup steps happen exactly once per process and cannot be
 * repeated: the `mock.module()` calls below, which stand in for six native driver packages
 * and `@/lib/ssh/tunnel` so that real providers can be constructed without a server, and the
 * `await import("@/lib/db/factory")` under a temporary `NODE_ENV=production`, which is how the
 * SIGTERM and SIGINT handlers the module registers on load are captured by diffing
 * `process.listeners`.
 *
 * If any other file in the same process has already evaluated the factory, this file inherits
 * an already-built module. Nothing registered a shutdown handler at an observable moment, so
 * the three `shutdown signal handlers` tests fail; and `getOrCreateProvider` caches a provider
 * built on unmocked drivers, whose entry then throws inside the `clearProviderCache()` in
 * `beforeEach` and fails every remaining test in the file.
 *
 * MEASURED 2026-09-13, so the claim is not an inference from the design:
 *
 * - This file alone: 99 pass 0 fail.
 * - Plus a three-line probe under `tests/unit/` whose only content is
 *   `import { createDatabaseProvider } from "@/lib/db/factory"`: 44 pass 56 fail. Three of the
 *   56 are the shutdown tests and 53 are the cascade from the `beforeEach`.
 * - The same probe importing `@/lib/ssh/tunnel` instead, or `@/lib/db/compatibility`, or doing
 *   nothing at all: 100 pass 0 fail. So it is the factory specifier and nothing else.
 * - Both CLI orders give the same 56. bun does not run test files in the order they are
 *   listed, measured by tracing the console output, so which file wins is not something the
 *   other file can arrange.
 *
 * The old component runner named this hazard from the other side and fixed it by moving the
 * OTHER file out of the group. That stopped working when #789 added two `tests/unit` files that
 * construct every provider through the real factory: a fleet census cannot do its job without
 * importing it. So the requirement sits on the file that needs it, which is this paragraph, and
 * the runner is what enforces it: one bun process per test file, no directory and no
 * registration, and `bun test tests/unit` is clean again.
 */
import { describe, test, expect, mock, beforeEach, beforeAll, afterAll, afterEach, jest, spyOn } from "bun:test";
import { open as libreOpen, kv as libreKv } from "@libredb/libredb";
import { captureContextSnapshot } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import type { AgentToolContext } from "@/lib/agent/tools";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry, sqlExplainAnalyzeDescriptor } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import type { DatabaseProvider, QueryResult } from "@/lib/db/types";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative as relativePath } from "node:path";
import type { DatabaseConnection, EditorExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import { ConnectionError, DatabaseConfigError, ExecutionProfileError, TimeoutError } from "@/lib/db/errors";
import { READ_ONLY_ENFORCED, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
import { supportsQueryCancel } from "@/lib/db/query-cancel";
import { MACHINE_PROFILE_SENTENCE } from "@/lib/db/providers/platform/kubernetes/machine-read";
import { removeOwnerProviders } from "@/lib/db/owner-removal";
import { logger } from "@/lib/logger";
import type { SSHTunnelConfig } from "@/lib/types";

// The SQLite agent-profile tests below construct the read-only profile for its
// query_only boundary, not to exercise the child transport. The worker's node:sqlite
// child hangs on Windows (Bun 1.4.x) under the profile's repeated `PRAGMA query_only`,
// so this file forces the synchronous in-process driver the way its provider tests
// are designed around.
process.env.LIBREDB_SQLITE_WORKER = "0";

/** Enforcement caps for the sqlite agent-profile assertions below. */
const AGENT_BUDGET: ReadOnlyStatementBudget = {
  statementTimeoutMs: 5_000,
  maxResultRows: 100,
  maxResultBytes: 64 * 1024,
};

/**
 * The `database` the two construction censuses hand the libredb provider.
 *
 * It is a path that is never opened, so what matters about it is only that it is a legal one:
 * the "/tmp/test.libredb" it replaces names a directory that does not exist on Windows, and a
 * hardcoded absolute path shared by every process is a collision waiting for the day something
 * does open it. `tmpdir()` answers the platform's own scratch directory on all three.
 */
const CENSUS_LIBREDB_FILE = join(tmpdir(), "factory-census.libredb");

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

/**
 * The configuration of every pg Pool a PostgreSQL provider built, oldest first, so the pool an owned
 * provider opens (docs/GOVERNANCE.md#per-user-providers) is read where the driver receives it. A test that reads it
 * empties it first.
 */
const pgPoolConfigs: { min?: number; max?: number; idleTimeoutMillis?: number }[] = [];

// The provider imports `types` from pg for its per-pool parsers, so the mock has to export
// it. These rows never reach a parser, and the real registry is passed rather than a stub.
// `Client` likewise: the provider subclasses it to keep server notices (#1401), and the
// mocked pool never builds one.
const { types: realPgTypes, Client: realPgClient } = await import("pg");

class MockPgPool {
  constructor(config: { min?: number; max?: number; idleTimeoutMillis?: number }) {
    pgPoolConfigs.push(config);
    return mockPgPool;
  }
}

mock.module("pg", () => ({
  default: { Pool: MockPgPool },
  Pool: MockPgPool,
  Client: realPgClient,
  types: realPgTypes,
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

/**
 * The tunnel this mock stands in for now HAS a far end, and a test can make it a different
 * one from the address the record names (D86).
 *
 * It used to answer a local endpoint and nothing else, so there was no far end to be wrong
 * about and a test asserting what the factory sealed could only have pinned the defect. The
 * default echoes the address it was asked to forward to, which is the honest case; the D86
 * test overrides one call with a forward that reaches somewhere else, which is what a pooled
 * tunnel opened for a previous record actually is.
 */
const mockCreateSSHTunnel = mock(async (_id: string, _sshConfig: unknown, remoteHost: string, remotePort: number) => ({
  localHost: "127.0.0.1",
  localPort: 54321,
  remoteHost,
  remotePort,
  close: mock(async () => {}),
}));

const mockCloseSSHTunnel = mock(async () => {});

/**
 * Takes its arguments so the assertions on them are not vacuous: the factory must ask about ONE
 * forward - this connection's route and far end - and the loose question would answer `true` for
 * a forward this call is about to open, which is the FD-leak the `tunnelPreexisted` flag guards.
 */
const mockHasTunnel = mock((_connectionId: string, _forward?: unknown) => false);

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
  getOrCreateProvider: rawGetOrCreateProvider,
  removeProvider,
  clearProviderCache,
  getProviderCacheStats,
  evictIdleProviders,
  registerShutdownHandlers,
  acquireExecutionProfileProvider: rawAcquireExecutionProfileProvider,
  executionContextFor,
  profiledCacheKey,
  findOpenSingleWriterProvider,
  isSingleWriterFileOpen,
  getExecutionProfileCacheStats,
  withOneShotTunnel,
  assertReadOnlyHonoured,
  editorCacheKey,
  findCachedProvider,
} = await import("@/lib/db/factory");
// Existing SQLite cache tests exercise trusted callers. Explicitly grant their file posture;
// denied callers are tested separately against the unwrapped factory below.
function getOrCreateProvider(...args: Parameters<typeof rawGetOrCreateProvider>) {
  const [connection, options, execution] = args;
  return rawGetOrCreateProvider(
    connection,
    options,
    execution ?? (connection.type === "sqlite" ? { allowExternalFileAccess: true } : {}),
  );
}
// The same for the profiled path: existing SQLite agent tests exercise trusted requesters, and the
// denied ones are tested against the unwrapped acquisition below.
function acquireExecutionProfileProvider(...args: Parameters<typeof rawAcquireExecutionProfileProvider>) {
  const [connection, profile, options, requester] = args;
  return rawAcquireExecutionProfileProvider(
    connection,
    profile,
    options,
    requester ?? (connection.type === "sqlite" ? { allowExternalFileAccess: true } : {}),
  );
}
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
  test.each([
    [undefined, undefined, 60000],
    [120000, undefined, 120000],
    [5000, undefined, 5000],
    [120000, 10000, 10000],
  ])("resolves connection timeout %s with override %s to %s ms", async (saved, override, expected) => {
    const provider = await createDatabaseProvider(makeConnection("postgres", { queryTimeout: saved }), {
      queryTimeout: override,
    });
    // Read the effective value consumed by drivers, not just the saved configuration.
    expect((provider as unknown as { queryTimeout: number }).queryTimeout).toBe(expected);
  });

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

  test('creates provider for type "duckdb"', async () => {
    // `:memory:` rather than a path, so the case is exercised without the engine taking
    // an exclusive lock on a file in the working tree.
    const conn = makeConnection("duckdb", { database: ":memory:" });
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("duckdb");
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

  // The owner (docs/GOVERNANCE.md#per-user-providers) reaches OracleProvider and MSSQLProvider, which arm their
  // transaction timeout only when owned.
  test("hands the execution context's owner to the oracle and mssql providers", async () => {
    const oracle = makeConnection("oracle", { serviceName: "ORCL" } as Partial<DatabaseConnection>);
    const mssql = makeConnection("mssql");
    const owner = { owner: "subject-a", ownerPoolMax: 3 };
    const [ownedOracle, sharedOracle, ownedMssql, sharedMssql] = await Promise.all([
      createDatabaseProvider(oracle, {}, owner),
      createDatabaseProvider(oracle),
      createDatabaseProvider(mssql, {}, owner),
      createDatabaseProvider(mssql),
    ]);
    const ownedOf = (provider: unknown) => (provider as { owned: boolean }).owned;
    expect(ownedOf(ownedOracle)).toBe(true);
    expect(ownedOf(sharedOracle)).toBe(false);
    expect(ownedOf(ownedMssql)).toBe(true);
    expect(ownedOf(sharedMssql)).toBe(false);
  });

  test('creates provider for type "db2"', async () => {
    const conn = makeConnection("db2");
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("db2");
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

  test('creates provider for type "firestore", unconnected, with its own dialect and its read-only enforcement', async () => {
    // No host, port, user or credential: the constructor reads no credential and opens nothing (Firestore spec 3.3).
    const conn = makeConnection("firestore", {
      host: undefined,
      port: undefined,
      user: undefined,
      password: undefined,
      database: "demo-studio",
    });
    const provider = await createDatabaseProvider(conn);
    expect(provider.type).toBe("firestore");
    expect(provider.getCapabilities().queryLanguage).toBe("json");
    expect(provider.getCapabilities().queryDialect).toBe("firestore");
    expect(provider.getCapabilities().enforcesReadOnly).toBe(true);
    expect(provider.isConnected()).toBe(false);
  });

  test("a firestore connection with readOnly: true is built, since its provider keeps the mode", async () => {
    const conn = {
      ...makeConnection("firestore", {
        host: undefined,
        port: undefined,
        password: undefined,
        database: "demo-studio",
      }),
      readOnly: true,
    };
    expect(() => assertReadOnlyHonoured(conn)).not.toThrow();
    expect((await createDatabaseProvider(conn)).type).toBe("firestore");
  });

  test("the factory error lists firestore between couchbase and redis, the order of the cases", async () => {
    const conn = makeConnection("not-an-engine");
    await expect(createDatabaseProvider(conn)).rejects.toThrow(
      /Supported types: .*\bmongodb, couchbase, firestore, redis\b/,
    );
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

  test('creates provider for type "databend"', async () => {
    // Over a password to a non-loopback host without TLS, and with no Warehouse: the constructor validates nothing
    // and opens nothing (Databend design 2.3), so the provider is built and declares SQL, the Databend plan format
    // and no billed compute, with no server running; the plaintext refusal comes from connect().
    const conn = makeConnection("databend", { port: 8000, database: undefined });
    const provider = await createDatabaseProvider(conn);
    expect(provider.type).toBe("databend");
    const capabilities = provider.getCapabilities();
    expect(capabilities.queryLanguage).toBe("sql");
    expect(capabilities.explainFormat).toBe("databend-text");
    expect(capabilities.enforcesReadOnly).toBeUndefined();
    expect(capabilities.resumesBilledCompute).toBeUndefined();
    expect(provider.isConnected()).toBe(false);
  });

  test("a databend connection with readOnly: true is refused before anything is built (Databend design 5.7)", async () => {
    const conn = { ...makeConnection("databend", { port: 8000 }), readOnly: true };
    expect(() => assertReadOnlyHonoured(conn)).toThrow("readOnly: true is refused for databend");
    await expect(createDatabaseProvider(conn)).rejects.toThrow(DatabaseConfigError);
  });

  test("the factory error lists databend after trino, in the SQL block", async () => {
    const conn = makeConnection("not-an-engine");
    await expect(createDatabaseProvider(conn)).rejects.toThrow(
      /Supported types: .*\bdruid, trino, databend, bigquery, snowflake, spark, cassandra\b/,
    );
  });

  test("the factory error lists spark after snowflake, in the SQL block", async () => {
    const conn = makeConnection("not-an-engine");
    await expect(createDatabaseProvider(conn)).rejects.toThrow(/\bsnowflake, spark, cassandra\b/);
  });

  test('creates provider for type "spark", unconnected, with the factory passing no transport', async () => {
    const { SparkProvider } = await import("@/lib/db/providers/sql/spark/index");
    const provider = await createDatabaseProvider(makeConnection("spark", { host: "127.0.0.1", port: 15002 }));
    expect(provider).toBeInstanceOf(SparkProvider);
    expect(provider.isConnected()).toBe(false);
    // The third constructor argument, the transport seam, defaults to an empty object when the factory omits it.
    expect((provider as unknown as { deps: Record<string, unknown> }).deps).toStrictEqual({});
  });

  test('creates provider for type "cassandra"', async () => {
    // `database` carries the KEYSPACE and `localDataCenter` is required by the
    // driver, so a connection missing it cannot be constructed at all.
    const conn = makeConnection("cassandra", { port: 9042, database: "probe", localDataCenter: "datacenter1" });
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("cassandra");
  });

  test('creates provider for type "prometheus"', async () => {
    // No `database`: the server holds one TSDB and every API read is addressed to it, so the
    // helper's default database is cleared. Building the provider reads nothing from the network,
    // so it is built, and declares its language, with no server running.
    const conn = makeConnection("prometheus", { port: 9090, database: undefined });
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("prometheus");
    expect(provider.getCapabilities().queryLanguage).toBe("promql");
  });

  test('creates provider for type "influxdb"', async () => {
    // No `database`: an empty one lists every database the credential reads, resolved in connect(). The
    // constructor validates nothing and opens nothing, so the provider is built, and declares its language with no
    // dialect, its read-only enforcement and no maintenance, with no server running.
    const conn = makeConnection("influxdb", { port: 8086, database: undefined });
    const provider = await createDatabaseProvider(conn);
    expect(provider.type).toBe("influxdb");
    const capabilities = provider.getCapabilities();
    expect(capabilities.queryLanguage).toBe("influxql");
    expect(capabilities.queryDialect).toBeUndefined();
    expect(capabilities.enforcesReadOnly).toBe(true);
    expect(capabilities.supportsMaintenance).toBe(false);
    expect(provider.isConnected()).toBe(false);
  });

  test("an influxdb connection with readOnly: true is built, since its provider keeps the mode (InfluxDB spec I8)", async () => {
    const conn = { ...makeConnection("influxdb", { port: 8086, database: undefined }), readOnly: true };
    expect(() => assertReadOnlyHonoured(conn)).not.toThrow();
    expect((await createDatabaseProvider(conn)).type).toBe("influxdb");
  });

  test('creates provider for type "influxdb3"', async () => {
    // No user: InfluxDB 3 has none, and the token rides in `password`. The constructor validates nothing and opens
    // nothing, so the provider is built, and declares SQL, its read-only enforcement and no maintenance, with no
    // server running.
    const conn = makeConnection("influxdb3", { port: 8181, user: undefined, database: undefined });
    const provider = await createDatabaseProvider(conn);
    expect(provider.type).toBe("influxdb3");
    const capabilities = provider.getCapabilities();
    expect(capabilities.queryLanguage).toBe("sql");
    expect(capabilities.queryDialect).toBeUndefined();
    expect(capabilities.enforcesReadOnly).toBe(true);
    expect(capabilities.supportsMaintenance).toBe(false);
    expect(provider.isConnected()).toBe(false);
  });

  test("an influxdb3 connection with readOnly: true is built, since its provider keeps the mode (InfluxDB spec I8)", async () => {
    const conn = {
      ...makeConnection("influxdb3", { port: 8181, user: undefined, database: undefined }),
      readOnly: true,
    };
    expect(() => assertReadOnlyHonoured(conn)).not.toThrow();
    expect((await createDatabaseProvider(conn)).type).toBe("influxdb3");
  });

  test("the factory error lists both InfluxDB types after prometheus, in their family block", async () => {
    const conn = makeConnection("not-an-engine");
    await expect(createDatabaseProvider(conn)).rejects.toThrow(
      /Supported types: .*\bprometheus, influxdb, influxdb3, kafka\b/,
    );
  });

  test('creates provider for type "kafka"', async () => {
    // No `database`: one connection is one cluster. The constructor validates nothing and opens
    // nothing, since the connection's rules run in connect() before any client exists, so the
    // provider is built, and declares its language and dialect, with no broker running.
    const conn = makeConnection("kafka", { port: 9092, database: undefined });
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("kafka");
    expect(provider.getCapabilities().queryLanguage).toBe("json");
    expect(provider.getCapabilities().queryDialect).toBe("kafka");
    expect(provider.isConnected()).toBe(false);
  });

  test('creates provider for type "etcd"', async () => {
    // No `database`: one connection is one cluster. The constructor validates nothing and opens nothing, the
    // connection's rules running in connect() before any client exists (#1089 3.1), so the provider is built,
    // and declares its language, its dialect and its read-only enforcement, with no etcd running.
    const conn = makeConnection("etcd", { port: 2379, database: undefined });
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("etcd");
    expect(provider.getCapabilities().queryLanguage).toBe("json");
    expect(provider.getCapabilities().queryDialect).toBe("etcd");
    expect(provider.getCapabilities().enforcesReadOnly).toBe(true);
    expect(provider.isConnected()).toBe(false);
  });

  test("an etcd connection with readOnly: true is built, since its provider keeps the mode (#1089 E6)", async () => {
    const conn = { ...makeConnection("etcd", { port: 2379, database: undefined }), readOnly: true };
    expect(() => assertReadOnlyHonoured(conn)).not.toThrow();
    const provider = await createDatabaseProvider(conn);
    expect(provider.type).toBe("etcd");
  });

  test('an etcd connection with readOnly: "true" is refused before anything is built (#1089 E6)', async () => {
    const conn = {
      ...makeConnection("etcd", { port: 2379, database: undefined }),
      readOnly: "true" as unknown as boolean,
    };
    expect(() => assertReadOnlyHonoured(conn)).toThrow("readOnly must be true or false.");
    await expect(createDatabaseProvider(conn)).rejects.toThrow("readOnly must be true or false.");
  });

  test('creates provider for type "neo4j"', async () => {
    // No `database`: an empty one means the server's home database, resolved in connect(). The constructor
    // validates nothing and opens nothing (Neo4j spec 6.1), so the provider is built, and declares its
    // language and its read-only enforcement, with no server running.
    const conn = makeConnection("neo4j", { port: 7687, database: undefined });
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("neo4j");
    expect(provider.getCapabilities().queryLanguage).toBe("cypher");
    expect(provider.getCapabilities().enforcesReadOnly).toBe(true);
    expect(provider.isConnected()).toBe(false);
  });

  test("a neo4j connection with readOnly: true is built, since its provider keeps the mode", async () => {
    const conn = { ...makeConnection("neo4j", { port: 7687, database: undefined }), readOnly: true };
    expect(() => assertReadOnlyHonoured(conn)).not.toThrow();
    const provider = await createDatabaseProvider(conn);
    expect(provider.type).toBe("neo4j");
  });

  test('creates provider for type "qdrant"', async () => {
    // No user and no database: Qdrant has neither. The constructor validates nothing and opens nothing, as
    // etcd's, so the provider is built, and declares its language, its dialect and its read-only enforcement,
    // with no Qdrant running.
    const conn = makeConnection("qdrant", { port: 6333, user: undefined, database: undefined });
    const provider = await createDatabaseProvider(conn);
    expect(provider.type).toBe("qdrant");
    expect(provider.getCapabilities().queryLanguage).toBe("json");
    expect(provider.getCapabilities().queryDialect).toBe("qdrant");
    expect(provider.getCapabilities().enforcesReadOnly).toBe(true);
    expect(provider.getCapabilities().supportsMaintenance).toBe(false);
    expect(provider.isConnected()).toBe(false);
  });

  test("a qdrant connection with readOnly: true is built, since its provider keeps the mode (vector-family spec 4.4)", async () => {
    const conn = { ...makeConnection("qdrant", { port: 6333, user: undefined, database: undefined }), readOnly: true };
    expect(() => assertReadOnlyHonoured(conn)).not.toThrow();
    expect((await createDatabaseProvider(conn)).type).toBe("qdrant");
  });

  test('creates provider for type "weaviate"', async () => {
    // No user and no database: Weaviate takes a bearer token alone and has no container level. The constructor
    // validates nothing and opens nothing, as Qdrant's, so the provider is built with no Weaviate running.
    const conn = makeConnection("weaviate", { port: 8080, user: undefined, database: undefined });
    const provider = await createDatabaseProvider(conn);
    expect(provider.type).toBe("weaviate");
    expect(provider.getCapabilities().queryLanguage).toBe("json");
    expect(provider.getCapabilities().queryDialect).toBe("weaviate");
    expect(provider.getCapabilities().enforcesReadOnly).toBe(true);
    expect(provider.getCapabilities().supportsMaintenance).toBe(false);
    expect(provider.isConnected()).toBe(false);
  });

  test("a weaviate connection with readOnly: true is built, since its provider keeps the mode (#1566 spec 3.5)", async () => {
    const conn = {
      ...makeConnection("weaviate", { port: 8080, user: undefined, database: undefined }),
      readOnly: true,
    };
    expect(() => assertReadOnlyHonoured(conn)).not.toThrow();
    expect((await createDatabaseProvider(conn)).type).toBe("weaviate");
  });

  test('creates provider for type "oxia"', async () => {
    // No user and no namespace: Oxia has no user name, and an empty namespace means default. The constructor
    // validates nothing and opens nothing, so the provider is built, and declares its language, its dialect and
    // its read-only enforcement, with no Oxia running (SB3-1.2).
    const conn = makeConnection("oxia", { port: 6648, user: undefined, database: undefined });
    const provider = await createDatabaseProvider(conn);
    expect(provider.type).toBe("oxia");
    expect(provider.getCapabilities().queryLanguage).toBe("json");
    expect(provider.getCapabilities().queryDialect).toBe("oxia");
    expect(provider.getCapabilities().enforcesReadOnly).toBe(true);
    expect(provider.isConnected()).toBe(false);
  });

  test("an oxia connection with readOnly: true is built, since its provider keeps the mode (DECISIONS O1)", async () => {
    const conn = { ...makeConnection("oxia", { port: 6648, user: undefined, database: undefined }), readOnly: true };
    expect(() => assertReadOnlyHonoured(conn)).not.toThrow();
    const provider = await createDatabaseProvider(conn);
    expect(provider.type).toBe("oxia");
    expect(provider.getCapabilities().enforcesReadOnly).toBe(true);
  });

  test("the factory error lists oxia among the supported types, after etcd and before prometheus", async () => {
    const conn = makeConnection("not-an-engine");
    await expect(createDatabaseProvider(conn)).rejects.toThrow(/Supported types: .*\betcd, oxia, prometheus\b/);
  });

  test('creates provider for type "milvus"', async () => {
    // The constructor validates nothing and opens nothing, as etcd's, so the provider is built, and declares its
    // language, its dialect and its read-only enforcement, with no Milvus running (vector-family spec 5.7).
    const conn = makeConnection("milvus", { port: 19530, database: undefined });
    const provider = await createDatabaseProvider(conn);
    expect(provider.type).toBe("milvus");
    expect(provider.getCapabilities().queryLanguage).toBe("json");
    expect(provider.getCapabilities().queryDialect).toBe("milvus");
    expect(provider.getCapabilities().enforcesReadOnly).toBe(true);
    expect(provider.isConnected()).toBe(false);
  });

  test("a milvus connection with readOnly: true is built, since its provider keeps the mode (vector-family E8)", async () => {
    const conn = { ...makeConnection("milvus", { port: 19530, database: undefined }), readOnly: true };
    expect(() => assertReadOnlyHonoured(conn)).not.toThrow();
    expect((await createDatabaseProvider(conn)).type).toBe("milvus");
  });

  test("the factory error lists milvus among the supported types, before qdrant and the embedded store", async () => {
    const conn = makeConnection("not-an-engine");
    await expect(createDatabaseProvider(conn)).rejects.toThrow(
      /Supported types: .*\bneo4j, milvus, qdrant, weaviate, s3, mqtt, opcua, mtconnect, modbus, snmp, rabbitmq, kubernetes, netconf, sparkplug, libredb$/,
    );
  });

  test("a kubernetes connection is built unconnected, with the kubectl dialect, and keeps readOnly", async () => {
    const conn = { ...makeConnection("kubernetes", { port: 6443, database: undefined }), readOnly: true };
    expect(() => assertReadOnlyHonoured(conn)).not.toThrow();
    const provider = await createDatabaseProvider(conn);
    expect(provider.type).toBe("kubernetes");
    expect(provider.getCapabilities().queryDialect).toBe("kubectl");
    expect(provider.getCapabilities().enforcesReadOnly).toBe(true);
    expect(provider.isConnected()).toBe(false);
  });

  test("the execution context rides along to kubernetes: queryReadOnly answers only under the agent profile", async () => {
    const conn = makeConnection("kubernetes", { port: 6443, database: undefined });
    const profiled = await createDatabaseProvider(conn, {}, { readOnly: true });
    const editor = await createDatabaseProvider(conn);
    if (profiled.queryReadOnly === undefined || editor.queryReadOnly === undefined) throw new Error("no queryReadOnly");
    // Unconnected, both refuse at the session before the profile is consulted.
    await expect(profiled.queryReadOnly("get pods", AGENT_BUDGET)).rejects.toThrow("Provider is not connected");
    // With a session in place, and a statement the console refuses before sending anything, only the provider built
    // without the context stops at the profile.
    const lifetime = new AbortController();
    for (const provider of [profiled, editor]) {
      Object.assign(provider, { requireSession: () => ({ surface: {}, explainCache: null, lifetime }) });
    }
    const write = "delete pod web-1";
    await expect(editor.queryReadOnly(write, AGENT_BUDGET)).rejects.toThrow(MACHINE_PROFILE_SENTENCE);
    const refusal = await profiled.queryReadOnly(write, AGENT_BUDGET).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("it is not read-only");
    expect((refusal as Error).message).not.toContain(MACHINE_PROFILE_SENTENCE);
    lifetime.abort();
  });

  test("the factory error lists weaviate between qdrant and s3", async () => {
    const conn = makeConnection("not-an-engine");
    await expect(createDatabaseProvider(conn)).rejects.toThrow(
      /Supported types: .*\bqdrant, weaviate, s3\b.*, libredb$/,
    );
  });

  test("the factory error lists qdrant among the supported types, before the embedded store", async () => {
    const conn = makeConnection("not-an-engine");
    await expect(createDatabaseProvider(conn)).rejects.toThrow(/Supported types: .*\bqdrant\b.*, libredb$/);
  });

  test('creates provider for type "s3"', async () => {
    // A blank key pair is an unsigned connection, and an empty Bucket pins nothing. The constructor validates nothing
    // and opens nothing, as Oxia's, so the provider is built, and declares its language, its dialect and its read-only
    // enforcement, with no S3 server running.
    const conn = makeConnection("s3", { port: 9000, user: undefined, password: undefined, database: undefined });
    const provider = await createDatabaseProvider(conn);
    expect(provider.type).toBe("s3");
    expect(provider.getCapabilities().queryLanguage).toBe("json");
    expect(provider.getCapabilities().queryDialect).toBe("s3");
    expect(provider.getCapabilities().enforcesReadOnly).toBe(true);
    expect(provider.isConnected()).toBe(false);
  });

  test("an s3 connection with readOnly: true is built, since its provider keeps the mode", async () => {
    const conn = {
      ...makeConnection("s3", { port: 9000, user: undefined, password: undefined, database: undefined }),
      readOnly: true,
    };
    expect(() => assertReadOnlyHonoured(conn)).not.toThrow();
    expect((await createDatabaseProvider(conn)).type).toBe("s3");
  });

  test("the factory error lists s3 between qdrant and kubernetes, kubernetes before the embedded store", async () => {
    const conn = makeConnection("not-an-engine");
    await expect(createDatabaseProvider(conn)).rejects.toThrow(
      /Supported types: .*\bqdrant, weaviate, s3, mqtt, opcua, mtconnect, modbus, snmp, rabbitmq, kubernetes, netconf, sparkplug, libredb$/,
    );
  });

  test('creates provider for type "libredb"', async () => {
    // A path the platform owns rather than a hardcoded "/tmp/...", which is not a directory
    // on Windows at all. Nothing opens this file: `createDatabaseProvider` constructs and
    // validates without touching the disk, so this is the spelling of a path and not a
    // fixture. It is named all the same, so a provider that ever did open it says where.
    const conn = makeConnection("libredb", { database: CENSUS_LIBREDB_FILE });
    const provider = await createDatabaseProvider(conn);
    expect(provider).toBeDefined();
    expect(provider.type).toBe("libredb");
  });

  // ─── supportsTransactions agrees with the route's own shape check (#464) ───
  //
  // `POST /api/db/transaction` gates on `isTransactionProvider(provider)` — the three
  // methods being present — which no client can read, so `Studio.tsx` reads the
  // declared capability instead. Two declarations for one fact drift, and the drift is
  // silent in both directions: `true` without the methods puts back the HTTP 400 the
  // capability exists to prevent, and `false` with them hides working controls. Every
  // SHIPPED type is checked rather than a sample, since the one nobody notices is
  // exactly the one that drifts.
  test("every provider's supportsTransactions matches whether it implements the trio", async () => {
    const overrides: Record<string, Partial<DatabaseConnection>> = {
      sqlite: { database: ":memory:" },
      mongodb: { connectionString: "mongodb://localhost/test" },
      oracle: { serviceName: "ORCL" } as Partial<DatabaseConnection>,
      couchbase: { port: 8091, database: "travel" },
      elasticsearch: { port: 9200 },
      opensearch: { port: 9200 },
      clickhouse: { port: 8123, database: "demo" },
      druid: { port: 8888 },
      trino: { port: 8080, database: "tpch" },
      cassandra: { port: 9042, database: "probe", localDataCenter: "datacenter1" } as Partial<DatabaseConnection>,
      libredb: { database: CENSUS_LIBREDB_FILE },
    };

    const declaringTypes: string[] = [];
    const implicitCommitTypes: string[] = [];
    for (const type of SHIPPED_DATABASE_TYPES) {
      const provider = (await createDatabaseProvider(makeConnection(type, overrides[type] ?? {}))) as unknown as Record<
        string,
        unknown
      >;
      const implementsTrio =
        typeof provider.beginTransaction === "function" &&
        typeof provider.commitTransaction === "function" &&
        typeof provider.rollbackTransaction === "function";
      const declared = (provider.getCapabilities as () => { supportsTransactions?: boolean })().supportsTransactions;

      expect(declared).toBe(implementsTrio);
      if (declared === true) declaringTypes.push(type);

      // A list of statements that commit a transaction is a claim about a transaction, so a
      // provider with none must not declare one: SANDBOX is never offered there to read it.
      const implicit = (provider.getCapabilities as () => { implicitCommitStatements?: readonly string[] })()
        .implicitCommitStatements;
      if (implicit !== undefined) {
        expect(declared).toBe(true);
        implicitCommitTypes.push(type);
        for (const keyword of implicit) expect(keyword).toBe(keyword.toUpperCase());
      }
    }

    // MySQL and Oracle commit around DDL; PostgreSQL declares its own COMMIT synonyms; SQL
    // Server rolls DDL back and has none.
    expect(implicitCommitTypes.sort()).toEqual(["mysql", "oracle", "postgres"]);

    // The positive half, pinned by name: exactly four providers hold a transaction
    // session, so a fifth (or a lost one) fails here and not only in the loop above.
    expect(declaringTypes.sort()).toEqual(["mssql", "mysql", "oracle", "postgres"]);
  });

  // ─── supportsQueryCancel, by name (#1364) ───
  //
  // The capability is read off the provider by the one check the cancel route makes, so it
  // cannot drift from the route; what CAN change unnoticed is which providers have a
  // `cancelQuery` at all, and the editor disables Cancel on every one that does not. Pinned
  // by name so a provider gaining or losing it is a reviewed change.
  test("the providers that cannot cancel a running statement, by name", async () => {
    const overrides: Record<string, Partial<DatabaseConnection>> = {
      sqlite: { database: ":memory:" },
      mongodb: { connectionString: "mongodb://localhost/test" },
      oracle: { serviceName: "ORCL" } as Partial<DatabaseConnection>,
      couchbase: { port: 8091, database: "travel" },
      elasticsearch: { port: 9200 },
      opensearch: { port: 9200 },
      clickhouse: { port: 8123, database: "demo" },
      druid: { port: 8888 },
      trino: { port: 8080, database: "tpch" },
      cassandra: { port: 9042, database: "probe", localDataCenter: "datacenter1" } as Partial<DatabaseConnection>,
      libredb: { database: CENSUS_LIBREDB_FILE },
    };

    const cannotCancel: string[] = [];
    for (const type of SHIPPED_DATABASE_TYPES) {
      const provider = await createDatabaseProvider(makeConnection(type, overrides[type] ?? {}));
      if (!supportsQueryCancel(provider)) cannotCancel.push(type);
    }

    expect(cannotCancel.sort()).toEqual([
      "bigquery",
      "cassandra",
      "couchbase",
      "db2",
      "druid",
      "elasticsearch",
      "kafka",
      "libredb",
      "libsql",
      // No cancel either, and for a reason of its own: a read is one exchange at a time on a
      // connection this provider does not hold open, and Modbus has no request that stops one in
      // flight - the five requests MB-S1 allows are four reads and the identification read (#1723).
      "modbus",
      "mongodb",
      // No cancel: a read is one subscription with its own budget, and there is no statement to stop.
      "mqtt",
      // No cancel either, and for OPC UA's reason rather than MQTT's: a read is bounded by bytes
      // instead, at most 16 MiB a request and one request at a time per agent, and MTConnect's
      // interface has no request that stops one in flight (#1722).
      "mtconnect",
      // No cancel either, and the reason is the protocol's: RFC 6241 has no operation that stops a
      // read in flight, and this provider holds one request per session, so there is nothing to
      // cancel and nothing to cancel it with. A read is bounded instead, by the session's deadline
      // and the framing's byte cap (#1724).
      "netconf",
      // No cancel either: a read is bounded instead, at most 200 nodes or 500 values a request, and
      // the protocol has no service that stops one in flight (#1677).
      // No cancel: the eight read services the seam names have no Cancel among them.
      "opcua",
      "opensearch",
      "redis",
      // No cancel either, and the reason is UDP's: a Get is one datagram out and one back, with
      // nothing in RFC 3416 that stops one in flight. A read is bounded instead, by the walk's
      // budget and by what one datagram can carry (#1721).
      "snmp",
      "sparkplug",
    ]);
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

  test("asks the pool about THIS forward, route and far end, before opening one", async () => {
    // D86. `tunnelPreexisted` decides whether a failed connect may close the tunnel, so the
    // question has to be the specific one: a loose `hasTunnel(id)` answers `true` for any forward
    // under the id, and the forward this call opened would then be left open on failure. Deleting
    // the second argument in `getOrCreateProvider` fails here and nowhere else.
    const conn = makeConnection("sqlite", {
      id: "ssh-has-tunnel-args",
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

    expect(mockHasTunnel).toHaveBeenLastCalledWith("ssh-has-tunnel-args", {
      ssh: conn.sshTunnel,
      farEnd: { host: "remote-db.example.com", port: 5432 },
    });
  });

  test("seals the far end the tunnel forwards to, not the one the record names", async () => {
    // D86. The factory used to build the far end from the RECORD it was handed, while the
    // pooled tunnel could be forwarding somewhere else entirely, so a plan verified against
    // a machine the statement never reached. The far end now comes off the tunnel.
    const forwardedTo = { host: "forwarded-db.internal", port: 15432 };
    const conn = makeConnection("sqlite", {
      id: "ssh-seal-far-end",
      host: "record-db.example.com",
      port: 5432,
      database: ":memory:",
      sshTunnel: {
        enabled: true,
        host: "bastion.example.com",
        port: 22,
        username: "admin",
        authMethod: "password",
        password: "secret",
      },
    } as Partial<DatabaseConnection>);
    // The forward reaches an address this record does not name: a tunnel opened before the
    // record's host was edited. The factory is handed it and must seal what it reaches.
    mockCreateSSHTunnel.mockImplementationOnce(async () => ({
      localHost: "127.0.0.1",
      localPort: 54321,
      remoteHost: forwardedTo.host,
      remotePort: forwardedTo.port,
      close: mock(async () => {}),
    }));

    const provider = await getOrCreateProvider(conn);

    const sealed = await connectionFingerprint(provider.config);
    expect(sealed).toBe(await connectionFingerprint({ ...conn, host: forwardedTo.host, port: forwardedTo.port }));
    expect(sealed).not.toBe(await connectionFingerprint(conn));
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

  test("an inline connection without an id is refused before the cache key is computed (#1539)", async () => {
    // The provider's own validate() refuses this record with DatabaseConfigError("Connection ID is
    // required"), but the cache key is computed ahead of the provider: providerCacheKey length-frames
    // connection.id, and a missing id crashed there with a TypeError, which createErrorResponse turned
    // into a 500 INTERNAL_ERROR on query, health and multi-query. The refusal now happens first, as the
    // same DatabaseConfigError the provider would have raised, so no cache key and no fallback key for a
    // missing id.
    const conn = makeConnection("sqlite", { id: undefined as unknown as string, database: ":memory:" });
    await expect(getOrCreateProvider(conn)).rejects.toThrow("Connection ID is required");
    await expect(getOrCreateProvider(conn)).rejects.toBeInstanceOf(DatabaseConfigError);
    expect(getProviderCacheStats().size).toBe(0);
  });

  test("an execution-profile acquisition without an id is refused the same way (#1539)", async () => {
    const conn = makeConnection("sqlite", { id: undefined as unknown as string, database: ":memory:" });
    await expect(acquireExecutionProfileProvider(conn, "agent-operations")).rejects.toThrow(
      "Connection ID is required",
    );
    await expect(acquireExecutionProfileProvider(conn, "agent-operations")).rejects.toBeInstanceOf(DatabaseConfigError);
    expect(getExecutionProfileCacheStats().size).toBe(0);
  });
});

// ─── The cache key may not be a string the caller typed (GHSA-3wh2-8x78-jfw4) ──
//
// Reported privately 2026-09-20 and reproduced here before anything was changed.
//
// `getOrCreateProvider` keyed `providerCache` on `connection.id`, and that id arrives in the
// request body: `resolveConnection` (`src/lib/seed/resolve-connection.ts:22-24`) hands an inline
// `connection` back verbatim, id included, so any signed-in caller can name any id. Naming one
// another session already opened returned THAT session's live provider, still authenticated as
// them, without ever comparing the credentials the caller sent. A `seed:` id is an operator-chosen
// slug like `prod`, so it is guessable, and the role filter that guards the `connectionId` path
// is not on the inline one.
//
// `connection.id` was already known here to be caller-typed: `connectionFingerprint`'s docblock
// (`src/lib/db/connection-fingerprint.ts`) records the same measurement as its reason for NOT
// sealing a plan to the id. The provider cache was the other half of that lesson.
//
// These run on the real sqlite driver, against two real files. The victim's row is the whole
// assertion: reading it through the attacker's call is the vulnerability, and no bookkeeping
// count can stand in for it.

describe("a deadline in the connect (connection, never query)", () => {
  const CONNECT_SENTENCE =
    /^The connection got no answer after \d+(?:\.\d)? seconds?: check the address, the port, the network path and that the server is running\.$/;

  /** Every provider of the connection's class times out in connect() until the returned restore runs. */
  async function connectTimesOut(conn: DatabaseConnection): Promise<() => void> {
    const prototype = Object.getPrototypeOf(await createDatabaseProvider(conn)) as DatabaseProvider;
    const spy = spyOn(prototype, "connect").mockImplementation(async () => {
      throw new TimeoutError("The server did not answer within 60 s.", conn.type, 60000);
    });
    return () => spy.mockRestore();
  }

  test("getOrCreateProvider raises a ConnectionError with the connection's sentence and caches nothing", async () => {
    const conn = makeConnection("postgres", { id: "pg-connect-deadline" });
    const restore = await connectTimesOut(conn);
    try {
      const error = await getOrCreateProvider(conn).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConnectionError);
      expect(error).not.toBeInstanceOf(TimeoutError);
      expect((error as Error).message).toMatch(CONNECT_SENTENCE);
      expect(getProviderCacheStats().size).toBe(0);
    } finally {
      restore();
    }
  });

  test("acquireExecutionProfileProvider raises the same ConnectionError and caches nothing", async () => {
    const conn = makeConnection("postgres", { id: "pg-profile-connect-deadline" });
    const restore = await connectTimesOut(conn);
    try {
      const error = await acquireExecutionProfileProvider(conn, "agent-read-only").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConnectionError);
      expect((error as Error).message).toMatch(CONNECT_SENTENCE);
      expect(getExecutionProfileCacheStats().size).toBe(0);
    } finally {
      restore();
    }
  });
});

describe("getOrCreateProvider cache isolation", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "libredb-factory-hijack-"));
  });

  afterAll(async () => {
    await clearProviderCache();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The connection the victim opened: a real file holding one secret row. */
  async function openVictim(id: string): Promise<DatabaseProvider> {
    const victim = await getOrCreateProvider(
      makeConnection("sqlite", { id, database: join(dir, `${id.replace(/\W/g, "_")}-victim.db`) }),
    );
    await victim.query("CREATE TABLE customers (card TEXT)");
    await victim.query("INSERT INTO customers (card) VALUES ('4111-1111-1111-1111')");
    return victim;
  }

  test("a caller naming another session's connection id never reaches that session's provider", async () => {
    const victim = await openVictim("seed:prod");

    // The attacker's request: the victim's id, their own empty file, unrelated credentials.
    const attacker = await getOrCreateProvider(
      makeConnection("sqlite", {
        id: "seed:prod",
        database: join(dir, "attacker.db"),
        user: "attacker",
        password: "attacker",
      }),
    );

    expect(attacker).not.toBe(victim);
    // Their own file is empty, so the victim's table must not exist on it.
    await expect(attacker.query("SELECT card FROM customers")).rejects.toThrow();
  });

  test("the execution-profile cache is keyed the same way, not on the id alone", async () => {
    const victim = await getOrCreateProvider(
      makeConnection("sqlite", { id: "seed:agent", database: join(dir, "agent-victim.db") }),
    );
    await victim.query("CREATE TABLE customers (card TEXT)");
    await victim.query("INSERT INTO customers (card) VALUES ('4111-1111-1111-1111')");

    // The same forgery on the agent path: `profiledCacheKey` framed the id straight from the
    // request too, so an attacker naming it reached whatever that profile had already opened.
    const seeded = await acquireExecutionProfileProvider(
      makeConnection("sqlite", { id: "seed:agent", database: join(dir, "agent-victim.db") }),
      "agent-read-only",
    );
    // Give the attacker a real but unrelated database. The read-only profile opens sqlite
    // read-only and so cannot create one, and a provider that never opened would pass the
    // assertion below for the wrong reason - it must reach ITS OWN file and find no such table.
    const attackerFile = join(dir, "agent-attacker.db");
    const own = await getOrCreateProvider(makeConnection("sqlite", { id: "attacker-own", database: attackerFile }));
    await own.query("CREATE TABLE unrelated (x TEXT)");
    await removeProvider("attacker-own");

    const attacker = await acquireExecutionProfileProvider(
      makeConnection("sqlite", { id: "seed:agent", database: attackerFile, password: "wrong" }),
      "agent-read-only",
    );

    expect(attacker).not.toBe(seeded);
    // The control: the attacker's provider really is open and serving its own file.
    expect(await attacker.queryReadOnly!("SELECT x FROM unrelated", { ...AGENT_BUDGET })).toMatchObject({ rows: [] });
    await expect(attacker.queryReadOnly!("SELECT card FROM customers", { ...AGENT_BUDGET })).rejects.toThrow();
  });

  test("a caller naming another session's connection id cannot evict that session's provider", async () => {
    const victim = await openVictim("seed:reports");

    // Under the old key, a differing queryTimeout disconnected and deleted the entry the
    // victim was using: denial of service on the same forgeable id.
    await getOrCreateProvider(
      makeConnection("sqlite", {
        id: "seed:reports",
        database: join(dir, "reports-attacker.db"),
        queryTimeout: 1_234,
      }),
    );

    expect(victim.isConnected()).toBe(true);
    const rows = await victim.query("SELECT card FROM customers");
    expect(rows.rows).toHaveLength(1);
  });

  test("two connections that differ only in their SASL mechanism are never handed one provider", async () => {
    // Kafka keeps a SCRAM credential per mechanism, so the mechanism decides which stored secret
    // the broker checks the password against: it changes who a connection authenticates as, and
    // `credentialDigest` frames it. The field is inert on sqlite, which is what lets the real
    // driver stand in here: only the cache key can tell these records apart.
    const database = join(dir, "sasl-mechanism.db");
    const record = (saslMechanism: DatabaseConnection["saslMechanism"]) =>
      makeConnection("sqlite", { id: "seed:events", database, user: "reader", password: "same", saslMechanism });

    const none = await getOrCreateProvider(record(undefined));
    const sha256 = await getOrCreateProvider(record("SCRAM-SHA-256"));
    const sha512 = await getOrCreateProvider(record("SCRAM-SHA-512"));

    expect(new Set([none, sha256, sha512]).size).toBe(3);
    // The control that the cache is still a cache: the same record asked for twice is one provider.
    expect(await getOrCreateProvider(record("SCRAM-SHA-512"))).toBe(sha512);
    expect(await getOrCreateProvider(record(undefined))).toBe(none);
  });

  test("two connections that differ only in their API key pair are never handed one provider", async () => {
    // An Elasticsearch connection sends `Authorization: ApiKey` built from the pair in preference to
    // its user and password, so the pair decides who it authenticates as, and `credentialDigest`
    // frames both halves. The fields are inert on sqlite, as the mechanism is above: only the cache
    // key can tell these records apart.
    const database = join(dir, "api-key-pair.db");
    const record = (pair: Pick<DatabaseConnection, "apiKeyId" | "apiKeySecret"> = {}) =>
      makeConnection("sqlite", { id: "seed:search", database, user: "reader", password: "same", ...pair });

    const none = await getOrCreateProvider(record());
    const paired = await getOrCreateProvider(record({ apiKeyId: "key-one", apiKeySecret: "secret-one" }));
    const otherId = await getOrCreateProvider(record({ apiKeyId: "key-two", apiKeySecret: "secret-one" }));
    const otherSecret = await getOrCreateProvider(record({ apiKeyId: "key-one", apiKeySecret: "secret-two" }));

    expect(new Set([none, paired, otherId, otherSecret]).size).toBe(4);
    // The control that the cache is still a cache: the same record asked for twice is one provider.
    expect(await getOrCreateProvider(record({ apiKeyId: "key-one", apiKeySecret: "secret-one" }))).toBe(paired);
    expect(await getOrCreateProvider(record())).toBe(none);
  });

  test("two connections that differ only in their MongoDB auth database are never handed one provider", async () => {
    // MongoDB looks the user up in `authSource`, so the same user and password under another auth
    // database are another principal's record, and `credentialDigest` frames it. Inert on sqlite,
    // like the two fields above: only the cache key can tell these records apart.
    const database = join(dir, "auth-source.db");
    const record = (authSource?: string) =>
      makeConnection("sqlite", {
        id: "seed:documents",
        database,
        user: "reader",
        password: "same",
        ...(authSource === undefined ? {} : { authSource }),
      });

    const none = await getOrCreateProvider(record());
    const admin = await getOrCreateProvider(record("admin"));
    const app = await getOrCreateProvider(record("app"));

    expect(new Set([none, admin, app]).size).toBe(3);
    // The control that the cache is still a cache: the same record asked for twice is one provider.
    expect(await getOrCreateProvider(record("app"))).toBe(app);
    expect(await getOrCreateProvider(record())).toBe(none);
  });

  test("readOnly: false and an absent readOnly are one mode, so they are handed one provider (#1089)", async () => {
    // The fourth part of the cache key is spelled `read-only` for `true` alone, so a record saved before
    // the mode existed and one that says `false` share a pool. The other half, `true` sharing none, is
    // held at the key in tests/unit/lib/db/provider-cache-key.test.ts, because on this engine the factory
    // refuses `readOnly: true` before the cache is consulted at all.
    const database = join(dir, "read-write-mode.db");
    const record = (overrides: Partial<DatabaseConnection> = {}) =>
      makeConnection("sqlite", { id: "seed:mode", database, ...overrides });

    const absent = await getOrCreateProvider(record());
    expect(await getOrCreateProvider(record({ readOnly: false }))).toBe(absent);
  });
});

// ─── Per-user providers (docs/GOVERNANCE.md#per-user-providers) ──────────────
//
// Under governance every user of a connection gets a provider of their own: the execution context
// names the session's identity provider subject as `owner`, the cache key frames it, and the provider
// opens a pool of the user's own share, `ownerPoolMax`. A context without an owner is what every
// install without governance passes, and the tests above pin that nothing about it changed.

describe("per-user providers", () => {
  const owned = (owner: string, ownerPoolMax = 3): EditorExecutionContext => ({ owner, ownerPoolMax });

  test("two owners resolving one connection get two provider instances", async () => {
    const conn = makeConnection("postgres", { id: "seed:orders" });

    const alice = await getOrCreateProvider(conn, {}, owned("alice-subject"));
    const bob = await getOrCreateProvider(conn, {}, owned("bob-subject"));

    expect(bob).not.toBe(alice);
    // The control that the cache is still a cache: the same owner asking again gets its own provider back.
    expect(await getOrCreateProvider(conn, {}, owned("alice-subject"))).toBe(alice);
    // And a caller that names no owner gets the provider every such caller shares, apart from both.
    const shared = await getOrCreateProvider(conn);
    expect(new Set([alice, bob, shared]).size).toBe(3);
    expect(getProviderCacheStats()).toEqual({ size: 3, connections: ["seed:orders", "seed:orders", "seed:orders"] });
  });

  test("an owned provider is created with pool min 0 and max ownerPoolMax", async () => {
    pgPoolConfigs.length = 0;

    await getOrCreateProvider(makeConnection("postgres", { id: "seed:owned-pool" }), {}, owned("alice-subject", 3));
    // A caller's own pool options stand, except the size: min and max are the owner's share.
    await getOrCreateProvider(
      makeConnection("postgres", { id: "seed:owned-pool-options" }),
      { pool: { min: 4, max: 50, idleTimeout: 5_000 } },
      owned("alice-subject", 2),
    );
    // Without an owner the pool is the one every provider opened before owners existed.
    await getOrCreateProvider(makeConnection("postgres", { id: "seed:shared-pool" }));

    expect(pgPoolConfigs.map(({ min, max, idleTimeoutMillis }) => ({ min, max, idleTimeoutMillis }))).toEqual([
      { min: 0, max: 3, idleTimeoutMillis: 30_000 },
      { min: 0, max: 2, idleTimeoutMillis: 5_000 },
      { min: 2, max: 10, idleTimeoutMillis: 30_000 },
    ]);
  });

  test("an owner's execution-profile acquisitions are its own too, opened with the owner's pool", async () => {
    const conn = makeConnection("postgres", { id: "seed:orders-agent" });
    pgPoolConfigs.length = 0;

    const alice = await acquireExecutionProfileProvider(conn, "agent-read-only", {}, owned("alice-subject"));
    const bob = await acquireExecutionProfileProvider(conn, "agent-read-only", {}, owned("bob-subject"));

    expect(bob).not.toBe(alice);
    expect(await acquireExecutionProfileProvider(conn, "agent-read-only", {}, owned("alice-subject"))).toBe(alice);
    expect(pgPoolConfigs.map(({ min, max }) => ({ min, max }))).toEqual([
      { min: 0, max: 3 },
      { min: 0, max: 3 },
    ]);
    // The profiled key is the writable key with the profile framed onto it, so the owner is its last part as well.
    expect(await profiledCacheKey(conn, "agent-read-only", owned("alice-subject"))).toBe(
      `${await profiledCacheKey(conn, "agent-read-only")}19:owner:alice-subject`,
    );
  });

  test.each([undefined, 0, -1, 2.5, Number.NaN, "3"])(
    "an owner with ownerPoolMax %p is refused before anything is built or dialled",
    async (ownerPoolMax) => {
      // A pool size pg cannot honour would be replaced or wedged silently: 0 and NaN open its default of 10, and a
      // negative size never hands out a connection. So an owner states a whole size from 1, or nothing is opened.
      const conn = makeConnection("postgres", {
        id: "seed:owned-bad-pool",
        sshTunnel: {
          enabled: true,
          host: "bastion.example.com",
          port: 22,
          username: "admin",
          authMethod: "password",
          password: "secret",
        },
      });
      const execution = { owner: "alice-subject", ownerPoolMax } as EditorExecutionContext;

      const refusals = await Promise.all([
        getOrCreateProvider(conn, {}, execution).catch((error: unknown) => error),
        acquireExecutionProfileProvider(conn, "agent-read-only", {}, execution).catch((error: unknown) => error),
        createDatabaseProvider(conn, {}, execution).catch((error: unknown) => error),
      ]);

      for (const refusal of refusals) {
        expect(refusal).toBeInstanceOf(DatabaseConfigError);
        expect((refusal as Error).message).toContain("ownerPoolMax");
      }
      expect(mockCreateSSHTunnel).not.toHaveBeenCalled();
      expect(getProviderCacheStats().size).toBe(0);
      expect(getExecutionProfileCacheStats().size).toBe(0);
    },
  );
});

// ─── The writable cache's key and lookup, for the transaction route (docs/GOVERNANCE.md#per-user-providers) ───

describe("editorCacheKey and findCachedProvider", () => {
  const owned = (owner: string): EditorExecutionContext => ({ owner, ownerPoolMax: 3 });

  test("editorCacheKey is the key getOrCreateProvider caches under, and findCachedProvider answers what is cached there", async () => {
    // The transaction route records the key a governed begin resolved and later looks the provider up by it, to roll
    // back a transaction whose credential changed; both only work if this key is the one the provider is cached under.
    const writer = makeConnection("postgres", { id: "seed:orders", user: "writer", password: "write-secret" });
    const reader = makeConnection("postgres", { id: "seed:orders", user: "reader", password: "read-secret" });

    const provider = await getOrCreateProvider(writer, {}, owned("alice-subject"));

    expect(findCachedProvider(await editorCacheKey(writer, owned("alice-subject")))).toBe(provider);
    // Another credential, another owner, or no owner at all names another key, under which nothing is cached.
    expect(findCachedProvider(await editorCacheKey(reader, owned("alice-subject")))).toBeNull();
    expect(findCachedProvider(await editorCacheKey(writer, owned("bob-subject")))).toBeNull();
    expect(findCachedProvider(await editorCacheKey(writer))).toBeNull();
    // A lookup opens nothing.
    expect(getProviderCacheStats().size).toBe(1);
  });

  test("editorCacheKey refuses a connection without an id, as getOrCreateProvider does", async () => {
    const refusal = await editorCacheKey(makeConnection("postgres", { id: "" }), owned("alice-subject")).catch(
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(DatabaseConfigError);
    expect((refusal as Error).message).toBe("Connection ID is required");
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

// ─── removeProvider with an owner scope (docs/GOVERNANCE.md#per-user-providers) ───
//
// Under governance one user's disconnect must not tear down another user's providers, so the disconnect route names
// the caller as the owner and only that owner's entries go. The SSH tunnel is shared by every entry of a connection,
// so a scoped removal closes it only once nothing serves the connection, as the idle sweep does. The unscoped removal
// above is what every install without governance calls, and it is unchanged.

describe("removeProvider with an owner scope", () => {
  const owned = (owner: string): EditorExecutionContext => ({ owner, ownerPoolMax: 3 });
  const TUNNEL: SSHTunnelConfig = {
    enabled: true,
    host: "bastion.example.com",
    port: 22,
    username: "tunnel",
    authMethod: "password",
    password: "example-only-tunnel-password",
  };

  test("removeProvider with an owner scope removes only that owner's entries", async () => {
    const conn = makeConnection("postgres", { id: "seed:orders", sshTunnel: TUNNEL });
    const alice = await getOrCreateProvider(conn, {}, owned("alice-subject"));
    const aliceAgent = await acquireExecutionProfileProvider(conn, "agent-read-only", {}, owned("alice-subject"));
    const bob = await getOrCreateProvider(conn, {}, owned("bob-subject"));
    const bobAgent = await acquireExecutionProfileProvider(conn, "agent-read-only", {}, owned("bob-subject"));
    const shared = await getOrCreateProvider(conn);
    const bobBilling = await getOrCreateProvider(
      makeConnection("postgres", { id: "seed:billing" }),
      {},
      owned("bob-subject"),
    );

    await removeProvider("seed:orders", { owner: "bob-subject" });

    // Bob's providers of the connection are gone, his editor provider and his profiled one alike.
    expect([bob.isConnected(), bobAgent.isConnected()]).toEqual([false, false]);
    // Alice's, the one every caller without an owner shares, and Bob's provider of another connection stay open.
    expect([alice.isConnected(), aliceAgent.isConnected(), shared.isConnected(), bobBilling.isConnected()]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(getProviderCacheStats().connections.sort()).toEqual(["seed:billing", "seed:orders", "seed:orders"]);
    expect(getExecutionProfileCacheStats()).toEqual({ size: 1, connections: ["seed:orders"] });
    // Alice is served her own provider again rather than a new one, so nothing of hers was reopened.
    expect(await getOrCreateProvider(conn, {}, owned("alice-subject"))).toBe(alice);
    // The tunnel still serves Alice and the shared entry.
    expect(mockCloseSSHTunnel).not.toHaveBeenCalled();
  });

  test("an owner scope closes the connection's SSH tunnel only once no entry serves the connection", async () => {
    const conn = makeConnection("postgres", { id: "seed:orders", sshTunnel: TUNNEL });
    await getOrCreateProvider(conn, {}, owned("alice-subject"));
    await acquireExecutionProfileProvider(conn, "agent-read-only", {}, owned("bob-subject"));

    // Bob's profiled entry still reaches the connection through the tunnel.
    await removeProvider("seed:orders", { owner: "alice-subject" });
    expect(mockCloseSSHTunnel).not.toHaveBeenCalled();

    // Bob's removal takes the last entry, so the tunnel goes with it, and a failing close is logged, not thrown.
    mockCloseSSHTunnel.mockImplementationOnce(async () => {
      throw new Error("tunnel close failed");
    });
    await removeProvider("seed:orders", { owner: "bob-subject" });
    expect(mockCloseSSHTunnel).toHaveBeenCalledTimes(1);
    expect(mockCloseSSHTunnel).toHaveBeenCalledWith("seed:orders");
    expect(getProviderCacheStats().size).toBe(0);
    expect(getExecutionProfileCacheStats().size).toBe(0);
  });

  test("an owner scope leaves the one handle of a single-writer file, which every owner shares", async () => {
    // A provider per user on such an engine would be a second handle on one file, so the factory opens one handle for
    // every owner and records no owner on it (`providerOwner`): one user's disconnect must not close it under the rest.
    const dir = mkdtempSync(join(tmpdir(), "libredb-factory-owner-scope-"));
    try {
      const conn = makeConnection("libredb", { id: "seed:local", database: join(dir, "shared.libredb") });
      const handle = await getOrCreateProvider(conn, {}, owned("alice-subject"));

      await removeProvider("seed:local", { owner: "alice-subject" });

      expect(handle.isConnected()).toBe(true);
      expect(await getOrCreateProvider(conn, {}, owned("bob-subject"))).toBe(handle);
    } finally {
      await clearProviderCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["{}", {}],
    ["{ owner: undefined }", { owner: undefined }],
    ["{ owner: 7 }", { owner: 7 }],
  ])("a scope without an owner string, %s, is refused before anything is removed", async (_label, scope) => {
    // Matching on a missing owner would remove the entries every caller shares, which is not what a scope promises.
    const conn = makeConnection("postgres", { id: "seed:orders" });
    const alice = await getOrCreateProvider(conn, {}, owned("alice-subject"));
    const shared = await getOrCreateProvider(conn);

    const refusal: unknown = await removeProvider("seed:orders", scope as { owner: string }).catch(
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(DatabaseConfigError);
    expect((refusal as Error).message).toContain("owner");
    expect([alice.isConnected(), shared.isConnected()]).toEqual([true, true]);
    expect(mockCloseSSHTunnel).not.toHaveBeenCalled();
  });
});

// ─── removeProvider with a key scope (docs/SECURITY.md, note 0.9) ────────────
//
// Without governance every caller of a connection shares its provider, so a disconnect cannot be scoped by owner. The
// disconnect route resolves the caller's own record instead and removes only the entries that record's key names
// (`editorCacheKey`): its editor entry, and its execution-profile entries, which are cached under the same key with the
// profile framed onto it. The key frames the server and the credentials, so naming another user's connection id closes
// nothing of theirs. The SSH tunnel serves every entry of the connection, so it closes only once nothing serves it.

describe("removeProvider with a key scope", () => {
  const TUNNEL: SSHTunnelConfig = {
    enabled: true,
    host: "bastion.example.com",
    port: 22,
    username: "tunnel",
    authMethod: "password",
    password: "example-only-tunnel-password",
  };

  test("removeProvider with a key scope removes only the entry its key names", async () => {
    const alice = makeConnection("postgres", { id: "conn-orders", user: "alice", password: "a-pw", sshTunnel: TUNNEL });
    const bob = makeConnection("postgres", { id: "conn-orders", user: "bob", password: "b-pw", sshTunnel: TUNNEL });
    const billing = makeConnection("postgres", { id: "conn-billing", user: "bob", password: "b-pw" });
    const alicesProvider = await getOrCreateProvider(alice);
    const bobsProvider = await getOrCreateProvider(bob);
    const billingProvider = await getOrCreateProvider(billing);

    await removeProvider("conn-orders", { key: await editorCacheKey(bob) });

    expect(bobsProvider.isConnected()).toBe(false);
    expect([alicesProvider.isConnected(), billingProvider.isConnected()]).toEqual([true, true]);
    // Alice is served her own provider again rather than a new one, and her entry keeps the tunnel open.
    expect(await getOrCreateProvider(alice)).toBe(alicesProvider);
    expect(mockCloseSSHTunnel).not.toHaveBeenCalled();

    // A key names an entry of one connection only: under another connection's id it removes nothing.
    await removeProvider("conn-billing", { key: await editorCacheKey(alice) });
    expect([alicesProvider.isConnected(), billingProvider.isConnected()]).toEqual([true, true]);

    // Alice's own key takes the last entry of the connection, so the tunnel goes with it.
    await removeProvider("conn-orders", { key: await editorCacheKey(alice) });
    expect(alicesProvider.isConnected()).toBe(false);
    expect(mockCloseSSHTunnel).toHaveBeenCalledTimes(1);
    expect(mockCloseSSHTunnel).toHaveBeenCalledWith("conn-orders");
    expect(getProviderCacheStats().connections).toEqual(["conn-billing"]);
  });

  test("a key scope removes the profiled entries of the record its key names, and nothing of another record's", async () => {
    // An execution profile caches a record's provider under that record's editor key with the profile framed onto it
    // (`profiledCacheKey`). A removal by the key must take those entries too, or they and the tunnel they reach the
    // connection through stay open until the idle sweep.
    const alice = makeConnection("postgres", { id: "conn-orders", user: "alice", password: "a-pw", sshTunnel: TUNNEL });
    const bob = makeConnection("postgres", { id: "conn-orders", user: "bob", password: "b-pw", sshTunnel: TUNNEL });
    const alicesEditor = await getOrCreateProvider(alice);
    const alicesAgents = [
      await acquireExecutionProfileProvider(alice, "agent-read-only"),
      await acquireExecutionProfileProvider(alice, "agent-operations"),
      await acquireExecutionProfileProvider(alice, "agent-handover"),
    ];
    const bobsEditor = await getOrCreateProvider(bob);
    const bobsAgent = await acquireExecutionProfileProvider(bob, "agent-read-only");

    await removeProvider("conn-orders", { key: await editorCacheKey(alice) });

    // Alice's editor entry goes, and so does her entry under every profile.
    expect([alicesEditor, ...alicesAgents].map((provider) => provider.isConnected())).toEqual([
      false,
      false,
      false,
      false,
    ]);
    // Bob's record names other keys, so his editor and profiled entries stay, and the tunnel they share stays open.
    expect([bobsEditor.isConnected(), bobsAgent.isConnected()]).toEqual([true, true]);
    expect(getProviderCacheStats()).toEqual({ size: 1, connections: ["conn-orders"] });
    expect(getExecutionProfileCacheStats()).toEqual({ size: 1, connections: ["conn-orders"] });
    expect(mockCloseSSHTunnel).not.toHaveBeenCalled();

    // Bob's key takes the last entries of the connection, his profiled one included, so the tunnel closes with them.
    await removeProvider("conn-orders", { key: await editorCacheKey(bob) });
    expect([bobsEditor.isConnected(), bobsAgent.isConnected()]).toEqual([false, false]);
    expect(getProviderCacheStats().size).toBe(0);
    expect(getExecutionProfileCacheStats().size).toBe(0);
    expect(mockCloseSSHTunnel).toHaveBeenCalledTimes(1);
    expect(mockCloseSSHTunnel).toHaveBeenCalledWith("conn-orders");
  });

  test.each([
    ["{ key: 7 }", { key: 7 }],
    ["an owner and a key", { owner: "alice-subject", key: "conn-orders" }],
  ])(
    "a scope that names no single owner or key string, %s, is refused before anything is removed",
    async (_label, scope) => {
      const conn = makeConnection("postgres", { id: "conn-orders" });
      const provider = await getOrCreateProvider(conn);

      const refusal: unknown = await removeProvider("conn-orders", scope as { key: string }).catch(
        (error: unknown) => error,
      );

      expect(refusal).toBeInstanceOf(DatabaseConfigError);
      expect((refusal as Error).message).toContain("key");
      expect(provider.isConnected()).toBe(true);
      expect(mockCloseSSHTunnel).not.toHaveBeenCalled();
    },
  );
});

// ─── Teardown of an owned provider (docs/GOVERNANCE.md#per-user-providers) ───
//
// When a reload of the governance snapshot takes a grant away or changes it, the loader removes that subject's
// providers of the connection (src/lib/governance/snapshot.ts), and an owned provider is torn down rather than only
// disconnected: its cache entry goes first, so no request is handed it on the way out, an open transaction is rolled
// back within 5 s, and the disconnect is waited for at most 10 s before the pool is abandoned with a log line, because
// pg's `end()` waits for every checked-out client and a client stuck in a statement never comes back. A provider every
// caller shares keeps the path the tests above pin.

describe("teardown of an owned provider", () => {
  const owned = (owner: string): EditorExecutionContext => ({ owner, ownerPoolMax: 3 });
  /** Lets every pending promise settle: bun's fake timers leave setImmediate real. */
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const hangs = (): Promise<void> => new Promise<void>(() => {});
  let warn: ReturnType<typeof spyOn>;
  let info: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    info = spyOn(logger, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    warn.mockRestore();
    info.mockRestore();
  });

  /**
   * Gives `provider` an open transaction, as a transaction provider holds one, whose rollback records in `events` how
   * many providers the writable cache still held when it ran, and then runs `rollback`.
   */
  function openTransaction(
    provider: DatabaseProvider,
    events: string[],
    rollback: () => Promise<void> = async () => {},
  ): void {
    let open = true;
    Object.assign(provider, {
      isInTransaction: () => open,
      rollbackTransaction: async () => {
        events.push(`rollback, ${getProviderCacheStats().size} cached`);
        await rollback();
        open = false;
      },
    });
  }

  /** Makes `provider`'s disconnect record the same in `events`, then run `disconnect`. */
  function recordDisconnect(
    provider: DatabaseProvider,
    events: string[],
    disconnect: () => Promise<void> = async () => {},
  ): void {
    provider.disconnect = async () => {
      events.push(`disconnect, ${getProviderCacheStats().size} cached`);
      await disconnect();
    };
  }

  /** The first argument of every call `spy` saw, which is the line each log call writes. */
  const lines = (spy: ReturnType<typeof spyOn>): string[] => spy.mock.calls.map((call: unknown[]) => String(call[0]));

  test("teardown of an owned provider in a transaction rolls back, removes the entry before disconnecting, and returns within 15 s when disconnect hangs", async () => {
    const conn = makeConnection("postgres", { id: "seed:orders" });
    const provider = await getOrCreateProvider(conn, {}, owned("alice-subject"));
    const events: string[] = [];
    openTransaction(provider, events);
    recordDisconnect(provider, events, hangs);
    jest.useFakeTimers();

    let returned = false;
    const removal = removeProvider("seed:orders", { owner: "alice-subject" }).then(() => {
      returned = true;
    });
    await settle();

    // The entry went first, so neither the rollback nor the disconnect ran on a provider a request could still be
    // handed, and the transaction was rolled back before the provider was closed.
    expect(events).toEqual(["rollback, 0 cached", "disconnect, 0 cached"]);
    expect(lines(info)).toContain(
      "[DB] Rolled back the open transaction of an owned provider of seed:orders before closing it.",
    );
    // The disconnect never answers: it is waited for 10 s, so the teardown ends within the 15 s a rollback and a
    // disconnect may take together, and the pool is abandoned with a line that says so.
    jest.advanceTimersByTime(9_999);
    await settle();
    expect(returned).toBe(false);
    jest.advanceTimersByTime(1);
    await removal;
    expect(lines(warn)).toEqual([
      "[DB] Abandoned the pool of owned provider seed:orders: its disconnect did not finish within 10000 ms.",
    ]);
    expect(getProviderCacheStats().size).toBe(0);
  });

  test("a rollback that does not finish within 5 s is given up, the provider is still disconnected, and the teardown ends by 15 s", async () => {
    const provider = await getOrCreateProvider(
      makeConnection("postgres", { id: "seed:orders" }),
      {},
      owned("alice-subject"),
    );
    const events: string[] = [];
    openTransaction(provider, events, hangs);
    recordDisconnect(provider, events, hangs);
    jest.useFakeTimers();

    let returned = false;
    const removal = removeProvider("seed:orders", { owner: "alice-subject" }).then(() => {
      returned = true;
    });
    await settle();
    expect(events).toEqual(["rollback, 0 cached"]);

    jest.advanceTimersByTime(5_000);
    await settle();
    expect(events).toEqual(["rollback, 0 cached", "disconnect, 0 cached"]);
    jest.advanceTimersByTime(9_999);
    await settle();
    expect(returned).toBe(false);
    jest.advanceTimersByTime(1);
    await removal;
    expect(lines(warn)).toEqual([
      "[DB] The open transaction of an owned provider of seed:orders did not roll back within 5000 ms, so the provider is closed with it open.",
      "[DB] Abandoned the pool of owned provider seed:orders: its disconnect did not finish within 10000 ms.",
    ]);
  });

  test("a rollback that fails is logged, and the provider is still disconnected", async () => {
    const provider = await getOrCreateProvider(
      makeConnection("postgres", { id: "seed:orders" }),
      {},
      owned("alice-subject"),
    );
    const events: string[] = [];
    openTransaction(provider, events, async () => {
      throw new Error("Connection terminated unexpectedly");
    });
    recordDisconnect(provider, events);

    await removeProvider("seed:orders", { owner: "alice-subject" });

    expect(events).toEqual(["rollback, 0 cached", "disconnect, 0 cached"]);
    expect(warn.mock.calls).toEqual([
      [
        "[DB] The open transaction of an owned provider of seed:orders failed to roll back, so the provider is closed with it open.",
        { connectionId: "seed:orders", error: "Error: Connection terminated unexpectedly" },
      ],
    ]);
  });

  test("a provider whose transaction state throws is logged as a failed rollback and still disconnected", async () => {
    // The provider's defect, as a throwing hasRunsInFlight is for the idle sweep: it must not leave the provider open.
    const provider = await getOrCreateProvider(
      makeConnection("postgres", { id: "seed:orders" }),
      {},
      owned("alice-subject"),
    );
    const events: string[] = [];
    openTransaction(provider, events);
    Object.assign(provider, {
      isInTransaction: () => {
        throw new Error("transaction state unreadable");
      },
    });
    recordDisconnect(provider, events);

    await removeProvider("seed:orders", { owner: "alice-subject" });

    expect(events).toEqual(["disconnect, 0 cached"]);
    expect(lines(warn)).toEqual([
      "[DB] The open transaction of an owned provider of seed:orders failed to roll back, so the provider is closed with it open.",
    ]);
  });

  test("an owned provider without an open transaction, or without a transaction session at all, is only disconnected, and a failing disconnect is logged", async () => {
    const postgres = await getOrCreateProvider(
      makeConnection("postgres", { id: "seed:orders" }),
      {},
      owned("alice-subject"),
    );
    const redis = await getOrCreateProvider(
      makeConnection("redis", { id: "seed:orders", port: 6379, database: "0" }),
      {},
      owned("alice-subject"),
    );
    const events: string[] = [];
    openTransaction(postgres, events);
    Object.assign(postgres, { isInTransaction: () => false });
    recordDisconnect(postgres, events, async () => {
      throw new Error("pool already ended");
    });
    expect("rollbackTransaction" in redis).toBe(false);
    recordDisconnect(redis, events);

    await removeProvider("seed:orders", { owner: "alice-subject" });

    // Each left the cache just before its own disconnect: the Redis entry was still there at the first one.
    expect(events).toEqual(["disconnect, 1 cached", "disconnect, 0 cached"]);
    expect(warn.mock.calls).toEqual([
      [
        "[DB] Error disconnecting owned provider seed:orders",
        { connectionId: "seed:orders", error: "Error: pool already ended" },
      ],
    ]);
    expect(lines(info).some((line) => line.includes("Rolled back"))).toBe(false);
  });

  test("an owner's profiled provider is torn down with its editor provider, and the shared provider keeps today's path", async () => {
    const conn = makeConnection("postgres", { id: "seed:orders" });
    const editor = await getOrCreateProvider(conn, {}, owned("alice-subject"));
    const agent = await acquireExecutionProfileProvider(conn, "agent-read-only", {}, owned("alice-subject"));
    const shared = await getOrCreateProvider(conn);
    const events: string[] = [];
    openTransaction(editor, events);
    recordDisconnect(editor, events);
    agent.disconnect = async () => {
      events.push(`agent disconnect, ${getExecutionProfileCacheStats().size} profiled`);
    };
    // Without a scope every entry of the connection goes: the shared one is disconnected while it is still cached,
    // as before owners existed, and the owned ones are torn down.
    shared.disconnect = async () => {
      events.push(`shared disconnect, ${getProviderCacheStats().size} cached`);
    };

    await removeProvider("seed:orders");

    // The owned editor entry was deleted before its rollback, while the shared one was still cached when it was
    // disconnected. The owned teardown runs beside the shared disconnect, so only its own order is pinned.
    expect(events).toContain("rollback, 1 cached");
    expect(events).toContain("shared disconnect, 1 cached");
    expect(events).toContain("agent disconnect, 0 profiled");
    expect(events.indexOf("rollback, 1 cached")).toBeLessThan(
      events.findIndex((event) => event.startsWith("disconnect")),
    );
    expect(events).toHaveLength(4);
    expect(getProviderCacheStats().size).toBe(0);
    expect(getExecutionProfileCacheStats().size).toBe(0);
    expect(mockCloseSSHTunnel).toHaveBeenCalledWith("seed:orders");
  });

  test("the idle sweep tears down an idle owned provider, rolling back its open transaction, and evicts a shared one as before", async () => {
    const conn = makeConnection("postgres", { id: "seed:orders" });
    const editor = await getOrCreateProvider(conn, {}, owned("alice-subject"));
    const agent = await acquireExecutionProfileProvider(conn, "agent-read-only", {}, owned("alice-subject"));
    const shared = await getOrCreateProvider(makeConnection("sqlite", { id: "idle-shared", database: ":memory:" }));
    const events: string[] = [];
    openTransaction(editor, events);
    recordDisconnect(editor, events);
    openTransaction(agent, events);
    agent.disconnect = async () => {
      events.push(`agent disconnect, ${getExecutionProfileCacheStats().size} profiled`);
    };
    shared.disconnect = async () => {
      events.push(`shared disconnect, ${getProviderCacheStats().size} cached`);
    };

    expect(await evictIdleProviders(0)).toBe(3);

    // The shared entry is disconnected first and deleted after, as the sweep always did; each owned entry is deleted
    // before its transaction is rolled back and it is disconnected.
    expect(events).toEqual([
      "rollback, 1 cached",
      "disconnect, 1 cached",
      "shared disconnect, 1 cached",
      "rollback, 0 cached",
      "agent disconnect, 0 profiled",
    ]);
    expect(getProviderCacheStats().size).toBe(0);
    expect(getExecutionProfileCacheStats().size).toBe(0);
    expect(mockCloseSSHTunnel).toHaveBeenCalledWith("seed:orders");
  });

  test("clearProviderCache tears down every owned provider, rolling back an open transaction, beside the shared ones", async () => {
    const conn = makeConnection("postgres", { id: "seed:orders" });
    const editor = await getOrCreateProvider(conn, {}, owned("alice-subject"));
    const agent = await acquireExecutionProfileProvider(conn, "agent-read-only", {}, owned("bob-subject"));
    const shared = await getOrCreateProvider(conn);
    const events: string[] = [];
    openTransaction(editor, events);
    recordDisconnect(editor, events);
    agent.disconnect = async () => {
      events.push("agent disconnect");
    };
    shared.disconnect = async () => {
      events.push("shared disconnect");
    };

    await clearProviderCache();

    expect(events.sort()).toEqual([
      "agent disconnect",
      "disconnect, 1 cached",
      "rollback, 1 cached",
      "shared disconnect",
    ]);
    expect(getProviderCacheStats().size).toBe(0);
    expect(getExecutionProfileCacheStats().size).toBe(0);
  });

  test("the factory registers its owner-scoped removal, so the governance loader reaches this cache from another bundle", async () => {
    const conn = makeConnection("postgres", { id: "seed:orders" });
    const alice = await getOrCreateProvider(conn, {}, owned("alice-subject"));
    const bob = await getOrCreateProvider(conn, {}, owned("bob-subject"));

    await removeOwnerProviders("seed:orders", "bob-subject");

    expect([alice.isConnected(), bob.isConnected()]).toEqual([true, false]);
    expect(getProviderCacheStats()).toEqual({ size: 1, connections: ["seed:orders"] });
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

  /*
   * `connection.id` is a string the caller typed - that is this file's other security group and
   * the whole of GHSA-3wh2-8x78-jfw4 - so every log line that INTERPOLATES one is a place a
   * caller writes into the log. A newline forges a whole entry; `createDatabaseProvider` has
   * sanitized `type` and `name` for that reason since long before this.
   */
  test("a connection id cannot forge a log line when a disconnect rejects", async () => {
    const forged = 'evil%s\n[DB] Creating admin provider for "prod"';
    const provider = await getOrCreateProvider(makeConnection("sqlite", { id: forged, database: ":memory:" }));
    provider.disconnect = async () => {
      throw new Error("disconnect failed");
    };

    const calls: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void calls.push(args);
    try {
      await clearProviderCache();
    } finally {
      console.error = realError;
    }

    // The control: the line was written, and it named this connection.
    const mine = calls.filter((args) => args.some((arg) => String(arg).includes("evil")));
    expect(mine).toHaveLength(1);
    expect(mine.flat().every((arg) => !String(arg).includes("\n"))).toBe(true);

    /*
     * The id is an ARGUMENT, never part of the first one. `console.error`'s first argument is a
     * format string, so an id carrying `%s` would otherwise consume the error beside it - which
     * is what `js/tainted-format-string` names, and what stripping control characters does not
     * address. A constant first argument cannot be a format attack at all.
     */
    expect(String(mine[0]![0])).not.toContain("evil");
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

  test("an idle entry whose provider reports a run in flight is kept, then evicted once it reports none", async () => {
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      const provider = await getOrCreateProvider(makeConnection("sqlite", { id: "busy-a" }));
      let busy = true;
      const disconnect = spyOn(provider, "disconnect");
      Object.assign(provider, { hasRunsInFlight: () => busy });

      expect(await evictIdleProviders(0)).toBe(0);
      expect(getProviderCacheStats().size).toBe(1);
      expect(disconnect).not.toHaveBeenCalled();
      expect(mockCloseSSHTunnel).not.toHaveBeenCalledWith("busy-a");
      const kept = info.mock.calls
        .map((call) => call.join(" "))
        .filter((line) => line.includes("reports a run in flight"));
      expect(kept).toHaveLength(1);
      expect(kept[0]).toContain("busy-a");

      busy = false;
      expect(await evictIdleProviders(0)).toBe(1);
      expect(getProviderCacheStats().size).toBe(0);
      expect(mockCloseSSHTunnel).toHaveBeenCalledWith("busy-a");
    } finally {
      info.mockRestore();
    }
  });

  test("a fresh entry's hasRunsInFlight is never called", async () => {
    const provider = await getOrCreateProvider(makeConnection("sqlite", { id: "fresh-busy" }));
    const asked = mock(() => true);
    Object.assign(provider, { hasRunsInFlight: asked });
    expect(await evictIdleProviders(999_999_999)).toBe(0);
    expect(asked).not.toHaveBeenCalled();
  });

  test("of two idle entries whose first one's hasRunsInFlight throws, both are evicted and one error names the first", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = await getOrCreateProvider(makeConnection("sqlite", { id: "throws-a" }));
      await getOrCreateProvider(makeConnection("sqlite", { id: "plain-b" }));
      Object.assign(first, {
        hasRunsInFlight: () => {
          throw new Error("registry exploded");
        },
      });
      expect(await evictIdleProviders(0)).toBe(2);
      expect(getProviderCacheStats().size).toBe(0);
      const lines = error.mock.calls
        .map((call) => call.join(" "))
        .filter((line) => line.includes("hasRunsInFlight() threw"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("throws-a");
      expect(lines[0]).toContain("registry exploded");
    } finally {
      error.mockRestore();
    }
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

// ─── executionContextFor: what each profile opens its provider under (#1614) ──────

describe("executionContextFor", () => {
  test("all three profiles open read-only, and only the two that send statements say they do", () => {
    expect(executionContextFor("agent-read-only")).toEqual({
      readOnly: true,
      sendsStatements: true,
      allowExternalFileAccess: false,
    });
    expect(executionContextFor("agent-operations")).toEqual({
      readOnly: true,
      sendsStatements: false,
      allowExternalFileAccess: false,
    });
    expect(executionContextFor("agent-handover")).toEqual({
      readOnly: true,
      sendsStatements: true,
      allowExternalFileAccess: false,
    });
  });

  test("the file-access posture is the requester's, and an absent one reads as denied", () => {
    expect(executionContextFor("agent-read-only", { allowExternalFileAccess: true }).allowExternalFileAccess).toBe(
      true,
    );
    expect(executionContextFor("agent-operations", { allowExternalFileAccess: true }).allowExternalFileAccess).toBe(
      true,
    );
    expect(executionContextFor("agent-handover", { allowExternalFileAccess: false }).allowExternalFileAccess).toBe(
      false,
    );
    expect(executionContextFor("agent-read-only", {}).allowExternalFileAccess).toBe(false);
  });

  test("an unknown profile is refused rather than defaulted, an inherited property name included", () => {
    // A lookup that read `toString` or `constructor` off the table would answer a context with no `readOnly` in it,
    // which is the editor's writable reach under a profile's name.
    for (const profile of ["agent-read-write", "toString", "constructor", "__proto__"]) {
      let error: unknown = null;
      try {
        executionContextFor(profile as never);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ExecutionProfileError);
      expect((error as InstanceType<typeof ExecutionProfileError>).reasonCode).toBe("UNSUPPORTED_PROFILE");
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

  test("refuses a provider type without a read-only statement path", async () => {
    const error: unknown = await acquireExecutionProfileProvider(
      makeConnection("redis", { id: "redis-profile" }),
      "agent-read-only",
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as InstanceType<typeof ExecutionProfileError>).reasonCode).toBe("PROFILE_UNSUPPORTED_BY_PROVIDER");
    // The rule is the method, not the kind of boundary behind it: Kubernetes and MongoDB are granted the profile with
    // no database read-only session.
    expect((error as Error).message).toBe(
      'Provider type "redis" implements no read-only statement path (queryReadOnly)',
    );
    expect(getExecutionProfileCacheStats().size).toBe(0);
  });

  test("refuses firestore the agent's read-only profile, the gate the explain-analyze descriptor's capability check is not", async () => {
    // `sql.explain.analyze` requires only `supportsExplain`, which Firestore declares for the editor's Explain button
    // (Firestore spec 5.7), so the refusal of a plan execution on Firestore is this profile gate: no `queryReadOnly`.
    expect(sqlExplainAnalyzeDescriptor.requiredCapabilities).toEqual(["supportsExplain"]);
    const error: unknown = await acquireExecutionProfileProvider(
      makeConnection("firestore", {
        id: "firestore-profile",
        host: undefined,
        port: undefined,
        password: undefined,
        database: "demo-studio",
      }),
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
    // A Redis database is a number: the shared fixture's "testdb" is refused at connect.
    const connection = makeConnection("redis", { id: "redis-operations", database: "0" });

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

  test("opens each profile's provider under its own context, and only a statement-sending one is told it sends statements", async () => {
    // A provider that proves its statement boundary at open (MongoDB) keys that proof on the flag, so the flag
    // has to arrive in the context the provider is built with: all three profiles carry `readOnly`, so a proof
    // read off it would refuse the operations profile, which sends no statement. The spy constructs the real
    // class, so it records the argument and changes nothing else about the open.
    const postgres = await import("@/lib/db/providers/sql/postgres");
    const RealProvider = postgres.PostgresProvider;
    // bun types a spied class as `Mock<never>`, since a class has no call signature, hence the cast.
    const constructed = spyOn(postgres, "PostgresProvider").mockImplementation(function (
      ...args: ConstructorParameters<typeof RealProvider>
    ) {
      return new RealProvider(...args);
    } as never);
    try {
      const operations = await acquireExecutionProfileProvider(pgConn(), "agent-operations");
      const readOnly = await acquireExecutionProfileProvider(pgConn(), "agent-read-only");
      const handover = await acquireExecutionProfileProvider(pgConn(), "agent-handover");

      expect(constructed.mock.calls.map((call) => (call as unknown[])[2])).toEqual([
        { readOnly: true, sendsStatements: false, allowExternalFileAccess: false },
        { readOnly: true, sendsStatements: true, allowExternalFileAccess: false },
        { readOnly: true, sendsStatements: true, allowExternalFileAccess: false },
      ]);
      // The profile is framed into the profiled cache key and decides the flag, so a provider opened without the
      // proof a statement needs is never the one a statement-sending profile is handed.
      expect(readOnly).not.toBe(operations);
      expect(handover).not.toBe(operations);
      expect(getExecutionProfileCacheStats().size).toBe(3);
    } finally {
      constructed.mockRestore();
    }
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
    expect((error as Error).message).toBe(
      'Connection "pg-password-only" configures an incomplete agent credential (user and password are both required)',
    );
    expect(getExecutionProfileCacheStats().size).toBe(0);
  });

  /**
   * An engine declaring `agentCredential: "token"` takes `agentPassword` alone as the agent's own bearer token.
   * Kubernetes' connect dials the API server, so its prototype's connect is stubbed for these tests only.
   */
  async function kubernetesConnectStubbed(conn: DatabaseConnection): Promise<() => void> {
    const prototype = Object.getPrototypeOf(await createDatabaseProvider(conn)) as DatabaseProvider;
    const spy = spyOn(prototype, "connect").mockImplementation(async function (this: DatabaseProvider) {
      (this as unknown as { setConnected(value: boolean): void }).setConnected(true);
    });
    return () => spy.mockRestore();
  }

  const kubernetesConn = (overrides: Partial<DatabaseConnection> = {}) =>
    makeConnection("kubernetes", { id: "k8s-profile", port: 6443, database: undefined, ...overrides });

  test("a token engine's agent password alone is the agent's token, and the connection's user is kept", async () => {
    const conn = kubernetesConn({ id: "k8s-agent-token", password: "connection-token", agentPassword: "agent-token" });
    const restore = await kubernetesConnectStubbed(conn);
    try {
      const agent = await acquireExecutionProfileProvider(conn, "agent-operations");

      expect(agent.config.password).toBe("agent-token");
      expect(agent.config.user).toBe("test");
      expect(getExecutionProfileCacheStats().size).toBe(1);
    } finally {
      restore();
    }
  });

  test("a token engine refuses an agent user beside the agent token", async () => {
    const conn = kubernetesConn({ id: "k8s-agent-user", agentUser: "agent", agentPassword: "agent-token" });
    const restore = await kubernetesConnectStubbed(conn);
    try {
      const error: unknown = await acquireExecutionProfileProvider(conn, "agent-operations").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ExecutionProfileError);
      expect((error as InstanceType<typeof ExecutionProfileError>).reasonCode).toBe("AGENT_CREDENTIAL_UNRESOLVABLE");
      expect((error as Error).message).toBe(
        `Connection "k8s-agent-user" configures an agent user, and this engine takes the agent's token alone: clear the agent user`,
      );
      expect(getExecutionProfileCacheStats().size).toBe(0);
    } finally {
      restore();
    }
  });

  test("a token engine refuses an agent user with no agent token", async () => {
    const conn = kubernetesConn({ id: "k8s-agent-user-only", agentUser: "agent" });
    const restore = await kubernetesConnectStubbed(conn);
    try {
      const error: unknown = await acquireExecutionProfileProvider(conn, "agent-operations").catch((e: unknown) => e);

      expect((error as InstanceType<typeof ExecutionProfileError>).reasonCode).toBe("AGENT_CREDENTIAL_UNRESOLVABLE");
      expect((error as Error).message).toContain("takes the agent's token alone");
    } finally {
      restore();
    }
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
    // The same specific question as the writable path, for the same reason (D86): this
    // acquisition may only tear down a forward it opened itself.
    expect(mockHasTunnel).toHaveBeenLastCalledWith("pg-tunnel-profile", {
      ssh: conn.sshTunnel,
      farEnd: { host: "remote-db.example.com", port: 5432 },
    });
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

  test("an idle profiled entry reporting a run in flight is kept with its line, and evicted once it reports none", async () => {
    const clock = installFakeClock();
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      const agent = await acquireExecutionProfileProvider(pgConn(), "agent-read-only");
      let busy = true;
      Object.assign(agent, { hasRunsInFlight: () => busy });
      clock.advance(60_000);
      expect(await evictIdleProviders(30_000)).toBe(0);
      expect(getExecutionProfileCacheStats().size).toBe(1);
      expect(info.mock.calls.flat().join(" ")).toContain("Keeping idle profiled provider");
      busy = false;
      expect(await evictIdleProviders(30_000)).toBe(1);
      expect(getExecutionProfileCacheStats().size).toBe(0);
    } finally {
      info.mockRestore();
      clock.restore();
    }
  });

  test("a busy shared entry keeps the tunnel open while its idle profiled sibling is evicted", async () => {
    const clock = installFakeClock();
    try {
      const shared = await getOrCreateProvider(pgConn());
      await acquireExecutionProfileProvider(pgConn(), "agent-read-only");
      Object.assign(shared, { hasRunsInFlight: () => true });
      clock.advance(60_000);
      mockCloseSSHTunnel.mockClear();
      expect(await evictIdleProviders(30_000)).toBe(1);
      expect(getProviderCacheStats().size).toBe(1);
      expect(getExecutionProfileCacheStats().size).toBe(0);
      expect(mockCloseSSHTunnel).not.toHaveBeenCalledWith("pg-profile");
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

    afterAll(async () => {
      /*
       * The cache is emptied before the directory goes, and the await is the point.
       * Nothing else clears it after the last test of this group, so a provider that
       * connected here still holds an open handle on a file inside `sqliteTmpDir`. POSIX
       * unlinks an open file and never complains, so the old spelling looked correct on
       * Linux and macOS; Windows refuses to remove a file that is open and answers EBUSY,
       * and `force: true` only swallows ENOENT.
       */
      await clearProviderCache();
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

    test("nor can an execution context: a readOnly in it is refused, so no read-only handle enters the writable cache", async () => {
      // The execution context is server-injected, and getOrCreateProvider takes the file-access
      // posture on it (non-admin DuckDB file access). A readOnly riding along used to reach the provider while the key
      // ignored it: the read-only provider was then served to every later editor request, or a
      // read-only caller was handed the writable one. Refused before the cache is touched.
      const conn = await seedFileConnection();

      for (const readOnly of [true, false]) {
        // oxlint-disable-next-line no-await-in-loop -- each refusal is read before the next call, and neither may reach the cache.
        const refusal: unknown = await getOrCreateProvider(conn, {}, { readOnly } as never).catch((e: unknown) => e);
        expect(refusal).toBeInstanceOf(DatabaseConfigError);
        expect((refusal as Error).message).toContain("takes no readOnly");
      }
      expect(getProviderCacheStats().size).toBe(0);

      // The editor is still served a writable provider.
      const shared = await getOrCreateProvider(conn);
      expect((await shared.query("INSERT INTO t (id, v) VALUES (2, 'editor')")).rowCount).toBe(1);
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

    test("every profile opens a sqlite handle only under a trusted posture, as the editor does", async () => {
      // SQLite's drivers cannot confine what a statement reads, read-only included, so a denied
      // requester is refused at connect on the profiled path too, and an absent one reads as denied.
      const conn = await seedFileConnection();

      for (const profile of ["agent-read-only", "agent-operations", "agent-handover"] as const) {
        for (const requester of [{ allowExternalFileAccess: false }, {}]) {
          // oxlint-disable-next-line no-await-in-loop -- each refusal is read before the next call, and none may reach the cache.
          const refusal: unknown = await rawAcquireExecutionProfileProvider(conn, profile, {}, requester).catch(
            (e: unknown) => e,
          );
          expect(refusal).toBeInstanceOf(DatabaseConfigError);
          expect((refusal as Error).message).toContain("require an administrator");
        }
      }
      expect(getExecutionProfileCacheStats().size).toBe(0);

      const agent = await rawAcquireExecutionProfileProvider(
        conn,
        "agent-read-only",
        {},
        { allowExternalFileAccess: true },
      );
      expect(await agent.queryReadOnly!("SELECT v FROM t", { ...AGENT_BUDGET })).toMatchObject({
        rows: [{ v: "seeded" }],
      });
    });

    test("a profiled sqlite handle a trusted requester opened is never served to a denied one", async () => {
      // The profiled cache splits by posture for an engine that reads it, as the writable cache does;
      // without that, the denied request below would be handed the trusted handle cached first.
      const conn = await seedFileConnection();
      await rawAcquireExecutionProfileProvider(conn, "agent-read-only", {}, { allowExternalFileAccess: true });

      const refusal: unknown = await rawAcquireExecutionProfileProvider(
        conn,
        "agent-read-only",
        {},
        { allowExternalFileAccess: false },
      ).catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(DatabaseConfigError);
      expect(getExecutionProfileCacheStats()).toEqual({ size: 1, connections: [conn.id] });
    });
  });

  test("the profiled key carries the requester's posture only for an engine that reads it", async () => {
    const sqlite = makeConnection("sqlite", { id: "sqlite-profiled-key", database: "/data/profiled-key.db" });
    const denied = await profiledCacheKey(sqlite, "agent-read-only", { allowExternalFileAccess: false });

    expect(await profiledCacheKey(sqlite, "agent-read-only", { allowExternalFileAccess: true })).not.toBe(denied);
    // Absent reads as denied, as it does for the writable key.
    expect(await profiledCacheKey(sqlite, "agent-read-only")).toBe(denied);
    expect(await profiledCacheKey(pgConn(), "agent-read-only", { allowExternalFileAccess: false })).toBe(
      await profiledCacheKey(pgConn(), "agent-read-only", { allowExternalFileAccess: true }),
    );
  });
});

// ============================================================================
// Single-writer file reuse (#498)
// ----------------------------------------------------------------------------
// A provider that declares `singleWriterFile` admits ONE open handle per file, so
// the two callers that build a SECOND provider on a file the writable cache is
// already holding do not get a less privileged handle - they get none. These run on
// the REAL @libredb/libredb package against temp files, so the lock they assert
// against is the driver's own, not a fixture's.
// ============================================================================

describe("single-writer file reuse", () => {
  let dir: string;
  let seq = 0;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "libredb-factory-single-writer-"));
  });

  afterAll(async () => {
    /*
     * The cache is emptied before the directory goes, and the await is the point.
     * Nothing else clears it after the last test of this group, so a provider that connected
     * here still holds an open handle on a file inside `dir`. POSIX unlinks an open file
     * and never complains, so the old spelling looked correct on Linux and macOS; Windows
     * refuses to remove a file that is open and answers EBUSY, and `force: true` only
     * swallows ENOENT.
     */
    await clearProviderCache();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A fresh libredb connection with a file of its own, so no test inherits a lock. */
  function libredbConn(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
    seq += 1;
    return makeConnection("libredb", {
      id: `libredb-single-writer-${seq}`,
      database: join(dir, `single-writer-${seq}.libredb`),
      ...overrides,
    });
  }

  test("a second handle on the same file is refused, which is what makes the borrow load-bearing", async () => {
    // The control arm. Without it every assertion below could pass on an engine that
    // never locked anything, and the reuse would be measuring nothing.
    const conn = libredbConn();
    await getOrCreateProvider(conn);

    const second = await createDatabaseProvider(conn);

    await expect(second.connect()).rejects.toThrow(/exclusive lock/);
  });

  test("an operations acquisition borrows the open writable handle instead of opening a second one", async () => {
    const conn = libredbConn();
    const writable = await getOrCreateProvider(conn);

    const agent = await acquireExecutionProfileProvider(conn, "agent-operations");

    expect(agent).toBe(writable);
    // Borrowed, never owned: an entry in the profiled cache would let that cache's
    // idle sweep, or a removeProvider for any connection sharing the file, close the
    // file under the session that opened it.
    expect(getExecutionProfileCacheStats()).toEqual({ size: 0, connections: [] });
    expect(agent.isConnected()).toBe(true);
  });

  test("the identity is the resolved file path, not the connection id", async () => {
    // The D3 reproduction exactly: "Sample (LibreDB)" holds the file and the record
    // being tested is "My Sample" - a different id pointing at the same file.
    const held = libredbConn({ id: "sample-libredb", name: "Sample (LibreDB)" });
    const writable = await getOrCreateProvider(held);

    const underTest: DatabaseConnection = { ...held, id: "my-sample", name: "My Sample" };

    expect(findOpenSingleWriterProvider(underTest)).toBe(writable);
  });

  test("an unresolved spelling of the same path is the same file", async () => {
    const held = libredbConn();
    const writable = await getOrCreateProvider(held);

    // Deliberately not built with path.join, which would normalise it before the
    // factory ever saw it: the lock is per inode, so the lookup has to resolve.
    // The file name comes from basename rather than from splitting on "/": on
    // Windows `dir` is a backslash path, so the split returned the whole path and
    // the spelling became `C:\...\dir/./C:\...\held.libredb`, which resolves to
    // nothing and matched nothing. Measured on windows-latest, 2026-09-15. A
    // forward slash inside the spelling is fine there: Win32 accepts it, and
    // path.resolve, which is what the factory uses, normalises it away.
    const spelled: DatabaseConnection = {
      ...held,
      id: "spelled",
      database: `${dir}/./${basename(held.database!)}`,
    };

    expect(findOpenSingleWriterProvider(spelled)).toBe(writable);
  });

  test("two anonymous in-memory DuckDB connections are not the same database", async () => {
    // `:memory:` is not a file. Resolving it against the working directory gave two
    // unrelated connections one identity, so the second borrowed the first's handle and
    // read a database nobody pointed it at - DuckDB declares `singleWriterFile`, so the
    // borrow fires. There is no file to share and no lock to work around here: an
    // anonymous in-memory database is per-handle by definition.
    const held = makeConnection("duckdb", { id: "duck-memory-a", database: ":memory:" });
    const other = makeConnection("duckdb", { id: "duck-memory-b", database: ":memory:" });
    await getOrCreateProvider(held);

    expect(findOpenSingleWriterProvider(other)).toBeNull();
    // Nor does the holding record match itself: `getOrCreateProvider` serves it from the
    // cache by id, and this lookup is about files.
    expect(findOpenSingleWriterProvider(held)).toBeNull();
    await removeProvider(held.id);
  });

  test("a real DuckDB file is still matched across its spellings", async () => {
    // The other direction of the same change: narrowing `fileIdentity` must not cost the
    // borrow the case it exists for. `..` and a relative spelling are what `path.resolve`
    // normalises and a string comparison would not.
    const file = join(dir, "borrowed.duckdb");
    const held = makeConnection("duckdb", { id: "duck-file-a", database: file });
    const writable = await getOrCreateProvider(held);

    const dotted = makeConnection("duckdb", {
      id: "duck-file-b",
      database: join(dir, "..", basename(dir), "borrowed.duckdb"),
    });
    // Relative TO THE CWD, deliberately, and not to the file's own directory. `fileIdentity`
    // normalises with `path.resolve` (src/lib/db/factory.ts), which resolves against
    // `process.cwd()`, so a spelling relative to anything else would name a different file and
    // this assertion would fail on every platform rather than exercise the borrow.
    //
    // ON WINDOWS THIS LINE CAN LOSE ITS POINT WITHOUT LOSING ITS TRUTH, which is why it is
    // written down here. `path.relative` cannot express a path across volumes, so a machine
    // whose TMP sits on a different drive from the checkout gets an ABSOLUTE spelling back and
    // the case below repeats the `dotted` one instead of adding the relative one. That is a
    // weaker test on that machine shape, never a false one, and no assertion is added to make
    // the premise hard: a legitimate Windows layout should not be reported as a defect.
    const relative = makeConnection("duckdb", { id: "duck-file-c", database: relativePath(process.cwd(), file) });

    expect(findOpenSingleWriterProvider(dotted)).toBe(writable);
    expect(findOpenSingleWriterProvider(relative)).toBe(writable);
    await removeProvider(held.id);
  });

  test("a single-writer file keeps one handle for every owner, because a provider per user would be a second handle", async () => {
    // Per-user providers stop at the engines that keep one handle per file (docs/GOVERNANCE.md#per-user-providers): a
    // second owner's provider would be a second handle on the file, which this engine refuses (the first test of this
    // group) and DuckDB corrupts. So the owner is left out of the key, and every owner is served the one open handle.
    const conn = libredbConn();
    const alice = await getOrCreateProvider(conn, {}, { owner: "alice-subject", ownerPoolMax: 3 });

    expect(await getOrCreateProvider(conn, {}, { owner: "bob-subject", ownerPoolMax: 3 })).toBe(alice);
    expect(await getOrCreateProvider(conn)).toBe(alice);
    expect(getProviderCacheStats().size).toBe(1);
  });

  test("a connection with no file path holds no file, and matches nothing", async () => {
    const conn = libredbConn();
    await getOrCreateProvider(conn);

    // The shape the test-connection route hands this on every request that is not a
    // file engine at all (a connection-string connection carries no `database`).
    expect(findOpenSingleWriterProvider(makeConnection("mongodb", { database: undefined }))).toBeNull();
  });

  // DuckDB file-access posture in the cache and the borrow (non-admin DuckDB file access). This is the
  // critical ruling: an admin's full handle must never be shared with, nor borrowed
  // by, a non-admin, and the reverse. Run against the real @duckdb/node-api driver.

  test("an admin and a non-admin resolving the same DuckDB connection get two distinct handles", async () => {
    // Same connection id and :memory: target; only the server-derived posture differs, so the
    // cache key's posture segment is what keeps them apart. Reaching the admin handle would hand
    // a non-admin full filesystem access, which is the whole of the fix.
    const conn = makeConnection("duckdb", { id: "duck-posture-split", database: ":memory:" });
    const admin = await getOrCreateProvider(conn, {}, { allowExternalFileAccess: true });
    const nonAdmin = await getOrCreateProvider(conn, {}, { allowExternalFileAccess: false });

    expect(nonAdmin).not.toBe(admin);
    // Each asked again under its own posture is served from the cache, so the split is stable.
    expect(await getOrCreateProvider(conn, {}, { allowExternalFileAccess: true })).toBe(admin);
    expect(await getOrCreateProvider(conn, {}, { allowExternalFileAccess: false })).toBe(nonAdmin);
    // And the handles really do differ in reach: the engine reports it.
    const setting = "SELECT current_setting('enable_external_access') AS v";
    expect((await admin.query!(setting)).rows).toEqual([{ v: true }]);
    expect((await nonAdmin.query!(setting)).rows).toEqual([{ v: false }]);
    await removeProvider(conn.id);
  });

  test("a file-backed DuckDB record reopened under a flipped posture closes the stale handle first", async () => {
    // Two :memory: postures are two independent databases and may both stay open, but one FILE
    // under two postures would be two read-write handles on one file (the operator-edits-roles case
    // the api test reproduces end to end). The second open must close the first, leaving one writer.
    const file = join(dir, "posture-flip-close.duckdb");
    const conn = makeConnection("duckdb", { id: "duck-flip-close", database: file });
    const admin = await getOrCreateProvider(conn, {}, { allowExternalFileAccess: true });
    // The stale handle's disconnect rejects, so the warn-and-continue path runs; it still closes the
    // real handle first, so the file lock is released for the reopen below.
    // The order of the stale close and the new open is recorded, since the close has to come first:
    // a stale handle merely dropped from the cache, or closed after the reopen, is still a second
    // writer on the file while the new one opens.
    const order: string[] = [];
    const realDisconnect = admin.disconnect.bind(admin);
    admin.disconnect = async () => {
      await realDisconnect();
      order.push("close");
      throw new Error("disconnect failed");
    };
    const { DuckDBProvider } = await import("@/lib/db/providers/sql/duckdb");
    const realConnect = DuckDBProvider.prototype.connect;
    const connectSpy = spyOn(DuckDBProvider.prototype, "connect").mockImplementation(async function (
      this: InstanceType<typeof DuckDBProvider>,
    ) {
      order.push("open");
      return realConnect.call(this);
    });

    const nonAdmin = await getOrCreateProvider(conn, {}, { allowExternalFileAccess: false }).finally(() =>
      connectSpy.mockRestore(),
    );

    expect(nonAdmin).not.toBe(admin);
    expect(admin.isConnected()).toBe(false);
    expect(order).toEqual(["close", "open"]);
    // One record, one entry: the stale full-reach handle was closed rather than left beside the new
    // one. On the base before the fix this was two entries on one file.
    expect(getProviderCacheStats()).toEqual({ size: 1, connections: ["duck-flip-close"] });
    await removeProvider(conn.id);
  });

  test("a reopen under a new key closes only the stale handle of its own record, not another record on the file", async () => {
    // The stale close is bounded to one connection id. A different record naming the same file is
    // the separate, pre-existing D240 case, and opening it must not tear down the first record's
    // handle: otherwise anyone naming the path would close every handle on it.
    const file = join(dir, "posture-flip-other-id.duckdb");
    const first = makeConnection("duckdb", { id: "duck-flip-first", database: file });
    const second = makeConnection("duckdb", { id: "duck-flip-second", database: file });
    const held = await getOrCreateProvider(first, {}, { allowExternalFileAccess: true });

    const opened = await getOrCreateProvider(second, {}, { allowExternalFileAccess: false }).then(
      () => null,
      (error: unknown) => error,
    );

    // Windows refuses a second read-write handle on a file this process holds; Linux and macOS open it.
    if (process.platform === "win32") {
      expect(opened).toBeInstanceOf(Error);
    } else {
      expect(opened).toBeNull();
    }
    expect(held.isConnected()).toBe(true);
    expect(getProviderCacheStats().connections).toContain("duck-flip-first");
    await removeProvider(second.id);
    await removeProvider(first.id);
  });

  test("a LibreDB record reopened under a new key on the same file closes its stale handle first", async () => {
    // LibreDB is the other engine that declares `singleWriterFile`. An edit that moves the key and keeps
    // the file (here a credential) used to leave the old handle open, and the reopen was refused by the
    // file lock; the stale handle is now closed first, so the reopen succeeds as the file's only handle.
    const conn = libredbConn();
    const before = await getOrCreateProvider(conn);

    const after = await getOrCreateProvider({ ...conn, password: "edited" });

    expect(after).not.toBe(before);
    expect(before.isConnected()).toBe(false);
    expect(after.isConnected()).toBe(true);
    expect(getProviderCacheStats()).toEqual({ size: 1, connections: [conn.id] });
    await removeProvider(conn.id);
  });

  test("findOpenSingleWriterProvider does not hand an admin DuckDB handle to a non-admin caller, nor the reverse", async () => {
    const file = join(dir, "posture-borrow.duckdb");
    const conn = makeConnection("duckdb", { id: "duck-borrow-admin", database: file });
    const admin = await getOrCreateProvider(conn, {}, { allowExternalFileAccess: true });

    // A non-admin borrow is refused the admin's full handle (it would open its own instead);
    // the admin posture borrows its own handle back.
    expect(findOpenSingleWriterProvider(conn, false)).toBeNull();
    expect(findOpenSingleWriterProvider(conn, true)).toBe(admin);
    // And a bare lookup (no posture) reads as deny, so it does not reach the admin handle either.
    expect(findOpenSingleWriterProvider(conn)).toBeNull();
    await removeProvider(conn.id);

    // The reverse: a non-admin handle open, an admin borrow does not reach it.
    const nonAdmin = await getOrCreateProvider(conn, {}, { allowExternalFileAccess: false });
    expect(findOpenSingleWriterProvider(conn, true)).toBeNull();
    expect(findOpenSingleWriterProvider(conn, false)).toBe(nonAdmin);
    await removeProvider(conn.id);
  });

  test("an operations acquisition borrows the open DuckDB handle of its requester's editor posture (B49)", async () => {
    // An admin running an Operate agent on a connection only admins use, while the editor holds
    // the file under the admin's posture. The agent profile itself carries no posture, so before
    // the requester's was passed the borrow read as deny, skipped the admin's handle, and the run
    // opened a second, read-only handle: a frozen snapshot on Linux and macOS, a refusal on Windows.
    const file = join(dir, "operations-admin.duckdb");
    const conn = makeConnection("duckdb", { id: "duck-ops-admin", database: file });
    const editor = await getOrCreateProvider(conn, {}, { allowExternalFileAccess: true });

    const agent = await acquireExecutionProfileProvider(
      conn,
      "agent-operations",
      {},
      { allowExternalFileAccess: true },
    );

    expect(agent).toBe(editor);
    // Borrowed, never owned, exactly as the posture-free borrow is.
    expect(getExecutionProfileCacheStats()).toEqual({ size: 0, connections: [] });
    await removeProvider(conn.id);
  });

  test("an operations acquisition never borrows a handle wider than its requester's posture", async () => {
    // The fail-closed default: no requester posture reads as deny, so an admin's full handle is
    // not lent to it. It opens its own read-only handle beside the writer instead, which Windows
    // refuses for a file this process already holds (docs/providers/duckdb.md section 3.8).
    const file = join(dir, "operations-deny.duckdb");
    const conn = makeConnection("duckdb", { id: "duck-ops-deny", database: file });
    const editor = await getOrCreateProvider(conn, {}, { allowExternalFileAccess: true });

    const acquired = await acquireExecutionProfileProvider(conn, "agent-operations").then(
      (provider) => provider,
      (error: unknown) => error,
    );

    if (process.platform === "win32") {
      expect(acquired).toBeInstanceOf(Error);
    } else {
      expect(acquired).not.toBe(editor);
      expect(getExecutionProfileCacheStats().size).toBe(1);
    }
    await removeProvider(conn.id);
  });

  test("isSingleWriterFileOpen sees a held file whatever posture holds it, which the borrow cannot", async () => {
    // The question Test Connection asks when the borrow answers null: is the file open under the
    // OTHER posture, where a second read-write handle must not be opened beside it.
    const file = join(dir, "posture-held.duckdb");
    const conn = makeConnection("duckdb", { id: "duck-held-admin", database: file });
    const other = makeConnection("duckdb", { id: "duck-held-other", database: file });
    expect(isSingleWriterFileOpen(other)).toBe(false);

    await getOrCreateProvider(conn, {}, { allowExternalFileAccess: true });

    expect(findOpenSingleWriterProvider(other, false)).toBeNull();
    expect(isSingleWriterFileOpen(other)).toBe(true);
    await removeProvider(conn.id);
    // Closed, so nothing holds it any more.
    expect(isSingleWriterFileOpen(other)).toBe(false);
  });

  test("isSingleWriterFileOpen is false for a connection with no file, an anonymous in-memory one included", async () => {
    const memory = makeConnection("duckdb", { id: "duck-held-memory", database: ":memory:" });
    await getOrCreateProvider(memory, {}, { allowExternalFileAccess: true });

    expect(isSingleWriterFileOpen(memory)).toBe(false);
    expect(isSingleWriterFileOpen(makeConnection("mongodb", { database: undefined }))).toBe(false);
    await removeProvider(memory.id);
  });

  test("an engine that admits many handles is not borrowed from, and keeps its read-only boundary", async () => {
    // SQLite is the engine a reader would expect to declare singleWriterFile. It does
    // not, and this is what declaring it would have cost: the agent handle here is a
    // SECOND, `readonly: true` open of the same file, and the database itself refuses
    // its writes. Borrowing the writable one would have handed the agent write access.
    const conn = makeConnection("sqlite", { id: "sqlite-many-handles", database: join(dir, "many-handles.db") });
    const writable = await getOrCreateProvider(conn);
    await writable.query("CREATE TABLE t (id INTEGER PRIMARY KEY)");

    const agent = await acquireExecutionProfileProvider(conn, "agent-read-only");

    expect(agent).not.toBe(writable);
    expect(getExecutionProfileCacheStats()).toEqual({ size: 1, connections: [conn.id] });
    await expect(agent.queryReadOnly!("INSERT INTO t (id) VALUES (1)", AGENT_BUDGET)).rejects.toThrow();
  });

  test("a profile that sends statements is still refused rather than handed the writable handle", async () => {
    // The borrow is scoped to `agent-operations`, the profile that sends no statement
    // at all. `agent-read-only` and `agent-handover` send one, and an engine with no
    // read-only statement path is refused as it always was - being able to reuse a
    // handle is not a reason to run a model's statement through a writable one.
    const conn = libredbConn();
    const writable = await getOrCreateProvider(conn);

    const error: unknown = await acquireExecutionProfileProvider(conn, "agent-read-only").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as ExecutionProfileError).reasonCode).toBe("PROFILE_UNSUPPORTED_BY_PROVIDER");
    expect(writable.isConnected()).toBe(true);
  });

  test("a configured agent credential opts out of borrowing (fail closed)", async () => {
    // The borrowed handle was opened under the connection's own credentials. An
    // operator who configured `agentUser` asked for something this reuse cannot give,
    // so it is not silently ignored: the acquisition opens its own handle and hits the
    // lock, which leaves the run ungrounded and honest rather than grounded under a
    // credential nobody asked for.
    const conn = libredbConn({ agentUser: "agent_ro", agentPassword: "agent-secret" });
    await getOrCreateProvider(conn);

    await expect(acquireExecutionProfileProvider(conn, "agent-operations")).rejects.toThrow(/exclusive lock/);
    expect(getExecutionProfileCacheStats().size).toBe(0);
  });

  test("nothing is borrowed once the writable handle is gone", async () => {
    const conn = libredbConn();
    await getOrCreateProvider(conn);
    await removeProvider(conn.id);

    expect(findOpenSingleWriterProvider(conn)).toBeNull();

    // And the file is free, so the acquisition opens - and OWNS - its own handle.
    const agent = await acquireExecutionProfileProvider(conn, "agent-operations");
    expect(agent.isConnected()).toBe(true);
    expect(getExecutionProfileCacheStats()).toEqual({ size: 1, connections: [conn.id] });
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
    mockCreateSSHTunnel.mockImplementationOnce(async (_id, _sshConfig, remoteHost, remotePort) => ({
      localHost: "127.0.0.1",
      localPort: 54321,
      remoteHost,
      remotePort,
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

// ─── A readOnly the engine cannot keep is refused before anything is built or dialled (#1089) ──

describe("assertReadOnlyHonoured", () => {
  // `mockHasTunnel` is not reset by the file-level beforeEach, and two assertions below are that no
  // pool is consulted: negatives that only mean anything against a counter this describe owns.
  beforeEach(() => {
    mockHasTunnel.mockClear();
  });

  const bastion: SSHTunnelConfig = {
    enabled: true,
    host: "bastion.example.com",
    port: 22,
    username: "jump",
    authMethod: "password",
    password: "pw",
  };

  /** The factory's refusal of `readOnly: true` on an engine whose provider does not enforce it. */
  const unenforced = (type: string) =>
    `readOnly: true is refused for ${type}: its provider does not enforce a read-only mode, so the connection would open able to write. Remove readOnly from the connection, or connect with a database role that cannot write.`;

  const thrownBy = (run: () => void): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  /** The lines `createDatabaseProvider` logs, one for every provider it builds. */
  const buildLines = (log: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }) =>
    log.mock.calls.filter(([line]) => String(line).startsWith("[DB] Creating"));

  /** A mode that is not a boolean: the fourth part of the cache key reads it as `read-write`. */
  const notABoolean = "true" as unknown as boolean;

  test("an absent or false readOnly passes on every shipped engine", () => {
    for (const type of SHIPPED_DATABASE_TYPES) {
      expect({ type, error: thrownBy(() => assertReadOnlyHonoured(makeConnection(type))) }).toEqual({
        type,
        error: undefined,
      });
      expect({
        type,
        error: thrownBy(() => assertReadOnlyHonoured(makeConnection(type, { readOnly: false }))),
      }).toEqual({ type, error: undefined });
    }
  });

  test("readOnly: true is refused on every engine that does not enforce it, naming the type and the field", () => {
    const refusing = SHIPPED_DATABASE_TYPES.filter((type) => !READ_ONLY_ENFORCED[type]);
    // Vacuity, by name: an empty population would refuse nothing and pass.
    expect(refusing).toContain("postgres");
    for (const type of refusing) {
      const error = thrownBy(() => assertReadOnlyHonoured(makeConnection(type, { readOnly: true })));
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect({ type, message: (error as Error).message }).toEqual({ type, message: unenforced(type) });
    }
  });

  test.each([
    ["a string", "read-only-please"],
    ["a number", 1],
    ["null", null],
  ])("a readOnly that is %s is refused on any engine, naming the field and never the value", (_label, value) => {
    const error = thrownBy(() =>
      assertReadOnlyHonoured(makeConnection("postgres", { readOnly: value as unknown as boolean })),
    );

    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect((error as Error).message).toBe("readOnly must be true or false.");
  });

  test("the refusal names a type it does not know with its line breaks taken out", () => {
    // The type arrives in the request body, and the factory strips a line break from every
    // caller-supplied value it interpolates into a message, so a type cannot write a line of its own.
    const error = thrownBy(() => assertReadOnlyHonoured(makeConnection("postgres\r\ninjected", { readOnly: true })));

    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect((error as Error).message).toBe(unenforced("postgres  injected"));
  });

  test("createDatabaseProvider refuses before it builds a provider", async () => {
    // The first thing the factory does after the check is log the provider it is creating, so a log
    // line here would mean a provider was built for a connection it must refuse.
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(createDatabaseProvider(makeConnection("postgres", { readOnly: true }))).rejects.toThrow(
        unenforced("postgres"),
      );
      expect(buildLines(log)).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  test("getOrCreateProvider refuses before the cache and before the tunnel, and builds and opens nothing", async () => {
    const connection = makeConnection("postgres", {
      id: "read-only-tunnelled",
      host: "db.internal",
      port: 5432,
      readOnly: true,
      sshTunnel: bastion,
    });
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(getOrCreateProvider(connection)).rejects.toThrow(unenforced("postgres"));
      expect(buildLines(log)).toEqual([]);
    } finally {
      log.mockRestore();
    }

    expect(mockHasTunnel).not.toHaveBeenCalled();
    expect(mockCreateSSHTunnel).not.toHaveBeenCalled();
    expect(getProviderCacheStats().size).toBe(0);
  });

  test("the same connection without the field opens its tunnel and is cached, as before", async () => {
    // The control: the refusal above is the field's, not a tunnelled PostgreSQL record's.
    const connection = makeConnection("postgres", {
      id: "read-write-tunnelled",
      host: "db.internal",
      port: 5432,
      sshTunnel: bastion,
    });

    const provider = await getOrCreateProvider(connection);

    expect(provider.isConnected()).toBe(true);
    expect(mockCreateSSHTunnel).toHaveBeenCalledTimes(1);
    expect(getProviderCacheStats().connections).toEqual(["read-write-tunnelled"]);
  });

  test("getOrCreateProvider refuses a mode that is not a boolean although a read-write provider is cached under its key", async () => {
    // A mode that is not `true` keys as `read-write`, so it answers the key the connection's cached
    // provider sits under: only a check ahead of the lookup refuses it rather than handing that
    // provider out.
    const connection = makeConnection("postgres", { id: "cached-read-write", host: "db.internal", port: 5432 });
    const cached = await getOrCreateProvider(connection);
    expect(cached.isConnected()).toBe(true);

    await expect(getOrCreateProvider({ ...connection, readOnly: notABoolean })).rejects.toThrow(
      "readOnly must be true or false.",
    );
  });

  test("acquireExecutionProfileProvider refuses before the profiled cache and before the tunnel", async () => {
    const connection = makeConnection("postgres", {
      id: "read-only-profiled",
      host: "db.internal",
      port: 5432,
      readOnly: true,
      sshTunnel: bastion,
    });

    await expect(acquireExecutionProfileProvider(connection, "agent-operations")).rejects.toThrow(
      unenforced("postgres"),
    );

    expect(mockHasTunnel).not.toHaveBeenCalled();
    expect(mockCreateSSHTunnel).not.toHaveBeenCalled();
    expect(getExecutionProfileCacheStats().size).toBe(0);
  });

  test("acquireExecutionProfileProvider refuses a mode that is not a boolean although a profiled provider is cached under its key", async () => {
    // The profiled key embeds the provider cache key, so the same reading holds there: the check has
    // to come before the profiled cache is consulted.
    const connection = makeConnection("postgres", { id: "cached-profiled", host: "db.internal", port: 5432 });
    const cached = await acquireExecutionProfileProvider(connection, "agent-operations");
    expect(cached.isConnected()).toBe(true);

    await expect(
      acquireExecutionProfileProvider({ ...connection, readOnly: notABoolean }, "agent-operations"),
    ).rejects.toThrow("readOnly must be true or false.");
  });

  test("withOneShotTunnel refuses before it dials, and never runs its callback", async () => {
    const run = mock(async () => "ran");
    const connection = makeConnection("postgres", {
      id: "read-only-one-shot",
      host: "db.internal",
      port: 5432,
      readOnly: true,
      sshTunnel: bastion,
    });

    await expect(withOneShotTunnel(connection, run)).rejects.toThrow(unenforced("postgres"));

    expect(run).not.toHaveBeenCalled();
    expect(mockCreateSSHTunnel).not.toHaveBeenCalled();
  });

  test("withOneShotTunnel refuses a connection with no tunnel too, and never runs its callback", async () => {
    // The pass-through branch hands the callback the connection as it is, so a check placed only on
    // the tunnelled path would let the callback build and connect a provider for it.
    const run = mock(async () => "ran");

    await expect(withOneShotTunnel(makeConnection("postgres", { readOnly: true }), run)).rejects.toThrow(
      unenforced("postgres"),
    );

    expect(run).not.toHaveBeenCalled();
  });
});

/**
 * Grounding a plan run on a file the editor already has open (#498).
 *
 * The real package, the real factory and a real file: the lock these assert against is
 * the driver's own. `acquireExecutionProfileProvider` used to open a SECOND handle here
 * and be refused every time, and because a `ConnectionError` becomes an unavailable
 * capture rather than a failure, the run went on silently ungrounded. The condition was
 * "the connection's ordinary provider is connected", which is true from the moment
 * anyone browses the connection in the sidebar - so in practice it was every run.
 */
describe("grounding a plan run while the writable provider holds the file (B49)", () => {
  const frozenClock = () => 1_700_000_000_000;

  let dir: string;
  let seq = 0;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "libredb-factory-grounding-"));
  });

  afterAll(async () => {
    /*
     * The cache is emptied before the directory goes, and the await is the point.
     * Nothing else clears it after the last test of this group, so a provider that connected
     * here still holds an open handle on a file inside `dir`. POSIX unlinks an open file
     * and never complains, so the old spelling looked correct on Linux and macOS; Windows
     * refuses to remove a file that is open and answers EBUSY, and `force: true` only
     * swallows ENOENT.
     */
    await clearProviderCache();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A seeded libredb file of its own, so no test inherits another's lock. */
  function seededConn(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
    seq += 1;
    const file = join(dir, `grounding-${seq}.libredb`);
    const db = libreOpen({ path: file });
    const store = libreKv(db);
    store.set("user:1", "Ada");
    store.set("order:1", "42");
    store.set("config", "on");
    db.close();
    return makeConnection("libredb", { id: `libredb-grounding-${seq}`, database: file, ...overrides });
  }

  function planContext(connection: DatabaseConnection, provider: DatabaseProvider): AgentToolContext {
    return {
      runId: "run-libredb-grounding",
      modelId: "unmeasured-model-for-tests",
      // A PLAN run: it is handed no tools, and this schema read is the server's own.
      mode: "planning",
      workflowType: "investigation",
      actor: { sessionId: "session-1", role: "user" },
      connection,
      capabilities: provider.getCapabilities(),
      labels: provider.getLabels(),
      registry: createCanonicalOperationRegistry(),
      scope: createTargetScope(connection.id),
      tracker: new ExecutionBudgetTracker(),
      artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
      deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs, frozenClock),
      repairs: new AgentRepairLedger(),
      acquireProvider: acquireExecutionProfileProvider,
      clock: frozenClock,
    };
  }

  test("the run is grounded from the handle the editor already holds", async () => {
    const connection = seededConn();
    const writable = await getOrCreateProvider(connection);
    expect(writable.isConnected()).toBe(true);

    const capture = await captureContextSnapshot(planContext(connection, writable));

    expect(capture.kind).toBe("captured");
    if (capture.kind !== "captured") throw new Error("unreachable");
    expect(capture.snapshot.readVia).toBe("provider-inventory");
    expect(capture.snapshot.objects.map((t) => t.name).sort()).toEqual(["config", "order:*", "user:*"]);
    // The handle was BORROWED: the profiled cache owns nothing, so no eviction there
    // can close the file under the editor's own session.
    expect(getExecutionProfileCacheStats()).toEqual({ size: 0, connections: [] });
    expect(writable.isConnected()).toBe(true);
  });

  test("the same run without the reuse is ungrounded, and nothing about it looks like a failure", async () => {
    // The control arm, and the pre-fix behaviour exactly. An agent credential opts the
    // acquisition out of borrowing (it cannot substitute one principal for another), so
    // this run opens its own handle, hits the lock, and the `ConnectionError` becomes an
    // unavailable capture instead of an error anyone sees.
    const connection = seededConn({ agentUser: "agent_ro", agentPassword: "secret" });
    const writable = await getOrCreateProvider(connection);

    const capture = await captureContextSnapshot(planContext(connection, writable));

    expect(capture.kind).toBe("unavailable");
    if (capture.kind !== "unavailable") throw new Error("unreachable");
    expect(capture.reasonCode).toBe("CATALOG_READ_REFUSED");
  });
});

describe("cached connection query timeout", () => {
  test.each([false, true])(
    "replaces the cached provider even when disconnect rejects (profiled: %s)",
    async (profiled) => {
      const acquire = (connection: DatabaseConnection) =>
        profiled ? acquireExecutionProfileProvider(connection, "agent-read-only") : getOrCreateProvider(connection);
      const connection = makeConnection("postgres");
      const initial = await acquire(connection);
      initial.disconnect = mock(async () => {
        throw new Error("socket already gone");
      });
      const changed = { ...connection, queryTimeout: 120000 };
      const fresh = await acquire(changed);
      expect(fresh).not.toBe(initial);
      expect(fresh.isConnected()).toBe(true);
      expect(await acquire(changed)).toBe(fresh);
      const restored = await acquire(connection);
      expect(restored).not.toBe(initial);
      expect(restored).not.toBe(fresh);
      expect(restored.isConnected()).toBe(true);
    },
  );
  test.each([false, true])(
    "recreates a provider after changing or clearing the timeout (profiled: %s)",
    async (profiled) => {
      const acquire = (connection: DatabaseConnection) =>
        profiled ? acquireExecutionProfileProvider(connection, "agent-read-only") : getOrCreateProvider(connection);
      const connection = makeConnection("postgres");
      const initial = await acquire(connection);
      const updated = await acquire({ ...connection, queryTimeout: 120000 });
      expect(updated).not.toBe(initial);
      expect(initial.isConnected()).toBe(false);
      expect((updated as unknown as { queryTimeout: number }).queryTimeout).toBe(120000);
      expect(await acquire({ ...connection, queryTimeout: 120000 })).toBe(updated);
      const cleared = await acquire(connection);
      expect(cleared).not.toBe(updated);
      expect(updated.isConnected()).toBe(false);
      expect((cleared as unknown as { queryTimeout: number }).queryTimeout).toBe(60000);
    },
  );
});

// ============================================================================
// The tunnel's far end reaches the plan seal (X23)
// ----------------------------------------------------------------------------
// `getOrCreateProvider` rewrites `host` and `port` to the tunnel's LOCAL endpoint
// before the provider is built, and every sealing provider digests `this.config`.
// The routes digest the record the request RESOLVED, which still names the far end.
// These assertions drive BOTH sides through the real factory: the left-hand digest
// is the exact expression `postgres.ts`, `trino/index.ts` and `redis.ts` evaluate.
// ============================================================================

describe("a tunnelled provider fingerprints the far end (X23)", () => {
  const BASTION: SSHTunnelConfig = {
    enabled: true,
    host: "bastion.internal",
    port: 22,
    username: "jump",
    authMethod: "password",
    password: "pw",
  };

  /** A distinct id per case: `getOrCreateProvider` caches on it. */
  function record(id: string, overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
    return makeConnection("postgres", {
      id,
      host: "db.internal",
      port: 5432,
      database: "app",
      sshTunnel: BASTION,
      ...overrides,
    });
  }

  /** The provider's side of the comparison, taken from the factory rather than hand-built. */
  async function sealedBy(connection: DatabaseConnection): Promise<string> {
    const provider = await getOrCreateProvider(connection);
    // The rewrite really happened, so the equality below is not passing by never having moved.
    expect(provider.config.host).toBe("127.0.0.1");
    expect(provider.config.port).toBe(54321);
    return await connectionFingerprint(provider.config);
  }

  test("the two sides of the edit-plan comparison agree", async () => {
    const stored = record("x23-agree");
    expect(await sealedBy(stored)).toBe(await connectionFingerprint(stored));
  });

  test("the property the digest exists for survives: same bastion, two databases", async () => {
    // Two databases behind the SAME bastion reach the SAME local endpoint - both providers
    // are handed `127.0.0.1:54321` - so this is the collision a fix that simply dropped
    // `host` and `port` from the frame would produce.
    const left = record("x23-same-bastion-a", { database: "app" });
    const right = record("x23-same-bastion-b", { database: "billing" });
    expect(await sealedBy(left)).not.toBe(await sealedBy(right));
  });

  test("the property the digest exists for survives: same far end, two bastions", async () => {
    // Identical `db.internal:5432`, reached through two different machines. `tunnelRoute`
    // is what separates them and this proves the far end did not displace it.
    const ours = record("x23-bastion-ours");
    const theirs = record("x23-bastion-theirs", { sshTunnel: { ...BASTION, host: "attacker.example" } });
    expect(await sealedBy(ours)).not.toBe(await sealedBy(theirs));
    expect(await sealedBy(theirs)).toBe(await connectionFingerprint(theirs));
  });

  test("the control: an untunnelled provider is untouched by any of this", async () => {
    const plain = makeConnection("postgres", { id: "x23-plain", host: "db.internal", port: 5432, database: "app" });
    const provider = await getOrCreateProvider(plain);
    expect(provider.config.host).toBe("db.internal");
    expect(await connectionFingerprint(provider.config)).toBe(await connectionFingerprint(plain));
    // And it is NOT the tunnelled record's digest: a carrier that leaked into the untunnelled
    // path, or a frame that dropped the tunnel, would make these two the same server.
    expect(await connectionFingerprint(plain)).not.toBe(await connectionFingerprint(record("x23-plain-twin")));
  });

  test("the far end cannot be stored, because it does not survive JSON", async () => {
    // Property 3 of the ruling, asserted rather than argued. Every connection this app
    // resolves has been through `JSON.parse` on the way out of storage or off the wire, and a
    // symbol-keyed property is dropped by `JSON.stringify` and unwritable by `JSON.parse`. So
    // the digest-deciding value cannot be set by whoever stores or posts the connection.
    const stored = record("x23-no-json");
    const provider = await getOrCreateProvider(stored);
    const roundTripped = JSON.parse(JSON.stringify(provider.config)) as DatabaseConnection;
    expect(await connectionFingerprint(roundTripped)).not.toBe(await connectionFingerprint(stored));
    // Fail closed: what a round trip leaves is the LOCAL endpoint, which is what the routes
    // refuse. The seal never falls back to "equal if we cannot tell".
    expect(await connectionFingerprint(roundTripped)).toBe(
      await connectionFingerprint({ ...stored, host: "127.0.0.1", port: 54321 }),
    );
  });

  test("the execution-profile path carries it too, credential substitution and all", async () => {
    // The second rewrite site. It has no sealing caller today, and a fix that covered one
    // site and not the other would be half a fix that nobody notices until it has one.
    const stored = record("x23-profile", { agentUser: "agent_ro", agentPassword: "s3cret" });
    const provider = await acquireExecutionProfileProvider(stored, "agent-read-only");
    expect(provider.config.host).toBe("127.0.0.1");
    // `user` IS in the frame and the acquisition substituted it, so the digest that must match
    // is the record's with the agent's role on it - which is the connection this provider is.
    expect(await connectionFingerprint(provider.config)).toBe(
      await connectionFingerprint({ ...stored, user: "agent_ro" }),
    );
  });

  test("the one-shot scope carries it too", async () => {
    // The third rewrite site: `test-connection` and `schema-snapshot` build a provider
    // outside both caches through here.
    const stored = record("x23-one-shot");
    const seen = await withOneShotTunnel(stored, async (effective) => {
      expect(effective.host).toBe("127.0.0.1");
      return await connectionFingerprint(effective);
    });
    expect(seen).toBe(await connectionFingerprint(stored));
  });
});

test("a denied SQLite caller cannot borrow a cached administrator handle", async () => {
  const connection = makeConnection("sqlite", { database: ":memory:" });
  const trusted = await getOrCreateProvider(connection, {}, { allowExternalFileAccess: true });
  try {
    await expect(getOrCreateProvider(connection, {}, { allowExternalFileAccess: false })).rejects.toThrow(
      "require an administrator",
    );
    expect(trusted.isConnected()).toBe(true);
    expect((await trusted.query("SELECT 1 AS value")).rows).toEqual([{ value: 1 }]);
  } finally {
    clearProviderCache();
  }
});

// ─── Snowflake: the two-argument build, the role split and removal ─────────

// Imported after the factory, which this file must evaluate first (the docblock above).
const { SnowflakeProvider } = await import("@/lib/db/providers/sql/snowflake/index");

describe("the Snowflake provider in the factory", () => {
  /** A Snowflake connection as a census builds one: nothing in it is read before connect(). */
  const snowflake = (overrides: Partial<DatabaseConnection> = {}): DatabaseConnection =>
    makeConnection("snowflake", {
      host: "myorg-myaccount",
      port: undefined,
      user: "studio_svc",
      role: "STUDIO_RO",
      authMethod: "pat",
      password: "stand-in-token",
      warehouse: "STUDIO_WH",
      ...overrides,
    });

  /** connect() stubbed to mark the provider connected and send nothing, as the file stubs other providers. */
  function stubConnect() {
    return spyOn(SnowflakeProvider.prototype, "connect").mockImplementation(async function (
      this: InstanceType<typeof SnowflakeProvider>,
    ) {
      (this as unknown as { setConnected(connected: boolean): void }).setConnected(true);
    });
  }

  test("builds SnowflakeProvider with two arguments only, so no deps reach it from a connection", async () => {
    const source = readFileSync(join(import.meta.dir, "../../src/lib/db/factory.ts"), "utf8");
    const start = source.indexOf('case "snowflake": {');
    expect(start).toBeGreaterThan(-1);
    // The case block ends at its own closing brace, the first one at the case's indentation.
    const block = source.slice(start, source.indexOf("\n    }", start));
    expect(block).toContain("new SnowflakeProvider(connection, options)");
    expect(block).not.toMatch(/new SnowflakeProvider\([^)]*,[^)]*,/);

    const provider = await createDatabaseProvider(snowflake());
    expect(provider).toBeInstanceOf(SnowflakeProvider);
    expect(provider.isConnected()).toBe(false);
  });

  test("two connections differing only in role are two cache entries, two instances, each with its own role", async () => {
    const connect = stubConnect();
    try {
      const first = await getOrCreateProvider(snowflake({ id: "sf-roles", role: "ROLE_A" }));
      const second = await getOrCreateProvider(snowflake({ id: "sf-roles", role: "ROLE_B" }));
      expect(first).not.toBe(second);
      expect(first.config.role).toBe("ROLE_A");
      expect(second.config.role).toBe("ROLE_B");
      expect(getProviderCacheStats()).toEqual({ size: 2, connections: ["sf-roles", "sf-roles"] });
      expect(connect).toHaveBeenCalledTimes(2);
      // The same role again is the first entry, not a third.
      expect(await getOrCreateProvider(snowflake({ id: "sf-roles", role: "ROLE_A" }))).toBe(first);
    } finally {
      connect.mockRestore();
    }
  });

  test("removeProvider calls disconnect() once per cached entry of the connection, shared and profiled", async () => {
    const connect = stubConnect();
    const disconnect = spyOn(SnowflakeProvider.prototype, "disconnect");
    try {
      const conn = snowflake({ id: "sf-remove" });
      await getOrCreateProvider(conn);
      await acquireExecutionProfileProvider(conn, "agent-operations");
      expect(getProviderCacheStats().size).toBe(1);
      expect(getExecutionProfileCacheStats().size).toBe(1);

      await removeProvider(conn.id);

      expect(disconnect).toHaveBeenCalledTimes(2);
      expect(getProviderCacheStats().size).toBe(0);
      expect(getExecutionProfileCacheStats().size).toBe(0);
    } finally {
      connect.mockRestore();
      disconnect.mockRestore();
    }
  });

  test.each(["agent-read-only", "agent-handover"] as const)(
    "the %s profile is refused, since Snowflake declares no read-only statement path, and nothing connects",
    async (profile) => {
      const connect = stubConnect();
      try {
        const error: unknown = await acquireExecutionProfileProvider(snowflake({ id: `sf-${profile}` }), profile).catch(
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(ExecutionProfileError);
        expect((error as InstanceType<typeof ExecutionProfileError>).reasonCode).toBe(
          "PROFILE_UNSUPPORTED_BY_PROVIDER",
        );
        expect(connect).not.toHaveBeenCalled();
        expect(getExecutionProfileCacheStats().size).toBe(0);
      } finally {
        connect.mockRestore();
      }
    },
  );
});
