import { isTaggedFloat, isTaggedInt, type TaggedJson, type TaggedObject } from "../console/tagged-json";
import type { VectorRefusal, VectorTarget } from "./dense";
import { isFiniteFloat32 } from "./float32";
import type { SparseEncoding } from "./types";

/**
 * Sparse vectors (vector-family spec 3.3): one in-memory form, `{indices, values}` in ascending index order, read
 * from either written form. Indices are distinct non-negative integers below a bound the provider gives, because
 * the bound is engine data; values are finite float32. The two readers take the field first, so every refusal
 * names it and its element type, and check the entries as written before sorting them, so a refusal's `index` is
 * the position the element was written at.
 */
export interface SparseVector {
  readonly indices: readonly number[];
  readonly values: readonly number[];
}

const CANONICAL_INDEX = /^(?:0|[1-9][0-9]*)$/;

function refusal(target: VectorTarget, index: number | null, detail: string): VectorRefusal {
  const field = target.name === "" ? "The unnamed vector" : `Vector field ${JSON.stringify(target.name)}`;
  return { field: target.name, dtype: target.dtype, index, sentence: `${field} (${target.dtype}, sparse): ${detail}` };
}

/** A typed value as a number, or undefined when it is not one. */
function numberOf(value: TaggedJson): number | undefined {
  if (typeof value === "number") return value;
  if (isTaggedFloat(value)) return Number(value.text);
  if (isTaggedInt(value)) return Number(value.digits);
  return undefined;
}

function sorted(indices: readonly number[], values: readonly number[]): SparseVector {
  const order = indices.map((index, position) => ({ index, value: values[position] }));
  order.sort((a, b) => a.index - b.index);
  return Object.freeze({
    indices: Object.freeze(order.map((entry) => entry.index)),
    values: Object.freeze(order.map((entry) => entry.value)),
  });
}

/** An index map, `{"17": 0.5}`: each key a canonical decimal index, each value a number. */
export function sparseFromIndexMap(
  target: VectorTarget,
  map: TaggedObject,
  indexBoundExclusive: number,
): SparseVector | VectorRefusal {
  const indices: number[] = [];
  const values: number[] = [];
  for (const key of Object.keys(map)) {
    if (!CANONICAL_INDEX.test(key)) {
      return refusal(target, null, `the key ${JSON.stringify(key)} is not an index written as plain decimal digits.`);
    }
    const value = numberOf(map[key]);
    if (value === undefined) return refusal(target, indices.length, `the value at index ${key} is not a number.`);
    indices.push(Number(key));
    values.push(value);
  }
  return checkSparse(target, { indices, values }, indexBoundExclusive) ?? sorted(indices, values);
}

/** Two parallel lists, `indices` of integer literals and `values` of numbers. */
export function sparseFromIndicesValues(
  target: VectorTarget,
  indices: readonly TaggedJson[],
  values: readonly TaggedJson[],
  indexBoundExclusive: number,
): SparseVector | VectorRefusal {
  if (indices.length !== values.length) {
    return refusal(target, null, `${indices.length} indices and ${values.length} values given; the two lists pair up.`);
  }
  const indexNumbers: number[] = [];
  const valueNumbers: number[] = [];
  for (let position = 0; position < indices.length; position++) {
    const index = indices[position];
    if (!isTaggedInt(index) && !(typeof index === "number" && Number.isInteger(index))) {
      return refusal(target, position, `index ${position} is not an integer.`);
    }
    const value = numberOf(values[position]);
    if (value === undefined) return refusal(target, position, `value ${position} is not a number.`);
    indexNumbers.push(isTaggedInt(index) ? Number(index.digits) : index);
    valueNumbers.push(value);
  }
  return (
    checkSparse(target, { indices: indexNumbers, values: valueNumbers }, indexBoundExclusive) ??
    sorted(indexNumbers, valueNumbers)
  );
}

/**
 * A result cell read as a sparse vector, for a renderer that counts its entries; null when the cell is not of the
 * declared encoding. Never refuses: a cell is what the engine answered.
 */
export function sparseFromCell(cell: unknown, encoding: SparseEncoding): SparseVector | null {
  if (cell === null || typeof cell !== "object" || Array.isArray(cell)) return null;
  if (encoding === "index-map") {
    const entries = Object.entries(cell as Record<string, unknown>);
    if (!entries.every(([key, value]) => CANONICAL_INDEX.test(key) && typeof value === "number")) return null;
    return sorted(
      entries.map(([key]) => Number(key)),
      entries.map(([, value]) => value as number),
    );
  }
  const { indices, values } = cell as { indices?: unknown; values?: unknown };
  if (!Array.isArray(indices) || !Array.isArray(values) || indices.length !== values.length) return null;
  if (!indices.every((index) => Number.isInteger(index)) || !values.every((value) => typeof value === "number")) {
    return null;
  }
  return sorted(indices as number[], values as number[]);
}

/** Equal lengths, distinct integer indices from 0 to below the bound, and finite float32 values. */
export function checkSparse(
  target: VectorTarget,
  vector: SparseVector,
  indexBoundExclusive: number,
): VectorRefusal | null {
  if (vector.indices.length !== vector.values.length) {
    return refusal(
      target,
      null,
      `${vector.indices.length} indices and ${vector.values.length} values; the two lists pair up.`,
    );
  }
  const seen = new Set<number>();
  for (let position = 0; position < vector.indices.length; position++) {
    const index = vector.indices[position];
    if (!Number.isInteger(index) || index < 0 || index >= indexBoundExclusive) {
      return refusal(target, position, `index ${index} is not an integer from 0 to below ${indexBoundExclusive}.`);
    }
    if (seen.has(index)) return refusal(target, position, `index ${index} is given twice.`);
    seen.add(index);
    const value = vector.values[position];
    if (!isFiniteFloat32(value)) {
      return refusal(target, position, `the value at index ${index} is ${value}, not a finite float32.`);
    }
  }
  return null;
}
