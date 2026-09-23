/**
 * Prometheus HTTP transport (#1085 sections 3.1, 4.6, 5.1, 5.2, 5.4, 5.5, 6.1 and 6.2, #1085 S3 and #1085 S4)
 *
 * The transport takes its request function by injection, so no global stands in for the server: each
 * test hands it a fake `SendRequest` that records every `OutboundRequest` and answers from a queue.
 * `mock.module()` is not used anywhere, being process-wide in bun. The one global replaced is
 * `AbortSignal.timeout`, per test and restored in afterEach, because the deadline each request carries is
 * itself under test: the recorder hands out signals the test fires by hand, so no test waits on a clock.
 *
 * CAPTURED: every answer read through tests/helpers/prometheus-fixtures.ts is the verbatim answer of the
 * live compose `prometheus` service (prom/prometheus:v3.13.3), replayed with its own status, content type
 * and bytes, and the fixture README names the request behind each. A test labelled "captured from
 * VictoriaMetrics" replays the compose `victoriametrics` service (victoriametrics/victoria-metrics:v1.152.0)
 * the same way: a relative whose answers leave out members that only describe an object, and which
 * refuses paths it does not serve in text of its own. CONSTRUCTED, and labelled so at each
 * use, is only what no capture holds: a native histogram with no buckets, the rule and alert members the
 * engine omits, notice lists no capture combines, a metadata family named like an Object.prototype member,
 * the error types the live server was not provoked into, refusals carrying a marker, a proxy's bodies, and
 * every malformed or non-envelope body. Their shapes follow web/api/v1/api.go and util/jsonutil/marshal.go
 * at v3.13.3.
 *
 * One test leaves the process, the #1085 S4 test: it sends a query through the real `createSendRequest(null)`
 * to a local server and reads what arrived.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConnectionError } from "@/lib/db/errors";
import { rejectRedirect } from "@/lib/db/http/endpoint";
import {
  authorizationFor,
  createHttpTransport,
  type HttpTransportDeps,
  type PrometheusCredentials,
  type PrometheusEndpoint,
  RESPONSE_BYTE_CAP,
} from "@/lib/db/providers/timeseries/prometheus/http-transport";
import {
  createSendRequest,
  type InboundResponse,
  type OutboundRequest,
  RequestFailure,
  type RequestFailureDetail,
  type RequestFailureReason,
} from "@/lib/db/providers/timeseries/prometheus/request";
import {
  type PrometheusAlert,
  type PrometheusMetadataEntry,
  type PrometheusQueryOptions,
  type PrometheusRule,
  type PrometheusRuleGroup,
  type PrometheusTarget,
  type PrometheusTransport,
  PrometheusTransportError,
  type PrometheusTsdbStatus,
  type TimeWindow,
} from "@/lib/db/providers/timeseries/prometheus/transport";
import { capture, captureBody, captureVm, captureVmBody } from "../../../helpers/prometheus-fixtures";

// ============================================================================
// Harness
// ============================================================================

const ORIGIN = "http://127.0.0.1:9090";
const REQUEST_TIMEOUT_MS = 7_000;
/** Distinct from RESPONSE_BYTE_CAP on purpose: a request carrying the constant instead of the dependency is caught. */
const MAX_BYTES = 4_096;
const QUERY_OPTIONS: PrometheusQueryOptions = { timeoutMs: 30_000, seriesLimit: 250 };
/** One hour ending 2026-09-23T10:00:00Z. The start carries a fraction, so float seconds are seen to pass as written. */
const WINDOW: TimeWindow = { startSeconds: 1_790_154_000.25, endSeconds: 1_790_157_600 };
const GROUP_FILTER = { group: "studio;dup", file: "/etc/prometheus/rules/studio a.yml" } as const;
const JSON_ACCEPT = { accept: "application/json" };
/** A sample time for CONSTRUCTED bodies: 2026-09-23T10:00:00Z in float seconds. */
const AT = 1_790_157_600;
/** The expressions two captures answered, exactly as the fixture README records their requests. */
const NATIVE_HISTOGRAM_SELECTOR = 'prometheus_http_request_duration_seconds{handler="/api/v1/query"}';
const SPECIAL_VALUES = [
  'label_replace(vector(0/0), "v", "nan", "__name__", ".*")',
  'label_replace(vector(1/0), "v", "pos_inf", "__name__", ".*")',
  'label_replace(vector(-1/0), "v", "neg_inf", "__name__", ".*")',
].join(" or ");

/** Builds URLs on a fixed origin. A test double for the port, not a validator (#1085 S1 is the shared module's). */
function endpointOn(origin: string): PrometheusEndpoint {
  return {
    url(pathname, query) {
      const url = new URL(pathname, origin);
      if (query !== undefined) url.search = query.toString();
      return url;
    },
  };
}

interface Reply {
  readonly status?: number;
  readonly contentType?: string | null;
  readonly body: string;
}

let sent: OutboundRequest[] = [];
let replies: Reply[] = [];
let sendFailure: unknown = null;

/** The fake sender: records every request, then throws `sendFailure` when one is set, or answers the next reply. */
async function send(request: OutboundRequest): Promise<InboundResponse> {
  sent.push(request);
  if (sendFailure !== null) throw sendFailure;
  const next = replies.shift();
  if (next === undefined) throw new Error(`no reply queued for ${request.method} ${request.url.pathname}`);
  return {
    status: next.status ?? 200,
    contentType: next.contentType === undefined ? "application/json" : next.contentType,
    body: next.body,
  };
}

function reply(...queued: Reply[]): void {
  replies.push(...queued);
}

/** A captured answer as the server sent it: the record's own status, content type and bytes. */
function captureOf(name: string): Reply {
  const answer = capture(name);
  return { status: answer.status, contentType: answer.headers["content-type"] ?? null, body: answer.text };
}

/** The same, from the VictoriaMetrics v1.152.0 captures. */
function captureVmOf(name: string): Reply {
  const answer = captureVm(name);
  return { status: answer.status, contentType: answer.headers["content-type"] ?? null, body: answer.text };
}

/** A plain-text answer, the way the health endpoints and a refusing proxy answer. */
function plain(body: string, status = 200): Reply {
  return { status, contentType: "text/plain; charset=utf-8", body };
}

/** A JSON body built here rather than captured (CONSTRUCTED). */
function constructed(document: unknown, status = 200): Reply {
  return { status, body: JSON.stringify(document) };
}

/** A success envelope around `data` (CONSTRUCTED). */
function success(data: unknown): Record<string, unknown> {
  return { status: "success", data };
}

function transportWith(
  credentials: PrometheusCredentials = {},
  overrides: Partial<HttpTransportDeps> = {},
): PrometheusTransport {
  return createHttpTransport(credentials, {
    send,
    endpoint: endpointOn(ORIGIN),
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    maxResponseBytes: MAX_BYTES,
    ...overrides,
  });
}

/** The one request a call made. */
function only(): OutboundRequest {
  expect(sent).toHaveLength(1);
  return sent[0] as OutboundRequest;
}

function paramsOf(request: OutboundRequest): [string, string][] {
  return [...request.url.searchParams];
}

/** The PrometheusTransportError a call threw, or a failed expectation when it resolved. */
async function failureOf(run: () => Promise<unknown>): Promise<PrometheusTransportError> {
  try {
    await run();
  } catch (caught) {
    expect(caught).toBeInstanceOf(PrometheusTransportError);
    return caught as PrometheusTransportError;
  }
  throw new Error("the transport resolved where it should have thrown");
}

interface ArmedDeadline {
  readonly ms: number;
  readonly controller: AbortController;
}

const originalTimeout = AbortSignal.timeout;
let armed: ArmedDeadline[] = [];

beforeEach(() => {
  sent = [];
  replies = [];
  sendFailure = null;
  armed = [];
  AbortSignal.timeout = ((ms: number) => {
    const controller = new AbortController();
    armed.push({ ms, controller });
    return controller.signal;
  }) as typeof AbortSignal.timeout;
});

afterEach(() => {
  AbortSignal.timeout = originalTimeout;
});

// ============================================================================
// Captured shapes, as far as a test reads them
// ============================================================================

interface RawEnvelope<T> {
  readonly status: string;
  readonly data: T;
  readonly warnings?: readonly string[];
  readonly infos?: readonly string[];
}
interface RawQueryData<T> {
  readonly resultType: string;
  readonly result: T;
}
type RawLabels = Record<string, string>;
interface RawVectorEntry {
  readonly metric: RawLabels;
  readonly value: [number, string];
}
interface RawMatrixEntry {
  readonly metric: RawLabels;
  readonly values: [number, string][];
}
/** `jsonutil.MarshalHistogram`: `count` and `sum`, and `buckets` only when one is not empty. */
interface RawHistogram {
  readonly count: string;
  readonly sum: string;
  readonly buckets?: [number, string, string, string][];
}
interface RawHistogramVectorEntry {
  readonly metric: RawLabels;
  readonly histogram: [number, RawHistogram];
}
interface RawHistogramMatrixEntry {
  readonly metric: RawLabels;
  readonly values?: [number, string][];
  readonly histograms: [number, RawHistogram][];
}
interface RawAlert {
  readonly labels: RawLabels;
  readonly annotations: RawLabels;
  readonly state: string;
  readonly activeAt?: string;
  readonly value: string;
}
interface RawRuleCommon {
  readonly name: string;
  readonly query: string;
  readonly labels: RawLabels;
  readonly health: string;
  readonly lastError?: string;
  readonly evaluationTime: number;
  readonly lastEvaluation: string;
}
interface RawRecordingRule extends RawRuleCommon {
  readonly type: "recording";
}
interface RawAlertingRule extends RawRuleCommon {
  readonly type: "alerting";
  readonly state: string;
  readonly duration: number;
  readonly keepFiringFor: number;
  readonly annotations: RawLabels;
  readonly alerts: RawAlert[] | null;
}
type RawRule = RawRecordingRule | RawAlertingRule;
interface RawRuleGroup {
  readonly name: string;
  readonly file: string;
  readonly interval: number;
  readonly limit: number;
  readonly evaluationTime: number;
  readonly lastEvaluation: string;
  readonly rules: RawRule[];
}
/** The two scrape members are absent from the VictoriaMetrics v1.152.0 captures. */
interface RawTarget {
  readonly scrapePool: string;
  readonly scrapeUrl: string;
  readonly health: string;
  readonly lastError: string;
  readonly lastScrape: string;
  readonly lastScrapeDuration: number;
  readonly scrapeInterval?: string;
  readonly scrapeTimeout?: string;
  readonly labels: RawLabels;
  readonly discoveredLabels: RawLabels;
}
/** `unit` is absent from the VictoriaMetrics v1.152.0 captures. */
interface RawMetadata {
  readonly type: string;
  readonly help: string;
  readonly unit?: string;
}
interface RawCount {
  readonly name: string;
  readonly value: number;
}
interface RawHead {
  readonly numSeries: number;
  readonly chunkCount: number;
  readonly minTime: number;
  readonly maxTime: number;
}
/** `headStats` is absent from the VictoriaMetrics v1.152.0 captures. */
interface RawTsdb {
  readonly headStats?: RawHead;
  readonly seriesCountByMetricName: RawCount[];
  readonly labelValueCountByLabelName: RawCount[];
}

// The seam form of each captured shape, written member by member, so a decoder that drops, renames or
// retypes a member is caught, and so does one that lets a wire member the seam does not carry (`globalUrl`)
// through.

function seamAlert(raw: RawAlert): PrometheusAlert {
  return {
    labels: raw.labels,
    annotations: raw.annotations,
    state: raw.state,
    activeAt: raw.activeAt ?? "",
    value: raw.value,
  };
}

function seamRule(raw: RawRule): PrometheusRule {
  const common = {
    name: raw.name,
    query: raw.query,
    labels: raw.labels,
    health: raw.health,
    lastError: raw.lastError ?? "",
    evaluationTime: raw.evaluationTime,
    lastEvaluation: raw.lastEvaluation,
  };
  if (raw.type === "recording") return { kind: "recording", ...common };
  return {
    kind: "alerting",
    ...common,
    duration: raw.duration,
    keepFiringFor: raw.keepFiringFor,
    annotations: raw.annotations,
    state: raw.state,
    alerts: (raw.alerts ?? []).map(seamAlert),
  };
}

function seamGroups(raw: readonly RawRuleGroup[]): PrometheusRuleGroup[] {
  return raw.map((group) => ({
    name: group.name,
    file: group.file,
    interval: group.interval,
    limit: group.limit,
    evaluationTime: group.evaluationTime,
    lastEvaluation: group.lastEvaluation,
    rules: group.rules.map(seamRule),
  }));
}

/** A member the engine left out stays out of the seam form too, as a missing key and never as undefined. */
function seamTarget(raw: RawTarget): PrometheusTarget {
  return {
    scrapePool: raw.scrapePool,
    scrapeUrl: raw.scrapeUrl,
    health: raw.health,
    lastError: raw.lastError,
    lastScrape: raw.lastScrape,
    lastScrapeDuration: raw.lastScrapeDuration,
    ...(raw.scrapeInterval === undefined ? {} : { scrapeInterval: raw.scrapeInterval }),
    ...(raw.scrapeTimeout === undefined ? {} : { scrapeTimeout: raw.scrapeTimeout }),
    labels: raw.labels,
    discoveredLabels: raw.discoveredLabels,
  };
}

function seamMetadata(raw: RawMetadata): PrometheusMetadataEntry {
  return { type: raw.type, help: raw.help, ...(raw.unit === undefined ? {} : { unit: raw.unit }) };
}

function seamTsdb(raw: RawTsdb): PrometheusTsdbStatus {
  const lists = {
    seriesByMetric: raw.seriesCountByMetricName.map(({ name, value }) => ({ name, value })),
    valuesByLabel: raw.labelValueCountByLabelName.map(({ name, value }) => ({ name, value })),
  };
  if (raw.headStats === undefined) return lists;
  const { numSeries, chunkCount, minTime, maxTime } = raw.headStats;
  return { head: { series: numSeries, chunks: chunkCount, minTimeMs: minTime, maxTimeMs: maxTime }, ...lists };
}

/**
 * Every member of a decoded value is either sent or left out, never present as undefined: `toEqual`
 * treats the two alike, so the keys are compared on their own.
 */
function keysOf(value: object): string[] {
  return Object.keys(value).sort();
}

// CONSTRUCTED members for the malformed documents below. Each is a complete, valid v3.13.3 object, so the
// one member a row breaks is the only thing wrong with the document.
const RULE_BASE = {
  name: "r",
  query: "up",
  labels: {},
  health: "ok",
  evaluationTime: 0.001,
  lastEvaluation: "2026-09-23T09:59:45Z",
};
const ALERTING_BASE = {
  ...RULE_BASE,
  type: "alerting",
  state: "firing",
  duration: 0,
  keepFiringFor: 0,
  annotations: {},
  // Always written: the Go nil slice every exclude_alerts=true read sends, as rules-all.json records it.
  alerts: null,
};
const GROUP_BASE = {
  name: "g",
  file: "a.yml",
  interval: 15,
  limit: 0,
  evaluationTime: 0.002,
  lastEvaluation: "2026-09-23T09:59:45Z",
};
const TARGET_BASE = {
  discoveredLabels: {},
  labels: {},
  scrapePool: "p",
  scrapeUrl: "http://a:1/metrics",
  globalUrl: "http://a:1/metrics",
  lastError: "",
  lastScrape: "2026-09-23T09:59:50Z",
  lastScrapeDuration: 0.01,
  health: "up",
  scrapeInterval: "15s",
  scrapeTimeout: "10s",
};
const HEAD = { numSeries: 1, numLabelPairs: 1, chunkCount: 1, minTime: 0, maxTime: 1 };

describe("authorizationFor (6.1, #1085 S3)", () => {
  test.each<[string, PrometheusCredentials, string | undefined]>([
    ["a user and a password as Basic", { user: "alice", password: "s3cret" }, "Basic YWxpY2U6czNjcmV0"],
    ["a password alone as a bearer token", { password: "tok-123" }, "Bearer tok-123"],
    ["a user alone as Basic with an empty password", { user: "alice" }, "Basic YWxpY2U6"],
    ["a user with an empty password as Basic", { user: "alice", password: "" }, "Basic YWxpY2U6"],
    ["an empty user and a password as a bearer token", { user: "", password: "tok-123" }, "Bearer tok-123"],
    ["neither field as no header", {}, undefined],
    ["two empty fields as no header", { user: "", password: "" }, undefined],
    ["a colon in a Basic password", { user: "alice", password: "a:b" }, "Basic YWxpY2U6YTpi"],
    ["a leading space in a Basic user, sent as entered", { user: " alice", password: "pw" }, "Basic IGFsaWNlOnB3"],
    [
      "UTF-8 credentials as their UTF-8 bytes",
      { user: "jos\u00e9", password: "contrase\u00f1a" },
      "Basic am9zw6k6Y29udHJhc2XDsWE=",
    ],
    ["every token68 character in a bearer token", { password: "Az9-._~+/=" }, "Bearer Az9-._~+/="],
    ["a dotted token in a bearer token", { password: "abc.def.ghi" }, "Bearer abc.def.ghi"],
  ])("builds %s", (_label, credentials, expected) => {
    expect(authorizationFor(credentials)).toBe(expected);
  });

  test.each<[string, PrometheusCredentials, string]>([
    ["a line feed in a bearer token", { password: "tok\nSECRET" }, "password or token"],
    ["a carriage return in a bearer token", { password: "tok\rSECRET" }, "password or token"],
    ["a NUL in a bearer token", { password: "tok\0SECRET" }, "password or token"],
    ["a line feed in a Basic password", { user: "alice", password: "pw\nSECRET" }, "password or token"],
    ["a carriage return in a Basic password", { user: "alice", password: "pw\rSECRET" }, "password or token"],
    ["a NUL in a Basic password", { user: "alice", password: "pw\0SECRET" }, "password or token"],
    ["a line feed in a user", { user: "alice\nSECRET", password: "pw" }, "user name"],
    ["a carriage return in a user", { user: "alice\rSECRET", password: "pw" }, "user name"],
    ["a NUL in a user sent alone", { user: "alice\0SECRET" }, "user name"],
    ["a colon in a user", { user: "alice:SECRET", password: "pw" }, "colon"],
    ["a colon in a user sent alone", { user: "alice:SECRET" }, "colon"],
    ["a space inside a bearer token", { password: "tok SECRET" }, "bearer token"],
    ["a leading space in a bearer token, which is not trimmed", { password: " SECRET" }, "bearer token"],
    ["a trailing space in a bearer token, which is not trimmed", { password: "SECRET " }, "bearer token"],
    ["a comma in a bearer token", { password: "tok,SECRET" }, "bearer token"],
    ["a quote in a bearer token", { password: 'tok"SECRET' }, "bearer token"],
    ["a non-ASCII letter in a bearer token", { password: "tok\u00e9SECRET" }, "bearer token"],
    ["padding before the end of a bearer token", { password: "tok=SECRET" }, "bearer token"],
    ["padding with nothing before it", { password: "=SECRET" }, "bearer token"],
  ])("refuses %s, naming what is wrong and never the value", (_label, credentials, named) => {
    let caught: unknown;
    try {
      authorizationFor(credentials);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PrometheusTransportError);
    const refusal = caught as PrometheusTransportError;
    expect(refusal.category).toBe("credential");
    expect(refusal.detail).toEqual({});
    // The control: the refusal says what is wrong, so the absences below are of the value, not of a message.
    expect(refusal.message).toContain(named);
    expect(refusal.message).not.toContain("SECRET");
    expect(refusal.stack ?? "").not.toContain("SECRET");
    const basic = Buffer.from(`${credentials.user ?? ""}:${credentials.password ?? ""}`, "utf8").toString("base64");
    expect(refusal.message).not.toContain(basic);
  });
});

/** [call, path, exact parameters in order, the captured answer it is fed, the call itself] */
type GetCase = readonly [
  call: string,
  path: string,
  params: [string, string][],
  answer: string,
  run: (transport: PrometheusTransport) => Promise<unknown>,
];

/** Every GET of #1085 4.6 and 6.2 but the health probes, which have their own test. */
const GETS: readonly GetCase[] = [
  [
    "metricNames",
    "/api/v1/label/__name__/values",
    [
      ["start", "1790154000.25"],
      ["end", "1790157600"],
      ["limit", "2001"],
    ],
    "label-values-names",
    (transport) => transport.metricNames(WINDOW, 2001),
  ],
  [
    "labelNames",
    "/api/v1/labels",
    [
      ["match[]", "prometheus_http_requests_total"],
      ["start", "1790154000.25"],
      ["end", "1790157600"],
    ],
    "labels-one-metric",
    (transport) => transport.labelNames("prometheus_http_requests_total", WINDOW),
  ],
  [
    "seriesLabels",
    "/api/v1/series",
    [
      ["match[]", '{__name__=~".+"}'],
      ["start", "1790154000.25"],
      ["end", "1790157600"],
      ["limit", "20000"],
    ],
    "series-all",
    (transport) => transport.seriesLabels('{__name__=~".+"}', WINDOW, 20_000),
  ],
  [
    "metadata",
    "/api/v1/metadata",
    [
      ["metric", "prometheus_http_requests_total"],
      ["limit", "1"],
    ],
    "metadata-exact",
    (transport) => transport.metadata("prometheus_http_requests_total"),
  ],
  ["rules, the listing", "/api/v1/rules", [["exclude_alerts", "true"]], "rules-all", (transport) => transport.rules()],
  [
    "rules, one rule with its alerts",
    "/api/v1/rules",
    [
      ["rule_group[]", "studio;dup"],
      ["file[]", "/etc/prometheus/rules/studio a.yml"],
      ["rule_name[]", "StudioAlwaysFiring"],
    ],
    "rules-firing-rule",
    (transport) => transport.rules({ ...GROUP_FILTER, ruleName: "StudioAlwaysFiring" }),
  ],
  ["scrapePools", "/api/v1/scrape_pools", [], "scrape-pools", (transport) => transport.scrapePools()],
  [
    "targets, every pool",
    "/api/v1/targets",
    [["state", "active"]],
    "targets-active",
    (transport) => transport.targets(),
  ],
  [
    "targets, one pool",
    "/api/v1/targets",
    [
      ["state", "active"],
      ["scrapePool", "studio pool"],
    ],
    "targets-active",
    (transport) => transport.targets("studio pool"),
  ],
  ["buildInfo", "/api/v1/status/buildinfo", [], "buildinfo", (transport) => transport.buildInfo()],
  ["runtimeInfo", "/api/v1/status/runtimeinfo", [], "runtimeinfo", (transport) => transport.runtimeInfo()],
  ["flags", "/api/v1/status/flags", [], "flags", (transport) => transport.flags()],
  ["tsdbStatus", "/api/v1/status/tsdb", [["limit", "50"]], "tsdb-status-50", (transport) => transport.tsdbStatus(50)],
];

describe("every endpoint call is sent exactly (4.6, 6.2)", () => {
  test("query is a POST of /api/v1/query whose form body holds query, timeout and limit, and no time", async () => {
    reply(captureOf("query-vector"));

    await transportWith().query("up", QUERY_OPTIONS);

    const request = only();
    expect(request.method).toBe("POST");
    // Nothing travels in the URL: the expression is a form value, never a query string a proxy logs.
    expect(request.url.href).toBe(`${ORIGIN}/api/v1/query`);
    expect(request.headers).toEqual({
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    });
    // One series more than the 250 shown, so a cut is seen even when the engine's own notice is dropped.
    expect([...new URLSearchParams(request.body)]).toEqual([
      ["query", "up"],
      ["timeout", "30"],
      ["limit", "251"],
    ]);
    expect(request.maxBytes).toBe(MAX_BYTES);
  });

  test("the expression is sent exactly as written, its comment and trailing newline included (5.1)", async () => {
    reply(captureOf("query-vector"));
    const expression = "sum by (job) (up)  # per job\n";

    await transportWith().query(expression, QUERY_OPTIONS);

    expect(new URLSearchParams(only().body).get("query")).toBe(expression);
  });

  test("timeout is the deadline in seconds, the form the handler's parseDuration reads first (5.2)", async () => {
    reply(captureOf("query-vector"));

    await transportWith().query("up", { timeoutMs: 1_500, seriesLimit: 250 });

    expect(new URLSearchParams(only().body).get("timeout")).toBe("1.5");
  });

  test.each(GETS)(
    "%s is a GET of %s with exactly its parameters, the request deadline and the byte cap",
    async (_call, path, params, answer, run) => {
      reply(captureOf(answer));

      await run(transportWith());

      const request = only();
      expect(request.method).toBe("GET");
      expect(request.url.origin).toBe(ORIGIN);
      expect(request.url.pathname).toBe(path);
      expect(paramsOf(request)).toEqual(params);
      expect(request.body).toBeUndefined();
      expect(request.headers).toEqual(JSON_ACCEPT);
      expect(request.maxBytes).toBe(MAX_BYTES);
      expect(armed.map((deadline) => deadline.ms)).toEqual([REQUEST_TIMEOUT_MS]);
      expect(request.signal).toBe(armed[0]?.controller.signal as AbortSignal);
    },
  );

  test("health is a GET of /-/healthy and then of /-/ready, each status recorded and no body read", async () => {
    reply(plain("Prometheus Server is Healthy.\n"), plain("Service Unavailable", 503));

    const health = await transportWith().health();

    expect(health).toEqual({
      probes: [
        { path: "/-/healthy", status: 200 },
        { path: "/-/ready", status: 503 },
      ],
    });
    expect(sent.map((request) => `${request.method} ${request.url.pathname}${request.url.search}`)).toEqual([
      "GET /-/healthy",
      "GET /-/ready",
    ]);
    expect(armed.map((deadline) => deadline.ms)).toEqual([REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS]);
    sent.forEach((request, index) => {
      expect(request.headers).toEqual(JSON_ACCEPT);
      expect(request.maxBytes).toBe(MAX_BYTES);
      expect(request.signal).toBe(armed[index]?.controller.signal as AbortSignal);
    });
  });
});

describe("the query's deadline and cancellation (5.2)", () => {
  test("the deadline is options.timeoutMs, and when it fires the request aborts as a timeout", async () => {
    reply(captureOf("query-vector"));

    await transportWith().query("up", QUERY_OPTIONS);

    const request = only();
    expect(armed.map((deadline) => deadline.ms)).toEqual([QUERY_OPTIONS.timeoutMs]);
    expect(request.signal.aborted).toBe(false);
    armed[0]?.controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    expect(request.signal.aborted).toBe(true);
    expect((request.signal.reason as DOMException).name).toBe("TimeoutError");
  });

  test("the caller's signal aborts the query's request with the caller's own reason", async () => {
    reply(captureOf("query-vector"));
    const caller = new AbortController();

    await transportWith().query("up", { ...QUERY_OPTIONS, signal: caller.signal });

    const request = only();
    expect(request.signal.aborted).toBe(false);
    const reason = new Error("the tab closed");
    caller.abort(reason);
    expect(request.signal.aborted).toBe(true);
    expect(request.signal.reason).toBe(reason);
    // A deadline was armed beside it. That the request still follows it is the next test's to prove:
    // once the caller has aborted, the request keeps the caller's reason whatever fires after.
    expect(armed.map((deadline) => deadline.ms)).toEqual([QUERY_OPTIONS.timeoutMs]);
  });

  test("with the caller's signal live, the deadline still ends the query's request as a timeout", async () => {
    // The provider always passes a signal of its own, so this is the arm every production query takes.
    reply(captureOf("query-vector"));
    const caller = new AbortController();

    await transportWith().query("up", { ...QUERY_OPTIONS, signal: caller.signal });

    const request = only();
    expect(armed.map((deadline) => deadline.ms)).toEqual([QUERY_OPTIONS.timeoutMs]);
    expect(request.signal.aborted).toBe(false);
    armed[0]?.controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    expect(request.signal.aborted).toBe(true);
    expect((request.signal.reason as DOMException).name).toBe("TimeoutError");
    // The timeout is the query's own: the caller's signal is untouched by it.
    expect(caller.signal.aborted).toBe(false);
  });
});

describe("credentials on the wire (6.1, #1085 S3)", () => {
  test("a refused credential throws from createHttpTransport, and no request is ever made", () => {
    let caught: unknown;
    try {
      transportWith({ user: "alice", password: "abc\nSECRET" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PrometheusTransportError);
    expect((caught as PrometheusTransportError).category).toBe("credential");
    expect(sent).toHaveLength(0);
    expect(armed).toHaveLength(0);
  });

  test("every request, the health probes and the query included, carries the header the credentials build", async () => {
    const credentials = { user: "1234567", password: "tok-123" };
    reply(
      captureOf("buildinfo"),
      plain("Prometheus Server is Healthy.\n"),
      plain("Prometheus Server is Ready.\n"),
      captureOf("query-vector"),
    );
    const transport = transportWith(credentials);

    await transport.buildInfo();
    await transport.health();
    await transport.query("up", QUERY_OPTIONS);

    const header = "Basic MTIzNDU2Nzp0b2stMTIz";
    expect(authorizationFor(credentials)).toBe(header);
    expect(sent.map((request) => request.headers.authorization)).toEqual([header, header, header, header]);
  });
});

describe("each captured answer decodes into the seam types", () => {
  test("a vector: one series per sample, the labels verbatim, the value as the engine's text", async () => {
    const raw = captureBody<RawEnvelope<RawQueryData<RawVectorEntry[]>>>("query-vector");
    reply(captureOf("query-vector"));

    const { value } = await transportWith().query("up", QUERY_OPTIONS);

    expect(raw.data.resultType).toBe("vector");
    // A target that answers and one that cannot be reached (#1085 section 8), so several series.
    expect(raw.data.result.map((entry) => entry.value[1])).toContain("1");
    expect(raw.data.result.map((entry) => entry.value[1])).toContain("0");
    expect(value).toEqual({
      shape: "vector",
      series: raw.data.result.map((entry) => ({
        labels: entry.metric,
        samples: [{ at: entry.value[0], value: entry.value[1] }],
        histograms: [],
      })),
    });
  });

  test("a matrix: one series per result, every sample in the engine's order", async () => {
    const raw = captureBody<RawEnvelope<RawQueryData<RawMatrixEntry[]>>>("query-matrix-subquery");
    reply(captureOf("query-matrix-subquery"));

    const { value } = await transportWith().query("rate(prometheus_http_requests_total[1m])[5m:30s]", QUERY_OPTIONS);

    expect(raw.data.resultType).toBe("matrix");
    // The control: 70 series, each stepped at the same ten instants 30 seconds apart, so the
    // equality below holds every sample of a multi-step range and not one instant per series.
    const [first] = raw.data.result;
    const instants = first.values.map(([at]) => at);
    expect(raw.data.result).toHaveLength(70);
    expect(instants).toHaveLength(10);
    expect(instants.slice(1).map((at, index) => at - instants[index])).toEqual(Array(9).fill(30));
    for (const entry of raw.data.result) expect(entry.values.map(([at]) => at)).toEqual(instants);
    expect(value).toEqual({
      shape: "matrix",
      series: raw.data.result.map((entry) => ({
        labels: entry.metric,
        samples: entry.values.map(([at, reading]) => ({ at, value: reading })),
        histograms: [],
      })),
    });
  });

  test.each<["scalar" | "string", string, string]>([
    ["scalar", "query-scalar", "scalar(count(up))"],
    ["string", "query-string", '"studio"'],
  ])("a %s: one sample, the pair as the engine wrote it", async (shape, name, expression) => {
    const raw = captureBody<RawEnvelope<RawQueryData<[number, string]>>>(name);
    reply(captureOf(name));

    const { value } = await transportWith().query(expression, QUERY_OPTIONS);

    expect(raw.data.resultType).toBe(shape);
    expect(value).toEqual({ shape, sample: { at: raw.data.result[0], value: raw.data.result[1] } });
  });

  test("a native histogram stays an object with its buckets, and its series holds no float sample", async () => {
    const raw = captureBody<RawEnvelope<RawQueryData<RawHistogramVectorEntry[]>>>("query-native-histogram");
    reply(captureOf("query-native-histogram"));

    const { value } = await transportWith().query(NATIVE_HISTOGRAM_SELECTOR, QUERY_OPTIONS);

    expect(raw.data.resultType).toBe("vector");
    // The control: the capture holds real buckets, so the equality below is about them.
    expect(raw.data.result.some((entry) => (entry.histogram[1].buckets?.length ?? 0) > 0)).toBe(true);
    expect(value).toEqual({
      shape: "vector",
      series: raw.data.result.map((entry) => ({
        labels: entry.metric,
        samples: [],
        histograms: [{ at: entry.histogram[0], histogram: entry.histogram[1] }],
      })),
    });
  });

  test("a range of native histograms is one point per sample, each histogram kept whole", async () => {
    const raw = captureBody<RawEnvelope<RawQueryData<RawHistogramMatrixEntry[]>>>("query-native-histogram-matrix");
    reply(captureOf("query-native-histogram-matrix"));

    const { value } = await transportWith().query(`${NATIVE_HISTOGRAM_SELECTOR}[1m]`, QUERY_OPTIONS);

    expect(raw.data.resultType).toBe("matrix");
    // The control: histogram points and no float values, so an empty `samples` is what the engine sent.
    expect(raw.data.result.every((entry) => entry.histograms.length > 0 && entry.values === undefined)).toBe(true);
    expect(value).toEqual({
      shape: "matrix",
      series: raw.data.result.map((entry) => ({
        labels: entry.metric,
        samples: [],
        histograms: entry.histograms.map(([at, histogram]) => ({ at, histogram })),
      })),
    });
  });

  test("a matrix series of histograms with no buckets carries no buckets member (CONSTRUCTED)", async () => {
    const points = [[AT, { count: "0", sum: "0" }]];
    reply(constructed(success({ resultType: "matrix", result: [{ metric: {}, histograms: points }] })));

    const { value } = await transportWith().query("studio_latency_seconds[1m]", QUERY_OPTIONS);

    expect(value).toEqual({
      shape: "matrix",
      series: [{ labels: {}, samples: [], histograms: [{ at: AT, histogram: { count: "0", sum: "0" } }] }],
    });
    // Present only where the engine wrote it, never as an undefined member.
    const series = value.shape === "matrix" ? value.series : [];
    expect(Object.keys(series[0]?.histograms[0]?.histogram ?? {})).toEqual(["count", "sum"]);
  });

  test("NaN, +Inf and -Inf stay the engine's text, in the engine's order", async () => {
    const raw = captureBody<RawEnvelope<RawQueryData<RawVectorEntry[]>>>("query-vector-special");
    reply(captureOf("query-vector-special"));

    const { value } = await transportWith().query(SPECIAL_VALUES, QUERY_OPTIONS);

    const readings = raw.data.result.map((entry) => entry.value[1]);
    // The control: the capture holds the three special values, so the equality below is about them.
    expect([...readings].sort()).toEqual(["+Inf", "-Inf", "NaN"]);
    const series = value.shape === "vector" ? value.series : [];
    expect(series.map((entry) => entry.samples[0]?.value)).toEqual(readings);
  });

  test("metric names are the captured list, in the engine's order", async () => {
    const raw = captureBody<RawEnvelope<string[]>>("label-values-names");
    reply(captureOf("label-values-names"));

    const names = await transportWith().metricNames(WINDOW, 2001);

    expect(raw.data).toContain("up");
    expect(names).toEqual({ items: raw.data, truncatedByServer: false });
  });

  test("label names are the captured list", async () => {
    const raw = captureBody<RawEnvelope<string[]>>("labels-one-metric");
    reply(captureOf("labels-one-metric"));

    const names = await transportWith().labelNames("up", WINDOW);

    expect(raw.data).toContain("__name__");
    expect(names).toEqual(raw.data);
  });

  test("series are the captured label sets", async () => {
    const raw = captureBody<RawEnvelope<RawLabels[]>>("series-all");
    reply(captureOf("series-all"));

    const series = await transportWith().seriesLabels('{__name__=~".+"}', WINDOW, 20_000);

    expect(raw.data.every((labels) => typeof labels.__name__ === "string")).toBe(true);
    expect(series).toEqual({ items: raw.data, truncatedByServer: false });
  });

  test("metadata is the entries of the one family asked for", async () => {
    const raw = captureBody<RawEnvelope<Record<string, RawMetadata[]>>>("metadata-exact");
    const [family, ...others] = Object.keys(raw.data);
    reply(captureOf("metadata-exact"));

    const entries = await transportWith().metadata(family as string);

    // `limit=1`: one family, and a real one, whose entries carry a unit as Prometheus writes them.
    expect(others).toEqual([]);
    expect(entries.length).toBeGreaterThan(0);
    expect((raw.data[family as string] ?? []).every((entry) => typeof entry.unit === "string")).toBe(true);
    expect(entries).toEqual((raw.data[family as string] ?? []).map(seamMetadata));
    expect(entries.map(keysOf)).toEqual(entries.map(() => ["help", "type", "unit"]));
  });

  test.each(["metadata-exact", "metadata-family"])(
    "an entry sent without a unit has none, its type and help verbatim (%s, captured from VictoriaMetrics)",
    async (name) => {
      const raw = captureVmBody<RawEnvelope<Record<string, RawMetadata[]>>>(name);
      const [family] = Object.keys(raw.data);
      const sent = raw.data[family as string] ?? [];
      reply(captureVmOf(name));

      const entries = await transportWith().metadata(family as string);

      // The control: the engine sent entries, and none of them a unit.
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every((entry) => entry.unit === undefined)).toBe(true);
      expect(entries).toEqual(sent.map(seamMetadata));
      // Left out, never invented as an empty unit.
      expect(entries.map(keysOf)).toEqual(sent.map(() => ["help", "type"]));
    },
  );

  test("an empty answer is no metadata, the engine's answer for a name it holds none for", async () => {
    const raw = captureBody<RawEnvelope<Record<string, unknown>>>("metadata-unknown");
    reply(captureOf("metadata-unknown"));

    const entries = await transportWith().metadata("studio_no_such_metric");

    expect(raw.data).toEqual({});
    expect(entries).toEqual([]);
  });

  test("only the family asked for is read, as an own property (CONSTRUCTED)", async () => {
    const entry = { type: "counter", help: "Requests.", unit: "" };
    const answer = success({ studio_requests_total: [entry] });
    reply(constructed(answer), constructed(answer));
    const transport = transportWith();

    expect(await transport.metadata("studio_requests_total")).toEqual([entry]);
    expect(await transport.metadata("constructor")).toEqual([]);
  });

  test("the rules listing decodes both rule kinds, every alerting rule's alerts empty because the call excludes them", async () => {
    const raw = captureBody<RawEnvelope<{ groups: RawRuleGroup[] }>>("rules-all");
    reply(captureOf("rules-all"));

    const groups = await transportWith().rules();

    const rules = groups.flatMap((group) => group.rules);
    expect(rules.map((rule) => rule.kind)).toContain("recording");
    expect(rules.map((rule) => rule.kind)).toContain("alerting");
    expect(rules.every((rule) => rule.kind === "recording" || rule.alerts.length === 0)).toBe(true);
    expect(groups).toEqual(seamGroups(raw.data.groups));
  });

  test("one rule's read carries its live alerts", async () => {
    const raw = captureBody<RawEnvelope<{ groups: RawRuleGroup[] }>>("rules-firing-rule");
    reply(captureOf("rules-firing-rule"));

    const groups = await transportWith().rules({
      group: "studio",
      file: "/etc/prometheus/rules/studio-a.yml",
      ruleName: "StudioAlwaysFiring",
    });

    const alerting = groups.flatMap((group) => group.rules).filter((rule) => rule.kind === "alerting");
    expect(alerting.length).toBeGreaterThan(0);
    expect(alerting.every((rule) => rule.kind === "alerting" && rule.alerts.length > 0)).toBe(true);
    expect(groups).toEqual(seamGroups(raw.data.groups));
  });

  test("an omitted lastError or activeAt is empty, alerts written as null is an empty list, and a written member is verbatim (CONSTRUCTED)", async () => {
    const conflict = "vector contains metrics with the same labelset";
    const rules = [
      { ...RULE_BASE, type: "recording" },
      { ...RULE_BASE, type: "recording", lastError: conflict },
      { ...ALERTING_BASE, alerts: [{ labels: {}, annotations: {}, state: "pending", value: "1e+00" }] },
      { ...ALERTING_BASE },
    ];
    reply(constructed(success({ groups: [{ ...GROUP_BASE, rules }] })));

    const [group] = await transportWith().rules();

    const decoded = group?.rules ?? [];
    expect(decoded.map((rule) => rule.lastError)).toEqual(["", conflict, "", ""]);
    expect(decoded[2]?.kind === "alerting" ? decoded[2].alerts : []).toEqual([
      { labels: {}, annotations: {}, state: "pending", activeAt: "", value: "1e+00" },
    ]);
    expect(decoded[3]?.kind === "alerting" ? decoded[3].alerts : null).toEqual([]);
  });

  test("scrape pools are the captured names", async () => {
    const raw = captureBody<RawEnvelope<{ scrapePools: string[] }>>("scrape-pools");
    reply(captureOf("scrape-pools"));

    const pools = await transportWith().scrapePools();

    expect(raw.data.scrapePools.length).toBeGreaterThan(0);
    expect(pools).toEqual(raw.data.scrapePools);
  });

  test("targets are the active targets, and the wire members the seam does not carry stay behind", async () => {
    const raw = captureBody<RawEnvelope<{ activeTargets: RawTarget[] }>>("targets-active");
    reply(captureOf("targets-active"));

    const targets = await transportWith().targets();

    // The configuration of #1085 section 8: a target that answers, and one that cannot be reached.
    expect(targets.map((target) => target.health)).toContain("up");
    expect(targets.some((target) => target.health !== "up")).toBe(true);
    expect(targets).toEqual(raw.data.activeTargets.map(seamTarget));
    expect(targets.every((target) => "scrapeInterval" in target && "scrapeTimeout" in target)).toBe(true);
  });

  test("targets sent without a scrape interval or timeout have neither, every other member verbatim (captured from VictoriaMetrics)", async () => {
    const raw = captureVmBody<RawEnvelope<{ activeTargets: RawTarget[] }>>("targets-active");
    reply(captureVmOf("targets-active"));

    const targets = await transportWith().targets();

    // The control: targets came, up and down among them, and none carries either member; the engine
    // keeps both among a target's discovered labels, which reach the seam as they are.
    expect(raw.data.activeTargets.length).toBeGreaterThan(1);
    expect(targets.map((target) => target.health)).toEqual(expect.arrayContaining(["up", "down"]));
    expect(raw.data.activeTargets.every((target) => target.scrapeInterval === undefined)).toBe(true);
    expect(raw.data.activeTargets.every((target) => target.scrapeTimeout === undefined)).toBe(true);
    expect(targets).toEqual(raw.data.activeTargets.map(seamTarget));
    expect(targets.some((target) => "scrapeInterval" in target || "scrapeTimeout" in target)).toBe(false);
    expect(targets.map((target) => target.discoveredLabels.__scrape_interval__)).toEqual(
      raw.data.activeTargets.map((target) => target.discoveredLabels.__scrape_interval__),
    );
  });

  test("build information carries the probed version", async () => {
    reply(captureOf("buildinfo"));

    expect(await transportWith().buildInfo()).toEqual({ version: "3.13.3" });
  });

  test("runtime information carries the start time, the server's own clock and the retention", async () => {
    const raw =
      captureBody<RawEnvelope<{ startTime: string; serverTime: string; storageRetention: string }>>("runtimeinfo");
    reply(captureOf("runtimeinfo"));

    const info = await transportWith().runtimeInfo();

    expect(info).toEqual({
      startTime: raw.data.startTime,
      serverTime: raw.data.serverTime,
      storageRetention: raw.data.storageRetention,
    });
  });

  test("the flags are every flag as text, web.max-connections among them", async () => {
    const raw = captureBody<RawEnvelope<Record<string, string>>>("flags");
    reply(captureOf("flags"));

    const flags = await transportWith().flags();

    expect(typeof flags["web.max-connections"]).toBe("string");
    expect(flags).toEqual(raw.data);
  });

  test("the TSDB status carries the head block and both top lists", async () => {
    const raw = captureBody<RawEnvelope<RawTsdb>>("tsdb-status-50");
    reply(captureOf("tsdb-status-50"));

    const status = await transportWith().tsdbStatus(50);

    expect(raw.data.seriesCountByMetricName.length).toBeGreaterThan(0);
    expect(raw.data.headStats).toBeDefined();
    expect(status).toEqual(seamTsdb(raw.data));
    expect(keysOf(status)).toEqual(["head", "seriesByMetric", "valuesByLabel"]);
  });

  test("a TSDB status sent without head statistics has no head, both top lists verbatim (captured from VictoriaMetrics)", async () => {
    const raw = captureVmBody<RawEnvelope<RawTsdb>>("tsdb-status-50");
    reply(captureVmOf("tsdb-status-50"));

    const status = await transportWith().tsdbStatus(50);

    // The control: the engine sent its series counts by metric, and no head block statistics.
    expect(raw.data.seriesCountByMetricName.length).toBeGreaterThan(0);
    expect(raw.data.headStats).toBeUndefined();
    expect(status).toEqual(seamTsdb(raw.data));
    expect(keysOf(status)).toEqual(["seriesByMetric", "valuesByLabel"]);
  });
});

/** [what is wrong, the path the failure must name, the CONSTRUCTED `data` member, the call that reads it] */
type MalformedCase = readonly [
  problem: string,
  path: string,
  data: unknown,
  run: (transport: PrometheusTransport) => Promise<unknown>,
];

const readQuery = (transport: PrometheusTransport) => transport.query("up", QUERY_OPTIONS);
const readRules = (transport: PrometheusTransport) => transport.rules();
const oneRuleGroup = (rule: unknown) => ({ groups: [{ ...GROUP_BASE, rules: [rule] }] });
const vectorOf = (...result: unknown[]) => ({ resultType: "vector", result });

const MALFORMED: readonly MalformedCase[] = [
  ["a query result that is not an object", "/api/v1/query", [], readQuery],
  ["a result type this client does not read", "/api/v1/query", { resultType: "exemplars", result: [] }, readQuery],
  ["a vector that is not a list", "/api/v1/query", { resultType: "vector", result: {} }, readQuery],
  ["a vector sample that is not an object", "/api/v1/query", vectorOf("up"), readQuery],
  ["a vector sample with neither a value nor a histogram", "/api/v1/query", vectorOf({ metric: {} }), readQuery],
  [
    "a vector sample with both a value and a histogram",
    "/api/v1/query",
    vectorOf({ metric: {}, value: [AT, "1"], histogram: [AT, { count: "1", sum: "1" }] }),
    readQuery,
  ],
  ["a sample value that is a number", "/api/v1/query", vectorOf({ metric: {}, value: [AT, 1] }), readQuery],
  ["a sample time that is text", "/api/v1/query", { resultType: "scalar", result: [String(AT), "1"] }, readQuery],
  ["a sample of three members", "/api/v1/query", { resultType: "string", result: [AT, "a", "b"] }, readQuery],
  ["a label value that is not text", "/api/v1/query", vectorOf({ metric: { job: 1 }, value: [AT, "1"] }), readQuery],
  ["labels that are not an object", "/api/v1/query", vectorOf({ metric: [], value: [AT, "1"] }), readQuery],
  [
    "matrix values that are not a list",
    "/api/v1/query",
    { resultType: "matrix", result: [{ metric: {}, values: {} }] },
    readQuery,
  ],
  ["a histogram point of one member", "/api/v1/query", vectorOf({ metric: {}, histogram: [AT] }), readQuery],
  ["a histogram with no sum", "/api/v1/query", vectorOf({ metric: {}, histogram: [AT, { count: "1" }] }), readQuery],
  [
    "a histogram bucket of three members",
    "/api/v1/query",
    {
      resultType: "matrix",
      result: [{ metric: {}, histograms: [[AT, { count: "1", sum: "1", buckets: [[0, "0", "1"]] }]] }],
    },
    readQuery,
  ],
  [
    "metric names holding a number",
    "/api/v1/label/__name__/values",
    ["up", 1],
    (transport) => transport.metricNames(WINDOW, 2001),
  ],
  ["label names that are not a list", "/api/v1/labels", {}, (transport) => transport.labelNames("up", WINDOW)],
  ["series that are not a list", "/api/v1/series", {}, (transport) => transport.seriesLabels("up", WINDOW, 10)],
  [
    "a series label that is not text",
    "/api/v1/series",
    [{ __name__: 1 }],
    (transport) => transport.seriesLabels("up", WINDOW, 10),
  ],
  ["metadata that is a list", "/api/v1/metadata", [], (transport) => transport.metadata("up")],
  [
    "a metadata entry with no help",
    "/api/v1/metadata",
    { up: [{ type: "gauge", unit: "" }] },
    (transport) => transport.metadata("up"),
  ],
  // The type classifies the metric, so it stays required where a description may be left out.
  [
    "a metadata entry with no type",
    "/api/v1/metadata",
    { up: [{ help: "Up.", unit: "" }] },
    (transport) => transport.metadata("up"),
  ],
  // A unit may be left out, but one that is sent must be text.
  [
    "a metadata unit that is not text",
    "/api/v1/metadata",
    { up: [{ type: "gauge", help: "Up.", unit: 1 }] },
    (transport) => transport.metadata("up"),
  ],
  ["rules without groups", "/api/v1/rules", {}, readRules],
  [
    "a rule group with no name",
    "/api/v1/rules",
    { groups: [{ file: "a.yml", interval: 15, limit: 0, evaluationTime: 0, lastEvaluation: "", rules: [] }] },
    readRules,
  ],
  ["a rule of an unknown type", "/api/v1/rules", oneRuleGroup({ ...RULE_BASE, type: "streaming" }), readRules],
  [
    "a rule whose lastError is not text",
    "/api/v1/rules",
    oneRuleGroup({ ...RULE_BASE, type: "recording", lastError: 1 }),
    readRules,
  ],
  ["alerts that are not a list", "/api/v1/rules", oneRuleGroup({ ...ALERTING_BASE, alerts: {} }), readRules],
  // JSON.stringify leaves an undefined member out, so the rule reaches the decoder with no alerts member at all.
  [
    "an alerting rule with no alerts member",
    "/api/v1/rules",
    oneRuleGroup({ ...ALERTING_BASE, alerts: undefined }),
    readRules,
  ],
  [
    "an alert with no state",
    "/api/v1/rules",
    oneRuleGroup({ ...ALERTING_BASE, alerts: [{ labels: {}, annotations: {}, value: "1" }] }),
    readRules,
  ],
  [
    "scrape pool names that are not a list",
    "/api/v1/scrape_pools",
    { scrapePools: "p" },
    (transport) => transport.scrapePools(),
  ],
  ["targets with no active list", "/api/v1/targets", { droppedTargets: [] }, (transport) => transport.targets()],
  [
    "a target whose scrape duration is text",
    "/api/v1/targets",
    { activeTargets: [{ ...TARGET_BASE, lastScrapeDuration: "0.01" }] },
    (transport) => transport.targets(),
  ],
  // The members that identify or classify a target stay required. JSON.stringify leaves an undefined
  // member out, so each row's target reaches the decoder without that member at all.
  ...(["scrapePool", "scrapeUrl", "health", "labels"] as const).map(
    (member): MalformedCase => [
      `a target with no ${member}`,
      "/api/v1/targets",
      { activeTargets: [{ ...TARGET_BASE, [member]: undefined }] },
      (transport) => transport.targets(),
    ],
  ),
  // The scrape interval and timeout may be left out, but one that is sent must be text.
  ...(["scrapeInterval", "scrapeTimeout"] as const).map(
    (member): MalformedCase => [
      `a target whose ${member} is not text`,
      "/api/v1/targets",
      { activeTargets: [{ ...TARGET_BASE, [member]: 15 }] },
      (transport) => transport.targets(),
    ],
  ),
  [
    "build information with no version",
    "/api/v1/status/buildinfo",
    { revision: "x" },
    (transport) => transport.buildInfo(),
  ],
  [
    "runtime information with no server time",
    "/api/v1/status/runtimeinfo",
    { startTime: "2026-09-23T09:00:00Z", storageRetention: "15d" },
    (transport) => transport.runtimeInfo(),
  ],
  [
    "runtime information with no retention",
    "/api/v1/status/runtimeinfo",
    { startTime: "2026-09-23T09:00:00Z", serverTime: "2026-09-23T10:00:00Z" },
    (transport) => transport.runtimeInfo(),
  ],
  ["a flag that is not text", "/api/v1/status/flags", { "web.max-connections": 512 }, (transport) => transport.flags()],
  // Head statistics may be left out whole, but sent ones must be the object of four numbers.
  [
    "head statistics that are not an object",
    "/api/v1/status/tsdb",
    { headStats: [], seriesCountByMetricName: [], labelValueCountByLabelName: [] },
    (transport) => transport.tsdbStatus(50),
  ],
  [
    "head statistics with no maximum time",
    "/api/v1/status/tsdb",
    {
      headStats: { numSeries: 1, numLabelPairs: 1, chunkCount: 1, minTime: 0 },
      seriesCountByMetricName: [],
      labelValueCountByLabelName: [],
    },
    (transport) => transport.tsdbStatus(50),
  ],
  [
    "a TSDB status with no series counts by metric",
    "/api/v1/status/tsdb",
    { headStats: HEAD, labelValueCountByLabelName: [] },
    (transport) => transport.tsdbStatus(50),
  ],
  [
    "a TSDB count that is not a number",
    "/api/v1/status/tsdb",
    { headStats: HEAD, seriesCountByMetricName: [{ name: "up", value: null }], labelValueCountByLabelName: [] },
    (transport) => transport.tsdbStatus(50),
  ],
];

describe("a document this client cannot read is a protocol failure naming the path (CONSTRUCTED)", () => {
  test.each(MALFORMED)("%s is refused, naming %s", async (_problem, path, data, run) => {
    reply(constructed(success(data)));

    const failure = await failureOf(() => run(transportWith()));

    expect(failure.category).toBe("protocol");
    // The server that answered, never the product: a wire-compatible relative answers through this transport too.
    expect(failure.message).toStartWith(`The server answered ${path} with a document this client cannot read: `);
  });
});

describe("the query arrives byte-identical at a real server (#1085 S4)", () => {
  test("a query holding + & % = # and a line break reaches a local server through the real sender unchanged", async () => {
    const arrivals: { method: string; contentType: string | null; body: string }[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        arrivals.push({
          method: request.method,
          contentType: request.headers.get("content-type"),
          body: await request.text(),
        });
        return Response.json(success({ resultType: "scalar", result: [AT, "1"] }));
      },
    });
    try {
      const transport = createHttpTransport(
        {},
        {
          send: createSendRequest(null),
          endpoint: endpointOn(`http://127.0.0.1:${server.port}`),
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
          maxResponseBytes: RESPONSE_BYTE_CAP,
        },
      );
      const expression = 'sum(rate(studio_requests_total{path="/a+b&c=d%20e"}[5m])) # 50% = half & more #\n';

      const answer = await transport.query(expression, QUERY_OPTIONS);

      expect(answer.value).toEqual({ shape: "scalar", sample: { at: AT, value: "1" } });
      expect(arrivals).toHaveLength(1);
      const [arrived] = arrivals;
      expect(arrived?.method).toBe("POST");
      expect(arrived?.contentType).toBe("application/x-www-form-urlencoded");
      expect(new URLSearchParams(arrived?.body).get("query")).toBe(expression);
      // Every character with a meaning in a form body crossed the wire escaped, none of them raw.
      for (const escaped of ["%2B", "%26", "%25", "%3D", "%23", "%0A"]) expect(arrived?.body).toContain(escaped);
    } finally {
      server.stop(true);
    }
  });
});

describe("notices and the server's own truncation notice (5.4, M8)", () => {
  test("a captured info notice reaches the answer verbatim, at level info, after any warning", async () => {
    const raw = captureBody<RawEnvelope<unknown>>("query-info-notice");
    reply(captureOf("query-info-notice"));

    const { notices } = await transportWith().query("rate(go_goroutines[1m])", QUERY_OPTIONS);

    expect(raw.infos?.length).toBeGreaterThan(0);
    expect(notices).toEqual([
      ...(raw.warnings ?? []).map((message) => ({ level: "warning" as const, message })),
      ...(raw.infos ?? []).map((message) => ({ level: "info" as const, message })),
    ]);
  });

  test("a captured limit that bit is the engine's own warning, and the answer says it was cut", async () => {
    const raw = captureBody<RawEnvelope<unknown>>("query-limited");
    reply(captureOf("query-limited"));

    const answer = await transportWith().query("up", { ...QUERY_OPTIONS, seriesLimit: 1 });

    // The capture asked limit=2, which is what one series shown asks for: one series more than it shows.
    expect(new URLSearchParams(only().body).get("limit")).toBe("2");
    // Measurement M8: the sentence the live server sends when a limit cuts a list.
    expect(raw.warnings).toContain("results truncated due to limit");
    expect(answer.notices).toContainEqual({ level: "warning", message: "results truncated due to limit" });
    expect(answer.truncatedByServer).toBe(true);
  });

  test("the control: a query answer without the engine's notice was not cut, beside another warning too", async () => {
    reply(
      captureOf("query-vector"),
      // CONSTRUCTED: a warning that is not the truncation notice.
      constructed({
        ...success({ resultType: "scalar", result: [AT, "1"] }),
        warnings: ["results partially computed"],
      }),
    );
    const transport = transportWith();

    expect((await transport.query("up", QUERY_OPTIONS)).truncatedByServer).toBe(false);
    expect((await transport.query("1", QUERY_OPTIONS)).truncatedByServer).toBe(false);
  });

  test("warnings come before infos, each list in the engine's order (CONSTRUCTED)", async () => {
    reply(
      constructed({
        ...success({ resultType: "scalar", result: [AT, "1"] }),
        warnings: ["first warning", "second warning"],
        infos: ["an info"],
      }),
    );

    const { notices } = await transportWith().query("1", QUERY_OPTIONS);

    expect(notices).toEqual([
      { level: "warning", message: "first warning" },
      { level: "warning", message: "second warning" },
      { level: "info", message: "an info" },
    ]);
  });

  test("an answer with neither list carries no notices, and the same answer with one carries it (CONSTRUCTED)", async () => {
    const bare = success({ resultType: "scalar", result: [AT, "1"] });
    reply(constructed(bare), constructed({ ...bare, infos: ["an info"] }));
    const transport = transportWith();

    expect((await transport.query("1", QUERY_OPTIONS)).notices).toEqual([]);
    expect((await transport.query("1", QUERY_OPTIONS)).notices).toEqual([{ level: "info", message: "an info" }]);
  });

  test("a captured label-values read the limit cut says so, and holds exactly the names the engine sent", async () => {
    const raw = captureBody<RawEnvelope<string[]>>("label-values-names-limited");
    reply(captureOf("label-values-names-limited"));

    const names = await transportWith().metricNames(WINDOW, 5);

    expect(raw.warnings).toContain("results truncated due to limit");
    expect(names).toEqual({ items: raw.data, truncatedByServer: true });
  });

  test("a captured series read the limit cut says so, and holds exactly the label sets the engine sent", async () => {
    const raw = captureBody<RawEnvelope<RawLabels[]>>("series-all-limited");
    reply(captureOf("series-all-limited"));

    const series = await transportWith().seriesLabels('{__name__=~".+"}', WINDOW, 10);

    expect(raw.warnings).toContain("results truncated due to limit");
    expect(series).toEqual({ items: raw.data, truncatedByServer: true });
  });

  test("the control: the same reads, uncut, say nothing was cut", async () => {
    reply(captureOf("label-values-names"), captureOf("series-all"));
    const transport = transportWith();

    expect((await transport.metricNames(WINDOW, 2001)).truncatedByServer).toBe(false);
    expect((await transport.seriesLabels('{__name__=~".+"}', WINDOW, 20_000)).truncatedByServer).toBe(false);
  });

  test("another warning is not the truncation notice, and the notice beside it still is (CONSTRUCTED)", async () => {
    reply(
      constructed({ ...success(["up"]), warnings: ["results partially computed"] }),
      constructed({ ...success(["up"]), warnings: ["results partially computed", "results truncated due to limit"] }),
    );
    const transport = transportWith();

    expect((await transport.metricNames(WINDOW, 2001)).truncatedByServer).toBe(false);
    expect((await transport.metricNames(WINDOW, 2001)).truncatedByServer).toBe(true);
  });

  test.each<[string, Record<string, unknown>]>([
    ["warnings that are not a list", { warnings: "one" }],
    ["an info that is not text", { infos: [1] }],
  ])("%s make the answer unreadable (CONSTRUCTED)", async (_label, notices) => {
    reply(constructed({ ...success({ resultType: "scalar", result: [AT, "1"] }), ...notices }));

    const failure = await failureOf(() => transportWith().query("1", QUERY_OPTIONS));

    expect(failure.category).toBe("protocol");
    expect(failure.message).toContain("/api/v1/query");
  });
});

describe("failures, classified by errorType and never by the HTTP status (5.5)", () => {
  test("a captured bad_data envelope is its errorType, with the engine's own sentence and the status", async () => {
    const raw = captureBody<{ status: string; errorType: string; error: string }>("error-bad-data");
    reply(captureOf("error-bad-data"));

    const failure = await failureOf(() => transportWith().query("sum(", QUERY_OPTIONS));

    expect(raw.errorType).toBe("bad_data");
    expect(failure.category).toBe("bad_data");
    expect(failure.message).toBe(raw.error);
    expect(failure.detail).toEqual({ status: 400 });
  });

  test.each<[string, string, string, number]>([
    ["error-execution", "execution", "up + on() up", QUERY_OPTIONS.timeoutMs],
    ["error-timeout", "timeout", "count_over_time(absent(studio_no_such_metric)[1h:1ms])", 50],
  ])(
    "a captured %s envelope is its errorType %s, with the engine's own sentence and the status",
    async (name, errorType, expression, timeoutMs) => {
      const answer = capture(name);
      const raw = captureBody<{ status: string; errorType: string; error: string }>(name);
      reply(captureOf(name));

      const failure = await failureOf(() => transportWith().query(expression, { ...QUERY_OPTIONS, timeoutMs }));

      // The control: the capture holds the type this row names, so the category below is the engine's word.
      expect(raw.errorType).toBe(errorType);
      expect(failure.category).toBe(errorType);
      expect(failure.message).toBe(raw.error);
      expect(failure.detail).toEqual({ status: answer.status });
    },
  );

  test.each<[string, number]>([
    ["canceled", 499],
    ["unavailable", 500],
    ["internal", 500],
    ["not_found", 404],
    ["not_acceptable", 406],
  ])("an envelope saying %s with HTTP %d is that category, verbatim (CONSTRUCTED)", async (errorType, status) => {
    const sentence = `the engine's own ${errorType} sentence`;
    reply(constructed({ status: "error", errorType, error: sentence }, status));

    const failure = await failureOf(() => transportWith().buildInfo());

    expect(failure.category).toBe(errorType);
    expect(failure.message).toBe(sentence);
    expect(failure.detail).toEqual({ status });
  });

  test("an error envelope with no errorType is a protocol failure (CONSTRUCTED)", async () => {
    reply(constructed({ status: "error", error: "something failed" }, 500));

    const failure = await failureOf(() => transportWith().buildInfo());

    expect(failure.category).toBe("protocol");
    expect(failure.detail).toEqual({ status: 500 });
    expect(failure.message).toBe(
      "The server answered /api/v1/status/buildinfo with HTTP 500 and an error document that lacks an errorType " +
        "or a message",
    );
  });

  test.each([401, 403])(
    "HTTP %d with no envelope is a refused credential, and its body is never shown (CONSTRUCTED, M5)",
    async (status) => {
      // M5 records the body the live prometheus-auth answers with; only its absence from the message matters.
      reply(plain(`Unauthorized marker-${status}\n`, status));

      const failure = await failureOf(() => transportWith({ user: "alice", password: "wrong" }).buildInfo());

      expect(failure.category).toBe("unauthorized");
      expect(failure.detail).toEqual({ status });
      expect(failure.message).toBe(
        `The server refused the credentials for /api/v1/status/buildinfo with HTTP ${status}. Check User and ` +
          "Password or token, or what a proxy in front of the server expects.",
      );
      expect(failure.message).not.toContain(`marker-${status}`);
    },
  );

  test.each<[string, Reply]>([
    [
      "an HTML page a proxy answers with HTTP 200",
      { status: 200, contentType: "text/html", body: "<html><title>Sign in marker-html</title></html>" },
    ],
    ["a 502 with a text body", plain("upstream connect error marker-502", 502)],
    ["the 503 a server that is not ready answers", plain("Service Unavailable marker-503", 503)],
    ["JSON that is not an envelope", { status: 200, body: '{"hello":"marker-json"}' }],
    ["a JSON list", { status: 200, body: '["marker-list"]' }],
    ["an object whose status is neither success nor error", { status: 200, body: '{"status":"ok","data":"marker"}' }],
    ["an empty body", { status: 500, body: "" }],
  ])("%s is a protocol failure naming the path and status, never the body (CONSTRUCTED)", async (_label, answer) => {
    reply(answer);

    const failure = await failureOf(() => transportWith().rules());

    expect(failure.category).toBe("protocol");
    expect(failure.detail).toEqual({ status: answer.status });
    // The controls: the message says where and how, so the absence below is of the body, not of a message.
    expect(failure.message).toContain("/api/v1/rules");
    expect(failure.message).toContain(`HTTP ${answer.status}`);
    expect(failure.message).not.toContain("marker");
  });

  test("the 503 the API's own ready gate answers is named as a server starting or stopping, or a proxy with none ready (CONSTRUCTED)", async () => {
    // `testReady` in web/web.go (v3.13.3) wraps every API route this client reads, and writes exactly
    // this while the server replays its write-ahead log at start-up and again while it shuts down. A
    // proxy with no ready server behind it answers 503 too, so the message names both and decides neither.
    reply(plain("Service Unavailable", 503));

    const failure = await failureOf(() => transportWith().buildInfo());

    expect(failure.category).toBe("protocol");
    expect(failure.detail).toEqual({ status: 503 });
    expect(failure.message).toBe(
      "The server answered /api/v1/status/buildinfo with HTTP 503 and a body that is not a Prometheus API " +
        "response. Prometheus answers every API path this client reads with this status while it starts up, " +
        "replaying its write-ahead log, and while it shuts down, and so does a proxy in front of it with no " +
        "ready server behind it. The body is not shown.",
    );
  });

  test("any other answer that is not the envelope offers its possible sources and decides none (captured from VictoriaMetrics)", async () => {
    // A real answer of this kind: VictoriaMetrics v1.152.0 does not serve the runtime read, and refuses
    // it with a plain-text 400 of its own.
    const answer = captureVm("runtimeinfo");
    reply(captureVmOf("runtimeinfo"));

    const failure = await failureOf(() => transportWith().runtimeInfo());

    // The control: the capture is a plain-text refusal, so the message below describes a real one.
    expect(answer.status).toBe(400);
    expect(answer.text).toContain("unsupported path requested");
    expect(failure.category).toBe("protocol");
    expect(failure.detail).toEqual({ status: 400 });
    // The subject is the server: VictoriaMetrics answered here, so "Prometheus answered" would be false.
    expect(failure.message).toBe(
      "The server answered /api/v1/status/runtimeinfo with HTTP 400 and a body that is not a Prometheus API " +
        "response. A proxy or a login page in front of the server answers this way, and so does a server " +
        "that does not serve this path. The body is not shown.",
    );
  });

  test.each<[RequestFailureReason, string, RequestFailureDetail]>([
    ["tls", "self-signed certificate", { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }],
    ["network", "connect ECONNREFUSED 127.0.0.1:9090", { code: "ECONNREFUSED" }],
    ["too_large", "the answer passed the 4,096-byte cap", { limitBytes: 4_096 }],
    ["deadline", "Prometheus did not answer within 7000 ms", {}],
    ["aborted", "the request was cancelled", {}],
  ])(
    "a request failure %s keeps its reason as the category, and its message and detail",
    async (reason, message, detail) => {
      sendFailure = new RequestFailure(reason, message, detail);

      const failure = await failureOf(() => transportWith().rules());

      expect(failure.category).toBe(reason);
      expect(failure.message).toBe(message);
      expect(failure.detail).toEqual(detail);
    },
  );

  test("the query goes through the same classification", async () => {
    sendFailure = new RequestFailure("aborted", "the request was cancelled");

    const failure = await failureOf(() => transportWith().query("up", QUERY_OPTIONS));

    expect(failure.category).toBe("aborted");
    expect(failure.detail).toEqual({});
  });

  test("a ConnectionError from the shared redirect refusal passes through as the same object (#1085 S2)", async () => {
    let caught: unknown;
    try {
      rejectRedirect(
        { status: 307, headers: new Headers({ location: "https://login.example.com/sso?token=abc" }) },
        `${ORIGIN}/api/v1/rules`,
      );
    } catch (error) {
      caught = error;
    }
    // The control: the shared module refused with the status and the target origin, and nothing else of the
    // Location, so what passes through below is that refusal and not a message this file wrote.
    expect(caught).toBeInstanceOf(ConnectionError);
    const refusal = caught as ConnectionError;
    expect(refusal.message).toContain("HTTP 307");
    expect(refusal.message).toContain("https://login.example.com");
    expect(refusal.message).not.toContain("/sso");
    expect(refusal.message).not.toContain("token=abc");
    sendFailure = refusal;

    await expect(transportWith().rules()).rejects.toBe(refusal);
  });

  test("anything else the sender throws is rethrown as it is, never dressed as a category", async () => {
    const defect = new TypeError("a defect in the sender");
    sendFailure = defect;

    await expect(transportWith().buildInfo()).rejects.toBe(defect);
  });
});

describe("health follows the answers, never the product (6.2)", () => {
  test("a 404 from /-/healthy, and only a 404, sends the probe to /health, and every answer is recorded in order", async () => {
    reply(plain("404 page not found\n", 404), plain("OK"), plain("Prometheus Server is Ready.\n"));

    const health = await transportWith().health();

    expect(health).toEqual({
      probes: [
        { path: "/-/healthy", status: 404 },
        { path: "/health", status: 200 },
        { path: "/-/ready", status: 200 },
      ],
    });
    expect(sent.map((request) => request.url.pathname)).toEqual(["/-/healthy", "/health", "/-/ready"]);
    expect(armed.map((deadline) => deadline.ms)).toEqual([REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS]);
  });

  test("the control: a 503 from /-/healthy is recorded as it is, and /health is never asked", async () => {
    reply(plain("Service Unavailable", 503), plain("Service Unavailable", 503));

    const health = await transportWith().health();

    expect(health.probes).toEqual([
      { path: "/-/healthy", status: 503 },
      { path: "/-/ready", status: 503 },
    ]);
    expect(sent.map((request) => request.url.pathname)).toEqual(["/-/healthy", "/-/ready"]);
  });

  test("a /health that is missing too is recorded, and nothing further is tried", async () => {
    reply(plain("", 404), plain("", 404), plain("Service Unavailable", 503));

    const health = await transportWith().health();

    expect(health.probes).toEqual([
      { path: "/-/healthy", status: 404 },
      { path: "/health", status: 404 },
      { path: "/-/ready", status: 503 },
    ]);
  });

  test.each<[string, Reply[], number]>([
    ["/-/healthy", [plain("Unauthorized\n", 401)], 401],
    ["/-/ready", [plain("Prometheus Server is Healthy.\n"), plain("Forbidden\n", 403)], 403],
  ])(
    "a refused credential at %s is raised as one, never recorded as a server that is down",
    async (path, answers, status) => {
      reply(...answers);

      const failure = await failureOf(() => transportWith({ user: "alice", password: "wrong" }).health());

      expect(failure.category).toBe("unauthorized");
      expect(failure.detail).toEqual({ status });
      expect(failure.message).toContain(path);
      // Nothing is asked after the refusal.
      expect(sent).toHaveLength(answers.length);
      expect(sent.at(-1)?.url.pathname).toBe(path);
    },
  );
});
