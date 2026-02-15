import '../setup-dom';
import '../helpers/mock-sonner';
import { mockRouterPush } from '../helpers/mock-navigation';

import { mock } from 'bun:test';
import {
  setupMonacoMock,
  setupRechartssMock,
  setupXYFlowMock,
  setupFramerMotionMock,
} from '../helpers/mock-monaco';

// Setup heavy library mocks before any component imports
setupMonacoMock();
setupRechartssMock();
setupXYFlowMock();
setupFramerMotionMock();

// ---- Module-level prop capture for child components ----
let capturedSidebarProps: Record<string, unknown> = {};
let capturedBottomPanelProps: Record<string, unknown> = {};
let capturedQueryToolbarProps: Record<string, unknown> = {};
let capturedConnectionModalProps: Record<string, unknown> = {};
let capturedSaveQueryModalProps: Record<string, unknown> = {};
let capturedCommandPaletteProps: Record<string, unknown> = {};
let capturedSafetyDialogProps: Record<string, unknown> = {};
let capturedMobileHeaderProps: Record<string, unknown> = {};

// ---- Trackable mock functions (shared across mocks + assertions) ----

// Auth
const mockHandleLogout = mock(() => {});
// Connection Manager
const mockSetConnections = mock(() => {});
const mockSetActiveConnection = mock(() => {});
const mockSetSchema = mock(() => {});
const mockFetchSchema = mock(() => {});
// Tab Manager
const mockSetTabs = mock(() => {});
const mockUpdateCurrentTab = mock(() => {});
const mockHandleTableClick = mock(() => {});
const mockHandleGenerateSelect = mock(() => {});
// Transaction Control
const mockResetTransactionState = mock(() => {});
const mockSetPlaygroundMode = mock(() => {});
// Query Execution
const mockExecuteQuery = mock(() => {});
const mockForceExecuteQuery = mock(() => {});
const mockCancelQuery = mock(() => {});
const mockSetSafetyCheckQuery = mock(() => {});
const mockSetBottomPanelMode = mock(() => {});
const mockHandleUnlimitedQuery = mock(() => {});
const mockHandleLoadMore = mock(() => {});
// Inline Editing
const mockSetEditingEnabled = mock(() => {});
const mockHandleCellChange = mock(() => {});
const mockHandleApplyChanges = mock(() => {});
const mockHandleDiscardChanges = mock(() => {});
// Toast
const mockToast = mock(() => {});
// Storage
const mockStorageSaveConnection = mock(() => {});
const mockStorageGetConnections = mock(() => [] as unknown[]);
const mockStorageDeleteConnection = mock(() => {});
const mockStorageSaveQuery = mock(() => {});
// Data Masking
const mockSaveMaskingConfig = mock(() => {});
// URL (for export tests)
const mockCreateObjectURL = mock(() => 'blob:mock-url');
const mockRevokeObjectURL = mock(() => {});

// ---- Hook override objects (spread into mock returns per-test) ----
let connMgrOverride: Record<string, unknown> = {};
let tabMgrOverride: Record<string, unknown> = {};
let queryExecOverride: Record<string, unknown> = {};
let authOverride: Record<string, unknown> = {};
let editingOverride: Record<string, unknown> = {};

// ---- Mock all hooks ----

mock.module('@/hooks/use-auth', () => ({
  useAuth: mock(() => ({
    user: { username: 'admin', role: 'admin' },
    isAdmin: true,
    handleLogout: mockHandleLogout,
    ...authOverride,
  })),
}));

mock.module('@/hooks/use-connection-manager', () => ({
  useConnectionManager: mock(() => ({
    connections: [],
    activeConnection: null,
    schema: [],
    tableNames: [],
    schemaContext: '[]',
    isLoadingSchema: false,
    connectionPulse: 'none',
    setConnections: mockSetConnections,
    setActiveConnection: mockSetActiveConnection,
    setSchema: mockSetSchema,
    fetchSchema: mockFetchSchema,
    ...connMgrOverride,
  })),
}));

mock.module('@/hooks/use-provider-metadata', () => ({
  useProviderMetadata: mock(() => ({
    metadata: {
      capabilities: {
        queryLanguage: 'sql',
        supportsExplain: true,
        supportsCreateTable: true,
        supportsTransactions: true,
        maintenanceOperations: ['vacuum'],
        schemaRefreshPattern: '^(CREATE|DROP)\\b',
      },
      labels: {
        entityName: 'Table',
        entitiesName: 'Tables',
        selectAction: 'SELECT * FROM',
        searchPlaceholder: 'Search...',
        editorLanguage: 'sql',
      },
    },
  })),
}));

mock.module('@/hooks/use-tab-manager', () => ({
  useTabManager: mock(() => ({
    tabs: [{ id: 'tab-1', name: 'Query 1', query: 'SELECT 1', result: null, isExecuting: false, type: 'sql' }],
    activeTabId: 'tab-1',
    currentTab: { id: 'tab-1', name: 'Query 1', query: 'SELECT 1', result: null, isExecuting: false, type: 'sql' },
    setTabs: mockSetTabs,
    setActiveTabId: mock(() => {}),
    editingTabId: null,
    editingTabName: '',
    setEditingTabId: mock(() => {}),
    setEditingTabName: mock(() => {}),
    addTab: mock(() => {}),
    closeTab: mock(() => {}),
    updateCurrentTab: mockUpdateCurrentTab,
    handleTableClick: mockHandleTableClick,
    handleGenerateSelect: mockHandleGenerateSelect,
    ...tabMgrOverride,
  })),
}));

mock.module('@/hooks/use-transaction-control', () => ({
  useTransactionControl: mock(() => ({
    transactionActive: false,
    playgroundMode: false,
    handleTransaction: mock(() => {}),
    setPlaygroundMode: mockSetPlaygroundMode,
    resetTransactionState: mockResetTransactionState,
  })),
}));

mock.module('@/hooks/use-query-execution', () => ({
  useQueryExecution: mock(() => ({
    bottomPanelMode: 'results',
    setBottomPanelMode: mockSetBottomPanelMode,
    historyKey: 0,
    executeQuery: mockExecuteQuery,
    cancelQuery: mockCancelQuery,
    forceExecuteQuery: mockForceExecuteQuery,
    safetyCheckQuery: null,
    setSafetyCheckQuery: mockSetSafetyCheckQuery,
    unlimitedWarningOpen: false,
    setUnlimitedWarningOpen: mock(() => {}),
    handleUnlimitedQuery: mockHandleUnlimitedQuery,
    handleLoadMore: mockHandleLoadMore,
    ...queryExecOverride,
  })),
}));

mock.module('@/hooks/use-inline-editing', () => ({
  useInlineEditing: mock(() => ({
    editingEnabled: false,
    pendingChanges: [],
    setEditingEnabled: mockSetEditingEnabled,
    handleCellChange: mockHandleCellChange,
    handleApplyChanges: mockHandleApplyChanges,
    handleDiscardChanges: mockHandleDiscardChanges,
    ...editingOverride,
  })),
}));

mock.module('@/hooks/use-toast', () => ({
  useToast: mock(() => ({
    toast: mockToast,
  })),
}));

// ---- Mock utility modules ----

mock.module('@/lib/storage', () => ({
  storage: {
    saveConnection: mockStorageSaveConnection,
    getConnections: mockStorageGetConnections,
    deleteConnection: mockStorageDeleteConnection,
    saveQuery: mockStorageSaveQuery,
    getActiveConnectionId: mock(() => null),
  },
}));

mock.module('@/lib/showcase-queries', () => ({
  getRandomShowcaseQuery: mock(() => 'SELECT * FROM demo_users'),
}));

mock.module('@/lib/data-masking', () => ({
  loadMaskingConfig: mock(() => ({
    enabled: false,
    patterns: [],
    roles: {
      admin: { canToggleMasking: true, canRevealValues: true },
      user: { canToggleMasking: false, canRevealValues: false },
    },
  })),
  saveMaskingConfig: mockSaveMaskingConfig,
  shouldMask: mock(() => false),
  canToggleMasking: mock(() => true),
  detectSensitiveColumnsFromConfig: mock(() => new Set()),
  applyMaskingToRows: mock((rows: unknown) => rows),
}));

// ---- Mock child components ----

mock.module('@/components/sidebar', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    Sidebar: (props: Record<string, unknown>) => {
      capturedSidebarProps = props;
      return React.createElement('div', { 'data-testid': 'sidebar' }, 'Sidebar');
    },
    ConnectionsList: () =>
      React.createElement('div', { 'data-testid': 'connections-list' }, 'ConnectionsList'),
  };
});

mock.module('@/components/MobileNav', () => ({
  MobileNav: () => null,
}));

mock.module('@/components/schema-explorer', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    SchemaExplorer: () =>
      React.createElement('div', { 'data-testid': 'schema-explorer' }, 'SchemaExplorer'),
  };
});

mock.module('@/components/ConnectionModal', () => ({
  ConnectionModal: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    capturedConnectionModalProps = props;
    return props.isOpen
      ? React.createElement('div', { 'data-testid': 'connection-modal' }, 'ConnectionModal')
      : null;
  },
}));

mock.module('@/components/QueryEditor', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  const QueryEditor = React.forwardRef((props: Record<string, unknown>, ref: unknown) =>
    React.createElement('div', { 'data-testid': 'query-editor', ref }, 'QueryEditor'));
  QueryEditor.displayName = 'QueryEditor';
  return { QueryEditor, QueryEditorRef: {} };
});

// Mock the studio sub-components barrel.
// Studio.tsx imports from '@/components/studio/index' to avoid ambiguity with
// the Studio.tsx file itself (bun resolves '@/components/studio' to Studio.tsx).
mock.module('@/components/studio/index', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    StudioMobileHeader: (props: Record<string, unknown>) => {
      capturedMobileHeaderProps = props;
      return React.createElement('div', { 'data-testid': 'mobile-header' }, 'MobileHeader');
    },
    StudioDesktopHeader: () =>
      React.createElement('div', { 'data-testid': 'desktop-header' }, 'DesktopHeader'),
    StudioTabBar: () =>
      React.createElement('div', { 'data-testid': 'tab-bar' }, 'TabBar'),
    QueryToolbar: (props: Record<string, unknown>) => {
      capturedQueryToolbarProps = props;
      return React.createElement('div', { 'data-testid': 'query-toolbar' }, 'QueryToolbar');
    },
    BottomPanel: (props: Record<string, unknown>) => {
      capturedBottomPanelProps = props;
      return React.createElement('div', { 'data-testid': 'bottom-panel' }, 'BottomPanel');
    },
    BottomPanelMode: {},
  };
});

mock.module('@/components/CommandPalette', () => ({
  CommandPalette: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    capturedCommandPaletteProps = props;
    return React.createElement('div', { 'data-testid': 'command-palette' }, 'CommandPalette');
  },
}));

mock.module('@/components/SchemaDiagram', () => ({
  SchemaDiagram: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'schemadiagram' }, 'SchemaDiagram');
  },
}));

mock.module('@/components/DataImportModal', () => ({
  DataImportModal: (props: { isOpen?: boolean }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return props.isOpen
      ? React.createElement('div', { 'data-testid': 'dataimportmodal' }, 'DataImportModal')
      : null;
  },
}));

mock.module('@/components/QuerySafetyDialog', () => ({
  QuerySafetyDialog: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    capturedSafetyDialogProps = props;
    return props.isOpen
      ? React.createElement('div', { 'data-testid': 'querysafetydialog' }, 'QuerySafetyDialog')
      : null;
  },
}));

mock.module('@/components/DataProfiler', () => ({
  DataProfiler: (props: { isOpen?: boolean }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return props.isOpen
      ? React.createElement('div', { 'data-testid': 'dataprofiler' }, 'DataProfiler')
      : null;
  },
}));

mock.module('@/components/CodeGenerator', () => ({
  CodeGenerator: (props: { isOpen?: boolean }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return props.isOpen
      ? React.createElement('div', { 'data-testid': 'codegenerator' }, 'CodeGenerator')
      : null;
  },
}));

mock.module('@/components/TestDataGenerator', () => ({
  TestDataGenerator: (props: { isOpen?: boolean }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return props.isOpen
      ? React.createElement('div', { 'data-testid': 'testdatagenerator' }, 'TestDataGenerator')
      : null;
  },
}));

mock.module('@/components/CreateTableModal', () => ({
  CreateTableModal: (props: { isOpen?: boolean }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return props.isOpen
      ? React.createElement('div', { 'data-testid': 'createtablemodal' }, 'CreateTableModal')
      : null;
  },
}));

mock.module('@/components/SaveQueryModal', () => ({
  SaveQueryModal: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    capturedSaveQueryModalProps = props;
    return props.isOpen
      ? React.createElement('div', { 'data-testid': 'savequerymodal' }, 'SaveQueryModal')
      : null;
  },
}));

mock.module('@/components/ui/resizable', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    ResizablePanelGroup: ({ children }: Record<string, unknown>) =>
      React.createElement('div', { 'data-testid': 'resizable-group' }, children),
    ResizablePanel: ({ children }: Record<string, unknown>) =>
      React.createElement('div', { 'data-testid': 'resizable-panel' }, children),
    ResizableHandle: () =>
      React.createElement('div', { 'data-testid': 'resizable-handle' }),
  };
});

// ---- Now import bun:test, testing-library, and the component ----

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { render, cleanup, act } from '@testing-library/react';
import React from 'react';

import Studio from '@/components/Studio';

// =============================================================================
// Test data
// =============================================================================

const pgConn = {
  id: 'c1', type: 'postgres' as const, name: 'TestPG',
  host: 'localhost', port: 5432, database: 'test', user: 'admin', password: 'pass',
};

const testResult = {
  rows: [
    { id: 1, name: 'Alice', salary: 50000 },
    { id: 2, name: "Bob's", salary: 60000, active: true },
  ],
  fields: ['id', 'name', 'salary', 'active'],
  rowCount: 2,
  executionTime: 10,
};

// =============================================================================
// Studio Tests
// =============================================================================

describe('Studio', () => {
  beforeEach(() => {
    // Reset prop captures
    capturedSidebarProps = {};
    capturedBottomPanelProps = {};
    capturedQueryToolbarProps = {};
    capturedConnectionModalProps = {};
    capturedSaveQueryModalProps = {};
    capturedCommandPaletteProps = {};
    capturedSafetyDialogProps = {};
    capturedMobileHeaderProps = {};

    // Reset overrides
    connMgrOverride = {};
    tabMgrOverride = {};
    queryExecOverride = {};
    authOverride = {};
    editingOverride = {};

    // Clear trackable mocks
    mockHandleLogout.mockClear();
    mockSetConnections.mockClear();
    mockSetActiveConnection.mockClear();
    mockSetSchema.mockClear();
    mockFetchSchema.mockClear();
    mockSetTabs.mockClear();
    mockUpdateCurrentTab.mockClear();
    mockHandleTableClick.mockClear();
    mockHandleGenerateSelect.mockClear();
    mockResetTransactionState.mockClear();
    mockSetPlaygroundMode.mockClear();
    mockExecuteQuery.mockClear();
    mockForceExecuteQuery.mockClear();
    mockCancelQuery.mockClear();
    mockSetSafetyCheckQuery.mockClear();
    mockSetBottomPanelMode.mockClear();
    mockHandleUnlimitedQuery.mockClear();
    mockHandleLoadMore.mockClear();
    mockSetEditingEnabled.mockClear();
    mockHandleCellChange.mockClear();
    mockHandleApplyChanges.mockClear();
    mockHandleDiscardChanges.mockClear();
    mockToast.mockClear();
    mockStorageSaveConnection.mockClear();
    mockStorageGetConnections.mockClear();
    mockStorageGetConnections.mockReturnValue([]);
    mockStorageDeleteConnection.mockClear();
    mockStorageSaveQuery.mockClear();
    mockSaveMaskingConfig.mockClear();
    mockCreateObjectURL.mockClear();
    mockRevokeObjectURL.mockClear();
    mockRouterPush.mockClear();

    // URL mocks (may not exist in happy-dom)
    globalThis.URL.createObjectURL = mockCreateObjectURL as unknown as typeof URL.createObjectURL;
    globalThis.URL.revokeObjectURL = mockRevokeObjectURL as unknown as typeof URL.revokeObjectURL;
  });

  afterEach(() => {
    cleanup();
  });

  // =========================================================================
  // Rendering tests (existing)
  // =========================================================================

  test('renders without crashing', () => {
    const { container } = render(<Studio />);
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  test('shows sidebar', () => {
    const { getByTestId } = render(<Studio />);
    const sidebar = getByTestId('sidebar');
    expect(sidebar).not.toBeNull();
    expect(sidebar.textContent).toBe('Sidebar');
  });

  test('shows desktop header', () => {
    const { getByTestId } = render(<Studio />);
    const header = getByTestId('desktop-header');
    expect(header).not.toBeNull();
    expect(header.textContent).toBe('DesktopHeader');
  });

  test('shows tab bar', () => {
    const { getByTestId } = render(<Studio />);
    const tabBar = getByTestId('tab-bar');
    expect(tabBar).not.toBeNull();
    expect(tabBar.textContent).toBe('TabBar');
  });

  test('shows query editor', () => {
    const { getByTestId } = render(<Studio />);
    const editor = getByTestId('query-editor');
    expect(editor).not.toBeNull();
    expect(editor.textContent).toBe('QueryEditor');
  });

  test('shows query toolbar', () => {
    const { getByTestId } = render(<Studio />);
    const toolbar = getByTestId('query-toolbar');
    expect(toolbar).not.toBeNull();
    expect(toolbar.textContent).toBe('QueryToolbar');
  });

  test('shows bottom panel', () => {
    const { getByTestId } = render(<Studio />);
    const panel = getByTestId('bottom-panel');
    expect(panel).not.toBeNull();
    expect(panel.textContent).toBe('BottomPanel');
  });

  test('shows command palette', () => {
    const { getByTestId } = render(<Studio />);
    const palette = getByTestId('command-palette');
    expect(palette).not.toBeNull();
    expect(palette.textContent).toBe('CommandPalette');
  });

  test('connection modal hidden by default', () => {
    const { queryByTestId } = render(<Studio />);
    const modal = queryByTestId('connection-modal');
    expect(modal).toBeNull();
  });

  test('create table modal hidden by default', () => {
    const { queryByTestId } = render(<Studio />);
    const modal = queryByTestId('createtablemodal');
    expect(modal).toBeNull();
  });

  test('data import modal hidden by default', () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId('dataimportmodal')).toBeNull();
  });

  test('data profiler hidden by default', () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId('dataprofiler')).toBeNull();
  });

  test('code generator hidden by default', () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId('codegenerator')).toBeNull();
  });

  test('test data generator hidden by default', () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId('testdatagenerator')).toBeNull();
  });

  test('save query modal hidden by default', () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId('savequerymodal')).toBeNull();
  });

  test('schema diagram hidden by default', () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId('schemadiagram')).toBeNull();
  });

  test('query safety dialog hidden by default', () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId('querysafetydialog')).toBeNull();
  });

  test('resizable panels render', () => {
    const { container } = render(<Studio />);
    const groups = container.querySelectorAll('[data-testid="resizable-group"]');
    expect(groups.length).toBeGreaterThanOrEqual(1);
  });

  test('resizable handles render', () => {
    const { container } = render(<Studio />);
    const handles = container.querySelectorAll('[data-testid="resizable-handle"]');
    expect(handles.length).toBeGreaterThanOrEqual(1);
  });

  test('multiple renders do not crash', () => {
    const { container, rerender } = render(<Studio />);
    rerender(<Studio />);
    rerender(<Studio />);
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  // =========================================================================
  // Callback + logic tests
  // =========================================================================

  // --- openMaintenance ---
  test('openMaintenance navigates to admin operations when admin', () => {
    render(<Studio />);
    const fn = capturedSidebarProps.onOpenMaintenance as () => void;
    act(() => fn());
    expect(mockRouterPush).toHaveBeenCalledWith('/admin?tab=operations');
  });

  test('openMaintenance navigates to monitoring when not admin', () => {
    authOverride = { isAdmin: false };
    render(<Studio />);
    const fn = capturedSidebarProps.onOpenMaintenance as () => void;
    act(() => fn());
    expect(mockRouterPush).toHaveBeenCalledWith('/monitoring');
  });

  // --- handleSaveQuery ---
  test('handleSaveQuery saves query and shows toast', () => {
    connMgrOverride = { activeConnection: pgConn };
    render(<Studio />);
    const onSave = capturedSaveQueryModalProps.onSave as (name: string, desc: string, tags: string[]) => void;
    act(() => onSave('My Query', 'A test query', ['test']));
    expect(mockStorageSaveQuery).toHaveBeenCalledTimes(1);
    const saved = (mockStorageSaveQuery.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(saved.name).toBe('My Query');
    expect(saved.connectionType).toBe('postgres');
    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  test('handleSaveQuery returns early without activeConnection', () => {
    render(<Studio />);
    const onSave = capturedSaveQueryModalProps.onSave as (name: string, desc: string, tags: string[]) => void;
    act(() => onSave('Noop', '', []));
    expect(mockStorageSaveQuery).not.toHaveBeenCalled();
  });

  // --- handleDeleteConnection ---
  test('handleDeleteConnection removes connection and updates list', () => {
    const remaining = [{ id: 'c2', type: 'mysql', name: 'MySQL' }];
    mockStorageGetConnections.mockReturnValue(remaining);
    connMgrOverride = { activeConnection: pgConn, connections: [pgConn, remaining[0]] };
    render(<Studio />);
    const deleteFn = capturedSidebarProps.onDeleteConnection as (id: string) => void;
    act(() => deleteFn('c1'));
    expect(mockStorageDeleteConnection).toHaveBeenCalledWith('c1');
    expect(mockSetConnections).toHaveBeenCalledWith(remaining);
    expect(mockSetActiveConnection).toHaveBeenCalledWith(remaining[0]);
  });

  // --- onTableClick ---
  test('onTableClick delegates to handleTableClick with executeQuery', () => {
    render(<Studio />);
    const fn = capturedSidebarProps.onTableClick as (name: string) => void;
    act(() => fn('users'));
    expect(mockHandleTableClick).toHaveBeenCalledWith('users', mockExecuteQuery);
  });

  // --- onEditConnection ---
  test('onEditConnection opens connection modal with connection', () => {
    render(<Studio />);
    const fn = capturedSidebarProps.onEditConnection as (c: unknown) => void;
    act(() => fn(pgConn));
    expect(capturedConnectionModalProps.isOpen).toBe(true);
    expect(capturedConnectionModalProps.editConnection).toEqual(pgConn);
  });

  // --- onAddConnection ---
  test('onAddConnection opens connection modal', () => {
    render(<Studio />);
    const fn = capturedSidebarProps.onAddConnection as () => void;
    act(() => fn());
    expect(capturedConnectionModalProps.isOpen).toBe(true);
  });

  // --- ConnectionModal onConnect ---
  test('ConnectionModal onConnect saves and activates connection', () => {
    const newConns = [pgConn];
    mockStorageGetConnections.mockReturnValue(newConns);
    render(<Studio />);
    const onConnect = capturedConnectionModalProps.onConnect as (c: unknown) => void;
    act(() => onConnect(pgConn));
    expect(mockStorageSaveConnection).toHaveBeenCalledWith(pgConn);
    expect(mockSetConnections).toHaveBeenCalledWith(newConns);
    expect(mockSetActiveConnection).toHaveBeenCalledWith(pgConn);
  });

  // --- ConnectionModal onClose ---
  test('ConnectionModal onClose resets editing and closes modal', () => {
    render(<Studio />);
    // Open the modal
    const addFn = capturedSidebarProps.onAddConnection as () => void;
    act(() => addFn());
    expect(capturedConnectionModalProps.isOpen).toBe(true);
    // Close the modal
    const closeFn = capturedConnectionModalProps.onClose as () => void;
    act(() => closeFn());
    expect(capturedConnectionModalProps.isOpen).toBe(false);
  });

  // --- exportResults ---
  test('exportResults CSV creates text/csv blob', () => {
    tabMgrOverride = {
      currentTab: { id: 'tab-1', name: 'Users', query: 'SELECT 1', result: testResult, isExecuting: false, type: 'sql' },
    };
    render(<Studio />);
    const exportFn = capturedBottomPanelProps.onExportResults as (format: string) => void;
    act(() => exportFn('csv'));
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
    expect(mockRevokeObjectURL).toHaveBeenCalledTimes(1);
    const blob = (mockCreateObjectURL.mock.calls[0] as unknown[])[0] as Blob;
    expect(blob.type).toBe('text/csv');
  });

  test('exportResults JSON creates application/json blob', () => {
    tabMgrOverride = {
      currentTab: { id: 'tab-1', name: 'Users', query: 'SELECT 1', result: testResult, isExecuting: false, type: 'sql' },
    };
    render(<Studio />);
    const exportFn = capturedBottomPanelProps.onExportResults as (format: string) => void;
    act(() => exportFn('json'));
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
    const blob = (mockCreateObjectURL.mock.calls[0] as unknown[])[0] as Blob;
    expect(blob.type).toContain('application/json');
  });

  test('exportResults sql-insert creates text/sql blob', () => {
    tabMgrOverride = {
      currentTab: { id: 'tab-1', name: 'Users', query: 'SELECT 1', result: testResult, isExecuting: false, type: 'sql' },
    };
    render(<Studio />);
    const exportFn = capturedBottomPanelProps.onExportResults as (format: string) => void;
    act(() => exportFn('sql-insert'));
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
    const blob = (mockCreateObjectURL.mock.calls[0] as unknown[])[0] as Blob;
    expect(blob.type).toBe('text/sql');
  });

  test('exportResults sql-ddl creates text/sql blob', () => {
    tabMgrOverride = {
      currentTab: { id: 'tab-1', name: 'Users', query: 'SELECT 1', result: testResult, isExecuting: false, type: 'sql' },
    };
    render(<Studio />);
    const exportFn = capturedBottomPanelProps.onExportResults as (format: string) => void;
    act(() => exportFn('sql-ddl'));
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
    const blob = (mockCreateObjectURL.mock.calls[0] as unknown[])[0] as Blob;
    expect(blob.type).toBe('text/sql');
  });

  test('exportResults with no result does nothing', () => {
    render(<Studio />);
    const exportFn = capturedBottomPanelProps.onExportResults as (format: string) => void;
    act(() => exportFn('csv'));
    expect(mockCreateObjectURL).not.toHaveBeenCalled();
  });

  // --- CommandPalette callbacks ---
  test('CommandPalette onLoadSavedQuery loads query and switches to results', () => {
    render(<Studio />);
    const fn = capturedCommandPaletteProps.onLoadSavedQuery as (q: string) => void;
    act(() => fn('SELECT * FROM orders'));
    expect(mockUpdateCurrentTab).toHaveBeenCalledWith({ query: 'SELECT * FROM orders' });
    expect(mockSetBottomPanelMode).toHaveBeenCalledWith('results');
  });

  test('CommandPalette onLoadHistoryQuery loads query and switches to results', () => {
    render(<Studio />);
    const fn = capturedCommandPaletteProps.onLoadHistoryQuery as (q: string) => void;
    act(() => fn('SELECT 1'));
    expect(mockUpdateCurrentTab).toHaveBeenCalledWith({ query: 'SELECT 1' });
    expect(mockSetBottomPanelMode).toHaveBeenCalledWith('results');
  });

  test('CommandPalette onNavigateMonitoring pushes /monitoring', () => {
    render(<Studio />);
    const fn = capturedCommandPaletteProps.onNavigateMonitoring as () => void;
    act(() => fn());
    expect(mockRouterPush).toHaveBeenCalledWith('/monitoring');
  });

  test('CommandPalette onShowDiagram opens diagram', () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId('schemadiagram')).toBeNull();
    const fn = capturedCommandPaletteProps.onShowDiagram as () => void;
    act(() => fn());
    expect(queryByTestId('schemadiagram')).not.toBeNull();
  });

  // --- QueryToolbar callbacks ---
  test('QueryToolbar onToggleEditing enables editing', () => {
    render(<Studio />);
    const fn = capturedQueryToolbarProps.onToggleEditing as () => void;
    act(() => fn());
    // editingEnabled is false by default → setEditingEnabled(true)
    expect(mockSetEditingEnabled).toHaveBeenCalledWith(true);
    expect(mockHandleDiscardChanges).not.toHaveBeenCalled();
  });

  test('QueryToolbar onToggleEditing disables editing and discards changes', () => {
    editingOverride = { editingEnabled: true };
    render(<Studio />);
    const fn = capturedQueryToolbarProps.onToggleEditing as () => void;
    act(() => fn());
    expect(mockSetEditingEnabled).toHaveBeenCalledWith(false);
    expect(mockHandleDiscardChanges).toHaveBeenCalled();
  });

  test('QueryToolbar onImport opens import modal', () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId('dataimportmodal')).toBeNull();
    const fn = capturedQueryToolbarProps.onImport as () => void;
    act(() => fn());
    expect(queryByTestId('dataimportmodal')).not.toBeNull();
  });

  test('QueryToolbar onSaveQuery opens save query modal', () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId('savequerymodal')).toBeNull();
    const fn = capturedQueryToolbarProps.onSaveQuery as () => void;
    act(() => fn());
    expect(queryByTestId('savequerymodal')).not.toBeNull();
  });

  // --- BottomPanel callbacks ---
  test('BottomPanel onToggleMasking toggles masking config', () => {
    render(<Studio />);
    const fn = capturedBottomPanelProps.onToggleMasking as () => void;
    expect(fn).toBeDefined();
    act(() => fn());
    expect(mockSaveMaskingConfig).toHaveBeenCalledTimes(1);
  });

  test('BottomPanel onLoadQuery updates current tab query', () => {
    render(<Studio />);
    const fn = capturedBottomPanelProps.onLoadQuery as (q: string) => void;
    act(() => fn('SELECT * FROM products'));
    expect(mockUpdateCurrentTab).toHaveBeenCalledWith({ query: 'SELECT * FROM products' });
  });

  test('BottomPanel onExecuteQuery delegates to executeQuery', () => {
    render(<Studio />);
    const fn = capturedBottomPanelProps.onExecuteQuery as (q: string) => void;
    act(() => fn('SELECT 1'));
    expect(mockExecuteQuery).toHaveBeenCalledWith('SELECT 1');
  });

  // --- QuerySafetyDialog ---
  test('QuerySafetyDialog onProceed calls forceExecuteQuery', () => {
    queryExecOverride = { safetyCheckQuery: 'DROP TABLE users' };
    render(<Studio />);
    const fn = capturedSafetyDialogProps.onProceed as () => void;
    act(() => fn());
    expect(mockForceExecuteQuery).toHaveBeenCalledWith('DROP TABLE users');
  });

  // --- Connection-change effect ---
  test('connection-change effect resets state and fetches schema', () => {
    connMgrOverride = { activeConnection: pgConn };
    render(<Studio />);
    expect(mockResetTransactionState).toHaveBeenCalled();
    expect(mockSetEditingEnabled).toHaveBeenCalledWith(false);
    expect(mockHandleDiscardChanges).toHaveBeenCalled();
    expect(mockFetchSchema).toHaveBeenCalledWith(pgConn);
    expect(mockSetTabs).toHaveBeenCalled();
  });

  test('connection-change effect clears schema when no active connection', () => {
    render(<Studio />);
    expect(mockSetSchema).toHaveBeenCalledWith([]);
  });

  // --- Sidebar profiler/codegen/testdata callbacks ---
  test('Sidebar onProfileTable opens profiler', () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId('dataprofiler')).toBeNull();
    const fn = capturedSidebarProps.onProfileTable as (name: string) => void;
    act(() => fn('users'));
    expect(queryByTestId('dataprofiler')).not.toBeNull();
  });

  test('Sidebar onGenerateCode opens code generator', () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId('codegenerator')).toBeNull();
    const fn = capturedSidebarProps.onGenerateCode as (name: string) => void;
    act(() => fn('users'));
    expect(queryByTestId('codegenerator')).not.toBeNull();
  });

  test('Sidebar onGenerateTestData opens test data generator', () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId('testdatagenerator')).toBeNull();
    const fn = capturedSidebarProps.onGenerateTestData as (name: string) => void;
    act(() => fn('users'));
    expect(queryByTestId('testdatagenerator')).not.toBeNull();
  });

  test('Sidebar onCreateTableClick opens create table modal', () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId('createtablemodal')).toBeNull();
    const fn = capturedSidebarProps.onCreateTableClick as () => void;
    act(() => fn());
    expect(queryByTestId('createtablemodal')).not.toBeNull();
  });

  test('Sidebar onShowDiagram opens schema diagram', () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId('schemadiagram')).toBeNull();
    const fn = capturedSidebarProps.onShowDiagram as () => void;
    act(() => fn());
    expect(queryByTestId('schemadiagram')).not.toBeNull();
  });

  // --- MobileHeader callbacks ---
  test('MobileHeader onSaveQuery opens save modal', () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId('savequerymodal')).toBeNull();
    const fn = capturedMobileHeaderProps.onSaveQuery as () => void;
    act(() => fn());
    expect(queryByTestId('savequerymodal')).not.toBeNull();
  });

  test('MobileHeader onClearQuery clears current tab query', () => {
    render(<Studio />);
    const fn = capturedMobileHeaderProps.onClearQuery as () => void;
    act(() => fn());
    expect(mockUpdateCurrentTab).toHaveBeenCalledWith({ query: '' });
  });

  test('MobileHeader onExecuteQuery delegates to executeQuery', () => {
    render(<Studio />);
    const fn = capturedMobileHeaderProps.onExecuteQuery as () => void;
    act(() => fn());
    expect(mockExecuteQuery).toHaveBeenCalled();
  });
});
