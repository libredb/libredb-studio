import { describe, expect, test } from "bun:test";
import {
  columnTypeOf,
  decodeCell,
  decodeRows,
  parseCellJson,
  readColumns,
  SNOWFLAKE_DECODE_SENTENCES,
  type SnowflakeColumn,
} from "@/lib/db/providers/sql/snowflake/decode";
import { SnowflakeError } from "@/lib/db/providers/sql/snowflake/errors";

const col = (type: string, extra: Partial<SnowflakeColumn> = {}): SnowflakeColumn => ({
  name: "c",
  type,
  precision: null,
  scale: null,
  length: null,
  ...extra,
});

function refusal(run: () => unknown): SnowflakeError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SnowflakeError);
    return error as SnowflakeError;
  }
  throw new Error("expected a refusal");
}

/** The deepest nesting `parseCellJson` reads, `decode.ts`'s own bound. */
const SNOWFLAKE_CELL_MAX_DEPTH = 64;
describe("decodeCell", () => {
  test("fixed scale 0: a safe integer is a number, anything past it exact text", () => {
    expect(decodeCell(col("fixed", { precision: 38, scale: 0 }), "42")).toBe(42);
    expect(decodeCell(col("fixed", { precision: 38, scale: 0 }), "-17")).toBe(-17);
    expect(decodeCell(col("FIXED", { precision: 38, scale: 0 }), "9007199254740993")).toBe("9007199254740993");
    expect(decodeCell(col("fixed", { precision: 38, scale: 0 }), "-0")).toBe("-0");
    expect(decodeCell(col("fixed", { precision: 38, scale: 0 }), "007")).toBe("007");
    expect(decodeCell(col("fixed", { precision: 38 }), "5")).toBe(5);
  });

  test("fixed with a scale stays text", () => {
    expect(decodeCell(col("fixed", { precision: 10, scale: 2 }), "1.10")).toBe("1.10");
    expect(decodeCell(col("fixed", { precision: 10, scale: 2 }), "-3")).toBe("-3");
  });

  test("decfloat stays text in every documented form", () => {
    for (const text of ["1.5", "-12", "1.", ".5", "1e400", "-2.5E-10"]) {
      expect(decodeCell(col("decfloat"), text)).toBe(text);
    }
  });

  test("real: finite numbers, and the non-finite words by table", () => {
    expect(decodeCell(col("real"), "1.5e3")).toBe(1500);
    expect(decodeCell(col("real"), "-0.25")).toBe(-0.25);
    expect(decodeCell(col("real"), "NaN")).toBe("NaN");
    expect(decodeCell(col("real"), "inf")).toBe("Infinity");
    expect(decodeCell(col("real"), "-inf")).toBe("-Infinity");
    expect(decodeCell(col("real"), "Infinity")).toBe("Infinity");
    expect(decodeCell(col("real"), "-Infinity")).toBe("-Infinity");
  });

  test("boolean, binary, text, null", () => {
    expect(decodeCell(col("boolean"), "TRUE")).toBe(true);
    expect(decodeCell(col("boolean"), "1")).toBe(true);
    expect(decodeCell(col("boolean"), "False")).toBe(false);
    expect(decodeCell(col("boolean"), "0")).toBe(false);
    expect(decodeCell(col("boolean"), "maybe")).toBe("maybe");
    expect(decodeCell(col("binary"), "DEADBEEF")).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    expect(decodeCell(col("binary"), "")).toEqual(Buffer.alloc(0));
    expect(decodeCell(col("text"), "x")).toBe("x");
    expect(decodeCell(col("text"), null)).toBeNull();
    expect(decodeCell(col("timestamp_tz"), null)).toBeNull();
  });

  test("the two documented time strings", () => {
    // 82919 s is 23 h, 1 min, 59 s.
    expect(decodeCell(col("time", { scale: 9 }), "82919.000000000")).toBe("23:01:59.000000000");
    // 1616173619 is 2021-03-19 17:06:59 UTC; 1500 - 1440 is +60 minutes.
    expect(decodeCell(col("timestamp_tz", { scale: 9 }), "1616173619.000000000 1500")).toBe(
      "2021-03-19 18:06:59.000000000+01:00",
    );
  });

  test("time keeps the received fraction digits, and none without a fraction", () => {
    expect(decodeCell(col("time", { scale: 3 }), "0.5")).toBe("00:00:00.5");
    expect(decodeCell(col("time", { scale: 0 }), "86399")).toBe("23:59:59");
  });

  test("ntz is the wall time, exact to the nanosecond", () => {
    expect(decodeCell(col("timestamp_ntz", { scale: 9 }), "1616173619.123456789")).toBe(
      "2021-03-19 17:06:59.123456789",
    );
    expect(decodeCell(col("timestamp_ntz", { scale: 0 }), "0")).toBe("1970-01-01 00:00:00");
    expect(decodeCell(col("timestamp_ntz", { scale: 9 }), "253402300799.999999999")).toBe(
      "9999-12-31 23:59:59.999999999",
    );
    expect(decodeCell(col("timestamp_ntz", { scale: 0 }), "-62135596800")).toBe("0001-01-01 00:00:00");
  });

  test("ltz is the UTC instant with +00:00", () => {
    expect(decodeCell(col("timestamp_ltz", { scale: 3 }), "0.123")).toBe("1970-01-01 00:00:00.123+00:00");
  });

  // Captured on the trial (2026-10-14) for one SELECT of an NTZ, a TZ, an LTZ, a TIME and a DATE literal under the
  // session zones UTC, America/Los_Angeles (the user's default) and Asia/Kolkata: the cells are identical, so no
  // decoded value depends on the session TIMEZONE Studio now leaves to the user (SF-009). Only `ltz::TIMESTAMP_TZ`
  // moves, to the session's offset, which is how a user sees an LTZ instant at their own zone.
  test("the temporal cells are the same in every session zone, and an LTZ cast to TZ carries the session offset", () => {
    const decoded = (cells: readonly string[]) =>
      ["timestamp_ntz", "timestamp_tz", "timestamp_ltz", "time", "date"].map((type, index) =>
        decodeCell(col(type, { scale: 9 }), cells[index]),
      );
    const cells = [
      "1780315200.500000000",
      "1780308000.000000000 1560",
      "1780308000.000000000",
      "47655.000000000",
      "20605",
    ];
    expect(decoded(cells)).toEqual([
      "2026-06-01 12:00:00.500000000",
      "2026-06-01 12:00:00.000000000+02:00",
      "2026-06-01 10:00:00.000000000+00:00",
      "13:14:15.000000000",
      "2026-06-01",
    ]);
    const asTz = (offsetCell: string) =>
      decodeCell(col("timestamp_tz", { scale: 9 }), `1780308000.000000000 ${offsetCell}`);
    expect([asTz("1440"), asTz("1020"), asTz("1770")]).toEqual([
      "2026-06-01 10:00:00.000000000+00:00",
      "2026-06-01 03:00:00.000000000-07:00",
      "2026-06-01 15:30:00.000000000+05:30",
    ]);
  });

  test("tz offsets beyond 720 to 2160 shift by 1440", () => {
    expect(decodeCell(col("timestamp_tz", { scale: 0 }), "0 2400")).toBe("1970-01-01 16:00:00+16:00");
    expect(decodeCell(col("timestamp_tz", { scale: 0 }), "0 0")).toBe("1969-12-31 00:00:00-24:00");
    expect(decodeCell(col("timestamp_tz", { scale: 0 }), "0 1440")).toBe("1970-01-01 00:00:00+00:00");
    expect(decodeCell(col("timestamp_tz", { scale: 0 }), "0 1110")).toBe("1969-12-31 18:30:00-05:30");
    expect(decodeCell(col("timestamp_tz", { scale: 0 }), "0 -60")).toBe("1969-12-30 23:00:00-25:00");
  });

  test("a pre-1970 fraction is one signed decimal", () => {
    expect(decodeCell(col("timestamp_ntz", { scale: 1 }), "-1.5")).toBe("1969-12-31 23:59:58.5");
    expect(decodeCell(col("timestamp_ntz", { scale: 2 }), "-0.25")).toBe("1969-12-31 23:59:59.75");
  });

  // The cells the trial (Snowflake 10.37.100, 2026-10-12) answered for TO_TIME('23:01:59.123'),
  // TO_TIMESTAMP_NTZ('2021-03-19 17:06:59.5'), TO_TIMESTAMP_LTZ('2021-03-19 17:06:59'),
  // TO_TIMESTAMP_TZ('2021-03-19 18:06:59 +01:00') and TO_TIMESTAMP_NTZ('1969-12-31 23:59:58.5'): decimal seconds with
  // nine fraction digits at scale 9, and a pre-1970 instant as one signed decimal.
  test.each([
    ["time", "82919.123000000", "23:01:59.123000000"],
    ["timestamp_ntz", "1616173619.500000000", "2021-03-19 17:06:59.500000000"],
    ["timestamp_ltz", "1616173619.000000000", "2021-03-19 17:06:59.000000000+00:00"],
    ["timestamp_tz", "1616173619.000000000 1500", "2021-03-19 18:06:59.000000000+01:00"],
    ["timestamp_ntz", "-1.500000000", "1969-12-31 23:59:58.500000000"],
  ])("the captured %s cell %s", (type, cell, expected) => {
    expect(decodeCell(col(type, { scale: 9, precision: 0 }), cell)).toBe(expected);
  });

  test("date from days since epoch", () => {
    expect(decodeCell(col("date"), "0")).toBe("1970-01-01");
    expect(decodeCell(col("date"), "-719162")).toBe("0001-01-01");
    expect(decodeCell(col("date"), "2932896")).toBe("9999-12-31");
    expect(decodeCell(col("date"), "18705")).toBe("2021-03-19");
  });

  // The cells the trial answered (2026-10-14) for '10000-01-01'::DATE, DATEADD(year, -2028, '2026-06-01'::DATE),
  // DATEADD(year, -2026, ...), DATEADD(year, -12026, ...), TO_TIMESTAMP_NTZ('10000-01-01 00:00:00.5') and
  // DATEADD(year, -2028, '2026-06-01 10:11:12.123'::TIMESTAMP_NTZ): Snowflake stores years outside 1 to 9999, and one
  // such cell must not fail the result (SF-008). The year is astronomical: 0 is 1 BC, -2 is 3 BC.
  test.each([
    ["date", "2932897", "10000-01-01"],
    ["date", "-720107", "-0002-06-01"],
    ["date", "-719376", "0000-06-01"],
    ["date", "-719163", "0000-12-31"],
    ["date", "-4371801", "-10000-06-01"],
    ["date", "91331230", "252026-06-01"],
    ["timestamp_ntz", "253402300800.500000000", "10000-01-01 00:00:00.500000000"],
    ["timestamp_ntz", "-62217208127.877000000", "-0002-06-01 10:11:12.123000000"],
    ["timestamp_ntz", "-62135596801", "0000-12-31 23:59:59"],
    ["timestamp_ltz", "317349853872.000000000", "12026-06-01 17:11:12.000000000+00:00"],
    ["timestamp_tz", "-62217182928.000000000 1020", "-0002-06-01 10:11:12.000000000-07:00"],
    ["timestamp_tz", "253402300799 1500", "10000-01-01 00:59:59+01:00"],
  ])("a %s cell outside years 1 to 9999 (%s) is shown with its signed year", (type, cell, expected) => {
    expect(decodeCell(col(type, { scale: 9 }), cell)).toBe(expected);
  });

  test("inside years 1 to 9999 every date and timestamp matches the platform's own UTC calendar", () => {
    for (let days = -719_162; days <= 2_932_896; days += 997) {
      const iso = new Date(days * 86_400_000).toISOString();
      expect(decodeCell(col("date"), String(days))).toBe(iso.slice(0, 10));
      const seconds = days * 86_400 + 45_296;
      expect(decodeCell(col("timestamp_ntz", { scale: 0 }), String(seconds))).toBe(
        new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " "),
      );
    }
  });

  test("leap years follow the proleptic Gregorian calendar on both sides of year 1", () => {
    // Year 0 and year -4 are leap years, year -100 is not, year -400 is.
    expect(decodeCell(col("date"), String(-719162 - 366 + 59))).toBe("0000-02-29");
    expect(decodeCell(col("date"), String(-719162 - 366 + 60))).toBe("0000-03-01");
    const daysBefore = (years: number) => {
      let days = 0;
      for (let year = 0; year > -years; year -= 1) {
        const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        days += leap ? 366 : 365;
      }
      return days;
    };
    // The first day of year -99, less one day, is the last day of year -100.
    expect(decodeCell(col("date"), String(-719162 - daysBefore(100) - 1))).toBe("-0100-12-31");
    expect(decodeCell(col("date"), String(-719162 - daysBefore(101) + 59))).toBe("-0100-03-01");
    expect(decodeCell(col("date"), String(-719162 - daysBefore(401) + 59))).toBe("-0400-02-29");
  });

  test("the refusals name the column", () => {
    for (const [column, cell] of [
      [col("binary", { name: "blob" }), "ZZ"],
      [col("binary", { name: "odd" }), "ABC"],
      [col("fixed", { name: "n", precision: 38, scale: 0 }), "abc"],
      [col("fixed", { name: "n1", precision: 38, scale: 0 }), "1.5"],
      [col("fixed", { name: "n2", precision: 10, scale: 2 }), "1e5"],
      [col("decfloat", { name: "df" }), "x"],
      [col("real", { name: "r" }), "1e999"],
      [col("real", { name: "r2" }), "nan"],
      [col("timestamp_ntz", { name: "ts2", scale: 9 }), "1.1234567890"],
      [col("timestamp_ltz", { name: "lt", scale: 0 }), "2021-03-19"],
      [col("timestamp_tz", { name: "tz", scale: 0 }), "0"],
      [col("time", { name: "t", scale: 0 }), "86400"],
      [col("time", { name: "t2", scale: 0 }), "-1"],
      [col("date", { name: "d3" }), "1.5"],
    ] as const) {
      expect(() => decodeCell(column, cell)).toThrow(SnowflakeError);
      expect(() => decodeCell(column, cell)).toThrow(`column "${column.name}"`);
    }
  });

  test("the refusal sentence names the catalog type and the column, and is a query error", () => {
    const error = refusal(() => decodeCell(col("binary", { name: "blob" }), "ZZ"));
    expect(error.category).toBe("query");
    expect(error.message).toBe(
      'Snowflake sent a BINARY value in column "blob" that Studio could not read, so the result is not shown.',
    );
    expect(error.message).toBe(SNOWFLAKE_DECODE_SENTENCES.unreadable("BINARY", "blob"));
  });

  test("a cell that is neither text nor null is refused", () => {
    for (const cell of [42, true, {}, ["x"]]) {
      expect(() => decodeCell(col("text", { name: "v" }), cell as unknown as string)).toThrow('column "v"');
    }
  });

  test("semi-structured, structured, vector and unknown cells stay their text", () => {
    for (const type of [
      "variant",
      "object",
      "array",
      "map",
      "vector",
      "geography",
      "geometry",
      "uuid",
      "file",
      "interval",
      "made_up",
    ]) {
      expect(decodeCell(col(type), '{"a":[1,2]}')).toBe('{"a":[1,2]}');
    }
  });

  test("a 10,000-deep VARIANT passes as a string", () => {
    const deep = `${"[".repeat(10_000)}${"]".repeat(10_000)}`;
    expect(decodeCell(col("variant"), deep)).toBe(deep);
  });
});

describe("decodeRows", () => {
  test("each row keyed by the column names, a repeated name numbered, every cell decoded", () => {
    const columns = [
      col("fixed", { name: "ID", precision: 38, scale: 0 }),
      col("text", { name: "ID" }),
      col("boolean", { name: "OK" }),
    ];
    expect(
      decodeRows(columns, [
        ["1", "a", "true"],
        [null, null, null],
      ]),
    ).toEqual([
      { ID: 1, "ID (2)": "a", OK: true },
      { ID: null, "ID (2)": null, OK: null },
    ]);
  });

  test("a column named __proto__ is an ordinary key", () => {
    const [row] = decodeRows([col("text", { name: "__proto__" })], [["x"]]);
    expect(Object.keys(row)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  });

  test("a row whose width is not the column count is refused", () => {
    const error = refusal(() => decodeRows([col("text", { name: "A" })], [["x", "y"]]));
    expect(error.category).toBe("defect");
    expect(error.message).toBe(SNOWFLAKE_DECODE_SENTENCES.columns);
  });
});

describe("columnTypeOf", () => {
  test("catalog spelling", () => {
    expect(columnTypeOf(col("fixed", { precision: 38, scale: 0 }))).toBe("NUMBER(38,0)");
    expect(columnTypeOf(col("fixed", { precision: 38 }))).toBe("NUMBER(38,0)");
    expect(columnTypeOf(col("fixed", { precision: 10, scale: 2 }))).toBe("NUMBER(10,2)");
    expect(columnTypeOf(col("fixed"))).toBe("NUMBER");
    expect(columnTypeOf(col("decfloat"))).toBe("DECFLOAT");
    expect(columnTypeOf(col("real"))).toBe("FLOAT");
    expect(columnTypeOf(col("text", { length: 16777216 }))).toBe("VARCHAR(16777216)");
    expect(columnTypeOf(col("text"))).toBe("VARCHAR");
    expect(columnTypeOf(col("boolean"))).toBe("BOOLEAN");
    expect(columnTypeOf(col("binary", { length: 8 }))).toBe("BINARY");
    expect(columnTypeOf(col("date"))).toBe("DATE");
    expect(columnTypeOf(col("time", { scale: 9 }))).toBe("TIME(9)");
    expect(columnTypeOf(col("time"))).toBe("TIME");
    expect(columnTypeOf(col("timestamp_ntz", { scale: 3 }))).toBe("TIMESTAMP_NTZ(3)");
    expect(columnTypeOf(col("timestamp_ltz", { scale: 0 }))).toBe("TIMESTAMP_LTZ(0)");
    expect(columnTypeOf(col("timestamp_tz", { scale: 9 }))).toBe("TIMESTAMP_TZ(9)");
    expect(columnTypeOf(col("variant"))).toBe("VARIANT");
    expect(columnTypeOf(col("vector"))).toBe("VECTOR");
    expect(columnTypeOf(col("geography"))).toBe("GEOGRAPHY");
  });

  test("an object column is GEOGRAPHY or GEOMETRY when its extTypeName says so, else OBJECT (SF-033)", () => {
    expect(columnTypeOf({ ...col("object"), extTypeName: "GEOGRAPHY" })).toBe("GEOGRAPHY");
    expect(columnTypeOf({ ...col("object"), extTypeName: "geometry" })).toBe("GEOMETRY");
    expect(columnTypeOf({ ...col("object"), extTypeName: "FILE" })).toBe("OBJECT");
    expect(columnTypeOf(col("object"))).toBe("OBJECT");
  });
});

describe("parseCellJson and readColumns", () => {
  test("a text nested past the depth bound is refused before any parse", () => {
    const deep = `${"[".repeat(SNOWFLAKE_CELL_MAX_DEPTH + 1)}${"]".repeat(SNOWFLAKE_CELL_MAX_DEPTH + 1)}`;
    expect(() => parseCellJson(deep, "data_type")).toThrow(SnowflakeError);
    expect(() => parseCellJson(deep, "data_type")).toThrow('a VARIANT value in column "data_type"');
    const atBound = `${"[".repeat(SNOWFLAKE_CELL_MAX_DEPTH)}${"]".repeat(SNOWFLAKE_CELL_MAX_DEPTH)}`;
    expect(parseCellJson(atBound, "x")).toBeArray();
    expect(parseCellJson('{"type":"FIXED","precision":38,"scale":0,"nullable":true}', "data_type")).toEqual({
      type: "FIXED",
      precision: 38,
      scale: 0,
      nullable: true,
    });
    expect(parseCellJson('{"a":"]]]]"}', "x")).toEqual({ a: "]]]]" });
  });

  test("brackets inside strings, escaped quotes among them, do not count toward the depth", () => {
    const inside = `"${'\\"'.repeat(3)}${"[{".repeat(200)}"`;
    expect(parseCellJson(`[${inside}]`, "x")).toEqual([`${'"'.repeat(3)}${"[{".repeat(200)}`]);
    expect(parseCellJson('"a\\\\"', "x")).toBe("a\\");
  });

  test("text that is not JSON is refused with the column name", () => {
    expect(() => parseCellJson("{not json", "data_type")).toThrow('column "data_type"');
  });

  test("a column list that is not an array of named, typed columns is refused", () => {
    for (const rowType of [
      [{ name: 1, type: "text" }],
      [{ name: "A" }],
      [{ name: "A", type: "text", precision: "38" }],
      [{ name: "A", type: "text", length: Number.NaN }],
      [null],
      ["A"],
      { name: "A", type: "text" },
      null,
    ]) {
      const error = refusal(() => readColumns(rowType));
      expect(error.category).toBe("defect");
      expect(error.message).toBe("Snowflake sent a result whose column list Studio could not read.");
    }
    expect(readColumns([{ name: "A", type: "TEXT", length: 5, precision: null, scale: null, nullable: true }])).toEqual(
      [{ name: "A", type: "text", precision: null, scale: null, length: 5 }],
    );
    expect(readColumns([{ name: "N", type: "fixed", precision: 38, scale: 0 }])).toEqual([
      { name: "N", type: "fixed", precision: 38, scale: 0, length: null },
    ]);
    expect(
      readColumns([{ name: "G", type: "object", extTypeName: "GEOGRAPHY", precision: null, scale: null }]),
    ).toEqual([{ name: "G", type: "object", precision: null, scale: null, length: null, extTypeName: "GEOGRAPHY" }]);
    expect(readColumns([{ name: "O", type: "object", extTypeName: 7 }])).toEqual([
      { name: "O", type: "object", precision: null, scale: null, length: null },
    ]);
    expect(readColumns([])).toEqual([]);
  });
});

describe("the cell each Snowflake type decodes to", () => {
  test("fixed, real, boolean, date, timestamp and variant cells decode to their JavaScript values", () => {
    const column = (type: string, scale: number | null = null) => ({
      name: "C",
      type,
      precision: 38,
      scale,
      length: null,
    });
    expect(decodeCell(column("fixed", 0), "42")).toBe(42);
    expect(decodeCell(column("fixed", 0), "9007199254740993")).toBe("9007199254740993");
    expect(decodeCell(column("fixed", 2), "1.50")).toBe("1.50");
    expect(decodeCell(column("real"), "NaN")).toBe("NaN");
    expect(decodeCell(column("boolean"), "TRUE")).toBe(true);
    expect(decodeCell(column("date"), "0")).toBe("1970-01-01");
    expect(decodeCell(column("timestamp_ltz", 0), "0")).toBe("1970-01-01 00:00:00+00:00");
    expect(decodeCell(column("timestamp_ltz", 9), "1780340400.000000000")).toBe("2026-06-01 19:00:00.000000000+00:00");
    expect(decodeCell(column("timestamp_tz", 9), "1780340400.000000000 1020")).toBe(
      "2026-06-01 12:00:00.000000000-07:00",
    );
    expect(decodeCell(column("variant"), '{"a": 1}')).toBe('{"a": 1}');
  });
});
