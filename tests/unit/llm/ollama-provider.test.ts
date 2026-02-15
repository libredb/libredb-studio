import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  LLMStreamError,
  LLMConfigError,
  type LLMConfig,
  type LLMStreamOptions,
} from '@/lib/llm/types';

// ============================================================================
// Import module under test (no mock.module needed — Ollama uses globalThis.fetch)
// ============================================================================

const { OllamaProvider } = await import('@/lib/llm/providers/ollama');

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
    provider: 'ollama',
    model: 'llama3.2',
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

describe('OllamaProvider', () => {
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
    test('creates without apiKey (not required for Ollama)', () => {
      const provider = new OllamaProvider(makeConfig());
      expect(provider.name).toBe('ollama');
      expect(provider.config.apiKey).toBeUndefined();
    });

    test('uses default Ollama URL (localhost:11434)', () => {
      const provider = new OllamaProvider(makeConfig());
      // The default URL is set internally; config.apiUrl remains undefined
      expect(provider.config.apiUrl).toBeUndefined();
    });

    test('uses custom apiUrl', () => {
      const provider = new OllamaProvider(
        makeConfig({ apiUrl: 'http://remote-ollama:11434/v1' })
      );
      expect(provider.config.apiUrl).toBe('http://remote-ollama:11434/v1');
    });
  });

  // --------------------------------------------------------------------------
  // validate()
  // --------------------------------------------------------------------------

  describe('validate()', () => {
    test('throws LLMConfigError without model', () => {
      // Ollama constructor does NOT call validate() automatically,
      // so we call it explicitly
      const provider = new OllamaProvider(
        makeConfig({ model: undefined as unknown as string })
      );
      expect(() => provider.validate()).toThrow(LLMConfigError);
    });

    test('throws LLMConfigError with empty model', () => {
      const provider = new OllamaProvider(makeConfig({ model: '' }));
      expect(() => provider.validate()).toThrow(LLMConfigError);
    });
  });

  // --------------------------------------------------------------------------
  // stream()
  // --------------------------------------------------------------------------

  describe('stream()', () => {
    test('sends Bearer ollama auth header', async () => {
      const sseData = [makeSSEChunk('Hi'), 'data: [DONE]\n\n'];
      fetchSpy.mockResolvedValueOnce(createSSEResponse(sseData));

      const provider = new OllamaProvider(makeConfig());
      await provider.stream(makeStreamOptions());

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer ollama');
    });

    test('returns parsed stream content', async () => {
      const sseData = [
        makeSSEChunk('Hello'),
        makeSSEChunk(' from'),
        makeSSEChunk(' Ollama'),
        'data: [DONE]\n\n',
      ];
      fetchSpy.mockResolvedValueOnce(createSSEResponse(sseData));

      const provider = new OllamaProvider(makeConfig());
      const stream = await provider.stream(makeStreamOptions());

      expect(stream).toBeInstanceOf(ReadableStream);
      const text = await readStream(stream);
      expect(text).toBe('Hello from Ollama');
    });

    test('passes model and messages', async () => {
      const sseData = [makeSSEChunk('ok'), 'data: [DONE]\n\n'];
      fetchSpy.mockResolvedValueOnce(createSSEResponse(sseData));

      const provider = new OllamaProvider(makeConfig());
      await provider.stream(
        makeStreamOptions({
          messages: [
            { role: 'system', content: 'Be concise' },
            { role: 'user', content: 'Hi' },
          ],
        })
      );

      const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
      expect(body.model).toBe('llama3.2');
      expect(body.messages).toHaveLength(2);
      expect(body.stream).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // validateResponse()
  // --------------------------------------------------------------------------

  describe('validateResponse()', () => {
    test('404 throws LLMConfigError with model pull message', async () => {
      fetchSpy.mockImplementation(async () =>
        createJsonResponse({ error: { message: 'model not found' } }, 404)
      );

      const provider = new OllamaProvider(makeConfig());
      try {
        await provider.stream(makeStreamOptions());
        expect(true).toBe(false); // should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(LLMConfigError);
        expect((err as Error).message).toContain('pulled');
      }
    });

    test('500 throws LLMStreamError', async () => {
      fetchSpy.mockImplementation(async () =>
        createJsonResponse({ error: { message: 'Internal error' } }, 500)
      );

      const provider = new OllamaProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMStreamError
      );
    });
  });

  // --------------------------------------------------------------------------
  // error mapping
  // --------------------------------------------------------------------------

  describe('error mapping', () => {
    test('ECONNREFUSED maps to connection error', async () => {
      fetchSpy.mockImplementation(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      });

      const provider = new OllamaProvider(makeConfig());
      try {
        await provider.stream(makeStreamOptions());
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(LLMStreamError);
        expect((err as Error).message).toContain('Cannot connect to Ollama');
      }
    });

    test('fetch failed maps to connection error', async () => {
      fetchSpy.mockImplementation(async () => {
        throw new TypeError('fetch failed');
      });

      const provider = new OllamaProvider(makeConfig());
      try {
        await provider.stream(makeStreamOptions());
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(LLMStreamError);
        expect((err as Error).message).toContain('Cannot connect to Ollama');
      }
    });

    test('LLMConfigError passes through', async () => {
      fetchSpy.mockImplementation(async () =>
        createJsonResponse({ error: { message: 'not found' } }, 404)
      );

      const provider = new OllamaProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMConfigError
      );
    });

    test('generic error maps to LLMStreamError', async () => {
      fetchSpy.mockImplementation(async () => {
        throw new Error('Unexpected error');
      });

      const provider = new OllamaProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMStreamError
      );
    });

    test('non-Error maps to LLMStreamError', async () => {
      fetchSpy.mockImplementation(async () => {
        throw 'string error value';
      });

      const provider = new OllamaProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMStreamError
      );
    });
  });
});
