import { describe, expect, test } from "bun:test";
import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";
import { codeStatementLanguageRow } from "@/lib/db/destructive-commands";
import {
  type GateGrants,
  rowDecidesAlone,
  rowNamesAsked,
  rowRefusal,
  rowTextByteLimit,
  rowTypedAsk,
  statementLanguageRow,
} from "@/lib/db/statement-language-row";
import type { TypedConfirmationAsk } from "@/lib/db/types";
import { type ConfirmationVerdict, confirmationVerdict } from "@/lib/editor/statement-analysis";
import type { StatementReading } from "@/lib/sql/dangerous-query";
import { grammarFromFacts } from "@/lib/db/sql-grammar";
import type { GrammarFacts, StatementLanguageData } from "@libredb/provider-sdk/manifest";
import { ACME_LANGUAGE_DATA, admittedManifest } from "../../helpers/package-catalog";

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
  test("an engine's statement language row is its declared data where it declares some, Studio's code row for a legacy engine otherwise, and none for SQL", () => {
    // Declared data compiles to a frozen row of core's reader kind: its operations, a reader that names none for any
    // text, its claim that it is the gate's whole answer, and the bound and the safety analysis it states.
    const compiled = statementLanguageRow(ENGINE, ACME_LANGUAGE_DATA, null);
    if (compiled === null) throw new Error("declared data compiled to no row");
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.operations)).toBe(true);
    expect([...compiled.operations]).toEqual([]);
    for (const text of ["", "DELETE FROM t", "GET /a", "\u0000"]) expect(compiled.read(text)).toEqual([]);
    expect(Object.keys(compiled).sort()).toEqual([
      "decidesAlone",
      "maxTextBytes",
      "operations",
      "read",
      "safetyAnalysis",
    ]);
    expect([compiled.decidesAlone, compiled.safetyAnalysis, compiled.maxTextBytes]).toEqual([true, false, 4096]);
    expect(rowTextByteLimit(compiled)).toBe(4096);

    // The operations it lists are the row's, and the row's own reader still names none of them.
    const listed: NonNullable<StatementLanguageData> = {
      name: "acmeql",
      confirmation: { ...ACME_LANGUAGE_DATA.confirmation, operations: ["drop", "put"] },
    };
    const named = statementLanguageRow(ENGINE, listed, null);
    expect([...(named?.operations ?? [])]).toEqual(["drop", "put"]);
    expect(rowNamesAsked(named, "drop")).toBe(false);

    // A row that sends to the safety analysis and bounds no text states neither key, as the row's shape reads
    // absence; a claim the data does not make is false.
    const open: NonNullable<StatementLanguageData> = {
      name: "acmeql",
      confirmation: {
        ...ACME_LANGUAGE_DATA.confirmation,
        decidesAlone: false,
        safetyAnalysis: true,
        maxTextBytes: null,
      },
    };
    const sends = statementLanguageRow(ENGINE, open, null);
    expect(Object.keys(sends ?? {}).sort()).toEqual(["decidesAlone", "operations", "read"]);
    expect(sends?.decidesAlone).toBe(false);
    expect(rowTextByteLimit(sends)).toBeUndefined();

    // No data: Studio's code row of a legacy engine, by identity, and none where the engine's statements are SQL.
    const kafka = codeStatementLanguageRow("kafka");
    expect(kafka).not.toBeNull();
    expect(statementLanguageRow("kafka", null, kafka)).toBe(kafka);
    expect(statementLanguageRow("postgres", null, null)).toBeNull();
    expect(rowTextByteLimit(null)).toBeUndefined();

    // Data beside a code row is a host defect: Studio holds a code row only for an engine that declares none.
    expect(() => statementLanguageRow("kafka", ACME_LANGUAGE_DATA, kafka)).toThrow(
      /The engine "kafka" declares its statement language as data and Studio also holds a code row for it/,
    );
    // A reader kind core does not hold is refused by name, never read as some other kind.
    const unknownKind = {
      name: "acmeql",
      confirmation: { ...ACME_LANGUAGE_DATA.confirmation, reader: "nonesuch" },
    } as unknown as NonNullable<StatementLanguageData>;
    expect(() => statementLanguageRow(ENGINE, unknownKind, null)).toThrow(
      /The engine "acmerow" declares the operation reader kind "nonesuch", which core does not hold/,
    );
  });

  test("a row's refusal is its text bound first, then its own verdict, and none for no row", () => {
    const refusing = row([], [], {
      refuse: (text) => (text.includes("FORBIDDEN") ? "refused" : undefined),
      maxTextBytes: 8,
    });
    expect(rowRefusal(refusing, "FORBIDDEN")).toBe(
      "The statement is 9 bytes in UTF-8, over the 8-byte limit for this connection type. Shorten it to run it.",
    );
    expect(rowRefusal(refusing, " FORBID")).toBeUndefined();
    expect(rowRefusal(row([], [], { refuse: () => "refused" }), "FORBIDDEN")).toBe("refused");
    expect(rowRefusal(row([], [], { maxTextBytes: 4 }), "abcd")).toBeUndefined();
    expect(rowRefusal(row([], []), "x".repeat(10_000))).toBeUndefined();
    expect(rowRefusal(null, "x".repeat(10_000))).toBeUndefined();
  });

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

    // The row the resolver compiles from declared data is read the same way: its claim counts only as granted.
    const compiled = statementLanguageRow(ENGINE, ACME_LANGUAGE_DATA, null);
    const compiledVerdict = (sql: string, grants: GateGrants) => [
      sql,
      confirmationVerdict(sql, { ...reading(grants), row: compiled }, "Keys"),
    ];
    const decides: GateGrants = {
      reviewedGrammar: true,
      readsSqlText: true,
      confirmExemptForms: [],
      decidesAlone: true,
    };
    expect(compiledVerdict("DELETE FROM t", decides)).toStrictEqual(runs("DELETE FROM t"));
    expect(compiledVerdict("SELECT 1", decides)).toStrictEqual(runs("SELECT 1"));
    expect(compiledVerdict("DELETE FROM t", ungranted)).toStrictEqual(asks("DELETE FROM t"));
    expect(compiledVerdict("SELECT 1", ungranted)).toStrictEqual(runs("SELECT 1"));
    const unreviewed: GateGrants = { ...decides, reviewedGrammar: false };
    for (const sql of ["SELECT 1", "DELETE FROM t"]) {
      expect(compiledVerdict(sql, unreviewed)).toStrictEqual(asks(sql));
    }
  });
});
