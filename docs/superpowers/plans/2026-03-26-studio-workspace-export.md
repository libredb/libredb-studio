# StudioWorkspace Composite Export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export the entire Studio workspace as a single `<StudioWorkspace />` composite component that platform can import with callback props, giving it the full IDE experience without rebuilding the orchestration layer.

**Architecture:** Adapter pattern — create new hooks (`useConnectionAdapter`, `useQueryAdapter`) that have the same return shape as the original hooks but delegate data operations to callback props instead of internal API routes. StudioWorkspace.tsx composes these adapters with existing UI components (QueryEditor, ResultsGrid, BottomPanel, etc.) to provide the full workspace.

**Tech Stack:** React 19, TypeScript (strict), tsup (build), bun:test + @testing-library/react (tests)

**Spec:** `docs/superpowers/specs/2026-03-26-studio-workspace-export-design.md`

---

### Task 1: Workspace Types

**Files:**
- Create: `src/workspace/types.ts`

- [ ] **Step 1: Create workspace types file**

```typescript
// src/workspace/types.ts
import type { DatabaseType, TableSchema, QueryResult, SavedQuery } from '@/lib/types';

// === Connection (platform → studio) ===

export interface WorkspaceConnection {
  id: string;
  name: string;
  type: DatabaseType;
}

// === User (platform → studio) ===

export interface WorkspaceUser {
  id: string;
  name?: string;
  role?: string;
}

// === Query result (studio ← platform) ===

export interface WorkspaceQueryResult {
  rows: Record<string, unknown>[];
  fields: string[];
  columns?: { name: string; type?: string }[];
  rowCount: number;
  executionTime: number;
  pagination?: {
    limit: number;
    offset: number;
    hasMore: boolean;
    totalReturned: number;
    wasLimited: boolean;
  };
}

// === Feature flags ===

export interface WorkspaceFeatures {
  ai?: boolean;
  charts?: boolean;
  codeGenerator?: boolean;
  testDataGenerator?: boolean;
  schemaDiagram?: boolean;
  dataImport?: boolean;
  inlineEditing?: boolean;
  transactions?: boolean;
  connectionManagement?: boolean;
  dataMasking?: boolean;
}

export const DEFAULT_WORKSPACE_FEATURES: Required<WorkspaceFeatures> = {
  ai: false,
  charts: true,
  codeGenerator: true,
  testDataGenerator: true,
  schemaDiagram: true,
  dataImport: true,
  inlineEditing: false,
  transactions: false,
  connectionManagement: false,
  dataMasking: false,
};

// === Saved query input ===

export interface SavedQueryInput {
  name: string;
  query: string;
  description?: string;
  connectionType?: string;
  tags?: string[];
}

// === Main props ===

export interface StudioWorkspaceProps {
  connections: WorkspaceConnection[];
  currentUser?: WorkspaceUser;

  onQueryExecute: (connectionId: string, sql: string, options?: {
    limit?: number;
    offset?: number;
    unlimited?: boolean;
  }) => Promise<WorkspaceQueryResult>;
  onSchemaFetch: (connectionId: string) => Promise<TableSchema[]>;

  onTestConnection?: (config: {
    type: DatabaseType;
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    sslEnabled?: boolean;
  }) => Promise<{ success: boolean; message: string }>;
  onSaveQuery?: (query: SavedQueryInput) => Promise<void>;
  onLoadSavedQueries?: () => Promise<SavedQuery[]>;

  features?: WorkspaceFeatures;
  className?: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/workspace/types.ts
git commit -m "feat(workspace): add StudioWorkspace types and props interface"
```

---

### Task 2: Connection Adapter Hook

**Files:**
- Create: `src/workspace/hooks/use-connection-adapter.ts`
- Test: `tests/hooks/use-connection-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/hooks/use-connection-adapter.test.ts
import '../setup-dom';

import { describe, test, expect, beforeEach } from 'bun:test';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useConnectionAdapter } from '@/workspace/hooks/use-connection-adapter';
import type { WorkspaceConnection } from '@/workspace/types';
import type { TableSchema } from '@/lib/types';

const makeConnections = (): WorkspaceConnection[] => [
  { id: 'conn-1', name: 'Production DB', type: 'postgres' },
  { id: 'conn-2', name: 'Analytics DB', type: 'mysql' },
];

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
];

describe('useConnectionAdapter', () => {
  test('initializes with first connection as active', () => {
    const connections = makeConnections();
    const { result } = renderHook(() =>
      useConnectionAdapter({
        connections,
        onSchemaFetch: async () => [],
      })
    );

    expect(result.current.connections).toEqual(connections);
    expect(result.current.activeConnection?.id).toBe('conn-1');
  });

  test('returns null activeConnection when connections array is empty', () => {
    const { result } = renderHook(() =>
      useConnectionAdapter({
        connections: [],
        onSchemaFetch: async () => [],
      })
    );

    expect(result.current.activeConnection).toBeNull();
  });

  test('setActiveConnection updates active connection', () => {
    const connections = makeConnections();
    const { result } = renderHook(() =>
      useConnectionAdapter({
        connections,
        onSchemaFetch: async () => [],
      })
    );

    act(() => {
      result.current.setActiveConnection(connections[1]);
    });

    expect(result.current.activeConnection?.id).toBe('conn-2');
  });

  test('fetchSchema calls onSchemaFetch and updates schema state', async () => {
    const schemaData = makeSchema();
    let fetchedConnectionId: string | null = null;

    const { result } = renderHook(() =>
      useConnectionAdapter({
        connections: makeConnections(),
        onSchemaFetch: async (connId) => {
          fetchedConnectionId = connId;
          return schemaData;
        },
      })
    );

    await act(async () => {
      await result.current.fetchSchema(result.current.activeConnection!);
    });

    expect(fetchedConnectionId).toBe('conn-1');
    expect(result.current.schema).toEqual(schemaData);
    expect(result.current.tableNames).toEqual(['users']);
    expect(result.current.isLoadingSchema).toBe(false);
  });

  test('fetchSchema sets isLoadingSchema during fetch', async () => {
    let resolveSchema: ((val: TableSchema[]) => void) | null = null;
    const schemaPromise = new Promise<TableSchema[]>((resolve) => {
      resolveSchema = resolve;
    });

    const { result } = renderHook(() =>
      useConnectionAdapter({
        connections: makeConnections(),
        onSchemaFetch: async () => schemaPromise,
      })
    );

    // Start fetch (don't await)
    let fetchPromise: Promise<void>;
    act(() => {
      fetchPromise = result.current.fetchSchema(result.current.activeConnection!);
    });

    expect(result.current.isLoadingSchema).toBe(true);

    // Resolve
    await act(async () => {
      resolveSchema!(makeSchema());
      await fetchPromise!;
    });

    expect(result.current.isLoadingSchema).toBe(false);
  });

  test('updates connections when props change', () => {
    const initial = makeConnections();
    const { result, rerender } = renderHook(
      ({ connections }) =>
        useConnectionAdapter({
          connections,
          onSchemaFetch: async () => [],
        }),
      { initialProps: { connections: initial } }
    );

    expect(result.current.connections).toHaveLength(2);

    const updated = [...initial, { id: 'conn-3', name: 'New DB', type: 'sqlite' as const }];
    rerender({ connections: updated });

    expect(result.current.connections).toHaveLength(3);
  });

  test('resets activeConnection when it is removed from connections', () => {
    const initial = makeConnections();
    const { result, rerender } = renderHook(
      ({ connections }) =>
        useConnectionAdapter({
          connections,
          onSchemaFetch: async () => [],
        }),
      { initialProps: { connections: initial } }
    );

    // Set active to conn-2
    act(() => {
      result.current.setActiveConnection(initial[1]);
    });
    expect(result.current.activeConnection?.id).toBe('conn-2');

    // Remove conn-2
    rerender({ connections: [initial[0]] });

    expect(result.current.activeConnection?.id).toBe('conn-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/cevheri/projects/libredb/libredb-studio && bun run test tests/hooks/use-connection-adapter.test.ts`
Expected: FAIL — module `@/workspace/hooks/use-connection-adapter` not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/workspace/hooks/use-connection-adapter.ts
'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { DatabaseConnection, TableSchema } from '@/lib/types';
import type { WorkspaceConnection } from '@/workspace/types';

interface UseConnectionAdapterParams {
  connections: WorkspaceConnection[];
  onSchemaFetch: (connectionId: string) => Promise<TableSchema[]>;
}

/**
 * Adapter hook that provides the same interface as useConnectionManager
 * but sources data from props and callbacks instead of internal API routes.
 */
export function useConnectionAdapter({
  connections: externalConnections,
  onSchemaFetch,
}: UseConnectionAdapterParams) {
  // Convert WorkspaceConnection[] to DatabaseConnection[] (add required fields)
  const connections: DatabaseConnection[] = useMemo(
    () =>
      externalConnections.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        createdAt: new Date(),
        managed: true, // platform-managed connections
      })),
    [externalConnections]
  );

  const [activeConnection, setActiveConnection] = useState<DatabaseConnection | null>(
    connections[0] ?? null
  );
  const [schema, setSchema] = useState<TableSchema[]>([]);
  const [isLoadingSchema, setIsLoadingSchema] = useState(false);

  // Sync activeConnection when connections prop changes
  useEffect(() => {
    if (connections.length === 0) {
      setActiveConnection(null);
      return;
    }

    // If current active is still in the list, keep it
    if (activeConnection && connections.some((c) => c.id === activeConnection.id)) {
      return;
    }

    // Otherwise, select first
    setActiveConnection(connections[0]);
  }, [connections]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchSchema = useCallback(
    async (conn: DatabaseConnection) => {
      setIsLoadingSchema(true);
      try {
        const result = await onSchemaFetch(conn.id);
        setSchema(result);
      } catch {
        setSchema([]);
      } finally {
        setIsLoadingSchema(false);
      }
    },
    [onSchemaFetch]
  );

  const tableNames = useMemo(() => schema.map((s) => s.name), [schema]);
  const schemaContext = useMemo(() => JSON.stringify(schema), [schema]);

  return {
    connections,
    setConnections: () => {}, // no-op — platform controls connections
    activeConnection,
    setActiveConnection: setActiveConnection as (conn: DatabaseConnection | null) => void,
    schema,
    setSchema,
    isLoadingSchema,
    connectionPulse: null as 'healthy' | 'degraded' | 'error' | null,
    fetchSchema,
    tableNames,
    schemaContext,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/cevheri/projects/libredb/libredb-studio && bun run test tests/hooks/use-connection-adapter.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/workspace/hooks/use-connection-adapter.ts tests/hooks/use-connection-adapter.test.ts
git commit -m "feat(workspace): add useConnectionAdapter hook with tests"
```

---

### Task 3: Query Adapter Hook

**Files:**
- Create: `src/workspace/hooks/use-query-adapter.ts`
- Test: `tests/hooks/use-query-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/hooks/use-query-adapter.test.ts
import '../setup-dom';

import { describe, test, expect, beforeEach } from 'bun:test';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useQueryAdapter } from '@/workspace/hooks/use-query-adapter';
import type { QueryTab } from '@/lib/types';
import type { WorkspaceQueryResult, WorkspaceConnection } from '@/workspace/types';

const mockConnection: WorkspaceConnection & { createdAt: Date; managed: boolean } = {
  id: 'conn-1',
  name: 'Test DB',
  type: 'postgres',
  createdAt: new Date(),
  managed: true,
};

const mockQueryResult: WorkspaceQueryResult = {
  rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
  fields: ['id', 'name'],
  rowCount: 2,
  executionTime: 42,
};

const defaultTab: QueryTab = {
  id: 'tab-1',
  name: 'Query 1',
  query: 'SELECT * FROM users',
  result: null,
  isExecuting: false,
  type: 'sql',
};

describe('useQueryAdapter', () => {
  test('executeQuery calls onQueryExecute and updates tab with result', async () => {
    let executedSql: string | null = null;
    let executedConnId: string | null = null;

    const tabs = [defaultTab];
    const setTabs = (fn: (prev: QueryTab[]) => QueryTab[]) => {
      const updated = fn(tabs);
      tabs.splice(0, tabs.length, ...updated);
    };

    const { result } = renderHook(() =>
      useQueryAdapter({
        activeConnection: mockConnection,
        onQueryExecute: async (connId, sql) => {
          executedConnId = connId;
          executedSql = sql;
          return mockQueryResult;
        },
        tabs,
        activeTabId: 'tab-1',
        currentTab: defaultTab,
        setTabs: setTabs as any,
        fetchSchema: async () => {},
        features: {},
      })
    );

    await act(async () => {
      await result.current.executeQuery('SELECT 1');
    });

    expect(executedConnId).toBe('conn-1');
    expect(executedSql).toBe('SELECT 1');
  });

  test('executeQuery uses tab query when no override provided', async () => {
    let executedSql: string | null = null;
    const tabs = [defaultTab];
    const setTabs = (fn: (prev: QueryTab[]) => QueryTab[]) => {
      const updated = fn(tabs);
      tabs.splice(0, tabs.length, ...updated);
    };

    const { result } = renderHook(() =>
      useQueryAdapter({
        activeConnection: mockConnection,
        onQueryExecute: async (_connId, sql) => {
          executedSql = sql;
          return mockQueryResult;
        },
        tabs,
        activeTabId: 'tab-1',
        currentTab: defaultTab,
        setTabs: setTabs as any,
        fetchSchema: async () => {},
        features: {},
      })
    );

    await act(async () => {
      await result.current.executeQuery();
    });

    expect(executedSql).toBe('SELECT * FROM users');
  });

  test('returns error state when onQueryExecute throws', async () => {
    const tabs = [defaultTab];
    const setTabs = (fn: (prev: QueryTab[]) => QueryTab[]) => {
      const updated = fn(tabs);
      tabs.splice(0, tabs.length, ...updated);
    };

    const { result } = renderHook(() =>
      useQueryAdapter({
        activeConnection: mockConnection,
        onQueryExecute: async () => {
          throw new Error('Connection refused');
        },
        tabs,
        activeTabId: 'tab-1',
        currentTab: defaultTab,
        setTabs: setTabs as any,
        fetchSchema: async () => {},
        features: {},
      })
    );

    await act(async () => {
      await result.current.executeQuery('SELECT 1');
    });

    // Tab should not be stuck in executing state
    expect(tabs[0].isExecuting).toBe(false);
  });

  test('cancelQuery aborts in-flight request', async () => {
    let resolveFetch: ((val: WorkspaceQueryResult) => void) | null = null;

    const tabs = [defaultTab];
    const setTabs = (fn: (prev: QueryTab[]) => QueryTab[]) => {
      const updated = fn(tabs);
      tabs.splice(0, tabs.length, ...updated);
    };

    const { result } = renderHook(() =>
      useQueryAdapter({
        activeConnection: mockConnection,
        onQueryExecute: async () => {
          return new Promise<WorkspaceQueryResult>((resolve) => {
            resolveFetch = resolve;
          });
        },
        tabs,
        activeTabId: 'tab-1',
        currentTab: defaultTab,
        setTabs: setTabs as any,
        fetchSchema: async () => {},
        features: {},
      })
    );

    // Start query (don't await)
    act(() => {
      result.current.executeQuery('SELECT 1');
    });

    // Cancel
    act(() => {
      result.current.cancelQuery();
    });

    // Resolve the pending promise (shouldn't crash)
    resolveFetch?.(mockQueryResult);

    expect(tabs[0].isExecuting).toBe(false);
  });

  test('bottomPanelMode defaults to results', () => {
    const { result } = renderHook(() =>
      useQueryAdapter({
        activeConnection: mockConnection,
        onQueryExecute: async () => mockQueryResult,
        tabs: [defaultTab],
        activeTabId: 'tab-1',
        currentTab: defaultTab,
        setTabs: () => {},
        fetchSchema: async () => {},
        features: {},
      })
    );

    expect(result.current.bottomPanelMode).toBe('results');
  });

  test('historyKey increments after successful query', async () => {
    const tabs = [defaultTab];
    const setTabs = (fn: (prev: QueryTab[]) => QueryTab[]) => {
      const updated = fn(tabs);
      tabs.splice(0, tabs.length, ...updated);
    };

    const { result } = renderHook(() =>
      useQueryAdapter({
        activeConnection: mockConnection,
        onQueryExecute: async () => mockQueryResult,
        tabs,
        activeTabId: 'tab-1',
        currentTab: defaultTab,
        setTabs: setTabs as any,
        fetchSchema: async () => {},
        features: {},
      })
    );

    const initialKey = result.current.historyKey;

    await act(async () => {
      await result.current.executeQuery('SELECT 1');
    });

    expect(result.current.historyKey).toBe(initialKey + 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/cevheri/projects/libredb/libredb-studio && bun run test tests/hooks/use-query-adapter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/workspace/hooks/use-query-adapter.ts
'use client';

import { useState, useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import type { DatabaseConnection, QueryTab } from '@/lib/types';
import type { WorkspaceQueryResult, WorkspaceFeatures } from '@/workspace/types';
import type { BottomPanelMode } from '@/components/studio/BottomPanel';
import { useToast } from '@/hooks/use-toast';

interface UseQueryAdapterParams {
  activeConnection: DatabaseConnection | null;
  onQueryExecute: (connectionId: string, sql: string, options?: {
    limit?: number;
    offset?: number;
    unlimited?: boolean;
  }) => Promise<WorkspaceQueryResult>;
  tabs: QueryTab[];
  activeTabId: string;
  currentTab: QueryTab;
  setTabs: Dispatch<SetStateAction<QueryTab[]>>;
  fetchSchema: (conn: DatabaseConnection) => Promise<void>;
  features: Partial<WorkspaceFeatures>;
}

export function useQueryAdapter({
  activeConnection,
  onQueryExecute,
  tabs,
  activeTabId,
  currentTab,
  setTabs,
  fetchSchema,
  features,
}: UseQueryAdapterParams) {
  const [historyKey, setHistoryKey] = useState(0);
  const [bottomPanelMode, setBottomPanelMode] = useState<BottomPanelMode>('results');
  const [safetyCheckQuery, setSafetyCheckQuery] = useState<string | null>(null);
  const [unlimitedWarningOpen, setUnlimitedWarningOpen] = useState(false);
  const [pendingUnlimitedQuery, setPendingUnlimitedQuery] = useState<{
    query: string;
    tabId: string;
  } | null>(null);

  const cancelledRef = useRef(false);
  const { toast } = useToast();

  // In-memory history for embedded mode
  const historyRef = useRef<Array<{
    id: string;
    connectionId: string;
    connectionName: string;
    tabName: string;
    query: string;
    executionTime: number;
    status: 'success' | 'error';
    executedAt: Date;
    rowCount?: number;
    errorMessage?: string;
  }>>([]);

  const executeQuery = useCallback(async (
    overrideQuery?: string,
    tabId?: string,
    isExplain: boolean = false,
  ) => {
    const targetTabId = tabId || activeTabId;
    const tabToExec = tabs.find(t => t.id === targetTabId) || currentTab;
    const queryToExecute = overrideQuery || tabToExec.query;

    if (!activeConnection) {
      toast({ title: 'No Connection', description: 'Select a connection first.', variant: 'destructive' });
      return;
    }

    if (!queryToExecute.trim()) {
      toast({ title: 'Empty Query', description: 'Enter a query to execute.', variant: 'destructive' });
      return;
    }

    cancelledRef.current = false;

    // Set executing state
    setTabs(prev => prev.map(t => t.id === targetTabId
      ? { ...t, isExecuting: true }
      : t
    ));
    setBottomPanelMode('results');

    const startTime = Date.now();

    try {
      const result = await onQueryExecute(activeConnection.id, queryToExecute);

      if (cancelledRef.current) return;

      const executionTime = result.executionTime || (Date.now() - startTime);

      // Add to in-memory history
      historyRef.current.unshift({
        id: Math.random().toString(36).substring(7),
        connectionId: activeConnection.id,
        connectionName: activeConnection.name,
        tabName: tabToExec.name,
        query: queryToExecute,
        executionTime,
        status: 'success',
        executedAt: new Date(),
        rowCount: result.rowCount,
      });

      // Update tab with result
      setTabs(prev => prev.map(t => t.id === targetTabId
        ? {
            ...t,
            result: {
              rows: result.rows,
              fields: result.fields || result.columns?.map(c => c.name) || Object.keys(result.rows[0] || {}),
              rowCount: result.rowCount,
              executionTime,
              pagination: result.pagination,
            },
            allRows: result.rows,
            currentOffset: result.rows.length,
            isExecuting: false,
            isLoadingMore: false,
          }
        : t
      ));

      setHistoryKey(prev => prev + 1);
    } catch (error) {
      if (cancelledRef.current) return;

      const errorMessage = error instanceof Error ? error.message : 'Query failed';

      // Add error to history
      historyRef.current.unshift({
        id: Math.random().toString(36).substring(7),
        connectionId: activeConnection.id,
        connectionName: activeConnection.name,
        tabName: tabToExec.name,
        query: queryToExecute,
        executionTime: Date.now() - startTime,
        status: 'error',
        executedAt: new Date(),
        errorMessage,
      });

      setTabs(prev => prev.map(t => t.id === targetTabId
        ? { ...t, isExecuting: false, isLoadingMore: false }
        : t
      ));

      toast({ title: 'Query Error', description: errorMessage, variant: 'destructive' });
    }
  }, [activeConnection, tabs, activeTabId, currentTab, onQueryExecute, setTabs, toast]);

  const forceExecuteQuery = useCallback((query: string) => {
    setSafetyCheckQuery(null);
    executeQuery(query);
  }, [executeQuery]);

  const cancelQuery = useCallback(() => {
    cancelledRef.current = true;
    setTabs(prev => prev.map(t => t.isExecuting
      ? { ...t, isExecuting: false, isLoadingMore: false }
      : t
    ));
    toast({ title: 'Query Cancelled', description: 'Query execution was cancelled.' });
  }, [setTabs, toast]);

  const handleLoadMore = useCallback(() => {
    if (!currentTab.result?.pagination?.hasMore || !activeConnection) return;

    const currentOffset = currentTab.currentOffset || currentTab.result.rows.length;

    setTabs(prev => prev.map(t => t.id === currentTab.id
      ? { ...t, isLoadingMore: true }
      : t
    ));

    onQueryExecute(activeConnection.id, currentTab.query, {
      limit: 500,
      offset: currentOffset,
    }).then(result => {
      if (cancelledRef.current) return;

      setTabs(prev => prev.map(t => {
        if (t.id !== currentTab.id || !t.result) return t;
        const existingRows = t.allRows || t.result.rows;
        const newAllRows = [...existingRows, ...result.rows];
        return {
          ...t,
          result: {
            ...t.result,
            rows: newAllRows,
            rowCount: newAllRows.length,
            pagination: result.pagination,
          },
          allRows: newAllRows,
          currentOffset: currentOffset + result.rows.length,
          isLoadingMore: false,
        };
      }));
    }).catch(() => {
      setTabs(prev => prev.map(t => t.id === currentTab.id
        ? { ...t, isLoadingMore: false }
        : t
      ));
    });
  }, [currentTab, activeConnection, onQueryExecute, setTabs]);

  const handleUnlimitedQuery = useCallback(() => {
    if (!pendingUnlimitedQuery || !activeConnection) return;
    // For embedded mode, just re-execute with unlimited flag
    // The consumer's onQueryExecute handles the actual execution
    executeQuery(pendingUnlimitedQuery.query, pendingUnlimitedQuery.tabId);
    setUnlimitedWarningOpen(false);
    setPendingUnlimitedQuery(null);
  }, [pendingUnlimitedQuery, activeConnection, executeQuery]);

  return {
    executeQuery,
    forceExecuteQuery,
    cancelQuery,
    handleLoadMore,
    handleUnlimitedQuery,
    safetyCheckQuery,
    setSafetyCheckQuery,
    unlimitedWarningOpen,
    setUnlimitedWarningOpen,
    pendingUnlimitedQuery,
    setPendingUnlimitedQuery,
    historyKey,
    bottomPanelMode,
    setBottomPanelMode,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/cevheri/projects/libredb/libredb-studio && bun run test tests/hooks/use-query-adapter.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/workspace/hooks/use-query-adapter.ts tests/hooks/use-query-adapter.test.ts
git commit -m "feat(workspace): add useQueryAdapter hook with tests"
```

---

### Task 4: StudioWorkspace Component

**Files:**
- Create: `src/workspace/StudioWorkspace.tsx`

This is the core composite component. It composes the adapter hooks with existing UI components.

- [ ] **Step 1: Create StudioWorkspace.tsx**

```typescript
// src/workspace/StudioWorkspace.tsx
'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Sidebar, ConnectionsList } from '@/components/sidebar';
import { MobileNav } from '@/components/MobileNav';
import { SchemaExplorer } from '@/components/schema-explorer';
import { QueryEditor, QueryEditorRef } from '@/components/QueryEditor';
import { DataProfiler } from '@/components/DataProfiler';
import { CodeGenerator } from '@/components/CodeGenerator';
import { TestDataGenerator } from '@/components/TestDataGenerator';
import { SchemaDiagram } from '@/components/SchemaDiagram';
import { DataImportModal } from '@/components/DataImportModal';
import { SaveQueryModal } from '@/components/SaveQueryModal';
import {
  StudioTabBar,
  QueryToolbar,
  BottomPanel,
} from '@/components/studio/index';
import type { SavedQuery } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { useTabManager } from '@/hooks/use-tab-manager';
import { useConnectionAdapter } from '@/workspace/hooks/use-connection-adapter';
import { useQueryAdapter } from '@/workspace/hooks/use-query-adapter';
import type { StudioWorkspaceProps } from '@/workspace/types';
import { DEFAULT_WORKSPACE_FEATURES } from '@/workspace/types';
import { cn } from '@/lib/utils';
import { Database, Plus } from 'lucide-react';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';

export function StudioWorkspace({
  connections: externalConnections,
  currentUser,
  onQueryExecute,
  onSchemaFetch,
  onSaveQuery,
  onLoadSavedQueries,
  features: featuresProp,
  className,
}: StudioWorkspaceProps) {
  const queryEditorRef = useRef<QueryEditorRef>(null);
  const { toast } = useToast();

  const features = useMemo(
    () => ({ ...DEFAULT_WORKSPACE_FEATURES, ...featuresProp }),
    [featuresProp]
  );

  // 1. Connection Adapter
  const conn = useConnectionAdapter({
    connections: externalConnections,
    onSchemaFetch,
  });

  // 2. Tab Manager (reused as-is — pure UI state)
  const tabMgr = useTabManager({
    activeConnection: conn.activeConnection,
    metadata: null, // no direct DB access in embedded mode
    schema: conn.schema,
  });

  // 3. Query Adapter
  const queryExec = useQueryAdapter({
    activeConnection: conn.activeConnection,
    onQueryExecute,
    tabs: tabMgr.tabs,
    activeTabId: tabMgr.activeTabId,
    currentTab: tabMgr.currentTab,
    setTabs: tabMgr.setTabs,
    fetchSchema: conn.fetchSchema,
    features,
  });

  // Fetch schema on connection change
  useEffect(() => {
    if (conn.activeConnection) {
      conn.fetchSchema(conn.activeConnection);
    } else {
      conn.setSchema([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.activeConnection]);

  // Modal state
  const [showDiagram, setShowDiagram] = useState(false);
  const [isSaveQueryModalOpen, setIsSaveQueryModalOpen] = useState(false);
  const [savedKey, setSavedKey] = useState(0);
  const [activeMobileTab, setActiveMobileTab] = useState<'database' | 'schema' | 'editor'>('editor');
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isNL2SQLOpen, setIsNL2SQLOpen] = useState(false);
  const [profilerTable, setProfilerTable] = useState<string | null>(null);
  const [codeGenTable, setCodeGenTable] = useState<string | null>(null);
  const [testDataTable, setTestDataTable] = useState<string | null>(null);

  const handleSaveQuery = async (name: string, description: string, tags: string[]) => {
    if (!conn.activeConnection) return;
    if (onSaveQuery) {
      await onSaveQuery({
        name,
        query: tabMgr.currentTab.query,
        description,
        connectionType: conn.activeConnection.type,
        tags,
      });
      setSavedKey(prev => prev + 1);
      toast({ title: 'Query Saved', description: `"${name}" has been saved.` });
    }
  };

  const exportResults = (format: 'csv' | 'json' | 'sql-insert' | 'sql-ddl') => {
    if (!tabMgr.currentTab.result) return;
    const data = tabMgr.currentTab.result.rows;
    let content = '';
    let mimeType = 'text/plain';
    let ext: string = format;

    if (format === 'csv') {
      const headers = Object.keys(data[0] || {}).join(',');
      const rows = data.map(row => Object.values(row).map(val => `"${val}"`).join(',')).join('\n');
      content = `${headers}\n${rows}`;
      mimeType = 'text/csv';
      ext = 'csv';
    } else if (format === 'json') {
      content = JSON.stringify(data, null, 2);
      mimeType = 'application/json';
      ext = 'json';
    } else if (format === 'sql-insert') {
      const tableName = tabMgr.currentTab.name.replace(/^Query[:  ]*/, '') || 'table_name';
      const columns = Object.keys(data[0] || {});
      const lines = data.map(row => {
        const values = columns.map(col => {
          const val = row[col];
          if (val === null || val === undefined) return 'NULL';
          if (typeof val === 'number' || typeof val === 'boolean') return String(val);
          return `'${String(val).replace(/'/g, "''")}'`;
        });
        return `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')});`;
      });
      content = lines.join('\n');
      mimeType = 'text/sql';
      ext = 'sql';
    } else if (format === 'sql-ddl') {
      const tableName = tabMgr.currentTab.name.replace(/^Query[:  ]*/, '') || 'table_name';
      const columns = Object.keys(data[0] || {});
      const colDefs = columns.map(col => {
        const sampleVal = data[0]?.[col];
        let sqlType = 'TEXT';
        if (typeof sampleVal === 'number') sqlType = Number.isInteger(sampleVal) ? 'INTEGER' : 'NUMERIC';
        else if (typeof sampleVal === 'boolean') sqlType = 'BOOLEAN';
        else if (sampleVal instanceof Date) sqlType = 'TIMESTAMP';
        return `  ${col} ${sqlType}`;
      });
      content = `CREATE TABLE ${tableName} (\n${colDefs.join(',\n')}\n);`;
      mimeType = 'text/sql';
      ext = 'sql';
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `query_result_export.${ext}`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const onTableClick = (tableName: string) => {
    tabMgr.handleTableClick(tableName, queryExec.executeQuery);
  };

  return (
    <div className={cn(
      'flex h-full w-full bg-[#050505] text-zinc-100 overflow-hidden font-sans select-none',
      className
    )}>
      <ResizablePanelGroup id="workspace-main" direction="horizontal" className="h-full">
        {/* Sidebar */}
        <ResizablePanel defaultSize={22} minSize={15} maxSize={35} className="hidden md:block">
          <Sidebar
            connections={conn.connections}
            activeConnection={conn.activeConnection}
            schema={conn.schema}
            isLoadingSchema={conn.isLoadingSchema}
            onSelectConnection={conn.setActiveConnection}
            onDeleteConnection={() => {}} // no-op in embedded mode
            onEditConnection={() => {}}   // no-op in embedded mode
            onAddConnection={() => {}}    // no-op in embedded mode
            onTableClick={onTableClick}
            onGenerateSelect={tabMgr.handleGenerateSelect}
            onCreateTableClick={() => {}} // no-op in embedded mode
            onShowDiagram={features.schemaDiagram ? () => setShowDiagram(true) : undefined}
            isAdmin={false}
            onOpenMaintenance={() => {}}
            databaseType={conn.activeConnection?.type}
            metadata={null}
            onProfileTable={features.codeGenerator ? (name) => setProfilerTable(name) : undefined}
            onGenerateCode={features.codeGenerator ? (name) => setCodeGenTable(name) : undefined}
            onGenerateTestData={features.testDataGenerator ? (name) => setTestDataTable(name) : undefined}
          />
        </ResizablePanel>
        <ResizableHandle className="hidden md:flex w-1 bg-transparent hover:bg-blue-500/30 transition-colors" />

        {/* Main Editor Area */}
        <ResizablePanel defaultSize={78}>
          <div className="flex-1 flex flex-col min-w-0 h-full bg-[#0a0a0a] pb-16 md:pb-0">
            {/* Tab Bar */}
            <StudioTabBar
              tabs={tabMgr.tabs}
              activeTabId={tabMgr.activeTabId}
              editingTabId={tabMgr.editingTabId}
              editingTabName={tabMgr.editingTabName}
              onSetActiveTabId={tabMgr.setActiveTabId}
              onSetEditingTabId={tabMgr.setEditingTabId}
              onSetEditingTabName={tabMgr.setEditingTabName}
              onSetTabs={tabMgr.setTabs}
              onCloseTab={tabMgr.closeTab}
              onAddTab={tabMgr.addTab}
            />

            <main className="flex-1 overflow-hidden relative">
              {/* Schema Diagram Overlay */}
              <AnimatePresence>
                {features.schemaDiagram && showDiagram && (
                  <SchemaDiagram schema={conn.schema} onClose={() => setShowDiagram(false)} />
                )}
              </AnimatePresence>

              {/* Mobile: Database Tab */}
              {activeMobileTab === 'database' && (
                <div className="md:hidden h-full bg-[#080808] overflow-auto p-4">
                  <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-sm font-bold text-zinc-300 uppercase tracking-widest">Connections</h2>
                  </div>
                  <ConnectionsList
                    connections={conn.connections}
                    activeConnection={conn.activeConnection}
                    onSelectConnection={(c) => {
                      conn.setActiveConnection(c);
                      setActiveMobileTab('editor');
                    }}
                    onDeleteConnection={() => {}}
                    onAddConnection={() => {}}
                  />
                </div>
              )}

              {/* Mobile: Schema Tab */}
              {activeMobileTab === 'schema' && (
                <div className="md:hidden h-full bg-[#080808] overflow-auto p-4">
                  {conn.activeConnection ? (
                    <SchemaExplorer
                      schema={conn.schema}
                      isLoadingSchema={conn.isLoadingSchema}
                      onTableClick={(tableName) => {
                        onTableClick(tableName);
                        setActiveMobileTab('editor');
                      }}
                      onGenerateSelect={(tableName) => {
                        tabMgr.handleGenerateSelect(tableName);
                        setActiveMobileTab('editor');
                      }}
                      onCreateTableClick={() => {}}
                      isAdmin={false}
                      onOpenMaintenance={() => {}}
                      databaseType={conn.activeConnection?.type}
                      metadata={null}
                      onProfileTable={features.codeGenerator ? (name) => setProfilerTable(name) : undefined}
                      onGenerateCode={features.codeGenerator ? (name) => setCodeGenTable(name) : undefined}
                      onGenerateTestData={features.testDataGenerator ? (name) => setTestDataTable(name) : undefined}
                    />
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full text-zinc-500">
                      <Database className="w-12 h-12 mb-4 opacity-30" />
                      <p className="text-sm">Select a connection first</p>
                    </div>
                  )}
                </div>
              )}

              {/* Editor + Results */}
              <div className={cn('h-full', activeMobileTab !== 'editor' && 'hidden md:block')}>
                <ResizablePanelGroup id="workspace-editor" direction="vertical">
                  <ResizablePanel defaultSize={40} minSize={20}>
                    <div className="h-full flex flex-col">
                      <QueryToolbar
                        activeConnection={conn.activeConnection}
                        metadata={null}
                        isExecuting={tabMgr.currentTab.isExecuting}
                        playgroundMode={false}
                        transactionActive={false}
                        editingEnabled={false}
                        onSaveQuery={onSaveQuery ? () => setIsSaveQueryModalOpen(true) : undefined}
                        onExecuteQuery={() => queryExec.executeQuery()}
                        onCancelQuery={queryExec.cancelQuery}
                        onBeginTransaction={() => {}}
                        onCommitTransaction={() => {}}
                        onRollbackTransaction={() => {}}
                        onTogglePlayground={() => {}}
                        onToggleEditing={() => {}}
                        onImport={features.dataImport ? () => setIsImportModalOpen(true) : undefined}
                      />
                      <div className="flex-1 relative">
                        <QueryEditor
                          ref={queryEditorRef}
                          value={tabMgr.currentTab.query}
                          onContentChange={(val) => tabMgr.updateTabById(tabMgr.currentTab.id, { query: val })}
                          language={tabMgr.currentTab.type === 'mongodb' ? 'json' : 'sql'}
                          tables={conn.tableNames}
                          databaseType={conn.activeConnection?.type}
                          schemaContext={conn.schemaContext}
                          capabilities={undefined}
                        />
                      </div>
                    </div>
                  </ResizablePanel>
                  <ResizableHandle className="h-1 bg-white/5 hover:bg-blue-500/20" />
                  <ResizablePanel defaultSize={60} minSize={20}>
                    <BottomPanel
                      mode={queryExec.bottomPanelMode}
                      onSetMode={queryExec.setBottomPanelMode}
                      currentTab={tabMgr.currentTab}
                      schema={conn.schema}
                      schemaContext={conn.schemaContext}
                      activeConnection={conn.activeConnection}
                      metadata={null}
                      historyKey={queryExec.historyKey}
                      savedKey={savedKey}
                      isNL2SQLOpen={features.ai ? isNL2SQLOpen : false}
                      onSetIsNL2SQLOpen={features.ai ? setIsNL2SQLOpen : () => {}}
                      maskingEnabled={false}
                      onToggleMasking={undefined}
                      userRole={currentUser?.role}
                      maskingConfig={{ enabled: false, mode: 'partial', patterns: [] }}
                      editingEnabled={false}
                      pendingChanges={[]}
                      onCellChange={() => {}}
                      onApplyChanges={() => {}}
                      onDiscardChanges={() => {}}
                      onExecuteQuery={(q) => queryExec.executeQuery(q)}
                      onLoadQuery={(q) => tabMgr.updateCurrentTab({ query: q })}
                      onLoadMore={
                        tabMgr.currentTab.result?.pagination?.hasMore
                          ? queryExec.handleLoadMore
                          : undefined
                      }
                      isLoadingMore={tabMgr.currentTab.isLoadingMore}
                      onExportResults={exportResults}
                    />
                  </ResizablePanel>
                </ResizablePanelGroup>
              </div>
            </main>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* Modals — only features that are enabled */}
      {onSaveQuery && (
        <SaveQueryModal
          isOpen={isSaveQueryModalOpen}
          onClose={() => setIsSaveQueryModalOpen(false)}
          onSave={handleSaveQuery}
          defaultQuery={tabMgr.currentTab.query}
        />
      )}

      {features.dataImport && (
        <DataImportModal
          isOpen={isImportModalOpen}
          onClose={() => setIsImportModalOpen(false)}
          onImport={(sql) => queryExec.executeQuery(sql)}
          tables={conn.schema}
          databaseType={conn.activeConnection?.type}
        />
      )}

      {features.codeGenerator && (
        <>
          <DataProfiler
            isOpen={!!profilerTable}
            onClose={() => setProfilerTable(null)}
            tableName={profilerTable || ''}
            tableSchema={conn.schema.find(t => t.name === profilerTable) || null}
            connection={conn.activeConnection}
            schemaContext={conn.schemaContext}
            databaseType={conn.activeConnection?.type}
          />
          <CodeGenerator
            isOpen={!!codeGenTable}
            onClose={() => setCodeGenTable(null)}
            tableName={codeGenTable || ''}
            tableSchema={conn.schema.find(t => t.name === codeGenTable) || null}
            databaseType={conn.activeConnection?.type}
          />
        </>
      )}

      {features.testDataGenerator && (
        <TestDataGenerator
          isOpen={!!testDataTable}
          onClose={() => setTestDataTable(null)}
          tableName={testDataTable || ''}
          tableSchema={conn.schema.find(t => t.name === testDataTable) || null}
          databaseType={conn.activeConnection?.type}
          queryLanguage={undefined}
          onExecuteQuery={(q) => queryExec.executeQuery(q)}
        />
      )}

      <MobileNav
        activeTab={activeMobileTab}
        onTabChange={setActiveMobileTab}
        hasResult={!!tabMgr.currentTab.result}
      />
    </div>
  );
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd /home/cevheri/projects/libredb/libredb-studio && npx tsc --noEmit --pretty src/workspace/StudioWorkspace.tsx 2>&1 | head -30`

Fix any type errors that come up. Common issues:
- Props mismatches on Sidebar, BottomPanel, QueryToolbar — adjust `undefined` vs `() => {}` as needed
- `MaskingConfig` import may be needed from `@/lib/data-masking`

- [ ] **Step 3: Commit**

```bash
git add src/workspace/StudioWorkspace.tsx
git commit -m "feat(workspace): add StudioWorkspace composite component"
```

---

### Task 5: Export Entry Point

**Files:**
- Create: `src/exports/workspace.ts`
- Modify: `tsup.config.ts:4-9` (add workspace entry)
- Modify: `package.json` (add ./workspace export)

- [ ] **Step 1: Create the export file**

```typescript
// src/exports/workspace.ts
export { StudioWorkspace } from '../workspace/StudioWorkspace'
export type {
  StudioWorkspaceProps,
  WorkspaceConnection,
  WorkspaceUser,
  WorkspaceQueryResult,
  WorkspaceFeatures,
  SavedQueryInput,
} from '../workspace/types'
export { DEFAULT_WORKSPACE_FEATURES } from '../workspace/types'
```

- [ ] **Step 2: Add workspace entry to tsup.config.ts**

In `tsup.config.ts`, add `workspace` to the `entry` object:

```typescript
entry: {
  index: 'src/exports/index.ts',
  providers: 'src/exports/providers.ts',
  types: 'src/exports/types.ts',
  components: 'src/exports/components.ts',
  workspace: 'src/exports/workspace.ts',  // NEW
},
```

- [ ] **Step 3: Add ./workspace export to package.json**

Add after the `"./components"` export block:

```json
"./workspace": {
  "import": {
    "types": "./dist/workspace.d.mts",
    "default": "./dist/workspace.mjs"
  },
  "require": {
    "types": "./dist/workspace.d.ts",
    "default": "./dist/workspace.js"
  }
}
```

- [ ] **Step 4: Verify build succeeds**

Run: `cd /home/cevheri/projects/libredb/libredb-studio && bun run build:lib 2>&1 | tail -20`

Expected: Build completes, `dist/workspace.mjs` and `dist/workspace.d.mts` are generated.

- [ ] **Step 5: Commit**

```bash
git add src/exports/workspace.ts tsup.config.ts package.json
git commit -m "feat(workspace): add workspace export entry point and build config"
```

---

### Task 6: Run Full Test Suite

**Files:** None (verification only)

- [ ] **Step 1: Run all existing tests to confirm nothing is broken**

Run: `cd /home/cevheri/projects/libredb/libredb-studio && bun run test 2>&1 | tail -30`

Expected: All existing tests pass. The new adapter hook tests also pass.

- [ ] **Step 2: Run lint**

Run: `cd /home/cevheri/projects/libredb/libredb-studio && bun run lint 2>&1 | tail -20`

Expected: No new lint errors introduced.

- [ ] **Step 3: Run typecheck**

Run: `cd /home/cevheri/projects/libredb/libredb-studio && bun run typecheck 2>&1 | tail -20`

Expected: No type errors.

- [ ] **Step 4: Run build**

Run: `cd /home/cevheri/projects/libredb/libredb-studio && bun run build 2>&1 | tail -20`

Expected: Next.js production build succeeds (standalone studio app still works).

- [ ] **Step 5: Commit any fixes if needed**

If any test/lint/type/build issues were found and fixed:

```bash
git add -A
git commit -m "fix(workspace): resolve test/lint/type issues"
```

---

### Summary: File Map

| Action | File |
|--------|------|
| Create | `src/workspace/types.ts` |
| Create | `src/workspace/hooks/use-connection-adapter.ts` |
| Create | `src/workspace/hooks/use-query-adapter.ts` |
| Create | `src/workspace/StudioWorkspace.tsx` |
| Create | `src/exports/workspace.ts` |
| Create | `tests/hooks/use-connection-adapter.test.ts` |
| Create | `tests/hooks/use-query-adapter.test.ts` |
| Modify | `tsup.config.ts` (add workspace entry) |
| Modify | `package.json` (add ./workspace export) |

**Total: 7 new files, 2 modified files. Zero existing files changed.**
