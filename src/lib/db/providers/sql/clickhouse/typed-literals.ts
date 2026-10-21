import {
  asBytes,
  type ClickHouseType,
  floatWord,
  isRecord,
  NUMERIC_TEXT,
  parseTypeCall,
  UnwritableValue,
} from "@/lib/db/sql-writing/export-shared";
import type { ScalarLiteral, TypedWriter } from "@/lib/db/sql-writing/types";

/**
 * ClickHouse's typed literals for the SQL INSERT export: the cells that need their column's
 * declared type to be written back as something ClickHouse reads (#1386). `typedLiteral` in
 * `src/lib/export/typed-literals.ts` hands every ClickHouse cell to `clickhouseLiteral`.
 */

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
export const clickhouseLiteral: TypedWriter = (value, declared, scalar) => {
  if (declared === undefined) return undefined;
  // A scalar float's NaN or infinity, `Nullable` and `LowCardinality` included: ClickHouse reads
  // the bare `nan`, `inf` and `-inf` back into a `Float` column (SF-045), where the generic
  // writer's quoted word is refused and NULL replays as 0 into a non-Nullable column.
  const word = CLICKHOUSE_FLOAT.test(unwrapClickHouseType(declared).name) ? floatWord(value) : undefined;
  if (word !== undefined) return CLICKHOUSE_NON_FINITE[word];
  if (value === null || typeof value !== "object" || asBytes(value) !== undefined) return undefined;
  const name = unwrapClickHouseType(declared).name;
  if (name !== "Array" && name !== "Map" && name !== "Tuple") return undefined;
  return clickHouseValue(value, declared, scalar);
};
