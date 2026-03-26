'use client';

import { useState, useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import type { DatabaseConnection, QueryTab } from '@/lib/types';
import type { WorkspaceQueryResult, WorkspaceFeatures } from '@/workspace/types';
import type { BottomPanelMode } from '@/components/studio/BottomPanel';
import { useToast } from '@/hooks/use-toast';
import { isDangerousQuery } from '@/components/QuerySafetyDialog';

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
  fetchSchema: _fetchSchema,
  features: _features,
}: UseQueryAdapterParams) {
  // Reserved for future use (schema refresh after DDL, feature gating)
  void _fetchSchema;
  void _features;
  const cancelledRef = useRef(false);

  const [safetyCheckQuery, setSafetyCheckQuery] = useState<string | null>(null);
  const [unlimitedWarningOpen, setUnlimitedWarningOpen] = useState(false);
  const [pendingUnlimitedQuery, setPendingUnlimitedQuery] = useState<{
    query: string;
    tabId: string;
  } | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [bottomPanelMode, setBottomPanelMode] = useState<BottomPanelMode>('results');

  const { toast } = useToast();

  const executeQuery = useCallback(async (
    overrideQuery?: string,
    tabId?: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _isExplain: boolean = false,
  ) => {
    const targetTabId = tabId || activeTabId;
    const tabToExec = tabs.find(t => t.id === targetTabId) || currentTab;

    const queryToExecute = overrideQuery || tabToExec.query;

    if (!activeConnection) {
      toast({ title: 'No Connection', description: 'Select a connection first.', variant: 'destructive' });
      return;
    }

    if (!queryToExecute || queryToExecute.trim() === '') {
      toast({ title: 'Empty Query', description: 'Enter a query to execute.', variant: 'destructive' });
      return;
    }

    // Safety check for dangerous queries (skip for force-execute via forceExecuteQuery)
    if (isDangerousQuery(queryToExecute)) {
      setSafetyCheckQuery(queryToExecute);
      return;
    }

    cancelledRef.current = false;

    // Set tab executing state
    setTabs(prev => prev.map(t => t.id === targetTabId ? {
      ...t,
      isExecuting: true,
    } : t));
    setBottomPanelMode('results');

    const startTime = Date.now();

    try {
      const result = await onQueryExecute(activeConnection.id, queryToExecute);

      // Check if cancelled while awaiting
      if (cancelledRef.current) return;

      const executionTime = result.executionTime || (Date.now() - startTime);

      setTabs(prev => prev.map(t => {
        if (t.id !== targetTabId) return t;

        return {
          ...t,
          result: {
            rows: result.rows,
            fields: result.fields,
            rowCount: result.rowCount,
            executionTime,
            pagination: result.pagination,
          },
          allRows: result.rows,
          currentOffset: result.rows.length,
          isExecuting: false,
          isLoadingMore: false,
        };
      }));

      setHistoryKey(prev => prev + 1);
    } catch (error) {
      // Skip updates if cancelled
      if (cancelledRef.current) return;

      setTabs(prev => prev.map(t => t.id === targetTabId ? {
        ...t,
        isExecuting: false,
        isLoadingMore: false,
      } : t));

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Query Error', description: errorMessage, variant: 'destructive' });
    }
  }, [activeConnection, tabs, currentTab, activeTabId, toast, onQueryExecute, setTabs]);

  // Force execute (bypass safety check)
  const forceExecuteQuery = useCallback((query: string) => {
    setSafetyCheckQuery(null);

    if (!activeConnection) {
      toast({ title: 'No Connection', description: 'Select a connection first.', variant: 'destructive' });
      return;
    }

    if (!query || query.trim() === '') {
      toast({ title: 'Empty Query', description: 'Enter a query to execute.', variant: 'destructive' });
      return;
    }

    cancelledRef.current = false;

    setTabs(prev => prev.map(t => t.id === activeTabId ? {
      ...t,
      isExecuting: true,
    } : t));
    setBottomPanelMode('results');

    const startTime = Date.now();

    onQueryExecute(activeConnection.id, query)
      .then((result) => {
        if (cancelledRef.current) return;

        const executionTime = result.executionTime || (Date.now() - startTime);

        setTabs(prev => prev.map(t => {
          if (t.id !== activeTabId) return t;

          return {
            ...t,
            result: {
              rows: result.rows,
              fields: result.fields,
              rowCount: result.rowCount,
              executionTime,
              pagination: result.pagination,
            },
            allRows: result.rows,
            currentOffset: result.rows.length,
            isExecuting: false,
            isLoadingMore: false,
          };
        }));

        setHistoryKey(prev => prev + 1);
      })
      .catch((error) => {
        if (cancelledRef.current) return;

        setTabs(prev => prev.map(t => t.id === activeTabId ? {
          ...t,
          isExecuting: false,
          isLoadingMore: false,
        } : t));

        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        toast({ title: 'Query Error', description: errorMessage, variant: 'destructive' });
      });
  }, [activeConnection, activeTabId, toast, onQueryExecute, setTabs]);

  // Cancel running query (best-effort via ref flag)
  const cancelQuery = useCallback(() => {
    cancelledRef.current = true;

    setTabs(prev => prev.map(t => t.isExecuting ? {
      ...t,
      isExecuting: false,
      isLoadingMore: false,
    } : t));

    toast({ title: 'Query Cancelled', description: 'Query execution was cancelled.' });
  }, [setTabs, toast]);

  // Load More handler
  const handleLoadMore = useCallback(() => {
    if (!currentTab.result?.pagination?.hasMore) return;
    if (!activeConnection) return;

    const currentOffset = currentTab.currentOffset || currentTab.result.rows.length;

    setTabs(prev => prev.map(t => t.id === currentTab.id ? {
      ...t,
      isLoadingMore: true,
    } : t));

    onQueryExecute(activeConnection.id, currentTab.query, {
      limit: 500,
      offset: currentOffset,
    })
      .then((result) => {
        if (cancelledRef.current) return;

        setTabs(prev => prev.map(t => {
          if (t.id !== currentTab.id) return t;

          const existingRows = t.allRows || t.result?.rows || [];
          const newAllRows = [...existingRows, ...result.rows];

          return {
            ...t,
            result: {
              rows: newAllRows,
              fields: result.fields,
              rowCount: newAllRows.length,
              executionTime: t.result?.executionTime || 0,
              pagination: result.pagination,
            },
            allRows: newAllRows,
            currentOffset: currentOffset + result.rows.length,
            isExecuting: false,
            isLoadingMore: false,
          };
        }));
      })
      .catch((error) => {
        if (cancelledRef.current) return;

        setTabs(prev => prev.map(t => t.id === currentTab.id ? {
          ...t,
          isExecuting: false,
          isLoadingMore: false,
        } : t));

        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        toast({ title: 'Load More Error', description: errorMessage, variant: 'destructive' });
      });
  }, [currentTab, activeConnection, onQueryExecute, setTabs, toast]);

  // Unlimited query handler
  const handleUnlimitedQuery = useCallback(() => {
    if (!pendingUnlimitedQuery) return;
    if (!activeConnection) return;

    const { query, tabId } = pendingUnlimitedQuery;

    cancelledRef.current = false;

    setTabs(prev => prev.map(t => t.id === tabId ? {
      ...t,
      isExecuting: true,
    } : t));

    onQueryExecute(activeConnection.id, query, { unlimited: true })
      .then((result) => {
        if (cancelledRef.current) return;

        setTabs(prev => prev.map(t => {
          if (t.id !== tabId) return t;

          return {
            ...t,
            result: {
              rows: result.rows,
              fields: result.fields,
              rowCount: result.rowCount,
              executionTime: result.executionTime,
              pagination: result.pagination,
            },
            allRows: result.rows,
            currentOffset: result.rows.length,
            isExecuting: false,
            isLoadingMore: false,
          };
        }));

        setHistoryKey(prev => prev + 1);
      })
      .catch((error) => {
        if (cancelledRef.current) return;

        setTabs(prev => prev.map(t => t.id === tabId ? {
          ...t,
          isExecuting: false,
          isLoadingMore: false,
        } : t));

        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        toast({ title: 'Query Error', description: errorMessage, variant: 'destructive' });
      });

    setUnlimitedWarningOpen(false);
    setPendingUnlimitedQuery(null);
  }, [pendingUnlimitedQuery, activeConnection, onQueryExecute, setTabs, toast]);

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
