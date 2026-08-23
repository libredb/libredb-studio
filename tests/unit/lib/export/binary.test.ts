import { describe, test, expect } from "bun:test";
import { asBytes, binaryPreview, binaryText } from "@/lib/export/binary";

describe("asBytes", () => {
  test("recognises the JSON shape a Node Buffer serializes to", () => {
    expect(asBytes({ type: "Buffer", data: [1, 2, 171, 255] })).toEqual(new Uint8Array([1, 2, 171, 255]));
  });

  test("recognises a live Uint8Array and a live Buffer", () => {
    const bytes = new Uint8Array([16, 32]);
    expect(asBytes(bytes)).toBe(bytes);
    expect(asBytes(Buffer.from([16, 32]))).toEqual(bytes);
  });

  test("an empty byte array is a binary value, not an absent one", () => {
    expect(asBytes({ type: "Buffer", data: [] })).toEqual(new Uint8Array(0));
    expect(asBytes(new Uint8Array(0))).toEqual(new Uint8Array(0));
  });

  test("a document that merely carries a type field is not binary", () => {
    // A user's own row: `SELECT 'Buffer' AS type, ARRAY[1,2] AS data` and a Mongo
    // document with a `type` field both reach here and must keep JSON rendering.
    expect(asBytes({ type: "Buffer" })).toBeUndefined();
    expect(asBytes({ type: "Buffer", data: "not an array" })).toBeUndefined();
    expect(asBytes({ type: "Buffer", data: [1, "two"] })).toBeUndefined();
    expect(asBytes({ type: "Buffer", data: [1, 2.5] })).toBeUndefined();
    expect(asBytes({ type: "Buffer", data: [-1] })).toBeUndefined();
    expect(asBytes({ type: "Buffer", data: [256] })).toBeUndefined();
    expect(asBytes({ type: "buffer", data: [1] })).toBeUndefined();
    expect(asBytes({ data: [1, 2] })).toBeUndefined();
  });

  test("a non-object value is never binary", () => {
    expect(asBytes(null)).toBeUndefined();
    expect(asBytes(undefined)).toBeUndefined();
    expect(asBytes("\\x0102")).toBeUndefined();
    expect(asBytes(42)).toBeUndefined();
    expect(asBytes([1, 2])).toBeUndefined();
  });
});

describe("binaryText", () => {
  test("writes lowercase hex behind the bytea escape prefix", () => {
    expect(binaryText(new Uint8Array([1, 2, 171, 255]))).toBe("\\x0102abff");
  });

  test("pads a byte below 0x10 to two digits, so the hex stays recoverable", () => {
    expect(binaryText(new Uint8Array([0, 1, 15, 16]))).toBe("\\x00010f10");
  });

  test("an empty value is the prefix alone", () => {
    expect(binaryText(new Uint8Array(0))).toBe("\\x");
  });
});

describe("binaryPreview", () => {
  test("a value at the truncation threshold is shown whole", () => {
    const bytes = new Uint8Array(32).fill(0xab);
    expect(binaryPreview(bytes)).toBe(binaryText(bytes));
  });

  test("one byte past the threshold truncates and states the size", () => {
    const bytes = new Uint8Array(33).fill(0xab);
    expect(binaryPreview(bytes)).toBe(`${binaryText(bytes.subarray(0, 32))}... (33 B)`);
  });

  test("states the size in the unit a reader can judge", () => {
    expect(binaryPreview(new Uint8Array(1536))).toBe(`${"\\x" + "00".repeat(32)}... (1.5 KB)`);
    expect(binaryPreview(new Uint8Array(1024 * 1024 * 3))).toBe(`${"\\x" + "00".repeat(32)}... (3.0 MB)`);
  });
});
