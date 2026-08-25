import { describe, test, expect } from "bun:test";
import { DEFAULT_SQL_GRAMMAR, resolveSqlGrammar, type SqlGrammar } from "@/lib/sql/grammar";
import { hasUnterminatedSpan, readSqlSpan } from "@/lib/sql/spans";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** The span at index 0, as `kind|text` (or `null`), which is what most cases assert. */
function spanOf(sql: string, index = 0, grammar?: SqlGrammar): string | null {
  const span = readSqlSpan(sql, index, grammar);
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

  // ── The `#` reading is the dialect's, when a dialect is named (#292) ─────
  //
  // Every case above is a call that names NO dialect, and all of them keep their
  // answers: the default is today's hybrid reading, pinned as a decision in
  // `grammar.test.ts`. A call that DOES name one gets that dialect's rule, which
  // is what removes the "the module takes one engine's side" trade above - not
  // for the default, but for every caller that knows which engine it is talking
  // to, and after #292 that is all of them.

  describe("a named dialect decides what `#` means", () => {
    const MYSQL = resolveSqlGrammar("mysql");
    const POSTGRES = resolveSqlGrammar("postgres");

    test("a comment grammar reads an operator-tailed hash as a comment", () => {
      expect(spanOf("#- note\nSELECT 1", 0, MYSQL)).toBe("line-comment|#- note\n");
      expect(spanOf("SELECT 1 #> note", 9, MYSQL)).toBe("line-comment|#> note");
    });

    test("a code grammar reads even a plainly-written hash comment as code", () => {
      expect(readSqlSpan("# note\nSELECT 1", 0, POSTGRES)).toBeNull();
      expect(readSqlSpan("SELECT * FROM #tmp", 14, POSTGRES)).toBeNull();
    });

    test("a dialect changes nothing about the `--` comment, which no dialect disputes", () => {
      expect(spanOf("-- note\nSELECT 1", 0, POSTGRES)).toBe("line-comment|-- note\n");
      expect(spanOf("-- note\nSELECT 1", 0, MYSQL)).toBe("line-comment|-- note\n");
    });

    // A `#` inside a literal is the literal's, whatever the dialect says about a
    // bare one - the branch order has to keep the quote reader in front.
    test("a hash inside a quoted run is not read as a comment under any grammar", () => {
      expect(spanOf("`a#b` FROM t", 0, MYSQL)).toBe("quoted-identifier|`a#b`");
      expect(spanOf("'# not a comment'", 0, POSTGRES)).toBe("string|'# not a comment'");
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

  // ── A second opener inside a comment is the dialect's answer (#300) ───────
  //
  // The cases above all call without a dialect and keep the reading this module
  // always had: the first `*/` closes the run. Where a dialect NESTS them, that
  // reading hands the text between the first `*/` and the comment's real end to
  // the readers above as code - and both of them are then wrong at once, because
  // a `)` in there ends a CTE body early (so the statement is typed by a keyword
  // written inside a comment) and the keyword the confirmation gate reads is one
  // the operator commented out.

  describe("a named dialect decides where a block comment ends", () => {
    const POSTGRES = resolveSqlGrammar("postgres");
    const MSSQL = resolveSqlGrammar("mssql");
    const CLICKHOUSE_G = resolveSqlGrammar("clickhouse");
    const MYSQL = resolveSqlGrammar("mysql");
    const SQLITE = resolveSqlGrammar("sqlite");
    const ORACLE_G = resolveSqlGrammar("oracle");

    const NESTED = "/* a /* b */ c */ SELECT 1";

    test.each<[string, SqlGrammar]>([
      ["postgres", POSTGRES],
      ["mssql", MSSQL],
      ["clickhouse", CLICKHOUSE_G],
    ])("a nesting grammar (%s) reads the inner comment as part of the outer one", (_label, grammar) => {
      expect(spanOf(NESTED, 0, grammar)).toBe("block-comment|/* a /* b */ c */");
    });

    test.each<[string, SqlGrammar | undefined]>([
      ["mysql", MYSQL],
      ["sqlite", SQLITE],
      ["oracle", ORACLE_G],
      ["no dialect at all", undefined],
    ])("a flat grammar (%s) closes it at the first delimiter", (_label, grammar) => {
      expect(spanOf(NESTED, 0, grammar)).toBe("block-comment|/* a /* b */");
    });

    // The fail-safe half of the nesting reading: one opener too many means the
    // comment never closes, so the span is undeterminable rather than guessed -
    // which costs a bound and, since #297, asks for a confirmation.
    test("a nesting grammar reports an unclosed nested comment as undeterminable", () => {
      expect(readSqlSpan("/* a /* b */ DROP TABLE t", 0, POSTGRES)).toEqual({
        kind: "block-comment",
        end: 25,
        terminated: false,
      });
    });

    test("depth is counted, not matched: three levels close in order", () => {
      expect(spanOf("/*1 /*2 /*3 */ 2*/ 1*/ SELECT", 0, POSTGRES)).toBe("block-comment|/*1 /*2 /*3 */ 2*/ 1*/");
    });

    test.each<[string, string]>([
      ["an empty comment", "/**/"],
      ["a comment holding a lone star", "/* a * b */"],
      ["a comment with a body", "/*a*/"],
    ])("a nesting grammar answers %s exactly as the flat reading does", (_label, sql) => {
      expect(spanOf(`${sql} SELECT 1`, 0, POSTGRES)).toBe(`block-comment|${sql}`);
      expect(spanOf(`${sql} SELECT 1`, 0)).toBe(`block-comment|${sql}`);
    });

    // Adjacent comments do not nest into each other: the first closes at depth zero,
    // and the second is a separate span. Worth asserting because a depth counter that
    // kept scanning past a zero crossing would swallow both.
    test("a nesting grammar ends the first of two adjacent comments at its own closer", () => {
      expect(spanOf("/*a*//*b*/SELECT 1", 0, POSTGRES)).toBe("block-comment|/*a*/");
      expect(spanOf("/*a*//*b*/SELECT 1", 5, POSTGRES)).toBe("block-comment|/*b*/");
    });

    // An empty nested comment is the smallest input where the two readings differ,
    // so it belongs here rather than in the list above: the nesting reading needs
    // both closers, the flat one stops at the first.
    test("the two readings of an empty nested comment differ by its second closer", () => {
      expect(spanOf("/*/**/*/ SELECT 1", 0, POSTGRES)).toBe("block-comment|/*/**/*/");
      expect(spanOf("/*/**/*/ SELECT 1", 0)).toBe("block-comment|/*/**/");
    });

    // `/*/` is one opener and no closer: the slash the two delimiters share is
    // consumed by the opener, so this never closes under either reading.
    test.each<[string, SqlGrammar | undefined]>([
      ["a nesting grammar", POSTGRES],
      ["the default", undefined],
    ])("%s leaves `/*/` unterminated", (_label, grammar) => {
      expect(readSqlSpan("/*/", 0, grammar)).toEqual({ kind: "block-comment", end: 3, terminated: false });
    });

    // Inside a comment there are no literals, in this reader and in the engines it
    // is reading for: a `/*` written inside a quoted-looking run is still an
    // opener, and a `*/` inside one still closes. Asserted because the opposite
    // guess - looking for literals inside comment text - is the plausible wrong fix.
    test("a quote inside comment text neither opens a literal nor hides a delimiter", () => {
      expect(spanOf("/* it's /* deep */ still */ SELECT 1", 0, POSTGRES)).toBe(
        "block-comment|/* it's /* deep */ still */",
      );
    });

    // A comment is trivia, so a nested one cannot be part of a statement's text -
    // but a nested comment INSIDE a bracketed subscript is crossed by the run that
    // contains it, and that run has to stay one span (#295).
    test("a nested comment inside a ClickHouse subscript is crossed with the run", () => {
      expect(spanOf("[1 /* ] /* deep */ still */, 2] x", 0, CLICKHOUSE_G)).toBe(
        "subscript|[1 /* ] /* deep */ still */, 2]",
      );
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

  // ── Alternate quoting (Oracle's `q'…'`) ─────────────────────────────────
  //
  // The form exists so that a literal can carry apostrophes without doubling
  // them, which is exactly what makes reading it as code so damaging: the first
  // apostrophe INSIDE the body opens a string, and everything after it is read one
  // construct out of step. A `)` there ends a CTE body early and a `--` there
  // turns the rest of the literal into what looks like trailing trivia (#292).
  //
  // Oracle is the only dialect here with the form, so the branch is reached only
  // under its grammar; every other dialect reads the same characters as a name
  // followed by an ordinary string, which is what they are there.

  describe("alternate quoting (`q'…'`, Oracle)", () => {
    const ORACLE = resolveSqlGrammar("oracle");

    // The delimiter pairs node-oracledb's own tokenizer accepts: the four bracket
    // forms close with their partner, every other character with itself.
    test.each<[string, string, string]>([
      ["a brace-delimited body", "q'{it's}' x", "string|q'{it's}'"],
      ["a bracket-delimited body", "q'[it's]' x", "string|q'[it's]'"],
      ["a paren-delimited body", "q'(it's)' x", "string|q'(it's)'"],
      ["an angle-delimited body", "q'<it's>' x", "string|q'<it's>'"],
      ["an arbitrary delimiter closing with itself", "q'!it's!' x", "string|q'!it's!'"],
      ["an upper-case tag", "Q'{it's}' x", "string|Q'{it's}'"],
      // The national-character-set spelling of the same form, whose body rules are
      // identical - Oracle's SQL Language Reference gives `nq'#…#'` for NCHAR.
      ["the national-charset tag", "nq'{it's}' x", "string|nq'{it's}'"],
      ["an upper-case national-charset tag", "NQ'{it's}' x", "string|NQ'{it's}'"],
      ["a mixed-case national-charset tag", "nQ'{it's}' x", "string|nQ'{it's}'"],
    ])("reads %s as one literal", (_label, sql, expected) => {
      expect(spanOf(sql, 0, ORACLE)).toBe(expected);
    });

    // The closer ends the body only where a quote follows it, which is what lets
    // the delimiter character itself appear inside the literal.
    test("a closing delimiter with no quote after it does not end the body", () => {
      expect(spanOf("q'{a}b}' x", 0, ORACLE)).toBe("string|q'{a}b}'");
      expect(spanOf("q'!a!b!' x", 0, ORACLE)).toBe("string|q'!a!b!'");
    });

    test("a paren, a comment marker and a write keyword inside the body belong to the body", () => {
      expect(spanOf("q'{it's ) -- DELETE FROM users}' x", 0, ORACLE)).toBe("string|q'{it's ) -- DELETE FROM users}'");
    });

    // A body that never closes hides whatever follows it, so the reader says so
    // rather than picking one of the two places the literal could end.
    test.each<[string, string, number]>([
      ["a body that never closes", "q'{abc", 6],
      ["a tag with nothing after it", "q'", 2],
      ["a national-charset body that never closes", "nq'{abc", 7],
    ])("reports %s as undeterminable", (_label, sql, end) => {
      expect(readSqlSpan(sql, 0, ORACLE)).toEqual({ kind: "string", end, terminated: false });
    });

    test.each<[string, string]>([
      ["the plain tag", "q'{it's}' x"],
      ["the national-charset tag", "nq'{it's}' x"],
    ])("a grammar without the form reads %s as code", (_label, sql) => {
      expect(readSqlSpan(sql, 0)).toBeNull();
      expect(readSqlSpan(sql, 0, resolveSqlGrammar("postgres"))).toBeNull();
    });

    // The tag has to START a token. Oracle's lexer reads a name greedily, so
    // `freq'x'` is a name followed by a string there too - and without the check
    // the two kinds of reader in this folder would disagree about it: the ones that
    // read whole words step over the name and never ask here, while the ones that
    // walk character by character would ask at its last letter.
    test.each<[string, string, number]>([
      ["inside a longer name", "SELECT freq'{x}'", 10],
      ["whose national-charset spelling sits inside a longer name", "SELECT frenq'{x}'", 10],
      ["at the `q` of a national-charset tag, which the span starts one earlier", "nq'{it's}'", 1],
    ])("a tag %s does not open the form", (_label, sql, index) => {
      expect(readSqlSpan(sql, index, ORACLE)).toBeNull();
    });

    // The body search is an `indexOf` for two characters, so it cannot backtrack -
    // and this guard is what stops anyone replacing it with a pattern that can.
    test("answers in bounded time on a long body that never closes", () => {
      const sql = `q'{${"a".repeat(20000)}`;

      const started = performance.now();
      const span = readSqlSpan(sql, 0, ORACLE);
      const elapsed = performance.now() - started;

      expect(span).toEqual({ kind: "string", end: sql.length, terminated: false });
      expect(elapsed, `took ${elapsed.toFixed(1)}ms`).toBeLessThan(200);
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

// ─── Bracket-quoted identifiers ──────────────────────────────────────────────
//
// `[…]` quotes an identifier in SQL Server and SQLite, and everything inside it is
// the NAME - a comment marker, a paren, a semicolon. Leaving it as code let the
// statement-end reader treat the `--` in `SELECT [a--b] FROM t` as trailing trivia,
// and #280's insert-before-trivia rewrite then spliced the bound INSIDE the
// identifier: `SELECT [a LIMIT 500--b] FROM t`. Reported by review on PR #299.

describe("readSqlSpan: bracket-quoted identifiers", () => {
  test("reads a bracketed name as one opaque span", () => {
    expect(spanOf("[Order Date]")).toBe("quoted-identifier|[Order Date]");
    expect(spanOf("SELECT [a--b] FROM t", 7)).toBe("quoted-identifier|[a--b]");
    expect(spanOf("[a/*b*/c]")).toBe("quoted-identifier|[a/*b*/c]");
    expect(spanOf("[a;b]")).toBe("quoted-identifier|[a;b]");
  });

  test("a doubled closing bracket is an escape, not the end", () => {
    // SQL Server spells a `]` inside a name by doubling it.
    expect(spanOf("[a]]b]")).toBe("quoted-identifier|[a]]b]");
  });

  test("reports an unterminated bracket rather than guessing where it ends", () => {
    const span = readSqlSpan("[abc", 0);
    expect(span?.terminated).toBe(false);
    expect(span?.end).toBe(4);
  });
});

// ─── Bracketed subscripts (#295) ─────────────────────────────────────────────
//
// The same characters are an array literal or a subscript in ClickHouse, where
// they NEST and nothing is escaped, so the name reading above ends the run at the
// wrong place twice over: at a `]` written inside a string (`m['a]b']`) and at the
// first `]` of a nested array (`[[1,2],[3,4]]`, whose `]]` the name reading then
// takes for an escape and never closes). Both cost the statement its bound. The
// two grammars are mutually exclusive - teaching the name scan to step over
// literals would break a legal SQL Server name like `[it's]` - so the reading
// comes from the dialect.

describe("readSqlSpan: bracketed subscripts", () => {
  const CLICKHOUSE = resolveSqlGrammar("clickhouse");
  const MSSQL = resolveSqlGrammar("mssql");

  test("reads an array literal as one span", () => {
    expect(spanOf("[1,2] AS a", 0, CLICKHOUSE)).toBe("subscript|[1,2]");
    expect(spanOf("m['k'] FROM t", 1, CLICKHOUSE)).toBe("subscript|['k']");
  });

  test("nests, so an inner array does not end the outer one", () => {
    expect(spanOf("[[1,2],[3,4]] AS a", 0, CLICKHOUSE)).toBe("subscript|[[1,2],[3,4]]");
    expect(spanOf("[[[1]]] x", 0, CLICKHOUSE)).toBe("subscript|[[[1]]]");
  });

  test("a close bracket inside a literal does not end the run", () => {
    expect(spanOf("['a]b'] AS v", 0, CLICKHOUSE)).toBe("subscript|['a]b']");
    expect(spanOf('["a]b"] AS v', 0, CLICKHOUSE)).toBe('subscript|["a]b"]');
  });

  test("a close bracket inside a comment does not end it either", () => {
    expect(spanOf("[1 /* ] */, 2] x", 0, CLICKHOUSE)).toBe("subscript|[1 /* ] */, 2]");
    // `#` is a comment in ClickHouse, which is the T1a row of the same record:
    // the two facts have to hold at once inside one run.
    expect(spanOf("[1 # ]\n, 2] x", 0, CLICKHOUSE)).toBe("subscript|[1 # ]\n, 2]");
  });

  test("a doubled close bracket is not an escape here", () => {
    // The mutually exclusive half, asserted on one input: `]]` closes the run
    // under the subscript reading (it is how a nested array ends) and escapes a
    // name character under SQL Server's.
    expect(spanOf("[a]]b] x", 0, CLICKHOUSE)).toBe("subscript|[a]");
    expect(spanOf("[a]]b] x", 0, MSSQL)).toBe("quoted-identifier|[a]]b]");
  });

  test("reports an unterminated subscript rather than guessing where it ends", () => {
    expect(readSqlSpan("[1,2", 0, CLICKHOUSE)).toEqual({ kind: "subscript", end: 4, terminated: false });
    // Depth is counted, so a run that closes one bracket short is unterminated too.
    expect(readSqlSpan("[[1,2]", 0, CLICKHOUSE)).toEqual({ kind: "subscript", end: 6, terminated: false });
  });

  test("a literal inside that cannot be resolved makes the whole run unterminated", () => {
    // The span reader reports a quote behind an odd backslash run as
    // undeterminable, and a run built on top of one cannot be more certain than
    // what it contains. Answering `terminated` here would put the end of the
    // statement inside a literal.
    expect(readSqlSpan("['a", 0, CLICKHOUSE)).toEqual({ kind: "subscript", end: 3, terminated: false });
    expect(readSqlSpan("['a\\'] AS v", 0, CLICKHOUSE)?.terminated).toBe(false);
  });
});

// ─── Text no reader can resolve (#297) ───────────────────────────────────────
//
// Every reader over this module discards `terminated: false` after acting on it:
// the limiter declines to rewrite, `findCodeWord` reports the word it could not
// see as absent. The confirmation gate needs the signal ITSELF - a span that never
// closes hides whatever is written inside it, and answering "not dangerous" for
// text a reader cannot read is the one direction that costs more than a click.

describe("hasUnterminatedSpan", () => {
  test.each<[string, string]>([
    ["a plain read", "SELECT * FROM users"],
    ["a closed literal", "SELECT name FROM users WHERE name = 'O''Brien'"],
    ["a backslash inside a literal", "SELECT 'a\\nb' FROM t"],
    ["a literal ending in a doubled backslash", "SELECT 'C:\\\\Users\\\\me' FROM files"],
    ["stacked comments", "-- one\n/* two */\n-- three\nSELECT 1"],
    ["a line comment closed by the end of the input", "SELECT 1 -- note"],
    ["a dollar-quoted body", "SELECT $fn$ begin end $fn$"],
    ["a bracket-quoted name", "SELECT [a--b] FROM t"],
    ["a backtick-quoted name", "SELECT `a b` FROM t"],
    ["text holding no span at all", "1+1"],
    ["nothing", ""],
  ])("answers false for %s", (_label, sql) => {
    expect(hasUnterminatedSpan(sql)).toBe(false);
  });

  test.each<[string, string]>([
    ["a quote behind an odd backslash run", "SELECT '\\';\nUPDATE t SET x = 1"],
    ["a literal that never closes", "SELECT 'unclosed FROM t"],
    ["a block comment that never closes", "SELECT 1 /* unclosed"],
    ["a dollar-quoted body that never closes", "SELECT $fn$ begin"],
    ["a bracket-quoted name that never closes", "SELECT [name FROM t"],
    ["a double-quoted name that never closes", 'SELECT "name FROM t'],
  ])("answers true for %s", (_label, sql) => {
    expect(hasUnterminatedSpan(sql)).toBe(true);
  });

  // The signal is the GRAMMAR's answer, not this module's: the same characters are
  // resolvable under one dialect's reading and not under another's, which is the
  // whole reason the dialect reaches these readers (#292, #295).

  test("the dialect decides whether a bracketed run resolves", () => {
    // Under the name reading this closes at the inner `]`; under ClickHouse's
    // array reading the depth never returns to zero.
    const unbalanced = "WITH [[1,2] AS x DELETE FROM t";

    expect(hasUnterminatedSpan(unbalanced)).toBe(false);
    expect(hasUnterminatedSpan(unbalanced, resolveSqlGrammar("clickhouse"))).toBe(true);

    // And the other direction on a nested array that IS balanced: the name reading
    // takes the trailing `]]` for an escape and never closes the run, while
    // ClickHouse's counts depth and closes it. This is the reason the confirmation
    // gate answers the same for both readings of this text and for different
    // reasons - one read the statement, the other could not.
    const nested = "WITH [[1,2],[3,4]] AS x DELETE FROM t";

    expect(hasUnterminatedSpan(nested)).toBe(true);
    expect(hasUnterminatedSpan(nested, resolveSqlGrammar("clickhouse"))).toBe(false);
  });

  test("the dialect decides whether a nested comment resolves", () => {
    // One opener too many: flat reading closes at the first `*/` and reads the
    // rest as code, while a nesting dialect is still inside the comment when the
    // input runs out - so the same text is resolvable under one and not the other,
    // and the gate asks only where it cannot be read (#300).
    const unclosed = "/* a /* b */ DROP TABLE users";

    expect(hasUnterminatedSpan(unclosed)).toBe(false);
    expect(hasUnterminatedSpan(unclosed, resolveSqlGrammar("mysql"))).toBe(false);
    expect(hasUnterminatedSpan(unclosed, resolveSqlGrammar("postgres"))).toBe(true);

    // Balanced, so a nesting dialect resolves it - and the gate then has to find
    // the DROP by reading the statement rather than by giving up on the text.
    const balanced = "/* a /* b */ c */ DROP TABLE users";

    expect(hasUnterminatedSpan(balanced, resolveSqlGrammar("postgres"))).toBe(false);
  });

  test("answers in bounded time on a deeply nested comment", () => {
    // The depth count is a single forward pass, so an adversarial nest is linear.
    // Unbalanced on purpose: the answer has to be reached by scanning to the end.
    const deep = `${"/*".repeat(20000)} SELECT 1`;

    const started = performance.now();
    const unresolved = hasUnterminatedSpan(deep, resolveSqlGrammar("postgres"));
    const elapsed = performance.now() - started;

    expect(unresolved).toBe(true);
    expect(elapsed, `took ${elapsed.toFixed(1)}ms`).toBeLessThan(200);
  });

  test("the dialect decides whether an alternate-quoted literal resolves", () => {
    // Read as ordinary code the apostrophe inside the body opens a string that
    // swallows the rest of the input; under Oracle's grammar the form closes.
    const alternateQuoted = "SELECT q'{it's}' FROM dual";

    expect(hasUnterminatedSpan(alternateQuoted)).toBe(true);
    expect(hasUnterminatedSpan(alternateQuoted, resolveSqlGrammar("oracle"))).toBe(false);
  });

  test("answers in bounded time on a large input", () => {
    // The gate that consumes this runs on the editor's execute path, where a
    // pasted migration script is ordinary. A scanner that advances one span at a
    // time cannot backtrack - the property this asserts is kept, not assumed.
    const many = `SELECT ${"'lit' /* note */ -- line\n".repeat(20000)}1`;

    const started = performance.now();
    const unresolved = hasUnterminatedSpan(many);
    const elapsed = performance.now() - started;

    expect(unresolved).toBe(false);
    expect(elapsed, `took ${elapsed.toFixed(1)}ms`).toBeLessThan(200);
  });
});

// ── `//`: the third line-comment form, and only where a dialect has it ──────
//
// The fact `grammar.ts` used to say it could not carry. It matters here rather
// than only in the provider that worked around it, because a comment is what a
// `;` can hide INSIDE - and `statement-splitter.ts` reads its boundaries through
// this module, so a `//` read as code hands `/api/db/multi-query` a fragment the
// operator never wrote.
//
// Measured 2026-08-25: a line comment on Cassandra 5.0.9, ScyllaDB 2026.2.4 and
// ClickHouse 26.7.1; refused outright by PostgreSQL 18, MySQL 26.7.0, Oracle Free,
// SQL Server 2022, Trino 476 and SQLite. The rows and their probes are in
// `grammar.test.ts`.

describe("readSqlSpan: `//` line comments", () => {
  const CASSANDRA = resolveSqlGrammar("cassandra");
  const CLICKHOUSE_SLASH = resolveSqlGrammar("clickhouse");
  const POSTGRES_SLASH = resolveSqlGrammar("postgres");
  const TRINO = resolveSqlGrammar("trino");

  test.each<[string, SqlGrammar]>([
    ["cassandra", CASSANDRA],
    ["clickhouse", CLICKHOUSE_SLASH],
  ])("a dialect that has the form reads it as a comment (%s)", (_label, grammar) => {
    expect(spanOf("// note\nSELECT 1", 0, grammar)).toBe("line-comment|// note\n");
    expect(spanOf("SELECT 1 // note\n, 2", 9, grammar)).toBe("line-comment|// note\n");
  });

  // The newline ENDS the run, measured on both engines that have the form:
  // `SELECT 1 AS a // note\n, 2 AS b` answers two columns on ClickHouse, and the
  // same shape returns rows on Cassandra. A run to end-of-input would have hidden
  // the second column.
  test.each<[string, SqlGrammar]>([
    ["cassandra", CASSANDRA],
    ["clickhouse", CLICKHOUSE_SLASH],
  ])("the run ends at the newline rather than at the end of the text (%s)", (_label, grammar) => {
    const span = readSqlSpan("SELECT 1 // note\n, 2", 9, grammar);

    expect(span).toEqual({ kind: "line-comment", end: 17, terminated: true });
  });

  test.each<[string, SqlGrammar]>([
    ["postgres", POSTGRES_SLASH],
    ["trino", TRINO],
    ["no dialect named", DEFAULT_SQL_GRAMMAR],
  ])("a dialect without the form reads it as code (%s)", (_label, grammar) => {
    expect(readSqlSpan("SELECT 1 // note", 9, grammar)).toBeNull();
  });

  // `/` is division everywhere and `//` is a real OPERATOR NAME in PostgreSQL
  // (measured: `SELECT 1 // 2` is "operator does not exist: integer // integer",
  // not a syntax error), so a single slash must never open a run under any grammar.
  test("a lone slash is code even where `//` is a comment", () => {
    expect(readSqlSpan("SELECT 1 / 2", 9, CASSANDRA)).toBeNull();
    expect(readSqlSpan("SELECT 1 /", 9, CASSANDRA)).toBeNull();
  });

  // The branch order has to keep `/*` reachable: both forms open with a slash, and
  // reading `/*` as a `//` run would swallow the rest of the line and lose the
  // comment's real end.
  test("a block comment still opens where `//` is a comment", () => {
    expect(spanOf("/* a */ SELECT 1", 0, CASSANDRA)).toBe("block-comment|/* a */");
    expect(spanOf("/* a\nb */ SELECT 1", 0, CLICKHOUSE_SLASH)).toBe("block-comment|/* a\nb */");
  });

  // `WHERE url = 'http://x'` is an ordinary statement on both engines, so the
  // literal readers stay in front of this one.
  test("a `//` inside a literal or a quoted name is not a comment", () => {
    expect(spanOf("'http://x'", 0, CASSANDRA)).toBe("string|'http://x'");
    expect(spanOf('"a//b" FROM t', 0, CLICKHOUSE_SLASH)).toBe('quoted-identifier|"a//b"');
  });

  // End of input closes it HERE, the same answer this module gives every line
  // comment - and on ClickHouse that is the server's answer too (`SELECT 1 AS a //
  // note` returns 1). CQL disagrees, which is a fact about where a statement may
  // END rather than about what the run is, and the reason is on `SqlSpan.terminated`.
  test("a `//` comment with no newline runs to the end and is terminated", () => {
    expect(readSqlSpan("SELECT 1 // note", 9, CLICKHOUSE_SLASH)).toEqual({
      kind: "line-comment",
      end: 16,
      terminated: true,
    });
  });
});

describe("hasUnterminatedSpan: `//`", () => {
  // A `//` run read as CODE leaves whatever follows it to be scanned as SQL, so an
  // apostrophe inside the comment opened a literal that never closed and the
  // confirmation gate asked about a statement CQL reads without trouble.
  test("a comment carrying an apostrophe is resolvable where the dialect has the form", () => {
    const sql = "SELECT id FROM probe.customers // it's fine\n";

    expect(hasUnterminatedSpan(sql, resolveSqlGrammar("cassandra"))).toBe(false);
    expect(hasUnterminatedSpan(sql, DEFAULT_SQL_GRAMMAR)).toBe(true);
  });
});
