import type { AccessRefusal, DriverErrorClassifier } from "@/lib/db/driver-errors/types";

/**
 * MySQL errors that carry SQLSTATE `42000` and are not the statement's fault: `1203`
 * `max_user_connections` and `1226` a per-account resource limit such as `max_questions`. The
 * account hit a limit; the same statement runs once it clears, so it keeps its 5xx class.
 */
export const MYSQL_ACCOUNT_LIMIT_ERRNOS = new Set([1203, 1226]);

/**
 * MySQL and MariaDB error numbers of an access refusal, from their error references. A privilege, each with SQLSTATE
 * `42000`: 1044 a database, 1142 a table, 1143 a column, 1227 a global privilege such as SUPER, 1370 a routine. The
 * account: 1045 and 1698 a refused login, 1820 and 1862 an expired password, 3118 a locked account and 3955 one
 * blocked after failed logins, the last four with SQLSTATE `HY000`.
 */
const MYSQL_ACCESS_REFUSALS: ReadonlyMap<number, AccessRefusal> = new Map([
  [1044, "privilege"],
  [1142, "privilege"],
  [1143, "privilege"],
  [1227, "privilege"],
  [1370, "privilege"],
  [1045, "credential"],
  [1698, "credential"],
  [1820, "credential"],
  [1862, "credential"],
  [3118, "credential"],
  [3955, "credential"],
]);

/** mysql2's error number, which counts only beside the `sqlState` every server error carries. */
function serverErrno(fields: { readonly sqlState?: unknown; readonly errno?: unknown }): unknown {
  return typeof fields.sqlState === "string" ? fields.errno : undefined;
}

/**
 * `mysql2`'s row, which MySQL-wire relatives answer through too. It puts the SQLSTATE in `sqlState` (`42000`), read by
 * the shared mapping, and the server's error number in `errno`. `bun:sqlite`'s `errno` and a system error's carry no
 * `sqlState`, so they are never read as an access refusal; an account limit is read from `errno` alone, as before.
 */
export const MYSQL_DRIVER_ERRORS = Object.freeze({
  driver: "mysql2",
  notStatementFault: (fields) => typeof fields.errno === "number" && MYSQL_ACCOUNT_LIMIT_ERRNOS.has(fields.errno),
  accessRefusal: (fields) => {
    const errno = serverErrno(fields);
    return typeof errno === "number" ? MYSQL_ACCESS_REFUSALS.get(errno) : undefined;
  },
  carriesCode: (fields) => typeof serverErrno(fields) === "number",
  cancelled: (message) => message.includes("query execution was interrupted"),
} satisfies DriverErrorClassifier);
