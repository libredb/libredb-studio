import { describe, test, expect } from "bun:test";
import {
  type BlockCommentGrammar,
  type BracketGrammar,
  DEFAULT_SQL_GRAMMAR,
  hashRunIsAmbiguous,
  readsSqlText,
  resolveSqlGrammar,
} from "@/lib/sql/grammar";
import type { DatabaseType } from "@/lib/types";

/**
 * The one place a database type becomes a set of grammar facts (#292).
 *
 * This test pins the TABLE, not the implementation: every row below was
 * established from an authoritative source, and a row that was NOT established
 * has to stay at the compatibility default rather than be guessed from a
 * neighbouring dialect. Both halves are asserted, because "which dialects were
 * left undecided" is part of the answer this milestone owes its readers.
 */
describe("resolveSqlGrammar", () => {
  // ── `#`: established readings ────────────────────────────────────────────
  //
  // - MySQL/MariaDB: `#` opens a line comment. The repo already skipped such a run
  //   in a statement's LEADING trivia before this record existed - and still does,
  //   on every dialect, because none of them can open a statement with one - and it
  //   pins that in the MySQL provider suite (`# note\nSELECT …` is bounded), which
  //   is what #275 closed.
  // - ClickHouse: `#` and `#!` open a line comment (ClickHouse syntax reference).
  // - PostgreSQL: the only comment forms are `--` and `/* */`; `#` is an operator
  //   character (`#>`, `#-`, `##`, integer XOR).
  // - Oracle: node-oracledb's own SQL tokenizer (`lib/thin/statement.js`) accepts
  //   `#` as an identifier character and opens comments on `--` and `/*` only.
  // - SQLite: the bundled SQLite amalgamation classifies `#` as `CC_VARALPHA`
  //   (a bind-variable prefix, i.e. code) and opens comments on `--` and `/*`.

  test.each<[DatabaseType, "comment" | "code"]>([
    ["mysql", "comment"],
    ["clickhouse", "comment"],
    ["postgres", "code"],
    ["oracle", "code"],
    ["mssql", "code"],
    ["sqlite", "code"],
    // Trino, probed 2026-08-20 on 476: `#` opens nothing in either position.
    // `SELECT 1 AS a # trailing` is "line 1:15: mismatched input '#'" and
    // `SELECT # x` is "line 1:8: mismatched input '#'", so the rest of the line is
    // not hidden - which is the only thing the readers in this folder ask. Leaving it
    // at the compatibility default would ALSO make every `#` run ambiguous, and since
    // #297 an unreadable span is a confirmation PROMPT - on a statement the engine
    // simply refuses.
    ["trino", "code"],
    // Cassandra, probed 2026-08-20 on 5.0.9 through the native protocol, in three
    // positions: `… WHERE id = 1 # trailing` is "line 1:44 no viable alternative at
    // character '#'", `SELECT # x\n id …` is the same at 1:7, and even `SELECT id#a`
    // is refused - so `#` is not a comment marker, not an operator and not an
    // identifier character. It hides nothing, which is the only thing these readers
    // ask, and leaving it at the compatibility default would make every `#` run
    // ambiguous and prompt on a statement CQL refuses outright.
    ["cassandra", "code"],
  ])("%s reads `#` as %s", (type, hash) => {
    expect(resolveSqlGrammar(type).hash).toBe(hash);
  });

  // ── Dialects deliberately left undecided ────────────────────────────────
  //
  // No authoritative offline source was established for these, and guessing a
  // dialect's rule from a neighbouring one is exactly what this milestone forbids.
  // They keep today's reading, which costs them nothing they had.

  test.each<DatabaseType>(["couchbase", "druid", "libredb", "mongodb", "redis"])(
    "%s is left at the compatibility default",
    (type) => {
      expect(resolveSqlGrammar(type)).toBe(DEFAULT_SQL_GRAMMAR);
    },
  );

  test("a call that names no dialect gets the compatibility default", () => {
    expect(resolveSqlGrammar(undefined)).toBe(DEFAULT_SQL_GRAMMAR);
  });

  /**
   * A string that is not a database type at all gets the default too, prototype
   * keys included. The packaged confirmation dialog resolves its own grammar from an
   * optional prop a HOST application fills in as a plain string (#297), so this
   * lookup is reached with text nothing in this repo validated; a bare index would
   * answer `Object.prototype.constructor` for one of these - not a grammar.
   */
  test.each(["constructor", "toString", "hasOwnProperty", "not-a-database"])(
    "resolves %p to the compatibility default rather than a prototype value",
    (key) => {
      expect(resolveSqlGrammar(key as DatabaseType)).toBe(DEFAULT_SQL_GRAMMAR);
    },
  );

  test("the compatibility default is today's reading, not one of the honest two", () => {
    expect(DEFAULT_SQL_GRAMMAR.hash).toBe("comment-unless-operator");
  });

  // ── `q'…'`: Oracle's alternate quoting ──────────────────────────────────
  //
  // Unlike `#`, this fact is not two engines disagreeing about a character: only
  // Oracle has the form at all, so every other dialect's reading of that text is
  // "a name followed by an ordinary string". Established from node-oracledb's own
  // SQL tokenizer (`lib/thin/statement.js`, `_parseQstring`), which parses a `'`
  // preceded by `q`/`Q` as a q-string, and from Oracle's SQL Language Reference
  // for the delimiter pairing and the `nq'…'` spelling.

  test("oracle is the only dialect that reads `q'…'` as a literal", () => {
    expect(resolveSqlGrammar("oracle").alternateQuoting).toBe(true);
  });

  test.each<DatabaseType>(["mysql", "clickhouse", "postgres", "mssql", "sqlite", "trino", "cassandra"])(
    "%s does not read `q'…'` as a literal",
    (type) => {
      expect(resolveSqlGrammar(type).alternateQuoting).toBe(false);
    },
  );

  test("a call that names no dialect does not read the form either", () => {
    // The compatibility default: before the channel existed no reader here had a
    // branch for the form, so keeping it out is what keeps those answers still.
    expect(DEFAULT_SQL_GRAMMAR.alternateQuoting).toBe(false);
  });

  // ── `[…]`: two readings that cannot both apply (#295) ────────────────────
  //
  // - SQL Server: `[name]` is a delimited identifier and a `]` inside it is
  //   written doubled. This repo's own quoter emits exactly that
  //   (`src/lib/sql/identifier.ts`), and the MSSQL provider's
  //   `escapeIdentifier` is pinned on it.
  // - SQLite: the SQLite amalgamation bundled with `better-sqlite3` classifies
  //   `[` as `CC_QUOTE2` - "`[...]` style quoted ids", the Microsoft-style form -
  //   so it is a name there too.
  // - ClickHouse: `[…]` is an array literal or a subscript, it NESTS, and it has
  //   no doubling escape; identifiers there are quoted with backticks or double
  //   quotes (`identifier.ts` falls back to the standard form for it). So the two
  //   readings are mutually exclusive rather than two spellings of one rule.
  // - PostgreSQL: `expression[subscript]` and `expression[lower:upper]` are how it
  //   reads an element and a slice (manual 4.2.3 Subscripts), and array
  //   constructors nest - the manual's own example is `SELECT ARRAY[[1,2],[3,4]]`
  //   (4.2.12 Array Constructors). Identifiers there are quoted with double quotes
  //   (4.1.1), so `[` is never a name quote and the subscript reading is the only
  //   one the dialect has.
  test.each<[DatabaseType, BracketGrammar]>([
    ["mssql", "quoted-identifier"],
    ["sqlite", "quoted-identifier"],
    ["clickhouse", "subscript"],
    ["postgres", "subscript"],
    // Trino, probed on 476, and BOTH halves of the rule were measured rather than one
    // inferred from the other. It subscripts: `SELECT ARRAY[1,2][1]` answers 1. It
    // NESTS: `SELECT ARRAY[ARRAY[1,2],ARRAY[3,4]][1][2]` answers 2. And it is not a
    // name quote: `SELECT [customer] FROM tpch.sf1.nation` fails with "Column
    // 'customer' cannot be resolved" - the brackets were read THROUGH to an
    // expression, which the identifier reading could never do.
    ["trino", "subscript"],
    // Cassandra, probed on 5.0.9, and both halves measured. `[…]` is a TERM the
    // parser reads through, not a name quote: `SELECT [id] FROM probe.customers`
    // answers a column literally named `[id]` whose type is `list` and whose value is
    // `[1]` - a one-element list built from the column - while `SELECT [1, 2] …` is
    // refused with "Cannot infer type for term [1, 2] in selection clause", which is
    // a TYPING complaint about a term the parser had already read. It nests:
    // `SELECT [[id]]` answers `[[1]]`. And a `]` inside a string inside the brackets
    // does not end the run - `SELECT ['a]b']` reaches the same type-inference
    // complaint - which the identifier reading, stopping at the first `]`, could not
    // do. CQL also subscripts a collection for real (`m['k']`).
    ["cassandra", "subscript"],
  ])("%s reads `[…]` as %s", (type, bracket) => {
    expect(resolveSqlGrammar(type).bracket).toBe(bracket);
  });

  // A dialect established for ONE character can be undecided about another, so
  // the default is per fact rather than per dialect. `[` is not an identifier
  // quote in MySQL or Oracle either, but neither has a SUBSCRIPT rule to read it
  // under - MySQL gives the characters no meaning outside a JSON path written in a
  // string, Oracle none outside an alternate-quote delimiter - so no authoritative
  // reading was established for them and they keep the one they had.
  test.each<DatabaseType>(["mysql", "oracle"])("%s is left at the compatibility default for `[…]`", (type) => {
    expect(resolveSqlGrammar(type).bracket).toBe(DEFAULT_SQL_GRAMMAR.bracket);
  });

  test("the compatibility default reads `[…]` as a quoted name", () => {
    // Today's reading, kept for the same reason as the `#` row: it is what the
    // #291/#299 fixtures assert, and the corrupted-statement shape those closed
    // (`SELECT [a LIMIT 500--b] FROM t`) is what a code reading brings back.
    expect(DEFAULT_SQL_GRAMMAR.bracket).toBe("quoted-identifier");
  });

  // ── `/* … /* … */ … */`: where a block comment ENDS (#300) ────────────────
  //
  // The one grammar fact that moves the end of a construct the reader is
  // otherwise happy with: a second opener written inside a comment is either part
  // of the comment (so the run continues past the next `*/`) or it is nothing at
  // all (so the run ends there and everything after it is the statement's code).
  //
  // - PostgreSQL: block comments nest, "as specified in the SQL standard but
  //   unlike C" (PostgreSQL manual, 4.1.5 Comments).
  // - SQL Server: nested comments are supported - a `/*` anywhere inside a comment
  //   opens a nested one and needs its own `*/` (T-SQL "Slash Star (Block
  //   Comment)").
  // - ClickHouse: C-style comments can be nested (ClickHouse SQL syntax
  //   reference, which gives a nested example).
  // - MySQL/MariaDB: nested comments are NOT supported and are deprecated (MySQL
  //   reference manual, 11.7 Comments), so the first `*/` ends the run.
  // - SQLite: the bundled amalgamation's tokenizer (`case CC_SLASH`) scans for the
  //   first `*/` with no depth count at all.
  // - Oracle: node-oracledb's own tokenizer (`_parseMultiLineComment`) stops at the
  //   first `*/`, and Oracle's PL/SQL reference states one multiline comment
  //   cannot contain another.

  test.each<[DatabaseType, BlockCommentGrammar]>([
    ["postgres", "nesting"],
    ["mssql", "nesting"],
    ["clickhouse", "nesting"],
    ["mysql", "flat"],
    ["sqlite", "flat"],
    ["oracle", "flat"],
    // Trino, probed on 476: `SELECT /* a /* b */ 1 AS a` returns the column, so the
    // FIRST `*/` closed the run. A nesting reader would have seen an unterminated
    // comment and refused to bound the statement.
    ["trino", "flat"],
    // Cassandra, probed on 5.0.9: `SELECT /* a /* b */ id FROM probe.customers WHERE
    // id = 1` returns the row, so the FIRST `*/` closed the run. A nesting reader
    // would have seen an unterminated comment and refused to bound the statement.
    ["cassandra", "flat"],
  ])("%s closes a block comment the %s way", (type, blockComment) => {
    expect(resolveSqlGrammar(type).blockComment).toBe(blockComment);
  });

  test("the compatibility default does not nest block comments", () => {
    // Today's reading again: every fixture written for #275, #280, #287, #291 and
    // #294 calls these readers without a dialect, and `indexOf("*/")` is what they
    // were written against.
    expect(DEFAULT_SQL_GRAMMAR.blockComment).toBe("flat");
  });

  // ── `//`: a THIRD line-comment form (S1 follow-up) ───────────────────────
  //
  // The one fact `grammar.ts` said it could not carry, and the splitter is where
  // that cost was live: `//` hides the rest of the line on TWO shipped engines, so
  // a `;` written inside such a comment is not a statement boundary - and
  // `/api/db/multi-query` RUNS every fragment the splitter returns, so the
  // dialect-blind reading manufactured a bare `DROP` out of text the server reads
  // as one statement. Every row below was probed 2026-08-25 against a live engine,
  // through the surface the provider itself uses, because "it is documented" is not
  // the same claim as "it is what the server does".
  //
  // A comment: two engines, and both halves measured rather than one inferred.
  //  - `cassandra` (Apache Cassandra 5.0.9 and ScyllaDB 2026.2.4, which shares this
  //    type-id, both over the native protocol):
  //    `SELECT release_version FROM system.local // note; DROP KEYSPACE nope\n`
  //    returns the ROW - one read - and the DROP does not run (a bare
  //    `DROP KEYSPACE nope` answers "Keyspace 'nope' doesn't exist", so the OK is
  //    proof it was hidden). Without the trailing newline the same text is "line
  //    1:68 mismatched character '<EOF>' expecting set null", which is the SECOND
  //    CQL fact - a line comment needs a newline to close it - and that one still
  //    has no field here (see `CASSANDRA_GRAMMAR`).
  //  - `clickhouse` (26.7.1, over HTTP): `SELECT 1 AS a // note; SELECT 999`
  //    answers `1` with no error, while `SELECT 1; DROP TABLE nope` is refused with
  //    "Syntax error (Multi-statements are not allowed)" - so the `;` was inside the
  //    comment rather than ignored. `SELECT 1 AS a // note\n, 2 AS b` answers TWO
  //    columns, so the run ends at the NEWLINE: it is a LINE comment, not a
  //    to-end-of-input one. Unlike CQL, end of input closes it (`SELECT 1 AS a //
  //    note` answers 1).
  //
  // Code: five engines plus SQLite, each refusing the characters outright, so
  // nothing on that line is hidden - which is the only thing these readers ask.
  //  - `postgres` (18): `SELECT 1 // 2` is "operator does not exist: integer //
  //    integer", so `//` is an OPERATOR NAME there, and `SELECT 1 AS a // note` is
  //    "syntax error at or near \"//\"".
  //  - `mysql` (26.7.0): ERROR 1064 near '// note'.
  //  - `oracle` (Oracle Free 23, via sqlplus): ORA-00923 "FROM keyword not found
  //    where expected".
  //  - `mssql` (2022, via sqlcmd): Msg 102 "Incorrect syntax near '/'".
  //  - `trino` (476, `POST /v1/statement`): "line 1:15: mismatched input '/'".
  //  - `sqlite` (the bundled driver): 'near "/": syntax error'.
  test.each<[DatabaseType, boolean]>([
    ["cassandra", true],
    ["clickhouse", true],
    ["postgres", false],
    ["mysql", false],
    ["oracle", false],
    ["mssql", false],
    ["trino", false],
    ["sqlite", false],
  ])("%s reads `//` as a line comment: %s", (type, doubleSlashComment) => {
    expect(resolveSqlGrammar(type).doubleSlashComment).toBe(doubleSlashComment);
  });

  // Neither search engine is reachable from this run, so neither row was
  // established - and PD-5 forbids reading one dialect's rule off another's, which
  // here would mean copying five refusals onto a sixth grammar. They keep the
  // compatibility default, and the direction that costs is stated rather than
  // implied: if `//` DOES open a comment in one of them, its splitter over-splits
  // exactly as `cassandra`'s did.
  test.each<DatabaseType>(["elasticsearch", "opensearch"])(
    "%s is left at the compatibility default for `//`",
    (type) => {
      expect(resolveSqlGrammar(type).doubleSlashComment).toBe(DEFAULT_SQL_GRAMMAR.doubleSlashComment);
    },
  );

  test("the compatibility default does not read `//` as a comment", () => {
    // Today's reading once more: no reader in this folder had a `//` branch before
    // this fact existed, so keeping it out is what leaves every dialect-less
    // fixture answering what it answered.
    expect(DEFAULT_SQL_GRAMMAR.doubleSlashComment).toBe(false);
  });
});

describe("hashRunIsAmbiguous", () => {
  test("is true only where the reading is the undecided one", () => {
    expect(hashRunIsAmbiguous(DEFAULT_SQL_GRAMMAR)).toBe(true);
    expect(hashRunIsAmbiguous(resolveSqlGrammar("mysql"))).toBe(false);
    expect(hashRunIsAmbiguous(resolveSqlGrammar("mssql"))).toBe(false);
  });
});

/**
 * Whether the query text is SQL at all - the question that comes BEFORE which SQL
 * grammar to read it under.
 *
 * `resolveSqlGrammar` answers the second question and has an answer for every
 * input, so a MongoDB document or a Redis command gets the compatibility grammar
 * and is then read as SQL. That is what the readers under `src/lib/sql/` do to
 * text no dialect here describes, and for the confirmation gate it produced a
 * prompt on ordinary reads: the escaped quote in a Mongo filter or a Redis value
 * is an unresolvable literal to a SQL span reader and a perfectly closed one in
 * the grammar the text is actually written in.
 *
 * Same shape as the grammar table and for the same reason: ONE place maps a
 * database type to the answer, so no reader grows a type test of its own.
 */
/**
 * The two maps below are the real checklist for a new provider, in the shape this
 * repo already uses for the other type-keyed tables (`PICKER_COVERAGE`,
 * `MODIFIED_COLUMN_COVERAGE`): a `Record<DatabaseType, …>` the compiler refuses to
 * accept until the new id is listed.
 *
 * Neither table in `grammar.ts` can enforce this on its own - `SQL_GRAMMARS` is a
 * `Partial<Record<…>>` because "absent" is a meaningful answer, and the non-SQL set
 * is a set. So a provider added without touching that file silently inherits the
 * compatibility grammar and is silently declared to write SQL, and nothing fails.
 * Deciding is mandatory; deciding "leave it at the default" is a fine decision.
 */
const GRAMMAR_COVERAGE: Record<DatabaseType, "established" | "default"> = {
  postgres: "established",
  mysql: "established",
  sqlite: "established",
  oracle: "established",
  mssql: "established",
  clickhouse: "established",
  // Established by live probe rather than from a document: their SQL surface is an
  // HTTP endpoint, so the grammar was asked directly (2026-08-19, Elasticsearch 9.1.4
  // and OpenSearch 3.8.0). They disagree about `#` (a line comment on OpenSearch, not
  // in Elasticsearch's grammar at all) and about `[…]` (an identifier quote on
  // OpenSearch, meaningless on Elasticsearch), which is why one provider
  // implementation still needs two rows.
  elasticsearch: "established",
  opensearch: "established",
  // Established the same way, and for the same reason: the coordinator IS the source.
  // Probed 2026-08-20 against Trino 476 - see the TRINO_GRAMMAR comments in
  // `grammar.ts` for the statement behind each of the four facts.
  trino: "established",
  // All four facts probed 2026-08-20 against Apache Cassandra 5.0.9 over the native
  // protocol, before any provider code existed. See CASSANDRA_GRAMMAR in
  // `grammar.ts` for the statement behind each one - and for the fifth fact this
  // record cannot hold: CQL has a THIRD comment form, `//`, and a line comment there
  // must be closed by a newline (at end of input it is a syntax error), which the
  // provider's own `prepareQuery` handles because no field here can express it.
  cassandra: "established",
  // No authoritative source was established for these, so they read as SQL under
  // the compatibility grammar. See the module doc in `grammar.ts`.
  couchbase: "default",
  druid: "default",
  libredb: "default",
  // Not SQL at all - see SQL_TEXT_COVERAGE below.
  mongodb: "default",
  redis: "default",
};

describe("every database type has a recorded grammar decision", () => {
  test.each(Object.entries(GRAMMAR_COVERAGE))("%s is %s", (type, expected) => {
    const isDefault = resolveSqlGrammar(type as DatabaseType) === DEFAULT_SQL_GRAMMAR;

    expect(isDefault ? "default" : "established").toBe(expected);
  });
});

const SQL_TEXT_COVERAGE: Record<DatabaseType, boolean> = {
  postgres: true,
  mysql: true,
  sqlite: true,
  oracle: true,
  mssql: true,
  clickhouse: true,
  couchbase: true,
  druid: true,
  libredb: true,
  // SQL, measured: both answer a POSTed statement with columns and positional rows,
  // and both providers extend SQLBaseProvider. Answering false here would switch the
  // confirmation gate's SQL reading off for text that is SQL.
  elasticsearch: true,
  opensearch: true,
  // SQL, and nothing but: the editor text is what goes to `POST /v1/statement`, and
  // the provider extends SQLBaseProvider.
  trino: true,
  // CQL is SQL-SHAPED and the answer here is about SHAPE, not about vocabulary. What
  // the editor holds is a statement built of SELECT/INSERT/UPDATE/DELETE keywords,
  // `'…'` literals with doubled quotes, `"…"` quoted names and `--` / `/* */`
  // comments - so the confirmation gate's span reader reads it correctly, and it is
  // exactly that reading which finds a write hidden behind a comment. The keywords
  // CQL LACKS (JOIN, OFFSET, EXPLAIN, subqueries - each measured as a syntax error on
  // 5.0.9) are a smaller vocabulary, not a different notation; answering false here
  // would switch the SQL checks off for text that is SQL, which is the mirror of the
  // defect #297 fixed.
  cassandra: true,
  mongodb: false,
  redis: false,
};

describe("readsSqlText", () => {
  test.each(Object.entries(SQL_TEXT_COVERAGE))("%s writes SQL: %s", (type, expected) => {
    expect(readsSqlText(type as DatabaseType)).toBe(expected);
  });

  test("a call that names no dialect is read as SQL", () => {
    // The compatibility default once more. A caller that named nothing was reading
    // SQL before this question existed, and the published dialog takes the type as
    // a plain string from a host application - an unrecognised one must not turn
    // the SQL checks off.
    expect(readsSqlText()).toBe(true);
    expect(readsSqlText("not-a-database" as DatabaseType)).toBe(true);
  });
});
