"use client";

import { useState, useEffect, useCallback, useRef, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { DatabaseConnection, QueryTab } from "@/lib/types";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import type { QueryEditorRef } from "@/components/QueryEditor";
import { useToast } from "@/hooks/use-toast";
import { storage } from "@/lib/storage";
import { isDangerousQuery } from "@/components/QuerySafetyDialog";
import { isMultiStatement } from "@/lib/sql/statement-splitter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { shouldRefreshSchema } from "@/lib/query-generators";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { logger } from "@/lib/logger";
import { newLocalId } from "@/lib/ids";
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

/**
 * The wait a rate-limited response names in its `Retry-After` header, in whole seconds.
 *
 * `createErrorResponse` sends a delta-seconds integer (`src/lib/api/rate-limit.ts` counts in
 * seconds), so that is the only form read here. RFC 9110 also permits an HTTP-date, and an
 * ingress in front of a multi-replica deployment may send one; anything this cannot parse
 * returns null so the caller keeps the server's own message rather than inventing a number.
 */
function retryAfterSeconds(response: Response): number | null {
  const seconds = Number(response.headers.get("Retry-After"));
  return Number.isInteger(seconds) && seconds > 0 ? seconds : null;
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
  /**
   * The run in flight for each tab, keyed by tab id.
   *
   * Per TAB, not per hook. Tabs execute independently — `executeQuery` targets
   * whichever `targetTabId` it is given — so a single controller made every new
   * run abort whatever was running anywhere. Starting a query in tab B killed
   * tab A's, and because A's abort then read as "superseded" it cleared no flags
   * and raised no toast: tab A sat on "Executing…" forever, with no result and
   * no error. Keying the map by tab is what keeps one tab's Run out of another's.
   */
  const runsRef = useRef(new Map<string, { controller: AbortController; queryId: string }>());

  /**
   * The id of the LAST run started on each tab — which run owns the tab's results.
   *
   * Separate from `runsRef` because it has to outlive the entry there. `runsRef` is
   * about cancellation, so a run deletes its own entry the moment it settles; a
   * background EXPLAIN outlives its query and asks about ownership afterwards, and
   * an absent entry cannot answer. Reading absence as "not superseded" was right for
   * the common case (the plan still describes the results on screen) and wrong for
   * the one that mattered: run A finishes, run B runs and finishes, then A's slow
   * EXPLAIN resolves, finds nothing, and writes A's plan over B's results
   * (docs/BACKLOG.md U1). This map is never cleared per run, so it answers for that
   * window too.
   */
  const lastRunRef = useRef(new Map<string, string>());

  // Latest-value refs. `executeQuery` reads these at call time only, so keeping
  // them out of its dependency list makes the callback identity stable across a
  // keystroke — which is what stops the `execute-query` listener below from being
  // torn down and re-attached on every character typed into the editor, and what
  // lets callers memoize on it.
  const tabsRef = useRef(tabs);
  const currentTabRef = useRef(currentTab);
  const activeTabIdRef = useRef(activeTabId);
  // Refreshed after every commit, not during render: a ref is not render data
  // (react.dev/learn/referencing-values-with-refs). Every reader is a callback
  // that runs after the commit — `executeQuery` and `cancelQuery` — so "after
  // render" is soon enough, and the `useRef` initializers already hold the first
  // render's values. One effect for all three, with no dependency array on
  // purpose: they all describe the same parent render, so they can never
  // disagree about which render they came from, and a fourth ref added here
  // cannot be forgotten in a dependency list.
  useEffect(() => {
    tabsRef.current = tabs;
    currentTabRef.current = currentTab;
    activeTabIdRef.current = activeTabId;
  });

  // Nothing this hook started should outlive it: a fetch left running after the
  // studio unmounts resolves into a setState on a component that is gone. Every
  // tab's run, not just the last one started.
  useEffect(() => {
    const runs = runsRef.current;
    const lastRuns = lastRunRef.current;
    return () => {
      for (const run of runs.values()) run.controller.abort();
      runs.clear();
      lastRuns.clear();
    };
  }, []);

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
  // Adjusted during render rather than in an effect: React re-runs this hook
  // immediately and discards the render, so the panel never commits a frame
  // showing the explain body with the explain tab already filtered out of the
  // strip (react.dev/learn/you-might-not-need-an-effect). The state is still
  // genuinely written — deriving it instead would let the panel snap back to a
  // stale plan when the user returns to a provider that can explain. The
  // condition is self-extinguishing, which is what keeps this out of a loop.
  if (bottomPanelMode === "explain" && metadata && !metadata.capabilities.explainFormat) {
    setBottomPanelMode("results");
  }

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
      // Set up abort controller for query cancellation.
      //
      // A new run supersedes the one still in flight ON THIS TAB. Without the
      // abort the older request keeps streaming and its late response overwrites
      // the newer one — the user runs A, then B, and reads A's rows under B's
      // statement. Scoped to `targetTabId` so a run in another tab is left alone.
      runsRef.current.get(targetTabId)?.controller.abort();
      const abortController = new AbortController();
      const queryId = `q-${Date.now()}-${newLocalId()}`;
      runsRef.current.set(targetTabId, { controller: abortController, queryId });
      lastRunRef.current.set(targetTabId, queryId);

      /**
       * A newer run has taken THIS TAB over.
       *
       * Asked of `lastRunRef`, not of the in-flight map: while this run is the
       * latest one the answer is the same either way, and once it has settled and
       * removed its own entry only this map still knows whether anything started
       * after it. That is what lets a background EXPLAIN outlive its own query — its
       * plan still describes the results on screen — without letting it outlive the
       * NEXT one (U1).
       */
      const isSuperseded = () => lastRunRef.current.get(targetTabId) !== queryId;

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
        //
        // The splitter is a SQL splitter: it cuts on `;` outside quotes. A dialect
        // that is not SQL has no such separator, so every cut it makes there is an
        // invented fragment. Measured on Redis (#427): the generated cheatsheet
        // carried a `;` inside a `#` comment, so the buffer was split, and the
        // first "statement" was comments only - the run failed with "No command to
        // run" and the panel reported a successful empty result. Unknown metadata
        // keeps the pre-existing behaviour, since only a declared JSON dialect is
        // known not to be SQL.
        const dialectIsSql = (metadata?.capabilities.queryLanguage ?? "sql") === "sql";
        const useMultiQuery =
          !isExplain &&
          !isLoadMore &&
          !transactionActive &&
          !isPlaygroundRun &&
          !params &&
          dialectIsSql &&
          // Under the connection's own dialect, the same record the gate above
          // reads the statement with: whether a `;` is code depends on the
          // engine's comment, quoting and bracket rules, and a fragment this
          // disagrees about is a fragment the route RUNS (S1).
          isMultiStatement(queryToExecute, resolveSqlGrammar(activeConnection.type));

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
          const errorCode = error.code as string | undefined;
          // A 429's own body may say nothing about the wait, but its header always
          // carries one — name it, so the user retries when the budget is back instead
          // of hammering a closed door (docs/BACKLOG.md H2). Only the 429 is rephrased:
          // a Retry-After on any other status says nothing about this query's failure.
          const retryAfter = response.status === 429 ? retryAfterSeconds(response) : null;
          const errorMessage =
            retryAfter !== null ? `Too many requests. Try again in ${retryAfter}s.` : error.error || "Query failed";

          storage.addToHistory({
            id: newLocalId(),
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
            id: newLocalId(),
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
        // Only the run that still owns this tab's slot may clear it. A superseded
        // run finishes AFTER its replacement started, and deleting the entry here
        // would leave the newer query with no controller and no id — a Cancel
        // button that aborts nothing and a server-side cancel that is never sent.
        if (!isSuperseded()) {
          runsRef.current.delete(targetTabId);
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
          id: newLocalId(),
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
          id: newLocalId(),
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

  /**
   * Cancel the run on one tab — the active one unless a caller names another.
   *
   * The Cancel button belongs to a tab, so cancelling has to name the tab too;
   * with a single hook-wide controller it stopped whichever run started last,
   * which is not necessarily the one the user is looking at.
   *
   * NEVER hand this to an `onClick` directly. React passes the MouseEvent into
   * the first slot, `tabId` reads it as a tab that holds no run, and the button
   * silently cancels nothing — the type checker permits it, because an optional
   * parameter still satisfies `() => void`. Wrap it: `() => cancelQuery()`.
   */
  const cancelQuery = useCallback(
    async (tabId?: string) => {
      const targetTabId = tabId ?? activeTabIdRef.current;
      const run = runsRef.current.get(targetTabId);
      if (!run) return;

      run.controller.abort();

      // Also cancel on the server side: aborting the fetch drops the response,
      // it does not stop the statement the engine is still executing.
      if (activeConnection) {
        try {
          await fetch("/api/db/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...buildConnectionPayload(activeConnection),
              queryId: run.queryId,
            }),
          });
        } catch {
          logger.warn("Query cancellation request failed", { route: "use-query-execution" });
        }
      }
    },
    [activeConnection],
  );

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
