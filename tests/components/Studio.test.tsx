import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

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

// ---- Mock all hooks ----

mock.module('@/hooks/use-auth', () => ({
  useAuth: mock(() => ({
    user: { username: 'admin', role: 'admin' },
    isAdmin: true,
    handleLogout: mock(() => {}),
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
    setConnections: mock(() => {}),
    setActiveConnection: mock(() => {}),
    setSchema: mock(() => {}),
    fetchSchema: mock(async () => {}),
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
    setTabs: mock(() => {}),
    setActiveTabId: mock(() => {}),
    editingTabId: null,
    editingTabName: '',
    setEditingTabId: mock(() => {}),
    setEditingTabName: mock(() => {}),
    addTab: mock(() => {}),
    closeTab: mock(() => {}),
    updateCurrentTab: mock(() => {}),
    handleTableClick: mock(() => {}),
    handleGenerateSelect: mock(() => {}),
  })),
}));

mock.module('@/hooks/use-transaction-control', () => ({
  useTransactionControl: mock(() => ({
    transactionActive: false,
    playgroundMode: false,
    handleTransaction: mock(async () => {}),
    setPlaygroundMode: mock(() => {}),
    resetTransactionState: mock(() => {}),
  })),
}));

mock.module('@/hooks/use-query-execution', () => ({
  useQueryExecution: mock(() => ({
    bottomPanelMode: 'results',
    setBottomPanelMode: mock(() => {}),
    historyKey: 0,
    executeQuery: mock(async () => {}),
    cancelQuery: mock(() => {}),
    forceExecuteQuery: mock(async () => {}),
    safetyCheckQuery: null,
    setSafetyCheckQuery: mock(() => {}),
    unlimitedWarningOpen: false,
    setUnlimitedWarningOpen: mock(() => {}),
    handleUnlimitedQuery: mock(() => {}),
    handleLoadMore: mock(() => {}),
  })),
}));

mock.module('@/hooks/use-inline-editing', () => ({
  useInlineEditing: mock(() => ({
    editingEnabled: false,
    pendingChanges: [],
    setEditingEnabled: mock(() => {}),
    handleCellChange: mock(() => {}),
    handleApplyChanges: mock(async () => {}),
    handleDiscardChanges: mock(() => {}),
  })),
}));

mock.module('@/hooks/use-toast', () => ({
  useToast: mock(() => ({
    toast: mock(() => {}),
  })),
}));

// ---- Mock utility modules ----

mock.module('@/lib/storage', () => ({
  storage: {
    saveConnection: mock(() => {}),
    getConnections: mock(() => []),
    deleteConnection: mock(() => {}),
    saveQuery: mock(() => {}),
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
  saveMaskingConfig: mock(() => {}),
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
    Sidebar: () =>
      React.createElement('div', { 'data-testid': 'sidebar' }, 'Sidebar'),
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
  ConnectionModal: (props: { isOpen?: boolean }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
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
    StudioMobileHeader: () =>
      React.createElement('div', { 'data-testid': 'mobile-header' }, 'MobileHeader'),
    StudioDesktopHeader: () =>
      React.createElement('div', { 'data-testid': 'desktop-header' }, 'DesktopHeader'),
    StudioTabBar: () =>
      React.createElement('div', { 'data-testid': 'tab-bar' }, 'TabBar'),
    QueryToolbar: () =>
      React.createElement('div', { 'data-testid': 'query-toolbar' }, 'QueryToolbar'),
    BottomPanel: () =>
      React.createElement('div', { 'data-testid': 'bottom-panel' }, 'BottomPanel'),
    BottomPanelMode: {},
  };
});

mock.module('@/components/CommandPalette', () => ({
  CommandPalette: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'command-palette' }, 'CommandPalette');
  },
}));

mock.module('@/components/SchemaDiagram', () => ({
  SchemaDiagram: (props: { isOpen?: boolean }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return props.isOpen
      ? React.createElement('div', { 'data-testid': 'schemadiagram' }, 'SchemaDiagram')
      : null;
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
  QuerySafetyDialog: (props: { isOpen?: boolean }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
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
  SaveQueryModal: (props: { isOpen?: boolean }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
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

import { describe, test, expect, afterEach } from 'bun:test';
import { render, cleanup } from '@testing-library/react';
import React from 'react';

import Studio from '@/components/Studio';

// =============================================================================
// Studio Tests
// =============================================================================

describe('Studio', () => {
  afterEach(() => {
    cleanup();
  });

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
});
