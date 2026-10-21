import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/** How etcd statement text is read: grammar, SQL text, redaction, update target and completion. */
export const ETCD_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DEFAULT_SQL_GRAMMAR,
  // `etcd` takes an etcdctl command line (#1089), which is not SQL text either: its words are read by
  // the shell's quoting rules and a txn body by etcdctl's own, and a key may be spelled like any SQL
  // keyword. Its provider extends `BaseDatabaseProvider` and parses the text itself.
  readsSqlText: false,
  redaction: { kind: "none" },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
