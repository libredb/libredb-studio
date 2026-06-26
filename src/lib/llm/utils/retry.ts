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
  } = options;

  let lastError: Error | undefined;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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

      // Wait before retrying
      await sleep(delay);

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
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
