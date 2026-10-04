/**
 * Database Error Classes
 * Custom error types for database operations
 */

import type { DatabaseType } from "./types";
import { ApiErrorCode } from "@/lib/api/error-codes";

const QUERY_PREVIEW_MAX_LENGTH = 100;

// ============================================================================
// Base Database Error
// ============================================================================

/**
 * Base error class for all database-related errors
 */
export class DatabaseError extends Error {
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
  constructor(message: string, provider?: DatabaseType) {
    super(message, provider, ApiErrorCode.AUTH_ERROR);
    this.name = "AuthenticationError";
    Object.setPrototypeOf(this, AuthenticationError.prototype);
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

  // Auth and config errors are not retryable
  if (error instanceof AuthenticationError || error instanceof DatabaseConfigError) {
    return false;
  }

  // Query syntax errors are not retryable
  if (error instanceof QueryError && error.position !== undefined) {
    return false;
  }

  // Connection and timeout errors may be retryable
  return true;
}

// ============================================================================
// Oracle Thick-mode diagnostics (#538)
// ============================================================================

/**
 * The one remedy every Thin-mode refusal shares, written once. Both the reason
 * strings below and the constructor's load failures point at the same place, and
 * two prose copies of one instruction drift.
 */
const ORACLE_THICK_MODE_REMEDY =
  "Thick mode is the remedy: set ORACLE_CLIENT_LIB_DIR to an installed Oracle Instant Client " +
  "directory (on Linux the directory must also be on the loader path). See " +
  "docs/providers/oracle.md section 4.4.";

/**
 * Why node-oracledb's Thin mode refused this connection, or `null` if the error
 * is not a Thin-mode refusal at all.
 *
 * These are the messages a DBA turns into "you must use Thick mode", and until
 * #538 only `NJS-138` was recognised. The rest fell through to the generic
 * retryable `ConnectionError`, which tells the operator to try again for a
 * condition that will never clear on its own - the exact defect #228 fixed for
 * `NJS-138`.
 *
 * `message` is expected already lower-cased (mapDatabaseError does that once).
 */
export function describeOracleThinModeRefusal(message: string): string | null {
  if (message.includes("njs-138")) {
    return "Oracle server version predates 12.1, which Thin mode does not support";
  }
  if (message.includes("njs-116")) {
    return (
      "the account's password verifier is 10G-only, and Thin mode can only use a 12C verifier. " +
      "A DBA can fix this without Thick mode by resetting the account's password, which writes " +
      "a 12C verifier (given a suitable SQLNET.ALLOWED_LOGON_VERSION_SERVER)"
    );
  }
  if (message.includes("njs-533")) {
    return (
      "the server requires Oracle Native Network Encryption or data integrity checksumming, " +
      "which Thin mode does not implement"
    );
  }
  if (message.includes("njs-529")) {
    // ERR_WALLET_TYPE_NOT_SUPPORTED in the driver's lib/errors.js. Its text says
    // nothing about Thin mode, so the generic substring below never catches it,
    // and it is the one refusal here with a way out that costs nothing: Thin
    // mode reads PEM, so converting the wallet is enough.
    return (
      "Thin mode reads only a PEM wallet, and this one is not PEM (typically an sso-only " +
      "cwallet.sso). Converting it to ewallet.pem avoids Thick mode entirely " +
      "(orapki wallet pkcs12_to_pem, or openssl against the PKCS#12); otherwise use Thick mode, " +
      "which reads the sso wallet as it stands"
    );
  }
  if (message.includes("njs-089")) {
    // Measured against node-oracledb 6.10.0's own source rather than assumed:
    // NJS-089 is raised for CLIENT-side features (heterogeneous pooling in
    // lib/thin/pool.js, some database object types in lib/thin/dbObject.js,
    // Advanced Queuing in aqArray.js and aqBase.js, a few protocol features in
    // withData.js). It is not the code for Kerberos, LDAP naming or a wallet.
    return "this uses a client-side feature Thin mode does not implement";
  }
  if (message.includes("not supported by node-oracledb in thin mode")) {
    return "the driver reports a feature Thin mode does not implement";
  }
  return null;
}

/**
 * What to tell the operator when `initOracleClient({ libDir })` throws.
 *
 * The old message said one thing for every failure - "verify the path points at
 * an installed Instant Client 'lib' directory" - and for the two failures that
 * actually happen that advice is wrong in both directions:
 *
 * - `NJS-045` is not about the path at all. It means this build has no
 *   node-oracledb Thick-mode addon to load, which is a defect of how the app was
 *   packaged, not of anything the operator configured. The operator can stare at
 *   a perfectly good Instant Client directory forever.
 * - `DPI-1047` means the addon loaded and then could not pull in the client
 *   libraries. On Linux that is almost never a wrong path: `libclntsh.so` has no
 *   RUNPATH, so its siblings (`libnnz*.so`, `libclntshcore.so`) are found only
 *   through the system library search path, and node-oracledb's own
 *   documentation says never to rely on `libDir` there.
 *
 * Exported so the mapping is testable without constructing a provider.
 */
export function describeOracleClientLoadFailure(libDir: string, detail: string): string {
  const lower = detail.toLowerCase();
  if (lower.includes("njs-045")) {
    return (
      `This build has no node-oracledb Thick mode binary for ${process.platform}-${process.arch}, ` +
      `so ORACLE_CLIENT_LIB_DIR=${libDir} could not be used: ${detail}. ` +
      "This is a packaging defect of the build, not a problem with the path - the driver's native " +
      "addon is missing or was resolved from a rewritten directory. Report it with the platform and " +
      "architecture above; see docs/providers/oracle.md section 4.4."
    );
  }
  if (lower.includes("dpi-1047")) {
    return (
      `The Oracle Client libraries in ORACLE_CLIENT_LIB_DIR=${libDir} could not be loaded: ${detail}. ` +
      "On Linux the directory must ALSO be on the system library search path - add it to a file under " +
      "/etc/ld.so.conf.d/ and run ldconfig, or set LD_LIBRARY_PATH before Node starts - because " +
      "libclntsh has no RUNPATH and cannot find its own siblings otherwise. On Debian 13 also check " +
      "that libaio.so.1 resolves (the distribution ships libaio.so.1t64 and the client asks for " +
      "libaio.so.1). See docs/providers/oracle.md section 4.4."
    );
  }
  return (
    `Failed to load the Oracle Instant Client from ORACLE_CLIENT_LIB_DIR=${libDir}: ${detail}. ` +
    "Verify the path points at an installed Oracle Instant Client directory " +
    "(Instant Client 19c is required to reach Oracle 11.2 servers); see " +
    "docs/providers/oracle.md section 4.4."
  );
}

/**
 * The SQLSTATE classes that name a fault of the statement itself (#1427): `0A` feature not
 * supported, `21` cardinality violation, `22` data exception, `23` integrity constraint
 * violation, `42` syntax error or access rule violation and `44` WITH CHECK OPTION violation.
 * Every other class is the connection's, the transaction's or the server's (`08` connection,
 * `40` rollback, `53` resources, `57` operator intervention, `XX` internal), and keeps the
 * class the rest of `mapDatabaseError` gives it.
 */
const STATEMENT_SQLSTATE = /^(0A|2[123]|4[24])[0-9A-Z]{3}$/;

/**
 * MySQL errors that carry SQLSTATE `42000` and are not the statement's fault: `1203`
 * `max_user_connections` and `1226` a per-account resource limit such as `max_questions`. The
 * account hit a limit; the same statement runs once it clears, so it keeps its 5xx class.
 */
export const MYSQL_ACCOUNT_LIMIT_ERRNOS = new Set([1203, 1226]);

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
  // An object that already exists, and a permission the principal lacks on an object.
  2714, 229, 230, 262,
]);

/**
 * Oracle error numbers for a statement the server parsed or ran and refused (#1427): unique
 * constraint (1), the `ORA-009xx` parse and name-resolution range, NOT NULL (1400, 1407),
 * insufficient privileges (1031), invalid number (1722), a value larger than its column (1438,
 * 12899), date format errors (1830 to 1861), check and referential constraints (2290 to 2292)
 * and a PL/SQL compilation error (6550).
 */
function isOracleStatementError(errorNum: number): boolean {
  return (
    errorNum === 1 ||
    (errorNum >= 900 && errorNum <= 999) ||
    errorNum === 1031 ||
    errorNum === 1400 ||
    errorNum === 1407 ||
    errorNum === 1438 ||
    errorNum === 1722 ||
    (errorNum >= 1830 && errorNum <= 1861) ||
    (errorNum >= 2290 && errorNum <= 2292) ||
    errorNum === 6550 ||
    errorNum === 12899
  );
}

/**
 * SQLite primary result codes for a statement the library refused (#1427): `SQLITE_ERROR` (1,
 * a syntax error or an unknown table or column), `SQLITE_CONSTRAINT` (19), `SQLITE_MISMATCH`
 * (20) and `SQLITE_RANGE` (25, a bind index out of range). An extended code carries its primary
 * code in its low byte, which is how `SQLITE_CONSTRAINT_UNIQUE` (2067) reads as 19.
 */
const SQLITE_STATEMENT_RESULT_CODES = new Set([1, 19, 20, 25]);

/**
 * Whether the driver's own code fields say the STATEMENT is at fault (#1427).
 *
 * Read from codes and never from the message, so a table named `pool_items` or `timeouts`
 * cannot decide the class (BACKLOG B4). Each driver publishes its own field, measured on the
 * installed drivers on 2026-10-04:
 *
 * - `pg` puts the SQLSTATE in `code` (`42601`), `mysql2` in `sqlState` (`42000`), `db2-node` in
 *   `sqlstate`. MySQL-wire relatives answer through `mysql2` too, so TiDB's `ER_PARSE_ERROR`
 *   reads `42000` like MySQL's.
 * - `mssql` puts the error number in `number` (`2812` for an unknown procedure).
 * - `oracledb` puts it in `errorNum` (`900` for `ORA-00900`).
 * - `bun:sqlite` names the result code in `code` (`SQLITE_CONSTRAINT_PRIMARYKEY`) and
 *   `node:sqlite` puts the extended code in `errcode` under `code: "ERR_SQLITE_ERROR"`.
 *
 * A code this function does not know answers false, and the caller's other branches decide.
 */
function isStatementFault(error: Error): boolean {
  const fields = error as Error & {
    code?: unknown;
    sqlState?: unknown;
    sqlstate?: unknown;
    number?: unknown;
    errorNum?: unknown;
    errcode?: unknown;
    errno?: unknown;
  };
  if (typeof fields.errno === "number" && MYSQL_ACCOUNT_LIMIT_ERRNOS.has(fields.errno)) return false;
  for (const state of [fields.code, fields.sqlState, fields.sqlstate]) {
    if (typeof state === "string" && STATEMENT_SQLSTATE.test(state)) return true;
  }
  if (typeof fields.number === "number" && MSSQL_STATEMENT_ERRORS.has(fields.number)) return true;
  if (typeof fields.errorNum === "number" && isOracleStatementError(fields.errorNum)) return true;
  if (typeof fields.code === "string" && fields.code.startsWith("SQLITE_")) {
    return /^SQLITE_(ERROR|CONSTRAINT|MISMATCH|RANGE)(_|$)/.test(fields.code);
  }
  if (fields.code === "ERR_SQLITE_ERROR" && typeof fields.errcode === "number") {
    return SQLITE_STATEMENT_RESULT_CODES.has(fields.errcode & 0xff);
  }
  return false;
}

/**
 * Map native database errors to our error types
 */
export function mapDatabaseError(error: unknown, provider: DatabaseType, query?: string): DatabaseError {
  if (isDatabaseError(error)) {
    return error;
  }

  if (!(error instanceof Error)) {
    return new DatabaseError(String(error), provider);
  }

  const message = error.message.toLowerCase();

  // Connection errors
  if (
    message.includes("econnrefused") ||
    message.includes("connection refused") ||
    message.includes("connect etimedout") ||
    message.includes("getaddrinfo")
  ) {
    return new ConnectionError(`Failed to connect to ${provider} database: ${error.message}`, provider);
  }

  // Oracle Thin-mode refusals. This runs BEFORE the authentication branch on
  // purpose: NJS-116's own text is "password verifier type 0x... is not
  // supported by node-oracledb in Thin mode", so the generic `password` match
  // below would otherwise turn a configuration problem into "wrong credentials"
  // and send the operator to reset something that is not broken.
  const thinModeRefusal = describeOracleThinModeRefusal(message);
  if (thinModeRefusal) {
    return new DatabaseConfigError(`${thinModeRefusal}: ${error.message}. ${ORACLE_THICK_MODE_REMEDY}`, provider);
  }

  // Authentication errors
  if (
    message.includes("password") ||
    message.includes("authentication") ||
    message.includes("access denied") ||
    message.includes("permission denied")
  ) {
    return new AuthenticationError(`Authentication failed: ${error.message}`, provider);
  }

  // The statement's own fault, read from the driver's code fields (#1427). Placed after the
  // connection and authentication branches so nothing they classify changes class, and before
  // every later substring branch, so a statement error whose text happens to hold "timeout" or
  // "pool" is not read as one. The engine's message is kept as it is, unprefixed, because it is
  // what the reader corrects the statement from.
  if (isStatementFault(error)) {
    return new QueryError(error.message, provider, query, (error as { position?: number }).position);
  }

  // PostgreSQL preemption vs. operator cancel (#1145). Both a `statement_timeout`
  // and a `lock_timeout` are reported as `canceling statement due to <statement|lock>
  // timeout`, sharing the `canceling statement` prefix an operator cancel
  // (`pg_cancel_backend`, `due to user request`) uses. Both are TIMEOUTS — a time
  // budget elapsed and the statement never ran to completion — so they map to
  // TimeoutError carrying the engine's own text, exactly as every other engine's
  // query timeout does. This MUST run before the cancellation branch below, which
  // would otherwise match `canceling statement` first and discard the wording that
  // tells a timeout apart from a cancel.
  if (message.includes("canceling statement due to statement timeout") || message.includes("due to lock timeout")) {
    return new TimeoutError(error.message, provider, undefined, query);
  }

  // Query cancellation (must check before timeout — 'canceling statement' is cancellation, not timeout)
  if (
    message.includes("canceling statement") ||
    message.includes("query execution was interrupted") ||
    message.includes("query was cancelled") ||
    message.includes("kill query")
  ) {
    return new QueryCancelledError("Query was cancelled", provider, query);
  }

  // Timeout errors
  if (message.includes("timeout") || message.includes("timed out")) {
    return new TimeoutError(`Query timeout: ${error.message}`, provider, undefined, query);
  }

  // Oracle errors
  if (message.includes("ora-01017") || message.includes("invalid username/password")) {
    return new AuthenticationError(`Authentication failed: ${error.message}`, provider);
  }
  if (message.includes("ora-12541") || message.includes("ora-12154") || message.includes("tns:")) {
    return new ConnectionError(`Failed to connect to Oracle: ${error.message}`, provider);
  }
  if (message.includes("ora-00942")) {
    return new QueryError(`Table or view does not exist: ${error.message}`, provider, query);
  }
  // NJS-138 and its siblings are handled above, before the authentication
  // branch - see describeOracleThinModeRefusal().

  // MSSQL errors
  if (message.includes("login failed")) {
    return new AuthenticationError(`Authentication failed: ${error.message}`, provider);
  }
  if (message.includes("cannot open database")) {
    return new ConnectionError(`Database not found: ${error.message}`, provider);
  }

  // Query errors (PostgreSQL specific)
  if (message.includes("syntax error") || message.includes("column") || message.includes("relation")) {
    return new QueryError(error.message, provider, query, (error as { position?: number }).position);
  }

  // Pool errors
  if (message.includes("pool") || message.includes("too many connections")) {
    return new PoolExhaustedError(`Connection pool error: ${error.message}`, provider);
  }

  // Generic database error
  return new DatabaseError(error.message, provider, undefined, query);
}
