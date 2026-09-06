/**
 * `CONTRIBUTORS.md` is a credential, so it has to stay checkable.
 *
 * The page exists because a merged pull request here is evidence about the person who wrote it:
 * every change lands with its tests in the same PR, under a 100% line-coverage gate. A page making
 * that claim is only worth reading if each entry points at the change it is claiming, so these
 * tests pin the three things a reader would otherwise have to take on trust:
 *
 *   1. every person listed carries at least one link to the change itself, written as a full URL
 *      rather than a bare `#123` - the page is read outside GitHub too, where a bare number links
 *      to nothing;
 *   2. the rungs `CONTRIBUTORS.md` groups people under are exactly the rungs `CONTRIBUTING.md`
 *      defines. A ladder whose two halves drift is worse than no ladder: someone is told they are
 *      a "Trusted contributor" by one file and the other has never heard of the rung;
 *   3. no rung is described as a number of merges. The page's premise is that nothing here is
 *      counted, and a threshold creeping back into the prose would contradict it in the one place
 *      a reader looks to find out how they are being judged.
 *
 * The rungs themselves are deliberately NOT testable, because they are judgements. There is no
 * assertion that a person belongs where they are put; that is the maintainers' call and the reason
 * is written beside the name so a reader can disagree with it.
 *
 * Deliberately NOT asserted: that the list is complete. Completeness can only be measured against
 * the GitHub API or a full `git log`, and CI clones shallowly, so a test claiming to check it would
 * pass vacuously. Adding the contributor is a step in the merge checklist in `CONTRIBUTING.md`
 * instead - a human step that is honest about being one, rather than a gate that does not gate.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

const CONTRIBUTORS = "CONTRIBUTORS.md";
const CONTRIBUTING = "CONTRIBUTING.md";

/**
 * Evidence is a pull request OR a commit in THIS repository, and the second is not a fallback.
 *
 * The two earliest outside changes reached `main` by rebase rather than through the merge button,
 * so GitHub records pull requests 8 and 12 as closed with `mergedAt: null` even though the code has
 * been in the tree since 2025-12-25. Linking those would show a stranger a rejected pull request as
 * proof of a contribution. The commit is the honest citation there.
 *
 * Matched on the parsed origin and path rather than as a substring of the entry, which CodeQL
 * flagged (`js/incomplete-url-substring-sanitization`) on the first version of this file. The alert
 * is not a security finding here - nothing is fetched or trusted - but the weakness it names is
 * real for a page whose whole claim is that its links are checkable: a substring test accepts
 * `https://evil.example/https://github.com/libredb/libredb-studio/pull/12`, where our prefix is
 * somebody else's path. On a credential page that is the one link that must not pass.
 */
const EVIDENCE_ORIGIN = "https://github.com";
const EVIDENCE_PATHS = ["/libredb/libredb-studio/pull/", "/libredb/libredb-studio/commit/"];

/** Markdown link targets in a block: the `target` of every `[text](target)`. */
const linkTargets = (body: string): string[] => [...body.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]);

/** Whether a link target is a pull request or commit in this repository, by origin and path. */
const isEvidence = (target: string): boolean => {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  return url.origin === EVIDENCE_ORIGIN && EVIDENCE_PATHS.some((prefix) => url.pathname.startsWith(prefix));
};

/**
 * The `## <rung>` headings people are actually grouped under.
 *
 * Not every `##` on the page is a rung - the page also carries prose sections - so a heading counts
 * only once a `### @login` entry appears beneath it. Reading the rungs off the entries rather than
 * off the heading level is what lets the page grow a section without the ladder guard firing at it.
 */
const rungHeadings = (text: string): string[] => {
  const rungs = new Set<string>();
  let current: string | null = null;
  for (const line of text.split("\n")) {
    if (/^## \S/.test(line)) {
      current = line.slice(3).trim();
    } else if (current !== null && /^### @/.test(line)) {
      rungs.add(current);
    }
  }
  return [...rungs];
};

/** Each `### @login` block, with the body that follows it up to the next heading of any level. */
const entries = (text: string): { login: string; body: string }[] => {
  const found: { login: string; body: string }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const heading = /^### @([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\b/.exec(lines[i]);
    if (heading === null) {
      continue;
    }
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && !lines[j].startsWith("#"); j++) {
      body.push(lines[j]);
    }
    found.push({ login: heading[1], body: body.join("\n") });
  }
  return found;
};

describe("CONTRIBUTORS.md", () => {
  const contributors = read(CONTRIBUTORS);

  test("lists people, so the guard below is not measuring an empty page", () => {
    // Without this, every assertion that follows passes vacuously on a file with no entries.
    expect(entries(contributors).length).toBeGreaterThan(0);
  });

  test("every person links to a pull request or a commit in this repository", () => {
    const withoutEvidence = entries(contributors)
      .filter(({ body }) => !linkTargets(body).some(isEvidence))
      .map(({ login }) => login);
    expect(withoutEvidence).toEqual([]);
  });

  test("no rung is described as a number of anything", () => {
    // The page states that nothing here is counted. A threshold creeping back into the prose is the
    // one drift that would contradict the page's own premise, and it would read as policy.
    expect(contributors).not.toMatch(/\b(?:one|two|three|four|five|\d+)\s+merged\b/i);
  });

  test("no bare #123 reference stands in for a link", () => {
    // A bare number renders as plain text everywhere this page is read outside GitHub, so the
    // claim it supports becomes uncheckable exactly where a stranger would want to check it.
    const bare = entries(contributors)
      .flatMap(({ login, body }) => body.split("\n").map((line) => ({ login, line })))
      .filter(({ line }) => /(^|\s)#\d+/.test(line))
      .map(({ login }) => login);
    expect(bare).toEqual([]);
  });

  test("nobody is listed twice", () => {
    const logins = entries(contributors).map(({ login }) => login);
    expect(logins).toEqual([...new Set(logins)]);
  });
});

describe("what counts as evidence", () => {
  // Paired positive and negative, because an accept-everything predicate would make the assertion
  // above pass on any page at all, and a reject-everything one would be caught by that same test.
  test("accepts a pull request and a commit in this repository", () => {
    expect(isEvidence("https://github.com/libredb/libredb-studio/pull/579")).toBe(true);
    expect(isEvidence("https://github.com/libredb/libredb-studio/commit/ff22a5dd")).toBe(true);
  });

  test("rejects a link that only carries our path on somebody else's host", () => {
    // The substring test this replaced accepted the FIRST of these, which is the defect CodeQL
    // named. The rest were already rejected by it and are here so the predicate cannot be loosened
    // in a way that lets a fork, a plain-HTTP host or a lookalike domain through unnoticed.
    expect(isEvidence("https://evil.example/https://github.com/libredb/libredb-studio/pull/579")).toBe(false);
    expect(isEvidence("https://github.evil.example/libredb/libredb-studio/pull/579")).toBe(false);
    expect(isEvidence("http://github.com/libredb/libredb-studio/pull/579")).toBe(false);
    expect(isEvidence("https://github.com/someone-else/fork/pull/579")).toBe(false);
    expect(isEvidence("../../src/lib/db/types.ts")).toBe(false);
  });
});

describe("the contributor ladder", () => {
  test("every rung CONTRIBUTORS.md groups people under is defined in CONTRIBUTING.md", () => {
    // The two-way binding. A rung renamed on one side has to be renamed on the other, or someone
    // is told they hold a rung the defining document has never heard of.
    const defined = read(CONTRIBUTING);
    const rungs = rungHeadings(read(CONTRIBUTORS));
    // Without this the filter below has nothing to reject and the assertion means nothing.
    expect(rungs.length).toBeGreaterThan(0);
    expect(rungs.filter((rung) => !defined.includes(rung))).toEqual([]);
  });

  test("CONTRIBUTING.md defines the rungs as a ladder a reader can climb", () => {
    const defining = read(CONTRIBUTING);
    for (const rung of ["Contributor", "Trusted contributor", "Area owner"]) {
      expect(defining.includes(rung), `CONTRIBUTING.md does not define the ${rung} rung`).toBe(true);
    }
  });
});
