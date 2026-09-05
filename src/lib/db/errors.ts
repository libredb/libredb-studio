/**
 * Database Error Classes
 * Custom error types for database operations
 */

import type { DatabaseType } from "./types";
import { ApiErrorCode } from "@/lib/api/error-codes";

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
      query: this.query ? this.query.substring(0, 100) + "..." : undefined,
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
