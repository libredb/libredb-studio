/**
 * VARIANT binary to JSON text, per the Variant encoding of parquet-format 37b6e8b that Spark 4.2 writes.
 * Every offset and length is checked against its buffer, nesting is at most 64 levels, and the text is bounded while
 * it is written: the encoding lets an object's fields share one nested value, so a short binary can stand for a long
 * text, and the reader stops the moment the text would pass `maxChars`. Pure: no I/O, no logger.
 */
import { SPARK_ERROR_SENTENCES, SparkError } from "./errors";
import { dateText, timestampText } from "./temporal";

const VARIANT_MAX_DEPTH = 64;
const DECIMAL_MAX_SCALE = 38;
const DECIMAL_MAX_PRECISION = 38;
// The writer joins its parts into one string this often, so a long text is never held as millions of short ones.
const PARTS_PER_CHUNK = 4_096;
const OVER_BUDGET = Symbol("over budget");
// BigInt(...) rather than literals: the repository's TypeScript target, ES2017, has no BigInt literal.
const ZERO = BigInt(0);
const SIXTY_FOUR = BigInt(64);
// ignoreBOM keeps a leading U+FEFF in the string, where a default decoder would drop it.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function malformed(): never {
  throw new SparkError(
    "unreadable",
    SPARK_ERROR_SENTENCES.unreadable("a VARIANT value that does not follow the Variant encoding"),
  );
}

/**
 * The shortest decimal that reads back as the same float32 (`0.1`, not `0.10000000149011612`), the nearer one when two
 * of that length do; NaN, the infinities and both zeros come back as they are.
 */
export function float32Number(value: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  for (let digits = 1; digits < 9; digits += 1) {
    const text = value.toExponential(digits - 1);
    const nearest = Number(text);
    if (Math.fround(nearest) === value) return nearest;
    // At a power of two the float32 below is half as far away as the one above, so the decimal of this length that
    // reads back can be the nearest one's neighbour on the value's other side.
    const [mantissa, exponent] = text.split("e");
    const units = Number(mantissa.replace(".", "")) + (nearest < value ? 1 : -1);
    const other = Number(`${units}e${Number(exponent) - digits + 1}`);
    if (Math.fround(other) === value) return other;
  }
  // Nine significant digits always read back as the same float32.
  return Number(value.toExponential(8));
}

function inside(bytes: Uint8Array, at: number, size: number): void {
  if (!Number.isInteger(at) || at < 0 || size < 0 || at + size > bytes.length) malformed();
}

function bounded(bytes: Uint8Array, at: number, size: number): DataView {
  inside(bytes, at, size);
  return new DataView(bytes.buffer, bytes.byteOffset + at, size);
}

/** A little-endian unsigned integer of 1 to 4 bytes, read from the bytes themselves: no view per read. */
function unsigned(bytes: Uint8Array, at: number, size: number): number {
  inside(bytes, at, size);
  let value = 0;
  for (let index = size - 1; index >= 0; index -= 1) value = value * 256 + bytes[at + index];
  return value;
}

function utf8(bytes: Uint8Array, at: number, length: number): string {
  inside(bytes, at, length);
  try {
    return UTF8.decode(bytes.subarray(at, at + length));
  } catch {
    return malformed();
  }
}

/** A field id's `"name":` text from the metadata dictionary, read the first time it is asked for and then kept. */
function dictionary(metadata: Uint8Array): (id: number) => string {
  const header = unsigned(metadata, 0, 1);
  if ((header & 0x0f) !== 1) malformed();
  const offsetSize = ((header >> 6) & 0x03) + 1;
  const size = unsigned(metadata, 1, offsetSize);
  const offsetsAt = 1 + offsetSize;
  const bytesAt = offsetsAt + (size + 1) * offsetSize;
  if (bytesAt > metadata.length) malformed();
  const keys = new Map<number, string>();
  return (id) => {
    const known = keys.get(id);
    if (known !== undefined) return known;
    if (id >= size) malformed();
    const from = unsigned(metadata, offsetsAt + id * offsetSize, offsetSize);
    const to = unsigned(metadata, offsetsAt + (id + 1) * offsetSize, offsetSize);
    if (to < from) malformed();
    const key = `${JSON.stringify(utf8(metadata, bytesAt + from, to - from))}:`;
    keys.set(id, key);
    return key;
  };
}

class Writer {
  private readonly chunks: string[] = [];
  private parts: string[] = [];
  private written = 0;
  constructor(private readonly maxChars: number) {}

  /** Stops the text, before anything is built, when `chars` more characters would pass `maxChars`. */
  room(chars: number): void {
    if (this.written + chars > this.maxChars) throw OVER_BUDGET;
  }

  push(text: string): void {
    this.room(text.length);
    this.written += text.length;
    this.parts.push(text);
    if (this.parts.length === PARTS_PER_CHUNK) {
      this.chunks.push(this.parts.join(""));
      this.parts = [];
    }
  }

  text(): string {
    return this.chunks.join("") + this.parts.join("");
  }
}

function scaledText(unscaled: bigint, scale: number): string {
  if (scale > DECIMAL_MAX_SCALE) malformed();
  const sign = unscaled < ZERO ? "-" : "";
  const digits = (unscaled < ZERO ? -unscaled : unscaled).toString();
  // The encoding stores no precision: a decimal's is the digit count of its unscaled value, at most 38.
  if (digits.length > DECIMAL_MAX_PRECISION) malformed();
  if (scale === 0) return `${sign}${digits}`;
  const padded = digits.padStart(scale + 1, "0");
  return `${sign}${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}

function numberText(value: number): string {
  return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
}

function writePrimitive(value: Uint8Array, at: number, id: number, out: Writer): void {
  const body = at + 1;
  switch (id) {
    case 0:
      return out.push("null");
    case 1:
      return out.push("true");
    case 2:
      return out.push("false");
    case 3:
      return out.push(String(bounded(value, body, 1).getInt8(0)));
    case 4:
      return out.push(String(bounded(value, body, 2).getInt16(0, true)));
    case 5:
      return out.push(String(bounded(value, body, 4).getInt32(0, true)));
    case 6:
      return out.push(String(bounded(value, body, 8).getBigInt64(0, true)));
    case 7:
      return out.push(numberText(bounded(value, body, 8).getFloat64(0, true)));
    case 8:
      return out.push(scaledText(BigInt(bounded(value, body + 1, 4).getInt32(0, true)), unsigned(value, body, 1)));
    case 9:
      return out.push(scaledText(bounded(value, body + 1, 8).getBigInt64(0, true), unsigned(value, body, 1)));
    case 10: {
      const view = bounded(value, body + 1, 16);
      const unscaled = (view.getBigInt64(8, true) << SIXTY_FOUR) | view.getBigUint64(0, true);
      return out.push(scaledText(unscaled, unsigned(value, body, 1)));
    }
    case 11:
      return out.push(JSON.stringify(dateText(bounded(value, body, 4).getInt32(0, true))));
    case 12:
      return out.push(
        JSON.stringify(timestampText(bounded(value, body, 8).getBigInt64(0, true), true).replace(" ", "T")),
      );
    case 13:
      return out.push(
        JSON.stringify(timestampText(bounded(value, body, 8).getBigInt64(0, true), false).replace(" ", "T")),
      );
    case 14:
      return out.push(numberText(float32Number(bounded(value, body, 4).getFloat32(0, true))));
    case 15: {
      const length = unsigned(value, body, 4);
      inside(value, body + 4, length);
      // Base64 writes 4 characters for every 3 bytes, and JSON adds the 2 quotes.
      out.room(4 * Math.ceil(length / 3) + 2);
      return out.push(JSON.stringify(Buffer.from(value.subarray(body + 4, body + 4 + length)).toString("base64")));
    }
    case 16:
      return out.push(JSON.stringify(utf8(value, body + 4, unsigned(value, body, 4))));
    default:
      // TIME, the nanosecond timestamps and UUID are not produced by Spark;
      // any other id is not in the encoding.
      return malformed();
  }
}

function writeValue(value: Uint8Array, at: number, depth: number, names: (id: number) => string, out: Writer): void {
  if (depth > VARIANT_MAX_DEPTH) malformed();
  const head = unsigned(value, at, 1);
  const basic = head & 0x03;
  const header = head >> 2;
  if (basic === 0) return writePrimitive(value, at, header, out);
  if (basic === 1) return out.push(JSON.stringify(utf8(value, at + 1, header)));
  const offsetSize = (header & 0x03) + 1;
  const isObject = basic === 2;
  const idSize = isObject ? ((header >> 2) & 0x03) + 1 : 0;
  const countSize = (isObject ? (header >> 4) & 0x01 : (header >> 2) & 0x01) === 1 ? 4 : 1;
  const count = unsigned(value, at + 1, countSize);
  const idsAt = at + 1 + countSize;
  const offsetsAt = idsAt + count * idSize;
  const valuesAt = offsetsAt + (count + 1) * offsetSize;
  if (valuesAt > value.length) malformed();
  out.push(isObject ? "{" : "[");
  // An object's field names are unique, whether or not two of its fields share a dictionary id.
  const keys = isObject && count > 1 ? new Set<string>() : undefined;
  for (let index = 0; index < count; index += 1) {
    if (index > 0) out.push(",");
    if (isObject) {
      const key = names(unsigned(value, idsAt + index * idSize, idSize));
      if (keys?.has(key)) malformed();
      keys?.add(key);
      out.push(key);
    }
    writeValue(value, valuesAt + unsigned(value, offsetsAt + index * offsetSize, offsetSize), depth + 1, names, out);
  }
  out.push(isObject ? "}" : "]");
}

/** A VARIANT value as JSON text, or undefined the moment the text would pass `maxChars`. */
export function variantJson(value: Uint8Array, metadata: Uint8Array, maxChars: number): string | undefined {
  // A budget that is not a count of characters is the caller's defect: NaN would turn the bound off without a word,
  // and Infinity would leave a short binary free to stand for an endless text. 0 is a budget spent to the end: no text
  // fits, so the answer is undefined and the caller cuts before the row.
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) {
    throw new TypeError(`variantJson: maxChars must be a non-negative safe integer, not ${maxChars}`);
  }
  const names = dictionary(metadata);
  const out = new Writer(maxChars);
  try {
    writeValue(value, 0, 0, names, out);
  } catch (error) {
    if (error === OVER_BUDGET) return undefined;
    throw error;
  }
  return out.text();
}
