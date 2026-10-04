import type { SparseVector } from "./sparse";
import type { VectorTarget } from "./dense";

/**
 * A probe vector for a field (vector-family spec 3.3), which Generate Command writes into a search template: every
 * element of a float vector `Math.fround(1 / Math.sqrt(dimension))`, a unit vector; an int8 or uint8 element 1;
 * every byte of a binary vector 0x55, because an all-zero probe is degenerate under the set and angle metrics; a
 * sparse probe index 0 with value 1; a multivector one row of the dense probe. Null where the dimension is unknown
 * or is one no vector can have (not a positive integer, or a binary dimension that is not whole bytes), and the
 * provider then writes a template of comments only.
 */
export type ProbeVector =
  | { readonly kind: "dense"; readonly values: readonly number[] }
  | { readonly kind: "sparse"; readonly vector: SparseVector }
  | { readonly kind: "multi"; readonly rows: readonly (readonly number[])[] };

function denseProbe(target: VectorTarget, dimension: number): readonly number[] {
  if (target.dtype === "binary") return new Array<number>(dimension / 8).fill(0x55);
  if (target.dtype === "int8" || target.dtype === "uint8") return new Array<number>(dimension).fill(1);
  return new Array<number>(dimension).fill(Math.fround(1 / Math.sqrt(dimension)));
}

export function probeVector(target: VectorTarget): ProbeVector | null {
  if (target.kind === "sparse") return { kind: "sparse", vector: { indices: [0], values: [1] } };
  const { dimension } = target;
  if (dimension === null || !Number.isInteger(dimension) || dimension < 1) return null;
  if (target.dtype === "binary" && dimension % 8 !== 0) return null;
  const values = denseProbe(target, dimension);
  return target.kind === "multi" ? { kind: "multi", rows: [values] } : { kind: "dense", values };
}
