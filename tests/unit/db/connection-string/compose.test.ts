/**
 * Composing an engine's connection string from its declaration (docs/providers/CONTRACT.md, clause M-74): a declaration
 * names its URL TLS reader, paste reader and seed check and never carries one, and `CONNECTION_STRING_FUNCTIONS`,
 * Studio's connection string function table, binds each name to the function Studio's own source holds for that engine
 * at that slot. A name the table holds no function for at that slot is refused by name, with no default.
 */
import { describe, expect, test } from "bun:test";
import type { EngineDeclaration } from "@libredb/provider-sdk/manifest";
import { admittedDeclarations } from "../../../../scripts/generate-engine-catalog";
import {
  CONNECTION_STRING_FUNCTIONS,
  type ConnectionStringFunctions,
  composeConnectionString,
} from "@/lib/db/connection-string";
import { type ConnectionStringEntry, projectConnectionStrings } from "@/lib/db/engine-catalog/projection";
import type { DatabaseType } from "@/lib/types";
import { fixtureEngineDeclaration } from "../../../helpers/fixture-engine-declaration";

const ADMITTED: readonly EngineDeclaration[] = admittedDeclarations();
const STRINGS = projectConnectionStrings(ADMITTED);

/** The projected connection string entry of `type`. */
function entryOf(type: string): ConnectionStringEntry {
  const entry = STRINGS[type];
  if (entry === undefined) throw new Error(`no connection string entry for ${type}`);
  return entry;
}

const sorted = (list: readonly string[]) => [...list].sort();

describe("composing a connection string", () => {
  test("a declaration naming a function Studio holds none for is refused by name when its connection string is composed", () => {
    const fixture = fixtureEngineDeclaration(ADMITTED.find((d) => d.id === "postgres") as EngineDeclaration);
    const naming = {
      ...fixture,
      connection: {
        ...fixture.connection,
        connectionString: { ...fixture.connection.connectionString, seedCheck: "seedCheck" },
      },
    };
    const acmefoo = projectConnectionStrings([naming]).acmefoo as ConnectionStringEntry;

    expect(() => composeConnectionString("acmefoo" as DatabaseType, acmefoo, CONNECTION_STRING_FUNCTIONS)).toThrow(
      'acmefoo names the function "seedCheck", which Studio holds no function for.',
    );
    // The fixture as committed names none, so it composes.
    const plain = projectConnectionStrings([fixture]).acmefoo as ConnectionStringEntry;
    expect(composeConnectionString("acmefoo" as DatabaseType, plain, CONNECTION_STRING_FUNCTIONS)).toEqual({
      scheme: null,
      readTls: null,
      paste: null,
      validateSeed: null,
    });

    // PostgreSQL's URL TLS reader renamed: no default, no skipped slot.
    const renamed: ConnectionStringEntry = { ...entryOf("postgres"), urlTls: "urlTlsV2" };
    expect(() => composeConnectionString("postgres", renamed, CONNECTION_STRING_FUNCTIONS)).toThrow(
      'postgres names the function "urlTlsV2", which Studio holds no function for.',
    );
    // A name on an engine the table holds nothing for.
    const druid: ConnectionStringEntry = { ...entryOf("druid"), seedCheck: "seedCheck" };
    expect(() => composeConnectionString("druid", druid, CONNECTION_STRING_FUNCTIONS)).toThrow(
      'druid names the function "seedCheck", which Studio holds no function for.',
    );

    // With an empty table, every engine that names a function is refused, and every other one composes.
    const empty: ConnectionStringFunctions = { urlTlsReaders: {}, pasteReaders: {}, seedChecks: {} };
    const refused: string[] = [];
    const composed: string[] = [];
    for (const [type, entry] of Object.entries(STRINGS)) {
      try {
        composeConnectionString(type as DatabaseType, entry, empty);
        composed.push(type);
      } catch (error) {
        expect((error as Error).message).toMatch(
          new RegExp(`^${type} names the function "\\w+", which Studio holds no function for\\.$`),
        );
        refused.push(type);
      }
    }
    const naming15 = Object.entries(STRINGS)
      .filter(([, entry]) => entry.urlTls !== null || entry.paste !== null || entry.seedCheck !== null)
      .map(([type]) => type);
    expect(refused).toEqual(naming15);
    expect(refused.length).toBe(15);
    expect(composed.length).toBe(ADMITTED.length - 15);
  });

  test("a name Studio holds only for another slot is refused by name", () => {
    const postgres = entryOf("postgres");
    const snowflake = entryOf("snowflake");

    for (const [type, entry, name] of [
      ["postgres", { ...postgres, urlTls: "pasteReader" }, "pasteReader"],
      ["postgres", { ...postgres, seedCheck: "urlTls" }, "urlTls"],
      ["snowflake", { ...snowflake, seedCheck: "pasteReader" }, "pasteReader"],
      [
        "snowflake",
        { ...snowflake, paste: { reader: "seedCheck", catchAll: false, formats: ["snowflake://"] } },
        "seedCheck",
      ],
    ] as const satisfies readonly (readonly [DatabaseType, ConnectionStringEntry, string])[]) {
      expect(() => composeConnectionString(type, entry, CONNECTION_STRING_FUNCTIONS)).toThrow(
        `${type} names the function "${name}", which Studio holds no function for.`,
      );
    }
  });

  test("Studio's connection string function table holds exactly the functions the committed declarations name, each at its own slot", () => {
    const named = (read: (d: EngineDeclaration) => string | null) =>
      Object.fromEntries(
        ADMITTED.flatMap((d) => {
          const name = read(d);
          return name === null ? [] : [[d.id, [name]]];
        }),
      );
    const held = (table: Readonly<Partial<Record<DatabaseType, Readonly<Record<string, unknown>>>>>) =>
      Object.fromEntries(Object.entries(table).map(([type, slots]) => [type, sorted(Object.keys(slots ?? {}))]));

    expect(held(CONNECTION_STRING_FUNCTIONS.urlTlsReaders)).toEqual(named((d) => d.connection.connectionString.urlTls));
    expect(held(CONNECTION_STRING_FUNCTIONS.pasteReaders)).toEqual(
      named((d) => d.connection.connectionString.paste?.reader ?? null),
    );
    expect(held(CONNECTION_STRING_FUNCTIONS.seedChecks)).toEqual(named((d) => d.connection.connectionString.seedCheck));
    expect(Object.isFrozen(CONNECTION_STRING_FUNCTIONS)).toBe(true);
    for (const table of Object.values(CONNECTION_STRING_FUNCTIONS)) {
      expect(Object.isFrozen(table)).toBe(true);
      expect(Object.values(table).every((slots) => Object.isFrozen(slots))).toBe(true);
    }
    // Each paste reader is frozen and holds exactly its three operations.
    for (const slots of Object.values(CONNECTION_STRING_FUNCTIONS.pasteReaders)) {
      for (const reader of Object.values(slots ?? {})) {
        expect(Object.isFrozen(reader)).toBe(true);
        expect(Object.keys(reader)).toEqual(["claims", "names", "parse"]);
      }
    }
  });
});
