"use client";

import { appFetch } from "@/lib/config/base-path";
import { useState, useEffect, useCallback, useRef, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { DatabaseConnection, QueryTab } from "@/lib/types";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import type { QueryEditorRef } from "@/components/QueryEditor";
import type { BottomPanelMode } from "@/components/studio/BottomPanel";
import { useToast } from "@/hooks/use-toast";
import { storage } from "@/lib/storage";
import { isDangerousQuery } from "@/components/QuerySafetyDialog";
import { consoleTextByteLimit, statementRefusal } from "@/lib/db/destructive-commands";
import { countCodeStatements, isMultiStatement } from "@/lib/sql/statement-splitter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { hasUnterminatedSpan } from "@/lib/sql/spans";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { shouldRefreshSchema } from "@/lib/query-generators";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { logger } from "@/lib/logger";
import { newLocalId } from "@/lib/ids";
import { getExplainStrategy, type ExplainStrategy } from "@/lib/explain";
import type { ExplainFormat } from "@/lib/db/types";
import { maybeInviteToStar } from "@/lib/community/star-prompt-toast";
import { sandboxRefusal } from "@/lib/editor/sandbox-refusal";
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
  /**
   * Handed the message of a run that failed: the refusal, the engine's error, the statement a
   * script stopped at, or the SANDBOX transaction that could not be opened, the same text the tab
   * or the toast shows. A dialog that ran a statement for the user keeps itself open and shows it
   * there (#1396), where the toast fades and the results panel sits under the dialog.
   *
   * Not called for a run that did not fail, nor for one that did not fail AT ALL: a run handed to
   * the safety dialog (which runs it on Proceed, through `forceExecuteQuery`), a cancel, or a run a
   * newer one superseded. Those resolve `false` with no message, and a caller that keeps a dialog
   * open on a failure must tell them apart by that: the import dialog closes for them, so the
   * statement the safety dialog runs is never offered a second time.
   */
  onFailure?: (message: string) => void;
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
  /**
   * Tell the object tree its catalog changed (#789).
   *
   * Separate from `fetchSchema`, and the split is not cosmetic: `fetchSchema` re-reads the
   * flat inventory the diagram, the profiler and the modals draw from, while the tree holds
   * its OWN lazy cache of counts and listings that nothing else can reach. Both are driven by
   * the same `schemaRefreshPattern`, and until this existed only the first one was refreshed.
   */
  onObjectsChanged?: () => void;
  /**
   * The server ended the open transaction while running a statement in it: a typed COMMIT or
   * ROLLBACK, or a statement the engine commits implicitly. The route answers `inTransaction: false`
   * and the BEGIN/COMMIT/ROLLBACK controls must stop offering a transaction that is gone.
   */
  onTransactionEnded?: () => void;
  queryEditorRef: RefObject<QueryEditorRef | null>;
}

/**
 * Whether a SANDBOX rollback answer confirms that the rollback happened. Only a 2xx
 * does; a fetch that threw never reached the route and is not an answer either.
 */
async function rollbackConfirmed(request: Promise<Response>): Promise<boolean> {
  try {
    return (await request).ok;
  } catch {
    return false;
  }
}

/**
 * The one toast for a cancel the server did not confirm (#1364).
 *
 * Aborting the request only stops this tab waiting: the statement is the engine's, and only
 * `POST /api/db/cancel` answering `cancelled: true` says the engine stopped it. Every other
 * outcome (`cancelled: false`, a refusal such as "not supported for this database type", a
 * route that cannot be reached) used to show "Query Cancelled" too, while CockroachDB,
 * Materialize, RisingWave, ClickHouse and SQLite kept running the statement. `false` also
 * covers a statement that ended just before the cancel reached it, which the server cannot
 * tell apart, so the wording admits both.
 */
const CANCEL_NOT_CONFIRMED = {
  title: "Cancel Not Confirmed",
  description:
    "The database did not confirm the cancel, so the statement may still be running there. It may also have finished just before the cancel arrived.",
  variant: "destructive" as const,
};

/**
 * Cancel where the provider has no cancel at all (`supportsQueryCancel: false`): the control
 * reads "Stop waiting" there, and this is what it did (#1364). The cancel route would only
 * answer 400, so nothing is sent.
 */
const STOPPED_WAITING = {
  title: "Stopped Waiting",
  description:
    "Studio stopped waiting for the result. This database cannot cancel a running statement, so it keeps running on the server until it ends.",
  variant: "destructive" as const,
};

/**
 * Cancel of a run that has no id on the server: a multi-statement script
 * (`/api/db/multi-query`) or a statement inside a transaction or SANDBOX
 * (`/api/db/transaction`). Neither route hands the provider a `queryId`, so the cancel route
 * could only answer `false`; this says why instead of "not confirmed".
 */
const RUN_NOT_CANCELLABLE = {
  title: "Stopped Waiting",
  description:
    "A multi-statement script or a statement inside a transaction cannot be cancelled on the server, so it keeps running there until it ends.",
  variant: "destructive" as const,
};

/** Whether one `POST /api/db/cancel` answer says the engine stopped the statement. */
async function cancelConfirmed(response: Response): Promise<boolean> {
  if (!response.ok) return false;
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && (body as { cancelled?: unknown }).cancelled === true;
  } catch {
    return false;
  }
}

/** What the user is told when a SANDBOX run's changes were NOT rolled back. */
const SANDBOX_NOT_ROLLED_BACK = {
  title: "Not Rolled Back",
  variant: "destructive" as const,
};

/**
 * Why an explain run cannot proceed, phrased for the user. Absent metadata means
 * "not loaded yet", not "unsupported" — blaming the database type there would be
 * misleading.
 */
function explainRefusal(metadata: ProviderMetadata | null, hasStrategy: boolean, oneStatement: boolean) {
  if (!metadata) {
    return { title: "Not Ready", description: "Connection metadata is still loading. Try again in a moment." };
  }
  if (hasStrategy && metadata.capabilities.supportsExplain) {
    if (!oneStatement) return { title: "Not Supported", description: "Only a single statement can be explained." };
    return { title: "Not Supported", description: "Only SELECT statements can be explained." };
  }
  return { title: "Not Supported", description: "EXPLAIN is not available for this database type." };
}

/**
 * Which strategy reads a plan the server just answered.
 *
 * The EXPLAIN statement is built on the server now (#574), so the response names
 * the format that really produced the plan and that naming wins: on the MySQL wire
 * family the provider only learns which form its server accepts once connected
 * (measured 2026-09-06: `EXPLAIN FORMAT=JSON SELECT 1` is errno 1105 on TiDB v8.5.1
 * and Apache Doris 4.1.3, errno 1064 on StarRocks 3.3.22 and SingleStore, while a
 * plain `EXPLAIN SELECT 1` is accepted on every one of them), and provider-meta
 * answers this hook without connecting at all (#457).
 *
 * The static strategy stays as the fallback for the two cases where the response
 * says nothing usable: an older server that names no format, and a format this build
 * does not register.
 */
function planStrategy(payload: unknown, fallback: ExplainStrategy): ExplainStrategy {
  const named =
    typeof payload === "object" && payload !== null
      ? (payload as { explainFormat?: unknown }).explainFormat
      : undefined;
  if (typeof named !== "string") return fallback;
  // `getExplainStrategy` indexes an object literal, so an inherited key such as
  // "constructor" resolves to a value that is truthy and is not a strategy. Every
  // registered strategy names itself, so that identity is the guard.
  const namedStrategy = getExplainStrategy(named as ExplainFormat);
  return namedStrategy?.format === named ? namedStrategy : fallback;
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

/**
 * The connection half of ONE RUN's request body, plus the database its tab belongs to.
 *
 * A TOP-LEVEL FIELD RATHER THAN A FIELD OF THE CONNECTION, and that is the whole of this function. A
 * run's connection is expressed two ways on the wire: a user's own saved connection travels as a
 * full object, and a managed one travels as an id (`{ connectionId: "seed:..." }`) that the server
 * resolves from the OPERATOR's config — discarding any connection field the caller attached, by
 * design (GHSA-3wh2-8x78). So a `database` merged into the connection object is dropped for every
 * managed connection, and the read would run in the session's database while the key tab claims it
 * read another. As a field beside the connection it survives the resolve, and `POST /api/db/query`
 * applies it after resolving: same field, same meaning as `POST /api/db/keys/scan`.
 *
 * `undefined` is NOT database 0 and NOT "the session's number": it is the absence of an override, so
 * the body is byte for byte what it was before this existed.
 */
function payloadForRun(connection: DatabaseConnection, database: number | undefined): Record<string, unknown> {
  const payload = buildConnectionPayload(connection);
  return database === undefined ? payload : { ...payload, database };
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
  onObjectsChanged,
  onTransactionEnded,
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
  const runsRef = useRef(
    new Map<
      string,
      {
        controller: AbortController;
        queryId: string;
        planQueryId: string | undefined;
        /** Whether the run went to the one route that hands the provider its `queryId`. */
        serverCancellable: boolean;
      }
    >(),
  );

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
   * (#422). This map is never cleared per run, so it answers for that
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
  const [bottomPanelMode, setBottomPanelMode] = useState<BottomPanelMode>("results");

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
  /**
   * Runs one statement against the active connection and writes the outcome into the
   * target tab.
   *
   * Returns whether the statement ran and the engine accepted it. Every failure is
   * still reported here — the toast, the tab flags and the history entry are unchanged
   * — but the answer is now handed back as well, because a caller running statements in
   * a loop cannot see a toast. Applying inline grid edits ran that loop and reported
   * "Changes Applied" whatever happened, dropping the user's pending edits after a write
   * the engine had refused (#882). `false` covers every way a run can fail to land: no
   * connection, the safety dialog taking over, an unsupported EXPLAIN, a cancellation,
   * a thrown request, and a multi-statement run the engine reported an error for.
   */
  const executeQuery = useCallback(
    async (
      overrideQuery?: string,
      tabId?: string,
      isExplain: boolean = false,
      executionOptions?: QueryExecutionOptions,
    ): Promise<boolean> => {
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
        return false;
      }

      // A statement this connection type's editor refuses never becomes a request and never enters history. The
      // check runs before the confirmation gate and before every condition that Proceed (`skipSafety`), an explain
      // run, a page (`offset`) or playground mode skips, so none of those paths can carry it to a route. It counts as
      // the tab's newest run: a run still in flight there is superseded, as a new run supersedes it, so its late
      // answer cannot land over the refusal.
      //
      // SANDBOX adds its own refusal on the same terms: a statement that would commit the
      // transaction SANDBOX is about to roll back (see `sandboxRefusal`). Asked only of a
      // run that will open that transaction, the same condition `isPlaygroundRun` reads below.
      const refusal =
        statementRefusal(queryToExecute, activeConnection.type) ??
        (playgroundMode && !transactionActive && !isExplain && !executionOptions?.offset
          ? sandboxRefusal(
              queryToExecute,
              resolveSqlGrammar(activeConnection.type),
              metadata?.capabilities.implicitCommitStatements,
              metadata?.capabilities.implicitCommitExceptions,
            )
          : undefined);
      if (refusal !== undefined) {
        runsRef.current.get(targetTabId)?.controller.abort();
        runsRef.current.delete(targetTabId);
        lastRunRef.current.set(targetTabId, `refused-${newLocalId()}`);
        setTabs((prev) =>
          prev.map((t) =>
            t.id === targetTabId
              ? {
                  ...t,
                  result: null,
                  resultQuery: undefined,
                  allRows: undefined,
                  currentOffset: 0,
                  runError: refusal,
                  isExecuting: false,
                  isLoadingMore: false,
                }
              : t,
          ),
        );
        toast({ title: "Statement Refused", description: refusal, variant: "destructive" });
        executionOptions?.onFailure?.(refusal);
        return false;
      }

      // The connection this run reaches, and the database it reads when the tab was opened in one: a
      // tab opened from a key browser walked ONE numbered database, so every run of that tab - the
      // initial read, a re-run, a selection, an inline edit, the next page - names it. See
      // `payloadForRun`.
      const runPayload = payloadForRun(activeConnection, tabToExec.databaseOverride);

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
        return false;
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
      // ask for a plan of a statement the dialect really explains, whether the
      // provider denies EXPLAIN outright, ships no strategy, or the statement is not
      // a SELECT. Sending it anyway would ask the server to execute e.g. an UPDATE
      // unguarded (#201).
      //
      // The refusal stays here even though the statement itself is now built on the
      // server (#574): a statement nothing can explain must not become a request at
      // all, so the user gets this toast rather than a 400.
      //
      // And only of ONE statement. An EXPLAIN prefixes one, so `EXPLAIN SELECT 1; INSERT
      // ...` explains the SELECT and then RUNS the INSERT: measured on Materialize 26.44.1,
      // AlloyDB Omni 17.9 and Cloudberry 2.1.0, a RUN of that text applied the INSERT twice
      // through its background plan request (#1311). Read under the connection's own
      // dialect, the same reading that sends a run to `/api/db/multi-query` below, and the
      // same count `POST /api/db/query` refuses an explain by. A fragment of comments only
      // is not counted: `SELECT 1; -- note` is one statement to explain, though the run
      // route below still splits it in two. A text with a run the grammar cannot close
      // is not one statement either: the splitter finds no boundary in it, yet
      // `SELECT E'\''; INSERT ...` is two statements to PostgreSQL.
      const grammar = resolveSqlGrammar(activeConnection.type);
      const oneStatement =
        countCodeStatements(queryToExecute, grammar) <= 1 && !hasUnterminatedSpan(queryToExecute, grammar);
      const explainSupported = !metadata || metadata.capabilities.supportsExplain;
      const explainAccepted =
        isExplain &&
        explainSupported &&
        oneStatement &&
        (explainStrategy?.buildSql(queryToExecute, "analyze") ?? null) !== null;
      if (isExplain && !explainAccepted) {
        toast({ ...explainRefusal(metadata, Boolean(explainStrategy), oneStatement), variant: "destructive" });
        setTabs((prev) =>
          prev.map((t) => (t.id === targetTabId ? { ...t, isExecuting: false, isLoadingMore: false } : t)),
        );
        return false;
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

      // Whether this run also asks for a plan in the background (SELECT only, one
      // statement only). Asked of the STATIC strategy, which is all this side has before
      // a response: whether a statement is explainable at all is a question about the
      // statement, and every strategy answers it the same way. The statement the engine
      // sees is built on the server (#574).
      //
      // The plan request gets an id of its own so Cancel can reach it on the server:
      // without one, measured on PostgreSQL 18.6, Cancel left the plan statement
      // `active` after the run's own backend went idle (#1311). Its own rather than the
      // run's, because a provider tracks one statement per id.
      const sendsPlan =
        !isExplain &&
        !isLoadMore &&
        oneStatement &&
        explainStrategy !== null &&
        explainStrategy.buildSql(queryToExecute, "estimate") !== null;
      const planQueryId = sendsPlan ? `${queryId}-plan` : undefined;
      const run = { controller: abortController, queryId, planQueryId, serverCancellable: false };
      runsRef.current.set(targetTabId, run);
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
          const beginRes = await appFetch("/api/db/transaction", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // SANDBOX is about to promise a rollback, so a server that never reports whether
            // a transaction is open is refused at BEGIN (Databend, StarRocks, Doris).
            body: JSON.stringify({ ...runPayload, action: "begin", requireReportedState: true }),
          });
          // No transaction, no SANDBOX run. This used to log and carry on, so the statement
          // ran unprotected and the toast still said it had been rolled back: measured on
          // RisingWave 3.1.0, whose BEGIN opens nothing, an INSERT and a DELETE stayed applied
          // (the DELETE without the confirmation dialog, which SANDBOX skips because it
          // promises a rollback).
          if (!beginRes.ok) {
            const answer = await beginRes.json().catch(() => ({}));
            const description =
              typeof answer?.error === "string" ? answer.error : "The transaction SANDBOX needs could not be opened.";
            commitToTab((t) => ({ ...t, isExecuting: false, isLoadingMore: false }));
            toast({
              title: "Sandbox Unavailable",
              // The server's sentence may or may not end in a period ("Transaction already active").
              description: `${/[.!?]$/.test(description) ? description : `${description}.`} Nothing was run.`,
              variant: "destructive",
            });
            executionOptions?.onFailure?.(description);
            return false;
          }
        }

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
        // keeps the pre-existing behaviour, since only a declared language is known
        // not to be SQL: JSON, and PromQL since #1085, whose single expression the
        // splitter would cut at a `;` inside a `#` comment exactly as it cut Redis's.
        // A type whose vocabulary row declares a console text bound is never SQL, and that declaration is static,
        // so it holds while the metadata above is still null, the window in which the default of "sql" would send
        // one console text to the splitter.
        const dialectIsSql =
          consoleTextByteLimit(activeConnection.type) === undefined &&
          (metadata?.capabilities.queryLanguage ?? "sql") === "sql";
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
          // disagrees about is a fragment the route RUNS (S1). The same record says where a
          // procedural body holds its `;` and which line is a script separator (#1312), so a
          // PL/SQL unit alone stays on the single-statement route and one followed by `/`
          // goes to the route that strips the `/`.
          isMultiStatement(queryToExecute, grammar);

        // Use transaction endpoint if a transaction is active or in playground mode. It is sent the
        // text whole and splits a script itself, running each statement on the transaction's
        // connection (#1390), so the splitter above is not asked here.
        const useTransaction = (transactionActive || isPlaygroundRun) && !isExplain;

        // Start both queries in parallel (main query + background explain)
        const queryEndpoint = useTransaction
          ? "/api/db/transaction"
          : useMultiQuery
            ? "/api/db/multi-query"
            : "/api/db/query";
        // Only this route carries the run's `queryId` to the provider (see the body below).
        run.serverCancellable = queryEndpoint === "/api/db/query";
        const mainQueryPromise = appFetch(queryEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...runPayload,
            // The parameter array travels beside the SQL on whichever endpoint the
            // statement takes, and only when the caller supplied one: a request
            // without values must stay a request without a `params` key (#290).
            ...(params && { params }),
            ...(useTransaction
              ? { action: "query", sql: queryToExecute, options: { limit, offset, unlimited } }
              : {
                  // The user's own statement, always: an explain run asks for a
                  // plan of it with `explain`, and the connected provider builds
                  // the EXPLAIN on the server (#574).
                  sql: queryToExecute,
                  options: isExplain ? {} : { limit, offset, unlimited },
                  ...(isExplain && { explain: { mode: "analyze" } }),
                  ...(!useMultiQuery && { queryId }),
                }),
          }),
          signal: abortController.signal,
        });

        // Run EXPLAIN in background for non-explain queries (one SELECT only, see
        // `sendsPlan`). It asks for the `estimate`, which plans without executing: the
        // run itself is the execution, and a second one is a second write (#1311).
        //
        // Typed as `Response | null` because its rejection is handled at creation
        // (below), not where it is consumed: the consumer only runs after the main
        // query settles, and a plan request that fails first — or is aborted with
        // its run — would be an unhandled rejection until then.
        let explainPromise: Promise<Response | null> | null = null;
        if (sendsPlan) {
          explainPromise = appFetch("/api/db/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...runPayload,
              sql: queryToExecute,
              options: {},
              explain: { mode: "estimate" },
              queryId: planQueryId,
              // The server prefixes the statement to build the EXPLAIN, so its
              // placeholders are the same ones in the same order and the same
              // values bind them. Without this the plan request would run
              // unbound and the panel would keep the previous plan (PR #304).
              ...(params && { params }),
            }),
            // The plan belongs to this run, so it dies with it. Without the
            // signal, cancelling the query (or unmounting the studio) leaves
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

        const response = await mainQueryPromise;

        const endTime = Date.now();
        const executionTime = endTime - startTime;

        if (!response.ok) {
          const error = await response.json();
          const errorCode = error.code as string | undefined;
          // A 429's own body may say nothing about the wait, but its header always
          // carries one — name it, so the user retries when the budget is back instead
          // of hammering a closed door (#459). Only the 429 is rephrased:
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
            ...(isExplain && { kind: "explain" as const }),
            errorMessage,
          });

          // Handle query cancellation via response code
          if (errorCode === ApiErrorCode.QUERY_CANCELLED) {
            commitToTab((t) => ({ ...t, isExecuting: false, isLoadingMore: false }));
            toast({ title: "Query Cancelled", description: "Query execution was cancelled." });
            return false;
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
            // An EXPLAIN's rows are the plan's, not the statement's (#1447).
            ...(isExplain ? { kind: "explain" as const } : { rowCount: resultData.rowCount }),
            errorMessage: resultData.hasError
              ? resultData.statements?.find((s: { status: string }) => s.status === "error")?.error
              : undefined,
          });
          setHistoryKey((prev) => prev + 1);
        }

        /**
         * A statement that opened a transaction and did not finish it has had it rolled back by
         * the server, because the connection handle is shared and an unfinished transaction would
         * otherwise reach the next person to use it (D71, D87). The author is told either way:
         * before this, the work simply vanished.
         *
         * ON BOTH PATHS, and it was on neither but the script one until D87. `/api/db/query`
         * gained the same `openTransaction` field when the ender learned to name the caller's own
         * call scope, and the route's own comment claimed the client rendered it "from the field's
         * presence alone". MEASURED FALSE: the notice lived inside the `multiStatement` branch, and
         * a single statement never sets that flag. So a reader who typed a lone `BEGIN` had it
         * silently rolled back and their next statement autocommitted instead of joining the
         * transaction they had asked for, which is exactly the harm this notice exists to prevent.
         */
        // THE KEYWORD IS THE ENGINE'S, not SQL's. This sentence said "Add COMMIT" while the only
        // caller of the ender was a SQL script route. D74 gave the single-statement route the same
        // `finally`, and `redis` implements the surface, so the notice now reaches a reader whose
        // open transaction is a `MULTI` and whose keyword is `EXEC`. Naming the wrong one tells
        // them to type a command their engine does not have.
        const keepKeyword = activeConnection.type === "redis" ? "EXEC" : "COMMIT";
        const transactionNotice =
          resultData.openTransaction === "rolled-back"
            ? ` This left a transaction open and it was rolled back, so its changes were discarded. Add ${keepKeyword} to keep them.`
            : "";

        // A lone statement gets no summary toast of its own, so the notice is the whole message:
        // raised only when there IS something to say, never as a toast about an ordinary success.
        if (!resultData.multiStatement && transactionNotice !== "") {
          toast({
            title: "Transaction rolled back",
            description: transactionNotice.trim(),
          });
        }

        // A script that stopped on an error is also written on the tab, so the panel keeps saying so
        // after the toast has gone (#1385). The rows that stay are the earlier statements' own.
        let scriptFailure: string | undefined;

        // Show multi-statement summary
        if (resultData.multiStatement) {
          const { executedCount, statementCount, hasError } = resultData;
          if (hasError) {
            const errorStmt = resultData.statements?.find((s: { status: string }) => s.status === "error");
            const stmtText = typeof errorStmt?.sql === "string" ? errorStmt.sql.replace(/\s+/g, " ").trim() : "";
            // By code points, so an emoji is never cut in half.
            const stmtChars = Array.from(stmtText);
            const excerpt = stmtChars.length > 80 ? `${stmtChars.slice(0, 80).join("")}...` : stmtText;
            scriptFailure =
              `Statement ${errorStmt?.index + 1} of ${statementCount} failed: ${errorStmt?.error}` +
              (excerpt === "" ? "" : `\n${excerpt}`) +
              // Its own line, and without the "Add COMMIT to keep them" advice of the toast: after a
              // failure there is nothing complete to keep.
              (resultData.openTransaction === "rolled-back"
                ? "\nThe open transaction was rolled back, so its changes were discarded."
                : "");
            toast({
              title: `Executed ${executedCount - 1}/${statementCount} statements`,
              description: `Error in statement ${errorStmt?.index + 1}: ${errorStmt?.error}${transactionNotice}`,
              variant: "destructive",
            });
          } else {
            toast({
              title: `${executedCount} statements executed`,
              description: `All ${statementCount} statements completed in ${resultData.executionTime}ms.${transactionNotice}`,
            });
          }
        }

        // Process EXPLAIN results (from background or direct)
        let explainPlanData = null;
        if (isExplain) {
          if (explainStrategy) {
            const strategy = planStrategy(resultData, explainStrategy);
            explainPlanData = { format: strategy.format, raw: strategy.extractPlan(resultData) };
          }
        } else if (explainPromise && explainStrategy) {
          // Background EXPLAIN - don't block, update async
          explainPromise
            .then(async (explainRes) => {
              if (!explainRes?.ok) return;
              const explainData = await explainRes.json();
              const strategy = planStrategy(explainData, explainStrategy);
              const plan = { format: strategy.format, raw: strategy.extractPlan(explainData) };
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
              // The page appended here is what this run fetched, so the tab names it for
              // the same reason the replace branch does: a reader of the rows must never
              // be handed a different statement's name for them.
              resultQuery: queryToExecute,
              result: {
                ...resultData,
                // THE SHAPE COMES FROM THE ROWS ON SCREEN, NOT FROM THE PAGE THAT ARRIVED.
                //
                // A page of the same statement cannot legitimately name different columns,
                // and an empty page often names none at all: SQLite answers `... LIMIT 50
                // OFFSET 100` on a hundred-row table with `rows: 0, fields: []`. Spreading
                // that over the tab left the grid holding its hundred rows under zero
                // columns - the strip read "100 rows / 0 columns" and the table rendered
                // header-less, cell-less stripes. A table whose size is an exact multiple
                // of the page size reaches that state in one click.
                fields: resultData.fields.length > 0 ? resultData.fields : t.result.fields,
                // The vector declaration describes those rows too, so a page that declares none keeps theirs, as
                // the embedded adapter's load-more does (`carriedChannels` in `use-query-adapter.ts`).
                ...((resultData.vectorColumns ?? t.result.vectorColumns) !== undefined && {
                  vectorColumns: resultData.vectorColumns ?? t.result.vectorColumns,
                }),
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
            // The rows and the statement that fetched them are committed together, so a
            // reader of one can never be handed the other's (#881). An EXPLAIN leaves the
            // results alone, so it leaves this alone too.
            resultQuery: isExplain ? t.resultQuery : queryToExecute,
            allRows: isExplain ? t.allRows : resultData.rows,
            currentOffset: isExplain ? t.currentOffset : resultData.rows.length,
            isExecuting: false,
            isLoadingMore: false,
            explainPlan: explainPlanData || t.explainPlan,
            // A run that landed answers the failure before it. An EXPLAIN leaves the
            // results panel alone, so it leaves that panel's error alone too. A script that
            // stopped on an error keeps the earlier statements' rows AND says it stopped (#1385).
            runError: isExplain ? t.runError : scriptFailure,
          };
        });

        // The server ended the transaction inside this run, so there is nothing left to roll back.
        // The OUTCOME is not known here and is not claimed: a COMMIT or an implicitly committing
        // statement kept the work, a ROLLBACK (or a COMMIT of a failed PostgreSQL transaction)
        // discarded it, and the server reports the same idle state after either.
        const transactionEnded = useTransaction && resultData.inTransaction === false;
        if (transactionEnded && !isPlaygroundRun) {
          onTransactionEnded?.();
          toast({
            title: "Transaction Ended",
            description:
              "The database ended the transaction while running this statement (a COMMIT, a ROLLBACK, or a statement it commits implicitly). Check what was kept.",
            variant: "destructive",
          });
        }

        // Playground mode: auto-rollback after getting results, and say it only when it happened.
        if (isPlaygroundRun) {
          if (transactionEnded) {
            toast({
              ...SANDBOX_NOT_ROLLED_BACK,
              description:
                "The database ended the transaction while running this statement (a COMMIT, a ROLLBACK, or a statement it commits implicitly), so SANDBOX could not roll it back. Check what was kept.",
            });
          } else if (
            await rollbackConfirmed(
              appFetch("/api/db/transaction", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...runPayload, action: "rollback" }),
              }),
            )
          ) {
            // Recorded on the result the grid shows, only because the server confirmed it: the
            // grid says "rolled back" about THIS run, never about the toggle's current state (#1425).
            commitToTab((t) => (t.result ? { ...t, result: { ...t.result, rolledBack: true } } : t));
            toast({
              title: "Playground",
              description: "Changes auto-rolled back. No data was modified.",
            });
          } else {
            logger.warn("Playground transaction rollback failed", { route: "use-query-execution" });
            toast({
              ...SANDBOX_NOT_ROLLED_BACK,
              description: "The rollback was not confirmed by the server, so the changes may have been kept.",
            });
          }
        }

        // Refresh schema after DDL/write operations (pattern from provider capabilities)
        // Skip schema refresh in playground mode since changes are rolled back, unless the server
        // committed them anyway: then the catalog did change and the tree has to say so.
        if (!isExplain && (!isPlaygroundRun || transactionEnded) && metadata) {
          if (shouldRefreshSchema(queryToExecute, metadata.capabilities.schemaRefreshPattern)) {
            fetchSchema(activeConnection);
            // The tree's cache is its own and nothing else can reach it, so the same statement
            // that re-reads the inventory has to say so here too.
            onObjectsChanged?.();
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
        if (scriptFailure !== undefined) executionOptions?.onFailure?.(scriptFailure);

        // The run reached the engine and the engine accepted it. `hasError` is the
        // multi-statement path's own signal — the request succeeds while one of the
        // statements inside it did not — so it is the same answer, not a separate one.
        //
        // A SUPERSEDED run reports false whatever the engine said. `commitToTab` dropped
        // its result, so nothing it did is on screen, and a caller counting applied rows
        // would otherwise count one the user never sees.
        return !resultData.hasError && !isSuperseded();
      } catch (error) {
        // Playground mode: rollback on error too. A statement that failed may still have
        // changed something first (a multi-statement text), so an unconfirmed rollback is
        // reported here as well rather than only logged.
        if (isPlaygroundRun) {
          const rolledBack = await rollbackConfirmed(
            appFetch("/api/db/transaction", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...runPayload, action: "rollback" }),
            }),
          );
          if (!rolledBack) {
            logger.warn("Playground transaction rollback failed", { route: "use-query-execution" });
            toast({
              ...SANDBOX_NOT_ROLLED_BACK,
              description: "The rollback was not confirmed by the server, so any changes may have been kept.",
            });
          }
        }
        // A superseded run must not clear the flags the newer run just set: the
        // spinner belongs to the query that is still running.
        commitToTab((t) => ({ ...t, isExecuting: false, isLoadingMore: false }));

        // Don't show error toast for user-initiated cancellation
        if (error instanceof DOMException && error.name === "AbortError") {
          // Nothing to say here. A Cancel is reported by `cancelQuery` once the server has
          // answered, since this abort stops nothing on the engine (#1364). Superseding is not
          // cancelling: the user asked for another query, not to be told this one stopped.
          // The one other abort is the studio unmounting, with nobody left to tell.
          return false;
        }

        // A LOST PAGE IS NOT A LOST QUERY (#816). Under the generic title the user reads
        // their own statement as having failed, when the rows on screen are intact and
        // only the next page did not arrive. `use-query-adapter.ts` raises the same
        // wording for the same failure, so the standalone app and the embedded workspace
        // say one thing.
        const title = isLoadMore ? "Load More Error" : "Query Error";
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        // NO MESSAGE CHECK FOR A CANCEL. Both real cancellations are caught before this by
        // structure: the fetch's own AbortError above, and the server's 499 `QUERY_CANCELLED`,
        // which every provider's cancel maps to, where the response is read. A check for the
        // word "cancelled" here also caught `column "cancelled" does not exist` and kept the
        // previous statement's rows under it.
        // A FAILED RUN IS NOT A RUN OF THE ROWS ON SCREEN. A new run that fails replaces the
        // previous result with its error, because leaving those rows up broke the invariant
        // the replace branch keeps (#881): the grid, export and inline edit went on acting on
        // the previous statement's rows while the editor showed the one that failed, and the
        // toast that said so fades. A failed page keeps its rows, for the reason above, and an
        // EXPLAIN never owned the results. `commitToTab` drops the write for a superseded run.
        if (!isLoadMore && !isExplain) {
          commitToTab((t) => ({
            ...t,
            result: null,
            resultQuery: undefined,
            allRows: undefined,
            currentOffset: 0,
            runError: errorMessage,
          }));
        }
        toast({ title, description: errorMessage, variant: "destructive" });
        executionOptions?.onFailure?.(errorMessage);
        return false;
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
    [
      activeConnection,
      toast,
      fetchSchema,
      onObjectsChanged,
      onTransactionEnded,
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
   * Run a statement an agent run handed to this editor (#329, see the "Handing the
   * answer to the editor (auto-execute)" section of `docs/AGENT.md`; reshaped by the
   * #373 review).
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
        const response = await appFetch(`/api/agent/runs/${encodeURIComponent(runId)}/handover`, { method: "POST" });
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

      // The abort's own `AbortError` branch says nothing: the toast below waits for the
      // server's answer, because the abort stops nothing but this tab's wait for the response.
      run.controller.abort();

      // Nothing on the server can be asked: say what the abort did, and that the statement
      // goes on. Asked of the declared capability first, so a provider with no cancel at
      // all is not posted a cancel it can only refuse.
      if (metadata?.capabilities.supportsQueryCancel === false) {
        toast(STOPPED_WAITING);
        return;
      }
      if (!run.serverCancellable) {
        toast(RUN_NOT_CANCELLABLE);
        return;
      }

      // Shown at once and replaced by the verdict: a cancel the server has to confirm can
      // take seconds (a wire-protocol cancel waits up to 3 s for the run to end).
      const pending = toast({ title: "Cancelling...", variant: "loading" });

      // Also cancel on the server side: aborting the fetch drops the response,
      // it does not stop the statement the engine is still executing. That holds for
      // the run's background plan request as much as for the run, so both are named
      // (#1311).
      //
      // Only the RUN's answer decides what the user is told (#1364). The plan request has
      // usually finished long before a Cancel, and its `cancelled: false` then means
      // "nothing left to stop", not "still running". The tab stops showing the run as
      // executing either way, since nothing here is waiting for it any more; the toast is
      // what says whether the engine is.
      let confirmed = false;
      if (activeConnection) {
        const connection = buildConnectionPayload(activeConnection);
        const ids = run.planQueryId === undefined ? [run.queryId] : [run.queryId, run.planQueryId];
        try {
          const [runAnswer] = await Promise.all(
            ids.map((queryId) =>
              appFetch("/api/db/cancel", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...connection, queryId }),
              }),
            ),
          );
          confirmed = await cancelConfirmed(runAnswer);
        } catch {
          logger.warn("Query cancellation request failed", { route: "use-query-execution" });
        }
      }
      toast({
        ...(confirmed
          ? { title: "Query Cancelled", description: "Query execution was cancelled." }
          : CANCEL_NOT_CONFIRMED),
        id: pending,
      });
    },
    [activeConnection, metadata, toast],
  );

  // Load More handler
  const handleLoadMore = useCallback(() => {
    if (!currentTab.result?.pagination?.hasMore) return;
    // Restates the condition the rendered control already enforces: the button that calls
    // this is `disabled={isLoadingMore}` in `StatsBar`, and the flag is wired end to end.
    // It reads render state rather than a ref, so it cannot be more than that - two calls
    // in the same tick would both read the value from before `executeQuery` claims the
    // tab and both pass. It is a second line behind the disabled control, not a
    // replacement for it, and a caller that renders no such control has to enforce the
    // invariant itself (#816).
    if (currentTab.isLoadingMore) return;

    const currentOffset = currentTab.currentOffset || currentTab.result.rows.length;
    // The next page of the STATEMENT THAT BUILT THIS GRID, not of whatever has been typed
    // since. The editor buffer is rewritten on every keystroke, and a run takes the
    // editor's effective query, which may be only a selection of it - so paging the buffer
    // appended another table's rows under these columns and left the tab holding rows from
    // two tables while naming one (#881).
    executeQuery(currentTab.resultQuery ?? currentTab.query, currentTab.id, false, {
      // The size of the page already on screen, not a constant. A table preview is 50
      // rows and a hand-run statement is 500, and a hardcoded 500 made the second page
      // ten times the first while the footer's own label promised 500 either way (#816).
      limit: currentTab.result.pagination.limit,
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
