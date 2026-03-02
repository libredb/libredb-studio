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

// ── Mock Drawer (vaul) — captures onOpenChange callback ─────────────────────
let capturedDrawerOnOpenChange: ((open: boolean) => void) | undefined;

mock.module('@/components/ui/drawer', () => ({
  Drawer: ({ open, children, onOpenChange }: { open?: boolean; children: React.ReactNode; onOpenChange?: (open: boolean) => void }) => {
    capturedDrawerOnOpenChange = onOpenChange;
    if (!open) return null;
    return React.createElement('div', { 'data-testid': 'drawer' }, children);
  },
  DrawerContent: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement('div', { 'data-testid': 'drawer-content', className }, children),
  DrawerHeader: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement('div', { 'data-testid': 'drawer-header', className }, children),
  DrawerTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('h2', { 'data-testid': 'drawer-title' }, children),
  DrawerDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement('p', null, children),
  DrawerFooter: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement('div', { 'data-testid': 'drawer-footer', className }, children),
}));

// ── Mock useIsMobile — always returns true (mobile path) ────────────────────
mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => true,
}));

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
let mockFormOverrides: Record<string, unknown> = {};

function getDefaultForm() {
  return {
    type: 'postgres' as const,
    setType: mock(() => {}),
    name: '',
    setName: mock(() => {}),
    host: 'localhost',
    setHost: mock(() => {}),
    port: '5432',
    setPort: mock(() => {}),
    user: '',
    setUser: mock(() => {}),
    password: '',
    setPassword: mock(() => {}),
    database: '',
    setDatabase: mock(() => {}),
    connectionString: '',
    setConnectionString: mock(() => {}),
    mongoConnectionMode: 'host' as const,
    setMongoConnectionMode: mock(() => {}),
    environment: 'local' as const,
    setEnvironment: mock(() => {}),
    isTesting: false,
    testResult: null,
    setTestResult: mock(() => {}),
    pasteInput: '',
    setPasteInput: mock(() => {}),
    showPasteInput: false,
    setShowPasteInput: mock(() => {}),
    isEditMode: false,
    showSSL: false,
    setShowSSL: mock(() => {}),
    sslMode: 'disable' as const,
    setSSLMode: mock(() => {}),
    caCert: '',
    setCaCert: mock(() => {}),
    clientCert: '',
    setClientCert: mock(() => {}),
    clientKey: '',
    setClientKey: mock(() => {}),
    showAdvanced: false,
    setShowAdvanced: mock(() => {}),
    serviceName: '',
    setServiceName: mock(() => {}),
    instanceName: '',
    setInstanceName: mock(() => {}),
    showSSH: false,
    setShowSSH: mock(() => {}),
    sshEnabled: false,
    setSSHEnabled: mock(() => {}),
    sshHost: '',
    setSSHHost: mock(() => {}),
    sshPort: '22',
    setSSHPort: mock(() => {}),
    sshUsername: '',
    setSSHUsername: mock(() => {}),
    sshAuthMethod: 'password' as const,
    setSSHAuthMethod: mock(() => {}),
    sshPassword: '',
    setSSHPassword: mock(() => {}),
    sshPrivateKey: '',
    setSSHPrivateKey: mock(() => {}),
    sshPassphrase: '',
    setSSHPassphrase: mock(() => {}),
    handleTestConnection: mock(async () => {}),
    handleConnect: mock(async () => {}),
    handlePasteConnectionString: mock(() => {}),
    dbTypes: [
      { value: 'postgres', label: 'PostgreSQL', icon: () => React.createElement('span', null, 'PG'), color: 'text-blue-400' },
      { value: 'mysql', label: 'MySQL', icon: () => React.createElement('span', null, 'MY'), color: 'text-amber-400' },
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
import { render, cleanup } from '@testing-library/react';
import { ConnectionModal } from '@/components/ConnectionModal';

// =============================================================================
// ConnectionModal Mobile (Drawer) Tests
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

describe('ConnectionModal (mobile Drawer path)', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockFormOverrides = {};
    capturedDrawerOnOpenChange = undefined;
  });

  test('isMobile=true renders Drawer, not Dialog', () => {
    const props = createDefaultProps();
    const { queryByTestId } = render(React.createElement(ConnectionModal, props));

    expect(queryByTestId('drawer')).not.toBeNull();
    expect(queryByTestId('dialog')).toBeNull();
  });

  test('isOpen=false does not render Drawer', () => {
    const props = createDefaultProps({ isOpen: false });
    const { queryByTestId } = render(React.createElement(ConnectionModal, props));

    expect(queryByTestId('drawer')).toBeNull();
  });

  test('Drawer onOpenChange(false) calls onClose', () => {
    const onClose = mock(() => {});
    const props = createDefaultProps({ onClose });
    render(React.createElement(ConnectionModal, props));

    expect(capturedDrawerOnOpenChange).toBeDefined();
    capturedDrawerOnOpenChange!(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('Drawer onOpenChange(true) does not call onClose', () => {
    const onClose = mock(() => {});
    const props = createDefaultProps({ onClose });
    render(React.createElement(ConnectionModal, props));

    expect(capturedDrawerOnOpenChange).toBeDefined();
    capturedDrawerOnOpenChange!(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  test('new connection mode shows "New Connection" in DrawerTitle', () => {
    const props = createDefaultProps({ editConnection: null });
    const { getByTestId } = render(React.createElement(ConnectionModal, props));

    const title = getByTestId('drawer-title');
    expect(title.textContent).toBe('New Connection');
  });

  test('edit mode shows "Edit Connection" in DrawerTitle', () => {
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
    const { getByTestId } = render(React.createElement(ConnectionModal, props));

    const title = getByTestId('drawer-title');
    expect(title.textContent).toBe('Edit Connection');
  });
});
