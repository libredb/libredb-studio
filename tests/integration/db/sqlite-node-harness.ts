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

import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { SQLiteProvider } from "../../../src/lib/db/providers/sql/sqlite";
import type { DatabaseConnection } from "../../../src/lib/types";
import type { ReadOnlyStatementBudget } from "../../../src/lib/db/types";

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

  // Per-table sizes, which on this driver come from the dbstat virtual table.
  const tableStats = await provider.getTableStats();
  report.tableStats = tableStats.map((t) => ({
    tableName: t.tableName,
    rowCount: t.rowCount,
    tableSize: t.tableSize ?? null,
    tableSizeBytes: t.tableSizeBytes ?? null,
    indexSizeBytes: t.indexSizeBytes ?? null,
    totalSize: t.totalSize,
    totalSizeBytes: t.totalSizeBytes,
  }));

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

  await runAgentReadOnlyProfile(dbPath, report);

  console.log(JSON.stringify(report));
}

/**
 * Agent read-only execution profile contract (#328) on the node:sqlite
 * adapter. The bun adapter is covered in-process by sqlite-provider.test.ts;
 * these are the same behavioral assertions run against the real node driver,
 * because an adapter that accepts the read-only open flag and ignores it would
 * otherwise hand the agent a fully writable handle and no in-process test
 * could see it.
 */
async function runAgentReadOnlyProfile(dbPath: string, report: Record<string, unknown>): Promise<void> {
  const budget: ReadOnlyStatementBudget = {
    statementTimeoutMs: 5_000,
    maxResultRows: 100,
    maxResultBytes: 64 * 1024,
  };
  const agentConfig: DatabaseConnection = {
    id: "node-driver-harness-agent",
    name: "Node Driver Harness (agent read-only)",
    type: "sqlite",
    database: dbPath,
    createdAt: new Date(),
  };

  const agent = new SQLiteProvider(agentConfig, {}, { readOnly: true });
  await agent.connect();
  report.agentConnected = agent.isConnected();

  // query_only must be verified at open — a read-only open does not imply it.
  report.agentQueryOnly = (await agent.queryReadOnly("PRAGMA query_only", budget)).rows;

  // A legitimate read still works.
  report.agentSelectRows = (await agent.queryReadOnly("SELECT id, name FROM users ORDER BY id", budget)).rows;

  // prepare() compiles one statement and drops the tail on this adapter too;
  // the verification read below proves the smuggled insert never ran.
  report.agentMultiStatementRows = (
    await agent.queryReadOnly("SELECT id FROM users; INSERT INTO users (id, name) VALUES (97, 'tail')", budget)
  ).rows;

  // Write and schema change: rejected by the database, not by a classifier.
  report.agentWriteRejected = await rejects(() =>
    agent.queryReadOnly("INSERT INTO users (id, name) VALUES (99, 'agent')", budget),
  );
  report.agentSchemaChangeRejected = await rejects(() =>
    agent.queryReadOnly("CREATE TABLE injected (id INTEGER)", budget),
  );

  // A statement that disables query_only must not leave it disabled for the
  // next one — the provider is pooled and reused across an agent run.
  await agent.queryReadOnly("PRAGMA query_only = false", budget);
  report.agentQueryOnlyAfterDisable = (await agent.queryReadOnly("PRAGMA query_only", budget)).rows;
  report.agentWriteRejectedAfterDisable = await rejects(() =>
    agent.queryReadOnly("INSERT INTO users (id, name) VALUES (98, 'bypass')", budget),
  );

  // The read-only open governs the target file only; VACUUM INTO writes to
  // ANOTHER file and is refused by query_only. The engine still creates the
  // target before refusing, so assert on content, not existence.
  const stolen = join(dirname(dbPath), "node-agent-stolen.db");
  await agent.queryReadOnly("PRAGMA query_only = false", budget);
  report.agentVacuumIntoRejected = await rejects(() => agent.queryReadOnly(`VACUUM INTO '${stolen}'`, budget));
  report.agentStolenBytes = existsSync(stolen) ? statSync(stolen).size : 0;

  await agent.disconnect();

  // Nothing landed: re-read with a writable handle.
  const verifier = new SQLiteProvider({ ...agentConfig, id: "node-driver-harness-verify" });
  await verifier.connect();
  report.agentRowsAfterRejectedWrites = (await verifier.query("SELECT id, name FROM users ORDER BY id")).rows;
  report.agentTablesAfterRejectedWrites = (
    await verifier.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  ).rows;
  await verifier.disconnect();

  // A missing file in an EXISTING directory must not be created (the shared
  // editor path would create it), and a missing directory must not be either.
  const missingFile = join(dirname(dbPath), "node-agent-never-created.db");
  const missingFileProvider = new SQLiteProvider(
    { ...agentConfig, id: "node-driver-harness-missing-file", database: missingFile },
    {},
    { readOnly: true },
  );
  report.agentMissingOpenRejected = await rejects(() => missingFileProvider.connect());
  report.agentMissingFileCreated = existsSync(missingFile);

  const missingDir = join(dirname(dbPath), "node-agent-not-created");
  const missingDirProvider = new SQLiteProvider(
    { ...agentConfig, id: "node-driver-harness-missing-dir", database: join(missingDir, "absent.db") },
    {},
    { readOnly: true },
  );
  report.agentMissingDirOpenRejected = await rejects(() => missingDirProvider.connect());
  report.agentMissingDirCreated = existsSync(missingDir);
}

/** True when the thunk rejects; false when it resolves. */
async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
