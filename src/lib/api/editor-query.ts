import {
  CLEANUP_DEADLINE_MS,
  type CallContext,
  deadlineSignal,
  envReader,
  type ExecuteRequest,
  type PageBound,
} from "@libredb/provider-sdk/calls";
import { firstResultSet } from "@/lib/api/first-result-set";
import { pageOfProbe, pageOptionError } from "@/lib/api/page-probe";
import { connectBudgetFor, openDeadlineSentence } from "@/lib/db/connect-budget";
import { consoleTextByteLimit, consoleTextOverLimit } from "@/lib/db/destructive-commands";
import { errorCode, errorKind } from "@/lib/db/error-record";
import { QueryCancelledError, waitedSeconds } from "@/lib/db/errors";
import { type ProviderTextScrub, withScrubbedWarnings } from "@/lib/db/operations/provider-text";
import { DEFAULT_QUERY_TIMEOUT, type DatabaseProvider, type QueryPrepareOptions } from "@/lib/db/types";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { logger } from "@/lib/logger";
import { rowsWithNonFiniteWords } from "@/lib/non-finite";
import { type CallerView, openStopError, refusalError, stopError } from "@/lib/provider-host/access";
import type { HostCallPorts, PageRecord, StoppedRecord } from "@/lib/provider-host/core/console";
import type { OpenWait } from "@/lib/provider-host/core/open-once";
import { hostCore } from "@/lib/provider-host/instance";
import { type AnsweredRun, bridgedConsole } from "@/lib/provider-host/legacy-bridge";
import type { DatabaseType, QueryPagination, QueryResult } from "@/lib/types";

/*
 * THE EDITOR QUERY'S PROVIDER-FACING STEPS, WITH NO NEXT IN THEM.
 *
 * Two callers run one statement through these two steps, in this order: `POST /api/db/query`
 * (`src/app/api/db/query/route.ts`) and the VS Code extension's backend child, whose `query/run`
 * re-does what the route does for one statement. `checkEditorQuery` holds the checks that run before
 * any provider resolves; `runEditorQuery` takes a provider the caller already resolved under its
 * posture and catalog, and runs it.
 *
 * What stays with each caller is what only that caller has: the session guard and rate limit, seed
 * resolution, the `sql` and `queryId` field checks, bound params, EXPLAIN, the `database` key-space
 * override, the admission gate, query events, how the provider is resolved, and how an error is
 * answered.
 */

/**
 * What `checkEditorQuery` reads: the statement as sent, the connection's type and statement timeout, and the page
 * bounds as sent. The statement is `unknown` because the route hands over its body field unchecked; the caller still
 * owns the `sql` and `queryId` field checks. The statement timeout is the connection's own `queryTimeout`, which an
 * inline connection carries unchecked.
 */
export interface EditorQueryRequest {
  statement: unknown;
  type: DatabaseType;
  options: unknown;
  queryTimeout: unknown;
}

/** A request refused before any provider resolves, with the status and sentence the route answers. */
export interface EditorQueryRefusal {
  status: 400 | 413;
  error: string;
}

/** The longest a timer waits on Node.js, which runs a longer one after one millisecond. */
const TIMER_MAX_MS = 2_147_483_647;

/**
 * The connection dialog's bounds of a statement timeout, refused by name here because the host's deadline is computed
 * from it: a value that is not a whole number of milliseconds made that deadline NaN, and every query answered 500.
 */
const QUERY_TIMEOUT_REFUSAL = `The connection's queryTimeout must be a whole number of milliseconds from 1 to ${TIMER_MAX_MS}.`;

/** Whether `value` is a statement timeout the host can wait on: absent, or a whole number from 1 to `TIMER_MAX_MS`. */
function validQueryTimeout(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= TIMER_MAX_MS;
}

/**
 * Why this request is refused, or null when no check refuses it: the page bounds first, then the connection's
 * statement timeout, then the console text bound of a connection type that declares one. Null does not mean the
 * request can run: only a type with a text bound has its statement held to a string here, so a new caller checks that
 * the statement and the `queryId` are strings itself before it calls `runEditorQuery`. The route checks that `sql` is
 * present and is a string, and that `queryId` is a string, before it calls this.
 */
export function checkEditorQuery(request: EditorQueryRequest): EditorQueryRefusal | null {
  const optionError = pageOptionError(request.options);
  if (optionError !== null) return { status: 400, error: optionError };
  if (!validQueryTimeout(request.queryTimeout)) return { status: 400, error: QUERY_TIMEOUT_REFUSAL };

  // A connection type that declares a console text bound is held to it here, before the bound parameters, the
  // provider and the statement cache are reached, so an oversize text opens no socket. The answer names the size
  // and the bound and never repeats the text. The bound is read from the type in the body, after the JSON has been
  // parsed: a streamed bound on the request itself would change every engine and is a separate decision.
  const textLimit = consoleTextByteLimit(request.type);
  if (textLimit !== undefined) {
    if (typeof request.statement !== "string") return { status: 400, error: "sql must be a string" };
    const over = consoleTextOverLimit(request.statement, textLimit);
    if (over !== undefined) return { status: 413, error: over };
  }
  return null;
}

/** One run of a statement that `checkEditorQuery` passed, on a provider the caller resolved. */
export interface EditorQueryRun {
  /** The text that runs: the route's EXPLAIN-built one, or the caller's own. */
  statement: string;
  /** The page bounds, already passed by `checkEditorQuery`. */
  options: QueryPrepareOptions;
  /** Bound params, bound to `statement` as written. */
  params?: unknown[];
  /** The id a provider tracks the run under and a cancel names it by. */
  queryId?: string;
  /** Aborted when the caller goes away; the run is then cancelled under `queryId`. */
  signal: AbortSignal;
  /** The label a failed cancel is logged under. */
  route: string;
  /**
   * The core scrub of the connection the provider was built from (`providerTextScrub(connection, "any")`): a warning
   * field that holds one of its credential forms is answered as `PROVIDER_TEXT_WITHHELD`. Required, so each caller
   * holds it.
   */
  scrub: ProviderTextScrub;
}

/** The answer's body: the first result set's page, with `pagination` always present. */
export interface EditorQueryBody extends Omit<QueryResult, "resultSets" | "pagination"> {
  openTransaction?: "rolled-back";
  pagination: QueryPagination;
}

/** The body, and how many result sets the text produced, which the body itself does not carry. */
export interface EditorQueryAnswer {
  body: EditorQueryBody;
  resultSetCount: number;
}

/**
 * How long after the statement timeout the host still waits: the engine's own timeout answer and the rollback of the
 * run's open transaction (at most 5 s) arrive within it, so today's timeout answer wins wherever the engine answers in
 * time.
 */
export const EXECUTE_SLACK_MS = 10_000;

/** A legacy provider reads no declared environment, so its calls get a reader of none. */
const NO_ENVIRONMENT = envReader([], () => undefined);

/** The statement timeout `provider` was built with: the connection's own, or Studio's default. */
export function statementTimeout(provider: Pick<DatabaseProvider, "config">): number {
  return provider.config.queryTimeout ?? DEFAULT_QUERY_TIMEOUT;
}

/**
 * When the execute call of a run that starts at `now` on `provider` must have answered: the statement timeout plus
 * `EXECUTE_SLACK_MS`, capped at the longest a timer waits.
 */
export function executeDeadline(provider: Pick<DatabaseProvider, "config">, now: number): number {
  return now + Math.min(statementTimeout(provider) + EXECUTE_SLACK_MS, TIMER_MAX_MS);
}

/**
 * Resolves an editor call's provider through `open`, waiting for it at most its engine's connect budget from `now`
 * (`connectBudgetFor`, src/lib/db/connect-budget.ts) or until `caller` aborts (docs/providers/CONTRACT.md, clauses
 * C-44, C-51 and M-51). The budget is the engine's own connect bound plus 10 s for its connect failure to arrive, so a
 * provider that bounds its connect answers in its own words, as `EXECUTE_SLACK_MS` lets the engine's own timeout win.
 * `open` is handed the call's open wait, which the caller passes to `getOrCreateProvider`, so the call stops waiting
 * while the open goes on for every other caller and admits itself. A rejection with the wait's own reason answers this
 * bundle's class (`openStopError`): `QueryCancelledError` when the caller left, `StudioTimeoutRefusal` naming the
 * engine's budget when the allowance ended, both not-sent. Any other failure of the open passes as the same object,
 * and an opener that answers despite its wait is answered as it is. The open's own deadline, the same budget from the
 * open's start (clause C-55), answers the same class and sentence. The execute keeps its own deadline, which starts
 * once the provider resolved.
 */
export async function openWithinCall<T>(
  caller: AbortSignal,
  type: DatabaseType,
  open: (wait: OpenWait) => Promise<T>,
  now: number = Date.now(),
): Promise<T> {
  const budget = connectBudgetFor(type);
  const wait: OpenWait = { signal: deadlineSignal(now + budget, caller) };
  try {
    return await open(wait);
  } catch (error) {
    if (wait.signal.aborted && error === wait.signal.reason) {
      throw openStopError(error, { caller, deadlineSentence: openDeadlineSentence(budget) });
    }
    throw error;
  }
}

/** The page a request asks for, as the contract states it: every row, or a limit and an offset. */
export function pageBound(options: QueryPrepareOptions): PageBound {
  if (options.unlimited === true) return { unlimited: true };
  return { limit: options.limit ?? DEFAULT_QUERY_LIMIT, offset: options.offset ?? 0 };
}

/**
 * Where the host core hands what a call no longer waits for, logged under `route`: a failure after the caller left,
 * and a failed cancel, each by its kind and code and never its text, which can carry a server's words. Once the run's
 * cancel was sent (`cancelSent`), a `QueryCancelledError` after it is the run's expected end and is not logged.
 */
export function hostPorts(route: string, cancelSent: () => boolean = () => false): HostCallPorts {
  return {
    late: (failure) => {
      if (failure instanceof QueryCancelledError && cancelSent()) return;
      logger.warn("A statement Studio stopped waiting for failed afterwards", {
        route,
        kind: errorKind(failure),
        code: errorCode(failure),
      });
    },
    cancelFailed: (failure) =>
      logger.warn("The cancel sent after the request was aborted failed", {
        route,
        kind: errorKind(failure),
        code: errorCode(failure),
      }),
  };
}

/** A call's context: `deadline`, and a signal that aborts at it or when `caller` aborts first. */
export function callContext(deadline: number, caller: AbortSignal): CallContext {
  return { deadline, signal: deadlineSignal(deadline, caller), env: NO_ENVIRONMENT };
}

/*
 * THE EDITOR QUERY ON THE PROVIDER HOST CORE (docs/providers/CONTRACT.md, clauses C-48 to C-51).
 *
 * `runEditorQuery` is the caller facade: it keeps the shape both callers have always used and answers today's body,
 * while the run goes through the legacy bridge and the host core's execute call. The core is the one the process's
 * composition root installed (`hostCore`, src/lib/provider-host/instance.ts, clause C-52), read before anything else,
 * so a call made before the install fails by name and this bundle holds no copy of the core's calls; the ports and the
 * accessor that read this bundle's classes stay this bundle's, built per call. It builds a fresh request and
 * context for each call, so the core freezes nothing a caller holds; the core checks the call before it is made,
 * waits for it until its deadline or the caller's going, and pumps its first result within the 32 MiB page budget
 * with a turn of the event loop before every pull. A page that needs more than one batch waits for the core's one
 * large-page slot (clause C-53), and the facade releases the page record once it has built the answer body, in a
 * `finally`, so the next large page waits for no more than that. A page whose wait for the slot its deadline ended
 * answers `StudioTimeoutRefusal` in a sentence naming that wait, outcome unknown, since the statement ran (clause C-54),
 * a page whose reading its deadline ended answers it in a sentence saying the statement answered, and a run whose
 * closing of its other results its deadline ended, after its page was read, in a sentence saying so (clause C-48).
 * The accessor turns each record the core answers into this bundle's own error class.
 *
 * A caller that goes while the statement runs is answered at once, and the core sends the run's cancel; the
 * statement's own end is handled late, logged by kind and code when it fails, unless it is the provider's cancellation
 * answer to that cancel. A provider that never answers is cut at the deadline, `StudioTimeoutRefusal`, answered 504.
 */

/** How the accessor reads an execute's records: the view of the call, and the view of a stop by the wait it ended. */
export interface ExecuteViews {
  readonly view: CallerView;
  readonly stopView: (record: StoppedRecord) => CallerView;
}

/** The views of an execute on `provider` for `caller`, each naming the statement timeout and the host's slack. */
export function executeViews(provider: Pick<DatabaseProvider, "config">, caller: AbortSignal): ExecuteViews {
  const view: CallerView = {
    caller,
    deadlineSentence: `The statement did not answer within its timeout of ${waitedSeconds(statementTimeout(provider))} and ${waitedSeconds(EXECUTE_SLACK_MS)} more for the engine's own answer, so Studio stopped waiting for it.`,
  };
  // The statement answered, but its page waited for the core's large-page slot until the deadline (clause C-54).
  const slotView: CallerView = {
    caller,
    deadlineSentence: `The statement answered, but its page waited for another large page to be answered past its timeout of ${waitedSeconds(statementTimeout(provider))} and ${waitedSeconds(EXECUTE_SLACK_MS)} more, so Studio stopped waiting for it.`,
  };
  // The statement answered, but its page was still being read at the deadline (clause C-48).
  const pageView: CallerView = {
    caller,
    deadlineSentence: `The statement answered, but Studio did not finish reading its page within its timeout of ${waitedSeconds(statementTimeout(provider))} and ${waitedSeconds(EXECUTE_SLACK_MS)} more, so it stopped waiting for it.`,
  };
  // The statement answered and its page was read, but its other results were still being closed (clause C-48).
  const otherResultsView: CallerView = {
    caller,
    deadlineSentence: `The statement answered and Studio read its page, but closing its other results did not finish within its timeout of ${waitedSeconds(statementTimeout(provider))} and ${waitedSeconds(EXECUTE_SLACK_MS)} more, so Studio stopped waiting for them.`,
  };
  const stopViews: Readonly<Record<NonNullable<StoppedRecord["waitingFor"]>, CallerView>> = {
    "large-page-slot": slotView,
    page: pageView,
    "other-results": otherResultsView,
  };
  return { view, stopView: (record) => (record.waitingFor === undefined ? view : stopViews[record.waitingFor]) };
}

/**
 * The answer body of the page `record` holds, built from what the bridged execute that answered left (`answeredRun`),
 * its warnings through `scrub`; the record is released once, in a `finally`, whether or not the body was built.
 */
export function editorPageBody(
  record: PageRecord,
  answeredRun: () => AnsweredRun,
  scrub: ProviderTextScrub,
): EditorQueryAnswer {
  try {
    const { prepared, result, openTransaction } = answeredRun();
    // The page the host pumped holds the rows that fit the page's row limit and its 32 MiB; the answer is the legacy
    // rows themselves, as the provider returned them, by that count.
    const pumped = result.rows.slice(0, record.page.rows.length);
    // A page the host cut by bytes ends before the rows ran out.
    const byteCut = record.page.end === "byte-limit";

    // PAGE TWO IS ONLY OFFERED FOR A BOUND THIS LAYER APPLIED (#816).
    //
    // `wasLimited` is the limiter saying it rewrote the statement, and it is the only
    // thing that makes advancing the bound meaningful: a statement returned untouched
    // (one carrying the user's own `LIMIT 50`, or a ClickHouse query whose trailing
    // `FORMAT`/`SETTINGS` clause the limiter declines to cut into) runs the same way at
    // every offset. Without this conjunct such a statement, answering with exactly
    // `prepared.limit` rows, offered a Load More whose click re-ran it unchanged and
    // appended the rows already on screen, which the user cannot tell from new ones.
    //
    // One rule, per statement, with no branching on database type: if the bound is ours,
    // pagination is offered; if it is the user's, or the statement could not be
    // rewritten, it is not.
    //
    // The probe row is the proof (#1440): more than `prepared.limit` rows came back, so a next
    // page exists, and the page itself is cut back to the limit asked for. A page the host cut
    // by bytes under a bound this layer wrote has a next page too, which the client reads from
    // its offset plus the rows answered, so it continues after the page's last row.
    const probed = pageOfProbe(prepared, pumped);
    const hasMore = probed.hasMore || (byteCut && prepared.wasLimited);
    const pageRows = probed.rows;
    const answered = firstResultSet(withScrubbedWarnings(scrub, result));
    return {
      body: {
        ...answered,
        // The probe row is not part of the answer, nor are the rows past a byte cut, so the count that names the rows
        // is the page's.
        ...((hasMore || byteCut) && { rowCount: pageRows.length }),
        // NaN and the infinities as words: `JSON.stringify` would write each as null, which
        // the grid and every export then show as SQL NULL (`src/lib/non-finite.ts`).
        rows: rowsWithNonFiniteWords(pageRows),
        // Present only when there was a transaction to end, the way `/api/db/multi-query`
        // reports it, so an always-present "none" would announce something that did not happen.
        // `use-query-execution.ts` raises the notice off this field on BOTH paths; it used to raise
        // it only inside its `multiStatement` branch, which a lone statement never sets, so this
        // field was answered and never rendered for its whole first commit.
        ...(openTransaction === "rolled-back" && { openTransaction }),
        pagination: {
          limit: prepared.limit,
          offset: prepared.offset,
          hasMore,
          totalReturned: pageRows.length,
          // A bound the PROVIDER applied is reported too (#1085, section 5.4). A provider that cuts
          // its own result, as the Prometheus provider cuts a vector at its series cap, says so on
          // the result's own `pagination`, and the badge this field drives says "Studio bounded this
          // result", which is as true of that bound as of the limiter's, and as true of a page the host
          // cut by bytes. Only a `true` crosses, so a provider cannot clear a filled bound this layer
          // applied. A short page does not show the limiter badge; `hasMore` above stays on
          // `prepared.wasLimited`, because an offset can only advance a bound this layer wrote.
          wasLimited: hasMore || byteCut || result.pagination?.wasLimited === true,
        },
      },
      resultSetCount: result.resultSets?.length ?? 1,
    };
  } finally {
    record.release();
  }
}

/** Runs one statement on `provider` and answers its first result set's page. */
export async function runEditorQuery(provider: DatabaseProvider, run: EditorQueryRun): Promise<EditorQueryAnswer> {
  const core = hostCore();
  const deadline = executeDeadline(provider, Date.now());
  const views = executeViews(provider, run.signal);
  const bridged = bridgedConsole(provider, run.options);
  const request: ExecuteRequest = {
    statement: run.statement,
    page: pageBound(run.options),
    ...(run.params === undefined ? {} : { params: [...run.params] }),
    ...(run.queryId === undefined ? {} : { runId: run.queryId }),
  };
  const record = await core.executeCall(
    bridged.session,
    request,
    callContext(deadline, run.signal),
    bridged.pumpLimits,
    hostPorts(run.route, () => bridged.run.cancelSent),
  );
  if (record.kind === "refused") throw refusalError(record, views.view);
  if (record.kind === "stopped") throw stopError(record.reason, views.stopView(record));
  return editorPageBody(record, bridged.answered, run.scrub);
}

/** What a cancel answers: the provider cannot cancel, or whether the engine stopped the run. */
export type EditorCancelAnswer = { readonly offered: false } | { readonly offered: true; readonly cancelled: boolean };

/**
 * Cancels the run `queryId` names on `provider` through the host core's cancel call, under the cleanup deadline,
 * `CLEANUP_DEADLINE_MS`, and the caller's signal. A provider that cannot cancel is answered `offered: false` without a
 * call, and each caller keeps its own answer for it; a caller already gone starts nothing.
 */
export async function cancelEditorRun(
  provider: DatabaseProvider,
  queryId: string,
  caller: AbortSignal,
  route: string,
): Promise<EditorCancelAnswer> {
  const core = hostCore();
  const view: CallerView = {
    caller,
    deadlineSentence: `The cancel did not answer within ${waitedSeconds(CLEANUP_DEADLINE_MS)}, so Studio stopped waiting for it.`,
  };
  const record = await core.cancelCall(
    bridgedConsole(provider, {}).session,
    { runId: queryId },
    callContext(Date.now() + CLEANUP_DEADLINE_MS, caller),
    hostPorts(route),
  );
  if (record.kind === "answered") return { offered: true, cancelled: record.cancelled };
  if (record.kind === "stopped") throw stopError(record.reason, view);
  if (record.refusals.some((refusal) => refusal.rule === "facet-not-offered")) return { offered: false };
  throw refusalError(record, view);
}
