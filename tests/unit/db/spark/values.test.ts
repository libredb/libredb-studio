import { describe, expect, test } from "bun:test";
import { captureBytes, readSparkCapture, type SparkCaptureVersion } from "../../../helpers/spark-captures";
import { columnsStream, patchRecordBatch, type SparkIpcColumn } from "../../../helpers/spark-ipc";
import { type ArrowColumnData, readIpcColumns } from "@/lib/db/providers/sql/spark/arrow";
import { SPARK_ERROR_SENTENCES, SparkError } from "@/lib/db/providers/sql/spark/errors";
import { columnsFromArrow, columnsFromDataType, type SparkColumn } from "@/lib/db/providers/sql/spark/schema";
import { cellValue, SparkCellOverBudget } from "@/lib/db/providers/sql/spark/values";
import { binaryText } from "@/lib/export/binary";

/** Every cell of a hand-built stream, mapped, as rows of [name, value]. */
function mapped(columns: readonly SparkIpcColumn[]): Record<string, unknown>[] {
  const read = readIpcColumns(columnsStream(columns));
  const spark = columnsFromArrow(read);
  return Array.from({ length: read.rowCount }, (_, row) =>
    Object.fromEntries(spark.map((column, index) => [column.name, cellValue(column, read.columns[index], row)])),
  );
}
const noBigint = (value: unknown): boolean =>
  typeof value !== "bigint" && (typeof value !== "object" || value === null || Object.values(value).every(noBigint));

/** The one column of a hand-built stream of one column. */
function onlyColumn(column: SparkIpcColumn): ArrowColumnData {
  return readIpcColumns(columnsStream([column])).columns[0];
}

/** The SparkError `run` throws; anything else thrown, or nothing, fails the test. */
function refusal(run: () => unknown): SparkError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SparkError);
    return error as SparkError;
  }
  throw new Error("expected a SparkError, and nothing was thrown");
}

/**
 * A VARIANT column of `count` values, each the JSON string "a" (a short string of one byte over an empty dictionary),
 * as Spark lays it out: Struct{value Binary, metadata Binary tagged variant=true}.
 */
const variantColumn = (name: string, count = 1): SparkIpcColumn => ({
  name,
  kind: "struct",
  length: count,
  children: [
    { name: "value", kind: "binary", values: Array.from({ length: count }, () => Uint8Array.of(0x05, 0x61)) },
    {
      name: "metadata",
      kind: "binary",
      values: Array.from({ length: count }, () => Uint8Array.of(0x01, 0x00, 0x00)),
      metadata: { variant: "true" },
    },
  ],
});

describe("cellValue: every scalar type", () => {
  test("booleans, integers, the int64 safe range and its edges, floats and doubles", () => {
    const rows = mapped([
      { name: "b", kind: "bool", values: [true, false, null] },
      { name: "i", kind: "int32", values: [-1, 0, 2147483647] },
      { name: "s", kind: "int16", values: [-32768, 1, null] },
      { name: "t", kind: "int8", values: [-128, 127, 0] },
      {
        name: "l",
        kind: "int64",
        values: [BigInt(9007199254740991), BigInt(-9007199254740991), BigInt("9007199254740992")],
      },
      { name: "f", kind: "float32", values: [0.1, Number.NaN, Number.NEGATIVE_INFINITY] },
      { name: "d", kind: "float64", values: [0.1, Number.POSITIVE_INFINITY, -0.5] },
    ]);
    expect(rows[0]).toStrictEqual({ b: true, i: -1, s: -32768, t: -128, l: 9007199254740991, f: 0.1, d: 0.1 });
    expect(rows[1].l).toBe(-9007199254740991);
    expect(rows[2].l).toBe("9007199254740992");
    expect(rows[1].f).toBeNaN();
    expect(rows[2].f).toBe(Number.NEGATIVE_INFINITY);
    expect(rows[1].d).toBe(Number.POSITIVE_INFINITY);
    expect(rows[2].b).toBeNull();
    expect(rows[2].s).toBeNull();
  });

  test("the int64 extremes and the first unsafe values on both sides are their digits", () => {
    const rows = mapped([
      {
        name: "l",
        kind: "int64",
        values: [BigInt("-9007199254740992"), BigInt("9223372036854775807"), BigInt("-9223372036854775808"), BigInt(0)],
      },
    ]);
    expect(rows.map((row) => row.l)).toStrictEqual([
      "-9007199254740992",
      "9223372036854775807",
      "-9223372036854775808",
      0,
    ]);
  });

  test("decimals as exact text, signs and a negative scale included", () => {
    const rows = mapped([
      { name: "a", kind: "decimal", precision: 10, scale: 2, values: [BigInt(1234567891), BigInt(-50), BigInt(0)] },
      {
        name: "b",
        kind: "decimal",
        precision: 38,
        scale: 18,
        values: [BigInt("-10000000000000000000000000000000000001"), BigInt(1), BigInt("1000000000000000000")],
      },
      { name: "c", kind: "decimal", precision: 1, scale: -10, values: [BigInt(1), BigInt(-3), BigInt(0)] },
    ]);
    expect(rows.map((row) => row.a)).toStrictEqual(["12345678.91", "-0.50", "0.00"]);
    expect(rows[0].b).toBe("-10000000000000000000.000000000000000001");
    expect(rows[1].b).toBe("0.000000000000000001");
    expect(rows[2].b).toBe("1.000000000000000000");
    expect(rows.map((row) => row.c)).toStrictEqual(["10000000000", "-30000000000", "0"]);
  });

  test("a decimal of the widest digits at scale 0 and at scale 38 keeps every digit", () => {
    const widest = BigInt("99999999999999999999999999999999999999");
    const rows = mapped([
      { name: "z", kind: "decimal", precision: 38, scale: 0, values: [widest, -widest] },
      { name: "f", kind: "decimal", precision: 38, scale: 38, values: [widest, BigInt(-1)] },
    ]);
    expect(rows.map((row) => row.z)).toStrictEqual([
      "99999999999999999999999999999999999999",
      "-99999999999999999999999999999999999999",
    ]);
    expect(rows.map((row) => row.f)).toStrictEqual([
      "0.99999999999999999999999999999999999999",
      "-0.00000000000000000000000000000000000001",
    ]);
  });

  test("strings, binary as Buffer at the top level, and the temporal and interval texts", () => {
    const rows = mapped([
      { name: "s", kind: "utf8", values: ["héllo", ""] },
      { name: "bin", kind: "binary", values: [new Uint8Array([0xde, 0xad]), new Uint8Array(0)] },
      { name: "day", kind: "date32", values: [-719162, 19782] },
      { name: "ts", kind: "timestamp-utc", values: [BigInt(1_709_164_800_123_450), BigInt(0)] },
      { name: "ntz", kind: "timestamp-ntz", values: [BigInt(0), BigInt(1)] },
      { name: "tm", kind: "time64-ns", values: [BigInt(45_296_123_456_000), BigInt(0)] },
      { name: "ym", kind: "interval-ym", values: [43, -43] },
      { name: "dt", kind: "duration-us", values: [BigInt(93_784_567_891), BigInt(-93_784_567_891)] },
      {
        name: "cal",
        kind: "interval-mdn",
        values: [
          { months: 3, days: 2, nanos: BigInt(1000) },
          { months: 0, days: 0, nanos: BigInt(0) },
        ],
      },
    ]);
    expect(rows[0].s).toBe("héllo");
    expect(rows[1].s).toBe("");
    expect(Buffer.isBuffer(rows[0].bin)).toBe(true);
    expect(Array.from(rows[0].bin as Buffer)).toStrictEqual([0xde, 0xad]);
    expect(Buffer.isBuffer(rows[1].bin)).toBe(true);
    expect((rows[1].bin as Buffer).length).toBe(0);
    expect(rows[0].day).toBe("0001-01-01");
    expect(rows[1].day).toBe("2024-02-29");
    expect(rows[0].ts).toBe("2024-02-29 00:00:00.12345+00:00");
    expect(rows[1].ts).toBe("1970-01-01 00:00:00+00:00");
    expect(rows[1].ntz).toBe("1970-01-01 00:00:00.000001");
    expect(rows[0].tm).toBe("12:34:56.123456");
    expect(rows[1].tm).toBe("00:00:00");
    expect(rows[0].ym).toBe("INTERVAL '3-7' YEAR TO MONTH");
    expect(rows[1].ym).toBe("INTERVAL '-3-7' YEAR TO MONTH");
    expect(rows[0].dt).toBe("INTERVAL '1 02:03:04.567891' DAY TO SECOND");
    expect(rows[1].dt).toBe("INTERVAL '-1 02:03:04.567891' DAY TO SECOND");
    expect(rows[0].cal).toBe("3 months 2 days 1 microseconds");
    expect(rows[1].cal).toBe("0 months 0 days 0 microseconds");
  });

  test("a top-level binary is a copy, so the row does not hold the batch's buffer", () => {
    const data = onlyColumn({ name: "bin", kind: "binary", values: [Uint8Array.of(7, 8, 9)] });
    const column = columnsFromArrow({ rowCount: 1, columns: [data] })[0];
    const value = cellValue(column, data, 0) as Buffer;
    expect(Array.from(value)).toStrictEqual([7, 8, 9]);
    expect(value.buffer).not.toBe(data.values?.buffer);
  });

  test("a string keeps a leading U+FEFF at the top level and nested, as Spark stores it", () => {
    const rows = mapped([
      { name: "s", kind: "utf8", values: ["\uFEFFx"] },
      { name: "a", kind: "list", offsets: [0, 1], child: { name: "element", kind: "utf8", values: ["\uFEFFy"] } },
    ]);
    expect(rows[0]).toStrictEqual({ s: "\uFEFFx", a: ["\uFEFFy"] });
  });

  test("a null-typed column and every null cell are null", () => {
    const rows = mapped([
      { name: "n", kind: "null", length: 1 },
      { name: "s", kind: "utf8", values: [null] },
    ]);
    expect(rows[0]).toStrictEqual({ n: null, s: null });
  });
});

describe("cellValue: the nested rule", () => {
  test("arrays, maps keyed by scalar text, maps of nested keys as pairs, structs; every inner value JSON-safe", () => {
    const rows = mapped([
      {
        name: "a",
        kind: "list",
        offsets: [0, 3],
        child: { name: "element", kind: "int64", values: [BigInt(1), BigInt("9007199254740993"), null] },
      },
      {
        name: "m",
        kind: "map",
        offsets: [0, 2],
        keys: { name: "key", kind: "int32", values: [1, 2] },
        items: { name: "value", kind: "binary", values: [new Uint8Array([1]), null] },
      },
      {
        name: "mk",
        kind: "map",
        offsets: [0, 1],
        keys: { name: "key", kind: "list", offsets: [0, 1], child: { name: "element", kind: "utf8", values: ["k"] } },
        items: { name: "value", kind: "decimal", precision: 3, scale: 1, values: [BigInt(15)] },
      },
      {
        name: "st",
        kind: "struct",
        length: 1,
        children: [
          { name: "x", kind: "date32", values: [0] },
          { name: "x", kind: "timestamp-utc", values: [BigInt(0)] },
        ],
      },
    ]);
    expect(rows[0].a).toStrictEqual([1, "9007199254740993", null]);
    expect(rows[0].m).toStrictEqual({ "1": "\\x01", "2": null });
    expect(rows[0].mk).toStrictEqual([[["k"], "1.5"]]);
    // A repeated struct field name is numbered as uniqueFieldNames numbers a repeated column.
    expect(rows[0].st).toStrictEqual({ x: "1970-01-01", "x (2)": "1970-01-01 00:00:00+00:00" });
    expect(noBigint(rows[0])).toBe(true);
    expect(() => JSON.stringify(rows)).not.toThrow();
  });

  test("every nested scalar kind is its JSON-safe text or number, and a null list, map or struct is null", () => {
    const rows = mapped([
      {
        name: "a",
        kind: "list",
        offsets: [0, 2, 2],
        valid: [true, false],
        child: { name: "element", kind: "timestamp-ntz", values: [BigInt(1), null] },
      },
      {
        name: "m",
        kind: "map",
        offsets: [0, 2, 2],
        valid: [true, false],
        keys: { name: "key", kind: "bool", values: [true, false] },
        items: { name: "value", kind: "float32", values: [Number.NaN, null] },
      },
      {
        name: "st",
        kind: "struct",
        length: 2,
        valid: [true, false],
        children: [
          { name: "i", kind: "interval-ym", values: [-1, 0] },
          { name: "d", kind: "duration-us", values: [BigInt(-1), BigInt(0)] },
          { name: "c", kind: "interval-mdn", values: [{ months: -1, days: -2, nanos: BigInt(-3000) }, null] },
          { name: "t", kind: "time64-ns", values: [BigInt(1), BigInt(0)] },
          { name: "n", kind: "null", length: 2 },
          { name: "b", kind: "int8", values: [5, 0] },
        ],
      },
    ]);
    expect(rows[0].a).toStrictEqual(["1970-01-01 00:00:00.000001", null]);
    expect(rows[0].m).toStrictEqual({ true: Number.NaN, false: null });
    expect(rows[0].st).toStrictEqual({
      i: "INTERVAL '-0-1' YEAR TO MONTH",
      d: "INTERVAL '-0 00:00:00.000001' DAY TO SECOND",
      c: "-1 months -2 days -3 microseconds",
      t: "00:00:00.000000001",
      n: null,
      b: 5,
    });
    expect(rows[1]).toStrictEqual({ a: null, m: null, st: null });
  });

  test("a struct field with an empty name is keyed as uniqueFieldNames keys an unnamed column", () => {
    // apache-arrow's writer leaves an empty field name out of the schema, so the child is named "" after reading.
    const read = readIpcColumns(
      columnsStream([{ name: "st", kind: "struct", length: 1, children: [{ name: "x", kind: "int8", values: [5] }] }]),
    );
    const data = { ...read.columns[0], children: [{ ...read.columns[0].children[0], name: "" }] };
    const column = {
      name: "st",
      spelling: "struct<``:tinyint>",
      kind: { type: "struct", fields: [{ name: "", kind: { type: "tinyint" } }] } as const,
    };
    expect(cellValue(column, data, 0)).toStrictEqual({ "(No column name)": 5 });
  });

  test("a nested binary is the \\x<hex> text binaryText writes, for every byte value and for no bytes", () => {
    const every = Uint8Array.from({ length: 256 }, (_, index) => index);
    const rows = mapped([
      {
        name: "a",
        kind: "list",
        offsets: [0, 2],
        child: { name: "element", kind: "binary", values: [every, new Uint8Array(0)] },
      },
    ]);
    expect(rows[0].a).toStrictEqual([binaryText(every), "\\x"]);
  });

  test("a struct field and a map key named __proto__ are own properties and the prototype is unchanged", () => {
    const rows = mapped([
      { name: "st", kind: "struct", length: 1, children: [{ name: "__proto__", kind: "int32", values: [1] }] },
      {
        name: "m",
        kind: "map",
        offsets: [0, 1],
        keys: { name: "key", kind: "utf8", values: ["__proto__"] },
        items: { name: "value", kind: "int32", values: [2] },
      },
    ]);
    for (const [name, expected] of [
      ["st", 1],
      ["m", 2],
    ] as const) {
      const value = rows[0][name] as Record<string, unknown>;
      expect(Object.hasOwn(value, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toBe(expected);
    }
  });

  test("VARIANT as its JSON text and geospatial values as EWKT, at the top level and nested", () => {
    const point = Uint8Array.from([1, 1, 0, 0, 0, ...new Uint8Array(Float64Array.of(1, 2).buffer)]);
    const rows = mapped([
      variantColumn("v"),
      {
        name: "g",
        kind: "struct",
        length: 1,
        children: [
          { name: "srid", kind: "int32", values: [4326] },
          { name: "wkb", kind: "binary", values: [point], metadata: { geometry: "true", srid: "4326" } },
        ],
      },
      {
        name: "gg",
        kind: "struct",
        length: 1,
        children: [
          { name: "srid", kind: "int32", values: [0] },
          { name: "wkb", kind: "binary", values: [Uint8Array.of(9)], metadata: { geography: "true", srid: "0" } },
        ],
      },
      { name: "nv", kind: "list", offsets: [0, 1], child: variantColumn("element") },
    ]);
    expect(rows[0].v).toBe('"a"');
    expect(rows[0].g).toBe("SRID=4326;POINT (1 2)");
    expect(rows[0].gg).toBe("SRID=0;WKB(09)");
    expect(rows[0].nv).toStrictEqual(['"a"']);
  });

  test("a geometry value writes the srid it carries, which a GEOMETRY(ANY) column's type does not name", () => {
    const point = Uint8Array.from([1, 1, 0, 0, 0, ...new Uint8Array(Float64Array.of(1, 2).buffer)]);
    const read = readIpcColumns(
      columnsStream([
        {
          name: "g",
          kind: "struct",
          length: 1,
          children: [
            { name: "srid", kind: "int32", values: [4326] },
            { name: "wkb", kind: "binary", values: [point], metadata: { geometry: "true", srid: "-1" } },
          ],
        },
      ]),
    );
    const [column] = columnsFromArrow(read);
    expect(column.kind).toStrictEqual({ type: "geometry", srid: -1 });
    expect(cellValue(column, read.columns[0], 0)).toBe("SRID=4326;POINT (1 2)");
  });

  test("a map keyed by a struct is its [key, value] pairs, each key its object", () => {
    // map(named_struct('a', 1), 'x'): a struct key has no scalar text to key an object by.
    const rows = mapped([
      {
        name: "m",
        kind: "map",
        offsets: [0, 1],
        keys: { name: "key", kind: "struct", length: 1, children: [{ name: "a", kind: "int32", values: [1] }] },
        items: { name: "value", kind: "utf8", values: ["x"] },
      },
    ]);
    expect(rows[0].m).toStrictEqual([[{ a: 1 }, "x"]]);
  });

  test("a map whose key texts are not all distinct is its [key, value] pairs, so no entry is lost", () => {
    // Spark reads a map as a source stored it, and a source that does not enforce distinct keys (Parquet) can hold one
    // key twice; two keys can also share a text, as 0.0 and -0.0 share "0". Each map is decided on its own keys.
    const rows = mapped([
      {
        name: "s",
        kind: "map",
        offsets: [0, 2, 4],
        keys: { name: "key", kind: "utf8", values: ["a", "a", "a", "b"] },
        items: { name: "value", kind: "int32", values: [1, 2, 1, 2] },
      },
      {
        name: "f",
        kind: "map",
        offsets: [0, 2, 4],
        keys: { name: "key", kind: "float64", values: [0, -0, 0, 1] },
        items: { name: "value", kind: "int32", values: [1, 2, 1, 2] },
      },
    ]);
    expect(rows).toStrictEqual([
      {
        s: [
          ["a", 1],
          ["a", 2],
        ],
        f: [
          [0, 1],
          [-0, 2],
        ],
      },
      { s: { a: 1, b: 2 }, f: { "0": 1, "1": 2 } },
    ]);
    expect(Object.is((rows[0].f as unknown[][])[1][0], -0)).toBe(true);
  });
});

describe("cellValue: refusals and the VARIANT budget", () => {
  test("a string Spark sent as invalid UTF-8 is refused naming its column", () => {
    // The bytes of "abcd" in the batch's Utf8 data buffer (buffer 2, after validity and offsets) overwritten with 0xFF,
    // a byte no UTF-8 text holds; the stream check and the Arrow reader read text bytes as they are.
    const stream = patchRecordBatch(columnsStream([{ name: "comment", kind: "utf8", values: ["abcd", "ok"] }]), {
      kind: "int32",
      buffer: 2,
      at: 0,
      value: -1,
    });
    const read = readIpcColumns(stream);
    const [column] = columnsFromArrow(read);
    const error = refusal(() => cellValue(column, read.columns[0], 0));
    expect(error.category).toBe("unreadable");
    expect(error.message).toBe(SPARK_ERROR_SENTENCES.cellUnreadable("string", "comment"));
    // One decoder serves every cell: the next string after a refusal still reads.
    expect(cellValue(column, read.columns[0], 1)).toBe("ok");
  });

  test("a VARIANT that does not follow the encoding is refused naming its column", () => {
    const read = readIpcColumns(
      columnsStream([
        {
          name: "v",
          kind: "struct",
          length: 1,
          children: [
            { name: "value", kind: "binary", values: [Uint8Array.of(0x50)] },
            {
              name: "metadata",
              kind: "binary",
              values: [Uint8Array.of(0x01, 0x00, 0x00)],
              metadata: { variant: "true" },
            },
          ],
        },
      ]),
    );
    const [column] = columnsFromArrow(read);
    const error = refusal(() => cellValue(column, read.columns[0], 0));
    expect(error.category).toBe("unreadable");
    expect(error.message).toBe(SPARK_ERROR_SENTENCES.cellUnreadable("variant", "v"));
  });

  test("a TIME outside one day and an interval whose field range temporal.ts refuses are refused naming their column", () => {
    const time = readIpcColumns(
      columnsStream([{ name: "tm", kind: "time64-ns", values: [BigInt(86_400_000_000_000)] }]),
    );
    const [timeColumn] = columnsFromArrow(time);
    const error = refusal(() => cellValue(timeColumn, time.columns[0], 0));
    expect(error.category).toBe("unreadable");
    expect(error.message).toBe(SPARK_ERROR_SENTENCES.cellUnreadable("time", "tm"));
    // A reversed range never leaves columnsFromDataType (it is refused at schema time), so the column is built by hand.
    const span = readIpcColumns(columnsStream([{ name: "d", kind: "duration-us", values: [BigInt(1)] }]));
    const reversed = {
      name: "span",
      spelling: "interval second to day",
      kind: { type: "day-time-interval", fields: { start: "SECOND", end: "DAY" } } as const,
    };
    expect(refusal(() => cellValue(reversed, span.columns[0], 0)).message).toBe(
      SPARK_ERROR_SENTENCES.cellUnreadable("day-time interval", "span"),
    );
    const ym = readIpcColumns(columnsStream([{ name: "y", kind: "interval-ym", values: [1] }]));
    const misnamed = {
      name: "age",
      spelling: "interval month to year",
      kind: { type: "year-month-interval", fields: { start: "MONTH", end: "YEAR" } } as const,
    };
    expect(refusal(() => cellValue(misnamed, ym.columns[0], 0)).message).toBe(
      SPARK_ERROR_SENTENCES.cellUnreadable("year-month interval", "age"),
    );
  });

  test("a nested cell refusal names the top-level column that holds it", () => {
    const read = readIpcColumns(
      columnsStream([
        {
          name: "times",
          kind: "list",
          offsets: [0, 1],
          child: { name: "element", kind: "time64-ns", values: [BigInt(-1)] },
        },
      ]),
    );
    const [column] = columnsFromArrow(read);
    expect(refusal(() => cellValue(column, read.columns[0], 0)).message).toBe(
      SPARK_ERROR_SENTENCES.cellUnreadable("time", "times"),
    );
  });

  test("a VARIANT text past the characters left throws SparkCellOverBudget, and one within them is whole and charged", () => {
    const read = readIpcColumns(columnsStream([variantColumn("v")]));
    const [column] = columnsFromArrow(read);
    const text = { charsLeft: 3 };
    expect(cellValue(column, read.columns[0], 0, text)).toBe('"a"');
    expect(text.charsLeft).toBe(0);
    // A budget spent to exactly 0 cuts the next VARIANT before its row; it is never read as an unreadable value.
    expect(() => cellValue(column, read.columns[0], 0, text)).toThrow(SparkCellOverBudget);
    expect(() => cellValue(column, read.columns[0], 0, { charsLeft: 2 })).toThrow(SparkCellOverBudget);
    // Absent, the budget is a whole statement's, finite.
    expect(cellValue(column, read.columns[0], 0)).toBe('"a"');
  });

  test("every VARIANT of a row is charged in turn, and the one that would pass the rest throws", () => {
    const read = readIpcColumns(
      columnsStream([{ name: "vs", kind: "list", offsets: [0, 2], child: variantColumn("element", 2) }]),
    );
    const [column] = columnsFromArrow(read);
    const whole = { charsLeft: 7 };
    expect(cellValue(column, read.columns[0], 0, whole)).toStrictEqual(['"a"', '"a"']);
    expect(whole.charsLeft).toBe(1);
    const short = { charsLeft: 5 };
    const thrown = (() => {
      try {
        cellValue(column, read.columns[0], 0, short);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(thrown).toBeInstanceOf(SparkCellOverBudget);
    expect((thrown as Error).name).toBe("SparkCellOverBudget");
    expect((thrown as Error).message).toBe("A VARIANT text passes the statement's decoded budget.");
    // The first text was written and charged before the second would pass what was left.
    expect(short.charsLeft).toBe(2);
  });

  test("a budget that is not a count of characters is the caller's defect, never an unreadable cell", () => {
    const read = readIpcColumns(columnsStream([variantColumn("v")]));
    const [column] = columnsFromArrow(read);
    for (const charsLeft of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      let caught: unknown;
      try {
        cellValue(column, read.columns[0], 0, { charsLeft });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TypeError);
      expect(caught).not.toBeInstanceOf(SparkError);
    }
  });

  test("a row outside the column is refused before any byte is read", () => {
    const data = onlyColumn({ name: "i", kind: "int32", values: [1] });
    const column = { name: "i", spelling: "int", kind: { type: "int" } as const };
    for (const row of [-1, 1, 0.5, Number.NaN]) {
      expect(() => cellValue(column, data, row)).toThrow(
        new RangeError(`row ${row} is not one of the column's 1 rows`),
      );
    }
  });
});

describe("cellValue: a column whose Arrow data is not laid out as its kind", () => {
  // The relation path reads each column's kind from the DataType Spark sends first and its cells from the Arrow batch;
  // assertSchemasAgree holds the two to the same column count, names and kinds, and this check also holds the children
  // of a VARIANT or geospatial struct and a caller that compares no schemas, so a column laid out otherwise is refused
  // before a byte is read under the wrong type, in the cell refusal's form, naming the kind it was to be read as.
  const int32 = onlyColumn({ name: "n", kind: "int32", values: [1, 2] });

  test("a kind read from another Arrow type is refused naming the column, whatever its width", () => {
    for (const [kind, label] of [
      [{ type: "bigint" }, "bigint"],
      [{ type: "string" }, "string"],
      [{ type: "binary" }, "binary"],
      [{ type: "void" }, "void"],
      [{ type: "array", element: { type: "int" } }, "array"],
      [{ type: "struct", fields: [] }, "struct"],
      // An interval is named as the interval refusals name it.
      [{ type: "day-time-interval", fields: { start: "DAY", end: "SECOND" } }, "day-time interval"],
      [{ type: "calendar-interval" }, "calendar interval"],
    ] as const satisfies readonly (readonly [SparkColumn["kind"], string])[]) {
      const error = refusal(() => cellValue({ name: "n", spelling: "x", kind }, int32, 0));
      expect(error.category).toBe("unreadable");
      expect(error.message).toBe(SPARK_ERROR_SENTENCES.cellUnreadable(label, "n"));
    }
    // The same column read as its own kind.
    expect(cellValue({ name: "n", spelling: "int", kind: { type: "int" } }, int32, 1)).toBe(2);
  });

  test("a nested kind read from another Arrow type is refused naming the top-level column", () => {
    const list = onlyColumn({
      name: "a",
      kind: "list",
      offsets: [0, 1],
      child: { name: "element", kind: "int32", values: [1] },
    });
    const column = {
      name: "a",
      spelling: "array<string>",
      kind: { type: "array", element: { type: "string" } } as const,
    };
    expect(refusal(() => cellValue(column, list, 0)).message).toBe(SPARK_ERROR_SENTENCES.cellUnreadable("string", "a"));
    const same = { name: "a", spelling: "array<int>", kind: { type: "array", element: { type: "int" } } as const };
    expect(cellValue(same, list, 0)).toStrictEqual([1]);
  });

  test("a null cell of a disagreeing column is refused too", () => {
    const nulls = onlyColumn({ name: "s", kind: "utf8", values: [null] });
    const column = { name: "s", spelling: "bigint", kind: { type: "bigint" } as const };
    expect(refusal(() => cellValue(column, nulls, 0)).message).toBe(
      SPARK_ERROR_SENTENCES.cellUnreadable("bigint", "s"),
    );
  });

  test("a decimal whose scale differs from the batch's is refused, since the scale places the point", () => {
    const decimal = onlyColumn({ name: "d", kind: "decimal", precision: 10, scale: 2, values: [BigInt(1234)] });
    const other = { name: "d", spelling: "decimal(10,3)", kind: { type: "decimal", precision: 10, scale: 3 } as const };
    expect(refusal(() => cellValue(other, decimal, 0)).message).toBe(
      SPARK_ERROR_SENTENCES.cellUnreadable("decimal", "d"),
    );
    // The precision does not place the point, so a batch of another precision reads by its scale.
    const wider = { name: "d", spelling: "decimal(12,2)", kind: { type: "decimal", precision: 12, scale: 2 } as const };
    expect(cellValue(wider, decimal, 0)).toBe("12.34");
  });

  test("a struct whose fields differ in count or in names from the batch's is refused", () => {
    const struct = onlyColumn({
      name: "st",
      kind: "struct",
      length: 1,
      children: [
        { name: "x", kind: "int32", values: [1] },
        { name: "y", kind: "int32", values: [2] },
      ],
    });
    const int = { type: "int" } as const;
    const fewer = {
      name: "st",
      spelling: "struct<x:int>",
      kind: { type: "struct", fields: [{ name: "x", kind: int }] } as const,
    };
    const more = {
      name: "st",
      spelling: "struct<x:int,y:int,z:int>",
      kind: {
        type: "struct",
        fields: [
          { name: "x", kind: int },
          { name: "y", kind: int },
          { name: "z", kind: int },
        ],
      } as const,
    };
    const swapped = {
      name: "st",
      spelling: "struct<y:int,x:int>",
      kind: {
        type: "struct",
        fields: [
          { name: "y", kind: int },
          { name: "x", kind: int },
        ],
      } as const,
    };
    for (const column of [fewer, more, swapped]) {
      expect(refusal(() => cellValue(column, struct, 0)).message).toBe(
        SPARK_ERROR_SENTENCES.cellUnreadable("struct", "st"),
      );
    }
    const same = {
      name: "st",
      spelling: "struct<x:int,y:int>",
      kind: {
        type: "struct",
        fields: [
          { name: "x", kind: int },
          { name: "y", kind: int },
        ],
      } as const,
    };
    expect(cellValue(same, struct, 0)).toStrictEqual({ x: 1, y: 2 });
  });

  // SELECT struct(a.id, b.id) AS st: the DataType keeps the names the plan gives (id, id), while Spark writes the Arrow
  // schema of both result paths with errorOnDuplicatedFieldNames = false, so ArrowUtils.deduplicateFieldNames numbers a
  // name the struct repeats (id_0, id_1, in order) and keeps a name it holds once (4.1.3 and 4.2.0 alike).
  const proto = (kind: string, body: object = {}) => ({ kind, [kind]: body });
  const protoStruct = (fields: readonly (readonly [string, object])[]) =>
    proto("struct", { fields: fields.map(([name, data_type]) => ({ name, data_type, nullable: true })) });

  test("a struct that repeats a field name reads on the relation path, under the names Spark's Arrow writer numbers", () => {
    const pair = protoStruct([
      ["id", proto("integer")],
      ["id", proto("integer")],
    ]);
    const [st, sts] = columnsFromDataType(
      protoStruct([
        ["st", pair],
        ["sts", proto("array", { element_type: pair, contains_null: true })],
      ]),
    );
    const read = readIpcColumns(
      columnsStream([
        {
          name: "st",
          kind: "struct",
          length: 1,
          children: [
            { name: "id_0", kind: "int32", values: [1] },
            { name: "id_1", kind: "int32", values: [2] },
          ],
        },
        {
          name: "sts",
          kind: "list",
          offsets: [0, 2],
          child: {
            name: "element",
            kind: "struct",
            length: 2,
            children: [
              { name: "id_0", kind: "int32", values: [3, 5] },
              { name: "id_1", kind: "int32", values: [4, 6] },
            ],
          },
        },
      ]),
    );
    expect(cellValue(st, read.columns[0], 0)).toStrictEqual({ id: 1, "id (2)": 2 });
    expect(cellValue(sts, read.columns[1], 0)).toStrictEqual([
      { id: 3, "id (2)": 4 },
      { id: 5, "id (2)": 6 },
    ]);
  });

  test("a numbered name the struct also declares keeps its own name, and repeats numbered otherwise are refused", () => {
    const declared = (...names: string[]): SparkColumn => ({
      name: "st",
      spelling: `struct<${names.map((name) => `${name}:int`).join(",")}>`,
      kind: { type: "struct", fields: names.map((name) => ({ name, kind: { type: "int" } as const })) },
    });
    const batch = (...names: string[]) =>
      readIpcColumns(
        columnsStream([
          {
            name: "st",
            kind: "struct",
            length: 1,
            children: names.map((name, index) => ({ name, kind: "int32" as const, values: [index + 1] })),
          },
        ]),
      );
    // Spark writes struct<id,x,id,id_0> as [id_0, x, id_1, id_0]: x and id_0 occur once, so each keeps its name.
    const written = batch("id_0", "x", "id_1", "id_0");
    expect(cellValue(declared("id", "x", "id", "id_0"), written.columns[0], 0)).toStrictEqual({
      id: 1,
      x: 2,
      "id (2)": 3,
      id_0: 4,
    });
    // The command path's kind takes the names Spark wrote, which repeat id_0, so the same batch reads under them.
    const [fromArrow] = columnsFromArrow(written);
    expect(cellValue(fromArrow, written.columns[0], 0)).toStrictEqual({ id_0: 1, x: 2, id_1: 3, "id_0 (2)": 4 });
    for (const names of [
      ["id_1", "id_0"],
      ["id_1", "id_2"],
      ["id", "id_1"],
      ["id_0", "id_0"],
    ]) {
      expect(refusal(() => cellValue(declared("id", "id"), batch(...names).columns[0], 0)).message).toBe(
        SPARK_ERROR_SENTENCES.cellUnreadable("struct", "st"),
      );
    }
  });

  test("a VARIANT or geospatial struct whose two children are not Spark's layout is refused", () => {
    // columnsFromArrow names the kind by the children's names and the tag; the children's types are held here.
    const variantOfText = readIpcColumns(
      columnsStream([
        {
          name: "v",
          kind: "struct",
          length: 1,
          children: [
            { name: "value", kind: "utf8", values: ["a"] },
            {
              name: "metadata",
              kind: "binary",
              values: [Uint8Array.of(0x01, 0x00, 0x00)],
              metadata: { variant: "true" },
            },
          ],
        },
      ]),
    );
    const [variant] = columnsFromArrow(variantOfText);
    expect(variant.kind).toStrictEqual({ type: "variant" });
    expect(refusal(() => cellValue(variant, variantOfText.columns[0], 0)).message).toBe(
      SPARK_ERROR_SENTENCES.cellUnreadable("variant", "v"),
    );
    const wideSrid = readIpcColumns(
      columnsStream([
        {
          name: "g",
          kind: "struct",
          length: 1,
          children: [
            { name: "srid", kind: "int64", values: [BigInt(4326)] },
            { name: "wkb", kind: "binary", values: [Uint8Array.of(1)], metadata: { geography: "true", srid: "4326" } },
          ],
        },
      ]),
    );
    const [geography] = columnsFromArrow(wideSrid);
    expect(geography.kind).toStrictEqual({ type: "geography", srid: 4326 });
    expect(refusal(() => cellValue(geography, wideSrid.columns[0], 0)).message).toBe(
      SPARK_ERROR_SENTENCES.cellUnreadable("geography", "g"),
    );
    // A DataType that names a VARIANT or a geometry over a struct of other children is refused alike.
    const pair = onlyColumn({
      name: "p",
      kind: "struct",
      length: 1,
      children: [
        { name: "metadata", kind: "binary", values: [Uint8Array.of(1)] },
        { name: "value", kind: "binary", values: [Uint8Array.of(2)] },
      ],
    });
    for (const kind of [{ type: "variant" }, { type: "geometry", srid: 0 }] as const) {
      expect(refusal(() => cellValue({ name: "p", spelling: kind.type, kind }, pair, 0)).message).toBe(
        SPARK_ERROR_SENTENCES.cellUnreadable(kind.type, "p"),
      );
    }
    const single = onlyColumn({
      name: "p",
      kind: "struct",
      length: 1,
      children: [{ name: "value", kind: "binary", values: [Uint8Array.of(1)] }],
    });
    expect(
      refusal(() => cellValue({ name: "p", spelling: "variant", kind: { type: "variant" } }, single, 0)).message,
    ).toBe(SPARK_ERROR_SENTENCES.cellUnreadable("variant", "p"));
  });
});

/** The captured every-type relation step of `version`: its DataType schema and its one Arrow batch. */
function everyTypeRelation(version: SparkCaptureVersion): { dataType: object; batch: Uint8Array } {
  const capture = readSparkCapture(version, "every-type-relation");
  if (capture.outcome !== "pass" || !Array.isArray(capture.payload))
    throw new Error("every-type-relation is not a pass list");
  const schema = capture.payload.find(
    (response) => typeof response === "object" && response !== null && (response as { schema?: unknown }).schema,
  ) as { schema: object };
  const batch = capture.payload.find(
    (response) => typeof response === "object" && response !== null && "arrow_batch" in response,
  ) as { arrow_batch: { data: unknown } };
  return { dataType: schema.schema, batch: captureBytes(batch.arrow_batch.data) };
}

/** The one row of SPARK_EVERY_TYPE_SELECT over the sample table, as Studio shows it on either path. */
const EVERY_TYPE_ROW = {
  c_boolean: true,
  c_tinyint: -7,
  c_smallint: -300,
  c_int: -70000,
  c_bigint_safe: 9007199254740991,
  c_bigint_large: "9223372036854775807",
  c_float: 0.1,
  c_double: 1.5,
  c_double_nan: Number.NaN,
  c_double_inf: Number.POSITIVE_INFINITY,
  c_decimal: "12345678.91",
  c_decimal_neg: "-0.05",
  c_decimal_38: "12345678901234567890123456789012345678",
  c_string: "héllo, wörld",
  c_string_collated: "Ab",
  c_char: "ab   ",
  c_varchar: "abc",
  c_binary: Buffer.from([0x00, 0xff, 0x10]),
  c_date: "2026-10-13",
  c_date_min: "0001-01-01",
  c_timestamp: "2026-10-13 12:34:56.789+00:00",
  c_timestamp_ntz: "2026-10-13 12:34:56.123456",
  c_ym_interval: "INTERVAL '3-7' YEAR TO MONTH",
  c_dt_interval: "INTERVAL '1 02:03:04.567891' DAY TO SECOND",
  c_array: [1, 2, null],
  c_map: { a: 1, b: 2 },
  c_map_nested_key: [[[1], "x"]],
  c_struct: { x: 1, y: "two" },
  // parse_json('{"b": 1.10, "a": [true, null]}'): Spark stores the fields sorted by name, and the decimal keeps its
  // scale.
  c_variant: '{"a":[true,null],"b":1.10}',
  c_null_int: null,
  c_void: null,
  // make_interval(1, 2, 3, 4, 5, 6, 7.000008): 14 months, 25 days and 5:06:07.000008 in microseconds.
  c_calendar_interval: "14 months 25 days 18367000008 microseconds",
};

describe("cellValue over Spark's own every-type batch", () => {
  for (const version of ["4.2.0", "4.1.3"] as const) {
    test(`${version}: every cell maps, JSON.stringify succeeds and no bigint leaves`, () => {
      const capture = readSparkCapture(version, "every-type-relation");
      if (capture.outcome !== "pass" || !Array.isArray(capture.payload))
        throw new Error("every-type-relation is not a pass list");
      const batch = capture.payload.find(
        (response) => typeof response === "object" && response !== null && "arrow_batch" in response,
      ) as {
        arrow_batch: { data: unknown };
      };
      const read = readIpcColumns(captureBytes(batch.arrow_batch.data));
      const columns = columnsFromArrow(read);
      const rows = Array.from({ length: read.rowCount }, (_, row) =>
        Object.fromEntries(columns.map((column, index) => [column.name, cellValue(column, read.columns[index], row)])),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(noBigint)).toBe(true);
      expect(() => JSON.stringify(rows)).not.toThrow();
    });

    test(`${version}: the row reads exactly on the command path's Arrow kinds and the relation path's DataType kinds`, () => {
      const { dataType, batch } = everyTypeRelation(version);
      const read = readIpcColumns(batch);
      expect(read.rowCount).toBe(1);
      const row = (columns: readonly SparkColumn[]) =>
        Object.fromEntries(columns.map((column, index) => [column.name, cellValue(column, read.columns[index], 0)]));
      // The Arrow types carry no interval fields, so the command path reads them as the whole range, as Spark does;
      // the DataType names each column's own fields.
      expect(row(columnsFromArrow(read))).toStrictEqual({
        ...EVERY_TYPE_ROW,
        c_year_interval: "INTERVAL '3-0' YEAR TO MONTH",
        c_hour_interval: "INTERVAL '1 02:00:00' DAY TO SECOND",
      });
      expect(row(columnsFromDataType(dataType))).toStrictEqual({
        ...EVERY_TYPE_ROW,
        c_year_interval: "INTERVAL '3' YEAR",
        c_hour_interval: "INTERVAL '26' HOUR",
      });
    });
  }
});
