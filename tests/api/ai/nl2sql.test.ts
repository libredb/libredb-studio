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

const { POST } = await import('@/app/api/ai/nl2sql/route');

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/ai/nl2sql', () => {
  beforeEach(() => {
    mockCreateLLMProvider.mockClear();
    mockStream.mockClear();
    mockCreateLLMProvider.mockImplementation(async () => mockProvider);
    mockStream.mockImplementation(async () => createMockStream());
  });

  test('returns streaming response with question', async () => {
    const req = createMockRequest('/api/ai/nl2sql', {
      method: 'POST',
      body: { question: 'Show me all active users', databaseType: 'postgres' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');

    const text = await readStreamResponse(res);
    expect(text).toBe('mock response');
    expect(mockCreateLLMProvider).toHaveBeenCalledTimes(1);
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  test('returns 400 when question is missing', async () => {
    const req = createMockRequest('/api/ai/nl2sql', {
      method: 'POST',
      body: { databaseType: 'postgres' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(400);

    const data = await parseResponseJSON<{ error: string }>(res);
    expect(data.error).toContain('required');
  });

  test('returns streaming response with conversation history', async () => {
    const req = createMockRequest('/api/ai/nl2sql', {
      method: 'POST',
      body: {
        question: 'And filter by active status',
        databaseType: 'postgres',
        conversationHistory: [
          { role: 'user', content: 'Show me users' },
          { role: 'assistant', content: 'SELECT * FROM users;' },
        ],
      },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);

    const text = await readStreamResponse(res);
    expect(text).toBe('mock response');

    const callArgs = mockStream.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    // system + 2 history + current question
    expect(callArgs.messages.length).toBe(4);
  });

  test('returns 500 on LLMConfigError', async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMConfigError('LLM not configured');
    });

    const req = createMockRequest('/api/ai/nl2sql', {
      method: 'POST',
      body: { question: 'test' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);
  });

  test('returns 401 on LLMAuthError', async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMAuthError('Invalid API key');
    });

    const req = createMockRequest('/api/ai/nl2sql', {
      method: 'POST',
      body: { question: 'test' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(401);
  });

  test('returns 429 on LLMRateLimitError', async () => {
    mockCreateLLMProvider.mockImplementation(async () => {
      throw new MockLLMRateLimitError('Rate limit');
    });

    const req = createMockRequest('/api/ai/nl2sql', {
      method: 'POST',
      body: { question: 'test' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(429);
  });

  test('returns 400 on LLMSafetyError', async () => {
    mockStream.mockImplementation(async () => {
      throw new MockLLMSafetyError('Blocked');
    });

    const req = createMockRequest('/api/ai/nl2sql', {
      method: 'POST',
      body: { question: 'test' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  test('returns 500 on generic error', async () => {
    mockStream.mockImplementation(async () => {
      throw new Error('Unexpected failure');
    });

    const req = createMockRequest('/api/ai/nl2sql', {
      method: 'POST',
      body: { question: 'test' },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(500);

    const data = await parseResponseJSON<{ error: string }>(res);
    expect(data.error).toBe('Unexpected failure');
  });
});
