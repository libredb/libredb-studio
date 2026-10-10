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

  // `datetime` and `smalldatetime` read `yyyy-mm-dd hh:mi:ss` through the session's
  // DATEFORMAT, so the provider's text (#1452) goes out in the ISO 8601 form with a `T`.
  test("writes a datetime and a smalldatetime's own text as ISO 8601 with a T", () => {
    expect(typedLiteral("2026-10-04 12:34:56.123", "datetime", "mssql", scalar)).toBe("N'2026-10-04T12:34:56.123'");
    expect(typedLiteral("2026-10-04 12:35:00", "smalldatetime", "mssql", scalar)).toBe("N'2026-10-04T12:35:00'");
    expect(typedLiteral("2026-10-04 12:35:00", " SmallDateTime ", "mssql", scalar)).toBe("N'2026-10-04T12:35:00'");
  });

  test("leaves every other datetime-shaped cell to the generic writer", () => {
    // `datetime2` and `date` read `yyyy-mm-dd` the same under every DATEFORMAT already.
    expect(typedLiteral("2026-10-04 12:34:56.123", "datetime2", "mssql", scalar)).toBeUndefined();
    expect(typedLiteral("2026-10-04 12:34:56.123", undefined, "mssql", scalar)).toBeUndefined();
    // Text the provider never reads a datetime as stays the text it is.
    expect(typedLiteral("2026-10-04T12:34:56.123Z", "datetime", "mssql", scalar)).toBeUndefined();
    expect(typedLiteral("2026-10-04 12:34:56.1234567", "datetime", "mssql", scalar)).toBeUndefined();
    expect(typedLiteral("2026-10-04 12:34", "smalldatetime", "mssql", scalar)).toBeUndefined();
    expect(typedLiteral("x 2026-10-04 12:34:56", "datetime", "mssql", scalar)).toBeUndefined();
    expect(typedLiteral(new Date(0), "datetime", "mssql", scalar)).toBeUndefined();
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

// Databend's cells arrive as display text (design section 4): a Binary is upper-case hex, a Boolean `1` or `0`, a
// Variant JSON text, and every number a string. The forms below are the ones M08b inserted on the pinned image; any
// other declared type is refused until the D14 every-type replay proves its form (X01).
describe("typedLiteral: databend", () => {
  test("writes a declared Binary cell's hex text through unhex, never as six quoted characters", () => {
    expect(typedLiteral("616263", "Binary", "databend", scalar)).toBe("unhex('616263')");
    expect(typedLiteral("00FF10", "Nullable(Binary)", "databend", scalar)).toBe("unhex('00FF10')");
    expect(typedLiteral("", "Binary", "databend", scalar)).toBe("unhex('')");
    // Text that is not whole bytes of hex cannot be the cell a Binary column holds.
    expect(() => typedLiteral("abc", "Binary", "databend", scalar)).toThrow(UnwritableValue);
    expect(() => typedLiteral("x'; DROP", "Binary", "databend", scalar)).toThrow(UnwritableValue);
    // Bytes from a host are left to the generic writer, whose BINARY_LITERAL row spells unhex too.
    expect(typedLiteral(new Uint8Array([1, 2]), "Binary", "databend", scalar)).toBeUndefined();
  });

  test("writes a Variant through parse_json, with Databend's own literal escaping", () => {
    expect(typedLiteral('{"a":1,"b":[1,2,"x"]}', "Variant", "databend", scalar)).toBe(
      `parse_json('{"a":1,"b":[1,2,"x"]}')`,
    );
    expect(typedLiteral('"it\'s"', "Nullable(Variant)", "databend", scalar)).toBe(`parse_json('"it''s"')`);
    expect(typedLiteral({ k: [1, null] }, "Variant", "databend", scalar)).toBe(`parse_json('{"k":[1,null]}')`);
  });

  test("throws for a Bitmap, a Map, a Tuple and every other type no replay has proven", () => {
    expect(() => typedLiteral("<bitmap binary>", "Bitmap", "databend", scalar)).toThrow(UnwritableValue);
    expect(() => typedLiteral('{"k1":1}', "Map(String, Int32)", "databend", scalar)).toThrow(UnwritableValue);
    expect(() => typedLiteral('(1,"a")', "Tuple(Int32, String)", "databend", scalar)).toThrow(UnwritableValue);
    expect(() => typedLiteral("[1,NULL]", "Nullable(Array(Int32 NULL))", "databend", scalar)).toThrow(UnwritableValue);
    expect(() => typedLiteral("1 day 2:03:00", "Interval", "databend", scalar)).toThrow("a value of type Interval");
    expect(() => typedLiteral("x", "Map(String, Int32)", "databend", scalar)).toThrow("a value of type Map");
  });

  // The type is the server's own text and reaches the writer verbatim, and the refusal is written into a `--` comment
  // of the exported file, so the name it carries is printable ASCII and bounded.
  test("names a type it has no literal for in printable text, cut at 64 characters", () => {
    const refusal = (declared: string) => {
      try {
        typedLiteral("x", declared, "databend", scalar);
      } catch (error) {
        if (error instanceof UnwritableValue) return error.message;
      }
      return "not refused";
    };

    expect(refusal("Mystery\nSELECT 2 AS injected;\r\n--\f\u2028\u0085\0end")).toBe(
      "a value of type Mystery?SELECT 2 AS injected;??--????end",
    );
    expect(refusal(`G${"e".repeat(63)}`)).toBe(`a value of type G${"e".repeat(63)}`);
    expect(refusal(`G${"e".repeat(64)}`)).toBe(`a value of type G${"e".repeat(63)}...`);
    expect(refusal("Bitmap")).toBe("a value of type Bitmap");
  });

  test("writes a number bare, the unsafe 64-bit integers and the exponents included", () => {
    expect(typedLiteral("-9223372036854775808", "Int64", "databend", scalar)).toBe("-9223372036854775808");
    expect(typedLiteral("18446744073709551615", "Nullable(UInt64)", "databend", scalar)).toBe("18446744073709551615");
    expect(typedLiteral("12345678.90", "Nullable(Decimal(10, 2))", "databend", scalar)).toBe("12345678.90");
    expect(typedLiteral("1e+308", "Float64", "databend", scalar)).toBe("1e+308");
    expect(typedLiteral(7, "Int32", "databend", scalar)).toBe("7");
    // Text that is not a number goes to the generic writer, which the INSERT then refuses by name.
    expect(typedLiteral("seven", "Int32", "databend", scalar)).toBe("<seven>");
  });

  test("hands a float's non-finite word to the generic writer as the number it is", () => {
    expect(typedLiteral("NaN", "Float32", "databend", scalar)).toBe("<null>");
    expect(typedLiteral("-Infinity", "Nullable(Float64)", "databend", scalar)).toBe("<null>");
    const numbers: unknown[] = [];
    typedLiteral("Infinity", "Float64", "databend", (value) => {
      numbers.push(value);
      return "";
    });
    expect(numbers).toEqual([Infinity]);
  });

  test("writes a Boolean's 1 and 0 as true and false", () => {
    expect(typedLiteral("1", "Boolean", "databend", scalar)).toBe("true");
    expect(typedLiteral("0", "Nullable(Boolean)", "databend", scalar)).toBe("false");
    expect(typedLiteral(true, "Boolean", "databend", scalar)).toBe("true");
    expect(typedLiteral("yes", "Boolean", "databend", scalar)).toBe("<yes>");
  });

  test("leaves the quoted types to the generic writer, and an undeclared cell too", () => {
    for (const declared of ["String", "Nullable(String)", "Date", "Timestamp", "Nullable(Timestamp_Tz)"]) {
      expect(typedLiteral("2026-10-07 12:34:56.789012", declared, "databend", scalar)).toBe(
        "<2026-10-07 12:34:56.789012>",
      );
    }
    expect(typedLiteral("616263", undefined, "databend", scalar)).toBeUndefined();
  });
});
