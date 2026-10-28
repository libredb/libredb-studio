import type { AccessRefusal, DriverErrorClassifier } from "@/lib/db/driver-errors/types";

/**
 * SQL Server error numbers for a statement the server parsed or ran and refused (#1427).
 * Severity alone would not do: a deadlock victim (1205) is severity 13, a user-correctable
 * level, and it is the transaction's fault, not the statement's.
 */
const MSSQL_STATEMENT_ERRORS = new Set([
  // Syntax: incorrect syntax near a token, near a keyword, and a missing or misused clause.
  102, 103, 105, 156, 170, 319,
  // A name that resolves to nothing: column, object, procedure, function, and an ambiguous column.
  207, 208, 209, 2812, 4121,
  // Constraints and values: NOT NULL, a FOREIGN KEY or CHECK conflict, a unique key, a value that
  // does not convert, an arithmetic overflow, a divide by zero, and a truncated string.
  515, 547, 2601, 2627, 245, 8114, 8115, 8134, 2628, 8152,
  // An object that already exists. A permission the principal lacks is an access refusal
  // (`MSSQL_ACCESS_REFUSALS`), decided before this list is read.
  2714,
]);

/**
 * SQL Server error numbers of a refused privilege, from its Database Engine errors: 229 on an object, 230 on a column,
 * 262 in a database, 297 for an action, 300 on a server-level object, 916 a database the login may not enter. tedious
 * raises a refused login as `ELOGIN` without the server's 18456, so the words decide that one: `credentialWords`.
 */
const MSSQL_ACCESS_REFUSALS: ReadonlyMap<number, AccessRefusal> = new Map([
  [229, "privilege"],
  [230, "privilege"],
  [262, "privilege"],
  [297, "privilege"],
  [300, "privilege"],
  [916, "privilege"],
]);

/**
 * `mssql`'s row: it puts the error number in `number` (`2812` for an unknown procedure).
 *
 * Its 4060, a database the login cannot open, is read before the access refusals: its own sentence ends in "The login
 * failed.", so the credential words would answer a missing database as a wrong password (#1451).
 *
 * `mssql` and `tedious` end a cancelled request with `RequestError('Canceled.', 'ECANCEL')`, whose sentence holds no
 * cancellation word, so it is read from the driver's code. No other installed driver raises `ECANCEL`; the POSIX
 * `ECANCELED` is a different string. A cancel the SQL Server provider's own deadline made never reaches here:
 * `runWithDeadline` answers it as its time-budget QueryError first.
 */
export const MSSQL_DRIVER_ERRORS = Object.freeze({
  driver: "mssql",
  missingDatabase: (message) => message.includes("cannot open database"),
  credentialWords: Object.freeze(["login failed"]),
  accessRefusal: (fields) => (typeof fields.number === "number" ? MSSQL_ACCESS_REFUSALS.get(fields.number) : undefined),
  carriesCode: (fields) => typeof fields.number === "number",
  statementFault: (fields) =>
    typeof fields.number === "number" && MSSQL_STATEMENT_ERRORS.has(fields.number) ? true : undefined,
  cancelled: (_message, fields) => fields.code === "ECANCEL",
} satisfies DriverErrorClassifier);
