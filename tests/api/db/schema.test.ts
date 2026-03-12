import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockRequest, parseResponseJSON } from '../../helpers/mock-next';
import { createMockProvider } from '../../helpers/mock-provider';
import { mockSchema } from '../../fixtures/schemas';
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
const { POST } = await import('@/app/api/db/schema/route');

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
describe('POST /api/db/schema', () => {
  beforeEach(() => {
    mockGetOrCreateProvider.mockClear();
    (mockProvider.getSchema as ReturnType<typeof mock>).mockClear();
  });

  test('returns 200 with schema array for valid connection', async () => {
    const req = createMockRequest('/api/db/schema', {
      method: 'POST',
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<typeof mockSchema>(res);

    expect(res.status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(mockSchema.length);
    expect(data[0].name).toBe('users');
  });

  test('returns 400 for empty request body', async () => {
    const req = new Request('http://localhost:3000/api/db/schema', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('Empty request body');
  });

  test('returns 400 when connection has no type field', async () => {
    const req = createMockRequest('/api/db/schema', {
      method: 'POST',
      body: { host: 'localhost', database: 'testdb' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('required');
  });

  test('returns 503 for ConnectionError', async () => {
    mockGetOrCreateProvider.mockRejectedValueOnce(
      new ConnectionError('Connection refused')
    );

    const req = createMockRequest('/api/db/schema', {
      method: 'POST',
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(503);
    expect(data.error).toContain('Connection refused');
    expect(data.code).toBe('CONNECTION_ERROR');
  });

  test('returns 500 for DatabaseError', async () => {
    const dbError = new DatabaseError('Database internal error', 'postgres', 'INTERNAL_ERROR');
    mockGetOrCreateProvider.mockResolvedValueOnce(mockProvider);
    (mockProvider.getSchema as ReturnType<typeof mock>).mockRejectedValueOnce(dbError);

    const req = createMockRequest('/api/db/schema', {
      method: 'POST',
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe('Database internal error');
    expect(data.code).toBe('INTERNAL_ERROR');
  });

  test('returns 500 for generic error', async () => {
    (mockProvider.getSchema as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('Unexpected failure')
    );

    const req = createMockRequest('/api/db/schema', {
      method: 'POST',
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe('Unexpected failure');
  });
});
