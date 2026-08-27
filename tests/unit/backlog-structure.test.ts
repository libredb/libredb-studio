/**
 * Structural guards for `docs/BACKLOG.md`.
 *
 * The file states its own rules and nothing measured them. Two of those rules broke on `main`
 * within one day of each other, both by the same mechanism, and every CI check stayed green:
 *
 *  - **Ids collided.** #511 and #513 branched from the same commit and each appended three driver
 *    entries. The bodies landed at different offsets, so git merged them without a conflict and
 *    `main` carried `D36`, `D37` and `D38` twice. The file's own rule is that "Every ID is unique
 *    across the whole file. Cross-references use the bare ID (`B47`)" — a duplicate id makes every
 *    such reference ambiguous, and the citation guard in `tests/unit/agent-documentation.test.ts`
 *    only ever asked whether an id EXISTS.
 *  - **An index line lost its basis.** The one line both branches did edit conflicted, and the
 *    resolution dropped its range and count altogether. A section index that says nothing cannot be
 *    wrong, which is exactly why nothing caught it.
 *
 * So these tests derive the index block from the entry bodies rather than trusting it: the sections
 * listed are the sections present, each listed id exists, each range's endpoints are the real
 * extremes, and the trailing count is the real number of entries. The endpoints are checked as
 * extremes rather than as a canonical rendering because the file writes a prefix's entries as
 * `X2–X14` in one section and as bare ids in another, and both are legitimate. The examples in
 * this file are illustrative rather than pinned: a closed entry changes them, so they are written
 * as shapes and the assertions derive the real ones from the document.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const BACKLOG_PATH = "docs/BACKLOG.md";
const BACKLOG = readFileSync(path.join(ROOT, BACKLOG_PATH), "utf8");

/** `AU4` is prefix `AU` and number 4, not prefix `A`: the prefix match is greedy on purpose. */
const ID_PATTERN = /^([A-Z]+)(\d+)$/;

interface BacklogId {
  readonly id: string;
  readonly prefix: string;
  readonly number: number;
}

const parseId = (id: string): BacklogId => {
  const match = ID_PATTERN.exec(id);
  if (match === null) throw new Error(`backlog id ${id} is not <PREFIX><NUMBER>`);
  return { id, prefix: match[1], number: Number(match[2]) };
};

interface Section {
  readonly title: string;
  readonly ids: readonly BacklogId[];
}

/** GitHub's heading slug, which is what the index block's `(#anchor)` has to match. */
const slug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

const sections: readonly Section[] = BACKLOG.split(/^## /m)
  .slice(1)
  .map((block) => {
    const title = block.slice(0, block.indexOf("\n")).trim();
    const ids = [...block.matchAll(/^### ([A-Z]+\d+)\./gm)].map((match) => parseId(match[1]));
    return { title, ids };
  });

interface IndexLine {
  readonly title: string;
  readonly anchor: string;
  /** The `— …` tail: the id ranges and the optional `· N` count. `null` when the line has none. */
  readonly spec: string | null;
}

const indexBlock = BACKLOG.split(/^\*\*Sections\*\*$/m)[1]?.split(/^---$/m)[0] ?? "";
const indexLines: readonly IndexLine[] = [...indexBlock.matchAll(/^- \[([^\]]+)\]\(#([^)]+)\)(?: — (.+))?$/gm)].map(
  (match) => ({ title: match[1], anchor: match[2], spec: match[3] ?? null }),
);

describe("the file was parsed at all", () => {
  // Every assertion below is a containment or an equality that an empty parse would satisfy
  // vacuously, so the parse is pinned first.
  test("the section headings were found", () => {
    expect(sections.length).toBeGreaterThan(15);
  });

  test("the entries were found", () => {
    expect(sections.flatMap((section) => section.ids).length).toBeGreaterThan(100);
  });

  test("the index block was found", () => {
    expect(indexLines.length).toBe(sections.length);
  });
});

describe("every id is unique across the whole file", () => {
  test("the rule the file states about itself holds", () => {
    expect(BACKLOG).toContain("Every ID is unique across the whole file");
  });

  test("no id is used twice", () => {
    const seen = new Map<string, string[]>();
    for (const section of sections) {
      for (const { id } of section.ids) {
        seen.set(id, [...(seen.get(id) ?? []), section.title]);
      }
    }
    const duplicates = [...seen.entries()].filter(([, where]) => where.length > 1);
    expect(duplicates).toEqual([]);
  });
});

describe("the section index names the sections that exist", () => {
  test.each(indexLines.map((line) => [line.title, line.anchor] as const))(
    "the index entry for %s resolves to a heading",
    (title, anchor) => {
      const titles = sections.map((section) => section.title);
      expect(titles).toContain(title);
      expect(anchor).toBe(slug(title));
    },
  );

  test.each(sections.map((section) => section.title))("the section %s is listed in the index", (title) => {
    expect(indexLines.map((line) => line.title)).toContain(title);
  });
});

interface Spec {
  /** Every id token the line lists, range endpoints included. */
  readonly listed: readonly BacklogId[];
  /** The `· N` tail, or `null` when the line carries no count. */
  readonly count: number | null;
}

/** `D1–D39, U17, U22 · 14` becomes the four endpoints it names plus the count 14. */
const parseSpec = (spec: string): Spec => {
  const [ranges, ...rest] = spec.split(" · ");
  return {
    listed: [...ranges.matchAll(/[A-Z]+\d+/g)].map((match) => parseId(match[0])),
    count: rest.length === 0 ? null : Number(rest[0]),
  };
};

describe("every index line is derived from the entries it summarises", () => {
  const rows = indexLines.map((line) => {
    const section = sections.find((candidate) => candidate.title === line.title);
    return { line, ids: section?.ids ?? [], spec: line.spec === null ? null : parseSpec(line.spec) };
  });

  test.each(rows.map((row) => [row.line.title, row] as const))("%s states a range and a count", (_title, row) => {
    // A line with no tail cannot be wrong, which is how the Drivers line survived losing both
    // (#513's merge). One entry is the only case that needs neither.
    if (row.ids.length > 1) expect(row.spec).not.toBeNull();
    if (row.spec === null) expect(row.ids.length).toBe(1);
  });

  test.each(rows.map((row) => [row.line.title, row] as const))("%s counts its entries", (_title, row) => {
    if (row.spec === null) return;
    if (row.spec.count === null) expect(row.ids.length).toBe(1);
    else expect(row.spec.count).toBe(row.ids.length);
  });

  test.each(rows.map((row) => [row.line.title, row] as const))("%s lists ids that exist", (_title, row) => {
    if (row.spec === null) return;
    const present = row.ids.map((entry) => entry.id);
    for (const entry of row.spec.listed) expect(present).toContain(entry.id);
  });

  test.each(rows.map((row) => [row.line.title, row] as const))("%s names the real extremes", (_title, row) => {
    if (row.spec === null) return;
    const prefixes = [...new Set(row.ids.map((entry) => entry.prefix))].sort();
    expect([...new Set(row.spec.listed.map((entry) => entry.prefix))].sort()).toEqual(prefixes);
    for (const prefix of prefixes) {
      const present = row.ids.filter((entry) => entry.prefix === prefix).map((entry) => entry.number);
      const listed = row.spec.listed.filter((entry) => entry.prefix === prefix).map((entry) => entry.number);
      expect(Math.min(...listed)).toBe(Math.min(...present));
      expect(Math.max(...listed)).toBe(Math.max(...present));
    }
  });
});
