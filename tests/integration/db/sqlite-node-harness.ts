/**
 * Node-runtime harness for the SQLite provider integration tests.
 *
 * Bun cannot load any non-bun SQLite driver in-process (it refuses
 * better-sqlite3 and does not implement node:sqlite), so the node driver
 * path (LIBREDB_SQLITE_DRIVER=node -> node:sqlite) is exercised in a real
 * `node` subprocess: sqlite-provider.test.ts bundles this file with
 * `bun build --target=node` and runs the bundle with `node <bundle> <db-path>`.
 *
 * The harness runs the core CRUD / schema / maintenance / error-mapping
 * cases against a real on-disk database file and prints a JSON report to
 * stdout for the test to assert on. Any failure exits non-zero.
 */

import { SQLiteProvider } from "../../../src/lib/db/providers/sql/sqlite";
import type { DatabaseConnection } from "../../../src/lib/types";

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  if (!dbPath) {
    throw new Error("usage: node sqlite-node-harness.mjs <db-path>");
  }

  const config: DatabaseConnection = {
    id: "node-driver-harness",
    name: "Node Driver Harness",
    type: "sqlite",
    database: dbPath,
    createdAt: new Date(),
  };

  const report: Record<string, unknown> = {
    runtime: typeof Bun === "undefined" ? "node" : "bun",
    driverEnv: process.env.LIBREDB_SQLITE_DRIVER ?? null,
  };

  const provider = new SQLiteProvider(config);

  // Connect
  await provider.connect();
  report.connected = provider.isConnected();

  // DDL + CRUD (with positional params)
  await provider.query("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)");
  await provider.query("CREATE INDEX idx_users_email ON users(email)");
  await provider.query("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, user_id INTEGER REFERENCES users(id))");

  const insert = await provider.query("INSERT INTO users (id, name, email) VALUES (?, ?, ?)", [
    1,
    "Alice",
    "alice@example.com",
  ]);
  report.insertRowCount = insert.rowCount;

  await provider.query("INSERT INTO users (id, name, email) VALUES (2, 'Bob', 'bob@example.com')");

  const select = await provider.query("SELECT * FROM users ORDER BY id");
  report.selectRows = select.rows;
  report.selectFields = select.fields;

  const update = await provider.query("UPDATE users SET name = ? WHERE id = ?", ["Bobby", 2]);
  report.updateRowCount = update.rowCount;

  const del = await provider.query("DELETE FROM users WHERE id = ?", [2]);
  report.deleteRowCount = del.rowCount;

  // Schema introspection
  const schema = await provider.getSchema();
  report.schema = schema.map((table) => ({
    name: table.name,
    rowCount: table.rowCount,
    columns: table.columns.map((c) => ({ name: c.name, isPrimary: c.isPrimary, nullable: c.nullable })),
    indexes: table.indexes.map((i) => i.name),
    foreignKeys: table.foreignKeys,
  }));

  // Maintenance
  const check = await provider.runMaintenance("check");
  report.maintenanceCheck = { success: check.success, message: check.message };
  const vacuum = await provider.runMaintenance("vacuum");
  report.vacuumSuccess = vacuum.success;

  // Monitoring
  const overview = await provider.getOverview();
  report.version = overview.version;
  report.tableCount = overview.tableCount;

  const health = await provider.getHealth();
  report.integrity = health.slowQueries.find((q) => q.query.includes("Integrity"))?.query ?? null;

  // Error mapping (same QueryError mapping as the bun driver)
  try {
    await provider.query("SELECT * FROM missing_table");
    report.queryErrorName = null;
  } catch (error) {
    report.queryErrorName = error instanceof Error ? error.constructor.name : typeof error;
    report.queryErrorMessage = error instanceof Error ? error.message : String(error);
  }

  await provider.disconnect();
  report.disconnected = !provider.isConnected();

  console.log(JSON.stringify(report));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
