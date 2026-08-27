import { describe, expect, test } from "bun:test";
import { positionalPlaceholder, quoteLiteral } from "@/lib/sql/values";

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
    expect(quoteLiteral("O'Brien", "mssql")).toBe("'O''Brien'");
    expect(quoteLiteral("O'Brien", "clickhouse")).toBe("'O''Brien'");
    expect(quoteLiteral("O'Brien", "druid")).toBe("'O''Brien'");
    // Measured on Trino 476: `SELECT 'O''Brien' AS a` answers the row `O'Brien`.
    expect(quoteLiteral("O'Brien", "trino")).toBe("'O''Brien'");
    // Measured on DuckDB v1.5.5: `SELECT 'it''s'` answers `it's`.
    expect(quoteLiteral("O'Brien", "duckdb")).toBe("'O''Brien'");
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
    expect(quoteLiteral("a\\b", "mssql")).toBe("'a\\b'");
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
  });
});
