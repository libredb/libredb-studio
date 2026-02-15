import { describe, test, expect } from 'bun:test';
import {
  type LLMConfig,
  type LLMStreamOptions,
  LLMConfigError,
} from '@/lib/llm/types';
import { BaseLLMProvider } from '@/lib/llm/base-provider';

// ============================================================================
// Concrete Test Provider (BaseLLMProvider is abstract)
// ============================================================================

class TestProvider extends BaseLLMProvider {
  constructor(config: LLMConfig) {
    super(config);
  }

  async stream(): Promise<ReadableStream<Uint8Array>> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  }
}

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  return {
    provider: 'gemini',
    apiKey: 'test-api-key',
    model: 'test-model',
    apiUrl: 'https://api.example.com/v1',
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

describe('BaseLLMProvider', () => {
  // --------------------------------------------------------------------------
  // constructor
  // --------------------------------------------------------------------------

  describe('constructor', () => {
    test('sets name from config.provider', () => {
      const provider = new TestProvider(makeConfig({ provider: 'openai' }));
      expect(provider.name).toBe('openai');
    });

    test('sets config', () => {
      const config = makeConfig({ model: 'my-model', apiKey: 'my-key' });
      const provider = new TestProvider(config);
      expect(provider.config).toEqual(config);
    });
  });

  // --------------------------------------------------------------------------
  // validate()
  // --------------------------------------------------------------------------

  describe('validate()', () => {
    test('calls validateConfig', () => {
      // Valid config should not throw
      const provider = new TestProvider(
        makeConfig({ provider: 'gemini', apiKey: 'key', model: 'model' })
      );
      expect(() => provider.validate()).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // getModel() — accessed via stream behavior, tested indirectly
  // We can test by creating a subclass that exposes the protected method
  // --------------------------------------------------------------------------

  describe('getModel()', () => {
    class ExposedProvider extends TestProvider {
      public exposedGetModel(options: LLMStreamOptions): string {
        return this.getModel(options);
      }
    }

    test('returns options.model when provided', () => {
      const provider = new ExposedProvider(makeConfig({ model: 'config-model' }));
      const model = provider.exposedGetModel(
        makeStreamOptions({ model: 'options-model' })
      );
      expect(model).toBe('options-model');
    });

    test('falls back to config.model', () => {
      const provider = new ExposedProvider(makeConfig({ model: 'config-model' }));
      const model = provider.exposedGetModel(makeStreamOptions());
      expect(model).toBe('config-model');
    });
  });

  // --------------------------------------------------------------------------
  // getSystemMessage()
  // --------------------------------------------------------------------------

  describe('getSystemMessage()', () => {
    class ExposedProvider extends TestProvider {
      public exposedGetSystemMessage(options: LLMStreamOptions): string | undefined {
        return this.getSystemMessage(options);
      }
    }

    test('returns system message content', () => {
      const provider = new ExposedProvider(makeConfig());
      const systemMsg = provider.exposedGetSystemMessage(
        makeStreamOptions({
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Hello' },
          ],
        })
      );
      expect(systemMsg).toBe('You are a helpful assistant.');
    });

    test('returns undefined when no system message', () => {
      const provider = new ExposedProvider(makeConfig());
      const systemMsg = provider.exposedGetSystemMessage(
        makeStreamOptions({
          messages: [{ role: 'user', content: 'Hello' }],
        })
      );
      expect(systemMsg).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // getNonSystemMessages()
  // --------------------------------------------------------------------------

  describe('getNonSystemMessages()', () => {
    class ExposedProvider extends TestProvider {
      public exposedGetNonSystemMessages(
        options: LLMStreamOptions
      ): Array<{ role: 'user' | 'assistant'; content: string }> {
        return this.getNonSystemMessages(options);
      }
    }

    test('filters out system messages', () => {
      const provider = new ExposedProvider(makeConfig());
      const messages = provider.exposedGetNonSystemMessages(
        makeStreamOptions({
          messages: [
            { role: 'system', content: 'System prompt' },
            { role: 'user', content: 'User message' },
          ],
        })
      );
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('User message');
    });

    test('returns user and assistant messages', () => {
      const provider = new ExposedProvider(makeConfig());
      const messages = provider.exposedGetNonSystemMessages(
        makeStreamOptions({
          messages: [
            { role: 'system', content: 'Be helpful' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi!' },
            { role: 'user', content: 'How are you?' },
          ],
        })
      );
      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(messages[1]).toEqual({ role: 'assistant', content: 'Hi!' });
      expect(messages[2]).toEqual({ role: 'user', content: 'How are you?' });
    });
  });

  // --------------------------------------------------------------------------
  // ensureApiKey()
  // --------------------------------------------------------------------------

  describe('ensureApiKey()', () => {
    class ExposedProvider extends TestProvider {
      public exposedEnsureApiKey(): string {
        return this.ensureApiKey();
      }
    }

    test('returns apiKey when present', () => {
      const provider = new ExposedProvider(makeConfig({ apiKey: 'my-key-123' }));
      expect(provider.exposedEnsureApiKey()).toBe('my-key-123');
    });

    test('throws LLMConfigError when missing', () => {
      const provider = new ExposedProvider(makeConfig({ apiKey: undefined }));
      expect(() => provider.exposedEnsureApiKey()).toThrow(LLMConfigError);
    });
  });

  // --------------------------------------------------------------------------
  // ensureApiUrl()
  // --------------------------------------------------------------------------

  describe('ensureApiUrl()', () => {
    class ExposedProvider extends TestProvider {
      public exposedEnsureApiUrl(): string {
        return this.ensureApiUrl();
      }
    }

    test('returns apiUrl when present', () => {
      const provider = new ExposedProvider(
        makeConfig({ apiUrl: 'https://api.example.com/v1' })
      );
      expect(provider.exposedEnsureApiUrl()).toBe('https://api.example.com/v1');
    });

    test('throws LLMConfigError when missing', () => {
      const provider = new ExposedProvider(makeConfig({ apiUrl: undefined }));
      expect(() => provider.exposedEnsureApiUrl()).toThrow(LLMConfigError);
    });
  });
});
