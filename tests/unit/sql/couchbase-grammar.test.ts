import { describe, expect, test } from "bun:test";
import { isDangerousQuery } from "@/components/QuerySafetyDialog";
import { analyzeQuery, applyQueryLimit } from "@/lib/db/utils/query-limiter";
import { DEFAULT_SQL_GRAMMAR, hashRunIsAmbiguous, readsSqlText, resolveSqlGrammar } from "@/lib/sql/grammar";
import { hasUnterminatedSpan, readSqlSpan } from "@/lib/sql/spans";
import { splitStatements } from "@/lib/sql/statement-splitter";

// Each fact is read off the SQL++ lexer (`parser/n1ql/n1ql.nex` in couchbase/query, the 8.0 branch) and the SQL++
// language reference, and each was measured on 2026-10-28 on couchbase:community-8.0.2 over `POST /query/service`,
// the endpoint the provider sends on. Every input below is one the compatibility default reads differently. Where
// SQL++ refuses a form the shared reader cannot follow (a backslash before a line feed inside a literal), the test
// pins the reader's refusal, the fail-safe direction.
const grammar = resolveSqlGrammar("couchbase");
const texts = (sql: string) => splitStatements(sql, grammar).map((statement) => statement.sql.trim());
const limited = (sql: string) => applyQueryLimit(sql, 500, 0, {}, "couchbase");

describe("the Couchbase SQL++ grammar", () => {
  test("is its own row, not the compatibility default, and its text is SQL", () => {
    expect(grammar).not.toBe(DEFAULT_SQL_GRAMMAR);
    expect(readsSqlText("couchbase")).toBe(true);
  });

  test("`#` is code, so a `;` after it ends the statement", () => {
    // `SELECT 1 AS a # note` is 3000 "syntax error ... at: #".
    expect(grammar.hash).toBe("code");
    expect(hashRunIsAmbiguous(grammar)).toBe(false);
    expect(texts("SELECT 1 # x; DELETE FROM t")).toEqual(["SELECT 1 # x", "DELETE FROM t"]);
    expect(texts("SELECT 1 # x; DELETE FROM t")).not.toEqual(
      splitStatements("SELECT 1 # x; DELETE FROM t").map((statement) => statement.sql.trim()),
    );
  });

  test("`[…]` is an array literal and a subscript: it nests and a literal inside it is a literal", () => {
    // `SELECT [1,[2,3]][1][0] AS a` answers 2, `SELECT {"a]b": 7}.["a]b"] AS a` answers 7, and `SELECT 1 AS [a]` is
    // 3000 "syntax error ... at: [", so the brackets are never a name quote.
    expect(grammar.bracket).toBe("subscript");
    expect(readSqlSpan("[[1],[2]]", 0, grammar)).toEqual({ kind: "subscript", end: 9, terminated: true });
    expect(hasUnterminatedSpan("SELECT [[1],[2]] AS a", grammar)).toBe(false);
    expect(hasUnterminatedSpan("SELECT j['a]b'] FROM t", grammar)).toBe(false);
    expect(texts("SELECT j['a]b'] FROM t; SELECT 2")).toEqual(["SELECT j['a]b'] FROM t", "SELECT 2"]);
    // The default reads the same text as a name that ends at the first `]` and a literal that never closes.
    expect(hasUnterminatedSpan("SELECT j['a]b'] FROM t")).toBe(true);
  });

  test("block comments do not nest: the first `*/` closes the run", () => {
    // `SELECT /* a /* b */ 1 AS a` answers 1, and `SELECT /* a /* b */ c */ 1 AS a` is 3000 "syntax error ... at: /".
    expect(grammar.blockComment).toBe("flat");
    expect(texts("SELECT /* a /* b */ 1; SELECT 2")).toEqual(["SELECT /* a /* b */ 1", "SELECT 2"]);
  });

  test("an optimizer hint ends where a block comment ends, so a quote inside it is hint text", () => {
    // `SELECT /*+ 'x */ 1 AS a` answers 1: the hint token runs to the first `*/` whatever it holds.
    expect(grammar.hintsAreCode).toBeUndefined();
    expect(readSqlSpan("/*+ 'x */ 1", 0, grammar)).toEqual({ kind: "block-comment", end: 9, terminated: true });
  });

  test("no alternate quoting and no `//` comment", () => {
    // `SELECT q'[x]' AS a` and `SELECT 4 // 2 AS a` are both 3000 syntax errors.
    expect(grammar.alternateQuoting).toBe(false);
    expect(grammar.doubleSlashComment).toBe(false);
    expect(texts("SELECT 4 // 2; SELECT 2")).toEqual(["SELECT 4 // 2", "SELECT 2"]);
  });

  test("a backslash escapes inside `'…'` and `\"…\"`, and a doubled `'` still does", () => {
    // `SELECT 'it\'s' AS a` and `SELECT 'it''s' AS a` both answer `it's`, `SELECT "it\"s" AS a` answers `it"s`.
    expect(grammar.backslashAlwaysEscapes).toBe(true);
    expect(grammar.doubleQuoteBackslashEscapes).toBeUndefined();
    expect(texts("SELECT 'it\\'s; x' AS a; SELECT 2")).toEqual(["SELECT 'it\\'s; x' AS a", "SELECT 2"]);
    expect(texts('SELECT "it\\"s; x" AS a; SELECT 2')).toEqual(['SELECT "it\\"s; x" AS a', "SELECT 2"]);
    expect(readSqlSpan("'it''s'", 0, grammar)).toEqual({ kind: "string", end: 7, terminated: true });
    // The default cannot tell where such a literal ends, so it reports it unterminated.
    expect(hasUnterminatedSpan("SELECT 'it\\'s' AS a")).toBe(true);
    expect(hasUnterminatedSpan("SELECT 'it\\'s' AS a", grammar)).toBe(false);
  });

  test("a backslash before a line feed leaves the literal unterminated, which SQL++ refuses too", () => {
    // `SELECT 'a\<LF>b' AS a` is 3000 "invalid quoted string - invalid escape sequence".
    expect(hasUnterminatedSpan("SELECT 'a\\\nb' AS a", grammar)).toBe(true);
  });

  test("a backslash escapes inside a backtick name, and a doubled backtick still does", () => {
    // `SELECT "a" AS \`x\\\`y\`` and `SELECT "a" AS \`x\`\`y\`` both answer a field named x`y.
    expect(grammar.backtickBackslashEscapes).toBe(true);
    expect(readSqlSpan("`x\\`y`", 0, grammar)).toEqual({ kind: "quoted-identifier", end: 6, terminated: true });
    expect(readSqlSpan("`x``y`", 0, grammar)).toEqual({ kind: "quoted-identifier", end: 6, terminated: true });
    expect(texts("SELECT 1 AS `x\\`; y`; SELECT 2")).toEqual(["SELECT 1 AS `x\\`; y`", "SELECT 2"]);
    // The default closes the name at the escaped backtick, so the `;` inside it reads as a boundary.
    expect(splitStatements("SELECT 1 AS `x\\`; y`; SELECT 2").map((statement) => statement.sql)).toEqual([
      "SELECT 1 AS `x\\`",
      "y`; SELECT 2",
    ]);
  });

  test("a carriage return ends a `--` comment, and a backslash does not continue one", () => {
    // `SELECT 1 AS a -- note<CR>, 2 AS b` answers both columns; so does `SELECT 1 AS a -- note \<LF>, 2 AS b`.
    expect(grammar.lineCommentEndsAtCarriageReturn).toBe(true);
    expect(grammar.lineCommentBackslashContinues).toBeUndefined();
    expect(texts("SELECT 1 -- x\r; DELETE FROM t")).toEqual(["SELECT 1 -- x", "DELETE FROM t"]);
    expect(texts("SELECT 1 -- x \\\n; DELETE FROM t")).toEqual(["SELECT 1 -- x \\", "DELETE FROM t"]);
  });

  test("a `$$` run keeps the default reading, since SQL++ refuses the text whole", () => {
    // `SELECT $$x$$ AS a` is 3000 "syntax error ... at: $": SQL++ has no dollar string, a `$` opens a named or
    // positional parameter only before a name or a digit, so reading the run as one literal keeps such text one
    // statement, which the engine then refuses.
    expect(grammar.dollarTags).toBeUndefined();
    expect(texts("SELECT $$x; DELETE FROM t; $$")).toHaveLength(1);
    expect(texts("SELECT * FROM t WHERE a = $a AND b = $1; SELECT 2")).toEqual([
      "SELECT * FROM t WHERE a = $a AND b = $1",
      "SELECT 2",
    ]);
  });

  test("a script keeps the default: one statement per request and no procedural body", () => {
    // `SELECT 1 AS a; SELECT 2 AS b` is 3000 "syntax error ... at: SELECT", and `SELECT 1 AS a;` answers 1.
    expect(grammar.script).toBe(DEFAULT_SQL_GRAMMAR.script);
  });

  test("the unsafe-statement check reads a write after an escaped quote as a write", () => {
    expect(isDangerousQuery("SELECT 'it\\'s'; DELETE FROM t", "couchbase")).toBe(true);
    expect(isDangerousQuery("SELECT 'it\\'s; DELETE FROM t' AS a", "couchbase")).toBe(false);
  });
});

describe("the row limiter reads SQL++", () => {
  test("nothing follows the row bound: SQL++ ends a SELECT at its LIMIT and OFFSET", () => {
    // dql.ebnf: `select ::= select-term ( set-op select-term )* order-by-clause? limit-clause? offset-clause?`.
    expect(grammar.trailingLimitClauses).toEqual([]);
    expect(grammar.nonNumericRowBounds).toBeUndefined();
  });

  test("bounds a read over a system keyspace", () => {
    // `SELECT RAW 1 FROM system:keyspaces AS k LIMIT 500` succeeds.
    expect(limited("SELECT RAW name FROM system:keyspaces").sql).toBe(
      "SELECT RAW name FROM system:keyspaces LIMIT 500",
    );
  });

  test("bounds a read whose subscript key holds a close bracket", () => {
    const result = limited("SELECT j['a]b'] FROM t");
    expect(result.sql).toBe("SELECT j['a]b'] FROM t LIMIT 500");
    expect(result.wasLimited).toBe(true);
    // The default loses the bound on the same text.
    expect(applyQueryLimit("SELECT j['a]b'] FROM t", 500).wasLimited).toBe(false);
  });

  test("bounds a read whose literal holds an escaped quote", () => {
    expect(limited("SELECT * FROM t WHERE name = 'O\\'Brien'").sql).toBe(
      "SELECT * FROM t WHERE name = 'O\\'Brien' LIMIT 500",
    );
    expect(applyQueryLimit("SELECT * FROM t WHERE name = 'O\\'Brien'", 500).wasLimited).toBe(false);
  });

  test("keeps an existing LIMIT, written before or after its OFFSET", () => {
    // `SELECT 1 AS a LIMIT 1 OFFSET 0` and `SELECT 1 AS a OFFSET 0 LIMIT 1` both answer the row, and a second
    // LIMIT is 3000 "syntax error ... at: LIMIT (reserved word)".
    for (const sql of ["SELECT a FROM t LIMIT 10 OFFSET 5", "SELECT a FROM t OFFSET 5 LIMIT 10"]) {
      const result = limited(sql);
      expect(result.sql).toBe(sql);
      expect(result.wasLimited).toBe(false);
      expect(analyzeQuery(sql, "couchbase").existingLimit).toBe(10);
    }
  });

  test("a lone OFFSET takes the bound after it", () => {
    // `SELECT 1 AS a OFFSET 1 LIMIT 500` succeeds.
    expect(limited("SELECT a FROM t OFFSET 5").sql).toBe("SELECT a FROM t OFFSET 5 LIMIT 500");
  });

  test("writes no bound into a `--` comment a lone carriage return ends", () => {
    // The limiter treats that comment as ambiguous on every dialect, so it declines rather than writing the bound
    // before the comment, where SQL++ would read the code after the carriage return as following the LIMIT.
    const sql = "SELECT a FROM t -- note\rWHERE a = 1";
    expect(limited(sql)).toEqual({ sql, wasLimited: false, appliedLimit: 0, appliedOffset: 0 });
  });
});
