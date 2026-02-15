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
// Import module under test (no mock.module needed — Custom uses globalThis.fetch)
// ============================================================================

const { CustomProvider } = await import('@/lib/llm/providers/custom');

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
    provider: 'custom',
    apiKey: 'custom-api-key',
    apiUrl: 'https://my-llm-proxy.example.com/v1',
    model: 'my-custom-model',
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

describe('CustomProvider', () => {
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
    test('creates with valid config including apiUrl', () => {
      const provider = new CustomProvider(makeConfig());
      expect(provider.name).toBe('custom');
      expect(provider.config.model).toBe('my-custom-model');
      expect(provider.config.apiUrl).toBe('https://my-llm-proxy.example.com/v1');
    });

    test('throws LLMConfigError without apiUrl', () => {
      expect(
        () => new CustomProvider(makeConfig({ apiUrl: undefined }))
      ).toThrow(LLMConfigError);
    });

    test('throws LLMConfigError without model', () => {
      expect(
        () =>
          new CustomProvider(
            makeConfig({ model: undefined as unknown as string })
          )
      ).toThrow(LLMConfigError);
    });
  });

  // --------------------------------------------------------------------------
  // stream()
  // --------------------------------------------------------------------------

  describe('stream()', () => {
    test('sends Bearer token when apiKey provided', async () => {
      const sseData = [makeSSEChunk('Hi'), 'data: [DONE]\n\n'];
      fetchSpy.mockResolvedValueOnce(createSSEResponse(sseData));

      const provider = new CustomProvider(makeConfig({ apiKey: 'my-secret-key' }));
      await provider.stream(makeStreamOptions());

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer my-secret-key');
    });

    test('omits Authorization when no apiKey', async () => {
      const sseData = [makeSSEChunk('Hi'), 'data: [DONE]\n\n'];
      fetchSpy.mockResolvedValueOnce(createSSEResponse(sseData));

      const provider = new CustomProvider(makeConfig({ apiKey: undefined }));
      await provider.stream(makeStreamOptions());

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    });

    test('returns parsed stream content', async () => {
      const sseData = [
        makeSSEChunk('Custom'),
        makeSSEChunk(' response'),
        'data: [DONE]\n\n',
      ];
      fetchSpy.mockResolvedValueOnce(createSSEResponse(sseData));

      const provider = new CustomProvider(makeConfig());
      const stream = await provider.stream(makeStreamOptions());

      expect(stream).toBeInstanceOf(ReadableStream);
      const text = await readStream(stream);
      expect(text).toBe('Custom response');
    });
  });

  // --------------------------------------------------------------------------
  // validateResponse()
  // --------------------------------------------------------------------------

  describe('validateResponse()', () => {
    test('401 throws LLMAuthError', async () => {
      fetchSpy.mockImplementation(async () =>
        createJsonResponse({ error: { message: 'Unauthorized' } }, 401)
      );

      const provider = new CustomProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMAuthError
      );
    });

    test('403 throws LLMAuthError', async () => {
      fetchSpy.mockImplementation(async () =>
        createJsonResponse({ error: { message: 'Forbidden' } }, 403)
      );

      const provider = new CustomProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMAuthError
      );
    });

    test('429 throws LLMRateLimitError', async () => {
      fetchSpy.mockImplementation(async () =>
        createJsonResponse({ error: { message: 'Rate limited' } }, 429)
      );

      const provider = new CustomProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMRateLimitError
      );
    });

    test('500 throws LLMStreamError', async () => {
      fetchSpy.mockImplementation(async () =>
        createJsonResponse({ error: { message: 'Server error' } }, 500)
      );

      const provider = new CustomProvider(makeConfig());
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
        throw new Error('connect ECONNREFUSED 127.0.0.1:8080');
      });

      const provider = new CustomProvider(makeConfig());
      try {
        await provider.stream(makeStreamOptions());
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(LLMStreamError);
        expect((err as Error).message).toContain('Cannot connect to custom endpoint');
      }
    });

    test('LLMStreamError passes through', async () => {
      fetchSpy.mockImplementation(async () =>
        createJsonResponse({ error: { message: 'stream broken' } }, 500)
      );

      const provider = new CustomProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMStreamError
      );
    });

    test('generic error maps to LLMStreamError', async () => {
      fetchSpy.mockImplementation(async () => {
        throw new Error('Something unexpected');
      });

      const provider = new CustomProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMStreamError
      );
    });

    test('non-Error maps to LLMStreamError', async () => {
      fetchSpy.mockImplementation(async () => {
        throw 'string error';
      });

      const provider = new CustomProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMStreamError
      );
    });

    test('LLMAuthError passes through in stream()', async () => {
      fetchSpy.mockImplementation(async () =>
        createJsonResponse({ error: { message: 'bad key' } }, 401)
      );

      const provider = new CustomProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMAuthError
      );
    });
  });
});
