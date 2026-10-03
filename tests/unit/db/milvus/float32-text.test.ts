/**
 * The float element text of the Milvus provider (vector-family spec 5.5, decision EXT-U7, R41 M20): the double
 * nearest the shortest decimal that rounds back to the same float32, so a copied vector searches exactly as stored.
 */
import { describe, expect, test } from "bun:test";
import { shortestFloat32 } from "@/lib/db/providers/vector/milvus/float32-text";

describe("shortestFloat32", () => {
  test.each([
    [Math.fround(0.1), 0.1],
    [Math.fround(1 / 3), 0.33333334],
    [Math.fround(0.35355338), 0.35355338],
    [Math.fround(3.4028234663852886e38), 3.4028235e38],
    [Math.fround(1.1754942106924411e-38), 1.1754942e-38],
    [1e-45, 1e-45],
    [0, 0],
    [-2, -2],
    [Math.fround(10.190845489501953), 10.1908455],
  ])("%p prints as %p", (value, expected) => {
    expect(shortestFloat32(value)).toBe(expected);
  });

  test("JSON prints the short form, and it rounds back to the same float32", () => {
    const widened = Math.fround(0.1);
    expect(JSON.stringify([widened])).toBe("[0.10000000149011612]");
    expect(JSON.stringify([shortestFloat32(widened)])).toBe("[0.1]");
    for (let index = 1; index < 5_000; index += 1) {
      const value = Math.fround(Math.sin(index) * 10 ** ((index % 70) - 35));
      expect(Math.fround(shortestFloat32(value))).toBe(value);
    }
  });

  test("a non-finite value is returned as it is, for the caller to show", () => {
    expect(shortestFloat32(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(shortestFloat32(1e39)).toBe(Number.POSITIVE_INFINITY);
    expect(shortestFloat32(Number.NaN)).toBeNaN();
  });
});
