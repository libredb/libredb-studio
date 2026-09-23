/**
 * Prometheus monitoring surfaces (#1085, section 6.2).
 *
 * Pure mappings from the seam's status reads to the shared monitoring types, and the four readers
 * the provider composes them from. Each surface reads the HTTP API only, and a surface that cannot
 * give an honest number is left empty rather than filled: this API publishes no database size, no
 * byte figure for what is stored, no cache hit ratio, no session list and no query log, so those
 * read "N/A", stay absent or answer `[]`, and the numbers it does publish are framed as exactly
 * what the engine measured.
 *
 * The readers take `MonitoringTransport`, the read-only slice of the seam they use (#1085 3.5,
 * interface segregation), so this file names no endpoint and no envelope member: a health probe's
 * path is read off the probe the transport recorded.
 *
 * A sentence about what the server answered or reported names the server, never Prometheus,
 * because a wire-compatible relative such as VictoriaMetrics answers these reads through this
 * provider too.
 */
import type { DatabaseOverview, HealthInfo, StorageStats, TableStats } from "@/lib/db/types";
import { CACHE_HIT_RATIO_UNAVAILABLE } from "@/lib/monitoring-cache-ratio";
import {
  type HealthProbe,
  type PrometheusBuildInfo,
  type PrometheusHeadBlock,
  type PrometheusHealth,
  type PrometheusRuntimeInfo,
  type PrometheusTransport,
  PrometheusTransportError,
  type PrometheusTsdbStatus,
} from "./transport";

/**
 * How many metrics the Tables panel lists: the top N by head-block series, in the order the TSDB
 * status ranks them. The panel is the only place a series count appears, because a metric row in
 * the tree carries none (#1085 4.3). The provider's `tableStatsCaption` label names this bound, so
 * the Tables tab heads the rows with it and counts them as listed rather than as the database's
 * tables, and the agent's table-stats reading carries it to the model (#1085 6.2).
 */
export const TSDB_TOP_METRICS = 50;

/**
 * The largest `limit` one TSDB status read accepts: `serveTSDBStatus` answers `bad_data` above
 * 10,000 (`web/api/v1/api.go` at v3.13.3, `maxTSDBLimit`). The metric count is read with it,
 * because the list that count comes from is cut at the limit, and the longest list is the one
 * least likely to have cut the metric-name entry (see `metricNameCount`).
 */
export const TSDB_LABEL_SCAN_LIMIT = 10_000;

export type MonitoringTransport = Pick<
  PrometheusTransport,
  "health" | "buildInfo" | "runtimeInfo" | "flags" | "tsdbStatus"
>;

/**
 * The schema a metric is reported under: none. Prometheus has no namespace above a metric, so the
 * empty string is the engine's own answer rather than a placeholder, the search provider's
 * precedent for an engine with no container (`SEARCH_SCHEMA_NAME`), and it renders as no prefix in
 * the monitoring tabs. The provider's `getTableStats` answers `[]` for any other schema it is asked
 * for, because no metric can be in one.
 */
export const PROMETHEUS_SCHEMA_NAME = "";

/** The label every series carries its metric name under: its distinct values are the metric names. */
const METRIC_NAME_LABEL = "__name__";

/**
 * What a figure this API does not publish reads as: the spelling the search provider uses for an
 * unmeasured size and `CACHE_HIT_RATIO_UNAVAILABLE` uses for an unmeasured ratio, so every "not
 * measured" in the monitoring tabs reads alike.
 */
const PROMETHEUS_UNKNOWN_TEXT = "N/A";

/** The flag that publishes the ceiling on concurrent HTTP connections, by the engine's own name. */
const MAX_CONNECTIONS_FLAG = "web.max-connections";

/**
 * The head block's distinct metric names, or undefined where the status does not carry that
 * number (M2).
 *
 * The TSDB status counts the distinct values of every label name in the head block, lists the
 * label names with the most values first, and cuts that list at the `limit` it was read with,
 * silently: no warning is sent (`tsdb/index/postings.go`, `MemPostings.Stats`, at v3.13.3). The cut
 * drops whole entries and never shortens one, because every entry it keeps carries its label's full
 * value count, so a listed metric-name entry is exact at any length of the list. Without the entry,
 * a list shorter than its limit was not cut and holds no metric name at all, which is 0; a list
 * that reached its limit may have cut the entry, and only there is the count undefined. It is never
 * the list's length, which counts label names. `tests/fixtures/prometheus/README.md`, section
 * "Measurements", entry M2, records that on the compose server the entry of a list cut at 10 equals
 * the entry of the whole list.
 */
export function metricNameCount(tsdb: PrometheusTsdbStatus, limit: number): number | undefined {
  const entry = tsdb.valuesByLabel.find((candidate) => candidate.name === METRIC_NAME_LABEL);
  if (entry !== undefined) return entry.value;
  return tsdb.valuesByLabel.length < limit ? 0 : undefined;
}

/**
 * The overview, from the build, runtime and flag reads and an exact metric count.
 *
 * `version` is the engine's own string. `uptime` runs from the runtime read's start time to its
 * server time, two readings of the server's own clock, so a skew between that clock and this
 * process's cannot move it. A server time before the start time means the server's clock stepped
 * back after it started, which is no uptime at all, so it reads "N/A", the way Cassandra's overview
 * reads an uptime it cannot compute (`sql/cassandra/introspect.ts`), while `startTime` still carries
 * what the server said. No figure here reads this process's clock, so none takes one.
 * `maxConnections` is `--web.max-connections`, a real published ceiling. `databaseSize` is not
 * measurable through this API, so it reads "N/A" with `databaseSizeBytes` absent, the search
 * provider's shape (`SearchProvider.getOverview`); `indexCount` is 0 because the engine has no
 * index object, the Redis precedent (`RedisProvider.getOverview`); `activeConnections` is absent
 * because nothing here counts open connections. `tableCount` is the metric count.
 */
export function overviewFrom(input: {
  readonly build: PrometheusBuildInfo;
  readonly runtime: PrometheusRuntimeInfo;
  readonly flags: Readonly<Record<string, string>>;
  readonly metricCount: number;
  readonly formatDuration: (ms: number) => string;
}): DatabaseOverview {
  const startMs = runtimeTimestamp(input.runtime.startTime, "start time");
  const upForMs = runtimeTimestamp(input.runtime.serverTime, "server time") - startMs;
  return {
    version: input.build.version,
    uptime: upForMs < 0 ? PROMETHEUS_UNKNOWN_TEXT : input.formatDuration(upForMs),
    startTime: new Date(startMs),
    maxConnections: maxConnectionsFrom(input.flags),
    databaseSize: PROMETHEUS_UNKNOWN_TEXT,
    tableCount: input.metricCount,
    indexCount: 0,
  };
}

/** A runtime read's timestamp in milliseconds; text the engine did not write as one is refused by name. */
function runtimeTimestamp(text: string, what: string): number {
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) {
    throw new PrometheusTransportError("protocol", `The server reported a ${what} that is not a timestamp`);
  }
  return ms;
}

/**
 * The published connection ceiling, or 0 where no flag publishes one, which is how
 * `DatabaseOverview.maxConnections` says "no limit published". The flag map is keyed by server
 * text, so it is read with `Object.hasOwn`, and a value that is not a whole number is refused
 * rather than read as either.
 */
function maxConnectionsFrom(flags: Readonly<Record<string, string>>): number {
  if (!Object.hasOwn(flags, MAX_CONNECTIONS_FLAG)) return 0;
  const text = flags[MAX_CONNECTIONS_FLAG];
  if (!/^\d+$/.test(text)) {
    throw new PrometheusTransportError(
      "protocol",
      `The server published ${MAX_CONNECTIONS_FLAG} as a value that is not a whole number`,
    );
  }
  return Number(text);
}

/**
 * The top metrics by head-block series, as the Tables panel's rows.
 *
 * `rowCount` is the metric's series count in the head block, a number the engine counted. No byte
 * figure per metric exists anywhere in this API, so `totalSize` reads "N/A" beside the 0 the
 * required `totalSizeBytes` has to carry, and the optional `tableSize` pair stays absent: that
 * absence is what the Tables and Storage tabs read to draw "N/A" and "-" rather than summing the
 * zeros, the SQLite and libSQL shape for a table whose bytes are unknown. At most
 * `TSDB_TOP_METRICS` rows, whatever limit the status was read with; the provider's
 * `tableStatsCaption` names that bound, and the Tables panel counts the rows as listed under it.
 * Only the ranked list is read, so a status with no head statistics lists its rows all the same.
 */
export function tableStatsFrom(tsdb: PrometheusTsdbStatus): TableStats[] {
  return tsdb.seriesByMetric.slice(0, TSDB_TOP_METRICS).map((entry) => ({
    schemaName: PROMETHEUS_SCHEMA_NAME,
    tableName: entry.name,
    rowCount: entry.value,
    totalSize: PROMETHEUS_UNKNOWN_TEXT,
    totalSizeBytes: 0,
  }));
}

/** Why the storage row is refused where the TSDB status carries no head statistics. */
const NO_HEAD_STATISTICS =
  "The server reports no head block statistics: its TSDB status carries none, so the storage row has no " +
  "series count, chunk count or sample span to show";

/**
 * The head block as the one storage row this API can describe, with no byte figure in it.
 *
 * The TSDB status publishes the head block's series and chunk counts and the span its samples
 * cover, and the runtime read publishes the retention; neither publishes a byte count of what is
 * stored. So the row says what the head holds, in the engine's own units, in its name, and when and
 * for how long in its location, while `size` reads "N/A" beside the 0 the required `sizeBytes` has
 * to carry, the shape the Trino provider gives a store with no byte figure. `usagePercent` is
 * absent because no capacity crosses this API either. An empty head reports the int64 extremes the
 * engine starts it at (`tsdb/head.go`, `resetInMemoryState`: the minimum above the maximum), which
 * is no span and no date, so it reads "no samples".
 *
 * A status with no head statistics, the one VictoriaMetrics answers, leaves this row nothing to
 * describe, and it is refused with that fact rather than answered: an empty list would read as a
 * server that measured no storage, and a row of zeros as an empty head, and `MonitoringData`
 * (`src/lib/db/types.ts`) keeps a panel the engine could not answer apart from an empty one for
 * exactly that reason.
 */
export function storageStatsFrom(tsdb: PrometheusTsdbStatus, runtime: PrometheusRuntimeInfo): StorageStats[] {
  const head = tsdb.head;
  if (head === undefined) throw new PrometheusTransportError("unmeasurable", NO_HEAD_STATISTICS);
  return [
    {
      name: `Head block: ${formatCount(head.series)} series, ${formatCount(head.chunks)} chunks`,
      location: `${headSpan(head)}, retention ${runtime.storageRetention}`,
      size: PROMETHEUS_UNKNOWN_TEXT,
      sizeBytes: 0,
    },
  ];
}

/** The span the head's samples cover, as two ISO-8601 instants, or "no samples" for an empty head. */
function headSpan(head: PrometheusHeadBlock): string {
  if (head.minTimeMs > head.maxTimeMs) return "no samples";
  return `${new Date(head.minTimeMs).toISOString()} to ${new Date(head.maxTimeMs).toISOString()}`;
}

/** A count grouped in `en-US`, so the text reads the same in every test and every screenshot. */
function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** The answer every health probe must give. */
const HEALTHY_STATUS = 200;

/** The answer that says a probe's path does not exist on this server. */
const NOT_FOUND_STATUS = 404;

/**
 * How many probes a health read records when liveness answered 404: that 404, the fallback probe
 * it sent, then readiness. The transport sends the fallback only then, so a read of any other
 * length carries no fallback and supersedes nothing.
 */
const PROBES_WITH_FALLBACK = 3;

/**
 * Health, judged from the probe answers alone and never from which product answered (#1085 6.2).
 *
 * The transport records every probe in the order it sent them: liveness, then readiness, and
 * between the two a `/health` fallback only when liveness answered 404, the answer that says the
 * path does not exist here. That 404 is superseded by the fallback that followed it. It is
 * recognised by position rather than by path, because this file names no endpoint: it is the first
 * probe of a read that recorded three. Every other probe must answer 200, and the first one that
 * answered neither 200 nor a superseded 404 is named with its path and status. A 401 or 403 never
 * reaches this function: the transport raises either as `unauthorized` instead of recording it. A
 * read that carries no probe has nothing to judge, which is a fault in the answer rather than in
 * the server. What this API cannot measure is not filled in: no size, no cache hit ratio, no slow
 * query, no session, and no `activeConnections` key.
 */
export function healthFrom(health: PrometheusHealth): HealthInfo {
  if (health.probes.length === 0) {
    throw new PrometheusTransportError("protocol", "The Prometheus health read carried no probe answer to judge");
  }
  const failed = health.probes.find(
    (probe, index, probes) => probe.status !== HEALTHY_STATUS && !superseded(probe, index, probes),
  );
  if (failed !== undefined) {
    throw new PrometheusTransportError(
      "unavailable",
      `The server answered its health probe ${failed.path} with HTTP ${failed.status}`,
      { status: failed.status },
    );
  }
  return {
    databaseSize: PROMETHEUS_UNKNOWN_TEXT,
    cacheHitRatio: CACHE_HIT_RATIO_UNAVAILABLE,
    slowQueries: [],
    activeSessions: [],
  };
}

/** Whether the fallback that followed this probe superseded it: the liveness 404 of a three-probe read. */
function superseded(probe: HealthProbe, index: number, probes: readonly HealthProbe[]): boolean {
  return index === 0 && probes.length === PROBES_WITH_FALLBACK && probe.status === NOT_FOUND_STATUS;
}

/**
 * The overview: the build, runtime and flag reads and one label scan at `TSDB_LABEL_SCAN_LIMIT`,
 * sent together. A full label list that does not carry the metric-name entry has no count to give,
 * and it is refused with this sentence rather than reported as the list's length or as 0 (M2); the
 * monitoring tab shows the sentence in the overview's place, and every other panel is read on its
 * own and keeps its answer.
 */
export async function readOverview(
  transport: MonitoringTransport,
  formatDuration: (ms: number) => string,
): Promise<DatabaseOverview> {
  const [build, runtime, flags, tsdb] = await Promise.all([
    transport.buildInfo(),
    transport.runtimeInfo(),
    transport.flags(),
    transport.tsdbStatus(TSDB_LABEL_SCAN_LIMIT),
  ]);
  const metricCount = metricNameCount(tsdb, TSDB_LABEL_SCAN_LIMIT);
  if (metricCount === undefined) {
    const listed = TSDB_LABEL_SCAN_LIMIT.toLocaleString("en-US");
    throw new PrometheusTransportError(
      "unmeasurable",
      `The server reports no exact metric count: one TSDB status read lists at most ${listed} label names, ` +
        "it has at least that many, and the entry that counts metric names " +
        `is not among the ${listed} listed`,
    );
  }
  return overviewFrom({ build, runtime, flags, metricCount, formatDuration });
}

/**
 * Health: the probes first, then the build read, because the probes sit outside the query API and a
 * 200 from them does not prove the API answers (#1085 6.2 reads both). An unhealthy probe ends the
 * read before the build read is sent.
 */
export async function readHealth(transport: MonitoringTransport): Promise<HealthInfo> {
  const health = healthFrom(await transport.health());
  await transport.buildInfo();
  return health;
}

/** The Tables panel: the top metrics by series, from one TSDB status read at `TSDB_TOP_METRICS`. */
export async function readTableStats(transport: MonitoringTransport): Promise<TableStats[]> {
  return tableStatsFrom(await transport.tsdbStatus(TSDB_TOP_METRICS));
}

/**
 * The storage row: the head block from the TSDB status and the retention from the runtime read. The
 * TSDB status is read at `TSDB_TOP_METRICS` although the head counts do not depend on it, because
 * the engine caches that computation under the label name and the limit (`tsdb/head.go`,
 * `PostingsCardinalityStats`), and the table read beside this one sends the same limit. A status
 * with no head statistics refuses the row (see `storageStatsFrom`).
 */
export async function readStorageStats(transport: MonitoringTransport): Promise<StorageStats[]> {
  const [tsdb, runtime] = await Promise.all([transport.tsdbStatus(TSDB_TOP_METRICS), transport.runtimeInfo()]);
  return storageStatsFrom(tsdb, runtime);
}
