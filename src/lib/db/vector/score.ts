import type { QueryWarning } from "@/lib/types";
import type { ScoreSemantics } from "./types";

/**
 * The score column's text and cells (vector-family spec 3.3), one wording for every engine.
 *
 * The text names the engine's own score name and its direction. A squared Euclidean distance says so, because
 * another engine's Euclidean distance is not squared and the two numbers differ for the same pair of vectors. No
 * text states a bound on a similarity: quantised and reduced-precision vectors give cosine scores above 1.
 */
export function scoreColumnType(semantics: ScoreSemantics): string {
  if (semantics.kind === "unranked") return "Float, not a similarity (constant 1.0)";
  const name = semantics.nativeName ?? semantics.metric;
  if (name === null) throw new Error(`A ${semantics.kind} score needs a native name or a metric to be labelled`);
  const order = semantics.better === null ? "rows are in rank order" : `${semantics.better} ranks first`;
  if (semantics.kind === "fused") return `Float, ${name} fusion, ${order}`;
  if (semantics.kind === "computed") return `Float, ${name} score, ${order}`;
  if (semantics.better === null) return `Float, ${name}, rows are in rank order`;
  const squared = semantics.metric === "euclidean_squared" ? " (squared Euclidean)" : "";
  return `Float, ${name}${squared}, ${semantics.better} is closer`;
}

/** A score as a JSON cell can carry it: a finite number, or the word for a value that is not finite. */
export type ScoreCell = number | "Infinity" | "-Infinity" | "NaN" | "not finite";

/**
 * A finite score is the number. Infinity, -Infinity and NaN are written as those words, and a `null`, which is how
 * an engine prints a score that is not finite, as `"not finite"`, because JSON cannot carry a non-finite number
 * and a bare `null` reads as "no score".
 */
export function scoreCell(raw: number | null): ScoreCell {
  if (raw === null) return "not finite";
  if (Number.isNaN(raw)) return "NaN";
  if (raw === Number.POSITIVE_INFINITY) return "Infinity";
  if (raw === Number.NEGATIVE_INFINITY) return "-Infinity";
  return raw;
}

/** The one warning a result carries when any of its scores is not finite, counting the rows. */
export function nonFiniteScoreWarning(rows: number): QueryWarning {
  return {
    message:
      rows === 1
        ? "1 row has a score that is not a finite number; it is shown as a word, because JSON cannot carry it."
        : `${rows} rows have scores that are not finite numbers; they are shown as words, because JSON cannot carry them.`,
  };
}
