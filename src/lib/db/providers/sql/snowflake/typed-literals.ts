import { asBytes, jsonText, UnwritableValue } from "@/lib/db/sql-writing/export-shared";
import { literalDoubleAndBackslash } from "@/lib/db/sql-writing/shared";
import type { ScalarLiteral, TypedWriter } from "@/lib/db/sql-writing/types";

/**
 * Snowflake's typed literals for the SQL INSERT export: the cells that need their column's
 * declared type to be written back as something Snowflake reads (#1386). `typedLiteral` in
 * `src/lib/export/typed-literals.ts` hands every Snowflake cell to `snowflakeLiteral`.
 */

/** The semi-structured types, each written through `PARSE_JSON`; a structured spelling of one is also cast. */
const SNOWFLAKE_SEMI_STRUCTURED = /^(VARIANT|OBJECT|ARRAY|MAP)$/;
/**
 * A declared type a cast may name: a type name and an argument list of names, digits, commas, spaces and parentheses.
 * The declaration is data, so nothing that could close a literal, start a comment or end the statement passes.
 */
const SNOWFLAKE_CAST_TYPE = /^[A-Z_]+\([A-Z0-9_, ()]*\)$/i;
/** One element of a VECTOR's text: a number, or a non-finite word, which only a FLOAT vector holds. */
const SNOWFLAKE_VECTOR_ELEMENT = /^-?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|inf|infinity|nan)$/i;
/** A NUMBER text written bare, and a DECFLOAT text quoted and cast, as the decoder hands over its exact text. */
const SNOWFLAKE_NUMERIC_TEXT = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

/**
 * The decoder's text for each temporal type, its conversion function, and its mask without the fraction. A year has at
 * least four digits and a `-` before year 0 (SF-008), as the decoder writes any year Snowflake stores.
 */
const SNOWFLAKE_TEMPORAL: Readonly<Record<string, { shape: RegExp; convert: string; mask: string; zoned: boolean }>> = {
  DATE: { shape: /^-?\d{4,}-\d{2}-\d{2}$/, convert: "TO_DATE", mask: "YYYY-MM-DD", zoned: false },
  TIME: { shape: /^\d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?$/, convert: "TO_TIME", mask: "HH24:MI:SS", zoned: false },
  TIMESTAMP_NTZ: {
    shape: /^-?\d{4,}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?$/,
    convert: "TO_TIMESTAMP_NTZ",
    mask: "YYYY-MM-DD HH24:MI:SS",
    zoned: false,
  },
  TIMESTAMP_LTZ: {
    shape: /^-?\d{4,}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?[+-]\d{2}:\d{2}$/,
    convert: "TO_TIMESTAMP_LTZ",
    mask: "YYYY-MM-DD HH24:MI:SS",
    zoned: true,
  },
  TIMESTAMP_TZ: {
    shape: /^-?\d{4,}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?[+-]\d{2}:\d{2}$/,
    convert: "TO_TIMESTAMP_TZ",
    mask: "YYYY-MM-DD HH24:MI:SS",
    zoned: true,
  },
};

/** A year before 1, as the decoder writes it: a `-` and the year's digits. */
const SNOWFLAKE_YEAR_BEFORE_ONE = /^-(\d+)/;
/** The years of one era of the proleptic Gregorian calendar, which repeats exactly after it, and its days. */
const YEARS_PER_ERA = BigInt(400);
const DAYS_PER_ERA = BigInt(146_097);

/**
 * A temporal cell through its `TO_*` function and mask. The mask reads a year of any length but not a sign (measured on
 * the trial on 2026-10-14: `TO_DATE('252026-01-01', 'YYYY-MM-DD')` is read, `'-0002-06-01'` is refused with 100097, and
 * a cast refuses a timestamp before year 1 with 100035), so a year before 1 is written as many whole 400-year eras
 * later as bring it to 0 or after, and moved back by the eras' exact day count with `DATEADD(DAY, ...)`, which keeps
 * the clock and the offset (`DATEADD(YEAR, ...)` moves a February 29 to the 28th). An LTZ cell, a UTC instant, is moved
 * as a TIMESTAMP_TZ at `+00:00` and cast back, so the session's zone never takes part.
 */
function snowflakeTemporalLiteral(text: string, convert: string, mask: string): string {
  const before = SNOWFLAKE_YEAR_BEFORE_ONE.exec(text);
  if (before === null) return `${convert}(${literalDoubleAndBackslash(text)}, '${mask}')`;
  const year = BigInt(before[1]);
  const eras = (year + YEARS_PER_ERA - BigInt(1)) / YEARS_PER_ERA;
  const shifted = `${(eras * YEARS_PER_ERA - year).toString().padStart(4, "0")}${text.slice(before[0].length)}`;
  const ltz = convert === "TO_TIMESTAMP_LTZ";
  const converted = `${ltz ? "TO_TIMESTAMP_TZ" : convert}(${literalDoubleAndBackslash(shifted)}, '${mask}')`;
  return `DATEADD(DAY, -${eras * DAYS_PER_ERA}, ${converted})${ltz ? "::TIMESTAMP_LTZ" : ""}`;
}

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
 * A Snowflake VECTOR column's declaration, from its first value.
 *
 * Snowflake reports a VECTOR result column as `vector` with no element type and no dimension, and
 * `CREATE TABLE t (v VECTOR)` is a syntax error (001003), so the declaration is the one the first
 * non-null cell spells, as the SQL INSERT export already casts each cell (`snowflakeVectorType`).
 * Every cell of a VECTOR column has the same element type and dimension, so one cell decides. A
 * column with no value to read is declared `ARRAY`, which holds the NULLs the file inserts and is
 * the semi-structured type the cell's JSON text belongs to.
 */
export function snowflakeVectorDeclaration(sample: unknown): string {
  if (sample === undefined) return "ARRAY";
  try {
    return snowflakeVectorType(typeof sample === "string" ? sample : jsonText(sample));
  } catch (error) {
    if (!(error instanceof UnwritableValue)) throw error;
    return "ARRAY";
  }
}

/**
 * A Snowflake cell by its declared type, in the catalog spelling the provider's decoder reports.
 *
 * Provisional until a replay on an account confirms each form. A semi-structured, structured or VECTOR cell is
 * `PARSE_JSON` of its JSON text, which `INSERT ... VALUES` refuses, so the export writes Snowflake's rows as
 * `INSERT ... SELECT`; a VECTOR or a structured type is cast to its declaration, and a VECTOR without its dimension
 * to the type its value spells. A date, a time or a timestamp goes through its `TO_*` function with a mask matching the
 * decoder's text, the fraction digits as the text carries them, so no account input format moves the value, and a year
 * before 1 through `snowflakeTemporalLiteral`'s era shift; a cell not in that text is refused rather than left to an
 * input format.
 */
function snowflakeValue(value: unknown, declared: string, scalar: ScalarLiteral): string | undefined {
  const spelled = declared.trim().replace(/\s+/g, " ");
  const name = spelled.split("(")[0].trim().toUpperCase();
  const structured = spelled.includes("(");
  if (SNOWFLAKE_SEMI_STRUCTURED.test(name) || name === "VECTOR") {
    const text = typeof value === "string" ? value : jsonText(value);
    const parsed = `PARSE_JSON(${literalDoubleAndBackslash(text)})`;
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
    return snowflakeTemporalLiteral(value as string, temporal.convert, mask);
  }
  if (name === "NUMBER" && typeof value === "string") {
    return SNOWFLAKE_NUMERIC_TEXT.test(value) ? value : scalar(value);
  }
  // A bare numeric literal is a NUMBER or a FLOAT before it is a DECFLOAT, which Snowflake's own
  // numeric-types page warns about: replayed on 2026-10-14, `1.23e40` came back
  // `1.22999999999999995e40`, `-4.2e-5432` came back 0 and `1e16384` failed as
  // `TO_DECFLOAT(inf)`. A quoted text cast to DECFLOAT is parsed by DECFLOAT itself, exactly.
  if (name === "DECFLOAT" && typeof value === "string") {
    return SNOWFLAKE_NUMERIC_TEXT.test(value) ? `${literalDoubleAndBackslash(value)}::DECFLOAT` : scalar(value);
  }
  return undefined;
}

/** Every declared cell but bytes, which the generic writer spells with `SNOWFLAKE_SQL_WRITING.export.binaryLiteral`. */
export const snowflakeLiteral: TypedWriter = (value, declared, scalar) =>
  declared === undefined || asBytes(value) !== undefined ? undefined : snowflakeValue(value, declared, scalar);
