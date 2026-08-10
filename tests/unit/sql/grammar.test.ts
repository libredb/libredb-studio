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

  test.each<DatabaseType>(["mysql", "clickhouse", "postgres", "mssql", "sqlite"])(
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
  ])("%s closes a block comment the %s way", (type, blockComment) => {
    expect(resolveSqlGrammar(type).blockComment).toBe(blockComment);
  });

  test("the compatibility default does not nest block comments", () => {
    // Today's reading again: every fixture written for #275, #280, #287, #291 and
    // #294 calls these readers without a dialect, and `indexOf("*/")` is what they
    // were written against.
    expect(DEFAULT_SQL_GRAMMAR.blockComment).toBe("flat");
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
