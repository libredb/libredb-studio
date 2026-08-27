import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";

// ---------------------------------------------------------------------------
// Mock mssql BEFORE importing the provider
// ---------------------------------------------------------------------------

let mockQueryFn: (sql: string) => Promise<unknown>;
let capturedInputs: Array<{ name: string; value: unknown }> = [];
let cancelShouldThrow = false;
/** The pool handed to the most recently constructed provider. */
let lastPool: EventEmitter | undefined;

class MockRequest {
  private _transaction: unknown;

  constructor(transaction?: unknown) {
    this._transaction = transaction;
  }

  input(name: string, val: unknown) {
    capturedInputs.push({ name, value: val });
    return this;
  }

  async query(sql: string) {
    return mockQueryFn(sql);
  }

  cancel() {
    if (cancelShouldThrow) throw new Error("cancel failed");
  }
}

class MockTransaction {
  private _pool: unknown;

  constructor(pool: unknown) {
    this._pool = pool;
  }

  async begin() {}
  async commit() {}
  async rollback() {}
}

/**
 * A real EventEmitter, because `mssql`'s ConnectionPool is one and emits `error` for a
 * background connection failure (a non-ESOCKET tedious error) as well as for a failed
 * acquire. An `error` event with no listener is an uncaught exception (#298), so an inert
 * `on` in the mock would hide the crash instead of pinning it.
 */
class MockConnectionPool extends EventEmitter {
  private _config: unknown;
  public size = 10;
  public available = 7;
  public pending = 0;

  constructor(config: unknown) {
    super();
    this._config = config;
  }

  async connect() {
    return this;
  }

  async close() {}

  request() {
    return new MockRequest();
  }
}

/**
 * The provider does `new mssql.ConnectionPool(config)`; recording the instance here lets a
 * test emit on the very emitter the provider attached its listener to.
 */
/** The config the provider handed the pool, for the TLS assertions below. */
let lastPoolConfig: { options?: { encrypt?: boolean; trustServerCertificate?: boolean } } = {};

function ConnectionPoolFactory(config: unknown): MockConnectionPool {
  const pool = new MockConnectionPool(config);
  lastPoolConfig = config as typeof lastPoolConfig;
  lastPool = pool;
  return pool;
}

mock.module("mssql", () => {
  return {
    default: {
      ConnectionPool: ConnectionPoolFactory,
      Transaction: MockTransaction,
      Request: MockRequest,
    },
  };
});

// Now import the provider (after mock is in place)
import { MSSQLProvider } from "@/lib/db/providers/sql/mssql";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/types";

// ---------------------------------------------------------------------------
// Default mock query implementation
// ---------------------------------------------------------------------------

function defaultQuery(sql: string) {
  const upper = sql.toUpperCase();

  if (upper.includes("SELECT 1 AS TEST")) {
    return { recordset: [{ test: 1 }], rowsAffected: [1] };
  }

  // getOverview()'s connections query, which must be matched BEFORE the generic
  // sessions-COUNT branch below: it selects COUNT(*) FROM sys.dm_exec_sessions too,
  // so that branch used to answer it with `{ cnt: 12 }` - a column getOverview never
  // reads. Both this fixture and its duplicate were therefore dead, and the
  // `typeof activeConnections === "number"` assertion they were written for passed
  // only on the fabricated 0 the provider fell back to. `sys.configurations` is
  // unique to this statement, so the guard is exact.
  if (upper.includes("SYS.CONFIGURATIONS") && upper.includes("USER CONNECTIONS")) {
    return { recordset: [{ active_connections: 5, max_connections: 32767 }], rowsAffected: [1] };
  }

  if (upper.includes("SYS.DM_EXEC_SESSIONS") && upper.includes("COUNT")) {
    return { recordset: [{ cnt: 12 }], rowsAffected: [1] };
  }

  // Active sessions detail query (for getActiveSessions — matches DM_EXEC_SESSIONS with TOP but not COUNT)
  if (upper.includes("SYS.DM_EXEC_SESSIONS") && upper.includes("TOP") && !upper.includes("COUNT")) {
    return {
      recordset: [
        {
          pid: 55,
          user: "sa",
          database: "testdb",
          application_name: "SSMS",
          client_addr: "WORKSTATION1",
          state: "sleeping",
          query: "SELECT * FROM users",
          query_start: new Date().toISOString(),
          duration: "10s",
          duration_ms: 10000,
          wait_type: null,
          last_wait_type: "ASYNC_NETWORK_IO",
          is_blocked: 0,
        },
      ],
      rowsAffected: [1],
    };
  }

  if (upper.includes("SYS.DM_EXEC_SESSIONS") && !upper.includes("COUNT")) {
    return {
      recordset: [{ pid: 55, user: "sa", database: "testdb", state: "sleeping", query: "", duration: "10s" }],
      rowsAffected: [1],
    };
  }

  if (upper.includes("SYS.DATABASE_FILES") && upper.includes("SIZE_MB")) {
    return { recordset: [{ size_mb: 512 }], rowsAffected: [1] };
  }

  // Storage stats query (physical_name AS location)
  if (upper.includes("SYS.DATABASE_FILES") && upper.includes("PHYSICAL_NAME")) {
    return {
      recordset: [
        { name: "testdb", location: "/data/testdb.mdf", size_bytes: 536870912, type_desc: "ROWS" },
        { name: "testdb_log", location: "/data/testdb_log.ldf", size_bytes: 67108864, type_desc: "LOG" },
      ],
      rowsAffected: [2],
    };
  }

  if (upper.includes("SYS.DATABASE_FILES")) {
    return {
      recordset: [{ name: "testdb", size_bytes: 536870912, location: "/data/testdb.mdf", type_desc: "ROWS" }],
      rowsAffected: [1],
    };
  }

  if (upper.includes("SYS.DM_OS_PERFORMANCE_COUNTERS")) {
    return { recordset: [{ hit_ratio: 99.5 }], rowsAffected: [1] };
  }

  // Slow queries detail query (for getSlowQueries — has query_hash)
  if (upper.includes("SYS.DM_EXEC_QUERY_STATS") && upper.includes("QUERY_HASH")) {
    return {
      recordset: [
        {
          query_id: "0xABC123",
          query: "SELECT * FROM big_table WHERE id > 1000",
          calls: 100,
          total_time: 5550.0,
          avg_time: 55.5,
          min_time: 10.0,
          max_time: 200.0,
          row_cnt: 500,
          logical_reads: 1000,
          physical_reads: 50,
        },
      ],
      rowsAffected: [1],
    };
  }

  if (upper.includes("SYS.DM_EXEC_QUERY_STATS")) {
    return {
      recordset: [
        {
          query: "SELECT * FROM big_table",
          calls: 100,
          avg_time_ms: 55.5,
          query_id: "abc",
          total_time: 5550,
          avg_time: 55.5,
          row_cnt: 500,
          logical_reads: 1000,
          physical_reads: 50,
        },
      ],
      rowsAffected: [1],
    };
  }

  if (upper.includes("INFORMATION_SCHEMA.COLUMNS")) {
    return {
      recordset: [
        {
          TABLE_SCHEMA: "dbo",
          TABLE_NAME: "users",
          COLUMN_NAME: "id",
          DATA_TYPE: "int",
          IS_NULLABLE: "NO",
          COLUMN_DEFAULT: null,
          ORDINAL_POSITION: 1,
        },
        {
          TABLE_SCHEMA: "dbo",
          TABLE_NAME: "users",
          COLUMN_NAME: "name",
          DATA_TYPE: "nvarchar",
          IS_NULLABLE: "YES",
          COLUMN_DEFAULT: null,
          ORDINAL_POSITION: 2,
        },
        {
          TABLE_SCHEMA: "dbo",
          TABLE_NAME: "orders",
          COLUMN_NAME: "id",
          DATA_TYPE: "int",
          IS_NULLABLE: "NO",
          COLUMN_DEFAULT: null,
          ORDINAL_POSITION: 1,
        },
      ],
      rowsAffected: [3],
    };
  }

  if (upper.includes("SYS.TABLES") && upper.includes("SYS.SCHEMAS") && upper.includes("SYS.PARTITIONS")) {
    return {
      recordset: [
        { schema_name: "dbo", table_name: "users", row_count: 100 },
        { schema_name: "dbo", table_name: "orders", row_count: 500 },
      ],
      rowsAffected: [2],
    };
  }

  // Table stats (for getTableStats — SYS.ALLOCATION_UNITS)
  if (upper.includes("SYS.TABLES") && upper.includes("SYS.ALLOCATION_UNITS")) {
    return {
      recordset: [
        {
          schema_name: "dbo",
          table_name: "users",
          row_count: 100,
          total_size_bytes: 81920,
          used_size_bytes: 65536,
          table_size_bytes: 49152,
          index_size_bytes: 16384,
          last_stats_update: "2026-02-14T00:00:00Z",
        },
        {
          schema_name: "dbo",
          table_name: "orders",
          row_count: 500,
          total_size_bytes: 163840,
          used_size_bytes: 131072,
          table_size_bytes: 98304,
          index_size_bytes: 32768,
          last_stats_update: "2026-02-14T00:00:00Z",
        },
      ],
      rowsAffected: [2],
    };
  }

  if (upper.includes("SYS.INDEXES") && upper.includes("IS_PRIMARY_KEY = 1")) {
    return {
      recordset: [{ schema_name: "dbo", table_name: "users", column_name: "id" }],
      rowsAffected: [1],
    };
  }

  if (upper.includes("SYS.FOREIGN_KEYS")) {
    return {
      recordset: [
        { schema_name: "dbo", table_name: "orders", column_name: "user_id", ref_table: "users", ref_column: "id" },
      ],
      rowsAffected: [1],
    };
  }

  // Index stats (for getIndexStats — SYS.DM_DB_INDEX_USAGE_STATS)
  if (upper.includes("SYS.INDEXES") && upper.includes("SYS.DM_DB_INDEX_USAGE_STATS")) {
    return {
      recordset: [
        {
          schema_name: "dbo",
          table_name: "users",
          index_name: "PK_users",
          index_type: "CLUSTERED",
          is_unique: true,
          is_primary_key: true,
          index_size_bytes: 16384,
          scans: 250,
        },
        {
          schema_name: "dbo",
          table_name: "users",
          index_name: "IX_users_name",
          index_type: "NONCLUSTERED",
          is_unique: false,
          is_primary_key: false,
          index_size_bytes: 8192,
          scans: 120,
        },
      ],
      rowsAffected: [2],
    };
  }

  // Index columns (for getIndexStats second query)
  if (upper.includes("SYS.INDEX_COLUMNS") && upper.includes("SYS.COLUMNS") && upper.includes("KEY_ORDINAL")) {
    return {
      recordset: [
        { schema_name: "dbo", table_name: "users", index_name: "PK_users", column_name: "id", key_ordinal: 1 },
        { schema_name: "dbo", table_name: "users", index_name: "IX_users_name", column_name: "name", key_ordinal: 1 },
      ],
      rowsAffected: [2],
    };
  }

  if (upper.includes("SYS.INDEXES") && upper.includes("IS_PRIMARY_KEY = 0")) {
    return {
      recordset: [
        {
          schema_name: "dbo",
          table_name: "users",
          index_name: "IX_users_name",
          is_unique: false,
          column_name: "name",
          key_ordinal: 1,
        },
      ],
      rowsAffected: [1],
    };
  }

  if (
    upper.includes("UPDATE STATISTICS") ||
    upper.includes("SP_UPDATESTATS") ||
    upper.includes("DBCC CHECKDB") ||
    upper.includes("ALTER INDEX") ||
    upper.includes("KILL")
  ) {
    return { recordset: [], rowsAffected: [0] };
  }

  if (upper.includes("@@VERSION")) {
    return { recordset: [{ version: "Microsoft SQL Server 2022 - 16.0.1000.6" }], rowsAffected: [1] };
  }

  if (upper.includes("SYS.DM_OS_SYS_INFO")) {
    return {
      recordset: [{ sqlserver_start_time: new Date(Date.now() - 86400 * 1000).toISOString(), uptime_seconds: 86400 }],
      rowsAffected: [1],
    };
  }

  // Table/index counts for overview
  if (upper.includes("SYS.TABLES") && upper.includes("TABLE_COUNT") && upper.includes("INDEX_COUNT")) {
    return { recordset: [{ table_count: 5, index_count: 12 }], rowsAffected: [1] };
  }

  // Database size bytes for overview
  if (upper.includes("SYS.DATABASE_FILES") && upper.includes("SIZE_BYTES")) {
    return { recordset: [{ size_bytes: 536870912 }], rowsAffected: [1] };
  }

  // Default
  return { recordset: [{ id: 1, name: "test" }], rowsAffected: [1] };
}

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

const baseConfig: DatabaseConnection = {
  id: "test-mssql",
  name: "Test MSSQL",
  type: "mssql",
  host: "localhost",
  port: 1433,
  database: "testdb",
  user: "sa",
  password: "test",
  createdAt: new Date(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MSSQLProvider", () => {
  let provider: MSSQLProvider;

  beforeEach(() => {
    mockQueryFn = async (sql: string) => defaultQuery(sql);
    capturedInputs = [];
    cancelShouldThrow = false;
    provider = new MSSQLProvider(baseConfig);
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

  describe("validation", () => {
    test("throws DatabaseConfigError when host is missing", () => {
      expect(() => {
        new MSSQLProvider({
          ...baseConfig,
          host: undefined,
          connectionString: undefined,
        } as unknown as DatabaseConnection);
      }).toThrow(DatabaseConfigError);
    });

    test("throws DatabaseConfigError when database is missing", () => {
      expect(() => {
        new MSSQLProvider({
          ...baseConfig,
          database: undefined,
          connectionString: undefined,
        } as unknown as DatabaseConnection);
      }).toThrow(DatabaseConfigError);
    });

    test("connectionString bypasses host/database validation", () => {
      expect(() => {
        new MSSQLProvider({
          ...baseConfig,
          host: undefined,
          database: undefined,
          connectionString: "Server=localhost;Database=testdb;User Id=sa;Password=test;",
        } as unknown as DatabaseConnection);
      }).not.toThrow();
    });
  });

  // =========================================================================
  // 2. Connect / Disconnect
  // =========================================================================

  // =========================================================================
  // TLS
  // =========================================================================

  describe("the TLS options handed to tedious", () => {
    const connectWithSSL = async (mode: NonNullable<DatabaseConnection["ssl"]>["mode"]) => {
      provider = new MSSQLProvider({ ...baseConfig, ssl: { mode } });
      await provider.connect();
      return lastPoolConfig.options;
    };

    test("mode disable turns encryption off", async () => {
      expect(await connectWithSSL("disable")).toMatchObject({ encrypt: false });
    });

    test("mode require encrypts and trusts whatever certificate is presented", async () => {
      expect(await connectWithSSL("require")).toMatchObject({ encrypt: true, trustServerCertificate: true });
    });

    // D26: SQL Server needed no code change to answer for `verify-system`. tedious has one
    // knob, `trustServerCertificate`, and turning it off is already "validate the chain and
    // the name against the host's trust store" - there is no separate CA channel here, so
    // verify-system, verify-ca and verify-full all land on the same call. This pins that the
    // widened union did not silently fall through to the trusting branch.
    test("mode verify-system validates the certificate, like the two verify-* modes", async () => {
      expect(await connectWithSSL("verify-system")).toMatchObject({ encrypt: true, trustServerCertificate: false });
      expect(await connectWithSSL("verify-ca")).toMatchObject({ encrypt: true, trustServerCertificate: false });
      expect(await connectWithSSL("verify-full")).toMatchObject({ encrypt: true, trustServerCertificate: false });
    });
  });

  describe("connect / disconnect", () => {
    test("connect creates pool and marks connected", async () => {
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test("disconnect closes pool and marks disconnected", async () => {
      await provider.connect();
      await provider.disconnect();
      expect(provider.isConnected()).toBe(false);
    });

    test("double connect is idempotent", async () => {
      await provider.connect();
      await provider.connect(); // should not throw
      expect(provider.isConnected()).toBe(true);
    });

    // ── Pool error events (#298) ─────────────────────────────────────────────

    test("a pool error is logged and does not escalate past the provider", async () => {
      await provider.connect();
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});

      try {
        expect(() => lastPool?.emit("error", new Error("socket hang up"))).not.toThrow();
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const logged = errorSpy.mock.calls[0].join(" ");
        expect(logged).toContain("[MSSQL]");
        expect(logged).toContain("socket hang up");
      } finally {
        errorSpy.mockRestore();
      }
    });

    test("the pool carries exactly one error listener, and a repeat connect adds none", async () => {
      await provider.connect();
      await provider.connect();

      expect(lastPool?.listenerCount("error")).toBe(1);
    });
  });

  // =========================================================================
  // 3. query()
  // =========================================================================

  describe("query()", () => {
    test("returns rows from recordset", async () => {
      await provider.connect();
      const result = await provider.query("SELECT id, name FROM users");

      expect(result.rows).toBeArray();
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.fields).toBeArray();
      expect(typeof result.executionTime).toBe("number");
    });

    test("binds positional parameters as p1..pN inputs", async () => {
      await provider.connect();
      const result = await provider.query("SELECT * FROM users WHERE id = @p1 AND name = @p2", [42, "alice"]);

      expect(result.rows).toBeArray();
      expect(capturedInputs).toEqual([
        { name: "p1", value: 42 },
        { name: "p2", value: "alice" },
      ]);
    });
  });

  // =========================================================================
  // 3b. escapeIdentifier() dialect override
  // =========================================================================

  describe("escapeIdentifier()", () => {
    test("wraps identifiers in brackets and escapes closing brackets", () => {
      const providerAny = provider as unknown as { escapeIdentifier(identifier: string): string };
      expect(providerAny.escapeIdentifier("users")).toBe("[users]");
      expect(providerAny.escapeIdentifier("weird]name")).toBe("[weird]]name]");
    });
  });

  // =========================================================================
  // 4. getCapabilities()
  // =========================================================================

  describe("getCapabilities()", () => {
    // #U9: DBCC CHECKDB takes no object, and `runMaintenance` ignores the target for
    // it - a per-table Check control would have named one table and checked the
    // database.
    test("declares the target grammar of every maintenance operation", () => {
      const caps = provider.getCapabilities();

      expect(caps.maintenanceOperationSpecs).toEqual({
        analyze: { label: "Update Statistics", perEntity: true, global: true },
        check: { label: "Check Database", perEntity: false, global: true },
        optimize: { label: "Rebuild Indexes", perEntity: true, global: true },
        kill: { label: "Kill Session", perEntity: false, global: false },
      });
      expect(Object.keys(caps.maintenanceOperationSpecs ?? {}).sort()).toEqual([...caps.maintenanceOperations].sort());
    });

    test("the vacuum label names the index rebuild, and the surfaces send that", () => {
      const labels = provider.getLabels();

      expect(labels.vacuumAction).toBe("Rebuild Indexes");
      expect(labels.vacuumActionOperation).toBe("optimize");
      // A redirected slot must name an operation the provider really declares,
      // otherwise the card it gates could only ever produce a 400.
      expect(provider.getCapabilities().maintenanceOperations).toContain("optimize");
    });
    test("returns correct capabilities for MSSQL", () => {
      const caps = provider.getCapabilities();
      expect(caps.defaultPort).toBe(1433);
      expect(caps.maintenanceOperations).toContain("analyze");
      expect(caps.maintenanceOperations).toContain("check");
      expect(caps.maintenanceOperations).toContain("optimize");
      expect(caps.maintenanceOperations).toContain("kill");
      // Explain is intentionally disabled until a SQL Server dialect wrapper exists (#126):
      // the UI's EXPLAIN builder has no SET SHOWPLAN_* flow, so advertising the capability
      // made the Explain action silently run the unmodified query.
      expect(caps.supportsExplain).toBe(false);
      expect(caps.explainFormat).toBeUndefined();
      expect(caps.supportsExplain).toBe(caps.explainFormat !== undefined);
      expect(caps.supportsConnectionString).toBe(true);
      // `UPDATE t SET c = v WHERE pk = v` is core T-SQL DML — the shape the inline
      // row editor builds (#269).
      expect(caps.supportsInlineRowEdit).toBe(true);
      // The mssql Transaction object over one held pool connection (#U13).
      expect(caps.supportsTransactions).toBe(true);
      // Inherited from the base capabilities: this engine declares foreign keys, so
      // an empty `foreignKeys` list is a fact about the schema or the role, never
      // about the engine (#414).
      expect(caps.declaresForeignKeys).toBe(true);
    });
  });

  // =========================================================================
  // 5. getLabels()
  // =========================================================================

  describe("getLabels()", () => {
    test("returns Update Statistics as analyzeAction", () => {
      const labels = provider.getLabels();
      expect(labels.analyzeAction).toBe("Update Statistics");
    });

    // Until #U12 the monitoring Queries panel told a SQL Server DBA to install a
    // PostgreSQL extension. `getSlowQueries()` reads sys.dm_exec_query_stats and
    // swallows a failure into `[]`, so the permission on that DMV is what it must name.
    test("names sys.dm_exec_query_stats, not a Postgres extension, as the source of query stats", () => {
      const { slowQueriesEmptyState } = provider.getLabels();

      expect(slowQueriesEmptyState).toContain("sys.dm_exec_query_stats");
      expect(slowQueriesEmptyState).toContain("VIEW SERVER STATE");
      expect(slowQueriesEmptyState).not.toContain("pg_stat_statements");
    });
  });

  // =========================================================================
  // 6. prepareQuery()
  // =========================================================================

  describe("prepareQuery()", () => {
    test("SELECT gets TOP N", () => {
      const result = provider.prepareQuery("SELECT * FROM users");
      expect(result.query).toMatch(/SELECT\s+TOP\s+\d+/i);
      expect(result.wasLimited).toBe(true);
    });

    test("SELECT with offset gets OFFSET FETCH and ORDER BY injected", () => {
      const result = provider.prepareQuery("SELECT * FROM users", { offset: 10, limit: 50 });
      expect(result.query).toContain("ORDER BY");
      expect(result.query).toContain("OFFSET 10 ROWS");
      expect(result.query).toContain("FETCH NEXT 50 ROWS ONLY");
      expect(result.wasLimited).toBe(true);
    });

    test("non-SELECT query is unchanged", () => {
      const sql = "INSERT INTO users (name) VALUES ('test')";
      const result = provider.prepareQuery(sql);
      expect(result.query).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    test("existing TOP leaves query unchanged", () => {
      const sql = "SELECT TOP 10 * FROM users";
      const result = provider.prepareQuery(sql);
      expect(result.wasLimited).toBe(false);
    });

    // ── Leading comments (#275) ─────────────────────────────────────────────
    //
    // This path is the reason the classifier could not be fixed on its own. It
    // commits to `wasLimited: true` and then splices `TOP` in after the leading
    // `SELECT`; behind a comment the old `^(\s*SELECT\s+)` replace matched
    // nothing, so a comment-tolerant classifier alone would have made MSSQL
    // report a limit it never applied - worse than not limiting at all, because
    // the UI stops warning about the unbounded result set.

    describe("leading comments", () => {
      test.each<[string, string, string]>([
        ["a line comment", "-- annotated\nSELECT * FROM users", "-- annotated\nSELECT TOP 50 * FROM users"],
        ["a block comment", "/* annotated */ SELECT * FROM users", "/* annotated */ SELECT TOP 50 * FROM users"],
        ["a hash comment", "# annotated\nSELECT * FROM users", "# annotated\nSELECT TOP 50 * FROM users"],
        ["stacked comments", "-- a\n/* b */\nSELECT name FROM users", "-- a\n/* b */\nSELECT TOP 50 name FROM users"],
      ])("injects TOP after the real SELECT behind %s", (_label, sql, expected) => {
        const result = provider.prepareQuery(sql, { limit: 50 });

        expect(result.query).toBe(expected);
        expect(result.wasLimited).toBe(true);
      });

      test("keeps TOP after DISTINCT, which is where T-SQL wants it", () => {
        const result = provider.prepareQuery("/* annotated */ SELECT DISTINCT name FROM users", { limit: 50 });

        expect(result.query).toBe("/* annotated */ SELECT DISTINCT TOP 50 name FROM users");
        expect(result.wasLimited).toBe(true);
      });

      test("does not inject a second TOP into a commented, already-bounded SELECT", () => {
        const sql = "-- annotated\nSELECT TOP 10 * FROM users";

        const result = provider.prepareQuery(sql, { limit: 50 });

        expect(result.query).toBe(sql);
        expect(result.wasLimited).toBe(false);
        expect(result.query.match(/\bTOP\b/gi)).toHaveLength(1);
      });

      // A comment BETWEEN `SELECT` and `TOP` defeats the already-bounded probe,
      // which still wants literal whitespace there, so this path is reached with a
      // statement that is in fact bounded. Splicing here would produce
      // `SELECT TOP 50/*c*/TOP 10 ...` - two TOPs and a server-side syntax error,
      // where before this task the same input came back unchanged. Refusing to
      // splice is the honest answer: the statement already carries its own bound.
      test.each<[string, string]>([
        ["a comment between SELECT and TOP", "SELECT/* c */TOP 10 * FROM users"],
        ["a comment between SELECT and TOP, with DISTINCT", "SELECT/* c */DISTINCT TOP 10 name FROM users"],
        ["DISTINCT before an existing TOP", "SELECT DISTINCT TOP 10 name FROM users"],
      ])("does not splice a second TOP past %s", (_label, sql) => {
        const result = provider.prepareQuery(sql, { limit: 50 });

        expect(result.query).toBe(sql);
        expect(result.wasLimited).toBe(false);
        expect(result.query.match(/\bTOP\b/gi)).toHaveLength(1);
      });

      // ── Trailing comments (#280) ──────────────────────────────────────────
      //
      // The `TOP` head splice was never affected - it writes into the head, which
      // no trailing comment can reach - but the pagination branch appends at the
      // tail exactly as PostgreSQL's and Oracle's do, so it shared the defect.
      // Both are asserted here: the one that changes, and the one that must not.

      describe("trailing comments", () => {
        test("the offset branch appends before the comment", () => {
          const result = provider.prepareQuery("SELECT id FROM users -- daily check", { limit: 50, offset: 10 });

          expect(result.query).toBe(
            "SELECT id FROM users ORDER BY (SELECT NULL) OFFSET 10 ROWS FETCH NEXT 50 ROWS ONLY -- daily check",
          );
          expect(result.wasLimited).toBe(true);
        });

        test("the offset branch keeps the terminating semicolon outside the comment", () => {
          const result = provider.prepareQuery("SELECT id FROM users ORDER BY id; -- daily check", {
            limit: 50,
            offset: 10,
          });

          expect(result.query).toBe(
            "SELECT id FROM users ORDER BY id OFFSET 10 ROWS FETCH NEXT 50 ROWS ONLY; -- daily check",
          );
        });

        // The head splice is lossless whatever follows the statement, so it keeps
        // working where the tail may not be cut. A temp table is the case that
        // makes this matter: `#tmp` is everyday T-SQL and reads as a MySQL
        // comment to the shared scanner, so a tail append would have emitted
        // `SELECT * FROM ... OFFSET ... #tmp`.
        test.each<[string, string, string]>([
          ["a temp table", "SELECT * FROM #tmp", "SELECT TOP 50 * FROM #tmp"],
          [
            "a literal whose end is undeterminable",
            "SELECT id FROM users WHERE path = 'C:\\';",
            "SELECT TOP 50 id FROM users WHERE path = 'C:\\';",
          ],
        ])("still splices TOP into %s", (_label, sql, expected) => {
          const result = provider.prepareQuery(sql, { limit: 50 });

          expect(result.query).toBe(expected);
          expect(result.wasLimited).toBe(true);
        });

        // `TOP` and `OFFSET … FETCH` cannot both appear in one query expression
        // (Msg 10741), so the splice must not fire on a page the user already
        // bounded. It does not, because a refused cut still reports the whole
        // statement, and the already-bounded probe reads that.
        test("does not splice TOP into a temp-table page that already carries a bound", () => {
          const sql = "SELECT * FROM #tmp ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY";

          const result = provider.prepareQuery(sql, { limit: 50 });

          expect(result.query).toBe(sql);
          expect(result.wasLimited).toBe(false);
        });

        test("the offset branch declines on a literal whose end is undeterminable", () => {
          const sql = "SELECT id FROM users WHERE path = 'C:\\';";

          const result = provider.prepareQuery(sql, { limit: 50, offset: 10 });

          expect(result.query).toBe(sql);
          expect(result.wasLimited).toBe(false);
        });

        // A temp table used to reach the same refusal, and it no longer does: this
        // provider now tells the shared reader that `#` is code in T-SQL (#292), so
        // `#tmp` is the statement's own text, the end is cuttable and the page is
        // appended where T-SQL wants it. The refusal was never about temp tables
        // being unsafe to page - it was the price of a reader that could not tell
        // `#tmp` from `# note`.
        test("the offset branch now pages a temp-table read, which T-SQL accepts", () => {
          const result = provider.prepareQuery("SELECT * FROM #tmp ORDER BY id", { limit: 50, offset: 10 });

          expect(result.query).toBe("SELECT * FROM #tmp ORDER BY id OFFSET 10 ROWS FETCH NEXT 50 ROWS ONLY");
          expect(result.wasLimited).toBe(true);
        });

        test("the TOP head splice is unchanged by a trailing comment", () => {
          const result = provider.prepareQuery("SELECT * FROM users -- daily check", { limit: 50 });

          expect(result.query).toBe("SELECT TOP 50 * FROM users -- daily check");
          expect(result.wasLimited).toBe(true);
        });

        // ── The `#` grammar is T-SQL's here (#292) ──────────────────────────
        //
        // This block records the shape the trailing-comment note above had to
        // leave open: put trivia AFTER the bound of a temp-table page and the
        // whole line vanished into a "comment" that starts at `#tmp`, so the
        // end-anchored probe saw no bound and a `TOP` was spliced alongside an
        // `OFFSET … FETCH` that SQL Server rejects outright (Msg 10741). Naming
        // the dialect closes it at the root: `#` is never a comment in T-SQL.
        test.each<[string, string]>([
          ["a trailing line comment", "SELECT * FROM #tmp ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY -- daily"],
          [
            "a trailing block comment",
            "SELECT * FROM #tmp ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY /* daily */",
          ],
          [
            "a terminator and a comment",
            "SELECT * FROM #tmp ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY; -- daily",
          ],
        ])("does not splice TOP into an already-paged temp-table read carrying %s", (_label, sql) => {
          const result = provider.prepareQuery(sql, { limit: 50 });

          expect(result.query).toBe(sql);
          expect(result.wasLimited).toBe(false);
        });

        // Fixture discipline: a bracket-quoted NAME carrying a hash, read from a
        // temp table - two constructs the scanner does not model as a unit. The
        // emitted text is asserted whole, because the failure mode this milestone
        // shipped last time was a bound spliced INTO a bracketed name.
        test("splices TOP ahead of a bracket-quoted name carrying a hash", () => {
          const result = provider.prepareQuery("SELECT [a#b] FROM #tmp", { limit: 50 });

          expect(result.query).toBe("SELECT TOP 50 [a#b] FROM #tmp");
          expect(result.wasLimited).toBe(true);
        });

        // ── `[…]` stays a quoted NAME here (#295) ───────────────────────────
        //
        // The bracket grammar is now the dialect's answer, and T-SQL's is the one
        // the shared reader always applied: everything between the brackets is the
        // name — an apostrophe, a comment marker, a semicolon — and a doubled `]`
        // is how a bracket inside one is written, which is exactly what this
        // provider's own `escapeIdentifier` emits. ClickHouse gets the array
        // reading instead, and teaching THIS scan to step over string literals is
        // what would break the first row below.
        test.each<[string, string, string]>([
          ["an apostrophe", "SELECT [it's] FROM users", "SELECT TOP 50 [it's] FROM users"],
          ["a doubled close bracket", "SELECT [a]]b] FROM users", "SELECT TOP 50 [a]]b] FROM users"],
          ["a comment marker", "SELECT [a--b] FROM users", "SELECT TOP 50 [a--b] FROM users"],
          ["a semicolon", "SELECT [a;b] FROM users", "SELECT TOP 50 [a;b] FROM users"],
        ])("splices TOP ahead of a bracket-quoted name carrying %s", (_label, sql, expected) => {
          const result = provider.prepareQuery(sql, { limit: 50 });

          expect(result.query).toBe(expected);
          expect(result.wasLimited).toBe(true);
        });

        test("pages a bracket-quoted name carrying an apostrophe, appending at the real end", () => {
          // The tail branch is where a misread name costs more than a bound: the
          // page has to land after the whole name, not inside it.
          const result = provider.prepareQuery("SELECT [it's] FROM users ORDER BY id", { limit: 50, offset: 10 });

          expect(result.query).toBe("SELECT [it's] FROM users ORDER BY id OFFSET 10 ROWS FETCH NEXT 50 ROWS ONLY");
          expect(result.wasLimited).toBe(true);
        });
      });

      test("appends OFFSET FETCH to a commented SELECT, which needs no head rewrite", () => {
        const result = provider.prepareQuery("-- annotated\nSELECT * FROM users", { limit: 50, offset: 10 });

        expect(result.query).toContain("-- annotated\n");
        expect(result.query).toContain("OFFSET 10 ROWS");
        expect(result.query).toContain("FETCH NEXT 50 ROWS ONLY");
        expect(result.wasLimited).toBe(true);
      });
    });

    // ── Block comments NEST here (#300) ──────────────────────────────────────
    //
    // T-SQL supports nested comments: a `/*` anywhere inside a comment opens a
    // nested one and needs its own `*/` ("Slash Star (Block Comment)"). Read flat,
    // the text between the inner `*/` and the comment's real end reaches the
    // readers as code - and on THIS provider that is worse than a lost bound,
    // because the `TOP` splice writes into the head at an index that reading
    // chose. The first row below is the shape it emitted: a `TOP` placed after a
    // `DISTINCT` that is inside the comment, so SQL Server saw
    // `SELECT name FROM t` - unbounded - while this method reported a limit.
    describe("nested block comments", () => {
      test("splices TOP before the whole comment rather than into it", () => {
        const result = provider.prepareQuery("SELECT /* a /* b */ DISTINCT */ name FROM t", { limit: 50 });

        expect(result.query).toBe("SELECT TOP 50 /* a /* b */ DISTINCT */ name FROM t");
        expect(result.wasLimited).toBe(true);
      });

      test("still keeps TOP after a DISTINCT that follows the whole comment", () => {
        const result = provider.prepareQuery("SELECT /* a /* b */ c */ DISTINCT name FROM t", { limit: 50 });

        expect(result.query).toBe("SELECT /* a /* b */ c */ DISTINCT TOP 50 name FROM t");
        expect(result.wasLimited).toBe(true);
      });

      test("bounds a read behind a leading nested comment", () => {
        const result = provider.prepareQuery("/* a /* b */ x */ SELECT name FROM t", { limit: 50 });

        expect(result.query).toBe("/* a /* b */ x */ SELECT TOP 50 name FROM t");
        expect(result.wasLimited).toBe(true);
      });

      test("adds no clause to a write a nested comment hid inside a CTE list", () => {
        const sql =
          "WITH recent AS (\n  /* outer /* inner */ ) SELECT 1 */\n  SELECT id FROM logs\n)\nINSERT INTO archive (id) SELECT id FROM recent";

        const result = provider.prepareQuery(sql, { limit: 50 });

        expect(result.query).toBe(sql);
        expect(result.wasLimited).toBe(false);
      });

      test("adds no clause where the nested comment never closes", () => {
        const sql = "/* a /* b */ SELECT name FROM t";

        const result = provider.prepareQuery(sql, { limit: 50 });

        expect(result.query).toBe(sql);
        expect(result.wasLimited).toBe(false);
      });
    });

    // ── A statement that already carries a page (#293) ───────────────────────
    //
    // `TOP` and `OFFSET … FETCH` may not both appear in one query expression, so
    // adding a row-count clause to a statement that already carries a page does
    // not return too many rows - SQL Server rejects the statement outright
    // (Msg 10741) while this method reports `wasLimited: true`. Two shapes reach
    // that, and neither of them is the hash #292 closed at the root:
    //
    // 1. The statement's end may not be CUT. The already-bounded probes in the
    //    shared limiter are anchored at the end of the statement's own text, and
    //    where the cut is refused that text still carries the trailing trivia -
    //    so a real page written BEFORE a trailing comment sits away from the
    //    anchor and reads as absent.
    // 2. `OFFSET n ROWS` with no `FETCH` tail is a complete T-SQL page that the
    //    shared probes do not recognise at all: they want a `FETCH … ROWS ONLY`
    //    tail or a bare `OFFSET n` at the very end, and this form is neither.
    describe("statements that already carry a page", () => {
      // Shape 1. Every row carries a real page AND real trailing trivia; what
      // differs is only the reason the end cannot be cut. The emitted text is
      // asserted whole, because what this closes is an emitted statement the
      // server refuses rather than one that returns too many rows.
      test.each<[string, string]>([
        [
          "a literal whose end is undeterminable",
          "SELECT id FROM users WHERE path = 'C:\\' ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY -- daily",
        ],
        [
          "an unterminated block comment",
          "SELECT id FROM users ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY /* daily",
        ],
        [
          "an unterminated bracket-quoted name",
          "SELECT [abc FROM users ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY -- daily",
        ],
      ])("adds no TOP to a paged read whose end cannot be cut for %s", (_label, sql) => {
        const result = provider.prepareQuery(sql, { limit: 50 });

        expect(result.query).toBe(sql);
        expect(result.wasLimited).toBe(false);
        expect(result.query).not.toMatch(/\bTOP\b/i);
      });

      // Shape 2. The `#tmp` row is this task's fixture-discipline input: a
      // temp-table name and a block comment after the page, two constructs the
      // shared scanner reads only because this provider names its dialect.
      test.each<[string, string]>([
        ["with no FETCH tail", "SELECT * FROM users ORDER BY id OFFSET 10 ROWS"],
        ["spelled ROW rather than ROWS", "SELECT * FROM users ORDER BY id OFFSET 1 ROW"],
        ["before a trailing line comment", "SELECT * FROM users ORDER BY id OFFSET 10 ROWS -- daily"],
        ["before a terminator", "SELECT * FROM users ORDER BY id OFFSET 10 ROWS;"],
        ["with a FETCH tail", "SELECT * FROM users ORDER BY id OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY"],
        ["on a temp table, before a block comment", "SELECT * FROM #tmp ORDER BY id OFFSET 10 ROWS /* daily */"],
      ])("recognises a T-SQL page %s and adds no clause beside it", (_label, sql) => {
        const result = provider.prepareQuery(sql, { limit: 50 });

        expect(result.query).toBe(sql);
        expect(result.wasLimited).toBe(false);
        expect(result.query).not.toMatch(/\bTOP\b/i);
      });

      // The pagination branch reaches the same statement, and appending there
      // emits `… OFFSET 10 ROWS OFFSET 10 ROWS FETCH NEXT 50 ROWS ONLY`.
      test("appends no second page to a T-SQL page when an offset is requested", () => {
        const sql = "SELECT * FROM users ORDER BY id OFFSET 10 ROWS";

        const result = provider.prepareQuery(sql, { limit: 50, offset: 10 });

        expect(result.query).toBe(sql);
        expect(result.wasLimited).toBe(false);
      });

      // The page probe is anchored at the end of the statement, exactly as the
      // shared ones are: an `OFFSET` belonging to a subquery is a different query
      // expression, which a `TOP` on the outer one may legally join, and one
      // written in text the statement merely carries is no page at all.
      test.each<[string, string, string]>([
        [
          "an OFFSET inside a subquery",
          "SELECT * FROM (SELECT id FROM t ORDER BY id OFFSET 10 ROWS) x",
          "SELECT TOP 50 * FROM (SELECT id FROM t ORDER BY id OFFSET 10 ROWS) x",
        ],
        [
          "a page spelled inside a trailing comment",
          "SELECT * FROM users -- OFFSET 10 ROWS",
          "SELECT TOP 50 * FROM users -- OFFSET 10 ROWS",
        ],
        [
          "a page spelled inside a bracket-quoted name",
          "SELECT [OFFSET 5 ROWS] FROM users",
          "SELECT TOP 50 [OFFSET 5 ROWS] FROM users",
        ],
        [
          "a column whose name merely begins with the word",
          "SELECT offset_id FROM users WHERE path = 'C:\\'",
          "SELECT TOP 50 offset_id FROM users WHERE path = 'C:\\'",
        ],
      ])("still bounds a read carrying %s", (_label, sql, expected) => {
        const result = provider.prepareQuery(sql, { limit: 50 });

        expect(result.query).toBe(expected);
        expect(result.wasLimited).toBe(true);
      });

      // A head `TOP` is found by a probe anchored at the statement's own
      // `SELECT`, so no trailing trivia and no unreadable tail can hide it. This
      // is today's answer on both rows; it is asserted because the refusal added
      // here must not turn a recognised bound into a silent second one.
      test.each<[string, string]>([
        ["before a trailing comment", "SELECT TOP 10 * FROM users -- daily"],
        ["in a statement whose end cannot be cut", "SELECT TOP 10 id FROM users WHERE path = 'C:\\'"],
      ])("keeps a head TOP %s and collects no second clause", (_label, sql) => {
        const result = provider.prepareQuery(sql, { limit: 50 });

        expect(result.query).toBe(sql);
        expect(result.wasLimited).toBe(false);
        expect(result.query.match(/\bTOP\b/gi)).toHaveLength(1);
      });

      // The blunt half of the rule, pinned so it stays a decision rather than a
      // surprise: where the end cannot be cut, no anchor is trustworthy, so the
      // WORD alone is enough to decline - and a statement that merely names a
      // column `offset` beside an unreadable literal loses its bound. It is
      // reported honestly (`wasLimited: false`), which is the trade every reader
      // in `src/lib/sql/` makes for text it cannot resolve.
      test("declines where an unreadable end sits beside a column named like a clause", () => {
        const sql = "SELECT [offset] FROM users WHERE path = 'C:\\'";

        const result = provider.prepareQuery(sql, { limit: 50 });

        expect(result.query).toBe(sql);
        expect(result.wasLimited).toBe(false);
      });
    });

    // The honesty invariant behind all of the above, asserted directly: there is no
    // input for which this path claims a limit while handing back the statement it
    // was given. A CTE is the case that is NOT rewritable here - `TOP` belongs to
    // the trailing SELECT, which finding would need a parser - so it must report
    // false rather than lie.
    test.each<[string, string]>([
      ["a CTE", "WITH cte AS (SELECT 1 AS n) SELECT * FROM cte"],
      ["a commented CTE", "-- annotated\nWITH cte AS (SELECT 1 AS n) SELECT * FROM cte"],
      ["a statement opening with a parenthesis", "(SELECT 1) UNION (SELECT 2)"],
    ])("never reports a limit it did not apply, for %s", (_label, sql) => {
      const result = provider.prepareQuery(sql, { limit: 50 });

      if (result.wasLimited) {
        expect(result.query).not.toBe(sql);
      } else {
        expect(result.query).toBe(sql);
      }
    });
  });

  // =========================================================================
  // 7. getSchema()
  // =========================================================================

  describe("getSchema()", () => {
    test("returns tables with schema prefix handling", async () => {
      await provider.connect();
      const schema = await provider.getSchema();

      expect(schema).toBeArray();
      expect(schema.length).toBe(2);

      // dbo schema should not have prefix for display name
      const usersTable = schema.find((t) => t.name === "users");
      expect(usersTable).toBeDefined();
      expect(usersTable!.columns.length).toBeGreaterThanOrEqual(2);

      // Check PK
      const idCol = usersTable!.columns.find((c) => c.name === "id");
      expect(idCol).toBeDefined();
      expect(idCol!.isPrimary).toBe(true);

      // Check FK on orders
      const ordersTable = schema.find((t) => t.name === "orders");
      expect(ordersTable).toBeDefined();
      expect(ordersTable!.foreignKeys!.length).toBeGreaterThan(0);
      expect(ordersTable!.foreignKeys![0].referencedTable).toBe("users");
    });
  });

  // =========================================================================
  // 8. getHealth()
  // =========================================================================

  describe("getHealth()", () => {
    test("returns health data", async () => {
      await provider.connect();
      const health = await provider.getHealth();

      expect(typeof health.activeConnections).toBe("number");
      expect(typeof health.databaseSize).toBe("string");
      expect(health.cacheHitRatio).toBe("99.5%");
      expect(health.slowQueries).toBeArray();
      expect(health.activeSessions).toBeArray();
    });

    test("a denied session DMV leaves activeConnections absent, never a measured 0", async () => {
      // `sys.dm_exec_sessions` needs VIEW SERVER STATE - the sibling of the grant whose
      // refusal WAS measured here, 2026-08-23 on SQL Server 2022 CU26 against a login
      // with nothing beyond CONNECT (`Msg 300 ... VIEW SERVER PERFORMANCE STATE
      // permission was denied on object 'server', database 'master'`, the
      // getPerformanceMetrics test below). The Msg 300 shape is the same; only the
      // permission named differs, so this fixture reproduces the shape, not a quote.
      // The block was guarded, but `let activeConnections = 0` then published the
      // denial as a server with no connections open - and `HealthInfo` is the shape
      // the agent's curated health reading forwards to the model, so that zero was a
      // measurement the model could cite about a figure SQL Server never gave.
      mockQueryFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("SYS.DM_EXEC_SESSIONS") && upper.includes("COUNT")) {
          throw new Error("VIEW SERVER STATE permission was denied on object 'server', database 'master'");
        }
        return defaultQuery(sql);
      };

      await provider.connect();
      const health = await provider.getHealth();

      expect("activeConnections" in health).toBe(false);
      // Only the denied block goes absent; the rest of the reading is unaffected.
      expect(health.cacheHitRatio).toBe("99.5%");
      expect(health.activeSessions).toBeArray();
    });

    test("a server with no user sessions keeps its measured zero connections", async () => {
      // The anti-vacuity twin of the test above. Absence must never be spelled with a
      // falsy test (`activeConnections || undefined`): an idle instance measures 0 and
      // that 0 is a reading, not a refusal.
      mockQueryFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("SYS.DM_EXEC_SESSIONS") && upper.includes("COUNT")) {
          return { recordset: [{ cnt: 0 }], rowsAffected: [1] };
        }
        return defaultQuery(sql);
      };

      await provider.connect();
      const health = await provider.getHealth();

      expect("activeConnections" in health).toBe(true);
      expect(health.activeConnections).toBe(0);
    });

    test("reports an unreadable cache hit ratio as unavailable, not as 0%", async () => {
      // `${recordset[0]?.hit_ratio || 0}%` published "0%" for a NULL, and the
      // Overview card rates 0 as "Needs tuning" - a fault SQL Server never
      // reported.
      mockQueryFn = async (sql: string) => {
        if (sql.toUpperCase().includes("SYS.DM_OS_PERFORMANCE_COUNTERS")) {
          return { recordset: [{ hit_ratio: null }], rowsAffected: [1] };
        }
        return defaultQuery(sql);
      };

      await provider.connect();
      const health = await provider.getHealth();

      expect(health.cacheHitRatio).toBe(CACHE_HIT_RATIO_UNAVAILABLE);
    });

    test("keeps a measured cache hit ratio of zero in the health string", async () => {
      mockQueryFn = async (sql: string) => {
        if (sql.toUpperCase().includes("SYS.DM_OS_PERFORMANCE_COUNTERS")) {
          return { recordset: [{ hit_ratio: 0 }], rowsAffected: [1] };
        }
        return defaultQuery(sql);
      };

      await provider.connect();
      const health = await provider.getHealth();

      expect(health.cacheHitRatio).toBe("0.0%");
      expect(health.cacheHitRatio).not.toBe(CACHE_HIT_RATIO_UNAVAILABLE);
    });
  });

  // =========================================================================
  // 9. runMaintenance()
  // =========================================================================

  describe("runMaintenance()", () => {
    test("analyze with target calls UPDATE STATISTICS", async () => {
      let capturedSql = "";
      mockQueryFn = async (sql: string) => {
        capturedSql = sql;
        return defaultQuery(sql);
      };

      await provider.connect();
      const result = await provider.runMaintenance("analyze", "users");

      expect(result.success).toBe(true);
      expect(capturedSql).toContain("UPDATE STATISTICS");
    });

    test("analyze without target calls sp_updatestats", async () => {
      let capturedSql = "";
      mockQueryFn = async (sql: string) => {
        capturedSql = sql;
        return defaultQuery(sql);
      };

      await provider.connect();
      const result = await provider.runMaintenance("analyze");

      expect(result.success).toBe(true);
      expect(capturedSql).toContain("sp_updatestats");
    });

    test("check calls DBCC CHECKDB", async () => {
      let capturedSql = "";
      mockQueryFn = async (sql: string) => {
        capturedSql = sql;
        return defaultQuery(sql);
      };

      await provider.connect();
      const result = await provider.runMaintenance("check");

      expect(result.success).toBe(true);
      expect(capturedSql).toContain("DBCC CHECKDB");
    });

    test("kill without target throws QueryError", async () => {
      await provider.connect();
      await expect(provider.runMaintenance("kill")).rejects.toThrow(QueryError);
    });

    test("unsupported maintenance type throws", async () => {
      await provider.connect();
      await expect(provider.runMaintenance("vacuum" as unknown as "analyze")).rejects.toThrow();
    });
  });

  // =========================================================================
  // 10. getPoolStats()
  // =========================================================================

  describe("getPoolStats()", () => {
    test("returns pool size, available, pending when connected", async () => {
      await provider.connect();
      const stats = provider.getPoolStats();

      expect(stats.total).toBe(10);
      expect(stats.idle).toBe(7);
      expect(stats.active).toBe(3);
      expect(stats.waiting).toBe(0);
    });

    test("returns zeros when not connected", () => {
      const stats = provider.getPoolStats();
      expect(stats.total).toBe(0);
      expect(stats.idle).toBe(0);
      expect(stats.active).toBe(0);
    });
  });

  // =========================================================================
  // 11. Transaction lifecycle
  // =========================================================================

  describe("transaction lifecycle", () => {
    test("begin/commit lifecycle works", async () => {
      await provider.connect();

      expect(provider.isInTransaction()).toBe(false);
      await provider.beginTransaction();
      expect(provider.isInTransaction()).toBe(true);

      const result = await provider.queryInTransaction("SELECT 1 AS test");
      expect(result.rows).toBeArray();

      await provider.commitTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });

    test("begin/rollback lifecycle works", async () => {
      await provider.connect();

      await provider.beginTransaction();
      expect(provider.isInTransaction()).toBe(true);

      await provider.rollbackTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });

    test("queryInTransaction binds positional parameters as p1..pN inputs", async () => {
      await provider.connect();
      await provider.beginTransaction();

      const result = await provider.queryInTransaction("SELECT * FROM users WHERE id = @p1", [7]);
      expect(result.rows).toBeArray();
      expect(capturedInputs).toEqual([{ name: "p1", value: 7 }]);

      await provider.rollbackTransaction();
    });
  });

  // =========================================================================
  // 12. cancelQuery()
  // =========================================================================

  describe("cancelQuery()", () => {
    test("unknown queryId returns false", async () => {
      await provider.connect();
      const cancelled = await provider.cancelQuery("non-existent-id");
      expect(cancelled).toBe(false);
    });

    test("cancels a tracked running request and returns true", async () => {
      await provider.connect();

      let release: (() => void) | undefined;
      mockQueryFn = () =>
        new Promise((resolve) => {
          release = () => resolve({ recordset: [], rowsAffected: [0] });
        });

      const pending = provider.query("SELECT * FROM slow_table", undefined, "qid-1");
      // Let the provider register the running request before cancelling
      await new Promise((r) => setTimeout(r, 0));

      const cancelled = await provider.cancelQuery("qid-1");
      expect(cancelled).toBe(true);

      release?.();
      await pending;

      // Request is deregistered after completion
      expect(await provider.cancelQuery("qid-1")).toBe(false);
    });

    test("returns false when the driver cancel throws", async () => {
      await provider.connect();

      cancelShouldThrow = true;
      let release: (() => void) | undefined;
      mockQueryFn = () =>
        new Promise((resolve) => {
          release = () => resolve({ recordset: [], rowsAffected: [0] });
        });

      const pending = provider.query("SELECT * FROM slow_table", undefined, "qid-2");
      await new Promise((r) => setTimeout(r, 0));

      const cancelled = await provider.cancelQuery("qid-2");
      expect(cancelled).toBe(false);

      release?.();
      await pending;
    });
  });

  // =========================================================================
  // 13. getOverview()
  // =========================================================================

  describe("getOverview()", () => {
    test("returns version, uptime, connections, size, counts", async () => {
      await provider.connect();
      const overview = await provider.getOverview();

      expect(typeof overview.version).toBe("string");
      expect(overview.version).toContain("Microsoft SQL Server");
      expect(typeof overview.uptime).toBe("string");
      expect(overview.uptime.length).toBeGreaterThan(0);
      expect(overview.activeConnections).toBe(5);
      expect(typeof overview.maxConnections).toBe("number");
      expect(typeof overview.databaseSize).toBe("string");
      expect(typeof overview.databaseSizeBytes).toBe("number");
      expect(typeof overview.tableCount).toBe("number");
      expect(typeof overview.indexCount).toBe("number");
    });

    test("a refused connections read leaves overview activeConnections absent, never a measured 0", async () => {
      // The getHealth() twin of this test has guarded the same figure since D17; the
      // identical defect survived here because `let activeConnections = 0` swallowed
      // this block's failure into a reading. Unlike that twin, the statement here
      // names two objects, and the fixture below refuses exactly one of them: the
      // `sys.configurations` ceiling subquery, which Microsoft documents as needing
      // only membership in `public` on SQL Server 2019 and earlier but
      // VIEW SERVER PERFORMANCE STATE on the server on 2022 and later (Permissions
      // section of sys.configurations, read 2026-08-27). So this reproduces the
      // 2022-and-later shape - one refused statement, one catch, count absent - and
      // speaks for those versions only. It says nothing about a login-wide loss: on
      // 2019 and earlier that arm needs no grant, and `sys.dm_exec_sessions` is
      // documented as row-filtered rather than refused ("Everyone can see their own
      // session information"), so an ungranted login there may instead SUCCEED with a
      // COUNT of its own session. That under-reading is neither measured nor caught -
      // see docs/providers/mssql.md section 7.2. The Msg 300 wording below is the
      // refusal measured 2026-08-23 on SQL Server 2022 CU26 against a login holding
      // nothing beyond CONNECT; nothing asserts on it, only that it throws.
      mockQueryFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("SYS.CONFIGURATIONS") && upper.includes("USER CONNECTIONS")) {
          throw new Error("VIEW SERVER PERFORMANCE STATE permission was denied on object 'server', database 'master'");
        }
        return defaultQuery(sql);
      };

      await provider.connect();
      const overview = await provider.getOverview();

      // Absent, so OverviewTab.tsx's Connections card renders "N/A" over "not
      // published" instead of a confident 0 with a "0% used" progress bar, and the
      // sample is dropped from the connection trend rather than plotted as a floor.
      expect("activeConnections" in overview).toBe(false);
      // maxConnections is a required number where 0 and absence are the SAME fact -
      // "no limit published" - so the refusal correctly leaves it 0. Pinned so the
      // absence above is not widened into this field by a later change.
      expect(overview.maxConnections).toBe(0);
      // Only the denied block goes absent; every other reading survives.
      expect(overview.version).toContain("Microsoft SQL Server");
      expect(overview.tableCount).toBe(5);
    });

    test("a server with no user sessions keeps its measured zero overview connections", async () => {
      // The anti-vacuity twin of the test above: absence must never be spelled with a
      // falsy test. An idle instance answers COUNT(*) = 0 and that 0 is a reading, so
      // the `Number(... || 0)` this replaces was destroying the very figure it
      // published - it could not tell an idle server from a denied DMV.
      mockQueryFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("SYS.CONFIGURATIONS") && upper.includes("USER CONNECTIONS")) {
          return { recordset: [{ active_connections: 0, max_connections: 32767 }], rowsAffected: [1] };
        }
        return defaultQuery(sql);
      };

      await provider.connect();
      const overview = await provider.getOverview();

      expect("activeConnections" in overview).toBe(true);
      expect(overview.activeConnections).toBe(0);
      expect(overview.maxConnections).toBe(32767);
    });

    test("Azure SQL detection from hostname", () => {
      const azureProvider = new MSSQLProvider({
        ...baseConfig,
        host: "myserver.database.windows.net",
      });
      // Azure host should not throw; the buildConfig should detect it
      expect(azureProvider).toBeDefined();
    });
  });

  // =========================================================================
  // 14. getPerformanceMetrics()
  // =========================================================================

  describe("getPerformanceMetrics()", () => {
    test("returns cache hit ratio and deadlocks", async () => {
      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      expect(metrics.cacheHitRatio).toBe(99.5);
      // No longer a second copy of the cache hit ratio under another name.
      expect("bufferPoolUsage" in metrics).toBe(false);
    });

    test("reports nothing when the DMV is not readable, rather than a perfect cache", async () => {
      // Measured 2026-08-23 on SQL Server 2022 CU26 against a login with no
      // server-level grant beyond CONNECT:
      //   Msg 300, Level 14, State 1 ... VIEW SERVER PERFORMANCE STATE permission
      //   was denied on object 'server', database 'master'.
      mockQueryFn = async (sql: string) => {
        if (sql.toUpperCase().includes("SYS.DM_OS_PERFORMANCE_COUNTERS")) {
          throw new Error("VIEW SERVER PERFORMANCE STATE permission was denied on object 'server'");
        }
        return defaultQuery(sql);
      };

      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      expect("cacheHitRatio" in metrics).toBe(false);
      expect(metrics).toEqual({});
    });

    test("omits the ratio when the counter base is zero and the DMV answers NULL", async () => {
      // Measured 2026-08-23 on SQL Server 2022 CU26 by forcing the NULLIF branch:
      //   hit_ratio
      //   ---------
      //        NULL
      mockQueryFn = async (sql: string) => {
        if (sql.toUpperCase().includes("SYS.DM_OS_PERFORMANCE_COUNTERS")) {
          return { recordset: [{ hit_ratio: null }], rowsAffected: [1] };
        }
        return defaultQuery(sql);
      };

      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      expect("cacheHitRatio" in metrics).toBe(false);
    });

    test("keeps a measured ratio of zero", async () => {
      mockQueryFn = async (sql: string) => {
        if (sql.toUpperCase().includes("SYS.DM_OS_PERFORMANCE_COUNTERS")) {
          return { recordset: [{ hit_ratio: 0 }], rowsAffected: [1] };
        }
        return defaultQuery(sql);
      };

      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      expect(metrics.cacheHitRatio).toBe(0);
    });
  });

  // =========================================================================
  // 15. getSlowQueries()
  // =========================================================================

  describe("getSlowQueries()", () => {
    test("returns from dm_exec_query_stats", async () => {
      await provider.connect();
      const slowQueries = await provider.getSlowQueries();

      expect(Array.isArray(slowQueries)).toBe(true);
      expect(slowQueries.length).toBeGreaterThan(0);

      const first = slowQueries[0];
      expect(typeof first.query).toBe("string");
      expect(typeof first.calls).toBe("number");
      expect(first.calls).toBe(100);
      expect(typeof first.totalTime).toBe("number");
      expect(typeof first.avgTime).toBe("number");
      expect(typeof first.rows).toBe("number");
      expect(typeof first.queryId).toBe("string");
    });
  });

  // =========================================================================
  // 16. getActiveSessions()
  // =========================================================================

  describe("getActiveSessions()", () => {
    test("returns sessions from dm_exec_sessions", async () => {
      await provider.connect();
      const sessions = await provider.getActiveSessions();

      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThan(0);

      const first = sessions[0];
      expect(typeof first.pid).toBe("number");
      expect(typeof first.user).toBe("string");
      expect(typeof first.database).toBe("string");
      expect(typeof first.state).toBe("string");
      expect(typeof first.query).toBe("string");
      expect(typeof first.duration).toBe("string");
      expect(typeof first.durationMs).toBe("number");
    });
  });

  // =========================================================================
  // 17. getTableStats()
  // =========================================================================

  describe("getTableStats()", () => {
    test("returns table sizes and row counts", async () => {
      await provider.connect();
      const stats = await provider.getTableStats();

      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBeGreaterThan(0);

      const first = stats[0];
      expect(typeof first.schemaName).toBe("string");
      expect(typeof first.tableName).toBe("string");
      expect(typeof first.rowCount).toBe("number");
      expect(typeof first.tableSize).toBe("string");
      expect(typeof first.tableSizeBytes).toBe("number");
      expect(typeof first.indexSize).toBe("string");
      expect(typeof first.totalSize).toBe("string");
      expect(typeof first.totalSizeBytes).toBe("number");
    });
  });

  // =========================================================================
  // 18. getIndexStats()
  // =========================================================================

  describe("getIndexStats()", () => {
    test("returns index usage stats", async () => {
      await provider.connect();
      const stats = await provider.getIndexStats();

      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBeGreaterThan(0);

      const first = stats[0];
      expect(typeof first.schemaName).toBe("string");
      expect(typeof first.tableName).toBe("string");
      expect(typeof first.indexName).toBe("string");
      expect(typeof first.indexType).toBe("string");
      expect(Array.isArray(first.columns)).toBe(true);
      expect(typeof first.isUnique).toBe("boolean");
      expect(typeof first.isPrimary).toBe("boolean");
      expect(typeof first.indexSize).toBe("string");
      expect(typeof first.indexSizeBytes).toBe("number");
      expect(typeof first.scans).toBe("number");
    });
  });

  // =========================================================================
  // 19. getStorageStats()
  // =========================================================================

  describe("getStorageStats()", () => {
    test("returns database file info", async () => {
      await provider.connect();
      const stats = await provider.getStorageStats();

      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBeGreaterThan(0);

      const first = stats[0];
      expect(typeof first.name).toBe("string");
      expect(typeof first.location).toBe("string");
      expect(typeof first.size).toBe("string");
      expect(typeof first.sizeBytes).toBe("number");
      expect(first.sizeBytes).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 20. Error mapping
  // =========================================================================

  describe("error mapping", () => {
    test("Login failed maps to auth error", async () => {
      // Connect first with default mock, then swap to error mock
      await provider.connect();

      mockQueryFn = async () => {
        throw new Error('Login failed for user "sa"');
      };

      try {
        await provider.query("SELECT 1");
        expect(true).toBe(false); // Should not reach here
      } catch (error: unknown) {
        expect(error).toBeDefined();
        const err = error as Error;
        expect(err.name).toBe("AuthenticationError");
        expect(err.message).toContain("Authentication failed");
      }
    });

    test("Cannot open database maps to config error", async () => {
      // Connect first with default mock, then swap to error mock
      await provider.connect();

      mockQueryFn = async () => {
        throw new Error('Cannot open database "baddb" requested by the login');
      };

      try {
        await provider.query("SELECT 1");
        expect(true).toBe(false); // Should not reach here
      } catch (error: unknown) {
        expect(error).toBeDefined();
        const err = error as Error;
        expect(err.name).toBe("ConnectionError");
        expect(err.message).toContain("Database not found");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Declared column types
// ---------------------------------------------------------------------------

/**
 * `mssql` attaches a `columns` map to the recordset ARRAY, and each entry's `type`
 * carries `declaration` - T-SQL's own lowercase spelling, the same word
 * `INFORMATION_SCHEMA.COLUMNS.DATA_TYPE` uses. The declarations below are verbatim
 * from SQL Server 2022 CU26 over `types`.
 *
 * `type` is a factory FUNCTION for some of the driver's types and a plain object for
 * others, so both forms appear here.
 */
describe("MSSQLProvider declared column types", () => {
  let provider: MSSQLProvider;

  /** A recordset the way `mssql` builds one: an array with a `columns` map on it. */
  function withColumns(
    rows: Record<string, unknown>[],
    columns: Record<string, { declaration: string } | (() => unknown)>,
  ) {
    const recordset = rows as Record<string, unknown>[] & { columns: unknown };
    recordset.columns = Object.fromEntries(Object.entries(columns).map(([name, type]) => [name, { name, type }]));
    return recordset;
  }

  beforeEach(() => {
    capturedInputs = [];
    cancelShouldThrow = false;
    provider = new MSSQLProvider(baseConfig);
  });

  afterEach(async () => {
    try {
      await provider.disconnect();
    } catch {
      /* ignore */
    }
  });

  test("query() reports the declaration each column metadata carries", async () => {
    const nvarcharFactory = Object.assign(() => ({}), { declaration: "nvarchar" });
    mockQueryFn = async () => ({
      recordset: withColumns([{ id: "19", price: "19.99", dt: new Date(), name: "x" }], {
        id: { declaration: "bigint" },
        price: { declaration: "decimal" },
        dt: { declaration: "datetime2" },
        name: nvarcharFactory,
      }),
      rowsAffected: [1],
    });

    await provider.connect();
    const result = await provider.query("SELECT id, price, dt, name FROM types");

    // `id` and `price` both arrive as STRINGS from tedious - which is exactly why the
    // value-shaped guess called them NVARCHAR(MAX) and FLOAT before this.
    expect(result.columnTypes).toEqual({
      id: "bigint",
      price: "decimal",
      dt: "datetime2",
      name: "nvarchar",
    });
  });

  test("the key is omitted entirely when the recordset carries no column map", async () => {
    mockQueryFn = async () => ({ recordset: [{ a: 1 }], rowsAffected: [1] });

    await provider.connect();
    const result = await provider.query("SELECT 1 AS a");

    expect(result.columnTypes).toBeUndefined();
    expect(Object.hasOwn(result, "columnTypes")).toBe(false);
  });

  test("queryInTransaction() declares them too, from the same column map", async () => {
    // Measured against a live server: a request made on a Transaction DOES carry
    // `recordset.columns`, including for a zero-row result - this path had simply
    // never read it.
    mockQueryFn = async () => ({
      recordset: withColumns([], { u: { declaration: "uniqueidentifier" } }),
      rowsAffected: [0],
    });

    await provider.connect();
    await provider.beginTransaction();
    const result = await provider.queryInTransaction("SELECT u FROM types WHERE 1 = 0");

    expect(result.columnTypes).toEqual({ u: "uniqueidentifier" });
    await provider.rollbackTransaction();
  });
});
