/**
 * The Prometheus provider's agent path, driven through the real composition with only the network faked: what an
 * agent-mode handle sends (every request pinned whole: method, path, URL parameters and form body), what it refuses
 * before anything is sent, how an answer is counted against the budgets and refused rather than cut, how a failure is
 * worded, and what the other surfaces of an agent-mode handle answer.
 *
 * The structural closed table is the boundary, so the seam test below drives every read an agent-mode handle can make
 * and holds each request it sent to the provider's own table of read paths: no admin, remote-write, OTLP, lifecycle or
 * import endpoint is ever reached, and the only POST is the instant query.
 *
 * Every token and user name below is obviously fake and generated for the test.
 */
// oxlint-disable no-await-in-loop -- each read runs after the one before, on purpose: the requests are pinned in order.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  RefusedBeforeSendError,
  TimeoutError,
} from "@/lib/db/errors";
import { createDatabaseProvider } from "@/lib/db/factory";
import { PROMETHEUS_AGENT_PROJECTION } from "@/lib/db/providers/timeseries/prometheus/agent-projection";
import { PROMETHEUS_AGENT_FAILURE_SENTENCES } from "@/lib/db/providers/timeseries/prometheus/agent-read";
import { PROMETHEUS_AGENT_READS } from "@/lib/db/providers/timeseries/prometheus/agent-statement";
import { PROMETHEUS_AGENT_WITHHELD } from "@/lib/db/providers/timeseries/prometheus/agent-surface";
import type { PrometheusEndpoint } from "@/lib/db/providers/timeseries/prometheus/http-transport";
import {
  PROMETHEUS_PROVIDER_SENTENCES,
  PrometheusProvider,
  type PrometheusProviderDeps,
} from "@/lib/db/providers/timeseries/prometheus/index";
import {
  type InboundResponse,
  type OutboundRequest,
  RequestFailure,
  type SendRequest,
} from "@/lib/db/providers/timeseries/prometheus/request";
import { MATRIX_SAMPLE_BUDGET } from "@/lib/db/providers/timeseries/prometheus/results";
import type { ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import { filterByRoles } from "@/lib/seed/connection-filter";
import type { DatabaseConnection } from "@/lib/types";
import { capture } from "../../../helpers/prometheus-fixtures";

const ORIGIN = "http://prometheus.test:9090";
const TEST_ENDPOINT: PrometheusEndpoint = {
  url: (pathname, query) => {
    const url = new URL(pathname, ORIGIN);
    if (query !== undefined) url.search = query.toString();
    return url;
  },
};

const SECRET = "not-a-real-token";
const USER = "not-a-real-user";
const READ_ONLY: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const OPERATIONS: ProviderExecutionContext = { readOnly: true };
const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 3, maxResultBytes: 100_000, statementTimeoutMs: 4_000 };

/**
 * Every path the provider's transport may build, and nothing else: the closed table of `http-transport.ts`, spelled
 * out here so a path added there must be added here too, on purpose.
 */
const READ_PATHS: ReadonlySet<string> = new Set([
  "/api/v1/query",
  "/api/v1/label/__name__/values",
  "/api/v1/labels",
  "/api/v1/series",
  "/api/v1/metadata",
  "/api/v1/rules",
  "/api/v1/scrape_pools",
  "/api/v1/targets",
  "/api/v1/status/buildinfo",
  "/api/v1/status/runtimeinfo",
  "/api/v1/status/flags",
  "/api/v1/status/tsdb",
  "/-/healthy",
  "/health",
  "/-/ready",
]);

/** Paths that change a server or its process, on Prometheus and on VictoriaMetrics: never sent by Studio. */
const WRITE_PATHS: readonly string[] = [
  "/api/v1/admin/tsdb/delete_series",
  "/api/v1/admin/tsdb/clean_tombstones",
  "/api/v1/admin/tsdb/snapshot",
  "/api/v1/write",
  "/api/v1/otlp/v1/metrics",
  "/-/reload",
  "/-/quit",
  "/api/v1/import",
  "/api/v1/import/prometheus",
  "/internal/force_merge",
  "/snapshot/create",
];

const envelope = (data: unknown, extra: Record<string, unknown> = {}): InboundResponse => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ status: "success", data, ...extra }),
});

const failure = (status: number, errorType: string, error: string): InboundResponse => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ status: "error", errorType, error }),
});

const vector = (count: number, extra: Record<string, unknown> = {}): InboundResponse =>
  envelope(
    {
      resultType: "vector",
      result: Array.from({ length: count }, (_, index) => ({
        metric: { __name__: "up", instance: `host-${index}:9100` },
        value: [1790000000.5, "1"],
      })),
    },
    extra,
  );

/** A matrix of `series` series of `points` samples each, at the same instants. */
const matrix = (series: number, points: number, distinct = false): InboundResponse =>
  envelope({
    resultType: "matrix",
    result: Array.from({ length: series }, (_, index) => ({
      metric: { __name__: "up", instance: `host-${index}:9100` },
      values: Array.from({ length: points }, (_, at) => [1790000000 + at + (distinct ? index * 1000 : 0), "1"]),
    })),
  });

const TARGETS = envelope({
  activeTargets: [
    {
      discoveredLabels: {
        __address__: `${USER}:${SECRET}@localhost:9090`,
        __param_token: SECRET,
        __scheme__: "http",
        job: "studio-token",
      },
      labels: { instance: `${USER}:${SECRET}@localhost:9090`, job: "studio-token" },
      scrapePool: "studio-token",
      scrapeUrl: `http://localhost:9090/metrics?token=${SECRET}`,
      globalUrl: `http://host:9090/metrics?token=${SECRET}`,
      lastError: `Get "http://localhost:9090/metrics?token=${SECRET}": connection refused`,
      lastScrape: "2026-10-31T00:00:00Z",
      lastScrapeDuration: 0.1,
      health: "down",
      scrapeInterval: "5s",
      scrapeTimeout: "5s",
    },
  ],
  droppedTargets: [],
});

const RULES = envelope({
  groups: [
    {
      name: "studio-urls",
      file: "/etc/prometheus/rules/a.yml",
      interval: 5,
      limit: 0,
      evaluationTime: 0,
      lastEvaluation: "2026-10-31T00:00:00Z",
      rules: [
        {
          state: "firing",
          name: "StudioFiring",
          query: "vector(1)",
          duration: 0,
          keepFiringFor: 0,
          labels: { link: `http://example.invalid/x?token=${SECRET}` },
          annotations: { runbook_url: `https://${USER}:${SECRET}@runbooks.example.invalid/p?token=${SECRET}` },
          alerts: [],
          health: "ok",
          lastError: "",
          evaluationTime: 0,
          lastEvaluation: "2026-10-31T00:00:00Z",
          type: "alerting",
        },
      ],
    },
  ],
});

const replay = (name: string): InboundResponse => {
  const answer = capture(name);
  return { status: answer.status, contentType: answer.headers["content-type"] ?? null, body: answer.text };
};

/** The answer to every path an agent-mode handle reads, from captures or from the fake answers above. */
const BY_PATH: Readonly<Record<string, () => InboundResponse>> = {
  "/api/v1/status/buildinfo": () => replay("buildinfo"),
  "/api/v1/status/runtimeinfo": () => replay("runtimeinfo"),
  "/api/v1/status/flags": () => replay("flags"),
  "/api/v1/status/tsdb": () => replay("tsdb-status-10000"),
  "/api/v1/query": () => replay("query-vector"),
  "/api/v1/label/__name__/values": () => replay("label-values-names"),
  "/api/v1/labels": () => replay("labels-one-metric"),
  "/api/v1/series": () => replay("series-all"),
  "/api/v1/metadata": () => replay("metadata-exact"),
  "/api/v1/rules": () => RULES,
  "/api/v1/scrape_pools": () => envelope({ scrapePools: ["studio-token"] }),
  "/api/v1/targets": () => TARGETS,
  "/-/healthy": () => replay("health-healthy"),
  "/-/ready": () => replay("health-ready"),
};

interface Sent {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

let sent: Sent[] = [];
let queryAnswer: (request: OutboundRequest) => Promise<InboundResponse> = () => Promise.resolve(vector(1));

const send: SendRequest = (request) => {
  sent.push({
    method: request.method,
    pathname: request.url.pathname,
    search: request.url.search,
    headers: { ...request.headers },
    body: request.body,
  });
  if (request.url.pathname === "/api/v1/query") return queryAnswer(request);
  const answer = BY_PATH[request.url.pathname];
  if (answer === undefined) return Promise.reject(new Error(`no answer for ${request.method} ${request.url.pathname}`));
  return Promise.resolve(answer());
};

const connection = (overrides: Partial<DatabaseConnection> = {}): DatabaseConnection => ({
  id: "prometheus-agent",
  name: "Prometheus agent",
  type: "prometheus",
  host: "prometheus.test",
  port: 9090,
  createdAt: new Date(0),
  ...overrides,
});

const deps = (): PrometheusProviderDeps => ({ endpoint: () => TEST_ENDPOINT, send, now: () => 1790000000000 });

async function agentProvider(
  execution: ProviderExecutionContext = READ_ONLY,
  overrides: Partial<DatabaseConnection> = {},
): Promise<PrometheusProvider> {
  const provider = new PrometheusProvider(connection(overrides), {}, execution, deps());
  await provider.connect();
  sent = [];
  return provider;
}

/** A rejection as a value, awaited before it is matched. */
async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  sent = [];
  queryAnswer = () => Promise.resolve(vector(1));
});

afterEach(() => {
  sent = [];
});

describe("which handle answers queryReadOnly", () => {
  test("an editor handle refuses it before anything is sent, connected or not", async () => {
    const editor = new PrometheusProvider(connection(), {}, {}, deps());
    let error = await failureOf(editor.queryReadOnly("up", BUDGET));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect(error.message).toBe(PROMETHEUS_PROVIDER_SENTENCES.profileRequired);
    await editor.connect();
    sent = [];
    error = await failureOf(editor.queryReadOnly("up", BUDGET));
    expect(error.message).toBe(PROMETHEUS_PROVIDER_SENTENCES.profileRequired);
    expect(sent).toEqual([]);
  });

  test("an operations handle, which sends no statement, refuses it too", async () => {
    const provider = await agentProvider(OPERATIONS);
    const error = await failureOf(provider.queryReadOnly("up", BUDGET));
    expect(error.message).toBe(PROMETHEUS_PROVIDER_SENTENCES.profileRequired);
    expect(sent).toEqual([]);
  });

  test("the factory hands the execution context to the provider", async () => {
    const agent = await createDatabaseProvider(connection(), {}, READ_ONLY);
    const refusal = await failureOf(agent.queryReadOnly!("up", BUDGET));
    // Opened under the profile, so the refusal is the connection's, not the profile's.
    expect(refusal).toBeInstanceOf(DatabaseConfigError);
    const editor = await createDatabaseProvider(connection());
    expect((await failureOf(editor.queryReadOnly!("up", BUDGET))).message).toBe(
      PROMETHEUS_PROVIDER_SENTENCES.profileRequired,
    );
  });

  test("a seeded connection keeps every field the agent path reads, and opens and reads on it", async () => {
    const [seeded] = filterByRoles(
      [
        {
          id: "prom",
          name: "Seeded Prometheus",
          type: "prometheus",
          host: "prometheus.test",
          port: 9090,
          user: "reader",
          password: "not-a-real-password",
          roles: ["*"],
        },
      ],
      ["user"],
    );
    const provider = new PrometheusProvider({ ...seeded, createdAt: new Date(0) }, {}, READ_ONLY, deps());
    await provider.connect();
    sent = [];
    expect((await provider.queryReadOnly("up", BUDGET)).rowCount).toBe(1);
    expect(sent[0].headers.authorization).toBe(`Basic ${Buffer.from("reader:not-a-real-password").toString("base64")}`);
  });

  test("a plan estimate is refused before anything is sent", async () => {
    const provider = await agentProvider();
    const error = await failureOf(provider.queryReadOnly("up", BUDGET, "estimate-plan"));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect(error.message).toBe(PROMETHEUS_PROVIDER_SENTENCES.noEstimate);
    expect(sent).toEqual([]);
  });

  test("a budget that is not one is refused before anything is sent", async () => {
    const provider = await agentProvider();
    await failureOf(provider.queryReadOnly("up", { ...BUDGET, maxResultRows: 0 }));
    expect(sent).toEqual([]);
  });
});

describe("the request an agent read sends", () => {
  test("is the console's instant query, pinned whole", async () => {
    const provider = await agentProvider(READ_ONLY, { user: "reader", password: "not-a-real-password" });
    const result = await provider.queryReadOnly('sum by (job) (up{job="prometheus"})  # why', BUDGET);
    expect(result.rowCount).toBe(1);
    expect(sent).toEqual([
      {
        method: "POST",
        pathname: "/api/v1/query",
        search: "",
        headers: {
          accept: "application/json",
          authorization: `Basic ${Buffer.from("reader:not-a-real-password").toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams([
          ["query", 'sum by (job) (up{job="prometheus"})  # why'],
          ["timeout", "4"],
          ["limit", "4"],
        ]).toString(),
      },
    ]);
  });

  test("carries the time budget as the server's time-out and one series past the row budget as its limit", async () => {
    const provider = await agentProvider();
    await provider.queryReadOnly("up", { maxResultRows: 7, maxResultBytes: 100_000, statementTimeoutMs: 1500 });
    const form = new URLSearchParams(sent[0].body);
    expect([...form.keys()]).toEqual(["query", "timeout", "limit"]);
    expect(form.get("timeout")).toBe("1.5");
    expect(form.get("limit")).toBe("8");
  });

  test("a parameter written into the expression never becomes one: it is refused before anything is sent", async () => {
    const provider = await agentProvider();
    for (const text of ["up&time=0", "up&start=0&end=9999999999&step=1", '{"query":"up","time":0}', "up[$__range]"]) {
      const error = await failureOf(provider.queryReadOnly(text, BUDGET));
      expect(error).toBeInstanceOf(RefusedBeforeSendError);
      expect(error.message).toContain(PROMETHEUS_AGENT_READS);
    }
    expect(sent).toEqual([]);
  });

  test("nothing of one read is kept for the next", async () => {
    const provider = await agentProvider();
    await provider.queryReadOnly("up", BUDGET);
    await provider.queryReadOnly("count(up)", { ...BUDGET, statementTimeoutMs: 2000 });
    expect(sent.map((request) => request.body)).toEqual([
      "query=up&timeout=4&limit=4",
      "query=count%28up%29&timeout=2&limit=4",
    ]);
  });
});

describe("how an answer counts against the row budget", () => {
  test("a vector counts one row per series: the budget itself is answered, one past it is refused", async () => {
    const provider = await agentProvider();
    queryAnswer = () => Promise.resolve(vector(3));
    expect((await provider.queryReadOnly("up", BUDGET)).rowCount).toBe(3);
    queryAnswer = () => Promise.resolve(vector(4));
    const error = await failureOf(provider.queryReadOnly("up", BUDGET));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe("Read-only execution exceeded the row budget: 4 rows > 3 allowed");
  });

  test("a server that cut its answer at the limit is refused, never shown in part", async () => {
    const provider = await agentProvider();
    queryAnswer = () => Promise.resolve(vector(2, { warnings: ["results truncated due to limit"] }));
    const error = await failureOf(provider.queryReadOnly("up", BUDGET));
    expect(error.message).toBe("Read-only execution exceeded the row budget: 4 rows > 3 allowed");
  });

  test("a matrix counts every sample of every series", async () => {
    const provider = await agentProvider();
    queryAnswer = () => Promise.resolve(matrix(1, 3));
    expect((await provider.queryReadOnly("up[1m]", BUDGET)).rows).toHaveLength(3);
    queryAnswer = () => Promise.resolve(matrix(2, 2));
    const error = await failureOf(provider.queryReadOnly("up[1m]", BUDGET));
    expect(error.message).toBe("Read-only execution exceeded the row budget: 4 rows > 3 allowed");
  });

  test("a scalar and a string count one", async () => {
    const provider = await agentProvider();
    queryAnswer = () => Promise.resolve(replay("query-scalar"));
    expect((await provider.queryReadOnly("scalar(count(up))", BUDGET)).rowCount).toBe(1);
    queryAnswer = () => Promise.resolve(replay("query-string"));
    expect((await provider.queryReadOnly('"studio"', BUDGET)).rowCount).toBe(1);
  });

  test("a matrix the console's grid would cut is refused", async () => {
    const provider = await agentProvider();
    const rows = 600;
    queryAnswer = () => Promise.resolve(matrix(rows, 1, true));
    const error = await failureOf(
      provider.queryReadOnly("up[1m]", { maxResultRows: rows, maxResultBytes: 50_000_000, statementTimeoutMs: 4000 }),
    );
    expect(error.message).toBe(PROMETHEUS_AGENT_FAILURE_SENTENCES.grid(MATRIX_SAMPLE_BUDGET));
  });

  test("past the byte budget is refused, and the budget itself is answered", async () => {
    const provider = await agentProvider();
    queryAnswer = () => Promise.resolve(vector(1));
    const bytes = JSON.stringify((await provider.queryReadOnly("up", BUDGET)).rows).length;
    expect((await provider.queryReadOnly("up", { ...BUDGET, maxResultBytes: bytes })).rowCount).toBe(1);
    const error = await failureOf(provider.queryReadOnly("up", { ...BUDGET, maxResultBytes: bytes - 1 }));
    expect(error.message).toBe(`Read-only execution exceeded the byte budget: ${bytes} bytes > ${bytes - 1} allowed`);
  });

  test("the engine's notices travel with the rows, verbatim", async () => {
    const provider = await agentProvider();
    queryAnswer = () => Promise.resolve(replay("query-info-notice"));
    const result = await provider.queryReadOnly("rate(go_goroutines[1m])", BUDGET);
    expect(result.warnings?.map((warning) => warning.message)).toEqual([
      'PromQL info: metric might not be a counter, name does not end in _total/_sum/_count/_bucket: "go_goroutines" (1:6)',
    ]);
  });
});

describe("how a failure is worded", () => {
  test("a server time-out by its category with the time budget, never the server's text", async () => {
    const provider = await agentProvider();
    queryAnswer = () => Promise.resolve(replay("error-timeout"));
    const error = await failureOf(provider.queryReadOnly("count_over_time(up[1h:1ms])", BUDGET));
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe(PROMETHEUS_AGENT_FAILURE_SENTENCES.serverTimeout(4000));
    expect(error.message).not.toContain("query timed out");
  });

  test("the server's own sample limit by its category, never the server's text", async () => {
    const provider = await agentProvider();
    queryAnswer = () =>
      Promise.resolve(
        failure(422, "execution", "query processing would load too many samples into memory in query execution"),
      );
    const error = await failureOf(provider.queryReadOnly("up[30d]", BUDGET));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(PROMETHEUS_AGENT_FAILURE_SENTENCES.execution(4000));
    expect(error.message).not.toContain("too many samples");
  });

  test("VictoriaMetrics' numbered categories read as the ones Prometheus names: its points limit never in its own text", async () => {
    const provider = await agentProvider();
    queryAnswer = () => Promise.resolve(failure(422, "422", "too many points for the given start and step"));
    const limit = await failureOf(provider.queryReadOnly("up[1h:1s]", BUDGET));
    expect(limit.message).toBe(PROMETHEUS_AGENT_FAILURE_SENTENCES.execution(4000));
    queryAnswer = () => Promise.resolve(failure(400, "400", 'error when executing query="sum(up) by"'));
    const parse = await failureOf(provider.queryReadOnly("sum(up) by", BUDGET));
    expect(parse.message).toBe(
      'The server could not parse the expression (category bad_data): error when executing query="sum(up) by"',
    );
  });

  test("a parse error keeps the server's sentence about the expression", async () => {
    const provider = await agentProvider();
    queryAnswer = () => Promise.resolve(replay("error-bad-data"));
    const error = await failureOf(provider.queryReadOnly("sum(up) by", BUDGET));
    expect(error.message).toStartWith("The server could not parse the expression (category bad_data): ");
    expect(error.message).toContain("parse error");
  });

  test("Studio's own deadline as Studio's, from the ask", async () => {
    const provider = await agentProvider();
    queryAnswer = (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(new RequestFailure("deadline", "The request did not finish within its time limit")),
          { once: true },
        );
      });
    const pending = failureOf(provider.queryReadOnly("up", { ...BUDGET, statementTimeoutMs: 30 }));
    const error = await pending;
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe(PROMETHEUS_AGENT_FAILURE_SENTENCES.deadline(30));
  });

  test("a wait for a query slot past the time budget as Studio's", async () => {
    const provider = await agentProvider();
    const releases: Array<() => void> = [];
    queryAnswer = () => new Promise((resolve) => releases.push(() => resolve(vector(1))));
    const long = { ...BUDGET, statementTimeoutMs: 60_000 };
    const holders = Array.from({ length: 4 }, () => provider.queryReadOnly("up", long));
    const waiting = failureOf(provider.queryReadOnly("count(up)", { ...BUDGET, statementTimeoutMs: 40 }));
    const error = await waiting;
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe(PROMETHEUS_AGENT_FAILURE_SENTENCES.deadline(40));
    expect(sent.filter((request) => request.body?.startsWith("query=count")).length).toBe(0);
    for (const release of releases) release();
    await Promise.all(holders);
  });

  test("an answer past the response cap as Studio's", async () => {
    const provider = await agentProvider();
    queryAnswer = () => Promise.reject(new RequestFailure("too_large", "too large", { limitBytes: 1234 }));
    const error = await failureOf(provider.queryReadOnly("up", BUDGET));
    expect(error.message).toBe(PROMETHEUS_AGENT_FAILURE_SENTENCES.tooLarge(1234));
    queryAnswer = () => Promise.reject(new RequestFailure("too_large", "too large"));
    expect((await failureOf(provider.queryReadOnly("up", BUDGET))).message).toContain("33554432 bytes");
  });

  test("every other failure keeps the provider's own classification", async () => {
    const provider = await agentProvider();
    queryAnswer = () => Promise.reject(new RequestFailure("network", "The server could not be reached"));
    expect(await failureOf(provider.queryReadOnly("up", BUDGET))).toBeInstanceOf(ConnectionError);
    queryAnswer = () => Promise.resolve(failure(503, "unavailable", "busy"));
    expect(await failureOf(provider.queryReadOnly("up", BUDGET))).toBeInstanceOf(ConnectionError);
  });

  test("a disconnect ends a read in flight as a cancellation", async () => {
    const provider = await agentProvider();
    queryAnswer = (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new RequestFailure("aborted", "cancelled")), {
          once: true,
        });
      });
    const pending = failureOf(provider.queryReadOnly("up", BUDGET));
    while (sent.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    await provider.disconnect();
    expect(await pending).toBeInstanceOf(QueryCancelledError);
  });
});

describe("the other surfaces of an agent-mode handle", () => {
  for (const [name, execution] of [
    ["read-only", READ_ONLY],
    ["operations", OPERATIONS],
  ] as const) {
    test(`the console is refused on a ${name} handle before anything is sent`, async () => {
      const provider = await agentProvider(execution);
      const error = await failureOf(provider.query("up"));
      expect(error).toBeInstanceOf(RefusedBeforeSendError);
      expect(error.message).toBe(PROMETHEUS_AGENT_WITHHELD.query);
      expect(sent).toEqual([]);
    });

    test(`readings the agent does not take answer their reason on a ${name} handle`, async () => {
      const provider = await agentProvider(execution);
      for (const [reading, sentence] of [
        [() => provider.getOverview(), PROMETHEUS_AGENT_WITHHELD.overview],
        [() => provider.getPerformanceMetrics(), PROMETHEUS_AGENT_WITHHELD.performance],
        [() => provider.getSlowQueries(), PROMETHEUS_AGENT_WITHHELD.slowQueries],
        [() => provider.getActiveSessions(), PROMETHEUS_AGENT_WITHHELD.sessions],
        [() => provider.getIndexStats(), PROMETHEUS_AGENT_WITHHELD.indexStats],
      ] as const) {
        let error: unknown;
        try {
          await reading();
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(QueryError);
        expect((error as Error).message).toBe(sentence);
      }
      expect(sent).toEqual([]);
    });
  }

  test("a withheld reading on a handle that is not open says so first", async () => {
    const provider = new PrometheusProvider(connection(), {}, READ_ONLY, deps());
    expect(await failureOf(provider.getOverview())).toBeInstanceOf(DatabaseConfigError);
  });

  test("health, storage and table readings are the server's, and never read the flags", async () => {
    const provider = await agentProvider(OPERATIONS);
    expect((await provider.getHealth()).activeConnections).toBeUndefined();
    expect((await provider.getStorageStats()).length).toBeGreaterThan(0);
    expect((await provider.getTableStats()).length).toBeGreaterThan(0);
    expect(sent.some((request) => request.pathname.endsWith("/flags"))).toBe(false);
  });

  test("the object tree names every target and rule by its projected answer, nothing withheld even as a digest", async () => {
    const provider = await agentProvider(OPERATIONS);
    const targets = await provider.listObjects([], "target");
    const rules = await provider.listObjects([], "alerting_rule");
    const detail = await provider.describeObject([...targets[0].path], "target");
    const source = await provider.readObjectSource([...targets[0].path], "target");
    const ruleSource = await provider.readObjectSource([...rules[0].path], "alerting_rule");
    const text = JSON.stringify({ targets, rules, detail, source, ruleSource });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(USER);
    expect(targets[0].name).toBe(`localhost:9090 ${PROMETHEUS_AGENT_PROJECTION.mark} (studio-token)`);
    expect(targets[0].path.at(-1)).toStartWith(`http://localhost:9090/metrics ${PROMETHEUS_AGENT_PROJECTION.mark} `);
  });

  test("an editor handle keeps every answer as the server gave it", async () => {
    const provider = new PrometheusProvider(connection(), {}, {}, deps());
    await provider.connect();
    const targets = await provider.listObjects([], "target");
    expect(targets[0].name).toBe(`${USER}:${SECRET}@localhost:9090 (studio-token)`);
    expect(targets[0].path.at(-1)).toStartWith(`http://localhost:9090/metrics?token=${SECRET} `);
    expect((await provider.query("up")).rowCount).toBeGreaterThan(0);
  });
});

describe("the structural closed table", () => {
  test("every request an agent-mode handle sends is a read path of the table, and only the query is a POST", async () => {
    const all: Sent[] = [];
    for (const execution of [READ_ONLY, OPERATIONS]) {
      const provider = new PrometheusProvider(connection(), {}, execution, deps());
      await provider.connect();
      if (execution === READ_ONLY) {
        await provider.queryReadOnly("up", BUDGET);
        await failureOf(provider.queryReadOnly("up&time=0", BUDGET));
      }
      await provider.getHealth();
      await provider.getStorageStats();
      await provider.getTableStats();
      await failureOf(provider.getOverview());
      await provider.countObjects([]);
      for (const kind of ["metric", "rule_group", "scrape_pool"]) await provider.listObjects([], kind);
      await provider.listObjects([], "target");
      await provider.listObjects([], "alerting_rule");
      await provider.describeObjects([], "metric", 2);
      await provider.describeObject(["up"], "metric");
      await provider.readObjectSource(["up"], "metric");
      all.push(...sent);
      sent = [];
      await provider.disconnect();
    }
    expect(all.length).toBeGreaterThan(10);
    for (const request of all) {
      expect(READ_PATHS.has(request.pathname)).toBe(true);
      expect(WRITE_PATHS).not.toContain(request.pathname);
      expect(request.method).toBe(request.pathname === "/api/v1/query" ? "POST" : "GET");
      if (request.method === "GET") expect(request.body).toBeUndefined();
    }
    // The flags are on the table for the editor's overview, and an agent-mode handle never asks for them.
    expect(all.some((request) => request.pathname === "/api/v1/status/flags")).toBe(false);
    // Every POST is the form the console writes: the expression, the time-out and the limit, nothing else.
    for (const request of all.filter((entry) => entry.method === "POST")) {
      expect([...new URLSearchParams(request.body).keys()]).toEqual(["query", "timeout", "limit"]);
      expect(request.search).toBe("");
    }
  });
});
