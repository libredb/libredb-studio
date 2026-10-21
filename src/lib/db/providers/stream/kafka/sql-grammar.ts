import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/** How Kafka statement text is read: grammar, SQL text, redaction, update target and completion. */
export const KAFKA_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DEFAULT_SQL_GRAMMAR,
  // `kafka` takes a JSON read request (#1088), one object naming a topic and where to read it
  // from, which is not SQL text either: its strings escape with a backslash as a MongoDB
  // document's do. Its provider extends `BaseDatabaseProvider` and parses the text itself.
  readsSqlText: false,
  redaction: { kind: "none" },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
