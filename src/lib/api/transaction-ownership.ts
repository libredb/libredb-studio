/**
 * Who opened the transaction that `POST /api/db/transaction` is holding open on a connection.
 *
 * The provider's transaction state (`txActive` / `txClient` in
 * `src/lib/db/providers/sql/postgres.ts`, and the equivalents in the mysql, mssql and oracle
 * providers) lives on the provider instance, and `getOrCreateProvider` caches one instance per
 * connection, server and credentials (`providerCacheKey`), not per user. Every Studio user who
 * reaches a connection with the same credentials therefore drives ONE transaction. Measured on
 * PostgreSQL 18.4 on 2026-09-13, through the product's own route, two
 * sessions on one connection id: `user` opened a transaction and inserted a row, `admin` was
 * refused its own `begin` with HTTP 400 "Transaction already active", and was then allowed to
 * `rollback` with HTTP 200. The engine had zero rows afterwards and `user`'s own `commit` came
 * back "No active transaction". A second Studio user destroyed the first one's uncommitted work.
 *
 * UNDER GOVERNANCE EVERY USER HAS A PROVIDER OF THEIR OWN (docs/GOVERNANCE.md#per-user-providers), and so a transaction
 * of their own: the provider's cache key frames the owner the execution context names, the session's identity provider
 * subject, and `transactionKey` frames the same owner, so one user neither sees nor joins another user's transaction,
 * and every record under such a key is that user's. Both keys gain the owner together
 * (docs/GOVERNANCE.md#per-user-providers): a record shared across users' own providers would let a user whose provider
 * holds no transaction drop another user's record on the reconcile below.
 *
 * A CREDENTIAL THAT CHANGES UNDER AN OPEN TRANSACTION, under governance (docs/GOVERNANCE.md#per-user-providers). A
 * governed request opens the connection with the credential of the caller's grant level, and the provider's cache key
 * frames that credential, so a grant downgraded from write to read, or a credential the control plane sealed again,
 * resolves a provider other than the one the transaction was opened on. So the record keeps the provider cache key its
 * begin resolved, and core's scrub of that provider's credential, and a request that resolves another key has the record
 * released by `releaseIfProviderChanged`: the route rolls the transaction back on the provider that holds it, logs a
 * failed rollback through the scrub of the credential that provider holds, which the current request no longer carries,
 * and answers 409 TRANSACTION_CREDENTIAL_CHANGED.
 * Without that, the reconcile below would drop the record because the NEW provider holds no transaction, and the old
 * one would stay open under a credential its owner no longer holds, on a provider their requests no longer reach.
 *
 * SESSION means the authenticated account, `UserPayload.username` from the JWT the route already
 * has through `guardRoute`. That is the only stable identity field in the payload - the comment in
 * `require-session.ts` says so, and the rate limiter is keyed on it for the same reason. Under
 * governance it is the identity provider subject instead, which the record keeps beside the
 * username, because there the username is a display label that can change (docs/GOVERNANCE.md#row-semantics). There is
 * no per-tab or per-browser identifier anywhere in the token or the cookie, so two tabs of ONE
 * account share a transaction, deliberately: that is the same person, and the alternative would be
 * inventing an id the product does not have.
 *
 * WHAT HAPPENS WHEN THE OWNER NEVER COMES BACK. Ownership is a lease, not a lock, because a
 * refusal that never lifts is a second defect: it would leave a connection unusable to everyone
 * else for as long as one abandoned tab holds it. Two independent releases apply.
 *
 *  1. The route reconciles against the provider on every call. `PostgresProvider` and
 *     `MySQLProvider` auto-roll back after their own `TX_TIMEOUT_MS` (5 minutes from BEGIN, not
 *     refreshed by activity) with no session behind that rollback at all, so a record can outlive
 *     the transaction it names. `MSSQLProvider` and `OracleProvider` do the same, but ONLY when
 *     they are owned, that is created with the `owner` of a per-user provider, which only
 *     governance sets (docs/GOVERNANCE.md#per-user-providers). When the provider reports no open transaction, the
 *     record is dropped and the connection is free.
 *  2. This lease expires after `OWNERSHIP_IDLE_MS` with no action from the owner. That is the
 *     release that matters for `MSSQLProvider` and `OracleProvider` without an owner, every
 *     install without governance, where they have no timeout of their own: without it an abandoned
 *     transaction there would hold the connection for the life of the process. An open
 *     transaction with no live record is treated as unowned and any session may commit or roll it
 *     back, which is the escape hatch that makes the refusal safe.
 *
 * Measured against the provider timeouts rather than chosen: 5 minutes is `TX_TIMEOUT_MS` in every
 * provider that has one. It is measured from the owner's LAST action here, not from BEGIN,
 * because the question this lease answers is whether the owner has gone away, and activity is the
 * evidence for that.
 *
 * Process-local, like the provider cache it shadows. A restart drops every record, which lands on
 * the unowned case above rather than on a lockout. The records live in a global under a registered
 * symbol, one map per process, because the governance loader that tears down a revoked user's
 * providers runs in another bundle than the route that claims them (src/lib/db/owner-removal.ts).
 *
 * TRANSACTION EVENTS, under governance (docs/GOVERNANCE.md#query-events). Every record carries a `transactionId` from
 * `randomUUID()`, and under governance the scope its query events need: who opened it, and the
 * connection and grant level it runs on. The route records one `open` event per statement run in it,
 * and exactly one terminal event ends it, through `endTransactionEvent`, which marks the record so a
 * second path that sees the same end records nothing: `committed` and `rolled-back` from the owner's
 * COMMIT and ROLLBACK and from Studio's own rollbacks (a credential that changed, a grant a reload
 * took away), and `timed-out` from whichever of three paths sees the provider's own timeout first:
 * the timer `watchTransactionTimeout` arms at claim, the route's reconcile, or the lapsed lease.
 *
 * AN UNKNOWN SESSION STATE IS NEVER READ AS CLOSED (docs/providers/CONTRACT.md, clause C-58). The route reads the
 * session state through the provider host on every request and after every call, and keeps no copy of it here. A call
 * of the owner's that answered `unknown`, because Studio stopped waiting for it or could not read its answer, keeps the
 * record and marks it `unresolved`, the route's note of what its own answer said, never read as a state: the next
 * answer or read that finds the transaction open clears it (`settleTransaction`, `resolveTransaction`), but only once
 * every call Studio stopped waiting for has settled (`awaitStoppedCall`). Until then no read resolves or releases the
 * record, whatever state it finds: the provider may report the transaction open only because that call still runs, as
 * a COMMIT Studio stopped waiting for leaves the provider's transaction flag set until it commits, or closed only
 * because a BEGIN Studio stopped waiting for has not opened it yet. Every state read is awaited, so a read that began
 * before another request of the owner's claimed, changed or ended the record is not about it, and neither releases nor
 * settles it: each record carries a generation every change bumps, and a read acts only on the record and generation
 * `markTransaction` saw before it began. The route counts each state-changing call of the owner's on the record before
 * it sends it (`startOwnerCall`), and while any is in flight no read acts on the record either: a COMMIT the provider
 * has committed may not have answered its request yet. An end any path sees on an unresolved record is recorded `unknown`, never
 * `timed-out` or `rolled-back`, since a COMMIT Studio stopped waiting for may have committed (`endAsSeen`). For the same
 * reason the route refuses a BEGIN, a statement, a COMMIT or a ROLLBACK of the owner's while such a call still runs
 * (`stoppedCallRunning`), before it is sent: on a connection that runs one call at a time it would queue behind the
 * stopped call, which may end the transaction first.
 */
import { randomUUID } from "node:crypto";
import type { SessionState } from "@libredb/provider-sdk/errors";
import type { ProviderTextScrub } from "@/lib/db/operations/provider-text";
import { queryEventStart } from "@/lib/query-events/build";
import { recordQueryEvent } from "@/lib/query-events/sink";
import type {
  QueryEventConnection,
  QueryEventPrincipal,
  QueryEventStart,
  QueryEventStatus,
  TransactionOutcome,
} from "@/lib/query-events/types";

/**
 * What every query event of a governed transaction says about who ran it and where (docs/GOVERNANCE.md#query-events).
 */
export interface TransactionEventScope {
  readonly principal: QueryEventPrincipal;
  readonly connection: QueryEventConnection;
  readonly clientIp?: string;
}

/** How a transaction ended, as its one terminal event says. */
export type TransactionEnd = Exclude<TransactionOutcome, "open">;

export interface TransactionOwner {
  /** `UserPayload.username` of the session that ran the successful `begin`. */
  username: string;
  /**
   * Under governance, the identity provider subject of that session, the owner its key frames: the
   * identity the route compares, since a username is only a display label there. Absent without
   * governance.
   */
  subject?: string;
  /**
   * Under governance, the cache key of the provider that `begin` ran on, which frames the credential of the owner's
   * grant level: a request that resolves another key no longer reaches this transaction (see the credential note
   * above). Absent without governance, where a record is never compared by key.
   */
  providerKey?: string;
  /**
   * Under governance, core's scrub of the provider `begin` ran on: the forms of the credential that begin resolved,
   * which a request after a credential change no longer carries, so a failed rollback on that provider is logged
   * through it. Present exactly when `providerKey` is.
   */
  providerScrub?: ProviderTextScrub;
  /** When the transaction was opened, for the refusal message and for `status`. */
  startedAt: number;
  /** When the owner last acted on it. The idle lease below is measured from here. */
  lastActiveAt: number;
  /** The `transaction_id` every query event of this transaction carries. */
  readonly transactionId: string;
  /** Under governance, the scope of its query events; absent without governance, where none is recorded. */
  readonly events?: TransactionEventScope;
  /** Whether its terminal event was recorded, so no second path records another. */
  ended: boolean;
  /**
   * Whether a call of the owner's answered an unknown session state that no later answer or read has resolved: an end
   * seen while it is set is recorded `unknown`. Never read as a state.
   */
  unresolved: boolean;
  /**
   * How many calls of the owner's Studio stopped waiting for have not settled yet (`awaitStoppedCall`): while any runs,
   * no answer or read clears `unresolved`.
   */
  unsettled: number;
  /**
   * How many calls of the owner's the route has sent on this record that have not answered yet (`startOwnerCall`): while
   * any is in flight, or a stopped one still runs (`unsettled`), no read acts on the record (`callsRunning`).
   */
  inFlight: number;
  /**
   * Bumped by every change of the record after its claim: a call sent on it and its answer, an answered state that
   * settles it, a stopped call and that call's settle, a resolve, and its end. A state read acts on the record only when the record and its generation are
   * the ones `markTransaction` saw before the read began (`settleTransaction`, `resolveTransaction`).
   */
  generation: number;
}

/**
 * The record under a key, and its generation, as they were before a state read began: the read is about them, and
 * about nothing claimed or changed after it.
 */
export interface TransactionMark {
  readonly owner: TransactionOwner | undefined;
  readonly generation: number;
}

/** See the "owner never comes back" note above: this is `TX_TIMEOUT_MS`, measured. */
export const OWNERSHIP_IDLE_MS = 5 * 60 * 1000;

/**
 * How long after its begin the timer of `watchTransactionTimeout` looks for a transaction the provider ended on its own:
 * the providers' `TX_TIMEOUT_MS`, which `OWNERSHIP_IDLE_MS` measures, plus a second for the provider's own timer to run.
 */
export const TRANSACTION_TIMEOUT_CHECK_MS = OWNERSHIP_IDLE_MS + 1000;

const OWNERS_KEY = Symbol.for("libredb-studio.transaction-owners");

type OwnersHolder = { [OWNERS_KEY]?: Map<string, TransactionOwner> };

function owners(): Map<string, TransactionOwner> {
  const holder = globalThis as OwnersHolder;
  holder[OWNERS_KEY] ??= new Map();
  return holder[OWNERS_KEY];
}

/** What a transaction event says beyond its scope: the statement, how it ended, and when it started. */
export interface TransactionEventDetail {
  readonly statement: string | null;
  readonly status: QueryEventStatus;
  readonly started: QueryEventStart;
  readonly rowCount?: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

/** Records one event of `owner`'s transaction with `outcome`; nothing without governance, where it has no scope. */
function recordEvent(owner: TransactionOwner, outcome: TransactionOutcome, detail: TransactionEventDetail): void {
  if (owner.events === undefined) return;
  recordQueryEvent({
    source: "transaction",
    ...owner.events,
    ...detail,
    transactionId: owner.transactionId,
    transactionOutcome: outcome,
  });
}

/** Records a statement run inside `owner`'s transaction: one `open` event. */
export function recordTransactionStatement(owner: TransactionOwner, detail: TransactionEventDetail): void {
  recordEvent(owner, "open", detail);
}

/**
 * Records the one terminal event of `owner`'s transaction, and nothing when one was recorded already, so of the paths
 * that see the same end only the first records it. It does not release the record: a path that ends the transaction
 * releases it as before.
 */
export function endTransactionEvent(
  owner: TransactionOwner,
  end: TransactionEnd,
  detail: TransactionEventDetail,
): void {
  if (owner.ended) return;
  owner.ended = true;
  owner.generation += 1;
  recordEvent(owner, end, detail);
}

/**
 * How an end of `owner`'s transaction is recorded: `end`, or `unknown` when the record is unresolved, since after an
 * unknown state Studio cannot tell how the transaction ended.
 */
export function endAsSeen(owner: TransactionOwner, end: TransactionEnd): TransactionEnd {
  return owner.unresolved ? "unknown" : end;
}

/**
 * The terminal event of a transaction Studio found ended without a call of its own, no statement, ended now:
 * `timed-out`, the provider's own timer, or `unknown` on an unresolved record.
 */
export function recordEndSeen(owner: TransactionOwner): void {
  endTransactionEvent(owner, endAsSeen(owner, "timed-out"), {
    statement: null,
    status: "cancelled",
    started: queryEventStart(),
  });
}

/**
 * The live owner of `connectionId`'s transaction, or null when there is none on record or the
 * lease has lapsed. Reading is what expires a lapsed lease: there is no timer, so a process that
 * never asks again never pays for one. Under governance every provider rolls back after its own
 * `TX_TIMEOUT_MS` from BEGIN, which a lease measured from the last action never outlasts, so a lapsed
 * lease records the transaction as `timed-out`, or `unknown` on an unresolved record, unless another path recorded its
 * end.
 */
export function transactionOwner(connectionId: string): TransactionOwner | null {
  const owner = owners().get(connectionId);
  if (!owner) return null;
  if (leaseLapsed(owner)) {
    owners().delete(connectionId);
    recordEndSeen(owner);
    return null;
  }
  return owner;
}

/** Whether `owner`'s lease has lapsed: `OWNERSHIP_IDLE_MS` since the owner last acted. */
function leaseLapsed(owner: TransactionOwner): boolean {
  return Date.now() - owner.lastActiveAt >= OWNERSHIP_IDLE_MS;
}

/**
 * Record `username`, and under governance its identity provider `subject`, the `providerKey` of the provider the
 * transaction runs on, the scope of its query `events` and the `providerScrub` of that provider's credential, as the
 * owner, with a new `transactionId`. Called only after `beginTransaction()` has actually succeeded. Returns the record.
 *
 * A record it replaces whose end was not recorded names a transaction the session no longer holds, since the provider
 * opened a new one: no read released it, because a call of the owner's was in flight or stopped, or its read answered
 * after the record changed. How it ended is not known, so its end is recorded `unknown`, once (`endTransactionEvent`).
 */
export function claimTransaction(
  connectionId: string,
  username: string,
  subject?: string,
  providerKey?: string,
  events?: TransactionEventScope,
  providerScrub?: ProviderTextScrub,
): TransactionOwner {
  const replaced = owners().get(connectionId);
  if (replaced !== undefined) {
    endTransactionEvent(replaced, "unknown", { statement: null, status: "cancelled", started: queryEventStart() });
  }
  const now = Date.now();
  const owner: TransactionOwner = {
    username,
    subject,
    providerKey,
    providerScrub,
    startedAt: now,
    lastActiveAt: now,
    transactionId: randomUUID(),
    events,
    ended: false,
    unresolved: false,
    unsettled: 0,
    inFlight: 0,
    generation: 0,
  };
  owners().set(connectionId, owner);
  return owner;
}

/**
 * How long the watch of `watchTransactionTimeout` waits before it looks again, when a call of the owner's that Studio
 * stopped waiting for still ran at its tick or during its read: a second, the margin `TRANSACTION_TIMEOUT_CHECK_MS`
 * gives the provider's own timer.
 */
export const TRANSACTION_TIMEOUT_RECHECK_MS = 1000;

/**
 * Under governance, arms an unreferenced timer that, once `TRANSACTION_TIMEOUT_CHECK_MS` have passed, reads the session
 * state through `readState` and records `owner`'s transaction as ended (`recordEndSeen`) when `owner` is still the
 * record under `connectionId` and the read answers `not-in-transaction`: the provider rolled it back on its own timer.
 * A read that answers `in-transaction` or `unknown` records nothing. While a call of the owner's is in flight or a
 * stopped one still runs (`callsRunning`), at the tick or when the read answers, and when the record changed while the
 * read ran (its mark, `markTransaction`), the read says nothing of the record as it is, so the tick records nothing and
 * the watch looks again after `TRANSACTION_TIMEOUT_RECHECK_MS`. Those repeated looks stop once the record's lease has
 * lapsed, which leaves the record to `transactionOwner` on the next request, so a call that never settles keeps no timer
 * looking. `readState` never rejects: the caller's read logs a failure and answers `unknown`. The record stays for the
 * route's reconcile to release. Without governance it arms nothing.
 */
export function watchTransactionTimeout(
  connectionId: string,
  owner: TransactionOwner,
  readState: () => Promise<SessionState>,
): void {
  if (owner.events === undefined) return;
  armWatch(connectionId, owner, readState, TRANSACTION_TIMEOUT_CHECK_MS, false);
}

/** One look of the watch of `watchTransactionTimeout`, `delay` from now; a `repeat` look stops on a lapsed lease. */
function armWatch(
  connectionId: string,
  owner: TransactionOwner,
  readState: () => Promise<SessionState>,
  delay: number,
  repeat: boolean,
): void {
  const lookAgain = () => armWatch(connectionId, owner, readState, TRANSACTION_TIMEOUT_RECHECK_MS, true);
  const timer = setTimeout(() => {
    if (owners().get(connectionId) !== owner) return;
    if (repeat && leaseLapsed(owner)) return;
    if (callsRunning(owner)) {
      lookAgain();
      return;
    }
    const mark = markTransaction(connectionId);
    void readState().then((state) => {
      if (owners().get(connectionId) !== owner) return;
      if (callsRunning(owner) || !unchangedSince(connectionId, mark)) lookAgain();
      else if (state === "not-in-transaction") recordEndSeen(owner);
    });
  }, delay);
  // The check must never hold the process open on its own.
  timer.unref?.();
}

/**
 * Records `rolled-back` for every open transaction `subject` holds on the connection Studio names `connectionId`, in any
 * of its databases, or `unknown` for an unresolved record: the governance loader calls it for each pair whose providers
 * it tears down, because the teardown rolls those transactions back (docs/GOVERNANCE.md#per-user-providers). It is
 * `unknown` too while a call of the owner's is in flight or stopped and still running on the record (`callsRunning`):
 * that call may end the transaction before the teardown's rollback, a COMMIT committing it, and the rollback then finds
 * nothing to undo. The records stay, so the owner's next request still learns what happened.
 */
export function endOwnerTransactions(connectionId: string, subject: string): void {
  for (const owner of owners().values()) {
    if (owner.subject !== subject || owner.events?.connection.id !== connectionId) continue;
    endTransactionEvent(owner, callsRunning(owner) ? "unknown" : endAsSeen(owner, "rolled-back"), {
      statement: "ROLLBACK",
      status: "success",
      started: queryEventStart(),
    });
  }
}

/**
 * Under governance, release the live record under `connectionId` when its begin resolved a provider other than
 * `providerKey`, the key the current request resolves, and answer the released record, whose `providerKey` is the key
 * it was opened on, so the caller can roll the transaction back on that provider, and whose `providerScrub` covers the
 * credential that provider holds; null when the record names this key, names none, or there is no live record. A record
 * that names a key without its scrub is a claim that broke its contract, refused with an error and left in place.
 *
 * Read and released in one synchronous step, so of two requests that arrive together only one is handed the record:
 * the other finds no record, and its own provider holds no transaction.
 */
export function releaseIfProviderChanged(
  connectionId: string,
  providerKey: string,
): (TransactionOwner & { readonly providerKey: string; readonly providerScrub: ProviderTextScrub }) | null {
  const owner = transactionOwner(connectionId);
  if (owner?.providerKey === undefined || owner.providerKey === providerKey) return null;
  if (owner.providerScrub === undefined) {
    throw new Error("A transaction record that names a provider key must keep that provider's scrub");
  }
  owners().delete(connectionId);
  // The record itself, never a copy, so a terminal event recorded through it marks the one record every path reads.
  return owner as TransactionOwner & { readonly providerKey: string; readonly providerScrub: ProviderTextScrub };
}

/** The record under `connectionId` and its generation now, taken before a state read begins (`TransactionMark`). */
export function markTransaction(connectionId: string): TransactionMark {
  const owner = owners().get(connectionId);
  return { owner, generation: owner?.generation ?? 0 };
}

/** Whether the record under `connectionId` is still the one `mark` saw, with the same generation. */
function unchangedSince(connectionId: string, mark: TransactionMark): boolean {
  const owner = owners().get(connectionId);
  return owner === mark.owner && (owner?.generation ?? 0) === mark.generation;
}

/** Whether the record under `connectionId` was claimed, changed, ended or released since `mark` was taken. */
export function recordChangedSince(connectionId: string, mark: TransactionMark): boolean {
  return !unchangedSince(connectionId, mark);
}

/**
 * A call of the owner's the route sends on the record under a key: `counted` is the record it is counted on until it
 * answers or Studio stops waiting for it, none when no record held the key, and `mark` the record as it was right after
 * the call's own count, so the call's own count never makes its own answer stale.
 */
export interface OwnerCall {
  readonly mark: TransactionMark;
  counted: TransactionOwner | undefined;
}

/**
 * Counts a state-changing call of the owner's on the record under `connectionId` before the route sends it, and bumps
 * the record's generation: until it answers, no read acts on the record (`callsRunning`), since the call may change the
 * session at any moment. Without a record nothing is counted.
 */
export function startOwnerCall(connectionId: string): OwnerCall {
  const owner = owners().get(connectionId);
  if (owner !== undefined) {
    owner.inFlight += 1;
    owner.generation += 1;
  }
  return { mark: markTransaction(connectionId), counted: owner };
}

/** Drops `call`'s count once it answered, and bumps the generation; a call no longer counted changes nothing. */
export function finishOwnerCall(call: OwnerCall): void {
  const owner = call.counted;
  if (owner === undefined) return;
  call.counted = undefined;
  owner.inFlight -= 1;
  owner.generation += 1;
}

/**
 * Moves `call`, which Studio stopped waiting for, from in flight to the calls that have not settled
 * (`awaitStoppedCall`), until `settled` resolves.
 */
export function stopOwnerCall(connectionId: string, call: OwnerCall, settled: Promise<void>): void {
  if (call.counted !== undefined) {
    call.counted.inFlight -= 1;
    call.counted = undefined;
  }
  awaitStoppedCall(connectionId, settled);
}

/**
 * Settles the record under `connectionId` by the session state the owner's own call answered: `in-transaction` extends
 * the lease and clears `unresolved` once no call Studio stopped waiting for still runs, `not-in-transaction` releases
 * the record, and `unknown` keeps it and marks it `unresolved`. A state read the call took acts only when the record is
 * unchanged since `mark`, taken before the call: one taken before another request of the owner's claimed, changed or
 * ended the record is not about it. `unknown` is no read and always marks the record. It records no event: the call
 * that ended a transaction records its own end. Answers the record it released, if it released one. A no-op without a
 * record.
 */
export function settleTransaction(
  connectionId: string,
  state: SessionState,
  mark: TransactionMark,
): TransactionOwner | undefined {
  const owner = owners().get(connectionId);
  if (!owner) return undefined;
  if (state === "unknown") {
    owner.unresolved = true;
    owner.generation += 1;
    return undefined;
  }
  if (!unchangedSince(connectionId, mark)) return undefined;
  if (state === "not-in-transaction") {
    owners().delete(connectionId);
    return owner;
  }
  if (!stoppedCallRunning(owner)) owner.unresolved = false;
  owner.lastActiveAt = Date.now();
  owner.generation += 1;
  return undefined;
}

/**
 * Holds the record under `connectionId` unresolved until `settled`, the settle of a call of the owner's Studio stopped
 * waiting for, resolves: until then the call may still end the transaction, so an answer or read that finds it open
 * does not resolve the record. `settled` never rejects (`UnansweredCall`). A no-op without a record.
 */
export function awaitStoppedCall(connectionId: string, settled: Promise<void>): void {
  const owner = owners().get(connectionId);
  if (!owner) return;
  owner.unsettled += 1;
  owner.generation += 1;
  void settled.then(() => {
    owner.unsettled -= 1;
    owner.generation += 1;
  });
}

/** Whether a call of `owner`'s that Studio stopped waiting for still runs (`awaitStoppedCall`). */
export function stoppedCallRunning(owner: TransactionOwner): boolean {
  return owner.unsettled > 0;
}

/** Whether any call of `owner`'s is in flight (`startOwnerCall`) or, stopped, still runs: no read acts on the record. */
export function callsRunning(owner: TransactionOwner): boolean {
  return owner.inFlight > 0 || stoppedCallRunning(owner);
}

/**
 * Resolves `owner`, the record under `connectionId`, by the session state the route's reconcile read for any caller,
 * and answers the record still held, or null once it is released. While a call of the owner's is in flight, or one
 * Studio stopped waiting for still runs (`callsRunning`), no read resolves or releases it: the provider may report the
 * transaction open only because that call still runs, or closed because a COMMIT the route has not seen answer ended
 * it, or only because a BEGIN it still runs has not opened it yet. Once every such call has
 * settled, `not-in-transaction` releases it and records the end Studio found (`recordEndSeen`), `in-transaction` clears
 * `unresolved` without extending the lease, since another session's read is not the owner's action, and `unknown`
 * changes nothing. A read that began before the record was claimed, changed or ended (`mark`, taken before the read) is
 * not about it and changes nothing.
 */
export function resolveTransaction(
  connectionId: string,
  owner: TransactionOwner,
  state: SessionState,
  mark: TransactionMark,
): TransactionOwner | null {
  if (state === "unknown" || callsRunning(owner) || !unchangedSince(connectionId, mark)) return owner;
  if (state === "in-transaction") {
    if (owner.unresolved) {
      owner.unresolved = false;
      owner.generation += 1;
    }
    return owner;
  }
  if (owners().get(connectionId) === owner) owners().delete(connectionId);
  recordEndSeen(owner);
  return null;
}

/** Forget the owner: the transaction ended, or the provider ended it without a session. */
export function releaseTransaction(connectionId: string): void {
  owners().delete(connectionId);
}

/**
 * A transaction's owner key: per database on a server-level connection, whose databases each hold one (#1530), and
 * under governance per owner, the identity provider subject whose own provider holds it
 * (docs/GOVERNANCE.md#per-user-providers). Without an owner the key is byte-identical to the key before owners existed.
 */
export function transactionKey(connectionId: string, catalog?: string, owner?: string): string {
  if (owner !== undefined) return JSON.stringify([connectionId, catalog ?? null, owner]);
  return catalog === undefined ? connectionId : JSON.stringify([connectionId, catalog]);
}
