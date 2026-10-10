/**
 * The console's numbers: five it shares with the provider and the preview, defined once in
 * the provider root's constants.ts and re-exported here under the same name, and five of its own.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as root from "@/lib/db/providers/objectstore/s3/constants";
import * as consoleConstants from "@/lib/db/providers/objectstore/s3/console/constants";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SOURCE = readFileSync(join(ROOT, "src/lib/db/providers/objectstore/s3/console/constants.ts"), "utf8");

const SHARED = [
  "S3_RESULT_MAX_ROWS",
  "S3_KEY_SCAN_MAX_COUNT",
  "S3_PREVIEW_DEFAULT_ROWS",
  "S3_KEY_MAX_BYTES",
  "S3_CELL_CHARS",
] as const;

// Plain copies of the two namespaces, so the lookup by name below is not a computed read of an imported namespace.
const ROOT_VALUES = { ...root };
const CONSOLE_VALUES = { ...consoleConstants };

describe("the console's constants", () => {
  test("the result bound is the query limiter's DEFAULT_QUERY_LIMIT", () => {
    expect(consoleConstants.S3_RESULT_MAX_ROWS).toBe(DEFAULT_QUERY_LIMIT);
  });

  test.each(SHARED.map((name) => [name]))("%s is the provider root's, re-exported and not defined here", (name) => {
    expect(CONSOLE_VALUES[name]).toBe(ROOT_VALUES[name]);
    expect(SOURCE).not.toMatch(new RegExp(`export const ${name}\\b`));
    expect(SOURCE).toMatch(new RegExp(`\\b${name}\\b[^;]*from "\\.\\./constants"`, "s"));
  });

  test("every number has the value the console's limits fix", () => {
    expect({
      S3_RESULT_MAX_ROWS: consoleConstants.S3_RESULT_MAX_ROWS,
      S3_KEY_SCAN_MAX_COUNT: consoleConstants.S3_KEY_SCAN_MAX_COUNT,
      S3_PREVIEW_DEFAULT_ROWS: consoleConstants.S3_PREVIEW_DEFAULT_ROWS,
      S3_KEY_MAX_BYTES: consoleConstants.S3_KEY_MAX_BYTES,
      S3_CELL_CHARS: consoleConstants.S3_CELL_CHARS,
      S3_MAX_TEXT_BYTES: consoleConstants.S3_MAX_TEXT_BYTES,
      S3_MAX_PAGES_PER_RUN: consoleConstants.S3_MAX_PAGES_PER_RUN,
      S3_MAX_TOKEN_CHARS: consoleConstants.S3_MAX_TOKEN_CHARS,
      S3_MAX_BUCKET_BYTES: consoleConstants.S3_MAX_BUCKET_BYTES,
      S3_ECHO_WORD_CHARS: consoleConstants.S3_ECHO_WORD_CHARS,
    }).toEqual({
      S3_RESULT_MAX_ROWS: 500,
      S3_KEY_SCAN_MAX_COUNT: 1_000,
      S3_PREVIEW_DEFAULT_ROWS: 100,
      S3_KEY_MAX_BYTES: 1_024,
      S3_CELL_CHARS: 65_536,
      S3_MAX_TEXT_BYTES: 65_536,
      S3_MAX_PAGES_PER_RUN: 50,
      S3_MAX_TOKEN_CHARS: 8_192,
      S3_MAX_BUCKET_BYTES: 255,
      S3_ECHO_WORD_CHARS: 40,
    });
  });
});
