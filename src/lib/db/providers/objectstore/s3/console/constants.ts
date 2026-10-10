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
/**
 * Characters of a `--starting-token`: the widest a 4,096-character service token, the longest the client reads, can
 * be written, so every token a notice gives is read back. JSON writes a character in at most six bytes, a control
 * character as a `\u` escape, so the object is at most 22 + 6 x 4,096 + 2 = 24,600 bytes, which base64 writes in
 * 32,800 characters.
 */
export const S3_MAX_TOKEN_CHARS = 32_800;
/** Bytes of UTF-8 in a `--bucket` value: Studio's input bound, not a server limit. */
export const S3_MAX_BUCKET_BYTES = 255;
/** Characters of a typed word a refusal echoes; never more. */
export const S3_ECHO_WORD_CHARS = 40;
