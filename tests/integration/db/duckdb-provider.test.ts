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

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBProvider, assertReadOnlyStatementIsBounded } from "@/lib/db/providers/sql/duckdb";
import type { DatabaseConnection } from "@/lib/types";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import { ConnectionError, DatabaseConfigError, ExecutionProfileError, QueryError } from "@/lib/db/errors";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";

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

describe("getSchema()", () => {
  let provider: DuckDBProvider;

  afterEach(async () => {
    if (provider?.isConnected()) await provider.disconnect();
  });

  test("lists tables and views across schemas, qualifying everything outside main", async () => {
    provider = await seededMemoryProvider();

    const schema = await provider.getSchema();

    expect(schema.map((entry) => entry.name).sort()).toEqual([
      "analytics.events",
      "customer_totals",
      "customers",
      "orders",
    ]);
  });

  test("columns carry DuckDB's own type text, nullability, primary keys and defaults", async () => {
    provider = await seededMemoryProvider();

    const customers = (await provider.getSchema()).find((entry) => entry.name === "customers");

    expect(customers?.columns).toEqual([
      { name: "id", type: "INTEGER", nullable: false, isPrimary: true },
      { name: "name", type: "VARCHAR", nullable: false, isPrimary: false },
      { name: "email", type: "VARCHAR", nullable: true, isPrimary: false },
      { name: "signed_up_at", type: "TIMESTAMP", nullable: true, isPrimary: false, defaultValue: "now()" },
    ]);
  });

  test("nested types keep their full DuckDB spelling", async () => {
    provider = await seededMemoryProvider();

    const events = (await provider.getSchema()).find((entry) => entry.name === "analytics.events");

    expect(events?.columns.map((column) => column.type)).toEqual(["BIGINT", "VARCHAR[]", 'STRUCT("source" VARCHAR)']);
  });

  test("the row count comes from estimated_size, which IS a row count", async () => {
    // It is NOT a byte size, and presenting it as one is the fabrication this provider
    // was built to avoid.
    provider = await seededMemoryProvider();

    const customers = (await provider.getSchema()).find((entry) => entry.name === "customers");

    expect(customers?.rowCount).toBe(2);
  });

  test("foreign keys carry their referenced table and column", async () => {
    provider = await seededMemoryProvider();

    const orders = (await provider.getSchema()).find((entry) => entry.name === "orders");

    expect(orders?.foreignKeys).toEqual([
      { columnName: "customer_id", referencedTable: "customers", referencedColumn: "id" },
    ]);
  });

  test("indexes carry their key columns as a real list", async () => {
    provider = await seededMemoryProvider();

    const orders = (await provider.getSchema()).find((entry) => entry.name === "orders");

    expect(orders?.indexes.map((index) => index.columns)).toContainEqual(["customer_id"]);
  });

  test("a view is listed with its columns and no row count", async () => {
    provider = await seededMemoryProvider();

    const view = (await provider.getSchema()).find((entry) => entry.name === "customer_totals");

    expect(view?.rowCount).toBeUndefined();
    expect(view?.columns.map((column) => column.name)).toEqual(["name", "revenue"]);
  });

  test("getTables() names every object the tree lists", async () => {
    provider = await seededMemoryProvider();

    expect((await provider.getTables()).sort()).toEqual(["analytics.events", "customer_totals", "customers", "orders"]);
  });
});

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
    expect(main.location).toBe(dbPath);
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
