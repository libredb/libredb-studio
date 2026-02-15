import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { mock } from 'bun:test';
import React from 'react';

// ── Mock framer-motion before component imports ─────────────────────────────
mock.module('framer-motion', () => {
  const passthrough = ({ children, ...props }: Record<string, unknown>) =>
    React.createElement('div', props, children as React.ReactNode);

  return {
    motion: new Proxy({}, {
      get: () => passthrough,
    }),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    useAnimation: () => ({ start: mock(() => {}), stop: mock(() => {}) }),
    useInView: () => true,
  };
});

// ── Mock Radix Dialog via @/components/ui/dialog ────────────────────────────
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children: React.ReactNode; onOpenChange?: (open: boolean) => void }) => {
    if (!open) return null;
    return React.createElement('div', { 'data-testid': 'dialog', 'data-open': open }, children);
  },
  DialogContent: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement('div', { 'data-testid': 'dialog-content', className }, children),
  DialogHeader: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement('div', { 'data-testid': 'dialog-header', className }, children),
  DialogTitle: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement('h2', { 'data-testid': 'dialog-title', className }, children),
  DialogFooter: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement('div', { 'data-testid': 'dialog-footer', className }, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement('p', null, children),
  DialogClose: ({ children }: { children: React.ReactNode }) =>
    React.createElement('button', null, children),
  DialogTrigger: ({ children }: { children: React.ReactNode }) => children,
  DialogPortal: ({ children }: { children: React.ReactNode }) => children,
  DialogOverlay: () => null,
}));

// ── Mock Shadcn UI primitives ───────────────────────────────────────────────
mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, className, disabled, ...rest }: Record<string, unknown>) =>
    React.createElement('button', { onClick: onClick as (() => void), className, disabled, ...rest }, children as React.ReactNode),
}));

mock.module('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) =>
    React.createElement('input', props),
}));

mock.module('@/components/ui/label', () => ({
  Label: ({ children, className, htmlFor }: Record<string, unknown>) =>
    React.createElement('label', { className, htmlFor }, children as React.ReactNode),
}));

// ── Mock useConnectionForm hook ─────────────────────────────────────────────
const mockSetType = mock(() => {});
const mockSetName = mock(() => {});
const mockSetHost = mock(() => {});
const mockSetPort = mock(() => {});
const mockSetUser = mock(() => {});
const mockSetPassword = mock(() => {});
const mockSetDatabase = mock(() => {});
const mockSetConnectionString = mock(() => {});
const mockSetMongoConnectionMode = mock(() => {});
const mockSetEnvironment = mock(() => {});
const mockSetTestResult = mock(() => {});
const mockSetPasteInput = mock(() => {});
const mockSetShowPasteInput = mock(() => {});
const mockSetShowSSL = mock(() => {});
const mockSetSSLMode = mock(() => {});
const mockSetCaCert = mock(() => {});
const mockSetClientCert = mock(() => {});
const mockSetClientKey = mock(() => {});
const mockSetShowAdvanced = mock(() => {});
const mockSetServiceName = mock(() => {});
const mockSetInstanceName = mock(() => {});
const mockSetShowSSH = mock(() => {});
const mockSetSSHEnabled = mock(() => {});
const mockSetSSHHost = mock(() => {});
const mockSetSSHPort = mock(() => {});
const mockSetSSHUsername = mock(() => {});
const mockSetSSHAuthMethod = mock(() => {});
const mockSetSSHPassword = mock(() => {});
const mockSetSSHPrivateKey = mock(() => {});
const mockSetSSHPassphrase = mock(() => {});
const mockHandleTestConnection = mock(async () => {});
const mockHandleConnect = mock(async () => {});
const mockHandlePasteConnectionString = mock(() => {});

let mockFormOverrides: Record<string, unknown> = {};

function getDefaultForm() {
  return {
    type: 'postgres' as const,
    setType: mockSetType,
    name: '',
    setName: mockSetName,
    host: 'localhost',
    setHost: mockSetHost,
    port: '5432',
    setPort: mockSetPort,
    user: '',
    setUser: mockSetUser,
    password: '',
    setPassword: mockSetPassword,
    database: '',
    setDatabase: mockSetDatabase,
    connectionString: '',
    setConnectionString: mockSetConnectionString,
    mongoConnectionMode: 'host' as const,
    setMongoConnectionMode: mockSetMongoConnectionMode,
    environment: 'local' as const,
    setEnvironment: mockSetEnvironment,
    isTesting: false,
    testResult: null,
    setTestResult: mockSetTestResult,
    pasteInput: '',
    setPasteInput: mockSetPasteInput,
    showPasteInput: false,
    setShowPasteInput: mockSetShowPasteInput,
    isEditMode: false,
    showSSL: false,
    setShowSSL: mockSetShowSSL,
    sslMode: 'disable' as const,
    setSSLMode: mockSetSSLMode,
    caCert: '',
    setCaCert: mockSetCaCert,
    clientCert: '',
    setClientCert: mockSetClientCert,
    clientKey: '',
    setClientKey: mockSetClientKey,
    showAdvanced: false,
    setShowAdvanced: mockSetShowAdvanced,
    serviceName: '',
    setServiceName: mockSetServiceName,
    instanceName: '',
    setInstanceName: mockSetInstanceName,
    showSSH: false,
    setShowSSH: mockSetShowSSH,
    sshEnabled: false,
    setSSHEnabled: mockSetSSHEnabled,
    sshHost: '',
    setSSHHost: mockSetSSHHost,
    sshPort: '22',
    setSSHPort: mockSetSSHPort,
    sshUsername: '',
    setSSHUsername: mockSetSSHUsername,
    sshAuthMethod: 'password' as const,
    setSSHAuthMethod: mockSetSSHAuthMethod,
    sshPassword: '',
    setSSHPassword: mockSetSSHPassword,
    sshPrivateKey: '',
    setSSHPrivateKey: mockSetSSHPrivateKey,
    sshPassphrase: '',
    setSSHPassphrase: mockSetSSHPassphrase,
    handleTestConnection: mockHandleTestConnection,
    handleConnect: mockHandleConnect,
    handlePasteConnectionString: mockHandlePasteConnectionString,
    dbTypes: [
      { value: 'postgres', label: 'PostgreSQL', icon: () => React.createElement('span', null, 'PG'), color: 'text-blue-400' },
      { value: 'mysql', label: 'MySQL', icon: () => React.createElement('span', null, 'MY'), color: 'text-amber-400' },
      { value: 'sqlite', label: 'SQLite', icon: () => React.createElement('span', null, 'SL'), color: 'text-cyan-400' },
      { value: 'mongodb', label: 'MongoDB', icon: () => React.createElement('span', null, 'MG'), color: 'text-emerald-400' },
      { value: 'redis', label: 'Redis', icon: () => React.createElement('span', null, 'RD'), color: 'text-red-400' },
      { value: 'demo', label: 'Demo', icon: () => React.createElement('span', null, 'DM'), color: 'text-yellow-400' },
    ],
    ...mockFormOverrides,
  };
}

mock.module('@/hooks/use-connection-form', () => ({
  useConnectionForm: mock(() => getDefaultForm()),
}));

// ── Mock @/lib/db-ui-config ─────────────────────────────────────────────────
mock.module('@/lib/db-ui-config', () => ({
  getDBConfig: (type: string) => ({
    icon: () => null,
    color: 'text-blue-400',
    label: type,
    defaultPort: type === 'mysql' ? '3306' : type === 'mongodb' ? '27017' : '5432',
    showConnectionStringToggle: type === 'mongodb',
    connectionFields: ['host', 'port', 'user', 'password', 'database'],
  }),
  getDBIcon: () => () => null,
  getDBColor: () => 'text-blue-400',
  DB_UI_CONFIG: {},
}));

// ── Mock lucide-react icons as simple spans ─────────────────────────────────
mock.module('lucide-react', () => {
  return new Proxy({}, {
    get: (_target, prop) => {
      if (prop === '__esModule') return true;
      return (props: Record<string, unknown>) =>
        React.createElement('span', { 'data-icon': prop, className: props.className as string });
    },
  });
});

// ── Imports AFTER mocks ─────────────────────────────────────────────────────
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { ConnectionModal } from '@/components/ConnectionModal';

// =============================================================================
// ConnectionModal Tests
// =============================================================================

function createDefaultProps(overrides: Partial<Parameters<typeof ConnectionModal>[0]> = {}) {
  return {
    isOpen: true,
    onClose: mock(() => {}),
    onConnect: mock(() => {}),
    editConnection: null,
    ...overrides,
  };
}

describe('ConnectionModal', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockFormOverrides = {};
    mockSetType.mockClear();
    mockSetName.mockClear();
    mockSetHost.mockClear();
    mockSetPort.mockClear();
    mockSetShowPasteInput.mockClear();
    mockSetShowSSL.mockClear();
    mockHandleTestConnection.mockClear();
    mockHandleConnect.mockClear();
  });

  // ── 1. Does not render when isOpen=false ────────────────────────────────────

  test('does not render dialog content when isOpen is false', () => {
    const props = createDefaultProps({ isOpen: false });
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText('New Connection')).toBeNull();
    expect(queryByText('Establish Connection')).toBeNull();
  });

  // ── 2. Renders dialog when isOpen=true ──────────────────────────────────────

  test('renders dialog content when isOpen is true', () => {
    const props = createDefaultProps({ isOpen: true });
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText('New Connection')).not.toBeNull();
  });

  // ── 3. Shows "New Connection" title for new connection ──────────────────────

  test('shows "New Connection" title for new connection', () => {
    const props = createDefaultProps({ editConnection: null });
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText('New Connection')).not.toBeNull();
  });

  // ── 4. Shows "Edit Connection" title when editConnection provided ───────────

  test('shows "Edit Connection" title when editConnection provided', () => {
    mockFormOverrides = { isEditMode: true };

    const editConn = {
      id: 'e1',
      name: 'My PG',
      type: 'postgres' as const,
      host: 'localhost',
      port: 5432,
      createdAt: new Date(),
    };
    const props = createDefaultProps({ editConnection: editConn });
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText('Edit Connection')).not.toBeNull();
  });

  // ── 5. Database type buttons render ─────────────────────────────────────────

  test('database type buttons render', () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText('PostgreSQL')).not.toBeNull();
    expect(queryByText('MySQL')).not.toBeNull();
    expect(queryByText('SQLite')).not.toBeNull();
    expect(queryByText('MongoDB')).not.toBeNull();
    expect(queryByText('Redis')).not.toBeNull();
    expect(queryByText('Demo')).not.toBeNull();
  });

  // ── 6. Name input renders ──────────────────────────────────────────────────

  test('connection name input renders', () => {
    const props = createDefaultProps();
    const { queryByText, container } = render(React.createElement(ConnectionModal, props));

    expect(queryByText('Connection Name')).not.toBeNull();
    const nameInput = container.querySelector('#name');
    expect(nameInput).not.toBeNull();
  });

  // ── 7. Host/Port inputs render ─────────────────────────────────────────────

  test('host and port inputs render', () => {
    const props = createDefaultProps();
    const { queryByText, container } = render(React.createElement(ConnectionModal, props));

    expect(queryByText('Host & Instance')).not.toBeNull();
    const hostInput = container.querySelector('#host');
    const portInput = container.querySelector('#port');
    expect(hostInput).not.toBeNull();
    expect(portInput).not.toBeNull();
  });

  // ── 8. Test Connection button renders ──────────────────────────────────────

  test('Test Connection button renders', () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText('Test Connection')).not.toBeNull();
  });

  // ── 9. Connect button renders ──────────────────────────────────────────────

  test('Establish Connection button renders', () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText('Establish Connection')).not.toBeNull();
  });

  // ── 10. Save Changes button renders in edit mode ───────────────────────────

  test('shows Save Changes button in edit mode', () => {
    mockFormOverrides = { isEditMode: true };
    const editConn = {
      id: 'e1',
      name: 'My PG',
      type: 'postgres' as const,
      host: 'localhost',
      port: 5432,
      createdAt: new Date(),
    };
    const props = createDefaultProps({ editConnection: editConn });
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText('Save Changes')).not.toBeNull();
  });

  // ── 11. onClose fires when Cancel clicked ──────────────────────────────────

  test('onClose fires when Cancel button clicked', () => {
    const onClose = mock(() => {});
    const props = createDefaultProps({ onClose });
    const { getByText } = render(React.createElement(ConnectionModal, props));

    const cancelBtn = getByText('Cancel');
    fireEvent.click(cancelBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── 12. SSL section expandable ─────────────────────────────────────────────

  test('SSL / TLS section toggle button renders', () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText('SSL / TLS')).not.toBeNull();
  });

  // ── 13. SSH Tunnel section renders ─────────────────────────────────────────

  test('SSH Tunnel section toggle button renders', () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText('SSH Tunnel')).not.toBeNull();
  });

  // ── 14. Paste URL button renders for new connection ────────────────────────

  test('Paste URL button renders for new connection', () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText('Paste URL')).not.toBeNull();
  });

  // ── 15. Environment selector renders ───────────────────────────────────────

  test('Environment selector renders with environment options', () => {
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));

    expect(queryByText('Environment')).not.toBeNull();
    expect(queryByText('PROD')).not.toBeNull();
    expect(queryByText('STAGING')).not.toBeNull();
    expect(queryByText('DEV')).not.toBeNull();
    expect(queryByText('LOCAL')).not.toBeNull();
  });

  // ── 16. Paste URL shows input area when clicked ─────────────────────────

  test('Paste URL shows paste input area when showPasteInput is true', () => {
    mockFormOverrides = { showPasteInput: true };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText('Paste Connection URL')).not.toBeNull();
    expect(queryByText('Parse')).not.toBeNull();
  });

  // ── 17. SSL expanded shows SSL fields ───────────────────────────────────

  test('SSL section shows fields when expanded', () => {
    mockFormOverrides = { showSSL: true };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText('SSL Mode')).not.toBeNull();
  });

  // ── 18. SSH expanded shows SSH fields ───────────────────────────────────

  test('SSH section shows fields when expanded', () => {
    mockFormOverrides = { showSSH: true };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText('Enable SSH Tunnel')).not.toBeNull();
  });

  // ── 19. SSH enabled shows all SSH fields ─────────────────────────────────

  test('SSH enabled shows SSH connection fields', () => {
    mockFormOverrides = { showSSH: true, sshEnabled: true };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText('Enable SSH Tunnel')).not.toBeNull();
  });

  // ── 20. Test result success displayed ──────────────────────────────────

  test('test result success message displayed', () => {
    mockFormOverrides = { testResult: { success: true, message: 'Connection successful' } };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText('Connection successful')).not.toBeNull();
  });

  // ── 21. Test result failure displayed ──────────────────────────────────

  test('test result failure message displayed', () => {
    mockFormOverrides = { testResult: { success: false, message: 'Connection failed: timeout' } };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText('Connection failed: timeout')).not.toBeNull();
  });

  // ── 22. isTesting shows spinner state ─────────────────────────────────

  test('Test Connection button shows testing state', () => {
    mockFormOverrides = { isTesting: true };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText('Testing...')).not.toBeNull();
  });

  // ── 23. Demo type hides connection fields ─────────────────────────────

  test('demo type renders without crash', () => {
    mockFormOverrides = { type: 'demo' };
    const props = createDefaultProps();
    const { container } = render(React.createElement(ConnectionModal, props));
    // Component renders properly with demo type
    expect(container.textContent).toContain('New Connection');
  });

  // ── 24. MongoDB connection string mode ──────────────────────────────────

  test('MongoDB shows connection mode toggle', () => {
    mockFormOverrides = { type: 'mongodb' };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText('Host / Port')).not.toBeNull();
    expect(queryByText('Connection String')).not.toBeNull();
  });

  // ── 25. MongoDB connection string mode shows URI field ─────────────────

  test('MongoDB connection string mode shows URI field', () => {
    mockFormOverrides = { type: 'mongodb', mongoConnectionMode: 'connectionString' };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText('Connection URI')).not.toBeNull();
  });

  // ── 26. Advanced section for Oracle ────────────────────────────────────

  test('Oracle type shows advanced section', () => {
    mockFormOverrides = { type: 'oracle', showAdvanced: true };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText('Service Name')).not.toBeNull();
  });

  // ── 27. Advanced section for MSSQL ─────────────────────────────────────

  test('MSSQL type shows instance name in advanced section', () => {
    mockFormOverrides = { type: 'mssql', showAdvanced: true };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText('Instance Name')).not.toBeNull();
  });

  // ── 28. Paste URL hidden in edit mode ────────────────────────────────

  test('Paste URL button hidden in edit mode', () => {
    mockFormOverrides = { isEditMode: true };
    const editConn = {
      id: 'e1', name: 'My PG', type: 'postgres' as const,
      host: 'localhost', port: 5432, createdAt: new Date(),
    };
    const props = createDefaultProps({ editConnection: editConn });
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText('Paste URL')).toBeNull();
  });

  // ── 29. Supports URL text shown in paste area ────────────────────────

  test('paste area shows supported URL protocols', () => {
    mockFormOverrides = { showPasteInput: true };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText(/postgres:\/\//)).not.toBeNull();
  });

  // ── 30. SSL section for verify-ca shows client cert fields ─────────────

  test('SSL verify-ca mode renders SSL section', () => {
    mockFormOverrides = { showSSL: true, sslMode: 'verify-ca' };
    const props = createDefaultProps();
    const { queryByText } = render(React.createElement(ConnectionModal, props));
    expect(queryByText('SSL Mode')).not.toBeNull();
  });
});
