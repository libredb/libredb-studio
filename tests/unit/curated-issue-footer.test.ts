/**
 * The CI-is-the-gate paragraph lives in two documents on purpose, so something has to hold the
 * copies together.
 *
 * `CONTRIBUTING.md` step 4 needs it for someone opening a pull request; `.github/curated-issue-footer.md`
 * needs it for the block we paste onto curated issues, where the reader never opens `CONTRIBUTING.md`.
 * Neither copy can be dropped, and the next person to improve the sentence will improve one of them
 * and leave the other telling contributors something else. This is the guard `readme:check`,
 * `chart:check` and `channels:showcase:check` already apply to the other duplicated text here.
 *
 * The expected wording is READ OUT OF THE FOOTER at runtime rather than pasted in below. A test
 * holding its own copy of the paragraph is simply the third copy: it drifts with the other two and
 * stays green while doing it, which is worse than no test because it reads as proof.
 *
 * Deliberately NOT asserted: that the two documents agree on anything else. They diverge after this
 * paragraph on purpose - the footer describes the devcontainer as something the repository provides,
 * `CONTRIBUTING.md` links to its own setup section instead - so only the shared paragraph is pinned.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

const CONTRIBUTING = "CONTRIBUTING.md";
const FOOTER = ".github/curated-issue-footer.md";

/** The paragraph both documents carry, identified by the sentence it opens with. */
const MARKER = "**CI is the merge gate.**";

/**
 * Layout has to go before the two sides can be compared; only the wording is pinned.
 *
 * In `CONTRIBUTING.md` the paragraph sits inside numbered list item 4, so every one of its lines is
 * indented by three spaces; in the footer it is flush left. Comparing the two as they are written
 * therefore fails on the indentation alone, which says nothing about whether the wording drifted.
 * The two copies also have different natural margins and this repository writes one sentence per
 * line, so either will be re-flowed sooner or later without a word changing - and a lone trailing
 * space would otherwise fail with two error strings that look identical. Collapsing every run of
 * whitespace covers all three.
 */
const words = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * The trimmed, blank-line-delimited paragraph of `relative` that opens with `MARKER`.
 *
 * Both sides are read with this one finder so the comparison below is paragraph against paragraph.
 * Matching the marker against the whole of `CONTRIBUTING.md` instead would pass while the two
 * documents disagree - a sentence appended to one copy leaves the other's wording still present in
 * the file - and on a genuine drift it printed the entire file as the received string.
 */
const paragraphIn = (relative: string): string => {
  const found = read(relative)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .find((paragraph) => paragraph.startsWith(MARKER));
  if (found === undefined) {
    // Rewording the opening sentence is allowed; silently leaving this guard with nothing to
    // compare is not, because every assertion below would then pass on any pair of documents.
    throw new Error(`${relative} no longer contains a paragraph starting with ${MARKER}`);
  }
  return found;
};

const sharedParagraph = (): string => paragraphIn(FOOTER);

describe("the CI-gate paragraph shared by CONTRIBUTING.md and the curated issue footer", () => {
  test(`${FOOTER} still carries the paragraph this guard reads`, () => {
    expect(sharedParagraph().length).toBeGreaterThan(MARKER.length);
  });

  test("CONTRIBUTING.md repeats it word for word", () => {
    expect(words(paragraphIn(CONTRIBUTING))).toBe(words(sharedParagraph()));
  });

  test("CONTRIBUTING.md tells a maintainer where the footer lives", () => {
    // Nothing else in the tree referenced the file, so a maintainer who wanted the footer had no
    // path to it and would retype it - the duplication these two documents exist to stop.
    expect(read(CONTRIBUTING)).toContain(FOOTER);
  });
});
