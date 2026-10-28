/**
 * Database Error Classes
 * Custom error types for database operations
 */

import type { DatabaseType } from "./types";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { DRIVER_ERROR_CLASSIFIERS } from "@/lib/db/driver-errors";
import type { AccessRefusal, DriverErrorClassifier, DriverErrorFields } from "@/lib/db/driver-errors/types";

const QUERY_PREVIEW_MAX_LENGTH = 100;

// ============================================================================
// Base Database Error
// ============================================================================

/**
 * Base error class for all database-related errors
 */
export class DatabaseError extends Error {
  /**
   * The five-character SQLSTATE the driver reported for the error this one was mapped from, when it reported one
   * (`mapDatabaseError`). The query event of the failed statement records it (docs/GOVERNANCE.md, "Query events");
   * no response carries it.
   */
  declare sqlstate?: string;

  constructor(
    message: string,
    public readonly provider?: DatabaseType,
    public readonly code?: ApiErrorCode,
    public readonly query?: string,
  ) {
    super(message);
    this.name = "DatabaseError";
    Object.setPrototypeOf(this, DatabaseError.prototype);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      provider: this.provider,
      code: this.code,
      // Don't expose full query in production for security
      query: this.query
        ? this.query.length > QUERY_PREVIEW_MAX_LENGTH
          ? this.query.substring(0, QUERY_PREVIEW_MAX_LENGTH) + "..."
          : this.query
        : undefined,
    };
  }
}

// ============================================================================
// Configuration Errors
// ============================================================================

/**
 * Configuration error - missing or invalid configuration
 */
export class DatabaseConfigError extends DatabaseError {
  constructor(message: string, provider?: DatabaseType) {
    super(message, provider, ApiErrorCode.CONFIG_ERROR);
    this.name = "DatabaseConfigError";
    Object.setPrototypeOf(this, DatabaseConfigError.prototype);
  }
}

// ============================================================================
// Connection Errors
// ============================================================================

/**
 * Connection error - failed to connect to database
 */
export class ConnectionError extends DatabaseError {
  constructor(
    message: string,
    provider?: DatabaseType,
    public readonly host?: string,
    public readonly port?: number,
  ) {
    super(message, provider, ApiErrorCode.CONNECTION_ERROR);
    this.name = "ConnectionError";
    Object.setPrototypeOf(this, ConnectionError.prototype);
  }
}

/**
 * Authentication error - invalid credentials
 */
export class AuthenticationError extends DatabaseError {
  /**
   * A statement the user can copy and run to fix the refusal, when the provider knows one; shown under the message.
   * An own property only then, so every other AuthenticationError has the same own keys as before it existed.
   */
  declare readonly fixStatement?: string;

  constructor(message: string, provider?: DatabaseType, options: { readonly fixStatement?: string } = {}) {
    super(message, provider, ApiErrorCode.AUTH_ERROR);
    this.name = "AuthenticationError";
    if (options.fixStatement !== undefined) this.fixStatement = options.fixStatement;
    Object.setPrototypeOf(this, AuthenticationError.prototype);
  }
}

/**
 * Permission denied - the database accepted the credential and refused the statement for a privilege that credential
 * lacks, such as PostgreSQL's `permission denied for table orders`. Not an AuthenticationError, whose 401 tells the
 * user to re-enter a password that is right; `mapDatabaseError` reads which of the two a refusal is from the driver's
 * code.
 */
export class PermissionDeniedError extends DatabaseError {
  constructor(message: string, provider?: DatabaseType, query?: string) {
    super(message, provider, ApiErrorCode.PERMISSION_DENIED, query);
    this.name = "PermissionDeniedError";
    Object.setPrototypeOf(this, PermissionDeniedError.prototype);
  }
}

/**
 * Pool exhausted error - no available connections in pool
 */
export class PoolExhaustedError extends DatabaseError {
  constructor(
    message: string,
    provider?: DatabaseType,
    public readonly poolSize?: number,
  ) {
    super(message, provider, ApiErrorCode.POOL_EXHAUSTED);
    this.name = "PoolExhaustedError";
    Object.setPrototypeOf(this, PoolExhaustedError.prototype);
  }
}

// ============================================================================
// Query Errors
// ============================================================================

/**
 * Query error - SQL syntax or execution error
 */
export class QueryError extends DatabaseError {
  constructor(
    message: string,
    provider?: DatabaseType,
    query?: string,
    public readonly position?: number,
    public readonly detail?: string,
  ) {
    super(message, provider, ApiErrorCode.QUERY_ERROR, query);
    this.name = "QueryError";
    Object.setPrototypeOf(this, QueryError.prototype);
  }
}

/**
 * What `prepareQuery()` raises for a positive offset on an engine whose SQL cannot page a result: Cassandra's CQL and
 * Elasticsearch SQL have no OFFSET clause. A `QueryError`, so the query route answers it as before; its own class, so
 * MCP `run_read_query` answers exactly this refusal as `mcp_offset_unsupported`, in the provider's own sentence, and
 * every other failure of `prepareQuery()` as the engine's.
 */
export class OffsetUnsupportedError extends QueryError {
  constructor(message: string, provider?: DatabaseType, query?: string) {
    super(message, provider, query);
    this.name = "OffsetUnsupportedError";
    Object.setPrototypeOf(this, OffsetUnsupportedError.prototype);
  }
}

/**
 * What `beginTransaction()` raises when the server accepted the BEGIN and its own status
 * says no transaction is open, the providers that can read that status (PostgreSQL's
 * ReadyForQuery byte, MySQL's `SERVER_STATUS_IN_TRANS`) share it. Measured 2026-10-04 on
 * RisingWave 3.1.0: `BEGIN` answers success with the NOTICE "no transaction is actually
 * started" and ReadyForQuery `I`, and an INSERT and a DELETE run after it stayed applied
 * through the ROLLBACK that SANDBOX reported as "Changes auto-rolled back". Raised as a
 * `QueryError`, so the route answers 400 with this sentence and the UI shows it as is.
 */
export const NO_TRANSACTION_OPENED =
  "This server accepted BEGIN but did not open a transaction, so nothing run in it could be rolled back. Transactions and SANDBOX are not available on this connection.";

/**
 * What every transaction provider (postgres, mysql, mssql, oracle) raises for a statement, COMMIT or ROLLBACK sent
 * while it holds no transaction, and what `POST /api/db/transaction` raises under governance for a caller who owns no
 * transaction there (docs/GOVERNANCE.md#query-events). Raised as a `QueryError`, so the route answers 400 QUERY_ERROR
 * with this sentence, and the editor's `transactionGone()` reads exactly this sentence as "the transaction is gone" and
 * leaves transaction mode. One constant for every producer and the one reader, so the two can never drift apart.
 */
export const NO_ACTIVE_TRANSACTION = "No active transaction";

/**
 * What `beginTransaction({ requireReportedState: true })` raises when the server answered the
 * BEGIN without reporting any transaction state (see `BeginTransactionResult`). SANDBOX asks
 * for that, because it tells the user their changes were rolled back, and on such a server
 * nothing Studio can read would show it. A manual transaction is still opened there.
 */
export const TRANSACTION_STATE_UNREPORTED =
  "This server does not report whether a transaction is open, so Studio cannot prove that SANDBOX rolled anything back. SANDBOX is not available on this connection; BEGIN, COMMIT and ROLLBACK still are.";

/**
 * Timeout error - query or connection timeout
 */
export class TimeoutError extends DatabaseError {
  constructor(
    message: string,
    provider?: DatabaseType,
    public readonly timeout?: number,
    query?: string,
  ) {
    super(message, provider, ApiErrorCode.TIMEOUT_ERROR, query);
    this.name = "TimeoutError";
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

/**
 * Query cancelled error - user-initiated cancellation
 */
export class QueryCancelledError extends DatabaseError {
  constructor(message: string, provider?: DatabaseType, query?: string) {
    super(message, provider, ApiErrorCode.QUERY_CANCELLED, query);
    this.name = "QueryCancelledError";
    Object.setPrototypeOf(this, QueryCancelledError.prototype);
  }
}

// ============================================================================
// Execution-profile errors (#328)
// ============================================================================

/**
 * Why an execution-profile acquisition was refused. Every refusal carries one:
 * a caller that has to parse a message to learn why it was denied cannot fail
 * closed on the reason.
 */
export type ExecutionProfileDenyCode =
  | "UNSUPPORTED_PROFILE"
  | "PROFILE_UNSUPPORTED_BY_PROVIDER"
  | "PROFILE_UNSUPPORTED_TARGET"
  /** The role the profile would run as holds privileges no read-only boundary can contain. */
  | "PROFILE_PRIVILEGES_TOO_BROAD"
  /**
   * The role the profile would run as is missing a privilege the BOUNDARY ITSELF needs.
   *
   * The opposite of the code above, and its own because the two are repaired in opposite
   * directions. SQL Server is where they came apart: its admission step asks the optimizer
   * to compile a candidate without running it, which needs `SHOWPLAN`, so a principal that
   * is merely a reader cannot be admitted at all. Reported as `PROFILE_PRIVILEGES_TOO_BROAD`
   * it told an operator to narrow a principal that needed one more grant.
   */
  | "PROFILE_PRIVILEGES_TOO_NARROW"
  /**
   * The server does not enforce authorization: it accepted a write from a principal whose own
   * privileges read as read-only, or from no principal at all.
   *
   * Its own code, apart from both above, because neither of their repairs works here. No user is
   * held read-only on such a server, so narrowing the principal changes nothing, and neither does
   * granting it more; the repair is the server's configuration, the opposite of narrowing a user.
   * MongoDB is where it came apart: on a server started without authorization, a user holding only
   * the `read` role wrote with `insertOne` while its own privileges still read as read-only (issue
   * #1614). Reported as `PROFILE_PRIVILEGES_TOO_BROAD` it told an operator to narrow a user who was
   * already as narrow as a user can be.
   */
  | "PROFILE_SERVER_UNENFORCED"
  | "AGENT_CREDENTIAL_UNRESOLVABLE"
  | "AGENT_CREDENTIAL_WITH_CONNECTION_STRING";

/**
 * Raised when a provider cannot be vended under a requested execution profile.
 * It lives here, with the other database errors, rather than in the factory:
 * providers themselves raise it (SQLite refuses an in-memory target), and a
 * provider must not have to import the factory to state why it fails closed.
 *
 * Kept a plain Error rather than a DatabaseError subclass for now — nothing
 * maps it to an API response yet, and the route surface that eventually will
 * (#329+) is where that decision belongs.
 */
export class ExecutionProfileError extends Error {
  constructor(
    message: string,
    public readonly reasonCode: ExecutionProfileDenyCode,
  ) {
    super(message);
    this.name = "ExecutionProfileError";
    Object.setPrototypeOf(this, ExecutionProfileError.prototype);
  }
}

// ============================================================================
// Type Guards
// ============================================================================

export function isDatabaseError(error: unknown): error is DatabaseError {
  return error instanceof DatabaseError;
}

export function isConnectionError(error: unknown): error is ConnectionError {
  return error instanceof ConnectionError;
}

export function isQueryError(error: unknown): error is QueryError {
  return error instanceof QueryError;
}

/**
 * A wait in milliseconds as the words a sentence names it with: tenths below 10 s and never fewer than 0.1, so a
 * deadline of a few milliseconds does not read as no wait at all; whole seconds from 10 s up; "1 second" in the
 * singular.
 */
export function waitedSeconds(ms: number): string {
  const seconds = ms < 9_950 ? Math.max(0.1, Math.round(ms / 100) / 10) : Math.round(ms / 1000);
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

/**
 * Runs a provider's connect(), timing it. A deadline met there ran no statement: the server was never reached, or
 * was reached and did not answer the connect, and a driver cannot always tell which. So a TimeoutError from the
 * connect is a ConnectionError naming the wait it made, on every route that connects, never the query sentence and
 * never the query timeout answer. The deadline is kept as its cause; every other failure passes as raised.
 */
export async function connectPhase(connect: () => Promise<void>): Promise<void> {
  const started = Date.now();
  try {
    await connect();
  } catch (error) {
    if (!(error instanceof TimeoutError)) throw error;
    const failure = new ConnectionError(
      `The connection got no answer after ${waitedSeconds(Date.now() - started)}: check the address, the port, the network path and that the server is running.`,
      error.provider,
    );
    failure.cause = error;
    throw failure;
  }
}

export function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof TimeoutError;
}

export function isAuthenticationError(error: unknown): error is AuthenticationError {
  return error instanceof AuthenticationError;
}

export function isQueryCancelledError(error: unknown): error is QueryCancelledError {
  return error instanceof QueryCancelledError;
}

// ============================================================================
// Error Mapping Utilities
// ============================================================================

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (!isDatabaseError(error)) {
    // Network errors are typically retryable
    if (error instanceof TypeError && error.message.includes("fetch")) {
      return true;
    }
    return false;
  }

  // Auth, privilege and config errors are not retryable
  if (
    error instanceof AuthenticationError ||
    error instanceof PermissionDeniedError ||
    error instanceof DatabaseConfigError
  ) {
    return false;
  }

  // Query syntax errors are not retryable
  if (error instanceof QueryError && error.position !== undefined) {
    return false;
  }

  // Connection and timeout errors may be retryable
  return true;
}

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
