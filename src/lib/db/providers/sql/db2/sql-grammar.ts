import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * Db2 LUW, every fact probed 2026-10-03 on DB2/LINUXX8664 12.1.0.0 through db2-node 1.0.22, the
 * driver the provider sends statements with (#786).
 */
const DB2_GRAMMAR: SqlGrammar = {
  // CODE: `SELECT 1 AS a FROM SYSIBM.SYSDUMMY1 # note` and `SELECT 1 # 2 AS a FROM
  // SYSIBM.SYSDUMMY1` are both SQLCODE -104 at the `#`, so the rest of the line is not hidden.
  hash: "code",
  // Not established. `SELECT 1 AS [a] FROM SYSIBM.SYSDUMMY1` is SQLCODE -104, so it is no name
  // quote, but SQL PL writes an array element as `a[1]` and no subscript reading was measured in
  // plain SQL, so the fail-safe default stays, for the reason the MySQL and Oracle modules give for
  // their own brackets.
  bracket: DEFAULT_SQL_GRAMMAR.bracket,
  // NESTING: `SELECT 1 AS a /* a /* b */ FROM SYSIBM.SYSDUMMY1 */ FROM SYSIBM.SYSDUMMY1` answers
  // the row, and `SELECT 1 AS a /* a /* b */ FROM SYSIBM.SYSDUMMY1` is SQLCODE -104, so the inner
  // `*/` did not close the run. The flat default would read the text after it as code.
  blockComment: "nesting",
  // `SELECT q'[x]' AS a FROM SYSIBM.SYSDUMMY1` is SQLCODE -104.
  alternateQuoting: false,
  // `SELECT 1 AS a FROM SYSIBM.SYSDUMMY1 // note` is SQLCODE -104.
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  // No dollar-quoted literal: `$` is a name character, first one included. Measured 2026-11-20 on 12.1.0.0 through
  // db2-node: `col$a$x` and `y$a$z` are columns, and `SELECT $$a$$ FROM SYSIBM.SYSDUMMY1` is SQLCODE -206 naming
  // `$$A$$` as a column. Read as an opener, the `$a$` inside `col$a$x` hid a `;` and a DELETE up to the next such name.
  dollarQuotes: false,
  // SQL PL compound statements: `BEGIN [NOT ATOMIC | ATOMIC] … END` sent alone and as the body of `CREATE [OR REPLACE]
  // PROCEDURE | FUNCTION | TRIGGER` are one statement each. Measured 2026-11-20 on 12.1.0.0 through db2-node: each
  // runs sent whole, with or without the `;` after its `END`, and cut at its inner `;` the first fragment was SQLCODE
  // -104 (R3). One statement per request, and no separator line.
  script: { ...DEFAULT_SQL_GRAMMAR.script, blocks: "sql-pl" },
  trailingLimitClauses: DEFAULT_SQL_GRAMMAR.trailingLimitClauses,
};

/** How Db2 statement text is read: grammar, SQL text, redaction, update target and completion. */
export const DB2_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: DB2_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: null },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
