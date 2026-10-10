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
import { THRIFT, type ThriftField, type ThriftValue, thriftStruct, varint } from "../../../helpers/thrift-compact";

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
    expect(guard(Uint8Array.of(0x16, ...new Array(10).fill(0xff), 0x01))).toEqual({
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
            [5, { i32: 0 }],
            [6, { i32: 0 }],
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
    const levels: readonly ThriftField[] = [
      [5, { i32: 0 }],
      [6, { i32: 0 }],
    ];
    const v2 = (nulls: readonly ThriftField[]) =>
      readPageHeader(
        pageHeader([[1, { i32: 3 }], ...sizes, [8, { struct: [[1, { i32: 5 }], ...nulls, ...levels] }]]),
        0,
        32,
      );
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

/** A field header in long form: the type byte, then the id as a zigzag varint of the bytes given. */
const longForm = (type: number, idBytes: readonly number[]): number[] => [type, ...idBytes];
/** The zigzag of `value` as an unsigned LEB128 of exactly the bytes it needs. */
const zigzagVarint = (value: bigint): number[] =>
  varint(value >= BigInt(0) ? value * BigInt(2) : -value * BigInt(2) - BigInt(1));

describe("guardThriftStruct reads numbers the way hyparquet does", () => {
  test("a page header carrying a second field 2 under a long-form id that wraps to 2 in 32-bit arithmetic is refused", () => {
    const wrapped = BigInt(2) ** BigInt(32) + BigInt(2);
    const head = pageHeader([[1, { i32: 0 }], ...sizes, [5, { struct: [[1, { i32: 1 }]] }]]);
    const bytes = Uint8Array.from([
      ...head.subarray(0, head.length - 1),
      ...longForm(THRIFT.I32, zigzagVarint(wrapped)),
      ...varint(big * 2),
      0x00,
    ]);
    const hyparquet = deserializeTCompactProtocol({ view: new DataView(bytes.buffer), offset: 0 });
    expect(hyparquet.field_2).toBe(big);
    expect(readPageHeader(bytes, 0, 32)).toEqual({ ok: false, reason: "a number takes more than 32 bits" });
  });

  test("a 32-bit varint of more than 5 bytes, or whose fifth byte holds bits past 32, is refused", () => {
    expect(guard(Uint8Array.of(0x15, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00, 0x00))).toEqual({
      ok: false,
      reason: "a number takes more than 32 bits",
    });
    expect(guard(Uint8Array.of(0x15, 0x80, 0x80, 0x80, 0x80, 0x10, 0x00))).toEqual({
      ok: false,
      reason: "a number takes more than 32 bits",
    });
    expect(guard(Uint8Array.of(0x18, 0x80, 0x80, 0x80, 0x80, 0x10, 0x00))).toEqual({
      ok: false,
      reason: "a number takes more than 32 bits",
    });
    expect(guard(Uint8Array.of(0x19, 0xf5, 0x80, 0x80, 0x80, 0x80, 0x10, 0x00))).toEqual({
      ok: false,
      reason: "a number takes more than 32 bits",
    });
    expect(guard(Uint8Array.of(0x15, 0x80, 0x80, 0x80, 0x80, 0x0f, 0x00))).toMatchObject({ ok: true });
  });

  test("an i64 varint may take 10 bytes", () => {
    expect(guard(Uint8Array.of(0x16, ...new Array(9).fill(0xff), 0x01, 0x00))).toEqual({ ok: true, end: 12 });
  });

  test("an i32 whose fifth byte sets bit 31 reports the value hyparquet reads", () => {
    const seen: number[] = [];
    const bytes = Uint8Array.of(0x15, 0xfe, 0xff, 0xff, 0xff, 0x0f, 0x00);
    guardThriftStruct(bytes, 0, 32, { onField: (_path, _type, value) => seen.push(value as number) });
    const hyparquet = deserializeTCompactProtocol({ view: new DataView(bytes.buffer), offset: 0 });
    expect(seen).toEqual([hyparquet.field_1 as number]);
    expect(seen).toEqual([2_147_483_647]);
    const negative = Uint8Array.of(0x15, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x00);
    const values: number[] = [];
    guardThriftStruct(negative, 0, 32, { onField: (_path, _type, value) => values.push(value as number) });
    expect(values).toEqual([deserializeTCompactProtocol({ view: new DataView(negative.buffer), offset: 0 }).field_1]);
    expect(values).toEqual([-2_147_483_648]);
  });

  test("a long-form field id outside 1 to 32,767 is refused", () => {
    expect(guard(Uint8Array.from([...longForm(THRIFT.I32, zigzagVarint(BigInt(0))), 0x02, 0x00]))).toEqual({
      ok: false,
      reason: "a field id outside 1 to 32,767",
    });
    expect(guard(Uint8Array.from([...longForm(THRIFT.I32, zigzagVarint(BigInt(-1))), 0x02, 0x00]))).toEqual({
      ok: false,
      reason: "a field id outside 1 to 32,767",
    });
    expect(guard(Uint8Array.from([...longForm(THRIFT.I32, zigzagVarint(BigInt(32_768))), 0x02, 0x00]))).toEqual({
      ok: false,
      reason: "a field id outside 1 to 32,767",
    });
    expect(guard(Uint8Array.from([...longForm(THRIFT.I32, zigzagVarint(BigInt(32_767))), 0x02, 0x00]))).toMatchObject({
      ok: true,
    });
  });

  test("a string or a list whose 32-bit length reads as negative is refused", () => {
    expect(guard(Uint8Array.of(0x18, 0x80, 0x80, 0x80, 0x80, 0x08, 0x00))).toEqual({
      ok: false,
      reason: "a string declares -2,147,483,648 bytes in 1 bytes",
    });
    expect(guard(Uint8Array.of(0x19, 0xf5, 0x80, 0x80, 0x80, 0x80, 0x08, 0x00))).toEqual({
      ok: false,
      reason: "a list declares -2,147,483,648 elements in 1 bytes",
    });
  });
});

/** mulberry32: the fixed-seed generator of the differential cases. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Random Thrift values and structs, and byte mutations of them, for the differential test. */
function generator(seed: number) {
  const random = seeded(seed);
  const below = (n: number): number => Math.floor(random() * n);
  const pick = <T>(items: readonly T[]): T => items[below(items.length)];
  const integer = (): number =>
    pick([0, 1, 2, 3, 5, 7, 100, -1, -5, big, -big, 2_147_483_647, -2_147_483_648, below(1_000_000)]);
  const value = (depth: number): ThriftValue => {
    const kind = below(depth > 2 ? 6 : 8);
    if (kind === 0) return { i32: integer() };
    if (kind === 1) return { i16: pick([0, 1, -1, 300, 32_767]) };
    if (kind === 2) return { i64: BigInt(integer()) };
    if (kind === 3) return { double: pick([0, 1.5, Number.NaN, big]) };
    if (kind === 4) return { binary: "x".repeat(below(4)) };
    if (kind === 5) return { bool: random() < 0.5 };
    if (kind === 6) {
      const type = pick([THRIFT.I32, THRIFT.BINARY, THRIFT.STRUCT, THRIFT.TRUE]);
      const items = Array.from({ length: below(4) }, (): ThriftValue => {
        if (type === THRIFT.I32) return { i32: integer() };
        if (type === THRIFT.BINARY) return { binary: "ab" };
        if (type === THRIFT.TRUE) return { bool: random() < 0.5 };
        return { struct: fields(depth + 1, 3) };
      });
      return { list: { type, items } };
    }
    return { struct: fields(depth + 1, 4) };
  };
  const fields = (depth: number, most: number): ThriftField[] => {
    const out: ThriftField[] = [];
    let id = 0;
    for (let count = below(most + 1); count > 0; count -= 1) {
      id = random() < 0.15 ? below(40) + 1 : id + below(3) + 1;
      out.push([id, value(depth)]);
    }
    return out;
  };
  const header = (): Uint8Array => {
    const type = pick([0, 1, 2, 3, 0, 2]);
    const holder = { 0: 5, 2: 7, 3: 8 }[type as 0 | 2 | 3];
    const count = random() < 0.8 ? below(50) : integer();
    const own: ThriftField[] = [
      [1, { i32: type }],
      [2, { i32: random() < 0.8 ? below(40) : integer() }],
      [3, { i32: random() < 0.8 ? below(40) : integer() }],
    ];
    if (holder !== undefined) {
      const inner: ThriftField[] = [[1, random() < 0.9 ? { i32: count } : value(3)]];
      if (type === 3) {
        inner.push([2, { i32: random() < 0.8 ? below(count + 1) : integer() }]);
        inner.push([5, { i32: random() < 0.8 ? 0 : integer() }], [6, { i32: random() < 0.8 ? 0 : integer() }]);
        if (random() < 0.5) inner.push([7, random() < 0.8 ? { bool: random() < 0.5 } : value(3)]);
      }
      own.push([holder, { struct: inner }]);
    }
    if (random() < 0.3) own.push([below(4) + 9, value(1)]);
    return thriftStruct(own);
  };
  const footer = (): Uint8Array => thriftStruct(fields(1, 8));
  const mutate = (bytes: Uint8Array): Uint8Array => {
    const out = [...bytes];
    for (let edits = below(3) + 1; edits > 0; edits -= 1) {
      const at = below(out.length + 1);
      const kind = below(5);
      if (kind === 0 && out.length > 0) out[Math.min(at, out.length - 1)] = below(256);
      else if (kind === 1) out.splice(at, 0, below(256));
      else if (kind === 2) out.splice(at, 1);
      else if (kind === 3)
        out.splice(at, 0, pick([0x05, 0x15, 0x19, 0x18]), ...varint(BigInt(below(2 ** 30)) * BigInt(below(64) + 1)));
      else
        out.splice(
          at,
          0,
          pick([0x05, 0x06, 0x08]),
          0x80 | below(128),
          0x80 | below(128),
          0x80,
          0x80,
          below(256),
          below(2),
        );
    }
    return Uint8Array.from(out);
  };
  return { random, header, footer, mutate };
}

/** hyparquet's struct read of `bytes`, with where it stopped, or the error it threw. */
function hyparquetRead(bytes: Uint8Array) {
  const reader = { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0 };
  try {
    return { value: deserializeTCompactProtocol(reader), end: reader.offset };
  } catch (error) {
    return { error: String(error) };
  }
}

describe("the guard and hyparquet agree wherever the guard accepts", () => {
  test("a fixed-seed run of generated and mutated page headers: hyparquet reads the guard's four facts", () => {
    const { random, header, mutate } = generator(20_261_010);
    let accepted = 0;
    let refused = 0;
    for (let index = 0; index < 4_000; index += 1) {
      const clean = header();
      const bytes = random() < 0.6 ? mutate(clean) : clean;
      const facts = readPageHeader(bytes, 0, 32);
      if (!("headerBytes" in facts)) {
        refused += 1;
        continue;
      }
      accepted += 1;
      const read = hyparquetRead(bytes);
      const label = `case ${index}: ${Array.from(bytes).join(",")}`;
      expect(read.error, label).toBeUndefined();
      const expected = hyparquetFacts(bytes);
      expect(facts.type, label).toBe(expected.type);
      expect(facts.uncompressedPageSize, label).toBe(expected.uncompressedPageSize);
      expect(facts.compressedPageSize, label).toBe(expected.compressedPageSize);
      expect(facts.numValues as unknown, label).toBe(expected.numValues);
      expect(facts.headerBytes, label).toBe(read.end);
    }
    expect(accepted).toBeGreaterThan(500);
    expect(refused).toBeGreaterThan(500);
  });

  test("a fixed-seed run of generated and mutated structs: hyparquet ends where the guard ends", () => {
    const { random, footer, mutate } = generator(1_337);
    let accepted = 0;
    for (let index = 0; index < 3_000; index += 1) {
      const clean = footer();
      const bytes = random() < 0.6 ? mutate(clean) : clean;
      const result = guardThriftStruct(bytes, 0, 32, { maxListElements: 1_000 });
      if (!result.ok) continue;
      accepted += 1;
      const read = hyparquetRead(bytes);
      const label = `case ${index}: ${Array.from(bytes).join(",")}`;
      expect(read.error, label).toBeUndefined();
      expect(read.end, label).toBe(result.end);
    }
    expect(accepted).toBeGreaterThan(1_000);
  });
});

/** A valid data page header's facts, then `count` short-form boolean fields with distinct ids. */
const manyBooleanFields = (count: number): Uint8Array => {
  const head = pageHeader([
    [1, { i32: 0 }],
    [2, { i32: 4 }],
    [3, { i32: 4 }],
    [5, { struct: [[1, { i32: 1 }]] }],
  ]);
  const bytes = new Uint8Array(head.length - 1 + count + 1);
  bytes.set(head.subarray(0, head.length - 1));
  bytes.fill(0x11, head.length - 1, head.length - 1 + count);
  return bytes;
};

/** A valid data page header carrying field 9: a list of `count` empty structs. */
const longList = (count: number): Uint8Array => {
  const head = pageHeader([
    [1, { i32: 0 }],
    [2, { i32: 4 }],
    [3, { i32: 4 }],
    [5, { struct: [[1, { i32: 1 }]] }],
  ]);
  return Uint8Array.from([
    ...head.subarray(0, head.length - 1),
    0x49,
    0xfc,
    ...varint(count),
    ...new Uint8Array(count),
    0x00,
  ]);
};

describe("the field budget", () => {
  test("structs that declare more fields in all than the budget are refused; at the budget they pass", () => {
    const flat = Uint8Array.from([...new Array(10).fill(0x11), 0x00]);
    expect(guardThriftStruct(flat, 0, 32, { maxFields: 10 })).toEqual({ ok: true, end: 11 });
    expect(guardThriftStruct(flat, 0, 32, { maxFields: 9 })).toEqual({
      ok: false,
      reason: "the structs declare more than 9 fields in all",
    });
    const nestedInList = thriftStruct([
      [
        1,
        {
          list: {
            type: THRIFT.STRUCT,
            items: [
              {
                struct: [
                  [1, { i32: 1 }],
                  [2, { i32: 2 }],
                ],
              },
            ],
          },
        },
      ],
      [2, { struct: [[1, { bool: true }]] }],
    ]);
    expect(guardThriftStruct(nestedInList, 0, 32, { maxFields: 5 })).toMatchObject({ ok: true });
    expect(guardThriftStruct(nestedInList, 0, 32, { maxFields: 4 })).toMatchObject({ ok: false });
  });

  test("a page header of 100,000 distinct boolean fields is refused", () => {
    expect(readPageHeader(manyBooleanFields(100_000), 0, 32)).toEqual({
      ok: false,
      reason: "the structs declare more than 64 fields in all",
    });
  });

  test("a page header carrying a list of 100,000 elements is refused", () => {
    expect(readPageHeader(longList(100_000), 0, 32)).toEqual({
      ok: false,
      reason: "the lists declare more than 8 elements in all",
    });
    expect(readPageHeader(longList(8), 0, 32)).toMatchObject({ type: 0, numValues: 1 });
  });

  test("a page header with every field the format defines, statistics included, passes", () => {
    const statistics: ThriftField = [
      5,
      {
        struct: [
          [1, { binary: "z" }],
          [2, { binary: "a" }],
          [3, { i64: 0 }],
          [4, { i64: 2 }],
          [5, { binary: "z" }],
          [6, { binary: "a" }],
          [7, { bool: true }],
          [8, { bool: true }],
        ],
      },
    ];
    const v1 = pageHeader([
      [1, { i32: 0 }],
      [2, { i32: 4 }],
      [3, { i32: 4 }],
      [4, { i32: 7 }],
      [5, { struct: [[1, { i32: 1 }], [2, { i32: 0 }], [3, { i32: 3 }], [4, { i32: 3 }], statistics] }],
    ]);
    expect(readPageHeader(v1, 0, 32)).toMatchObject({ type: 0, numValues: 1 });
  });
});

/** A data page v2 of 10 values with page sizes `unc` and `comp`, and the given fields after its null count. */
const v2With = (levels: readonly ThriftField[], unc = 40, comp = 30): Uint8Array =>
  pageHeader([
    [1, { i32: 3 }],
    [2, { i32: unc }],
    [3, { i32: comp }],
    [8, { struct: [[1, { i32: 10 }], [2, { i32: 0 }], [3, { i32: 10 }], [4, { i32: 0 }], ...levels] }],
  ]);

describe("readPageHeader: the level lengths of a data page v2", () => {
  test("a data page v2 whose level lengths are not 32-bit integers is refused", () => {
    const wrong: readonly ThriftValue[] = [
      { double: Number.NaN },
      { binary: "ab" },
      { struct: [[1, { i32: 1 }]] },
      { list: { type: THRIFT.I32, items: [{ i32: 1 }] } },
      { i64: 1 },
    ];
    for (const value of wrong) {
      expect(
        readPageHeader(
          v2With([
            [5, value],
            [6, { i32: 0 }],
          ]),
          0,
          32,
        ),
        JSON.stringify(value),
      ).toEqual({
        ok: false,
        reason: "page header field 8.5 is not a 16-bit or 32-bit integer",
      });
      expect(
        readPageHeader(
          v2With([
            [5, { i32: 0 }],
            [6, value],
          ]),
          0,
          32,
        ),
        JSON.stringify(value),
      ).toEqual({
        ok: false,
        reason: "page header field 8.6 is not a 16-bit or 32-bit integer",
      });
    }
    expect(readPageHeader(v2With([[6, { i32: 0 }]]), 0, 32)).toEqual({
      ok: false,
      reason: "a data page v2 has no level lengths",
    });
    expect(readPageHeader(v2With([[5, { i32: 0 }]]), 0, 32)).toEqual({
      ok: false,
      reason: "a data page v2 has no level lengths",
    });
  });

  test("a data page v2 whose level lengths exceed its page size is refused", () => {
    const outside = { ok: false, reason: "a data page v2 declares level lengths outside 0 to its page sizes" };
    expect(
      readPageHeader(
        v2With([
          [5, { i32: -1 }],
          [6, { i32: 0 }],
        ]),
        0,
        32,
      ),
    ).toEqual(outside);
    expect(
      readPageHeader(
        v2With([
          [5, { i32: 0 }],
          [6, { i32: -2_147_483_648 }],
        ]),
        0,
        32,
      ),
    ).toEqual(outside);
    expect(
      readPageHeader(
        v2With([
          [5, { i32: 20 }],
          [6, { i32: 11 }],
        ]),
        0,
        32,
      ),
    ).toEqual(outside);
    expect(
      readPageHeader(
        v2With(
          [
            [5, { i32: 20 }],
            [6, { i32: 11 }],
          ],
          30,
          40,
        ),
        0,
        32,
      ),
    ).toEqual(outside);
    expect(
      readPageHeader(
        v2With([
          [5, { i32: 20 }],
          [6, { i32: 10 }],
        ]),
        0,
        32,
      ),
    ).toMatchObject({ type: 3 });
    expect(
      readPageHeader(
        v2With(
          [
            [5, { i16: 20 }],
            [6, { i16: 10 }],
          ],
          30,
          40,
        ),
        0,
        32,
      ),
    ).toMatchObject({ type: 3 });
  });

  test("a data page v2 level length that appears twice is refused", () => {
    expect(
      readPageHeader(
        v2With([
          [5, { i32: 0 }],
          [5, { i32: 1 }],
          [6, { i32: 0 }],
        ]),
        0,
        32,
      ),
    ).toEqual({
      ok: false,
      reason: "page header field 8.5 appears more than once",
    });
  });

  test("a data page v2 whose is_compressed is not a bool is refused; a bool or no field passes", () => {
    const levels: ThriftField[] = [
      [5, { i32: 0 }],
      [6, { i32: 0 }],
    ];
    expect(readPageHeader(v2With([...levels, [7, { i32: 0 }]]), 0, 32)).toEqual({
      ok: false,
      reason: "page header field 8.7 is not a bool",
    });
    expect(readPageHeader(v2With([...levels, [7, { bool: false }]]), 0, 32)).toMatchObject({ type: 3 });
    expect(readPageHeader(v2With([...levels, [7, { bool: true }]]), 0, 32)).toMatchObject({ type: 3 });
    expect(readPageHeader(v2With(levels), 0, 32)).toMatchObject({ type: 3 });
  });
});
