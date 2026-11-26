import { NO_EXTRA_WORDS } from "./shared";
import { DEFAULT_SQL_GRAMMAR } from "@libredb/provider-sdk/sql";
import type { SqlGrammarSpec } from "./types";

/** What a call that names no type gets (`sqlGrammarFor(undefined)`): the compatibility grammar, read as SQL. */
export const NO_CONNECTION_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DEFAULT_SQL_GRAMMAR,
  readsSqlText: true,
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
