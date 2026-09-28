import { describe, expect, test } from "bun:test";
import { isRecord } from "@/lib/is-record";

describe("isRecord", () => {
  test("isRecord accepts plain objects and refuses null, arrays and primitives", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord("text")).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(true)).toBe(false);
  });
});
