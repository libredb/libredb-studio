import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockRequest, parseResponseJSON } from '../../helpers/mock-next';
import { createMockProvider } from '../../helpers/mock-provider';

// ─── Mock providers ─────────────────────────────────────────────────────────
const mockSQLProvider = createMockProvider({
  capabilities: { queryLanguage: 'sql' },
});

const mockMongoProvider = createMockProvider({
  capabilities: { queryLanguage: 'json' },
});

const mockGetOrCreateProvider = mock(async () => mockSQLProvider);

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
  createDatabaseProvider: mock(async () => mockSQLProvider),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import('@/app/api/db/profile/route');

// ─── Fixtures ───────────────────────────────────────────────────────────────
const validConnection = {
  id: 'test-1',
  name: 'Test DB',
  type: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'testdb',
};

const mongoConnection = {
  id: 'test-mongo',
  name: 'Test MongoDB',
  type: 'mongodb',
  connectionString: 'mongodb://localhost:27017/testdb',
};

// ─── Tests ──────────────────────────────────────────────────────────────────
describe('POST /api/db/profile', () => {
  beforeEach(() => {
    mockGetOrCreateProvider.mockClear();
    mockGetOrCreateProvider.mockImplementation(async () => mockSQLProvider);
    (mockSQLProvider.query as ReturnType<typeof mock>).mockClear();
    (mockMongoProvider.query as ReturnType<typeof mock>).mockClear();
  });

  test('returns column profiles for SQL provider with columns', async () => {
    // Mock SQL query responses - order matters:
    // 1st call: SELECT COUNT(*) as total FROM users
    // 2nd call: per-column profile query containing 'as column_name'
    // 3rd call: SELECT "id" FROM users LIMIT 5
    const sqlProvider = createMockProvider({ capabilities: { queryLanguage: 'sql' } });
    const mockQuery = mock(async (sql: string) => {
      if (sql.includes('as total') && !sql.includes('as column_name')) {
        return { rows: [{ total: 100 }], fields: ['total'], rowCount: 1, executionTime: 5 };
      }
      if (sql.includes('as column_name')) {
        return {
          rows: [{
            column_name: 'id',
            total_count: 100,
            non_null_count: 100,
            null_count: 0,
            distinct_count: 100,
            min_value: '1',
            max_value: '100',
          }],
          fields: ['column_name', 'total_count', 'non_null_count', 'null_count', 'distinct_count', 'min_value', 'max_value'],
          rowCount: 1,
          executionTime: 5,
        };
      }
      // sample query
      return { rows: [{ id: 1 }], fields: ['id'], rowCount: 1, executionTime: 5 };
    });
    (sqlProvider.query as ReturnType<typeof mock>).mockImplementation(mockQuery);
    mockGetOrCreateProvider.mockResolvedValueOnce(sqlProvider);

    const req = createMockRequest('/api/db/profile', {
      method: 'POST',
      body: { connection: validConnection, tableName: 'users', columns: ['id'] },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      tableName: string;
      totalRows: number;
      columns: { name: string; totalRows: number; nullCount: number; distinctCount: number }[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.tableName).toBe('users');
    expect(data.totalRows).toBe(100);
    expect(data.columns).toBeArray();
    expect(data.columns.length).toBeGreaterThan(0);
    expect(data.columns[0].name).toBe('id');
  });

  test('returns 400 for SQL provider with no columns', async () => {
    const req = createMockRequest('/api/db/profile', {
      method: 'POST',
      body: { connection: validConnection, tableName: 'users', columns: [] },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('No columns');
  });

  test('returns column profiles for MongoDB provider', async () => {
    const mongoProvider = createMockProvider({
      capabilities: { queryLanguage: 'json' },
    });
    (mongoProvider.query as ReturnType<typeof mock>).mockImplementation(async (queryStr: string) => {
      const parsed = JSON.parse(queryStr);
      if (parsed.operation === 'aggregate') {
        return {
          rows: [
            { status: 'active', name: 'Alice' },
            { status: 'inactive', name: 'Bob' },
          ],
          fields: ['status', 'name'],
          rowCount: 2,
          executionTime: 5,
        };
      }
      if (parsed.operation === 'countDocuments') {
        return { rows: [{ count: 50 }], fields: ['count'], rowCount: 1, executionTime: 3 };
      }
      return { rows: [], fields: [], rowCount: 0, executionTime: 1 };
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(mongoProvider);

    const req = createMockRequest('/api/db/profile', {
      method: 'POST',
      body: { connection: mongoConnection, tableName: 'users', columns: ['status', 'name'] },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      tableName: string;
      totalRows: number;
      columns: { name: string; nullCount: number; distinctCount: number }[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.tableName).toBe('users');
    expect(data.totalRows).toBe(50);
    expect(data.columns).toBeArray();
    expect(data.columns.length).toBe(2);
  });

  test('returns 400 when connection is missing', async () => {
    const req = createMockRequest('/api/db/profile', {
      method: 'POST',
      body: { tableName: 'users', columns: ['id'] },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('required');
  });

  test('returns 400 when tableName is missing', async () => {
    const req = createMockRequest('/api/db/profile', {
      method: 'POST',
      body: { connection: validConnection, columns: ['id'] },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain('required');
  });

  test('returns 500 on error', async () => {
    mockGetOrCreateProvider.mockRejectedValueOnce(
      new Error('Database unavailable')
    );

    const req = createMockRequest('/api/db/profile', {
      method: 'POST',
      body: { connection: validConnection, tableName: 'users', columns: ['id'] },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe('Database unavailable');
  });

  test('SQL sample values included for top 5 columns', async () => {
    const sqlProvider = createMockProvider({ capabilities: { queryLanguage: 'sql' } });
    (sqlProvider.query as ReturnType<typeof mock>).mockImplementation(async (sql: string) => {
      if (sql.includes('as total') && !sql.includes('as column_name')) {
        return { rows: [{ total: 50 }], fields: ['total'], rowCount: 1, executionTime: 5 };
      }
      if (sql.includes('as column_name')) {
        // Extract column name from the SQL pattern: 'colname' as column_name
        const match = sql.match(/'([^']+)' as column_name/);
        const colName = match ? match[1] : 'unknown';
        return {
          rows: [{
            column_name: colName,
            total_count: 50,
            non_null_count: 48,
            null_count: 2,
            distinct_count: 30,
            min_value: 'a',
            max_value: 'z',
          }],
          fields: ['column_name', 'total_count', 'non_null_count', 'null_count', 'distinct_count', 'min_value', 'max_value'],
          rowCount: 1,
          executionTime: 5,
        };
      }
      // Sample query (SELECT "name", "email" FROM users LIMIT 5)
      return {
        rows: [
          { name: 'Alice', email: 'alice@test.com' },
          { name: 'Bob', email: 'bob@test.com' },
        ],
        fields: ['name', 'email'],
        rowCount: 2,
        executionTime: 3,
      };
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(sqlProvider);

    const req = createMockRequest('/api/db/profile', {
      method: 'POST',
      body: { connection: validConnection, tableName: 'users', columns: ['name', 'email'] },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      columns: { name: string; sampleValues?: string[] }[];
    }>(res);

    expect(res.status).toBe(200);
    const nameProfile = data.columns.find(c => c.name === 'name');
    expect(nameProfile).toBeDefined();
    expect(nameProfile!.sampleValues).toBeArray();
  });

  test('SQL column profiling error is gracefully handled', async () => {
    const sqlProvider = createMockProvider({ capabilities: { queryLanguage: 'sql' } });
    let profileCallIdx = 0;
    (sqlProvider.query as ReturnType<typeof mock>).mockImplementation(async (sql: string) => {
      if (sql.includes('as total') && !sql.includes('as column_name')) {
        return { rows: [{ total: 100 }], fields: ['total'], rowCount: 1, executionTime: 5 };
      }
      if (sql.includes('as column_name')) {
        profileCallIdx++;
        if (profileCallIdx === 1) {
          throw new Error('Cannot profile binary column');
        }
        return {
          rows: [{
            column_name: 'name',
            total_count: 100,
            non_null_count: 100,
            null_count: 0,
            distinct_count: 50,
            min_value: 'a',
            max_value: 'z',
          }],
          fields: ['column_name', 'total_count', 'non_null_count', 'null_count', 'distinct_count', 'min_value', 'max_value'],
          rowCount: 1,
          executionTime: 5,
        };
      }
      return { rows: [], fields: [], rowCount: 0, executionTime: 1 };
    });
    mockGetOrCreateProvider.mockResolvedValueOnce(sqlProvider);

    const req = createMockRequest('/api/db/profile', {
      method: 'POST',
      body: { connection: validConnection, tableName: 'users', columns: ['binary_col', 'name'] },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      columns: { name: string; error?: string }[];
    }>(res);

    expect(res.status).toBe(200);
    // The first column should have an error fallback
    const errorCol = data.columns.find(c => c.error);
    expect(errorCol).toBeDefined();
    expect(errorCol!.error).toContain('Could not profile');
  });
});
