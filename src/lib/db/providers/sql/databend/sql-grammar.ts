import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * Databend, every fact read off the server's own lexer (`src/query/ast/src/parser/token.rs`) and parser rather than
 * a neighbouring dialect: there is no driver package to ask, and the lexer is what the server runs. The one fact a
 * source could not settle, the trailing `FORMAT` clause, was measured on the pinned image over `POST /v1/query`.
 *
 * Five readings of Databend's differ from the span reader's and are refused by the provider's statement guard
 * (`providers/sql/databend/sql-text.ts`) rather than carried here. A `--` comment ends at a form feed. An `@` stage
 * token runs to the first white space, comma, semicolon, quote or parenthesis and takes `\'`, `--`, `/*`, a dollar run
 * and `[` into the name where the span reader opens a quote, a comment, a dollar string or an array, so the guard
 * refuses a stage token that holds a backslash or any run the span reader opens; an `@` that ends a `<@` operator,
 * which the lexer takes as one token, opens no stage token. The body of a `/*+` hint is tokenized, so the hint ends at
 * the first closing star-slash TOKEN, which a quote or comment inside the body can move past the one the span reader
 * stops at. A `$tag$…$tag$` run is a dollar string to the span reader while Databend lexes `$tag$` as a variable and
 * reads the text between two tags as code. And a `$$` straight after an identifier character is part of that
 * identifier to Databend, whose identifier tail takes `$`, while the span reader opens a dollar string there.
 */
const DATABEND_GRAMMAR: SqlGrammar = {
  // CODE: the lexer has `#`, `#>`, `#>>` and `#-` as operator tokens, and its only comment forms are `--` and the
  // block form.
  hash: "code",
  // A SUBSCRIPT and an array literal: `[` and `]` are plain tokens, and names are quoted with `"` or a backtick.
  bracket: "subscript",
  // FLAT: `lex_comment_block` scans for the first `*/` with no depth count.
  blockComment: "flat",
  alternateQuoting: false,
  // CODE: `//` is an operator token.
  doubleSlashComment: false,
  // The string token is `'([^'\\]|\\.|'')*'` and its `"` twin, and no setting turns the escape off, so `'it\'s'`
  // is one terminated literal and a backslash before a line feed leaves one unterminated.
  backslashAlwaysEscapes: true,
  // A body is a `$$` literal (`EXECUTE IMMEDIATE $$ … $$`, a procedure), which the span reader holds whole.
  script: DEFAULT_SQL_GRAMMAR.script,
  // Measured on the pinned image: `SELECT 1 FORMAT JSON LIMIT 5` is 1005 "unexpected `LIMIT`", and
  // `SELECT 1 LIMIT 5 FORMAT JSON` succeeds. The format is one bracket-free word, so a `)` after it ends the match.
  // Databend's documented SELECT syntax places IGNORE_RESULT after LIMIT/OFFSET
  // (https://docs.databend.com/sql/sql-commands/query-syntax/query-select), so the bound goes before it and an
  // existing `... ORDER BY EventTime LIMIT 10 ignore_result` keeps its bound rather than taking a second one (#2092).
  // The word is also a legal alias after `AS`, and a guard for that was measured and refused: a lookbehind over the
  // whitespace run re-scans it from every position the strip retries, so a 100,000-space run took seconds where the
  // plain word reads once - the same accepted trade-off the `ROWS?` clause already ships. The exposure is the one
  // end-anchored alias shape `SELECT 1 AS IGNORE_RESULT` with nothing after it; any FROM, second column or bound
  // behind the alias breaks the anchor and the word reads as code again.
  trailingLimitClauses: [/\s+FORMAT\s+\w+\s*$/i, /\s+IGNORE_RESULT\s*$/i],
};

/** How Databend statement text is read: grammar, SQL text, redaction, update target and completion. */
export const DATABEND_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DATABEND_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: null },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
