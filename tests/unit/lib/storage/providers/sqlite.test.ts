import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { ServerStorageProvider } from '@/lib/storage/types';

// ── Mock better-sqlite3 ─────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockPrepare = mock((): any => ({
  all: mock((): any[] => []),
  get: mock((): any => undefined),
  run: mock((..._args: any[]) => {}),
}));
const mockExec = mock((..._args: any[]) => {});
const mockPragma = mock((..._args: any[]) => {});
const mockClose = mock(() => {});

const mockDbInstance = {
  prepare: mockPrepare,
  exec: mockExec,
  pragma: mockPragma,
  close: mockClose,
  transaction: mock((fn: () => void) => fn),
};

mock.module('better-sqlite3', () => ({
  default: mock(() => mockDbInstance),
}));

// Mock fs and path for directory creation
mock.module('fs', () => ({
  existsSync: mock(() => true),
  mkdirSync: mock(() => {}),
}));

mock.module('path', () => ({
  dirname: mock((p: string) => p.replace(/\/[^/]*$/, '')),
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

import { SQLiteStorageProvider } from '@/lib/storage/providers/sqlite';

describe('SQLiteStorageProvider', () => {
  let provider: ServerStorageProvider;

  beforeEach(() => {
    mockPrepare.mockClear();
    mockExec.mockClear();
    mockPragma.mockClear();
    mockClose.mockClear();
    provider = new SQLiteStorageProvider(':memory:');
  });

  afterEach(async () => {
    await provider.close();
  });

  test('initialize creates table and enables WAL', async () => {
    await provider.initialize();
    expect(mockPragma).toHaveBeenCalledWith('journal_mode = WAL');
    expect(mockExec).toHaveBeenCalledTimes(1);
    const sql = (mockExec.mock.calls as unknown[][])[0][0] as string;
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS user_storage');
  });

  test('getAllData returns parsed collections', async () => {
    const mockRows = [
      { collection: 'connections', data: JSON.stringify([{ id: 'c1' }]) },
      { collection: 'history', data: JSON.stringify([{ id: 'h1' }]) },
    ];
    mockPrepare.mockReturnValue({
      all: mock(() => mockRows),
      get: mock(() => undefined),
      run: mock(() => {}),
    });

    await provider.initialize();
    const result = await provider.getAllData('admin@test.com');

    expect(result.connections as unknown).toEqual([{ id: 'c1' }]);
    expect(result.history as unknown).toEqual([{ id: 'h1' }]);
  });

  test('getCollection returns null when not found', async () => {
    mockPrepare.mockReturnValue({
      all: mock(() => []),
      get: mock(() => undefined),
      run: mock(() => {}),
    });

    await provider.initialize();
    const result = await provider.getCollection('admin@test.com', 'connections');
    expect(result).toBeNull();
  });

  test('getCollection returns parsed data', async () => {
    const data = [{ id: 'c1', name: 'Test' }];
    mockPrepare.mockReturnValue({
      all: mock(() => []),
      get: mock(() => ({ data: JSON.stringify(data) })),
      run: mock(() => {}),
    });

    await provider.initialize();
    const result = await provider.getCollection('admin@test.com', 'connections');
    expect(result as unknown).toEqual(data);
  });

  test('setCollection calls INSERT OR REPLACE', async () => {
    const mockRun = mock((..._args: unknown[]) => {});
    mockPrepare.mockReturnValue({
      all: mock(() => []),
      get: mock(() => undefined),
      run: mockRun,
    });

    await provider.initialize();
    await provider.setCollection('admin@test.com', 'connections', []);

    expect(mockRun).toHaveBeenCalled();
    const args = (mockRun.mock.calls as unknown[][])[0];
    expect(args[0]).toBe('admin@test.com');
    expect(args[1]).toBe('connections');
  });

  test('isHealthy returns true when db works', async () => {
    mockPrepare.mockReturnValue({
      all: mock(() => []),
      get: mock(() => ({ ok: 1 })),
      run: mock(() => {}),
    });

    await provider.initialize();
    expect(await provider.isHealthy()).toBe(true);
  });

  test('close calls db.close()', async () => {
    await provider.initialize();
    await provider.close();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  test('mergeData uses transaction', async () => {
    const mockRun = mock((..._args: unknown[]) => {});
    mockPrepare.mockReturnValue({
      all: mock(() => []),
      get: mock(() => undefined),
      run: mockRun,
    });

    const txFn = mock((fn: () => void) => fn);
    mockDbInstance.transaction = txFn;

    await provider.initialize();
    await provider.mergeData('admin@test.com', {
      connections: [{ id: 'c1', name: 'DB', type: 'postgres', host: 'localhost', port: 5432, createdAt: new Date() }] as import('@/lib/types').DatabaseConnection[],
      history: [{ id: 'h1', connectionId: 'c1', query: 'SELECT 1', executionTime: 10, status: 'success', executedAt: new Date() }] as import('@/lib/types').QueryHistoryItem[],
    });

    // Transaction wrapper was called
    expect(txFn).toHaveBeenCalledTimes(1);
    // run was called for each provided collection
    expect(mockRun.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('mergeData only writes provided collections', async () => {
    const mockRun = mock((..._args: unknown[]) => {});
    mockPrepare.mockReturnValue({
      all: mock(() => []),
      get: mock(() => undefined),
      run: mockRun,
    });
    mockDbInstance.transaction = mock((fn: () => void) => fn);

    await provider.initialize();
    await provider.mergeData('admin@test.com', {
      connections: [{ id: 'c1', name: 'DB', type: 'postgres', host: 'localhost', port: 5432, createdAt: new Date() }] as import('@/lib/types').DatabaseConnection[],
    });

    // Only connections was provided, so only 1 run call for data
    expect(mockRun).toHaveBeenCalledTimes(1);
    const args = (mockRun.mock.calls as unknown[][])[0];
    expect(args[1]).toBe('connections');
  });

  test('isHealthy returns false on error', async () => {
    mockPrepare.mockReturnValue({
      all: mock(() => []),
      get: mock(() => { throw new Error('DB crashed'); }),
      run: mock(() => {}),
    });

    await provider.initialize();
    expect(await provider.isHealthy()).toBe(false);
  });

  test('getCollection returns null for corrupted JSON', async () => {
    mockPrepare.mockReturnValue({
      all: mock(() => []),
      get: mock(() => ({ data: 'not-valid-json{{{' })),
      run: mock(() => {}),
    });

    await provider.initialize();
    const result = await provider.getCollection('admin@test.com', 'connections');
    expect(result).toBeNull();
  });

  test('getAllData skips corrupted JSON rows', async () => {
    mockPrepare.mockReturnValue({
      all: mock(() => [
        { collection: 'connections', data: JSON.stringify([{ id: 'c1' }]) },
        { collection: 'history', data: 'corrupted{{{' },
      ]),
      get: mock(() => undefined),
      run: mock(() => {}),
    });

    await provider.initialize();
    const result = await provider.getAllData('admin@test.com');
    expect(result.connections as unknown).toEqual([{ id: 'c1' }]);
    expect(result.history).toBeUndefined();
  });

  test('close on uninitialized provider does not throw', async () => {
    const freshProvider = new SQLiteStorageProvider(':memory:');
    await expect(freshProvider.close()).resolves.toBeUndefined();
  });

  test('ensureDb throws when not initialized', async () => {
    const freshProvider = new SQLiteStorageProvider(':memory:');
    await expect(freshProvider.getAllData('test@test.com')).rejects.toThrow('not initialized');
  });
});
