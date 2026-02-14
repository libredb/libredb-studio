import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockRequest, parseResponseJSON } from '../../helpers/mock-next';
import { createMockProvider } from '../../helpers/mock-provider';

// ─── Mock error classes ─────────────────────────────────────────────────────
class MockConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
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
  ConnectionError: MockConnectionError,
  DatabaseError: MockDatabaseError,
  isDatabaseError: mock((e: unknown) => e instanceof MockDatabaseError),
  isConnectionError: mock((e: unknown) => e instanceof MockConnectionError),
  QueryError: class extends Error { constructor(m: string) { super(m); this.name = 'QueryError'; } },
  TimeoutError: class extends Error { constructor(m: string) { super(m); this.name = 'TimeoutError'; } },
  DatabaseConfigError: class extends Error { constructor(m: string) { super(m); this.name = 'DatabaseConfigError'; } },
  isQueryError: mock(() => false),
  isTimeoutError: mock(() => false),
  isAuthenticationError: mock(() => false),
  isRetryableError: mock(() => false),
  mapDatabaseError: mock(),
  BaseDatabaseProvider: class {},
  DemoProvider: class {},
}));

// ─── Import route handlers AFTER mocking ────────────────────────────────────
const { GET, POST } = await import('@/app/api/db/health/route');

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
describe('GET /api/db/health', () => {
  test('returns 200 with healthy status', async () => {
    const res = await GET();
    const data = await parseResponseJSON<{
      status: string;
      timestamp: string;
      service: string;
    }>(res);

    expect(res.status).toBe(200);
    expect(data.status).toBe('healthy');
    expect(data.service).toBe('libredb-studio');
    expect(data.timestamp).toBeDefined();
  });
});

describe('POST /api/db/health', () => {
  beforeEach(() => {
    mockGetOrCreateProvider.mockClear();
    (mockProvider.getHealth as ReturnType<typeof mock>).mockClear();
  });

  test('returns 200 with health info for valid connection', async () => {
    const req = createMockRequest('/api/db/health', {
      method: 'POST',
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      activeConnections: number;
      databaseSize: string;
      cacheHitRatio: string;
    }>(res);

    expect(res.status).toBe(200);
    expect(data.activeConnections).toBeDefined();
    expect(data.databaseSize).toBeDefined();
    expect(data.cacheHitRatio).toBeDefined();
  });

  test('returns 400 when connection is missing', async () => {
    const req = createMockRequest('/api/db/health', {
      method: 'POST',
      body: {},
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('required');
  });

  test('returns 503 for ConnectionError', async () => {
    mockGetOrCreateProvider.mockRejectedValueOnce(
      new MockConnectionError('Connection refused')
    );

    const req = createMockRequest('/api/db/health', {
      method: 'POST',
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; activeConnections: number }>(res);

    expect(res.status).toBe(503);
    expect(data.error).toContain('Connection failed');
    expect(data.activeConnections).toBe(0);
  });

  test('returns 500 for DatabaseError', async () => {
    const dbError = new MockDatabaseError('Database internal error', 'postgres', 'INTERNAL');
    mockGetOrCreateProvider.mockResolvedValueOnce(mockProvider);
    (mockProvider.getHealth as ReturnType<typeof mock>).mockRejectedValueOnce(dbError);

    const req = createMockRequest('/api/db/health', {
      method: 'POST',
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe('Database internal error');
    expect(data.code).toBe('INTERNAL');
  });

  test('returns 500 for generic error', async () => {
    (mockProvider.getHealth as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('Unexpected failure')
    );

    const req = createMockRequest('/api/db/health', {
      method: 'POST',
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe('Unexpected failure');
  });
});
