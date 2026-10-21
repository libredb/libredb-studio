import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/** How Druid statement text is read: grammar, SQL text, redaction, update target and completion. */
export const DRUID_SQL_GRAMMAR: SqlGrammarSpec = {
  // At the compatibility default because no rule was established for it, NOT because it agrees with the default.
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
