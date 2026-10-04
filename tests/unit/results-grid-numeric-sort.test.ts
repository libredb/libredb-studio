import { describe, expect, test } from "bun:test";
import {
  compareNumeric,
  compareNumericCells,
  isNumericColumn,
  isNumericType,
  numericCellComparator,
} from "@/components/results-grid/numeric-sort";

const sortAsc = (values: unknown[]) => [...values].sort(compareNumeric);

describe("isNumericType", () => {
  test.each([
    "bigint",
    "BIGINT UNSIGNED",
    "integer",
    "int4",
    "Int64",
    "UInt64",
    "Nullable(Int64)",
    "numeric(12,2)",
    "Decimal(18, 4)",
    "double precision",
    "NUMBER",
    "float8",
    "HUGEINT",
    "UBIGINT",
    "UHUGEINT",
    "UINTEGER",
    "USMALLINT",
    "UTINYINT",
    "varint",
    "counter",
    "Decimal256(10)",
    "unsigned_long",
    "half_float",
    "scaled_float",
    "BINARY_DOUBLE",
    "BINARY_FLOAT",
    "smallmoney",
    "BIGNUMERIC",
    "Float64",
    "DECFLOAT(34)",
    "decfloat16",
    "BIGNUM",
  ])("%s is numeric", (type) => {
    expect(isNumericType(type)).toBe(true);
  });

  test.each([
    "varchar(20)",
    "text",
    "interval",
    "bytea",
    "point",
    "int[]",
    "Array(Int64)",
    "timestamp",
    "uuid",
    "money",
    "LONG RAW",
    "long varchar",
    "row(int, varchar)",
    "STRUCT(a INTEGER)",
    "UNION(n INTEGER)",
    "Variant(Int64, String)",
    "Nested(a Int64)",
    "Enum8('a' = 1)",
    "object",
  ])("%s is not numeric", (type) => {
    expect(isNumericType(type)).toBe(false);
  });
});

describe("isNumericColumn", () => {
  const rows = (values: unknown[]) => values.map((v) => ({ v }));

  test("a declared type decides, whatever the values look like", () => {
    expect(isNumericColumn("varchar(5)", rows(["10", "9"]), "v")).toBe(false);
    expect(isNumericColumn("bigint", rows(["abc"]), "v")).toBe(true);
  });

  test("an undeclared column is numeric when every non-null value is a number or digit string", () => {
    expect(isNumericColumn(undefined, rows(["10", 9, null, undefined, BigInt(1), "-1.5"]), "v")).toBe(true);
  });

  test("an undeclared column with any other value, or only NULLs, is text", () => {
    expect(isNumericColumn(undefined, rows(["10", "x"]), "v")).toBe(false);
    expect(isNumericColumn(undefined, rows([null, null]), "v")).toBe(false);
    expect(isNumericColumn(undefined, [{}], "v")).toBe(false);
  });
});

describe("compareNumeric", () => {
  test("orders digit strings as numbers, not as text", () => {
    expect(sortAsc(["10", "9", "100", "1"])).toEqual(["1", "9", "10", "100"]);
  });

  test("handles negatives", () => {
    expect(sortAsc(["-5", "10", "-100", "0", "9"])).toEqual(["-100", "-5", "0", "9", "10"]);
  });

  test("keeps every digit past 2^53", () => {
    expect(sortAsc(["9007199254740993", "9007199254740992", "10", "-9007199254740993", "-9007199254740992"])).toEqual([
      "-9007199254740993",
      "-9007199254740992",
      "10",
      "9007199254740992",
      "9007199254740993",
    ]);
  });

  test("compares decimals of different scales exactly", () => {
    expect(sortAsc(["10.00", "1.25", "100.00", "1000.00", "1.2", "1.249", "-1.25", "-0.5"])).toEqual([
      "-1.25",
      "-0.5",
      "1.2",
      "1.249",
      "1.25",
      "10.00",
      "100.00",
      "1000.00",
    ]);
  });

  test("ties numerically equal spellings and treats negative zero as zero", () => {
    expect(compareNumeric("1.50", "1.5")).toBe(0);
    expect(compareNumeric("007", "7")).toBe(0);
    expect(compareNumeric("-0.00", "0")).toBe(0);
    expect(compareNumeric("-0", "0.0")).toBe(0);
    expect(compareNumeric("1.", "1")).toBe(0);
  });

  test("mixes numbers, bigints and digit strings", () => {
    expect(sortAsc(["9", 10, BigInt(8), 2.5, "100"])).toEqual([2.5, BigInt(8), "9", 10, "100"]);
  });

  test("reads leading-dot decimals and trims surrounding whitespace", () => {
    expect(sortAsc([" 5 ", ".5", "-.5", "0.25"])).toEqual(["-.5", "0.25", ".5", " 5 "]);
    expect(compareNumeric(".5", "0.50")).toBe(0);
  });

  test("keeps float order for JS numbers in exponent range", () => {
    expect(sortAsc([1000, 1e-7, 5, 2e21, 3e20, 1.5e21, -1e-7])).toEqual([-1e-7, 1e-7, 5, 1000, 3e20, 1.5e21, 2e21]);
  });

  test("reads exponent spellings as exact decimals", () => {
    expect(sortAsc(["1.5e21", "3e20", "1e-7", "5", "-1e-7", "2E+2", "12.5e-1"])).toEqual([
      "-1e-7",
      "1e-7",
      "12.5e-1",
      "5",
      "2E+2",
      "3e20",
      "1.5e21",
    ]);
    expect(compareNumeric("1e1", "10")).toBe(0);
    expect(compareNumeric("1.25e1", "12.5")).toBe(0);
    expect(compareNumeric("1e-2", "0.01")).toBe(0);
    expect(compareNumeric("1e999", "5")).toBeGreaterThan(0);
  });

  test("ranks non-finite values like PostgreSQL: -Infinity, finite, Infinity, NaN", () => {
    const sorted = sortAsc([
      "NaN",
      "Infinity",
      5,
      "-Infinity",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "-5",
      Number.NEGATIVE_INFINITY,
      "+infinity",
    ]);
    expect(sorted.map(String)).toEqual([
      "-Infinity",
      "-Infinity",
      "-5",
      "5",
      "Infinity",
      "Infinity",
      "+infinity",
      "NaN",
      "NaN",
    ]);
    expect(compareNumeric("NaN", Number.NaN)).toBe(0);
  });

  test("a cache gives the same answer", () => {
    const compare = numericCellComparator();
    expect(compare("9", "10", false)).toBeLessThan(0);
    expect(compare("9", "10", false)).toBeLessThan(0);
    expect(compare("10", null, true)).toBeGreaterThan(0);
  });

  test("puts values that are not decimals after every number, in a total order", () => {
    expect(sortAsc(["b", 5, "NaN", "a", "1e21", -2])).toEqual([-2, 5, "1e21", "NaN", "a", "b"]);
    expect(compareNumeric("x", "x")).toBe(0);
  });
});

describe("compareNumericCells", () => {
  test("compares values as numbers", () => {
    expect(compareNumericCells("9", "10", false)).toBeLessThan(0);
  });

  test("keeps NULL after every value in both directions", () => {
    // The table inverts the result for a descending sort, so a NULL that is last in both
    // directions must answer with the opposite sign when descending.
    expect(compareNumericCells(null, "5", false)).toBeGreaterThan(0);
    expect(compareNumericCells("5", undefined, false)).toBeLessThan(0);
    expect(compareNumericCells(null, "5", true)).toBeLessThan(0);
    expect(compareNumericCells("5", null, true)).toBeGreaterThan(0);
    expect(compareNumericCells(null, undefined, false)).toBe(0);
  });
});
