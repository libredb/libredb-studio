/** The engine an explain request names when the view has no connection type: today's `databaseType || "postgres"` (spec 5.5, T18). */
export const NO_CONNECTION_EXPLAIN_ENGINE = "postgres";

/** The engine an explain request names: the view's connection type, or `NO_CONNECTION_EXPLAIN_ENGINE` when it has none, so `""` also gives `"postgres"`. */
export function explainRequestEngine(databaseType: string | undefined): string {
  return databaseType || NO_CONNECTION_EXPLAIN_ENGINE;
}
