import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * Druid SQL, every fact read off Druid's own parser and probed on the server. The parser is Apache Calcite 1.37's
 * (`calcite.version` in Druid's `pom.xml`), generated from `sql/src/main/codegen/templates/Parser.jj` at druid-37.0.0,
 * and `DruidSqlParser.PARSER_CONFIG` sets `Quoting.DOUBLE_QUOTE`, so the lexer runs in its `DQID` state: `"…"` quotes a
 * name and neither `[` nor a backtick does. Each fact was measured on 2026-10-28 on apache/druid:37.0.0 over
 * `POST /druid/v2/sql` on the Router, the endpoint the provider sends on.
 *
 * Four readings are left at the shared reader's, each measured, and all but the last in the fail-safe direction. A
 * quote after a backslash in a `'…'` literal is unresolved to the span reader: Druid closes a plain literal there
 * (`SELECT 'a\' AS a` answers `a\`) but escapes in an `E'…'` literal (`SELECT E'it\'s' AS a` answers `it's`). A `"…"`
 * run holding a line feed is one name to the span reader, and Druid refuses it (`QUOTED_IDENTIFIER` excludes `\n` and
 * `\r`). A backtick run is a name to the span reader, and Druid refuses the character (`Lexical error ... Encountered:
 * "`"`). And an untagged `$$` run is a dollar string to the span reader, while Druid reads `$` as an identifier
 * character (`SELECT $$x$$ AS a` is "Column '$$x$$' not found"), so text the run holds is either refused with it or,
 * after a `--` or `//` inside the run, a comment Druid reads where the span reader reads code. That last reading is not
 * fail-safe: the limiter can write its bound inside such a comment and report the statement bounded.
 */
const DRUID_GRAMMAR: SqlGrammar = {
  // CODE: the lexer has no `#` token, and `SELECT 1 AS a # note` is 400 "Lexical error ... Encountered: \"#\"".
  hash: "code",
  // A SUBSCRIPT and an array constructor: in the `DQID` state `[` and `]` are the plain `LBRACKET` and `RBRACKET`
  // tokens. `SELECT ARRAY_LENGTH(ARRAY[ARRAY[1,2],ARRAY[3,4]]) AS a` answers 2, `SELECT ARRAY_OFFSET(ARRAY['a]b','c'],
  // 0) AS a` answers `a]b`, and `SELECT 1 AS [a]` is 400 "Incorrect syntax near the keyword 'AS'".
  bracket: "subscript",
  // FLAT: `/*` enters `IN_MULTI_LINE_COMMENT`, which the first `*/` leaves, with no depth count. `SELECT /* a /* b */
  // 1 AS a` answers 1, and `SELECT /* a /* b */ c */ 1 AS a` is 400 "Received an unexpected token [*/]".
  blockComment: "flat",
  // `SELECT q'[x]' AS a` is 400 "Expecting alias, found character literal".
  alternateQuoting: false,
  // A LINE comment: the token is `("//"|"--")(~["\n","\r"])*`. `SELECT 4 // 2 AS a` answers 4 in a column named
  // EXPR$0, `SELECT 1 AS a // note; SELECT 999` answers 1 alone, and `SELECT 1 AS a // note<LF>, 2 AS b` answers both
  // columns.
  doubleSlashComment: true,
  // A plain literal is `<QUOTE> ( (~["'"]) | ("''"))* <QUOTE>`: `SELECT 'a\' AS a` answers `a\` and `SELECT 'it\'s'
  // AS a` is 400 "Received an unexpected token [\']". The `E'…'` literal escapes, so no row value holds for both.
  backslashAlwaysEscapes: false,
  // A name is `"` ( ~["\"","\n","\r"] | "\"\"" )+ `"`: `SELECT 1 AS "a\"` answers a column named `a\`.
  doubleQuoteBackslashEscapes: false,
  // `$` is a `LETTER`: `SELECT 1 AS $t$` answers a column named `$t$`.
  dollarTags: false,
  // `/*+` is its own token (`HINT_BEG`) and the hint body is parsed as code up to `COMMENT_END`: `SELECT /*+ h('*/')
  // */ 1 AS a` answers 1, `SELECT /*+ x */ 1 AS a */` is 400 "Received an unexpected token [*/]", and inside a comment
  // `/*+` is text: `SELECT /* a /*+ b */ 1 AS a` answers 1.
  hintsAreCode: true,
  // The line comment token stops at `\n` or `\r`: `SELECT 1 AS a -- note<CR>, 2 AS b` and the same with `//` answer
  // both columns, and so does `SELECT 1 AS a -- note \<LF>, 2 AS b`, so a backslash continues nothing.
  lineCommentEndsAtCarriageReturn: true,
  // No procedural body, and one statement per request: a request may carry SET statements before its one query, and
  // `SELECT 1 AS a; SELECT 2 AS b` is 400 "Only SET statements can appear before the final statement".
  script: DEFAULT_SQL_GRAMMAR.script,
  // `OffsetClause` takes an optional `ROW | ROWS` after its count: `SELECT 1 AS a LIMIT 5 OFFSET 0 ROWS` answers the
  // row, and the same text with ` LIMIT 500` after it is 400 "Received an unexpected token [LIMIT]". `ROW` and `ROWS`
  // are reserved, so neither can end a statement as a name.
  trailingLimitClauses: [/\s+ROWS?\s*$/i],
  // `LimitClause` takes `ALL` in place of a count: `SELECT 1 AS a LIMIT ALL` answers the row, and `SELECT 1 AS a
  // LIMIT ALL LIMIT 500` is 400 "Received an unexpected token [LIMIT]". `LIMIT NULL` is a syntax error.
  nonNumericRowBounds: ["ALL"],
};

/** How Druid statement text is read: grammar, SQL text, redaction, update target and completion. */
export const DRUID_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DRUID_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "none" },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
