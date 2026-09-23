/**
 * Prometheus HTTP transport (#1085, section 3.1)
 *
 * The only implementation of the {@link PrometheusTransport} seam, and the only file in the provider
 * allowed to know the wire: the endpoint paths and the exact parameters of every call (4.6 and 6.2), the
 * `Authorization` header and the rules its credentials must pass first (6.1, #1085 S3), the response envelope
 * and every payload member decoded out of it. `seam-guard.test.ts` fails the build the moment that
 * vocabulary appears anywhere else in the directory.
 *
 * It sends nothing itself. The request function arrives by injection (`HttpTransportDeps.send`, built by
 * `request.ts`) and so does the URL builder (`PrometheusEndpoint`), so this file never touches the
 * network or a host name, and every test drives it without replacing a global (3.5).
 *
 * FIVE FACTS from the upstream source at v3.13.3 (`web/api/v1/api.go`) decide the code below:
 *
 * 1. A FAILURE IS CLASSIFIED BY `errorType`, NEVER BY THE HTTP STATUS. The status is not a stable
 *    signal: `canceled` answers 499, `timeout` 503, `execution` 422, and a type with no case of its own
 *    falls through to 500 (`getDefaultErrorCode`).
 * 2. A BODY THAT IS NOT THE ENVELOPE DID NOT COME FROM THE API. Web-config basic auth answers 401 with
 *    plain text, a proxy answers with an HTML page, and a server that is not ready answers 503
 *    `Service Unavailable` as text. Such a body is never parsed further and never copied into a message:
 *    it is whatever the thing that answered chose to say (#1085 S3).
 * 3. A `limit` THAT CUTS A LIST SHORT SAYS SO, with the warning `results truncated due to limit`, in the
 *    query, series, label names and label values handlers, each of which cuts at the limit itself.
 * 4. THE QUERY HANDLER READS `r.FormValue`, so the expression travels as a form body rather than in a URL
 *    a proxy may log, and with no `time` parameter the server evaluates it at its own now (5.1).
 * 5. THE TARGETS HANDLER AND `exclude_alerts` READ THE URL QUERY (`r.URL.Query()`), so every call other
 *    than the query is a GET with its parameters in the URL.
 */
import { escapeLabelNameForPath } from "./promql";
import { type InboundResponse, type OutboundRequest, RequestFailure, type SendRequest } from "./request";
import {
  type CappedList,
  type HealthProbe,
  type NamedCount,
  type PrometheusAlert,
  type PrometheusAnswer,
  type PrometheusBuildInfo,
  type PrometheusHealth,
  type PrometheusHistogramPoint,
  type PrometheusMetadataEntry,
  type PrometheusNativeHistogram,
  type PrometheusNotice,
  type PrometheusQueryData,
  type PrometheusQueryOptions,
  type PrometheusRule,
  type PrometheusRuleGroup,
  type PrometheusRuntimeInfo,
  type PrometheusSample,
  type PrometheusSeries,
  type PrometheusTarget,
  type PrometheusTransport,
  PrometheusTransportError,
  type PrometheusTsdbStatus,
  type RuleFilter,
  type TimeWindow,
} from "./transport";

// ============================================================================
// Public surface
// ============================================================================

/**
 * The narrow port every request URL is built through.
 *
 * The shared endpoint module implements it (#1085 S1): it validates the connection's host and port and asserts
 * the origin and path of every URL it builds before anything is sent. This file hands it only a fixed
 * path from {@link PATHS} and parameters built with `URLSearchParams`, never a host and never text spliced
 * into a path.
 */
export interface PrometheusEndpoint {
  url(pathname: string, query?: URLSearchParams): URL;
}

/** The two connection fields authentication is built from (6.1). */
export interface PrometheusCredentials {
  readonly user?: string;
  readonly password?: string;
}

export interface HttpTransportDeps {
  /** How a request leaves the process: `createSendRequest()` from `request.ts`. */
  readonly send: SendRequest;
  readonly endpoint: PrometheusEndpoint;
  /** The deadline of every call that is not a query. A query carries its own (5.2). */
  readonly requestTimeoutMs: number;
  /** Every request's streaming byte cap (#1085 S5). */
  readonly maxResponseBytes: number;
}

/**
 * The response byte cap of #1085 S5, measurement M12 (tests/fixtures/prometheus/README.md, "Measurements").
 *
 * Series and sample caps can only apply after a body is parsed, and `--query.max-samples` defaults to
 * 50,000,000, so one matrix answer can reach gigabytes inside the one Studio process every user shares.
 * The candidate was 32 MiB, and M12 confirms it against the largest answer the live server produced.
 */
export const RESPONSE_BYTE_CAP = 32 * 1024 * 1024;

// ============================================================================
// The wire
// ============================================================================

/**
 * Every endpoint this provider calls, and nothing else (#1085 S9): the read endpoints of #1085 4.6 and 6.2.
 * Each is spelled whole rather than assembled from a prefix, so this table is the complete record of what
 * the provider can reach.
 */
const PATHS = Object.freeze({
  QUERY: "/api/v1/query",
  // The only label-values path the provider reads. `__name__` is a legacy name, so the escape is the
  // identity, and it still goes through promql.ts, the one builder of a label path (#1085 S4).
  METRIC_NAMES: `/api/v1/label/${escapeLabelNameForPath("__name__")}/values`,
  LABELS: "/api/v1/labels",
  SERIES: "/api/v1/series",
  METADATA: "/api/v1/metadata",
  RULES: "/api/v1/rules",
  SCRAPE_POOLS: "/api/v1/scrape_pools",
  TARGETS: "/api/v1/targets",
  BUILD_INFO: "/api/v1/status/buildinfo",
  RUNTIME_INFO: "/api/v1/status/runtimeinfo",
  FLAGS: "/api/v1/status/flags",
  TSDB: "/api/v1/status/tsdb",
  HEALTHY: "/-/healthy",
  // Asked only when /-/healthy answers 404, the one answer that says the path does not exist there (6.2).
  HEALTH_FALLBACK: "/health",
  READY: "/-/ready",
} as const);

/** Parameter names, exactly as the handlers read them. */
const PARAMS = Object.freeze({
  QUERY: "query",
  TIMEOUT: "timeout",
  LIMIT: "limit",
  START: "start",
  END: "end",
  MATCH: "match[]",
  METRIC: "metric",
  RULE_GROUP: "rule_group[]",
  FILE: "file[]",
  RULE_NAME: "rule_name[]",
  EXCLUDE_ALERTS: "exclude_alerts",
  STATE: "state",
  SCRAPE_POOL: "scrapePool",
} as const);

/**
 * A listing never carries the live alerts of every alerting rule, which are the bulk of a large server's
 * answer; one rule's alerts are read when its source is (4.3, 4.4).
 */
const EXCLUDE_ALERTS = "true";

/** Dropped targets are never listed, and on Kubernetes they can number in the tens of thousands (4.3). */
const ACTIVE_TARGETS = "active";

/** The metadata answer is keyed by metric family, and one family is all a source reads (4.4). */
const ONE_FAMILY = "1";

/** The envelope every API answer is wrapped in (`Response` in web/api/v1/api.go). */
const ENVELOPE = Object.freeze({
  STATUS: "status",
  DATA: "data",
  ERROR_TYPE: "errorType",
  ERROR: "error",
  WARNINGS: "warnings",
  INFOS: "infos",
} as const);

/** The two values of the envelope's `status`, and the only two that make a body an envelope (fact 2). */
const STATUS_SUCCESS = "success";
const STATUS_ERROR = "error";

/** A query's `data`, and the members of each series in it (`QueryData`, web/api/v1/json_codec.go). */
const RESULT = Object.freeze({
  TYPE: "resultType",
  RESULT: "result",
  METRIC: "metric",
  VALUE: "value",
  VALUES: "values",
  HISTOGRAM: "histogram",
  HISTOGRAMS: "histograms",
} as const);

const RESULT_TYPES = Object.freeze({
  VECTOR: "vector",
  MATRIX: "matrix",
  SCALAR: "scalar",
  STRING: "string",
} as const);

/** A native histogram as `jsonutil.MarshalHistogram` writes it: `buckets` only when it has any. */
const HISTOGRAM_FIELDS = Object.freeze({ COUNT: "count", SUM: "sum", BUCKETS: "buckets" } as const);

/** One metadata entry. The answer around it is keyed by metric family. */
const METADATA_FIELDS = Object.freeze({ TYPE: "type", HELP: "help", UNIT: "unit" } as const);

/**
 * `RuleDiscovery` and `RuleGroup`. `groupNextToken` is never read: no call sends `group_limit`, so the
 * listing is never paginated.
 */
const RULE_GROUP_FIELDS = Object.freeze({
  GROUPS: "groups",
  NAME: "name",
  FILE: "file",
  INTERVAL: "interval",
  LIMIT: "limit",
  EVALUATION_TIME: "evaluationTime",
  LAST_EVALUATION: "lastEvaluation",
  RULES: "rules",
} as const);

/**
 * `AlertingRule` and `RecordingRule`, one list told apart by `type`. `lastError` is omitted while a rule
 * has none, and `alerts` is null when the call excluded them.
 */
const RULE_FIELDS = Object.freeze({
  TYPE: "type",
  NAME: "name",
  QUERY: "query",
  LABELS: "labels",
  HEALTH: "health",
  LAST_ERROR: "lastError",
  EVALUATION_TIME: "evaluationTime",
  LAST_EVALUATION: "lastEvaluation",
  STATE: "state",
  DURATION: "duration",
  KEEP_FIRING_FOR: "keepFiringFor",
  ANNOTATIONS: "annotations",
  ALERTS: "alerts",
} as const);

const RULE_TYPES = Object.freeze({ RECORDING: "recording", ALERTING: "alerting" } as const);

/** `Alert`. `activeAt` is omitted while unset, and `keepFiringSince` is not part of the seam. */
const ALERT_FIELDS = Object.freeze({
  LABELS: "labels",
  ANNOTATIONS: "annotations",
  STATE: "state",
  ACTIVE_AT: "activeAt",
  VALUE: "value",
} as const);

/** `ScrapePoolsDiscovery`. */
const SCRAPE_POOLS_FIELD = "scrapePools";

/** `TargetDiscovery`. */
const TARGETS_FIELDS = Object.freeze({
  ACTIVE: "activeTargets",
  /**
   * Deliberately NOT read. `state=active` makes the server answer it as an empty list, and a dropped
   * target is not listed at all (4.1). Recorded because this file is the record of what the wire carries.
   */
  DROPPED: "droppedTargets",
} as const);

/** `Target`. `globalUrl` is not read: `scrapeUrl` is what a target is identified by (4.1). */
const TARGET_FIELDS = Object.freeze({
  SCRAPE_POOL: "scrapePool",
  SCRAPE_URL: "scrapeUrl",
  HEALTH: "health",
  LAST_ERROR: "lastError",
  LAST_SCRAPE: "lastScrape",
  LAST_SCRAPE_DURATION: "lastScrapeDuration",
  SCRAPE_INTERVAL: "scrapeInterval",
  SCRAPE_TIMEOUT: "scrapeTimeout",
  LABELS: "labels",
  DISCOVERED_LABELS: "discoveredLabels",
} as const);

/**
 * `PrometheusVersion` and `RuntimeInfo`: the members the monitoring surfaces read (6.2). `serverTime` is
 * the server's own clock, so an uptime measured against it carries no skew between the two hosts.
 */
const BUILD_FIELDS = Object.freeze({ VERSION: "version" } as const);
const RUNTIME_FIELDS = Object.freeze({
  START_TIME: "startTime",
  SERVER_TIME: "serverTime",
  STORAGE_RETENTION: "storageRetention",
} as const);

/**
 * `TSDBStatus` and `HeadStats`. `numLabelPairs`, `memoryInBytesByLabelName` and
 * `seriesCountByLabelValuePair` are not read.
 */
const TSDB_FIELDS = Object.freeze({
  HEAD: "headStats",
  NUM_SERIES: "numSeries",
  CHUNK_COUNT: "chunkCount",
  MIN_TIME: "minTime",
  MAX_TIME: "maxTime",
  SERIES_BY_METRIC: "seriesCountByMetricName",
  VALUES_BY_LABEL: "labelValueCountByLabelName",
  NAME: "name",
  VALUE: "value",
} as const);

/**
 * The engine's own sentence when a `limit` cut a list short (fact 3), compared whole. Measurement M8 in
 * tests/fixtures/prometheus/README.md records it verbatim from the live server.
 */
const TRUNCATION_NOTICE = "results truncated due to limit";

const ACCEPT_HEADER = "accept";
const AUTHORIZATION_HEADER = "authorization";
const CONTENT_TYPE_HEADER = "content-type";
const JSON_MEDIA_TYPE = "application/json";
/** Go's `ParseForm` reads a POST body only under this type: without it the server would see no `query`. */
const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";

/** The statuses a refused credential answers with when no envelope says anything else (5.5). */
const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;
/** The one liveness answer that says the path does not exist, and so the only one that sends the probe on. */
const NOT_FOUND_STATUS = 404;

const MS_PER_SECOND = 1000;

// ============================================================================
// Credentials
// ============================================================================

/**
 * RFC 7235 section 2.1: `token68 = 1*( ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/" ) *"="`.
 * A space, a comma, a quote or any non-ASCII character would make the header mean something else.
 */
const TOKEN68 = /^[A-Za-z0-9._~+/-]+=*$/;

/**
 * The characters that end or corrupt a header line. A value holding one makes `fetch` throw a
 * `TypeError` whose message quotes the whole header, token included (measured on node v26.7.0 and bun
 * 1.4.2, #1085 S3), and that message would reach the log and the client.
 */
const HEADER_BREAKING_CHARACTERS: readonly string[] = ["\r", "\n", "\0"];

const USER_FIELD = "user name";
const PASSWORD_FIELD = "password or token";

function credentialError(message: string): PrometheusTransportError {
  return new PrometheusTransportError("credential", message);
}

/** Refuses rather than trims: a credential is sent exactly as entered, or not at all. */
function refuseHeaderBreaking(value: string, field: string): void {
  if (HEADER_BREAKING_CHARACTERS.some((character) => value.includes(character))) {
    throw credentialError(
      `The ${field} contains a line break or a NUL character, which an HTTP header cannot carry. ` +
        "Remove it: credentials are sent exactly as entered and never trimmed.",
    );
  }
}

/**
 * The `Authorization` header these credentials make, or undefined when neither is set (6.1).
 *
 * - User and password: `Basic`. Grafana Cloud's hosted Prometheus works this way, with the instance id
 *   as the user and an access-policy token as the password.
 * - Password alone: `Bearer <password>`, the libSQL precedent; the field is labelled "Password or token".
 * - User alone: `Basic` with an empty password, the ClickHouse behaviour.
 * - An empty field is not set: the connection form stores one as "".
 *
 * Every value is checked before a header exists (#1085 S3), and a refusal names the field and never the value,
 * because its message reaches the log and the client.
 */
export function authorizationFor(credentials: PrometheusCredentials): string | undefined {
  const user = credentials.user ?? "";
  const password = credentials.password ?? "";

  if (user === "") {
    if (password === "") return undefined;
    refuseHeaderBreaking(password, PASSWORD_FIELD);
    if (!TOKEN68.test(password)) {
      throw credentialError(
        `The ${PASSWORD_FIELD} holds a character a bearer token cannot carry: only letters, digits and ` +
          "- . _ ~ + / are allowed, with = only at the end. Remove it, or fill in User to send the value as a " +
          "Basic password.",
      );
    }
    return `Bearer ${password}`;
  }

  refuseHeaderBreaking(user, USER_FIELD);
  if (user.includes(":")) {
    throw credentialError(
      `The ${USER_FIELD} contains a colon, which Basic authentication cannot carry: the colon is what ` +
        "separates the user from the password (RFC 7617). Remove it.",
    );
  }
  refuseHeaderBreaking(password, PASSWORD_FIELD);
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

// ============================================================================
// Reading a document
// ============================================================================

/**
 * A document this client cannot read. The message names the path and what was expected, in this file's
 * own words, and never quotes the document: the server's text is data, not a message (#1085 S7).
 */
function unreadable(path: string, problem: string): PrometheusTransportError {
  return new PrometheusTransportError(
    "protocol",
    `Prometheus answered ${path} with a document this client cannot read: ${problem}`,
  );
}

function asObject(path: string, value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw unreadable(path, `expected an object at ${what}`);
  }
  return value as Record<string, unknown>;
}

function list(path: string, value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw unreadable(path, `expected a list at ${what}`);
  return value;
}

function texts(path: string, value: unknown, what: string): string[] {
  return list(path, value, what).map((entry) => {
    if (typeof entry !== "string") throw unreadable(path, `expected only text in ${what}`);
    return entry;
  });
}

/** An object whose every value is text: a label set, a rule's annotations, the flags. */
function textRecord(path: string, value: unknown, what: string): Record<string, string> {
  const record = asObject(path, value, what);
  if (Object.values(record).some((entry) => typeof entry !== "string")) {
    throw unreadable(path, `expected only text in ${what}`);
  }
  return record as Record<string, string>;
}

/** Typed reads of one object's members, each refusal naming the member and the object. */
interface MemberReader {
  readonly source: Readonly<Record<string, unknown>>;
  text(member: string): string;
  /** Text, or "" where the engine omits the member while it is empty (`omitempty`). */
  optionalText(member: string): string;
  number(member: string): number;
  labels(member: string): Record<string, string>;
}

function membersOf(path: string, value: unknown, what: string): MemberReader {
  const source = asObject(path, value, what);
  return {
    source,
    text: (member) => {
      const found = source[member];
      if (typeof found !== "string") throw unreadable(path, `expected text at ${member} in ${what}`);
      return found;
    },
    optionalText: (member) => {
      const found = source[member];
      if (found === undefined) return "";
      if (typeof found !== "string") throw unreadable(path, `expected text or nothing at ${member} in ${what}`);
      return found;
    },
    number: (member) => {
      const found = source[member];
      if (typeof found !== "number" || !Number.isFinite(found)) {
        throw unreadable(path, `expected a finite number at ${member} in ${what}`);
      }
      return found;
    },
    labels: (member) => textRecord(path, source[member], `${what}'s ${member}`),
  };
}

// ============================================================================
// Reading an answer
// ============================================================================

/** What one answer carried: its `data` member and the notices beside it. */
interface EnvelopeContent {
  readonly data: unknown;
  readonly notices: readonly PrometheusNotice[];
}

/** The envelope, or null when the body is not one: a JSON object whose `status` is `success` or `error` (fact 2). */
function parseEnvelope(body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const envelope = parsed as Record<string, unknown>;
  const status = envelope[ENVELOPE.STATUS];
  return status === STATUS_SUCCESS || status === STATUS_ERROR ? envelope : null;
}

/**
 * An answer's `data` and notices, or the failure it reports.
 *
 * A body that is not the envelope stays out of every message (fact 2): a 401 or 403 is a refused
 * credential, anything else a protocol failure that names only the path and the status.
 */
function readEnvelope(path: string, response: InboundResponse): EnvelopeContent {
  const envelope = parseEnvelope(response.body);
  if (envelope === null) {
    if (response.status === UNAUTHORIZED_STATUS || response.status === FORBIDDEN_STATUS) {
      throw refusedCredentials(path, response.status);
    }
    throw new PrometheusTransportError(
      "protocol",
      `Prometheus answered ${path} with HTTP ${response.status} and a body that is not a Prometheus API ` +
        "response, so something other than the Prometheus API answered at this address, such as a proxy or a " +
        "login page. The body is not shown.",
      { status: response.status },
    );
  }
  if (envelope[ENVELOPE.STATUS] === STATUS_ERROR) throw engineFailure(path, envelope, response.status);
  return { data: envelope[ENVELOPE.DATA], notices: noticesOf(path, envelope) };
}

/**
 * The failure an error envelope reports, classified by its `errorType` alone (fact 1). The category is
 * the engine's own word, carried verbatim even when this build does not know it, and the message is the
 * engine's own sentence, which is what locates a parse error for the user.
 */
function engineFailure(path: string, envelope: Record<string, unknown>, status: number): PrometheusTransportError {
  const category = envelope[ENVELOPE.ERROR_TYPE];
  const message = envelope[ENVELOPE.ERROR];
  if (typeof category !== "string" || category === "" || typeof message !== "string") {
    return new PrometheusTransportError(
      "protocol",
      `Prometheus answered ${path} with HTTP ${status} and an error document that lacks an errorType or a message`,
      { status },
    );
  }
  return new PrometheusTransportError(category, message, { status });
}

/** A 401 or 403 without an envelope: web-config basic auth, or a proxy, refused the credentials (5.5). */
function refusedCredentials(path: string, status: number): PrometheusTransportError {
  return new PrometheusTransportError(
    "unauthorized",
    `Prometheus refused the credentials for ${path} with HTTP ${status}. Check User and Password or token, ` +
      "or what a proxy in front of the server expects.",
    { status },
  );
}

/** The envelope's `warnings`, then its `infos`, verbatim (5.4). The handler omits a list that is empty. */
function noticesOf(path: string, envelope: Record<string, unknown>): PrometheusNotice[] {
  const warnings = envelope[ENVELOPE.WARNINGS];
  const infos = envelope[ENVELOPE.INFOS];
  return [
    ...(warnings === undefined ? [] : texts(path, warnings, "the warnings")).map(
      (message): PrometheusNotice => ({ level: "warning", message }),
    ),
    ...(infos === undefined ? [] : texts(path, infos, "the info notices")).map(
      (message): PrometheusNotice => ({ level: "info", message }),
    ),
  ];
}

/** Whether the server said it cut the list at the limit it was asked for (fact 3, M8). */
function truncatedBy(notices: readonly PrometheusNotice[]): boolean {
  return notices.some((notice) => notice.level === "warning" && notice.message === TRUNCATION_NOTICE);
}

// ============================================================================
// Decoding into the seam
// ============================================================================

function sample(path: string, value: unknown, what: string): PrometheusSample {
  const pair = list(path, value, what);
  const [at, reading] = pair;
  if (pair.length !== 2 || typeof at !== "number" || !Number.isFinite(at) || typeof reading !== "string") {
    throw unreadable(path, `expected a [time, value] pair at ${what}`);
  }
  return { at, value: reading };
}

function histogramPoint(path: string, value: unknown, what: string): PrometheusHistogramPoint {
  const pair = list(path, value, what);
  const [at, histogram] = pair;
  if (pair.length !== 2 || typeof at !== "number" || !Number.isFinite(at)) {
    throw unreadable(path, `expected a [time, histogram] pair at ${what}`);
  }
  return { at, histogram: nativeHistogram(path, histogram) };
}

function nativeHistogram(path: string, value: unknown): PrometheusNativeHistogram {
  const histogram = membersOf(path, value, "a native histogram");
  const count = histogram.text(HISTOGRAM_FIELDS.COUNT);
  const sum = histogram.text(HISTOGRAM_FIELDS.SUM);
  const buckets = histogram.source[HISTOGRAM_FIELDS.BUCKETS];
  if (buckets === undefined) return { count, sum };
  return {
    count,
    sum,
    buckets: list(path, buckets, "a native histogram's buckets").map((bucket) => histogramBucket(path, bucket)),
  };
}

function histogramBucket(path: string, value: unknown): readonly [number, string, string, string] {
  const bucket = list(path, value, "a histogram bucket");
  const [boundaries, lower, upper, count] = bucket;
  if (
    bucket.length !== 4 ||
    typeof boundaries !== "number" ||
    typeof lower !== "string" ||
    typeof upper !== "string" ||
    typeof count !== "string"
  ) {
    throw unreadable(path, "expected a [boundaries, lower, upper, count] histogram bucket");
  }
  return [boundaries, lower, upper, count];
}

/**
 * One vector entry: exactly one sample, a float `value` or a native `histogram`. The engine writes one of
 * the two and never both (`marshalSampleJSON`), and the seam's vector series holds exactly one point, so an
 * entry with neither or both is refused rather than read as zero points or two.
 */
function vectorSeries(path: string, value: unknown): PrometheusSeries {
  const entry = membersOf(path, value, "a vector sample");
  const reading = entry.source[RESULT.VALUE];
  const histogram = entry.source[RESULT.HISTOGRAM];
  if ((reading === undefined) === (histogram === undefined)) {
    throw unreadable(path, "expected exactly one of a value and a histogram in a vector sample");
  }
  return {
    labels: entry.labels(RESULT.METRIC),
    samples: reading === undefined ? [] : [sample(path, reading, "a vector sample's value")],
    histograms: histogram === undefined ? [] : [histogramPoint(path, histogram, "a vector sample's histogram")],
  };
}

/** One matrix series: `values` and `histograms` are each written only when the series has any. */
function matrixSeries(path: string, value: unknown): PrometheusSeries {
  const entry = membersOf(path, value, "a matrix series");
  const readings = entry.source[RESULT.VALUES];
  const histograms = entry.source[RESULT.HISTOGRAMS];
  return {
    labels: entry.labels(RESULT.METRIC),
    samples:
      readings === undefined
        ? []
        : list(path, readings, "a matrix series' values").map((pair) => sample(path, pair, "a matrix sample")),
    histograms:
      histograms === undefined
        ? []
        : list(path, histograms, "a matrix series' histograms").map((point) =>
            histogramPoint(path, point, "a matrix histogram"),
          ),
  };
}

function queryData(value: unknown): PrometheusQueryData {
  const path = PATHS.QUERY;
  const data = membersOf(path, value, "the query result");
  const result = data.source[RESULT.RESULT];
  switch (data.source[RESULT.TYPE]) {
    case RESULT_TYPES.VECTOR:
      return { shape: "vector", series: list(path, result, "a vector").map((entry) => vectorSeries(path, entry)) };
    case RESULT_TYPES.MATRIX:
      return { shape: "matrix", series: list(path, result, "a matrix").map((entry) => matrixSeries(path, entry)) };
    case RESULT_TYPES.SCALAR:
      return { shape: "scalar", sample: sample(path, result, "a scalar") };
    case RESULT_TYPES.STRING:
      return { shape: "string", sample: sample(path, result, "a string") };
    default:
      throw unreadable(path, "expected a vector, matrix, scalar or string result");
  }
}

function metadataEntry(value: unknown): PrometheusMetadataEntry {
  const entry = membersOf(PATHS.METADATA, value, "a metadata entry");
  return {
    type: entry.text(METADATA_FIELDS.TYPE),
    help: entry.text(METADATA_FIELDS.HELP),
    unit: entry.text(METADATA_FIELDS.UNIT),
  };
}

function ruleGroup(value: unknown): PrometheusRuleGroup {
  const group = membersOf(PATHS.RULES, value, "a rule group");
  const rules = list(PATHS.RULES, group.source[RULE_GROUP_FIELDS.RULES], "a rule group's rules");
  return {
    name: group.text(RULE_GROUP_FIELDS.NAME),
    file: group.text(RULE_GROUP_FIELDS.FILE),
    interval: group.number(RULE_GROUP_FIELDS.INTERVAL),
    limit: group.number(RULE_GROUP_FIELDS.LIMIT),
    evaluationTime: group.number(RULE_GROUP_FIELDS.EVALUATION_TIME),
    lastEvaluation: group.text(RULE_GROUP_FIELDS.LAST_EVALUATION),
    rules: rules.map((entry) => rule(entry)),
  };
}

function rule(value: unknown): PrometheusRule {
  const entry = membersOf(PATHS.RULES, value, "a rule");
  const common = {
    name: entry.text(RULE_FIELDS.NAME),
    query: entry.text(RULE_FIELDS.QUERY),
    labels: entry.labels(RULE_FIELDS.LABELS),
    health: entry.text(RULE_FIELDS.HEALTH),
    lastError: entry.optionalText(RULE_FIELDS.LAST_ERROR),
    evaluationTime: entry.number(RULE_FIELDS.EVALUATION_TIME),
    lastEvaluation: entry.text(RULE_FIELDS.LAST_EVALUATION),
  };
  switch (entry.source[RULE_FIELDS.TYPE]) {
    case RULE_TYPES.RECORDING:
      return { kind: "recording", ...common };
    case RULE_TYPES.ALERTING: {
      const alerts = entry.source[RULE_FIELDS.ALERTS];
      return {
        kind: "alerting",
        ...common,
        duration: entry.number(RULE_FIELDS.DURATION),
        keepFiringFor: entry.number(RULE_FIELDS.KEEP_FIRING_FOR),
        annotations: entry.labels(RULE_FIELDS.ANNOTATIONS),
        state: entry.text(RULE_FIELDS.STATE),
        // Null on every call that excluded them, the Go nil slice, which is an empty list (4.3). The member
        // itself is always written, so a rule without it is a document this client cannot read.
        alerts:
          alerts === null ? [] : list(PATHS.RULES, alerts, "an alerting rule's alerts").map((item) => alert(item)),
      };
    }
    default:
      throw unreadable(PATHS.RULES, "expected a recording or an alerting rule");
  }
}

function alert(value: unknown): PrometheusAlert {
  const entry = membersOf(PATHS.RULES, value, "an alert");
  return {
    labels: entry.labels(ALERT_FIELDS.LABELS),
    annotations: entry.labels(ALERT_FIELDS.ANNOTATIONS),
    state: entry.text(ALERT_FIELDS.STATE),
    activeAt: entry.optionalText(ALERT_FIELDS.ACTIVE_AT),
    value: entry.text(ALERT_FIELDS.VALUE),
  };
}

function target(value: unknown): PrometheusTarget {
  const entry = membersOf(PATHS.TARGETS, value, "a target");
  return {
    scrapePool: entry.text(TARGET_FIELDS.SCRAPE_POOL),
    scrapeUrl: entry.text(TARGET_FIELDS.SCRAPE_URL),
    health: entry.text(TARGET_FIELDS.HEALTH),
    lastError: entry.text(TARGET_FIELDS.LAST_ERROR),
    lastScrape: entry.text(TARGET_FIELDS.LAST_SCRAPE),
    lastScrapeDuration: entry.number(TARGET_FIELDS.LAST_SCRAPE_DURATION),
    scrapeInterval: entry.text(TARGET_FIELDS.SCRAPE_INTERVAL),
    scrapeTimeout: entry.text(TARGET_FIELDS.SCRAPE_TIMEOUT),
    labels: entry.labels(TARGET_FIELDS.LABELS),
    discoveredLabels: entry.labels(TARGET_FIELDS.DISCOVERED_LABELS),
  };
}

function namedCounts(value: unknown, what: string): NamedCount[] {
  return list(PATHS.TSDB, value, what).map((item) => {
    const counted = membersOf(PATHS.TSDB, item, `an entry of ${what}`);
    return { name: counted.text(TSDB_FIELDS.NAME), value: counted.number(TSDB_FIELDS.VALUE) };
  });
}

function tsdbStatus(value: unknown): PrometheusTsdbStatus {
  const status = membersOf(PATHS.TSDB, value, "the TSDB status");
  const head = membersOf(PATHS.TSDB, status.source[TSDB_FIELDS.HEAD], "the head block statistics");
  return {
    headSeries: head.number(TSDB_FIELDS.NUM_SERIES),
    headChunks: head.number(TSDB_FIELDS.CHUNK_COUNT),
    headMinTimeMs: head.number(TSDB_FIELDS.MIN_TIME),
    headMaxTimeMs: head.number(TSDB_FIELDS.MAX_TIME),
    seriesByMetric: namedCounts(status.source[TSDB_FIELDS.SERIES_BY_METRIC], "the series counts by metric"),
    valuesByLabel: namedCounts(status.source[TSDB_FIELDS.VALUES_BY_LABEL], "the value counts by label"),
  };
}

// ============================================================================
// Parameters
// ============================================================================

type QueryParams = [string, string][];

/** Float seconds, the form the handlers' `parseTime` reads first. */
function windowParams(window: TimeWindow): QueryParams {
  return [
    [PARAMS.START, String(window.startSeconds)],
    [PARAMS.END, String(window.endSeconds)],
  ];
}

/**
 * The two rules calls of 4.4 and 4.6, as {@link RuleFilter} names them: the listing, which leaves out every
 * live alert, and the rules of one name in one group, which carry theirs. A group's own facts come from its
 * listing entry, which holds every member a read of that group alone would, so that read is never sent.
 */
function ruleParams(filter: RuleFilter | undefined): QueryParams {
  if (filter === undefined) return [[PARAMS.EXCLUDE_ALERTS, EXCLUDE_ALERTS]];
  return [
    [PARAMS.RULE_GROUP, filter.group],
    [PARAMS.FILE, filter.file],
    [PARAMS.RULE_NAME, filter.ruleName],
  ];
}

// ============================================================================
// Transport
// ============================================================================

class PrometheusHttpTransport implements PrometheusTransport {
  private readonly headers: Readonly<Record<string, string>>;

  constructor(
    authorization: string | undefined,
    private readonly deps: HttpTransportDeps,
  ) {
    this.headers = {
      [ACCEPT_HEADER]: JSON_MEDIA_TYPE,
      ...(authorization === undefined ? {} : { [AUTHORIZATION_HEADER]: authorization }),
    };
  }

  /**
   * One instant query (5.1). The expression is sent exactly as written, `#` comments and all. `timeout` is
   * the deadline in seconds, the form the handler's `parseDuration` reads first. `limit` caps the series on
   * the server where that is supported, and it asks for one series more than the shaper shows (5.4): the
   * engine keeps at most ten warnings and can drop its own truncation notice among them, so the extra
   * series is how a server-side cut is still seen, the way the capped lists ask for their cap plus one
   * (4.3). No `time` parameter, so the server evaluates at its own now. The request aborts on the caller's
   * signal or at the deadline, whichever comes first (5.2).
   */
  async query(expression: string, options: PrometheusQueryOptions): Promise<PrometheusAnswer<PrometheusQueryData>> {
    const form = new URLSearchParams([
      [PARAMS.QUERY, expression],
      [PARAMS.TIMEOUT, String(options.timeoutMs / MS_PER_SECOND)],
      [PARAMS.LIMIT, String(options.seriesLimit + 1)],
    ]);
    const deadline = AbortSignal.timeout(options.timeoutMs);
    const { data, notices } = await this.read(PATHS.QUERY, {
      method: "POST",
      url: this.deps.endpoint.url(PATHS.QUERY),
      headers: { ...this.headers, [CONTENT_TYPE_HEADER]: FORM_MEDIA_TYPE },
      body: form.toString(),
      signal: AbortSignal.any(options.signal === undefined ? [deadline] : [options.signal, deadline]),
      maxBytes: this.deps.maxResponseBytes,
    });
    return { value: queryData(data), notices, truncatedByServer: truncatedBy(notices) };
  }

  async metricNames(window: TimeWindow, limit: number): Promise<CappedList<string>> {
    const { data, notices } = await this.call(PATHS.METRIC_NAMES, [
      ...windowParams(window),
      [PARAMS.LIMIT, String(limit)],
    ]);
    return { items: texts(PATHS.METRIC_NAMES, data, "the metric names"), truncatedByServer: truncatedBy(notices) };
  }

  async labelNames(selector: string, window: TimeWindow): Promise<readonly string[]> {
    const { data } = await this.call(PATHS.LABELS, [[PARAMS.MATCH, selector], ...windowParams(window)]);
    return texts(PATHS.LABELS, data, "the label names");
  }

  async seriesLabels(
    selector: string,
    window: TimeWindow,
    limit: number,
  ): Promise<CappedList<Readonly<Record<string, string>>>> {
    const { data, notices } = await this.call(PATHS.SERIES, [
      [PARAMS.MATCH, selector],
      ...windowParams(window),
      [PARAMS.LIMIT, String(limit)],
    ]);
    return {
      items: list(PATHS.SERIES, data, "the series").map((entry) => textRecord(PATHS.SERIES, entry, "a series")),
      truncatedByServer: truncatedBy(notices),
    };
  }

  /**
   * The metadata of one metric. The answer is keyed by the family the server resolved the name to, and
   * only that key is read, as an own property: a name such as `constructor` must never reach
   * `Object.prototype`, and an empty answer is the engine saying it holds none (4.4).
   */
  async metadata(metric: string): Promise<readonly PrometheusMetadataEntry[]> {
    const { data } = await this.call(PATHS.METADATA, [
      [PARAMS.METRIC, metric],
      [PARAMS.LIMIT, ONE_FAMILY],
    ]);
    const families = asObject(PATHS.METADATA, data, "the metadata");
    if (!Object.hasOwn(families, metric)) return [];
    return list(PATHS.METADATA, families[metric], "a family's metadata").map((entry) => metadataEntry(entry));
  }

  async rules(filter?: RuleFilter): Promise<readonly PrometheusRuleGroup[]> {
    const { data } = await this.call(PATHS.RULES, ruleParams(filter));
    const discovery = asObject(PATHS.RULES, data, "the rules");
    return list(PATHS.RULES, discovery[RULE_GROUP_FIELDS.GROUPS], "the rule groups").map((entry) => ruleGroup(entry));
  }

  async scrapePools(): Promise<readonly string[]> {
    const { data } = await this.call(PATHS.SCRAPE_POOLS);
    const discovery = asObject(PATHS.SCRAPE_POOLS, data, "the scrape pools");
    return texts(PATHS.SCRAPE_POOLS, discovery[SCRAPE_POOLS_FIELD], "the scrape pool names");
  }

  async targets(pool?: string): Promise<readonly PrometheusTarget[]> {
    const params: QueryParams =
      pool === undefined
        ? [[PARAMS.STATE, ACTIVE_TARGETS]]
        : [
            [PARAMS.STATE, ACTIVE_TARGETS],
            [PARAMS.SCRAPE_POOL, pool],
          ];
    const { data } = await this.call(PATHS.TARGETS, params);
    const discovery = asObject(PATHS.TARGETS, data, "the targets");
    return list(PATHS.TARGETS, discovery[TARGETS_FIELDS.ACTIVE], "the active targets").map((entry) => target(entry));
  }

  /**
   * Liveness, then readiness, each answer recorded in the order it was asked (6.2). Driven by the answers
   * and never by naming a product: only a 404 from /-/healthy, the answer that says the path does not
   * exist, sends the probe to /health, and that 404 stays in the record so a reader sees which path spoke.
   */
  async health(): Promise<PrometheusHealth> {
    const liveness = await this.probe(PATHS.HEALTHY);
    const fallback = liveness.status === NOT_FOUND_STATUS ? [await this.probe(PATHS.HEALTH_FALLBACK)] : [];
    const readiness = await this.probe(PATHS.READY);
    return { probes: [liveness, ...fallback, readiness] };
  }

  async buildInfo(): Promise<PrometheusBuildInfo> {
    const { data } = await this.call(PATHS.BUILD_INFO);
    return { version: membersOf(PATHS.BUILD_INFO, data, "the build information").text(BUILD_FIELDS.VERSION) };
  }

  async runtimeInfo(): Promise<PrometheusRuntimeInfo> {
    const { data } = await this.call(PATHS.RUNTIME_INFO);
    const info = membersOf(PATHS.RUNTIME_INFO, data, "the runtime information");
    return {
      startTime: info.text(RUNTIME_FIELDS.START_TIME),
      serverTime: info.text(RUNTIME_FIELDS.SERVER_TIME),
      storageRetention: info.text(RUNTIME_FIELDS.STORAGE_RETENTION),
    };
  }

  async flags(): Promise<Readonly<Record<string, string>>> {
    const { data } = await this.call(PATHS.FLAGS);
    return textRecord(PATHS.FLAGS, data, "the flags");
  }

  async tsdbStatus(limit: number): Promise<PrometheusTsdbStatus> {
    const { data } = await this.call(PATHS.TSDB, [[PARAMS.LIMIT, String(limit)]]);
    return tsdbStatus(data);
  }

  /**
   * One health answer's status. The body is never read: at best it is a sentence of text, and only the
   * status is a fact. A 401 or 403 is not a health fact but a refused credential (5.5), so it is raised as
   * one rather than recorded as a server that is down.
   */
  private async probe(path: string): Promise<HealthProbe> {
    const response = await this.exchange(this.getRequest(path));
    if (response.status === UNAUTHORIZED_STATUS || response.status === FORBIDDEN_STATUS) {
      throw refusedCredentials(path, response.status);
    }
    return { path, status: response.status };
  }

  private call(path: string, params?: QueryParams): Promise<EnvelopeContent> {
    return this.read(path, this.getRequest(path, params));
  }

  /** Every call that is not a query: a GET with its parameters in the URL, under the request deadline. */
  private getRequest(path: string, params?: QueryParams): OutboundRequest {
    return {
      method: "GET",
      url: this.deps.endpoint.url(path, params === undefined ? undefined : new URLSearchParams(params)),
      headers: this.headers,
      signal: AbortSignal.timeout(this.deps.requestTimeoutMs),
      maxBytes: this.deps.maxResponseBytes,
    };
  }

  private async read(path: string, request: OutboundRequest): Promise<EnvelopeContent> {
    return readEnvelope(path, await this.exchange(request));
  }

  /**
   * The sender's failures in this seam's vocabulary. A `RequestFailure` keeps its reason as the category,
   * and its message and detail as they are: request.ts never puts a header value or a body in either.
   * Anything else is rethrown unchanged rather than dressed up as a category it may not be: above all the
   * `ConnectionError` the shared `rejectRedirect` throws for a 3xx, which already names only the status
   * and the target's origin (#1085 S2), and a defect the sender did not classify.
   */
  private async exchange(request: OutboundRequest): Promise<InboundResponse> {
    try {
      return await this.deps.send(request);
    } catch (error) {
      if (error instanceof RequestFailure) {
        throw new PrometheusTransportError(error.reason, error.message, error.detail);
      }
      throw error;
    }
  }
}

/**
 * The transport for one connection. The credentials are checked here, once, before any request exists
 * (#1085 S3): a refused credential throws from this call, and nothing is ever sent.
 */
export function createHttpTransport(credentials: PrometheusCredentials, deps: HttpTransportDeps): PrometheusTransport {
  return new PrometheusHttpTransport(authorizationFor(credentials), deps);
}
