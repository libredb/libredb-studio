/**
 * The roster count in `docs/llms/` is derived from the shipped profiles, not typed beside them.
 *
 * This file exists because the count leaked twice. `docs/llms/README.md` moved from twenty-two to
 * twenty-seven when five models landed, and `setup.md` and `methodology.md` did not: both still
 * said "Twenty-two models are supported" and "660 runs, and all 660 passed" against a document
 * holding twenty-seven. Two pull requests and one review passed over it, because nothing anywhere
 * compared the sentence to the file it describes.
 *
 * So the comparison is here, derived on both sides: the count comes from `modelProfiles()` and the
 * total from `count * RUNS_PER_MODEL`, which is what the protocol those pages describe produces -
 * six surfaces, five consecutive runs each.
 *
 * What is checked is the CLAIM, not every number in the prose. A first attempt asserted only that
 * each page contained the current word, and it did not bite: reverting `setup.md`'s opening
 * sentence to "Twenty-two models are supported" left the test green, because two later sentences in
 * the same file still said "twenty-eight" and `includes` was satisfied by them. A test that passes
 * for the wrong reason is worse than no test, so each claim is now captured by its own sentence and
 * compared, and the run total is checked against every other roster size it could have been rather
 * than against the ones we happen to have had.
 *
 * A blanket ban on number-words would be wrong here: these pages legitimately say "twenty-seven"
 * (the models that run locally), "twenty-one" (the models at the 90-second ceiling), "Ten" (the
 * browser sweep) and "thirty runs" (one model's own sweep). Those are different counts, correctly
 * stated, and a guard that failed on them would be deleted within a week.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { modelProfiles } from "@/lib/agent/models";

/** Six surfaces, five consecutive passing runs each - the bar `methodology.md` sets. */
const RUNS_PER_MODEL = 30;

const read = (page: string): string => readFileSync(join(process.cwd(), "docs", "llms", page), "utf8");

/**
 * The sentences that state the roster's size, one per page that states it.
 *
 * Hand-listed because a sentence cannot be derived; the NUMBER in it is what the test derives. A
 * page whose phrasing changes fails here loudly rather than silently stopping being checked, which
 * is the failure mode this file was written after.
 */
const CLAIMS: readonly { readonly page: string; readonly pattern: RegExp }[] = [
  { page: "README.md", pattern: /\*\*([A-Za-z-]+) models are supported\.\*\*/ },
  { page: "setup.md", pattern: /([A-Za-z-]+) models are supported —/ },
  { page: "methodology.md", pattern: /([A-Za-z-]+) models, six surfaces, five runs/ },
];

/** Only these two carry the run total; `setup.md` names the roster without counting its runs. */
const PAGES_WITH_TOTAL = ["README.md", "methodology.md"] as const;

const WORDS: Readonly<Record<number, string>> = {
  20: "Twenty",
  21: "Twenty-one",
  22: "Twenty-two",
  23: "Twenty-three",
  24: "Twenty-four",
  25: "Twenty-five",
  26: "Twenty-six",
  27: "Twenty-seven",
  28: "Twenty-eight",
  29: "Twenty-nine",
  30: "Thirty",
  31: "Thirty-one",
  32: "Thirty-two",
  33: "Thirty-three",
  34: "Thirty-four",
  35: "Thirty-five",
};

describe("the roster count the docs state is the roster the product ships", () => {
  const count = Object.keys(modelProfiles()).length;
  const total = count * RUNS_PER_MODEL;

  test("each page's own roster sentence names the current count", () => {
    const word = WORDS[count];
    // A roster past the table above fails here rather than skipping: these pages spell the number
    // out, so growing past it needs the word written before the count can be stated at all.
    expect({ count, word }).toEqual({ count, word: expect.any(String) });
    for (const { page, pattern } of CLAIMS) {
      const found = pattern.exec(read(page))?.[1];
      expect({ page, found }).toEqual({ page, found: word });
    }
  });

  test("no page carries a run total from a different roster", () => {
    for (const page of PAGES_WITH_TOTAL) {
      const text = read(page);
      expect({ page, states: text.includes(`${total} runs`) }).toEqual({ page, states: true });
      for (let other = 10; other <= 60; other += 1) {
        if (other === count) continue;
        const stale = `${other * RUNS_PER_MODEL} runs`;
        expect({ page, stale, found: text.includes(stale) }).toEqual({ page, stale, found: false });
      }
    }
  });
});
