import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockRequest, readStreamResponse, parseResponseJSON } from '../../helpers/mock-next';

// ─── Mock helpers ───────────────────────────────────────────────────────────

function createMockStream(text = 'mock response') {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

class MockLLMError extends Error {
  statusCode?: number;
  constructor(msg: string, _provider?: string, code?: number) {
    super(msg);
    this.name = 'LLMError';
    this.statusCode = code;
  }
}
class MockLLMConfigError extends MockLLMError {
  constructor(msg: string) { super(msg); this.name = 'LLMConfigError'; }
}
class MockLLMAuthError extends MockLLMError {
  constructor(msg: string) { super(msg, undefined, 401); this.name = 'LLMAuthError'; }
}
class MockLLMRateLimitError extends MockLLMError {
  constructor(msg: string) { super(msg, undefined, 429); this.name = 'LLMRateLimitError'; }
}
class MockLLMSafetyError extends MockLLMError {
  constructor(msg: string) { super(msg, undefined, 400); this.name = 'LLMSafetyError'; }
}

// ─── Mock @/lib/llm BEFORE importing the route ─────────────────────────────

const mockStream = mock(async () => createMockStream());
const mockProvider = { stream: mockStream };
const mockCreateLLMProvider = mock(async () => mockProvider);

mock.module('@/lib/llm', () => ({
  createLLMProvider: mockCreateLLMProvider,
  LLMError: MockLLMError,
  LLMConfigError: MockLLMConfigError,
  LLMAuthError: MockLLMAuthError,
  LLMRateLimitError: MockLLMRateLimitError,
  LLMSafetyError: MockLLMSafetyError,
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────

const { POST } = await import('@/app/api/ai/query-safety/route');

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/ai/query-safety', () => {
  beforeEach(() => {
    mockCreateLLMProvider.mockClear();
    mockStream.mockClear();
    mockCreateLLMProvider.mockImplementation(async () => mockProvider);
    mockStream.mockImplementation(async () => createMockStream());
  });

  test('returns streaming response with query', async () => {
    const req = createMockRequest('/api/ai/query-safety', {
      method: 'POST',
      body: {
        query: 'DROP TABLE users',
        schemaContext: 'users(id, name)',
        databaseType: 'postgres',
      },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');

    const text = await readStreamResponse(res);
    expect(text).toBe('mock response');
    expect(mockCreateLLMProvider).toHaveBeenCalledTimes(1);
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  test('returns 400 when query is missing', async () => {
    const req = createMockRequest('/api/ai/query-safety', {
      method: 'POST',
      body: { databaseType: 'postgres' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(400);

    const data = await parseResponseJSON<{ error: string }>(res);
    expect(data.error).toContain('required');
  });

  test('returns 500 on LLMConfigError', async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMConfigError('LLM not configured');
    });

    const req = createMockRequest('/api/ai/query-safety', {
      method: 'POST',
      body: { query: 'DELETE FROM users' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);
  });

  test('returns 401 on LLMAuthError', async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMAuthError('Invalid key');
    });

    const req = createMockRequest('/api/ai/query-safety', {
      method: 'POST',
      body: { query: 'DELETE FROM users' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(401);
  });

  test('returns 429 on LLMRateLimitError', async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMRateLimitError('Rate limit');
    });

    const req = createMockRequest('/api/ai/query-safety', {
      method: 'POST',
      body: { query: 'DELETE FROM users' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(429);
  });

  test('returns 400 on LLMSafetyError', async () => {
    mockStream.mockImplementation(async () => {
      throw new MockLLMSafetyError('Blocked');
    });

    const req = createMockRequest('/api/ai/query-safety', {
      method: 'POST',
      body: { query: 'DELETE FROM users' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  test('returns custom status code on LLMError', async () => {
    mockStream.mockImplementation(async () => {
      throw new MockLLMError('Bad gateway', undefined, 502);
    });

    const req = createMockRequest('/api/ai/query-safety', {
      method: 'POST',
      body: { query: 'DELETE FROM users' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(502);
  });

  test('returns 500 on generic error', async () => {
    mockStream.mockImplementation(async () => {
      throw new Error('Unexpected');
    });

    const req = createMockRequest('/api/ai/query-safety', {
      method: 'POST',
      body: { query: 'DELETE FROM users' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);

    const data = await parseResponseJSON<{ error: string }>(res);
    expect(data.error).toBe('Unexpected');
  });
});
