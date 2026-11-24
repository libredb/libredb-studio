/**
 * Removing an engine's declaration from the admitted set gives exactly what a fresh build from the remaining set gives,
 * in every projection Studio makes of the declarations (docs/providers/CONTRACT.md, clauses M-70, M-71, M-72, M-74,
 * M-75, M-77 and M-78).
 *
 * A fixture engine, `acmefoo` (tests/helpers/fixture-engine-declaration.ts), is added to the committed declarations and
 * removed again; each projection built without it must equal a fresh build from the committed set and the committed
 * generated modules, and none may depend on the order the declarations are admitted in. What is kept on purpose is held
 * too: a stored connection of an engine the catalog no longer holds stays in the user's list, shown as Unavailable.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { compileManifestValidator, type EngineDeclaration } from "@libredb/provider-sdk/manifest";
import {
  admittedDeclarations,
  ENGINE_CATALOG_MODULE,
  ENGINE_CONNECTION_FLAGS_MODULE,
  ENGINE_CONNECTION_FORM_MODULE,
  ENGINE_CONNECTION_MODULE,
  ENGINE_CONNECTION_STRING_MODULE,
  ENGINE_EDITOR_MODULE,
  ENGINE_QUERY_EDITOR_MODULE,
  ENGINE_SQL_TEXT_MODULE,
  renderCatalog,
  renderConnectionFlags,
  renderConnectionForms,
  renderConnectionStrings,
  renderConnectionTables,
  renderEditorFacts,
  renderQueryEditorFacts,
  renderSqlText,
} from "../../../scripts/generate-engine-catalog";
import { defaultConnection, savedConnectionNotice, shownConnection } from "@/lib/connection-availability";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { CONNECTION_FORM_FUNCTIONS, composeConnectionForm } from "@/lib/db/connection-form";
import { CONNECTION_STRING_FUNCTIONS, composeConnectionString } from "@/lib/db/connection-string";
import {
  type ConnectionFormEntry,
  type ConnectionStringEntry,
  type ConnectionTables,
  projectCatalog,
  projectConnectionForms,
  projectConnectionStrings,
  projectConnectionTables,
  projectEditorFacts,
  projectQueryEditorFacts,
  projectSqlText,
  type SqlTextEntry,
} from "@/lib/db/engine-catalog/projection";
import { composeSqlGrammar, SQL_GRAMMAR_FUNCTIONS, sqlGrammarFor } from "@/lib/db/sql-grammar";
import { unknownTypeSentence } from "@/lib/db/type-id";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import { fixtureEngineDeclaration } from "../../helpers/fixture-engine-declaration";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SCHEMA_FILE = path.join(ROOT, "packages/provider-sdk/src/manifest/manifest.schema.json");

const ADMITTED: readonly EngineDeclaration[] = admittedDeclarations();
const POSTGRES = ADMITTED.find((d) => d.id === "postgres") as EngineDeclaration;
const FIXTURE = fixtureEngineDeclaration(POSTGRES);

/** `list` in a fixed shuffled order: every third declaration first, then the rest, both reversed. */
function shuffled<T>(list: readonly T[]): T[] {
  const first = list.filter((_, index) => index % 3 === 0).reverse();
  const rest = list.filter((_, index) => index % 3 !== 0).reverse();
  return [...first, ...rest];
}

describe("each projection of the admitted declarations, built with and without a fixture engine", () => {
  test("the fixture engine's declaration is admitted by the schema's engine declaration and its rules", () => {
    const verdict = compileManifestValidator(readFileSync(SCHEMA_FILE)).validateEngine(FIXTURE);

    expect(verdict.admitted).toBe(true);
  });

  test("the catalog built with the fixture engine holds it, and with it removed is exactly a fresh build from the remaining set and the committed catalog", () => {
    const withFixture = projectCatalog([...ADMITTED, FIXTURE]);
    expect(withFixture.acmefoo).toEqual({ location: "external", connectBudgetMs: 90_000 });
    expect(Object.keys(withFixture).length).toBe(ADMITTED.length + 1);

    const removed = projectCatalog([...ADMITTED, FIXTURE].filter((d) => d.id !== FIXTURE.id));
    expect(removed).toEqual(projectCatalog(ADMITTED));
    expect(Object.hasOwn(removed, FIXTURE.id)).toBe(false);
    expect(renderCatalog(removed) === readFileSync(path.join(ROOT, ENGINE_CATALOG_MODULE), "utf8")).toBe(true);
    expect(Object.keys(removed)).toEqual([...SHIPPED_DATABASE_TYPES]);
  });

  test("the catalog is the same whatever order the declarations are admitted in", () => {
    const set = [...ADMITTED, FIXTURE];
    const built = projectCatalog(set);

    for (const order of [[...set].reverse(), shuffled(set)]) {
      const catalog = projectCatalog(order);
      expect(catalog).toEqual(built);
      expect(Object.keys(catalog)).toEqual(Object.keys(built));
    }
    // Vacuity: the shuffle moves declarations, so a projection keyed by admission order would differ.
    expect(shuffled(set).map((d) => d.id)).not.toEqual(set.map((d) => d.id));
  });

  test("the connection tables built with the fixture engine hold its rows, and with it removed are exactly a fresh build from the remaining set and the committed module", () => {
    const withFixture = projectConnectionTables([...ADMITTED, FIXTURE]);
    const tables = Object.keys(withFixture) as (keyof ConnectionTables)[];

    for (const table of tables) expect(Object.hasOwn(withFixture[table], FIXTURE.id)).toBe(true);
    expect(withFixture.fields.acmefoo).toEqual(POSTGRES.connection.fields);
    expect(withFixture.seedOnly.acmefoo).toBeNull();
    expect(withFixture.refused.acmefoo).toEqual({ schema: FIXTURE.connection.refused[0]?.refusal });
    expect(withFixture.refused.acmefoo.schema).toContain("Acme Foo");
    expect(withFixture.credentialWarnings.acmefoo).toEqual([
      { kind: "no-secret", message: expect.stringContaining("Acme Foo") },
    ]);
    expect(withFixture.readsTrustMaterial.acmefoo).toBe(true);
    expect(withFixture.connectionStringAccepted.acmefoo).toBe(POSTGRES.connection.connectionString.accepted);
    expect(withFixture.dialogOffersUri.acmefoo).toBe(true);

    const removed = projectConnectionTables([...ADMITTED, FIXTURE].filter((d) => d.id !== FIXTURE.id));
    const fresh = projectConnectionTables(ADMITTED);
    expect(removed).toEqual(fresh);
    for (const table of tables) {
      expect(Object.hasOwn(removed[table], FIXTURE.id)).toBe(false);
      expect(Object.keys(removed[table])).toEqual(Object.keys(fresh[table]));
    }
    expect(renderConnectionTables(removed) === readFileSync(path.join(ROOT, ENGINE_CONNECTION_MODULE), "utf8")).toBe(
      true,
    );
    expect(
      renderConnectionFlags(removed) === readFileSync(path.join(ROOT, ENGINE_CONNECTION_FLAGS_MODULE), "utf8"),
    ).toBe(true);
  });

  test("the connection tables are the same whatever order the declarations are admitted in", () => {
    const set = [...ADMITTED, FIXTURE];
    const built = projectConnectionTables(set);
    const tables = Object.keys(built) as (keyof ConnectionTables)[];

    for (const order of [[...set].reverse(), shuffled(set)]) {
      const projected = projectConnectionTables(order);
      expect(projected).toEqual(built);
      for (const table of tables) expect(Object.keys(projected[table])).toEqual(Object.keys(built[table]));
    }
  });

  test("the connection forms built with the fixture engine hold its entry, and with it removed are exactly a fresh build from the remaining set and the committed module", () => {
    const withFixture = projectConnectionForms([...ADMITTED, FIXTURE]);
    const entry = withFixture.acmefoo as ConnectionFormEntry;
    expect(entry.displayName).toBe("Acme Foo");
    expect(entry.dialog).toEqual(POSTGRES.connection.dialog);
    expect(entry.tls).toEqual({ modes: ["verify-system", "verify-full"] });
    expect([entry.hostHint, entry.hostIdentity, entry.import]).toEqual([null, null, null]);
    expect(Object.keys(withFixture)).toHaveLength(ADMITTED.length + 1);
    // Its form composes with Studio's function table, which holds nothing for it, since it names no function.
    expect(composeConnectionForm(FIXTURE.id as DatabaseType, entry, CONNECTION_FORM_FUNCTIONS).label).toBe("Acme Foo");

    const removed = projectConnectionForms([...ADMITTED, FIXTURE].filter((d) => d.id !== FIXTURE.id));
    expect(removed).toEqual(projectConnectionForms(ADMITTED));
    expect(Object.hasOwn(removed, FIXTURE.id)).toBe(false);
    expect(Object.keys(removed)).toEqual([...SHIPPED_DATABASE_TYPES]);
    expect(renderConnectionForms(removed)).toBe(readFileSync(path.join(ROOT, ENGINE_CONNECTION_FORM_MODULE), "utf8"));
  });

  test("the connection forms are the same whatever order the declarations are admitted in", () => {
    const set = [...ADMITTED, FIXTURE];
    const built = projectConnectionForms(set);

    for (const order of [[...set].reverse(), shuffled(set)]) {
      const forms = projectConnectionForms(order);
      expect(forms).toEqual(built);
      expect(Object.keys(forms)).toEqual(Object.keys(built));
    }
  });

  test("the connection strings built with the fixture engine hold its entry, and with it removed are exactly a fresh build from the remaining set and the committed module", () => {
    const withFixture = projectConnectionStrings([...ADMITTED, FIXTURE]);
    const entry = withFixture.acmefoo as ConnectionStringEntry;
    // The fixture names no connection string function, whatever its base names: PostgreSQL names three.
    expect(entry).toEqual({ scheme: null, urlTls: null, paste: null, seedCheck: null });
    expect(POSTGRES.connection.connectionString.paste).not.toBeNull();
    expect(Object.keys(withFixture)).toHaveLength(ADMITTED.length + 1);
    // Its connection string composes with Studio's function table, which holds nothing for it.
    expect(composeConnectionString(FIXTURE.id as DatabaseType, entry, CONNECTION_STRING_FUNCTIONS)).toEqual({
      scheme: null,
      readTls: null,
      paste: null,
      validateSeed: null,
    });

    const removed = projectConnectionStrings([...ADMITTED, FIXTURE].filter((d) => d.id !== FIXTURE.id));
    expect(removed).toEqual(projectConnectionStrings(ADMITTED));
    expect(Object.hasOwn(removed, FIXTURE.id)).toBe(false);
    expect(Object.keys(removed)).toEqual([...SHIPPED_DATABASE_TYPES]);
    expect(renderConnectionStrings(removed)).toBe(
      readFileSync(path.join(ROOT, ENGINE_CONNECTION_STRING_MODULE), "utf8"),
    );
  });

  test("the connection strings are the same whatever order the declarations are admitted in", () => {
    const set = [...ADMITTED, FIXTURE];
    const built = projectConnectionStrings(set);

    for (const order of [[...set].reverse(), shuffled(set)]) {
      const strings = projectConnectionStrings(order);
      expect(strings).toEqual(built);
      expect(Object.keys(strings)).toEqual(Object.keys(built));
    }
  });

  test("the execution UI and the fence aliases built with the fixture engine hold its entries, and with it removed are exactly a fresh build from the remaining set and the committed module", () => {
    const withFixture = projectEditorFacts([...ADMITTED, FIXTURE]);
    expect(withFixture.executionUi.acmefoo).toEqual({
      commitKeyword: "APPLY",
      consentDeadline: FIXTURE.editor.consentDeadline,
    });
    expect(withFixture.fenceAliases.acmefooql).toBe("acmefoo");
    expect(Object.keys(withFixture.executionUi).length).toBe(ADMITTED.length + 1);
    // Its entries are ones no shipped engine has.
    const shipped = projectEditorFacts(ADMITTED);
    expect(Object.values(shipped.executionUi)).not.toContainEqual(withFixture.executionUi.acmefoo);
    expect(Object.keys(withFixture.fenceAliases)).toEqual(["acmefooql", ...Object.keys(shipped.fenceAliases)]);

    const removed = projectEditorFacts([...ADMITTED, FIXTURE].filter((d) => d.id !== FIXTURE.id));
    expect(removed).toEqual(shipped);
    expect(Object.hasOwn(removed.executionUi, FIXTURE.id)).toBe(false);
    expect(Object.values(removed.fenceAliases)).not.toContain(FIXTURE.id);
    expect(Object.keys(removed.executionUi)).toEqual([...SHIPPED_DATABASE_TYPES]);
    expect(renderEditorFacts(removed)).toBe(readFileSync(path.join(ROOT, ENGINE_EDITOR_MODULE), "utf8"));
  });

  test("the execution UI and the fence aliases are the same whatever order the declarations are admitted in", () => {
    const set = [...ADMITTED, FIXTURE];
    const built = projectEditorFacts(set);

    for (const order of [[...set].reverse(), shuffled(set)]) {
      const facts = projectEditorFacts(order);
      expect(facts).toEqual(built);
      expect(Object.keys(facts.executionUi)).toEqual(Object.keys(built.executionUi));
      expect(Object.keys(facts.fenceAliases)).toEqual(Object.keys(built.fenceAliases));
    }
  });

  test("the query dialects, the tab type editors and the editor languages built with the fixture engine are the committed module's, and with it or the only declaration of a dialect, tab type and language removed are exactly a fresh build from the remaining set", () => {
    const committed = readFileSync(path.join(ROOT, ENGINE_QUERY_EDITOR_MODULE), "utf8");
    const shipped = projectQueryEditorFacts(ADMITTED);
    // The fixture states postgres's dialect, none, and its language, sql in blue, so it adds no entry: within the
    // closed vocabularies every dialect, tab type and language is already stated, and a differing statement is refused.
    const withFixture = projectQueryEditorFacts([...ADMITTED, FIXTURE]);
    expect(withFixture).toEqual(shipped);
    expect(renderQueryEditorFacts(withFixture)).toBe(committed);

    const removed = projectQueryEditorFacts([...ADMITTED, FIXTURE].filter((d) => d.id !== FIXTURE.id));
    expect(removed).toEqual(shipped);
    expect(renderQueryEditorFacts(removed)).toBe(committed);

    // Kubernetes is the only declaration of the kubectl dialect, tab type and language: removing it gives exactly a
    // fresh build from the remaining 42, lacking the three kubectl entries and nothing else.
    const remaining = ADMITTED.filter((d) => d.id !== "kubernetes");
    const withoutKubernetes = projectQueryEditorFacts([...ADMITTED, FIXTURE].filter((d) => d.id !== "kubernetes"));
    expect(withoutKubernetes).toEqual(projectQueryEditorFacts(remaining));
    expect(remaining.length).toBe(ADMITTED.length - 1);
    const without = <Value>(record: Readonly<Record<string, Value>>, key: string): Record<string, Value> =>
      Object.fromEntries(Object.entries(record).filter(([entry]) => entry !== key));
    expect(withoutKubernetes.queryDialects).toEqual(without(shipped.queryDialects, "kubectl"));
    expect(withoutKubernetes.dialectEditors).toEqual(without(shipped.dialectEditors, "kubectl"));
    expect(withoutKubernetes.editorLanguages).toEqual(without(shipped.editorLanguages, "kubectl"));
    for (const record of Object.values(withoutKubernetes)) expect(Object.hasOwn(record, "kubectl")).toBe(false);
  });

  test("the query dialects, the tab type editors and the editor languages are the same whatever order the declarations are admitted in", () => {
    const set = [...ADMITTED, FIXTURE];
    const built = projectQueryEditorFacts(set);

    for (const order of [[...set].reverse(), shuffled(set)]) {
      const facts = projectQueryEditorFacts(order);
      expect(facts).toEqual(built);
      expect(Object.keys(facts.queryDialects)).toEqual(Object.keys(built.queryDialects));
      expect(Object.keys(facts.dialectEditors)).toEqual(Object.keys(built.dialectEditors));
      expect(Object.keys(facts.editorLanguages)).toEqual(Object.keys(built.editorLanguages));
    }
  });

  test("the SQL text built with the fixture engine holds its entry, and with it removed is exactly a fresh build from the remaining set and the committed module", () => {
    const shipped = projectSqlText(ADMITTED);
    const withFixture = projectSqlText([...ADMITTED, FIXTURE]);
    const entry = withFixture.acmefoo as SqlTextEntry;
    // The fixture names no grammar function, whatever its base names: PostgreSQL names both completion readers.
    expect(entry.completion).toEqual({ formatSegment: null, readQuotedQualifier: null });
    expect(POSTGRES.sqlText.completion.formatSegment).not.toBeNull();
    // Its own trailing clause after its base's, so its entry is one no shipped engine has.
    expect(entry.grammar.trailingLimitClauses.at(-1)).toEqual({
      source: String.raw`\s+WITH\s+ACME\s+HINT\s*$`,
      flags: "i",
    });
    expect(Object.values(shipped)).not.toContainEqual(entry);
    expect(Object.keys(withFixture)).toHaveLength(ADMITTED.length + 1);
    // Its row composes with Studio's grammar function table, which holds nothing for it, and the redaction it is given,
    // since the record has no row for it.
    const row = composeSqlGrammar(FIXTURE.id as DatabaseType, entry, { kind: "none" }, SQL_GRAMMAR_FUNCTIONS);
    expect(row.redaction).toEqual({ kind: "none" });
    expect(row.grammar.trailingLimitClauses.at(-1)?.test("SELECT 1 WITH ACME HINT")).toBe(true);
    expect(row.completion).toEqual({ formatSegment: null, readQuotedQualifier: null });

    const removed = projectSqlText([...ADMITTED, FIXTURE].filter((d) => d.id !== FIXTURE.id));
    expect(removed).toEqual(shipped);
    expect(Object.hasOwn(removed, FIXTURE.id)).toBe(false);
    expect(Object.keys(removed)).toEqual([...SHIPPED_DATABASE_TYPES]);
    expect(renderSqlText(removed)).toBe(readFileSync(path.join(ROOT, ENGINE_SQL_TEXT_MODULE), "utf8"));
    // Nothing is kept on purpose: the grammar composed from the committed module refuses the fixture's id by name.
    expect(() => sqlGrammarFor(FIXTURE.id)).toThrow(unknownTypeSentence(FIXTURE.id));
  });

  test("the SQL text is the same whatever order the declarations are admitted in", () => {
    const set = [...ADMITTED, FIXTURE];
    const built = projectSqlText(set);

    for (const order of [[...set].reverse(), shuffled(set)]) {
      const texts = projectSqlText(order);
      expect(texts).toEqual(built);
      expect(Object.keys(texts)).toEqual(Object.keys(built));
      expect(JSON.stringify(texts)).toBe(JSON.stringify(built));
    }
  });

  test("a stored connection of an engine the catalog no longer holds is kept and shown as Unavailable", () => {
    const postgres: DatabaseConnection = {
      id: "pg",
      name: "Orders",
      type: "postgres",
      host: "localhost",
      port: 5432,
      createdAt: new Date("2026-11-24T10:00:00.000Z"),
    };
    const removed = { ...postgres, id: "acme", name: "Acme Store", type: FIXTURE.id } as unknown as DatabaseConnection;
    const list = [postgres, removed];

    expect(SHIPPED_DATABASE_TYPES as readonly string[]).not.toContain(FIXTURE.id);
    expect(shownConnection(list, removed.id, removed.id)).toBe(removed);
    expect(defaultConnection(list, removed.id)).toBe(postgres);
    expect(savedConnectionNotice(list, removed.id)).toEqual({
      title: "Connection unavailable",
      description: `Acme Store: ${unknownTypeSentence("acmefoo")}`,
    });
  });
});
