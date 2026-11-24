/**
 * Removing an engine's declaration from the admitted set gives exactly what a fresh build from the remaining set gives,
 * in every projection Studio makes of the declarations (docs/providers/CONTRACT.md, clause M-70).
 *
 * A fixture engine, `acmefoo` (tests/helpers/fixture-engine-declaration.ts), is added to the committed declarations and
 * removed again; each projection built without it must equal a fresh build from the committed set and the committed
 * generated module, and none may depend on the order the declarations are admitted in. What is kept on purpose is held
 * too: a stored connection of an engine the catalog no longer holds stays in the user's list, shown as Unavailable.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { compileManifestValidator, type EngineDeclaration } from "@libredb/provider-sdk/manifest";
import { admittedDeclarations, ENGINE_CATALOG_MODULE, renderCatalog } from "../../../scripts/generate-engine-catalog";
import { defaultConnection, savedConnectionNotice, shownConnection } from "@/lib/connection-availability";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { projectCatalog } from "@/lib/db/engine-catalog/projection";
import { unknownTypeSentence } from "@/lib/db/type-id";
import type { DatabaseConnection } from "@/lib/types";
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
