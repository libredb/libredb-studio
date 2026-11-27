import { describe, expect, test } from "bun:test";
import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";
import { type GateGrants, rowDecidesAlone, rowNamesAsked, rowTypedAsk } from "@/lib/db/statement-language-row";
import type { TypedConfirmationAsk } from "@/lib/db/types";
import { type ConfirmationVerdict, confirmationVerdict } from "@/lib/editor/statement-analysis";
import type { StatementReading } from "@/lib/sql/dangerous-query";
import { grammarFromFacts } from "@/lib/db/sql-grammar";
import type { GrammarFacts } from "@libredb/provider-sdk/manifest";
import { admittedManifest } from "../../helpers/package-catalog";

/** The engine whose reading the gate is handed, by its id: no engine Studio ships, so no type is ever read for it. */
const ENGINE = "acmerow";

/** The grammar the minimal manifest declares, composed as the server catalog composes a package engine's. */
const grammar = grammarFromFacts(
  (admittedManifest(ENGINE).engines[0] as { sqlText: { grammar: GrammarFacts } }).sqlText.grammar,
);

/** A row whose reader answers `names` for every text, asking about `asked`, with `fields` beside them. */
function row(
  names: readonly string[] | undefined,
  asked: readonly string[],
  fields: Partial<DestructiveVocabulary> = {},
): DestructiveVocabulary {
  return { operations: new Set(asked), read: () => names, decidesAlone: false, ...fields };
}

describe("a statement language row's readers", () => {
  test("a row's named operations and typed ask are read from the row alone, and none for no row", () => {
    // A reader that names a listed operation asks; one that names only others runs, as does one that names none.
    expect(rowNamesAsked(row(["drop"], ["drop"]), "anything")).toBe(true);
    expect(rowNamesAsked(row(["read", "drop"], ["drop"]), "anything")).toBe(true);
    expect(rowNamesAsked(row(["read"], ["drop"]), "anything")).toBe(false);
    expect(rowNamesAsked(row([], ["drop"]), "anything")).toBe(false);
    // A reader that cannot tell what would run asks.
    expect(rowNamesAsked(row(undefined, []), "anything")).toBe(true);
    // No row asks about nothing: the engine's statements are read as SQL, or not at all.
    expect(rowNamesAsked(null, "anything")).toBe(false);

    // The reader is handed the statement as it was written.
    const seen: string[] = [];
    const reading: DestructiveVocabulary = {
      operations: new Set(),
      read: (text) => {
        seen.push(text);
        return [];
      },
      decidesAlone: false,
    };
    rowNamesAsked(reading, "  del /a  ");
    expect(seen).toEqual(["  del /a  "]);

    const ask: TypedConfirmationAsk = { type: "text", text: "/a" };
    const asking = row([], [], { typedConfirmation: (text) => (text === "del /a" ? ask : undefined) });
    expect(rowTypedAsk(asking, "del /a")).toBe(ask);
    expect(rowTypedAsk(asking, "get /a")).toBeUndefined();
    expect(rowTypedAsk(row([], []), "del /a")).toBeUndefined();
    expect(rowTypedAsk(null, "del /a")).toBeUndefined();
  });

  test("a data row's decidesAlone counts only where the engine's grants grant it", () => {
    // A row shaped as M-86's one reader kind compiles: no operation, a reader that names none, and the claim that it
    // is the gate's whole answer.
    const data = row([], [], { decidesAlone: true });
    const reading = (grants: GateGrants): StatementReading => ({
      engine: ENGINE,
      row: data,
      grammar,
      grants,
      explainReading: "either",
    });
    const verdict = (sql: string, grants: GateGrants) => [sql, confirmationVerdict(sql, reading(grants), "Keys")];
    const runs = (sql: string): [string, ConfirmationVerdict] => [sql, { decision: "run" }];
    const asks = (sql: string, unreadable = false): [string, ConfirmationVerdict] => [
      sql,
      { decision: "confirm", unreadable, typedConfirmation: null },
    ];

    // Granted, with the text-not-SQL claim beside it: the row is the whole answer, so a SQL write, a run that never
    // closes and a write in a later statement all run.
    const granted: GateGrants = {
      reviewedGrammar: true,
      readsSqlText: false,
      confirmExemptForms: [],
      decidesAlone: true,
    };
    expect(rowDecidesAlone(data, granted)).toBe(true);
    for (const sql of ["DELETE FROM t", "SELECT 'a", "SELECT 1; DROP TABLE x"]) {
      expect(verdict(sql, granted)).toStrictEqual(runs(sql));
    }

    // Not granted: the claim is read as if the row had not made it, so the SQL reading stays in front of the row.
    const ungranted: GateGrants = {
      reviewedGrammar: true,
      readsSqlText: true,
      confirmExemptForms: [],
      decidesAlone: false,
    };
    expect(rowDecidesAlone(data, ungranted)).toBe(false);
    expect(verdict("DELETE FROM t", ungranted)).toStrictEqual(asks("DELETE FROM t"));
    expect(verdict("SELECT 'a", ungranted)).toStrictEqual(asks("SELECT 'a", true));
    expect(verdict("SELECT 1", ungranted)).toStrictEqual(runs("SELECT 1"));

    // A row that does not claim it is never read as deciding alone, whatever the grants grant.
    expect(rowDecidesAlone(row([], []), granted)).toBe(false);
    expect(rowDecidesAlone(null, granted)).toBe(false);

    // No register row reviewed the grammar: every statement asks, and none is read, granted claim or not.
    for (const decidesAlone of [true, false]) {
      const unreviewed: GateGrants = {
        reviewedGrammar: false,
        readsSqlText: true,
        confirmExemptForms: [],
        decidesAlone,
      };
      for (const sql of ["SELECT 1", "", "DELETE FROM t"]) {
        expect([decidesAlone, ...verdict(sql, unreviewed)]).toStrictEqual([decidesAlone, ...asks(sql)]);
      }
    }
  });
});
