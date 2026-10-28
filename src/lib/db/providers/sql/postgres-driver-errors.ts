import type { DriverErrorClassifier } from "@/lib/db/driver-errors/types";

/**
 * `pg`'s row. The driver puts the SQLSTATE in `code` (`42601`), which the shared mapping reads; this row holds the
 * words of PostgreSQL's own messages.
 *
 * Preemption vs. operator cancel (#1145). Both a `statement_timeout` and a `lock_timeout` are reported as `canceling
 * statement due to <statement|lock> timeout`, sharing the `canceling statement` prefix an operator cancel
 * (`pg_cancel_backend`, `due to user request`) uses. Both are TIMEOUTS, a time budget elapsed and the statement never
 * ran to completion, so they map to a TimeoutError carrying the engine's own text, exactly as every other engine's
 * query timeout does. The mapping reads the timeout before the cancellation, which would otherwise match `canceling
 * statement` first and discard the wording that tells a timeout apart from a cancel.
 *
 * The statement words, read late and kept with the engine's position, are the ones its query errors use.
 */
export const POSTGRES_DRIVER_ERRORS = Object.freeze({
  driver: "pg",
  timeout: (message) =>
    message.includes("canceling statement due to statement timeout") || message.includes("due to lock timeout"),
  cancelled: (message) => message.includes("canceling statement"),
  late: (message: string, error: Error) =>
    message.includes("syntax error") || message.includes("column") || message.includes("relation")
      ? { kind: "query", message: error.message, keepsPosition: true }
      : undefined,
} satisfies DriverErrorClassifier);
