import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockRequest, parseResponseJSON } from '../../helpers/mock-next';
import { createMockProvider } from '../../helpers/mock-provider';

// ─── Mock provider ──────────────────────────────────────────────────────────
const mockProvider = createMockProvider();
const mockCreateDatabaseProvider = mock(async () => mockProvider);

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
  getOrCreateProvider: mock(async () => mockProvider),
  createDatabaseProvider: mockCreateDatabaseProvider,
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import('@/app/api/db/schema-snapshot/route');

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
describe('POST /api/db/schema-snapshot', () => {
  beforeEach(() => {
    mockCreateDatabaseProvider.mockClear();
    mockCreateDatabaseProvider.mockImplementation(async () => mockProvider);
    (mockProvider.connect as ReturnType<typeof mock>).mockClear();
    (mockProvider.disconnect as ReturnType<typeof mock>).mockClear();
    (mockProvider.getSchema as ReturnType<typeof mock>).mockClear();
    // Reset implementations
    (mockProvider.connect as ReturnType<typeof mock>).mockImplementation(async () => {});
    (mockProvider.disconnect as ReturnType<typeof mock>).mockImplementation(async () => {});
  });

  test('returns schema with metadata for valid connection', async () => {
    const req = createMockRequest('/api/db/schema-snapshot', {
      method: 'POST',
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      schema: unknown[];
      connectionId: string;
      connectionName: string;
      databaseType: string;
      timestamp: string;
    }>(res);

    expect(res.status).toBe(200);
    expect(data.schema).toBeArray();
    expect(data.connectionId).toBe('test-1');
    expect(data.connectionName).toBe('Test DB');
    expect(data.databaseType).toBe('postgres');
    expect(data.timestamp).toBeDefined();
  });

  test('returns 400 when connection is missing', async () => {
    const req = createMockRequest('/api/db/schema-snapshot', {
      method: 'POST',
      body: {},
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('required');
  });

  test('returns 500 when connect() fails', async () => {
    (mockProvider.connect as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('Connection refused')
    );

    const req = createMockRequest('/api/db/schema-snapshot', {
      method: 'POST',
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe('Connection refused');
  });

  test('returns 500 when getSchema() fails and disconnect is still called', async () => {
    (mockProvider.getSchema as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('Schema fetch failed')
    );

    const req = createMockRequest('/api/db/schema-snapshot', {
      method: 'POST',
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe('Schema fetch failed');
    // disconnect should be called in the error handler
    expect(mockProvider.disconnect).toHaveBeenCalled();
  });

  test('calls connect() and disconnect() on success', async () => {
    const req = createMockRequest('/api/db/schema-snapshot', {
      method: 'POST',
      body: { connection: validConnection },
    });

    await POST(req as never);

    expect(mockProvider.connect).toHaveBeenCalledTimes(1);
    expect(mockProvider.disconnect).toHaveBeenCalledTimes(1);
  });

  test('calls disconnect() in error handler when connect succeeds but getSchema fails', async () => {
    (mockProvider.connect as ReturnType<typeof mock>).mockImplementation(async () => {});
    (mockProvider.getSchema as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('Schema error')
    );
    (mockProvider.disconnect as ReturnType<typeof mock>).mockImplementation(async () => {});

    const req = createMockRequest('/api/db/schema-snapshot', {
      method: 'POST',
      body: { connection: validConnection },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(500);
    // disconnect should have been called in the catch block
    expect(mockProvider.disconnect).toHaveBeenCalled();
  });
});
