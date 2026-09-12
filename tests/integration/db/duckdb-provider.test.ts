/**
 * Integration tests for DuckDBProvider (issue #424).
 *
 * Against a REAL embedded DuckDB - `:memory:` and a temp file on disk - through the
 * real `@duckdb/node-api` driver. Nothing here is mocked: the whole point of an
 * embedded engine is that the engine is available in the test process, so a mock would
 * only prove that the mock agrees with itself.
 *
 * **Gate 4 pin: DuckDB v1.5.5 via @duckdb/node-api 1.5.5-r.4, measured 2026-08-27 on
 * Bun 1.3.14 and Node 24.14.0.** Every behaviour asserted below was probed live at
 * that version and recorded in `.duckdb-measured.md`; the version assertion in
 * "engine version" fails loudly if the pinned driver moves underneath these
 * expectations.
 *
 * The read-only section is the one that carries real weight. `access_mode: 'READ_ONLY'`
 * refuses writes to the attached database and does NOT refuse `COPY ... TO`,
 * `EXPORT DATABASE`, `INSTALL`, `LOAD` or `read_text('/etc/hostname')` - all measured
 * escaping a genuinely read-only handle - so each refusal below is asserted by checking
 * that NO FILE APPEARED ON DISK, not merely that an error was thrown.
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBProvider, assertReadOnlyStatementIsBounded } from "@/lib/db/providers/sql/duckdb";
import type { DatabaseConnection } from "@/lib/types";
import type { ProviderCapabilities, ReadOnlyStatementBudget } from "@/lib/db/types";
import {
  FUNCTION_TYPE_RULES,
  OBJECT_COLUMNS_SQL,
  applyKindCounts,
  bulkTargetSql,
  comparePaths,
  countsSql,
  listObjectsSql,
  seedZeroCounts,
} from "@/lib/db/providers/sql/duckdb/objects";
import { ConnectionError, DatabaseConfigError, ExecutionProfileError, QueryError } from "@/lib/db/errors";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";

// ============================================================================
// Helpers
// ============================================================================

const PINNED_VERSION = "v1.5.5";

/**
 * The scratch directory every fixture in this file lives in, created HERE rather than in
 * `beforeAll` because `test.each` builds its table at module evaluation time and one of
 * those tables needs a real path (see `BARE_SCAN_CSV`).
 *
 * `mkdtempSync` and not a fixed name under `tmpdir()`: a predictable path in a
 * world-writable directory is the insecure-temporary-file shape, and CodeQL flags it
 * (`js/insecure-temporary-file`) even in a test. `mkdtempSync` answers a random name at
 * mode 0700, so nothing can pre-create or symlink what these tests are about to write -
 * which matters more here than in most tests, because several of them assert that a file
 * did NOT appear.
 */
const workDir = mkdtempSync(join(tmpdir(), "libredb-duckdb-test-"));

/**
 * A CSV outside every database, for the bare-path form: DuckDB's replacement scan turns
 * `FROM '<path>.csv'` into a `read_csv_auto`, so the statement carries no forbidden word
 * for a name denylist to find.
 */
const BARE_SCAN_CSV = join(workDir, "bare-scan.csv");

function makeConfig(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "test-duckdb",
    name: "Test DuckDB",
    type: "duckdb",
    database: ":memory:",
    createdAt: new Date(),
    ...overrides,
  };
}

const GENEROUS_BUDGET: ReadOnlyStatementBudget = {
  statementTimeoutMs: 30_000,
  maxResultRows: 1_000,
  maxResultBytes: 1_000_000,
};

/** A connected provider over `:memory:` holding the fixture below. */
async function seededMemoryProvider(): Promise<DuckDBProvider> {
  const provider = new DuckDBProvider(makeConfig());
  await provider.connect();
  await provider.query("CREATE SCHEMA analytics");
  await provider.query(
    "CREATE TABLE customers (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL, email VARCHAR, signed_up_at TIMESTAMP DEFAULT now())",
  );
  await provider.query(
    "CREATE TABLE orders (id BIGINT PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), total DECIMAL(12,2) NOT NULL)",
  );
  await provider.query("CREATE INDEX idx_orders_customer ON orders(customer_id)");
  await provider.query("CREATE VIEW customer_totals AS SELECT name, 0 AS revenue FROM customers");
  await provider.query("CREATE TABLE analytics.events (id BIGINT, tags VARCHAR[], props STRUCT(source VARCHAR))");
  await provider.query(
    "INSERT INTO customers (id, name, email) VALUES (1, 'Ada', 'ada@example.com'), (2, 'Grace', NULL)",
  );
  await provider.query("INSERT INTO orders VALUES (10, 1, 12.50), (11, 2, 99.00)");
  return provider;
}

/** A file-backed database with one checkpointed table, ready for a read-only handle. */
async function seededFile(name: string): Promise<string> {
  const dbPath = join(workDir, name);
  const writer = new DuckDBProvider(makeConfig({ database: dbPath }));
  await writer.connect();
  await writer.query("CREATE TABLE users (id INTEGER, secret VARCHAR)");
  await writer.query("INSERT INTO users VALUES (1, 'top'), (2, 'secret')");
  await writer.query("CHECKPOINT");
  await writer.disconnect();
  return dbPath;
}

beforeAll(() => {
  writeFileSync(BARE_SCAN_CSV, "a,b\n1,2\n");
});

afterAll(() => {
  // One removal, not two: the CSV lives inside the scratch directory now.
  rmSync(workDir, { recursive: true, force: true });
});

// ============================================================================
// Validation & metadata
// ============================================================================

describe("DuckDBProvider validation", () => {
  test("a config with no database path is refused", () => {
    expect(() => new DuckDBProvider(makeConfig({ database: undefined }))).toThrow(DatabaseConfigError);
  });

  test("the refusal names the field and the :memory: alternative", () => {
    expect(() => new DuckDBProvider(makeConfig({ database: "" }))).toThrow(/"database" field[\s\S]*:memory:/);
  });

  test(":memory: is a valid target", () => {
    expect(() => new DuckDBProvider(makeConfig())).not.toThrow();
  });
});

describe("DuckDBProvider capabilities", () => {
  const capabilities = new DuckDBProvider(makeConfig()).getCapabilities();

  test("declares an embedded engine with no port and no connection string", () => {
    expect(capabilities.defaultPort).toBeNull();
    expect(capabilities.supportsConnectionString).toBe(false);
  });

  test("declares singleWriterFile, because the file admits one operating-system process", () => {
    // Measured: a second PROCESS is refused even in read-only mode, so the three routes
    // that would open a second handle borrow this one instead (BACKLOG D3).
    expect(capabilities.singleWriterFile).toBe(true);
  });

  test("declares double-quote identifier quoting rather than relying on the null-port heuristic", () => {
    // `defaultPort: null` is shared with sqlite, and query-generators.ts derives the
    // dialect from the port unless the capability is declared.
    expect(capabilities.identifierQuoting).toBe("double");
  });

  test("offers only the three maintenance operations DuckDB accepted live", () => {
    // REINDEX is a Parser Error here; PRAGMA integrity_check and PRAGMA optimize are
    // both "Pragma Function with name ... does not exist!".
    expect(capabilities.maintenanceOperations).toEqual(["vacuum", "analyze", "optimize"]);
  });

  test("every offered operation carries a spec, so neither surface offers it in the wrong place", () => {
    // #U9: an operation declared without a spec is offered in BOTH placements.
    for (const operation of capabilities.maintenanceOperations) {
      expect(capabilities.maintenanceOperationSpecs?.[operation]).toBeDefined();
    }
    expect(capabilities.maintenanceOperationSpecs?.optimize).toEqual({
      label: "Checkpoint Database",
      perEntity: false,
      global: true,
    });
    expect(capabilities.maintenanceOperationSpecs?.vacuum?.perEntity).toBe(true);
  });

  test("holds no session for a transaction", () => {
    expect(capabilities.supportsTransactions).toBe(false);
  });
});

describe("DuckDBProvider labels", () => {
  const labels = new DuckDBProvider(makeConfig()).getLabels();

  test("the slow-query panel says why it is empty instead of naming a PostgreSQL extension", () => {
    // #U12: the default sentence tells the reader to install pg_stat_statements.
    expect(labels.slowQueriesEmptyState).toContain("duckdb_queries()");
    expect(labels.slowQueriesEmptyState).not.toContain("pg_stat_statements");
  });

  test("the sessions panel says the list can never have a row, not that none is running", () => {
    // #D48: the default "No active sessions found." reads as "nothing is running right
    // now", and duckdb_connections() does not exist, so no row can ever appear.
    expect(labels.sessionsEmptyState).toContain("duckdb_connections()");
  });

  test("the global vacuum wording says what VACUUM actually does on this engine", () => {
    expect(labels.vacuumGlobalDesc).toContain("checkpoint");
  });
});

// ============================================================================
// Connection lifecycle
// ============================================================================

describe("connect / disconnect", () => {
  let provider: DuckDBProvider;

  afterEach(async () => {
    if (provider?.isConnected()) await provider.disconnect();
  });

  test("connects to :memory:", async () => {
    provider = new DuckDBProvider(makeConfig());
    expect(provider.isConnected()).toBe(false);
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
  });

  test("double connect is idempotent", async () => {
    provider = new DuckDBProvider(makeConfig());
    await provider.connect();
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
  });

  test("disconnect closes the handle and a second disconnect is a no-op", async () => {
    provider = new DuckDBProvider(makeConfig());
    await provider.connect();
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
  });

  test("creates the parent directory of a file that does not exist yet", async () => {
    const dbPath = join(workDir, "nested", "deeper", "created.duckdb");
    provider = new DuckDBProvider(makeConfig({ database: dbPath }));

    await provider.connect();
    await provider.query("CREATE TABLE t (a INTEGER)");
    await provider.query("CHECKPOINT");

    expect(existsSync(dbPath)).toBe(true);
  });

  test("a relative path is resolved against the process directory, matching factory.ts's fileIdentity", async () => {
    // `findOpenSingleWriterProvider` keys off `path.resolve(connection.database)`, so a
    // provider that resolved differently would silently stop matching its own handle.
    const relative = `./${join("tests-tmp-duckdb", "relative.duckdb")}`;
    provider = new DuckDBProvider(makeConfig({ database: relative }));

    await provider.connect();
    await provider.query("CREATE TABLE t (a INTEGER)");
    await provider.query("CHECKPOINT");

    const [storage] = await provider.getStorageStats();
    expect(storage.location).toBe(join(process.cwd(), "tests-tmp-duckdb", "relative.duckdb"));

    await provider.disconnect();
    rmSync(join(process.cwd(), "tests-tmp-duckdb"), { recursive: true, force: true });
  });

  test("a path carrying a NUL byte is refused as a configuration error", async () => {
    provider = new DuckDBProvider(makeConfig({ database: "/tmp/bad\0path.duckdb" }));

    await expect(provider.connect()).rejects.toThrow(DatabaseConfigError);
    expect(provider.isConnected()).toBe(false);
  });

  test("two handles on the same file inside ONE process are both allowed", async () => {
    // This is the measurement that makes the agent's read-only handle possible: the
    // lock is per operating-system process, so a second in-process handle is fine.
    const dbPath = await seededFile("shared.duckdb");
    const first = new DuckDBProvider(makeConfig({ database: dbPath }));
    const second = new DuckDBProvider(makeConfig({ id: "second", database: dbPath }));

    await first.connect();
    await second.connect();

    expect((await second.query("SELECT count(*) AS n FROM users")).rows[0].n).toBe("2");

    await first.disconnect();
    await second.disconnect();
  });
});

// ============================================================================
// Query execution
// ============================================================================

describe("query()", () => {
  let provider: DuckDBProvider;

  afterEach(async () => {
    if (provider?.isConnected()) await provider.disconnect();
  });

  test("refuses to run before connect()", async () => {
    provider = new DuckDBProvider(makeConfig());

    await expect(provider.query("SELECT 1")).rejects.toThrow(DatabaseConfigError);
  });

  test("engine version is the pinned one these expectations were measured against", async () => {
    provider = new DuckDBProvider(makeConfig());
    await provider.connect();

    expect((await provider.query("SELECT version() AS v")).rows[0].v).toBe(PINNED_VERSION);
  });

  test("a SELECT carries rows, declared columns and declared types", async () => {
    provider = new DuckDBProvider(makeConfig());
    await provider.connect();

    const result = await provider.query("SELECT 42 AS a, 'x' AS b");

    expect(result.rows).toEqual([{ a: 42, b: "x" }]);
    expect(result.fields).toEqual(["a", "b"]);
    expect(result.rowCount).toBe(1);
    expect(result.columnTypes).toEqual({ a: "INTEGER", b: "VARCHAR" });
  });

  test("wide types arrive in the shapes getRowObjectsJson produces", async () => {
    // Pinned because they are the reason `getRowObjects()` is banned: it throws on
    // JSON.stringify ("Do not know how to serialize a BigInt").
    provider = new DuckDBProvider(makeConfig());
    await provider.connect();

    const result = await provider.query(
      "SELECT 9223372036854775807::HUGEINT AS big, [1,2,3] AS lst, {'x': 1} AS st, INTERVAL 1 DAY AS iv",
    );

    expect(result.rows[0]).toEqual({
      big: "9223372036854775807",
      lst: [1, 2, 3],
      st: { x: 1 },
      iv: { months: 0, days: 1, micros: "0" },
    });
  });

  test("an empty row set still declares its columns", async () => {
    provider = new DuckDBProvider(makeConfig());
    await provider.connect();
    await provider.query("CREATE TABLE t (id INTEGER, name VARCHAR)");

    const result = await provider.query("SELECT * FROM t WHERE 1 = 0");

    expect(result.rows).toEqual([]);
    expect(result.fields).toEqual(["id", "name"]);
    expect(result.columnTypes).toEqual({ id: "INTEGER", name: "VARCHAR" });
  });

  test("an INSERT reports the rows it changed and shows no Count grid", async () => {
    provider = new DuckDBProvider(makeConfig());
    await provider.connect();
    await provider.query("CREATE TABLE t (a INTEGER)");

    const result = await provider.query("INSERT INTO t VALUES (1), (2)");

    expect(result).toEqual({ rows: [], fields: [], rowCount: 2, executionTime: expect.any(Number) });
  });

  test.each([
    ["UPDATE t SET a = 9 WHERE a = 1", 1],
    ["DELETE FROM t WHERE a = 99", 0],
  ])("%s reports %i changed rows", async (sql, expected) => {
    provider = new DuckDBProvider(makeConfig());
    await provider.connect();
    await provider.query("CREATE TABLE t (a INTEGER)");
    await provider.query("INSERT INTO t VALUES (1), (2)");

    expect((await provider.query(sql)).rowCount).toBe(expected);
  });

  test("a SELECT the user aliased to Count is NOT mistaken for a write", async () => {
    provider = new DuckDBProvider(makeConfig());
    await provider.connect();

    const result = await provider.query("SELECT 41 AS Count");

    expect(result.rows).toEqual([{ Count: 41 }]);
    expect(result.fields).toEqual(["Count"]);
  });

  test("DuckDB's FROM-first syntax returns its rows, unlike a keyword-routed provider", async () => {
    // Bug #275 in a new dialect: `isReadOnlyQuery`'s keyword set has no FROM, so a
    // router-based provider would take the write branch and report zero rows.
    provider = new DuckDBProvider(makeConfig());
    await provider.connect();
    await provider.query("CREATE TABLE t (a INTEGER)");
    await provider.query("INSERT INTO t VALUES (1), (2)");

    expect((await provider.query("FROM t")).rowCount).toBe(2);
  });

  test.each([
    ["SUMMARIZE t", 1],
    ["CALL pragma_version()", 1],
  ])("%s returns rows too", async (sql, atLeast) => {
    provider = new DuckDBProvider(makeConfig());
    await provider.connect();
    await provider.query("CREATE TABLE t (a INTEGER)");
    await provider.query("INSERT INTO t VALUES (1)");

    expect((await provider.query(sql)).rowCount).toBeGreaterThanOrEqual(atLeast);
  });

  test("bound parameters go to the driver's bind path", async () => {
    provider = new DuckDBProvider(makeConfig());
    await provider.connect();

    const result = await provider.query("SELECT ?::INTEGER AS a, ?::VARCHAR AS b", [7, "x"]);

    expect(result.rows).toEqual([{ a: 7, b: "x" }]);
  });

  test("a syntax error is a QueryError carrying DuckDB's own sentence", async () => {
    provider = new DuckDBProvider(makeConfig());
    await provider.connect();

    await expect(provider.query("SELCT 1")).rejects.toThrow(QueryError);
    await expect(provider.query("SELCT 1")).rejects.toThrow(/Parser Error: syntax error/);
  });

  test("a missing table is a QueryError, not a connection failure", async () => {
    provider = new DuckDBProvider(makeConfig());
    await provider.connect();

    await expect(provider.query("SELECT * FROM nope")).rejects.toThrow(/Catalog Error: Table with name nope/);
  });
});

// ============================================================================
// Cancellation
// ============================================================================

describe("cancelQuery()", () => {
  let provider: DuckDBProvider;

  afterEach(async () => {
    if (provider?.isConnected()) await provider.disconnect();
  });

  test("a token this provider never started answers false", async () => {
    provider = new DuckDBProvider(makeConfig());
    await provider.connect();

    expect(await provider.cancelQuery("never-started")).toBe(false);
  });

  test("a token whose query already finished answers false", async () => {
    provider = new DuckDBProvider(makeConfig());
    await provider.connect();
    await provider.query("SELECT 1", undefined, "finished");

    expect(await provider.cancelQuery("finished")).toBe(false);
  });

  test("interrupts a running scan and leaves the connection usable", async () => {
    provider = new DuckDBProvider(makeConfig());
    await provider.connect();

    const running = provider.query("SELECT count(*) FROM range(100000000000) t(i)", undefined, "long");
    // The statement has to be in flight before the token is cancellable.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const cancelled = await provider.cancelQuery("long");

    expect(cancelled).toBe(true);
    await expect(running).rejects.toThrow(/cancelled/i);
    // Measured: the connection survives an interrupt.
    expect((await provider.query("SELECT 1 AS a")).rows).toEqual([{ a: 1 }]);
  }, 30_000);

  test("a disconnected provider answers false rather than throwing", async () => {
    provider = new DuckDBProvider(makeConfig());
    await provider.connect();
    await provider.disconnect();

    expect(await provider.cancelQuery("anything")).toBe(false);
  });
});

// ============================================================================
// Schema
// ============================================================================

// ============================================================================
// Monitoring
// ============================================================================

describe("monitoring", () => {
  let provider: DuckDBProvider;

  afterEach(async () => {
    if (provider?.isConnected()) await provider.disconnect();
  });

  test("the overview names the engine, counts the objects and publishes no connection ceiling", async () => {
    provider = await seededMemoryProvider();

    const overview = await provider.getOverview();

    expect(overview.version).toBe(`DuckDB ${PINNED_VERSION}`);
    expect(overview.uptime).toBe("N/A");
    expect(overview.activeConnections).toBe(1);
    // 0 means "no limit published", per DatabaseOverview.
    expect(overview.maxConnections).toBe(0);
    expect(overview.tableCount).toBe(3);
    expect(overview.indexCount).toBeGreaterThanOrEqual(1);
  });

  test("a file-backed overview carries a measured byte size", async () => {
    const dbPath = await seededFile("overview.duckdb");
    provider = new DuckDBProvider(makeConfig({ database: dbPath }));
    await provider.connect();

    const overview = await provider.getOverview();

    expect(overview.databaseSizeBytes).toBeGreaterThan(0);
    expect(overview.databaseSize).not.toBe("N/A");
  });

  test("health reports the size and says plainly it has no ratio, no queries and no sessions", async () => {
    provider = await seededMemoryProvider();

    const health = await provider.getHealth();

    expect(health.activeConnections).toBe(1);
    expect(health.cacheHitRatio).toBe(CACHE_HIT_RATIO_UNAVAILABLE);
    expect(health.slowQueries).toEqual([]);
    expect(health.activeSessions).toEqual([]);
  });

  test("the performance panel reports nothing rather than inventing a zero", async () => {
    // A fabricated 0 cacheHitRatio renders as a red critical fault, and `deadlocks: 0`
    // would be a reading nobody took - DuckDB has optimistic concurrency and no
    // deadlock counter.
    provider = await seededMemoryProvider();

    expect(await provider.getPerformanceMetrics()).toEqual({});
  });

  test("slow queries and active sessions are empty and never fabricated", async () => {
    provider = await seededMemoryProvider();

    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
  });

  test("an in-memory table publishes no bytes, so its size fields are absent", async () => {
    // Measured: every segment of a :memory: database answers persistent: false with a
    // NULL block_id, and block_size is 0. A 0 would read as an empty table.
    provider = await seededMemoryProvider();

    const customers = (await provider.getTableStats()).find((stats) => stats.tableName === "customers");

    expect(customers?.rowCount).toBe(2);
    expect(customers?.totalSize).toBe("N/A");
    expect(customers?.tableSizeBytes).toBeUndefined();
  });

  test("a checkpointed file table publishes its allocated block bytes", async () => {
    const dbPath = await seededFile("stats.duckdb");
    provider = new DuckDBProvider(makeConfig({ database: dbPath }));
    await provider.connect();

    const [users] = await provider.getTableStats();

    expect(users.tableName).toBe("users");
    // Block-granular by construction: the figure is distinct persistent blocks times
    // block_size, which is 256 KiB on this storage version.
    expect(users.tableSizeBytes).toBeGreaterThanOrEqual(262144);
    expect(users.totalSizeBytes).toBe(users.tableSizeBytes ?? 0);
  });

  test("index stats carry columns and no size or scan count DuckDB does not publish", async () => {
    provider = await seededMemoryProvider();

    const index = (await provider.getIndexStats()).find((stats) => stats.indexName === "idx_orders_customer");

    expect(index?.columns).toEqual(["customer_id"]);
    expect(index?.indexSize).toBe("N/A");
    expect(index?.indexSizeBytes).toBeUndefined();
    expect(index?.scans).toBe(0);
  });

  test("storage stats name the file on disk", async () => {
    const dbPath = await seededFile("storage.duckdb");
    provider = new DuckDBProvider(makeConfig({ database: dbPath }));
    await provider.connect();

    const [main] = await provider.getStorageStats();

    expect(main.name).toBe("Main Database");
    // Both sides through `realpathSync`, because the location is DUCKDB's answer and DuckDB
    // canonicalises it. A no-op wherever the temp directory is a real directory, which is why
    // this read as portable: on macOS `os.tmpdir()` is `/var/folders/...`, a symlink to
    // `/private/var/folders/...`, so the engine returns a path that names the same file by a
    // different route and a string comparison fails on a correct answer.
    expect(main.location).toBeDefined();
    expect(realpathSync(main.location!)).toBe(realpathSync(dbPath));
    expect(main.sizeBytes).toBeGreaterThan(0);
  });

  test("storage stats name an in-memory database as such", async () => {
    provider = await seededMemoryProvider();

    const [main] = await provider.getStorageStats();

    expect(main.location).toBe(":memory:");
  });

  test("getMonitoringData reads every panel and reports no errors", async () => {
    // Inherited from BaseDatabaseProvider, which reads the seven panels with
    // Promise.allSettled - this asserts none of them rejects on this engine.
    provider = await seededMemoryProvider();

    const data = await provider.getMonitoringData();

    expect(data.errors).toBeUndefined();
    expect(data.overview).toBeDefined();
    expect(data.tables).toBeDefined();
    expect(data.indexes).toBeDefined();
    expect(data.storage).toBeDefined();
  });
});

// ============================================================================
// Maintenance
// ============================================================================

describe("runMaintenance()", () => {
  let provider: DuckDBProvider;

  afterEach(async () => {
    if (provider?.isConnected()) await provider.disconnect();
  });

  test.each([
    ["vacuum", undefined],
    ["vacuum", "customers"],
    ["vacuum", "analytics.events"],
    ["analyze", undefined],
    ["analyze", "customers"],
    ["optimize", undefined],
  ] as const)("%s with target %p succeeds against a live database", async (type, target) => {
    provider = await seededMemoryProvider();

    const result = await provider.runMaintenance(type, target);

    expect(result.success).toBe(true);
    expect(result.message).toContain(type.toUpperCase());
  });

  test("a bare target is qualified into main rather than sent unqualified", async () => {
    // A wrongly qualified target is the #U9 shape: the control names one table and the
    // engine acts on something else, or refuses.
    provider = await seededMemoryProvider();

    await expect(provider.runMaintenance("analyze", "customers")).resolves.toMatchObject({ success: true });
  });

  /*
    The other side of that default, and the reason D49 exists.

    A caller that sends a BARE name for a table living outside `main` gets `main`, and the
    engine refuses because that table is not there. The refusal is the CORRECT behaviour for
    this provider - guessing which schema the caller meant would act on a table nobody named -
    so it is pinned here rather than repaired: the repair belongs to the caller.

    Measured in the browser on 2026-08-27: the Tables panel's per-row Analyze button sends
    `table.tableName` without the `table.schemaName` it renders beside it, so clicking it on the
    `analytics.events` row produced exactly this refusal. That is a shared-component defect
    reaching all twelve providers that implement `runMaintenance`, filed as D49.
  */
  test("a bare target naming a table outside main is refused, and the message names the real one", async () => {
    provider = await seededMemoryProvider();

    await expect(provider.runMaintenance("analyze", "events")).rejects.toThrow(/events/);
    // The qualified spelling is what works, which is what makes the refusal the caller's to fix.
    await expect(provider.runMaintenance("analyze", "analytics.events")).resolves.toMatchObject({ success: true });
  });

  test("optimize refuses a target rather than silently ignoring it", async () => {
    // It is CHECKPOINT, which takes no object at all - which is why its spec declares
    // perEntity: false.
    provider = await seededMemoryProvider();

    await expect(provider.runMaintenance("optimize", "customers")).rejects.toThrow(/takes no target/);
  });

  test.each(["reindex", "check", "kill"] as const)("%s is refused with the reason it is not offered", async (type) => {
    provider = await seededMemoryProvider();

    await expect(provider.runMaintenance(type)).rejects.toThrow(/does not support the .* maintenance operation/);
  });

  test("a maintenance statement the engine refuses surfaces as a QueryError", async () => {
    provider = await seededMemoryProvider();

    await expect(provider.runMaintenance("analyze", "no_such_table")).rejects.toThrow(QueryError);
  });
});

// ============================================================================
// Agent read-only execution profile (#328)
// ============================================================================

describe("queryReadOnly()", () => {
  let provider: DuckDBProvider;
  let dbPath: string;

  afterEach(async () => {
    if (provider?.isConnected()) await provider.disconnect();
  });

  async function readOnlyProvider(): Promise<DuckDBProvider> {
    dbPath = await seededFile(`ro-${Math.random().toString(36).slice(2)}.duckdb`);
    const opened = new DuckDBProvider(makeConfig({ database: dbPath }), {}, { readOnly: true });
    await opened.connect();
    return opened;
  }

  test("an in-memory target is refused: there would be nothing to read", async () => {
    provider = new DuckDBProvider(makeConfig(), {}, { readOnly: true });

    await expect(provider.connect()).rejects.toThrow(ExecutionProfileError);
    await expect(provider.connect()).rejects.toMatchObject({ reasonCode: "PROFILE_UNSUPPORTED_TARGET" });
  });

  test("a file that does not exist is refused with a sentence saying it will not be created", async () => {
    provider = new DuckDBProvider(makeConfig({ database: join(workDir, "absent.duckdb") }), {}, { readOnly: true });

    await expect(provider.connect()).rejects.toThrow(ConnectionError);
    await expect(provider.connect()).rejects.toThrow(/will not create one/);
    expect(existsSync(join(workDir, "absent.duckdb"))).toBe(false);
  });

  test("a writable provider refuses read-only execution outright", async () => {
    // A handle with no boundary has nothing to enforce, so running the statement there
    // would be exactly the fail-open this layer exists to prevent.
    provider = new DuckDBProvider(makeConfig());
    await provider.connect();

    await expect(provider.queryReadOnly("SELECT 1", GENEROUS_BUDGET)).rejects.toThrow(/agent read-only profile/);
  });

  test("reads answer normally through the profiled handle", async () => {
    provider = await readOnlyProvider();

    const result = await provider.queryReadOnly("SELECT id, secret FROM users ORDER BY id", GENEROUS_BUDGET);

    expect(result.rows).toEqual([
      { id: 1, secret: "top" },
      { id: 2, secret: "secret" },
    ]);
  });

  test("the engine itself refuses a write, before any statement inspection could", async () => {
    provider = await readOnlyProvider();

    await expect(provider.queryReadOnly("INSERT INTO users VALUES (3, 'x')", GENEROUS_BUDGET)).rejects.toThrow(
      /read-only mode/,
    );
  });

  test.each([
    [{ statementTimeoutMs: 0, maxResultRows: 10, maxResultBytes: 10 }],
    [{ statementTimeoutMs: 10, maxResultRows: 0, maxResultBytes: 10 }],
    [{ statementTimeoutMs: 10, maxResultRows: 10, maxResultBytes: -1 }],
    [{ statementTimeoutMs: 1.5, maxResultRows: 10, maxResultBytes: 10 }],
  ])("a budget that is not all positive integers is refused: %p", async (budget) => {
    provider = await readOnlyProvider();

    await expect(provider.queryReadOnly("SELECT 1", budget as ReadOnlyStatementBudget)).rejects.toThrow(
      /must be a positive integer/,
    );
  });

  test("a result over the row budget is refused", async () => {
    provider = await readOnlyProvider();

    await expect(
      provider.queryReadOnly("SELECT * FROM users", { ...GENEROUS_BUDGET, maxResultRows: 1 }),
    ).rejects.toThrow(/exceeded the row budget: 2 rows > 1 allowed/);
  });

  test("a result over the byte budget is refused", async () => {
    provider = await readOnlyProvider();

    await expect(
      provider.queryReadOnly("SELECT * FROM users", { ...GENEROUS_BUDGET, maxResultBytes: 1 }),
    ).rejects.toThrow(/exceeded the byte budget/);
  });

  test("a statement over the time budget has its result refused", async () => {
    // DuckDB has no statement-level timeout setting, so the deadline is enforced after
    // the fact: the result is refused rather than returned as if it were in budget.
    provider = await readOnlyProvider();

    await expect(
      provider.queryReadOnly("SELECT count(*) FROM range(30000000)", { ...GENEROUS_BUDGET, statementTimeoutMs: 1 }),
    ).rejects.toThrow(/exceeded the time budget/);
  }, 30_000);

  // ------------------------------------------------------------------------
  // The escapes access_mode does not close. Each asserts that NOTHING appeared
  // on disk - an error alone would not distinguish "refused" from "wrote the
  // file, then complained".
  // ------------------------------------------------------------------------

  test("COPY ... TO is refused and no file appears", async () => {
    provider = await readOnlyProvider();
    const leak = join(workDir, "copy-leak.csv");

    await expect(provider.queryReadOnly(`COPY (SELECT 1) TO '${leak}' (FORMAT CSV)`, GENEROUS_BUDGET)).rejects.toThrow(
      QueryError,
    );

    expect(existsSync(leak)).toBe(false);
  });

  test("COPY of a whole table to Parquet is refused and no file appears", async () => {
    provider = await readOnlyProvider();
    const leak = join(workDir, "copy-leak.parquet");

    await expect(provider.queryReadOnly(`COPY users TO '${leak}' (FORMAT PARQUET)`, GENEROUS_BUDGET)).rejects.toThrow(
      QueryError,
    );

    expect(existsSync(leak)).toBe(false);
  });

  test("EXPORT DATABASE is refused and no directory appears", async () => {
    provider = await readOnlyProvider();
    const target = join(workDir, "export-leak");

    await expect(provider.queryReadOnly(`EXPORT DATABASE '${target}'`, GENEROUS_BUDGET)).rejects.toThrow(QueryError);

    expect(existsSync(target)).toBe(false);
  });

  test.each([["INSTALL httpfs"], ["LOAD json"], ["ATTACH ':memory:' AS side"], ["DETACH users"]])(
    "%s is refused before the engine sees it",
    async (sql) => {
      provider = await readOnlyProvider();

      await expect(provider.queryReadOnly(sql, GENEROUS_BUDGET)).rejects.toThrow(/Read-only execution refused/);
    },
  );

  test("reading a file outside the database is refused, so nothing is returned from it", async () => {
    // Measured: `read_text('/etc/hostname')` returns the file's contents through a
    // read-only handle. That is a read the profile's boundary is supposed to bound.
    provider = await readOnlyProvider();

    await expect(provider.queryReadOnly("SELECT * FROM read_text('/etc/hostname')", GENEROUS_BUDGET)).rejects.toThrow(
      /Read-only execution refused READ_TEXT/,
    );
    await expect(
      provider.queryReadOnly("SELECT * FROM read_csv_auto('/etc/hostname')", GENEROUS_BUDGET),
    ).rejects.toThrow(/Read-only execution refused/);
    await expect(provider.queryReadOnly("SELECT * FROM glob('/etc/*')", GENEROUS_BUDGET)).rejects.toThrow(
      /Read-only execution refused GLOB/,
    );
  });

  test("the guard does not stop an ordinary catalog read", async () => {
    provider = await readOnlyProvider();

    const result = await provider.queryReadOnly("SELECT table_name FROM duckdb_tables()", GENEROUS_BUDGET);

    expect(result.rows).toEqual([{ table_name: "users" }]);
  });

  test("only the first statement of a multi-statement string is executed", async () => {
    // The driver runs one statement per call (measured), and the guard reads the whole
    // string anyway - so a forbidden form in the tail is still refused.
    provider = await readOnlyProvider();

    expect((await provider.queryReadOnly("SELECT 1 AS a; SELECT 2 AS b", GENEROUS_BUDGET)).rows).toEqual([{ a: 1 }]);
    await expect(
      provider.queryReadOnly(`SELECT 1; COPY (SELECT 1) TO '${join(workDir, "tail.csv")}'`, GENEROUS_BUDGET),
    ).rejects.toThrow(QueryError);
    expect(existsSync(join(workDir, "tail.csv"))).toBe(false);
  });

  // ------------------------------------------------------------------------
  // The engine-side boundary: `enable_external_access: 'false'`.
  //
  // The statement guard above is a NAME denylist, and a name denylist cannot be the
  // boundary: it does not see a quoted function name, a bare path in FROM, or a
  // statement carried inside a string literal. Each form below was measured EXECUTING
  // through this provider when `access_mode: 'READ_ONLY'` was the only engine control.
  // Every test carries a live control read on the same handle, so a wording change
  // cannot make the refusal assertions pass vacuously.
  // ------------------------------------------------------------------------

  /** A read the profile is SUPPOSED to serve, run on the same handle as each refusal. */
  async function expectTheHandleStillReads(open: DuckDBProvider): Promise<void> {
    const control = await open.queryReadOnly("SELECT secret FROM users WHERE id = 1", GENEROUS_BUDGET);
    expect(control.rows).toEqual([{ secret: "top" }]);
  }

  test("the read-only handle runs with external access off, and the writable one does not", async () => {
    provider = await readOnlyProvider();
    const SETTING = "SELECT value FROM duckdb_settings() WHERE name = 'enable_external_access'";

    expect((await provider.queryReadOnly(SETTING, GENEROUS_BUDGET)).rows).toEqual([{ value: "false" }]);

    // The control that makes the assertion above mean something: the ordinary editor
    // handle on the SAME file keeps its filesystem reach, because COPY and read_csv are
    // features there rather than escapes.
    const writable = new DuckDBProvider(makeConfig({ database: dbPath }));
    await writable.connect();
    try {
      expect((await writable.query(SETTING)).rows).toEqual([{ value: "true" }]);
    } finally {
      await writable.disconnect();
    }
  });

  test("external access cannot be turned back on by a statement", async () => {
    provider = await readOnlyProvider();

    await expect(provider.queryReadOnly("SET enable_external_access = true", GENEROUS_BUDGET)).rejects.toThrow(
      /Cannot enable external access while database is running/,
    );
    await expect(provider.queryReadOnly("SET GLOBAL enable_external_access = true", GENEROUS_BUDGET)).rejects.toThrow(
      /Cannot enable external access while database is running/,
    );
    // Still off afterwards, and the handle still reads.
    expect(
      (
        await provider.queryReadOnly(
          "SELECT value FROM duckdb_settings() WHERE name = 'enable_external_access'",
          GENEROUS_BUDGET,
        )
      ).rows,
    ).toEqual([{ value: "false" }]);
    await expectTheHandleStillReads(provider);
  });

  test.each([
    ["a quoted function name", `SELECT * FROM "read_text"('/etc/hostname')`],
    ["a quoted, schema-qualified function name", `SELECT * FROM main."read_text"('/etc/hostname')`],
    ["a quoted glob", `SELECT * FROM "glob"('/etc/*')`],
    ["a quoted read_csv_auto", `SELECT * FROM "read_csv_auto"('${BARE_SCAN_CSV}')`],
    ["a bare path, which DuckDB's replacement scan turns into read_csv_auto", `SELECT * FROM '${BARE_SCAN_CSV}'`],
    [
      "a statement smuggled through a quoted json_execute_serialized_sql",
      `SELECT * FROM "json_execute_serialized_sql"(json_serialize_sql('SELECT * FROM read_text(''/etc/hostname'')'))`,
    ],
  ])("%s reaches no file: the guard cannot see it, the engine refuses it", async (_label, sql) => {
    provider = await readOnlyProvider();

    // The guard genuinely does not see this form - that is why the engine option is the
    // boundary rather than the belt. If a future matcher DOES see it, this line fails
    // and the comment above it has to be rewritten.
    expect(() => assertReadOnlyStatementIsBounded(sql)).not.toThrow();

    await expect(provider.queryReadOnly(sql, GENEROUS_BUDGET)).rejects.toThrow(
      /file system operations are disabled by configuration/,
    );
    await expectTheHandleStillReads(provider);
  });

  test("the unquoted forms are refused twice over: by the guard, and by the engine behind it", async () => {
    provider = await readOnlyProvider();

    // The guard answers first, with its own sentence...
    await expect(provider.queryReadOnly("SELECT * FROM read_text('/etc/hostname')", GENEROUS_BUDGET)).rejects.toThrow(
      /Read-only execution refused READ_TEXT/,
    );
    // ...and the engine would have refused it too, which is what makes the guard a belt
    // rather than the boundary. Asserted through the quoted spelling the guard is blind
    // to, so the engine is demonstrably the one answering.
    await expect(provider.queryReadOnly(`SELECT * FROM "read_text"('/etc/hostname')`, GENEROUS_BUDGET)).rejects.toThrow(
      /Permission Error/,
    );
    await expectTheHandleStillReads(provider);
  });

  test("read_duckdb cannot reach a second database file, which is the ATTACH refusal by another name", async () => {
    const other = await seededFile("read-duckdb-target.duckdb");
    provider = await readOnlyProvider();

    await expect(provider.queryReadOnly(`SELECT * FROM read_duckdb('${other}')`, GENEROUS_BUDGET)).rejects.toThrow(
      /Read-only execution refused READ_DUCKDB/,
    );
    // And with the guard's name blinded by quoting, the engine still refuses it.
    await expect(provider.queryReadOnly(`SELECT * FROM "read_duckdb"('${other}')`, GENEROUS_BUDGET)).rejects.toThrow(
      /file system operations are disabled by configuration/,
    );
    await expectTheHandleStillReads(provider);
  });

  test("the writable handle keeps the filesystem reach the read-only profile gives up", async () => {
    // The engine option is the PROFILE's, not the provider's: the editor connection is
    // measured unaffected, so COPY and read_csv_auto still work for the user at the
    // keyboard. Without this control, disabling external access everywhere would look
    // exactly the same in every other test.
    const target = join(workDir, "writable-reach.csv");
    provider = new DuckDBProvider(makeConfig({ database: join(workDir, "writable-reach.duckdb") }));
    await provider.connect();

    await provider.query(`COPY (SELECT 1 AS a) TO '${target}' (FORMAT CSV)`);
    expect(existsSync(target)).toBe(true);

    const readBack = await provider.query(`SELECT * FROM read_csv_auto('${target}')`);
    expect(readBack.rows).toEqual([{ a: "1" }]);
  });
});

// ============================================================================
// The denylist against DuckDB's own catalog
// ============================================================================

/**
 * The highest-value test in this file: the read-only denylist is checked against the
 * functions the LIVE engine ships, not against the ones the author happened to know.
 *
 * A DuckDB upgrade that adds a new reader - `read_avro`, `parquet_something_metadata` -
 * fails here instead of silently widening what the agent profile can name. The engine
 * option is still the boundary; this keeps the belt from rotting.
 */
describe("the read-only denylist against duckdb_functions()", () => {
  /** How a DuckDB table function's NAME is spelled when it reaches outside the database. */
  const FILE_REACHING_SHAPE = /^read_|^parquet_|_scan$|^glob$|^sniff_|serialized_sql$/;

  /**
   * Matches the shape and reaches no path, so it is deliberately not on the denylist.
   * Both take an in-process binding rather than a file: `arrow_scan` a set of raw
   * pointers, `seq_scan` the engine's own table binding.
   */
  const REVIEWED_AS_NOT_A_FILE_READER = new Set(["arrow_scan", "seq_scan"]);

  test("every file-reaching table function this engine ships is refused by the guard", async () => {
    const provider = new DuckDBProvider(makeConfig());
    await provider.connect();

    try {
      const result = await provider.query(
        "SELECT DISTINCT function_name FROM duckdb_functions() WHERE function_type = 'table' ORDER BY 1",
      );
      const names = result.rows.map((row) => String(row.function_name));

      // Non-vacuity: the catalog really did answer, and it really does carry the
      // readers this list is about.
      expect(names).toContain("read_text");
      expect(names).toContain("parquet_metadata");

      const reaching = names.filter(
        (name) => FILE_REACHING_SHAPE.test(name) && !REVIEWED_AS_NOT_A_FILE_READER.has(name),
      );
      expect(reaching.length).toBeGreaterThan(15);

      const unguarded = reaching.filter((name) => {
        try {
          assertReadOnlyStatementIsBounded(`SELECT * FROM ${name}('/tmp/x')`);
          return true;
        } catch {
          return false;
        }
      });

      expect(unguarded).toEqual([]);

      // The complement, so the filter above is not simply refusing everything: a
      // catalog function that reaches nothing outside the database is still allowed.
      expect(() => assertReadOnlyStatementIsBounded("SELECT * FROM duckdb_tables()")).not.toThrow();
      expect(() => assertReadOnlyStatementIsBounded("CALL pragma_storage_info('users')")).not.toThrow();
    } finally {
      await provider.disconnect();
    }
  });
});

// ============================================================================
// The object surface (#789)
// ============================================================================

/**
 * The object-surface fixture, built in a real engine rather than mocked.
 *
 * DuckDB is embedded, so every row below is the ENGINE's answer and not a canned
 * recordset: `ATTACH ':memory:' AS warehouse` gives a second real catalog in the same
 * process, which is what makes this the only provider in #789 whose two container levels
 * are exercised against a live server in the ordinary test run.
 *
 * Two catalogs, four schemas, and one object of every declared kind. The `overlap` trio
 * is not padding: measured on DuckDB v1.5.5, `CREATE SEQUENCE overlap` and
 * `CREATE MACRO overlap(x)` both succeed while the table `overlap` exists, and
 * `CREATE VIEW overlap` is refused (`Catalog Error: Table with name "overlap" already
 * exists!`). So a table, a sequence and a macro really do share one name here, which is
 * the case `tests/helpers/object-surface-conformance.ts` keeps invariant 5 inside a kind
 * for.
 */
async function seededObjectProvider(): Promise<DuckDBProvider> {
  const provider = new DuckDBProvider(makeConfig());
  await provider.connect();

  await provider.query("CREATE SCHEMA analytics");
  await provider.query(
    "CREATE TABLE main.customers (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL, note VARCHAR DEFAULT 'none')",
  );
  await provider.query(
    "CREATE TABLE main.orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES main.customers(id), total DECIMAL(12,2))",
  );
  await provider.query("CREATE INDEX ix_orders_customer ON main.orders(customer_id)");
  await provider.query("CREATE TABLE analytics.events (id BIGINT, payload VARCHAR)");
  // Two SAME-NAMED tables in two schemas, with different columns and an index each. This
  // is what a detail read's schema filter is for: without it `main.customers` and
  // `analytics.customers` merge, and the merged answer is a table with columns it does
  // not have rather than an error anybody would notice.
  await provider.query("CREATE TABLE analytics.customers (event_id BIGINT)");
  await provider.query("CREATE TABLE analytics.orders (id INTEGER)");
  await provider.query("CREATE INDEX ix_orders_customer ON analytics.orders(id)");
  await provider.query("CREATE VIEW main.customer_names AS SELECT name FROM main.customers");
  await provider.query("CREATE VIEW analytics.event_days AS SELECT id FROM analytics.events");
  await provider.query("CREATE MACRO main.add_one(x) AS x + 1");
  await provider.query("CREATE MACRO analytics.recent_events(n) AS TABLE SELECT * FROM analytics.events LIMIT n");
  await provider.query("CREATE SEQUENCE main.customer_seq START 1");
  await provider.query("CREATE SEQUENCE analytics.event_seq START 100");

  // One name, three kinds, in one schema. Measured, not assumed - see the docblock.
  await provider.query("CREATE TABLE main.overlap (id INTEGER)");
  await provider.query("CREATE SEQUENCE main.overlap");
  await provider.query("CREATE MACRO main.overlap(x) AS x");

  // A second real catalog, with a schema set of its own and no routine or sequence, so a
  // declared-and-empty folder has somewhere to be measured.
  await provider.query("ATTACH ':memory:' AS warehouse");
  await provider.query("CREATE SCHEMA warehouse.stock");
  await provider.query("CREATE TABLE warehouse.main.ledger (id INTEGER)");
  // Same SCHEMA name, same TABLE name, different CATALOG. This is the two-level engine's
  // characteristic case and the only thing that can show the catalog filter working: a
  // detail read that dropped `database_name = $1` would merge `memory.main.customers`
  // with this one and report a table with columns from both.
  await provider.query("CREATE TABLE warehouse.main.customers (sku VARCHAR)");
  await provider.query("CREATE TABLE warehouse.stock.items (sku VARCHAR)");

  return provider;
}

/** Every catalog the fixture above answers `listContainers()` with, in order. */
const FIXTURE_CATALOGS = [["memory"], ["warehouse"]];

/** The counts the fixture holds in the catalog `memory`, measured against the engine. */
const FIXTURE_CATALOG_COUNTS = { table: 6, view: 2, macro: 3, sequence: 3 };

describe("object surface", () => {
  test("declares the kinds DuckDB has, at two container levels", () => {
    const capabilities = new DuckDBProvider(makeConfig()).getCapabilities();
    const kinds = capabilities.objectKinds ?? [];

    expect(kinds.map((kind) => kind.id).sort()).toEqual(["macro", "sequence", "table", "view"]);
    expect(kinds.find((kind) => kind.id === "table")?.acceptsRowWrites).toBe(true);
    // No `acceptsRowWrites` on a view: DuckDB refuses an INSERT into a view outright
    // ("Catalog Error: Table with name ... does not exist!" against the view's name is
    // what an INSERT answers), so a view is never an import target here.
    expect(kinds.find((kind) => kind.id === "view")?.acceptsRowWrites).toBeUndefined();
    expect(kinds.find((kind) => kind.id === "macro")?.role).toBe("routine");
    expect(kinds.find((kind) => kind.id === "sequence")?.role).toBe("config");
    // No trigger and no procedure: DuckDB has neither, and a folder for a concept the
    // engine does not have is a lie its zero badge makes look like a fact.
    expect(kinds.find((kind) => kind.id === "trigger")).toBeUndefined();
    expect(kinds.find((kind) => kind.id === "procedure")).toBeUndefined();
    // No `index` kind: `duckdb_indexes()` is keyed by `table_oid` and an index cannot
    // exist without a table, so it belongs in describeObject's output.
    expect(kinds.find((kind) => kind.id === "index")).toBeUndefined();

    expect(capabilities.containerLevels).toEqual([
      { id: "catalog", label: "Database", labelPlural: "Databases" },
      { id: "schema", label: "Schema", labelPlural: "Schemas" },
    ]);
  });

  test("satisfies the shared object surface contract", async () => {
    const provider = await seededObjectProvider();
    try {
      await assertObjectSurface(provider, {
        containers: FIXTURE_CATALOGS,
        kinds: FIXTURE_CATALOG_COUNTS,
        sampleObject: { path: ["memory", "main", "orders"], kind: "table" },
      });
    } finally {
      await provider.disconnect();
    }
  });
});

/**
 * The rest of the object surface: the containers, the listings, the detail row and the
 * refusals. Kept out of the block above so `-t "object surface"` still runs the shared
 * contract on its own.
 */
describe("DuckDB object containers, listings and detail", () => {
  test("the top level is every attachable catalog, and a nested list reads the CALLER's catalog", async () => {
    const provider = await seededObjectProvider();
    try {
      const catalogs = await provider.listContainers();
      expect(catalogs.map((container) => container.path)).toEqual(FIXTURE_CATALOGS);
      expect(catalogs.every((container) => container.level === 0)).toBe(true);
      // The connected catalog is marked and the ATTACHed one is not. `:memory:` opens as
      // the catalog `memory`, which is DuckDB's own name for it.
      expect(catalogs.find((container) => container.name === "memory")?.isSessionDefault).toBe(true);
      expect(catalogs.find((container) => container.name === "warehouse")?.isSessionDefault).toBe(false);

      // The nested level. The two catalogs answer DIFFERENT schema sets, which is the pin:
      // a provider that read `current_database()` instead of the caller's segment would
      // answer `memory`'s schemas under `warehouse` and look entirely healthy doing it.
      expect((await provider.listContainers(["memory"])).map((container) => container.path)).toEqual([
        ["memory", "analytics"],
        ["memory", "main"],
      ]);
      expect((await provider.listContainers(["warehouse"])).map((container) => container.path)).toEqual([
        ["warehouse", "main"],
        ["warehouse", "stock"],
      ]);
      expect((await provider.listContainers(["warehouse"])).every((container) => container.level === 1)).toBe(true);
    } finally {
      await provider.disconnect();
    }
  });

  test("the session default is marked at BOTH levels, so first paint reaches a schema", async () => {
    const provider = await seededObjectProvider();
    try {
      // Standing ruling 5a2 (#789): first paint walks the container chain down to the
      // session default at the DEEPEST declared level and reads counts THERE. On a
      // two-level engine that is three reads, and a provider marking only its catalogs
      // would leave `withSessionDefault` in `src/components/object-tree/use-tree-nodes.ts`
      // opening a database and stopping, having read no counts at all.
      const catalogs = await provider.listContainers();
      const defaultCatalog = catalogs.filter((container) => container.isSessionDefault === true);
      expect(defaultCatalog.map((container) => container.path)).toEqual([["memory"]]);

      const schemas = await provider.listContainers(defaultCatalog[0].path);
      const defaultSchema = schemas.filter((container) => container.isSessionDefault === true);
      expect(defaultSchema.map((container) => container.path)).toEqual([["memory", "main"]]);
      // Exactly one, at each level: the walk takes `find`, so two marked rows would make
      // which one opens an accident of catalog order.
      expect(schemas.filter((container) => container.name === "analytics")[0].isSessionDefault).toBe(false);

      // An ATTACHed catalog marks NO schema, which is the truth rather than a gap:
      // `current_schema()` names a schema inside `current_database()`, and a session sits
      // in one catalog. A predicate comparing the schema name alone would mark
      // `warehouse.main` here, and the tree would open two databases at once.
      expect((await provider.listContainers(["warehouse"])).map((container) => container.isSessionDefault)).toEqual([
        false,
        false,
      ]);

      // And it FOLLOWS the session rather than naming `main`: `USE` moves both halves.
      await provider.query("USE warehouse.stock");
      expect((await provider.listContainers()).filter((c) => c.isSessionDefault === true).map((c) => c.path)).toEqual([
        ["warehouse"],
      ]);
      expect(
        (await provider.listContainers(["warehouse"])).filter((c) => c.isSessionDefault === true).map((c) => c.path),
      ).toEqual([["warehouse", "stock"]]);
      // The catalog that WAS the default now marks nothing at either level.
      expect((await provider.listContainers(["memory"])).map((c) => c.isSessionDefault)).toEqual([false, false]);
    } finally {
      await provider.disconnect();
    }
  });

  test("main is listed although duckdb_schemas() calls it internal", async () => {
    const provider = await seededObjectProvider();
    try {
      // The measured trap, and the control for it in the same test: `main` is
      // `internal = true` in a USER database while `analytics` is not, so a schema listing
      // filtered on `NOT internal` would drop the default schema and with it most of the
      // objects in the tree. DuckDB's own rows, read directly:
      const flags = await provider.query(
        "SELECT schema_name, internal FROM duckdb_schemas() WHERE database_name = 'memory' ORDER BY schema_name",
      );
      expect(flags.rows).toEqual([
        { schema_name: "analytics", internal: false },
        { schema_name: "main", internal: true },
      ]);

      const schemas = await provider.listContainers(["memory"]);
      expect(schemas.map((container) => container.name)).toContain("main");
    } finally {
      await provider.disconnect();
    }
  });

  test("the internal system and temp catalogs are never containers", async () => {
    const provider = await seededObjectProvider();
    try {
      // Non-vacuity first: both really are attached to this session, and `system` really
      // does hold objects - 2949 built-in functions and the whole pg_catalog compatibility
      // layer - so excluding them is a decision rather than an empty filter.
      const attached = await provider.query("SELECT database_name, internal FROM duckdb_databases() ORDER BY 1");
      expect(attached.rows).toEqual([
        { database_name: "memory", internal: false },
        { database_name: "system", internal: true },
        { database_name: "temp", internal: true },
        { database_name: "warehouse", internal: false },
      ]);

      const names = (await provider.listContainers()).map((container) => container.name);
      expect(names).not.toContain("system");
      expect(names).not.toContain("temp");
    } finally {
      await provider.disconnect();
    }
  });

  test("nothing nests under a schema, and that is an answer rather than a refusal", async () => {
    const provider = await seededObjectProvider();
    try {
      expect(await provider.listContainers(["memory", "main"])).toEqual([]);
    } finally {
      await provider.disconnect();
    }
  });

  test("counts the whole catalog, then one schema, and seeds a declared kind at zero", async () => {
    const provider = await seededObjectProvider();
    try {
      expect(await provider.countObjects(["memory"])).toEqual({
        table: { count: 6 },
        view: { count: 2 },
        macro: { count: 3 },
        sequence: { count: 3 },
      });
      expect(await provider.countObjects(["memory", "main"])).toEqual({
        table: { count: 3 },
        view: { count: 1 },
        macro: { count: 2 },
        sequence: { count: 2 },
      });
      expect(await provider.countObjects(["memory", "analytics"])).toEqual({
        table: { count: 3 },
        view: { count: 1 },
        macro: { count: 1 },
        sequence: { count: 1 },
      });
      // The sum rule: unlike SQL Server, every DuckDB object of every declared kind
      // belongs to a schema, so a catalog count IS the sum over the schemas
      // `listContainers` lists. 3+1 tables, 1+1 views, 2+1 macros, 2+1 sequences.

      // A declared kind this catalog holds none of carries `{ count: 0 }` and NOT an
      // absent key: an absent kind means the engine has no such concept, and a folder
      // that disappears is a different fact from a folder badged 0.
      expect(await provider.countObjects(["warehouse"])).toEqual({
        table: { count: 3 },
        view: { count: 0 },
        macro: { count: 0 },
        sequence: { count: 0 },
      });
      expect(await provider.countObjects(["warehouse", "stock"])).toEqual({
        table: { count: 1 },
        view: { count: 0 },
        macro: { count: 0 },
        sequence: { count: 0 },
      });
    } finally {
      await provider.disconnect();
    }
  });

  test("a refused count carries the engine's own sentence, never a zero", async () => {
    const provider = await seededObjectProvider();
    try {
      // A REAL refusal from a real engine rather than a thrown mock, and a DETERMINISTIC
      // one: `SET max_expression_depth=1` is pure configuration, so the SET itself always
      // succeeds, and every catalog read after it is refused by the parser. (The obvious
      // alternative, `SET memory_limit='1KB'`, is not usable here - measured, the SET
      // itself fails with "could not free up enough memory for the new limit" once the
      // fixture holds enough, so the refusal would come and go with the fixture's size.)
      await provider.query("SET max_expression_depth=1");

      // Every shape of container, because a refusal has to answer for the WHOLE declared
      // kind set at either depth: a catalog, a schema inside it, and a second catalog
      // entirely. Reporting `{ count: 0 }` for any one of them would render "the read was
      // refused" as "this folder is empty".
      for (const container of [["memory"], ["memory", "main"], ["warehouse", "stock"]]) {
        const counts = await provider.countObjects(container);
        expect(Object.keys(counts).sort()).toEqual(["macro", "sequence", "table", "view"]);
        for (const kind of Object.keys(counts)) {
          const count = counts[kind];
          expect(count).toHaveProperty("unavailable");
          expect((count as { unavailable: string }).unavailable).toContain("Max expression depth limit of 1 exceeded");
        }
      }
      // The control, on a SIBLING provider over the same fixture: the same statement at
      // the default depth answers numbers, so the assertions above are about the refusal
      // and not about a broken statement. It has to be a second handle - measured, once
      // the depth is 1 even `SET max_expression_depth=1000` and `RESET` are refused by the
      // same limit, so the session cannot climb back out.
      const control = await seededObjectProvider();
      try {
        expect(await control.countObjects(["memory"])).toEqual({
          table: { count: 6 },
          view: { count: 2 },
          macro: { count: 3 },
          sequence: { count: 3 },
        });
      } finally {
        await control.disconnect();
      }
    } finally {
      await provider.disconnect();
    }
  });

  test("a container path of the wrong shape is refused by name", async () => {
    const provider = await seededObjectProvider();
    try {
      await expect(provider.countObjects([])).rejects.toThrow(
        "A DuckDB container path is [database] or [database, schema], received []",
      );
      await expect(provider.listObjects(["memory", "main", "customers"], "table")).rejects.toThrow(
        'received ["memory","main","customers"]',
      );
    } finally {
      await provider.disconnect();
    }
  });

  test("the listing holds exactly what the count counted, at both depths", async () => {
    const provider = await seededObjectProvider();
    try {
      // Standing ruling 5f (#789), asserted rather than assumed. The count and the listing
      // for one kind read the same `duckdb_*` table function through the same filter, and
      // the engine is in-process and static here, so the two really must agree to the row.
      for (const container of [["memory"], ["memory", "main"], ["memory", "analytics"], ["warehouse"]]) {
        const counts = await provider.countObjects(container);
        for (const [kind, count] of Object.entries(counts)) {
          const listed = await provider.listObjects(container, kind);
          expect({ container, kind, n: listed.length }).toEqual({
            container,
            kind,
            n: (count as { count: number }).count,
          });
        }
      }
    } finally {
      await provider.disconnect();
    }
  });

  test("lists each kind with the paths and names the tree addresses it by", async () => {
    const provider = await seededObjectProvider();
    try {
      expect(await provider.listObjects(["memory"], "table")).toEqual([
        { path: ["memory", "analytics", "customers"], name: "customers", kind: "table" },
        { path: ["memory", "analytics", "events"], name: "events", kind: "table" },
        { path: ["memory", "analytics", "orders"], name: "orders", kind: "table" },
        { path: ["memory", "main", "customers"], name: "customers", kind: "table" },
        { path: ["memory", "main", "orders"], name: "orders", kind: "table" },
        { path: ["memory", "main", "overlap"], name: "overlap", kind: "table" },
      ]);
      expect(await provider.listObjects(["memory"], "view")).toEqual([
        { path: ["memory", "analytics", "event_days"], name: "event_days", kind: "view" },
        { path: ["memory", "main", "customer_names"], name: "customer_names", kind: "view" },
      ]);
      // BOTH macro forms, which is the whole reason `function_type` carries two spellings:
      // `recent_events` is a table macro and `add_one` a scalar one. A vocabulary that had
      // lost `table_macro` would drop the first from the count AND the listing together.
      expect(await provider.listObjects(["memory"], "macro")).toEqual([
        { path: ["memory", "analytics", "recent_events"], name: "recent_events", kind: "macro" },
        { path: ["memory", "main", "add_one"], name: "add_one", kind: "macro" },
        { path: ["memory", "main", "overlap"], name: "overlap", kind: "macro" },
      ]);
      expect(await provider.listObjects(["memory"], "sequence")).toEqual([
        { path: ["memory", "analytics", "event_seq"], name: "event_seq", kind: "sequence" },
        { path: ["memory", "main", "customer_seq"], name: "customer_seq", kind: "sequence" },
        { path: ["memory", "main", "overlap"], name: "overlap", kind: "sequence" },
      ]);
      // Scoped to ONE schema, so a listing that ignored `$2` would be caught here as well
      // as by the count comparison above.
      expect((await provider.listObjects(["memory", "analytics"], "table")).map((object) => object.path)).toEqual([
        ["memory", "analytics", "customers"],
        ["memory", "analytics", "events"],
        ["memory", "analytics", "orders"],
      ]);
      // A different CATALOG entirely, which is what makes the outer level real.
      expect(await provider.listObjects(["warehouse"], "table")).toEqual([
        { path: ["warehouse", "main", "customers"], name: "customers", kind: "table" },
        { path: ["warehouse", "main", "ledger"], name: "ledger", kind: "table" },
        { path: ["warehouse", "stock", "items"], name: "items", kind: "table" },
      ]);
    } finally {
      await provider.disconnect();
    }
  });

  test("a table, a sequence and a macro may share one name, and a view may not", async () => {
    const provider = await seededObjectProvider();
    try {
      // Measured against the running engine, not assumed: this is the case
      // `tests/helpers/object-surface-conformance.ts` keeps invariant 5 inside a kind for,
      // and it is what makes `describeObject` take the kind rather than resolve it from
      // the name.
      await expect(provider.query("CREATE VIEW main.overlap AS SELECT 1")).rejects.toThrow(
        'Table with name "overlap" already exists',
      );

      const paths = ["table", "sequence", "macro"].map(async (kind) =>
        (await provider.listObjects(["memory", "main"], kind)).map((object) => object.path),
      );
      for (const kindPaths of await Promise.all(paths)) {
        expect(kindPaths).toContainEqual(["memory", "main", "overlap"]);
      }

      // And the three answer three DIFFERENT details for that one path.
      expect((await provider.describeObject(["memory", "main", "overlap"], "table")).columns).toEqual([
        { name: "id", type: "INTEGER", nullable: true, isPrimary: false },
      ]);
      expect((await provider.describeObject(["memory", "main", "overlap"], "sequence")).columns).toEqual([]);
      expect((await provider.describeObject(["memory", "main", "overlap"], "macro")).columns).toEqual([]);
    } finally {
      await provider.disconnect();
    }
  });

  test("listObjects refuses an undeclared kind, and a declared one with no catalog behind it", async () => {
    const provider = await seededObjectProvider();
    try {
      await expect(provider.listObjects(["memory"], "trigger")).rejects.toThrow(
        'DuckDB declares no object kind "trigger"',
      );

      // A kind id is an OPEN string, so `DUCKDB_OBJECT_SOURCES["toString"]` answers a
      // function off the prototype chain unless the lookup is `Object.hasOwn`. Declaring a
      // kind called `toString` is what makes that reachable, and the refusal has to be the
      // SECOND sentence - the declaration answered the first question.
      spyOn(provider, "getCapabilities").mockReturnValue({
        ...new DuckDBProvider(makeConfig()).getCapabilities(),
        objectKinds: [{ id: "toString", role: "relation", label: "Odd", labelPlural: "Odds" }],
      });
      await expect(provider.listObjects(["memory"], "toString")).rejects.toThrow(
        'DuckDB declares the kind "toString" but has no catalog function that answers for it',
      );
      // The same defect reaches `countObjects` through the statement builder, and it
      // surfaces as a THROW rather than as `{ unavailable }`: a declaration defect is not
      // the engine refusing a read.
      await expect(provider.countObjects(["memory"])).rejects.toThrow("has no catalog function");
    } finally {
      await provider.disconnect();
    }
  });

  test("describes a table: columns, primary key, foreign keys and indexes", async () => {
    const provider = await seededObjectProvider();
    try {
      expect(await provider.describeObject(["memory", "main", "orders"], "table")).toEqual({
        path: ["memory", "main", "orders"],
        columns: [
          { name: "id", type: "INTEGER", nullable: false, isPrimary: true },
          { name: "customer_id", type: "INTEGER", nullable: true, isPrimary: false },
          { name: "total", type: "DECIMAL(12,2)", nullable: true, isPrimary: false },
        ],
        indexes: [{ name: "ix_orders_customer", columns: ["customer_id"], unique: false }],
        foreignKeys: [{ columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" }],
      });

      // A DEFAULT reaches the column row, and a table with no index or foreign key carries
      // two empty arrays rather than an absent key.
      expect(await provider.describeObject(["memory", "main", "customers"], "table")).toEqual({
        path: ["memory", "main", "customers"],
        columns: [
          { name: "id", type: "INTEGER", nullable: false, isPrimary: true },
          { name: "name", type: "VARCHAR", nullable: false, isPrimary: false },
          { name: "note", type: "VARCHAR", nullable: true, isPrimary: false, defaultValue: "'none'" },
        ],
        indexes: [],
        foreignKeys: [],
      });

      // The SCHEMA filter, which only a same-named pair can show. `analytics.customers`
      // is a different table with a different column, and `analytics.orders` carries an
      // index of the SAME NAME as the one on `main.orders`: a detail read that dropped
      // `schema_name = $2` would merge the two and report columns and indexes the object
      // does not have.
      expect(await provider.describeObject(["memory", "analytics", "customers"], "table")).toEqual({
        path: ["memory", "analytics", "customers"],
        columns: [{ name: "event_id", type: "BIGINT", nullable: true, isPrimary: false }],
        indexes: [],
        foreignKeys: [],
      });
      expect((await provider.describeObject(["memory", "analytics", "orders"], "table")).indexes).toEqual([
        { name: "ix_orders_customer", columns: ["id"], unique: false },
      ]);
      // The CATALOG filter, which only a same-schema same-name pair across two databases
      // can show. `warehouse.main.customers` is a third real table at the same schema and
      // the same name, so a detail read that dropped `database_name = $1` would answer
      // four columns for a three-column table.
      expect(await provider.describeObject(["warehouse", "main", "customers"], "table")).toEqual({
        path: ["warehouse", "main", "customers"],
        columns: [{ name: "sku", type: "VARCHAR", nullable: true, isPrimary: false }],
        indexes: [],
        foreignKeys: [],
      });

      // The control for that pair: DuckDB really does hold two indexes of one name, in
      // two schemas, so the filter has something to get wrong.
      const shared = await provider.query(
        "SELECT schema_name FROM duckdb_indexes() WHERE index_name = 'ix_orders_customer' ORDER BY 1",
      );
      expect(shared.rows).toEqual([{ schema_name: "analytics" }, { schema_name: "main" }]);

      // A PRIMARY KEY writes NO `duckdb_indexes()` row on this engine, which is why the
      // index listing needs no exclusion. The control for that claim, read directly:
      const indexes = await provider.query("SELECT COUNT(*) AS n FROM duckdb_indexes() WHERE is_primary");
      expect(indexes.rows).toEqual([{ n: "0" }]);
    } finally {
      await provider.disconnect();
    }
  });

  test("describes a view's columns, and a macro and a sequence with no round trip", async () => {
    const provider = await seededObjectProvider();
    try {
      expect(await provider.describeObject(["memory", "main", "customer_names"], "view")).toEqual({
        path: ["memory", "main", "customer_names"],
        columns: [{ name: "name", type: "VARCHAR", nullable: true, isPrimary: false }],
        indexes: [],
        foreignKeys: [],
      });

      // A routine and a config object legitimately have no columns, and answering three
      // empty arrays is the right answer rather than a failed read. Both are checked
      // against a path whose SCHEMA is not `main`, so nothing here can be passing by
      // accident on the default schema.
      expect(await provider.describeObject(["memory", "analytics", "recent_events"], "macro")).toEqual({
        path: ["memory", "analytics", "recent_events"],
        columns: [],
        indexes: [],
        foreignKeys: [],
      });
      expect(await provider.describeObject(["memory", "analytics", "event_seq"], "sequence")).toEqual({
        path: ["memory", "analytics", "event_seq"],
        columns: [],
        indexes: [],
        foreignKeys: [],
      });
    } finally {
      await provider.disconnect();
    }
  });

  test("describeObject refuses an unknown kind, a wrong shape, and an object that is not there", async () => {
    const provider = await seededObjectProvider();
    try {
      await expect(provider.describeObject(["memory", "main", "orders"], "trigger")).rejects.toThrow(
        'DuckDB declares no object kind "trigger"',
      );
      await expect(provider.describeObject(["memory", "orders"], "table")).rejects.toThrow(
        'A DuckDB "table" path is [database, schema, name], received ["memory","orders"]',
      );
      // Zero column rows means the relation is not there: `CREATE TABLE t ()` is
      // `Parser Error: Table must have at least one column!` on this engine, so an empty
      // `columns` array would render a dropped table as a table with no columns.
      await expect(provider.describeObject(["memory", "main", "gone"], "table")).rejects.toThrow(
        "No column row for memory.main.gone",
      );
    } finally {
      await provider.disconnect();
    }
  });

  test("a composite foreign key is zipped out column by column", async () => {
    const provider = await seededObjectProvider();
    try {
      await provider.query("CREATE TABLE analytics.parent (a INTEGER, b INTEGER, PRIMARY KEY (a, b))");
      await provider.query(
        "CREATE TABLE analytics.child (x INTEGER, y INTEGER, FOREIGN KEY (x, y) REFERENCES analytics.parent(a, b))",
      );

      const detail = await provider.describeObject(["memory", "analytics", "child"], "table");
      expect(detail.foreignKeys).toEqual([
        { columnName: "x", referencedTable: "analytics.parent", referencedColumn: "a" },
        { columnName: "y", referencedTable: "analytics.parent", referencedColumn: "b" },
      ]);
      // The referenced table is spelled the way `getSchema()` spells it on this engine:
      // bare in `main`, qualified anywhere else. `orders` above is the bare half.
      expect((await provider.describeObject(["memory", "analytics", "parent"], "table")).columns).toEqual([
        { name: "a", type: "INTEGER", nullable: false, isPrimary: true },
        { name: "b", type: "INTEGER", nullable: false, isPrimary: true },
      ]);
    } finally {
      await provider.disconnect();
    }
  });

  test("the path comparator is total: a prefix sorts before the path that extends it", () => {
    // Asserted DIRECTLY, and the reason is worth stating rather than hiding behind a
    // sort. Every DuckDB object of every declared kind sits at the same depth - there is
    // no trigger here, which is the kind that put `[db, name]` and `[db, schema, table,
    // name]` in one SQL Server folder - so no listing this provider produces can exercise
    // the prefix arm through `listObjects`. The arm is what makes the comparator TOTAL,
    // and a comparator that answered `undefined` for a prefix pair would be a latent
    // defect the first time a kind on this engine has mixed depth.
    expect(comparePaths(["a"], ["a", "b"])).toBeLessThan(0);
    expect(comparePaths(["a", "b"], ["a"])).toBeGreaterThan(0);
    expect(comparePaths(["a", "b"], ["a", "b"])).toBe(0);
    // The serialised key gets the first of those backwards, which is why it is not used:
    // `,` is 0x2C and `]` is 0x5D, so the deeper path sorts before its own prefix.
    expect(JSON.stringify(["a", "b"]) < JSON.stringify(["a"])).toBe(true);
  });

  test("paths are ordered segment by segment, never by JSON.stringify", async () => {
    const provider = await seededObjectProvider();
    try {
      // Both names are legal DuckDB identifiers, created live to check. Raw, `"` is 0x22
      // and sorts before `0` at 0x30; serialised, JSON rewrites `"` as `\"` and the
      // backslash at 0x5C sorts AFTER `0`, so a `JSON.stringify` key orders these two
      // backwards.
      await provider.query('CREATE TABLE main."a""b" (id INTEGER)');
      await provider.query('CREATE TABLE main."a0b" (id INTEGER)');

      const names = (await provider.listObjects(["memory", "main"], "table")).map((object) => object.name);
      expect(names.indexOf('a"b')).toBeLessThan(names.indexOf("a0b"));
      expect(JSON.stringify(["memory", "main", 'a"b']) < JSON.stringify(["memory", "main", "a0b"])).toBe(false);
    } finally {
      await provider.disconnect();
    }
  });
});

/**
 * Standing ruling 5g (#789): every derivation over the declaration, pinned by handing the
 * provider a declaration its engine does not have.
 *
 * This is the block the SQL Server provider (#789) recorded as unreachable there. Two
 * derivations there could only be distinguished by an engine the fleet does not have:
 * telling `requiredSegment(segments, "catalog")` from "the first entry of the record"
 * needs a declaration that lists `schema` BEFORE `catalog`. A `spyOn` supplies exactly
 * that here, and because DuckDB is embedded the swapped declaration is driven all the way
 * to a BOUND VALUE against a real engine rather than to a refusal - which is what let the
 * third spelling of this defect survive two providers and a review round.
 *
 * The fixture is what makes the bound value visible. Two ATTACHed catalogs carry each
 * other's names as schemas, so `alpha.beta.pin` and `beta.alpha.pin` are two different
 * real tables with two different columns: a positional read answers the wrong one rather
 * than nothing, and the test can tell them apart by name.
 */
/**
 * The bulk column read (#789), against the real embedded engine.
 *
 * Every assertion below is a live answer from DuckDB v1.5.5: the fixture is built by DDL
 * in `seededObjectProvider()` and nothing here is recorded or faked.
 */
describe("DuckDB bulk column read", () => {
  /**
   * Every statement the provider sent from here on.
   *
   * The only way to assert "no round trip at all", which is the claim a kind with no
   * columns makes, and the only way to assert that the round trips are CONSTANT in the
   * number of objects rather than one per object. `spyOn` keeps the real implementation,
   * so every answer beside the count is still the engine's.
   */
  function recordStatements(provider: DuckDBProvider): string[] {
    const client = (provider as unknown as { client: { run: (sql: string, params?: unknown[]) => unknown } }).client;
    const sent: string[] = [];
    const real = client.run.bind(client);
    spyOn(client, "run").mockImplementation((sql: string, params?: unknown[]) => {
      sent.push(sql);
      return real(sql, params);
    });
    return sent;
  }

  test("describes every table in a CATALOG, across both its schemas, and each detail is the single read's", async () => {
    const provider = await seededObjectProvider();
    try {
      const batch = await provider.describeObjects(["memory"], "table");

      expect(batch.truncated).toBeUndefined();
      expect(batch.details.map((detail) => detail.path)).toEqual([
        ["memory", "analytics", "customers"],
        ["memory", "analytics", "events"],
        ["memory", "analytics", "orders"],
        ["memory", "main", "customers"],
        ["memory", "main", "orders"],
        ["memory", "main", "overlap"],
      ]);
      // One mapper serves both reads, so a divergence here is the bulk read spelling a
      // column, an index or a foreign key differently from the single read of the same
      // table - the defect two mappers cause.
      for (const detail of batch.details) {
        expect(detail).toEqual(await provider.describeObject(detail.path, "table"));
      }
    } finally {
      await provider.disconnect();
    }
  });

  test("two same-named tables in two schemas keep their own columns", async () => {
    const provider = await seededObjectProvider();
    try {
      // The catalog-level read spans every schema under the catalog, so this is the case
      // that a join on NAME alone gets wrong: `main.customers` has three columns and
      // `analytics.customers` has one, and a merged answer would be a table with columns
      // it does not have rather than an error anybody would notice.
      const batch = await provider.describeObjects(["memory"], "table");
      const byPath = new Map(batch.details.map((detail) => [detail.path.join("."), detail]));

      expect(byPath.get("memory.main.customers")!.columns.map((column) => column.name)).toEqual(["id", "name", "note"]);
      expect(byPath.get("memory.analytics.customers")!.columns.map((column) => column.name)).toEqual(["event_id"]);
      // And the indexes land on the right table too: both schemas hold an `orders` with
      // an index of the SAME NAME, `ix_orders_customer`, over different columns.
      expect(byPath.get("memory.main.orders")!.indexes).toEqual([
        { name: "ix_orders_customer", columns: ["customer_id"], unique: false },
      ]);
      expect(byPath.get("memory.analytics.orders")!.indexes).toEqual([
        { name: "ix_orders_customer", columns: ["id"], unique: false },
      ]);
    } finally {
      await provider.disconnect();
    }
  });

  test("a SCHEMA-level read answers that schema only, and the other catalog is never merged in", async () => {
    const provider = await seededObjectProvider();
    try {
      const batch = await provider.describeObjects(["memory", "main"], "table");

      expect(batch.details.map((detail) => detail.path)).toEqual([
        ["memory", "main", "customers"],
        ["memory", "main", "orders"],
        ["memory", "main", "overlap"],
      ]);
      // `warehouse.main.customers` holds one column called `sku` and shares both the
      // schema name and the table name with `memory.main.customers`. A detail read that
      // dropped `database_name = $1` would report a table with columns from both.
      expect(batch.details[0]!.columns.map((column) => column.name)).toEqual(["id", "name", "note"]);
    } finally {
      await provider.disconnect();
    }
  });

  test("a view is described from the same statements a table is", async () => {
    const provider = await seededObjectProvider();
    try {
      const batch = await provider.describeObjects(["memory", "main"], "view");

      expect(batch.details.map((detail) => detail.path)).toEqual([["memory", "main", "customer_names"]]);
      expect(batch.details[0]!.columns.map((column) => column.name)).toEqual(["name"]);
      expect(batch.details[0]!.indexes).toEqual([]);
      expect(batch.details[0]!.foreignKeys).toEqual([]);
    } finally {
      await provider.disconnect();
    }
  });

  test("a macro and a sequence answer an empty batch with no round trip at all", async () => {
    const provider = await seededObjectProvider();
    try {
      const sent = recordStatements(provider);

      await expect(provider.describeObjects(["memory"], "macro")).resolves.toEqual({ details: [] });
      await expect(provider.describeObjects(["memory"], "sequence")).resolves.toEqual({ details: [] });

      // Not "no rows came back": no statement was sent. Measured on DuckDB v1.5.5,
      // `duckdb_columns()` holds no row at all for a sequence or a macro, so neither kind
      // has columns on this engine and that is a fact about the KIND, answered from the
      // declaration.
      expect(sent).toEqual([]);
      // The control: a kind that DOES have columns still reaches the engine.
      await provider.describeObjects(["memory"], "view");
      expect(sent.length).toBeGreaterThan(0);
    } finally {
      await provider.disconnect();
    }
  });

  test("an undeclared kind raises, naming the engine and the kind", async () => {
    const provider = await seededObjectProvider();
    try {
      await expect(provider.describeObjects(["memory"], "trigger")).rejects.toThrow(
        /DuckDB declares no object kind "trigger"/,
      );
    } finally {
      await provider.disconnect();
    }
  });

  test("a container path of the wrong shape raises through the declaration, not a literal depth", async () => {
    const provider = await seededObjectProvider();
    try {
      await expect(provider.describeObjects([], "table")).rejects.toThrow(
        /A DuckDB container path is \[database\] or \[database, schema\], received \[\]/,
      );
      await expect(provider.describeObjects(["memory", "main", "orders"], "table")).rejects.toThrow(
        /A DuckDB container path is \[database\] or \[database, schema\]/,
      );
    } finally {
      await provider.disconnect();
    }
  });

  test("the container levels are read BY NAME, so reversing the declaration reverses the binds", async () => {
    // Standing ruling 5g driven to a VALUE against a live engine. The declaration is the
    // same two levels in the opposite order, so `container[0]` is now the SCHEMA: a
    // positional read binds `main` as the catalog and answers nothing, while a read by
    // level binds the same pair the right way round and the engine answers the same three
    // tables.
    const provider = await seededObjectProvider();
    try {
      spyOn(provider, "getCapabilities").mockReturnValue({
        ...provider.getCapabilities(),
        containerLevels: [
          { id: "schema", label: "Schema", labelPlural: "Schemas" },
          { id: "catalog", label: "Database", labelPlural: "Databases" },
        ],
      });

      const batch = await provider.describeObjects(["main", "memory"], "table");

      expect(batch.details.map((detail) => detail.path)).toEqual([
        ["main", "memory", "customers"],
        ["main", "memory", "orders"],
        ["main", "memory", "overlap"],
      ]);
      expect(batch.details[0]!.columns.map((column) => column.name)).toEqual(["id", "name", "note"]);
    } finally {
      await provider.disconnect();
    }
  });

  test("a limit that is not a positive whole number raises rather than clamping", async () => {
    const provider = await seededObjectProvider();
    try {
      for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(provider.describeObjects(["memory"], "table", limit)).rejects.toThrow(
          /A DuckDB bulk column read limit must be a positive whole number/,
        );
      }
    } finally {
      await provider.disconnect();
    }
  });

  test("a bound that bites reports the caller's own limit, and one that does not never reports", async () => {
    const provider = await seededObjectProvider();
    try {
      const bounded = await provider.describeObjects(["memory"], "table", 2);
      expect(bounded.details.map((detail) => detail.path)).toEqual([
        ["memory", "analytics", "customers"],
        ["memory", "analytics", "events"],
      ]);
      expect(bounded.truncated?.limit).toBe(2);
      expect(bounded.truncated?.reason.length).toBeGreaterThan(0);
      // Every bounded detail is complete, not a stub: the bound cuts OBJECTS and never
      // columns.
      expect(bounded.details[0]!.columns.map((column) => column.name)).toEqual(["event_id"]);

      // Exactly as many as the folder holds: `limit + 1` is what the statement carries, so
      // a saturated read is told from an exact one with no second count.
      const exact = await provider.describeObjects(["memory"], "table", FIXTURE_CATALOG_COUNTS.table);
      expect(exact.details).toHaveLength(FIXTURE_CATALOG_COUNTS.table);
      expect(exact.truncated).toBeUndefined();

      const unbounded = await provider.describeObjects(["memory"], "table");
      expect(unbounded.details).toHaveLength(FIXTURE_CATALOG_COUNTS.table);
      expect(unbounded.truncated).toBeUndefined();
    } finally {
      await provider.disconnect();
    }
  });

  test("the engine cuts under its own order and the answer is sorted by path, and those are two different orders", async () => {
    // The one probe that separates the two on this engine. DuckDB's `ORDER BY` runs under
    // the UTF-8 BYTE order, where U+E000 (EE 80 80) sorts below U+1F600 (F0 9F 98 80);
    // JavaScript compares UTF-16 code units, where the surrogate 0xD83D sorts below
    // 0xE000. Measured on v1.5.5.
    const provider = new DuckDBProvider(makeConfig());
    await provider.connect();
    try {
      await provider.query('CREATE TABLE "\u{1F600}" (x INTEGER)');
      await provider.query('CREATE TABLE "" (x INTEGER)');

      const engineOrder = await provider.query(
        "SELECT table_name FROM duckdb_tables() WHERE database_name = 'memory' ORDER BY table_name",
      );
      expect(engineOrder.rows.map((row) => (row as { table_name: string }).table_name)).toEqual(["", "\u{1F600}"]);

      const batch = await provider.describeObjects(["memory", "main"], "table");
      expect(batch.details.map((detail) => detail.path)).toEqual([
        ["memory", "main", "\u{1F600}"],
        ["memory", "main", ""],
      ]);

      // And the cut keeps the engine's first, which is the other one.
      const bounded = await provider.describeObjects(["memory", "main"], "table", 1);
      expect(bounded.details.map((detail) => detail.path)).toEqual([["memory", "main", ""]]);
      expect(bounded.truncated?.limit).toBe(1);
    } finally {
      await provider.disconnect();
    }
  });

  test("the round trips are constant in the number of objects", async () => {
    const provider = await seededObjectProvider();
    try {
      const sent = recordStatements(provider);

      const batch = await provider.describeObjects(["memory"], "table");

      // Six objects, five statements: the target read plus the four detail reads. The
      // single read is four statements PER OBJECT, so the alternative here was 24.
      expect(batch.details).toHaveLength(6);
      expect(sent).toHaveLength(5);
    } finally {
      await provider.disconnect();
    }
  });

  test("a composite foreign key is zipped out per column, exactly as the single read does it", async () => {
    const provider = await seededObjectProvider();
    try {
      const batch = await provider.describeObjects(["memory", "main"], "table");
      const orders = batch.details.find((detail) => detail.path[2] === "orders")!;

      expect(orders.foreignKeys).toEqual([
        { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
      ]);
      expect(orders.columns.find((column) => column.name === "id")!.isPrimary).toBe(true);
      expect(orders.columns.find((column) => column.name === "total")!.isPrimary).toBe(false);
    } finally {
      await provider.disconnect();
    }
  });

  test("an empty folder answers an empty batch rather than raising", async () => {
    const provider = await seededObjectProvider();
    try {
      // `warehouse` holds no view at all, and "this container holds none" is a true answer
      // rather than a refusal.
      await expect(provider.describeObjects(["warehouse"], "view")).resolves.toEqual({ details: [] });
    } finally {
      await provider.disconnect();
    }
  });
});

describe("DuckDB object paths are derived from the declaration, never from a position", () => {
  async function crossedProvider(): Promise<DuckDBProvider> {
    const provider = new DuckDBProvider(makeConfig());
    await provider.connect();
    await provider.query("ATTACH ':memory:' AS alpha");
    await provider.query("ATTACH ':memory:' AS beta");
    await provider.query("CREATE SCHEMA alpha.beta");
    await provider.query("CREATE SCHEMA beta.alpha");
    await provider.query("CREATE TABLE alpha.beta.pin (from_alpha_beta INTEGER)");
    await provider.query("CREATE TABLE beta.alpha.pin (from_beta_alpha INTEGER)");
    return provider;
  }

  /** The real declaration, with `containerLevels` replaced and nothing else. */
  function withLevels(provider: DuckDBProvider, containerLevels: ProviderCapabilities["containerLevels"]): void {
    const real = new DuckDBProvider(makeConfig()).getCapabilities();
    spyOn(provider, "getCapabilities").mockReturnValue({ ...real, containerLevels });
  }

  test("the crossed fixture really does hold two different tables at the two spellings", async () => {
    const provider = await crossedProvider();
    try {
      // The control for everything below. Without it a positional read and a derived one
      // could agree by accident, and the pin would certify nothing.
      expect((await provider.describeObject(["alpha", "beta", "pin"], "table")).columns.map((c) => c.name)).toEqual([
        "from_alpha_beta",
      ]);
      expect((await provider.describeObject(["beta", "alpha", "pin"], "table")).columns.map((c) => c.name)).toEqual([
        "from_beta_alpha",
      ]);
    } finally {
      await provider.disconnect();
    }
  });

  test("a declaration listing schema BEFORE catalog moves every read with it", async () => {
    const provider = await crossedProvider();
    try {
      withLevels(provider, [
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
        { id: "catalog", label: "Database", labelPlural: "Databases" },
      ]);

      // `["beta", "alpha", "pin"]` now means schema `beta` in catalog `alpha`, so the
      // object it addresses is `alpha.beta.pin` and its column is `from_alpha_beta`. A
      // provider binding `path[0]` as the catalog answers `from_beta_alpha` here, which is
      // a different real table rather than an error - exactly the silent case this ruling
      // exists for.
      const detail = await provider.describeObject(["beta", "alpha", "pin"], "table");
      expect(detail.columns.map((column) => column.name)).toEqual(["from_alpha_beta"]);

      // The container reads move with it too, and the path a listing CONSTRUCTS is
      // written in the declared order so `describeObject` reads it back as the same
      // object. The round trip is what the conformance helper does.
      expect(await provider.countObjects(["beta", "alpha"])).toMatchObject({ table: { count: 1 } });
      const listed = await provider.listObjects(["beta", "alpha"], "table");
      expect(listed.map((object) => object.path)).toEqual([["beta", "alpha", "pin"]]);
      expect((await provider.describeObject(listed[0].path, "table")).columns.map((c) => c.name)).toEqual([
        "from_alpha_beta",
      ]);

      // And the refusal names the declared LABELS in the declared order, so a person
      // reading it is told the shape this declaration actually accepts.
      await expect(provider.describeObject(["alpha", "pin"], "table")).rejects.toThrow(
        'A DuckDB "table" path is [schema, database, name], received ["alpha","pin"]',
      );
    } finally {
      await provider.disconnect();
    }
  });

  test("container depth is derived, so a ONE-level declaration binds one segment and refuses two", async () => {
    const provider = await crossedProvider();
    try {
      withLevels(provider, [{ id: "catalog", label: "Database", labelPlural: "Databases" }]);

      // Driven to a BOUND VALUE, not to a refusal: at one level the whole catalog is the
      // container, so the count covers both schemas of `alpha` and the listing carries
      // two-segment paths. A provider that cut the path at a literal 2 would bind
      // `schema_name = undefined` and answer nothing.
      await provider.query("CREATE TABLE alpha.main.extra (id INTEGER)");
      expect(await provider.countObjects(["alpha"])).toMatchObject({ table: { count: 2 } });
      expect((await provider.listObjects(["alpha"], "table")).map((object) => object.path)).toEqual([
        ["alpha", "extra"],
        ["alpha", "pin"],
      ]);

      // Nothing nests under the last declared level, whichever level that is.
      expect(await provider.listContainers(["alpha"])).toEqual([]);
      // A two-segment container is now one segment too long, and the message says so in
      // the declaration's own words.
      await expect(provider.countObjects(["alpha", "beta"])).rejects.toThrow(
        'A DuckDB container path is [database], received ["alpha","beta"]',
      );
      // And a detail read has no schema segment to bind at all, so it raises NAMING the
      // level rather than binding `undefined`, which this driver answers with
      // "Cannot create values of type ANY" - a sentence about neither the level nor the
      // path.
      await expect(provider.describeObject(["alpha", "pin"], "table")).rejects.toThrow(
        "DuckDB declares no schema level to read this path's segment from",
      );
    } finally {
      await provider.disconnect();
    }
  });

  test("a declaration carrying MORE levels than the model has is cut to the declared depth", async () => {
    const provider = await crossedProvider();
    try {
      // `containerDepth()` answers at most 2 and is the ONLY reader of how deep a
      // declaration goes (standing ruling 1, #789): `containerLevels.length` is not. A
      // third entry must therefore widen nothing - not the accepted container shapes, not
      // the segment lookup, not the object path. Behaviour-identical to the cut version on
      // every real declaration in the fleet, which is exactly why it needs pinning here.
      withLevels(provider, [
        { id: "catalog", label: "Database", labelPlural: "Databases" },
        { id: "schema", label: "Schema", labelPlural: "Schemas" },
        { id: "schema", label: "Sub-schema", labelPlural: "Sub-schemas" },
      ]);

      await expect(provider.countObjects(["alpha", "beta", "extra"])).rejects.toThrow(
        'A DuckDB container path is [database] or [database, schema], received ["alpha","beta","extra"]',
      );
      // And the reads that DO have a valid shape still answer, so the refusal above is the
      // depth cut rather than the whole declaration being rejected.
      expect(await provider.countObjects(["alpha", "beta"])).toMatchObject({ table: { count: 1 } });
      expect((await provider.listObjects(["alpha", "beta"], "table")).map((object) => object.path)).toEqual([
        ["alpha", "beta", "pin"],
      ]);
      expect(await provider.listContainers(["alpha", "beta"])).toEqual([]);
    } finally {
      await provider.disconnect();
    }
  });

  test("a kind declaring attachedTo is refused, because DuckDB holds no attached object", async () => {
    const provider = await crossedProvider();
    try {
      // DuckDB has no trigger and no other object that hangs off another, and the four
      // statements here address a schema and a name. A provider that produced the extra
      // segment anyway would draw a folder whose every path resolves to nothing, so the
      // refusal names the declaration rather than the read.
      const real = new DuckDBProvider(makeConfig()).getCapabilities();
      spyOn(provider, "getCapabilities").mockReturnValue({
        ...real,
        objectKinds: [
          { id: "trigger", role: "attached", label: "Trigger", labelPlural: "Triggers", attachedTo: "table" },
        ],
      });
      await expect(provider.describeObject(["alpha", "beta", "pin", "stamp"], "trigger")).rejects.toThrow(
        'DuckDB holds no object attached to another, so the kind "trigger" cannot declare attachedTo "table"',
      );
    } finally {
      await provider.disconnect();
    }
  });

  test("a declaration with NO container level refuses every container path", async () => {
    const provider = await crossedProvider();
    try {
      withLevels(provider, []);
      // `containerDepth()` reads absent and empty as the same zero, so there is no shape
      // at all and the message says so rather than accepting `[]` as "the root".
      await expect(provider.countObjects([])).rejects.toThrow(
        "A DuckDB container path is nothing: this declaration carries no container level, received []",
      );
      expect(await provider.listContainers(["alpha"])).toEqual([]);
    } finally {
      await provider.disconnect();
    }
  });
});

/**
 * Standing ruling 5a (#789): the macro vocabulary enumerates the ENGINE, not the fixture.
 *
 * Task 10 derived a `TABLE_TYPE` vocabulary from `SELECT DISTINCT` over its own fixture,
 * and a spelling the engine can produce that the fixture lacked fell out of the count AND
 * the listing together - so ruling 5f still held while the object was invisible in the
 * tree. Here the vocabulary comes from DuckDB's two documented macro forms, and this test
 * is the guard that it still accounts for every `function_type` the engine publishes.
 *
 * The engine is embedded, so this needs no separate live script the way MySQL's
 * `CATALOG_TYPE_RULES` does: the instance under test IS the live server, and it ships
 * ~2950 built-in functions covering every `function_type` DuckDB has.
 */
describe("the macro vocabulary against duckdb_functions()", () => {
  test("every function_type the engine publishes is either a macro form or an explained exclusion", async () => {
    const provider = await seededObjectProvider();
    try {
      const result = await provider.query("SELECT DISTINCT function_type FROM duckdb_functions() ORDER BY 1");
      const live = result.rows.map((row) => (row as { function_type: string }).function_type);

      // Non-vacuity: the engine really did answer, and it really does carry both macro
      // forms - the fixture's own `add_one` is a scalar macro and `recent_events` a table
      // macro, so neither arm can rot into the other unnoticed.
      expect(live.length).toBeGreaterThan(4);
      expect(live).toContain("macro");
      expect(live).toContain("table_macro");

      const accounted = [...FUNCTION_TYPE_RULES.macros, ...Object.keys(FUNCTION_TYPE_RULES.excluded)];
      expect([...live].sort()).toEqual([...accounted].sort());
      // The two halves are disjoint, so a spelling cannot be counted and excluded at once.
      expect(FUNCTION_TYPE_RULES.macros.filter((type) => type in FUNCTION_TYPE_RULES.excluded)).toEqual([]);
      // Every exclusion carries a reason rather than sitting in a bare list.
      for (const reason of Object.values(FUNCTION_TYPE_RULES.excluded)) expect(reason.length).toBeGreaterThan(10);
    } finally {
      await provider.disconnect();
    }
  });

  test("a built-in function is never listed as a macro of a user catalog", async () => {
    const provider = await seededObjectProvider();
    try {
      // Every one of DuckDB's own functions lives in the `system` catalog, which is what
      // makes the `database_name` filter sufficient and the macro read need no `internal`
      // predicate of its own. Measured here rather than claimed.
      const elsewhere = await provider.query(
        "SELECT COUNT(*) AS n FROM duckdb_functions() WHERE internal AND database_name <> 'system'",
      );
      expect(elsewhere.rows).toEqual([{ n: "0" }]);
      // The control: there really are thousands of internal functions to have leaked.
      const internal = await provider.query("SELECT COUNT(*) AS n FROM duckdb_functions() WHERE internal");
      expect(Number((internal.rows[0] as { n: string }).n)).toBeGreaterThan(2000);

      expect((await provider.listObjects(["memory"], "macro")).map((object) => object.name)).toEqual([
        "recent_events",
        "add_one",
        "overlap",
      ]);
    } finally {
      await provider.disconnect();
    }
  });
});

/**
 * Three facts the fixture cannot distinguish, asserted on the STATEMENT instead.
 *
 * Each one is a predicate that is redundant against THIS engine's data and load-bearing
 * against the engine's contract, which is exactly the case standing ruling 5g's last
 * paragraph asks to be stated rather than reported as an unavailable mutation.
 */
describe("DuckDB object statements: what the fixture cannot show", () => {
  const KINDS = [
    { id: "table", role: "relation" as const, label: "Table", labelPlural: "Tables" },
    { id: "macro", role: "routine" as const, label: "Macro", labelPlural: "Macros" },
  ];

  test("the macro reads carry the function_type vocabulary, in the count and in the listing alike", () => {
    // DuckDB has no CREATE FUNCTION, so every non-internal `duckdb_functions()` row in a
    // user catalog is already a macro and dropping this predicate changes no count the
    // fixture can produce. It stays because the vocabulary is what ruling 5a is about: it
    // is the only thing that would keep a future non-macro user function out of the Macros
    // folder, and it is what makes the two macro FORMS explicit rather than incidental.
    const expected = "function_type IN ('macro', 'table_macro')";
    expect(listObjectsSql("macro", false)).toContain(expected);
    expect(listObjectsSql("macro", true)).toContain(expected);
    expect(countsSql(KINDS, false)).toContain(expected);
    expect(countsSql(KINDS, true)).toContain(expected);
    // And it is the MACRO arm that carries it, not every arm: the table arm has no
    // function_type at all, so the assertion above cannot be satisfied by a predicate
    // pasted across the whole statement.
    const tableArm = countsSql(KINDS, false).split("UNION ALL")[0];
    expect(tableArm).toContain("duckdb_tables()");
    expect(tableArm).not.toContain("function_type");
  });

  test("the counts statement binds one catalog once, across every arm", () => {
    // The numbered form is why: `$1` reused across a UNION ALL takes ONE parameter, while
    // a positional `?` would need one copy per arm and the arity would shift silently the
    // moment a kind was added or removed.
    const sql = countsSql(KINDS, true);
    expect(sql.match(/\$1/g)).toHaveLength(2);
    expect(sql.match(/\$2/g)).toHaveLength(2);
    expect(sql).not.toContain("?");
    expect(countsSql(KINDS, false)).not.toContain("$2");
  });

  test("the bulk target orders by schema and name, which no fixture on this engine can prove", () => {
    // Standing ruling 5a asks for the fixture that would DISPROVE a statement-shape pin
    // before the pin is accepted. It was built and it does not disprove it: five tables
    // created in the order `main.zz, main.aa, analytics.mm, analytics.bb, main.cc` come
    // back from a bare `SELECT ... FROM duckdb_tables()` as
    // `analytics.bb, analytics.mm, main.aa, main.cc, main.zz`, because DuckDB walks its
    // catalog's sorted maps. So no data this engine can hold separates the ordered
    // statement from the unordered one, and the `ORDER BY` is pinned by TEXT.
    //
    // It stays because the order is what decides WHICH objects a bound keeps, and the
    // natural order is an implementation detail of the catalog rather than a promise.
    for (const bySchema of [false, true]) {
      expect(bulkTargetSql("table", bySchema, false)).toContain("ORDER BY schema_name, name");
      expect(bulkTargetSql("table", bySchema, true)).toContain("ORDER BY schema_name, name");
    }
    // The LIMIT placeholder takes the next free number after the container binds, which is
    // one at catalog level and two at schema level.
    expect(bulkTargetSql("table", false, true)).toContain("LIMIT $2");
    expect(bulkTargetSql("table", true, true)).toContain("LIMIT $3");
    expect(bulkTargetSql("table", false, false)).not.toContain("LIMIT");
  });

  test("the column read orders by column_index, which no fixture can prove", () => {
    // DuckDB happens to answer `duckdb_columns()` in column order for a freshly written
    // table, so dropping this ORDER BY breaks nothing measurable here. A table whose
    // columns were rewritten by ALTER would be a different matter, and a detail row that
    // lists a table's columns in an arbitrary order is wrong however stable the accident.
    expect(OBJECT_COLUMNS_SQL).toContain("ORDER BY column_index");
  });

  test("every declared kind is seeded at zero before any row is read", () => {
    // Asserted DIRECTLY, because this engine's counts statement cannot lose an arm: a
    // `UNION ALL` of `COUNT(*)` answers exactly one row per arm whether the container
    // holds anything or not, so no live read here can distinguish a seeded record from an
    // unseeded one. The seed is standing ruling 4's requirement all the same - a declared
    // kind missing from `countObjects` draws NO FOLDER, which is a different and stronger
    // statement than a folder badged 0 - and it is what an engine or a statement shape
    // that does skip empty groups would need.
    expect(seedZeroCounts(KINDS)).toEqual({ table: { count: 0 }, macro: { count: 0 } });
    expect(seedZeroCounts([])).toEqual({});
  });

  test("a count the driver cannot read leaves its seeded value rather than writing NaN", () => {
    // The `toNumber` seam is injected precisely so this can be driven: a DuckDB COUNT(*)
    // is BIGINT and arrives as a decimal STRING through `getRowObjectsJson()`, so no live
    // read can produce an unreadable one. A driver change that did would otherwise write
    // `Number(undefined)`, and NaN renders as a blank badge that looks like a measurement.
    const counts = { table: { count: 0 }, macro: { count: 0 } };
    applyKindCounts(
      counts,
      [
        { kind: "table", n: "7" },
        { kind: "macro", n: null },
      ],
      (value) => (typeof value === "string" ? Number(value) : undefined),
    );
    expect(counts).toEqual({ table: { count: 7 }, macro: { count: 0 } });
  });
});
