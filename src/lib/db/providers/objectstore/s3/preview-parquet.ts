/**
 * The S3 Parquet preview. Server-only: the only module that loads hyparquet and
 * hyparquet-compressors, through a memoised dynamic import the first time a Parquet preview runs, so a server
 * that never previews Parquet never loads them. It reads the footer by a suffix range, guards its Thrift bytes and
 * walks its schema before hyparquet builds any tree, plans the first row group's leading columns inside the fetch,
 * decode, leaf and value budgets, then prefetches, pre-scans the page headers and decodes from memory.
 */
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import type * as Hyparquet from "hyparquet";
import type { AsyncBuffer, ColumnChunk, ColumnMetaData, Compressors, FileMetaData, ParquetParsers } from "hyparquet";
import { QueryError } from "@/lib/db/errors";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import { S3_PARQUET_DECODE_QUEUE, S3_PARQUET_DECODE_SLOTS, S3_TYPE, type S3PreviewLimits } from "./constants";
import { type ParquetSchemaShape, walkParquetSchema } from "./parquet-schema";
import { guardThriftStruct, readPageHeader } from "./parquet-thrift-guard";
import type {
  ParquetColumnSummary,
  ParquetSummary,
  S3ByteRange,
  S3ObjectHead,
  S3Preview,
  S3PreviewCell,
  S3PreviewRequest,
} from "./preview";
import { buildRows, cutText, renderCell } from "./preview-cells";
import { FOOTER_BAD_BARE, inMiB, PreviewRefusal, previewSentence, spellName } from "./preview-render";

/** The five codec functions the guarded compressors call. */
export interface ParquetCodecs {
  readonly gzip: (input: Uint8Array, outputLength: number) => Uint8Array;
  readonly brotli: (input: Uint8Array, outputLength: number) => Uint8Array;
  readonly zstd: (input: Uint8Array, output: Uint8Array) => Uint8Array;
  readonly lz4: (input: Uint8Array, outputLength: number) => Uint8Array;
  readonly lz4Raw: (input: Uint8Array, outputLength: number) => Uint8Array;
}

/** What the preview takes from the two packages; tests wrap these to spy on them. */
export interface ParquetModules {
  readonly parquetMetadata: typeof Hyparquet.parquetMetadata;
  readonly parquetReadObjects: typeof Hyparquet.parquetReadObjects;
  readonly snappyUncompress: (input: Uint8Array, output: Uint8Array) => void;
  readonly codecs: ParquetCodecs;
}

async function importParquetModules(): Promise<ParquetModules> {
  const [hyparquet, compressors] = await Promise.all([import("hyparquet"), import("hyparquet-compressors")]);
  return {
    parquetMetadata: hyparquet.parquetMetadata,
    parquetReadObjects: hyparquet.parquetReadObjects,
    snappyUncompress: hyparquet.snappyUncompress,
    codecs: {
      gzip: boundedZlib(gunzipSync),
      brotli: boundedZlib(brotliDecompressSync),
      zstd: compressors.decompressZstd,
      lz4: boundedLz4,
      lz4Raw: boundedLz4Raw,
    },
  };
}

let loaded: Promise<ParquetModules> | undefined;

/** The two packages, imported once per process. */
export function loadParquetModules(): Promise<ParquetModules> {
  loaded ??= importParquetModules();
  return loaded;
}

const DATE_LIMIT_MS = BigInt("8640000000000000");

/** A timestamp of `value` units as `YYYY-MM-DDTHH:MM:SS.f`, floored so a time before 1970 is right, with no Z. */
function timestampText(value: bigint, perSecond: bigint, digits: number, unit: string): string {
  let seconds = value / perSecond;
  let fraction = value % perSecond;
  if (fraction < BigInt(0)) {
    fraction += perSecond;
    seconds -= BigInt(1);
  }
  const milliseconds = seconds * BigInt(1_000);
  if (milliseconds > DATE_LIMIT_MS || milliseconds < -DATE_LIMIT_MS) return `${value} ${unit}`;
  const iso = new Date(Number(milliseconds)).toISOString();
  return `${iso.slice(0, iso.indexOf("."))}.${fraction.toString().padStart(digits, "0")}`;
}

const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function strictText(bytes: Uint8Array | undefined): string | Uint8Array | undefined {
  if (bytes === undefined) return undefined;
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return bytes;
  }
}

/** Parsers that show what was stored, replacing hyparquet's defaults (convert.js:13-40); uuid keeps its default. */
export const PREVIEW_PARSERS: Partial<ParquetParsers> = {
  timestampFromMilliseconds: (value: bigint) => timestampText(value, BigInt(1_000), 3, "ms"),
  timestampFromMicroseconds: (value: bigint) => timestampText(value, BigInt(1_000_000), 6, "us"),
  timestampFromNanoseconds: (value: bigint) => timestampText(value, BigInt(1_000_000_000), 9, "ns"),
  dateFromDays: (days: number) => {
    const milliseconds = days * 86_400_000;
    if (Math.abs(milliseconds) > Number(DATE_LIMIT_MS)) return `${days} days`;
    const iso = new Date(milliseconds).toISOString();
    return iso.slice(0, iso.indexOf("T"));
  },
  stringFromBytes: strictText,
  jsonFromBytes: strictText,
  geometryFromBytes: (bytes: Uint8Array) => bytes,
  geographyFromBytes: (bytes: Uint8Array) => bytes,
};

export interface ParquetPreviewInput {
  readonly head: S3ObjectHead;
  /** A read whose answer previewObject has already checked against the HEAD; returns exactly the asked bytes. */
  readonly read: (range: S3ByteRange, maxBytes: number) => Promise<Uint8Array>;
  readonly request: S3PreviewRequest;
  readonly purpose: "source" | "console";
  readonly limits: S3PreviewLimits;
  readonly signal: AbortSignal;
}

export interface ParquetFooter {
  readonly metadata: FileMetaData;
  readonly shape: ParquetSchemaShape;
  readonly footerLength: number;
  /** Offset of the footer's first byte in the object; the footer bytes run to the end of the object. */
  readonly footerStart: number;
  /** The footer, its length field and PAR1: the object's last `footerLength + 8` bytes. */
  readonly footerBytes: Uint8Array;
}

export type FooterOutcome =
  | { readonly kind: "footer"; readonly footer: ParquetFooter }
  | { readonly kind: "not-parquet"; readonly held?: Uint8Array }
  | { readonly kind: "refused"; readonly sentence: string };

const PAR1 = [0x50, 0x41, 0x52, 0x31];
const endsWithPar1 = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 && PAR1.every((byte, index) => bytes[bytes.length - 4 + index] === byte);
const refused = (sentence: string): FooterOutcome => ({ kind: "refused", sentence });

/**
 * The footer's list elements in all, per schema element the walk admits. hyparquet builds an object for each list
 * element before the schema walk runs, so the guard bounds them first: measured on Node 26.10.0, 131,072 empty column
 * chunks (this multiple at 128 leaf columns) hold 21 MiB after parquetMetadata. Real writers declare few list elements
 * per column chunk (pyarrow and DuckDB write five to seven: the encodings, the path, the encoding stats), so the field
 * bound below is the one a real footer meets first.
 */
const FOOTER_LIST_ELEMENTS_PER_SCHEMA_ELEMENT = 128;

/**
 * The footer's fields in all, at every depth. hyparquet builds a property for each field, and a struct object for
 * each struct field, before the schema walk runs, and a 1 MiB footer can declare a million one-byte fields: measured
 * on Node 26.10.0, 1,000,000 distinct boolean fields grow the heap by 94 MiB in parquetMetadata, while at this bound
 * the costliest shape (262,143 empty struct fields beside a list of 131,072 empty structs, the list budget) grows it by
 * 55 MiB in 120 ms. The parse runs inside a decode slot, so that growth counts in the slots' shared budget.
 * Real column chunks with statistics declare 18 to 22 fields in 47 to 111 bytes (DuckDB), 25 to 32 in 74 to 126
 * bytes (pyarrow) and 18 in about 75 bytes (Polars): about 270,000 fields per MiB of row groups for DuckDB, 265,000
 * to 296,000 for pyarrow and 245,000 for Polars. This bound admits a footer of 60-column pyarrow row groups up to about
 * 1,030,000 bytes and a Polars footer up to the 1 MiB footer cap; denser mixes, DuckDB's and narrow pyarrow's, are
 * admitted up to about 900 to 990 KiB.
 */
const FOOTER_MAX_FIELDS = 262_144;

/**
 * Parquet writes a row group's column chunks one per schema leaf, in schema order; the plan and the summary pair
 * them by that order, so a chunk list of another length, a chunk with no metadata, or a chunk whose path is not the
 * leaf's at its position is refused.
 */
function chunksMatchLeaves(chunks: readonly ColumnChunk[], shape: ParquetSchemaShape): boolean {
  if (chunks.length !== shape.leaves.length) return false;
  return chunks.every((chunk, index) => {
    const path = chunk.meta_data?.path_in_schema;
    const leaf = shape.leaves[index].path;
    return path !== undefined && path.length === leaf.length && path.every((name, depth) => name === leaf[depth]);
  });
}

const metaOf = (chunk: ColumnChunk): ColumnMetaData => chunk.meta_data as ColumnMetaData;

const ZERO = BigInt(0);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** An i64 as hyparquet parses one (a bigint) between 0 and 2^53 - 1, checked before any Number() coercion. */
const isCount = (value: unknown): boolean => typeof value === "bigint" && value >= ZERO && value <= MAX_SAFE;

/**
 * The footer values the plan and the reads use: the file's and the first row group's num_rows, and each first-row-group
 * chunk's num_values, sizes and page offsets, the dictionary page offset when present. Each must be a non-negative safe
 * integer read as an i64, so no running sum can drop below a cap, and a chunk's range computed with Number() equals the
 * range hyparquet computes with bigint arithmetic.
 */
function footerValuesHold(metadata: FileMetaData): boolean {
  if (!isCount(metadata.num_rows)) return false;
  const first = metadata.row_groups[0];
  if (first === undefined) return true;
  if (!isCount(first.num_rows)) return false;
  return first.columns.every((chunk) => {
    const meta = metaOf(chunk);
    return (
      isCount(meta.num_values) &&
      isCount(meta.total_compressed_size) &&
      isCount(meta.total_uncompressed_size) &&
      isCount(meta.data_page_offset) &&
      (meta.dictionary_page_offset === undefined || isCount(meta.dictionary_page_offset))
    );
  });
}

/**
 * hyparquet's footer parse, or undefined when it throws. It runs inside a decode slot, released before planning, so
 * its heap counts in the same budget as the decodes however many previews run at once.
 */
async function parseFooter(
  input: ParquetPreviewInput,
  footerBytes: Uint8Array<ArrayBuffer>,
  modules: ParquetModules,
  slots: DecodeSlots,
): Promise<FileMetaData | undefined> {
  const release = await slots.acquire(input.signal);
  try {
    input.signal.throwIfAborted();
    try {
      return modules.parquetMetadata(footerBytes.buffer, { geoparquet: false, parsers: PREVIEW_PARSERS });
    } catch {
      return undefined;
    }
  } finally {
    release();
  }
}

/**
 * The tail read, the footer length checks, the second read when needed, the guard, the parse in a decode slot, the
 * walk. A full slot queue rejects with R-PQ-BUSY.
 */
export async function readParquetFooter(
  input: ParquetPreviewInput,
  modules: ParquetModules,
  slots: DecodeSlots,
): Promise<FooterOutcome> {
  const { limits } = input;
  const size = input.head.size;
  if (size < 12) return { kind: "not-parquet" };
  const tailLength = Math.min(limits.parquetTailBytes, size);
  const tail = await input.read({ kind: "suffix", length: tailLength }, tailLength);
  if (!endsWithPar1(tail)) return tailLength === size ? { kind: "not-parquet", held: tail } : { kind: "not-parquet" };
  const footerLength = new DataView(tail.buffer, tail.byteOffset, tail.byteLength).getUint32(tail.length - 8, true);
  if (footerLength > limits.parquetFooterMaxBytes) {
    return refused(previewSentence("R-PQ-FOOTER-BIG", { n: footerLength, footerMax: limits.parquetFooterMaxBytes }));
  }
  if (footerLength + 12 > size) return refused(previewSentence("R-PQ-FOOTER-LONG", { n: footerLength }));
  const footerBytes = new Uint8Array(footerLength + 8);
  if (footerLength + 8 > tailLength) {
    const start = size - 8 - footerLength;
    const end = size - tailLength;
    footerBytes.set(await input.read({ kind: "span", start, end }, end - start), 0);
    footerBytes.set(tail, end - start);
  } else {
    footerBytes.set(tail.subarray(tailLength - footerLength - 8));
  }
  const schemaBound = limits.parquetMaxLeafColumns * 8;
  let schemaElements = 0;
  const guard = guardThriftStruct(footerBytes.subarray(0, footerLength), 0, limits.thriftMaxDepth, {
    maxListElements: schemaBound * FOOTER_LIST_ELEMENTS_PER_SCHEMA_ELEMENT,
    maxFields: FOOTER_MAX_FIELDS,
    onField: (path, type, value) => {
      if (path.length === 1 && path[0] === 2 && type === 9) schemaElements = Math.max(schemaElements, value as number);
    },
  });
  if (!guard.ok) return refused(previewSentence("R-PQ-FOOTER-BAD", { reason: guard.reason }));
  if (schemaElements > schemaBound) return refused(previewSentence("R-PQ-SCHEMA"));
  const metadata = await parseFooter(input, footerBytes, modules, slots);
  if (metadata === undefined) return refused(FOOTER_BAD_BARE);
  const shape = walkParquetSchema(metadata.schema, limits);
  if (!shape.ok) return refused(previewSentence("R-PQ-SCHEMA"));
  const first = metadata.row_groups[0];
  if (first !== undefined && !chunksMatchLeaves(first.columns, shape)) return refused(FOOTER_BAD_BARE);
  if (!footerValuesHold(metadata)) return refused(FOOTER_BAD_BARE);
  return {
    kind: "footer",
    footer: { metadata, shape, footerLength, footerStart: size - 8 - footerLength, footerBytes },
  };
}

/** A chunk's codec as the preview prints it: hyparquet maps an id past the format's table to undefined. */
const codecOf = (meta: ColumnMetaData): string => (meta.codec as string | undefined) ?? "an unknown codec";

/** Counts, the writer, the first row group, and each leaf's first-row-group statistics. */
export function summarizeParquet(
  footer: ParquetFooter,
  limits: S3PreviewLimits,
): { readonly summary: ParquetSummary; readonly notices: readonly string[] } {
  const { metadata, shape } = footer;
  const first = metadata.row_groups[0];
  let cutCells = 0;
  const cell = (value: unknown): S3PreviewCell => {
    const rendered = renderCell(value, limits.summaryCellChars, limits.cellMaxDepth);
    if (rendered.cut) cutCells += 1;
    return rendered.cell;
  };
  let createdBy: string | null = null;
  if (metadata.created_by !== undefined) {
    const cut = cutText(metadata.created_by, limits.summaryCellChars);
    if (cut.cut) cutCells += 1;
    createdBy = cut.text;
  }
  const chunks = first?.columns ?? [];
  const columns: ParquetColumnSummary[] = chunks.slice(0, limits.maxColumns).map((chunk, index) => {
    const meta = metaOf(chunk);
    const leaf = shape.leaves[index];
    const statistics = leaf.underVariant ? undefined : meta.statistics;
    return {
      path: meta.path_in_schema.join("."),
      type: leaf.type,
      codec: codecOf(meta),
      nulls: cell(statistics?.null_count),
      min: cell(statistics?.min_value ?? statistics?.min),
      max: cell(statistics?.max_value ?? statistics?.max),
      compressedBytes: Number(meta.total_compressed_size),
      uncompressedBytes: Number(meta.total_uncompressed_size),
    };
  });
  const sum = (field: "total_compressed_size" | "total_uncompressed_size"): number =>
    chunks.reduce((total, chunk) => total + Number(metaOf(chunk)[field]), 0);
  const summary: ParquetSummary = {
    rows: cell(metadata.num_rows),
    rowGroups: metadata.row_groups.length,
    createdBy,
    firstRowGroup:
      first === undefined
        ? null
        : {
            rows: cell(first.num_rows),
            compressedBytes: sum("total_compressed_size"),
            uncompressedBytes: sum("total_uncompressed_size"),
          },
    columns,
  };
  const notices: string[] = [];
  if (chunks.length > limits.maxColumns)
    notices.push(previewSentence("N-COLUMNS", { cap: limits.maxColumns, n: chunks.length }));
  if (cutCells > 0) notices.push(previewSentence("N-CELLS", { k: cutCells, cap: limits.summaryCellChars }));
  return { summary, notices };
}

const READABLE_CODECS: ReadonlySet<string> = new Set([
  "UNCOMPRESSED",
  "SNAPPY",
  "GZIP",
  "BROTLI",
  "ZSTD",
  "LZ4",
  "LZ4_RAW",
]);

/** One top-level column's first-row-group costs. */
export interface PlannedColumn {
  readonly name: string;
  readonly type: string;
  readonly chunks: readonly ColumnChunk[];
  readonly fetch: number;
  readonly decode: number;
  readonly leaves: number;
  readonly values: number;
  readonly readable: boolean;
  /** The codec of the first chunk the preview cannot read, else of the first chunk. */
  readonly codec: string;
  readonly variant: boolean;
  readonly decimals: readonly { readonly path: string; readonly precision: number; readonly scale: number }[];
}

export type ParquetPlan =
  | { readonly kind: "summary"; readonly notices: readonly string[] }
  | {
      readonly kind: "rows";
      readonly columns: readonly PlannedColumn[];
      readonly rowsToRead: number;
      readonly rowsAsked: number;
      readonly notices: readonly string[];
    };

function costs(footer: ParquetFooter): PlannedColumn[] {
  const first = footer.metadata.row_groups[0];
  return footer.shape.columns.map((column) => {
    const chunks = first.columns.filter((chunk) => metaOf(chunk).path_in_schema[0] === column.name);
    const total = (read: (meta: ColumnMetaData) => bigint): number =>
      chunks.reduce((sum, chunk) => sum + Number(read(metaOf(chunk))), 0);
    const unreadable = chunks.find(
      (chunk) => chunk.file_path !== undefined || !READABLE_CODECS.has(codecOf(metaOf(chunk))),
    );
    return {
      name: column.name,
      type: column.type,
      chunks,
      fetch: total((meta) => meta.total_compressed_size),
      decode: total((meta) => meta.total_uncompressed_size),
      leaves: chunks.length,
      values: total((meta) => meta.num_values),
      readable: unreadable === undefined,
      codec: codecOf(metaOf(unreadable ?? chunks[0])),
      variant: column.variant,
      decimals: footer.shape.leaves
        .filter((leaf) => leaf.path[0] === column.name && leaf.decimal !== undefined)
        .map((leaf) => ({
          path: leaf.path.join("."),
          precision: leaf.decimal?.precision ?? 0,
          scale: leaf.decimal?.scale ?? 0,
        })),
    };
  });
}

/** The limits the column-stop sentences name. */
function capsOf(limits: S3PreviewLimits) {
  return {
    fetchBudget: inMiB(limits.parquetFetchBudget),
    decodeBudget: inMiB(limits.parquetDecodeBudget),
    leafCap: limits.parquetMaxLeafColumns,
    valueCap: limits.parquetMaxTotalValues,
  };
}

/** N-PQ-NONE-FIT: the summary's sentence when even the first column does not fit. */
function noneFit(column: PlannedColumn, limits: S3PreviewLimits): string {
  return previewSentence("N-PQ-NONE-FIT", {
    fetch: inMiB(column.fetch),
    decode: inMiB(column.decode),
    ...capsOf(limits),
  });
}

/** The notices about the rows read: N-PQ-RG0 for a short first row group, N-PQ-DECIMAL for each chosen wide DECIMAL. */
function rowNotices(footer: ParquetFooter, columns: readonly PlannedColumn[], rowsAsked: number): string[] {
  const notices: string[] = [];
  const firstRows = Number(footer.metadata.row_groups[0].num_rows);
  if (firstRows < rowsAsked && footer.metadata.row_groups.length > 1)
    notices.push(previewSentence("N-PQ-RG0", { m: firstRows }));
  for (const column of columns) {
    for (const decimal of column.decimals) {
      if (decimal.precision > 15) {
        notices.push(
          previewSentence("N-PQ-DECIMAL", { c: spellName(decimal.path), p: decimal.precision, s: decimal.scale }),
        );
      }
    }
  }
  return notices;
}

/** The columns to read from the first row group, leading or explicit, and how many rows. */
export function planParquet(
  footer: ParquetFooter,
  request: S3PreviewRequest,
  purpose: "source" | "console",
  limits: S3PreviewLimits,
): ParquetPlan {
  const first = footer.metadata.row_groups[0];
  if (first === undefined || Number(first.num_rows) === 0)
    return { kind: "summary", notices: [previewSentence("N-PQ-NO-ROWS")] };
  if (request.schemaOnly === true) return { kind: "summary", notices: [] };
  const all = costs(footer);
  const caps = capsOf(limits);
  const over = (fetch: number, decode: number, leaves: number, values: number): boolean =>
    fetch > limits.parquetFetchBudget ||
    decode > limits.parquetDecodeBudget ||
    leaves > limits.parquetMaxLeafColumns ||
    values > limits.parquetMaxTotalValues;
  const notices: string[] = [];
  let chosen: PlannedColumn[] = [];
  if (request.columns === undefined) {
    let fetch = 0;
    let decode = 0;
    let leaves = 0;
    let values = 0;
    for (const column of all) {
      const c = spellName(column.name);
      if (!column.readable) {
        notices.push(previewSentence("N-PQ-CODEC", { c, codec: column.codec }));
        break;
      }
      if (column.variant) {
        notices.push(previewSentence("N-PQ-VARIANT", { c }));
        break;
      }
      if (over(fetch + column.fetch, decode + column.decode, leaves + column.leaves, values + column.values)) {
        notices.push(
          chosen.length === 0
            ? noneFit(column, limits)
            : previewSentence("N-PQ-SOME-COLUMNS", { k: chosen.length, n: all.length, ...caps }),
        );
        break;
      }
      if (chosen.length >= limits.maxColumns) {
        notices.push(previewSentence("N-PQ-MAX-COLUMNS", { k: chosen.length, n: all.length }));
        break;
      }
      chosen.push(column);
      fetch += column.fetch;
      decode += column.decode;
      leaves += column.leaves;
      values += column.values;
    }
    if (chosen.length === 0) return { kind: "summary", notices };
  } else {
    const byName = new Map(all.map((column) => [column.name, column] as const));
    chosen = request.columns.map((name) => {
      const column = byName.get(name);
      if (column === undefined)
        throw new QueryError(previewSentence("R-PQ-NO-COLUMN", { c: spellName(name) }), S3_TYPE);
      return column;
    });
    for (const column of chosen) {
      if (!column.readable) {
        throw new QueryError(
          previewSentence("R-PQ-COLUMN-CODEC", { c: spellName(column.name), codec: column.codec }),
          S3_TYPE,
        );
      }
    }
    for (const column of chosen) {
      if (column.variant)
        throw new QueryError(previewSentence("R-PQ-COLUMN-VARIANT", { c: spellName(column.name) }), S3_TYPE);
    }
    const sum = (read: (column: PlannedColumn) => number): number =>
      chosen.reduce((total, column) => total + read(column), 0);
    const fetch = sum((column) => column.fetch);
    const decode = sum((column) => column.decode);
    const leaves = sum((column) => column.leaves);
    const values = sum((column) => column.values);
    if (over(fetch, decode, leaves, values)) {
      throw new QueryError(
        previewSentence("R-PQ-COLUMNS-BIG", { fetch: inMiB(fetch), decode: inMiB(decode), leaves, values, ...caps }),
        S3_TYPE,
      );
    }
  }
  const rowsAsked = purpose === "source" ? limits.sourceRows : (request.maxRows ?? limits.defaultRows);
  notices.push(...rowNotices(footer, chosen, rowsAsked));
  return {
    kind: "rows",
    columns: chosen,
    rowsToRead: Math.min(rowsAsked, Number(first.num_rows)),
    rowsAsked,
    notices,
  };
}

/** The guarded compressors' refusal; previewParquet reports it as R-PQ-DECODE. */
export const DECODE_OVER_BUDGET = "The pages declare more decoded bytes than the preview decodes";

/** The prefetch buffer's refusal of a slice it does not hold; previewParquet reports it as R-PQ-DECODE. */
const OUTSIDE_PLAN = "The Parquet reader asked for bytes outside the planned ranges";

/**
 * A node:zlib decoder whose output may not pass the declared length: zlib stops at `maxOutputLength`, and an output
 * longer or shorter than the declared length throws DECODE_OVER_BUDGET. Any other zlib error is rethrown unchanged.
 * zlib refuses a limit of 0, so a declared length of 0 decodes with a limit of 1 and the length check refuses any byte.
 */
export function boundedZlib(
  decode: (input: Uint8Array, options: { maxOutputLength: number }) => Uint8Array,
): (input: Uint8Array, outputLength: number) => Uint8Array {
  return (input, outputLength) => {
    let output: Uint8Array;
    try {
      output = decode(input, { maxOutputLength: Math.max(1, outputLength) });
    } catch (error) {
      if ((error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE")
        throw new Error(DECODE_OVER_BUDGET, { cause: error });
      throw error;
    }
    if (output.length !== outputLength) throw new Error(DECODE_OVER_BUDGET);
    return new Uint8Array(output.buffer, output.byteOffset, output.length);
  };
}

/** The bounded LZ4 decoders' refusal of a block that breaks the format; previewParquet reports it as R-PQ-DECODE. */
const LZ4_MALFORMED = "The LZ4 data is malformed";

/** An LZ4 length: the token's nibble, then while it reads 15, each following byte added until one is not 255. */
function lz4Length(input: Uint8Array, nibble: number, at: { i: number }): number {
  let length = nibble;
  if (nibble !== 15) return length;
  for (;;) {
    if (at.i >= input.length) throw new Error(LZ4_MALFORMED);
    const byte = input[at.i];
    at.i += 1;
    length += byte;
    if (byte !== 255) return length;
  }
}

/**
 * Decodes one LZ4 block into `output` from `start`, never past `limit`: a literal run or a match that would pass it
 * throws DECODE_OVER_BUDGET before it is copied, so the work is bounded by the input and the limit, not by the lengths
 * the block declares. Returns where the output ends.
 */
function lz4Block(input: Uint8Array, output: Uint8Array, start: number, limit: number): number {
  let out = start;
  const at = { i: 0 };
  while (at.i < input.length) {
    const token = input[at.i];
    at.i += 1;
    const literals = lz4Length(input, token >> 4, at);
    if (literals > 0) {
      if (at.i + literals > input.length) throw new Error(LZ4_MALFORMED);
      if (out + literals > limit) throw new Error(DECODE_OVER_BUDGET);
      output.set(input.subarray(at.i, at.i + literals), out);
      out += literals;
      at.i += literals;
      if (at.i >= input.length) return out;
    }
    if (at.i + 2 > input.length) throw new Error(LZ4_MALFORMED);
    const offset = input[at.i] | (input[at.i + 1] << 8);
    at.i += 2;
    if (offset === 0 || offset > out) throw new Error(LZ4_MALFORMED);
    const match = lz4Length(input, token & 0x0f, at) + 4;
    if (out + match > limit) throw new Error(DECODE_OVER_BUDGET);
    for (let end = out + match; out < end; out += 1) output[out] = output[out - offset];
  }
  return out;
}

/** LZ4_RAW: one block that must decode to exactly `outputLength` bytes, else DECODE_OVER_BUDGET. */
export function boundedLz4Raw(input: Uint8Array, outputLength: number): Uint8Array {
  const output = new Uint8Array(outputLength);
  if (lz4Block(input, output, 0, outputLength) !== outputLength) throw new Error(DECODE_OVER_BUDGET);
  return output;
}

/** Reads `input` as Hadoop LZ4 frames into `output`; false when it is not framed that way (hyparquet-compressors' rule). */
function hadoopFrames(input: Uint8Array, output: Uint8Array): boolean {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let i = 0;
  let o = 0;
  while (i < input.length - 8) {
    const frameOutput = view.getUint32(i);
    const frameInput = view.getUint32(i + 4);
    i += 8;
    if (input.length - i < frameInput || o + frameOutput > output.length) return false;
    try {
      if (lz4Block(input.subarray(i, i + frameInput), output, o, o + frameOutput) !== o + frameOutput) return false;
    } catch {
      return false;
    }
    i += frameInput;
    o += frameOutput;
    if (i === input.length) {
      if (o !== output.length) throw new Error(DECODE_OVER_BUDGET);
      return true;
    }
  }
  return false;
}

/**
 * Legacy LZ4: Hadoop frames when the input reads as such, else one raw block, as hyparquet-compressors decides; either
 * way bounded by `outputLength` and refused unless it fills it exactly.
 */
export function boundedLz4(input: Uint8Array, outputLength: number): Uint8Array {
  const output = new Uint8Array(outputLength);
  if (hadoopFrames(input, output)) return output;
  return boundedLz4Raw(input, outputLength);
}

/** The bounded zstd decoder's refusal of a frame that breaks the format; previewParquet reports it as R-PQ-DECODE. */
const ZSTD_MALFORMED = "The ZSTD data is malformed";

/** The bytes of the dictionary id each value of a frame header's dictionary flag declares. */
const ZSTD_DICTIONARY_BYTES = [0, 1, 2, 4];

/** An FSE decoding table as fzstd builds one: accuracy log, and per state its symbol, bit count and next state base. */
interface ZstdFseTable {
  readonly b: number;
  readonly s: Uint8Array;
  readonly n: Uint8Array;
  readonly t: Uint16Array;
}

/** The index of the highest set bit, -1 for 0 (fzstd's msb). */
function zstdMsb(value: number): number {
  let bits = 0;
  while (1 << bits <= value) bits += 1;
  return bits - 1;
}

/**
 * fzstd 0.1.1's FSE table reader (rfse), ported expression for expression so the sequence walk below reads the same
 * symbols and states the decoder will. Out-of-range reads give undefined, which the bitwise operators read as 0, as
 * they do in fzstd. Returns the byte after the table description and the table. fzstd is MIT licensed, Copyright (c)
 * 2020 Arjun Barrett; this reader, the default tables and the block walk below follow its code.
 */
function zstdFse(dat: Uint8Array, bt: number, maxLog: number): [number, ZstdFseTable] {
  let tpos = (bt << 3) + 4;
  const al = (dat[bt] & 15) + 5;
  if (al > maxLog) throw new Error(ZSTD_MALFORMED);
  const sz = 1 << al;
  let probs = sz;
  let sym = -1;
  let ht = sz;
  const buf = new ArrayBuffer(512 + (sz << 2));
  const freq = new Int16Array(buf, 0, 256);
  const dstate = new Uint16Array(buf, 0, 256);
  const nstate = new Uint16Array(buf, 512, sz);
  const bb1 = 512 + (sz << 1);
  const syms = new Uint8Array(buf, bb1, sz);
  const nbits = new Uint8Array(buf, bb1 + sz);
  while (sym < 255 && probs > 0) {
    const bits = zstdMsb(probs + 1);
    const cbt = tpos >> 3;
    const msk = (1 << (bits + 1)) - 1;
    let val = ((dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16)) >> (tpos & 7)) & msk;
    const msk1fb = (1 << bits) - 1;
    const msv = msk - probs - 1;
    const sval = val & msk1fb;
    if (sval < msv) {
      tpos += bits;
      val = sval;
    } else {
      tpos += bits + 1;
      if (val > msk1fb) val -= msv;
    }
    freq[++sym] = --val;
    if (val === -1) {
      probs += val;
      syms[--ht] = sym;
    } else probs -= val;
    if (!val) {
      let re: number;
      do {
        const rbt = tpos >> 3;
        re = ((dat[rbt] | (dat[rbt + 1] << 8)) >> (tpos & 7)) & 3;
        tpos += 2;
        sym += re;
      } while (re === 3);
    }
  }
  if (sym > 255 || probs) throw new Error(ZSTD_MALFORMED);
  let sympos = 0;
  const sstep = (sz >> 1) + (sz >> 3) + 3;
  const smask = sz - 1;
  for (let s = 0; s <= sym; ++s) {
    const sf = freq[s];
    if (sf < 1) {
      dstate[s] = -sf;
      continue;
    }
    for (let i = 0; i < sf; ++i) {
      syms[sympos] = s;
      do {
        sympos = (sympos + sstep) & smask;
      } while (sympos >= ht);
    }
  }
  if (sympos) throw new Error(ZSTD_MALFORMED);
  for (let i = 0; i < sz; ++i) {
    const ns = dstate[syms[i]]++;
    const nb = (nbits[i] = al - zstdMsb(ns));
    nstate[i] = (ns << nb) - sz;
  }
  return [(tpos + 7) >> 3, { b: al, s: syms, n: nbits, t: nstate }];
}

/** The predefined literal length, match length and offset tables, built from fzstd's own descriptions. */
const ZSTD_DEFAULT_TABLES: readonly ZstdFseTable[] = [
  zstdFse(
    Uint8Array.from([
      33, 20, 196, 24, 99, 140, 33, 132, 16, 66, 8, 33, 132, 16, 66, 8, 33, 68, 68, 68, 68, 68, 68, 68, 68, 36, 9,
    ]),
    0,
    6,
  )[1],
  zstdFse(Uint8Array.from([32, 132, 16, 66, 102, 70, 68, 68, 68, 68, 36, 73, 2]), 0, 5)[1],
  zstdFse(Uint8Array.from([81, 16, 99, 140, 49, 198, 24, 99, 12, 33, 196, 24, 99, 102, 102, 134, 70, 146, 4]), 0, 6)[1],
];

/** Extra bits and baselines of the 36 literal length codes and the 53 match length codes. */
const ZSTD_LITERAL_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
];
const ZSTD_MATCH_BITS = [
  ...new Array<number>(32).fill(0),
  1,
  1,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
];
const zstdBaselines = (bits: readonly number[], start: number): number[] => {
  let at = start;
  return bits.map((width) => {
    const baseline = at;
    at += 1 << width;
    return baseline;
  });
};
const ZSTD_LITERAL_BASE = zstdBaselines(ZSTD_LITERAL_BITS, 0);
const ZSTD_MATCH_BASE = zstdBaselines(ZSTD_MATCH_BITS, 3);

/**
 * The bytes a compressed block regenerates, read the way fzstd's block decoder (rzb) reads it: the literals header,
 * the sequence count, the table modes and tables, then each sequence's literal and match lengths, without decoding a
 * literal or copying a byte. fzstd runs a sequence's copy loops for the full lengths whatever its output holds, so the
 * running total of literals plus match lengths is refused as soon as it passes `room`, the frame's content size left,
 * and a sequence that takes more literals than the block carries, or a code the format does not define, is malformed.
 * `tables` carries the last tables of the frame, which a later block may repeat.
 */
function zstdCompressedBlock(
  dat: Uint8Array,
  start: number,
  end: number,
  room: number,
  frame: { tables?: readonly ZstdFseTable[] },
): number {
  let bt = start;
  const b3 = dat[bt];
  const lbt = b3 & 3;
  const sf = (b3 >> 2) & 3;
  let lss = b3 >> 4;
  let lcs = 0;
  if (lbt < 2) {
    if (sf & 1) lss |= (dat[++bt] << 4) | (sf & 2 && dat[++bt] << 12);
    else lss = b3 >> 3;
  } else if (sf < 2) {
    lss |= (dat[++bt] & 63) << 4;
    lcs = (dat[bt] >> 6) | (dat[++bt] << 2);
  } else if (sf === 2) {
    lss |= (dat[++bt] << 4) | ((dat[++bt] & 3) << 12);
    lcs = (dat[bt] >> 2) | (dat[++bt] << 6);
  } else {
    lss |= (dat[++bt] << 4) | ((dat[++bt] & 63) << 12);
    lcs = (dat[bt] >> 6) | (dat[++bt] << 2) | (dat[++bt] << 10);
  }
  ++bt;
  if (lss > room) throw new Error(DECODE_OVER_BUDGET);
  bt += lbt === 0 ? lss : lbt === 1 ? 1 : lcs;
  let ns = dat[bt++];
  if (!ns) return lss;
  if (ns === 255) ns = (dat[bt++] | (dat[bt++] << 8)) + 0x7f00;
  else if (ns > 127) ns = ((ns - 128) << 8) | dat[bt++];
  const scm = dat[bt++];
  if (scm & 3) throw new Error(ZSTD_MALFORMED);
  const dts = [...ZSTD_DEFAULT_TABLES];
  for (let i = 2; i > -1; --i) {
    const md = (scm >> ((i << 1) + 2)) & 3;
    if (md === 1) {
      dts[i] = { b: 0, s: Uint8Array.of(dat[bt++]), n: Uint8Array.of(0), t: Uint16Array.of(0) };
    } else if (md === 2) {
      [bt, dts[i]] = zstdFse(dat, bt, 9 - (i & 1));
    } else if (md === 3) {
      if (frame.tables === undefined) throw new Error(ZSTD_MALFORMED);
      dts[i] = frame.tables[i];
    }
  }
  frame.tables = dts;
  const [mlt, oct, llt] = dts;
  const lb = dat[end - 1];
  if (!lb) throw new Error(ZSTD_MALFORMED);
  let spos = (end << 3) - 8 + zstdMsb(lb) - llt.b;
  let cbt = spos >> 3;
  let lst = ((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << llt.b) - 1);
  cbt = (spos -= oct.b) >> 3;
  let ost = ((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << oct.b) - 1);
  cbt = (spos -= mlt.b) >> 3;
  let mst = ((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << mlt.b) - 1);
  let literals = 0;
  let matches = 0;
  for (; ns > 0; ns -= 1) {
    const llc = llt.s[lst];
    const lbtr = llt.n[lst];
    const mlc = mlt.s[mst];
    const mbtr = mlt.n[mst];
    const ofc = oct.s[ost];
    const obtr = oct.n[ost];
    if (llc > 35 || mlc > 52 || ofc > 31) throw new Error(ZSTD_MALFORMED);
    spos -= ofc;
    cbt = (spos -= ZSTD_MATCH_BITS[mlc]) >> 3;
    const ml =
      ZSTD_MATCH_BASE[mlc] +
      (((dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16)) >> (spos & 7)) & ((1 << ZSTD_MATCH_BITS[mlc]) - 1));
    cbt = (spos -= ZSTD_LITERAL_BITS[llc]) >> 3;
    const ll =
      ZSTD_LITERAL_BASE[llc] +
      (((dat[cbt] | (dat[cbt + 1] << 8) | (dat[cbt + 2] << 16)) >> (spos & 7)) & ((1 << ZSTD_LITERAL_BITS[llc]) - 1));
    cbt = (spos -= lbtr) >> 3;
    lst = llt.t[lst] + (((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << lbtr) - 1));
    cbt = (spos -= mbtr) >> 3;
    mst = mlt.t[mst] + (((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << mbtr) - 1));
    cbt = (spos -= obtr) >> 3;
    ost = oct.t[ost] + (((dat[cbt] | (dat[cbt + 1] << 8)) >> (spos & 7)) & ((1 << obtr) - 1));
    literals += ll;
    if (literals > lss) throw new Error(ZSTD_MALFORMED);
    matches += ml;
    if (lss + matches > room) throw new Error(DECODE_OVER_BUDGET);
  }
  return lss + matches;
}

/**
 * Reads the zstd frame header at `start` and walks its blocks without decoding them: where the frame ends and the
 * content size it declares. A frame that declares no content size, or one past `room`, is refused before any work.
 * Then each block's regenerated bytes, raw and RLE from their headers and compressed ones from their sequences, are
 * summed over the frame as the decoder will see it, and a frame whose blocks pass its content size is refused, so
 * fzstd's work on the frame stays within that size.
 */
function zstdFrame(input: Uint8Array, start: number, room: number): { readonly end: number; readonly size: number } {
  if (start + 5 > input.length) throw new Error(ZSTD_MALFORMED);
  const descriptor = input[start + 4];
  if ((descriptor & 0x08) !== 0) throw new Error(ZSTD_MALFORMED);
  const singleSegment = (descriptor >> 5) & 1;
  const sizeFlag = descriptor >> 6;
  const sizeBytes = sizeFlag === 0 ? singleSegment : 1 << sizeFlag;
  if (sizeBytes === 0) throw new Error(DECODE_OVER_BUDGET);
  let at = start + 5 + (1 - singleSegment) + ZSTD_DICTIONARY_BYTES[descriptor & 3];
  if (at + sizeBytes > input.length) throw new Error(ZSTD_MALFORMED);
  let size = 0;
  for (let byte = sizeBytes - 1; byte >= 0; byte -= 1) size = size * 256 + input[at + byte];
  if (sizeBytes === 2) size += 256;
  if (size > room) throw new Error(DECODE_OVER_BUDGET);
  at += sizeBytes;
  const blocks: { readonly at: number; readonly type: number; readonly size: number }[] = [];
  for (let last = false; !last; ) {
    if (at + 3 > input.length) throw new Error(ZSTD_MALFORMED);
    const header = input[at] | (input[at + 1] << 8) | (input[at + 2] << 16);
    const type = (header >> 1) & 3;
    const blockSize = header >>> 3;
    if (type === 3) throw new Error(ZSTD_MALFORMED);
    const body = type === 1 ? 1 : blockSize;
    if (at + 3 + body > input.length) throw new Error(ZSTD_MALFORMED);
    blocks.push({ at: at + 3 - start, type, size: blockSize });
    at += 3 + body;
    last = (header & 1) === 1;
  }
  if ((descriptor & 0x04) !== 0) {
    if (at + 4 > input.length) throw new Error(ZSTD_MALFORMED);
    at += 4;
  }
  const dat = input.subarray(start, at);
  const frame: { tables?: readonly ZstdFseTable[] } = {};
  let regenerated = 0;
  for (const block of blocks) {
    regenerated +=
      block.type === 2
        ? zstdCompressedBlock(dat, block.at, block.at + block.size, size - regenerated, frame)
        : block.size;
    if (regenerated > size) throw new Error(DECODE_OVER_BUDGET);
  }
  return { end: at, size };
}

/**
 * zstd bounded by `outputLength`: fzstd given one output buffer starts every frame at its offset 0, so an input of many
 * frames would do that buffer's work once per frame, and its sequence loop runs each match for its full length even
 * where its output view stops. Each frame must declare its content size, the sizes may not pass `outputLength`, the
 * literals and match lengths of each frame's blocks may not pass its content size, and each frame decodes into its own
 * part of the output; skippable frames are skipped by their length. An output shorter than `outputLength` is refused
 * with DECODE_OVER_BUDGET.
 */
export function boundedZstd(input: Uint8Array, outputLength: number, decompress: ParquetCodecs["zstd"]): Uint8Array {
  const output = new Uint8Array(outputLength);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let at = 0;
  let out = 0;
  while (at < input.length) {
    if (at + 4 > input.length) throw new Error(ZSTD_MALFORMED);
    const magic = view.getUint32(at, true);
    if (magic >>> 4 === 0x184d2a5) {
      if (at + 8 > input.length) throw new Error(ZSTD_MALFORMED);
      const skip = view.getUint32(at + 4, true);
      if (at + 8 + skip > input.length) throw new Error(ZSTD_MALFORMED);
      at += 8 + skip;
      continue;
    }
    if (magic !== 0xfd2fb528) throw new Error(ZSTD_MALFORMED);
    const frame = zstdFrame(input, at, outputLength - out);
    decompress(input.subarray(at, frame.end), output.subarray(out, out + frame.size));
    out += frame.size;
    at = frame.end;
  }
  if (out !== outputLength) throw new Error(DECODE_OVER_BUDGET);
  return output;
}

/**
 * The second line behind the pre-scan: each codec checks that the declared output length is a non-negative
 * integer within the budget left before it runs, then spends it, so no call can leave the budget anything but a
 * whole number. Snappy is hyparquet's own pure-JavaScript decoder, so hysnappy's shared WASM
 * memory is never grown; zstd decodes through the frame and sequence walk above, each frame into its own part of a
 * buffer of the declared size, since fzstd otherwise sizes from the frame, given a buffer restarts it for every frame,
 * and copies a match for its declared length past its output. Gzip and
 * brotli decode through node:zlib with the declared length as the output limit, because the package decoders size
 * their output from the stream, and both LZ4 codecs through the bounded decoders above, because the package decoder
 * keeps copying a match past its output.
 */
export function guardedCompressors(budget: number, modules: ParquetModules): Compressors {
  let left = budget;
  const guard =
    (codec: (input: Uint8Array, outputLength: number) => Uint8Array) =>
    (input: Uint8Array, outputLength: number): Uint8Array => {
      if (!Number.isSafeInteger(outputLength) || outputLength < 0 || outputLength > left)
        throw new Error(DECODE_OVER_BUDGET);
      const output = codec(input, outputLength);
      left -= outputLength;
      return output;
    };
  return {
    SNAPPY: guard((input, outputLength) => {
      const output = new Uint8Array(outputLength);
      modules.snappyUncompress(input, output);
      return output;
    }),
    GZIP: guard(modules.codecs.gzip),
    BROTLI: guard(modules.codecs.brotli),
    ZSTD: guard((input, outputLength) => boundedZstd(input, outputLength, modules.codecs.zstd)),
    LZ4: guard(modules.codecs.lz4),
    LZ4_RAW: guard(modules.codecs.lz4Raw),
  };
}

export interface PrescanTotals {
  values: number;
  decoded: number;
}

/**
 * Walks one chunk's pages with the guarded header reader: the walk must end exactly at the
 * chunk's end; a page may declare at most parquetMaxPageValues values; the data pages' values may not pass the
 * footer's count or parquetMaxChunkValues; the values of every page of every chosen chunk, dictionary pages included,
 * may not pass `valueCap` (parquetMaxTotalValues unless the caller sums a column and checks it itself); the declared
 * decoded bytes may not pass the decode budget.
 * A page may not declare a negative count.
 */
export function prescanChunk(
  bytes: Uint8Array,
  footerValues: number,
  name: string,
  limits: S3PreviewLimits,
  totals: PrescanTotals,
  valueCap: number = limits.parquetMaxTotalValues,
): void {
  const c = spellName(name);
  let offset = 0;
  let dataValues = 0;
  while (offset < bytes.length) {
    const facts = readPageHeader(bytes, offset, limits.thriftMaxDepth);
    if (!("headerBytes" in facts)) throw new PreviewRefusal(previewSentence("R-PQ-PAGES", { c }));
    if (facts.numValues < 0) throw new PreviewRefusal(previewSentence("R-PQ-PAGES", { c }));
    if (facts.numValues > limits.parquetMaxPageValues)
      throw new PreviewRefusal(previewSentence("R-PQ-PAGE-VALUES", { c, v: facts.numValues }));
    if (facts.type === 0 || facts.type === 3) dataValues += facts.numValues;
    totals.values += facts.numValues;
    totals.decoded += facts.uncompressedPageSize;
    if (totals.decoded > limits.parquetDecodeBudget) {
      throw new PreviewRefusal(
        previewSentence("R-PQ-PAGE-DECODE", {
          d: inMiB(totals.decoded),
          decodeBudget: inMiB(limits.parquetDecodeBudget),
        }),
      );
    }
    offset += facts.headerBytes + facts.compressedPageSize;
  }
  if (offset !== bytes.length) throw new PreviewRefusal(previewSentence("R-PQ-PAGES", { c }));
  if (dataValues > footerValues || dataValues > limits.parquetMaxChunkValues) {
    throw new PreviewRefusal(previewSentence("R-PQ-PAGE-VALUES", { c, v: dataValues }));
  }
  if (totals.values > valueCap) {
    throw new PreviewRefusal(previewSentence("R-PQ-PAGE-VALUES", { c, v: totals.values }));
  }
}

export interface DecodeSlots {
  /** Resolves with the release function; rejects with R-PQ-BUSY when the queue is full, or with the abort. */
  acquire(signal: AbortSignal): Promise<() => void>;
}

/**
 * A first-in, first-out semaphore of `slots` decodes and `queue` waiters. Not the engine limiter: its permit admits
 * one decode or one footer parse, not one wire call, and it names no engine. A waiter whose signal aborts leaves the
 * queue; each release function frees its slot once, whatever path calls it.
 */
export function createDecodeSlots(slots: number, queue: number): DecodeSlots {
  let running = 0;
  const waiting: { readonly grant: () => void; readonly signal: AbortSignal; readonly onAbort: () => void }[] = [];
  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) {
      running -= 1;
      return;
    }
    next.signal.removeEventListener("abort", next.onAbort);
    next.grant();
  };
  const releaseOnce = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  };
  return {
    async acquire(signal) {
      signal.throwIfAborted();
      if (running < slots) {
        running += 1;
        return releaseOnce();
      }
      if (waiting.length >= queue) throw new PreviewRefusal(previewSentence("R-PQ-BUSY"));
      return new Promise<() => void>((resolve, reject) => {
        const entry = {
          signal,
          grant: () => resolve(releaseOnce()),
          onAbort: () => {
            waiting.splice(waiting.indexOf(entry), 1);
            reject(signal.reason);
          },
        };
        waiting.push(entry);
        signal.addEventListener("abort", entry.onAbort, { once: true });
      });
    },
  };
}

export interface ParquetDeps {
  readonly modules: () => Promise<ParquetModules>;
  readonly slots: DecodeSlots;
}

/**
 * The process-wide decode slot: at most S3_PARQUET_DECODE_SLOTS decodes and footer parses at once,
 * S3_PARQUET_DECODE_QUEUE waiters.
 */
export const PARQUET_DEPS: ParquetDeps = {
  modules: loadParquetModules,
  slots: createDecodeSlots(S3_PARQUET_DECODE_SLOTS, S3_PARQUET_DECODE_QUEUE),
};

export type ParquetOutcome = S3Preview | { readonly kind: "not-parquet"; readonly held?: Uint8Array };

interface Span {
  readonly start: number;
  end: number;
  bytes: Uint8Array;
}

/** A chunk's byte range as hyparquet plans it: the dictionary page if any (0 counts as none), else the first data page. */
function chunkRange(chunk: ColumnChunk): { readonly start: number; readonly end: number } {
  const meta = metaOf(chunk);
  const start = Number(meta.dictionary_page_offset || meta.data_page_offset);
  return { start, end: start + Number(meta.total_compressed_size) };
}

async function decodeRows(modules: ParquetModules, options: Parameters<ParquetModules["parquetReadObjects"]>[0]) {
  try {
    return await modules.parquetReadObjects(options);
  } catch {
    throw new PreviewRefusal(previewSentence("R-PQ-DECODE"));
  }
}

type PlannedRead =
  | { readonly kind: "summary"; readonly notices: readonly string[] }
  | {
      readonly kind: "rows";
      readonly rows: ReturnType<typeof buildRows>["rows"];
      /** The plan's notices, rewritten when the pre-scan dropped columns. */
      readonly planNotices: readonly string[];
      readonly notices: readonly string[];
    };

/**
 * Ranges, merge, prefetch, pre-scan, the slot, the guarded decode, the rows. In leading mode the pre-scan sums
 * one top-level column at a time: the first column whose page values would take the total past
 * parquetMaxTotalValues is dropped with every column after it (N-PQ-SOME-COLUMNS), and when that is the first
 * column the answer is the summary (N-PQ-NONE-FIT). Explicit mode refuses instead (R-PQ-PAGE-VALUES).
 */
async function readPlannedRows(
  input: ParquetPreviewInput,
  footer: ParquetFooter,
  plan: Extract<ParquetPlan, { kind: "rows" }>,
  modules: ParquetModules,
  slots: DecodeSlots,
): Promise<PlannedRead> {
  const size = input.head.size;
  const chunks = plan.columns.flatMap((column) =>
    column.chunks.map((chunk) => ({
      chunk,
      column,
      name: metaOf(chunk).path_in_schema.join("."),
      ...chunkRange(chunk),
    })),
  );
  for (const each of chunks) {
    if (each.start < 4 || each.end > footer.footerStart || each.end <= each.start) {
      throw new PreviewRefusal(previewSentence("R-PQ-CHUNK-RANGE", { c: spellName(each.name) }));
    }
  }
  const spans: Span[] = [];
  for (const each of [...chunks].sort((a, b) => a.start - b.start)) {
    const last = spans[spans.length - 1];
    if (last !== undefined && last.end === each.start) last.end = each.end;
    else spans.push({ start: each.start, end: each.end, bytes: new Uint8Array(0) });
  }
  for (const span of spans) {
    // oxlint-disable-next-line no-await-in-loop -- the spans are read one after another, one GET in flight per preview.
    span.bytes = await input.read({ kind: "span", start: span.start, end: span.end }, span.end - span.start);
  }
  const holding = (start: number, end: number): Span | undefined =>
    spans.find((span) => span.start <= start && end <= span.end);
  const scan = (each: (typeof chunks)[number], totals: PrescanTotals, valueCap?: number): void => {
    const span = holding(each.start, each.end) as Span;
    prescanChunk(
      span.bytes.subarray(each.start - span.start, each.end - span.start),
      Number(metaOf(each.chunk).num_values),
      each.name,
      input.limits,
      totals,
      valueCap,
    );
  };
  const totals: PrescanTotals = { values: 0, decoded: 0 };
  let columns = plan.columns;
  let planNotices = plan.notices;
  if (input.request.columns !== undefined) {
    for (const each of chunks) scan(each, totals);
  } else {
    let kept = 0;
    for (const column of plan.columns) {
      const own: PrescanTotals = { values: 0, decoded: totals.decoded };
      for (const each of chunks) if (each.column === column) scan(each, own, Number.POSITIVE_INFINITY);
      if (totals.values + own.values > input.limits.parquetMaxTotalValues) break;
      totals.values += own.values;
      totals.decoded = own.decoded;
      kept += 1;
    }
    if (kept === 0) return { kind: "summary", notices: [noneFit(plan.columns[0], input.limits)] };
    if (kept < plan.columns.length) {
      columns = plan.columns.slice(0, kept);
      planNotices = [
        previewSentence("N-PQ-SOME-COLUMNS", { k: kept, n: footer.shape.columns.length, ...capsOf(input.limits) }),
        ...rowNotices(footer, columns, plan.rowsAsked),
      ];
    }
  }
  const held: readonly Span[] = [...spans, { start: footer.footerStart, end: size, bytes: footer.footerBytes }];
  const file: AsyncBuffer = {
    byteLength: size,
    slice(start: number, end: number = size): ArrayBuffer {
      const span = held.find((each) => each.start <= start && end <= each.end);
      if (span === undefined) throw new Error(OUTSIDE_PLAN);
      return span.bytes.slice(start - span.start, end - span.start).buffer;
    },
  };
  input.signal.throwIfAborted();
  const release = await slots.acquire(input.signal);
  let objects: Record<string, unknown>[];
  try {
    input.signal.throwIfAborted();
    objects = await decodeRows(modules, {
      file,
      metadata: footer.metadata,
      columns: columns.map((column) => column.name),
      rowStart: 0,
      rowEnd: plan.rowsToRead,
      compressors: guardedCompressors(input.limits.parquetDecodeBudget, modules),
      utf8: false,
      parsers: PREVIEW_PARSERS,
      useOffsetIndex: false,
    });
  } finally {
    release();
  }
  const firstRows = Number(footer.metadata.row_groups[0].num_rows);
  const totalRows = Number(footer.metadata.num_rows);
  const built = buildRows(
    {
      names: uniqueFieldNames(columns.map((column) => column.name)),
      typing: columns.map((column) => column.type),
      rowCount: objects.length,
      available: firstRows >= plan.rowsAsked && totalRows > plan.rowsAsked ? totalRows : objects.length,
      valueAt: (row, column) => objects[row][columns[column].name],
    },
    undefined,
    plan.rowsToRead,
    input.limits,
  );
  return { kind: "rows", rows: built.rows, planNotices, notices: built.notices };
}

/**
 * A Parquet preview: the footer, the summary and the plan; then, when rows are planned, the reads and the
 * decode. A refusal that is not a QueryError comes back as the `refused` arm; a file that is not Parquet comes back as
 * `not-parquet`, with the bytes already read when they cover the whole object, for previewObject's hex dump.
 */
export async function previewParquet(
  input: ParquetPreviewInput,
  deps: ParquetDeps = PARQUET_DEPS,
): Promise<ParquetOutcome> {
  const modules = await deps.modules();
  try {
    const outcome = await readParquetFooter(input, modules, deps.slots);
    if (outcome.kind === "not-parquet") return outcome;
    if (outcome.kind === "refused") return { kind: "refused", sentence: outcome.sentence, notices: [] };
    const { summary, notices: summaryNotices } = summarizeParquet(outcome.footer, input.limits);
    const plan = planParquet(outcome.footer, input.request, input.purpose, input.limits);
    if (plan.kind === "summary") return { kind: "parquet", summary, notices: [...plan.notices, ...summaryNotices] };
    const read = await readPlannedRows(input, outcome.footer, plan, modules, deps.slots);
    if (read.kind === "summary") return { kind: "parquet", summary, notices: [...read.notices, ...summaryNotices] };
    return {
      kind: "parquet",
      summary,
      rows: read.rows,
      notices: [...read.planNotices, ...summaryNotices, ...read.notices],
    };
  } catch (error) {
    if (error instanceof PreviewRefusal) return { kind: "refused", sentence: error.sentence, notices: [] };
    throw error;
  }
}
