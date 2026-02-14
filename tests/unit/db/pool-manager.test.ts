import { describe, test, expect } from 'bun:test';
import {
  mergePoolConfig,
  validatePoolConfig,
  withTimeout,
  formatBytes,
  formatDuration,
  escapeIdentifier,
} from '@/lib/db/utils/pool-manager';
import { TimeoutError } from '@/lib/db/errors';
import { DEFAULT_POOL_CONFIG, type PoolConfig } from '@/lib/db/types';

// ============================================================================
// mergePoolConfig
// ============================================================================

describe('mergePoolConfig', () => {
  test('returns defaults when no argument provided', () => {
    const config = mergePoolConfig();
    expect(config).toEqual(DEFAULT_POOL_CONFIG);
    expect(config.min).toBe(2);
    expect(config.max).toBe(10);
    expect(config.idleTimeout).toBe(30000);
    expect(config.acquireTimeout).toBe(60000);
  });

  test('partial override merges with defaults', () => {
    const config = mergePoolConfig({ max: 20 });
    expect(config.min).toBe(2);
    expect(config.max).toBe(20);
    expect(config.idleTimeout).toBe(30000);
    expect(config.acquireTimeout).toBe(60000);
  });

  test('full override replaces all defaults', () => {
    const custom: PoolConfig = {
      min: 5,
      max: 50,
      idleTimeout: 10000,
      acquireTimeout: 30000,
    };
    const config = mergePoolConfig(custom);
    expect(config).toEqual(custom);
  });
});

// ============================================================================
// validatePoolConfig
// ============================================================================

describe('validatePoolConfig', () => {
  test('valid config passes without throwing', () => {
    expect(() => validatePoolConfig({
      min: 2, max: 10, idleTimeout: 30000, acquireTimeout: 60000,
    })).not.toThrow();
  });

  test('min=0 is valid (non-negative)', () => {
    expect(() => validatePoolConfig({
      min: 0, max: 10, idleTimeout: 30000, acquireTimeout: 60000,
    })).not.toThrow();
  });

  test('min < 0 throws', () => {
    expect(() => validatePoolConfig({
      min: -1, max: 10, idleTimeout: 30000, acquireTimeout: 60000,
    })).toThrow('Pool min must be non-negative');
  });

  test('max < 1 throws', () => {
    expect(() => validatePoolConfig({
      min: 0, max: 0, idleTimeout: 30000, acquireTimeout: 60000,
    })).toThrow('Pool max must be at least 1');
  });

  test('min > max throws', () => {
    expect(() => validatePoolConfig({
      min: 15, max: 10, idleTimeout: 30000, acquireTimeout: 60000,
    })).toThrow('Pool min cannot be greater than max');
  });

  test('negative idleTimeout throws', () => {
    expect(() => validatePoolConfig({
      min: 2, max: 10, idleTimeout: -1, acquireTimeout: 60000,
    })).toThrow('Pool idleTimeout must be non-negative');
  });

  test('negative acquireTimeout throws', () => {
    expect(() => validatePoolConfig({
      min: 2, max: 10, idleTimeout: 30000, acquireTimeout: -1,
    })).toThrow('Pool acquireTimeout must be non-negative');
  });
});

// ============================================================================
// withTimeout
// ============================================================================

describe('withTimeout', () => {
  test('resolves when promise completes before timeout', async () => {
    const promise = Promise.resolve('done');
    const result = await withTimeout(promise, 1000, 'postgres', 'test-op');
    expect(result).toBe('done');
  });

  test('rejects with TimeoutError when promise exceeds timeout', async () => {
    const slowPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve('too late'), 500);
    });

    try {
      await withTimeout(slowPromise, 10, 'postgres', 'test-op');
      expect(true).toBe(false); // should not reach
    } catch (error) {
      expect(error).toBeInstanceOf(TimeoutError);
      expect((error as TimeoutError).message).toContain('test-op');
      expect((error as TimeoutError).message).toContain('timed out');
    }
  });

  test('original error propagates if promise rejects before timeout', async () => {
    const failingPromise = Promise.reject(new Error('original failure'));

    try {
      await withTimeout(failingPromise, 5000, 'mysql', 'test-op');
      expect(true).toBe(false); // should not reach
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('original failure');
    }
  });
});

// ============================================================================
// formatBytes
// ============================================================================

describe('formatBytes', () => {
  test('0 bytes returns "0 B"', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  test('1024 bytes returns "1 KB"', () => {
    expect(formatBytes(1024)).toBe('1 KB');
  });

  test('1536 bytes returns "1.5 KB"', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  test('1048576 bytes returns "1 MB"', () => {
    expect(formatBytes(1048576)).toBe('1 MB');
  });

  test('1073741824 bytes returns "1 GB"', () => {
    expect(formatBytes(1073741824)).toBe('1 GB');
  });

  test('1099511627776 bytes returns "1 TB"', () => {
    expect(formatBytes(1099511627776)).toBe('1 TB');
  });
});

// ============================================================================
// formatDuration
// ============================================================================

describe('formatDuration', () => {
  test('50ms returns "50ms"', () => {
    expect(formatDuration(50)).toBe('50ms');
  });

  test('999ms returns "999ms"', () => {
    expect(formatDuration(999)).toBe('999ms');
  });

  test('1500ms returns "1.50s"', () => {
    expect(formatDuration(1500)).toBe('1.50s');
  });

  test('90000ms returns "1.50m"', () => {
    expect(formatDuration(90000)).toBe('1.50m');
  });

  test('7200000ms returns "2.00h"', () => {
    expect(formatDuration(7200000)).toBe('2.00h');
  });
});

// ============================================================================
// escapeIdentifier
// ============================================================================

describe('escapeIdentifier', () => {
  test('postgres wraps in double quotes', () => {
    expect(escapeIdentifier('users', 'postgres')).toBe('"users"');
  });

  test('mysql wraps in backticks', () => {
    expect(escapeIdentifier('users', 'mysql')).toBe('`users`');
  });

  test('sqlite wraps in double quotes', () => {
    expect(escapeIdentifier('users', 'sqlite')).toBe('"users"');
  });

  test('default (unknown provider) wraps in double quotes', () => {
    expect(escapeIdentifier('users', 'mongodb')).toBe('"users"');
  });

  test('strips existing quotes from identifier', () => {
    expect(escapeIdentifier('"my_table"', 'postgres')).toBe('"my_table"');
    expect(escapeIdentifier('`my_table`', 'mysql')).toBe('`my_table`');
    expect(escapeIdentifier("'my_table'", 'sqlite')).toBe('"my_table"');
  });
});
