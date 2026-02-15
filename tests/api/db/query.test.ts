import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockRequest, parseResponseJSON } from '../../helpers/mock-next';
import { createMockProvider } from '../../helpers/mock-provider';
import {
  AuthenticationError,
  PoolExhaustedError,
} from '@/lib/db/errors';

// ─── Mock error classes (must match instanceof checks in route) ─────────────
class MockQueryError extends Error {
  code?: string;
  constructor(message: string) {
    super(message);
    this.name = 'QueryError';
    this.code = 'QUERY_ERROR';
  }
}

class MockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

class MockDatabaseError extends Error {
  provider?: string;
  code?: string;
  constructor(message: string, provider?: string, code?: string) {
    super(message);
    this.name = 'DatabaseError';
    this.provider = provider;
    this.code = code;
  }
}

class MockConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

class MockDatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigError';
  }
}

// ─── Mock provider ──────────────────────────────────────────────────────────
const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider);

// ─── Mock @/lib/db BEFORE importing the route ───────────────────────────────
mock.module('@/lib/db', () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(),
  removeProvider: mock(),
  clearProviderCache: mock(),
  getProviderCacheStats: mock(),
  QueryError: MockQueryError,
  TimeoutError: MockTimeoutError,
  DatabaseError: MockDatabaseError,
  isDatabaseError: mock((e: unknown) => e instanceof MockDatabaseError),
  ConnectionError: MockConnectionError,
  DatabaseConfigError: MockDatabaseConfigError,
  AuthenticationError,
  PoolExhaustedError,
  isConnectionError: mock((e: unknown) => e instanceof MockConnectionError),
  isQueryError: mock((e: unknown) => e instanceof MockQueryError),
  isTimeoutError: mock((e: unknown) => e instanceof MockTimeoutError),
  isAuthenticationError: mock(() => false),
  isRetryableError: mock(() => false),
  mapDatabaseError: mock(),
  BaseDatabaseProvider: class {},
  DemoProvider: class {},
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import('@/app/api/db/query/route');

// ─── Fixtures ───────────────────────────────────────────────────────────────
const validConnection = {
  id: 'test-1',
  name: 'Test DB',
  type: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'testdb',
};

// ─── Tests ──────────────────────────────────────────────────────────────────
describe('POST /api/db/query', () => {
  beforeEach(() => {
    mockGetOrCreateProvider.mockClear();
    (mockProvider.query as ReturnType<typeof mock>).mockClear();
    (mockProvider.prepareQuery as ReturnType<typeof mock>).mockClear();
  });

  test('returns 200 with rows and pagination for valid query', async () => {
    const req = createMockRequest('/api/db/query', {
      method: 'POST',
      body: { connection: validConnection, sql: 'SELECT * FROM users' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      rows: unknown[];
      fields: string[];
      pagination: { limit: number; offset: number; hasMore: boolean; totalReturned: number; wasLimited: boolean };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.rows).toBeDefined();
    expect(data.fields).toBeDefined();
    expect(data.pagination).toBeDefined();
    expect(data.pagination.limit).toBe(50);
    expect(data.pagination.offset).toBe(0);
    expect(data.pagination.wasLimited).toBe(true);
  });

  test('returns 400 when connection is missing', async () => {
    const req = createMockRequest('/api/db/query', {
      method: 'POST',
      body: { sql: 'SELECT 1' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('required');
  });

  test('returns 400 when sql is missing', async () => {
    const req = createMockRequest('/api/db/query', {
      method: 'POST',
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('required');
  });

  test('returns 400 for QueryError', async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(
      new MockQueryError('syntax error at or near "FORM"')
    );

    const req = createMockRequest('/api/db/query', {
      method: 'POST',
      body: { connection: validConnection, sql: 'SELECT * FORM users' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('syntax error');
    expect(data.code).toBe('QUERY_ERROR');
  });

  test('returns 408 for TimeoutError', async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(
      new MockTimeoutError('Query timed out after 30000ms')
    );

    const req = createMockRequest('/api/db/query', {
      method: 'POST',
      body: { connection: validConnection, sql: 'SELECT pg_sleep(60)' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(408);
    expect(data.error).toContain('timed out');
  });

  test('returns 500 for DatabaseError', async () => {
    const dbError = new MockDatabaseError('Internal database failure', 'postgres', 'INTERNAL');
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(dbError);

    const req = createMockRequest('/api/db/query', {
      method: 'POST',
      body: { connection: validConnection, sql: 'SELECT 1' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe('Internal database failure');
    expect(data.code).toBe('INTERNAL');
  });

  test('returns 499 for cancelled query', async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('canceling statement due to user request')
    );

    const req = createMockRequest('/api/db/query', {
      method: 'POST',
      body: { connection: validConnection, sql: 'SELECT * FROM large_table' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; cancelled: boolean }>(res);

    expect(res.status).toBe(499);
    expect(data.cancelled).toBe(true);
    expect(data.error).toContain('cancelled');
  });

  test('returns 500 for generic error', async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('Something unexpected happened')
    );

    const req = createMockRequest('/api/db/query', {
      method: 'POST',
      body: { connection: validConnection, sql: 'SELECT 1' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe('Something unexpected happened');
  });

  test('calls prepareQuery with sql and options', async () => {
    const req = createMockRequest('/api/db/query', {
      method: 'POST',
      body: {
        connection: validConnection,
        sql: 'SELECT * FROM users',
        options: { limit: 100 },
      },
    });

    await POST(req as never);

    expect(mockProvider.prepareQuery).toHaveBeenCalledTimes(1);
    expect(mockProvider.prepareQuery).toHaveBeenCalledWith('SELECT * FROM users', { limit: 100 });
  });

  test('pagination hasMore is true when rows.length equals limit', async () => {
    const fiftyRows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
    (mockProvider.query as ReturnType<typeof mock>).mockResolvedValueOnce({
      rows: fiftyRows,
      fields: ['id'],
      rowCount: 50,
      executionTime: 10,
    });

    const req = createMockRequest('/api/db/query', {
      method: 'POST',
      body: { connection: validConnection, sql: 'SELECT * FROM users' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      pagination: { hasMore: boolean; totalReturned: number };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.pagination.hasMore).toBe(true);
    expect(data.pagination.totalReturned).toBe(50);
  });

  test('pagination hasMore is false when rows.length less than limit', async () => {
    const threeRows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    (mockProvider.query as ReturnType<typeof mock>).mockResolvedValueOnce({
      rows: threeRows,
      fields: ['id'],
      rowCount: 3,
      executionTime: 5,
    });

    const req = createMockRequest('/api/db/query', {
      method: 'POST',
      body: { connection: validConnection, sql: 'SELECT * FROM users' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      pagination: { hasMore: boolean; totalReturned: number };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.pagination.hasMore).toBe(false);
    expect(data.pagination.totalReturned).toBe(3);
  });

  test('returns 499 for interrupted query execution', async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('Query execution was interrupted')
    );

    const req = createMockRequest('/api/db/query', {
      method: 'POST',
      body: { connection: validConnection, sql: 'SELECT * FROM users' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; cancelled: boolean }>(res);

    expect(res.status).toBe(499);
    expect(data.cancelled).toBe(true);
  });
});
