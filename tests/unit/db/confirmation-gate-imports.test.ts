/**
 * The confirmation gate reads a statement language some engine declares as data through the one engine-neutral check,
 * never through a module of that language: once an engine states its `statementLanguageData`, no module of the gate
 * imports the language's family module or the provider's own `destructive.ts` for it (PLAN M4's exit test).
 *
 * The gate's modules are the entries below; each is walked with tests/helpers/value-import-closure.ts, so a type-only
 * import is left out and a re-export is counted. The declared languages are read from the committed declarations and
 * from every provider package's manifest (tests/helpers/declared-language-census.ts), so a language a package states
 * is held the day the package lands. A language's modules are every file under `src/lib/languages/<name>/` and
 * `src/lib/db/graph/<name>/` (Cypher's family module), and the `destructive.ts` beside the engine's legacy provider or,
 * for a package's engine, every file under the package's directory. That package branch matches a closure member by
 * its path, so it sees a package module the gate reaches by a path; a gate module importing the package by its name is
 * refused by tests/unit/package-imports.test.ts ("core imports no provider package, by name or by path"), and the two
 * tests hold the package case together. Kafka's declaration states its language, kafkaread, as data, so the check
 * runs on a real declaration; the controls below plant other engines' languages to show it names a gate module of
 * each kind.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseType } from "@/lib/types";
import { shippedStatementLanguages } from "../../helpers/declared-language-census";
import { ACME_LANGUAGE_DATA } from "../../helpers/package-catalog";
import { plantedRoot, removePlantedRoot } from "../../helpers/planted-package";
import { providerTriad } from "../../helpers/provider-layout";
import { valueImportClosure } from "../../helpers/value-import-closure";

const ROOT = path.join(import.meta.dir, "..", "..", "..");

/**
 * The modules that classify a statement for the confirmation gate, on the server and in the browser, and the modules
 * that compose or read an engine's statement language row: the two composers of the server's engine records and the
 * editor query's text bound.
 */
const GATE_MODULES = [
  "src/lib/api/run-confirmation.ts",
  "src/lib/editor/statement-analysis.ts",
  "src/lib/sql/dangerous-query.ts",
  "src/lib/db/destructive-commands.ts",
  "src/lib/db/statement-language-row.ts",
  "src/lib/provider-host/legacy-adapter/records.ts",
  "src/lib/db/server-catalog-compose.ts",
  "src/lib/api/editor-query.ts",
] as const;

/** An engine that states its statement language as data, and the language's name. */
interface DeclaredLanguage {
  readonly engine: string;
  readonly name: string;
  readonly packageDirectory?: string;
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

/**
 * Every engine under `root` that states its statement language data, in a committed declaration or in a provider
 * package's manifest (tests/helpers/declared-language-census.ts), with the language's name and, for a package's
 * engine, the package's directory.
 */
function declaredLanguages(root: string = ROOT): DeclaredLanguage[] {
  return shippedStatementLanguages(root).map(({ engine, source, directory, data }) =>
    source === "package" ? { engine, name: data.name, packageDirectory: directory } : { engine, name: data.name },
  );
}

/** `file` repository-relative, with forward slashes on every platform. */
function repoRelative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

/**
 * The members of `closure` that are a module of a language in `declared`: a file under the language's family
 * directory, any file under the provider package's directory for a package's engine, or the `destructive.ts` of the
 * engine's legacy provider where its code is a directory.
 *
 * @throws {Error} Naming the engine, where a declared legacy engine's provider code is missing.
 */
function declaredLanguageModules(closure: readonly string[], declared: readonly DeclaredLanguage[]): string[] {
  return closure.filter((member) =>
    declared.some(({ engine, name, packageDirectory }) => {
      if (member.startsWith(`src/lib/languages/${name}/`) || member.startsWith(`src/lib/db/graph/${name}/`)) {
        return true;
      }
      if (packageDirectory !== undefined) return member.startsWith(`${packageDirectory}/`);
      const code = providerTriad(ROOT, engine as DatabaseType).code;
      if (!existsSync(code)) {
        throw new Error(
          `The engine ${engine} declares its statement language ${name} as data, but its provider code ${repoRelative(code)} is missing, so this check cannot tell whether the gate imports that code's destructive.ts.`,
        );
      }
      return statSync(code).isDirectory() && member === repoRelative(path.join(code, "destructive.ts"));
    }),
  );
}

describe("the confirmation gate's imports", () => {
  test("the confirmation gate imports no module of a statement language some engine declares as data", () => {
    const declared = declaredLanguages();
    expect(declared).toEqual([{ engine: "kafka", name: "kafkaread" }]);
    const closure = gateClosure();
    expect(declaredLanguageModules(closure, declared)).toEqual([]);

    // Vacuity: the walk reaches the language modules the gate imports today, so an empty answer is not an empty walk.
    expect(closure).toContain("src/lib/languages/rabbitread/destructive.ts");
    expect(closure).toContain("src/lib/db/providers/keyvalue/etcd/destructive.ts");
    for (const entry of GATE_MODULES) expect(closure).toContain(entry);
  });

  test("the check names a gate module of a crafted declared language", () => {
    const closure = gateClosure();
    expect(declaredLanguageModules(closure, [{ engine: "rabbitmq", name: "rabbitread" }])).toContain(
      "src/lib/languages/rabbitread/destructive.ts",
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

  test("a statement language a provider package's manifest states is read as a declared language", () => {
    const planted = plantedRoot({
      copy: [],
      workspaces: true,
      linkNodeModules: false,
      files: {
        "src/lib/db/engine-declarations/acme.json": JSON.stringify({ id: "acme", statementLanguageData: null }),
        "packages/provider-sdk/package.json": JSON.stringify({ name: "@libredb/provider-sdk" }),
        "packages/provider-alpha/package.json": JSON.stringify({ name: "@libredb/provider-alpha" }),
        "packages/provider-alpha/libredb-provider.json": JSON.stringify({
          engines: [
            { id: "alpha", statementLanguageData: { ...ACME_LANGUAGE_DATA, name: "alpharead" } },
            { id: "alphatwo", statementLanguageData: null },
          ],
        }),
      },
    });
    try {
      expect(declaredLanguages(planted)).toEqual([
        { engine: "alpha", name: "alpharead", packageDirectory: "packages/provider-alpha" },
      ]);
      // A package language's modules are the gate's closure members under its package's directory.
      expect(
        declaredLanguageModules(gateClosure(), [
          { engine: "alpha", name: "alpharead", packageDirectory: "src/lib/api" },
        ]),
      ).toContain("src/lib/api/run-confirmation.ts");

      rmSync(path.join(planted, "packages/provider-alpha/libredb-provider.json"));
      expect(() => declaredLanguages(planted)).toThrow(
        "The provider package packages/provider-alpha has no libredb-provider.json",
      );
      writeFileSync(
        path.join(planted, "packages/provider-alpha/libredb-provider.json"),
        JSON.stringify({ engines: {} }),
      );
      expect(() => declaredLanguages(planted)).toThrow(
        "packages/provider-alpha/libredb-provider.json has no engines array",
      );
      writeFileSync(
        path.join(planted, "packages/provider-alpha/libredb-provider.json"),
        JSON.stringify({ engines: [{ id: "alpha" }] }),
      );
      expect(() => declaredLanguages(planted)).toThrow(
        "packages/provider-alpha/libredb-provider.json states no statementLanguageData for the engine alpha",
      );
    } finally {
      removePlantedRoot(planted);
    }
  });
});
