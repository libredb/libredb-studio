import '../setup';
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Mock } from 'bun:test';
import { createErrorResponse } from '@/lib/api/errors';
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

describe('createErrorResponse', () => {
  // Suppress logger output during tests
  let debugSpy: Mock<typeof console.debug>;
  let infoSpy: Mock<typeof console.info>;
  let warnSpy: Mock<typeof console.warn>;
  let errorSpy: Mock<typeof console.error>;

  beforeEach(() => {
    debugSpy = spyOn(console, 'debug').mockImplementation(() => {});
    infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    debugSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // ─── Database Errors ──────────────────────────────────────────────────────

  test('QueryError returns 400 with code QUERY_ERROR', async () => {
    const err = new QueryError('syntax error at position 5', 'postgres', 'SELECT *');
    const res = createErrorResponse(err);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('QUERY_ERROR');
    expect(body.statusCode).toBe(400);
    expect(body.error).toContain('syntax error');
  });

  test('DatabaseConfigError returns 400 with code CONFIG_ERROR', async () => {
    const err = new DatabaseConfigError('missing host', 'mysql');
    const res = createErrorResponse(err);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('CONFIG_ERROR');
    expect(body.statusCode).toBe(400);
  });

  test('AuthenticationError returns 401 with code AUTH_ERROR', async () => {
    const err = new AuthenticationError('bad password', 'postgres');
    const res = createErrorResponse(err);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('AUTH_ERROR');
    expect(body.statusCode).toBe(401);
  });

  test('TimeoutError returns 408 with code TIMEOUT_ERROR', async () => {
    const err = new TimeoutError('query took too long', 'postgres', 30000);
    const res = createErrorResponse(err);
    expect(res.status).toBe(408);
    const body = await res.json();
    expect(body.code).toBe('TIMEOUT_ERROR');
    expect(body.statusCode).toBe(408);
    expect(body.retryable).toBe(true);
  });

  test('ConnectionError returns 503 with code CONNECTION_ERROR', async () => {
    const err = new ConnectionError('ECONNREFUSED', 'postgres', 'localhost', 5432);
    const res = createErrorResponse(err);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('CONNECTION_ERROR');
    expect(body.statusCode).toBe(503);
    expect(body.retryable).toBe(true);
  });

  test('PoolExhaustedError returns 503 with code POOL_EXHAUSTED', async () => {
    const err = new PoolExhaustedError('no connections available', 'postgres', 10);
    const res = createErrorResponse(err);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('POOL_EXHAUSTED');
    expect(body.statusCode).toBe(503);
    expect(body.retryable).toBe(true);
  });

  test('DatabaseError (base) returns 500', async () => {
    const err = new DatabaseError('unknown db error', 'postgres');
    const res = createErrorResponse(err);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.statusCode).toBe(500);
    expect(body.error).toContain('unknown db error');
  });

  test('QueryCancelledError returns 499 with code QUERY_CANCELLED', async () => {
    const err = new QueryCancelledError('Query was cancelled', 'postgres', 'SELECT 1');
    const res = createErrorResponse(err);
    expect(res.status).toBe(499);
    const body = await res.json();
    expect(body.code).toBe('QUERY_CANCELLED');
    expect(body.statusCode).toBe(499);
  });

  // ─── LLM Errors ──────────────────────────────────────────────────────────

  test('LLMSafetyError returns 400 with code LLM_SAFETY', async () => {
    const err = new LLMSafetyError('content blocked', 'gemini');
    const res = createErrorResponse(err);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('LLM_SAFETY');
    expect(body.statusCode).toBe(400);
  });

  test('LLMAuthError returns 401 with code LLM_AUTH', async () => {
    const err = new LLMAuthError('invalid key', 'openai');
    const res = createErrorResponse(err);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('LLM_AUTH');
    expect(body.statusCode).toBe(401);
  });

  test('LLMRateLimitError returns 429 with code LLM_RATE_LIMIT', async () => {
    const err = new LLMRateLimitError('quota exceeded', 'gemini');
    const res = createErrorResponse(err);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe('LLM_RATE_LIMIT');
    expect(body.statusCode).toBe(429);
    expect(body.retryable).toBe(true);
  });

  test('LLMConfigError returns 503 with code LLM_CONFIG', async () => {
    const err = new LLMConfigError('missing API key', 'ollama');
    const res = createErrorResponse(err);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('LLM_CONFIG');
    expect(body.statusCode).toBe(503);
  });

  test('LLMStreamError returns 502 with code LLM_STREAM', async () => {
    const err = new LLMStreamError('stream interrupted', 'openai');
    const res = createErrorResponse(err);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('LLM_STREAM');
    expect(body.statusCode).toBe(502);
    expect(body.retryable).toBe(true);
  });

  test('LLMError (base) uses statusCode or 500', async () => {
    const err = new LLMError('generic llm error', 'gemini', 503);
    const res = createErrorResponse(err);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('LLM_ERROR');
    expect(body.statusCode).toBe(503);
  });

  test('LLMError (base) without statusCode defaults to 500', async () => {
    const err = new LLMError('generic llm error', 'gemini');
    const res = createErrorResponse(err);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('LLM_ERROR');
    expect(body.statusCode).toBe(500);
  });

  // ─── Generic Errors ───────────────────────────────────────────────────────

  test('generic Error returns 500 with code INTERNAL_ERROR', async () => {
    const err = new Error('unexpected failure');
    const res = createErrorResponse(err);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.statusCode).toBe(500);
    expect(body.error).toBe('unexpected failure');
  });

  test('non-Error (string) returns 500 with code INTERNAL_ERROR', async () => {
    const res = createErrorResponse('something went wrong');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.statusCode).toBe(500);
    expect(body.error).toBe('Internal server error');
  });
});
