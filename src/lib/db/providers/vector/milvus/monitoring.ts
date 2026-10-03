/**
 * Pure mappings for the Milvus provider's monitoring: the Tables rows
 * from GetCollectionStatistics, the index rows from DescribeIndex, the overview, health from CheckHealth, and the one
 * parse of GetMetrics, whose allowlist keeps per query node only its role and id, its memory, its memory in use and the
 * data loaded on it, and drops node addresses, `collection_metrics` and every other `quota_metrics` field, whose
 * `CollectionRows` names other databases' collections. A figure Milvus does not report is absent or "N/A",
 * never a zero that reads as a measurement, except the required `totalSizeBytes`, which carries 0 beside "N/A" as
 * etcd's and Prometheus's rows do.
 *
 * Pure: it receives answers and never a client. monitoring-reads.ts and maintenance.ts make the reads.
 */
import { QueryError } from "@/lib/db/errors";
import type { DatabaseOverview, DatabaseType, HealthInfo, IndexStats, TableStats } from "@/lib/db/types";
import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";
import { serverText } from "@/lib/db/utils/server-text";
import type { CheckHealthResponse, WireIndexDescription, WireKeyValuePair } from "./client";
import { indexParam } from "./schema";

const PROVIDER: DatabaseType = "milvus";

/** What Milvus does not report, in the words the monitoring panels already render. */
export const NOT_REPORTED = "N/A";

/** How a GetCollectionStatistics row count is labelled wherever it is shown. */
export const ROW_COUNT_ESTIMATE = "estimate: flushed segments only, deletes not subtracted, may lag recent inserts";

const BINARY_UNITS: readonly string[] = ["KiB", "MiB", "GiB", "TiB", "PiB"];
const QUERY_NODE = "querynode";
const LOAD_STATE_PREFIX = "LoadState";

/** GetCollectionStatistics' `row_count`, or undefined when the answer carries none. */
export function statisticsRowCount(stats: readonly WireKeyValuePair[]): string | undefined {
  return stats.find((pair) => pair.key === "row_count")?.value;
}

/** A byte count as the preview writes it: "512 bytes", "925.0 MiB", "4.0 GiB". */
export function formatMilvusBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString("en-US")} bytes`;
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < BINARY_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BINARY_UNITS[unit]}`;
}

/** A GetLoadState answer in Milvus's own word: `LoadStateLoaded` is "Loaded", `LoadStateNotLoad` is "NotLoad". */
export function loadStateWord(state: string): string {
  return state.startsWith(LOAD_STATE_PREFIX) ? state.slice(LOAD_STATE_PREFIX.length) : state;
}

/** One collection's GetCollectionStatistics estimate. */
export interface CollectionRowCount {
  readonly collection: string;
  readonly rowCount: string;
}

/**
 * The Tables rows: `schemaName` the database, `tableName` the collection, `rowCount` the estimate as a
 * number, `totalSize` "N/A" and `totalSizeBytes` 0, the etcd and Prometheus shape. The estimate and the 200 bound are
 * stated by `tableStatsCaption`, because `TableStats` has no per-row label.
 */
export function toMilvusTableStats(database: string, rows: readonly CollectionRowCount[]): TableStats[] {
  return rows.map((row) => ({
    schemaName: database,
    tableName: row.collection,
    rowCount: Number(row.rowCount),
    totalSize: NOT_REPORTED,
    totalSizeBytes: 0,
  }));
}

/**
 * The index rows: one per index, the native `index_type` as reported (AUTOINDEX as AUTOINDEX), the one field,
 * never unique or primary, no size and no scan count, the shape of an engine that publishes neither. The metric, the
 * build state and the indexed, total and pending rows have no slot here and are in the collection's Source.
 */
export function toMilvusIndexStats(
  database: string,
  collection: string,
  indexes: readonly WireIndexDescription[],
): IndexStats[] {
  return indexes.map((index) => {
    const indexType = indexParam(index, "index_type");
    return {
      schemaName: database,
      tableName: collection,
      indexName: index.index_name,
      ...(indexType === undefined ? {} : { indexType }),
      columns: [index.field_name],
      isUnique: false,
      isPrimary: false,
      indexSize: NOT_REPORTED,
      scans: 0,
    };
  });
}

export interface MilvusOverviewInput {
  /** GetVersion's answer at connect, or undefined where Studio could not read one. */
  readonly version: string | undefined;
  readonly database: string;
  /** The selected database's collections, as ShowCollections lists them for this user. */
  readonly collections: number;
  /** The index rows of the Tables bound. */
  readonly indexes: number;
}

/**
 * The overview: the version, the selected database's collections, which ShowCollections lists only where the
 * user holds a privilege, so the count is named "visible to this Milvus user", and the index rows of the same
 * 200-collection bound. Milvus publishes no connection count, size or uptime here, so `activeConnections` is absent.
 */
export function toMilvusOverview(input: MilvusOverviewInput): DatabaseOverview {
  return {
    version: input.version ?? NOT_REPORTED,
    uptime: NOT_REPORTED,
    maxConnections: 0,
    databaseSize: NOT_REPORTED,
    tableCount: input.collections,
    tableCountSampledFrom: `the collections of database ${input.database} visible to this Milvus user`,
    indexCount: input.indexes,
  };
}

/** CheckHealth's verdict: a server that says it is not healthy is raised with its reasons after Studio's words. */
export function toMilvusHealth(answer: CheckHealthResponse, secretForms: readonly string[]): HealthInfo {
  if (!answer.isHealthy) {
    const reasons = answer.reasons.map((reason) => serverText(reason, secretForms)).join("; ");
    throw new QueryError(`Milvus reports that it is not healthy${reasons === "" ? "." : `: ${reasons}`}`, PROVIDER);
  }
  return { databaseSize: NOT_REPORTED, cacheHitRatio: NOT_REPORTED, slowQueries: [], activeSessions: [] };
}

/** One query node of a GetMetrics answer, after the allowlist. */
export interface QueryNodeMemory {
  readonly role: "querynode";
  readonly id: string;
  /** `hardware_infos.memory`: in standalone, the whole process's limit. */
  readonly memory?: number;
  /** `hardware_infos.memory_usage`: in standalone, the whole process's use. */
  readonly memoryUsage?: number;
  /** `quota_metrics.LoadedBinlogSize`: the data loaded on the node. */
  readonly loadedBinlogSize?: number;
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** A byte count: a non-negative number, or the exact digits `quoteUnsafeIntegers` kept for one past 2^53. */
function figure(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  return undefined;
}

/**
 * GetMetrics(system_info) to the allowlist: per query node, its role and id, `hardware_infos.memory`,
 * `hardware_infos.memory_usage` and `quota_metrics.LoadedBinlogSize`, and nothing else. The JSON is read through
 * `quoteUnsafeIntegers`, so an integer past 2^53 is read from its digits. Text that is not the system_info shape is
 * refused in Studio's words.
 */
export function readSystemInfo(response: string): QueryNodeMemory[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(quoteUnsafeIntegers(response));
  } catch {
    throw new QueryError(
      "Milvus answered GetMetrics with text that is not JSON, so Studio reads no memory figure from it.",
      PROVIDER,
    );
  }
  const nodes = objectOf(parsed)?.nodes_info;
  if (!Array.isArray(nodes)) {
    throw new QueryError(
      "Milvus answered GetMetrics with no node list, so Studio reads no memory figure from it.",
      PROVIDER,
    );
  }
  const queryNodes: QueryNodeMemory[] = [];
  for (const node of nodes) {
    const infos = objectOf(objectOf(node)?.infos);
    if (infos?.type !== QUERY_NODE) continue;
    const hardware = objectOf(infos.hardware_infos);
    const quota = objectOf(infos.quota_metrics);
    const memory = figure(hardware?.memory);
    const memoryUsage = figure(hardware?.memory_usage);
    const loadedBinlogSize = figure(quota?.LoadedBinlogSize);
    const id = typeof infos.id === "number" || typeof infos.id === "string" ? String(infos.id) : "unknown";
    queryNodes.push({
      role: QUERY_NODE,
      id,
      ...(memory === undefined ? {} : { memory }),
      ...(memoryUsage === undefined ? {} : { memoryUsage }),
      ...(loadedBinlogSize === undefined ? {} : { loadedBinlogSize }),
    });
  }
  return queryNodes;
}
