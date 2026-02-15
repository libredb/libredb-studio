import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  LLMAuthError,
  LLMRateLimitError,
  LLMStreamError,
  LLMConfigError,
  type LLMConfig,
  type LLMStreamOptions,
} from '@/lib/llm/types';

// ============================================================================
// Import module under test (no mock.module needed — OpenAI uses globalThis.fetch)
// ============================================================================

const { OpenAIProvider } = await import('@/lib/llm/providers/openai');

// ============================================================================
// Helpers
// ============================================================================

function makeSSEChunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function createSSEResponse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function createJsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value);
  }
  return result;
}

function makeConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  return {
    provider: 'openai',
    apiKey: 'sk-test-openai-key',
    model: 'gpt-4o',
    ...overrides,
  };
}

function makeStreamOptions(overrides?: Partial<LLMStreamOptions>): LLMStreamOptions {
  return {
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('OpenAIProvider', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // constructor
  // --------------------------------------------------------------------------

  describe('constructor', () => {
    test('creates with valid config', () => {
      const provider = new OpenAIProvider(makeConfig());
      expect(provider.name).toBe('openai');
      expect(provider.config.model).toBe('gpt-4o');
    });

    test('uses default OpenAI URL', () => {
      const provider = new OpenAIProvider(makeConfig());
      expect(provider.config.apiUrl).toBeUndefined();
    });

    test('uses custom apiUrl when provided', () => {
      const provider = new OpenAIProvider(
        makeConfig({ apiUrl: 'https://custom.openai.com/v1' })
      );
      expect(provider.config.apiUrl).toBe('https://custom.openai.com/v1');
    });

    test('throws without apiKey', () => {
      expect(() => new OpenAIProvider(makeConfig({ apiKey: undefined }))).toThrow(
        LLMConfigError
      );
    });
  });

  // --------------------------------------------------------------------------
  // stream()
  // --------------------------------------------------------------------------

  describe('stream()', () => {
    test('sends correct request to /chat/completions', async () => {
      const sseData = [makeSSEChunk('Hi'), 'data: [DONE]\n\n'];
      fetchSpy.mockResolvedValueOnce(createSSEResponse(sseData));

      const provider = new OpenAIProvider(makeConfig());
      await provider.stream(makeStreamOptions());

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/chat/completions');
      expect(opts.method).toBe('POST');

      const headers = opts.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers.Authorization).toBe('Bearer sk-test-openai-key');

      const body = JSON.parse(opts.body as string);
      expect(body.model).toBe('gpt-4o');
      expect(body.stream).toBe(true);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe('user');
    });

    test('returns ReadableStream with SSE parsed content', async () => {
      const sseData = [makeSSEChunk('Hello'), makeSSEChunk(' World'), 'data: [DONE]\n\n'];
      fetchSpy.mockResolvedValueOnce(createSSEResponse(sseData));

      const provider = new OpenAIProvider(makeConfig());
      const stream = await provider.stream(makeStreamOptions());

      expect(stream).toBeInstanceOf(ReadableStream);
      const text = await readStream(stream);
      expect(text).toBe('Hello World');
    });

    test('passes temperature and maxTokens', async () => {
      const sseData = [makeSSEChunk('ok'), 'data: [DONE]\n\n'];
      fetchSpy.mockResolvedValueOnce(createSSEResponse(sseData));

      const provider = new OpenAIProvider(makeConfig());
      await provider.stream(
        makeStreamOptions({ temperature: 0.7, maxTokens: 1000 })
      );

      const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
      expect(body.temperature).toBe(0.7);
      expect(body.max_tokens).toBe(1000);
    });

    test('uses model from options over config', async () => {
      const sseData = [makeSSEChunk('ok'), 'data: [DONE]\n\n'];
      fetchSpy.mockResolvedValueOnce(createSSEResponse(sseData));

      const provider = new OpenAIProvider(makeConfig());
      await provider.stream(makeStreamOptions({ model: 'gpt-3.5-turbo' }));

      const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
      expect(body.model).toBe('gpt-3.5-turbo');
    });
  });

  // --------------------------------------------------------------------------
  // validateResponse()
  // --------------------------------------------------------------------------

  describe('validateResponse()', () => {
    test('401 throws LLMAuthError', async () => {
      // Use mockImplementation so every retry also gets 401
      fetchSpy.mockImplementation(async () =>
        createJsonResponse({ error: { message: 'Invalid key' } }, 401)
      );

      const provider = new OpenAIProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMAuthError
      );
    });

    test('403 throws LLMAuthError', async () => {
      fetchSpy.mockImplementation(async () =>
        createJsonResponse({ error: { message: 'Forbidden' } }, 403)
      );

      const provider = new OpenAIProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMAuthError
      );
    });

    test('429 throws LLMRateLimitError', async () => {
      fetchSpy.mockImplementation(async () =>
        createJsonResponse({ error: { message: 'Rate limit' } }, 429)
      );

      const provider = new OpenAIProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMRateLimitError
      );
    });

    test('500 throws LLMStreamError', async () => {
      fetchSpy.mockImplementation(async () =>
        createJsonResponse({ error: { message: 'Internal Server Error' } }, 500)
      );

      const provider = new OpenAIProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMStreamError
      );
    });

    test('error body parsed as JSON', async () => {
      fetchSpy.mockImplementation(async () =>
        createJsonResponse({ error: { message: 'Custom error detail' } }, 500)
      );

      const provider = new OpenAIProvider(makeConfig());
      try {
        await provider.stream(makeStreamOptions());
        expect(true).toBe(false); // should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(LLMStreamError);
        expect((err as Error).message).toContain('Custom error detail');
      }
    });
  });

  // --------------------------------------------------------------------------
  // error mapping
  // --------------------------------------------------------------------------

  describe('error mapping', () => {
    test('fetch error maps to network error', async () => {
      fetchSpy.mockImplementation(async () => {
        throw new TypeError('fetch failed');
      });

      const provider = new OpenAIProvider(makeConfig());
      try {
        await provider.stream(makeStreamOptions());
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(LLMStreamError);
        expect((err as Error).message).toContain('Network error');
      }
    });

    test('generic Error maps to LLMStreamError', async () => {
      fetchSpy.mockImplementation(async () => {
        throw new Error('Something unexpected');
      });

      const provider = new OpenAIProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMStreamError
      );
    });

    test('non-Error maps to LLMStreamError', async () => {
      fetchSpy.mockImplementation(async () => {
        throw 'string error';
      });

      const provider = new OpenAIProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMStreamError
      );
    });
  });

  // --------------------------------------------------------------------------
  // buildMessages()
  // --------------------------------------------------------------------------

  describe('buildMessages()', () => {
    test('maps messages to role/content format', async () => {
      const sseData = [makeSSEChunk('ok'), 'data: [DONE]\n\n'];
      fetchSpy.mockResolvedValueOnce(createSSEResponse(sseData));

      const provider = new OpenAIProvider(makeConfig());
      await provider.stream(
        makeStreamOptions({
          messages: [
            { role: 'system', content: 'Be helpful' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' },
            { role: 'user', content: 'How are you?' },
          ],
        })
      );

      const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
      expect(body.messages).toHaveLength(4);
      expect(body.messages[0]).toEqual({ role: 'system', content: 'Be helpful' });
      expect(body.messages[1]).toEqual({ role: 'user', content: 'Hello' });
      expect(body.messages[2]).toEqual({ role: 'assistant', content: 'Hi there!' });
      expect(body.messages[3]).toEqual({ role: 'user', content: 'How are you?' });
    });
  });
});
