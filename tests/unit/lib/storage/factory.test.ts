import { describe, test, expect, beforeEach } from 'bun:test';
import {
  getStorageProviderType,
  isServerStorageEnabled,
  getStorageConfig,
} from '@/lib/storage/factory';

// Clean env before every test to prevent leakage
beforeEach(() => {
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
