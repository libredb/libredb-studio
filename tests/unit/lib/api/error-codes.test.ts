import { describe, test, expect } from 'bun:test';
import { ApiErrorCode } from '@/lib/api/error-codes';

describe('ApiErrorCode', () => {
  test('contains all 16 error codes', () => {
    expect(Object.keys(ApiErrorCode)).toHaveLength(16);
  });

  test('values match keys', () => {
    for (const [key, value] of Object.entries(ApiErrorCode) as [string, string][]) {
      expect(value).toBe(key);
    }
  });

  test('contains all database error codes', () => {
    expect(ApiErrorCode.QUERY_CANCELLED).toBe('QUERY_CANCELLED');
    expect(ApiErrorCode.QUERY_ERROR).toBe('QUERY_ERROR');
    expect(ApiErrorCode.CONFIG_ERROR).toBe('CONFIG_ERROR');
    expect(ApiErrorCode.AUTH_ERROR).toBe('AUTH_ERROR');
    expect(ApiErrorCode.TIMEOUT_ERROR).toBe('TIMEOUT_ERROR');
    expect(ApiErrorCode.CONNECTION_ERROR).toBe('CONNECTION_ERROR');
    expect(ApiErrorCode.POOL_EXHAUSTED).toBe('POOL_EXHAUSTED');
    expect(ApiErrorCode.DATABASE_ERROR).toBe('DATABASE_ERROR');
  });

  test('contains all LLM error codes', () => {
    expect(ApiErrorCode.LLM_SAFETY).toBe('LLM_SAFETY');
    expect(ApiErrorCode.LLM_AUTH).toBe('LLM_AUTH');
    expect(ApiErrorCode.LLM_RATE_LIMIT).toBe('LLM_RATE_LIMIT');
    expect(ApiErrorCode.LLM_CONFIG).toBe('LLM_CONFIG');
    expect(ApiErrorCode.LLM_STREAM).toBe('LLM_STREAM');
    expect(ApiErrorCode.LLM_ERROR).toBe('LLM_ERROR');
  });

  test('contains generic error codes', () => {
    expect(ApiErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    expect(ApiErrorCode.NETWORK_ERROR).toBe('NETWORK_ERROR');
  });
});
