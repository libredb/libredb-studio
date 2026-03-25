import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockRequest, parseResponseJSON } from '../../helpers/mock-next';
import { createMockProvider } from '../../helpers/mock-provider';

// ─── Mock provider ──────────────────────────────────────────────────────────
const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider);

// ─── Mock auth + seed resolution BEFORE importing the route ─────────────────
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

// ─── Mock @/lib/db/factory BEFORE importing the route ───────────────────────
mock.module('@/lib/db/factory', () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(async () => mockProvider),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import('@/app/api/db/pool-stats/route');

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
describe('POST /api/db/pool-stats', () => {
  beforeEach(() => {
    mockGetOrCreateProvider.mockClear();
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider);
  });

  test('returns pool stats when provider supports getPoolStats', async () => {
    const providerWithPoolStats = {
      ...createMockProvider(),
      getPoolStats: mock(() => ({ total: 10, idle: 5, active: 3, waiting: 2 })),
    };
    mockGetOrCreateProvider.mockResolvedValueOnce(providerWithPoolStats);

    const req = createMockRequest('/api/db/pool-stats', {
      method: 'POST',
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      total: number; idle: number; active: number; waiting: number;
    }>(res);

    expect(res.status).toBe(200);
    expect(data.total).toBe(10);
    expect(data.idle).toBe(5);
    expect(data.active).toBe(3);
    expect(data.waiting).toBe(2);
  });

  test('returns fallback stats when provider lacks getPoolStats', async () => {
    // Default mockProvider does not have getPoolStats
    const req = createMockRequest('/api/db/pool-stats', {
      method: 'POST',
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      total: number; idle: number; active: number; waiting: number; message: string;
    }>(res);

    expect(res.status).toBe(200);
    expect(data.total).toBe(0);
    expect(data.idle).toBe(0);
    expect(data.active).toBe(0);
    expect(data.waiting).toBe(0);
    expect(data.message).toContain('not available');
  });

  test('returns 400 when connection is missing', async () => {
    const req = createMockRequest('/api/db/pool-stats', {
      method: 'POST',
      body: {},
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('required');
  });

  test('returns 500 on error', async () => {
    mockGetOrCreateProvider.mockRejectedValueOnce(
      new Error('Provider creation failed')
    );

    const req = createMockRequest('/api/db/pool-stats', {
      method: 'POST',
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe('Provider creation failed');
  });
});
