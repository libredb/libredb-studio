import { describe, expect, test } from "bun:test";
import { positionalPlaceholder, quoteLiteral, unquoteLiteral } from "@/lib/sql/values";
import type { DatabaseType } from "@/lib/types";

// A value reaching SQL generation is arbitrary text — a pasted cell, an imported
// result, a natural key read back from the table. Doubling the quote is only half
// the escape: MySQL and the JSON-shaped dialects read a backslash as an escape
// inside a string literal, so `\'` there closes the literal early and the rest of
// the value is parsed as statement text (issue #290). Binding the value is the
// real fix; this quoting is what the dialects without a positional bind form get.

describe("quoteLiteral", () => {
  test("wraps a value in single quotes", () => {
    expect(quoteLiteral("abc", "postgres")).toBe("'abc'");
    expect(quoteLiteral("abc", "mysql")).toBe("'abc'");
  });

  test("doubles an embedded single quote where doubling is the escape", () => {
    expect(quoteLiteral("O'Brien", "postgres")).toBe("'O''Brien'");
    expect(quoteLiteral("O'Brien", "mysql")).toBe("'O''Brien'");
    expect(quoteLiteral("O'Brien", "sqlite")).toBe("'O''Brien'");
    expect(quoteLiteral("O'Brien", "oracle")).toBe("'O''Brien'");
    expect(quoteLiteral("O'Brien", "clickhouse")).toBe("'O''Brien'");
    expect(quoteLiteral("O'Brien", "druid")).toBe("'O''Brien'");
    // Measured on Trino 476: `SELECT 'O''Brien' AS a` answers the row `O'Brien`.
    expect(quoteLiteral("O'Brien", "trino")).toBe("'O''Brien'");
    // Measured on DuckDB v1.5.5: `SELECT 'it''s'` answers `it's`.
    expect(quoteLiteral("O'Brien", "duckdb")).toBe("'O''Brien'");
  });

  test("prefixes the SQL Server literal with N, so the value is read as Unicode", () => {
    // SQL Server parses a BARE literal in the DATABASE's collation code page, and only
    // an `N`-prefixed one as Unicode. Measured on SQL Server 2022 CU26 against
    // AdventureWorks2022, collation `SQL_Latin1_General_CP1_CI_AS` (code page 1252):
    // `SELECT 'Müşteri'` answers `Müsteri`, because `ş` (U+015F) is not in 1252 and the
    // server best-fits it to `s`. With schemas `Müşteri` and `Müsteri` both present,
    // `… WHERE s.name = 'Müşteri'` matched `Müsteri.Siparis` - the WRONG object - while
    // `… WHERE s.name = N'Müşteri'` matched `Müşteri.Sipariş`. Every catalog name this
    // repo composes a selector against is `sysname`, which is `nvarchar(128)`.
    expect(quoteLiteral("Müşteri", "mssql")).toBe("N'Müşteri'");
    // The escaping is the standard doubling either way: the prefix decides the
    // character set, not the escape.
    expect(quoteLiteral("O'Brien", "mssql")).toBe("N'O''Brien'");
    // A backslash is ordinary data on this dialect, as it is on the `standard` ones.
    expect(quoteLiteral("a\\b", "mssql")).toBe("N'a\\b'");
  });

  test("escapes the quote with a backslash where the grammar has no doubling", () => {
    // Couchbase's SQL++ spells every escape with a backslash:
    //   char ::= unicode-character | '\' ( '\' | '"' | "'" | 'b' | ... )
    // Doubling is not in that grammar, so `'O''Brien'` is not one literal there.
    expect(quoteLiteral("O'Brien", "couchbase")).toBe("'O\\'Brien'");
  });

  test("leaves a backslash alone on duckdb, where it is ordinary data", () => {
    // Measured on v1.5.5: `SELECT 'a\\b', length('a\\b')` answers the three characters
    // `a\\b`, so doubling it would add a second one to the value.
    expect(quoteLiteral("a\\b", "duckdb")).toBe("'a\\b'");
  });

  test("doubles a backslash where the dialect reads it as an escape", () => {
    expect(quoteLiteral("a\\b", "mysql")).toBe("'a\\\\b'");
    expect(quoteLiteral("a\\b", "clickhouse")).toBe("'a\\\\b'");
    expect(quoteLiteral("a\\b", "couchbase")).toBe("'a\\\\b'");
  });

  test("leaves a backslash alone where it is data", () => {
    expect(quoteLiteral("a\\b", "postgres")).toBe("'a\\b'");
    expect(quoteLiteral("a\\b", "sqlite")).toBe("'a\\b'");
    expect(quoteLiteral("a\\b", "oracle")).toBe("'a\\b'");
    expect(quoteLiteral("a\\b", "druid")).toBe("'a\\b'");
    // Measured on Trino 476: `SELECT 'a\b' AS a` answers the two characters `a\b`, so
    // the backslash is data and doubling it would put a second one in the value.
    expect(quoteLiteral("a\\b", "trino")).toBe("'a\\b'");
  });

  test("gives the standard form to an engine that has no SQL of its own", () => {
    // MongoDB, Redis and the embedded engine all declare `queryLanguage: "json"`,
    // so no statement is ever built for them to read. What a generator emits for
    // such a connection is portable SQL meant to run elsewhere, and the standard
    // form is the only thing it can claim.
    expect(quoteLiteral("a\\b", "mongodb")).toBe("'a\\b'");
    expect(quoteLiteral("a\\b", "redis")).toBe("'a\\b'");
    expect(quoteLiteral("a\\b", "libredb")).toBe("'a\\b'");
    expect(quoteLiteral("O'Brien", "mongodb")).toBe("'O''Brien'");
    // Prometheus writes PromQL, and no SQL statement is ever built for it either, so the same
    // portable claim holds for it (#1085).
    expect(quoteLiteral("a\\b", "prometheus")).toBe("'a\\b'");
  });

  test("falls back to the standard form when no dialect is known", () => {
    // A generator that has no connection yet (no engine has been picked) can only
    // claim the SQL standard, which is also what its identifier quoting claims.
    // Doubling a backslash there would corrupt the value on the dialects that read
    // it as data — the larger group.
    expect(quoteLiteral("a\\b", undefined)).toBe("'a\\b'");
    expect(quoteLiteral("O'Brien", undefined)).toBe("'O''Brien'");
  });

  test("the issue #290 payload cannot close the literal early on MySQL", () => {
    // Read as MySQL: '  \\ -> one backslash, '' -> one quote, then the text, then
    // the closing quote. Every character of the payload stays data, so the trailing
    // `WHERE 1=1` is not the statement's predicate.
    expect(quoteLiteral("\\' WHERE 1=1 -- ", "mysql")).toBe("'\\\\'' WHERE 1=1 -- '");
  });
});

describe("positionalPlaceholder", () => {
  test("spells the placeholder the driver binds for each dialect", () => {
    expect(positionalPlaceholder("postgres", 1)).toBe("$1");
    expect(positionalPlaceholder("postgres", 2)).toBe("$2");
    expect(positionalPlaceholder("mysql", 1)).toBe("?");
    expect(positionalPlaceholder("mysql", 2)).toBe("?");
    expect(positionalPlaceholder("sqlite", 1)).toBe("?");
    expect(positionalPlaceholder("oracle", 1)).toBe(":1");
    expect(positionalPlaceholder("oracle", 2)).toBe(":2");
    // mssql binds `request.input("p1", ...)`, so the statement must say `@p1`.
    expect(positionalPlaceholder("mssql", 1)).toBe("@p1");
    expect(positionalPlaceholder("mssql", 2)).toBe("@p2");
    // Druid's provider binds a `parameters` array against `?` placeholders, which
    // its own doc comment records as live-verified.
    expect(positionalPlaceholder("druid", 1)).toBe("?");
    // Couchbase sends `args`, which SQL++ reads as `$1`, `$2` — the integration
    // test pins the pair with `bodyOf("country = $1").args`.
    expect(positionalPlaceholder("couchbase", 1)).toBe("$1");
    expect(positionalPlaceholder("couchbase", 2)).toBe("$2");
    // DuckDB binds both `?` and `$1` (measured); `?` is the form this repo pins,
    // because `$` also opens a dollar-quoted literal in this dialect.
    expect(positionalPlaceholder("duckdb", 1)).toBe("?");
    expect(positionalPlaceholder("duckdb", 2)).toBe("?");
  });

  test("trino has no positional placeholder, because its provider refuses to bind one", () => {
    // Trino DOES bind values, but only through `PREPARE`/`EXECUTE` plus an
    // `X-Trino-Prepared-Statement` header, and the provider's transport seam carries
    // the statement alone - so `TrinoProvider.query()` throws on a non-empty params
    // array rather than sending an unbound placeholder. Emitting `?` here would build
    // a statement the provider then declines to run, so the caller must quote the
    // value with `quoteLiteral` instead. The same reasoning as the two search ids.
    expect(positionalPlaceholder("trino", 1)).toBeNull();
    expect(positionalPlaceholder("trino", 2)).toBeNull();
  });

  test("returns null where this repo knows there is no positional bind form", () => {
    // ClickHouse's provider refuses positional parameters outright, and the other
    // three declare `queryLanguage: "json"`, so no SQL statement binds anything for
    // them. Null is the signal to quote the value instead — never to emit an
    // unbound placeholder.
    expect(positionalPlaceholder("clickhouse", 1)).toBeNull();
    expect(positionalPlaceholder("mongodb", 1)).toBeNull();
    expect(positionalPlaceholder("redis", 1)).toBeNull();
    expect(positionalPlaceholder("libredb", 1)).toBeNull();
    // PromQL binds nothing at all (#1085 5.1), so there is no placeholder to emit.
    expect(positionalPlaceholder("prometheus", 1)).toBeNull();
  });
});

// The inverse of `quoteLiteral`, and it lives here because the escape rules it undoes are
// already measured in this module. A catalog that reports a default as the literal AS
// WRITTEN, which MariaDB does and MySQL does not, is read back through this (issue #795).
describe("unquoteLiteral", () => {
  test("decodes a literal in the doubling dialects", () => {
    expect(unquoteLiteral("'abc'", "postgres")).toBe("abc");
    expect(unquoteLiteral("'it''s'", "postgres")).toBe("it's");
    expect(unquoteLiteral("''", "postgres")).toBe("");
    // A backslash is DATA here, so it survives untouched.
    expect(unquoteLiteral("'a\\b'", "postgres")).toBe("a\\b");
  });

  test("decodes the backslash escapes where the dialect reads a backslash as one", () => {
    // Measured on MariaDB 12.3.2, 2026-09-20: a column whose default is the three
    // characters a, backslash, b reports COLUMN_DEFAULT as 'a\\b', hex 27615C5C6227.
    expect(unquoteLiteral("'a\\\\b'", "mysql")).toBe("a\\b");
    expect(unquoteLiteral("'a\\\\'", "mysql")).toBe("a\\");
    expect(unquoteLiteral("'a\\nb'", "mysql")).toBe("a\nb");
    expect(unquoteLiteral("'a\\tb'", "mysql")).toBe("a\tb");
    expect(unquoteLiteral("'a\\0b'", "mysql")).toBe("a\u0000b");
    expect(unquoteLiteral("'a\\Zb'", "mysql")).toBe("a\u001ab");
    expect(unquoteLiteral("'a\\rb'", "mysql")).toBe("a\rb");
    expect(unquoteLiteral("'a\\bb'", "mysql")).toBe("a\bb");
    expect(unquoteLiteral("'a\\\"b'", "mysql")).toBe('a"b');
    expect(unquoteLiteral("'a\\'b'", "mysql")).toBe("a'b");
    // MySQL DOCUMENTS these two as keeping both characters, for LIKE.
    expect(unquoteLiteral("'a\\%b'", "mysql")).toBe("a\\%b");
    expect(unquoteLiteral("'a\\_b'", "mysql")).toBe("a\\_b");
    // Any other escaped character is itself.
    expect(unquoteLiteral("'a\\qb'", "mysql")).toBe("aqb");
    // Doubling works too, and MariaDB normalises a backslash-escaped quote INTO it:
    // measured 2026-09-20, DEFAULT 'a\'b' reads back as 'a''b'.
    expect(unquoteLiteral("'a''b'", "mysql")).toBe("a'b");
  });

  test("decodes the backslash-only grammar, where doubling is not an escape", () => {
    expect(unquoteLiteral("'a\\'b'", "couchbase")).toBe("a'b");
    expect(unquoteLiteral("'a\\\\b'", "couchbase")).toBe("a\\b");
    // Two literals side by side, not one with a doubled quote, so this is not one literal.
    expect(unquoteLiteral("'a''b'", "couchbase")).toBeUndefined();
  });

  test("accepts the Unicode prefix SQL Server's literals carry", () => {
    expect(unquoteLiteral("N'abc'", "mssql")).toBe("abc");
    expect(unquoteLiteral("N'it''s'", "mssql")).toBe("it's");
    expect(unquoteLiteral("'abc'", "mssql")).toBe("abc");
  });

  test("answers undefined for text that is not exactly one literal", () => {
    // What a catalog reports for an expression default or a number, which the caller
    // passes through as written rather than decoding.
    expect(unquoteLiteral("42", "mysql")).toBeUndefined();
    expect(unquoteLiteral("current_timestamp()", "mysql")).toBeUndefined();
    expect(unquoteLiteral("concat('x','y')", "mysql")).toBeUndefined();
    // The literal closes before the end, so stripping the outer quotes would corrupt it.
    expect(unquoteLiteral("('a' = 'b')", "mysql")).toBeUndefined();
    expect(unquoteLiteral("'a' = 'b'", "mysql")).toBeUndefined();
    // Never closed, and one lone quote.
    expect(unquoteLiteral("'abc", "mysql")).toBeUndefined();
    expect(unquoteLiteral("'", "mysql")).toBeUndefined();
    expect(unquoteLiteral("", "mysql")).toBeUndefined();
    // A trailing backslash escapes the closing quote, so the literal never closes.
    expect(unquoteLiteral("'abc\\'", "mysql")).toBeUndefined();
  });

  test("an unknown dialect decodes the standard form, matching what quoteLiteral writes", () => {
    expect(unquoteLiteral("'a\\b'", undefined)).toBe("a\\b");
    expect(unquoteLiteral("'it''s'", undefined)).toBe("it's");
  });

  // The binding test. The two halves can now only break together, which is what stops a
  // third, half-right copy of the escape rules from being written somewhere else.
  test("round-trips every value quoteLiteral can produce, on every dialect", () => {
    const values = ["", "abc", "it's", "a''b", "a\\b", "a\\", "'", "\\", "a\nb", "a\tb", "a\u0000b", "O'Brien\\"];
    const dialects: DatabaseType[] = ["postgres", "mysql", "mssql", "couchbase", "duckdb", "clickhouse", "trino"];
    for (const dialect of dialects) {
      for (const value of values) {
        expect(unquoteLiteral(quoteLiteral(value, dialect), dialect)).toBe(value);
      }
    }
  });
});
