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
      new ConnectionError('Connection refused')
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
      new DatabaseError('Internal failure', 'postgres', 'INTERNAL_ERROR')
    );

    const req = createMockRequest('/api/db/provider-meta', {
      method: 'POST',
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe('Internal failure');
    expect(data.code).toBe('INTERNAL_ERROR');
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
