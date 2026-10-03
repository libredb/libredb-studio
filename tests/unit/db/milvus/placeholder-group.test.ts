/**
 * The PlaceholderGroup encoder (vector-family spec 5.5, 5.11; R09 F13): byte-identical to protobufjs over the two
 * messages of common.proto, and the vector bytes of each placeholder type.
 */
import { describe, expect, test } from "bun:test";
import protobuf from "protobufjs";
import {
  encodePlaceholderGroup,
  floatVectorBytes,
  int8VectorBytes,
  MILVUS_PLACEHOLDER_TYPES,
  type MilvusPlaceholderType,
  sparseVectorBytes,
  textBytes,
} from "@/lib/db/providers/vector/milvus/placeholder-group";

/** common.PlaceholderValue and common.PlaceholderGroup at milvus-proto 9e4f0ebc (common.proto:158-170). */
const ROOT = protobuf.Root.fromJSON({
  nested: {
    PlaceholderValue: {
      fields: {
        tag: { type: "string", id: 1 },
        type: { type: "int32", id: 2 },
        values: { rule: "repeated", type: "bytes", id: 3 },
        element_level: { type: "bool", id: 4 },
      },
    },
    PlaceholderGroup: { fields: { placeholders: { rule: "repeated", type: "PlaceholderValue", id: 1 } } },
  },
});
const GROUP = ROOT.lookupType("PlaceholderGroup");

function reference(type: MilvusPlaceholderType, values: readonly Uint8Array[]): Uint8Array {
  return GROUP.encode(
    GROUP.fromObject({ placeholders: [{ tag: "$0", type: MILVUS_PLACEHOLDER_TYPES[type], values: [...values] }] }),
  ).finish();
}

describe("encodePlaceholderGroup (R09 F13)", () => {
  test.each([
    ["FloatVector", [floatVectorBytes([0.1, 0.2, 0.3, 0.4])]],
    [
      "FloatVector",
      [floatVectorBytes(Array.from({ length: 768 }, (_, index) => index / 768)), floatVectorBytes([1, 2])],
    ],
    ["BinaryVector", [Uint8Array.from([0x55, 0xaa])]],
    ["Int8Vector", [int8VectorBytes([-128, 127, 0, -1])]],
    ["SparseFloatVector", [sparseVectorBytes({ indices: [230, 17], values: [0.2, 0.4] })]],
    ["VarChar", [textBytes("vector index")]],
    ["EmbListFloatVector", [floatVectorBytes([0, 1, 0, 0, 1, 1, 0, 0])]],
  ] as const)("%s is byte-identical to protobufjs", (type, values) => {
    expect(encodePlaceholderGroup(type, values)).toEqual(reference(type, values));
  });

  test("a value longer than 2^14 bytes takes a three-byte length, as protobufjs writes it", () => {
    const values = [floatVectorBytes(Array.from({ length: 32_768 }, () => 0.5))];
    expect(encodePlaceholderGroup("FloatVector", values)).toEqual(reference("FloatVector", values));
  });

  test("the placeholder types are common.proto's numbers", () => {
    expect(MILVUS_PLACEHOLDER_TYPES).toEqual({
      BinaryVector: 100,
      FloatVector: 101,
      SparseFloatVector: 104,
      Int8Vector: 105,
      VarChar: 21,
      EmbListFloatVector: 301,
    });
  });
});

describe("vector bytes", () => {
  test("float32 elements are little-endian", () => {
    expect([...floatVectorBytes([1])]).toEqual([0, 0, 0x80, 0x3f]);
  });

  test("int8 elements are two's complement bytes", () => {
    expect([...int8VectorBytes([-128, 127, -1])]).toEqual([0x80, 0x7f, 0xff]);
  });

  test("a sparse row is pairs of a uint32 index and a float32 value, ascending by index", () => {
    const bytes = sparseVectorBytes({ indices: [230, 17], values: [0.5, 1] });
    const view = new DataView(bytes.buffer);
    expect([
      view.getUint32(0, true),
      view.getFloat32(4, true),
      view.getUint32(8, true),
      view.getFloat32(12, true),
    ]).toEqual([17, 1, 230, 0.5]);
  });

  test("text is UTF-8", () => {
    expect([...textBytes("é")]).toEqual([0xc3, 0xa9]);
  });
});
