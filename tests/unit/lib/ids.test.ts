import { describe, test, expect } from "bun:test";
import { newLocalId } from "@/lib/ids";

describe("newLocalId", () => {
  test("mints a non-empty id", () => {
    expect(newLocalId().length).toBeGreaterThan(0);
  });

  test("draws from the crypto generator, not from Math.random", () => {
    const values: number[] = [];
    const original = crypto.getRandomValues;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (crypto as any).getRandomValues = (array: Uint32Array) => {
      values.push(array.length);
      array[0] = 1;
      array[1] = 2;
      return array;
    };
    try {
      expect(newLocalId()).toBe("12");
      expect(values).toEqual([2]);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (crypto as any).getRandomValues = original;
    }
  });

  test("does not repeat across a run long enough to matter", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i += 1) {
      seen.add(newLocalId());
    }
    expect(seen.size).toBe(5000);
  });
});
