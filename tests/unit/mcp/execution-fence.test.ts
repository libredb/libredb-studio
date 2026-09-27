import { describe, expect, test } from "bun:test";
import { assertReadOnlyStatement, checkReadOnlyStatement } from "@/lib/mcp/guards/execution-fence";

describe("MCP Execution Fence", () => {
  test("allows legitimate SELECT queries", () => {
    expect(() => assertReadOnlyStatement("SELECT * FROM users")).not.toThrow();
    expect(checkReadOnlyStatement("SELECT id, name FROM accounts WHERE active = true")).toBeNull();
  });

  test("allows queries with pure read CTEs", () => {
    const sql = "WITH active_users AS (SELECT id FROM users WHERE active = true) SELECT * FROM active_users";
    expect(() => assertReadOnlyStatement(sql)).not.toThrow();
  });

  test("rejects DDL statements (DROP, CREATE, ALTER, TRUNCATE)", () => {
    expect(() => assertReadOnlyStatement("DROP TABLE users")).toThrow();
    expect(() => assertReadOnlyStatement("CREATE TABLE hacked (id INT)")).toThrow();
    expect(() => assertReadOnlyStatement("ALTER TABLE users ADD COLUMN compromised INT")).toThrow();
    expect(() => assertReadOnlyStatement("TRUNCATE TABLE logs")).toThrow();
  });

  test("rejects DML statements (INSERT, UPDATE, DELETE)", () => {
    expect(() => assertReadOnlyStatement("INSERT INTO users (name) VALUES ('hacker')")).toThrow();
    expect(() => assertReadOnlyStatement("UPDATE users SET is_admin = true")).toThrow();
    expect(() => assertReadOnlyStatement("DELETE FROM users WHERE id = 1")).toThrow();
  });

  test("rejects multiple statements separated by semicolons", () => {
    expect(() => assertReadOnlyStatement("SELECT 1; DROP TABLE users;")).toThrow();
    expect(checkReadOnlyStatement("SELECT 1; SELECT 2;")).toBe("MULTIPLE_STATEMENTS");
  });

  test("rejects commands disguised in comments or ambiguous text", () => {
    expect(() => assertReadOnlyStatement("/* SELECT */ INSERT INTO users VALUES (1)")).toThrow();
  });
});
