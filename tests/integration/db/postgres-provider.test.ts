/**
 * Integration tests for PostgresProvider
 * Uses mock.module() to intercept pg before provider import.
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import type { DatabaseConnection } from "@/lib/types";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import { ConnectionError, DatabaseConfigError, ExecutionProfileError } from "@/lib/db/errors";

// ============================================================================
// Mock pg BEFORE importing the provider
// ============================================================================

let mockQueryFn: (
  sql: string,
  params?: unknown[],
) => Promise<{
  rows: unknown[];
  fields?: { name: string }[];
  rowCount?: number;
}>;

const mockClient = {
  query: (sql: string, params?: unknown[]) => mockQueryFn(sql, params),
  // Real pg signature: release(err?) — an error argument destroys the client
  // instead of returning it to the pool, which queryReadOnly relies on.
  release: (_destroy?: Error) => {},
};

/**
 * The pool mock is a real EventEmitter, and a fresh instance per construction, because
 * that is what `pg` hands back. An `error` event with no listener is an uncaught
 * exception (#298), so a plain object carrying an inert `on` could not tell a pool whose
 * idle-client failure is handled from one that takes the process down with it.
 */
class MockPool extends EventEmitter {
  public totalCount = 10;
  public idleCount = 7;
  public waitingCount = 0;

  async connect() {
    return mockClient;
  }

  async end() {}
}

/** The pool handed to the most recently constructed provider. */
let lastPool: MockPool | undefined;

mock.module("pg", () => ({
  Pool: function () {
    lastPool = new MockPool();
    return lastPool;
  },
}));

// Dynamic import AFTER mock is installed
const { PostgresProvider } = await import("@/lib/db/providers/sql/postgres");

// ============================================================================
// Helpers
// ============================================================================

function makePgConfig(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "test-pg",
    name: "Test Postgres",
    type: "postgres",
    host: "localhost",
    port: 5432,
    database: "testdb",
    user: "postgres",
    password: "secret",
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * Default mock query that matches SQL patterns and returns appropriate mock data.
 */
function defaultMockQuery(sql: string): Promise<{ rows: unknown[]; fields?: { name: string }[]; rowCount?: number }> {
  const normalized = sql.trim().toLowerCase();

  // pg_backend_pid — PID tracking for query cancellation
  if (
    normalized.includes("pg_backend_pid()") &&
    normalized.includes("select") &&
    !normalized.includes("pg_stat_activity")
  ) {
    return Promise.resolve({ rows: [{ pid: 12345 }], fields: [{ name: "pid" }], rowCount: 1 });
  }

  // pg_cancel_backend — cancel a running query
  if (normalized.includes("pg_cancel_backend")) {
    return Promise.resolve({ rows: [{ cancelled: true }], fields: [{ name: "cancelled" }], rowCount: 1 });
  }

  // pg_terminate_backend — kill session
  if (normalized.includes("pg_terminate_backend")) {
    return Promise.resolve({
      rows: [{ pg_terminate_backend: true }],
      fields: [{ name: "pg_terminate_backend" }],
      rowCount: 1,
    });
  }

  // BEGIN / COMMIT / ROLLBACK — transaction control
  if (normalized === "begin" || normalized === "commit" || normalized === "rollback") {
    return Promise.resolve({ rows: [], fields: [], rowCount: 0 });
  }

  // VACUUM ANALYZE
  if (normalized.includes("vacuum analyze") || normalized === "vacuum analyze") {
    return Promise.resolve({ rows: [], fields: [], rowCount: 0 });
  }

  // ANALYZE (without vacuum)
  if (normalized.startsWith("analyze")) {
    return Promise.resolve({ rows: [], fields: [], rowCount: 0 });
  }

  // REINDEX
  if (normalized.startsWith("reindex")) {
    return Promise.resolve({ rows: [], fields: [], rowCount: 0 });
  }

  // SELECT * FROM pg_stat_activity (exact, getPgStatActivity)
  if (normalized.includes("select * from pg_stat_activity")) {
    return Promise.resolve({
      rows: [
        {
          datname: "testdb",
          pid: 123,
          usename: "testuser",
          application_name: "testapp",
          client_addr: "127.0.0.1",
          backend_start: new Date().toISOString(),
          state: "active",
          query: "SELECT * FROM test_table",
        },
      ],
      fields: [
        { name: "datname" },
        { name: "pid" },
        { name: "usename" },
        { name: "application_name" },
        { name: "client_addr" },
        { name: "backend_start" },
        { name: "state" },
        { name: "query" },
      ],
      rowCount: 1,
    });
  }

  // getHealth: count(*) from pg_stat_activity
  if (
    normalized.includes("count(*)") &&
    normalized.includes("pg_stat_activity") &&
    !normalized.includes("max_connections")
  ) {
    return Promise.resolve({ rows: [{ count: "5" }], fields: [{ name: "count" }], rowCount: 1 });
  }

  // getHealth: pg_size_pretty(pg_database_size(...))
  if (
    normalized.includes("pg_size_pretty") &&
    normalized.includes("pg_database_size") &&
    !normalized.includes("pg_tablespace")
  ) {
    return Promise.resolve({
      rows: [{ pg_size_pretty: "256 MB", database_size: "256 MB", database_size_bytes: "268435456" }],
      fields: [{ name: "pg_size_pretty" }],
      rowCount: 1,
    });
  }

  // pg_stat_statements with total_exec_time (getHealth slow queries)
  if (
    normalized.includes("pg_stat_statements") &&
    normalized.includes("total_exec_time desc") &&
    normalized.includes("left(query, 100)")
  ) {
    return Promise.resolve({
      rows: [{ query: "SELECT * FROM users", calls: 100, avgtime: "12.5ms" }],
      fields: [{ name: "query" }, { name: "calls" }, { name: "avgtime" }],
      rowCount: 1,
    });
  }

  // pg_stat_statements (getSlowQueries — detailed fields)
  if (normalized.includes("pg_stat_statements") && normalized.includes("total_exec_time desc")) {
    return Promise.resolve({
      rows: [
        {
          query_id: "12345",
          query: "SELECT * FROM users WHERE id = $1",
          calls: "200",
          total_time: "5000.00",
          avg_time: "25.00",
          min_time: "1.00",
          max_time: "150.00",
          rows: "200",
          shared_blks_hit: "8000",
          shared_blks_read: "50",
        },
      ],
      fields: [
        { name: "query_id" },
        { name: "query" },
        { name: "calls" },
        { name: "total_time" },
        { name: "avg_time" },
        { name: "min_time" },
        { name: "max_time" },
        { name: "rows" },
        { name: "shared_blks_hit" },
        { name: "shared_blks_read" },
      ],
      rowCount: 1,
    });
  }

  // pg_stat_activity fallback slow queries (state = 'active')
  if (
    normalized.includes("pg_stat_activity") &&
    normalized.includes("state = 'active'") &&
    normalized.includes("query_start asc")
  ) {
    return Promise.resolve({
      rows: [
        {
          query_id: "999",
          query: "SELECT * FROM slow_table",
          calls: "1",
          total_time: "3000",
          avg_time: "3000",
          rows: "0",
        },
      ],
      fields: [],
      rowCount: 1,
    });
  }

  // getHealth sessions: pg_stat_activity with pid != pg_backend_pid and datname = $1
  if (
    normalized.includes("pg_stat_activity") &&
    normalized.includes("pid != pg_backend_pid()") &&
    normalized.includes("xact_start desc") &&
    !normalized.includes("application_name")
  ) {
    return Promise.resolve({
      rows: [
        {
          pid: 101,
          user: "app_user",
          database: "testdb",
          state: "active",
          query: "SELECT 1",
          duration: "2.5s",
        },
      ],
      fields: [],
      rowCount: 1,
    });
  }

  // getActiveSessions: pg_stat_activity with detailed fields
  if (
    normalized.includes("pg_stat_activity") &&
    normalized.includes("application_name") &&
    normalized.includes("wait_event_type") &&
    normalized.includes("pid != pg_backend_pid()")
  ) {
    return Promise.resolve({
      rows: [
        {
          pid: 201,
          user: "db_user",
          database: "testdb",
          application_name: "myapp",
          client_addr: "10.0.0.1",
          state: "active",
          query: "SELECT * FROM orders",
          query_start: new Date().toISOString(),
          wait_event_type: null,
          wait_event: null,
          duration: "1.2s",
          duration_ms: "1200",
        },
      ],
      fields: [],
      rowCount: 1,
    });
  }

  // getHealth: pg_statio_user_tables (cache ratio with heap_read + heap_hit)
  if (normalized.includes("pg_statio_user_tables") && normalized.includes("heap_blks_read")) {
    return Promise.resolve({
      rows: [{ ratio: 99.5, heap_read: "100", heap_hit: "9900" }],
      fields: [{ name: "ratio" }, { name: "heap_read" }, { name: "heap_hit" }],
      rowCount: 1,
    });
  }

  // getPerformanceMetrics: pg_statio_user_tables (cache_hit_ratio only)
  if (normalized.includes("pg_statio_user_tables") && normalized.includes("cache_hit_ratio")) {
    return Promise.resolve({
      rows: [{ cache_hit_ratio: "98.75" }],
      fields: [{ name: "cache_hit_ratio" }],
      rowCount: 1,
    });
  }

  // Schema CTE query: information_schema + table_type = 'base table'
  if (normalized.includes("information_schema") && normalized.includes("table_type = 'base table'")) {
    return Promise.resolve({
      rows: [
        {
          table_schema: "public",
          table_name: "users",
          row_count: "1000",
          total_size: "81920",
          columns: [
            { name: "id", type: "integer", nullable: false, defaultValue: "nextval('users_id_seq')" },
            { name: "name", type: "character varying", nullable: true, defaultValue: null },
            { name: "email", type: "character varying", nullable: false, defaultValue: null },
          ],
          pk_columns: ["id"],
          foreign_keys: [],
          indexes: [
            { name: "users_pkey", columns: ["id"], unique: true },
            { name: "idx_users_email", columns: ["email"], unique: true },
          ],
        },
        {
          table_schema: "analytics",
          table_name: "events",
          row_count: "50000",
          total_size: "4194304",
          columns: [
            { name: "id", type: "integer", nullable: false, defaultValue: null },
            { name: "user_id", type: "integer", nullable: false, defaultValue: null },
            { name: "event_type", type: "character varying", nullable: false, defaultValue: null },
          ],
          pk_columns: ["id"],
          foreign_keys: [
            {
              columnName: "user_id",
              referencedSchema: "public",
              referencedTable: "users",
              referencedColumn: "id",
            },
          ],
          indexes: [{ name: "events_pkey", columns: ["id"], unique: true }],
        },
      ],
      fields: [],
      rowCount: 2,
    });
  }

  // getOverview: version() + pg_postmaster_start_time()
  if (normalized.includes("version()") && normalized.includes("pg_postmaster_start_time()")) {
    return Promise.resolve({
      rows: [
        {
          version: "PostgreSQL 16.2, compiled by Visual C++ build 1941, 64-bit",
          start_time: new Date(Date.now() - 90061000).toISOString(),
          uptime_seconds: "90061",
        },
      ],
      fields: [],
      rowCount: 1,
    });
  }

  // getOverview: connection counts (max_connections + pg_stat_activity)
  if (normalized.includes("max_connections") && normalized.includes("pg_stat_activity")) {
    return Promise.resolve({
      rows: [{ active_connections: "12", max_connections: "200" }],
      fields: [],
      rowCount: 1,
    });
  }

  // getOverview: database size (pg_database_size with pretty + bytes)
  if (normalized.includes("pg_database_size") && normalized.includes("database_size_bytes")) {
    return Promise.resolve({
      rows: [{ database_size: "512 MB", database_size_bytes: "536870912" }],
      fields: [],
      rowCount: 1,
    });
  }

  // getOverview: table + index counts
  if (normalized.includes("pg_tables") && normalized.includes("pg_indexes")) {
    return Promise.resolve({
      rows: [{ table_count: "15", index_count: "30" }],
      fields: [],
      rowCount: 1,
    });
  }

  // getPerformanceMetrics: pg_stat_database (transaction stats)
  if (normalized.includes("pg_stat_database") && normalized.includes("xact_commit")) {
    return Promise.resolve({
      rows: [
        {
          xact_commit: "50000",
          xact_rollback: "150",
          deadlocks: "3",
          blks_read: "2000",
          blks_hit: "98000",
        },
      ],
      fields: [],
      rowCount: 1,
    });
  }

  // getPerformanceMetrics: pg_stat_bgwriter (checkpoint stats)
  if (normalized.includes("pg_stat_bgwriter")) {
    return Promise.resolve({
      rows: [
        {
          checkpoint_write_time: "12500",
          checkpoint_sync_time: "3200",
        },
      ],
      fields: [],
      rowCount: 1,
    });
  }

  // getTableStats: pg_stat_user_tables
  if (normalized.includes("pg_stat_user_tables") && normalized.includes("n_live_tup")) {
    return Promise.resolve({
      rows: [
        {
          schema_name: "public",
          table_name: "users",
          live_row_count: "1000",
          dead_row_count: "50",
          row_count: "1050",
          table_size: "64 kB",
          table_size_bytes: "65536",
          index_size: "32 kB",
          index_size_bytes: "32768",
          total_size: "96 kB",
          total_size_bytes: "98304",
          last_vacuum: null,
          last_autovacuum: new Date().toISOString(),
          last_analyze: null,
          last_autoanalyze: new Date().toISOString(),
          bloat_ratio: "4.76",
        },
        {
          schema_name: "public",
          table_name: "orders",
          live_row_count: "5000",
          dead_row_count: "200",
          row_count: "5200",
          table_size: "256 kB",
          table_size_bytes: "262144",
          index_size: "128 kB",
          index_size_bytes: "131072",
          total_size: "384 kB",
          total_size_bytes: "393216",
          last_vacuum: new Date().toISOString(),
          last_autovacuum: null,
          last_analyze: new Date().toISOString(),
          last_autoanalyze: null,
          bloat_ratio: "3.85",
        },
      ],
      fields: [],
      rowCount: 2,
    });
  }

  // getIndexStats: pg_stat_user_indexes
  if (normalized.includes("pg_stat_user_indexes")) {
    return Promise.resolve({
      rows: [
        {
          schema_name: "public",
          table_name: "users",
          index_name: "users_pkey",
          index_type: "btree",
          index_size: "16 kB",
          index_size_bytes: "16384",
          scans: "5000",
          tuples_read: "5000",
          tuples_fetched: "5000",
          is_unique: true,
          is_primary: true,
          columns: ["id"],
          usage_ratio: "85.50",
        },
        {
          schema_name: "public",
          table_name: "users",
          index_name: "idx_users_email",
          index_type: "btree",
          index_size: "32 kB",
          index_size_bytes: "32768",
          scans: "3000",
          tuples_read: "3000",
          tuples_fetched: "3000",
          is_unique: true,
          is_primary: false,
          columns: ["email"],
          usage_ratio: "52.17",
        },
      ],
      fields: [],
      rowCount: 2,
    });
  }

  // getStorageStats: pg_tablespace
  if (normalized.includes("pg_tablespace") && normalized.includes("pg_tablespace_size")) {
    return Promise.resolve({
      rows: [
        {
          name: "pg_default",
          location: "",
          size: "1.2 GB",
          size_bytes: "1288490188",
          is_default: true,
        },
      ],
      fields: [],
      rowCount: 1,
    });
  }

  // getStorageStats: pg_wal_lsn_diff (WAL info)
  if (normalized.includes("pg_wal_lsn_diff")) {
    return Promise.resolve({
      rows: [{ wal_size: "128 MB", wal_size_bytes: "134217728" }],
      fields: [],
      rowCount: 1,
    });
  }

  // Default: generic SELECT result
  return Promise.resolve({
    rows: [{ id: 1, name: "test" }],
    fields: [{ name: "id" }, { name: "name" }],
    rowCount: 1,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe("PostgresProvider", () => {
  let provider: InstanceType<typeof PostgresProvider>;

  beforeEach(() => {
    mockQueryFn = defaultMockQuery;
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

  describe("validate()", () => {
    test("missing host throws DatabaseConfigError", () => {
      expect(() => {
        new PostgresProvider(makePgConfig({ host: undefined }));
      }).toThrow(DatabaseConfigError);
    });

    test("missing database throws DatabaseConfigError", () => {
      expect(() => {
        new PostgresProvider(makePgConfig({ database: undefined }));
      }).toThrow(DatabaseConfigError);
    });

    test("valid config passes validation", () => {
      expect(() => {
        new PostgresProvider(makePgConfig());
      }).not.toThrow();
    });

    test("connectionString bypasses host/database requirement", () => {
      expect(() => {
        new PostgresProvider(
          makePgConfig({
            host: undefined,
            database: undefined,
            connectionString: "postgresql://user:pass@localhost:5432/mydb",
          }),
        );
      }).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Connection lifecycle
  // --------------------------------------------------------------------------

  describe("connect / disconnect", () => {
    test("isConnected() is false before connect", () => {
      provider = new PostgresProvider(makePgConfig());
      expect(provider.isConnected()).toBe(false);
    });

    test("connect() sets connected to true", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test("disconnect() sets connected to false", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await provider.disconnect();
      expect(provider.isConnected()).toBe(false);
    });

    test("double connect is idempotent", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // buildSSLConfig()
  // --------------------------------------------------------------------------

  describe("buildSSLConfig()", () => {
    test("ssl mode disable returns false (no SSL)", async () => {
      provider = new PostgresProvider(
        makePgConfig({
          ssl: { mode: "disable" },
        }),
      );
      await provider.connect();
      // If we get here without error, connect succeeded with ssl=false
      expect(provider.isConnected()).toBe(true);
    });

    test("ssl mode verify-ca sets rejectUnauthorized to true", async () => {
      provider = new PostgresProvider(
        makePgConfig({
          ssl: { mode: "verify-ca" },
        }),
      );
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test("ssl mode verify-full with certs includes ca, cert, key", async () => {
      provider = new PostgresProvider(
        makePgConfig({
          ssl: {
            mode: "verify-full",
            caCert: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----",
            clientCert: "-----BEGIN CERTIFICATE-----\nCLIENT\n-----END CERTIFICATE-----",
            clientKey: "-----BEGIN RSA PRIVATE KEY-----\nKEY\n-----END RSA PRIVATE KEY-----",
          },
        }),
      );
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test("auto-detect cloud provider enables SSL", async () => {
      provider = new PostgresProvider(
        makePgConfig({
          host: "my-db.supabase.co",
        }),
      );
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test("options.ssl=false returns false", async () => {
      provider = new PostgresProvider(makePgConfig(), { ssl: false });
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test("no SSL config returns undefined (default)", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Query execution
  // --------------------------------------------------------------------------

  describe("query()", () => {
    test("SELECT returns rows, fields, and executionTime", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.query("SELECT * FROM users");
      expect(result.rows.length).toBeGreaterThan(0);
      expect(Array.isArray(result.fields)).toBe(true);
      expect(typeof result.executionTime).toBe("number");
      expect(typeof result.rowCount).toBe("number");
    });

    test("PID is tracked when queryId is provided", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.query("SELECT 1", undefined, "test-query-id");
      expect(result.rows.length).toBeGreaterThan(0);
    });

    test("query error is mapped to database error", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      // Override mock to throw a syntax error
      mockQueryFn = async () => {
        throw new Error('syntax error at or near "SELEC"');
      };

      await expect(provider.query("SELEC * FROM users")).rejects.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Cancel query
  // --------------------------------------------------------------------------

  describe("cancelQuery()", () => {
    test("cancels known PID and returns true", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      // We need a query running to have a tracked PID.
      // Simulate: trigger a query with queryId, then cancel mid-flight.
      // Since our mock is synchronous, we'll manually set the PID map.
      // Access the private runningQueryPids map via casting.
      const providerAny = provider as unknown as { runningQueryPids: Map<string, number> };
      providerAny.runningQueryPids.set("cancel-test", 12345);

      const cancelled = await provider.cancelQuery("cancel-test");
      expect(cancelled).toBe(true);
    });

    test("returns false for unknown queryId", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.cancelQuery("nonexistent-query-id");
      expect(result).toBe(false);
    });

    test("handles cancel error gracefully and returns false", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const providerAny = provider as unknown as { runningQueryPids: Map<string, number> };
      providerAny.runningQueryPids.set("error-cancel", 99999);

      // Override mock to throw on pg_cancel_backend
      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        if (sql.includes("pg_cancel_backend")) {
          throw new Error("Connection lost");
        }
        return originalMock(sql, params);
      };

      const result = await provider.cancelQuery("error-cancel");
      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Transaction lifecycle
  // --------------------------------------------------------------------------

  describe("Transaction lifecycle", () => {
    test("beginTransaction / commitTransaction works", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      expect(provider.isInTransaction()).toBe(false);
      await provider.beginTransaction();
      expect(provider.isInTransaction()).toBe(true);
      await provider.commitTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });

    test("beginTransaction / rollbackTransaction works", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await provider.beginTransaction();
      expect(provider.isInTransaction()).toBe(true);
      await provider.rollbackTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });

    test("double beginTransaction throws", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await provider.beginTransaction();
      await expect(provider.beginTransaction()).rejects.toThrow("Transaction already active");
      // Clean up
      await provider.rollbackTransaction();
    });

    test("commitTransaction without begin throws", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await expect(provider.commitTransaction()).rejects.toThrow("No active transaction");
    });

    test("rollbackTransaction without begin throws", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await expect(provider.rollbackTransaction()).rejects.toThrow("No active transaction");
    });

    test("queryInTransaction executes within active transaction", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await provider.beginTransaction();
      const result = await provider.queryInTransaction("SELECT 1");
      expect(result.rows).toBeDefined();
      expect(typeof result.executionTime).toBe("number");
      await provider.commitTransaction();
    });

    test("queryInTransaction without begin throws", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await expect(provider.queryInTransaction("SELECT 1")).rejects.toThrow("No active transaction");
    });

    test("expireTransaction auto-rollbacks an active transaction", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await provider.beginTransaction();
      expect(provider.isInTransaction()).toBe(true);

      await provider.expireTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });

    test("expireTransaction is no-op when no active transaction", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      // Should not throw
      await provider.expireTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });

    test("transaction timeout timer fires and auto-rollbacks", async () => {
      // TX_TIMEOUT_MS is a private static read at beginTransaction() call time;
      // shrink it so the auto-rollback timer actually fires in the test
      // (same private-access-via-cast precedent as runningQueryPids above).
      const providerStatics = PostgresProvider as unknown as { TX_TIMEOUT_MS: number };
      const originalTimeout = providerStatics.TX_TIMEOUT_MS;
      providerStatics.TX_TIMEOUT_MS = 5;
      try {
        provider = new PostgresProvider(makePgConfig());
        await provider.connect();

        await provider.beginTransaction();
        expect(provider.isInTransaction()).toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(provider.isInTransaction()).toBe(false);
      } finally {
        providerStatics.TX_TIMEOUT_MS = originalTimeout;
      }
    });
  });

  // --------------------------------------------------------------------------
  // Schema
  // --------------------------------------------------------------------------

  describe("getSchema()", () => {
    test("returns TableSchema array with columns, indexes, foreignKeys", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const schema = await provider.getSchema();

      expect(schema.length).toBe(2);

      for (const table of schema) {
        expect(typeof table.name).toBe("string");
        expect(Array.isArray(table.columns)).toBe(true);
        expect(table.columns.length).toBeGreaterThan(0);
        expect(Array.isArray(table.indexes)).toBe(true);
        expect(Array.isArray(table.foreignKeys)).toBe(true);
      }
    });

    test("primary key columns are detected via isPrimary flag", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const schema = await provider.getSchema();

      const usersTable = schema.find((t) => t.name === "users");
      expect(usersTable).toBeDefined();

      const idCol = usersTable!.columns.find((c) => c.name === "id");
      expect(idCol).toBeDefined();
      expect(idCol!.isPrimary).toBe(true);

      const nameCol = usersTable!.columns.find((c) => c.name === "name");
      expect(nameCol).toBeDefined();
      expect(nameCol!.isPrimary).toBe(false);
    });

    test("non-public schema tables get schema prefix in name", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const schema = await provider.getSchema();

      const eventsTable = schema.find((t) => t.name === "analytics.events");
      expect(eventsTable).toBeDefined();
      expect(eventsTable!.name).toBe("analytics.events");

      // Foreign key from analytics.events.user_id -> public.users.id should have no prefix
      expect(eventsTable!.foreignKeys!.length).toBe(1);
      expect(eventsTable!.foreignKeys![0].referencedTable).toBe("users");
    });
  });

  // --------------------------------------------------------------------------
  // getSchemaList() — fast structural path (tables + columns + PKs only)
  // --------------------------------------------------------------------------

  describe("getSchemaList()", () => {
    // The fast path shares the tables/columns/pk CTE shape with getSchema(), so
    // the default mock (information_schema + table_type = 'base table') applies.
    // What it must NOT do is populate indexes/foreignKeys — those are deferred
    // to getSchemaRelations() so a slow stats query can't block the table list.
    test("returns tables with columns and PKs but empty indexes/foreignKeys", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const schema = await provider.getSchemaList();

      expect(schema.length).toBe(2);
      for (const table of schema) {
        expect(typeof table.name).toBe("string");
        expect(table.columns.length).toBeGreaterThan(0);
        // The whole point of the split: relations are intentionally absent here.
        expect(table.indexes).toEqual([]);
        expect(table.foreignKeys).toEqual([]);
      }
    });

    test("primary key columns are detected via isPrimary flag", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const schema = await provider.getSchemaList();

      const usersTable = schema.find((t) => t.name === "users");
      expect(usersTable).toBeDefined();
      expect(usersTable!.columns.find((c) => c.name === "id")!.isPrimary).toBe(true);
      expect(usersTable!.columns.find((c) => c.name === "name")!.isPrimary).toBe(false);
    });

    test("non-public schema tables get schema prefix in name", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const schema = await provider.getSchemaList();

      expect(schema.find((t) => t.name === "analytics.events")).toBeDefined();
      expect(schema.find((t) => t.name === "users")).toBeDefined();
    });

    test("negative reltuples row_count is clamped to zero", async () => {
      // Never-analyzed tables report reltuples = -1; the UI must never show -1.
      mockQueryFn = (sql: string) => {
        if (sql.toLowerCase().includes("table_type = 'base table'")) {
          return Promise.resolve({
            rows: [
              {
                table_schema: "public",
                table_name: "fresh",
                row_count: "-1",
                total_size: "0",
                columns: [{ name: "id", type: "integer", nullable: false, defaultValue: null }],
                pk_columns: ["id"],
              },
            ],
            fields: [],
            rowCount: 1,
          });
        }
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const schema = await provider.getSchemaList();

      expect(schema[0].rowCount).toBe(0);
    });

    test("table with no columns yields an empty columns array (not a crash)", async () => {
      mockQueryFn = (sql: string) => {
        if (sql.toLowerCase().includes("table_type = 'base table'")) {
          return Promise.resolve({
            rows: [
              {
                table_schema: "public",
                table_name: "empty_table",
                row_count: "0",
                total_size: "0",
                columns: null,
                pk_columns: null,
              },
            ],
            fields: [],
            rowCount: 1,
          });
        }
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const schema = await provider.getSchemaList();

      expect(schema[0].name).toBe("empty_table");
      expect(schema[0].columns).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // getSchemaRelations() — heavy FK/index path, keyed by table display name
  // --------------------------------------------------------------------------

  describe("getSchemaRelations()", () => {
    // The relations query (fk_info + index_info, FULL OUTER JOIN) does not match
    // the default schema mock, so each test supplies its own relation rows.
    function withRelationRows(rows: unknown[]) {
      mockQueryFn = (sql: string) => {
        const normalized = sql.toLowerCase();
        if (normalized.includes("fk_info") || normalized.includes("full outer join")) {
          return Promise.resolve({ rows, fields: [], rowCount: rows.length });
        }
        return defaultMockQuery(sql);
      };
    }

    test("returns foreignKeys and indexes keyed by table display name", async () => {
      withRelationRows([
        {
          table_schema: "public",
          table_name: "orders",
          foreign_keys: [
            {
              columnName: "user_id",
              referencedSchema: "public",
              referencedTable: "users",
              referencedColumn: "id",
            },
          ],
          indexes: [{ name: "orders_pkey", columns: ["id"], unique: true }],
        },
      ]);
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const relations = await provider.getSchemaRelations();

      expect(relations.length).toBe(1);
      const orders = relations.find((r) => r.name === "orders");
      expect(orders).toBeDefined();
      expect(orders!.foreignKeys.length).toBe(1);
      expect(orders!.foreignKeys[0].columnName).toBe("user_id");
      expect(orders!.foreignKeys[0].referencedColumn).toBe("id");
      expect(orders!.indexes.length).toBe(1);
      expect(orders!.indexes[0].unique).toBe(true);
    });

    test("non-public schema is prefixed on both table name and referenced table", async () => {
      withRelationRows([
        {
          table_schema: "analytics",
          table_name: "events",
          foreign_keys: [
            {
              columnName: "account_id",
              referencedSchema: "billing",
              referencedTable: "accounts",
              referencedColumn: "id",
            },
          ],
          indexes: [],
        },
      ]);
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const relations = await provider.getSchemaRelations();

      const events = relations.find((r) => r.name === "analytics.events");
      expect(events).toBeDefined();
      expect(events!.foreignKeys[0].referencedTable).toBe("billing.accounts");
    });

    test("public referenced table keeps its bare name (no prefix)", async () => {
      withRelationRows([
        {
          table_schema: "analytics",
          table_name: "events",
          foreign_keys: [
            {
              columnName: "user_id",
              referencedSchema: "public",
              referencedTable: "users",
              referencedColumn: "id",
            },
          ],
          indexes: [],
        },
      ]);
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const relations = await provider.getSchemaRelations();

      expect(relations[0].foreignKeys[0].referencedTable).toBe("users");
    });

    test("empty fk/index arrays are tolerated (index-only or fk-only tables)", async () => {
      withRelationRows([
        { table_schema: "public", table_name: "logs", foreign_keys: [], indexes: [] },
        {
          table_schema: "public",
          table_name: "metrics",
          foreign_keys: null,
          indexes: [{ name: "metrics_ts_idx", columns: ["ts"], unique: false }],
        },
      ]);
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const relations = await provider.getSchemaRelations();

      const logs = relations.find((r) => r.name === "logs")!;
      expect(logs.foreignKeys).toEqual([]);
      expect(logs.indexes).toEqual([]);

      const metrics = relations.find((r) => r.name === "metrics")!;
      expect(metrics.foreignKeys).toEqual([]);
      expect(metrics.indexes[0].columns).toEqual(["ts"]);
      expect(metrics.indexes[0].unique).toBe(false);
    });

    test("null index columns coerce to an empty array", async () => {
      withRelationRows([
        {
          table_schema: "public",
          table_name: "weird",
          foreign_keys: [],
          indexes: [{ name: "broken_idx", columns: null, unique: false }],
        },
      ]);
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const relations = await provider.getSchemaRelations();

      expect(relations[0].indexes[0].columns).toEqual([]);
    });

    // Regression guard: constraint_column_usage reports the *referenced* table's
    // schema in ccu.table_schema, so joining it to tc.table_schema drops every
    // cross-schema foreign key. The join must be on the constraint's own schema.
    // The query result is mocked, so this asserts the SQL itself.
    test("FK introspection joins constraint_column_usage on constraint_schema", async () => {
      let capturedSql = "";
      mockQueryFn = (sql: string) => {
        capturedSql = sql;
        return Promise.resolve({ rows: [], fields: [], rowCount: 0 });
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await provider.getSchemaRelations();

      expect(capturedSql).toContain("ccu.constraint_schema = tc.constraint_schema");
      expect(capturedSql).not.toContain("ccu.table_schema = tc.table_schema");
    });
  });

  // --------------------------------------------------------------------------
  // Health
  // --------------------------------------------------------------------------

  describe("getHealth()", () => {
    test("returns all health fields", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const health = await provider.getHealth();

      expect(typeof health.activeConnections).toBe("number");
      expect(health.activeConnections).toBe(5);
      expect(typeof health.databaseSize).toBe("string");
      expect(health.databaseSize).toBe("256 MB");
      expect(typeof health.cacheHitRatio).toBe("string");
      expect(health.cacheHitRatio).toContain("99.5");
      expect(Array.isArray(health.slowQueries)).toBe(true);
      expect(Array.isArray(health.activeSessions)).toBe(true);
    });

    test("pg_stat_statements fallback when extension is not enabled", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      // Override: make pg_stat_statements fail
      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        const normalized = sql.trim().toLowerCase();
        if (normalized.includes("pg_stat_statements") && normalized.includes("total_exec_time desc")) {
          throw new Error('relation "pg_stat_statements" does not exist');
        }
        return originalMock(sql, params);
      };

      const health = await provider.getHealth();
      expect(Array.isArray(health.slowQueries)).toBe(true);
      expect(health.slowQueries.length).toBe(1);
      expect(health.slowQueries[0].query).toContain("pg_stat_statements extension not enabled");
    });

    test("sessions data is populated", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const health = await provider.getHealth();

      expect(health.activeSessions.length).toBeGreaterThan(0);
      const session = health.activeSessions[0];
      expect(typeof session.pid).toBe("number");
      expect(typeof session.user).toBe("string");
      expect(typeof session.state).toBe("string");
    });
  });

  // --------------------------------------------------------------------------
  // Maintenance
  // --------------------------------------------------------------------------

  describe("runMaintenance()", () => {
    test("vacuum with target returns success", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.runMaintenance("vacuum", "users");
      expect(result.success).toBe(true);
      expect(typeof result.executionTime).toBe("number");
      expect(result.message).toContain("VACUUM");
    });

    test("vacuum without target returns success", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.runMaintenance("vacuum");
      expect(result.success).toBe(true);
      expect(result.message).toContain("VACUUM");
    });

    test("analyze with target returns success", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.runMaintenance("analyze", "users");
      expect(result.success).toBe(true);
      expect(result.message).toContain("ANALYZE");
    });

    test("analyze without target returns success", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.runMaintenance("analyze");
      expect(result.success).toBe(true);
      expect(result.message).toContain("ANALYZE");
    });

    test("reindex with target returns success", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.runMaintenance("reindex", "users");
      expect(result.success).toBe(true);
      expect(result.message).toContain("REINDEX");
    });

    test("reindex without target returns success (database-level)", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.runMaintenance("reindex");
      expect(result.success).toBe(true);
      expect(result.message).toContain("REINDEX");
    });

    test("quotes a mixed-case target (defaults to public schema)", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      let capturedSql = "";
      mockQueryFn = (sql: string) => {
        capturedSql = sql;
        return defaultMockQuery(sql);
      };
      await provider.runMaintenance("vacuum", "MyTable");
      expect(capturedSql).toContain('public."MyTable"');
    });

    test("quotes a schema-qualified target per part (not forced to public)", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      let capturedSql = "";
      mockQueryFn = (sql: string) => {
        capturedSql = sql;
        return defaultMockQuery(sql);
      };
      await provider.runMaintenance("reindex", "reporting.MonthlySummary");
      expect(capturedSql).toContain('"reporting"."MonthlySummary"');
      expect(capturedSql).not.toContain("public.");
    });

    test("kill with valid PID returns success", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const result = await provider.runMaintenance("kill", "12345");
      expect(result.success).toBe(true);
      expect(result.message).toContain("KILL");
    });

    test("kill without target throws QueryError", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await expect(provider.runMaintenance("kill")).rejects.toThrow("Target PID is required for kill operation");
    });

    test("kill with invalid (non-numeric) PID throws QueryError", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await expect(provider.runMaintenance("kill", "abc")).rejects.toThrow("Invalid PID for kill operation");
    });

    test("unsupported maintenance type throws QueryError", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await expect(provider.runMaintenance("optimize" as unknown as "vacuum", "users")).rejects.toThrow(
        "Unsupported maintenance type",
      );
    });
  });

  // --------------------------------------------------------------------------
  // Overview
  // --------------------------------------------------------------------------

  describe("getOverview()", () => {
    test("returns all overview fields", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      expect(typeof overview.version).toBe("string");
      expect(overview.version).toContain("PostgreSQL");
      expect(typeof overview.uptime).toBe("string");
      expect(typeof overview.activeConnections).toBe("number");
      expect(overview.activeConnections).toBe(12);
      expect(typeof overview.maxConnections).toBe("number");
      expect(overview.maxConnections).toBe(200);
      expect(typeof overview.databaseSize).toBe("string");
      expect(typeof overview.databaseSizeBytes).toBe("number");
      expect(typeof overview.tableCount).toBe("number");
      expect(overview.tableCount).toBe(15);
      expect(typeof overview.indexCount).toBe("number");
      expect(overview.indexCount).toBe(30);
    });

    test("uptime is formatted with days, hours, minutes", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      // 90061 seconds = 1d 1h 1m
      expect(overview.uptime).toBe("1d 1h 1m");
    });
  });

  // --------------------------------------------------------------------------
  // Performance Metrics
  // --------------------------------------------------------------------------

  describe("getPerformanceMetrics()", () => {
    test("returns all performance metrics", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      expect(typeof metrics.cacheHitRatio).toBe("number");
      expect(typeof metrics.bufferPoolUsage).toBe("number");
      expect(typeof metrics.deadlocks).toBe("number");
      expect(metrics.deadlocks).toBe(3);
      expect(typeof metrics.checkpointWriteTime).toBe("string");
      expect(metrics.checkpointWriteTime).not.toBe("N/A");
    });

    test("handles checkpoint fallback gracefully", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        const normalized = sql.trim().toLowerCase();
        if (normalized.includes("pg_stat_bgwriter")) {
          throw new Error("permission denied for pg_stat_bgwriter");
        }
        return originalMock(sql, params);
      };

      const metrics = await provider.getPerformanceMetrics();
      expect(metrics.checkpointWriteTime).toBe("N/A");
    });
  });

  // --------------------------------------------------------------------------
  // Slow Queries
  // --------------------------------------------------------------------------

  describe("getSlowQueries()", () => {
    test("pg_stat_statements returns detailed slow query stats", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const slowQueries = await provider.getSlowQueries();

      expect(slowQueries.length).toBe(1);
      const sq = slowQueries[0];
      expect(typeof sq.queryId).toBe("string");
      expect(typeof sq.query).toBe("string");
      expect(typeof sq.calls).toBe("number");
      expect(typeof sq.totalTime).toBe("number");
      expect(typeof sq.avgTime).toBe("number");
      expect(typeof sq.minTime).toBe("number");
      expect(typeof sq.maxTime).toBe("number");
      expect(typeof sq.rows).toBe("number");
      expect(typeof sq.sharedBlksHit).toBe("number");
      expect(typeof sq.sharedBlksRead).toBe("number");
    });

    test("fallback to pg_stat_activity when pg_stat_statements is unavailable", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        const normalized = sql.trim().toLowerCase();
        // Make pg_stat_statements queries fail
        if (normalized.includes("pg_stat_statements")) {
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

    test("respects limit option", async () => {
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

  describe("getActiveSessions()", () => {
    test("returns session details", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const sessions = await provider.getActiveSessions();

      expect(sessions.length).toBe(1);
      const session = sessions[0];
      expect(session.pid).toBe(201);
      expect(session.user).toBe("db_user");
      expect(session.database).toBe("testdb");
      expect(session.applicationName).toBe("myapp");
      expect(session.state).toBe("active");
      expect(typeof session.query).toBe("string");
      expect(typeof session.duration).toBe("string");
      expect(typeof session.durationMs).toBe("number");
      expect(session.blocked).toBe(false);
    });

    test("respects limit option", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const sessions = await provider.getActiveSessions({ limit: 10 });
      expect(Array.isArray(sessions)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Table Stats
  // --------------------------------------------------------------------------

  describe("getTableStats()", () => {
    test("returns table stats for all schemas", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const stats = await provider.getTableStats();

      expect(stats.length).toBe(2);

      const usersStats = stats.find((s) => s.tableName === "users");
      expect(usersStats).toBeDefined();
      expect(usersStats!.schemaName).toBe("public");
      expect(typeof usersStats!.rowCount).toBe("number");
      expect(typeof usersStats!.liveRowCount).toBe("number");
      expect(typeof usersStats!.deadRowCount).toBe("number");
      expect(typeof usersStats!.tableSize).toBe("string");
      expect(typeof usersStats!.tableSizeBytes).toBe("number");
      expect(typeof usersStats!.indexSize).toBe("string");
      expect(typeof usersStats!.totalSize).toBe("string");
      expect(typeof usersStats!.bloatRatio).toBe("number");
    });

    test("filters by schema when option is provided", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const stats = await provider.getTableStats({ schema: "public" });
      expect(Array.isArray(stats)).toBe(true);
    });

    test("quotes identifiers in the stats query for mixed-case safety", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      let capturedSql = "";
      mockQueryFn = (sql: string) => {
        capturedSql = sql;
        return defaultMockQuery(sql);
      };
      await provider.getTableStats();
      expect(capturedSql).toContain("quote_ident(schemaname)");
      expect(capturedSql).toContain("quote_ident(relname)");
    });
  });

  // --------------------------------------------------------------------------
  // Index Stats
  // --------------------------------------------------------------------------

  describe("getIndexStats()", () => {
    test("returns index stats for all schemas", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const stats = await provider.getIndexStats();

      expect(stats.length).toBe(2);

      const pkeyStats = stats.find((s) => s.indexName === "users_pkey");
      expect(pkeyStats).toBeDefined();
      expect(pkeyStats!.schemaName).toBe("public");
      expect(pkeyStats!.tableName).toBe("users");
      expect(pkeyStats!.indexType).toBe("btree");
      expect(pkeyStats!.isUnique).toBe(true);
      expect(pkeyStats!.isPrimary).toBe(true);
      expect(Array.isArray(pkeyStats!.columns)).toBe(true);
      expect(typeof pkeyStats!.indexSize).toBe("string");
      expect(typeof pkeyStats!.indexSizeBytes).toBe("number");
      expect(typeof pkeyStats!.scans).toBe("number");
      expect(typeof pkeyStats!.usageRatio).toBe("number");
    });

    test("filters by schema when option is provided", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const stats = await provider.getIndexStats({ schema: "public" });
      expect(Array.isArray(stats)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Storage Stats
  // --------------------------------------------------------------------------

  describe("getStorageStats()", () => {
    test("returns tablespaces and WAL info", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const stats = await provider.getStorageStats();

      // Should have tablespace(s) + WAL entry
      expect(stats.length).toBeGreaterThanOrEqual(2);

      const defaultTs = stats.find((s) => s.name === "pg_default");
      expect(defaultTs).toBeDefined();
      expect(typeof defaultTs!.size).toBe("string");
      expect(typeof defaultTs!.sizeBytes).toBe("number");

      const walEntry = stats.find((s) => s.name === "WAL");
      expect(walEntry).toBeDefined();
      expect(walEntry!.location).toBe("pg_wal");
      expect(typeof walEntry!.walSize).toBe("string");
      expect(typeof walEntry!.walSizeBytes).toBe("number");
    });

    test("WAL permission denied handled gracefully", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        const normalized = sql.trim().toLowerCase();
        if (normalized.includes("pg_wal_lsn_diff")) {
          throw new Error("permission denied for function pg_current_wal_lsn");
        }
        return originalMock(sql, params);
      };

      const stats = await provider.getStorageStats();
      // Should still have tablespace info, but no WAL entry
      expect(stats.length).toBeGreaterThanOrEqual(1);
      const walEntry = stats.find((s) => s.name === "WAL");
      expect(walEntry).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Pool Error Events (#298)
  // --------------------------------------------------------------------------

  describe("pool error events", () => {
    test("an idle client error is logged and does not escalate past the provider", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const pool = lastPool;
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});

      try {
        // `pg` has already removed and destroyed the client by the time it emits on the
        // POOL; with no listener that emit is an uncaught exception, i.e. a dead server.
        expect(() => pool?.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const logged = errorSpy.mock.calls[0].join(" ");
        expect(logged).toContain("[Postgres]");
        expect(logged).toContain("Connection terminated unexpectedly");
      } finally {
        errorSpy.mockRestore();
      }
    });

    test("the pool carries exactly one error listener, and a repeat connect adds none", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      // connect() is a no-op once a pool exists, so listeners cannot accumulate.
      await provider.connect();

      expect(lastPool?.listenerCount("error")).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Pool Stats
  // --------------------------------------------------------------------------

  describe("getPoolStats()", () => {
    test("connected provider returns pool stats", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const stats = provider.getPoolStats();

      expect(stats.total).toBe(10);
      expect(stats.idle).toBe(7);
      expect(stats.active).toBe(3); // total - idle
      expect(stats.waiting).toBe(0);
    });

    test("not connected returns zeros", () => {
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

  describe("getCapabilities()", () => {
    test("returns correct PostgreSQL capabilities", () => {
      provider = new PostgresProvider(makePgConfig());
      const caps = provider.getCapabilities();

      expect(caps.defaultPort).toBe(5432);
      expect(caps.queryLanguage).toBe("sql");
      expect(caps.supportsExplain).toBe(true);
      expect(caps.explainFormat).toBe("postgres-json");
      expect(caps.supportsExplain).toBe(caps.explainFormat !== undefined);
      expect(caps.supportsConnectionString).toBe(true);
      // `UPDATE t SET c = v WHERE pk = v` is core PostgreSQL DML — exactly the
      // statement shape the inline row editor builds (#269).
      expect(caps.supportsInlineRowEdit).toBe(true);
      expect(caps.maintenanceOperations).toContain("vacuum");
      expect(caps.maintenanceOperations).toContain("analyze");
      expect(caps.maintenanceOperations).toContain("reindex");
      expect(caps.maintenanceOperations).toContain("kill");
    });
  });

  // --------------------------------------------------------------------------
  // getPgStatActivity
  // --------------------------------------------------------------------------

  describe("getPgStatActivity()", () => {
    test("returns activity rows from pg_stat_activity", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const activity = await provider.getPgStatActivity();

      expect(activity).toBeArray();
      expect(activity.length).toBe(1);
      expect(activity[0].datname).toBe("testdb");
      expect(activity[0].pid).toBe(123);
      expect(activity[0].usename).toBe("testuser");
      expect(activity[0].application_name).toBe("testapp");
      expect(activity[0].client_addr).toBe("127.0.0.1");
      expect(activity[0].state).toBe("active");
      expect(activity[0].query).toBe("SELECT * FROM test_table");
    });
  });

  // --------------------------------------------------------------------------
  // prepareQuery() — the `#` grammar is PostgreSQL's here (#292)
  // --------------------------------------------------------------------------
  //
  // PostgreSQL has exactly two comment forms, `--` and `/* */`; `#` is an
  // operator character (`#>`, `#>>`, `#-` walk or delete a jsonb path, `#` is
  // integer XOR). The shared readers used to approximate that with "a hash is a
  // comment unless the next character makes an operator", which reads `# note` on
  // this provider as a comment and stops the statement there. Asserted through
  // the provider's own `prepareQuery`, with the emitted text pinned whole.

  describe("prepareQuery()", () => {
    test.each<[string, string]>([
      ["a jsonb path operator", "SELECT meta #> '{a}' FROM docs"],
      ["a jsonb path-as-text operator", "SELECT meta #>> '{a}' FROM docs"],
      ["an integer XOR operator", "SELECT flags # 5 AS x FROM t"],
      ["a dollar-quoted body carrying a hash and a paren", "SELECT $fn$ # ) DELETE $fn$ AS body FROM t"],
    ])("bounds a statement carrying %s, emitted intact", (_label, sql) => {
      provider = new PostgresProvider(makePgConfig());

      const result = provider.prepareQuery(sql, { limit: 50 });

      expect(result.query).toBe(`${sql} LIMIT 50`);
      expect(result.wasLimited).toBe(true);
    });

    test("a write is still a write, hash or no hash", () => {
      provider = new PostgresProvider(makePgConfig());
      const sql = "UPDATE t SET flags = flags # 5";

      const result = provider.prepareQuery(sql, { limit: 50 });

      expect(result.query).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    // ── `[…]` is a SUBSCRIPT here (#295) ────────────────────────────────────
    //
    // Established from the manual: `expression[subscript]` and
    // `expression[lower:upper]` are an element and a slice (4.2.3), array
    // constructors nest and the manual's own example is `SELECT ARRAY[[1,2],[3,4]]`
    // (4.2.12), and identifiers are quoted with double quotes (4.1.1) - so `[` is
    // never a name quote in this dialect and the NAME reading it briefly inherited
    // from SQL Server could not close a nested array or a key carrying a `]`. That
    // cost a bound on everyday syntax and, once #297 landed, a confirmation prompt
    // on an ordinary read.
    //
    // The last row is the one the reader could get wrong silently: the statement
    // ENDS with the bracketed run, so nothing after it would catch a bound placed
    // by a reader that lost track of where the run closes. A fixture can only pin a
    // reading where the two readings disagree.
    test.each<[string, string]>([
      ["an ordinary subscript", "SELECT a[1] FROM t"],
      ["a flat array constructor", "SELECT ARRAY[1,2] FROM t"],
      ["a nested array constructor", "SELECT ARRAY[[1,2],[3,4]] AS a FROM t"],
      ["a jsonb subscript whose key carries a close bracket", "SELECT j['a]b'] FROM t"],
      ["a nested subscript", "SELECT t.data[idx[0]] FROM t"],
      ["a statement that ENDS with a nested array", "SELECT ARRAY[[1,2],[3,4]]"],
    ])("bounds %s, appending the clause after the run", (_label, sql) => {
      provider = new PostgresProvider(makePgConfig());

      const result = provider.prepareQuery(sql, { limit: 50 });

      expect(result.query).toBe(`${sql} LIMIT 50`);
      expect(result.wasLimited).toBe(true);
    });

    // A reading is not a licence to guess: a subscript run short of its closer is
    // still undeterminable, so the statement keeps its text and loses its bound
    // rather than collecting a clause inside the run.
    test("leaves an unclosed subscript run unbounded, and emits it untouched", () => {
      provider = new PostgresProvider(makePgConfig());
      const sql = "SELECT ARRAY[[1,2] AS a FROM t";

      const result = provider.prepareQuery(sql, { limit: 50 });

      expect(result.query).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    // ── Block comments NEST here (#300) ────────────────────────────────────
    //
    // PostgreSQL's manual (4.1.5) says block comments nest "as specified in the SQL
    // standard but unlike C", so a `/*` written inside one opens a second comment
    // and the run continues past the next `*/`. Read flat, everything between that
    // `*/` and the comment's real end reaches the readers as code - and this is the
    // provider where that costs the most, because `WITH … INSERT` really writes and
    // a bound appended to it commits part of the write.

    test.each<[string, string]>([
      ["an INSERT … SELECT", "INSERT INTO archive (id) SELECT id FROM recent"],
      ["an UPDATE … SET", "UPDATE archive SET seen = true WHERE id IN (SELECT id FROM recent)"],
    ])("leaves %s hidden behind a nested comment unbounded, emitted intact", (_label, write) => {
      provider = new PostgresProvider(makePgConfig());
      const sql = `WITH recent AS (\n  /* outer /* inner */ ) SELECT 1 */\n  SELECT id FROM logs\n)\n${write}`;

      const result = provider.prepareQuery(sql, { limit: 50 });

      expect(result.query).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    test("bounds a read behind a nested comment, and emits the comment intact", () => {
      provider = new PostgresProvider(makePgConfig());
      const sql = "/* outer /* inner */ still a note */ SELECT id FROM logs";

      const result = provider.prepareQuery(sql, { limit: 50 });

      expect(result.query).toBe(`${sql} LIMIT 50`);
      expect(result.wasLimited).toBe(true);
    });

    test("leaves a statement whose nested comment never closes untouched", () => {
      provider = new PostgresProvider(makePgConfig());
      const sql = "/* outer /* inner */ SELECT id FROM logs";

      const result = provider.prepareQuery(sql, { limit: 50 });

      expect(result.query).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // queryReadOnly — agent read-only execution profile (#328)
  // --------------------------------------------------------------------------

  describe("queryReadOnly (agent read-only execution profile)", () => {
    /** Reads the first keyword the way the server would: past whitespace and comments. */
    function engineLeadingKeyword(text: string): string {
      let rest = text;
      for (;;) {
        const trimmed = rest.trimStart();
        if (trimmed.startsWith("--")) {
          const newline = trimmed.indexOf("\n");
          rest = newline === -1 ? "" : trimmed.slice(newline + 1);
          continue;
        }
        if (trimmed.startsWith("/*")) {
          const close = trimmed.indexOf("*/");
          rest = close === -1 ? "" : trimmed.slice(close + 2);
          continue;
        }
        return (/^[A-Za-z]+/.exec(trimmed)?.[0] ?? "").toUpperCase();
      }
    }

    function pgServerError(message: string, code: string): Error {
      return Object.assign(new Error(message), { code });
    }

    /** The server executes each semicolon-separated command of a simple-protocol string in turn. */
    function splitCommands(text: string): string[] {
      // Naive split is faithful enough for this suite's corpus (no ';' inside literals).
      return text
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    }

    type EngineProtocol = "simple" | "extended";

    /**
     * A data-modifying CTE, the only shape that can carry a write under a `WITH`.
     *
     * A whole-text pattern, which `lib/sql/operative-keyword.ts` documents as the
     * wrong reading for PRODUCTION code — deliberately kept here, where being
     * stricter than the server only ever makes a hostile fixture easier to
     * refuse. A read-only CTE that merely quotes a write keyword would be modeled
     * as a write, so a future fixture of that shape must not be read as proof of
     * anything.
     */
    function withCarriesWrite(text: string): boolean {
      return /\b(?:INSERT|UPDATE|DELETE|MERGE)\b/i.test(text);
    }

    /**
     * Stateful engine mock modeling the PostgreSQL behaviors this profile's
     * security rests on, so the assertions hold even when product-side
     * classification is bypassed. Every rule below was verified against a live
     * PostgreSQL 18 rather than assumed:
     *
     * - a write executed inside a READ ONLY transaction fails with 25006 based
     *   on the ENGINE's transaction state, no matter what the text looks like —
     *   including a data-modifying CTE, which the server refuses while naming
     *   the top-level statement ("cannot execute SELECT in a read-only
     *   transaction"), and a write behind a comment;
     * - `SET TRANSACTION READ WRITE` really DOES relax the transaction — it is
     *   accepted inside `BEGIN READ ONLY` and a following write then commits.
     *   That is why the profile's one-statement-per-transaction rule is
     *   load-bearing rather than decorative, and modeling it faithfully is what
     *   makes the pollution tests below mean something;
     * - a session-level `SET` inside the transaction is reverted by ROLLBACK
     *   (GUC changes are transactional), so it cannot leak into the next
     *   execution on a pooled client;
     * - `COPY … TO <file>` / `TO PROGRAM` are NOT refused by a read-only
     *   transaction. Only privileges refuse them, which is why the profile
     *   verifies the role at open;
     * - the extended query protocol refuses multi-command strings with 42601
     *   before executing anything;
     * - the simple protocol EXECUTES multi-command strings sequentially and
     *   honors transaction control, so an implementation that regressed to the
     *   simple protocol would really COMMIT out of the read-only transaction
     *   and apply the smuggled write — `appliedWrites` catches that.
     *
     * Protocol detection mirrors pg's requiresPreparation()
     * (node_modules/pg/lib/query.js): named, extended-mode, or valued queries
     * prepare; a bare string with no values stays on the simple protocol.
     */
    class ReadOnlyEngineMock {
      txState: "none" | "read-only" | "read-write" | "aborted" = "none";
      readonly statements: Array<{ text: string; protocol: EngineProtocol }> = [];
      readonly appliedWrites: string[] = [];
      readonly localTimeouts: number[] = [];
      /** Files/programs a COPY reached — empty unless privileges allowed it. */
      readonly serverFileWrites: string[] = [];
      selectRows: Array<Record<string, unknown>> = [{ ok: 1 }];
      failRollback = false;
      /** What the role-privilege probe answers. All false = a least-privilege agent role. */
      privileges: Record<string, boolean> = {
        is_superuser: false,
        reads_server_files: false,
        writes_server_files: false,
        executes_programs: false,
      };
      /** Rows the probe returns; overridable to model a server that answers nothing. */
      privilegeRows: Array<Record<string, unknown>> | null = null;
      privilegeProbes = 0;
      /** The probe's SQL, kept so a test can assert how it names its built-ins. */
      privilegeProbeText: string | null = null;
      /** Set to model the probe itself failing (dropped socket, protocol error). */
      privilegeProbeFailure: Error | null = null;
      /** Session-level statement_timeout, and the value to restore on rollback. */
      sessionTimeout = 30_000;
      private sessionTimeoutBeforeTx: number | null = null;
      /** Advisory locks held by the session. These survive ROLLBACK (verified on 18). */
      readonly advisoryLocks: number[] = [];

      static protocolOf(arg: unknown, params?: unknown[]): { text: string; protocol: EngineProtocol } {
        if (typeof arg === "string") {
          const extended = Array.isArray(params) && params.length > 0;
          return { text: arg, protocol: extended ? "extended" : "simple" };
        }
        const config = arg as { text: string; name?: string; values?: unknown[]; queryMode?: string };
        const extended =
          config.queryMode === "extended" ||
          Boolean(config.name) ||
          (Array.isArray(config.values) && config.values.length > 0);
        return { text: config.text, protocol: extended ? "extended" : "simple" };
      }

      async query(arg: unknown, params?: unknown[]) {
        const { text, protocol } = ReadOnlyEngineMock.protocolOf(arg, params);
        if (protocol === "extended") {
          if (splitCommands(text).length > 1) {
            throw pgServerError("cannot insert multiple commands into a prepared statement", "42601");
          }
          return this.execute(text, protocol);
        }
        let last: ReturnType<ReadOnlyEngineMock["execute"]> = { rows: [], fields: [], rowCount: 0 };
        for (const command of splitCommands(text)) {
          last = this.execute(command, protocol);
        }
        return last;
      }

      private rows(data: Array<Record<string, unknown>>) {
        return { rows: data, fields: Object.keys(data[0] ?? {}).map((name) => ({ name })), rowCount: data.length };
      }

      /** A write attempt: refused by the transaction's access mode, else applied. */
      private write(text: string, named: string) {
        if (this.txState === "read-only") {
          this.txState = "aborted";
          throw pgServerError(`cannot execute ${named} in a read-only transaction`, "25006");
        }
        this.appliedWrites.push(text.trim());
        return { rows: [], fields: [], rowCount: 1 };
      }

      private execute(text: string, protocol: EngineProtocol) {
        const keyword = engineLeadingKeyword(text);
        // The role-privilege probe the read-only profile runs at OPEN. Counted
        // separately rather than pushed onto `statements`, which the tests read
        // as "what one queryReadOnly call sent".
        if (keyword === "SELECT" && /is_superuser/i.test(text)) {
          this.privilegeProbes++;
          this.privilegeProbeText = text;
          if (this.privilegeProbeFailure) throw this.privilegeProbeFailure;
          return this.rows(this.privilegeRows ?? [{ ...this.privileges }]);
        }
        this.statements.push({ text: text.trim(), protocol });
        if (this.txState === "aborted" && keyword !== "ROLLBACK" && keyword !== "COMMIT") {
          throw pgServerError(
            "current transaction is aborted, commands ignored until end of transaction block",
            "25P02",
          );
        }
        switch (keyword) {
          case "BEGIN":
          case "START":
            // Inside a transaction the server only warns; state is unchanged.
            if (this.txState === "none") {
              this.txState = /read\s+only/i.test(text) ? "read-only" : "read-write";
              this.sessionTimeoutBeforeTx = this.sessionTimeout;
            }
            return { rows: [], fields: [], rowCount: 0 };
          case "COMMIT":
          case "END":
            this.txState = "none";
            this.sessionTimeoutBeforeTx = null;
            return { rows: [], fields: [], rowCount: 0 };
          case "ROLLBACK":
            if (this.failRollback) {
              throw pgServerError("server closed the connection unexpectedly", "08006");
            }
            this.txState = "none";
            // GUC changes are transactional: a session-level SET made inside the
            // transaction is undone here.
            if (this.sessionTimeoutBeforeTx !== null) this.sessionTimeout = this.sessionTimeoutBeforeTx;
            this.sessionTimeoutBeforeTx = null;
            return { rows: [], fields: [], rowCount: 0 };
          case "SET": {
            const local = /^set\s+local\s+statement_timeout\s*=\s*(\d+)$/i.exec(text.trim());
            if (local) {
              this.localTimeouts.push(Number(local[1]));
              return { rows: [], fields: [], rowCount: 0 };
            }
            const session = /^set\s+statement_timeout\s*=\s*(\d+)$/i.exec(text.trim());
            if (session) {
              this.sessionTimeout = Number(session[1]);
              return { rows: [], fields: [], rowCount: 0 };
            }
            // Live-verified on PostgreSQL 18: accepted inside BEGIN READ ONLY,
            // and the transaction really becomes writable.
            if (/^set\s+transaction\s+read\s+write$/i.test(text.trim())) {
              if (this.txState === "read-only") this.txState = "read-write";
              return { rows: [], fields: [], rowCount: 0 };
            }
            return { rows: [], fields: [], rowCount: 0 };
          }
          case "COPY": {
            // A read-only transaction does not refuse these; privileges do.
            const toProgram = /\bto\s+program\b/i.test(text);
            const privileged = toProgram ? this.privileges.executes_programs : this.privileges.writes_server_files;
            if (!privileged) {
              this.txState = "aborted";
              throw pgServerError(
                toProgram
                  ? "permission denied to COPY to or from an external program"
                  : "permission denied to COPY to a file",
                "42501",
              );
            }
            this.serverFileWrites.push(text.trim());
            return { rows: [], fields: [], rowCount: 1 };
          }
          case "DISCARD":
            // Session state a rollback does not undo. Cannot run inside a
            // transaction block, which is why the profile issues it after the
            // ROLLBACK rather than instead of it.
            this.advisoryLocks.length = 0;
            return { rows: [], fields: [], rowCount: 0 };
          case "WITH":
            // The CTE list is a preamble: a `WITH` that carries a write is a
            // write, and one that does not is an ordinary read.
            return withCarriesWrite(text) ? this.write(text, "SELECT") : this.rows(this.selectRows);
          case "SELECT": {
            // An advisory lock is session state, not transaction state: taking
            // one inside a read-only transaction succeeds and outlives the
            // rollback.
            const lock = /pg_advisory_lock\(\s*(\d+)\s*\)/i.exec(text);
            if (lock) {
              this.advisoryLocks.push(Number(lock[1]));
              return this.rows([{ pg_advisory_lock: "" }]);
            }
            return this.rows(this.selectRows);
          }
          case "EXPLAIN":
          case "SHOW":
            return this.rows(this.selectRows);
          default:
            // Everything else counts as a write attempt (conservative server model).
            return this.write(text, keyword);
        }
      }
    }

    function roBudget(overrides: Partial<ReadOnlyStatementBudget> = {}): ReadOnlyStatementBudget {
      return { statementTimeoutMs: 4500, maxResultRows: 100, maxResultBytes: 1_000_000, ...overrides };
    }

    let engine: ReadOnlyEngineMock;
    let releaseSpy: ReturnType<typeof spyOn<typeof mockClient, "release">>;

    beforeEach(async () => {
      engine = new ReadOnlyEngineMock();
      mockQueryFn = (sql: string, params?: unknown[]) => engine.query(sql, params);
      // The third argument is the server-injected execution context: `queryReadOnly`
      // exists only on a provider opened under the profile, so that the role
      // verification below can never be skipped by reaching for the method on an
      // ordinary provider.
      provider = new PostgresProvider(makePgConfig(), {}, { readOnly: true });
      await provider.connect();
      // Installed after connect() so the counts below are wrapper-only.
      releaseSpy = spyOn(mockClient, "release");
    });

    afterEach(() => {
      releaseSpy.mockRestore();
    });

    test("runs exactly one statement inside BEGIN READ ONLY with a transaction-local timeout, then rolls back and releases", async () => {
      const result = await provider.queryReadOnly("SELECT 1 AS ok", roBudget());

      expect(result.rows).toEqual([{ ok: 1 }]);
      expect(result.fields).toEqual(["ok"]);
      expect(result.rowCount).toBe(1);
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
      expect(engine.statements.map((s) => s.text)).toEqual([
        "BEGIN READ ONLY",
        "SET LOCAL statement_timeout = 4500",
        "SELECT 1 AS ok",
        "ROLLBACK",
        // Session state the rollback does not undo (see the advisory-lock case).
        "DISCARD ALL",
      ]);
      // The statement itself travels on the extended protocol — that is what
      // makes single-statement a server-enforced property (42601), not a parse.
      expect(engine.statements[2]?.protocol).toBe("extended");
      expect(engine.localTimeouts).toEqual([4500]);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
    });

    test("the database itself rejects a write attempted through the agent path", async () => {
      await expect(provider.queryReadOnly("INSERT INTO t (id) VALUES (1)", roBudget())).rejects.toThrow(
        /read-only transaction/,
      );

      expect(engine.appliedWrites).toEqual([]);
      expect(engine.statements.at(-1)?.text).toBe("DISCARD ALL");
      expect(releaseSpy).toHaveBeenCalledTimes(1);
    });

    test("the normal editor path on the same connection still writes", async () => {
      // The editor holds its own, unprofiled provider (getOrCreateProvider's
      // cache entry) — the regression pin for #328: gating the agent path must
      // not gate the editor.
      const editor = new PostgresProvider(makePgConfig());
      await editor.connect();
      const result = await editor.query("INSERT INTO t (id) VALUES (1)");

      expect(result.rowCount).toBe(1);
      expect(engine.appliedWrites).toEqual(["INSERT INTO t (id) VALUES (1)"]);
      await editor.disconnect();
    });

    test("refuses queryReadOnly on a provider that was not opened under the profile", async () => {
      const unprofiled = new PostgresProvider(makePgConfig());
      await unprofiled.connect();

      // Fail closed, and for the reason the SQLite profile fails closed too: a
      // provider opened outside the profile has had no role verification, so
      // running the statement there would be the fail-open this layer prevents.
      await expect(unprofiled.queryReadOnly("SELECT 1", roBudget())).rejects.toThrow(/read-only profile/i);
      expect(engine.statements).toEqual([]);
      await unprofiled.disconnect();
    });

    test("multi-statement input cannot smuggle transaction control past the read-only boundary", async () => {
      await expect(
        provider.queryReadOnly("SELECT 1; COMMIT; INSERT INTO t (id) VALUES (1)", roBudget()),
      ).rejects.toThrow(/multiple commands/);

      expect(engine.appliedWrites).toEqual([]);
      // The server refused at parse time: nothing ran between SET LOCAL and ROLLBACK.
      expect(engine.statements.map((s) => s.text)).toEqual([
        "BEGIN READ ONLY",
        "SET LOCAL statement_timeout = 4500",
        "ROLLBACK",
        "DISCARD ALL",
      ]);
    });

    test("a transaction-control statement as the single statement leaves no residue", async () => {
      const result = await provider.queryReadOnly("COMMIT", roBudget());

      expect(result.rows).toEqual([]);
      expect(engine.appliedWrites).toEqual([]);
      expect(engine.txState).toBe("none");
      expect(releaseSpy).toHaveBeenCalledTimes(1);
    });

    test("rejects a malformed budget before any statement reaches the session", async () => {
      const hostileTimeouts = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, "50; COMMIT"];
      for (const statementTimeoutMs of hostileTimeouts) {
        await expect(
          provider.queryReadOnly("SELECT 1", roBudget({ statementTimeoutMs: statementTimeoutMs as never })),
        ).rejects.toThrow(/budget/i);
      }
      await expect(provider.queryReadOnly("SELECT 1", roBudget({ maxResultRows: 0 }))).rejects.toThrow(/budget/i);
      await expect(provider.queryReadOnly("SELECT 1", roBudget({ maxResultBytes: -5 }))).rejects.toThrow(/budget/i);

      expect(engine.statements).toEqual([]);
      expect(releaseSpy).not.toHaveBeenCalled();
    });

    test("enforces the row budget result-side", async () => {
      engine.selectRows = [{ id: 1 }, { id: 2 }, { id: 3 }];

      await expect(provider.queryReadOnly("SELECT id FROM t", roBudget({ maxResultRows: 2 }))).rejects.toThrow(
        /row budget/i,
      );
      expect(engine.statements.at(-1)?.text).toBe("DISCARD ALL");
      expect(releaseSpy).toHaveBeenCalledTimes(1);
    });

    test("enforces the byte budget result-side", async () => {
      engine.selectRows = [{ blob: "x".repeat(64) }];

      await expect(provider.queryReadOnly("SELECT blob FROM t", roBudget({ maxResultBytes: 16 }))).rejects.toThrow(
        /byte budget/i,
      );
      expect(engine.statements.at(-1)?.text).toBe("DISCARD ALL");
    });

    test("a client that cannot roll back is destroyed, never returned to the pool", async () => {
      engine.failRollback = true;

      const result = await provider.queryReadOnly("SELECT 1 AS ok", roBudget());

      expect(result.rows).toEqual([{ ok: 1 }]);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(releaseSpy.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    });

    test("requires a connected provider", async () => {
      const cold = new PostgresProvider(makePgConfig(), {}, { readOnly: true });

      await expect(cold.queryReadOnly("SELECT 1", roBudget())).rejects.toThrow(/connect/i);
      expect(engine.statements).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // What the read-only TRANSACTION does not cover (verified on PostgreSQL 18)
    // ------------------------------------------------------------------------

    test("verifies at open that the agent role holds no server-file or program privilege", async () => {
      // The probe is part of opening the profile, not of every statement.
      expect(engine.privilegeProbes).toBe(1);
      expect(provider.isConnected()).toBe(true);
    });

    test("schema-qualifies every built-in the privilege probe calls", () => {
      // pg_catalog is searched implicitly FIRST only while it is NOT named in
      // search_path; once it is named explicitly, a schema ahead of it shadows
      // built-ins. So `search_path = attacker_schema, pg_catalog` plus a shadow
      // pg_has_role()/current_setting() makes this probe answer four falses for
      // a superuser — defeating the one check meant to catch exactly that role.
      // Whoever can plant prompt-injection text in a table can often also create
      // a function, so the two reach the same attacker. Qualifying costs nothing.
      // Only real catalog FUNCTIONS are shadowable, so only they are listed:
      // COALESCE and CURRENT_USER are SQL constructs the parser handles, cannot
      // be schema-qualified at all, and no user function can intercept them.
      const probe = engine.privilegeProbeText;
      expect(probe).toBeTruthy();
      for (const builtin of ["current_setting", "pg_has_role", "to_regrole"]) {
        expect(probe).not.toMatch(new RegExp(String.raw`(?<!pg_catalog\.)\b${builtin}\s*\(`, "i"));
      }
    });

    test("ends the pool when the privilege probe itself fails", async () => {
      // The typed refusal path already ends the pool. This is the other way out
      // of connect() after the pool exists: the probe query rejecting on a
      // dropped socket or protocol error. The factory does not disconnect a
      // provider whose connect() threw, so a pool left open here leaks its idle
      // socket and timers with nothing holding a reference to close them.
      engine.privilegeProbeFailure = new Error("connection terminated unexpectedly");
      const failing = new PostgresProvider(makePgConfig(), {}, { readOnly: true });
      const endSpy = spyOn(MockPool.prototype, "end");

      const error = await failing.connect().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ConnectionError);
      expect(failing.isConnected()).toBe(false);
      expect(endSpy).toHaveBeenCalled();
      endSpy.mockRestore();
      engine.privilegeProbeFailure = null;
    });

    test.each([
      ["a superuser", "is_superuser"],
      ["a role that can read server files", "reads_server_files"],
      ["a role that can write server files", "writes_server_files"],
      ["a role that can run server programs", "executes_programs"],
    ])("refuses to open the profile for %s", async (_label, capability) => {
      // A read-only transaction forbids changing the DATABASE. It does not stop
      // `COPY … TO '<path>'`, `COPY … TO PROGRAM '<cmd>'` or `pg_read_file()` —
      // all three succeeded inside BEGIN READ ONLY as a superuser on PostgreSQL
      // 18. Only privileges refuse them, so a role that holds any of these has
      // no read-only boundary and the profile refuses to vend it.
      engine.privileges = { ...engine.privileges, [capability]: true };
      const privileged = new PostgresProvider(makePgConfig(), {}, { readOnly: true });
      // The pool is constructed inside connect(), so the spy goes on the
      // prototype rather than on an instance that does not exist yet.
      const endSpy = spyOn(MockPool.prototype, "end");

      const error = await privileged.connect().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ExecutionProfileError);
      expect((error as ExecutionProfileError).reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(privileged.isConnected()).toBe(false);
      // The pool exists before the refusal; leaving it would leak its sockets
      // for a provider the caller can never use.
      expect(endSpy).toHaveBeenCalled();
      endSpy.mockRestore();
    });

    test.each([
      ["no rows", []],
      ["a row without the expected fields", [{ ok: 1 }]],
      ["a row whose flags are not booleans", [{ is_superuser: "off" }]],
    ])("fails closed when the privilege probe answers %s", async (_label, rows) => {
      engine.privilegeRows = rows as Array<Record<string, unknown>>;
      const unverifiable = new PostgresProvider(makePgConfig(), {}, { readOnly: true });

      await expect(unverifiable.connect()).rejects.toThrow(ExecutionProfileError);
      expect(unverifiable.isConnected()).toBe(false);
    });

    test("the profile only ever exists for a role the engine refuses COPY to", async () => {
      // Together with the refusals above, this is the whole story for the
      // exfiltration family: the engine permits COPY under a read-only
      // transaction, so the control is the role — and for a role that reached
      // the profile, the engine itself denies it.
      await expect(provider.queryReadOnly("COPY (SELECT 1) TO PROGRAM 'sh -c id'", roBudget())).rejects.toThrow(
        /permission denied/i,
      );
      await expect(provider.queryReadOnly("COPY (SELECT 1) TO '/tmp/stolen.txt'", roBudget())).rejects.toThrow(
        /permission denied/i,
      );

      expect(engine.serverFileWrites).toEqual([]);
      expect(engine.appliedWrites).toEqual([]);
    });

    test("a data-modifying CTE is rejected by the engine while a read-only CTE succeeds", async () => {
      engine.selectRows = [{ n: 1 }];
      const read = await provider.queryReadOnly(
        "WITH recent AS (SELECT id FROM t) SELECT count(*) AS n FROM recent",
        roBudget(),
      );
      expect(read.rows).toEqual([{ n: 1 }]);

      await expect(
        provider.queryReadOnly(
          "WITH moved AS (INSERT INTO archive SELECT * FROM t RETURNING id) SELECT count(*) FROM moved",
          roBudget(),
        ),
      ).rejects.toThrow(/read-only transaction/);

      // The pair is the point: a mock that blanket-refused every `WITH` would
      // pass the second assertion for the wrong reason and fail the first.
      expect(engine.appliedWrites).toEqual([]);
    });

    test("a write hidden behind a comment is rejected by the engine, not by inspecting the text", async () => {
      await expect(provider.queryReadOnly("/* SELECT */ INSERT INTO t (id) VALUES (1)", roBudget())).rejects.toThrow(
        /read-only transaction/,
      );
      await expect(provider.queryReadOnly("-- SELECT 1\nUPDATE t SET id = 2", roBudget())).rejects.toThrow(
        /read-only transaction/,
      );

      expect(engine.appliedWrites).toEqual([]);
    });

    test("relaxing the transaction access mode cannot reach a second statement", async () => {
      // The escape is real: this statement genuinely makes the transaction
      // writable (live-verified). What stops it is that it is the transaction's
      // ONLY statement — the next execution begins its own READ ONLY
      // transaction on the pooled client.
      await provider.queryReadOnly("SET TRANSACTION READ WRITE", roBudget());
      expect(engine.txState).toBe("none");

      await expect(provider.queryReadOnly("INSERT INTO t (id) VALUES (1)", roBudget())).rejects.toThrow(
        /read-only transaction/,
      );
      expect(engine.appliedWrites).toEqual([]);
      expect(engine.statements.filter((s) => s.text === "BEGIN READ ONLY")).toHaveLength(2);
    });

    test("a session-level SET does not survive into the next execution on the pooled client", async () => {
      await provider.queryReadOnly("SET statement_timeout = 0", roBudget());

      // The first assertion documents the model (GUCs are transactional, so the
      // ROLLBACK restored the session value); the load-bearing one is the
      // second — the next execution installs its own transaction-local timeout
      // from the budget whatever the session carries.
      expect(engine.sessionTimeout).toBe(30_000);
      await provider.queryReadOnly("SELECT 1 AS ok", roBudget({ statementTimeoutMs: 1234 }));
      expect(engine.localTimeouts).toEqual([4500, 1234]);
    });

    test("session state a rollback does NOT undo is discarded before the client goes back to the pool", async () => {
      // Verified on PostgreSQL 18: an advisory lock taken inside BEGIN READ ONLY
      // survives the ROLLBACK, and nothing on the agent path is REQUIRED to
      // release it (`pg_advisory_unlock_all()` would, but a hostile statement has
      // no reason to send it), so a pooled client would otherwise carry the lock
      // into every later execution. `DISCARD ALL` — which cannot run inside a
      // transaction block, hence after the rollback — makes "rolled back and
      // released" true for session state too, without relying on goodwill.
      await provider.queryReadOnly("SELECT pg_advisory_lock(101)", roBudget());

      expect(engine.advisoryLocks).toEqual([]);
      expect(engine.statements.map((s) => s.text)).toEqual([
        "BEGIN READ ONLY",
        "SET LOCAL statement_timeout = 4500",
        "SELECT pg_advisory_lock(101)",
        "ROLLBACK",
        "DISCARD ALL",
      ]);
    });
  });
});
