/**
 * The S3 Parquet preview. Server-only: the only module that loads hyparquet and
 * hyparquet-compressors, through a memoised dynamic import the first time a Parquet preview runs, so a server
 * that never previews Parquet never loads them. It reads the footer by a suffix range, guards its Thrift bytes and
 * walks its schema before hyparquet builds any tree, plans the first row group's leading columns inside the fetch,
 * decode, leaf and value budgets, then (Task 17) prefetches, pre-scans the page headers and decodes from memory.
 */
import type * as Hyparquet from "hyparquet";
import type { ColumnChunk, ColumnMetaData, FileMetaData, ParquetParsers } from "hyparquet";
import { QueryError } from "@/lib/db/errors";
import { S3_TYPE, type S3PreviewLimits } from "./constants";
import { type ParquetSchemaShape, walkParquetSchema } from "./parquet-schema";
import { guardThriftStruct } from "./parquet-thrift-guard";
import type {
  ParquetColumnSummary,
  ParquetSummary,
  S3ByteRange,
  S3ObjectHead,
  S3PreviewCell,
  S3PreviewRequest,
} from "./preview";
import { cutText, renderCell } from "./preview-cells";
import { FOOTER_BAD_BARE, inMiB, previewSentence, spellName } from "./preview-render";

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
      gzip: compressors.decompressGzip,
      brotli: compressors.decompressBrotli,
      zstd: compressors.decompressZstd,
      lz4: compressors.decompressLz4,
      lz4Raw: compressors.decompressLz4Raw,
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
  const guard = guardThriftStruct(footerBytes.subarray(0, footerLength), 0, limits.thriftMaxDepth);
  if (!guard.ok) return refused(previewSentence("R-PQ-FOOTER-BAD", { reason: guard.reason }));
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
      codec: meta.codec,
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
      (chunk) => chunk.file_path !== undefined || !READABLE_CODECS.has(metaOf(chunk).codec),
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
      codec: metaOf(unreadable ?? chunks[0]).codec,
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
