/**
 * Integration tests for MySQLProvider
 * Uses mock.module() to intercept mysql2/promise before provider import.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { DatabaseConnection } from "@/lib/types";
import { DatabaseConfigError } from "@/lib/db/errors";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";

// ============================================================================
// Mock mysql2/promise BEFORE importing the provider
// ============================================================================

let mockExecuteFn: (sql: string, params?: unknown[]) => Promise<[unknown[], unknown[]]>;

const mockConnection = {
  threadId: 42,
  execute: (sql: string, params?: unknown[]) => mockExecuteFn(sql, params),
  release: () => {},
  beginTransaction: async () => {},
  commit: async () => {},
  rollback: async () => {},
};

const mockPool = {
  getConnection: async () => mockConnection,
  end: async () => {},
  execute: (sql: string, params?: unknown[]) => mockExecuteFn(sql, params),
};

mock.module("mysql2/promise", () => ({
  default: {
    createPool: () => mockPool,
  },
  createPool: () => mockPool,
}));

// Dynamic import AFTER mock is installed
const { MySQLProvider } = await import("@/lib/db/providers/sql/mysql");

// ============================================================================
// Helpers
// ============================================================================

function makeMySQLConfig(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "test-mysql",
    name: "Test MySQL",
    type: "mysql",
    host: "localhost",
    port: 3306,
    database: "testdb",
    user: "root",
    password: "secret",
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * Default mock execute that matches SQL patterns and returns mock data.
 */
function defaultMockExecute(sql: string): Promise<[unknown[], unknown[]]> {
  const normalized = sql.trim().toLowerCase();

  // SHOW STATUS LIKE 'Threads_connected'
  if (normalized.includes("show status like 'threads_connected'")) {
    return Promise.resolve([[{ Value: "5" }], []]);
  }

  // SHOW STATUS LIKE 'Uptime'
  if (normalized.includes("show status like 'uptime'")) {
    return Promise.resolve([[{ Value: "86400" }], []]);
  }

  // SHOW STATUS LIKE 'Innodb_deadlocks'
  if (normalized.includes("show status like 'innodb_deadlocks'")) {
    return Promise.resolve([[{ Value: "0" }], []]);
  }

  // SHOW VARIABLES LIKE 'max_connections'
  if (normalized.includes("show variables like 'max_connections'")) {
    return Promise.resolve([[{ Value: "151" }], []]);
  }

  // SHOW VARIABLES LIKE 'innodb_data_file_path'
  if (normalized.includes("show variables like 'innodb_data_file_path'")) {
    return Promise.resolve([[{ Value: "ibdata1:12M:autoextend" }], []]);
  }

  // SHOW BINARY LOGS
  if (normalized.includes("show binary logs")) {
    return Promise.resolve([[{ File_size: "1048576" }], []]);
  }

  // VERSION()
  if (normalized.includes("version()")) {
    return Promise.resolve([[{ version: "8.0.35" }], [{ name: "version" }]]);
  }

  // performance_schema.global_status — cache hit ratio, buffer pool, QPS
  if (normalized.includes("performance_schema.global_status")) {
    // Buffer pool reads query (hit_ratio must be numeric — .toFixed() is called on it)
    if (normalized.includes("innodb_buffer_pool_reads") && normalized.includes("hit_ratio")) {
      return Promise.resolve([[{ hit_ratio: 99.5 }], []]);
    }
    // Buffer pool pages
    if (normalized.includes("data_pages") && normalized.includes("total_pages")) {
      return Promise.resolve([[{ data_pages: "800", total_pages: "1000" }], []]);
    }
    // Queries/uptime (QPS)
    if (normalized.includes("queries") && normalized.includes("uptime")) {
      return Promise.resolve([[{ queries: "50000", uptime: "86400" }], []]);
    }
    return Promise.resolve([[{ hit_ratio: 99.5 }], []]);
  }

  // performance_schema.events_statements_summary_by_digest (slow queries)
  if (normalized.includes("events_statements_summary_by_digest")) {
    return Promise.resolve([
      [
        {
          query: "SELECT * FROM users",
          calls: "100",
          avgTime: "12.5ms",
          query_id: "abc123",
          total_time_ms: "1250",
          avg_time_ms: "12.5",
          min_time_ms: "1.0",
          max_time_ms: "50.0",
          rows_examined: "5000",
        },
      ],
      [],
    ]);
  }

  // information_schema.TABLES — COUNT(*) without table_name (getOverview table count)
  if (
    normalized.includes("information_schema.tables") &&
    normalized.includes("count(*)") &&
    !normalized.includes("table_name")
  ) {
    return Promise.resolve([[{ cnt: "2" }], []]);
  }

  // information_schema.TABLES — size aggregate (no table_name in query, e.g. getOverview, getStorageStats)
  if (
    normalized.includes("information_schema.tables") &&
    normalized.includes("sum(data_length") &&
    !normalized.includes("table_name")
  ) {
    return Promise.resolve([[{ size_mb: "12.50", size_bytes: "13107200", name: "testdb" }], []]);
  }

  // information_schema.TABLES — table list (has table_name)
  if (normalized.includes("information_schema.tables") && normalized.includes("table_name")) {
    // Table count query
    if (normalized.includes("count(*)")) {
      return Promise.resolve([[{ cnt: "2" }], []]);
    }
    // Size aggregate with table_schema (getHealth size)
    if (normalized.includes("sum(data_length")) {
      return Promise.resolve([[{ size_mb: "12.50", size_bytes: "13107200", name: "testdb" }], []]);
    }
    // Table stats query
    if (normalized.includes("table_rows") && normalized.includes("data_length")) {
      return Promise.resolve([
        [
          {
            table_name: "users",
            row_count: "100",
            total_size: "8192",
            table_size_bytes: "4096",
            index_size_bytes: "2048",
            total_size_bytes: "6144",
            free_space_bytes: "512",
            schema_name: "testdb",
          },
          {
            table_name: "orders",
            row_count: "50",
            total_size: "4096",
            table_size_bytes: "2048",
            index_size_bytes: "1024",
            total_size_bytes: "3072",
            free_space_bytes: "256",
            schema_name: "testdb",
          },
        ],
        [],
      ]);
    }
    // Plain table listing (for maintenance getAllTablesForMaintenance)
    if (normalized.includes("table_name") && !normalized.includes("table_rows")) {
      return Promise.resolve([[{ TABLE_NAME: "users" }, { TABLE_NAME: "orders" }], []]);
    }
    return Promise.resolve([
      [
        { table_name: "users", row_count: "100", total_size: "8192" },
        { table_name: "orders", row_count: "50", total_size: "4096" },
      ],
      [],
    ]);
  }

  // information_schema.TABLES — size only (getHealth — has size_mb but no table_name)
  if (normalized.includes("information_schema.tables") && normalized.includes("size_mb")) {
    return Promise.resolve([[{ size_mb: "12.50" }], []]);
  }

  // information_schema.COLUMNS
  if (normalized.includes("information_schema.columns")) {
    return Promise.resolve([
      [
        { column_name: "id", data_type: "int", is_nullable: "NO", column_default: null, column_key: "PRI" },
        { column_name: "name", data_type: "varchar", is_nullable: "YES", column_default: null, column_key: "" },
        { column_name: "email", data_type: "varchar", is_nullable: "NO", column_default: null, column_key: "UNI" },
      ],
      [],
    ]);
  }

  // information_schema.KEY_COLUMN_USAGE (foreign keys)
  if (normalized.includes("key_column_usage")) {
    return Promise.resolve([[{ column_name: "user_id", referenced_table: "users", referenced_column: "id" }], []]);
  }

  // information_schema.STATISTICS (indexes)
  if (normalized.includes("information_schema.statistics")) {
    // Count query for overview
    if (normalized.includes("count(distinct")) {
      return Promise.resolve([[{ table_count: "2", index_count: "3" }], []]);
    }
    // Index stats query
    if (normalized.includes("index_type") || normalized.includes("group_concat")) {
      return Promise.resolve([
        [
          {
            schema_name: "testdb",
            table_name: "users",
            index_name: "PRIMARY",
            index_type: "BTREE",
            columns: "id",
            is_unique: 1,
            is_primary: 1,
            cardinality: "100",
          },
          {
            schema_name: "testdb",
            table_name: "users",
            index_name: "idx_email",
            index_type: "BTREE",
            columns: "email",
            is_unique: 1,
            is_primary: 0,
            cardinality: "100",
          },
        ],
        [],
      ]);
    }
    return Promise.resolve([
      [
        { index_name: "PRIMARY", columns: "id", is_unique: 1 },
        { index_name: "idx_email", columns: "email", is_unique: 1 },
      ],
      [],
    ]);
  }

  // information_schema.PROCESSLIST (sessions)
  if (normalized.includes("processlist")) {
    return Promise.resolve([
      [
        {
          pid: 1,
          user: "root",
          database: "testdb",
          database_name: "testdb",
          state: "Query",
          query: "SELECT 1",
          duration: "0s",
          client_addr: "127.0.0.1:3306",
          duration_seconds: "0",
        },
        {
          pid: 2,
          user: "app",
          database: "testdb",
          database_name: "testdb",
          state: "Sleep",
          query: "",
          duration: "5s",
          client_addr: "10.0.0.1:3306",
          duration_seconds: "5",
        },
      ],
      [],
    ]);
  }

  // mysql.innodb_index_stats (per-index sizes) — only `users.PRIMARY` has a persistent-stats
  // row, so `users.idx_email` exercises the "no row" path.
  if (normalized.includes("innodb_index_stats")) {
    return Promise.resolve([
      [{ database_name: "testdb", table_name: "users", index_name: "PRIMARY", size_bytes: "16384" }],
      [],
    ]);
  }

  // KILL query (maintenance)
  if (normalized.startsWith("kill")) {
    return Promise.resolve([[], []]);
  }

  // ANALYZE TABLE / OPTIMIZE TABLE / CHECK TABLE
  if (
    normalized.startsWith("analyze table") ||
    normalized.startsWith("optimize table") ||
    normalized.startsWith("check table")
  ) {
    return Promise.resolve([[], []]);
  }

  // Default: generic SELECT result
  return Promise.resolve([[{ id: 1, name: "test" }], [{ name: "id" }, { name: "name" }]]);
}

/**
 * MariaDB answers `SELECT VERSION()` with its own build string. Measured on
 * `mariadb:12.3` (`12.3.2-MariaDB-ubu2404`), which is the version
 * `WIRE_COMPATIBLE_ENGINES` records for MariaDB.
 */
function mariaDBMockExecute(sql: string): Promise<[unknown[], unknown[]]> {
  if (sql.trim().toLowerCase().includes("version()")) {
    return Promise.resolve([[{ version: "12.3.2-MariaDB-ubu2404" }], [{ name: "version" }]]);
  }
  return defaultMockExecute(sql);
}

/**
 * What a server with `performance_schema` OFF actually returns. MariaDB ships it
 * disabled by default, and the tables still EXIST there: every query below is a
 * bare `SELECT (subquery)` with no FROM, so it answers one row of NULLs rather
 * than throwing or returning nothing. Measured on `mariadb:12.3` with
 * `@@performance_schema` = 0.
 */
function perfSchemaDisabledMockExecute(sql: string): Promise<[unknown[], unknown[]]> {
  const normalized = sql.trim().toLowerCase();

  if (normalized.includes("performance_schema.global_status")) {
    if (normalized.includes("innodb_buffer_pool_reads") && normalized.includes("hit_ratio")) {
      return Promise.resolve([[{ hit_ratio: null }], []]);
    }
    if (normalized.includes("data_pages") && normalized.includes("total_pages")) {
      return Promise.resolve([[{ data_pages: null, total_pages: null }], []]);
    }
    if (normalized.includes("queries") && normalized.includes("uptime")) {
      return Promise.resolve([[{ queries: null, uptime: null }], []]);
    }
    return Promise.resolve([[{ hit_ratio: null }], []]);
  }

  if (normalized.includes("events_statements_summary_by_digest")) {
    return Promise.resolve([[], []]);
  }

  return defaultMockExecute(sql);
}

// ============================================================================
// Tests
// ============================================================================

describe("MySQLProvider", () => {
  let provider: InstanceType<typeof MySQLProvider>;

  beforeEach(() => {
    mockExecuteFn = defaultMockExecute;
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
        new MySQLProvider(makeMySQLConfig({ host: undefined }));
      }).toThrow(DatabaseConfigError);
    });

    test("missing database throws DatabaseConfigError", () => {
      expect(() => {
        new MySQLProvider(makeMySQLConfig({ database: undefined }));
      }).toThrow(DatabaseConfigError);
    });

    test("valid config passes validation", () => {
      expect(() => {
        new MySQLProvider(makeMySQLConfig());
      }).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Connection lifecycle
  // --------------------------------------------------------------------------

  describe("connect / disconnect", () => {
    test("isConnected() is false before connect", () => {
      provider = new MySQLProvider(makeMySQLConfig());
      expect(provider.isConnected()).toBe(false);
    });

    test("connect() sets connected to true", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test("disconnect() sets connected to false", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      await provider.disconnect();
      expect(provider.isConnected()).toBe(false);
    });

    test("double connect is idempotent", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Query execution
  // --------------------------------------------------------------------------

  describe("query()", () => {
    test("SELECT returns rows, fields, and executionTime", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.query("SELECT * FROM users");
      expect(result.rows.length).toBeGreaterThan(0);
      expect(Array.isArray(result.fields)).toBe(true);
      expect(typeof result.executionTime).toBe("number");
      expect(typeof result.rowCount).toBe("number");
    });

    test("result contains sanitized rows", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.query("SELECT id, name FROM test");
      expect(result.rows.length).toBe(1);
      const row = result.rows[0] as Record<string, unknown>;
      expect(row.id).toBe(1);
      expect(row.name).toBe("test");
    });
  });

  // --------------------------------------------------------------------------
  // Capabilities
  // --------------------------------------------------------------------------

  describe("getCapabilities()", () => {
    test("returns correct MySQL capabilities", () => {
      provider = new MySQLProvider(makeMySQLConfig());
      const caps = provider.getCapabilities();
      expect(caps.defaultPort).toBe(3306);
      expect(caps.queryLanguage).toBe("sql");
      expect(caps.supportsExplain).toBe(true);
      expect(caps.explainFormat).toBe("mysql-json");
      expect(caps.supportsExplain).toBe(caps.explainFormat !== undefined);
      expect(caps.supportsConnectionString).toBe(true);
      // `UPDATE t SET c = v WHERE pk = v` is core MySQL DML — the shape the inline
      // row editor builds (#269).
      expect(caps.supportsInlineRowEdit).toBe(true);
      // One held connection carries the transaction, so the trio is offered (#U13).
      expect(caps.supportsTransactions).toBe(true);
      // Inherited from the base capabilities: this engine declares foreign keys, so
      // an empty `foreignKeys` list is a fact about the schema or the role, never
      // about the engine (#414).
      expect(caps.declaresForeignKeys).toBe(true);
      expect(caps.maintenanceOperations).toContain("analyze");
      expect(caps.maintenanceOperations).toContain("optimize");
      expect(caps.maintenanceOperations).toContain("check");
      expect(caps.maintenanceOperations).toContain("kill");
    });
  });

  // --------------------------------------------------------------------------
  // Labels
  // --------------------------------------------------------------------------

  describe("getLabels()", () => {
    // The only label this provider declares. Until #U12 the monitoring Queries panel
    // told a MySQL operator to install a PostgreSQL extension; `getSlowQueries()` reads
    // `performance_schema.events_statements_summary_by_digest` and swallows a failure
    // into `[]`, so the Performance Schema is the switch the sentence must name.
    test("names the Performance Schema, not a Postgres extension, as the source of query stats", () => {
      provider = new MySQLProvider(makeMySQLConfig());
      const { slowQueriesEmptyState, entityName } = provider.getLabels();

      expect(slowQueriesEmptyState).toContain("performance_schema.events_statements_summary_by_digest");
      expect(slowQueriesEmptyState).toContain("Performance Schema");
      expect(slowQueriesEmptyState).not.toContain("pg_stat_statements");
      // Everything else is still the inherited SQL wording, which is right for MySQL.
      expect(entityName).toBe("Table");
    });
  });

  // --------------------------------------------------------------------------
  // Schema
  // --------------------------------------------------------------------------

  describe("getSchema()", () => {
    test("returns TableSchema array with columns, indexes, foreignKeys", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const schema = await provider.getSchema();

      expect(schema.length).toBeGreaterThan(0);

      for (const table of schema) {
        expect(typeof table.name).toBe("string");
        expect(Array.isArray(table.columns)).toBe(true);
        expect(table.columns.length).toBeGreaterThan(0);
        expect(Array.isArray(table.indexes)).toBe(true);
        expect(Array.isArray(table.foreignKeys)).toBe(true);
      }
    });

    test("columns have expected properties", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const schema = await provider.getSchema();
      const firstTable = schema[0];
      const col = firstTable.columns[0];

      expect(typeof col.name).toBe("string");
      expect(typeof col.type).toBe("string");
      expect(typeof col.nullable).toBe("boolean");
      expect(typeof col.isPrimary).toBe("boolean");
    });
  });

  // --------------------------------------------------------------------------
  // Health
  // --------------------------------------------------------------------------

  describe("getHealth()", () => {
    test("returns health info with activeConnections, databaseSize, cacheHitRatio, slowQueries, activeSessions", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const health = await provider.getHealth();

      expect(typeof health.activeConnections).toBe("number");
      expect(health.activeConnections).toBe(5);
      expect(typeof health.databaseSize).toBe("string");
      expect(typeof health.cacheHitRatio).toBe("string");
      expect(Array.isArray(health.slowQueries)).toBe(true);
      expect(Array.isArray(health.activeSessions)).toBe(true);
    });

    test("reports the cache hit ratio as measured when performance_schema answers", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const health = await provider.getHealth();

      expect(health.cacheHitRatio).toBe("99.5");
    });

    test("reports the cache hit ratio as unavailable when performance_schema is disabled", async () => {
      mockExecuteFn = perfSchemaDisabledMockExecute;

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const health = await provider.getHealth();

      expect(health.cacheHitRatio).toBe(CACHE_HIT_RATIO_UNAVAILABLE);
    });
  });

  // --------------------------------------------------------------------------
  // Maintenance
  // --------------------------------------------------------------------------

  describe("runMaintenance()", () => {
    test("analyze returns success", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance("analyze", "users");
      expect(result.success).toBe(true);
      expect(typeof result.executionTime).toBe("number");
      expect(result.message).toContain("ANALYZE");
    });

    test("optimize returns success", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance("optimize", "users");
      expect(result.success).toBe(true);
      expect(result.message).toContain("OPTIMIZE");
    });

    test("check returns success", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance("check", "users");
      expect(result.success).toBe(true);
      expect(result.message).toContain("CHECK");
    });

    test("analyze without target runs against all tables", async () => {
      const executedStatements: string[] = [];
      mockExecuteFn = (sql: string) => {
        executedStatements.push(sql);
        return defaultMockExecute(sql);
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance("analyze");
      expect(result.success).toBe(true);
      expect(result.message).toContain("ANALYZE");

      // getAllTablesForMaintenance lists tables and escapes each identifier
      const analyzeSql = executedStatements.find((s) => s.startsWith("ANALYZE TABLE"));
      expect(analyzeSql).toBeDefined();
      expect(analyzeSql).toContain("`users`");
      expect(analyzeSql).toContain("`orders`");
    });

    test("kill without target throws QueryError", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      await expect(provider.runMaintenance("kill")).rejects.toThrow("Target connection ID is required");
    });

    test("kill with valid target returns success", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.runMaintenance("kill", "1234");
      expect(result.success).toBe(true);
      expect(result.message).toContain("KILL");
    });

    test("unsupported type throws QueryError", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      await expect(provider.runMaintenance("vacuum" as unknown as "analyze", "users")).rejects.toThrow(
        "Unsupported maintenance type for MySQL",
      );
    });
  });

  // --------------------------------------------------------------------------
  // Transaction support
  // --------------------------------------------------------------------------

  describe("Transaction lifecycle", () => {
    test("beginTransaction / commitTransaction works", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      expect(provider.isInTransaction()).toBe(false);
      await provider.beginTransaction();
      expect(provider.isInTransaction()).toBe(true);
      await provider.commitTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });

    test("beginTransaction / rollbackTransaction works", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      await provider.beginTransaction();
      expect(provider.isInTransaction()).toBe(true);
      await provider.rollbackTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });

    test("double beginTransaction throws", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      await provider.beginTransaction();
      await expect(provider.beginTransaction()).rejects.toThrow("Transaction already active");
      // Clean up
      await provider.rollbackTransaction();
    });

    test("expireTransaction auto-rollbacks an active transaction", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      await provider.beginTransaction();
      expect(provider.isInTransaction()).toBe(true);

      await provider.expireTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });

    test("transaction auto-rolls back when the timeout timer fires", async () => {
      // TX_TIMEOUT_MS is a compile-time-private static; shrink it at runtime so
      // the setTimeout callback in beginTransaction actually fires in the test.
      const providerStatics = MySQLProvider as unknown as { TX_TIMEOUT_MS: number };
      const originalTimeout = providerStatics.TX_TIMEOUT_MS;
      providerStatics.TX_TIMEOUT_MS = 5;

      try {
        provider = new MySQLProvider(makeMySQLConfig());
        await provider.connect();
        await provider.beginTransaction();
        expect(provider.isInTransaction()).toBe(true);

        // Wait for the shortened timeout to trigger the auto-rollback
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(provider.isInTransaction()).toBe(false);
      } finally {
        providerStatics.TX_TIMEOUT_MS = originalTimeout;
      }
    });

    test("expireTransaction is no-op when no active transaction", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      // Should not throw
      await provider.expireTransaction();
      expect(provider.isInTransaction()).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Cancel query
  // --------------------------------------------------------------------------

  describe("cancelQuery()", () => {
    test("cancelQuery with unknown queryId returns false", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const result = await provider.cancelQuery("nonexistent-query-id");
      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getOverview()
  // --------------------------------------------------------------------------

  describe("getOverview()", () => {
    test("returns version, uptime, connections, size, table/index counts", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      expect(overview.version).toContain("MySQL");
      expect(overview.version).toContain("8.0.35");
      expect(typeof overview.uptime).toBe("string");
      expect(overview.uptime.length).toBeGreaterThan(0);
      expect(typeof overview.activeConnections).toBe("number");
      expect(overview.activeConnections).toBe(5);
      expect(typeof overview.maxConnections).toBe("number");
      expect(overview.maxConnections).toBe(151);
      expect(typeof overview.databaseSize).toBe("string");
      expect(typeof overview.databaseSizeBytes).toBe("number");
      expect(overview.databaseSizeBytes).toBe(13107200);
      expect(typeof overview.tableCount).toBe("number");
      expect(overview.tableCount).toBe(2);
      expect(typeof overview.indexCount).toBe("number");
      expect(overview.indexCount).toBe(3);
      expect(overview.startTime).toBeInstanceOf(Date);
    });

    test("does not call a MariaDB server MySQL", async () => {
      mockExecuteFn = mariaDBMockExecute;

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      // The driver is mysql2 and the wire protocol is MySQL's, but the SERVER is not
      // MySQL and the panel must not assert that it is.
      expect(overview.version).not.toContain("MySQL");
      expect(overview.version).toContain("MariaDB");
      expect(overview.version).toContain("12.3.2");
    });

    test("leaves every measured self-identifying version string as the server gave it", async () => {
      // The exact strings WIRE_COMPATIBLE_ENGINES recorded from a live probe.
      const probed = ["12.3.2-MariaDB-ubu2404", "8.0.11-TiDB-v8.5.1", "8.0.43-Vitess", "5.7.25-OceanBase_CE-v4.4.2.1"];

      for (const version of probed) {
        mockExecuteFn = (sql: string) =>
          sql.trim().toLowerCase().includes("version()")
            ? Promise.resolve([[{ version }], [{ name: "version" }]])
            : defaultMockExecute(sql);

        provider = new MySQLProvider(makeMySQLConfig());
        await provider.connect();
        const overview = await provider.getOverview();
        await provider.disconnect();

        expect(overview.version).toBe(version);
      }
    });

    test("still names MySQL when the server does not name itself", async () => {
      // StarRocks answers VERSION() with a plain "5.1.0" and SingleStore with a
      // MySQL number too: there is nothing to key on, so the prefix stays.
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      expect(overview.version).toBe("MySQL 8.0.35");
    });

    test("formats uptime correctly", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const overview = await provider.getOverview();

      // 86400 seconds = 1 day
      expect(overview.uptime).toBe("1d 0h");
    });
  });

  // --------------------------------------------------------------------------
  // getPerformanceMetrics()
  // --------------------------------------------------------------------------

  describe("getPerformanceMetrics()", () => {
    test("returns cacheHitRatio, bufferPoolUsage, deadlocks, QPS", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      expect(typeof metrics.cacheHitRatio).toBe("number");
      expect(metrics.cacheHitRatio).toBeGreaterThanOrEqual(0);
      expect(metrics.cacheHitRatio).toBeLessThanOrEqual(100);
      expect(typeof metrics.bufferPoolUsage).toBe("number");
      // 800/1000 * 100 = 80
      expect(metrics.bufferPoolUsage).toBe(80);
      expect(typeof metrics.deadlocks).toBe("number");
      expect(metrics.deadlocks).toBe(0);
      expect(typeof metrics.queriesPerSecond).toBe("number");
      // 50000 / 86400 ≈ 0.58
      expect(metrics.queriesPerSecond).toBeGreaterThan(0);
    });

    test("omits the metrics performance_schema cannot answer when it is disabled", async () => {
      mockExecuteFn = perfSchemaDisabledMockExecute;

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      // ABSENCE and ZERO are different inputs (#448, #452). A server with
      // performance_schema off has measured nothing, so nothing is reported -
      // not a confident 99% hit ratio, not a 0% buffer pool, not 0 QPS.
      expect(metrics.cacheHitRatio).toBeUndefined();
      expect(metrics.bufferPoolUsage).toBeUndefined();
      expect(metrics.queriesPerSecond).toBeUndefined();

      // Deadlocks come from SHOW STATUS, which answers with or without
      // performance_schema, so this 0 is a measurement and stays.
      expect(metrics.deadlocks).toBe(0);
    });

    test("omits deadlocks on a server that does not publish Innodb_deadlocks", async () => {
      // `Innodb_deadlocks` is MariaDB's status variable. MySQL does not publish it -
      // measured as an empty SHOW STATUS result on both 8.0.46 and 26.7.0 - so the
      // old `parseInt(row?.Value || "0")` reported a deadlock count MySQL never gave.
      mockExecuteFn = (sql: string) =>
        sql.trim().toLowerCase().includes("show status like 'innodb_deadlocks'")
          ? Promise.resolve([[], []])
          : defaultMockExecute(sql);

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      expect(metrics.deadlocks).toBeUndefined();
      // The performance_schema readings are unaffected: still measured, still reported.
      expect(metrics.cacheHitRatio).toBe(99.5);
      expect(metrics.bufferPoolUsage).toBe(80);
    });

    test("omits every metric when the performance_schema query fails outright", async () => {
      mockExecuteFn = (sql: string) => {
        if (sql.trim().toLowerCase().includes("performance_schema")) {
          return Promise.reject(new Error("Table 'performance_schema.global_status' doesn't exist"));
        }
        return defaultMockExecute(sql);
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const metrics = await provider.getPerformanceMetrics();

      expect(metrics.cacheHitRatio).toBeUndefined();
      expect(metrics.bufferPoolUsage).toBeUndefined();
      expect(metrics.queriesPerSecond).toBeUndefined();
      expect(metrics.deadlocks).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // getSlowQueries()
  // --------------------------------------------------------------------------

  describe("getSlowQueries()", () => {
    test("returns slow query stats from performance_schema", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const slowQueries = await provider.getSlowQueries();

      expect(Array.isArray(slowQueries)).toBe(true);
      expect(slowQueries.length).toBeGreaterThan(0);

      const first = slowQueries[0];
      expect(typeof first.query).toBe("string");
      expect(first.query).toContain("SELECT");
      expect(typeof first.calls).toBe("number");
      expect(typeof first.totalTime).toBe("number");
      expect(typeof first.avgTime).toBe("number");
      expect(typeof first.rows).toBe("number");
    });

    test("respects limit option", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const slowQueries = await provider.getSlowQueries({ limit: 5 });

      // Our mock returns 1 row regardless of limit, but we verify the method accepts it
      expect(Array.isArray(slowQueries)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // getActiveSessions()
  // --------------------------------------------------------------------------

  describe("getActiveSessions()", () => {
    test("returns session list with pid, user, state, query", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const sessions = await provider.getActiveSessions();

      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBe(2);

      const first = sessions[0];
      expect(typeof first.pid).toBe("number");
      expect(first.pid).toBe(1);
      expect(typeof first.user).toBe("string");
      expect(first.user).toBe("root");
      expect(typeof first.state).toBe("string");
      expect(typeof first.query).toBe("string");
      expect(typeof first.duration).toBe("string");
      expect(typeof first.durationMs).toBe("number");
    });
  });

  // --------------------------------------------------------------------------
  // getTableStats()
  // --------------------------------------------------------------------------

  describe("getTableStats()", () => {
    test("returns table stats with sizes and row counts", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const stats = await provider.getTableStats();

      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBe(2);

      const first = stats[0];
      expect(typeof first.tableName).toBe("string");
      expect(first.tableName).toBe("users");
      expect(typeof first.rowCount).toBe("number");
      expect(first.rowCount).toBe(100);
      expect(typeof first.tableSize).toBe("string");
      expect(typeof first.tableSizeBytes).toBe("number");
      expect(first.tableSizeBytes).toBe(4096);
      expect(typeof first.indexSize).toBe("string");
      // The byte figure, not only the formatted string: the storage panel's index total is the sum
      // of these, and MySQL used to compute this number and drop it, so the panel read "N/A".
      expect(first.indexSizeBytes).toBe(2048);
      expect(typeof first.totalSize).toBe("string");
      expect(typeof first.totalSizeBytes).toBe("number");
      expect(first.totalSizeBytes).toBe(6144);
      expect(typeof first.schemaName).toBe("string");
      expect(typeof first.bloatRatio).toBe("number");
    });
  });

  // --------------------------------------------------------------------------
  // getIndexStats()
  // --------------------------------------------------------------------------

  describe("getIndexStats()", () => {
    test("returns index stats with scan counts", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const stats = await provider.getIndexStats();

      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBe(2);

      const primary = stats[0];
      expect(typeof primary.indexName).toBe("string");
      expect(primary.indexName).toBe("PRIMARY");
      expect(typeof primary.tableName).toBe("string");
      expect(primary.tableName).toBe("users");
      expect(typeof primary.indexType).toBe("string");
      expect(primary.indexType).toBe("BTREE");
      expect(Array.isArray(primary.columns)).toBe(true);
      expect(primary.columns).toContain("id");
      expect(typeof primary.isUnique).toBe("boolean");
      expect(primary.isUnique).toBe(true);
      expect(typeof primary.isPrimary).toBe("boolean");
      expect(primary.isPrimary).toBe(true);
      expect(typeof primary.scans).toBe("number");
      expect(primary.scans).toBe(100);
      expect(primary.indexSize).toBe("16 KB");
      expect(primary.indexSizeBytes).toBe(16384);
    });

    test("reports an index with no persistent-stats row as unavailable, not as zero bytes", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const stats = await provider.getIndexStats();

      // `users.idx_email` has no mysql.innodb_index_stats row (MyISAM tables and
      // never-analyzed InnoDB tables behave the same way on a live server).
      const secondary = stats[1];
      expect(secondary.indexName).toBe("idx_email");
      expect(secondary.indexSize).toBe("N/A");
      expect(secondary.indexSizeBytes).toBeUndefined();
    });

    test("reports every size as unavailable when the mysql schema is not readable", async () => {
      mockExecuteFn = (sql, params) => {
        if (sql.toLowerCase().includes("innodb_index_stats")) {
          return Promise.reject(new Error("SELECT command denied to user 'app'@'%' for table 'innodb_index_stats'"));
        }
        return defaultMockExecute(sql);
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const stats = await provider.getIndexStats();

      expect(stats.length).toBe(2);
      for (const index of stats) {
        expect(index.indexSize).toBe("N/A");
        expect(index.indexSizeBytes).toBeUndefined();
      }
    });

    test("looks the sizes up under the schema the server reported, not the one connected to", async () => {
      // Vitess answers information_schema.STATISTICS with the physical shard database
      // (`vt_testdb_0`) even though the filter named the keyspace.
      const sizeParams: unknown[][] = [];
      mockExecuteFn = (sql, params) => {
        const normalized = sql.toLowerCase();
        if (normalized.includes("information_schema.statistics") && normalized.includes("group_concat")) {
          return Promise.resolve([
            [
              {
                schema_name: "vt_testdb_0",
                table_name: "orders",
                index_name: "PRIMARY",
                index_type: "BTREE",
                columns: "id",
                is_unique: 1,
                is_primary: 1,
                cardinality: "3",
              },
            ],
            [],
          ]);
        }
        if (normalized.includes("innodb_index_stats")) {
          sizeParams.push(params ?? []);
          return Promise.resolve([
            [{ database_name: "vt_testdb_0", table_name: "orders", index_name: "PRIMARY", size_bytes: "16384" }],
            [],
          ]);
        }
        return defaultMockExecute(sql);
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const stats = await provider.getIndexStats();

      expect(sizeParams).toEqual([["vt_testdb_0"]]);
      expect(stats[0].indexSizeBytes).toBe(16384);
      expect(stats[0].indexSize).toBe("16 KB");
    });
  });

  // --------------------------------------------------------------------------
  // getStorageStats()
  // --------------------------------------------------------------------------

  describe("getStorageStats()", () => {
    test("returns innodb data and binary log sizes", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      const stats = await provider.getStorageStats();

      expect(Array.isArray(stats)).toBe(true);
      expect(stats.length).toBeGreaterThanOrEqual(1);

      // First item should be "Data"
      const dataEntry = stats.find((s) => s.name === "Data");
      expect(dataEntry).toBeDefined();
      expect(typeof dataEntry!.size).toBe("string");
      expect(typeof dataEntry!.sizeBytes).toBe("number");
      expect(dataEntry!.sizeBytes).toBe(13107200);

      // Binary Logs entry
      const binlogEntry = stats.find((s) => s.name === "Binary Logs");
      expect(binlogEntry).toBeDefined();
      expect(binlogEntry!.sizeBytes).toBe(1048576);

      // InnoDB entry
      const innodbEntry = stats.find((s) => s.name === "InnoDB");
      expect(innodbEntry).toBeDefined();
      expect(innodbEntry!.location).toContain("ibdata1");
    });
  });

  // --------------------------------------------------------------------------
  // Note: MySQLProvider does not expose a getPoolStats() method.
  // Pool stats are handled by the base provider if needed.
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // buildSSLConfig() (tested indirectly via connect)
  // --------------------------------------------------------------------------

  describe("buildSSLConfig()", () => {
    test("cloud provider auto-enables SSL", () => {
      // A cloud hostname should trigger SSL auto-enable
      provider = new MySQLProvider(
        makeMySQLConfig({
          host: "my-db.supabase.co",
        }),
      );
      // If no error during construction, SSL config was built
      expect(provider).toBeDefined();
    });

    test("explicit ssl mode disable", () => {
      provider = new MySQLProvider(
        makeMySQLConfig({
          ssl: { mode: "disable" },
        }),
      );
      // Should not throw — ssl disabled
      expect(provider).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // queryInTransaction()
  // --------------------------------------------------------------------------

  describe("queryInTransaction()", () => {
    test("executes query within active transaction", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();
      await provider.beginTransaction();

      const result = await provider.queryInTransaction("SELECT * FROM users");
      expect(result.rows).toBeArray();
      expect(result.rows.length).toBeGreaterThan(0);
      expect(typeof result.executionTime).toBe("number");

      await provider.commitTransaction();
    });

    test("throws when no active transaction", async () => {
      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      await expect(provider.queryInTransaction("SELECT 1")).rejects.toThrow("No active transaction");
    });
  });

  // --------------------------------------------------------------------------
  // prepareQuery()
  // --------------------------------------------------------------------------

  describe("prepareQuery()", () => {
    test("SELECT gets LIMIT appended", () => {
      provider = new MySQLProvider(makeMySQLConfig());
      const result = provider.prepareQuery("SELECT * FROM users");
      expect(result.query).toContain("LIMIT");
      expect(result.wasLimited).toBe(true);
    });

    test("non-SELECT passes through unchanged", () => {
      provider = new MySQLProvider(makeMySQLConfig());
      const sql = "INSERT INTO users (name) VALUES ('test')";
      const result = provider.prepareQuery(sql);
      expect(result.query).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    // `#` is MySQL's own second line-comment marker, and it is the reason
    // `lib/sql/leading-keyword.ts` skips such a run at all - on every dialect, since
    // none of them can OPEN a statement with one. Without it a `# note`-led SELECT
    // classified as an unknown statement type and reached the server with no LIMIT,
    // which is #275's reported symptom on this provider.
    test.each<[string, string]>([
      ["a hash comment", "# note\nSELECT * FROM users"],
      ["a line comment", "-- note\nSELECT * FROM users"],
      ["a block comment", "/* note */ SELECT * FROM users"],
    ])("SELECT behind %s still gets LIMIT appended", (_label, sql) => {
      provider = new MySQLProvider(makeMySQLConfig());
      const result = provider.prepareQuery(sql);

      expect(result.query).toContain("LIMIT");
      expect(result.wasLimited).toBe(true);
    });

    test("a hash comment does not make a write look like a read", () => {
      provider = new MySQLProvider(makeMySQLConfig());
      const sql = "# note\nUPDATE users SET name = 'x' WHERE id = 1";

      const result = provider.prepareQuery(sql);

      expect(result.query).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    // ── The `#` grammar is MySQL's here (#292) ────────────────────────────
    //
    // The shared readers used to decide `#` from the characters alone, and the
    // rule they settled on was PostgreSQL's: a hash whose next character makes a
    // jsonb/geometric operator is code. On THIS provider that reading is simply
    // wrong - every `#` opens a comment - and it cost a write its typing. The
    // provider now tells the readers which dialect they are reading, so these
    // assertions go through `prepareQuery`, the real caller, and pin the emitted
    // text rather than "a bound was added".

    describe("hash comments (#292)", () => {
      test("a comment hiding a paren does not retype the DELETE it precedes", () => {
        provider = new MySQLProvider(makeMySQLConfig());
        // `#-` reads as a jsonb operator to a dialect-blind scan, so the `)` inside
        // the comment closed the CTE body early and `SELECT` answered for the whole
        // statement - a bound on a DELETE, which MySQL 8 accepts and commits.
        const sql = "WITH t AS (\n  #- drop the ) SELECT here\n  SELECT id FROM logs\n) DELETE FROM users";

        const result = provider.prepareQuery(sql, { limit: 50 });

        expect(result.query).toBe(sql);
        expect(result.wasLimited).toBe(false);
      });

      test("a bound written after a hash is commented out, so a real one is added before it", () => {
        provider = new MySQLProvider(makeMySQLConfig());

        const result = provider.prepareQuery("SELECT * FROM t # LIMIT 10", { limit: 50 });

        expect(result.query).toBe("SELECT * FROM t LIMIT 50 # LIMIT 10");
        expect(result.wasLimited).toBe(true);
      });

      test("a hash inside a backtick-quoted name is part of the name", () => {
        provider = new MySQLProvider(makeMySQLConfig());

        const result = provider.prepareQuery("SELECT `a#b` FROM t", { limit: 50 });

        expect(result.query).toBe("SELECT `a#b` FROM t LIMIT 50");
        expect(result.wasLimited).toBe(true);
      });
    });
  });

  // --------------------------------------------------------------------------
  // error mapping
  // --------------------------------------------------------------------------

  describe("error mapping", () => {
    test("ER_ACCESS_DENIED maps to auth error", async () => {
      mockExecuteFn = async () => {
        throw new Error("ER_ACCESS_DENIED: Access denied for user");
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      try {
        await provider.query("SELECT 1");
        expect(true).toBe(false); // Should not reach here
      } catch (error: unknown) {
        expect(error).toBeDefined();
        const err = error as Error;
        expect(err.message).toContain("Access denied");
      }
    });

    test("connection error on query throws", async () => {
      mockExecuteFn = async () => {
        throw new Error("ECONNREFUSED: Connection refused");
      };

      provider = new MySQLProvider(makeMySQLConfig());
      await provider.connect();

      try {
        await provider.query("SELECT 1");
        expect(true).toBe(false); // Should not reach here
      } catch (error: unknown) {
        expect(error).toBeDefined();
        const err = error as Error;
        expect(err.message).toContain("ECONNREFUSED");
      }
    });
  });
});
