/**
 * Studio's value codec: the one form a value takes when it crosses a JSON boundary.
 *
 * JSON carries null, booleans, strings, finite numbers, arrays and objects. Every other
 * value Studio reads from a database is written as a TAGGED VALUE: an object whose own
 * keys are exactly `$` (the tag) and `v` (its payload, always a string or an object).
 *
 * | tag     | JavaScript value                                   | payload                                   |
 * |---------|----------------------------------------------------|-------------------------------------------|
 * | `i64`   | a `bigint` from -2^63 to 2^64 - 1                  | its decimal digits, no sign but `-`, no leading zero |
 * | `bytes` | a `Uint8Array` (a `Buffer` is one)                 | standard base64 with padding, canonical   |
 * | `ts`    | a valid `Date`                                     | exactly what `toISOString` writes         |
 * | `nf`    | `NaN`, `Infinity`, `-Infinity`                     | `"NaN"`, `"Infinity"`, `"-Infinity"`      |
 * | `obj`   | a data object whose own keys are exactly `$`, `v`  | that object with its two values encoded   |
 *
 * The tags are the manifest schema's `$defs/valueTag`, typed `ValueTag`, and
 * `packages/provider-sdk/tests/values/tags.test.ts` holds this table to that list.
 *
 * `obj` is the escape: without it a row with columns named `$` and `v` would be read
 * back as a tag. With it, an object with exactly those two keys is ALWAYS a tag on the
 * wire, and nothing a database hands back is ever mistaken for one.
 *
 * The domain is closed. `encodeValue` accepts the values above, the JSON values, arrays
 * without holes and objects whose prototype is `Object.prototype` or `null` (read by
 * their own enumerable string keys; no `toJSON` is called), and writes `-0` as `0`, as
 * JSON does. An object member whose value is `undefined` is left out, as JSON leaves it
 * out, and the `obj` escape is decided on the members written. Anything else (`undefined`
 * at the root or in an array, a function, a symbol, an invalid `Date`, a typed array other
 * than `Uint8Array`, an `ArrayBuffer`, a `Map`, a `Set`, an `Error`, a boxed primitive, a
 * class instance, an array hole, a wider `bigint`, an array or object nested inside
 * `MAX_VALUE_DEPTH` others, which a cycle always is) is refused with a `ValueCodecError`
 * naming the kind and the JSON Pointer of the place, never the value.
 *
 * `decodeValue` is strict and canonical: an unknown tag, a payload of the wrong type or
 * in a non-canonical spelling, any value `JSON.parse` cannot produce (meeting one means
 * a value skipped the encoder) and nesting past `MAX_VALUE_DEPTH` are refused the same
 * way. Decoded bytes are a plain `Uint8Array`; decoded objects have `Object.prototype` and own data properties, so a
 * `__proto__` key stays a key. A refusal's path points into the VALUE: a tagged value
 * counts as the one value it carries, so `/0/k` names the same place on both sides.
 *
 * No Node-only global is used (base64 is written and read through lookup tables), so the module
 * loads in the browser and the VS Code webview as well as on the server.
 *
 * The SQLite worker's child runs from `node -e` and cannot import this module, so its
 * bootstrap carries a plain-JavaScript copy restricted to what the child binds and reads
 * (`ser` and `deser` in `src/lib/db/providers/sql/sqlite-worker.ts`). Its agreement with
 * this module is held by round trips through the real child in
 * `tests/integration/db/sqlite-worker.test.ts`.
 */

/** A value as it stands on the wire: plain JSON. */
export type WireValue = null | boolean | number | string | WireValue[] | { [key: string]: WireValue };

/** A value the codec refuses, with the JSON Pointer of the place it stood. */
export class ValueCodecError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(message);
    this.name = "ValueCodecError";
    this.path = path;
  }
}

/**
 * The most arrays and objects a value may be nested inside (CONTRACT.md V-8). An array or a data object inside this
 * many others is refused on encode and on decode, so a deep or cyclic value is refused by name and never overflows the
 * stack. A tagged value counts as the one value it carries: the wire's tag wrapper adds no level. 256 clears every
 * engine's own JSON nesting limit (MongoDB and MySQL nest at most 100 levels, SQL Server 128) with room for the rows
 * around a document, and sits ten times below the shallowest stack overflow measured (2721 objects, encoding on
 * Node 24).
 */
export const MAX_VALUE_DEPTH = 256;

const MIN_I64 = -(BigInt(2) ** BigInt(63));
const MAX_U64 = BigInt(2) ** BigInt(64) - BigInt(1);
/** The longest canonical digits in range: "-9223372036854775808" and "18446744073709551615". */
const MAX_I64_DIGITS = 20;
const I64_DIGITS = /^(?:0|-?[1-9][0-9]*)$/;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Each character code's 6-bit value in the standard alphabet, -1 for every other code below 128. */
const BASE64_VALUES = Int8Array.from({ length: 128 }, (_, code) => BASE64_ALPHABET.indexOf(String.fromCharCode(code)));
/** The alphabet's character codes, by 6-bit value. */
const BASE64_CODES = Uint8Array.from(BASE64_ALPHABET, (char) => char.charCodeAt(0));
const PAD_CODE = 0x3d;
/** Reads the encoder's ASCII bytes as text; every byte it writes is below 128, so UTF-8 reads it as is. */
const ASCII = new TextDecoder();

/** The JSON Pointer (RFC 6901) of the place `segments` names. */
function pointer(segments: readonly string[]): string {
  return segments.map((segment) => `/${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

function refuse(verb: "encode" | "decode", kind: string, segments: readonly string[]): never {
  const path = pointer(segments);
  throw new ValueCodecError(
    `The value codec cannot ${verb} ${kind}, at ${path === "" ? "the root" : `"${path}"`}.`,
    path,
  );
}

/** Refuse an array or a data object that `segments` places inside MAX_VALUE_DEPTH others. */
function boundDepth(verb: "encode" | "decode", segments: readonly string[]): void {
  if (segments.length >= MAX_VALUE_DEPTH) {
    refuse(verb, `a value nested deeper than ${MAX_VALUE_DEPTH} arrays and objects`, segments);
  }
}

function isDataObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Whether an object's own enumerable string keys are exactly `$` and `v`, in either order. */
function hasTagKeys(keys: readonly string[]): boolean {
  return keys.length === 2 && keys.includes("$") && keys.includes("v");
}

function isBoxedPrimitive(value: object): boolean {
  return (
    value instanceof Number ||
    value instanceof String ||
    value instanceof Boolean ||
    value instanceof BigInt ||
    value instanceof Symbol
  );
}

/** The kind of an object outside the domain, by its type and never by its contents. */
function objectKind(value: object): string {
  if (value instanceof Date) return "an invalid Date";
  if (value instanceof Map) return "a Map";
  if (value instanceof Set) return "a Set";
  if (value instanceof Error) return "an Error";
  if (value instanceof ArrayBuffer) return "an ArrayBuffer";
  if (ArrayBuffer.isView(value)) return `a ${value.constructor.name}`;
  if (isBoxedPrimitive(value)) return "a boxed primitive";
  const name = (value.constructor as { name?: unknown } | undefined)?.name;
  return typeof name === "string" && name !== "" ? `an instance of the class ${name}` : "an instance of a class";
}

/** Input bytes per chunk of `bytesToBase64`: a multiple of three, so only the last chunk is padded. */
const BYTES_PER_CHUNK = 3 * 4096;
/**
 * The ASCII the encoder writes for one chunk, reused by every call. Encoding is synchronous
 * and never re-enters itself, so one buffer serves; allocating one per cell cost V8 more
 * than the encoding (measured 2026-11-22: 100,000 three-byte cells took 95 ms on Node 24
 * with a fresh array each, against 23 ms through `Buffer`).
 */
const ASCII_CHUNK = new Uint8Array((BYTES_PER_CHUNK / 3) * 4);

/**
 * Standard padded base64, written by one pass over a lookup table. Not `btoa`: measured
 * 2026-11-22 on a 16 MiB payload, `btoa` over a binary string took 210 ms on Bun 1.4.4
 * and 500 ms on Node 24, this table about 15 ms on both.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  for (let start = 0; start < bytes.length; start += BYTES_PER_CHUNK) {
    const end = Math.min(start + BYTES_PER_CHUNK, bytes.length);
    const fullGroupsEnd = end - ((end - start) % 3);
    let at = 0;
    let index = start;
    for (; index < fullGroupsEnd; index += 3) {
      const group = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
      ASCII_CHUNK[at++] = BASE64_CODES[group >>> 18];
      ASCII_CHUNK[at++] = BASE64_CODES[(group >>> 12) & 0x3f];
      ASCII_CHUNK[at++] = BASE64_CODES[(group >>> 6) & 0x3f];
      ASCII_CHUNK[at++] = BASE64_CODES[group & 0x3f];
    }
    const rest = end - fullGroupsEnd;
    if (rest > 0) {
      const group = (bytes[index] << 16) | (rest === 2 ? bytes[index + 1] << 8 : 0);
      ASCII_CHUNK[at++] = BASE64_CODES[group >>> 18];
      ASCII_CHUNK[at++] = BASE64_CODES[(group >>> 12) & 0x3f];
      ASCII_CHUNK[at++] = rest === 2 ? BASE64_CODES[(group >>> 6) & 0x3f] : PAD_CODE;
      ASCII_CHUNK[at++] = PAD_CODE;
    }
    text += ASCII.decode(ASCII_CHUNK.subarray(0, at));
  }
  return text;
}

/** The 6-bit value of the character at `index`, or -1 when it is not in the standard alphabet. */
function sextet(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code < 128 ? BASE64_VALUES[code] : -1;
}

/**
 * Decode standard padded base64, or answer null when `text` is not its canonical spelling:
 * a length that is not a multiple of four, a character outside the alphabet, padding
 * anywhere but the last one or two places, or unused trailing bits that are not zero.
 *
 * One linear pass over a lookup table, validating as it decodes. Not a regular expression
 * and `atob`: measured 2026-11-22, a pattern over a 16 MiB payload's text overflowed V8's
 * stack and made JavaScriptCore answer no match, and `atob` alone accepts non-canonical text.
 */
function base64ToBytes(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  const fullGroupsEnd = padding === 0 ? text.length : text.length - 4;
  let out = 0;
  for (let index = 0; index < fullGroupsEnd; index += 4) {
    const a = sextet(text, index);
    const b = sextet(text, index + 1);
    const c = sextet(text, index + 2);
    const d = sextet(text, index + 3);
    if ((a | b | c | d) < 0) return null;
    bytes[out++] = (a << 2) | (b >> 4);
    bytes[out++] = ((b & 0x0f) << 4) | (c >> 2);
    bytes[out++] = ((c & 0x03) << 6) | d;
  }
  if (padding === 0) return bytes;
  const a = sextet(text, fullGroupsEnd);
  const b = sextet(text, fullGroupsEnd + 1);
  if ((a | b) < 0) return null;
  bytes[out++] = (a << 2) | (b >> 4);
  if (padding === 2) return (b & 0x0f) === 0 ? bytes : null;
  const c = sextet(text, fullGroupsEnd + 2);
  if (c < 0 || (c & 0x03) !== 0) return null;
  bytes[out] = ((b & 0x0f) << 4) | (c >> 2);
  return bytes;
}

function encodeAt(value: unknown, segments: string[]): WireValue {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (Number.isFinite(value)) return value === 0 ? 0 : value;
      return { $: "nf", v: String(value) };
    case "bigint":
      if (value < MIN_I64 || value > MAX_U64) refuse("encode", "a bigint outside the 64-bit range", segments);
      return { $: "i64", v: value.toString() };
    case "undefined":
      return refuse("encode", "undefined", segments);
    case "function":
      return refuse("encode", "a function", segments);
    case "symbol":
      return refuse("encode", "a symbol", segments);
  }
  if (value === null) return null;
  const object = value as object;
  if (Array.isArray(object)) {
    boundDepth("encode", segments);
    const out: WireValue[] = new Array(object.length);
    for (let index = 0; index < object.length; index++) {
      segments.push(String(index));
      if (!(index in object)) refuse("encode", "an array hole", segments);
      out[index] = encodeAt(object[index], segments);
      segments.pop();
    }
    return out;
  }
  if (object instanceof Uint8Array) return { $: "bytes", v: bytesToBase64(object) };
  if (object instanceof Date && !Number.isNaN(object.getTime())) return { $: "ts", v: object.toISOString() };
  if (!isDataObject(object)) refuse("encode", objectKind(object), segments);
  boundDepth("encode", segments);
  const record = object as Record<string, unknown>;
  // A member whose value is undefined is left out, as JSON leaves it out (V-9); the escape is decided on the rest.
  const entries: [string, WireValue][] = [];
  for (const key of Object.keys(record)) {
    const member = record[key];
    if (member === undefined) continue;
    segments.push(key);
    entries.push([key, encodeAt(member, segments)]);
    segments.pop();
  }
  const out = Object.fromEntries(entries) as { [key: string]: WireValue };
  return hasTagKeys(entries.map(([key]) => key)) ? { $: "obj", v: out } : out;
}

/** Encode one value into its wire form; refuses a value outside the domain with `ValueCodecError`. */
export function encodeValue(value: unknown): WireValue {
  return encodeAt(value, []);
}

/** The JavaScript value one tagged wire value carries. */
function decodeTag(tag: unknown, payload: unknown, segments: string[]): unknown {
  switch (tag) {
    case "i64":
      if (typeof payload === "string" && payload.length <= MAX_I64_DIGITS && I64_DIGITS.test(payload)) {
        const value = BigInt(payload);
        if (value >= MIN_I64 && value <= MAX_U64) return value;
      }
      return refuse("decode", "an i64 payload that is not canonical 64-bit decimal digits", segments);
    case "bytes":
      if (typeof payload === "string") {
        const bytes = base64ToBytes(payload);
        if (bytes !== null) return bytes;
      }
      return refuse("decode", "a bytes payload that is not canonical padded base64", segments);
    case "ts":
      if (typeof payload === "string") {
        const date = new Date(payload);
        if (!Number.isNaN(date.getTime()) && date.toISOString() === payload) return date;
      }
      return refuse("decode", "a ts payload that is not the text toISOString writes", segments);
    case "nf":
      if (payload === "NaN") return Number.NaN;
      if (payload === "Infinity") return Number.POSITIVE_INFINITY;
      if (payload === "-Infinity") return Number.NEGATIVE_INFINITY;
      return refuse("decode", "an nf payload that is not NaN, Infinity or -Infinity", segments);
    case "obj":
      if (
        payload !== null &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        isDataObject(payload) &&
        hasTagKeys(Object.keys(payload))
      ) {
        return decodeEntries(payload as Record<string, unknown>, segments);
      }
      return refuse("decode", "an obj payload whose keys are not exactly $ and v", segments);
    default:
      return refuse("decode", "an unknown tag", segments);
  }
}

/** A data object's members, decoded: a plain object, or the payload of an `obj` escape. */
function decodeEntries(record: Record<string, unknown>, segments: string[]): Record<string, unknown> {
  boundDepth("decode", segments);
  return Object.fromEntries(
    Object.keys(record).map((key) => {
      segments.push(key);
      const decoded = decodeAt(record[key], segments);
      segments.pop();
      return [key, decoded];
    }),
  );
}

function decodeAt(value: unknown, segments: string[]): unknown {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : refuse("decode", "a non-finite number", segments);
    case "bigint":
      return refuse("decode", "a bigint", segments);
    case "undefined":
      return refuse("decode", "undefined", segments);
    case "function":
      return refuse("decode", "a function", segments);
    case "symbol":
      return refuse("decode", "a symbol", segments);
  }
  if (value === null) return null;
  const object = value as object;
  if (Array.isArray(object)) {
    boundDepth("decode", segments);
    const out: unknown[] = new Array(object.length);
    for (let index = 0; index < object.length; index++) {
      segments.push(String(index));
      if (!(index in object)) refuse("decode", "an array hole", segments);
      out[index] = decodeAt(object[index], segments);
      segments.pop();
    }
    return out;
  }
  if (!isDataObject(object)) {
    refuse("decode", object instanceof Date ? "a Date" : `${objectKind(object)}, which JSON cannot produce`, segments);
  }
  const record = object as Record<string, unknown>;
  if (hasTagKeys(Object.keys(record))) return decodeTag(record.$, record.v, segments);
  return decodeEntries(record, segments);
}

/** Decode one wire value; refuses a malformed tag or a value JSON cannot produce with `ValueCodecError`. */
export function decodeValue(wire: unknown): unknown {
  return decodeAt(wire, []);
}
