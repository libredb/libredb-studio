import '../setup-dom';

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { renderHook, act, waitFor } from '@testing-library/react';

// Shared mocks — process-wide singletons (no contamination)
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { useTabManager } from '@/hooks/use-tab-manager';
import type { DatabaseConnection, TableSchema } from '@/lib/types';
import type { ProviderMetadata } from '@/hooks/use-provider-metadata';

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

describe('useTabManager', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('starts with one default tab', () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
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
    expect(newTab.query).toBe('');
    expect(newTab.result).toBeNull();
    expect(newTab.isExecuting).toBe(false);
  });

  test('closeTab removes a tab when more than 1 tab exists', () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
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
      })
    );

    act(() => {
      result.current.updateCurrentTab({ query: 'SELECT 1;', name: 'Renamed Tab' });
    });

    expect(result.current.currentTab.query).toBe('SELECT 1;');
    expect(result.current.currentTab.name).toBe('Renamed Tab');
  });

  test('updateTabById updates only the targeted tab query', () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
      })
    );

    act(() => {
      result.current.updateCurrentTab({ query: 'SELECT 1;' });
      result.current.addTab();
    });

    const [firstTab, secondTab] = result.current.tabs;
    expect(firstTab.query).toBe('SELECT 1;');
    expect(secondTab.query).toBe('');

    act(() => {
      result.current.updateTabById(firstTab.id, { query: 'SELECT 42;' });
    });

    expect(result.current.tabs[0].query).toBe('SELECT 42;');
    expect(result.current.tabs[1].query).toBe('');
  });

  test('handleTableClick creates new tab with query and calls executeQueryFn', () => {
    const connection = makeConnection();
    const executeFn = mock(() => {});

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: connection,
        metadata: defaultMetadata,
        schema: testSchema,
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
      })
    );

    act(() => {
      result.current.addTab();
    });

    const newTab = result.current.tabs[1];
    expect(newTab.type).toBe('mongodb');
  });

  // ─── Persistence: Load Effect ───

  test('load — empty storage with persistWorkspace defaults to DEFAULT_TAB', async () => {
    // No data in localStorage for this key
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
        persistWorkspace: true,
      })
    );

    await waitFor(() => {
      expect(result.current.tabs).toHaveLength(1);
      expect(result.current.tabs[0].id).toBe('default');
      expect(result.current.activeTabId).toBe('default');
    });
  });

  test('load — corrupted JSON falls back to DEFAULT_TAB', async () => {
    localStorage.setItem('libredb_workspace_tabs_v1:default', '<<<INVALID JSON>>>');

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
        persistWorkspace: true,
      })
    );

    await waitFor(() => {
      expect(result.current.tabs).toHaveLength(1);
      expect(result.current.tabs[0].id).toBe('default');
      expect(result.current.activeTabId).toBe('default');
    });
  });

  test('load — empty tabs array falls back to DEFAULT_TAB', async () => {
    localStorage.setItem(
      'libredb_workspace_tabs_v1:default',
      JSON.stringify({ activeTabId: 'x', tabs: [] })
    );

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
        persistWorkspace: true,
      })
    );

    await waitFor(() => {
      expect(result.current.tabs).toHaveLength(1);
      expect(result.current.tabs[0].id).toBe('default');
    });
  });

  test('load — stored activeTabId not in tabs falls back to first tab', async () => {
    localStorage.setItem(
      'libredb_workspace_tabs_v1:default',
      JSON.stringify({
        activeTabId: 'non-existent-id',
        tabs: [
          { id: 'tab-a', name: 'A', query: 'SELECT 1;', type: 'sql' },
          { id: 'tab-b', name: 'B', query: 'SELECT 2;', type: 'sql' },
        ],
      })
    );

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
        persistWorkspace: true,
      })
    );

    await waitFor(() => {
      expect(result.current.tabs).toHaveLength(2);
      expect(result.current.activeTabId).toBe('tab-a');
    });
  });

  test('restores tabs and active tab from workspace storage', async () => {
    localStorage.setItem(
      'libredb_workspace_tabs_v1:default',
      JSON.stringify({
        activeTabId: 'tab-2',
        tabs: [
          { id: 'tab-1', name: 'Query 1', query: 'SELECT 1;', type: 'sql' },
          { id: 'tab-2', name: 'Query 2', query: 'SELECT 2;', type: 'sql' },
        ],
      })
    );

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
        persistWorkspace: true,
      })
    );

    await waitFor(() => {
      expect(result.current.tabs).toHaveLength(2);
      expect(result.current.activeTabId).toBe('tab-2');
      expect(result.current.currentTab.query).toBe('SELECT 2;');
    });
  });

  test('persists query updates into workspace storage after debounce', async () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ id: 'persist-conn' }),
        metadata: null,
        schema: [],
        persistWorkspace: true,
      })
    );

    act(() => {
      result.current.updateCurrentTab({ query: 'SELECT now();' });
    });

    // Save is debounced by 500ms — wait for it to flush
    await waitFor(() => {
      const raw = localStorage.getItem('libredb_workspace_tabs_v1:persist-conn');
      expect(raw).toBeTruthy();

      const parsed = JSON.parse(raw || '{}') as {
        activeTabId: string;
        tabs: Array<{ query: string }>;
      };

      expect(parsed.activeTabId).toBe(result.current.activeTabId);
      expect(parsed.tabs[0].query).toBe('SELECT now();');
    }, { timeout: 2000 });
  });

  test('debounce — rapid updates only persist final state', async () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ id: 'debounce-conn' }),
        metadata: null,
        schema: [],
        persistWorkspace: true,
      })
    );

    // Rapid-fire 3 updates within debounce window
    act(() => {
      result.current.updateCurrentTab({ query: 'first' });
    });
    act(() => {
      result.current.updateCurrentTab({ query: 'second' });
    });
    act(() => {
      result.current.updateCurrentTab({ query: 'third' });
    });

    await waitFor(() => {
      const raw = localStorage.getItem('libredb_workspace_tabs_v1:debounce-conn');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!) as { tabs: Array<{ query: string }> };
      expect(parsed.tabs[0].query).toBe('third');
    }, { timeout: 2000 });
  });

  test('connection switch race — old tabs not saved to new connection key', async () => {
    // Seed connection A with tabs
    localStorage.setItem(
      'libredb_workspace_tabs_v1:conn-a',
      JSON.stringify({
        activeTabId: 'a-tab',
        tabs: [{ id: 'a-tab', name: 'A Tab', query: 'SELECT a;', type: 'sql' }],
      })
    );

    const connA = makeConnection({ id: 'conn-a' });
    const connB = makeConnection({ id: 'conn-b' });

    // Start with connection A
    const { result, rerender } = renderHook(
      ({ conn }) =>
        useTabManager({
          activeConnection: conn,
          metadata: null,
          schema: [],
          persistWorkspace: true,
        }),
      { initialProps: { conn: connA } }
    );

    // Wait for load to finish
    await waitFor(() => {
      expect(result.current.tabs).toHaveLength(1);
      expect(result.current.tabs[0].query).toBe('SELECT a;');
    });

    // Switch to connection B (which has no saved workspace)
    rerender({ conn: connB });

    // Wait for load to set defaults for B
    await waitFor(() => {
      expect(result.current.tabs[0].id).toBe('default');
    });

    // Wait for any potential debounced saves to flush
    await new Promise(r => setTimeout(r, 700));

    // Connection B's storage should only have the default tab, not A's tabs
    const rawB = localStorage.getItem('libredb_workspace_tabs_v1:conn-b');
    expect(rawB).toBeTruthy();
    const parsedB = JSON.parse(rawB!) as { tabs: Array<{ query: string }> };
    expect(parsedB.tabs[0].query).toBe('');

    // Connection A's storage should still be intact
    const rawA = localStorage.getItem('libredb_workspace_tabs_v1:conn-a');
    expect(rawA).toBeTruthy();
    const parsedA = JSON.parse(rawA!) as { tabs: Array<{ query: string }> };
    expect(parsedA.tabs[0].query).toBe('SELECT a;');
  });

  // ─── Functionality: Fallback & Edge Cases ───

  test('currentTab falls back to tabs[0] when activeTabId is stale', () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
      })
    );

    // Force a stale activeTabId via setActiveTabId
    act(() => {
      result.current.setActiveTabId('non-existent-id');
    });

    // currentTab should fall back to tabs[0]
    expect(result.current.currentTab).toBeDefined();
    expect(result.current.currentTab.id).toBe('default');
  });

  test('handleTableClick without metadata uses fallback query', () => {
    const executeFn = mock(() => {});
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection(),
        metadata: null,
        schema: testSchema,
      })
    );

    act(() => {
      result.current.handleTableClick('users', executeFn);
    });

    const newTab = result.current.tabs[1];
    expect(newTab.query).toBe('SELECT * FROM users LIMIT 50;');
    expect(newTab.type).toBe('sql');
    expect(newTab.name).toBe('users');
  });

  test('handleTableClick with MongoDB metadata creates mongodb tab', () => {
    const executeFn = mock(() => {});
    const mongoMetadata: ProviderMetadata = {
      capabilities: {
        ...defaultMetadata.capabilities,
        queryLanguage: 'json' as const,
      },
      labels: defaultMetadata.labels,
    } as ProviderMetadata;

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ type: 'mongodb' }),
        metadata: mongoMetadata,
        schema: [],
      })
    );

    act(() => {
      result.current.handleTableClick('users', executeFn);
    });

    const newTab = result.current.tabs[1];
    expect(newTab.type).toBe('mongodb');
    expect(newTab.query).toContain('"collection": "users"');
    expect(newTab.query).toContain('"operation": "find"');
  });

  test('handleGenerateSelect without metadata uses fallback SELECT', () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection(),
        metadata: null,
        schema: testSchema,
      })
    );

    act(() => {
      result.current.handleGenerateSelect('users');
    });

    const newTab = result.current.tabs[1];
    expect(newTab.query).toContain('SELECT');
    expect(newTab.query).toContain('id');
    expect(newTab.query).toContain('name');
    expect(newTab.query).toContain('LIMIT 100;');
    expect(newTab.type).toBe('sql');
  });

  test('handleGenerateSelect for unknown table uses * for columns', () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection(),
        metadata: null,
        schema: [],  // empty schema — table not found
      })
    );

    act(() => {
      result.current.handleGenerateSelect('unknown_table');
    });

    const newTab = result.current.tabs[1];
    expect(newTab.query).toContain('  *');
    expect(newTab.query).toContain('FROM unknown_table');
  });

  test('handleGenerateSelect with MongoDB metadata creates mongodb tab', () => {
    const mongoMetadata: ProviderMetadata = {
      capabilities: {
        ...defaultMetadata.capabilities,
        queryLanguage: 'json' as const,
      },
      labels: defaultMetadata.labels,
    } as ProviderMetadata;

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ type: 'mongodb' }),
        metadata: mongoMetadata,
        schema: testSchema,
      })
    );

    act(() => {
      result.current.handleGenerateSelect('users');
    });

    const newTab = result.current.tabs[1];
    expect(newTab.type).toBe('mongodb');
    expect(newTab.query).toContain('"collection": "users"');
    expect(newTab.query).toContain('"operation": "find"');
  });

});
