/**
 * Integration tests for PostgresProvider
 * Uses mock.module() to intercept pg before provider import.
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import type { DatabaseConnection } from "@/lib/types";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import { ConnectionError, DatabaseConfigError, ExecutionProfileError, QueryError } from "@/lib/db/errors";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";

// ============================================================================
// Mock pg BEFORE importing the provider
// ============================================================================

let mockQueryFn: (
  sql: string,
  params?: unknown[],
) => Promise<{
  rows: unknown[];
  // `dataTypeID` is a pg_type OID and the ONLY thing pg says about a column's type:
  // there is no name on the wire at all.
  fields?: { name: string; dataTypeID?: number }[];
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

/**
 * The config object the provider handed `new Pool(...)`. Recorded because `buildSSLConfig`
 * is private and its result is only observable here: a test that merely connects and
 * asserts `isConnected()` passes for every SSL mode, including a wrong one.
 */
let lastPoolConfig: Record<string, unknown> = {};

mock.module("pg", () => ({
  Pool: function (config: Record<string, unknown>) {
    lastPoolConfig = config;
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
// A SQL rewrite that drops a bracket still satisfies "does not contain X", so the
// rewrite tests below pair every such assertion with this: it reports imbalance
// rather than a bare false, so a failure says which direction the rewrite broke.
function countParens(sql: string): { balanced: boolean; open?: number; close?: number } {
  let depth = 0;
  let open = 0;
  let close = 0;
  for (const ch of sql) {
    if (ch === "(") {
      open++;
      depth++;
    } else if (ch === ")") {
      close++;
      depth--;
    }
  }
  return depth === 0 ? { balanced: true } : { balanced: false, open, close };
}

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

  // getPerformanceMetrics: pg_statio_user_tables (cache_hit_ratio only).
  // Checked BEFORE the getHealth branch below, not after: both statements sum
  // heap_blks_read, so a heap_blks_read test matches this query too and this
  // branch was unreachable - which is why getPerformanceMetrics() was asserted
  // against a fabricated 100 instead of against 98.75.
  if (normalized.includes("pg_statio_user_tables") && normalized.includes("cache_hit_ratio")) {
    return Promise.resolve({
      rows: [{ cache_hit_ratio: "98.75" }],
      fields: [{ name: "cache_hit_ratio" }],
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

  // Schema CTE query: information_schema + table_type in ('base table'
  if (normalized.includes("tables_info as materialized (") || normalized.includes("tables_info as (")) {
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

  // getOverview: version() (split from uptime so an engine without
  // pg_postmaster_start_time() still reports a version - see postgres.ts)
  if (normalized.includes("version()") && !normalized.includes("pg_postmaster_start_time()")) {
    return Promise.resolve({
      rows: [{ version: "PostgreSQL 16.2, compiled by Visual C++ build 1941, 64-bit" }],
      fields: [],
      rowCount: 1,
    });
  }

  // getOverview: pg_postmaster_start_time() + uptime_seconds
  if (normalized.includes("pg_postmaster_start_time()")) {
    return Promise.resolve({
      rows: [
        {
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

  // getOverview: database size, the byte figure only - `databaseSize` is formatBytes() over it.
  if (normalized.includes("pg_database_size") && normalized.includes("database_size_bytes")) {
    return Promise.resolve({
      rows: [{ database_size_bytes: "536870912" }],
      fields: [],
      rowCount: 1,
    });
  }

  // getOverview: table + index counts. Keyed on the output column rather than on the
  // catalogs, which have already moved once (pg_tables -> information_schema.tables).
  if (normalized.includes("as table_count") && normalized.includes("as index_count")) {
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

    // D26: the mode a pasted `?ssl=true` lands on, and the reason it can: `pg` is handed
    // `rejectUnauthorized: true` with NO `ca`, so Node's own trust store checks the chain and
    // there is no PEM for the user to find. `require` is the same call with verification off.
    test("ssl mode verify-system verifies against the runtime trust store with no ca", async () => {
      provider = new PostgresProvider(makePgConfig({ ssl: { mode: "verify-system" } }));
      await provider.connect();
      expect(lastPoolConfig.ssl).toEqual({ rejectUnauthorized: true });
    });

    test("ssl mode require encrypts without checking the chain", async () => {
      provider = new PostgresProvider(makePgConfig({ ssl: { mode: "require" } }));
      await provider.connect();
      expect(lastPoolConfig.ssl).toEqual({ rejectUnauthorized: false });
    });

    test("ssl mode verify-ca sets rejectUnauthorized to true", async () => {
      provider = new PostgresProvider(
        makePgConfig({
          ssl: { mode: "verify-ca" },
        }),
      );
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
      expect(lastPoolConfig.ssl).toEqual({ rejectUnauthorized: true });
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
    // the default mock (information_schema + table_type in ('base table') applies.
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

    test("negative reltuples row_count is reported as absent, not as zero", async () => {
      // Never-analysed tables report reltuples = -1 and the UI must never show -1 - but
      // clamping it to 0 traded one wrong number for another, and 0 is the more
      // convincing lie because it looks like a reading. Absence draws no badge at all.
      mockQueryFn = (sql: string) => {
        if (sql.toLowerCase().includes("table_type in ('base table'")) {
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

      expect(schema[0].rowCount).toBeUndefined();
    });

    test("table with no columns yields an empty columns array (not a crash)", async () => {
      mockQueryFn = (sql: string) => {
        if (sql.toLowerCase().includes("table_type in ('base table'")) {
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
  // MATERIALIZED-keyword fallback (Materialize/RisingWave compatibility, #38680)
  // --------------------------------------------------------------------------

  describe("MATERIALIZED-keyword schema fallback", () => {
    // Materialize/RisingWave reserve MATERIALIZED as a keyword and reject the
    // CTE modifier with a syntax error, even though the underlying
    // information_schema views are otherwise queryable there.
    function rejectMaterializedHintOnce(onRetry: (sql: string) => ReturnType<typeof defaultMockQuery>) {
      mockQueryFn = (sql: string) => {
        if (sql.includes("AS MATERIALIZED (")) {
          return Promise.reject(new Error('syntax error at or near "MATERIALIZED"'));
        }
        return onRetry(sql);
      };
    }

    test("getSchema() retries without the hint and returns real data", async () => {
      rejectMaterializedHintOnce(defaultMockQuery);
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const schema = await provider.getSchema();
      expect(schema.length).toBe(2);
    });

    test("getSchemaList() and getSchemaRelations() also recover via the same fallback", async () => {
      rejectMaterializedHintOnce(defaultMockQuery);
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const list = await provider.getSchemaList();
      expect(list.length).toBe(2);

      const relations = await provider.getSchemaRelations();
      expect(Array.isArray(relations)).toBe(true);
    });

    test("getSchema() maps and rethrows when the retry without the hint also fails", async () => {
      mockQueryFn = () => Promise.reject(new Error('syntax error at or near "MATERIALIZED"'));
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await expect(provider.getSchema()).rejects.toThrow(QueryError);
      await expect(provider.getSchema()).rejects.toThrow(/materialized/i);
    });

    test("getSchema() maps and rethrows an unrelated error without retrying", async () => {
      mockQueryFn = () => Promise.reject(new Error('relation "tables_info" does not exist'));
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await expect(provider.getSchema()).rejects.toThrow(QueryError);
      await expect(provider.getSchema()).rejects.toThrow(/does not exist/);
    });

    // CockroachDB accepts the MATERIALIZED hint fine (its own compatibility.ts entry
    // says so) but has no pg_total_relation_size() builtin - hitting the second
    // fallback as the FIRST error, with the MATERIALIZED collision never in play.
    test("getSchema() retries around a missing pg_total_relation_size(), independent of the MATERIALIZED collision", async () => {
      mockQueryFn = (sql: string) => {
        if (sql.includes("pg_total_relation_size(c.oid)")) {
          return Promise.reject(new Error("unknown function: pg_total_relation_size()"));
        }
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const schema = await provider.getSchema();
      expect(schema.length).toBe(2);
    });

    // Materialize hits all three gaps in sequence: MATERIALIZED is rejected first,
    // then (once stripped) pg_total_relation_size, then (once replaced) json_agg.
    test("getSchema() chains through all three fallbacks when an engine hits every gap", async () => {
      mockQueryFn = (sql: string) => {
        if (sql.includes("AS MATERIALIZED (")) {
          return Promise.reject(new Error("Expected left parenthesis, found MATERIALIZED"));
        }
        if (sql.includes("pg_total_relation_size(c.oid)")) {
          return Promise.reject(new Error('function "pg_total_relation_size" does not exist'));
        }
        if (sql.includes("json_agg(")) {
          return Promise.reject(new Error('function "json_agg" does not exist'));
        }
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const schema = await provider.getSchema();
      expect(schema.length).toBe(2);
    });

    test("getSchema() maps and rethrows when the MATERIALIZED retry fails for an unrelated reason", async () => {
      // Every attempt gets this same message: the first is consumed by the
      // MATERIALIZED fallback (it mentions "MATERIALIZED"), but once that fallback is
      // used up, no remaining fallback recognizes it, so the second attempt's
      // rejection is mapped and rethrown rather than retried forever.
      mockQueryFn = () =>
        Promise.reject(new Error("syntax error: Expected left parenthesis, found MATERIALIZED; unrelated cause"));
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await expect(provider.getSchema()).rejects.toThrow(QueryError);
    });
  });

  // --------------------------------------------------------------------------
  // System-schema exclusion set (engine internals must never count as user data)
  // --------------------------------------------------------------------------

  describe("system-schema exclusion set", () => {
    // Each name below was read off that engine's own documentation and then
    // confirmed against a live instance. They are the schemas a wire-compatible
    // engine puts in pg_tables/information_schema alongside a user's own tables.
    const DOCUMENTED_ENGINE_SCHEMAS = [
      // Materialize - materialize.com/docs/sql/system-catalog/
      "mz_catalog",
      "mz_internal",
      "mz_introspection",
      // CockroachDB - cockroachlabs.com/docs/stable/system-catalogs
      "crdb_internal",
      "pg_extension",
      // TimescaleDB - timescaledb/sql/pre_install/schemas.sql
      "_timescaledb_catalog",
      "_timescaledb_config",
      "_timescaledb_functions",
      "_timescaledb_internal",
      "_timescaledb_cache",
      "timescaledb_experimental",
      "timescaledb_information",
      // Apache Cloudberry - cloudberry.apache.org create-and-manage-schemas
      "gp_toolkit",
      "pg_aoseg",
      "pg_bitmapindex",
      "pg_ext_aux",
      // AlloyDB Omni is not here on purpose: its google_ml schema is extension-created,
      // so the ownership test covers it and no user schema can collide with the name.
      // See "extension-created schemas are excluded by ownership, not by name" below.
    ];

    // Capture every statement the provider sends while exercising the surfaces
    // that filter by schema, so the assertion below covers all of them at once
    // rather than a hand-copied list that a new query could silently escape.
    async function captureSchemaFilteredSql(): Promise<string[]> {
      const seen: string[] = [];
      mockQueryFn = (sql: string) => {
        seen.push(sql);
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await provider.getSchema();
      await provider.getSchemaList();
      await provider.getSchemaRelations();
      await provider.getOverview();
      await provider.getTableStats();
      await provider.getIndexStats();
      return seen.filter((sql) => sql.includes("NOT IN ('pg_catalog'"));
    }

    test("every schema-filtered query excludes all documented engine internals", async () => {
      const filtered = await captureSchemaFilteredSql();

      // Non-vacuity: the surfaces above really do emit schema filters. The count
      // is read off the capture rather than pinned, so adding a query cannot make
      // this guard silently stop covering it.
      expect(filtered.length).toBeGreaterThan(0);

      for (const sql of filtered) {
        for (const schema of DOCUMENTED_ENGINE_SCHEMAS) {
          expect(sql).toContain(`'${schema}'`);
        }
      }
    });

    test("every CTE in the schema queries filters by schema, not just some of them", async () => {
      // tables_info/columns_info/index_info carried the exclusion while pk_info and
      // fk_info did not, so getSchemaRelations() still listed _timescaledb_catalog
      // and google_ml relations through the FK side of its FULL OUTER JOIN even
      // after the object browser stopped showing them. Every CTE here reads
      // per-table metadata, so every one of them needs the filter.
      const seen: string[] = [];
      mockQueryFn = (sql: string) => {
        seen.push(sql);
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await provider.getSchema();
      await provider.getSchemaRelations();

      const schemaQueries = seen.filter((sql) => sql.includes("_info AS MATERIALIZED ("));
      expect(schemaQueries.length).toBeGreaterThan(0);

      // Split each query into its CTE bodies and require the filter in every one.
      // The count comes off the split, so a CTE added later is covered automatically.
      const unfiltered: string[] = [];
      for (const sql of schemaQueries) {
        // Splitting on the CTE header yields [prefix, name, body, name, body, ...],
        // so each body runs exactly to the next CTE and cannot borrow its filter.
        const parts = sql.split(/(\w+) AS MATERIALIZED \(/);
        expect(parts.length).toBeGreaterThan(1);
        for (let i = 1; i < parts.length; i += 2) {
          if (!parts[i + 1].includes("NOT IN ('pg_catalog'")) unfiltered.push(parts[i]);
        }
      }
      expect(unfiltered).toEqual([]);
    });

    test("extension-created schemas are excluded by ownership, not by name", async () => {
      // A hardcoded "google_ml" would hide a real schema from anyone who happened to
      // name one that - it is the only entry on the list a user could plausibly pick.
      // pg_depend answers the question the name was standing in for, and answers it
      // better: on a live AlloyDB Omni it returns google_ml AND ai, which the name
      // list had missed. Measured working on all seven engines, PostgreSQL included,
      // where it correctly returns nothing.
      const seen: string[] = [];
      mockQueryFn = (sql: string) => {
        seen.push(sql);
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await provider.getSchema();
      await provider.getOverview();
      await provider.getTableStats();
      await provider.getIndexStats();

      const filtered = seen.filter((sql) => sql.includes("NOT IN ('pg_catalog'"));
      expect(filtered.length).toBeGreaterThan(0);
      for (const sql of filtered) {
        expect(sql).toContain("pg_depend");
      }
      // And the name it replaces is gone, so a user's own google_ml stays visible.
      expect(seen.some((sql) => sql.includes("'google_ml'"))).toBe(false);
    });

    test("an engine without pg_depend still gets a real count, not a zero", async () => {
      // The counts query carries the ownership clause too, but it does not go through
      // the object browser's fallback chain, so an engine that cannot evaluate
      // pg_depend used to land in getOverview's catch and report 0 tables - the same
      // fabricated measurement this file spends its comments arguing against.
      let attempts = 0;
      mockQueryFn = (sql: string) => {
        if (sql.includes("as table_count")) {
          attempts++;
          if (sql.includes("pg_depend")) {
            return Promise.reject(new Error('relation "pg_depend" does not exist'));
          }
          return Promise.resolve({ rows: [{ table_count: "42", index_count: "7" }], fields: [], rowCount: 1 });
        }
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const overview = await provider.getOverview();
      expect(attempts).toBe(2);
      expect(overview.tableCount).toBe(42);
      expect(overview.indexCount).toBe(7);
    });

    test("the overview counts a table the same way the object browser does", async () => {
      // These are the two readers that disagreed on CockroachDB, and adding
      // materialized views to the browser split them again on Materialize: the browser
      // said 4 and the overview 3, because pg_tables has no materialized views in it.
      // One definition of "a table" or the panels drift apart again on the next engine.
      const seen: string[] = [];
      mockQueryFn = (sql: string) => {
        seen.push(sql);
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await provider.getSchema();
      await provider.getOverview();

      const browserQuery = seen.find((sql) => sql.includes("tables_info AS MATERIALIZED ("));
      const countsQuery = seen.find((sql) => sql.includes("as table_count"));
      expect(browserQuery).toBeDefined();
      expect(countsQuery).toBeDefined();

      // Same source and same type list, not merely both filtered somehow.
      expect(countsQuery).toContain("information_schema.tables");
      expect(countsQuery).toContain("'MATERIALIZED VIEW'");
      expect(countsQuery).toContain("'BASE TABLE'");
    });

    test("getOverview() counts exclude CockroachDB's crdb_internal and pg_extension", async () => {
      // Measured on CockroachDB v26.2.5: a database with two user tables answers
      // 98 rows from pg_tables, 93 of them crdb_internal and 3 pg_extension. The
      // object browser reads information_schema and correctly says 2, so an
      // unfiltered count makes the two panels disagree.
      let countsSql = "";
      mockQueryFn = (sql: string) => {
        if (sql.includes("as table_count")) countsSql = sql;
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await provider.getOverview();

      expect(countsSql).toContain("'crdb_internal'");
      expect(countsSql).toContain("'pg_extension'");
    });
  });

  // --------------------------------------------------------------------------
  // Foreign-key catalog fallback (Materialize has no constraint_column_usage)
  // --------------------------------------------------------------------------

  describe("missing constraint_column_usage fallback", () => {
    // Measured on Materialize v26.37.0: key_column_usage and table_constraints
    // both exist, but constraint_column_usage does not, so the whole schema query
    // fails even after the MATERIALIZED/size/json fallbacks have cleared their
    // gaps. Foreign keys are genuinely unknowable there; every other column is not.
    function rejectConstraintColumnUsage(onRetry: (sql: string) => ReturnType<typeof defaultMockQuery>) {
      mockQueryFn = async (sql: string) => {
        if (sql.includes("constraint_column_usage")) {
          return Promise.reject(new Error("unknown catalog item 'information_schema.constraint_column_usage'"));
        }
        const result = await onRetry(sql);
        // The canned rows carry foreign keys whatever SQL arrives, so asserting on
        // them would test the fixture rather than the rewrite. Model what the engine
        // actually does instead: an emptied fk_info CTE joins to nothing, and the
        // outer COALESCE turns that into []. Keyed on the emptied CTE's own marker so
        // the fixture cannot answer [] for a query that still asked for real keys.
        if (!sql.includes("WHERE false")) return result;
        return {
          ...result,
          rows: result.rows.map((row) =>
            row !== null && typeof row === "object" && "foreign_keys" in row ? { ...row, foreign_keys: [] } : row,
          ),
        };
      };
    }

    test("getSchema() returns tables with no foreign keys instead of failing", async () => {
      rejectConstraintColumnUsage(defaultMockQuery);
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const schema = await provider.getSchema();
      expect(schema.length).toBe(2);
      // Absent, not invented: the retry drops the FK join rather than guessing.
      for (const table of schema) {
        expect(table.foreignKeys).toEqual([]);
      }
    });

    test("getSchemaRelations() still returns index data once the FK join is dropped", async () => {
      rejectConstraintColumnUsage(defaultMockQuery);
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const relations = await provider.getSchemaRelations();
      expect(Array.isArray(relations)).toBe(true);
    });

    test("the retried statement no longer reads constraint_column_usage", async () => {
      const attempts: string[] = [];
      mockQueryFn = (sql: string) => {
        attempts.push(sql);
        if (sql.includes("constraint_column_usage")) {
          return Promise.reject(new Error("unknown catalog item 'information_schema.constraint_column_usage'"));
        }
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      // Connect's own EXPLAIN grammar probe (#597) is not one of the schema read's
      // attempts; what this counts is what getSchema() sent.
      attempts.length = 0;
      await provider.getSchema();

      // Two attempts: the original, then one that has dropped the FK catalog.
      expect(attempts.length).toBe(2);
      expect(attempts[0]).toContain("constraint_column_usage");
      expect(attempts[1]).not.toContain("constraint_column_usage");
      // The CTE itself must survive - the outer query joins it by name.
      expect(attempts[1]).toContain("fk_info");
      // A rewrite that ate a bracket would still satisfy the assertions above.
      expect(countParens(attempts[1])).toEqual({ balanced: true });
    });

    test("a parenthesis inside a string literal does not move the CTE boundary", async () => {
      // replaceCteBody() counts brackets to find where the CTE ends. Today fk_info's
      // literals contain none, so the count is right by luck rather than by rule. This
      // pins the rule: the engine sees an unbalanced ")" inside a quoted string, and a
      // scanner that counted it would cut the CTE short and corrupt everything after.
      const attempts: string[] = [];
      mockQueryFn = (sql: string) => {
        attempts.push(sql);
        if (sql.includes("constraint_column_usage")) {
          return Promise.reject(new Error("unknown catalog item 'information_schema.constraint_column_usage'"));
        }
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      // Connect's own EXPLAIN grammar probe (#597) is not one of the schema read's
      // attempts; what this counts is what getSchema() sent.
      attempts.length = 0;
      await provider.getSchema();

      const rewritten = attempts[attempts.length - 1];
      // Everything the outer query needs must survive the cut, in order.
      expect(rewritten).toContain("fk_info");
      expect(rewritten).toContain("index_info AS MATERIALIZED (");
      expect(rewritten).toContain("LEFT JOIN fk_info fk");
      expect(rewritten).toContain("ORDER BY ti.table_schema");
      expect(countParens(rewritten)).toEqual({ balanced: true });
    });

    test("the ownership subquery stays strippable, which means bracket-free", async () => {
      // withoutExtensionOwnershipTest() finds the clause with a regex that stops at the
      // first ")", so a bracket anywhere inside the subquery would leave half of it
      // behind and produce SQL no engine will parse - silently, on exactly the engines
      // nobody here can test. The subquery is written bracket-free on purpose; this
      // fails the moment someone forgets why.
      const seen: string[] = [];
      mockQueryFn = (sql: string) => {
        seen.push(sql);
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await provider.getSchema();

      const query = seen.find((sql) => sql.includes("pg_depend"));
      expect(query).toBeDefined();
      const clause = /NOT IN \(SELECT n\.nspname FROM pg_namespace n JOIN pg_depend[^)]*\)/.exec(query as string);
      expect(clause).not.toBeNull();
      // The match must end at the clause's own closing bracket, so what it captured
      // has to contain the whole subquery - pg_extension is its last table.
      expect((clause as RegExpExecArray)[0]).toContain("pg_extension");
    });

    test("an engine without pg_depend falls back to the fixed schema list", async () => {
      // Every engine probed accepts the ownership test, but the driver serves engines
      // nobody has run. One that has no pg_depend must keep working on the fixed list
      // rather than losing its object browser to a filter it cannot evaluate.
      const attempts: string[] = [];
      mockQueryFn = (sql: string) => {
        attempts.push(sql);
        if (sql.includes("pg_depend")) {
          return Promise.reject(new Error('relation "pg_depend" does not exist'));
        }
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      // Connect's own EXPLAIN grammar probe (#597) is not one of the schema read's
      // attempts; what this counts is what getSchema() sent.
      attempts.length = 0;

      const schema = await provider.getSchema();
      expect(schema.length).toBe(2);
      expect(attempts.length).toBe(2);
      // The ownership clause is gone and the fixed list is still doing its job.
      expect(attempts[1]).not.toContain("pg_depend");
      expect(attempts[1]).toContain("NOT IN ('pg_catalog'");
      expect(countParens(attempts[1])).toEqual({ balanced: true });
    });

    test("the rethrown error carries the statement that actually failed", async () => {
      // The chain rewrites the SQL as it goes, so reporting the original text sends a
      // reader looking at a statement the server never saw. Here the MATERIALIZED hint
      // is stripped, the retry fails for an unrelated reason, and the error should
      // quote the stripped statement - the one that produced it.
      mockQueryFn = (sql: string) => {
        if (sql.includes("AS MATERIALIZED (")) {
          return Promise.reject(new Error("Expected left parenthesis, found MATERIALIZED"));
        }
        return Promise.reject(new Error('relation "tables_info" is not visible to this role'));
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const error = (await provider.getSchema().catch((e: unknown) => e)) as QueryError;
      expect(error).toBeInstanceOf(QueryError);
      expect(error.query).toBeDefined();
      expect(error.query).not.toContain("AS MATERIALIZED (");
    });

    test("getSchemaList(), which never joins the FK catalog, rethrows instead of retrying blind", async () => {
      // SCHEMA_LIST_SQL has no fk_info CTE to drop, so there is nothing this
      // fallback can rewrite. It must surface the error rather than loop or
      // quietly hand back a query it did not actually repair.
      mockQueryFn = () =>
        Promise.reject(new Error("unknown catalog item 'information_schema.constraint_column_usage'"));
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await expect(provider.getSchemaList()).rejects.toThrow(QueryError);
    });

    test("Materialize's full sequence: keyword, size builtin, json_agg, then the FK catalog", async () => {
      const attempts: string[] = [];
      mockQueryFn = (sql: string) => {
        attempts.push(sql);
        if (sql.includes("AS MATERIALIZED (")) {
          return Promise.reject(new Error("Expected left parenthesis, found MATERIALIZED"));
        }
        if (sql.includes("pg_total_relation_size(c.oid)")) {
          return Promise.reject(new Error('function "pg_total_relation_size" does not exist'));
        }
        if (sql.includes("json_agg(")) {
          return Promise.reject(new Error('function "json_agg" does not exist'));
        }
        if (sql.includes("constraint_column_usage")) {
          return Promise.reject(new Error("unknown catalog item 'information_schema.constraint_column_usage'"));
        }
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      // Connect's own EXPLAIN grammar probe (#597) is not one of the schema read's
      // attempts; what this counts is what getSchema() sent.
      attempts.length = 0;

      const schema = await provider.getSchema();
      expect(schema.length).toBe(2);
      expect(attempts.length).toBe(5);
      expect(countParens(attempts[4])).toEqual({ balanced: true });
    });
  });

  // --------------------------------------------------------------------------
  // Materialized views, and statistics panels on an engine that has no sizes
  // --------------------------------------------------------------------------

  describe("materialized views in the object browser", () => {
    test("the schema query asks for materialized views as well as base tables", async () => {
      // Materialize reports its materialized views through information_schema.tables
      // with table_type = 'MATERIALIZED VIEW', and they are the object its users
      // actually work with - a browser that lists only BASE TABLE hides the product.
      // Measured no-op elsewhere: PostgreSQL 18.4, TimescaleDB, YugabyteDB, Cloudberry,
      // AlloyDB Omni and CockroachDB never emit that table_type at all (PostgreSQL
      // leaves materialized views out of information_schema.tables entirely).
      const seen: string[] = [];
      mockQueryFn = (sql: string) => {
        seen.push(sql);
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await provider.getSchema();
      await provider.getSchemaList();

      const tableQueries = seen.filter((sql) => sql.includes("tables_info AS MATERIALIZED ("));
      expect(tableQueries.length).toBeGreaterThan(0);
      for (const sql of tableQueries) {
        expect(sql).toContain("'MATERIALIZED VIEW'");
        // Still a positive list, not "everything that is not a view": a FOREIGN or
        // SYSTEM VIEW row is not a table and must stay out.
        expect(sql).toContain("'BASE TABLE'");
        expect(sql).not.toContain("'SYSTEM VIEW'");
      }
    });
  });

  describe("statistics panels on an engine with no size functions", () => {
    // Measured on Materialize v26.37.0: getTableStats() dies on pg_table_size,
    // getIndexStats() on pg_stat_user_tables and the tablespace read on
    // pg_tablespace_size. All three REJECT rather than answering [], because
    // MonitoringData draws that exact distinction: an absent panel means "this engine
    // could not answer" and carries the engine's sentence under `errors`, while an
    // empty array claims the engine answered "nothing" - a measurement it never made.
    // PanelUnavailable then reads that sentence to decide whether the absence is an
    // engine limit or a refused statement (see monitoring-absence.ts).

    test("getTableStats() surfaces the engine's sentence instead of an empty result", async () => {
      mockQueryFn = (sql: string) => {
        if (sql.includes("pg_table_size")) {
          return Promise.reject(new Error('function "pg_table_size" does not exist'));
        }
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await expect(provider.getTableStats()).rejects.toThrow(/pg_table_size/);
    });

    test("getIndexStats() surfaces the engine's sentence instead of an empty result", async () => {
      mockQueryFn = (sql: string) => {
        if (sql.includes("pg_stat_user_indexes") || sql.includes("pg_stat_user_tables")) {
          return Promise.reject(new Error("unknown catalog item 'pg_stat_user_tables'"));
        }
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await expect(provider.getIndexStats()).rejects.toThrow(/pg_stat_user_tables/);
    });

    test("a planner restriction reaches the panel with its own wording", async () => {
      // Cloudberry's control case: pg_stat_user_tables exists there and the catalog is
      // readable, so this sentence must not be flattened into the same absence as a
      // missing function - a different statement could still succeed.
      mockQueryFn = () => Promise.reject(new Error("query plan with multiple segworker groups is not supported"));
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await expect(provider.getTableStats()).rejects.toThrow(/segworker/);
      await expect(provider.getIndexStats()).rejects.toThrow(/segworker/);
    });
  });

  // --------------------------------------------------------------------------
  // A relation that disappears while the schema is being read
  // --------------------------------------------------------------------------

  describe("concurrent DDL during a schema read", () => {
    // tables_info lists relations from information_schema and then resolves each name
    // to a pg_class row. A bare ::regclass cast RAISES when the name no longer resolves,
    // so a table dropped between those two steps failed the whole read. Reproduced on
    // PostgreSQL 18.4: with tables being created and dropped alongside, 102 of 400 runs
    // died with 'relation "public.materialized_daily_totals_396" does not exist'.
    //
    // to_regclass() answers NULL instead of raising, so the row survives with no
    // pg_class match and its count reads as absent - which it genuinely is.

    test("the schema query resolves names without raising", async () => {
      const seen: string[] = [];
      mockQueryFn = (sql: string) => {
        seen.push(sql);
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await provider.getSchema();

      const query = seen.find((sql) => sql.includes("tables_info AS MATERIALIZED ("));
      expect(query).toBeDefined();
      expect(query).toContain("to_regclass(");
    });

    test("an engine without to_regclass falls back to the cast and still reads", async () => {
      // Measured: Materialize has no to_regclass, while PostgreSQL, TimescaleDB,
      // YugabyteDB, Cloudberry, AlloyDB Omni and CockroachDB all do. The engine this
      // whole fallback chain exists for must not lose its object browser to the fix.
      const attempts: string[] = [];
      mockQueryFn = (sql: string) => {
        attempts.push(sql);
        if (sql.includes("to_regclass(")) {
          return Promise.reject(new Error('function "to_regclass" does not exist'));
        }
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      // Connect's own EXPLAIN grammar probe (#597) is not one of the schema read's
      // attempts; what this counts is what getSchema() sent.
      attempts.length = 0;

      const schema = await provider.getSchema();
      expect(schema.length).toBe(2);
      expect(attempts.length).toBe(2);
      expect(attempts[1]).not.toContain("to_regclass(");
      expect(attempts[1]).toContain("::regclass");
      expect(countParens(attempts[1])).toEqual({ balanced: true });
    });
  });

  // --------------------------------------------------------------------------
  // Row counts an engine has not actually counted
  // --------------------------------------------------------------------------

  describe("uncounted row estimates", () => {
    // pg_class.reltuples is -1 on PostgreSQL 14+ for a relation nothing has vacuumed
    // or analysed yet. Measured on a stock PostgreSQL 18.4: two tables holding 5000
    // and 1200 rows both answered -1 until ANALYZE ran, and the object browser showed
    // "0 rows" for both. A freshly restored dump is exactly that state, so the first
    // thing a new user sees is every table claiming to be empty.
    //
    // src/lib/agent/schema-stats.ts already reads -1 as absence and says why: "the
    // standing defect class in this repository is claiming a precision you do not
    // have". The object browser is the same read for a human instead of a model.
    function schemaWithRowCount(rowCount: string | null) {
      mockQueryFn = (sql: string) => {
        if (sql.includes("tables_info AS MATERIALIZED (")) {
          return Promise.resolve({
            rows: [
              {
                table_schema: "public",
                table_name: "orders",
                row_count: rowCount,
                total_size: "81920",
                columns: [],
                pk_columns: [],
                foreign_keys: [],
                indexes: [],
              },
            ],
            fields: [],
            rowCount: 1,
          });
        }
        return defaultMockQuery(sql);
      };
    }

    test("getSchema() leaves the count absent when the engine has not counted", async () => {
      schemaWithRowCount("-1");
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const [table] = await provider.getSchema();
      expect(table.rowCount).toBeUndefined();
    });

    test("getSchemaList() leaves it absent too", async () => {
      schemaWithRowCount("-1");
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const [table] = await provider.getSchemaList();
      expect(table.rowCount).toBeUndefined();
    });

    test("a table with no pg_class row is absent, not zero", async () => {
      // The CTE used to COALESCE a missing join to 0, which is the same fabrication
      // wearing a different hat: "no row here" is not "this table has no rows".
      schemaWithRowCount(null);
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const [table] = await provider.getSchema();
      expect(table.rowCount).toBeUndefined();
    });

    test("a real zero survives, because an empty table is a measurement", async () => {
      // The control. If absence swallowed 0 as well, this fix would trade one wrong
      // answer for another and the badge would vanish from every genuinely empty table.
      schemaWithRowCount("0");
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const [table] = await provider.getSchema();
      expect(table.rowCount).toBe(0);
    });

    test("the query no longer asks the database to invent a zero", async () => {
      const seen: string[] = [];
      mockQueryFn = (sql: string) => {
        seen.push(sql);
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await provider.getSchema();

      const schemaQuery = seen.find((sql) => sql.includes("tables_info AS MATERIALIZED ("));
      expect(schemaQuery).toBeDefined();
      expect(schemaQuery).not.toContain("COALESCE(c.reltuples");
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

    test("reports an unmeasurable cache hit ratio as unavailable, not as 100%", async () => {
      // pg_statio_user_tables aggregates to NULL on a database with no user tables.
      // Measured 2026-08-23 against postgres:18 on a freshly created database:
      //   heap_read | heap_hit | raw_ratio | coalesced
      //  -----------+----------+-----------+-----------
      //             |          |           |       100
      // The 100 was ours, produced by a COALESCE in our own SQL.
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        const normalized = sql.trim().toLowerCase();
        if (normalized.includes("pg_statio_user_tables")) {
          return { rows: [{ ratio: null, heap_read: null, heap_hit: null }], fields: [], rowCount: 1 };
        }
        return originalMock(sql, params);
      };

      const health = await provider.getHealth();
      expect(health.cacheHitRatio).toBe(CACHE_HIT_RATIO_UNAVAILABLE);
      mockQueryFn = originalMock;
    });

    test("keeps a measured cache hit ratio of zero, which is a cold cache and not an absence", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        const normalized = sql.trim().toLowerCase();
        if (normalized.includes("pg_statio_user_tables")) {
          return { rows: [{ ratio: "0.0", heap_read: "500", heap_hit: "0" }], fields: [], rowCount: 1 };
        }
        return originalMock(sql, params);
      };

      const health = await provider.getHealth();
      expect(health.cacheHitRatio).toBe("0.0%");
      expect(health.cacheHitRatio).not.toBe(CACHE_HIT_RATIO_UNAVAILABLE);
      mockQueryFn = originalMock;
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

    // Engines with no pg statistics catalog at all (Materialize, RisingWave)
    // reject every query below, not just pg_stat_statements. Each must degrade
    // its own panel instead of failing the whole health check (#38680).
    test("activeConnections is omitted when the pg_stat_activity count query fails", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        const normalized = sql.trim().toLowerCase();
        if (normalized.includes("count(*)") && normalized.includes("pg_stat_activity")) {
          throw new Error('relation "pg_stat_activity" does not exist');
        }
        return originalMock(sql, params);
      };

      const health = await provider.getHealth();
      expect(health.activeConnections).toBeUndefined();
    });

    test("databaseSize falls back to N/A when pg_database_size fails", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        const normalized = sql.trim().toLowerCase();
        if (normalized.includes("pg_size_pretty") && normalized.includes("pg_database_size")) {
          throw new Error("function pg_database_size(text) does not exist");
        }
        return originalMock(sql, params);
      };

      const health = await provider.getHealth();
      expect(health.databaseSize).toBe("N/A");
    });

    test("cacheHitRatio reports unavailable when pg_statio_user_tables fails outright", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        const normalized = sql.trim().toLowerCase();
        if (normalized.includes("pg_statio_user_tables")) {
          throw new Error('relation "pg_statio_user_tables" does not exist');
        }
        return originalMock(sql, params);
      };

      const health = await provider.getHealth();
      expect(health.cacheHitRatio).toBe(CACHE_HIT_RATIO_UNAVAILABLE);
    });

    test("activeSessions falls back to an empty array when the sessions query fails", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        const normalized = sql.trim().toLowerCase();
        if (
          normalized.includes("pg_stat_activity") &&
          normalized.includes("pid != pg_backend_pid()") &&
          normalized.includes("xact_start desc")
        ) {
          throw new Error('relation "pg_stat_activity" does not exist');
        }
        return originalMock(sql, params);
      };

      const health = await provider.getHealth();
      expect(health.activeSessions).toEqual([]);
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

    test("a size result without the expected column leaves overview size absent", async () => {
      mockQueryFn = async (sql: string) => {
        const normalized = sql.trim().toLowerCase();
        if (normalized.includes("pg_database_size") && normalized.includes("database_size_bytes")) {
          return Promise.resolve({ rows: [{ unexpected_column: "512 MB" }], fields: [], rowCount: 1 });
        }
        return defaultMockQuery(sql);
      };

      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(false);
      expect(overview.databaseSize).toBe("N/A");
    });

    test("a size read with no result row leaves overview size absent", async () => {
      mockQueryFn = async (sql: string) => {
        const normalized = sql.trim().toLowerCase();
        if (normalized.includes("pg_database_size") && normalized.includes("database_size_bytes")) {
          return Promise.resolve({ rows: [], fields: [], rowCount: 0 });
        }
        return defaultMockQuery(sql);
      };

      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(false);
      expect(overview.databaseSize).toBe("N/A");
    });

    test("a non-finite size leaves overview size absent", async () => {
      mockQueryFn = async (sql: string) => {
        const normalized = sql.trim().toLowerCase();
        if (normalized.includes("pg_database_size") && normalized.includes("database_size_bytes")) {
          return Promise.resolve({
            rows: [{ database_size_bytes: Number.POSITIVE_INFINITY }],
            fields: [],
            rowCount: 1,
          });
        }
        return defaultMockQuery(sql);
      };

      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(false);
      expect(overview.databaseSize).toBe("N/A");
    });

    test("a database that measures zero bytes keeps its measured zero size", async () => {
      // The anti-vacuity twin of the tests above: a null aggregate is a MEASURED zero the
      // provider must keep publishing, never an absence. It pins the shared helper's
      // contract rather than a state this engine produces - `pg_database_size()` is a
      // function, not an aggregate, and measured on PostgreSQL 18 a freshly created
      // database answers 7774735 bytes, never NULL and never zero. MySQL's `SUM()` over an
      // empty schema is where the null row is real.
      mockQueryFn = async (sql: string) => {
        const normalized = sql.trim().toLowerCase();
        if (normalized.includes("pg_database_size") && normalized.includes("database_size_bytes")) {
          return Promise.resolve({
            rows: [{ database_size_bytes: null }],
            fields: [],
            rowCount: 1,
          });
        }
        return defaultMockQuery(sql);
      };

      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(true);
      expect(overview.databaseSizeBytes).toBe(0);
      expect(overview.databaseSize).toBe("0 B");
    });

    test("the overview size read asks for the byte figure only", async () => {
      const seen: string[] = [];
      mockQueryFn = async (sql: string) => {
        seen.push(sql);
        return defaultMockQuery(sql);
      };

      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      await provider.getOverview();

      const sizeRead = seen.find((sql) => sql.includes("pg_database_size"));
      expect(sizeRead).toBeDefined();
      // `databaseSize` is `formatBytes(databaseSizeBytes)` now, the shape `mssql.ts`
      // uses, so a selected `pg_size_pretty()` would be a column nothing reads - and
      // one whose value disagreed with the published string on every rounding boundary.
      expect(sizeRead).not.toContain("pg_size_pretty");
      expect(sizeRead).toContain("database_size_bytes");
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

      expect(metrics.cacheHitRatio).toBe(98.75);
      // Not a metric PostgreSQL publishes; see the note in getPerformanceMetrics().
      expect("bufferPoolUsage" in metrics).toBe(false);
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

    test("omits the cache hit ratio when pg_statio_user_tables has nothing to divide", async () => {
      // A table nothing has read yet, measured 2026-08-23 on postgres:18:
      //   hit | read | raw_ratio
      //  -----+------+-----------
      //     0 |    0 |
      // NULLIF turns 0/0 into NULL, so the honest answer is no reading at all.
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        const normalized = sql.trim().toLowerCase();
        if (normalized.includes("pg_statio_user_tables")) {
          return { rows: [{ cache_hit_ratio: null }], fields: [], rowCount: 1 };
        }
        return originalMock(sql, params);
      };

      const metrics = await provider.getPerformanceMetrics();
      expect("cacheHitRatio" in metrics).toBe(false);
      mockQueryFn = originalMock;
    });

    test("keeps a measured cache hit ratio of zero", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        const normalized = sql.trim().toLowerCase();
        if (normalized.includes("pg_statio_user_tables")) {
          return { rows: [{ cache_hit_ratio: "0.00" }], fields: [], rowCount: 1 };
        }
        return originalMock(sql, params);
      };

      const metrics = await provider.getPerformanceMetrics();
      expect(metrics.cacheHitRatio).toBe(0);
      mockQueryFn = originalMock;
    });

    test("omits the deadlock count when pg_stat_database has no row for the database", async () => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        const normalized = sql.trim().toLowerCase();
        if (normalized.includes("pg_stat_database")) {
          return { rows: [], fields: [], rowCount: 0 };
        }
        return originalMock(sql, params);
      };

      const metrics = await provider.getPerformanceMetrics();
      expect("deadlocks" in metrics).toBe(false);
      mockQueryFn = originalMock;
    });

    test("reports an absent checkpoint reading as N/A rather than as zero seconds", async () => {
      // pg_stat_bgwriter still exists on PostgreSQL 17+ but the two checkpoint
      // columns moved to pg_stat_checkpointer, so the query throws there and the
      // catch already answers "N/A". This is the other shape: the view answers,
      // and both columns are NULL.
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      const originalMock = mockQueryFn;
      mockQueryFn = async (sql: string, params?: unknown[]) => {
        const normalized = sql.trim().toLowerCase();
        if (normalized.includes("pg_stat_bgwriter")) {
          return {
            rows: [{ checkpoint_write_time: null, checkpoint_sync_time: null }],
            fields: [],
            rowCount: 1,
          };
        }
        return originalMock(sql, params);
      };

      const metrics = await provider.getPerformanceMetrics();
      expect(metrics.checkpointWriteTime).toBe("N/A");
      mockQueryFn = originalMock;
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
    // #U9: the target grammar of each operation, declared next to it. PostgreSQL is
    // the engine both surfaces were already right about - every statement here has a
    // one-table form and a whole-database form - so this records the baseline the
    // other providers are measured against rather than a change in behaviour.
    test("declares the target grammar of every maintenance operation", () => {
      provider = new PostgresProvider(makePgConfig());
      const specs = provider.getCapabilities().maintenanceOperationSpecs;

      expect(specs).toEqual({
        vacuum: { label: "Vacuum Table", perEntity: true, global: true },
        analyze: { label: "Analyze Table", perEntity: true, global: true },
        reindex: { label: "Reindex Table", perEntity: true, global: true },
        // A backend PID comes from the Sessions panel; no table row and no global
        // card can supply one.
        kill: { label: "Terminate Backend", perEntity: false, global: false },
      });
      // Every declared operation carries a spec, and no spec names an operation the
      // provider does not declare.
      expect(Object.keys(specs ?? {}).sort()).toEqual([...provider.getCapabilities().maintenanceOperations].sort());
    });

    test("the vacuum label really means vacuum here", () => {
      // Absent is the default, so the four engines whose vacuum wording names
      // something else are the ones that have to say so (#496).
      expect(new PostgresProvider(makePgConfig()).getLabels().vacuumActionOperation).toBeUndefined();
    });
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
      // BEGIN/COMMIT/ROLLBACK run over one held pool client here, so the toolbar's
      // transaction trio and the sandbox toggle are offered (#464).
      expect(caps.supportsTransactions).toBe(true);
      // Inherited from the base capabilities: this engine declares foreign keys, so
      // an empty `foreignKeys` list is a fact about the schema or the role, never
      // about the engine (#414).
      expect(caps.declaresForeignKeys).toBe(true);
      expect(caps.maintenanceOperations).toContain("vacuum");
      expect(caps.maintenanceOperations).toContain("analyze");
      expect(caps.maintenanceOperations).toContain("reindex");
      expect(caps.maintenanceOperations).toContain("kill");
    });
  });

  // --------------------------------------------------------------------------
  // getLabels
  // --------------------------------------------------------------------------

  describe("getLabels()", () => {
    // The Operations tab's global reindex card was hardcoded to exactly this wording
    // for every engine. PostgreSQL is the engine it was written for - `runMaintenance`
    // sends `REINDEX DATABASE` with no target - so declaring it here changes nothing
    // on this provider and lets SQLite and Couchbase say what theirs does (#464).
    test("declares the global reindex wording the card used to hardcode", () => {
      const labels = new PostgresProvider(makePgConfig()).getLabels();

      expect(labels.reindexGlobalLabel).toBe("Run Reindex");
      expect(labels.reindexGlobalTitle).toBe("Rebuild Indexes");
      expect(labels.reindexGlobalDesc).toContain("REINDEX DATABASE");
      // The rest of the vocabulary is still the base default, not a local copy.
      expect(labels.entityName).toBe("Table");
      expect(labels.analyzeGlobalLabel).toBe("Run Analyze");
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

    test("the profile connection never probes the EXPLAIN grammar, so nothing it runs leaves the envelope", async () => {
      const fresh = new ReadOnlyEngineMock();
      mockQueryFn = (sql: string, params?: unknown[]) => fresh.query(sql, params);
      const profiled = new PostgresProvider(makePgConfig(), {}, { readOnly: true });
      await profiled.connect();

      // A bare probe at connect would be the first statement this connection ran
      // outside `BEGIN READ ONLY`. It buys nothing here: the agent composes its own
      // EXPLAIN from `ESTIMATING_EXPLAIN_PREFIX` rather than from this capability.
      expect(fresh.statements.map((s) => s.text)).toEqual([]);
      expect(profiled.getCapabilities().explainFormat).toBe("postgres-json");
      await profiled.disconnect();
    });

    test("an unprofiled provider on the same server DOES probe, so the skip is the profile's and not the mock's", async () => {
      // The control the assertion above needs: an empty statement list means nothing
      // ran only if this same fixture records a probe when one is issued.
      const fresh = new ReadOnlyEngineMock();
      mockQueryFn = (sql: string, params?: unknown[]) => fresh.query(sql, params);
      const editor = new PostgresProvider(makePgConfig());
      await editor.connect();

      expect(fresh.statements.map((s) => s.text)).toEqual(["EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1"]);
      await editor.disconnect();
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
      // Connect's own EXPLAIN grammar probe (#597), dropped for the reason the
      // beforeEach drops it: what this asserts is that queryReadOnly reached the
      // session with nothing.
      engine.statements.length = 0;

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

// ============================================================================
// Declared column types
// ============================================================================

describe("PostgresProvider declared column types", () => {
  /**
   * The OIDs and the names are both measured: `SELECT * FROM r5_types` on PostgreSQL
   * 18.4 reports exactly these `dataTypeID`s, and `format_type(oid, NULL)` spells them
   * exactly like this. The value arms matter as much as the type arms - `4.99` and the
   * timestamp are STRINGS on the wire, which is why nothing value-shaped could have
   * recovered `numeric` or `timestamp without time zone`.
   */
  test("query() reports what pg's OIDs declare", async () => {
    mockQueryFn = () =>
      Promise.resolve({
        rows: [{ price: "4.99", ts: "2013-05-26 14:50:58.951", id: "133" }],
        fields: [
          { name: "price", dataTypeID: 1700 },
          { name: "ts", dataTypeID: 1114 },
          { name: "id", dataTypeID: 20 },
        ],
        rowCount: 1,
      });

    const provider = new PostgresProvider(makePgConfig());
    await provider.connect();
    const result = await provider.query("SELECT price, ts, id FROM r5_types");

    expect(result.columnTypes).toEqual({
      price: "numeric",
      ts: "timestamp without time zone",
      id: "bigint",
    });
    await provider.disconnect();
  });

  test("a user-defined OID is absent rather than wrongly named", async () => {
    // dvdrental's `film.rating` is the enum `mpaa_rating`, OID 16504 in that database.
    mockQueryFn = () =>
      Promise.resolve({
        rows: [{ rating: "NC-17", film_id: 133 }],
        fields: [
          { name: "rating", dataTypeID: 16504 },
          { name: "film_id", dataTypeID: 23 },
        ],
        rowCount: 1,
      });

    const provider = new PostgresProvider(makePgConfig());
    await provider.connect();
    const result = await provider.query("SELECT rating, film_id FROM film");

    expect(result.columnTypes).toEqual({ film_id: "integer" });
    expect(Object.hasOwn(result.columnTypes!, "rating")).toBe(false);
    await provider.disconnect();
  });

  test("the key is omitted entirely when no column declared a type", async () => {
    mockQueryFn = () => Promise.resolve({ rows: [], fields: [], rowCount: 0 });

    const provider = new PostgresProvider(makePgConfig());
    await provider.connect();
    const result = await provider.query("CREATE TABLE t (a int)");

    expect(result.columnTypes).toBeUndefined();
    expect(Object.hasOwn(result, "columnTypes")).toBe(false);
    await provider.disconnect();
  });

  test("queryInTransaction() declares them too", async () => {
    mockQueryFn = (sql) =>
      Promise.resolve(
        sql === "BEGIN"
          ? { rows: [], fields: [], rowCount: 0 }
          : { rows: [{ d: "2026-08-23" }], fields: [{ name: "d", dataTypeID: 1082 }], rowCount: 1 },
      );

    const provider = new PostgresProvider(makePgConfig());
    await provider.connect();
    await provider.beginTransaction();
    const result = await provider.queryInTransaction("SELECT d FROM r5_types");

    expect(result.columnTypes).toEqual({ d: "date" });
    await provider.rollbackTransaction();
    await provider.disconnect();
  });

  test("queryReadOnly() declares them without a catalog round trip", async () => {
    // The profile promises EXACTLY ONE statement inside BEGIN READ ONLY, so the
    // statements it sends are asserted here alongside the types: a lookup added for a
    // column label would show up in this list.
    const sent: string[] = [];
    mockQueryFn = (arg) => {
      // The profile sends its one statement on the extended protocol, which means a
      // QueryConfig OBJECT rather than a string (`queryMode: "extended"`).
      const sql = typeof arg === "string" ? arg : (arg as unknown as { text: string }).text;
      sent.push(sql);
      return Promise.resolve(
        sql === "SELECT price FROM r5_types"
          ? { rows: [{ price: "4.99" }], fields: [{ name: "price", dataTypeID: 1700 }], rowCount: 1 }
          : {
              rows: [
                {
                  is_superuser: false,
                  reads_server_files: false,
                  writes_server_files: false,
                  executes_programs: false,
                },
              ],
              fields: [],
              rowCount: 1,
            },
      );
    };

    const provider = new PostgresProvider(makePgConfig(), {}, { readOnly: true });
    await provider.connect();
    const result = await provider.queryReadOnly("SELECT price FROM r5_types", {
      statementTimeoutMs: 4500,
      maxResultRows: 10,
      maxResultBytes: 10_000,
    } as ReadOnlyStatementBudget);

    expect(result.columnTypes).toEqual({ price: "numeric" });
    expect(sent.slice(-5)).toEqual([
      "BEGIN READ ONLY",
      "SET LOCAL statement_timeout = 4500",
      "SELECT price FROM r5_types",
      "ROLLBACK",
      "DISCARD ALL",
    ]);
    await provider.disconnect();
  });
});

// ============================================================================
// The connect-time EXPLAIN grammar probe (#597)
// ============================================================================
/**
 * `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` is PostgreSQL's grammar, not the wire
 * family's. Measured 2026-09-06 through `pg` against live containers:
 *
 * - Materialize v26.40.0 refuses it with `Expected SELECT, VALUES, or a subquery in
 *   the query body, found ANALYZE`, and refuses a bare `(FORMAT JSON)` the same way.
 *   It has no `EXPLAIN ANALYZE` either (`Expected one of CPU or MEMORY, found
 *   SELECT`), so the plain `EXPLAIN` is all it publishes.
 * - CockroachDB v26.2.5 refuses it with `at or near "analyze": syntax error` - its
 *   option vocabulary is its own - but accepts an unparenthesised `EXPLAIN ANALYZE`.
 * - PostgreSQL 18, TimescaleDB (PG 17.11), YugabyteDB 2.25.2, Cloudberry 2.1.0 and
 *   AlloyDB Omni (PG 17.9) all accept the parenthesised form and stop at the first
 *   probe.
 *
 * The refusals below are those runs' own words. Nothing here reads the message: the
 * family shares no code for a grammar refusal any more than the MySQL family does
 * (#574), so the probe asks and reads success or failure.
 */
describe("PostgresProvider EXPLAIN grammar probe", () => {
  let sent: string[];

  /**
   * A server that refuses the statements named here and answers everything else the
   * way the shared fixture does.
   */
  function refusing(refusals: Record<string, string>) {
    return (sql: string, params?: unknown[]) => {
      sent.push(sql);
      const refusal = refusals[sql.trim().toLowerCase()];
      return refusal === undefined ? defaultMockQuery(sql) : Promise.reject(new Error(refusal));
    };
  }

  const MATERIALIZE_REFUSAL = "Expected SELECT, VALUES, or a subquery in the query body, found ANALYZE";
  const MATERIALIZE_ANALYZE_REFUSAL = "Expected one of CPU or MEMORY, found SELECT";
  const COCKROACH_REFUSAL = 'at or near "analyze": syntax error';

  /** Only the statements the probe issued, in order. */
  const probed = () => sent.filter((sql) => sql.toLowerCase().startsWith("explain"));

  beforeEach(() => {
    sent = [];
    mockQueryFn = refusing({});
  });

  test("before connect the provider answers the static PostgreSQL default", () => {
    const caps = new PostgresProvider(makePgConfig()).getCapabilities();

    // `POST /api/db/provider-meta` never connects (#457), so this is what the client's
    // pre-flight sees, and it must stay what it has always been.
    expect(caps.explainFormat).toBe("postgres-json");
    expect(caps.supportsExplain).toBe(true);
    expect(probed()).toEqual([]);
  });

  test("a server that accepts the parenthesised JSON form keeps postgres-json, after one statement", async () => {
    const provider = new PostgresProvider(makePgConfig());
    await provider.connect();

    expect(provider.getCapabilities().explainFormat).toBe("postgres-json");
    expect(probed()).toEqual(["EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1"]);
    await provider.disconnect();
  });

  test("CockroachDB refuses the parenthesised form and accepts EXPLAIN ANALYZE, so the format is postgres-text-analyze", async () => {
    mockQueryFn = refusing({ "explain (analyze, buffers, format json) select 1": COCKROACH_REFUSAL });

    const provider = new PostgresProvider(makePgConfig());
    await provider.connect();

    expect(provider.getCapabilities().explainFormat).toBe("postgres-text-analyze");
    expect(probed()).toEqual(["EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1", "EXPLAIN ANALYZE SELECT 1"]);
    await provider.disconnect();
  });

  test("Materialize refuses both analyze grammars and lands on the plain EXPLAIN", async () => {
    mockQueryFn = refusing({
      "explain (analyze, buffers, format json) select 1": MATERIALIZE_REFUSAL,
      "explain analyze select 1": MATERIALIZE_ANALYZE_REFUSAL,
    });

    const provider = new PostgresProvider(makePgConfig());
    await provider.connect();
    const caps = provider.getCapabilities();

    expect(caps.explainFormat).toBe("postgres-text");
    expect(caps.supportsExplain).toBe(true);
    expect(probed()).toEqual([
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1",
      "EXPLAIN ANALYZE SELECT 1",
      "EXPLAIN SELECT 1",
    ]);
    await provider.disconnect();
  });

  test("a server that refuses every grammar declares no explain support and no format", async () => {
    mockQueryFn = refusing({
      "explain (analyze, buffers, format json) select 1": MATERIALIZE_REFUSAL,
      "explain analyze select 1": MATERIALIZE_ANALYZE_REFUSAL,
      "explain select 1": 'syntax error at or near "EXPLAIN"',
    });

    const provider = new PostgresProvider(makePgConfig());
    await provider.connect();
    const caps = provider.getCapabilities();

    expect(caps.supportsExplain).toBe(false);
    // Absent, not undefined-valued: `explainFormat` is present iff supportsExplain is.
    expect("explainFormat" in caps).toBe(false);
    await provider.disconnect();
  });

  test("a grammar the server does not have never fails the connection", async () => {
    mockQueryFn = refusing({
      "explain (analyze, buffers, format json) select 1": MATERIALIZE_REFUSAL,
      "explain analyze select 1": MATERIALIZE_ANALYZE_REFUSAL,
      "explain select 1": "syntax error",
    });

    const provider = new PostgresProvider(makePgConfig());
    await provider.connect();

    // The Explain panel is not the connection. A refused grammar is a fact about the
    // panel and the capability it produces IS the report.
    expect(provider.isConnected()).toBe(true);
    await provider.disconnect();
  });

  test("the probe runs again on the next connect, because the next server may be another engine", async () => {
    const provider = new PostgresProvider(makePgConfig());
    await provider.connect();
    expect(provider.getCapabilities().explainFormat).toBe("postgres-json");
    await provider.disconnect();

    mockQueryFn = refusing({
      "explain (analyze, buffers, format json) select 1": MATERIALIZE_REFUSAL,
      "explain analyze select 1": MATERIALIZE_ANALYZE_REFUSAL,
    });
    await provider.connect();

    expect(provider.getCapabilities().explainFormat).toBe("postgres-text");
    await provider.disconnect();
  });
});
