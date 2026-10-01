/**
 * The reads of spec 7.1, each through the client slice it needs (spec 3.5, R12 CIC-11): the answering
 * member's `Status`, which the adapter sends without `hasleader` so a member without a leader still
 * answers it (spec 6.1); `Alarm` GET; a serializable `MemberList`; and `count_only` Ranges, each with
 * the limit of 1 every Range carries (E14), since etcd counts the whole range whatever the limit and
 * a count_only read sends no key back. monitoring.ts shapes every answer, and errors.ts's one table
 * raises every failure (spec 5.6).
 */
import { QueryError } from "@/lib/db/errors";
import type { DatabaseOverview, DatabaseType, HealthInfo, StorageStats, TableStats } from "@/lib/db/types";
import { type EtcdByteRange, type EtcdClient, EtcdError, type EtcdInt64 } from "./client";
import { type EtcdErrorContext, toProviderError } from "./errors";
import { ALL_KEYS, encodeKey, groupLabel, type PrefixGroup, prefixRangeEnd } from "./keys";
import { describeAlarm, toHealthInfo, toOverview, toStorageStats, toTableStats } from "./monitoring";
import { type EtcdSurfaceContext, surfaceErrorContext } from "./objects";
import { clipToScope, describeRange } from "./permissions";

const PROVIDER: DatabaseType = "etcd";

export type EtcdMonitoringClient = Pick<EtcdClient, "status" | "alarmList" | "memberList" | "range">;

/**
 * The count_only reads of getTableStats in flight at once (spec KE2), kept by Task 22's measurement on
 * 2026-10-01 (KE2: the 388 groups of a key space of 401,440 keys were counted in 350 ms).
 */
export const ETCD_TABLE_STATS_CONCURRENCY = 8;

/** One count_only read: its range, and how 5.6's sentences name it. */
interface CountPiece {
  readonly range: EtcdByteRange;
  readonly label: string;
}

/**
 * errors.ts's facts for one read of this module, as objects.ts states them for every surface: a context
 * that carries a principal names what the user may read, whatever its grants read (spec 4.7, 5.6).
 */
function readContext(context: EtcdSurfaceContext, command: string, range?: string): EtcdErrorContext {
  return surfaceErrorContext(context, command, range === undefined ? {} : { range });
}

/** One read, its failure raised through errors.ts's table (spec 5.6). */
async function read<T>(call: () => Promise<T>, errors: EtcdErrorContext): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toProviderError(error, errors);
  }
}

/**
 * `each` over `items` with at most `limit` in flight, the results in the items' order (spec KE2). After
 * the first failure no further item starts; the reads already in flight settle, and the first failure
 * is raised, so no read is left running and no rejection is left unhandled.
 */
async function inBoundedFlight<T, R>(items: readonly T[], limit: number, each: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  const failures: unknown[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (failures.length === 0 && next < items.length) {
      const index = next;
      next += 1;
      try {
        // oxlint-disable-next-line no-await-in-loop -- each worker holds one read in flight at a time, which is the bound.
        results[index] = await each(items[index]);
      } catch (error) {
        failures.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failures.length > 0) throw failures[0];
  return results;
}

/** One count_only Range: etcd counts the whole range whatever the limit, and sends no key back. */
async function countOne(
  client: EtcdMonitoringClient,
  context: EtcdSurfaceContext,
  piece: CountPiece,
): Promise<EtcdInt64> {
  const answer = await read(
    () => client.range({ ...piece.range, limit: 1, countOnly: true }, { signal: context.signal }),
    readContext(context, "key count", piece.label),
  );
  return answer.count;
}

/** The sum of one count_only per piece, KE2's reads in flight at most, as etcd's 64-bit decimal string. */
async function countKeys(
  client: EtcdMonitoringClient,
  context: EtcdSurfaceContext,
  pieces: readonly CountPiece[],
): Promise<EtcdInt64> {
  const counts = await inBoundedFlight(pieces, ETCD_TABLE_STATS_CONCURRENCY, (piece) =>
    countOne(client, context, piece),
  );
  return counts.reduce((sum, count) => sum + BigInt(count), BigInt(0)).toString();
}

/** The pieces of a range this context may read: the range itself for root or with auth off (spec 4.7). */
function readablePieces(range: EtcdByteRange, context: EtcdSurfaceContext): readonly EtcdByteRange[] {
  return context.readable.kind === "all" ? [range] : clipToScope(range, context.readable);
}

/** A group from its prefix, which the prefix walk always ends in "/" (spec 4.1). */
function groupOf(prefix: string): PrefixGroup {
  if (!prefix.endsWith("/")) {
    throw new QueryError(
      'A key-prefix group ends in "/", and one of the groups asked for does not, so it names no group this provider listed.',
      PROVIDER,
    );
  }
  const key = encodeKey(prefix);
  return { prefix, range: { key, rangeEnd: prefixRangeEnd(key) } };
}

/**
 * The answering member's health (spec 7.1). `HealthInfo` has no field for a lost quorum or an alarm,
 * and fleet-health reads a `getHealth` that returns as healthy, so both are raised: a `Status` whose
 * `leader` is 0 is 5.6's lost quorum, carrying `Status.errors` in etcd's words, before any `Alarm` GET
 * (R11 ETCD-3), and a raised alarm names every alarm the GET lists, which covers the whole cluster, as
 * etcdctl's own health probe reads it (spec 5.1.3).
 */
export async function readEtcdHealth(client: EtcdMonitoringClient, context: EtcdSurfaceContext): Promise<HealthInfo> {
  const status = await read(() => client.status({ signal: context.signal }), readContext(context, "status read"));
  if (status.leader === "0") {
    throw toProviderError(new EtcdError("no-leader", status.errors.join("; ")), readContext(context, "status read"));
  }
  const alarms = await read(() => client.alarmList({ signal: context.signal }), readContext(context, "alarm list"));
  if (alarms.length > 0) {
    throw new QueryError(
      `etcd reports active alarms: ${alarms.map(describeAlarm).join(", ")}. A cluster with an active alarm is not healthy: run alarm list to see every alarm, and an admin disarms them from the Global Operations cards of Admin > Operations once their cause is fixed.`,
      PROVIDER,
    );
  }
  return toHealthInfo(status);
}

/**
 * The overview (spec 7.1): `Status` for the version and the size, a serializable `MemberList` to name
 * the answering member, and the exact key count, one `count_only` over the key space, or one per
 * readable range for a user who is not root, whose count is then a floor that names its scope, whatever
 * its grants read (spec 4.7). The count is linearizable, so during a quorum loss it fails at once and
 * the monitoring route keeps the other panels.
 */
export async function readEtcdOverview(
  client: EtcdMonitoringClient,
  context: EtcdSurfaceContext,
): Promise<DatabaseOverview> {
  const status = await read(() => client.status({ signal: context.signal }), readContext(context, "status read"));
  const { members } = await read(
    () => client.memberList({ linearizable: false }, { signal: context.signal }),
    readContext(context, "member list"),
  );
  // Scoped where a refusal names what the user may read, so grants that read every key are one range.
  const scope = readContext(context, "key count").readable;
  if (scope === undefined) {
    const keyCount = await countKeys(client, context, [{ range: ALL_KEYS, label: "every key" }]);
    return toOverview({ status, members, keyCount });
  }
  const pieces = clipToScope(ALL_KEYS, context.readable).map((range) => ({ range, label: describeRange(range) }));
  const keyCount = await countKeys(client, context, pieces);
  const countScope = `the ranges etcd user ${scope.user} may read: ${scope.ranges}`;
  return toOverview({ status, members, keyCount, countScope });
}

/** One row for the answering member, from one `Status` read (spec 7.1). */
export async function readEtcdStorageStats(
  client: EtcdMonitoringClient,
  context: EtcdSurfaceContext,
): Promise<StorageStats[]> {
  return toStorageStats(
    await read(() => client.status({ signal: context.signal }), readContext(context, "status read")),
  );
}

/**
 * The Tables panel (spec 7.1): one `count_only` per prefix group over its readable intersection (spec
 * 4.7), read when the panel opens and never on connect, KE2's reads in flight at most. The groups are
 * disjoint (spec 4.1), so no key is counted twice; an undecided `F/*` group (R13 D9) is counted over
 * the prefix range of `F/` like any other. A failure names the group, never a grant's key (spec E13).
 */
export async function readEtcdTableStats(
  client: EtcdMonitoringClient,
  context: EtcdSurfaceContext,
  groupPrefixes: readonly string[],
): Promise<TableStats[]> {
  const groups = groupPrefixes.map((prefix) => groupOf(prefix));
  const pieces = groups.flatMap((group, index) =>
    readablePieces(group.range, context).map((range) => ({ index, range, label: groupLabel(group) })),
  );
  const counts = await inBoundedFlight(pieces, ETCD_TABLE_STATS_CONCURRENCY, (piece) =>
    countOne(client, context, piece),
  );
  const totals = groups.map(() => BigInt(0));
  pieces.forEach((piece, at) => {
    totals[piece.index] += BigInt(counts[at]);
  });
  return toTableStats(groups.map((group, index) => ({ group: groupLabel(group), count: totals[index].toString() })));
}
