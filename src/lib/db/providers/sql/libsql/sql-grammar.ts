import { NO_EXTRA_WORDS, SQLITE_GRAMMAR } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/** How libSQL statement text is read: grammar, SQL text, redaction, update target and completion. */
export const LIBSQL_SQL_GRAMMAR: SqlGrammarSpec = {
  // The SAME grammar object, and every one of its four facts was re-measured over
  // Hrana on sqld 0.24.33 rather than inherited: `SELECT 1 # x` is refused ("bad
  // variable name", so `#` is no comment), `SELECT [id] FROM probe_customers` parses
  // (so brackets quote an identifier), `/* outer /* inner */ SELECT 1` RUNS (so block
  // comments do not nest), and `q'[x]'` is a syntax error. Sharing the object rather
  // than declaring a second identical one is deliberate: a divergence would then have
  // to be written down as its own grammar, which is the change a reader should see.
  // The `script` fact was measured on the same sqld: a trigger cut at its inner `;` is
  // "SQL string could not be parsed: unexpected end of input", and sent whole it is created.
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
