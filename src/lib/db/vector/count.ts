import type { CountKind } from "./types";

/**
 * The `columnTypes` text of a count column (vector-family spec 3.3). A count is labelled exact only when the engine
 * computed it exactly; a floor or an estimate is never reported as exact.
 */
export function countLabel(kind: CountKind): "Int64, exact count" | "Int64, estimate" {
  return kind === "exact" ? "Int64, exact count" : "Int64, estimate";
}
