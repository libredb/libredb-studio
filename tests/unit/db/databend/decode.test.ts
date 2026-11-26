import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { decodeOutcome } from "@/lib/db/providers/sql/databend/decode";
import type { DatabendCell, DatabendColumn } from "@/lib/db/providers/sql/databend/transport";

const SQL = "SELECT 1";

function decodeOne(type: string, cell: DatabendCell): unknown {
  return decodeOutcome({ schema: [{ name: "c", type }], rows: [[cell]] }, SQL).rows[0].c;
}

describe("decodeOutcome: the cells of design section 4", () => {
  test("SQL NULL is null whatever the type", () => {
    for (const type of ["Nullable(Int32)", "Nullable(Boolean)", "Nullable(Float64)", "Nullable(String)"]) {
      expect(decodeOne(type, null)).toBeNull();
    }
  });

  test("Boolean 1 and 0 are true and false, any other text stays a string", () => {
    expect(decodeOne("Boolean", "1")).toBe(true);
    expect(decodeOne("Nullable(Boolean)", "0")).toBe(false);
    expect(decodeOne("Boolean", "true")).toBe("true");
  });

  test("Int8 to Int32 and UInt8 to UInt32 are numbers", () => {
    expect(decodeOne("Int8", "-128")).toBe(-128);
    expect(decodeOne("Int16", "-32768")).toBe(-32768);
    expect(decodeOne("Nullable(Int32)", "2147483647")).toBe(2147483647);
    expect(decodeOne("UInt8", "255")).toBe(255);
    expect(decodeOne("UInt16", "65535")).toBe(65535);
    expect(decodeOne("UInt32", "4294967295")).toBe(4294967295);
  });

  test("Int64 and UInt64 are numbers while safe, the exact text from 2^53 up", () => {
    expect(decodeOne("Int64", "9007199254740991")).toBe(9007199254740991);
    expect(decodeOne("Int64", "-9007199254740991")).toBe(-9007199254740991);
    expect(decodeOne("Int64", "9007199254740992")).toBe("9007199254740992");
    expect(decodeOne("Nullable(Int64)", "-9223372036854775808")).toBe("-9223372036854775808");
    expect(decodeOne("UInt64", "42")).toBe(42);
    expect(decodeOne("UInt64", "18446744073709551615")).toBe("18446744073709551615");
  });

  test("an integer cell whose number does not round-trip stays its text", () => {
    expect(decodeOne("Int32", "007")).toBe("007");
    expect(decodeOne("Int64", "abc")).toBe("abc");
  });

  test("Float32 and Float64 are numbers when finite, NaN and the infinities stay strings", () => {
    expect(decodeOne("Float32", "3.14")).toBe(3.14);
    expect(decodeOne("Nullable(Float64)", "1e+308")).toBe(1e308);
    expect(decodeOne("Float64", "NaN")).toBe("NaN");
    expect(decodeOne("Float64", "Infinity")).toBe("Infinity");
    expect(decodeOne("Float32", "-Infinity")).toBe("-Infinity");
  });

  test("every other type is its text verbatim, never refused", () => {
    const texts: [string, string][] = [
      ["Nullable(Decimal(76, 20))", "12345678901234567890123456789012345678901234567890123456.01234567890123456789"],
      ["Date", "2026-10-07"],
      ["Timestamp", "2026-10-07 12:34:56.789012"],
      ["Timestamp_Tz", "2026-10-07 12:34:56.789012 +0300"],
      ["Interval", "1 day 2:03:00"],
      ["String", "quote ' dq \" back\\slash"],
      ["Binary", "00FF10"],
      ["Variant", '{"d":12345678901234567890}'],
      ["Nullable(Map(String, Int32 NULL))", '{"k":NULL}'],
      ["Tuple(Int32 NULL, String NULL)", "(NULL,NULL)"],
      ["Vector(3)", "[1.0,2.5,-3.25]"],
      ["Bitmap", "<bitmap binary>"],
      ["Geometry", '{"type": "Point", "coordinates": [1,2]}'],
    ];
    for (const [type, text] of texts) expect(decodeOne(type, text)).toBe(text);
  });

  test("a nested NULL stays text, not JSON null", () => {
    expect(decodeOne("Nullable(Array(Int32 NULL))", "[NULL,1]")).toBe("[NULL,1]");
  });

  test("one outer Nullable(...) is stripped for the type read and kept verbatim in columnTypes", () => {
    const result = decodeOutcome(
      {
        schema: [
          { name: "a", type: "Nullable(Int32)" },
          { name: "b", type: "Nullable(Nullable(Int32))" },
          { name: "c", type: "Array(Nullable(Int32))" },
        ],
        rows: [["1", "1", "1"]],
      },
      SQL,
    );
    expect(result.rows).toEqual([{ a: 1, b: "1", c: "1" }]);
    expect(result.columnTypes).toEqual({
      a: "Nullable(Int32)",
      b: "Nullable(Nullable(Int32))",
      c: "Array(Nullable(Int32))",
    });
  });
});

describe("decodeOutcome: names and rows", () => {
  test("repeated names are numbered by uniqueFieldNames, never onto a declared name", () => {
    const schema: DatabendColumn[] = ["a", "a", "a (2)"].map((name) => ({ name, type: "Int32" }));
    const result = decodeOutcome({ schema, rows: [["1", "2", "3"]] }, SQL);
    expect(result.fields).toEqual(["a", "a (3)", "a (2)"]);
    expect(result.rows).toEqual([{ a: 1, "a (3)": 2, "a (2)": 3 }]);
    expect(result.columnTypes).toEqual({ a: "Int32", "a (3)": "Int32", "a (2)": "Int32" });
  });

  test("an empty name is (No column name)", () => {
    const result = decodeOutcome({ schema: [{ name: "", type: "String" }], rows: [["x"]] }, SQL);
    expect(result.fields).toEqual(["(No column name)"]);
    expect(result.rows).toEqual([{ "(No column name)": "x" }]);
  });

  test("a __proto__ column is a plain key", () => {
    const result = decodeOutcome({ schema: [{ name: "__proto__", type: "String" }], rows: [["x"]] }, SQL);
    expect(Object.keys(result.rows[0])).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(result.rows[0])).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(result.rows[0], "__proto__")?.value).toBe("x");
  });

  test("a row whose width is not the schema's is refused", () => {
    const schema: DatabendColumn[] = [{ name: "a", type: "Int32" }];
    expect(() => decodeOutcome({ schema, rows: [["1", "2"]] }, SQL)).toThrow(QueryError);
    expect(() => decodeOutcome({ schema, rows: [[]] }, SQL)).toThrow("Row 1 carries 0 values for 1 result columns");
  });

  test("a query's rowCount is its row count, and a statement with no result set has nothing", () => {
    const schema: DatabendColumn[] = [{ name: "n", type: "UInt64" }];
    expect(decodeOutcome({ schema, rows: [["5"], ["6"]] }, SQL).rowCount).toBe(2);
    expect(decodeOutcome({ schema, rows: [] }, SQL)).toEqual({
      fields: ["n"],
      rows: [],
      rowCount: 0,
      columnTypes: { n: "UInt64" },
    });
    expect(decodeOutcome({ schema: [], rows: [] }, SQL)).toEqual({
      fields: [],
      rows: [],
      rowCount: 0,
      columnTypes: {},
    });
  });
});

describe("decodeOutcome: the one-row DML answer", () => {
  test.each(["inserted", "updated", "deleted"])("number of rows %s gives rowCount and keeps its row", (verb) => {
    const name = `number of rows ${verb}`;
    const result = decodeOutcome({ schema: [{ name, type: "UInt64" }], rows: [["4"]] }, SQL);
    expect(result.rowCount).toBe(4);
    expect(result.rows).toEqual([{ [name]: 4 }]);
  });

  test("an UPDATE matching no row counts zero", () => {
    const result = decodeOutcome({ schema: [{ name: "number of rows updated", type: "UInt64" }], rows: [["0"]] }, SQL);
    expect(result.rowCount).toBe(0);
  });

  test("a count from 2^53 up is the nearest number, while its row keeps the exact count as text", () => {
    const decode = (count: string) =>
      decodeOutcome({ schema: [{ name: "number of rows inserted", type: "UInt64" }], rows: [[count]] }, SQL);
    const largest = decode("18446744073709551615");
    expect(largest.rowCount).toBe(2 ** 64);
    expect(largest.rows).toEqual([{ "number of rows inserted": "18446744073709551615" }]);
    // 2^53 + 1 has no double: the nearest is 2^53, one off, which is why the row keeps the text.
    expect(decode("9007199254740993").rowCount).toBe(2 ** 53);
  });

  test("a count cell that is NULL or not a number leaves rowCount the row count", () => {
    for (const count of [null, "abc", "1e3"]) {
      const result = decodeOutcome(
        { schema: [{ name: "number of rows deleted", type: "UInt64" }], rows: [[count]] },
        SQL,
      );
      expect(result.rowCount).toBe(1);
    }
  });

  test("a query that merely aliases a column so is read as a query when its shape differs", () => {
    const two = decodeOutcome(
      { schema: [{ name: "number of rows inserted", type: "UInt64" }], rows: [["7"], ["8"]] },
      SQL,
    );
    expect(two.rowCount).toBe(2);
    const wide = decodeOutcome(
      {
        schema: [
          { name: "number of rows inserted", type: "UInt64" },
          { name: "x", type: "UInt64" },
        ],
        rows: [["7", "1"]],
      },
      SQL,
    );
    expect(wide.rowCount).toBe(1);
    const other = decodeOutcome({ schema: [{ name: "number of rows", type: "UInt64" }], rows: [["7"]] }, SQL);
    expect(other.rowCount).toBe(1);
  });

  test("an alias of that name in a type other than UInt64 is a query; a UInt64 alias cannot be told apart", () => {
    const signed = decodeOutcome({ schema: [{ name: "number of rows deleted", type: "Int32" }], rows: [["-3"]] }, SQL);
    expect(signed.rowCount).toBe(1);
    const narrow = decodeOutcome({ schema: [{ name: "number of rows deleted", type: "UInt8" }], rows: [["0"]] }, SQL);
    expect(narrow.rowCount).toBe(1);
  });
});

describe("a count past 2^53", () => {
  test("a count from 2^53 up is the nearest number, while the row keeps it exact", () => {
    const column = "number of rows updated";
    const decoded = decodeOutcome({ schema: [{ name: column, type: "UInt64" }], rows: [["9007199254740993"]] }, "U");
    expect(decoded.rowCount).toBe(2 ** 53);
    expect(decoded.rows).toEqual([{ [column]: "9007199254740993" }]);
  });
});
