/**
 * Prometheus object surface (#1085, sections 4.1 to 4.4)
 *
 * Driven through a recording fake of `ObjectsTransport`, the seam slice the module takes, with no
 * fetch and no `mock.module()` (process-wide in bun). The inline answers stand for the compose
 * configuration of #1085 section 8 and carry every edge section 4 names, each built inline and
 * saying which: one group name in two rule files, a group whose file and name both hold `;`, two
 * alerting rules with one name in one group, a firing, a pending, an inactive and a not yet
 * evaluated alert, two targets sharing an `instance` in one pool, a down and an unknown target,
 * and metrics named like PromQL keywords. The rules fake answers a filtered read the way
 * `web/api/v1/api.go` `rules()` does at v3.13.3. One block replays the captured compose answers,
 * read through the one fixture reader (`tests/helpers/prometheus-fixtures.ts`), into the real HTTP
 * transport, so the identities are also held to what the live server sent.
 */
import { describe, expect, test } from "bun:test";
import { flattenTree } from "@/components/object-tree/flatten";
import { ConnectionError, QueryError } from "@/lib/db/errors";
import {
  assertObjectPathShape,
  callerBoundTruncationReason,
  containerDepth,
  findKind,
  kindAcceptsRowWrites,
  kindAcceptsSourceEdits,
  kindHasColumns,
  type ObjectPathShapeEngine,
  SOURCE_PART_LIMIT,
  sourceBoundTruncationReason,
} from "@/lib/db/object-kinds";
import { pathKey } from "@/lib/db/object-path";
import type { DatabaseObject, ObjectSourcePart, ProviderCapabilities } from "@/lib/db/types";
import {
  createHttpTransport,
  type PrometheusEndpoint,
  RESPONSE_BYTE_CAP,
} from "@/lib/db/providers/timeseries/prometheus/http-transport";
import {
  DESCRIBE_SERIES_CAP,
  groupKey,
  INVENTORY_WINDOW_MS,
  METRIC_LIST_CAP,
  type ObjectsTransport,
  PROMETHEUS_OBJECT_KINDS,
  PrometheusObjects,
  ruleSegment,
  targetSegment,
} from "@/lib/db/providers/timeseries/prometheus/objects";
import { ALL_METRICS_SELECTOR, metricSelector } from "@/lib/db/providers/timeseries/prometheus/promql";
import type { SendRequest } from "@/lib/db/providers/timeseries/prometheus/request";
import { vectorFieldNames } from "@/lib/db/providers/timeseries/prometheus/results";
import {
  type CappedList,
  type PrometheusAlert,
  type PrometheusAlertingRule,
  type PrometheusMetadataEntry,
  type PrometheusQueryData,
  type PrometheusQueryOptions,
  type PrometheusRecordingRule,
  type PrometheusRuleGroup,
  type PrometheusTarget,
  PrometheusTransportError,
  type RuleFilter,
} from "@/lib/db/providers/timeseries/prometheus/transport";
import { assertObjectSurface } from "../../../helpers/object-surface-conformance";
import { capture, captureBody } from "../../../helpers/prometheus-fixtures";

const ENGINE: ObjectPathShapeEngine = { code: "prometheus", label: "A Prometheus", attachedSegment: "required" };

/** The declaration the provider makes (#1085 6.3), reduced to what the object surface reads. */
const CAPABILITIES: ProviderCapabilities = {
  queryLanguage: "promql",
  supportsExplain: false,
  supportsExternalQueryLimiting: false,
  supportsCreateTable: false,
  supportsMaintenance: false,
  maintenanceOperations: [],
  supportsConnectionString: false,
  defaultPort: 9090,
  containerLevels: [],
  objectKinds: PROMETHEUS_OBJECT_KINDS,
  schemaRefreshPattern: "",
};

const STUDIO_A = "/etc/prometheus/rules/studio-a.yml";
const KEY_A = `${STUDIO_A};studio`;

/** The four fixture targets' segments; each digest was computed once over the sorted label pairs. */
const SELF_SEGMENT = "http://localhost:9090/metrics e35eb48e2ff2";
const UNREACHABLE_SEGMENT = "http://unreachable.invalid:9999/metrics a0317ba57eb6";
const NODE_A_SEGMENT = "http://node-a:9100/metrics d00a79c1d85a";
const NODE_B_SEGMENT = "http://node-b:9100/metrics d00a79c1d85a";

const NOW_MS = Date.parse("2026-09-23T12:00:00.000Z");

/** The window every inventory read must carry: the hour before the injected now, in float seconds. */
const WINDOW = { startSeconds: (NOW_MS - INVENTORY_WINDOW_MS) / 1000, endSeconds: NOW_MS / 1000 };

const QUERY_OPTIONS: PrometheusQueryOptions = { timeoutMs: 30_000, seriesLimit: 500 };

/** The floor sentence a capped metric count carries, built from the cap so a measured cap moves it. */
const METRIC_LIST_SAMPLE = `one label-values read capped at ${METRIC_LIST_CAP.toLocaleString("en-US")} names`;

/** Go writes `time.Time` as RFC 3339 with nanoseconds, which is how a rule reports its last evaluation. */
const EVALUATED_AT = "2026-09-23T11:59:50.123456789Z";

const STUDIO_B = "/etc/prometheus/rules/studio-b.yml";
const SEMICOLON_FILE = "/etc/prometheus/rules/a;b.yml";
const KEY_B = `${STUDIO_B};studio`;
/** Split at its first `;`, this key would name file "/etc/prometheus/rules/a" and group "b.yml;c;d". */
const KEY_C = `${SEMICOLON_FILE};c;d`;

const ALWAYS_FIRING_SUMMARY = "Always firing, so the tree shows the firing glyph.";

function recording(name: string, query: string): PrometheusRecordingRule {
  return {
    kind: "recording",
    name,
    query,
    labels: {},
    health: "ok",
    lastError: "",
    evaluationTime: 0.0003,
    lastEvaluation: EVALUATED_AT,
  };
}

function alerting(
  name: string,
  state: string,
  overrides: Partial<Omit<PrometheusAlertingRule, "kind" | "name" | "state">> = {},
): PrometheusAlertingRule {
  return {
    kind: "alerting",
    name,
    query: "vector(1)",
    labels: {},
    health: "ok",
    lastError: "",
    evaluationTime: 0.0004,
    lastEvaluation: EVALUATED_AT,
    duration: 0,
    keepFiringFor: 0,
    annotations: {},
    state,
    alerts: [],
    ...overrides,
  };
}

function alert(alertname: string, state: string): PrometheusAlert {
  return {
    labels: { alertname, severity: "none" },
    annotations: {},
    state,
    activeAt: "2026-09-23T10:00:05.000000001Z",
    value: "1e+00",
  };
}

const FIRING_ALERT = alert("StudioAlwaysFiring", "firing");
const DUPLICATE_ALERT = alert("StudioDuplicate", "firing");

/**
 * The first rule file: a recording rule, an always-firing alert, one held pending by `for: 1h`, and
 * two alerting rules with one name, the first firing and the second inactive.
 */
const GROUP_A: PrometheusRuleGroup = {
  name: "studio",
  file: STUDIO_A,
  interval: 15,
  limit: 0,
  evaluationTime: 0.0021,
  lastEvaluation: EVALUATED_AT,
  rules: [
    recording("studio:up:count", "count(up)"),
    alerting("StudioAlwaysFiring", "firing", {
      labels: { severity: "none" },
      annotations: { summary: ALWAYS_FIRING_SUMMARY },
      alerts: [FIRING_ALERT],
    }),
    alerting("StudioHeldPending", "pending", { duration: 3600, alerts: [alert("StudioHeldPending", "pending")] }),
    alerting("StudioDuplicate", "firing", { query: "up == 0", alerts: [DUPLICATE_ALERT] }),
    alerting("StudioDuplicate", "inactive", { query: "up == 2" }),
  ],
};

/**
 * The second rule file declares a group of the same name, with recording-rule outputs named like
 * PromQL words (`nan` lexes as a number, `sum` as an aggregator) and an alert not yet evaluated.
 */
const GROUP_B: PrometheusRuleGroup = {
  name: "studio",
  file: STUDIO_B,
  interval: 30,
  limit: 0,
  evaluationTime: 0.0009,
  lastEvaluation: EVALUATED_AT,
  rules: [
    recording("nan", "vector(1)"),
    alerting("StudioNotYetEvaluated", "unknown", { evaluationTime: 0, lastEvaluation: "0001-01-01T00:00:00Z" }),
    recording("sum", "vector(2)"),
  ],
};

/** A group whose file and name both hold `;`, which is why a key is resolved and never split. */
const GROUP_C: PrometheusRuleGroup = {
  name: "c;d",
  file: SEMICOLON_FILE,
  interval: 60,
  limit: 5,
  evaluationTime: 0.0001,
  lastEvaluation: EVALUATED_AT,
  rules: [recording("semi:colon", "vector(3)")],
};

const RULE_GROUPS: readonly PrometheusRuleGroup[] = [GROUP_A, GROUP_B, GROUP_C];

function target(
  scrapePool: string,
  scrapeUrl: string,
  instance: string,
  health: string,
  lastError = "",
): PrometheusTarget {
  return {
    scrapePool,
    scrapeUrl,
    health,
    lastError,
    lastScrape: "2026-09-23T11:59:58.5Z",
    lastScrapeDuration: 0.0042,
    scrapeInterval: "15s",
    scrapeTimeout: "10s",
    labels: { instance, job: scrapePool },
    discoveredLabels: {
      __address__: new URL(scrapeUrl).host,
      __metrics_path__: "/metrics",
      __scheme__: "http",
      job: scrapePool,
    },
  };
}

/**
 * The self-scrape, an unreachable address that is down, and two targets of one pool that share an
 * `instance`, one scraped and one not yet (unknown). Listed out of order: the engine answers a
 * pool's targets in Go map order.
 */
const TARGETS: readonly PrometheusTarget[] = [
  target(
    "unreachable",
    "http://unreachable.invalid:9999/metrics",
    "unreachable.invalid:9999",
    "down",
    'Get "http://unreachable.invalid:9999/metrics": dial tcp: lookup unreachable.invalid: no such host',
  ),
  target("shared-instance", "http://node-b:9100/metrics", "shared", "unknown"),
  target("prometheus", "http://localhost:9090/metrics", "localhost:9090", "up"),
  target("shared-instance", "http://node-a:9100/metrics", "shared", "up"),
];

const POOLS: readonly string[] = ["prometheus", "shared-instance", "unreachable"];

/** The metric names of the window, as the label-values read answers them: sorted. */
const METRIC_NAMES: readonly string[] = [
  "go_goroutines",
  "nan",
  "prometheus_http_requests_total",
  "studio:up:count",
  "sum",
  "up",
];

/** The series of the window: every listed metric has one, and one metric has two label sets. */
const SERIES: readonly Readonly<Record<string, string>>[] = [
  { __name__: "up", instance: "localhost:9090", job: "prometheus" },
  { __name__: "up", instance: "unreachable.invalid:9999", job: "unreachable" },
  { __name__: "go_goroutines", instance: "localhost:9090", job: "prometheus" },
  {
    __name__: "prometheus_http_requests_total",
    code: "200",
    handler: "/api/v1/query",
    instance: "localhost:9090",
    job: "prometheus",
  },
  {
    __name__: "prometheus_http_requests_total",
    code: "503",
    handler: "/api/v1/query",
    instance: "localhost:9090",
    job: "prometheus",
    "service.name": "studio",
  },
  { __name__: "studio:up:count" },
  { __name__: "nan" },
  { __name__: "sum" },
];

/** Label names by selector, the way the labels read answers one matcher. */
const LABEL_NAMES: Readonly<Record<string, readonly string[]>> = { up: ["__name__", "instance", "job"] };

/** The two capped reads answered whole: nothing past either cap, and no truncation notice. */
const COMPLETE_NAMES: CappedList<string> = { items: METRIC_NAMES, truncatedByServer: false };
const COMPLETE_SERIES: CappedList<Readonly<Record<string, string>>> = { items: SERIES, truncatedByServer: false };

const COUNTER_ENTRY: PrometheusMetadataEntry = { type: "counter", help: "Counter of HTTP requests.", unit: "" };
const GAUGE_ENTRY: PrometheusMetadataEntry = {
  type: "gauge",
  help: "Number of goroutines that currently exist.",
  unit: "",
};

const METADATA: Readonly<Record<string, readonly PrometheusMetadataEntry[]>> = {
  go_goroutines: [GAUGE_ENTRY],
  prometheus_http_requests_total: [COUNTER_ENTRY],
};

interface Call {
  readonly method: keyof ObjectsTransport;
  readonly args: readonly unknown[];
}

interface Answers {
  readonly metricNames?: CappedList<string>;
  readonly labelNames?: Readonly<Record<string, readonly string[]>>;
  readonly seriesLabels?: CappedList<Readonly<Record<string, string>>>;
  readonly metadata?: Readonly<Record<string, readonly PrometheusMetadataEntry[]>>;
  readonly ruleGroups?: readonly PrometheusRuleGroup[];
  /** Answers every filtered rules read in place of the server's own filter over `ruleGroups`. */
  readonly filteredRules?: (filter: RuleFilter) => readonly PrometheusRuleGroup[];
  readonly scrapePools?: readonly string[];
  readonly targets?: readonly PrometheusTarget[];
  /** How many series each exact existence expression, `count(last_over_time(...))`, finds; any other finds none. */
  readonly counts?: Readonly<Record<string, number>>;
  readonly failures?: Partial<Record<keyof ObjectsTransport, Error>>;
  readonly capabilities?: ProviderCapabilities;
}

/** An `exclude_alerts` answer: the server leaves the alerts out and the decoder answers none. */
function withoutAlerts(group: PrometheusRuleGroup): PrometheusRuleGroup {
  return { ...group, rules: group.rules.map((rule) => (rule.kind === "alerting" ? { ...rule, alerts: [] } : rule)) };
}

/**
 * A filtered rules read the way `web/api/v1/api.go` `rules()` answers it at v3.13.3: `rule_group[]`
 * and `file[]` select one group, `rule_name[]` keeps the rules of that name with their alerts, and a
 * group left with no rule is not answered at all. A filter always names a rule, so this read is the
 * one that carries alerts.
 */
function serverFilter(groups: readonly PrometheusRuleGroup[]): (filter: RuleFilter) => readonly PrometheusRuleGroup[] {
  return (filter) =>
    groups
      .filter((group) => group.name === filter.group && group.file === filter.file)
      .map((group) => ({ ...group, rules: group.rules.filter((rule) => rule.name === filter.ruleName) }))
      .filter((group) => group.rules.length > 0);
}

/** What `count(...)` answers: one sample holding the series count, or an empty vector for none. */
function countData(series: number): PrometheusQueryData {
  if (series === 0) return { shape: "vector", series: [] };
  return {
    shape: "vector",
    series: [{ labels: {}, samples: [{ at: NOW_MS / 1000, value: String(series) }], histograms: [] }],
  };
}

function fakeTransport(answers: Answers): { transport: ObjectsTransport; calls: Call[] } {
  const calls: Call[] = [];
  const groups = answers.ruleGroups ?? RULE_GROUPS;
  const filtered = answers.filteredRules ?? serverFilter(groups);
  function reply<T>(method: keyof ObjectsTransport, args: readonly unknown[], value: () => T): Promise<T> {
    calls.push({ method, args });
    const failure = answers.failures?.[method];
    return failure === undefined ? Promise.resolve(value()) : Promise.reject(failure);
  }
  const transport: ObjectsTransport = {
    query: (expression, options) =>
      reply("query", [expression, options], () => ({
        value: countData(answers.counts?.[expression] ?? 0),
        notices: [],
        truncatedByServer: false,
      })),
    metricNames: (span, limit) => reply("metricNames", [span, limit], () => answers.metricNames ?? COMPLETE_NAMES),
    labelNames: (selector, span) =>
      reply("labelNames", [selector, span], () => (answers.labelNames ?? LABEL_NAMES)[selector] ?? []),
    seriesLabels: (selector, span, limit) =>
      reply("seriesLabels", [selector, span, limit], () => answers.seriesLabels ?? COMPLETE_SERIES),
    metadata: (metric) => reply("metadata", [metric], () => (answers.metadata ?? METADATA)[metric] ?? []),
    rules: (filter) =>
      reply("rules", [filter], () => (filter === undefined ? groups.map(withoutAlerts) : filtered(filter))),
    scrapePools: () => reply("scrapePools", [], () => answers.scrapePools ?? POOLS),
    targets: (pool) => reply("targets", [pool], () => targetsOf(answers.targets ?? TARGETS, pool)),
  };
  return { transport, calls };
}

/** The targets read the way the engine filters it: one pool's active targets, or every pool's. */
function targetsOf(targets: readonly PrometheusTarget[], pool: string | undefined): readonly PrometheusTarget[] {
  return targets.filter((candidate) => pool === undefined || candidate.scrapePool === pool);
}

function surface(answers: Answers = {}): { objects: PrometheusObjects; calls: Call[] } {
  const { transport, calls } = fakeTransport(answers);
  const objects = new PrometheusObjects({
    transport,
    now: () => NOW_MS,
    capabilities: answers.capabilities ?? CAPABILITIES,
    engine: ENGINE,
    queryOptions: () => QUERY_OPTIONS,
  });
  return { objects, calls };
}

/** How many times each transport method was called. */
function tally(calls: readonly Call[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const call of calls) counts[call.method] = (counts[call.method] ?? 0) + 1;
  return counts;
}

/**
 * The capture that answers each listing these tests read, by the path it was asked on, from the
 * compose `prometheus` service: `rules-all` is `GET /api/v1/rules?exclude_alerts=true` and
 * `targets-active` is `GET /api/v1/targets?state=active`.
 */
const CAPTURED_LISTINGS: Readonly<Record<string, string>> = {
  "/api/v1/rules": "rules-all",
  "/api/v1/targets": "targets-active",
};

interface RawRule {
  readonly name: string;
  readonly type: string;
}

interface RawGroup {
  readonly name: string;
  readonly file: string;
  readonly rules: readonly RawRule[];
}

interface RawTarget {
  readonly scrapePool: string;
  readonly scrapeUrl: string;
  readonly health: string;
  readonly labels: Readonly<Record<string, string>>;
}

function capturedGroups(): readonly RawGroup[] {
  return captureBody<{ data: { groups: RawGroup[] } }>("rules-all").data.groups;
}

function capturedTargets(): readonly RawTarget[] {
  return captureBody<{ data: { activeTargets: RawTarget[] } }>("targets-active").data.activeTargets;
}

/**
 * The surface over the real transport, answered from the captures by path whatever the query
 * string, which is all the two listings these tests read need. A replay hands over the record's
 * own status, content type and verbatim text, never a body serialised again.
 */
function capturedSurface(): PrometheusObjects {
  const send: SendRequest = async (request) => {
    const name = CAPTURED_LISTINGS[request.url.pathname];
    if (name === undefined) throw new Error(`no captured answer for ${request.url.pathname}`);
    const answer = capture(name);
    return { status: answer.status, contentType: answer.headers["content-type"] ?? null, body: answer.text };
  };
  const endpoint: PrometheusEndpoint = {
    url: (pathname, query) => {
      const url = new URL(pathname, "http://prometheus.test:9090");
      if (query !== undefined) url.search = query.toString();
      return url;
    },
  };
  const deps = { send, endpoint, requestTimeoutMs: 5_000, maxResponseBytes: RESPONSE_BYTE_CAP };
  return new PrometheusObjects({
    transport: createHttpTransport({}, deps),
    now: () => NOW_MS,
    capabilities: CAPABILITIES,
    engine: ENGINE,
    queryOptions: () => QUERY_OPTIONS,
  });
}

/** The series bound's sentence, built from the cap so a measured cap moves it with the code's. */
const SERIES_BOUND =
  `the series read stopped at ${DESCRIBE_SERIES_CAP.toLocaleString("en-US")} series, so a metric may be missing ` +
  "from this batch or described without a label only its unread series carry";

const HISTOGRAM_ENTRY: PrometheusMetadataEntry = {
  type: "histogram",
  help: "Histogram of latencies for HTTP requests.",
  unit: "",
};

/** The engine fact a metric with no metadata is answered with (#1085 4.4). */
const METADATA_ABSENT =
  "Prometheus holds no metadata for this name: metadata is collected per metric family from active scrape " +
  "targets, so recording-rule outputs, ALERTS and classic histogram series have none.";

/** A readable part's text; a refusal fails the test by name. */
function textOf(part: ObjectSourcePart): string {
  if ("unavailable" in part) throw new Error(`expected a readable part, received the refusal "${part.unavailable}"`);
  return part.text;
}

describe("PROMETHEUS_OBJECT_KINDS", () => {
  test("declares six kinds in the agent walk's order, each in the engine's own words", () => {
    expect(PROMETHEUS_OBJECT_KINDS.map((kind) => [kind.id, kind.role, kind.label, kind.labelPlural])).toEqual([
      ["metric", "relation", "Metric", "Metrics"],
      ["rule_group", "group", "Rule group", "Rule groups"],
      ["recording_rule", "config", "Recording rule", "Recording rules"],
      ["alerting_rule", "config", "Alerting rule", "Alerting rules"],
      ["scrape_pool", "group", "Scrape pool", "Scrape pools"],
      ["target", "config", "Target", "Targets"],
    ]);
  });

  test("only a metric has columns, and every kind reads its source as JSON", () => {
    expect(PROMETHEUS_OBJECT_KINDS.filter((kind) => kindHasColumns(kind)).map((kind) => kind.id)).toEqual(["metric"]);
    expect(PROMETHEUS_OBJECT_KINDS.map((kind) => [kind.hasSource, kind.sourceLanguage])).toEqual(
      PROMETHEUS_OBJECT_KINDS.map(() => [true, "json"]),
    );
  });

  test("the two parents declare their children and the three children declare their parent", () => {
    expect(PROMETHEUS_OBJECT_KINDS.map((kind) => [kind.id, kind.childKinds ?? null, kind.attachedTo ?? null])).toEqual([
      ["metric", null, null],
      ["rule_group", ["recording_rule", "alerting_rule"], null],
      ["recording_rule", null, "rule_group"],
      ["alerting_rule", null, "rule_group"],
      ["scrape_pool", ["target"], null],
      ["target", null, "scrape_pool"],
    ]);
  });

  test("no kind accepts a row write or an edited definition", () => {
    for (const kind of PROMETHEUS_OBJECT_KINDS) {
      expect(kindAcceptsRowWrites(CAPABILITIES, kind.id)).toBe(false);
      expect(kindAcceptsSourceEdits(CAPABILITIES, kind.id)).toBe(false);
    }
    // Control: the same two helpers answer true for a declaration that carries the flags.
    const writable: ProviderCapabilities = {
      ...CAPABILITIES,
      objectKinds: [{ ...PROMETHEUS_OBJECT_KINDS[0], acceptsRowWrites: true, acceptsSourceEdits: true }],
    };
    expect(kindAcceptsRowWrites(writable, "metric")).toBe(true);
    expect(kindAcceptsSourceEdits(writable, "metric")).toBe(true);
  });
});

describe("identity (#1085 4.1)", () => {
  test("a rule group is keyed by its file and its name, the engine's own GroupKey", () => {
    expect(groupKey({ file: STUDIO_A, name: "studio" })).toBe(KEY_A);
  });

  test("a rule is its 1-based position among its group's rules, then its name", () => {
    expect(ruleSegment(3, "NodeFilesystemSpaceFillingUp")).toBe("3:NodeFilesystemSpaceFillingUp");
  });

  test("a target is its scrape URL and 12 hex digits of a SHA-256 over its sorted label pairs", () => {
    const url = "http://node-a:9100/metrics";
    const shared = { instance: "shared", job: "shared-instance" };
    expect(targetSegment({ scrapeUrl: url, labels: shared })).toBe(NODE_A_SEGMENT);
    // The same labels written in another order are the same label set.
    const reordered = { job: "shared-instance", instance: "shared" };
    expect(targetSegment({ scrapeUrl: url, labels: reordered })).toBe(NODE_A_SEGMENT);
  });

  test("two label sets a plain name=value join would merge keep two digests", () => {
    expect(targetSegment({ scrapeUrl: "u", labels: { "a,b": "c" } })).toBe("u c018560ef287");
    expect(targetSegment({ scrapeUrl: "u", labels: { a: "b,c" } })).toBe("u a30b36e4b8ff");
  });

  test("the fixture targets below carry the segments the listings expect", () => {
    const self = { instance: "localhost:9090", job: "prometheus" };
    const unreachable = { instance: "unreachable.invalid:9999", job: "unreachable" };
    const shared = { instance: "shared", job: "shared-instance" };
    expect(targetSegment({ scrapeUrl: "http://localhost:9090/metrics", labels: self })).toBe(SELF_SEGMENT);
    expect(targetSegment({ scrapeUrl: "http://unreachable.invalid:9999/metrics", labels: unreachable })).toBe(
      UNREACHABLE_SEGMENT,
    );
    // Two targets of one pool that share `instance` differ by URL alone.
    expect(targetSegment({ scrapeUrl: "http://node-b:9100/metrics", labels: shared })).toBe(NODE_B_SEGMENT);
    expect(NODE_B_SEGMENT).not.toBe(NODE_A_SEGMENT);
  });
});

describe("path shapes (#1085 4.1)", () => {
  test.each([
    ["metric", ["up"]],
    ["rule_group", [KEY_A]],
    ["recording_rule", [KEY_A, "1:studio:up:count"]],
    ["alerting_rule", [KEY_A, "4:StudioDuplicate"]],
    ["scrape_pool", ["prometheus"]],
    ["target", ["prometheus", SELF_SEGMENT]],
  ] as const)("a %s path of its declared shape passes", (kind, path) => {
    const spec = findKind(CAPABILITIES, kind);
    expect(spec).toBeDefined();
    expect(() => assertObjectPathShape(CAPABILITIES, spec!, kind, path, ENGINE)).not.toThrow();
  });

  test("a child addressed without its parent is refused, naming the one shape it has", () => {
    const spec = findKind(CAPABILITIES, "alerting_rule")!;
    const refuse = () => assertObjectPathShape(CAPABILITIES, spec, "alerting_rule", ["4:StudioDuplicate"], ENGINE);
    expect(refuse).toThrow(QueryError);
    expect(refuse).toThrow('A Prometheus "alerting_rule" path is [rule_group, name], received ["4:StudioDuplicate"]');
  });

  test("a root kind addressed with two segments is refused", () => {
    const spec = findKind(CAPABILITIES, "metric")!;
    const refuse = () => assertObjectPathShape(CAPABILITIES, spec, "metric", ["a", "b"], ENGINE);
    expect(refuse).toThrow(QueryError);
    expect(refuse).toThrow('A Prometheus "metric" path is [name], received ["a","b"]');
  });
});

describe("listContainers", () => {
  test("answers no container and reads nothing, because Prometheus has no container level", async () => {
    const { objects, calls } = surface();
    expect(await objects.listContainers()).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("countObjects and listObjects (#1085 4.3)", () => {
  test("counts every kind as the length of its own listing, sending each listing once", async () => {
    const { objects, calls } = surface();
    expect(await objects.countObjects([])).toEqual({
      metric: { count: 6 },
      rule_group: { count: 3 },
      recording_rule: { count: 4 },
      alerting_rule: { count: 5 },
      scrape_pool: { count: 3 },
      target: { count: 4 },
    });
    // Three kinds come from the one rules listing, and it was sent once.
    expect(tally(calls)).toEqual({ metricNames: 1, rules: 1, scrapePools: 1, targets: 1 });
  });

  test("reads the metric names over the injected hour, asking for one name more than the cap", async () => {
    const { objects, calls } = surface();
    await objects.listObjects([], "metric");
    expect(calls).toEqual([{ method: "metricNames", args: [WINDOW, METRIC_LIST_CAP + 1] }]);
  });

  test("lists a metric by its name alone, with no row count a list read never measured", async () => {
    const { objects } = surface();
    expect(await objects.listObjects([], "metric")).toEqual(
      METRIC_NAMES.map((name) => ({ path: [name], name, kind: "metric" })),
    );
  });

  test("a server truncation notice makes the count a floor, and the cap is what is listed", async () => {
    const names = Array.from({ length: METRIC_LIST_CAP }, (_, index) => `metric_${String(index).padStart(5, "0")}`);
    const { objects } = surface({ metricNames: { items: names, truncatedByServer: true } });
    const floor = { count: METRIC_LIST_CAP, sampledFrom: METRIC_LIST_SAMPLE };
    expect((await objects.countObjects([])).metric).toEqual(floor);
    expect(await objects.listObjects([], "metric")).toHaveLength(METRIC_LIST_CAP);
  });

  test("one name past the cap is the signal when no notice arrives, and that name is not listed", async () => {
    const names = Array.from({ length: METRIC_LIST_CAP + 1 }, (_, index) => `metric_${String(index).padStart(5, "0")}`);
    const { objects } = surface({ metricNames: { items: names, truncatedByServer: false } });
    const floor = { count: METRIC_LIST_CAP, sampledFrom: METRIC_LIST_SAMPLE };
    expect((await objects.countObjects([])).metric).toEqual(floor);
    const listed = (await objects.listObjects([], "metric")).map((object) => object.name);
    expect(listed).toContain(names[METRIC_LIST_CAP - 1]);
    expect(listed).not.toContain(names[METRIC_LIST_CAP]);
  });

  test("keys a rule group by file and name, so one group name in two files is two groups", async () => {
    const { objects } = surface();
    expect(await objects.listObjects([], "rule_group")).toEqual([
      { path: [KEY_A], name: "studio", kind: "rule_group" },
      { path: [KEY_B], name: "studio", kind: "rule_group" },
      { path: [KEY_C], name: "c;d", kind: "rule_group" },
    ]);
  });

  test("addresses a rule by its position in its group and names it with the group, in group order", async () => {
    const { objects } = surface();
    expect(await objects.listObjects([], "recording_rule")).toEqual([
      { path: [KEY_A, "1:studio:up:count"], name: "studio:up:count (studio)", kind: "recording_rule" },
      { path: [KEY_B, "1:nan"], name: "nan (studio)", kind: "recording_rule" },
      { path: [KEY_B, "3:sum"], name: "sum (studio)", kind: "recording_rule" },
      { path: [KEY_C, "1:semi:colon"], name: "semi:colon (c;d)", kind: "recording_rule" },
    ]);
  });

  test("an alerting rule carries firing or pending, and nothing when inactive or not yet evaluated", async () => {
    const { objects } = surface();
    expect(await objects.listObjects([], "alerting_rule")).toEqual([
      {
        path: [KEY_A, "2:StudioAlwaysFiring"],
        name: "StudioAlwaysFiring (studio)",
        kind: "alerting_rule",
        status: "firing",
      },
      {
        path: [KEY_A, "3:StudioHeldPending"],
        name: "StudioHeldPending (studio)",
        kind: "alerting_rule",
        status: "pending",
      },
      { path: [KEY_A, "4:StudioDuplicate"], name: "StudioDuplicate (studio)", kind: "alerting_rule", status: "firing" },
      { path: [KEY_A, "5:StudioDuplicate"], name: "StudioDuplicate (studio)", kind: "alerting_rule" },
      { path: [KEY_B, "2:StudioNotYetEvaluated"], name: "StudioNotYetEvaluated (studio)", kind: "alerting_rule" },
    ]);
  });

  test("lists scrape pools by name", async () => {
    const { objects } = surface();
    expect(await objects.listObjects([], "scrape_pool")).toEqual(
      POOLS.map((pool) => ({ path: [pool], name: pool, kind: "scrape_pool" })),
    );
  });

  test("addresses a target by URL and label digest, and flags down and unknown", async () => {
    const { objects } = surface();
    expect(await objects.listObjects([], "target")).toEqual([
      { path: ["prometheus", SELF_SEGMENT], name: "localhost:9090 (prometheus)", kind: "target" },
      { path: ["shared-instance", NODE_A_SEGMENT], name: "shared (shared-instance)", kind: "target" },
      {
        path: ["shared-instance", NODE_B_SEGMENT],
        name: "shared (shared-instance)",
        kind: "target",
        status: "unknown",
      },
      {
        path: ["unreachable", UNREACHABLE_SEGMENT],
        name: "unreachable.invalid:9999 (unreachable)",
        kind: "target",
        status: "down",
      },
    ]);
  });

  test("a refused listing is its kinds' refusal, in the transport's sentence, and the rest still count", async () => {
    const refusal = new PrometheusTransportError("unauthorized", "Prometheus refused the credentials (HTTP 401)", {
      status: 401,
    });
    const { objects, calls } = surface({ failures: { rules: refusal } });
    expect(await objects.countObjects([])).toEqual({
      metric: { count: 6 },
      rule_group: { unavailable: "Prometheus refused the credentials (HTTP 401)" },
      recording_rule: { unavailable: "Prometheus refused the credentials (HTTP 401)" },
      alerting_rule: { unavailable: "Prometheus refused the credentials (HTTP 401)" },
      scrape_pool: { count: 3 },
      target: { count: 4 },
    });
    expect(tally(calls).rules).toBe(1);
  });

  test("a redirect the sender refused is that listing's refusal, and the rest still count", async () => {
    // The shared module's refusal, which the transport passes through unchanged: a ConnectionError
    // naming the status and the target's origin only.
    const redirect = new ConnectionError(
      "The server answered HTTP 302, a redirect to https://sso.example, and redirects are not followed",
    );
    const { objects } = surface({ failures: { rules: redirect } });
    expect(await objects.countObjects([])).toEqual({
      metric: { count: 6 },
      rule_group: { unavailable: redirect.message },
      recording_rule: { unavailable: redirect.message },
      alerting_rule: { unavailable: redirect.message },
      scrape_pool: { count: 3 },
      target: { count: 4 },
    });
  });

  test("a fault that is not the transport's is not dressed up as a refusal", async () => {
    const { objects } = surface({ failures: { targets: new TypeError("targets is not iterable") } });
    await expect(objects.countObjects([])).rejects.toBeInstanceOf(TypeError);
  });

  test("an undeclared kind is refused before any read", async () => {
    const { objects, calls } = surface();
    const listing = objects.listObjects([], "exemplar");
    await expect(listing).rejects.toBeInstanceOf(QueryError);
    await expect(listing).rejects.toThrow('Prometheus declares no object kind "exemplar"');
    expect(calls).toEqual([]);
  });

  test("a container path is refused before any read, because there is no container to be in", async () => {
    const { objects, calls } = surface();
    await expect(objects.countObjects(["default"])).rejects.toThrow(
      'A Prometheus container path has 0 segment(s), received ["default"]',
    );
    await expect(objects.listObjects(["default"], "metric")).rejects.toBeInstanceOf(QueryError);
    expect(calls).toEqual([]);
  });

  test("a kind the declaration gains without a reader fails loudly instead of counting zero", async () => {
    const capabilities: ProviderCapabilities = {
      ...CAPABILITIES,
      objectKinds: [
        ...PROMETHEUS_OBJECT_KINDS,
        { id: "exemplar", role: "config", label: "Exemplar", labelPlural: "Exemplars" },
      ],
    };
    const { objects } = surface({ capabilities });
    await expect(objects.countObjects([])).rejects.toThrow(
      'Prometheus declares the object kind "exemplar" and has no reader for it',
    );
  });
});

describe("the tree this declaration draws (#1085 4.1)", () => {
  test("six root folders, and every object row a leaf except a metric's", async () => {
    const { objects } = surface();
    const listed: Record<string, DatabaseObject[]> = {};
    for (const kind of PROMETHEUS_OBJECT_KINDS) listed[kind.id] = await objects.listObjects([], kind.id);
    const rows = flattenTree({
      kinds: PROMETHEUS_OBJECT_KINDS,
      containers: await objects.listContainers(),
      expanded: new Set(PROMETHEUS_OBJECT_KINDS.map((kind) => kind.id)),
      counts: { "": await objects.countObjects([]) },
      objects: listed,
      details: {},
      readsColumns: true,
      containerDepth: containerDepth(CAPABILITIES),
    });
    expect(rows.filter((row) => row.kind === "folder").map((row) => `${row.depth}:${row.label}:${row.badge}`)).toEqual([
      "0:Metrics:6",
      "0:Rule groups:3",
      "0:Recording rules:4",
      "0:Alerting rules:5",
      "0:Scrape pools:3",
      "0:Targets:4",
    ]);
    const objectRows = rows.filter((row) => row.kind === "object");
    expect(objectRows).toHaveLength(25);
    // A leaf carries no `expanded` at all; a metric carries it, closed, because its kind has columns.
    expect(objectRows.filter((row) => row.expanded !== undefined).map((row) => row.kindId)).toEqual(
      METRIC_NAMES.map(() => "metric"),
    );
    expect(objectRows.filter((row) => row.expanded === undefined)).toHaveLength(19);
    // A child's row is named with its parent, because no folder nests it under one.
    expect(objectRows.filter((row) => row.kindId === "alerting_rule").map((row) => row.label)).toContain(
      "StudioDuplicate (studio)",
    );
  });
});

describe("identity over the captured compose answers (#1085 4.1)", () => {
  test("one group name in two files is two rule groups, each keyed by its own file", async () => {
    const groups = capturedGroups();
    const shared = groups.filter((group) => groups.some((other) => other !== group && other.name === group.name));
    expect(shared.length).toBeGreaterThanOrEqual(2);
    const listed = await capturedSurface().listObjects([], "rule_group");
    expect(listed.map((object) => object.path)).toEqual(groups.map((group) => [`${group.file};${group.name}`]));
    expect(new Set(listed.map((object) => object.path[0])).size).toBe(listed.length);
  });

  test("an alert name repeated in one group is two rules, one per position", async () => {
    const repeated = capturedGroups().flatMap((group) =>
      group.rules.flatMap((rule, index) =>
        rule.type === "alerting" &&
        group.rules.some((other, position) => position !== index && other.name === rule.name)
          ? [[`${group.file};${group.name}`, `${index + 1}:${rule.name}`]]
          : [],
      ),
    );
    expect(repeated.length).toBeGreaterThanOrEqual(2);
    const paths = (await capturedSurface().listObjects([], "alerting_rule")).map((object) => object.path);
    expect(paths).toEqual(expect.arrayContaining(repeated));
    expect(new Set(paths.map((path) => pathKey(path))).size).toBe(paths.length);
  });

  test("two targets sharing an instance in one pool are two targets, told apart by their label digest", async () => {
    const targets = capturedTargets();
    const sharing = targets.filter((candidate) =>
      targets.some(
        (other) =>
          other !== candidate &&
          other.scrapePool === candidate.scrapePool &&
          other.labels.instance === candidate.labels.instance,
      ),
    );
    expect(sharing.length).toBeGreaterThanOrEqual(2);
    // They share the scrape URL too, so only the digest over their labels can separate their paths.
    expect(new Set(sharing.map((raw) => raw.scrapeUrl)).size).toBeLessThan(sharing.length);
    const listed = await capturedSurface().listObjects([], "target");
    for (const raw of sharing) {
      const matches = listed.filter(
        (object) => object.path[0] === raw.scrapePool && object.path[1] === targetSegment(raw),
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.name).toBe(`${raw.labels.instance} (${raw.scrapePool})`);
    }
    expect(new Set(listed.map((object) => pathKey(object.path))).size).toBe(listed.length);
  });

  test("a target the server reports down carries that word, and one it reports up carries none", async () => {
    const targets = capturedTargets();
    const down = targets.filter((candidate) => candidate.health === "down");
    const up = targets.filter((candidate) => candidate.health === "up");
    expect(down.length).toBeGreaterThanOrEqual(1);
    expect(up.length).toBeGreaterThanOrEqual(1);
    const listed = await capturedSurface().listObjects([], "target");
    const statusOf = (raw: RawTarget) =>
      listed.find((object) => object.path[0] === raw.scrapePool && object.path[1] === targetSegment(raw))?.status;
    expect(down.map(statusOf)).toEqual(down.map(() => "down"));
    expect(up.map(statusOf)).toEqual(up.map(() => undefined));
  });
});

describe("describeObject (#1085 4.2)", () => {
  test("a metric's columns are its label names over the hour, then timestamp and value", async () => {
    const { objects, calls } = surface();
    expect(await objects.describeObject(["up"], "metric")).toEqual({
      path: ["up"],
      columns: [
        { name: "__name__", type: "string", nullable: false, isPrimary: false },
        { name: "instance", type: "string", nullable: true, isPrimary: false },
        { name: "job", type: "string", nullable: true, isPrimary: false },
        { name: "timestamp", type: "timestamp", nullable: false, isPrimary: false },
        { name: "value", type: "float64 or histogram", nullable: false, isPrimary: false },
      ],
      indexes: [],
      foreignKeys: [],
    });
    expect(calls).toEqual([{ method: "labelNames", args: ["up", WINDOW] }]);
  });

  test("a label named like a sample field, or not a legacy name, gets the grid's own field name", async () => {
    // The tree's columns and the grid's fields come from one function, so the two never name a label apart.
    const labels = ["__name__", "value", "timestamp", "service.name", "job"];
    const { objects } = surface({ labelNames: { http_server_duration_seconds_count: labels } });
    const detail = await objects.describeObject(["http_server_duration_seconds_count"], "metric");
    const names = detail.columns.map((column) => column.name);
    expect(names).toEqual(vectorFieldNames(labels));
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(['"value"', '"timestamp"', '"service.name"']));
    expect(names.slice(-2)).toEqual(["timestamp", "value"]);
  });

  test("a metric with no series in the hour has no columns, not a timestamp and a value", async () => {
    // Every series carries its metric name, so a labels read that names no label found no series.
    const { objects, calls } = surface();
    expect(await objects.describeObject(["studio_quiet_metric"], "metric")).toEqual({
      path: ["studio_quiet_metric"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    expect(calls).toEqual([{ method: "labelNames", args: ["studio_quiet_metric", WINDOW] }]);
    // Control: the metric-name label alone is a series, described with the sample's two fields.
    const named = surface({ labelNames: { studio_quiet_metric: ["__name__"] } });
    const detail = await named.objects.describeObject(["studio_quiet_metric"], "metric");
    expect(detail.columns.map((column) => column.name)).toEqual(["__name__", "timestamp", "value"]);
  });

  test("a metric named like a PromQL keyword is read through the one selector builder (#1085 S4)", async () => {
    const selector = metricSelector("sum");
    const { objects, calls } = surface({ labelNames: { [selector]: ["__name__"] } });
    await objects.describeObject(["sum"], "metric");
    expect(selector).toBe('{__name__="sum"}');
    expect(calls).toEqual([{ method: "labelNames", args: [selector, WINDOW] }]);
  });

  test.each([
    ["rule_group", [KEY_A]],
    ["recording_rule", [KEY_A, "1:studio:up:count"]],
    ["alerting_rule", [KEY_A, "2:StudioAlwaysFiring"]],
    ["scrape_pool", ["prometheus"]],
    ["target", ["prometheus", SELF_SEGMENT]],
  ] as const)("a %s has no columns, and none are read", async (kind, path) => {
    const { objects, calls } = surface();
    expect(await objects.describeObject(path, kind)).toEqual({
      path: [...path],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    expect(calls).toEqual([]);
  });

  test("a path of the wrong shape is refused before any read", async () => {
    const { objects, calls } = surface();
    const read = objects.describeObject(["up", "extra"], "metric");
    await expect(read).rejects.toBeInstanceOf(QueryError);
    await expect(read).rejects.toThrow('A Prometheus "metric" path is [name], received ["up","extra"]');
    expect(calls).toEqual([]);
  });

  test("an undeclared kind is refused", async () => {
    const { objects } = surface();
    await expect(objects.describeObject(["x"], "exemplar")).rejects.toThrow(
      'Prometheus declares no object kind "exemplar"',
    );
  });
});

describe("describeObjects (#1085 4.2)", () => {
  test("describes every metric of the folder from ONE series read, grouped by metric name", async () => {
    const { objects, calls } = surface();
    const batch = await objects.describeObjects([], "metric");
    expect(batch.details.map((detail) => detail.path)).toEqual(METRIC_NAMES.map((name) => [name]));
    expect(batch.truncated).toBeUndefined();
    // Two label sets of one metric are one column list: their union.
    const requests = batch.details.find((detail) => detail.path[0] === "prometheus_http_requests_total");
    expect(requests?.columns.map((column) => column.name)).toEqual(
      vectorFieldNames(["__name__", "code", "handler", "instance", "job", "service.name"]),
    );
    expect(calls).toEqual([{ method: "seriesLabels", args: [ALL_METRICS_SELECTOR, WINDOW, DESCRIBE_SERIES_CAP + 1] }]);
  });

  test("the caller's limit bounds the batch in the shared sentence, still in one read", async () => {
    const { objects, calls } = surface();
    const batch = await objects.describeObjects([], "metric", 2);
    expect(batch.details.map((detail) => detail.path)).toEqual([["go_goroutines"], ["nan"]]);
    expect(batch.truncated).toEqual({ limit: 2, reason: callerBoundTruncationReason(2) });
    expect(calls).toHaveLength(1);
  });

  test("the series cap marks an unbounded batch truncated in this provider's own words", async () => {
    const { objects } = surface({ seriesLabels: { items: SERIES, truncatedByServer: true } });
    const batch = await objects.describeObjects([], "metric");
    expect(batch.details).toHaveLength(METRIC_NAMES.length);
    // Not the caller's sentence: no caller passed a limit, and the conformance helper refuses that.
    expect(batch.truncated).toEqual({ limit: METRIC_NAMES.length, reason: SERIES_BOUND });
  });

  test("one series past the cap is the signal when no notice arrives, and that series is not read", async () => {
    const items = [
      ...Array.from({ length: DESCRIBE_SERIES_CAP }, (_, index) => ({ __name__: "bulk", shard: String(index) })),
      { __name__: "past_the_cap" },
    ];
    const { objects } = surface({ seriesLabels: { items, truncatedByServer: false } });
    const batch = await objects.describeObjects([], "metric");
    expect(batch.details.map((detail) => detail.path)).toEqual([["bulk"]]);
    expect(batch.truncated).toEqual({ limit: 1, reason: SERIES_BOUND });
  });

  test("both bounds biting are both named, the caller's first, joined the Redis way", async () => {
    const { objects } = surface({ seriesLabels: { items: SERIES, truncatedByServer: true } });
    const batch = await objects.describeObjects([], "metric", 1);
    expect(batch.details.map((detail) => detail.path)).toEqual([["go_goroutines"]]);
    expect(batch.truncated).toEqual({ limit: 1, reason: `${callerBoundTruncationReason(1)}, and ${SERIES_BOUND}` });
  });

  test.each(["rule_group", "recording_rule", "alerting_rule", "scrape_pool", "target"])(
    "a %s folder answers an empty batch with no read",
    async (kind) => {
      const { objects, calls } = surface();
      expect(await objects.describeObjects([], kind)).toEqual({ details: [] });
      expect(calls).toEqual([]);
    },
  );

  test.each([0, -1, 1.5])("a limit of %p is refused before any read", async (limit) => {
    const { objects, calls } = surface();
    await expect(objects.describeObjects([], "metric", limit)).rejects.toThrow(
      `A Prometheus bulk column read limit must be a positive whole number, received ${limit}`,
    );
    expect(calls).toEqual([]);
  });
});

describe("readObjectSource: metrics (#1085 4.4)", () => {
  test("a metric's metadata is one rendered JSON part, the entry as the engine sent it", async () => {
    const { objects, calls } = surface();
    expect(await objects.readObjectSource(["prometheus_http_requests_total"], "metric")).toEqual({
      path: ["prometheus_http_requests_total"],
      kind: "metric",
      parts: [
        {
          id: "metadata",
          label: "Metadata",
          text: JSON.stringify({ family: "prometheus_http_requests_total", ...COUNTER_ENTRY }, null, 2),
          language: "json",
          form: "complete",
          origin: "rendered",
        },
      ],
    });
    expect(calls.map((call) => call.method)).toEqual(["metricNames", "metadata"]);
  });

  test.each(["_bucket", "_sum", "_count", "_total", "_created"])(
    "a series ending in %s falls back to its family's metadata",
    async (suffix) => {
      const family = "prometheus_http_request_duration_seconds";
      const name = `${family}${suffix}`;
      const { objects, calls } = surface({
        metricNames: { items: [name], truncatedByServer: false },
        metadata: { [family]: [HISTOGRAM_ENTRY] },
      });
      const document = await objects.readObjectSource([name], "metric");
      expect(JSON.parse(textOf(document.parts[0]))).toEqual({ family, ...HISTOGRAM_ENTRY });
      expect(calls.filter((call) => call.method === "metadata").map((call) => call.args[0])).toEqual([name, family]);
    },
  );

  test("a name with no metadata under it or its family answers the engine's reason after both lookups", async () => {
    const name = "studio_requests_total";
    const { objects, calls } = surface({ metricNames: { items: [name], truncatedByServer: false } });
    expect((await objects.readObjectSource([name], "metric")).parts).toEqual([
      { id: "metadata", label: "Metadata", unavailable: METADATA_ABSENT },
    ]);
    expect(calls.filter((call) => call.method === "metadata").map((call) => call.args[0])).toEqual([
      name,
      "studio_requests",
    ]);
  });

  test("a name with no suffix to remove, or one that is only a suffix, is looked up once", async () => {
    for (const name of ["up", "_total"]) {
      const { objects, calls } = surface({ metricNames: { items: [name], truncatedByServer: false } });
      expect((await objects.readObjectSource([name], "metric")).parts).toEqual([
        { id: "metadata", label: "Metadata", unavailable: METADATA_ABSENT },
      ]);
      expect(calls.filter((call) => call.method === "metadata").map((call) => call.args[0])).toEqual([name]);
    }
  });

  test("distinct entries are one part each in a stable order, and a repeated entry is one part", async () => {
    const older: PrometheusMetadataEntry = { type: "gauge", help: "Number of goroutines.", unit: "" };
    const { objects } = surface({ metadata: { go_goroutines: [older, GAUGE_ENTRY, older] } });
    const { parts } = await objects.readObjectSource(["go_goroutines"], "metric");
    expect(parts.map((part) => [part.id, part.label])).toEqual([
      ["metadata-1", "Metadata 1 of 2"],
      ["metadata-2", "Metadata 2 of 2"],
    ]);
    expect(parts.map((part) => JSON.parse(textOf(part)).help)).toEqual([GAUGE_ENTRY.help, older.help]);
  });

  test("more distinct entries than one document carries keep every entry, the last part holding the rest", async () => {
    const total = SOURCE_PART_LIMIT + 2;
    const entries = Array.from({ length: total }, (_, index) => ({
      type: "counter",
      help: `Help text ${String(index).padStart(2, "0")}.`,
      unit: "",
    }));
    const { objects } = surface({ metadata: { go_goroutines: entries } });
    const { parts } = await objects.readObjectSource(["go_goroutines"], "metric");
    expect(parts).toHaveLength(SOURCE_PART_LIMIT);
    expect(parts.map((part) => part.label)).toEqual([
      ...Array.from({ length: SOURCE_PART_LIMIT - 1 }, (_, index) => `Metadata ${index + 1} of ${total}`),
      `Metadata ${SOURCE_PART_LIMIT} to ${total} of ${total}`,
    ]);
    const rest = JSON.parse(textOf(parts[SOURCE_PART_LIMIT - 1])) as { help: string }[];
    expect(rest.map((entry) => entry.help)).toEqual(entries.slice(SOURCE_PART_LIMIT - 1).map((entry) => entry.help));
  });

  test("a name outside a complete listing does not exist, and no query is sent to ask", async () => {
    const { objects, calls } = surface();
    const read = objects.readObjectSource(["no_such_metric"], "metric");
    await expect(read).rejects.toBeInstanceOf(QueryError);
    await expect(read).rejects.toThrow("Prometheus reports no metric named no_such_metric");
    expect(calls.map((call) => call.method)).toEqual(["metricNames"]);
  });

  test("a name outside a capped listing is asked about over the listing's hour, with its one selector", async () => {
    const expression = `count(last_over_time(${metricSelector("nan")}[1h]))`;
    const { objects, calls } = surface({
      metricNames: { items: ["go_goroutines"], truncatedByServer: true },
      counts: { [expression]: 1 },
    });
    const document = await objects.readObjectSource(["nan"], "metric");
    // `[1h]` is the listing's own window, pinned here beside the text, so a metric the listing could
    // show is never called absent, and a change to the window fails this test until the range follows.
    expect(INVENTORY_WINDOW_MS).toBe(3_600_000);
    expect(expression).toBe('count(last_over_time({__name__="nan"}[1h]))');
    expect(calls.find((call) => call.method === "query")?.args).toEqual([expression, QUERY_OPTIONS]);
    expect(document.parts).toEqual([{ id: "metadata", label: "Metadata", unavailable: METADATA_ABSENT }]);
  });

  test("an existence read that finds no series outside a capped listing is the same QueryError", async () => {
    const { objects, calls } = surface({ metricNames: { items: ["go_goroutines"], truncatedByServer: true } });
    await expect(objects.readObjectSource(["gone_metric"], "metric")).rejects.toThrow(
      "Prometheus reports no metric named gone_metric",
    );
    // The refusal comes after the one existence read was asked, not instead of it.
    expect(calls.filter((call) => call.method === "query").map((call) => call.args[0])).toEqual([
      `count(last_over_time(${metricSelector("gone_metric")}[1h]))`,
    ]);
  });
});

describe("readObjectSource: rules (#1085 4.4)", () => {
  test("a rule group answers its evaluation facts from its listing entry", async () => {
    const { objects, calls } = surface();
    const { parts } = await objects.readObjectSource([KEY_A], "rule_group");
    expect(parts).toEqual([
      {
        id: "group",
        label: "Rule group",
        text: JSON.stringify(
          {
            file: STUDIO_A,
            name: "studio",
            interval: 15,
            limit: 0,
            evaluationTime: 0.0021,
            lastEvaluation: EVALUATED_AT,
            ruleCount: 5,
          },
          null,
          2,
        ),
        language: "json",
        form: "complete",
        origin: "rendered",
      },
    ]);
    // The listing, alerts excluded, is the only read: it already carries every fact the part renders.
    expect(calls.map((call) => call.args)).toEqual([[undefined]]);
  });

  test("a group whose file and name both hold ';' is found by its key, never by splitting it", async () => {
    const { objects, calls } = surface();
    const { parts } = await objects.readObjectSource([KEY_C], "rule_group");
    expect(JSON.parse(textOf(parts[0]))).toMatchObject({ file: SEMICOLON_FILE, name: "c;d", ruleCount: 1 });
    expect(calls.map((call) => call.args)).toEqual([[undefined]]);
  });

  test("a recording rule answers the rule as the listing has it", async () => {
    const { objects, calls } = surface();
    const { parts } = await objects.readObjectSource([KEY_B, "3:sum"], "recording_rule");
    expect(parts[0]).toMatchObject({ id: "rule", label: "Recording rule", language: "json" });
    expect(JSON.parse(textOf(parts[0]))).toEqual({
      name: "sum",
      query: "vector(2)",
      labels: {},
      health: "ok",
      lastError: "",
      evaluationTime: 0.0003,
      lastEvaluation: EVALUATED_AT,
    });
    expect(calls.map((call) => call.args)).toEqual([[undefined]]);
  });

  test("an alerting rule answers its definition, then its live state from the read that names it", async () => {
    const { objects, calls } = surface();
    const { parts } = await objects.readObjectSource([KEY_A, "2:StudioAlwaysFiring"], "alerting_rule");
    expect(parts.map((part) => [part.id, part.label])).toEqual([
      ["definition", "Definition"],
      ["state", "Live state"],
    ]);
    expect(JSON.parse(textOf(parts[0]))).toEqual({
      name: "StudioAlwaysFiring",
      query: "vector(1)",
      duration: 0,
      keepFiringFor: 0,
      labels: { severity: "none" },
      annotations: { summary: ALWAYS_FIRING_SUMMARY },
      health: "ok",
      lastError: "",
    });
    expect(JSON.parse(textOf(parts[1]))).toEqual({ state: "firing", alerts: [FIRING_ALERT] });
    // The listing gives the definition; the one read that names the rule is the one carrying alerts.
    expect(calls.map((call) => call.args[0])).toEqual([
      undefined,
      { group: "studio", file: STUDIO_A, ruleName: "StudioAlwaysFiring" },
    ]);
  });

  test("a repeated alert name is read by its occurrence among the rules of that name", async () => {
    const { objects } = surface();
    const second = await objects.readObjectSource([KEY_A, "5:StudioDuplicate"], "alerting_rule");
    expect(JSON.parse(textOf(second.parts[0])).query).toBe("up == 2");
    expect(JSON.parse(textOf(second.parts[1]))).toEqual({ state: "inactive", alerts: [] });
    // Control: the first of the two is the one that fires.
    const first = await objects.readObjectSource([KEY_A, "4:StudioDuplicate"], "alerting_rule");
    expect(JSON.parse(textOf(first.parts[1]))).toEqual({ state: "firing", alerts: [DUPLICATE_ALERT] });
  });

  test("server text is data: an annotation written as JSON comes back as the string it is (#1085 S7)", async () => {
    const forged = '"}, "forged": {"x": 1}, "y": {"';
    const group: PrometheusRuleGroup = {
      ...GROUP_A,
      rules: [alerting("StudioForged", "inactive", { annotations: { summary: forged } })],
    };
    const { objects } = surface({ ruleGroups: [group] });
    const { parts } = await objects.readObjectSource([KEY_A, "1:StudioForged"], "alerting_rule");
    const definition = JSON.parse(textOf(parts[0]));
    expect(definition.annotations).toEqual({ summary: forged });
    expect(Object.keys(definition)).toEqual([
      "name",
      "query",
      "duration",
      "keepFiringFor",
      "labels",
      "annotations",
      "health",
      "lastError",
    ]);
  });

  test("a rule gone between the listing and the read that names it is the same QueryError", async () => {
    // The listing still holds the rule; the read that names it finds nothing left.
    const { objects } = surface({ filteredRules: () => [] });
    await expect(objects.readObjectSource([KEY_A, "2:StudioAlwaysFiring"], "alerting_rule")).rejects.toThrow(
      `Prometheus has no alerting rule 2:StudioAlwaysFiring in the rule group ${KEY_A}`,
    );
  });
});

describe("readObjectSource: scrape pools and targets (#1085 4.4)", () => {
  test("a scrape pool answers its active targets counted by health", async () => {
    const { objects, calls } = surface();
    const { parts } = await objects.readObjectSource(["shared-instance"], "scrape_pool");
    expect(parts).toEqual([
      {
        id: "targets",
        label: "Targets by health",
        text: JSON.stringify(
          { scrapePool: "shared-instance", targets: 2, targetsByHealth: { unknown: 1, up: 1 } },
          null,
          2,
        ),
        language: "json",
        form: "complete",
        origin: "rendered",
      },
    ]);
    expect(calls).toEqual([
      { method: "scrapePools", args: [] },
      { method: "targets", args: ["shared-instance"] },
    ]);
  });

  test("a target answers the fields 4.4 names, read from its own pool", async () => {
    const { objects, calls } = surface();
    const unreachable = TARGETS.find((candidate) => candidate.scrapePool === "unreachable")!;
    const { parts } = await objects.readObjectSource(["unreachable", UNREACHABLE_SEGMENT], "target");
    expect(JSON.parse(textOf(parts[0]))).toEqual({
      scrapeUrl: unreachable.scrapeUrl,
      health: "down",
      lastError: unreachable.lastError,
      lastScrape: unreachable.lastScrape,
      lastScrapeDuration: unreachable.lastScrapeDuration,
      scrapeInterval: "15s",
      scrapeTimeout: "10s",
      labels: unreachable.labels,
      discoveredLabels: unreachable.discoveredLabels,
    });
    expect(calls).toEqual([{ method: "targets", args: ["unreachable"] }]);
  });
});

describe("readObjectSource: absence, bounds and guards (#1085 4.4)", () => {
  test.each([
    ["metric", ["no_such_metric"]],
    ["rule_group", [`${STUDIO_A};no-such-group`]],
    ["recording_rule", [KEY_A, "9:studio:up:count"]],
    ["recording_rule", [KEY_A, "2:StudioAlwaysFiring"]],
    ["alerting_rule", [KEY_A, "1:studio:up:count"]],
    ["scrape_pool", ["no-such-pool"]],
    ["target", ["prometheus", "http://localhost:9090/metrics 000000000000"]],
  ] as const)("a %s that does not exist is a QueryError naming its last segment: %p", async (kind, path) => {
    const { objects } = surface();
    const read = objects.readObjectSource(path, kind);
    await expect(read).rejects.toBeInstanceOf(QueryError);
    await expect(read).rejects.toThrow(path[path.length - 1]);
  });

  test("a caller's limit bounds each readable part with the shared sentence", async () => {
    const { objects } = surface();
    const whole = textOf((await objects.readObjectSource([KEY_A], "rule_group")).parts[0]);
    const { parts } = await objects.readObjectSource([KEY_A], "rule_group", 12);
    expect(parts).toEqual([
      {
        id: "group",
        label: "Rule group",
        text: whole.slice(0, 12),
        language: "json",
        form: "complete",
        origin: "rendered",
        truncated: { limit: 12, reason: sourceBoundTruncationReason(12) },
      },
    ]);
  });

  test("a part read whole is never marked, and a refusal is never cut", async () => {
    const { objects } = surface();
    const unbounded = (await objects.readObjectSource([KEY_A], "rule_group")).parts[0];
    const bounded = (await objects.readObjectSource([KEY_A], "rule_group", 12)).parts[0];
    expect(unbounded).not.toHaveProperty("truncated");
    expect(bounded).toHaveProperty("truncated");
    // A refusal is the engine's sentence, whole, under any bound.
    expect((await objects.readObjectSource(["up"], "metric", 12)).parts).toEqual([
      { id: "metadata", label: "Metadata", unavailable: METADATA_ABSENT },
    ]);
  });

  test("an undeclared kind is refused through the shared entry guard, before any read", async () => {
    const { objects, calls } = surface();
    await expect(objects.readObjectSource(["x"], "exemplar")).rejects.toThrow(
      'Prometheus declares no object kind "exemplar"',
    );
    expect(calls).toEqual([]);
  });

  test("a path of the wrong shape is refused before any read", async () => {
    const { objects, calls } = surface();
    await expect(objects.readObjectSource(["prometheus"], "target")).rejects.toThrow(
      'A Prometheus "target" path is [scrape_pool, name], received ["prometheus"]',
    );
    expect(calls).toEqual([]);
  });

  test("a source kind the declaration gains without a reader fails loudly", async () => {
    const capabilities: ProviderCapabilities = {
      ...CAPABILITIES,
      objectKinds: [
        ...PROMETHEUS_OBJECT_KINDS,
        {
          id: "exemplar",
          role: "config",
          label: "Exemplar",
          labelPlural: "Exemplars",
          hasSource: true,
          sourceLanguage: "json",
        },
      ],
    };
    const { objects } = surface({ capabilities });
    await expect(objects.readObjectSource(["x"], "exemplar")).rejects.toThrow(
      'Prometheus declares source for the object kind "exemplar" and has no reader for it',
    );
  });
});

describe("the shared object surface contract", () => {
  test("holds over the inline answers", async () => {
    // The helper reads the six object methods, the capabilities and `type`, and nothing else, so the
    // methods are handed to it as they are; the provider's integration test runs the same helper
    // through the real composition over the captured answers.
    const { objects } = surface();
    const provider = {
      type: ENGINE.code,
      getCapabilities: () => CAPABILITIES,
      listContainers: (parent?: readonly string[]) => objects.listContainers(parent),
      countObjects: (container: readonly string[]) => objects.countObjects(container),
      listObjects: (container: readonly string[], kind: string) => objects.listObjects(container, kind),
      describeObject: (path: readonly string[], kind: string) => objects.describeObject(path, kind),
      describeObjects: (container: readonly string[], kind: string, limit?: number) =>
        objects.describeObjects(container, kind, limit),
      readObjectSource: (path: readonly string[], kind: string, limit?: number) =>
        objects.readObjectSource(path, kind, limit),
    };
    await assertObjectSurface(provider as never, {
      containers: [],
      kinds: { metric: 6, rule_group: 3, recording_rule: 4, alerting_rule: 5, scrape_pool: 3, target: 4 },
      sampleObject: { path: ["up"], kind: "metric" },
      absentSource: { path: ["no_such_metric"], kind: "metric" },
    });
  });
});
