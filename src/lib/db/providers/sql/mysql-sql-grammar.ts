import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

const MYSQL_GRAMMAR: SqlGrammar = {
  hash: "comment",
  bracket: DEFAULT_SQL_GRAMMAR.bracket,
  blockComment: "flat",
  alternateQuoting: false,
  // Probed 2026-08-25 on 26.7.0: `SELECT 1 AS a // note` is ERROR 1064, "check the
  // manual … near '// note'". Nothing on that line is hidden.
  doubleSlashComment: false,
  // False although MySQL escapes with a backslash by default: `NO_BACKSLASH_ESCAPES` in
  // `sql_mode` turns that off per session, so the escape is not a fact of the dialect.
  backslashAlwaysEscapes: false,
  // NOT established. MySQL has compound statements (`CREATE PROCEDURE … BEGIN … END`), which
  // its own client cuts with `DELIMITER`, and no reading of them was measured here, so the
  // default stays and the gap is BACKLOG S7.
  script: DEFAULT_SQL_GRAMMAR.script,
  trailingLimitClauses: DEFAULT_SQL_GRAMMAR.trailingLimitClauses,
};

/** How MySQL statement text is read: grammar, SQL text, redaction, update target and completion. */
export const MYSQL_SQL_GRAMMAR: SqlGrammarSpec = {
  // `#` to end of line is MySQL's and MariaDB's second comment form;
  // this repo already skipped such a run in a statement's LEADING trivia before the
  // record existed - `leading-keyword.ts` still does, on every dialect, and says
  // why - and pins it in the MySQL provider suite (#275).
  // Block comments are FLAT: the MySQL reference manual (11.7 Comments, dev.mysql.com;
  // checked 2026-08-05) states nested comments are not supported and are
  // deprecated. It adds that they "might be permitted" under some conditions and
  // that users should avoid them, which is a reason to read the first `*\/` as
  // the end rather than to guess at a second reading.
  // `//` reads as CODE (26.7.0), refusing the characters where they stand; the probe is quoted on the constant above.
  // NOT established, and therefore left at the default: how `mysql` reads `[…]`. It is not an identifier quote -
  // MySQL gives it no meaning outside a JSON path written inside a string - but there is no SUBSCRIPT rule to read
  // it under instead, and rule 2 of `src/lib/sql/grammar.ts` forbids reading one dialect's rule off another's
  // behaviour. The name reading costs it a bound on a nested bracket run, and it can never misplace one: a run it
  // cannot close is undeterminable, and an undeterminable end is not cut. That is the fail-safe direction, so it is
  // what it keeps.
  grammar: MYSQL_GRAMMAR,
  readsSqlText: true,
  // A backtick is a name under every session setting. A double quote is a string unless `ANSI_QUOTES` is set, so it
  // is masked like any literal.
  redaction: { kind: "sql", nameQuote: "`" },
  // `--` opens a comment only before a space or a control character on MySQL and MariaDB; the reader's own test,
  // and the MariaDB 11.8.9 measurement behind it, sit beside its regex in `src/lib/sql/update-target.ts`.
  updateTarget: {
    dashCommentNeedsSeparator: true,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
