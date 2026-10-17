/**
 * One BSON value as JSON-safe text, the way the editor's grid and the agent's read path both show it.
 *
 * Shared on purpose: an answer's rows and the editor's rows for the same documents are one serialization, so they
 * cannot render a value two ways.
 */

import { ObjectId, Binary, Decimal128, type Document } from "mongodb";
// The BSON classes and the Extended JSON writer, reached through a namespace import for the reason `index.ts` gives:
// bun does not see `BSON` as a named export of the driver's CommonJS entry.
import * as mongodbDriver from "mongodb";

/**
 * A bigint as a JSON-safe value: a number while it is exact, its digits past 2^53. The
 * driver reads no bigint back (it is not asked to), so the only one a result holds is an
 * echo of a `$numberLong` the statement wrote, `insertedId` above all; `JSON.stringify`
 * throws on a bigint, which answered the write with an error after it had committed.
 */
function serializeBigInt(value: unknown): unknown {
  if (typeof value !== "bigint") return value;
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
}

/**
 * One value as the grid - and the agent's read-only profile, which shares this serializer
 * so an answer's rows and the editor's rows for the same statement cannot differ - shows it.
 * An array's entries go through the same rules as a field's (#1423): an ObjectId, a Date or
 * a Long inside an array used to be copied field by field.
 */
function serializeMongoValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return serializeBigInt(value);
  if (value instanceof ObjectId) return value.toString();
  // Before the Binary branch: a UUID is a subtype-4 Binary, and its hex is what identifies it.
  const uuid = uuidText(value);
  if (uuid !== null) return uuid;
  if (value instanceof Binary) return `<Binary: ${value.length()} bytes>`;
  if (value instanceof Decimal128) return value.toString();
  if (value instanceof Date) return value.toISOString();
  // Only an echo of what the statement wrote (`insertedId` of a `$numberDouble`
  // `_id`) is a Double here: the driver promotes every double it reads to a number.
  if (value instanceof mongodbDriver.BSON.Double) return value.valueOf();
  if (Array.isArray(value)) return value.map((entry) => serializeMongoValue(entry));
  const scalar = bsonScalarText(value);
  if (scalar !== undefined) return scalar;
  return serializeMongoDocument(value as Document);
}

/** One document through the value rules above, as both the grid and the agent profile read it. */
export function serializeMongoDocument(doc: Document): Record<string, unknown> {
  const serialized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) serialized[key] = serializeMongoValue(value);
  return serialized;
}

/**
 * The BSON class a driver value is an instance of, read from the `_bsontype` every BSON class
 * carries. Read by NAME and not by `instanceof` for the reason `isServerErrorReply` in `index.ts`
 * gives: the integration suite replaces the driver module, so only a name is the same on both sides.
 */
export function bsonTypeOf(value: object): string | undefined {
  // A BSON class declares it on its prototype; a document's own field of that name is data.
  if (Object.hasOwn(value, "_bsontype")) return undefined;
  const name = (value as { _bsontype?: unknown })._bsontype;
  return typeof name === "string" ? name : undefined;
}

/** The Binary subtype of a UUID (BSON spec, subtype 4). */
const BINARY_SUBTYPE_UUID = 4;

/** A UUID in its dashed hex form, or null for any other value, a subtype-4 Binary of another length included. */
export function uuidText(value: object): string | null {
  if (bsonTypeOf(value) !== "Binary") return null;
  const binary = value as InstanceType<typeof mongodbDriver.BSON.Binary>;
  if (binary.sub_type !== BINARY_SUBTYPE_UUID) return null;
  const hex = binary.toString("hex");
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The grid text of a BSON value the classic branches of `serializeMongoValue` do not know, or
 * undefined for a value that is not a BSON class (#1423).
 *
 * Each of these used to fall through to the subdocument branch, which copies a value's own
 * enumerable fields: measured on MongoDB 8.2.12, a Long above 2^53 showed as
 * `{"high":2097152,"low":1,"unsigned":false}`, a Timestamp the same way, a regular expression
 * as `{}` (its pattern lost) and a UUID as `<Binary: 16 bytes>`. A Long is its decimal digits,
 * as other providers carry a 64-bit integer; a Timestamp is `Timestamp(t, i)`, the shell's own
 * spelling; a regular expression is `/pattern/flags`; a UUID is its dashed hex, read before this
 * by `uuidText`. Every other BSON class (Code, MinKey, MaxKey, DBRef, BSONSymbol) is its relaxed
 * Extended JSON text.
 */
function bsonScalarText(value: object): string | number | undefined {
  // The driver reads a BSON regular expression back as a native RegExp unless asked otherwise.
  if (value instanceof RegExp) return String(value);
  switch (bsonTypeOf(value)) {
    case undefined:
      return undefined;
    case "Long":
      return String(value);
    case "Timestamp": {
      const timestamp = value as InstanceType<typeof mongodbDriver.BSON.Timestamp>;
      return `Timestamp(${timestamp.t}, ${timestamp.i})`;
    }
    case "BSONRegExp": {
      const regexp = value as InstanceType<typeof mongodbDriver.BSON.BSONRegExp>;
      return `/${regexp.pattern}/${regexp.options}`;
    }
    case "Int32":
      return Number(value.valueOf());
    default:
      return mongodbDriver.BSON.EJSON.stringify(value, { relaxed: true });
  }
}
