import { describe, test, expect } from "bun:test";
import { cqlFrozenNested, typedLiteral, UnwritableValue } from "@/lib/export/typed-literals";

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

describe("typedLiteral: trino", () => {
  test("types nothing without a declaration", () => {
    expect(typedLiteral("1", undefined, "trino", scalar)).toBeUndefined();
  });

  test("hands a value its type has no literal form for to the generic writer", () => {
    expect(typedLiteral("x", "bigint", "trino", scalar)).toBe("<x>");
    expect(typedLiteral("not base64!", "varbinary", "trino", scalar)).toBe("<not base64!>");
    expect(typedLiteral(true, "boolean", "trino", scalar)).toBe("<true>");
    expect(typedLiteral({ a: 1 }, "json", "trino", scalar)).toBe(`JSON '{"a":1}'`);
  });

  test("writes a double or real NaN and infinity as a typed literal, nested ones included", () => {
    expect(typedLiteral("NaN", "double", "trino", scalar)).toBe("DOUBLE 'NaN'");
    expect(typedLiteral(-Infinity, "double", "trino", scalar)).toBe("DOUBLE '-Infinity'");
    expect(typedLiteral("Infinity", "real", "trino", scalar)).toBe("REAL 'Infinity'");
    expect(typedLiteral(["NaN", 1.5], "array(double)", "trino", scalar)).toBe("ARRAY[DOUBLE 'NaN', 1.5]");
    // A text column may hold the word itself.
    expect(typedLiteral("NaN", "varchar", "trino", scalar)).toBe("<NaN>");
  });

  test("reads a multi-word type as an unnamed row field", () => {
    expect(
      typedLiteral([1, "2024-01-01 00:00:00.000 UTC"], "row(integer, timestamp(3) with time zone)", "trino", scalar),
    ).toBe("ROW(1, TIMESTAMP '2024-01-01 00:00:00.000 UTC')");
    expect(typedLiteral([1.5], "row(double precision)", "trino", scalar)).toBe("ROW(<1.5>)");
  });

  test("reads an unnamed row field and refuses a composite of the wrong shape", () => {
    expect(typedLiteral([1, "x"], "row(integer, varchar)", "trino", scalar)).toBe("ROW(1, <x>)");
    expect(typedLiteral([1, "x"], 'row("a b" integer, c varchar)', "trino", scalar)).toBe("ROW(1, <x>)");
    expect(() => typedLiteral([1], "row(a integer, b varchar)", "trino", scalar)).toThrow(UnwritableValue);
    expect(() => typedLiteral({}, "row(a integer)", "trino", scalar)).toThrow(UnwritableValue);
    expect(() => typedLiteral("x", "array(integer)", "trino", scalar)).toThrow(UnwritableValue);
    expect(() => typedLiteral([], "map(varchar, integer)", "trino", scalar)).toThrow(UnwritableValue);
  });
});

describe("typedLiteral: duckdb", () => {
  test("types only a composite or interval cell with a declaration", () => {
    expect(typedLiteral([1], undefined, "duckdb", scalar)).toBeUndefined();
    expect(typedLiteral("1", "INTEGER[]", "duckdb", scalar)).toBeUndefined();
    expect(typedLiteral({ type: "Buffer", data: [1] }, "BLOB", "duckdb", scalar)).toBeUndefined();
    expect(typedLiteral({ a: 1 }, "JSON", "duckdb", scalar)).toBe('<{"a":1}>');
  });

  test("writes a number-shaped element bare and an interval only from its three parts", () => {
    expect(typedLiteral(["1", 2.5, "x"], "DECIMAL(9,2)[]", "duckdb", scalar)).toBe("[1, 2.5, <x>]");
    expect(typedLiteral({ months: 0, days: 0, micros: 5 }, "INTERVAL", "duckdb", scalar)).toBe(
      "INTERVAL '0 months 0 days 5 microseconds'",
    );
    for (const value of [
      { months: 1, days: 2 },
      { months: 1.5, days: 0, micros: "0" },
      { months: 1, days: 0, micros: "1.5" },
      { months: 1, days: 0, micros: "x" },
    ]) {
      expect(() => typedLiteral(value, "INTERVAL", "duckdb", scalar)).toThrow(UnwritableValue);
    }
  });

  test("reads an unquoted STRUCT field, and refuses a composite of the wrong shape", () => {
    expect(typedLiteral({ a: 1 }, "STRUCT(a INTEGER)", "duckdb", scalar)).toBe("{'a': 1}");
    expect(typedLiteral({ 'a"b': 1 }, 'STRUCT("a""b" INTEGER)', "duckdb", scalar)).toBe(`{'a"b': 1}`);
    expect(() => typedLiteral({ b: 1 }, "STRUCT(a INTEGER)", "duckdb", scalar)).toThrow(UnwritableValue);
    expect(() => typedLiteral({ a: 1 }, "STRUCT(INTEGER)", "duckdb", scalar)).toThrow(UnwritableValue);
    expect(() => typedLiteral({ a: 1 }, "INTEGER[]", "duckdb", scalar)).toThrow(UnwritableValue);
    expect(() => typedLiteral({ k: 1 }, "MAP(VARCHAR, INTEGER)", "duckdb", scalar)).toThrow(UnwritableValue);
    expect(() => typedLiteral([1], "MAP(VARCHAR, INTEGER)", "duckdb", scalar)).toThrow(UnwritableValue);
  });
});

describe("typedLiteral: cassandra", () => {
  test("types nothing without a declaration, and writes an absent element as null", () => {
    expect(typedLiteral([1], undefined, "cassandra", scalar)).toBeUndefined();
    expect(typedLiteral([1, null], "list<int>", "cassandra", scalar)).toBe("[1, null]");
    expect(typedLiteral([1.5, 2], "frozen<vector<float, 2>>", "cassandra", scalar)).toBe("[1.5, 2]");
  });

  test("hands a value its type has no bare form for to the generic writer", () => {
    expect(typedLiteral("x", "bigint", "cassandra", scalar)).toBe("<x>");
    expect(typedLiteral("x", "uuid", "cassandra", scalar)).toBe("<x>");
    expect(typedLiteral("1 day", "duration", "cassandra", scalar)).toBe("<1 day>");
    expect(typedLiteral("x", "text", "cassandra", scalar)).toBe("<x>");
  });

  test("writes a float or double NaN and infinity as CQL's bare words, nested ones included", () => {
    expect(typedLiteral("NaN", "double", "cassandra", scalar)).toBe("NaN");
    expect(typedLiteral(Infinity, "float", "cassandra", scalar)).toBe("Infinity");
    expect(typedLiteral(["-Infinity", 1.5], "list<double>", "cassandra", scalar)).toBe("[-Infinity, 1.5]");
    expect(typedLiteral("NaN", "text", "cassandra", scalar)).toBe("<NaN>");
  });

  test("writes the zero duration the provider spells", () => {
    expect(typedLiteral("0s", "duration", "cassandra", scalar)).toBe("0s");
  });

  test("refuses a collection or tuple of the wrong shape", () => {
    expect(() => typedLiteral("x", "list<int>", "cassandra", scalar)).toThrow(UnwritableValue);
    expect(() => typedLiteral([1], "map<int, int>", "cassandra", scalar)).toThrow(UnwritableValue);
    expect(() => typedLiteral({}, "tuple<int>", "cassandra", scalar)).toThrow(UnwritableValue);
  });

  test("freezes only what is nested in a collection", () => {
    expect(cqlFrozenNested("list<int>")).toBe("list<int>");
    expect(cqlFrozenNested("address")).toBe("address");
    expect(cqlFrozenNested("frozen<list<list<int>>>")).toBe("frozen<list<list<int>>>");
    expect(cqlFrozenNested("map<text, tuple<int, list<int>>>")).toBe(
      "map<text, frozen<tuple<int, frozen<list<int>>>>>",
    );
    expect(cqlFrozenNested("vector<float, 3>")).toBe("vector<float, 3>");
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

  test("refuses an element that does not have its container's declared shape", () => {
    // An Array cell that is not an array, and a tuple whose shape does not match its type.
    for (const [value, type] of [
      [["x"], "Array(Array(Int32))"],
      [{ a: "x" }, "Map(String, Array(Int32))"],
      [["x"], "Array(Map(String, Int32))"],
      [[[1, 2, 3]], "Array(Tuple(Int32, Int32))"],
      [[{ a: 1 }], "Array(Tuple(a Int32, b Int32))"],
      [[{ a: 1 }], "Array(Tuple(Int32))"],
    ] as const) {
      expect(() => typedLiteral(value, type, "clickhouse", scalar)).toThrow(UnwritableValue);
    }
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
