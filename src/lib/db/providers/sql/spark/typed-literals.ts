import { asBytes, jsonText, normalized, UnwritableValue } from "@/lib/db/sql-writing/export-shared";
import { literalBackslash } from "@/lib/db/sql-writing/shared";
import type { TypedWriter } from "@/lib/db/sql-writing/types";

/**
 * Apache Spark's typed literals for the SQL INSERT export: the cells that need their column's
 * declared type to be written back as something Apache Spark reads (#1386). `typedLiteral` in
 * `src/lib/export/typed-literals.ts` hands every Apache Spark cell to `sparkLiteral`.
 */

/**
 * Spark's typed literals for the texts the Spark provider's decoder writes: a date, a timestamp with
 * its `+00:00`, a timestamp without a zone and a time, each checked against that text before it is quoted, so a cell
 * in another form is refused rather than left to Spark's string casts. Strings, booleans, plain numbers and bytes
 * are the generic writer's (`SPARK_SQL_WRITING.escapeLiteral`, `SPARK_SQL_WRITING.export.binaryLiteral`).
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
    return `${temporal.keyword} ${literalBackslash(value)}`;
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
    return `PARSE_JSON(${literalBackslash(value)})`;
  }
  if (type.startsWith("geometry") || type.startsWith("geography")) {
    throw new UnwritableValue(`${withArticle(type)} value (Studio does not write one back to Spark in this version)`);
  }
  if (SPARK_NESTED_TYPE.test(type)) {
    const refusal = sparkNestedRefusal(type);
    if (refusal !== undefined) throw new UnwritableValue(`${withArticle(type)} value with ${refusal}`);
    const json = literalBackslash(jsonText(value));
    return `FROM_JSON(${json}, ${literalBackslash(declared.trim())}, ${SPARK_FROM_JSON_OPTIONS})`;
  }
  return undefined;
}

/** Every declared cell but bytes, which the generic writer spells with `SPARK_SQL_WRITING.export.binaryLiteral`. */
export const sparkLiteral: TypedWriter = (value, declared) =>
  declared === undefined || asBytes(value) !== undefined ? undefined : sparkValue(value, declared);
