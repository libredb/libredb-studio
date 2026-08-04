/**
 * Integration tests for SQLiteProvider
 * Uses real drivers with real databases — no mocking needed:
 * - bun driver: bun:sqlite with a :memory: database (in-process, tests run under Bun)
 * - node driver: node:sqlite against a temp on-disk file, exercised in a real
 *   `node` subprocess (Bun cannot load any non-bun SQLite driver in-process),
 *   forced deterministically via LIBREDB_SQLITE_DRIVER=node
 */

import { describe, test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { SQLiteProvider } from "@/lib/db/providers/sql/sqlite";
import { resolveSQLiteDriverName } from "@/lib/db/providers/sql/sqlite-driver";
import type { DatabaseConnection } from "@/lib/types";
import { DatabaseConfigError } from "@/lib/db/errors";

// ============================================================================
// Helpers
// ============================================================================

function makeSQLiteConfig(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "test-sqlite",
    name: "Test SQLite",
    type: "sqlite",
    database: ":memory:",
    createdAt: new Date(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("SQLiteProvider", () => {
  let provider: SQLiteProvider;

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
    test("missing database throws DatabaseConfigError", () => {
      expect(() => {
        new SQLiteProvider(makeSQLiteConfig({ database: undefined }));
      }).toThrow(DatabaseConfigError);
    });

    test("valid config with :memory: passes validation", () => {
      expect(() => {
        new SQLiteProvider(makeSQLiteConfig());
      }).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Connection lifecycle
  // --------------------------------------------------------------------------

  describe("connect / disconnect", () => {
    test("connect to :memory: sets isConnected to true", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      expect(provider.isConnected()).toBe(false);
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test("disconnect sets isConnected to false", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      await provider.disconnect();
      expect(provider.isConnected()).toBe(false);
    });

    test("double connect is idempotent", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Database path handling (#125)
  // --------------------------------------------------------------------------

  describe("getDatabasePath() via connect()", () => {
    let pathTmpDir: string;

    beforeAll(() => {
      pathTmpDir = mkdtempSync(join(tmpdir(), "libredb-sqlite-path-"));
    });

    afterAll(() => {
      rmSync(pathTmpDir, { recursive: true, force: true });
    });

    test("a path containing a NUL byte throws DatabaseConfigError without claiming traversal protection", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig({ database: "data/evil\0.db" }));
      const error = await provider.connect().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DatabaseConfigError);
      const message = (error as Error).message;
      expect(message).toContain("NUL");
      // The only path validation is NUL rejection; the message must not promise
      // traversal protection the code does not provide.
      expect(message.toLowerCase()).not.toContain("traversal");
    });

    test("a relative path with '..' segments is accepted and resolves to an absolute location", async () => {
      // Pins intended behavior: sqlite paths are trusted server-side paths, so
      // ".." segments are legal and simply resolve against the process cwd.
      const relPath = relative(process.cwd(), join(pathTmpDir, "dotdot-ok.db"));
      expect(isAbsolute(relPath)).toBe(false);
      expect(relPath).toContain("..");

      provider = new SQLiteProvider(makeSQLiteConfig({ database: relPath }));
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
      // The database file materializes at the resolved absolute location.
      expect(existsSync(join(pathTmpDir, "dotdot-ok.db"))).toBe(true);
    });

    test("a connectionString with a file: prefix is accepted and the prefix is stripped", async () => {
      const dbPath = join(pathTmpDir, "conn-string-file.db");
      provider = new SQLiteProvider(makeSQLiteConfig({ database: undefined, connectionString: `file:${dbPath}` }));
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
      const result = await provider.query("SELECT 1 AS one");
      expect(result.rows).toEqual([{ one: 1 }]);
      expect(existsSync(dbPath)).toBe(true);
    });

    test("a plain-path connectionString (no file: prefix) is used as-is", async () => {
      const dbPath = join(pathTmpDir, "conn-string-plain.db");
      provider = new SQLiteProvider(makeSQLiteConfig({ database: undefined, connectionString: dbPath }));
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
      expect(existsSync(dbPath)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Query execution
  // --------------------------------------------------------------------------

  describe("query()", () => {
    test("CREATE TABLE + INSERT + SELECT works end-to-end", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      // Create table
      await provider.query("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)");

      // Insert rows
      await provider.query("INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@example.com')");
      await provider.query("INSERT INTO users (id, name, email) VALUES (2, 'Bob', 'bob@example.com')");

      // Select all
      const result = await provider.query("SELECT * FROM users");
      expect(result.rows.length).toBe(2);
      expect(result.fields).toEqual(["id", "name", "email"]);
      expect(result.rowCount).toBe(2);
      expect(typeof result.executionTime).toBe("number");
    });

    test("SELECT returns correct row data", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, price REAL)");
      await provider.query("INSERT INTO items VALUES (1, 'Widget', 9.99)");

      const result = await provider.query("SELECT * FROM items WHERE id = 1");
      expect(result.rows.length).toBe(1);
      const row = result.rows[0] as Record<string, unknown>;
      expect(row.id).toBe(1);
      expect(row.name).toBe("Widget");
      expect(row.price).toBe(9.99);
    });

    test("INSERT returns rowCount as changes", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");
      const result = await provider.query("INSERT INTO test VALUES (1, 'a')");
      expect(result.rowCount).toBe(1);
    });

    test("bound parameters work for both writes and reads", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query("CREATE TABLE params (id INTEGER PRIMARY KEY, name TEXT)");
      const insert = await provider.query("INSERT INTO params (id, name) VALUES (?, ?)", [1, "Ann"]);
      expect(insert.rowCount).toBe(1);

      const select = await provider.query("SELECT * FROM params WHERE id = ?", [1]);
      expect(select.rows).toEqual([{ id: 1, name: "Ann" }]);
    });

    test("SELECT with no matching rows returns empty rows and fields", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query("CREATE TABLE empty_result (id INTEGER PRIMARY KEY)");
      const result = await provider.query("SELECT * FROM empty_result WHERE id = 999");
      expect(result.rows).toEqual([]);
      expect(result.fields).toEqual([]);
      expect(result.rowCount).toBe(0);
    });

    // The provider picks `all()` vs `run()` from `isReadOnlyQuery`, so a SELECT
    // misread as a write used to come back with no rows and `changes: 0` - the
    // same comment-blind classification as the missing LIMIT in #275, with a
    // worse symptom: the user sees an empty grid for a query that has data.
    test("a comment-led SELECT returns its rows instead of an empty write result", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
      await provider.query("INSERT INTO notes VALUES (1, 'first'), (2, 'second')");

      const result = await provider.query("-- annotated\nSELECT * FROM notes ORDER BY id");

      expect(result.rows.length).toBe(2);
      expect(result.fields).toEqual(["id", "body"]);
      expect(result.rowCount).toBe(2);
      expect((result.rows[0] as Record<string, unknown>).body).toBe("first");
    });

    test("query against a missing table is mapped through mapDatabaseError", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await expect(provider.query("SELECT * FROM missing_table")).rejects.toThrow("no such table");
    });
  });

  // --------------------------------------------------------------------------
  // Capabilities
  // --------------------------------------------------------------------------

  describe("getCapabilities()", () => {
    test("returns correct SQLite capabilities", () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      const caps = provider.getCapabilities();

      expect(caps.defaultPort).toBeNull();
      expect(caps.queryLanguage).toBe("sql");
      expect(caps.supportsExplain).toBe(true);
      expect(caps.explainFormat).toBe("sqlite-queryplan");
      expect(caps.supportsExplain).toBe(caps.explainFormat !== undefined);
      expect(caps.supportsConnectionString).toBe(false);
      // `UPDATE t SET c = v WHERE pk = v` is core SQLite DML — the shape the inline
      // row editor builds (#269).
      expect(caps.supportsInlineRowEdit).toBe(true);
      expect(caps.maintenanceOperations).toContain("vacuum");
      expect(caps.maintenanceOperations).toContain("analyze");
      expect(caps.maintenanceOperations).toContain("reindex");
      expect(caps.maintenanceOperations).toContain("check");
    });
  });

  // --------------------------------------------------------------------------
  // Schema
  // --------------------------------------------------------------------------

  describe("getSchema()", () => {
    test("returns correct schema after CREATE TABLE", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await provider.query("CREATE INDEX idx_users_email ON users(email)");

      const schema = await provider.getSchema();
      expect(schema.length).toBe(1);

      const table = schema[0];
      expect(table.name).toBe("users");
      expect(table.columns.length).toBe(4);

      // Check column properties
      const idCol = table.columns.find((c) => c.name === "id")!;
      expect(idCol.type).toBe("INTEGER");
      expect(idCol.isPrimary).toBe(true);

      const nameCol = table.columns.find((c) => c.name === "name")!;
      expect(nameCol.nullable).toBe(false);

      const emailCol = table.columns.find((c) => c.name === "email")!;
      expect(emailCol.nullable).toBe(true);

      // Check indexes
      expect(table.indexes.length).toBeGreaterThanOrEqual(1);
      const emailIdx = table.indexes.find((i) => i.name === "idx_users_email");
      expect(emailIdx).toBeDefined();
      expect(emailIdx!.columns).toContain("email");
    });

    test("schema includes foreign keys", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query("CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT)");
      await provider.query(`
        CREATE TABLE books (
          id INTEGER PRIMARY KEY,
          title TEXT,
          author_id INTEGER REFERENCES authors(id)
        )
      `);

      const schema = await provider.getSchema();
      const books = schema.find((t) => t.name === "books")!;
      expect(books.foreignKeys).toBeDefined();
      expect(books.foreignKeys!.length).toBe(1);
      expect(books.foreignKeys![0].columnName).toBe("author_id");
      expect(books.foreignKeys![0].referencedTable).toBe("authors");
      expect(books.foreignKeys![0].referencedColumn).toBe("id");
    });
  });

  // --------------------------------------------------------------------------
  // Health
  // --------------------------------------------------------------------------

  describe("getHealth()", () => {
    test("returns health info with integrity check OK", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      const health = await provider.getHealth();
      expect(health.activeConnections).toBe(1);
      expect(typeof health.databaseSize).toBe("string");
      expect(typeof health.cacheHitRatio).toBe("string");
      expect(Array.isArray(health.slowQueries)).toBe(true);
      expect(Array.isArray(health.activeSessions)).toBe(true);

      // Integrity check should appear in slowQueries info
      const integrityInfo = health.slowQueries.find((sq) => sq.query.includes("Integrity"));
      expect(integrityInfo).toBeDefined();
      expect(integrityInfo!.query).toContain("OK");
    });
  });

  // --------------------------------------------------------------------------
  // Maintenance
  // --------------------------------------------------------------------------

  describe("runMaintenance()", () => {
    test("vacuum succeeds", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      const result = await provider.runMaintenance("vacuum");
      expect(result.success).toBe(true);
      expect(typeof result.executionTime).toBe("number");
      expect(result.message).toContain("VACUUM");
    });

    test("analyze succeeds", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      const result = await provider.runMaintenance("analyze");
      expect(result.success).toBe(true);
      expect(result.message).toContain("ANALYZE");
    });

    test("check returns integrity result (ok)", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      const result = await provider.runMaintenance("check");
      expect(result.success).toBe(true);
      expect(result.message).toBe("ok");
    });

    test("reindex succeeds", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      await provider.query("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");
      await provider.query("CREATE INDEX idx_val ON test(val)");
      const result = await provider.runMaintenance("reindex");
      expect(result.success).toBe(true);
      expect(result.message).toContain("REINDEX");
    });

    test("unsupported type throws QueryError", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      await expect(provider.runMaintenance("kill" as unknown as "analyze")).rejects.toThrow(
        "Unsupported maintenance type for SQLite",
      );
    });

    test("analyze with a target table succeeds", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      await provider.query("CREATE TABLE mt (id INTEGER PRIMARY KEY, v TEXT)");
      const result = await provider.runMaintenance("analyze", "mt");
      expect(result.success).toBe(true);
      expect(result.message).toContain("ANALYZE");
    });

    test("reindex with a target index succeeds", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      await provider.query("CREATE TABLE mt (id INTEGER PRIMARY KEY, v TEXT)");
      await provider.query("CREATE INDEX idx_mt_v ON mt(v)");
      const result = await provider.runMaintenance("reindex", "idx_mt_v");
      expect(result.success).toBe(true);
      expect(result.message).toContain("REINDEX");
    });
  });

  // --------------------------------------------------------------------------
  // Overview
  // --------------------------------------------------------------------------

  describe("getOverview()", () => {
    test("returns SQLite version, tableCount, indexCount", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query("CREATE TABLE t1 (id INTEGER PRIMARY KEY)");
      await provider.query("CREATE TABLE t2 (id INTEGER PRIMARY KEY, ref INTEGER)");
      await provider.query("CREATE INDEX idx_ref ON t2(ref)");

      const overview = await provider.getOverview();
      expect(overview.version).toContain("SQLite");
      expect(overview.tableCount).toBe(2);
      expect(overview.indexCount).toBe(1);
      expect(typeof overview.databaseSize).toBe("string");
      expect(typeof overview.databaseSizeBytes).toBe("number");
      expect(overview.activeConnections).toBe(1);
      expect(overview.maxConnections).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Performance metrics
  // --------------------------------------------------------------------------

  describe("getPerformanceMetrics()", () => {
    test("returns cacheHitRatio as a number", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      const perf = await provider.getPerformanceMetrics();
      expect(typeof perf.cacheHitRatio).toBe("number");
      expect(perf.cacheHitRatio).toBeGreaterThanOrEqual(0);
      expect(perf.deadlocks).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Active sessions
  // --------------------------------------------------------------------------

  describe("getActiveSessions()", () => {
    test("returns single session with process pid", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      const sessions = await provider.getActiveSessions();
      expect(sessions.length).toBe(1);

      const session = sessions[0];
      expect(session.pid).toBe(process.pid);
      expect(session.user).toBe("sqlite");
      expect(session.state).toBe("active");
    });
  });

  // --------------------------------------------------------------------------
  // Slow queries
  // --------------------------------------------------------------------------

  describe("getSlowQueries()", () => {
    test("returns empty array (SQLite has no slow query stats)", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      const slow = await provider.getSlowQueries();
      expect(slow).toBeArray();
    });
  });

  // --------------------------------------------------------------------------
  // Table stats
  // --------------------------------------------------------------------------

  describe("getTableStats()", () => {
    test("returns table stats for created tables", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
      await provider.query("INSERT INTO users VALUES (1, 'Alice')");
      await provider.query("INSERT INTO users VALUES (2, 'Bob')");

      const stats = await provider.getTableStats();
      expect(stats).toBeArray();

      const usersStats = stats.find((s) => s.tableName === "users");
      expect(usersStats).toBeDefined();
      expect(typeof usersStats!.tableName).toBe("string");
    });
  });

  // --------------------------------------------------------------------------
  // Index stats
  // --------------------------------------------------------------------------

  describe("getIndexStats()", () => {
    test("returns index info for created indexes", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, code TEXT)");
      await provider.query("CREATE INDEX idx_name ON items(name)");
      await provider.query("CREATE UNIQUE INDEX idx_code ON items(code)");

      const stats = await provider.getIndexStats();
      expect(stats).toBeArray();
      expect(stats.length).toBeGreaterThanOrEqual(2);
    });
  });

  // --------------------------------------------------------------------------
  // Storage stats
  // --------------------------------------------------------------------------

  describe("getStorageStats()", () => {
    test("returns storage info", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      const stats = await provider.getStorageStats();
      expect(stats).toBeArray();
      expect(stats.length).toBeGreaterThan(0);
      expect(typeof stats[0].name).toBe("string");
      expect(typeof stats[0].size).toBe("string");
    });
  });

  // --------------------------------------------------------------------------
  // File-backed database (statSync paths + WAL/SHM sidecar files)
  // --------------------------------------------------------------------------

  describe("file-backed database", () => {
    let fileTmpDir: string;

    beforeAll(() => {
      fileTmpDir = mkdtempSync(join(tmpdir(), "libredb-sqlite-file-"));
    });

    afterAll(() => {
      rmSync(fileTmpDir, { recursive: true, force: true });
    });

    test("getHealth reports the on-disk file size and passes the integrity check", async () => {
      const dbPath = join(fileTmpDir, "health.db");
      provider = new SQLiteProvider(makeSQLiteConfig({ database: dbPath }));
      await provider.connect();
      await provider.query("CREATE TABLE h (id INTEGER PRIMARY KEY)");

      const health = await provider.getHealth();
      expect(health.databaseSize).not.toBe("N/A");
      expect(health.databaseSize).not.toBe("Unknown");
      const integrityInfo = health.slowQueries.find((sq) => sq.query.includes("Integrity"));
      expect(integrityInfo!.query).toContain("OK");
      expect(health.activeSessions[0].database).toBe("health.db");
    });

    test("getOverview reads the database size from the file", async () => {
      const dbPath = join(fileTmpDir, "overview.db");
      provider = new SQLiteProvider(makeSQLiteConfig({ database: dbPath }));
      await provider.connect();
      await provider.query("CREATE TABLE o (id INTEGER PRIMARY KEY)");

      const overview = await provider.getOverview();
      expect(overview.databaseSizeBytes).toBeGreaterThan(0);
      expect(overview.tableCount).toBe(1);
    });

    test("getStorageStats lists the main database plus WAL and SHM sidecar files", async () => {
      const dbPath = join(fileTmpDir, "storage.db");
      provider = new SQLiteProvider(makeSQLiteConfig({ database: dbPath }));
      await provider.connect();
      // A write in WAL journal mode materializes the -wal and -shm files.
      await provider.query("CREATE TABLE s (id INTEGER PRIMARY KEY, v TEXT)");
      await provider.query("INSERT INTO s VALUES (1, 'x')");

      const stats = await provider.getStorageStats();
      const names = stats.map((s) => s.name);
      expect(names).toContain("Main Database");
      expect(names).toContain("WAL");
      expect(names).toContain("Shared Memory");

      const main = stats.find((s) => s.name === "Main Database")!;
      expect(main.location).toBe("storage.db");
      const wal = stats.find((s) => s.name === "WAL")!;
      expect(wal.location).toBe("storage.db-wal");
      expect(typeof wal.walSizeBytes).toBe("number");
    });
  });

  // --------------------------------------------------------------------------
  // Monitoring data (via base getMonitoringData)
  // --------------------------------------------------------------------------

  describe("getMonitoringData()", () => {
    test("returns monitoring data with all sections", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query("CREATE TABLE md_test (id INTEGER PRIMARY KEY)");

      const data = await provider.getMonitoringData();
      expect(data.timestamp).toBeInstanceOf(Date);
      expect(data.overview).toBeDefined();
      expect(data.performance).toBeDefined();
      expect(data.slowQueries).toBeArray();
      expect(data.activeSessions).toBeArray();
    });
  });

  // --------------------------------------------------------------------------
  // prepareQuery
  // --------------------------------------------------------------------------

  describe("prepareQuery()", () => {
    test("SELECT gets LIMIT appended", () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      const result = provider.prepareQuery("SELECT * FROM users");
      expect(result.wasLimited).toBe(true);
      expect(result.query).toContain("LIMIT");
    });

    test("non-SELECT passes through unchanged", () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      const sql = "INSERT INTO users VALUES (1, 'test')";
      const result = provider.prepareQuery(sql);
      expect(result.query).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Labels
  // --------------------------------------------------------------------------

  describe("getLabels()", () => {
    test("returns correct SQLite labels", () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      const labels = provider.getLabels();
      expect(labels.entityName).toBe("Table");
      expect(typeof labels.selectAction).toBe("string");
    });
  });
});

// ============================================================================
// Driver selection (sqlite-driver adapter)
// ============================================================================

describe("resolveSQLiteDriverName()", () => {
  const originalDriverEnv = process.env.LIBREDB_SQLITE_DRIVER;

  afterEach(() => {
    if (originalDriverEnv === undefined) {
      delete process.env.LIBREDB_SQLITE_DRIVER;
    } else {
      process.env.LIBREDB_SQLITE_DRIVER = originalDriverEnv;
    }
  });

  test("defaults to the bun driver under the Bun runtime", () => {
    delete process.env.LIBREDB_SQLITE_DRIVER;
    expect(resolveSQLiteDriverName()).toBe("bun");
  });

  test("LIBREDB_SQLITE_DRIVER=node forces the node driver", () => {
    process.env.LIBREDB_SQLITE_DRIVER = "node";
    expect(resolveSQLiteDriverName()).toBe("node");
  });

  test("LIBREDB_SQLITE_DRIVER=bun forces the bun driver", () => {
    process.env.LIBREDB_SQLITE_DRIVER = "bun";
    expect(resolveSQLiteDriverName()).toBe("bun");
  });

  test("invalid override falls back to runtime detection", () => {
    process.env.LIBREDB_SQLITE_DRIVER = "sqlite3";
    expect(resolveSQLiteDriverName()).toBe("bun");
  });

  test("provider connects and queries with an explicit LIBREDB_SQLITE_DRIVER=bun override", async () => {
    process.env.LIBREDB_SQLITE_DRIVER = "bun";
    const provider = new SQLiteProvider({
      id: "override-bun",
      name: "Override Bun",
      type: "sqlite",
      database: ":memory:",
      createdAt: new Date(),
    });
    try {
      await provider.connect();
      const result = await provider.query("SELECT 1 AS one");
      expect(result.rows).toEqual([{ one: 1 }]);
    } finally {
      await provider.disconnect();
    }
  });
});

// ============================================================================
// Node driver (LIBREDB_SQLITE_DRIVER=node -> node:sqlite)
//
// Bun refuses to load better-sqlite3 and does not implement node:sqlite, so
// no non-bun driver can run inside `bun test`. The core CRUD / schema /
// maintenance / error-mapping cases therefore run in a real `node` subprocess:
// sqlite-node-harness.ts is bundled with `bun build --target=node` and
// executed with LIBREDB_SQLITE_DRIVER=node against a temp on-disk database
// (see the harness for the exact scenario).
// ============================================================================

const nodeSqliteProbe = spawnSync(
  "node",
  ["-e", "import('node:sqlite').then(() => process.exit(0), () => process.exit(1))"],
  { timeout: 30_000 },
);
const nodeDriverTestable = nodeSqliteProbe.status === 0;
if (!nodeDriverTestable) {
  console.warn("Skipping node-driver SQLite tests: `node` with node:sqlite is not available on this machine");
}

describe.skipIf(!nodeDriverTestable)("SQLiteProvider with LIBREDB_SQLITE_DRIVER=node (node:sqlite)", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "libredb-sqlite-node-"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("core CRUD, schema, maintenance, and error mapping work under Node", () => {
    const harnessEntry = join(import.meta.dir, "sqlite-node-harness.ts");
    const bundlePath = join(tmpDir, "sqlite-node-harness.mjs");
    const dbPath = join(tmpDir, "harness.db");

    // Bundle the harness (and the provider under test) for the Node runtime.
    const build = spawnSync(
      process.execPath,
      ["build", harnessEntry, "--target=node", "--format=esm", "--external", "bun:sqlite", "--outfile", bundlePath],
      { timeout: 60_000 },
    );
    if (build.status !== 0) {
      throw new Error(`bun build failed: ${build.stderr?.toString()}`);
    }

    // Run it under real Node with the node driver forced.
    const run = spawnSync("node", [bundlePath, dbPath], {
      env: { ...process.env, LIBREDB_SQLITE_DRIVER: "node" },
      timeout: 60_000,
    });
    if (run.status !== 0) {
      throw new Error(`node harness failed: ${run.stderr?.toString()}`);
    }

    const report = JSON.parse(run.stdout.toString()) as Record<string, unknown>;

    // Runtime and connection lifecycle
    expect(report.runtime).toBe("node");
    expect(report.driverEnv).toBe("node");
    expect(report.connected).toBe(true);
    expect(report.disconnected).toBe(true);
    expect(existsSync(dbPath)).toBe(true); // real file-backed database

    // CRUD (same results as the bun driver)
    expect(report.insertRowCount).toBe(1);
    expect(report.selectFields).toEqual(["id", "name", "email"]);
    expect(report.selectRows).toEqual([
      { id: 1, name: "Alice", email: "alice@example.com" },
      { id: 2, name: "Bob", email: "bob@example.com" },
    ]);
    expect(report.updateRowCount).toBe(1);
    expect(report.deleteRowCount).toBe(1);

    // Schema introspection
    const schema = report.schema as Array<{
      name: string;
      rowCount: number;
      columns: Array<{ name: string; isPrimary: boolean; nullable: boolean }>;
      indexes: string[];
      foreignKeys: Array<{ columnName: string; referencedTable: string; referencedColumn: string }>;
    }>;
    const users = schema.find((t) => t.name === "users")!;
    expect(users).toBeDefined();
    expect(users.rowCount).toBe(1);
    expect(users.columns.find((c) => c.name === "id")!.isPrimary).toBe(true);
    expect(users.columns.find((c) => c.name === "name")!.nullable).toBe(false);
    expect(users.indexes).toContain("idx_users_email");
    const books = schema.find((t) => t.name === "books")!;
    expect(books.foreignKeys).toEqual([{ columnName: "user_id", referencedTable: "users", referencedColumn: "id" }]);

    // Maintenance + monitoring
    expect(report.maintenanceCheck).toEqual({ success: true, message: "ok" });
    expect(report.vacuumSuccess).toBe(true);
    expect(report.version).toContain("SQLite");
    expect(report.tableCount).toBe(2);
    expect(report.integrity).toContain("OK");

    // Error mapping (same mapDatabaseError path as the bun driver)
    expect(report.queryErrorName).toBe("DatabaseError");
    expect(report.queryErrorMessage).toContain("no such table");
  });
});
