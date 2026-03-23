'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import type { DatabaseConnection, TableSchema, QueryTab } from '@/lib/types';
import type { ProviderMetadata } from '@/hooks/use-provider-metadata';
import { getDefaultQuery } from '@/lib/showcase-queries';
import { generateTableQuery, generateSelectQuery } from '@/lib/query-generators';

const DEFAULT_TAB: QueryTab = {
  id: 'default',
  name: 'Query 1',
  query: '-- Start typing your SQL query here\n',
  result: null,
  isExecuting: false,
  type: 'sql'
};

const WORKSPACE_STORAGE_PREFIX = 'libredb_workspace_tabs_v1';

interface PersistedTabState {
  id: string;
  name: string;
  query: string;
  type: QueryTab['type'];
}

interface PersistedWorkspaceState {
  activeTabId: string;
  tabs: PersistedTabState[];
}

interface UseTabManagerParams {
  activeConnection: DatabaseConnection | null;
  metadata: ProviderMetadata | null;
  schema: TableSchema[];
  persistWorkspace?: boolean;
}

export function useTabManager({
  activeConnection,
  metadata,
  schema,
  persistWorkspace,
}: UseTabManagerParams) {
  const [tabs, setTabs] = useState<QueryTab[]>([DEFAULT_TAB]);
  const [activeTabId, setActiveTabId] = useState<string>('default');
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabName, setEditingTabName] = useState('');
  const [isWorkspaceHydrated, setIsWorkspaceHydrated] = useState(false);

  const workspaceKey = useMemo(
    () => `${WORKSPACE_STORAGE_PREFIX}:${activeConnection?.id ?? 'default'}`,
    [activeConnection?.id]
  );
  const shouldPersistWorkspace = persistWorkspace ?? process.env.NODE_ENV !== 'test';

  const currentTab = tabs.find(t => t.id === activeTabId) || tabs[0];

  // LOAD EFFECT — restore tabs from localStorage on connection switch
  useEffect(() => {
    setIsWorkspaceHydrated(false);
    if (!shouldPersistWorkspace) return;

    const storage = typeof globalThis !== 'undefined' && 'localStorage' in globalThis
      ? globalThis.localStorage
      : null;
    if (!storage) return;

    try {
      const raw = storage.getItem(workspaceKey);
      if (!raw) {
        setTabs([DEFAULT_TAB]);
        setActiveTabId(DEFAULT_TAB.id);
        return;
      }

      const parsed = JSON.parse(raw) as PersistedWorkspaceState;
      if (!parsed || !Array.isArray(parsed.tabs) || parsed.tabs.length === 0) {
        setTabs([DEFAULT_TAB]);
        setActiveTabId(DEFAULT_TAB.id);
        return;
      }

      const restoredTabs: QueryTab[] = parsed.tabs.map(tab => ({
        id: tab.id,
        name: tab.name,
        query: tab.query,
        type: tab.type,
        result: null,
        isExecuting: false,
      }));

      const hasActiveTab = restoredTabs.some(tab => tab.id === parsed.activeTabId);
      setTabs(restoredTabs);
      setActiveTabId(hasActiveTab ? parsed.activeTabId : restoredTabs[0].id);
    } catch (error) {
      console.error('[useTabManager] Failed to restore workspace tabs:', error);
      setTabs([DEFAULT_TAB]);
      setActiveTabId(DEFAULT_TAB.id);
    }
    // NOTE: hydration flag stays false — set by ready effect below.
  }, [workspaceKey, shouldPersistWorkspace]);

  // READY EFFECT — fires after load's setTabs commits (next render)
  useEffect(() => {
    if (!shouldPersistWorkspace || isWorkspaceHydrated) return;
    setIsWorkspaceHydrated(true);
  }, [tabs, activeTabId, shouldPersistWorkspace, isWorkspaceHydrated]);

  // SAVE EFFECT — debounced write to localStorage (500ms)
  useEffect(() => {
    if (!shouldPersistWorkspace) return;
    const storage = typeof globalThis !== 'undefined' && 'localStorage' in globalThis
      ? globalThis.localStorage
      : null;
    if (!isWorkspaceHydrated || !storage) return;

    const timer = setTimeout(() => {
      const serialized: PersistedWorkspaceState = {
        activeTabId,
        tabs: tabs.map(tab => ({
          id: tab.id,
          name: tab.name,
          query: tab.query,
          type: tab.type,
        })),
      };
      storage.setItem(workspaceKey, JSON.stringify(serialized));
    }, 500);

    return () => clearTimeout(timer);
  }, [tabs, activeTabId, workspaceKey, shouldPersistWorkspace, isWorkspaceHydrated]);

  const updateTabById = useCallback((tabId: string, updates: Partial<QueryTab>) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, ...updates } : t));
  }, []);

  const updateCurrentTab = useCallback((updates: Partial<QueryTab>) => {
    updateTabById(activeTabId, updates);
  }, [activeTabId, updateTabById]);

  const addTab = useCallback(() => {
    const newId = Math.random().toString(36).substring(7);
    const isDemo = activeConnection?.isDemo || activeConnection?.type === 'demo';
    const queryLanguage = metadata?.capabilities.queryLanguage;
    setTabs(prev => [...prev, {
      id: newId,
      name: `Query ${prev.length + 1}`,
      query: getDefaultQuery(isDemo, queryLanguage),
      result: null,
      isExecuting: false,
      type: queryLanguage === 'json' ? 'mongodb' : 'sql'
    }]);
    setActiveTabId(newId);
  }, [activeConnection, metadata]);

  const closeTab = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTabs(prev => {
      if (prev.length === 1) return prev;
      const newTabs = prev.filter(t => t.id !== id);
      if (activeTabId === id && newTabs.length > 0) {
        setActiveTabId(newTabs[newTabs.length - 1].id);
      }
      return newTabs;
    });
  }, [activeTabId]);

  // handleTableClick takes executeQuery as callback param to avoid circular dependency
  const handleTableClick = useCallback((
    tableName: string,
    executeQueryFn: (query: string, tabId: string) => void
  ) => {
    const capabilities = metadata?.capabilities;
    const newQuery = capabilities
      ? generateTableQuery(tableName, capabilities)
      : `SELECT * FROM ${tableName} LIMIT 50;`;

    const newId = Math.random().toString(36).substring(7);
    const newTab: QueryTab = {
      id: newId,
      name: tableName,
      query: newQuery,
      result: null,
      isExecuting: false,
      type: capabilities?.queryLanguage === 'json' ? 'mongodb' : 'sql'
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newId);
    setTimeout(() => executeQueryFn(newQuery, newId), 100);
  }, [metadata]);

  const handleGenerateSelect = useCallback((tableName: string) => {
    const capabilities = metadata?.capabilities;
    const table = schema.find(t => t.name === tableName);
    const columns = table?.columns || [];

    const newQuery = capabilities
      ? generateSelectQuery(tableName, columns, capabilities)
      : `SELECT\n${columns.map(c => `  ${c.name}`).join(',\n') || '  *'}\nFROM ${tableName}\nWHERE 1=1\nLIMIT 100;`;

    const tabType: 'sql' | 'mongodb' | 'redis' = capabilities?.queryLanguage === 'json' ? 'mongodb' : 'sql';

    const newId = Math.random().toString(36).substring(7);
    setTabs(prev => [...prev, {
      id: newId,
      name: `Query: ${tableName}`,
      query: newQuery,
      result: null,
      isExecuting: false,
      type: tabType
    }]);
    setActiveTabId(newId);
  }, [metadata, schema]);

  return {
    tabs,
    setTabs,
    activeTabId,
    setActiveTabId,
    currentTab,
    editingTabId,
    setEditingTabId,
    editingTabName,
    setEditingTabName,
    addTab,
    closeTab,
    updateCurrentTab,
    updateTabById,
    handleTableClick,
    handleGenerateSelect,
  };
}
