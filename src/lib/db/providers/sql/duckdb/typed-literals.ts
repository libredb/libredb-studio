import {
  asBytes,
  bareNumber,
  isRecord,
  namedField,
  normalized,
  parseTypeCall,
  UnwritableValue,
} from "@/lib/db/sql-writing/export-shared";
import { literalStandard } from "@/lib/db/sql-writing/shared";
import type { ScalarLiteral, TypedWriter } from "@/lib/db/sql-writing/types";

/**
 * DuckDB's typed literals for the SQL INSERT export: the cells that need their column's
 * declared type to be written back as something DuckDB reads (#1386). `typedLiteral` in
 * `src/lib/export/typed-literals.ts` hands every DuckDB cell to `duckdbLiteral`.
 */

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
      (field) => `${literalStandard(field.name)}: ${duckdbValue(value[field.name], field.type, scalar)}`,
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
export const duckdbLiteral: TypedWriter = (value, declared, scalar) => {
  if (declared === undefined || typeof value !== "object" || value === null || asBytes(value) !== undefined) {
    return undefined;
  }
  return duckdbValue(value, declared, scalar);
};
