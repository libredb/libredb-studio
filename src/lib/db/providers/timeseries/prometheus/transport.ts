/**
 * Prometheus transport seam (#1085, section 3.1)
 *
 * The object surface, the monitoring readers, the result shaper and the provider speak these
 * types and never the HTTP API. The envelope, the endpoint paths, the form parameters and the
 * wire's pairs of time and value text live in http-transport.ts alone, and the seam guard fails
 * the build when that vocabulary appears anywhere else in this directory. That is what lets every
 * shaping rule be a pure function tested from hand-built values (3.5, dependency inversion), and
 * what would let a second wire arrive as a second transport rather than as branches in the
 * provider.
 *
 * Three decisions shape the types:
 *
 * - Values stay the engine's text. A sample value is the string the engine wrote, "NaN", "+Inf"
 *   and "-Inf" included, and a time is its float seconds, so how a cell is typed is decided once,
 *   in results.ts (5.3).
 * - A failure is classified by category, never by HTTP status, because the status does not
 *   classify: web/api/v1/api.go answers `canceled` with 499, `timeout` with 503 and `execution`
 *   with 422, and lets `unavailable` fall through to 500. errors.ts maps the category (5.5).
 * - A member that identifies or classifies an object is always there. A member that only describes
 *   one is optional where an engine was measured leaving it out, VictoriaMetrics v1.152.0 so far:
 *   an omitted description is a fact about that engine, so it arrives as absent and nothing above
 *   the seam invents a value for it.
 *
 * Apart from the error class this file is purely structural: no I/O and no imports.
 */

/**
 * The category every failure below the provider is reported in. The first six are the engine's
 * own `errorType` values (web/api/v1/api.go); an engine value this build does not know is
 * carried verbatim, which is why `category` is typed `string` on the error. api.go also defines
 * `not_found` and `not_acceptable`, and they arrive that way.
 */
export type PrometheusErrorCategory =
  | "bad_data"
  | "execution"
  | "timeout"
  | "canceled"
  | "unavailable"
  | "internal"
  | "unauthorized" // 401 or 403 with no envelope
  | "tls" // handshake or verification failure (#1085 S8)
  | "network" // refused, reset, DNS
  | "too_large" // past the response byte cap (#1085 S5)
  | "deadline" // the client-side timeout fired
  | "aborted" // the caller cancelled
  | "credential" // a credential refused before any request (#1085 S3)
  | "protocol" // a body that is not the API envelope, or an envelope of the wrong shape
  | "unmeasurable"; // a monitoring read with no exact number to give (M2), or no number sent at all

/** What a failure may say about itself without echoing a credential, a header or a body (#1085 S3). */
export interface PrometheusErrorDetail {
  readonly status?: number;
  readonly code?: string;
  readonly limitBytes?: number;
}

/**
 * A failure that crossed the seam, classified.
 *
 * `category` is what errors.ts branches on. `message` is the engine's own sentence where there is
 * one and this provider's where there is none, and it never carries a header value or a response
 * body: a proxy's HTML error page is described, not copied (#1085 S3).
 */
export class PrometheusTransportError extends Error {
  constructor(
    readonly category: string,
    message: string,
    readonly detail: PrometheusErrorDetail = {},
  ) {
    super(message);
    this.name = "PrometheusTransportError";
    // Subclassing a builtin loses the prototype under a downlevel emit, which would make every
    // instanceof check in errors.ts quietly fall through to the generic branch.
    Object.setPrototypeOf(this, PrometheusTransportError.prototype);
  }
}

/** One float sample. */
export interface PrometheusSample {
  readonly at: number; // float seconds since the epoch, as the engine wrote it
  readonly value: string; // the engine's text, "NaN", "+Inf" and "-Inf" included
}

/** A native histogram, its numbers kept as the engine's text; a bucket is [boundary rule, lower, upper, count]. */
export interface PrometheusNativeHistogram {
  readonly count: string;
  readonly sum: string;
  readonly buckets?: readonly (readonly [number, string, string, string])[];
}

/** One native histogram sample. */
export interface PrometheusHistogramPoint {
  readonly at: number;
  readonly histogram: PrometheusNativeHistogram;
}

/**
 * One series of a vector or a matrix. A vector's series holds exactly one point, in `samples` or
 * in `histograms`; a matrix's holds any number of each, and a series that changed from float to
 * native histogram samples holds both.
 */
export interface PrometheusSeries {
  readonly labels: Readonly<Record<string, string>>; // __name__ included when the engine sent it
  readonly samples: readonly PrometheusSample[];
  readonly histograms: readonly PrometheusHistogramPoint[];
}

/** An instant query's answer, by the result type the engine reported. */
export type PrometheusQueryData =
  | { readonly shape: "vector"; readonly series: readonly PrometheusSeries[] }
  | { readonly shape: "matrix"; readonly series: readonly PrometheusSeries[] }
  | { readonly shape: "scalar"; readonly sample: PrometheusSample }
  | { readonly shape: "string"; readonly sample: PrometheusSample };

/** A warning or an info the engine attached to an answer. */
export interface PrometheusNotice {
  readonly level: "warning" | "info";
  readonly message: string; // verbatim
}

/** A value, with the notices that came with it. */
export interface PrometheusAnswer<T> {
  readonly value: T;
  readonly notices: readonly PrometheusNotice[];
  readonly truncatedByServer: boolean; // the engine's own "results truncated due to limit" notice was present (M8)
}

/** A read window in float seconds, the unit the engine's `start` and `end` take. */
export interface TimeWindow {
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export interface PrometheusQueryOptions {
  readonly timeoutMs: number; // sent as `timeout` and enforced client-side
  /**
   * The most series shown. The transport sends `limit` as seriesLimit + 1, so a cut is seen even
   * when the engine drops its own truncation notice (#1085 5.4).
   */
  readonly seriesLimit: number;
  readonly signal?: AbortSignal; // the caller's cancellation
}

/** A list read with a limit, and whether the engine said it cut the list (4.3). */
export interface CappedList<T> {
  readonly items: readonly T[];
  readonly truncatedByServer: boolean; // the engine's own truncation notice was present (M8)
}

/** One metadata entry of a metric family. `type` classifies the family; the other two describe it. */
export interface PrometheusMetadataEntry {
  readonly type: string;
  readonly help: string;
  readonly unit?: string; // absent where the engine leaves it out: VictoriaMetrics sends type and help only
}

export interface PrometheusAlert {
  readonly labels: Readonly<Record<string, string>>;
  readonly annotations: Readonly<Record<string, string>>;
  readonly state: string;
  readonly activeAt: string;
  readonly value: string;
}

interface PrometheusRuleCommon {
  readonly name: string;
  readonly query: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly health: string;
  readonly lastError: string;
  readonly evaluationTime: number;
  readonly lastEvaluation: string;
}

export interface PrometheusRecordingRule extends PrometheusRuleCommon {
  readonly kind: "recording";
}

export interface PrometheusAlertingRule extends PrometheusRuleCommon {
  readonly kind: "alerting";
  readonly duration: number;
  readonly keepFiringFor: number;
  readonly annotations: Readonly<Record<string, string>>;
  readonly state: string; // "firing" | "pending" | "inactive", the engine's word
  readonly alerts: readonly PrometheusAlert[]; // empty on every exclude_alerts read
}

export type PrometheusRule = PrometheusRecordingRule | PrometheusAlertingRule;

export interface PrometheusRuleGroup {
  readonly name: string;
  readonly file: string;
  readonly interval: number;
  readonly limit: number;
  readonly evaluationTime: number;
  readonly lastEvaluation: string;
  readonly rules: readonly PrometheusRule[];
}

/**
 * Absent: the full listing with exclude_alerts=true (4.3). Present: that group's rules of that name,
 * alerts included (4.4).
 */
export interface RuleFilter {
  readonly group: string;
  readonly file: string;
  readonly ruleName: string;
}

/** An active target. Its pool, URL, health and labels identify and classify it; the rest describes it. */
export interface PrometheusTarget {
  readonly scrapePool: string;
  readonly scrapeUrl: string;
  readonly health: string; // "up" | "down" | "unknown", the engine's word
  readonly lastError: string;
  readonly lastScrape: string;
  readonly lastScrapeDuration: number;
  /**
   * Both absent where the engine leaves them out: VictoriaMetrics keeps them as `__scrape_interval__`
   * and `__scrape_timeout__` among the discovered labels instead.
   */
  readonly scrapeInterval?: string;
  readonly scrapeTimeout?: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly discoveredLabels: Readonly<Record<string, string>>;
}

export interface HealthProbe {
  readonly path: string; // "/-/healthy", "/health" or "/-/ready"
  readonly status: number;
}

export interface PrometheusHealth {
  /**
   * In the order they were sent: liveness, a `/health` fallback only after a `/-/healthy` 404 (so a
   * fallback is always the second of exactly three probes), then readiness. A 401 or 403 is raised
   * as `unauthorized` and never recorded (#1085 6.2).
   */
  readonly probes: readonly HealthProbe[];
}

export interface PrometheusBuildInfo {
  readonly version: string;
}

export interface PrometheusRuntimeInfo {
  readonly startTime: string;
  readonly serverTime: string; // uptime is serverTime - startTime, both on the server's own clock
  readonly storageRetention: string;
}

export interface NamedCount {
  readonly name: string;
  readonly value: number;
}

/** The head block, in the engine's own units: two counts, and the span its samples cover in milliseconds. */
export interface PrometheusHeadBlock {
  readonly series: number;
  readonly chunks: number;
  readonly minTimeMs: number;
  readonly maxTimeMs: number;
}

export interface PrometheusTsdbStatus {
  /**
   * Absent where the engine sends no head statistics: VictoriaMetrics answers the TSDB status with
   * statistics of its own and the two ranked lists below, and no head block.
   */
  readonly head?: PrometheusHeadBlock;
  readonly seriesByMetric: readonly NamedCount[];
  readonly valuesByLabel: readonly NamedCount[];
}

/**
 * The seam itself: every read the provider makes, in the provider's terms (4.6, 6.2). Each
 * consumer takes the narrowest `Pick` of it that it uses (3.5, interface segregation).
 */
export interface PrometheusTransport {
  /** One instant evaluation at the server's now (5.1). */
  query(expression: string, options: PrometheusQueryOptions): Promise<PrometheusAnswer<PrometheusQueryData>>;
  /** Metric names seen in the window, at most `limit` (4.3). */
  metricNames(window: TimeWindow, limit: number): Promise<CappedList<string>>;
  /** The label names of the series `selector` matches in the window (4.2). */
  labelNames(selector: string, window: TimeWindow): Promise<readonly string[]>;
  /** The label sets of the series `selector` matches in the window, at most `limit` (4.2). */
  seriesLabels(
    selector: string,
    window: TimeWindow,
    limit: number,
  ): Promise<CappedList<Readonly<Record<string, string>>>>;
  /** The metadata entries for one metric name; empty when the engine holds none (4.4). */
  metadata(metric: string): Promise<readonly PrometheusMetadataEntry[]>;
  /** Rule groups, as RuleFilter says (4.3, 4.4). */
  rules(filter?: RuleFilter): Promise<readonly PrometheusRuleGroup[]>;
  /** Scrape pool names (4.3). */
  scrapePools(): Promise<readonly string[]>;
  /** Active targets, of one pool when named; dropped targets are never read (4.3). */
  targets(pool?: string): Promise<readonly PrometheusTarget[]>;
  /** The health probes, in the order they were sent (6.2). */
  health(): Promise<PrometheusHealth>;
  buildInfo(): Promise<PrometheusBuildInfo>;
  runtimeInfo(): Promise<PrometheusRuntimeInfo>;
  flags(): Promise<Readonly<Record<string, string>>>;
  /** TSDB statistics: the head block where the engine sends it, and each top list at most `limit` long (6.2). */
  tsdbStatus(limit: number): Promise<PrometheusTsdbStatus>;
}
