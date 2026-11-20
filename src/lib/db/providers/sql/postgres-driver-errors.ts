import type { DriverErrorClassifier, DriverErrorFields } from "@/lib/db/driver-errors/types";

/**
 * SQLSTATE class `P0`, PL/pgSQL's own: an error the statement raised itself, `P0001` a `RAISE EXCEPTION`, `P0004` an
 * `ASSERT` that failed. Its words are its author's, so they never say what the server did.
 */
const RAISED_SQLSTATE = /^P0[0-9A-Z]{3}$/;

/** Whether `pg`'s `code` holds a SQLSTATE of class `P0`. */
const isRaised = (fields: DriverErrorFields): boolean =>
  typeof fields.code === "string" && RAISED_SQLSTATE.test(fields.code);

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
 * Not a timeout, whatever the words (A09, measured on PostgreSQL 19.0 and 18.7 on 2026-11-20): an error of class `P0`,
 * whose words are the statement author's (`RAISE EXCEPTION 'timed out while waiting'`), and a `57014` that names no
 * timeout, which is an operator cancel or the limit a statement set on its own wait, `WAIT FOR LSN ... WITH (TIMEOUT
 * '1s')` answering "timed out while waiting for target LSN ...". Both keep the engine's text; a `P0` error is not a
 * cancel either.
 *
 * The statement words, read late and kept with the engine's position, are the ones its query errors use.
 */
export const POSTGRES_DRIVER_ERRORS = Object.freeze({
  driver: "pg",
  timeout: (message) =>
    message.includes("canceling statement due to statement timeout") || message.includes("due to lock timeout"),
  notTimeout: (message, fields) => isRaised(fields) || (fields.code === "57014" && !message.includes("timeout")),
  cancelled: (message, fields) => message.includes("canceling statement") && !isRaised(fields),
  late: (message: string, error: Error) =>
    message.includes("syntax error") || message.includes("column") || message.includes("relation")
      ? { kind: "query", message: error.message, keepsPosition: true }
      : undefined,
} satisfies DriverErrorClassifier);
