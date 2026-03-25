import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockRequest, parseResponseJSON } from '../../helpers/mock-next';
import { createMockProvider } from '../../helpers/mock-provider';
import {
  QueryError,
  TimeoutError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
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

// ─── Create mock objects ────────────────────────────────────────────────────
const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider as never);

// ─── Mock auth + seed resolution BEFORE importing route ─────────────────────
mock.module('@/lib/auth', () => ({
  getSession: mock(async () => ({ role: 'admin', username: 'admin' })),
  signJWT: mock(async () => 'mock-token'),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

mock.module('@/lib/seed/resolve-connection', () => {
  class SeedConnectionError extends Error {
    constructor(message: string, public statusCode: number) {
      super(message);
      this.name = 'SeedConnectionError';
    }
  }
  return {
    resolveConnection: mock(async (body: Record<string, unknown>) => {
      if (!body.connection && !body.connectionId) {
        throw new SeedConnectionError('Either connection or connectionId is required', 400);
      }
      return body.connection;
    }),
    SeedConnectionError,
  };
});

// ─── Mock dependencies BEFORE importing route ───────────────────────────────
mock.module('@/lib/db', () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(async () => mockProvider),
  removeProvider: mock(async () => {}),
  clearProviderCache: mock(async () => {}),
  getProviderCacheStats: mock(() => ({ size: 0, connections: [] })),
  QueryError,
  TimeoutError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
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
const { POST } = await import('@/app/api/db/multi-query/route');

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
describe('POST /api/db/multi-query', () => {
  beforeEach(() => {
    mockGetOrCreateProvider.mockClear();
    (mockProvider.query as ReturnType<typeof mock>).mockClear();
    (mockProvider.prepareQuery as ReturnType<typeof mock>).mockClear();

    // Reset to default implementations
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider as never);
    (mockProvider.query as ReturnType<typeof mock>).mockImplementation(async () => ({
      rows: [{ id: 1, name: 'Alice' }],
      fields: ['id', 'name'],
      rowCount: 1,
      executionTime: 10,
    }));
    (mockProvider.prepareQuery as ReturnType<typeof mock>).mockImplementation((query: string) => ({
      query: `${query} LIMIT 50`,
      wasLimited: true,
      limit: 50,
      offset: 0,
    }));
  });

  test('single statement returns multiStatement results', async () => {
    const req = createMockRequest('/api/db/multi-query', {
      method: 'POST',
      body: { connection: validConnection, sql: 'SELECT * FROM users' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      multiStatement: boolean;
      statementCount: number;
      executedCount: number;
      hasError: boolean;
      statements: unknown[];
      rows: unknown[];
      fields: string[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.multiStatement).toBe(true);
    expect(data.statementCount).toBe(1);
    expect(data.executedCount).toBe(1);
    expect(data.hasError).toBe(false);
    expect(data.statements).toHaveLength(1);
    expect(data.rows).toBeDefined();
    expect(data.fields).toBeDefined();
  });

  test('multiple statements are all executed', async () => {
    let callCount = 0;
    (mockProvider.query as ReturnType<typeof mock>).mockImplementation(async () => {
      callCount++;
      return {
        rows: [{ result: callCount }],
        fields: ['result'],
        rowCount: 1,
        executionTime: 5,
      };
    });

    const req = createMockRequest('/api/db/multi-query', {
      method: 'POST',
      body: {
        connection: validConnection,
        sql: 'INSERT INTO users (name) VALUES (\'Alice\'); INSERT INTO users (name) VALUES (\'Bob\'); SELECT * FROM users',
      },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      multiStatement: boolean;
      statementCount: number;
      executedCount: number;
      hasError: boolean;
      statements: Array<{ status: string; index: number }>;
    }>(res);

    expect(res.status).toBe(200);
    expect(data.statementCount).toBe(3);
    expect(data.executedCount).toBe(3);
    expect(data.hasError).toBe(false);
    expect(data.statements.every((s) => s.status === 'success')).toBe(true);
  });

  test('error in second statement stops execution and sets hasError', async () => {
    let callCount = 0;
    (mockProvider.query as ReturnType<typeof mock>).mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        throw new Error('Syntax error in statement 2');
      }
      return {
        rows: [],
        fields: [],
        rowCount: 0,
        executionTime: 5,
      };
    });

    const req = createMockRequest('/api/db/multi-query', {
      method: 'POST',
      body: {
        connection: validConnection,
        sql: 'INSERT INTO a VALUES (1); BAD SQL HERE; SELECT * FROM b',
      },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      statementCount: number;
      executedCount: number;
      hasError: boolean;
      statements: Array<{ status: string; error?: string }>;
    }>(res);

    expect(res.status).toBe(200);
    expect(data.statementCount).toBe(3);
    expect(data.executedCount).toBe(2); // Stopped after error on 2nd
    expect(data.hasError).toBe(true);
    expect(data.statements[0].status).toBe('success');
    expect(data.statements[1].status).toBe('error');
    expect(data.statements[1].error).toContain('Syntax error');
  });

  test('missing connection returns 400', async () => {
    const req = createMockRequest('/api/db/multi-query', {
      method: 'POST',
      body: { sql: 'SELECT 1' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('required');
  });

  test('missing sql returns 400', async () => {
    const req = createMockRequest('/api/db/multi-query', {
      method: 'POST',
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('Connection and query are required');
  });

  test('only semicolons returns 400 (no valid statements)', async () => {
    const req = createMockRequest('/api/db/multi-query', {
      method: 'POST',
      body: { connection: validConnection, sql: ';;;' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('No valid SQL statements found');
  });

  test('last SELECT gets prepareQuery applied', async () => {
    const req = createMockRequest('/api/db/multi-query', {
      method: 'POST',
      body: {
        connection: validConnection,
        sql: 'INSERT INTO users (name) VALUES (\'test\'); SELECT * FROM users',
      },
    });

    await POST(req as never);

    // prepareQuery should have been called for the SELECT (last statement)
    expect(mockProvider.prepareQuery).toHaveBeenCalled();
  });

  test('non-SELECT statements do not get prepareQuery applied', async () => {
    const req = createMockRequest('/api/db/multi-query', {
      method: 'POST',
      body: {
        connection: validConnection,
        sql: 'INSERT INTO users (name) VALUES (\'test\')',
      },
    });

    await POST(req as never);

    // prepareQuery should NOT have been called for a single INSERT
    expect(mockProvider.prepareQuery).not.toHaveBeenCalled();
  });

  test('QueryError from getOrCreateProvider returns 400', async () => {
    mockGetOrCreateProvider.mockImplementation(async () => {
      throw new QueryError('Bad query', 'postgres');
    });

    const req = createMockRequest('/api/db/multi-query', {
      method: 'POST',
      body: { connection: validConnection, sql: 'SELECT 1' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('Bad query');
  });

  test('TimeoutError from getOrCreateProvider returns 408', async () => {
    mockGetOrCreateProvider.mockImplementation(async () => {
      throw new TimeoutError('Query timed out', 'postgres', 30000);
    });

    const req = createMockRequest('/api/db/multi-query', {
      method: 'POST',
      body: { connection: validConnection, sql: 'SELECT 1' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(408);
    expect(data.error).toContain('timed out');
  });
});
