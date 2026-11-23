/**
 * The numbers and fixed names the oxia command language reads (SB1-11), in one pure, browser-safe module.
 *
 * The command table and its parser and the confirmation row read them, and the provider reads the same ones from here;
 * the module imports nothing. The provider's own numbers (its receive caps, limiter options, deadlines, the admin port
 * and the TLS server name) stay in `src/lib/db/providers/keyvalue/oxia/constants.ts`, and no module restates one.
 */
/** The data server's public port, the CLI's default. */
export const OXIA_DEFAULT_PORT = 6648;
/** Keys under this prefix are Oxia's own internal records; no surface of Studio reads them. */
export const OXIA_INTERNAL_PREFIX = "__oxia/";
/** `list --limit` when the command names none. */
export const OXIA_LIST_DEFAULT_LIMIT = 500;
/** `range-scan --limit` when the command names none. */
export const OXIA_SCAN_DEFAULT_LIMIT = 100;
/**
 * The largest `--limit` a console command may ask. A literal rather than an import of `DEFAULT_QUERY_LIMIT`: the
 * query limiter's module imports the SQL readers, which a browser-safe module may not pull in, and the console's test
 * holds the two equal.
 */
export const OXIA_MAX_LIMIT = 500;
/** Bytes of one console command's text. */
export const OXIA_MAX_TEXT_BYTES = 65_536;
/** Characters of a typed word a sentence echoes; never more. */
export const OXIA_ECHO_WORD_CHARS = 40;
