/**
 * Geometry and geography values to EWKT: Spark sends Struct{srid Int32, wkb Binary}, and Studio shows
 * `SRID=<srid>;<WKT>`. The reader is wkbToWkt of the Milvus provider, copied and never imported, from
 * src/lib/db/providers/vector/milvus/field-data.ts, with four changes. Two are bounds: a geometry
 * nested past 64 levels is not decoded, and a point count that would pass the end is refused before any point is
 * read, as is a ring count or a multi or collection part count that cannot fit, before any ring or part is read. Two refuse malformed forms the Milvus reader writes as WKT: a byte order other than 0 or 1, and a multi form
 * holding a part of another type, which it writes as WKT that misnames the value. A form the reader does not decode
 * (a Z or M dimension, a truncated or malformed value) is written as `SRID=<srid>;WKB(<hex>)`, lossless.
 * Pure: no I/O, no logger.
 */
const WKB_MAX_DEPTH = 64;

const WKB_NAMES = [
  "",
  "POINT",
  "LINESTRING",
  "POLYGON",
  "MULTIPOINT",
  "MULTILINESTRING",
  "MULTIPOLYGON",
  "GEOMETRYCOLLECTION",
];

function wrap(parts: readonly string[]): string {
  return parts.length === 0 ? "EMPTY" : `(${parts.join(", ")})`;
}

/** Well-known binary, two-dimensional, to well-known text; undefined for a form Studio does not decode. */
export function wkbToWkt(bytes: Uint8Array): string | undefined {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const point = (little: boolean) => {
    const x = data.getFloat64(at, little);
    const y = data.getFloat64(at + 8, little);
    at += 16;
    return `${x} ${y}`;
  };
  const points = (little: boolean) => {
    const count = data.getUint32(at, little);
    at += 4;
    if (at + 16 * count > bytes.byteLength) throw new RangeError("points past the end");
    return Array.from({ length: count }, () => point(little));
  };
  const geometry = (depth: number): { readonly name: string; readonly body: string } | undefined => {
    if (depth > WKB_MAX_DEPTH) return undefined;
    // The byte order is 0 (big-endian) or 1 (little-endian); any other byte is a malformed value.
    const order = data.getUint8(at);
    if (order > 1) return undefined;
    const little = order === 1;
    const type = data.getUint32(at + 1, little);
    at += 5;
    const name = WKB_NAMES[type];
    if (name === undefined || name === "") return undefined;
    if (type === 1) {
      const text = point(little);
      return { name, body: text === "NaN NaN" ? "EMPTY" : `(${text})` };
    }
    if (type === 2) return { name, body: wrap(points(little)) };
    if (type === 3) {
      const rings = data.getUint32(at, little);
      at += 4;
      // Every ring carries at least its 4-byte point count.
      if (at + 4 * rings > bytes.byteLength) throw new RangeError("rings past the end");
      return { name, body: wrap(Array.from({ length: rings }, () => wrap(points(little)))) };
    }
    const count = data.getUint32(at, little);
    at += 4;
    // Every part is at least 9 bytes: its byte order, its type, and a point's coordinates or a 4-byte count.
    if (at + 9 * count > bytes.byteLength) throw new RangeError("parts past the end");
    const parts: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const part = geometry(depth + 1);
      // MULTIPOINT, MULTILINESTRING and MULTIPOLYGON (4 to 6) hold only their single type (1 to 3); a collection any.
      if (part === undefined || (type !== 7 && part.name !== WKB_NAMES[type - 3])) return undefined;
      parts.push(type === 7 ? `${part.name} ${part.body}` : part.body);
    }
    return { name, body: wrap(parts) };
  };
  try {
    const result = geometry(1);
    return result === undefined || at !== bytes.byteLength ? undefined : `${result.name} ${result.body}`;
  } catch {
    // A truncated WKB reads past the end of its bytes: a form Studio does not decode, which geoText writes as hex.
    return undefined;
  }
}

const HEX_DIGITS = "0123456789abcdef";
const ASCII = new TextDecoder();

/**
 * Every byte as two lower-case hex digits, written into one buffer and decoded once. A string per byte, joined,
 * holds tens of bytes of memory per byte of the value: about 1 GiB for a 16 MiB value, under Bun and under Node.
 */
function hexText(bytes: Uint8Array): string {
  const digits = new Uint8Array(bytes.length * 2);
  let at = 0;
  for (const byte of bytes) {
    digits[at] = HEX_DIGITS.charCodeAt(byte >> 4);
    digits[at + 1] = HEX_DIGITS.charCodeAt(byte & 15);
    at += 2;
  }
  return ASCII.decode(digits);
}

/** A geometry or geography value as EWKT, or as `SRID=<srid>;WKB(<hex>)` when the reader does not decode it. */
export function geoText(srid: number, wkb: Uint8Array): string {
  const wkt = wkbToWkt(wkb);
  if (wkt !== undefined) return `SRID=${srid};${wkt}`;
  return `SRID=${srid};WKB(${hexText(wkb)})`;
}
