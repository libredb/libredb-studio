/**
 * The overview and health panels, read on the provider's metadata session only. Spark has no connection count, size,
 * cache ratio or index Studio can read, so those are declared, never estimated.
 */
import type { DatabaseOverview, HealthInfo } from "@/lib/db/types";
import { formatDuration } from "@/lib/db/utils/pool-manager";
import { SPARK_ERROR_SENTENCES, SparkError } from "./errors";

export interface SparkMonitoringDeps {
  /** AnalyzePlan `spark_version` on the metadata session: one round trip. */
  version(): Promise<string>;
  /** Config `get_all` under `prefix` on the metadata session, the prefix removed from every key, as Spark answers it. */
  confAll(prefix: string): Promise<Readonly<Record<string, string>>>;
  /** SHOW CURRENT NAMESPACE on the metadata session: the first row of Spark's answer, none when it answered none. */
  currentNamespace(): Promise<Readonly<Record<string, unknown>> | undefined>;
  /** The count of the tables that the listing of `namespace`, as Spark spells it, in `catalog` answers. */
  tableCount(catalog: string, namespace: string): Promise<number>;
}

/** The monitoring panels' own sentences. */
export const SPARK_MONITORING_LABELS: Readonly<{
  slowQueriesEmptyState: string;
  sessionsEmptyState: string;
  tablesRefused: string;
  storageRefused: string;
}> = {
  slowQueriesEmptyState:
    "Spark keeps finished statements in the driver's web UI, which Studio does not read in this version.",
  sessionsEmptyState:
    "Spark Connect sessions are listed in the driver's web UI, which Studio does not read in this version. Studio's own sessions last one request each, except the one for the tree and the panels, which Studio keeps while the connection is open.",
  tablesRefused:
    "Spark keeps table statistics only where its catalog stores them, and Studio does not read them in this version.",
  storageRefused: "Spark reports no storage figure Studio can read in this version.",
};

const NOT_AVAILABLE = "N/A";

const unreadable = (what: string) => new SparkError("unreadable", SPARK_ERROR_SENTENCES.unreadable(what));

/** A cell of SHOW CURRENT NAMESPACE's row, which Spark answers as text; anything else is unreadable. */
function cell(row: Readonly<Record<string, unknown>>, column: "catalog" | "namespace"): string {
  const value = row[column];
  if (typeof value !== "string") throw unreadable(`the ${column} column of Spark's answer`);
  return value;
}

/**
 * The version, the start time and uptime from `spark.app.`, and the count of the current namespace's tables. A catalog
 * can have no current namespace, which Spark spells as "": no listing can name it, so there is no count to report, and
 * the overview shows 0 tables with no sentence of what was counted, every other field as with a namespace.
 */
export async function readOverview(deps: SparkMonitoringDeps): Promise<DatabaseOverview> {
  const version = await deps.version();
  // Read in the provider's own session: a user session can override both keys for itself.
  const app = await deps.confAll("spark.app.");
  // Read as the tree reads it, so a missing row or cell is never taken for a catalog with no current namespace.
  const row = await deps.currentNamespace();
  if (row === undefined) throw unreadable("SHOW CURRENT NAMESPACE");
  const catalog = cell(row, "catalog");
  const namespace = cell(row, "namespace");
  const count = namespace === "" ? undefined : await deps.tableCount(catalog, namespace);
  const raw = app.startTime;
  const now = Date.now();
  // `spark.app.startTime` is epoch milliseconds. Any other text, and a start later than Studio's clock, claims no start
  // time, so the overview never shows a negative uptime. A start past the Date range is later than any clock, so it
  // never becomes an Invalid Date either.
  const read = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  const startMs = read <= now ? read : undefined;
  return {
    version,
    uptime: startMs === undefined ? NOT_AVAILABLE : formatDuration(now - startMs),
    ...(startMs === undefined ? {} : { startTime: new Date(startMs) }),
    maxConnections: 0,
    databaseSize: NOT_AVAILABLE,
    tableCount: count ?? 0,
    ...(count === undefined
      ? {}
      : { tableCountSampledFrom: `the tables of ${catalog}.${namespace}, the connection's current namespace` }),
    indexCount: 0,
  };
}

export async function readHealth(deps: Pick<SparkMonitoringDeps, "version">): Promise<HealthInfo> {
  await deps.version();
  return { databaseSize: NOT_AVAILABLE, cacheHitRatio: NOT_AVAILABLE, slowQueries: [], activeSessions: [] };
}
