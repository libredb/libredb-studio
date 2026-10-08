import { describe, expect, test } from "bun:test";
import {
  DATABEND_FORM_FEED,
  DATABEND_HINT_SEMICOLON,
  DATABEND_HINT_TOKEN,
  DATABEND_IDENTIFIER_DOLLAR,
  DATABEND_MULTIPLE_STATEMENTS,
  DATABEND_NO_STATEMENT,
  DATABEND_STAGE_RUN_ON,
  DATABEND_TAGGED_DOLLAR,
  DATABEND_UNTERMINATED_SPAN,
  databendStatementRefusal,
} from "@/lib/db/providers/sql/databend/sql-text";
import { applyQueryLimit } from "@/lib/db/utils/query-limiter";

/**
 * The statement guard of design 5.3, which runs before any request. Each refusal is one exported sentence that names
 * the reason and never echoes the text.
 */
describe("databendStatementRefusal", () => {
  // The editor sends a selection of several statements to the multi-statement route, so this refusal reaches a caller
  // that sent one text as one request, and Studio has no Run All control to name (browser verification, 2026-10-08).
  test("the multi-statement refusal asks for one statement at a time and names no control", () => {
    expect(DATABEND_MULTIPLE_STATEMENTS).toBe(
      "Databend runs one statement per request, and when the first is an INSERT or REPLACE it drops the rest without an error. Run the statements one at a time.",
    );
  });

  test.each<[string, string, string]>([
    ["two statements", "SELECT 1; SELECT 2", DATABEND_MULTIPLE_STATEMENTS],
    [
      "an INSERT followed by a DELETE, the escaped quote read as Databend reads it",
      "INSERT INTO t VALUES ('a\\'b'); DELETE FROM t",
      DATABEND_MULTIPLE_STATEMENTS,
    ],
    ["no statement", "-- only a note\n/* and another */", DATABEND_NO_STATEMENT],
    ["empty text", "   ", DATABEND_NO_STATEMENT],
    ["an unterminated literal", "SELECT 'abc", DATABEND_UNTERMINATED_SPAN],
    ["an unterminated block comment", "SELECT 1 /* note", DATABEND_UNTERMINATED_SPAN],
    // I13: Databend's `\\.` does not match a line feed, so the literal does not close there.
    ["a backslash before a line feed inside a literal", "SELECT 'a\\\nb'", DATABEND_UNTERMINATED_SPAN],
    // 11 #7: Databend ends a `--` comment at a form feed, Studio's reader does not.
    ["a form feed that ends a comment in Databend", "-- x\fDROP TABLE t", DATABEND_FORM_FEED],
    // I11: Databend's stage token takes `\'` into the name, so the `;` after it is code there.
    ["a stage name holding a backslash", "SELECT * FROM @s\\'; DROP TABLE t; --'", DATABEND_STAGE_RUN_ON],
    // HASIM-D-2: the stage token `@([^\s,`;'"()]|...)+` takes `--`, `/*`, `$$` and `[` into the name too, where the span
    // reader opens a comment, a dollar string or an array. Measured on v1.2.951: each of the first four texts is 1005
    // "unexpected" at the statement after the `;`, so Databend read that `;` as code, and the fifth fails to lex only
    // at its last `$$`, past the hidden SELECT.
    ["a stage name running into a -- comment", "SELECT 1 FROM @s--;DROP TABLE t", DATABEND_STAGE_RUN_ON],
    ["a stage name running into a block comment", "SELECT 1 FROM @s/*;DROP TABLE t;*/", DATABEND_STAGE_RUN_ON],
    ["a stage name running into a bracket", "SELECT 1 FROM @s[ ; SELECT 2 AS hidden ]", DATABEND_STAGE_RUN_ON],
    ["a stage name inside an array literal", "SELECT [@s/*, 1]; SELECT 2 AS hidden; */ 1]", DATABEND_STAGE_RUN_ON],
    ["a stage name running into a $$ string", "SELECT 1 FROM @s/$$ ; SELECT 2 AS hidden; $$", DATABEND_STAGE_RUN_ON],
    // Databend's `\s` is Unicode White_Space, which U+FEFF is not: `@abc\u{FEFF}--xyz` is the stage `abc\u{FEFF}--xyz`.
    [
      "a stage name running into a comment after U+FEFF",
      "SELECT 1 FROM @s\uFEFF--;DROP TABLE t",
      DATABEND_STAGE_RUN_ON,
    ],
    // No `;` is needed: measured on v1.2.951, `EXPLAIN SELECT * FROM @~/--, numbers((SELECT count(*) FROM numbers(7)))`
    // planned a `numbers` scan of 7 rows, so the argument subquery read here as a comment ran while binding.
    [
      "a stage name running into a comment that hides an argument subquery",
      "EXPLAIN SELECT * FROM @~/--, numbers((SELECT nextval(s)))",
      DATABEND_STAGE_RUN_ON,
    ],
    // The lexer takes the longest token, and `<@` is the one operator that starts with another character and takes an
    // `@` in (`token.rs`: `ArrowAt`), so a run of `<` is read in pairs from its start, `<<` before `<@`: after an even
    // run the `@` opens a stage token.
    // Measured on v1.2.951: `SELECT 2<<@s--;SELECT 3 AS hidden` is 1005 "unexpected `SELECT`" at the second SELECT.
    ["a stage name after a << operator", "SELECT 2<<@s--;SELECT 3 AS hidden", DATABEND_STAGE_RUN_ON],
    ["a stage name after two << operators", "SELECT 2<<<<@s[1]", DATABEND_STAGE_RUN_ON],
    // `@>`, `@?` and `@@` are operators only before an ending character, since the stage token is longer otherwise.
    // Measured on v1.2.951: `SELECT parse_json('[1,2]')@>[1] AS r` is 1005 at the `AS`, so `@>[1]` was one token.
    ["a stage name that starts like the @> operator", "SELECT parse_json('[1,2]')@>[1] AS r", DATABEND_STAGE_RUN_ON],
    // I12: a hint body is tokenized by Databend, so a `;` in it is code there.
    ["an optimizer hint holding a semicolon", "SELECT /*+ SET_VAR(a=1); DROP TABLE t */ 1", DATABEND_HINT_SEMICOLON],
    // D6-1: a token in the hint body that runs past Studio's first `*/` moves Databend's hint end to a later one.
    // Each text ran `SELECT 2 AS hidden` on the pinned image.
    [
      "a hint whose quote runs past the */ Studio reads as its end",
      "/*+ ' */ SELECT 1 AS shown -- ' */ SELECT 2 AS hidden",
      DATABEND_HINT_TOKEN,
    ],
    ["a hint holding a -- comment", "/*+ -- */ SELECT 1 AS shown\n*/ SELECT 2 AS hidden", DATABEND_HINT_TOKEN],
    ["a hint holding a nested block comment", "/*+ /* */ SELECT 1 AS shown */ SELECT 2 AS hidden", DATABEND_HINT_TOKEN],
    // D9-1: Databend lexes `$a$` as a variable (`\$[_a-zA-Z][_$a-zA-Z0-9]*`) and reads what lies between two of them as
    // code, while Studio reads one dollar string. Measured on v1.2.951 as studio_reader: this text is 1005 "unexpected
    // `SELECT`" at column 25, the second SELECT, so Databend parsed the `;` and the statement after it as code.
    [
      "a tagged dollar run that hides a second statement",
      "SELECT $a$, 1 AS shown; SELECT 2 AS hidden; -- $a$",
      DATABEND_TAGGED_DOLLAR,
    ],
    ["a tagged dollar run with nothing hidden in it", "SELECT $tag$ x $tag$", DATABEND_TAGGED_DOLLAR],
    // D6b-1: Databend's identifier tail takes `$` (`is_ident_continue`), so `a$$` is one name there and what Studio reads
    // as a dollar string is code. Measured on v1.2.951 as studio_reader: `SELECT 1 AS a$$, 2 AS b -- $$` answered the
    // columns `a$$` and `b`, and `SELECT 1 AS a$$; SELECT 2 AS hidden; -- $$` is 1005 "unexpected `SELECT`" at column 18.
    [
      "a $$ run straight after an identifier that hides a second statement",
      "SELECT 1 AS a$$; SELECT 2 AS hidden; -- $$",
      DATABEND_IDENTIFIER_DOLLAR,
    ],
    ["a $$ run straight after an underscore", "SELECT 1 AS _$$; SELECT 2; -- $$", DATABEND_IDENTIFIER_DOLLAR],
    ["a $$ run straight after a non-ASCII letter", "SELECT 1 AS é$$; SELECT 2; -- $$", DATABEND_IDENTIFIER_DOLLAR],
    ["a $$ run straight after a digit in a name", "SELECT 1 AS x9$$, 2 AS b -- $$", DATABEND_IDENTIFIER_DOLLAR],
    // An array literal's contents are code to both readers, so the guard walks into one and each reading from the form
    // feed down holds there too. Measured on v1.2.951: both texts are 1005 "unexpected `SELECT`" at `SELECT 2 AS hidden`.
    [
      "a tagged dollar run inside an array literal",
      "SELECT [$a$, 1] AS shown; SELECT 2 AS hidden; -- $a$]",
      DATABEND_TAGGED_DOLLAR,
    ],
    [
      "a hint inside an array literal whose quote runs past its */",
      "SELECT [/*+ ' */ 1] AS shown -- ' */ 1]; SELECT 2 AS hidden",
      DATABEND_HINT_TOKEN,
    ],
  ])("refuses %s", (_, sql, sentence) => {
    expect(databendStatementRefusal(sql)).toBe(sentence);
  });

  test.each<[string, string]>([
    ["a literal holding an escaped quote", "SELECT 'it\\'s'"],
    ["one statement and its terminator", "SELECT 1;"],
    ["one statement and a trailing comment", "SELECT 1; -- note"],
    ["a $$ script", "EXECUTE IMMEDIATE $$ BEGIN LET x := 1; RETURN x; END; $$"],
    ["a stage name with no backslash", "SELECT * FROM @my_stage/data.csv"],
    ["a stage path holding single dashes, slashes and a $ that opens no tag", "SELECT * FROM @s/2026-10/x$1.csv"],
    ["a stage name a space ends before a comment", "SELECT * FROM @s -- note"],
    ["a stage name a line break ends before a comment", "SELECT * FROM @s\n/* note */"],
    ["a stage name inside a comment", "SELECT [1, 2] AS a -- @s--x"],
    // After an odd run of `<` the `@` ends a `<@` operator and opens nothing. Measured on v1.2.951: the first text
    // answered true, so its `--` is a comment to Databend too; `<@[1,2]` and `<@$$[1,2]$$` are 1065 at the `<@`, an
    // operator given an array and a string; and the `<<<@` text is 1005 at the `<@`, an operator missing an operand.
    ["a <@ operator before a comment", "SELECT parse_json('[1]')<@--;SELECT 3 AS hidden\nparse_json('[1,2]') AS r"],
    ["a <@ operator before an array literal", "SELECT parse_json('[1]')<@[1,2] AS r"],
    ["a <@ operator before a $$ string", "SELECT parse_json('[1]')<@$$[1,2]$$ AS r"],
    ["a <@ operator before a block comment", "SELECT parse_json('[1]')<@/*c*/parse_json('[1,2]') AS r"],
    ["a <@ operator after a << operator", "SELECT 2<<<@--;SELECT 3 AS hidden\n1 AS r"],
    ["the @>, @? and @@ operators before an ending character", "SELECT a@> b, a@?'$.a', a@@'$.a == 1' FROM t"],
    // Databend reads a quoted location that starts with `@` as the same stage (`string_location` in `stage.rs`).
    ["a stage location written as a quoted string", "SELECT $1 FROM '@~/a--b.csv'"],
    ["a backslash inside a literal after a stage name", "SELECT * FROM @s WHERE a = 'x\\'y'"],
    ["an @ inside a literal", "SELECT '@s\\\\x'"],
    ["an optimizer hint with no semicolon", "SELECT /*+ SET_VAR(max_threads=1) */ 1"],
    ["an optimizer hint holding a plain quoted value", "SELECT /*+ SET_VAR(timezone='Asia/Shanghai') */ 1"],
    ["a plain comment holding a semicolon", "SELECT /* a; b */ 1"],
    // D6b-2: a tag that is only mentioned inside a comment, a literal or a $$ string is no code-level dollar run.
    ["a tag inside a line comment", "SELECT 1 -- $a$ x $a$"],
    ["a tag inside a block comment", "SELECT 1 /* $a$ */"],
    ["a tag inside a quoted literal", "SELECT '$a$' AS v"],
    ["a tag inside a quoted identifier", 'SELECT 1 AS "$a$"'],
    ["a tag inside a $$ string", "SELECT $$ $a$ $$"],
    ["a $$ string after a space", "SELECT 1 AS a, $$x$$ AS b"],
  ])("passes %s", (_, sql) => {
    expect(databendStatementRefusal(sql)).toBeNull();
  });

  test("no sentence echoes the text", () => {
    const sql = "SELECT 'secret_marker'; SELECT 2";

    expect(databendStatementRefusal(sql)).not.toContain("secret_marker");
  });

  /**
   * A timing guard: a run of `@` is one stage token, and a scan of it from every `@` in it is quadratic (measured on the
   * scan this replaced: 3.2 seconds for a 25k run, 12.5 for 50k). The bound is loose so it cannot flake on a slow
   * runner, and the answer is asserted with the time.
   */
  test("answers in bounded time on long runs of stage tokens", () => {
    const BOUND_MS = 200;
    const adversarial: [string, string, string | null][] = [
      ["a 20k run of @", `SELECT 1 FROM ${"@".repeat(20_000)}`, null],
      ["a 20k run of @ that ends in a comment", `SELECT 1 FROM ${"@".repeat(20_000)}--`, DATABEND_STAGE_RUN_ON],
      ["10k stage tokens glued together", `SELECT 1 FROM ${"@s".repeat(10_000)}`, null],
      ["an odd 20k run of < before an @", `SELECT 1 ${"<".repeat(20_001)}@[1]`, null],
      ["an even 20k run of < before an @", `SELECT 1 ${"<".repeat(20_000)}@--`, DATABEND_STAGE_RUN_ON],
      ["10k <@ operators", `SELECT 1 ${"<@".repeat(10_000)}[1]`, null],
    ];

    for (const [label, sql, refusal] of adversarial) {
      const started = performance.now();
      const answer = databendStatementRefusal(sql);
      const elapsed = performance.now() - started;

      expect(answer, label).toBe(refusal);
      expect(elapsed, `${label} took ${elapsed.toFixed(1)}ms`).toBeLessThan(BOUND_MS);
    }
  });
});

/** The shared limiter under the Databend grammar, as the provider calls it (L3). */
describe("the shared limiter under databend", () => {
  test("appends no bound to a top-level SELECT TOP n, which Databend refuses beside a LIMIT (I4)", () => {
    const sql = "SELECT TOP 3 * FROM numbers(10)";

    expect(applyQueryLimit(sql, 500, 0, {}, "databend")).toMatchObject({ sql, wasLimited: false });
    expect(applyQueryLimit(sql, 500, 500, {}, "databend")).toMatchObject({ sql, wasLimited: false });
  });

  test("places the bound before a trailing FORMAT clause (I3)", () => {
    expect(applyQueryLimit("SELECT number FROM numbers(10) FORMAT TabSeparated", 5, 0, {}, "databend").sql).toBe(
      "SELECT number FROM numbers(10) LIMIT 5 FORMAT TabSeparated",
    );
    expect(applyQueryLimit("SELECT 1 FORMAT JSON;", 5, 10, {}, "databend").sql).toBe(
      "SELECT 1 LIMIT 5 OFFSET 10 FORMAT JSON;",
    );
  });

  test("reads an existing bound before a trailing FORMAT clause as the bound it is", () => {
    const sql = "SELECT 1 LIMIT 5 FORMAT CSV";

    expect(applyQueryLimit(sql, 500, 0, {}, "databend")).toMatchObject({ sql, wasLimited: false, originalLimit: 5 });
  });
});
