import {
  asBytes,
  type ClickHouseType,
  floatWord,
  jsonText,
  parseTypeCall,
  UnwritableValue,
} from "@/lib/db/sql-writing/export-shared";
import { literalDoubleAndBackslash } from "@/lib/db/sql-writing/shared";
import type { ScalarLiteral, TypedWriter } from "@/lib/db/sql-writing/types";

/**
 * Databend's typed literals for the SQL INSERT export: the cells that need their column's
 * declared type to be written back as something Databend reads (#1386). `typedLiteral` in
 * `src/lib/export/typed-literals.ts` hands every Databend cell to `databendLiteral`.
 */

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
    return `parse_json(${literalDoubleAndBackslash(typeof value === "string" ? value : jsonText(value))})`;
  if (name === "Boolean")
    return Object.hasOwn(DATABEND_BOOLEAN, String(value)) ? DATABEND_BOOLEAN[String(value)] : scalar(value);
  // The generic writer spells a non-finite number with `DATABEND_SQL_WRITING.export.nonFinite`.
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

/** Every declared cell but bytes from a host, which the generic writer spells with `DATABEND_SQL_WRITING.export.binaryLiteral`. */
export const databendLiteral: TypedWriter = (value, declared, scalar) =>
  declared === undefined || asBytes(value) !== undefined ? undefined : databendValue(value, declared, scalar);
