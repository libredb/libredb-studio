import { describe, expect, test } from "bun:test";
import { analyzeQuery, applyQueryLimit } from "@/lib/db/utils/query-limiter";
import { DEFAULT_SQL_GRAMMAR, readsSqlText, resolveSqlGrammar } from "@/lib/sql/grammar";
import { readLeadingKeyword } from "@/lib/sql/leading-keyword";
import { readOperativeKeyword } from "@/lib/sql/operative-keyword";
import { hasUnterminatedSpan } from "@/lib/sql/spans";
import { splitExecutionUnits } from "@/lib/sql/statement-splitter";

// Each fact is read off Spark's lexer and parser at tag v4.2.0, and the comment facts were measured on Spark 4.2.0.
// Where Spark reads a form more permissively than the shared reader (a backslash before a line feed inside a
// literal), the test pins the reader's refusal, the fail-safe direction.
const grammar = resolveSqlGrammar("spark");
const units = (sql: string) => splitExecutionUnits(sql, grammar).map((unit) => unit.sql.trim());
const limited = (sql: string) => applyQueryLimit(sql, 500, 0, {}, "spark").sql;

describe("the Spark grammar", () => {
  test("is its own row, not the compatibility default, and its text is SQL", () => {
    expect(grammar).not.toBe(DEFAULT_SQL_GRAMMAR);
    expect(readsSqlText("spark")).toBe(true);
  });

  test("`#` is code, so a `;` after it ends the statement", () => {
    expect(grammar.hash).toBe("code");
    expect(units("SELECT 1 # x; SELECT 2")).toEqual(["SELECT 1 # x", "SELECT 2"]);
  });

  test("`[` is a subscript", () => {
    expect(grammar.bracket).toBe("subscript");
    expect(units("SELECT m['a]b'] FROM t; SELECT 2")).toHaveLength(2);
  });

  test("block comments nest", () => {
    expect(grammar.blockComment).toBe("nesting");
    expect(readOperativeKeyword("/* a /* b */ c */ SELECT 1", grammar)?.keyword).toBe("SELECT");
  });

  test("no alternate quoting and no `//` comment", () => {
    expect(grammar.alternateQuoting).toBe(false);
    expect(grammar.doubleSlashComment).toBe(false);
    expect(units("SELECT 4 // 2; SELECT 2")).toEqual(["SELECT 4 // 2", "SELECT 2"]);
  });

  test("a backslash escapes inside both quotes, and before a line feed leaves the literal unterminated", () => {
    expect(grammar.backslashAlwaysEscapes).toBe(true);
    expect(grammar.doubleQuoteBackslashEscapes).toBeUndefined();
    expect(units("SELECT 'it\\'s'; SELECT 2")).toEqual(["SELECT 'it\\'s'", "SELECT 2"]);
    expect(units('SELECT "a\\"b"; SELECT 2')).toEqual(['SELECT "a\\"b"', "SELECT 2"]);
    expect(hasUnterminatedSpan("SELECT 'a\\\nb'", grammar)).toBe(true);
  });

  test("a raw string takes no escapes, so the quote after a backslash closes it", () => {
    expect(grammar.rawStrings).toBe(true);
    expect(units("SELECT r'C:\\' AS a; SELECT 2")).toEqual(["SELECT r'C:\\' AS a", "SELECT 2"]);
  });

  test("`/*+` opens a hint read as code, and inside a comment it opens no level", () => {
    expect(grammar.hintsAreCode).toBe(true);
    expect(units("SELECT /*+ REPARTITION(2) */ a FROM t; SELECT 2")).toHaveLength(2);
    expect(readOperativeKeyword("/* a /*+ b */ DELETE FROM t", grammar)?.keyword).toBe("DELETE");
  });

  test("a backslash right before a line feed continues a `--` comment, and one before CR LF does not", () => {
    expect(grammar.lineCommentBackslashContinues).toBe(true);
    // Spark reads the line after the backslash as comment text, so a `;` there cuts no unit and a WHERE there is no
    // clause; the leading and operative keywords are the first code words after the comment.
    expect(units("SELECT 1 -- note \\\n; DROP TABLE t")).toHaveLength(1);
    expect(units("SELECT 1 -- note \\\r\n; DROP TABLE t")).toHaveLength(2);
    expect(limited("SELECT * FROM t -- note \\\nWHERE x = 1")).toBe(
      "SELECT * FROM t LIMIT 500 -- note \\\nWHERE x = 1",
    );
    expect(readLeadingKeyword("-- note \\\nSELECT 1\nDELETE FROM t", grammar)?.keyword).toBe("DELETE");
    expect(
      readOperativeKeyword("WITH c AS (SELECT 1 -- note \\\n) SELECT 1 --\n) DELETE FROM u", grammar)?.keyword,
    ).toBe("DELETE");
  });

  test("a lone carriage return ends a `--` comment, and a backslash before it continues nothing", () => {
    expect(grammar.lineCommentEndsAtCarriageReturn).toBe(true);
    // Spark reads the text after a lone carriage return as code, so a `;` there cuts a unit, a WHERE there is the
    // statement's own clause and the bound follows it, and the keywords after the comment are read.
    expect(units("SELECT 1 -- note\r; DROP TABLE t")).toHaveLength(2);
    expect(units("SELECT 1 -- note \\\r; DROP TABLE t")).toHaveLength(2);
    expect(units("SELECT 1 -- a \\\nb\r; DROP TABLE t")).toStrictEqual(["SELECT 1 -- a \\\nb", "DROP TABLE t"]);
    expect(limited("SELECT * FROM t -- note\rWHERE x = 1")).toBe("SELECT * FROM t -- note\rWHERE x = 1 LIMIT 500");
    expect(readLeadingKeyword("-- note\rDELETE FROM t", grammar)?.keyword).toBe("DELETE");
    expect(readOperativeKeyword("WITH c AS (SELECT 1) -- note\rINSERT INTO u\nSELECT 1", grammar)?.keyword).toBe(
      "INSERT",
    );
  });

  test("dollar-quoted runs, tagged or not, are strings", () => {
    expect(grammar.dollarTags).toBeUndefined();
    expect(units("SELECT $$x;y$$; SELECT 2")).toEqual(["SELECT $$x;y$$", "SELECT 2"]);
    expect(units("SELECT $t$x;y$t$; SELECT 2")).toEqual(["SELECT $t$x;y$t$", "SELECT 2"]);
  });

  test("one statement per unit, and BEGIN is the leading keyword of a block the provider refuses", () => {
    expect(grammar.script).toBe(DEFAULT_SQL_GRAMMAR.script);
    expect(readLeadingKeyword("BEGIN SELECT 1; END", grammar)?.keyword).toBe("BEGIN");
    // A BEGIN block holding raw strings still reads BEGIN, and a hint before BEGIN is code, so no keyword leads.
    expect(readLeadingKeyword("BEGIN SELECT r'\\'; DROP TABLE t; SELECT '\\''; END", grammar)?.keyword).toBe("BEGIN");
    expect(readLeadingKeyword("/*+ x */ BEGIN SELECT 1; END", grammar)).toBeNull();
  });

  test("a trailing OFFSET follows the row bound, and LIMIT before OFFSET reads as bounded", () => {
    expect(grammar.trailingLimitClauses).toHaveLength(1);
    expect(limited("SELECT * FROM t ORDER BY a OFFSET 10")).toBe("SELECT * FROM t ORDER BY a LIMIT 500 OFFSET 10");
    expect(limited("SELECT * FROM t LIMIT 5 OFFSET 10")).toBe("SELECT * FROM t LIMIT 5 OFFSET 10");
    expect(grammar.trailingLimitClauses[0].test("SELECT note FROM t WHERE note = 'OFFSET 10'")).toBe(false);
  });

  test.each([
    "FROM t SELECT a",
    "TABLE t",
    "VALUES (1), (2)",
    "MAP a USING 'cat' AS (b) FROM t",
    "REDUCE a USING 'cat' AS (b) FROM t",
  ])("%j is typed OTHER and gets no LIMIT; the provider's budgets bound it", (sql) => {
    expect(analyzeQuery(sql, "spark").type).toBe("OTHER");
    expect(limited(sql)).toBe(sql);
  });

  test("SELECT TRANSFORM ... USING is typed SELECT and bounded", () => {
    const sql = "SELECT TRANSFORM(a) USING 'cat' AS (b) FROM t";
    expect(analyzeQuery(sql, "spark").type).toBe("SELECT");
    expect(limited(sql)).toBe(`${sql} LIMIT 500`);
  });

  test("LIMIT ALL is not read as a bound, so a second LIMIT follows it and Spark refuses the text", () => {
    expect(limited("SELECT * FROM t LIMIT ALL")).toBe("SELECT * FROM t LIMIT ALL LIMIT 500");
  });

  test("declares the confirmation forms and session keys", () => {
    expect(grammar.confirmForms).toEqual([
      ["CREATE", "OR", "REPLACE"],
      ["REPLACE", "TABLE"],
      ["MERGE"],
      ["LOAD", "DATA"],
      ["CALL"],
      ["EXECUTE", "IMMEDIATE"],
      ["ADD"],
    ]);
    expect(grammar.confirmCodeForms).toStrictEqual([
      ["INSERT", "OVERWRITE"],
      ["EVOLUTION", "OVERWRITE"],
      ["REPLACE", "WHERE"],
      ["REPLACE", "ON"],
      ["REPLACE", "USING"],
      ["USING", "JAR"],
      ["USING", "FILE"],
      ["USING", "ARCHIVE"],
      ["DROP", "PARTITIONS"],
      ["SYNC", "PARTITIONS"],
      { wordThenLiteral: "USING" },
      ["REFLECT"],
      ["JAVA_METHOD"],
      ["TRY_REFLECT"],
      { quotedCall: "REFLECT" },
      { quotedCall: "JAVA_METHOD" },
      { quotedCall: "TRY_REFLECT" },
      { computedCall: "IDENTIFIER" },
      { dollarQuoted: true },
    ]);
    expect(grammar.confirmConfigKeys).toEqual([
      "spark.sql.variable.substitute",
      "spark.sql.defaultCatalog",
      "spark.sql.catalog.",
    ]);
  });
});
