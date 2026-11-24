import { describe, expect, test } from "bun:test";
import type { AgentLanguageClientPack } from "@/lib/agent/languages/pack";

/**
 * What a language pack may say of the safety strip's posture, held by the compiler: `bun run typecheck` reads this
 * file, and each `@ts-expect-error` below fails it the day its line compiles, so every case is proven both ways.
 *
 * A pack supplies the qualifier, the title and the body; the tone and the headline are core's, derived from the run's
 * arm and the review record in `posture.ts`, so no form of writing either one compiles: not an arrow checked by
 * `satisfies`, not a named function with no return annotation, and not inside `Object.freeze`. The runtime assertions
 * only keep the fixtures from being unused.
 */

type PostureFacet = AgentLanguageClientPack["posture"];

const COPY = { qualifier: "q", title: "t", body: "b" } as const;
const terms = (): string => "terms";

function namedReadsWithTone() {
  return { ...COPY, tone: "reads" as const };
}

describe("the posture facet's types", () => {
  test("refuse a pack that writes a tone or a headline, in every arm and every form", () => {
    const fixtures: readonly unknown[] = [
      {
        // @ts-expect-error: the reads arm's tone is core's.
        reads: () => ({ ...COPY, tone: "reads" as const }),
        handoverTerms: terms,
      } satisfies PostureFacet,
      {
        // @ts-expect-error: the reads arm's headline is core's.
        reads: () => ({ ...COPY, headline: "Reads only" }),
        handoverTerms: terms,
      } satisfies PostureFacet,
      {
        reads: () => COPY,
        // @ts-expect-error: the widened arm's tone and headline are core's.
        widened: () => ({
          ...COPY,
          tone: "widened" as const,
          headline: "Reads only, and one statement in your editor",
        }),
        handoverTerms: terms,
      } satisfies PostureFacet,
      {
        reads: () => COPY,
        handoverTerms: terms,
        // @ts-expect-error: the plan arm's tone is core's, even where the language says its own plan copy.
        plan: () => ({ ...COPY, tone: "safe" as const }),
      } satisfies PostureFacet,
      {
        // @ts-expect-error: a named function with no return annotation is held as well as an arrow.
        reads: namedReadsWithTone,
        handoverTerms: terms,
      } satisfies PostureFacet,
      Object.freeze({
        reads: () => ({ ...COPY, headline: "Reads only" }),
        handoverTerms: terms,
        // @ts-expect-error: and so is a facet frozen before it is checked.
      }) satisfies PostureFacet,
    ];
    expect(fixtures).toHaveLength(6);
  });

  test("admit a pack that supplies the qualifier, the title and the body alone", () => {
    const facet = Object.freeze({ reads: () => COPY, handoverTerms: terms }) satisfies PostureFacet;
    expect(Object.keys(facet.reads()).sort()).toEqual(["body", "qualifier", "title"]);
  });
});
