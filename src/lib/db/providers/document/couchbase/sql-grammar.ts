import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * Couchbase SQL++, every fact read off the query service's own lexer (`parser/n1ql/n1ql.nex` in couchbase/query, the
 * 8.0 branch) and the SQL++ language reference (Identifiers, Literals, LIMIT and OFFSET clauses, and the `n1ql.ebnf`
 * and `dql.ebnf` grammar it includes), and each one probed on 2026-10-28 on couchbase:community-8.0.2 over
 * `POST /query/service`, the endpoint the provider sends on. A `"…"` run is a string literal there, not a name, but the
 * span reader's quoted-name reading of it ends in the same place under the escape rule below, which is all the
 * readers ask.
 *
 * Three readings are left at the shared reader's, each in the fail-safe direction and each measured. A `$$` or
 * `$tag$` run is a dollar string to the span reader, while SQL++ has no dollar string and refuses a `$` that no
 * parameter name or number follows (`SELECT $$x$$ AS a` is 3000 "syntax error ... at: $"), so the run keeps text the
 * engine refuses as one statement. A backslash before a line feed inside a literal leaves it unterminated to the span
 * reader, and SQL++ refuses that escape too (`invalid escape sequence`). And a `LIMIT` whose count is an expression
 * or a parameter (`LIMIT $n`, `LIMIT 2 * 3`) is not read as a bound, so the limiter appends one and the engine refuses
 * the second `LIMIT` rather than running the read unbounded.
 */
const COUCHBASE_GRAMMAR: SqlGrammar = {
  // CODE: the lexer has no `#` token, and `SELECT 1 AS a # note` is 3000 "syntax error ... at: #".
  hash: "code",
  // A SUBSCRIPT and an array literal: `[` and `]` are plain tokens and names are quoted with a backtick.
  // `SELECT [1,[2,3]][1][0] AS a` answers 2, `SELECT {"a]b": 7}.["a]b"] AS a` answers 7, and `SELECT 1 AS [a]` is
  // 3000 "syntax error ... at: [".
  bracket: "subscript",
  // FLAT: the block comment token runs to the first `*/`. `SELECT /* a /* b */ 1 AS a` answers 1, and
  // `SELECT /* a /* b */ c */ 1 AS a` is 3000 "syntax error ... at: /". A `/*+` hint is a token of the same extent:
  // `SELECT /*+ 'x */ 1 AS a` answers 1.
  blockComment: "flat",
  // `SELECT q'[x]' AS a` is 3000 "syntax error ... at: '[x]'".
  alternateQuoting: false,
  // CODE: `/` is the division token, and `SELECT 4 // 2 AS a` is 3000 "syntax error ... at: /".
  doubleSlashComment: false,
  // The string tokens are `"(\\"|\\[^"]|[^"\\])*"` and `'(''|\\'|\\[^']|[^'\\])*'`, with no setting that turns the
  // escape off. `SELECT 'it\'s' AS a` and `SELECT 'it''s' AS a` both answer `it's`, and `SELECT "it\"s" AS a` answers
  // `it"s`.
  backslashAlwaysEscapes: true,
  // The escaped identifier token is `` `((``|\\`)|\\[^`]|[^`\\])*` ``: `SELECT "a" AS \`x\\\`y\`` and
  // `SELECT "a" AS \`x\`\`y\`` both answer a field named x`y.
  backtickBackslashEscapes: true,
  // The line comment token is `--[^\n\r]*`: `SELECT 1 AS a -- note<CR>, 2 AS b` answers both columns, and so does
  // `SELECT 1 AS a -- note \<LF>, 2 AS b`, so a backslash continues nothing.
  lineCommentEndsAtCarriageReturn: true,
  // One statement per request and no procedural body: `SELECT 1 AS a; SELECT 2 AS b` is 3000 "syntax error ... at:
  // SELECT", and a function body is a string literal or a `{…}` expression with no `;` in it.
  script: DEFAULT_SQL_GRAMMAR.script,
  // Nothing follows the row bound: `select ::= select-term ( set-op select-term )* order-by-clause? limit-clause?
  // offset-clause?` (`dql.ebnf`), and `SELECT 1 AS a OFFSET 1 LIMIT 500` succeeds, so a bound after a lone OFFSET is
  // read too. `LIMIT NULL` and `LIMIT MISSING` are 5030 "Invalid LIMIT", so no value but a number is a bound.
  trailingLimitClauses: DEFAULT_SQL_GRAMMAR.trailingLimitClauses,
};

/** How Couchbase statement text is read: grammar, SQL text, redaction, update target and completion. */
export const COUCHBASE_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: COUCHBASE_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "none" },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
