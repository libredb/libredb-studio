import { ReadAllowanceExceededError, RefusedBeforeSendError } from "@/lib/db/errors";
import { readQueryFormsOf } from "@/lib/db/providers/sql/read-query-forms";
import {
  READ_ONLY_REFUSAL_OPENINGS,
  type ReadOnlyRefusalKind,
  type ReadOnlyRefusalOpening,
} from "@/lib/db/providers/sql/read-only-refusals";
import { analyzeQuery } from "@/lib/db/utils/query-limiter";
import type { DatabaseType } from "@/lib/types";

/**
 * The pure rules run_read_query follows (#246).
 *
 * A provider's read-only budget refusal is recognised by the fixed opening of this repository's
 * own messages, and answered in this server's words. The row and byte refusals are built once, by
 * the constructors in src/lib/db/providers/sql/read-only-budget.ts that every provider with a
 * queryReadOnly calls; every other opening, and the answer to a kind only one engine raises, is
 * declared beside the provider that raises it. All of them are read from READ_ONLY_REFUSAL_OPENINGS
 * in src/lib/db/providers/sql/read-only-refusals.ts rather than typed again here. A test reads the
 * provider files and fails when an opening no longer occurs, so a reworded message cannot fall
 * through to an engine error. A time-budget refusal, and any failure that settles once the
 * deadline has passed, is the timeout, so which of the two settles first never changes what the
 * client reads. The deadline race stops the wait for a statement, not the statement: no provider
 * can cancel a read-only statement yet (docs/BACKLOG.md D128).
 *
 * The statements an engine takes and its own paging clause differ by engine, so every text that names either reads the
 * engine's row in src/lib/db/providers/sql/read-query-forms.ts rather than one engine's words for all.
 */

export type { ReadOnlyRefusalKind };

export const READ_ONLY_REFUSALS: readonly ReadOnlyRefusalOpening[] = READ_ONLY_REFUSAL_OPENINGS;

const TOO_LARGE_TEXTS: Record<"rows" | "bytes", string> = {
  rows: "The result has more than 1000 rows, the most this server reads for one call. Add a LIMIT of 1000 or less, or remove your own LIMIT and page with offset.",
  bytes:
    "The result is larger than 1 MiB, the most this server reads for one call. Select fewer or narrower columns, or add a smaller LIMIT.",
};

export type ReadQueryFailure =
  | { readonly kind: "timeout" }
  | { readonly kind: "too-large"; readonly text: string }
  | { readonly kind: "not-sent"; readonly text: string }
  | { readonly kind: "engine"; readonly error: unknown };

/** `texts` answers a budget refusal in a statement language's own words; a refusal it leaves out keeps the SQL text. */
export function classifyReadQueryFailure(
  error: unknown,
  settledAt: number,
  deadline: number,
  texts: Partial<Record<Exclude<ReadOnlyRefusalKind, "time">, string>> = {},
): ReadQueryFailure {
  if (settledAt >= deadline) return { kind: "timeout" };
  // The call's read allowance, refused by this server before anything was sent: its own sentence, never the
  // database's error.
  if (error instanceof ReadAllowanceExceededError) return { kind: "too-large", text: error.message };
  // Any other statement this repository refused before sending it, a provider's own fence: its sentence, said to be
  // this server's refusal rather than the database's error.
  if (error instanceof RefusedBeforeSendError) return { kind: "not-sent", text: notSentText(error.message) };
  const message = error instanceof Error ? error.message : String(error);
  const refusal = READ_ONLY_REFUSALS.find(({ prefix }) => message.startsWith(prefix));
  if (refusal === undefined) return { kind: "engine", error };
  if (refusal.kind === "time") return { kind: "timeout" };
  const own = "tooLargeText" in refusal ? refusal.tooLargeText : TOO_LARGE_TEXTS[refusal.kind];
  return { kind: "too-large", text: texts[refusal.kind] ?? own };
}

/** Whether `prepareQuery` can page `type`'s SQL with an offset; where it cannot, no offset is ever named or taken. */
export function pagesWithOffset(type: DatabaseType): boolean {
  return readQueryFormsOf(type).pagesWithOffset;
}

/**
 * The budget refusals in `type`'s words where they differ from the shared ones: an engine with no offset is never told
 * to page with one.
 */
export function tooLargeTextsOf(type: DatabaseType): Partial<Record<"rows", string>> {
  if (pagesWithOffset(type)) return {};
  return {
    rows: `The result has more than 1000 rows, the most this server reads for one call. Add a LIMIT of 1000 or less, and page it in SQL: ${readQueryFormsOf(type).paging}.`,
  };
}

export function inSqlPaging(type: DatabaseType): string {
  return `Page it in SQL: ${readQueryFormsOf(type).paging}.`;
}

export function moreRowsThanPageableHint(type: DatabaseType): string {
  return `More rows exist than this result holds, and this query cannot be paged with offset. ${inSqlPaging(type)}`;
}

export const ROW_OVER_CAP_TEXT =
  "One row of this result is larger than the 32 KiB result limit. Select fewer or narrower columns, for example a substring of a long text column.";

const NOT_PAGEABLE_TEXT = "This statement's result cannot be paged. Call again without offset.";

/** Which of the three cases kept the provider from rewriting the query, read with its own analyzer. */
export function offsetRefusalText(sql: string, type: DatabaseType): string {
  const info = analyzeQuery(sql, type);
  if (info.type !== "SELECT") return NOT_PAGEABLE_TEXT;
  if (!pagesWithOffset(type)) {
    return `This engine's SQL has no OFFSET, so this query cannot be paged with offset. ${inSqlPaging(type)}`;
  }
  if (!info.hasLimit) return `This query cannot be paged with offset. ${inSqlPaging(type)}`;
  return `This query has its own LIMIT or TOP, so it cannot be paged with offset. Remove it and page with offset, or page it in SQL: ${readQueryFormsOf(type).paging}.`;
}

export function timeoutText(timeoutMs: number): string {
  return `The statement did not finish within timeout_ms (${timeoutMs} ms). Narrow it, or raise timeout_ms up to 30000.`;
}

export function nextPageHint(nextOffset: number): string {
  return `Call again with offset ${nextOffset} for the next page.`;
}

function notSentText(message: string): string {
  const reason = /[.!?]$/.test(message) ? message : `${message}.`;
  return `The statement was refused before it reached the database: ${reason}`;
}

export function fenceRefusalText(code: string, type: DatabaseType): string {
  return `The statement was refused before it reached the database (${code}). On this engine run_read_query runs one read-only statement: ${readQueryFormsOf(type).statements}.`;
}

export function profileRefusalText(message: string, engines: string, tool: string): string {
  // #1462: inspect_schema runs under the same role-checking profile on PostgreSQL, so
  // it is not true that inspect_schema works on every engine; and an ExecutionProfileError
  // message (postgres.ts's assertAgentRoleIsUnprivileged) already ends in a period, so
  // appending unconditionally produced a double period. Strip any trailing ones first.
  const sentence = message.replace(/\.+$/, "");
  return `${tool} cannot run on this connection: ${sentence}. It runs on ${engines}.`;
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
