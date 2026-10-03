/**
 * Whether a number survives as a finite float32 (vector-family spec 3.3): `1e39` is finite as a double and
 * infinite once rounded to the float32 that reaches the wire.
 */
export function isFiniteFloat32(value: number): boolean {
  return Number.isFinite(Math.fround(value));
}
