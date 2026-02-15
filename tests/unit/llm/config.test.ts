import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  resolveConfig,
  validateConfig,
  requiresApiKey,
  requiresApiUrl,
  getSafeConfigForLogging,
  DEFAULT_MODELS,
  DEFAULT_API_URLS,
} from '@/lib/llm/utils/config';
import { LLMConfigError } from '@/lib/llm/types';

// ============================================================================
// Environment Variable Helpers
// ============================================================================

let savedEnv: Record<string, string | undefined>;

const LLM_ENV_KEYS = ['LLM_PROVIDER', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_API_URL'];

beforeEach(() => {
  savedEnv = {};
  for (const key of LLM_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of LLM_ENV_KEYS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
});

// ============================================================================
// resolveConfig
// ============================================================================

describe('resolveConfig', () => {
  test('defaults to gemini provider with default model when no env vars set', () => {
    const config = resolveConfig();
    expect(config.provider).toBe('gemini');
    expect(config.model).toBe(DEFAULT_MODELS.gemini);
  });

  test('reads provider from LLM_PROVIDER env var', () => {
    process.env.LLM_PROVIDER = 'openai';
    const config = resolveConfig();
    expect(config.provider).toBe('openai');
  });

  test('reads apiKey from LLM_API_KEY env var', () => {
    process.env.LLM_API_KEY = 'sk-test-key';
    const config = resolveConfig();
    expect(config.apiKey).toBe('sk-test-key');
  });

  test('reads model from LLM_MODEL env var', () => {
    process.env.LLM_MODEL = 'gpt-4-turbo';
    const config = resolveConfig();
    expect(config.model).toBe('gpt-4-turbo');
  });

  test('reads apiUrl from LLM_API_URL env var', () => {
    process.env.LLM_API_URL = 'https://custom.api.com/v1';
    const config = resolveConfig();
    expect(config.apiUrl).toBe('https://custom.api.com/v1');
  });

  test('overrides take precedence over env vars', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.LLM_API_KEY = 'env-key';
    process.env.LLM_MODEL = 'env-model';

    const config = resolveConfig({
      provider: 'ollama',
      apiKey: 'override-key',
      model: 'override-model',
    });

    expect(config.provider).toBe('ollama');
    expect(config.apiKey).toBe('override-key');
    expect(config.model).toBe('override-model');
  });

  test('invalid provider falls back to default (gemini)', () => {
    process.env.LLM_PROVIDER = 'invalid-provider';
    // Suppress console.error for this test
    const originalError = console.error;
    console.error = () => {};
    const config = resolveConfig();
    console.error = originalError;

    expect(config.provider).toBe('gemini');
  });

  test('ollama gets default URL when LLM_API_URL is not set', () => {
    process.env.LLM_PROVIDER = 'ollama';
    const config = resolveConfig();
    expect(config.apiUrl).toBe(DEFAULT_API_URLS.ollama);
  });

  test('openai gets default URL when LLM_API_URL is not set', () => {
    process.env.LLM_PROVIDER = 'openai';
    const config = resolveConfig();
    expect(config.apiUrl).toBe(DEFAULT_API_URLS.openai);
  });

  test('provider-specific default model is used when LLM_MODEL is not set', () => {
    process.env.LLM_PROVIDER = 'ollama';
    const config = resolveConfig();
    expect(config.model).toBe(DEFAULT_MODELS.ollama);
  });
});

// ============================================================================
// validateConfig
// ============================================================================

describe('validateConfig', () => {
  test('valid gemini config with key passes', () => {
    expect(() => validateConfig({
      provider: 'gemini',
      apiKey: 'test-key',
      model: 'gemini-2.5-flash',
    })).not.toThrow();
  });

  test('gemini without apiKey throws LLMConfigError', () => {
    expect(() => validateConfig({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
    })).toThrow(LLMConfigError);
  });

  test('openai without apiKey throws LLMConfigError', () => {
    expect(() => validateConfig({
      provider: 'openai',
      model: 'gpt-4o',
    })).toThrow(LLMConfigError);
  });

  test('custom without apiUrl throws LLMConfigError', () => {
    expect(() => validateConfig({
      provider: 'custom',
      model: 'my-model',
    })).toThrow(LLMConfigError);
  });

  test('invalid provider throws LLMConfigError', () => {
    expect(() => validateConfig({
      provider: 'invalid' as unknown as 'gemini',
      model: 'some-model',
    })).toThrow(LLMConfigError);
  });

  test('empty model throws LLMConfigError', () => {
    expect(() => validateConfig({
      provider: 'ollama',
      model: '',
    })).toThrow(LLMConfigError);
  });

  test('whitespace-only model throws LLMConfigError', () => {
    expect(() => validateConfig({
      provider: 'ollama',
      model: '   ',
    })).toThrow(LLMConfigError);
  });

  test('ollama without apiKey passes validation', () => {
    expect(() => validateConfig({
      provider: 'ollama',
      model: 'llama3.2',
    })).not.toThrow();
  });

  test('custom with apiUrl passes validation', () => {
    expect(() => validateConfig({
      provider: 'custom',
      model: 'my-model',
      apiUrl: 'https://custom.api.com/v1',
    })).not.toThrow();
  });
});

// ============================================================================
// requiresApiKey
// ============================================================================

describe('requiresApiKey', () => {
  test('gemini requires API key', () => {
    expect(requiresApiKey('gemini')).toBe(true);
  });

  test('openai requires API key', () => {
    expect(requiresApiKey('openai')).toBe(true);
  });

  test('ollama does not require API key', () => {
    expect(requiresApiKey('ollama')).toBe(false);
  });

  test('custom does not require API key', () => {
    expect(requiresApiKey('custom')).toBe(false);
  });
});

// ============================================================================
// requiresApiUrl
// ============================================================================

describe('requiresApiUrl', () => {
  test('custom requires API URL', () => {
    expect(requiresApiUrl('custom')).toBe(true);
  });

  test('gemini does not require API URL', () => {
    expect(requiresApiUrl('gemini')).toBe(false);
  });

  test('openai does not require API URL', () => {
    expect(requiresApiUrl('openai')).toBe(false);
  });

  test('ollama does not require API URL', () => {
    expect(requiresApiUrl('ollama')).toBe(false);
  });
});

// ============================================================================
// getSafeConfigForLogging
// ============================================================================

describe('getSafeConfigForLogging', () => {
  test('masks apiKey with "***"', () => {
    const safe = getSafeConfigForLogging({
      provider: 'openai',
      apiKey: 'sk-super-secret-key',
      model: 'gpt-4o',
      apiUrl: 'https://api.openai.com/v1',
    });

    expect(safe.provider).toBe('openai');
    expect(safe.model).toBe('gpt-4o');
    expect(safe.apiUrl).toBe('https://api.openai.com/v1');
    expect(safe.apiKey).toBe('***');
  });

  test('undefined apiKey stays undefined', () => {
    const safe = getSafeConfigForLogging({
      provider: 'ollama',
      model: 'llama3.2',
    });

    expect(safe.apiKey).toBeUndefined();
  });
});
