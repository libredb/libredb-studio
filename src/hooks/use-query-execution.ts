"use client";

import { useState, useEffect, useCallback, useRef, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { DatabaseConnection, QueryTab } from "@/lib/types";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import type { QueryEditorRef } from "@/components/QueryEditor";
import { useToast } from "@/hooks/use-toast";
import { storage } from "@/lib/storage";
import { isDangerousQuery } from "@/components/QuerySafetyDialog";
import { isMultiStatement } from "@/lib/sql/statement-splitter";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
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
 * The id one history entry is filed under.
 *
 * `crypto.getRandomValues` rather than `Math.random`, which a scanner reads as a
 * pseudorandom generator standing where a secure one belongs. Nothing here is a
 * secret — the id names a row in this browser's own query history — but the two cost
 * the same and only one of them has to be argued about in every review.
 *
 * Deliberately NOT `crypto.randomUUID`: it is restricted to secure contexts, and
 * Studio is served over plain HTTP on several of its distribution channels, where it
 * is simply undefined. `getRandomValues` carries no such restriction.
 */
function newHistoryId(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(2));
  return `${bytes[0].toString(36)}${bytes[1].toString(36)}`;
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
      const targetTabId = tabId || activeTabId;
      const tabToExec = tabs.find((t) => t.id === targetTabId) || currentTab;

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
      const { limit = DEFAULT_QUERY_LIMIT, offset = 0, unlimited = false, params } = executionOptions || {};

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
      // Set up abort controller for query cancellation
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      const queryId = `q-${Date.now()}-${newHistoryId()}`;
      activeQueryIdRef.current = queryId;

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
        let explainPromise: Promise<Response> | null = null;
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
            id: newHistoryId(),
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
            toast({ title: "Query Cancelled", description: "Query execution was cancelled." });
            return;
          }

          throw new Error(errorMessage);
        }

        const resultData = await response.json();

        // Only add to history for new queries (not load more)
        if (!isLoadMore) {
          storage.addToHistory({
            id: newHistoryId(),
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
              if (explainRes.ok) {
                const explainData = await explainRes.json();
                const plan = { format: explainStrategy.format, raw: explainStrategy.extractPlan(explainData) };
                setTabs((prev) => prev.map((t) => (t.id === targetTabId ? { ...t, explainPlan: plan } : t)));
              }
            })
            .catch((err) => console.error("[EXPLAIN] Background fetch failed:", err));
        }

        // Update tab state: Load More (append) vs new query (replace)
        setTabs((prev) =>
          prev.map((t) => {
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
          }),
        );

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

        // Don't show error toast for user-initiated cancellation
        if (error instanceof DOMException && error.name === "AbortError") {
          toast({ title: "Query Cancelled", description: "Query execution was cancelled." });
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
        abortControllerRef.current = null;
        activeQueryIdRef.current = null;
      }
    },
    [
      activeConnection,
      tabs,
      currentTab,
      activeTabId,
      toast,
      fetchSchema,
      metadata,
      transactionActive,
      playgroundMode,
      setTabs,
      queryEditorRef,
    ],
  );

  // Force execute (bypass safety check) — unified via skipSafety flag
  const forceExecuteQuery = useCallback(
    (query: string) => {
      setSafetyCheckQuery(null);
      executeQuery(query, undefined, false, { skipSafety: true });
    },
    [executeQuery],
  );

  /**
   * Run a statement an agent run handed to this editor (#329, §2.1/§2.5 of
   * `docs/AGENT_ANALYST_DESIGN.md`; reshaped by the #373 review).
   *
   * It takes a RUN, not a statement to execute. The statement is named only so this
   * hook can label the history entry with the text the user is looking at; what is
   * sent is the run id, and the server reads the statement off that run's ledger.
   *
   * That is the whole of the security fix. This used to call `executeQuery`, which
   * goes to `POST /api/db/query` — the editor's ordinary, read-WRITE path, guarded
   * only by `isDangerousQuery`, a check on the statement's text. The agent's own read
   * is bounded by the ENGINE (`BEGIN READ ONLY`, `PRAGMA query_only`), and a `SELECT`
   * that calls a VOLATILE function performing an `INSERT` is refused there and
   * performed here. No inspection of the text can tell those apart, so the replay is
   * no longer served by a route that lacks the boundary: it goes to
   * `POST /api/agent/runs/[runId]/handover`, which runs it through `queryReadOnly`
   * under `AGENT_HANDOVER_PROFILE` at the editor's default row limit and with no
   * statement timeout — the bounds the checkbox names, enforced by the database.
   *
   * The route is named as a literal rather than imported: `src/lib/agent/*` is out of
   * the published package's module graph by construction
   * (`tests/unit/agent-package-boundary.test.ts`), and this hook is in it.
   *
   * Nothing here appends a `LIMIT`, and nothing refreshes the schema afterwards: the
   * text stays the text the run's ledger holds, and a read that the engine itself
   * holds read-only cannot have changed one.
   */
  const executeHandedOverStatement = useCallback(
    async (runId: string, sql: string) => {
      if (!activeConnection) {
        toast({ title: "No Connection", description: "Select a connection first.", variant: "destructive" });
        return;
      }
      const targetTabId = activeTabId;
      const tabToExec = tabs.find((t) => t.id === targetTabId) || currentTab;

      setTabs((prev) => prev.map((t) => (t.id === targetTabId ? { ...t, isExecuting: true } : t)));
      setBottomPanelMode("results");

      const startTime = Date.now();
      try {
        const response = await fetch(`/api/agent/runs/${encodeURIComponent(runId)}/handover`, { method: "POST" });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "The hand-over could not be run");
        }

        const result = payload.result;
        storage.addToHistory({
          id: newHistoryId(),
          connectionId: activeConnection.id,
          connectionName: activeConnection.name,
          tabName: tabToExec.name,
          query: sql,
          executionTime: result.executionTime ?? Date.now() - startTime,
          status: "success",
          executedAt: new Date(),
          rowCount: result.rowCount,
        });
        setHistoryKey((prev) => prev + 1);

        setTabs((prev) =>
          prev.map((t) =>
            t.id === targetTabId
              ? { ...t, result, allRows: result.rows, currentOffset: result.rows.length, isExecuting: false }
              : t,
          ),
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        storage.addToHistory({
          id: newHistoryId(),
          connectionId: activeConnection.id,
          connectionName: activeConnection.name,
          tabName: tabToExec.name,
          query: sql,
          executionTime: Date.now() - startTime,
          status: "error",
          executedAt: new Date(),
          errorMessage,
        });
        setHistoryKey((prev) => prev + 1);
        setTabs((prev) => prev.map((t) => (t.id === targetTabId ? { ...t, isExecuting: false } : t)));
        toast({ title: "Query Error", description: errorMessage, variant: "destructive" });
      }
    },
    [activeConnection, activeTabId, tabs, currentTab, setTabs, toast],
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
    executeHandedOverStatement,
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
