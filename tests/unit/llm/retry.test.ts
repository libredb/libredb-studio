import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { withRetry, makeRetryable } from '@/lib/llm/utils/retry';
import { LLMConfigError, LLMRateLimitError } from '@/lib/llm/types';

// Suppress console.error output during retry tests
let originalConsoleError: typeof console.error;

beforeEach(() => {
  originalConsoleError = console.error;
  console.error = () => {};
});

afterEach(() => {
  console.error = originalConsoleError;
});

// ============================================================================
// withRetry
// ============================================================================

describe('withRetry', () => {
  test('returns result on first successful attempt', async () => {
    const fn = mock(() => Promise.resolve('success'));

    const result = await withRetry(fn, {
      maxAttempts: 3,
      initialDelay: 1,
      maxDelay: 5,
    });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on retryable error and succeeds on second attempt', async () => {
    let attempts = 0;
    const fn = mock(async () => {
      attempts++;
      if (attempts === 1) {
        throw new LLMRateLimitError('rate limited', 'openai');
      }
      return 'success after retry';
    });

    const result = await withRetry(fn, {
      maxAttempts: 3,
      initialDelay: 1,
      maxDelay: 5,
    });

    expect(result).toBe('success after retry');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('throws last error after all retries exhausted', async () => {
    const fn = mock(async () => {
      throw new LLMRateLimitError('rate limited', 'openai');
    });

    try {
      await withRetry(fn, {
        maxAttempts: 3,
        initialDelay: 1,
        maxDelay: 5,
      });
      expect(true).toBe(false); // should not reach
    } catch (error) {
      expect(error).toBeInstanceOf(LLMRateLimitError);
      expect(fn).toHaveBeenCalledTimes(3);
    }
  });

  test('throws immediately for non-retryable error without retrying', async () => {
    const fn = mock(async () => {
      throw new LLMConfigError('invalid config', 'gemini');
    });

    try {
      await withRetry(fn, {
        maxAttempts: 3,
        initialDelay: 1,
        maxDelay: 5,
      });
      expect(true).toBe(false); // should not reach
    } catch (error) {
      expect(error).toBeInstanceOf(LLMConfigError);
      // Non-retryable errors should cause immediate throw
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  test('maxAttempts=1 means no retry', async () => {
    const fn = mock(async () => {
      throw new LLMRateLimitError('rate limited', 'openai');
    });

    try {
      await withRetry(fn, {
        maxAttempts: 1,
        initialDelay: 1,
        maxDelay: 5,
      });
      expect(true).toBe(false); // should not reach
    } catch (error) {
      expect(error).toBeInstanceOf(LLMRateLimitError);
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  test('plain Error (non-LLM) is not retried', async () => {
    const fn = mock(async () => {
      throw new Error('generic error');
    });

    try {
      await withRetry(fn, {
        maxAttempts: 3,
        initialDelay: 1,
        maxDelay: 5,
      });
      expect(true).toBe(false);
    } catch (error) {
      expect((error as Error).message).toBe('generic error');
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });
});

// ============================================================================
// makeRetryable
// ============================================================================

describe('makeRetryable', () => {
  test('wraps function with retry and passes arguments through', async () => {
    const fn = mock(async (a: number, b: string) => `${b}-${a}`);

    const retryable = makeRetryable(fn, {
      maxAttempts: 3,
      initialDelay: 1,
      maxDelay: 5,
    });

    const result = await retryable(42, 'hello');
    expect(result).toBe('hello-42');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries the wrapped function on retryable failure', async () => {
    let attempts = 0;
    const fn = async (value: string): Promise<string> => {
      attempts++;
      if (attempts === 1) {
        throw new LLMRateLimitError('rate limited');
      }
      return `result-${value}`;
    };

    const retryable = makeRetryable(fn, {
      maxAttempts: 3,
      initialDelay: 1,
      maxDelay: 5,
    });

    const result = await retryable('test');
    expect(result).toBe('result-test');
    expect(attempts).toBe(2);
  });

  test('returns a function with the same argument types', async () => {
    const fn = async (x: number, y: number): Promise<number> => x + y;

    const retryable = makeRetryable(fn, {
      maxAttempts: 2,
      initialDelay: 1,
    });

    const result = await retryable(3, 7);
    expect(result).toBe(10);
  });
});
