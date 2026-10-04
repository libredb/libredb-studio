/**
 * The float element text of the Milvus provider (vector-family spec 5.5, decision EXT-U7). Pure, browser-safe.
 *
 * A float32 read from the wire widens to a double that prints as `0.10000000149011612`. Each element becomes the
 * double nearest the shortest decimal that rounds back to the same float32, so `JSON.stringify` prints `0.1` and a
 * copied vector searches exactly as stored (R41 M20). It stays in this provider: Qdrant prints its own floats.
 */

/**
 * The double nearest the shortest decimal whose float32 is `value`'s float32. A non-finite value is returned as it
 * is; the caller decides how to show it.
 */
export function shortestFloat32(value: number): number {
  const single = Math.fround(value);
  if (!Number.isFinite(single)) return single;
  for (let digits = 1; digits < 9; digits += 1) {
    const candidate = Number(single.toPrecision(digits));
    if (Math.fround(candidate) === single) return candidate;
  }
  // Nine significant digits always round-trip a float32.
  return Number(single.toPrecision(9));
}
