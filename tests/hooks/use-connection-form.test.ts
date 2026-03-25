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

  // ── Edit mode with Oracle serviceName ──────────────────────────────────

  test('populates Oracle serviceName and showAdvanced in edit mode', () => {
    const editConn: DatabaseConnection = {
      id: 'edit-oracle',
      name: 'Oracle DB',
      type: 'oracle',
      host: 'oracle.example.com',
      port: 1521,
      user: 'sys',
      password: 'oraclepass',
      database: 'ORCL',
      serviceName: 'myservice',
      createdAt: new Date(),
    };

    const { result } = renderHook(() =>
      useConnectionForm({ ...defaultProps, editConnection: editConn })
    );

    expect(result.current.type).toBe('oracle');
    expect(result.current.serviceName).toBe('myservice');
    expect(result.current.showAdvanced).toBe(true);
  });

  // ── Edit mode with MSSQL instanceName ──────────────────────────────────

  test('populates MSSQL instanceName and showAdvanced in edit mode', () => {
    const editConn: DatabaseConnection = {
      id: 'edit-mssql',
      name: 'MSSQL DB',
      type: 'mssql',
      host: 'mssql.example.com',
      port: 1433,
      user: 'sa',
      password: 'mssqlpass',
      database: 'master',
      instanceName: 'SQLEXPRESS',
      createdAt: new Date(),
    };

    const { result } = renderHook(() =>
      useConnectionForm({ ...defaultProps, editConnection: editConn })
    );

    expect(result.current.type).toBe('mssql');
    expect(result.current.instanceName).toBe('SQLEXPRESS');
    expect(result.current.showAdvanced).toBe(true);
  });

  // ── Edit mode with SSL config ──────────────────────────────────────────

  test('populates SSL config in edit mode', () => {
    const editConn: DatabaseConnection = {
      id: 'edit-ssl',
      name: 'SSL PG',
      type: 'postgres',
      host: 'ssl.example.com',
      port: 5432,
      createdAt: new Date(),
      ssl: {
        mode: 'verify-full',
        caCert: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
        clientCert: '-----BEGIN CERTIFICATE-----\nCLIENT\n-----END CERTIFICATE-----',
        clientKey: '-----BEGIN KEY-----\nKEY\n-----END KEY-----',
      },
    };

    const { result } = renderHook(() =>
      useConnectionForm({ ...defaultProps, editConnection: editConn })
    );

    expect(result.current.sslMode).toBe('verify-full');
    expect(result.current.caCert).toContain('CA');
    expect(result.current.clientCert).toContain('CLIENT');
    expect(result.current.clientKey).toContain('KEY');
    expect(result.current.showSSL).toBe(true);
  });

  // ── Edit mode with SSH tunnel ──────────────────────────────────────────

  test('populates SSH tunnel config in edit mode', () => {
    const editConn: DatabaseConnection = {
      id: 'edit-ssh',
      name: 'SSH PG',
      type: 'postgres',
      host: 'internal.example.com',
      port: 5432,
      createdAt: new Date(),
      sshTunnel: {
        enabled: true,
        host: 'bastion.example.com',
        port: 22,
        username: 'tunneluser',
        authMethod: 'privateKey',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nKEY\n-----END RSA PRIVATE KEY-----',
        passphrase: 'keypass',
      },
    };

    const { result } = renderHook(() =>
      useConnectionForm({ ...defaultProps, editConnection: editConn })
    );

    expect(result.current.sshEnabled).toBe(true);
    expect(result.current.showSSH).toBe(true);
    expect(result.current.sshHost).toBe('bastion.example.com');
    expect(result.current.sshPort).toBe('22');
    expect(result.current.sshUsername).toBe('tunneluser');
    expect(result.current.sshAuthMethod).toBe('privateKey');
    expect(result.current.sshPrivateKey).toContain('RSA PRIVATE KEY');
    expect(result.current.sshPassphrase).toBe('keypass');
  });

  // ── Edit mode with SSH password auth ───────────────────────────────────

  test('populates SSH password auth in edit mode', () => {
    const editConn: DatabaseConnection = {
      id: 'edit-ssh-pw',
      name: 'SSH PG',
      type: 'postgres',
      host: 'internal.example.com',
      port: 5432,
      createdAt: new Date(),
      sshTunnel: {
        enabled: true,
        host: 'bastion.example.com',
        port: 2222,
        username: 'sshuser',
        authMethod: 'password',
        password: 'sshpass',
      },
    };

    const { result } = renderHook(() =>
      useConnectionForm({ ...defaultProps, editConnection: editConn })
    );

    expect(result.current.sshAuthMethod).toBe('password');
    expect(result.current.sshPassword).toBe('sshpass');
  });

  // ── Edit mode with MongoDB connectionString ───────────────────────────

  test('populates MongoDB connection string mode in edit mode', () => {
    const editConn: DatabaseConnection = {
      id: 'edit-mongo',
      name: 'Mongo Atlas',
      type: 'mongodb',
      host: 'localhost',
      port: 27017,
      createdAt: new Date(),
      connectionString: 'mongodb+srv://user:pass@cluster.mongodb.net/mydb',
    };

    const { result } = renderHook(() =>
      useConnectionForm({ ...defaultProps, editConnection: editConn })
    );

    expect(result.current.type).toBe('mongodb');
    expect(result.current.connectionString).toBe('mongodb+srv://user:pass@cluster.mongodb.net/mydb');
    expect(result.current.mongoConnectionMode).toBe('connectionString');
  });

  // ── buildConnection includes SSL config when mode is not disable ───────

  test('handleTestConnection includes SSL config when sslMode is not disable', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/test-connection': { ok: true, json: { success: true, latency: 30 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setSSLMode('require');
      result.current.setCaCert('test-ca-cert');
    });

    await act(async () => {
      await result.current.handleTestConnection();
    });

    const testCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/test-connection')
    );
    expect(testCall).toBeDefined();
    const body = JSON.parse(testCall![1]!.body as string);
    expect(body.ssl).toBeDefined();
    expect(body.ssl.mode).toBe('require');
    expect(body.ssl.caCert).toBe('test-ca-cert');
  });

  // ── buildConnection includes SSH tunnel config ─────────────────────────

  test('handleTestConnection includes SSH tunnel config when enabled', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/test-connection': { ok: true, json: { success: true, latency: 30 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setSSHEnabled(true);
      result.current.setSSHHost('bastion.test.com');
      result.current.setSSHPort('2222');
      result.current.setSSHUsername('tunnel');
      result.current.setSSHAuthMethod('password');
      result.current.setSSHPassword('tunnelpass');
    });

    await act(async () => {
      await result.current.handleTestConnection();
    });

    const testCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/test-connection')
    );
    const body = JSON.parse(testCall![1]!.body as string);
    expect(body.sshTunnel).toBeDefined();
    expect(body.sshTunnel.enabled).toBe(true);
    expect(body.sshTunnel.host).toBe('bastion.test.com');
    expect(body.sshTunnel.port).toBe(2222);
    expect(body.sshTunnel.username).toBe('tunnel');
    expect(body.sshTunnel.password).toBe('tunnelpass');
  });

  // ── buildConnection with privateKey SSH auth ───────────────────────────

  test('handleTestConnection includes SSH privateKey config', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/test-connection': { ok: true, json: { success: true, latency: 30 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setSSHEnabled(true);
      result.current.setSSHHost('bastion.test.com');
      result.current.setSSHUsername('tunnel');
      result.current.setSSHAuthMethod('privateKey');
      result.current.setSSHPrivateKey('my-private-key');
      result.current.setSSHPassphrase('mypassphrase');
    });

    await act(async () => {
      await result.current.handleTestConnection();
    });

    const testCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/test-connection')
    );
    const body = JSON.parse(testCall![1]!.body as string);
    expect(body.sshTunnel.authMethod).toBe('privateKey');
    expect(body.sshTunnel.privateKey).toBe('my-private-key');
    expect(body.sshTunnel.passphrase).toBe('mypassphrase');
  });

  // ── buildConnection with MongoDB connectionString mode ─────────────────

  test('buildConnection with MongoDB connectionString mode clears host/port', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/test-connection': { ok: true, json: { success: true, latency: 20 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setType('mongodb');
      result.current.setMongoConnectionMode('connectionString');
      result.current.setConnectionString('mongodb://localhost:27017/testdb');
    });

    await act(async () => {
      await result.current.handleTestConnection();
    });

    const testCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/test-connection')
    );
    const body = JSON.parse(testCall![1]!.body as string);
    expect(body.connectionString).toBe('mongodb://localhost:27017/testdb');
    expect(body.host).toBeUndefined();
    expect(body.port).toBeUndefined();
  });

  // ── buildConnection with Oracle serviceName ────────────────────────────

  test('buildConnection includes Oracle serviceName', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/test-connection': { ok: true, json: { success: true, latency: 20 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setType('oracle');
      result.current.setServiceName('MYSERVICE');
    });

    await act(async () => {
      await result.current.handleTestConnection();
    });

    const testCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/test-connection')
    );
    const body = JSON.parse(testCall![1]!.body as string);
    expect(body.serviceName).toBe('MYSERVICE');
  });

  // ── buildConnection with MSSQL instanceName ────────────────────────────

  test('buildConnection includes MSSQL instanceName', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/test-connection': { ok: true, json: { success: true, latency: 20 } },
    });

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setType('mssql');
      result.current.setInstanceName('SQLEXPRESS');
    });

    await act(async () => {
      await result.current.handleTestConnection();
    });

    const testCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/test-connection')
    );
    const body = JSON.parse(testCall![1]!.body as string);
    expect(body.instanceName).toBe('SQLEXPRESS');
  });

  // ── handleConnect sets network error on fetch failure ──────────────────

  test('handleConnect sets network error on fetch failure', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Network error');
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useConnectionForm(defaultProps));

    await act(async () => {
      await result.current.handleConnect();
    });

    expect(result.current.testResult).not.toBeNull();
    expect(result.current.testResult!.success).toBe(false);
    expect(result.current.testResult!.message).toContain('Network error');
  });

  // ── handlePasteConnectionString for MongoDB ────────────────────────────

  test('handlePasteConnectionString sets MongoDB connectionString mode', () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setPasteInput('mongodb://admin:pass@mongo.example.com:27017/mydb');
    });

    act(() => {
      result.current.handlePasteConnectionString();
    });

    expect(result.current.type).toBe('mongodb');
    expect(result.current.connectionString).toBe('mongodb://admin:pass@mongo.example.com:27017/mydb');
    expect(result.current.mongoConnectionMode).toBe('connectionString');
  });

  // ── handlePasteConnectionString does nothing for empty input ───────────

  test('handlePasteConnectionString does nothing for empty input', () => {
    const { result } = renderHook(() => useConnectionForm(defaultProps));

    act(() => {
      result.current.setPasteInput('   ');
    });

    act(() => {
      result.current.handlePasteConnectionString();
    });

    // testResult should remain null — no action taken
    expect(result.current.testResult).toBeNull();
  });
});
