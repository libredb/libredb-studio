import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/** How Prometheus statement text is read: grammar, SQL text, redaction, update target and completion. */
export const PROMETHEUS_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DEFAULT_SQL_GRAMMAR,
  // `prometheus` takes a PromQL expression (#1085), which is not SQL text either: PromQL
  // strings escape with a backslash, so a SQL span reader reads `'it\'s'` as a literal
  // that never closes, which is the false prompt #297 measured on Redis. Its provider
  // extends `BaseDatabaseProvider` as well.
  readsSqlText: false,
  redaction: { kind: "none" },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
