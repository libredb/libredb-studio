/**
 * Hand-built Parquet files for the S3 preview's guard, plan and pre-scan cases: the magic, column
 * chunks of page headers and bodies, then a FileMetaData footer, its length and the magic again, written with the
 * Thrift compact writer. Bodies are only valid where a case decodes them (INT32 PLAIN, BOOLEAN RLE, both REQUIRED);
 * every other case stops before decode, so its bodies are filler.
 */
import { THRIFT, type ThriftField, type ThriftValue, thriftStruct, varint } from "./thrift-compact";

export const PHYSICAL = { BOOLEAN: 0, INT32: 1, INT64: 2, BYTE_ARRAY: 6 } as const;
export const CODEC = { UNCOMPRESSED: 0, SNAPPY: 1, GZIP: 2, LZO: 3, BROTLI: 4, LZ4: 5, ZSTD: 6, LZ4_RAW: 7 } as const;
export const ENCODING = { PLAIN: 0, RLE: 3 } as const;

const MAGIC = [0x50, 0x41, 0x52, 0x31];

export interface SyntheticSchemaElement {
  readonly name: string;
  /** A PHYSICAL value for a leaf; absent for a group and the root. */
  readonly type?: number;
  readonly children?: number;
  /** Writes the VARIANT logical type (LogicalType field 16). */
  readonly variant?: boolean;
}

export interface SyntheticPage {
  readonly kind: "data" | "dictionary";
  readonly numValues: number;
  readonly body: Uint8Array;
  readonly encoding?: number;
  /** The header's uncompressed_page_size; the body's length when absent. */
  readonly uncompressedSize?: number;
}

export interface SyntheticChunk {
  readonly path: readonly string[];
  readonly type: number;
  readonly codec?: number;
  readonly pages: readonly SyntheticPage[];
  /** The footer's num_values; the data pages' sum when absent. */
  readonly numValues?: number;
  readonly filePath?: string;
  /** Footer overrides, to place a chunk outside the data or misstate its size. */
  readonly dataPageOffset?: number;
  readonly totalCompressedSize?: number;
  readonly totalUncompressedSize?: number;
  /** ColumnMetaData fields that replace the written field of the same id, or are added, in id order. */
  readonly metaFields?: readonly ThriftField[];
}

export interface SyntheticFile {
  readonly schema: readonly SyntheticSchemaElement[];
  readonly rowGroups: readonly {
    readonly numRows: number;
    readonly chunks: readonly SyntheticChunk[];
    /** The row group's num_rows as written, in place of the i64 of `numRows`. */
    readonly numRowsValue?: ThriftValue;
  }[];
  readonly createdBy?: string;
  /** The file's num_rows as written, in place of the i64 sum of the row groups. */
  readonly numRowsValue?: ThriftValue;
}

/** INT32 values, PLAIN: four little-endian bytes each. */
export function int32Plain(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return bytes;
}

/** `count` equal BOOLEAN values, RLE: a 4-byte length, one RLE run header, one value byte. */
export function booleanRle(count: number, value: boolean): Uint8Array {
  const run = [...varint(count * 2), value ? 1 : 0];
  const bytes = new Uint8Array(4 + run.length);
  new DataView(bytes.buffer).setUint32(0, run.length, true);
  bytes.set(run, 4);
  return bytes;
}

function pageHeader(page: SyntheticPage): Uint8Array {
  const sizes: ThriftField[] = [
    [2, { i32: page.uncompressedSize ?? page.body.length }],
    [3, { i32: page.body.length }],
  ];
  if (page.kind === "dictionary") {
    return thriftStruct([
      [1, { i32: 2 }],
      ...sizes,
      [
        7,
        {
          struct: [
            [1, { i32: page.numValues }],
            [2, { i32: ENCODING.PLAIN }],
          ],
        },
      ],
    ]);
  }
  return thriftStruct([
    [1, { i32: 0 }],
    ...sizes,
    [
      5,
      {
        struct: [
          [1, { i32: page.numValues }],
          [2, { i32: page.encoding ?? ENCODING.PLAIN }],
          [3, { i32: 3 }],
          [4, { i32: 3 }],
        ],
      },
    ],
  ]);
}

function schemaFields(element: SyntheticSchemaElement): ThriftField[] {
  const fields: ThriftField[] = [];
  if (element.type !== undefined) fields.push([1, { i32: element.type }]);
  if (element.type !== undefined || element.variant === true) fields.push([3, { i32: 0 }]);
  fields.push([4, { binary: element.name }]);
  if (element.children !== undefined) fields.push([5, { i32: element.children }]);
  if (element.variant === true) fields.push([10, { struct: [[16, { struct: [] }]] }]);
  return fields;
}

/** A whole Parquet file: PAR1, the chunks in order, the footer, its length, PAR1. */
export function syntheticParquet(file: SyntheticFile): Uint8Array {
  const out: number[] = [...MAGIC];
  const groups = file.rowGroups.map((group) => {
    let groupBytes = 0;
    const chunks = group.chunks.map((chunk) => {
      const start = out.length;
      let dictionaryOffset: number | undefined;
      let dataOffset: number | undefined;
      let uncompressed = 0;
      for (const page of chunk.pages) {
        if (page.kind === "dictionary" && dictionaryOffset === undefined) dictionaryOffset = out.length;
        if (page.kind === "data" && dataOffset === undefined) dataOffset = out.length;
        const header = pageHeader(page);
        for (const byte of header) out.push(byte);
        for (const byte of page.body) out.push(byte);
        uncompressed += header.length + (page.uncompressedSize ?? page.body.length);
      }
      const compressed = out.length - start;
      groupBytes += compressed;
      const dataValues = chunk.pages
        .filter((page) => page.kind === "data")
        .reduce((sum, page) => sum + page.numValues, 0);
      const meta: ThriftField[] = [
        [1, { i32: chunk.type }],
        [2, { list: { type: THRIFT.I32, items: [{ i32: ENCODING.PLAIN }, { i32: ENCODING.RLE }] } }],
        [3, { list: { type: THRIFT.BINARY, items: chunk.path.map((name) => ({ binary: name })) } }],
        [4, { i32: chunk.codec ?? CODEC.UNCOMPRESSED }],
        [5, { i64: chunk.numValues ?? dataValues }],
        [6, { i64: chunk.totalUncompressedSize ?? uncompressed }],
        [7, { i64: chunk.totalCompressedSize ?? compressed }],
        [9, { i64: chunk.dataPageOffset ?? dataOffset ?? start }],
      ];
      if (dictionaryOffset !== undefined && chunk.dataPageOffset === undefined)
        meta.push([11, { i64: dictionaryOffset }]);
      for (const field of chunk.metaFields ?? []) {
        const at = meta.findIndex(([id]) => id === field[0]);
        if (at === -1) meta.push(field);
        else meta[at] = field;
      }
      meta.sort((a, b) => a[0] - b[0]);
      const fields: ThriftField[] = [];
      if (chunk.filePath !== undefined) fields.push([1, { binary: chunk.filePath }]);
      fields.push([2, { i64: start }], [3, { struct: meta }]);
      return { struct: fields } as const;
    });
    return {
      struct: [
        [1, { list: { type: THRIFT.STRUCT, items: chunks } }],
        [2, { i64: groupBytes }],
        [3, group.numRowsValue ?? { i64: group.numRows }],
      ],
    } as const;
  });
  const footerFields: ThriftField[] = [
    [1, { i32: 1 }],
    [2, { list: { type: THRIFT.STRUCT, items: file.schema.map((element) => ({ struct: schemaFields(element) })) } }],
    [3, file.numRowsValue ?? { i64: file.rowGroups.reduce((sum, group) => sum + group.numRows, 0) }],
    [4, { list: { type: THRIFT.STRUCT, items: groups } }],
  ];
  if (file.createdBy !== undefined) footerFields.push([6, { binary: file.createdBy }]);
  const footer = thriftStruct(footerFields);
  for (const byte of footer) out.push(byte);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, footer.length, true);
  out.push(...length, ...MAGIC);
  return Uint8Array.from(out);
}

/** `size` bytes that end with a footer length field of `lengthField` and PAR1, the rest zero. */
export function withTail(lengthField: number, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(size - 8, lengthField, true);
  bytes.set(MAGIC, size - 4);
  return bytes;
}
