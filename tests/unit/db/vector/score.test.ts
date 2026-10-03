/**
 * The score column's text and cells (vector-family spec 3.3), over both engines' fixtures: one wording for both
 * engines, the squared Euclidean named, and a non-finite score written as a word with one warning.
 */
import { describe, expect, test } from "bun:test";
import { nonFiniteScoreWarning, scoreCell, scoreColumnType } from "@/lib/db/vector/score";
import type { ScoreSemantics } from "@/lib/db/vector/types";
import { allFields, ENGINES, expectedScores } from "../../../helpers/vector-fixtures";

/**
 * Each native metric of the fixtures as its provider's score table will describe it, and the text the column
 * shows: the score tables are each provider's (spec 5.5 and 6.5); the wording is this module's.
 */
const SCORES: Readonly<
  Record<string, { readonly semantics: Omit<ScoreSemantics, "metric" | "nativeName">; readonly text: string }>
> = {
  COSINE: { semantics: { kind: "similarity", better: "higher" }, text: "Float, COSINE, higher is closer" },
  IP: { semantics: { kind: "similarity", better: "higher" }, text: "Float, IP, higher is closer" },
  BM25: { semantics: { kind: "similarity", better: "higher" }, text: "Float, BM25, higher is closer" },
  L2: { semantics: { kind: "distance", better: "lower" }, text: "Float, L2 (squared Euclidean), lower is closer" },
  HAMMING: { semantics: { kind: "distance", better: "lower" }, text: "Float, HAMMING, lower is closer" },
  JACCARD: { semantics: { kind: "distance", better: "lower" }, text: "Float, JACCARD, lower is closer" },
  Cosine: { semantics: { kind: "similarity", better: "higher" }, text: "Float, Cosine, higher is closer" },
  Dot: { semantics: { kind: "similarity", better: "higher" }, text: "Float, Dot, higher is closer" },
  Euclid: { semantics: { kind: "distance", better: "lower" }, text: "Float, Euclid, lower is closer" },
  Manhattan: { semantics: { kind: "distance", better: "lower" }, text: "Float, Manhattan, lower is closer" },
};

for (const engine of ENGINES) {
  describe(`scoreColumnType over ${engine}'s fields`, () => {
    test("writes the score text of every native metric the fixture declares", () => {
      const named = allFields(engine).filter(({ field }) => field.nativeMetric !== null);
      expect(named.length).toBeGreaterThan(0);
      for (const { collection, field } of named) {
        const entry = SCORES[field.nativeMetric as string];
        expect(entry, `${collection}.${field.name}: ${field.nativeMetric}`).toBeDefined();
        expect(scoreColumnType({ ...entry.semantics, metric: field.metric, nativeName: field.nativeMetric })).toBe(
          entry.text,
        );
      }
    });
  });
}

describe("scoreColumnType", () => {
  test.each([
    [
      { kind: "similarity", better: null, metric: "other", nativeName: "MAX_SIM_COSINE" },
      "Float, MAX_SIM_COSINE, rows are in rank order",
    ],
    [{ kind: "fused", better: "higher", metric: null, nativeName: "RRF" }, "Float, RRF fusion, higher ranks first"],
    [
      { kind: "fused", better: "higher", metric: null, nativeName: "weighted" },
      "Float, weighted fusion, higher ranks first",
    ],
    [{ kind: "fused", better: null, metric: null, nativeName: "DBSF" }, "Float, DBSF fusion, rows are in rank order"],
    [
      { kind: "computed", better: null, metric: null, nativeName: "formula" },
      "Float, formula score, rows are in rank order",
    ],
    [
      { kind: "computed", better: null, metric: null, nativeName: "recommend" },
      "Float, recommend score, rows are in rank order",
    ],
    [
      { kind: "computed", better: "higher", metric: null, nativeName: "relevance_feedback" },
      "Float, relevance_feedback score, higher ranks first",
    ],
    [{ kind: "unranked", better: null, metric: null, nativeName: null }, "Float, not a similarity (constant 1.0)"],
    [
      { kind: "distance", better: "lower", metric: "euclidean_squared", nativeName: null },
      "Float, euclidean_squared (squared Euclidean), lower is closer",
    ],
  ] as const)("%j is %p", (semantics, text) => {
    expect(scoreColumnType(semantics)).toBe(text);
  });

  test("a score with neither a native name nor a metric cannot be labelled, and says so", () => {
    expect(() => scoreColumnType({ kind: "similarity", better: "higher", metric: null, nativeName: null })).toThrow(
      "A similarity score needs a native name or a metric to be labelled",
    );
  });

  test("no text states a bound on a similarity", () => {
    for (const { text } of Object.values(SCORES)) expect(text).not.toMatch(/\b1(\.0)?\b|between|range/);
  });
});

describe("scoreCell and nonFiniteScoreWarning over both fixtures' non-finite scores", () => {
  test("the Milvus self-search score derived from the seed is Infinity, written as the word", () => {
    const { milvus } = expectedScores();
    expect(milvus.score).toBe("Infinity");
    expect(scoreCell(Number(milvus.score))).toBe("Infinity");
  });

  test("the null Qdrant prints for a score that is not finite is written as not finite", () => {
    const { qdrant } = expectedScores();
    expect(qdrant.printed).toBeNull();
    expect(scoreCell(qdrant.printed)).toBe("not finite");
  });

  test("each carries one warning counting the rows", () => {
    expect(nonFiniteScoreWarning(1)).toEqual({
      message: "1 row has a score that is not a finite number; it is shown as a word, because JSON cannot carry it.",
    });
    expect(nonFiniteScoreWarning(3)).toEqual({
      message:
        "3 rows have scores that are not finite numbers; they are shown as words, because JSON cannot carry them.",
    });
  });
});

describe("scoreCell", () => {
  test.each([
    [0.5, 0.5],
    [-2, -2],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [Number.NEGATIVE_INFINITY, "-Infinity"],
    [Number.NaN, "NaN"],
    [null, "not finite"],
  ] as const)("%p is %p", (raw, cell) => {
    expect(scoreCell(raw)).toBe(cell);
  });
});
