/**
 * Firestore REST `Value`s to grid cells, Firestore type names, and (encoding half) console literals to REST values.
 *
 * Decoding branches on the one REST key a value carries, never on the JSON form of its number, and reads both
 * spellings of null and of the double specials (spec 5.6). A value Studio cannot read is an explicit QueryError.
 * Browser-safe.
 */
import { QueryError } from "@/lib/db/errors";
import { FIRESTORE_ERROR_PROVIDER } from "./constants";
import { type FirestoreTarget, relativeSegments } from "./names";

/** A REST `Value`: exactly one key. */
export type RestValue = Readonly<Record<string, unknown>>;

export type FirestoreTypeName =
  | "null"
  | "boolean"
  | "integer"
  | "double"
  | "timestamp"
  | "string"
  | "bytes"
  | "reference"
  | "geopoint"
  | "array"
  | "map"
  | "vector"
  | "minKey"
  | "maxKey"
  | "regex"
  | "objectId"
  | "int32"
  | "decimal128"
  | "bsonTimestamp"
  | "bsonBinary";

export interface RestDocument {
  readonly name: string;
  readonly fields?: Readonly<Record<string, RestValue>>;
  readonly createTime?: string;
  readonly updateTime?: string;
}

export type Literal =
  | { kind: "null" }
  | { kind: "boolean"; value: boolean }
  | { kind: "integer"; text: string }
  | { kind: "double"; value: number | "NaN" | "Infinity" | "-Infinity" }
  | { kind: "string"; value: string }
  | { kind: "timestamp"; seconds: string; nanos: number }
  | { kind: "geopoint"; latitude: number; longitude: number }
  | { kind: "reference"; segments: readonly string[] }
  | { kind: "vector"; values: readonly number[] }
  | { kind: "array"; items: readonly Literal[] }
  | { kind: "map"; entries: readonly (readonly [string, Literal])[] };

/** Every REST key but `mapValue`, whose type depends on its fields. */
const SCALAR_TYPES = new Map<string, FirestoreTypeName>([
  ["nullValue", "null"],
  ["booleanValue", "boolean"],
  ["integerValue", "integer"],
  ["doubleValue", "double"],
  ["timestampValue", "timestamp"],
  ["stringValue", "string"],
  ["bytesValue", "bytes"],
  ["referenceValue", "reference"],
  ["geoPointValue", "geopoint"],
  ["arrayValue", "array"],
]);
/** The one-key maps Enterprise databases that also serve the MongoDB API store BSON types as; `__int__` is checked apart. */
const BSON_TYPES = new Map<string, FirestoreTypeName>([
  ["__min__", "minKey"],
  ["__max__", "maxKey"],
  ["__regex__", "regex"],
  ["__oid__", "objectId"],
  ["__decimal128__", "decimal128"],
  ["__request_timestamp__", "bsonTimestamp"],
  ["__binary__", "bsonBinary"],
]);
const DOUBLE_SPECIALS = new Set(["NaN", "Infinity", "-Infinity"]);
const INTEGER_TEXT = /^-?\d+$/;
const DOUBLE_TEXT = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const VECTOR_TYPE = "__vector__";

export const VALUE_SENTENCES = Object.freeze({
  unreadable: (what: string): string => `Firestore answered a value Studio cannot read: ${what}`,
});

export function decodeValue(value: RestValue, target: FirestoreTarget): unknown {
  const key = valueKey(value);
  const raw = value[key];
  if (key === "nullValue") {
    if (raw === null || raw === "NULL_VALUE") return null;
  } else if (key === "booleanValue") {
    if (typeof raw === "boolean") return raw;
  } else if (key === "integerValue") {
    return decodeInteger(raw);
  } else if (key === "doubleValue") {
    return decodeDouble(raw);
  } else if (key === "timestampValue" || key === "stringValue") {
    if (typeof raw === "string") return raw;
  } else if (key === "bytesValue") {
    if (typeof raw === "string") return { bytesValue: raw };
  } else if (key === "referenceValue") {
    if (typeof raw === "string") return { referenceValue: referenceCell(raw, target) };
  } else if (key === "geoPointValue") {
    const point = recordOf(raw, key);
    return { geoPointValue: { latitude: coordinate(point.latitude), longitude: coordinate(point.longitude) } };
  } else if (key === "arrayValue") {
    return valuesOf(raw).map((item) => decodeValue(item, target));
  } else {
    const fields = fieldsOf(raw);
    return isVectorFields(fields)
      ? { __type__: VECTOR_TYPE, value: vectorCells(fields, target) }
      : decodeFields(fields, target);
  }
  throw refuse(VALUE_SENTENCES.unreadable(key));
}

export function decodeFields(fields: RestDocument["fields"], target: FirestoreTarget): Record<string, unknown> {
  if (fields === undefined) return {};
  // fromEntries defines own properties, so a field named "__proto__" stays a field.
  return Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, decodeValue(value, target)]));
}

export function typeNameOf(value: RestValue): FirestoreTypeName {
  const key = valueKey(value);
  return SCALAR_TYPES.get(key) ?? mapTypeName(fieldsOf(value[key]));
}

export function isVectorValue(value: RestValue): boolean {
  const key = valueKey(value);
  return key === "mapValue" && isVectorFields(fieldsOf(value[key]));
}

export function vectorOf(value: RestValue): number[] | null {
  if (!isVectorValue(value)) return null;
  const holder = fieldsOf(value.mapValue).value;
  if (holder === undefined) return [];
  if (valueKey(holder) !== "arrayValue") return null;
  const numbers: number[] = [];
  for (const element of valuesOf(holder.arrayValue)) {
    const key = valueKey(element);
    const decoded =
      key === "doubleValue" ? decodeDouble(element[key]) : key === "integerValue" ? decodeInteger(element[key]) : null;
    if (typeof decoded !== "number" || !Number.isFinite(decoded)) return null;
    numbers.push(decoded);
  }
  return numbers;
}

/** The one REST key of a value; anything else is unreadable. */
function valueKey(value: unknown): string {
  if (!isRecord(value)) throw refuse(VALUE_SENTENCES.unreadable("a value that is not an object"));
  const keys = Object.keys(value);
  const [key] = keys;
  if (keys.length !== 1 || key === undefined)
    throw refuse(VALUE_SENTENCES.unreadable(`${keys.length} keys in one value`));
  if (!SCALAR_TYPES.has(key) && key !== "mapValue")
    throw refuse(VALUE_SENTENCES.unreadable(`the key ${key.slice(0, 60)}`));
  return key;
}

function decodeInteger(raw: unknown): number | string {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return raw;
  if (typeof raw !== "string" || !INTEGER_TEXT.test(raw)) throw refuse(VALUE_SENTENCES.unreadable("integerValue"));
  const integer = BigInt(raw);
  return integer <= MAX_SAFE && integer >= -MAX_SAFE ? Number(integer) : integer.toString();
}

function decodeDouble(raw: unknown): number | string {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && DOUBLE_SPECIALS.has(raw)) return raw;
  if (typeof raw === "string" && DOUBLE_TEXT.test(raw)) return Number(raw);
  throw refuse(VALUE_SENTENCES.unreadable("doubleValue"));
}

/** Relative to the documents root when it points into this database, the full name otherwise. */
function referenceCell(name: string, target: FirestoreTarget): string {
  const segments = relativeSegments(target, name);
  return segments !== null && segments.length > 0 ? segments.join("/") : name;
}

function coordinate(raw: unknown): number {
  if (raw === undefined) return 0;
  if (typeof raw === "number") return raw;
  throw refuse(VALUE_SENTENCES.unreadable("geoPointValue"));
}

function valuesOf(raw: unknown): readonly RestValue[] {
  const values = recordOf(raw, "arrayValue").values;
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw refuse(VALUE_SENTENCES.unreadable("arrayValue"));
  return values as readonly RestValue[];
}

function fieldsOf(raw: unknown): Readonly<Record<string, RestValue>> {
  const fields = recordOf(raw, "mapValue").fields;
  if (fields === undefined) return {};
  return recordOf(fields, "mapValue") as Readonly<Record<string, RestValue>>;
}

/** The SDK's rule: a `__type__` field holding the string "__vector__", whatever else the map holds. */
function isVectorFields(fields: Readonly<Record<string, RestValue>>): boolean {
  const type = fields.__type__;
  return isRecord(type) && Object.keys(type).length === 1 && type.stringValue === VECTOR_TYPE;
}

function vectorCells(fields: Readonly<Record<string, RestValue>>, target: FirestoreTarget): unknown[] {
  const holder = fields.value;
  if (holder === undefined) return [];
  const cells = decodeValue(holder, target);
  if (!Array.isArray(cells)) throw refuse(VALUE_SENTENCES.unreadable("a vector whose value is not an array"));
  return cells;
}

function mapTypeName(fields: Readonly<Record<string, RestValue>>): FirestoreTypeName {
  if (isVectorFields(fields)) return "vector";
  const keys = Object.keys(fields);
  const [only] = keys;
  if (keys.length !== 1 || only === undefined) return "map";
  if (only === "__int__")
    return isRecord(fields.__int__) && fields.__int__.integerValue !== undefined ? "int32" : "map";
  return BSON_TYPES.get(only) ?? "map";
}

function recordOf(raw: unknown, what: string): Readonly<Record<string, unknown>> {
  if (!isRecord(raw)) throw refuse(VALUE_SENTENCES.unreadable(what));
  return raw;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuse(message: string): QueryError {
  return new QueryError(message, FIRESTORE_ERROR_PROVIDER);
}
