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
});
