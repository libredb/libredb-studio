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
  // A locking clause follows the row bound in both engines' SELECT grammar
  // (MySQL 8 SELECT: LIMIT ... FOR UPDATE | FOR SHARE [OF tbl[, tbl]]
  // [NOWAIT | SKIP LOCKED], plus the LOCK IN SHARE MODE spelling; MariaDB adds
  // WAIT n), so the bound the limiter writes must stand BEFORE it (#1981).
  // Declaring the tails here gives them the same strip/re-attach path
  // Materialize's `AS OF` and ScyllaDB's `BYPASS CACHE` use (#1398): the run
  // comes off the end, the bound is written, the run is re-attached verbatim -
  // and a bound that already stands before one reads as the statement's own
  // instead of inviting a second one past the clause.
  //
  // Each pattern eats ONE clause of the run, so a statement carrying several -
  // `FOR SHARE OF t1 FOR UPDATE OF t2` - keeps them in the order they were
  // written. `SKIP LOCKED`, `NOWAIT`, `WAIT n` and the OF list are options OF
  // THE CLAUSE, not clauses of their own: a pattern that peeled `SKIP LOCKED`
  // off separately would re-attach it before `FOR UPDATE`.
  //
  // A name in the OF list is a bare token, a backtick-quoted identifier or a
  // double-quoted one - the quoted forms are the only way a name carries a
  // space, and MySQL escapes a quote inside them by doubling it. The bare token
  // excludes quotes, brackets and commas, so a closing quote can never ride on
  // a name: a literal or a backticked identifier that merely ENDS in the clause
  // words (`WHERE note = "x FOR UPDATE OF t"`) fails the pattern's `\s*$` after
  // the name, the tail is not stripped, and the bound keeps its place at the
  // end rather than landing inside the quoted text. A `)` is excluded for the
  // same reason: a locking clause written inside a subquery is never the
  // statement's own tail.
  trailingLimitClauses: [
    /\s+FOR\s+(?:UPDATE|SHARE)(?:\s+OF\s+(?:`(?:[^`]|``)*`|"(?:[^"]|"")*"|[^\s()',;"`]+)(?:\s*,\s*(?:`(?:[^`]|``)*`|"(?:[^"]|"")*"|[^\s()',;"`]+))*)?(?:\s+(?:NOWAIT|SKIP\s+LOCKED|WAIT\s+\d+))?\s*$/i,
    /\s+LOCK\s+IN\s+SHARE\s+MODE(?:\s+(?:NOWAIT|SKIP\s+LOCKED|WAIT\s+\d+))?\s*$/i,
  ],
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
