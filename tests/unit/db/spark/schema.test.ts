import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { captureBytes, readSparkCapture, type SparkCaptureVersion } from "../../../helpers/spark-captures";
import { columnsStream, type SparkIpcColumn } from "../../../helpers/spark-ipc";
import type { SparkCaptureName } from "../../../live/spark-evidence-plan";
import { type ArrowColumnData, readIpcColumns } from "@/lib/db/providers/sql/spark/arrow";
import { SPARK_ERROR_SENTENCES, SparkError } from "@/lib/db/providers/sql/spark/errors";
import {
  assertSchemasAgree,
  columnsFromArrow,
  columnsFromDataType,
  type SparkColumn,
} from "@/lib/db/providers/sql/spark/schema";

const t = (kind: string, body: object = {}) => ({ kind, [kind]: body });
const struct = (fields: readonly (readonly [string, object])[]) =>
  t("struct", { fields: fields.map(([name, data_type]) => ({ name, data_type, nullable: true })) });
const udt = (storage?: object) =>
  t("udt", storage === undefined ? { type: "udt" } : { type: "udt", sql_type: storage });
/** The one column of a schema holding `dataType` alone. */
const one = (dataType: object) => columnsFromDataType(struct([["c", dataType]]))[0];
const fromStream = (columns: readonly SparkIpcColumn[]) => columnsFromArrow(readIpcColumns(columnsStream(columns)));

/** What `read` threw: a SparkError as its category and its sentence, so one assertion holds both. */
function refusalOf(read: () => unknown): unknown {
  try {
    read();
    return "nothing was refused";
  } catch (error) {
    return error instanceof SparkError ? { category: error.category, message: error.message } : error;
  }
}
const unreadable = (what: string) => ({ category: "unreadable", message: SPARK_ERROR_SENTENCES.unreadable(what) });

/**
 * A struct whose field names hold a backtick, a quote, and a colon and a comma, as both paths spell it: each such name
 * backticked with a backtick inside doubled, as Spark's quoteIfNeeded writes it, so the spelling is type text Spark
 * parses back as the same struct (the SQL export hands it to FROM_JSON); the kind keeps every name as it is.
 */
const QUOTED_FIELDS: Omit<SparkColumn, "name"> = {
  spelling: "struct<`a``b`:int,`it's`:string,`x:int,y`:bigint,ok:boolean>",
  kind: {
    type: "struct",
    fields: [
      { name: "a`b", kind: { type: "int" } },
      { name: "it's", kind: { type: "string" } },
      { name: "x:int,y", kind: { type: "bigint" } },
      { name: "ok", kind: { type: "boolean" } },
    ],
  },
};

describe("columnsFromDataType: spellings and kinds", () => {
  test("every scalar type", () => {
    const columns = columnsFromDataType(
      struct([
        ["n", t("null")],
        ["b", t("boolean")],
        ["i1", t("byte")],
        ["i2", t("short")],
        ["i4", t("integer")],
        ["i8", t("long")],
        ["f", t("float")],
        ["d", t("double")],
        ["dec", t("decimal", { precision: 10, scale: 2 })],
        ["neg", t("decimal", { precision: 1, scale: -10 })],
        ["s", t("string", { collation: "UTF8_BINARY" })],
        ["sc", t("string", { collation: "UTF8_LCASE" })],
        ["c", t("char", { length: 5 })],
        ["vc", t("var_char", { length: 10 })],
        ["bin", t("binary")],
        ["day", t("date")],
        ["ts", t("timestamp")],
        ["ntz", t("timestamp_ntz")],
        ["tm", t("time", { precision: 3 })],
        ["cal", t("calendar_interval")],
        ["ym", t("year_month_interval", { start_field: 0, end_field: 1 })],
        ["y", t("year_month_interval", { start_field: 0, end_field: 0 })],
        ["dt", t("day_time_interval", { start_field: 0, end_field: 3 })],
        ["h", t("day_time_interval", { start_field: 1, end_field: 1 })],
        ["v", t("variant")],
        ["g", t("geometry", { srid: 4326 })],
        ["gg", t("geography", { srid: 4326 })],
        ["u", t("udt", { type: "udt", sql_type: t("long") })],
      ]),
    );
    expect(columns.map((column) => [column.name, column.spelling])).toStrictEqual([
      ["n", "void"],
      ["b", "boolean"],
      ["i1", "tinyint"],
      ["i2", "smallint"],
      ["i4", "int"],
      ["i8", "bigint"],
      ["f", "float"],
      ["d", "double"],
      ["dec", "decimal(10,2)"],
      ["neg", "decimal(1,-10)"],
      ["s", "string"],
      ["sc", "string collate UTF8_LCASE"],
      ["c", "char(5)"],
      ["vc", "varchar(10)"],
      ["bin", "binary"],
      ["day", "date"],
      ["ts", "timestamp"],
      ["ntz", "timestamp_ntz"],
      ["tm", "time(3)"],
      ["cal", "interval"],
      ["ym", "interval year to month"],
      ["y", "interval year"],
      ["dt", "interval day to second"],
      ["h", "interval hour"],
      ["v", "variant"],
      ["g", "geometry(4326)"],
      ["gg", "geography(4326)"],
      ["u", "bigint"],
    ]);
    expect(columns.map((column) => column.kind)).toStrictEqual([
      { type: "void" },
      { type: "boolean" },
      { type: "tinyint" },
      { type: "smallint" },
      { type: "int" },
      { type: "bigint" },
      { type: "float" },
      { type: "double" },
      { type: "decimal", precision: 10, scale: 2 },
      { type: "decimal", precision: 1, scale: -10 },
      { type: "string" },
      { type: "string" },
      { type: "string" },
      { type: "string" },
      { type: "binary" },
      { type: "date" },
      { type: "timestamp" },
      { type: "timestamp_ntz" },
      { type: "time", precision: 3 },
      { type: "calendar-interval" },
      { type: "year-month-interval", fields: { start: "YEAR", end: "MONTH" } },
      { type: "year-month-interval", fields: { start: "YEAR", end: "YEAR" } },
      { type: "day-time-interval", fields: { start: "DAY", end: "SECOND" } },
      { type: "day-time-interval", fields: { start: "HOUR", end: "HOUR" } },
      { type: "variant" },
      { type: "geometry", srid: 4326 },
      { type: "geography", srid: 4326 },
      { type: "bigint" },
    ]);
  });

  test("nested types spell their parts, a field name quoted where Spark would", () => {
    const [column] = columnsFromDataType(
      struct([
        [
          "x",
          t("map", {
            key_type: t("string"),
            value_type: t("array", {
              element_type: struct([
                ["a b", t("integer")],
                ["ok", t("long")],
              ]),
            }),
          }),
        ],
      ]),
    );
    expect(column.spelling).toBe("map<string,array<struct<`a b`:int,ok:bigint>>>");
    expect(column.kind).toStrictEqual({
      type: "map",
      key: { type: "string" },
      value: {
        type: "array",
        element: {
          type: "struct",
          fields: [
            { name: "a b", kind: { type: "int" } },
            { name: "ok", kind: { type: "bigint" } },
          ],
        },
      },
    });
  });

  test("a struct field name Spark would quote is backticked, a backtick doubled, so the spelling parses back", () => {
    expect(
      one(
        struct([
          ["a`b", t("integer")],
          ["it's", t("string")],
          ["x:int,y", t("long")],
          ["ok", t("boolean")],
        ]),
      ),
    ).toStrictEqual({ name: "c", ...QUOTED_FIELDS });
  });

  test("a field the proto leaves out reads as Spark reads it", () => {
    const left = [
      { kind: "decimal" },
      t("decimal"),
      t("decimal", { precision: 5 }),
      t("decimal", { scale: 3 }),
      t("time"),
      t("year_month_interval"),
      t("year_month_interval", { start_field: 1 }),
      t("year_month_interval", { end_field: 0 }),
      t("day_time_interval"),
      t("day_time_interval", { start_field: 2 }),
      t("day_time_interval", { end_field: 1 }),
      t("string"),
      t("char"),
      t("var_char"),
      t("struct"),
      t("geometry"),
      t("geography"),
    ];
    expect(left.map((dataType) => one(dataType).spelling)).toStrictEqual([
      "decimal(10,0)",
      "decimal(10,0)",
      "decimal(5,0)",
      "decimal(10,0)",
      "time(6)",
      "interval year to month",
      "interval month",
      "interval year to month",
      "interval day to second",
      "interval minute",
      "interval day to second",
      "string",
      "char(0)",
      "varchar(0)",
      "struct<>",
      "geometry(0)",
      "geography(0)",
    ]);
    expect(one(t("struct")).kind).toStrictEqual({ type: "struct", fields: [] });
    expect(one(t("decimal", { scale: 3 })).kind).toStrictEqual({ type: "decimal", precision: 10, scale: 0 });
    expect(one(t("day_time_interval", { start_field: 2 })).kind).toStrictEqual({
      type: "day-time-interval",
      fields: { start: "MINUTE", end: "MINUTE" },
    });
    expect(one(t("geometry")).kind).toStrictEqual({ type: "geometry", srid: 0 });
    // A field the proto gives no name reads with the empty name, as proto3 reads an unset string.
    expect(columnsFromDataType(t("struct", { fields: [{ data_type: t("integer") }] }))).toStrictEqual([
      { name: "", spelling: "int", kind: { type: "int" } },
    ]);
  });

  test("a type with no parameters is one frozen node, so no caller can change it for a later result", () => {
    const first = one(t("integer"));
    expect(() => {
      (first.kind as { type: string }).type = "string";
    }).toThrow(TypeError);
    expect(one(t("integer")).kind).toStrictEqual({ type: "int" });
    expect(fromStream([{ name: "c", kind: "int32", values: [1] }])[0].kind).toBe(first.kind);
  });

  test("a geospatial type of mixed srid is spelled any, as Spark spells it", () => {
    const columns = columnsFromDataType(
      struct([
        ["g", t("geometry", { srid: -1 })],
        ["gg", t("geography", { srid: -1 })],
      ]),
    );
    expect(columns.map((column) => column.spelling)).toStrictEqual(["geometry(any)", "geography(any)"]);
    expect(columns.map((column) => column.kind)).toStrictEqual([
      { type: "geometry", srid: -1 },
      { type: "geography", srid: -1 },
    ]);
  });

  test("a decimal outside precision 1 to 38, scale -38 to the precision, or of a fractional precision or scale, is refused as unreadable", () => {
    const decimal = (precision: number, scale: number) => struct([["d", t("decimal", { precision, scale })]]);
    for (const [precision, scale] of [
      [0, 0],
      [39, 0],
      [38, 39],
      [10, -39],
      [10.5, 2],
      [10, 2.5],
    ] as const) {
      expect(refusalOf(() => columnsFromDataType(decimal(precision, scale)))).toStrictEqual(
        unreadable(`a result column of the Spark type decimal(${precision},${scale})`),
      );
    }
    for (const [precision, scale] of [
      [38, 38],
      [10, -38],
      [10, 2],
    ] as const) {
      expect(columnsFromDataType(decimal(precision, scale))[0].spelling).toBe(`decimal(${precision},${scale})`);
    }
  });

  test("an interval field index outside its unit list, fractional, or a start after the end is refused once, at schema time", () => {
    const interval = (kind: string, start_field: number, end_field: number) =>
      struct([["i", t(kind, { start_field, end_field })]]);
    for (const [kind, start, end] of [
      ["day_time_interval", 3, 0],
      ["day_time_interval", 0, 4],
      ["day_time_interval", -1, 3],
      ["year_month_interval", 1, 0],
      ["year_month_interval", 0, 2],
      ["day_time_interval", 1.5, 3],
      ["year_month_interval", 0, 0.5],
    ] as const) {
      expect(refusalOf(() => columnsFromDataType(interval(kind, start, end)))).toStrictEqual(
        unreadable(`an interval column whose fields run from ${start} to ${end}`),
      );
    }
    // A start alone is that one unit, as Spark reads it, so a start outside the list is refused the same way.
    expect(refusalOf(() => one(t("day_time_interval", { start_field: 4 })))).toStrictEqual(
      unreadable("an interval column whose fields run from 4 to 4"),
    );
    expect(columnsFromDataType(interval("day_time_interval", 2, 2))[0].kind).toStrictEqual({
      type: "day-time-interval",
      fields: { start: "MINUTE", end: "MINUTE" },
    });
  });

  test("64 levels and 10,000 fields are read; 65 levels, 10,001 fields, an unknown type and a non-struct schema are refused", () => {
    const nested = (levels: number, inner: object = t("integer")) => {
      let type: object = inner;
      for (let level = 1; level < levels; level += 1) type = t("array", { element_type: type });
      return struct([["c", type]]);
    };
    const wide = (fields: number, type: () => object = () => t("integer")) =>
      struct(Array.from({ length: fields }, (_, index) => [`c${index}`, type()] as const));
    expect(columnsFromDataType(nested(64))).toHaveLength(1);
    expect(columnsFromDataType(wide(10_000))).toHaveLength(10_000);
    expect(refusalOf(() => columnsFromDataType(nested(65)))).toStrictEqual(
      unreadable("a result schema nested deeper than 64 levels"),
    );
    expect(refusalOf(() => columnsFromDataType(wide(10_001)))).toStrictEqual(
      unreadable("a result schema with more than 10,000 fields"),
    );
    // A struct this wide is refused before any of its fields is read, so a first field of an unknown type is not what
    // refuses it.
    expect(refusalOf(() => columnsFromDataType(wide(10_001, () => t("unparsed"))))).toStrictEqual(
      unreadable("a result schema with more than 10,000 fields"),
    );
    // Every type node counts, nested ones included: 5,000 arrays of int are 10,000 fields.
    const arrays = () => t("array", { element_type: t("integer") });
    expect(columnsFromDataType(wide(5_000, arrays))).toHaveLength(5_000);
    expect(refusalOf(() => columnsFromDataType(wide(5_001, arrays)))).toStrictEqual(
      unreadable("a result schema with more than 10,000 fields"),
    );
    // A user-defined type is read as its storage type, at the same depth and counted once, as Arrow carries it.
    expect(columnsFromDataType(nested(64, udt(t("integer"))))[0].spelling).toBe(
      `${"array<".repeat(63)}int${">".repeat(63)}`,
    );
    expect(columnsFromDataType(wide(10_000, () => udt(t("integer"))))).toHaveLength(10_000);
    expect(one(udt(udt(t("long")))).spelling).toBe("bigint");
    expect(
      refusalOf(() => columnsFromDataType(struct([["c", t("unparsed", { data_type_string: "x" })]]))),
    ).toStrictEqual(unreadable("a result column of the Spark type unparsed"));
    expect(refusalOf(() => one(udt()))).toStrictEqual(unreadable("a result column of the Spark type (none)"));
    expect(refusalOf(() => columnsFromDataType(t("integer")))).toStrictEqual(
      unreadable("a result schema that is not a struct"),
    );
    expect(refusalOf(() => columnsFromDataType({}))).toStrictEqual(unreadable("a result schema that is not a struct"));
  });
});

describe("columnsFromArrow: the command path, from Arrow types", () => {
  test("reads intervals as Spark reads them back, and tells variant and geospatial structs apart", () => {
    const columns = fromStream([
      { name: "ym", kind: "interval-ym", values: [1] },
      { name: "dt", kind: "duration-us", values: [BigInt(1)] },
      { name: "cal", kind: "interval-mdn", values: [{ months: 1, days: 0, nanos: BigInt(0) }] },
      { name: "ts", kind: "timestamp-utc", values: [BigInt(0)] },
      { name: "ntz", kind: "timestamp-ntz", values: [BigInt(0)] },
      { name: "dec", kind: "decimal", precision: 38, scale: 18, values: [BigInt(1)] },
      {
        name: "v",
        kind: "struct",
        length: 1,
        children: [
          { name: "value", kind: "binary", values: [new Uint8Array([0])] },
          { name: "metadata", kind: "binary", values: [new Uint8Array([1, 0, 0])], metadata: { variant: "true" } },
        ],
      },
      {
        name: "g",
        kind: "struct",
        length: 1,
        children: [
          { name: "srid", kind: "int32", values: [4326] },
          { name: "wkb", kind: "binary", values: [new Uint8Array(0)], metadata: { geometry: "true", srid: "4326" } },
        ],
      },
      {
        name: "gg",
        kind: "struct",
        length: 1,
        children: [
          { name: "srid", kind: "int32", values: [4326] },
          { name: "wkb", kind: "binary", values: [new Uint8Array(0)], metadata: { geography: "true", srid: "4326" } },
        ],
      },
      { name: "s", kind: "struct", length: 1, children: [{ name: "value", kind: "binary", values: [null] }] },
      {
        name: "m",
        kind: "map",
        offsets: [0, 0],
        keys: { name: "key", kind: "utf8", values: [] },
        items: { name: "value", kind: "list", offsets: [0], child: { name: "element", kind: "bool", values: [] } },
      },
      { name: "n", kind: "null", length: 1 },
      { name: "t", kind: "time64-ns", values: [BigInt(0)] },
    ]);
    expect(columns.map((column) => [column.name, column.spelling])).toStrictEqual([
      ["ym", "interval year to month"],
      ["dt", "interval day to second"],
      ["cal", "interval"],
      ["ts", "timestamp"],
      ["ntz", "timestamp_ntz"],
      ["dec", "decimal(38,18)"],
      ["v", "variant"],
      ["g", "geometry(4326)"],
      ["gg", "geography(4326)"],
      ["s", "struct<value:binary>"],
      ["m", "map<string,array<boolean>>"],
      ["n", "void"],
      ["t", "time(6)"],
    ]);
    expect(columns.map((column) => column.kind)).toStrictEqual([
      { type: "year-month-interval", fields: { start: "YEAR", end: "MONTH" } },
      { type: "day-time-interval", fields: { start: "DAY", end: "SECOND" } },
      { type: "calendar-interval" },
      { type: "timestamp" },
      { type: "timestamp_ntz" },
      { type: "decimal", precision: 38, scale: 18 },
      { type: "variant" },
      { type: "geometry", srid: 4326 },
      { type: "geography", srid: 4326 },
      { type: "struct", fields: [{ name: "value", kind: { type: "binary" } }] },
      { type: "map", key: { type: "string" }, value: { type: "array", element: { type: "boolean" } } },
      { type: "void" },
      { type: "time", precision: 6 },
    ]);
  });

  test("every integer and float width, string and binary", () => {
    const columns = fromStream([
      { name: "a", kind: "int8", values: [1] },
      { name: "b", kind: "int16", values: [1] },
      { name: "c", kind: "int32", values: [1] },
      { name: "d", kind: "int64", values: [BigInt(1)] },
      { name: "e", kind: "float32", values: [1] },
      { name: "f", kind: "float64", values: [1] },
      { name: "g", kind: "utf8", values: ["x"] },
      { name: "h", kind: "binary", values: [new Uint8Array(1)] },
      { name: "i", kind: "bool", values: [true] },
      { name: "j", kind: "date32", values: [0] },
    ]);
    expect(columns.map((column) => [column.name, column.spelling])).toStrictEqual([
      ["a", "tinyint"],
      ["b", "smallint"],
      ["c", "int"],
      ["d", "bigint"],
      ["e", "float"],
      ["f", "double"],
      ["g", "string"],
      ["h", "binary"],
      ["i", "boolean"],
      ["j", "date"],
    ]);
  });

  test("a timestamp whose zone is unset or empty reads as timestamp_ntz, as Arrow's Schema.fbs reads it", () => {
    const timestamp = (timezone: string | null): ArrowColumnData => ({
      name: "ts",
      type: "timestamp",
      length: 0,
      nullCount: 0,
      validity: undefined,
      values: undefined,
      offsets: undefined,
      children: [],
      timezone,
      metadata: new Map(),
    });
    const columns = columnsFromArrow({ rowCount: 0, columns: [timestamp(""), timestamp(null), timestamp("Etc/UTC")] });
    expect(columns.map((column) => column.spelling)).toStrictEqual(["timestamp_ntz", "timestamp_ntz", "timestamp"]);
  });

  test("a tagged struct outside Spark's own layouts reads as a struct, and a mixed srid is spelled any", () => {
    const binary = (name: string, metadata?: Readonly<Record<string, string>>): SparkIpcColumn => ({
      name,
      kind: "binary",
      values: [new Uint8Array(0)],
      ...(metadata === undefined ? {} : { metadata }),
    });
    const srid: SparkIpcColumn = { name: "srid", kind: "int32", values: [4326] };
    const columns = fromStream([
      { name: "a", kind: "struct", length: 1, children: [binary("a"), binary("b", { variant: "true" })] },
      { name: "b", kind: "struct", length: 1, children: [binary("metadata", { variant: "true" }), binary("value")] },
      {
        name: "c",
        kind: "struct",
        length: 1,
        children: [binary("value"), binary("metadata", { variant: "true" }), binary("x")],
      },
      { name: "d", kind: "struct", length: 1, children: [srid, binary("geom", { geometry: "true", srid: "4326" })] },
      { name: "e", kind: "struct", length: 1, children: [srid, binary("wkb", { srid: "4326" })] },
      { name: "f", kind: "struct", length: 1, children: [srid, binary("wkb", { geography: "true", srid: "-1" })] },
      {
        name: "g",
        kind: "struct",
        length: 1,
        children: [srid, binary("wkb", { geography: "true", geometry: "true", srid: "4326" })],
      },
    ]);
    expect(columns.map((column) => column.spelling)).toStrictEqual([
      "struct<a:binary,b:binary>",
      "struct<metadata:binary,value:binary>",
      "struct<value:binary,metadata:binary,x:binary>",
      "struct<srid:int,geom:binary>",
      "struct<srid:int,wkb:binary>",
      "geography(any)",
      "geometry(4326)",
    ]);
    expect(columns[5].kind).toStrictEqual({ type: "geography", srid: -1 });
  });

  test("a struct field name Spark would quote is backticked here too, as the relation path spells it", () => {
    expect(
      fromStream([
        {
          name: "c",
          kind: "struct",
          length: 1,
          children: [
            { name: "a`b", kind: "int32", values: [1] },
            { name: "it's", kind: "utf8", values: ["x"] },
            { name: "x:int,y", kind: "int64", values: [BigInt(1)] },
            { name: "ok", kind: "bool", values: [true] },
          ],
        },
      ]),
    ).toStrictEqual([{ name: "c", ...QUOTED_FIELDS }]);
  });

  for (const version of ["4.2.0", "4.1.3"] as const satisfies readonly SparkCaptureVersion[]) {
    test(`the captured inline answer of ${version} reads from its Arrow types`, () => {
      const capture = readSparkCapture(version, "show-tables-inline");
      if (capture.outcome !== "pass" || !Array.isArray(capture.payload)) {
        throw new Error("show-tables-inline is not a pass list");
      }
      const answer = capture.payload.find(
        (response) => typeof response === "object" && response !== null && "sql_command_result" in response,
      ) as { sql_command_result: { relation: { local_relation: { data: unknown } } } };
      const data = answer.sql_command_result.relation.local_relation.data;
      expect(
        columnsFromArrow(readIpcColumns(captureBytes(data))).map((column) => [column.name, column.spelling]),
      ).toStrictEqual([
        ["namespace", "string"],
        ["tableName", "string"],
        ["isTemporary", "boolean"],
      ]);
    });
  }

  test("a geospatial struct whose srid is not an int32 in digits is refused, as Spark's own reader refuses it", () => {
    const geo = (type: "geometry" | "geography", metadata: Readonly<Record<string, string>>) => () =>
      fromStream([
        {
          name: "g",
          kind: "struct",
          length: 1,
          children: [
            { name: "srid", kind: "int32", values: [4326] },
            { name: "wkb", kind: "binary", values: [new Uint8Array(0)], metadata: { [type]: "true", ...metadata } },
          ],
        },
      ]);
    for (const text of ["", "x", "4326.0", " 4326", "1e3", "2147483648", "-2147483649"]) {
      expect(refusalOf(geo("geometry", { srid: text }))).toStrictEqual(
        unreadable("a geometry column without a readable srid"),
      );
    }
    expect(refusalOf(geo("geography", {}))).toStrictEqual(unreadable("a geography column without a readable srid"));
    expect(geo("geometry", { srid: "2147483647" })()[0].spelling).toBe("geometry(2147483647)");
    expect(geo("geometry", { srid: "-2147483648" })()[0].spelling).toBe("geometry(-2147483648)");
  });
});

/** The strings of a Utf8 column, read from its offsets. */
function utf8Values(column: ArrowColumnData | undefined): string[] {
  if (column?.type !== "utf8" || column.values === undefined || column.offsets === undefined) {
    throw new Error("not a Utf8 column with values and offsets");
  }
  const { values, offsets } = column;
  return Array.from({ length: column.length }, (_, row) =>
    new TextDecoder().decode(values.subarray(offsets[row], offsets[row + 1])),
  );
}

/** Spark's own spelling of each stored column of the every-type table, DESCRIBE TABLE's data_type on 4.2.0. */
function describedSpellings(): Record<string, string> {
  const capture = readSparkCapture("4.2.0", "describe-table");
  if (capture.outcome !== "pass" || !Array.isArray(capture.payload)) {
    throw new Error("describe-table is not a pass list");
  }
  const answer = capture.payload.find(
    (response) => typeof response === "object" && response !== null && "sql_command_result" in response,
  ) as { sql_command_result: { relation: { local_relation: { data: unknown } } } };
  const { columns } = readIpcColumns(captureBytes(answer.sql_command_result.relation.local_relation.data));
  const names = utf8Values(columns.find((column) => column.name === "col_name"));
  const types = utf8Values(columns.find((column) => column.name === "data_type"));
  return Object.fromEntries(names.map((name, index) => [name, types[index]]));
}

/** A captured relation step read on both paths: its `DataType` schema and its one Arrow batch. */
function relationCapture(version: SparkCaptureVersion, name: "every-type-relation" | "negative-scale-decimal") {
  const capture = readSparkCapture(version, name);
  if (capture.outcome !== "pass" || !Array.isArray(capture.payload)) throw new Error(`${name} is not a pass list`);
  const schema = capture.payload.find(
    (response) => typeof response === "object" && response !== null && (response as { schema?: unknown }).schema,
  ) as { schema: object };
  const batch = capture.payload.find(
    (response) => typeof response === "object" && response !== null && "arrow_batch" in response,
  ) as { arrow_batch: { data: unknown } };
  return {
    fromDataType: columnsFromDataType(schema.schema),
    fromArrow: columnsFromArrow(readIpcColumns(captureBytes(batch.arrow_batch.data))),
  };
}

describe("the two schemas of the relation path", () => {
  for (const version of ["4.2.0", "4.1.3"] as const satisfies readonly SparkCaptureVersion[]) {
    test(`the captured every-type schema of ${version} reads, and agrees with its Arrow batch`, () => {
      const { fromDataType, fromArrow } = relationCapture(version, "every-type-relation");
      expect(fromDataType).toHaveLength(34);
      expect(() => assertSchemasAgree(fromDataType, fromArrow)).not.toThrow();
      for (const column of fromDataType) expect(column.spelling.length).toBeGreaterThan(0);
    });

    test(`the captured every-type schema of ${version} is spelled as Spark's own DESCRIBE spells it`, () => {
      const { fromDataType } = relationCapture(version, "every-type-relation");
      // DESCRIBE spells the 32 stored columns from the table, where a char or varchar column keeps its length; a
      // result schema reports such a column as string, and the two computed columns are not stored. Every
      // struct field name in the table is bare, so DESCRIBE, which writes a field name unquoted, and this module, which
      // backticks a name Spark would quote, spell it alike.
      expect(Object.fromEntries(fromDataType.map((column) => [column.name, column.spelling]))).toStrictEqual({
        ...describedSpellings(),
        c_char: "string",
        c_varchar: "string",
        c_void: "void",
        c_calendar_interval: "interval",
      });
    });

    test(`the captured negative-scale decimal of ${version} reads alike on both paths`, () => {
      const { fromDataType, fromArrow } = relationCapture(version, "negative-scale-decimal");
      const expected: SparkColumn[] = [
        { name: "d", spelling: "decimal(1,-10)", kind: { type: "decimal", precision: 1, scale: -10 } },
      ];
      expect(fromDataType).toStrictEqual(expected);
      expect(fromArrow).toStrictEqual(expected);
    });
  }

  test("a disagreement in count or in names is refused as unreadable", () => {
    const a = columnsFromDataType(
      struct([
        ["x", t("integer")],
        ["y", t("long")],
      ]),
    );
    const b = columnsFromDataType(
      struct([
        ["x", t("integer")],
        ["z", t("long")],
      ]),
    );
    const disagree = unreadable("a result whose schema and batches name different columns");
    expect(refusalOf(() => assertSchemasAgree(a, a.slice(0, 1)))).toStrictEqual(disagree);
    expect(refusalOf(() => assertSchemasAgree(a.slice(0, 1), a))).toStrictEqual(disagree);
    expect(refusalOf(() => assertSchemasAgree(a, b))).toStrictEqual(disagree);
    expect(() =>
      assertSchemasAgree(
        a,
        fromStream([
          { name: "x", kind: "int32", values: [1] },
          { name: "y", kind: "int64", values: [BigInt(1)] },
        ]),
      ),
    ).not.toThrow();
  });

  test("a column whose Arrow type is not its declared one, at any depth, is refused as unreadable", () => {
    const int32 = (name: string): SparkIpcColumn => ({ name, kind: "int32", values: [1] });
    const binary = (name: string): SparkIpcColumn => ({ name, kind: "binary", values: [new Uint8Array(0)] });
    const structOf = (...children: SparkIpcColumn[]): SparkIpcColumn => ({
      name: "c",
      kind: "struct",
      length: 1,
      children,
    });
    const stringToInt: SparkIpcColumn = {
      name: "c",
      kind: "map",
      offsets: [0, 0],
      keys: { name: "key", kind: "utf8", values: [] },
      items: { name: "value", kind: "int32", values: [] },
    };
    const cases: readonly (readonly [object, SparkIpcColumn])[] = [
      // A scale the batch does not carry would show every value at another magnitude; a precision is held alike.
      [t("decimal", { precision: 10, scale: 2 }), { name: "c", kind: "decimal", precision: 10, scale: 0, values: [] }],
      [t("decimal", { precision: 10, scale: 2 }), { name: "c", kind: "decimal", precision: 12, scale: 2, values: [] }],
      [t("long"), int32("c")],
      [
        struct([
          ["a", t("integer")],
          ["b", t("integer")],
        ]),
        structOf(int32("a")),
      ],
      [struct([["a", t("integer")]]), structOf(int32("b"))],
      [struct([["a", t("integer")]]), structOf({ name: "a", kind: "utf8", values: ["x"] })],
      // A variant read from a struct without Spark's variant tag, and the tagged layout read where a struct is declared.
      [t("variant"), structOf(binary("value"), binary("metadata"))],
      [
        struct([
          ["value", t("binary")],
          ["metadata", t("binary")],
        ]),
        structOf(binary("value"), { ...binary("metadata"), metadata: { variant: "true" } }),
      ],
      [
        t("array", { element_type: t("integer") }),
        { name: "c", kind: "list", offsets: [0, 0], child: { name: "element", kind: "int64", values: [] } },
      ],
      [t("array", { element_type: t("integer") }), int32("c")],
      [t("map", { key_type: t("integer"), value_type: t("integer") }), stringToInt],
      [t("map", { key_type: t("string"), value_type: t("string") }), stringToInt],
    ];
    for (const [declared, batch] of cases) {
      expect(refusalOf(() => assertSchemasAgree([one(declared)], fromStream([batch])))).toStrictEqual(
        unreadable("a result whose schema and batches name different columns"),
      );
    }
  });

  // SELECT struct(a.id, b.id) AS st: the DataType keeps the names the plan gives (id, id), while Spark writes the Arrow
  // schema with errorOnDuplicatedFieldNames = false, so ArrowUtils.deduplicateFieldNames numbers a name a struct
  // repeats (id_0, id_1, in order) and keeps a name it holds once, inside an array or a map too.
  test("a struct that repeats a field name agrees with the names Spark's Arrow writer numbers, at every depth", () => {
    const fieldsOf = (names: readonly string[]) => struct(names.map((name) => [name, t("integer")] as const));
    const structOf = (name: string, names: readonly string[]): SparkIpcColumn => ({
      name,
      kind: "struct",
      length: 1,
      children: names.map((child) => ({ name: child, kind: "int32", values: [1] })),
    });
    // The struct as the column, as an array's element and as a map's value: its DataType and its batch.
    const shapes: readonly (readonly [
      (names: readonly string[]) => object,
      (names: readonly string[]) => SparkIpcColumn,
    ])[] = [
      [fieldsOf, (names) => structOf("c", names)],
      [
        (names) => t("array", { element_type: fieldsOf(names) }),
        (names) => ({ name: "c", kind: "list", offsets: [0, 1], child: structOf("element", names) }),
      ],
      [
        (names) => t("map", { key_type: t("string"), value_type: fieldsOf(names) }),
        (names) => ({
          name: "c",
          kind: "map",
          offsets: [0, 1],
          keys: { name: "key", kind: "utf8", values: ["k"] },
          items: structOf("value", names),
        }),
      ],
    ];
    for (const [dataType, batch] of shapes) {
      const compare = (declared: readonly string[], written: readonly string[]) => () =>
        assertSchemasAgree([one(dataType(declared))], fromStream([batch(written)]));
      expect(compare(["id", "id"], ["id_0", "id_1"])).not.toThrow();
      // struct<id,x,id,id_0> is written id_0, x, id_1, id_0: x and id_0 each occur once, so each keeps its name.
      expect(compare(["id", "x", "id", "id_0"], ["id_0", "x", "id_1", "id_0"])).not.toThrow();
      // The names as the DataType gives them agree too.
      expect(compare(["id", "id"], ["id", "id"])).not.toThrow();
      // A repeat numbered any other way is not Spark's writing.
      for (const written of [
        ["id_1", "id_0"],
        ["id", "id_1"],
        ["id_0", "id_0"],
        ["id_1", "id_2"],
      ]) {
        expect(refusalOf(compare(["id", "id"], written))).toStrictEqual(
          unreadable("a result whose schema and batches name different columns"),
        );
      }
    }
  });

  test("a top-level column name is compared as it is, since Spark numbers a repeated name only inside a struct", () => {
    const int32 = (name: string): SparkIpcColumn => ({ name, kind: "int32", values: [1] });
    const repeated = columnsFromDataType(
      struct([
        ["id", t("integer")],
        ["id", t("integer")],
      ]),
    );
    expect(() => assertSchemasAgree(repeated, fromStream([int32("id"), int32("id")]))).not.toThrow();
    expect(refusalOf(() => assertSchemasAgree(repeated, fromStream([int32("id_0"), int32("id_1")])))).toStrictEqual(
      unreadable("a result whose schema and batches name different columns"),
    );
  });

  test("interval fields, time precision and srid are not compared, at any depth, since Spark's two readings differ on them", () => {
    const hour = t("day_time_interval", { start_field: 1, end_field: 1 });
    const declared = columnsFromDataType(
      struct([
        ["h", hour],
        ["y", t("year_month_interval", { start_field: 0, end_field: 0 })],
        ["tm", t("time", { precision: 3 })],
        ["g", t("geometry", { srid: 4326 })],
        ["a", t("array", { element_type: struct([["h", hour]]) })],
      ]),
    );
    const arrow = fromStream([
      { name: "h", kind: "duration-us", values: [BigInt(1)] },
      { name: "y", kind: "interval-ym", values: [1] },
      { name: "tm", kind: "time64-ns", values: [BigInt(0)] },
      {
        name: "g",
        kind: "struct",
        length: 1,
        children: [
          { name: "srid", kind: "int32", values: [0] },
          { name: "wkb", kind: "binary", values: [new Uint8Array(0)], metadata: { geometry: "true", srid: "0" } },
        ],
      },
      {
        name: "a",
        kind: "list",
        offsets: [0, 1],
        child: {
          name: "element",
          kind: "struct",
          length: 1,
          children: [{ name: "h", kind: "duration-us", values: [BigInt(1)] }],
        },
      },
    ]);
    // Each column's two kinds differ, in its interval fields, its time precision or its srid, and only there.
    declared.forEach((column, index) => expect(column.kind).not.toStrictEqual(arrow[index].kind));
    expect(() => assertSchemasAgree(declared, arrow)).not.toThrow();
  });

  test("every captured relation answer of both versions agrees with each of its batches, kinds included", () => {
    // Studio refuses these batches before it reads a type (ipc-guard.ts), so no schema of theirs is compared.
    const refused: ReadonlySet<string> = new Set(["compressed-lz4", "compressed-zstd", "large-var-types-refused"]);
    const compared: string[] = [];
    for (const version of ["4.2.0", "4.1.3"] as const satisfies readonly SparkCaptureVersion[]) {
      for (const file of readdirSync(new URL(`../../../fixtures/spark/${version}/`, import.meta.url)).sort()) {
        const name = file.replace(/\.json$/, "") as SparkCaptureName;
        const capture = readSparkCapture(version, name);
        const answers: unknown[] = capture.outcome === "pass" && Array.isArray(capture.payload) ? capture.payload : [];
        const schema = answers.find(
          (response) => typeof response === "object" && response !== null && (response as { schema?: unknown }).schema,
        ) as { schema: object } | undefined;
        const batches = answers.filter(
          (response) => typeof response === "object" && response !== null && "arrow_batch" in response,
        ) as { arrow_batch: { data: unknown } }[];
        if (schema === undefined || batches.length === 0) continue;
        const declared = columnsFromDataType(schema.schema);
        for (const batch of batches) {
          const bytes = captureBytes(batch.arrow_batch.data);
          if (refused.has(name)) expect(() => readIpcColumns(bytes)).toThrow(SparkError);
          else assertSchemasAgree(declared, columnsFromArrow(readIpcColumns(bytes)));
        }
        if (!refused.has(name)) compared.push(`${version}/${name}`);
      }
    }
    expect(compared).toStrictEqual([
      "4.2.0/batch-rows",
      "4.2.0/every-type-relation",
      "4.2.0/negative-scale-decimal",
      "4.2.0/proxy-silent-timeout",
      "4.2.0/row-budget-cut",
      "4.2.0/substitution-off",
      "4.2.0/temp-view-script",
      "4.1.3/batch-rows",
      "4.1.3/every-type-relation",
      "4.1.3/negative-scale-decimal",
    ]);
  });
});
