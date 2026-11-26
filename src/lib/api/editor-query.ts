import {
  CLEANUP_DEADLINE_MS,
  type CallContext,
  checkConsoleFacet,
  cleanupContext,
  deadlineSignal,
  type EndScopeAnswer,
  type EnvReader,
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
import {
  DEFAULT_QUERY_TIMEOUT,
  type DatabaseProvider,
  newQueryCallScope,
  type QueryPrepareOptions,
} from "@/lib/db/types";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { logger } from "@/lib/logger";
import { rowsWithNonFiniteWords } from "@/lib/non-finite";
import { type CallerView, openStopError, refusalError, stopError } from "@/lib/provider-host/access";
import type {
  ConsoleSession,
  EndScopeRecord,
  ExecuteRecord,
  HostCallPorts,
  PageRecord,
  StoppedRecord,
} from "@/lib/provider-host/core/console";
import type { HostCore } from "@/lib/provider-host/core/host-core";
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
 * What `checkEditorQuery` reads: the statement as sent, the type whose console text bound applies, the connection's
 * statement timeout, and the page bounds as sent. The statement is `unknown` because the route hands over its body
 * field unchecked; the caller still owns the `sql` and `queryId` field checks. The statement timeout is the
 * connection's own `queryTimeout`, which an inline connection carries unchecked.
 */
export interface EditorQueryRequest {
  statement: unknown;
  /**
   * The type whose console text bound applies, undefined for a connection whose engine's record offers none
   * (`EngineOffers.consoleTextBound`): a package's engine, which has no row of Studio's keyed by its id.
   */
  type: DatabaseType | undefined;
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
 * Why a connection's statement timeout `value` is refused, or null when the host can wait on it. Read by
 * `checkEditorQuery`, by `POST /api/db/multi-query`, whose units each wait on it, and by `POST /api/db/profile`, whose
 * reads each wait on it.
 */
export function queryTimeoutError(value: unknown): string | null {
  return validQueryTimeout(value) ? null : QUERY_TIMEOUT_REFUSAL;
}

/**
 * Why this request is refused, or null when no check refuses it: the page bounds first, then the connection's
 * statement timeout, then the console text bound of a connection type that declares one (none where `type` is
 * undefined). Null does not mean the request can run: only a type with a text bound has its statement held to a string
 * here, so a new caller checks that the statement and the `queryId` are strings itself before it calls
 * `runEditorQuery`. The route checks that `sql` is present and is a string, and that `queryId` is a string, before it
 * calls this.
 */
export function checkEditorQuery(request: EditorQueryRequest): EditorQueryRefusal | null {
  const optionError = pageOptionError(request.options);
  if (optionError !== null) return { status: 400, error: optionError };
  const timeoutError = queryTimeoutError(request.queryTimeout);
  if (timeoutError !== null) return { status: 400, error: timeoutError };

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
 * How long after the statement timeout the host still waits: the engine's own timeout answer arrives within it, so
 * today's timeout answer wins wherever the engine answers in time. The end of the run's scope comes after the run,
 * under a cleanup deadline of its own (`CLEANUP_DEADLINE_MS`).
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
  return executeDeadlineFor(statementTimeout(provider), now);
}

/**
 * When the execute call of a run that starts at `now` under the statement timeout `timeout` must have answered: the
 * body of `executeDeadline`, which a provider package's run reads with its connection's own timeout
 * (src/lib/api/package-editor-query.ts).
 */
export function executeDeadlineFor(timeout: number, now: number): number {
  return now + Math.min(timeout + EXECUTE_SLACK_MS, TIMER_MAX_MS);
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
export function openWithinCall<T>(
  caller: AbortSignal,
  type: DatabaseType,
  open: (wait: OpenWait) => Promise<T>,
  now: number = Date.now(),
): Promise<T> {
  return openWithinBudget(caller, connectBudgetFor(type), open, now);
}

/**
 * `openWithinCall` with the allowance `budget` in milliseconds rather than read by type: the query route reads an
 * engine a provider package serves at its declared connect budget (`packageConnectBudget`).
 */
export async function openWithinBudget<T>(
  caller: AbortSignal,
  budget: number,
  open: (wait: OpenWait) => Promise<T>,
  now: number = Date.now(),
): Promise<T> {
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

/**
 * A call's context on a wait the caller already holds: `deadline`, and `signal` itself, by reference, so a caller that
 * holds a deadline signal of its own keeps one deadline and no second timer races it. `env` is the environment the
 * session's calls are given: none for a legacy provider, the declared one for a provider package's session.
 */
export function contextOn(deadline: number, signal: AbortSignal, env: EnvReader = NO_ENVIRONMENT): CallContext {
  return { deadline, signal, env };
}

/** A call's context: `deadline`, and a signal that aborts at it or when `caller` aborts first; `env` as `contextOn`. */
export function callContext(deadline: number, caller: AbortSignal, env: EnvReader = NO_ENVIRONMENT): CallContext {
  return contextOn(deadline, deadlineSignal(deadline, caller), env);
}

/*
 * THE EDITOR QUERY ON THE PROVIDER HOST CORE (docs/providers/CONTRACT.md, clauses C-48 to C-51 and C-60).
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
 *
 * The run's scope is the facade's: it mints one for a session that offers `console.endScope`, sends it with the execute,
 * and ends it through the core's endScope call after the run, under the cleanup deadline (see the D74 and D87 note
 * above `runEditorQuery`).
 *
 * A script of `POST /api/db/multi-query` runs its units through a facade of its own, `openEditorScript` in
 * src/lib/api/editor-script.ts (clause C-83), which reads this module's deadline, views, ports and scope end.
 */

/** How the accessor reads an execute's records: the view of the call, and the view of a stop by the wait it ended. */
export interface ExecuteViews {
  readonly view: CallerView;
  readonly stopView: (record: StoppedRecord) => CallerView;
}

/** The views of an execute on `provider` for `caller`, each naming the statement timeout and the host's slack. */
export function executeViews(provider: Pick<DatabaseProvider, "config">, caller: AbortSignal): ExecuteViews {
  return executeViewsFor(statementTimeout(provider), caller);
}

/** The views of an execute under the statement timeout `timeout` for `caller`: the body of `executeViews`. */
export function executeViewsFor(timeout: number, caller: AbortSignal): ExecuteViews {
  const view: CallerView = {
    caller,
    deadlineSentence: `The statement did not answer within its timeout of ${waitedSeconds(timeout)} and ${waitedSeconds(EXECUTE_SLACK_MS)} more for the engine's own answer, so Studio stopped waiting for it.`,
  };
  // The statement answered, but its page waited for the core's large-page slot until the deadline (clause C-54).
  const slotView: CallerView = {
    caller,
    deadlineSentence: `The statement answered, but its page waited for another large page to be answered past its timeout of ${waitedSeconds(timeout)} and ${waitedSeconds(EXECUTE_SLACK_MS)} more, so Studio stopped waiting for it.`,
  };
  // The statement answered, but its page was still being read at the deadline (clause C-48).
  const pageView: CallerView = {
    caller,
    deadlineSentence: `The statement answered, but Studio did not finish reading its page within its timeout of ${waitedSeconds(timeout)} and ${waitedSeconds(EXECUTE_SLACK_MS)} more, so it stopped waiting for it.`,
  };
  // The statement answered and its page was read, but its other results were still being closed (clause C-48).
  const otherResultsView: CallerView = {
    caller,
    deadlineSentence: `The statement answered and Studio read its page, but closing its other results did not finish within its timeout of ${waitedSeconds(timeout)} and ${waitedSeconds(EXECUTE_SLACK_MS)} more, so Studio stopped waiting for them.`,
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
 * its warnings through `scrub`; the record is released once, in a `finally`, whether or not the body was built. The
 * run's `openTransaction` is not the page's: `runEditorQuery` appends it from the end of the run's scope.
 */
export function editorPageBody(
  record: PageRecord,
  answeredRun: () => AnsweredRun,
  scrub: ProviderTextScrub,
): EditorQueryAnswer {
  try {
    const { prepared, result } = answeredRun();
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

/*
 * A SINGLE STATEMENT CAN LEAVE A TRANSACTION OPEN, SO THE RUN ENDS ITS SCOPE (D74, D87;
 * docs/providers/CONTRACT.md, clause C-60).
 *
 * MEASURED 2026-09-15 against PostgreSQL 18.4 through the query route with the real
 * provider and the real process-wide cache: a lone `BEGIN` answered 200 and released
 * its pooled client in status `T`, and the next request on the same cached provider,
 * which is any other signed-in user of that stored connection, ran its `CREATE TABLE`
 * inside that stranger's transaction, answered 200, and an independent reader saw no
 * such table. Driven the other way the loss is loud: a `BEGIN` followed by a statement
 * naming a missing relation leaves the client in `E` and the next request answers 500.
 *
 * Ending the run's transaction was tried once before and REVERTED, because the ender named
 * one shared pointer: it rolled back whichever client anybody had recorded last, which
 * cost a concurrent `/api/db/multi-query` script its committed `CREATE TABLE` and an
 * interactive `POST /api/db/transaction` session its own. D87 fixed that in the
 * provider, where the borrowed client is in scope, and the `scope` minted here is what
 * names this run's own session: nothing this run did not run on can be ended.
 *
 * The scope is minted only for a session that offers `console.endScope`, since the host refuses
 * a scope to any other (clause C-9), and it is ended through the host core's endScope call
 * after the run, under a cleanup context of its own that the caller's leaving does not end: on
 * every path the statement may have run on, the failing one included, since the statement
 * that poisons a client is usually the one that threw. A run refused before its call ran
 * nothing and ends nothing; a run Studio stopped waiting for is ended once its call settled,
 * and that end's failure is logged, since its answer has already gone.
 */

/** Studio's sentence for an end of a run's scope its cleanup deadline stopped. */
const END_SCOPE_DEADLINE_SENTENCE = `Ending the transaction this request may have left open did not answer within ${waitedSeconds(CLEANUP_DEADLINE_MS)}, so Studio stopped waiting for it.`;

/**
 * The late handler of every end of a run's scope, logged under `route`: a failure of the end after Studio stopped
 * waiting for it, or the end of a stopped run's scope that failed or was stopped, by its kind and code and never its
 * text, which can carry a server's words.
 */
export function lateScopeEnd(route: string): (failure: unknown) => void {
  return (failure) =>
    logger.warn("Ending the transaction a run Studio stopped waiting for may have left open failed", {
      route,
      kind: errorKind(failure),
      code: errorCode(failure),
    });
}

/**
 * Ends `scope` on `session` through the host core's endScope call, under a cleanup context of its own with `env`, the
 * environment the session's calls are given.
 */
function endScopeRecord(
  core: HostCore,
  session: ConsoleSession,
  scope: string,
  route: string,
  env: EnvReader = NO_ENVIRONMENT,
): Promise<EndScopeRecord> {
  return core.endScopeCall(session, { scope }, cleanupContext(env), { late: lateScopeEnd(route) });
}

/**
 * The outcome an end of a run's scope answered.
 *
 * @throws The provider's error by reference; `StudioTimeoutRefusal` naming the end when its cleanup deadline stopped
 * it, outcome unknown; a host defect for a refusal.
 */
function endedScope(record: EndScopeRecord, caller: AbortSignal): EndScopeAnswer["openTransaction"] {
  const view: CallerView = { caller, deadlineSentence: END_SCOPE_DEADLINE_SENTENCE };
  if (record.kind === "answered") return record.openTransaction;
  if (record.kind === "stopped") throw stopError(record.reason, view);
  throw refusalError(record, view);
}

/**
 * Ends the run's `scope`, when it has one, and answers the outcome; see `endedScope` for what it throws. `env` is the
 * environment the session's calls are given, a provider package's declared one for its session.
 */
export async function endRunScope(
  core: HostCore,
  session: ConsoleSession,
  scope: string | undefined,
  run: Pick<EditorQueryRun, "route" | "signal">,
  env: EnvReader = NO_ENVIRONMENT,
): Promise<EndScopeAnswer["openTransaction"]> {
  if (scope === undefined) return "none";
  return endedScope(await endScopeRecord(core, session, scope, run.route, env), run.signal);
}

/**
 * Ends the run's scope as the execute's `record` says, and answers the end's outcome: at once for a page, before its
 * body is built, releasing the record if the end throws, and for a refusal after the call; once the stopped call has
 * settled for a stop, its failure logged, since the stop is answered at once; and not at all for a refusal before the
 * call, which ran nothing.
 */
export async function endAfterRun(
  record: ExecuteRecord,
  end: () => Promise<EndScopeAnswer["openTransaction"]>,
  route: string,
): Promise<EndScopeAnswer["openTransaction"]> {
  if (record.kind === "stopped") {
    record.settled.then(end).then(() => undefined, lateScopeEnd(route));
    return "none";
  }
  if (record.kind === "refused" && !record.called) return "none";
  if (record.kind === "refused") return end();
  try {
    return await end();
  } catch (error) {
    record.release();
    throw error;
  }
}

/** Runs one statement on `provider` and answers its first result set's page. */
export async function runEditorQuery(provider: DatabaseProvider, run: EditorQueryRun): Promise<EditorQueryAnswer> {
  const core = hostCore();
  const deadline = executeDeadline(provider, Date.now());
  const views = executeViews(provider, run.signal);
  const bridged = bridgedConsole(provider, run.options);
  const scope = checkConsoleFacet(bridged.session.calls, "endScope").length === 0 ? newQueryCallScope() : undefined;
  const end = () => endRunScope(core, bridged.session, scope, run);
  const request: ExecuteRequest = {
    statement: run.statement,
    page: pageBound(run.options),
    ...(run.params === undefined ? {} : { params: [...run.params] }),
    ...(run.queryId === undefined ? {} : { runId: run.queryId }),
    ...(scope === undefined ? {} : { scope }),
  };
  let record: ExecuteRecord;
  try {
    record = await core.executeCall(
      bridged.session,
      request,
      callContext(deadline, run.signal),
      bridged.pumpLimits,
      hostPorts(run.route, () => bridged.run.cancelSent),
    );
  } catch (error) {
    await end();
    throw error;
  }
  const openTransaction = await endAfterRun(record, end, run.route);
  if (record.kind === "refused") throw refusalError(record, views.view);
  if (record.kind === "stopped") throw stopError(record.reason, views.stopView(record));
  const answer = editorPageBody(record, bridged.answered, run.scrub);
  // Present only when there was a transaction to end, the way `/api/db/multi-query`
  // reports it, so an always-present "none" would announce something that did not happen.
  // `use-query-execution.ts` raises the notice off this field on BOTH paths; it used to raise
  // it only inside its `multiStatement` branch, which a lone statement never sets, so this
  // field was answered and never rendered for its whole first commit.
  if (openTransaction !== "rolled-back") return answer;
  return { ...answer, body: { ...answer.body, openTransaction } };
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

/**
 * Ends `scope`, which the script facade (`openEditorScript`, src/lib/api/editor-script.ts) minted for a provider whose
 * session offers `console.endScope` and sent with every unit it ran on `provider`, through the bridge's
 * `console.endScope` and the host core's endScope call, under a cleanup context of its own that `caller`'s leaving does
 * not end (docs/providers/CONTRACT.md, clause C-60), and answers the end's outcome.
 *
 * @throws The provider's error by reference; `StudioTimeoutRefusal` naming the end when its cleanup deadline stopped
 * it, outcome unknown; a host defect for a refusal, the facet's included, since a scope is minted only where the facet
 * is offered.
 */
export async function endEditorScope(
  provider: DatabaseProvider,
  scope: string,
  caller: AbortSignal,
  route: string,
): Promise<EndScopeAnswer["openTransaction"]> {
  const core = hostCore();
  return endedScope(await endScopeRecord(core, bridgedConsole(provider, {}).session, scope, route), caller);
}
