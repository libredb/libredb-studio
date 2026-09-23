/**
 * Prometheus provider, end to end (issue #1085, epic #424 Phase 6)
 *
 * Every payload below was captured from a live Prometheus 3.13.3 server: the official
 * `prom/prometheus:v3.13.3` image, whose buildinfo reports version "3.13.3" and revision
 * "b273ae3adeb64ad630d65ef7f16440df95658410" (the release commit of tag v3.13.3), run as the
 * `prometheus` compose service with the configuration in `docker/prometheus/`. The captures are
 * committed under `tests/fixtures/prometheus/v3.13.3/` and read only through
 * `tests/helpers/prometheus-fixtures.ts`, and that directory's README records the request each one
 * answers and when it was taken. `globalThis.fetch` is REPLACED per test and
 * restored afterwards - `mock.module()` is refused, being process-wide in bun and able to poison
 * sibling files - and the provider is built with no dependency injected, as the factory builds it,
 * so the whole composition runs: the shared endpoint builder, the request function, the HTTP
 * transport, the query limiter, the result shaper, the object surface, the monitoring mappings and
 * the error table. Only the server is fake, and it answers each request from the capture of that
 * request, matched by path and parameters. A section number below, "section 4.1" for example, is
 * a section of #1085.
 *
 * Three answers are SELECTED from a wider capture rather than captured one by one: a filtered rules
 * read from a rules listing, a pool's targets from the active-target listing, and one metric's
 * metadata from the metadata listing. Each selection ports the server's own filter (`rules`,
 * `targets` and `metricMetadata` in web/api/v1/api.go at v3.13.3), and each is held to one real
 * filtered capture in "the captures" below, so the fake cannot drift from the server in silence.
 * Text answers and failure shapes are built inline, each saying where it comes from. TLS handshakes
 * are not repeated: `tests/unit/db/prometheus/request.test.ts` drives them against a real
 * `node:https` server. One block replays the compose `victoriametrics` service instead
 * (`tests/fixtures/prometheus/victoriametrics-v1.152.0/`), the relative whose answers leave out
 * members that only describe an object, and its title says so.
 *
 * Five measured behaviours drive what is asserted, and "the captures" pins each one:
 *
 * 1. A metric can have no metadata at all: `up` is synthesised by the scrape loop, so
 *    `/api/v1/metadata` answers `{}` for it, the same answer it gives for a name that does not
 *    exist, which is why existence is decided by the listing and not by metadata.
 * 2. Metadata is keyed by metric family, so a classic histogram's `_bucket` series has none under
 *    its own name and is found under the family name.
 * 3. `rate()` over a gauge answers with an `infos` notice, which reaches the result in the
 *    engine's own words.
 * 4. The HTTP status does not classify: a parse error is an envelope with `errorType` "bad_data" on
 *    HTTP 400, while a server behind basic auth answers 401 with no envelope at all.
 * 5. Rule names repeat inside one group, group names repeat across files, and two targets in one
 *    pool can share `instance`, so identity is the engine's own key and never the display name.
 */
import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { isSourcePartUnavailable } from "@/lib/db/object-kinds";
import { PrometheusProvider } from "@/lib/db/providers/timeseries/prometheus/index";
import { TSDB_LABEL_SCAN_LIMIT, TSDB_TOP_METRICS } from "@/lib/db/providers/timeseries/prometheus/monitoring";
import {
  DESCRIBE_SERIES_CAP,
  INVENTORY_WINDOW_MS,
  METRIC_LIST_CAP,
} from "@/lib/db/providers/timeseries/prometheus/objects";
import { ALL_METRICS_SELECTOR, PROMQL_RESERVED_WORDS } from "@/lib/db/providers/timeseries/prometheus/promql";
import { labelFieldNames, vectorFieldNames } from "@/lib/db/providers/timeseries/prometheus/results";
import type { ObjectSourceDocument, ObjectSourcePart } from "@/lib/db/types";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import type { DatabaseConnection } from "@/lib/types";
import { assertObjectSurface } from "../../helpers/object-surface-conformance";
import { capture, captureBody, captureVm, captureVmBody } from "../../helpers/prometheus-fixtures";

// ============================================================================
// The captured payloads, and the test's own view of their wire shapes
// ============================================================================

type Labels = Readonly<Record<string, string>>;

interface Envelope<T> {
  readonly status: "success" | "error";
  readonly data: T;
  readonly warnings?: readonly string[];
  readonly infos?: readonly string[];
  readonly errorType?: string;
  readonly error?: string;
}
interface WireAlert {
  readonly labels: Labels;
  readonly state: string;
}
interface WireRule {
  readonly type: "alerting" | "recording";
  readonly name: string;
  readonly query: string;
  readonly labels?: Labels;
  readonly annotations?: Labels;
  readonly state?: string;
  readonly alerts?: readonly WireAlert[] | null;
  readonly health: string;
}
interface WireGroup {
  readonly name: string;
  readonly file: string;
  readonly interval: number;
  readonly limit: number;
  readonly rules: readonly WireRule[];
}
interface RulesData {
  readonly groups: readonly WireGroup[];
}
interface WireTarget {
  readonly scrapePool: string;
  readonly scrapeUrl: string;
  readonly health: string;
  readonly lastError: string;
  readonly labels: Labels;
}
interface TargetsData {
  readonly activeTargets: readonly WireTarget[];
  readonly droppedTargets: readonly unknown[];
}
interface WireMetadata {
  readonly type: string;
  readonly help: string;
  readonly unit: string;
}
interface WireStat {
  readonly name: string;
  readonly value: number;
}
interface TsdbData {
  readonly seriesCountByMetricName: readonly WireStat[];
  readonly labelValueCountByLabelName: readonly WireStat[];
}
type WireSample = readonly [number, string];
interface WireSeries {
  readonly metric: Labels;
  readonly value?: WireSample;
  readonly values?: readonly WireSample[];
}
interface QueryData {
  readonly resultType: "vector" | "matrix" | "scalar" | "string";
  readonly result: readonly WireSeries[] | WireSample;
}

interface BuildData {
  readonly version: string;
  readonly revision: string;
}
interface RuntimeData {
  readonly startTime: string;
  readonly storageRetention: string;
}
type MetadataData = Readonly<Record<string, readonly WireMetadata[]>>;

/** Each capture's whole document, as the server sent it, through the one fixture reader. */
const BUILDINFO = captureBody<Envelope<BuildData>>("buildinfo");
const RUNTIMEINFO = captureBody<Envelope<RuntimeData>>("runtimeinfo");
const FLAGS = captureBody<Envelope<Readonly<Record<string, string>>>>("flags");
const TSDB_TOP = captureBody<Envelope<TsdbData>>("tsdb-status-50");
const TSDB_LABELS = captureBody<Envelope<TsdbData>>("tsdb-status-10000");
const METRIC_NAMES = captureBody<Envelope<readonly string[]>>("label-values-names");
const LABELS_UP = captureBody<Envelope<readonly string[]>>("labels-one-metric");
const LABELS_KEYWORD = captureBody<Envelope<readonly string[]>>("labels-keyword-metric");
const SERIES = captureBody<Envelope<readonly Labels[]>>("series-all");
const METADATA = captureBody<Envelope<MetadataData>>("metadata-all");
const METADATA_ONE = captureBody<Envelope<MetadataData>>("metadata-exact");
const RULES = captureBody<Envelope<RulesData>>("rules-all");
const RULES_WITH_ALERTS = captureBody<Envelope<RulesData>>("rules-all-with-alerts");
// Data only, the group the rule group source test reads: the provider never sends a one-group read.
const RULES_ONE_GROUP = captureBody<Envelope<RulesData>>("rules-one-group");
const RULES_ONE_ALERT = captureBody<Envelope<RulesData>>("rules-firing-rule");
const POOLS = captureBody<Envelope<{ readonly scrapePools: readonly string[] }>>("scrape-pools");
const TARGETS = captureBody<Envelope<TargetsData>>("targets-active");
const TARGETS_ONE_POOL = captureBody<Envelope<TargetsData>>("targets-one-pool");
const VECTOR = captureBody<Envelope<QueryData>>("query-vector");
const RANGE = captureBody<Envelope<QueryData>>("query-matrix-raw-all");
const SUBQUERY = captureBody<Envelope<QueryData>>("query-matrix-subquery");
const SCALAR = captureBody<Envelope<QueryData>>("query-scalar");
const STRING = captureBody<Envelope<QueryData>>("query-string");
const GAUGE_RATE = captureBody<Envelope<QueryData>>("query-info-notice");
const ABSENT_COUNT = captureBody<Envelope<QueryData>>("query-count-absent");
const BAD_DATA = captureBody<Envelope<null>>("error-bad-data");

/** The expression each query capture answers, as its record and the fixture README give it. */
const QUERY = {
  vector: "up",
  range: "up[5m]",
  subquery: "rate(prometheus_http_requests_total[1m])[5m:30s]",
  scalar: "scalar(count(up))",
  string: '"studio"',
  gaugeRate: "rate(go_goroutines[1m])",
  absentCount: "count(last_over_time(studio_no_such_metric[1h]))",
  badData: "sum(",
} as const;

const ABSENT_METRIC = "studio_no_such_metric";
const COUNTER = "prometheus_http_requests_total";
const HISTOGRAM_FAMILY = "prometheus_http_request_duration_seconds";
const HISTOGRAM_BUCKET = "prometheus_http_request_duration_seconds_bucket";

/** Every rule with its group and its 1-based position among all rules of that group (section 4.1). */
const ALL_RULES = RULES.data.groups.flatMap((group) =>
  group.rules.map((rule, index) => ({ group, rule, position: index + 1 })),
);
type RuleEntry = (typeof ALL_RULES)[number];

/** Section 8's recording-rule output named like a PromQL keyword, which #1085 S4 must write as a matcher. */
const KEYWORD_METRIC = ALL_RULES.find(
  ({ rule }) => rule.type === "recording" && PROMQL_RESERVED_WORDS.has(rule.name.toLowerCase()),
)?.rule.name;
const FIRING = ALL_RULES.find(({ rule }) => rule.type === "alerting" && rule.state === "firing");
const PENDING = ALL_RULES.find(({ rule }) => rule.type === "alerting" && rule.state === "pending");
const DOWN = TARGETS.data.activeTargets.find((target) => target.health === "down");
const UP = TARGETS.data.activeTargets.find((target) => target.health === "up");
const SHARED_INSTANCE = TARGETS.data.activeTargets.find((target, index, all) =>
  all.some(
    (other, otherIndex) =>
      otherIndex !== index &&
      other.scrapePool === target.scrapePool &&
      other.labels.instance === target.labels.instance,
  ),
);

const hasRepeatedName = (names: readonly string[]): boolean => new Set(names).size < names.length;

/** Section 4.1: the engine's own group key. */
const groupKeyOf = (group: WireGroup): string => `${group.file};${group.name}`;
/** Section 4.1: the rule's position among all rules of its group, a colon, its name. */
const ruleSegmentOf = (entry: RuleEntry): string => `${entry.position}:${entry.rule.name}`;

// ============================================================================
// The fake server: every request answered from its capture, by path and parameters
// ============================================================================

interface Sent {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly form: URLSearchParams | null;
  readonly signal: AbortSignal | null;
}
interface Reply {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

const ORIGIN = "http://prometheus.test:9090";

const json = (payload: unknown, status = 200): Reply => ({
  status,
  body: JSON.stringify(payload),
  headers: { "content-type": "application/json" },
});
const text = (body: string, status = 200): Reply => ({
  status,
  body,
  headers: { "content-type": "text/plain; charset=utf-8" },
});

/** `web/web.go` at v3.13.3 writes `"%s is Healthy.\n"` with `AppName` "Prometheus Server". */
const HEALTHY = "Prometheus Server is Healthy.\n";
const READY = "Prometheus Server is Ready.\n";
/**
 * The `prometheus-auth` service's answer to a wrong or missing credential, as the fixture README's
 * M5 entry records it: its web config answers before the API is reached, so there is no envelope.
 */
const UNAUTHORIZED: Reply = {
  status: 401,
  body: "Unauthorized\n",
  headers: { "content-type": "text/plain; charset=utf-8", "www-authenticate": "Basic" },
};

/** Sections 4.6 and 6.2 and nothing else. Every request this suite sees is held to it (#1085 S9). */
const READ_ENDPOINTS: ReadonlySet<string> = new Set([
  "POST /api/v1/query",
  "GET /api/v1/label/__name__/values",
  "GET /api/v1/labels",
  "GET /api/v1/series",
  "GET /api/v1/metadata",
  "GET /api/v1/rules",
  "GET /api/v1/scrape_pools",
  "GET /api/v1/targets",
  "GET /-/healthy",
  "GET /-/ready",
  "GET /health",
  "GET /api/v1/status/buildinfo",
  "GET /api/v1/status/runtimeinfo",
  "GET /api/v1/status/flags",
  "GET /api/v1/status/tsdb",
]);

const originalFetch = globalThis.fetch;
let sent: Sent[] = [];
let uncaptured: string[] = [];
/** A test's own answer for the requests it is about; `undefined` falls through to the captures. */
let override: ((request: Sent) => Reply | Promise<Reply> | undefined) | null = null;

const sameList = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);

const describeRequest = (request: Sent): string =>
  `${request.method} ${request.url.pathname}${request.url.search}${request.form === null ? "" : ` ${request.form}`}`;

const QUERY_ANSWERS = new Map<string, Reply>([
  [QUERY.vector, json(VECTOR)],
  [QUERY.range, json(RANGE)],
  [QUERY.subquery, json(SUBQUERY)],
  [QUERY.scalar, json(SCALAR)],
  [QUERY.string, json(STRING)],
  [QUERY.gaugeRate, json(GAUGE_RATE)],
  [QUERY.absentCount, json(ABSENT_COUNT)],
  // The capture's own status, the 400 `bad_data` answers (`getDefaultErrorCode` in web/api/v1/api.go at v3.13.3).
  [QUERY.badData, json(BAD_DATA, capture("error-bad-data").status)],
]);

function queryAnswer(form: URLSearchParams | null): Reply | undefined {
  const expression = form?.get("query");
  return typeof expression === "string" ? QUERY_ANSWERS.get(expression) : undefined;
}

function tsdbAnswer(params: URLSearchParams): Reply | undefined {
  const limit = params.get("limit");
  if (limit === String(TSDB_TOP_METRICS)) return json(TSDB_TOP);
  if (limit === String(TSDB_LABEL_SCAN_LIMIT)) return json(TSDB_LABELS);
  return undefined;
}

/**
 * A list capture answers any request whose `limit` could not have cut it: it carries no truncation
 * warning and holds fewer items than the limit asks for. A smaller limit would make the server cut
 * the list and warn ("results truncated due to limit"), which no capture here recorded, so that
 * request is left unanswered rather than served a list the server would not have sent.
 */
function completeAnswer(params: URLSearchParams, payload: Envelope<unknown>, length: number): Reply | undefined {
  const limit = params.get("limit");
  if ((payload.warnings ?? []).length > 0) return undefined;
  if (limit !== null && !(Number(limit) > length)) return undefined;
  return json(payload);
}

function labelsAnswer(params: URLSearchParams): Reply | undefined {
  const matchers = params.getAll("match[]");
  if (sameList(matchers, ["up"])) return json(LABELS_UP);
  if (KEYWORD_METRIC !== undefined && sameList(matchers, [`{__name__=${JSON.stringify(KEYWORD_METRIC)}}`])) {
    return json(LABELS_KEYWORD);
  }
  return undefined;
}

/**
 * One metric's metadata, SELECTED from the unfiltered listing: `metricMetadata` in web/api/v1/api.go
 * (v3.13.3) looks each target's metadata up by family name and keys the answer by that name, so a
 * filtered read is the listing's entry for the name, or `{}`.
 */
function selectMetadata(metric: string): Envelope<Readonly<Record<string, readonly WireMetadata[]>>> {
  const entries = Object.hasOwn(METADATA.data, metric) ? METADATA.data[metric] : undefined;
  return { status: "success", data: entries === undefined ? {} : { [metric]: entries } };
}

function metadataAnswer(params: URLSearchParams): Reply | undefined {
  const metric = params.get("metric");
  if (metric === null || params.get("limit") !== "1" || [...params.keys()].length !== 2) return undefined;
  return json(selectMetadata(metric));
}

/**
 * A rules read, SELECTED with the filter `rules` applies in web/api/v1/api.go (v3.13.3): a group is
 * kept when its name is in `rule_group[]` and its file in `file[]` (an absent filter keeps every
 * group), a rule when its name is in `rule_name[]`, and a group left with no rule is dropped. An
 * `exclude_alerts=true` read selects from the capture taken with it and every other read from the
 * capture taken without it, so no alert is invented or stripped here.
 */
function selectRules(params: URLSearchParams): Envelope<RulesData> {
  const source = params.get("exclude_alerts") === "true" ? RULES : RULES_WITH_ALERTS;
  const groups = new Set(params.getAll("rule_group[]"));
  const files = new Set(params.getAll("file[]"));
  const names = new Set(params.getAll("rule_name[]"));
  const kept = source.data.groups
    .filter((group) => (groups.size === 0 || groups.has(group.name)) && (files.size === 0 || files.has(group.file)))
    .map((group) => ({ ...group, rules: group.rules.filter((rule) => names.size === 0 || names.has(rule.name)) }))
    .filter((group) => group.rules.length > 0);
  return { status: "success", data: { groups: kept } };
}

/**
 * The two rules reads the provider sends, and no other: the listing, `exclude_alerts=true` alone, and
 * one alerting rule's read, one each of `rule_group[]`, `file[]` and `rule_name[]` with no
 * `exclude_alerts`, which carries that rule's live alerts. Any other shape, a one-group read with
 * `exclude_alerts=true` among them, is left unanswered, so a test whose provider sends one fails.
 */
function rulesAnswer(params: URLSearchParams): Reply | undefined {
  const keys = [...params.keys()].sort();
  const listing = sameList(keys, ["exclude_alerts"]) && params.get("exclude_alerts") === "true";
  const oneRule = sameList(keys, ["file[]", "rule_group[]", "rule_name[]"]);
  return listing || oneRule ? json(selectRules(params)) : undefined;
}

/**
 * A pool's active targets, SELECTED from the active-target capture: `targets` in web/api/v1/api.go
 * (v3.13.3) skips every pool that is not `scrapePool`, and `state=active` adds no dropped target, so
 * nothing else in the answer changes.
 */
function selectPool(pool: string): Envelope<TargetsData> {
  return {
    ...TARGETS,
    data: { ...TARGETS.data, activeTargets: TARGETS.data.activeTargets.filter((target) => target.scrapePool === pool) },
  };
}

function targetsAnswer(params: URLSearchParams): Reply | undefined {
  if (params.get("state") !== "active") return undefined;
  if ([...params.keys()].some((key) => key !== "state" && key !== "scrapePool")) return undefined;
  const pool = params.get("scrapePool");
  return json(pool === null ? TARGETS : selectPool(pool));
}

function captured(request: Sent): Reply | undefined {
  const { pathname, searchParams } = request.url;
  if (request.url.origin !== ORIGIN || !READ_ENDPOINTS.has(`${request.method} ${pathname}`)) return undefined;
  switch (pathname) {
    case "/api/v1/query":
      return queryAnswer(request.form);
    case "/-/healthy":
      return text(HEALTHY);
    case "/-/ready":
      return text(READY);
    case "/api/v1/status/buildinfo":
      return json(BUILDINFO);
    case "/api/v1/status/runtimeinfo":
      return json(RUNTIMEINFO);
    case "/api/v1/status/flags":
      return json(FLAGS);
    case "/api/v1/status/tsdb":
      return tsdbAnswer(searchParams);
    case "/api/v1/label/__name__/values":
      return completeAnswer(searchParams, METRIC_NAMES, METRIC_NAMES.data.length);
    case "/api/v1/labels":
      return labelsAnswer(searchParams);
    case "/api/v1/series":
      return sameList(searchParams.getAll("match[]"), [ALL_METRICS_SELECTOR])
        ? completeAnswer(searchParams, SERIES, SERIES.data.length)
        : undefined;
    case "/api/v1/metadata":
      return metadataAnswer(searchParams);
    case "/api/v1/rules":
      return rulesAnswer(searchParams);
    case "/api/v1/scrape_pools":
      return json(POOLS);
    case "/api/v1/targets":
      return targetsAnswer(searchParams);
    default:
      // `/health` included: a server that answered `/-/healthy` is never asked it.
      return undefined;
  }
}

function formOf(body: RequestInit["body"]): URLSearchParams | null {
  if (body instanceof URLSearchParams) return body;
  return typeof body === "string" ? new URLSearchParams(body) : null;
}

/** A real fetch rejects with the signal's reason once it aborts, whether or not an answer ever comes. */
function abortable(pending: Promise<Reply>, signal: AbortSignal | null): Promise<Reply> {
  if (signal === null) return pending;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<Reply>((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    pending.then(resolve, reject);
  });
}

function installFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: Sent = {
      method: init?.method ?? "GET",
      url: new URL(input instanceof Request ? input.url : String(input)),
      headers: new Headers(init?.headers),
      form: formOf(init?.body),
      signal: init?.signal ?? null,
    };
    sent.push(request);
    const answer = override?.(request) ?? captured(request);
    if (answer === undefined) {
      uncaptured.push(describeRequest(request));
      throw new Error(`no capture answers ${describeRequest(request)}`);
    }
    const reply = await abortable(Promise.resolve(answer), request.signal);
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  sent = [];
  uncaptured = [];
  override = null;
  installFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ============================================================================
// Helpers
// ============================================================================

function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "prometheus-integration",
    name: "Compose Prometheus",
    type: "prometheus",
    host: "prometheus.test",
    port: 9090,
    createdAt: new Date("2026-09-23T00:00:00.000Z"),
    ...overrides,
  };
}

async function connected(overrides: Partial<DatabaseConnection> = {}): Promise<PrometheusProvider> {
  const provider = new PrometheusProvider(makeConnection(overrides));
  await provider.connect();
  return provider;
}

/**
 * A user's first request on a connection: connect, then run a query, as the editor does. A failure
 * may surface from either call, depending on whether `connect()` asks the server anything, so the
 * error tests hold the pair to it rather than `connect()` alone.
 */
async function firstQuery(provider: PrometheusProvider): Promise<unknown> {
  await provider.connect();
  return provider.query(QUERY.vector);
}

/** Section 5.3: float seconds become an ISO-8601 UTC string with millisecond precision. */
const iso = (seconds: number): string => new Date(Math.round(seconds * 1000)).toISOString();

/** Seconds from either form the API accepts for a time: a decimal Unix timestamp or RFC 3339. */
function toSeconds(value: string | null): number {
  if (value === null) return Number.NaN;
  return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : Date.parse(value) / 1000;
}

const requestsTo = (pathname: string): Sent[] => sent.filter((request) => request.url.pathname === pathname);
const seriesOf = (payload: Envelope<QueryData>): readonly WireSeries[] => payload.data.result as readonly WireSeries[];
const sampleOf = (payload: Envelope<QueryData>): WireSample => payload.data.result as WireSample;
const messageOf = (failure: Promise<unknown>): Promise<string> =>
  failure.then(
    () => "",
    (error: unknown) => (error as Error).message,
  );

type ReadablePart = Extract<ObjectSourcePart, { readonly text: string }>;

function readablePart(document: ObjectSourceDocument, index: number): ReadablePart {
  const part = document.parts[index];
  if (part === undefined || isSourcePartUnavailable(part)) {
    throw new Error(`part ${index} of ${JSON.stringify(document.path)} is not readable`);
  }
  return part;
}

function parsedPart(document: ObjectSourceDocument, index: number): Record<string, unknown> {
  return JSON.parse(readablePart(document, index).text) as Record<string, unknown>;
}

const matchesEntry = (part: Record<string, unknown>, entry: WireMetadata): boolean =>
  part.type === entry.type && part.help === entry.help && part.unit === entry.unit;

/** The parts of a rules answer that do not move between two reads seconds apart. */
function stableRules(data: RulesData): unknown {
  return data.groups.map((group) => ({
    name: group.name,
    file: group.file,
    interval: group.interval,
    limit: group.limit,
    rules: group.rules.map((rule) => ({
      type: rule.type,
      name: rule.name,
      query: rule.query,
      labels: rule.labels ?? {},
      annotations: rule.annotations ?? {},
      state: rule.state,
      alerts: (rule.alerts ?? []).map((alert) => alert.labels),
    })),
  }));
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const labelKey = (labels: Labels): string =>
  JSON.stringify(Object.entries(labels).sort(([a], [b]) => byCodeUnit(a, b)));

/**
 * The parts of a targets answer that do not move between two reads, in one order. The engine
 * answers a pool's targets in Go map order (`scrapePool.ActiveTargets` at v3.13.3), so two captures
 * of one pool can list the two `studio-twin` targets, which share a scrape URL, either way round:
 * they are sorted by scrape URL, then by label set, as `sortedJson` treats metadata.
 */
function stableTargets(data: TargetsData): unknown {
  return data.activeTargets
    .map((target) => ({ scrapePool: target.scrapePool, scrapeUrl: target.scrapeUrl, labels: target.labels }))
    .sort((a, b) => byCodeUnit(a.scrapeUrl, b.scrapeUrl) || byCodeUnit(labelKey(a.labels), labelKey(b.labels)));
}

const sortedJson = (entries: readonly WireMetadata[]): string[] => entries.map((entry) => JSON.stringify(entry)).sort();

// ============================================================================
// The captures
// ============================================================================

describe("the captures", () => {
  test("come from the server this file names", () => {
    expect(BUILDINFO.data.version).toBe("3.13.3");
    expect(BUILDINFO.data.revision).toBe("b273ae3adeb64ad630d65ef7f16440df95658410");
  });

  test("hold every kind, status and identity edge of section 8, so nothing below runs over nothing", () => {
    expect(METRIC_NAMES.data.length).toBeGreaterThan(1);
    // Below the list cap, so the provider's count is exact and not a floor.
    expect(METRIC_NAMES.data.length).toBeLessThan(METRIC_LIST_CAP + 1);
    for (const name of ["up", COUNTER, HISTOGRAM_BUCKET]) expect(METRIC_NAMES.data).toContain(name);
    // The series read names the same metrics as the listing, so a complete batch describes them all.
    expect([...new Set(SERIES.data.map((labels) => labels.__name__))].sort()).toEqual([...METRIC_NAMES.data].sort());
    expect(KEYWORD_METRIC).toBeDefined();
    expect(METRIC_NAMES.data).toContain(KEYWORD_METRIC as string);
    expect(ALL_RULES.some(({ rule }) => rule.type === "recording")).toBe(true);
    expect(FIRING).toBeDefined();
    expect(PENDING).toBeDefined();
    // A group declared in two files, and a group holding two alerting rules of one name whose
    // queries differ, so a source read by position can be told from one read by name.
    expect(hasRepeatedName(RULES.data.groups.map((group) => group.name))).toBe(true);
    const twins = ALL_RULES.filter(
      (entry) =>
        entry.rule.type === "alerting" &&
        ALL_RULES.some(
          (other) => other !== entry && other.group === entry.group && other.rule.name === entry.rule.name,
        ),
    );
    expect(twins.length).toBeGreaterThan(1);
    expect(new Set(twins.map((entry) => entry.rule.query)).size).toBe(twins.length);
    expect(DOWN).toBeDefined();
    expect(UP).toBeDefined();
    expect(SHARED_INSTANCE).toBeDefined();
    expect(POOLS.data.scrapePools.length).toBeGreaterThan(1);
  });

  test("record the five behaviours the header names", () => {
    // 1: `up` has no metadata, while a scraped counter does.
    expect(Object.hasOwn(METADATA.data, "up")).toBe(false);
    expect(Object.hasOwn(METADATA.data, COUNTER)).toBe(true);
    // 2: a classic histogram's metadata is under its family, not under its `_bucket` series.
    expect(Object.hasOwn(METADATA.data, HISTOGRAM_FAMILY)).toBe(true);
    expect(Object.hasOwn(METADATA.data, HISTOGRAM_BUCKET)).toBe(false);
    // 3: rate() over a gauge answers an `infos` notice.
    expect((GAUGE_RATE.infos ?? []).length).toBeGreaterThan(0);
    // 4: a parse error is an envelope carrying its own category, on HTTP 400.
    expect(capture("error-bad-data").status).toBe(400);
    expect(BAD_DATA.status).toBe("error");
    expect(BAD_DATA.errorType).toBe("bad_data");
    // 4: basic auth refuses with a 401 and no envelope, the answer the error tests replay inline.
    const refused = capture("auth-wrong-credentials");
    expect([refused.status, refused.text]).toEqual([UNAUTHORIZED.status, UNAUTHORIZED.body]);
    // The absent name's existence read is an empty vector, not an error.
    expect(ABSENT_COUNT.data.resultType).toBe("vector");
    expect(seriesOf(ABSENT_COUNT)).toEqual([]);
    // The vector carries the labels `up` carried over the window, so the grid and the tree compare.
    const vectorLabels = [...new Set(seriesOf(VECTOR).flatMap((series) => Object.keys(series.metric)))].sort();
    expect(vectorLabels).toEqual([...LABELS_UP.data].sort());
  });

  test("the metadata selection is the server's own filtered answer", () => {
    const keys = Object.keys(METADATA_ONE.data);
    expect(keys).toEqual([COUNTER]);
    expect(sortedJson(selectMetadata(COUNTER).data[COUNTER] ?? [])).toEqual(
      sortedJson(METADATA_ONE.data[COUNTER] ?? []),
    );
  });

  test("the rules selection is the server's own filtered answer for one alerting rule, with its alerts", () => {
    expect(RULES_ONE_ALERT.data.groups).toHaveLength(1);
    const [alertGroup] = RULES_ONE_ALERT.data.groups;
    const names = [...new Set(alertGroup.rules.map((rule) => rule.name))];
    expect(names).toHaveLength(1);
    // The control that makes the comparison mean something: the alerts are really there.
    expect(alertGroup.rules.some((rule) => (rule.alerts ?? []).length > 0)).toBe(true);
    const alertRead = new URLSearchParams([
      ["rule_group[]", alertGroup.name],
      ["file[]", alertGroup.file],
      ["rule_name[]", names[0]],
    ]);
    expect(stableRules(selectRules(alertRead).data)).toEqual(stableRules(RULES_ONE_ALERT.data));
  });

  test("the pool selection is the server's own filtered answer", () => {
    const pools = [...new Set(TARGETS_ONE_POOL.data.activeTargets.map((target) => target.scrapePool))];
    expect(pools).toHaveLength(1);
    expect(stableTargets(selectPool(pools[0]).data)).toEqual(stableTargets(TARGETS_ONE_POOL.data));
  });
});

// ============================================================================
// Connect
// ============================================================================

describe("connect", () => {
  test("connects through the real composition and addresses only the configured server", async () => {
    const provider = await connected();
    await provider.query(QUERY.vector);

    expect(provider.isConnected()).toBe(true);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((request) => request.url.origin === ORIGIN)).toBe(true);
    expect(uncaptured).toEqual([]);
    await provider.disconnect();
  });

  test("sends no credential when none is set, Basic for a user and a password, Bearer for a password alone", async () => {
    await firstQuery(new PrometheusProvider(makeConnection()));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((request) => !request.headers.has("authorization"))).toBe(true);

    sent = [];
    await firstQuery(new PrometheusProvider(makeConnection({ user: "reader", password: "s3cret" })));
    const basic = `Basic ${Buffer.from("reader:s3cret").toString("base64")}`;
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((request) => request.headers.get("authorization") === basic)).toBe(true);

    sent = [];
    await firstQuery(new PrometheusProvider(makeConnection({ password: "tok_123" })));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((request) => request.headers.get("authorization") === "Bearer tok_123")).toBe(true);
  });
});

// ============================================================================
// Queries
// ============================================================================

describe("queries", () => {
  test("an instant vector is one row per series: __name__, the other labels sorted, then timestamp and value", async () => {
    const provider = await connected();
    const result = await provider.query(QUERY.vector);
    const request = requestsTo("/api/v1/query").at(-1);

    expect(request?.method).toBe("POST");
    expect(request?.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    expect(request?.form?.get("query")).toBe(QUERY.vector);
    // One series more than is shown, so a cut is seen even where the engine drops its own truncation notice.
    expect(request?.form?.get("limit")).toBe(String(DEFAULT_QUERY_LIMIT + 1));
    expect(request?.form?.has("timeout")).toBe(true);
    // Section 5.1: no `time`, so the server evaluates at now. The `query` above is the control.
    expect(request?.form?.has("time")).toBe(false);

    const series = seriesOf(VECTOR);
    // The field rule is results.ts's single definition: a UTF-8 label name such as `service.name`,
    // which the `studio-twin` series carry, is its JSON string, quotes included.
    expect(result.fields).toEqual(vectorFieldNames([...new Set(series.flatMap((one) => Object.keys(one.metric)))]));
    expect(result.fields).toContain('"service.name"');
    expect(result.rowCount).toBe(series.length);
    for (const one of series) {
      const [at, value] = one.value as WireSample;
      const row = result.rows.find((candidate) =>
        Object.entries(one.metric).every(([name, label]) => candidate[labelFieldNames([name])[0]] === label),
      );
      expect(row).toMatchObject({ timestamp: iso(at), value: Number(value) });
    }
    await provider.disconnect();
  });

  test("the grid's fields for a metric are the columns the tree describes for it", async () => {
    const provider = await connected();
    const result = await provider.query(QUERY.vector);
    const detail = await provider.describeObject(["up"], "metric");

    expect(detail.columns.map((column) => column.name)).toEqual(result.fields);
    await provider.disconnect();
  });

  test("a raw range selector is wide: a row per distinct timestamp, a column per series, null for no sample", async () => {
    const provider = await connected();
    const result = await provider.query(QUERY.range);
    const series = seriesOf(RANGE);
    const stamps = [...new Set(series.flatMap((one) => (one.values ?? []).map(([at]) => at)))].sort((a, b) => a - b);
    const samples = series.reduce((total, one) => total + (one.values ?? []).length, 0);
    const columns = result.fields.slice(1);
    const cells = result.rows.flatMap((row) => columns.map((column) => row[column]));

    expect(result.fields[0]).toBe("timestamp");
    expect(columns).toHaveLength(series.length);
    expect(new Set(columns).size).toBe(columns.length);
    for (const column of columns) expect(column === "value" || /^\{.+\}$/.test(column)).toBe(true);
    expect(result.rows.map((row) => row.timestamp)).toEqual(stamps.map(iso));
    expect(cells.filter((cell) => cell !== null)).toHaveLength(samples);
    await provider.disconnect();
  });

  test("a subquery is stepped, and every cell is a number, null, or the engine's own non-finite text", async () => {
    const provider = await connected();
    const result = await provider.query(QUERY.subquery);
    const series = seriesOf(SUBQUERY);
    const stamps = [...new Set(series.flatMap((one) => (one.values ?? []).map(([at]) => at)))].sort((a, b) => a - b);
    const cells = result.rows.flatMap((row) => result.fields.slice(1).map((column) => row[column]));

    expect(SUBQUERY.data.resultType).toBe("matrix");
    // The capture: 70 series, each sampled at the same ten instants 30 seconds apart.
    expect(series).toHaveLength(70);
    expect(stamps).toHaveLength(10);
    expect(stamps.slice(1).map((at, index) => at - stamps[index])).toEqual(Array(9).fill(30));
    // So the result is ten rows, one per step, a column per series, and no step without a sample.
    expect(result.rows).toHaveLength(10);
    expect(result.fields.slice(1)).toHaveLength(70);
    expect(result.rows.map((row) => row.timestamp)).toEqual(stamps.map(iso));
    expect(cells).toHaveLength(700);
    expect(cells.filter((cell) => cell === null)).toEqual([]);
    for (const cell of cells) {
      expect(cell === null || typeof cell === "number" || ["NaN", "+Inf", "-Inf"].includes(cell as string)).toBe(true);
    }
    await provider.disconnect();
  });

  test("a scalar and a string are one row of timestamp and value", async () => {
    const provider = await connected();
    const [scalarAt, scalarValue] = sampleOf(SCALAR);
    const [stringAt, stringValue] = sampleOf(STRING);

    const scalar = await provider.query(QUERY.scalar);
    expect(scalar.fields).toEqual(["timestamp", "value"]);
    expect(scalar.rows).toEqual([{ timestamp: iso(scalarAt), value: Number(scalarValue) }]);

    const string = await provider.query(QUERY.string);
    expect(string.fields).toEqual(["timestamp", "value"]);
    expect(string.rows).toEqual([{ timestamp: iso(stringAt), value: stringValue }]);
    await provider.disconnect();
  });

  test("NaN stays the engine's string, because null already means no sample (built inline)", async () => {
    // Inline: the scalar capture's timestamp with the text the engine writes for a NaN sample.
    const [at] = sampleOf(SCALAR);
    override = (request) =>
      request.form?.get("query") === "0 / 0"
        ? json({ status: "success", data: { resultType: "scalar", result: [at, "NaN"] } })
        : undefined;
    const provider = await connected();
    const result = await provider.query("0 / 0");

    expect(result.rows).toEqual([{ timestamp: iso(at), value: "NaN" }]);
    await provider.disconnect();
  });

  test("an infos notice reaches the result in the engine's own words", async () => {
    const provider = await connected();
    const result = await provider.query(QUERY.gaugeRate);
    const messages = (result.warnings ?? []).map((warning) => warning.message);

    for (const notice of GAUGE_RATE.infos ?? []) expect(messages).toContain(notice);
    await provider.disconnect();
  });

  test("a vector past the series cap keeps the first DEFAULT_QUERY_LIMIT and says what it cut (built inline)", async () => {
    // Inline: the captured `up` series repeated to one more than the cap with distinct instances,
    // which any server answers for the limit the query sends, cap + 1; the local cap bounds the rows shown.
    const [template] = seriesOf(VECTOR);
    const many = Array.from({ length: DEFAULT_QUERY_LIMIT + 1 }, (_, index) => ({
      metric: { ...template.metric, instance: `host-${index}:9100` },
      value: template.value,
    }));
    override = (request) =>
      request.form?.get("query") === QUERY.vector
        ? json({ status: "success", data: { resultType: "vector", result: many } })
        : undefined;
    const provider = await connected();
    const result = await provider.query(QUERY.vector);

    expect(result.rows).toHaveLength(DEFAULT_QUERY_LIMIT);
    expect((result.warnings ?? []).map((warning) => warning.message).join(" ")).toContain(String(DEFAULT_QUERY_LIMIT));
    await provider.disconnect();
  });

  test("a buffer holding only comments is refused before any request", async () => {
    const provider = await connected();
    const before = requestsTo("/api/v1/query").length;

    await expect(provider.query("# nothing to run\n  # still nothing\n")).rejects.toBeInstanceOf(QueryError);
    // The vector test above is the control: a query does reach this recorder.
    expect(requestsTo("/api/v1/query")).toHaveLength(before);
    await provider.disconnect();
  });

  test("bound parameters are refused before any request, because PromQL binds nothing", async () => {
    const provider = await connected();
    const before = requestsTo("/api/v1/query").length;

    await expect(provider.query(QUERY.vector, [1])).rejects.toBeInstanceOf(DatabaseConfigError);
    expect(requestsTo("/api/v1/query")).toHaveLength(before);
    await provider.disconnect();
  });
});

// ============================================================================
// The object surface (#789)
// ============================================================================

describe("the object surface", () => {
  test("satisfies the shared object surface contract, reading only the endpoints of 4.6 and 6.2", async () => {
    const provider = await connected();

    await assertObjectSurface(provider, {
      // A zero-level engine lists no containers, and every object sits at the root.
      containers: [],
      kinds: {
        metric: METRIC_NAMES.data.length,
        rule_group: RULES.data.groups.length,
        recording_rule: ALL_RULES.filter(({ rule }) => rule.type === "recording").length,
        alerting_rule: ALL_RULES.filter(({ rule }) => rule.type === "alerting").length,
        scrape_pool: POOLS.data.scrapePools.length,
        target: TARGETS.data.activeTargets.length,
      },
      sampleObject: { path: ["up"], kind: "metric" },
      // Absent by construction: no compose target exports it, so the complete listing omits it, and a
      // name outside a complete listing is refused with no query sent. The one-hour count read is for a
      // truncated listing only; "sources" below holds both cases.
      absentSource: { path: [ABSENT_METRIC], kind: "metric" },
    });

    expect(uncaptured).toEqual([]);
    // #1085 S9: nothing but the read endpoints was called, and the control is that something was.
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((request) => !READ_ENDPOINTS.has(`${request.method} ${request.url.pathname}`))).toEqual([]);
    await provider.disconnect();
  });

  test("lists every kind under the engine's own identity, each child named after its parent", async () => {
    const provider = await connected();

    const metrics = await provider.listObjects([], "metric");
    expect(metrics.map((object) => object.name).sort()).toEqual([...METRIC_NAMES.data].sort());
    // Section 4.3: a list read measures no series, so no metric row carries a count.
    expect(metrics.filter((object) => object.rowCount !== undefined)).toEqual([]);

    const groups = await provider.listObjects([], "rule_group");
    expect(groups.map((object) => JSON.stringify([object.path, object.name])).sort()).toEqual(
      RULES.data.groups.map((group) => JSON.stringify([[groupKeyOf(group)], group.name])).sort(),
    );

    const recording = await provider.listObjects([], "recording_rule");
    const alerting = await provider.listObjects([], "alerting_rule");
    expect(recording.length + alerting.length).toBe(ALL_RULES.length);
    for (const entry of ALL_RULES) {
      const listed = entry.rule.type === "recording" ? recording : alerting;
      const path = JSON.stringify([groupKeyOf(entry.group), ruleSegmentOf(entry)]);
      const object = listed.find((candidate) => JSON.stringify(candidate.path) === path);
      expect(object?.name).toBe(`${entry.rule.name} (${entry.group.name})`);
      // Section 4.1: the engine's word, and only when it is worth acting on.
      const worthActingOn = entry.rule.state === "firing" || entry.rule.state === "pending";
      expect(object?.status).toBe(worthActingOn ? entry.rule.state : undefined);
    }

    const pools = await provider.listObjects([], "scrape_pool");
    expect(pools.map((object) => object.name).sort()).toEqual([...POOLS.data.scrapePools].sort());

    const targets = await provider.listObjects([], "target");
    expect(targets).toHaveLength(TARGETS.data.activeTargets.length);
    for (const target of TARGETS.data.activeTargets) {
      const object = targets.find(
        (candidate) =>
          candidate.path[0] === target.scrapePool &&
          candidate.path[1]?.startsWith(`${target.scrapeUrl} `) &&
          candidate.name === `${target.labels.instance} (${target.scrapePool})`,
      );
      expect(object?.path[1]).toMatch(/ [0-9a-f]{12}$/);
      expect(object?.status).toBe(target.health === "up" ? undefined : target.health);
    }
    await provider.disconnect();
  });

  test("keeps the three identity edges of section 4.1 apart", async () => {
    const provider = await connected();

    // Two files declare a group of one name: two rows of that name, two paths.
    const repeated = RULES.data.groups.find((group, index, all) =>
      all.some((other, otherIndex) => otherIndex !== index && other.name === group.name),
    );
    const groups = (await provider.listObjects([], "rule_group")).filter((object) => object.name === repeated?.name);
    expect(groups.length).toBeGreaterThan(1);
    expect(new Set(groups.map((object) => JSON.stringify(object.path))).size).toBe(groups.length);

    // One group holds two alerting rules of one name: each is addressed by its position, and each
    // source is that rule's own definition rather than whichever of the two was found first.
    const alerting = await provider.listObjects([], "alerting_rule");
    const twins = ALL_RULES.filter(
      (entry) =>
        entry.rule.type === "alerting" &&
        ALL_RULES.some(
          (other) => other !== entry && other.group === entry.group && other.rule.name === entry.rule.name,
        ),
    );
    for (const entry of twins) {
      const path = [groupKeyOf(entry.group), ruleSegmentOf(entry)];
      expect(alerting.some((object) => JSON.stringify(object.path) === JSON.stringify(path))).toBe(true);
      const document = await provider.readObjectSource(path, "alerting_rule");
      expect(parsedPart(document, 0)).toMatchObject({ name: entry.rule.name, query: entry.rule.query });
    }

    // Two targets in one pool share `instance`: two rows under one display name, two paths.
    const shared = SHARED_INSTANCE as WireTarget;
    const rows = (await provider.listObjects([], "target")).filter(
      (object) => object.name === `${shared.labels.instance} (${shared.scrapePool})`,
    );
    const expected = TARGETS.data.activeTargets.filter(
      (target) => target.scrapePool === shared.scrapePool && target.labels.instance === shared.labels.instance,
    );
    expect(rows).toHaveLength(expected.length);
    expect(new Set(rows.map((object) => object.path[1])).size).toBe(rows.length);
    await provider.disconnect();
  });

  test("describes a metric with the columns an instant query of it returns, over the last hour of the real clock", async () => {
    const provider = await connected();
    const detail = await provider.describeObject(["up"], "metric");

    // The same single definition the grid uses, so `service.name` is the quoted column here too.
    expect(detail.columns.map((column) => column.name)).toEqual(vectorFieldNames(LABELS_UP.data));
    const request = requestsTo("/api/v1/labels").at(-1);
    expect(request?.url.searchParams.getAll("match[]")).toEqual(["up"]);
    const start = toSeconds(request?.url.searchParams.get("start") ?? null);
    const end = toSeconds(request?.url.searchParams.get("end") ?? null);
    expect(end - start).toBeCloseTo(INVENTORY_WINDOW_MS / 1000, 3);
    expect(Math.abs(end - Date.now() / 1000)).toBeLessThan(60);
    await provider.disconnect();
  });

  test("writes a metric named like a PromQL keyword as a matcher, never as a bare name (#1085 S4)", async () => {
    const provider = await connected();
    const name = KEYWORD_METRIC as string;
    const detail = await provider.describeObject([name], "metric");

    expect(requestsTo("/api/v1/labels").at(-1)?.url.searchParams.getAll("match[]")).toEqual([
      `{__name__=${JSON.stringify(name)}}`,
    ]);
    // The control: the columns are the ones the server answered for that matcher.
    expect(detail.columns.map((column) => column.name)).toEqual(vectorFieldNames(LABELS_KEYWORD.data));
    await provider.disconnect();
  });

  test("describeObjects is exactly one series read per call, and names each metric's columns from it", async () => {
    const provider = await connected();

    const before = sent.length;
    const batch = await provider.describeObjects([], "metric");
    expect(sent.length - before).toBe(1);
    expect(sent.at(-1)?.url.pathname).toBe("/api/v1/series");
    expect(sent.at(-1)?.url.searchParams.getAll("match[]")).toEqual([ALL_METRICS_SELECTOR]);
    expect(batch.truncated).toBeUndefined();
    expect(batch.details.map((detail) => detail.path[0]).sort()).toEqual([...METRIC_NAMES.data].sort());

    const up = batch.details.find((detail) => detail.path[0] === "up");
    const single = await provider.describeObject(["up"], "metric");
    expect(up?.columns.map((column) => column.name)).toEqual(single.columns.map((column) => column.name));

    const bounded = sent.length;
    const one = await provider.describeObjects([], "metric", 1);
    expect(sent.length - bounded).toBe(1);
    expect(one.details).toHaveLength(1);
    expect(one.truncated?.limit).toBe(1);
    await provider.disconnect();
  });

  test("a series answer the server cut is reported as truncated, naming the provider's own bound (built inline)", async () => {
    // Inline: the complete series capture with the warning the server adds when `limit` cuts it.
    override = (request) =>
      request.url.pathname === "/api/v1/series"
        ? json({ ...SERIES, warnings: ["results truncated due to limit"] })
        : undefined;
    const provider = await connected();

    const before = sent.length;
    const batch = await provider.describeObjects([], "metric");
    expect(sent.length - before).toBe(1);
    const reason = batch.truncated?.reason ?? "";
    expect(
      reason.includes(String(DESCRIBE_SERIES_CAP)) || reason.includes(DESCRIBE_SERIES_CAP.toLocaleString("en-US")),
    ).toBe(true);
    await provider.disconnect();
  });
});

// ============================================================================
// Sources, one per kind (#789)
// ============================================================================

describe("sources", () => {
  const metadataReads = (): (string | null)[] =>
    requestsTo("/api/v1/metadata").map((request) => request.url.searchParams.get("metric"));

  test("a metric's source is its metadata, one JSON part per entry, found under the exact name in one read", async () => {
    const provider = await connected();
    const document = await provider.readObjectSource([COUNTER], "metric");
    const entries = METADATA.data[COUNTER] ?? [];

    expect(document.parts).toHaveLength(entries.length);
    for (const [index] of document.parts.entries()) {
      expect(readablePart(document, index)).toMatchObject({ language: "json", form: "complete", origin: "rendered" });
    }
    const parts = document.parts.map((_, index) => parsedPart(document, index));
    for (const entry of entries) expect(parts.some((part) => matchesEntry(part, entry))).toBe(true);
    expect(metadataReads()).toEqual([COUNTER]);
    await provider.disconnect();
  });

  test("a classic histogram's _bucket series finds its metadata under the family name, in a second read", async () => {
    const provider = await connected();
    const document = await provider.readObjectSource([HISTOGRAM_BUCKET], "metric");
    const entries = METADATA.data[HISTOGRAM_FAMILY] ?? [];

    expect(metadataReads()).toEqual([HISTOGRAM_BUCKET, HISTOGRAM_FAMILY]);
    const parts = document.parts.map((_, index) => parsedPart(document, index));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(parts.some((part) => matchesEntry(part, entry))).toBe(true);
    await provider.disconnect();
  });

  test("a metric with no metadata answers the engine fact as a refusal part, after one read", async () => {
    const provider = await connected();
    const document = await provider.readObjectSource(["up"], "metric");

    expect(document.parts).toHaveLength(1);
    const [part] = document.parts;
    expect(isSourcePartUnavailable(part)).toBe(true);
    expect("unavailable" in part ? part.unavailable : "").toContain("metadata");
    // `up` ends in no family suffix, so there is no second name to try.
    expect(metadataReads()).toEqual(["up"]);
    await provider.disconnect();
  });

  test("a name outside a complete listing is refused by name, and no query is sent to ask", async () => {
    const provider = await connected();
    const before = requestsTo("/api/v1/query").length;
    const failure = provider.readObjectSource([ABSENT_METRIC], "metric");

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow(ABSENT_METRIC);
    // The listing is complete, so it decides: nothing is asked of the query endpoint.
    expect(requestsTo("/api/v1/query")).toHaveLength(before);
    // The control that must match: a query on this connection does reach the recorder.
    await provider.query(QUERY.vector);
    expect(requestsTo("/api/v1/query")).toHaveLength(before + 1);
    await provider.disconnect();
  });

  test("a name outside a truncated listing is checked with one count read over the listing's hour (built inline)", async () => {
    // Inline: the complete name listing with the notice the server adds when `limit` cuts it (M8).
    override = (request) =>
      request.url.pathname === "/api/v1/label/__name__/values"
        ? json({ ...METRIC_NAMES, warnings: ["results truncated due to limit"] })
        : undefined;
    const provider = await connected();
    const before = requestsTo("/api/v1/query").length;
    const failure = provider.readObjectSource([ABSENT_METRIC], "metric");

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow(ABSENT_METRIC);
    // One `count(last_over_time(<selector>[1h]))`, over the listing's own hour, answered here by the
    // `query-count-absent` capture's empty vector.
    expect(
      requestsTo("/api/v1/query")
        .slice(before)
        .map((request) => request.form?.get("query")),
    ).toEqual([QUERY.absentCount]);
    await provider.disconnect();
  });

  test("a rule group's source is its evaluation facts, from the rules listing", async () => {
    const provider = await connected();
    const [group] = RULES_ONE_GROUP.data.groups;
    const before = requestsTo("/api/v1/rules").length;
    const document = await provider.readObjectSource([groupKeyOf(group)], "rule_group");

    expect(parsedPart(document, 0)).toMatchObject({
      name: group.name,
      file: group.file,
      interval: group.interval,
      limit: group.limit,
    });
    // The exclude_alerts=true listing already carries every field the source renders, so the group
    // is resolved there and no filtered read is sent.
    const groupReads = requestsTo("/api/v1/rules").slice(before);
    expect(groupReads.length).toBeGreaterThan(0);
    expect(groupReads.every((request) => request.url.searchParams.get("exclude_alerts") === "true")).toBe(true);
    expect(groupReads.filter((request) => request.url.searchParams.has("rule_group[]"))).toEqual([]);

    // The control that must match: an alerting rule's source does send the filtered read, without
    // exclude_alerts, so the absence above is not a filter this recorder cannot see.
    const alert = FIRING as RuleEntry;
    const alertBefore = requestsTo("/api/v1/rules").length;
    await provider.readObjectSource([groupKeyOf(alert.group), ruleSegmentOf(alert)], "alerting_rule");
    const filtered = requestsTo("/api/v1/rules")
      .slice(alertBefore)
      .find((request) => request.url.searchParams.has("rule_group[]"));
    expect(filtered?.url.searchParams.getAll("rule_group[]")).toEqual([alert.group.name]);
    expect(filtered?.url.searchParams.getAll("file[]")).toEqual([alert.group.file]);
    expect(filtered?.url.searchParams.getAll("rule_name[]")).toEqual([alert.rule.name]);
    expect(filtered?.url.searchParams.has("exclude_alerts")).toBe(false);
    await provider.disconnect();
  });

  test("a recording rule's source is the rule, addressed by its position in its group", async () => {
    const provider = await connected();
    const entry = ALL_RULES.find(({ rule }) => rule.type === "recording" && rule.name === KEYWORD_METRIC) as RuleEntry;
    const document = await provider.readObjectSource([groupKeyOf(entry.group), ruleSegmentOf(entry)], "recording_rule");

    expect(parsedPart(document, 0)).toMatchObject({
      name: entry.rule.name,
      query: entry.rule.query,
      health: entry.rule.health,
    });
    await provider.disconnect();
  });

  test("an alerting rule's source is its definition, then its live state with the active alerts", async () => {
    const provider = await connected();
    const entry = FIRING as RuleEntry;
    const document = await provider.readObjectSource([groupKeyOf(entry.group), ruleSegmentOf(entry)], "alerting_rule");

    expect(document.parts).toHaveLength(2);
    const definition = parsedPart(document, 0);
    expect(definition).toMatchObject({ name: entry.rule.name, query: entry.rule.query, health: entry.rule.health });
    // Section 4.4: the live state is not inside the definition; the second part is the control.
    expect("alerts" in definition).toBe(false);
    const live = parsedPart(document, 1);
    expect(live).toMatchObject({ state: "firing" });
    const capturedRule = RULES_WITH_ALERTS.data.groups.find(
      (group) => group.name === entry.group.name && group.file === entry.group.file,
    )?.rules[entry.position - 1];
    const lists = Object.values(live).filter(Array.isArray);
    expect(lists).toHaveLength(1);
    expect(lists[0]).toHaveLength((capturedRule?.alerts ?? []).length);
    expect((capturedRule?.alerts ?? []).length).toBeGreaterThan(0);
    await provider.disconnect();
  });

  test("a scrape pool's source counts its active targets by health, from one pool read", async () => {
    const provider = await connected();
    const pool = (SHARED_INSTANCE as WireTarget).scrapePool;
    const document = await provider.readObjectSource([pool], "scrape_pool");
    const counts = JSON.stringify(parsedPart(document, 0));

    const expected = new Map<string, number>();
    for (const target of TARGETS.data.activeTargets.filter((candidate) => candidate.scrapePool === pool)) {
      expected.set(target.health, (expected.get(target.health) ?? 0) + 1);
    }
    for (const [health, count] of expected) expect(counts).toContain(`"${health}":${count}`);
    expect(requestsTo("/api/v1/targets").some((request) => request.url.searchParams.get("scrapePool") === pool)).toBe(
      true,
    );
    await provider.disconnect();
  });

  test("a down target is marked down in the tree, and its source is the engine's record with the error", async () => {
    const provider = await connected();
    const target = DOWN as WireTarget;
    const object = (await provider.listObjects([], "target")).find(
      (candidate) => candidate.path[0] === target.scrapePool && candidate.path[1]?.startsWith(`${target.scrapeUrl} `),
    );

    expect(object?.status).toBe("down");
    expect(target.lastError.length).toBeGreaterThan(0);
    const document = await provider.readObjectSource(object?.path ?? [], "target");
    expect(parsedPart(document, 0)).toMatchObject({
      scrapeUrl: target.scrapeUrl,
      health: "down",
      lastError: target.lastError,
      labels: target.labels,
    });
    await provider.disconnect();
  });
});

// ============================================================================
// Monitoring
// ============================================================================

describe("monitoring", () => {
  test("getHealth reads /-/healthy then /-/ready, and reports no connection count it cannot measure", async () => {
    const provider = await connected();
    const before = sent.length;
    const health = await provider.getHealth();
    const paths = sent.slice(before).map((request) => request.url.pathname);

    expect(paths).toContain("/-/healthy");
    expect(paths).toContain("/-/ready");
    expect(paths.indexOf("/-/healthy")).toBeLessThan(paths.indexOf("/-/ready"));
    // Response-driven: /-/healthy answered 200, so /health is never tried. The two above are the control.
    expect(paths).not.toContain("/health");
    expect(health.activeConnections).toBeUndefined();
    expect(health.slowQueries).toEqual([]);
    expect(health.activeSessions).toEqual([]);
    await provider.disconnect();
  });

  test("a 404 from /-/healthy tries /health next, because the answer decides and not the product (built inline)", async () => {
    // Inline: a server serving /health and not /-/healthy, the shape section 6.2 falls back for.
    override = (request) => {
      if (request.url.pathname === "/-/healthy") return text("404 page not found\n", 404);
      if (request.url.pathname === "/health") return text("OK");
      return undefined;
    };
    const provider = await connected();
    const before = sent.length;
    await provider.getHealth();
    const paths = sent.slice(before).map((request) => request.url.pathname);

    expect(paths).toContain("/-/healthy");
    expect(paths.indexOf("/health")).toBeGreaterThan(paths.indexOf("/-/healthy"));
    await provider.disconnect();
  });

  test("getOverview reads the version, the start time, the connection limit and the head block's metric count", async () => {
    const provider = await connected();
    const overview = await provider.getOverview();

    expect(overview.version).toBe(BUILDINFO.data.version);
    // The server's own start time, as runtimeinfo reported it, and not this process's clock.
    expect(overview.startTime).toEqual(new Date(RUNTIMEINFO.data.startTime));
    expect(overview.maxConnections).toBe(Number(FLAGS.data["web.max-connections"]));
    // M2: the __name__ entry is the count whenever it is present; this capture's list is also
    // shorter than the scan limit.
    const names = TSDB_LABELS.data.labelValueCountByLabelName.find((stat) => stat.name === "__name__");
    expect(names).toBeDefined();
    expect(overview.tableCount).toBe(names?.value as number);
    expect(overview.databaseSize).toBe("N/A");
    expect(overview.databaseSizeBytes).toBeUndefined();
    expect(overview.uptime.length).toBeGreaterThan(0);
    await provider.disconnect();
  });

  test("getPerformanceMetrics publishes no cache hit ratio, because the API measures none (#1085 6.2)", async () => {
    const provider = await connected();

    expect((await provider.getPerformanceMetrics()).cacheHitRatio).toBeUndefined();
    await provider.disconnect();
  });

  test("getTableStats is the TSDB's top metrics by series, in the server's order", async () => {
    const provider = await connected();
    const stats = await provider.getTableStats();

    expect(stats.map((stat) => [stat.tableName, stat.rowCount])).toEqual(
      TSDB_TOP.data.seriesCountByMetricName.map((stat) => [stat.name, stat.value]),
    );
    expect(requestsTo("/api/v1/status/tsdb").at(-1)?.url.searchParams.get("limit")).toBe(String(TSDB_TOP_METRICS));
    await provider.disconnect();
  });

  test("getStorageStats is read from the head block and names the retention", async () => {
    const provider = await connected();
    const storage = await provider.getStorageStats();

    expect(storage.length).toBeGreaterThan(0);
    expect(JSON.stringify(storage)).toContain(RUNTIMEINFO.data.storageRetention);
    await provider.disconnect();
  });

  test("the surfaces with nothing honest to report answer empty and send nothing", async () => {
    const provider = await connected();
    const before = sent.length;

    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    expect(sent.length).toBe(before);
    // The control: a surface that has a source does reach the server.
    await provider.getOverview();
    expect(sent.length).toBeGreaterThan(before);
    await provider.disconnect();
  });

  test("getMonitoringData answers every panel, with no panel error", async () => {
    const provider = await connected();
    const data = await provider.getMonitoringData();

    expect(data.errors).toBeUndefined();
    expect(data.overview?.version).toBe(BUILDINFO.data.version);
    expect(data.tables).toHaveLength(TSDB_TOP.data.seriesCountByMetricName.length);
    expect(uncaptured).toEqual([]);
    await provider.disconnect();
  });
});

// ============================================================================
// A relative whose answers leave descriptions out (VictoriaMetrics v1.152.0)
// ============================================================================

/**
 * The capture of the compose `victoriametrics` service (victoriametrics/victoria-metrics:v1.152.0) that
 * answers a read, by its path and the one parameter that picks a capture, for the reads the tests below
 * make. Those captures hold one answer per read, so nothing is selected from a wider one.
 */
function vmCaptureName(request: Sent): string | undefined {
  const { pathname, searchParams } = request.url;
  const pool = searchParams.get("scrapePool");
  switch (`${request.method} ${pathname}`) {
    case "GET /api/v1/status/buildinfo":
      return "buildinfo";
    case "GET /api/v1/label/__name__/values":
      return "label-values-names";
    case "GET /api/v1/metadata":
      return searchParams.get("metric") === COUNTER ? "metadata-exact" : undefined;
    case "GET /api/v1/rules":
      return searchParams.get("exclude_alerts") === "true" ? "rules-all" : undefined;
    case "GET /api/v1/scrape_pools":
      return "scrape-pools";
    case "GET /api/v1/targets":
      if (searchParams.get("state") !== "active") return undefined;
      return pool === null ? "targets-active" : pool === "studio-twin" ? "targets-one-pool" : undefined;
    case "GET /api/v1/status/tsdb":
      return searchParams.get("limit") === String(TSDB_TOP_METRICS) ? "tsdb-status-50" : undefined;
    default:
      return undefined;
  }
}

/**
 * The fake server's `victoriametrics` answers, replayed with each record's own status, headers and
 * text. A read none of them answers fails as uncaptured rather than falling through to a capture of
 * the `prometheus` service, so no test below reads one server's answer as the other's.
 */
function vmCaptured(request: Sent): Reply {
  const name = vmCaptureName(request);
  if (name === undefined) {
    uncaptured.push(describeRequest(request));
    throw new Error(`no VictoriaMetrics capture answers ${describeRequest(request)}`);
  }
  const answer = captureVm(name);
  return { status: answer.status, body: answer.text, headers: answer.headers };
}

interface VmMetadata {
  readonly type: string;
  readonly help: string;
  readonly unit?: string;
}

describe("a relative whose answers leave descriptions out, end to end (VictoriaMetrics v1.152.0 captures)", () => {
  beforeEach(() => {
    override = vmCaptured;
  });

  test("the Tables tab lists the server's series counts by metric, from a TSDB status with no head statistics", async () => {
    const tsdb = captureVmBody<Envelope<TsdbData & { readonly headStats?: unknown }>>("tsdb-status-50");
    // The control: the server ranked its metrics, and sent no head block statistics beside them.
    expect(tsdb.data.seriesCountByMetricName.length).toBeGreaterThan(0);
    expect(tsdb.data.headStats).toBeUndefined();
    const provider = await connected();

    const stats = await provider.getTableStats();

    expect(stats.map((stat) => [stat.tableName, stat.rowCount])).toEqual(
      tsdb.data.seriesCountByMetricName.map((stat) => [stat.name, stat.value]),
    );
    expect(uncaptured).toEqual([]);
    await provider.disconnect();
  });

  test("a metric's source is the type and help the server sent, and no unit it did not send", async () => {
    const families = captureVmBody<Envelope<Readonly<Record<string, readonly VmMetadata[]>>>>("metadata-exact").data;
    const entry = families[COUNTER]?.[0];
    // The control: the server holds an entry for the counter, and no unit in it.
    expect(entry).toBeDefined();
    expect(entry?.unit).toBeUndefined();
    const provider = await connected();

    const document = await provider.readObjectSource([COUNTER], "metric");

    expect(document.parts).toHaveLength(1);
    expect(parsedPart(document, 0)).toEqual({ family: COUNTER, type: entry?.type, help: entry?.help });
    expect(Object.keys(parsedPart(document, 0))).toEqual(["family", "type", "help"]);
    expect(uncaptured).toEqual([]);
    await provider.disconnect();
  });

  test("the Targets folder counts every active target, and a target's source leaves out what the server did not send", async () => {
    const targets = captureVmBody<Envelope<TargetsData>>("targets-active").data.activeTargets;
    const pool = captureVmBody<Envelope<TargetsData>>("targets-one-pool").data.activeTargets;
    // The control: the server reports several targets, a pool of them among them, with no scrape
    // interval or timeout in any.
    expect(targets.length).toBeGreaterThan(1);
    expect(pool.length).toBeGreaterThan(0);
    expect(targets.some((target) => "scrapeInterval" in target || "scrapeTimeout" in target)).toBe(false);
    const provider = await connected();

    expect((await provider.countObjects([])).target).toEqual({ count: targets.length });
    const listed = (await provider.listObjects([], "target")).filter((object) => object.path[0] === "studio-twin");
    expect(listed).toHaveLength(pool.length);
    const document = await provider.readObjectSource(listed[0]?.path ?? [], "target");
    const part = parsedPart(document, 0);
    expect(part).toMatchObject({ scrapeUrl: pool[0]?.scrapeUrl, health: pool[0]?.health });
    expect(Object.keys(part)).toEqual([
      "scrapeUrl",
      "health",
      "lastError",
      "lastScrape",
      "lastScrapeDuration",
      "labels",
      "discoveredLabels",
    ]);
    expect(uncaptured).toEqual([]);
    await provider.disconnect();
  });

  test("the storage row is refused as unmeasured where the TSDB status has no head statistics, never filled (built inline)", async () => {
    // Inline: the VictoriaMetrics TSDB status beside every other answer from the `prometheus` captures,
    // the runtime read among them, which is what a server that serves that read and sends no head
    // statistics gives. VictoriaMetrics itself fails this panel one read earlier: it does not serve the
    // runtime read, and says so in text.
    override = (request) => (request.url.pathname === "/api/v1/status/tsdb" ? vmCaptured(request) : undefined);
    const provider = await connected();

    const failure = provider.getStorageStats();

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow("The server reports no head block statistics");
    // The control: the same TSDB status answers the table read, so the refusal is about the head alone.
    expect((await provider.getTableStats()).length).toBeGreaterThan(0);
    expect(uncaptured).toEqual([]);
    await provider.disconnect();
  });
});

// ============================================================================
// Errors, end to end (section 5.5)
// ============================================================================

describe("errors, end to end", () => {
  let consoleError: Mock<typeof console.error>;

  beforeEach(() => {
    consoleError = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  test("an error envelope maps by its errorType: bad_data is a QueryError in the engine's words", async () => {
    const provider = await connected();
    const failure = provider.query(QUERY.badData);

    await expect(failure).rejects.toBeInstanceOf(QueryError);
    await expect(failure).rejects.toThrow(BAD_DATA.error as string);
    await provider.disconnect();
  });

  test("a 401 with no envelope is an AuthenticationError (built inline from M5)", async () => {
    override = () => UNAUTHORIZED;
    const provider = new PrometheusProvider(makeConnection({ user: "reader", password: "wrong" }));

    await expect(firstQuery(provider)).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("a proxy's HTML page is a ConnectionError that never quotes the page (built inline)", async () => {
    const page = "<!doctype html><html><body><h1>Welcome to nginx!</h1><p>upstream-host-7</p></body></html>";
    override = () => ({ status: 200, body: page, headers: { "content-type": "text/html" } });
    const provider = new PrometheusProvider(makeConnection());
    const failure = firstQuery(provider);

    await expect(failure).rejects.toBeInstanceOf(ConnectionError);
    const message = await messageOf(failure);
    // The control: the message says something. It only never says what the proxy sent.
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain("nginx");
    expect(message).not.toContain("upstream-host-7");
  });

  test("a server still starting or already stopping is named as one, and not as a proxy, when connecting (built inline)", async () => {
    // Inline: what `testReady` in web/web.go (v3.13.3) answers on every API path this client reads while
    // the server replays its write-ahead log at start-up, the window a restart of a large server spends
    // minutes in.
    override = () => ({
      status: 503,
      body: "Service Unavailable",
      headers: { "content-type": "text/plain; charset=utf-8", "x-prometheus-stopping": "false" },
    });
    const provider = new PrometheusProvider(makeConnection());
    const failure = provider.connect();

    await expect(failure).rejects.toBeInstanceOf(ConnectionError);
    const message = await messageOf(failure);
    // The controls: the message names the read that failed and how, so the absences below mean something.
    expect(message).toContain("/api/v1/status/buildinfo");
    expect(message).toContain("HTTP 503");
    expect(message).toContain("while it starts up");
    expect(message).not.toContain("Service Unavailable");
    expect(message).not.toContain("something other than the Prometheus API answered");
  });

  test("a 502 with a body is a ConnectionError that never quotes the body (built inline)", async () => {
    const page = "<html><head><title>502</title></head><body>gateway-node-19 could not reach upstream</body></html>";
    override = () => ({ status: 502, body: page, headers: { "content-type": "text/html" } });
    const provider = new PrometheusProvider(makeConnection());
    const failure = firstQuery(provider);

    await expect(failure).rejects.toBeInstanceOf(ConnectionError);
    const message = await messageOf(failure);
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain("gateway-node-19");
  });

  test("a refused connection is a ConnectionError (built inline)", async () => {
    // Inline: what the runtime's fetch throws when nothing listens at the address.
    override = () => {
      throw new TypeError("fetch failed");
    };
    const provider = new PrometheusProvider(makeConnection());

    await expect(firstQuery(provider)).rejects.toBeInstanceOf(ConnectionError);
  });
});

// ============================================================================
// Credentials (#1085 S3), end to end
// ============================================================================

describe("credentials (#1085 S3), end to end", () => {
  let consoleError: Mock<typeof console.error>;

  beforeEach(() => {
    consoleError = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  const logged = (): string => consoleError.mock.calls.map((call) => call.map(String).join(" ")).join("\n");

  // The control for "nothing was sent" is the connect test above, where a valid Basic and a valid
  // Bearer credential each reach this recorder with the header they build.
  test.each([
    ["a bearer token carrying a line feed", { password: "abc\n" }, "abc"],
    ["a Basic password carrying a line feed", { user: "reader", password: "abc\n" }, "abc"],
    ["a Basic user carrying a colon", { user: "re:ader", password: "s3cret" }, "re:ader"],
  ] as const)(
    "%s is refused before any request, and neither the error nor the log repeats it",
    async (_, credential, secret) => {
      const provider = new PrometheusProvider(makeConnection(credential));
      const failure = firstQuery(provider);

      await expect(failure).rejects.toBeInstanceOf(DatabaseConfigError);
      const message = await messageOf(failure);
      // The control: the refusal was logged, so the log read below is a real line and not an empty one.
      expect(consoleError).toHaveBeenCalled();
      const user = "user" in credential ? credential.user : "";
      const encoded = Buffer.from(`${user}:${credential.password}`).toString("base64");
      for (const written of [message, logged()]) {
        expect(written).not.toContain(secret);
        expect(written).not.toContain(encoded);
      }
      expect(sent).toEqual([]);
    },
  );
});

// ============================================================================
// Cancellation (M1)
// ============================================================================

describe("cancellation, M1 observed, so cancelQuery exists", () => {
  const SLOW = 'sum(count_over_time({__name__=~".+"}[1h:1s]))';

  async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await Bun.sleep(5);
    expect(predicate()).toBe(true);
  }

  test("cancelQuery aborts the running request, and the query ends as QueryCancelledError", async () => {
    // Inline: a query the server never answers, so only the abort can end it.
    override = (request) => (request.form?.get("query") === SLOW ? new Promise<Reply>(() => {}) : undefined);
    const provider = await connected();
    const running = provider.query(SLOW, undefined, "run-slow");
    await waitFor(() => requestsTo("/api/v1/query").some((request) => request.form?.get("query") === SLOW));

    expect(await provider.cancelQuery("run-slow")).toBe(true);
    await expect(running).rejects.toBeInstanceOf(QueryCancelledError);
    const request = requestsTo("/api/v1/query").find((candidate) => candidate.form?.get("query") === SLOW);
    expect(request?.signal?.aborted).toBe(true);
    await provider.disconnect();
  });

  test("cancelQuery answers false for an id that is not running", async () => {
    const provider = await connected();

    expect(await provider.cancelQuery("never-started")).toBe(false);
    await provider.disconnect();
  });
});

// ============================================================================
// The query deadline (section 5.2)
// ============================================================================

describe("the query deadline, end to end (section 5.2)", () => {
  test("a query the server never answers ends as a TimeoutError at the connection's query timeout", async () => {
    // Inline: a server that takes the query and never answers, so only the client-side deadline can
    // end it. The provider sends every query with a cancellation signal of its own, so this is the
    // path a user's query always takes, and the deadline has to hold beside that signal. The timeout also
    // bounds connect()'s build read, so it leaves that read room; the wait below stays inside bun's 5 s.
    const queryTimeout = 500;
    override = (request) => (request.url.pathname === "/api/v1/query" ? new Promise<Reply>(() => {}) : undefined);
    const provider = new PrometheusProvider(makeConnection(), { queryTimeout });
    await provider.connect();

    const outcome = await Promise.race([
      provider.query(QUERY.vector).then(
        () => "answered",
        (error: unknown) => error,
      ),
      Bun.sleep(queryTimeout * 8).then(() => "still pending"),
    ]);

    expect(outcome).toBeInstanceOf(TimeoutError);
    expect((outcome as TimeoutError).timeout).toBe(queryTimeout);
    // The control: the query did reach the server, so the timeout ended a request that was sent.
    expect(requestsTo("/api/v1/query")).toHaveLength(1);
    await provider.disconnect();
  });
});
