import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { LLMConfigError } from '@/lib/llm/types';

// ============================================================================
// Environment Variable Management
// ============================================================================

let savedEnv: Record<string, string | undefined>;

const LLM_ENV_KEYS = ['LLM_PROVIDER', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_API_URL'];

// ============================================================================
// Module Mocks (must be before await import)
// Mocking provider constructors to avoid real SDK initialization
// ============================================================================

mock.module('@google/generative-ai', () => ({
  GoogleGenerativeAI: function () {
    return {
      getGenerativeModel: () => ({
        generateContentStream: async () => ({ stream: (async function* () {})() }),
      }),
    };
  },
}));

// ============================================================================
// Import module under test (after mocks)
// ============================================================================

const { createLLMProvider, getDefaultProvider, resetDefaultProvider } = await import(
  '@/lib/llm/factory'
);

// ============================================================================
// Tests
// ============================================================================

describe('LLM Factory', () => {
  beforeEach(() => {
    savedEnv = {};
    for (const key of LLM_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    resetDefaultProvider();
  });

  afterEach(() => {
    for (const key of LLM_ENV_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    resetDefaultProvider();
  });

  // --------------------------------------------------------------------------
  // createLLMProvider()
  // --------------------------------------------------------------------------

  describe('createLLMProvider()', () => {
    test('creates GeminiProvider for gemini type', async () => {
      const provider = await createLLMProvider({
        provider: 'gemini',
        apiKey: 'test-gemini-key',
        model: 'gemini-2.0-flash',
      });
      expect(provider.name).toBe('gemini');
    });

    test('creates OpenAIProvider for openai type', async () => {
      const provider = await createLLMProvider({
        provider: 'openai',
        apiKey: 'sk-test-key',
        model: 'gpt-4o',
      });
      expect(provider.name).toBe('openai');
    });

    test('creates OllamaProvider for ollama type', async () => {
      const provider = await createLLMProvider({
        provider: 'ollama',
        model: 'llama3.2',
      });
      expect(provider.name).toBe('ollama');
    });

    test('creates CustomProvider for custom type', async () => {
      const provider = await createLLMProvider({
        provider: 'custom',
        apiUrl: 'https://my-endpoint.com/v1',
        model: 'custom-model',
      });
      expect(provider.name).toBe('custom');
    });

    test('throws LLMConfigError for unknown provider', async () => {
      await expect(
        createLLMProvider({
          provider: 'nonexistent' as 'gemini',
          model: 'some-model',
        })
      ).rejects.toThrow(LLMConfigError);
    });
  });

  // --------------------------------------------------------------------------
  // getDefaultProvider()
  // --------------------------------------------------------------------------

  describe('getDefaultProvider()', () => {
    test('returns singleton instance', async () => {
      process.env.LLM_PROVIDER = 'gemini';
      process.env.LLM_API_KEY = 'test-key-for-singleton';
      process.env.LLM_MODEL = 'gemini-2.0-flash';

      const provider = await getDefaultProvider();
      expect(provider).toBeDefined();
      expect(provider.name).toBe('gemini');
    });

    test('returns same instance on second call', async () => {
      process.env.LLM_PROVIDER = 'gemini';
      process.env.LLM_API_KEY = 'test-key-for-singleton';
      process.env.LLM_MODEL = 'gemini-2.0-flash';

      const first = await getDefaultProvider();
      const second = await getDefaultProvider();
      expect(first).toBe(second);
    });
  });

  // --------------------------------------------------------------------------
  // resetDefaultProvider()
  // --------------------------------------------------------------------------

  describe('resetDefaultProvider()', () => {
    test('clears singleton so next call creates new', async () => {
      process.env.LLM_PROVIDER = 'gemini';
      process.env.LLM_API_KEY = 'test-key-for-singleton';
      process.env.LLM_MODEL = 'gemini-2.0-flash';

      const first = await getDefaultProvider();

      resetDefaultProvider();

      const second = await getDefaultProvider();
      // They should be different object references
      expect(first).not.toBe(second);
    });
  });
});
