import { analyzeQuery } from "@/lib/db/utils/query-limiter";
import type { DatabaseType } from "@/lib/types";

/**
 * The pure rules run_read_query follows (#246).
 *
 * A provider's read-only budget refusal is recognised by the fixed opening of this repository's
 * own messages, under src/lib/db/providers/sql/, and answered in this server's words; a test reads
 * those provider files and fails when an opening no longer occurs, so a reworded message cannot
 * fall through to an engine error. A time-budget refusal, and any failure that settles once the
 * deadline has passed, is the timeout, so which of the two settles first never changes what the
 * client reads. The deadline race stops the wait for a statement, not the statement: no provider
 * can cancel a read-only statement yet (docs/BACKLOG.md D122).
 */

export type ReadOnlyRefusalKind = "rows" | "bytes" | "cut-value" | "serialised" | "time";

export const READ_ONLY_REFUSALS: readonly { readonly prefix: string; readonly kind: ReadOnlyRefusalKind }[] = [
  { prefix: "Read-only execution exceeded the row budget", kind: "rows" },
  { prefix: "Read-only execution exceeded the byte budget", kind: "bytes" },
  { prefix: "Read-only execution refused a value the server cut at the byte budget", kind: "cut-value" },
  { prefix: "Read-only execution cannot bound a serialised result", kind: "serialised" },
  { prefix: "Read-only execution exceeded the time budget", kind: "time" },
  { prefix: "Read-only execution exceeded its time budget", kind: "time" },
];

const TOO_LARGE_TEXTS: Record<Exclude<ReadOnlyRefusalKind, "time">, string> = {
  rows: "The result has more than 1000 rows, the most this server reads for one call. Add a LIMIT of 1000 or less, or remove your own LIMIT and page with offset.",
  bytes:
    "The result is larger than 1 MiB, the most this server reads for one call. Select fewer or narrower columns, or add a smaller LIMIT.",
  "cut-value":
    "One value in this result is 1 MiB or larger, and SQL Server cut it at the most this server reads for one call. Select fewer or narrower columns, for example a substring of a long text column.",
  serialised:
    "SQL Server returns a FOR JSON or FOR XML result as one serialised value, which this server cannot bound. Select the rows themselves, without the FOR JSON or FOR XML clause.",
};

export type ReadQueryFailure =
  | { readonly kind: "timeout" }
  | { readonly kind: "too-large"; readonly text: string }
  | { readonly kind: "engine"; readonly error: unknown };

export function classifyReadQueryFailure(error: unknown, settledAt: number, deadline: number): ReadQueryFailure {
  if (settledAt >= deadline) return { kind: "timeout" };
  const message = error instanceof Error ? error.message : String(error);
  const refusal = READ_ONLY_REFUSALS.find(({ prefix }) => message.startsWith(prefix));
  if (refusal === undefined) return { kind: "engine", error };
  return refusal.kind === "time" ? { kind: "timeout" } : { kind: "too-large", text: TOO_LARGE_TEXTS[refusal.kind] };
}

export const IN_SQL_PAGING =
  "Page it in SQL: LIMIT n OFFSET m, or on SQL Server ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY.";
export const MORE_ROWS_THAN_PAGEABLE_HINT = `More rows exist than this result holds, and this query cannot be paged with offset. ${IN_SQL_PAGING}`;
export const ROW_OVER_CAP_TEXT =
  "One row of this result is larger than the 32 KiB result limit. Select fewer or narrower columns, for example a substring of a long text column.";

const OWN_LIMIT_TEXT =
  "This query has its own LIMIT or TOP, so it cannot be paged with offset. Remove it and page with offset, or page it in SQL: LIMIT n OFFSET m, or on SQL Server ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY.";
const NO_CUT_TEXT = `This query cannot be paged with offset. ${IN_SQL_PAGING}`;
const NOT_PAGEABLE_TEXT = "This statement's result cannot be paged. Call again without offset.";

/** Which of the three cases kept the provider from rewriting the query, read with its own analyzer. */
export function offsetRefusalText(sql: string, type: DatabaseType): string {
  const info = analyzeQuery(sql, type);
  if (info.type !== "SELECT") return NOT_PAGEABLE_TEXT;
  return info.hasLimit ? OWN_LIMIT_TEXT : NO_CUT_TEXT;
}

export function timeoutText(timeoutMs: number): string {
  return `The statement did not finish within timeout_ms (${timeoutMs} ms). Narrow it, or raise timeout_ms up to 30000.`;
}

export function nextPageHint(nextOffset: number): string {
  return `Call again with offset ${nextOffset} for the next page.`;
}

export function fenceRefusalText(code: string): string {
  return `The statement was refused before it reached the database (${code}). run_read_query runs one read-only statement: a SELECT (a WITH is fine), VALUES, TABLE, or EXPLAIN without ANALYZE.`;
}

export function profileRefusalText(message: string, engines: string): string {
  return `run_read_query cannot run on this connection: ${message}. It runs on ${engines}; inspect_schema works on every engine.`;
}

export type Raced<T> =
  | { readonly kind: "settled"; readonly value: T }
  | { readonly kind: "failed"; readonly error: unknown; readonly settledAt: number }
  | { readonly kind: "cancelled" }
  | { readonly kind: "timeout" };

/** One awaited step of a call, raced against the call's signal and its deadline; nothing starts late. */
export async function raceDeadline<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
  deadline: number,
): Promise<Raced<T>> {
  if (signal.aborted) return { kind: "cancelled" };
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { kind: "timeout" };
  const settled = (async () => work())().then(
    (value): Raced<T> => ({ kind: "settled", value }),
    (error: unknown): Raced<T> => ({ kind: "failed", error, settledAt: Date.now() }),
  );
  const interrupted = Promise.withResolvers<Raced<T>>();
  const onAbort = () => interrupted.resolve({ kind: "cancelled" });
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => interrupted.resolve({ kind: "timeout" }), remaining);
  try {
    return await Promise.race([settled, interrupted.promise]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
