import type { DatabaseProvider, PreparedQuery, QueryPrepareOptions } from "@/lib/db/types";

/**
 * ONE ROW PAST THE PAGE, SO A FULL LAST PAGE IS NOT TAKEN FOR A FULL PAGE (#1440).
 *
 * A page that came back exactly full proves nothing about the next one: when the total is a
 * multiple of the page size the last full page is also the last, and guessing "more" left
 * "load more" and the limited badge standing after the final row until a click fetched nothing.
 * The statement that RUNS therefore asks for `limit + 1`, and the extra row, which is never
 * answered, is the evidence that a next page exists.
 *
 * The same limiter builds both statements, so no engine is named. A statement the limiter
 * declined to rewrite has no bound of ours to probe past and runs as prepared. `unlimited` is
 * dropped from the second call because `prepared.limit` already carries the bound it chose.
 */
export function probePastPage(
  provider: Pick<DatabaseProvider, "prepareQuery">,
  statement: string,
  options: QueryPrepareOptions,
  prepared: PreparedQuery,
): PreparedQuery {
  if (!prepared.wasLimited) return prepared;
  return provider.prepareQuery(statement, { ...options, limit: prepared.limit + 1, unlimited: false });
}

/**
 * The rows a probed run answers and whether a next page exists, read off `rows.length > limit`.
 * `hasMore` needs a bound that is ours (`wasLimited`): an offset can only advance one this layer
 * wrote (#816).
 */
export function pageOfProbe<Row>(prepared: PreparedQuery, rows: Row[]): { hasMore: boolean; rows: Row[] } {
  const hasMore = prepared.wasLimited && rows.length > prepared.limit;
  return { hasMore, rows: hasMore ? rows.slice(0, prepared.limit) : rows };
}

/**
 * Why `options.limit` / `options.offset` cannot be a page bound, or null when they can.
 *
 * Read from the request body, so a value can be any JSON: the probe adds one to the limit, and
 * `"500" + 1` is the string `"5001"`, which would run a page ten times the size asked for.
 * Each is therefore required to be a non-negative integer when present.
 */
export function pageOptionError(options: unknown): string | null {
  if (options === null || typeof options !== "object") return "options must be an object";
  const { limit, offset } = options as Record<string, unknown>;
  for (const [name, value] of [
    ["limit", limit],
    ["offset", offset],
  ] as const) {
    if (value !== undefined && !(typeof value === "number" && Number.isInteger(value) && value >= 0)) {
      return `options.${name} must be a non-negative integer`;
    }
  }
  return null;
}
