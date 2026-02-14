import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockRequest, parseResponseJSON } from '../../helpers/mock-next';
import { createMockProvider } from '../../helpers/mock-provider';
import {
  QueryError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  TimeoutError,
  AuthenticationError,
  PoolExhaustedError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  mapDatabaseError,
} from '@/lib/db/errors';

// ─── Create mock provider with transaction methods ──────────────────────────
const baseMockProvider = createMockProvider();

const mockTxProvider = {
  ...baseMockProvider,
  beginTransaction: mock(async () => {}),
  commitTransaction: mock(async () => {}),
  rollbackTransaction: mock(async () => {}),
  isInTransaction: mock(() => true),
  queryInTransaction: mock(async () => ({
    rows: [{ id: 1, name: 'Alice' }],
    fields: ['id', 'name'],
    rowCount: 1,
    executionTime: 10,
  })),
};

// Non-transaction provider (no transaction methods)
const mockNonTxProvider = createMockProvider();

const mockGetOrCreateProvider = mock(async () => mockTxProvider as never);

// ─── Mock dependencies BEFORE importing route ───────────────────────────────
mock.module('@/lib/db', () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(async () => mockTxProvider),
  removeProvider: mock(async () => {}),
  clearProviderCache: mock(async () => {}),
  getProviderCacheStats: mock(() => ({ size: 0, connections: [] })),
  QueryError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  TimeoutError,
  AuthenticationError,
  PoolExhaustedError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  mapDatabaseError,
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import('@/app/api/db/transaction/route');

// ─── Helpers ────────────────────────────────────────────────────────────────
const validConnection = {
  id: 'test-1',
  name: 'Test DB',
  type: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'testdb',
};

// ─── Tests ──────────────────────────────────────────────────────────────────
describe('POST /api/db/transaction', () => {
  beforeEach(() => {
    mockGetOrCreateProvider.mockClear();
    mockTxProvider.beginTransaction.mockClear();
    mockTxProvider.commitTransaction.mockClear();
    mockTxProvider.rollbackTransaction.mockClear();
    mockTxProvider.isInTransaction.mockClear();
    mockTxProvider.queryInTransaction.mockClear();
    (mockTxProvider.prepareQuery as ReturnType<typeof mock>).mockClear();

    // Reset to default implementations
    mockGetOrCreateProvider.mockImplementation(async () => mockTxProvider as never);
    mockTxProvider.beginTransaction.mockImplementation(async () => {});
    mockTxProvider.commitTransaction.mockImplementation(async () => {});
    mockTxProvider.rollbackTransaction.mockImplementation(async () => {});
    mockTxProvider.isInTransaction.mockImplementation(() => true);
    mockTxProvider.queryInTransaction.mockImplementation(async () => ({
      rows: [{ id: 1, name: 'Alice' }],
      fields: ['id', 'name'],
      rowCount: 1,
      executionTime: 10,
    }));
  });

  test('begin action returns status active', async () => {
    const req = createMockRequest('/api/db/transaction', {
      method: 'POST',
      body: { connection: validConnection, action: 'begin' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ status: string; message: string }>(res);

    expect(res.status).toBe(200);
    expect(data.status).toBe('active');
    expect(data.message).toBe('Transaction started');
    expect(mockTxProvider.beginTransaction).toHaveBeenCalledTimes(1);
  });

  test('commit action returns status committed', async () => {
    const req = createMockRequest('/api/db/transaction', {
      method: 'POST',
      body: { connection: validConnection, action: 'commit' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ status: string; message: string }>(res);

    expect(res.status).toBe(200);
    expect(data.status).toBe('committed');
    expect(data.message).toBe('Transaction committed');
    expect(mockTxProvider.commitTransaction).toHaveBeenCalledTimes(1);
  });

  test('rollback action returns status rolled_back', async () => {
    const req = createMockRequest('/api/db/transaction', {
      method: 'POST',
      body: { connection: validConnection, action: 'rollback' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ status: string; message: string }>(res);

    expect(res.status).toBe(200);
    expect(data.status).toBe('rolled_back');
    expect(data.message).toBe('Transaction rolled back');
    expect(mockTxProvider.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  test('query action with sql returns result with pagination', async () => {
    const req = createMockRequest('/api/db/transaction', {
      method: 'POST',
      body: { connection: validConnection, action: 'query', sql: 'SELECT * FROM users' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      rows: unknown[];
      fields: string[];
      rowCount: number;
      inTransaction: boolean;
      pagination: { limit: number; offset: number; hasMore: boolean; totalReturned: number; wasLimited: boolean };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.inTransaction).toBe(true);
    expect(data.rows).toBeDefined();
    expect(data.fields).toBeDefined();
    expect(data.pagination).toBeDefined();
    expect(data.pagination.wasLimited).toBeDefined();
  });

  test('query action without sql returns 400', async () => {
    const req = createMockRequest('/api/db/transaction', {
      method: 'POST',
      body: { connection: validConnection, action: 'query' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('SQL query is required');
  });

  test('status action returns inTransaction boolean', async () => {
    mockTxProvider.isInTransaction.mockImplementation(() => false);

    const req = createMockRequest('/api/db/transaction', {
      method: 'POST',
      body: { connection: validConnection, action: 'status' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ inTransaction: boolean }>(res);

    expect(res.status).toBe(200);
    expect(data.inTransaction).toBe(false);
  });

  test('unknown action returns 400', async () => {
    const req = createMockRequest('/api/db/transaction', {
      method: 'POST',
      body: { connection: validConnection, action: 'invalid-action' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('Unknown transaction action');
  });

  test('missing connection returns 400', async () => {
    const req = createMockRequest('/api/db/transaction', {
      method: 'POST',
      body: { action: 'begin' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('Connection and action are required');
  });

  test('missing action returns 400', async () => {
    const req = createMockRequest('/api/db/transaction', {
      method: 'POST',
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('Connection and action are required');
  });

  test('provider without transaction support returns 400', async () => {
    mockGetOrCreateProvider.mockImplementation(async () => mockNonTxProvider as never);

    const req = createMockRequest('/api/db/transaction', {
      method: 'POST',
      body: { connection: validConnection, action: 'begin' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('not supported');
  });

  test('QueryError returns 400', async () => {
    mockTxProvider.beginTransaction.mockImplementation(async () => {
      throw new QueryError('Syntax error near BEGIN', 'postgres');
    });

    const req = createMockRequest('/api/db/transaction', {
      method: 'POST',
      body: { connection: validConnection, action: 'begin' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('Syntax error');
  });

  test('DatabaseError returns 500', async () => {
    mockTxProvider.beginTransaction.mockImplementation(async () => {
      throw new DatabaseError('Internal database error', 'postgres', 'DB_ERROR');
    });

    const req = createMockRequest('/api/db/transaction', {
      method: 'POST',
      body: { connection: validConnection, action: 'begin' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toContain('Internal database error');
  });
});
