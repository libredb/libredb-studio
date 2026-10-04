import { describe, test, expect } from "bun:test";
import { typedLiteral } from "@/lib/export/typed-literals";

// The generic writer stands in for `result-export.ts`'s own, so every fallback is visible
// as `<...>` and cannot be mistaken for a typed literal.
const scalar = (value: unknown) => `<${typeof value === "string" ? value : JSON.stringify(value)}>`;

describe("typedLiteral: when nothing is typed", () => {
  test("answers undefined for a NULL cell, an unknown dialect and a dialect with no typed form", () => {
    expect(typedLiteral(null, "integer[]", "postgres", scalar)).toBeUndefined();
    expect(typedLiteral(undefined, "integer[]", "postgres", scalar)).toBeUndefined();
    expect(typedLiteral([1], "integer[]", undefined, scalar)).toBeUndefined();
    expect(typedLiteral([1], "integer[]", "sqlite", scalar)).toBeUndefined();
  });

  test("reads a declared type that is not a string as no declaration", () => {
    expect(typedLiteral([1], 42, "postgres", scalar)).toBeUndefined();
    expect(typedLiteral([1], { t: "Array(Int32)" }, "clickhouse", scalar)).toBeUndefined();
  });
});

describe("typedLiteral: postgres", () => {
  test("falls back for an object that is not an interval, a point or a circle", () => {
    expect(typedLiteral({ days: 1, weeks: 2 }, "interval", "postgres", scalar)).toBeUndefined();
    expect(typedLiteral({ days: "1" }, "interval", "postgres", scalar)).toBeUndefined();
    expect(typedLiteral({ x: 1, y: "2" }, "point", "postgres", scalar)).toBeUndefined();
    expect(typedLiteral({ x: 1, y: 2 }, "circle", "postgres", scalar)).toBeUndefined();
    expect(typedLiteral({ x: 1, y: 2 }, "box", "postgres", scalar)).toBeUndefined();
    expect(typedLiteral("1 day", "interval", "postgres", scalar)).toBeUndefined();
  });

  test("writes an element it has no text form for as JSON", () => {
    expect(typedLiteral([{ weeks: 1 }, 1.5], "interval[]", "postgres", scalar)).toBe(`'{"{\\"weeks\\":1}","1.5"}'`);
  });

  test("writes every json or jsonb element as JSON, a string included", () => {
    // `pg` JSON.parses each element, so the document "hello" arrives as the string hello.
    expect(typedLiteral(["hello", 1, null], "jsonb[]", "postgres", scalar)).toBe(`'{"\\"hello\\"","1",NULL}'`);
  });

  test("reads the declared type whatever its case and spacing", () => {
    expect(typedLiteral([1], "  INTEGER[] ", "postgres", scalar)).toBe(`'{"1"}'`);
  });
});

describe("typedLiteral: mssql", () => {
  test("types only a boolean", () => {
    expect(typedLiteral(true, undefined, "mssql", scalar)).toBe("1");
    expect(typedLiteral(false, "bit", "mssql", scalar)).toBe("0");
    expect(typedLiteral(1, "bit", "mssql", scalar)).toBeUndefined();
  });
});

describe("typedLiteral: clickhouse", () => {
  test("types only a composite column with a declaration", () => {
    expect(typedLiteral([1], undefined, "clickhouse", scalar)).toBeUndefined();
    expect(typedLiteral("x", "Array(String)", "clickhouse", scalar)).toBeUndefined();
    expect(typedLiteral({ type: "Buffer", data: [1] }, "Array(UInt8)", "clickhouse", scalar)).toBeUndefined();
    expect(typedLiteral({ a: 1 }, "JSON", "clickhouse", scalar)).toBeUndefined();
  });

  test("unwraps Nullable and LowCardinality around a container and its elements", () => {
    expect(typedLiteral(["a"], "Nullable(Array(LowCardinality(String)))", "clickhouse", scalar)).toBe("[<a>]");
  });

  test("hands an element the container cannot type to the generic writer", () => {
    // An Array cell that is not an array, and a tuple whose shape does not match its type.
    expect(typedLiteral(["x"], "Array(Array(Int32))", "clickhouse", scalar)).toBe("[<x>]");
    expect(typedLiteral({ a: "x" }, "Map(String, Array(Int32))", "clickhouse", scalar)).toBe("map(<a>, <x>)");
    expect(typedLiteral([[1, 2, 3]], "Array(Tuple(Int32, Int32))", "clickhouse", scalar)).toBe("[<[1,2,3]>]");
    expect(typedLiteral([{ a: 1 }], "Array(Tuple(a Int32, b Int32))", "clickhouse", scalar)).toBe('[<{"a":1}>]');
    expect(typedLiteral([{ a: 1 }], "Array(Tuple(Int32))", "clickhouse", scalar)).toBe('[<{"a":1}>]');
  });

  test("splits type arguments at the top level only, quotes and nesting respected", () => {
    expect(
      typedLiteral(
        { k: [1, "2024-01-01 00:00:00.000"] },
        "Map(String, Tuple(Int32, DateTime64(3, 'Europe/Istanbul')))",
        "clickhouse",
        scalar,
      ),
    ).toBe("map(<k>, tuple(<1>, <2024-01-01 00:00:00.000>))");
    expect(typedLiteral(["a"], "Array(Enum8('a,b' = 1))", "clickhouse", scalar)).toBe("[<a>]");
  });

  test("writes a non-finite word under a Float element as ClickHouse's bare spelling", () => {
    expect(typedLiteral(["NaN", "Infinity", "-Infinity", "1.5"], "Array(Float64)", "clickhouse", scalar)).toBe(
      "[nan, inf, -inf, 1.5]",
    );
    expect(typedLiteral(["NaN"], "Array(String)", "clickhouse", scalar)).toBe("[<NaN>]");
    expect(typedLiteral(["constructor"], "Array(Float32)", "clickhouse", scalar)).toBe("[<constructor>]");
  });

  test("writes a number-shaped string bare only under a numeric element type", () => {
    expect(typedLiteral(["1.5", "x"], "Array(Decimal(9, 2))", "clickhouse", scalar)).toBe("[1.5, <x>]");
    expect(typedLiteral(["1"], "Array(String)", "clickhouse", scalar)).toBe("[<1>]");
  });
});
