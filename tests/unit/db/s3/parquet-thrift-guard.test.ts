/**
 * The structural Thrift guard of the S3 Parquet preview: measured, hyparquet's
 * compact reader builds a 10,000,000-element list from 6 input bytes (610 MB of heap on Node), so footers and page
 * headers are walked here first, without building values, and refused with a reason before any allocation.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { deserializeTCompactProtocol } from "hyparquet/src/thrift.js";
import { guardThriftStruct, readPageHeader } from "@/lib/db/providers/objectstore/s3/parquet-thrift-guard";
import { fixture, PREVIEW_FIXTURES } from "../../../helpers/s3-preview-reader";
import { THRIFT, type ThriftField, thriftStruct, varint } from "../../../helpers/thrift-compact";

const guard = (bytes: Uint8Array, maxDepth = 32) => guardThriftStruct(bytes, 0, maxDepth);
/** A struct whose field 1 holds a struct, `levels` deep, the innermost holding one i32. */
const nested = (levels: number): Uint8Array => {
  let fields: readonly ThriftField[] = [[1, { i32: 1 }]];
  for (let level = 1; level < levels; level += 1) fields = [[1, { struct: fields }]];
  return thriftStruct(fields);
};
const pageHeader = (fields: readonly ThriftField[]): Uint8Array => thriftStruct(fields);

describe("guardThriftStruct: the structural rules", () => {
  test("the 6-byte amplification input is refused before any allocation", () => {
    const input = Uint8Array.of(0x19, 0xfc, ...varint(10_000_000));
    expect(input).toHaveLength(6);
    expect(guard(input)).toEqual({ ok: false, reason: "a list declares 10,000,000 elements in 0 bytes" });
  });

  test("a binary longer than the bytes left is refused", () => {
    expect(guard(Uint8Array.of(0x18, 0x0a, 0x61, 0x62))).toEqual({
      ok: false,
      reason: "a string declares 10 bytes in 2 bytes",
    });
  });

  test("nesting past the depth in force is refused with the reason naming it", () => {
    expect(guard(nested(3), 3)).toMatchObject({ ok: true });
    expect(guard(nested(4), 3)).toEqual({ ok: false, reason: "nesting deeper than 3 levels" });
    expect(guard(nested(33))).toEqual({ ok: false, reason: "nesting deeper than 32 levels" });
  });

  test("unknown field types 10 and 11, and an unknown list element type, are refused", () => {
    expect(guard(Uint8Array.of(0x1a, 0x00))).toEqual({ ok: false, reason: "an unknown Thrift type 10" });
    expect(guard(Uint8Array.of(0x1b, 0x00))).toEqual({ ok: false, reason: "an unknown Thrift type 11" });
    expect(guard(Uint8Array.of(0x19, 0x1a, 0x00))).toEqual({ ok: false, reason: "an unknown Thrift type 10" });
  });

  test("a varint of 11 bytes, and one that runs past the input, are refused", () => {
    expect(guard(Uint8Array.of(0x15, ...new Array(10).fill(0xff), 0x01))).toEqual({
      ok: false,
      reason: "a number runs past the end",
    });
    expect(guard(Uint8Array.of(0x15, 0xff))).toEqual({ ok: false, reason: "a number runs past the end" });
    expect(guard(Uint8Array.of(0x17, 0x00, 0x00))).toEqual({ ok: false, reason: "a number runs past the end" });
  });

  test("a struct with no stop byte, and a list with no header, are refused", () => {
    expect(guard(Uint8Array.of(0x15, 0x02))).toEqual({ ok: false, reason: "a struct runs past the end" });
    expect(guard(Uint8Array.of(0x19))).toEqual({ ok: false, reason: "a struct runs past the end" });
  });

  test("a well-formed struct of every type passes and reports where it ends", () => {
    const body = thriftStruct([
      [1, { bool: true }],
      [2, { i64: BigInt(5) }],
      [3, { binary: "ab" }],
      [4, { list: { type: THRIFT.I32, items: Array.from({ length: 20 }, (_, index) => ({ i32: index })) } }],
      [5, { struct: [[1, { i32: 7 }]] }],
      [40, { list: { type: THRIFT.TRUE, items: [{ bool: true }, { bool: false }] } }],
    ]);
    expect(guard(new Uint8Array([...body, 0x99]))).toEqual({ ok: true, end: body.length });
    const doubleAndByte = Uint8Array.of(0x17, 0, 0, 0, 0, 0, 0, 0xf0, 0x3f, 0x13, 0x05, 0x00);
    expect(guard(doubleAndByte)).toEqual({ ok: true, end: 12 });
  });
});

describe("readPageHeader", () => {
  test("a data page (v1) gives its four facts", () => {
    const bytes = pageHeader([
      [1, { i32: 0 }],
      [2, { i32: 400 }],
      [3, { i32: 120 }],
      [
        5,
        {
          struct: [
            [1, { i32: 100 }],
            [2, { i32: 0 }],
            [3, { i32: 3 }],
            [4, { i32: 3 }],
          ],
        },
      ],
    ]);
    expect(readPageHeader(bytes, 0, 32)).toEqual({
      type: 0,
      uncompressedPageSize: 400,
      compressedPageSize: 120,
      numValues: 100,
      headerBytes: bytes.length,
    });
  });

  test("a dictionary page, a data page v2 and an index page", () => {
    const dictionary = pageHeader([
      [1, { i32: 2 }],
      [2, { i32: 10 }],
      [3, { i32: 10 }],
      [
        7,
        {
          struct: [
            [1, { i32: 4 }],
            [2, { i32: 0 }],
          ],
        },
      ],
    ]);
    const v2 = pageHeader([
      [1, { i32: 3 }],
      [2, { i32: 9 }],
      [3, { i32: 9 }],
      [
        8,
        {
          struct: [
            [1, { i32: 6 }],
            [2, { i32: 0 }],
            [3, { i32: 6 }],
            [4, { i32: 0 }],
            [5, { i32: 0 }],
            [6, { i32: 0 }],
          ],
        },
      ],
    ]);
    const index = pageHeader([
      [1, { i32: 1 }],
      [2, { i32: 0 }],
      [3, { i32: 0 }],
    ]);
    expect(readPageHeader(dictionary, 0, 32)).toMatchObject({ type: 2, numValues: 4 });
    expect(readPageHeader(v2, 0, 32)).toMatchObject({ type: 3, numValues: 6 });
    expect(readPageHeader(index, 0, 32)).toMatchObject({ type: 1, numValues: 0 });
  });

  test("a header read at an offset counts its own bytes only", () => {
    const header = pageHeader([
      [1, { i32: 0 }],
      [2, { i32: 1 }],
      [3, { i32: 1 }],
      [5, { struct: [[1, { i32: 1 }]] }],
    ]);
    const bytes = new Uint8Array([0xaa, 0xbb, ...header, 0x42]);
    expect(readPageHeader(bytes, 2, 32)).toMatchObject({ headerBytes: header.length });
  });

  test("a negative or missing size is refused, and so is a header the guard refuses", () => {
    expect(
      readPageHeader(
        pageHeader([
          [1, { i32: 0 }],
          [2, { i32: 1 }],
          [3, { i32: -1 }],
        ]),
        0,
        32,
      ),
    ).toEqual({
      ok: false,
      reason: "a page declares a negative size",
    });
    expect(readPageHeader(pageHeader([[1, { i32: 0 }]]), 0, 32)).toEqual({
      ok: false,
      reason: "a page declares a negative size",
    });
    expect(readPageHeader(Uint8Array.of(0x1a, 0x00), 0, 32)).toEqual({
      ok: false,
      reason: "an unknown Thrift type 10",
    });
  });

  test("values inside a list never count as the page's facts", () => {
    const bytes = pageHeader([
      [1, { i32: 0 }],
      [2, { i32: 8 }],
      [3, { i32: 8 }],
      [
        5,
        {
          struct: [
            [1, { i32: 2 }],
            [9, { list: { type: THRIFT.STRUCT, items: [{ struct: [[1, { i32: 999 }]] }] } }],
          ],
        },
      ],
    ]);
    expect(readPageHeader(bytes, 0, 32)).toMatchObject({ numValues: 2 });
  });
});

/** The four facts as hyparquet's column.js parquetHeader reads them from the same bytes. */
function hyparquetFacts(bytes: Uint8Array) {
  const header = deserializeTCompactProtocol({
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    offset: 0,
  });
  const holders: Record<number, { readonly field_1?: unknown } | undefined> = {
    0: header.field_5,
    2: header.field_7,
    3: header.field_8,
  };
  return {
    type: header.field_1,
    uncompressedPageSize: header.field_2,
    compressedPageSize: header.field_3,
    numValues: header.field_1 === 1 ? 0 : holders[header.field_1 as number]?.field_1,
  };
}

const sizes: readonly ThriftField[] = [
  [2, { i32: 1_000 }],
  [3, { i32: 10 }],
];
const big = 100_000_000;

describe("readPageHeader reads the count hyparquet reads", () => {
  test("a dictionary page with a decoy field 5 counts its field 7 values", () => {
    const bytes = pageHeader([
      [1, { i32: 2 }],
      ...sizes,
      [5, { struct: [[1, { i32: 1 }]] }],
      [
        7,
        {
          struct: [
            [1, { i32: big }],
            [2, { i32: 0 }],
          ],
        },
      ],
    ]);
    expect(hyparquetFacts(bytes).numValues).toBe(big);
    expect(readPageHeader(bytes, 0, 32)).toMatchObject({ type: 2, numValues: big });
  });

  test("a data page v2 with a decoy field 5 counts its field 8 values", () => {
    const bytes = pageHeader([
      [1, { i32: 3 }],
      ...sizes,
      [5, { struct: [[1, { i32: 1 }]] }],
      [
        8,
        {
          struct: [
            [1, { i32: big }],
            [2, { i32: 0 }],
            [3, { i32: big }],
          ],
        },
      ],
    ]);
    expect(hyparquetFacts(bytes).numValues).toBe(big);
    expect(readPageHeader(bytes, 0, 32)).toMatchObject({ type: 3, numValues: big });
  });

  test("a data page with a decoy field 7 counts its field 5 values", () => {
    const bytes = pageHeader([
      [1, { i32: 0 }],
      ...sizes,
      [5, { struct: [[1, { i32: 3 }]] }],
      [7, { struct: [[1, { i32: big }]] }],
    ]);
    expect(readPageHeader(bytes, 0, 32)).toMatchObject({ type: 0, numValues: 3 });
  });

  test("a count, a size or the type that is not a 16-bit or 32-bit integer is refused", () => {
    const asDouble = pageHeader([[1, { i32: 0 }], ...sizes, [5, { struct: [[1, { double: big }]] }]]);
    expect(hyparquetFacts(asDouble).numValues).toBe(big);
    expect(readPageHeader(asDouble, 0, 32)).toEqual({
      ok: false,
      reason: "page header field 5.1 is not a 16-bit or 32-bit integer",
    });
    expect(
      readPageHeader(
        pageHeader([
          [1, { i32: 0 }],
          [2, { i64: 1 }],
          [3, { i32: 1 }],
        ]),
        0,
        32,
      ),
    ).toEqual({
      ok: false,
      reason: "page header field 2 is not a 16-bit or 32-bit integer",
    });
    expect(readPageHeader(pageHeader([[1, { double: 0 }], ...sizes]), 0, 32)).toEqual({
      ok: false,
      reason: "page header field 1 is not a 16-bit or 32-bit integer",
    });
  });

  test("an i16 count is read like an i32 one", () => {
    const bytes = pageHeader([
      [1, { i16: 2 }],
      [2, { i16: 4 }],
      [3, { i16: 4 }],
      [7, { struct: [[1, { i16: 9 }]] }],
    ]);
    expect(readPageHeader(bytes, 0, 32)).toMatchObject({
      type: 2,
      uncompressedPageSize: 4,
      compressedPageSize: 4,
      numValues: 9,
    });
  });

  test("a fact or its holder that appears twice is refused", () => {
    expect(
      readPageHeader(
        pageHeader([[1, { i32: 0 }], ...sizes, [2, { i32: 1 }], [5, { struct: [[1, { i32: 1 }]] }]]),
        0,
        32,
      ),
    ).toEqual({
      ok: false,
      reason: "page header field 2 appears more than once",
    });
    expect(
      readPageHeader(
        pageHeader([
          [1, { i32: 0 }],
          ...sizes,
          [
            5,
            {
              struct: [
                [1, { i32: 1 }],
                [1, { i32: big }],
              ],
            },
          ],
        ]),
        0,
        32,
      ),
    ).toEqual({ ok: false, reason: "page header field 5.1 appears more than once" });
    expect(
      readPageHeader(
        pageHeader([[1, { i32: 0 }], ...sizes, [5, { struct: [[1, { i32: 1 }]] }], [5, { struct: [[2, { i32: 0 }]] }]]),
        0,
        32,
      ),
    ).toEqual({ ok: false, reason: "page header field 5 appears more than once" });
  });

  test("a page whose type needs a holder or a count it lacks, or of no or an unknown type, is refused", () => {
    expect(readPageHeader(pageHeader([[1, { i32: 2 }], ...sizes, [5, { struct: [[1, { i32: 1 }]] }]]), 0, 32)).toEqual({
      ok: false,
      reason: "a page of type 2 has no field 7",
    });
    expect(readPageHeader(pageHeader([[1, { i32: 0 }], ...sizes, [5, { i32: 1 }]]), 0, 32)).toEqual({
      ok: false,
      reason: "a page of type 0 has no field 5",
    });
    expect(readPageHeader(pageHeader([[1, { i32: 0 }], ...sizes, [5, { struct: [[2, { i32: 0 }]] }]]), 0, 32)).toEqual({
      ok: false,
      reason: "a page of type 0 has no value count",
    });
    expect(readPageHeader(pageHeader([...sizes]), 0, 32)).toEqual({ ok: false, reason: "a page declares no type" });
    expect(readPageHeader(pageHeader([[1, { i32: 4 }], ...sizes]), 0, 32)).toEqual({
      ok: false,
      reason: "a page declares an unknown type 4",
    });
  });

  test("a data page v2 with no null count, or with more nulls than values or a negative count of them, is refused", () => {
    const v2 = (nulls: readonly ThriftField[]) =>
      readPageHeader(pageHeader([[1, { i32: 3 }], ...sizes, [8, { struct: [[1, { i32: 5 }], ...nulls] }]]), 0, 32);
    expect(v2([])).toEqual({ ok: false, reason: "a data page v2 has no null count" });
    expect(v2([[2, { i32: -big }]])).toEqual({
      ok: false,
      reason: "a data page v2 declares a null count outside 0 to its values",
    });
    expect(v2([[2, { i32: 6 }]])).toEqual({
      ok: false,
      reason: "a data page v2 declares a null count outside 0 to its values",
    });
    expect(v2([[2, { i32: 5 }]])).toMatchObject({ numValues: 5 });
  });

  test("wherever the guard accepts a header, its facts equal hyparquet's", () => {
    const counts: readonly ThriftField[][] = [
      [[5, { struct: [[1, { i32: 7 }]] }]],
      [[7, { struct: [[1, { i32: 7 }]] }]],
      [
        [
          8,
          {
            struct: [
              [1, { i32: 7 }],
              [2, { i32: 2 }],
            ],
          },
        ],
      ],
      [
        [5, { struct: [[1, { i32: 1 }]] }],
        [7, { struct: [[1, { i32: big }]] }],
      ],
      [
        [5, { struct: [[1, { i32: 1 }]] }],
        [
          8,
          {
            struct: [
              [1, { i32: big }],
              [2, { i32: 0 }],
            ],
          },
        ],
      ],
      [
        [7, { struct: [[1, { i32: 1 }]] }],
        [
          8,
          {
            struct: [
              [1, { i32: big }],
              [2, { i32: 0 }],
            ],
          },
        ],
      ],
      [[5, { struct: [[1, { double: big }]] }]],
      [[7, { struct: [[1, { i64: big }]] }]],
      [
        [
          5,
          {
            struct: [
              [1, { i32: 1 }],
              [1, { i32: big }],
            ],
          },
        ],
      ],
      [
        [
          8,
          {
            struct: [
              [1, { i32: 4 }],
              [2, { i32: -big }],
            ],
          },
        ],
      ],
      [],
    ];
    let accepted = 0;
    for (const type of [0, 1, 2, 3]) {
      for (const extra of counts) {
        const bytes = pageHeader([[1, { i32: type }], ...sizes, ...extra]);
        const facts = readPageHeader(bytes, 0, 32);
        if (!("headerBytes" in facts)) continue;
        accepted += 1;
        const expected = hyparquetFacts(bytes);
        const label = `type ${type}, ${JSON.stringify(extra)}`;
        expect(facts.type, label).toBe(expected.type);
        expect(facts.uncompressedPageSize, label).toBe(expected.uncompressedPageSize);
        expect(facts.compressedPageSize, label).toBe(expected.compressedPageSize);
        expect(facts.numValues as unknown, label).toBe(expected.numValues);
      }
    }
    expect(accepted).toBeGreaterThan(5);
  });
});

describe("guardThriftStruct: the list element budget", () => {
  const listOf = (size: number): Uint8Array =>
    new Uint8Array([0x19, 0xfc, ...varint(size), ...new Uint8Array(size), 0x00]);

  test("lists that declare more elements in all than the budget are refused; at the budget they pass", () => {
    expect(guardThriftStruct(listOf(100), 0, 32, { maxListElements: 100 })).toMatchObject({ ok: true });
    expect(guardThriftStruct(listOf(101), 0, 32, { maxListElements: 100 })).toEqual({
      ok: false,
      reason: "the lists declare more than 100 elements in all",
    });
    const twoLists = thriftStruct([
      [1, { list: { type: THRIFT.I32, items: Array.from({ length: 60 }, () => ({ i32: 1 })) } }],
      [
        2,
        {
          list: {
            type: THRIFT.STRUCT,
            items: [
              { struct: [[1, { list: { type: THRIFT.I32, items: Array.from({ length: 41 }, () => ({ i32: 1 })) } }]] },
            ],
          },
        },
      ],
    ]);
    expect(guardThriftStruct(twoLists, 0, 32, { maxListElements: 102 })).toMatchObject({ ok: true });
    expect(guardThriftStruct(twoLists, 0, 32, { maxListElements: 101 })).toMatchObject({ ok: false });
  });

  test("onField reports each field outside any list with its path, its type and its integer or list size", () => {
    const seen: string[] = [];
    const bytes = thriftStruct([
      [1, { i32: -3 }],
      [2, { list: { type: THRIFT.STRUCT, items: [{ struct: [[1, { i32: 9 }]] }] } }],
      [3, { struct: [[4, { binary: "x" }]] }],
    ]);
    guardThriftStruct(bytes, 0, 32, {
      onField: (fieldPath, type, value) => seen.push(`${fieldPath.join(".")}:${type}:${value}`),
    });
    expect(seen).toEqual(["1:5:-3", "2:9:1", "3.4:8:undefined", "3:12:undefined"]);
  });
});

describe("the committed preview fixtures", () => {
  const parquet = readdirSync(PREVIEW_FIXTURES)
    .filter((name) => name.endsWith(".parquet"))
    .sort();

  test("every preview fixture exists and stays under 200 KiB", () => {
    expect(parquet).toEqual([
      "bigcells-zstd.parquet",
      "fx-brotli.parquet",
      "fx-empty.parquet",
      "fx-gzip.parquet",
      "fx-lz4_raw.parquet",
      "fx-snappy.parquet",
      "fx-two-groups.parquet",
      "fx-uncompressed.parquet",
      "fx-zstd.parquet",
    ]);
    for (const name of readdirSync(PREVIEW_FIXTURES)) {
      expect(statSync(path.join(PREVIEW_FIXTURES, name)).size, name).toBeLessThan(200 * 1_024);
    }
  });

  test("every fixture's footer passes the guard", () => {
    for (const name of parquet) {
      const bytes = fixture(name);
      const length = new DataView(bytes.buffer).getUint32(bytes.length - 8, true);
      const footer = bytes.subarray(bytes.length - 8 - length, bytes.length - 8);
      expect(guardThriftStruct(footer, 0, 32), name).toMatchObject({ ok: true });
    }
  });
});
