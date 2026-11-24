import { NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import { DEFAULT_SQL_GRAMMAR } from "@libredb/provider-sdk/sql";
import type { SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/** How MTConnect statement text is read: grammar, SQL text, redaction, update target and completion. */
export const MTCONNECT_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DEFAULT_SQL_GRAMMAR,
  // One request line in the agent's own URL grammar, so no span of it is SQL (#1722).
  readsSqlText: false,
  redaction: { kind: "none" },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    supportsTopClause: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
