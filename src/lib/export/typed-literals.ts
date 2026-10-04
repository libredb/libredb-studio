import type { DatabaseType } from "@/lib/types";
import { quoteLiteral } from "@/lib/sql/values";
import { asBytes, binaryText } from "./binary";
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
 * T-SQL has no boolean literal: `true` parses as a column name (`Msg 207: Invalid column
 * name 'true'`, measured on SQL Server 2025 17.0.5005.3) and fails the whole batch. A BIT
 * takes `1` and `0`, and `mssql` hands a BIT back as a JS boolean.
 */
const mssqlLiteral: TypedWriter = (value) => (typeof value === "boolean" ? (value ? "1" : "0") : undefined);

// ---------------------------------------------------------------------------------------
// ClickHouse
// ---------------------------------------------------------------------------------------

/** A ClickHouse type split into its name and its top-level arguments: `Map(String, Int32)`. */
interface ClickHouseType {
  name: string;
  args: string[];
}

/** The top-level comma-separated arguments of a parenthesised list, quotes and nesting respected. */
function splitArguments(text: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "'") quoted = !quoted;
    else if (quoted) continue;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      args.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  args.push(text.slice(start).trim());
  return args;
}

function parseClickHouseType(declared: string): ClickHouseType {
  const match = /^([A-Za-z0-9_]+)\((.*)\)$/.exec(declared.trim());
  if (match === null) return { name: declared.trim(), args: [] };
  return { name: match[1], args: splitArguments(match[2]) };
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

/** The dialects whose INSERT needs a declared type to write some cell; the rest have no row. */
const TYPED_WRITERS: Partial<Record<DatabaseType, TypedWriter>> = {
  postgres: postgresLiteral,
  mssql: mssqlLiteral,
  clickhouse: clickhouseLiteral,
};

/**
 * `value` as the literal `dialect` reads back into a column declared `declared`, or
 * `undefined` when the generic writer's form is already the right one.
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
