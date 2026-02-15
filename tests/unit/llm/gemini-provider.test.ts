import { describe, test, expect, mock, beforeEach } from 'bun:test';
import {
  LLMAuthError,
  LLMRateLimitError,
  LLMSafetyError,
  LLMStreamError,
  LLMConfigError,
  type LLMConfig,
  type LLMStreamOptions,
} from '@/lib/llm/types';

// ============================================================================
// Mock State
// ============================================================================

let mockGenerateContentStream: (prompt: string) => Promise<unknown>;

// ============================================================================
// Module Mocks (must be before await import)
// ============================================================================

mock.module('@google/generative-ai', () => ({
  GoogleGenerativeAI: function () {
    return {
      getGenerativeModel: function () {
        return {
          generateContentStream: async (prompt: string) =>
            mockGenerateContentStream(prompt),
        };
      },
    };
  },
}));

// ============================================================================
// Import module under test (after mocks)
// ============================================================================

const { GeminiProvider } = await import('@/lib/llm/providers/gemini');

// ============================================================================
// Helpers
// ============================================================================

async function* mockStreamChunks(texts: string[]) {
  for (const t of texts) {
    yield { text: () => t };
  }
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
    provider: 'gemini',
    apiKey: 'test-gemini-api-key',
    model: 'gemini-2.0-flash',
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

describe('GeminiProvider', () => {
  beforeEach(() => {
    mockGenerateContentStream = async () => ({
      stream: mockStreamChunks(['Hello', ' World']),
    });
  });

  // --------------------------------------------------------------------------
  // constructor
  // --------------------------------------------------------------------------

  describe('constructor', () => {
    test('creates instance with valid config', () => {
      const provider = new GeminiProvider(makeConfig());
      expect(provider.name).toBe('gemini');
      expect(provider.config.model).toBe('gemini-2.0-flash');
    });

    test('throws LLMConfigError without apiKey', () => {
      expect(() => new GeminiProvider(makeConfig({ apiKey: undefined }))).toThrow(
        LLMConfigError
      );
    });
  });

  // --------------------------------------------------------------------------
  // stream()
  // --------------------------------------------------------------------------

  describe('stream()', () => {
    test('returns ReadableStream on success', async () => {
      const provider = new GeminiProvider(makeConfig());
      const stream = await provider.stream(makeStreamOptions());

      expect(stream).toBeInstanceOf(ReadableStream);
      const text = await readStream(stream);
      expect(text).toBe('Hello World');
    });

    test('passes model from options', async () => {
      const provider = new GeminiProvider(makeConfig());
      const stream = await provider.stream(
        makeStreamOptions({ model: 'gemini-pro' })
      );
      expect(stream).toBeInstanceOf(ReadableStream);
    });

    test('passes system instruction', async () => {
      const provider = new GeminiProvider(makeConfig());
      const stream = await provider.stream(
        makeStreamOptions({
          messages: [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Hello' },
          ],
        })
      );
      expect(stream).toBeInstanceOf(ReadableStream);
    });

    test('handles empty stream', async () => {
      mockGenerateContentStream = async () => ({
        stream: mockStreamChunks([]),
      });

      const provider = new GeminiProvider(makeConfig());
      const stream = await provider.stream(makeStreamOptions());
      const text = await readStream(stream);
      expect(text).toBe('');
    });
  });

  // --------------------------------------------------------------------------
  // error mapping
  // --------------------------------------------------------------------------

  describe('error mapping', () => {
    test('api key error maps to LLMAuthError', async () => {
      mockGenerateContentStream = async () => {
        throw new Error('Invalid API key provided');
      };

      const provider = new GeminiProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMAuthError
      );
    });

    test('unauthorized error maps to LLMAuthError', async () => {
      mockGenerateContentStream = async () => {
        throw new Error('Unauthorized access');
      };

      const provider = new GeminiProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMAuthError
      );
    });

    test('quota error maps to LLMRateLimitError', async () => {
      mockGenerateContentStream = async () => {
        throw new Error('Quota exceeded for this project');
      };

      const provider = new GeminiProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMRateLimitError
      );
    });

    test('rate limit error maps to LLMRateLimitError', async () => {
      mockGenerateContentStream = async () => {
        throw new Error('Rate limit reached');
      };

      const provider = new GeminiProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMRateLimitError
      );
    });

    test('safety error maps to LLMSafetyError', async () => {
      mockGenerateContentStream = async () => {
        throw new Error('Content blocked by safety filters');
      };

      const provider = new GeminiProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMSafetyError
      );
    });

    test('blocked error maps to LLMSafetyError', async () => {
      mockGenerateContentStream = async () => {
        throw new Error('Response was blocked');
      };

      const provider = new GeminiProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMSafetyError
      );
    });

    test('generic error maps to LLMStreamError', async () => {
      mockGenerateContentStream = async () => {
        throw new Error('Something unexpected happened');
      };

      const provider = new GeminiProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMStreamError
      );
    });

    test('non-Error value maps to LLMStreamError', async () => {
      mockGenerateContentStream = async () => {
        throw 'string error value';
      };

      const provider = new GeminiProvider(makeConfig());
      await expect(provider.stream(makeStreamOptions())).rejects.toBeInstanceOf(
        LLMStreamError
      );
    });
  });
});
