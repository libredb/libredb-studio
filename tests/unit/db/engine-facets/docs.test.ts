import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ENGINE_FACETS } from "@/lib/db/engine-facets";
import { MONITORING_PANELS } from "@/lib/db/engine-facets/types";
import type { DatabaseType } from "@/lib/types";

/**
 * The provider triad's engine facets leg: every provider document carries one `Engine facets` subsection, at whatever
 * level the document's own scheme gives it, which links the module that declares the engine's `ENGINE_FACETS` row and
 * states, in a table, each of the seven monitoring panels as offered (`Yes`) or not (`No`) exactly as the row does.
 */

const ROOT = path.resolve(import.meta.dir, "../../../..");
const PROVIDER_DOCS = path.join(ROOT, "docs/providers");
const PROVIDERS = path.join(ROOT, "src/lib/db/providers");

const ENGINES = Object.keys(ENGINE_FACETS) as DatabaseType[];

const HEADING = /^#{2,4}( [0-9.]+)? Engine facets$/;

/** Every row module under the provider layer, by its path relative to the provider layer. */
const ROW_MODULES: readonly string[] = (readdirSync(PROVIDERS, { recursive: true }) as string[]).filter((file) =>
  file.endsWith("engine-facets.ts"),
);

/** The provider-layer path of the module that declares a type's row. */
function rowModuleOf(type: DatabaseType): string {
  const matches = ROW_MODULES.filter(
    (file) => path.basename(file) === `${type}-engine-facets.ts` || file.endsWith(`/${type}/engine-facets.ts`),
  );
  if (matches.length !== 1) throw new Error(`${type}: ${matches.length} row modules found`);
  return matches[0];
}

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

/** Every `Engine facets` subsection of a document, each up to the next heading of the same or a higher level. */
function engineFacetsSections(text: string): string[] {
  const lines = text.split("\n");
  const headings = headingsOf(lines);
  return headings
    .filter(({ index }) => HEADING.test(lines[index]))
    .map((heading) => {
      const next = headings.find(({ index, level }) => index > heading.index && level <= heading.level);
      return lines.slice(heading.index, next?.index ?? lines.length).join("\n");
    });
}

const docOf = (type: DatabaseType): string => readFileSync(path.join(PROVIDER_DOCS, `${type}.md`), "utf8");

/** The first two cells of each body row of the section's monitoring panel table. */
function panelRows(section: string): [string, string][] {
  const lines = section.split("\n");
  const header = lines.findIndex((line) => /^\| Monitoring panel \| Offered \|/.test(line));
  if (header === -1) return [];
  const rows: [string, string][] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").map((cell) => cell.trim());
    rows.push([cells[1], cells[2]]);
  }
  return rows;
}

describe("each provider document's Engine facets subsection", () => {
  test("covers every engine the registry has a row for", () => {
    expect(ENGINES).toHaveLength(43);
  });

  test("every provider doc carries exactly one Engine facets heading", () => {
    const counts = Object.fromEntries(ENGINES.map((type) => [type, engineFacetsSections(docOf(type)).length]));
    expect(counts).toEqual(Object.fromEntries(ENGINES.map((type) => [type, 1])));
  });

  test.each(ENGINES)("docs/providers/%s.md states the monitoring panels its engine offers", (type) => {
    const [section] = engineFacetsSections(docOf(type));
    const rowModule = rowModuleOf(type);
    expect(section).toContain(`[\`${path.basename(rowModule)}\`](../../src/lib/db/providers/${rowModule})`);
    expect(panelRows(section)).toEqual(
      MONITORING_PANELS.map((panel) => [
        `\`${panel}\``,
        ENGINE_FACETS[type].monitoring[panel] === "offered" ? "Yes" : "No",
      ]),
    );
  });
});
