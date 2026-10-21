/**
 * The SQL export output of every engine, rendered as text after the inline edit lines.
 *
 * Each line is one `buildResultExport` call and the file content it answered, or the
 * error it threw: today a prototype key and an unknown string throw on some paths, and
 * the golden pins that too. Every call is made with `tabName: "t"` and no `query`, so the
 * table name never comes from reading a statement.
 *
 * The lines render under `Asia/Tokyo`, the zone `tests/unit/lib/export/result-export.test.ts`
 * holds its Oracle cases at, because Oracle writes a naive `Date` from its local fields and
 * a machine's own zone would otherwise move those lines.
 *
 * `TYPED_CELLS` is every declared type and value `tests/unit/lib/export/typed-literals.test.ts`
 * hands `typedLiteral`, in that file's order with repeats dropped, plus the non-finite words
 * as text under float and non-float columns. Its two non-string declarations are left out,
 * because `columnTypes` carries strings only.
 */
import { buildResultExport, type ResultExportSource } from "@/lib/export/result-export";
import type { DatabaseType } from "@/lib/types";

/** One cell of every kind the DDL form infers a type from, and every escape edge of the INSERT form. */
export const EXPORT_ROW: Readonly<Record<string, unknown>> = Object.freeze({
  txt: "it's a\\",
  int: 42,
  num: 1.5,
  bool: true,
  ts: new Date("2026-01-27T14:30:00.123Z"),
  bin: new Uint8Array([0x01, 0x02, 0xde, 0xad, 0xbe, 0xef]),
  empty_bin: new Uint8Array([]),
  big: BigInt("9007199254740993"),
  nan: NaN,
  inf: Infinity,
  ninf: -Infinity,
  obj: { k: [1, { x: "y" }] },
  arr: [1, 2, 3],
  nul: null,
  "odd name": "Müşteri",
});

/** The same columns with no value, so the inferred types come from the first row alone. */
const NULL_ROW: Readonly<Record<string, unknown>> = Object.freeze({
  ...Object.fromEntries(Object.keys(EXPORT_ROW).map((key) => [key, null])),
  txt: undefined,
});

/**
 * Every declared name the DDL tables of `result-export.ts` read: the keys of
 * `BARE_TYPE_FAMILY`, every word of `STANDS_ALONE` and the keys of
 * `DIALECT_BARE_SPELLING`, plus spellings that reach the other branches of the completion.
 */
export const DECLARED_DDL_NAMES: readonly string[] = Object.freeze([
  "BIT",
  "DECIMAL(10, 2)",
  "NUMBER(10,2)",
  "Nullable(Int64)",
  "TIMESTAMP  WITH   TIME ZONE",
  "__proto__",
  "binary",
  "binary_double",
  "binary_float",
  "bit",
  "bit[]",
  "blob",
  "bytea",
  "char",
  "character",
  "character varying",
  "clob",
  "constructor",
  "datetime",
  "datetime2",
  "datetimeoffset",
  "decimal",
  "enum",
  "image",
  "list<list<int>>",
  "longblob",
  "longtext",
  "map<text, list<int>>",
  "mediumblob",
  "mediumtext",
  "money",
  "nchar",
  "nclob",
  "ntext",
  "number",
  "numeric",
  "nvarchar",
  "nvarchar2",
  "raw",
  "rowid",
  "set",
  "set<frozen<list<int>>>",
  "smalldatetime",
  "text",
  "time",
  "timestamp",
  "timestamp with time zone",
  "timestamp without time zone",
  "tinyblob",
  "tinytext",
  "uniqueidentifier",
  "varbinary",
  "varchar",
  "varchar2",
  "vector",
  "x; DROP TABLE t",
  "year",
]);

/** Every Snowflake VECTOR sample shape, including no value to read and one it cannot read. */
const VECTOR_SAMPLES: readonly unknown[] = [[1.5, 2], "[1,2,3]", null, { bad: 1 }];

const NON_FINITE_WORDS = ["NaN", "Infinity", "-Infinity"];
const NON_FINITE_COLUMNS = ["double precision", "REAL", "float8", "BINARY_DOUBLE", "Nullable(Float64)", "text"];

export const TYPED_CELLS: ReadonlyArray<readonly [declared: string | undefined, value: unknown]> = [
  ["integer[]", null],
  ["integer[]", undefined],
  ["integer[]", [1]],
  ["interval", { days: 1, weeks: 2 }],
  ["interval", { days: "1" }],
  ["point", { x: 1, y: "2" }],
  ["circle", { x: 1, y: 2 }],
  ["box", { x: 1, y: 2 }],
  ["interval", "1 day"],
  ["interval[]", [{ weeks: 1 }, 1.5]],
  ["jsonb[]", ["hello", 1, null]],
  ["  INTEGER[] ", [1]],
  [undefined, "1"],
  ["bigint", "x"],
  ["varbinary", "not base64!"],
  ["boolean", true],
  ["json", { a: 1 }],
  ["double", "NaN"],
  ["double", -Infinity],
  ["real", "Infinity"],
  ["array(double)", ["NaN", 1.5]],
  ["varchar", "NaN"],
  ["row(integer, timestamp(3) with time zone)", [1, "2024-01-01 00:00:00.000 UTC"]],
  ["row(double precision)", [1.5]],
  ["row(integer, varchar)", [1, "x"]],
  ['row("a b" integer, c varchar)', [1, "x"]],
  ["row(a integer, b varchar)", [1]],
  ["row(a integer)", {}],
  ["array(integer)", "x"],
  ["map(varchar, integer)", []],
  [undefined, [1]],
  ["INTEGER[]", "1"],
  ["BLOB", { type: "Buffer", data: [1] }],
  ["JSON", { a: 1 }],
  ["DECIMAL(9,2)[]", ["1", 2.5, "x"]],
  ["INTERVAL", { months: 0, days: 0, micros: 5 }],
  ["INTERVAL", { months: 1, days: 2 }],
  ["INTERVAL", { months: 1.5, days: 0, micros: "0" }],
  ["INTERVAL", { months: 1, days: 0, micros: "1.5" }],
  ["INTERVAL", { months: 1, days: 0, micros: "x" }],
  ["STRUCT(a INTEGER)", { a: 1 }],
  ['STRUCT("a""b" INTEGER)', { 'a"b': 1 }],
  ["STRUCT(a INTEGER)", { b: 1 }],
  ["STRUCT(INTEGER)", { a: 1 }],
  ["INTEGER[]", { a: 1 }],
  ["MAP(VARCHAR, INTEGER)", { k: 1 }],
  ["MAP(VARCHAR, INTEGER)", [1]],
  ["list<int>", [1, null]],
  ["frozen<vector<float, 2>>", [1.5, 2]],
  ["uuid", "x"],
  ["duration", "1 day"],
  ["text", "x"],
  ["float", Infinity],
  ["list<double>", ["-Infinity", 1.5]],
  ["text", "NaN"],
  ["duration", "0s"],
  ["list<int>", "x"],
  ["map<int, int>", [1]],
  ["tuple<int>", {}],
  [undefined, true],
  ["bit", false],
  ["bit", 1],
  ["datetime", "2026-10-04 12:34:56.123"],
  ["smalldatetime", "2026-10-04 12:35:00"],
  [" SmallDateTime ", "2026-10-04 12:35:00"],
  ["datetime2", "2026-10-04 12:34:56.123"],
  [undefined, "2026-10-04 12:34:56.123"],
  ["datetime", "2026-10-04T12:34:56.123Z"],
  ["datetime", "2026-10-04 12:34:56.1234567"],
  ["smalldatetime", "2026-10-04 12:34"],
  ["datetime", "x 2026-10-04 12:34:56"],
  ["datetime", new Date("1970-01-01T00:00:00.000Z")],
  ["Array(String)", "x"],
  ["Array(UInt8)", { type: "Buffer", data: [1] }],
  ["Nullable(Array(LowCardinality(String)))", ["a"]],
  ["Array(Array(Int32))", ["x"]],
  ["Map(String, Array(Int32))", { a: "x" }],
  ["Array(Map(String, Int32))", ["x"]],
  ["Array(Tuple(Int32, Int32))", [[1, 2, 3]]],
  ["Array(Tuple(a Int32, b Int32))", [{ a: 1 }]],
  ["Array(Tuple(Int32))", [{ a: 1 }]],
  ["Map(String, Tuple(Int32, DateTime64(3, 'Europe/Istanbul')))", { k: [1, "2024-01-01 00:00:00.000"] }],
  ["Array(Enum8('a,b' = 1))", ["a"]],
  ["Array(Float64)", ["NaN", "Infinity", "-Infinity", "1.5"]],
  ["Array(String)", ["NaN"]],
  ["Array(Float32)", ["constructor"]],
  ["Float64", "Infinity"],
  ["Nullable(Float32)", "-Infinity"],
  ["LowCardinality(Nullable(Float64))", "NaN"],
  ["BFloat16", -Infinity],
  ["Float64", 1.5],
  ["String", "Infinity"],
  ["Float64", "inf"],
  ["Array(Decimal(9, 2))", ["1.5", "x"]],
  ["Array(String)", ["1"]],
  ["Binary", "616263"],
  ["Nullable(Binary)", "00FF10"],
  ["Binary", ""],
  ["Binary", "abc"],
  ["Binary", "x'; DROP"],
  ["Binary", new Uint8Array([1, 2])],
  ["Variant", '{"a":1,"b":[1,2,"x"]}'],
  ["Nullable(Variant)", '"it\'s"'],
  ["Variant", { k: [1, null] }],
  ["Bitmap", "<bitmap binary>"],
  ["Map(String, Int32)", '{"k1":1}'],
  ["Tuple(Int32, String)", '(1,"a")'],
  ["Nullable(Array(Int32 NULL))", "[1,NULL]"],
  ["Interval", "1 day 2:03:00"],
  ["Map(String, Int32)", "x"],
  ["Mystery\nSELECT 2 AS injected;\r\n--\f \u0000end", "x"],
  ["Geeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "x"],
  ["Geeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "x"],
  ["Bitmap", "x"],
  ["Int64", "-9223372036854775808"],
  ["Nullable(UInt64)", "18446744073709551615"],
  ["Nullable(Decimal(10, 2))", "12345678.90"],
  ["Float64", "1e+308"],
  ["Int32", 7],
  ["Int32", "seven"],
  ["Float32", "NaN"],
  ["Nullable(Float64)", "-Infinity"],
  ["Boolean", "1"],
  ["Nullable(Boolean)", "0"],
  ["Boolean", true],
  ["Boolean", "yes"],
  ["String", "2026-10-07 12:34:56.789012"],
  ["Nullable(String)", "2026-10-07 12:34:56.789012"],
  ["Date", "2026-10-07 12:34:56.789012"],
  ["Timestamp", "2026-10-07 12:34:56.789012"],
  ["Nullable(Timestamp_Tz)", "2026-10-07 12:34:56.789012"],
  [undefined, "616263"],
  ["VARIANT", '{"a":1}'],
  ["OBJECT", { k: [1, null] }],
  ["array", "[1,2]"],
  ["MAP", '{"a":1}'],
  ["VECTOR(FLOAT, 2)", "[1,2]"],
  ["ARRAY(NUMBER(38,0))", "[1,2]"],
  ["VARIANT", '"it\'s\\"'],
  ["VECTOR", "[1.500000,2.000000,-3.000000]"],
  ["VECTOR", "[1,-2]"],
  ["vector", "[1, 2e3]"],
  ["VECTOR", "[1,NaN]"],
  ["VECTOR", [4, 5, 6]],
  ["VECTOR", "[]"],
  ["VECTOR", '["a"]'],
  ["VECTOR", "[1,,2]"],
  ["VECTOR", "1,2"],
  ["ARRAY(INT)'; DROP TABLE t; --", "[1]"],
  ["DATE", "0001-01-01"],
  ["TIME(0)", "13:45:30"],
  ["TIME(1)", "13:45:30.5"],
  ["TIMESTAMP_NTZ(0)", "2026-10-12 01:02:03"],
  ["TIMESTAMP_LTZ(6)", "2026-10-12 01:02:03.123456+00:00"],
  ["TIMESTAMP_TZ(0)", "2026-10-12 01:02:03-05:30"],
  ["DATE", "10000-01-01"],
  ["TIMESTAMP_NTZ(1)", "252026-03-04 05:06:07.5"],
  ["TIMESTAMP_LTZ(0)", "10000-01-01 01:02:03+00:00"],
  ["TIMESTAMP_TZ(0)", "10000-01-01 01:02:03-07:00"],
  ["DATE", "0000-02-29"],
  ["DATE", "-0002-06-01"],
  ["DATE", "-0400-02-29"],
  ["DATE", "-10000-12-31"],
  ["TIMESTAMP_NTZ(9)", "-0002-06-01 12:34:56.876543211"],
  ["TIMESTAMP_TZ(0)", "-0401-03-01 23:59:59-07:00"],
  ["TIMESTAMP_LTZ(3)", "-0002-06-01 12:34:56.123+00:00"],
  ["DATE", "12/10/2026"],
  ["TIMESTAMP_NTZ(3)", new Date("1970-01-01T00:00:00.000Z")],
  ["TIMESTAMP_TZ(0)", "2026-10-12 01:02:03"],
  ["DATE", "999-01-01"],
  ["DATE", "--0002-06-01"],
  ["DECFLOAT", "1.23e40"],
  ["DECFLOAT", "-4.2e-5432"],
  ["DECFLOAT", "1e16384"],
  ["DECFLOAT", "0.1"],
  ["DECFLOAT", "x"],
  ["NUMBER(10,2)", "12.50"],
  ["NUMBER(38,0)", "123456789012345678901234567890"],
  ["DECFLOAT", "-1.5e-300"],
  ["NUMBER(10,2)", "x"],
  ["NUMBER(38,0)", 7],
  ["FLOAT", 1.5],
  ["VARCHAR(10)", "a"],
  ["BOOLEAN", true],
  ["BINARY", new Uint8Array([1])],
  ["GEOGRAPHY", "POINT(1 2)"],
  [undefined, "x"],
  ["date", "2026-10-12"],
  ["date", "0001-01-01"],
  ["timestamp", "2026-10-12 13:45:30.123456+00:00"],
  ["timestamp_ntz", "2026-10-12 13:45:30"],
  ["time(6)", "13:45:30.5"],
  ["date", "12/10/2026"],
  ["timestamp", "2026-10-12 13:45:30"],
  ["timestamp_ntz", "x'; DROP TABLE t; --"],
  ["decimal(10,2)", "12345678.91"],
  ["decimal(3,2)", "-0.50"],
  ["decimal(1,-10)", "10000000000"],
  ["bigint", "9007199254740993"],
  ["bigint", 42],
  ["double", 1.5],
  ["decimal(10,2)", "1e3"],
  ["bigint", "12 345"],
  ["interval", "x"],
  ["interval year to month", "x"],
  ["geometry(4326)", "POINT (1 2)"],
  ["map<int,string>", { "1": "a" }],
  ["interval year to month", "INTERVAL '3-7' YEAR TO MONTH"],
  ["interval day to second", "INTERVAL '-1 02:03:04.567891' DAY TO SECOND"],
  ["interval hour", "INTERVAL '26' HOUR"],
  ["interval day", "INTERVAL '1' DAY; DROP"],
  ["interval", "3 months 2 days 1 microseconds"],
  ["variant", '{"a":"it\'s"}'],
  ["array<int>", [1, null, 3]],
  ["map<string,string>", { k: "v\\" }],
  ["struct<`it's`:int>", { "it's": 1 }],
  ["array<bigint>", [1, "9007199254740993"]],
  ["array<binary>", ["\\x0102"]],
  ["map<string,binary>", { k: "\\x01" }],
  ["struct<b:binary,n:int>", { b: "\\x01", n: 1 }],
  ["array<variant>", ['{"a":1}']],
  ["ARRAY<ARRAY<STRUCT<v: VARIANT>>>", [[{ v: "1" }]]],
  ["struct<g:geometry(4326)>", { g: "SRID=4326;POINT (1 2)" }],
  ["array<geography(4326)>", ["SRID=4326;POINT (1 2)"]],
  ["struct<variant:int,binary:string>", { variant: 1, binary: "x" }],
  ["struct<`a:binary`:int>", { "a:binary": 1 }],
  ["struct<m:map<array<int>,int>>", { m: [[[1], 2]] }],
  ["map<string collate UTF8_LCASE,int>", { k: 1 }],
  ["struct<map:map<string,int>>", { map: { k: 1 } }],
  ["struct<a:char(5)>", { a: "x" }],
  ["array<varchar(5)>", ["x"]],
  ["map<array<int>,string>", [[[1], "v"]]],
  ["geometry(4326)", "SRID=4326;POINT (1 2)"],
  ["geography(4326)", "SRID=4326;POINT (1 2)"],
  ["variant", 1],
  ["string", "x"],
  ["char(5)", "ab   "],
  ["binary", Buffer.from([1, 2])],
  [undefined, "2026-10-12"],
  ...NON_FINITE_COLUMNS.flatMap((declared) => NON_FINITE_WORDS.map((word) => [declared, word] as const)),
];

const ORACLE_DATE_COLUMNS = [
  "DATE",
  "TIMESTAMP(6)",
  "TIMESTAMP(6) WITH TIME ZONE",
  "TIMESTAMP WITH LOCAL TIME ZONE",
  "VARCHAR2(20)",
  undefined,
];
const ORACLE_DATE_VALUES: readonly unknown[] = [
  new Date("2026-08-24T07:11:12.345Z"),
  new Date("-000044-03-15T12:00:00.000Z"),
  "2026-08-24 10:11:12",
  "2026-08-24 10:11:12.5",
  "-0044-03-15 12:00:00",
  "2026-08-24T07:11:12.345Z",
  "not a date",
];

/** Every arm of Oracle's date and timestamp literal, a `Date` and a text under each column shape. */
export const ORACLE_DATE_CELLS: ReadonlyArray<readonly [declared: string | undefined, value: unknown]> =
  ORACLE_DATE_VALUES.flatMap((value) => ORACLE_DATE_COLUMNS.map((declared) => [declared, value] as const));

/** The declarations whose CSV cells are numeric for one engine's wrapper and not for another's. */
const CSV_COLUMN_TYPES: Record<string, string> = {
  nf: "Nullable(Float64)",
  lc: "LowCardinality(Nullable(Decimal(10, 2)))",
  df: "decfloat",
  nm: "numeric(10, 2)",
  bd: "binary_double",
  tx: "text",
};
const CSV_FIELDS = [...Object.keys(CSV_COLUMN_TYPES), "none"];

/** A value spelled so a `Date`, bytes, a bigint and the non-JSON numbers stay distinct. */
function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value instanceof Date) return `Date(${Number.isNaN(value.getTime()) ? "invalid" : value.toISOString()})`;
  if (value instanceof Uint8Array) return `bytes(${Buffer.from(value).toString("hex")})`;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return JSON.stringify(value);
}

function typed(declared: string | undefined): Pick<ResultExportSource, "columnTypes"> {
  return declared === undefined ? {} : { columnTypes: { c: declared } };
}

export function renderExportGolden(type: string | undefined): string {
  const dialect = type as DatabaseType | undefined;
  const lines: string[] = [];
  const line = (call: string, build: () => string) => {
    let result: string;
    try {
      result = JSON.stringify(build());
    } catch (error) {
      result = `throws ${(error as Error).name}: ${(error as Error).message}`;
    }
    lines.push(`${call} => ${result}`);
  };
  const exported = (
    format: "sql-insert" | "sql-ddl" | "csv",
    source: Omit<ResultExportSource, "dialect" | "tabName">,
  ) => buildResultExport(format, { ...source, dialect, tabName: "t" }).content;

  const runnerZone = process.env.TZ;
  process.env.TZ = "Asia/Tokyo";
  try {
    const inferred = { rows: [EXPORT_ROW, NULL_ROW], fields: Object.keys(EXPORT_ROW) };
    line("insert(inferred)", () => exported("sql-insert", inferred));
    line("ddl(inferred)", () => exported("sql-ddl", inferred));
    for (const name of DECLARED_DDL_NAMES) {
      line(`ddl(${describe(name)})`, () =>
        exported("sql-ddl", { rows: [{ c: "v" }], fields: ["c"], columnTypes: { c: name } }),
      );
    }
    for (const sample of VECTOR_SAMPLES) {
      line(`ddlSample("VECTOR", ${describe(sample)})`, () =>
        exported("sql-ddl", { rows: [{ c: sample }], fields: ["c"], columnTypes: { c: "VECTOR" } }),
      );
    }
    for (const [declared, value] of [...TYPED_CELLS, ...ORACLE_DATE_CELLS]) {
      line(`insert(${describe(declared)}, ${describe(value)})`, () =>
        exported("sql-insert", { rows: [{ c: value }], fields: ["c"], ...typed(declared) }),
      );
    }
    const csvRows = ["-Infinity", "=1+1"].map((cell) => Object.fromEntries(CSV_FIELDS.map((field) => [field, cell])));
    line("csv(numeric)", () => exported("csv", { rows: csvRows, fields: CSV_FIELDS, columnTypes: CSV_COLUMN_TYPES }));
  } finally {
    if (runnerZone === undefined) delete process.env.TZ;
    else process.env.TZ = runnerZone;
  }
  return lines.join("\n");
}
