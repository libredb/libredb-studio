/**
 * Factory singleton tests — isolated process required.
 * Mocks provider modules to test getStorageProvider() and closeStorageProvider()
 * without real database connections.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';

// ── Mock providers ──────────────────────────────────────────────────────────

const mockInitialize = mock(async () => {});
const mockClose = mock(async () => {});
const mockGetAllData = mock(async () => ({}));

function makeMockProvider() {
  return {
    initialize: mockInitialize,
    close: mockClose,
    getAllData: mockGetAllData,
    getCollection: mock(async () => null),
    setCollection: mock(async () => {}),
    mergeData: mock(async () => {}),
    isHealthy: mock(async () => true),
  };
}

const mockSQLiteInstance = makeMockProvider();
const mockPostgresInstance = makeMockProvider();

mock.module('@/lib/storage/providers/sqlite', () => ({
  SQLiteStorageProvider: mock(() => mockSQLiteInstance),
}));

mock.module('@/lib/storage/providers/postgres', () => ({
  PostgresStorageProvider: mock(() => mockPostgresInstance),
}));

// Import factory AFTER mocking providers
import {
  getStorageProvider,
  closeStorageProvider,
  getStorageProviderType,
} from '@/lib/storage/factory';

// ── Tests ───────────────────────────────────────────────────────────────────

describe('factory: getStorageProvider', () => {
  beforeEach(async () => {
    // Reset singleton state between tests
    await closeStorageProvider();
    mockInitialize.mockClear();
    mockClose.mockClear();
    delete process.env.STORAGE_PROVIDER;
  });

  test('returns null when STORAGE_PROVIDER is local', async () => {
    process.env.STORAGE_PROVIDER = 'local';
    const provider = await getStorageProvider();
    expect(provider).toBeNull();
  });

  test('returns null when STORAGE_PROVIDER is not set', async () => {
    const provider = await getStorageProvider();
    expect(provider).toBeNull();
  });

  test('creates SQLite provider when STORAGE_PROVIDER=sqlite', async () => {
    process.env.STORAGE_PROVIDER = 'sqlite';
    const provider = await getStorageProvider();

    expect(provider).not.toBeNull();
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  test('creates Postgres provider when STORAGE_PROVIDER=postgres', async () => {
    process.env.STORAGE_PROVIDER = 'postgres';
    const provider = await getStorageProvider();

    expect(provider).not.toBeNull();
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  test('returns same instance on second call (singleton)', async () => {
    process.env.STORAGE_PROVIDER = 'sqlite';
    const first = await getStorageProvider();
    const second = await getStorageProvider();

    expect(first).toBe(second);
    // initialize called only once, not twice
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  test('calls initialize() on first creation', async () => {
    process.env.STORAGE_PROVIDER = 'sqlite';
    await getStorageProvider();

    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  test('propagates error when initialize() throws', async () => {
    process.env.STORAGE_PROVIDER = 'sqlite';
    mockInitialize.mockRejectedValueOnce(new Error('DB init failed'));

    await expect(getStorageProvider()).rejects.toThrow('DB init failed');
  });
});

describe('factory: closeStorageProvider', () => {
  beforeEach(async () => {
    await closeStorageProvider();
    mockInitialize.mockClear();
    mockClose.mockClear();
    delete process.env.STORAGE_PROVIDER;
  });

  test('closes and resets singleton', async () => {
    process.env.STORAGE_PROVIDER = 'sqlite';
    await getStorageProvider();

    await closeStorageProvider();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  test('creates new instance after close + re-get', async () => {
    process.env.STORAGE_PROVIDER = 'sqlite';
    await getStorageProvider();
    await closeStorageProvider();

    mockInitialize.mockClear();
    const provider = await getStorageProvider();

    expect(provider).not.toBeNull();
    // New initialize call — fresh instance
    expect(mockInitialize).toHaveBeenCalledTimes(1);
  });

  test('does not throw when called without active provider', async () => {
    await expect(closeStorageProvider()).resolves.toBeUndefined();
    expect(mockClose).not.toHaveBeenCalled();
  });

  test('double close does not throw', async () => {
    process.env.STORAGE_PROVIDER = 'sqlite';
    await getStorageProvider();

    await closeStorageProvider();
    await expect(closeStorageProvider()).resolves.toBeUndefined();
    // close called only once (second call has no provider)
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});
