/**
 * The names Studio holds: the tables a declared explain format, query dialect, query language, Monaco language and
 * formatter language are held to (docs/providers/CONTRACT.md, M-48, M-50, S-4 and S-23), each read engine-neutrally
 * from the table of Studio's that gives the name its meaning:
 *
 * - query dialects, the keys of `QUERY_DIALECTS`, Studio's dialect rows;
 * - Monaco languages, the keys of `BUNDLED_EDITOR_LANGUAGES`, the server-safe table of the editor languages; the
 *   browser's `EDITOR_LANGUAGES` refuses at load every one it holds no code for;
 * - formatter languages, `FORMATTER_LANGUAGES`, the ones Studio's own engines state;
 * - explain formats, `EXPLAIN_FORMATS`, the formats Studio holds an explain strategy for;
 * - query languages, the keys of `QUERY_LANGUAGE_TAB_TYPES`, the languages Studio holds a tab type for.
 *
 * Boot hands these to admission (src/lib/provider-host/boot.ts), which refuses a package engine stating a name none
 * holds, and the declaration generator holds every legacy declaration to them (scripts/generate-engine-declarations.ts).
 * The check itself is `unheldNamePointers` (src/lib/provider-host/held-names.ts).
 */
import { QUERY_LANGUAGE_TAB_TYPES } from "@/lib/db/engine-catalog/projection";
import { BUNDLED_EDITOR_LANGUAGES } from "@/lib/db/engine-catalog/query-editor.generated";
import { QUERY_DIALECTS } from "@/lib/db/query-dialects";
import { FORMATTER_LANGUAGES } from "@/lib/db/sql-grammar";
import { EXPLAIN_FORMATS } from "@/lib/explain";
import type { HeldNames } from "@/lib/provider-host/held-names";

/** Studio's held names, each a frozen array. */
export const STUDIO_HELD_NAMES: HeldNames = Object.freeze({
  explainFormats: EXPLAIN_FORMATS,
  queryDialects: Object.freeze(Object.keys(QUERY_DIALECTS)),
  queryLanguages: Object.freeze(Object.keys(QUERY_LANGUAGE_TAB_TYPES)),
  monacoLanguages: Object.freeze(Object.keys(BUNDLED_EDITOR_LANGUAGES)),
  formatterLanguages: FORMATTER_LANGUAGES,
});
