import { describe, test, expect } from "bun:test";
import { readStatementEnd } from "@/lib/sql/statement-end";

/**
 * `[statement, trailing]` - the split this reader exists to produce.
 *
 * Asserting on the two halves rather than on the index keeps the failure message
 * readable and pins BOTH sides: a reader that loses characters would still return
 * a plausible-looking number.
 */
function split(sql: string): [string, string] {
  const { end } = readStatementEnd(sql);
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
