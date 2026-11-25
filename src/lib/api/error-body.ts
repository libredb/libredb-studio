/**
 * The error body for the database error classes, free of Next.js and of the logger, so the API
 * routes (through `createErrorResponse`) and any other channel answer every database error class
 * from one implementation. It returns the body and a description of the log line the caller
 * writes; it writes nothing itself.
 */

import { ApiErrorCode } from "./error-codes";
import type { ErrorKind, ExecuteOutcome } from "@libredb/provider-sdk/errors";
import { errorKind, errorOutcome } from "@/lib/db/error-record";
import {
  DatabaseError,
  DatabaseConfigError,
  FacetNotOfferedError,
  PackageEngineUnsupportedError,
  ProviderUnavailableError,
  ConnectionError,
  AuthenticationError,
  PermissionDeniedError,
  PoolExhaustedError,
  QueryError,
  QueryCancelledError,
  StudioTimeoutRefusal,
  TimeoutError,
  TransactionLostError,
  UnknownProviderError,
  type TypeIdRefusal,
} from "@/lib/db/errors";
import { quoteTypeId } from "@/lib/db/type-id";
import type { DatabaseType } from "@/lib/db/types";

export interface ApiErrorResponse {
  error: string;
  code?: ApiErrorCode;
  statusCode: number;
  retryable?: boolean;
  details?: unknown;
  /** On a 401 only: a statement the user can copy and run to fix the refusal, when the provider knows one. */
  fixStatement?: string;
  /**
   * On every database error: the error's kind and whether the statement may have reached the database, as its error
   * record (src/lib/db/error-record.ts) says. Closed vocabularies, never the error's text. A body without them is not
   * a database error's.
   */
  kind?: ErrorKind;
  outcome?: ExecuteOutcome;
  /**
   * On a database error answered with the connection's scrub only: the SQLSTATE its error record carries, which it
   * carries only when the driver reported one and the error's text was not withheld.
   */
  sqlState?: string;
}

/** The log line a caller writes for a database error: `error` lines also carry the error itself. */
export interface DatabaseErrorLog {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly context: {
    readonly provider?: DatabaseType;
    readonly duration?: number;
    /** On a `PROVIDER_UNKNOWN` refusal only: whether the type was absent, not text, or named no provider. */
    readonly reason?: TypeIdRefusal["reason"];
    /**
     * On an `unknown` refusal, a `PROVIDER_UNAVAILABLE` and a `PACKAGE_ENGINE_UNSUPPORTED` answer: the type, quoted by
     * `quoteTypeId` so it stays one line in the log.
     */
    readonly type?: string;
    /** On a `PROVIDER_UNAVAILABLE` answer only: the codes the packages naming the engine were refused with. */
    readonly codes?: readonly string[];
  };
}

/** A database error's body, whose `statusCode` is the HTTP status, and the log line it calls for. */
export interface DatabaseErrorAnswer {
  readonly body: ApiErrorResponse;
  readonly log: DatabaseErrorLog;
}

export const TIMEOUT_SENTENCE = "Query timed out. Please try a simpler query or increase timeout.";

/**
 * The answer for a database error, with its error kind and outcome on the body, or `null` when `error` is not one and
 * the caller goes on to its own branches.
 */
export function databaseErrorBody(error: unknown): DatabaseErrorAnswer | null {
  const answer = classifiedAnswer(error);
  if (answer === null) return null;
  return { body: { ...answer.body, kind: errorKind(error), outcome: errorOutcome(error) }, log: answer.log };
}

/** The status, code, words and log line of each database error class, most derived first. */
function classifiedAnswer(error: unknown): DatabaseErrorAnswer | null {
  // --- Query Cancelled ---
  if (error instanceof QueryCancelledError) {
    return {
      body: { error: error.message, code: ApiErrorCode.QUERY_CANCELLED, statusCode: 499 },
      log: { level: "info", message: "Query cancelled", context: { provider: error.provider } },
    };
  }

  // --- DB: QueryError (syntax / execution) ---
  if (error instanceof QueryError) {
    return {
      body: {
        error: error.message,
        code: ApiErrorCode.QUERY_ERROR,
        statusCode: 400,
        details:
          error.position !== undefined || error.detail ? { position: error.position, detail: error.detail } : undefined,
      },
      log: { level: "warn", message: "Query error", context: { provider: error.provider } },
    };
  }

  // --- DB: UnknownProviderError ---
  // Before the DatabaseConfigError branch it subclasses: the connection's type names no provider, so there is none to
  // log against. The log names the reason and, quoted, the refused type, so an operator can tell the two apart.
  if (error instanceof UnknownProviderError) {
    return {
      body: { error: error.message, code: ApiErrorCode.PROVIDER_UNKNOWN, statusCode: 400 },
      log: {
        level: "warn",
        message: "Unknown provider",
        context:
          error.typeId === undefined
            ? { reason: error.reason }
            : { reason: error.reason, type: quoteTypeId(error.typeId) },
      },
    };
  }

  // --- DB: ProviderUnavailableError ---
  // Before the DatabaseConfigError branch it subclasses: the engine's package was refused at boot, so the remedy is
  // the operator's and the same request succeeds once the package is fixed. The log names the quoted type and the codes.
  if (error instanceof ProviderUnavailableError) {
    return {
      body: { error: error.message, code: ApiErrorCode.PROVIDER_UNAVAILABLE, statusCode: 503 },
      log: {
        level: "warn",
        message: "Provider unavailable",
        context: { type: quoteTypeId(error.typeId), codes: error.codes },
      },
    };
  }

  // --- DB: PackageEngineUnsupportedError ---
  // 501 before the generic branch it would otherwise reach as a 500: the server does not serve this request for an
  // engine of a provider package yet.
  if (error instanceof PackageEngineUnsupportedError) {
    return {
      body: { error: error.message, code: ApiErrorCode.PACKAGE_ENGINE_UNSUPPORTED, statusCode: 501 },
      log: { level: "info", message: "Package engine unsupported", context: { type: quoteTypeId(error.typeId) } },
    };
  }

  // --- DB: DatabaseConfigError ---
  if (error instanceof DatabaseConfigError) {
    return {
      body: { error: error.message, code: ApiErrorCode.CONFIG_ERROR, statusCode: 400 },
      log: { level: "warn", message: "Database config error", context: { provider: error.provider } },
    };
  }

  // --- DB: AuthenticationError ---
  if (error instanceof AuthenticationError) {
    return {
      body: {
        error: error.message,
        code: ApiErrorCode.AUTH_ERROR,
        statusCode: 401,
        ...(error.fixStatement === undefined ? {} : { fixStatement: error.fixStatement }),
      },
      log: { level: "warn", message: "Database auth error", context: { provider: error.provider } },
    };
  }

  // --- DB: PermissionDeniedError ---
  // The database accepted the credential and refused the statement for a privilege it lacks: 403, so no client reads
  // it as a refused credential or an ended session (the browser signs in again only for AUTH_REQUIRED).
  if (error instanceof PermissionDeniedError) {
    return {
      body: { error: error.message, code: ApiErrorCode.PERMISSION_DENIED, statusCode: 403 },
      log: { level: "warn", message: "Database permission denied", context: { provider: error.provider } },
    };
  }

  // --- DB: TimeoutError ---
  // 504: Chromium sends a POST answered Request Timeout on a reused connection again, so the statement ran again
  // on the database. `retryable` is a hint for the person; no client resends on it. A Studio timeout refusal answers
  // the sentence Studio wrote for it, which names what Studio waited for (an open, a statement, a page, a cancel) and
  // whether anything was sent; a provider's own timeout answers the shared sentence.
  if (error instanceof TimeoutError) {
    const sentence = error instanceof StudioTimeoutRefusal ? error.message : TIMEOUT_SENTENCE;
    return {
      body: { error: sentence, code: ApiErrorCode.TIMEOUT_ERROR, statusCode: 504, retryable: true },
      log: { level: "warn", message: "Query timeout", context: { provider: error.provider, duration: error.timeout } },
    };
  }

  // --- DB: TransactionLostError ---
  // Before the ConnectionError branch it subclasses: the held transaction is gone with its session, so the answer is
  // not `retryable`. Running the statement again cannot reach that transaction; a new one has to be begun.
  if (error instanceof TransactionLostError) {
    return {
      body: { error: error.message, code: ApiErrorCode.TRANSACTION_LOST, statusCode: 503 },
      log: { level: "warn", message: "Transaction lost", context: { provider: error.provider } },
    };
  }

  // --- DB: ConnectionError ---
  if (error instanceof ConnectionError) {
    return {
      body: { error: error.message, code: ApiErrorCode.CONNECTION_ERROR, statusCode: 503, retryable: true },
      log: { level: "error", message: "Connection error", context: { provider: error.provider } },
    };
  }

  // --- DB: PoolExhaustedError ---
  if (error instanceof PoolExhaustedError) {
    return {
      body: { error: error.message, code: ApiErrorCode.POOL_EXHAUSTED, statusCode: 503, retryable: true },
      log: { level: "error", message: "Pool exhausted", context: { provider: error.provider } },
    };
  }

  // --- DB: FacetNotOfferedError ---
  // 400 before the generic branch it would otherwise reach as a 500: the engine does not offer what the request names.
  if (error instanceof FacetNotOfferedError) {
    return {
      body: { error: error.message, code: ApiErrorCode.FACET_NOT_OFFERED, statusCode: 400 },
      log: { level: "warn", message: "Facet not offered", context: { provider: error.provider } },
    };
  }

  // --- DB: generic DatabaseError (base class catch-all) ---
  if (error instanceof DatabaseError) {
    return {
      body: { error: error.message, code: error.code ?? ApiErrorCode.DATABASE_ERROR, statusCode: 500 },
      log: { level: "error", message: "Database error", context: { provider: error.provider } },
    };
  }

  return null;
}

/** The answer for any error no other branch classifies: 500 `INTERNAL_ERROR` with its message. */
export function internalErrorBody(error: unknown): ApiErrorResponse {
  const message = error instanceof Error ? error.message : "Internal server error";
  return { error: message, code: ApiErrorCode.INTERNAL_ERROR, statusCode: 500 };
}

/**
 * The same body with its texts replaced by `message`, for an error whose text holds a credential of the connection:
 * `error` is `message`, `details` keeps only a numeric `position`, and `fixStatement` is left out, while the status,
 * `code`, `retryable`, `kind`, `outcome` and every other key stay the error's own. The caller decides whether the
 * text is withheld and passes the withheld error's message, so this module stays free of the scrub. The body given is
 * not changed.
 */
export function withWithheldText(body: ApiErrorResponse, message: string): ApiErrorResponse {
  const position = (body.details as { position?: unknown } | undefined)?.position;
  const answered: ApiErrorResponse = { ...body, error: message };
  delete answered.details;
  delete answered.fixStatement;
  if (typeof position === "number") answered.details = { position };
  return answered;
}
