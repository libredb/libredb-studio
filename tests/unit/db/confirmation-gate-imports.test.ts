/**
 * The confirmation gate reads a statement language some engine declares as data through the one engine-neutral check,
 * never through a module of that language: once an engine states its `statementLanguageData`, no module of the gate
 * imports the language's family module or the provider's own `destructive.ts` for it (PLAN M4's exit test).
 *
 * The gate's modules are the entries below; each is walked with tests/helpers/value-import-closure.ts, so a type-only
 * import is left out and a re-export is counted. A language's modules are every file under `src/lib/languages/<name>/`
 * and `src/lib/db/graph/<name>/` (Cypher's family module), and the `destructive.ts` beside the engine's legacy
 * provider. Every legacy declaration states null today, so the check is proven against crafted declarations until
 * the first language is written as data.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseType } from "@/lib/types";
import { workspacePackageDirectories } from "../../../scripts/workspace-packages.mjs";
import { providerTriad } from "../../helpers/provider-layout";
import { valueImportClosure } from "../../helpers/value-import-closure";

const ROOT = path.join(import.meta.dir, "..", "..", "..");

/** The modules that classify a statement for the confirmation gate, on the server and in the browser. */
const GATE_MODULES = [
  "src/lib/api/run-confirmation.ts",
  "src/lib/editor/statement-analysis.ts",
  "src/lib/sql/dangerous-query.ts",
  "src/lib/db/destructive-commands.ts",
  "src/lib/db/statement-language-row.ts",
] as const;

/** An engine that states its statement language as data, and the language's name. */
interface DeclaredLanguage {
  readonly engine: string;
  readonly name: string;
}

/** Every module the gate's entries reach by value, repository-relative and sorted. */
function gateClosure(): string[] {
  const modules = new Set<string>();
  for (const entry of GATE_MODULES) {
    const closure = valueImportClosure(entry);
    expect([entry, closure.unresolved]).toEqual([entry, []]);
    for (const reached of closure.modules) modules.add(reached);
  }
  return [...modules].sort();
}

/** Every committed engine declaration that states its statement language data, with the language's name. */
function declaredLanguages(): DeclaredLanguage[] {
  const directory = path.join(ROOT, "src", "lib", "db", "engine-declarations");
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .flatMap((file) => {
      const declaration = JSON.parse(readFileSync(path.join(directory, file), "utf8")) as {
        id: string;
        statementLanguageData: { name: string } | null;
      };
      const data = declaration.statementLanguageData;
      return data === null ? [] : [{ engine: declaration.id, name: data.name }];
    });
}

/** `file` repository-relative, with forward slashes on every platform. */
function repoRelative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

/**
 * The members of `closure` that are a module of a language in `declared`: a file under the language's family
 * directory, or the `destructive.ts` of the engine's legacy provider where its code is a directory.
 */
function declaredLanguageModules(closure: readonly string[], declared: readonly DeclaredLanguage[]): string[] {
  return closure.filter((member) =>
    declared.some(({ engine, name }) => {
      if (member.startsWith(`src/lib/languages/${name}/`) || member.startsWith(`src/lib/db/graph/${name}/`)) {
        return true;
      }
      const code = providerTriad(ROOT, engine as DatabaseType).code;
      return statSync(code).isDirectory() && member === repoRelative(path.join(code, "destructive.ts"));
    }),
  );
}

describe("the confirmation gate's imports", () => {
  test("the confirmation gate imports no module of a statement language some engine declares as data", () => {
    // A provider package states its language in its manifest, which this test reads from the day one ships.
    const providerPackages = workspacePackageDirectories(ROOT).filter(
      (directory: string) => directory.startsWith("packages/provider-") && directory !== "packages/provider-sdk",
    );
    expect(providerPackages).toEqual([]);

    const declared = declaredLanguages();
    console.log(`declared statement languages: ${JSON.stringify(declared)}`);
    const closure = gateClosure();
    expect(declaredLanguageModules(closure, declared)).toEqual([]);

    // Vacuity: the walk reaches the language modules the gate imports today, so an empty answer is not an empty walk.
    expect(closure).toContain("src/lib/languages/kafkaread/destructive.ts");
    expect(closure).toContain("src/lib/db/providers/keyvalue/etcd/destructive.ts");
    for (const entry of GATE_MODULES) expect(closure).toContain(entry);
  });

  test("the check names a gate module of a crafted declared language", () => {
    const closure = gateClosure();
    expect(declaredLanguageModules(closure, [{ engine: "kafka", name: "kafkaread" }])).toContain(
      "src/lib/languages/kafkaread/destructive.ts",
    );
    expect(declaredLanguageModules(closure, [{ engine: "etcd", name: "etcdctl" }])).toEqual([
      "src/lib/db/providers/keyvalue/etcd/destructive.ts",
    ]);
    expect(declaredLanguageModules(closure, [{ engine: "neo4j", name: "cypher" }])).toContain(
      "src/lib/db/graph/cypher/destructive.ts",
    );
    // A language the gate reaches no module of is not named.
    expect(existsSync(path.join(ROOT, "src", "lib", "languages", "nolanguage"))).toBe(false);
    expect(declaredLanguageModules(closure, [{ engine: "postgres", name: "nolanguage" }])).toEqual([]);
  });
});
