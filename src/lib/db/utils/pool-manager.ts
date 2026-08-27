/**
 * Connection Pool Manager
 * Abstract pool management utilities for database providers
 */

import { type PoolConfig, DEFAULT_POOL_CONFIG, type DatabaseType } from "../types";
import { TimeoutError } from "../errors";

// ============================================================================
// Pool Configuration Utilities
// ============================================================================

/**
 * Merge user config with defaults
 */
export function mergePoolConfig(config?: Partial<PoolConfig>): PoolConfig {
  return {
    ...DEFAULT_POOL_CONFIG,
    ...config,
  };
}

/**
 * Validate pool configuration
 */
export function validatePoolConfig(config: PoolConfig): void {
  if (config.min < 0) {
    throw new Error("Pool min must be non-negative");
  }
  if (config.max < 1) {
    throw new Error("Pool max must be at least 1");
  }
  if (config.min > config.max) {
    throw new Error("Pool min cannot be greater than max");
  }
  if (config.idleTimeout < 0) {
    throw new Error("Pool idleTimeout must be non-negative");
  }
  if (config.acquireTimeout < 0) {
    throw new Error("Pool acquireTimeout must be non-negative");
  }
}

// ============================================================================
// Timeout Utilities
// ============================================================================

/**
 * Execute a promise with timeout
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeout: number,
  provider: DatabaseType,
  operation: string,
): Promise<T> {
  let timeoutId: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TimeoutError(`${operation} timed out after ${timeout}ms`, provider, timeout));
    }, timeout);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

/**
 * Create a cancellable query wrapper
 */
export function createCancellableQuery<T>(
  queryFn: (signal?: AbortSignal) => Promise<T>,
  timeout: number,
  provider: DatabaseType,
): { promise: Promise<T>; cancel: () => void } {
  const controller = new AbortController();
  let timeoutId: NodeJS.Timeout;

  const promise = new Promise<T>((resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(`Query timed out after ${timeout}ms`, provider, timeout));
    }, timeout);

    queryFn(controller.signal)
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(timeoutId));
  });

  return {
    promise,
    cancel: () => {
      clearTimeout(timeoutId);
      controller.abort();
    },
  };
}

// ============================================================================
// Connection Health Check
// ============================================================================

/**
 * Simple ping-like health check
 */
export async function checkConnectionHealth<T>(
  acquireFn: () => Promise<T>,
  releaseFn: (conn: T) => void,
  pingFn: (conn: T) => Promise<void>,
  timeout: number,
  provider: DatabaseType,
): Promise<boolean> {
  try {
    const conn = await withTimeout(acquireFn(), timeout, provider, "Connection acquire");

    try {
      await withTimeout(pingFn(conn), timeout, provider, "Connection ping");
      return true;
    } finally {
      releaseFn(conn);
    }
  } catch {
    return false;
  }
}

// ============================================================================
// Retry Logic
// ============================================================================

export interface RetryOptions {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 10000,
  backoffMultiplier: 2,
};

/**
 * Execute with retry logic and exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
  isRetryable: (error: unknown) => boolean = () => true,
  provider?: DatabaseType,
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error | undefined;
  let delay = opts.initialDelay;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (!isRetryable(error) || attempt === opts.maxAttempts) {
        throw error;
      }

      console.error(
        `[DB${provider ? `:${provider}` : ""}] Operation failed (attempt ${attempt}/${opts.maxAttempts}): ${lastError.message}. Retrying in ${delay}ms...`,
      );

      await sleep(delay);
      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelay);
    }
  }

  // Reached only when maxAttempts < 1 skipped the retry loop entirely; every
  // in-loop path either returns or rethrows the original error.
  throw lastError ?? new RangeError(`maxAttempts must be >= 1, got ${opts.maxAttempts}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// SQL Utilities
// ============================================================================

/**
 * Escape SQL identifier (table name, column name)
 * Prevents SQL injection in dynamic queries
 */
export function escapeIdentifier(identifier: string, provider: DatabaseType): string {
  // Remove any existing quotes and escape internal quotes
  const cleaned = identifier.replace(/["'`]/g, "");

  switch (provider) {
    case "postgres":
      return `"${cleaned}"`;
    case "mysql":
      return `\`${cleaned}\``;
    case "sqlite":
      return `"${cleaned}"`;
  }
  return `"${cleaned}"`;
}

/**
 * Format bytes to human readable size.
 *
 * A negative or non-finite input is not a magnitude, so it is refused as "N/A"
 * rather than drawn as a figure. All five of -1, -1536, NaN, Infinity and
 * -Infinity measured as the literal "NaN undefined" before this guard, by two
 * different routes: `Math.log` is NaN for a negative and for NaN, so the unit
 * index is NaN, while `Math.log(Infinity)` is Infinity, so the index is Infinity
 * — either way it lands outside the array and the division reduces to NaN. "N/A"
 * is the string this codebase already uses for a size it does not have (see the
 * `databaseSize` arms of MongoDBProvider.getHealth). A real 0 stays "0 B"
 * because zero bytes IS a measurement, and `-0` reaches that arm first
 * (`-0 === 0` is true), so it never sees the refusal below.
 *
 * The ladder gains PB and EB, and the index is CLAMPED to its end. Two rungs is
 * a judgement, the clamp is the guarantee: a byte count stops being an exact
 * integer in a double at 2^53, which is 8 PB, so rungs past EB would spell
 * magnitudes the input can no longer carry - and a double stays finite up to
 * 1024^102 (measured), so no ladder length can outrun the input range. Without
 * the clamp a petabyte read as "1 undefined" - a number wearing a missing unit,
 * which scans as a figure rather than as garbage - and so did every larger
 * input. ClickHouseProvider's OVERVIEW_SIZE_SQL sums bytes_on_disk over every
 * active part of the current database, so PB-scale inputs are reachable.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (!Number.isFinite(bytes) || bytes < 0) return "N/A";

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Format duration in milliseconds to human readable
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(2)}m`;
  return `${(ms / 3600000).toFixed(2)}h`;
}
