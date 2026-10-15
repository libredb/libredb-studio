/**
 * Which access a reload of the governance snapshot took away or changed (spec 4.3, 7.4, 14): the subject and connection
 * pairs whose providers Studio tears down once the new snapshot is in place.
 *
 * A pair is listed when its subject held an effective grant on the connection in the previous snapshot, judged at the
 * time that snapshot was loaded, and the next snapshot, judged at the caller's clock:
 *
 * - grants nothing: the grant row or the connection is gone, admission skipped the connection, or the grant expired
 *   since the previous load, which no notification announces;
 * - grants another level, in either direction, because the editor then opens the connection with another credential;
 * - opens the connection with a credential that was sealed again: the read envelope, which every grant opens, or the
 *   write envelope of a write grant. The control plane seals a credential again whenever it or the connection's
 *   definition changes (spec 8.4).
 *
 * A grant that only appeared, or a connection whose change opens nothing differently, such as a new name, lists
 * nothing, so a reload never closes a session it has no reason to close. `changedGrants` reads the two snapshots only.
 *
 * A removal that succeeds rolls back the open transactions of its pair, so for each pair whose removal succeeded
 * `endRevokedTransactions` looks up their ownership records and records each one's terminal `rolled-back` query event
 * (spec 7.9). A pair whose removal failed is not passed to it: its transaction may still be open.
 */
import { endOwnerTransactions } from "@/lib/api/transaction-ownership";
import { type EffectiveGrant, effectiveGrant, type GovernanceSnapshot } from "./state";

/** One subject's access to one connection, as the snapshot names them: the subject and the connection's own id. */
export interface ChangedGrant {
  readonly subject: string;
  readonly connectionId: string;
}

/** Whether `after` opens the connection exactly as `before` did: the same level, with the same sealed credentials. */
function opensTheSame(before: EffectiveGrant, after: EffectiveGrant): boolean {
  if (before.level !== after.level) return false;
  if (before.connection.envelopes.read !== after.connection.envelopes.read) return false;
  return before.level === "read" || before.connection.envelopes.write === after.connection.envelopes.write;
}

/**
 * The pairs whose access `next` took away or changed since `previous`, at `nowMs`, in the order of `previous`'s
 * grants.
 */
export function changedGrants(previous: GovernanceSnapshot, next: GovernanceSnapshot, nowMs: number): ChangedGrant[] {
  const changed: ChangedGrant[] = [];
  for (const [subject, grants] of previous.grants) {
    for (const connectionId of grants.keys()) {
      const before = effectiveGrant(previous, subject, connectionId, previous.loadedAt);
      // Expired when the previous snapshot loaded: an earlier reload listed it, if anything was opened under it.
      if (before === undefined) continue;
      const after = effectiveGrant(next, subject, connectionId, nowMs);
      if (after === undefined || !opensTheSame(before, after)) changed.push({ subject, connectionId });
    }
  }
  return changed;
}

/**
 * Records `rolled-back` for every open transaction of each pair in `changed`, whose providers the loader removed with
 * their transactions rolled back: a route resolves a governed connection under `seed:<id>`, and its subject owns them.
 * The loader passes only the pairs whose removal succeeded.
 * A transaction whose end was recorded already records nothing more.
 */
export function endRevokedTransactions(changed: readonly ChangedGrant[]): void {
  for (const { subject, connectionId } of changed) endOwnerTransactions(`seed:${connectionId}`, subject);
}
