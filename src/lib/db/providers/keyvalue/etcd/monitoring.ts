/**
 * Pure mappings from etcd's `Status`, `MemberList` and `Alarm` answers to the monitoring types (spec
 * 7.1). A figure no RPC reports is left out or said to be unknown rather than filled: etcd reports no
 * start time and no cache ratio, so both read "N/A" as Kafka's do (Kafka KM3), and no connection
 * count, so `activeConnections` is absent, which is a different fact from zero.
 *
 * Pure (spec 3.1): it receives answers and never a client (spec 3.5), and imports the shared types,
 * keys.ts for a member's hex id, and types from client.ts. monitoring-reads.ts makes the reads, and
 * maintenance.ts words its messages with the three namers this module exports.
 */
import type { DatabaseOverview, HealthInfo, StorageStats, TableStats } from "@/lib/db/types";
import type { EtcdAlarm, EtcdInt64, EtcdMember, EtcdStatus } from "./client";
import { memberHexId } from "./keys";

/** "2147483648": a quota of 0 means the 2 GiB default (R06 2.9). */
export const ETCD_DEFAULT_QUOTA_BYTES: EtcdInt64 = "2147483648";

/** What etcd does not report, in the words the monitoring panels already render (Kafka KM3). */
const NOT_REPORTED = "N/A";

const BINARY_UNITS: readonly string[] = ["KiB", "MiB", "GiB", "TiB", "PiB"];

/** A byte count as spec 7.2's messages write it: "512 bytes", "310 MiB", "1.2 GiB". */
export function formatEtcdBytes(bytes: EtcdInt64): string {
  let value = Number(bytes);
  if (value < 1024) return `${value.toLocaleString("en-US")} bytes`;
  let unit = -1;
  while (value >= 1024 && unit < BINARY_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Number(value.toFixed(1)).toLocaleString("en-US")} ${BINARY_UNITS[unit]}`;
}

/**
 * A member as the tree names it (spec 4.1): "<name> (<hex id>)", or the hex id alone when the member
 * has no name, as an unstarted one has not, or is not in the list.
 */
export function memberLabel(memberId: EtcdInt64, members: readonly EtcdMember[]): string {
  const hex = memberHexId(memberId);
  const name = members.find((member) => member.id === memberId)?.name;
  return name === undefined || name === "" ? hex : `${name} (${hex})`;
}

/** One raised alarm, its type as etcd prints it on the member the tree names: "NOSPACE on member 8e9e05c52164694d". */
export function describeAlarm(alarm: EtcdAlarm): string {
  return `${alarm.alarm.toUpperCase()} on member ${memberHexId(alarm.memberId)}`;
}

/** The answering member's size on disk, the one figure `HealthInfo` carries for etcd (spec 7.1). */
export function toHealthInfo(status: EtcdStatus): HealthInfo {
  return {
    databaseSize: `${formatEtcdBytes(status.dbSize)} on disk, the answering member`,
    cacheHitRatio: NOT_REPORTED,
    slowQueries: [],
    activeSessions: [],
  };
}

/** What the overview is built from; `countScope` only for a user who is not root (spec 4.7, 7.1). */
export interface EtcdOverviewInput {
  readonly status: EtcdStatus;
  readonly members: readonly EtcdMember[];
  readonly keyCount: EtcdInt64;
  /** Set for a user who is not root: "the ranges etcd user <name> may read: <ranges>" (spec 7.1). */
  readonly countScope?: string;
}

/**
 * The version, the exact key count and the answering member's size, that member named from the
 * serializable `MemberList` (spec 7.1). `tableCount` is the key count, the Redis precedent; for a user
 * who is not root it counts only the ranges that user may read, a floor, so `tableCountSampledFrom`
 * names them and the Tables card draws "N+" (R11 CF-19), while a count as root carries no such field.
 * `maxConnections` is 0, "no limit published", and nothing in etcd is an index.
 */
export function toOverview(input: EtcdOverviewInput): DatabaseOverview {
  const { status, members, keyCount, countScope } = input;
  const size = formatEtcdBytes(status.dbSize);
  const answering = memberLabel(status.header.memberId, members);
  return {
    version: status.version,
    uptime: NOT_REPORTED,
    maxConnections: 0,
    databaseSize: `${size} on disk, the answering member ${answering}`,
    databaseSizeBytes: Number(status.dbSize),
    tableCount: Number(keyCount),
    ...(countScope === undefined ? {} : { tableCountSampledFrom: countScope }),
    indexCount: 0,
  };
}

/**
 * One row for the answering member (spec 7.1): its size on disk and in use, and `usagePercent`, its
 * size on disk over the quota, a quota of 0 read as the 2 GiB default (R06 2.9). `StorageStats` has no
 * field for the size in use, so the row's size text carries it beside the size on disk.
 */
export function toStorageStats(status: EtcdStatus): StorageStats[] {
  const quota = status.dbSizeQuota === "0" ? ETCD_DEFAULT_QUOTA_BYTES : status.dbSizeQuota;
  return [
    {
      name: `member ${memberHexId(status.header.memberId)}`,
      location: "the member this connection reaches",
      size: `${formatEtcdBytes(status.dbSize)} on disk, ${formatEtcdBytes(status.dbSizeInUse)} in use`,
      sizeBytes: Number(status.dbSize),
      usagePercent: (Number(status.dbSize) / Number(quota)) * 100,
    },
  ];
}

/** One prefix group's exact key count, as monitoring-reads.ts reads it (spec 7.1). */
export interface EtcdGroupCount {
  readonly group: string;
  readonly count: EtcdInt64;
}

/**
 * The Tables panel's rows: one per prefix group, named as the tree names it, with its exact key count
 * (spec 7.1). No RPC reports a group's bytes, so `totalSize` reads "N/A" beside the 0 the required
 * `totalSizeBytes` carries and `tableSize` stays absent, the Prometheus shape the Tables and Storage
 * tabs read as unknown; a group sits in no container, so `schemaName` is empty, as Prometheus's is.
 */
export function toTableStats(counts: readonly EtcdGroupCount[]): TableStats[] {
  return counts.map((entry) => ({
    schemaName: "",
    tableName: entry.group,
    rowCount: Number(entry.count),
    totalSize: NOT_REPORTED,
    totalSizeBytes: 0,
  }));
}
