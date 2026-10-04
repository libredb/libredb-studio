"use client";

import { useState, useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { DatabaseConnection, QueryTab } from "@/lib/types";
import type { WorkspaceQueryResult, WorkspaceFeatures } from "@/workspace/types";
import type { BottomPanelMode } from "@/components/studio/BottomPanel";
import { useToast } from "@/hooks/use-toast";
import { newLocalId } from "@/lib/ids";
import { isDangerousQuery } from "@/components/QuerySafetyDialog";
import { statementRefusal } from "@/lib/db/destructive-commands";
import { maybeInviteToStar } from "@/lib/community/star-prompt-toast";

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
 *
 * The host's vector columns ride the same channel (vector-family spec 3.10), so
 * every path that builds a tab result carries them: a run, a confirmed run, a page
 * and an unlimited run. A page of the same statement names the same columns, so a
 * page that declares none keeps the declaration of the rows already on screen
 * (`previous`), which is what keeps a vector column from turning back into JSON
 * after Load More; a page that declares its own is believed.
 */
function carriedChannels(
  result: WorkspaceQueryResult,
  previous?: QueryTab["result"],
): Pick<QueryTab["result"] & object, "warnings" | "columnTypes" | "vectorColumns"> {
  // A column the host declared without a type contributes no entry rather than an
  // undefined one every reader would have to test for.
  const declared = (result.columns ?? []).filter((column) => column.type !== undefined);
  const vectorColumns = result.vectorColumns ?? previous?.vectorColumns;
  return {
    ...(result.warnings && { warnings: result.warnings }),
    ...(declared.length > 0 && {
      columnTypes: Object.fromEntries(declared.map((column) => [column.name, column.type as string])),
    }),
    ...(vectorColumns !== undefined && { vectorColumns }),
  };
}

interface UseQueryAdapterParams {
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

  /**
   * The id of the LAST run started on each tab, which is to say the run that owns the
   * tab's results.
   *
   * `cancelledRef` is a single boolean for the whole hook, so it can answer "did the user
   * press Cancel" and nothing else. It cannot answer "is this result still the one the
   * tab is waiting for", and that is the question a late response has to be asked. The
   * user clicks Load More, gives up waiting and presses Run; Run replaces the grid; then
   * the overtaken page resolves, appends its now-stale rows on top of the new ones and
   * rewrites `resultQuery` to the paged statement. The tab ends up holding rows from two
   * statements while naming one, which is the failure the commit below already cites
   * #881 for, reached down the paging path instead.
   *
   * `use-query-execution` answers this with its own `lastRunRef`, and aborts as well.
   * This surface cannot abort: the host owns the fetch behind `onQueryExecute`. Ownership
   * is therefore the only mechanism available here, and it is the one that closes the
   * window in any case, because an abort does not un-resolve a response already on its
   * way back.
   *
   * Keyed by TAB for the same reason the standalone map is: tabs execute independently,
   * so a run started in one tab must not disown a run in another.
   */
  const lastRunRef = useRef(new Map<string, string>());

  /**
   * Claim a tab for a new run, and hand back the question every commit of that run must
   * ask before it writes: does this run still own the tab?
   */
  const beginRun = useCallback((tabId: string) => {
    const runId = newLocalId();
    lastRunRef.current.set(tabId, runId);
    return () => lastRunRef.current.get(tabId) === runId;
  }, []);

  // Nothing this hook started should outlive it, for the reason `use-query-execution`
  // states where it aborts every run on unmount: "a fetch left running after the studio
  // unmounts resolves into a setState on a component that is gone". This surface cannot
  // abort, because the host owns the fetch behind `onQueryExecute`, so dropping the claims
  // is how the same rule is kept here: a run whose claim is gone no longer owns its tab,
  // and every commit arm below asks that question before it writes (#816).
  useEffect(() => {
    const lastRuns = lastRunRef.current;
    return () => {
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
  const [bottomPanelMode, setBottomPanelMode] = useState<BottomPanelMode>("results");

  const { toast } = useToast();

  /**
   * Shows a statement this connection type's editor refuses on the tab it was run in, and hands the host nothing.
   *
   * It counts as the tab's newest run, so `beginRun` disowns a run still in flight there and that run's late answer
   * cannot land over the sentence. The failure takes the place of the rows on screen because this shell mounts no
   * Toaster: `runError` is the signal a host's user sees, and the toast reaches only a host that mounts one.
   */
  const refuseRun = useCallback(
    (tabId: string, sentence: string) => {
      beginRun(tabId);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? {
                ...t,
                result: null,
                resultQuery: undefined,
                allRows: undefined,
                currentOffset: 0,
                runError: sentence,
                isExecuting: false,
                isLoadingMore: false,
              }
            : t,
        ),
      );
      toast({ title: "Statement Refused", description: sentence, variant: "destructive" });
    },
    [beginRun, setTabs, toast],
  );

  const executeQuery = useCallback(
    async (
      overrideQuery?: string,
      tabId?: string,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _isExplain: boolean = false,
      /**
       * Carried to the host verbatim (#816).
       *
       * This surface took no options at all, and a tree click's preview cap used to be
       * text inside the statement, so nothing was lost. With the cap moved out of the
       * SQL (`PREVIEW_PAGE_SIZE` in `use-tab-manager.ts`) this is the only channel it
       * has, and a host that ignores `limit` answers a tree click with every row of the
       * table — which is why the prop's own docblock in `src/workspace/types.ts` now
       * says so.
       */
      executionOptions?: { limit?: number; offset?: number; unlimited?: boolean },
    ) => {
      const targetTabId = tabId || activeTabId;
      const tabToExec = tabs.find((t) => t.id === targetTabId) || currentTab;

      const queryToExecute = overrideQuery || tabToExec.query;

      if (!activeConnection) {
        toast({ title: "No Connection", description: "Select a connection first.", variant: "destructive" });
        return;
      }

      // Before the gate and before anything reaches the host, which owns the fetch.
      const refusal = statementRefusal(queryToExecute, activeConnection.type);
      if (refusal !== undefined) {
        refuseRun(targetTabId, refusal);
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
      const ownsTab = beginRun(targetTabId);

      // Set tab executing state.
      //
      // Claiming the tab takes over BOTH flags in one write, for the reason the claim in
      // `handleLoadMore` states in the other direction: a page in flight set
      // `isLoadingMore: true`, the ownership check above has just disowned it, and a
      // disowned page may not write - so it can no longer clear the flag it set. Writing
      // only `isExecuting` here left the tab spinning a Load More, for the whole of this
      // run, over a page whose rows will never be shown.
      //
      // `isLoadingMore: false` rather than the standalone's `isLoadMore` ternary, because
      // this hook's paging does not come through here at all: `handleLoadMore` makes its
      // own claim and its own request. A run reaching this point REPLACES the grid even
      // when it carries an offset, so it is never the page (#816).
      setTabs((prev) =>
        prev.map((t) =>
          t.id === targetTabId
            ? {
                ...t,
                isExecuting: true,
                isLoadingMore: false,
              }
            : t,
        ),
      );
      setBottomPanelMode("results");

      const startTime = Date.now();

      try {
        // The third argument is OMITTED rather than sent as `undefined` when this run
        // carries no options. `onQueryExecute` is a published host prop, and a run that
        // asks for nothing has to reach a host exactly as it always did.
        const result =
          executionOptions === undefined
            ? await onQueryExecute(activeConnection.id, queryToExecute)
            : await onQueryExecute(activeConnection.id, queryToExecute, executionOptions);

        // Check if cancelled, or overtaken by a newer run on this tab, while awaiting
        if (cancelledRef.current || !ownsTab()) return;

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
              // The rows and the statement that fetched them are committed together, the way
              // `use-query-execution` does it: a reader of one must never be handed the other's
              // (#881). Inline editing is off in this surface, so the wrong-table WRITE cannot
              // happen here - a tab holding rows from two tables while naming one still can.
              resultQuery: queryToExecute,
              allRows: result.rows,
              currentOffset: result.rows.length,
              isExecuting: false,
              isLoadingMore: false,
              runError: undefined,
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
        // Skip updates if cancelled, or if a newer run now owns the tab: clearing its
        // flags or raising a toast for a run nobody is waiting for is the same write.
        if (cancelledRef.current || !ownsTab()) return;

        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        // The failure REPLACES the previous result, as it does in `use-query-execution`: the
        // rows on screen were fetched by another statement, and a reader of one must never be
        // handed the other's (#881). This shell mounts no Toaster, so the inline block the
        // results panel renders for `runError` is the only failure signal a host's user sees.
        setTabs((prev) =>
          prev.map((t) =>
            t.id === targetTabId
              ? {
                  ...t,
                  result: null,
                  resultQuery: undefined,
                  allRows: undefined,
                  currentOffset: 0,
                  runError: errorMessage,
                  isExecuting: false,
                  isLoadingMore: false,
                }
              : t,
          ),
        );

        toast({ title: "Query Error", description: errorMessage, variant: "destructive" });
      }
    },
    [activeConnection, tabs, currentTab, activeTabId, toast, onQueryExecute, setTabs, beginRun, refuseRun],
  );

  // Force execute (bypass safety check)
  const forceExecuteQuery = useCallback(
    (query: string) => {
      setSafetyCheckQuery(null);

      if (!activeConnection) {
        toast({ title: "No Connection", description: "Select a connection first.", variant: "destructive" });
        return;
      }

      // Proceed skips the gate, never this check.
      const refusal = statementRefusal(query, activeConnection.type);
      if (refusal !== undefined) {
        refuseRun(activeTabId, refusal);
        return;
      }

      if (!query || query.trim() === "") {
        toast({ title: "Empty Query", description: "Enter a query to execute.", variant: "destructive" });
        return;
      }

      cancelledRef.current = false;
      const ownsTab = beginRun(activeTabId);

      // Claiming the tab takes over BOTH flags in one write, for the same reason the claims
      // in `executeQuery` and `handleLoadMore` state: `beginRun` immediately above has just
      // disowned whatever was in flight, and a disowned page may not write, so it can no
      // longer clear the `isLoadingMore: true` it set itself. Writing only `isExecuting`
      // here left the tab spinning a Load More, for the whole of this run, over a page
      // whose rows will never be shown - and the control is `disabled={isLoadingMore}` in
      // `StatsBar`, so it sat dead until some later run settled the flag. This is a run
      // entry point a user reaches without trying: it is the safety dialog's Proceed in
      // `StudioWorkspace` (#816).
      //
      // `isLoadingMore: false` rather than a ternary, because this path never carries an
      // offset: it re-runs the statement the dialog asked about and REPLACES the grid.
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTabId
            ? {
                ...t,
                isExecuting: true,
                isLoadingMore: false,
              }
            : t,
        ),
      );
      setBottomPanelMode("results");

      const startTime = Date.now();

      onQueryExecute(activeConnection.id, query)
        .then((result) => {
          if (cancelledRef.current || !ownsTab()) return;

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
                resultQuery: query,
                allRows: result.rows,
                currentOffset: result.rows.length,
                isExecuting: false,
                isLoadingMore: false,
                runError: undefined,
              };
            }),
          );

          setHistoryKey((prev) => prev + 1);
          maybeInviteToStar();
        })
        .catch((error) => {
          if (cancelledRef.current || !ownsTab()) return;

          // Replaces the previous result, for the reason the catch in `executeQuery` states.
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          setTabs((prev) =>
            prev.map((t) =>
              t.id === activeTabId
                ? {
                    ...t,
                    result: null,
                    resultQuery: undefined,
                    allRows: undefined,
                    currentOffset: 0,
                    runError: errorMessage,
                    isExecuting: false,
                    isLoadingMore: false,
                  }
                : t,
            ),
          );

          toast({ title: "Query Error", description: errorMessage, variant: "destructive" });
        });
    },
    [activeConnection, activeTabId, toast, onQueryExecute, setTabs, beginRun, refuseRun],
  );

  // Cancel running query (best-effort via ref flag)
  const cancelQuery = useCallback(() => {
    cancelledRef.current = true;

    setTabs((prev) =>
      prev.map((t) =>
        // A PAGING TAB IS A RUNNING TAB, and reading `isExecuting` alone missed it.
        //
        // The gap predates this PR, and the claim write in `handleLoadMore` did not create
        // it: at the merge base (474c2e3e) this arm already read `isExecuting` alone, and
        // that claim already wrote nothing but `isLoadingMore: true`, so a tab fetching a
        // page carried the `isExecuting: false` its previous run had settled and was
        // skipped here exactly the same way. The claim now writing that flag explicitly
        // only put into the source a value the tab already held.
        //
        // What the gap cost, then and now: Cancel skipped the one tab the user had just
        // cancelled. The page then landed, its success arm refused itself on the flag set
        // above, and nothing was left to clear `isLoadingMore` - so Load More, which is
        // `disabled={isLoadingMore}` in `StatsBar`, stayed dead until the next Run happened
        // to clear it. Reading both flags is what makes Cancel reach a paging tab (#816).
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
  const handleLoadMore = useCallback(() => {
    if (!currentTab.result?.pagination?.hasMore) return;
    if (!activeConnection) return;
    // Restates the condition the rendered control already enforces: the button that calls
    // this is `disabled={isLoadingMore}` in `StatsBar`, and the flag is wired end to end.
    // It reads render state rather than a ref, so it cannot be more than that - two calls
    // in the same tick would both read the value from before the claim below and both
    // pass. It is a second line behind the disabled control, not a replacement for it, and
    // a caller that renders no such control has to enforce the invariant itself (#816).
    if (currentTab.isLoadingMore) return;

    // The statement this page would re-run, checked here because paging calls the host itself and never re-enters
    // `executeQuery`.
    const pageRefusal = statementRefusal(currentTab.resultQuery ?? currentTab.query, activeConnection.type);
    if (pageRefusal !== undefined) {
      refuseRun(currentTab.id, pageRefusal);
      return;
    }

    // The same reset `executeQuery`, `forceExecuteQuery` and `handleUnlimitedQuery` make,
    // and for the same reason: `cancelledRef` is one sticky hook-wide boolean, and a page
    // is an entry point too. Left set by an earlier Cancel it would make this page refuse
    // its own commit, leaving `isLoadingMore` set - which the guard above then reads as a
    // page still in flight, so one Cancel disabled Load More for good (#816).
    cancelledRef.current = false;
    const ownsTab = beginRun(currentTab.id);
    const currentOffset = currentTab.currentOffset || currentTab.result.rows.length;

    setTabs((prev) =>
      prev.map((t) =>
        t.id === currentTab.id
          ? {
              ...t,
              // Claiming the tab takes over BOTH flags, in one write, exactly as the
              // standalone does it (`isExecuting: !isLoadMore, isLoadingMore: isLoadMore`).
              // A Run still in flight set `isExecuting: true`, and the ownership check
              // below now refuses its settle, so it can no longer clear that flag itself:
              // without this the tab shows a spinner and a CANCEL button for a run it has
              // already disowned, until this page's own commit happens to clear a flag the
              // page never set (#816).
              isExecuting: false,
              isLoadingMore: true,
            }
          : t,
      ),
    );

    // The next page of the statement that built this grid, not of whatever has been typed
    // since - the editor buffer is rewritten on every keystroke.
    //
    // Read once, here, and carried into the commit below. Reading it again when the page
    // arrives would label these rows with whatever statement had started in the meantime.
    // The ownership check in that commit answers the other half of the same failure: it
    // refuses a page the tab has since disowned, and pinning the statement here keeps the
    // label true for a page that still owns it and does land (#816).
    const pagedStatement = currentTab.resultQuery ?? currentTab.query;

    onQueryExecute(activeConnection.id, pagedStatement, {
      // The size of the page already on screen, not a constant. A table preview is 50
      // rows and a hand-run statement is 500, and a hardcoded 500 made the second page
      // ten times the first while the footer's own label promised 500 either way (#816).
      limit: currentTab.result.pagination.limit,
      offset: currentOffset,
    })
      .then((result) => {
        // A Run started while this page was in flight owns the tab now, and this page is
        // a page of a statement the grid no longer shows. Appending it would leave the
        // tab holding rows from two statements while naming one, and rewrite
        // `resultQuery` to the paged one (#881's class). The host owns the fetch, so
        // there is nothing to abort - refusing the write is the whole guard.
        if (cancelledRef.current || !ownsTab()) return;

        setTabs((prev) =>
          prev.map((t) => {
            if (t.id !== currentTab.id) return t;

            const existingRows = t.allRows || t.result?.rows || [];
            const newAllRows = [...existingRows, ...result.rows];

            return {
              ...t,
              result: {
                rows: newAllRows,
                // THE SHAPE COMES FROM THE ROWS ON SCREEN, NOT FROM THE PAGE THAT ARRIVED.
                //
                // A page of the same statement cannot legitimately name different columns,
                // and an empty page often names none at all: SQLite answers `... LIMIT 50
                // OFFSET 100` on a hundred-row table with `rows: 0, fields: []`. Taking the
                // page's own list left the grid holding its hundred rows under zero columns
                // - the strip read "100 rows / 0 columns" and the table rendered
                // header-less, cell-less stripes. The standalone hook carries the same
                // guard, for the same reason (#816).
                fields: result.fields.length > 0 ? result.fields : (t.result?.fields ?? []),
                rowCount: newAllRows.length,
                executionTime: t.result?.executionTime || 0,
                pagination: result.pagination,
                // The first-page commit above carries these, and this one did not: a
                // paged result silently lost the engine warnings and the declared column
                // types the first page had shown (#285's class, on the paging path).
                ...carriedChannels(result, t.result),
              },
              resultQuery: pagedStatement,
              allRows: newAllRows,
              currentOffset: currentOffset + result.rows.length,
              isExecuting: false,
              isLoadingMore: false,
            };
          }),
        );
      })
      .catch((error) => {
        // Same ownership rule on the failure arm: a page nobody is waiting for must not
        // clear the new run's flags or raise a toast about itself.
        if (cancelledRef.current || !ownsTab()) return;

        setTabs((prev) =>
          prev.map((t) =>
            t.id === currentTab.id
              ? {
                  ...t,
                  isExecuting: false,
                  isLoadingMore: false,
                }
              : t,
          ),
        );

        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        toast({ title: "Load More Error", description: errorMessage, variant: "destructive" });
      });
  }, [currentTab, activeConnection, onQueryExecute, setTabs, toast, beginRun, refuseRun]);

  // Unlimited query handler
  const handleUnlimitedQuery = useCallback(() => {
    if (!pendingUnlimitedQuery) return;
    if (!activeConnection) return;

    const { query, tabId } = pendingUnlimitedQuery;

    const refusal = statementRefusal(query, activeConnection.type);
    if (refusal !== undefined) {
      refuseRun(tabId, refusal);
      setUnlimitedWarningOpen(false);
      setPendingUnlimitedQuery(null);
      return;
    }

    cancelledRef.current = false;
    const ownsTab = beginRun(tabId);

    // The same claim rule as `executeQuery` and `forceExecuteQuery`, for the same reason:
    // `beginRun` above disowns a page in flight, a disowned page may not write, and so it
    // can no longer clear the `isLoadingMore: true` it set itself. Without this write the
    // tab spins a Load More over a page whose rows will never be shown, and the control is
    // `disabled={isLoadingMore}` in `StatsBar`, so it stays dead until some later run
    // settles the flag (#816).
    //
    // Nothing in `src/` opens the unlimited warning or sets a pending query today, in
    // either product, so there is no click that reaches this claim: do not go looking for
    // the repro. It is fixed and covered anyway, because the hook exports the handler and
    // the dialog wired to it is already rendered in both products, so the day something
    // sets a pending query this becomes the fourth live claim on a tab.
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? {
              ...t,
              isExecuting: true,
              isLoadingMore: false,
            }
          : t,
      ),
    );

    onQueryExecute(activeConnection.id, query, { unlimited: true })
      .then((result) => {
        if (cancelledRef.current || !ownsTab()) return;

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
                // The other three paths carry these and this one did not: an unlimited run
                // dropped the host's warnings and declared types (#285's class), and would
                // have dropped its vector columns.
                ...carriedChannels(result),
              },
              // The rows and the statement that fetched them are committed together, the way
              // `use-query-execution` does it: a reader of one must never be handed the other's
              // (#881). Inline editing is off in this surface, so the wrong-table WRITE cannot
              // happen here - a tab holding rows from two tables while naming one still can.
              resultQuery: query,
              allRows: result.rows,
              currentOffset: result.rows.length,
              isExecuting: false,
              isLoadingMore: false,
              runError: undefined,
            };
          }),
        );

        setHistoryKey((prev) => prev + 1);
        maybeInviteToStar();
      })
      .catch((error) => {
        if (cancelledRef.current || !ownsTab()) return;

        // Replaces the previous result, for the reason the catch in `executeQuery` states.
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  result: null,
                  resultQuery: undefined,
                  allRows: undefined,
                  currentOffset: 0,
                  runError: errorMessage,
                  isExecuting: false,
                  isLoadingMore: false,
                }
              : t,
          ),
        );

        toast({ title: "Query Error", description: errorMessage, variant: "destructive" });
      });

    setUnlimitedWarningOpen(false);
    setPendingUnlimitedQuery(null);
  }, [pendingUnlimitedQuery, activeConnection, onQueryExecute, setTabs, toast, beginRun, refuseRun]);

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
