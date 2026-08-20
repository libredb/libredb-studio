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
 *   be discovered. Since #297 it can cost that statement a confirmation prompt as
 *   well, where the doubled bracket swallows the real closer and the run therefore
 *   never terminates (`SELECT [a]] FROM t`).
 * - `subscript` - an array literal or a subscript. It NESTS, nothing inside it is
 *   escaped, and a literal inside it is a literal. ClickHouse, PostgreSQL.
 *
 * The two are mutually exclusive rather than two spellings of one rule, which is
 * why this is a dialect fact and not something the text could settle: `['a]b']` is
 * a subscript whose key carries a close bracket under one reading and a name that
 * ends at that bracket under the other, and `[a]]b]` is one name under the first
 * and a closed run followed by junk under the second.
 */
export type BracketGrammar = "quoted-identifier" | "subscript";

/**
 * Where a block comment ENDS when a second `/*` is written inside it.
 *
 * - `flat` - the first `*\/` closes the run, whatever is inside it. MySQL,
 *   MariaDB, SQLite, Oracle.
 * - `nesting` - a `/*` inside a comment opens another one, so the run continues
 *   until the depth returns to zero. PostgreSQL, SQL Server, ClickHouse. A run
 *   short of a closer is then undeterminable rather than closed early, which costs
 *   a bound and asks for a confirmation instead of hiding a write.
 *
 * The two readings put the comment's end in different places, and everything
 * between the first `*\/` and the real end is either comment text or the
 * statement's own code depending on which one applies - so a `)` written there
 * either closes a CTE body or does not, and the keyword that types the statement
 * changes with it (#300).
 */
export type BlockCommentGrammar = "flat" | "nesting";

/** The grammar facts that differ between the engines this product supports. */
export interface SqlGrammar {
  readonly hash: HashGrammar;
  readonly bracket: BracketGrammar;
  readonly blockComment: BlockCommentGrammar;
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
  blockComment: "flat",
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
  blockComment: "flat",
  alternateQuoting: false,
};
const CLICKHOUSE_GRAMMAR: SqlGrammar = {
  hash: "comment",
  bracket: "subscript",
  blockComment: "nesting",
  alternateQuoting: false,
};
const POSTGRES_GRAMMAR: SqlGrammar = {
  hash: "code",
  bracket: "subscript",
  blockComment: "nesting",
  alternateQuoting: false,
};
const ORACLE_GRAMMAR: SqlGrammar = {
  hash: "code",
  bracket: DEFAULT_SQL_GRAMMAR.bracket,
  blockComment: "flat",
  alternateQuoting: true,
};
const MSSQL_GRAMMAR: SqlGrammar = {
  hash: "code",
  bracket: "quoted-identifier",
  blockComment: "nesting",
  alternateQuoting: false,
};
const SQLITE_GRAMMAR: SqlGrammar = {
  hash: "code",
  bracket: "quoted-identifier",
  blockComment: "flat",
  alternateQuoting: false,
};

/**
 * The two search engines and Trino are the rows here established by LIVE PROBE rather
 * than from documentation or a bundled driver: their SQL surfaces are HTTP endpoints
 * on a running cluster, so the grammar can be asked directly, and asking it beats
 * every other source. The search probes ran 2026-08-19 against Elasticsearch 9.1.4 and
 * OpenSearch 3.8.0, and they DISAGREE about two of the four facts - which is the
 * reason the one provider implementation still has two rows here. The Trino probes ran
 * 2026-08-20 against 476; that row sits below, after OpenSearch's.
 */
const ELASTICSEARCH_GRAMMAR: SqlGrammar = {
  // `#` opens NOTHING: `SELECT 1 # x` is a `parsing_exception`, "mismatched input
  // '#'", and so is `SELECT # x\n1`. So the rest of the line is not hidden, which is
  // the only thing the readers in this folder ask about. Reading it as a comment (the
  // compatibility default) would also leave every `#` run AMBIGUOUS
  // (`hashRunIsAmbiguous`), and since #297 an unreadable span is a confirmation
  // PROMPT rather than silence - a prompt on a statement this engine simply refuses.
  hash: "code",
  // NOT established, and left at the default deliberately. `[` has no meaning at all
  // in this grammar - `SELECT [1, 2]` and `SELECT [customer] FROM probe_orders` are
  // both "extraneous input '['" - so it is neither an identifier quote nor a
  // subscript, and PD-5 forbids reading one dialect's rule off another's. The name
  // reading can only cost a bound on a statement the engine refuses anyway, which is
  // the same fail-safe argument the `mysql` and `oracle` rows make.
  bracket: DEFAULT_SQL_GRAMMAR.bracket,
  // FLAT: `SELECT /* a /* b */ 1 AS a` answers 200 with the column, so the first
  // `*/` closed the run. A nesting reader would have seen an unterminated comment.
  blockComment: "flat",
  // `SELECT q'{it's}'` is a `parsing_exception` - the form does not exist here.
  alternateQuoting: false,
};
const OPENSEARCH_GRAMMAR: SqlGrammar = {
  // `#` really is a line comment, and this is where the fork's SQL plugin parts
  // company with Elasticsearch's. Three probes, because "the statement still ran" is
  // not enough to tell a comment from a token the parser ignored:
  //   `SELECT 1 AS a # , 2 AS b`         -> 200, ONE column: the rest was hidden.
  //   `SELECT 1 AS a # hidden\n, 2 AS b` -> 200, TWO columns: the run ended at the
  //                                         newline, so it is a LINE comment.
  //   `SELECT customer # FROM probe_orders` -> `SemanticCheckException`, "can't
  //                                         resolve … customer": the FROM was hidden.
  hash: "comment",
  // `[…]` is an identifier quote, MySQL/SQL-Server style: `SELECT [customer] FROM
  // probe_orders` answers the field's value, while `SELECT [1, 2]` is refused with
  // "All items between Brackets should be identifiers, got:LITERAL_INT". It has no
  // escape and does not nest - `[customer]]` and `[a[b]]` are both refused - which is
  // the SQLITE_GRAMMAR situation exactly: this reading's doubled-`]` allowance can
  // only swallow a closer in text the server rejects either way.
  bracket: "quoted-identifier",
  // FLAT, same probe and same answer as Elasticsearch.
  blockComment: "flat",
  // `SELECT q'{it's}'` is refused, "Illegal SQL expression".
  alternateQuoting: false,
};
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
};

/**
 * The established readings, one row per fact per dialect.
 *
 * A dialect absent from this table is at the compatibility default because its
 * rule was not established, NOT because it agrees with the default. Currently
 * absent: `couchbase`, `druid`, `libredb` and the non-SQL `mongodb`, `redis` -
 * whose providers never reach these readers on the QUERY path, though the
 * confirmation gate reads their editor text as SQL only where `readsSqlText` says
 * the text IS SQL, which for those two it does not (#297). Present for one fact and
 * undecided about another: `mysql` and `oracle` carry no established BRACKET
 * reading (see the row below), and `elasticsearch` carries none either - `[` is not
 * in its grammar at all.
 *
 * Sources, one per row, all offline or first-party documentation - except
 * `elasticsearch` and `opensearch`, whose rows were established by probing the
 * engines themselves (their SQL surface is an HTTP endpoint, so the grammar can be
 * asked rather than read about). The probes and their answers are quoted on the two
 * constants above, and the two products disagree about `#` and about `[…]`:
 *
 * - `mysql` - `#` to end of line is MySQL's and MariaDB's second comment form;
 *   this repo already skipped such a run in a statement's LEADING trivia before the
 *   record existed - `leading-keyword.ts` still does, on every dialect, and says
 *   why - and pins it in the MySQL provider suite (#275).
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
 * - Block comments, one source per dialect and every row established, so no
 *   dialect in this table is left undecided about this fact (#300):
 *   - `postgres` NESTS - the PostgreSQL manual's lexical-structure chapter (4.1.5
 *     Comments, postgresql.org/docs/current/sql-syntax-lexical.html; checked
 *     2026-08-05) says block comments nest "as specified in the SQL standard but
 *     unlike C", precisely so a region containing comments can be commented out.
 *   - `mssql` NESTS - "Slash Star (Block Comment) (Transact-SQL)"
 *     (learn.microsoft.com; checked 2026-08-05): nested comments are supported, a
 *     `/*` anywhere inside a comment starts a nested one, and a missing closer is
 *     an error. This is the row the report on #300 got wrong, which is why it was
 *     re-established rather than copied.
 *   - `clickhouse` NESTS - the ClickHouse SQL syntax reference
 *     (clickhouse.com/docs/sql-reference/syntax; checked 2026-08-05) states C-style
 *     comments can be nested and gives a nested example. Same caveat as its `#`
 *     row: reached over HTTP, so there is no driver artifact to check it against.
 *   - `mysql` is FLAT - the MySQL reference manual (11.7 Comments, dev.mysql.com;
 *     checked 2026-08-05) states nested comments are not supported and are
 *     deprecated. It adds that they "might be permitted" under some conditions and
 *     that users should avoid them, which is a reason to read the first `*\/` as
 *     the end rather than to guess at a second reading.
 *   - `sqlite` is FLAT, from the bundled amalgamation's own tokenizer: `case
 *     CC_SLASH` scans forward for the first `*\/` with no depth count at all.
 *   - `oracle` is FLAT - node-oracledb's tokenizer (`_parseMultiLineComment`)
 *     stops at the first `*\/`, and Oracle's PL/SQL Language Reference states that
 *     one multiline comment cannot contain another.
 *
 * - `postgres`, brackets - `expression[subscript]` extracts an element and
 *   `expression[lower:upper]` a slice (PostgreSQL manual 4.2.3 Subscripts), and
 *   array constructors nest: the manual's own example is
 *   `SELECT ARRAY[[1,2],[3,4]]` (4.2.12 Array Constructors, which also notes the
 *   inner `ARRAY` keyword may be omitted). Identifiers there are quoted with double
 *   quotes (4.1.1), so `[` is never a name quote in this dialect.
 *
 * NOT established, and therefore left at the default: how `mysql` and `oracle` read
 * `[…]`. It is not an identifier quote in either - MySQL gives it no meaning outside
 * a JSON path written inside a string, and Oracle none outside an alternate-quote
 * delimiter - but neither has a SUBSCRIPT rule to read it under instead, and PD-5
 * forbids reading one dialect's rule off another's. The name reading costs them a
 * bound on a nested bracket run, and it can never misplace one: a run it cannot
 * close is undeterminable, and an undeterminable end is not cut. That is the
 * fail-safe direction, so it is what they keep.
 *
 * PostgreSQL was briefly left there too, and the cost is why it is not: an
 * undeterminable run is also text the confirmation gate cannot read, and since #297
 * that gate ASKS rather than staying silent - so `ARRAY[[1,2],[3,4]]` and
 * `j['a]b']`, everyday reads in this dialect, both lost their bound AND prompted
 * before running. A confirmation an operator learns to click through protects
 * nothing, so a false prompt on everyday syntax is not the cheap direction it looks
 * like. The rule was established from the manual rather than the cost being
 * accepted. Pinned in `tests/components/QuerySafetyDialog.test.tsx` and the
 * PostgreSQL provider suite, and documented in `docs/providers/postgres.md`.
 */
const SQL_GRAMMARS: Partial<Record<DatabaseType, SqlGrammar>> = {
  mysql: MYSQL_GRAMMAR,
  clickhouse: CLICKHOUSE_GRAMMAR,
  postgres: POSTGRES_GRAMMAR,
  oracle: ORACLE_GRAMMAR,
  mssql: MSSQL_GRAMMAR,
  sqlite: SQLITE_GRAMMAR,
  elasticsearch: ELASTICSEARCH_GRAMMAR,
  opensearch: OPENSEARCH_GRAMMAR,
  trino: TRINO_GRAMMAR,
};

/**
 * The grammar to read a statement of this dialect with.
 *
 * `Object.hasOwn` rather than a bare lookup: since #297 the packaged confirmation
 * dialog resolves its own grammar from an optional prop a HOST application supplies
 * as a plain string, and a prototype key (`"constructor"`, `"toString"`) would
 * otherwise return something that is not a grammar at all instead of falling to the
 * default.
 */
export function resolveSqlGrammar(type?: DatabaseType): SqlGrammar {
  if (type === undefined || !Object.hasOwn(SQL_GRAMMARS, type)) return DEFAULT_SQL_GRAMMAR;
  return SQL_GRAMMARS[type] ?? DEFAULT_SQL_GRAMMAR;
}

/**
 * The dialects whose query text is not SQL at all.
 *
 * MongoDB takes a JSON document and Redis a command line, and neither reaches the
 * readers in this folder on the QUERY path - their providers extend
 * `BaseDatabaseProvider` and never call `prepareQuery`. They reach the confirmation
 * gate, though, because both execution paths ask about whatever is in the editor
 * before running it (#297).
 *
 * `trino` is deliberately absent for the same reason as the two search ids: the editor
 * text is the exact bytes `POST /v1/statement` receives, and the provider extends
 * `SQLBaseProvider`.
 *
 * `elasticsearch` and `opensearch` are deliberately ABSENT: their editor text is SQL
 * (measured - both answer `POST`ed statements with columns and rows, and both
 * providers extend `SQLBaseProvider` and call `prepareQuery`). Listing them here
 * would switch the SQL checks off for text that IS SQL, which is the mirror of the
 * defect this set exists to fix: the confirmation gate would stop reading a statement
 * it can read, and an unreadable statement's spans are what tell it a write is
 * hiding behind a comment. The other direction is the one #297 measured - reading
 * non-SQL as SQL prompted on ordinary reads - so a wrong answer here costs either a
 * gate that never asks or a gate an operator learns to click through.
 */
const NON_SQL_DIALECTS: ReadonlySet<DatabaseType> = new Set<DatabaseType>(["mongodb", "redis"]);

/**
 * Whether this dialect's query text is SQL - the question BEFORE which SQL grammar
 * to read it under.
 *
 * `resolveSqlGrammar` has an answer for every input, so without this a Mongo
 * document or a Redis command is simply read as SQL under the compatibility
 * grammar. For a reader that only ever declines to act, that costs nothing. For the
 * confirmation gate it cost a false prompt on ordinary reads: the escaped quote in
 * `{"filter":{"msg":"say \"hi\""}}` or in `SET k "a\"b"` is an unresolvable literal
 * to a SQL span reader and a perfectly closed one in the grammar the text is
 * actually written in - and the dialog then said the statement could not be read
 * about text that reads fine. An operator who learns to click the confirmation away
 * is the one thing that gate cannot survive.
 *
 * Unknown and absent both answer true, which keeps every existing caller and any
 * host application passing an unrecognised string on today's reading rather than
 * silently switching the SQL checks off.
 */
export function readsSqlText(type?: DatabaseType): boolean {
  return type === undefined || !NON_SQL_DIALECTS.has(type);
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
