'use client';

import { useState, useEffect, useCallback, useRef, type Dispatch, type SetStateAction, type RefObject } from 'react';
import type { DatabaseConnection, QueryTab } from '@/lib/types';
import type { ProviderMetadata } from '@/hooks/use-provider-metadata';
import type { QueryEditorRef } from '@/components/QueryEditor';
import { useToast } from '@/hooks/use-toast';
import { storage } from '@/lib/storage';
import { isDangerousQuery } from '@/components/QuerySafetyDialog';
import { isMultiStatement } from '@/lib/sql/statement-splitter';
import { shouldRefreshSchema } from '@/lib/query-generators';
import { ApiErrorCode } from '@/lib/api/error-codes';
import { logger } from '@/lib/logger';

export interface QueryExecutionOptions {
  limit?: number;
  offset?: number;
  unlimited?: boolean;
  skipSafety?: boolean;
}

interface UseQueryExecutionParams {
  activeConnection: DatabaseConnection | null;
  metadata: ProviderMetadata | null;
  tabs: QueryTab[];
  activeTabId: string;
  currentTab: QueryTab;
  setTabs: Dispatch<SetStateAction<QueryTab[]>>;
  transactionActive: boolean;
  playgroundMode: boolean;
  fetchSchema: (conn: DatabaseConnection) => Promise<void>;
  queryEditorRef: RefObject<QueryEditorRef | null>;
}

export function useQueryExecution({
  activeConnection,
  metadata,
  tabs,
  activeTabId,
  currentTab,
  setTabs,
  transactionActive,
  playgroundMode,
  fetchSchema,
  queryEditorRef,
}: UseQueryExecutionParams) {
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeQueryIdRef = useRef<string | null>(null);

  const [safetyCheckQuery, setSafetyCheckQuery] = useState<string | null>(null);
  const [unlimitedWarningOpen, setUnlimitedWarningOpen] = useState(false);
  const [pendingUnlimitedQuery, setPendingUnlimitedQuery] = useState<{
    query: string;
    tabId: string;
  } | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [bottomPanelMode, setBottomPanelMode] = useState<'results' | 'explain' | 'history' | 'saved' | 'charts' | 'nl2sql' | 'autopilot' | 'pivot' | 'docs' | 'schemadiff' | 'dashboard'>('results');

  const { toast } = useToast();

  // Unified executeQuery — handles both normal and force (skipSafety) execution
  const executeQuery = useCallback(async (
    overrideQuery?: string,
    tabId?: string,
    isExplain: boolean = false,
    executionOptions?: QueryExecutionOptions
  ) => {
    const targetTabId = tabId || activeTabId;
    const tabToExec = tabs.find(t => t.id === targetTabId) || currentTab;

    // Modern Execution Logic: Prioritize selection from ref, then override, then tab state
    let queryToExecute = overrideQuery;
    if (!queryToExecute && targetTabId === activeTabId && queryEditorRef.current) {
      queryToExecute = queryEditorRef.current.getEffectiveQuery();
    }
    if (!queryToExecute) {
      queryToExecute = tabToExec.query;
    }

    if (!activeConnection) {
      toast({ title: "No Connection", description: "Select a connection first.", variant: "destructive" });
      return;
    }

    // Safety check for dangerous queries (skip for explain, load-more, playground, and force-execute)
    const skipSafety = executionOptions?.skipSafety ?? false;
    if (!skipSafety && !isExplain && !executionOptions?.offset && !playgroundMode && isDangerousQuery(queryToExecute)) {
      setSafetyCheckQuery(queryToExecute);
      return;
    }

    // Options extraction
    const {
      limit = 500,
      offset = 0,
      unlimited = false,
    } = executionOptions || {};

    // isLoadingMore flag
    const isLoadMore = offset > 0;

    setTabs(prev => prev.map(t => t.id === targetTabId ? {
      ...t,
      isExecuting: !isLoadMore,
      isLoadingMore: isLoadMore,
    } : t));
    setBottomPanelMode(isExplain ? 'explain' : 'results');

    if (activeConnection.isDemo && process.env.NODE_ENV === 'development') {
      console.log('[DemoDB] Executing query on demo connection:', {
        queryPreview: queryToExecute.substring(0, 100) + (queryToExecute.length > 100 ? '...' : ''),
      });
    }

    // Check EXPLAIN support via capabilities
    if (isExplain && metadata && !metadata.capabilities.supportsExplain) {
      toast({ title: "Not Supported", description: "EXPLAIN is not available for this database type.", variant: "destructive" });
      setTabs(prev => prev.map(t => t.id === targetTabId ? { ...t, isExecuting: false, isLoadingMore: false } : t));
      return;
    }

    // Build EXPLAIN query for PostgreSQL/MySQL
    const buildExplainQuery = (sql: string, dbType: string): string | null => {
      // Only for SELECT queries
      if (!/^\s*SELECT\b/i.test(sql.trim())) return null;

      if (dbType === 'postgres') {
        return `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`;
      } else if (dbType === 'mysql') {
        return `EXPLAIN FORMAT=JSON ${sql}`;
      }
      return null;
    };

    const startTime = Date.now();
    // Set up abort controller for query cancellation
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const queryId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeQueryIdRef.current = queryId;

    // Playground mode: begin a transaction before executing (will rollback after)
    const isPlaygroundRun = playgroundMode && !transactionActive && !isExplain && !isLoadMore;

    try {
      if (isPlaygroundRun) {
        const beginRes = await fetch('/api/db/transaction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connection: activeConnection, action: 'begin' }),
        });
        if (!beginRes.ok) {
          logger.warn('Playground transaction BEGIN failed', { route: 'use-query-execution' });
        }
      }

      // If isExplain mode, run EXPLAIN query instead
      let queryToRun = queryToExecute;
      if (isExplain && activeConnection.type) {
        const explainSql = buildExplainQuery(queryToExecute, activeConnection.type);
        if (explainSql) {
          queryToRun = explainSql;
        }
      }

      // Detect multi-statement queries (not for EXPLAIN or load-more or transaction)
      const useMultiQuery = !isExplain && !isLoadMore && !transactionActive && !isPlaygroundRun && isMultiStatement(queryToExecute);

      // Use transaction endpoint if a transaction is active or in playground mode
      const useTransaction = (transactionActive || isPlaygroundRun) && !isExplain;

      // Start both queries in parallel (main query + background explain)
      const queryEndpoint = useTransaction
        ? '/api/db/transaction'
        : useMultiQuery ? '/api/db/multi-query' : '/api/db/query';
      const mainQueryPromise = fetch(queryEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connection: activeConnection,
          ...(useTransaction
            ? { action: 'query', sql: queryToExecute, options: { limit, offset, unlimited } }
            : {
                sql: isExplain ? queryToRun : queryToExecute,
                options: isExplain ? {} : { limit, offset, unlimited },
                ...(!useMultiQuery && { queryId }),
              }
          ),
        }),
        signal: abortController.signal,
      });

      // Run EXPLAIN in background for non-explain queries (SELECT only)
      let explainPromise: Promise<Response> | null = null;
      if (!isExplain && !isLoadMore && activeConnection.type) {
        const explainSql = buildExplainQuery(queryToExecute, activeConnection.type);
        if (explainSql) {
          explainPromise = fetch('/api/db/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              connection: activeConnection,
              sql: explainSql,
              options: {},
            }),
          });
        }
      }

      const response = await mainQueryPromise;

      const endTime = Date.now();
      const executionTime = endTime - startTime;

      if (!response.ok) {
        const error = await response.json();
        const errorMessage = error.error || 'Query failed';
        const errorCode = error.code as string | undefined;

        if (activeConnection.isDemo) {
          console.error('[DemoDB] Query failed:', { errorMessage, executionTime });
        }

        storage.addToHistory({
          id: Math.random().toString(36).substring(7),
          connectionId: activeConnection.id,
          connectionName: activeConnection.name,
          tabName: tabToExec.name,
          query: queryToExecute,
          executionTime,
          status: 'error',
          executedAt: new Date(),
          errorMessage
        });

        // Handle query cancellation via response code
        if (errorCode === ApiErrorCode.QUERY_CANCELLED) {
          setTabs(prev => prev.map(t => t.id === targetTabId ? {
            ...t,
            isExecuting: false,
            isLoadingMore: false,
          } : t));
          toast({ title: "Query Cancelled", description: "Query execution was cancelled." });
          return;
        }

        // Provide more context for demo connection errors
        if (activeConnection.isDemo) {
          throw new Error(`Demo database error: ${errorMessage}. The demo database may be temporarily unavailable.`);
        }
        throw new Error(errorMessage);
      }

      const resultData = await response.json();

      if (activeConnection.isDemo && process.env.NODE_ENV === 'development') {
        console.log('[DemoDB] Query executed successfully:', {
          rowCount: resultData.rowCount,
          executionTime: resultData.executionTime || executionTime,
        });
      }

      // Only add to history for new queries (not load more)
      if (!isLoadMore) {
        storage.addToHistory({
          id: Math.random().toString(36).substring(7),
          connectionId: activeConnection.id,
          connectionName: activeConnection.name,
          tabName: tabToExec.name,
          query: queryToExecute,
          executionTime: resultData.executionTime || executionTime,
          status: resultData.hasError ? 'error' : 'success',
          executedAt: new Date(),
          rowCount: resultData.rowCount,
          errorMessage: resultData.hasError ? resultData.statements?.find((s: { status: string }) => s.status === 'error')?.error : undefined,
        });
        setHistoryKey(prev => prev + 1);
      }

      // Show multi-statement summary
      if (resultData.multiStatement) {
        const { executedCount, statementCount, hasError } = resultData;
        if (hasError) {
          const errorStmt = resultData.statements?.find((s: { status: string }) => s.status === 'error');
          toast({
            title: `Executed ${executedCount - 1}/${statementCount} statements`,
            description: `Error in statement ${errorStmt?.index + 1}: ${errorStmt?.error}`,
            variant: "destructive",
          });
        } else {
          toast({
            title: `${executedCount} statements executed`,
            description: `All ${statementCount} statements completed in ${resultData.executionTime}ms`,
          });
        }
      }

      // Process EXPLAIN results (from background or direct)
      let explainPlanData = null;
      if (isExplain) {
        // Direct EXPLAIN query - parse result
        explainPlanData = resultData.rows?.[0]?.['QUERY PLAN'] || resultData.rows;
      } else if (explainPromise) {
        // Background EXPLAIN - don't block, update async
        explainPromise.then(async (explainRes) => {
          if (explainRes.ok) {
            const explainData = await explainRes.json();
            const plan = explainData.rows?.[0]?.['QUERY PLAN'] || explainData.rows;
            setTabs(prev => prev.map(t =>
              t.id === targetTabId ? { ...t, explainPlan: plan } : t
            ));
          }
        }).catch(err => console.error('[EXPLAIN] Background fetch failed:', err));
      }

      // Update tab state: Load More (append) vs new query (replace)
      setTabs(prev => prev.map(t => {
        if (t.id !== targetTabId) return t;

        // Load More mode: append rows
        if (isLoadMore && t.result) {
          const existingRows = t.allRows || t.result.rows;
          const newAllRows = [...existingRows, ...resultData.rows];

          return {
            ...t,
            result: {
              ...resultData,
              rows: newAllRows,
              rowCount: newAllRows.length,
            },
            allRows: newAllRows,
            currentOffset: offset + resultData.rows.length,
            isExecuting: false,
            isLoadingMore: false,
          };
        }

        // New query mode: replace
        return {
          ...t,
          result: isExplain ? null : resultData, // Don't show EXPLAIN as results
          allRows: isExplain ? t.allRows : resultData.rows,
          currentOffset: isExplain ? t.currentOffset : resultData.rows.length,
          isExecuting: false,
          isLoadingMore: false,
          explainPlan: explainPlanData || t.explainPlan,
        };
      }));

      // Playground mode: auto-rollback after getting results
      if (isPlaygroundRun) {
        try {
          await fetch('/api/db/transaction', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connection: activeConnection, action: 'rollback' }),
          });
        } catch {
          logger.warn('Playground transaction rollback failed', { route: 'use-query-execution' });
        }
        toast({
          title: "Playground",
          description: "Changes auto-rolled back. No data was modified.",
        });
      }

      // Refresh schema after DDL/write operations (pattern from provider capabilities)
      // Skip schema refresh in playground mode since changes are rolled back
      if (!isExplain && !isPlaygroundRun && metadata) {
        if (shouldRefreshSchema(queryToExecute, metadata.capabilities.schemaRefreshPattern)) {
          fetchSchema(activeConnection);
        }
      }
    } catch (error) {
      // Playground mode: rollback on error too
      if (isPlaygroundRun) {
        try {
          await fetch('/api/db/transaction', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connection: activeConnection, action: 'rollback' }),
          });
        } catch {
          logger.warn('Playground transaction rollback failed', { route: 'use-query-execution' });
        }
      }
      setTabs(prev => prev.map(t => t.id === targetTabId ? {
        ...t,
        isExecuting: false,
        isLoadingMore: false,
      } : t));

      // Don't show error toast for user-initiated cancellation
      if (error instanceof DOMException && error.name === 'AbortError') {
        toast({ title: "Query Cancelled", description: "Query execution was cancelled." });
        return;
      }

      const title = activeConnection?.isDemo ? "Demo Database Error" : "Query Error";
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      // Fallback string check for cancellation errors not caught by response code
      if (errorMessage.includes('Query was cancelled') || errorMessage.includes('cancelled')) {
        toast({ title: "Query Cancelled", description: "Query execution was cancelled." });
        return;
      }
      toast({ title, description: errorMessage, variant: "destructive" });
    } finally {
      abortControllerRef.current = null;
      activeQueryIdRef.current = null;
    }
  }, [activeConnection, tabs, currentTab, activeTabId, toast, fetchSchema, metadata, transactionActive, playgroundMode, setTabs, queryEditorRef]);

  // Force execute (bypass safety check) — unified via skipSafety flag
  const forceExecuteQuery = useCallback((query: string) => {
    setSafetyCheckQuery(null);
    executeQuery(query, undefined, false, { skipSafety: true });
  }, [executeQuery]);

  // Cancel running query
  const cancelQuery = useCallback(async () => {
    // Abort the fetch request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Also cancel on the server side
    if (activeQueryIdRef.current && activeConnection) {
      try {
        await fetch('/api/db/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            connection: activeConnection,
            queryId: activeQueryIdRef.current,
          }),
        });
      } catch {
        logger.warn('Query cancellation request failed', { route: 'use-query-execution' });
      }
    }
  }, [activeConnection]);

  // Load More handler
  const handleLoadMore = useCallback(() => {
    if (!currentTab.result?.pagination?.hasMore) return;

    const currentOffset = currentTab.currentOffset || currentTab.result.rows.length;
    executeQuery(currentTab.query, currentTab.id, false, {
      limit: 500,
      offset: currentOffset,
    });
  }, [currentTab, executeQuery]);

  // Unlimited query handler
  const handleUnlimitedQuery = useCallback(() => {
    if (!pendingUnlimitedQuery) return;

    executeQuery(
      pendingUnlimitedQuery.query,
      pendingUnlimitedQuery.tabId,
      false,
      { unlimited: true }
    );

    setUnlimitedWarningOpen(false);
    setPendingUnlimitedQuery(null);
  }, [pendingUnlimitedQuery, executeQuery]);

  // Listen for execute-query custom events (from command palette etc.)
  useEffect(() => {
    const handleExecuteQueryEvent = (e: Event) => {
      const customEvent = e as CustomEvent<{ query: string }>;
      if (customEvent.detail?.query) {
        executeQuery(customEvent.detail.query);
      }
    };
    window.addEventListener('execute-query', handleExecuteQueryEvent);
    return () => window.removeEventListener('execute-query', handleExecuteQueryEvent);
  }, [executeQuery]);

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
