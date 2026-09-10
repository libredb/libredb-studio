/**
 * Opt-in live regression for #284. Requires disposable SQL Server and Oracle servers.
 * Run with Bun; connection variables are documented in docs/SCHEMA_DIFF.md.
 * Each probe owns a fresh database/schema and removes it in finally.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import mssql from "mssql";
import oracledb from "oracledb";
import { generateMigrationSQL } from "../../src/lib/schema-diff/migration-generator";
import type { SchemaDiff, TableDiff } from "../../src/lib/schema-diff/types";
import { splitStatements } from "../../src/lib/sql/statement-splitter";
import { resolveSqlGrammar } from "../../src/lib/sql/grammar";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} for the disposable test server.`);
  return value;
}

function change(table: Partial<TableDiff>): SchemaDiff {
  return {
    hasChanges: true,
    summary: { added: 1, removed: 1, modified: 1 },
    tables: [{ action: "modified", tableName: "items", columns: [], indexes: [], foreignKeys: [], ...table }],
  };
}

async function probe(
  dialect: "mssql" | "oracle",
  run: (sql: string) => Promise<unknown>,
  scalar: (sql: string) => Promise<unknown>,
): Promise<void> {
  const q = (name: string) =>
    dialect === "mssql" ? `[${name.replaceAll("]", "]]")}]` : `"${name.replaceAll('"', '""')}"`;
  const generated = async (table: Partial<TableDiff>) => {
    const sql = generateMigrationSQL(change(table), dialect);
    for (const statement of splitStatements(sql, resolveSqlGrammar(dialect))) {
      // oxlint-disable-next-line no-await-in-loop -- DDL depends on earlier statements in the same session.
      await run(statement.sql.replace(/;\s*$/, ""));
    }
    return sql;
  };
  await run(`CREATE TABLE ${q("parent")} (${q("id")} INTEGER PRIMARY KEY)`);
  await run(`INSERT INTO ${q("parent")} VALUES (1)`);
  await generated({
    action: "added",
    columns: [
      {
        action: "added",
        columnName: "id",
        targetType: "INTEGER",
        targetNullable: false,
        targetIsPrimary: true,
        changes: [],
      },
      { action: "added", columnName: "old", targetType: "INTEGER", changes: [] },
      {
        action: "added",
        columnName: "n",
        targetType: "INTEGER",
        targetDefault: "42",
        targetNullable: false,
        changes: [],
      },
    ],
    indexes: [{ action: "added", indexName: "idx_old", targetColumns: ["old"], changes: [] }],
    foreignKeys: [
      {
        action: "added",
        columnName: "old",
        targetReferencedTable: "parent",
        targetReferencedColumn: "id",
        changes: [],
      },
    ],
  });
  await run(`INSERT INTO ${q("items")} (${q("id")}, ${q("old")}) VALUES (1, 1)`);
  assert.equal(Number(await scalar(`SELECT ${q("n")} FROM ${q("items")}`)), 42);
  await assert.rejects(() => run(`INSERT INTO ${q("items")} (${q("id")}, ${q("n")}) VALUES (2, NULL)`));
  await assert.rejects(() => run(`INSERT INTO ${q("items")} (${q("id")}, ${q("old")}) VALUES (3, 99)`));

  // Mutation controls: the old emitted forms must fail against the same live server.
  await assert.rejects(() => run(`ALTER TABLE ${q("items")} ADD COLUMN ${q("extra")} INTEGER`));
  await assert.rejects(() => run("BEGIN"));
  if (dialect === "mssql") {
    await assert.rejects(() => run(`DROP INDEX IF EXISTS ${q("idx_old")}`));
    await assert.rejects(() => run(`ALTER TABLE ${q("items")} DROP COLUMN ${q("old")}`));
  } else {
    await assert.rejects(() => run(`ALTER TABLE ${q("items")} ADD (${q("extra")} INTEGER NOT NULL DEFAULT 7)`));
  }

  // Remove an indexed FK column and replace its index name on the newly added column.
  await generated({
    columns: [
      { action: "removed", columnName: "old", changes: [] },
      {
        action: "added",
        columnName: "extra",
        targetType: "INTEGER",
        targetDefault: "7",
        targetNullable: false,
        changes: [],
      },
    ],
    indexes: [
      { action: "modified", indexName: "idx_old", sourceColumns: ["old"], targetColumns: ["extra"], changes: [] },
    ],
    foreignKeys: [{ action: "removed", columnName: "old", changes: [] }],
  });
  assert.equal(Number(await scalar(`SELECT ${q("extra")} FROM ${q("items")}`)), 7);
  assert.equal(Number(await scalar(`SELECT COUNT(*) FROM ${q("items")}`)), 1);
  await assert.rejects(() => run(`SELECT ${q("old")} FROM ${q("items")}`));

  // A uniqueness-only diff must replace the index and enforce the new rule.
  await generated({
    indexes: [
      {
        action: "modified",
        indexName: "idx_old",
        sourceColumns: ["extra"],
        targetColumns: ["extra"],
        sourceUnique: false,
        targetUnique: true,
        changes: [],
      },
    ],
  });
  await assert.rejects(() => run(`INSERT INTO ${q("items")} (${q("id")}, ${q("extra")}) VALUES (2, 7)`));

  // Newlines and quote delimiters in metadata must stay inside identifiers, never
  // turn the generator's informational comment into an executable DELETE.
  const attack = dialect === "mssql" ? 'x"\nDELETE FROM "items";\n--]' : "x\nDELETE FROM items;\n--]";
  await run(`CREATE TABLE ${q(attack)} (${q("id")} INTEGER)`);
  await generated({
    tableName: attack,
    columns: [{ action: "added", columnName: dialect === "mssql" ? 'n"]' : "n]", targetType: "INTEGER", changes: [] }],
  });
  assert.equal(Number(await scalar(`SELECT COUNT(*) FROM ${q("items")}`)), 1);
  await generated({ tableName: attack, action: "removed" });

  // Transaction semantics, not just parser acceptance.
  if (dialect === "mssql") {
    await run("BEGIN TRANSACTION");
    await run(`CREATE TABLE ${q("rollback_probe")} (${q("id")} INTEGER)`);
    await run("ROLLBACK");
    assert.equal(Number(await scalar("SELECT COUNT(*) FROM sys.tables WHERE name = 'rollback_probe'")), 0);
  } else {
    await run(`CREATE TABLE ${q("commit_probe")} (${q("id")} INTEGER)`);
    await run("ROLLBACK");
    assert.equal(Number(await scalar("SELECT COUNT(*) FROM user_tables WHERE table_name = 'commit_probe'")), 1);
    await run(`DROP TABLE ${q("commit_probe")}`);
  }
  await generated({ action: "removed" });
  await run(`DROP TABLE ${q("parent")}`);
  console.log(`${dialect}: live DDL, data/defaults, dependency order, quoted metadata and transaction probes passed`);
}

const engine = required("MIGRATION_PROBE_ENGINE");
const suffix = randomBytes(5).toString("hex");
if (engine === "mssql") {
  const config = {
    server: "127.0.0.1",
    port: Number(required("MSSQL_TEST_PORT")),
    user: "sa",
    password: required("MSSQL_TEST_PASSWORD"),
    options: { trustServerCertificate: true, encrypt: false },
    // One physical connection: transaction statements must share a session.
    pool: { min: 1, max: 1 },
  };
  const admin = await new mssql.ConnectionPool(config).connect();
  const database = `migration_probe_${suffix}`;
  let connection: mssql.ConnectionPool | undefined;
  try {
    console.log((await admin.request().query("SELECT @@VERSION AS version")).recordset[0].version);
    await admin.request().query(`CREATE DATABASE [${database}]`);
    connection = await new mssql.ConnectionPool({ ...config, database }).connect();
    const db = connection;
    await probe(
      "mssql",
      (sql) => db.request().batch(sql),
      async (sql) => Object.values((await db.request().query(sql)).recordset[0])[0],
    );
  } finally {
    await connection?.close();
    await admin.request().query(`IF DB_ID('${database}') IS NOT NULL DROP DATABASE [${database}]`);
    await admin.close();
  }
} else if (engine === "oracle") {
  const connectString = `127.0.0.1:${required("ORACLE_TEST_PORT")}/FREEPDB1`;
  const adminPool = await oracledb.createPool({
    user: "system",
    password: required("ORACLE_TEST_PASSWORD"),
    connectString,
    poolMin: 0,
    poolMax: 1,
  });
  const admin = await adminPool.getConnection();
  const user = `PROBE_${suffix.toUpperCase()}`;
  const password = `Probe${randomBytes(12).toString("hex")}`;
  let connection: oracledb.Connection | undefined;
  let pool: oracledb.Pool | undefined;
  let created = false;
  try {
    console.log((await admin.execute("SELECT banner_full FROM v$version")).rows);
    await admin.execute(`CREATE USER ${user} IDENTIFIED BY "${password}" QUOTA UNLIMITED ON USERS`);
    created = true;
    await admin.execute(`GRANT CREATE SESSION, CREATE TABLE TO ${user}`);
    pool = await oracledb.createPool({ user, password, connectString, poolMin: 0, poolMax: 1 });
    connection = await pool.getConnection();
    const db = connection;
    await probe(
      "oracle",
      (sql) => db.execute(sql),
      async (sql) => ((await db.execute(sql)).rows as unknown[][])[0][0],
    );
  } finally {
    await connection?.close();
    await pool?.close(0);
    if (created) await admin.execute(`DROP USER ${user} CASCADE`);
    await admin.close();
    await adminPool.close(0);
  }
} else {
  throw new Error("MIGRATION_PROBE_ENGINE must be mssql or oracle");
}
