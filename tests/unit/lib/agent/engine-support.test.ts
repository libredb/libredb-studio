import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_EXECUTION_ENGINES, namedList } from "@/lib/agent/engine-support";
import { getDBConfig } from "@/lib/db-ui-config";
import { BaseDatabaseProvider } from "@/lib/db/base-provider";
import type { DatabaseType } from "@/lib/types";

/**
 * `AGENT_EXECUTION_ENGINES` is a CLAIM about the providers, not a second source of truth.
 * Since the `POST /api/agent/runs` pre-flight started refusing on it, a stale entry is no
 * longer a wrong sentence on the login hero - it is a 400 on a run the factory would have
 * executed, or a run admitted that the factory then kills with
 * `PROFILE_UNSUPPORTED_BY_PROVIDER`. The factory's real gate is
 * `acquisition.requiresReadOnlyStatements && typeof provider.queryReadOnly !== "function"`
 * (`src/lib/db/factory.ts`).
 *
 * So this file measures the providers instead of reciting the list a second time - a test
 * that repeats `["postgres", "sqlite"]` on both sides pins nothing. It closes the loop over
 * EVERY id in the `DatabaseType` union, and derives all three inputs from source:
 *
 * 1. the union itself, parsed out of `src/lib/types.ts` (the ids are erased at runtime);
 * 2. the module specifier and class name per id, parsed out of the `createProvider` switch
 *    in `src/lib/db/factory.ts` - the same map the factory dispatches on;
 * 3. `typeof Class.prototype.queryReadOnly`, read off the real class after importing it.
 *    Property lookup walks the prototype chain, so an implementation inherited from
 *    `SQLBaseProvider` counts exactly as the factory's `typeof provider.queryReadOnly`
 *    would count it.
 *
 * Adding `queryReadOnly` to any provider, adding a provider, or adding a `DatabaseType`
 * therefore fails this file until `AGENT_EXECUTION_ENGINES` is updated to match.
 *
 * ONE id escapes the prototype measurement: `mongodb`. Importing
 * `providers/document/mongodb.ts` pulls `mongodb` -> `bson`, which calls
 * `node:v8 isBuildingSnapshot` at import time; Bun answers
 * `NotImplementedError: node:v8 isBuildingSnapshot is not yet implemented in Bun`
 * (measured with bun 1.3.14). For that id the file falls back to a conservative source
 * scan: the module must not mention `queryReadOnly` at all, and its base class
 * (`BaseDatabaseProvider` in `src/lib/db/base-provider.ts`, which imports no driver) must
 * not carry one either. Any mention fails the test rather than being interpreted, so the
 * fallback can only be too strict.
 */

const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
const typesSource = readFileSync(join(repoRoot, "src", "lib", "types.ts"), "utf8");
const factorySource = readFileSync(join(repoRoot, "src", "lib", "db", "factory.ts"), "utf8");

/** Every member of the `DatabaseType` union, parsed from its declaration in `src/lib/types.ts`. */
function parseDatabaseTypes(): DatabaseType[] {
  const declaration = /export type DatabaseType =([\s\S]*?);\n/.exec(typesSource);
  if (!declaration) throw new Error("could not locate the DatabaseType declaration in src/lib/types.ts");
  const ids = [...declaration[1].matchAll(/^\s*\|\s*"([a-z]+)"/gm)].map((match) => match[1] as DatabaseType);
  if (ids.length === 0) throw new Error("parsed no ids out of the DatabaseType declaration");
  // A union arm whose id the `[a-z]+` class cannot spell (a digit, a hyphen) would be
  // dropped SILENTLY, and the factory scan below would drop it in the same way, so the
  // parity test would still pass and the new engine would go unmeasured. Counting the
  // arms independently of their spelling makes that a hard failure instead.
  const arms = [...declaration[1].matchAll(/^\s*\|/gm)].length;
  if (arms !== ids.length) {
    throw new Error(`the DatabaseType declaration has ${arms} arms but ${ids.length} parsed as ids`);
  }
  return ids;
}

/** type-id -> { class name, module specifier }, parsed from the `createProvider` switch. */
function parseFactoryDispatch(): Map<DatabaseType, { exportName: string; specifier: string }> {
  const dispatch = new Map<DatabaseType, { exportName: string; specifier: string }>();
  // `(?:(?!case ")[\s\S])*?` instead of a bare `[\s\S]*?`: a lazy any-run would let a case
  // that constructs its provider WITHOUT its own `await import(...)` borrow the specifier of
  // the NEXT case, silently measuring the wrong provider class for it. Refusing to cross a
  // `case "` boundary makes such a case fail to parse, which the union-parity test below
  // then reports as a missing id.
  const cases = factorySource.matchAll(
    /case "([a-z]+)": \{(?:(?!case ")[\s\S])*?const \{ (\w+) \} = await import\("(\.[^"]+)"\)/g,
  );
  for (const [, id, exportName, specifier] of cases) {
    dispatch.set(id as DatabaseType, { exportName, specifier });
  }
  if (dispatch.size === 0) throw new Error("parsed no cases out of the createProvider switch");
  return dispatch;
}

const databaseTypes = parseDatabaseTypes();
const dispatch = parseFactoryDispatch();

/** The one id whose module cannot be imported under Bun - see the file header. */
const UNIMPORTABLE: DatabaseType = "mongodb";

async function hasReadOnlyPath(type: DatabaseType): Promise<boolean> {
  const entry = dispatch.get(type);
  if (!entry) throw new Error(`no createProvider case for "${type}"`);
  const modulePath = join(repoRoot, "src", "lib", "db", entry.specifier);

  if (type === UNIMPORTABLE) {
    const source = readFileSync(`${modulePath}.ts`, "utf8");
    expect({ id: type, mentionsQueryReadOnly: source.includes("queryReadOnly") }).toEqual({
      id: type,
      mentionsQueryReadOnly: false,
    });
    return false;
  }

  const imported = (await import(modulePath)) as Record<string, unknown>;
  const exported = imported[entry.exportName];
  if (typeof exported !== "function") {
    throw new Error(`${entry.specifier} exports no class named ${entry.exportName}`);
  }
  const prototype = (exported as { prototype: { queryReadOnly?: unknown } }).prototype;
  return typeof prototype.queryReadOnly === "function";
}

describe("AGENT_EXECUTION_ENGINES", () => {
  test("the factory dispatches on exactly the DatabaseType union", () => {
    expect([...dispatch.keys()].sort()).toEqual([...databaseTypes].sort());
  });

  test("every listed engine is a real DatabaseType", () => {
    for (const type of AGENT_EXECUTION_ENGINES) {
      expect(databaseTypes).toContain(type);
    }
  });

  test("the base class that mongodb inherits from exposes no read-only path", () => {
    expect(typeof (BaseDatabaseProvider.prototype as { queryReadOnly?: unknown }).queryReadOnly).not.toBe("function");
  });

  test("names exactly the engines whose provider offers queryReadOnly", async () => {
    const results = await Promise.all(databaseTypes.map(hasReadOnlyPath));
    const measured = databaseTypes.filter((_, index) => results[index]);
    expect(measured.sort()).toEqual([...AGENT_EXECUTION_ENGINES].sort());
  });
});

/**
 * The engine list is now THREE names long, and "A and B and C" is what a two-name join
 * produces when a third engine arrives. Both surfaces that print it - the login hero
 * (`src/components/login/hero-proof.tsx`) and the agent posture popover
 * (`src/lib/agent/posture.ts`) - carried their own copy of that join, so the next engine
 * would have reopened it in two places. One helper, tested here, is what closes it.
 */
describe("namedList", () => {
  test("one name is itself and two are joined with 'and'", () => {
    expect(namedList([])).toBe("");
    expect(namedList(["PostgreSQL"])).toBe("PostgreSQL");
    expect(namedList(["PostgreSQL", "SQLite"])).toBe("PostgreSQL and SQLite");
  });

  test("three or more read as a list, not as a chain of 'and'", () => {
    expect(namedList(["PostgreSQL", "SQLite", "DuckDB"])).toBe("PostgreSQL, SQLite and DuckDB");
    expect(namedList(["a", "b", "c", "d"])).toBe("a, b, c and d");
  });

  test("the engines agent mode executes on read as one list", () => {
    // Derived from the array rather than typed out, so this stays true of the next engine
    // and fails only if the JOIN regresses.
    const names = AGENT_EXECUTION_ENGINES.map((type) => getDBConfig(type).label);
    const sentence = namedList(names);

    for (const name of names) expect(sentence).toContain(name);
    expect(sentence.match(/ and /g)?.length).toBe(1);
  });
});
