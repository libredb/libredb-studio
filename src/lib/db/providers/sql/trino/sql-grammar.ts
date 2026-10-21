import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * Established the same way and for the same reason as the two search rows: the engine
 * IS an HTTP endpoint, so the grammar was asked directly rather than read off a
 * document. All four probes ran 2026-08-20 against Trino 476 through
 * `POST /v1/statement`, and every one of them is a statement rather than an inference.
 */
const TRINO_GRAMMAR: SqlGrammar = {
  // `#` opens NOTHING, in either position: `SELECT 1 AS a # trailing` is "line 1:15:
  // mismatched input '#'" and `SELECT # x` is "line 1:8: mismatched input '#'". So the
  // rest of the line is not hidden, which is the only thing the readers here ask.
  // Leaving it at the compatibility default would also make every `#` run AMBIGUOUS,
  // and since #297 an unreadable span is a confirmation PROMPT rather than silence -
  // a prompt on a statement this engine simply refuses.
  hash: "code",
  // A SUBSCRIPT, and both halves of that rule were measured rather than one inferred
  // from the other. It subscripts: `SELECT ARRAY[1,2][1]` answers 1. It NESTS:
  // `SELECT ARRAY[ARRAY[1,2],ARRAY[3,4]][1][2]` answers 2. And it is emphatically not
  // a name quote - `SELECT [customer] FROM tpch.sf1.nation` fails with "Column
  // 'customer' cannot be resolved", so the brackets were read THROUGH to an
  // expression, which the identifier reading could never do. Names here are quoted
  // with `"` (`identifier.ts` leaves this id on the standard default).
  bracket: "subscript",
  // FLAT: `SELECT /* a /* b */ 1 AS a` returns the column, so the first `*/` closed
  // the run. A nesting reader would have seen an unterminated comment and refused to
  // bound the statement.
  blockComment: "flat",
  // `SELECT q'{it''s}'` is "line 1:8: Unknown resolvedType: q" - the form does not
  // exist here, so those characters are a name followed by an ordinary string.
  alternateQuoting: false,
  // CODE, probed 2026-08-25 on 476: `SELECT 1 AS a // note` is "line 1:15: mismatched
  // input '/'", and the same text with a newline before a second column is the same
  // error at the same offset - so the slashes are refused where they stand rather
  // than hiding what follows.
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  script: DEFAULT_SQL_GRAMMAR.script,
  trailingLimitClauses: DEFAULT_SQL_GRAMMAR.trailingLimitClauses,
};

/** How Trino statement text is read: grammar, SQL text, redaction, update target and completion. */
export const TRINO_SQL_GRAMMAR: SqlGrammarSpec = {
  // `//` reads as CODE (476), refusing the characters where they stand; the probe is quoted on the constant above.
  grammar: TRINO_GRAMMAR,
  // True, and deliberately so: the editor text is the exact bytes `POST /v1/statement` receives, and the provider
  // extends `SQLBaseProvider`.
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: null },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
