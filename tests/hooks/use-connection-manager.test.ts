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
    mockGlobalFetch({});

    const { result } = renderHook(() => useConnectionManager(true));

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
      '/api/db/health': { ok: true, json: { status: 'healthy' } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => {
      expect(result.current.connections.length).toBe(1);
    });

    expect(result.current.connections[0].id).toBe('conn-1');
    expect(result.current.connections[0].name).toBe('Test DB');
  });

  // ── Active Connection from Persisted ID ───────────────────────────────────

  test('sets activeConnection from persisted active ID', async () => {
    const conn1 = makeConnection({ id: 'conn-1', name: 'DB One' });
    const conn2 = makeConnection({ id: 'conn-2', name: 'DB Two' });
    storage.saveConnection(conn1);
    storage.saveConnection(conn2);
    storage.setActiveConnectionId('conn-2');

    mockGlobalFetch({
      '/api/db/health': { ok: true, json: { status: 'healthy' } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

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
      '/api/db/health': { ok: true, json: { status: 'healthy' } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => {
      expect(result.current.activeConnection).not.toBeNull();
    });

    expect(result.current.activeConnection!.id).toBe('conn-1');
  });

  // ── fetchSchema success ───────────────────────────────────────────────────

  test('fetchSchema calls /api/db/schema POST and sets schema', async () => {
    const schemaData = makeSchema();

    const fetchMock = mockGlobalFetch({
      '/api/db/schema': { ok: true, json: schemaData },
    });

    const { result } = renderHook(() => useConnectionManager(true));

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
      '/api/db/schema': { ok: false, status: 500, json: { error: 'Connection refused' } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

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
      '/api/db/schema': { ok: true, json: schemaData },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(result.current.tableNames).toEqual(['users', 'orders']);
  });

  // ── schemaContext derived value ────────────────────────────────────────────

  test('schemaContext is JSON string of schema', async () => {
    const schemaData = makeSchema();

    mockGlobalFetch({
      '/api/db/schema': { ok: true, json: schemaData },
    });

    const { result } = renderHook(() => useConnectionManager(true));

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

    mockGlobalFetch({});

    const originalMockedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/db/schema')) {
        return schemaPromise;
      }
      return originalMockedFetch(input, init);
    }) as typeof fetch;

    const { result } = renderHook(() => useConnectionManager(true));

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
      '/api/db/health': { ok: true, json: { status: 'healthy' } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

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
    mockGlobalFetch({});

    const { result } = renderHook(() => useConnectionManager(true));

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
      '/api/db/health': { ok: true, json: { status: 'healthy' } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => {
      expect(result.current.connectionPulse).toBe('healthy');
    });
  });

  // ── Connection pulse degraded ──────────────────────────────────────────

  test('connectionPulse is degraded when health check returns non-ok', async () => {
    const conn = makeConnection();
    storage.saveConnection(conn);

    mockGlobalFetch({
      '/api/db/health': { ok: false, status: 503, json: { error: 'Service Unavailable' } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => {
      expect(result.current.connectionPulse).toBe('degraded');
    });
  });

  // ── Connection pulse error on fetch failure ────────────────────────────

  test('connectionPulse is error when health check throws', async () => {
    const conn = makeConnection();
    storage.saveConnection(conn);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/db/health')) {
        throw new Error('Network error');
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }) as typeof fetch;

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => {
      expect(result.current.connectionPulse).toBe('error');
    });

    globalThis.fetch = originalFetch;
  });

  // ── fetchSchema error with non-JSON response ──────────────────────────

  test('fetchSchema handles non-JSON error response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/db/schema')) {
        return new Response('Internal Server Error', { status: 500 });
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }) as typeof fetch;

    const { result } = renderHook(() => useConnectionManager(true));

    const conn = makeConnection();
    await act(async () => {
      await result.current.fetchSchema(conn);
    });

    expect(result.current.isLoadingSchema).toBe(false);
    expect(mockToastError).toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  // ── fetchSchema with non-Error exception → 'Unknown error' ────────────

  test('fetchSchema with non-Error exception shows Unknown error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/db/schema')) {
        throw 'non-error string';
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const { result } = renderHook(() => useConnectionManager(true));

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

  // ── No activeConnection ID persistence when connection is null ─────────

  test('does not persist active connection ID when connection is null', async () => {
    mockGlobalFetch({});

    const { result } = renderHook(() => useConnectionManager(true));

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

  // ── Managed (seed) connection merging ────────────────────────────────────

  test('fetchSchema for regular connection success shows schema', async () => {
    const schemaData = makeSchema();

    mockGlobalFetch({
      '/api/db/schema': { ok: true, json: schemaData },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    const conn = makeConnection({ id: 'pg-1' });
    await act(async () => {
      await result.current.fetchSchema(conn);
    });

    expect(result.current.schema).toEqual(schemaData);
    expect(result.current.isLoadingSchema).toBe(false);
  });
});
