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
 * chunks (this multiple at 128 leaf columns) hold 21 MiB after parquetMetadata, and a footer of 20,000 one-column row
 * groups holds 100,002 list elements.
 */
const FOOTER_LIST_ELEMENTS_PER_SCHEMA_ELEMENT = 128;

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

/** The tail read, the footer length checks, the second read when needed, the guard, the parse, the walk. */
export async function readParquetFooter(input: ParquetPreviewInput, modules: ParquetModules): Promise<FooterOutcome> {
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
    onField: (path, type, value) => {
      if (path.length === 1 && path[0] === 2 && type === 9) schemaElements = Math.max(schemaElements, value as number);
    },
  });
  if (!guard.ok) return refused(previewSentence("R-PQ-FOOTER-BAD", { reason: guard.reason }));
  if (schemaElements > schemaBound) return refused(previewSentence("R-PQ-SCHEMA"));
  let metadata: FileMetaData;
  try {
    metadata = modules.parquetMetadata(footerBytes.buffer, { geoparquet: false, parsers: PREVIEW_PARSERS });
  } catch {
    return refused(FOOTER_BAD_BARE);
  }
  const shape = walkParquetSchema(metadata.schema, limits);
  if (!shape.ok) return refused(previewSentence("R-PQ-SCHEMA"));
  const first = metadata.row_groups[0];
  if (first !== undefined && !chunksMatchLeaves(first.columns, shape)) return refused(FOOTER_BAD_BARE);
  return {
    kind: "footer",
    footer: { metadata, shape, footerLength, footerStart: size - 8 - footerLength, footerBytes },
  };
}

const metaOf = (chunk: ColumnChunk): ColumnMetaData => chunk.meta_data as ColumnMetaData;

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
  const caps = {
    fetchBudget: inMiB(limits.parquetFetchBudget),
    decodeBudget: inMiB(limits.parquetDecodeBudget),
    leafCap: limits.parquetMaxLeafColumns,
    valueCap: limits.parquetMaxTotalValues,
  };
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
            ? previewSentence("N-PQ-NONE-FIT", { fetch: inMiB(column.fetch), decode: inMiB(column.decode), ...caps })
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
  const firstRows = Number(first.num_rows);
  if (firstRows < rowsAsked && footer.metadata.row_groups.length > 1)
    notices.push(previewSentence("N-PQ-RG0", { m: firstRows }));
  for (const column of chosen) {
    for (const decimal of column.decimals) {
      if (decimal.precision > 15) {
        notices.push(
          previewSentence("N-PQ-DECIMAL", { c: spellName(decimal.path), p: decimal.precision, s: decimal.scale }),
        );
      }
    }
  }
  return { kind: "rows", columns: chosen, rowsToRead: Math.min(rowsAsked, firstRows), rowsAsked, notices };
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

/**
 * The second line behind the pre-scan: each codec checks the declared output length against the budget
 * left before it runs, then spends it. Snappy is hyparquet's own pure-JavaScript decoder, so hysnappy's shared WASM
 * memory is never grown; zstd gets a buffer of the declared size, since fzstd otherwise sizes from the frame. Gzip and
 * brotli decode through node:zlib with the declared length as the output limit, because the package decoders size
 * their output from the stream, and both LZ4 codecs through the bounded decoders above, because the package decoder
 * keeps copying a match past its output.
 */
export function guardedCompressors(budget: number, modules: ParquetModules): Compressors {
  let left = budget;
  const guard =
    (codec: (input: Uint8Array, outputLength: number) => Uint8Array) =>
    (input: Uint8Array, outputLength: number): Uint8Array => {
      if (outputLength > left) throw new Error(DECODE_OVER_BUDGET);
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
    ZSTD: guard((input, outputLength) => modules.codecs.zstd(input, new Uint8Array(outputLength))),
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
 * may not pass parquetMaxTotalValues; the declared decoded bytes may not pass the decode budget.
 * A page may not declare a negative count.
 */
export function prescanChunk(
  bytes: Uint8Array,
  footerValues: number,
  name: string,
  limits: S3PreviewLimits,
  totals: PrescanTotals,
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
  if (totals.values > limits.parquetMaxTotalValues) {
    throw new PreviewRefusal(previewSentence("R-PQ-PAGE-VALUES", { c, v: totals.values }));
  }
}

export interface DecodeSlots {
  /** Resolves with the release function; rejects with R-PQ-BUSY when the queue is full, or with the abort. */
  acquire(signal: AbortSignal): Promise<() => void>;
}

/**
 * A first-in, first-out semaphore of `slots` decodes and `queue` waiters. Not the engine limiter: its
 * permit admits one decode, not one wire call, and it names no engine. A waiter whose signal aborts leaves the queue;
 * each release function frees its slot once, whatever path calls it.
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

/** The process-wide decode slot: at most S3_PARQUET_DECODE_SLOTS decodes, S3_PARQUET_DECODE_QUEUE waiters. */
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

/** Ranges, merge, prefetch, pre-scan, the slot, the guarded decode, the rows. */
async function readPlannedRows(
  input: ParquetPreviewInput,
  footer: ParquetFooter,
  plan: Extract<ParquetPlan, { kind: "rows" }>,
  modules: ParquetModules,
  slots: DecodeSlots,
): Promise<{ readonly rows: ReturnType<typeof buildRows>["rows"]; readonly notices: readonly string[] }> {
  const size = input.head.size;
  const chunks = plan.columns.flatMap((column) =>
    column.chunks.map((chunk) => ({ chunk, name: metaOf(chunk).path_in_schema.join("."), ...chunkRange(chunk) })),
  );
  for (const each of chunks) {
    if (each.start < 4 || each.end > footer.footerStart || each.end < each.start) {
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
  const totals: PrescanTotals = { values: 0, decoded: 0 };
  for (const each of chunks) {
    const span = holding(each.start, each.end) as Span;
    prescanChunk(
      span.bytes.subarray(each.start - span.start, each.end - span.start),
      Number(metaOf(each.chunk).num_values),
      each.name,
      input.limits,
      totals,
    );
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
      columns: plan.columns.map((column) => column.name),
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
      names: uniqueFieldNames(plan.columns.map((column) => column.name)),
      typing: plan.columns.map((column) => column.type),
      rowCount: objects.length,
      available: firstRows >= plan.rowsAsked && totalRows > plan.rowsAsked ? totalRows : objects.length,
      valueAt: (row, column) => objects[row][plan.columns[column].name],
    },
    undefined,
    plan.rowsToRead,
    input.limits,
  );
  return { rows: built.rows, notices: built.notices };
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
  const outcome = await readParquetFooter(input, modules);
  if (outcome.kind === "not-parquet") return outcome;
  if (outcome.kind === "refused") return { kind: "refused", sentence: outcome.sentence, notices: [] };
  const { summary, notices: summaryNotices } = summarizeParquet(outcome.footer, input.limits);
  const plan = planParquet(outcome.footer, input.request, input.purpose, input.limits);
  if (plan.kind === "summary") return { kind: "parquet", summary, notices: [...plan.notices, ...summaryNotices] };
  try {
    const read = await readPlannedRows(input, outcome.footer, plan, modules, deps.slots);
    return {
      kind: "parquet",
      summary,
      rows: read.rows,
      notices: [...plan.notices, ...summaryNotices, ...read.notices],
    };
  } catch (error) {
    if (error instanceof PreviewRefusal) return { kind: "refused", sentence: error.sentence, notices: [] };
    throw error;
  }
}
