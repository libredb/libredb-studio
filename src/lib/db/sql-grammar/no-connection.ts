import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "./shared";
import type { SqlGrammarSpec } from "./types";

/**
 * What a call that names no type gets (`sqlGrammarFor(undefined)`): the compatibility grammar, read as SQL, and a
 * statement that keeps nothing when redacted.
 */
export const NO_CONNECTION_SQL_GRAMMAR: SqlGrammarSpec = {
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
