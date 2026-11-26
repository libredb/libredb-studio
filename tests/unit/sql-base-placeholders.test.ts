/**
 * #647: `SQLBaseProvider` has no placeholder logic. The real home is `positionalPlaceholder()` in
 * `src/lib/sql/values.ts`. Docs paraphrased the capability onto the base class (or claimed inheritance); #640's
 * `getPlaceholder` grep missed every paraphrase.
 *
 * docs/DATABASE_PROVIDERS.md is held on ATTRIBUTION in the sentence that contains a `placeholder(s)` match: denials
 * ("Not in the list...", "no longer has") clear only that sentence, not a neighbourhood around it. The negative is
 * paired with a control: if the helper later moves into `sql-base.ts`, the source assertion goes red and this guard
 * must be rewritten on purpose.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");

const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

const PROVIDERS_GUIDE = "docs/DATABASE_PROVIDERS.md";

const collapse = (text: string): string => text.replace(/\s+/g, " ");

/** Broad: any "placeholder" / "placeholders"; denials are sentence-scoped. */
const PLACEHOLDER_CAPABILITY_SOURCE = String.raw`\bplaceholders?\b`;

/** Sentence containing `matchIndex` in already-collapsed prose (`.!?` boundaries). */
const sentenceAt = (collapsed: string, matchIndex: number): string => {
  let start = 0;
  for (const boundary of collapsed.slice(0, matchIndex).matchAll(/[.!?]\s+/g)) {
    start = boundary.index! + boundary[0].length;
  }
  const rest = collapsed.slice(matchIndex);
  const endRel = /[.!?](?:\s|$)/.exec(rest);
  const end = endRel ? matchIndex + endRel.index! + 1 : collapsed.length;
  return collapsed.slice(start, end);
};

/** Each sentence of `text` that credits SQLBaseProvider or inheritance with placeholders and does not deny it. */
function placeholderCredits(text: string): string[] {
  const collapsed = collapse(text);
  return [...collapsed.matchAll(new RegExp(PLACEHOLDER_CAPABILITY_SOURCE, "gi"))]
    .map((match) => sentenceAt(collapsed, match.index!))
    .filter((window) => {
      const credits =
        /SQLBaseProvider/i.test(window) ||
        (/\binherited\b/i.test(window) && !/\b(?:not|rather than)\s+inherited\b/i.test(window));
      const denies = /\bno longer has\b|\bnot in the list\b/i.test(window);
      return credits && !denies;
    });
}

describe("docs do not credit SQLBaseProvider with placeholders (#647)", () => {
  test("docs/DATABASE_PROVIDERS.md does not credit SQLBaseProvider / inheritance with placeholders", () => {
    expect(placeholderCredits(read(PROVIDERS_GUIDE)), `${PROVIDERS_GUIDE} credits SQLBaseProvider`).toEqual([]);
    // Vacuity: a crediting sentence is named, and a denial clears only its own sentence.
    expect(placeholderCredits("Intro. SQLBaseProvider gives placeholders. It no longer has a placeholder.")).toEqual([
      "SQLBaseProvider gives placeholders.",
    ]);
  });

  test("positionalPlaceholder is declared in values.ts; sql-base declares no placeholder member", () => {
    expect(read("src/lib/sql/values.ts")).toMatch(/^export function positionalPlaceholder\(/m);
    expect(read("src/lib/db/providers/sql/sql-base.ts")).not.toMatch(/placeholder/i);
  });
});
