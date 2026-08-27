import { describe, test, expect } from "bun:test";
import { resolveSqlGrammar, type SqlGrammar } from "@/lib/sql/grammar";
import { readStatementEnd } from "@/lib/sql/statement-end";
import type { DatabaseType } from "@/lib/types";

/**
 * `[statement, trailing]` - the split this reader exists to produce.
 *
 * Asserting on the two halves rather than on the index keeps the failure message
 * readable and pins BOTH sides: a reader that loses characters would still return
 * a plausible-looking number.
 */
function split(sql: string, grammar?: SqlGrammar): [string, string] {
  const { end } = readStatementEnd(sql, grammar);
  return [sql.slice(0, end), sql.slice(end)];
}

describe("readStatementEnd", () => {
  // ── The statement's own text ────────────────────────────────────────────

  describe("nothing to strip", () => {
    test.each<[string, string]>([
      ["a bare statement", "SELECT 1"],
      ["a statement ending in a string", "SELECT 'a'"],
      ["a statement ending in a quoted identifier", 'SELECT "col"'],
      ["a statement ending in a paren", "SELECT count(*) FROM t"],
    ])("leaves %s whole", (_label, sql) => {
      expect(split(sql)).toEqual([sql, ""]);
    });
  });

  describe("trailing trivia", () => {
    test.each<[string, string, string]>([
      // label, statement, trailing
      ["a semicolon", "SELECT 1", ";"],
      ["repeated semicolons", "SELECT 1", ";;"],
      ["whitespace", "SELECT 1", "  \n"],
      ["a line comment", "SELECT 1", " -- note"],
      ["a block comment", "SELECT 1", " /* note */"],
      ["a semicolon then a comment", "SELECT 1", "; -- note"],
      ["a comment then a semicolon", "SELECT 1", " -- note\n;"],
      ["a comment carrying a semicolon", "SELECT 1", " -- ; note"],
      ["several comments", "SELECT 1", " /* a */ -- b\n/* c */"],
      ["a comment after a bound", "SELECT 1 LIMIT 10", " -- deliberate"],
    ])("splits off %s", (_label, statement, trailing) => {
      expect(split(`${statement}${trailing}`)).toEqual([statement, trailing]);
    });

    test("leading whitespace is not part of the answer - only the end moves", () => {
      expect(split("  SELECT 1  ")).toEqual(["  SELECT 1", "  "]);
    });

    test("input that is only trivia has no statement", () => {
      expect(split("-- note\n")).toEqual(["", "-- note\n"]);
      expect(split("")).toEqual(["", ""]);
    });
  });

  // ── Literals are code, and what they contain is not ─────────────────────
  //
  // The whole reason this is a scanner and not `lastIndexOf("--")`: a comment
  // marker or a semicolon written inside a literal is data, and cutting the
  // statement there would hand the engine half a query.

  describe("a delimiter inside a literal does not end the statement", () => {
    test.each<[string, string]>([
      ["a semicolon in a string", "SELECT ';'"],
      ["a dash pair in a string", "SELECT '-- not a comment'"],
      ["a hash in a string", "SELECT '# not a comment'"],
      ["a block-comment opener in a string", "SELECT '/* not a comment'"],
      ["a comment marker in a quoted identifier", 'SELECT "a -- b"'],
      ["a comment marker in a backtick identifier", "SELECT `a -- b`"],
      ["a comment marker in a dollar-quoted body", "SELECT $$ ; -- $$"],
      ["a comment marker in a TAGGED dollar-quoted body", "SELECT $tag$ ; -- $tag$"],
      ["a doubled quote inside a string", "SELECT 'it''s -- fine'"],
    ])("keeps %s inside the statement", (_label, sql) => {
      expect(split(sql)).toEqual([sql, ""]);
    });

    test("code after a comment is still part of the statement", () => {
      expect(split("SELECT /* c */ 1")).toEqual(["SELECT /* c */ 1", ""]);
      expect(split("SELECT 1 -- c\nFROM t")).toEqual(["SELECT 1 -- c\nFROM t", ""]);
    });

    test("a semicolon that separates statements is not trailing trivia", () => {
      expect(split("SELECT 1; SELECT 2;")).toEqual(["SELECT 1; SELECT 2", ";"]);
    });

    // ── A dollar-quoted body is the statement's own text ───────────────────
    //
    // Same shape as the bracketed run below, and pinned the same way: only a
    // fixture where the two readings DISAGREE decides it. With code after the
    // body the end reaches the same index either way, so the body has to be the
    // LAST token - either ending the input or with nothing but trivia after it.
    // Read as trivia instead, the body would join the trailing run and the end
    // would fall back to the last code character before it, so the
    // insert-before-trivia rewrite would emit `SELECT $$body$$` as
    // `SELECT LIMIT 500 $$body$$` - the corrupted-statement class, not a missed
    // bound.
    test("splits the trailing trivia off after a dollar-quoted body, not before it", () => {
      expect(readStatementEnd("SELECT $$a$$")).toEqual({ end: 12, rewritable: true });
      expect(split("SELECT $$a$$ -- daily")).toEqual(["SELECT $$a$$", " -- daily"]);
      expect(split("SELECT $tag$a$tag$;")).toEqual(["SELECT $tag$a$tag$", ";"]);
      expect(split("SELECT $$ ; -- $$ /* c */")).toEqual(["SELECT $$ ; -- $$", " /* c */"]);
    });
  });

  // ── Ends that may not be cut ────────────────────────────────────────────
  //
  // Reading a statement's text and cutting it in two are not equally risky, so
  // `rewritable` answers the second question separately: a probe reading the
  // wrong text at worst reports a bound that is not there, and the caller then
  // leaves the statement alone, while a clause inserted at the wrong index lands
  // in the middle of the statement and the server rejects it outright.

  describe("rewritable", () => {
    test.each<[string, string]>([
      ["a bare statement", "SELECT 1"],
      ["a trailing dash comment", "SELECT 1 -- note"],
      ["a trailing block comment", "SELECT 1 /* note */"],
      ["a terminator", "SELECT 1;"],
      ["a hash comment with code after it", "SELECT * FROM t # note\nWHERE a = 1"],
    ])("allows a cut after %s", (_label, sql) => {
      expect(readStatementEnd(sql).rewritable).toBe(true);
    });

    // A refused cut always reports the terminator strip as its end - trailing
    // whitespace and semicolons removed and nothing else, which is what this
    // module's callers read before it existed. So a caller's probes lose
    // nothing: only the rewrite is declined.
    //
    // A span that never closes is the first of the two shapes: the two dialect
    // readings end the statement in different places, so the cut would be a guess.
    test.each<[string, string, string]>([
      ["an unterminated block comment", "SELECT 1 /* note", "SELECT 1 /* note"],
      ["an unterminated string", "SELECT 'note", "SELECT 'note"],
      ["an unterminated dollar-quoted body", "SELECT $$ note", "SELECT $$ note"],
      ["a `$` inside a bare identifier", "SELECT a$b$c FROM t", "SELECT a$b$c FROM t"],
      ["a quote behind an odd backslash run", "SELECT 'O\\'Brien' -- note", "SELECT 'O\\'Brien' -- note"],
      ["the same before a terminator", "SELECT 'O\\'Brien';", "SELECT 'O\\'Brien'"],
    ])("refuses a cut after %s", (_label, sql, statement) => {
      expect(readStatementEnd(sql).rewritable).toBe(false);
      expect(split(sql)[0]).toBe(statement);
    });

    // `#` is MySQL's comment marker and ordinary code in three other dialects
    // this project supports, and nothing in the text tells them apart. Cutting
    // there would emit `SELECT * FROM LIMIT 500 #tmp`; reporting the SHORTER
    // reading would hide a bound written after the `#`, and a caller that cannot
    // see one adds a second.
    test.each<[string, string, string]>([
      ["a T-SQL temp table", "SELECT * FROM #tmp", "SELECT * FROM #tmp"],
      [
        "an already-bounded temp-table page",
        "SELECT * FROM #t FETCH NEXT 10 ROWS ONLY",
        "SELECT * FROM #t FETCH NEXT 10 ROWS ONLY",
      ],
      ["an Oracle identifier carrying a hash", "SELECT * FROM EMP WHERE ID# = 1", "SELECT * FROM EMP WHERE ID# = 1"],
      ["a PostgreSQL XOR operator", "SELECT flags # 5 AS x FROM t", "SELECT flags # 5 AS x FROM t"],
      ["a MySQL trailing hash comment", "SELECT 1 # note", "SELECT 1 # note"],
      ["a hash comment before a terminator", "SELECT 1 # note\n;", "SELECT 1 # note"],
    ])("refuses a cut but reports the whole statement for %s", (_label, sql, statement) => {
      expect(readStatementEnd(sql).rewritable).toBe(false);
      expect(split(sql)[0]).toBe(statement);
    });

    // ── …unless the caller says which dialect it is (#292) ────────────────
    //
    // The refusal above exists because "nothing in the text tells them apart".
    // A caller that names its dialect has told them apart, so the refusal is
    // lifted in BOTH directions - and the two directions produce different
    // ends, which is why each is asserted whole rather than by its flag.

    test("a comment grammar cuts before the trailing hash comment", () => {
      const mysql = resolveSqlGrammar("mysql");

      expect(readStatementEnd("SELECT 1 # note", mysql)).toEqual({ end: 8, rewritable: true });
      expect(split("SELECT 1 # note", mysql)).toEqual(["SELECT 1", " # note"]);
      expect(split("SELECT 1 # note\n;", mysql)).toEqual(["SELECT 1", " # note\n;"]);
    });

    test.each<[string, string, DatabaseType]>([
      ["a T-SQL temp table", "SELECT * FROM #tmp", "mssql"],
      ["an Oracle identifier carrying a hash", "SELECT * FROM EMP WHERE ID# = 1", "oracle"],
      ["a PostgreSQL XOR operator", "SELECT flags # 5 AS x FROM t", "postgres"],
      ["a SQLite bind variable", "SELECT * FROM t WHERE id = #id", "sqlite"],
    ])("a code grammar keeps %s as the statement's own text and allows the cut", (_label, sql, type) => {
      expect(readStatementEnd(sql, resolveSqlGrammar(type))).toEqual({ end: sql.length, rewritable: true });
    });

    test("a code grammar still splits off the trivia that dialect does have", () => {
      const mssql = resolveSqlGrammar("mssql");

      expect(split("SELECT * FROM #tmp -- daily", mssql)).toEqual(["SELECT * FROM #tmp", " -- daily"]);
      expect(split("SELECT * FROM #t FETCH NEXT 10 ROWS ONLY;", mssql)).toEqual([
        "SELECT * FROM #t FETCH NEXT 10 ROWS ONLY",
        ";",
      ]);
    });

    // ── A bracketed run is the statement's own text under both readings ────
    //
    // A quoted name and an array literal are both TOKENS, so the end has to
    // advance past either of them. Treating the subscript reading (#295) as
    // trivia instead would put the end back at the last code character BEFORE
    // the run, and the insert-before-trivia rewrite then splices the bound into
    // the middle of the statement - `SELECT [1,2]` emitted as
    // `SELECT LIMIT 500 [1,2]` - which is the corrupted-statement class, not a
    // missed bound.
    // Only a row where the run is the LAST token decides that: with code after the
    // run the end reaches the input's length under either reading, so the first
    // three rows below say nothing about it. Reported by review on this task.
    test.each<[string, string, DatabaseType]>([
      ["an array literal", "SELECT [1,2] AS a", "clickhouse"],
      ["a map subscript whose key carries a close bracket", "SELECT m['a]b'] AS v", "clickhouse"],
      ["a bracket-quoted name", "SELECT [a--b] FROM t", "mssql"],
      ["an array literal that ENDS the statement", "SELECT [1,2]", "clickhouse"],
      ["a nested array that ends the statement", "SELECT [[1,2],[3,4]]", "clickhouse"],
      ["a subscript that ends the statement", "SELECT m['a]b']", "clickhouse"],
      ["a bracket-quoted name that ends the statement", "SELECT [a--b]", "mssql"],
    ])("keeps %s inside the statement and allows the cut", (_label, sql, type) => {
      expect(readStatementEnd(sql, resolveSqlGrammar(type))).toEqual({ end: sql.length, rewritable: true });
    });

    test("splits the trailing trivia off after a bracketed run, not before it", () => {
      const clickhouse = resolveSqlGrammar("clickhouse");

      expect(split("SELECT [1,2] AS a -- daily", clickhouse)).toEqual(["SELECT [1,2] AS a", " -- daily"]);
      expect(split("SELECT [[1,2],[3,4]] AS a;", clickhouse)).toEqual(["SELECT [[1,2],[3,4]] AS a", ";"]);
    });

    test("refuses the cut where a subscript never closes", () => {
      const clickhouse = resolveSqlGrammar("clickhouse");

      expect(readStatementEnd("SELECT [1,2 AS a", clickhouse).rewritable).toBe(false);
    });
  });

  // ── Bounded time ────────────────────────────────────────────────────────
  //
  // Same guard as `spans.ts` and `leading-keyword.ts` carry, for the same
  // reason: the regex shape of this job ("everything up to the trailing
  // comment") backtracks catastrophically, and three measured failures of that
  // kind are recorded in `leading-keyword.ts`. A scan that advances one span at
  // a time cannot backtrack, and this guard is what keeps it that way.

  test("answers in bounded time on adversarial input", () => {
    const BOUND_MS = 200;
    const adversarial: [string, string, number][] = [
      // label, input, expected end
      ["20k semicolons", `SELECT 1${";".repeat(20000)}`, 8],
      ["20k line comments", `SELECT 1${" -- note\n".repeat(20000)}`, 8],
      ["20k empty block comments", `SELECT 1${"/**/".repeat(20000)}`, 8],
      ["a 20k unterminated block comment", `SELECT 1 /*${"a".repeat(20000)}`, 20011],
      ["20k quotes that never close", `SELECT ${"'".repeat(20001)}`, 20008],
      // The run is EVEN, so the closing quote is a real one and the comment after
      // it really is trailing - the walk-back has to prove that at every candidate.
      ["a 20k backslash run before a quote", `SELECT '${"\\".repeat(20000)}' -- note`, 20009],
      ["20k whitespace", `SELECT 1${" ".repeat(20000)}`, 8],
      ["20k alternating trivia", `SELECT 1${"; -- a\n/**/ ".repeat(2000)}`, 8],
    ];

    for (const [label, sql, expected] of adversarial) {
      const started = performance.now();
      const { end } = readStatementEnd(sql);
      const elapsed = performance.now() - started;

      // A correct answer AND a bounded one: a fast wrong answer is not a pass.
      expect(end, label).toBe(expected);
      expect(elapsed, `${label} took ${elapsed.toFixed(1)}ms`).toBeLessThan(BOUND_MS);
    }
  });
});
