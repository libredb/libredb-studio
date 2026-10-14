import type { DatabaseType } from "@/lib/types";
import { quoteIdentifier } from "@/lib/sql/identifier";
import { quoteLiteral } from "@/lib/sql/values";
import { asBytes, binaryText } from "./binary";
import { isNonFiniteWord, nonFiniteWord, type NonFiniteWord } from "@/lib/non-finite";
import { jsonText } from "./json";

/**
 * The cells of an exported INSERT that need their column's DECLARED type to be written
 * back as something the engine takes (#1386).
 *
 * The plain value writer in `result-export.ts` has one form per JavaScript type, and a
 * result reaches the export after a trip through JSON: a Postgres `integer[]` is a JS
 * array, an `interval` is an object of named parts and a ClickHouse `Map` is an object.
 * Written in that generic form, each was refused on replay (measured 2026-10-03/04):
 * PostgreSQL 18.6 `malformed array literal` for `'[1,2,3]'`, ClickHouse `Cannot parse
 * quoted string` for `'{"k":1}'` into a `Map`, and SQL Server `Msg 207 Invalid column name
 * 'true'` for a BIT, which takes the whole batch with it.
 *
 * The SAME value is legitimately something else under another declaration, which is why
 * nothing here looks at the value alone: a JS array in a `jsonb` column is JSON and stays
 * the quoted JSON text, and only an array in a column declared `integer[]` is a Postgres
 * array. A dialect without a row below, or a cell this module has no form for, answers
 * `undefined` and is written by the generic writer exactly as before.
 */

/** The generic writer, for a scalar inside a composite value. */
export type ScalarLiteral = (value: unknown) => string;

/**
 * A cell the dialect has no literal for: a composite whose value does not have the shape
 * its declared type says (a tuple of the wrong length, a scalar where a list belongs).
 * Thrown rather than written in the generic form, because that form is exactly what the
 * engine refuses on replay, and one refused statement stops the whole file; the caller
 * skips the row with a comment instead.
 */
export class UnwritableValue extends Error {}

type TypedWriter = (value: unknown, declared: string | undefined, scalar: ScalarLiteral) => string | undefined;

/** A plain object: what JSON makes of a record, and not an array or a byte container. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && asBytes(value) === undefined;
}

/** A declared type with its case and inner runs of spaces normalized, since both are engine output. */
function normalized(declared: string | undefined): string {
  return declared?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

// ---------------------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------------------

/**
 * The parts `pg` (through `postgres-interval`) splits an interval into, each of which is
 * also a unit PostgreSQL's interval input reads: measured on 18.6, `'-1 years -2 months 3
 * days -1 seconds -500 milliseconds'::interval` answers `-1 years -2 mons +3 days
 * -00:00:01.5`, and a fractional `1.5 milliseconds` keeps its microseconds.
 */
const INTERVAL_PARTS = ["years", "months", "days", "hours", "minutes", "seconds", "milliseconds"] as const;

/**
 * An interval object as PostgreSQL interval text, or `undefined` when it is not one.
 *
 * JSON drops a zero part, so a zero interval arrives as `{}` and is `0 seconds`. Anything
 * with a key outside the parts, or a part that is not a finite number, is not an interval
 * this module recognizes and falls back to the generic writer.
 */
function pgIntervalText(value: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const [key, amount] of Object.entries(value)) {
    if (!(INTERVAL_PARTS as readonly string[]).includes(key)) return undefined;
    if (typeof amount !== "number" || !Number.isFinite(amount)) return undefined;
    parts.push(`${amount} ${key}`);
  }
  return parts.length === 0 ? "0 seconds" : parts.join(" ");
}

/** A finite number, which is all a geometric coordinate can be. */
function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The two geometric types `pg` parses into objects, `point` as `{x, y}` and `circle` as
 * `{x, y, radius}`, back in their input syntax. The other geometric types arrive as the
 * engine's own text and need nothing.
 */
function pgGeometryText(value: Record<string, unknown>, base: string): string | undefined {
  const { x, y, radius } = value;
  if (!isCoordinate(x) || !isCoordinate(y)) return undefined;
  if (base === "point") return `(${x},${y})`;
  return base === "circle" && isCoordinate(radius) ? `<(${x},${y}),${radius}>` : undefined;
}

/** A Postgres value in the text form its type's input function reads, for an array element. */
function pgElementText(value: unknown, base: string): string {
  if (typeof value === "string") return value;
  const bytes = asBytes(value);
  if (bytes !== undefined) return binaryText(bytes);
  if (isRecord(value)) {
    const text = base === "interval" ? pgIntervalText(value) : pgGeometryText(value, base);
    if (text !== undefined) return text;
  }
  // A number, a boolean, a JSON document: `jsonText` spells each the way its type reads it
  // (`true`, `1.5`, `{"a":1}`), and it does not throw on a bigint or a cycle.
  return jsonText(value);
}

/**
 * A JS array as the body of a Postgres array literal, `{...}`.
 *
 * Every element is double-quoted with `"` and `\` backslash-escaped, which is the one
 * element form every element type's input accepts, including text that holds a comma, a
 * brace or the word `NULL`; a SQL NULL is the bare `NULL`. A nested JS array is a further
 * dimension (`pg` reports `integer[]` for every dimension count), except for a JSON
 * element type, whose element may itself be a JSON array.
 *
 * A JSON element is written as JSON whatever it holds, a string included: `pg` runs every
 * `json[]`/`jsonb[]` element through `JSON.parse`, so the document `"hello"` arrives as the
 * JS string `hello`, and writing that raw would replay as invalid JSON.
 */
function pgArrayText(values: readonly unknown[], base: string): string {
  const json = base === "json" || base === "jsonb";
  const elements = values.map((element) => {
    if (element === null || element === undefined) return "NULL";
    if (Array.isArray(element) && !json) return pgArrayText(element, base);
    const text = json ? jsonText(element) : pgElementText(element, base);
    return `"${text.replace(/[\\"]/g, "\\$&")}"`;
  });
  return `{${elements.join(",")}}`;
}

/**
 * Measured on PostgreSQL 18.6: the `'{...}'` literal replays into `integer[]`, `text[]`,
 * `boolean[]`, `jsonb[]`, `timestamp with time zone[]` and a two-dimensional `integer[]`,
 * and Materialize 26.44.1 takes it where it refused `'[1,2,3]'` with `Specifying array
 * lower bounds is not supported`. It is untyped text, so the column's own type decides the
 * element type, which `ARRAY[...]` would not: an empty `ARRAY[]` needs a cast to parse.
 */
const postgresLiteral: TypedWriter = (value, declared) => {
  const type = normalized(declared);
  if (type.endsWith("[]") && Array.isArray(value)) {
    return quoteLiteral(pgArrayText(value, type.replace(/(\[\])+$/, "")), "postgres");
  }
  if (!isRecord(value)) return undefined;
  const text = type === "interval" ? pgIntervalText(value) : pgGeometryText(value, type);
  return text === undefined ? undefined : quoteLiteral(text, "postgres");
};

// ---------------------------------------------------------------------------------------
// SQL Server
// ---------------------------------------------------------------------------------------

/**
 * The text the provider reads a `datetime` and a `smalldatetime` as (#1452): the engine's own.
 * The inline grid edit (`use-inline-editing.ts`) binds it with a `T` for the same reason the
 * export below writes it with one.
 */
export const MSSQL_DATETIME_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,3})?$/;

/**
 * T-SQL has no boolean literal: `true` parses as a column name (`Msg 207: Invalid column
 * name 'true'`, measured on SQL Server 2025 17.0.5005.3) and fails the whole batch. A BIT
 * takes `1` and `0`, and `mssql` hands a BIT back as a JS boolean.
 *
 * A `datetime` or `smalldatetime` cell is the engine's own `yyyy-mm-dd hh:mi:ss[.mmm]` text
 * (#1452), and unlike `datetime2` and `date`, those two types read that form through the
 * session's DATEFORMAT. Measured on SQL Server 2022 CU27 (16.0.4295.3): under `british`,
 * `Deutsch` and `Français` (dmy) `'2026-10-04 12:34:56.123'` is stored as April 10th and
 * `'2026-10-25 …'` is refused, while `'2026-10-04T12:34:56.123'` is October 4th under those
 * and under `us_english` and `Japanese`. So the text goes out with its space as a `T`.
 */
const mssqlLiteral: TypedWriter = (value, declared) => {
  if (typeof value === "boolean") return value ? "1" : "0";
  const type = normalized(declared);
  if (
    (type === "datetime" || type === "smalldatetime") &&
    typeof value === "string" &&
    MSSQL_DATETIME_TEXT.test(value)
  ) {
    return quoteLiteral(value.replace(" ", "T"), "mssql");
  }
  return undefined;
};

// ---------------------------------------------------------------------------------------
// ClickHouse
// ---------------------------------------------------------------------------------------

/** A ClickHouse type split into its name and its top-level arguments: `Map(String, Int32)`. */
interface ClickHouseType {
  name: string;
  args: string[];
}

/**
 * The top-level comma-separated arguments of a type's argument list, with single- and
 * double-quoted runs and `()`/`<>` nesting respected (`Enum8('a,b' = 1)`, `STRUCT("a,b"
 * INTEGER)`, `map<int, set<text>>`).
 */
function splitArguments(text: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "(" || char === "<") depth++;
    else if (char === ")" || char === ">") depth--;
    else if (char === "," && depth === 0) {
      args.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  args.push(text.slice(start).trim());
  return args;
}

/** `Name(args)` or `name<args>`, split into its name and its top-level arguments. */
function parseTypeCall(declared: string, open = "(", close = ")"): ClickHouseType {
  const text = declared.trim();
  const at = text.indexOf(open);
  if (at <= 0 || !text.endsWith(close) || !/^[A-Za-z0-9_ ]+$/.test(text.slice(0, at))) return { name: text, args: [] };
  return { name: text.slice(0, at).trim(), args: splitArguments(text.slice(at + 1, -1)) };
}

function parseClickHouseType(declared: string): ClickHouseType {
  return parseTypeCall(declared);
}

/** `Nullable(T)` and `LowCardinality(T)` change nothing about how a `T` is spelled. */
function unwrapClickHouseType(declared: string): ClickHouseType {
  let type = parseClickHouseType(declared);
  while ((type.name === "Nullable" || type.name === "LowCardinality") && type.args.length === 1) {
    type = parseClickHouseType(type.args[0]);
  }
  return type;
}

/** One `Tuple` element: `a Int32` in a named tuple, `Int32` in an unnamed one. */
function tupleElement(arg: string): { name?: string; type: string } {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+(\S.*)$/.exec(arg);
  return match === null ? { type: arg } : { name: match[1], type: match[2] };
}

const CLICKHOUSE_NUMBER = /^(U?Int\d+|Float\d+|Decimal\d*|BFloat16)$/;
const NUMERIC_TEXT = /^-?\d+(\.\d+)?$/;

/**
 * The words a non-finite float travels as (`src/lib/non-finite.ts`), and ClickHouse's own
 * bare spellings, which a `Float` element reads back where the quoted word is a `String`.
 */
const CLICKHOUSE_NON_FINITE: Readonly<Record<string, string>> = { NaN: "nan", Infinity: "inf", "-Infinity": "-inf" };
const CLICKHOUSE_FLOAT = /^(Float\d+|BFloat16)$/;

/**
 * A value inside a ClickHouse composite, by its element type.
 *
 * A 64-bit or wider integer and a decimal arrive as a JSON string (ClickHouse quotes them
 * so JavaScript cannot round them), and a map key always does; under a numeric element
 * type those are written bare, since the quoted form is a `String` that the container's
 * element type would have to be cast from.
 */
function clickHouseValue(value: unknown, declared: string, scalar: ScalarLiteral): string {
  if (value === null || value === undefined) return "NULL";
  const type = unwrapClickHouseType(declared);
  if (type.name === "Array" && type.args.length === 1 && Array.isArray(value)) {
    return `[${value.map((element) => clickHouseValue(element, type.args[0], scalar)).join(", ")}]`;
  }
  if (type.name === "Map" && type.args.length === 2 && isRecord(value)) {
    const [keyType, valueType] = type.args;
    const entries = Object.entries(value).flatMap(([key, entry]) => [
      clickHouseValue(key, keyType, scalar),
      clickHouseValue(entry, valueType, scalar),
    ]);
    return `map(${entries.join(", ")})`;
  }
  if (type.name === "Tuple") {
    const elements = type.args.map(tupleElement);
    // An unnamed tuple arrives as a JSON array; a named one as an object keyed by its
    // element names, which are read back in the DECLARED order rather than the key order.
    const items = Array.isArray(value)
      ? value
      : isRecord(value) && elements.every((element) => element.name !== undefined && Object.hasOwn(value, element.name))
        ? elements.map((element) => value[element.name as string])
        : undefined;
    if (items !== undefined && items.length === elements.length) {
      return `tuple(${items.map((item, index) => clickHouseValue(item, elements[index].type, scalar)).join(", ")})`;
    }
    throw new UnwritableValue("a Tuple that does not have its declared elements");
  }
  if ((type.name === "Array" || type.name === "Map") && type.args.length > 0) {
    throw new UnwritableValue(`a ${type.name} that does not have its declared shape`);
  }
  if (CLICKHOUSE_NUMBER.test(type.name) && typeof value === "string" && NUMERIC_TEXT.test(value)) return value;
  if (CLICKHOUSE_FLOAT.test(type.name) && typeof value === "string" && Object.hasOwn(CLICKHOUSE_NON_FINITE, value)) {
    return CLICKHOUSE_NON_FINITE[value];
  }
  return scalar(value);
}

/**
 * Measured on ClickHouse 26.9: an `Array`, a `Map` or a `Tuple` written as quoted JSON is
 * `Code: 26 ... Cannot parse quoted string`, while `[...]`, `map(...)` and `tuple(...)`
 * replay, nested and empty (`map()`, `tuple(0, [])`) included. A scalar column is left to
 * the generic writer, which ClickHouse already reads (a quoted `UInt64` included).
 */
const clickhouseLiteral: TypedWriter = (value, declared, scalar) => {
  if (declared === undefined || value === null || typeof value !== "object" || asBytes(value) !== undefined) {
    return undefined;
  }
  const name = unwrapClickHouseType(declared).name;
  if (name !== "Array" && name !== "Map" && name !== "Tuple") return undefined;
  return clickHouseValue(value, declared, scalar);
};

// ---------------------------------------------------------------------------------------
// Shared by the three typed-literal grammars below
// ---------------------------------------------------------------------------------------

/** A number, or the text of one (how a JSON result keeps a wide integer's digits), written bare. */
function bareNumber(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && NUMERIC_TEXT.test(value) ? value : undefined;
}

/**
 * NaN or an infinity, as the word it travels as (`src/lib/non-finite.ts`): a number from a
 * host that built its rows itself, or the word a result carried through JSON.
 */
function floatWord(value: unknown): NonFiniteWord | undefined {
  if (typeof value === "number") return nonFiniteWord(value);
  return isNonFiniteWord(value) ? value : undefined;
}

/**
 * The type names with a space in them that a Trino `row(...)` field can be WITHOUT a field
 * name, so `timestamp(3) with time zone` is not read as a field `timestamp(3)` of type
 * `with time zone`.
 */
const MULTI_WORD_TYPE =
  /^((timestamp|time)(\(\d+\))? with(out)? time zone|double precision|interval (day to second|year to month))$/i;

/** A `name type` field of a Trino `row(...)` or a DuckDB `STRUCT(...)`, its name unquoted. */
function namedField(arg: string): { name: string; type: string } | undefined {
  if (MULTI_WORD_TYPE.test(arg.trim())) return undefined;
  const match = /^("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*)\s+(\S.*)$/.exec(arg);
  if (match === null) return undefined;
  const name = match[1].startsWith('"') ? match[1].slice(1, -1).replace(/""/g, '"') : match[1];
  return { name, type: match[2] };
}

// ---------------------------------------------------------------------------------------
// Trino
// ---------------------------------------------------------------------------------------

/** The Trino types that read a bare number, the wide integers included. */
const TRINO_BARE_NUMBER = /^(tinyint|smallint|integer|int|bigint|double)$/;

/**
 * The Trino types written as `<KEYWORD> '<text>'`, the type-prefixed literal Trino reads for
 * each. A quoted string alone is a `varchar`, and INSERT does not coerce a `varchar` into any
 * of these. The keyword comes from this table, never from the declared text.
 */
const TRINO_KEYWORD: ReadonlyArray<readonly [RegExp, string]> = [
  [/^decimal(\(.*\))?$/, "DECIMAL"],
  [/^real$/, "REAL"],
  [/^date$/, "DATE"],
  [/^timestamp(\(\d+\))?( with time zone)?$/, "TIMESTAMP"],
  [/^time(\(\d+\))?( with time zone)?$/, "TIME"],
  [/^json$/, "JSON"],
  [/^uuid$/, "UUID"],
  [/^ipaddress$/, "IPADDRESS"],
];

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * A value as Trino writes it back, recursing through `array`, `map` and `row`.
 *
 * Trino's JSON wire format answers a `varbinary` as base64, a `row` as a JSON array, a `map`
 * as an object and a `json` column as its text, and those are the shapes read here.
 */
function trinoValue(value: unknown, declared: string, scalar: ScalarLiteral): string {
  if (value === null || value === undefined) return "NULL";
  const type = parseTypeCall(declared);
  const name = type.name.toLowerCase();
  if (name === "array" && type.args.length === 1) {
    if (!Array.isArray(value)) throw new UnwritableValue("an array that is not a list");
    return `ARRAY[${value.map((element) => trinoValue(element, type.args[0], scalar)).join(", ")}]`;
  }
  if (name === "map" && type.args.length === 2) {
    if (!isRecord(value)) throw new UnwritableValue("a map that is not an object");
    const entries = Object.entries(value);
    if (entries.length === 0) return "MAP()";
    const keys = entries.map(([key]) => trinoValue(key, type.args[0], scalar));
    const values = entries.map(([, entry]) => trinoValue(entry, type.args[1], scalar));
    return `MAP(ARRAY[${keys.join(", ")}], ARRAY[${values.join(", ")}])`;
  }
  if (name === "row" && type.args.length > 0) {
    // Measured on Trino 483: `ROW(7, 'x')` goes into a `row(a integer, b varchar)` column by position.
    if (!Array.isArray(value) || value.length !== type.args.length) {
      throw new UnwritableValue("a row that does not have its declared fields");
    }
    const fields = type.args.map((arg) => namedField(arg)?.type ?? arg);
    return `ROW(${value.map((field, index) => trinoValue(field, fields[index], scalar)).join(", ")})`;
  }
  const lower = normalized(declared);
  // Measured on Trino 483: `DOUBLE 'NaN'`, `DOUBLE 'Infinity'` and `DOUBLE '-Infinity'` replay
  // into a `double` column, and `REAL 'NaN'` into a `real` one, where the quoted word alone is
  // a `varchar` the INSERT refuses.
  const word = lower === "double" || lower === "real" ? floatWord(value) : undefined;
  if (word !== undefined) return `${lower.toUpperCase()} '${word}'`;
  if (TRINO_BARE_NUMBER.test(lower)) return bareNumber(value) ?? scalar(value);
  if (lower === "varbinary" && typeof value === "string" && BASE64.test(value)) {
    return `X'${Buffer.from(value, "base64").toString("hex")}'`;
  }
  const keyword = TRINO_KEYWORD.find(([pattern]) => pattern.test(lower))?.[1];
  if (keyword === undefined) return scalar(value);
  return `${keyword} ${quoteLiteral(typeof value === "string" ? value : jsonText(value), "trino")}`;
}

/**
 * Trino's INSERT coerces almost nothing from a quoted string: measured on 483, a `bigint`,
 * `decimal`, `date`, `timestamp`, `json`, `array`, `map`, `uuid`, `varbinary` and `row`
 * each answered `Insert query has mismatched column types`. So every declared cell is
 * written by its type.
 */
const trinoLiteral: TypedWriter = (value, declared, scalar) =>
  declared === undefined ? undefined : trinoValue(value, declared, scalar);

// ---------------------------------------------------------------------------------------
// DuckDB
// ---------------------------------------------------------------------------------------

/** The DuckDB integer, float and decimal types, every one of which reads a bare number. */
const DUCKDB_NUMBER =
  /^(tinyint|smallint|integer|bigint|hugeint|utinyint|usmallint|uinteger|ubigint|uhugeint|float|double|decimal(\(.*\))?)$/;

/** `@duckdb/node-api`'s JSON form of an INTERVAL, `{months, days, micros}`, as interval text. */
function duckdbIntervalText(value: Record<string, unknown>): string | undefined {
  const { months, days, micros } = value;
  if (Object.keys(value).length !== 3 || !Number.isInteger(months) || !Number.isInteger(days)) return undefined;
  const microseconds = bareNumber(micros);
  if (microseconds === undefined || microseconds.includes(".")) return undefined;
  return `${months} months ${days} days ${microseconds} microseconds`;
}

/**
 * A value as DuckDB writes it back, recursing through lists, fixed-size arrays, MAP and STRUCT.
 *
 * `@duckdb/node-api` answers a MAP as a list of `{key, value}` entries, a STRUCT as an object
 * and an INTERVAL as `{months, days, micros}`. Measured on DuckDB 1.5.5, that INTERVAL written
 * as JSON is `Conversion Error`, while `INTERVAL '14 months 3 days 14706000001 microseconds'`,
 * `MAP {'k': 1}`, `MAP {}`, `{'a': 7, 'b': ['p']}` and `[1, 2, 3]` all replay.
 */
function duckdbValue(value: unknown, declared: string, scalar: ScalarLiteral): string {
  if (value === null || value === undefined) return "NULL";
  const text = declared.trim();
  const list = /^(.*)\[\d*\]$/.exec(text);
  if (list !== null) {
    if (!Array.isArray(value)) throw new UnwritableValue("a list that is not a list");
    return `[${value.map((element) => duckdbValue(element, list[1], scalar)).join(", ")}]`;
  }
  const type = parseTypeCall(text);
  const name = type.name.toUpperCase();
  if (name === "MAP" && type.args.length === 2) {
    if (!Array.isArray(value) || !value.every((entry) => isRecord(entry) && Object.hasOwn(entry, "key"))) {
      throw new UnwritableValue("a MAP that is not a list of entries");
    }
    const pairs = (value as Record<string, unknown>[]).map(
      (entry) => `${duckdbValue(entry.key, type.args[0], scalar)}: ${duckdbValue(entry.value, type.args[1], scalar)}`,
    );
    return `MAP {${pairs.join(", ")}}`;
  }
  if (name === "STRUCT" && type.args.length > 0) {
    const fields = type.args.map(namedField);
    if (!isRecord(value) || fields.some((field) => field === undefined || !Object.hasOwn(value, field.name))) {
      throw new UnwritableValue("a STRUCT that does not have its declared fields");
    }
    const pairs = (fields as { name: string; type: string }[]).map(
      (field) => `${quoteLiteral(field.name, "duckdb")}: ${duckdbValue(value[field.name], field.type, scalar)}`,
    );
    return `{${pairs.join(", ")}}`;
  }
  if (name === "INTERVAL" && isRecord(value)) {
    const interval = duckdbIntervalText(value);
    if (interval === undefined) throw new UnwritableValue("an INTERVAL that is not months, days and microseconds");
    return `INTERVAL '${interval}'`;
  }
  if (DUCKDB_NUMBER.test(normalized(declared))) return bareNumber(value) ?? scalar(value);
  return scalar(value);
}

/** Only a composite or an INTERVAL cell: DuckDB already reads every quoted scalar back. */
const duckdbLiteral: TypedWriter = (value, declared, scalar) => {
  if (declared === undefined || typeof value !== "object" || value === null || asBytes(value) !== undefined) {
    return undefined;
  }
  return duckdbValue(value, declared, scalar);
};

// ---------------------------------------------------------------------------------------
// Cassandra
// ---------------------------------------------------------------------------------------

/** The CQL types written bare: the numbers, and the uuids, which CQL refuses as quoted strings. */
const CQL_BARE_NUMBER = /^(tinyint|smallint|int|bigint|varint|counter|float|double|decimal)$/;
const CQL_UUID_TYPE = /^(uuid|timeuuid)$/;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CQL_DURATION = /^-?(\d+(y|mo|w|d|h|m|s|ms|us|ns))+$/i;

/** `frozen<T>` is written exactly as `T` is. */
function unwrapFrozen(declared: string): ClickHouseType {
  let type = parseTypeCall(declared, "<", ">");
  while (type.name.toLowerCase() === "frozen" && type.args.length === 1) type = parseTypeCall(type.args[0], "<", ">");
  return type;
}

/**
 * A value as CQL writes it back, recursing through `list`, `set`, `map`, `tuple`, `vector`
 * and user-defined types.
 *
 * A UDT is declared by its bare name (`address`), so an object under a name that is not a
 * map is read as one, with each field quoted as an identifier. The field TYPES are not in
 * the declaration, so each field value goes through the generic writer.
 */
function cassandraValue(value: unknown, declared: string, scalar: ScalarLiteral): string {
  if (value === null || value === undefined) return "null";
  const type = unwrapFrozen(declared);
  const name = type.name.toLowerCase();
  if ((name === "list" || name === "set" || name === "vector") && type.args.length > 0) {
    if (!Array.isArray(value)) throw new UnwritableValue(`a ${name} that is not a list`);
    const elements = value.map((element) => cassandraValue(element, type.args[0], scalar)).join(", ");
    return name === "set" ? `{${elements}}` : `[${elements}]`;
  }
  if (name === "map" && type.args.length === 2) {
    if (!isRecord(value)) throw new UnwritableValue("a map that is not an object");
    const pairs = Object.entries(value).map(
      ([key, entry]) => `${cassandraValue(key, type.args[0], scalar)}: ${cassandraValue(entry, type.args[1], scalar)}`,
    );
    return `{${pairs.join(", ")}}`;
  }
  if (name === "tuple" && type.args.length > 0) {
    if (!Array.isArray(value) || value.length !== type.args.length) {
      throw new UnwritableValue("a tuple that does not have its declared length");
    }
    return `(${value.map((element, index) => cassandraValue(element, type.args[index], scalar)).join(", ")})`;
  }
  // CQL's float constants include the bare words `NaN`, `Infinity` and `-Infinity`.
  const word = name === "float" || name === "double" ? floatWord(value) : undefined;
  if (word !== undefined) return word;
  if (CQL_BARE_NUMBER.test(name)) return bareNumber(value) ?? scalar(value);
  if (CQL_UUID_TYPE.test(name) && typeof value === "string" && UUID_TEXT.test(value)) return value;
  if (name === "duration" && typeof value === "string" && CQL_DURATION.test(value)) return value;
  if (isRecord(value)) {
    const fields = Object.entries(value).map(
      ([field, entry]) => `${quoteIdentifier(field, "cassandra")}: ${scalar(entry)}`,
    );
    return `{${fields.join(", ")}}`;
  }
  return scalar(value);
}

/** The CQL types that stand inside a collection as they are; every other one must be frozen. */
const CQL_NATIVE =
  /^(ascii|bigint|blob|boolean|counter|date|decimal|double|duration|float|inet|int|smallint|text|time|timestamp|timeuuid|tinyint|uuid|varchar|varint|\d+)$/i;

/**
 * A CQL type with every collection, tuple and UDT nested inside a collection written as
 * `frozen<...>`, which is the only form CQL accepts there. A type already frozen, and the
 * top level itself, are left as they are.
 */
export function cqlFrozenNested(declared: string, nested = false): string {
  const text = declared.trim();
  const type = parseTypeCall(text, "<", ">");
  const name = type.name.toLowerCase();
  if (name === "frozen" || (type.args.length === 0 && CQL_NATIVE.test(text))) return text;
  const spelled =
    type.args.length === 0 ? text : `${type.name}<${type.args.map((arg) => cqlFrozenNested(arg, true)).join(", ")}>`;
  return nested ? `frozen<${spelled}>` : spelled;
}

/**
 * Measured on Cassandra 5.0.9: a collection, a UDT, a tuple, a `bigint`, a `varint` and a
 * `decimal` written as quoted JSON or quoted text are `Invalid STRING constant`; the CQL
 * collection, tuple and UDT literals, and the bare number, uuid and duration, replay.
 */
const cassandraLiteral: TypedWriter = (value, declared, scalar) =>
  declared === undefined ? undefined : cassandraValue(value, declared, scalar);

// ---------------------------------------------------------------------------------------
// Databend
// ---------------------------------------------------------------------------------------

/** `Nullable(T)` changes nothing about how a `T` is spelled. */
function unwrapDatabendType(declared: string): ClickHouseType {
  let type = parseTypeCall(declared);
  while (type.name === "Nullable" && type.args.length === 1) type = parseTypeCall(type.args[0]);
  return type;
}

/** The Databend integer, float and decimal types, each of which M08b inserted as a bare number. */
const DATABEND_NUMBER = /^(U?Int(8|16|32|64)|Float(32|64)|Decimal)$/;
/** A number as Databend prints one and reads one back bare: M08b inserted `1e308` and `-1e-10`. */
const DATABEND_NUMERIC_TEXT = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;
/** The types the generic writer's quoted text is the inserted form of: M08b inserted each as a quoted string. */
const DATABEND_QUOTED = /^(String|Date|Timestamp|Timestamp_Tz)$/;
/** A Boolean prints as `1` or `0`; M08b inserted `true` and `false`. */
const DATABEND_BOOLEAN: Readonly<Record<string, string>> = { "1": "true", "0": "false", true: "true", false: "false" };
/** Whole bytes of hex, which is all `binary_output_format` HEX prints and all `unhex` reads. */
const HEX_BYTES = /^(?:[0-9A-Fa-f]{2})*$/;
/** How much of a refused type's name the skipped row's comment carries; every name Databend prints is far shorter. */
const DATABEND_TYPE_NAME_CHARS = 64;

/**
 * A refused type's name as the skipped row's comment carries it. The type is the server's own text, kept verbatim from
 * the wire, so it is cut to a bound and everything outside printable ASCII is replaced: a line break in it would end
 * the comment and put the rest of the type in the file as a statement.
 */
function databendTypeName(name: string): string {
  const printable = name.replace(/[^\x20-\x7e]/g, "?");
  return printable.length > DATABEND_TYPE_NAME_CHARS ? `${printable.slice(0, DATABEND_TYPE_NAME_CHARS)}...` : printable;
}

/**
 * A Databend cell by its declared type, the forms M08b inserted on the pinned image (design 7.2, X01).
 *
 * A Binary cell is hex text, which the generic writer would quote and Databend would read through
 * `binary_input_format` (utf-8 by default) as six characters instead of three bytes, silently; `unhex` reads it
 * back as the bytes. A Variant is JSON text, read back through `parse_json`. A Bitmap prints as the placeholder
 * `<bitmap binary>`, and an Array, a Map or a Tuple prints a bare `NULL` inside it that is not JSON, so those, and
 * every other type the every-type replay has not proven, are refused rather than written in a form that might
 * replay as something else.
 */
function databendValue(value: unknown, declared: string, scalar: ScalarLiteral): string {
  const name = unwrapDatabendType(declared).name;
  if (name === "Binary") {
    if (typeof value !== "string" || !HEX_BYTES.test(value)) throw new UnwritableValue("a Binary that is not hex");
    return `unhex('${value}')`;
  }
  if (name === "Variant")
    return `parse_json(${quoteLiteral(typeof value === "string" ? value : jsonText(value), "databend")})`;
  if (name === "Boolean")
    return Object.hasOwn(DATABEND_BOOLEAN, String(value)) ? DATABEND_BOOLEAN[String(value)] : scalar(value);
  // The generic writer spells a non-finite number with `NON_FINITE_LITERALS.databend`.
  const word = name.startsWith("Float") ? floatWord(value) : undefined;
  if (word !== undefined) return scalar(Number(word));
  if (DATABEND_NUMBER.test(name)) {
    return typeof value === "number" || (typeof value === "string" && DATABEND_NUMERIC_TEXT.test(value))
      ? String(value)
      : scalar(value);
  }
  if (DATABEND_QUOTED.test(name)) return scalar(value);
  throw new UnwritableValue(`a value of type ${databendTypeName(name)}`);
}

/** Every declared cell but bytes from a host, which the generic writer spells with `BINARY_LITERAL.databend`. */
const databendLiteral: TypedWriter = (value, declared, scalar) =>
  declared === undefined || asBytes(value) !== undefined ? undefined : databendValue(value, declared, scalar);

// ---------------------------------------------------------------------------------------
// Snowflake
// ---------------------------------------------------------------------------------------

/** The semi-structured types, each written through `PARSE_JSON`; a structured spelling of one is also cast. */
const SNOWFLAKE_SEMI_STRUCTURED = /^(VARIANT|OBJECT|ARRAY|MAP)$/;
/**
 * A declared type a cast may name: a type name and an argument list of names, digits, commas, spaces and parentheses.
 * The declaration is data, so nothing that could close a literal, start a comment or end the statement passes.
 */
const SNOWFLAKE_CAST_TYPE = /^[A-Z_]+\([A-Z0-9_, ()]*\)$/i;
/** One element of a VECTOR's text: a number, or a non-finite word, which only a FLOAT vector holds. */
const SNOWFLAKE_VECTOR_ELEMENT = /^-?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|inf|infinity|nan)$/i;
/** A NUMBER or DECFLOAT text written bare, as the decoder hands over its exact text. */
const SNOWFLAKE_NUMERIC_TEXT = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

/** The decoder's text for each temporal type, its conversion function, and its mask without the fraction. */
const SNOWFLAKE_TEMPORAL: Readonly<Record<string, { shape: RegExp; convert: string; mask: string; zoned: boolean }>> = {
  DATE: { shape: /^\d{4}-\d{2}-\d{2}$/, convert: "TO_DATE", mask: "YYYY-MM-DD", zoned: false },
  TIME: { shape: /^\d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?$/, convert: "TO_TIME", mask: "HH24:MI:SS", zoned: false },
  TIMESTAMP_NTZ: {
    shape: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?$/,
    convert: "TO_TIMESTAMP_NTZ",
    mask: "YYYY-MM-DD HH24:MI:SS",
    zoned: false,
  },
  TIMESTAMP_LTZ: {
    shape: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?[+-]\d{2}:\d{2}$/,
    convert: "TO_TIMESTAMP_LTZ",
    mask: "YYYY-MM-DD HH24:MI:SS",
    zoned: true,
  },
  TIMESTAMP_TZ: {
    shape: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?[+-]\d{2}:\d{2}$/,
    convert: "TO_TIMESTAMP_TZ",
    mask: "YYYY-MM-DD HH24:MI:SS",
    zoned: true,
  },
};

/**
 * The VECTOR type a cell's own text spells, for a column whose result metadata carries no dimension, as the trial's
 * did: as many elements as the value holds, FLOAT when any is not an integer, else INT.
 */
function snowflakeVectorType(text: string): string {
  const inner = /^\s*\[([\s\S]*)\]\s*$/.exec(text)?.[1];
  const elements = inner === undefined ? [] : inner.split(",").map((element) => element.trim());
  if (elements.length === 0 || !elements.every((element) => SNOWFLAKE_VECTOR_ELEMENT.test(element))) {
    throw new UnwritableValue("a VECTOR whose value is not an array of numbers");
  }
  const float = elements.some((element) => !/^-?\d+$/.test(element));
  return `VECTOR(${float ? "FLOAT" : "INT"}, ${elements.length})`;
}

/**
 * A Snowflake cell by its declared type, in the catalog spelling the provider's decoder reports.
 *
 * Provisional until a replay on an account confirms each form. A semi-structured, structured or VECTOR cell is
 * `PARSE_JSON` of its JSON text, which `INSERT ... VALUES` refuses, so the export writes Snowflake's rows as
 * `INSERT ... SELECT`; a VECTOR or a structured type is cast to its declaration, and a VECTOR without its dimension
 * to the type its value spells. A date, a time or a timestamp goes through its `TO_*` function with a mask matching the
 * decoder's text, the fraction digits as the text carries them, so no account input format moves the value; a cell
 * not in that text is refused rather than left to an input format.
 */
function snowflakeValue(value: unknown, declared: string, scalar: ScalarLiteral): string | undefined {
  const spelled = declared.trim().replace(/\s+/g, " ");
  const name = spelled.split("(")[0].trim().toUpperCase();
  const structured = spelled.includes("(");
  if (SNOWFLAKE_SEMI_STRUCTURED.test(name) || name === "VECTOR") {
    const text = typeof value === "string" ? value : jsonText(value);
    const parsed = `PARSE_JSON(${quoteLiteral(text, "snowflake")})`;
    if (!structured) return name === "VECTOR" ? `${parsed}::${snowflakeVectorType(text)}` : parsed;
    if (!SNOWFLAKE_CAST_TYPE.test(spelled)) throw new UnwritableValue(`a ${name} whose declared type is not a type`);
    return `${parsed}::${spelled}`;
  }
  const temporal = Object.hasOwn(SNOWFLAKE_TEMPORAL, name) ? SNOWFLAKE_TEMPORAL[name] : undefined;
  if (temporal !== undefined) {
    const match = typeof value === "string" ? temporal.shape.exec(value) : null;
    if (match === null) throw new UnwritableValue(`a ${name} that is not in the form Studio reads`);
    const fraction = match[1] === undefined ? "" : `.FF${match[1].length}`;
    const mask = `${temporal.mask}${fraction}${temporal.zoned ? "TZH:TZM" : ""}`;
    return `${temporal.convert}(${quoteLiteral(value as string, "snowflake")}, '${mask}')`;
  }
  if ((name === "NUMBER" || name === "DECFLOAT") && typeof value === "string") {
    return SNOWFLAKE_NUMERIC_TEXT.test(value) ? value : scalar(value);
  }
  return undefined;
}

/** Every declared cell but bytes, which the generic writer spells with `BINARY_LITERAL.snowflake`. */
const snowflakeLiteral: TypedWriter = (value, declared, scalar) =>
  declared === undefined || asBytes(value) !== undefined ? undefined : snowflakeValue(value, declared, scalar);

// ---------------------------------------------------------------------------------------
// Apache Spark
// ---------------------------------------------------------------------------------------

/**
 * Spark's typed literals for the texts the Spark provider's decoder writes: a date, a timestamp with
 * its `+00:00`, a timestamp without a zone and a time, each checked against that text before it is quoted, so a cell
 * in another form is refused rather than left to Spark's string casts. Strings, booleans, plain numbers and bytes
 * are the generic writer's (`LITERAL_ESCAPE.spark`, `BINARY_LITERAL.spark`).
 */
const SPARK_TEMPORAL: ReadonlyArray<{ readonly declared: RegExp; readonly keyword: string; readonly shape: RegExp }> = [
  { declared: /^date$/, keyword: "DATE", shape: /^[+-]?\d{4,}-\d{2}-\d{2}$/ },
  {
    declared: /^timestamp$/,
    keyword: "TIMESTAMP_LTZ",
    shape: /^[+-]?\d{4,}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00:00$/,
  },
  {
    declared: /^timestamp_ntz$/,
    keyword: "TIMESTAMP_NTZ",
    shape: /^[+-]?\d{4,}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/,
  },
  { declared: /^time(\(\d\))?$/, keyword: "TIME", shape: /^\d{2}:\d{2}:\d{2}(\.\d{1,9})?$/ },
];
const SPARK_DIGITS_TYPE = /^(bigint|decimal\(\d+,\s*-?\d+\))$/;
const SPARK_DIGITS = /^-?\d+(\.\d+)?$/;
const SPARK_ANSI_INTERVAL_TYPE = /^interval (year|month|day|hour|minute|second)( to (month|hour|minute|second))?$/;
/** The ANSI literal `temporal.ts` renders: a quoted run of digits, signs, spaces, colons and points, then its fields. */
const SPARK_ANSI_INTERVAL =
  /^INTERVAL '-?\d[\d :.-]*' (YEAR|MONTH|DAY|HOUR|MINUTE|SECOND)( TO (MONTH|HOUR|MINUTE|SECOND))?$/;
const SPARK_NESTED_TYPE = /^(array|map|struct)</;
/**
 * A Spark type name with the article it is read with, "an array<int>", "an interval year to month", "a map<...>", for
 * the refusals the skipped-row line quotes; a Spark type name is ASCII, so its first letter decides.
 */
const withArticle = (typeName: string): string => `${/^[aeiou]/i.test(typeName) ? "an" : "a"} ${typeName}`;

/**
 * The type names inside an array, map or struct that FROM_JSON does not read back from the text the decoder writes,
 * each with the words its refused cell is reported in. Spark 4.2.0's JSON reader takes a binary value
 * only as base64, where the decoder writes `\x<hex>`; makes a JSON string under VARIANT a string VARIANT, where the
 * decoder writes a variant's JSON text as a string; and has no reader for a geospatial type (`JacksonParser.scala`
 * at v4.2.0). A CHAR or VARCHAR anywhere in a FROM_JSON schema fails the statement with
 * UNSUPPORTED_CHAR_OR_VARCHAR_AS_STRING. Measured on 4.2.0: the binary cell stored NULL, the variant cell a string,
 * and the CHAR and VARCHAR schemas failed.
 */
const SPARK_NESTED_REFUSALS: ReadonlyMap<string, string> = new Map([
  ["binary", "binary inside (FROM_JSON reads it only as base64)"],
  ["variant", "a VARIANT inside (FROM_JSON would store it as a string)"],
  ["geometry", "a geospatial value inside (FROM_JSON reads none)"],
  ["geography", "a geospatial value inside (FROM_JSON reads none)"],
  ["char", "a CHAR or VARCHAR inside (a FROM_JSON schema takes neither)"],
  ["varchar", "a CHAR or VARCHAR inside (a FROM_JSON schema takes neither)"],
]);
/**
 * FROM_JSON's options. Its default mode, PERMISSIVE, stores NULL for a whole value when one element does not parse (a
 * nested bigint past 2^53, which the decoder writes as digit text, is one); FAILFAST fails the INSERT instead, so
 * no row is stored (measured on 4.2.0).
 */
const SPARK_FROM_JSON_OPTIONS = "MAP('mode', 'FAILFAST')";

/**
 * Why FROM_JSON cannot write a cell of the nested type `type`, or `undefined` when it can. A word is a type name
 * unless a colon follows it, which makes it a struct field's name, and a backquoted name is skipped whole. Spark
 * refuses a FROM_JSON schema holding a map whose key is not a STRING, at any depth (INVALID_JSON_MAP_KEY_TYPE), and
 * reads a STRING key with a collation (both measured on 4.2.0).
 */
function sparkNestedRefusal(type: string): string | undefined {
  const tokens = type.replace(/`(?:[^`]|``)*`/g, " ").match(/[a-z0-9_]+|[^\sa-z0-9_]/g) ?? [];
  for (const [index, token] of tokens.entries()) {
    if (tokens[index + 1] === ":") continue;
    const refusal = SPARK_NESTED_REFUSALS.get(token);
    if (refusal !== undefined) return refusal;
    if (token !== "map" || tokens[index + 1] !== "<") continue;
    const afterKey = tokens[index + 3];
    if (tokens[index + 2] !== "string" || (afterKey !== "," && afterKey !== "collate")) {
      return "a map whose keys are not strings (FROM_JSON reads none)";
    }
  }
  return undefined;
}

function sparkValue(value: unknown, declared: string): string | undefined {
  const type = normalized(declared);
  for (const temporal of SPARK_TEMPORAL) {
    if (!temporal.declared.test(type)) continue;
    if (typeof value !== "string" || !temporal.shape.test(value)) {
      throw new UnwritableValue(`${withArticle(type)} value that is not in the form Studio reads from Spark`);
    }
    return `${temporal.keyword} ${quoteLiteral(value, "spark")}`;
  }
  if (SPARK_DIGITS_TYPE.test(type)) {
    if (typeof value !== "string") return undefined;
    // Not quoted instead: Spark's default store assignment (ANSI) refuses a string into a BIGINT or DECIMAL column
    // with CANNOT_SAFELY_CAST (measured on 4.2.0).
    if (!SPARK_DIGITS.test(value)) throw new UnwritableValue(`${withArticle(type)} value that is not digit text`);
    return value;
  }
  if (type === "interval") throw new UnwritableValue("a calendar interval (no Spark table column stores one)");
  if (SPARK_ANSI_INTERVAL_TYPE.test(type)) {
    if (typeof value !== "string" || !SPARK_ANSI_INTERVAL.test(value)) {
      throw new UnwritableValue(`${withArticle(type)} value that is not an ANSI interval literal`);
    }
    return value;
  }
  if (type === "variant") {
    if (typeof value !== "string") throw new UnwritableValue("a VARIANT value that is not JSON text");
    return `PARSE_JSON(${quoteLiteral(value, "spark")})`;
  }
  if (type.startsWith("geometry") || type.startsWith("geography")) {
    throw new UnwritableValue(`${withArticle(type)} value (Studio does not write one back to Spark in this version)`);
  }
  if (SPARK_NESTED_TYPE.test(type)) {
    const refusal = sparkNestedRefusal(type);
    if (refusal !== undefined) throw new UnwritableValue(`${withArticle(type)} value with ${refusal}`);
    const json = quoteLiteral(jsonText(value), "spark");
    return `FROM_JSON(${json}, ${quoteLiteral(declared.trim(), "spark")}, ${SPARK_FROM_JSON_OPTIONS})`;
  }
  return undefined;
}

/** Every declared cell but bytes, which the generic writer spells with `BINARY_LITERAL.spark`. */
const sparkLiteral: TypedWriter = (value, declared) =>
  declared === undefined || asBytes(value) !== undefined ? undefined : sparkValue(value, declared);

/** The dialects whose INSERT needs a declared type to write some cell; the rest have no row. */
const TYPED_WRITERS: Partial<Record<DatabaseType, TypedWriter>> = {
  postgres: postgresLiteral,
  mssql: mssqlLiteral,
  clickhouse: clickhouseLiteral,
  trino: trinoLiteral,
  duckdb: duckdbLiteral,
  cassandra: cassandraLiteral,
  databend: databendLiteral,
  snowflake: snowflakeLiteral,
  spark: sparkLiteral,
};

/**
 * `value` as the literal `dialect` reads back into a column declared `declared`, or
 * `undefined` when the generic writer's form is already the right one. Throws
 * `UnwritableValue` for a cell the dialect has no literal for.
 */
export function typedLiteral(
  value: unknown,
  declared: unknown,
  dialect: DatabaseType | undefined,
  scalar: ScalarLiteral,
): string | undefined {
  if (value === null || value === undefined || dialect === undefined) return undefined;
  // `columnTypes` is the host's data until checked, so only a string is a declaration.
  return TYPED_WRITERS[dialect]?.(value, typeof declared === "string" ? declared : undefined, scalar);
}
