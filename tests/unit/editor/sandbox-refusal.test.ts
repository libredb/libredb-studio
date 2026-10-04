import { describe, test, expect } from "bun:test";
import { sandboxRefusal } from "@/lib/editor/sandbox-refusal";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { MySQLProvider } from "@/lib/db/providers/sql/mysql";

/**
 * SANDBOX promises a rollback, so a statement that commits the transaction it runs in must
 * never reach the server under it. Measured 2026-10-04 on MySQL 26.7.0: a SANDBOX
 * `CREATE TABLE` left the table behind under "Changes auto-rolled back. No data was modified."
 */
describe("sandboxRefusal", () => {
  const mysql = resolveSqlGrammar("mysql");
  const postgres = resolveSqlGrammar("postgres");
  // The provider's own declaration, not a copy, so this pins what the editor will read.
  const declared = new MySQLProvider({
    id: "sandbox-refusal",
    name: "m",
    type: "mysql",
    host: "localhost",
    port: 3306,
    database: "e2e",
    createdAt: new Date(0),
  }).getCapabilities().implicitCommitStatements;

  test("refuses a statement the provider declares as committing implicitly", () => {
    expect(sandboxRefusal("CREATE TABLE e2e.sbx (id INT)", mysql, declared)).toBe(
      "SANDBOX cannot run CREATE: this database commits the open transaction when it runs one, so the rollback that follows would undo nothing. Turn SANDBOX off to run it for real.",
    );
  });

  test("lets DML through, which the rollback really undoes", () => {
    expect(sandboxRefusal("INSERT INTO t VALUES (1)", mysql, declared)).toBeUndefined();
    expect(sandboxRefusal("DELETE FROM t WHERE id = 77", mysql, declared)).toBeUndefined();
  });

  test("lets DDL through on an engine that declares none, because its DDL rolls back", () => {
    expect(sandboxRefusal("CREATE TABLE t (id int)", postgres, undefined)).toBeUndefined();
  });

  test("refuses COMMIT on every engine", () => {
    expect(sandboxRefusal("INSERT INTO t VALUES (1); COMMIT", postgres, undefined)).toBe(
      "SANDBOX cannot run COMMIT: it would make the changes permanent, and the rollback that follows would undo nothing. Turn SANDBOX off to commit.",
    );
  });

  test("reads every statement, and past a leading comment", () => {
    expect(sandboxRefusal("INSERT INTO t VALUES (1);\n/* setup */ DROP TABLE t", mysql, declared)).toContain(
      "SANDBOX cannot run DROP",
    );
  });

  test("a keyword quoted inside a literal is not a statement", () => {
    expect(sandboxRefusal("SELECT 'CREATE TABLE x' AS s", mysql, declared)).toBeUndefined();
  });

  test("an empty text has nothing to refuse", () => {
    expect(sandboxRefusal("  ", mysql, declared)).toBeUndefined();
  });
});
