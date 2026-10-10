/**
 * The S3 object preview: its limits, one name per shared number, and, from Task 18 on,
 * previewObject's dispatch and the checks every ranged answer passes before its bytes are used.
 */
import { describe, expect, test } from "bun:test";
import { SOURCE_CHARACTER_LIMIT } from "@/lib/db/object-kinds";
import * as consoleConstants from "@/lib/db/providers/objectstore/s3/console/constants";
import {
  S3_CELL_CHARS,
  S3_LIMITER_OPTIONS,
  S3_PARQUET_DECODE_QUEUE,
  S3_PARQUET_DECODE_SLOTS,
  S3_PREVIEW_DEFAULT_ROWS,
  S3_PREVIEW_LIMITS,
  S3_RESULT_MAX_ROWS,
} from "@/lib/db/providers/objectstore/s3/constants";

describe("the preview's limits", () => {
  test("defaultRows, maxRows and cellChars are the single definitions, and the console re-exports the same bindings", () => {
    expect(S3_PREVIEW_LIMITS.defaultRows).toBe(S3_PREVIEW_DEFAULT_ROWS);
    expect(S3_PREVIEW_LIMITS.maxRows).toBe(S3_RESULT_MAX_ROWS);
    expect(S3_PREVIEW_LIMITS.cellChars).toBe(S3_CELL_CHARS);
    expect(consoleConstants.S3_PREVIEW_DEFAULT_ROWS).toBe(S3_PREVIEW_DEFAULT_ROWS);
    expect(consoleConstants.S3_RESULT_MAX_ROWS).toBe(S3_RESULT_MAX_ROWS);
    expect(consoleConstants.S3_CELL_CHARS).toBe(S3_CELL_CHARS);
  });

  test("the object is frozen, so no caller widens a bound for the whole process", () => {
    expect(Object.isFrozen(S3_PREVIEW_LIMITS)).toBe(true);
  });

  test("a text read and a decoded gzip prefix always fit one Source part uncut", () => {
    expect(S3_PREVIEW_LIMITS.textFetchBytes).toBeLessThanOrEqual(SOURCE_CHARACTER_LIMIT);
    expect(S3_PREVIEW_LIMITS.decodedTextBytes).toBeLessThanOrEqual(SOURCE_CHARACTER_LIMIT);
  });

  test("the documented values, with the Parquet caps the decode heap measurement fixed", () => {
    expect({ ...S3_PREVIEW_LIMITS }).toEqual({
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
      defaultRows: 100,
      maxRows: 500,
      cellChars: 65_536,
      summaryCellChars: 256,
      cellMaxDepth: 64,
      outputChars: 4_194_304,
      maxColumns: 1_024,
      csvSniffRecords: 20,
    });
  });

  test("two Parquet decodes run per process, and the queue equals the provider's request bound", () => {
    expect(S3_PARQUET_DECODE_SLOTS).toBe(2);
    expect(S3_PARQUET_DECODE_QUEUE).toBe(S3_LIMITER_OPTIONS.perProvider);
    expect(S3_PARQUET_DECODE_QUEUE).toBe(4);
  });
});
