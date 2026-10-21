/**
 * The error body for the database error classes, free of Next.js and of the logger, so the API
 * routes (through `createErrorResponse`) and any other channel answer every database error class
 * from one implementation. It returns the body and a description of the log line the caller
 * writes; it writes nothing itself.
 */

import { ApiErrorCode } from "./error-codes";
import {
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  AuthenticationError,
  PermissionDeniedError,
  PoolExhaustedError,
  QueryError,
  QueryCancelledError,
  TimeoutError,
} from "@/lib/db/errors";
import type { DatabaseType } from "@/lib/db/types";

export interface ApiErrorResponse {
  error: string;
  code?: ApiErrorCode;
  statusCode: number;
  retryable?: boolean;
  details?: unknown;
  /** On a 401 only: a statement the user can copy and run to fix the refusal, when the provider knows one. */
  fixStatement?: string;
}

/** The log line a caller writes for a database error: `error` lines also carry the error itself. */
export interface DatabaseErrorLog {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly context: { readonly provider?: DatabaseType; readonly duration?: number };
}

/** A database error's body, whose `statusCode` is the HTTP status, and the log line it calls for. */
export interface DatabaseErrorAnswer {
  readonly body: ApiErrorResponse;
  readonly log: DatabaseErrorLog;
}

export const TIMEOUT_SENTENCE = "Query timed out. Please try a simpler query or increase timeout.";

/** The answer for a database error, or `null` when `error` is not one and the caller goes on to its own branches. */
export function databaseErrorBody(error: unknown): DatabaseErrorAnswer | null {
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
  // on the database. `retryable` is a hint for the person; no client resends on it.
  if (error instanceof TimeoutError) {
    return {
      body: { error: TIMEOUT_SENTENCE, code: ApiErrorCode.TIMEOUT_ERROR, statusCode: 504, retryable: true },
      log: { level: "warn", message: "Query timeout", context: { provider: error.provider, duration: error.timeout } },
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
