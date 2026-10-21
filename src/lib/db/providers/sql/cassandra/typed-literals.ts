import {
  bareNumber,
  type ClickHouseType,
  floatWord,
  isRecord,
  parseTypeCall,
  UnwritableValue,
} from "@/lib/db/sql-writing/export-shared";
import { identifierDoubleQuoted } from "@/lib/db/sql-writing/shared";
import type { ScalarLiteral, TypedWriter } from "@/lib/db/sql-writing/types";

/**
 * Cassandra's typed literals for the SQL INSERT export: the cells that need their column's
 * declared type to be written back as something Cassandra reads (#1386). `typedLiteral` in
 * `src/lib/export/typed-literals.ts` hands every Cassandra cell to `cassandraLiteral`.
 */

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
    const fields = Object.entries(value).map(([field, entry]) => `${identifierDoubleQuoted(field)}: ${scalar(entry)}`);
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
export const cassandraLiteral: TypedWriter = (value, declared, scalar) =>
  declared === undefined ? undefined : cassandraValue(value, declared, scalar);
