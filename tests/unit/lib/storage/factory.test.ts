import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  getStorageProviderType,
  isServerStorageEnabled,
  getStorageConfig,
  getStorageProvider,
  closeStorageProvider,
} from '@/lib/storage/factory';

// Clean env before every test to prevent leakage
beforeEach(async () => {
  await closeStorageProvider();
  delete process.env.STORAGE_PROVIDER;
});

afterEach(async () => {
  await closeStorageProvider();
  delete process.env.STORAGE_PROVIDER;
});

describe('storage factory: getStorageProviderType', () => {
  test('returns "local" when STORAGE_PROVIDER not set', () => {
    expect(getStorageProviderType()).toBe('local');
  });

  test('returns "local" for empty string', () => {
    process.env.STORAGE_PROVIDER = '';
    expect(getStorageProviderType()).toBe('local');
  });

  test('returns "sqlite" when STORAGE_PROVIDER=sqlite', () => {
    process.env.STORAGE_PROVIDER = 'sqlite';
    expect(getStorageProviderType()).toBe('sqlite');
  });

  test('returns "postgres" when STORAGE_PROVIDER=postgres', () => {
    process.env.STORAGE_PROVIDER = 'postgres';
    expect(getStorageProviderType()).toBe('postgres');
  });

  test('returns "local" for unknown values', () => {
    process.env.STORAGE_PROVIDER = 'redis';
    expect(getStorageProviderType()).toBe('local');
  });

  test('is case-insensitive', () => {
    process.env.STORAGE_PROVIDER = 'SQLite';
    expect(getStorageProviderType()).toBe('sqlite');
  });
});

describe('storage factory: isServerStorageEnabled', () => {
  test('returns false when local', () => {
    expect(isServerStorageEnabled()).toBe(false);
  });

  test('returns true for sqlite', () => {
    process.env.STORAGE_PROVIDER = 'sqlite';
    expect(isServerStorageEnabled()).toBe(true);
  });

  test('returns true for postgres', () => {
    process.env.STORAGE_PROVIDER = 'postgres';
    expect(isServerStorageEnabled()).toBe(true);
  });
});

describe('storage factory: getStorageConfig', () => {
  test('returns correct shape for local', () => {
    const config = getStorageConfig();
    expect(config).toEqual({ provider: 'local', serverMode: false });
  });

  test('returns correct shape for sqlite', () => {
    process.env.STORAGE_PROVIDER = 'sqlite';
    const config = getStorageConfig();
    expect(config).toEqual({ provider: 'sqlite', serverMode: true });
  });
});

describe('storage factory: getStorageProvider (local paths)', () => {
  test('returns null when STORAGE_PROVIDER=local', async () => {
    process.env.STORAGE_PROVIDER = 'local';
    const provider = await getStorageProvider();
    expect(provider).toBeNull();
  });

  test('returns null when STORAGE_PROVIDER is not set', async () => {
    const provider = await getStorageProvider();
    expect(provider).toBeNull();
  });
});

describe('storage factory: closeStorageProvider (no-op path)', () => {
  test('does nothing when no provider exists', async () => {
    // Should not throw when called with no active provider
    await expect(closeStorageProvider()).resolves.toBeUndefined();
  });
});
