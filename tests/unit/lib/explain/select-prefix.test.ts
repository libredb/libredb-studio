import { describe, expect, test } from "bun:test";
import { classifySelectPrefix, hasDataModifyingStatement } from "@/lib/explain/select-prefix";

describe("classifySelectPrefix", () => {
  test.each<[string, string]>([
    ["a bare SELECT", "SELECT 1"],
    ["leading spaces", "   SELECT 1"],
    ["leading newlines and tabs", "\n\t SELECT 1"],
    ["a line comment", "-- note\nSELECT 1"],
    ["an empty line comment", "--\nSELECT 1"],
    ["a block comment", "/* note */ SELECT 1"],
    ["a multi-line block comment", "/* one\n   two */ SELECT 1"],
    ["two adjacent block comments", "/*a*//*b*/SELECT 1"],
    ["comments and whitespace interleaved", "-- a\n  /* b */\n\t-- c\nSELECT 1"],
    ["a MySQL hash line comment", "# note\nSELECT 1"],
    ["lower case", "select 1"],
    ["mixed case", "SeLeCt 1"],
  ])("classifies %s as select", (_label, sql) => {
    expect(classifySelectPrefix(sql)).toBe("select");
  });

  // The `#` case above is a DELIBERATE widening, not inherited behaviour: it arrived
  // when the query limiter needed the same comment tolerance (#275) and `#` went into
  // the shared trivia pattern for MySQL's and MariaDB's sake. It answered `null` here
  // before, so all six strategies used to hide the Explain button for a `#`-annotated
  // statement and now build one.
  //
  // Accepted, because the widening cannot cost more than an error message. On MySQL
  // and MariaDB a `#`-led statement is exactly as explainable as a `--`-led one. On the
  // dialects that do NOT treat `#` as a comment, no statement can OPEN with one either,
  // so what used to be a missing button becomes a button that surfaces the same syntax
  // error the server would have raised for the unwrapped statement. No dialect gains a
  // statement that runs when it should not - that policy lives in
  // `hasDataModifyingStatement`, which scans the whole statement and is unaffected by
  // what counts as trivia.
  test("classifies a hash-annotated CTE as with, so the write guard still screens it", () => {
    const sql = "# note\nWITH t AS (INSERT INTO probe(id) VALUES (42) RETURNING id) SELECT * FROM t";

    expect(classifySelectPrefix(sql)).toBe("with");
    expect(hasDataModifyingStatement(sql)).toBe(true);
  });

  // Distinguished from `select` rather than collapsed into a boolean, because a WITH
  // can carry a statement that writes and PostgreSQL's EXPLAIN executes what it
  // explains. See postgres-json.ts.
  test.each<[string, string]>([
    ["a bare CTE", "WITH t AS (SELECT 1) SELECT * FROM t"],
    ["a CTE behind a comment", "-- lead\nWITH t AS (SELECT 1) SELECT * FROM t"],
    ["a CTE behind a block comment", "/* lead */ WITH t AS (SELECT 1) SELECT * FROM t"],
    ["a recursive CTE", "WITH RECURSIVE t AS (SELECT 1) SELECT * FROM t"],
    ["lower case", "with t as (select 1) select * from t"],
  ])("classifies %s as with", (_label, sql) => {
    expect(classifySelectPrefix(sql)).toBe("with");
  });

  // The near misses. Broadening the check must not turn it into "starts with anything":
  // a comment is not a statement, and the word boundary is what keeps SELECTED out.
  test.each<[string, string]>([
    ["an UPDATE", "UPDATE t SET a = 1"],
    ["a DELETE", "DELETE FROM t"],
    ["an INSERT", "INSERT INTO t SELECT 1"],
    ["a CREATE", "CREATE TABLE t (id INT)"],
    ["an already-wrapped EXPLAIN", "EXPLAIN SELECT 1"],
    ["a line comment alone", "-- only a comment"],
    ["a block comment alone", "/* only a comment */"],
    ["an empty string", ""],
    ["only whitespace", "   "],
    ["a word that merely starts with SELECT", "SELECTED 1"],
    ["a word that merely starts with WITH", "WITHER"],
    ["a word that merely starts with WITH, with a tail", "WITHOUT_A_KEYWORD 1"],
    ["an unterminated block comment", "/* unterminated SELECT 1"],
    ["a comment that never closes before the keyword", "-- SELECT 1"],
  ])("returns null for %s", (_label, sql) => {
    expect(classifySelectPrefix(sql)).toBeNull();
  });

  /**
   * Regression guard on the SHAPE of the pattern, not on what it accepts.
   *
   * All three alternatives sit inside a `*` quantifier, so any way of matching the same
   * text twice lets a NON-matching input backtrack. Each was measured on a predecessor
   * of this pattern, and each is a different ambiguity:
   *
   *   a leading `\s*` beside a `\s` alternative      quadratic    958ms / 20k spaces
   *   a lazy `[\s\S]*?\*\/` spanning two comments    quadratic    852ms / 4 KB
   *   `--[^\n]*` with no `(?:\n|$)` tail             EXPONENTIAL  634ms / 49 chars
   *
   * The third is the one worth remembering: it needs three orders of magnitude less
   * input than the others, it was introduced while fixing them, and it was found by
   * CodeQL rather than by a guard like this one - because the guard exercised `-- a\n`
   * repetitions, and the newline is exactly what makes that branch unambiguous. Hence
   * the bare-dash cases below.
   *
   * The bound is loose on purpose - three orders of magnitude above what the correct
   * pattern needs - so it cannot flake on a slow runner while still failing outright if
   * any of the three ambiguities returns.
   */
  test("does not backtrack on long comment or whitespace runs that never reach a keyword", () => {
    const BOUND_MS = 200;
    const adversarial: [string, string][] = [
      ["20k leading spaces", `${" ".repeat(20000)}UPDATE t SET a = 1`],
      ["4 KB of empty block comments", `${"/**/".repeat(1000)}UPDATE t SET a = 1`],
      ["block comments with bodies", `${"/*a*/".repeat(1000)}DELETE FROM t`],
      ["line comments with newlines", `${"-- a\n".repeat(1000)}UPDATE t SET a = 1`],
      ["mixed comments and whitespace", `${"/**/ -- a\n ".repeat(1000)}DELETE FROM t`],
      ["24 bare dash pairs", `${"--".repeat(24)}X`],
      ["2k bare dash pairs", `${"--".repeat(2000)}UPDATE t SET a = 1`],
      ["20k bare dashes", `${"-".repeat(20000)}X`],
    ];

    for (const [label, sql] of adversarial) {
      const started = performance.now();
      const result = classifySelectPrefix(sql);
      const elapsed = performance.now() - started;

      // A correct answer AND a bounded one: a fast wrong answer is not a pass.
      expect(result).toBeNull();
      expect(elapsed, `${label} took ${elapsed.toFixed(1)}ms`).toBeLessThan(BOUND_MS);
    }
  });

  test("stays fast on a large licence header that DOES reach a SELECT", () => {
    const header = `/*\n${" * Licence line filler.\n".repeat(400)} */\n`;
    const started = performance.now();

    expect(classifySelectPrefix(`${header}SELECT 1`)).toBe("select");
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("hasDataModifyingStatement", () => {
  // Exists for PostgreSQL alone, whose EXPLAIN (ANALYZE) executes what it explains, so
  // a data-modifying CTE would be PERFORMED by a button that claims to describe.
  // All four are real carriers. MERGE especially is not a defensive guess: live on
  // PostgreSQL 18, `EXPLAIN (ANALYZE, FORMAT JSON) WITH t AS (MERGE INTO probe ...
  // RETURNING id) SELECT * FROM t` really inserted the row.
  test.each<[string, string]>([
    ["an INSERT CTE", "WITH t AS (INSERT INTO probe(id) VALUES (1) RETURNING id) SELECT * FROM t"],
    ["an UPDATE CTE", "WITH t AS (UPDATE probe SET id = 1 RETURNING id) SELECT * FROM t"],
    ["a DELETE CTE", "WITH t AS (DELETE FROM probe RETURNING id) SELECT * FROM t"],
    [
      "a MERGE CTE",
      "WITH t AS (MERGE INTO probe p USING (SELECT 99 AS mid) s ON p.id = s.mid " +
        "WHEN NOT MATCHED THEN INSERT (id) VALUES (s.mid) RETURNING p.id) SELECT * FROM t",
    ],
    ["lower case", "with t as (insert into probe values (1) returning id) select * from t"],
  ])("detects %s", (_label, sql) => {
    expect(hasDataModifyingStatement(sql)).toBe(true);
  });

  // TRUNCATE is deliberately absent: it cannot ride inside a WITH at all (live,
  // `WITH t AS (TRUNCATE probe) SELECT 1` is a SYNTAX error), and a statement leading
  // with it never reaches this function because `classifySelectPrefix` already answers
  // null for anything but SELECT or WITH. Same for the other DDL verbs.
  test.each<[string, string]>([
    ["TRUNCATE", "TRUNCATE probe"],
    ["DROP", "DROP TABLE probe"],
    ["CREATE", "CREATE TABLE probe (id INT)"],
  ])("leaves %s to the prefix classification, which refuses it outright", (_label, sql) => {
    expect(hasDataModifyingStatement(sql)).toBe(false);
    expect(classifySelectPrefix(sql)).toBeNull();
  });

  test.each<[string, string]>([
    ["a read-only CTE", "WITH t AS (SELECT 1) SELECT * FROM t"],
    ["a plain SELECT", "SELECT 1"],
    ["a join", "SELECT * FROM a JOIN b ON a.id = b.id"],
    // The word boundary keeps these out; without it every `updated_at` column would
    // look like a write.
    ["a column named updated_at", "SELECT updated_at FROM t"],
    ["a column named inserted_by", "SELECT inserted_by FROM t"],
    ["a table named deletions", "SELECT * FROM deletions"],
  ])("does not flag %s", (_label, sql) => {
    expect(hasDataModifyingStatement(sql)).toBe(false);
  });

  // Documented over-reach: the scan is textual, so a keyword inside a string literal
  // counts. That costs an Explain button on an unusual CTE and never performs a write,
  // which is the direction this has to err in.
  test("errs toward refusing when a keyword appears inside a string literal", () => {
    expect(hasDataModifyingStatement("WITH t AS (SELECT 'insert' AS x) SELECT * FROM t")).toBe(true);
  });
});
