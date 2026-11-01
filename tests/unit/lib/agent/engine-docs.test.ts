import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { AGENT_STATEMENT_LANGUAGE, type AgentStatementLanguageId } from "@/lib/agent/agent-manifest";
import { engineServerOverlay } from "@/lib/agent/languages/engines/server";
import type { DatabaseType } from "@/lib/types";

/**
 * The provider triad's agent leg (#1821): every engine that speaks a statement language documents its language pack in
 * its provider document, and that subsection is held to the overlay the server registry keeps, row for row.
 *
 * The subsection is the one heading `Agent language pack`, at whatever level and number the document's own scheme
 * gives it. It names the statement-language family and the overlay module, and its table holds one row per dialect
 * member (supplied or `"unsupported"`) and one per Shared member the overlay overrides, and no other row. A document
 * whose type speaks no statement language carries no such heading.
 *
 * `docs/AGENT.md`'s `## Language packs` is held to the resolvers by `tests/unit/agent-documentation.test.ts`.
 */

const ROOT = path.resolve(import.meta.dir, "../../../..");
const PROVIDER_DOCS = path.join(ROOT, "docs/providers");

const ENGINES = (Object.keys(AGENT_STATEMENT_LANGUAGE) as DatabaseType[]).filter(
  (type) => AGENT_STATEMENT_LANGUAGE[type] !== null,
);

const HEADING = /^(#{2,4}) (?:[0-9.]+ )?Agent language pack$/;

const NO_OVERRIDE_SENTENCE = "overrides no Shared member";

/** An engine's server overlay as the registry holds it: its dialect, if any, and any overridden Shared member. */
interface DocumentedOverlay {
  readonly dialect?: object;
  readonly [member: string]: unknown;
}

const overlayPath = (family: AgentStatementLanguageId, type: DatabaseType): string =>
  `src/lib/agent/languages/${family}/engines/${type}.ts`;

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

/** The `Agent language pack` headings of a document, outside fenced code. */
function packHeadings(text: string): { readonly level: number; readonly index: number }[] {
  const lines = text.split("\n");
  return headingsOf(lines).filter(({ index }) => HEADING.test(lines[index]));
}

/** The subsection under the one `Agent language pack` heading, up to the next heading of the same or a higher level. */
function packSection(text: string): string {
  const lines = text.split("\n");
  const [heading] = packHeadings(text);
  const next = headingsOf(lines).find(({ index, level }) => index > heading.index && level <= heading.level);
  return lines.slice(heading.index, next?.index ?? lines.length).join("\n");
}

/**
 * Every body row of every table in a section, each as its trimmed cells joined: a table's first two lines, its header
 * and separator, are skipped, and every other row counts, whatever its first cell holds.
 */
function tableRows(section: string): string[] {
  const lines = section.split("\n");
  return lines
    .filter(
      (line, index) => line.startsWith("|") && lines[index - 1]?.startsWith("|") && lines[index - 2]?.startsWith("|"),
    )
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim())
        .join(" | "),
    );
}

/** The rows an overlay requires: one per dialect member, then one per own non-dialect member. */
function expectedRows(overlay: DocumentedOverlay): string[] {
  const dialect = Object.entries(overlay.dialect ?? {}).map(
    ([member, value]) => `\`${member}\` | Dialect-bound | ${value === "unsupported" ? '`"unsupported"`' : "Supplied"}`,
  );
  const shared = Object.keys(overlay)
    .filter((member) => member !== "dialect")
    .map((member) => `\`${member}\` | Shared | Overridden`);
  return [...dialect, ...shared];
}

/** What a provider document gets wrong about one engine's language pack; empty when it holds. */
function sectionViolations(
  type: DatabaseType,
  family: AgentStatementLanguageId,
  overlay: DocumentedOverlay,
  text: string,
): string[] {
  const headings = packHeadings(text).length;
  if (headings !== 1) return [`${type}: ${headings} "Agent language pack" headings, not one`];
  const section = packSection(text);
  const violations: string[] = [];
  if (!section.includes(`Statement-language family: \`${family}\`.`)) violations.push(`${type}: no family sentence`);
  if (!section.includes(overlayPath(family, type))) violations.push(`${type}: no overlay path`);
  const rows = tableRows(section);
  const expected = expectedRows(overlay);
  for (const row of expected) if (!rows.includes(row)) violations.push(`${type}: missing row ${row}`);
  for (const row of rows) if (!expected.includes(row)) violations.push(`${type}: extra row ${row}`);
  const overrides = Object.keys(overlay).some((member) => member !== "dialect");
  if (overrides === section.includes(NO_OVERRIDE_SENTENCE)) {
    violations.push(`${type}: the "${NO_OVERRIDE_SENTENCE}" sentence does not match the overlay`);
  }
  const empty = Object.keys(overlay).length === 0;
  if (empty && !section.includes(`resolves to the \`${family}\` family pack itself`)) {
    violations.push(`${type}: no empty-overlay sentence`);
  }
  return violations;
}

const docOf = (type: string): string => readFileSync(path.join(PROVIDER_DOCS, `${type}.md`), "utf8");

const familyOf = (type: DatabaseType): AgentStatementLanguageId =>
  AGENT_STATEMENT_LANGUAGE[type] as AgentStatementLanguageId;

test("the engines are read from the manifest, and there are some", () => {
  expect(ENGINES.length).toBeGreaterThan(0);
});

describe.each(ENGINES)("%s", (type) => {
  const family = familyOf(type);

  test("its overlay module is where the triad rule says", () => {
    expect(existsSync(path.join(ROOT, overlayPath(family, type)))).toBe(true);
  });

  test("its provider document's Agent language pack subsection matches the overlay", () => {
    expect(sectionViolations(type, family, engineServerOverlay(type), docOf(type))).toEqual([]);
  });
});

test("no provider document whose type speaks no statement language carries the heading", () => {
  const silent = readdirSync(PROVIDER_DOCS)
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -".md".length))
    .filter((type) => Object.hasOwn(AGENT_STATEMENT_LANGUAGE, type))
    .filter((type) => AGENT_STATEMENT_LANGUAGE[type as DatabaseType] === null);
  // Non-vacuity: the null-family population is most of the providers.
  expect(silent).toContain("spark");
  expect(silent.filter((type) => packHeadings(docOf(type)).length > 0)).toEqual([]);
});

describe("each check fails when the document is wrong", () => {
  const duckdb = docOf("duckdb");
  const duckdbOverlay = engineServerOverlay("duckdb");
  const check = (text: string, overlay: DocumentedOverlay = duckdbOverlay) =>
    sectionViolations("duckdb", "sql", overlay, text);

  test("the shipped document passes, so every plant below is the only difference", () => {
    expect(check(duckdb)).toEqual([]);
  });

  test("a flipped value is a missing row and an extra row", () => {
    const planted = duckdb.replace(
      '| `profileComposition` | Dialect-bound | `"unsupported"` |',
      "| `profileComposition` | Dialect-bound | Supplied |",
    );
    expect(planted).not.toBe(duckdb);
    expect(check(planted)).toEqual([
      'duckdb: missing row `profileComposition` | Dialect-bound | `"unsupported"`',
      "duckdb: extra row `profileComposition` | Dialect-bound | Supplied",
    ]);
  });

  test("a dropped row is missing", () => {
    const planted = duckdb.replace('| `catalogCapture` | Dialect-bound | `"unsupported"` |\n', "");
    expect(check(planted)).toEqual(['duckdb: missing row `catalogCapture` | Dialect-bound | `"unsupported"`']);
  });

  test("a stray row is extra", () => {
    const planted = duckdb.replace(
      "| `catalogCapture` | Dialect-bound |",
      "| `grounding` | Shared | Overridden |\n| `catalogCapture` | Dialect-bound |",
    );
    expect(check(planted)).toEqual(["duckdb: extra row `grounding` | Shared | Overridden"]);
  });

  test("a stray row whose first cell has no backticks is extra too", () => {
    const planted = duckdb.replace(
      "| `catalogCapture` | Dialect-bound |",
      "| grounding | Shared | Overridden |\n| `catalogCapture` | Dialect-bound |",
    );
    expect(check(planted)).toEqual(["duckdb: extra row grounding | Shared | Overridden"]);
  });

  test("an override the document does not list is missing, and the no-override sentence is then false", () => {
    const overriding: DocumentedOverlay = { ...duckdbOverlay, answerNotADataRead: "planted" };
    expect(check(duckdb, overriding)).toEqual([
      "duckdb: missing row `answerNotADataRead` | Shared | Overridden",
      `duckdb: the "${NO_OVERRIDE_SENTENCE}" sentence does not match the overlay`,
    ]);
  });

  test("a missing family sentence, overlay path or second heading is named", () => {
    expect(check(duckdb.replace("Statement-language family: `sql`.", "Statement-language family: SQL."))).toEqual([
      "duckdb: no family sentence",
    ]);
    expect(check(duckdb.replaceAll(overlayPath("sql", "duckdb"), "elsewhere"))).toEqual(["duckdb: no overlay path"]);
    expect(check(`${duckdb}\n## Agent language pack\n`)).toEqual(['duckdb: 2 "Agent language pack" headings, not one']);
  });

  test("an empty overlay needs the sentence that it resolves to the family pack itself", () => {
    const mongodb = docOf("mongodb");
    expect(sectionViolations("mongodb", "mongo", {}, mongodb)).toEqual([]);
    expect(
      sectionViolations("mongodb", "mongo", {}, mongodb.replace("resolves to the `mongo` family pack itself", "")),
    ).toEqual(["mongodb: no empty-overlay sentence"]);
  });

  test("a heading inside fenced code is not a heading", () => {
    expect(packHeadings("```\n## Agent language pack\n```\n")).toEqual([]);
  });

  test("a stray heading in a document whose type speaks no statement language is found", () => {
    const spark = docOf("spark");
    expect(packHeadings(spark)).toEqual([]);
    expect(packHeadings(`${spark}\n### 9.9 Agent language pack\n`)).toHaveLength(1);
  });
});
