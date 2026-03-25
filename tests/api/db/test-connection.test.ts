import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockRequest, parseResponseJSON } from '../../helpers/mock-next';
import { createMockProvider } from '../../helpers/mock-provider';
import { DatabaseConfigError } from '@/lib/db/errors';

// ─── Create mock objects ────────────────────────────────────────────────────
const mockProvider = createMockProvider();
const mockCreateDatabaseProvider = mock(async () => mockProvider);

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
mock.module('@/lib/db/factory', () => ({
  createDatabaseProvider: mockCreateDatabaseProvider,
  getOrCreateProvider: mock(async () => mockProvider),
  removeProvider: mock(async () => {}),
  clearProviderCache: mock(async () => {}),
  getProviderCacheStats: mock(() => ({ size: 0, connections: [] })),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import('@/app/api/db/test-connection/route');

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
describe('POST /api/db/test-connection', () => {
  beforeEach(() => {
    mockCreateDatabaseProvider.mockClear();
    (mockProvider.connect as ReturnType<typeof mock>).mockClear();
    (mockProvider.disconnect as ReturnType<typeof mock>).mockClear();
    (mockProvider.getHealth as ReturnType<typeof mock>).mockClear();

    // Reset implementations to defaults
    mockCreateDatabaseProvider.mockImplementation(async () => mockProvider);
    (mockProvider.connect as ReturnType<typeof mock>).mockImplementation(async () => {});
    (mockProvider.disconnect as ReturnType<typeof mock>).mockImplementation(async () => {});
    (mockProvider.getHealth as ReturnType<typeof mock>).mockImplementation(async () => ({
      activeConnections: 5,
      databaseSize: '256 MB',
      cacheHitRatio: '99.2%',
      slowQueries: [],
      activeSessions: [],
    }));
  });

  test('returns success with latency for valid connection', async () => {
    const req = createMockRequest('/api/db/test-connection', {
      method: 'POST',
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string; latency: number }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toBe('Connection successful');
    expect(typeof data.latency).toBe('number');
  });

  test('returns success for demo connection type', async () => {
    const req = createMockRequest('/api/db/test-connection', {
      method: 'POST',
      body: { type: 'demo' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.message).toBe('Demo connection is always available.');
  });

  test('returns 400 when connection type is missing', async () => {
    const req = createMockRequest('/api/db/test-connection', {
      method: 'POST',
      body: { host: 'localhost' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.success).toBe(false);
  });

  test('returns 400 when body is empty object', async () => {
    const req = createMockRequest('/api/db/test-connection', {
      method: 'POST',
      body: {},
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.success).toBe(false);
  });

  test('returns 400 when DatabaseConfigError is thrown', async () => {
    mockCreateDatabaseProvider.mockImplementation(async () => {
      throw new DatabaseConfigError('Invalid database configuration');
    });

    const req = createMockRequest('/api/db/test-connection', {
      method: 'POST',
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toBe('Invalid database configuration');
    expect(data.code).toBe('CONFIG_ERROR');
  });

  test('returns 500 when connection error occurs', async () => {
    (mockProvider.connect as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });

    const req = createMockRequest('/api/db/test-connection', {
      method: 'POST',
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe('ECONNREFUSED');
    expect(data.code).toBe('INTERNAL_ERROR');
  });

  test('calls connect and disconnect on successful test', async () => {
    const req = createMockRequest('/api/db/test-connection', {
      method: 'POST',
      body: validConnection,
    });

    await POST(req as never);

    expect(mockProvider.connect).toHaveBeenCalledTimes(1);
    expect(mockProvider.getHealth).toHaveBeenCalledTimes(1);
    expect(mockProvider.disconnect).toHaveBeenCalledTimes(1);
  });

  test('calls disconnect on error', async () => {
    (mockProvider.getHealth as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error('Health check failed');
    });

    const req = createMockRequest('/api/db/test-connection', {
      method: 'POST',
      body: validConnection,
    });

    await POST(req as never);

    expect(mockProvider.connect).toHaveBeenCalledTimes(1);
    expect(mockProvider.disconnect).toHaveBeenCalledTimes(1);
  });
});
