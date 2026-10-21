import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * Apache DataFusion as InfluxDB 3.12.0 Core parses it. Established the same way as the Trino row and
 * for the same reason: the engine IS an HTTP endpoint, so every fact below is a statement the server
 * answered through `POST /api/v3/query_sql` with `{"db":"home","q":<text>,"format":"jsonl"}`, the
 * body the `influxdb3` provider sends, and none is read off a neighbouring dialect. Re-run 2026-10-04.
 *
 * Three more measured facts about this dialect are not fields of this record and are carried where
 * the repository keeps them: a string doubles its quote (`''`) and gives a backslash no meaning (the
 * standard literal rule in `values.ts`), a name is quoted with `"` and doubles it (`""`), and an
 * unquoted name folds to lower case (the default branch of `quoteIdentifier`).
 */
const DATAFUSION_GRAMMAR: SqlGrammar = {
  // `#` opens NOTHING: `SELECT 1 AS x # c` is HTTP 400, `ParserError("Expected: end of statement,
  // found: # at Line: 1, Column: 15")`. So the rest of the line is not hidden, and a `;` written after
  // it is a statement boundary.
  hash: "code",
  // A SUBSCRIPT and an array literal, never a name quote. `SELECT [1,2] AS a` answers `[1,2]` and
  // `SELECT [1,2][1] AS x` answers 1. It NESTS: `SELECT [[1,2],[3,4]][2][1] AS x` answers 3. A literal
  // inside it is a literal: `SELECT ['a]b'][1] AS x` answers `a]b`. And `SELECT [room] FROM home`
  // answers an array column named `make_array(home.room)`, so the brackets were read THROUGH to an
  // expression, which the identifier reading could never do.
  bracket: "subscript",
  // NESTING: `SELECT 1 /* a /* b */ c */ AS x` answers `{"x":1}`, so the inner `*/` did not close the
  // run. A flat reader would have taken `c */ AS x` for code.
  blockComment: "nesting",
  // `SELECT q'[x]' AS x` is HTTP 400, `ParserError("Expected: end of statement, found: AS at Line: 1,
  // Column: 15")`: the form does not exist here, so those characters are a name followed by an
  // ordinary string.
  alternateQuoting: false,
  // CODE: `SELECT 1 AS x // c` is HTTP 400, `ParserError("Expected: end of statement, found: // at
  // Line: 1, Column: 15")`, so the slashes are refused where they stand rather than hiding what
  // follows.
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  script: DEFAULT_SQL_GRAMMAR.script,
  trailingLimitClauses: DEFAULT_SQL_GRAMMAR.trailingLimitClauses,
};

/** How InfluxDB 3 (SQL) statement text is read: grammar, SQL text, redaction, update target and completion. */
export const INFLUXDB3_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DATAFUSION_GRAMMAR,
  // True, for the search pair's reason: its text is SQL and its provider extends `SQLBaseProvider`, so the SQL gate
  // reads it and will prompt on a `DELETE` or `DROP` the provider then refuses, a documented cost.
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: null },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
