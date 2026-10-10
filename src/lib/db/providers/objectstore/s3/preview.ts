/**
 * The S3 object preview: the types every preview module shares and, from Task 18 on, `previewObject`,
 * the one entry point the Source tab and the console's `preview` command call through the provider's preview-adapter.ts.
 * The preview reads only through `S3RangeReader`: it builds no request, signs nothing and parses no header.
 */

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
      readonly notices: readonly string[];
    }
  | {
      readonly kind: "parquet";
      readonly summary: ParquetSummary;
      readonly rows?: S3PreviewRows;
      readonly notices: readonly string[];
    }
  | { readonly kind: "refused"; readonly sentence: string; readonly notices: readonly string[] };
