/**
 * Every engine's migration DDL row, rebuilt from the `migrationDdl` segment of its committed engine declaration, writes
 * what the row writes (docs/providers/CONTRACT.md, clauses S-17 and S-18).
 *
 * At module top, before anything that reads the registry is imported, each engine module the migration DDL registry
 * imports (found by `engineModules` in tests/unit/db/migration-ddl/modules.ts, which reads the registry file's import
 * statements as source) has its exported row replaced, through `mock.module` on its absolute path, by the row
 * `migrationDdlFromDeclaration` rebuilds from the engine's declaration, each function resolved by the slot the
 * declaration names on the module's own row. Then `renderGolden` writes the schema diff's migration over a diff that
 * carries every change kind, and each engine's text must equal its committed golden file, so a data member the census
 * reads back structurally, the refusal line and the transaction wrapper, is also held to the text Studio writes with it.
 *
 * The reasons are held by the census alone: nothing at run time reads them, so a reason dropped or reordered moves no
 * golden file, and the census reads each declaration's reasons back to the row's list in order.
 *
 * The mocks are safe here only because `bun run test` runs every test file in its own bun process (CLAUDE.md,
 * tests/run-tests.ts): bun's module mocks are process-wide with no undo, so a bare `bun test` over a directory would
 * hand the rebuilt rows to every other file of that process.
 */
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { EngineDeclaration } from "@libredb/provider-sdk/manifest";
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";
import { engineModules, ROOT } from "../migration-ddl/modules";
import { migrationDdlFromDeclaration } from "./migration-ddl-from-declaration";

const GOLDEN_DIR = path.join(ROOT, "tests", "unit", "db", "migration-ddl", "golden");
const DECLARATIONS_DIR = path.join(ROOT, "src", "lib", "db", "engine-declarations");

/** The committed declaration of one type-id, parsed. */
function declared(id: string): EngineDeclaration {
  return JSON.parse(readFileSync(path.join(DECLARATIONS_DIR, `${id}.json`), "utf8")) as EngineDeclaration;
}

const modules = await Promise.all(
  engineModules().map(async (engine) => {
    const absPath = path.join(ROOT, engine.path);
    return { engine, absPath, actual: (await import(absPath)) as Record<string, unknown> };
  }),
);

/** Each engine's row as its own module exports it, read before the module is replaced. */
const OWN = new Map<string, MigrationDdlSpec>();
/** Each engine's row as rebuilt from its declaration, the value its module now exports. */
const REBUILT = new Map<string, MigrationDdlSpec>();
for (const { engine, absPath, actual } of modules) {
  const own = actual[engine.exportName] as MigrationDdlSpec;
  OWN.set(engine.id, own);
  const rebuilt = migrationDdlFromDeclaration(engine.id, declared(engine.id).migrationDdl, own);
  REBUILT.set(engine.id, rebuilt);
  mock.module(absPath, () => ({ ...actual, [engine.exportName]: rebuilt }));
}

const { renderGolden } = await import("../migration-ddl/fixtures");
const { MIGRATION_DDL } = await import("@/lib/db/migration-ddl");

describe("migration DDL replayed from the declarations", () => {
  test("every engine's migration DDL row, rebuilt from its declaration with each function resolved by its slot, renders the engine's golden migration text", () => {
    const differing = modules
      .map(({ engine }) => engine.id)
      .filter((id) => renderGolden(id) !== readFileSync(path.join(GOLDEN_DIR, `${id}.txt`), "utf8"));

    expect(differing).toEqual([]);
    expect(modules.length).toBe(Object.keys(MIGRATION_DDL).length);
  });

  test("the registry serves every shipped engine the migration DDL row rebuilt from its declaration, not its module's own", () => {
    const ids = Object.keys(MIGRATION_DDL) as (keyof typeof MIGRATION_DDL)[];

    expect(ids.filter((id) => MIGRATION_DDL[id] !== REBUILT.get(id))).toEqual([]);
    expect(ids.filter((id) => MIGRATION_DDL[id] === OWN.get(id))).toEqual([]);
    expect(ids.filter((id) => OWN.get(id) === undefined)).toEqual([]);
  });
});
