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
 * class the rest of `mapDatabaseError` gives it. A refused privilege in class `42` (`42501`,
 * `42502`) never reaches it: the access refusals are decided first (`accessRefusalOf`).
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
  // An object that already exists. A permission the principal lacks is an access refusal
  // (`MSSQL_ACCESS_REFUSALS`), decided before this list is read.
  2714,
]);

/**
 * Oracle error numbers for a statement the server parsed or ran and refused (#1427): unique
 * constraint (1), the `ORA-009xx` parse and name-resolution range, NOT NULL (1400, 1407),
 * invalid number (1722), a value larger than its column (1438, 12899), date format errors
 * (1830 to 1861), check and referential constraints (2290 to 2292) and a PL/SQL compilation
 * error (6550). Insufficient privileges (1031) is an access refusal (`ORACLE_ACCESS_REFUSALS`).
 */
function isOracleStatementError(errorNum: number): boolean {
  return (
    errorNum === 1 ||
    (errorNum >= 900 && errorNum <= 999) ||
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
 * What a server's refusal of the caller is: `privilege`, a privilege the credential lacks, answered 403, or
 * `credential`, the credential itself refused, answered 401.
 */
type AccessRefusal = "privilege" | "credential";

/**
 * SQLSTATEs of a refused privilege: `42501` insufficient_privilege (PostgreSQL's Appendix A, also Db2's SQL0551N) and
 * `42502` (Db2's SQL0552N). Class `28`, invalid authorization specification, is a refused credential: PostgreSQL's
 * `28000` and `28P01`, and the `28000` MySQL gives its 1045 and 1698.
 */
const PRIVILEGE_SQLSTATES = new Set(["42501", "42502"]);
const CREDENTIAL_SQLSTATE_CLASS = "28";

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

/**
 * SQL Server error numbers of a refused privilege, from its Database Engine errors: 229 on an object, 230 on a column,
 * 262 in a database, 297 for an action, 300 on a server-level object, 916 a database the login may not enter. tedious
 * raises a refused login as `ELOGIN` without the server's 18456, so the words decide that one.
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
 * Oracle error numbers of an access refusal, from Oracle's error help: ORA-01031 insufficient privileges and ORA-01045
 * a user without CREATE SESSION; ORA-01017 an invalid credential, ORA-01005 a null password, ORA-28000 a locked
 * account and ORA-28001 an expired one.
 */
const ORACLE_ACCESS_REFUSALS: ReadonlyMap<number, AccessRefusal> = new Map([
  [1031, "privilege"],
  [1045, "privilege"],
  [1017, "credential"],
  [1005, "credential"],
  [28000, "credential"],
  [28001, "credential"],
]);

/**
 * Db2 SQLCODEs of an access refusal whose SQLSTATE is a connection class: SQL1060N, a user without the CONNECT
 * privilege (`08004`), and SQL30082N, security processing failed (`08001`).
 */
const DB2_ACCESS_REFUSALS: ReadonlyMap<number, AccessRefusal> = new Map([
  [-1060, "privilege"],
  [-30082, "credential"],
]);

/** MongoDB server codes of an access refusal, from its error codes: 13 `Unauthorized`, 18 `AuthenticationFailed`. */
const MONGODB_ACCESS_REFUSALS: ReadonlyMap<number, AccessRefusal> = new Map([
  [13, "privilege"],
  [18, "credential"],
]);

/** The refusal `code` names in `table`, when it is a number the table holds. */
function refusalIn(table: ReadonlyMap<number, AccessRefusal>, code: unknown): AccessRefusal | undefined {
  return typeof code === "number" ? table.get(code) : undefined;
}

/**
 * Whether the driver's own code fields say the server refused the caller, and how: a refusal, `null` when the code
 * names neither, and `undefined` when the error carries no code this module reads. Only the last is read by its
 * words, so a column called `password` is the statement's fault and never a refused credential.
 *
 * The fields are the ones `isStatementFault` reads, plus `db2-node`'s `sqlcode` and the MongoDB driver's numeric
 * `code` beside its `codeName`. mysql2's `errno` counts only beside the `sqlState` every server error carries, which
 * `bun:sqlite`'s `errno` and a system error's do not.
 */
function accessRefusalOf(error: Error): AccessRefusal | null | undefined {
  const fields = error as Error & {
    code?: unknown;
    codeName?: unknown;
    sqlState?: unknown;
    errno?: unknown;
    number?: unknown;
    errorNum?: unknown;
    sqlcode?: unknown;
    errcode?: unknown;
  };
  const sqlstate = driverSqlstate(error);
  if (sqlstate !== undefined && PRIVILEGE_SQLSTATES.has(sqlstate)) return "privilege";
  if (sqlstate?.startsWith(CREDENTIAL_SQLSTATE_CLASS)) return "credential";
  const mysqlErrno = typeof fields.sqlState === "string" ? fields.errno : undefined;
  const mongoCode = typeof fields.codeName === "string" ? fields.code : undefined;
  const refusal =
    refusalIn(MYSQL_ACCESS_REFUSALS, mysqlErrno) ??
    refusalIn(MSSQL_ACCESS_REFUSALS, fields.number) ??
    refusalIn(ORACLE_ACCESS_REFUSALS, fields.errorNum) ??
    refusalIn(DB2_ACCESS_REFUSALS, fields.sqlcode) ??
    refusalIn(MONGODB_ACCESS_REFUSALS, mongoCode);
  if (refusal !== undefined) return refusal;
  const carriesCode =
    sqlstate !== undefined ||
    [mysqlErrno, mongoCode, fields.number, fields.errorNum, fields.sqlcode].some((code) => typeof code === "number") ||
    (typeof fields.code === "string" && fields.code.startsWith("SQLITE_")) ||
    (fields.code === "ERR_SQLITE_ERROR" && typeof fields.errcode === "number");
  return carriesCode ? null : undefined;
}

/** The words of a refused credential, read only in an error that carries no code. */
const CREDENTIAL_WORDS = ["password", "authentication", "access denied", "login failed", "ora-01017"];

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

  // Connection errors
  if (
    message.includes("econnrefused") ||
    message.includes("connection refused") ||
    message.includes("connect etimedout") ||
    message.includes("getaddrinfo")
  ) {
    return new ConnectionError(`Failed to connect to ${provider} database: ${error.message}`, provider);
  }

  // Oracle Thin-mode refusals. This runs BEFORE the access refusals on
  // purpose: NJS-116 carries no server code and its own text is "password
  // verifier type 0x... is not supported by node-oracledb in Thin mode", so the
  // `password` match below would otherwise turn a configuration problem into
  // "wrong credentials" and send the operator to reset something that is not broken.
  const thinModeRefusal = describeOracleThinModeRefusal(message);
  if (thinModeRefusal) {
    return new DatabaseConfigError(`${thinModeRefusal}: ${error.message}. ${ORACLE_THICK_MODE_REMEDY}`, provider);
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

  // Oracle errors. ORA-01017 is an access refusal, decided above with the others.
  if (message.includes("ora-12541") || message.includes("ora-12154") || message.includes("tns:")) {
    return new ConnectionError(`Failed to connect to Oracle: ${error.message}`, provider);
  }
  if (message.includes("ora-00942")) {
    return new QueryError(`Table or view does not exist: ${error.message}`, provider, query);
  }
  // NJS-138 and its siblings are handled above, before the access refusals -
  // see describeOracleThinModeRefusal().

  // MSSQL errors. A refused login is an access refusal, decided above with the others.
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
