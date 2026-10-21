import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

const ORACLE_GRAMMAR: SqlGrammar = {
  hash: "code",
  bracket: DEFAULT_SQL_GRAMMAR.bracket,
  blockComment: "flat",
  alternateQuoting: true,
  // Probed 2026-08-25 on Oracle Free through sqlplus: `SELECT 1 AS a // note FROM
  // dual` is ORA-00923, "FROM keyword not found where expected", with the caret under
  // the slashes. Nothing on that line is hidden.
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  // PL/SQL units and SQL*Plus's `/` line. Measured on 26ai Free 23.26.3 before the fact
  // existed: the procedure cut at its inner `;` was stored INVALID with PLS-00103, and the
  // unit is refused without the `;` after its `END`, so the splitter keeps that one.
  script: { blocks: "pl-sql", separatorLine: "/", unit: "statement" },
  trailingLimitClauses: DEFAULT_SQL_GRAMMAR.trailingLimitClauses,
};

/** Oracle's, and an ordinary column name on every other engine. */
const ORACLE_SET_OPERATORS: ReadonlySet<string> = new Set(["MINUS"]);

/** How Oracle statement text is read: grammar, SQL text, redaction, update target and completion. */
export const ORACLE_SQL_GRAMMAR: SqlGrammarSpec = {
  // `#`: node-oracledb's own SQL tokenizer (`lib/thin/statement.js`)
  // accepts `#` as an identifier character and opens comments on `--` and `/*`
  // only. The same tokenizer's `_parseQstring` is where the alternate-quoting
  // row comes from: a `'` preceded by `q`/`Q` opens a q-string, `[ ] { } ( ) < >`
  // are the paired delimiters, and any other character closes with itself. The
  // `nq'…'` spelling of the same form, for `NCHAR`/`NVARCHAR2`, and the same
  // delimiter-pairing rule are in Oracle's SQL Language Reference ("Literals" →
  // text literals, docs.oracle.com; checked 2026-08-05). The driver corroborates
  // the spelling behaviourally: its tokenizer opens a q-string at any `'` whose
  // previous character is `q`/`Q`, `nq'` included. No other dialect here has the
  // form, so Oracle is the only row that carries it.
  // Block comments are FLAT: node-oracledb's tokenizer (`_parseMultiLineComment`)
  // stops at the first `*\/`, and Oracle's PL/SQL Language Reference states that
  // one multiline comment cannot contain another.
  // `//` reads as CODE (Free, sqlplus), refusing the characters where they stand; the probe is quoted on the
  // constant above.
  // NOT established, and therefore left at the default: how `oracle` reads `[…]`. It is not an identifier quote -
  // Oracle gives it no meaning outside an alternate-quote delimiter - but there is no SUBSCRIPT rule to read it
  // under instead, and rule 2 of `src/lib/sql/grammar.ts` forbids reading one dialect's rule off another's
  // behaviour. The name reading costs it a bound on a nested bracket run, and it can never misplace one: a run it
  // cannot close is undeterminable, and an undeterminable end is not cut. That is the fail-safe direction, so it is
  // what it keeps.
  grammar: ORACLE_GRAMMAR,
  readsSqlText: true,
  // A double quote is a name under every session setting, the one quoted run a redacted statement keeps.
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: ORACLE_SET_OPERATORS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
