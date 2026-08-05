import { describe, test, expect } from "bun:test";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { findCodeWord, readSqlWord } from "@/lib/sql/words";

/** The word at an index as its text alone - the shape most assertions want. */
function wordAt(sql: string, index = 0): string | null {
  return readSqlWord(sql, index)?.text ?? null;
}

/**
 * Where a code word starts, or -1.
 *
 * Asserting on the INDEX rather than on a boolean pins that the reader stopped in
 * the right place: a scanner that answered from inside a literal would still say
 * "found".
 */
function findAt(sql: string, word: string, from = 0): number {
  return findCodeWord(sql, word, from)?.start ?? -1;
}

describe("readSqlWord", () => {
  test.each<[string, string, string | null]>([
    ["a keyword, upper-cased", "select 1", "SELECT"],
    ["a name with digits and underscores", "t1_a", "T1_A"],
    ["a name carrying a dollar", "a$b", "A$B"],
    ["a localized name", "müşteri", "MÜŞTERI"],
  ])("reads %s", (_label, sql, expected) => {
    expect(wordAt(sql)).toBe(expected);
  });

  test.each<[string, string]>([
    ["a digit", "1a"],
    ["a paren", "(SELECT 1)"],
    ["a quote", "'SELECT'"],
    ["a dollar, so a dollar-quote tag stays the literal it is", "$tag$"],
    ["the end of the input", ""],
  ])("answers null where a word cannot open - %s", (_label, sql) => {
    expect(wordAt(sql)).toBeNull();
  });

  test("reads from the given index and reports where the word ends", () => {
    const word = readSqlWord("SELECT count", 7);

    expect(word).toEqual({ text: "COUNT", end: 12 });
  });
});

describe("findCodeWord", () => {
  // ── Reading the statement's own code ────────────────────────────────────

  test.each<[string, string, string, number]>([
    // label, sql, word, expected start
    ["a leading keyword", "UPDATE t SET x = 1", "UPDATE", 0],
    ["a keyword further in", "UPDATE t SET x = 1", "SET", 9],
    ["a word written in lower case", "update t", "UPDATE", 0],
    ["a word searched for in lower case", "UPDATE t", "update", 0],
    ["code that follows a comment", "-- note\nUPDATE t", "UPDATE", 8],
    ["code that follows a literal", "SELECT 'x', UPDATE", "UPDATE", 12],
  ])("finds %s", (_label, sql, word, expected) => {
    expect(findAt(sql, word)).toBe(expected);
  });

  test("reports where the word ends, so a caller can search on past it", () => {
    expect(findCodeWord("UPDATE t SET x = 1", "UPDATE")).toEqual({ start: 0, end: 6 });
  });

  test("searches from the given index, past an earlier occurrence", () => {
    expect(findAt("SET a SET b", "SET", 1)).toBe(6);
  });

  // ── Whole words only ───────────────────────────────────────────────────

  test.each<[string, string]>([
    ["a longer word that starts with it", "UPDATED t SET x = 1"],
    ["a longer word that ends with it", "xUPDATE t"],
    ["a word joined to it by a dollar", "UPDATE$x t"],
    ["a word that is absent", "SELECT * FROM t"],
  ])("does not answer for %s", (_label, sql) => {
    expect(findAt(sql, "UPDATE")).toBe(-1);
  });

  // ── Everything that is not code ────────────────────────────────────────

  /**
   * The reason this module exists rather than a `\bWORD\b` regex: every one of
   * these inputs MENTIONS the word without the statement doing it. A regex reads
   * all of them as the statement's own code, which is how a read that quotes
   * `UPDATE … SET` in a string was treated as a write (#294).
   */
  test.each<[string, string]>([
    ["a single-quoted string", "SELECT 'UPDATE t SET x' FROM notes"],
    ["a string carrying a doubled quote", "SELECT 'it''s UPDATE' FROM notes"],
    ["a double-quoted identifier", 'SELECT "UPDATE" FROM t'],
    ["a backtick identifier", "SELECT `UPDATE` FROM t"],
    ["a dollar-quoted body", "SELECT $$ UPDATE t $$"],
    ["a tagged dollar-quoted body", "SELECT $fn$ UPDATE t $fn$"],
    ["a line comment", "SELECT 1 -- UPDATE t SET x"],
    ["a MySQL hash comment", "SELECT 1 # UPDATE t SET x"],
    ["a block comment", "SELECT /* UPDATE */ 1"],
    ["a block comment spanning lines", "SELECT 1\n/*\n UPDATE t\n*/"],
  ])("skips %s", (_label, sql) => {
    expect(findAt(sql, "UPDATE")).toBe(-1);
  });

  /**
   * An undeterminable literal reaches the end of the input (`spans.ts` reports
   * `end: sql.length` for one), so code written after it is not read at all.
   *
   * Recorded as a test because for THIS module's caller the direction is the
   * unhelpful one: the safety dialog wants to prompt when it cannot tell, and a
   * write hidden behind `'\'` - a complete string in PostgreSQL, an unterminated
   * one in MySQL - is not detected. Every reader in this folder pays the same
   * price for the same reason (the two dialect readings put the end of the string
   * in different places), and the text is a syntax error under one of them, so it
   * is left where `spans.ts` decided it rather than guessed at here.
   */
  test.each<[string, string]>([
    ["an unterminated string", "SELECT 'x\nUPDATE t SET y = 1"],
    ["a literal behind an odd backslash run", "SELECT '\\';\nUPDATE t SET y = 1"],
    ["an unterminated block comment", "SELECT 1 /* note\nUPDATE t SET y = 1"],
  ])("does not read code past %s", (_label, sql) => {
    expect(findAt(sql, "UPDATE")).toBe(-1);
  });

  // ── What counts as "not code" is the dialect's answer (#292) ────────────
  //
  // The safety predicate is this module's caller, and a `#` decides whether a
  // write after it is the statement's own code. Both directions matter here: in
  // MySQL the write really is commented out and prompting would be a false alarm,
  // while in PostgreSQL those characters are an operator and the write is real.

  test("a hash hides a write under a comment grammar and does not under a code grammar", () => {
    const sql = "SELECT 1 # UPDATE t SET x";

    expect(findCodeWord(sql, "UPDATE", 0, resolveSqlGrammar("mysql"))).toBeNull();
    expect(findCodeWord(sql, "UPDATE", 0, resolveSqlGrammar("postgres"))).toEqual({ start: 11, end: 17 });
  });

  // ── Shape of the scan ──────────────────────────────────────────────────

  /**
   * A timing guard, because the pattern this reader replaced was measurably
   * quadratic and lived on the editor's execute path.
   *
   * `/\bUPDATE\b[\s\S]*?\bSET\b/i` restarts its lazy tail at every `UPDATE` in the
   * input, so text holding many of them and no `SET` costs one full scan each.
   * Measured on the real predicate before this module existed:
   *
   *   14 KB of `UPDATE ` repeats     10.5ms
   *   140 KB                          1025ms
   *   350 KB                          6406ms
   *
   * A scanner that advances one span or one word at a time cannot do that. The rows
   * expecting `-1` are the full-scan guards - they walk every byte before answering,
   * so a backtracking pattern would blow the bound outright; the two rows expecting
   * `0` return after the first word and pin the ANSWER rather than the time. The
   * bound is loose on purpose so it cannot flake on a slow runner while still
   * failing outright if a backtracking pattern returns - the quadratic form is five
   * times over it at 140 KB alone.
   *
   * Correctness is asserted with the timing: a fast wrong answer is not a pass.
   */
  test("answers in bounded time on input built to make a lazy pattern backtrack", () => {
    const BOUND_MS = 200;
    const adversarial: [string, string, number][] = [
      ["20k UPDATE words, no SET", `${"UPDATE ".repeat(20000)}(`, 0],
      ["50k UPDATE words, no SET", `${"UPDATE ".repeat(50000)}(`, 0],
      ["20k words that only start with it", `${"UPDATED ".repeat(20000)}(`, -1],
      ["20k leading spaces", `${" ".repeat(20000)}(`, -1],
      ["4 KB of empty block comments", `${"/**/".repeat(1000)}(`, -1],
      ["2k line comments", `${"-- a\n".repeat(2000)}(`, -1],
      ["2k strings", `${"'a', ".repeat(2000)}(`, -1],
      ["2k quote characters", `${"'".repeat(2000)}(`, -1],
      ["a 20 KB string body", `SELECT '${"UPDATE ".repeat(3000)}'`, -1],
    ];

    for (const [label, sql, expected] of adversarial) {
      const started = performance.now();
      const found = findAt(sql, "UPDATE");
      const elapsed = performance.now() - started;

      expect(found, label).toBe(expected);
      expect(elapsed, `${label} took ${elapsed.toFixed(1)}ms`).toBeLessThan(BOUND_MS);
    }
  });
});
