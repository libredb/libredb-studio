import type { ErrorKind } from "@libredb/provider-sdk/errors";
import { errorKind } from "@/lib/db/error-record";
import type { ReadAllowanceExceededError, RefusedBeforeSendError } from "@/lib/db/errors";
import { ENGINE_TOO_LARGE_TEXTS } from "@/lib/db/providers/sql/read-only-refusals";
import { readQueryFormsOf } from "@/lib/db/providers/sql/read-query-forms";
import { analyzeQuery } from "@/lib/db/utils/query-limiter";
import type { DatabaseType } from "@/lib/types";

/**
 * The pure rules run_read_query follows (#246).
 *
 * A failure is answered by its class, its error kind (src/lib/db/error-record.ts), never by its words: a provider's
 * or Studio's row, byte, cut-value or serialised budget refusal is answered as too large, in this server's words; a
 * time budget refusal is the timeout; a statement refused before it was sent is the provider's refusal; and any other
 * failure is the engine's, whatever its message says. A `TimeoutError` before the deadline is the engine's too: its
 * class says some timeout fired, not that it was the call's (Cassandra's coordinator, a connection's own query
 * timeout), so its own text, not a sentence claiming timeout_ms was reached, says which. `MCP_FAILURE_OF_KIND` holds one answer for every
 * kind, so a kind added to `ERROR_KINDS` fails typecheck until it is given one. Which provider sites raise a budget
 * refusal as its class is held by tests/unit/db/operations/budget-refusal-census.test.ts. Any failure that settles
 * once the deadline has passed is the deadline, answered as the deadline timer's own answer is, so which of the two
 * settles first never changes what the client reads.
 * The deadline race stops the wait for a statement, not the statement: no provider can cancel a read-only statement
 * yet (docs/BACKLOG.md D128).
 *
 * The statements an engine takes and its own paging clause differ by engine, so every text that names either reads the
 * engine's row in src/lib/db/providers/sql/read-query-forms.ts rather than one engine's words for all.
 */

/** The kinds of read-only budget refusal a provider raises. */
export type ReadOnlyRefusalKind = "rows" | "bytes" | "cut-value" | "serialised" | "time";

/**
 * The bounds of every MCP tool's `timeout_ms`: at least 500 ms, unless a statement facet raises its own least
 * (`leastTimeout`), and at most 30000 ms, the most a timeout answer offers.
 */
export const MCP_TIMEOUT_BOUNDS_MS = { min: 500, max: 30_000 } as const;

/** The answer a statement tool gives a failure of each kind before the deadline. */
type McpFailureClass = Exclude<ReadOnlyRefusalKind, "time"> | "timeout" | "allowance" | "not-sent" | "engine";

/**
 * One answer for every error kind, so a kind added to `ERROR_KINDS` fails typecheck until it has one. A budget
 * refusal is too large (`rows`, `bytes`, `cut-value`, `serialised`) or the timeout, Studio's and the provider's alike;
 * the call's read allowance is too large in its own sentence; a statement refused before it was sent is the
 * provider's refusal; every other kind, `timeout` among them, is the engine's error.
 */
export const MCP_FAILURE_OF_KIND: Readonly<Record<ErrorKind, McpFailureClass>> = {
  database: "engine",
  config: "engine",
  "unknown-provider": "engine",
  "not-offered": "engine",
  connection: "engine",
  "transaction-lost": "engine",
  authentication: "engine",
  permission: "engine",
  "pool-exhausted": "engine",
  query: "engine",
  "offset-unsupported": "engine",
  "refused-before-send": "not-sent",
  "read-allowance-exceeded": "allowance",
  "row-budget-refusal": "rows",
  "byte-budget-refusal": "bytes",
  "time-budget-refusal": "timeout",
  "cut-value-refusal": "cut-value",
  "serialised-result-refusal": "serialised",
  "studio-row-budget-refusal": "rows",
  "studio-byte-budget-refusal": "bytes",
  "studio-time-budget-refusal": "timeout",
  timeout: "engine",
  "studio-timeout-refusal": "engine",
  cancelled: "engine",
  "execution-profile": "engine",
  "studio-profile-refusal": "engine",
  "provider-text-withheld": "engine",
  internal: "engine",
};

/** The too-large answer of each budget class, where an arm's statement language gives none of its own. */
const TOO_LARGE_TEXTS: Record<Exclude<ReadOnlyRefusalKind, "time">, string> = {
  rows: "The result has more than 1000 rows, the most this server reads for one call. Add a LIMIT of 1000 or less, or remove your own LIMIT and page with offset.",
  bytes:
    "The result is larger than 1 MiB, the most this server reads for one call. Select fewer or narrower columns, or add a smaller LIMIT.",
  "cut-value": ENGINE_TOO_LARGE_TEXTS["cut-value"],
  serialised: ENGINE_TOO_LARGE_TEXTS.serialised,
};

/**
 * `deadline` is a failure that settled at or after the call's deadline, answered as the deadline itself is; `timeout`
 * is a time budget refusal before it.
 */
export type ReadQueryFailure =
  | { readonly kind: "deadline" }
  | { readonly kind: "timeout" }
  | { readonly kind: "too-large"; readonly text: string }
  | { readonly kind: "not-sent"; readonly error: RefusedBeforeSendError }
  | { readonly kind: "engine"; readonly error: unknown };

/**
 * The answer to a failed statement, by its error kind (`MCP_FAILURE_OF_KIND`). `texts` answers a budget refusal in a
 * statement language's own words; a refusal it leaves out keeps the shared text. A kind names its class by
 * construction (`errorKind` walks the prototype chain), so the `allowance` and `not-sent` answers hold the error as
 * that class.
 */
export function classifyReadQueryFailure(
  error: unknown,
  settledAt: number,
  deadline: number,
  texts: Partial<Record<Exclude<ReadOnlyRefusalKind, "time">, string>> = {},
): ReadQueryFailure {
  if (settledAt >= deadline) return { kind: "deadline" };
  const answer = MCP_FAILURE_OF_KIND[errorKind(error)];
  switch (answer) {
    case "timeout":
      return { kind: "timeout" };
    // The call's read allowance, refused by this server before anything was sent: its own sentence, never the
    // database's error.
    case "allowance":
      return { kind: "too-large", text: (error as ReadAllowanceExceededError).message };
    // Any other statement refused before it was sent, a provider's own fence: the error itself, which the caller
    // renders as the provider's text behind a notice naming it, never as the database's error.
    case "not-sent":
      return { kind: "not-sent", error: error as RefusedBeforeSendError };
    case "engine":
      return { kind: "engine", error };
    default:
      return { kind: "too-large", text: texts[answer] ?? TOO_LARGE_TEXTS[answer] };
  }
}

/** Whether `prepareQuery` can page `type`'s SQL with an offset; where it cannot, no offset is ever named or taken. */
export function pagesWithOffset(type: DatabaseType): boolean {
  return readQueryFormsOf(type).pagesWithOffset;
}

/**
 * The budget refusals in `type`'s words where they differ from the shared ones: an engine with no offset is never told
 * to page with one, and an engine with no `LIMIT` is told its own row limiting clause.
 */
export function tooLargeTextsOf(type: DatabaseType): Partial<Record<"rows" | "bytes", string>> {
  const { rowLimit, paging } = readQueryFormsOf(type);
  if (rowLimit !== undefined) {
    return {
      rows: `The result has more than 1000 rows, the most this server reads for one call. Add ${rowLimit.add} with n of 1000 or less, or remove your own ${rowLimit.own} and page with offset.`,
      bytes: `The result is larger than 1 MiB, the most this server reads for one call. Select fewer or narrower columns, or add ${rowLimit.add} with a smaller n.`,
    };
  }
  if (pagesWithOffset(type)) return {};
  return {
    rows: `The result has more than 1000 rows, the most this server reads for one call. Add a LIMIT of 1000 or less, and page it in SQL: ${paging}.`,
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
  const { rowLimit, paging } = readQueryFormsOf(type);
  return `This query has its own ${rowLimit?.own ?? "LIMIT or TOP"}, so it cannot be paged with offset. Remove it and page with offset, or page it in SQL: ${paging}.`;
}

/** The timeout answer of every statement tool; more time is offered only below the most `timeout_ms` allows. */
export function timeoutText(timeoutMs: number): string {
  const more = timeoutMs < MCP_TIMEOUT_BOUNDS_MS.max ? `, or raise timeout_ms up to ${MCP_TIMEOUT_BOUNDS_MS.max}` : "";
  return `The statement did not finish within timeout_ms (${timeoutMs} ms). Narrow it${more}.`;
}

export function nextPageHint(nextOffset: number): string {
  return `Call again with offset ${nextOffset} for the next page.`;
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
