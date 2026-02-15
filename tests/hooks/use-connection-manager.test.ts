import '../setup-dom';
import { mockToastSuccess, mockToastError } from '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { renderHook, act, waitFor } from '@testing-library/react';
import { mockGlobalFetch, restoreGlobalFetch } from '../helpers/mock-fetch';

import { useConnectionManager } from '@/hooks/use-connection-manager';
import { storage } from '@/lib/storage';
import type { DatabaseConnection, TableSchema } from '@/lib/types';

// ── Test Data ───────────────────────────────────────────────────────────────

const makeConnection = (overrides: Partial<DatabaseConnection> = {}): DatabaseConnection => ({
  id: 'conn-1',
  name: 'Test DB',
  type: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'admin',
  password: 'secret',
  createdAt: new Date('2026-01-01'),
  ...overrides,
});

const makeSchema = (): TableSchema[] => [
  {
    name: 'users',
    columns: [
      { name: 'id', type: 'integer', nullable: false, isPrimary: true },
      { name: 'email', type: 'varchar', nullable: false, isPrimary: false },
    ],
    indexes: [{ name: 'users_pkey', columns: ['id'], unique: true }],
    rowCount: 100,
  },
  {
    name: 'orders',
    columns: [
      { name: 'id', type: 'integer', nullable: false, isPrimary: true },
      { name: 'user_id', type: 'integer', nullable: false, isPrimary: false },
    ],
    indexes: [{ name: 'orders_pkey', columns: ['id'], unique: true }],
    rowCount: 500,
  },
];

// =============================================================================
// useConnectionManager Tests
// =============================================================================
describe('useConnectionManager', () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    localStorage.clear();
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  // ── Initial State ─────────────────────────────────────────────────────────

  test('starts with empty connections and null activeConnection', () => {
    mockGlobalFetch({
      '/api/demo-connection': { ok: false, status: 404, json: {} },
    });

    const { result } = renderHook(() => useConnectionManager());

    expect(result.current.connections).toEqual([]);
    expect(result.current.activeConnection).toBeNull();
    expect(result.current.schema).toEqual([]);
    expect(result.current.isLoadingSchema).toBe(false);
    expect(result.current.connectionPulse).toBeNull();
  });

  // ── Load from localStorage ────────────────────────────────────────────────

  test('loads connections from localStorage on mount', async () => {
    const conn = makeConnection();
    storage.saveConnection(conn);

    mockGlobalFetch({
      '/api/demo-connection': { ok: false, status: 404, json: {} },
      '/api/db/health': { ok: true, json: { status: 'healthy' } },
    });

    const { result } = renderHook(() => useConnectionManager());

    await waitFor(() => {
      expect(result.current.connections.length).toBe(1);
    });

    expect(result.current.connections[0].id).toBe('conn-1');
    expect(result.current.connections[0].name).toBe('Test DB');
  });

  // ── Demo Connection ───────────────────────────────────────────────────────

  test('fetches /api/demo-connection and adds demo if enabled', async () => {
    const demoConn: DatabaseConnection = makeConnection({
      id: 'demo-1',
      name: 'Demo DB',
      isDemo: true,
    });

    mockGlobalFetch({
      '/api/demo-connection': {
        ok: true,
        json: { enabled: true, connection: { ...demoConn, createdAt: demoConn.createdAt.toISOString() } },
      },
    });

    const { result } = renderHook(() => useConnectionManager());

    await waitFor(() => {
      expect(result.current.connections.length).toBe(1);
    });

    expect(result.current.connections[0].id).toBe('demo-1');
    expect(result.current.connections[0].isDemo).toBe(true);
  });

  // ── Active Connection from Persisted ID ───────────────────────────────────

  test('sets activeConnection from persisted active ID', async () => {
    const conn1 = makeConnection({ id: 'conn-1', name: 'DB One' });
    const conn2 = makeConnection({ id: 'conn-2', name: 'DB Two' });
    storage.saveConnection(conn1);
    storage.saveConnection(conn2);
    storage.setActiveConnectionId('conn-2');

    mockGlobalFetch({
      '/api/demo-connection': { ok: false, status: 404, json: {} },
      '/api/db/health': { ok: true, json: { status: 'healthy' } },
    });

    const { result } = renderHook(() => useConnectionManager());

    await waitFor(() => {
      expect(result.current.activeConnection).not.toBeNull();
    });

    expect(result.current.activeConnection!.id).toBe('conn-2');
    expect(result.current.activeConnection!.name).toBe('DB Two');
  });

  // ── First Connection as Fallback ──────────────────────────────────────────

  test('sets first connection as active if no persisted ID', async () => {
    const conn1 = makeConnection({ id: 'conn-1', name: 'DB One' });
    const conn2 = makeConnection({ id: 'conn-2', name: 'DB Two' });
    storage.saveConnection(conn1);
    storage.saveConnection(conn2);
    // No setActiveConnectionId call — no persisted ID

    mockGlobalFetch({
      '/api/demo-connection': { ok: false, status: 404, json: {} },
      '/api/db/health': { ok: true, json: { status: 'healthy' } },
    });

    const { result } = renderHook(() => useConnectionManager());

    await waitFor(() => {
      expect(result.current.activeConnection).not.toBeNull();
    });

    expect(result.current.activeConnection!.id).toBe('conn-1');
  });

  // ── fetchSchema success ───────────────────────────────────────────────────

  test('fetchSchema calls /api/db/schema POST and sets schema', async () => {
    const schemaData = makeSchema();

    const fetchMock = mockGlobalFetch({
      '/api/demo-connection': { ok: false, status: 404, json: {} },
      '/api/db/schema': { ok: true, json: schemaData },
    });

    const { result } = renderHook(() => useConnectionManager());

    const conn = makeConnection();
    await act(async () => {
      await result.current.fetchSchema(conn);
    });

    expect(result.current.schema).toEqual(schemaData);
    expect(result.current.isLoadingSchema).toBe(false);

    // Verify fetch was called with POST and connection body
    const schemaCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/schema')
    );
    expect(schemaCall).toBeDefined();
    expect(schemaCall![1]?.method).toBe('POST');
  });

  // ── fetchSchema error ─────────────────────────────────────────────────────

  test('fetchSchema shows toast on error', async () => {
    mockGlobalFetch({
      '/api/demo-connection': { ok: false, status: 404, json: {} },
      '/api/db/schema': { ok: false, status: 500, json: { error: 'Connection refused' } },
    });

    const { result } = renderHook(() => useConnectionManager());

    const conn = makeConnection();
    await act(async () => {
      await result.current.fetchSchema(conn);
    });

    expect(result.current.schema).toEqual([]);
    expect(result.current.isLoadingSchema).toBe(false);

    // useToast calls sonnerToast.error for destructive variant
    expect(mockToastError).toHaveBeenCalledWith(
      'Schema Error',
      { description: 'Connection refused' }
    );
  });

  // ── tableNames derived value ──────────────────────────────────────────────

  test('tableNames returns array of table name strings', async () => {
    const schemaData = makeSchema();

    mockGlobalFetch({
      '/api/demo-connection': { ok: false, status: 404, json: {} },
      '/api/db/schema': { ok: true, json: schemaData },
    });

    const { result } = renderHook(() => useConnectionManager());

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(result.current.tableNames).toEqual(['users', 'orders']);
  });

  // ── schemaContext derived value ────────────────────────────────────────────

  test('schemaContext is JSON string of schema', async () => {
    const schemaData = makeSchema();

    mockGlobalFetch({
      '/api/demo-connection': { ok: false, status: 404, json: {} },
      '/api/db/schema': { ok: true, json: schemaData },
    });

    const { result } = renderHook(() => useConnectionManager());

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(result.current.schemaContext).toBe(JSON.stringify(schemaData));
  });

  // ── isLoadingSchema during fetch ──────────────────────────────────────────

  test('isLoadingSchema is true during fetch, false after', async () => {
    let resolveSchema: ((value: Response) => void) | undefined;
    const schemaPromise = new Promise<Response>((resolve) => {
      resolveSchema = resolve;
    });

    // Use a custom fetch that holds the schema call
    mockGlobalFetch({
      '/api/demo-connection': { ok: false, status: 404, json: {} },
    });

    const originalMockedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/db/schema')) {
        return schemaPromise;
      }
      return originalMockedFetch(input, init);
    }) as typeof fetch;

    const { result } = renderHook(() => useConnectionManager());

    // Start fetching schema
    let fetchPromise: Promise<void>;
    act(() => {
      fetchPromise = result.current.fetchSchema(makeConnection());
    });

    // isLoadingSchema should be true while waiting
    expect(result.current.isLoadingSchema).toBe(true);

    // Resolve the schema request
    resolveSchema!(new Response(JSON.stringify(makeSchema()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await act(async () => {
      await fetchPromise!;
    });

    expect(result.current.isLoadingSchema).toBe(false);
  });

  // ── setActiveConnection persists to storage ───────────────────────────────

  test('setActiveConnection persists to storage', async () => {
    mockGlobalFetch({
      '/api/demo-connection': { ok: false, status: 404, json: {} },
      '/api/db/health': { ok: true, json: { status: 'healthy' } },
    });

    const { result } = renderHook(() => useConnectionManager());

    const conn = makeConnection({ id: 'new-conn-42' });

    await act(async () => {
      result.current.setActiveConnection(conn);
    });

    await waitFor(() => {
      expect(storage.getActiveConnectionId()).toBe('new-conn-42');
    });
  });

  // ── setConnections updates array ──────────────────────────────────────────

  test('setConnections updates connections array', async () => {
    mockGlobalFetch({
      '/api/demo-connection': { ok: false, status: 404, json: {} },
    });

    const { result } = renderHook(() => useConnectionManager());

    const newConns = [
      makeConnection({ id: 'a', name: 'Alpha' }),
      makeConnection({ id: 'b', name: 'Beta' }),
    ];

    act(() => {
      result.current.setConnections(newConns);
    });

    expect(result.current.connections).toHaveLength(2);
    expect(result.current.connections[0].name).toBe('Alpha');
    expect(result.current.connections[1].name).toBe('Beta');
  });

  // ── connectionPulse healthy ───────────────────────────────────────────────

  test('connectionPulse is healthy when health check succeeds', async () => {
    const conn = makeConnection();
    storage.saveConnection(conn);

    mockGlobalFetch({
      '/api/demo-connection': { ok: false, status: 404, json: {} },
      '/api/db/health': { ok: true, json: { status: 'healthy' } },
    });

    const { result } = renderHook(() => useConnectionManager());

    await waitFor(() => {
      expect(result.current.connectionPulse).toBe('healthy');
    });
  });

  // ── connectionPulse null for demo ─────────────────────────────────────────

  test('connectionPulse is null for demo connections', async () => {
    const demoConn = makeConnection({ id: 'demo-1', name: 'Demo', isDemo: true });

    mockGlobalFetch({
      '/api/demo-connection': {
        ok: true,
        json: { enabled: true, connection: { ...demoConn, createdAt: demoConn.createdAt.toISOString() } },
      },
    });

    const { result } = renderHook(() => useConnectionManager());

    await waitFor(() => {
      expect(result.current.activeConnection).not.toBeNull();
    });

    // Demo connections skip health check
    expect(result.current.connectionPulse).toBeNull();
  });

  // ── fetchSchema demo error message ────────────────────────────────────────

  test('fetchSchema shows demo-specific error for demo connections', async () => {
    mockGlobalFetch({
      '/api/demo-connection': { ok: false, status: 404, json: {} },
      '/api/db/schema': { ok: false, status: 500, json: { error: 'Timeout' } },
    });

    const { result } = renderHook(() => useConnectionManager());

    const demoConn = makeConnection({ id: 'demo-1', isDemo: true });
    await act(async () => {
      await result.current.fetchSchema(demoConn);
    });

    expect(mockToastError).toHaveBeenCalledWith(
      'Demo Database Error',
      { description: expect.stringContaining('Demo database unavailable') }
    );
  });

  // ── Demo connection updates existing demo ──────────────────────────────

  test('updates existing demo connection when demo already exists in storage', async () => {
    // Pre-populate storage with an existing demo connection
    const existingDemo = makeConnection({ id: 'demo-old', name: 'Old Demo', isDemo: true });
    storage.saveConnection(existingDemo);

    const newDemoConn = makeConnection({
      id: 'demo-new',
      name: 'Updated Demo',
      isDemo: true,
      host: 'new-demo-host',
    });

    mockGlobalFetch({
      '/api/demo-connection': {
        ok: true,
        json: { enabled: true, connection: { ...newDemoConn, createdAt: newDemoConn.createdAt.toISOString() } },
      },
    });

    const { result } = renderHook(() => useConnectionManager());

    await waitFor(() => {
      expect(result.current.connections.length).toBeGreaterThan(0);
    });

    // Should have updated the existing demo connection
    const demoConn = result.current.connections.find(c => c.isDemo);
    expect(demoConn).toBeDefined();
    expect(demoConn!.name).toBe('Updated Demo');
  });

  // ── Demo not enabled ───────────────────────────────────────────────────

  test('handles demo connection not enabled', async () => {
    mockGlobalFetch({
      '/api/demo-connection': { ok: true, json: { enabled: false } },
    });

    const { result } = renderHook(() => useConnectionManager());

    // Should still initialize but without demo connection
    await waitFor(() => {
      expect(result.current.connections).toBeDefined();
    });

    // Wait a bit for initialization
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(result.current.connections.length).toBe(0);
  });

  // ── Connection pulse degraded ──────────────────────────────────────────

  test('connectionPulse is degraded when health check returns non-ok', async () => {
    const conn = makeConnection();
    storage.saveConnection(conn);

    mockGlobalFetch({
      '/api/demo-connection': { ok: false, status: 404, json: {} },
      '/api/db/health': { ok: false, status: 503, json: { error: 'Service Unavailable' } },
    });

    const { result } = renderHook(() => useConnectionManager());

    await waitFor(() => {
      expect(result.current.connectionPulse).toBe('degraded');
    });
  });

  // ── Connection pulse error on fetch failure ────────────────────────────

  test('connectionPulse is error when health check throws', async () => {
    const conn = makeConnection();
    storage.saveConnection(conn);

    // First set up demo-connection to fail, then health check to throw
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/demo-connection')) {
        return new Response(JSON.stringify({}), { status: 404 });
      }
      if (url.includes('/api/db/health')) {
        throw new Error('Network error');
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }) as typeof fetch;

    const { result } = renderHook(() => useConnectionManager());

    await waitFor(() => {
      expect(result.current.connectionPulse).toBe('error');
    });

    globalThis.fetch = originalFetch;
  });

  // ── Demo connection with existing connections restores persisted ────────

  test('demo connection with existing connections restores persisted active', async () => {
    // Pre-populate with non-demo connection
    const existingConn = makeConnection({ id: 'existing-1', name: 'Existing DB' });
    storage.saveConnection(existingConn);
    storage.setActiveConnectionId('existing-1');

    const demoConn = makeConnection({
      id: 'demo-new',
      name: 'Demo',
      isDemo: true,
    });

    mockGlobalFetch({
      '/api/demo-connection': {
        ok: true,
        json: { enabled: true, connection: { ...demoConn, createdAt: demoConn.createdAt.toISOString() } },
      },
      '/api/db/health': { ok: true, json: { status: 'healthy' } },
    });

    const { result } = renderHook(() => useConnectionManager());

    await waitFor(() => {
      expect(result.current.activeConnection).not.toBeNull();
    });

    // Should restore persisted connection (existing-1), not auto-select demo
    expect(result.current.activeConnection!.id).toBe('existing-1');
  });

  // ── fetchSchema error with non-JSON response ──────────────────────────

  test('fetchSchema handles non-JSON error response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/demo-connection')) {
        return new Response(JSON.stringify({}), { status: 404 });
      }
      if (url.includes('/api/db/schema')) {
        return new Response('Internal Server Error', { status: 500 });
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }) as typeof fetch;

    const { result } = renderHook(() => useConnectionManager());

    const conn = makeConnection();
    await act(async () => {
      await result.current.fetchSchema(conn);
    });

    expect(result.current.isLoadingSchema).toBe(false);
    expect(mockToastError).toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  // ── Demo-connection fetch throwing network error ───────────────────────

  test('handles demo-connection fetch network error gracefully', async () => {
    const conn = makeConnection();
    storage.saveConnection(conn);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/demo-connection')) {
        throw new Error('Network error');
      }
      if (url.includes('/api/db/health')) {
        return new Response(JSON.stringify({ status: 'healthy' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const { result } = renderHook(() => useConnectionManager());

    // Should still load local connections despite demo fetch error
    await waitFor(() => {
      expect(result.current.connections.length).toBe(1);
    });

    expect(result.current.connections[0].id).toBe('conn-1');

    globalThis.fetch = originalFetch;
  });

  // ── Demo enabled but connection is null in response ────────────────────

  test('handles demo enabled but connection is null in response', async () => {
    mockGlobalFetch({
      '/api/demo-connection': { ok: true, json: { enabled: true, connection: null } },
    });

    const { result } = renderHook(() => useConnectionManager());

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    // Should not crash; no demo connection added
    expect(result.current.connections.length).toBe(0);
  });

  // ── fetchSchema with non-Error exception → 'Unknown error' ────────────

  test('fetchSchema with non-Error exception shows Unknown error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/demo-connection')) {
        return new Response(JSON.stringify({}), { status: 404 });
      }
      if (url.includes('/api/db/schema')) {
        throw 'non-error string';
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const { result } = renderHook(() => useConnectionManager());

    const conn = makeConnection();
    await act(async () => {
      await result.current.fetchSchema(conn);
    });

    expect(result.current.isLoadingSchema).toBe(false);
    expect(mockToastError).toHaveBeenCalledWith(
      'Schema Error',
      { description: 'Unknown error' }
    );

    globalThis.fetch = originalFetch;
  });

  // ── fetchSchema for demo connection success path ───────────────────────

  test('fetchSchema for demo connection success shows schema', async () => {
    const schemaData = makeSchema();

    mockGlobalFetch({
      '/api/demo-connection': { ok: false, status: 404, json: {} },
      '/api/db/schema': { ok: true, json: schemaData },
    });

    const { result } = renderHook(() => useConnectionManager());

    const demoConn = makeConnection({ id: 'demo-1', isDemo: true });
    await act(async () => {
      await result.current.fetchSchema(demoConn);
    });

    expect(result.current.schema).toEqual(schemaData);
    expect(result.current.isLoadingSchema).toBe(false);
  });

  // ── No activeConnection ID persistence when connection is null ─────────

  test('does not persist active connection ID when connection is null', async () => {
    mockGlobalFetch({
      '/api/demo-connection': { ok: false, status: 404, json: {} },
    });

    const { result } = renderHook(() => useConnectionManager());

    // activeConnection should be null (no saved connections)
    expect(result.current.activeConnection).toBeNull();

    // localStorage should not have active connection id for null
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    // setActiveConnectionId is only called when activeConnection is truthy
    // so we verify no ID was persisted
    const savedId = storage.getActiveConnectionId();
    // It might be null or whatever was there before, but no new call should have been made
    expect(result.current.activeConnection).toBeNull();
    expect(savedId).toBeFalsy();
  });

  // ── Existing demo found by exact c.id match ──────────────────────────

  test('updates existing demo connection found by exact ID match', async () => {
    // Pre-populate storage with demo connection matching ID exactly
    const existingDemo = makeConnection({ id: 'demo-exact', name: 'Old Demo', isDemo: true });
    storage.saveConnection(existingDemo);

    const updatedDemoConn = makeConnection({
      id: 'demo-exact',
      name: 'Updated Demo',
      isDemo: true,
      host: 'new-host',
    });

    mockGlobalFetch({
      '/api/demo-connection': {
        ok: true,
        json: { enabled: true, connection: { ...updatedDemoConn, createdAt: updatedDemoConn.createdAt.toISOString() } },
      },
    });

    const { result } = renderHook(() => useConnectionManager());

    await waitFor(() => {
      expect(result.current.connections.length).toBeGreaterThan(0);
    });

    // Should have updated via ID match
    const demo = result.current.connections.find(c => c.id === 'demo-exact');
    expect(demo).toBeDefined();
    expect(demo!.name).toBe('Updated Demo');
  });
});
