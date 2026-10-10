/**
 * Every number and fixed name of the S3 provider, in one pure, browser-safe module.
 *
 * Every other module of the provider imports its numbers from here, and no module restates one. A number the console
 * or the preview also uses is defined only here and re-exported under the same name: the console
 * part's `console/constants.ts` re-exports the shared ones, and the preview part appends one `// Preview` block that
 * reads them. The module holds no logic and imports nothing but a type, so the browser-safe modules can read it.
 */
import type { DatabaseType } from "@/lib/types";

/** The provider's type-id, the one every error of this provider is tagged with. */
export const S3_TYPE: DatabaseType = "s3";
/** MinIO's and RustFS's default API port. */
export const S3_DEFAULT_PORT = 9000;
/** The signing region when the Region field is blank. */
export const S3_DEFAULT_REGION = "us-east-1";
/** The transport's socket bound, equal to the limiter's per-provider bound, so a permit never waits on a socket. */
export const S3_MAX_SOCKETS = 4;
/** One process-wide table for every S3 provider: 4 calls per provider, 16 per process, a queue of 64. */
export const S3_LIMITER_OPTIONS = Object.freeze({ perProvider: 4, perEngine: 16, queueDepth: 64 });
/** Tree, Keys panel, Source and connect calls, under the query timeout. */
export const S3_SURFACE_DEADLINE_MS = 10_000;
/** Health, under the query timeout. */
export const S3_HEALTH_DEADLINE_MS = 5_000;
/** Entries a Keys panel page asks for by default. */
export const S3_KEY_SCAN_DEFAULT_COUNT = 500;
/** S3's own page ceiling, and the one name of the page-size bound the console re-exports. */
export const S3_KEY_SCAN_MAX_COUNT = 1_000;
/** The `max-buckets` sent: AWS's documented maximum. */
export const S3_MAX_BUCKETS_READ = 10_000;
/** One ListObjectsV2 or ListObjectVersions page. */
export const S3_LIST_RESPONSE_BYTES = 8 * 1024 * 1024;
/** One ListBuckets answer: 10,000 buckets at about 150 bytes each is 1.5 MB. */
export const S3_BUCKET_LIST_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Error bodies, location, versioning and tagging answers. */
export const S3_SMALL_RESPONSE_BYTES = 65_536;
/** HEAD has no body; the transport needs a positive integer. */
export const S3_HEAD_RESPONSE_BYTES = 1;
/** The deepest shape read is 4 levels. */
export const S3_XML_MAX_DEPTH = 16;
/** 10,000 buckets are about 30,000 elements; a 1,000-entry page about 8,000. */
export const S3_XML_MAX_ELEMENTS = 100_000;
/** A 1,012-byte key gave a 1,384-character MinIO token. */
export const S3_CURSOR_TOKEN_MAX_CHARS = 4_096;
/** A 1,024-byte prefix of control characters is 6,144 JSON characters, plus a token and a bucket name. */
export const S3_CURSOR_PAYLOAD_MAX_BYTES = 12_288;
/** `s3c:1:` (6) plus the base64url of 12,288 bytes (16,384). */
export const S3_CURSOR_TEXT_MAX_CHARS = 16_390;
/** MinIO's minimum; the keys of all four verified servers are longer. */
export const S3_ACCESS_KEY_ID_MIN_CHARS = 3;
/**
 * The ID, a region of up to 64 characters and about 150 fixed characters fit the byte transport's 1,024-byte header
 * rule.
 */
export const S3_ACCESS_KEY_ID_MAX_CHARS = 512;
/** AWS's key limit; the one name of the key byte bound the console re-exports. */
export const S3_KEY_MAX_BYTES = 1_024;
/** Rows the Source tab shows and a console `preview` shows by default. */
export const S3_PREVIEW_DEFAULT_ROWS = 100;
/** The most rows any console result keeps: a literal equal to DEFAULT_QUERY_LIMIT, which a browser-safe module cannot import. */
export const S3_RESULT_MAX_ROWS = 500;
/** The cell bound of the console and the preview. */
export const S3_CELL_CHARS = 65_536;
/** The part of a server `Message` a sentence may carry. */
export const S3_SERVER_TEXT_CHARS = 300;
/** The characters of a key or bucket name a sentence shows. */
export const S3_SHOWN_NAME_CHARS = 120;
/** The S3 skew window: 14 minutes passed and 20 failed on MinIO, Silo and RustFS. */
export const S3_CLOCK_WINDOW_MS = 15 * 60 * 1000;

/** Printable ASCII without space, comma, equals sign or slash: the ID is written inside `Credential=`. */
export const S3_ACCESS_KEY_ID_PATTERN = /^[\x21-\x2b\x2d\x2e\x30-\x3c\x3e-\x7e]+$/;
/** 1 to 255 letters, digits, dots, hyphens or underscores, starting and ending with a letter or digit. */
export const S3_BUCKET_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9])?$/;
/** 1 to 64 letters, digits, hyphens or underscores. */
export const S3_REGION_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Object preview bounds. The three numbers the console and the preview share are read from their
// single definitions above; every other number of the preview is defined here once.

/**
 * Elements per allowed column, the one ratio behind two derived bounds: a Parquet schema of more than this many
 * elements per allowed leaf column is refused, and a CSV record keeps this many fields per shown column.
 */
export const S3_PREVIEW_ELEMENTS_PER_COLUMN = 8;

/** Every bound of one object preview; tests pass a smaller copy so fixtures stay small. */
export interface S3PreviewLimits {
  readonly textFetchBytes: number;
  readonly gzipFetchBytes: number;
  readonly decodedTextBytes: number;
  readonly hexBytes: number;
  readonly parquetTailBytes: number;
  readonly parquetFooterMaxBytes: number;
  readonly parquetFetchBudget: number;
  readonly parquetDecodeBudget: number;
  readonly parquetMaxPageValues: number;
  readonly parquetMaxChunkValues: number;
  readonly parquetMaxTotalValues: number;
  readonly parquetMaxLeafColumns: number;
  readonly parquetMaxSchemaDepth: number;
  readonly thriftMaxDepth: number;
  readonly sourceRows: number;
  readonly defaultRows: number;
  readonly maxRows: number;
  readonly cellChars: number;
  readonly summaryCellChars: number;
  readonly cellMaxDepth: number;
  readonly outputChars: number;
  readonly maxColumns: number;
  readonly csvSniffRecords: number;
}

/** The preview's bounds, each with its basis in docs/providers/s3.md, "Object preview". */
export const S3_PREVIEW_LIMITS: S3PreviewLimits = Object.freeze({
  textFetchBytes: 1_000_000,
  gzipFetchBytes: 1_000_000,
  decodedTextBytes: 1_000_000,
  hexBytes: 65_536,
  parquetTailBytes: 65_536,
  parquetFooterMaxBytes: 1_048_576,
  parquetFetchBudget: 8_388_608,
  parquetDecodeBudget: 33_554_432,
  parquetMaxPageValues: 524_288,
  parquetMaxChunkValues: 524_288,
  parquetMaxTotalValues: 524_288,
  parquetMaxLeafColumns: 128,
  parquetMaxSchemaDepth: 64,
  thriftMaxDepth: 32,
  sourceRows: 100,
  defaultRows: S3_PREVIEW_DEFAULT_ROWS,
  maxRows: S3_RESULT_MAX_ROWS,
  cellChars: S3_CELL_CHARS,
  summaryCellChars: 256,
  cellMaxDepth: 64,
  outputChars: 4_194_304,
  maxColumns: 1_024,
  csvSniffRecords: 20,
});

/**
 * At most two Parquet decodes or footer parses run at once in one process, whatever the provider, connection or user.
 */
export const S3_PARQUET_DECODE_SLOTS = 2;

/** At most this many previews wait for a decode slot; equal to the provider's request bound. */
export const S3_PARQUET_DECODE_QUEUE = S3_LIMITER_OPTIONS.perProvider;
