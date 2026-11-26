/**
 * The SQL grammar registry is total over the type ids, each row is its declaration's SQL text composed with Studio's
 * grammar function table (docs/providers/CONTRACT.md, clause M-78), the no-connection spec answers `undefined`, and
 * every other value outside the `DatabaseType` union is refused by name (FND-1).
 */
import { describe, expect, test } from "bun:test";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { BUNDLED_SQL_TEXT } from "@/lib/db/engine-catalog/sql-text.generated";
import { servedEngineRecord } from "@/lib/db/server-catalog";
import { composeSqlGrammar, SQL_GRAMMAR, SQL_GRAMMAR_FUNCTIONS, sqlGrammarFor } from "@/lib/db/sql-grammar";
import { NO_CONNECTION_SQL_GRAMMAR } from "@/lib/db/sql-grammar/no-connection";
import type { SqlGrammarSpec } from "@/lib/db/sql-grammar/types";
import { DEFAULT_SQL_GRAMMAR } from "@libredb/provider-sdk/sql";
import type { DatabaseType } from "@/lib/types";
import { OUTSIDE_THE_UNION, refusalOf, refusalThrownBy } from "../../../helpers/outside-the-union";

const ALL_IDS = [...EXTERNAL_DATABASE_TYPES, "libredb"].sort();

describe("the SQL grammar registry", () => {
  test("has one row per type id and no other", () => {
    expect(Object.keys(SQL_GRAMMAR).sort()).toEqual(ALL_IDS);
    expect(Object.isFrozen(SQL_GRAMMAR)).toBe(true);
  });

  for (const id of ALL_IDS as DatabaseType[]) {
    test(`${id}'s row is its declaration's SQL text composed with Studio's grammar function table`, () => {
      expect(SQL_GRAMMAR[id]).toEqual(composeSqlGrammar(id, BUNDLED_SQL_TEXT[id], SQL_GRAMMAR_FUNCTIONS));
    });
  }

  test("the rows are pairwise distinct objects", () => {
    expect(new Set(Object.values(SQL_GRAMMAR)).size).toBe(ALL_IDS.length);
  });

  test("no two rows share a grammar object", () => {
    expect(new Set(Object.values(SQL_GRAMMAR).map((spec) => spec.grammar)).size).toBe(ALL_IDS.length);
    expect(Object.values(SQL_GRAMMAR).some((spec) => spec.grammar === NO_CONNECTION_SQL_GRAMMAR.grammar)).toBe(false);
  });

  test("sqlite and libsql state one grammar, with the confirmation forms of the INSERTs that replace rows", () => {
    // libSQL reads SQLite's grammar, so the two declarations state the same facts.
    expect(SQL_GRAMMAR.libsql.grammar).toEqual(SQL_GRAMMAR.sqlite.grammar);
    expect(SQL_GRAMMAR.sqlite.grammar.hash).toBe("code");
    expect(SQL_GRAMMAR.sqlite.grammar.bracket).toBe("quoted-identifier");
    expect(SQL_GRAMMAR.sqlite.grammar.script.blocks).toBe("trigger-body");
    // OR REPLACE is the one conflict algorithm that deletes a row already there; OR ROLLBACK, OR ABORT, OR FAIL and OR
    // IGNORE leave it (SQLite reference, "The ON CONFLICT Clause").
    expect(SQL_GRAMMAR.sqlite.grammar.confirmForms).toEqual([
      ["REPLACE", "INTO"],
      ["INSERT", "OR", "REPLACE"],
    ]);
    expect(SQL_GRAMMAR.sqlite.grammar.confirmCodeForms).toBeUndefined();
  });

  test("an absent type is the no-connection spec", () => {
    expect(sqlGrammarFor(undefined)).toBe(NO_CONNECTION_SQL_GRAMMAR);
  });

  test.each(OUTSIDE_THE_UNION)("sqlGrammarFor refuses %s by name", (_label, value) => {
    expect(refusalThrownBy(() => sqlGrammarFor(value as string))).toEqual(refusalOf(value));
  });

  // A redaction reader guessing where a literal ends can store the literal, so `sql` redaction needs text that IS
  // SQL and a grammar established for the engine, one whose declared facts are not the compatibility default's. The
  // redaction is the engine record's grant; the no-connection reading grants none.
  // Before the registry, `readerOf` refused both cases itself.
  test.each(Object.entries(SQL_GRAMMAR) as [DatabaseType, SqlGrammarSpec][])(
    "%s redacts as SQL only text it reads as SQL under its own grammar",
    (id, spec) => {
      if (servedEngineRecord(id).grants.redaction.kind !== "sql") return;
      expect(spec.readsSqlText).toBe(true);
      expect(spec.grammar).not.toEqual(DEFAULT_SQL_GRAMMAR);
    },
  );
});
