import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * DuckDB, every fact measured on v1.5.5 through `@duckdb/node-api` 1.5.5-r.4.
 *
 * A separate object from `POSTGRES_GRAMMAR` even though the five values coincide, and
 * the coincidence is why: DuckDB's dialect is Postgres-SHAPED rather than PostgreSQL's,
 * so sharing the object would say the two move together, which nothing measured here
 * supports. The engine already disagrees with PostgreSQL elsewhere in this codebase
 * (`X'…'` is a string here, `bytea` is an alias for `BLOB`), and a divergence in one of
 * these five should be a value changing in this object rather than a split.
 */
const DUCKDB_GRAMMAR: SqlGrammar = {
  // CODE: `SELECT 1 # x` is `Parser Error: syntax error at or near "#"`, so the rest
  // of the line is not hidden.
  hash: "code",
  // A SUBSCRIPT, not a name quote: `SELECT [1,2][1]` answers 1, so the brackets are a
  // LIST literal followed by a 1-based index. Copying SQLite's `quoted-identifier`
  // row - the tempting move, since both engines open a local file - would read an
  // everyday DuckDB list literal as a name and lose the statement's bound.
  bracket: "subscript",
  // NESTING: `/* a /* b */ still */ SELECT 1` runs, so the inner `*/` did not close
  // the run.
  blockComment: "nesting",
  // `SELECT q'[x]' AS a` is `Catalog Error: Type with name q does not exist!` - the
  // `q` was read as a type name, so the form is not in the grammar.
  alternateQuoting: false,
  // `SELECT 1 AS a // note` is `Parser Error: syntax error at or near "//"`.
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  script: DEFAULT_SQL_GRAMMAR.script,
  trailingLimitClauses: DEFAULT_SQL_GRAMMAR.trailingLimitClauses,
};

/**
 * DuckDB's own, which are not reserved anywhere else.
 *
 * Measured on DuckDB 1.5.5, `(PIVOT orders ON k USING max(note))` is a scalar subquery
 * that answers with another table's value. Asking about them everywhere cost PostgreSQL a
 * refusal for `coalesce(show, '')`, where `show` is an ordinary column name, so they are
 * asked about under the dialect that has them.
 */
const DUCKDB_QUERY_OPENERS: ReadonlySet<string> = new Set([
  "PIVOT",
  "UNPIVOT",
  "UNNEST",
  "SUMMARIZE",
  "DESCRIBE",
  "SHOW",
]);

/** How DuckDB statement text is read: grammar, SQL text, redaction, update target and completion. */
export const DUCKDB_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DUCKDB_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: null },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: DUCKDB_QUERY_OPENERS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
