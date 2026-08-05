import { describe, test, expect } from "bun:test";
import { postgresJsonStrategy } from "@/lib/explain/postgres-json";

describe("postgresJsonStrategy", () => {
  test("format id", () => {
    expect(postgresJsonStrategy.format).toBe("postgres-json");
  });

  test("buildSql wraps SELECT with ANALYZE JSON explain", () => {
    expect(postgresJsonStrategy.buildSql("SELECT * FROM users", "analyze")).toBe(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM users",
    );
  });

  test("buildSql is case-insensitive and whitespace-tolerant", () => {
    expect(postgresJsonStrategy.buildSql("  select 1", "analyze")).toBe(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)   select 1",
    );
  });

  // PR-1 preserves current behavior: estimate mode also runs ANALYZE.
  // PR-5 (#194 B5) will make estimate return plain EXPLAIN (FORMAT JSON).
  test("buildSql estimate mode currently matches analyze mode", () => {
    expect(postgresJsonStrategy.buildSql("SELECT 1", "estimate")).toBe(
      postgresJsonStrategy.buildSql("SELECT 1", "analyze"),
    );
  });

  test("buildSql returns null for non-SELECT", () => {
    expect(postgresJsonStrategy.buildSql("UPDATE users SET a = 1", "analyze")).toBeNull();
    expect(postgresJsonStrategy.buildSql("EXPLAIN SELECT 1", "analyze")).toBeNull();
  });

  test("buildSql explains a read-only CTE and a commented SELECT", () => {
    const cte = "WITH t AS (SELECT 1 AS x) SELECT * FROM t";
    expect(postgresJsonStrategy.buildSql(cte, "analyze")).toBe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${cte}`);
    expect(postgresJsonStrategy.buildSql("-- note\nSELECT 1", "analyze")).toBe(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) -- note\nSELECT 1",
    );
  });

  /**
   * The reason this strategy screens more than the shared classification does.
   *
   * `EXPLAIN (ANALYZE, ...)` RUNS the statement, and a data-modifying CTE is a write
   * wearing a `WITH`. Live-verified on PostgreSQL 18: explaining
   * `WITH t AS (INSERT INTO probe(id) VALUES (42) RETURNING id) SELECT * FROM t`
   * left the row really inserted - 0 rows before, 1 row after. Declining costs an
   * Explain button; accepting performs a write the user only asked to see.
   */
  test.each<[string, string]>([
    ["an INSERT CTE", "WITH t AS (INSERT INTO probe(id) VALUES (42) RETURNING id) SELECT * FROM t"],
    ["an UPDATE CTE", "WITH t AS (UPDATE probe SET id = 1 RETURNING id) SELECT * FROM t"],
    ["a DELETE CTE", "WITH t AS (DELETE FROM probe RETURNING id) SELECT * FROM t"],
  ])("buildSql refuses %s, because ANALYZE would execute it", (_label, sql) => {
    expect(postgresJsonStrategy.buildSql(sql, "analyze")).toBeNull();
    expect(postgresJsonStrategy.buildSql(sql, "estimate")).toBeNull();
  });

  /**
   * The nested-comment shape, and the reason this strategy has to read the statement
   * under PostgreSQL's own grammar rather than the shared default (#300).
   *
   * Block comments NEST here, so `/* a /* b *\/ SELECT 1 *\/ DELETE FROM users` is a
   * comment followed by a DELETE - while a flat reading sees the comment end at the
   * inner `*\/` and reports `SELECT` as the leading keyword. This path skips the
   * confirmation gate entirely (an explain run is not a dangerous-query check), and
   * `ANALYZE` executes what it explains, so the flat reading really did delete the
   * rows: live-verified on PostgreSQL 18, `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`
   * over that statement against a 3-row table left 0 rows behind. Refusing to build
   * is the only honest answer - the statement is a DELETE, and this strategy explains
   * reads.
   */
  test.each<[string, string]>([
    ["a DELETE", "/* a /* b */ SELECT 1 */ DELETE FROM users"],
    ["an UPDATE", "/* a /* b */ SELECT 1 */ UPDATE users SET x = 1"],
    ["a TRUNCATE", "/* a /* b */ SELECT 1 */ TRUNCATE users"],
  ])("buildSql refuses %s that a nested comment made look like a SELECT", (_label, sql) => {
    expect(postgresJsonStrategy.buildSql(sql, "analyze")).toBeNull();
    expect(postgresJsonStrategy.buildSql(sql, "estimate")).toBeNull();
  });

  test("buildSql still explains a read behind a nested comment", () => {
    const sql = "/* a /* b */ x */ SELECT 1";

    expect(postgresJsonStrategy.buildSql(sql, "analyze")).toBe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
  });

  test("buildSql refuses a statement whose nested comment never closes", () => {
    // Undeterminable text: the comment never returns to depth zero, so there is no
    // leading keyword to classify and nothing to wrap.
    expect(postgresJsonStrategy.buildSql("/* a /* b */ SELECT 1", "analyze")).toBeNull();
  });

  // The over-reach, pinned at the STRATEGY boundary rather than only on the helper.
  // The screen is textual, so a keyword inside a string literal counts and this
  // harmless read-only CTE loses its Explain button. That is the direction this has to
  // err in - the other one performs a write the user only asked to see - and it is the
  // documented behaviour, so it belongs in a test rather than in prose alone.
  test("buildSql refuses a read-only CTE that merely mentions a writing keyword", () => {
    expect(postgresJsonStrategy.buildSql("WITH t AS (SELECT 'insert' AS x) SELECT * FROM t", "analyze")).toBeNull();
  });

  // And the limit of that over-reach: the word boundary is what keeps it from swallowing
  // every CTE that touches an `updated_at` column, which would be most of them.
  test("buildSql still explains a CTE over a column whose name merely contains a keyword", () => {
    const cte = "WITH t AS (SELECT updated_at FROM u) SELECT * FROM t";
    expect(postgresJsonStrategy.buildSql(cte, "estimate")).toBe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${cte}`);
  });

  // The screen is scoped to the WITH form on purpose. A statement leading with SELECT
  // cannot carry a data-modifying CTE (PostgreSQL allows one only at the top level), so
  // screening those too would only strip the button off queries that mention a keyword.
  test("buildSql still explains a SELECT that merely mentions a writing keyword", () => {
    expect(postgresJsonStrategy.buildSql("SELECT 'insert' AS word", "analyze")).toBe(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 'insert' AS word",
    );
    expect(postgresJsonStrategy.buildSql("SELECT updated_at FROM t", "analyze")).toBe(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT updated_at FROM t",
    );
  });

  test("extractPlan prefers the QUERY PLAN column", () => {
    const plan = [{ Plan: { "Node Type": "Seq Scan" } }];
    expect(postgresJsonStrategy.extractPlan({ rows: [{ "QUERY PLAN": plan }] })).toEqual(plan);
  });

  test("extractPlan falls back to raw rows", () => {
    const rows = [{ id: 1 }];
    expect(postgresJsonStrategy.extractPlan({ rows })).toEqual(rows);
    expect(postgresJsonStrategy.extractPlan({})).toBeUndefined();
  });
});
