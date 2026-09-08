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
 * Leading whitespace has to go before the two sides can be compared.
 *
 * In `CONTRIBUTING.md` the paragraph sits inside numbered list item 4, so every one of its lines is
 * indented by three spaces; in the footer it is flush left. A plain `includes()` therefore fails on
 * the very first line, which says nothing about whether the wording drifted.
 */
const dedent = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trimStart())
    .join("\n");

/** The dedented, blank-line-delimited paragraph of the footer that opens with `MARKER`. */
const sharedParagraph = (): string => {
  const found = dedent(read(FOOTER))
    .split(/\n\s*\n/)
    .find((paragraph) => paragraph.startsWith(MARKER));
  if (found === undefined) {
    // Rewording the footer's opening sentence is allowed; silently leaving this guard with nothing
    // to compare is not, because every assertion below would then pass on any CONTRIBUTING.md at all.
    throw new Error(`${FOOTER} no longer contains a paragraph starting with ${MARKER}`);
  }
  return found;
};

describe("the CI-gate paragraph shared by CONTRIBUTING.md and the curated issue footer", () => {
  test(`${FOOTER} still carries the paragraph this guard reads`, () => {
    expect(sharedParagraph().split("\n").length).toBeGreaterThan(1);
  });

  test("CONTRIBUTING.md repeats it word for word", () => {
    expect(dedent(read(CONTRIBUTING))).toContain(sharedParagraph());
  });

  test("CONTRIBUTING.md tells a maintainer where the footer lives", () => {
    // Nothing else in the tree referenced the file, so a maintainer who wanted the footer had no
    // path to it and would retype it - the duplication these two documents exist to stop.
    expect(read(CONTRIBUTING)).toContain(FOOTER);
  });
});
