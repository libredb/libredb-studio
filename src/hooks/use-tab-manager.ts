'use client';

import { useState, useEffect, useCallback, useRef, type RefObject } from 'react';
import type { DatabaseConnection, TableSchema, QueryTab } from '@/lib/types';
import type { ProviderMetadata } from '@/hooks/use-provider-metadata';
import type { QueryEditorRef } from '@/components/QueryEditor';
import { getDefaultQuery } from '@/lib/showcase-queries';
import { generateTableQuery, generateSelectQuery } from '@/lib/query-generators';

interface UseTabManagerParams {
  activeConnection: DatabaseConnection | null;
  metadata: ProviderMetadata | null;
  schema: TableSchema[];
  queryEditorRef: RefObject<QueryEditorRef | null>;
}

export function useTabManager({
  activeConnection,
  metadata,
  schema,
  queryEditorRef,
}: UseTabManagerParams) {
  const [tabs, setTabs] = useState<QueryTab[]>([
    {
      id: 'default',
      name: 'Query 1',
      query: '-- Start typing your SQL query here\n',
      result: null,
      isExecuting: false,
      type: 'sql'
    }
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('default');
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTabName, setEditingTabName] = useState('');

  const currentTab = tabs.find(t => t.id === activeTabId) || tabs[0];

  // Track previous tab to sync editor content on tab switch
  const prevTabIdRef = useRef<string>(activeTabId);

  // Sync editor content when switching tabs
  useEffect(() => {
    if (prevTabIdRef.current !== activeTabId && queryEditorRef.current) {
      // Save current editor content to the previous tab before switching
      const currentEditorValue = queryEditorRef.current.getValue();
      const prevTabId = prevTabIdRef.current;

      setTabs(prev => prev.map(t =>
        t.id === prevTabId ? { ...t, query: currentEditorValue } : t
      ));

      // Update ref to current tab
      prevTabIdRef.current = activeTabId;
    }
  }, [activeTabId, queryEditorRef]);

  const updateCurrentTab = useCallback((updates: Partial<QueryTab>) => {
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, ...updates } : t));
  }, [activeTabId]);

  const addTab = useCallback(() => {
    const newId = Math.random().toString(36).substring(7);
    const isDemo = activeConnection?.isDemo || activeConnection?.type === 'demo';
    const queryLanguage = metadata?.capabilities.queryLanguage;
    const newTab: QueryTab = {
      id: newId,
      name: `Query ${tabs.length + 1}`,
      query: getDefaultQuery(isDemo, queryLanguage),
      result: null,
      isExecuting: false,
      type: queryLanguage === 'json' ? 'mongodb' : 'sql'
    };
    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newId);
  }, [activeConnection, metadata, tabs.length]);

  const closeTab = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tabs.length === 1) return;
    const newTabs = tabs.filter(t => t.id !== id);
    setTabs(newTabs);
    if (activeTabId === id) {
      setActiveTabId(newTabs[newTabs.length - 1].id);
    }
  }, [tabs, activeTabId]);

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
    handleTableClick,
    handleGenerateSelect,
  };
}
