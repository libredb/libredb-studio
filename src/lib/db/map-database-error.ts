/**
 * The mapping of a native driver error onto the database error types, read from each driver's row in
 * `DRIVER_ERROR_CLASSIFIERS`. Kept apart from the error types in `errors.ts`, so a reader of an error class never
 * pulls the driver rows, and through them the providers, into its bundle.
 */

import type { DatabaseType } from "./types";
import { DRIVER_ERROR_CLASSIFIERS } from "@/lib/db/driver-errors";
import type { AccessRefusal, DriverErrorClassifier, DriverErrorFields } from "@/lib/db/driver-errors/types";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  DatabaseError,
  PermissionDeniedError,
  PoolExhaustedError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
  isDatabaseError,
} from "./errors";

/**
 * The SQLSTATE classes that name a fault of the statement itself (#1427): `0A` feature not
 * supported, `21` cardinality violation, `22` data exception, `23` integrity constraint
 * violation, `42` syntax error or access rule violation and `44` WITH CHECK OPTION violation.
 * Every other class is the connection's, the transaction's or the server's (`08` connection,
 * `40` rollback, `53` resources, `57` operator intervention, `XX` internal), and keeps the
 * class the rest of `mapDatabaseError` gives it. A refused privilege in class `42` (`42501`,
 * `42502`) never reaches it: the access refusals are decided first (`accessRefusalOf`).
 */
const STATEMENT_SQLSTATE = /^(0A|2[123]|4[24])[0-9A-Z]{3}$/;

/** The first answer a driver row gives, in the registry's order, or undefined when none gives one. */
function firstAnswer<Answer>(ask: (row: DriverErrorClassifier) => Answer | undefined): Answer | undefined {
  for (const row of DRIVER_ERROR_CLASSIFIERS) {
    const answer = ask(row);
    if (answer !== undefined) return answer;
  }
  return undefined;
}

/**
 * Whether the driver's own code fields say the STATEMENT is at fault (#1427).
 *
 * Read from codes and never from the message, so a table named `pool_items` or `timeouts`
 * cannot decide the class (BACKLOG B4). Each driver publishes its own field, measured on the
 * installed drivers on 2026-10-04: the SQLSTATE in `code`, `sqlState` or `sqlstate`, read here,
 * and every other field by the driver's row in `DRIVER_ERROR_CLASSIFIERS`, which may also say a
 * code is not the statement's fault before any SQLSTATE is read.
 *
 * A code no row knows answers false, and the caller's other branches decide.
 */
function isStatementFault(error: Error): boolean {
  const fields = error as DriverErrorFields;
  if (DRIVER_ERROR_CLASSIFIERS.some((row) => row.notStatementFault?.(fields) === true)) return false;
  for (const state of [fields.code, fields.sqlState, fields.sqlstate]) {
    if (typeof state === "string" && STATEMENT_SQLSTATE.test(state)) return true;
  }
  return firstAnswer((row) => row.statementFault?.(fields)) ?? false;
}

/** A SQLSTATE: five digits or uppercase letters, with a digit, so a system code such as `EPIPE` is not read as one. */
const SQLSTATE = /^(?=[A-Z]*\d)[0-9A-Z]{5}$/;

/** The SQLSTATE in a driver error's own code fields, read the way `isStatementFault` reads them, or undefined. */
function driverSqlstate(error: Error): string | undefined {
  const fields = error as Error & { code?: unknown; sqlState?: unknown; sqlstate?: unknown };
  return [fields.code, fields.sqlState, fields.sqlstate].find(
    (state): state is string => typeof state === "string" && SQLSTATE.test(state),
  );
}

/**
 * SQLSTATEs of a refused privilege: `42501` insufficient_privilege (PostgreSQL's Appendix A, also Db2's SQL0551N) and
 * `42502` (Db2's SQL0552N). Class `28`, invalid authorization specification, is a refused credential: PostgreSQL's
 * `28000` and `28P01`, and the `28000` MySQL gives its 1045 and 1698.
 */
const PRIVILEGE_SQLSTATES = new Set(["42501", "42502"]);
const CREDENTIAL_SQLSTATE_CLASS = "28";

/**
 * Whether the driver's own code fields say the server refused the caller, and how: a refusal, `null` when the code
 * names neither, and `undefined` when the error carries no code this module reads. Only the last is read by its
 * words, so a column called `password` is the statement's fault and never a refused credential.
 *
 * The SQLSTATE is read here; every other code field by the driver rows, in the registry's order.
 */
function accessRefusalOf(error: Error): AccessRefusal | null | undefined {
  const fields = error as DriverErrorFields;
  const sqlstate = driverSqlstate(error);
  if (sqlstate !== undefined && PRIVILEGE_SQLSTATES.has(sqlstate)) return "privilege";
  if (sqlstate?.startsWith(CREDENTIAL_SQLSTATE_CLASS)) return "credential";
  const refusal = firstAnswer((row) => row.accessRefusal?.(fields));
  if (refusal !== undefined) return refusal;
  const carriesCode =
    sqlstate !== undefined || DRIVER_ERROR_CLASSIFIERS.some((row) => row.carriesCode?.(fields) === true);
  return carriesCode ? null : undefined;
}

/** The words of a refused credential, read only in an error that carries no code, beside each driver row's own. */
const CREDENTIAL_WORDS = [
  "password",
  "authentication",
  "access denied",
  ...DRIVER_ERROR_CLASSIFIERS.flatMap((row) => row.credentialWords ?? []),
];

/** The words of a cancelled statement any driver may use, beside each driver row's own. */
const CANCELLED_WORDS = ["query was cancelled", "kill query"];

/**
 * Map native database errors to our error types, keeping the driver's SQLSTATE on the mapped error.
 */
export function mapDatabaseError(error: unknown, provider: DatabaseType, query?: string): DatabaseError {
  if (isDatabaseError(error)) {
    return error;
  }

  if (!(error instanceof Error)) {
    return new DatabaseError(String(error), provider);
  }

  const mapped = mapNativeError(error, provider, query);
  const sqlstate = driverSqlstate(error);
  if (sqlstate !== undefined) mapped.sqlstate = sqlstate;
  return mapped;
}

function mapNativeError(error: Error, provider: DatabaseType, query?: string): DatabaseError {
  const message = error.message.toLowerCase();
  const fields = error as DriverErrorFields;

  // Connection errors
  if (
    message.includes("econnrefused") ||
    message.includes("connection refused") ||
    message.includes("connect etimedout") ||
    message.includes("getaddrinfo")
  ) {
    return new ConnectionError(`Failed to connect to ${provider} database: ${error.message}`, provider);
  }

  // A refusal of the driver's own configuration, read before the access refusals: its text may hold a credential
  // word for a condition no credential repairs.
  const configRefusal = firstAnswer((row) => row.configRefusal?.(message, error) ?? undefined);
  if (configRefusal !== undefined) return new DatabaseConfigError(configRefusal, provider);

  // A database the login cannot open, read before the access refusals for the same reason.
  if (DRIVER_ERROR_CLASSIFIERS.some((row) => row.missingDatabase?.(message) === true)) {
    return new ConnectionError(`Database not found: ${error.message}`, provider);
  }

  // Access refusals, read from the driver's code wherever the error carries one (`accessRefusalOf`): a privilege the
  // credential lacks is not a refused credential, and answering it 401 "Authentication failed" sent a user whose
  // password is right to re-enter it. The words decide only an error with no code: "permission denied" names a
  // missing privilege, and the credential words a refused credential.
  const refusal = accessRefusalOf(error);
  if (refusal === "privilege" || (refusal === undefined && message.includes("permission denied"))) {
    return new PermissionDeniedError(`Permission denied: ${error.message}`, provider, query);
  }
  if (refusal === "credential" || (refusal === undefined && CREDENTIAL_WORDS.some((word) => message.includes(word)))) {
    return new AuthenticationError(`Authentication failed: ${error.message}`, provider);
  }

  // The statement's own fault, read from the driver's code fields (#1427). Placed after the
  // connection branch and the access refusals so nothing they classify changes class, and before
  // every later substring branch, so a statement error whose text happens to hold "timeout" or
  // "pool" is not read as one. The engine's message is kept as it is, unprefixed, because it is
  // what the reader corrects the statement from.
  if (isStatementFault(error)) {
    return new QueryError(error.message, provider, query, (error as { position?: number }).position);
  }

  // An engine's own report of a time budget that elapsed, in its own words, read before the cancellation words a
  // driver row may share with it.
  if (DRIVER_ERROR_CLASSIFIERS.some((row) => row.timeout?.(message) === true)) {
    return new TimeoutError(error.message, provider, undefined, query);
  }

  // Query cancellation, checked before timeout: a cancel is not a timeout.
  if (
    DRIVER_ERROR_CLASSIFIERS.some((row) => row.cancelled?.(message, fields) === true) ||
    CANCELLED_WORDS.some((word) => message.includes(word))
  ) {
    return new QueryCancelledError("Query was cancelled", provider, query);
  }

  // Timeout errors
  if (message.includes("timeout") || message.includes("timed out")) {
    return new TimeoutError(`Query timeout: ${error.message}`, provider, undefined, query);
  }

  // What a driver row reads from the message last: a connection its listener refused, a missing object, or the words
  // of a statement error.
  const late = firstAnswer((row) => row.late?.(message, error));
  if (late?.kind === "connection") return new ConnectionError(late.message, provider);
  if (late?.kind === "query") {
    return new QueryError(
      late.message,
      provider,
      query,
      late.keepsPosition ? (error as { position?: number }).position : undefined,
    );
  }

  // Pool errors
  if (message.includes("pool") || message.includes("too many connections")) {
    return new PoolExhaustedError(`Connection pool error: ${error.message}`, provider);
  }

  // Generic database error
  return new DatabaseError(error.message, provider, undefined, query);
}
