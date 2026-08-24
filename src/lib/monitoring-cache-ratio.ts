/**
 * The one place that turns an optional cache hit ratio into display text.
 *
 * `PerformanceMetrics.cacheHitRatio` is optional because "not measured" and
 * "measured as zero" are different facts and only one of them is an alarm: Apache
 * Druid cannot measure the ratio at all (its cache statistics reach a metrics
 * emitter and never a SQL-readable table), while a genuine 0 on another engine is
 * a real, actionable measurement.
 *
 * `HealthInfo.cacheHitRatio` is a STRING, so it can carry the absence honestly -
 * but the providers that always produce a number (Couchbase, ClickHouse) would
 * each need an unreachable fallback branch to say so, and the repo's coverage gate
 * fails on unreachable lines. Hence one shared formatter whose absent path is
 * covered once, here.
 */

/**
 * What an unavailable ratio is called on screen.
 *
 * "N/A" is the spelling `sqlite.ts`, `oracle.ts`, `mssql.ts` and `mongodb.ts`
 * already use for a ratio they cannot read, so this is the repo's existing word
 * for it rather than a new one.
 */
export const CACHE_HIT_RATIO_UNAVAILABLE = "N/A";

/**
 * One decimal place for a measured ratio, {@link CACHE_HIT_RATIO_UNAVAILABLE}
 * when there is nothing to report. A measured `0` formats as "0.0": it is a
 * number the engine actually produced.
 */
export function formatCacheHitRatio(ratio: number | undefined): string {
  return ratio === undefined ? CACHE_HIT_RATIO_UNAVAILABLE : ratio.toFixed(1);
}

/**
 * A reading a monitoring source actually published, or `undefined` when it
 * published none.
 *
 * This is the guard that keeps the whole "absent is not zero" rule enforceable at
 * the provider boundary, and it lives here rather than in each provider because
 * four of them wrote it independently (mysql.ts and mongodb.ts word for word,
 * couchbase/index.ts as an inline `=== null` pair, and postgres/oracle/mssql not
 * at all - which is how they came to invent numbers).
 *
 * A SQL NULL is the ordinary answer, not an exotic one: every cache-hit query in
 * this repo guards its division with `NULLIF(..., 0)`, so a source with nothing to
 * divide answers one row whose single column is NULL. Measured 2026-08-23 on the
 * live engines: PostgreSQL 18 `pg_statio_user_tables` aggregates to NULL on a
 * database with no user tables, and to `0 / NULLIF(0, 0)` on a table nothing has
 * read yet; Oracle Free 23ai and SQL Server 2022 both return a single NULL row
 * when their counter denominators are 0. `Number(null)` is `0`, and
 * `DEFAULT_THRESHOLDS` rates a cache hit ratio of 0 as critical - so the naive
 * coercion turns "nothing was measured" into a red fault the engine never
 * reported. `value || fallback` is the same bug wearing a friendlier number, and it
 * additionally discards a legitimate measured 0.
 *
 * MySQL/MariaDB reach the same NULL by a different route, recorded here because it
 * is the case that first motivated this guard: MariaDB ships `performance_schema`
 * OFF while the tables still exist, so the metric queries are a bare
 * `SELECT (subquery)` that answers one row of NULLs rather than throwing, and
 * `parseInt(x || "0")` turned each of those NULLs into a measurement nobody took.
 *
 * Non-finite input (NaN from an unparseable string, an Infinity) is absent for the
 * same reason: it is not a reading either.
 */
export function measuredNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
