import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockRequest, parseResponseJSON } from '../../helpers/mock-next';
import { createMockProvider } from '../../helpers/mock-provider';

// ─── Mock error classes (must match instanceof checks in route) ─────────────
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
  isQueryError: mock(() => false),
  isTimeoutError: mock(() => false),
  isAuthenticationError: mock(() => false),
  isRetryableError: mock(() => false),
  mapDatabaseError: mock(),
  BaseDatabaseProvider: class {},
  DemoProvider: class {},
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import('@/app/api/db/provider-meta/route');

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
describe('POST /api/db/provider-meta', () => {
  beforeEach(() => {
    mockGetOrCreateProvider.mockClear();
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider);
  });

  test('returns 200 with capabilities and labels for valid connection', async () => {
    const req = createMockRequest('/api/db/provider-meta', {
      method: 'POST',
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      capabilities: Record<string, unknown>;
      labels: Record<string, unknown>;
    }>(res);

    expect(res.status).toBe(200);
    expect(data.capabilities).toBeDefined();
    expect(data.labels).toBeDefined();
    expect(data.capabilities.queryLanguage).toBe('sql');
    expect(data.labels.entityName).toBe('Table');
  });

  test('returns 400 when body is empty', async () => {
    const req = new Request('http://localhost:3000/api/db/provider-meta', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('Empty');
  });

  test('returns 400 when connection has no type', async () => {
    const req = createMockRequest('/api/db/provider-meta', {
      method: 'POST',
      body: { id: 'test-1', name: 'No Type' },
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

    const req = createMockRequest('/api/db/provider-meta', {
      method: 'POST',
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(503);
    expect(data.error).toContain('Connection');
  });

  test('returns 500 for DatabaseError', async () => {
    mockGetOrCreateProvider.mockRejectedValueOnce(
      new MockDatabaseError('Internal failure', 'postgres', 'INTERNAL')
    );

    const req = createMockRequest('/api/db/provider-meta', {
      method: 'POST',
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe('Internal failure');
    expect(data.code).toBe('INTERNAL');
  });

  test('returns 500 for generic error', async () => {
    mockGetOrCreateProvider.mockRejectedValueOnce(
      new Error('Unexpected failure')
    );

    const req = createMockRequest('/api/db/provider-meta', {
      method: 'POST',
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe('Unexpected failure');
  });
});
