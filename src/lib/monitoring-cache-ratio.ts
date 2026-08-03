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
