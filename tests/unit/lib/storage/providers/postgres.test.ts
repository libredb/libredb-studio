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

const mockPoolConstructor = mock(() => mockPool);

mock.module('pg', () => ({
  Pool: mockPoolConstructor,
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

import { PostgresStorageProvider } from '@/lib/storage/providers/postgres';

describe('PostgresStorageProvider', () => {
  let provider: ServerStorageProvider;

  beforeEach(() => {
    mockQuery.mockClear();
    mockEnd.mockClear();
    mockRelease.mockClear();
    mockPoolConstructor.mockClear();
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

  test('initialize disables SSL for localhost when no ssl params', async () => {
    const localProvider = new PostgresStorageProvider(
      'postgresql://localhost:5432/test'
    );
    await localProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toBe(false);
    await localProvider.close();
  });

  test('initialize disables SSL when sslmode=disable', async () => {
    const localProvider = new PostgresStorageProvider(
      'postgresql://localhost:5432/test?sslmode=disable'
    );
    await localProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toBe(false);
    await localProvider.close();
  });

  test('initialize disables SSL for docker local host aliases', async () => {
    const localProvider = new PostgresStorageProvider(
      'postgresql://host.docker.internal:5432/test'
    );
    await localProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toBe(false);
    await localProvider.close();
  });

  test('initialize enables SSL when sslmode=require', async () => {
    const cloudProvider = new PostgresStorageProvider(
      'postgresql://db.example.com:5432/test?sslmode=require'
    );
    await cloudProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toEqual({ rejectUnauthorized: false });
    await cloudProvider.close();
  });

  test('initialize enables SSL for non-local hosts by default', async () => {
    const cloudProvider = new PostgresStorageProvider(
      'postgresql://db.internal.example:5432/test'
    );
    await cloudProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toEqual({ rejectUnauthorized: false });
    await cloudProvider.close();
  });

  test('initialize disables SSL for all loopback 127.x.x.x addresses', async () => {
    const localProvider = new PostgresStorageProvider(
      'postgresql://127.0.0.42:5432/test'
    );
    await localProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toBe(false);
    await localProvider.close();
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

  test('mergeData rolls back on error and releases client', async () => {
    await provider.initialize();

    let callCount = 0;
    const mockClientQuery = mock(async (sql: string): Promise<{ rows: unknown[] }> => {
      callCount++;
      // Fail on the INSERT (3rd call: BEGIN, then INSERT fails)
      if (callCount === 2) throw new Error('Insert failed');
      return { rows: [] };
    });
    const mockClientRelease = mock(() => {});
    const client = {
      query: mockClientQuery,
      release: mockClientRelease,
    };
    mockPool.connect = mock(async () => client);

    await expect(
      provider.mergeData('admin@test.com', {
        connections: [{ id: 'c1', name: 'Test', type: 'postgres', createdAt: new Date() } as import('@/lib/types').DatabaseConnection],
      })
    ).rejects.toThrow('Insert failed');

    // ROLLBACK should have been called
    const queries = (mockClientQuery.mock.calls as unknown[][]).map((c) => c[0] as string);
    expect(queries).toContain('ROLLBACK');
    // Client always released (finally block)
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  test('mergeData only writes provided collections', async () => {
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
    // BEGIN + 1 INSERT + COMMIT = 3 queries
    expect(queries.length).toBe(3);
    expect(queries[0]).toBe('BEGIN');
    expect(queries[1]).toContain('INSERT INTO user_storage');
    expect(queries[2]).toBe('COMMIT');
  });

  test('getCollection returns null for corrupted JSON', async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({
      rows: [{ data: 'invalid-json{{{' }],
    });

    const result = await provider.getCollection('admin@test.com', 'connections');
    expect(result).toBeNull();
  });

  test('getAllData skips corrupted JSON rows', async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({
      rows: [
        { collection: 'connections', data: JSON.stringify([{ id: 'c1' }]) },
        { collection: 'history', data: 'corrupted{{{' },
      ],
    });

    const result = await provider.getAllData('admin@test.com');
    expect(result.connections as unknown).toEqual([{ id: 'c1' }]);
    expect(result.history).toBeUndefined();
  });

  test('initialize throws when no connection string', async () => {
    const origEnv = process.env.STORAGE_POSTGRES_URL;
    delete process.env.STORAGE_POSTGRES_URL;
    try {
      const noUrlProvider = new PostgresStorageProvider('');
      await expect(noUrlProvider.initialize()).rejects.toThrow('STORAGE_POSTGRES_URL is required');
    } finally {
      if (origEnv !== undefined) process.env.STORAGE_POSTGRES_URL = origEnv;
    }
  });

  test('close on uninitialized provider does not throw', async () => {
    const freshProvider = new PostgresStorageProvider('postgresql://localhost/test');
    await expect(freshProvider.close()).resolves.toBeUndefined();
  });

  test('ensurePool throws when not initialized', async () => {
    const freshProvider = new PostgresStorageProvider('postgresql://localhost/test');
    await expect(freshProvider.getAllData('test@test.com')).rejects.toThrow('not initialized');
  });
});
