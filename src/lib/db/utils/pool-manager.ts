/**
 * Connection Pool Manager
 * Abstract pool management utilities for database providers
 */

import { type PoolConfig, DEFAULT_POOL_CONFIG, type DatabaseType } from '../types';
import { TimeoutError } from '../errors';

// ============================================================================
// Pool Statistics
// ============================================================================

export interface PoolStats {
  /** Total connections in pool */
  total: number;
  /** Currently idle connections */
  idle: number;
  /** Currently active/busy connections */
  active: number;
  /** Connections waiting in queue */
  waiting: number;
}

// ============================================================================
// Pool Manager Interface
// ============================================================================

export interface PoolManager<T> {
  /** Acquire a connection from the pool */
  acquire(): Promise<T>;
  /** Release a connection back to the pool */
  release(connection: T): void;
  /** Get pool statistics */
  getStats(): PoolStats;
  /** Drain all connections and close pool */
  drain(): Promise<void>;
  /** Check if pool is healthy */
  isHealthy(): boolean;
}

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
    throw new Error('Pool min must be non-negative');
  }
  if (config.max < 1) {
    throw new Error('Pool max must be at least 1');
  }
  if (config.min > config.max) {
    throw new Error('Pool min cannot be greater than max');
  }
  if (config.idleTimeout < 0) {
    throw new Error('Pool idleTimeout must be non-negative');
  }
  if (config.acquireTimeout < 0) {
    throw new Error('Pool acquireTimeout must be non-negative');
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
  operation: string
): Promise<T> {
  let timeoutId: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TimeoutError(
        `${operation} timed out after ${timeout}ms`,
        provider,
        timeout
      ));
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
  provider: DatabaseType
): { promise: Promise<T>; cancel: () => void } {
  const controller = new AbortController();
  let timeoutId: NodeJS.Timeout;

  const promise = new Promise<T>((resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(
        `Query timed out after ${timeout}ms`,
        provider,
        timeout
      ));
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
  provider: DatabaseType
): Promise<boolean> {
  try {
    const conn = await withTimeout(
      acquireFn(),
      timeout,
      provider,
      'Connection acquire'
    );

    try {
      await withTimeout(
        pingFn(conn),
        timeout,
        provider,
        'Connection ping'
      );
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
  provider?: DatabaseType
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
        `[DB${provider ? `:${provider}` : ''}] Operation failed (attempt ${attempt}/${opts.maxAttempts}): ${lastError.message}. Retrying in ${delay}ms...`
      );

      await sleep(delay);
      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelay);
    }
  }

  throw lastError;
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
  const cleaned = identifier.replace(/["'`]/g, '');

  switch (provider) {
    case 'postgres':
      return `"${cleaned}"`;
    case 'mysql':
      return `\`${cleaned}\``;
    case 'sqlite':
      return `"${cleaned}"`;
    default:
      return `"${cleaned}"`;
  }
}

/**
 * Format bytes to human readable size
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

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
