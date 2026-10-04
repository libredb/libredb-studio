/**
 * Retry Utility with Exponential Backoff
 * Handles transient failures in LLM API calls
 */

import { isRetryableError, LLMError, type LLMProviderType } from "../types";

// ============================================================================
// Types
// ============================================================================

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay in milliseconds (default: 1000) */
  initialDelay?: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;
  /** Maximum delay in milliseconds (default: 10000) */
  maxDelay?: number;
  /** Provider name for logging */
  provider?: LLMProviderType;
  /** Operation name for logging */
  operation?: string;
  /**
   * The caller's abort signal. Once it has aborted, a failure is the abort and not a transient fault,
   * so it is thrown at once instead of being retried after a backoff.
   */
  signal?: AbortSignal;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY = 1000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_MAX_DELAY = 10000;

// ============================================================================
// Retry Implementation
// ============================================================================

/**
 * Execute a function with retry logic and exponential backoff
 * @param fn - Async function to execute
 * @param options - Retry configuration
 * @returns Result of the function
 * @throws Last error if all retries fail
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    initialDelay = DEFAULT_INITIAL_DELAY,
    backoffMultiplier = DEFAULT_BACKOFF_MULTIPLIER,
    maxDelay = DEFAULT_MAX_DELAY,
    provider,
    operation = "LLM request",
    signal,
  } = options;

  let lastError: Error | undefined;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Checked before every attempt, not left to `fn`: the Gemini SDK (0.24.1) listens for the abort event and
    // never reads `aborted`, so a request handed a signal that already aborted is sent, unbounded.
    if (signal?.aborted) throw lastError ?? signal.reason;
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if error is retryable
      if (!isRetryableError(error)) {
        throw error;
      }

      // Don't retry on last attempt
      if (attempt === maxAttempts) {
        break;
      }

      // Log retry attempt
      console.error(
        `[LLM${provider ? `:${provider}` : ""}] ${operation} failed (attempt ${attempt}/${maxAttempts}): ${lastError.message}. Retrying in ${delay}ms...`,
      );

      // Wait before retrying. An abort ends the wait early, and the check at the top of the loop then ends the
      // retries with the error this attempt raised.
      await sleep(delay, signal);

      // Increase delay with exponential backoff
      delay = Math.min(delay * backoffMultiplier, maxDelay);
    }
  }

  // All retries exhausted
  console.error(
    `[LLM${provider ? `:${provider}` : ""}] ${operation} failed after ${maxAttempts} attempts: ${lastError?.message}`,
  );

  throw lastError ?? new LLMError("Unknown error during retry", provider);
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

// ============================================================================
// Retry Decorators (for class methods)
// ============================================================================

/**
 * Create a retryable version of an async function
 */
export function makeRetryable<T extends unknown[], R>(
  fn: (...args: T) => Promise<R>,
  options: RetryOptions = {},
): (...args: T) => Promise<R> {
  return (...args: T) => withRetry(() => fn(...args), options);
}
