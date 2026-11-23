/**
 * Every engine's SQL writing row, rebuilt from the `sqlWriting` segment of its committed engine declaration, writes
 * what the row writes (docs/providers/CONTRACT.md, clauses S-11 to S-14).
 *
 * At module top, before anything that reads the registry is imported, each engine module that
 * tests/unit/db/sql-writing/engine-modules.ts finds on disk has its exported row replaced, through `mock.module` on its
 * absolute path, by the row `sqlWritingFromDeclaration` rebuilds from the engine's declaration, each function resolved
 * by the slot the declaration names on the module's own row. Then `renderGolden` runs every reader the rows feed, the
 * literal, identifier, placeholder and temporal forms, the inline edit with its key kinds and bound edit, and the result
 * export's CREATE TABLE, INSERT and CSV, and each engine's output must equal its committed golden file, so a data
 * member the census reads back structurally is also held to what Studio does with it.
 *
 * The mocks are safe here only because `bun run test` runs every test file in its own bun process (CLAUDE.md,
 * tests/run-tests.ts): bun's module mocks are process-wide with no undo, so a bare `bun test` over a directory would
 * hand the rebuilt rows to every other file of that process.
 */
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { EngineDeclaration } from "@libredb/provider-sdk/manifest";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";
import { ENGINE_MODULES, ROOT } from "../sql-writing/engine-modules";
import { sqlWritingFromDeclaration } from "./sql-writing-from-declaration";

const GOLDEN_DIR = path.join(ROOT, "tests", "unit", "db", "sql-writing", "golden");
const DECLARATIONS_DIR = path.join(ROOT, "src", "lib", "db", "engine-declarations");

/** The committed declaration of one type-id, parsed. */
function declared(id: string): EngineDeclaration {
  return JSON.parse(readFileSync(path.join(DECLARATIONS_DIR, `${id}.json`), "utf8")) as EngineDeclaration;
}

const modules = await Promise.all(
  ENGINE_MODULES.map(async (engine) => ({ engine, actual: (await import(engine.absPath)) as Record<string, unknown> })),
);

/** Each engine's row as its own module exports it, read before the module is replaced. */
const OWN = new Map<string, SqlWritingSpec>();
/** Each engine's row as rebuilt from its declaration, the value its module now exports. */
const REBUILT = new Map<string, SqlWritingSpec>();
for (const { engine, actual } of modules) {
  const own = actual[engine.exportName] as SqlWritingSpec;
  OWN.set(engine.id, own);
  const rebuilt = sqlWritingFromDeclaration(engine.id, declared(engine.id).sqlWriting, own);
  REBUILT.set(engine.id, rebuilt);
  mock.module(engine.absPath, () => ({ ...actual, [engine.exportName]: rebuilt }));
}

const { goldenFileName, renderGolden } = await import("../sql-writing/fixtures");
const { SQL_WRITING } = await import("@/lib/db/sql-writing");

describe("SQL writing replayed from the declarations", () => {
  test("every engine's SQL writing row, rebuilt from its declaration with each function resolved by its slot, renders the engine's golden output", async () => {
    const differing: string[] = [];
    for (const { engine } of modules) {
      // oxlint-disable-next-line no-await-in-loop -- one engine at a time: every render replaces the same global fetch and reads the same toast mocks.
      const rendered = await renderGolden(engine.id);
      if (rendered !== readFileSync(path.join(GOLDEN_DIR, goldenFileName(engine.id)), "utf8")) {
        differing.push(engine.id);
      }
    }

    expect(differing).toEqual([]);
    expect(modules.length).toBe(Object.keys(SQL_WRITING).length);
  });

  test("the registry serves every shipped engine the row rebuilt from its declaration, not its module's own", () => {
    const ids = Object.keys(SQL_WRITING) as (keyof typeof SQL_WRITING)[];

    expect(ids.filter((id) => SQL_WRITING[id] !== REBUILT.get(id))).toEqual([]);
    expect(ids.filter((id) => SQL_WRITING[id] === OWN.get(id))).toEqual([]);
    expect(ids.filter((id) => OWN.get(id) === undefined)).toEqual([]);
  });
});
