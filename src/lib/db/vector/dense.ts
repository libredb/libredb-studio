import { checkIntRange, isTaggedFloat, isTaggedInt, type TaggedJson } from "../console/tagged-json";
import type { VectorDType, VectorFieldInfo } from "./types";

/**
 * Dense and multivector element checks (vector-family spec 3.3), run on what reaches the wire: a float element is
 * checked after `Math.fround`, because a float32, float16 or bfloat16 field receives the value rounded to float32
 * first. An underflow, a tiny value that flushes to zero or to a subnormal, is accepted.
 */

/** The facts of a field a vector is aimed at. */
export type VectorTarget = Pick<VectorFieldInfo, "name" | "kind" | "dtype" | "dimension">;

export type DTypeRange =
  | { readonly kind: "float"; readonly maxAbs: number }
  | { readonly kind: "integer"; readonly min: number; readonly max: number };

/**
 * Each element type's accepted range. bfloat16's bound is the largest bfloat16 that every rounding mode keeps
 * finite (bits 0x7f7f0000), so the verdict does not depend on how the server rounds; float64 accepts every finite
 * double.
 */
export const DTYPE_RANGES: Readonly<Record<VectorDType, DTypeRange>> = Object.freeze({
  float32: Object.freeze({ kind: "float", maxAbs: 3.4028234663852886e38 }),
  float64: Object.freeze({ kind: "float", maxAbs: Number.MAX_VALUE }),
  float16: Object.freeze({ kind: "float", maxAbs: 65504 }),
  bfloat16: Object.freeze({ kind: "float", maxAbs: 3.3895313892515355e38 }),
  int8: Object.freeze({ kind: "integer", min: -128, max: 127 }),
  uint8: Object.freeze({ kind: "integer", min: 0, max: 255 }),
  binary: Object.freeze({ kind: "integer", min: 0, max: 255 }),
});

/** Why a vector is refused, naming the field, the element type, the position and the bound. */
export interface VectorRefusal {
  readonly field: string;
  readonly dtype: VectorDType;
  /** The element's position, or null for a length or shape refusal. */
  readonly index: number | null;
  readonly sentence: string;
}

const ROUNDED_TO_FLOAT32: ReadonlySet<VectorDType> = new Set(["float32", "float16", "bfloat16"]);

function fieldName(target: VectorTarget): string {
  return target.name === "" ? "The unnamed vector" : `Vector field ${JSON.stringify(target.name)}`;
}

function refusal(target: VectorTarget, index: number | null, detail: string): VectorRefusal {
  return {
    field: target.name,
    dtype: target.dtype,
    index,
    sentence: `${fieldName(target)} (${target.dtype}): ${detail}`,
  };
}

function kindOf(value: TaggedJson): string {
  if (value === null) return "null";
  if (typeof value === "string") return "a string";
  if (typeof value === "boolean") return "a boolean";
  if (Array.isArray(value)) return "a list";
  return "an object";
}

function boundText(range: DTypeRange, dtype: VectorDType): string {
  if (range.kind === "integer") return `an integer from ${range.min} to ${range.max}`;
  return dtype === "float64" ? "a finite number" : `a finite number of absolute value at most ${range.maxAbs}`;
}

/**
 * The numbers of a vector typed in the console: a float literal as its double, an integer literal as its double
 * once it is inside the safe integer range, and a number Studio produced as itself. A literal outside the safe
 * range, and anything that is not a number, is refused naming its position.
 */
export function vectorNumbers(target: VectorTarget, values: readonly TaggedJson[]): readonly number[] | VectorRefusal {
  const numbers: number[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (typeof value === "number") numbers.push(value);
    else if (isTaggedFloat(value)) numbers.push(Number(value.text));
    else if (isTaggedInt(value)) {
      if (!checkIntRange(value, "safe")) {
        return refusal(target, index, `element ${index} is ${value.digits}, outside the range a double holds exactly.`);
      }
      numbers.push(Number(value.digits));
    } else {
      return refusal(target, index, `element ${index} is ${kindOf(value)}, not a number.`);
    }
  }
  return numbers;
}

/** The element at `index` against the field's element type, or the refusal naming it. */
function elementRefusal(target: VectorTarget, index: number, value: number, label: string): VectorRefusal | null {
  const range = DTYPE_RANGES[target.dtype];
  if (range.kind === "integer") {
    if (Number.isInteger(value) && value >= range.min && value <= range.max) return null;
  } else {
    const wire = ROUNDED_TO_FLOAT32.has(target.dtype) ? Math.fround(value) : value;
    if (Number.isFinite(wire) && Math.abs(wire) <= range.maxAbs) return null;
  }
  return refusal(target, index, `${label} is ${value}, not ${boundText(range, target.dtype)}.`);
}

/** The length against the field's dimension (bytes for a binary field), then every element against its range. */
export function checkDenseElements(target: VectorTarget, values: readonly number[]): VectorRefusal | null {
  if (target.dimension !== null) {
    if (target.dtype === "binary" && target.dimension % 8 !== 0) {
      return refusal(
        target,
        null,
        `the field's dimension is ${target.dimension} bits, which is not a whole number of bytes, so no byte vector fits it.`,
      );
    }
    const expected = target.dtype === "binary" ? target.dimension / 8 : target.dimension;
    if (values.length !== expected) {
      const unit = target.dtype === "binary" ? "bytes" : "elements";
      const field =
        target.dtype === "binary"
          ? `a ${target.dimension}-bit binary vector takes exactly ${expected}`
          : `the field's dimension is ${expected}`;
      return refusal(target, null, `${values.length} ${unit} given, ${field}.`);
    }
  }
  for (let index = 0; index < values.length; index++) {
    const refused = elementRefusal(target, index, values[index], `element ${index}`);
    if (refused !== null) return refused;
  }
  return null;
}

/** A multivector: at least one row, every row checked as a dense vector, and rows times size at most `maxElements`. */
export function checkMultiVector(
  target: VectorTarget,
  rows: readonly (readonly number[])[],
  maxElements: number,
): VectorRefusal | null {
  if (rows.length === 0) return refusal(target, null, "a multivector holds at least one row.");
  const total = rows.reduce((sum, row) => sum + row.length, 0);
  if (total > maxElements) {
    return refusal(target, null, `${rows.length} rows hold ${total} elements, above the bound of ${maxElements}.`);
  }
  let position = 0;
  for (let row = 0; row < rows.length; row++) {
    const values = rows[row];
    if (target.dimension !== null && values.length !== target.dimension) {
      return refusal(
        target,
        null,
        `row ${row} holds ${values.length} elements, the field's dimension is ${target.dimension}.`,
      );
    }
    for (let index = 0; index < values.length; index++) {
      const refused = elementRefusal(target, position + index, values[index], `row ${row}, element ${index}`);
      if (refused !== null) return refused;
    }
    position += values.length;
  }
  return null;
}
