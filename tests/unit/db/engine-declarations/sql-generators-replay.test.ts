/**
 * Every SQL engine's generator row, rebuilt from the `sqlGenerators` segment of its committed engine declaration,
 * answers what the row answers (docs/providers/CONTRACT.md, clauses S-20 and S-21).
 *
 * At module top, before anything that reads the generator registry is imported, each module the query generators'
 * registry imports an SQL engine's row from (found by `sqlGeneratorModules` in
 * tests/unit/db/engine-declarations/sql-generator-modules.ts, which reads the registry file's import statements as
 * source) has its exported row replaced, through `mock.module` on its absolute path, by the row
 * `sqlGeneratorsFromDeclaration` rebuilds from the engine's declaration, each form resolved by the slot the declaration
 * names on the module's own row. Then `generatorCorpusDigests` (tests/fixtures/query-generators/generator-corpus.ts)
 * runs every generator and quoting helper over its corpus, which reaches every member of every SQL engine's row, and
 * its digests must equal the committed generator-corpus.json, so the count expression and each named form are held to
 * the text Studio writes with them.
 *
 * The editor language has no golden output of its own: the census in tests/unit/db/engine-declarations.test.ts reads
 * it back to the editor's registries.
 *
 * The mocks are safe here only because `bun run test` runs every test file in its own bun process (CLAUDE.md,
 * tests/run-tests.ts): bun's module mocks are process-wide with no undo, so a bare `bun test` over a directory would
 * hand the rebuilt rows to every other file of that process.
 */
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { EngineDeclaration } from "@libredb/provider-sdk/manifest";
import type { SqlEngineGenerators } from "@/lib/db/query-generators/types";
import { ROOT } from "../migration-ddl/modules";
import { sqlGeneratorModules } from "./sql-generator-modules";
import { sqlGeneratorsFromDeclaration } from "./sql-generators-from-declaration";

const GOLDEN = path.join(ROOT, "tests", "fixtures", "query-generators", "generator-corpus.json");
const DECLARATIONS_DIR = path.join(ROOT, "src", "lib", "db", "engine-declarations");

/** The committed declaration of one type-id, parsed. */
function declared(id: string): EngineDeclaration {
  return JSON.parse(readFileSync(path.join(DECLARATIONS_DIR, `${id}.json`), "utf8")) as EngineDeclaration;
}

const modules = await Promise.all(
  sqlGeneratorModules().map(async (engine) => {
    const absPath = path.join(ROOT, engine.path);
    return { engine, absPath, actual: (await import(absPath)) as Record<string, unknown> };
  }),
);

/** Each engine's row as its own module exports it, read before the module is replaced. */
const OWN = new Map<string, SqlEngineGenerators>();
/** Each engine's row as rebuilt from its declaration, the value its module now exports. */
const REBUILT = new Map<string, SqlEngineGenerators>();
for (const { engine, absPath, actual } of modules) {
  const own = actual[engine.exportName] as SqlEngineGenerators;
  OWN.set(engine.id, own);
  const rebuilt = sqlGeneratorsFromDeclaration(engine.id, declared(engine.id).sqlGenerators, own);
  REBUILT.set(engine.id, rebuilt);
  mock.module(absPath, () => ({ ...actual, [engine.exportName]: rebuilt }));
}

const { generatorCorpusDigests } = await import("../../../fixtures/query-generators/generator-corpus");
const { SQL_ENGINE_GENERATORS } = await import("@/lib/db/query-generators");

describe("SQL generators replayed from the declarations", () => {
  test("every SQL engine's generator row, rebuilt from its declaration with each form resolved by its slot, answers the committed generator corpus", async () => {
    const digests = JSON.parse(await generatorCorpusDigests()) as Record<string, string>;

    expect(digests).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
    expect(modules.length).toBe(Object.keys(SQL_ENGINE_GENERATORS).length);
  });

  test("the registry serves every engine with a row the SQL generator row rebuilt from its declaration, not its module's own", () => {
    const ids = Object.keys(SQL_ENGINE_GENERATORS) as (keyof typeof SQL_ENGINE_GENERATORS)[];

    expect(ids.filter((id) => SQL_ENGINE_GENERATORS[id] !== REBUILT.get(id))).toEqual([]);
    expect(ids.filter((id) => SQL_ENGINE_GENERATORS[id] === OWN.get(id))).toEqual([]);
    expect(ids.filter((id) => OWN.get(id) === undefined)).toEqual([]);
    expect(ids.length).toBeGreaterThan(0);
  });
});
