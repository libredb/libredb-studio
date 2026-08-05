import { describe, test, expect } from "bun:test";
import { type BracketGrammar, DEFAULT_SQL_GRAMMAR, hashRunIsAmbiguous, resolveSqlGrammar } from "@/lib/sql/grammar";
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
  // - MySQL/MariaDB: `#` opens a line comment. The repo already encodes this in
  //   `leading-keyword.ts`'s trivia pattern and pins it in the MySQL provider
  //   suite (`# note\nSELECT …` is bounded), which is what #275 closed.
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

  test.each<DatabaseType>([
    "couchbase",
    "druid",
    "libredb",
    "mongodb",
    "redis",
  ])("%s is left at the compatibility default", (type) => {
    expect(resolveSqlGrammar(type)).toBe(DEFAULT_SQL_GRAMMAR);
  });

  test("a call that names no dialect gets the compatibility default", () => {
    expect(resolveSqlGrammar(undefined)).toBe(DEFAULT_SQL_GRAMMAR);
  });

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

  test.each<DatabaseType>([
    "mysql",
    "clickhouse",
    "postgres",
    "mssql",
    "sqlite",
  ])("%s does not read `q'…'` as a literal", (type) => {
    expect(resolveSqlGrammar(type).alternateQuoting).toBe(false);
  });

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

  test.each<[DatabaseType, BracketGrammar]>([
    ["mssql", "quoted-identifier"],
    ["sqlite", "quoted-identifier"],
    ["clickhouse", "subscript"],
  ])("%s reads `[…]` as %s", (type, bracket) => {
    expect(resolveSqlGrammar(type).bracket).toBe(bracket);
  });

  // A dialect established for ONE character can be undecided about another, so
  // the default is per fact rather than per dialect. `[` is not an identifier
  // quote in MySQL, PostgreSQL or Oracle and no authoritative reading of it was
  // established for them, so they keep the one they had.
  test.each<DatabaseType>([
    "mysql",
    "postgres",
    "oracle",
  ])("%s is left at the compatibility default for `[…]`", (type) => {
    expect(resolveSqlGrammar(type).bracket).toBe(DEFAULT_SQL_GRAMMAR.bracket);
  });

  test("the compatibility default reads `[…]` as a quoted name", () => {
    // Today's reading, kept for the same reason as the `#` row: it is what the
    // #291/#299 fixtures assert, and the corrupted-statement shape those closed
    // (`SELECT [a LIMIT 500--b] FROM t`) is what a code reading brings back.
    expect(DEFAULT_SQL_GRAMMAR.bracket).toBe("quoted-identifier");
  });
});

describe("hashRunIsAmbiguous", () => {
  test("is true only where the reading is the undecided one", () => {
    expect(hashRunIsAmbiguous(DEFAULT_SQL_GRAMMAR)).toBe(true);
    expect(hashRunIsAmbiguous(resolveSqlGrammar("mysql"))).toBe(false);
    expect(hashRunIsAmbiguous(resolveSqlGrammar("mssql"))).toBe(false);
  });
});
