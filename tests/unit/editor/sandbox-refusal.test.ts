import { describe, test, expect } from "bun:test";
import { sandboxRefusal } from "@/lib/editor/sandbox-refusal";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { MySQLProvider } from "@/lib/db/providers/sql/mysql";
import { PostgresProvider } from "@/lib/db/providers/sql/postgres";
import { OracleProvider } from "@/lib/db/providers/sql/oracle";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";

/**
 * SANDBOX promises a rollback, so a statement that ends the transaction it runs in must
 * never reach the server under it. Measured 2026-10-04 on MySQL 26.7.0: a SANDBOX
 * `CREATE TABLE` left the table behind under "Changes auto-rolled back. No data was modified."
 */

function connection(type: DatabaseType, extra: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: `sandbox-refusal-${type}`,
    name: type,
    type,
    host: "localhost",
    port: 1,
    database: "db",
    createdAt: new Date(0),
    ...extra,
  } as DatabaseConnection;
}

// The providers' own declarations, not copies, so this pins what the editor will read.
const mysqlCaps = new MySQLProvider(connection("mysql")).getCapabilities();
const pgCaps = new PostgresProvider(connection("postgres")).getCapabilities();
const oracleCaps = new OracleProvider(
  connection("oracle", { serviceName: "ORCL" } as Partial<DatabaseConnection>),
).getCapabilities();

const onMysql = (sql: string) =>
  sandboxRefusal(
    sql,
    resolveSqlGrammar("mysql"),
    mysqlCaps.implicitCommitStatements,
    mysqlCaps.implicitCommitExceptions,
  );
const onPostgres = (sql: string) =>
  sandboxRefusal(sql, resolveSqlGrammar("postgres"), pgCaps.implicitCommitStatements, pgCaps.implicitCommitExceptions);
const onOracle = (sql: string) =>
  sandboxRefusal(
    sql,
    resolveSqlGrammar("oracle"),
    oracleCaps.implicitCommitStatements,
    oracleCaps.implicitCommitExceptions,
  );

describe("sandboxRefusal", () => {
  test("refuses a statement the provider declares, with a sentence that claims no more than it knows", () => {
    expect(onMysql("CREATE TABLE e2e.sbx (id INT)")).toBe(
      "SANDBOX cannot run CREATE: on this database it can end the open transaction (it commits implicitly, or runs code that may), so the rollback that follows could undo nothing. Turn SANDBOX off to run it for real.",
    );
  });

  test("lets DML through, which the rollback really undoes", () => {
    expect(onMysql("INSERT INTO t VALUES (1)")).toBeUndefined();
    expect(onMysql("DELETE FROM t WHERE id = 77")).toBeUndefined();
    expect(onOracle("UPDATE t SET a = 1")).toBeUndefined();
  });

  test("lets PostgreSQL DDL through, because its DDL rolls back", () => {
    expect(onPostgres("CREATE TABLE t (id int)")).toBeUndefined();
  });

  test("refuses COMMIT on every engine", () => {
    expect(onPostgres("INSERT INTO t VALUES (1); COMMIT")).toBe(
      "SANDBOX cannot run COMMIT: it would make the changes permanent, and the rollback that follows would undo nothing. Turn SANDBOX off to commit.",
    );
    expect(sandboxRefusal("COMMIT", resolveSqlGrammar("mssql"), undefined, undefined)).toContain("cannot run COMMIT");
  });

  test("refuses ROLLBACK and ABORT, which would end the transaction early", () => {
    expect(onPostgres("INSERT INTO t VALUES (1); ROLLBACK")).toBe(
      "SANDBOX cannot run ROLLBACK: SANDBOX rolls the run back itself, and a ROLLBACK inside it would end the transaction early, so anything after it would run outside one.",
    );
    expect(onPostgres("ABORT")).toContain("cannot run ABORT");
  });

  test("refuses PostgreSQL's END and PREPARE TRANSACTION, but not a prepared statement", () => {
    expect(onPostgres("INSERT INTO t VALUES (1); END")).toContain("cannot run END");
    expect(onPostgres("PREPARE TRANSACTION 'gid1'")).toContain("cannot run PREPARE TRANSACTION");
    expect(onPostgres("PREPARE q AS SELECT 1")).toBeUndefined();
  });

  test("reads every statement, and past a leading comment", () => {
    expect(onMysql("INSERT INTO t VALUES (1);\n/* setup */ DROP TABLE t")).toContain("SANDBOX cannot run DROP");
  });

  test("lets MySQL's temporary tables and MariaDB's statement analyser through", () => {
    expect(onMysql("CREATE TEMPORARY TABLE tmp (id INT)")).toBeUndefined();
    expect(onMysql("DROP TEMPORARY TABLE tmp")).toBeUndefined();
    expect(onMysql("ANALYZE SELECT * FROM t")).toBeUndefined();
    expect(onMysql("ANALYZE FORMAT=JSON SELECT * FROM t")).toBeUndefined();
    expect(onMysql("ANALYZE TABLE t")).toContain("cannot run ANALYZE");
  });

  test("lets Oracle's session and system control through, and refuses its DDL and PL/SQL", () => {
    expect(onOracle("ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD'")).toBeUndefined();
    expect(onOracle("ALTER SYSTEM FLUSH SHARED_POOL")).toBeUndefined();
    expect(onOracle("ALTER TABLE t ADD (c NUMBER)")).toContain("cannot run ALTER");
    expect(onOracle("BEGIN EXECUTE IMMEDIATE 'CREATE TABLE x (id NUMBER)'; END;")).toContain("cannot run BEGIN");
    expect(onOracle("DECLARE n NUMBER; BEGIN n := 1; END;")).toContain("cannot run DECLARE");
  });

  test("a keyword quoted inside a literal is not a statement", () => {
    expect(onMysql("SELECT 'CREATE TABLE x' AS s")).toBeUndefined();
  });

  test("a sequence stops at a literal or punctuation, which is not a word of the verb", () => {
    expect(onPostgres("PREPARE 'x'")).toBeUndefined();
    expect(onPostgres("END;")).toContain("cannot run END");
  });

  test("an empty text has nothing to refuse", () => {
    expect(onMysql("  ")).toBeUndefined();
  });
});
