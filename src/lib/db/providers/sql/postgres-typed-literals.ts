import { asBytes, binaryText, isRecord, jsonText, normalized } from "@/lib/db/sql-writing/export-shared";
import { literalStandard } from "@/lib/db/sql-writing/shared";
import type { TypedWriter } from "@/lib/db/sql-writing/types";

/**
 * PostgreSQL's typed literals for the SQL INSERT export: the cells that need their column's
 * declared type to be written back as something PostgreSQL reads (#1386). `typedLiteral` in
 * `src/lib/export/typed-literals.ts` hands every PostgreSQL cell to `postgresLiteral`.
 */

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
export const postgresLiteral: TypedWriter = (value, declared) => {
  const type = normalized(declared);
  if (type.endsWith("[]") && Array.isArray(value)) {
    return literalStandard(pgArrayText(value, type.replace(/(\[\])+$/, "")));
  }
  if (!isRecord(value)) return undefined;
  const text = type === "interval" ? pgIntervalText(value) : pgGeometryText(value, type);
  return text === undefined ? undefined : literalStandard(text);
};
