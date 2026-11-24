/**
 * Studio's engine catalog: which engines it ships, where each lives and how long its open may take, projected from the
 * engine declarations the catalog generator admits (docs/providers/CONTRACT.md, clause M-70).
 *
 * `scripts/generate-engine-catalog.ts` admits every committed declaration through the SDK's digest-checked validator,
 * projects the admitted set with `projectCatalog` and renders the projection into
 * `src/lib/db/engine-catalog/catalog.generated.ts`, the one module Studio's catalog readers read. This file holds the
 * projection, the admission, the generated module's bytes and the readers that answer from it.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EngineDeclaration } from "@libredb/provider-sdk/manifest";
import {
  admittedDeclarations,
  ENGINE_CATALOG_MODULE,
  ENGINE_DECLARATIONS_DIRECTORY,
  renderCatalog,
} from "../../../scripts/generate-engine-catalog";
import { EXTERNAL_DATABASE_TYPES, isExternalDatabaseType, SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { BUNDLED_CATALOG } from "@/lib/db/engine-catalog/catalog.generated";
import { projectCatalog } from "@/lib/db/engine-catalog/projection";
import type { DatabaseType } from "@/lib/types";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SCRIPT = path.join(ROOT, "scripts/generate-engine-catalog.ts");
const DIRECTORY = path.join(ROOT, ENGINE_DECLARATIONS_DIRECTORY);

/** The admitted set, read once: admission compiles the schema and validates every declaration. */
const ADMITTED: readonly EngineDeclaration[] = admittedDeclarations();

/** The admitted declaration of `id`. */
function admitted(id: string): EngineDeclaration {
  const declaration = ADMITTED.find((d) => d.id === id);
  if (declaration === undefined) throw new Error(`no admitted declaration of ${id}`);
  return declaration;
}

/** A scratch copy of the committed declarations directory, removed by the returned function. */
function scratchDirectory(): { readonly directory: string; readonly remove: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "engine-catalog-"));
  const directory = path.join(root, "declarations");
  mkdirSync(directory);
  for (const declaration of ADMITTED) {
    copyFileSync(path.join(DIRECTORY, `${declaration.id}.json`), path.join(directory, `${declaration.id}.json`));
  }
  return { directory, remove: () => rmSync(root, { recursive: true, force: true }) };
}

describe("the engine catalog, projected from the admitted declarations", () => {
  test("the catalog holds one entry per declaration, keyed in ascending id order whatever order they come in", () => {
    const catalog = projectCatalog([admitted("snowflake"), admitted("libredb"), admitted("bigquery")]);

    expect(Object.keys(catalog)).toEqual(["bigquery", "libredb", "snowflake"]);
    expect(catalog).toEqual({
      bigquery: { location: "external", connectBudgetMs: 140_000 },
      libredb: { location: "embedded", connectBudgetMs: null },
      snowflake: { location: "external", connectBudgetMs: 80_000 },
    });
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.values(catalog).every((entry) => Object.isFrozen(entry))).toBe(true);
    // An id sorts after the id it begins with, given in either order.
    expect(Object.keys(projectCatalog([admitted("influxdb3"), admitted("influxdb")]))).toEqual([
      "influxdb",
      "influxdb3",
    ]);
  });

  test("two declarations of one engine id are refused by name", () => {
    expect(() => projectCatalog([admitted("postgres"), admitted("mysql"), admitted("postgres")])).toThrow(
      'The engine id "postgres" is declared twice.',
    );
  });

  test("the catalog reads only the members a declaration authors", () => {
    // Every member but the authored ones replaced with postgres's: the catalog the generator writes first, before the
    // declaration generator rewrites those members, is therefore already the final one (D-2's premise).
    const postgres = admitted("postgres");
    const replaced = ADMITTED.map(
      (d): EngineDeclaration => ({
        ...postgres,
        id: d.id,
        location: d.location,
        connection: { ...postgres.connection, connectBudgetMs: d.connection.connectBudgetMs },
      }),
    );

    expect(projectCatalog(replaced)).toEqual(projectCatalog(ADMITTED));
    // Vacuity: the replacement changed members the catalog would read if it read them.
    expect(replaced.filter((d, index) => d.displayName !== ADMITTED[index].displayName).length).toBeGreaterThan(0);
  });

  test("every committed declaration is admitted through the SDK's digest-checked validator before it is projected", () => {
    expect(ADMITTED.map((d) => d.id)).toEqual([...SHIPPED_DATABASE_TYPES]);
    expect(ADMITTED.length).toBe(SHIPPED_DATABASE_TYPES.length);
  });

  test("a declaration the schema refuses, one whose id is not its file name, and a stray entry are each refused by name", () => {
    const scratch = scratchDirectory();
    try {
      const { directory } = scratch;
      const kafka = readFileSync(path.join(directory, "kafka.json"), "utf8");

      writeFileSync(path.join(directory, "kafka.json"), JSON.stringify({ ...JSON.parse(kafka), location: "nearby" }));
      expect(() => admittedDeclarations(directory)).toThrow(
        /^kafka\.json is refused by the provider manifest schema: /,
      );

      writeFileSync(path.join(directory, "kafka.json"), JSON.stringify({ ...JSON.parse(kafka), id: "mqtt" }));
      expect(() => admittedDeclarations(directory)).toThrow(
        'kafka.json declares the engine id "mqtt", which is not its file name',
      );

      writeFileSync(path.join(directory, "kafka.json"), kafka);
      writeFileSync(path.join(directory, "notes.txt"), "kept\n");
      expect(() => admittedDeclarations(directory)).toThrow("notes.txt is not a declaration");

      rmSync(path.join(directory, "notes.txt"));
      writeFileSync(path.join(directory, "acmefoo.json"), "{");
      expect(() => admittedDeclarations(directory)).toThrow(/^acmefoo\.json is not JSON: /);

      rmSync(path.join(directory, "acmefoo.json"));
      expect(admittedDeclarations(directory)).toEqual([...ADMITTED]);
    } finally {
      scratch.remove();
    }
  });

  test("the committed catalog module is what the generator renders from the admitted declarations", () => {
    const committed = readFileSync(path.join(ROOT, ENGINE_CATALOG_MODULE), "utf8");

    expect(committed === renderCatalog(projectCatalog(ADMITTED))).toBe(true);
    expect(BUNDLED_CATALOG).toEqual(projectCatalog(ADMITTED));
    expect(committed).toContain("bun run engines:generate");
  });

  test("--check names a stale catalog module, --write writes it, and anything else is refused with the usage line", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "engine-catalog-module-"));
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    try {
      const committed = run("--check");
      expect(committed.stderr.toString()).toBe("");
      expect(committed.exitCode).toBe(0);

      const out = path.join(dir, "catalog.generated.ts");
      writeFileSync(out, readFileSync(path.join(ROOT, ENGINE_CATALOG_MODULE), "utf8").replace("140000", "150000"));
      const stale = run("--check", "--out", out);
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr.toString()).toContain(`${out} is not what the engine declarations project`);
      expect(stale.stderr.toString()).toContain("run: bun run engines:generate");

      rmSync(out);
      expect(run("--check", "--out", out).exitCode).toBe(1);

      expect(run("--write", "--out", out).exitCode).toBe(0);
      expect(readFileSync(out, "utf8")).toBe(readFileSync(path.join(ROOT, ENGINE_CATALOG_MODULE), "utf8"));
      expect(run("--check", "--out", out).exitCode).toBe(0);

      for (const args of [[], ["--check", "--write"], ["--write", "--out"], ["--check", "--verbose"]]) {
        const refused = run(...args);
        expect(refused.exitCode).toBe(2);
        expect(refused.stderr.toString()).toContain(
          "Usage: bun scripts/generate-engine-catalog.ts --write | --check [--out <file>]",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Each run admits every declaration, a fraction of a second; well inside ten times that.
  }, 20000);

  test("SHIPPED_DATABASE_TYPES is the catalog's engines in its order", () => {
    expect<string[]>([...SHIPPED_DATABASE_TYPES]).toEqual(Object.keys(BUNDLED_CATALOG));
    expect([...SHIPPED_DATABASE_TYPES]).toEqual([...SHIPPED_DATABASE_TYPES].sort());
    expect(Object.isFrozen(SHIPPED_DATABASE_TYPES)).toBe(true);
  });

  test("EXTERNAL_DATABASE_TYPES and isExternalDatabaseType answer the location each declaration authors", () => {
    const external = ADMITTED.filter((d) => d.location === "external").map((d) => d.id);

    expect<string[]>([...EXTERNAL_DATABASE_TYPES]).toEqual(external);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => isExternalDatabaseType(type))).toEqual(external as DatabaseType[]);
    expect(ADMITTED.filter((d) => d.location === "embedded").map((d) => d.id)).toEqual(["libredb"]);
    expect(isExternalDatabaseType("libredb")).toBe(false);
    // A value the catalog does not hold is no external engine, prototype keys included.
    for (const value of ["acmefoo", "constructor", "toString", "__proto__"]) {
      expect(isExternalDatabaseType(value as DatabaseType)).toBe(false);
    }
  });
});
