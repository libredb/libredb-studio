import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LEGACY_KEY, readGrantRegister } from "@libredb/grant-register";
import { grantEngineClaims, legacyEngineGrants } from "@/lib/db/claim-grants";
import type { DestructiveVocabulary } from "@/lib/db/destructive-vocabulary";
import { codeStatementLanguageRow, typeStatementLanguageRow } from "@/lib/db/destructive-commands";
import { BUNDLED_CLAIM_REQUESTS } from "@/lib/db/engine-catalog/claims.generated";
import { BUNDLED_SQL_TEXT } from "@/lib/db/engine-catalog/sql-text.generated";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { SEED_ONLY_FIELDS } from "@/lib/db/connection-fields";
import { languageDataSha256 } from "@/lib/db/language-digest";
import { LEGACY_ENGINE_IDS } from "@/lib/provider-host/legacy-adapter/identity";
import { LEGACY_ENGINES } from "@/lib/provider-host/legacy-adapter/records";
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
import type { DatabaseType } from "@/lib/types";
import { type ConfirmationVerdict, confirmationVerdict } from "@/lib/editor/statement-analysis";
import { readingOfRecord, type StatementReading } from "@/lib/sql/dangerous-query";
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
      agent: null,
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
      agent: null,
    };
    const sends = statementLanguageRow(ENGINE, open, null);
    expect(Object.keys(sends ?? {}).sort()).toEqual(["decidesAlone", "operations", "read"]);
    expect(sends?.decidesAlone).toBe(false);
    expect(rowTextByteLimit(sends)).toBeUndefined();

    // No data: Studio's code row of a legacy engine, by identity, and none where the engine's statements are SQL.
    const redis = codeStatementLanguageRow("redis");
    expect(redis).not.toBeNull();
    expect(statementLanguageRow("redis", null, redis)).toBe(redis);
    expect(statementLanguageRow("postgres", null, null)).toBeNull();
    expect(rowTextByteLimit(null)).toBeUndefined();

    // Data beside a code row is a host defect: Studio holds a code row only for an engine that declares none.
    expect(() => statementLanguageRow("redis", ACME_LANGUAGE_DATA, redis)).toThrow(
      /The engine "redis" declares its statement language as data and Studio also holds a code row for it/,
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

  test("a legacy engine's statement language row is its declared data, granted under its register row's language digest", () => {
    const declaredData = (type: DatabaseType) =>
      JSON.parse(
        readFileSync(path.resolve(import.meta.dir, `../../../src/lib/db/engine-declarations/${type}.json`), "utf8"),
      ).statementLanguageData as StatementLanguageData;
    const stating = SHIPPED_DATABASE_TYPES.filter((type) => declaredData(type) !== null);
    // A census pin: the legacy engines whose declaration states statement language data, a set that leaves with them.
    expect(stating).toEqual(["kafka"]);

    let ran = 0;
    for (const type of stating) {
      const declared = declaredData(type) as NonNullable<StatementLanguageData>;
      // Studio holds no code row for the engine: its row is compiled from its declaration's data, once, and the
      // browser's by-type resolver and the legacy record hold the same frozen object.
      expect(codeStatementLanguageRow(type)).toBeNull();
      const compiled = typeStatementLanguageRow(type);
      if (compiled === null) throw new Error(`${type} has no statement language row`);
      expect(typeStatementLanguageRow(type)).toBe(compiled);
      const record = LEGACY_ENGINES.get(type);
      if (record === undefined) throw new Error(`the legacy adapter serves no ${type}`);
      expect(record.statementLanguageRow).toBe(compiled);
      expect(Object.isFrozen(compiled)).toBe(true);
      expect([...compiled.operations]).toEqual([...declared.confirmation.operations]);
      expect(compiled.decidesAlone).toBe(declared.confirmation.decidesAlone);
      expect(rowTextByteLimit(compiled)).toBe(declared.confirmation.maxTextBytes ?? undefined);
      expect(JSON.stringify(statementLanguageRow(type, declared, null))).toBe(JSON.stringify(compiled));

      // Its register row reviewed the digest of exactly this data, so the claims count: the text is not SQL, agent
      // mode sends the language, and the row is the gate's whole answer where the data says it decides alone.
      const grants = legacyEngineGrants(type);
      expect([grants.readsSqlText, grants.statementLanguage]).toEqual([false, declared.name]);
      expect(rowDecidesAlone(compiled, grants)).toBe(declared.confirmation.decidesAlone);
      // A text the row names no operation for runs where the row decides alone.
      const unnamed = ["", "DELETE FROM t", "SELECT 'a"].filter((text) => compiled.read(text)?.length === 0);
      for (const text of declared.confirmation.decidesAlone ? unnamed : []) {
        expect([type, text, confirmationVerdict(text, readingOfRecord(record), "Keys")]).toStrictEqual([
          type,
          text,
          { decision: "run" },
        ]);
        ran += 1;
      }

      // The same data a byte changed is not what the row reviewed: no statement language, no decides-alone and no
      // text-not-SQL, the restrictive values, so the gate reads every statement as SQL in front of the row, a write or
      // a run it cannot read asking, and agent mode sends the engine no statement language.
      const row = readGrantRegister(LEGACY_ENGINE_IDS).rowFor({ legacy: LEGACY_KEY, engine: type });
      if (row === null) throw new Error(`the grant register holds no legacy ${type} row`);
      const sqlText = {
        readsSqlText: BUNDLED_SQL_TEXT[type].readsSqlText,
        confirmExemptForms: BUNDLED_SQL_TEXT[type].grammar.confirmExemptForms,
        redaction: row.grants.redaction,
        grammarSha256: row.grants.grammarSha256,
      };
      const grantFor = (data: NonNullable<StatementLanguageData>) =>
        grantEngineClaims(
          type,
          BUNDLED_CLAIM_REQUESTS[type],
          sqlText,
          { languageSha256: languageDataSha256(data) },
          row,
          SEED_ONLY_FIELDS,
        );
      // Vacuity: the committed data grants exactly the legacy record's grants.
      expect(grantFor(declared)).toEqual(grants);
      const last = declared.name.at(-1) === "a" ? "b" : "a";
      const changed = { ...declared, name: `${declared.name.slice(0, -1)}${last}` };
      expect(languageDataSha256(changed)).not.toBe(languageDataSha256(declared));
      const planted = grantFor(changed);
      expect([planted.decidesAlone, planted.readsSqlText, planted.statementLanguage]).toEqual([false, true, null]);
      expect(rowDecidesAlone(compiled, planted)).toBe(false);
      for (const text of ["DELETE FROM t", "SELECT 'a"]) {
        const verdict = confirmationVerdict(text, { ...readingOfRecord(record), grants: planted }, "Keys");
        expect([type, text, verdict.decision]).toEqual([type, text, "confirm"]);
      }
    }
    // Vacuity: some row decided alone on a text it names no operation for, so the run half reads a verdict.
    expect(ran).toBeGreaterThan(0);
  });
});
