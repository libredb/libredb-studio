/**
 * Firestore REST `Value`s to grid cells, Firestore type names, and (encoding half) console literals to REST values.
 *
 * Decoding branches on the one REST key a value carries, never on the JSON form of its number, and reads both
 * spellings of null and of the double specials (spec 5.6). A value Studio cannot read is an explicit QueryError.
 * Browser-safe.
 */
import { QueryError } from "@/lib/db/errors";
import { FIRESTORE_TYPE, LIMITS } from "./constants";
import { type FirestoreTarget, fullDocumentName, isDocumentPath, relativeSegments, segmentsRefusal } from "./names";

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
const VECTOR_TYPE = "__vector__";
/** 0001-01-01T00:00:00Z and 9999-12-31T23:59:59Z in Unix seconds. */
const MIN_SECONDS = BigInt("-62135596800");
const MAX_SECONDS = BigInt("253402300799");
const MAX_NANOS = 999_999_999;

export const VALUE_SENTENCES = Object.freeze({
  unreadable: (what: string): string => `Firestore answered a value Studio cannot read: ${what}`,
  integerText: "An integer literal must be decimal digits with an optional leading minus sign",
  integerRange:
    "An integer must lie between -9223372036854775808 and 9223372036854775807, Firestore's 64-bit range; write a fraction or an exponent for a double",
  doubleRange: "A number literal must be a finite double",
  stringMalformed: "A string or map key must be well-formed Unicode text",
  timestampRange: "A timestamp must lie between 0001-01-01T00:00:00Z and 9999-12-31T23:59:59.999999999Z",
  timestampNanos: "Timestamp nanoseconds must be an integer from 0 to 999,999,999",
  latitude: "A GeoPoint latitude must be a number from -90 to 90",
  longitude: "A GeoPoint longitude must be a number from -180 to 180",
  referencePath: "db.doc() takes a document path: an even number of segments, such as users/alice",
  vectorElement: "A vector holds finite numbers only",
  vectorDimensions: "A vector holds at most 2,048 numbers",
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
  // Converting first is exact for every safe integer, and rounds anything past 2^53 to a value Number.isSafeInteger refuses.
  return Number.isSafeInteger(Number(integer)) ? Number(integer) : integer.toString();
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
  return new QueryError(message, FIRESTORE_TYPE);
}

export function encodeLiteral(literal: Literal, target: FirestoreTarget): RestValue {
  switch (literal.kind) {
    case "null":
      return { nullValue: null };
    case "boolean":
      return { booleanValue: literal.value };
    case "integer":
      return { integerValue: canonicalInteger(literal.text) };
    case "double":
      return { doubleValue: encodeDouble(literal.value) };
    case "string":
      return { stringValue: wellFormed(literal.value) };
    case "timestamp":
      return { timestampValue: timestampText(literal.seconds, literal.nanos) };
    case "geopoint":
      return { geoPointValue: geoPoint(literal.latitude, literal.longitude) };
    case "reference":
      return { referenceValue: referenceName(literal.segments, target) };
    case "vector":
      return vectorValue(literal.values);
    case "array":
      return { arrayValue: { values: literal.items.map((item) => encodeLiteral(item, target)) } };
    case "map":
      return {
        mapValue: {
          fields: Object.fromEntries(
            literal.entries.map(([key, value]) => [wellFormed(key), encodeLiteral(value, target)]),
          ),
        },
      };
  }
}

function canonicalInteger(text: string): string {
  if (!INTEGER_TEXT.test(text)) throw refuse(VALUE_SENTENCES.integerText);
  const integer = BigInt(text);
  // A Firestore integer is a signed 64-bit value: asIntN wraps anything outside that range to a different number.
  if (BigInt.asIntN(64, integer) !== integer) throw refuse(VALUE_SENTENCES.integerRange);
  return integer.toString();
}

function encodeDouble(value: number | "NaN" | "Infinity" | "-Infinity"): number | string {
  if (typeof value === "string") return value;
  if (!Number.isFinite(value)) throw refuse(VALUE_SENTENCES.doubleRange);
  return value;
}

function wellFormed(text: string): string {
  if (!text.isWellFormed()) throw refuse(VALUE_SENTENCES.stringMalformed);
  return text;
}

/** RFC 3339 in UTC; nine fraction digits when nanos is not 0, none otherwise. */
function timestampText(seconds: string, nanos: number): string {
  if (!Number.isInteger(nanos) || nanos < 0 || nanos > MAX_NANOS) throw refuse(VALUE_SENTENCES.timestampNanos);
  if (!INTEGER_TEXT.test(seconds)) throw refuse(VALUE_SENTENCES.timestampRange);
  const whole = BigInt(seconds);
  if (whole < MIN_SECONDS || whole > MAX_SECONDS) throw refuse(VALUE_SENTENCES.timestampRange);
  const second = new Date(Number(whole) * 1000).toISOString().slice(0, 19);
  return nanos === 0 ? `${second}Z` : `${second}.${String(nanos).padStart(9, "0")}Z`;
}

function geoPoint(latitude: number, longitude: number): { latitude: number; longitude: number } {
  if (!(Number.isFinite(latitude) && latitude >= -90 && latitude <= 90)) throw refuse(VALUE_SENTENCES.latitude);
  if (!(Number.isFinite(longitude) && longitude >= -180 && longitude <= 180)) throw refuse(VALUE_SENTENCES.longitude);
  return { latitude, longitude };
}

function referenceName(segments: readonly string[], target: FirestoreTarget): string {
  if (!isDocumentPath(segments)) throw refuse(VALUE_SENTENCES.referencePath);
  const refusal = segmentsRefusal(segments);
  if (refusal !== null) throw refuse(refusal);
  return fullDocumentName(target, segments);
}

function vectorValue(values: readonly number[]): RestValue {
  if (values.length > LIMITS.maxVectorDimensions) throw refuse(VALUE_SENTENCES.vectorDimensions);
  if (!values.every((value) => Number.isFinite(value))) throw refuse(VALUE_SENTENCES.vectorElement);
  return {
    mapValue: {
      fields: {
        __type__: { stringValue: VECTOR_TYPE },
        value: { arrayValue: { values: values.map((value) => ({ doubleValue: value })) } },
      },
    },
  };
}
