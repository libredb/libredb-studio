import { describe, expect, test } from "bun:test";
import { quoteIdentifier } from "@/lib/sql/identifier";

// A column name reaching this helper is arbitrary engine output: a result field can
// be named by any alias the query wrote, including one that spells SQL. Quoting has
// to make the name inert, which means escaping the closing quote character too —
// without that, a name carrying one ends the quoted span and the rest is parsed as
// statement text (PR #289 review).

describe("quoteIdentifier", () => {
  test("wraps a name in the quoting characters the dialect uses", () => {
    expect(quoteIdentifier("name", "postgres")).toBe('"name"');
    expect(quoteIdentifier("name", "sqlite")).toBe('"name"');
    expect(quoteIdentifier("name", "oracle")).toBe('"name"');
    expect(quoteIdentifier("name", "clickhouse")).toBe('"name"');
    expect(quoteIdentifier("name", "mysql")).toBe("`name`");
    expect(quoteIdentifier("name", "mssql")).toBe("[name]");
  });

  test("doubles an embedded closing quote character", () => {
    expect(quoteIdentifier('a"b', "postgres")).toBe('"a""b"');
    expect(quoteIdentifier("a`b", "mysql")).toBe("`a``b`");
    expect(quoteIdentifier("a]b", "mssql")).toBe("[a]]b]");
  });

  test("leaves a name that spells SQL inert", () => {
    const hostile = "x = 1; DELETE FROM users; --";

    expect(quoteIdentifier(hostile, "postgres")).toBe('"x = 1; DELETE FROM users; --"');
    expect(quoteIdentifier(hostile, "mysql")).toBe("`x = 1; DELETE FROM users; --`");
    expect(quoteIdentifier(hostile, "mssql")).toBe("[x = 1; DELETE FROM users; --]");
  });

  test("preserves a name that needs quoting to be legal at all", () => {
    // Spaces and reserved words are the everyday reason to quote; before this
    // helper the inline editor emitted them bare and the engine rejected the SQL.
    expect(quoteIdentifier("first name", "postgres")).toBe('"first name"');
    expect(quoteIdentifier("order", "mysql")).toBe("`order`");
  });
});
