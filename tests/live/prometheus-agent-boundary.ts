/**
 * Runs the Prometheus agent path through the provider against the Prometheus 3.13.3 and VictoriaMetrics v1.152.0
 * servers that tests/fixtures/prometheus/v3.13.3/agent-boundary/run.sh started, sends the admin, remote-write, OTLP,
 * import and lifecycle requests raw, and writes what each answered into that run.sh's directory as boundary.json.
 *
 *   bun tests/live/prometheus-agent-boundary.ts
 *
 * The environment names the servers: PROMETHEUS_AGENT_URL and VICTORIAMETRICS_AGENT_URL (their origins),
 * PROMETHEUS_AGENT_OUT (the directory to write), PROMETHEUS_AGENT_IMAGE and VICTORIAMETRICS_AGENT_IMAGE (the pinned
 * images, recorded), and PROMETHEUS_AGENT_TOKEN and PROMETHEUS_AGENT_USER, the values run.sh generated for its scrape
 * targets and rules. Those two are read only to prove their absence: before anything is written the whole capture is
 * checked for either one and for any URL that still carries a query string or userinfo, and the script stops if one is
 * there. The capture records no credential value at all: a raw target is recorded by which of its fields carry a query
 * string or userinfo, never by a field's value, and the flags by their names alone.
 *
 * Every request the provider sends goes through a recording sender in front of the real one, so the capture holds
 * every request Studio sent (method, path and the names of its parameters), and the server's state is read before
 * and after Studio's reads: the start time, the last configuration reload, the snapshot of a seeded series' samples
 * at a fixed instant, and the TSDB head. The raw requests are sent by this script with `fetch`, never by Studio, after
 * Studio's reads and after the state is read again; `/-/quit` is the last request, since it stops the server.
 *
 * Run by hand through run.sh, never by `bun run test`, which runs no file under tests/live/.
 */
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a capture records what the server holds then.
import { writeFileSync } from "node:fs";
import { posix } from "node:path";
import { PrometheusProvider } from "@/lib/db/providers/timeseries/prometheus/index";
import { createSendRequest, type SendRequest } from "@/lib/db/providers/timeseries/prometheus/request";
import type { ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const PROMETHEUS = env("PROMETHEUS_AGENT_URL");
const VICTORIAMETRICS = env("VICTORIAMETRICS_AGENT_URL");
const OUT = env("PROMETHEUS_AGENT_OUT");
const SECRETS = [env("PROMETHEUS_AGENT_TOKEN"), env("PROMETHEUS_AGENT_USER")];
const DATE = new Date().toISOString().slice(0, 10);
const READ_ONLY: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const OPERATIONS: ProviderExecutionContext = { readOnly: true };
const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 200, maxResultBytes: 1_000_000, statementTimeoutMs: 10_000 };

interface SentRecord {
  readonly method: string;
  readonly path: string;
  readonly urlParameters: readonly string[];
  readonly formParameters: readonly string[];
}

function recordingSender(sent: SentRecord[]): SendRequest {
  const real = createSendRequest(null);
  return (request) => {
    sent.push({
      method: request.method,
      path: request.url.pathname,
      urlParameters: [...new Set(request.url.searchParams.keys())],
      formParameters: request.body === undefined ? [] : [...new URLSearchParams(request.body).keys()],
    });
    return real(request);
  };
}

function connectionTo(origin: string): DatabaseConnection {
  const url = new URL(origin);
  return {
    id: `capture-${url.port}`,
    name: "capture",
    type: "prometheus",
    host: url.hostname,
    port: Number(url.port),
    createdAt: new Date(),
  };
}

async function open(origin: string, execution: ProviderExecutionContext, sent: SentRecord[]) {
  const provider = new PrometheusProvider(connectionTo(origin), {}, execution, { send: recordingSender(sent) });
  await provider.connect();
  return provider;
}

/** A reading's outcome: what it answered, or the error class and message it refused with. */
async function outcome<T>(read: () => Promise<T>, keep: (value: T) => unknown) {
  try {
    return { ok: true, answer: keep(await read()) };
  } catch (error) {
    const failure = error as Error;
    return { ok: false, error: failure.name, message: failure.message };
  }
}

async function raw(origin: string, method: string, path: string, body?: string) {
  const response = await fetch(`${origin}${path}`, {
    method,
    ...(body === undefined ? {} : { body, headers: { "content-type": "application/x-www-form-urlencoded" } }),
  });
  const text = await response.text();
  return { method, path, status: response.status, bytes: Buffer.byteLength(text), body: text.slice(0, 200) };
}

async function instant(origin: string, expression: string): Promise<unknown> {
  const response = await fetch(`${origin}/api/v1/query`, {
    method: "POST",
    body: new URLSearchParams({ query: expression }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  return ((await response.json()) as { data: { result: unknown } }).data.result;
}

/** What the server holds that a write, a deletion or a lifecycle call would change. */
async function prometheusState(at: number) {
  const runtime = (await (await fetch(`${PROMETHEUS}/api/v1/status/runtimeinfo`)).json()) as {
    data: { startTime: string; reloadConfigSuccess: boolean; lastConfigTime: string };
  };
  const tsdb = (await (await fetch(`${PROMETHEUS}/api/v1/status/tsdb`)).json()) as {
    data: { headStats: { numSeries: number; minTime: number } };
  };
  return {
    startTime: runtime.data.startTime,
    lastConfigTime: runtime.data.lastConfigTime,
    // The value alone: the answer's timestamp is the server's now, which moves between two reads of the same state.
    seedSamplesAtFixedInstant: (
      (await instant(PROMETHEUS, `count_over_time(studio_capture_seed[1m] @ ${at})`)) as { value: [number, string] }[]
    ).map((sample) => sample.value[1]),
    headSeriesAtLeast: tsdb.data.headStats.numSeries > 0,
    headMinTime: tsdb.data.headStats.minTime,
  };
}

/** A raw target recorded by which fields carry a query string or userinfo, never by a value. */
function targetShape(target: Record<string, unknown>) {
  const carries = (value: unknown) => ({
    query: typeof value === "string" && value.includes("?"),
    userinfo: typeof value === "string" && (/^[^\s/@]*:[^\s/@]*@/.test(value) || /\/\/[^/\s]*@/.test(value)),
  });
  const labels = (target.discoveredLabels ?? {}) as Record<string, string>;
  return {
    scrapePool: target.scrapePool,
    scrapeUrl: carries(target.scrapeUrl),
    globalUrl: carries(target.globalUrl),
    lastError: carries(target.lastError),
    instance: carries(((target.labels ?? {}) as Record<string, string>).instance),
    address: carries(labels.__address__),
    scrapeParameters: Object.keys(labels).filter((name) => name.startsWith("__param_")),
  };
}

async function rawTargets(origin: string) {
  const answer = (await (await fetch(`${origin}/api/v1/targets?state=active`)).json()) as {
    data: { activeTargets: Record<string, unknown>[] };
  };
  return answer.data.activeTargets
    .map(targetShape)
    .sort((left, right) => String(left.scrapePool).localeCompare(String(right.scrapePool)));
}

async function agentReads(origin: string, sent: SentRecord[]) {
  const reader = await open(origin, READ_ONLY, sent);
  const rows = (result: { rowCount: number; fields: string[] }) => ({
    rowCount: result.rowCount,
    fields: result.fields,
  });
  const reads = {
    vector: await outcome(() => reader.queryReadOnly("up", BUDGET), rows),
    matrix: await outcome(() => reader.queryReadOnly('up{job="prometheus"}[30s]', BUDGET), rows),
    aggregate: await outcome(() => reader.queryReadOnly("count by (job) (up)", BUDGET), rows),
    alerts: await outcome(() => reader.queryReadOnly("ALERTS", BUDGET), rows),
    rowBudget: await outcome(() => reader.queryReadOnly("up", { ...BUDGET, maxResultRows: 1 }), rows),
    byteBudget: await outcome(() => reader.queryReadOnly("up", { ...BUDGET, maxResultBytes: 10 }), rows),
    parseError: await outcome(() => reader.queryReadOnly("sum(up) by", BUDGET), rows),
    timeBudget: await outcome(
      () => reader.queryReadOnly('sum(count_over_time({__name__=~".+"}[5m]))', { ...BUDGET, statementTimeoutMs: 1 }),
      rows,
    ),
    sampleLimit: await outcome(
      () => reader.queryReadOnly('sum(count_over_time({__name__=~".+"}[10m:1s]))', BUDGET),
      rows,
    ),
  };
  const requestsBeforeRefusals = sent.length;
  const refusedBeforeSend = {
    requestParameter: await outcome(() => reader.queryReadOnly("up&time=0", BUDGET), rows),
    jsonRequest: await outcome(() => reader.queryReadOnly('{"query":"up","time":0}', BUDGET), rows),
    dashboardVariable: await outcome(() => reader.queryReadOnly("rate(up[$__rate_interval])", BUDGET), rows),
    console: await outcome(() => reader.query("up"), rows),
  };
  const refusalsSentNothing = sent.length === requestsBeforeRefusals;
  await reader.disconnect();

  const operator = await open(origin, OPERATIONS, sent);
  const names = (objects: { name: string }[]) => objects.map((object) => object.name).sort();
  const surfaces = {
    targets: await outcome(() => operator.listObjects([], "target"), names),
    alertingRules: await outcome(() => operator.listObjects([], "alerting_rule"), names),
    ruleSources: await outcome(
      async () => {
        const rules = await operator.listObjects([], "alerting_rule");
        return Promise.all(rules.map((rule) => operator.readObjectSource([...rule.path], "alerting_rule")));
      },
      (documents) =>
        documents.map((document) =>
          JSON.stringify(document).includes("[userinfo, query string and fragment withheld]"),
        ),
    ),
    health: await outcome(
      () => operator.getHealth(),
      (health) => Object.keys(health).sort(),
    ),
    storage: await outcome(
      () => operator.getStorageStats(),
      (stats) => stats.length,
    ),
    tables: await outcome(
      () => operator.getTableStats(),
      (stats) => stats.length,
    ),
    overview: await outcome(
      () => operator.getOverview(),
      () => "answered",
    ),
  };
  await operator.disconnect();
  return { reads, refusedBeforeSend, refusalsSentNothing, surfaces };
}

function summarizeSent(sent: readonly SentRecord[]) {
  const seen = new Map<string, SentRecord & { count: number }>();
  for (const request of sent) {
    const key = JSON.stringify(request);
    const entry = seen.get(key);
    seen.set(key, { ...request, count: (entry?.count ?? 0) + 1 });
  }
  return [...seen.values()].sort((left, right) =>
    `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`),
  );
}

const fixedInstant = Math.floor(Date.now() / 1000) - 10;
const prometheusSent: SentRecord[] = [];
const victoriaSent: SentRecord[] = [];

const stateBefore = await prometheusState(fixedInstant);
const prometheusAgent = await agentReads(PROMETHEUS, prometheusSent);
const victoriaAgent = await agentReads(VICTORIAMETRICS, victoriaSent);
const stateAfterStudio = await prometheusState(fixedInstant);

const prometheusTargets = await rawTargets(PROMETHEUS);
const victoriaTargets = await rawTargets(VICTORIAMETRICS);
const flags = (await (await fetch(`${PROMETHEUS}/api/v1/status/flags`)).json()) as { data: Record<string, string> };
const flagNames = Object.keys(flags.data).sort();

// The raw requests, sent by this script and never by Studio. `/-/quit` stops the server, so it is the last.
const victoriaRaw = [
  await raw(VICTORIAMETRICS, "GET", "/api/v1/status/flags"),
  await raw(
    VICTORIAMETRICS,
    "POST",
    "/api/v1/import",
    '{"metric":{"__name__":"studio_capture_import"},"values":[1],"timestamps":[0]}',
  ),
  await raw(VICTORIAMETRICS, "POST", "/api/v1/admin/tsdb/delete_series", "match[]=studio_capture_import"),
  await raw(VICTORIAMETRICS, "GET", "/internal/force_merge"),
  await raw(VICTORIAMETRICS, "GET", "/snapshot/create"),
  await raw(VICTORIAMETRICS, "GET", "/-/reload"),
];
const prometheusRaw = [
  await raw(PROMETHEUS, "POST", "/api/v1/admin/tsdb/delete_series", "match[]=studio_capture_seed"),
  await raw(PROMETHEUS, "POST", "/api/v1/admin/tsdb/clean_tombstones"),
  await raw(PROMETHEUS, "POST", "/api/v1/admin/tsdb/snapshot"),
  await raw(PROMETHEUS, "POST", "/api/v1/write", ""),
  await raw(PROMETHEUS, "POST", "/api/v1/otlp/v1/metrics", ""),
  await raw(PROMETHEUS, "POST", "/-/reload"),
];
const stateAfterRaw = await prometheusState(fixedInstant);
const quit = await raw(PROMETHEUS, "POST", "/-/quit");

const capture = {
  measured: DATE,
  servers: {
    prometheus: `${env("PROMETHEUS_AGENT_IMAGE")}, --web.enable-admin-api --web.enable-remote-write-receiver --web.enable-lifecycle --query.max-samples=100000`,
    victoriametrics: env("VICTORIAMETRICS_AGENT_IMAGE"),
  },
  budget: BUDGET,
  prometheus: {
    agent: prometheusAgent,
    sentByStudio: summarizeSent(prometheusSent),
    stateBefore,
    stateAfterStudio,
    studioLeftStateUnchanged: JSON.stringify(stateBefore) === JSON.stringify(stateAfterStudio),
    rawTargets: prometheusTargets,
    flags: { count: flagNames.length, names: flagNames },
    rawRequests: [...prometheusRaw, quit],
    stateAfterRaw,
  },
  victoriametrics: {
    agent: victoriaAgent,
    sentByStudio: summarizeSent(victoriaSent),
    rawTargets: victoriaTargets,
    rawRequests: victoriaRaw,
  },
};

const text = `${JSON.stringify(capture, null, 2)}\n`;
for (const secret of SECRETS) {
  if (text.includes(secret)) throw new Error("the capture holds a generated credential value; nothing was written");
}
if (/[?&]token=/.test(text) || /:\/\/[^/\s"]*@/.test(text)) {
  throw new Error("the capture holds a URL with a query token or userinfo; nothing was written");
}
writeFileSync(posix.join(OUT.replaceAll("\\", "/"), "boundary.json"), text);
console.log(`wrote ${posix.join(OUT, "boundary.json")}`);
