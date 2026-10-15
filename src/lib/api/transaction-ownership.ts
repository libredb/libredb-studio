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
 * UNDER GOVERNANCE EVERY USER HAS A PROVIDER OF THEIR OWN (spec 9.4), and so a transaction of their
 * own: the provider's cache key frames the owner the execution context names, the session's
 * identity provider subject, and `transactionKey` frames the same owner, so one user neither sees
 * nor joins another user's transaction, and every record under such a key is that user's. Both keys
 * gain the owner together (spec 3.2 D7): a record shared across users' own providers would let a
 * user whose provider holds no transaction drop another user's record on the reconcile below.
 *
 * A CREDENTIAL THAT CHANGES UNDER AN OPEN TRANSACTION, under governance (spec 9.4). A governed request
 * opens the connection with the credential of the caller's grant level, and the provider's cache key
 * frames that credential, so a grant downgraded from write to read, or a credential the control plane
 * sealed again, resolves a provider other than the one the transaction was opened on. So the record
 * keeps the provider cache key its begin resolved, and a request that resolves another key has the
 * record released by `releaseIfProviderChanged`: the route rolls the transaction back on the provider
 * that holds it and answers 409 TRANSACTION_CREDENTIAL_CHANGED. Without that, the reconcile below would
 * drop the record because the NEW provider holds no transaction, and the old one would stay open under a
 * credential its owner no longer holds, on a provider their requests no longer reach.
 *
 * SESSION means the authenticated account, `UserPayload.username` from the JWT the route already
 * has through `guardRoute`. That is the only stable identity field in the payload - the comment in
 * `require-session.ts` says so, and the rate limiter is keyed on it for the same reason. Under
 * governance it is the identity provider subject instead, which the record keeps beside the
 * username, because there the username is a display label that can change (spec 3.2 D2). There is
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
 *     governance sets (spec 9.4). When the provider reports no open transaction, the record is
 *     dropped and the connection is free.
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
 * the unowned case above rather than on a lockout.
 */

interface TransactionOwner {
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
}

/** See the "owner never comes back" note above: this is `TX_TIMEOUT_MS`, measured. */
export const OWNERSHIP_IDLE_MS = 5 * 60 * 1000;

const owners = new Map<string, TransactionOwner>();

/**
 * The live owner of `connectionId`'s transaction, or null when there is none on record or the
 * lease has lapsed. Reading is what expires a lapsed lease: there is no timer, so a process that
 * never asks again never pays for one.
 */
export function transactionOwner(connectionId: string): TransactionOwner | null {
  const owner = owners.get(connectionId);
  if (!owner) return null;
  if (Date.now() - owner.lastActiveAt >= OWNERSHIP_IDLE_MS) {
    owners.delete(connectionId);
    return null;
  }
  return owner;
}

/**
 * Record `username`, and under governance its identity provider `subject` and the `providerKey` of the provider the
 * transaction runs on, as the owner. Called only after `beginTransaction()` has actually succeeded.
 */
export function claimTransaction(connectionId: string, username: string, subject?: string, providerKey?: string): void {
  const now = Date.now();
  owners.set(connectionId, { username, subject, providerKey, startedAt: now, lastActiveAt: now });
}

/**
 * Under governance, release the live record under `connectionId` when its begin resolved a provider other than
 * `providerKey`, the key the current request resolves, and answer the key it was opened on, so the caller can roll the
 * transaction back on that provider; null when the record names this key, names none, or there is no live record.
 *
 * Read and released in one synchronous step, so of two requests that arrive together only one is handed the key: the
 * other finds no record, and its own provider holds no transaction.
 */
export function releaseIfProviderChanged(connectionId: string, providerKey: string): string | null {
  const opened = transactionOwner(connectionId)?.providerKey;
  if (opened === undefined || opened === providerKey) return null;
  owners.delete(connectionId);
  return opened;
}

/** Extend the owner's lease after an authorized action. A no-op when there is no record. */
export function touchTransaction(connectionId: string): void {
  const owner = owners.get(connectionId);
  if (owner) owner.lastActiveAt = Date.now();
}

/** Forget the owner: the transaction ended, or the provider ended it without a session. */
export function releaseTransaction(connectionId: string): void {
  owners.delete(connectionId);
}

/**
 * A transaction's owner key: per database on a server-level connection, whose databases each hold one (#1530), and
 * under governance per owner, the identity provider subject whose own provider holds it (spec 9.4). Without an owner
 * the key is byte-identical to the key before owners existed.
 */
export function transactionKey(connectionId: string, catalog?: string, owner?: string): string {
  if (owner !== undefined) return JSON.stringify([connectionId, catalog ?? null, owner]);
  return catalog === undefined ? connectionId : JSON.stringify([connectionId, catalog]);
}
