import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockRequest, parseResponseJSON } from '../../helpers/mock-next';
import { createMockProvider } from '../../helpers/mock-provider';
import { mockSchema } from '../../fixtures/schemas';
import type { TableSchema } from '@/lib/types';
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

// A provider may optionally implement getSchemaList(); the mock helper does not,
// so we treat the instance as augmentable to test both the fast path and the
// getSchema() fallback the route relies on for non-postgres providers.
type AugmentedProvider = ReturnType<typeof createMockProvider> & {
  getSchemaList?: ReturnType<typeof mock>;
};

// ─── Mock provider ──────────────────────────────────────────────────────────
const mockProvider = createMockProvider() as AugmentedProvider;
const mockGetOrCreateProvider = mock(async () => mockProvider);

// ─── Mock auth + seed resolution BEFORE importing the route ─────────────────
const mockGetSession = mock(async () => ({ role: 'admin', username: 'admin' }) as unknown);
mock.module('@/lib/auth', () => ({
  getSession: mockGetSession,
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

// ─── Mock @/lib/db BEFORE importing the route ───────────────────────────────
mock.module('@/lib/db', () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(),
  removeProvider: mock(),
  clearProviderCache: mock(),
  getProviderCacheStats: mock(),
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
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import('@/app/api/db/schema/list/route');

// ─── Fixtures ───────────────────────────────────────────────────────────────
const validConnection = {
  id: 'test-1',
  name: 'Test DB',
  type: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'testdb',
};

// A "list-only" schema: tables + columns + PKs, but no relations (indexes/FKs),
// mirroring what getSchemaList() actually returns.
const listSchema: TableSchema[] = [
  {
    name: 'users',
    columns: [{ name: 'id', type: 'integer', nullable: false, isPrimary: true }],
    indexes: [],
    foreignKeys: [],
    rowCount: 10,
    size: '16 kB',
  },
];

// ─── Tests ──────────────────────────────────────────────────────────────────
describe('POST /api/db/schema/list', () => {
  beforeEach(() => {
    mockGetOrCreateProvider.mockClear();
    mockGetSession.mockClear();
    (mockProvider.getSchema as ReturnType<typeof mock>).mockClear();
    // Default: provider exposes the fast path.
    mockProvider.getSchemaList = mock(async () => listSchema);
  });

  test('returns 200 and uses getSchemaList() when the provider implements it', async () => {
    const req = createMockRequest('/api/db/schema/list', { method: 'POST', body: validConnection });

    const res = await POST(req as never);
    const data = await parseResponseJSON<TableSchema[]>(res);

    expect(res.status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data[0].name).toBe('users');
    // Fast path was taken, full getSchema() was NOT called.
    expect(mockProvider.getSchemaList).toHaveBeenCalledTimes(1);
    expect(mockProvider.getSchema as ReturnType<typeof mock>).toHaveBeenCalledTimes(0);
  });

  test('falls back to getSchema() when the provider has no fast path', async () => {
    // Simulate a provider (e.g. mysql/sqlite) that never implemented getSchemaList.
    delete mockProvider.getSchemaList;

    const req = createMockRequest('/api/db/schema/list', { method: 'POST', body: validConnection });

    const res = await POST(req as never);
    const data = await parseResponseJSON<typeof mockSchema>(res);

    expect(res.status).toBe(200);
    expect(data.length).toBe(mockSchema.length);
    expect(mockProvider.getSchema as ReturnType<typeof mock>).toHaveBeenCalledTimes(1);
  });

  test('returns 400 for empty request body', async () => {
    const req = new Request('http://localhost:3000/api/db/schema/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('Empty request body');
  });

  test('returns 401 when there is no session', async () => {
    mockGetSession.mockResolvedValueOnce(null as unknown as { role: string; username: string });

    const req = createMockRequest('/api/db/schema/list', { method: 'POST', body: validConnection });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(data.error).toContain('Authentication required');
    // Must short-circuit before touching the database.
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(0);
  });

  test('returns 400 when connection has no type field', async () => {
    const req = createMockRequest('/api/db/schema/list', {
      method: 'POST',
      body: { host: 'localhost', database: 'testdb' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('required');
  });

  test('returns 503 for ConnectionError', async () => {
    mockGetOrCreateProvider.mockRejectedValueOnce(new ConnectionError('Connection refused'));

    const req = createMockRequest('/api/db/schema/list', { method: 'POST', body: validConnection });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(503);
    expect(data.error).toContain('Connection refused');
    expect(data.code).toBe('CONNECTION_ERROR');
  });

  test('returns 500 for DatabaseError raised by getSchemaList', async () => {
    mockProvider.getSchemaList = mock(async () => {
      throw new DatabaseError('Database internal error', 'postgres', 'INTERNAL_ERROR');
    });

    const req = createMockRequest('/api/db/schema/list', { method: 'POST', body: validConnection });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe('Database internal error');
    expect(data.code).toBe('INTERNAL_ERROR');
  });

  test('returns 500 for a generic error', async () => {
    mockProvider.getSchemaList = mock(async () => {
      throw new Error('Unexpected failure');
    });

    const req = createMockRequest('/api/db/schema/list', { method: 'POST', body: validConnection });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe('Unexpected failure');
  });
});
