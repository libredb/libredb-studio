/**
 * The PlaceholderGroup a search sends and the bytes of each query vector in it (vector-family spec 5.5, 5.11; R09
 * F13). Pure: hand-written protobuf, byte-identical to protobufjs, so no protobuf library runs at request time, and
 * reached from the browser through request.ts, so it uses Uint8Array and DataView only.
 *
 * `common.PlaceholderGroup { repeated PlaceholderValue placeholders = 1 }` holds one
 * `PlaceholderValue { string tag = 1; PlaceholderType type = 2; repeated bytes values = 3 }` with the tag `$0` and
 * one value per query vector. A float16 or bfloat16 field receives float32 data, which the server converts, so the
 * provider never encodes float16 or bfloat16 (R09 F11, R45 F6).
 */
import type { SparseVector } from "@/lib/db/vector/sparse";

/** The `common.PlaceholderType` members Studio sends. */
export const MILVUS_PLACEHOLDER_TYPES = {
  BinaryVector: 100,
  FloatVector: 101,
  SparseFloatVector: 104,
  Int8Vector: 105,
  VarChar: 21,
  EmbListFloatVector: 301,
} as const;

export type MilvusPlaceholderType = keyof typeof MILVUS_PLACEHOLDER_TYPES;

const PLACEHOLDER_TAG = "$0";

/** A protobuf varint of a non-negative safe integer. */
function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return bytes;
}

/** A length-delimited field: its key (wire type 2), the length and the bytes. */
function lengthDelimited(field: number, bytes: Uint8Array): Uint8Array[] {
  return [Uint8Array.from(varint(field * 8 + 2)), Uint8Array.from(varint(bytes.length)), bytes];
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** One serialised PlaceholderGroup holding `values`, one per query vector, of `type`. */
export function encodePlaceholderGroup(type: MilvusPlaceholderType, values: readonly Uint8Array[]): Uint8Array {
  const placeholder = concat([
    ...lengthDelimited(1, new TextEncoder().encode(PLACEHOLDER_TAG)),
    Uint8Array.from([2 * 8, ...varint(MILVUS_PLACEHOLDER_TYPES[type])]),
    ...values.flatMap((value) => lengthDelimited(3, value)),
  ]);
  return concat(lengthDelimited(1, placeholder));
}

/** Little-endian float32 elements: FloatVector, and Float16Vector and BFloat16Vector, which the server converts. */
export function floatVectorBytes(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return out;
}

/** Int8Vector elements, already checked to lie in -128 to 127. */
export function int8VectorBytes(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length);
  const view = new DataView(out.buffer);
  values.forEach((value, index) => view.setInt8(index, value));
  return out;
}

/** A sparse row: little-endian pairs of a uint32 index and a float32 value, in ascending index order. */
export function sparseVectorBytes(vector: SparseVector): Uint8Array {
  const order = vector.indices.map((_, position) => position).sort((a, b) => vector.indices[a] - vector.indices[b]);
  const out = new Uint8Array(order.length * 8);
  const view = new DataView(out.buffer);
  order.forEach((position, slot) => {
    view.setUint32(slot * 8, vector.indices[position], true);
    view.setFloat32(slot * 8 + 4, vector.values[position], true);
  });
  return out;
}

/** The UTF-8 bytes of a text query, for a field a BM25 function produces. */
export function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
