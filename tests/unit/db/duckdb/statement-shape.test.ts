/**
 * The refusal the DuckDB provider makes before the engine reads a statement, read under the DuckDB grammar row.
 */
import { describe, expect, test } from "bun:test";
import { DUCKDB_UNICODE_SPACE_SENTENCE, unicodeSpaceRefusal } from "@/lib/db/providers/sql/duckdb/statement-shape";

/** The characters DuckDB 1.5.5 reads as a space between two code words, measured one by one. */
const SPACES = [
  "\u00A0",
  "\u2000",
  "\u2001",
  "\u2002",
  "\u2003",
  "\u2004",
  "\u2005",
  "\u2006",
  "\u2007",
  "\u2008",
  "\u2009",
  "\u200A",
  "\u200B",
  "\u202F",
  "\u205F",
  "\u2060",
  "\u3000",
  "\uFEFF",
];

describe("unicodeSpaceRefusal", () => {
  test("each space DuckDB reads as white space is refused between two code words, also in INSERT OR REPLACE", () => {
    for (const space of SPACES) {
      expect(unicodeSpaceRefusal(`SELECT${space}1`)).toBe(DUCKDB_UNICODE_SPACE_SENTENCE);
      expect(unicodeSpaceRefusal(`INSERT${space}OR${space}REPLACE INTO t VALUES (1, 'new', NULL)`)).toBe(
        DUCKDB_UNICODE_SPACE_SENTENCE,
      );
      expect(unicodeSpaceRefusal(`INSERT OR${space}REPLACE INTO t VALUES (1, 'new', NULL)`)).toBe(
        DUCKDB_UNICODE_SPACE_SENTENCE,
      );
      expect(unicodeSpaceRefusal(`${space}SELECT 1`)).toBe(DUCKDB_UNICODE_SPACE_SENTENCE);
    }
  });

  test("the same character inside a string, a dollar string, a quoted name or a comment is not refused", () => {
    for (const space of SPACES) {
      for (const sql of [
        `SELECT '${space}'`,
        `SELECT $$${space}$$`,
        `SELECT $tag$${space}$tag$`,
        `SELECT 1 AS "a${space}b"`,
        `SELECT 1 -- ${space}`,
        `/* ${space} */ SELECT 1`,
        `/* a /* nested ${space} */ still */ SELECT 1`,
      ]) {
        expect(unicodeSpaceRefusal(sql)).toBeUndefined();
      }
    }
  });

  test("the contents of a subscript are code, so the same character there is refused", () => {
    expect(unicodeSpaceRefusal("SELECT [1,\u00A02][1]")).toBe(DUCKDB_UNICODE_SPACE_SENTENCE);
    expect(unicodeSpaceRefusal("SELECT [[1],[\u3000 2]][2]")).toBe(DUCKDB_UNICODE_SPACE_SENTENCE);
    expect(unicodeSpaceRefusal("SELECT m['\u00A0']")).toBeUndefined();
  });

  test("ordinary white space, the characters DuckDB does not read as a space and a statement with none are not refused", () => {
    // Measured on 1.5.5: with U+0085, U+1680, U+180E, U+200C, U+200D, U+2028 or U+2029 between SELECT and 1 the
    // statement is a Parser Error, so DuckDB and Studio's reader agree that none of them is a space.
    expect(unicodeSpaceRefusal("SELECT\t1\r\nFROM t\f")).toBeUndefined();
    for (const other of ["\u0085", "\u1680", "\u180E", "\u200C", "\u200D", "\u2028", "\u2029"]) {
      expect(unicodeSpaceRefusal(`SELECT${other}1`)).toBeUndefined();
    }
    expect(unicodeSpaceRefusal("")).toBeUndefined();
  });

  test("an unclosed subscript is read to the end of the text once, however many brackets open", () => {
    const text = `SELECT ${"[".repeat(20_000)}1`;
    expect(unicodeSpaceRefusal(text)).toBeUndefined();
    expect(unicodeSpaceRefusal(`${text}\u00A0`)).toBe(DUCKDB_UNICODE_SPACE_SENTENCE);
  });
});
