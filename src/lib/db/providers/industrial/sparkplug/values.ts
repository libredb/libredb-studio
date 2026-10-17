/**
 * A Sparkplug metric's wire value turned into what a cell shows, by its DATATYPE and never by
 * the wire field that happens to be set (spec 6.4.16, 6.4.17).
 *
 * The whole module exists because of three measured facts, each of which produces a wrong number
 * rather than an error if the obvious thing is done instead:
 *
 * 1. MEASURED 2026-10-13 against Eclipse Tahu `sparkplug-payload` 1.0.3 under Bun 1.4.2 and
 *    Node 24.14.0: Tahu writes the narrow signed types as 32-bit two's complement, so Int8 -1
 *    arrives as `int_value` 4294967295 and Int16 -32768 as 4294934528. Reading `int_value` as
 *    the value gives a positive number near four billion for every negative reading.
 * 2. MEASURED the same day: Tahu puts UInt32 4294967295 in `long_value`, not `int_value`. So the
 *    field that is set does NOT identify the type, and a decoder that infers the type from the
 *    field reads a UInt32 as an Int64 or a DateTime.
 * 3. MEASURED the same day: a JavaScript number holds integers exactly only to 2^53, and Int64,
 *    UInt64, DateTime, `seq`, `alias` and MetaData sizes are all 64-bit (6.4.5, 6.4.6). They are
 *    carried as decimal TEXT end to end; 2^63-1 and 2^64-1 round-trip exactly that way.
 *    (Measured in passing: Tahu's own decoder returns a signed Int64 -5 as
 *    `{low:-5,high:-1,unsigned:true}`, so a caller that trusts its flag reads 18446744073709551611.
 *    This module never reads another decoder's output.)
 *
 * Pure. Takes bytes and a datatype, returns a view. No I/O.
 */

import { MAX_HEX_BYTES_IN_CELL } from "./constants";

/** The 35 datatypes of 6.4.16, by their wire number. */
export const DATATYPES = Object.freeze({
  0: "Unknown",
  1: "Int8",
  2: "Int16",
  3: "Int32",
  4: "Int64",
  5: "UInt8",
  6: "UInt16",
  7: "UInt32",
  8: "UInt64",
  9: "Float",
  10: "Double",
  11: "Boolean",
  12: "String",
  13: "DateTime",
  14: "Text",
  15: "UUID",
  16: "DataSet",
  17: "Bytes",
  18: "File",
  19: "Template",
  20: "PropertySet",
  21: "PropertySetList",
  22: "Int8Array",
  23: "Int16Array",
  24: "Int32Array",
  25: "Int64Array",
  26: "UInt8Array",
  27: "UInt16Array",
  28: "UInt32Array",
  29: "UInt64Array",
  30: "FloatArray",
  31: "DoubleArray",
  32: "BooleanArray",
  33: "StringArray",
  34: "DateTimeArray",
} as const);

export type DatatypeNumber = keyof typeof DATATYPES;
export type DatatypeName = (typeof DATATYPES)[DatatypeNumber];

export function datatypeName(datatype: number): DatatypeName | undefined {
  return Object.hasOwn(DATATYPES, datatype) ? DATATYPES[datatype as DatatypeNumber] : undefined;
}

/** The signed integer types and the width their sign must be recovered from. */
const SIGNED_WIDTHS: Readonly<Record<number, 8 | 16 | 32 | 64>> = Object.freeze({
  1: 8,
  2: 16,
  3: 32,
  4: 64,
});

/** The element width, in bytes, of each fixed-width array type (6.4.17). */
const ARRAY_ELEMENT: Readonly<Record<number, { bytes: 1 | 2 | 4 | 8; signed: boolean; float: boolean }>> =
  Object.freeze({
    22: { bytes: 1, signed: true, float: false },
    23: { bytes: 2, signed: true, float: false },
    24: { bytes: 4, signed: true, float: false },
    25: { bytes: 8, signed: true, float: false },
    26: { bytes: 1, signed: false, float: false },
    27: { bytes: 2, signed: false, float: false },
    28: { bytes: 4, signed: false, float: false },
    29: { bytes: 8, signed: false, float: false },
    30: { bytes: 4, signed: false, float: true },
    31: { bytes: 8, signed: false, float: true },
    34: { bytes: 8, signed: false, float: false },
  });

/**
 * What a cell shows for one metric value.
 *
 * `text` is always safe to render: a string that is not valid UTF-8 becomes hex with a notice
 * rather than replacement characters, because U+FFFD loses the bytes and the user cannot tell a
 * broken encoding from a metric whose value really contains U+FFFD.
 */
export interface MetricValueView {
  readonly text: string;
  readonly datatype: DatatypeName;
  /** Set when the value could not be read as its datatype asks; the text then says what arrived. */
  readonly problem?: "wire-field-missing" | "wire-field-mismatch" | "length-not-a-multiple" | "not-utf8" | "ambiguous";
  /** True when `text` is a hex dump rather than a value. */
  readonly hex?: boolean;
}

/** The wire fields a Metric's `value` oneof can carry (6.4.5). Exactly one is set, or none. */
export interface MetricWireValue {
  readonly intValue?: string;
  readonly longValue?: string;
  readonly floatValue?: number;
  readonly doubleValue?: number;
  readonly booleanValue?: boolean;
  readonly stringValue?: string;
  readonly bytesValue?: Uint8Array;
  readonly isNull?: boolean;
}

function hex(bytes: Uint8Array, limit = MAX_HEX_BYTES_IN_CELL): string {
  const shown = bytes.subarray(0, limit);
  const text = Array.from(shown, (b) => b.toString(16).padStart(2, "0")).join(" ");
  return bytes.length > limit ? `${text} ... (${bytes.length} bytes)` : text;
}

/**
 * Recover a signed value from the unsigned field it was written into.
 *
 * `BigInt.asIntN` reads BOTH forms: Tahu's 32-bit two's complement for a narrow type (Int8 -1 as
 * 4294967295) and a producer that writes the narrow form instead (Int8 -1 as 255), because
 * sign-extending from the datatype's own width maps each onto the same negative value. A value
 * that fits neither is flagged rather than silently truncated, which is what section 6 item 7 of
 * the proposal measures other producers for.
 */
export function signedFromWire(raw: bigint, width: 8 | 16 | 32 | 64): { value: bigint; narrowed: boolean } {
  const narrow = BigInt.asIntN(width, raw);
  if (width === 64) return { value: narrow, narrowed: false };
  // A 32-bit two's complement form of a narrow type: the low `width` bits already carry the value,
  // so asIntN over the full 32 bits and over `width` agree. They disagree only when the producer
  // put something in the bits above `width` that is not sign fill, which is worth saying.
  const from32 = BigInt.asIntN(32, raw);
  const narrowed = BigInt.asIntN(width, from32) !== from32;
  return { value: narrow, narrowed };
}

/** Unpack one fixed-width little-endian array (6.4.17: "simply little-endian packed byte arrays"). */
function unpackFixed(bytes: Uint8Array, datatype: number): MetricValueView | string[] {
  const spec = ARRAY_ELEMENT[datatype];
  const name = DATATYPES[datatype as DatatypeNumber];
  if (bytes.length % spec.bytes !== 0) {
    return {
      text: hex(bytes),
      datatype: name,
      problem: "length-not-a-multiple",
      hex: true,
    };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: string[] = [];
  for (let at = 0; at < bytes.length; at += spec.bytes) {
    if (spec.float) {
      out.push(String(spec.bytes === 4 ? view.getFloat32(at, true) : view.getFloat64(at, true)));
      continue;
    }
    switch (spec.bytes) {
      case 1:
        out.push(String(spec.signed ? view.getInt8(at) : view.getUint8(at)));
        break;
      case 2:
        out.push(String(spec.signed ? view.getInt16(at, true) : view.getUint16(at, true)));
        break;
      case 4:
        out.push(String(spec.signed ? view.getInt32(at, true) : view.getUint32(at, true)));
        break;
      default:
        // 64-bit elements stay decimal text for the reason the module header gives.
        out.push(String(spec.signed ? view.getBigInt64(at, true) : view.getBigUint64(at, true)));
        break;
    }
  }
  return out;
}

/**
 * Unpack a BooleanArray: a 4-byte little-endian COUNT, then the bits packed most significant
 * first (6.4.17).
 *
 * Computed 2026-10-13 from the 6.4.17 sentence under Bun and Node and again with Python's
 * `struct`: a 9-value array is `09 00 00 00 B0 80`. The specification's note says a padding bit
 * "can be either 1 or 0", so the padding is ignored rather than read.
 */
function unpackBooleans(bytes: Uint8Array): MetricValueView | string[] {
  if (bytes.length < 4) {
    return { text: hex(bytes), datatype: "BooleanArray", problem: "length-not-a-multiple", hex: true };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  const bits = bytes.subarray(4);
  if (bits.length !== Math.ceil(count / 8)) {
    return { text: hex(bytes), datatype: "BooleanArray", problem: "length-not-a-multiple", hex: true };
  }
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const byte = bits[Math.floor(i / 8)] ?? 0;
    out.push(String((byte & (0x80 >> (i % 8))) !== 0));
  }
  return out;
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });

/**
 * A StringArray is a run of NUL-terminated strings (6.4.17), which is ambiguous by construction:
 * an empty string is a lone `00`, and a string that CONTAINS a NUL cannot be told from two
 * strings. Such an array is shown as its bytes with a notice rather than split into a guess.
 */
function unpackStrings(bytes: Uint8Array): MetricValueView | string[] {
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== 0x00) {
    return { text: hex(bytes), datatype: "StringArray", problem: "ambiguous", hex: true };
  }
  const out: string[] = [];
  let start = 0;
  for (let at = 0; at < bytes.length; at++) {
    if (bytes[at] !== 0x00) continue;
    try {
      out.push(utf8Strict.decode(bytes.subarray(start, at)));
    } catch {
      return { text: hex(bytes), datatype: "StringArray", problem: "not-utf8", hex: true };
    }
    start = at + 1;
  }
  return out;
}

/**
 * Read one metric value under the datatype its BIRTH gave it.
 *
 * `datatype` is never taken from the message carrying the value: 6.4.6 says a data message
 * "SHOULD NOT" include the datatype and MUST leave the name out where aliases are used, so the
 * only authority is the birth (SP-S7). A caller with no birth in hand must not call this; it shows
 * the wire field unresolved instead.
 */
export function readMetricValue(datatype: number, wire: MetricWireValue): MetricValueView {
  const name = datatypeName(datatype);
  if (name === undefined) {
    return { text: `unknown datatype ${datatype}`, datatype: "Unknown", problem: "wire-field-mismatch" };
  }
  if (wire.isNull === true) return { text: "null", datatype: name };

  const signedWidth = SIGNED_WIDTHS[datatype];
  if (signedWidth !== undefined) {
    // Accept either integer field, because Tahu puts UInt32 in `long_value` and a narrow signed
    // type in `int_value`; the datatype decides, not the field (measured fact 2 in the header).
    const raw = wire.intValue ?? wire.longValue;
    if (raw === undefined) return { text: "", datatype: name, problem: "wire-field-missing" };
    const { value, narrowed } = signedFromWire(BigInt(raw), signedWidth);
    return narrowed
      ? { text: value.toString(), datatype: name, problem: "wire-field-mismatch" }
      : { text: value.toString(), datatype: name };
  }

  switch (name) {
    case "UInt8":
    case "UInt16":
    case "UInt32":
    case "UInt64":
    case "DateTime": {
      const raw = wire.intValue ?? wire.longValue;
      if (raw === undefined) return { text: "", datatype: name, problem: "wire-field-missing" };
      // Decimal text, not a number: DateTime and UInt64 both reach 2^64-1 (measured fact 3).
      return { text: BigInt.asUintN(64, BigInt(raw)).toString(), datatype: name };
    }
    case "Float":
    case "Double": {
      const raw = wire.floatValue ?? wire.doubleValue;
      if (raw === undefined) return { text: "", datatype: name, problem: "wire-field-missing" };
      return { text: String(raw), datatype: name };
    }
    case "Boolean":
      if (wire.booleanValue === undefined) return { text: "", datatype: name, problem: "wire-field-missing" };
      return { text: String(wire.booleanValue), datatype: name };
    case "String":
    case "Text":
    case "UUID":
      if (wire.stringValue === undefined) return { text: "", datatype: name, problem: "wire-field-missing" };
      return { text: wire.stringValue, datatype: name };
    case "Bytes":
    case "File":
      if (wire.bytesValue === undefined) return { text: "", datatype: name, problem: "wire-field-missing" };
      // Shown as hex with its MetaData by the caller, never written to disk or opened (SP-S11).
      return { text: hex(wire.bytesValue), datatype: name, hex: true };
    case "BooleanArray": {
      if (wire.bytesValue === undefined) return { text: "", datatype: name, problem: "wire-field-missing" };
      const read = unpackBooleans(wire.bytesValue);
      return Array.isArray(read) ? { text: `[${read.join(", ")}]`, datatype: name } : read;
    }
    case "StringArray": {
      if (wire.bytesValue === undefined) return { text: "", datatype: name, problem: "wire-field-missing" };
      const read = unpackStrings(wire.bytesValue);
      return Array.isArray(read) ? { text: `[${read.join(", ")}]`, datatype: name } : read;
    }
    default:
      break;
  }

  if (Object.hasOwn(ARRAY_ELEMENT, datatype)) {
    if (wire.bytesValue === undefined) return { text: "", datatype: name, problem: "wire-field-missing" };
    const read = unpackFixed(wire.bytesValue, datatype);
    return Array.isArray(read) ? { text: `[${read.join(", ")}]`, datatype: name } : read;
  }

  // DataSet, Template, PropertySet and PropertySetList are structures rather than scalars: the
  // objects layer renders them, and this module declines rather than flattening them to text.
  return { text: "", datatype: name, problem: "wire-field-mismatch" };
}
