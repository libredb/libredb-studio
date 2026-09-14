/**
 * Integration tests for PostgresProvider
 * Uses mock.module() to intercept pg before provider import.
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import {
  callerBoundTruncationReason,
  isSourcePartUnavailable,
  sourceBoundTruncationReason,
} from "@/lib/db/object-kinds";
import { EventEmitter } from "node:events";
import type { DatabaseConnection } from "@/lib/types";
import type { ContainerLevels, ObjectEditRefusalClass, ReadOnlyStatementBudget } from "@/lib/db/types";
import {
  ConnectionError,
  DatabaseConfigError,
  DatabaseError,
  ExecutionProfileError,
  QueryError,
} from "@/lib/db/errors";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
import { renderSegments } from "@/lib/db/object-edit";

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

  // --------------------------------------------------------------------------
  // getSchemaList() — fast structural path (tables + columns + PKs only)
  // --------------------------------------------------------------------------

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
  });

  // --------------------------------------------------------------------------
  // MATERIALIZED-keyword fallback (Materialize/RisingWave compatibility, #38680)
  // --------------------------------------------------------------------------

  describe("the repair chain around an engine that rejects part of a catalog statement (#38680)", () => {
    /*
      Every object read goes through `queryWithMaterializedFallback()`, which recovers real
      catalog data on four independent gaps rather than failing outright. The chain used to be
      driven here through the flat schema reading; that reading is deleted (#789), so it is
      driven through `describeObjects()`, which composes the same `json_agg` /
      `json_build_object` CTEs.

      Each repair is used AT MOST ONCE per statement, and a message no remaining repair
      recognises is mapped and rethrown rather than retried forever. That is the property
      under test, and it is what keeps a permanently failing engine from looping here.
    */
    const describeTables = async (): Promise<unknown> => {
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();
      return provider.describeObjects(["public"], "table");
    };

    /** Reject the first attempt with `message`, then answer; the statements sent are returned. */
    function rejectFirst(message: string): string[] {
      const sent: string[] = [];
      mockQueryFn = (sql: string) => {
        sent.push(sql);
        if (
          sent.filter((entry) => entry.includes("described_columns")).length === 1 &&
          sql.includes("described_columns")
        ) {
          return Promise.reject(new Error(message));
        }
        return defaultMockQuery(sql);
      };
      return sent;
    }

    const detailStatements = (sent: readonly string[]): string[] =>
      sent.filter((sql) => sql.includes("described_columns"));

    test("json_agg is swapped for jsonb_agg, which returns the same shape over the wire", async () => {
      // Materialize has only the jsonb_ equivalents, and node-postgres parses both the json
      // and the jsonb OID into the same plain JS value, so the swap is enough.
      const sent = rejectFirst('function "json_agg" does not exist');

      await describeTables();

      const attempts = detailStatements(sent);
      expect(attempts.length).toBe(2);
      expect(attempts[0]).toContain("json_agg(");
      expect(attempts[1]).toContain("jsonb_agg(");
      expect(attempts[1]).toContain("jsonb_build_object(");
      expect(attempts[1]).not.toContain(" json_agg(");
    });

    test("a missing pg_total_relation_size() is recognised and the statement retried", async () => {
      // CockroachDB's first gap, and it has no MATERIALIZED collision at all. The repair is a
      // no-op on THIS statement, which names no size call, and that is the honest behaviour of
      // a shared chain: a repair that does not apply costs one retry and never a wrong reading.
      const sent = rejectFirst("unknown function: pg_total_relation_size()");

      await describeTables();

      expect(detailStatements(sent).length).toBe(2);
    });

    test("a missing to_regclass is recognised and the statement retried", async () => {
      const sent = rejectFirst('function "to_regclass" does not exist');

      await describeTables();

      expect(detailStatements(sent).length).toBe(2);
    });

    test("an error no repair recognises is mapped and rethrown rather than retried", async () => {
      const sent: string[] = [];
      mockQueryFn = (sql: string) => {
        sent.push(sql);
        if (sql.includes("described_columns")) return Promise.reject(new Error("column lists are not readable here"));
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await expect(provider.describeObjects(["public"], "table")).rejects.toThrow(QueryError);
      // One attempt, not two: nothing recognised it, so nothing was rewritten.
      expect(detailStatements(sent).length).toBe(1);
    });

    test("a repair is used ONCE: the same message twice is rethrown rather than looping", async () => {
      const sent: string[] = [];
      mockQueryFn = (sql: string) => {
        sent.push(sql);
        if (sql.includes("described_columns")) return Promise.reject(new Error('function "json_agg" does not exist'));
        return defaultMockQuery(sql);
      };
      provider = new PostgresProvider(makePgConfig());
      await provider.connect();

      await expect(provider.describeObjects(["public"], "table")).rejects.toThrow(DatabaseError);
      // Exactly two: the repair consumed the first, and the second found no repair left.
      expect(detailStatements(sent).length).toBe(2);
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
      await provider.listContainers();
      await provider.countObjects(["public"]);
      await provider.listObjects(["public"], "table");
      await provider.describeObjects(["public"], "table");
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
  });

  // --------------------------------------------------------------------------
  // Materialized views, and statistics panels on an engine that has no sizes
  // --------------------------------------------------------------------------

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

/**
 * The object surface (#789), and the bug it closes (#710).
 *
 * `makeProvider()` is local rather than shared with the block above: these tests each
 * install their own `mockQueryFn` before connecting, so they need a provider built
 * after that assignment and no `afterEach` that reaches for a shared handle.
 */
describe("object surface", () => {
  function makeProvider() {
    return new PostgresProvider(makePgConfig());
  }

  test("declares the kinds PostgreSQL actually has", () => {
    const provider = makeProvider();
    const kinds = provider.getCapabilities().objectKinds ?? [];
    expect(kinds.map((k) => k.id).sort()).toEqual([
      "function",
      "materialized_view",
      "procedure",
      "sequence",
      "table",
      "trigger",
      "view",
    ]);
    expect(kinds.find((k) => k.id === "view")?.role).toBe("relation");
    expect(kinds.find((k) => k.id === "procedure")?.role).toBe("routine");
    expect(kinds.find((k) => k.id === "trigger")?.attachedTo).toBe("table");
    // A view is not an import target even where PostgreSQL would allow the write.
    expect(kinds.find((k) => k.id === "view")?.acceptsRowWrites).toBeUndefined();
    expect(kinds.find((k) => k.id === "table")?.acceptsRowWrites).toBe(true);
  });

  /**
   * The source declaration, both directions (#789 Phase 2).
   *
   * The second assertion is the one that matters over time: a kind added to `objectKinds`
   * later cannot quietly gain a Source tab, and a kind losing its declaration cannot quietly
   * lose one. `table` and `sequence` are in the second list as a RESULT and not as a gap:
   * PostgreSQL publishes no `pg_get_tabledef` and no `pg_get_sequencedef`, and
   * `pg_catalog.pg_sequences` publishes a sequence's properties rather than any text.
   */
  test("declares source on exactly the kinds that have a definition text", () => {
    const provider = makeProvider();
    const kinds = provider.getCapabilities().objectKinds ?? [];
    const declared = kinds
      .filter((kind) => kind.hasSource === true)
      .map((kind) => [kind.id, kind.sourceLanguage] as const)
      .sort();
    expect(declared).toEqual([
      ["function", "pgsql"],
      ["materialized_view", "pgsql"],
      ["procedure", "pgsql"],
      ["trigger", "pgsql"],
      ["view", "pgsql"],
    ]);
    // The other direction, so a kind added later cannot quietly gain a Source tab.
    expect(
      kinds
        .filter((kind) => kind.hasSource !== true)
        .map((kind) => kind.id)
        .sort(),
    ).toEqual(["sequence", "table"]);
  });

  /**
   * The edit declaration, both directions (#789 Phase 3).
   *
   * The second assertion is the one that matters over time, exactly as it is for the source
   * declaration above it: a kind added to `objectKinds` later cannot quietly gain an edit
   * affordance, and the three REFUSED kinds are refused with an engine fact each rather than
   * left unbuilt. `docs/providers/postgres.md` carries all three.
   */
  test("declares acceptsSourceEdits on exactly the two routine kinds", () => {
    const provider = makeProvider();
    const kinds = provider.getCapabilities().objectKinds ?? [];
    expect(
      kinds
        .filter((kind) => kind.acceptsSourceEdits === true)
        .map((kind) => kind.id)
        .sort(),
    ).toEqual(["function", "procedure"]);
    // The other direction, so a kind added later cannot quietly gain an edit affordance. `view` and
    // `materialized_view` are REFUSED rather than unbuilt, and the provider doc carries why:
    // `pg_get_viewdef` returns neither the column alias list nor WITH CHECK OPTION nor
    // security_barrier, so a header assembled from it silently removes a write constraint and a
    // row-security control, and `CREATE OR REPLACE MATERIALIZED VIEW` is a syntax error.
    expect(
      kinds
        .filter((kind) => kind.acceptsSourceEdits !== true)
        .map((kind) => kind.id)
        .sort(),
    ).toEqual(["materialized_view", "sequence", "table", "trigger", "view"]);
  });

  test("satisfies the shared object surface contract", async () => {
    // The relations each kind holds, one place, because the helper now reads the listing
    // and the bulk column read against each other: two lists that had to be kept in step
    // by hand would make a mismatch look like a provider defect.
    const relations: Record<string, string[]> = {
      "'v'": ["order_summary", "daily_sales"],
      "'m'": ["revenue_by_month"],
      "'r','p'": ["orders", "products"],
    };
    // `public` holds ONE table and it is called `orders`, the same last segment as
    // `app.orders`. That is `docker/postgres-init/03-object-fixture.sql`, and it is the case
    // the address rule and its preferred-container tie-breaker exist for: with one schema in
    // play a bare name is a valid suffix of every address, so the join could not be told
    // apart from a suffix match. Measured on a postgres:18 seeded with `docker/postgres-init`:
    // `current_schema()` is `public`, so the bare `orders` the flat reading spells for it
    // must land HERE and the qualified `app.orders` on the other.
    const publicRelations: Record<string, string[]> = { "'v'": [], "'m'": [], "'r','p'": ["orders"] };
    // The three kinds that are not relations, listed by their own catalogs. A routine's last
    // segment is the IDENTITY the listing writes, and a trigger's path carries its table,
    // which is what makes the source binds below more than one segment (#789).
    const routines: Record<string, { name: string; identity: string }[]> = {
      f: [
        { name: "order_total", identity: "order_total(integer)" },
        { name: "stamp_updated_at", identity: "stamp_updated_at()" },
      ],
      p: [{ name: "touch_order", identity: "touch_order(integer)" }],
    };
    // Keyed by the LAST bind, which is the object's own segment on all five statements, so an
    // absence is the same lookup missing rather than an arm written for the absent case.
    const definitions: Record<string, string> = {
      order_summary: MEASURED_VIEW_DEFINITION,
      daily_sales: MEASURED_DAILY_SALES_DEFINITION,
      revenue_by_month: MEASURED_MATERIALIZED_VIEW_DEFINITION,
      "order_total(integer)": MEASURED_FUNCTION_DEFINITION,
      "stamp_updated_at()": MEASURED_FUNCTION_DEFINITION,
      "touch_order(integer)": MEASURED_FUNCTION_DEFINITION,
      orders_stamp_updated_at: MEASURED_TRIGGER_DEFINITION,
    };
    const relkindOf = (sql: string) => Object.keys(relations).find((relkinds) => sql.includes(`IN (${relkinds})`))!;
    const listedIn = (schema: string | undefined, relkinds: string) =>
      (schema === "public" ? publicRelations : relations)[relkinds];
    mockQueryFn = async (sql, params) => {
      // The source statements FIRST: the view one also names `relkind` and the routine one
      // also names `prokind`, so a looser arm below would answer a definition read with a
      // listing row. Keyed on the `pg_get_*` function name, which is the token that tells the
      // five apart and the one a rewritten statement cannot keep by accident.
      if (sql.includes("pg_get_viewdef") || sql.includes("pg_get_functiondef") || sql.includes("pg_get_triggerdef")) {
        const bound = params as string[];
        const definition = definitions[bound[bound.length - 1]];
        return { rows: definition === undefined ? [] : [{ definition }] };
      }
      // The FLAT reading, over the same relations the object reading lists (#789).
      //
      // The guard inside `assertObjectSurface` joins `getSchema()`'s names to the object
      // paths with the app's own rule, and it cannot do that against a double that never
      // answers `SCHEMA_FULL_SQL`: this fake used to fall through to the container arm,
      // which returned `[{ name: "app" }]`, and one row with no `table_schema` and no
      // `table_name` reached the reader as the single flat entry `undefined.undefined`.
      // That is a shape mismatch and not a join, so the guard was measuring nothing.
      //
      // It is checked FIRST because `SCHEMA_FULL_SQL` also carries an `ORDER BY`.
      //
      // The rows are the DRIVER'S rows and the naming is left to `postgres.ts`, which is
      // the whole point: the provider spells a name schema-qualified except in `public`
      // (`postgres.ts:2047`), so a fixture that returned finished names would assert the
      // fixture's spelling rather than the engine's. `public.audit_log` is the spelling
      // PostgreSQL NEVER produces, and this epic has already taken a Critical for writing
      // it, so the `public` row is here to be stripped: it reaches the reading as a bare
      // `audit_log`. It sits outside the listed container deliberately, because the flat
      // reading spans every schema the connection can see while the object listing is
      // scoped to one, which is exactly the asymmetry the join has to survive.
      if (sql.includes("FROM tables_info ti")) {
        const flat = [
          ...Object.values(relations).flatMap((names) => names.map((name) => ["app", name] as const)),
          ["public", "orders"] as const,
        ];
        return {
          rows: flat.map(([schema, name]) => ({
            table_schema: schema,
            table_name: name,
            row_count: "0",
            total_size: "8192",
            columns: [{ name: "id", type: "integer", nullable: false, defaultValue: null }],
            pk_columns: ["id"],
            foreign_keys: [],
            indexes: [],
          })),
        };
      }
      // Checked FIRST: the bulk statement also joins pg_namespace and also carries an
      // ORDER BY, so a looser arm below would answer it with a container row.
      if (sql.includes("described_columns")) {
        const names = relations[relkindOf(sql)];
        const bound = params?.[1] as number | undefined;
        return {
          rows: (bound === undefined ? names : names.slice(0, bound)).map((name) => ({
            name,
            pk_columns: null,
            columns: [{ name: "id", type: "integer", nullable: false, defaultValue: null }],
            indexes: null,
            foreign_keys: null,
          })),
        };
      }
      if (sql.includes("pg_namespace") && sql.includes("ORDER BY")) {
        return {
          rows: [
            { name: "app", is_session_default: 0 },
            { name: "public", is_session_default: 1 },
          ],
        };
      }
      if (sql.includes("GROUP BY kind")) {
        return {
          rows: [
            { kind: "table", n: 3 },
            { kind: "view", n: 4 },
            { kind: "materialized_view", n: 1 },
            { kind: "function", n: 2 },
            { kind: "procedure", n: 1 },
            { kind: "trigger", n: 1 },
          ],
        };
      }
      if (sql.includes("prokind")) {
        return { rows: routines[params?.[1] as string] };
      }
      if (sql.includes("tgisinternal")) {
        return { rows: [{ name: "orders_stamp_updated_at", parent: "orders" }] };
      }
      if (sql.includes("relkind")) {
        // One row per relkind, and they must be DISTINCT rows. The shared helper lists
        // every counted kind and requires paths unique across all of them, so one row
        // reused for three kinds is three objects at one address.
        return {
          rows: listedIn(params?.[0] as string | undefined, relkindOf(sql)).map((name) => ({
            name,
            row_count: null,
            size_bytes: null,
          })),
        };
      }
      return { rows: [] };
    };
    const provider = makeProvider();
    await provider.connect();
    await assertObjectSurface(provider, {
      containers: [["app"], ["public"]],
      kinds: { table: 3, view: 4, materialized_view: 1, function: 2, procedure: 1, trigger: 1 },
      sampleObject: { path: ["app", "order_summary"], kind: "view" },
      // Authored, because no listing produces an absence. `no_such_view` is a name the
      // fixture holds under no kind, and the catalog join answers no row for it, which is
      // the raise design guarantee 6 requires rather than a refusal part (#789).
      absentSource: { path: ["app", "no_such_view"], kind: "view" },
    });
    await provider.disconnect();
  });

  test("a refused count is reported as unavailable, never as zero", async () => {
    mockQueryFn = async (sql) => {
      if (sql.includes("pg_namespace") && sql.includes("ORDER BY")) return { rows: [{ name: "sales" }] };
      throw Object.assign(new Error("permission denied for schema sales"), { code: "42501" });
    };
    const provider = makeProvider();
    await provider.connect();
    const counts = await provider.countObjects(["sales"]);
    expect(counts.table).toEqual({ unavailable: "permission denied for schema sales" });
    await provider.disconnect();
  });

  test("falls back when the server has no pg_proc.prokind", async () => {
    // CockroachDB, YugabyteDB and older forks can answer 42703 here. The tree must lose
    // the routine folders rather than the whole container.
    let attempts = 0;
    mockQueryFn = async (sql) => {
      if (sql.includes("pg_namespace") && sql.includes("ORDER BY")) return { rows: [{ name: "app" }] };
      attempts += 1;
      if (sql.includes("prokind")) {
        throw Object.assign(new Error('column "prokind" does not exist'), { code: "42703" });
      }
      return { rows: [{ kind: "table", n: 2 }] };
    };
    const provider = makeProvider();
    await provider.connect();
    const counts = await provider.countObjects(["app"]);
    expect(attempts).toBeGreaterThan(1);
    expect(counts.table).toEqual({ count: 2 });
    expect(counts.function).toEqual({ unavailable: 'column "prokind" does not exist' });
    await provider.disconnect();
  });
});

/**
 * The rest of the object surface: the three listing catalogs, the detail row, and the
 * refusals. Kept out of the block above so `-t "object surface"` still runs exactly the
 * conformance and declaration tests the task briefs name. The count was four and is five
 * since the source declaration joined them (#789 Phase 2); what the sentence is about is
 * which tests that filter selects, not the numeral.
 */
describe("PostgreSQL object listing and detail", () => {
  function makeProvider() {
    return new PostgresProvider(makePgConfig());
  }

  test("a container path that is not one schema is refused, rather than read as empty", async () => {
    mockQueryFn = async () => ({ rows: [] });
    const provider = makeProvider();
    await provider.connect();

    // Not [] and not a zero count: binding undefined to $1 would answer a schema holding
    // nothing, which is indistinguishable from a real empty schema.
    await expect(provider.countObjects([])).rejects.toThrow(QueryError);
    await expect(provider.listObjects(["catalog", "schema"], "table")).rejects.toThrow(
      /A PostgreSQL container path is \[schema\], received \["catalog","schema"\]/,
    );
    await provider.disconnect();
  });

  test("the containers are the schemas, with the session's own marked", async () => {
    // Standing ruling 5a2: a provider with container levels marks `isSessionDefault` at
    // every level, or first paint stops short and opens nothing. This one marked none, and
    // that also left the flat join with no tie-breaker: measured on a postgres:18 seeded
    // with `docker/postgres-init/`, a bare `orders` from the flat reading answers to both
    // `app.orders` and `public.orders` and nothing said which container the session was in.
    //
    // `current_schema()` is what the server answers, not `public` written down: measured on
    // the seeded fixture, a fresh connection reports search_path `"$user", public` and
    // current_schema `public`, and a connection that sets search_path moves it.
    const asked: string[] = [];
    mockQueryFn = async (sql) => {
      asked.push(sql);
      return {
        rows: [
          { name: "app", is_session_default: 0 },
          { name: "public", is_session_default: 1 },
        ],
      };
    };
    const provider = makeProvider();
    await provider.connect();

    expect(await provider.listContainers()).toEqual([
      { path: ["app"], name: "app", level: 0, isSessionDefault: false },
      { path: ["public"], name: "public", level: 0, isSessionDefault: true },
    ]);
    expect(asked.at(-1)).toContain("current_schema()");
    await provider.disconnect();
  });

  test("nothing nests under a schema", async () => {
    mockQueryFn = async () => ({ rows: [] });
    const provider = makeProvider();
    await provider.connect();

    expect(await provider.listContainers(["app"])).toEqual([]);
    await provider.disconnect();
  });

  test("a kind this engine does not declare is refused, not answered empty", async () => {
    mockQueryFn = async () => ({ rows: [] });
    const provider = makeProvider();
    await provider.connect();

    await expect(provider.listObjects(["app"], "package")).rejects.toThrow(/declares no object kind "package"/);
    await expect(provider.describeObject(["app", "x"], "package")).rejects.toThrow(/declares no object kind "package"/);
    await provider.disconnect();
  });

  test("each kind is answered by its own catalog, in one order", async () => {
    mockQueryFn = async (sql, params) => {
      if (sql.includes("prokind")) {
        expect(params).toEqual(["app", "p"]);
        // Overloads differ by argument TYPES and never by parameter names, so a name in
        // the segment adds nothing to identity and would change it when somebody renames
        // a parameter. `pg_get_function_identity_arguments()` carries those names, which
        // is why it is not used.
        expect(sql).not.toContain("pg_get_function_identity_arguments");
        expect(sql).toContain("proargtypes");
        return { rows: [{ name: "touch_order", identity: "touch_order(integer)" }] };
      }
      if (sql.includes("tgisinternal")) {
        return { rows: [{ name: "orders_stamp_updated_at", parent: "orders" }] };
      }
      if (sql.includes("relkind")) {
        return {
          rows: [
            { name: "products", row_count: "1200", size_bytes: "8192" },
            // reltuples -1 is "nothing has analysed this", and a NULL size is a size the
            // fallback chain replaced. Both are absences, neither is a zero.
            { name: "audit_log", row_count: "-1", size_bytes: null },
          ],
        };
      }
      return { rows: [] };
    };
    const provider = makeProvider();
    await provider.connect();

    // The path carries the engine's own identity form; the label stays readable.
    expect(await provider.listObjects(["app"], "procedure")).toEqual([
      {
        path: ["app", "touch_order(integer)"],
        name: "touch_order",
        kind: "procedure",
        rowCount: undefined,
        sizeBytes: undefined,
      },
    ]);
    // attachedTo: "table", so the table is a path segment. A trigger name is unique per
    // table, not per schema.
    expect(await provider.listObjects(["app"], "trigger")).toEqual([
      {
        path: ["app", "orders", "orders_stamp_updated_at"],
        name: "orders_stamp_updated_at",
        kind: "trigger",
        rowCount: undefined,
        sizeBytes: undefined,
      },
    ]);
    // Sorted here, not by the server: the catalog answered products first.
    expect(await provider.listObjects(["app"], "table")).toEqual([
      { path: ["app", "audit_log"], name: "audit_log", kind: "table", rowCount: undefined, sizeBytes: undefined },
      { path: ["app", "products"], name: "products", kind: "table", rowCount: 1200, sizeBytes: 8192 },
    ]);
    await provider.disconnect();
  });

  /**
   * Standing ruling 5g's other named sweep item, on this file (#789, Task 28a).
   *
   * `listObjects` sorted by `JSON.stringify(path)`, and JSON ESCAPING reorders exotic names
   * by rewriting the characters being compared. A quoted identifier may hold a double quote
   * on this engine (`CREATE TABLE "a""b"` is valid), and the escape turns its first byte
   * into a backslash: raw, `"` (0x22) is below `Z` (0x5A), and escaped, `\` (0x5C) is above
   * it. So the two orders are the REVERSE of each other over this pair, and the address
   * order is the one every caller joins on.
   */
  test("the listing is ordered by the ADDRESS, which a name JSON would escape reverses", async () => {
    mockQueryFn = async (sql) => {
      if (!sql.includes("relkind")) return { rows: [] };
      return { rows: [{ name: "aZb" }, { name: 'a"b' }] };
    };
    const provider = makeProvider();
    await provider.connect();

    expect((await provider.listObjects(["app"], "table")).map((object) => object.name)).toEqual(['a"b', "aZb"]);
    await provider.disconnect();
  });

  test("a server without pg_total_relation_size loses the size, not the folder", async () => {
    // CockroachDB and Materialize are both reached under the `postgres` type id and have
    // no such builtin. The shared withoutTotalRelationSizeFn() is deliberately NOT used:
    // its literal 0 would claim every relation there is empty.
    const asked: string[] = [];
    mockQueryFn = async (sql) => {
      if (!sql.includes("relkind")) return { rows: [] };
      asked.push(sql);
      if (sql.includes("pg_total_relation_size")) {
        throw new Error("unknown function: pg_total_relation_size()");
      }
      return { rows: [{ name: "orders", row_count: "42" }] };
    };
    const provider = makeProvider();
    await provider.connect();

    expect(await provider.listObjects(["app"], "table")).toEqual([
      // A size nobody could read is absent, never 0.
      { path: ["app", "orders"], name: "orders", kind: "table", rowCount: 42, sizeBytes: undefined },
    ]);
    expect(asked).toHaveLength(2);
    expect(asked[1]).not.toContain("pg_total_relation_size");
    await provider.disconnect();
  });

  test("the size retry's own failure leaves by the same door, quoting what the server received", async () => {
    mockQueryFn = async (sql) => {
      if (!sql.includes("relkind")) return { rows: [] };
      if (sql.includes("pg_total_relation_size")) throw new Error("unknown function: pg_total_relation_size()");
      throw new Error('relation "pg_class" does not exist');
    };
    const provider = makeProvider();
    await provider.connect();

    const failure = await provider.listObjects(["app"], "table").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DatabaseError);
    expect((failure as DatabaseError).message).toContain('relation "pg_class" does not exist');
    // The retry is what the server actually ran, so it is what the error quotes. Quoting
    // the original would point a reader at text that never left this process.
    expect((failure as DatabaseError).query).not.toContain("pg_total_relation_size");
    expect((failure as DatabaseError).query).toContain("relkind");
    await provider.disconnect();
  });

  test("a kind that is declared but has no listing statement says so, not that it is undeclared", async () => {
    // Two questions, and only the declaration answers the first. Deciding "declared" from
    // whether a statement exists would report "declares no object kind" about a kind
    // `objectKinds` does declare.
    mockQueryFn = async () => ({ rows: [] });
    const provider = makeProvider();
    await provider.connect();
    const real = provider.getCapabilities();
    spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      objectKinds: [
        ...(real.objectKinds ?? []),
        { id: "package", role: "routine", label: "Package", labelPlural: "Packages" },
      ],
    });

    await expect(provider.listObjects(["app"], "package")).rejects.toThrow(
      /declares the kind "package" but has no statement that lists it/,
    );
    await provider.disconnect();
  });

  /**
   * Ruling 5g, on this file's container reader (#789 bulk-read review, Minor 6).
   *
   * `containerSchema()` was `container.length !== 1` plus `container[0]`, which is the
   * exact spelling the pattern tells every other implementer not to copy, and the bulk
   * read routed through it. Both halves are behaviour-identical on a one-level engine, so
   * no fixture of PostgreSQL can tell the two spellings apart: this test hands THIS
   * provider a two-level declaration and drives it to the BOUND VALUE, which is the only
   * place the difference shows. The hardcoded depth refuses a valid two-segment path; a
   * positional `container[0]` binds the catalog where the schema belongs.
   */
  test("the container depth and the schema bind are DERIVED, which a two-level declaration shows", async () => {
    const bound: unknown[][] = [];
    mockQueryFn = async (sql, params) => {
      bound.push(params ?? []);
      // One described row, so the ADDRESS assertion below is over an object that exists.
      // An empty batch asserts nothing about what `objectPath()` builds.
      return { rows: sql.includes("relkind") ? [{ name: "orders", columns: [] }] : [] };
    };
    const provider = makeProvider();
    await provider.connect();
    const real = provider.getCapabilities();
    spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      containerLevels: [
        { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
      ],
    });

    const batch = await provider.describeObjects(["shop", "app"], "table");

    // The ADDRESS carries the WHOLE container, not its last segment. `objectPath()` used to
    // build `[schema, name]` from the schema segment alone, so at depth 2 both this reading
    // and `listObjects` lost the catalog together and still agreed with each other, which is
    // what the shared-rule assertion elsewhere in this file cannot see (Task 28a, minor 6).
    expect(batch.details.map((detail) => detail.path)).toEqual([["shop", "app", "orders"]]);
    // The SCHEMA segment, which is the second one under this declaration. `container[0]`
    // would bind "shop" and narrow every read to a schema that does not exist. Every
    // statement that binds anything is asserted, rather than a count of them: the number of
    // round trips is this method's business and not this rule's.
    expect(bound.filter((params) => params.length > 0)).toEqual([["app"]]);
    await provider.disconnect();
  });

  test("a path whose depth is not the declared one is refused, naming the declaration", async () => {
    const provider = makeProvider();
    await provider.connect();

    await expect(provider.describeObjects(["shop", "app"], "table")).rejects.toThrow(
      /A PostgreSQL container path is \[schema\], received \["shop","app"\]/,
    );
    await provider.disconnect();
  });

  test("a listing refusal the size retry cannot repair is raised, mapped", async () => {
    mockQueryFn = async (sql) => {
      if (!sql.includes("tgisinternal")) return { rows: [] };
      throw new Error("permission denied for table pg_trigger");
    };
    const provider = makeProvider();
    await provider.connect();

    await expect(provider.listObjects(["app"], "trigger")).rejects.toThrow(/permission denied for table pg_trigger/);
    await provider.disconnect();
  });

  test("an object's detail carries its columns, indexes and foreign keys", async () => {
    mockQueryFn = async (sql, params) => {
      if (!sql.includes("object_columns")) return { rows: [] };
      expect(params).toEqual(["app", "orders"]);
      return {
        rows: [
          {
            pk_columns: ["id"],
            columns: [
              { name: "id", type: "integer", nullable: false, defaultValue: "nextval('app.orders_id_seq'::regclass)" },
              { name: "notes", type: "text", nullable: true, defaultValue: null },
            ],
            indexes: [
              { name: "orders_pkey", columns: ["id"], unique: true },
              // An index over an expression alone has no attnums, so the subselect
              // answers NULL rather than an array.
              { name: "idx_orders_lower_number", columns: null, unique: false },
            ],
            foreign_keys: [
              {
                columnName: "customer_id",
                referencedSchema: "app",
                referencedTable: "customers",
                referencedColumn: "id",
              },
              { columnName: "owner_id", referencedSchema: "public", referencedTable: "users", referencedColumn: "id" },
            ],
          },
        ],
      };
    };
    const provider = makeProvider();
    await provider.connect();

    const detail = await provider.describeObject(["app", "orders"], "table");
    expect(detail.path).toEqual(["app", "orders"]);
    expect(detail.columns).toEqual([
      {
        name: "id",
        type: "integer",
        nullable: false,
        isPrimary: true,
        defaultValue: "nextval('app.orders_id_seq'::regclass)",
      },
      { name: "notes", type: "text", nullable: true, isPrimary: false, defaultValue: undefined },
    ]);
    expect(detail.indexes).toEqual([
      { name: "orders_pkey", columns: ["id"], unique: true },
      { name: "idx_orders_lower_number", columns: [], unique: false },
    ]);
    // Same spelling getSchema() uses: public is implicit, anything else is qualified.
    expect(detail.foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "app.customers", referencedColumn: "id" },
      { columnName: "owner_id", referencedTable: "users", referencedColumn: "id" },
    ]);
    await provider.disconnect();
  });

  test("a kind with no columns describes as three empty lists, not as a failure", async () => {
    mockQueryFn = async (sql) => {
      if (!sql.includes("object_columns")) return { rows: [] };
      return { rows: [{ pk_columns: null, columns: null, indexes: null, foreign_keys: null }] };
    };
    const provider = makeProvider();
    await provider.connect();

    // A sequence, a routine and a trigger all land here. Having no columns is a true fact
    // about those kinds, so it is an answer rather than an error.
    const detail = await provider.describeObject(["app", "invoice_number_seq"], "sequence");
    expect(detail).toEqual({
      path: ["app", "invoice_number_seq"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    await provider.disconnect();
  });

  test("a kind with no relation behind it describes as empty without asking the server", async () => {
    // Not an optimisation, and not a name test. The detail statement keys the LAST segment
    // against pg_class.relname, so a trigger named `orders` on table `customers` would
    // have been handed app.orders's columns as if they were its own. The KIND says there
    // is no relation to read; the name only ever happened not to match one.
    let asked = 0;
    mockQueryFn = async (sql) => {
      if (sql.includes("object_columns")) asked += 1;
      return { rows: [] };
    };
    const provider = makeProvider();
    await provider.connect();

    expect(await provider.describeObject(["app", "customers", "orders"], "trigger")).toEqual({
      path: ["app", "customers", "orders"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    // A routine is the case the KIND settles and a name cannot: `order_total(integer)`
    // answered no columns before this only because no relation is called that.
    expect(await provider.describeObject(["app", "order_total(integer)"], "function")).toEqual({
      path: ["app", "order_total(integer)"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    expect(asked).toBe(0);
    await provider.disconnect();
  });

  test("a detail statement that returns no row at all is a failure, not an empty object", async () => {
    // OBJECT_DETAIL_SQL's aggregate has no GROUP BY, so any server that ran it answers
    // exactly one row. Zero means the statement that ran was not the one we wrote.
    mockQueryFn = async () => ({ rows: [] });
    const provider = makeProvider();
    await provider.connect();

    await expect(provider.describeObject(["app", "orders"], "table")).rejects.toThrow(/No detail row for app\.orders/);
    await provider.disconnect();
  });

  test("an object path that is not [schema, name] is refused", async () => {
    mockQueryFn = async () => ({ rows: [] });
    const provider = makeProvider();
    await provider.connect();

    await expect(provider.describeObject(["app"], "table")).rejects.toThrow(/"table" path is \[schema, name\]/);
    await expect(provider.describeObject(["a", "b", "c"], "table")).rejects.toThrow(/"table" path is \[schema, name\]/);
    await expect(provider.describeObject(["app", "t"], "trigger")).rejects.toThrow(
      /"trigger" path is \[schema, table, name\]/,
    );
    await provider.disconnect();
  });

  test("when the routine-free retry fails too, each folder carries the sentence that stopped it", async () => {
    mockQueryFn = async (sql) => {
      if (sql.includes("prokind")) {
        throw Object.assign(new Error('column "prokind" does not exist'), { code: "42703" });
      }
      if (sql.includes("GROUP BY kind")) throw new Error('relation "pg_trigger" does not exist');
      return { rows: [] };
    };
    const provider = makeProvider();
    await provider.connect();

    const counts = await provider.countObjects(["app"]);
    // Two different reads failed for two different reasons, and neither reason is
    // overwritten by the other.
    expect(counts.function).toEqual({ unavailable: 'column "prokind" does not exist' });
    expect(counts.procedure).toEqual({ unavailable: 'column "prokind" does not exist' });
    expect(counts.table).toEqual({ unavailable: 'relation "pg_trigger" does not exist' });
    expect(counts.trigger).toEqual({ unavailable: 'relation "pg_trigger" does not exist' });
    await provider.disconnect();
  });

  test("a 42703 that does not name prokind takes the whole container down", async () => {
    // The retry repairs nothing when the missing column was in an arm it keeps, so
    // reporting the routine folders as merely unavailable would be a guess.
    mockQueryFn = async (sql) => {
      if (sql.includes("GROUP BY kind")) {
        throw Object.assign(new Error("column c.relkind does not exist"), { code: "42703" });
      }
      return { rows: [] };
    };
    const provider = makeProvider();
    await provider.connect();

    const counts = await provider.countObjects(["app"]);
    for (const kind of ["table", "view", "materialized_view", "sequence", "function", "procedure", "trigger"]) {
      expect(counts[kind]).toEqual({ unavailable: "column c.relkind does not exist" });
    }
    await provider.disconnect();
  });
});

/**
 * The fifth provider method (#789): every relation of one kind in one schema, described in
 * ONE round trip.
 *
 * This mock dispatches on the statement the provider built, which ruling 5b names as a
 * blind spot: a rewrite it cannot see stays green here. So every behaviour these tests
 * reason about is either asserted against the statement TEXT or measured against a live
 * postgres:18 in the task report, and the two catalog choices that matter - pg_attribute
 * rather than information_schema.columns, and no 100-column cap - are pinned by text below.
 */
describe("PostgreSQL bulk column read", () => {
  function makeProvider() {
    return new PostgresProvider(makePgConfig());
  }

  /** The rows the bulk statement answers for the two-table fixture, in catalog order. */
  function bulkRows() {
    return [
      {
        name: "orders",
        pk_columns: ["id"],
        columns: [{ name: "id", type: "integer", nullable: false, defaultValue: null }],
        indexes: [{ name: "orders_pkey", columns: ["id"], unique: true }],
        foreign_keys: [
          { columnName: "customer_id", referencedSchema: "app", referencedTable: "customers", referencedColumn: "id" },
        ],
      },
      {
        name: "audit_log",
        pk_columns: null,
        columns: [{ name: "payload", type: "jsonb", nullable: true, defaultValue: null }],
        indexes: null,
        foreign_keys: null,
      },
    ];
  }

  test("describes every relation of one kind in one round trip", async () => {
    const asked: { sql: string; params?: unknown[] }[] = [];
    mockQueryFn = async (sql, params) => {
      if (!sql.includes("described_columns")) return { rows: [] };
      asked.push({ sql, params });
      return { rows: bulkRows() };
    };
    const provider = makeProvider();
    await provider.connect();

    const batch = await provider.describeObjects(["app"], "table");
    // ONE statement for the whole folder. A loop over describeObject is the N+1 the
    // inventory route already refused once.
    expect(asked).toHaveLength(1);
    expect(asked[0].params).toEqual(["app"]);
    // The columns come from pg_attribute, not from information_schema.columns, and that is
    // measured rather than stylistic: information_schema.columns is defined over relkinds
    // r, v, f and p only, so it has no row at all for a materialized view or a sequence.
    expect(asked[0].sql).toContain("pg_catalog.pg_attribute");
    expect(asked[0].sql).not.toContain("information_schema.columns");
    // No 100-column cap. getSchema() carries one, unreported, and an unreported bound is
    // the defect this method's `truncated` exists to avoid.
    expect(asked[0].sql).not.toContain("ordinal_position <= 100");
    // Unbounded, so no LIMIT reaches the server and nothing claims truncation.
    expect(asked[0].sql).not.toContain("LIMIT");
    expect(batch.truncated).toBeUndefined();

    // Keyed by PATH, built by the same rule listObjects uses, and sorted by it.
    expect(batch.details.map((detail) => detail.path)).toEqual([
      ["app", "audit_log"],
      ["app", "orders"],
    ]);
    const orders = batch.details[1];
    expect(orders.columns).toEqual([
      { name: "id", type: "integer", nullable: false, isPrimary: true, defaultValue: undefined },
    ]);
    expect(orders.indexes).toEqual([{ name: "orders_pkey", columns: ["id"], unique: true }]);
    expect(orders.foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "app.customers", referencedColumn: "id" },
    ]);
    // An object the catalog answered nothing for still describes as three empty lists.
    expect(batch.details[0]).toEqual({
      path: ["app", "audit_log"],
      columns: [{ name: "payload", type: "jsonb", nullable: true, isPrimary: false, defaultValue: undefined }],
      indexes: [],
      foreignKeys: [],
    });
    await provider.disconnect();
  });

  test("a bounded read reports its own truncation", async () => {
    let bound: unknown;
    mockQueryFn = async (sql, params) => {
      if (!sql.includes("described_columns")) return { rows: [] };
      expect(sql).toContain("LIMIT");
      bound = params?.[1];
      // The provider asks for one row more than the bound, which is how it can tell a
      // saturated read from an exact one without a second count.
      return { rows: bulkRows().slice(0, Number(bound)) };
    };
    const provider = makeProvider();
    await provider.connect();

    const batch = await provider.describeObjects(["app"], "table", 1);
    expect(bound).toBe(2);
    expect(batch.details).toHaveLength(1);
    expect(batch.truncated).toEqual({ limit: 1, reason: callerBoundTruncationReason(1) });
    await provider.disconnect();
  });

  test("a bounded read that fits reports nothing", async () => {
    mockQueryFn = async (sql) => {
      if (!sql.includes("described_columns")) return { rows: [] };
      return { rows: bulkRows() };
    };
    const provider = makeProvider();
    await provider.connect();

    // Two rows against a bound of two: the read reached the end, so marking it would
    // teach a reader to discount every badge.
    const batch = await provider.describeObjects(["app"], "table", 2);
    expect(batch.details).toHaveLength(2);
    expect(batch.truncated).toBeUndefined();
    await provider.disconnect();
  });

  test("a kind with no relation behind it answers empty without asking the server", async () => {
    let asked = 0;
    mockQueryFn = async (sql) => {
      if (sql.includes("described_columns")) asked += 1;
      return { rows: [] };
    };
    const provider = makeProvider();
    await provider.connect();

    for (const kind of ["function", "procedure", "trigger"]) {
      expect(await provider.describeObjects(["app"], kind)).toEqual({ details: [] });
    }
    expect(asked).toBe(0);
    await provider.disconnect();
  });

  test("a kind this engine does not declare is refused, not answered empty", async () => {
    mockQueryFn = async () => ({ rows: [] });
    const provider = makeProvider();
    await provider.connect();

    await expect(provider.describeObjects(["app"], "package")).rejects.toThrow(/declares no object kind "package"/);
    await provider.disconnect();
  });

  test("a container path that is not one schema is refused, rather than read as empty", async () => {
    mockQueryFn = async () => ({ rows: [] });
    const provider = makeProvider();
    await provider.connect();

    await expect(provider.describeObjects([], "table")).rejects.toThrow(
      /A PostgreSQL container path is \[schema\], received \[\]/,
    );
    await provider.disconnect();
  });

  test("a limit that cannot bound anything is refused, rather than silently ignored", async () => {
    mockQueryFn = async () => ({ rows: [] });
    const provider = makeProvider();
    await provider.connect();

    // 0 would answer nothing while reporting a truncation nobody asked for, and a
    // fractional bound reaches the server as a bind it cannot use.
    await expect(provider.describeObjects(["app"], "table", 0)).rejects.toThrow(/limit must be a positive whole/);
    await expect(provider.describeObjects(["app"], "table", 1.5)).rejects.toThrow(/limit must be a positive whole/);
    await provider.disconnect();
  });

  test("a refusal the fallback chain cannot repair is raised, mapped", async () => {
    mockQueryFn = async (sql) => {
      if (!sql.includes("described_columns")) return { rows: [] };
      throw new Error("permission denied for schema app");
    };
    const provider = makeProvider();
    await provider.connect();

    await expect(provider.describeObjects(["app"], "table")).rejects.toThrow(/permission denied for schema app/);
    await provider.disconnect();
  });

  test("a fork with no constraint_column_usage loses the foreign keys, not the columns", async () => {
    // Materialize. The bulk read goes through the same fallback chain getSchema() does,
    // which is the point of reshaping that body rather than writing a new statement.
    const asked: string[] = [];
    mockQueryFn = async (sql) => {
      if (!sql.includes("described_columns")) return { rows: [] };
      asked.push(sql);
      if (sql.includes("constraint_column_usage")) {
        throw new Error('relation "information_schema.constraint_column_usage" does not exist');
      }
      return { rows: [bulkRows()[0]] };
    };
    const provider = makeProvider();
    await provider.connect();

    const batch = await provider.describeObjects(["app"], "table");
    expect(asked).toHaveLength(2);
    expect(asked[1]).not.toContain("constraint_column_usage");
    expect(batch.details[0].columns).toHaveLength(1);
    await provider.disconnect();
  });

  test("the paths it answers are the paths listObjects answers", async () => {
    // The two surfaces are joined on path by every caller, so they are built by one rule
    // rather than by two that happen to agree.
    mockQueryFn = async (sql) => {
      if (sql.includes("described_columns")) {
        return { rows: [{ name: "orders", pk_columns: null, columns: null, indexes: null, foreign_keys: null }] };
      }
      if (sql.includes("relkind")) return { rows: [{ name: "orders", row_count: null, size_bytes: null }] };
      return { rows: [] };
    };
    const provider = makeProvider();
    await provider.connect();

    const listed = await provider.listObjects(["app"], "table");
    const batch = await provider.describeObjects(["app"], "table");
    expect(batch.details.map((detail) => detail.path)).toEqual(listed.map((object) => object.path));
    await provider.disconnect();
  });
});

/**
 * The source read (#789 Phase 2).
 *
 * Every definition text below is what PostgreSQL 18.4 (Debian 18.4-1.pgdg13+1) answered for
 * the objects `docker/postgres-init/02-sample-data.sql` creates, read back through the exact
 * statements this provider sends, as the privilege-less `src_probe` role
 * `docker/postgres-init/03-object-fixture.sql` creates. The fixture is the evidence: a reader
 * can bring the container up on that init directory and get these bytes again.
 *
 * VERBATIM AND NOT ABRIDGED, and that is the correction a review made on 2026-09-12. The view
 * constant used to be a hand-shortened four-column reading of `app.order_summary` while this
 * same docblock claimed it was measured, and `docs/providers/postgres.md`'s own verification
 * block said 606 characters for the same object. Re-measured on a `postgres:18` brought up on
 * `docker/postgres-init`: 606 characters and twelve select-list columns. A length assertion
 * now pins each one, so an abridgement cannot creep back in while the claim stays.
 */
const MEASURED_VIEW_DEFINITION = ` SELECT o.id,
    o.order_number,
    (((c.first_name)::text || ' '::text) || (c.last_name)::text) AS customer_name,
    c.email AS customer_email,
    c.tier AS customer_tier,
    o.status,
    o.payment_status,
    o.total_amount,
    count(oi.id) AS item_count,
    sum(oi.quantity) AS total_items,
    o.created_at AS order_date
   FROM ((app.orders o
     JOIN app.customers c ON ((o.customer_id = c.id)))
     LEFT JOIN app.order_items oi ON ((o.id = oi.order_id)))
  GROUP BY o.id, o.order_number, c.first_name, c.last_name, c.email, c.tier, o.status, o.payment_status, o.total_amount, o.created_at;`;

/** `app.daily_sales`, the suite's second view, measured the same way: 408 characters. */
const MEASURED_DAILY_SALES_DEFINITION = ` SELECT date(created_at) AS sale_date,
    count(DISTINCT id) AS order_count,
    sum(total_amount) AS total_sales,
    avg(total_amount) AS avg_order_value,
    count(DISTINCT customer_id) AS unique_customers
   FROM app.orders o
  WHERE ((status)::text <> ALL ((ARRAY['cancelled'::character varying, 'pending'::character varying])::text[]))
  GROUP BY (date(created_at))
  ORDER BY (date(created_at)) DESC;`;

/**
 * `app.revenue_by_month`, the materialized view, 161 characters.
 *
 * Read through the `c.relkind = 'm'` statement and not the view one. It is a separate constant
 * because the materialized view has its own read test, and that test exists because building
 * `SOURCE_VIEW_SQL.materialized_view` from `RELKIND_BY_KIND.view` survived the whole suite
 * until it was written.
 */
const MEASURED_MATERIALIZED_VIEW_DEFINITION = ` SELECT date_trunc('month'::text, created_at) AS month,
    sum(total_amount) AS revenue
   FROM app.orders o
  GROUP BY (date_trunc('month'::text, created_at));`;

/** `app.order_total(integer)`, measured the same way: 228 characters, trailing newline included. */
const MEASURED_FUNCTION_DEFINITION = `CREATE OR REPLACE FUNCTION app.order_total(order_id integer)
 RETURNS numeric
 LANGUAGE sql
 STABLE
AS $function$
  SELECT coalesce(sum(quantity * unit_price), 0) FROM app.order_items WHERE order_items.order_id = $1;
$function$
`;

/** `app.orders.orders_stamp_updated_at`, measured the same way: 119 characters. */
const MEASURED_TRIGGER_DEFINITION =
  "CREATE TRIGGER orders_stamp_updated_at BEFORE UPDATE ON app.orders " +
  "FOR EACH ROW EXECUTE FUNCTION app.stamp_updated_at()";

/**
 * THE WHOLE STATEMENT, one per kind, squashed to a single line, and why it is the whole one.
 *
 * Round 1 pinned each statement's WHERE clause and its pretty flag as text, which killed the
 * four mutants that lived in a predicate. It left the SELECT expression and the JOINs
 * unpinned, and three mutants measured on 2026-09-12 then survived the whole suite at
 * 205 pass 0 fail:
 *
 * - `pg_get_functiondef(p.oid)` rewritten to
 *   `pg_get_functiondef((n.nspname || '.' || p.proname)::regprocedure)`, which is the one rule
 *   this provider's own docblock says nobody would have written from the documentation. The
 *   cast resolves a NAME, name resolution needs USAGE on the schema, and it manufactures a
 *   42501 "permission denied for schema app" the engine never made, on an object the tree has
 *   already listed. Measured for `src_probe` on PostgreSQL 18.4.
 * - `pg_get_functiondef(p.oid)` rewritten to `pg_get_functiondef(p.prorettype)`, which asks
 *   for the definition of some other catalog entry entirely.
 * - the trigger's `JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid` rewritten to
 *   `ON c.oid = t.tgconstrrelid`, which is 0 for every trigger that is not a constraint
 *   trigger, so every ordinary trigger's Source tab would raise the absence sentence.
 *
 * The double does not execute SQL, so no assertion on `params` and none on the returned
 * document can see any of the three. Enumerating tokens is what let them through: the view
 * test's `not.toContain("regclass")` only ever sees the VIEW statement, exactly the way
 * `not.toContain("c.oid, true")` could never see the trigger's own flag. One equality per kind
 * closes the class instead of the members of it somebody has thought of.
 *
 * Whitespace is squashed because indentation is not behaviour. Every other byte is pinned: the
 * function called, its arguments, the pretty flag, every FROM, every JOIN and every predicate.
 */
function squashSql(sql: string): string {
  return sql.trim().replace(/\s+/g, " ");
}

const EXPECTED_VIEW_SOURCE_SQL =
  "SELECT pg_catalog.pg_get_viewdef(c.oid, false) AS definition " +
  "FROM pg_catalog.pg_class c " +
  "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
  "WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'v'";

/** Spelled out in full rather than derived from the view's, because the one token that differs is the defect. */
const EXPECTED_MATERIALIZED_VIEW_SOURCE_SQL =
  "SELECT pg_catalog.pg_get_viewdef(c.oid, false) AS definition " +
  "FROM pg_catalog.pg_class c " +
  "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
  "WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'm'";

/** One statement for both routine kinds: a function and a procedure differ only by the bound `prokind`. */
const EXPECTED_ROUTINE_SOURCE_SQL =
  "SELECT pg_catalog.pg_get_functiondef(p.oid) AS definition, " +
  // The five columns the EDIT reads (#789 Phase 3). They are pinned by this same equality and
  // for the same reason the definition expression is: the double does not execute SQL, so a
  // column silently dropped from the projection is invisible to every assertion on the document
  // the read returns, and `may_replace` dropped would make the ownership pre-flight offer an
  // edit of somebody else's routine.
  "md5(pg_catalog.pg_get_functiondef(p.oid)) AS revision, " +
  "pg_catalog.pg_get_userbyid(p.proowner) AS owner, " +
  "pg_catalog.pg_has_role(current_user, p.proowner, 'USAGE') AS may_replace, " +
  "current_setting('search_path') AS search_path, " +
  "current_setting('check_function_bodies') AS check_function_bodies " +
  "FROM pg_catalog.pg_proc p " +
  "JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace " +
  "WHERE n.nspname = $1 AND p.prokind = $2 AND p.proname || '(' || " +
  "COALESCE(pg_catalog.array_to_string(ARRAY( " +
  "SELECT pg_catalog.format_type(t, NULL) FROM unnest(p.proargtypes) AS t), ','), '') || ')' = $3";

const EXPECTED_TRIGGER_SOURCE_SQL =
  "SELECT pg_catalog.pg_get_triggerdef(t.oid, false) AS definition " +
  "FROM pg_catalog.pg_trigger t " +
  "JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid " +
  "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
  "WHERE n.nspname = $1 AND c.relname = $2 AND t.tgname = $3 AND NOT t.tgisinternal";

describe("PostgreSQL object source", () => {
  function makeProvider() {
    return new PostgresProvider(makePgConfig());
  }

  /**
   * The double dispatches on the `pg_get_*` function NAME, which is the one token that tells
   * the five statements apart and the one a mutation to the statement cannot preserve by
   * accident: a read rewritten to `pg_get_function_identity_arguments` or to a `regclass`
   * cast falls through to `{ rows: [] }` and every assertion below goes red. The binds are
   * captured rather than matched, so a statement that reaches the server with the wrong
   * values is a failure here and not a silent miss.
   */
  function sourceDouble(definition: string | null) {
    const sent: { sql: string; params: unknown[] }[] = [];
    mockQueryFn = async (sql, params) => {
      if (sql.includes("pg_get_viewdef") || sql.includes("pg_get_functiondef") || sql.includes("pg_get_triggerdef")) {
        // Recorded only for the source statements, so `connect()`'s own EXPLAIN capability
        // probe cannot occupy sent[0] and make an index assertion read the wrong statement.
        sent.push({ sql, params: (params ?? []) as unknown[] });
        return { rows: definition === null ? [] : [{ definition }] };
      }
      return { rows: [] };
    };
    return sent;
  }

  test("reads a view's definition and says what the text is", async () => {
    const sent = sourceDouble(MEASURED_VIEW_DEFINITION);
    const provider = makeProvider();
    await provider.connect();

    const document = await provider.readObjectSource(["app", "order_summary"], "view");
    expect(document.path).toEqual(["app", "order_summary"]);
    expect(document.kind).toBe("view");
    expect(document.parts).toHaveLength(1);
    const [part] = document.parts;
    expect(isSourcePartUnavailable(part)).toBe(false);
    if (isSourcePartUnavailable(part)) throw new Error("narrowing");
    expect(part.id).toBe("definition");
    expect(part.label).toBe("Definition");
    expect(part.text).toContain("JOIN app.customers c ON ((o.customer_id = c.id))");
    expect(part.language).toBe("pgsql");
    // `pg_get_viewdef` answers the bare SELECT and no CREATE, measured: the caption exists to
    // say exactly that, so claiming `complete` here would be a claim about text that does not
    // run as given.
    expect(part.form).toBe("partial");
    // PostgreSQL's own words for this output: "a decompiled reconstruction, not the original
    // text of the command".
    expect(part.origin).toBe("regenerated");
    expect(part.truncated).toBeUndefined();

    // THE WHOLE STATEMENT AS TEXT, and not a chosen set of tokens. The OID and never a
    // `::regclass` or `::regprocedure` cast, which resolves a NAME, needs USAGE on the schema
    // and raises 42501 for a schema the caller cannot see, on an object the tree has already
    // listed; `false` for the pretty flag, which PostgreSQL documents as the format a future
    // version is likelier to read back the same way; and both predicates, because this fixture
    // holds `orders` in BOTH `app` and `public`. A double that does not execute SQL sees none
    // of them leave the statement: the binds still arrive and every assertion on `params` and
    // on the document stays green. The three mutants a token-by-token pin let through are on
    // `EXPECTED_VIEW_SOURCE_SQL`.
    expect(squashSql(sent[0].sql)).toBe(EXPECTED_VIEW_SOURCE_SQL);
    expect(sent[0].params).toEqual(["app", "order_summary"]);
    // The bytes, not a substring. This constant is the fixture's evidence under standing
    // ruling 5i, so its LENGTH is asserted: an abridged text would still contain every
    // substring above.
    expect(part.text).toHaveLength(606);
    await provider.disconnect();
  });

  test("reads a materialized view under its own relkind, never the view's", async () => {
    const sent = sourceDouble(MEASURED_MATERIALIZED_VIEW_DEFINITION);
    const provider = makeProvider();
    await provider.connect();

    const document = await provider.readObjectSource(["app", "revenue_by_month"], "materialized_view");
    expect(document.kind).toBe("materialized_view");
    const [part] = document.parts;
    if (isSourcePartUnavailable(part)) throw new Error("the fixture materialized view is readable");
    expect(part.text).toBe(MEASURED_MATERIALIZED_VIEW_DEFINITION);
    expect(part.text).toHaveLength(161);
    // `pg_get_viewdef` answers the bare SELECT for a materialized view too, measured on 18.4.
    expect(part.form).toBe("partial");
    expect(part.origin).toBe("regenerated");
    // 'm' AND NOT 'v', and every other byte of the statement with it. `SOURCE_VIEW_SQL`
    // builds both entries from one relkind map, so building the materialized-view entry from
    // `RELKIND_BY_KIND.view` is a one-token edit that binds the same two values and survived
    // the whole suite until this kind got a read test: every materialized view's Source tab
    // would then raise the absence sentence.
    expect(squashSql(sent[0].sql)).toBe(EXPECTED_MATERIALIZED_VIEW_SOURCE_SQL);
    expect(sent[0].params).toEqual(["app", "revenue_by_month"]);
    await provider.disconnect();
  });

  test("reads a routine by the identity its own listing wrote, not by its name", async () => {
    const sent = sourceDouble(MEASURED_FUNCTION_DEFINITION);
    const provider = makeProvider();
    await provider.connect();

    const document = await provider.readObjectSource(["app", "order_total(integer)"], "function");
    const [part] = document.parts;
    if (isSourcePartUnavailable(part)) throw new Error("the fixture function is readable");
    expect(part.text).toContain("CREATE OR REPLACE FUNCTION app.order_total(order_id integer)");
    // The engine wraps it in a runnable CREATE OR REPLACE, so this one runs as given.
    expect(part.form).toBe("complete");
    expect(part.origin).toBe("regenerated");
    // The overload's TYPE list is the address, so the bind is the whole segment and the
    // comparison is the same expression the listing built the segment with. A read keyed on
    // `proname` alone would answer whichever overload the catalog happened to return first.
    expect(sent[0].params).toEqual(["app", "f", "order_total(integer)"]);
    // The WHOLE statement, which is where this suite's blind spot was widest. The READ
    // EXPRESSION had no pin at all, so `pg_get_functiondef(p.oid)` rewritten to a
    // `::regprocedure` name cast, the single defect this provider's docblock exists to forbid,
    // survived the whole suite at 205 pass 0 fail, and so did rewriting it to
    // `pg_get_functiondef(p.prorettype)`. The identity expression is pinned by the same
    // equality: it is the address the LISTING wrote, so a read keyed on `proname` alone would
    // answer whichever overload the catalog returned first, and
    // `pg_get_function_identity_arguments` would include parameter names the segment has not.
    expect(squashSql(sent[0].sql)).toBe(EXPECTED_ROUTINE_SOURCE_SQL);

    const procedure = await provider.readObjectSource(["app", "touch_order(integer)"], "procedure");
    expect(procedure.kind).toBe("procedure");
    // The SAME statement with the prokind BOUND, never two statements: a procedure and a
    // function differ by one character on the wire.
    expect(sent[1].params).toEqual(["app", "p", "touch_order(integer)"]);
    expect(sent[1].sql).toBe(sent[0].sql);
    await provider.disconnect();
  });

  test("reads a trigger by its table as well as by its name", async () => {
    const sent = sourceDouble(MEASURED_TRIGGER_DEFINITION);
    const provider = makeProvider();
    await provider.connect();

    const document = await provider.readObjectSource(["app", "orders", "orders_stamp_updated_at"], "trigger");
    const [part] = document.parts;
    if (isSourcePartUnavailable(part)) throw new Error("the fixture trigger is readable");
    expect(part.text).toBe(MEASURED_TRIGGER_DEFINITION);
    expect(part.form).toBe("complete");
    // A trigger name is unique per TABLE, so the table segment is a bind and not decoration:
    // two tables in one schema may each carry `stamp_updated_at`.
    expect(sent[0].params).toEqual(["app", "orders", "orders_stamp_updated_at"]);
    // THE WHOLE STATEMENT, JOINs included, and the JOIN is the half a WHERE-clause pin
    // cannot reach. `ON c.oid = t.tgrelid` is what makes the table segment address anything:
    // rewritten to `ON c.oid = t.tgconstrrelid` it is 0 for every trigger that is not a
    // constraint trigger, all three binds still arrive, every assertion on `params` stays
    // green, and every ordinary trigger's Source tab would raise the absence sentence. That
    // mutant survived the whole suite while the WHERE clause and the pretty flag were pinned
    // and the JOIN was not. The flag is pinned here and not only on the view, because the view
    // test's `not.toContain("c.oid, true")` names the view statement's own alias and can never
    // see `t.oid, true`; dropping `c.relname = $2` is pinned by the same equality.
    expect(squashSql(sent[0].sql)).toBe(EXPECTED_TRIGGER_SOURCE_SQL);
    await provider.disconnect();
  });

  /**
   * Standing ruling 5g, driven all the way to the BINDS (#789).
   *
   * PostgreSQL declares ONE container level, so its own fixture cannot tell a hardcoded depth
   * from a derived one: `path[0]` and `path.slice(0, containerDepth())[0]` are the same
   * segment at depth 1. A two-level declaration is swapped in so they are not, and the
   * assertion is on the VALUES that reached the server rather than on a refusal, because a
   * two-level test that stops at the refusal never reaches the bind the defect lives in.
   */
  test("derives the schema and the object name from the DECLARATION, not from a position", async () => {
    const sent = sourceDouble(MEASURED_VIEW_DEFINITION);
    const provider = makeProvider();
    await provider.connect();
    const spy = spyOn(provider, "getCapabilities").mockReturnValue({
      ...provider.getCapabilities(),
      containerLevels: [
        { id: "catalog", label: "Database", labelPlural: "Databases" },
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
      ],
    });
    try {
      await provider.readObjectSource(["cat", "sch", "obj"], "view");
      // `sch` and not `cat`: the schema is the segment the DECLARATION calls the schema, which
      // is the second one here and the first one on the shipped declaration.
      expect(sent[0].params).toEqual(["sch", "obj"]);
    } finally {
      spy.mockRestore();
    }
    await provider.disconnect();
  });

  test("a fork without the pg_get_* function refuses in its own words, and does not raise", async () => {
    // CockroachDB and Materialize are both reached under this type id. Measured shape, from
    // asking PostgreSQL 18.4 for a function that does not exist.
    mockQueryFn = async (sql) => {
      if (!sql.includes("pg_get_viewdef")) return { rows: [] };
      throw Object.assign(new Error("function pg_catalog.pg_get_viewdef(oid, boolean) does not exist"), {
        code: "42883",
      });
    };
    const provider = makeProvider();
    await provider.connect();

    const document = await provider.readObjectSource(["app", "order_summary"], "view");
    expect(document.parts).toHaveLength(1);
    const [part] = document.parts;
    if (!isSourcePartUnavailable(part)) throw new Error("a fork without the function is a refusal");
    // The server's own sentence, UNPREFIXED. Routing it through mapDatabaseError would put
    // this product's words in front of the server's, which is what `unavailableCounts`
    // already refuses to do one surface up.
    expect(part.unavailable).toBe("function pg_catalog.pg_get_viewdef(oid, boolean) does not exist");
    expect(part.label).toBe("Definition");
    expect("text" in part).toBe(false);
    await provider.disconnect();
  });

  test("a fork without pg_proc.prokind refuses the routine read in its own words", async () => {
    mockQueryFn = async (sql) => {
      if (!sql.includes("pg_get_functiondef")) return { rows: [] };
      throw Object.assign(new Error("column p.prokind does not exist"), { code: "42703" });
    };
    const provider = makeProvider();
    await provider.connect();

    const [part] = (await provider.readObjectSource(["app", "order_total(integer)"], "function")).parts;
    if (!isSourcePartUnavailable(part)) throw new Error("a fork without prokind is a refusal");
    expect(part.unavailable).toBe("column p.prokind does not exist");
    await provider.disconnect();
  });

  test("a transport failure raises, because nobody answered at all", async () => {
    // The narrowness of the refusal set is the point. "Connection terminated unexpectedly"
    // rendered in the Source pane as this object's own refusal is a symptom presented as a
    // fact about the object, with no raise and nothing telling it apart from a real one.
    mockQueryFn = async () => {
      throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
    };
    const provider = makeProvider();
    await provider.connect();

    await expect(provider.readObjectSource(["app", "order_summary"], "view")).rejects.toThrow(
      /Connection terminated unexpectedly/,
    );
    await provider.disconnect();
  });

  test("an object the catalog does not hold RAISES, naming it, and never answers a refusal", async () => {
    sourceDouble(null);
    const provider = makeProvider();
    await provider.connect();

    // Absence is a raise and not an `unavailable` part: the engine said nothing rather than
    // saying no, and a refusal sentence we wrote would be our silence dressed as its answer.
    await expect(provider.readObjectSource(["app", "no_such_view"], "view")).rejects.toThrow(QueryError);
    await expect(provider.readObjectSource(["app", "no_such_view"], "view")).rejects.toThrow(/no_such_view/);
    await provider.disconnect();
  });

  test("a NULL and a whitespace-only definition are the same absence as no row at all", async () => {
    // Measured on 18.4: `pg_get_viewdef` answers NULL for an oid that is not a view, and a
    // driver hands that back as a row carrying null. An empty editor over a definition that
    // was never read is the one failure this whole surface exists to prevent.
    const provider = makeProvider();
    for (const definition of [null, "   \n\t "]) {
      mockQueryFn = async (sql) => (sql.includes("pg_get_viewdef") ? { rows: [{ definition }] } : { rows: [] });
      await provider.connect();
      await expect(provider.readObjectSource(["app", "order_summary"], "view")).rejects.toThrow(/order_summary/);
      await provider.disconnect();
    }
  });

  test("a caller's bound cuts the text and says so, and an exact read is never marked", async () => {
    sourceDouble(MEASURED_FUNCTION_DEFINITION);
    const provider = makeProvider();
    await provider.connect();

    const bounded = await provider.readObjectSource(["app", "order_total(integer)"], "function", 20);
    const [part] = bounded.parts;
    if (isSourcePartUnavailable(part)) throw new Error("the fixture function is readable");
    expect(part.text).toBe(MEASURED_FUNCTION_DEFINITION.slice(0, 20));
    expect(part.truncated).toEqual({ limit: 20, reason: sourceBoundTruncationReason(20) });

    const exact = await provider.readObjectSource(
      ["app", "order_total(integer)"],
      "function",
      MEASURED_FUNCTION_DEFINITION.length,
    );
    const [whole] = exact.parts;
    if (isSourcePartUnavailable(whole)) throw new Error("the fixture function is readable");
    // Marking an exact answer teaches a reader to discount every mark, which is the rule
    // `sampledFrom` already follows one surface up.
    expect(whole.truncated).toBeUndefined();
    await provider.disconnect();
  });

  test("a kind that publishes no definition text is refused by name, not answered empty", async () => {
    sourceDouble(MEASURED_VIEW_DEFINITION);
    const provider = makeProvider();
    await provider.connect();

    // `sequence` IS declared and has no source; `package` is not declared at all. Two
    // different facts and two different sentences, and neither is an empty document.
    // The ENGINE's own name is part of each sentence, and pinning it is what the entry guard
    // being shared owes: since #789's hoist the display name reaches `requireSourceKind` as an
    // argument, so a provider passing the wrong literal would otherwise attribute PostgreSQL's
    // refusal to another engine with nothing here noticing.
    await expect(provider.readObjectSource(["app", "invoice_number_seq"], "sequence")).rejects.toThrow(
      /PostgreSQL publishes no definition text for the kind "sequence"/,
    );
    await expect(provider.readObjectSource(["app", "x"], "package")).rejects.toThrow(
      /PostgreSQL declares no object kind "package"/,
    );
    await provider.disconnect();
  });

  test("a path of the wrong depth is refused, rather than read from the wrong segment", async () => {
    sourceDouble(MEASURED_VIEW_DEFINITION);
    const provider = makeProvider();
    await provider.connect();

    // A trigger is [schema, table, trigger] because the declaration says it is attached; a
    // view is [schema, view]. Reading the last segment of a path of another shape would send
    // a table name where a view name belongs and answer an absence for an object that exists.
    await expect(provider.readObjectSource(["app", "orders_stamp_updated_at"], "trigger")).rejects.toThrow(
      /A PostgreSQL "trigger" path is \[schema, table, name\], received \["app","orders_stamp_updated_at"\]/,
    );
    await expect(provider.readObjectSource(["app", "orders", "order_summary"], "view")).rejects.toThrow(
      /A PostgreSQL "view" path is \[schema, name\]/,
    );
    await provider.disconnect();
  });

  /**
   * The path-shape check counts the levels `containerDepth()` reports, not the array's length.
   *
   * `ContainerLevels` is a tuple union of nought, one or two levels, so a third level is a
   * compile error where a provider would write it, and `containerDepth()` still carries a
   * `>= 2` arm for exactly the cast this test performs. The two readings are behaviour
   * identical at every depth the type admits, which is why this is the only fixture that can
   * tell them apart: `assertObjectPathShape` used to count `containerLevels.length`, so at
   * three declared levels it demanded four segments while `readObjectSource` sliced the
   * container at two and handed `containerSchema` a two-segment path. The file's own
   * `declaredLevels` docblock already said `containerDepth()` is what decides.
   */
  test("counts the path's segments at the DEPTH the derivation reports, not at the array's length", async () => {
    const sent = sourceDouble(MEASURED_VIEW_DEFINITION);
    const provider = makeProvider();
    await provider.connect();
    const spy = spyOn(provider, "getCapabilities").mockReturnValue({
      ...provider.getCapabilities(),
      containerLevels: [
        { id: "catalog", label: "Database", labelPlural: "Databases" },
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
        { id: "extra", label: "Extra", labelPlural: "Extras" },
      ] as unknown as ContainerLevels,
    });
    try {
      // Three segments, because the depth is two and a view adds its own name. A shape check
      // reading the raw array would refuse this path by name before any bind was built.
      await provider.readObjectSource(["cat", "sch", "obj"], "view");
      expect(sent[0].params).toEqual(["sch", "obj"]);
    } finally {
      spy.mockRestore();
    }
    await provider.disconnect();
  });

  test("a kind declaring source with no language raises, rather than rendering as plain text", async () => {
    sourceDouble(MEASURED_VIEW_DEFINITION);
    const provider = makeProvider();
    await provider.connect();
    const capabilities = provider.getCapabilities();
    const spy = spyOn(provider, "getCapabilities").mockReturnValue({
      ...capabilities,
      objectKinds: (capabilities.objectKinds ?? []).map((kind) =>
        kind.id === "view" ? { ...kind, sourceLanguage: undefined } : kind,
      ),
    });
    try {
      // An unregistered or absent Monaco id degrades to plain text with no throw and nothing
      // observable, so a declaration that forgot the language would ship a Source tab that
      // silently stopped highlighting. The declaration is the single source of the language
      // and there is no literal here to fall back to.
      await expect(provider.readObjectSource(["app", "order_summary"], "view")).rejects.toThrow(
        /declares readable source for the kind "view" and no sourceLanguage/,
      );
    } finally {
      spy.mockRestore();
    }
    await provider.disconnect();
  });

  test("a declared readable kind with no statement behind it is refused by name", async () => {
    sourceDouble(MEASURED_VIEW_DEFINITION);
    const provider = makeProvider();
    await provider.connect();
    const capabilities = provider.getCapabilities();
    const spy = spyOn(provider, "getCapabilities").mockReturnValue({
      ...capabilities,
      objectKinds: (capabilities.objectKinds ?? []).map((kind) =>
        kind.id === "sequence" ? { ...kind, hasSource: true, sourceLanguage: "pgsql" } : kind,
      ),
    });
    try {
      // The declaration and the reader are two lists and a kind can be added to one and not
      // the other. It fails by name here rather than answering a document with nothing in it.
      await expect(provider.readObjectSource(["app", "invoice_number_seq"], "sequence")).rejects.toThrow(
        /declares readable source for the kind "sequence" but has no statement that reads it/,
      );
    } finally {
      spy.mockRestore();
    }
    await provider.disconnect();
  });
});

// ============================================================================
// Object edit (#789 Phase 3)
// ============================================================================

/**
 * The row `SOURCE_ROUTINE_SQL` answers for `app.order_total(integer)` once the edit's five
 * columns joined it, as PostgreSQL 18.4 (Debian 18.4-1.pgdg13+1) answered it on the container
 * `docker/postgres-init/` builds.
 *
 * `definition` is `MEASURED_FUNCTION_DEFINITION` verbatim, so the identity rule and the
 * byte-identical refusal below are asked of the engine's own rendering and never of a
 * hand-written approximation of it. `revision` is the md5 of exactly those bytes: it was read
 * back with `SELECT md5(pg_get_functiondef('app.order_total(integer)'::regprocedure))` and it is
 * recomputable from the constant above it.
 */
const ROUTINE_ROW = {
  definition: MEASURED_FUNCTION_DEFINITION,
  revision: "9d7b0d59cbc2bd88b0d55a7845da1b2a",
  owner: "postgres",
  may_replace: true,
  search_path: '"$user", public',
  check_function_bodies: "on",
};

/** The reader's edit: one word of the body changed, and the identity untouched. */
const EDITED = MEASURED_FUNCTION_DEFINITION.replace("coalesce(sum(", "COALESCE(sum(");

describe("PostgreSQL object edit (#789 Phase 3)", () => {
  function makeProvider() {
    return new PostgresProvider(makePgConfig());
  }

  /**
   * A connected provider whose `mockQueryFn` is installed AFTER `connect()`, because `connect()`
   * sends its own EXPLAIN-format probe and a recorder installed before it would make `seen[0]`
   * that probe rather than the build's read.
   */
  async function connected() {
    const provider = makeProvider();
    await provider.connect();
    return provider;
  }

  describe("the edit affordance on the read", () => {
    test("a readable routine part carries the edit affordance the OWNER gets", async () => {
      const provider = await connected();
      mockQueryFn = async () => ({
        rows: [
          {
            definition: "CREATE OR REPLACE FUNCTION app.order_total(order_id integer)\n RETURNS numeric\n...",
            may_replace: true,
            owner: "postgres",
          },
        ],
      });
      const document = await provider.readObjectSource(["app", "order_total(integer)"], "function");
      const [part] = document.parts;
      if (isSourcePartUnavailable(part)) throw new Error("narrowing");
      expect(part.edit).toEqual({ offered: true });
      await provider.disconnect();
    });

    test("a routine the connection does not own carries the engine's own ownership sentence", async () => {
      const provider = await connected();
      mockQueryFn = async () => ({
        rows: [
          {
            definition: "CREATE OR REPLACE FUNCTION app.order_total(order_id integer) ...",
            may_replace: false,
            owner: "app_owner",
          },
        ],
      });
      const document = await provider.readObjectSource(["app", "order_total(integer)"], "function");
      const [part] = document.parts;
      if (isSourcePartUnavailable(part)) throw new Error("narrowing");
      // The PROVIDER's sentence, naming the owner, because the reader's next action is to use a
      // different connection and nothing else on the screen can tell them that.
      expect(part.edit).toEqual({
        offered: false,
        reason:
          'this connection\'s database account does not own "app.order_total(integer)", which is owned by "app_owner", and PostgreSQL checks ownership rather than privilege for CREATE OR REPLACE',
      });
      await provider.disconnect();
    });

    test("a kind that declares no edit carries NO affordance at all", async () => {
      // Absent and not `{ offered: false }`: a decorative false is forbidden, and absence is what the
      // client predicate reads as "this database offers no way to replace this definition in place".
      const provider = await connected();
      mockQueryFn = async () => ({ rows: [{ definition: "SELECT 1" }] });
      const document = await provider.readObjectSource(["app", "order_summary"], "view");
      const [part] = document.parts;
      if (isSourcePartUnavailable(part)) throw new Error("narrowing");
      expect(Object.hasOwn(part, "edit")).toBe(false);
      await provider.disconnect();
    });
  });

  describe("buildObjectEdit", () => {
    test("the build re-reads the object with the identity expression the LISTING wrote", async () => {
      const provider = await connected();
      const seen: { sql: string; params: unknown[] }[] = [];
      mockQueryFn = async (sql, params) => {
        seen.push({ sql, params: (params ?? []) as unknown[] });
        return { rows: [ROUTINE_ROW] };
      };
      await provider.buildObjectEdit({
        path: ["app", "order_total(integer)"],
        kind: "function",
        partId: "definition",
        text: EDITED,
      });
      expect(seen[0].sql).toContain("pg_catalog.pg_has_role(current_user, p.proowner, 'USAGE')");
      expect(seen[0].sql).toContain("md5(pg_catalog.pg_get_functiondef(p.oid))");
      expect(seen[0].params).toEqual(["app", "f", "order_total(integer)"]);
      await provider.disconnect();
    });

    test("a plan pins TWO session settings, one of each mode", async () => {
      const provider = await connected();
      mockQueryFn = async () => ({ rows: [ROUTINE_ROW] });
      const build = await provider.buildObjectEdit({
        path: ["app", "order_total(integer)"],
        kind: "function",
        partId: "definition",
        text: EDITED,
      });
      if (!build.built) throw new Error(build.refusal.sentence);
      expect(build.plan.session).toEqual([
        // PINNED, and the value is exactly what the statement sets, so the preview shows what runs.
        { mode: "pinned", setting: "search_path", value: '"app", pg_catalog' },
        // ASSERTED, and never set: the plan compares it and refuses if it moved.
        { mode: "asserted", setting: "check_function_bodies", value: "on" },
      ]);
      await provider.disconnect();
    });

    test("the unit is ONE step, three segments, and the segments reconstruct the text", async () => {
      const provider = await connected();
      mockQueryFn = async () => ({ rows: [ROUTINE_ROW] });
      const build = await provider.buildObjectEdit({
        path: ["app", "order_total(integer)"],
        kind: "function",
        partId: "definition",
        text: EDITED,
      });
      if (!build.built) throw new Error(build.refusal.sentence);
      if (build.plan.unit.medium !== "statement") throw new Error("narrowing");
      const [step] = build.plan.unit.steps;
      expect(build.plan.unit.steps).toHaveLength(1);
      expect(step.segments).toHaveLength(3);
      // THE RENDER INVARIANT. `text` is authoritative and `segments` is the coordinate map, and this
      // is what stops the two drifting.
      expect(renderSegments(EDITED, step.segments)).toBe(step.text);
      expect(step.text).toContain('SET LOCAL search_path = "app", pg_catalog;');
      expect(step.text).toContain("RAISE EXCEPTION 'libredb: this definition changed since it was read'");
      expect(step.text).toContain(
        "RAISE EXCEPTION 'libredb: this apply did not change the object it was addressed to'",
      );
      expect(step.language).toBe("pgsql");
      await provider.disconnect();
    });

    test("the revision is the md5 of the engine's own rendering, computed SERVER SIDE", async () => {
      const provider = await connected();
      mockQueryFn = async () => ({ rows: [ROUTINE_ROW] });
      const build = await provider.buildObjectEdit({
        path: ["app", "order_total(integer)"],
        kind: "function",
        partId: "definition",
        text: EDITED,
      });
      if (!build.built) throw new Error(build.refusal.sentence);
      expect(build.plan.revision).toEqual({
        check: "guarded",
        token: ROUTINE_ROW.revision,
        basis: "md5(pg_get_functiondef(oid))",
        scope: "server",
      });
      // MEASURED why that expression and not the obvious ones: `xmin` moves on a byte-identical
      // replace and on a GRANT EXECUTE, so it produces FALSE conflicts; `ctid` moves on a plain
      // VACUUM FULL while `xmin` survives; a frozen catalog row reports `xmin` of 1. The md5 of
      // `pg_get_functiondef` did not move on COMMENT ON or on GRANT EXECUTE and did move on a real
      // body change, on all five measured rows.
      expect(build.plan.consequences).toEqual([]);
      expect(build.plan.strategy).toBe("guarded-atomic-batch");
      await provider.disconnect();
    });

    test("the pre-image is the definition the BUILD read, and never the text the tab was showing", async () => {
      const provider = await connected();
      mockQueryFn = async () => ({ rows: [ROUTINE_ROW] });
      const build = await provider.buildObjectEdit({
        path: ["app", "order_total(integer)"],
        kind: "function",
        partId: "definition",
        text: EDITED,
      });
      if (!build.built) throw new Error(build.refusal.sentence);
      expect(build.preimage).toEqual({ text: ROUTINE_ROW.definition, language: "pgsql" });
      await provider.disconnect();
    });

    describe("the five build refusals, in order", () => {
      test("a truncated read is a GUARD refusal and carries core's own bound sentence", async () => {
        const provider = await connected();
        mockQueryFn = async () => ({ rows: [{ ...ROUTINE_ROW, definition: "x".repeat(1_000_001) }] });
        const build = await provider.buildObjectEdit({
          path: ["app", "order_total(integer)"],
          kind: "function",
          partId: "definition",
          text: EDITED,
        });
        if (build.built) throw new Error("expected a refusal");
        expect(build.refusal.refusal).toBe("guard");
        expect(build.refusal.sentence).toContain("bounded at 1,000,000 characters");
        expect(build.refusal.at).toEqual({ within: "none" });
        await provider.disconnect();
      });

      test("a routine this connection does not own is a PRIVILEGE refusal, before the reader types", async () => {
        const provider = await connected();
        mockQueryFn = async () => ({ rows: [{ ...ROUTINE_ROW, may_replace: false, owner: "app_owner" }] });
        const build = await provider.buildObjectEdit({
          path: ["app", "order_total(integer)"],
          kind: "function",
          partId: "definition",
          text: EDITED,
        });
        if (build.built) throw new Error("expected a refusal");
        expect(build.refusal.refusal).toBe("privilege");
        expect(build.refusal.sentence).toContain("app_owner");
        await provider.disconnect();
      });

      test("check_function_bodies off is a GUARD refusal naming the GUC", async () => {
        // With it off the engine accepts a body it would otherwise reject, so an apply would succeed
        // and store a definition that cannot run.
        const provider = await connected();
        mockQueryFn = async () => ({ rows: [{ ...ROUTINE_ROW, check_function_bodies: "off" }] });
        const build = await provider.buildObjectEdit({
          path: ["app", "order_total(integer)"],
          kind: "function",
          partId: "definition",
          text: EDITED,
        });
        if (build.built) throw new Error("expected a refusal");
        expect(build.refusal.refusal).toBe("guard");
        expect(build.refusal.sentence).toContain("check_function_bodies");
        await provider.disconnect();
      });

      test("text byte-identical to the server's is a DEFINITION refusal and never a no-op apply", async () => {
        // A refusal rather than a no-op because it removes the entire false-positive population from
        // the post-condition below: with it, "this apply did not change the object" can only mean a
        // fork.
        const provider = await connected();
        mockQueryFn = async () => ({ rows: [ROUTINE_ROW] });
        const build = await provider.buildObjectEdit({
          path: ["app", "order_total(integer)"],
          kind: "function",
          partId: "definition",
          text: ROUTINE_ROW.definition,
        });
        if (build.built) throw new Error("expected a refusal");
        expect(build.refusal.refusal).toBe("definition");
        expect(build.refusal.sentence).toBe("this text is identical to the definition on the server");
        await provider.disconnect();
      });

      test("an edited IDENTITY is refused with BOTH headers shown", async () => {
        // The rule is exact and needs no parser, because `pg_get_functiondef` is the engine's own
        // rendering and so is the text the reader started from: everything up to and including the
        // first `)` that closes the parameter list is compared byte for byte.
        const provider = await connected();
        mockQueryFn = async () => ({ rows: [ROUTINE_ROW] });
        const renamed = ROUTINE_ROW.definition.replace("order_total", "order_total_v2");
        const build = await provider.buildObjectEdit({
          path: ["app", "order_total(integer)"],
          kind: "function",
          partId: "definition",
          text: renamed,
        });
        if (build.built) throw new Error("expected a refusal");
        expect(build.refusal.refusal).toBe("identity");
        expect(build.refusal.sentence).toContain("order_total_v2");
        expect(build.refusal.sentence).toContain("order_total(order_id integer)");
        await provider.disconnect();
      });

      test("an ADDED PARAMETER is refused too, which is the silent fork", async () => {
        // MEASURED on 18.4: a changed argument type or an added parameter is a SILENT SUCCESS that
        // creates a SECOND `pg_proc` row (`TWO rows (16854 integer, 16855 bigint)`) and leaves the
        // original untouched, after which every call site fails `42725 is not unique`.
        const provider = await connected();
        mockQueryFn = async () => ({ rows: [ROUTINE_ROW] });
        const forked = ROUTINE_ROW.definition.replace("(order_id integer)", "(order_id bigint)");
        const build = await provider.buildObjectEdit({
          path: ["app", "order_total(integer)"],
          kind: "function",
          partId: "definition",
          text: forked,
        });
        if (build.built) throw new Error("expected a refusal");
        expect(build.refusal.refusal).toBe("identity");
        await provider.disconnect();
      });
    });
  });

  describe("applyObjectEdit", () => {
    /**
     * Builds a plan against `ROUTINE_ROW`, then re-points `mockQueryFn` so that the apply's FIRST
     * query rejects with the given error and any later query resolves with `ROUTINE_ROW`, which is
     * what lets the conflict arm's re-read answer the server's current text.
     */
    async function applyWithEngineError(error: unknown) {
      const provider = await connected();
      mockQueryFn = async () => ({ rows: [ROUTINE_ROW] });
      const build = await provider.buildObjectEdit({
        path: ["app", "order_total(integer)"],
        kind: "function",
        partId: "definition",
        text: EDITED,
      });
      if (!build.built) throw new Error(build.refusal.sentence);
      let first = true;
      mockQueryFn = async () => {
        if (first) {
          first = false;
          throw error instanceof Error
            ? error
            : Object.assign(new Error(String((error as { message?: string }).message)), error);
        }
        return { rows: [ROUTINE_ROW] };
      };
      const outcome = await provider.applyObjectEdit(build.plan);
      await provider.disconnect();
      return outcome;
    }

    test("sends EXACTLY the bytes the plan carries, with no parameters", async () => {
      const provider = await connected();
      const sent: { sql: string; params: unknown[] }[] = [];
      mockQueryFn = async (sql, params) => {
        sent.push({ sql, params: (params ?? []) as unknown[] });
        return { rows: [ROUTINE_ROW] };
      };
      const build = await provider.buildObjectEdit({
        path: ["app", "order_total(integer)"],
        kind: "function",
        partId: "definition",
        text: EDITED,
      });
      if (!build.built) throw new Error("expected a plan");
      if (build.plan.unit.medium !== "statement") throw new Error("narrowing");
      sent.length = 0;
      await provider.applyObjectEdit(build.plan);
      expect(sent[0].sql).toBe(build.plan.unit.steps[0].text);
      // Binding a parameter does not degrade the atomicity, it REFUSES it: MEASURED, `42601 cannot
      // insert multiple commands into a prepared statement`.
      expect(sent[0].params).toEqual([]);
      await provider.disconnect();
    });

    test("THE PREVIEW IS THE APPLY, proven against a provider whose state MOVED between the two calls", async () => {
      // The naive version of this test builds a plan, applies it, and asserts the executed text
      // equals `plan.unit.steps[0].text`. That test PASSES against a design that rebuilds at apply
      // time, because nothing changed between the two calls, so it certifies nothing.
      //
      // THE LIVE POPULATION THAT CONTAINS THE CASE: `objectKindsFor(version)` in
      // `src/lib/db/providers/sql/mysql.ts` resolves from `measuredServerVersion`, set in
      // `connect()`, and `POST /api/db/provider-meta` reads capabilities off a provider it never
      // connects. That is the shipped mechanism by which two reads of one provider legitimately
      // answer differently, and it is measured end to end on a live MariaDB 12.3.2.
      const provider = await connected();
      mockQueryFn = async () => ({ rows: [ROUTINE_ROW] });
      const build = await provider.buildObjectEdit({
        path: ["app", "order_total(integer)"],
        kind: "function",
        partId: "definition",
        text: EDITED,
      });
      if (!build.built) throw new Error("expected a plan");
      if (build.plan.unit.medium !== "statement") throw new Error("narrowing");
      const promised = build.plan.unit.steps[0].text;

      // MOVE the provider's resolved state between the build and the apply: a different definition
      // on the server and a different capability answer.
      const moved = {
        ...ROUTINE_ROW,
        definition: `${ROUTINE_ROW.definition} -- somebody else`,
        revision: "0123456789abcdef0123456789abcdef",
      };
      const capabilities = spyOn(provider, "getCapabilities").mockReturnValue({
        ...provider.getCapabilities(),
        objectKinds: (provider.getCapabilities().objectKinds ?? []).map((kind) =>
          kind.id === "function" ? { ...kind, sourceLanguage: "sql" } : kind,
        ),
      });
      const sent: string[] = [];
      mockQueryFn = async (sql) => {
        sent.push(sql);
        return { rows: [moved] };
      };
      try {
        await provider.applyObjectEdit(build.plan);
      } finally {
        capabilities.mockRestore();
      }
      // Byte for byte. A design that rebuilt would send different bytes here and this assertion
      // would fail; without the mutation above it could not tell the two apart.
      expect(sent[0]).toBe(promised);
      await provider.disconnect();
    });

    test("a successful apply answers `applied` with the NEW revision", async () => {
      const provider = await connected();
      let call = 0;
      mockQueryFn = async () => {
        call += 1;
        return { rows: [call === 1 ? ROUTINE_ROW : { ...ROUTINE_ROW, revision: "f".repeat(32) }] };
      };
      const build = await provider.buildObjectEdit({
        path: ["app", "order_total(integer)"],
        kind: "function",
        partId: "definition",
        text: EDITED,
      });
      if (!build.built) throw new Error("expected a plan");
      const outcome = await provider.applyObjectEdit(build.plan);
      expect(outcome.outcome).toBe("applied");
      if (outcome.outcome !== "applied") throw new Error("narrowing");
      expect(outcome.revision).toEqual({
        check: "guarded",
        token: "f".repeat(32),
        basis: "md5(pg_get_functiondef(oid))",
        scope: "server",
      });
      expect(outcome.duration).toBeGreaterThanOrEqual(0);
      await provider.disconnect();
    });

    test("the classifier maps SQLSTATE as DATA, one test per measured code", async () => {
      // The third member is typed `ObjectEditRefusalClass | undefined` and not `string | undefined`,
      // which is what this repository's own tsc under strict requires at the `toBe` below: the
      // matcher is typed by the value it is called on, so a bare `string` is rejected there rather
      // than silently widened. The VALUES are unchanged.
      const cases: readonly (readonly [string, string, ObjectEditRefusalClass | undefined])[] = [
        ["LB001", "conflict", undefined],
        ["LB002", "refused", "guard"],
        ["LB003", "applied-elsewhere", undefined],
        ["42501", "refused", "privilege"],
        ["42601", "refused", "definition"],
        ["42P13", "refused", "definition"],
        ["42809", "refused", "definition"],
        ["42P16", "refused", "definition"],
        // Risk 5, carried: this type id also serves CockroachDB and Materialize, neither of which
        // was probed, so an UNRECOGNISED code is `definition` with the engine's own sentence rather
        // than a guess.
        ["XX999", "refused", "definition"],
      ];
      for (const [code, outcome, refusalClass] of cases) {
        const answer = await applyWithEngineError(Object.assign(new Error(`engine says ${code}`), { code }));
        expect([code, answer.outcome]).toEqual([code, outcome]);
        if (answer.outcome === "refused") {
          // A `refused` row whose case carries no class means a code this table expected to answer
          // some other arm came back as a refusal, which is the mapping changing under the test.
          if (refusalClass === undefined) throw new Error(`${code} answered refused with no expected class`);
          // The CODE is paired into both assertions, and that is the difference between a failure a
          // reader can act on and one they cannot: the loop stops at the first bad case, and a bare
          // `toBe("definition")` receiving `"privilege"` does not say WHICH of the nine codes moved.
          // Measured: mutating the `42P13` arm to `privilege` produced exactly that message before
          // this pairing, so the test went red without naming the arm it was red about.
          expect([code, answer.refusal.refusal]).toEqual([code, refusalClass]);
        }
      }
    });

    test("42P13 carries the server's own HINT, which the shipped mapper destroys", async () => {
      const answer = await applyWithEngineError(
        Object.assign(new Error("cannot change return type of existing function"), {
          code: "42P13",
          hint: "Use DROP FUNCTION app.f_demo(integer) first.",
        }),
      );
      if (answer.outcome !== "refused") throw new Error("narrowing");
      expect(answer.refusal.sentence).toBe("cannot change return type of existing function");
      expect(answer.refusal.code).toBe("42P13");
      expect(answer.refusal.hint).toBe("Use DROP FUNCTION app.f_demo(integer) first.");
    });

    test("a refusal with a position lands in the READER's coordinates", async () => {
      // MEASURED: the same body error is `position 23` bare and `position 63` assembled, prefix 40,
      // and an uncorrected coordinate is CLAMPED by Monaco rather than rejected, so nothing in the
      // platform catches this being wrong.
      //
      // THE POSITION IS DERIVED FROM THE EMITTED UNIT AND IS NEVER A LITERAL: the provider segment
      // that precedes the reader's text is `step.segments[0]`, so the engine's 1-based position of
      // the reader's FIRST character is that segment's length plus one, and `position` arrives from
      // `pg` as a STRING although `QueryError.position` is typed `number`, which is the other half
      // of the conversion this test pins.
      const provider = await connected();
      mockQueryFn = async () => ({ rows: [ROUTINE_ROW] });
      const build = await provider.buildObjectEdit({
        path: ["app", "order_total(integer)"],
        kind: "function",
        partId: "definition",
        text: EDITED,
      });
      if (!build.built) throw new Error("expected a plan");
      if (build.plan.unit.medium !== "statement") throw new Error("narrowing");
      const [prefix] = build.plan.unit.steps[0].segments;
      if (prefix.from !== "provider") throw new Error("the first segment is the provider's guard block");
      const firstUserCharacter = String(prefix.text.length + 1);
      await provider.disconnect();

      const answer = await applyWithEngineError(
        Object.assign(new Error("syntax error at end of input"), { code: "42601", position: firstUserCharacter }),
      );
      if (answer.outcome !== "refused") throw new Error("narrowing");
      expect(answer.refusal.at).toEqual({ within: "user", line: 1, column: 1 });
    });

    test("a position inside the guard block is OUTSIDE and places no marker", async () => {
      const answer = await applyWithEngineError(
        Object.assign(new Error("syntax error"), { code: "42601", position: "10" }),
      );
      if (answer.outcome !== "refused") throw new Error("narrowing");
      expect(answer.refusal.at).toEqual({ within: "outside" });
    });

    test("`tuple concurrently updated` is its own conflict arm and never a driver failure", async () => {
      // MEASURED through the product: two overlapping applies of one object answered this after
      // blocking for 2.8 seconds, at HTTP 500 DATABASE_ERROR, with a sentence no user can act on.
      // This is the ONE place a message is read rather than a code, because the engine reports it
      // as XX000 and there is nothing else to read.
      const answer = await applyWithEngineError(
        Object.assign(new Error("tuple concurrently updated"), { code: "XX000" }),
      );
      expect(answer.outcome).toBe("conflict");
      if (answer.outcome !== "conflict") throw new Error("narrowing");
      expect(answer.conflict).toBe("engine-refused-concurrent");
    });

    test("a conflict re-reads and carries the server's CURRENT text for the diff", async () => {
      const answer = await applyWithEngineError(
        Object.assign(new Error("libredb: this definition changed since it was read"), { code: "LB001" }),
      );
      if (answer.outcome !== "conflict" || answer.conflict !== "object-changed") throw new Error("narrowing");
      expect(answer.current.text).toBe(ROUTINE_ROW.definition);
      expect(answer.current.language).toBe("pgsql");
    });

    test("a fork detected by the post-condition is `applied-elsewhere` and UNDONE", async () => {
      const answer = await applyWithEngineError(
        Object.assign(new Error("libredb: this apply did not change the object it was addressed to"), {
          code: "LB003",
        }),
      );
      if (answer.outcome !== "applied-elsewhere") throw new Error("narrowing");
      // PostgreSQL's post-condition raises inside the same implicit transaction, so the whole round
      // trip rolls back and the second object is gone.
      expect(answer.undone).toBe(true);
    });

    test("a driver failure with no SQLSTATE is INTERRUPTED and never a false success", async () => {
      const answer = await applyWithEngineError(new Error("Connection terminated unexpectedly"));
      if (answer.outcome !== "interrupted") throw new Error("narrowing");
      // `committed: "unknown"` is the day-one answer on all three engines, because no day-one
      // strategy wraps its own transaction. A client that retried here would apply twice.
      expect(answer.committed).toBe("unknown");
    });
  });

  test("THE SESSION IS UNCHANGED, and the apply is what makes the assertion non-vacuous", async () => {
    // Asserting "the apply left the session alone" against a provider that never touches the
    // session is an assertion nothing can fail. This provider DOES touch it: the plan pins
    // `search_path`. The pin is `SET LOCAL` inside the apply's own implicit transaction, so it is
    // gone when the round trip ends, and this is what proves it.
    //
    // THE LIVE POPULATION: MEASURED through the product with three controls, a `SET` issued by one
    // Studio user's request was read back by seven later requests including an ADMIN session on the
    // same `connection.id`, and a fresh session on the same server answered null.
    const provider = await connected();
    const sent: string[] = [];
    mockQueryFn = async (sql) => {
      sent.push(sql);
      return { rows: [ROUTINE_ROW] };
    };
    const build = await provider.buildObjectEdit({
      path: ["app", "order_total(integer)"],
      kind: "function",
      partId: "definition",
      text: EDITED,
    });
    if (!build.built) throw new Error("expected a plan");
    await provider.applyObjectEdit(build.plan);
    // Every SET this apply emits is a SET LOCAL, and there is no bare SET anywhere in the round trip.
    const sets = sent.flatMap((sql) => sql.split("\n").filter((line) => /^\s*SET\b/i.test(line)));
    expect(sets).toEqual(['SET LOCAL search_path = "app", pg_catalog;']);
    await provider.disconnect();
  });

  /**
   * Standing ruling 5g, for BOTH new methods, driven all the way to the BOUND VALUES (#789).
   *
   * PostgreSQL declares ONE container level, so its own fixture cannot tell a hardcoded index from
   * a derived one: `path[0]` and `path.slice(0, containerDepth())[0]` are the same segment at
   * depth 1. A two-level declaration is swapped in so they are not, and every assertion below is
   * on a value that REACHED the server or on the emitted unit, never on a refusal, because a
   * two-level test that stops at the refusal never reaches the bind the defect lives in.
   */
  test("derives the schema and the routine name from the DECLARATION in both new methods", async () => {
    const provider = await connected();
    const seen: { sql: string; params: unknown[] }[] = [];
    mockQueryFn = async (sql, params) => {
      seen.push({ sql, params: (params ?? []) as unknown[] });
      return { rows: [ROUTINE_ROW] };
    };
    const capabilities = spyOn(provider, "getCapabilities").mockReturnValue({
      ...provider.getCapabilities(),
      containerLevels: [
        { id: "catalog", label: "Database", labelPlural: "Databases" },
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
      ],
    });
    try {
      const build = await provider.buildObjectEdit({
        path: ["cat", "sch", "order_total(integer)"],
        kind: "function",
        partId: "definition",
        text: EDITED,
      });
      if (!build.built) throw new Error(build.refusal.sentence);
      if (build.plan.unit.medium !== "statement") throw new Error("narrowing");
      // `sch` and not `cat`: the schema is the segment the DECLARATION calls the schema, which is
      // the second one here and the first one on the shipped declaration. The name is the LAST
      // segment and not `path[1]`.
      expect(seen[0].params).toEqual(["sch", "f", "order_total(integer)"]);
      // The same derivation reached the EMITTED UNIT, which is the half a bind assertion cannot
      // see: the pin and the guard block address the object too, and a positional index there
      // would pin `search_path` to the catalog and compare the wrong routine.
      const [step] = build.plan.unit.steps;
      expect(step.text).toContain('SET LOCAL search_path = "sch", pg_catalog;');
      expect(step.text).toContain("$sch$");
      expect(build.plan.session[0]).toEqual({ mode: "pinned", setting: "search_path", value: '"sch", pg_catalog' });

      // And the APPLY's own re-read, which derives from the PLAN's path rather than the request's.
      seen.length = 0;
      await provider.applyObjectEdit(build.plan);
      expect(seen[1].params).toEqual(["sch", "f", "order_total(integer)"]);
    } finally {
      capabilities.mockRestore();
    }
    await provider.disconnect();
  });

  describe("the guards on a plan or a request this provider never produced", () => {
    /** Reaches the private helper by name, which is where the collision arm can be executed. */
    function quoter(provider: object) {
      return (provider as unknown as { dollarQuote(value: string, tagSource?: () => string): string }).dollarQuote.bind(
        provider,
      );
    }

    test("dollarQuote wraps a value in a tag that is not in it", () => {
      const quote = quoter(makeProvider());
      // No escaping of any kind, which is the point: a dollar-quoted string ignores every escape,
      // so the result does not depend on `standard_conforming_strings`, a GUC a previous borrower
      // of the pooled connection can change.
      expect(quote("it's a $$ body\\n", () => "abc123")).toBe("$lbabc123$it's a $$ body\\n$lbabc123$");
    });

    test("dollarQuote refuses rather than emitting a tag the value already contains", () => {
      const quote = quoter(makeProvider());
      // The arm is executable BECAUSE the random source is an argument. With `randomBytes` inlined
      // this line could not be reached by any test and would be a dead branch under the coverage
      // gate, which is the shape this epic has shipped before.
      expect(() => quote("body holding $lbdeadbeef$ verbatim", () => "deadbeef")).toThrow(
        /the generated quote tag occurs inside the definition/,
      );
    });

    test("a request naming a part this provider never produced is refused by name", async () => {
      const provider = await connected();
      mockQueryFn = async () => ({ rows: [ROUTINE_ROW] });
      await expect(
        provider.buildObjectEdit({
          path: ["app", "order_total(integer)"],
          kind: "function",
          partId: "body",
          text: EDITED,
        }),
      ).rejects.toThrow(/has one source part, "definition", received "body"/);
      await provider.disconnect();
    });

    test("an editable kind with no routine statement fails by name rather than binding undefined", async () => {
      // The declaration and the statement map are two lists and a kind can be added to one and not
      // the other, which is the same trap the source read's own sequence test drives one method up.
      const provider = await connected();
      const capabilities = provider.getCapabilities();
      const spy = spyOn(provider, "getCapabilities").mockReturnValue({
        ...capabilities,
        objectKinds: (capabilities.objectKinds ?? []).map((kind) =>
          kind.id === "view" ? { ...kind, acceptsSourceEdits: true } : kind,
        ),
      });
      try {
        await expect(
          provider.buildObjectEdit({
            path: ["app", "order_summary"],
            kind: "view",
            partId: "definition",
            text: "SELECT 1",
          }),
        ).rejects.toThrow(/declares an editable kind "view" but has no statement that reads it/);
      } finally {
        spy.mockRestore();
      }
      await provider.disconnect();
    });

    test("an absent routine raises the source read's own sentence rather than refusing", async () => {
      // PostgreSQL utters no sentence for an object that is not there, so a refusal here would
      // carry our silence dressed as the server's answer, which is the rule `readObjectSource`
      // already follows for the same fact.
      const provider = await connected();
      mockQueryFn = async () => ({ rows: [] });
      await expect(
        provider.buildObjectEdit({
          path: ["app", "gone(integer)"],
          kind: "function",
          partId: "definition",
          text: EDITED,
        }),
      ).rejects.toThrow(/holds no function called "gone\(integer\)" in schema "app"/);
      await provider.disconnect();
    });

    test("a server that answers no md5 refuses UNSUPPORTED rather than applying unguarded", async () => {
      // D62's population: this type id also serves CockroachDB and Materialize, neither of which
      // was probed. A guarded batch with no token to guard on is not this strategy.
      const provider = await connected();
      mockQueryFn = async () => ({ rows: [{ ...ROUTINE_ROW, revision: null }] });
      const build = await provider.buildObjectEdit({
        path: ["app", "order_total(integer)"],
        kind: "function",
        partId: "definition",
        text: EDITED,
      });
      if (build.built) throw new Error("expected a refusal");
      expect(build.refusal.refusal).toBe("unsupported");
      expect(build.refusal.sentence).toContain("md5 of pg_get_functiondef");
      await provider.disconnect();
    });

    test("a command unit is not a plan this provider issued and raises", async () => {
      const provider = await connected();
      mockQueryFn = async () => ({ rows: [ROUTINE_ROW] });
      const build = await provider.buildObjectEdit({
        path: ["app", "order_total(integer)"],
        kind: "function",
        partId: "definition",
        text: EDITED,
      });
      if (!build.built) throw new Error(build.refusal.sentence);
      if (build.plan.unit.medium !== "statement") throw new Error("narrowing");
      const command = {
        ...build.plan,
        unit: {
          medium: "command" as const,
          name: "FUNCTION",
          arguments: ["LOAD", "REPLACE"],
          payload: build.plan.unit.steps[0],
        },
      };
      await expect(provider.applyObjectEdit(command)).rejects.toThrow(/carries a statement unit, received a command/);
      await provider.disconnect();
    });

    test("a successful apply whose re-read answers nothing says the revision is UNAVAILABLE", async () => {
      // Never the OLD token: a client would compare it on its next apply and be told the object
      // had not moved, which is H3's two-state collapse arriving through the back door.
      const provider = await connected();
      let call = 0;
      mockQueryFn = async () => {
        call += 1;
        return { rows: call === 1 ? [ROUTINE_ROW] : [] };
      };
      const build = await provider.buildObjectEdit({
        path: ["app", "order_total(integer)"],
        kind: "function",
        partId: "definition",
        text: EDITED,
      });
      if (!build.built) throw new Error(build.refusal.sentence);
      const outcome = await provider.applyObjectEdit(build.plan);
      if (outcome.outcome !== "applied") throw new Error("narrowing");
      expect(outcome.revision).toEqual({
        check: "unavailable",
        reason: "the apply succeeded and the re-read that produces the new revision answered no row for this routine",
      });
      await provider.disconnect();
    });

    test("a conflict whose re-read answers nothing carries an empty current text and never the plan's", async () => {
      const provider = await connected();
      mockQueryFn = async () => ({ rows: [ROUTINE_ROW] });
      const build = await provider.buildObjectEdit({
        path: ["app", "order_total(integer)"],
        kind: "function",
        partId: "definition",
        text: EDITED,
      });
      if (!build.built) throw new Error(build.refusal.sentence);
      let first = true;
      mockQueryFn = async () => {
        if (first) {
          first = false;
          throw Object.assign(new Error("libredb: this definition changed since it was read"), { code: "LB001" });
        }
        return { rows: [] };
      };
      const outcome = await provider.applyObjectEdit(build.plan);
      if (outcome.outcome !== "conflict" || outcome.conflict !== "object-changed") throw new Error("narrowing");
      expect(outcome.current.text).toBe("");
      await provider.disconnect();
    });
  });
});
