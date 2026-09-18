/**
 * Integration tests for SQLiteProvider
 * Uses real drivers with real databases — no mocking needed:
 * - bun driver: bun:sqlite with a :memory: database (in-process, tests run under Bun)
 * - node driver: node:sqlite against a temp on-disk file, exercised in a real
 *   `node` subprocess (Bun cannot load any non-bun SQLite driver in-process),
 *   forced deterministically via LIBREDB_SQLITE_DRIVER=node
 */

import { describe, test, expect, afterEach, beforeAll, afterAll, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

/** The repository root, anchored to this file so nothing here depends on the launcher's cwd. */
const REPO_ROOT = resolve(import.meta.dir, "../../..");
import {
  SQLiteProvider,
  assertQueryOnlyEnabled,
  buildTableStats,
  readDbstatSizes,
} from "@/lib/db/providers/sql/sqlite";
import { resolveSQLiteDriverName } from "@/lib/db/providers/sql/sqlite-driver";
import {
  containerDepth,
  declaredKinds,
  isCountUnavailable,
  isSourcePartUnavailable,
  sourceBoundTruncationReason,
} from "@/lib/db/object-kinds";
import { flattenTree } from "@/components/object-tree/flatten";
import type { SQLiteDatabase, SQLiteStatement } from "@/lib/db/providers/sql/sqlite-driver";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
import { rowBudgetIn } from "@/lib/agent/context-snapshot";
import type { DatabaseConnection } from "@/lib/types";
import type { ObjectKindSpec, ReadOnlyStatementBudget } from "@/lib/db/types";
import {
  ConnectionError,
  DatabaseConfigError,
  DatabaseError,
  ExecutionProfileError,
  QueryError,
} from "@/lib/db/errors";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";
import { comparePaths } from "@/lib/db/object-path";
import { readFixtureStatements } from "../../../docker/sqlite-init/build-fixture";

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

/**
 * Whether the SQLite build behind the running driver carries `dbstat`.
 *
 * `dbstat` sits behind SQLITE_ENABLE_DBSTAT_VTAB, a COMPILE-TIME option, so its presence
 * is a property of the build and not of the driver's name: two Bun releases on two
 * platforms disagree about it. Asked here rather than assumed, so the size tests pin the
 * arm the build is actually on instead of the arm one machine happened to be on.
 */
async function hasDbstat(db: SQLiteProvider): Promise<boolean> {
  try {
    await db.query("SELECT 1 FROM dbstat LIMIT 1");
    return true;
  } catch {
    return false;
  }
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
    let sameVolumeTmpDir: string;

    beforeAll(() => {
      pathTmpDir = mkdtempSync(join(tmpdir(), "libredb-sqlite-path-"));
      // A second fixture directory, deliberately on the same volume as the process cwd: the
      // relative-path test below needs path.relative(cwd, target) to BE relative, and on Windows a
      // clone on D: with %TEMP% on C: makes that impossible to express, so path.relative hands
      // back the absolute target and the test fails on that machine only. node_modules/.cache is
      // ignored by the VCS, so nothing here is visible to a working-tree drift guard.
      const cache = join(REPO_ROOT, "node_modules", ".cache");
      mkdirSync(cache, { recursive: true });
      sameVolumeTmpDir = mkdtempSync(join(cache, "libredb-sqlite-path-"));
    });

    afterAll(() => {
      rmSync(pathTmpDir, { recursive: true });
      rmSync(sameVolumeTmpDir, { recursive: true });
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
      // The ".." is built explicitly, by leaving the working directory and coming straight back
      // into it, rather than by pointing at a directory outside the tree and letting
      // path.relative produce the hops. That used to be a path under the system temp directory:
      // on Windows a clone on D: with %TEMP% on C: has no relative spelling at all, so
      // path.relative returns the absolute target and the assertion below fails on that machine
      // only. This form carries the same ".." segments on every platform.
      const target = join(sameVolumeTmpDir, "dotdot-ok.db");
      const cwd = process.cwd();
      const relPath = join("..", basename(cwd), relative(cwd, target));
      expect(isAbsolute(relPath)).toBe(false);
      expect(relPath).toContain("..");
      expect(resolve(relPath)).toBe(target);

      provider = new SQLiteProvider(makeSQLiteConfig({ database: relPath }));
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
      // The database file materializes at the resolved absolute location.
      expect(existsSync(join(sameVolumeTmpDir, "dotdot-ok.db"))).toBe(true);
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
  // A transaction left open on the handle (D71)
  // --------------------------------------------------------------------------

  describe("endOpenQueryTransaction()", () => {
    test("rolls back a transaction a statement left open on this handle", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      await provider.query("CREATE TABLE t (id INTEGER)");

      await provider.query("BEGIN");
      await provider.query("INSERT INTO t VALUES (1)");

      expect(await provider.endOpenQueryTransaction()).toBe("rolled-back");

      const after = await provider.query("SELECT count(*) AS n FROM t");
      expect((after.rows[0] as Record<string, unknown>).n).toBe(0);
    });

    test("answers none when no transaction is open, instead of raising", async () => {
      // The reason the route cannot simply issue ROLLBACK. Measured on
      // bun:sqlite 1.4.2: a ROLLBACK with no transaction active throws
      // "cannot rollback - no transaction is active", so an unconditional
      // rollback would report an error on every script that ended cleanly.
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      expect(await provider.endOpenQueryTransaction()).toBe("none");
      await expect(provider.query("ROLLBACK")).rejects.toThrow("cannot rollback - no transaction is active");
    });

    test("leaves a committed transaction alone", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      await provider.query("CREATE TABLE t (id INTEGER)");

      await provider.query("BEGIN");
      await provider.query("INSERT INTO t VALUES (1)");
      await provider.query("COMMIT");

      expect(await provider.endOpenQueryTransaction()).toBe("none");
      const after = await provider.query("SELECT count(*) AS n FROM t");
      expect((after.rows[0] as Record<string, unknown>).n).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Capabilities
  // --------------------------------------------------------------------------

  describe("getCapabilities()", () => {
    // #U9: VACUUM rewrites the whole file and `runMaintenance` ignores the target, so
    // the per-table control named one table and acted on the database. The same is
    // true of PRAGMA integrity_check.
    test("declares the target grammar of every maintenance operation", () => {
      const caps = new SQLiteProvider(makeSQLiteConfig()).getCapabilities();

      expect(caps.maintenanceOperationSpecs).toEqual({
        vacuum: { label: "Vacuum Database", perEntity: false, global: true },
        analyze: { label: "Analyze Table", perEntity: true, global: true },
        reindex: { label: "Reindex Table", perEntity: true, global: true },
        check: { label: "Integrity Check", perEntity: false, global: true },
      });
      expect(Object.keys(caps.maintenanceOperationSpecs ?? {}).sort()).toEqual([...caps.maintenanceOperations].sort());
    });
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
      // False although SQLite HAS transactions: this provider holds no session for
      // one, so POST /api/db/transaction refuses the call and the controls must not
      // be offered (#464). The flag describes the provider's surface, not the engine.
      expect(caps.supportsTransactions).toBe(false);
      // Inherited from the base capabilities: this engine declares foreign keys, so
      // an empty `foreignKeys` list is a fact about the schema or the role, never
      // about the engine (#414).
      expect(caps.declaresForeignKeys).toBe(true);
      expect(caps.maintenanceOperations).toContain("vacuum");
      expect(caps.maintenanceOperations).toContain("analyze");
      expect(caps.maintenanceOperations).toContain("reindex");
      expect(caps.maintenanceOperations).toContain("check");
    });
  });

  // --------------------------------------------------------------------------
  // Schema
  // --------------------------------------------------------------------------

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
      // Not "100" and not "95": the health card says the ratio is unmeasurable
      // here in the same word every other provider uses for it.
      expect(health.cacheHitRatio).toBe(CACHE_HIT_RATIO_UNAVAILABLE);
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

    test("analyze does not execute a statement smuggled through the target identifier", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      await provider.query("CREATE TABLE mt (id INTEGER PRIMARY KEY, v TEXT)");
      await provider.query("CREATE TABLE victim (id INTEGER PRIMARY KEY)");

      // The target is quoted, so a `"` inside it must be doubled rather than closing the
      // identifier. Unescaped, this becomes: ANALYZE "mt"; DROP TABLE victim; --"
      await provider.runMaintenance("analyze", 'mt"; DROP TABLE victim; --').catch(() => undefined);

      const tables = await provider.query("SELECT name FROM sqlite_master WHERE type='table' AND name='victim'");
      expect(tables.rows.length).toBe(1);
    });

    test("reindex does not execute a statement smuggled through the target identifier", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();
      await provider.query("CREATE TABLE mt (id INTEGER PRIMARY KEY, v TEXT)");
      await provider.query("CREATE INDEX idx_mt_v ON mt(v)");
      await provider.query("CREATE TABLE victim (id INTEGER PRIMARY KEY)");

      await provider.runMaintenance("reindex", 'idx_mt_v"; DROP TABLE victim; --').catch(() => undefined);

      const tables = await provider.query("SELECT name FROM sqlite_master WHERE type='table' AND name='victim'");
      expect(tables.rows.length).toBe(1);
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
    // The previous assertion here was `typeof perf.cacheHitRatio === "number"`,
    // which is exactly what pinned the invented figure in place: the provider
    // read `PRAGMA cache_size` (a configuration value, `-2000` by default) and
    // answered the panel with 95% whenever it was truthy. Neither driver exposes
    // SQLite's cache counters, so the field must be absent, not plausible.
    test("omits cacheHitRatio: neither driver can read SQLite's cache counters", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      const perf = await provider.getPerformanceMetrics();
      expect("cacheHitRatio" in perf).toBe(false);
      expect(perf.cacheHitRatio).toBeUndefined();
    });

    test("omits queriesPerSecond and bufferPoolUsage, and keeps the measured deadlock count", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      const perf = await provider.getPerformanceMetrics();
      expect("queriesPerSecond" in perf).toBe(false);
      expect("bufferPoolUsage" in perf).toBe(false);
      // SQLite serializes writers behind one write lock and has no deadlock to
      // count - a statement about the engine, not a reading that failed.
      expect(perf.deadlocks).toBe(0);
    });

    test("a working PRAGMA cache_size does not become a cache hit ratio", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      // The pragma the old code derived 95% from still answers; it is a page budget in
      // KiB (negative) or pages (positive), never a hit count. BOTH signs are the same
      // fact about the same setting, so the sign is not asserted: pinning the -2000 this
      // was written against pinned one build's default (SQLite's compiled default is
      // -2000, and a build or a driver may set its own), and a build answering 2000
      // failed a test whose subject is that the number is not a ratio.
      const cacheSize = await provider.query("PRAGMA cache_size");
      const budget = cacheSize.rows[0].cache_size;
      expect(typeof budget).toBe("number");
      expect(budget).not.toBe(0);
      // The reading is a budget, and no budget is the 95 the old code reported as a
      // percentage - which is the regression this case exists to catch.
      expect((await provider.getPerformanceMetrics()).cacheHitRatio).toBeUndefined();
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
      expect(usersStats!.rowCount).toBe(2);
    });

    // The size used to be `rowCount * 100` ("Assume 100 bytes average per row"), and the
    // Storage tab summed it into the Data figure it draws beside the measured database
    // size. The real answer is `dbstat`, a virtual table behind a COMPILE-TIME option.
    //
    // Which arm runs is therefore a property of the SQLite build behind the driver, not
    // of the driver's name, and this test asserted the empty arm unconditionally under a
    // heading that named bun:sqlite. That held on the build it was written against
    // ("no such table: dbstat", Bun 1.3.14 / SQLite 3.53.0, 2026-08-24) and fails on a
    // Bun whose SQLite carries dbstat - a correct answer, reported as a regression. So
    // the build is asked, and whichever arm it is on is the one pinned. Both are real:
    // measured bytes when dbstat answers, absent fields when it does not, and the
    // fabricated `rowCount * 100` on neither.
    test("reports dbstat's measured bytes where it exists, and omits the size where it does not", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query("CREATE TABLE wide (id INTEGER PRIMARY KEY, payload TEXT)");
      await provider.query("INSERT INTO wide VALUES (1, 'x')");

      const stats = await provider.getTableStats();
      const wide = stats.find((s) => s.tableName === "wide")!;

      expect(wide.rowCount).toBe(1);
      // The guessed value, on both arms, in case a regression reinstates the multiplication.
      expect(wide.tableSizeBytes).not.toBe(100);

      if (await hasDbstat(provider)) {
        // Real page bytes: a one-row table still occupies at least one page.
        expect(wide.tableSizeBytes).toBeGreaterThan(0);
        expect(wide.tableSize).toBeDefined();
        expect(wide.totalSizeBytes).toBe(wide.tableSizeBytes! + wide.indexSizeBytes!);
        return;
      }

      expect(wide.tableSizeBytes).toBeUndefined();
      expect(wide.tableSize).toBeUndefined();
      expect(wide.indexSizeBytes).toBeUndefined();
      // `totalSize`/`totalSizeBytes` are still required by the type, so they carry the
      // same "N/A" placeholder `indexSize` uses in getIndexStats() (#469); the Storage
      // tab keys off the ABSENT `tableSizeBytes` and draws neither.
      expect(wide.totalSize).toBe("N/A");
      expect(wide.totalSizeBytes).toBe(0);
    });

    // The populated branch cannot be reached through the bun driver at all - it has no
    // dbstat - so it is exercised by handing readDbstatSizes() a stand-in handle. The
    // rows are the ones node:sqlite 3.51.2 actually returned for a seeded database
    // (200 rows of 4 KB text in `big` with an index on it, 200 short rows in `small`):
    //   dbstat -> big 823296, idx_big 929792, small 4096
    // and the provider under LIBREDB_SQLITE_DRIVER=node reported exactly
    // big 804 KB + 908 KB = 1.67 MB, small 4 KB + 0 B, both measured 2026-08-24.
    test("aggregates dbstat page bytes per table, indexes onto their table", () => {
      const dbstat = [
        { name: "big", bytes: 823296 },
        { name: "idx_big", bytes: 929792 },
        { name: "small", bytes: 4096 },
        { name: "sqlite_autoindex_small_1", bytes: 8192 },
      ];
      const owners = [
        { name: "idx_big", tbl_name: "big" },
        { name: "sqlite_autoindex_small_1", tbl_name: "small" },
      ];
      const fakeDb = {
        exec: () => {},
        close: () => {},
        inTransaction: false,
        prepare: (sql: string) => ({
          all: () => (sql.includes("dbstat") ? dbstat : owners),
          get: () => null,
          run: () => ({ changes: 0 }),
        }),
      };

      const sizes = readDbstatSizes(fakeDb)!;

      expect(sizes.get("big")).toEqual({ tableSizeBytes: 823296, indexSizeBytes: 929792 });
      // An implicit sqlite_autoindex_* occupies real pages and is not a table of its
      // own, so it counts as its table's index bytes and never as a row in the list.
      expect(sizes.get("small")).toEqual({ tableSizeBytes: 4096, indexSizeBytes: 8192 });
      expect(sizes.has("idx_big")).toBe(false);
      expect(sizes.has("sqlite_autoindex_small_1")).toBe(false);
    });

    test("readDbstatSizes answers null when the driver has no dbstat", () => {
      const fakeDb = {
        exec: () => {},
        close: () => {},
        inTransaction: false,
        prepare: () => {
          throw new Error("no such table: dbstat");
        },
      };

      expect(readDbstatSizes(fakeDb)).toBeNull();
    });

    test("buildTableStats states the measured bytes when it has them", () => {
      const stats = buildTableStats("big", 200, { tableSizeBytes: 823296, indexSizeBytes: 929792 });

      expect(stats).toEqual({
        schemaName: "main",
        tableName: "big",
        rowCount: 200,
        tableSize: "804 KB",
        tableSizeBytes: 823296,
        indexSize: "908 KB",
        indexSizeBytes: 929792,
        totalSize: "1.67 MB",
        totalSizeBytes: 1753088,
      });
    });

    test("buildTableStats omits every byte field when it has none", () => {
      const stats = buildTableStats("wide", 1, null);

      expect(stats).toEqual({
        schemaName: "main",
        tableName: "wide",
        rowCount: 1,
        totalSize: "N/A",
        totalSizeBytes: 0,
      });
      expect(Object.hasOwn(stats, "tableSizeBytes")).toBe(false);
      expect(Object.hasOwn(stats, "tableSize")).toBe(false);
    });

    // The answer is per CALL, not per row: one dbstat scan decides for the whole list, so
    // every table gains its byte fields together or loses them together. What the Storage
    // tab's `every()` gate must never see is a partial answer - some tables sized and
    // others not - and that is the invariant here, on whichever arm the build is on.
    test("answers uniformly for every table in the list, never some sized and some not", async () => {
      provider = new SQLiteProvider(makeSQLiteConfig());
      await provider.connect();

      await provider.query("CREATE TABLE a (id INTEGER)");
      await provider.query("CREATE TABLE b (id INTEGER)");

      const stats = await provider.getTableStats();
      expect(stats.map((s) => s.tableName).sort()).toEqual(["a", "b"]);

      const sized = stats.filter((s) => s.tableSizeBytes !== undefined).length;
      expect(sized === 0 || sized === stats.length).toBe(true);
      // And the arm is the one the build is actually on, so a provider that started
      // dropping every size on a dbstat-carrying build would still be caught.
      expect(sized === stats.length).toBe(await hasDbstat(provider));
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

      // The size string already said "N/A" while the byte count said 0, which the
      // Storage tab summed into its index total as if every index were empty.
      // `IndexStats.indexSizeBytes` is optional for exactly this case.
      for (const entry of stats) {
        expect(entry.indexSize).toBe("N/A");
        expect("indexSizeBytes" in entry).toBe(false);
      }
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
      rmSync(fileTmpDir, { recursive: true });
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

    // ── disconnect() has to RELEASE the file, not schedule its release ────────
    //
    // bun:sqlite's `close()` is `sqlite3_close_v2`: the connection becomes a zombie
    // and the operating-system handle is released only once the last statement
    // prepared from it is finalized or garbage collected. The provider prepares a
    // statement per query and drops the reference, so on a collector's schedule that
    // is "eventually", and `disconnect()` used to resolve with the database, its WAL
    // and its shared-memory file still open (measured on Linux through
    // /proc/self/fd: three descriptors survived a disconnect that reported
    // isConnected() === false).
    //
    // Nothing on POSIX notices, because POSIX unlinks a file that is still open. On
    // Windows it is the whole difference: every one of these directories failed its
    // own teardown with `EBUSY: resource busy or locked` on windows-latest
    // (2026-09), and a user could not delete or move a database Studio had
    // disconnected from.
    //
    // Each platform is asked the strongest question it can answer. The WAL sidecars
    // are NOT that question, though they look like it: measured on 2026-09-15 with
    // the same probe on all three runners, `close(true)` removes `-wal` and `-shm`
    // on Linux and on Windows, and leaves both in place on macOS, where bun:sqlite
    // links Apple's system libsqlite3. That is the library keeping the WAL, not a
    // handle keeping the file: opening the same database with node:sqlite and
    // closing it removed both sidecars on that same macOS run, and removing a WAL
    // takes the exclusive lock a surviving handle would have denied.
    test("disconnect releases the file rather than scheduling it", async () => {
      const dbPath = join(fileTmpDir, "release.db");
      provider = new SQLiteProvider(makeSQLiteConfig({ database: dbPath }));
      await provider.connect();
      await provider.query("CREATE TABLE r (id INTEGER PRIMARY KEY, v TEXT)");
      await provider.query("INSERT INTO r VALUES (1, 'held')");
      expect(existsSync(`${dbPath}-wal`)).toBe(true);

      await provider.disconnect();

      // Windows answers by refusing: a file with a live handle cannot be renamed,
      // and renaming is exactly what a user does to a database they think they have
      // closed. POSIX renames an open file, so this cannot fail there.
      const moved = `${dbPath}.moved`;
      renameSync(dbPath, moved);
      renameSync(moved, dbPath);

      // Linux answers precisely: this is the measurement the defect was found with.
      // /proc/self/fd is the process's own open files, so a scheduled close shows up
      // as a descriptor still pointing into this directory.
      if (existsSync("/proc/self/fd")) {
        const held = readdirSync("/proc/self/fd").flatMap((fd) => {
          try {
            return [readlinkSync(join("/proc/self/fd", fd))];
          } catch {
            // The descriptor closed between the listing and the read, which is this
            // process's own bookkeeping rather than anything about the database.
            return [];
          }
        });
        expect(held.filter((target) => target.startsWith(fileTmpDir))).toEqual([]);
      }

      // And the data survived whatever the close had to checkpoint.
      const reader = new SQLiteProvider(makeSQLiteConfig({ database: dbPath }));
      await reader.connect();
      try {
        expect((await reader.query("SELECT v FROM r")).rows).toEqual([{ v: "held" }]);
      } finally {
        await reader.disconnect();
      }
    });

    // The same claim on the path nobody plans for: the connection points at a file
    // that is not a SQLite database, which is the ordinary "wrong file in the
    // dialog" mistake. `connect()` opens the handle before it fails, so a catch that
    // only records the error leaves the user's own file held open: on Windows they
    // then cannot delete or move the file they just picked by accident. Measured
    // 2026-09-15 through /proc/self/fd, before the fix: one descriptor on notes.txt
    // survived a connect() that had already thrown and reported isConnected() false.
    test("a connect that fails releases the file it had already opened", async () => {
      const notADatabase = join(fileTmpDir, "notes.txt");
      writeFileSync(notADatabase, "these are notes, not a database\n");
      provider = new SQLiteProvider(makeSQLiteConfig({ database: notADatabase }));

      await expect(provider.connect()).rejects.toThrow();
      expect(provider.isConnected()).toBe(false);
      // A retry has to ask the file again rather than answer from a handle that is
      // not there: `connect()` returns early when it still holds one, so a catch that
      // released the file but kept the reference would make this second call resolve,
      // silently, on a provider that is not connected.
      await expect(provider.connect()).rejects.toThrow();
      expect(provider.isConnected()).toBe(false);

      const moved = `${notADatabase}.moved`;
      renameSync(notADatabase, moved);
      renameSync(moved, notADatabase);

      if (existsSync("/proc/self/fd")) {
        const held = readdirSync("/proc/self/fd").flatMap((fd) => {
          try {
            return [readlinkSync(join("/proc/self/fd", fd))];
          } catch {
            return [];
          }
        });
        expect(held.filter((target) => target === notADatabase)).toEqual([]);
      }
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

    // ── The `#` grammar is SQLite's here (#292) ──────────────────────────
    //
    // SQLite has two comment forms, `--` and `/* */`. Its own tokenizer (the
    // bundled amalgamation classifies `#` as `CC_VARALPHA`) reads `#name` as a
    // bind variable, i.e. code. The shared reader used to guess MySQL's rule
    // here, which swallowed the rest of the line and cost the statement its
    // bound; naming the dialect bounds it instead, emitted text intact.
    test("bounds a statement carrying a hash-prefixed bind variable", () => {
      provider = new SQLiteProvider(makeSQLiteConfig());

      const result = provider.prepareQuery("SELECT * FROM users WHERE id = #id");

      expect(result.query).toBe("SELECT * FROM users WHERE id = #id LIMIT 500");
      expect(result.wasLimited).toBe(true);
    });

    // ── `[…]` is a quoted name here too (#295) ───────────────────────────
    //
    // SQLite accepts Microsoft-style bracket identifiers: its own tokenizer (the
    // bundled amalgamation classifies `[` as `CC_QUOTE2`, "`[...]` style quoted
    // ids") reads everything up to the close bracket as the name. So the bracket
    // fact for this dialect is the name reading, not ClickHouse's array one, and a
    // scan that stepped over string literals inside the run would lose the first
    // row below. The emitted text is asserted whole: a bound spliced INTO a
    // bracketed name is the corrupted-statement shape, not a missing bound.
    test.each<[string, string, string]>([
      ["an apostrophe", "SELECT [it's] FROM users", "SELECT [it's] FROM users LIMIT 500"],
      ["a comment marker", "SELECT [a--b] FROM users", "SELECT [a--b] FROM users LIMIT 500"],
      [
        "a comment marker before real trailing trivia",
        "SELECT [a--b] FROM users -- daily",
        "SELECT [a--b] FROM users LIMIT 500 -- daily",
      ],
    ])("bounds a statement whose bracket-quoted name carries %s", (_label, sql, expected) => {
      provider = new SQLiteProvider(makeSQLiteConfig());

      const result = provider.prepareQuery(sql);

      expect(result.query).toBe(expected);
      expect(result.wasLimited).toBe(true);
    });

    // KNOWN DIVERGENCE, asserted so it is a decision: SQLite has no escape inside
    // a bracket identifier - its tokenizer stops at the FIRST `]` - while this
    // reader honours SQL Server's doubled bracket, so it reads `[a]]b]` as one
    // name where SQLite reads `[a]` followed by junk. SQLite rejects that text
    // either way, so the longer reading only ever costs a bound on a statement the
    // server refuses.
    test("reads a doubled close bracket as part of the name, which SQLite itself does not", () => {
      provider = new SQLiteProvider(makeSQLiteConfig());

      const result = provider.prepareQuery("SELECT [a]]b] FROM users");

      expect(result.query).toBe("SELECT [a]]b] FROM users LIMIT 500");
      expect(result.wasLimited).toBe(true);
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

    // The monitoring Queries panel is ALWAYS empty here - `getSlowQueries()` answers
    // `[]` unconditionally - and until #U12 it told the reader to enable a PostgreSQL
    // extension. What it says now must not name one.
    test("says SQLite keeps no statement statistics rather than naming a Postgres extension", () => {
      const { slowQueriesEmptyState } = new SQLiteProvider(makeSQLiteConfig()).getLabels();

      expect(slowQueriesEmptyState).toContain("SQLite keeps no statistics");
      expect(slowQueriesEmptyState).not.toContain("pg_stat_statements");
    });

    // SQLite declares the `reindex` maintenance operation and `runMaintenance()`
    // sends a bare `REINDEX` for the global card, which rebuilds every index in the
    // FILE - not in a database of tables the way the hardcoded copy read (#464).
    test("declares the global reindex wording the bare REINDEX it runs deserves", () => {
      const labels = new SQLiteProvider(makeSQLiteConfig()).getLabels();

      expect(labels.reindexGlobalLabel).toBe("Run Reindex");
      expect(labels.reindexGlobalTitle).toBe("Rebuild Indexes");
      expect(labels.reindexGlobalDesc).toContain("REINDEX");
      expect(labels.reindexGlobalDesc).toContain("database file");
    });
  });
});

// ============================================================================
// Object surface (#789)
//
// SQLite is the first ZERO-CONTAINER engine in this epic: `containerLevels` is
// `[]`, `containerDepth()` answers 0, and `listContainers()` answers `[]`. The
// fixture below is built by DDL against a real :memory: database, so every
// assertion is measured against the engine rather than a mock.
// ============================================================================

/**
 * One instance of every declared kind, plus every case the reads have to survive.
 *
 * Built to hold all four values of `PRAGMA table_list.type` - `table`, `view`,
 * `shadow` and `virtual` - because the vocabulary is derived from SQLite's own
 * documentation and a rule nothing exercises is a rule nobody measured (standing
 * ruling 5a). The FTS5 table contributes the `virtual` row and five `shadow` rows,
 * and a naive `sqlite_schema` scan types all six as `table`.
 *
 * The `temp` and `attached` objects deliberately SHADOW names in `main`: a listing
 * that did not restrict itself to `main` would answer two objects with one path,
 * which is the invariant the conformance helper checks and the tree relies on.
 *
 * THE DDL IS NOT HERE ANY MORE and that is standing ruling 5i (#789). It lives in
 * `docker/sqlite-init/01-object-fixture.sql`, which this reads and which
 * `bun docker/sqlite-init/build-fixture.ts` replays into a database FILE a person
 * can open in Studio. A fixture only a test can apply is a measurement nobody else
 * can re-run; every object asserted below is created by that file.
 */
const OBJECT_FIXTURE_DDL: readonly string[] = readFixtureStatements();

/**
 * What `sqlite_schema.sql` holds for every object of every source-bearing kind (#789).
 *
 * Keyed `"<kind>/<name>"`, because `audit_log` is BOTH a table and a trigger and a key of
 * the name alone could not hold both. Every value is a statement of
 * `docker/sqlite-init/01-object-fixture.sql`, resolved from the file rather than typed here:
 * the engine stores the submitted text, so a literal that drifted from the file would be a
 * definition nobody wrote.
 *
 * MEASURED on SQLite 3.53.2 through `bun:sqlite`, and it is why `origin` is `stored`: the
 * newlines and the five-space indentation of the multi-line `orders` statement come back
 * exactly as written. The engine does normalize the `CREATE TABLE <name>` prefix and drops
 * anything after the closing parenthesis, including a trailing comment, which is recorded in
 * docs/providers/sqlite.md and is why neither fixture writes one.
 */
const EXPECTED_DEFINITIONS: Readonly<Record<string, string>> = Object.fromEntries(
  [
    "table/customers",
    "table/orders",
    "table/archive",
    "table/audit_log",
    "table/sqliteXledger",
    "table/notes",
    "view/order_summary",
    "index/idx_orders_customer",
    "index/idx_orders_doubled",
    "trigger/orders_stamp",
    "trigger/order_summary_guard",
    "trigger/audit_log",
  ].map((key) => [key, definitionFor(key)]),
);

/**
 * The fixture statement that created one object, or a throw naming the key that matched none.
 *
 * The match is on the object's NAME as a whole word after its own keyword, so
 * `trigger/audit_log` cannot pick up `CREATE TABLE audit_log`. A key matching zero statements
 * or more than one raises rather than answering, because either one would silently pin the
 * wrong text and a test asserting the wrong value is worse than no test at all.
 */
function definitionFor(key: string): string {
  const [kind, name] = key.split("/");
  const keyword = kind === "table" ? "(?:VIRTUAL TABLE|TABLE)" : kind.toUpperCase();
  const pattern = new RegExp(`^CREATE ${keyword} ${name}\\b`);
  const matched = readFixtureStatements().filter((statement) => pattern.test(statement));
  if (matched.length !== 1) {
    throw new Error(`${key} matched ${matched.length} statements of 01-object-fixture.sql, expected exactly 1`);
  }
  return matched[0];
}

/** Every kind, and how many of it `main` holds. Derived nowhere: counted by hand off the DDL. */
const EXPECTED_COUNTS = { table: 6, view: 1, index: 2, trigger: 3 } as const;

/**
 * Swaps the provider's own database handle for one that intercepts a named statement.
 *
 * Every other assertion in this block runs against the real engine, which is how a
 * provider test should be written; these three cases cannot be. A build without
 * `PRAGMA table_list` is a build, not a schema, and SQLite's catalog cannot be made to
 * answer a row whose kind reads `toString`. The handle is the smallest seam that reaches
 * them, and everything not matched still goes to the real database, so each test keeps a
 * live control beside the intercepted read.
 */
function interceptReads(provider: SQLiteProvider, match: string, intercept: (sql: string) => SQLiteStatement): void {
  const holder = provider as unknown as { db: SQLiteDatabase };
  const real = holder.db;
  holder.db = {
    exec: (sql: string) => real.exec(sql),
    close: (throwOnError?: boolean) => real.close(throwOnError),
    get inTransaction() {
      return real.inTransaction;
    },
    prepare: (sql: string) => (sql.includes(match) ? intercept(sql) : real.prepare(sql)),
  };
}

/** The named statement fails the way a missing catalog does: at prepare, with a message. */
function failReadsMatching(provider: SQLiteProvider, match: string, message: string): void {
  interceptReads(provider, match, () => {
    throw new Error(message);
  });
}

/** The named statement throws something that is not an Error at all. */
function throwFromReadsMatching(provider: SQLiteProvider, match: string, thrown: string): void {
  interceptReads(provider, match, () => {
    throw thrown;
  });
}

/** The named statement answers rows of the test's choosing. */
function answerReadsMatching(provider: SQLiteProvider, match: string, rows: readonly unknown[]): void {
  interceptReads(provider, match, () => ({
    all: () => [...rows],
    get: () => rows[0] ?? null,
    run: () => ({ changes: 0 }),
  }));
}

/**
 * Captures the parameters a named statement is prepared with, and answers rows of the
 * test's choosing.
 *
 * The binds are what a derivation test has to reach: standing ruling 5g says a two-level
 * test that stops at a refusal proves nothing, so the statement must run and its BOUND
 * VALUES must be read. Everything not matched still goes to the real database.
 */
function captureReadsMatching(
  provider: SQLiteProvider,
  match: string,
  rows: readonly unknown[],
): { statements: string[]; params: unknown[][] } {
  const captured = { statements: [] as string[], params: [] as unknown[][] };
  interceptReads(provider, match, (sql) => {
    captured.statements.push(sql);
    return {
      all: (...params: unknown[]) => {
        captured.params.push(params);
        return [...rows];
      },
      get: () => rows[0] ?? null,
      run: () => ({ changes: 0 }),
    };
  });
  return captured;
}

/** A connected provider holding the fixture above, in memory. */
async function connectedWithObjects(): Promise<SQLiteProvider> {
  const opened = new SQLiteProvider(makeSQLiteConfig());
  await opened.connect();
  for (const statement of OBJECT_FIXTURE_DDL) await opened.query(statement);
  return opened;
}

describe("SQLiteProvider object surface (#789)", () => {
  let objects: SQLiteProvider;

  afterEach(async () => {
    if (objects?.isConnected()) await objects.disconnect();
  });

  test("declares the four kinds SQLite has, at zero container levels", async () => {
    objects = await connectedWithObjects();
    const capabilities = objects.getCapabilities();
    const kinds = capabilities.objectKinds ?? [];

    expect(kinds.map((kind) => kind.id)).toEqual(["table", "view", "index", "trigger"]);
    expect(kinds.find((kind) => kind.id === "table")?.role).toBe("relation");
    expect(kinds.find((kind) => kind.id === "table")?.acceptsRowWrites).toBe(true);
    // A view is not a row-write target: SQLite refuses a write to one outright unless
    // an INSTEAD OF trigger carries it, which is a per-OBJECT fact this per-kind
    // declaration cannot state.
    expect(kinds.find((kind) => kind.id === "view")?.role).toBe("relation");
    expect(kinds.find((kind) => kind.id === "view")?.acceptsRowWrites).toBeUndefined();
    // Declared, unlike on postgres, mysql, mssql and oracle: `sqlite_schema` models an
    // index as a first-class named row beside its tables (standing ruling 4).
    expect(kinds.find((kind) => kind.id === "index")?.role).toBe("config");
    expect(kinds.find((kind) => kind.id === "trigger")?.role).toBe("attached");
    expect(kinds.find((kind) => kind.id === "trigger")?.attachedTo).toBe("table");
    // No routine kind of any spelling. An application-defined SQLite function is
    // registered by the HOST PROCESS and never stored in the file, so there is nothing
    // to list, and a kind an engine does not have is ABSENT rather than counted zero.
    for (const absent of ["procedure", "function", "routine", "sequence", "package", "event"]) {
      expect(kinds.find((kind) => kind.id === absent)).toBeUndefined();
    }
    // The headline of this task: zero container levels, which `containerDepth()` reads.
    expect(capabilities.containerLevels).toEqual([]);
    expect(containerDepth(capabilities)).toBe(0);
  });

  test("satisfies the object-surface conformance contract", async () => {
    objects = await connectedWithObjects();

    await assertObjectSurface(objects, {
      // No container level, so there is no container path to name. `[]` here is the
      // engine answering "I have none", never a refusal.
      containers: [],
      kinds: { ...EXPECTED_COUNTS },
      sampleObject: { path: ["orders"], kind: "table" },
      // No container level, so the authored path is the bare name. `emptyKinds` is absent
      // because every source-bearing kind this engine declares is counted above zero.
      absentSource: { path: ["no_such_table"], kind: "table" },
    });
  });

  test("the TREE draws the kind folders at the ROOT, which nothing before this task exercised", async () => {
    // The headline risk of the first zero-container engine, and the reason a provider
    // test asserts a UI derivation. `flatten.ts` originally read `containerLevels?.length
    // ?? 1`, which rendered an engine with no container level as an EMPTY TREE with no
    // error at all - a Critical in Task 5's review. Every engine landed since has had at
    // least one container, so this is the first time the 0 arm is driven by a real
    // provider rather than by a hand-written declaration.
    //
    // Everything below comes from the PROVIDER: the kinds are its declaration, the depth
    // is `containerDepth()` over that declaration, and the counts and objects are its own
    // reads. Nothing about the zero case is typed in here.
    objects = await connectedWithObjects();
    const capabilities = objects.getCapabilities();
    const containers = await objects.listContainers();
    const counts = await objects.countObjects([]);
    const tables = await objects.listObjects([], "table");

    const rows = flattenTree({
      kinds: declaredKinds(capabilities),
      containers,
      // The folder row id at depth 0 is the bare kind id, because the container path it
      // hangs under is empty.
      expanded: new Set(["table"]),
      // Keyed by the container path joined with "/", so the root container's key is "".
      counts: { "": counts },
      objects: { table: tables },
      containerDepth: containerDepth(capabilities),
    });

    // No container row anywhere: the engine has no container level, so there is nothing
    // above the folders. A tree that drew a synthetic "main" row would fail here.
    expect(rows.filter((row) => row.kind === "container")).toEqual([]);

    // The four folders ARE the top-level sibling group, in declaration order, each
    // badged from `countObjects` rather than from a listing's length.
    const folders = rows.filter((row) => row.kind === "folder");
    expect(folders.map((row) => ({ id: row.id, label: row.label, depth: row.depth, badge: row.badge }))).toEqual([
      { id: "table", label: "Tables", depth: 0, badge: "6" },
      { id: "view", label: "Views", depth: 0, badge: "1" },
      { id: "index", label: "Indexes", depth: 0, badge: "2" },
      { id: "trigger", label: "Triggers", depth: 0, badge: "3" },
    ]);
    // ARIA position is computed per sibling group, and at depth 0 that group is the four
    // folders and nothing else.
    expect(folders.map((row) => `${row.posInSet}/${row.setSize}`)).toEqual(["1/4", "2/4", "3/4", "4/4"]);

    // And the expanded folder really opens onto the provider's own objects, one level in.
    const objectRows = rows.filter((row) => row.kind === "object");
    expect(objectRows.map((row) => row.label)).toEqual([
      "archive",
      "audit_log",
      "customers",
      "notes",
      "orders",
      "sqliteXledger",
    ]);
    expect(objectRows.every((row) => row.depth === 1 && row.kindId === "table")).toBe(true);
    expect(objectRows.map((row) => row.id)).toEqual([
      "archive/table",
      "audit_log/table",
      "customers/table",
      "notes/table",
      "orders/table",
      "sqliteXledger/table",
    ]);
  });

  test("listContainers answers an empty array, which is an answer and not a refusal", async () => {
    objects = await connectedWithObjects();

    // `[]` is SQLite saying it has no container level. It must not raise, and it must not
    // invent a `main` row to make the shape match the other sixteen engines.
    await expect(objects.listContainers()).resolves.toEqual([]);
    // Still a catalog method: it is not answerable off a closed handle.
    await expect(new SQLiteProvider(makeSQLiteConfig()).listContainers()).rejects.toThrow();
  });

  // --------------------------------------------------------------------------
  // What the counts and the listings enumerate
  // --------------------------------------------------------------------------

  test("a shadow table is not an object, and a virtual table is", async () => {
    // The whole reason `PRAGMA table_list` is read here rather than `sqlite_schema`. The
    // FTS5 table `notes` contributes one `virtual` row and five `shadow` rows, and
    // `sqlite_schema` types every one of the six `table`.
    objects = await connectedWithObjects();

    const naive = (await objects.query("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")).rows;
    const listed = (await objects.listObjects([], "table")).map((object) => object.name);

    // The control: the naive scan really does see the shadow tables, so the assertion
    // below is a difference rather than an empty comparison.
    expect(naive.map((row) => row.name)).toContain("notes_data");
    expect(naive).toHaveLength(12);

    expect(listed).toEqual(["archive", "audit_log", "customers", "notes", "orders", "sqliteXledger"]);
    for (const shadow of ["notes_data", "notes_idx", "notes_content", "notes_docsize", "notes_config"]) {
      expect(listed).not.toContain(shadow);
    }
    // `notes` itself IS listed: a user selects from a virtual table, and it accepts row
    // writes, so dropping it with its shadows would lose a real object.
    expect(listed).toContain("notes");
  });

  test("every value PRAGMA table_list can answer has a rule, checked against the engine", async () => {
    // Standing ruling 5a: the vocabulary is derived from SQLite's documentation, not from
    // a `SELECT DISTINCT` over whatever the fixture happens to hold. This guard is the
    // other half - it fails the day the engine answers a fifth value, which would
    // otherwise fall out of BOTH the count and the listing and be invisible in the tree.
    //
    // Non-vacuous by construction: the fixture is built to contain all four, and that is
    // asserted first. A guard run against data that never holds the case it exists to
    // catch is a guard that has never run.
    objects = await connectedWithObjects();

    const answered = (await objects.query("SELECT DISTINCT type FROM pragma_table_list ORDER BY type")).rows.map(
      (row) => row.type,
    );

    expect(answered).toEqual(["shadow", "table", "view", "virtual"]);
    // `shadow` is the one value with no kind, and it is dropped on purpose. The other
    // three are covered by the two relation kinds.
    expect(answered.filter((type) => type !== "shadow")).toEqual(["table", "view", "virtual"]);
  });

  test("the names SQLite reserves for itself are not objects", async () => {
    objects = await connectedWithObjects();

    const tables = (await objects.listObjects([], "table")).map((object) => object.name);
    const indexes = (await objects.listObjects([], "index")).map((object) => object.name);

    // Controls: each of these really is in the catalog this listing reads.
    const raw = (await objects.query("SELECT name FROM pragma_table_list WHERE schema = 'main'")).rows.map(
      (row) => row.name,
    );
    expect(raw).toContain("sqlite_schema");
    expect(raw).toContain("sqlite_sequence");
    const rawIndexes = (await objects.query("SELECT name FROM sqlite_schema WHERE type = 'index'")).rows.map(
      (row) => row.name,
    );
    expect(rawIndexes).toContain("sqlite_autoindex_customers_1");

    expect(tables).not.toContain("sqlite_schema");
    // `sqlite_sequence` is the one an AUTOINCREMENT column adds without being asked for.
    expect(tables).not.toContain("sqlite_sequence");
    // And the other direction, which is what makes `ESCAPE` load-bearing rather than
    // decoration: `sqliteXledger` is a name a user can really have, and the unescaped
    // `LIKE 'sqlite_%'` excludes it too, because `_` matches any single character.
    expect(tables).toContain("sqliteXledger");
    expect(indexes).toEqual(["idx_orders_customer", "idx_orders_doubled"]);
  });

  test("temp and attached objects are not in this file, so they are not in the tree", async () => {
    // `PRAGMA table_list` spans every attached schema AND `temp`, and the fixture puts an
    // `orders` in all three. Without the schema restriction the table folder would answer
    // three objects with ONE path, which is the uniqueness the tree addresses rows by.
    objects = await connectedWithObjects();

    const everywhere = (await objects.query("SELECT schema, name FROM pragma_table_list WHERE name = 'orders'")).rows;
    // The control: all three really are visible on this handle.
    expect(everywhere.map((row) => row.schema).sort()).toEqual(["attached", "main", "temp"]);

    const counts = await objects.countObjects([]);
    expect(counts).toEqual({
      table: { count: EXPECTED_COUNTS.table },
      view: { count: EXPECTED_COUNTS.view },
      index: { count: EXPECTED_COUNTS.index },
      trigger: { count: EXPECTED_COUNTS.trigger },
    });
    for (const kind of ["table", "view", "index", "trigger"]) {
      const paths = (await objects.listObjects([], kind)).map((object) => object.path.join("/"));
      expect(new Set(paths).size).toBe(paths.length);
    }
    // Named, so a regression says which schema leaked rather than only that a number moved.
    expect((await objects.listObjects([], "index")).map((o) => o.name)).not.toContain("idx_orders_customer_temp");
    expect((await objects.listObjects([], "trigger")).map((o) => o.name)).not.toContain("orders_stamp_attached");
  });

  test("the listing contains exactly what the count counted, for every declared kind", async () => {
    // Standing ruling 5f from this provider's side: a badge that disagrees with its own
    // folder is worse than either being wrong alone. The two reads go to different
    // statements, so this is a real cross-check rather than a restatement.
    objects = await connectedWithObjects();
    const counts = await objects.countObjects([]);

    for (const kind of declaredKinds(objects.getCapabilities())) {
      const count = counts[kind.id];
      expect(isCountUnavailable(count)).toBe(false);
      const listed = await objects.listObjects([], kind.id);
      expect({ kind: kind.id, n: listed.length }).toEqual({
        kind: kind.id,
        n: isCountUnavailable(count) ? -1 : count.count,
      });
    }
  });

  test("a trigger nests under the object it fires on, view or table", async () => {
    objects = await connectedWithObjects();

    const triggers = await objects.listObjects([], "trigger");

    // Sorted by PATH, so a trigger sits under its parent's name. The INSTEAD OF trigger's
    // parent is a VIEW, which the `attachedTo: "table"` declaration does not forbid and
    // which the count includes, so the listing has to as well.
    expect(triggers.map((trigger) => trigger.path)).toEqual([
      // The name collision the source read needs: a trigger may share a name with the table
      // it fires on, which SQLite accepts and which no other kind here can do.
      ["audit_log", "audit_log"],
      ["order_summary", "order_summary_guard"],
      ["orders", "orders_stamp"],
    ]);
    expect(triggers.map((trigger) => trigger.name)).toEqual(["audit_log", "order_summary_guard", "orders_stamp"]);
    expect(triggers.every((trigger) => trigger.kind === "trigger")).toBe(true);
  });

  test("a listing is sorted by path, and by segments rather than by one joined string", async () => {
    objects = await connectedWithObjects();

    const tables = await objects.listObjects([], "table");

    // Neither catalog answers in name order: `PRAGMA table_list` walks its own hash.
    const raw = (
      await objects.query(
        "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type IN ('table','virtual') AND name NOT LIKE 'sqlite@_%' ESCAPE '@'",
      )
    ).rows.map((row) => row.name);
    expect(raw).not.toEqual([...raw].sort());

    expect(tables.map((table) => table.name)).toEqual([
      "archive",
      "audit_log",
      "customers",
      "notes",
      "orders",
      "sqliteXledger",
    ]);
  });

  // --------------------------------------------------------------------------
  // describeObject
  // --------------------------------------------------------------------------

  test("describes a table from `main` even when temp holds a different table of that name", async () => {
    // The measurement behind MAIN_SCHEMA. A one-argument `pragma_table_info('orders')`
    // answers about the TEMP table, which has one column; the schema-bound read answers
    // about the file, which has five. Both are non-empty, so a read that lost the schema
    // would not raise - it would quietly describe a different object.
    objects = await connectedWithObjects();

    const shadow = (await objects.query("SELECT name FROM pragma_table_info('orders')")).rows.map((row) => row.name);
    expect(shadow).toEqual(["id"]);

    const described = await objects.describeObject(["orders"], "table");
    expect(described.columns.map((column) => column.name)).toHaveLength(5);
  });

  test("describes a view, which has columns and neither indexes nor foreign keys", async () => {
    objects = await connectedWithObjects();

    const view = await objects.describeObject(["order_summary"], "view");

    expect(view.columns.map((column) => column.name)).toEqual(["id", "total"]);
    expect(view.indexes).toEqual([]);
    expect(view.foreignKeys).toEqual([]);
  });

  test("a virtual table describes its declared columns and not the module's own", async () => {
    // `table_xinfo` publishes an FTS5 table's interface columns `notes` and `rank` at
    // hidden = 1. They are the module's handles rather than columns the table declares,
    // and the `hidden <> 1` filter is what keeps them out while keeping generated
    // columns in.
    objects = await connectedWithObjects();

    const raw = (await objects.query("SELECT name, hidden FROM pragma_table_xinfo('notes', 'main')")).rows;
    expect(raw.map((row) => row.name)).toEqual(["body", "notes", "rank"]);

    const notes = await objects.describeObject(["notes"], "table");
    expect(notes.columns.map((column) => column.name)).toEqual(["body"]);
  });

  test("a table's indexes exclude the implicit ones, and an expression key has no column name", async () => {
    objects = await connectedWithObjects();

    const orders = await objects.describeObject(["orders"], "table");

    // BY NAME, which is this read's own `ORDER BY` and not `pragma_index_list`'s: measured,
    // that pragma answers in reverse creation order, so it would put `idx_orders_doubled`
    // first. The bulk read has to order by the object to group its rows, and two different
    // orders over one table's indexes is a disagreement between the two surfaces (#789).
    expect(orders.indexes).toEqual([
      { name: "idx_orders_customer", columns: ["customer_id"], unique: false },
      // The expression index keys `total * 2`, which publishes a null column name, so it
      // carries no columns rather than a fabricated label.
      { name: "idx_orders_doubled", columns: [], unique: false },
    ]);
    // The control for the null filter: SQLite really does answer a null name here.
    const keys = (await objects.query("SELECT name FROM pragma_index_info('idx_orders_doubled', 'main')")).rows;
    expect(keys).toEqual([{ name: null }]);

    // An implicit `sqlite_autoindex_*` serves a UNIQUE constraint, cannot be dropped, and
    // is not in the Indexes folder either, so the two surfaces agree about what an index is.
    const customers = await objects.describeObject(["customers"], "table");
    expect(customers.indexes).toEqual([]);
    const raw = (await objects.query("SELECT name FROM pragma_index_list('customers', 'main')")).rows;
    expect(raw).toEqual([{ name: "sqlite_autoindex_customers_1" }]);
  });

  test("a foreign key that names no column resolves to the parent's primary key", async () => {
    objects = await connectedWithObjects();

    const orders = await objects.describeObject(["orders"], "table");

    // The control: SQLite publishes a null for the implicit one, so this is a resolution
    // rather than a pass-through.
    const raw = (await objects.query("SELECT \"from\", \"to\" FROM pragma_foreign_key_list('orders', 'main')")).rows;
    expect(raw).toContainEqual({ from: "customer_id", to: null });

    expect(orders.foreignKeys).toEqual([
      { columnName: "customer_email", referencedTable: "customers", referencedColumn: "email" },
      { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
    ]);
  });

  test("a foreign key whose parent has no primary key carries no referenced column", async () => {
    // SQLite accepts this schema and rejects it only on INSERT ("foreign key mismatch"),
    // so `pragma_table_info` answers no key column to resolve. `ForeignKeySchema` carries
    // a string, and the empty one says there is nothing to name.
    objects = new SQLiteProvider(makeSQLiteConfig());
    await objects.connect();
    await objects.query("CREATE TABLE no_pk (x INTEGER, y INTEGER)");
    await objects.query("CREATE TABLE broken_ref (a INTEGER REFERENCES no_pk)");

    const detail = await objects.describeObject(["broken_ref"], "table");

    expect(detail.foreignKeys).toEqual([{ columnName: "a", referencedTable: "no_pk", referencedColumn: "" }]);
  });

  test("an index and a trigger describe as three empty arrays, without a round trip", async () => {
    objects = await connectedWithObjects();

    // A true fact about those kinds rather than a failed read: `pragma_table_xinfo`
    // answers nothing for either name, which is the control below.
    for (const name of ["idx_orders_customer", "orders_stamp"]) {
      expect((await objects.query(`SELECT name FROM pragma_table_xinfo('${name}', 'main')`)).rows).toEqual([]);
    }

    expect(await objects.describeObject(["idx_orders_customer"], "index")).toEqual({
      path: ["idx_orders_customer"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    expect(await objects.describeObject(["orders", "orders_stamp"], "trigger")).toEqual({
      path: ["orders", "orders_stamp"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
  });

  test("an object that is not there is a failed read and says so", async () => {
    objects = await connectedWithObjects();

    // Zero columns cannot mean an empty table: SQLite refuses `CREATE TABLE t()`, so an
    // empty answer means nothing of that name is in `main`. The temp and attached
    // `orders` are reachable on this handle and deliberately do not rescue this.
    await expect(objects.describeObject(["no_such_table"], "table")).rejects.toThrow(
      /No SQLite table named no_such_table in main/,
    );
  });

  // --------------------------------------------------------------------------
  // Refusals and the declaration
  // --------------------------------------------------------------------------

  test("a kind the file holds none of still draws its folder, badged zero", async () => {
    // The three states of `KindCount` are three different facts. Building the record from
    // the GROUP BY rows alone would leave an empty kind OUT, and an absent kind already
    // means something stronger: the engine has no such concept, so the tree draws no
    // folder. Seeding is what keeps "SQLite has views and this file has none" renderable.
    objects = new SQLiteProvider(makeSQLiteConfig());
    await objects.connect();
    await objects.query("CREATE TABLE only_a_table (id INTEGER PRIMARY KEY)");

    const counts = await objects.countObjects([]);

    expect(counts).toEqual({
      table: { count: 1 },
      view: { count: 0 },
      index: { count: 0 },
      trigger: { count: 0 },
    });
    // Every declared kind is present, which is what stops a folder vanishing from the tree.
    expect(Object.keys(counts).sort()).toEqual(
      declaredKinds(objects.getCapabilities())
        .map((kind) => kind.id)
        .sort(),
    );
  });

  test("a kind SQLite does not declare is refused by name, in both methods", async () => {
    objects = await connectedWithObjects();

    await expect(objects.listObjects([], "procedure")).rejects.toThrow(/declares no object kind "procedure"/);
    await expect(objects.describeObject(["x"], "sequence")).rejects.toThrow(/declares no object kind "sequence"/);
  });

  test("a kind that is declared but has no listing statement says so, not that it is undeclared", async () => {
    // Two questions, and only the declaration answers the first. Deciding "declared" from
    // whether a statement exists would report "declares no object kind" about a kind
    // `objectKinds` does declare, which is a different defect with the same symptom.
    objects = await connectedWithObjects();
    const real = objects.getCapabilities();
    spyOn(objects, "getCapabilities").mockReturnValue({
      ...real,
      objectKinds: [...(real.objectKinds ?? []), { id: "tablespace", role: "config", label: "T", labelPlural: "Ts" }],
    });

    await expect(objects.listObjects([], "tablespace")).rejects.toThrow(
      /declares the kind "tablespace" but has no statement that lists it/,
    );
  });

  test("a container path of another engine's shape is refused rather than read", async () => {
    objects = await connectedWithObjects();

    // The message names the shape the DECLARATION describes, which here is no shape at all.
    for (const call of [objects.countObjects(["main"]), objects.listObjects(["main"], "table")]) {
      await expect(call).rejects.toThrow(/A SQLite container path is empty, received \["main"\]/);
    }
    await expect(objects.describeObject(["main", "orders"], "table")).rejects.toThrow(
      /A SQLite "table" path is \[name\], received \["main","orders"\]/,
    );
    await expect(objects.describeObject(["orders_stamp"], "trigger")).rejects.toThrow(
      /A SQLite "trigger" path is \[table, name\], received \["orders_stamp"\]/,
    );
  });

  test("the container depth, the object path and the name bind are DERIVED, which a two-level declaration shows", async () => {
    // Standing ruling 5g, and on a ZERO-container engine this test is the only thing that
    // can tell a derivation from a literal: `container.length !== 0` and `path[0]` for the
    // object name are behaviour-identical to the derived forms at depth 0, which is
    // exactly why the same defect has now shipped three times, each instance found one
    // review later than the last. The declaration below is synthetic for SQLite; the
    // derivations under test are the shared ones every provider copies.
    //
    // It is driven all the way to a BOUND VALUE and not to a refusal. A test that stops at
    // the refusal is how the third instance survived two providers and a review round.
    objects = await connectedWithObjects();
    const real = objects.getCapabilities();
    spyOn(objects, "getCapabilities").mockReturnValue({
      ...real,
      containerLevels: [
        { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
        { id: "schema", label: "Database", labelPlural: "Databases" },
      ],
    });

    // The refusal half. The depth comes from `containerDepth()`, so the EMPTY container
    // path - the only one this engine really accepts - is now wrong, and the message names
    // both declared levels. A hardcoded `!== 0` would accept it.
    await expect(objects.countObjects([])).rejects.toThrow(
      /A SQLite container path is \[catalog, database\], received \[\]/,
    );
    await expect(objects.listObjects([], "table")).rejects.toThrow(
      /A SQLite container path is \[catalog, database\], received \[\]/,
    );
    await expect(objects.describeObject(["orders"], "table")).rejects.toThrow(
      /A SQLite "table" path is \[catalog, database, name\], received \["orders"\]/,
    );
    await expect(objects.describeObject(["cat", "sch", "orders", "orders_stamp"], "table")).rejects.toThrow(
      /A SQLite "table" path is \[catalog, database, name\]/,
    );

    // The bound-value half, which a refusal-only test cannot see.
    //
    // A two-segment container is now the valid one, and the reads still answer.
    expect(await objects.countObjects(["cat", "sch"])).toEqual({
      table: { count: EXPECTED_COUNTS.table },
      view: { count: EXPECTED_COUNTS.view },
      index: { count: EXPECTED_COUNTS.index },
      trigger: { count: EXPECTED_COUNTS.trigger },
    });

    // Every listed path starts with the container it was asked for, because `objectPath`
    // prefixes the container rather than knowing this engine's depth. A `[row.name]`
    // literal would answer `["orders"]` here and break the tree's addressing.
    const tables = await objects.listObjects(["cat", "sch"], "table");
    expect(tables.map((table) => table.path)).toContainEqual(["cat", "sch", "orders"]);
    const triggers = await objects.listObjects(["cat", "sch"], "trigger");
    expect(triggers.map((trigger) => trigger.path)).toEqual([
      ["cat", "sch", "audit_log", "audit_log"],
      ["cat", "sch", "order_summary", "order_summary_guard"],
      ["cat", "sch", "orders", "orders_stamp"],
    ]);

    // AND THE BIND. `path[path.length - 1]` is `orders` at this depth and `path[0]` is the
    // CATALOG, `path[1]` the schema. Both literals are depth-identical at 0, so only this
    // declaration can tell them apart: binding either would ask `pragma_table_xinfo` for
    // an object called `cat` or `sch`, which answers nothing and raises by name.
    const detail = await objects.describeObject(["cat", "sch", "orders"], "table");
    expect(detail.path).toEqual(["cat", "sch", "orders"]);
    expect(detail.columns.map((column) => column.name)).toEqual([
      "id",
      "customer_id",
      "customer_email",
      "total",
      "total_with_tax",
    ]);
    expect(detail.foreignKeys.map((fk) => fk.columnName).sort()).toEqual(["customer_email", "customer_id"]);
    expect(detail.indexes.map((index) => index.name).sort()).toEqual(["idx_orders_customer", "idx_orders_doubled"]);
  });

  // --------------------------------------------------------------------------
  // A read the engine refuses
  // --------------------------------------------------------------------------

  test("a refused count carries SQLite's own sentence, for every kind at once", async () => {
    // `PRAGMA table_list` arrived in SQLite 3.37 and a build below it answers "no such
    // table: pragma_table_list" for the whole statement, so one failure covers all four
    // kinds. A refused read is never 0: the two are different facts and `KindCount` is the
    // type that keeps them apart.
    objects = await connectedWithObjects();
    failReadsMatching(objects, "pragma_table_list", "no such table: pragma_table_list");

    const counts = await objects.countObjects([]);

    expect(counts).toEqual({
      table: { unavailable: "no such table: pragma_table_list" },
      view: { unavailable: "no such table: pragma_table_list" },
      index: { unavailable: "no such table: pragma_table_list" },
      trigger: { unavailable: "no such table: pragma_table_list" },
    });
    // Verbatim, with no product prefix in front of the engine's words.
    for (const count of Object.values(counts)) {
      expect(isCountUnavailable(count) ? count.unavailable : "").not.toContain("SQLite");
    }
  });

  test("a thrown non-Error still reaches the folder as a sentence", async () => {
    objects = await connectedWithObjects();
    throwFromReadsMatching(objects, "pragma_table_list", "a driver that threw a string");

    const counts = await objects.countObjects([]);

    expect(counts.table).toEqual({ unavailable: "a driver that threw a string" });
  });

  test("a refused LISTING raises against the statement SQLite received", async () => {
    // A listing has no third state to report: a folder the user opened has to say why it
    // could not be filled, so this raises where `countObjects` degrades.
    objects = await connectedWithObjects();
    failReadsMatching(objects, "pragma_table_list", "no such table: pragma_table_list");

    // Typed, and carrying THE STATEMENT SQLITE RECEIVED rather than a bare driver error:
    // a raw rethrow arrives as a plain Error with no provider and no query, so whoever
    // reads the message cannot tell which of the four listings failed.
    const refusal = await objects.listObjects([], "table").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(DatabaseError);
    expect((refusal as DatabaseError).message).toContain("no such table: pragma_table_list");
    expect((refusal as DatabaseError).provider).toBe("sqlite");
    expect((refusal as DatabaseError).query).toContain("pragma_table_list");

    // The kinds that read `sqlite_schema` are untouched, which is the control.
    await expect(objects.listObjects([], "index")).resolves.toHaveLength(EXPECTED_COUNTS.index);
  });

  test("a catalog row whose kind names a prototype member draws no folder", async () => {
    // `Object.hasOwn` and not `in`, which is what makes the declared-kind guard ABSOLUTE
    // rather than nearly so. `"toString" in counts` is true on any object literal, so the
    // `in` spelling would write a folder for a kind the provider never declared. SQLite's
    // own catalog cannot produce such a row, which is exactly why it is handed one here:
    // the guard's docblock claims the declaration decides, with no exceptions.
    objects = await connectedWithObjects();
    answerReadsMatching(objects, "pragma_table_list", [
      { kind: "table", n: 3 },
      { kind: "toString", n: 9 },
      { kind: "constructor", n: 9 },
      { kind: "__proto__", n: 9 },
    ]);

    const counts = await objects.countObjects([]);

    // The control, so this is not a test of an empty read: the declared kind DID take its
    // count from the same rows.
    expect(counts.table).toEqual({ count: 3 });
    expect(Object.keys(counts).sort()).toEqual(["index", "table", "trigger", "view"]);
  });
});

/**
 * The Source read, against the real engine plus one intercepted case (#789 Phase 2).
 *
 * Everything here runs against a live `:memory:` database built from
 * `docker/sqlite-init/01-object-fixture.sql`. The single exception is the NULL-definition
 * case, which is UNREACHABLE through this provider by construction and is driven through the
 * statement seam for the reason section 6 of the recipe gives: on an engine whose read is
 * supposed never to refuse, the thing worth knowing is what the suite would do if it started.
 */
describe("SQLiteProvider object source (#789)", () => {
  let objects: SQLiteProvider;

  afterEach(async () => {
    if (objects?.isConnected()) await objects.disconnect();
  });

  test("declares source on exactly the kinds that have a definition text", async () => {
    objects = await connectedWithObjects();
    const kinds = objects.getCapabilities().objectKinds ?? [];
    const declared = kinds
      .filter((kind) => kind.hasSource === true)
      .map((kind) => [kind.id, kind.sourceLanguage] as const)
      .sort();

    // All four, because `sqlite_schema.sql` holds the submitted text for every row it has.
    expect(declared).toEqual([
      ["index", "sql"],
      ["table", "sql"],
      ["trigger", "sql"],
      ["view", "sql"],
    ]);
    // The other direction, so a kind added later cannot quietly gain a Source tab. SQLite is
    // one of the engines where this list is EMPTY, and the assertion is still the one that
    // fails the day a fifth kind is declared without a decision about its source.
    expect(
      kinds
        .filter((kind) => kind.hasSource !== true)
        .map((kind) => kind.id)
        .sort(),
    ).toEqual([]);
  });

  test("reads the definition of a table and says what the text is", async () => {
    objects = await connectedWithObjects();

    const document = await objects.readObjectSource!(["orders"], "table");

    expect(document.path).toEqual(["orders"]);
    expect(document.kind).toBe("table");
    expect(document.parts).toHaveLength(1);
    const [part] = document.parts;
    expect(isSourcePartUnavailable(part)).toBe(false);
    if (isSourcePartUnavailable(part)) throw new Error("narrowing");
    expect(part.id).toBe("definition");
    expect(part.label).toBe("Definition");
    expect(part.text).toContain("total_with_tax INTEGER GENERATED ALWAYS AS (total * 2) VIRTUAL");
    expect(part.language).toBe("sql");
    // The caption's whole job: this is the author's own bytes, not a reconstruction. The
    // newlines and the five-space indentation of the fixture statement survive, which is what
    // separates SQLite from every engine that rebuilds a statement out of its catalog.
    expect(part.form).toBe("complete");
    expect(part.origin).toBe("stored");
    expect(part.text).toContain("\n     id INTEGER PRIMARY KEY,");
    expect(part.truncated).toBeUndefined();
  });

  /**
   * The per-kind READ-THE-TEXT pin, whose population comes from the DECLARATION (#789).
   *
   * Recipe rule 6, measured by Task 8 one wave earlier: a whole-statement pin is necessary
   * and NOT sufficient. A wrong reply column reads as `undefined`, the provider correctly
   * turns that into a refusal, and a refusal passes the conformance walk, the statement pin
   * and every count assertion. On THIS engine the same defect wears a worse disguise:
   * `sqlite_schema` has four columns and reading `s.name` instead of `s.sql` answers a
   * non-empty STRING, so the read would not even become a refusal - it would hand a reader
   * the object's own name as its definition. Only comparing the TEXT can see either.
   *
   * Three guards, so no arm of this can go vacuous:
   *   - a declared source-bearing kind with no expectation THROWS by name;
   *   - a listed object with no expectation THROWS by name, so the expectation cannot name
   *     one object of a kind and leave its siblings unread;
   *   - every expected text is resolved from the fixture FILE, so nothing here can drift
   *     away from the DDL that created the object.
   */
  test("every object of every source-bearing kind reads back the DDL the fixture file wrote", async () => {
    objects = await connectedWithObjects();
    const capabilities = objects.getCapabilities();
    const sourceKinds = (capabilities.objectKinds ?? []).filter((kind) => kind.hasSource === true);
    if (sourceKinds.length === 0) throw new Error("no kind declares hasSource, so this test reads nothing");

    let read = 0;
    for (const spec of sourceKinds) {
      const listed = await objects.listObjects([], spec.id);
      if (listed.length === 0) throw new Error(`the fixture holds no ${spec.id}, so its source read is unexercised`);
      const named = Object.keys(EXPECTED_DEFINITIONS).filter((key) => key.startsWith(`${spec.id}/`));
      if (named.length === 0) throw new Error(`EXPECTED_DEFINITIONS names no ${spec.id}, so that kind is unread`);
      for (const object of listed) {
        const key = `${spec.id}/${object.name}`;
        if (!Object.hasOwn(EXPECTED_DEFINITIONS, key)) {
          throw new Error(`the fixture holds ${key} and EXPECTED_DEFINITIONS carries no text for it`);
        }
        const document = await objects.readObjectSource!(object.path, spec.id);
        const [part] = document.parts;
        if (isSourcePartUnavailable(part)) {
          throw new Error(`${key} answered the refusal "${part.unavailable}" on an engine that has none`);
        }
        expect(part.text).toBe(EXPECTED_DEFINITIONS[key]);
        read += 1;
      }
    }
    // Both sides come from the fixture: the left from the declaration and the listings, the
    // right from the expectation map. Equal means every named object was reached.
    expect(read).toBe(Object.keys(EXPECTED_DEFINITIONS).length);
  });

  test("the statement is one text, with the type BOUND and taken from the KIND", async () => {
    objects = await connectedWithObjects();
    const captured = captureReadsMatching(objects, "FROM sqlite_schema AS s", [{ sql: "CREATE TABLE x (a)" }]);

    await objects.readObjectSource!(["orders"], "table");

    // The whole statement as a LITERAL, never the provider's own constant: importing it
    // would move both sides of the assertion together and pin nothing (recipe rule 6).
    expect(captured.statements).toEqual([
      `
      SELECT s.sql AS sql
        FROM sqlite_schema AS s
       WHERE s.type = ?
         AND s.name = ?
    `,
    ]);
    expect(captured.params).toEqual([["table", "orders"]]);
  });

  /**
   * The one object either fixture holds that can tell a KIND-derived type from a name match.
   *
   * `audit_log` is a table AND a trigger, which SQLite accepts while it refuses an index or a
   * view under an existing table's name (measured on SQLite 3.53.2). `SELECT sql FROM
   * sqlite_schema WHERE name = 'audit_log'` answers two rows and the table's comes first, so
   * dropping `type = ?` hands a reader the table's DDL under the trigger's address - a defect
   * no statement-shape assertion can see, which is standing ruling 5a's instruction to build
   * the fixture that would disprove the claim.
   */
  test("a trigger sharing a name with a table reads the TRIGGER, not the table", async () => {
    objects = await connectedWithObjects();

    const trigger = await objects.readObjectSource!(["audit_log", "audit_log"], "trigger");
    const table = await objects.readObjectSource!(["audit_log"], "table");
    const [triggerPart] = trigger.parts;
    const [tablePart] = table.parts;
    if (isSourcePartUnavailable(triggerPart) || isSourcePartUnavailable(tablePart)) throw new Error("narrowing");

    expect(triggerPart.text).toBe(EXPECTED_DEFINITIONS["trigger/audit_log"]);
    expect(tablePart.text).toBe(EXPECTED_DEFINITIONS["table/audit_log"]);
    expect(triggerPart.text).not.toBe(tablePart.text);
  });

  test("an object that is not there RAISES, naming the segment, and never answers a refusal", async () => {
    objects = await connectedWithObjects();

    await expect(objects.readObjectSource!(["no_such_table"], "table")).rejects.toThrow(
      /No SQLite table named no_such_table/,
    );
    // The kind is what decides, so a name that exists under ANOTHER kind raises too rather
    // than quietly resolving to the row that does exist.
    await expect(objects.readObjectSource!(["orders", "orders"], "trigger")).rejects.toThrow(
      /No SQLite trigger named orders/,
    );
  });

  test("a kind this engine does not declare, and a path of the wrong shape, both raise", async () => {
    objects = await connectedWithObjects();

    await expect(objects.readObjectSource!(["x"], "procedure")).rejects.toThrow(
      /SQLite declares no object kind "procedure"/,
    );
    await expect(objects.readObjectSource!(["orders_stamp"], "trigger")).rejects.toThrow(
      /A SQLite "trigger" path is \[table, name\], received \["orders_stamp"\]/,
    );
  });

  /**
   * The refusal this engine CANNOT produce, driven anyway.
   *
   * `sqlite_schema.sql` is NULL for exactly one shape, an index the engine made for itself,
   * and the provider's `name NOT LIKE 'sqlite\_%' ESCAPE '\'` filter keeps every one of those
   * out of the listing, so no path the tree offers can reach it. That is why
   * docs/providers/sqlite.md states the absence of a refusal as a CANNOT rather than leaving a
   * reader to wonder. The arm still exists, because "unreachable today" is not "cannot be
   * written", and this is what the suite would say if the read ever started producing one: a
   * REFUSAL part carrying a sentence, never an empty editor over a definition.
   */
  test("a NULL definition becomes a refusal part rather than an empty text", async () => {
    objects = await connectedWithObjects();
    captureReadsMatching(objects, "FROM sqlite_schema AS s", [{ sql: null }]);

    const document = await objects.readObjectSource!(["orders"], "table");
    const [part] = document.parts;

    expect(isSourcePartUnavailable(part)).toBe(true);
    if (!isSourcePartUnavailable(part)) throw new Error("narrowing");
    expect(part.id).toBe("definition");
    expect(part.unavailable).toContain("sqlite_schema.sql is NULL");
    // The CAUSE is asserted, and it is asserted HERE and nowhere else: NULL is the only one of
    // the three blank shapes for which "an index SQLite created for itself" is a true reason.
    expect(part.unavailable).toContain("an index it created for itself");
    // Not an empty string and not whitespace: a refusal that says nothing is not a refusal.
    expect(part.unavailable.trim().length).toBeGreaterThan(20);
  });

  test("a whitespace-only definition is refused too, and is NOT reported as the engine's NULL", async () => {
    objects = await connectedWithObjects();
    captureReadsMatching(objects, "FROM sqlite_schema AS s", [{ sql: "   \n  " }]);

    const [part] = (await objects.readObjectSource!(["orders"], "table")).parts;

    expect(isSourcePartUnavailable(part)).toBe(true);
    if (!isSourcePartUnavailable(part)) throw new Error("narrowing");
    expect(part.unavailable).toContain("no non-whitespace character");
    // The sentence must not carry a cause that is false for this shape: the row is present and
    // the column is present, so nothing here is an index the engine made for itself.
    expect(part.unavailable).not.toContain("an index it created for itself");
    expect(part.unavailable).not.toContain("is NULL");
  });

  /**
   * The three guards a correct DECLARATION cannot reach, driven through the declaration.
   *
   * Each one is a different way the declaration and this method can disagree, and none is
   * reachable with the four kinds SQLite really declares: a kind that is declared and not
   * source-bearing, a kind that declares source and forgets the Monaco id that renders it,
   * and a kind that declares source and has no catalog type behind it. A `spyOn` on
   * `getCapabilities` is the only seam that reaches them, and reaching them is what says
   * the guards are live rather than covered.
   */
  test("a declared kind that is not source-bearing, or is under-declared, raises by name", async () => {
    objects = await connectedWithObjects();
    const real = objects.getCapabilities();
    const withKind = (extra: ObjectKindSpec) =>
      spyOn(objects, "getCapabilities").mockReturnValue({ ...real, objectKinds: [...(real.objectKinds ?? []), extra] });

    const noSource = withKind({ id: "synonym", role: "config", label: "Synonym", labelPlural: "Synonyms" });
    try {
      await expect(objects.readObjectSource!(["x"], "synonym")).rejects.toThrow(
        /SQLite publishes no definition text for the kind "synonym"/,
      );
    } finally {
      noSource.mockRestore();
    }

    const noLanguage = withKind({
      id: "synonym",
      role: "config",
      label: "Synonym",
      labelPlural: "Synonyms",
      hasSource: true,
    });
    try {
      await expect(objects.readObjectSource!(["x"], "synonym")).rejects.toThrow(
        /declares readable source for the kind "synonym" and no sourceLanguage/,
      );
    } finally {
      noLanguage.mockRestore();
    }

    const noStatement = withKind({
      id: "synonym",
      role: "config",
      label: "Synonym",
      labelPlural: "Synonyms",
      hasSource: true,
      sourceLanguage: "sql",
    });
    try {
      await expect(objects.readObjectSource!(["x"], "synonym")).rejects.toThrow(
        /declares readable source for the kind "synonym" but has no catalog type that reads it/,
      );
    } finally {
      noStatement.mockRestore();
    }
  });

  /**
   * Recipe rule 6's own failure mode, driven on the engine that has no refusal.
   *
   * A reply whose definition COLUMN is spelled differently reads as `undefined` rather than
   * as an error, and a document of one refusal part passes every count and length assertion
   * there is. Here it becomes a refusal rather than an empty text, which is the only correct
   * answer; the per-kind text pin above is what would notice that the live read had started
   * doing it.
   */
  test("a reply carrying no sql column at all becomes a refusal that names the READ, not the object", async () => {
    objects = await connectedWithObjects();
    captureReadsMatching(objects, "FROM sqlite_schema AS s", [{}]);

    const [part] = (await objects.readObjectSource!(["orders"], "table")).parts;

    expect(isSourcePartUnavailable(part)).toBe(true);
    if (!isSourcePartUnavailable(part)) throw new Error("narrowing");
    // This arm is the defect recipe rule 6 exists for, so its sentence has to send a reader to
    // the statement rather than to the object. A reason claiming the engine stored NULL for an
    // index of its own would send them to the listing filter instead, and it would be false:
    // the row is there and the column this provider asked for is not.
    expect(part.unavailable).toContain("no sqlite_schema.sql column at all");
    expect(part.unavailable).not.toContain("an index it created for itself");
  });

  test("the caller's bound cuts the text and says so, and an exact answer is never marked", async () => {
    objects = await connectedWithObjects();
    const [whole] = (await objects.readObjectSource!(["orders"], "table")).parts;
    if (isSourcePartUnavailable(whole)) throw new Error("narrowing");

    const [cut] = (await objects.readObjectSource!(["orders"], "table", 20)).parts;
    if (isSourcePartUnavailable(cut)) throw new Error("narrowing");

    expect(whole.text.length).toBeGreaterThan(20);
    expect(cut.text).toBe(whole.text.slice(0, 20));
    expect(cut.truncated).toEqual({ limit: 20, reason: sourceBoundTruncationReason(20) });

    const [uncut] = (await objects.readObjectSource!(["orders"], "table", whole.text.length)).parts;
    if (isSourcePartUnavailable(uncut)) throw new Error("narrowing");
    expect(uncut.truncated).toBeUndefined();
  });

  /**
   * Standing ruling 5g, on a zero-level engine, driven to the BOUND VALUE (#789).
   *
   * A zero-level engine's own fixture cannot tell a hardcoded depth from a derived one, so the
   * declaration is swapped for a two-level one and a three-segment path is driven all the way
   * to the binds. Two mutations die here and nowhere else in this suite: a shape check written
   * `path.length !== 1` refuses this path, and a name bind written `path[0]` binds "cat"
   * instead of "obj".
   */
  test("derives the object name and the path shape from the DECLARATION, not from a position", async () => {
    objects = await connectedWithObjects();
    const spy = spyOn(objects, "getCapabilities").mockReturnValue({
      ...objects.getCapabilities(),
      containerLevels: [
        { id: "catalog", label: "Database", labelPlural: "Databases" },
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
      ],
    });
    try {
      const captured = captureReadsMatching(objects, "FROM sqlite_schema AS s", [{ sql: "CREATE TABLE obj (a)" }]);

      const document = await objects.readObjectSource!(["cat", "sch", "obj"], "table");

      expect(captured.params).toEqual([["table", "obj"]]);
      expect(document.path).toEqual(["cat", "sch", "obj"]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("SQLiteProvider bulk column read (#789)", () => {
  let objects: SQLiteProvider;

  afterEach(async () => {
    if (objects?.isConnected()) await objects.disconnect();
  });

  /**
   * Every statement the provider prepared from here on, in order.
   *
   * The only way to assert "no round trip at all", which is the claim a kind with no
   * columns makes, and the only way to assert that the round trips are CONSTANT in the
   * number of objects rather than one per object - the property this method exists for.
   * Everything still reaches the real database, so the assertions beside the count are
   * live answers and not a double's.
   */
  function recordPrepares(provider: SQLiteProvider): string[] {
    const holder = provider as unknown as { db: SQLiteDatabase };
    const real = holder.db;
    const seen: string[] = [];
    holder.db = {
      exec: (sql: string) => real.exec(sql),
      close: (throwOnError?: boolean) => real.close(throwOnError),
      get inTransaction() {
        return real.inTransaction;
      },
      prepare: (sql: string) => {
        seen.push(sql);
        return real.prepare(sql);
      },
    };
    return seen;
  }

  test("describes every table in the folder, and each detail is what describeObject answers for the same object", async () => {
    objects = await connectedWithObjects();

    const batch = await objects.describeObjects([], "table");

    expect(batch.truncated).toBeUndefined();
    expect(batch.details.map((detail) => detail.path)).toEqual([
      ["archive"],
      ["audit_log"],
      ["customers"],
      ["notes"],
      ["orders"],
      ["sqliteXledger"],
    ]);
    // The two readings of the same object, compared whole. One mapper serves both, so a
    // divergence here is the bulk read spelling a column, an index or a foreign key
    // differently from the single read of the same table - the defect two mappers cause.
    for (const detail of batch.details) {
      expect(detail).toEqual(await objects.describeObject(detail.path, "table"));
    }
  });

  test("every described path is one listObjects produced", async () => {
    objects = await connectedWithObjects();

    const listed = await objects.listObjects([], "table");
    const batch = await objects.describeObjects([], "table");

    // Both sides come from the provider; nothing here is a path this test typed.
    expect(batch.details.map((detail) => detail.path)).toEqual(listed.map((object) => object.path));
  });

  test("a view is described from the same statements a table is", async () => {
    objects = await connectedWithObjects();

    const batch = await objects.describeObjects([], "view");

    expect(batch.details).toHaveLength(1);
    expect(batch.details[0]!.path).toEqual(["order_summary"]);
    expect(batch.details[0]!.columns.map((column) => column.name)).toEqual(["id", "total"]);
    // Measured: `pragma_index_list` and `pragma_foreign_key_list` both answer zero rows
    // for a view, so the two reads happen and find nothing rather than being skipped.
    expect(batch.details[0]!.indexes).toEqual([]);
    expect(batch.details[0]!.foreignKeys).toEqual([]);
  });

  test("an index and a trigger answer an empty batch with no round trip at all", async () => {
    objects = await connectedWithObjects();
    const prepared = recordPrepares(objects);

    await expect(objects.describeObjects([], "index")).resolves.toEqual({ details: [] });
    await expect(objects.describeObjects([], "trigger")).resolves.toEqual({ details: [] });

    // Not "no rows came back": no statement was sent. Neither kind has columns on this
    // engine - measured, `pragma_table_xinfo` answers zero rows for an index name and for
    // a trigger name - and that is a fact about the KIND, so it is answered from the
    // declaration and never from the catalog.
    expect(prepared).toEqual([]);
    // The control: a kind that DOES have columns still reaches the database.
    await objects.describeObjects([], "view");
    expect(prepared.length).toBeGreaterThan(0);
  });

  test("an undeclared kind raises, naming the engine and the kind", async () => {
    objects = await connectedWithObjects();

    // Never an empty batch. An undeclared kind is a fact about SQLite and an empty answer
    // would be a claim about the file.
    await expect(objects.describeObjects([], "sequence")).rejects.toThrow(/SQLite declares no object kind "sequence"/);
  });

  test("a container path of the wrong shape raises through the declaration, not a literal depth", async () => {
    objects = await connectedWithObjects();

    await expect(objects.describeObjects(["main"], "table")).rejects.toThrow(/A SQLite container path is empty/);
  });

  test("a two-level declaration is accepted and reaches the produced path", async () => {
    // Standing ruling 5g, driven to a VALUE and not to a refusal. SQLite declares no
    // container level, so the hardcoded spellings this rule forbids - `container.length
    // !== 0` here, `[row.name]` in the path builder - are behaviour-identical on the real
    // engine and only a differently shaped declaration can tell them apart.
    objects = await connectedWithObjects();
    spyOn(objects, "getCapabilities").mockReturnValue({
      ...objects.getCapabilities(),
      containerLevels: [
        { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
      ],
    });

    const batch = await objects.describeObjects(["warehouse", "app"], "table");

    // Every path carries both container segments, so the prefix is derived from the
    // declaration rather than assumed empty.
    expect(batch.details.map((detail) => detail.path)).toEqual([
      ["warehouse", "app", "archive"],
      ["warehouse", "app", "audit_log"],
      ["warehouse", "app", "customers"],
      ["warehouse", "app", "notes"],
      ["warehouse", "app", "orders"],
      ["warehouse", "app", "sqliteXledger"],
    ]);
    // And the shape that WAS valid a moment ago is refused, with the declared level
    // labels in the sentence.
    await expect(objects.describeObjects([], "table")).rejects.toThrow(
      /A SQLite container path is \[catalog, schema\]/,
    );
  });

  test("a limit that is not a positive whole number raises rather than clamping", async () => {
    objects = await connectedWithObjects();

    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(objects.describeObjects([], "table", limit)).rejects.toThrow(
        /A SQLite bulk column read limit must be a positive whole number/,
      );
    }
    // Not clamped and not ignored: a 0 would answer nothing while reporting a truncation
    // the caller never asked for.
    expect(true).toBe(true);
  });

  test("a bound that bites reports the caller's own limit, and one that does not never reports", async () => {
    objects = await connectedWithObjects();

    const bounded = await objects.describeObjects([], "table", 2);
    expect(bounded.details).toHaveLength(2);
    expect(bounded.truncated?.limit).toBe(2);
    expect(bounded.truncated?.reason.length).toBeGreaterThan(0);

    // Exactly as many as the folder holds. `limit + 1` is what the statement carries, so
    // a saturated read is told from an exact one without a second count.
    const exact = await objects.describeObjects([], "table", EXPECTED_COUNTS.table);
    expect(exact.details).toHaveLength(EXPECTED_COUNTS.table);
    expect(exact.truncated).toBeUndefined();

    const unbounded = await objects.describeObjects([], "table");
    expect(unbounded.details).toHaveLength(EXPECTED_COUNTS.table);
    expect(unbounded.truncated).toBeUndefined();
  });

  test("the bound cuts the engine's own order, and the answer is sorted by path", async () => {
    objects = await connectedWithObjects();

    const bounded = await objects.describeObjects([], "table", 3);

    // `ORDER BY t.name` in the target, which on SQLite runs under BINARY, the UTF-8 byte
    // order: measured, `pragma_table_list` answers in no useful order at all without it,
    // so the bound would otherwise keep an arbitrary three of the six.
    expect(bounded.details.map((detail) => detail.path)).toEqual([["archive"], ["audit_log"], ["customers"]]);
    expect(bounded.truncated).toEqual({ limit: 3, reason: bounded.truncated!.reason });
  });

  test("the engine cuts under BINARY and the answer is sorted by path, and those are two different orders", async () => {
    // The one probe that can tell the two apart on this engine, and it is a real
    // disagreement rather than a contrived one. SQLite's `ORDER BY name` runs under
    // BINARY, the UTF-8 BYTE order, where U+E000 (EE 80 80) sorts below U+1F600
    // (F0 9F 98 80); JavaScript compares UTF-16 CODE UNITS, where the surrogate 0xD83D
    // sorts below 0xE000. So the engine's order and `comparePaths`' order are opposite
    // here, which is why the membership of a bounded cut is the server's and the ORDER of
    // the answer is ours.
    const named = new SQLiteProvider(makeSQLiteConfig());
    await named.connect();
    try {
      await named.query('CREATE TABLE "\u{1F600}" (x INTEGER)');
      await named.query('CREATE TABLE "\uE000" (x INTEGER)');

      const engineOrder = (
        await named.query(
          "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table'" +
            " AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
        )
      ).rows as { name: string }[];
      expect(engineOrder.map((row) => row.name)).toEqual(["\uE000", "\u{1F600}"]);

      const batch = await named.describeObjects([], "table");
      expect(batch.details.map((detail) => detail.path)).toEqual([["\u{1F600}"], ["\uE000"]]);

      // And the cut keeps the engine's first, which is the other one.
      const bounded = await named.describeObjects([], "table", 1);
      expect(bounded.details.map((detail) => detail.path)).toEqual([["\uE000"]]);
      expect(bounded.truncated?.limit).toBe(1);
    } finally {
      await named.disconnect();
    }
  });

  test("the round trips are constant in the number of objects", async () => {
    objects = await connectedWithObjects();
    const prepared = recordPrepares(objects);

    const batch = await objects.describeObjects([], "table");

    // Six objects, five statements: the target plus the four detail reads. The whole
    // reason this method exists is that the caller's alternative was one describeObject
    // per object, which is 6 x (1 column read + 1 index list + N index reads + 1 foreign
    // key list) here.
    expect(batch.details).toHaveLength(6);
    expect(prepared).toHaveLength(5);
  });

  test("a generated column survives the bulk read, as it does the single one", async () => {
    objects = await connectedWithObjects();

    const batch = await objects.describeObjects([], "table");
    const orders = batch.details.find((detail) => detail.path[0] === "orders")!;

    // `pragma_table_xinfo` and not `pragma_table_info`, which DROPS a generated column in
    // both spellings. `getSchema()` still reads `table_info` and still loses it; the bulk
    // read inherits the object model's catalog and not the flat surface's.
    expect(orders.columns.map((column) => column.name)).toContain("total_with_tax");
  });

  test("an expression index publishes no fabricated column name", async () => {
    objects = await connectedWithObjects();

    const batch = await objects.describeObjects([], "table");
    const orders = batch.details.find((detail) => detail.path[0] === "orders")!;

    // `idx_orders_doubled` keys `total * 2`, whose `index_info` row carries a null name.
    // A null there is not a column of this object, so it is left out rather than rendered
    // as a label - and the index itself still appears, with an empty column list.
    expect(orders.indexes).toEqual([
      { name: "idx_orders_customer", columns: ["customer_id"], unique: false },
      { name: "idx_orders_doubled", columns: [], unique: false },
    ]);
  });

  test("a foreign key naming no column resolves the parent's primary key", async () => {
    objects = await connectedWithObjects();

    const batch = await objects.describeObjects([], "table");
    const orders = batch.details.find((detail) => detail.path[0] === "orders")!;

    // `REFERENCES customers` with no column list answers `to = NULL`, which SQLite reads
    // as the parent's PRIMARY KEY. `ForeignKeySchema.referencedColumn` is a string, so
    // the alternative to resolving it is a null in a typed string field.
    // In `pragma_foreign_key_list`'s own order, which is by its `id` and is the reverse of
    // the declaration order: both reads carry the same `ORDER BY id, seq`.
    expect(orders.foreignKeys).toEqual([
      { columnName: "customer_email", referencedTable: "customers", referencedColumn: "email" },
      { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
    ]);
  });
});

describe("comparePaths", () => {
  // Exported for the same reason `readDbstatSizes` is: the ordering rule is shared with
  // every other provider in #789, and the cases that separate it from `JSON.stringify`
  // cannot arise on an engine whose paths within one kind are all the same length.
  test("orders by segments, so a prefix sorts above what nests under it", () => {
    // The `JSON.stringify` spelling gets this backwards: `,` (0x2C) is below `]` (0x5D),
    // so the deeper path would sort first and a trigger would sit above its own table.
    expect(comparePaths(["orders"], ["orders", "orders_stamp"])).toBeLessThan(0);
    expect(comparePaths(["orders", "orders_stamp"], ["orders"])).toBeGreaterThan(0);
    expect(comparePaths(["orders"], ["orders"])).toBe(0);
  });

  test("orders by code point, so an escaped name is not reordered by its escape", () => {
    // `JSON.stringify(["a\\"b"])` is `["a\\\\"b"]`, whose third character is a backslash
    // (0x5C) rather than the quote (0x22) the name actually holds.
    expect(comparePaths(['a"b'], ["a\\b"])).toBeLessThan(0);
    expect(comparePaths(["a", "z"], ["b", "a"])).toBeLessThan(0);
  });
});

// ============================================================================
// Agent read-only execution profile (#328) — bun driver, in-process
//
// The security boundary asserted here is the DATABASE's own read-only open,
// never a SQL classifier: every rejection case drives hostile SQL straight
// through the profile and then re-reads the data with a writable handle to
// prove nothing landed. Assertions are behavioral on purpose — bun and node
// report read-only violations with different codes and messages, so a test
// that asserted either would pass on one adapter and fail on the other.
// ============================================================================

const AGENT_BUDGET: ReadOnlyStatementBudget = {
  statementTimeoutMs: 5_000,
  maxResultRows: 100,
  maxResultBytes: 64 * 1024,
};

describe("SQLiteProvider agent read-only execution profile (#328)", () => {
  let agentTmpDir: string;
  let seeded = 0;
  let agent: SQLiteProvider | null = null;
  let writable: SQLiteProvider | null = null;

  beforeAll(() => {
    agentTmpDir = mkdtempSync(join(tmpdir(), "libredb-sqlite-agent-"));
  });

  afterAll(() => {
    rmSync(agentTmpDir, { recursive: true });
  });

  afterEach(async () => {
    for (const p of [agent, writable]) {
      try {
        if (p?.isConnected()) await p.disconnect();
      } catch {
        // Ignore cleanup errors
      }
    }
    agent = null;
    writable = null;
  });

  /** Create a real on-disk database with one seeded row, then close the writer. */
  async function seedDatabase(): Promise<string> {
    const dbPath = join(agentTmpDir, `agent-${++seeded}.db`);
    const seed = new SQLiteProvider(makeSQLiteConfig({ database: dbPath }));
    await seed.connect();
    await seed.query("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await seed.query("INSERT INTO t (id, v) VALUES (1, 'seeded')");
    await seed.disconnect();
    return dbPath;
  }

  /** Rows currently in `t`, read back through an independent writable handle. */
  async function readBack(dbPath: string): Promise<Record<string, unknown>[]> {
    const reader = new SQLiteProvider(makeSQLiteConfig({ database: dbPath }));
    await reader.connect();
    try {
      return (await reader.query("SELECT id, v FROM t ORDER BY id")).rows;
    } finally {
      await reader.disconnect();
    }
  }

  async function openAgent(dbPath: string): Promise<SQLiteProvider> {
    agent = new SQLiteProvider(makeSQLiteConfig({ database: dbPath }), {}, { readOnly: true });
    await agent.connect();
    return agent;
  }

  test("returns rows for a legitimate SELECT", async () => {
    const dbPath = await seedDatabase();
    const profile = await openAgent(dbPath);

    const result = await profile.queryReadOnly("SELECT id, v FROM t ORDER BY id", AGENT_BUDGET);

    expect(result.rows).toEqual([{ id: 1, v: "seeded" }]);
    expect(result.fields).toEqual(["id", "v"]);
    expect(result.rowCount).toBe(1);
  });

  test("the database itself rejects a write through the profile", async () => {
    const dbPath = await seedDatabase();
    const profile = await openAgent(dbPath);

    await expect(profile.queryReadOnly("INSERT INTO t (id, v) VALUES (2, 'agent')", AGENT_BUDGET)).rejects.toThrow();

    expect(await readBack(dbPath)).toEqual([{ id: 1, v: "seeded" }]);
  });

  test("the database itself rejects a schema change through the profile", async () => {
    const dbPath = await seedDatabase();
    const profile = await openAgent(dbPath);

    await expect(profile.queryReadOnly("CREATE TABLE injected (id INTEGER)", AGENT_BUDGET)).rejects.toThrow();
    await expect(profile.queryReadOnly("DROP TABLE t", AGENT_BUDGET)).rejects.toThrow();

    const tables = await profile.queryReadOnly("SELECT name FROM sqlite_master WHERE type = 'table'", AGENT_BUDGET);
    expect(tables.rows).toEqual([{ name: "t" }]);
  });

  test("a missing file in an existing directory is not created", async () => {
    // The sharp no-create case: the shared editor path would create this file
    // (it passes `create: true` and mkdirs first), so a read-only open that
    // silently fell back to read-write would leave the file behind.
    const missingFile = join(agentTmpDir, "never-created.db");

    const profile = new SQLiteProvider(makeSQLiteConfig({ database: missingFile }), {}, { readOnly: true });
    await expect(profile.connect()).rejects.toThrow();

    expect(profile.isConnected()).toBe(false);
    expect(existsSync(missingFile)).toBe(false);
  });

  test("a missing parent directory is not created either", async () => {
    const missingDir = join(agentTmpDir, "not-created");
    const missingFile = join(missingDir, "absent.db");

    const profile = new SQLiteProvider(makeSQLiteConfig({ database: missingFile }), {}, { readOnly: true });
    await expect(profile.connect()).rejects.toThrow();

    expect(existsSync(missingDir)).toBe(false);
  });

  test("PRAGMA query_only reads back enabled after open", async () => {
    const dbPath = await seedDatabase();
    const profile = await openAgent(dbPath);

    const pragma = await profile.queryReadOnly("PRAGMA query_only", AGENT_BUDGET);

    expect(pragma.rows).toEqual([{ query_only: 1 }]);
  });

  test("query_only is re-asserted before every statement, so a disable cannot persist", async () => {
    const dbPath = await seedDatabase();
    const profile = await openAgent(dbPath);

    // The statement itself succeeds — nothing parses it — but it cannot leave
    // the session disabled for the next call, because the profiled provider is
    // pooled and reused across an agent run.
    await profile.queryReadOnly("PRAGMA query_only = false", AGENT_BUDGET);

    expect((await profile.queryReadOnly("PRAGMA query_only", AGENT_BUDGET)).rows).toEqual([{ query_only: 1 }]);
    await expect(profile.queryReadOnly("INSERT INTO t (id, v) VALUES (2, 'bypass')", AGENT_BUDGET)).rejects.toThrow();
    expect(await readBack(dbPath)).toEqual([{ id: 1, v: "seeded" }]);
  });

  test("VACUUM INTO cannot copy the database to another path, even after disabling query_only", async () => {
    const dbPath = await seedDatabase();
    const profile = await openAgent(dbPath);
    const stolen = join(agentTmpDir, `stolen-${seeded}.db`);

    // A read-only OPEN only governs the target database file: on a handle
    // whose query_only is off, this statement copies the whole database to an
    // arbitrary server path on BOTH adapters (verified). query_only is what
    // refuses it, which is why it is re-asserted per statement.
    await profile.queryReadOnly("PRAGMA query_only = false", AGENT_BUDGET);
    await expect(profile.queryReadOnly(`VACUUM INTO '${stolen}'`, AGENT_BUDGET)).rejects.toThrow();

    // KNOWN LIMITATION: the engine creates the target file before refusing the
    // copy, so an empty file can still appear at an agent-chosen path. What
    // must never happen is readable data landing in it.
    expect(existsSync(stolen) ? statSync(stolen).size : 0).toBe(0);
  });

  test("executes only the first statement of multi-statement input; the tail never runs", async () => {
    const dbPath = await seedDatabase();
    const profile = await openAgent(dbPath);

    // prepare() compiles a single statement and drops the tail on both
    // adapters. The profile must therefore never reach exec(), which would run
    // every statement. Silent truncation is not an acceptable pass either —
    // input-stage denial of multi-statement text is the policy pipeline's job.
    const result = await profile.queryReadOnly("SELECT id FROM t; INSERT INTO t VALUES (2, 'tail')", AGENT_BUDGET);

    expect(result.rows).toEqual([{ id: 1 }]);
    expect(await readBack(dbPath)).toEqual([{ id: 1, v: "seeded" }]);
  });

  test("a writable provider on the same file still writes while the profile is open", async () => {
    const dbPath = await seedDatabase();
    const profile = await openAgent(dbPath);

    writable = new SQLiteProvider(makeSQLiteConfig({ database: dbPath }));
    await writable.connect();
    const insert = await writable.query("INSERT INTO t (id, v) VALUES (2, 'editor')");

    expect(insert.rowCount).toBe(1);
    expect(await profile.queryReadOnly("SELECT COUNT(*) AS c FROM t", AGENT_BUDGET)).toMatchObject({
      rows: [{ c: 2 }],
    });
  });

  test("refuses queryReadOnly on a provider that was not opened read-only (fail closed)", async () => {
    const dbPath = await seedDatabase();
    writable = new SQLiteProvider(makeSQLiteConfig({ database: dbPath }));
    await writable.connect();

    await expect(writable.queryReadOnly("SELECT 1 AS one", AGENT_BUDGET)).rejects.toThrow(QueryError);
    // The refusal is what keeps the writable handle from becoming an agent
    // path: the statement must not have run at all.
    await expect(writable.queryReadOnly("INSERT INTO t (id, v) VALUES (3, 'x')", AGENT_BUDGET)).rejects.toThrow(
      QueryError,
    );
    expect(await readBack(dbPath)).toEqual([{ id: 1, v: "seeded" }]);
  });

  test("refuses an in-memory database under the read-only profile", async () => {
    const profile = new SQLiteProvider(makeSQLiteConfig({ database: ":memory:" }), {}, { readOnly: true });

    // A read-only open of an anonymous database can only ever yield an empty
    // one (node) or fail outright (bun); vending it would be a silently
    // useless agent target. The refusal carries a deny code, and connect()
    // must not wrap it into a generic ConnectionError.
    const error = await profile.connect().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as ExecutionProfileError).reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(profile.isConnected()).toBe(false);
  });

  test("enforces the row budget with a typed error instead of truncating", async () => {
    const dbPath = await seedDatabase();
    const profile = await openAgent(dbPath);

    const rows = await profile.queryReadOnly("SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3", {
      ...AGENT_BUDGET,
      maxResultRows: 3,
    });
    expect(rows.rowCount).toBe(3);

    await expect(
      profile.queryReadOnly("SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3", {
        ...AGENT_BUDGET,
        maxResultRows: 2,
      }),
    ).rejects.toThrow(QueryError);
  });

  test("the row budget refusal a grounding capture records is parsed out of THIS message (B54)", async () => {
    /*
      The loop B54 closes, closed at both ends.

      A refused schema capture now writes a `context-unavailable` ledger entry carrying
      the two numbers — rows projected against rows allowed — and the only place those
      numbers exist is inside the sentence this provider formats: neither `QueryError`
      nor the tool refusal that wraps it carries them as fields, so `rowBudgetIn` reads
      them back out of the message.

      That is a silent-failure shape, which is why this test drives the REAL provider
      instead of asserting against a hand-typed copy of the sentence. Reword the message
      in `sqlite.ts` and this goes red here, rather than going quiet in production and
      re-opening the entry with the ledger blank again.
    */
    const dbPath = await seedDatabase();
    const profile = await openAgent(dbPath);

    const thrown = await profile
      .queryReadOnly("SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3", { ...AGENT_BUDGET, maxResultRows: 2 })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(thrown).toBeInstanceOf(QueryError);
    expect(rowBudgetIn((thrown as QueryError).message)).toEqual({ projected: 3, allowed: 2 });

    /*
      PostgreSQL formats the same sentence in its own file and cannot be driven from
      here without a server, so its copy is pinned against the SOURCE. Weaker than the
      live arm above — it proves the template still reads that way, not that a running
      engine produces it — and still red on a reword, which is the property that matters.
    */
    // Anchored to this file, like every other source read in the suite: a cwd-relative read
    // would fail here naming a path rather than the rule it is checking.
    const postgresSource = readFileSync(join(REPO_ROOT, "src/lib/db/providers/sql/postgres.ts"), "utf8");
    expect(postgresSource).toContain(
      "Read-only execution exceeded the row budget: ${result.rows.length} rows > ${budget.maxResultRows} allowed",
    );
  });

  test("enforces the byte budget with a typed error instead of truncating", async () => {
    const dbPath = await seedDatabase();
    const profile = await openAgent(dbPath);

    await expect(
      profile.queryReadOnly("SELECT 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' AS big", { ...AGENT_BUDGET, maxResultBytes: 8 }),
    ).rejects.toThrow(QueryError);
  });

  test("rejects a statement that overruns the timeout budget", async () => {
    const dbPath = await seedDatabase();
    const profile = await openAgent(dbPath);

    // Neither adapter exposes sqlite3_interrupt or a progress handler, so the
    // timeout is a post-execution deadline: the statement is not preempted,
    // but its result is refused. See docs/providers/sqlite.md section 12.
    await expect(
      profile.queryReadOnly(
        "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 400000) SELECT COUNT(*) AS n FROM c",
        { ...AGENT_BUDGET, statementTimeoutMs: 1 },
      ),
    ).rejects.toThrow(QueryError);
  });

  test.each([
    ["statementTimeoutMs", { statementTimeoutMs: 0 }],
    ["maxResultRows", { maxResultRows: -1 }],
    ["maxResultBytes", { maxResultBytes: 1.5 }],
  ])("refuses the whole call when budget field %s is not a positive integer", async (_field, override) => {
    const dbPath = await seedDatabase();
    const profile = await openAgent(dbPath);

    await expect(
      profile.queryReadOnly("SELECT 1 AS one", { ...AGENT_BUDGET, ...override } as ReadOnlyStatementBudget),
    ).rejects.toThrow(QueryError);
  });

  test("attaching a second database creates nothing and cannot be written through", async () => {
    const dbPath = await seedDatabase();
    const otherPath = await seedDatabase();
    const profile = await openAgent(dbPath);
    const absent = join(agentTmpDir, `attach-absent-${seeded}.db`);

    // A missing file is not created by ATTACH either — same no-create property
    // as the profile's own open.
    await expect(profile.queryReadOnly(`ATTACH DATABASE '${absent}' AS absent`, AGENT_BUDGET)).rejects.toThrow();
    expect(existsSync(absent)).toBe(false);

    // An EXISTING file attaches successfully: the read-only mode is inherited,
    // so writes through it are refused...
    await profile.queryReadOnly(`ATTACH DATABASE '${otherPath}' AS other`, AGENT_BUDGET);
    await expect(profile.queryReadOnly("INSERT INTO other.t (id, v) VALUES (2, 'x')", AGENT_BUDGET)).rejects.toThrow();
    expect(await readBack(otherPath)).toEqual([{ id: 1, v: "seeded" }]);

    // ...but its ROWS become readable, and neither adapter offers a
    // database-native control that would stop that (bun:sqlite exposes no
    // authorizer at all). This is asserted rather than wished away: the only
    // control for out-of-scope READS through ATTACH is the input-stage denial in
    // the operations layer (tests/security/agent-statement-boundary.test.ts),
    // which is why that denial exists. Recorded as a known limitation in
    // docs/providers/sqlite.md section 12 and docs/BACKLOG.md.
    const leaked = await profile.queryReadOnly("SELECT v FROM other.t", AGENT_BUDGET);
    expect(leaked.rows).toEqual([{ v: "seeded" }]);

    await profile.queryReadOnly("DETACH DATABASE other", AGENT_BUDGET);
    await expect(profile.queryReadOnly("DETACH DATABASE main", AGENT_BUDGET)).rejects.toThrow();
  });

  test("refuses a handle whose query_only pragma does not read back enabled", () => {
    // The happy path is covered by every test above; these pin the refusal for
    // a driver that accepts `PRAGMA query_only = true` and ignores it.
    expect(() => assertQueryOnlyEnabled([{ query_only: 1 }])).not.toThrow();
    expect(() => assertQueryOnlyEnabled([{ query_only: 0 }])).toThrow(ConnectionError);
    expect(() => assertQueryOnlyEnabled([])).toThrow(ConnectionError);
  });
});

// ============================================================================
// 64-bit integers (#39)
//
// SQLite's INTEGER is signed 64-bit, so an id past 2^53 has no exact JavaScript
// `number`. Measured on the two drivers with their defaults: bun:sqlite (the
// Docker image) silently answered 9007199254740992 for 9007199254740993 - the
// row NEXT to the one asked for, which the inline editor then used as its
// UPDATE key and edited the neighbour; node:sqlite threw ERR_OUT_OF_RANGE.
// Both drivers now read 64-bit integers as BigInt and the provider's driver seam
// converts them back: exactly representable -> number, otherwise -> decimal
// string, the same answer `supportBigNumbers` gives on MySQL.
// ============================================================================

describe("64-bit integers past 2^53", () => {
  /** 2^53, the first integer a JS number cannot separate from its neighbour. */
  const TWO_53 = "9007199254740992";
  const TWO_53_PLUS_1 = "9007199254740993";

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

  async function connectWithBigIds(): Promise<SQLiteProvider> {
    const db = new SQLiteProvider(makeSQLiteConfig());
    await db.connect();
    await db.query("CREATE TABLE big (id INTEGER PRIMARY KEY, label TEXT)");
    await db.query(`INSERT INTO big (id, label) VALUES (${TWO_53}, 'neighbour')`);
    await db.query(`INSERT INTO big (id, label) VALUES (${TWO_53_PLUS_1}, 'target')`);
    return db;
  }

  test("reads both ids back with every digit, and keeps them apart", async () => {
    provider = await connectWithBigIds();

    const rows = (await provider.query("SELECT id, label FROM big ORDER BY id")).rows as Record<string, unknown>[];

    expect(rows.map((row) => String(row.id))).toEqual([TWO_53, TWO_53_PLUS_1]);
    expect(String(rows[1].id)).not.toBe(TWO_53);
    expect(rows[0].id).not.toEqual(rows[1].id);
  });

  // The damage the defect actually did: the id read back was the neighbour's, so the
  // UPDATE the inline editor builds from it wrote to the wrong row.
  test("an UPDATE keyed on the id that was read lands on that row, not the one next to it", async () => {
    provider = await connectWithBigIds();

    const read = (await provider.query("SELECT id, label FROM big ORDER BY id")).rows as Record<string, unknown>[];
    const target = read.find((row) => row.label === "target")!;
    await provider.query("UPDATE big SET label = 'edited' WHERE id = ?", [target.id]);

    const after = (await provider.query("SELECT id, label FROM big ORDER BY id")).rows as Record<string, unknown>[];
    expect(after.map((row) => [String(row.id), row.label])).toEqual([
      [TWO_53, "neighbour"],
      [TWO_53_PLUS_1, "edited"],
    ]);
  });

  // Rows are serialized to the browser with JSON.stringify, which refuses BigInt
  // outright, so "turn the driver flag on" without this conversion breaks the
  // connection itself rather than fixing anything.
  test("hands back no BigInt anywhere, so rows survive JSON.stringify", async () => {
    provider = await connectWithBigIds();

    const rows = (await provider.query("SELECT id, label FROM big ORDER BY id")).rows as Record<string, unknown>[];
    for (const row of rows) {
      for (const value of Object.values(row)) {
        expect(typeof value).not.toBe("bigint");
      }
    }
    expect(() => JSON.stringify(rows)).not.toThrow();
    expect(JSON.parse(JSON.stringify(rows))[1].id).toBe(TWO_53_PLUS_1);
  });

  // The driver flag is all-or-nothing - `1` and COUNT(*) become BigInt too - so the
  // conversion has to hand ordinary integers back as ordinary numbers.
  test("leaves ordinary integers as numbers", async () => {
    provider = await connectWithBigIds();

    expect((await provider.query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
    expect((await provider.query("SELECT COUNT(*) AS count FROM big")).rows).toEqual([{ count: 2 }]);
    expect((await provider.query("SELECT -7 AS negative, 1.5 AS fraction, 'x' AS word, NULL AS nil")).rows).toEqual([
      { negative: -7, fraction: 1.5, word: "x", nil: null },
    ]);
    // The exact edges of the safe range stay numbers; one past them becomes digits.
    expect((await provider.query("SELECT 9007199254740991 AS max, -9007199254740991 AS min")).rows).toEqual([
      { max: 9007199254740991, min: -9007199254740991 },
    ]);
    expect((await provider.query("SELECT -9007199254740993 AS below")).rows).toEqual([{ below: "-9007199254740993" }]);
  });

  test("leaves PRAGMA columns unchanged", async () => {
    provider = await connectWithBigIds();

    expect((await provider.query("PRAGMA journal_mode")).rows).toEqual([{ journal_mode: "memory" }]);
    expect((await provider.query("PRAGMA foreign_keys")).rows).toEqual([{ foreign_keys: 1 }]);
    const tableInfo = (await provider.query('PRAGMA table_info("big")')).rows as Record<string, unknown>[];
    expect(tableInfo.map((column) => column.cid)).toEqual([0, 1]);
    expect(tableInfo[0].pk).toBe(1);
  });

  // The agent read-only profile prepares its own statements and refuses an in-memory
  // target, so it gets a file of its own rather than the shared :memory: handle.
  test("reads the same digits back on the agent read-only path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "libredb-sqlite-bigint-"));
    const dbPath = join(dir, "big.db");
    const writer = new SQLiteProvider(makeSQLiteConfig({ database: dbPath }));
    await writer.connect();
    await writer.query("CREATE TABLE big (id INTEGER PRIMARY KEY, label TEXT)");
    await writer.query(`INSERT INTO big (id, label) VALUES (${TWO_53_PLUS_1}, 'target')`);
    await writer.disconnect();

    const agent = new SQLiteProvider(makeSQLiteConfig({ database: dbPath }), {}, { readOnly: true });
    try {
      await agent.connect();
      const rows = (
        await agent.queryReadOnly("SELECT id, label FROM big", {
          statementTimeoutMs: 5_000,
          maxResultRows: 100,
          maxResultBytes: 64 * 1024,
        })
      ).rows as Record<string, unknown>[];
      expect(String(rows[0].id)).toBe(TWO_53_PLUS_1);
      expect(() => JSON.stringify(rows)).not.toThrow();
    } finally {
      await agent.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Every other way a row can leave the provider. They all compile through the same
  // `prepare()` seam, and this pins that rather than trusting it.
  test("covers the parameterized, transaction, schema and stats paths alike", async () => {
    provider = await connectWithBigIds();

    // Parameterized statement, with the big id bound as the digits it was read as.
    const bound = (await provider.query("SELECT label FROM big WHERE id = ?", [TWO_53_PLUS_1])).rows;
    expect(bound).toEqual([{ label: "target" }]);

    // Inside an open transaction.
    await provider.query("BEGIN");
    const inTx = (await provider.query("SELECT id FROM big ORDER BY id DESC LIMIT 1")).rows as Record<
      string,
      unknown
    >[];
    expect(String(inTx[0].id)).toBe(TWO_53_PLUS_1);
    await provider.endOpenQueryTransaction();

    // Schema reads (PRAGMA-backed) and the statistics reads still answer in numbers.
    const detail = await provider.describeObject(["big"], "table");
    expect(detail.columns.map((column) => column.name)).toEqual(["id", "label"]);
    expect(detail.columns[0].isPrimary).toBe(true);
    const stats = await provider.getTableStats();
    expect(stats.find((table) => table.tableName === "big")!.rowCount).toBe(2);
    const overview = await provider.getOverview();
    expect(overview.tableCount).toBe(1);
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
    rmSync(tmpDir, { recursive: true });
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
    // `build.error` first: on a timeout spawnSync returns status null with error set, and
    // `status !== 0` is true for null, so checking status alone raises "bun build failed:" with an
    // empty stderr, a message that names nothing. Under a concurrent runner a timeout is the
    // likely failure, so it has to say so.
    if (build.error) {
      throw new Error(`bun build could not run: ${build.error.message}`);
    }
    if (build.status !== 0) {
      throw new Error(`bun build failed: ${build.stderr?.toString()}`);
    }

    // Run it under real Node with the node driver forced.
    const run = spawnSync("node", [bundlePath, dbPath], {
      env: { ...process.env, LIBREDB_SQLITE_DRIVER: "node" },
      timeout: 60_000,
    });
    if (run.error) {
      throw new Error(`node harness could not run: ${run.error.message}`);
    }
    if (run.status !== 0) {
      throw new Error(`node harness failed: ${run.stderr?.toString()}`);
    }

    const report = JSON.parse(run.stdout.toString()) as Record<string, unknown>;

    // Runtime and connection lifecycle
    expect(report.runtime).toBe("node");
    expect(report.driverEnv).toBe("node");
    expect(report.connected).toBe(true);
    expect(report.disconnected).toBe(true);
    // And the disconnect released the file, as the bun adapter's does: no WAL sidecar
    // survived it. See "disconnect releases the file rather than scheduling it" above.
    expect(report.sidecarsAfterDisconnect).toEqual([]);
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

    // 64-bit ids (#39): the same answer the bun driver gives in-process above.
    // Before the fix this run did not reach here at all - node:sqlite threw
    // ERR_OUT_OF_RANGE on the first read of 9007199254740993.
    expect(report.bigIds).toEqual(["9007199254740992", "9007199254740993"]);
    expect(report.bigIdTypes).toEqual(["string", "string"]);
    expect(report.bigRowsAfterUpdate).toEqual([
      { id: "9007199254740992", label: "neighbour" },
      { id: "9007199254740993", label: "edited" },
    ]);
    expect(report.bigSmallInteger).toEqual([{ one: 1 }]);
    expect(report.bigCount).toEqual([{ count: 2 }]);

    // #42: on a column with NO affinity the same id used to match nothing at all, so the
    // row was uneditable. One row changes, and it is the one that was read.
    for (const key of ["none", "blob"]) {
      expect((report.noAffinityRoundTrip as Record<string, unknown>)[key]).toEqual({
        read: ["9007199254740992", "9007199254740993"],
        rowCount: 1,
        after: [
          { id: "9007199254740992", label: "neighbour" },
          { id: "9007199254740993", label: "edited" },
        ],
      });
    }
    // and a genuinely textual all-digit key is untouched by that, leading zero included
    expect(report.textKeyKinds).toEqual([
      { id: "007", kind: "text" },
      { id: "9007199254740993", kind: "text" },
    ]);
    expect(report.textKeyMatches).toEqual([1, 1]);

    // Schema introspection
    const schema = report.schema as Array<{
      name: string;
      columns: Array<{ name: string; isPrimary: boolean; nullable: boolean }>;
      indexes: string[];
      foreignKeys: Array<{ columnName: string; referencedTable: string; referencedColumn: string }>;
    }>;
    const users = schema.find((t) => t.name === "users")!;
    expect(users).toBeDefined();
    // No row count here, and that is SQLite`s own answer rather than a gap in the harness:
    // the object listing publishes none, because there is no catalog estimate on this
    // engine and a COUNT(*) per object would be a full table scan per row of the tree.
    // The counted figure has its own read, asserted below through `getTableStats`.
    expect(users.columns.find((c) => c.name === "id")!.isPrimary).toBe(true);
    expect(users.columns.find((c) => c.name === "name")!.nullable).toBe(false);
    expect(users.indexes).toContain("idx_users_email");
    const books = schema.find((t) => t.name === "books")!;
    expect(books.foreignKeys).toEqual([{ columnName: "user_id", referencedTable: "users", referencedColumn: "id" }]);

    // Per-table sizes: node:sqlite is compiled WITH the dbstat virtual table
    // (SQLITE_ENABLE_DBSTAT_VTAB), so the size here is measured page bytes rather
    // than the `rowCount * 100` guess this driver also used to answer.
    // Everything dbstat reports is a whole number of pages, so a page-aligned
    // figure is what separates a measurement from the old estimate (100 bytes for
    // the harness's one-row `users` table).
    const tableStats = report.tableStats as Array<{
      tableName: string;
      rowCount: number;
      tableSizeBytes: number | null;
      indexSizeBytes: number | null;
      totalSizeBytes: number;
      totalSize: string;
    }>;
    const usersStats = tableStats.find((t) => t.tableName === "users")!;
    expect(usersStats.tableSizeBytes).toBeGreaterThan(0);
    expect(usersStats.tableSizeBytes! % 4096).toBe(0);
    expect(usersStats.tableSizeBytes).not.toBe(100);
    // `users` carries idx_users_email, so its index bytes are measured too and the
    // total is the sum - which is what the Storage tab's Indexes card adds up.
    expect(usersStats.indexSizeBytes).toBeGreaterThan(0);
    expect(usersStats.totalSizeBytes).toBe(usersStats.tableSizeBytes! + usersStats.indexSizeBytes!);
    expect(usersStats.totalSize).not.toBe("N/A");
    // `books` has no index at all: 0 index bytes is a measurement here, not an absence.
    const booksStats = tableStats.find((t) => t.tableName === "books")!;
    expect(booksStats.indexSizeBytes).toBe(0);
    expect(booksStats.totalSizeBytes).toBe(booksStats.tableSizeBytes!);

    // Maintenance + monitoring
    expect(report.maintenanceCheck).toEqual({ success: true, message: "ok" });
    expect(report.vacuumSuccess).toBe(true);
    expect(report.version).toContain("SQLite");
    expect(report.tableCount).toBe(2);
    expect(report.integrity).toContain("OK");

    // Error mapping (same mapDatabaseError path as the bun driver)
    expect(report.queryErrorName).toBe("DatabaseError");
    expect(report.queryErrorMessage).toContain("no such table");

    // ------------------------------------------------------------------
    // The object surface (#789) on the node:sqlite adapter.
    //
    // node:sqlite is a DIFFERENT SQLite build behind the same adapter, and this surface
    // needs `PRAGMA table_list` (3.37+) and a bound schema argument on the pragma
    // table-valued functions. Neither is provable from the bun run: measured here,
    // node:sqlite is 3.51.2 where bun:sqlite is 3.53.2.
    // ------------------------------------------------------------------
    expect(report.objectContainers).toEqual([]);
    // `users`, `books` and the FTS5-free fixture's two tables, plus the view and the
    // trigger this section adds. The TEMP `users` created beside them is excluded, which
    // is the schema restriction working on this driver too.
    expect(report.objectCounts).toEqual({
      table: { count: 2 },
      view: { count: 1 },
      index: { count: 1 },
      trigger: { count: 1 },
    });
    expect(report.objectList_table).toEqual([
      { path: ["books"], name: "books", kind: "table" },
      { path: ["users"], name: "users", kind: "table" },
    ]);
    expect(report.objectList_view).toEqual([{ path: ["user_names"], name: "user_names", kind: "view" }]);
    expect(report.objectList_index).toEqual([{ path: ["idx_users_email"], name: "idx_users_email", kind: "index" }]);
    expect(report.objectList_trigger).toEqual([
      { path: ["users", "users_stamp"], name: "users_stamp", kind: "trigger" },
    ]);
    // The file's `users`, not the one-column TEMP table shadowing it: the schema is bound
    // into `pragma_table_xinfo` on this adapter as well.
    expect(report.objectDetail).toEqual({
      path: ["users"],
      columns: [
        { name: "id", isPrimary: true },
        { name: "name", isPrimary: false },
        { name: "email", isPrimary: false },
      ],
      indexes: [{ name: "idx_users_email", columns: ["email"] }],
    });
    expect(report.objectDetailTrigger).toEqual({
      path: ["users", "users_stamp"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    expect(report.objectMissingRefused).toBe(true);
    expect(report.objectBadContainerRefused).toBe(true);

    // ------------------------------------------------------------------
    // Agent read-only execution profile (#328) on the node:sqlite adapter.
    // These fail on an adapter that accepts the read-only open flag and
    // ignores it: the write would land and the file would be created.
    // ------------------------------------------------------------------
    expect(report.agentConnected).toBe(true);
    expect(report.agentQueryOnly).toEqual([{ query_only: 1 }]);
    expect(report.agentSelectRows).toEqual([{ id: 1, name: "Alice" }]);
    expect(report.agentMultiStatementRows).toEqual([{ id: 1 }]);
    expect(report.agentWriteRejected).toBe(true);
    expect(report.agentSchemaChangeRejected).toBe(true);
    // query_only is re-asserted per statement, and VACUUM INTO — the one route
    // a read-only open does not cover — leaks nothing.
    expect(report.agentQueryOnlyAfterDisable).toEqual([{ query_only: 1 }]);
    expect(report.agentWriteRejectedAfterDisable).toBe(true);
    expect(report.agentVacuumIntoRejected).toBe(true);
    expect(report.agentStolenBytes).toBe(0);
    expect(report.agentRowsAfterRejectedWrites).toEqual([{ id: 1, name: "Alice" }]);
    expect(report.agentTablesAfterRejectedWrites).toEqual([{ name: "books" }, { name: "users" }]);
    expect(report.agentMissingOpenRejected).toBe(true);
    expect(report.agentMissingFileCreated).toBe(false);
    expect(report.agentMissingDirOpenRejected).toBe(true);
    expect(report.agentMissingDirCreated).toBe(false);
  });
});

// ============================================================================
// Independent verification of #39 (added by the verifying pass)
//
// Three questions the fix's own tests do not answer, measured through the real
// provider on whichever driver this file's default resolves to:
//
// 1. WHICH shapes changed. The driver flag is all-or-nothing, so every narrow
//    integer in the product crosses the same conversion. The table below is the
//    measured before/after for each one: nothing narrow may have become a string.
// 2. What an AGGREGATE over 64-bit values answers now, and what json_extract does.
//    Before the fix bun:sqlite answered SUM(id) as 18014398509481984 - one short of
//    the truth and indistinguishable from it.
// 3. The residual: a string id read out only finds its row again when the column
//    it is compared against has INTEGER (or NUMERIC/REAL) affinity. SQLite applies
//    no conversion for a BLOB/NONE-affinity column, so there the round trip fails.
// ============================================================================

describe("64-bit integers past 2^53, independently verified", () => {
  let provider: SQLiteProvider;
  const originalDriverEnv = process.env.LIBREDB_SQLITE_DRIVER;

  afterEach(async () => {
    if (originalDriverEnv === undefined) {
      delete process.env.LIBREDB_SQLITE_DRIVER;
    } else {
      process.env.LIBREDB_SQLITE_DRIVER = originalDriverEnv;
    }
    try {
      if (provider?.isConnected()) {
        await provider.disconnect();
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  async function connect(setup: readonly string[] = []): Promise<SQLiteProvider> {
    // Run on this file's default driver rather than whatever a sibling describe left
    // behind, so the shapes below are the ones the Docker image actually produces.
    delete process.env.LIBREDB_SQLITE_DRIVER;
    const db = new SQLiteProvider(makeSQLiteConfig());
    await db.connect();
    for (const statement of setup) {
      await db.query(statement);
    }
    return db;
  }

  const SMALL_TABLE = [
    "CREATE TABLE small (id INTEGER PRIMARY KEY, g TEXT, v INTEGER, r REAL)",
    "INSERT INTO small (g, v, r) VALUES ('a', 1, 1.5), ('a', 2, 2.5), ('b', 3, 3.5)",
  ];

  /**
   * Every narrow shape the all-or-nothing driver flag passes through, with the type
   * measured on the unfixed build for comparison. All nine were `number` before the
   * fix on bun:sqlite (and on node:sqlite, which only threw past the safe range), and
   * all nine must still be `number` after it.
   */
  test.each([
    ["SELECT 1", "SELECT 1 AS x", "number", 1],
    ["COUNT(*)", "SELECT COUNT(*) AS x FROM small", "number", 3],
    ["SUM() over small values", "SELECT SUM(v) AS x FROM small", "number", 6],
    ["AVG()", "SELECT AVG(v) AS x FROM small", "number", 2],
    ["INTEGER PRIMARY KEY", "SELECT id AS x FROM small ORDER BY id LIMIT 1", "number", 1],
    ["rowid", "SELECT rowid AS x FROM small ORDER BY rowid LIMIT 1", "number", 1],
    ["length()", "SELECT length('abcd') AS x", "number", 4],
    ["a REAL column", "SELECT r AS x FROM small ORDER BY id LIMIT 1", "number", 1.5],
    ["CAST to INTEGER", "SELECT CAST('42' AS INTEGER) AS x", "number", 42],
    ["GROUP BY count", "SELECT COUNT(*) AS x FROM small GROUP BY g ORDER BY g LIMIT 1", "number", 2],
    ["julianday()", "SELECT julianday('2020-01-01') AS x", "number", 2458849.5],
    // TEXT before and after — strftime has always answered text, typeof always a name.
    ["strftime('%s')", "SELECT strftime('%s', '2020-01-01') AS x", "string", "1577836800"],
    ["typeof()", "SELECT typeof(9007199254740993) AS x", "string", "integer"],
  ] as const)("%s keeps its shape", async (_label, sql, expectedType, expectedValue) => {
    provider = await connect(SMALL_TABLE);

    const value = ((await provider.query(sql)).rows[0] as Record<string, unknown>).x;

    expect(typeof value).toBe(expectedType);
    expect(value).toEqual(expectedValue);
  });

  // last_insert_rowid() answers whatever was last written, so it is narrow or wide by
  // the same rule as any other integer — asserted both ways rather than once.
  test("last_insert_rowid() is a number for a small rowid and digits for a 64-bit one", async () => {
    provider = await connect(["CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)"]);

    await provider.query("INSERT INTO t (id, label) VALUES (7, 'small')");
    expect((await provider.query("SELECT last_insert_rowid() AS x")).rows).toEqual([{ x: 7 }]);

    await provider.query("INSERT INTO t (id, label) VALUES (9007199254740993, 'wide')");
    expect((await provider.query("SELECT last_insert_rowid() AS x")).rows).toEqual([{ x: "9007199254740993" }]);
  });

  // The aggregate is the case that was wrong without ever looking wrong: bun:sqlite
  // answered SUM(id) as 18014398509481984 where the truth is ...985.
  test("an aggregate over 64-bit values answers every digit", async () => {
    provider = await connect([
      "CREATE TABLE big (id INTEGER PRIMARY KEY, doc TEXT)",
      "INSERT INTO big VALUES (9007199254740992, '{\"k\":9007199254740993}')",
      "INSERT INTO big VALUES (9007199254740993, '{\"k\":7}')",
    ]);

    expect((await provider.query("SELECT SUM(id) AS x FROM big")).rows).toEqual([{ x: "18014398509481985" }]);
    expect((await provider.query("SELECT MAX(id) AS x FROM big")).rows).toEqual([{ x: "9007199254740993" }]);
    expect((await provider.query("SELECT MIN(id) AS x FROM big")).rows).toEqual([{ x: "9007199254740992" }]);
    // A 64-bit integer inside JSON comes out of json_extract on the same rule.
    expect((await provider.query("SELECT json_extract(doc, '$.k') AS x FROM big ORDER BY id LIMIT 1")).rows).toEqual([
      { x: "9007199254740993" },
    ]);
    // and a narrow one inside the same column is still a number
    expect(
      (await provider.query("SELECT json_extract(doc, '$.k') AS x FROM big ORDER BY id DESC LIMIT 1")).rows,
    ).toEqual([{ x: 7 }]);
    // INT64's own limits survive the trip.
    expect((await provider.query("SELECT 9223372036854775807 AS hi, -9223372036854775807 - 1 AS lo")).rows).toEqual([
      { hi: "9223372036854775807", lo: "-9223372036854775808" },
    ]);
  });

  /**
   * The other half of the round trip (#42).
   *
   * SQLite settles `column = ?` by the COLUMN's affinity, and a column declared BLOB or
   * declared NOTHING has none: it compares a text to an integer as they stand, they are
   * never equal, and the id the grid just read could not find its own row again. The
   * UPDATE reported 0 rows changed and the user was told nothing happened - better than
   * the original defect, which wrote to the NEIGHBOUR, but still an uneditable row.
   *
   * The driver seam now reads the digits it printed back as the 64-bit integer they came
   * from (`toSQLiteBindValue`), so the comparison is integer to integer and the row is
   * found on every affinity.
   */
  test.each([
    ["no declared type (NONE affinity)", "CREATE TABLE k (id, label TEXT)"],
    ["a BLOB-affinity column", "CREATE TABLE k (id BLOB, label TEXT)"],
  ] as const)("a 64-bit id read from %s finds its own row again when sent back", async (_label, ddl) => {
    provider = await connect([
      ddl,
      "INSERT INTO k VALUES (9007199254740992, 'neighbour')",
      "INSERT INTO k VALUES (9007199254740993, 'target')",
    ]);

    const rows = (await provider.query("SELECT id, label FROM k ORDER BY id")).rows as Record<string, unknown>[];
    // The read is right: both ids come back whole and apart.
    expect(rows.map((row) => row.id)).toEqual(["9007199254740992", "9007199254740993"]);

    const target = rows.find((row) => row.label === "target")!;
    const update = await provider.query("UPDATE k SET label = 'edited' WHERE id = ?", [target.id]);

    // Exactly one row, and it is the one that was read.
    expect(update.rowCount).toBe(1);
    expect((await provider.query("SELECT label FROM k WHERE id = ?", [target.id])).rows).toEqual([{ label: "edited" }]);
    expect((await provider.query("SELECT id, label FROM k ORDER BY id")).rows).toEqual([
      { id: "9007199254740992", label: "neighbour" },
      { id: "9007199254740993", label: "edited" },
    ]);
  });

  /**
   * Which strings the bind reads as a 64-bit integer, and which it leaves as text.
   *
   * The set is exactly what the READ can print for an out-of-range integer, so the two
   * directions are inverses. Everything else is somebody's text and stays text -
   * asserted here through `typeof(?)`, which is the one thing SQLite answers differently
   * for the two storage classes.
   */
  test.each([
    ["past 2^53, the shape the read prints", "9007199254740993", "integer"],
    ["past 2^53 and negative", "-9007199254740993", "integer"],
    ["INT64's own maximum", "9223372036854775807", "integer"],
    ["INT64's own minimum", "-9223372036854775808", "integer"],
    ["one past INT64, which no row can hold", "9223372036854775808", "text"],
    ["far wider than 64 bits", "99999999999999999999999", "text"],
    ["inside the safe range, where the read prints a number", "9007199254740991", "text"],
    ["a small integer's digits", "7", "text"],
    ["leading zeros", "0009007199254740993", "text"],
    ["a single leading zero", "007", "text"],
    ["a leading plus", "+9007199254740993", "text"],
    ["a leading minus with a zero", "-0009007199254740993", "text"],
    ["surrounding space", " 9007199254740993 ", "text"],
    ["a decimal point", "9007199254740993.0", "text"],
    ["exponent notation", "9.007199254740993e15", "text"],
    ["the empty string", "", "text"],
    ["digits with a tail", "9007199254740993x", "text"],
  ] as const)("binds %s as %s", async (_label, value, expected) => {
    provider = await connect(["CREATE TABLE k (id, label TEXT)"]);
    expect((await provider.query("SELECT typeof(?) AS kind", [value])).rows).toEqual([{ kind: expected }]);
  });

  /**
   * A genuinely textual key is still matched as text.
   *
   * On a TEXT-declared column this is unconditional and covers the whole shape: SQLite
   * applies the column's TEXT affinity to the bind, so the integer is turned back into
   * the same digits before the comparison. A leading zero is carried along because it is
   * the case that would break if the conversion were written as "digits mean a number".
   */
  test("a genuinely textual all-digit key still stores and matches as text", async () => {
    provider = await connect([
      "CREATE TABLE t (id TEXT PRIMARY KEY, label TEXT)",
      "INSERT INTO t VALUES ('9007199254740993', 'wide')",
      "INSERT INTO t VALUES ('0009007199254740993', 'padded')",
      "INSERT INTO t VALUES ('007', 'bond')",
    ]);

    // Stored as text, every one of them, including the one the bind would read as a number.
    expect((await provider.query("SELECT id, typeof(id) AS kind FROM t ORDER BY label")).rows).toEqual([
      { id: "007", kind: "text" },
      { id: "0009007199254740993", kind: "text" },
      { id: "9007199254740993", kind: "text" },
    ]);

    const stillMatchesAsText = async (id: string, label: string): Promise<void> => {
      expect((await provider.query("SELECT label FROM t WHERE id = ?", [id])).rows).toEqual([{ label }]);
      const update = await provider.query("UPDATE t SET label = ? WHERE id = ?", [`${label}-edited`, id]);
      expect(update.rowCount).toBe(1);
    };
    await stillMatchesAsText("9007199254740993", "wide");
    await stillMatchesAsText("0009007199254740993", "padded");
    await stillMatchesAsText("007", "bond");
    // And a value written through a bind is still the text that was written.
    await provider.query("INSERT INTO t VALUES (?, 'written')", ["9007199254740994"]);
    expect((await provider.query("SELECT typeof(id) AS kind FROM t WHERE label = 'written'")).rows).toEqual([
      { kind: "text" },
    ]);
  });

  /**
   * The mistake the first half of this fix made, in the other direction: the bind creates
   * a BigInt, and a BigInt that reached a row would break `JSON.stringify` and with it the
   * whole connection. It exists only between this seam and the driver call, so everything
   * that comes back is swept for one.
   */
  test("a converted bind never comes back as a BigInt", async () => {
    provider = await connect(["CREATE TABLE k (id, label TEXT)", "INSERT INTO k VALUES (9007199254740993, 'target')"]);

    const answers: unknown[] = [
      (await provider.query("SELECT ? AS echo", ["9007199254740993"])).rows,
      (await provider.query("SELECT id, label FROM k WHERE id = ?", ["9007199254740993"])).rows,
      await provider.query("UPDATE k SET label = ? WHERE id = ?", ["9007199254740994", "9007199254740993"]),
      (await provider.query("SELECT id, label, typeof(label) AS kind FROM k")).rows,
    ];

    const found: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === "bigint") return void found.push(`${path} = ${value}`);
      if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) walk(child, `${path}.${key}`);
    };
    answers.forEach((answer, index) => walk(answer, `answer[${index}]`));

    expect(found).toEqual([]);
    expect(() => JSON.stringify(answers)).not.toThrow();
    // The echo comes back as the digits it went in as, which is the round trip itself.
    expect(answers[0]).toEqual([{ echo: "9007199254740993" }]);
    // and a converted value WRITTEN into a TEXT-affinity column is still text
    expect(answers[3]).toEqual([{ id: "9007199254740993", label: "9007199254740994", kind: "text" }]);
  });

  /**
   * The residual, written down rather than left to be discovered.
   *
   * A column with NO affinity that genuinely stores these digits as TEXT is the one case
   * the seam cannot serve, and it is the SAME ambiguity read from the other end: the read
   * prints the integer 9007199254740993 and the text '9007199254740993' as one identical
   * JavaScript string, so the bind has to pick, and it picks the integer those digits
   * exist for. Reaching it takes a quoted SQL literal - a value written through a bind is
   * stored as an integer here, so what this provider writes it can always read back.
   */
  test("a no-affinity column holding these digits as TEXT is the case the seam cannot serve", async () => {
    provider = await connect([
      "CREATE TABLE k (id, label TEXT)",
      "INSERT INTO k VALUES ('9007199254740993', 'quoted-literal')",
    ]);

    expect((await provider.query("SELECT typeof(id) AS kind FROM k")).rows).toEqual([{ kind: "text" }]);
    expect((await provider.query("UPDATE k SET label = 'edited' WHERE id = ?", ["9007199254740993"])).rowCount).toBe(0);
    // It is reachable by its text, which is what the column actually holds.
    expect((await provider.query("SELECT label FROM k WHERE CAST(id AS TEXT) = ?", ["9007199254740993"])).rows).toEqual(
      [{ label: "quoted-literal" }],
    );
    // And a bind WRITES an integer there, so the provider's own round trip stays closed.
    await provider.query("INSERT INTO k VALUES (?, 'through-a-bind')", ["9007199254740994"]);
    expect((await provider.query("SELECT typeof(id) AS kind FROM k WHERE label = 'through-a-bind'")).rows).toEqual([
      { kind: "integer" },
    ]);
    expect((await provider.query("UPDATE k SET label = 'edited' WHERE id = ?", ["9007199254740994"])).rowCount).toBe(1);
  });

  // The same id on an affinity that DOES convert, so the contrast is pinned rather than
  // asserted in prose.
  test.each([["INTEGER"], ["NUMERIC"]] as const)(
    "a 64-bit id round-trips on a %s-affinity column",
    async (declared) => {
      provider = await connect([
        `CREATE TABLE k (id ${declared}, label TEXT)`,
        "INSERT INTO k VALUES (9007199254740992, 'neighbour')",
        "INSERT INTO k VALUES (9007199254740993, 'target')",
      ]);

      const rows = (await provider.query("SELECT id, label FROM k ORDER BY id")).rows as Record<string, unknown>[];
      const target = rows.find((row) => row.label === "target")!;
      const update = await provider.query("UPDATE k SET label = 'edited' WHERE id = ?", [target.id]);

      expect(update.rowCount).toBe(1);
      expect((await provider.query("SELECT id, label FROM k ORDER BY id")).rows).toEqual([
        { id: "9007199254740992", label: "neighbour" },
        { id: "9007199254740993", label: "edited" },
      ]);
    },
  );

  /**
   * A REAL-affinity column is lossy in SQLite ITSELF, before any driver sees it: the
   * engine stores an INTEGER there as a double, so 9007199254740993 and its neighbour
   * become the same value in the FILE. The provider then reads one number twice and an
   * edit keyed on it hits BOTH rows. Nothing at the driver seam can recover this, and it
   * is pinned here so the limit is written down rather than discovered later.
   */
  test("a REAL-affinity column collapses two 64-bit ids in the file, before the driver", async () => {
    provider = await connect([
      "CREATE TABLE k (id REAL, label TEXT)",
      "INSERT INTO k VALUES (9007199254740992, 'neighbour')",
      "INSERT INTO k VALUES (9007199254740993, 'target')",
    ]);

    const rows = (await provider.query("SELECT id, typeof(id) AS kind FROM k ORDER BY rowid")).rows as Record<
      string,
      unknown
    >[];
    expect(rows.map((row) => row.kind)).toEqual(["real", "real"]);
    expect(rows[0].id).toEqual(rows[1].id);

    const update = await provider.query("UPDATE k SET label = 'edited' WHERE id = ?", [rows[1].id]);
    expect(update.rowCount).toBe(2);
  });

  /**
   * The coverage claim, checked rather than argued: every public surface that can hand
   * a row or a scalar back, driven over a database that holds INT64's own maximum, and
   * swept for a BigInt at any depth. A BigInt reaching any of these is a connection the
   * browser cannot serialize at all.
   */
  test("no public read path leaks a BigInt when the database holds a 64-bit value", async () => {
    delete process.env.LIBREDB_SQLITE_DRIVER;
    const dir = mkdtempSync(join(tmpdir(), "libredb-sqlite-bigint-sweep-"));
    const db = new SQLiteProvider(makeSQLiteConfig({ database: join(dir, "sweep.db") }));
    try {
      await db.connect();
      await db.query("CREATE TABLE big (id INTEGER PRIMARY KEY, n INTEGER DEFAULT 9223372036854775807)");
      await db.query("INSERT INTO big (id, n) VALUES (9007199254740993, 9223372036854775807)");
      await db.query("CREATE INDEX idx_big_n ON big(n)");
      await db.query("CREATE VIEW v_big AS SELECT id, n FROM big");

      const answers: unknown[] = [
        (await db.query("SELECT * FROM big")).rows,
        (await db.query('PRAGMA table_info("big")')).rows,
        (await db.query('PRAGMA index_list("big")')).rows,
        (await db.query("PRAGMA page_count")).rows,
        (await db.query("EXPLAIN QUERY PLAN SELECT * FROM big WHERE n = 1")).rows,
        await db.listContainers(),
        await db.countObjects([]),
        await db.listObjects([], "table"),
        await db.listObjects([], "index"),
        await db.describeObject(["big"], "table"),
        await db.describeObjects([], "table"),
        await db.readObjectSource(["v_big"], "view"),
        await db.getHealth(),
        await db.getOverview(),
        await db.getPerformanceMetrics(),
        await db.getSlowQueries(),
        await db.getActiveSessions(),
        await db.getTableStats(),
        await db.getIndexStats(),
        await db.getStorageStats(),
        await db.runMaintenance("analyze"),
      ];

      const bigints: string[] = [];
      const seen = new Set<unknown>();
      const walk = (value: unknown, path: string): void => {
        if (typeof value === "bigint") {
          bigints.push(`${path} = ${value}`);
          return;
        }
        if (value === null || typeof value !== "object" || ArrayBuffer.isView(value) || seen.has(value)) {
          return;
        }
        seen.add(value);
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          walk(child, `${path}.${key}`);
        }
      };
      answers.forEach((answer, index) => walk(answer, `answer[${index}]`));

      expect(bigints).toEqual([]);
      expect(() => JSON.stringify(answers)).not.toThrow();
      // and the 64-bit column DEFAULT still reaches the schema reader with every digit
      const detail = await db.describeObject(["big"], "table");
      expect(detail.columns.find((column) => column.name === "n")!.defaultValue).toBe("9223372036854775807");
      // a row count is a row count, not digits
      expect((await db.getTableStats()).find((table) => table.tableName === "big")!.rowCount).toBe(1);
    } finally {
      try {
        await db.disconnect();
      } catch {
        // Ignore cleanup errors
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
