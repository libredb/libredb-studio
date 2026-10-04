/**
 * The Milvus vector codecs (vector-family spec 5.5, 5.11): float16, bfloat16, binary and sparse rows to the cell
 * form Studio shows, and an index map to and from the shared `SparseVector`. Pure.
 *
 * Every float element passes through `shortestFloat32`, so a float16 or bfloat16 element prints as the shortest
 * decimal of the float32 it widens to (`65504`, `5.9604645e-8`, `3.3895314e+38`), the form a copied cell searches
 * with (R45 M21). The decoders are this repository's own, written from the IEEE 754 layouts, not copied.
 */
import type { SparseVector } from "@/lib/db/vector/sparse";
import { shortestFloat32 } from "./float32-text";

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The value of a binary16 bit pattern, exactly. */
export function float16BitsToNumber(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/** The value of a bfloat16 bit pattern: the upper half of a float32, exactly. */
export function bfloat16BitsToNumber(bits: number): number {
  const word = new DataView(new ArrayBuffer(4));
  word.setUint16(0, bits & 0xffff);
  return word.getFloat32(0);
}

/** One row of a Float16Vector: `dimension` little-endian binary16 elements at `row`. */
export function float16Row(bytes: Uint8Array, dimension: number, row: number): number[] {
  const data = view(bytes);
  const out: number[] = [];
  for (let index = 0; index < dimension; index += 1) {
    out.push(shortestFloat32(float16BitsToNumber(data.getUint16((row * dimension + index) * 2, true))));
  }
  return out;
}

/** One row of a BFloat16Vector. */
export function bfloat16Row(bytes: Uint8Array, dimension: number, row: number): number[] {
  const data = view(bytes);
  const out: number[] = [];
  for (let index = 0; index < dimension; index += 1) {
    out.push(shortestFloat32(bfloat16BitsToNumber(data.getUint16((row * dimension + index) * 2, true))));
  }
  return out;
}

/** One row of an Int8Vector, as integers. */
export function int8Row(bytes: Uint8Array, dimension: number, row: number): number[] {
  const data = view(bytes);
  const out: number[] = [];
  for (let index = 0; index < dimension; index += 1) out.push(data.getInt8(row * dimension + index));
  return out;
}

/** One row of a BinaryVector: `dimension / 8` bytes, so a copied cell is valid search data (J3 B1). */
export function binaryRow(bytes: Uint8Array, dimension: number, row: number): number[] {
  const width = dimension / 8;
  return Array.from(bytes.subarray(row * width, (row + 1) * width));
}

/** A sparse row's bytes (pairs of a uint32 index and a float32 value) as a `SparseVector`, in stored order. */
export function sparseFromRow(bytes: Uint8Array): SparseVector {
  const data = view(bytes);
  const indices: number[] = [];
  const values: number[] = [];
  for (let offset = 0; offset + 8 <= bytes.byteLength; offset += 8) {
    indices.push(data.getUint32(offset, true));
    values.push(shortestFloat32(data.getFloat32(offset + 4, true)));
  }
  return { indices, values };
}

/** Milvus's index map, indices ascending, built on a null prototype (5.5). */
export function indexMapFromSparse(vector: SparseVector): Record<string, number> {
  const map: Record<string, number> = Object.create(null);
  const order = vector.indices.map((_, position) => position).sort((a, b) => vector.indices[a] - vector.indices[b]);
  for (const position of order) map[String(vector.indices[position])] = vector.values[position];
  return map;
}
