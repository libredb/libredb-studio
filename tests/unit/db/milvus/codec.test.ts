/**
 * The Milvus vector codecs (vector-family spec 5.5; R09 F12): float16 against the runtime's own Float16Array on all
 * 65,536 bit patterns, bfloat16 against a float32 reference on all 65,536, and the row readers of every vector type.
 */
import { describe, expect, test } from "bun:test";
import {
  bfloat16BitsToNumber,
  bfloat16Row,
  binaryRow,
  float16BitsToNumber,
  float16Row,
  indexMapFromSparse,
  int8Row,
  sparseFromRow,
} from "@/lib/db/providers/vector/milvus/codec";

/** The runtime's Float16Array, typed here because the repository's TypeScript lib may predate it. */
const Float16 = (globalThis as unknown as { Float16Array: new (buffer: ArrayBuffer) => ArrayLike<number> })
  .Float16Array;

function halves(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((bits, index) => view.setUint16(index * 2, bits, true));
  return bytes;
}

describe("float16BitsToNumber (R09 F12)", () => {
  test("equals Float16Array on all 65,536 bit patterns", () => {
    const buffer = new ArrayBuffer(2);
    const bits = new Uint16Array(buffer);
    const reference = new Float16(buffer);
    for (let pattern = 0; pattern < 65_536; pattern += 1) {
      bits[0] = pattern;
      expect(Object.is(float16BitsToNumber(pattern), reference[0])).toBe(true);
    }
  });
});

describe("bfloat16BitsToNumber", () => {
  test("equals the float32 whose upper half is the pattern, on all 65,536", () => {
    const word = new DataView(new ArrayBuffer(4));
    for (let pattern = 0; pattern < 65_536; pattern += 1) {
      word.setUint32(0, pattern * 65_536);
      expect(Object.is(bfloat16BitsToNumber(pattern), word.getFloat32(0))).toBe(true);
    }
  });
});

describe("row readers (5.5)", () => {
  test("a Float16Vector row prints each element as the shortest decimal of its float32 (R45 M21)", () => {
    // 65504, -65504, 2^-14 and 2^-24: the edge row of edge_values.
    expect(float16Row(halves([0x7bff, 0xfbff, 0x0400, 0x0001]), 4, 0)).toEqual([
      65504, -65504, 0.000061035156, 5.9604645e-8,
    ]);
  });

  test("a BFloat16Vector row likewise", () => {
    expect(bfloat16Row(halves([0x7f7f, 0x8080, 0x3dcd, 0xc000]), 4, 0)).toEqual([
      3.3895314e38, -1.1754944e-38, 0.100097656, -2,
    ]);
  });

  test("the second row of a column is read at its offset", () => {
    expect(float16Row(halves([0x3c00, 0x4000, 0x4200, 0x4400]), 2, 1)).toEqual([3, 4]);
    expect(bfloat16Row(halves([0x3f80, 0x4000, 0x4040, 0x4080]), 2, 1)).toEqual([3, 4]);
  });

  test("an Int8Vector row is integers", () => {
    expect(int8Row(Uint8Array.from([0x80, 0x7f, 0x00, 0xff, 1, 2]), 3, 1)).toEqual([-1, 1, 2]);
    expect(int8Row(Uint8Array.from([0x80, 0x7f, 0x00, 0xff]), 4, 0)).toEqual([-128, 127, 0, -1]);
  });

  test("a BinaryVector row is its dimension / 8 bytes, a valid search vector (J3 B1)", () => {
    expect(binaryRow(Uint8Array.from([0, 0, 255, 255]), 16, 1)).toEqual([255, 255]);
  });

  test("a sparse row reads as indices and shortest float32 values, then as Milvus's index map", () => {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 230, true);
    view.setFloat32(4, 0.2, true);
    view.setUint32(8, 17, true);
    view.setFloat32(12, 0.4, true);
    const vector = sparseFromRow(bytes);
    expect(vector).toEqual({ indices: [230, 17], values: [0.2, 0.4] });
    const map = indexMapFromSparse(vector);
    expect(Object.getPrototypeOf(map)).toBeNull();
    expect(JSON.stringify(map)).toBe('{"17":0.4,"230":0.2}');
  });

  test("an index at the top of the uint32 range and a tiny value stay exact", () => {
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 4_294_967_294, true);
    view.setFloat32(4, 1e-30, true);
    expect(JSON.stringify(indexMapFromSparse(sparseFromRow(bytes)))).toBe('{"4294967294":1e-30}');
  });

  test("an empty sparse row is an empty map", () => {
    expect(JSON.stringify(indexMapFromSparse(sparseFromRow(new Uint8Array(0))))).toBe("{}");
  });
});
