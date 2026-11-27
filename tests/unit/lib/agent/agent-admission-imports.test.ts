/**
 * Core's agent admission and composer of a statement language an engine declares as data read the language's data
 * alone: the engine-neutral admission (src/lib/db/operations/declared-request-form.ts), the generic read descriptor
 * builder (src/lib/db/operations/declared-language-read.ts), the composer of the language's client, server and MCP
 * facets (src/lib/agent/languages/declared-client.ts, declared-server.ts, declared-mcp.ts) and the projection of the
 * declared languages' data (src/lib/db/engine-catalog/statement-language.generated.ts) reach, by value import, no
 * module of any statement language and no provider module. A language's module is one under src/lib/languages/<language>/ or
 * src/lib/agent/languages/<language>/, or its admission src/lib/db/operations/<language>-admission.ts; the languages
 * are read from the tree, joined by every language a committed declaration or a provider package's manifest states
 * data for (tests/helpers/declared-language-census.ts) and by a crafted one, so the check names each of today's
 * language modules and still holds once a language's modules are gone or its engine has moved into a package.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { shippedLanguageData } from "../../../helpers/declared-language-census";
import { ACME_LANGUAGE_DATA } from "../../../helpers/package-catalog";
import { plantedRoot, removePlantedRoot } from "../../../helpers/planted-package";
import { valueImportClosure } from "../../../helpers/value-import-closure";

const ROOT = path.resolve(import.meta.dir, "../../../..");

/** The modules whose value import closures this test holds. */
const ENTRIES = [
  "src/lib/db/operations/declared-request-form.ts",
  "src/lib/db/operations/declared-language-read.ts",
  "src/lib/db/engine-catalog/statement-language.generated.ts",
  "src/lib/agent/languages/declared-client.ts",
  "src/lib/agent/languages/declared-server.ts",
  "src/lib/agent/languages/declared-mcp.ts",
];

/** The subdirectories of the repository directory `directory`. */
function subdirectories(directory: string): string[] {
  return readdirSync(path.join(ROOT, directory), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * Every statement language with a module in the tree, every language of `declared`, and the crafted `acmeread`.
 * `declared` is by default every language a committed declaration or a provider package's manifest states data for.
 */
function statementLanguages(declared: readonly { name: string }[] = shippedLanguageData()): string[] {
  const admissions = readdirSync(path.join(ROOT, "src/lib/db/operations"))
    .filter((file) => file.endsWith("-admission.ts"))
    .map((file) => file.slice(0, -"-admission.ts".length));
  return [
    ...new Set([
      ...subdirectories("src/lib/languages"),
      ...subdirectories("src/lib/agent/languages"),
      ...admissions,
      ...declared.map((data) => data.name),
      "acmeread",
    ]),
  ].sort();
}

/** The modules of `entry`'s value import closure that belong to one of `languages`, or to a provider. */
function languageModulesReached(entry: string, languages: readonly string[]): string[] {
  return valueImportClosure(entry).modules.filter(
    (module) =>
      module.startsWith("src/lib/db/providers/") ||
      languages.some(
        (language) =>
          module.startsWith(`src/lib/languages/${language}/`) ||
          module.startsWith(`src/lib/agent/languages/${language}/`) ||
          module === `src/lib/db/operations/${language}-admission.ts`,
      ),
  );
}

describe("the agent admission's imports", () => {
  test("the agent admission and the composer import no module of a statement language some engine declares as data", () => {
    const languages = statementLanguages();
    expect(languages).toContain("acmeread");
    // Kafka's language is read from its committed declaration's data alone: no module of it is left in the tree.
    expect(shippedLanguageData().map((data) => data.name)).toContain("kafkaread");
    expect(subdirectories("src/lib/agent/languages")).not.toContain("kafkaread");
    expect(languages).toContain("kafkaread");

    for (const entry of ENTRIES) {
      const closure = valueImportClosure(entry);
      expect({ entry, unresolved: closure.unresolved }).toEqual({ entry, unresolved: [] });
      expect({ entry, reached: languageModulesReached(entry, languages) }).toEqual({ entry, reached: [] });
    }

    // The control: a language's own admission reaches its language module, so the check is not vacuous.
    expect(languageModulesReached("src/lib/db/operations/oxiacli-admission.ts", languages)).toContain(
      "src/lib/languages/oxiacli/agent-statement.ts",
    );
  });

  test("a language a planted provider package states is among the languages held", () => {
    const planted = plantedRoot({
      copy: [],
      workspaces: true,
      linkNodeModules: false,
      files: {
        "src/lib/db/engine-declarations/acme.json": JSON.stringify({ id: "acme", statementLanguageData: null }),
        "packages/provider-sdk/package.json": JSON.stringify({ name: "@libredb/provider-sdk" }),
        "packages/provider-alpha/package.json": JSON.stringify({ name: "@libredb/provider-alpha" }),
        "packages/provider-alpha/libredb-provider.json": JSON.stringify({
          engines: [{ id: "alpha", statementLanguageData: { ...ACME_LANGUAGE_DATA, name: "alpharead" } }],
        }),
      },
    });
    try {
      const data = shippedLanguageData(planted);
      expect(data.map(({ name }) => name)).toEqual(["alpharead"]);
      const languages = statementLanguages(data);
      expect(languages).toContain("alpharead");
      expect(languages).toContain("acmeread");
      // The planted root holds no Kafka declaration, so its language comes only from the repository's.
      expect(languages).not.toContain("kafkaread");
    } finally {
      removePlantedRoot(planted);
    }
  });
});
