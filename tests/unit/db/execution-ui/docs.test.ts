import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { EXECUTION_UI } from "@/lib/db/execution-ui";
import { ALIAS_ENGINES } from "@/lib/sql/fence-tags";
import type { DatabaseType } from "@/lib/types";

/**
 * The provider triad's execution UI leg: every provider document carries one `Execution UI` subsection, at whatever
 * level the document's own scheme gives it, and that subsection says what the engine's declaration states. The keyword
 * the rolled-back notice names, a link to the declaration that states its row, the consent card's deadline chip and
 * sentence verbatim (or that the engine has no consent deadline), and every fence tag that names the engine: its id and
 * each of its `editor.fenceAliases`.
 */

const ROOT = path.resolve(import.meta.dir, "../../../..");
const PROVIDER_DOCS = path.join(ROOT, "docs/providers");

const ENGINES = Object.keys(EXECUTION_UI) as DatabaseType[];

const HEADING = /^#{2,4} Execution UI$/;

/** The fence tags that name `type`: its id, and each alias `ALIAS_ENGINES` maps to it. */
const fenceTagsOf = (type: DatabaseType): string[] => [
  type,
  ...Object.keys(ALIAS_ENGINES).filter((alias) => ALIAS_ENGINES[alias] === type),
];

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
    expect([...ENGINES].sort()).toEqual([...SHIPPED_DATABASE_TYPES].sort());
  });

  for (const type of ENGINES) {
    describe(type, () => {
      const spec = EXECUTION_UI[type];

      test("names the keyword the rolled-back notice names", () => {
        expect(sectionOf(type)).toContain(`\`${spec.commitKeyword}\``);
      });

      test("links the declaration that states its row", () => {
        expect(sectionOf(type)).toContain(`[\`${type}.json\`](../../src/lib/db/engine-declarations/${type}.json)`);
      });

      test("names every fence tag that names the engine", () => {
        const section = sectionOf(type);
        expect(fenceTagsOf(type).filter((tag) => !section.includes(`\`${tag}\``))).toEqual([]);
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
