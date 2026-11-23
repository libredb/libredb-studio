import { NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import { DEFAULT_SQL_GRAMMAR } from "@libredb/provider-sdk/sql";
import type { SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/** How OPC UA statement text is read: grammar, SQL text, redaction, update target and completion. */
export const OPCUA_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DEFAULT_SQL_GRAMMAR,
  // One JSON read request naming node ids, so no span of it is SQL (#1677).
  readsSqlText: false,
  redaction: { kind: "none" },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
