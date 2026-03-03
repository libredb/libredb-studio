import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { ServerStorageProvider } from '@/lib/storage/types';

// ── Mock pg ──────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockQuery = mock(async (..._args: any[]): Promise<any> => ({ rows: [] }));
const mockRelease = mock(() => {});
const mockEnd = mock(async () => {});

const mockClient = {
  query: mockQuery,
  release: mockRelease,
};

const mockPool: Record<string, any> = {
  query: mockQuery,
  connect: mock(async () => mockClient),
  end: mockEnd,
};

mock.module('pg', () => ({
  Pool: mock(() => mockPool),
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

import { PostgresStorageProvider } from '@/lib/storage/providers/postgres';

describe('PostgresStorageProvider', () => {
  let provider: ServerStorageProvider;

  beforeEach(() => {
    mockQuery.mockClear();
    mockEnd.mockClear();
    mockRelease.mockClear();
    provider = new PostgresStorageProvider('postgresql://localhost:5432/test');
  });

  afterEach(async () => {
    await provider.close();
  });

  test('initialize creates table', async () => {
    await provider.initialize();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = (mockQuery.mock.calls as unknown[][])[0][0] as string;
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS user_storage');
  });

  test('getAllData returns parsed collections', async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({
      rows: [
        { collection: 'connections', data: JSON.stringify([{ id: 'c1' }]) },
        { collection: 'history', data: JSON.stringify([{ id: 'h1' }]) },
      ],
    });

    const result = await provider.getAllData('admin@test.com');
    expect(result.connections as unknown).toEqual([{ id: 'c1' }]);
    expect(result.history as unknown).toEqual([{ id: 'h1' }]);
  });

  test('getCollection returns null when not found', async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await provider.getCollection('admin@test.com', 'connections');
    expect(result).toBeNull();
  });

  test('getCollection returns parsed data', async () => {
    const data = [{ id: 'c1', name: 'Test' }];
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({
      rows: [{ data: JSON.stringify(data) }],
    });

    const result = await provider.getCollection('admin@test.com', 'connections');
    expect(result as unknown).toEqual(data);
  });

  test('setCollection calls INSERT with ON CONFLICT', async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await provider.setCollection('admin@test.com', 'connections', []);

    const calls = mockQuery.mock.calls as unknown[][];
    const lastCall = calls[calls.length - 1];
    const sql = lastCall[0] as string;
    expect(sql).toContain('INSERT INTO user_storage');
    expect(sql).toContain('ON CONFLICT');
  });

  test('isHealthy returns true on success', async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: 1 }] });

    expect(await provider.isHealthy()).toBe(true);
  });

  test('isHealthy returns false on error', async () => {
    await provider.initialize();
    mockQuery.mockRejectedValueOnce(new Error('Connection lost'));

    expect(await provider.isHealthy()).toBe(false);
  });

  test('close calls pool.end()', async () => {
    await provider.initialize();
    await provider.close();
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  test('mergeData uses transaction', async () => {
    await provider.initialize();

    const mockClientQuery = mock(async (): Promise<{ rows: unknown[] }> => ({ rows: [] }));
    const client = {
      query: mockClientQuery,
      release: mock(() => {}),
    };
    mockPool.connect = mock(async () => client);

    await provider.mergeData('admin@test.com', {
      connections: [{ id: 'c1', name: 'Test', type: 'postgres', createdAt: new Date() } as import('@/lib/types').DatabaseConnection],
    });

    const queries = (mockClientQuery.mock.calls as unknown[][]).map((c) => c[0] as string);
    expect(queries[0]).toBe('BEGIN');
    expect(queries[queries.length - 1]).toBe('COMMIT');
  });
});
