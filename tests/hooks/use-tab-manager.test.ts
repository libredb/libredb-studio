import '../setup-dom';

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';

// Shared mocks — process-wide singletons (no contamination)
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { useTabManager } from '@/hooks/use-tab-manager';
import type { DatabaseConnection, TableSchema } from '@/lib/types';
import type { ProviderMetadata } from '@/hooks/use-provider-metadata';
import type { RefObject } from 'react';

// Helper to create a minimal connection
function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: 'conn-1',
    name: 'Test DB',
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'testdb',
    createdAt: new Date(),
    ...overrides,
  };
}

// Helper metadata
const defaultMetadata: ProviderMetadata = {
  capabilities: {
    queryLanguage: 'sql' as const,
    supportsExplain: true,
    supportsExternalQueryLimiting: true,
    supportsCreateTable: true,
    supportsMaintenance: true,
    maintenanceOperations: [],
    supportsConnectionString: true,
    schemaRefreshPattern: 'CREATE|ALTER|DROP',
    defaultPort: 5432,
  },
  labels: {
    entityName: 'Table',
    entityNamePlural: 'Tables',
    rowName: 'Row',
    rowNamePlural: 'Rows',
    selectAction: 'SELECT',
    generateAction: 'Generate SELECT',
    analyzeAction: 'Analyze',
    vacuumAction: 'Vacuum',
    searchPlaceholder: 'Search tables...',
    analyzeGlobalLabel: 'Analyze All',
    analyzeGlobalTitle: 'Analyze All Tables',
    analyzeGlobalDesc: 'Analyze all tables in the database',
    vacuumGlobalLabel: 'Vacuum All',
    vacuumGlobalTitle: 'Vacuum All Tables',
    vacuumGlobalDesc: 'Vacuum all tables in the database',
  },
};

// Helper schema
const testSchema: TableSchema[] = [
  {
    name: 'users',
    columns: [
      { name: 'id', type: 'integer', nullable: false, isPrimary: true },
      { name: 'name', type: 'varchar', nullable: true, isPrimary: false },
    ],
    indexes: [],
  },
];

// Null ref for queryEditorRef
function makeEditorRef(): RefObject<null> {
  return { current: null };
}

describe('useTabManager', () => {
  beforeEach(() => {
    // Reset any state between tests
  });

  test('starts with one default tab', () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
        queryEditorRef: makeEditorRef(),
      })
    );

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].id).toBe('default');
    expect(result.current.tabs[0].name).toBe('Query 1');
    expect(result.current.tabs[0].type).toBe('sql');
    expect(result.current.activeTabId).toBe('default');
  });

  test('currentTab returns the active tab', () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
        queryEditorRef: makeEditorRef(),
      })
    );

    expect(result.current.currentTab).toBeDefined();
    expect(result.current.currentTab.id).toBe('default');
    expect(result.current.currentTab.id).toBe(result.current.activeTabId);
  });

  test('addTab creates a new tab and sets it active', () => {
    const connection = makeConnection();
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: connection,
        metadata: defaultMetadata,
        schema: [],
        queryEditorRef: makeEditorRef(),
      })
    );

    act(() => {
      result.current.addTab();
    });

    expect(result.current.tabs).toHaveLength(2);
    // The new tab should be the active one
    const newTab = result.current.tabs[1];
    expect(result.current.activeTabId).toBe(newTab.id);
    expect(newTab.name).toBe('Query 2');
    expect(newTab.query).toBe('-- Start typing your SQL query here\n');
    expect(newTab.result).toBeNull();
    expect(newTab.isExecuting).toBe(false);
  });

  test('closeTab removes a tab when more than 1 tab exists', () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
        queryEditorRef: makeEditorRef(),
      })
    );

    // Add a second tab first
    act(() => {
      result.current.addTab();
    });
    expect(result.current.tabs).toHaveLength(2);

    const secondTabId = result.current.tabs[1].id;

    // Close the second tab (not the active one in this case; active is second tab)
    // Active is now the second tab, close the first
    act(() => {
      result.current.closeTab('default', { stopPropagation: () => {} } as React.MouseEvent);
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].id).toBe(secondTabId);
  });

  test('closeTab switches active tab if closing the active one', () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
        queryEditorRef: makeEditorRef(),
      })
    );

    // Add a second tab
    act(() => {
      result.current.addTab();
    });

    const secondTabId = result.current.tabs[1].id;
    // Active is now the second tab
    expect(result.current.activeTabId).toBe(secondTabId);

    // Close the active (second) tab
    act(() => {
      result.current.closeTab(secondTabId, { stopPropagation: () => {} } as React.MouseEvent);
    });

    expect(result.current.tabs).toHaveLength(1);
    // Should switch to the remaining tab (the default one)
    expect(result.current.activeTabId).toBe('default');
  });

  test('closeTab does nothing when only 1 tab remains', () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
        queryEditorRef: makeEditorRef(),
      })
    );

    expect(result.current.tabs).toHaveLength(1);

    act(() => {
      result.current.closeTab('default', { stopPropagation: () => {} } as React.MouseEvent);
    });

    // Still one tab, nothing changed
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].id).toBe('default');
  });

  test('updateCurrentTab updates the active tab properties', () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
        queryEditorRef: makeEditorRef(),
      })
    );

    act(() => {
      result.current.updateCurrentTab({ query: 'SELECT 1;', name: 'Renamed Tab' });
    });

    expect(result.current.currentTab.query).toBe('SELECT 1;');
    expect(result.current.currentTab.name).toBe('Renamed Tab');
  });

  test('handleTableClick creates new tab with query and calls executeQueryFn', () => {
    const connection = makeConnection();
    const executeFn = mock(() => {});

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: connection,
        metadata: defaultMetadata,
        schema: testSchema,
        queryEditorRef: makeEditorRef(),
      })
    );

    act(() => {
      result.current.handleTableClick('users', executeFn);
    });

    // New tab should be added
    expect(result.current.tabs).toHaveLength(2);
    const newTab = result.current.tabs[1];
    expect(newTab.name).toBe('users');
    expect(newTab.query).toBe('SELECT * FROM users LIMIT 50;');
    expect(newTab.type).toBe('sql');

    // Active tab should be the new one
    expect(result.current.activeTabId).toBe(newTab.id);

    // executeQueryFn should be called via setTimeout — we need to advance timers
    // The hook uses setTimeout(..., 100), so we wait for it
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(executeFn).toHaveBeenCalledWith('SELECT * FROM users LIMIT 50;', newTab.id);
        resolve();
      }, 150);
    });
  });

  test('handleGenerateSelect creates new tab with SELECT query', () => {
    const connection = makeConnection();
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: connection,
        metadata: defaultMetadata,
        schema: testSchema,
        queryEditorRef: makeEditorRef(),
      })
    );

    act(() => {
      result.current.handleGenerateSelect('users');
    });

    expect(result.current.tabs).toHaveLength(2);
    const newTab = result.current.tabs[1];
    expect(newTab.name).toBe('Query: users');
    expect(newTab.query).toContain('SELECT');
    expect(newTab.query).toContain('users');
    expect(newTab.query).toContain('LIMIT 100');
    expect(newTab.type).toBe('sql');
    expect(result.current.activeTabId).toBe(newTab.id);
  });

  test('setActiveTabId changes the active tab', () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
        queryEditorRef: makeEditorRef(),
      })
    );

    // Add a second tab
    act(() => {
      result.current.addTab();
    });

    const secondTabId = result.current.tabs[1].id;
    expect(result.current.activeTabId).toBe(secondTabId);

    // Switch back to the default tab
    act(() => {
      result.current.setActiveTabId('default');
    });

    expect(result.current.activeTabId).toBe('default');
    expect(result.current.currentTab.id).toBe('default');
  });

  test('editingTabId and editingTabName work for tab rename', () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
        queryEditorRef: makeEditorRef(),
      })
    );

    // Initially null / empty
    expect(result.current.editingTabId).toBeNull();
    expect(result.current.editingTabName).toBe('');

    // Set editing state
    act(() => {
      result.current.setEditingTabId('default');
      result.current.setEditingTabName('My Custom Query');
    });

    expect(result.current.editingTabId).toBe('default');
    expect(result.current.editingTabName).toBe('My Custom Query');

    // Clear editing state
    act(() => {
      result.current.setEditingTabId(null);
      result.current.setEditingTabName('');
    });

    expect(result.current.editingTabId).toBeNull();
    expect(result.current.editingTabName).toBe('');
  });

  test('addTab uses mongodb type when queryLanguage is json', () => {
    const connection = makeConnection({ type: 'mongodb' });
    const mongoMetadata: ProviderMetadata = {
      capabilities: {
        ...defaultMetadata.capabilities,
        queryLanguage: 'json' as const,
      },
      labels: defaultMetadata.labels,
    } as ProviderMetadata;

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: connection,
        metadata: mongoMetadata,
        schema: [],
        queryEditorRef: makeEditorRef(),
      })
    );

    act(() => {
      result.current.addTab();
    });

    const newTab = result.current.tabs[1];
    expect(newTab.type).toBe('mongodb');
  });
});
