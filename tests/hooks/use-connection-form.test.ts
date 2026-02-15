import '../setup-dom';

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { mockGlobalFetch, restoreGlobalFetch } from '../helpers/mock-fetch';

// ── Shared mocks — process-wide singletons (no contamination) ────────────────
import { mockToastSuccess, mockToastError } from '../helpers/mock-sonner';
import '../helpers/mock-navigation';

// ── Mock @/lib/db-ui-config ─────────────────────────────────────────────────
mock.module('@/lib/db-ui-config', () => ({
  getDBConfig: (type: string) => ({
    label: type.charAt(0).toUpperCase() + type.slice(1),
    icon: 'Database',
    color: '#000',
    defaultPort: type === 'mysql' ? '3306' : type === 'mongodb' ? '27017' : type === 'redis' ? '6379' : '5432',
    showConnectionStringToggle: type === 'mongodb',
    connectionFields: ['host', 'port', 'user', 'password', 'database'],
  }),
}));


import { useConnectionForm } from '@/hooks/use-connection-form';
import type { DatabaseConnection } from '@/lib/types';

// =============================================================================
// useConnectionForm Tests
// =============================================================================
describe('useConnectionForm', () => {
  const defaultProps = {
    isOpen: true,
    onClose: mock(() => {}),
    onConnect: mock(() => {}),
    editConnection: null as DatabaseConnection | null,
  };

  beforeEach(() => {
    defaultProps.onClose.mockClear();
    defaultProps.onConnect.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  // ── Default State ──────────────────────────────────────────────────────────

  test('default state has type postgres, host localhost, port 5432', () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    expect(result.current.type).toBe('postgres');
    expect(result.current.host).toBe('localhost');
    expect(result.current.port).toBe('5432');
  });

  // ── setType Changes Database Type ──────────────────────────────────────────

  test('setType changes database type', () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setType('mysql');
    });

    expect(result.current.type).toBe('mysql');
  });

  // ── Populate from editConnection ───────────────────────────────────────────

  test('populates form from editConnection on mount', () => {
    const editConn: DatabaseConnection = {
      id: 'edit-1',
      name: 'My PG',
      type: 'postgres',
      host: 'db.example.com',
      port: 5433,
      user: 'pgadmin',
      password: 'pgpass',
      database: 'mydb',
      createdAt: new Date(),
      environment: 'staging',
    };

    const { result } = renderHook(() =>
      useConnectionForm({ ...defaultProps, editConnection: editConn })
    );

    expect(result.current.type).toBe('postgres');
    expect(result.current.name).toBe('My PG');
    expect(result.current.host).toBe('db.example.com');
    expect(result.current.port).toBe('5433');
    expect(result.current.user).toBe('pgadmin');
    expect(result.current.password).toBe('pgpass');
    expect(result.current.database).toBe('mydb');
    expect(result.current.environment).toBe('staging');
  });

  // ── Reset form when modal closes ──────────────────────────────────────────

  test('resets form when modal closes (isOpen false)', () => {
    const { result, rerender } = renderHook(
      (props) => useConnectionForm(props),
      { initialProps: { ...defaultProps, isOpen: true } }
    );

    // Set some form state
    act(() => {
      result.current.setName('TestConn');
      result.current.setUser('testuser');
      result.current.setPassword('pass123');
      result.current.setDatabase('testdb');
    });

    expect(result.current.name).toBe('TestConn');

    // Close the modal
    rerender({ ...defaultProps, isOpen: false });

    expect(result.current.name).toBe('');
    expect(result.current.user).toBe('');
    expect(result.current.password).toBe('');
    expect(result.current.database).toBe('');
    expect(result.current.type).toBe('postgres');
    expect(result.current.host).toBe('localhost');
    expect(result.current.port).toBe('5432');
  });

  // ── handleTestConnection calls POST ────────────────────────────────────────

  test('handleTestConnection calls /api/db/test-connection POST', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/test-connection': { ok: true, json: { success: true, latency: 42 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    await act(async () => {
      await result.current.handleTestConnection();
    });

    const testCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/test-connection')
    );
    expect(testCall).toBeDefined();
    expect(testCall![1]).toMatchObject({ method: 'POST' });
  });

  // ── handleTestConnection sets testResult on success ────────────────────────

  test('handleTestConnection sets testResult on success', async () => {
    mockGlobalFetch({
      '/api/db/test-connection': { ok: true, json: { success: true, latency: 25 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    await act(async () => {
      await result.current.handleTestConnection();
    });

    expect(result.current.testResult).not.toBeNull();
    expect(result.current.testResult!.success).toBe(true);
    expect(result.current.testResult!.message).toContain('Connected successfully');
    expect(result.current.testResult!.latency).toBe(25);
  });

  // ── handleTestConnection sets error on failure ─────────────────────────────

  test('handleTestConnection sets error on failure', async () => {
    mockGlobalFetch({
      '/api/db/test-connection': { ok: true, json: { success: false, error: 'Connection refused' } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    await act(async () => {
      await result.current.handleTestConnection();
    });

    expect(result.current.testResult).not.toBeNull();
    expect(result.current.testResult!.success).toBe(false);
    expect(result.current.testResult!.message).toBe('Connection refused');
  });

  // ── handleConnect calls onConnect on successful test ───────────────────────

  test('handleConnect calls onConnect on successful test', async () => {
    mockGlobalFetch({
      '/api/db/test-connection': { ok: true, json: { success: true, latency: 10 } },
    });

    const onConnect = mock(() => {});
    const { result } = renderHook(() =>
      useConnectionForm({ ...defaultProps, onConnect })
    );

    // Set required fields for a valid connection
    act(() => {
      result.current.setName('TestConn');
      result.current.setHost('localhost');
      result.current.setPort('5432');
    });

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(onConnect).toHaveBeenCalledTimes(1);
    const connArg = (onConnect.mock.calls as unknown[][])[0][0] as DatabaseConnection;
    expect(connArg.type).toBe('postgres');
    expect(connArg.host).toBe('localhost');
  });

  // ── handleConnect does not call onConnect on failed test ───────────────────

  test('handleConnect does not call onConnect on failed test', async () => {
    mockGlobalFetch({
      '/api/db/test-connection': { ok: true, json: { success: false, error: 'Auth failed' } },
    });

    const onConnect = mock(() => {});
    const { result } = renderHook(() =>
      useConnectionForm({ ...defaultProps, onConnect })
    );

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(onConnect).not.toHaveBeenCalled();
    expect(result.current.testResult).not.toBeNull();
    expect(result.current.testResult!.success).toBe(false);
  });

  // ── handleConnect skips test for demo type ─────────────────────────────────

  test('handleConnect skips test for demo type', async () => {
    const fetchMock = mockGlobalFetch({});
    const onConnect = mock(() => {});

    const { result } = renderHook(() =>
      useConnectionForm({ ...defaultProps, onConnect })
    );

    act(() => {
      result.current.setType('demo');
    });

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(onConnect).toHaveBeenCalledTimes(1);
    // Should not have called test-connection endpoint
    const testCalls = fetchMock.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/test-connection')
    );
    expect(testCalls.length).toBe(0);
  });

  // ── handlePasteConnectionString parses and fills form ──────────────────────

  test('handlePasteConnectionString parses and fills form fields', () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setPasteInput('postgres://admin:secret@parsed-host:5432/parsed-db');
    });

    act(() => {
      result.current.handlePasteConnectionString();
    });

    expect(result.current.type).toBe('postgres');
    expect(result.current.host).toBe('parsed-host');
    expect(result.current.port).toBe('5432');
    expect(result.current.user).toBe('admin');
    expect(result.current.password).toBe('secret');
    expect(result.current.database).toBe('parsed-db');
    expect(result.current.testResult).not.toBeNull();
    expect(result.current.testResult!.success).toBe(true);
    expect(result.current.testResult!.message).toContain('parsed successfully');
  });

  // ── handlePasteConnectionString shows error for invalid string ─────────────

  test('handlePasteConnectionString shows error for invalid string', () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setPasteInput('not-a-valid-connection-string');
    });

    act(() => {
      result.current.handlePasteConnectionString();
    });

    expect(result.current.testResult).not.toBeNull();
    expect(result.current.testResult!.success).toBe(false);
    expect(result.current.testResult!.message).toContain('Could not parse');
  });

  // ── environment defaults to 'local' ────────────────────────────────────────

  test('environment defaults to local', () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    expect(result.current.environment).toBe('local');
  });

  // ── isEditMode is true when editConnection is provided ─────────────────────

  test('isEditMode is true when editConnection is provided', () => {
    const editConn: DatabaseConnection = {
      id: 'edit-1',
      name: 'Edit Conn',
      type: 'mysql',
      host: 'localhost',
      port: 3306,
      createdAt: new Date(),
    };

    const { result } = renderHook(() =>
      useConnectionForm({ ...defaultProps, editConnection: editConn })
    );

    expect(result.current.isEditMode).toBe(true);
  });

  test('isEditMode is false when editConnection is null', () => {
    const { result } = renderHook(() =>
      useConnectionForm({ ...defaultProps, editConnection: null })
    );

    expect(result.current.isEditMode).toBe(false);
  });

  // ── dbTypes returns array of selectable types ──────────────────────────────

  test('dbTypes returns array of selectable types', () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    expect(result.current.dbTypes).toBeDefined();
    expect(Array.isArray(result.current.dbTypes)).toBe(true);
    expect(result.current.dbTypes.length).toBeGreaterThan(0);

    const types = result.current.dbTypes.map((t: { value: string }) => t.value);
    expect(types).toContain('postgres');
    expect(types).toContain('mysql');
    expect(types).toContain('mongodb');
    expect(types).toContain('demo');

    // Each entry has value, label, icon, color
    const first = result.current.dbTypes[0];
    expect(first).toHaveProperty('value');
    expect(first).toHaveProperty('label');
    expect(first).toHaveProperty('icon');
    expect(first).toHaveProperty('color');
  });

  // ── handleTestConnection handles network error ─────────────────────────────

  test('handleTestConnection sets network error on fetch failure', async () => {
    // Mock fetch to throw
    globalThis.fetch = (async () => {
      throw new Error('Network error');
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    await act(async () => {
      await result.current.handleTestConnection();
    });

    expect(result.current.testResult).not.toBeNull();
    expect(result.current.testResult!.success).toBe(false);
    expect(result.current.testResult!.message).toContain('Network error');
  });
});
