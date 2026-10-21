import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/** How Neo4j statement text is read: grammar, SQL text, redaction, update target and completion. */
export const NEO4J_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DEFAULT_SQL_GRAMMAR,
  // `neo4j` takes one Cypher statement (Neo4j spec 5.5), which is not SQL text either: its strings
  // escape with a backslash, `//` opens a comment and a backtick quotes a name, so a SQL span reader
  // would misread where a literal ends. Its provider reads the text with the graph lexer
  // (`src/lib/db/graph/cypher/lexer.ts`) and refuses every write before sending it.
  readsSqlText: false,
  redaction: { kind: "none" },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
