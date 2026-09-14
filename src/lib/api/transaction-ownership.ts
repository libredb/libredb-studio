/**
 * Who opened the transaction that `POST /api/db/transaction` is holding open on a connection.
 *
 * The provider's transaction state (`txActive` / `txClient` in
 * `src/lib/db/providers/sql/postgres.ts`, and the equivalents in the mysql, mssql and oracle
 * providers) lives on the provider instance, and `getOrCreateProvider` caches one instance per
 * `connection.id`. Every Studio user who reaches that connection therefore drives ONE
 * transaction. Measured on PostgreSQL 18.4 on 2026-09-13, through the product's own route, two
 * sessions on one connection id: `user` opened a transaction and inserted a row, `admin` was
 * refused its own `begin` with HTTP 400 "Transaction already active", and was then allowed to
 * `rollback` with HTTP 200. The engine had zero rows afterwards and `user`'s own `commit` came
 * back "No active transaction". A second Studio user destroyed the first one's uncommitted work.
 *
 * SESSION means the authenticated account, `UserPayload.username` from the JWT the route already
 * has through `guardRoute`. That is the only stable identity field in the payload - the comment in
 * `require-session.ts` says so, and the rate limiter is keyed on it for the same reason. There is
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
 *     the transaction it names. When the provider reports no open transaction, the record is
 *     dropped and the connection is free.
 *  2. This lease expires after `OWNERSHIP_IDLE_MS` with no action from the owner. That is the
 *     release that matters for `MSSQLProvider` and `OracleProvider`, which have no timeout of
 *     their own: without it an abandoned transaction there would hold the connection for the life
 *     of the process. An open transaction with no live record is treated as unowned and any
 *     session may commit or roll it back, which is the escape hatch that makes the refusal safe.
 *
 * Measured against the provider timeouts rather than chosen: 5 minutes is `TX_TIMEOUT_MS` in both
 * providers that have one. It is measured from the owner's LAST action here, not from BEGIN,
 * because the question this lease answers is whether the owner has gone away, and activity is the
 * evidence for that.
 *
 * Process-local, like the provider cache it shadows. A restart drops every record, which lands on
 * the unowned case above rather than on a lockout.
 */

interface TransactionOwner {
  /** `UserPayload.username` of the session that ran the successful `begin`. */
  username: string;
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

/** Record `username` as the owner. Called only after `beginTransaction()` has actually succeeded. */
export function claimTransaction(connectionId: string, username: string): void {
  const now = Date.now();
  owners.set(connectionId, { username, startedAt: now, lastActiveAt: now });
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
