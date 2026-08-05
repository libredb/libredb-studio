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

/** The grammar facts that differ between the engines this product supports. */
export interface SqlGrammar {
  readonly hash: HashGrammar;
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
export const DEFAULT_SQL_GRAMMAR: SqlGrammar = { hash: "comment-unless-operator", alternateQuoting: false };

const COMMENT_HASH: SqlGrammar = { hash: "comment", alternateQuoting: false };
const CODE_HASH: SqlGrammar = { hash: "code", alternateQuoting: false };
const ORACLE_GRAMMAR: SqlGrammar = { hash: "code", alternateQuoting: true };

/**
 * The established readings, one row per fact per dialect.
 *
 * A dialect absent from this table is at the compatibility default because its
 * rule was not established, NOT because it agrees with the default. Currently
 * absent: `couchbase`, `druid`, `libredb` (and the non-SQL `mongodb`, `redis`,
 * whose providers never reach these readers).
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
 *   on `--` and `/*` only.
 * - `mssql` - `#name` and `##name` are local and global temp tables, which is
 *   ordinary T-SQL; the comment forms are `--` and the block form.
 */
const SQL_GRAMMARS: Partial<Record<DatabaseType, SqlGrammar>> = {
  mysql: COMMENT_HASH,
  clickhouse: COMMENT_HASH,
  postgres: CODE_HASH,
  oracle: ORACLE_GRAMMAR,
  mssql: CODE_HASH,
  sqlite: CODE_HASH,
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
