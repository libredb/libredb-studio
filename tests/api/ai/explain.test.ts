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
class MockLLMStreamError extends MockLLMError {
  constructor(msg: string) { super(msg); this.name = 'LLMStreamError'; }
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

mock.module('@/lib/llm/types', () => ({
  LLMError: MockLLMError,
  LLMConfigError: MockLLMConfigError,
  LLMAuthError: MockLLMAuthError,
  LLMRateLimitError: MockLLMRateLimitError,
  LLMSafetyError: MockLLMSafetyError,
  LLMStreamError: MockLLMStreamError,
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────

const { POST } = await import('@/app/api/ai/explain/route');

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/ai/explain', () => {
  beforeEach(() => {
    mockCreateLLMProvider.mockClear();
    mockStream.mockClear();
    mockCreateLLMProvider.mockImplementation(async () => mockProvider);
    mockStream.mockImplementation(async () => createMockStream());
  });

  test('returns streaming response with query and explainPlan', async () => {
    const req = createMockRequest('/api/ai/explain', {
      method: 'POST',
      body: {
        query: 'SELECT * FROM users WHERE id = 1',
        explainPlan: { 'Node Type': 'Seq Scan', 'Relation Name': 'users' },
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
    const req = createMockRequest('/api/ai/explain', {
      method: 'POST',
      body: { explainPlan: {}, databaseType: 'postgres' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(400);

    const data = await parseResponseJSON<{ error: string }>(res);
    expect(data.error).toContain('required');
  });

  test('returns streaming response with schemaContext', async () => {
    const req = createMockRequest('/api/ai/explain', {
      method: 'POST',
      body: {
        query: 'SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id',
        schemaContext: 'users(id, name), orders(id, user_id, total)',
        databaseType: 'postgres',
      },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    const text = await readStreamResponse(res);
    expect(text).toBe('mock response');

    const callArgs = (mockStream.mock.calls as unknown[][])[0][0] as { messages: Array<{ role: string; content: string }> };
    expect(callArgs.messages[0].content).toContain('users(id, name)');
  });

  test('returns 503 on LLMConfigError', async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMConfigError('LLM not configured');
    });

    const req = createMockRequest('/api/ai/explain', {
      method: 'POST',
      body: { query: 'SELECT 1' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(503);
  });

  test('returns 401 on LLMAuthError', async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMAuthError('Invalid API key');
    });

    const req = createMockRequest('/api/ai/explain', {
      method: 'POST',
      body: { query: 'SELECT 1' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(401);
  });

  test('returns 429 on LLMRateLimitError', async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMRateLimitError('Rate limit');
    });

    const req = createMockRequest('/api/ai/explain', {
      method: 'POST',
      body: { query: 'SELECT 1' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(429);
  });

  test('returns 400 on LLMSafetyError', async () => {
    mockStream.mockImplementation(async () => {
      throw new MockLLMSafetyError('Blocked');
    });

    const req = createMockRequest('/api/ai/explain', {
      method: 'POST',
      body: { query: 'SELECT 1' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  test('returns custom status code on LLMError with statusCode', async () => {
    mockStream.mockImplementation(async () => {
      throw new MockLLMError('Service unavailable', undefined, 503);
    });

    const req = createMockRequest('/api/ai/explain', {
      method: 'POST',
      body: { query: 'SELECT 1' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(503);
  });
});
