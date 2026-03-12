/**
 * API Error Codes
 * Single source of truth for all error codes used across server and client
 */

export const ApiErrorCode = {
  // Database errors
  QUERY_CANCELLED: 'QUERY_CANCELLED',
  QUERY_ERROR: 'QUERY_ERROR',
  CONFIG_ERROR: 'CONFIG_ERROR',
  AUTH_ERROR: 'AUTH_ERROR',
  TIMEOUT_ERROR: 'TIMEOUT_ERROR',
  CONNECTION_ERROR: 'CONNECTION_ERROR',
  POOL_EXHAUSTED: 'POOL_EXHAUSTED',
  DATABASE_ERROR: 'DATABASE_ERROR',

  // LLM errors
  LLM_SAFETY: 'LLM_SAFETY',
  LLM_AUTH: 'LLM_AUTH',
  LLM_RATE_LIMIT: 'LLM_RATE_LIMIT',
  LLM_CONFIG: 'LLM_CONFIG',
  LLM_STREAM: 'LLM_STREAM',
  LLM_ERROR: 'LLM_ERROR',

  // Generic
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];
