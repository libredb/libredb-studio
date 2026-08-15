"use client";

import { useState, useEffect, useCallback, useRef, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { DatabaseConnection, QueryTab } from "@/lib/types";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import type { QueryEditorRef } from "@/components/QueryEditor";
import { useToast } from "@/hooks/use-toast";
import { storage } from "@/lib/storage";
import { isDangerousQuery } from "@/components/QuerySafetyDialog";
import { isMultiStatement } from "@/lib/sql/statement-splitter";
import { shouldRefreshSchema } from "@/lib/query-generators";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { logger } from "@/lib/logger";
import { getExplainStrategy } from "@/lib/explain";
import { maybeInviteToStar } from "@/lib/community/star-prompt-toast";
import { buildConnectionPayload } from "./use-connection-payload";

export interface QueryExecutionOptions {
  limit?: number;
  offset?: number;
  unlimited?: boolean;
  skipSafety?: boolean;
  /**
   * Values for the statement's positional placeholders, bound by the driver
   * instead of written into the SQL. A generated statement (the inline row editor,
   * #290) carries its values here so that no value can be read as statement text.
   */
  params?: unknown[];
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

/**
 * Why an explain run cannot proceed, phrased for the user. Absent metadata means
 * "not loaded yet", not "unsupported" — blaming the database type there would be
 * misleading.
 */
function explainRefusal(metadata: ProviderMetadata | null, hasStrategy: boolean) {
  if (!metadata) {
    return { title: "Not Ready", description: "Connection metadata is still loading. Try again in a moment." };
  }
  if (hasStrategy && metadata.capabilities.supportsExplain) {
    return { title: "Not Supported", description: "Only SELECT statements can be explained." };
  }
  return { title: "Not Supported", description: "EXPLAIN is not available for this database type." };
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

  // Latest-value refs. `executeQuery` reads these at call time only, so keeping
  // them out of its dependency list makes the callback identity stable across a
  // keystroke — which is what stops the `execute-query` listener below from being
  // torn down and re-attached on every character typed into the editor, and what
  // lets callers memoize on it.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const currentTabRef = useRef(currentTab);
  currentTabRef.current = currentTab;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  // Nothing this hook started should outlive it: a fetch left running after the
  // studio unmounts resolves into a setState on a component that is gone.
  useEffect(() => () => abortControllerRef.current?.abort(), []);

  const [safetyCheckQuery, setSafetyCheckQuery] = useState<string | null>(null);
  const [unlimitedWarningOpen, setUnlimitedWarningOpen] = useState(false);
  const [pendingUnlimitedQuery, setPendingUnlimitedQuery] = useState<{
    query: string;
    tabId: string;
  } | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [bottomPanelMode, setBottomPanelMode] = useState<
    "results" | "explain" | "history" | "saved" | "charts" | "pivot" | "docs" | "schemadiff" | "dashboard"
  >("results");

  // Capability honesty: if the active provider has no explainFormat (e.g. the
  // user switched connections), never leave the panel stuck on a hidden tab.
  // Keyed on explainFormat to match the BottomPanel tab filter and getExplainStrategy.
  useEffect(() => {
    if (bottomPanelMode === "explain" && metadata && !metadata.capabilities.explainFormat) {
      setBottomPanelMode("results");
    }
  }, [bottomPanelMode, metadata]);

  const { toast } = useToast();

  // Unified executeQuery — handles both normal and force (skipSafety) execution
  const executeQuery = useCallback(
    async (
      overrideQuery?: string,
      tabId?: string,
      isExplain: boolean = false,
      executionOptions?: QueryExecutionOptions,
    ) => {
      const activeTabId = activeTabIdRef.current;
      const targetTabId = tabId || activeTabId;
      const tabToExec = tabsRef.current.find((t) => t.id === targetTabId) || currentTabRef.current;

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
      if (
        !skipSafety &&
        !isExplain &&
        !executionOptions?.offset &&
        !playgroundMode &&
        // The connection's type is the dialect the statement is about to run
        // under, and the gate reads the statement under it (#292).
        isDangerousQuery(queryToExecute, activeConnection.type)
      ) {
        setSafetyCheckQuery(queryToExecute);
        return;
      }

      // Options extraction
      const { limit = 500, offset = 0, unlimited = false, params } = executionOptions || {};

      // isLoadingMore flag
      const isLoadMore = offset > 0;

      setTabs((prev) =>
        prev.map((t) =>
          t.id === targetTabId
            ? {
                ...t,
                isExecuting: !isLoadMore,
                isLoadingMore: isLoadMore,
              }
            : t,
        ),
      );
      setBottomPanelMode(isExplain ? "explain" : "results");

      const explainStrategy = getExplainStrategy(metadata?.capabilities.explainFormat);

      // An explain run skips the dangerous-query gate above, so it may only ever
      // send SQL the dialect actually built for it — whether the provider denies
      // EXPLAIN outright, ships no strategy, or the statement is not a SELECT.
      // Falling back to the original statement would execute e.g. an UPDATE
      // unguarded (#201).
      const explainSupported = !metadata || metadata.capabilities.supportsExplain;
      const directExplainSql =
        isExplain && explainSupported ? (explainStrategy?.buildSql(queryToExecute, "analyze") ?? null) : null;
      if (isExplain && !directExplainSql) {
        toast({ ...explainRefusal(metadata, Boolean(explainStrategy)), variant: "destructive" });
        setTabs((prev) =>
          prev.map((t) => (t.id === targetTabId ? { ...t, isExecuting: false, isLoadingMore: false } : t)),
        );
        return;
      }

      const startTime = Date.now();
      // Set up abort controller for query cancellation.
      //
      // A new run supersedes whatever is still in flight. Without the abort the
      // older request keeps streaming and its late response overwrites the newer
      // one on the same tab — the user runs A, then B, and reads A's rows under
      // B's statement.
      abortControllerRef.current?.abort();
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      const queryId = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      activeQueryIdRef.current = queryId;

      /**
       * A newer run has taken this tab over. Idle (`null`) is deliberately NOT
       * superseded: the background EXPLAIN outlives its own query, and its plan
       * is still the right plan for the results on screen.
       */
      const isSuperseded = () => activeQueryIdRef.current !== null && activeQueryIdRef.current !== queryId;

      /** Write to the tab this run owns — and only while it still owns it. */
      const commitToTab = (update: (tab: QueryTab) => QueryTab) => {
        if (isSuperseded()) return;
        setTabs((prev) => prev.map((t) => (t.id === targetTabId ? update(t) : t)));
      };

      // Playground mode: begin a transaction before executing (will rollback after)
      const isPlaygroundRun = playgroundMode && !transactionActive && !isExplain && !isLoadMore;

      try {
        if (isPlaygroundRun) {
          const beginRes = await fetch("/api/db/transaction", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...buildConnectionPayload(activeConnection), action: "begin" }),
          });
          if (!beginRes.ok) {
            logger.warn("Playground transaction BEGIN failed", { route: "use-query-execution" });
          }
        }

        // If isExplain mode, run the dialect's EXPLAIN query instead
        const queryToRun = directExplainSql || queryToExecute;

        // Detect multi-statement queries (not for EXPLAIN or load-more or transaction)
        //
        // A parameterized statement never takes this route: `/api/db/multi-query`
        // splits the payload and binds nothing, so the values would be dropped and
        // the statement would run with unbound placeholders. Parameters may only
        // travel to an endpoint that binds them (PR #304 review).
        const useMultiQuery =
          !isExplain &&
          !isLoadMore &&
          !transactionActive &&
          !isPlaygroundRun &&
          !params &&
          isMultiStatement(queryToExecute);

        // Use transaction endpoint if a transaction is active or in playground mode
        const useTransaction = (transactionActive || isPlaygroundRun) && !isExplain;

        // Start both queries in parallel (main query + background explain)
        const queryEndpoint = useTransaction
          ? "/api/db/transaction"
          : useMultiQuery
            ? "/api/db/multi-query"
            : "/api/db/query";
        const mainQueryPromise = fetch(queryEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...buildConnectionPayload(activeConnection),
            // The parameter array travels beside the SQL on whichever endpoint the
            // statement takes, and only when the caller supplied one: a request
            // without values must stay a request without a `params` key (#290).
            ...(params && { params }),
            ...(useTransaction
              ? { action: "query", sql: queryToExecute, options: { limit, offset, unlimited } }
              : {
                  sql: isExplain ? queryToRun : queryToExecute,
                  options: isExplain ? {} : { limit, offset, unlimited },
                  ...(!useMultiQuery && { queryId }),
                }),
          }),
          signal: abortController.signal,
        });

        // Run EXPLAIN in background for non-explain queries (SELECT only)
        //
        // Typed as `Response | null` because its rejection is handled at creation
        // (below), not where it is consumed: the consumer only runs after the main
        // query settles, and a plan request that fails first — or is aborted with
        // its run — would be an unhandled rejection until then.
        let explainPromise: Promise<Response | null> | null = null;
        if (!isExplain && !isLoadMore && explainStrategy) {
          const explainSql = explainStrategy.buildSql(queryToExecute, "estimate");
          if (explainSql) {
            explainPromise = fetch("/api/db/query", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...buildConnectionPayload(activeConnection),
                sql: explainSql,
                options: {},
                // The explain SQL is the statement with a prefix, so its
                // placeholders are the same ones in the same order and the same
                // values bind them. Without this the plan request would run
                // unbound and the panel would keep the previous plan (PR #304).
                ...(params && { params }),
              }),
              // The plan belongs to this run, so it dies with it. Without the
              // signal, cancelling the query — or unmounting the studio — leaves
              // a request nobody can stop, which lands a plan on a tab that has
              // moved on.
              signal: abortController.signal,
            }).catch((err) => {
              // Aborting is this hook's own doing, not a failure worth reporting.
              if (!(err instanceof DOMException && err.name === "AbortError")) {
                logger.warn("Background EXPLAIN fetch failed", {
                  route: "use-query-execution",
                  error: err instanceof Error ? err.message : String(err),
                });
              }
              return null;
            });
          }
        }

        const response = await mainQueryPromise;

        const endTime = Date.now();
        const executionTime = endTime - startTime;

        if (!response.ok) {
          const error = await response.json();
          const errorMessage = error.error || "Query failed";
          const errorCode = error.code as string | undefined;

          storage.addToHistory({
            id: Math.random().toString(36).substring(7),
            connectionId: activeConnection.id,
            connectionName: activeConnection.name,
            tabName: tabToExec.name,
            query: queryToExecute,
            executionTime,
            status: "error",
            executedAt: new Date(),
            errorMessage,
          });

          // Handle query cancellation via response code
          if (errorCode === ApiErrorCode.QUERY_CANCELLED) {
            commitToTab((t) => ({ ...t, isExecuting: false, isLoadingMore: false }));
            toast({ title: "Query Cancelled", description: "Query execution was cancelled." });
            return;
          }

          throw new Error(errorMessage);
        }

        const resultData = await response.json();

        // Only add to history for new queries (not load more)
        if (!isLoadMore) {
          storage.addToHistory({
            id: Math.random().toString(36).substring(7),
            connectionId: activeConnection.id,
            connectionName: activeConnection.name,
            tabName: tabToExec.name,
            query: queryToExecute,
            executionTime: resultData.executionTime || executionTime,
            status: resultData.hasError ? "error" : "success",
            executedAt: new Date(),
            rowCount: resultData.rowCount,
            errorMessage: resultData.hasError
              ? resultData.statements?.find((s: { status: string }) => s.status === "error")?.error
              : undefined,
          });
          setHistoryKey((prev) => prev + 1);
        }

        // Show multi-statement summary
        if (resultData.multiStatement) {
          const { executedCount, statementCount, hasError } = resultData;
          if (hasError) {
            const errorStmt = resultData.statements?.find((s: { status: string }) => s.status === "error");
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
          explainPlanData = explainStrategy
            ? { format: explainStrategy.format, raw: explainStrategy.extractPlan(resultData) }
            : null;
        } else if (explainPromise && explainStrategy) {
          // Background EXPLAIN - don't block, update async
          explainPromise
            .then(async (explainRes) => {
              if (!explainRes?.ok) return;
              const explainData = await explainRes.json();
              const plan = { format: explainStrategy.format, raw: explainStrategy.extractPlan(explainData) };
              // `commitToTab` drops the plan if a newer run owns the tab: a plan
              // describing the previous statement is worse than no plan at all.
              commitToTab((t) => ({ ...t, explainPlan: plan }));
            })
            .catch((err) => {
              logger.warn("Background EXPLAIN parse failed", {
                route: "use-query-execution",
                error: err instanceof Error ? err.message : String(err),
              });
            });
        }

        // Update tab state: Load More (append) vs new query (replace)
        commitToTab((t) => {
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
        });

        // Playground mode: auto-rollback after getting results
        if (isPlaygroundRun) {
          try {
            await fetch("/api/db/transaction", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...buildConnectionPayload(activeConnection), action: "rollback" }),
            });
          } catch {
            logger.warn("Playground transaction rollback failed", { route: "use-query-execution" });
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

        // A genuine success - not an error, not a cancellation, not a pagination
        // fetch or a background EXPLAIN - may earn the one-shot star invitation
        // (once per browser, ever). LAST in the try block on purpose: the result
        // is already in the tab and the playground rollback has already run, so
        // nothing downstream depends on this line. `maybeInviteToStar` cannot
        // throw either, which keeps the catch below about queries only.
        if (!isExplain && !isLoadMore && !resultData.hasError) {
          maybeInviteToStar();
        }
      } catch (error) {
        // Playground mode: rollback on error too
        if (isPlaygroundRun) {
          try {
            await fetch("/api/db/transaction", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...buildConnectionPayload(activeConnection), action: "rollback" }),
            });
          } catch {
            logger.warn("Playground transaction rollback failed", { route: "use-query-execution" });
          }
        }
        // A superseded run must not clear the flags the newer run just set: the
        // spinner belongs to the query that is still running.
        const superseded = isSuperseded();
        commitToTab((t) => ({ ...t, isExecuting: false, isLoadingMore: false }));

        // Don't show error toast for user-initiated cancellation
        if (error instanceof DOMException && error.name === "AbortError") {
          // Superseding is not cancelling. The user asked for another query; they
          // did not ask to be told this one stopped.
          if (!superseded) {
            toast({ title: "Query Cancelled", description: "Query execution was cancelled." });
          }
          return;
        }

        const title = "Query Error";
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        // Fallback string check for cancellation errors not caught by response code
        if (errorMessage.includes("Query was cancelled") || errorMessage.includes("cancelled")) {
          toast({ title: "Query Cancelled", description: "Query execution was cancelled." });
          return;
        }
        toast({ title, description: errorMessage, variant: "destructive" });
      } finally {
        // Only the run that still owns the refs may clear them. A run that was
        // superseded finishes AFTER its replacement started, and blanking the
        // refs here would leave the newer query with no controller and no id —
        // a Cancel button that aborts nothing and a server-side cancel that is
        // never sent.
        if (!isSuperseded()) {
          abortControllerRef.current = null;
          activeQueryIdRef.current = null;
        }
      }
    },
    [activeConnection, toast, fetchSchema, metadata, transactionActive, playgroundMode, setTabs, queryEditorRef],
  );

  // Force execute (bypass safety check) — unified via skipSafety flag
  const forceExecuteQuery = useCallback(
    (query: string) => {
      setSafetyCheckQuery(null);
      executeQuery(query, undefined, false, { skipSafety: true });
    },
    [executeQuery],
  );

  // Cancel running query
  const cancelQuery = useCallback(async () => {
    // Abort the fetch request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Also cancel on the server side
    if (activeQueryIdRef.current && activeConnection) {
      try {
        await fetch("/api/db/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...buildConnectionPayload(activeConnection),
            queryId: activeQueryIdRef.current,
          }),
        });
      } catch {
        logger.warn("Query cancellation request failed", { route: "use-query-execution" });
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

    executeQuery(pendingUnlimitedQuery.query, pendingUnlimitedQuery.tabId, false, { unlimited: true });

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
    window.addEventListener("execute-query", handleExecuteQueryEvent);
    return () => window.removeEventListener("execute-query", handleExecuteQueryEvent);
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
