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

  test("doubles an embedded single quote in every dialect", () => {
    expect(quoteLiteral("O'Brien", "postgres")).toBe("'O''Brien'");
    expect(quoteLiteral("O'Brien", "mysql")).toBe("'O''Brien'");
    expect(quoteLiteral("O'Brien", "sqlite")).toBe("'O''Brien'");
    expect(quoteLiteral("O'Brien", "oracle")).toBe("'O''Brien'");
    expect(quoteLiteral("O'Brien", "mssql")).toBe("'O''Brien'");
    expect(quoteLiteral("O'Brien", "clickhouse")).toBe("'O''Brien'");
  });

  test("doubles a backslash where the dialect reads it as an escape", () => {
    expect(quoteLiteral("a\\b", "mysql")).toBe("'a\\\\b'");
    expect(quoteLiteral("a\\b", "clickhouse")).toBe("'a\\\\b'");
    expect(quoteLiteral("a\\b", "couchbase")).toBe("'a\\\\b'");
    expect(quoteLiteral("a\\b", "mongodb")).toBe("'a\\\\b'");
  });

  test("leaves a backslash alone where it is data", () => {
    expect(quoteLiteral("a\\b", "postgres")).toBe("'a\\b'");
    expect(quoteLiteral("a\\b", "sqlite")).toBe("'a\\b'");
    expect(quoteLiteral("a\\b", "oracle")).toBe("'a\\b'");
    expect(quoteLiteral("a\\b", "mssql")).toBe("'a\\b'");
    expect(quoteLiteral("a\\b", "druid")).toBe("'a\\b'");
    expect(quoteLiteral("a\\b", "redis")).toBe("'a\\b'");
    expect(quoteLiteral("a\\b", "libredb")).toBe("'a\\b'");
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
  });

  test("returns null for a dialect whose bind form this repo has not pinned", () => {
    // ClickHouse's provider refuses positional parameters outright, and the
    // remaining engines are not driven by a SQL statement at all. Null is the
    // signal to quote the value instead — never to emit an unbound placeholder.
    expect(positionalPlaceholder("clickhouse", 1)).toBeNull();
    expect(positionalPlaceholder("couchbase", 1)).toBeNull();
    expect(positionalPlaceholder("druid", 1)).toBeNull();
    expect(positionalPlaceholder("mongodb", 1)).toBeNull();
    expect(positionalPlaceholder("redis", 1)).toBeNull();
    expect(positionalPlaceholder("libredb", 1)).toBeNull();
  });
});
