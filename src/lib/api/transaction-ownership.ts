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
 * begin resolved, and a request that resolves another key has the record released by `releaseIfProviderChanged`: the
 * route rolls the transaction back on the provider that holds it and answers 409 TRANSACTION_CREDENTIAL_CHANGED.
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
 */
import { randomUUID } from "node:crypto";
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
  recordEvent(owner, end, detail);
}

/** The terminal event of a transaction the provider ended on its own timer: no statement, ended now. */
export function recordTimedOut(owner: TransactionOwner): void {
  endTransactionEvent(owner, "timed-out", { statement: null, status: "cancelled", started: queryEventStart() });
}

/**
 * The live owner of `connectionId`'s transaction, or null when there is none on record or the
 * lease has lapsed. Reading is what expires a lapsed lease: there is no timer, so a process that
 * never asks again never pays for one. Under governance every provider rolls back after its own
 * `TX_TIMEOUT_MS` from BEGIN, which a lease measured from the last action never outlasts, so a lapsed
 * lease records the transaction as `timed-out` unless another path recorded its end.
 */
export function transactionOwner(connectionId: string): TransactionOwner | null {
  const owner = owners().get(connectionId);
  if (!owner) return null;
  if (Date.now() - owner.lastActiveAt >= OWNERSHIP_IDLE_MS) {
    owners().delete(connectionId);
    recordTimedOut(owner);
    return null;
  }
  return owner;
}

/**
 * Record `username`, and under governance its identity provider `subject`, the `providerKey` of the provider the
 * transaction runs on and the scope of its query `events`, as the owner, with a new `transactionId`. Called only after
 * `beginTransaction()` has actually succeeded. Returns the record.
 */
export function claimTransaction(
  connectionId: string,
  username: string,
  subject?: string,
  providerKey?: string,
  events?: TransactionEventScope,
): TransactionOwner {
  const now = Date.now();
  const owner: TransactionOwner = {
    username,
    subject,
    providerKey,
    startedAt: now,
    lastActiveAt: now,
    transactionId: randomUUID(),
    events,
    ended: false,
  };
  owners().set(connectionId, owner);
  return owner;
}

/**
 * Under governance, arms an unreferenced timer that records `owner`'s transaction as `timed-out` once
 * `TRANSACTION_TIMEOUT_CHECK_MS` have passed, when `owner` is still the record under `connectionId` and `stillOpen`,
 * the provider's `isInTransaction`, says the provider no longer holds a transaction: the provider rolled it back on its
 * own timer. The record stays for the route's reconcile to release. Without governance it arms nothing.
 */
export function watchTransactionTimeout(connectionId: string, owner: TransactionOwner, stillOpen: () => boolean): void {
  if (owner.events === undefined) return;
  const timer = setTimeout(() => {
    if (owners().get(connectionId) === owner && !stillOpen()) recordTimedOut(owner);
  }, TRANSACTION_TIMEOUT_CHECK_MS);
  // The check must never hold the process open on its own.
  timer.unref?.();
}

/**
 * Records `rolled-back` for every open transaction `subject` holds on the connection Studio names `connectionId`, in any
 * of its databases: the governance loader calls it for each pair whose providers it tears down, because the teardown
 * rolls those transactions back (docs/GOVERNANCE.md#per-user-providers). The records stay, so the owner's next request
 * still learns what happened.
 */
export function endOwnerTransactions(connectionId: string, subject: string): void {
  for (const owner of owners().values()) {
    if (owner.subject !== subject || owner.events?.connection.id !== connectionId) continue;
    endTransactionEvent(owner, "rolled-back", { statement: "ROLLBACK", status: "success", started: queryEventStart() });
  }
}

/**
 * Under governance, release the live record under `connectionId` when its begin resolved a provider other than
 * `providerKey`, the key the current request resolves, and answer the released record, whose `providerKey` is the key
 * it was opened on, so the caller can roll the transaction back on that provider; null when the record names this key,
 * names none, or there is no live record.
 *
 * Read and released in one synchronous step, so of two requests that arrive together only one is handed the record:
 * the other finds no record, and its own provider holds no transaction.
 */
export function releaseIfProviderChanged(
  connectionId: string,
  providerKey: string,
): (TransactionOwner & { readonly providerKey: string }) | null {
  const owner = transactionOwner(connectionId);
  if (owner?.providerKey === undefined || owner.providerKey === providerKey) return null;
  owners().delete(connectionId);
  // The record itself, never a copy, so a terminal event recorded through it marks the one record every path reads.
  return owner as TransactionOwner & { readonly providerKey: string };
}

/** Extend the owner's lease after an authorized action. A no-op when there is no record. */
export function touchTransaction(connectionId: string): void {
  const owner = owners().get(connectionId);
  if (owner) owner.lastActiveAt = Date.now();
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
