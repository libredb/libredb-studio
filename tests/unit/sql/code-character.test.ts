/**
 * `hasCodeCharacter`, the walk the Spark and DuckDB providers share for their Unicode-space refusals: whether a
 * character of a class stands at a code position under a grammar row, outside every span `readSqlSpan` reads there.
 */
import { describe, expect, test } from "bun:test";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { hasCodeCharacter } from "@/lib/sql/spans";

const NBSP = /[\u00A0]/;
const DUCKDB = resolveSqlGrammar("duckdb");
const SPARK = resolveSqlGrammar("spark");
const MSSQL = resolveSqlGrammar("mssql");

describe("hasCodeCharacter", () => {
  test("a character of the class between two code words, at the start and at the end is found", () => {
    for (const grammar of [DUCKDB, SPARK, MSSQL]) {
      expect(hasCodeCharacter("SELECT\u00A01", grammar, NBSP)).toBe(true);
      expect(hasCodeCharacter("\u00A0SELECT 1", grammar, NBSP)).toBe(true);
      expect(hasCodeCharacter("SELECT 1\u00A0", grammar, NBSP)).toBe(true);
      expect(hasCodeCharacter("SELECT 1", grammar, NBSP)).toBe(false);
      expect(hasCodeCharacter("", grammar, NBSP)).toBe(false);
    }
  });

  test("a character of the class inside a string, a quoted name or a comment is not found", () => {
    for (const grammar of [DUCKDB, SPARK, MSSQL]) {
      for (const sql of ["SELECT '\u00A0'", 'SELECT 1 AS "a\u00A0b"', "SELECT 1 -- \u00A0", "/* \u00A0 */ SELECT 1"]) {
        expect(hasCodeCharacter(sql, grammar, NBSP)).toBe(false);
      }
    }
  });

  test("each span kind of a row is stepped over: DuckDB's dollar strings and nested comments, Spark's raw strings and backticks", () => {
    for (const sql of ["SELECT $$\u00A0$$", "SELECT $tag$\u00A0$tag$", "/* a /* nested \u00A0 */ still */ SELECT 1"]) {
      expect(hasCodeCharacter(sql, DUCKDB, NBSP)).toBe(false);
    }
    for (const sql of ["SELECT r'\u00A0'", "SELECT 1 AS `a\u00A0b`"]) {
      expect(hasCodeCharacter(sql, SPARK, NBSP)).toBe(false);
    }
  });

  test("the class is tested against code characters only, so ASCII white space, itself a span, is never one", () => {
    expect(hasCodeCharacter("SELECT\t1", DUCKDB, /\t/)).toBe(false);
    expect(hasCodeCharacter("SELECT 1;", DUCKDB, /;/)).toBe(true);
    expect(hasCodeCharacter("SELECT ';'", DUCKDB, /;/)).toBe(false);
  });

  test("under a row whose [ opens a subscript, the [ and the subscript's contents are code", () => {
    for (const grammar of [DUCKDB, SPARK]) {
      expect(hasCodeCharacter("SELECT [1,\u00A02][1]", grammar, NBSP)).toBe(true);
      expect(hasCodeCharacter("SELECT [[1],[\u00A0 2]][2]", grammar, NBSP)).toBe(true);
      expect(hasCodeCharacter("SELECT arr[\u00A0i]", grammar, NBSP)).toBe(true);
      expect(hasCodeCharacter("SELECT m['\u00A0']", grammar, NBSP)).toBe(false);
      expect(hasCodeCharacter("SELECT [1]", grammar, /\[/)).toBe(true);
    }
  });

  test("under a row whose [ opens a name, the bracketed name is stepped over like any other quoted name", () => {
    expect(hasCodeCharacter("SELECT 1 AS [a\u00A0b]", MSSQL, NBSP)).toBe(false);
    expect(hasCodeCharacter("SELECT 1 AS [a b]\u00A0", MSSQL, NBSP)).toBe(true);
    expect(hasCodeCharacter("SELECT 1 AS [a]", MSSQL, /\[/)).toBe(false);
  });

  test("a global or sticky class is refused, since its test would carry its position from one character to the next", () => {
    expect(() => hasCodeCharacter("SELECT 1", DUCKDB, /[\u00A0]/g)).toThrow(/neither global nor sticky/);
    expect(() => hasCodeCharacter("SELECT 1", DUCKDB, /[\u00A0]/y)).toThrow(/neither global nor sticky/);
  });

  /**
   * A walk that asked the span reader about each `[` had it read to the matching `]`, or to the end of the text when
   * none closes it, then stepped one character into the subscript, so each nested or unclosed `[` read the rest of the
   * text again: quadratic in them, over a second on inputs like these. The bound is loose so it cannot flake on a slow
   * runner, as in the Spark provider's statement-shape guard.
   */
  test("nested or unclosed brackets are read in bounded time", () => {
    const BOUND_MS = 200;
    for (const [label, sql] of [
      ["50k unclosed brackets", `SELECT ${"[".repeat(50_000)}`],
      ["20k letter and unclosed bracket pairs", `SELECT ${"a[".repeat(20_000)}`],
      ["a 25k-deep nested pair", `SELECT ${"[".repeat(25_000)}${"]".repeat(25_000)}`],
    ]) {
      for (const grammar of [DUCKDB, SPARK]) {
        const started = performance.now();
        const found = hasCodeCharacter(`${sql}\u00A0`, grammar, NBSP);
        const elapsed = performance.now() - started;
        expect(found).toBe(true);
        expect(elapsed, `${label} took ${elapsed.toFixed(1)}ms`).toBeLessThan(BOUND_MS);
      }
    }
  });
});
