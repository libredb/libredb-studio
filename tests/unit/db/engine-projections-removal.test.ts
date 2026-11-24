/**
 * Removing an engine's declaration from the admitted set gives exactly what a fresh build from the remaining set gives,
 * in every projection Studio makes of the declarations (docs/providers/CONTRACT.md, clauses M-70, M-71 and M-72).
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
  renderCatalog,
  renderConnectionFlags,
  renderConnectionForms,
  renderConnectionTables,
} from "../../../scripts/generate-engine-catalog";
import { defaultConnection, savedConnectionNotice, shownConnection } from "@/lib/connection-availability";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { CONNECTION_FORM_FUNCTIONS, composeConnectionForm } from "@/lib/db/connection-form";
import {
  type ConnectionFormEntry,
  type ConnectionTables,
  projectCatalog,
  projectConnectionForms,
  projectConnectionTables,
} from "@/lib/db/engine-catalog/projection";
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
