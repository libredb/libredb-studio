import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/** How Qdrant statement text is read: grammar, SQL text, redaction, update target and completion. */
export const QDRANT_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DEFAULT_SQL_GRAMMAR,
  // `qdrant` takes one Qdrant console request (vector-family spec 6.4), a `METHOD /path` line and one JSON body,
  // which is not SQL text either: its strings escape with a backslash and `//` opens a comment outside a string.
  // Its provider extends `BaseDatabaseProvider` and parses the text with the shared console parser.
  readsSqlText: false,
  redaction: { kind: "none" },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
