import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "./shared";
import type { SqlGrammarSpec } from "./types";

/**
 * What a type id that is no member of `DatabaseType` gets, a host application's unrecognised string or a prototype
 * key such as `"constructor"` included: the compatibility grammar, read as SQL, and a statement that keeps nothing
 * when redacted. A separate object from `NO_CONNECTION_SQL_GRAMMAR` with the same facts, so a reader can tell the
 * two cases apart.
 */
export const UNKNOWN_TYPE_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DEFAULT_SQL_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "none" },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
