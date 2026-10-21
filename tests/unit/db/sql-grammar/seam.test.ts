/**
 * The seam of the SQL grammar registry: an engine's module reaches the contract's types and the
 * shared building blocks and nothing else, so no engine can read, reuse or reshape another
 * engine's facts (spec 5.5). Two leaves are listed by name, each importing nothing: the record
 * check MongoDB's command redaction needs and the Redis command-text reader.
 *
 * The fresh-process half loads each engine, and the three readers of the registry, as the first
 * import of a new `bun` process. An import cycle through the registry shows up there as a
 * temporal-dead-zone error at load, which a test process that has already loaded the registry
 * through another path never sees.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { howItFailed } from "../../../helpers/spawn-outcome";
import { engineModules, importsOf, REGISTRY_DIR, REGISTRY_INDEX, ROOT, resolveSpecifier } from "./engine-modules";

const TYPES = "@/lib/db/sql-grammar/types";
const SHARED = "@/lib/db/sql-grammar/shared";

/** The one non-contract import each listed engine module may make. */
const LEAVES: Readonly<Record<string, string>> = {
  mongodb: "@/lib/is-record",
  redis: "./redis-command-text",
};

const MODULES = engineModules();
const ALL_IDS = [...EXTERNAL_DATABASE_TYPES, "libredb"].sort();

describe("the engine modules the registry imports", () => {
  test("are one per type id", () => {
    expect(MODULES.map((m) => m.id)).toEqual(ALL_IDS);
  });

  test("the registry imports each engine module exactly once", () => {
    const counts = new Map<string, number>();
    for (const entry of importsOf(REGISTRY_INDEX)) {
      const path = resolveSpecifier(entry.specifier, REGISTRY_INDEX);
      if (path !== null) counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    for (const engine of MODULES) expect([engine.id, counts.get(engine.path)]).toEqual([engine.id, 1]);
  });
});

describe("each engine module imports only the contract", () => {
  for (const engine of MODULES) {
    test(`${engine.id} imports the types, the shared blocks and its listed leaf only`, () => {
      const leaf = LEAVES[engine.id];
      const imports = importsOf(engine.path);
      const offending = imports.filter(
        (entry) =>
          !(entry.specifier === TYPES && entry.typeOnly) && entry.specifier !== SHARED && entry.specifier !== leaf,
      );
      expect({ id: engine.id, offending }).toEqual({ id: engine.id, offending: [] });
      if (leaf !== undefined) expect(imports.some((entry) => entry.specifier === leaf)).toBe(true);
    });
  }

  for (const [id, leaf] of Object.entries(LEAVES)) {
    test(`${id}'s leaf ${leaf} imports nothing`, () => {
      const engine = MODULES.find((m) => m.id === id);
      expect(engine).toBeDefined();
      const path = resolveSpecifier(leaf, engine?.path ?? "") as string;
      expect(importsOf(path)).toEqual([]);
    });
  }

  test("SQLITE_GRAMMAR is imported by exactly the sqlite and libsql modules", () => {
    const importers = MODULES.filter((engine) =>
      importsOf(engine.path).some((entry) => entry.specifier === SHARED && entry.names.includes("SQLITE_GRAMMAR")),
    ).map((engine) => engine.id);
    expect(importers).toEqual(["libsql", "sqlite"]);
  });

  test("no engine module imports the no-connection or unknown-type spec", () => {
    const named = new Set([join(REGISTRY_DIR, "no-connection.ts"), join(REGISTRY_DIR, "unknown-type.ts")]);
    const importers = MODULES.filter((engine) =>
      importsOf(engine.path).some((entry) => named.has(resolveSpecifier(entry.specifier, engine.path) ?? "")),
    ).map((engine) => engine.id);
    expect(importers).toEqual([]);
  });
});

describe("the contract's own modules", () => {
  test("types.ts has only type-only imports", () => {
    const imports = importsOf(join(REGISTRY_DIR, "types.ts"));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((entry) => !entry.typeOnly)).toEqual([]);
  });

  test("shared.ts imports only ./types, type-only", () => {
    const imports = importsOf(join(REGISTRY_DIR, "shared.ts"));
    expect(imports.map((entry) => [entry.specifier, entry.typeOnly])).toEqual([["./types", true]]);
  });
});

/** Loads `path` as the first import of a new process; stderr must stay empty, since a load error writes there. */
function loadsAlone(path: string): void {
  const run = Bun.spawnSync(["bun", "-e", `await import(${JSON.stringify(path)})`], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = run.stderr.toString();
  expect({ path, outcome: run.exitCode === 0 ? "ok" : howItFailed(run), stderr }).toEqual({
    path,
    outcome: "ok",
    stderr: "",
  });
}

describe("each module loads first in a fresh process", () => {
  for (const engine of MODULES) {
    test(engine.id, () => loadsAlone(engine.path));
  }

  for (const reader of ["src/lib/sql/grammar.ts", "src/lib/sql/spans.ts", "src/lib/query-events/redact.ts"]) {
    test(reader, () => loadsAlone(join(ROOT, reader)));
  }
});
