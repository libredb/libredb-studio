import type { ExecuteRequest, TransactionAction, TransactionRequest } from "@libredb/provider-sdk/calls";
import { CLEANUP_DEADLINE_MS } from "@libredb/provider-sdk/calls";
import type { SessionState } from "@libredb/provider-sdk/errors";
import {
  callContext,
  type EditorQueryBody,
  EXECUTE_SLACK_MS,
  editorPageBody,
  executeDeadline,
  executeViews,
  hostPorts,
  pageBound,
  statementTimeout,
} from "@/lib/api/editor-query";
import { errorCode, errorKind } from "@/lib/db/error-record";
import { waitedSeconds } from "@/lib/db/errors";
import type { ProviderTextScrub } from "@/lib/db/operations/provider-text";
import type { DatabaseProvider, QueryPrepareOptions } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { type CallerView, refusalError, stopError } from "@/lib/provider-host/access";
import type { RefusedRecord, TransactionRecord } from "@/lib/provider-host/core/console";
import { hostCore } from "@/lib/provider-host/instance";
import { bridgedConsole } from "@/lib/provider-host/legacy-bridge";

/*
 * THE TRANSACTION ROUTE'S CALLS ON THE PROVIDER HOST CORE (docs/providers/CONTRACT.md, clauses C-48, C-58 and C-59).
 *
 * The caller facade of `POST /api/db/transaction`, beside `runEditorQuery`: a begin, a COMMIT, a ROLLBACK, the state
 * read and one statement inside the transaction each run through the legacy bridge and the host core's transaction or
 * execute call, on the core the process's composition root installed, read before anything else in every call. Each
 * call builds a fresh request and context, so the core freezes nothing a caller holds, and the facade keeps no state:
 * every outcome carries the session state its own call answered, never one kept from an earlier call (clause C-58).
 *
 * Deadlines (clause C-59). A begin, a COMMIT, a ROLLBACK and a statement wait until `executeDeadline`, the statement
 * timeout plus `EXECUTE_SLACK_MS`, and the state read until `CLEANUP_DEADLINE_MS`, each also ended by the caller's
 * signal. The rollback after a credential change reads the state and rolls back within one allowance of its own,
 * `CREDENTIAL_CHANGE_ROLLBACK_MS`, under a signal of its own and not the caller's: it is Studio's own cleanup, which
 * the caller did not ask for (clause C-47's reason).
 *
 * Outcomes. A call is `answered` with its session state; `failed` with the provider's error by reference and the state
 * read at once after it, except a begin's failure, after which nothing is read since the route claims nothing for it;
 * `unanswered` when the host stopped waiting for it, its caller gone or its deadline passed, or could not read what it
 * answered, so its state is unknown and nothing is read after it, with `settled` for when the call itself has settled;
 * and `not-sent` when the host refused it before the call. Each error is this bundle's class, built by the accessor: a
 * stop is outcome unknown, since the call may have reached the database, and a refusal before the call not-sent.
 *
 * A state read after a failure that is itself stopped answers `unknown` and is logged in Studio's own sentence, and
 * one that fails answers `unknown` and is logged by kind and code, never its text, since the call's own error is the
 * one answered. A call that fails after its wait ended is logged by kind and code through the core's late port.
 */

/** Who waits for a transaction call: the request's signal, and the route a late failure is logged under. */
export interface TransactionCaller {
  readonly signal: AbortSignal;
  readonly route: string;
}

/** A call the session answered, with the session state after it. */
export interface AnsweredCall {
  readonly kind: "answered";
  readonly sessionState: SessionState;
}

/** A call the provider failed: its error by reference, and the state read at once after it. */
export interface FailedCall {
  readonly kind: "failed";
  readonly error: unknown;
  readonly sessionState: SessionState;
}

/**
 * A call the host stopped waiting for, or whose answer it could not read: its session state is unknown. `settled`
 * resolves once the call itself has settled, and never rejects: until then it may still change the session (clause
 * C-58). A call whose answer the host could not read has settled already.
 */
export interface UnansweredCall {
  readonly kind: "unanswered";
  readonly error: Error;
  readonly settled: Promise<void>;
}

/** A call the host refused before it was made: the session was not called, and its state is what it was. */
export interface NotSentCall {
  readonly kind: "not-sent";
  readonly error: Error;
}

/** What a begin answers. A begin's failure carries no state: nothing is read after it. */
export type BeginOutcome =
  | (AnsweredCall & { readonly stateReported?: boolean })
  | { readonly kind: "failed"; readonly error: unknown }
  | UnansweredCall
  | NotSentCall;

/** What a COMMIT or a ROLLBACK answers. */
export type EndOutcome = AnsweredCall | FailedCall | UnansweredCall | NotSentCall;

/** What a statement inside the transaction answers: its page's body when it answered. */
export type StatementOutcome =
  | (AnsweredCall & { readonly body: EditorQueryBody })
  | FailedCall
  | UnansweredCall
  | NotSentCall;

/** One statement inside the transaction: its text, its bound params, its page options and the connection's scrub. */
export interface TransactionStatement {
  readonly statement: string;
  readonly params?: readonly unknown[];
  readonly options: QueryPrepareOptions;
  readonly scrub: ProviderTextScrub;
}

/**
 * How long the state read and the rollback of a transaction whose credential changed may take together before the
 * answer goes out (docs/GOVERNANCE.md#per-user-providers).
 */
export const CREDENTIAL_CHANGE_ROLLBACK_MS = 5_000;

/** What the rollback after a credential change answers: the rollback answered, no transaction was held, or neither. */
export type CredentialRollback =
  | { readonly kind: "rolled-back" }
  | { readonly kind: "none-open" }
  | { readonly kind: "unconfirmed"; readonly error: unknown };

/** The words of each statement the transaction calls send, for the deadline sentences. */
const STATEMENT_WORDS: Readonly<Record<Exclude<TransactionAction, "state">, string>> = {
  begin: "BEGIN",
  commit: "COMMIT",
  rollback: "ROLLBACK",
};

/** What a call of each action leaves open when Studio stopped waiting for it. */
const LEFT_OPEN: Readonly<Record<Exclude<TransactionAction, "state">, string>> = {
  begin: "the transaction may be open",
  commit: "the transaction may have been committed or rolled back",
  rollback: "the transaction may still be open",
};

/** The view of a begin, COMMIT or ROLLBACK on `provider`, naming the statement and what it may have left. */
function actionView(
  provider: Pick<DatabaseProvider, "config">,
  action: Exclude<TransactionAction, "state">,
  caller: AbortSignal,
): CallerView {
  return {
    caller,
    deadlineSentence: `The ${STATEMENT_WORDS[action]} did not answer within the statement timeout of ${waitedSeconds(statementTimeout(provider))} and ${waitedSeconds(EXECUTE_SLACK_MS)} more for the engine's own answer, so Studio stopped waiting for it, and ${LEFT_OPEN[action]}.`,
  };
}

/** The view of a state read for `caller`. */
function stateView(caller: AbortSignal): CallerView {
  return {
    caller,
    deadlineSentence: `The transaction state read did not answer within ${waitedSeconds(CLEANUP_DEADLINE_MS)}, so Studio stopped waiting for it.`,
  };
}

/** The view of the rollback after a credential change, whose allowance is its own. */
const CREDENTIAL_VIEW_SENTENCE = `The rollback after a credential change did not answer within ${waitedSeconds(CREDENTIAL_CHANGE_ROLLBACK_MS)}, so Studio stopped waiting for it.`;

/** A refused record's outcome: not-sent before the call, unanswered once the provider was called. */
function refusedOutcome(record: RefusedRecord, view: CallerView): UnansweredCall | NotSentCall {
  const error = refusalError(record, view);
  return record.called ? { kind: "unanswered", error, settled: Promise.resolve() } : { kind: "not-sent", error };
}

/** One transaction call on `provider` through the installed core, with a fresh request and context. */
function transactionOn(
  provider: DatabaseProvider,
  request: TransactionRequest,
  deadline: number,
  signal: AbortSignal,
  route: string,
): Promise<TransactionRecord> {
  return hostCore().transactionCall(
    bridgedConsole(provider, {}).session,
    request,
    callContext(deadline, signal),
    hostPorts(route),
  );
}

/** A state read, or the error of a read the host stopped waiting for or refused before the call. */
type StateRead =
  | { readonly kind: "read"; readonly sessionState: SessionState }
  | { readonly kind: "unread"; readonly error: Error };

/**
 * Reads the session state of `provider` until `deadline` under `signal`.
 *
 * @throws The provider's error by reference, or a host defect for an answer the host could not read.
 */
async function readState(
  provider: DatabaseProvider,
  deadline: number,
  signal: AbortSignal,
  view: CallerView,
  route: string,
): Promise<StateRead> {
  const record = await transactionOn(provider, { action: "state" }, deadline, signal, route);
  if (record.kind === "answered") return { kind: "read", sessionState: record.sessionState };
  if (record.kind === "stopped") return { kind: "unread", error: stopError(record.reason, view) };
  const error = refusalError(record, view);
  if (record.called) throw error;
  return { kind: "unread", error };
}

/**
 * The session state of `provider` now, read through the host core under the cleanup deadline from `now` and the
 * caller's signal. A read the host stopped waiting for, or refused before the call, answers `unknown`, logged in
 * Studio's own sentence by kind and code.
 *
 * @throws The provider's error by reference, or a host defect for an answer the host could not read.
 */
export async function readTransactionState(
  provider: DatabaseProvider,
  caller: TransactionCaller,
  now: number = Date.now(),
): Promise<SessionState> {
  const read = await readState(
    provider,
    now + CLEANUP_DEADLINE_MS,
    caller.signal,
    stateView(caller.signal),
    caller.route,
  );
  if (read.kind === "read") return read.sessionState;
  logger.warn(read.error.message, { route: caller.route, kind: errorKind(read.error), code: errorCode(read.error) });
  return "unknown";
}

/**
 * The session state of `provider` read as `readTransactionState` reads it, answering `unknown` for a read that fails,
 * logged by kind and code and never its text: the state read after a provider's failure, whose own error is the one
 * answered, and the read of the route's timeout watch. It never rejects.
 */
export async function readTransactionStateOrUnknown(
  provider: DatabaseProvider,
  caller: TransactionCaller,
): Promise<SessionState> {
  try {
    return await readTransactionState(provider, caller);
  } catch (failure) {
    logger.warn("A transaction state read failed, so the state is unknown", {
      route: caller.route,
      kind: errorKind(failure),
      code: errorCode(failure),
    });
    return "unknown";
  }
}

/** Opens a transaction on `provider`, asking the server to report its state when `requireReportedState`. */
export async function beginInTransaction(
  provider: DatabaseProvider,
  requireReportedState: boolean,
  caller: TransactionCaller,
  now: number = Date.now(),
): Promise<BeginOutcome> {
  const view = actionView(provider, "begin", caller.signal);
  let record: TransactionRecord;
  try {
    record = await transactionOn(
      provider,
      { action: "begin", ...(requireReportedState ? { requireReportedState: true as const } : {}) },
      executeDeadline(provider, now),
      caller.signal,
      caller.route,
    );
  } catch (error) {
    return { kind: "failed", error };
  }
  if (record.kind === "refused") return refusedOutcome(record, view);
  if (record.kind === "stopped") {
    return { kind: "unanswered", error: stopError(record.reason, view), settled: record.settled };
  }
  return record;
}

/** Ends the transaction on `provider` with a COMMIT or a ROLLBACK. */
export async function endTransaction(
  provider: DatabaseProvider,
  action: "commit" | "rollback",
  caller: TransactionCaller,
  now: number = Date.now(),
): Promise<EndOutcome> {
  const view = actionView(provider, action, caller.signal);
  let record: TransactionRecord;
  try {
    record = await transactionOn(provider, { action }, executeDeadline(provider, now), caller.signal, caller.route);
  } catch (error) {
    return { kind: "failed", error, sessionState: await readTransactionStateOrUnknown(provider, caller) };
  }
  if (record.kind === "refused") return refusedOutcome(record, view);
  if (record.kind === "stopped") {
    return { kind: "unanswered", error: stopError(record.reason, view), settled: record.settled };
  }
  return { kind: "answered", sessionState: record.sessionState };
}

/**
 * Runs one statement inside the transaction on `provider` and answers its first result set's page, as
 * `runEditorQuery` answers it: within the host's page budget and its large-page slot, the body built by
 * `editorPageBody`, with the session state the statement answered.
 */
export async function runInTransaction(
  provider: DatabaseProvider,
  run: TransactionStatement,
  caller: TransactionCaller,
  now: number = Date.now(),
): Promise<StatementOutcome> {
  const core = hostCore();
  const views = executeViews(provider, caller.signal);
  const bridged = bridgedConsole(provider, run.options);
  const request: ExecuteRequest = {
    statement: run.statement,
    page: pageBound(run.options),
    ...(run.params === undefined ? {} : { params: [...run.params] }),
    transaction: true,
  };
  let record: Awaited<ReturnType<typeof core.executeCall>>;
  try {
    record = await core.executeCall(
      bridged.session,
      request,
      callContext(executeDeadline(provider, now), caller.signal),
      bridged.pumpLimits,
      hostPorts(caller.route),
    );
  } catch (error) {
    return { kind: "failed", error, sessionState: await readTransactionStateOrUnknown(provider, caller) };
  }
  if (record.kind === "refused") return refusedOutcome(record, views.view);
  if (record.kind === "stopped") {
    return { kind: "unanswered", error: stopError(record.reason, views.stopView(record)), settled: record.settled };
  }
  // Present on every page of a statement sent with `transaction` (clause C-48).
  const sessionState = record.sessionState as SessionState;
  const { body } = editorPageBody(record, bridged.answered, run.scrub);
  return { kind: "answered", body, sessionState };
}

/**
 * Rolls back the transaction `provider` holds after its owner's credential changed: the state read, then the rollback
 * when the state is `in-transaction` or `unknown`, both within `CREDENTIAL_CHANGE_ROLLBACK_MS` from `now` under a
 * signal of the allowance's own. A rollback that answered is `rolled-back`, a session that held none `none-open`, and
 * every other end `unconfirmed` with its error: the provider's by reference, or this bundle's class for a stop or a
 * refusal, named by the allowance.
 */
export async function rollBackAfterCredentialChange(
  provider: DatabaseProvider,
  route: string,
  now: number = Date.now(),
): Promise<CredentialRollback> {
  const deadline = now + CREDENTIAL_CHANGE_ROLLBACK_MS;
  // Studio's own signal, which only the allowance ends.
  const own = new AbortController().signal;
  const view: CallerView = { caller: own, deadlineSentence: CREDENTIAL_VIEW_SENTENCE };
  try {
    const read = await readState(provider, deadline, own, view, route);
    if (read.kind === "read" && read.sessionState === "not-in-transaction") return { kind: "none-open" };
    const record = await transactionOn(provider, { action: "rollback" }, deadline, own, route);
    if (record.kind === "answered") return { kind: "rolled-back" };
    if (record.kind === "stopped") return { kind: "unconfirmed", error: stopError(record.reason, view) };
    return { kind: "unconfirmed", error: refusalError(record, view) };
  } catch (error) {
    return { kind: "unconfirmed", error };
  }
}

/** The `inTransaction` an answer carries for `state`: `null` when the state is unknown, which is neither. */
export function inTransactionAnswer(state: SessionState): boolean | null {
  if (state === "unknown") return null;
  return state === "in-transaction";
}
