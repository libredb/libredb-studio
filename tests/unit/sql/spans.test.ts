import { describe, test, expect } from "bun:test";
import { readSqlSpan } from "@/lib/sql/spans";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** The span at index 0, as `kind|text` (or `null`), which is what most cases assert. */
function spanOf(sql: string, index = 0): string | null {
  const span = readSqlSpan(sql, index);
  return span === null ? null : `${span.kind}|${sql.slice(index, span.end)}`;
}

// ─── readSqlSpan ────────────────────────────────────────────────────────────
//
// The primitive every SQL-text reader in `lib/sql` needs before it can trust a
// character: whether the text at this index is trivia or a literal, and where
// that runs to. Without it, a paren, a semicolon or a keyword written inside a
// comment or a string answers for the statement itself.

describe("readSqlSpan", () => {
  // ── Ordinary code is not a span ──────────────────────────────────────────

  describe("reports null where code begins", () => {
    test.each<[string, string]>([
      ["a letter", "SELECT 1"],
      ["a digit", "1 + 1"],
      ["an open paren", "(1)"],
      ["a semicolon", ";"],
      ["a lone dash (subtraction)", "a - b"],
      ["a lone slash (division)", "a / b"],
      ["a star", "*"],
      ["a lone dollar", "$ "],
      ["a positional parameter", "$1"],
      ["a dollar tag that never closes", "$tag SELECT"],
      ["a dollar tag starting with a digit", "$1$ x"],
    ])("returns null for %s", (_label, sql) => {
      expect(readSqlSpan(sql, 0)).toBeNull();
    });

    test("returns null past the end of the input", () => {
      expect(readSqlSpan("ab", 2)).toBeNull();
      expect(readSqlSpan("", 0)).toBeNull();
    });
  });

  // ── Whitespace ──────────────────────────────────────────────────────────

  describe("whitespace", () => {
    test("reads a whole run of whitespace in one span", () => {
      expect(spanOf(" \t\n\r\f\vSELECT")).toBe("whitespace| \t\n\r\f\v");
    });

    test("reads whitespace at an arbitrary index", () => {
      expect(spanOf("SELECT   1", 6)).toBe("whitespace|   ");
    });

    test("whitespace running to the end of input is terminated", () => {
      expect(readSqlSpan("SELECT 1  ", 8)).toEqual({ kind: "whitespace", end: 10, terminated: true });
    });
  });

  // ── Comments ────────────────────────────────────────────────────────────

  describe("line comments", () => {
    test("a dash comment ends with its newline, which belongs to the span", () => {
      expect(spanOf("-- note\nSELECT 1")).toBe("line-comment|-- note\n");
    });

    test("a hash comment (MySQL) is read the same way", () => {
      expect(spanOf("# note\nSELECT 1")).toBe("line-comment|# note\n");
    });

    // Unlike `leading-keyword.ts`, this reader is asked about every position in a
    // statement, not just the leading trivia - and mid-statement `#` is a live
    // PostgreSQL operator. Reading `meta #> '{a}'` as a comment swallows the rest
    // of the line and costs an ordinary jsonb query its bound.
    test.each<[string, string]>([
      ["#> (jsonb path)", "meta #> '{a}'"],
      ["#>> (jsonb path as text)", "meta #>> '{a}'"],
      ["#- (jsonb delete path)", "meta #- '{a}'"],
      ["## (geometric closest point)", "meta ## other"],
    ])("does not read the PostgreSQL %s operator as a comment", (_label, sql) => {
      expect(readSqlSpan(sql, 5)).toBeNull();
    });

    // The trade that buys the operators back, stated as a test: a MySQL comment
    // whose first character is one of those operator characters reads as code, so
    // the rest of that line is read as SQL where MySQL reads it as comment. That is
    // a real gap rather than a safe "cannot tell" - a paren inside such a comment
    // moves a construct's end, which `operative-keyword.test.ts` pins with the
    // statement it costs. `# note`, how comments are actually written, is untouched.
    test("a hash comment opening with an operator character reads as code", () => {
      expect(readSqlSpan("SELECT 1 #> note", 9)).toBeNull();
    });

    // A line comment closed by the end of the input is closed, not truncated:
    // nothing follows it that a reader could be misled about.
    test("a line comment with no newline runs to the end and is terminated", () => {
      expect(readSqlSpan("SELECT 1 -- note", 9)).toEqual({ kind: "line-comment", end: 16, terminated: true });
    });

    test("an empty line comment is still a span", () => {
      expect(spanOf("--\nSELECT")).toBe("line-comment|--\n");
    });
  });

  describe("block comments", () => {
    test("reads to the first closing delimiter", () => {
      expect(spanOf("/* a */ /* b */ SELECT")).toBe("block-comment|/* a */");
    });

    test("spans newlines", () => {
      expect(spanOf("/* one\n   two */SELECT")).toBe("block-comment|/* one\n   two */");
    });

    // An unterminated block comment is the one case where a reader must NOT
    // assume it knows where the statement's text is: everything after it is
    // comment, so callers bias to "cannot tell" rather than guessing.
    test("an unterminated block comment reports terminated: false", () => {
      expect(readSqlSpan("/* never closed", 0)).toEqual({ kind: "block-comment", end: 15, terminated: false });
    });
  });

  // ── Literals ────────────────────────────────────────────────────────────

  describe("single-quoted strings", () => {
    test("reads a plain string", () => {
      expect(spanOf("'abc' x")).toBe("string|'abc'");
    });

    test("a doubled quote is an escape, not the end", () => {
      expect(spanOf("'it''s' x")).toBe("string|'it''s'");
    });

    test("a paren inside a string belongs to the string", () => {
      expect(spanOf("') SELECT' x")).toBe("string|') SELECT'");
    });

    test("an unterminated string reports terminated: false", () => {
      expect(readSqlSpan("'abc", 0)).toEqual({ kind: "string", end: 4, terminated: false });
    });

    // A run of quotes is all escapes, so it never closes - the trap a
    // "find the next quote" reader falls into.
    test("an odd run of quotes is unterminated", () => {
      expect(readSqlSpan("'''", 0)).toEqual({ kind: "string", end: 3, terminated: false });
    });

    // Whether a backslash escapes the following quote is a DIALECT setting, not a
    // property of the text: MySQL escapes by default, PostgreSQL does not unless
    // the literal is an `E'…'`. The two readings disagree about where the string
    // ends and therefore about the rest of the statement, so a delimiter behind an
    // odd backslash run is reported as undeterminable rather than guessed. The
    // guess is not free: it can put a bound on a statement that writes.
    test("a quote behind an odd backslash run does not close the string", () => {
      expect(readSqlSpan("'a\\' , x", 0)).toEqual({ kind: "string", end: 8, terminated: false });
    });

    test("a quote behind an even backslash run does close it", () => {
      expect(spanOf("'a\\\\' x")).toBe("string|'a\\\\'");
    });

    // The two escape rules can MEET: `\''` is the ordinary way to end a MySQL
    // string with an apostrophe. Testing the doubling rule first consumes both
    // quotes and never reaches the backslash question, so the ambiguity has to be
    // answered BEFORE the doubling branch or the safe answer is unreachable
    // exactly where the two dialects disagree most often.
    test("a doubled quote behind an odd backslash run is undeterminable, not an escape", () => {
      // Taking the doubling branch here ends the literal at the LAST quote instead
      // of reporting the ambiguity, which puts everything between the two readings
      // inside a string under one of them and outside it under the other.
      expect(readSqlSpan("'a\\'' x'", 0)?.terminated).toBe(false);
    });

    test("a backslash immediately after the opening delimiter is still counted", () => {
      expect(readSqlSpan("'\\' , x", 0)?.terminated).toBe(false);
    });
  });

  describe("quoted identifiers", () => {
    test.each<[string, string, string]>([
      ["double quotes (SQL standard)", '"my table" x', 'quoted-identifier|"my table"'],
      ["a doubled double quote is an escape", '"say ""hi""" x', 'quoted-identifier|"say ""hi"""'],
      ["backticks (MySQL)", "`my table` x", "quoted-identifier|`my table`"],
      ["a doubled backtick is an escape", "`a``b` x", "quoted-identifier|`a``b`"],
    ])("reads %s", (_label, sql, expected) => {
      expect(spanOf(sql)).toBe(expected);
    });

    test.each<[string, string]>([
      ["a double-quoted identifier", '"unclosed'],
      ["a backtick-quoted identifier", "`unclosed"],
    ])("an unterminated %s reports terminated: false", (_label, sql) => {
      expect(readSqlSpan(sql, 0)?.terminated).toBe(false);
    });

    // `"` is a STRING in MySQL unless ANSI_QUOTES is set, so it inherits the
    // backslash ambiguity above. Backticks do not: no dialect gives a backslash
    // any meaning inside them, so one behind the closing delimiter is just a
    // character in the name.
    test("a double quote behind an odd backslash run is undeterminable", () => {
      expect(readSqlSpan('"a\\" x', 0)?.terminated).toBe(false);
    });

    test("a backtick behind a backslash still closes the identifier", () => {
      expect(spanOf("`a\\` x")).toBe("quoted-identifier|`a\\`");
    });
  });

  describe("dollar-quoted strings (PostgreSQL)", () => {
    test("reads an untagged $$ body", () => {
      expect(spanOf("$$ a ) b $$ x")).toBe("dollar-string|$$ a ) b $$");
    });

    test("reads a tagged body", () => {
      expect(spanOf("$fn$ BEGIN END $fn$ x")).toBe("dollar-string|$fn$ BEGIN END $fn$");
    });

    test("a tag may carry digits and underscores after its first character", () => {
      expect(spanOf("$_t1$ body $_t1$ x")).toBe("dollar-string|$_t1$ body $_t1$");
    });

    // Tags follow identifier rules, and identifiers are not ASCII. A reader that
    // rejects the tag scans the body as code.
    test("a tag may be non-ASCII", () => {
      expect(spanOf("$gövde$ içerik $gövde$ x")).toBe("dollar-string|$gövde$ içerik $gövde$");
    });

    test("a differently tagged delimiter inside the body does not close it", () => {
      expect(spanOf("$a$ $b$ inner $b$ $a$ x")).toBe("dollar-string|$a$ $b$ inner $b$ $a$");
    });

    test("an unterminated dollar string reports terminated: false", () => {
      expect(readSqlSpan("$$ body", 0)).toEqual({ kind: "dollar-string", end: 7, terminated: false });
    });
  });

  // ── Bounded time ────────────────────────────────────────────────────────
  //
  // This module exists partly because the regex alternative is a ReDoS trap:
  // `leading-keyword.ts` records three measured backtracking failures (quadratic
  // 958ms, quadratic 852ms, exponential 634ms on a 49-character input) in the
  // equivalent pattern. A character scanner cannot backtrack, and this guard is
  // what keeps anyone from replacing it with one that can.

  test("answers in bounded time on adversarial input", () => {
    const BOUND_MS = 200;
    const adversarial: [string, string, boolean][] = [
      // label, input, whether a span is expected at index 0
      ["20k quotes (all escapes, never closes)", "'".repeat(20001), true],
      // The backslash walk-back runs at every candidate delimiter, so a long run
      // followed by many candidates is where a quadratic version of it would show.
      ["a 20k backslash run before a quote", `'${"\\".repeat(20000)}' x`, true],
      ["a 20k backslash run before 10k doubled quotes", `'${"\\".repeat(20000)}${"''".repeat(10000)}`, true],
      ["20k backticks", "`".repeat(20001), true],
      ["a 20k unterminated block comment", `/*${"a".repeat(20000)}`, true],
      ["a 20k line comment", `--${"a".repeat(20000)}`, true],
      ["20k whitespace", " ".repeat(20000), true],
      ["a 20k unterminated dollar string", `$$${"a".repeat(20000)}`, true],
      // A run of dollars is a run of EMPTY dollar-quoted strings (`$$$$` is a
      // valid empty literal in PostgreSQL), so the first two of them are a span.
      ["20k bare dollars", "$".repeat(20000), true],
      // A 20k tag that never closes is not one: the tag scan has to walk the whole
      // run before it can say so, which is the bounded-time case here.
      ["a 20k unclosed dollar tag", `$${"a".repeat(20000)}`, false],
      // The body search is an `indexOf` for the whole tag. A long tag against a
      // body full of near-misses is where a naive character-by-character substring
      // search would degrade to O(n·m), so the guard covers it rather than assuming
      // the engine's sublinear search.
      [
        "a 200-char tag against a 20k near-matching body",
        `$${"a".repeat(200)}$${`$${"a".repeat(199)}$`.repeat(100)}`,
        true,
      ],
    ];

    for (const [label, sql, expectSpan] of adversarial) {
      const started = performance.now();
      const span = readSqlSpan(sql, 0);
      const elapsed = performance.now() - started;

      // A correct answer AND a bounded one: a fast wrong answer is not a pass.
      expect(span === null, label).toBe(!expectSpan);
      expect(elapsed, `${label} took ${elapsed.toFixed(1)}ms`).toBeLessThan(BOUND_MS);
    }
  });
});
