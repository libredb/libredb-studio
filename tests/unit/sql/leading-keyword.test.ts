import { describe, test, expect } from "bun:test";
import { resolveSqlGrammar, type SqlGrammar } from "@/lib/sql/grammar";
import { readLeadingKeyword } from "@/lib/sql/leading-keyword";

// ─── Helpers ────────────────────────────────────────────────────────────────

function keywordOf(sql: string, grammar?: SqlGrammar): string | null {
  return readLeadingKeyword(sql, grammar)?.keyword ?? null;
}

// ─── readLeadingKeyword ─────────────────────────────────────────────────────

describe("readLeadingKeyword", () => {
  // ── What precedes the keyword ───────────────────────────────────────────

  describe("skips leading trivia", () => {
    test.each<[string, string]>([
      ["no comment at all", "SELECT 1"],
      ["leading spaces", "   SELECT 1"],
      ["leading newlines and tabs", "\n\t SELECT 1"],
      ["one line comment", "-- note\nSELECT 1"],
      ["an empty line comment", "--\nSELECT 1"],
      ["one block comment", "/* note */ SELECT 1"],
      ["a multi-line block comment", "/* one\n   two */ SELECT 1"],
      ["two adjacent block comments", "/*a*//*b*/SELECT 1"],
      ["stacked comments of both styles", "-- a\n  /* b */\n\t-- c\nSELECT 1"],
      ["a comment, then a newline, then the keyword", "/* note */\n\nSELECT 1"],
      ["a MySQL hash line comment", "# note\nSELECT 1"],
      ["an empty hash comment", "#\nSELECT 1"],
      ["stacked comments of all three styles", "# a\n-- b\n/* c */\nSELECT 1"],
      // Whitespace here is JS `\s`, which is WIDER than the ASCII set `spans.ts`
      // reads as a whitespace span. It is the alphabet the pattern this scan replaced
      // used, so keeping it is what makes the conversion answer-for-answer identical -
      // and on one engine the narrower reading would cost more than a difference: a
      // `latin1` MySQL connection reads byte 0xA0 as a space and runs the statement
      // behind it (verified on MySQL 26.7 through mysql2: a row comes back under
      // `charset=latin1`, and the statement is rejected under the `utf8mb4` the
      // provider negotiates by default, as U+2028, U+3000 and a BOM are under every
      // charset tried; PostgreSQL 18 rejects all four). The gate's half of that is
      // pinned in tests/components/QuerySafetyDialog.test.tsx.
      ["a no-break space", " SELECT 1"],
      ["a byte-order mark", "﻿SELECT 1"],
      ["an ideographic space", "　SELECT 1"],
      ["a line separator", " SELECT 1"],
      ["unicode whitespace between comments", "-- a\n /* b */ SELECT 1"],
    ])("finds the keyword behind %s", (_label, sql) => {
      expect(keywordOf(sql)).toBe("SELECT");
    });

    // `#` is MySQL's and MariaDB's second line-comment marker, and it is here for
    // the same reason `--` is: without it a `# note`-led SELECT reaches the server
    // with no LIMIT on the provider this project's users reach for second most
    // (#275). It is not a comment in PostgreSQL, Oracle, SQL Server or SQLite - but
    // a statement that OPENS with `#` is a syntax error on all four, so skipping it
    // there only changes which error the server reports, never a result.
    test("treats a hash comment as trivia on every dialect, because a statement cannot open with one", () => {
      expect(keywordOf("# note\nUPDATE t SET a = 1")).toBe("UPDATE");
    });
  });

  // ── Where the leading comment ENDS is the dialect's answer (#300) ────────
  //
  // The trivia scan is `readSqlSpan`'s now, so this reader and the ones that walk
  // the rest of the statement read a comment the same way - which they did not
  // before, and the difference was invisible until a dialect that NESTS block
  // comments met a statement carrying one.

  describe("reads leading trivia under the grammar it is given", () => {
    const POSTGRES = resolveSqlGrammar("postgres");
    const MSSQL = resolveSqlGrammar("mssql");
    const MYSQL = resolveSqlGrammar("mysql");

    // The word after the inner `*/` is what a flat reading reports, and it is not a
    // keyword the statement has - it is a word the operator commented out.
    const NESTED = "/* note /* inner */ still a note */ DROP TABLE users";

    test.each<[string, SqlGrammar]>([
      ["postgres", POSTGRES],
      ["mssql", MSSQL],
    ])("a nesting grammar (%s) reads past the whole comment to the real keyword", (_label, grammar) => {
      expect(keywordOf(NESTED, grammar)).toBe("DROP");
    });

    test.each<[string, SqlGrammar | undefined]>([
      ["mysql", MYSQL],
      ["no dialect at all", undefined],
    ])("a flat grammar (%s) keeps reporting the word inside the comment tail", (_label, grammar) => {
      // Not a regression and not a guess: MySQL closes the comment at the first
      // `*/`, so `still a note */ DROP …` really is what follows it there - text
      // MySQL rejects outright. The answer is pinned so the flat reading stays a
      // decision rather than whatever the scan happens to do.
      expect(keywordOf(NESTED, grammar)).toBe("STILL");
    });

    test("a nested comment that never closes answers null under a nesting grammar", () => {
      expect(readLeadingKeyword("/* note /* inner */ DROP TABLE users", POSTGRES)).toBeNull();
    });

    /**
     * `#` in LEADING trivia stays dialect-blind, on purpose.
     *
     * It is a comment marker in MySQL and ClickHouse and ordinary code in the rest,
     * but no dialect here can OPEN a statement with one - `#tmp`, `#>` and `ID#` are
     * all mid-statement forms - so skipping the run costs nothing anywhere and
     * keeps every dialect's annotated statement bounded, which is what #275 fixed.
     * Reading it as code instead would have taken the bound back off a
     * `# note`-led SELECT on SQL Server and PostgreSQL.
     */
    test.each<[string, SqlGrammar | undefined]>([
      ["postgres", POSTGRES],
      ["mssql", MSSQL],
      ["mysql", MYSQL],
      ["no dialect at all", undefined],
    ])("skips a leading hash comment under %s", (_label, grammar) => {
      expect(keywordOf("# note\nSELECT 1", grammar)).toBe("SELECT");
      expect(keywordOf("#- note\nSELECT 1", grammar)).toBe("SELECT");
    });

    // A literal is the statement's own text, not trivia, so the scan stops at one
    // rather than stepping over it looking for a word. The edge matters because
    // `readSqlSpan` answers for literals too, and treating every span as trivia
    // would report `UPDATE` for `'x' UPDATE t SET …`.
    test.each<[string, string]>([
      ["a string", "'x' SELECT 1"],
      ["a backtick-quoted name", "`x` SELECT 1"],
      ["a dollar-quoted body", "$fn$ x $fn$ SELECT 1"],
      ["a bracket-quoted name", "[x] SELECT 1"],
    ])("answers null when %s precedes the first word", (_label, sql) => {
      expect(readLeadingKeyword(sql)).toBeNull();
    });

    // The same rule under Oracle's grammar, where one more form is a literal: the
    // alternate-quote tag opens with a letter, so a reader without the form answers
    // `Q` for this input and Oracle's answers null - the literal is the statement's
    // own text, and a statement cannot open with one.
    test("answers null for an Oracle alternate-quoted literal, under Oracle's grammar only", () => {
      expect(keywordOf("q'{x}' FROM dual")).toBe("Q");
      expect(keywordOf("q'{x}' FROM dual", resolveSqlGrammar("oracle"))).toBeNull();
    });
  });

  // ── Vocabulary-agnostic by design ───────────────────────────────────────
  //
  // The primitive reports whichever word leads the statement rather than testing
  // against a fixed keyword list, because its callers disagree about the list: the
  // query limiter classifies SELECT/INSERT/UPDATE/DELETE/DDL/WITH, while
  // `isReadOnlyQuery` also counts SHOW, DESCRIBE, EXPLAIN and PRAGMA. Neither is
  // wired to this yet — both arrive with the query-limiter half of #275 — so the
  // keywords are covered here to keep that change a rewiring, not a widening.

  describe("reports whichever keyword leads the statement", () => {
    test.each<[string, string]>([
      ["INSERT", "-- annotated\nINSERT INTO t VALUES (1)"],
      ["UPDATE", "/* annotated */ UPDATE t SET a = 1"],
      ["DELETE", "-- annotated\nDELETE FROM t"],
      ["CREATE", "-- annotated\nCREATE TABLE t (id INT)"],
      ["ALTER", "-- annotated\nALTER TABLE t ADD COLUMN a INT"],
      ["DROP", "-- annotated\nDROP TABLE t"],
      ["TRUNCATE", "-- annotated\nTRUNCATE TABLE t"],
      ["WITH", "-- annotated\nWITH t AS (SELECT 1) SELECT * FROM t"],
      ["PRAGMA", "-- annotated\nPRAGMA table_info(t)"],
      ["EXPLAIN", "/* annotated */ EXPLAIN SELECT 1"],
    ])("reports %s", (expected, sql) => {
      expect(keywordOf(sql)).toBe(expected);
    });
  });

  // ── Normalisation ───────────────────────────────────────────────────────

  describe("normalises the keyword to upper case", () => {
    test.each<[string, string]>([
      ["lower case", "select 1"],
      ["mixed case", "SeLeCt 1"],
      ["lower case behind a comment", "-- note\nselect 1"],
    ])("reports %s as SELECT", (_label, sql) => {
      expect(keywordOf(sql)).toBe("SELECT");
    });

    // Case is normalised on the reported keyword only; the offsets still point at
    // the input, so a caller that has to rewrite the statement keeps the original
    // spelling.
    test("leaves the input's own spelling reachable through the offsets", () => {
      const sql = "/* note */ SeLeCt 1";
      const found = readLeadingKeyword(sql);

      expect(found?.keyword).toBe("SELECT");
      expect(sql.slice(found?.start, found?.end)).toBe("SeLeCt");
    });
  });

  // ── Offsets ─────────────────────────────────────────────────────────────
  //
  // The offsets are the reason this returns an object rather than a string: the
  // MSSQL provider has to splice `TOP n` in immediately after the real keyword,
  // and re-scanning for it there would be a second comment scanner.

  describe("reports where the keyword sits in the input", () => {
    test.each<[string, string, string]>([
      ["a bare statement", "SELECT 1", "SELECT"],
      ["a line comment", "-- note\nSELECT 1", "SELECT"],
      ["a block comment", "/* note */ select 1", "select"],
      ["stacked comments", "-- a\n  /* b */\n\t-- c\nUpDaTe t SET a = 1", "UpDaTe"],
      ["leading whitespace only", "\n\t  DELETE FROM t", "DELETE"],
    ])("slices back to the keyword as written for %s", (_label, sql, written) => {
      const found = readLeadingKeyword(sql);

      expect(found).not.toBeNull();
      expect(sql.slice(found?.start, found?.end)).toBe(written);
    });

    test("reports start 0 when nothing precedes the keyword", () => {
      expect(readLeadingKeyword("SELECT 1")).toEqual({ keyword: "SELECT", start: 0, end: 6 });
    });

    test("reports the offset past the comment when one precedes the keyword", () => {
      const sql = "-- note\nSELECT 1";

      expect(readLeadingKeyword(sql)).toEqual({ keyword: "SELECT", start: 8, end: 14 });
    });
  });

  // ── No keyword at all ───────────────────────────────────────────────────

  describe("answers null when the input holds no keyword", () => {
    test.each<[string, string]>([
      ["an empty string", ""],
      ["whitespace only", "   \n\t "],
      ["a line comment alone", "-- only a comment"],
      ["a line comment alone, newline-terminated", "-- only a comment\n"],
      ["a hash comment alone", "# only a comment"],
      ["a hash comment alone, newline-terminated", "# only a comment\n"],
      ["a block comment alone", "/* only a comment */"],
      ["several comments and nothing else", "-- a\n/* b */\n-- c"],
      ["an unterminated block comment", "/* unterminated SELECT 1"],
      ["a statement that opens with a parenthesis", "(SELECT 1) UNION (SELECT 2)"],
      ["a statement that opens with a digit", "1 + 1"],
    ])("returns null for %s", (_label, sql) => {
      expect(readLeadingKeyword(sql)).toBeNull();
    });
  });

  // ── What must NOT win ───────────────────────────────────────────────────
  //
  // A keyword mentioned inside trivia or inside the statement's own text is not
  // the LEADING keyword. Getting this wrong would make the query limiter classify
  // `-- remember to UPDATE this\nSELECT ...` as a write and skip its LIMIT.

  describe("is not fooled by a keyword that is not the leading one", () => {
    test.each<[string, string, string]>([
      ["inside a line comment body", "-- remember to UPDATE this\nSELECT 1", "SELECT"],
      ["inside a hash comment body", "# remember to UPDATE this\nSELECT 1", "SELECT"],
      ["inside a block comment body", "/* was a DELETE once */ SELECT 1", "SELECT"],
      ["inside a string literal", "SELECT 'update' FROM t", "SELECT"],
      ["later in the statement", "SELECT * FROM t WHERE a IN (SELECT 1)", "SELECT"],
      ["as part of a longer word", "SELECTED 1", "SELECTED"],
      ["as part of a longer word with an underscore", "WITH_A_TAIL 1", "WITH_A_TAIL"],
      ["as part of a longer word with a digit", "SELECT2 1", "SELECT2"],
    ])("reads past a keyword %s", (_label, sql, expected) => {
      expect(keywordOf(sql)).toBe(expected);
    });
  });

  // ── Shape of the scan ───────────────────────────────────────────────────

  /**
   * Regression guard on the SHAPE of the trivia scan, not on what it accepts.
   *
   * The scan is `readSqlSpan`'s now (#300) - one span or one character at a time, so
   * it cannot backtrack at all - and this guard is what keeps it that way: a reader
   * that goes back to a pattern over the same trivia grammar would reintroduce one of
   * the three ambiguities below and this test would fail on time rather than on an
   * answer.
   *
   * The pattern this replaced travelled here from `lib/explain/select-prefix.ts`,
   * where all three ambiguities were measured on real predecessors and one was found
   * by CodeQL rather than by a guard like this one. Each is a different way of
   * matching the same text twice inside a `*` quantifier, which is what lets a
   * NON-matching input backtrack:
   *
   *   a leading `\s*` beside a `\s` alternative      quadratic    958ms / 20k spaces
   *   a lazy `[\s\S]*?\*\/` spanning two comments    quadratic    852ms / 4 KB
   *   `--[^\n]*` with no `(?:\n|$)` tail             EXPONENTIAL  634ms / 49 chars
   *
   * The hash alternative carried the same anchor requirement as the dash one, and a
   * run of single `#` characters partitions even more freely than a run of `--`
   * pairs, so it is guarded on the same shapes.
   *
   * EVERY input here ends in a character that cannot open a word, which is what makes
   * this a TIMING guard rather than a correctness one: the read has to fail, so a
   * pattern-shaped reader is forced to try every partition of the trivia. That tail is
   * load-bearing and easy to get wrong. Measured against the anchorless
   * `--[^\n]*` mutation while writing this guard:
   *
   *   `${"--".repeat(24)}X`   matches "X" in 0.0ms                  <- proves nothing
   *   `${"--".repeat(24)}(`   no match, 0.7s on bun, 56s on node    <- the trap, caught
   *
   * With a letter tail the mutation finds a keyword immediately and never searches,
   * so only the null assertion below would catch it. A guard that cannot fail on
   * time is not a guard on the shape. (The scanner answers every input here in
   * well under a millisecond, so the numbers below are the failure mode's, not its.)
   *
   * Both engine numbers are recorded because they differ by two orders of magnitude
   * and the SMALLER one is what this suite sees: JSC caps backtracking (it plateaus
   * near 0.7s from ~20 dash pairs upward), while V8 grows cleanly exponentially past
   * a minute. Anyone re-measuring under `bun test` and finding "only" 0.7s has not
   * found an exaggeration - it still clears the bound below by 3x, and the scanner
   * answers that same input in 0.001ms, five orders of magnitude away.
   *
   * The bound is loose on purpose (three orders of magnitude above what the scan
   * needs) so it cannot flake on a slow runner while still failing outright if any of
   * the three ambiguities returns.
   */
  test("does not backtrack on long comment or whitespace runs that never reach a keyword", () => {
    const BOUND_MS = 200;
    const adversarial: [string, string][] = [
      ["20k leading spaces", `${" ".repeat(20000)}(1)`],
      ["4 KB of empty block comments", `${"/**/".repeat(1000)}(1)`],
      ["block comments with bodies", `${"/*a*/".repeat(1000)}(1)`],
      ["line comments with newlines", `${"-- a\n".repeat(1000)}(1)`],
      ["hash comments with newlines", `${"# a\n".repeat(1000)}(1)`],
      ["mixed comments and whitespace", `${"/**/ -- a\n # b\n ".repeat(1000)}(1)`],
      ["24 bare dash pairs", `${"--".repeat(24)}(`],
      ["2k bare dash pairs", `${"--".repeat(2000)}(`],
      ["20k bare dashes", `${"-".repeat(20000)}(`],
      ["24 bare hashes", `${"#".repeat(24)}(`],
      ["2k bare hashes", `${"#".repeat(2000)}(`],
    ];

    for (const [label, sql] of adversarial) {
      const started = performance.now();
      const result = readLeadingKeyword(sql);
      const elapsed = performance.now() - started;

      // A correct answer AND a bounded one: a fast wrong answer is not a pass.
      expect(result).toBeNull();
      expect(elapsed, `${label} took ${elapsed.toFixed(1)}ms`).toBeLessThan(BOUND_MS);
    }
  });

  /**
   * The same guard under a grammar that NESTS block comments (#300).
   *
   * Counting depth is what could have reintroduced the cost the pattern above was
   * shaped to avoid, so it is asserted rather than assumed: the scan is a single
   * forward pass that consumes each comment once, and an adversarial nest - a run
   * of openers that never closes, and a deeply balanced one - stays linear.
   */
  test("stays bounded under a nesting grammar, on nests that never close and nests that do", () => {
    const BOUND_MS = 200;
    const POSTGRES = resolveSqlGrammar("postgres");
    const adversarial: [string, string, string | null][] = [
      ["20k unclosed openers", `${"/*".repeat(20000)}(`, null],
      ["20k balanced levels", `${"/*".repeat(20000)}${"*/".repeat(20000)}(`, null],
      ["4 KB of empty block comments", `${"/**/".repeat(1000)}(1)`, null],
      ["1k nested pairs, reaching a keyword", `${"/*a/*b*/c*/".repeat(1000)}SELECT 1`, "SELECT"],
    ];

    for (const [label, sql, expected] of adversarial) {
      const started = performance.now();
      const result = readLeadingKeyword(sql, POSTGRES);
      const elapsed = performance.now() - started;

      expect(result?.keyword ?? null).toBe(expected);
      expect(elapsed, `${label} took ${elapsed.toFixed(1)}ms`).toBeLessThan(BOUND_MS);
    }
  });

  test("stays fast on a large licence header that DOES reach a keyword", () => {
    const header = `/*\n${" * Licence line filler.\n".repeat(400)} */\n`;
    const started = performance.now();

    expect(keywordOf(`${header}SELECT 1`)).toBe("SELECT");
    expect(performance.now() - started).toBeLessThan(200);
  });
});
