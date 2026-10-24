import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/** How Weaviate statement text is read: grammar, SQL text, redaction, update target and completion. */
export const WEAVIATE_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DEFAULT_SQL_GRAMMAR,
  // `weaviate` takes one Weaviate console request (#1566 spec 5.1), a `METHOD /v1/path` line and one JSON body,
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
