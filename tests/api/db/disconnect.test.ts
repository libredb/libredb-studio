import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockRequest, parseResponseJSON } from '../../helpers/mock-next';
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

const mockRemoveProvider = mock(async () => {});

mock.module('@/lib/db/factory', () => ({
  createDatabaseProvider: mock(async () => ({})),
  getOrCreateProvider: mock(async () => ({})),
  removeProvider: mockRemoveProvider,
  clearProviderCache: mock(async () => {}),
  getProviderCacheStats: mock(() => ({ size: 0, connections: [] })),
  registerShutdownHandlers: mock(() => {}),
}));

mock.module('@/lib/db', () => ({
  createDatabaseProvider: mock(async () => ({})),
  getOrCreateProvider: mock(async () => ({})),
  removeProvider: mockRemoveProvider,
  clearProviderCache: mock(async () => {}),
  getProviderCacheStats: mock(() => ({ size: 0, connections: [] })),
  registerShutdownHandlers: mock(() => {}),
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
}));

mock.module('@/lib/logger', () => ({
  logger: {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  },
}));

const { POST } = await import('@/app/api/db/disconnect/route');

beforeEach(() => {
  mockRemoveProvider.mockClear();
});

describe('POST /api/db/disconnect', () => {
  test('returns 400 when connectionId is missing', async () => {
    const req = createMockRequest('/api/db/disconnect', {
      method: 'POST',
      body: {},
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error).toBe('connectionId is required');
  });

  test('returns 400 when connectionId is not a string', async () => {
    const req = createMockRequest('/api/db/disconnect', {
      method: 'POST',
      body: { connectionId: 123 },
    });

    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  test('calls removeProvider and returns success', async () => {
    const req = createMockRequest('/api/db/disconnect', {
      method: 'POST',
      body: { connectionId: 'conn-123' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(mockRemoveProvider).toHaveBeenCalledWith('conn-123');
  });

  test('returns 500 when removeProvider throws', async () => {
    mockRemoveProvider.mockImplementationOnce(async () => {
      throw new Error('disconnect failed');
    });

    const req = createMockRequest('/api/db/disconnect', {
      method: 'POST',
      body: { connectionId: 'conn-fail' },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.success).toBe(false);
  });
});
