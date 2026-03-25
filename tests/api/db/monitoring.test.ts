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
const { POST } = await import('@/app/api/db/monitoring/route');

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
describe('POST /api/db/monitoring', () => {
  beforeEach(() => {
    mockGetOrCreateProvider.mockClear();
    (mockProvider.getMonitoringData as ReturnType<typeof mock>).mockClear();

    // Reset implementations
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider as never);
    (mockProvider.getMonitoringData as ReturnType<typeof mock>).mockImplementation(async () => ({
      timestamp: new Date(),
      overview: {
        version: 'PostgreSQL 16.1',
        uptime: '10 days',
        activeConnections: 5,
        maxConnections: 100,
        databaseSize: '256 MB',
        databaseSizeBytes: 268435456,
        tableCount: 15,
        indexCount: 30,
      },
      performance: {
        cacheHitRatio: 99.2,
        transactionsPerSecond: 120,
        queriesPerSecond: 350,
        bufferPoolUsage: 45.5,
        deadlocks: 0,
      },
      slowQueries: [],
      activeSessions: [],
    }));
  });

  test('valid connection returns 200 with monitoring data', async () => {
    const req = createMockRequest('/api/db/monitoring', {
      method: 'POST',
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      timestamp: string;
      overview: { version: string; activeConnections: number };
      performance: { cacheHitRatio: number };
      slowQueries: unknown[];
      activeSessions: unknown[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.overview).toBeDefined();
    expect(data.overview.version).toBe('PostgreSQL 16.1');
    expect(data.performance).toBeDefined();
    expect(data.performance.cacheHitRatio).toBe(99.2);
    expect(data.slowQueries).toBeDefined();
    expect(data.activeSessions).toBeDefined();
  });

  test('empty body returns 400', async () => {
    const req = new Request('http://localhost:3000/api/db/monitoring', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('empty');
  });

  test('invalid JSON returns 400', async () => {
    const req = new Request('http://localhost:3000/api/db/monitoring', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-valid-json{{{',
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('Invalid JSON');
  });

  test('missing connection type returns 400', async () => {
    const req = createMockRequest('/api/db/monitoring', {
      method: 'POST',
      body: { connection: { host: 'localhost' } },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('Valid connection configuration is required');
  });

  test('ConnectionError returns 503', async () => {
    mockGetOrCreateProvider.mockImplementation(async () => {
      throw new ConnectionError('Connection refused', 'postgres', 'localhost', 5432);
    });

    const req = createMockRequest('/api/db/monitoring', {
      method: 'POST',
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(503);
    expect(data.error).toContain('Connection refused');
    expect(data.code).toBe('CONNECTION_ERROR');
  });

  test('DatabaseError returns 500', async () => {
    mockGetOrCreateProvider.mockImplementation(async () => {
      throw new DatabaseError('Internal error', 'postgres', 'DATABASE_ERROR');
    });

    const req = createMockRequest('/api/db/monitoring', {
      method: 'POST',
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string; statusCode: number }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toContain('Internal error');
    expect(data.code).toBe('DATABASE_ERROR');
    expect(data.statusCode).toBe(500);
  });
});
