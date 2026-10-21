import {
  bareNumber,
  floatWord,
  isRecord,
  jsonText,
  namedField,
  normalized,
  parseTypeCall,
  UnwritableValue,
} from "@/lib/db/sql-writing/export-shared";
import { literalStandard } from "@/lib/db/sql-writing/shared";
import type { ScalarLiteral, TypedWriter } from "@/lib/db/sql-writing/types";

/**
 * Trino's typed literals for the SQL INSERT export: the cells that need their column's
 * declared type to be written back as something Trino reads (#1386). `typedLiteral` in
 * `src/lib/export/typed-literals.ts` hands every Trino cell to `trinoLiteral`.
 */

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
  return `${keyword} ${literalStandard(typeof value === "string" ? value : jsonText(value))}`;
}

/**
 * Trino's INSERT coerces almost nothing from a quoted string: measured on 483, a `bigint`,
 * `decimal`, `date`, `timestamp`, `json`, `array`, `map`, `uuid`, `varbinary` and `row`
 * each answered `Insert query has mismatched column types`. So every declared cell is
 * written by its type.
 */
export const trinoLiteral: TypedWriter = (value, declared, scalar) =>
  declared === undefined ? undefined : trinoValue(value, declared, scalar);
