/**
 * The migration DDL function modules the registry imports, held to the registry: each belongs to a shipped engine
 * whose row writes table DDL, one module per engine, and a written row's `reasons` lists every refusal its module
 * prints. A written row's `reasons` is held to its golden text: every refusal line the fixture makes it print ends in
 * one of them, so a refusal the module prints cannot be left out of `reasons`.
 */
import { describe, expect, test } from "bun:test";
import { MIGRATION_DDL } from "@/lib/db/migration-ddl";
import type { DatabaseType } from "@/lib/types";
import { renderGolden } from "./fixtures";
import { engineModules } from "./modules";

const MODULES = engineModules();
const IDS = Object.keys(MIGRATION_DDL) as DatabaseType[];

describe("the registry's migration DDL function modules", () => {
  test("the registry's function modules belong to shipped engines that write table DDL, one module each", () => {
    const ids = MODULES.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => MIGRATION_DDL[id as DatabaseType]?.tableDdl !== "written")).toEqual([]);
  });
});

/** Each `-- <engine>: Cannot ...` line of a key's golden text; the header lines name no refusal. */
function refusalLines(key: string): string[] {
  return renderGolden(key)
    .split("\n")
    .filter((line) => line.startsWith("-- ") && line.includes(": Cannot "));
}

/** The refusal lines that end in none of `reasons`, each once. */
function unlistedRefusals(key: string, reasons: readonly string[]): string[] {
  return [...new Set(refusalLines(key))].filter((line) => !reasons.some((reason) => line.endsWith(reason)));
}

describe("a written module lists every refusal it prints", () => {
  const written = IDS.filter((id) => MIGRATION_DDL[id].tableDdl === "written");

  test.each(written.map((id) => [id] as const))("%s", (id) => {
    expect(unlistedRefusals(id, MIGRATION_DDL[id].reasons)).toEqual([]);
  });

  test("a printed refusal missing from reasons is named, and a module that refuses nothing prints none", () => {
    expect(refusalLines("postgres")).toEqual([]);
    expect(unlistedRefusals("clickhouse", [])).toContain(
      "-- ClickHouse: Cannot add a foreign key. The engine has no foreign-key constraint.",
    );
  });
});
