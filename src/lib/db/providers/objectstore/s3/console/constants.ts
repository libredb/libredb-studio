/**
 * The S3 console's numbers.
 *
 * Pure, and shipped to the browser. A number the provider or the preview also uses is defined once in the provider
 * root's `constants.ts` and re-exported here under the same name, so the console imports the
 * root and the root never imports the console. The numbers below are the console's own.
 */
export {
  S3_CELL_CHARS,
  S3_KEY_MAX_BYTES,
  S3_KEY_SCAN_MAX_COUNT,
  S3_PREVIEW_DEFAULT_ROWS,
  S3_RESULT_MAX_ROWS,
} from "../constants";

/** Bytes of UTF-8 in one console command, Oxia's command text bound; the vocabulary row imports it. */
export const S3_MAX_TEXT_BYTES = 65_536;
/** Requests one ListObjectsV2 run sends before it stops with a token (the page cap the AWS CLI reference recommends). */
export const S3_MAX_PAGES_PER_RUN = 50;
/** Characters of a `--starting-token`: a 4,096-character service token wrapped in JSON and base64 stays under 5,500. */
export const S3_MAX_TOKEN_CHARS = 8_192;
/** Bytes of UTF-8 in a `--bucket` value: Studio's input bound, not a server limit. */
export const S3_MAX_BUCKET_BYTES = 255;
/** Characters of a typed word a refusal echoes; never more. */
export const S3_ECHO_WORD_CHARS = 40;
