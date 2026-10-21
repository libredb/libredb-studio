import { NO_EXTRA_WORDS, SQLITE_GRAMMAR } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/** How SQLite statement text is read: grammar, SQL text, redaction, update target and completion. */
export const SQLITE_SQL_GRAMMAR: SqlGrammarSpec = {
  // The grammar libSQL shares, with its sources, is `SQLITE_GRAMMAR` in `src/lib/db/sql-grammar/shared.ts`.
  // `//` reads as CODE through the bundled driver, refusing the characters where they stand.
  grammar: SQLITE_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: null },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
