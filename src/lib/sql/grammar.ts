/**
 * Which grammar the readers in this folder are reading.
 *
 * Every reader here answers a question about a statement's STRUCTURE from
 * characters alone, and a handful of those characters mean different things in
 * different engines. Where they do, a reader with no dialect has to take one
 * engine's side, and taking the wrong one moves where a construct ends: a `)`
 * that closes a CTE body, a comment that hides a bound, a keyword that types the
 * statement. `operative-keyword.ts` records what that costs - a statement that
 * WRITES typed as a read, and a row bound then appended to it, which on
 * PostgreSQL and MySQL commits part of the write (#287).
 *
 * The dialect was always available at the callers - every provider knows its own
 * `type`, the multi-statement route resolves its provider before it asks, and
 * both client-side execution paths hold the active connection - so this module
 * threads information that already exists rather than inferring it from the text
 * (#292).
 *
 * Two rules keep this from becoming the type-switching this project bans
 * ("no `=== 'mongodb'` type-checks outside provider classes - drive behaviour
 * through capabilities"):
 *
 * 1. **Exactly one place maps a database type to grammar facts** - the table
 *    below. Readers receive the resolved record and never see a type id, so no
 *    reader can grow a dialect test of its own.
 * 2. **A fact that could not be established from an authoritative source is not
 *    guessed.** It stays at the compatibility default, and which dialects are
 *    there is stated (in `docs/editor/query-optimization.md`) rather than
 *    implied. Never read one dialect's rule off another's behaviour.
 */

import type { DatabaseType } from "@/lib/types";

/**
 * What a `#` opens.
 *
 * - `comment` - it opens a line comment, always. MySQL, MariaDB, ClickHouse.
 * - `code` - it never opens one; it is an operator character, part of an
 *   identifier, or a variable prefix. PostgreSQL, Oracle, SQL Server, SQLite.
 * - `comment-unless-operator` - the compatibility default, and neither of the
 *   honest readings: a comment unless the next character makes a PostgreSQL
 *   jsonb/geometric operator. It is what this folder did before the dialect
 *   reached it, and it is kept exactly so that a call naming no dialect answers
 *   what it always answered.
 */
export type HashGrammar = "comment" | "code" | "comment-unless-operator";

/**
 * What a `[…]` run is.
 *
 * - `quoted-identifier` - everything between the brackets is a NAME and the run
 *   does not nest. SQL Server, SQLite. The doubled `]` this reading honours is SQL
 *   SERVER's escape; SQLite's own tokenizer stops at the first `]` and has no
 *   escape at all, so this reads `[a]]b]` as one name where SQLite reads `[a]`
 *   followed by junk. SQLite rejects that text either way, so the longer reading
 *   can only cost a bound on a statement the server refuses - the fail-safe
 *   direction, pinned by a test in the SQLite provider suite rather than left to
 *   be discovered.
 * - `subscript` - an array literal or a subscript. It NESTS, nothing inside it is
 *   escaped, and a literal inside it is a literal. ClickHouse.
 *
 * The two are mutually exclusive rather than two spellings of one rule, which is
 * why this is a dialect fact and not something the text could settle: `['a]b']` is
 * a subscript whose key carries a close bracket under one reading and a name that
 * ends at that bracket under the other, and `[a]]b]` is one name under the first
 * and a closed run followed by junk under the second.
 */
export type BracketGrammar = "quoted-identifier" | "subscript";

/** The grammar facts that differ between the engines this product supports. */
export interface SqlGrammar {
  readonly hash: HashGrammar;
  readonly bracket: BracketGrammar;
  /**
   * Whether `q'…'` opens a string literal - Oracle's alternate quoting.
   *
   * Not a disagreement about a character like `hash` is, but a form ONE dialect
   * has: `q'{it's}'` is how Oracle writes a literal carrying apostrophes without
   * doubling them, and everywhere else those characters really are a name
   * followed by an ordinary string. So the fact is whether the reader has the
   * form at all, and reading it where the dialect does not have it would take a
   * literal out of ordinary code.
   */
  readonly alternateQuoting: boolean;
}

/**
 * What a call that names no dialect gets.
 *
 * Deliberately today's reading rather than a stricter "report undeterminable
 * wherever the dialects disagree". The strict default is the more honest one in
 * the abstract, but every fixture written for #275, #280, #287, #291 and #294
 * calls these readers without a dialect, and rewriting the meaning of that whole
 * suite in the same change that introduces the channel would leave nothing
 * pinning the old behaviour. Pinned by its own tests instead, so it is a decision
 * rather than an accident.
 */
export const DEFAULT_SQL_GRAMMAR: SqlGrammar = {
  hash: "comment-unless-operator",
  bracket: "quoted-identifier",
  alternateQuoting: false,
};

/**
 * One constant per dialect, and a fact spelled `DEFAULT_SQL_GRAMMAR.<fact>` is one
 * this table could not establish for that dialect. The default is therefore per
 * FACT, not per dialect: a dialect whose `#` rule is known can still be undecided
 * about its brackets, and writing the default's own value there is what keeps that
 * visible in the code rather than only in the doc.
 */
const MYSQL_GRAMMAR: SqlGrammar = {
  hash: "comment",
  bracket: DEFAULT_SQL_GRAMMAR.bracket,
  alternateQuoting: false,
};
const CLICKHOUSE_GRAMMAR: SqlGrammar = { hash: "comment", bracket: "subscript", alternateQuoting: false };
const POSTGRES_GRAMMAR: SqlGrammar = {
  hash: "code",
  bracket: DEFAULT_SQL_GRAMMAR.bracket,
  alternateQuoting: false,
};
const ORACLE_GRAMMAR: SqlGrammar = {
  hash: "code",
  bracket: DEFAULT_SQL_GRAMMAR.bracket,
  alternateQuoting: true,
};
const MSSQL_GRAMMAR: SqlGrammar = { hash: "code", bracket: "quoted-identifier", alternateQuoting: false };
const SQLITE_GRAMMAR: SqlGrammar = { hash: "code", bracket: "quoted-identifier", alternateQuoting: false };

/**
 * The established readings, one row per fact per dialect.
 *
 * A dialect absent from this table is at the compatibility default because its
 * rule was not established, NOT because it agrees with the default. Currently
 * absent: `couchbase`, `druid`, `libredb` (and the non-SQL `mongodb`, `redis`,
 * whose providers never reach these readers). Present for one fact and undecided
 * about another: `mysql`, `postgres` and `oracle` carry no established BRACKET
 * reading (see the row below).
 *
 * Sources, one per row, all offline or first-party documentation:
 *
 * - `mysql` - `#` to end of line is MySQL's and MariaDB's second comment form;
 *   this repo already encodes it in `leading-keyword.ts`'s trivia pattern and
 *   pins it in the MySQL provider suite (#275).
 * - `clickhouse` - the ClickHouse SQL syntax reference
 *   (clickhouse.com/docs/sql-reference/syntax, "Comments", checked 2026-08-05)
 *   lists `#` and `#!` beside `--` as single-line comment forms. The only row
 *   here with no offline artifact to check - ClickHouse is reached over HTTP and
 *   has no driver package under `node_modules` - so it is named with its source
 *   and date rather than left implicit.
 * - `postgres` - PostgreSQL has exactly two comment forms, `--` and the block
 *   form; `#` is an operator character (`#>`, `#>>`, `#-` walk or delete a jsonb
 *   path, `#` is integer XOR).
 * - `oracle` - node-oracledb's own SQL tokenizer (`lib/thin/statement.js`)
 *   accepts `#` as an identifier character and opens comments on `--` and `/*`
 *   only. The same tokenizer's `_parseQstring` is where the alternate-quoting
 *   row comes from: a `'` preceded by `q`/`Q` opens a q-string, `[ ] { } ( ) < >`
 *   are the paired delimiters, and any other character closes with itself. The
 *   `nq'…'` spelling of the same form, for `NCHAR`/`NVARCHAR2`, and the same
 *   delimiter-pairing rule are in Oracle's SQL Language Reference ("Literals" →
 *   text literals, docs.oracle.com; checked 2026-08-05). The driver corroborates
 *   the spelling behaviourally: its tokenizer opens a q-string at any `'` whose
 *   previous character is `q`/`Q`, `nq'` included. No other dialect here has the
 *   form, so Oracle is the only row that carries it.
 * - `sqlite` - the SQLite amalgamation bundled with `better-sqlite3` classifies
 *   `#` as `CC_VARALPHA`, an alphabetic bind-variable prefix, and opens comments
 *   on `--` and `/*` only. The same tokenizer is where its BRACKET row comes from:
 *   `[` is `CC_QUOTE2`, "`[...]` style quoted ids", scanned to the first `]` -
 *   Microsoft-style identifiers, accepted for compatibility.
 * - `mssql` - `#name` and `##name` are local and global temp tables, which is
 *   ordinary T-SQL; the comment forms are `--` and the block form. `[name]` is a
 *   delimited identifier and a `]` inside one is written doubled, which is exactly
 *   what this repo's own quoter emits for the dialect (`src/lib/sql/identifier.ts`,
 *   pinned by the MSSQL provider suite's `escapeIdentifier` test).
 * - `clickhouse`, brackets - `[…]` is an array literal or a subscript there, and
 *   arrays nest (`Array(Array(T))` is a type). Source: the ClickHouse SQL reference
 *   (clickhouse.com/docs/sql-reference, the Array type and the `[]` operator,
 *   checked 2026-08-05); as with the `#` row there is no offline artifact, so the
 *   two halves are corroborated separately from inside this repo - that `[…]` is an
 *   array literal by the provider suite's own live-verified fixture
 *   (`WITH [1, 2, 3] AS arr SELECT arrayJoin(arr)`), and that it is NOT an
 *   identifier quote by `identifier.ts`, which quotes this dialect's names with the
 *   standard `"…"` form. The nesting half rests on the reference alone.
 *
 * NOT established, and therefore left at the default: how `mysql`, `postgres` and
 * `oracle` read `[…]`. It is not an identifier quote in any of the three -
 * PostgreSQL subscripts arrays and jsonb with it, MySQL gives it no meaning outside
 * a JSON path written inside a string, and Oracle none outside an alternate-quote
 * delimiter - but no first-party artifact for the SUBSCRIPT rule was established
 * here, and PD-5 forbids reading one dialect's rule off another's. The name reading
 * costs them a bound on a nested array or on a subscript key carrying a `]`, and it
 * can never misplace one: a run it cannot close is undeterminable, and an
 * undeterminable end is not cut. That is the fail-safe direction, so it is what
 * they keep.
 */
const SQL_GRAMMARS: Partial<Record<DatabaseType, SqlGrammar>> = {
  mysql: MYSQL_GRAMMAR,
  clickhouse: CLICKHOUSE_GRAMMAR,
  postgres: POSTGRES_GRAMMAR,
  oracle: ORACLE_GRAMMAR,
  mssql: MSSQL_GRAMMAR,
  sqlite: SQLITE_GRAMMAR,
};

/** The grammar to read a statement of this dialect with. */
export function resolveSqlGrammar(type?: DatabaseType): SqlGrammar {
  if (type === undefined) return DEFAULT_SQL_GRAMMAR;
  return SQL_GRAMMARS[type] ?? DEFAULT_SQL_GRAMMAR;
}

/**
 * Whether a `#` run this grammar read as a comment might be code in the dialect
 * actually meant.
 *
 * `statement-end.ts` asks, because it decides whether the statement may be CUT
 * there, and cutting on the wrong reading emits `SELECT * FROM LIMIT 500 #tmp`.
 * Only the compatibility default is ambiguous: the other two readings ARE the
 * dialect's answer, so there is nothing left to be wrong about.
 */
export function hashRunIsAmbiguous(grammar: SqlGrammar): boolean {
  return grammar.hash === "comment-unless-operator";
}
