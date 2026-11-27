/**
 * Core's agent admission of a statement language an engine declares as data reads the language's data alone: the
 * engine-neutral admission (src/lib/db/operations/declared-request-form.ts) and the generic read descriptor builder
 * (src/lib/db/operations/declared-language-read.ts) reach, by value import, no module of any statement language and no
 * provider module. A language's module is one under src/lib/languages/<language>/ or src/lib/agent/languages/<language>/,
 * or its admission src/lib/db/operations/<language>-admission.ts; the languages are read from the tree, joined by every
 * language a shipped declaration states data for and by a crafted one, so the check names each of today's language
 * modules and still holds once a language's modules are gone.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { shippedLanguageData } from "../../../helpers/declared-language-census";
import { valueImportClosure } from "../../../helpers/value-import-closure";

const ROOT = path.resolve(import.meta.dir, "../../../..");

/** The modules whose value import closures this test holds. */
const ENTRIES = ["src/lib/db/operations/declared-request-form.ts", "src/lib/db/operations/declared-language-read.ts"];

/** The subdirectories of the repository directory `directory`. */
function subdirectories(directory: string): string[] {
  return readdirSync(path.join(ROOT, directory), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * Every statement language with a module in the tree, every language a shipped declaration states data for, and the
 * crafted `acmeread`.
 */
function statementLanguages(): string[] {
  const admissions = readdirSync(path.join(ROOT, "src/lib/db/operations"))
    .filter((file) => file.endsWith("-admission.ts"))
    .map((file) => file.slice(0, -"-admission.ts".length));
  return [
    ...new Set([
      ...subdirectories("src/lib/languages"),
      ...subdirectories("src/lib/agent/languages"),
      ...admissions,
      ...shippedLanguageData().map((data) => data.name),
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
    expect(languages).toContain("kafkaread");

    for (const entry of ENTRIES) {
      const closure = valueImportClosure(entry);
      expect({ entry, unresolved: closure.unresolved }).toEqual({ entry, unresolved: [] });
      expect({ entry, reached: languageModulesReached(entry, languages) }).toEqual({ entry, reached: [] });
    }

    // The control: a language's own admission reaches its language module, so the check is not vacuous.
    expect(languageModulesReached("src/lib/db/operations/kafkaread-admission.ts", languages)).toContain(
      "src/lib/languages/kafkaread/agent-statement.ts",
    );
  });
});
