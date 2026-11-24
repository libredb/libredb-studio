import { NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import { DEFAULT_SQL_GRAMMAR } from "@libredb/provider-sdk/sql";
import type { SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/** How Modbus statement text is read: grammar, SQL text, redaction, update target and completion. */
export const MODBUS_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DEFAULT_SQL_GRAMMAR,
  // One JSON read request against a register map, so no span of it is SQL (#1723).
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
