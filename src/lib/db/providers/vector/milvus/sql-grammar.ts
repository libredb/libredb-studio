import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/** How Milvus statement text is read: grammar, SQL text, redaction, update target and completion. */
export const MILVUS_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DEFAULT_SQL_GRAMMAR,
  // `milvus` takes one Milvus console request (vector-family spec 5.4), a `POST /v2/vectordb/<route>` line and one
  // JSON body, which is not SQL text either: its strings escape with a backslash, and its filter is a Milvus
  // expression the server parses. Its provider extends `BaseDatabaseProvider` and parses the text itself.
  readsSqlText: false,
  redaction: { kind: "none" },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
