"use client";

import { useState, useCallback, useRef, useEffect, type Dispatch, type SetStateAction } from "react";
import type { DatabaseConnection, QueryTab } from "@/lib/types";
import type { WorkspaceQueryResult, WorkspaceFeatures } from "@/workspace/types";
import type { BottomPanelMode } from "@/components/studio/BottomPanel";
import { useToast } from "@/hooks/use-toast";
import { isDangerousQuery } from "@/components/QuerySafetyDialog";
import { maybeInviteToStar } from "@/lib/community/star-prompt-toast";
import { hasPageableResult } from "@/lib/query-pagination";

/**
 * The channels a host result carries beyond rows and counts (#285).
 *
 * The adapter used to build its tab result from an explicit five-key list, so
 * anything the host attached beyond those keys was dropped and the embedding saw
 * neither the query warnings nor the declared column types the standalone app
 * shows. Both are read straight off `result` by `ResultsGrid`, so carrying them is
 * the whole fix — and the declared types go into the contract's existing
 * `columns[].type` slot rather than a second shape for the same information.
 *
 * Both stay ABSENT when the host sent nothing: the grid decides whether to render
 * from the field's presence, so an empty array would announce a section with
 * nothing in it.
 */
function carriedChannels(result: WorkspaceQueryResult): Pick<QueryTab["result"] & object, "warnings" | "columnTypes"> {
  // A column the host declared without a type contributes no entry rather than an
  // undefined one every reader would have to test for.
  const declared = (result.columns ?? []).filter((column) => column.type !== undefined);
  return {
    ...(result.warnings && { warnings: result.warnings }),
    ...(declared.length > 0 && {
      columnTypes: Object.fromEntries(declared.map((column) => [column.name, column.type as string])),
    }),
  };
}

interface UseQueryAdapterParams {
  supportsResultPagination?: boolean;
  activeConnection: DatabaseConnection | null;
  onQueryExecute: (
    connectionId: string,
    sql: string,
    options?: {
      limit?: number;
      offset?: number;
      unlimited?: boolean;
    },
  ) => Promise<WorkspaceQueryResult>;
  tabs: QueryTab[];
  activeTabId: string;
  currentTab: QueryTab;
  setTabs: Dispatch<SetStateAction<QueryTab[]>>;
  fetchSchema: (conn: DatabaseConnection) => Promise<void>;
  features: Partial<WorkspaceFeatures>;
}

export function useQueryAdapter({
  supportsResultPagination,
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
  // Sidebar previews execute after their new tab is created. Read that committed tab, not the old callback's tabs.
  const tabsRef = useRef(tabs);
  const currentTabRef = useRef(currentTab);
  useEffect(() => {
    tabsRef.current = tabs;
    currentTabRef.current = currentTab;
  });
  const cancelledRef = useRef(false);
  const pageRequestsRef = useRef(new Map<string, object>());
  useEffect(() => {
    if (!activeConnection) return;
    const requests = pageRequestsRef.current;
    return () => {
      requests.clear();
    };
  }, [activeConnection]);

  const [safetyCheckQuery, setSafetyCheckQuery] = useState<string | null>(null);
  const [unlimitedWarningOpen, setUnlimitedWarningOpen] = useState(false);
  const [pendingUnlimitedQuery, setPendingUnlimitedQuery] = useState<{
    query: string;
    tabId: string;
  } | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [bottomPanelMode, setBottomPanelMode] = useState<BottomPanelMode>("results");

  const { toast } = useToast();

  const executeQuery = useCallback(
    async (
      overrideQuery?: string,
      tabId?: string,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _isExplain: boolean = false,
      executionOptions?: { limit?: number; offset?: number; unlimited?: boolean },
    ) => {
      const targetTabId = tabId || activeTabId;
      const tabToExec = tabsRef.current.find((t) => t.id === targetTabId) || currentTabRef.current;

      const queryToExecute = overrideQuery || tabToExec.query;

      if (!activeConnection) {
        toast({ title: "No Connection", description: "Select a connection first.", variant: "destructive" });
        return;
      }

      if (!queryToExecute || queryToExecute.trim() === "") {
        toast({ title: "Empty Query", description: "Enter a query to execute.", variant: "destructive" });
        return;
      }

      // Safety check for dangerous queries (skip for force-execute via forceExecuteQuery)
      // Read under the active connection's dialect, as the standalone path does
      // (#292): the same characters are a comment in one engine and code in
      // another, and only the connection says which.
      if (isDangerousQuery(queryToExecute, activeConnection.type)) {
        setSafetyCheckQuery(queryToExecute);
        return;
      }

      cancelledRef.current = false;
      pageRequestsRef.current.delete(targetTabId);

      // Set tab executing state
      setTabs((prev) =>
        prev.map((t) =>
          t.id === targetTabId
            ? {
                ...t,
                isExecuting: true,
                result: null,
                allRows: undefined,
                currentOffset: 0,
                isLoadingMore: false,
                loadMoreError: undefined,
              }
            : t,
        ),
      );
      setBottomPanelMode("results");

      const startTime = Date.now();

      try {
        const result = await (executionOptions === undefined
          ? onQueryExecute(activeConnection.id, queryToExecute)
          : onQueryExecute(activeConnection.id, queryToExecute, executionOptions));

        // Check if cancelled while awaiting
        if (cancelledRef.current) return;

        const executionTime = result.executionTime || Date.now() - startTime;

        setTabs((prev) =>
          prev.map((t) => {
            if (t.id !== targetTabId) return t;

            return {
              ...t,
              result: {
                rows: result.rows,
                fields: result.fields,
                rowCount: result.rowCount,
                executionTime,
                pagination: result.pagination,
                ...carriedChannels(result),
              },
              allRows: result.rows,
              resultQuery: queryToExecute,
              resultSourceQuery: tabToExec.query,
              resultConnectionId: activeConnection.id,
              currentOffset: result.rows.length,
              isExecuting: false,
              isLoadingMore: false,
            };
          }),
        );

        setHistoryKey((prev) => prev + 1);

        // The embedded workspace runs its queries here rather than through
        // `useQueryExecution`, so the one-shot star invitation has to be offered
        // from both paths or it would exist for standalone users only. Last in
        // the block and unable to throw: the result is already in the tab.
        maybeInviteToStar();
      } catch (error) {
        // Skip updates if cancelled
        if (cancelledRef.current) return;

        setTabs((prev) =>
          prev.map((t) =>
            t.id === targetTabId
              ? {
                  ...t,
                  isExecuting: false,
                  isLoadingMore: false,
                }
              : t,
          ),
        );

        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        toast({ title: "Query Error", description: errorMessage, variant: "destructive" });
      }
    },
    [activeConnection, activeTabId, toast, onQueryExecute, setTabs],
  );

  // Force execute (bypass safety check)
  const forceExecuteQuery = useCallback(
    (query: string) => {
      setSafetyCheckQuery(null);

      if (!activeConnection) {
        toast({ title: "No Connection", description: "Select a connection first.", variant: "destructive" });
        return;
      }

      if (!query || query.trim() === "") {
        toast({ title: "Empty Query", description: "Enter a query to execute.", variant: "destructive" });
        return;
      }

      cancelledRef.current = false;
      pageRequestsRef.current.delete(activeTabId);

      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId
            ? {
                ...t,
                isExecuting: true,
                result: null,
                allRows: undefined,
                currentOffset: 0,
                isLoadingMore: false,
                loadMoreError: undefined,
              }
            : t,
        ),
      );
      setBottomPanelMode("results");

      const startTime = Date.now();

      onQueryExecute(activeConnection.id, query)
        .then((result) => {
          if (cancelledRef.current) return;

          const executionTime = result.executionTime || Date.now() - startTime;

          setTabs((prev) =>
            prev.map((t) => {
              if (t.id !== activeTabId) return t;

              return {
                ...t,
                result: {
                  rows: result.rows,
                  fields: result.fields,
                  rowCount: result.rowCount,
                  executionTime,
                  pagination: result.pagination,
                  ...carriedChannels(result),
                },
                allRows: result.rows,
                resultQuery: query,
                resultSourceQuery: currentTab.query,
                resultConnectionId: activeConnection.id,
                currentOffset: result.rows.length,
                isExecuting: false,
                isLoadingMore: false,
              };
            }),
          );

          setHistoryKey((prev) => prev + 1);
          maybeInviteToStar();
        })
        .catch((error) => {
          if (cancelledRef.current) return;

          setTabs((prev) =>
            prev.map((t) =>
              t.id === activeTabId
                ? {
                    ...t,
                    isExecuting: false,
                    isLoadingMore: false,
                  }
                : t,
            ),
          );

          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          toast({ title: "Query Error", description: errorMessage, variant: "destructive" });
        });
    },
    [activeConnection, activeTabId, currentTab, toast, onQueryExecute, setTabs],
  );

  // Cancel running query (best-effort via ref flag)
  const cancelQuery = useCallback(() => {
    pageRequestsRef.current.clear();
    cancelledRef.current = true;

    setTabs((prev) =>
      prev.map((t) =>
        t.isExecuting || t.isLoadingMore
          ? {
              ...t,
              isExecuting: false,
              isLoadingMore: false,
            }
          : t,
      ),
    );

    toast({ title: "Query Cancelled", description: "Query execution was cancelled." });
  }, [setTabs, toast]);

  // Load More handler
  const handleLoadMore = useCallback(async () => {
    if (
      supportsResultPagination !== true ||
      !activeConnection ||
      !hasPageableResult(currentTab, activeConnection.id) ||
      currentTab.isLoadingMore ||
      currentTab.isExecuting ||
      pageRequestsRef.current.has(currentTab.id)
    )
      return;

    cancelledRef.current = false;
    const currentOffset = currentTab.currentOffset ?? currentTab.result!.rows.length;
    const originalResult = currentTab.result!;
    const request = {};
    const requests = pageRequestsRef.current;
    requests.set(currentTab.id, request);
    const ownsRequest = () => requests.get(currentTab.id) === request && !cancelledRef.current;

    setTabs((prev) =>
      prev.map((t) =>
        t.id === currentTab.id
          ? {
              ...t,
              isLoadingMore: true,
              loadMoreError: undefined,
            }
          : t,
      ),
    );

    try {
      const result = await onQueryExecute(activeConnection.id, currentTab.resultQuery ?? currentTab.query, {
        limit: originalResult.pagination!.limit,
        offset: currentOffset,
      });
      if (!ownsRequest()) return;

      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== currentTab.id) return t;
          if (t.result !== originalResult || !hasPageableResult(t, activeConnection.id))
            return { ...t, isLoadingMore: false };

          const existingRows = t.allRows || t.result?.rows || [];
          const newAllRows = [...existingRows, ...result.rows];

          return {
            ...t,
            result: {
              ...t.result,
              rows: newAllRows,
              fields: result.fields,
              rowCount: newAllRows.length,
              executionTime: t.result?.executionTime || 0,
              pagination: result.pagination,
              ...carriedChannels(result),
            },
            allRows: newAllRows,
            currentOffset: currentOffset + result.rows.length,
            isExecuting: false,
            isLoadingMore: false,
          };
        }),
      );
    } catch (error) {
      if (!ownsRequest()) return;
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      setTabs((prev) =>
        prev.map((t) =>
          t.id === currentTab.id
            ? {
                ...t,
                isExecuting: false,
                isLoadingMore: false,
                loadMoreError: errorMessage,
              }
            : t,
        ),
      );

      toast({ title: "Load More Error", description: errorMessage, variant: "destructive" });
    } finally {
      if (requests.get(currentTab.id) === request) requests.delete(currentTab.id);
    }
  }, [currentTab, activeConnection, onQueryExecute, setTabs, toast, supportsResultPagination]);

  // Unlimited query handler
  const handleUnlimitedQuery = useCallback(() => {
    if (!pendingUnlimitedQuery) return;
    if (!activeConnection) return;

    const { query, tabId } = pendingUnlimitedQuery;
    const sourceQuery = tabs.find((tab) => tab.id === tabId)?.query ?? query;

    cancelledRef.current = false;
    pageRequestsRef.current.delete(tabId);

    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? {
              ...t,
              isExecuting: true,
              result: null,
              allRows: undefined,
              currentOffset: 0,
              isLoadingMore: false,
              loadMoreError: undefined,
            }
          : t,
      ),
    );

    onQueryExecute(activeConnection.id, query, { unlimited: true })
      .then((result) => {
        if (cancelledRef.current) return;

        setTabs((prev) =>
          prev.map((t) => {
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
              resultQuery: query,
              resultSourceQuery: sourceQuery,
              resultConnectionId: activeConnection.id,
              currentOffset: result.rows.length,
              isExecuting: false,
              isLoadingMore: false,
            };
          }),
        );

        setHistoryKey((prev) => prev + 1);
        maybeInviteToStar();
      })
      .catch((error) => {
        if (cancelledRef.current) return;

        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  isExecuting: false,
                  isLoadingMore: false,
                }
              : t,
          ),
        );

        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        toast({ title: "Query Error", description: errorMessage, variant: "destructive" });
      });

    setUnlimitedWarningOpen(false);
    setPendingUnlimitedQuery(null);
  }, [pendingUnlimitedQuery, activeConnection, onQueryExecute, setTabs, toast, tabs]);

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
