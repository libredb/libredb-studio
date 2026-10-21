import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * BigQuery (GoogleSQL), every fact measured on 2026-10-11 through `jobs.query` dry runs, which validate a statement
 * without running or billing it.
 */
const BIGQUERY_GRAMMAR: SqlGrammar = {
  // COMMENT: `SELECT 1 # x` and `SELECT 1 #> 2` both validate, so a `#` hides the rest of its line.
  hash: "comment",
  // A SUBSCRIPT: `SELECT [1,2][OFFSET(0)]` validates, and `SELECT 1 AS [a]` is `Unexpected "["`.
  bracket: "subscript",
  // FLAT: `SELECT /* a /* b */ 1` validates, and the same text with a trailing `*/` is `Unexpected "/"`.
  blockComment: "flat",
  // `SELECT q'{a}'` is a syntax error: the `q` is an identifier and `'{a}'` a stray string.
  alternateQuoting: false,
  // `SELECT 1 // x` is `Unexpected "/"`.
  doubleSlashComment: false,
  // `'it\'s'` and `"it\"s"` validate, a backslash before a line feed is "Illegal escaped newline", and a doubled
  // quote is no escape: `'it''s'` is "concatenated string literals must be separated by whitespace or comments".
  backslashAlwaysEscapes: true,
  // `'''a'b''c'''`, `"""a"b""c"""` and a triple with a line feed inside all validate.
  tripleQuotedStrings: true,
  // `` `a\`b` `` is ONE identifier a`b, and a doubled backtick is a syntax error (dry runs, 2026-10-11).
  backtickBackslashEscapes: true,
  // A script (`BEGIN … END`) is sent whole as one job, which the shared splitter does not model.
  script: DEFAULT_SQL_GRAMMAR.script,
  trailingLimitClauses: DEFAULT_SQL_GRAMMAR.trailingLimitClauses,
};

/** How BigQuery statement text is read: grammar, SQL text, redaction, update target and completion. */
export const BIGQUERY_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: BIGQUERY_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: null },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
