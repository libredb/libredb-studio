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

// ─── Mock getSession for auth ───────────────────────────────────────────────
const mockGetSession = mock(async () => ({ role: 'admin' as const, username: 'admin' }));

// ─── Mock audit buffer ──────────────────────────────────────────────────────
const mockAuditPush = mock(() => ({
  id: '1',
  timestamp: new Date().toISOString(),
  type: 'maintenance',
  action: 'VACUUM',
  target: 'all',
  user: 'admin',
  result: 'success' as const,
}));

// ─── Mock dependencies BEFORE importing route ───────────────────────────────
mock.module('@/lib/auth', () => ({
  getSession: mockGetSession,
  signJWT: mock(async () => 'mock-token'),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

mock.module('@/lib/audit', () => ({
  getServerAuditBuffer: () => ({ push: mockAuditPush }),
  AuditRingBuffer: class {},
  loadAuditFromStorage: () => [],
  saveAuditToStorage: () => {},
}));

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
const { POST } = await import('@/app/api/db/maintenance/route');

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
describe('POST /api/db/maintenance', () => {
  beforeEach(() => {
    mockGetSession.mockClear();
    mockGetOrCreateProvider.mockClear();
    mockAuditPush.mockClear();
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockClear();
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockClear();

    // Reset implementations
    mockGetSession.mockImplementation(async () => ({ role: 'admin' as const, username: 'admin' }));
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider as never);
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementation(async () => ({
      success: true,
      executionTime: 100,
      message: 'OK',
    }));
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(() => ({
      queryLanguage: 'sql',
      supportsExplain: true,
      supportsExternalQueryLimiting: true,
      supportsCreateTable: true,
      supportsMaintenance: true,
      maintenanceOperations: ['vacuum', 'analyze', 'reindex'],
      supportsConnectionString: true,
      defaultPort: 5432,
      schemaRefreshPattern: '(?:CREATE|ALTER|DROP|TRUNCATE)\\s',
    }));
  });

  test('admin with valid params returns maintenance result', async () => {
    const req = createMockRequest('/api/db/maintenance', {
      method: 'POST',
      body: { type: 'vacuum', target: 'users', connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; executionTime: number; message: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.executionTime).toBe(100);
    expect(data.message).toBe('OK');
  });

  test('non-admin user returns 403', async () => {
    mockGetSession.mockImplementation(async () => ({ role: 'user' as const, username: 'user' }));

    const req = createMockRequest('/api/db/maintenance', {
      method: 'POST',
      body: { type: 'vacuum', target: 'users', connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(403);
    expect(data.error).toContain('Unauthorized');
  });

  test('no session returns 403', async () => {
    mockGetSession.mockImplementation(async () => null);

    const req = createMockRequest('/api/db/maintenance', {
      method: 'POST',
      body: { type: 'vacuum', target: 'users', connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(403);
    expect(data.error).toContain('Unauthorized');
  });

  test('missing connection returns 400', async () => {
    const req = createMockRequest('/api/db/maintenance', {
      method: 'POST',
      body: { type: 'vacuum', target: 'users' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('Connection is required');
  });

  test('missing type returns 400', async () => {
    const req = createMockRequest('/api/db/maintenance', {
      method: 'POST',
      body: { target: 'users', connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('Maintenance type is required');
  });

  test('provider without maintenance support returns 400', async () => {
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(() => ({
      queryLanguage: 'sql',
      supportsExplain: false,
      supportsExternalQueryLimiting: true,
      supportsCreateTable: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: 0,
      schemaRefreshPattern: '',
    }));

    const req = createMockRequest('/api/db/maintenance', {
      method: 'POST',
      body: { type: 'vacuum', target: 'users', connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('not supported');
  });

  test('unsupported operation type returns 400', async () => {
    const req = createMockRequest('/api/db/maintenance', {
      method: 'POST',
      body: { type: 'optimize', target: 'users', connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('not supported');
  });

  test('DatabaseError from runMaintenance returns 500', async () => {
    (mockProvider.runMaintenance as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new DatabaseError('Internal maintenance failure', 'postgres', 'MAINT_ERR');
    });

    const req = createMockRequest('/api/db/maintenance', {
      method: 'POST',
      body: { type: 'vacuum', target: 'users', connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toContain('Internal maintenance failure');
  });
});
