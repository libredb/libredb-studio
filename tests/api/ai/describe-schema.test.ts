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
  LLMConfigError: MockLLMConfigError,
  LLMAuthError: MockLLMAuthError,
  LLMRateLimitError: MockLLMRateLimitError,
  LLMSafetyError: MockLLMSafetyError,
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────

const { POST } = await import('@/app/api/ai/describe-schema/route');

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/ai/describe-schema', () => {
  beforeEach(() => {
    mockCreateLLMProvider.mockClear();
    mockStream.mockClear();
    mockCreateLLMProvider.mockImplementation(async () => mockProvider);
    mockStream.mockImplementation(async () => createMockStream());
  });

  test('returns streaming response with schemaContext', async () => {
    const req = createMockRequest('/api/ai/describe-schema', {
      method: 'POST',
      body: {
        schemaContext: 'users(id, name, email), orders(id, user_id, total)',
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

  test('returns 400 when schemaContext is missing', async () => {
    const req = createMockRequest('/api/ai/describe-schema', {
      method: 'POST',
      body: { databaseType: 'postgres' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(400);

    const data = await parseResponseJSON<{ error: string }>(res);
    expect(data.error).toContain('required');
  });

  test('returns streaming response with mode=table', async () => {
    const req = createMockRequest('/api/ai/describe-schema', {
      method: 'POST',
      body: {
        schemaContext: 'users(id INTEGER PK, name VARCHAR, email VARCHAR UNIQUE)',
        databaseType: 'postgres',
        mode: 'table',
      },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    const text = await readStreamResponse(res);
    expect(text).toBe('mock response');

    // Verify the table-specific system prompt was used
    const callArgs = (mockStream.mock.calls as unknown[][])[0][0] as { messages: Array<{ role: string; content: string }> };
    expect(callArgs.messages[0].content).toContain('table schema');
  });

  test('returns 503 on LLMConfigError (different from other AI routes)', async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMConfigError('AI not configured');
    });

    const req = createMockRequest('/api/ai/describe-schema', {
      method: 'POST',
      body: { schemaContext: 'users(id, name)' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(503);

    const data = await parseResponseJSON<{ error: string }>(res);
    expect(data.error).toContain('AI not configured');
  });

  test('returns 401 on LLMAuthError', async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMAuthError('Invalid API key');
    });

    const req = createMockRequest('/api/ai/describe-schema', {
      method: 'POST',
      body: { schemaContext: 'users(id, name)' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(401);

    const data = await parseResponseJSON<{ error: string }>(res);
    expect(data.error).toContain('authentication');
  });

  test('returns 429 on LLMRateLimitError', async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMRateLimitError('Rate limit exceeded');
    });

    const req = createMockRequest('/api/ai/describe-schema', {
      method: 'POST',
      body: { schemaContext: 'users(id, name)' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(429);

    const data = await parseResponseJSON<{ error: string }>(res);
    expect(data.error).toContain('rate limit');
  });

  test('returns 400 on LLMSafetyError', async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMSafetyError('Content blocked');
    });

    const req = createMockRequest('/api/ai/describe-schema', {
      method: 'POST',
      body: { schemaContext: 'users(id, name)' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(400);

    const data = await parseResponseJSON<{ error: string }>(res);
    expect(data.error).toContain('safety');
  });

  test('returns 500 with error.message for generic Error', async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new Error('Something went wrong');
    });

    const req = createMockRequest('/api/ai/describe-schema', {
      method: 'POST',
      body: { schemaContext: 'users(id, name)' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);

    const data = await parseResponseJSON<{ error: string }>(res);
    expect(data.error).toBe('Something went wrong');
  });

  test('returns 500 with Unknown error for non-Error thrown', async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw 'string error';
    });

    const req = createMockRequest('/api/ai/describe-schema', {
      method: 'POST',
      body: { schemaContext: 'users(id, name)' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);

    const data = await parseResponseJSON<{ error: string }>(res);
    expect(data.error).toBe('Unknown error');
  });

  test('mode omitted uses database overview prompt (not table prompt)', async () => {
    const req = createMockRequest('/api/ai/describe-schema', {
      method: 'POST',
      body: {
        schemaContext: 'users(id, name), orders(id, user_id)',
        databaseType: 'postgres',
        // mode not specified
      },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    const callArgs = (mockStream.mock.calls as unknown[][])[0][0] as { messages: Array<{ role: string; content: string }> };
    expect(callArgs.messages[0].content).toContain('Database Overview');
    expect(callArgs.messages[0].content).not.toContain('table schema');
  });

  test('databaseType omitted falls back to SQL in prompt', async () => {
    const req = createMockRequest('/api/ai/describe-schema', {
      method: 'POST',
      body: {
        schemaContext: 'users(id, name)',
        mode: 'table',
        // databaseType not specified
      },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    const callArgs = (mockStream.mock.calls as unknown[][])[0][0] as { messages: Array<{ role: string; content: string }> };
    expect(callArgs.messages[0].content).toContain('Database type: SQL');
  });
});
