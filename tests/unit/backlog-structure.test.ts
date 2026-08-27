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
    expect(sections.length).toBe([...BACKLOG.matchAll(/^## /gm)].length);
    expect(sections.length).toBeGreaterThan(1);
  });

  test("the entries were found", () => {
    // Derived, not a floor. This used to assert "more than 100", which pinned the parse by
    // pinning the backlog's SIZE - so the settlement that took the file from 129 entries to
    // 90 failed a test whose subject is whether the regex matched. The count the parse found
    // has to equal the count in the raw text, and that stays true at any size, including a
    // file with one entry left.
    const headings = [...BACKLOG.matchAll(/^### [A-Z]+\d+\./gm)].length;
    expect(sections.flatMap((section) => section.ids).length).toBe(headings);
    expect(headings).toBeGreaterThan(1);
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

/**
 * Every `docs/BACKLOG.md <ID>` citation in the tree names an entry that is still there.
 *
 * The file is a work list, so an entry LEAVES it when the work lands. 208 citations across 101
 * files had outlived their entries that way - 30 dead ids - and nothing measured it: the guard
 * above this one asks whether the index is derived from the bodies, and the one in
 * `tests/unit/agent-documentation.test.ts` asks the same question of `docs/AGENT.md` alone,
 * scoped to the M2 section's `B` ids. A citation from a source comment was checked by nobody,
 * so a reader who followed one found an empty grep and had to decide whether the comment or the
 * file was wrong.
 *
 * The count arrived in three instalments, and both jumps were the pattern's fault rather than
 * the tree's - worth recording, because a guard that under-reports reads exactly like a clean
 * one:
 *
 *  - Matching line by line found 77. Three citations wrap across a line break in a block
 *    comment (`(\`docs/BACKLOG.md\`\n * B24, ...)`), so the scan now runs over whole files and
 *    derives the line from the match offset.
 *  - Those 80 were all of ONE form. An id written in the syntax of a PR reference - `#U9`,
 *    parenthesised - accounted for another 128, more than the form anyone was looking for, and
 *    43 of them named a single dead id.
 *
 * Three of the 208 were not pointer faults at all but stale CLAIMS, and they are the reason the
 * two kinds are worth separating: each said an entry was open when it had been settled, so the
 * comment argued for behaviour the code no longer had. One told a reader the held snapshot could
 * not tell two databases apart, four paragraphs above the comment describing the key that tells
 * them apart; one deferred a decision to the owner that the owner had ratified; one told a demo
 * driver not to show a Redis draft because an open question hung over it, when the question had
 * been ruled on and declined.
 *
 * The rule this pins is that the two kinds of reference are not interchangeable. A citation of
 * `docs/BACKLOG.md` says *this is open* and has to resolve; a claim about work already done
 * cites the PR that did it (`#463`), which is immutable and carries the reasoning. So closing an
 * entry now means rewriting its citations in the same PR — the same lockstep the provider triad
 * already runs on, and the reason this is a test rather than a convention.
 *
 * Non-vacuity is a positive control on the extractor plus a floor on the SCAN, never on the
 * number of citations: that number falls every time an entry closes, and a floor under it would
 * become a floor under the backlog itself.
 *
 * **The limit, stated rather than implied.** A THIRD form is not checked here and cannot be: the
 * bare parenthesised id, `(U22)`. 232 of those are in the tree and 47 distinct ids among them
 * name no live entry, but the shape is not the backlog's alone - `(S256)` is a PKCE
 * code-challenge method and
 * `(T6)` is a task number from issue #331, both indistinguishable from an entry id by pattern. A
 * bare id that matches a live entry is a citation and needs no help; one that does not is either a
 * dead citation or not a citation at all, and nothing in the text says which. So the two forms
 * above are the ones with a machine-checkable answer, and the bare form is left to the reader on
 * purpose.
 */
describe("no citation outlives the entry it names", () => {
  /**
   * `docs/BACKLOG.md <ID> and <ID>` cites two entries. Chains join on `and`, a comma or a slash.
   *
   * The ids in the control below are interpolated rather than written out, and that is the point:
   * a literal example here would be a citation like any other, so this test's own fixtures were
   * five of the eighty-four dangling sites it first reported. Interpolation keeps the source text
   * unscannable while the runtime string still exercises the real shape, and taking the ids from
   * the document means no example is pinned to an entry that will close.
   */
  const CITATION = /BACKLOG\.md`?[\s*]+((?:[A-Z]+\d+)(?:[\s*]*(?:and|,|\/)[\s*]*`?[A-Z]+\d+`?)*)/g;

  const citedIn = (text: string): string[] =>
    [...text.matchAll(CITATION)].flatMap((match) => match[1].match(/[A-Z]+\d+/g) ?? []);

  /** Which line a match index falls on, since a citation may not start on the line it names. */
  const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

  const SCAN_ROOTS = [
    "src/**/*.{ts,tsx}",
    "tests/**/*.{ts,tsx}",
    "docs/**/*.md",
    "scripts/**/*.mjs",
    ".github/**/*.yml",
  ];
  const scanned = SCAN_ROOTS.flatMap((pattern) => [...new Bun.Glob(pattern).scanSync(ROOT)]).filter(
    (file) => file !== BACKLOG_PATH,
  );

  const present = new Set(sections.flatMap((section) => section.ids.map((entry) => entry.id)));

  /**
   * The other citation form, and the one that outnumbers the first: `(#496)` — a backlog id written
   * in the syntax of a PR reference. GitHub renders no link for it and a reader reasonably takes it
   * for a pull request, so it is worse than a bare id and it was never valid.
   *
   * Told apart from a hex colour (`#FFF000` is in `src/lib/db-ui-config.ts`) by the PREFIX, taken
   * from the document rather than listed here: `FFF` is not a prefix any entry uses, `B` is. A
   * prefix that stops being used stops being scanned, which is the right failure — the ids under it
   * are gone too.
   */
  const PREFIXES = new Set([...present].map((id) => /^([A-Z]+)/.exec(id)?.[1] ?? ""));
  const AS_PR = /\(#([A-Z]+)(\d+)\)/g;

  const idsWrittenAsPr = (text: string): { id: string; index: number }[] =>
    [...text.matchAll(AS_PR)]
      .filter((match) => PREFIXES.has(match[1]))
      .map((match) => ({ id: `${match[1]}${match[2]}`, index: match.index }));

  test("an id written as a PR reference is read, and a hex colour is not", () => {
    const [one] = [...present];
    expect(idsWrittenAsPr(`the same shape (#${one}) again`).map((hit) => hit.id)).toEqual([one]);
    expect(idsWrittenAsPr("border: 1px solid #FFF000")).toEqual([]);
    expect(idsWrittenAsPr("(#FFF000)")).toEqual([]);
  });

  test("the extractor reads a single citation and a chain", () => {
    const [one, two] = [...present];
    expect(citedIn(`filed as \`docs/BACKLOG.md\` ${one} for now`)).toEqual([one]);
    expect(citedIn(`(docs/BACKLOG.md ${one} and ${two})`)).toEqual([one, two]);
    expect(citedIn("nothing to see")).toEqual([]);
  });

  test("the scan reached the tree", () => {
    // A mistyped glob returns nothing, and an empty scan makes the assertion below pass for the
    // wrong reason. The floor is on files in the repo, which does not shrink when an entry closes.
    expect(scanned.length).toBeGreaterThan(200);
    expect(present.size).toBeGreaterThan(0);
  });

  test("every cited entry exists", () => {
    const dangling = scanned.flatMap((file) => {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      return [...text.matchAll(CITATION)].flatMap((match) =>
        (match[1].match(/[A-Z]+\d+/g) ?? [])
          .filter((id) => !present.has(id))
          .map((id) => `${file}:${lineOf(text, match.index)} cites ${id}`),
      );
    });
    const asPr = scanned.flatMap((file) => {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      return idsWrittenAsPr(text)
        .filter((hit) => !present.has(hit.id))
        .map((hit) => `${file}:${lineOf(text, hit.index)} cites ${hit.id} as if it were a PR`);
    });
    expect([...dangling, ...asPr]).toEqual([]);
  });
});
