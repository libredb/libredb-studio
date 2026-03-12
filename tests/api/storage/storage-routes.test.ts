import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';

// ── Mock auth ────────────────────────────────────────────────────────────────

let mockSession: { username: string; role: string } | null = { username: 'admin@test.com', role: 'admin' };

mock.module('@/lib/auth', () => ({
  getSession: async () => mockSession,
}));

// ── Mock storage factory ─────────────────────────────────────────────────────

const mockProvider = {
  getAllData: mock(async () => ({
    connections: [{ id: 'c1' }],
  })),
  getCollection: mock(async () => [{ id: 'c1' }]),
  setCollection: mock(async () => {}),
  mergeData: mock(async () => {}),
};

let providerEnabled = true;

mock.module('@/lib/storage/factory', () => ({
  getStorageProvider: async () => (providerEnabled ? mockProvider : null),
}));

mock.module('@/lib/storage/types', () => ({
  STORAGE_COLLECTIONS: [
    'connections', 'history', 'saved_queries', 'schema_snapshots',
    'saved_charts', 'active_connection_id', 'audit_log',
    'masking_config', 'threshold_config',
  ],
}));

// ── Import routes ────────────────────────────────────────────────────────────

import { GET } from '@/app/api/storage/route';
import { PUT } from '@/app/api/storage/[collection]/route';
import { POST } from '@/app/api/storage/migrate/route';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/storage', () => {
  beforeEach(() => {
    mockSession = { username: 'admin@test.com', role: 'admin' };
    providerEnabled = true;
    mockProvider.getAllData.mockClear();
  });

  test('returns 404 when storage not enabled', async () => {
    providerEnabled = false;
    const res = await GET();
    expect(res.status).toBe(404);
  });

  test('returns 401 when not authenticated', async () => {
    mockSession = null;
    const res = await GET();
    expect(res.status).toBe(401);
  });

  test('returns user data on success', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.connections).toEqual([{ id: 'c1' }]);
    expect(mockProvider.getAllData).toHaveBeenCalledWith('admin@test.com');
  });
});

describe('PUT /api/storage/[collection]', () => {
  beforeEach(() => {
    mockSession = { username: 'admin@test.com', role: 'admin' };
    providerEnabled = true;
    mockProvider.setCollection.mockClear();
  });

  function makeRequest(collection: string, data: unknown) {
    return PUT(
      new NextRequest(`http://localhost/api/storage/${collection}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      }),
      { params: Promise.resolve({ collection }) }
    );
  }

  test('returns 404 when storage not enabled', async () => {
    providerEnabled = false;
    const res = await makeRequest('connections', []);
    expect(res.status).toBe(404);
  });

  test('returns 401 when not authenticated', async () => {
    mockSession = null;
    const res = await makeRequest('connections', []);
    expect(res.status).toBe(401);
  });

  test('returns 400 for invalid collection', async () => {
    const res = await makeRequest('invalid_collection', []);
    expect(res.status).toBe(400);
  });

  test('updates collection on success', async () => {
    const data = [{ id: 'c1', name: 'New DB' }];
    const res = await makeRequest('connections', data);
    expect(res.status).toBe(200);
    expect(mockProvider.setCollection).toHaveBeenCalledWith(
      'admin@test.com',
      'connections',
      data
    );
  });
});

describe('POST /api/storage/migrate', () => {
  beforeEach(() => {
    mockSession = { username: 'admin@test.com', role: 'admin' };
    providerEnabled = true;
    mockProvider.mergeData.mockClear();
  });

  function makeMigrateRequest(data: Record<string, unknown>) {
    return POST(
      new NextRequest('http://localhost/api/storage/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
    );
  }

  test('returns 404 when storage not enabled', async () => {
    providerEnabled = false;
    const res = await makeMigrateRequest({});
    expect(res.status).toBe(404);
  });

  test('returns 401 when not authenticated', async () => {
    mockSession = null;
    const res = await makeMigrateRequest({});
    expect(res.status).toBe(401);
  });

  test('merges data on success', async () => {
    const data = { connections: [{ id: 'c1' }], history: [] };
    const res = await makeMigrateRequest(data);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.migrated).toContain('connections');
    expect(json.migrated).toContain('history');
    expect(mockProvider.mergeData).toHaveBeenCalledWith('admin@test.com', data);
  });

  test('returns empty migrated array for empty payload', async () => {
    const res = await makeMigrateRequest({});
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.migrated).toEqual([]);
  });
});

// ── Error propagation from provider ────────────────────────────────────────

describe('API routes: provider error propagation', () => {
  beforeEach(() => {
    mockSession = { username: 'admin@test.com', role: 'admin' };
    providerEnabled = true;
    mockProvider.getAllData.mockClear();
    mockProvider.setCollection.mockClear();
    mockProvider.mergeData.mockClear();
  });

  test('GET /api/storage returns 500 on provider error', async () => {
    mockProvider.getAllData.mockRejectedValueOnce(new Error('DB connection lost'));
    const res = await GET();
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('DB connection lost');
  });

  test('PUT collection response includes ok:true on success', async () => {
    const res = await PUT(
      new NextRequest('http://localhost/api/storage/connections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [{ id: 'c1' }] }),
      }),
      { params: Promise.resolve({ collection: 'connections' }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  test('PUT uses session username for user scoping', async () => {
    mockSession = { username: 'user@test.com', role: 'user' };
    const data = [{ id: 'c1' }];
    await PUT(
      new NextRequest('http://localhost/api/storage/connections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      }),
      { params: Promise.resolve({ collection: 'connections' }) }
    );
    expect(mockProvider.setCollection).toHaveBeenCalledWith('user@test.com', 'connections', data);
  });

  test('GET uses session username for user scoping', async () => {
    mockSession = { username: 'user@test.com', role: 'user' };
    await GET();
    expect(mockProvider.getAllData).toHaveBeenCalledWith('user@test.com');
  });

  test('PUT validates all 9 valid collection names', async () => {
    const validCollections = [
      'connections', 'history', 'saved_queries', 'schema_snapshots',
      'saved_charts', 'active_connection_id', 'audit_log',
      'masking_config', 'threshold_config',
    ];

    for (const collection of validCollections) {
      mockProvider.setCollection.mockClear();
      const res = await PUT(
        new NextRequest(`http://localhost/api/storage/${collection}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: [] }),
        }),
        { params: Promise.resolve({ collection }) }
      );
      expect(res.status).toBe(200);
    }
  });

  test('PUT rejects collection names not in whitelist', async () => {
    const invalidNames = ['settings', 'users', 'passwords', '../connections', 'CONNECTIONS'];
    for (const name of invalidNames) {
      const res = await PUT(
        new NextRequest(`http://localhost/api/storage/${name}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: [] }),
        }),
        { params: Promise.resolve({ collection: name }) }
      );
      expect(res.status).toBe(400);
    }
  });

  test('migrate uses session username for user scoping', async () => {
    mockSession = { username: 'user@test.com', role: 'user' };
    await POST(
      new NextRequest('http://localhost/api/storage/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connections: [] }),
      })
    );
    expect(mockProvider.mergeData).toHaveBeenCalledWith('user@test.com', { connections: [] });
  });
});
