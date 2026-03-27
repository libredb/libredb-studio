import '../setup-dom';

import { describe, test, expect, mock } from 'bun:test';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useConnectionAdapter } from '@/workspace/hooks/use-connection-adapter';
import type { WorkspaceConnection } from '@/workspace/types';
import type { TableSchema } from '@/lib/types';

// ── Test Data ───────────────────────────────────────────────────────────────

const makeWorkspaceConnection = (
  overrides: Partial<WorkspaceConnection> = {}
): WorkspaceConnection => ({
  id: 'ws-conn-1',
  name: 'Platform DB',
  type: 'postgres',
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
// useConnectionAdapter Tests
// =============================================================================
describe('useConnectionAdapter', () => {
  // ── Initializes with first connection as active ─────────────────────────

  test('initializes with first connection as active', () => {
    const connections = [
      makeWorkspaceConnection({ id: 'c1', name: 'DB One' }),
      makeWorkspaceConnection({ id: 'c2', name: 'DB Two' }),
    ];
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result } = renderHook(() =>
      useConnectionAdapter({ connections, onSchemaFetch })
    );

    expect(result.current.activeConnection).not.toBeNull();
    expect(result.current.activeConnection!.id).toBe('c1');
    expect(result.current.activeConnection!.name).toBe('DB One');
    expect(result.current.activeConnection!.managed).toBe(true);
  });

  // ── Returns null activeConnection when connections array is empty ───────

  test('returns null activeConnection when connections array is empty', () => {
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result } = renderHook(() =>
      useConnectionAdapter({ connections: [], onSchemaFetch })
    );

    expect(result.current.connections).toEqual([]);
    expect(result.current.activeConnection).toBeNull();
    expect(result.current.schema).toEqual([]);
    expect(result.current.isLoadingSchema).toBe(false);
    expect(result.current.connectionPulse).toBeNull();
  });

  // ── setActiveConnection updates active connection ───────────────────────

  test('setActiveConnection updates active connection', () => {
    const connections = [
      makeWorkspaceConnection({ id: 'c1', name: 'DB One' }),
      makeWorkspaceConnection({ id: 'c2', name: 'DB Two' }),
    ];
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result } = renderHook(() =>
      useConnectionAdapter({ connections, onSchemaFetch })
    );

    expect(result.current.activeConnection!.id).toBe('c1');

    act(() => {
      result.current.setActiveConnection(result.current.connections[1]);
    });

    expect(result.current.activeConnection!.id).toBe('c2');
    expect(result.current.activeConnection!.name).toBe('DB Two');
  });

  // ── fetchSchema calls onSchemaFetch and updates schema state ────────────

  test('fetchSchema calls onSchemaFetch and updates schema state', async () => {
    const schemaData = makeSchema();
    const onSchemaFetch = mock(() => Promise.resolve(schemaData));

    const connections = [makeWorkspaceConnection({ id: 'c1' })];

    const { result } = renderHook(() =>
      useConnectionAdapter({ connections, onSchemaFetch })
    );

    await act(async () => {
      await result.current.fetchSchema(result.current.connections[0]);
    });

    // Verify onSchemaFetch was called with the connection ID
    expect(onSchemaFetch).toHaveBeenCalledTimes(1);
    expect(onSchemaFetch).toHaveBeenCalledWith('c1');

    // Verify schema was set
    expect(result.current.schema).toEqual(schemaData);

    // Verify tableNames derived value
    expect(result.current.tableNames).toEqual(['users', 'orders']);

    // Verify schemaContext derived value
    expect(result.current.schemaContext).toBe(JSON.stringify(schemaData));

    // Verify loading is done
    expect(result.current.isLoadingSchema).toBe(false);
  });

  // ── fetchSchema sets isLoadingSchema during fetch ───────────────────────

  test('fetchSchema sets isLoadingSchema during fetch', async () => {
    let resolveSchema: ((value: TableSchema[]) => void) | undefined;
    const schemaPromise = new Promise<TableSchema[]>((resolve) => {
      resolveSchema = resolve;
    });
    const onSchemaFetch = mock(() => schemaPromise);

    const connections = [makeWorkspaceConnection({ id: 'c1' })];

    const { result } = renderHook(() =>
      useConnectionAdapter({ connections, onSchemaFetch })
    );

    // Start fetching schema (don't await)
    let fetchPromise: Promise<void>;
    act(() => {
      fetchPromise = result.current.fetchSchema(result.current.connections[0]);
    });

    // isLoadingSchema should be true while waiting
    expect(result.current.isLoadingSchema).toBe(true);

    // Resolve the schema request
    resolveSchema!(makeSchema());

    await act(async () => {
      await fetchPromise!;
    });

    expect(result.current.isLoadingSchema).toBe(false);
    expect(result.current.schema).toHaveLength(2);
  });

  // ── fetchSchema error sets empty schema ─────────────────────────────────

  test('fetchSchema error sets empty schema', async () => {
    const onSchemaFetch = mock(() => Promise.reject(new Error('Connection refused')));

    const connections = [makeWorkspaceConnection({ id: 'c1' })];

    const { result } = renderHook(() =>
      useConnectionAdapter({ connections, onSchemaFetch })
    );

    await act(async () => {
      await result.current.fetchSchema(result.current.connections[0]);
    });

    expect(result.current.schema).toEqual([]);
    expect(result.current.isLoadingSchema).toBe(false);
  });

  // ── Updates connections when props change ───────────────────────────────

  test('updates connections when props change', () => {
    const initialConnections = [
      makeWorkspaceConnection({ id: 'c1', name: 'DB One' }),
    ];
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result, rerender } = renderHook(
      ({ connections }) =>
        useConnectionAdapter({ connections, onSchemaFetch }),
      { initialProps: { connections: initialConnections } }
    );

    expect(result.current.connections).toHaveLength(1);
    expect(result.current.connections[0].id).toBe('c1');

    // Rerender with updated connections
    const updatedConnections = [
      makeWorkspaceConnection({ id: 'c1', name: 'DB One' }),
      makeWorkspaceConnection({ id: 'c2', name: 'DB Two' }),
      makeWorkspaceConnection({ id: 'c3', name: 'DB Three', type: 'mysql' }),
    ];

    rerender({ connections: updatedConnections });

    expect(result.current.connections).toHaveLength(3);
    expect(result.current.connections[2].id).toBe('c3');
    expect(result.current.connections[2].type).toBe('mysql');
    expect(result.current.connections[2].managed).toBe(true);
  });

  // ── Resets activeConnection when it is removed from connections ─────────

  test('resets activeConnection when it is removed from connections', async () => {
    const initialConnections = [
      makeWorkspaceConnection({ id: 'c1', name: 'DB One' }),
      makeWorkspaceConnection({ id: 'c2', name: 'DB Two' }),
    ];
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result, rerender } = renderHook(
      ({ connections }) =>
        useConnectionAdapter({ connections, onSchemaFetch }),
      { initialProps: { connections: initialConnections } }
    );

    // Set active to c2
    act(() => {
      result.current.setActiveConnection(result.current.connections[1]);
    });
    expect(result.current.activeConnection!.id).toBe('c2');

    // Remove c2 from connections
    const updatedConnections = [
      makeWorkspaceConnection({ id: 'c1', name: 'DB One' }),
    ];

    rerender({ connections: updatedConnections });

    // activeConnection should reset to the first available connection
    await waitFor(() => {
      expect(result.current.activeConnection!.id).toBe('c1');
    });
  });

  // ── Resets activeConnection to null when all connections removed ─────────

  test('resets activeConnection to null when all connections removed', async () => {
    const initialConnections = [
      makeWorkspaceConnection({ id: 'c1', name: 'DB One' }),
    ];
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result, rerender } = renderHook(
      ({ connections }) =>
        useConnectionAdapter({ connections, onSchemaFetch }),
      { initialProps: { connections: initialConnections } }
    );

    expect(result.current.activeConnection!.id).toBe('c1');

    // Remove all connections
    rerender({ connections: [] });

    await waitFor(() => {
      expect(result.current.activeConnection).toBeNull();
    });
  });

  // ── Maps WorkspaceConnection to DatabaseConnection correctly ────────────

  test('maps WorkspaceConnection to DatabaseConnection with managed flag', () => {
    const connections = [
      makeWorkspaceConnection({ id: 'c1', name: 'Platform DB', type: 'mysql' }),
    ];
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result } = renderHook(() =>
      useConnectionAdapter({ connections, onSchemaFetch })
    );

    const mapped = result.current.connections[0];
    expect(mapped.id).toBe('c1');
    expect(mapped.name).toBe('Platform DB');
    expect(mapped.type).toBe('mysql');
    expect(mapped.managed).toBe(true);
    expect(mapped.createdAt).toBeInstanceOf(Date);
  });

  // ── setConnections is a no-op ──────────────────────────────────────────

  test('setConnections is a no-op (connections are externally managed)', () => {
    const connections = [makeWorkspaceConnection({ id: 'c1' })];
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result } = renderHook(() =>
      useConnectionAdapter({ connections, onSchemaFetch })
    );

    // Calling setConnections should not throw and should not change connections
    act(() => {
      result.current.setConnections([]);
    });

    expect(result.current.connections).toHaveLength(1);
  });

  // ── connectionPulse is always null ─────────────────────────────────────

  test('connectionPulse is always null (no health check in adapter)', () => {
    const connections = [makeWorkspaceConnection({ id: 'c1' })];
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result } = renderHook(() =>
      useConnectionAdapter({ connections, onSchemaFetch })
    );

    expect(result.current.connectionPulse).toBeNull();
  });
});
