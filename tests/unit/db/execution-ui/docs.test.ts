import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { EXECUTION_UI } from "@/lib/db/execution-ui";
import type { DatabaseType } from "@/lib/types";

/**
 * The provider triad's execution UI leg: every provider document carries one `Execution UI` subsection, at whatever
 * level the document's own scheme gives it, and that subsection says what the engine's `EXECUTION_UI` row declares.
 * The keyword the rolled-back notice names, the module that declares the row, and the consent card's deadline chip
 * and sentence verbatim (or that the engine has no consent deadline).
 */

const ROOT = path.resolve(import.meta.dir, "../../../..");
const PROVIDER_DOCS = path.join(ROOT, "docs/providers");
const PROVIDERS = path.join(ROOT, "src/lib/db/providers");

const ENGINES = Object.keys(EXECUTION_UI) as DatabaseType[];

const HEADING = /^#{2,4} Execution UI$/;

/** Every module file under the provider layer whose basename ends in `execution-ui.ts`, by its basename. */
const MODULE_BASENAMES: readonly string[] = (readdirSync(PROVIDERS, { recursive: true }) as string[])
  .map((file) => path.basename(file))
  .filter((name) => name.endsWith("execution-ui.ts"));

/** The basename of the module that declares a type's row: `<type-id>-execution-ui.ts` beside a flat provider file. */
const moduleBasenameOf = (type: DatabaseType): string =>
  MODULE_BASENAMES.includes(`${type}-execution-ui.ts`) ? `${type}-execution-ui.ts` : "execution-ui.ts";

/** The headings outside fenced code, each with its level and line index. */
function headingsOf(lines: readonly string[]): { readonly level: number; readonly index: number }[] {
  const headings: { level: number; index: number }[] = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (line.startsWith("```")) fenced = !fenced;
    const match = fenced ? null : /^(#{1,6}) /.exec(line);
    if (match !== null) headings.push({ level: match[1].length, index });
  });
  return headings;
}

/** Every `Execution UI` subsection of a document, each up to the next heading of the same or a higher level. */
function executionUiSections(text: string): string[] {
  const lines = text.split("\n");
  const headings = headingsOf(lines);
  return headings
    .filter(({ index }) => HEADING.test(lines[index]))
    .map((heading) => {
      const next = headings.find(({ index, level }) => index > heading.index && level <= heading.level);
      return lines.slice(heading.index, next?.index ?? lines.length).join("\n");
    });
}

const sectionOf = (type: DatabaseType): string => {
  const sections = executionUiSections(readFileSync(path.join(PROVIDER_DOCS, `${type}.md`), "utf8"));
  expect(sections).toHaveLength(1);
  return sections[0];
};

describe("each provider document's Execution UI subsection", () => {
  test("covers every engine the registry has a row for", () => {
    expect(ENGINES).toHaveLength(43);
  });

  for (const type of ENGINES) {
    describe(type, () => {
      const spec = EXECUTION_UI[type];

      test("names the keyword the rolled-back notice names", () => {
        expect(sectionOf(type)).toContain(`\`${spec.commitKeyword}\``);
      });

      test("links the module that declares its row", () => {
        expect(sectionOf(type)).toContain(`[\`${moduleBasenameOf(type)}\`](`);
      });

      test("quotes the consent card's deadline chip and sentence, or says it has none", () => {
        const section = sectionOf(type);
        if (spec.consentDeadline === null) {
          expect(section).toContain("no consent deadline");
          return;
        }
        expect(section).toContain(spec.consentDeadline.chip);
        expect(section).toContain(spec.consentDeadline.sentence);
      });
    });
  }

  test("only redis names a keyword other than COMMIT, and only sqlite has a consent deadline", () => {
    expect(ENGINES.filter((type) => EXECUTION_UI[type].commitKeyword !== "COMMIT")).toEqual(["redis"]);
    expect(ENGINES.filter((type) => EXECUTION_UI[type].consentDeadline !== null)).toEqual(["sqlite"]);
  });
});
