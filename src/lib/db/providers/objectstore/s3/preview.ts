/**
 * The S3 object preview: the types every preview module shares and, from Task 18 on, `previewObject`,
 * the one entry point the Source tab and the console's `preview` command call through the provider's preview-adapter.ts.
 * The preview reads only through `S3RangeReader`: it builds no request, signs nothing and parses no header.
 */

import { QueryError } from "@/lib/db/errors";
import { SOURCE_CHARACTER_LIMIT } from "@/lib/db/object-kinds";
import { S3_PREVIEW_LIMITS, S3_TYPE, type S3PreviewLimits } from "./constants";
import { buildRows } from "./preview-cells";
import { csvRows, type RowsInput, type RowsOutcome } from "./preview-csv";
import { contentTypeHint, encodingLayer, extensionOf, parsesAsJson, sniffMagic } from "./preview-detect";
import { gunzipPrefix } from "./preview-gzip";
import { jsonDocumentRows, ndjsonRows } from "./preview-json";
import { PARQUET_DEPS, type ParquetDeps, previewParquet } from "./preview-parquet";
import { counted, previewMaxRowsSentence, previewSentence, spellName } from "./preview-render";
import { decodeText, hexRows, isPrintableText, reindentJson, textLines, utf8BackOff } from "./preview-text";

/** What the HEAD that the Source tab or the console already ran said about the object. */
export interface S3ObjectHead {
  readonly bucket: string;
  readonly key: string;
  /** Content-Length of the HEAD answer, a whole number from 0. */
  readonly size: number;
  /** The ETag header exactly as received, quotes included. */
  readonly etag: string;
  /** Content-Type as stored, absent when the server sent none. */
  readonly contentType?: string;
  /** Content-Encoding as stored, absent when the server sent none. */
  readonly contentEncoding?: string;
}

/** One byte range, end exclusive. "suffix" is RFC 9110 `bytes=-N`. */
export type S3ByteRange =
  | { readonly kind: "first"; readonly length: number }
  | { readonly kind: "suffix"; readonly length: number }
  | { readonly kind: "span"; readonly start: number; readonly end: number };

export interface S3RangeAnswer {
  /** The bytes received, at most the `maxBytes` the call passed. */
  readonly bytes: Uint8Array;
  /** Offset of `bytes[0]` in the object: from Content-Range on a 206, 0 on a 200. */
  readonly start: number;
  /** The object's size: Content-Range's complete-length on a 206, Content-Length on a 200. */
  readonly total: number;
  /** The ETag header of this answer, absent when the server sent none. */
  readonly etag?: string;
}

/** Implemented by `rangeReader(client, bucket, key, call)` in preview-adapter.ts. */
export interface S3RangeReader {
  read(range: S3ByteRange, maxBytes: number, signal: AbortSignal): Promise<S3RangeAnswer>;
}

export type S3PreviewFormat = "text" | "json" | "ndjson" | "csv" | "tsv" | "parquet" | "hex";

export interface S3PreviewRequest {
  /** Forces a format instead of detection (console `--format`). Validation still applies: Parquet still needs PAR1. */
  readonly format?: S3PreviewFormat;
  /** Columns to show, in this order (console `--columns`); Parquet: top-level names; row formats: final names. */
  readonly columns?: readonly string[];
  /** Rows to show, a whole number from 1 to `limits.maxRows` (console `--max-rows`). */
  readonly maxRows?: number;
  /** Parquet only: answer the schema and statistics even when rows fit (console `--schema`). */
  readonly schemaOnly?: boolean;
}

export type S3PreviewCell = string | number | boolean | null;

export interface S3PreviewColumn {
  readonly name: string;
  readonly type: string;
}

export interface S3PreviewRows {
  readonly columns: readonly S3PreviewColumn[];
  /** Positional: cell i belongs to columns[i]. Names are already unique. */
  readonly rows: readonly (readonly S3PreviewCell[])[];
}

export interface ParquetColumnSummary {
  /** path_in_schema joined with ".". */
  readonly path: string;
  /** The column's type string, as the result grid shows it. */
  readonly type: string;
  readonly codec: string;
  /** RG0 statistics null_count, or null. */
  readonly nulls: S3PreviewCell;
  /** RG0 min_value (else min), rendered and cut at summaryCellChars. */
  readonly min: S3PreviewCell;
  readonly max: S3PreviewCell;
  /** RG0 total_compressed_size. */
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
}

export interface ParquetSummary {
  /** num_rows, by the cell table's bigint rule. */
  readonly rows: S3PreviewCell;
  readonly rowGroups: number;
  /** created_by, cut at summaryCellChars. */
  readonly createdBy: string | null;
  readonly firstRowGroup: {
    readonly rows: S3PreviewCell;
    readonly compressedBytes: number;
    readonly uncompressedBytes: number;
  } | null;
  /** Leaf columns of the first row group, at most maxColumns. */
  readonly columns: readonly ParquetColumnSummary[];
}

/**
 * One preview. When a text preview's `cut` is true, `notices[0]` is the sentence that says how much was read (N-CUT,
 * or N-GZIP under a gzip layer); the Source part's `truncated.reason` is that sentence.
 */
export type S3Preview =
  | { readonly kind: "empty"; readonly notices: readonly string[] }
  | {
      readonly kind: "text";
      readonly format: "text" | "json" | "ndjson" | "csv" | "tsv";
      readonly text: string;
      readonly language: "plaintext" | "json";
      readonly origin: "stored" | "rendered";
      /** Bytes of the object behind `text`, after any gzip layer. */
      readonly shownBytes: number;
      readonly objectBytes: number;
      readonly cut: boolean;
      /** Console purpose only. */
      readonly rows?: S3PreviewRows;
      readonly notices: readonly string[];
    }
  | {
      readonly kind: "hex";
      readonly bytes: Uint8Array;
      readonly objectBytes: number;
      /** Console purpose only. */
      readonly rows?: S3PreviewRows;
      readonly notices: readonly string[];
    }
  | {
      readonly kind: "parquet";
      readonly summary: ParquetSummary;
      readonly rows?: S3PreviewRows;
      /** Console purpose, summary only: the most summary rows the grid shows, the request's maxRows or defaultRows. */
      readonly summaryRows?: number;
      readonly notices: readonly string[];
    }
  | { readonly kind: "refused"; readonly sentence: string; readonly notices: readonly string[] };

/** The checks on every ranged answer, in the order they run. */
export const PREVIEW_READ_SENTENCES = Object.freeze({
  noEtag:
    "The server sent no ETag with the object's bytes, so the preview cannot tell whether the object changed while it was read.",
  changed: "The object changed while it was previewed; preview it again.",
  range: "The server answered a different byte range from the one asked for, so the preview stopped.",
  short: "The server answered fewer bytes than the range asked for, so the preview stopped.",
} as const);

export interface RowBuilders {
  readonly csv: typeof csvRows;
  readonly ndjson: typeof ndjsonRows;
  readonly json: typeof jsonDocumentRows;
}

/** What previewObject builds rows and decodes Parquet with; production passes nothing and gets these. */
export interface PreviewDeps {
  readonly rows: RowBuilders;
  readonly parquet: ParquetDeps;
}

export const PREVIEW_DEPS: PreviewDeps = {
  rows: { csv: csvRows, ndjson: ndjsonRows, json: jsonDocumentRows },
  parquet: PARQUET_DEPS,
};

type TextFormat = "text" | "json" | "ndjson" | "csv" | "tsv";

interface Context {
  readonly head: S3ObjectHead;
  readonly read: (range: S3ByteRange, maxBytes: number) => Promise<Uint8Array>;
  readonly request: S3PreviewRequest;
  readonly purpose: "source" | "console";
  readonly limits: S3PreviewLimits;
  readonly signal: AbortSignal;
  readonly deps: PreviewDeps;
}

const refusal = (sentence: string): QueryError => new QueryError(sentence, S3_TYPE);

/** One GET through the port, checked against the HEAD before its bytes are used. */
function checkedRead(head: S3ObjectHead, reader: S3RangeReader, signal: AbortSignal) {
  return async (range: S3ByteRange, maxBytes: number): Promise<Uint8Array> => {
    signal.throwIfAborted();
    const answer = await reader.read(range, maxBytes, signal);
    if (answer.etag === undefined) throw refusal(PREVIEW_READ_SENTENCES.noEtag);
    if (answer.etag !== head.etag || answer.total !== head.size) throw refusal(PREVIEW_READ_SENTENCES.changed);
    const start = range.kind === "first" ? 0 : range.kind === "suffix" ? head.size - range.length : range.start;
    if (answer.start !== start) throw refusal(PREVIEW_READ_SENTENCES.range);
    const asked = range.kind === "span" ? range.end - range.start : range.length;
    if (answer.bytes.length !== Math.min(asked, answer.total - answer.start))
      throw refusal(PREVIEW_READ_SENTENCES.short);
    return answer.bytes;
  };
}

/** The request's own bounds, held for any caller: checked before any GET. */
function checkRequest(request: S3PreviewRequest, limits: S3PreviewLimits): void {
  const { maxRows, columns } = request;
  if (maxRows !== undefined && (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > limits.maxRows)) {
    throw refusal(previewMaxRowsSentence(limits.maxRows));
  }
  if (columns === undefined) return;
  const seen = new Set<string>();
  const repeated = columns.find((name) => {
    if (seen.has(name)) return true;
    seen.add(name);
    return false;
  });
  if (repeated !== undefined) throw refusal(previewSentence("R-COLUMNS-REPEATED", { c: spellName(repeated) }));
  if (columns.length > limits.maxColumns)
    throw refusal(previewSentence("R-COLUMNS-MANY", { most: counted(limits.maxColumns, "name", "names") }));
}

async function hex(
  context: Context,
  held: Uint8Array | undefined,
  notices: readonly string[],
  objectBytes: number,
): Promise<S3Preview> {
  const length = Math.min(context.limits.hexBytes, context.head.size);
  const bytes =
    held === undefined
      ? await context.read({ kind: "first", length }, length)
      : held.subarray(0, context.limits.hexBytes);
  if (context.purpose === "source") return { kind: "hex", bytes, objectBytes, notices };
  const maxRows = context.request.maxRows ?? context.limits.defaultRows;
  const built = hexRows(bytes, maxRows);
  return {
    kind: "hex",
    bytes,
    objectBytes,
    rows: { columns: ["offset", "hex", "text"].map((name) => ({ name, type: "text" })), rows: built.rows },
    notices: built.more ? [...notices, previewSentence("N-ROWS", { cap: maxRows })] : notices,
  };
}

/** The console's line rows of a text that has no rows of its own; the Source tab gets none. */
function lineRows(
  context: Context,
  text: string,
  notices: readonly string[],
): { readonly rows?: S3PreviewRows; readonly notices: readonly string[] } {
  if (context.purpose === "source") return { notices };
  const maxRows = context.request.maxRows ?? context.limits.defaultRows;
  const lines = textLines(text, maxRows);
  const built = buildRows(
    {
      names: ["line", "text"],
      typing: ["number", "text"],
      rowCount: lines.lines.length,
      available: lines.more ? lines.lines.length + 1 : lines.lines.length,
      valueAt: (row, column) => (column === 0 ? row + 1 : lines.lines[row]),
    },
    undefined,
    maxRows,
    context.limits,
  );
  return { rows: built.rows, notices: [...notices, ...built.notices] };
}

/** A row format's rows for the console; its text rows when the builder answers text or throws (R-ROWS). */
function formatRows(
  context: Context,
  text: string,
  notices: readonly string[],
  build: () => RowsOutcome,
): { readonly rows?: S3PreviewRows; readonly notices: readonly string[] } {
  if (context.purpose === "source") return { notices };
  let outcome: RowsOutcome;
  try {
    outcome = build();
  } catch (error) {
    if (error instanceof QueryError) throw error;
    return lineRows(context, text, [...notices, previewSentence("R-ROWS")]);
  }
  if (outcome.kind === "text") return lineRows(context, text, [...notices, ...outcome.notices]);
  return { rows: outcome.rows, notices: [...notices, ...outcome.notices] };
}

/** The text checks, the format and its rows, for bytes read plainly or decoded from one gzip layer (`lead` is then N-GZIP). */
async function fromText(
  context: Context,
  bytes: Uint8Array,
  ended: boolean,
  format: TextFormat | undefined,
  read: { readonly readBytes: number; readonly lead?: string; readonly hexSize: number },
): Promise<S3Preview> {
  const lead = read.lead === undefined ? [] : [read.lead];
  const kept = ended ? bytes : utf8BackOff(bytes);
  if (!isPrintableText(kept)) return hex(context, bytes, [...lead, previewSentence("N-NOT-UTF8")], read.hexSize);
  const text = decodeText(kept);
  if (text.trim() === "") return hex(context, bytes, [...lead, previewSentence("N-BLANK")], read.hexSize);
  let shown: TextFormat = format ?? contentTypeHint(context.head.contentType);
  if (context.request.format === undefined && shown === "text" && ended && parsesAsJson(text)) shown = "json";
  const notices =
    ended || read.lead !== undefined
      ? lead
      : [previewSentence("N-CUT", { shown: kept.length, size: context.head.size })];
  const base = {
    kind: "text",
    format: shown,
    shownBytes: kept.length,
    objectBytes: context.head.size,
    cut: !ended,
  } as const;
  const rowsInput: RowsInput = {
    text,
    ended,
    readBytes: read.readBytes,
    request: context.request,
    maxRows: context.request.maxRows ?? context.limits.defaultRows,
    limits: context.limits,
  };
  const stored = { text, language: "plaintext", origin: "stored" } as const;
  if (shown === "json") {
    if (!ended)
      return {
        ...base,
        ...stored,
        ...lineRows(context, text, [...notices, previewSentence("N-JSON-CUT", { n: read.readBytes })]),
      };
    if (!parsesAsJson(text))
      return { ...base, ...stored, ...lineRows(context, text, [...notices, previewSentence("N-JSON-INVALID")]) };
    const indented = reindentJson(text, SOURCE_CHARACTER_LIMIT) ?? text;
    return {
      ...base,
      text: indented,
      language: "json",
      origin: indented === text ? "stored" : "rendered",
      ...formatRows(context, text, notices, () => context.deps.rows.json(rowsInput)),
    };
  }
  if (shown === "ndjson")
    return { ...base, ...stored, ...formatRows(context, text, notices, () => context.deps.rows.ndjson(rowsInput)) };
  if (shown === "csv" || shown === "tsv") {
    const csvFormat = shown;
    return {
      ...base,
      ...stored,
      ...formatRows(context, text, notices, () => context.deps.rows.csv({ ...rowsInput, format: csvFormat })),
    };
  }
  return { ...base, ...stored, ...lineRows(context, text, notices) };
}

/** One gzip layer, decoded from the stored prefix. */
async function gzipLayer(
  context: Context,
  stored: Uint8Array,
  format: S3PreviewFormat | undefined,
): Promise<S3Preview> {
  const decoded = await gunzipPrefix(stored, context.limits.decodedTextBytes, context.head.size <= stored.length);
  if (decoded.bad) return hex(context, stored, [previewSentence("N-GZIP-BAD")], context.head.size);
  if (decoded.ended && decoded.bytes.length === 0) return { kind: "empty", notices: [previewSentence("N-GZIP-EMPTY")] };
  const size = decoded.bytes.length;
  if (sniffMagic(decoded.bytes) === "gzip")
    return hex(context, decoded.bytes, [previewSentence("N-GZIP-NESTED")], size);
  if (format === "parquet" || sniffMagic(decoded.bytes) === "parquet")
    return hex(context, decoded.bytes, [previewSentence("N-PQ-ENCODED")], size);
  const lead = previewSentence("N-GZIP", { d: size, f: stored.length });
  if (format === "hex") return hex(context, decoded.bytes, [lead], size);
  return fromText(context, decoded.bytes, decoded.ended, format, {
    readBytes: context.limits.decodedTextBytes,
    lead,
    hexSize: size,
  });
}

async function parquet(context: Context): Promise<S3Preview> {
  const outcome = await previewParquet(
    {
      head: context.head,
      read: context.read,
      request: context.request,
      purpose: context.purpose,
      limits: context.limits,
      signal: context.signal,
    },
    context.deps.parquet,
  );
  if (outcome.kind === "not-parquet")
    return hex(context, outcome.held, [previewSentence("N-PQ-MAGIC")], context.head.size);
  return outcome;
}

/** Detection in order: Content-Encoding, then the extension (or --format), then the first bytes, then the Content-Type hint. */
async function dispatch(context: Context): Promise<S3Preview> {
  const { head, limits, request } = context;
  const layer = encodingLayer(head.contentEncoding);
  const extension = request.format === undefined ? extensionOf(head.key) : { gzip: false };
  const format = request.format ?? extension.format;
  const gzip = layer.kind === "gzip" || extension.gzip;
  if (
    request.schemaOnly === true &&
    (layer.kind !== "none" || gzip || (format !== undefined && format !== "parquet"))
  ) {
    throw refusal(previewSentence("R-SCHEMA"));
  }
  if (layer.kind === "other")
    return hex(context, undefined, [previewSentence("N-ENC-OTHER", { coding: layer.coding })], head.size);
  if (gzip) {
    const length = Math.min(limits.gzipFetchBytes, head.size);
    return gzipLayer(context, await context.read({ kind: "first", length }, length), format);
  }
  if (format === "parquet") return parquet(context);
  if (format === "hex") return hex(context, undefined, [], head.size);
  const length = Math.min(limits.textFetchBytes, head.size);
  const bytes = await context.read({ kind: "first", length }, length);
  if (format === undefined) {
    const magic = sniffMagic(bytes);
    if (magic === "gzip")
      return gzipLayer(context, bytes.subarray(0, Math.min(bytes.length, limits.gzipFetchBytes)), undefined);
    if (magic === "parquet") return parquet(context);
  }
  return fromText(context, bytes, head.size <= bytes.length, format, {
    readBytes: limits.textFetchBytes,
    hexSize: head.size,
  });
}

/**
 * The preview of one object: checks the request, sends no GET for a 0-byte object, then detects
 * and dispatches. A QueryError (a preview refusal marked QueryError, or the client's own) and the run's abort
 * propagate; every other refusal is in the answer.
 */
export async function previewObject(
  input: {
    readonly head: S3ObjectHead;
    readonly reader: S3RangeReader;
    readonly request: S3PreviewRequest;
    /** "source" builds the Source tab's text; "console" also builds rows for a grid. */
    readonly purpose: "source" | "console";
    /** Defaults to S3_PREVIEW_LIMITS; tests pass small limits so fixtures stay small. */
    readonly limits?: S3PreviewLimits;
    readonly signal: AbortSignal;
  },
  deps: PreviewDeps = PREVIEW_DEPS,
): Promise<S3Preview> {
  const limits = input.limits ?? S3_PREVIEW_LIMITS;
  checkRequest(input.request, limits);
  input.signal.throwIfAborted();
  const context: Context = {
    head: input.head,
    read: checkedRead(input.head, input.reader, input.signal),
    request: input.request,
    purpose: input.purpose,
    limits,
    signal: input.signal,
    deps,
  };
  const preview: S3Preview = input.head.size === 0 ? { kind: "empty", notices: [] } : await dispatch(context);
  if (input.request.schemaOnly === true && preview.kind !== "parquet" && preview.kind !== "refused") {
    throw refusal(previewSentence("R-SCHEMA"));
  }
  return preview;
}
