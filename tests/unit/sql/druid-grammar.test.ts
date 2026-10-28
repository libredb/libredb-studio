import { describe, expect, test } from "bun:test";
import { isDangerousQuery } from "@/components/QuerySafetyDialog";
import { analyzeQuery, applyQueryLimit } from "@/lib/db/utils/query-limiter";
import { DEFAULT_SQL_GRAMMAR, hashRunIsAmbiguous, readsSqlText, resolveSqlGrammar } from "@/lib/sql/grammar";
import { hasUnterminatedSpan, readSqlSpan } from "@/lib/sql/spans";
import { splitStatements } from "@/lib/sql/statement-splitter";

// Each fact is read off Druid's SQL parser, which is Apache Calcite 1.37's `Parser.jj` as Druid generates it
// (`sql/src/main/codegen/templates/Parser.jj` at druid-37.0.0, quoting set by `DruidSqlParser.PARSER_CONFIG`), and each
// was measured on 2026-10-28 on apache/druid:37.0.0 over `POST /druid/v2/sql` on the Router, the endpoint the provider
// sends on. A test pinning a fact that differs from the compatibility default uses an input the default reads
// differently; the rest pin established facts that happen to equal the default. Where Druid refuses a form the shared
// reader cannot follow, the test pins the reader's refusal, the fail-safe direction.
const grammar = resolveSqlGrammar("druid");
const texts = (sql: string) => splitStatements(sql, grammar).map((statement) => statement.sql.trim());
const defaultTexts = (sql: string) => splitStatements(sql).map((statement) => statement.sql.trim());
const limited = (sql: string) => applyQueryLimit(sql, 500, 0, {}, "druid");

describe("the Druid SQL grammar", () => {
  test("is its own row, not the compatibility default, and its text is SQL", () => {
    expect(grammar).not.toBe(DEFAULT_SQL_GRAMMAR);
    expect(readsSqlText("druid")).toBe(true);
  });

  test("`#` is code, so a `;` after it ends the statement", () => {
    // `SELECT 1 AS a # note` is 400 "Lexical error ... Encountered: \"#\"": the lexer has no `#` token at all.
    expect(grammar.hash).toBe("code");
    expect(hashRunIsAmbiguous(grammar)).toBe(false);
    expect(texts("SELECT 1 # x; SELECT 2")).toEqual(["SELECT 1 # x", "SELECT 2"]);
    expect(defaultTexts("SELECT 1 # x; SELECT 2")).toEqual(["SELECT 1 # x; SELECT 2"]);
  });

  test("`[…]` is an array constructor and a subscript: it nests and a literal inside it is a literal", () => {
    // Druid quotes names with `"`, so the lexer has no bracket identifier: `SELECT 1 AS [a]` is 400 "Incorrect syntax
    // near the keyword 'AS'", `SELECT ARRAY_LENGTH(ARRAY[ARRAY[1,2],ARRAY[3,4]]) AS a` answers 2 and
    // `SELECT ARRAY_OFFSET(ARRAY['a]b','c'], 0) AS a` answers `a]b`.
    expect(grammar.bracket).toBe("subscript");
    expect(readSqlSpan("[[1],[2]]", 0, grammar)).toEqual({ kind: "subscript", end: 9, terminated: true });
    expect(hasUnterminatedSpan("SELECT ARRAY['a]b', 'c'] AS a", grammar)).toBe(false);
    expect(texts("SELECT ARRAY['a]b'] AS a; SELECT 2")).toEqual(["SELECT ARRAY['a]b'] AS a", "SELECT 2"]);
    // The default reads the same text as a name that ends at the first `]` and a literal that never closes.
    expect(hasUnterminatedSpan("SELECT ARRAY['a]b', 'c'] AS a")).toBe(true);
  });

  test("block comments do not nest: the first `*/` closes the run", () => {
    // `SELECT /* a /* b */ 1 AS a` answers 1, and `SELECT /* a /* b */ c */ 1 AS a` is 400 "Received an unexpected
    // token [*/]": a comment opens no level inside a comment.
    expect(grammar.blockComment).toBe("flat");
    expect(texts("SELECT /* a /* b */ 1; SELECT 2")).toEqual(["SELECT /* a /* b */ 1", "SELECT 2"]);
  });

  test("an optimizer hint is code, so a quote inside it is a literal and not the end of a comment", () => {
    // `/*+` is its own token (`HINT_BEG`), the hint body is parsed as code and `*/` closes it: `SELECT /*+ h('*/') */
    // 1 AS a` answers 1, where a comment ending at the first `*/` would leave `') */ 1 AS a` unterminated. Inside a
    // comment `/*+` is text: `SELECT /* a /*+ b */ 1 AS a` answers 1.
    expect(grammar.hintsAreCode).toBe(true);
    expect(readSqlSpan("/*+ h('*/') */ 1", 0, grammar)).toBeNull();
    expect(hasUnterminatedSpan("SELECT /*+ h('*/') */ 1 AS a", grammar)).toBe(false);
    expect(texts("SELECT /*+ h(';') */ 1; SELECT 2")).toEqual(["SELECT /*+ h(';') */ 1", "SELECT 2"]);
    expect(readSqlSpan("/* a /*+ b */ 1", 0, grammar)).toEqual({ kind: "block-comment", end: 13, terminated: true });
    // The default reads the hint as a comment that ends inside the literal, which then never closes.
    expect(hasUnterminatedSpan("SELECT /*+ h('*/') */ 1 AS a")).toBe(true);
  });

  test("`//` opens a line comment, so a `;` after it is comment text", () => {
    // `SELECT 4 // 2 AS a` answers 4 in a column named EXPR$0, `SELECT 1 AS a // note; SELECT 999` answers 1 alone,
    // and `SELECT 1 AS a // note<LF>, 2 AS b` answers both columns: the run ends at the line feed.
    expect(grammar.doubleSlashComment).toBe(true);
    expect(texts("SELECT 1 AS a // note; SELECT 999")).toEqual(["SELECT 1 AS a // note; SELECT 999"]);
    expect(texts("SELECT 1 // note\n; SELECT 2")).toEqual(["SELECT 1 // note", "SELECT 2"]);
    // The default reads `//` as code and cuts the text the engine reads as one statement.
    expect(defaultTexts("SELECT 1 AS a // note; SELECT 999")).toEqual(["SELECT 1 AS a // note", "SELECT 999"]);
  });

  test("no alternate quoting", () => {
    // `SELECT q'[x]' AS a` is 400 "Expecting alias, found character literal".
    expect(grammar.alternateQuoting).toBe(false);
  });

  test("a backslash in `'…'` is the literal's own text, which the reader leaves unresolved", () => {
    // `SELECT 'a\' AS a` answers `a\`, and `SELECT 'it\'s' AS a` is 400 "Received an unexpected token [\']". But an
    // `E'…'` literal does take the escape (`SELECT E'it\'s' AS a` answers `it's`), so no single reading of a quote
    // after a backslash holds for every literal, and the reader keeps reporting it unresolved.
    expect(grammar.backslashAlwaysEscapes).toBe(false);
    expect(hasUnterminatedSpan("SELECT 'a\\' AS a", grammar)).toBe(true);
    expect(readSqlSpan("'it''s'", 0, grammar)).toEqual({ kind: "string", end: 7, terminated: true });
  });

  test('a backslash in `"…"` is part of the name', () => {
    // `SELECT 1 AS "a\"` answers a column named `a\`, and `SELECT 1 AS "a""b"` one named `a"b`.
    expect(grammar.doubleQuoteBackslashEscapes).toBe(false);
    expect(readSqlSpan('"a\\"', 0, grammar)).toEqual({ kind: "quoted-identifier", end: 4, terminated: true });
    expect(texts('SELECT 1 AS "a\\"; SELECT 2')).toEqual(['SELECT 1 AS "a\\"', "SELECT 2"]);
    // The default cannot tell whether that quote closes the name.
    expect(hasUnterminatedSpan('SELECT 1 AS "a\\"')).toBe(true);
  });

  test("a backtick quotes nothing, and the reader's name reading costs only text Druid refuses", () => {
    // `SELECT 1 AS \`a\`` is 400 "Lexical error ... Encountered: \"`\"".
    expect(grammar.backtickBackslashEscapes).toBeUndefined();
  });

  test("a carriage return ends a line comment, and a backslash does not continue one", () => {
    // `SELECT 1 AS a -- note<CR>, 2 AS b` and `SELECT 1 AS a // note<CR>, 2 AS b` answer both columns, and so does
    // `SELECT 1 AS a -- note \<LF>, 2 AS b`: the line comment token is `("//"|"--")(~["\n","\r"])*`.
    expect(grammar.lineCommentEndsAtCarriageReturn).toBe(true);
    expect(grammar.lineCommentBackslashContinues).toBeUndefined();
    expect(texts("SELECT 1 -- x\r; SELECT 2")).toEqual(["SELECT 1 -- x", "SELECT 2"]);
    expect(texts("SELECT 1 // x\r; SELECT 2")).toEqual(["SELECT 1 // x", "SELECT 2"]);
    expect(texts("SELECT 1 -- x \\\n; SELECT 2")).toEqual(["SELECT 1 -- x \\", "SELECT 2"]);
    expect(defaultTexts("SELECT 1 -- x\r; SELECT 2")).toEqual(["SELECT 1 -- x\r; SELECT 2"]);
  });

  test("a tagged dollar run is code: `$` is an identifier character", () => {
    // `SELECT 1 AS $t$` answers a column named `$t$`. An untagged `$$` run keeps the reader's dollar-string reading:
    // `SELECT $$x$$ AS a` is 400 "Column '$$x$$' not found", so Druid reads a name there too, and the run the reader
    // holds whole is either text Druid refuses or a name whose end the reader moves (see the provider doc).
    expect(grammar.dollarTags).toBe(false);
    expect(readSqlSpan("$t$ x; $t$", 0, grammar)).toBeNull();
    expect(texts("SELECT 1 AS $t$; SELECT 2")).toEqual(["SELECT 1 AS $t$", "SELECT 2"]);
    expect(defaultTexts("SELECT 1 AS $t$; SELECT 2 AS $t$")).toEqual(["SELECT 1 AS $t$; SELECT 2 AS $t$"]);
  });

  test("a script keeps the default: one statement per cut and no procedural body", () => {
    // `SELECT 1 AS a; SELECT 2 AS b` is 400 "Only SET statements can appear before the final statement in a
    // statement list", and Druid SQL has no routine or block with a body.
    expect(grammar.script).toBe(DEFAULT_SQL_GRAMMAR.script);
  });

  test("the unsafe-statement check reads what Druid reads", () => {
    // A `//` comment hides the `;` and what follows it from Druid, so there is no second statement to ask about.
    expect(isDangerousQuery("SELECT 1 AS a // x; DELETE FROM t", "druid")).toBe(false);
    expect(isDangerousQuery("SELECT 1 AS a // x; DELETE FROM t")).toBe(true);
    // A name the default cannot close no longer asks, and a write after it still does.
    expect(isDangerousQuery('SELECT 1 AS "a\\" FROM t', "druid")).toBe(false);
    expect(isDangerousQuery('SELECT 1 AS "a\\" FROM t')).toBe(true);
    expect(isDangerousQuery('SELECT 1 AS "a\\"; DELETE FROM t', "druid")).toBe(true);
  });
});

describe("the row limiter reads Druid SQL", () => {
  test("`LIMIT ALL` is the statement's own bound", () => {
    // Calcite's `LimitClause` takes `ALL` in place of a count: `SELECT 1 AS a LIMIT ALL` answers the row and
    // `SELECT 1 AS a LIMIT ALL LIMIT 500` is 400 "Received an unexpected token [LIMIT]".
    expect(grammar.nonNumericRowBounds).toEqual(["ALL"]);
    const result = limited("SELECT a FROM t LIMIT ALL");
    expect(result.sql).toBe("SELECT a FROM t LIMIT ALL");
    expect(result.wasLimited).toBe(false);
    expect(applyQueryLimit("SELECT a FROM t LIMIT ALL", 500).sql).toBe("SELECT a FROM t LIMIT ALL LIMIT 500");
  });

  test("an OFFSET may end in ROW or ROWS, and the bound before it is kept", () => {
    // `OffsetClause` takes an optional `ROW | ROWS`: `SELECT 1 AS a LIMIT 5 OFFSET 0 ROWS` answers the row, and the
    // same text with ` LIMIT 500` after it is 400 "Received an unexpected token [LIMIT]".
    expect(grammar.trailingLimitClauses).toHaveLength(1);
    for (const sql of ["SELECT a FROM t LIMIT 5 OFFSET 2 ROWS", "SELECT a FROM t LIMIT 5 OFFSET 2 row"]) {
      const result = limited(sql);
      expect(result.sql).toBe(sql);
      expect(result.wasLimited).toBe(false);
      expect(analyzeQuery(sql, "druid").existingLimit).toBe(5);
    }
    expect(applyQueryLimit("SELECT a FROM t LIMIT 5 OFFSET 2 ROWS", 500).sql).toBe(
      "SELECT a FROM t LIMIT 5 OFFSET 2 ROWS LIMIT 500",
    );
  });

  test("an OFFSET n ROWS with no bound reads as an OFFSET", () => {
    // `SELECT 1 AS a OFFSET 0 ROWS` answers the row; the provider leaves such a statement alone, since Druid refuses
    // a LIMIT written after an OFFSET.
    expect(analyzeQuery("SELECT a FROM t OFFSET 2 ROWS", "druid")).toMatchObject({ hasOffset: true, hasLimit: false });
    expect(analyzeQuery("SELECT a FROM t OFFSET 2 ROWS")).toMatchObject({ hasOffset: false });
  });

  test("a ROWS inside a literal or a FETCH clause is no clause", () => {
    const sql = "SELECT a FROM t WHERE note = 'x ROWS'";
    expect(limited(sql).sql).toBe(`${sql} LIMIT 500`);
    expect(limited("SELECT a FROM t FETCH FIRST 5 ROWS ONLY")).toMatchObject({ wasLimited: false });
  });

  test("bounds a read before a trailing `//` comment, not inside it", () => {
    // `SELECT 1 AS a LIMIT 5 // note` answers the row; the default writes the bound into the comment.
    expect(limited("SELECT a FROM t // note")).toMatchObject({
      sql: "SELECT a FROM t LIMIT 500 // note",
      wasLimited: true,
    });
    expect(applyQueryLimit("SELECT a FROM t // note", 500).sql).toBe("SELECT a FROM t // note LIMIT 500");
  });

  test("bounds a read whose array literal holds a close bracket", () => {
    const sql = "SELECT ARRAY_OFFSET(ARRAY['a]b'], 0) AS a FROM t";
    expect(limited(sql)).toMatchObject({ sql: `${sql} LIMIT 500`, wasLimited: true });
    // The default loses the bound on the same text.
    expect(applyQueryLimit(sql, 500).wasLimited).toBe(false);
  });

  test("bounds a read whose quoted name ends in a backslash", () => {
    const sql = 'SELECT a AS "x\\" FROM t';
    expect(limited(sql)).toMatchObject({ sql: `${sql} LIMIT 500`, wasLimited: true });
    expect(applyQueryLimit(sql, 500).wasLimited).toBe(false);
  });
});
