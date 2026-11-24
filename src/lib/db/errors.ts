/**
 * Database Error Classes
 * Custom error types for database operations
 */

import type { ExecuteOutcome } from "@libredb/provider-sdk/errors";
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

  /**
   * `not-sent` when the statement this error answers never reached the database. Written in exactly seven places: the
   * constructor of `RefusedBeforeSendError`, so every refusal before send carries it; the constructor of
   * `TransactionLostError`, when the provider raising it says it found the held session ended before sending;
   * `connectPhase`, on what a provider's connect raised, the `ConnectionError` of an open a removal or a cache close overtook included (the
   * factory raises it inside the connect it runs there); `buildPhase`, which `buildProvider` in ./factory runs, on what building a provider
   * raised; `withheldProviderError` in ./operations/provider-text, which copies `not-sent` onto the error it answers
   * in place of one; and the provider host's accessor (src/lib/provider-host/access.ts), through `markNotSent`, on the
   * class it builds for a console call the host refused before making it; and `checkoutPhase`, which a provider's execute
   * runs around taking a connection or session from its pool or client before it sends, on what that checkout raised,
   * mapped. Absent otherwise, which `errorOutcome` in ./error-record reads as `unknown`, because the statement
   * may have run. An own field only when set, so every other error keeps the own keys it had. An instance a failed
   * build or connect raised is never raised by a later statement: the factory keeps no provider whose build or connect
   * failed.
   */
  declare outcome?: ExecuteOutcome;

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
 * Configuration error - missing or invalid configuration. `code` is `CONFIG_ERROR` unless a subclass names a more
 * specific one, as `UnknownProviderError` does.
 */
export class DatabaseConfigError extends DatabaseError {
  constructor(message: string, provider?: DatabaseType, code: ApiErrorCode = ApiErrorCode.CONFIG_ERROR) {
    super(message, provider, code);
    this.name = "DatabaseConfigError";
    Object.setPrototypeOf(this, DatabaseConfigError.prototype);
  }
}

/**
 * Why a connection's `type` is not a type id, as `typeIdRefusal` in `./type-id` answers it: `absent` when the value is
 * missing, `null` or empty, `malformed` when it is present and not a string, whose value is never repeated, `unknown`
 * when it is a string that names no provider, which `typeId` then carries verbatim. `sentence` is the user-facing
 * refusal, the same on every surface. Declared here as a type so this module gains no runtime import.
 */
export type TypeIdRefusal =
  | { readonly reason: "absent"; readonly sentence: string }
  | { readonly reason: "malformed"; readonly sentence: string }
  | { readonly reason: "unknown"; readonly typeId: string; readonly sentence: string };

/**
 * A connection whose `type` is absent, not text, or names no provider this Studio has (FND-1). Raised before any provider is
 * built, any SSH tunnel opened or any per-engine table read, and answered 400 `PROVIDER_UNKNOWN` with the refusal's
 * sentence. A `DatabaseConfigError`, so every existing classification of a configuration error still holds; its
 * `provider` is undefined because the value is not a `DatabaseType`.
 */
export class UnknownProviderError extends DatabaseConfigError {
  readonly reason: TypeIdRefusal["reason"];
  /** The refused value, verbatim; only for an `unknown` type. */
  readonly typeId?: string;

  constructor(refusal: TypeIdRefusal) {
    super(refusal.sentence, undefined, ApiErrorCode.PROVIDER_UNKNOWN);
    this.name = "UnknownProviderError";
    this.reason = refusal.reason;
    if (refusal.reason === "unknown") this.typeId = refusal.typeId;
    Object.setPrototypeOf(this, UnknownProviderError.prototype);
  }
}

/** A facet of an engine's `ENGINE_FACETS` row that a request can name a member of; only maintenance is refused today. */
export type DeclaredFacet = "maintenance";

/**
 * A request names a member of a facet the connection's engine does not offer: before any provider is built, an
 * operation its `ENGINE_FACETS` row does not list, or, after connect, one the connected server does not accept.
 * Answered 400 `FACET_NOT_OFFERED` with its sentence, which names the member and the engine. A `DatabaseError` and not
 * a `DatabaseConfigError`: no setting of the connection is wrong, so a configuration error's remedy does not apply.
 */
export class FacetNotOfferedError extends DatabaseError {
  constructor(
    message: string,
    provider: DatabaseType,
    readonly facet: DeclaredFacet,
    readonly operation: string,
  ) {
    super(message, provider, ApiErrorCode.FACET_NOT_OFFERED);
    this.name = "FacetNotOfferedError";
    Object.setPrototypeOf(this, FacetNotOfferedError.prototype);
  }
}

// ============================================================================
// Connection Errors
// ============================================================================

/**
 * Connection error - failed to connect to database. `code` is `CONNECTION_ERROR` unless a subclass names a more
 * specific one, as `TransactionLostError` does.
 */
export class ConnectionError extends DatabaseError {
  constructor(
    message: string,
    provider?: DatabaseType,
    public readonly host?: string,
    public readonly port?: number,
    code: ApiErrorCode = ApiErrorCode.CONNECTION_ERROR,
  ) {
    super(message, provider, code);
    this.name = "ConnectionError";
    Object.setPrototypeOf(this, ConnectionError.prototype);
  }
}

/**
 * A call on a held transaction whose database session has ended since the transaction began. The server ended the
 * transaction with its session, so the provider holds none from then on and its next call answers
 * `NO_ACTIVE_TRANSACTION`. A `ConnectionError`, because the connection and not the statement failed, with the code
 * `TRANSACTION_LOST`, which the editor reads as the end of its transaction.
 *
 * `beforeSend: true` is the provider saying it found the session ended before it sent anything of the call, so the
 * error answers `outcome` `not-sent` (docs/providers/CONTRACT.md, E-5). Without it the outcome stays `unknown`, since
 * a provider may raise this class for a session that ended while the call ran.
 */
export class TransactionLostError extends ConnectionError {
  constructor(
    message: string,
    provider?: DatabaseType,
    host?: string,
    port?: number,
    options: { readonly beforeSend?: true } = {},
  ) {
    super(message, provider, host, port, ApiErrorCode.TRANSACTION_LOST);
    this.name = "TransactionLostError";
    if (options.beforeSend === true) this.outcome = "not-sent";
    Object.setPrototypeOf(this, TransactionLostError.prototype);
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
 * MCP `run_read_query` answers exactly this refusal as `mcp_offset_unsupported`, in the provider's own sentence behind a
 * notice naming the provider, and every other failure of `prepareQuery()` as the engine's.
 */
export class OffsetUnsupportedError extends QueryError {
  constructor(message: string, provider?: DatabaseType, query?: string) {
    super(message, provider, query);
    this.name = "OffsetUnsupportedError";
    Object.setPrototypeOf(this, OffsetUnsupportedError.prototype);
  }
}

/**
 * A statement this repository refused before sending it, so the database never saw it: a provider's own fence on what
 * the read-only profile may run, or a charge the run's read allowance cannot pay. A QueryError, so every caller that
 * settles a statement failure still settles this one, and a statement that avoids what the sentence names is the
 * repair; its own class, so the agent and MCP say the statement was refused before it was sent rather than presenting
 * the sentence as the database's error: a provider's sentence as its own text, fenced or behind a notice naming the
 * provider, and the read allowance's (`ReadAllowanceExceededError`, which only core constructs) in Studio's words.
 */
export class RefusedBeforeSendError extends QueryError {
  constructor(message: string, provider?: DatabaseType, query?: string) {
    super(message, provider, query);
    this.name = "RefusedBeforeSendError";
    this.outcome = "not-sent";
    Object.setPrototypeOf(this, RefusedBeforeSendError.prototype);
  }
}

/**
 * A read refused because it would spend more billed reads than its run has left (`RunReadAllowance` in
 * `read-allowance.ts`). Refused before the request is sent: a smaller read that fits what is left is the repair.
 */
export class ReadAllowanceExceededError extends RefusedBeforeSendError {
  constructor(message: string, provider?: DatabaseType) {
    super(message, provider);
    this.name = "ReadAllowanceExceededError";
    Object.setPrototypeOf(this, ReadAllowanceExceededError.prototype);
  }
}

/**
 * A provider's refusal of a read whose answer held more rows than the row field of the `ReadOnlyStatementBudget` it
 * was handed, raised after the read began, in `rowBudgetSentence`'s words. Its own class, so its error record answers
 * kind `row-budget-refusal` and a reader can tell it from any other statement failure without reading the sentence.
 * A `QueryError`, so the route answers 400 `QUERY_ERROR` and every caller that settles a statement failure settles it;
 * its `name` stays `QueryError`. Providers construct it; core raises its subclass `StudioRowBudgetRefusal`, and a
 * refusal raised before anything was sent stays a `RefusedBeforeSendError`.
 */
export class RowBudgetRefusal extends QueryError {
  constructor(message: string, provider?: DatabaseType, query?: string) {
    super(message, provider, query);
    this.name = "QueryError";
    Object.setPrototypeOf(this, RowBudgetRefusal.prototype);
  }
}

/**
 * A provider's refusal of a read whose answer held more bytes than the byte field of its `ReadOnlyStatementBudget`,
 * in `byteBudgetSentence`'s words or an engine's own words for the same budget (SQL Server's estimated plan). Kind
 * `byte-budget-refusal`; otherwise as `RowBudgetRefusal`, core raising its subclass `StudioByteBudgetRefusal`.
 */
export class ByteBudgetRefusal extends QueryError {
  constructor(message: string, provider?: DatabaseType, query?: string) {
    super(message, provider, query);
    this.name = "QueryError";
    Object.setPrototypeOf(this, ByteBudgetRefusal.prototype);
  }
}

/**
 * A provider's refusal of a read that outlasted the time field of its `ReadOnlyStatementBudget`, in words that open
 * with a time budget prefix or the statement deadline. Kind `time-budget-refusal`; otherwise as `RowBudgetRefusal`,
 * core raising its subclass `StudioTimeBudgetRefusal`.
 * A `QueryError` rather than a `TimeoutError`, so its answer's code and `retryable` stay what they were; a provider
 * that raises its time refusal as a `TimeoutError` keeps that class and kind `timeout`.
 */
export class TimeBudgetRefusal extends QueryError {
  constructor(message: string, provider?: DatabaseType, query?: string) {
    super(message, provider, query);
    this.name = "QueryError";
    Object.setPrototypeOf(this, TimeBudgetRefusal.prototype);
  }
}

/**
 * A provider's refusal of a value the server cut at the byte ceiling, which the byte budget cannot measure whole
 * (SQL Server's `MSSQL_CUT_VALUE_PREFIX`). Kind `cut-value-refusal`; otherwise as `RowBudgetRefusal`.
 */
export class CutValueRefusal extends QueryError {
  constructor(message: string, provider?: DatabaseType, query?: string) {
    super(message, provider, query);
    this.name = "QueryError";
    Object.setPrototypeOf(this, CutValueRefusal.prototype);
  }
}

/**
 * A provider's refusal of a serialised result, one value the row budget cannot bound (SQL Server's FOR JSON or FOR
 * XML, `MSSQL_SERIALISED_PREFIX`). Kind `serialised-result-refusal`; otherwise as `RowBudgetRefusal`.
 */
export class SerialisedResultRefusal extends QueryError {
  constructor(message: string, provider?: DatabaseType, query?: string) {
    super(message, provider, query);
    this.name = "QueryError";
    Object.setPrototypeOf(this, SerialisedResultRefusal.prototype);
  }
}

/**
 * Core's refusal of a provider's answer that held more rows than the read's row budget (`runReadOnlyStatement` and
 * `runReadOnlyReading`). A `RowBudgetRefusal`, so a reader of the row budget sees it whoever raised it; its own class,
 * so its error record answers kind `studio-row-budget-refusal` and the agent says it in Studio's voice where it fences
 * a provider's as database content. Its `name` stays `QueryError`, so a log line, an error body and a reader of the
 * name see no difference. No provider constructs it; tests/unit/db/operations/provider-text-census.test.ts holds that.
 */
export class StudioRowBudgetRefusal extends RowBudgetRefusal {
  constructor(message: string, provider?: DatabaseType, query?: string) {
    super(message, provider, query);
    this.name = "QueryError";
    Object.setPrototypeOf(this, StudioRowBudgetRefusal.prototype);
  }
}

/**
 * Core's refusal of a provider's answer that held more bytes than the read's byte budget. A `ByteBudgetRefusal` with
 * kind `studio-byte-budget-refusal`; otherwise as `StudioRowBudgetRefusal`.
 */
export class StudioByteBudgetRefusal extends ByteBudgetRefusal {
  constructor(message: string, provider?: DatabaseType, query?: string) {
    super(message, provider, query);
    this.name = "QueryError";
    Object.setPrototypeOf(this, StudioByteBudgetRefusal.prototype);
  }
}

/**
 * Core's refusal of a provider's call it stopped waiting for at the read's time budget. A `TimeBudgetRefusal` with
 * kind `studio-time-budget-refusal`; otherwise as `StudioRowBudgetRefusal`.
 */
export class StudioTimeBudgetRefusal extends TimeBudgetRefusal {
  constructor(message: string, provider?: DatabaseType, query?: string) {
    super(message, provider, query);
    this.name = "QueryError";
    Object.setPrototypeOf(this, StudioTimeBudgetRefusal.prototype);
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
 * A time limit Studio set and the work outlasted: the agent's statistics read, the host's deadline on a provider's
 * execute or cancel call (`refusalError` and `stopError` in src/lib/provider-host/access.ts), and an editor call's
 * allowance for its provider's open (`openStopError`, the same module). It exists only to mark Studio's sentence apart from a provider's timeout, so
 * the agent says this one in Studio's voice and an answer names its kind, `studio-timeout-refusal`. Its `name` stays
 * `TimeoutError`, so a log line, an error body and a reader of the name see no difference. No provider constructs it;
 * tests/unit/db/operations/provider-text-census.test.ts holds that.
 */
export class StudioTimeoutRefusal extends TimeoutError {
  constructor(message: string, provider?: DatabaseType, timeout?: number) {
    super(message, provider, timeout);
    this.name = "TimeoutError";
    Object.setPrototypeOf(this, StudioTimeoutRefusal.prototype);
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
  /**
   * The engine is not on Studio's review record of the engines agent and MCP statements run on (`AGENT_EXECUTION_ENGINES`
   * in src/lib/db/compatibility.ts), so no statement profile is granted and no statement or budgeted read is made on it,
   * even when its provider implements `queryReadOnly`.
   *
   * Its own code, apart from `PROFILE_UNSUPPORTED_BY_PROVIDER`, which says the provider has no such path and would be
   * false of one that has it. No operator grant widens the record in this version.
   */
  | "PROFILE_ENGINE_NOT_REVIEWED"
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
  | "AGENT_CREDENTIAL_WITH_CONNECTION_STRING"
  /**
   * A secret reference on the connection's seed entry, a `${vault:...}` one, could not be read, so nothing was opened.
   * Raised by MCP's acquisition, which resolves a seed's references as the editor and agent routes do, and its own
   * code so both MCP tools answer it in Studio's words rather than as an engine's error.
   */
  | "CONNECTION_SECRET_UNRESOLVABLE"
  /**
   * The engine is one MCP reads only under an agent credential of the seed's own (`MCP_AGENT_CREDENTIAL_REQUIRED` in
   * src/lib/db/compatibility.ts), and the connection carries none, so it is not read under its own login. Raised by
   * MCP's acquisition, and its own code so both MCP tools answer it in Studio's words.
   */
  | "AGENT_CREDENTIAL_REQUIRED"
  /**
   * The engine is one agent mode and MCP read only beneath read roots the seed declares (`READ_ROOTS_REQUIRED` in
   * src/lib/db/compatibility.ts), and the connection declares none, so nothing is read. Raised by the provider when a
   * statement-sending agent profile opens, and by MCP's acquisition, its own code so both answer it in Studio's words.
   */
  | "READ_ROOTS_REQUIRED";

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
  /** As `DatabaseError.outcome`: `not-sent` when `connectPhase` or `buildPhase` saw a connect or a build raise it. */
  declare outcome?: ExecuteOutcome;

  constructor(
    message: string,
    public readonly reasonCode: ExecutionProfileDenyCode,
  ) {
    super(message);
    this.name = "ExecutionProfileError";
    Object.setPrototypeOf(this, ExecutionProfileError.prototype);
  }
}

/**
 * An execution profile refusal Studio's own code wrote: the factory's acquisition checks, MCP's open, the statement
 * review and the core read path. It exists only to mark Studio's sentence apart from a provider's, which raises the
 * parent class, so the agent and MCP say this one in Studio's voice and fence a provider's as the provider's text.
 * Its `name` stays `ExecutionProfileError`, so a log line and a reader of the name see no difference. No provider
 * constructs it; tests/unit/db/operations/provider-text-census.test.ts holds that.
 */
export class StudioProfileRefusal extends ExecutionProfileError {
  constructor(message: string, reasonCode: ExecutionProfileDenyCode) {
    super(message, reasonCode);
    this.name = "ExecutionProfileError";
    Object.setPrototypeOf(this, StudioProfileRefusal.prototype);
  }
}

/**
 * What core answers in place of a provider's error whose text held a credential of the calling connection, when the
 * error leaves core for a renderer that does not hold the connection (an error response, a route's log line). Its
 * message is the withheld sentence and it carries none of the original's text or stack; the original is never
 * changed, because providers throw shared error instances. Constructed only by `withholdProviderError`
 * (src/lib/db/operations/provider-text.ts).
 */
export class ProviderTextWithheldError extends DatabaseError {
  constructor(message: string, provider: DatabaseType) {
    super(message, provider);
    this.name = "ProviderTextWithheldError";
    Object.setPrototypeOf(this, ProviderTextWithheldError.prototype);
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
 * Whether `error` is a budget refusal raised after the read began, a provider's or Studio's: an instance of one of the
 * five budget classes, Studio's three subclasses included. A provider's categorizer passes one through as it is, so it
 * keeps its class and its error kind. A refusal before send and a timeout are not budget refusals here: each already
 * keeps its own class.
 */
export function isBudgetRefusal(
  error: unknown,
): error is RowBudgetRefusal | ByteBudgetRefusal | TimeBudgetRefusal | CutValueRefusal | SerialisedResultRefusal {
  return (
    error instanceof RowBudgetRefusal ||
    error instanceof ByteBudgetRefusal ||
    error instanceof TimeBudgetRefusal ||
    error instanceof CutValueRefusal ||
    error instanceof SerialisedResultRefusal
  );
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
 *
 * Nothing the connect raised reached the database as a statement, so the error it rejects with answers `outcome`
 * `not-sent`: the ConnectionError a deadline becomes, and every database error or execution profile refusal, marked on
 * the instance as raised. A value of any other class passes unmarked and answers `unknown`.
 */
export async function connectPhase(connect: () => Promise<void>): Promise<void> {
  const started = Date.now();
  try {
    await connect();
  } catch (error) {
    if (!(error instanceof TimeoutError)) {
      markNotSent(error);
      throw error;
    }
    const failure = new ConnectionError(
      `The connection got no answer after ${waitedSeconds(Date.now() - started)}: check the address, the port, the network path and that the server is running.`,
      error.provider,
    );
    failure.cause = error;
    failure.outcome = "not-sent";
    throw failure;
  }
}

/**
 * Runs a provider's build: every check core makes on the connection and its context, then the provider's constructor.
 * A build sends no statement, so whatever it rejects with answers `outcome` `not-sent`, for the reason `connectPhase`
 * gives for a connect: a database error or an execution profile refusal is marked on the instance as raised, and a
 * value of any other class passes unmarked and answers `unknown`. It resolves to what the build answers.
 */
export async function buildPhase<T>(build: () => Promise<T>): Promise<T> {
  try {
    return await build();
  } catch (error) {
    markNotSent(error);
    throw error;
  }
}

/**
 * Runs the step of a provider's execute that takes a connection or session from its pool or client before anything
 * of the statement is sent (docs/providers/CONTRACT.md, E-5). A failure of that step provably precedes the send, so
 * the error it rejects with answers `outcome` `not-sent`: `map` (the provider's own `mapDatabaseError`) turns the
 * raised value into the class it answers, and a database error it answers is marked on the instance as mapped. A
 * deadline the checkout met is no statement timeout, for the reason `connectPhase` gives for a connect: a mapped
 * TimeoutError becomes a ConnectionError naming the wait, the TimeoutError kept as its cause and left unmarked. A value
 * `map` answers outside the database classes passes unmarked and answers `unknown`, and a throw from `map` itself
 * propagates as thrown. It resolves to what the checkout answers, and every failure after it stays the provider's own.
 */
export async function checkoutPhase<T>(checkout: () => Promise<T>, map: (error: unknown) => unknown): Promise<T> {
  const started = Date.now();
  try {
    return await checkout();
  } catch (error) {
    const mapped = map(error);
    if (!(mapped instanceof TimeoutError)) {
      markNotSent(mapped);
      throw mapped;
    }
    const failure = new ConnectionError(
      `No connection of the pool came free or opened within ${waitedSeconds(Date.now() - started)}, so the statement was not sent: every connection may be in use, or the server may not be answering.`,
      mapped.provider,
    );
    failure.cause = mapped;
    failure.outcome = "not-sent";
    throw failure;
  }
}

/** Marks a database error or an execution profile refusal `not-sent` on the instance; any other value is left as is. */
export function markNotSent(error: unknown): void {
  if (error instanceof DatabaseError || error instanceof ExecutionProfileError) error.outcome = "not-sent";
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
