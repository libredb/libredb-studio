import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";

// ---------------------------------------------------------------------------
// Mock mssql BEFORE importing the provider
// ---------------------------------------------------------------------------

/**
 * The statement, plus the parameters the request bound for it.
 *
 * The second argument arrived with the object surface (#789), whose reads bind `@schema`
 * and `@name`: a dispatcher that only ever sees the statement text cannot tell
 * `countObjects(["db"])` from `countObjects(["db", "app"])`, because the difference is the
 * bind and not the text. Every handler written before it takes one argument and is
 * unaffected.
 */
let mockQueryFn: (sql: string, inputs?: Record<string, unknown>) => Promise<unknown>;
let capturedInputs: Array<{ name: string; value: unknown }> = [];
let cancelShouldThrow = false;
/** The pool handed to the most recently constructed provider. */
let lastPool: EventEmitter | undefined;

class MockRequest {
  private _transaction: unknown;
  /** What THIS request bound, as `mssql` hands it to the driver. */
  private readonly inputs: Record<string, unknown> = {};

  constructor(transaction?: unknown) {
    this._transaction = transaction;
  }

  input(name: string, val: unknown) {
    capturedInputs.push({ name, value: val });
    this.inputs[name] = val;
    return this;
  }

  async query(sql: string) {
    return mockQueryFn(sql, this.inputs);
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
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
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
      // The mssql Transaction object over one held pool connection (#464).
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

    test("a refused size read leaves overview databaseSizeBytes absent, never a measured 0", async () => {
      // The same defect as the connections pair above, one field over, and it survived
      // #515 because that round only moved the count: `let databaseSizeBytes = 0` plus an
      // empty catch turned any failure of the size statement into a reading.
      // Deliberately NOT given a permission-refusal shape like §7.2's. `sys.database_files`
      // is a database-scoped catalog view, not one of the server-scoped DMVs that section
      // measured a `Msg 300` against, and no failure of this statement has been measured on
      // a live instance - the request timeout of §3.5 firing, a pool fault mid-overview and
      // a deployment without the view all arrive here identically. That is the whole point:
      // the `catch` cannot tell one cause from another, so it must not publish a figure for
      // any of them. The error below therefore asserts nothing beyond "the statement threw".
      mockQueryFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("SYS.DATABASE_FILES")) {
          throw new Error("Timeout: Request failed to complete in 15000ms");
        }
        return defaultQuery(sql);
      };

      await provider.connect();
      const overview = await provider.getOverview();

      // Absent, so StorageTab.tsx's `sizeKnown` is false and the tab says "No storage
      // size information available" instead of drawing a breakdown over a database it
      // never measured, against per-table bytes that a separate read did answer for.
      expect("databaseSizeBytes" in overview).toBe(false);
      // The formatted string travels with the figure, as it does in the merged libSQL
      // (#569) and search (#517) shapes: "0 bytes" beside an absent byte count would
      // print a confident zero as the headline size on that same tab.
      expect(overview.databaseSize).toBe("N/A");
      // Only the refused statement goes absent; every other reading survives.
      expect(overview.activeConnections).toBe(5);
      expect(overview.tableCount).toBe(5);
    });

    test("a database that measures zero bytes keeps its measured zero size", async () => {
      // The anti-vacuity twin of the test above: absence must never be spelled with a
      // falsy test. `SUM(CAST(size AS BIGINT))` returns NULL when the aggregate has no
      // row to sum. The provider deliberately treats that returned null aggregate as
      // a measured zero, so the key stays present and the Storage tab formats the zero it was
      // given rather than claiming it knows nothing.
      mockQueryFn = async (sql: string) => {
        const upper = sql.toUpperCase();
        if (upper.includes("SYS.DATABASE_FILES")) {
          return { recordset: [{ size_bytes: null }], rowsAffected: [1] };
        }
        return defaultQuery(sql);
      };

      await provider.connect();
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(true);
      expect(overview.databaseSizeBytes).toBe(0);
      expect(overview.databaseSize).toBe("0 B");
    });

    test("a size read with no result row leaves overview size absent", async () => {
      mockQueryFn = async (sql: string) => {
        if (sql.toUpperCase().includes("SYS.DATABASE_FILES")) {
          return { recordset: [], rowsAffected: [0] };
        }
        return defaultQuery(sql);
      };

      await provider.connect();
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(false);
      expect(overview.databaseSize).toBe("N/A");
    });

    test("a size result without the expected column leaves overview size absent", async () => {
      mockQueryFn = async (sql: string) => {
        if (sql.toUpperCase().includes("SYS.DATABASE_FILES")) {
          return { recordset: [{ unrelated: 1 }], rowsAffected: [1] };
        }
        return defaultQuery(sql);
      };

      await provider.connect();
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(false);
      expect(overview.databaseSize).toBe("N/A");
    });

    test("a non-finite size leaves overview size absent", async () => {
      mockQueryFn = async (sql: string) => {
        if (sql.toUpperCase().includes("SYS.DATABASE_FILES")) {
          return { recordset: [{ size_bytes: Number.POSITIVE_INFINITY }], rowsAffected: [1] };
        }
        return defaultQuery(sql);
      };

      await provider.connect();
      const overview = await provider.getOverview();

      expect("databaseSizeBytes" in overview).toBe(false);
      expect(overview.databaseSize).toBe("N/A");
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

// ---------------------------------------------------------------------------
// The object surface (#789)
// ---------------------------------------------------------------------------

/**
 * Which object-surface read a statement is, from the one fragment unique to it.
 *
 * ORDER MATTERS and it is not alphabetical: the counts statement names `sys.objects` AND
 * `sys.triggers`, the trigger listing outer-joins `sys.objects`, and the primary-key and
 * index reads both join `sys.columns`. Resolving that overlap once here is what lets each
 * fixture below answer per READ rather than per statement text.
 *
 * The default THROWS. A dispatcher that answered a generic recordset for a statement
 * nobody anticipated would let a wrong read pass for a right one, which is how two mocked
 * fixtures in this file went dead before (see the `sys.configurations` note above).
 */
function objectRead(sql: string): string {
  const upper = sql.toUpperCase();
  // The bulk column read's five statements first: each carries the `described` CTE, and
  // each would otherwise match one of the single-object reads below.
  if (upper.includes("WITH DESCRIBED AS")) {
    if (upper.includes("IS_PRIMARY_KEY = 1")) return "bulk-pk";
    if (upper.includes("SYS.FOREIGN_KEYS")) return "bulk-fks";
    if (upper.includes("IS_PRIMARY_KEY = 0")) return "bulk-indexes";
    if (upper.includes("SYS.COLUMNS")) return "bulk-columns";
    return "bulk-target";
  }
  // The FLAT reading's five statements, after the bulk block and before the single-object
  // arms (#789). Each of them collides with one of the
  // object-surface arms below - `SCHEMA_TABLES_SQL` reaches `sys.partitions`,
  // `SCHEMA_PRIMARY_KEYS_SQL` reaches `is_primary_key = 1`, `SCHEMA_INDEXES_SQL` reaches
  // `is_primary_key = 0` - and answering one with the other's recordset is what made
  // `getSchema()` throw through `mapDatabaseError` here rather than answer.
  if (upper.includes("SUM(P.ROWS) AS ROW_COUNT") && upper.includes("GROUP BY S.NAME, T.NAME")) return "flat-tables";
  if (upper.includes("FROM INFORMATION_SCHEMA.COLUMNS")) return "flat-columns";
  if (upper.includes("WHERE I.IS_PRIMARY_KEY = 1") && upper.includes("T.NAME AS TABLE_NAME")) return "flat-pk";
  if (upper.includes("OBJECT_SCHEMA_NAME(FK.PARENT_OBJECT_ID)")) return "flat-fks";
  if (upper.includes("I.IS_PRIMARY_KEY = 0") && upper.includes("IC.KEY_ORDINAL")) return "flat-indexes";
  if (upper.includes("SYS.DATABASES")) return "databases";
  if (upper.includes("SYS.DATABASE_PRINCIPALS")) return "schemas";
  if (upper.includes("GROUP BY KIND")) return "counts";
  if (upper.includes("SYS.TRIGGERS")) return "triggers";
  if (upper.includes("SYS.PARTITIONS")) return "tables";
  if (upper.includes("IS_PRIMARY_KEY = 1")) return "pk";
  if (upper.includes("SYS.FOREIGN_KEYS")) return "fks";
  if (upper.includes("IS_PRIMARY_KEY = 0")) return "indexes";
  if (upper.includes("SYS.COLUMNS")) return "columns";
  if (upper.includes("SYS.OBJECTS")) return "objects";
  throw new Error(`the object-surface mock was handed a statement it does not know: ${sql}`);
}

/**
 * The seeded fixture, as the recordsets each read answers.
 *
 * Every row here was MEASURED against `docker/mssql-init/01-object-fixture.sql` on SQL
 * Server 2022 CU26 (16.0.4265.3), and the trigger rows are what that fixture exists for:
 * `sys.objects` holds 2 triggers there and `sys.triggers` holds 4, because a
 * DATABASE-scoped DDL trigger is absent from `sys.objects` entirely.
 */
const FIXTURE_DATABASES = [
  { name: "libredb_objects", is_session_default: 1 },
  { name: "libredb_objects_two", is_session_default: 0 },
  { name: "master", is_session_default: 0 },
  { name: "model", is_session_default: 0 },
  { name: "msdb", is_session_default: 0 },
  { name: "tempdb", is_session_default: 0 },
];

/** The whole database, then one schema. Two different answers, which is the point. */
const FIXTURE_COUNTS: Record<string, Array<{ kind: string; n: number }>> = {
  "": [
    { kind: "table", n: 5 },
    { kind: "view", n: 1 },
    { kind: "procedure", n: 1 },
    { kind: "function", n: 3 },
    { kind: "trigger", n: 4 },
    { kind: "synonym", n: 1 },
    { kind: "sequence", n: 1 },
  ],
  app: [
    { kind: "table", n: 4 },
    { kind: "view", n: 1 },
    { kind: "procedure", n: 1 },
    { kind: "function", n: 3 },
    { kind: "trigger", n: 1 },
    { kind: "synonym", n: 1 },
    { kind: "sequence", n: 1 },
  ],
  reporting: [
    { kind: "table", n: 1 },
    { kind: "trigger", n: 1 },
  ],
};

const FIXTURE_TABLES = [
  { schema_name: "app", name: "customers", row_count: 0 },
  // Both halves of a SYSTEM-VERSIONED temporal pair, which is standing ruling 5a's check on
  // this engine: each is `sys.objects.type = 'U'` with `temporal_type` beside it, so neither
  // can fall out of a vocabulary derived from the documented type set.
  { schema_name: "app", name: "order_audit", row_count: 0 },
  { schema_name: "app", name: "order_audit_history", row_count: 0 },
  { schema_name: "app", name: "orders", row_count: 0 },
  { schema_name: "reporting", name: "daily", row_count: 0 },
];

const FIXTURE_VIEWS = [{ schema_name: "app", name: "order_summary" }];

const FIXTURE_TRIGGERS = [
  { name: "ddl_audit", parent_schema: null, parent_name: null, is_disabled: false },
  { name: "orders", parent_schema: null, parent_name: null, is_disabled: false },
  { name: "stamp_order", parent_schema: "app", parent_name: "orders", is_disabled: false },
  { name: "stamp_order", parent_schema: "reporting", parent_name: "daily", is_disabled: true },
];

const FIXTURE_COLUMNS: Record<string, Array<Record<string, unknown>>> = {
  orders: [
    { name: "id", data_type: "int", is_nullable: false, default_definition: null },
    { name: "customer_id", data_type: "int", is_nullable: true, default_definition: null },
    { name: "total", data_type: "decimal", is_nullable: true, default_definition: "((0))" },
    { name: "note", data_type: "nvarchar", is_nullable: true, default_definition: null },
  ],
  daily: [
    { name: "day", data_type: "date", is_nullable: false, default_definition: null },
    { name: "orders", data_type: "int", is_nullable: true, default_definition: null },
    { name: "customer_id", data_type: "int", is_nullable: true, default_definition: null },
  ],
};

/**
 * One recordset per read, filtered by the SCHEMA the request bound.
 *
 * The filter is not decoration. Without it the schema-level container and the
 * database-level one answer the same rows, so a listing that ignored `@schema` entirely
 * would pass - and the test would be pinning the wrong behaviour rather than measuring
 * the right one.
 */
/**
 * The target set of a bulk read, in the order SQL Server returns it.
 *
 * `ORDER BY s.name, o.name` runs under the DATABASE's collation, which is
 * SQL_Latin1_General_CP1_CI_AS on the fixture server (measured), and this array is that
 * answer. Each row carries the `object_id` the five statements group on, because a name is
 * a string a caller can spell and an object id is the engine's own key.
 */
const FIXTURE_BULK_TARGET: Record<string, Array<{ object_id: number; schema_name: string; name: string }>> = {
  table: [
    { object_id: 1, schema_name: "app", name: "customers" },
    { object_id: 2, schema_name: "app", name: "order_audit" },
    { object_id: 3, schema_name: "app", name: "order_audit_history" },
    { object_id: 4, schema_name: "app", name: "orders" },
    { object_id: 5, schema_name: "reporting", name: "daily" },
  ],
  view: [{ object_id: 6, schema_name: "app", name: "order_summary" }],
};

/** Which kind a bulk statement is about, read off the type list it interpolated. */
function bulkKind(sql: string): string {
  return sql.includes("o.type IN ('U')") ? "table" : "view";
}

/** The target rows one bulk statement covers, filtered by schema and cut by TOP. */
function bulkTarget(sql: string, inputs: Record<string, unknown>) {
  const schema = sql.includes("@schema") ? (inputs.schema as string | undefined) : undefined;
  const rows = FIXTURE_BULK_TARGET[bulkKind(sql)].filter((row) => schema === undefined || row.schema_name === schema);
  const limit = sql.includes("TOP (@limit)") ? Number(inputs.limit) : undefined;
  return limit === undefined ? rows : rows.slice(0, limit);
}

/**
 * `libredb_objects_two`'s own objects, and the four system databases hold NONE.
 *
 * The double answered one set of rows whatever database the statement was three-part named
 * at, which is a fixture that cannot tell a provider reading the connected database from
 * one reading the catalog it was asked for. The conformance guard resolves a flat name
 * against every container `listContainers` answered (#789), so it now lists objects in each
 * of the six databases, and six identical `app.customers` rows made the join ambiguous on a
 * provider that is correct.
 *
 * The rows are the seeded fixture's: `docker/mssql-init/01-object-fixture.sql` creates
 * `warehouse.stock` and `db_owner.audit_log` in the second database and nothing else, and
 * `master`, `model`, `msdb` and `tempdb` hold only Microsoft's own objects, which every one
 * of these statements excludes with `is_ms_shipped = 0`.
 */
const FIXTURE_TABLES_TWO = [
  { schema_name: "db_owner", name: "audit_log", row_count: 0 },
  { schema_name: "warehouse", name: "stock", row_count: 0 },
];

/** Which database a statement is three-part named at, read off the statement itself. */
function fixtureDatabase(sql: string): string {
  return /\[([^\]]+)\]\.(?:sys|INFORMATION_SCHEMA)\./.exec(sql)?.[1] ?? "libredb_objects";
}

function fixtureRead(read: string, inputs: Record<string, unknown>, sql: string): unknown {
  const database = fixtureDatabase(sql);
  const tablesOf = (): typeof FIXTURE_TABLES =>
    database === "libredb_objects" ? FIXTURE_TABLES : database === "libredb_objects_two" ? FIXTURE_TABLES_TWO : [];
  const viewsOf = (): typeof FIXTURE_VIEWS => (database === "libredb_objects" ? FIXTURE_VIEWS : []);
  const triggersOf = (): typeof FIXTURE_TRIGGERS => (database === "libredb_objects" ? FIXTURE_TRIGGERS : []);
  // The SERVER filters, not the bind. A statement that binds `@schema` and never mentions
  // it returns every row, so the filter is read off the STATEMENT here and not off the
  // parameter - mutation M11b is what found that: with the filter taken from `inputs`
  // alone, a trigger listing that had lost its WHERE clause entirely still answered one
  // schema's rows and the suite stayed green. The counts statement filters its two arms
  // separately and one canned recordset cannot express half a filter, so the per-arm
  // clauses are pinned by the assertions on the statement text instead.
  const schema = sql.includes("@schema") ? (inputs.schema as string | undefined) : undefined;
  const inSchema = <T extends { schema_name: string }>(rows: readonly T[]) =>
    rows.filter((row) => schema === undefined || row.schema_name === schema);

  switch (read) {
    case "databases":
      return { recordset: FIXTURE_DATABASES, rowsAffected: [FIXTURE_DATABASES.length] };
    case "schemas": {
      // `SCHEMA_NAME()` and `DB_NAME()` are evaluated in the CONNECTED database whichever
      // catalog the statement is three-part named at, which is why the provider carries
      // `connected_database` back rather than interpolating a name to compare in SQL. The
      // fixture's login is `sa`, whose default schema is `dbo`.
      const rows = [
        { name: "app", is_session_schema: 0, connected_database: "libredb_objects" },
        { name: "dbo", is_session_schema: 1, connected_database: "libredb_objects" },
        { name: "reporting", is_session_schema: 0, connected_database: "libredb_objects" },
      ];
      return { recordset: rows, rowsAffected: [rows.length] };
    }
    case "counts": {
      const rows = FIXTURE_COUNTS[schema ?? ""];
      return { recordset: rows, rowsAffected: [rows.length] };
    }
    case "triggers": {
      const rows = triggersOf().filter((row) => schema === undefined || row.parent_schema === schema);
      return { recordset: rows, rowsAffected: [rows.length] };
    }
    case "tables":
      return { recordset: inSchema(tablesOf()), rowsAffected: [inSchema(tablesOf()).length] };
    case "objects":
      return { recordset: inSchema(viewsOf()), rowsAffected: [inSchema(viewsOf()).length] };
    case "columns": {
      // Keyed on the NAME the provider bound, so a read that bound the schema segment
      // instead answers nothing - which is exactly what the last-segment pin needs.
      const rows = FIXTURE_COLUMNS[(inputs.name as string) ?? ""] ?? [];
      return { recordset: rows, rowsAffected: [rows.length] };
    }
    case "bulk-target": {
      const rows = bulkTarget(sql, inputs);
      return { recordset: rows, rowsAffected: [rows.length] };
    }
    case "bulk-columns": {
      // Only two of the fixture's objects have column rows here, which is deliberate: an
      // object the detail reads answer nothing for must still come back, with three empty
      // lists rather than missing.
      const rows = bulkTarget(sql, inputs).flatMap((target) =>
        (FIXTURE_COLUMNS[target.name] ?? []).map((column) => ({ object_id: target.object_id, ...column })),
      );
      return { recordset: rows, rowsAffected: [rows.length] };
    }
    case "bulk-pk": {
      const rows = bulkTarget(sql, inputs)
        .filter((target) => FIXTURE_COLUMNS[target.name] !== undefined)
        .map((target) => ({ object_id: target.object_id, name: "id" }));
      return { recordset: rows, rowsAffected: [rows.length] };
    }
    case "bulk-fks": {
      const rows = bulkTarget(sql, inputs)
        .filter((target) => FIXTURE_COLUMNS[target.name] !== undefined)
        .map((target) => ({
          object_id: target.object_id,
          column_name: "customer_id",
          ref_schema: "app",
          ref_table: "customers",
          ref_column: "id",
        }));
      return { recordset: rows, rowsAffected: [rows.length] };
    }
    case "bulk-indexes": {
      const rows = bulkTarget(sql, inputs)
        .filter((target) => target.name === "orders")
        .map((target) => ({
          object_id: target.object_id,
          index_name: "app_orders_total_ix",
          is_unique: false,
          column_name: "total",
        }));
      return { recordset: rows, rowsAffected: [rows.length] };
    }
    // The FLAT reading, over the SAME objects the object surface lists (#789).
    //
    // The guard inside `assertObjectSurface` joins `getSchema()`'s names to the object
    // paths with the app's own rule, and it had nothing to join: these five statements were
    // misrouted into the object-surface arms above, whose recordsets carry different column
    // names, so the read threw through `mapDatabaseError` instead of answering.
    //
    // The rows are the DRIVER'S rows and the naming is left to `mssql.ts`, which spells a
    // name `schema.table` and strips `dbo` (`mssql.ts:1798`). A fixture that returned
    // finished names would assert its own spelling rather than the engine's.
    //
    // DISCLOSED: the `dbo` strip is not exercised, and inventing a row for it would be
    // worse than leaving it. `docker/mssql-init/01-object-fixture.sql` creates `app`,
    // `reporting`, `warehouse` and `db_owner` and no user table in `dbo`, so a `dbo` row
    // here would be a row the seeded fixture does not hold, and standing ruling 5i makes
    // that fixture the deliverable. `SCHEMA_TABLES_SQL` also reads `sys.tables` alone, so
    // the view `app.order_summary` is correctly absent from the flat reading while the
    // object surface lists it: the join has to survive a flat reading NARROWER than the
    // listing, and that asymmetry is real on this engine rather than arranged here.
    case "flat-tables":
      return {
        recordset: FIXTURE_TABLES.map((table) => ({
          schema_name: table.schema_name,
          table_name: table.name,
          row_count: table.row_count,
        })),
        rowsAffected: [FIXTURE_TABLES.length],
      };
    case "flat-columns": {
      const rows = FIXTURE_TABLES.flatMap((table) =>
        (FIXTURE_COLUMNS[table.name] ?? []).map((column, index) => ({
          TABLE_SCHEMA: table.schema_name,
          TABLE_NAME: table.name,
          COLUMN_NAME: column.name,
          DATA_TYPE: column.data_type,
          IS_NULLABLE: column.is_nullable === true ? "YES" : "NO",
          COLUMN_DEFAULT: column.default_definition,
          ORDINAL_POSITION: index + 1,
        })),
      );
      return { recordset: rows, rowsAffected: [rows.length] };
    }
    case "flat-pk": {
      const rows = FIXTURE_TABLES.filter((table) => FIXTURE_COLUMNS[table.name] !== undefined).map((table) => ({
        schema_name: table.schema_name,
        table_name: table.name,
        column_name: "id",
      }));
      return { recordset: rows, rowsAffected: [rows.length] };
    }
    case "flat-fks": {
      const rows = FIXTURE_TABLES.filter((table) => FIXTURE_COLUMNS[table.name] !== undefined).map((table) => ({
        schema_name: table.schema_name,
        table_name: table.name,
        column_name: "customer_id",
        ref_table: "customers",
        ref_column: "id",
      }));
      return { recordset: rows, rowsAffected: [rows.length] };
    }
    case "flat-indexes":
      return {
        recordset: [
          {
            schema_name: "app",
            table_name: "orders",
            index_name: "app_orders_total_ix",
            is_unique: false,
            column_name: "total",
            key_ordinal: 1,
          },
        ],
        rowsAffected: [1],
      };
    case "pk":
      return { recordset: [{ name: "id" }], rowsAffected: [1] };
    case "fks":
      // ONE row for both objects, deliberately: the referenced table is `app.customers`
      // either way and it is the READING object's schema that differs, which is what
      // decides whether the name comes back qualified. Both fixture tables really do carry
      // this key - app.orders inside `app`, reporting.daily across the boundary.
      return {
        recordset: [{ column_name: "customer_id", ref_schema: "app", ref_table: "customers", ref_column: "id" }],
        rowsAffected: [1],
      };
    case "indexes":
      return {
        recordset: [{ index_name: "app_orders_total_ix", is_unique: false, column_name: "total" }],
        rowsAffected: [1],
      };
    default:
      throw new Error(`the object-surface fixture has no rows for the read "${read}"`);
  }
}

/** Every statement one provider issued, in order, with the parameters it bound. */
let issued: Array<{ sql: string; inputs: Record<string, unknown> }> = [];

function installObjectFixture(): void {
  issued = [];
  capturedInputs = [];
  mockQueryFn = async (sql: string, inputs: Record<string, unknown> = {}) => {
    issued.push({ sql, inputs });
    if (sql.toUpperCase().includes("SELECT 1 AS TEST")) return { recordset: [{ test: 1 }], rowsAffected: [1] };
    return fixtureRead(objectRead(sql), inputs, sql);
  };
}

/**
 * A connected provider whose configured database is the fixture's, built locally rather
 * than shared with the blocks above: these tests install their own `mockQueryFn` before
 * connecting, and none of them wants a shared `afterEach` disconnecting a handle it does
 * not hold.
 */
async function connectedForObjects(overrides: Partial<DatabaseConnection> = {}): Promise<MSSQLProvider> {
  const provider = new MSSQLProvider({ ...baseConfig, database: "libredb_objects", ...overrides });
  await provider.connect();
  return provider;
}

describe("object surface", () => {
  beforeEach(installObjectFixture);

  test("declares the kinds SQL Server has, at two container levels", () => {
    const capabilities = new MSSQLProvider({ ...baseConfig, database: "libredb_objects" }).getCapabilities();
    const kinds = capabilities.objectKinds ?? [];

    expect(kinds.map((kind) => kind.id).sort()).toEqual([
      "function",
      "procedure",
      "sequence",
      "synonym",
      "table",
      "trigger",
      "view",
    ]);
    expect(kinds.find((kind) => kind.id === "table")?.acceptsRowWrites).toBe(true);
    // No `acceptsRowWrites` on a view: SQL Server takes an UPDATE against a
    // single-table view and refuses it against the rest, which is a per-OBJECT fact this
    // per-kind declaration cannot state.
    expect(kinds.find((kind) => kind.id === "view")?.acceptsRowWrites).toBeUndefined();
    expect(kinds.find((kind) => kind.id === "trigger")?.attachedTo).toBe("table");
    expect(kinds.find((kind) => kind.id === "procedure")?.role).toBe("routine");
    expect(kinds.find((kind) => kind.id === "function")?.role).toBe("routine");
    // No `index` kind: on SQL Server an index is an attribute of the table it is on -
    // sys.indexes is keyed by object_id and an index cannot exist without one - so it
    // belongs in describeObject's output rather than in a folder of its own.
    expect(kinds.find((kind) => kind.id === "index")).toBeUndefined();
    // TWO levels. Every engine in #789 before this one declared at most one.
    expect(capabilities.containerLevels).toEqual([
      { id: "catalog", label: "Database", labelPlural: "Databases" },
      { id: "schema", label: "Schema", labelPlural: "Schemas" },
    ]);
  });

  test("the top level is databases, and a nested list reads the CALLER's catalog", async () => {
    const provider = await connectedForObjects();

    const databases = await provider.listContainers();
    expect(databases.map((container) => container.path)).toEqual([
      ["libredb_objects"],
      ["libredb_objects_two"],
      ["master"],
      ["model"],
      ["msdb"],
      ["tempdb"],
    ]);
    expect(databases.every((container) => container.level === 0)).toBe(true);
    expect(databases.find((container) => container.name === "libredb_objects")?.isSessionDefault).toBe(true);
    expect(databases.find((container) => container.name === "master")?.isSessionDefault).toBe(false);

    // The nested level, which no provider before this one had. `assertObjectSurface` only
    // ever calls `listContainers()` with no parent, so this is the only thing in the epic
    // that exercises a second container level at all.
    const schemas = await provider.listContainers(["libredb_objects_two"]);
    expect(schemas.map((container) => container.path)).toEqual([
      ["libredb_objects_two", "app"],
      ["libredb_objects_two", "dbo"],
      ["libredb_objects_two", "reporting"],
    ]);
    expect(schemas.every((container) => container.level === 1)).toBe(true);
    // Not the connected database, so no schema here is the session's: `SCHEMA_NAME()`
    // answers for the database the session is IN, and naming `dbo` under every catalog
    // would point first paint at a schema this session has nothing to do with.
    expect(schemas.every((container) => container.isSessionDefault === false)).toBe(true);

    // Two measured exclusions, and a statement is the only place a mocked recordset can
    // show them. `sys` and `INFORMATION_SCHEMA` can hold nothing a person wrote
    // (`CREATE TABLE sys.probe` answers Msg 2760), and the nine fixed-role schemas exist
    // to own permissions - `is_fixed_role` being the engine's own answer for which those
    // are. The EXISTS arm is what stops the second exclusion hiding anything: a user table
    // in `db_owner` is legal, measured, and brings its schema back into the list.
    expect(issued.at(-1)!.sql).toContain("s.name NOT IN ('sys', 'INFORMATION_SCHEMA')");
    expect(issued.at(-1)!.sql).toContain("p.is_fixed_role = 0");
    expect(issued.at(-1)!.sql).toContain("o.schema_id = s.schema_id AND o.is_ms_shipped = 0");

    // The pin: the CALLER's catalog is what was read, not the connected one. SQL Server
    // addresses another database with a three-part name and there is nothing to bind, so a
    // provider that dropped the segment would answer the connected database's schemas for
    // every catalog in the tree and look entirely healthy doing it.
    const schemaRead = issued.at(-1)!.sql;
    expect(schemaRead).toContain("[libredb_objects_two].sys.schemas");
    expect(schemaRead).not.toContain("[libredb_objects].sys.schemas");

    // Last, because the assertions above read the statement issued most recently. The
    // connected database is where `SCHEMA_NAME()` IS about the catalog being listed, and
    // first paint needs it: it walks to the session default at the DEEPEST declared level
    // and counts there (#789), so an engine marking only its outer level opens a database
    // and stops with no folder and no count.
    const ownSchemas = await provider.listContainers(["libredb_objects"]);
    expect(ownSchemas.find((container) => container.name === "dbo")?.isSessionDefault).toBe(true);
    expect(ownSchemas.find((container) => container.name === "app")?.isSessionDefault).toBe(false);

    await provider.disconnect();
  });

  test("nothing nests under a schema, and that is an answer rather than a refusal", async () => {
    const provider = await connectedForObjects();
    expect(await provider.listContainers(["libredb_objects", "app"])).toEqual([]);
    // The control for that empty answer: no statement was issued for it. "This level has
    // no children" is a true statement about SQL Server and needs no round trip, so the
    // connect probe is the only read.
    expect(issued).toHaveLength(1);
    await provider.disconnect();
  });

  test("the trigger count comes from sys.triggers, because sys.objects has no DDL trigger", async () => {
    const provider = await connectedForObjects();
    const counts = await provider.countObjects(["libredb_objects"]);

    expect(counts.trigger).toEqual({ count: 4 });
    const sql = issued.at(-1)!.sql;
    // Measured on the fixture: sys.objects holds 2 triggers and sys.triggers holds 4. A
    // count taken from sys.objects alone is short by exactly the two DDL triggers, and no
    // assertion on sys.objects can see it.
    expect(sql).toContain("sys.triggers");
    expect(sql).not.toContain("'TR'");
    expect(sql).not.toContain("'TA'");
    // The control for those two negatives: the type list IS in this statement, with the
    // eight spellings sys.objects does answer for.
    expect(sql).toContain("'U','V','P','PC','X','FN','IF','TF','FS','FT','AF','SN','SO'");
    // Both arms keep Microsoft's own objects out. Measured: msdb holds 476 shipped
    // procedures, 145 tables, 78 views and 38 triggers, so without these a database nobody
    // has written a line in reports hundreds of objects as if a person had.
    expect(sql).toContain("o.is_ms_shipped = 0");
    expect(sql).toContain("t.is_ms_shipped = 0");
    await provider.disconnect();
  });

  test("satisfies the shared object surface contract", async () => {
    const provider = await connectedForObjects();

    await assertObjectSurface(provider, {
      containers: FIXTURE_DATABASES.map((database) => [database.name]),
      kinds: { table: 5, view: 1, procedure: 1, function: 3, trigger: 4, synonym: 1, sequence: 1 },
      sampleObject: { path: ["libredb_objects", "app", "orders"], kind: "table" },
    });

    await provider.disconnect();
  });
});

/**
 * The rest of the object surface: the container derivation, the listings, the detail row
 * and the refusals. Kept out of the block above so `-t "object surface"` still runs
 * exactly the five conformance tests.
 */
describe("SQL Server object containers, listings and detail", () => {
  beforeEach(installObjectFixture);

  test("a container is a database OR a database and a schema, and the depth is DERIVED", async () => {
    const provider = await connectedForObjects();

    // Both depths answer, and this is the assertion standing ruling 5g asks task 11 to
    // write for the fleet. A helper comparing `container.length !== 1` - correct on every
    // single-level engine, and what the two reference providers hold - refuses the
    // schema-level read below outright; one comparing `!== 2` refuses the database-level
    // read `assertObjectSurface` itself performs. Only an engine with two container levels
    // can tell either mistake from the derivation.
    const wholeDatabase = await provider.countObjects(["libredb_objects"]);
    expect(wholeDatabase.table).toEqual({ count: 5 });
    const databaseRead = issued.at(-1)!;
    expect(databaseRead.sql).not.toContain("@schema");
    expect(databaseRead.inputs).toEqual({});

    // A different number from the same fixture, because the schema really is a filter and
    // not a decoration: app holds four of the five tables, `reporting` the fifth.
    const oneSchema = await provider.countObjects(["libredb_objects", "app"]);
    expect(oneSchema.table).toEqual({ count: 4 });
    const schemaRead = issued.at(-1)!;
    // Both arms are filtered, and each fragment names the arm it belongs to. A bare
    // `toContain("s.name = @schema")` is VACUOUS here and was caught by mutation M10: it is
    // a substring of the trigger arm's `ps.name = @schema`, so dropping the filter from the
    // object arm entirely left it passing.
    expect(schemaRead.sql).toContain(
      "o.type IN ('U','V','P','PC','X','FN','IF','TF','FS','FT','AF','SN','SO') AND s.name = @schema",
    );
    expect(schemaRead.sql).toContain("t.is_ms_shipped = 0 AND ps.name = @schema");
    expect(schemaRead.inputs).toEqual({ schema: "app" });

    await provider.disconnect();
  });

  test("refuses a container path that names no database or reaches below a schema", async () => {
    const provider = await connectedForObjects();

    // The message is built from the DECLARED level labels, so the check and the sentence
    // are the same array and cannot disagree.
    await expect(provider.countObjects([])).rejects.toThrow(
      /container path is \[database\] or \[database, schema\], received \[\]/,
    );
    await expect(provider.listObjects(["a", "b", "c"], "table")).rejects.toThrow(
      /\[database\] or \[database, schema\], received \["a","b","c"\]/,
    );

    await provider.disconnect();
  });

  test("refuses a path whose segment its declaration has no level for", async () => {
    const provider = await connectedForObjects();
    // Reachable without a bug in the provider: a copy of this file declaring only a schema
    // level passes the length check and then has no catalog segment to three-part name
    // with, and `[undefined].sys.objects` asks the server about a database nobody has.
    // Both container levels are checked, because each is read by a different caller.
    const real = provider.getCapabilities();
    spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
    });
    await expect(provider.countObjects(["app"])).rejects.toThrow(
      "SQL Server declares no catalog level to read this path's segment from",
    );
    await expect(provider.listObjects(["app"], "table")).rejects.toThrow(/no catalog level/);
    await expect(provider.describeObject(["app", "orders"], "table")).rejects.toThrow(/no catalog level/);
    // `listContainers` is the one that does NOT raise, and that is the depth derivation
    // working: under a one-level declaration a schema is the last level, so nothing nests
    // under it and `[]` is the true answer rather than a refusal.
    expect(await provider.listContainers(["app"])).toEqual([]);
    await provider.disconnect();
  });

  test("seeds every declared kind at zero before a row overwrites it", async () => {
    const provider = await connectedForObjects();
    mockQueryFn = async (sql: string) => {
      issued.push({ sql, inputs: {} });
      return { recordset: [{ kind: "table", n: 2 }], rowsAffected: [1] };
    };

    const counts = await provider.countObjects(["libredb_objects", "app"]);
    expect(counts.table).toEqual({ count: 2 });
    // A declared kind the GROUP BY did not answer for holds none, which is a different
    // fact from a kind SQL Server does not have: the first draws a 0 badge, the second
    // draws no folder at all.
    expect(counts.view).toEqual({ count: 0 });
    expect(counts.trigger).toEqual({ count: 0 });
    expect(Object.keys(counts).sort()).toEqual([
      "function",
      "procedure",
      "sequence",
      "synonym",
      "table",
      "trigger",
      "view",
    ]);
    await provider.disconnect();
  });

  test("a refused count carries the server's own sentence against every kind", async () => {
    const provider = await connectedForObjects();
    const refusal = "The SELECT permission was denied on the object 'objects', database 'libredb_objects'";
    mockQueryFn = async () => {
      throw new Error(refusal);
    };

    const counts = await provider.countObjects(["libredb_objects", "app"]);
    // Never 0: "permission denied" and "this schema holds no tables" are different facts,
    // and this is the type that keeps them apart.
    expect(counts.table).toEqual({ unavailable: refusal });
    expect(counts.trigger).toEqual({ unavailable: refusal });
    await provider.disconnect();
  });

  test("a fault of OURS is raised, not dressed as the engine's refusal", async () => {
    const provider = await connectedForObjects();
    // `{ unavailable }` is rendered to a person verbatim as the reason a folder has no
    // number, so it must only ever carry a sentence SQL Server said. The catch therefore
    // covers the READ and not the mapping: here the driver answers a recordset that is not
    // iterable, the mapping throws, and that surfaces as a thrown error rather than as
    // "the engine refused" against all seven kinds.
    mockQueryFn = async () => ({ recordset: {}, rowsAffected: [0] });
    await expect(provider.countObjects(["libredb_objects", "app"])).rejects.toThrow(/is not iterable/);
    await provider.disconnect();
  });

  test("lists objects addressed [database, schema, name], with the engine's row count", async () => {
    const provider = await connectedForObjects();

    const tables = await provider.listObjects(["libredb_objects", "app"], "table");
    expect(tables).toEqual([
      { path: ["libredb_objects", "app", "customers"], name: "customers", kind: "table", rowCount: 0 },
      { path: ["libredb_objects", "app", "order_audit"], name: "order_audit", kind: "table", rowCount: 0 },
      {
        path: ["libredb_objects", "app", "order_audit_history"],
        name: "order_audit_history",
        kind: "table",
        rowCount: 0,
      },
      { path: ["libredb_objects", "app", "orders"], name: "orders", kind: "table", rowCount: 0 },
    ]);
    expect(issued.at(-1)!.inputs).toEqual({ schema: "app" });

    // A view holds no rows of its own, so the statement that answers for one selects no
    // count and the object carries no key at all rather than a fabricated 0.
    const views = await provider.listObjects(["libredb_objects", "app"], "view");
    expect(views).toEqual([{ path: ["libredb_objects", "app", "order_summary"], name: "order_summary", kind: "view" }]);
    expect(Object.hasOwn(views[0], "rowCount")).toBe(false);

    // The whole database, which is the depth `assertObjectSurface` reads at: the same kind
    // spans every schema and each path still starts with the container.
    const everyTable = await provider.listObjects(["libredb_objects"], "table");
    expect(everyTable.map((object) => object.path)).toEqual([
      ["libredb_objects", "app", "customers"],
      ["libredb_objects", "app", "order_audit"],
      ["libredb_objects", "app", "order_audit_history"],
      ["libredb_objects", "app", "orders"],
      ["libredb_objects", "reporting", "daily"],
    ]);

    await provider.disconnect();
  });

  test("a row count that was not measured is ABSENT, never 0", async () => {
    const provider = await connectedForObjects();
    // Its own listing rather than a row added to the measured fixture above, because these
    // two shapes are not in it: the fixture mirrors what the live server answers, and it
    // answers a number for all five tables.
    //
    // NULL is ENGINE-REACHABLE: `SUM(p.rows)` over no matching partition row answers NULL
    // through the LEFT JOIN, and reporting that as 0 would claim a measurement nobody made.
    // The unparseable value is a DRIVER-shape guard instead - tedious returns this column as
    // a number here - and it is pinned because `rowCount` is typed `number`, so a NaN would
    // reach the wire as `null` with nothing to tell it from the absence above.
    //
    // Both arms are pinned by a MUTATION and not by the coverage number: measured on
    // bun 1.4.2, raw lcov reported `DA:...,9` for both `return undefined` lines while
    // replacing either one changed nothing in the suite. Standing ruling 5b says the line
    // gate cannot see a folded arm; here it reported hits for arms that never ran at all.
    mockQueryFn = async (sql: string, inputs: Record<string, unknown> = {}) => {
      issued.push({ sql, inputs });
      if (sql.toUpperCase().includes("SELECT 1 AS TEST")) return { recordset: [{ test: 1 }], rowsAffected: [1] };
      return {
        recordset: [
          { schema_name: "app", name: "counted", row_count: 12 },
          { schema_name: "app", name: "no_partition_row", row_count: null },
          { schema_name: "app", name: "unreadable", row_count: "not a number" },
        ],
        rowsAffected: [3],
      };
    };

    const tables = await provider.listObjects(["libredb_objects", "app"], "table");
    expect(tables.map((object) => object.rowCount)).toEqual([12, undefined, undefined]);
    expect(Object.hasOwn(tables[0], "rowCount")).toBe(true);
    expect(Object.hasOwn(tables[1], "rowCount")).toBe(false);
    expect(Object.hasOwn(tables[2], "rowCount")).toBe(false);
    await provider.disconnect();
  });

  test("three sys.objects types are one `function` kind", async () => {
    const provider = await connectedForObjects();
    await provider.listObjects(["libredb_objects", "app"], "function");
    // FN is a scalar function, IF an inline table-valued one and TF a multi-statement
    // table-valued one. A person wrote three functions, so they are one folder.
    expect(issued.at(-1)!.sql).toContain("o.type IN ('FN','IF','TF','FS','FT','AF')");
    await provider.disconnect();
  });

  test("a DML trigger hangs off its table and a DDL trigger hangs off the database", async () => {
    const provider = await connectedForObjects();

    const triggers = await provider.listObjects(["libredb_objects"], "trigger");
    // Mixed depth in ONE listing, which standing ruling 5f requires: the count counted
    // four and the folder shows four. A DATABASE-scoped DDL trigger has no schema and no
    // base object, so [database, name] is its whole address, while a DML trigger takes the
    // table segment its `attachedTo: "table"` declaration states.
    expect(triggers).toEqual([
      {
        path: ["libredb_objects", "app", "orders", "stamp_order"],
        name: "stamp_order",
        kind: "trigger",
        status: "ENABLED",
      },
      { path: ["libredb_objects", "ddl_audit"], name: "ddl_audit", kind: "trigger", status: "ENABLED" },
      { path: ["libredb_objects", "orders"], name: "orders", kind: "trigger", status: "ENABLED" },
      {
        path: ["libredb_objects", "reporting", "daily", "stamp_order"],
        name: "stamp_order",
        kind: "trigger",
        status: "DISABLED",
      },
    ]);

    // One schema's folder holds only the triggers whose BASE OBJECT is in that schema, and
    // the two schemas each hold a `stamp_order`: measured, a trigger name is unique per
    // schema on SQL Server and a second `stamp_order` in one schema answers Msg 2714.
    const appTriggers = await provider.listObjects(["libredb_objects", "app"], "trigger");
    expect(appTriggers.map((object) => object.path)).toEqual([["libredb_objects", "app", "orders", "stamp_order"]]);
    await provider.disconnect();
  });

  test("orders a mixed-depth folder by SEGMENT, never by a serialised path", async () => {
    const provider = await connectedForObjects();
    // Four triggers whose order a `JSON.stringify` key gets wrong twice over, and both are
    // reachable on this engine rather than contrived. A DDL trigger is not in the schema
    // namespace, so one may be named `app` while a schema called `app` exists, and
    // `CREATE TRIGGER [a"b] ON DATABASE` is legal - both measured on SQL Server 2022 CU26.
    //
    //   - MIXED DEPTH: serialised, `["db","app","orders","trg"]` sorts BEFORE its own
    //     prefix `["db","app"]`, because `,` (0x2C) precedes `]` (0x5D).
    //   - ESCAPING: serialised, `a"b` becomes `a\"b`, so it sorts AFTER `a0b` on the
    //     backslash - the comparison is made on characters JSON invented.
    mockQueryFn = async (sql: string, inputs: Record<string, unknown> = {}) => {
      issued.push({ sql, inputs });
      if (sql.toUpperCase().includes("SELECT 1 AS TEST")) return { recordset: [{ test: 1 }], rowsAffected: [1] };
      return {
        recordset: [
          { name: "stamp_order", parent_schema: "app", parent_name: "orders", is_disabled: false },
          { name: "a0b", parent_schema: null, parent_name: null, is_disabled: false },
          { name: "app", parent_schema: null, parent_name: null, is_disabled: false },
          { name: 'a"b', parent_schema: null, parent_name: null, is_disabled: false },
        ],
        rowsAffected: [4],
      };
    };

    const triggers = await provider.listObjects(["libredb_objects"], "trigger");
    expect(triggers.map((object) => object.path)).toEqual([
      ["libredb_objects", 'a"b'],
      ["libredb_objects", "a0b"],
      ["libredb_objects", "app"],
      ["libredb_objects", "app", "orders", "stamp_order"],
    ]);
    await provider.disconnect();
  });

  test("a kind id that names a prototype property is refused, not resolved off it", async () => {
    const provider = await connectedForObjects();
    // A kind id is an OPEN string, and the vocabulary is a plain object: `TYPES["toString"]`
    // answers a FUNCTION off the prototype chain rather than undefined, so a bare index
    // would carry it into the statement builder as a kind this engine has. The lookup is
    // `Object.hasOwn`, and the refusal below is what says so.
    const real = provider.getCapabilities();
    spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      objectKinds: [...(real.objectKinds ?? []), { id: "toString", role: "config", label: "T", labelPlural: "Ts" }],
    });
    await expect(provider.listObjects(["libredb_objects", "app"], "toString")).rejects.toThrow(
      'SQL Server declares the kind "toString" but has no statement that lists it',
    );
    await provider.disconnect();
  });

  test("the type vocabulary is the ENGINE's documented set, not the fixture's", async () => {
    const provider = await connectedForObjects();
    await provider.countObjects(["libredb_objects"]);
    const sql = issued.at(-1)!.sql;

    // Standing ruling 5a (#789). A `SELECT DISTINCT type FROM sys.objects` over this
    // repo's fixture server answers eighteen spellings and NONE of the CLR ones, because no
    // assembly is registered there - so a vocabulary taken from what happened to be present
    // would drop a CLR stored procedure out of the count and the listing both, invisible in
    // the tree. These five are in the statement because Microsoft documents them, not
    // because anything measured here holds one.
    for (const clr of ["'PC'", "'X'", "'FS'", "'FT'", "'AF'"]) {
      expect(sql).toContain(clr);
    }
    // And the engine spellings that are deliberately NOT a declared kind: a table TYPE
    // (measured: its sys.objects row is `is_ms_shipped = 1`), a rule, a plan guide and a
    // replication filter procedure. Each is recorded as a known gap in the provider doc
    // rather than folded into a kind it is not.
    for (const excluded of ["'TT'", "'R'", "'PG'", "'RF'"]) {
      expect(sql).not.toContain(excluded);
    }
    await provider.disconnect();
  });

  test("refuses a kind SQL Server does not declare, and one it cannot list", async () => {
    const provider = await connectedForObjects();
    await expect(provider.listObjects(["libredb_objects", "app"], "package")).rejects.toThrow(
      'SQL Server declares no object kind "package"',
    );

    // Two questions, asked in order, and only the DECLARATION answers the first. Deciding
    // "is this kind declared" from whether a listing statement exists would report
    // "declares no object kind" about a kind `objectKinds` does declare.
    const real = provider.getCapabilities();
    spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      objectKinds: [...(real.objectKinds ?? []), { id: "assembly", role: "config", label: "A", labelPlural: "As" }],
    });
    await expect(provider.listObjects(["libredb_objects", "app"], "assembly")).rejects.toThrow(
      'SQL Server declares the kind "assembly" but has no statement that lists it',
    );
    await provider.disconnect();
  });

  test("describeObject binds the LAST path segment, never path[1]", async () => {
    const provider = await connectedForObjects();

    const detail = await provider.describeObject(["libredb_objects", "app", "orders"], "table");
    expect(detail.path).toEqual(["libredb_objects", "app", "orders"]);
    expect(detail.columns.map((column) => column.name)).toEqual(["id", "customer_id", "total", "note"]);
    expect(detail.columns[0]).toEqual({
      name: "id",
      type: "int",
      nullable: false,
      isPrimary: true,
      defaultValue: undefined,
    });
    expect(detail.columns[2].defaultValue).toBe("((0))");
    expect(detail.columns[3].isPrimary).toBe(false);
    expect(detail.indexes).toEqual([{ name: "app_orders_total_ix", columns: ["total"], unique: false }]);
    expect(detail.foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
    ]);

    // The pin standing ruling 5g asks task 11 to write for the fleet. On a one-level engine
    // `path[1]` IS the object's own name, so neither PostgreSQL's suite nor Oracle's can
    // tell the positional form from the derived one; here `path[1]` is the SCHEMA, and a
    // provider binding it as the object name reads a table called `app`, finds nothing, and
    // reports an object that exists as missing. All four reads bind the same pair.
    const reads = issued.slice(1);
    expect(reads).toHaveLength(4);
    // Declaration order comes from the statement, so this is where it is pinned: nothing
    // in TypeScript re-sorts a column list, and a grid showing `note` before `id` is wrong
    // in a way no count can catch.
    expect(reads[0].sql).toContain("ORDER BY c.column_id");
    for (const read of reads) {
      expect(read.inputs).toEqual({ schema: "app", name: "orders" });
      expect(read.sql).toContain("[libredb_objects].sys.");
    }
    await provider.disconnect();
  });

  test("a foreign key into another schema is QUALIFIED, and one inside it is not", async () => {
    const provider = await connectedForObjects();

    // Two reads of one rule, from both sides of a schema boundary. `ForeignKeySchema`
    // carries one string through Phase 1, so this spelling is what has to carry the
    // schema, and a bare name for the crossing case addresses a table in the WRONG schema
    // - which is exactly what the flat schema query's `OBJECT_NAME()` answers for it.
    const inside = await provider.describeObject(["libredb_objects", "app", "orders"], "table");
    expect(inside.foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
    ]);

    const crossing = await provider.describeObject(["libredb_objects", "reporting", "daily"], "table");
    expect(crossing.foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "app.customers", referencedColumn: "id" },
    ]);
    // Reaching the BIND a second time, on a different schema. Standing ruling 5g's third
    // spelling - a positional `path[0]` for the schema - survived two providers partly
    // because the tests written for it stopped at the refusal path and never looked at what
    // was bound. Here the catalog, the schema and the name are three different strings.
    expect(issued.at(-1)!.inputs).toEqual({ schema: "reporting", name: "daily" });
    await provider.disconnect();
  });

  test("a non-relation kind answers three empty arrays without a round trip", async () => {
    const provider = await connectedForObjects();

    for (const [path, kind] of [
      [["libredb_objects", "app", "touch_order"], "procedure"],
      [["libredb_objects", "app", "order_total"], "function"],
      [["libredb_objects", "app", "customer_alias"], "synonym"],
      [["libredb_objects", "app", "order_number_seq"], "sequence"],
      [["libredb_objects", "app", "orders", "stamp_order"], "trigger"],
      [["libredb_objects", "ddl_audit"], "trigger"],
    ] as const) {
      expect(await provider.describeObject(path, kind)).toEqual({
        path: [...path],
        columns: [],
        indexes: [],
        foreignKeys: [],
      });
    }
    // The control for those six: not one catalog read was issued, so the empty arrays are
    // a true fact about those kinds rather than four reads that happened to answer nothing.
    expect(issued).toHaveLength(1);
    await provider.disconnect();
  });

  test("a trigger sharing a name with a table gets the trigger's answer", async () => {
    const provider = await connectedForObjects();
    // Measured on SQL Server 2022: `CREATE TRIGGER orders ON DATABASE` succeeds while the
    // table app.orders exists, because a DDL trigger is not in the schema namespace -
    // where `CREATE PROCEDURE app.orders` answers Msg 2714. So the kind is what decides,
    // and a detail read keyed on the name alone would hand this trigger a table's columns.
    expect(await provider.describeObject(["libredb_objects", "orders"], "trigger")).toEqual({
      path: ["libredb_objects", "orders"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    await provider.disconnect();
  });

  test("refuses a path whose shape is not one this engine produces", async () => {
    const provider = await connectedForObjects();

    // Derived from the declaration, never counted: the container segments come from
    // `containerLevels` and the extra one from `attachedTo`, so the accepted shapes are
    // exactly the ones `listObjects` answers with.
    await expect(provider.describeObject(["libredb_objects", "orders"], "table")).rejects.toThrow(
      /"table" path is \[database, schema, name\], received \["libredb_objects","orders"\]/,
    );
    await expect(provider.describeObject(["libredb_objects", "app", "orders", "x"], "table")).rejects.toThrow(
      /"table" path is \[database, schema, name\]/,
    );
    await expect(provider.describeObject(["libredb_objects", "app", "stamp_order"], "trigger")).rejects.toThrow(
      /"trigger" path is \[database, schema, table, name\] or \[database, name\]/,
    );
    await expect(provider.describeObject(["x"], "trigger")).rejects.toThrow(/"trigger" path is/);
    await expect(provider.describeObject(["libredb_objects", "app", "orders"], "package")).rejects.toThrow(
      'SQL Server declares no object kind "package"',
    );
    await provider.disconnect();
  });

  test("the attached-kind shapes are read from the DECLARATION, not from a position", async () => {
    const provider = await connectedForObjects();
    const real = provider.getCapabilities();

    // Levels DECLARED IN THE OTHER ORDER. Filtering for the level whose id is `catalog` and
    // taking the first level by position are the same thing on every engine that declares a
    // catalog first, which is every engine that has one - so this swap is the only way to
    // tell them apart, and standing ruling 5g's closing line asks for exactly this rather
    // than a named survivor. The refusal spells the catalog level's own label either way;
    // under the swap a positional read would spell `[schema, name]`.
    spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      containerLevels: [
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
        { id: "catalog", label: "Database", labelPlural: "Databases" },
      ],
    });
    await expect(provider.describeObject(["only-one"], "trigger")).rejects.toThrow(
      '"trigger" path is [schema, database, table, name] or [database, name], received ["only-one"]',
    );

    // And with no catalog level at all the second shape is GONE rather than empty: an empty
    // filter spreads to nothing, so `["name"]` would accept a container-less single segment
    // for an attached kind and answer a detail for it.
    spyOn(provider, "getCapabilities").mockReturnValue({
      ...real,
      containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
    });
    await expect(provider.describeObject(["stamp_order"], "trigger")).rejects.toThrow(
      '"trigger" path is [schema, table, name], received ["stamp_order"]',
    );
    await provider.disconnect();
  });

  test("a relation with no column at all is a failed read, not an empty detail", async () => {
    const provider = await connectedForObjects();
    // A table and a view each hold at least one column on SQL Server - `CREATE TABLE t ()`
    // is a syntax error - so zero column rows means the object is not there. Answering
    // `{ columns: [] }` would render a table that was dropped as a table with no columns.
    await expect(provider.describeObject(["libredb_objects", "app", "gone"], "table")).rejects.toThrow(
      /No column row for libredb_objects\.app\.gone/,
    );
    await provider.disconnect();
  });

  test("the database list is the connected database alone on Azure SQL Database", async () => {
    const provider = await connectedForObjects();
    await provider.listContainers();
    const sql = issued.at(-1)!.sql;
    // Azure SQL Database cannot run a cross-database query at all, so every other catalog
    // would draw a container whose schemas can never be read. Listing exactly the connected
    // database is the engine's fact; answering an empty list would be a lie about the
    // database the caller is connected to. EngineEdition 5 IS Azure SQL Database, and the
    // arm lives in the statement rather than in TypeScript so one read serves both.
    expect(sql).toContain("SERVERPROPERTY('EngineEdition') <> 5 OR d.database_id = DB_ID()");
    // And a database this login cannot open is not listed: it would draw a container that
    // opens onto an error. Measured on the fixture, HAS_DBACCESS answers 0 for an OFFLINE
    // database while sys.databases still holds its row.
    expect(sql).toContain("HAS_DBACCESS(d.name) = 1");
    await provider.disconnect();
  });
});

/**
 * The fifth provider method (#789): every object of one kind in one container described in
 * FIVE round trips rather than four per object.
 *
 * This mock dispatches on the statement the provider built, which standing ruling 5b names
 * as a blind spot: a rewrite it cannot see stays green here. So the decisions a rewrite
 * would silently undo are pinned by statement TEXT below - the target set comes from
 * `sys.objects` with the same `is_ms_shipped = 0` predicate the listing uses, the cut is
 * `TOP (@limit)` with an `ORDER BY`, and nothing here caps a column - and all of them are
 * measured live in the task report.
 */
describe("SQL Server bulk column read", () => {
  beforeEach(installObjectFixture);

  test("describes every table of a database in five round trips, keyed by path", async () => {
    const provider = await connectedForObjects();
    issued = [];

    const batch = await provider.describeObjects(["libredb_objects"], "table");

    // FIVE statements for the whole folder, whatever the folder holds. The single read is
    // four per object, which at five tables is twenty.
    expect(issued).toHaveLength(5);
    expect(issued[0].sql).toContain("[libredb_objects].sys.objects");
    expect(issued[0].sql).toContain("o.is_ms_shipped = 0");
    expect(issued[0].sql).toContain("o.type IN ('U')");
    // A database-level container binds no schema and the statement does not mention one.
    expect(issued[0].sql).not.toContain("@schema");
    // Unbounded: no TOP, and with no TOP there is no ORDER BY either, because SQL Server
    // does not take one in a CTE without a row bound and an unbounded read cuts nothing.
    for (const call of issued) {
      expect(call.sql).not.toContain("TOP (@limit)");
      expect(call.sql).not.toContain("ORDER BY s.name, o.name");
    }
    expect(batch.truncated).toBeUndefined();

    // Every object of the kind, at [database, schema, name], sorted by path.
    expect(batch.details.map((detail) => detail.path)).toEqual([
      ["libredb_objects", "app", "customers"],
      ["libredb_objects", "app", "order_audit"],
      ["libredb_objects", "app", "order_audit_history"],
      ["libredb_objects", "app", "orders"],
      ["libredb_objects", "reporting", "daily"],
    ]);
    const orders = batch.details[3];
    expect(orders.columns).toEqual([
      { name: "id", type: "int", nullable: false, isPrimary: true, defaultValue: undefined },
      { name: "customer_id", type: "int", nullable: true, isPrimary: false, defaultValue: undefined },
      { name: "total", type: "decimal", nullable: true, isPrimary: false, defaultValue: "((0))" },
      { name: "note", type: "nvarchar", nullable: true, isPrimary: false, defaultValue: undefined },
    ]);
    expect(orders.indexes).toEqual([{ name: "app_orders_total_ix", columns: ["total"], unique: false }]);
    // Bare inside the object's OWN schema, qualified outside it, which is per object rather
    // than per read: `app.orders` and `reporting.daily` carry the same foreign key and only
    // one of them crosses a schema boundary.
    expect(orders.foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
    ]);
    expect(batch.details[4].foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "app.customers", referencedColumn: "id" },
    ]);
    // An object the four detail reads answered nothing for is still IN the answer.
    expect(batch.details[0]).toEqual({
      path: ["libredb_objects", "app", "customers"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    await provider.disconnect();
  });

  test("a schema-level container describes that schema and binds it", async () => {
    const provider = await connectedForObjects();
    issued = [];

    const batch = await provider.describeObjects(["libredb_objects", "reporting"], "table");

    expect(issued[0].sql).toContain("s.name = @schema");
    expect(issued[0].inputs.schema).toBe("reporting");
    expect(batch.details.map((detail) => detail.path)).toEqual([["libredb_objects", "reporting", "daily"]]);
    await provider.disconnect();
  });

  test("the bulk read and the single read spell one object identically", async () => {
    // ONE mapper serves both, so the two answers for one table cannot disagree about a
    // foreign key, an index or which column is the primary key.
    const provider = await connectedForObjects();

    const bulk = (await provider.describeObjects(["libredb_objects", "app"], "table")).details.find(
      (detail) => detail.path[2] === "orders",
    );
    const single = await provider.describeObject(["libredb_objects", "app", "orders"], "table");

    expect(bulk).toEqual(single);
    await provider.disconnect();
  });

  test("a bounded read binds one row more than the bound and reports its own truncation", async () => {
    const provider = await connectedForObjects();
    issued = [];

    const batch = await provider.describeObjects(["libredb_objects"], "table", 2);

    // limit + 1, which is how a saturated read is told from an exact one with no second
    // count, and the cut is ordered so the bound keeps a determinate set.
    expect(issued[0].inputs.limit).toBe(3);
    expect(issued[0].sql).toContain("TOP (@limit)");
    expect(issued[0].sql).toContain("ORDER BY s.name, o.name");
    expect(batch.details.map((detail) => detail.path[2])).toEqual(["customers", "order_audit"]);
    expect(batch.truncated).toEqual({ limit: 2, reason: "column read limit reached" });
    await provider.disconnect();
  });

  test("a bounded read that fits reports nothing", async () => {
    const provider = await connectedForObjects();

    const batch = await provider.describeObjects(["libredb_objects"], "table", 5);

    expect(batch.details).toHaveLength(5);
    expect(batch.truncated).toBeUndefined();
    await provider.disconnect();
  });

  test("a kind SQL Server holds no columns for answers empty without asking the server", async () => {
    // Measured on SQL Server 2022 CU26 against the fixture: of the types a person writes,
    // only `U` and `V` have sys.columns rows - a scalar function, a procedure, a synonym, a
    // SEQUENCE and a trigger all have zero. A sequence having none is the contrast with
    // PostgreSQL, where one has three columns, and with MariaDB, where one has eight.
    const provider = await connectedForObjects();
    issued = [];

    for (const kind of ["procedure", "function", "synonym", "sequence", "trigger"]) {
      expect(await provider.describeObjects(["libredb_objects"], kind)).toEqual({ details: [] });
    }
    expect(issued).toHaveLength(0);
    await provider.disconnect();
  });

  test("an empty container costs one round trip and not five", async () => {
    const provider = await connectedForObjects();
    issued = [];

    expect(await provider.describeObjects(["libredb_objects", "dbo"], "table")).toEqual({ details: [] });
    expect(issued).toHaveLength(1);
    await provider.disconnect();
  });

  test("a kind this engine does not declare is refused, not answered empty", async () => {
    const provider = await connectedForObjects();

    await expect(provider.describeObjects(["libredb_objects"], "package")).rejects.toThrow(
      /declares no object kind "package"/,
    );
    await provider.disconnect();
  });

  test("a container path that is neither shape is refused, rather than read as empty", async () => {
    const provider = await connectedForObjects();

    await expect(provider.describeObjects([], "table")).rejects.toThrow(
      /container path is \[database\] or \[database, schema\]/,
    );
    await expect(provider.describeObjects(["a", "b", "c"], "table")).rejects.toThrow(
      /container path is \[database\] or \[database, schema\]/,
    );
    await provider.disconnect();
  });

  test("a limit that cannot bound anything is refused, rather than silently ignored", async () => {
    const provider = await connectedForObjects();

    await expect(provider.describeObjects(["libredb_objects"], "table", 0)).rejects.toThrow(
      /limit must be a positive whole number, received 0/,
    );
    await expect(provider.describeObjects(["libredb_objects"], "table", 1.5)).rejects.toThrow(
      /limit must be a positive whole number, received 1.5/,
    );
    await provider.disconnect();
  });

  test("the paths it answers are the paths listObjects answers", async () => {
    const provider = await connectedForObjects();

    const listed = await provider.listObjects(["libredb_objects"], "table");
    const batch = await provider.describeObjects(["libredb_objects"], "table");

    expect(batch.details.map((detail) => detail.path)).toEqual(listed.map((object) => object.path));
    await provider.disconnect();
  });

  test("the CALLER's catalog is what is read, and the schema comes from its declared level", async () => {
    // Standing ruling 5g (#789) driven to a BOUND VALUE. SQL Server is the engine where
    // `path[0]` is the catalog and `path[1]` is the schema, so a positional read of either
    // narrows every one of the five statements to an object that does not exist.
    const provider = await connectedForObjects();
    issued = [];

    await provider.describeObjects(["libredb_objects_two", "app"], "table");

    for (const call of issued) {
      expect(call.sql).toContain("[libredb_objects_two].sys.");
      expect(call.sql).not.toContain("[libredb_objects].sys.");
      expect(call.inputs.schema).toBe("app");
    }
    await provider.disconnect();
  });

  test("the container segments are read from the DECLARATION, not from a position", async () => {
    // Standing ruling 5g (#789)'s closing line: `container[0]` is the catalog and
    // `container[1]` is the schema on every engine that declares them in that order, so the
    // only thing that can tell a derivation from a position is a declaration in the OTHER
    // order - and this one is driven to a BOUND VALUE rather than to a refusal.
    const provider = await connectedForObjects();
    spyOn(provider, "getCapabilities").mockReturnValue({
      ...provider.getCapabilities(),
      containerLevels: [
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
        { id: "catalog", label: "Database", labelPlural: "Databases" },
      ],
    });
    issued = [];

    await provider.describeObjects(["app", "libredb_objects_two"], "table");

    for (const call of issued) {
      expect(call.sql).toContain("[libredb_objects_two].sys.");
      expect(call.sql).not.toContain("[app].sys.");
      expect(call.inputs.schema).toBe("app");
    }
    await provider.disconnect();
  });

  test("the answer is sorted by path, whatever order the server cut it in", async () => {
    const provider = await connectedForObjects();
    mockQueryFn = async (sql: string) => {
      if (!sql.toUpperCase().includes("WITH DESCRIBED AS")) return { recordset: [], rowsAffected: [0] };
      if (!sql.includes("sys.columns")) {
        return {
          recordset: [
            { object_id: 5, schema_name: "reporting", name: "daily" },
            { object_id: 4, schema_name: "app", name: "orders" },
          ],
          rowsAffected: [2],
        };
      }
      return { recordset: [], rowsAffected: [0] };
    };

    const batch = await provider.describeObjects(["libredb_objects"], "table");

    // The server's order decides which objects a bound keeps; the order a caller reads is
    // ours, one rule on every engine, because callers join the two answers on path. By PATH
    // and not by name: `app.orders` sorts above `reporting.daily` because the SCHEMA segment
    // is compared first, which is what groups a database-level folder by schema.
    expect(batch.details.map((detail) => detail.path)).toEqual([
      ["libredb_objects", "app", "orders"],
      ["libredb_objects", "reporting", "daily"],
    ]);
    await provider.disconnect();
  });
});
