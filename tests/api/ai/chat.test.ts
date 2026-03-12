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

const { POST } = await import('@/app/api/ai/chat/route');

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/ai/chat', () => {
  beforeEach(() => {
    mockCreateLLMProvider.mockClear();
    mockStream.mockClear();
    mockCreateLLMProvider.mockImplementation(async () => mockProvider);
    mockStream.mockImplementation(async () => createMockStream());
  });

  test('returns streaming response with prompt', async () => {
    const req = createMockRequest('/api/ai/chat', {
      method: 'POST',
      body: { prompt: 'SELECT * FROM users', databaseType: 'postgres' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');

    const text = await readStreamResponse(res);
    expect(text).toBe('mock response');
    expect(mockCreateLLMProvider).toHaveBeenCalledTimes(1);
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  test('returns streaming response with conversation history', async () => {
    const req = createMockRequest('/api/ai/chat', {
      method: 'POST',
      body: {
        prompt: 'And now join with orders',
        databaseType: 'postgres',
        conversationHistory: [
          { role: 'user', content: 'Show me all users' },
          { role: 'assistant', content: 'SELECT * FROM users;' },
        ],
      },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    const text = await readStreamResponse(res);
    expect(text).toBe('mock response');

    // Verify conversation history was passed in messages
    const callArgs = (mockStream.mock.calls as unknown[][])[0][0] as { messages: Array<{ role: string; content: string }> };
    expect(callArgs.messages.length).toBe(4); // system + 2 history + current prompt
    expect(callArgs.messages[1].role).toBe('user');
    expect(callArgs.messages[2].role).toBe('assistant');
    expect(callArgs.messages[3].content).toBe('And now join with orders');
  });

  test('returns streaming response with queryLanguage json (MongoDB)', async () => {
    const req = createMockRequest('/api/ai/chat', {
      method: 'POST',
      body: {
        prompt: 'Find all active users',
        databaseType: 'mongodb',
        queryLanguage: 'json',
      },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    const text = await readStreamResponse(res);
    expect(text).toBe('mock response');

    // System prompt should be MongoDB-specific
    const callArgs = (mockStream.mock.calls as unknown[][])[0][0] as { messages: Array<{ role: string; content: string }> };
    expect(callArgs.messages[0].content).toContain('MongoDB');
  });

  test('returns streaming response with schemaContext', async () => {
    const req = createMockRequest('/api/ai/chat', {
      method: 'POST',
      body: {
        prompt: 'Get user count',
        schemaContext: 'users(id, name, email)',
        databaseType: 'postgres',
      },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    const callArgs = (mockStream.mock.calls as unknown[][])[0][0] as { messages: Array<{ role: string; content: string }> };
    expect(callArgs.messages[0].content).toContain('users(id, name, email)');
  });

  test('returns 503 on LLMConfigError', async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMConfigError('LLM not configured');
    });

    const req = createMockRequest('/api/ai/chat', {
      method: 'POST',
      body: { prompt: 'test' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(503);

    const data = await parseResponseJSON<{ error: string }>(res);
    expect(data.error).toContain('LLM not configured');
  });

  test('returns 401 on LLMAuthError', async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMAuthError('Invalid API key');
    });

    const req = createMockRequest('/api/ai/chat', {
      method: 'POST',
      body: { prompt: 'test' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(401);

    const data = await parseResponseJSON<{ error: string }>(res);
    expect(data.error).toContain('Invalid API key');
  });

  test('returns 429 on LLMRateLimitError', async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMRateLimitError('Rate limit exceeded');
    });

    const req = createMockRequest('/api/ai/chat', {
      method: 'POST',
      body: { prompt: 'test' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(429);
  });

  test('returns 400 on LLMSafetyError', async () => {
    mockStream.mockImplementation(async () => {
      throw new MockLLMSafetyError('Content blocked');
    });

    const req = createMockRequest('/api/ai/chat', {
      method: 'POST',
      body: { prompt: 'test' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  test('returns custom status code on LLMError with statusCode', async () => {
    mockStream.mockImplementation(async () => {
      throw new MockLLMError('Service unavailable', undefined, 503);
    });

    const req = createMockRequest('/api/ai/chat', {
      method: 'POST',
      body: { prompt: 'test' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(503);
  });

  test('returns 500 on generic error', async () => {
    mockStream.mockImplementation(async () => {
      throw new Error('Something went wrong');
    });

    const req = createMockRequest('/api/ai/chat', {
      method: 'POST',
      body: { prompt: 'test' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);

    const data = await parseResponseJSON<{ error: string }>(res);
    expect(data.error).toBe('Something went wrong');
  });
});
