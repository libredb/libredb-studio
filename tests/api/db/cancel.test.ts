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
const baseMockProvider = createMockProvider();

// Provider with cancelQuery support
const mockCancelProvider = {
  ...baseMockProvider,
  cancelQuery: mock(async () => true),
};

// Provider without cancelQuery support
const mockNoCancelProvider = createMockProvider();

const mockGetOrCreateProvider = mock(async () => mockCancelProvider as never);

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
  createDatabaseProvider: mock(async () => mockCancelProvider),
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
  BaseDatabaseProvider: class {},
  DemoProvider: class {},
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import('@/app/api/db/cancel/route');

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
describe('POST /api/db/cancel', () => {
  beforeEach(() => {
    mockGetOrCreateProvider.mockClear();
    mockCancelProvider.cancelQuery.mockClear();

    // Reset implementations
    mockGetOrCreateProvider.mockImplementation(async () => mockCancelProvider as never);
    mockCancelProvider.cancelQuery.mockImplementation(async () => true);
  });

  test('returns cancelled:true with valid connection and queryId', async () => {
    const req = createMockRequest('/api/db/cancel', {
      method: 'POST',
      body: { connection: validConnection, queryId: 'query-123' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ cancelled: boolean }>(res);

    expect(res.status).toBe(200);
    expect(data.cancelled).toBe(true);
    expect(mockCancelProvider.cancelQuery).toHaveBeenCalledWith('query-123');
  });

  test('missing connection returns 400', async () => {
    const req = createMockRequest('/api/db/cancel', {
      method: 'POST',
      body: { queryId: 'query-123' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('required');
  });

  test('missing queryId returns 400', async () => {
    const req = createMockRequest('/api/db/cancel', {
      method: 'POST',
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('Connection and queryId are required');
  });

  test('provider without cancelQuery returns 400', async () => {
    mockGetOrCreateProvider.mockImplementation(async () => mockNoCancelProvider as never);

    const req = createMockRequest('/api/db/cancel', {
      method: 'POST',
      body: { connection: validConnection, queryId: 'query-123' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; cancelled: boolean }>(res);

    expect(res.status).toBe(400);
    expect(data.cancelled).toBe(false);
    expect(data.error).toContain('not supported');
  });

  test('cancelQuery returning false returns cancelled:false', async () => {
    mockCancelProvider.cancelQuery.mockImplementation(async () => false);

    const req = createMockRequest('/api/db/cancel', {
      method: 'POST',
      body: { connection: validConnection, queryId: 'query-999' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ cancelled: boolean }>(res);

    expect(res.status).toBe(200);
    expect(data.cancelled).toBe(false);
  });

  test('error in cancelQuery returns 500', async () => {
    mockCancelProvider.cancelQuery.mockImplementation(async () => {
      throw new Error('Failed to cancel query');
    });

    const req = createMockRequest('/api/db/cancel', {
      method: 'POST',
      body: { connection: validConnection, queryId: 'query-123' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toContain('Failed to cancel query');
    expect(data.code).toBe('INTERNAL_ERROR');
  });
});
