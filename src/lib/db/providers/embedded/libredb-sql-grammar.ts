import { NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import { DEFAULT_SQL_GRAMMAR } from "@libredb/provider-sdk/sql";
import type { SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/** How the embedded LibreDB store statement text is read: grammar, SQL text, redaction, update target and completion. */
export const LIBREDB_SQL_GRAMMAR: SqlGrammarSpec = {
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
