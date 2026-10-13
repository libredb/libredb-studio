import { describe, expect, test } from "bun:test";
import { applyQueryLimit } from "@/lib/db/utils/query-limiter";
import { DEFAULT_SQL_GRAMMAR, resolveSqlGrammar } from "@/lib/sql/grammar";
import { readOperativeKeyword } from "@/lib/sql/operative-keyword";
import { hasUnterminatedSpan } from "@/lib/sql/spans";
import { splitExecutionUnits } from "@/lib/sql/statement-splitter";

// Each fact is one the trial capture measured (Snowflake 10.37.100, 2026-10-12, items M60 to M64 of
// tests/fixtures/snowflake/trial-2026-10-12-v10.37.100/), named in its title. Where the account reads a form more
// permissively than the shared reader (M63's continuation), the test pins the reader's refusal, the fail-safe
// direction.
const grammar = resolveSqlGrammar("snowflake");
const units = (sql: string) => splitExecutionUnits(sql, grammar).map((unit) => unit.sql.trim());

describe("the Snowflake grammar", () => {
  test("is its own row, not the compatibility default", () => {
    expect(grammar).not.toBe(DEFAULT_SQL_GRAMMAR);
  });

  test("M63: `//` opens a line comment, so a `;` and a DROP behind it stay in the comment", () => {
    expect(grammar.doubleSlashComment).toBe(true);
    expect(units("SELECT 1 AS a // note; DROP TABLE t")).toEqual(["SELECT 1 AS a // note; DROP TABLE t"]);
    expect(units("SELECT 1 AS a // note\n; SELECT 2")).toHaveLength(2);
  });

  test("M63: a backslash before a line feed leaves the literal unterminated, so the text stays one unit", () => {
    // The shared reader refuses the continuation form (no escaped pair before a line feed), the fail-safe direction:
    // the text is one unit and the gate cannot read it.
    expect(units("SELECT 'a\\\nb'; SELECT 2")).toHaveLength(1);
    expect(hasUnterminatedSpan("SELECT 'a\\\nb'", grammar)).toBe(true);
  });

  test("a backslash escapes inside a single-quoted string", () => {
    expect(grammar.backslashAlwaysEscapes).toBe(true);
    expect(units("SELECT 'it\\'s'; SELECT 2")).toEqual(["SELECT 'it\\'s'", "SELECT 2"]);
  });

  test("M60: block comments are flat, so the first closer ends the run", () => {
    expect(grammar.blockComment).toBe("flat");
    expect(readOperativeKeyword("/* a /* b */ SELECT 1", grammar)?.keyword).toBe("SELECT");
  });

  test("M62: `#` is code, so a `;` after it ends the statement", () => {
    expect(grammar.hash).toBe("code");
    expect(units("SELECT 1 # x; SELECT 2")).toEqual(["SELECT 1 # x", "SELECT 2"]);
  });

  test("M62: `X''` is an ordinary string after an identifier, with no alternate quoting", () => {
    expect(grammar.alternateQuoting).toBe(false);
    expect(units("SELECT X'0A'; SELECT 2")).toEqual(["SELECT X'0A'", "SELECT 2"]);
  });

  test("M61: a backslash inside a double-quoted identifier is part of the name, so the run closes at its second quote", () => {
    expect(grammar.doubleQuoteBackslashEscapes).toBe(false);
    expect(hasUnterminatedSpan('SELECT 1 AS "a\\"', grammar)).toBe(false);
    expect(units('SELECT 1 AS "a\\"; SELECT 2')).toEqual(['SELECT 1 AS "a\\"', "SELECT 2"]);
  });

  test("M64: `a$b$c` is a name, so it opens no span and the statement is bounded", () => {
    expect(grammar.dollarTags).toBe(false);
    expect(hasUnterminatedSpan("SELECT a$b$c FROM t", grammar)).toBe(false);
    expect(applyQueryLimit("SELECT a$b$c FROM t", 5, 0, {}, "snowflake").sql).toBe("SELECT a$b$c FROM t LIMIT 5");
  });

  test("`$$` is the only dollar-quoted form, so a tagged run is code and its `;` ends the statement", () => {
    expect(units("SELECT $t$x;y$t$")).toEqual(["SELECT $t$x", "y$t$"]);
    expect(units("SELECT $$x;y$$; SELECT 2")).toEqual(["SELECT $$x;y$$", "SELECT 2"]);
  });

  test("`[` is a subscript", () => {
    expect(grammar.bracket).toBe("subscript");
    expect(units("SELECT v['a]b'] FROM t; SELECT 2")).toHaveLength(2);
  });

  test("a trailing FOR UPDATE follows the row bound", () => {
    expect(applyQueryLimit("SELECT * FROM t FOR UPDATE", 5, 0, {}, "snowflake").sql).toBe(
      "SELECT * FROM t LIMIT 5 FOR UPDATE",
    );
    expect(applyQueryLimit("SELECT * FROM t for update nowait", 5, 0, {}, "snowflake").sql).toBe(
      "SELECT * FROM t LIMIT 5 for update nowait",
    );
    expect(applyQueryLimit("SELECT * FROM t FOR UPDATE WAIT 10", 5, 0, {}, "snowflake").sql).toBe(
      "SELECT * FROM t LIMIT 5 FOR UPDATE WAIT 10",
    );
    const [clause] = grammar.trailingLimitClauses;
    expect(grammar.trailingLimitClauses).toHaveLength(1);
    expect(clause.test("SELECT note FROM t WHERE note = 'FOR UPDATE'")).toBe(false);
    expect(clause.test("SELECT * FROM (SELECT 1 FOR UPDATE) t")).toBe(false);
  });

  test("a script keeps the default: no procedural block is read", () => {
    expect(grammar.script).toBe(DEFAULT_SQL_GRAMMAR.script);
    expect(grammar.script.blocks).toBe("none");
  });
});
