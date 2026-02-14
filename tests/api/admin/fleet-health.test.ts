import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockRequest, parseResponseJSON } from '../../helpers/mock-next';
import { createMockProvider } from '../../helpers/mock-provider';

// ─── Mock provider ──────────────────────────────────────────────────────────
const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider);
const mockGetSession = mock(async () => ({ role: 'admin', username: 'admin' }));

// ─── Mock @/lib/auth BEFORE importing the route ─────────────────────────────
mock.module('@/lib/auth', () => ({
  getSession: mockGetSession,
  signJWT: mock(async () => 'mock-token'),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

// ─── Mock @/lib/db BEFORE importing the route ───────────────────────────────
mock.module('@/lib/db', () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(),
  removeProvider: mock(),
  clearProviderCache: mock(),
  getProviderCacheStats: mock(),
  ConnectionError: class extends Error { constructor(m: string) { super(m); this.name = 'ConnectionError'; } },
  DatabaseError: class extends Error { constructor(m: string) { super(m); this.name = 'DatabaseError'; } },
  isDatabaseError: mock(() => false),
  isConnectionError: mock(() => false),
  isQueryError: mock(() => false),
  isTimeoutError: mock(() => false),
  isAuthenticationError: mock(() => false),
  isRetryableError: mock(() => false),
  mapDatabaseError: mock(),
  BaseDatabaseProvider: class {},
  DemoProvider: class {},
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import('@/app/api/admin/fleet-health/route');

// ─── Fixtures ───────────────────────────────────────────────────────────────
const connections = [
  { id: 'conn-1', name: 'Production DB', type: 'postgres', host: 'prod.example.com', port: 5432, database: 'prod', createdAt: new Date() },
  { id: 'conn-2', name: 'Staging DB', type: 'mysql', host: 'staging.example.com', port: 3306, database: 'staging', createdAt: new Date() },
];

// ─── Tests ──────────────────────────────────────────────────────────────────
describe('POST /api/admin/fleet-health', () => {
  beforeEach(() => {
    mockGetSession.mockClear();
    mockGetOrCreateProvider.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: 'admin', username: 'admin' }));
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider);
    (mockProvider.getHealth as ReturnType<typeof mock>).mockClear();
  });

  test('returns health results for all connections as admin', async () => {
    const req = createMockRequest('/api/admin/fleet-health', {
      method: 'POST',
      body: { connections },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{
      results: { connectionId: string; connectionName: string; status: string; latencyMs: number }[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.results).toBeArray();
    expect(data.results.length).toBe(2);
    expect(data.results[0].connectionId).toBe('conn-1');
    expect(data.results[0].connectionName).toBe('Production DB');
    expect(data.results[0].status).toBe('healthy');
    expect(data.results[0].latencyMs).toBeDefined();
  });

  test('returns 403 for non-admin user', async () => {
    mockGetSession.mockResolvedValueOnce({ role: 'user', username: 'user' });

    const req = createMockRequest('/api/admin/fleet-health', {
      method: 'POST',
      body: { connections },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(403);
    expect(data.error).toContain('Unauthorized');
  });

  test('returns 403 when no session exists', async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = createMockRequest('/api/admin/fleet-health', {
      method: 'POST',
      body: { connections },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(403);
    expect(data.error).toContain('Unauthorized');
  });

  test('returns 400 when connections is missing', async () => {
    const req = createMockRequest('/api/admin/fleet-health', {
      method: 'POST',
      body: {},
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('connections');
  });

  test('connection error results in error status for that item', async () => {
    let callCount = 0;
    mockGetOrCreateProvider.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Connection refused');
      }
      return mockProvider;
    });

    const req = createMockRequest('/api/admin/fleet-health', {
      method: 'POST',
      body: { connections },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{
      results: { connectionId: string; status: string; error?: string }[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.results.length).toBe(2);
    const errorItem = data.results.find(r => r.status === 'error');
    expect(errorItem).toBeDefined();
    expect(errorItem!.error).toContain('Connection refused');
  });

  test('empty connections array returns empty results', async () => {
    const req = createMockRequest('/api/admin/fleet-health', {
      method: 'POST',
      body: { connections: [] },
    });

    const res = await POST(req);
    const data = await parseResponseJSON<{
      results: unknown[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.results).toBeArray();
    expect(data.results.length).toBe(0);
  });
});
