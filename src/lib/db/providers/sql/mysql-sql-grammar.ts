import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * A quoted literal as an export file name or option value: single or double
 * quotes, a quote inside it doubled, a backslash escape pair taken whole
 * (String Literals, dev.mysql.com - both quote forms are strings while
 * `ANSI_QUOTES` is off, and a file name may carry either).
 */
const EXPORT_QUOTED = "(?:'(?:''|\\\\[\\s\\S]|[^'\\\\])*'|\"(?:\"\"|\\\\[\\s\\S]|[^\"\\\\])*\")";

/** An export option value: a quoted literal, or a hex/binary literal (LOAD DATA). */
const EXPORT_VALUE = `(?:${EXPORT_QUOTED}|0x[0-9a-f]+|x'[0-9a-f]*'|0b[01]+|b'[01]*')`;

/** A `CHARACTER SET` name: a bare word, a backticked name, or a quoted literal. */
const EXPORT_CHARSET = "(?:[A-Za-z0-9_]+|`(?:``|[^`])*`|" + EXPORT_QUOTED + ")";

/**
 * The INTO OUTFILE tail: the file name, one optional `CHARACTER SET`, one
 * optional FIELDS/COLUMNS block, one optional LINES block - the shapes the
 * parser grammar takes (sql_yacc.yy `into_destination`), not a wildcard. #2011.
 */
const MYSQL_OUTFILE_TAIL = new RegExp(
  "\\s+INTO\\s+OUTFILE\\s+" +
    EXPORT_QUOTED +
    "(?:\\s+(?:CHARACTER\\s+SET|CHAR\\s+SET|CHARSET)\\s+" +
    EXPORT_CHARSET +
    ")?" +
    "(?:\\s+(?:FIELDS|COLUMNS)(?:\\s+(?:TERMINATED\\s+BY|(?:OPTIONALLY\\s+)?ENCLOSED\\s+BY|ESCAPED\\s+BY)\\s+" +
    EXPORT_VALUE +
    ")+)?" +
    "(?:\\s+LINES(?:\\s+(?:STARTING|TERMINATED)\\s+BY\\s+" +
    EXPORT_VALUE +
    ")+)?" +
    "\\s*$",
  "i",
);

/** The INTO DUMPFILE tail: a file name and nothing after it (SELECT ... INTO). #2011. */
const MYSQL_DUMPFILE_TAIL = new RegExp("\\s+INTO\\s+DUMPFILE\\s+" + EXPORT_QUOTED + "\\s*$", "i");

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
  // off separately would re-attach it before its `FOR UPDATE`.
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
  //
  // The file-writing INTO tails follow the row bound too (#2011): INTO
  // OUTFILE/DUMPFILE (and the export options after the file name) stand after
  // the select list, WHERE, ORDER BY and LIMIT (SELECT ... INTO, dev.mysql.com;
  // the end position is the preferred one, the position before a locking clause
  // is deprecated but accepted, so a statement may carry both orders and the
  // strip re-attaches whichever order it finds). The file name is a quoted
  // literal - single or double quotes, a quote inside it doubled, a backslash
  // escape pair taken whole - and the export options are the CLOSED set the
  // parser grammar spells (sql_yacc.yy: one `CHARACTER SET`, one FIELDS/COLUMNS
  // block of TERMINATED/ENCLOSED/ESCAPED BY, one LINES block of
  // STARTING/TERMINATED BY; the values are quoted literals or hex/binary
  // literals). The closed set is what keeps a mid-statement `INTO` (`SELECT a
  // INTO OUTFILE '/x' FROM t`, the position before FROM the docs also allow)
  // from matching: the words after the file name are not the option set, and
  // the pattern is end-anchored anyway. A second FIELDS block or a FIELDS after
  // LINES is a syntax error on the server, not a tail to strip: the pattern
  // leaves it where it stands and the engine reports the writer's own error.
  // DUMPFILE takes no options (SELECT ... INTO, dev.mysql.com). A match that
  // starts inside a comment or a literal is refused by the strip
  // (`matchStartsInNonCode` in query-limiter.ts), so words a statement merely
  // mentions never come off as a tail; and a `)` outside a quoted value ends
  // the option set the same way it ends a name everywhere else: an INTO written
  // inside a subquery is never the statement's own tail. Forms without a space
  // before the quote (`OUTFILE'/x'`) and a comment between INTO and OUTFILE are
  // known gaps: they are left where they stand, which is the bound-at-the-end
  // placement of today rather than a new corruption.
  trailingLimitClauses: [
    /\s+FOR\s+(?:UPDATE|SHARE)(?:\s+OF\s+(?:`(?:[^`]|``)*`|"(?:[^"]|"")*"|[^\s()',;"`]+)(?:\s*,\s*(?:`(?:[^`]|``)*`|"(?:[^"]|"")*"|[^\s()',;"`]+))*)?(?:\s+(?:NOWAIT|SKIP\s+LOCKED|WAIT\s+\d+))?\s*$/i,
    /\s+LOCK\s+IN\s+SHARE\s+MODE(?:\s+(?:NOWAIT|SKIP\s+LOCKED|WAIT\s+\d+))?\s*$/i,
    MYSQL_OUTFILE_TAIL,
    MYSQL_DUMPFILE_TAIL,
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
