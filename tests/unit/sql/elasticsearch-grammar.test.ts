/**
 * Elasticsearch's grammar row reads a backslash as the engine does: an ordinary character inside both quotes.
 * Measured on 9.1.4 on 2026-11-01: `SELECT 'a\' AS x` answers `a\`, `SELECT 'a\'b' AS x` is a parsing_exception at the
 * stray quote, `SELECT "a\" FROM probe_orders` names a column `a\`, and `".security"` names an index of those
 * twelve characters, never `.security`.
 */
import { describe, expect, test } from "bun:test";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readSqlSpan } from "@/lib/sql/spans";

const grammar = resolveSqlGrammar("elasticsearch");
const BS = "\\";

describe("the Elasticsearch grammar row's backslash", () => {
  test("is declared ordinary in both quotes", () => {
    expect(grammar.backslashAlwaysEscapes).toBe(false);
    expect(grammar.singleQuoteBackslashEscapes).toBe(false);
    expect(grammar.doubleQuoteBackslashEscapes).toBe(false);
  });

  test("ends a string at the quote after it", () => {
    expect(readSqlSpan(`'a${BS}'`, 0, grammar)).toEqual({ kind: "string", end: 4, terminated: true });
    expect(readSqlSpan(`'a${BS}'b'`, 0, grammar)).toEqual({ kind: "string", end: 4, terminated: true });
    expect(readSqlSpan(`'a''b'`, 0, grammar)).toEqual({ kind: "string", end: 6, terminated: true });
  });

  test("ends a quoted name at the quote after it", () => {
    expect(readSqlSpan(`"a${BS}"`, 0, grammar)).toEqual({ kind: "quoted-identifier", end: 4, terminated: true });
  });

  test("leaves a string that never closes unterminated", () => {
    expect(readSqlSpan("'abc", 0, grammar)).toEqual({ kind: "string", end: 4, terminated: false });
    expect(readSqlSpan('"abc', 0, grammar)).toEqual({ kind: "quoted-identifier", end: 4, terminated: false });
  });
});
