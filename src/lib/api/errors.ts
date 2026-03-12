/**
 * API Error Response Standardization
 * Centralized error-to-HTTP mapping for all API routes
 */

import { NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { ApiErrorCode } from './error-codes';
import {
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  AuthenticationError,
  PoolExhaustedError,
  QueryError,
  QueryCancelledError,
  TimeoutError,
} from '@/lib/db/errors';
import {
  LLMError,
  LLMAuthError,
  LLMConfigError,
  LLMRateLimitError,
  LLMSafetyError,
  LLMStreamError,
} from '@/lib/llm/types';

// ============================================================================
// Types
// ============================================================================

export type { ApiErrorCode } from './error-codes';

export interface ApiErrorResponse {
  error: string;
  code?: ApiErrorCode;
  statusCode: number;
  retryable?: boolean;
  details?: unknown;
}

// ============================================================================
// Error → HTTP Mapping
// ============================================================================

export function createErrorResponse(
  error: unknown,
  context?: { route?: string }
): NextResponse<ApiErrorResponse> {
  const route = context?.route;

  // --- Query Cancelled ---
  if (error instanceof QueryCancelledError) {
    logger.info('Query cancelled', { route, provider: error.provider });
    return NextResponse.json(
      {
        error: error.message,
        code: ApiErrorCode.QUERY_CANCELLED,
        statusCode: 499,
      },
      { status: 499 }
    );
  }

  // --- DB: QueryError (syntax / execution) ---
  if (error instanceof QueryError) {
    logger.warn('Query error', { route, provider: error.provider });
    return NextResponse.json(
      {
        error: error.message,
        code: ApiErrorCode.QUERY_ERROR,
        statusCode: 400,
        details: error.position !== undefined || error.detail
          ? { position: error.position, detail: error.detail }
          : undefined,
      },
      { status: 400 }
    );
  }

  // --- DB: DatabaseConfigError ---
  if (error instanceof DatabaseConfigError) {
    logger.warn('Database config error', { route, provider: error.provider });
    return NextResponse.json(
      { error: error.message, code: ApiErrorCode.CONFIG_ERROR, statusCode: 400 },
      { status: 400 }
    );
  }

  // --- DB: AuthenticationError ---
  if (error instanceof AuthenticationError) {
    logger.warn('Database auth error', { route, provider: error.provider });
    return NextResponse.json(
      { error: error.message, code: ApiErrorCode.AUTH_ERROR, statusCode: 401 },
      { status: 401 }
    );
  }

  // --- DB: TimeoutError ---
  if (error instanceof TimeoutError) {
    logger.warn('Query timeout', { route, provider: error.provider, duration: error.timeout });
    return NextResponse.json(
      {
        error: 'Query timed out. Please try a simpler query or increase timeout.',
        code: ApiErrorCode.TIMEOUT_ERROR,
        statusCode: 408,
        retryable: true,
      },
      { status: 408 }
    );
  }

  // --- DB: ConnectionError ---
  if (error instanceof ConnectionError) {
    logger.error('Connection error', error, { route, provider: error.provider });
    return NextResponse.json(
      {
        error: error.message,
        code: ApiErrorCode.CONNECTION_ERROR,
        statusCode: 503,
        retryable: true,
      },
      { status: 503 }
    );
  }

  // --- DB: PoolExhaustedError ---
  if (error instanceof PoolExhaustedError) {
    logger.error('Pool exhausted', error, { route, provider: error.provider });
    return NextResponse.json(
      {
        error: error.message,
        code: ApiErrorCode.POOL_EXHAUSTED,
        statusCode: 503,
        retryable: true,
      },
      { status: 503 }
    );
  }

  // --- DB: generic DatabaseError (base class catch-all) ---
  if (error instanceof DatabaseError) {
    logger.error('Database error', error, { route, provider: error.provider });
    return NextResponse.json(
      {
        error: error.message,
        code: (error.code as ApiErrorCode) ?? ApiErrorCode.DATABASE_ERROR,
        statusCode: 500,
      },
      { status: 500 }
    );
  }

  // --- LLM: Safety ---
  if (error instanceof LLMSafetyError) {
    logger.warn('LLM safety filter triggered', { route, provider: error.provider });
    return NextResponse.json(
      { error: 'The prompt was blocked by safety filters.', code: ApiErrorCode.LLM_SAFETY, statusCode: 400 },
      { status: 400 }
    );
  }

  // --- LLM: Auth ---
  if (error instanceof LLMAuthError) {
    logger.warn('LLM auth error', { route, provider: error.provider });
    return NextResponse.json(
      { error: 'Invalid API key. Please check your configuration.', code: ApiErrorCode.LLM_AUTH, statusCode: 401 },
      { status: 401 }
    );
  }

  // --- LLM: Rate Limit ---
  if (error instanceof LLMRateLimitError) {
    logger.warn('LLM rate limit', { route, provider: error.provider });
    return NextResponse.json(
      {
        error: 'AI usage limit reached. Please try again later or check your billing status.',
        code: ApiErrorCode.LLM_RATE_LIMIT,
        statusCode: 429,
        retryable: true,
      },
      { status: 429 }
    );
  }

  // --- LLM: Config ---
  if (error instanceof LLMConfigError) {
    logger.warn('LLM config error', { route, provider: error.provider });
    return NextResponse.json(
      { error: error.message, code: ApiErrorCode.LLM_CONFIG, statusCode: 503 },
      { status: 503 }
    );
  }

  // --- LLM: Stream ---
  if (error instanceof LLMStreamError) {
    logger.error('LLM stream error', error, { route, provider: error.provider });
    return NextResponse.json(
      { error: error.message, code: ApiErrorCode.LLM_STREAM, statusCode: 502, retryable: true },
      { status: 502 }
    );
  }

  // --- LLM: generic LLMError (base class catch-all) ---
  if (error instanceof LLMError) {
    const status = error.statusCode ?? 500;
    logger.error('LLM error', error, { route, provider: error.provider });
    return NextResponse.json(
      { error: error.message, code: ApiErrorCode.LLM_ERROR, statusCode: status },
      { status }
    );
  }

  // --- Generic Error ---
  const message = error instanceof Error ? error.message : 'Internal server error';
  logger.error('Unhandled error', error, { route });
  return NextResponse.json(
    { error: message, code: ApiErrorCode.INTERNAL_ERROR, statusCode: 500 },
    { status: 500 }
  );
}
