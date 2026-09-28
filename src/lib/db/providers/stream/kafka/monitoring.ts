/**
 * Pure mappings to the monitoring types (spec 7.1). A surface that cannot give an
 * honest number is left empty rather than filled: the Kafka protocol reports neither
 * a product version nor a start time, so both are "N/A" (the duckdb, libsql and
 * sqlite uptime precedent), never a version guessed from API ranges.
 */
import type { DatabaseOverview, HealthInfo, StorageStats } from "@/lib/db/types";
import { formatBytes } from "@/lib/db/utils/pool-manager";
import { BIGINT_ZERO, KafkaError, type KafkaConfigEntry, type KafkaLogDir } from "./client";

const KAFKA_NOT_REPORTED = "N/A";
const KAFKA_CACHE_HIT_RATIO_UNAVAILABLE = "N/A";
const MAX_CONNECTIONS_CONFIG = "max.connections";

/**
 * The log-dir sum counts every replica on every broker, and only the partitions the metadata
 * lists, which leaves out the internal topics the client drops (spec 7.1): said with the number.
 */
function onDisk(logDirs: readonly KafkaLogDir[] | undefined): { text: string; bytes?: number } {
  if (logDirs === undefined) return { text: KAFKA_NOT_REPORTED };
  const bytes = Number(logDirs.reduce((sum, d) => sum + d.sizeBytes, BIGINT_ZERO));
  return { text: `${formatBytes(bytes)} on disk, all replicas, internal topics excluded`, bytes };
}

/**
 * The broker's published connection ceiling, or 0 where none is published, which is how
 * `DatabaseOverview.maxConnections` says "no limit published": no entry (the configs were
 * refused, KM4, and the caller passes none) or a value the broker withholds. A value that is
 * not a whole number is refused rather than read as either, the Prometheus provider's rule.
 */
function maxConnectionsFrom(brokerConfigs: readonly KafkaConfigEntry[]): number {
  const value = brokerConfigs.find((c) => c.name === MAX_CONNECTIONS_CONFIG)?.value ?? null;
  if (value === null) return 0;
  if (!/^\d+$/.test(value)) {
    throw new KafkaError(
      "protocol",
      `The broker published ${MAX_CONNECTIONS_CONFIG} as a value that is not a whole number`,
    );
  }
  return Number(value);
}

export function overviewFrom(input: {
  topicCount: number;
  brokerConfigs: readonly KafkaConfigEntry[];
  logDirs: readonly KafkaLogDir[] | undefined;
}): DatabaseOverview {
  const size = onDisk(input.logDirs);
  return {
    version: KAFKA_NOT_REPORTED,
    uptime: KAFKA_NOT_REPORTED,
    maxConnections: maxConnectionsFrom(input.brokerConfigs),
    databaseSize: size.text,
    ...(size.bytes === undefined ? {} : { databaseSizeBytes: size.bytes }),
    tableCount: input.topicCount,
    indexCount: 0,
  };
}

export function storageFrom(logDirs: readonly KafkaLogDir[] | undefined): StorageStats[] {
  return (logDirs ?? []).map((d) => {
    const row: StorageStats = {
      name: `broker ${d.brokerId}: ${d.path}`,
      location: d.path,
      size: formatBytes(Number(d.sizeBytes)),
      sizeBytes: Number(d.sizeBytes),
    };
    // A total or usable figure the broker does not report is -1: no percentage from it.
    if (d.totalBytes > BIGINT_ZERO && d.usableBytes >= BIGINT_ZERO) {
      row.usagePercent = Math.round((Number(d.totalBytes - d.usableBytes) / Number(d.totalBytes)) * 100);
    }
    return row;
  });
}

/**
 * Health reads only what any principal that can connect can read: metadata (by the
 * caller) and, where allowed, log dirs. It does NOT read broker configs: a principal
 * without the Describe Cluster ACL gets CLUSTER_AUTHORIZATION_FAILED there (measured
 * M-I), and health must not report a reachable cluster as down for a permission.
 */
export function healthFrom(logDirs: readonly KafkaLogDir[] | undefined): HealthInfo {
  return {
    databaseSize: onDisk(logDirs).text,
    cacheHitRatio: KAFKA_CACHE_HIT_RATIO_UNAVAILABLE,
    slowQueries: [],
    activeSessions: [],
  };
}
