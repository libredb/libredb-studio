/**
 * ClickHouse schema introspection (issue #264, design spec section 3.6)
 *
 * Driven entirely through a hand-built ClickHouseTransport - the point of the
 * seam: no fetch mocking, no `mock.module()` (process-wide in bun) and no
 * server. Every row shape below was captured from a live ClickHouse
 * 26.7.1.1315 instance, so the fake speaks exactly what the server speaks,
 * including the two encodings that break naive parsing: a `UInt64` arrives as a
 * decimal STRING (spec 2.1 quoting) while a `UInt8` stays a NUMBER, and a
 * `Nullable(UInt64)` arrives as `null` for anything that is not a MergeTree.
 */
import { describe, expect, test } from "bun:test";
import {
  CLICKHOUSE_SYSTEM_DATABASES,
  isNullableType,
  readCount,
  readDefault,
  readIdentifier,
  readText,
  splitKeyExpression,
} from "@/lib/db/providers/sql/clickhouse/introspect";

// ============================================================================
// The system-database filter
// ============================================================================

describe("the system-database filter", () => {
  test("names exactly the three system databases the live server reports", () => {
    expect([...CLICKHOUSE_SYSTEM_DATABASES]).toEqual(["system", "information_schema", "INFORMATION_SCHEMA"]);
  });
});

// ============================================================================
// The key expression reader
// ============================================================================

/**
 * `splitKeyExpression` is what turns a ClickHouse sorting key, primary key or skipping-index
 * expression into the column list the object surface publishes as an index
 * (`objects.ts` calls it for `system.data_skipping_indices.expr`). ClickHouse writes those as
 * ONE expression, not as a list, so every case below is a real shape the server produces.
 *
 * The quoted-span cases are the ones that make this a reader rather than a `split(",")`: a
 * backtick-quoted identifier may legally contain a comma or a parenthesis, and an escaped
 * quote does not close the span.
 */
describe("splitKeyExpression", () => {
  test("a single column is one element", () => {
    expect(splitKeyExpression("id")).toEqual(["id"]);
  });

  test("a tuple is unwrapped and split, and the whitespace goes", () => {
    expect(splitKeyExpression("(id, created_at)")).toEqual(["id", "created_at"]);
  });

  test("a comma INSIDE a quoted identifier does not split it", () => {
    // `region,code` is one column name. A `split(",")` reads it as two columns that do not
    // exist, and the index then publishes a column list nobody declared.
    expect(splitKeyExpression("(`region,code`, id)")).toEqual(["`region,code`", "id"]);
  });

  test("a parenthesis inside a quoted identifier does not move the depth counter", () => {
    // The `(` inside the name would otherwise leave the reader one level deep for the rest
    // of the expression, so the trailing `id` would never be split off.
    expect(splitKeyExpression("(`a(b`, id)")).toEqual(["`a(b`", "id"]);
  });

  test("a doubled quote escapes the quote rather than closing the span", () => {
    expect(splitKeyExpression("(`a``b,c`, id)")).toEqual(["`a``b,c`", "id"]);
  });

  test("a backslash escapes the next character inside a quoted span", () => {
    expect(splitKeyExpression("('a\\',b', id)")).toEqual(["'a\\',b'", "id"]);
  });

  test("an unterminated quote consumes the rest, which cannot mis-split", () => {
    // The reading that is wrong in the safe direction: one element carrying everything,
    // rather than a split at a comma that is inside a name.
    expect(splitKeyExpression("(`a,b, id)")).toEqual(["`a,b, id"]);
  });

  test("a function call keeps its own arguments together", () => {
    expect(splitKeyExpression("(toYYYYMM(created_at), id)")).toEqual(["toYYYYMM(created_at)", "id"]);
  });

  test("an empty expression is no columns at all", () => {
    expect(splitKeyExpression("")).toEqual([]);
    expect(splitKeyExpression("()")).toEqual([]);
  });

  test("a parenthesised expression that is not a tuple is left whole", () => {
    // `unwrapOuterParens` only strips a wrapper that really wraps the whole expression.
    expect(splitKeyExpression("(a) + (b)")).toEqual(["(a) + (b)"]);
  });
});

// ============================================================================
// Row value readers
// ============================================================================

describe("row value readers", () => {
  test("readIdentifier answers a non-empty string and nothing else", () => {
    expect(readIdentifier("users")).toBe("users");
    expect(readIdentifier("")).toBeNull();
    expect(readIdentifier(null)).toBeNull();
    expect(readIdentifier(7)).toBeNull();
  });

  test("readText answers the empty string where there is no text", () => {
    expect(readText("x")).toBe("x");
    expect(readText(null)).toBe("");
    expect(readText(3)).toBe("");
  });

  test("readCount reads the quoted-string form a MergeTree reports", () => {
    // `system.tables.total_rows` arrives as a STRING over the HTTP interface.
    expect(readCount("3")).toBe(3);
    expect(readCount(3)).toBe(3);
    // A view reports null for both figures, which is an absence and never a zero.
    expect(readCount(null)).toBeUndefined();
    expect(readCount("not a number")).toBeUndefined();
  });

  test("isNullableType reads the declared type rather than a value", () => {
    expect(isNullableType("Nullable(String)")).toBe(true);
    expect(isNullableType("LowCardinality(Nullable(String))")).toBe(true);
    expect(isNullableType("String")).toBe(false);
  });

  test("readDefault carries only a default the column really declares", () => {
    expect(readDefault("DEFAULT", "now()")).toBe("now()");
    expect(readDefault("", "")).toBeUndefined();
    // A MATERIALIZED or ALIAS column is not a value an INSERT may override, so its
    // expression is LABELLED with its kind rather than printed bare as a default.
    expect(readDefault("MATERIALIZED", "a + b")).toBe("MATERIALIZED a + b");
    expect(readDefault("DEFAULT", "")).toBeUndefined();
  });
});
