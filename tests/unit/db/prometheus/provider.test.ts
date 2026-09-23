/**
 * PrometheusProvider: lifecycle and composition (#1085 sections 3.5, 5.1, 5.2 and 6.1 to 6.3).
 *
 * The provider holds no wire format, no result shaping and no error table, so what this file tests
 * is the composition: which transport a connection gets, what reaches it, what comes back, and which
 * module answers each surface. Everything below the provider is the REAL module - the HTTP
 * transport, the result shaper, the error mapping and the query slots - and only the network is
 * fake: `send` is a `SendRequest` answering from the payloads captured from a live Prometheus 3.13.3,
 * read through the one fixture reader (`tests/helpers/prometheus-fixtures.ts`), with the edge cases
 * built inline and said so where they are. The endpoint is a test `PrometheusEndpoint` and the clock
 * is fixed, both injected through `PrometheusProviderDeps`, except where a test proves a default.
 * Two tests replace `globalThis.fetch`, to prove that the default `send` reads it and that the
 * default endpoint builds each URL from the connection, and `afterEach` restores it.
 *
 * The TLS tests inject nothing, because the request function a TLS panel gets, and the material it
 * is built with, are decided in `connect()` and nowhere else. They connect to real `node:https`
 * servers on the loopback interface, built from the throwaway certificates of tests/fixtures/tls/,
 * and they too replace `globalThis.fetch`, with one that records being reached, so a TLS connection
 * that fell back to it is seen. Three more globals are replaced only inside the one test that reads
 * each, and restored in `finally`: `Date.now`, for the default inventory window;
 * `AbortSignal.timeout`, for the deadline each request is armed with; and `performance.now`, the
 * clock a query's execution time is read from. No `mock.module()`: it is process-wide in bun.
 */
import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
  type ServerOptions as HttpsServerOptions,
} from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
} from "@/lib/db/errors";
import { QUERY_CONCURRENCY_LIMIT } from "@/lib/db/providers/timeseries/prometheus/concurrency";
import {
  createHttpTransport,
  type PrometheusEndpoint,
  RESPONSE_BYTE_CAP,
} from "@/lib/db/providers/timeseries/prometheus/http-transport";
import { PrometheusProvider, type PrometheusProviderDeps } from "@/lib/db/providers/timeseries/prometheus/index";
import {
  PROMETHEUS_SCHEMA_NAME,
  readHealth,
  readOverview,
  readStorageStats,
  readTableStats,
} from "@/lib/db/providers/timeseries/prometheus/monitoring";
import {
  INVENTORY_WINDOW_MS,
  METRIC_LIST_CAP,
  PROMETHEUS_OBJECT_KINDS,
  PrometheusObjects,
} from "@/lib/db/providers/timeseries/prometheus/objects";
import { metricSelector } from "@/lib/db/providers/timeseries/prometheus/promql";
import {
  type InboundResponse,
  type OutboundRequest,
  RequestFailure,
  type SendRequest,
} from "@/lib/db/providers/timeseries/prometheus/request";
import {
  MATRIX_SAMPLE_BUDGET,
  RESULT_BYTE_BUDGET,
  shapeQueryResult,
} from "@/lib/db/providers/timeseries/prometheus/results";
import { type PrometheusTransport, PrometheusTransportError } from "@/lib/db/providers/timeseries/prometheus/transport";
import {
  type Container,
  DEFAULT_QUERY_TIMEOUT,
  type DatabaseObject,
  type DatabaseProvider,
  type KindCount,
  type ObjectDetail,
  type ObjectDetailBatch,
  type ObjectSourceDocument,
  type ProviderOptions,
} from "@/lib/db/types";
import { formatDuration } from "@/lib/db/utils/pool-manager";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { generateSelectQuery } from "@/lib/query-generators";
import type { ColumnSchema, DatabaseConnection, SSLConfig } from "@/lib/types";
import { capture, captureBody } from "../../../helpers/prometheus-fixtures";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";

// ============================================================================
// The fake network, answering from what a live server answered
// ============================================================================

/**
 * A capture handed back as `request.ts` hands an answer to the transport: the server's own bytes
 * (`text`, never the decoded `body`), with the status and the content type it sent. The reader
 * leaves out `content-length` and `content-encoding`, which describe the wire rather than the body.
 */
const replay = (name: string): InboundResponse => {
  const answer = capture(name);
  return { status: answer.status, contentType: answer.headers["content-type"] ?? null, body: answer.text };
};

/**
 * The fixed clock: ninety minutes after the captured server started, a moment that server could
 * have been asked at. The inventory window is read against it, so nothing depends on the machine's
 * own clock. The uptime does not read it: the server reports its own `serverTime` beside
 * `startTime`, and the uptime is the difference between the two.
 */
const NOW_MS = Date.parse(captureBody<{ data: { startTime: string } }>("runtimeinfo").data.startTime) + 90 * 60_000;
const ORIGIN = "http://prometheus.test:9090";

const TEST_ENDPOINT: PrometheusEndpoint = {
  url: (pathname, query) => {
    const url = new URL(pathname, ORIGIN);
    if (query !== undefined) url.search = query.toString();
    return url;
  },
};

/** An answer built inline, for an edge no capture holds; each use says which edge. */
const json = (body: string, status = 200): InboundResponse => ({ status, contentType: "application/json", body });

/** The capture that answers each endpoint the provider's own methods reach, by path. */
const CAPTURED: Readonly<Record<string, string>> = {
  "/api/v1/status/buildinfo": "buildinfo",
  "/api/v1/status/runtimeinfo": "runtimeinfo",
  "/api/v1/status/flags": "flags",
  // Every TSDB read is answered with the capture taken at `limit=10000`, whose lists are complete:
  // it holds whatever a smaller `limit` would, and each check below compares the provider with the
  // monitoring module over the same answer.
  "/api/v1/status/tsdb": "tsdb-status-10000",
  // `query=up`: one series per scraped target.
  "/api/v1/query": "query-vector",
  "/-/healthy": "health-healthy",
  "/-/ready": "health-ready",
};

const captured: SendRequest = async (request) => {
  const name = CAPTURED[request.url.pathname];
  if (name === undefined) throw new Error(`no captured answer for ${request.method} ${request.url.pathname}`);
  return replay(name);
};

interface SentRequest {
  readonly method: string;
  readonly pathname: string;
  /** The URL's own parameters: where every read that is not a query carries them. */
  readonly search: URLSearchParams;
  readonly headers: Readonly<Record<string, string>>;
  /** The form body a query carries, decoded; null on a request with no body. */
  readonly form: URLSearchParams | null;
  /** The most bytes its answer may hold, which `request.ts` enforces as the body streams (#1085 S5). */
  readonly maxBytes: number;
  /** What it aborts on: its own deadline, and for a query the query's signal beside it. */
  readonly signal: AbortSignal;
}

let sent: SentRequest[] = [];
let respond: SendRequest = captured;

/** The network: records what left the process, then answers through `respond`. */
const send: SendRequest = (request) => {
  sent.push({
    method: request.method,
    pathname: request.url.pathname,
    search: request.url.searchParams,
    headers: request.headers,
    form: request.body === undefined ? null : new URLSearchParams(request.body),
    maxBytes: request.maxBytes,
    signal: request.signal,
  });
  return respond(request);
};

const queries = (): SentRequest[] => sent.filter((request) => request.pathname === "/api/v1/query");

const authorizationOf = (request: SentRequest): string | undefined =>
  Object.entries(request.headers).find(([name]) => name.toLowerCase() === "authorization")?.[1];

/** A query request the test answers later, or that ends the way `request.ts` ends an aborted one. */
interface Held {
  readonly request: OutboundRequest;
  release(): void;
}

let held: Held[] = [];

/** What `request.ts` reports for an aborted signal: its own deadline, or the caller's cancel. */
const abortReason = (signal: AbortSignal): "deadline" | "aborted" =>
  (signal.reason as { readonly name?: unknown } | undefined)?.name === "TimeoutError" ? "deadline" : "aborted";

/** Holds every query until the test releases it; every other endpoint answers as captured. */
const holdQueries: SendRequest = (request) => {
  if (request.url.pathname !== "/api/v1/query") return captured(request);
  return new Promise<InboundResponse>((resolve, reject) => {
    const aborted = () => reject(new RequestFailure(abortReason(request.signal), "The request was aborted"));
    if (request.signal.aborted) {
      aborted();
      return;
    }
    request.signal.addEventListener("abort", aborted, { once: true });
    held.push({ request, release: () => resolve(replay("query-vector")) });
  });
};

const heldQueryText = (slot: Held): string | null => new URLSearchParams(slot.request.body ?? "").get("query");

// ============================================================================
// Helpers
// ============================================================================

/** One turn of the event loop, after every promise already queued has run. */
const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Runs turns until `ready()` holds, and fails naming what never happened. */
async function until(ready: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (ready()) return;
    await turn();
  }
  throw new Error(`never happened: ${what}`);
}

/** Gives anything that could still happen the turns to happen in, before an absence is asserted. */
async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) await turn();
}

/** A promise's settlement as a value, so a rejection that arrives while the test is busy is never unhandled. */
function outcomeOf<T>(promise: Promise<T>): Promise<{ readonly value?: T; readonly error?: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

const UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/**
 * The `timeout` parameter as the server reads it, in milliseconds: `parseDuration` in
 * `web/api/v1/api.go` (v3.13.3) takes a bare number as seconds first, then a duration such as
 * `1234ms`, `1.234s` or `1s234ms`. Either spelling the transport chooses is read the same way.
 */
function durationMs(value: string | null | undefined): number {
  const written = value ?? "";
  if (/^\d+(?:\.\d+)?$/.test(written)) return Math.round(Number(written) * 1000);
  const parts = [...written.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== written) {
    throw new Error(`not a timeout the server reads: ${String(value)}`);
  }
  return Math.round(parts.reduce((total, [, amount, unit]) => total + Number(amount) * UNIT_MS[unit], 0));
}

const connection = (overrides: Partial<DatabaseConnection> = {}): DatabaseConnection => ({
  id: "prometheus-test",
  name: "Prometheus test",
  type: "prometheus",
  host: "prometheus.test",
  port: 9090,
  createdAt: new Date(0),
  ...overrides,
});

const deps = (): PrometheusProviderDeps => ({ endpoint: () => TEST_ENDPOINT, send, now: () => NOW_MS });

/** A provider past `connect()`, with the connect request cleared from the record. */
async function connectedProvider(
  overrides: Partial<DatabaseConnection> = {},
  options: ProviderOptions = {},
): Promise<PrometheusProvider> {
  const provider = new PrometheusProvider(connection(overrides), options, deps());
  await provider.connect();
  sent = [];
  return provider;
}

/** The transport the provider builds, over the same network, for the delegation checks. */
const directTransport = (): PrometheusTransport =>
  createHttpTransport(
    {},
    { send, endpoint: TEST_ENDPOINT, requestTimeoutMs: DEFAULT_QUERY_TIMEOUT, maxResponseBytes: RESPONSE_BYTE_CAP },
  );

const SHAPE = { seriesLimit: DEFAULT_QUERY_LIMIT, sampleBudget: MATRIX_SAMPLE_BUDGET, byteBudget: RESULT_BYTE_BUDGET };
const DIRECT_QUERY = { timeoutMs: DEFAULT_QUERY_TIMEOUT, seriesLimit: DEFAULT_QUERY_LIMIT };

const originalFetch = globalThis.fetch;
let errorSpy: Mock<typeof console.error>;

beforeEach(() => {
  sent = [];
  held = [];
  respond = captured;
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  errorSpy.mockRestore();
});

// ============================================================================
// connect()
// ============================================================================

describe("connect", () => {
  test("with no endpoint injected, the shared endpoint module addresses the connection's host and port", async () => {
    const fetched: string[] = [];
    const buildinfo = capture("buildinfo");
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetched.push(String(input));
      return new Response(buildinfo.text, { status: buildinfo.status, headers: buildinfo.headers });
    }) as typeof fetch;

    // Neither `endpoint` nor `send` is injected: the composition every real connection gets (#1086).
    const provider = new PrometheusProvider(connection(), {}, { now: () => NOW_MS });
    await provider.connect();
    // The control: the port is the connection's own, not a constant the adapter writes.
    await new PrometheusProvider(connection({ port: 9091 }), {}, { now: () => NOW_MS }).connect();

    expect(provider.isConnected()).toBe(true);
    expect(fetched).toEqual([
      "http://prometheus.test:9090/api/v1/status/buildinfo",
      "http://prometheus.test:9091/api/v1/status/buildinfo",
    ]);
  });

  test("asks the endpoint port with the connection and whether it is TLS", async () => {
    const asked: { readonly host: string | undefined; readonly secure: boolean }[] = [];
    const endpoint = (config: DatabaseConnection, secure: boolean): PrometheusEndpoint => {
      asked.push({ host: config.host, secure });
      return TEST_ENDPOINT;
    };

    for (const ssl of [undefined, { mode: "disable" as const }, { mode: "require" as const }]) {
      await new PrometheusProvider(connection({ ssl }), {}, { endpoint, send, now: () => NOW_MS }).connect();
    }

    expect(asked).toEqual([
      { host: "prometheus.test", secure: false },
      { host: "prometheus.test", secure: false },
      { host: "prometheus.test", secure: true },
    ]);
  });

  test("hands the connection's user and password to the transport as its Basic credential", async () => {
    await new PrometheusProvider(connection({ user: "reader", password: "secret" }), {}, deps()).connect();
    expect(authorizationOf(sent[0])).toBe(`Basic ${Buffer.from("reader:secret").toString("base64")}`);

    // The control: a connection with neither sends no credential at all.
    sent = [];
    await new PrometheusProvider(connection(), {}, deps()).connect();
    expect(authorizationOf(sent[0])).toBeUndefined();
  });

  const LINE_FEED_CREDENTIALS: [string, { user?: string; password: string }][] = [
    ["the password of a Basic credential", { user: "reader", password: "abc\n" }],
    ["a bearer token", { password: "abc\n" }],
  ];

  test.each(LINE_FEED_CREDENTIALS)(
    "a line feed in %s is refused before any request, and neither the error nor the log carries it (#1085 S3)",
    async (_where, credential) => {
      const provider = new PrometheusProvider(connection(credential), {}, deps());

      const failure = await provider.connect().then(
        () => new Error("connect resolved with a line feed in the credential"),
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(DatabaseConfigError);
      expect(sent).toEqual([]);
      const logged = errorSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
      const basic = Buffer.from(`${credential.user ?? ""}:${credential.password}`).toString("base64");
      for (const surface of [(failure as Error).message, logged]) {
        expect(surface).not.toContain("abc");
        expect(surface).not.toContain(basic);
      }
      // The control: the refusal WAS logged, so the absence above is about what the line says.
      expect(logged).toContain("[DB:prometheus] connect failed:");
    },
  );

  test("an unreachable server is a ConnectionError, logged, and the provider stays disconnected", async () => {
    respond = () => Promise.reject(new RequestFailure("network", "connect ECONNREFUSED 127.0.0.1:9090"));
    const provider = new PrometheusProvider(connection(), {}, deps());

    await expect(provider.connect()).rejects.toBeInstanceOf(ConnectionError);
    expect(provider.isConnected()).toBe(false);
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain("[DB:prometheus] connect failed:");
  });

  test("a 401 with no envelope in front of the API is an AuthenticationError", async () => {
    // What the basic-auth `prometheus-auth` service answered a request with no credential (M5): a
    // plain-text 401, and no envelope.
    respond = async () => replay("auth-no-credentials");

    await expect(new PrometheusProvider(connection(), {}, deps()).connect()).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  test("with no send injected, a plaintext connection sends through the global fetch", async () => {
    const fetched: string[] = [];
    const buildinfo = capture("buildinfo");
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetched.push(String(input));
      return new Response(buildinfo.text, { status: buildinfo.status, headers: buildinfo.headers });
    }) as typeof fetch;
    const provider = new PrometheusProvider(connection(), {}, { endpoint: () => TEST_ENDPOINT, now: () => NOW_MS });

    await provider.connect();

    expect(fetched).toEqual([`${ORIGIN}/api/v1/status/buildinfo`]);
    expect(provider.isConnected()).toBe(true);
  });
});

// ============================================================================
// connect() over TLS, with nothing injected (#1085 S8)
// ============================================================================

describe("connect over TLS, through the request function a real connection gets (#1085 S8)", () => {
  const TLS = loadTlsFixtures();

  /** One request a test server received, and whether the client presented a certificate it verified. */
  interface Hit {
    readonly url: string | undefined;
    readonly authorized: boolean;
  }

  const servers: HttpsServer[] = [];
  let fetched: string[] = [];

  beforeEach(() => {
    // A TLS panel is sent through node:https, never through the global fetch, so the fetch is
    // replaced by one that records being reached and refuses: a connection that fell back to it
    // is seen here, whatever the runtime's own fetch would have answered.
    fetched = [];
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      fetched.push(String(input));
      throw new Error("a TLS connection reached the global fetch");
    }) as typeof fetch;
  });

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => {
        server.closeAllConnections();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );
  });

  /**
   * A `node:https` server on 127.0.0.1 with the test CA's certificate, which names that address,
   * answering every request with the captured build info, the one read `connect()` makes.
   */
  async function serveTls(options: HttpsServerOptions = {}): Promise<{ port: number; received: Hit[] }> {
    const received: Hit[] = [];
    const buildinfo = capture("buildinfo");
    const server = createHttpsServer({ cert: TLS.server.cert, key: TLS.server.key, ...options }, (request, reply) => {
      received.push({ url: request.url, authorized: (request.socket as TLSSocket).authorized });
      request.resume();
      reply.writeHead(buildinfo.status, buildinfo.headers);
      reply.end(buildinfo.text);
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    return { port: (server.address() as AddressInfo).port, received };
  }

  /**
   * The provider as the factory builds it, with no dependency injected: the default endpoint and
   * the default request function, from nothing but the connection and its TLS panel.
   */
  const providerFor = (port: number, ssl: SSLConfig): PrometheusProvider =>
    new PrometheusProvider(connection({ host: "127.0.0.1", port, ssl }));

  test("verify-full with no CA refuses the test CA's server as a ConnectionError naming the code, and sends it nothing", async () => {
    const { port, received } = await serveTls();
    const refused = providerFor(port, { mode: "verify-full" });

    const failure = (await outcomeOf(refused.connect())).error;

    expect(failure).toBeInstanceOf(ConnectionError);
    expect((failure as Error).message).toContain("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    expect(received).toEqual([]);
    expect(refused.isConnected()).toBe(false);
    // The control, sent after the refusal so no connection verified earlier can answer it: the
    // same server, checked against the CA that signed it, is connected to.
    const trusted = providerFor(port, { mode: "verify-full", caCert: TLS.ca });
    await trusted.connect();
    expect(trusted.isConnected()).toBe(true);
    expect(received.map((hit) => hit.url)).toEqual(["/api/v1/status/buildinfo"]);
    expect(fetched).toEqual([]);
  });

  test("verify-ca refuses a CA that did not sign the server, and connects with the one that did", async () => {
    const { port, received } = await serveTls();

    const failure = (await outcomeOf(providerFor(port, { mode: "verify-ca", caCert: TLS.otherCa }).connect())).error;

    expect(failure).toBeInstanceOf(ConnectionError);
    expect((failure as Error).message).toContain("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    expect(received).toEqual([]);
    // The control: the CA that did sign it is trusted.
    await providerFor(port, { mode: "verify-ca", caCert: TLS.ca }).connect();
    expect(received.map((hit) => hit.url)).toEqual(["/api/v1/status/buildinfo"]);
    expect(fetched).toEqual([]);
  });

  test("require encrypts without verifying, so it connects to the same server with no CA", async () => {
    const { port, received } = await serveTls();
    const provider = providerFor(port, { mode: "require" });

    await provider.connect();

    expect(provider.isConnected()).toBe(true);
    expect(received.map((hit) => hit.url)).toEqual(["/api/v1/status/buildinfo"]);
    expect(fetched).toEqual([]);
  });

  test("the panel's client certificate and key reach a server that asks for one", async () => {
    const { port, received } = await serveTls({ requestCert: true, rejectUnauthorized: true, ca: TLS.clientCa });

    // Without them the server ends the handshake. bun 1.4.2 reports that as a reset rather than a
    // TLS code, so only the refusal itself is asserted.
    const refused = (await outcomeOf(providerFor(port, { mode: "verify-full", caCert: TLS.ca }).connect())).error;
    expect(refused).toBeInstanceOf(ConnectionError);
    expect(received).toEqual([]);

    await providerFor(port, {
      mode: "verify-full",
      caCert: TLS.ca,
      clientCert: TLS.client.cert,
      clientKey: TLS.client.key,
    }).connect();

    expect(received).toEqual([{ url: "/api/v1/status/buildinfo", authorized: true }]);
    expect(fetched).toEqual([]);
  });
});

// ============================================================================
// The bounds connect() hands the transport (#1085 S5)
// ============================================================================

describe("the bounds connect() hands the transport (#1085 S5)", () => {
  /** Built inline: a one-name metric listing, what the object read below is answered with. */
  const oneMetricListing: SendRequest = (request) =>
    request.url.pathname === "/api/v1/label/__name__/values"
      ? Promise.resolve(json('{"status":"success","data":["up"]}'))
      : captured(request);

  test("every request carries the response byte cap: connect, a query, a monitoring read and an object read", async () => {
    respond = oneMetricListing;
    const provider = new PrometheusProvider(connection(), {}, deps());

    await provider.connect();
    await provider.query("up");
    await provider.getTableStats();
    await provider.listObjects([], "metric");

    expect(sent.map((request) => [request.pathname, request.maxBytes])).toEqual([
      ["/api/v1/status/buildinfo", RESPONSE_BYTE_CAP],
      ["/api/v1/query", RESPONSE_BYTE_CAP],
      ["/api/v1/status/tsdb", RESPONSE_BYTE_CAP],
      ["/api/v1/label/__name__/values", RESPONSE_BYTE_CAP],
    ]);
  });

  test("every read that is not a query has the connection's query timeout as its deadline", async () => {
    // Each deadline is recorded as it is armed and handed back as a signal that never fires, so
    // nothing here waits on a clock. Replaced for this test alone: the tests of the query slots
    // read the reason a real deadline aborts with.
    const armed: { readonly ms: number; readonly signal: AbortSignal }[] = [];
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const { signal } = new AbortController();
      armed.push({ ms, signal });
      return signal;
    });
    /** The deadline armed for exactly this request's signal. */
    const deadlineOf = (request: SentRequest): number | undefined =>
      armed.find((deadline) => deadline.signal === request.signal)?.ms;
    try {
      respond = oneMetricListing;
      // Not the product's default, so a deadline written as a constant is told apart from the
      // connection's own.
      const provider = new PrometheusProvider(connection(), { queryTimeout: 4321 }, deps());

      await provider.connect();
      await provider.getTableStats();
      await provider.listObjects([], "metric");

      expect(sent.map((request) => [request.pathname, deadlineOf(request)])).toEqual([
        ["/api/v1/status/buildinfo", 4321],
        ["/api/v1/status/tsdb", 4321],
        ["/api/v1/label/__name__/values", 4321],
      ]);

      // The control: with none configured it is the product's own default.
      sent = [];
      await new PrometheusProvider(connection(), {}, deps()).connect();
      expect(sent.map(deadlineOf)).toEqual([DEFAULT_QUERY_TIMEOUT]);
    } finally {
      timeout.mockRestore();
    }
  });

  test("the object surface's existence read is bounded as a query is, by the connection's query timeout and the series cap", async () => {
    // Built inline, as in the query slots' tests: a metric listing one name past the cap, so a name
    // outside it is asked about with a count over the hour the listing covers (#1085 4.3, 4.4).
    const listing = JSON.stringify({
      status: "success",
      data: Array.from({ length: METRIC_LIST_CAP + 1 }, (_, index) => `studio_listed_${index}`),
    });
    respond = (request) => {
      if (request.url.pathname === "/api/v1/label/__name__/values") return Promise.resolve(json(listing));
      // The metadata read that follows: the captured answer for a name with none.
      if (request.url.pathname === "/api/v1/metadata") return Promise.resolve(replay("metadata-unknown"));
      return captured(request);
    };
    // Not the product's default, as above.
    const provider = await connectedProvider({}, { queryTimeout: 4321 });

    await provider.readObjectSource(["studio_unlisted"], "metric");

    const [existence, ...others] = queries();
    expect(others).toEqual([]);
    expect(existence.form?.get("query")).toBe(`count(last_over_time(${metricSelector("studio_unlisted")}[1h]))`);
    expect(durationMs(existence.form?.get("timeout"))).toBe(4321);
    expect(existence.form?.get("limit")).toBe(String(DEFAULT_QUERY_LIMIT + 1));
  });
});

// ============================================================================
// query()
// ============================================================================

describe("query", () => {
  test("a provider that is not connected refuses before anything is sent", async () => {
    const provider = new PrometheusProvider(connection(), {}, deps());

    await expect(provider.query("up")).rejects.toBeInstanceOf(DatabaseConfigError);
    expect(sent).toEqual([]);

    // The control: connected, the same call reaches the server.
    await provider.connect();
    sent = [];
    await provider.query("up");
    expect(queries()).toHaveLength(1);
  });

  test("the editor text reaches the server unchanged, asking for one series more than the cap", async () => {
    const provider = await connectedProvider();
    const statement =
      '# requests by code\nsum by (code) (rate(prometheus_http_requests_total{handler=~"/api/.+"}[5m])) + 0 # & % = +';

    await provider.query(statement);

    expect(queries()).toHaveLength(1);
    expect(queries()[0].method).toBe("POST");
    expect(queries()[0].form?.get("query")).toBe(statement);
    // The shaper shows at most DEFAULT_QUERY_LIMIT series; the query asks for one more, so a cut
    // is always seen (#1085 5.4).
    expect(queries()[0].form?.get("limit")).toBe(String(DEFAULT_QUERY_LIMIT + 1));
  });

  test("the connection's query timeout is the query's own timeout", async () => {
    const provider = await connectedProvider({}, { queryTimeout: 1234 });
    await provider.query("up");
    expect(durationMs(queries()[0].form?.get("timeout"))).toBe(1234);

    // The control: with none configured it is the product's own default, not a number chosen here.
    const byDefault = await connectedProvider();
    await byDefault.query("up");
    expect(durationMs(queries()[0].form?.get("timeout"))).toBe(DEFAULT_QUERY_TIMEOUT);
  });

  test("a text holding only comments and whitespace is refused before any request (#1085 5.1)", async () => {
    const provider = await connectedProvider();

    for (const statement of ["", "   \n\t", "# only a comment", "# one\n  # two\n\n"]) {
      await expect(provider.query(statement)).rejects.toBeInstanceOf(QueryError);
    }
    expect(sent).toEqual([]);

    // The controls: an expression under the same comments is sent, and so is a string literal whose
    // text holds a `#`, which is part of the string and not a comment.
    await provider.query("# one\n  # two\nup");
    await provider.query('"#"');
    expect(queries().map((request) => request.form?.get("query"))).toEqual(["# one\n  # two\nup", '"#"']);
  });

  test("bound values are refused, because PromQL binds nothing", async () => {
    const provider = await connectedProvider();

    await expect(provider.query("up", ["x"])).rejects.toBeInstanceOf(DatabaseConfigError);
    expect(sent).toEqual([]);

    // The control: an empty array binds nothing and is not a refusal.
    await provider.query("up", []);
    expect(queries()).toHaveLength(1);
  });

  test("the text Generate Query writes reaches the server as one request, byte for byte (#1085 6.4)", async () => {
    const provider = await connectedProvider();
    const columns: ColumnSchema[] = [
      { name: "code", type: "label", nullable: true, isPrimary: false },
      { name: "handler", type: "label", nullable: true, isPrimary: false },
    ];
    const generated = generateSelectQuery(["prometheus_http_requests_total"], columns, provider.getCapabilities());

    await provider.query(generated);

    expect(queries()).toHaveLength(1);
    expect(queries()[0].form?.get("query")).toBe(generated);
  });

  test("an answer is the result shaper's own rows and fields, timed, with no warnings key when the engine sent none", async () => {
    const provider = await connectedProvider();

    const result = await provider.query("up");
    const expected = shapeQueryResult(await directTransport().query("up", DIRECT_QUERY), SHAPE);

    expect(result.rows).toEqual(expected.rows);
    expect(result.fields).toEqual(expected.fields);
    expect(result.rowCount).toBe(expected.rows.length);
    // Non-vacuous: the captured `up` answer holds at least the self-scrape series.
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.executionTime).toBeGreaterThanOrEqual(0);
    expect(expected.warnings).toEqual([]);
    expect(expected.wasLimited).toBe(false);
    expect("warnings" in result).toBe(false);
    expect("pagination" in result).toBe(false);
  });

  test("the engine's warnings and infos arrive as the result's warnings", async () => {
    // The two captured notice answers, each asked with the statement beside it.
    const notices = [
      ["query-warning-notice", "quantile(2, up)"],
      ["query-info-notice", "rate(go_goroutines[1m])"],
    ] as const;

    for (const [name, statement] of notices) {
      respond = async (request) => (request.url.pathname === "/api/v1/query" ? replay(name) : captured(request));
      const provider = await connectedProvider();

      const result = await provider.query(statement);
      const expected = shapeQueryResult(await directTransport().query(statement, DIRECT_QUERY), SHAPE);

      expect(result.warnings).toEqual(expected.warnings);
      // Non-vacuous: each capture carries a notice in the engine's own words.
      expect(expected.warnings.length).toBeGreaterThan(0);
    }
  });

  test("a result cut at the series cap says so on its own pagination (#1085 5.4), beside the shaper's warning", async () => {
    // Built inline: one series more than the cap, which no captured payload holds.
    const overCap = JSON.stringify({
      status: "success",
      data: {
        resultType: "vector",
        result: Array.from({ length: DEFAULT_QUERY_LIMIT + 1 }, (_, index) => ({
          metric: { __name__: "series_cap_probe", index: String(index) },
          value: [1758585600, "1"],
        })),
      },
    });
    respond = async (request) => (request.url.pathname === "/api/v1/query" ? json(overCap) : captured(request));
    const provider = await connectedProvider();

    const result = await provider.query("series_cap_probe");

    expect(result.rows.length).toBeLessThanOrEqual(DEFAULT_QUERY_LIMIT);
    expect(result.pagination).toEqual({
      limit: DEFAULT_QUERY_LIMIT,
      offset: 0,
      hasMore: false,
      totalReturned: result.rows.length,
      wasLimited: true,
    });
    expect(result.warnings?.length ?? 0).toBeGreaterThan(0);
  });

  test("a matrix whose grid passes the cell budget is cut to the series that fit, and says so on its own pagination (#1085 5.4)", async () => {
    // Built inline, since no capture comes near the budget. Every series but the last holds one
    // sample at one shared instant; the last brings enough instants of its own that the grid,
    // instants times series, passes the budget only once it is added. The answer holds exactly the
    // series cap, so the budget is the one bound that cuts, and the series kept share one row.
    const instant = 1758585600;
    const ownInstants = Math.floor(MATRIX_SAMPLE_BUDGET / DEFAULT_QUERY_LIMIT);
    const overBudget = JSON.stringify({
      status: "success",
      data: {
        resultType: "matrix",
        result: Array.from({ length: DEFAULT_QUERY_LIMIT }, (_, index) => ({
          metric: { __name__: "budget_probe", index: String(index) },
          values:
            index < DEFAULT_QUERY_LIMIT - 1
              ? [[instant, "1"]]
              : Array.from({ length: ownInstants }, (_, step) => [instant + 1 + step, "1"]),
        })),
      },
    });
    respond = async (request) => (request.url.pathname === "/api/v1/query" ? json(overBudget) : captured(request));
    const provider = await connectedProvider();

    const result = await provider.query("budget_probe[1h]");
    const expected = shapeQueryResult(await directTransport().query("budget_probe[1h]", DIRECT_QUERY), SHAPE);

    expect(result.rows).toEqual(expected.rows);
    expect(result.fields).toEqual(expected.fields);
    expect(result.warnings).toEqual(expected.warnings);
    expect(result.pagination).toEqual({
      limit: DEFAULT_QUERY_LIMIT,
      offset: 0,
      hasMore: false,
      totalReturned: result.rows.length,
      wasLimited: true,
    });
    // Non-vacuous: at these bounds the shaper cuts this answer, and its notice names the budget. So
    // any other budget reaching the shaper answers something else: a larger one, or none, keeps
    // every series, and a smaller one names itself.
    const budgetNotice = `held to ${MATRIX_SAMPLE_BUDGET.toLocaleString("en-US")} cells`;
    expect(expected.wasLimited).toBe(true);
    expect(expected.warnings.some((warning) => warning.message.includes(budgetNotice))).toBe(true);
  });

  test("an engine error arrives as the class its errorType names", async () => {
    // The captured parse error: status 400 and `errorType` `bad_data`, asked with `sum(`.
    respond = async (request) =>
      request.url.pathname === "/api/v1/query" ? replay("error-bad-data") : captured(request);
    const provider = await connectedProvider();

    await expect(provider.query("sum(")).rejects.toBeInstanceOf(QueryError);
  });
});

// ============================================================================
// The query slots (#1085 S6) and cancellation (M1)
// ============================================================================

describe("the query slots and cancellation", () => {
  /** The existence read of a metric outside a capped listing: a count over the listing's own hour (#1085 4.4). */
  const EXISTENCE = `count(last_over_time(${metricSelector("studio_unlisted")}[1h]))`;

  test("a query past the limit waits for a slot, and a monitoring read does not queue behind queries", async () => {
    respond = holdQueries;
    const provider = await connectedProvider();
    const running = Array.from({ length: QUERY_CONCURRENCY_LIMIT }, (_, index) =>
      outcomeOf(provider.query(`vector(${index})`)),
    );
    await until(() => held.length === QUERY_CONCURRENCY_LIMIT, "every slot taken");

    const overflow = outcomeOf(provider.query("vector(99)"));
    await settle();
    expect(queries().map((request) => request.form?.get("query"))).not.toContain("vector(99)");

    // A monitoring read is not a query and takes no slot: it completes while every slot is held.
    expect((await provider.getTableStats()).length).toBeGreaterThan(0);

    // The control: freeing one slot is exactly what lets the waiting query reach the server.
    held[0].release();
    await until(() => held.length === QUERY_CONCURRENCY_LIMIT + 1, "the waiting query reaching the server");
    expect(heldQueryText(held[QUERY_CONCURRENCY_LIMIT])).toBe("vector(99)");

    for (const slot of held) slot.release();
    for (const outcome of await Promise.all([...running, overflow])) expect(outcome.error).toBeUndefined();
  });

  test("a query that waited for a slot reports the time of its own exchange, not of its wait (#1085 S6)", async () => {
    // `performance.now` is the clock the execution time is read from, and nothing else on this path
    // reads it, so a stubbed one makes both the wait and the exchange exact.
    let clock = 1_000;
    const now = spyOn(performance, "now").mockImplementation(() => clock);
    try {
      respond = holdQueries;
      const provider = await connectedProvider();
      const running = Array.from({ length: QUERY_CONCURRENCY_LIMIT }, (_, index) =>
        outcomeOf(provider.query(`vector(${index})`)),
      );
      await until(() => held.length === QUERY_CONCURRENCY_LIMIT, "every slot taken");
      const waiting = outcomeOf(provider.query("vector(99)"));
      await settle();

      // Thirty seconds pass while it waits, then a slot comes free.
      clock += 30_000;
      held[0].release();
      await until(() => held.length === QUERY_CONCURRENCY_LIMIT + 1, "the waiting query reaching the server");
      // Its own exchange takes seven milliseconds.
      clock += 7;
      held[QUERY_CONCURRENCY_LIMIT].release();

      expect((await waiting).value?.executionTime).toBe(7);
      // The control: the query that held its slot through the wait reports all of it, so the stubbed
      // clock is the one read, and the 7 above is about where it is read.
      expect((await running[0]).value?.executionTime).toBe(30_000);

      for (const slot of held) slot.release();
      for (const outcome of await Promise.all(running)) expect(outcome.error).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });

  test("the object surface's existence read waits for a slot too, because it is a PromQL evaluation (#1085 S6)", async () => {
    // Built inline: a metric listing one name past the cap, which no capture is long enough for, so
    // a name outside it is asked about with `EXISTENCE`, a count of its one selector over the hour
    // the listing covers (#1085 4.3, 4.4).
    const listing = JSON.stringify({
      status: "success",
      data: Array.from({ length: METRIC_LIST_CAP + 1 }, (_, index) => `studio_listed_${index}`),
    });
    respond = (request) => {
      if (request.url.pathname === "/api/v1/label/__name__/values") return Promise.resolve(json(listing));
      // The metadata read that follows: the captured answer for a name with none.
      if (request.url.pathname === "/api/v1/metadata") return Promise.resolve(replay("metadata-unknown"));
      return holdQueries(request);
    };
    const provider = await connectedProvider();
    const running = Array.from({ length: QUERY_CONCURRENCY_LIMIT }, (_, index) =>
      outcomeOf(provider.query(`vector(${index})`)),
    );
    await until(() => held.length === QUERY_CONCURRENCY_LIMIT, "every slot taken");

    const source = outcomeOf(provider.readObjectSource(["studio_unlisted"], "metric"));
    await until(
      () => sent.some((request) => request.pathname === "/api/v1/label/__name__/values"),
      "the metric listing read",
    );
    await settle();
    expect(queries().map((request) => request.form?.get("query"))).not.toContain(EXISTENCE);

    // The control: freeing one slot is exactly what lets the existence read reach the server.
    held[0].release();
    await until(() => held.length === QUERY_CONCURRENCY_LIMIT + 1, "the existence read reaching the server");
    expect(heldQueryText(held[QUERY_CONCURRENCY_LIMIT])).toBe(EXISTENCE);

    for (const slot of held) slot.release();
    for (const outcome of await Promise.all(running)) expect(outcome.error).toBeUndefined();
    expect((await source).error).toBeUndefined();
  });

  test("disconnect ends an existence read still waiting for a slot, and it is never sent", async () => {
    // The same inline listing as the test above: one name past the cap.
    const listing = JSON.stringify({
      status: "success",
      data: Array.from({ length: METRIC_LIST_CAP + 1 }, (_, index) => `studio_listed_${index}`),
    });
    respond = (request) =>
      request.url.pathname === "/api/v1/label/__name__/values" ? Promise.resolve(json(listing)) : holdQueries(request);
    const provider = await connectedProvider();
    const running = Array.from({ length: QUERY_CONCURRENCY_LIMIT }, (_, index) =>
      outcomeOf(provider.query(`vector(${index})`)),
    );
    await until(() => held.length === QUERY_CONCURRENCY_LIMIT, "every slot taken");
    const source = outcomeOf(provider.readObjectSource(["studio_unlisted"], "metric"));
    await until(
      () => sent.some((request) => request.pathname === "/api/v1/label/__name__/values"),
      "the metric listing read",
    );
    await settle();

    await provider.disconnect();

    expect((await source).error).toBeInstanceOf(QueryCancelledError);
    for (const outcome of await Promise.all(running)) expect(outcome.error).toBeInstanceOf(QueryCancelledError);
    await settle();
    // Never sent: the queries that held the slots were, and nothing after them. The test above is
    // the control that `EXISTENCE` is the text this read sends once it has a slot.
    expect(queries().map((request) => request.form?.get("query"))).not.toContain(EXISTENCE);
    expect(queries()).toHaveLength(QUERY_CONCURRENCY_LIMIT);
  });

  test("a query cancelled while it waits for a slot never reaches the server, and ends as a cancellation (#1085 S6)", async () => {
    respond = holdQueries;
    const provider = await connectedProvider();
    const running = Array.from({ length: QUERY_CONCURRENCY_LIMIT }, (_, index) =>
      outcomeOf(provider.query(`vector(${index})`, undefined, `running-${index}`)),
    );
    await until(() => held.length === QUERY_CONCURRENCY_LIMIT, "every slot taken");
    const waiting = outcomeOf(provider.query("vector(99)", undefined, "waiting"));
    await settle();

    expect(await provider.cancelQuery("waiting")).toBe(true);
    expect((await waiting).error).toBeInstanceOf(QueryCancelledError);

    for (const slot of held) slot.release();
    for (const outcome of await Promise.all(running)) expect(outcome.error).toBeUndefined();
    await settle();
    // Never sent, before the cancel or after the slots came free.
    expect(queries().map((request) => request.form?.get("query"))).not.toContain("vector(99)");
    // The control: every query that held a slot did reach the server.
    expect(queries()).toHaveLength(QUERY_CONCURRENCY_LIMIT);
    // And the name went with the query: nothing is left to cancel under it.
    expect(await provider.cancelQuery("waiting")).toBe(false);
  });

  test("cancelQuery aborts that query's request, and the query ends as a cancellation", async () => {
    respond = holdQueries;
    const provider = await connectedProvider();
    const running = outcomeOf(provider.query("vector(1)", undefined, "to-cancel"));
    await until(() => held.length === 1, "the query reaching the server");

    expect(await provider.cancelQuery("to-cancel")).toBe(true);

    expect((await running).error).toBeInstanceOf(QueryCancelledError);
    expect(held[0].request.signal.aborted).toBe(true);
  });

  test("cancelQuery answers false, and sends nothing, for a name no running query carries", async () => {
    const provider = await connectedProvider();

    expect(await provider.cancelQuery("never-started")).toBe(false);
    expect(sent).toEqual([]);

    // The control: the same name is cancellable while a query carries it.
    respond = holdQueries;
    const running = outcomeOf(provider.query("vector(1)", undefined, "never-started"));
    await until(() => held.length === 1, "the query reaching the server");
    expect(await provider.cancelQuery("never-started")).toBe(true);
    expect((await running).error).toBeInstanceOf(QueryCancelledError);
  });

  test("disconnect ends every query as a cancellation, running or waiting, named or not", async () => {
    respond = holdQueries;
    const provider = await connectedProvider();
    const running = Array.from({ length: QUERY_CONCURRENCY_LIMIT }, (_, index) =>
      outcomeOf(provider.query(`vector(${index})`, undefined, index === 0 ? "named" : undefined)),
    );
    await until(() => held.length === QUERY_CONCURRENCY_LIMIT, "every slot taken");
    const waiting = outcomeOf(provider.query("vector(99)", undefined, "queued"));
    await settle();

    await provider.disconnect();
    // Asked before the queries have settled, so the answer is the disconnect's own: each query
    // also drops its name when it ends, and asked after that, this line would hold without it.
    expect(await provider.cancelQuery("named")).toBe(false);

    for (const outcome of await Promise.all([...running, waiting])) {
      expect(outcome.error).toBeInstanceOf(QueryCancelledError);
    }
    expect(held.every((slot) => slot.request.signal.aborted)).toBe(true);
    expect(queries().map((request) => request.form?.get("query"))).not.toContain("vector(99)");
    expect(provider.isConnected()).toBe(false);
  });
});

// ============================================================================
// The monitoring surfaces (#1085 6.2)
// ============================================================================

describe("the monitoring surfaces", () => {
  test("each is the monitoring module's own answer, over the same transport", async () => {
    const provider = await connectedProvider();
    const direct = directTransport();

    expect(await provider.getHealth()).toEqual(await readHealth(direct));
    expect(await provider.getOverview()).toEqual(await readOverview(direct, formatDuration));
    expect(await provider.getTableStats()).toEqual(await readTableStats(direct));
    expect(await provider.getStorageStats()).toEqual(await readStorageStats(direct));
    // Non-vacuous: the captured TSDB status names the metrics with the most series.
    expect((await provider.getTableStats()).length).toBeGreaterThan(0);
  });

  test("a schema filter naming any schema answers no metrics and reads nothing, because no metric is in one", async () => {
    const provider = await connectedProvider();

    expect(await provider.getTableStats({ schema: "public" })).toEqual([]);
    expect(sent).toEqual([]);

    // The controls: the schema Prometheus reports its metrics under, and no filter at all, both read.
    expect((await provider.getTableStats({ schema: PROMETHEUS_SCHEMA_NAME })).length).toBeGreaterThan(0);
    expect((await provider.getTableStats()).length).toBeGreaterThan(0);
  });

  test("the surfaces Prometheus publishes nothing for answer empty, and read nothing", async () => {
    const provider = await connectedProvider();

    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    expect(sent).toEqual([]);

    // The control: the same connection reads a surface that does exist.
    await provider.getTableStats();
    expect(sent.map((request) => request.pathname)).toContain("/api/v1/status/tsdb");
  });

  test("a failed monitoring read arrives as this repository's error class", async () => {
    const provider = await connectedProvider();
    respond = () => Promise.reject(new RequestFailure("network", "connect ECONNREFUSED 127.0.0.1:9090"));

    await expect(provider.getTableStats()).rejects.toBeInstanceOf(ConnectionError);
  });

  test("getPoolStats is absent, so the pool-stats route answers its own fallback", () => {
    const provider = new PrometheusProvider(connection());

    expect("getPoolStats" in provider).toBe(false);
    // The control: the same presence test sees a method that is there.
    expect("getHealth" in provider).toBe(true);
  });

  test("runMaintenance refuses and sends nothing, because no maintenance operation runs here", async () => {
    const provider = await connectedProvider();

    await expect(provider.runMaintenance("analyze")).rejects.toBeInstanceOf(QueryError);
    expect(sent).toEqual([]);

    // The control: the same connection does send when a surface reads the server.
    await provider.getHealth();
    expect(sent.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// The object surface (#1085 section 4), which PrometheusObjects owns
// ============================================================================

describe("the object surface", () => {
  const CONTAINERS: Container[] = [{ path: ["delegated"], name: "delegated", level: 0 }];
  const COUNTS: Record<string, KindCount> = { metric: { count: 3 } };
  const OBJECTS: DatabaseObject[] = [{ path: ["up"], name: "up", kind: "metric" }];
  const DETAIL: ObjectDetail = { path: ["up"], columns: [], indexes: [], foreignKeys: [] };
  const BATCH: ObjectDetailBatch = { details: [DETAIL] };
  const SOURCE: ObjectSourceDocument = {
    path: ["up"],
    kind: "metric",
    parts: [{ id: "metadata", label: "Metadata", text: "{}", language: "json", form: "complete", origin: "rendered" }],
  };

  type SurfaceMethod =
    | "listContainers"
    | "countObjects"
    | "listObjects"
    | "describeObject"
    | "describeObjects"
    | "readObjectSource";

  /** The provider answers exactly what `PrometheusObjects` answered, for exactly the arguments given. */
  async function expectDelegated<K extends SurfaceMethod>(
    method: K,
    args: Parameters<PrometheusObjects[K]>,
    answer: Awaited<ReturnType<PrometheusObjects[K]>>,
  ): Promise<void> {
    const spy = spyOn(PrometheusObjects.prototype, method).mockResolvedValue(answer as never);
    try {
      const provider = await connectedProvider();
      const call = provider[method] as (...values: Parameters<PrometheusObjects[K]>) => Promise<unknown>;
      expect(await call.apply(provider, args)).toBe(answer);
      expect(spy.mock.calls).toEqual([args]);
    } finally {
      spy.mockRestore();
    }
  }

  test("listContainers", () => expectDelegated("listContainers", [["parent"]], CONTAINERS));
  test("countObjects", () => expectDelegated("countObjects", [[]], COUNTS));
  test("listObjects", () => expectDelegated("listObjects", [[], "metric"], OBJECTS));
  test("describeObject", () => expectDelegated("describeObject", [["up"], "metric"], DETAIL));
  test("describeObjects", () => expectDelegated("describeObjects", [[], "metric", 10], BATCH));
  test("readObjectSource", () => expectDelegated("readObjectSource", [["up"], "metric", 100], SOURCE));

  test("a provider that is not connected refuses the object surface before anything is sent", async () => {
    const provider = new PrometheusProvider(connection(), {}, deps());

    await expect(provider.listObjects([], "metric")).rejects.toBeInstanceOf(DatabaseConfigError);
    expect(sent).toEqual([]);

    // The control: connected, the same call reaches the object surface.
    const spy = spyOn(PrometheusObjects.prototype, "listObjects").mockResolvedValue(OBJECTS);
    try {
      await provider.connect();
      expect(await provider.listObjects([], "metric")).toBe(OBJECTS);
    } finally {
      spy.mockRestore();
    }
  });

  test("a transport failure under the object surface arrives as this repository's error class", async () => {
    const spy = spyOn(PrometheusObjects.prototype, "countObjects").mockRejectedValue(
      new PrometheusTransportError("unavailable", "the server is not ready"),
    );
    try {
      const provider = await connectedProvider();
      await expect(provider.countObjects([])).rejects.toBeInstanceOf(ConnectionError);
    } finally {
      spy.mockRestore();
    }
  });

  test("with no clock injected, the inventory window is read against the real one", async () => {
    // Built inline: a one-name listing, since what this test reads is the window asked for.
    respond = (request) =>
      request.url.pathname === "/api/v1/label/__name__/values"
        ? Promise.resolve(json('{"status":"success","data":["up"]}'))
        : captured(request);
    const provider = new PrometheusProvider(connection(), {}, { endpoint: () => TEST_ENDPOINT, send });
    await provider.connect();
    const listings = (): SentRequest[] =>
      sent.filter((request) => request.pathname === "/api/v1/label/__name__/values");
    // `Date.now` is read at call time, so replacing it here is what the default clock sees.
    const clock = spyOn(Date, "now").mockReturnValue(NOW_MS);
    try {
      await provider.listObjects([], "metric");
      expect(listings()[0].search.get("start")).toBe(String((NOW_MS - INVENTORY_WINDOW_MS) / 1000));
      expect(listings()[0].search.get("end")).toBe(String(NOW_MS / 1000));

      // The control: the window moves with the clock, so the values above are about which clock was read.
      clock.mockReturnValue(NOW_MS + 3_600_000);
      await provider.listObjects([], "metric");
      expect(listings()[1].search.get("end")).toBe(String((NOW_MS + 3_600_000) / 1000));
    } finally {
      clock.mockRestore();
    }
  });
});

// ============================================================================
// The declarations (#1085 6.3)
// ============================================================================

describe("the declarations", () => {
  test("the capabilities are #1085 section 6.3, exactly", () => {
    expect(new PrometheusProvider(connection()).getCapabilities()).toEqual({
      queryLanguage: "promql",
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsResultPagination: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: 9090,
      statementTerminator: "none",
      containerLevels: [],
      objectKinds: PROMETHEUS_OBJECT_KINDS,
      schemaRefreshPattern: "(?!)",
    });
  });

  test("the schema refresh pattern matches no statement, because none changes the tree", () => {
    const pattern = new RegExp(new PrometheusProvider(connection()).getCapabilities().schemaRefreshPattern, "i");

    for (const statement of ["up", "DROP TABLE x", 'delete_series{job="x"}', "CREATE", ""]) {
      expect(pattern.test(statement)).toBe(false);
    }
    // The control: the same reading of a pattern that does name a statement finds it.
    expect(new RegExp("(CREATE|DROP|ALTER|TRUNCATE)\\b", "i").test("DROP TABLE x")).toBe(true);
  });

  test("the labels name metrics and series, the statement language, and why two panels are empty", () => {
    expect(new PrometheusProvider(connection()).getLabels()).toEqual({
      entityName: "Metric",
      entityNamePlural: "Metrics",
      rowName: "series",
      rowNamePlural: "series",
      selectAction: "Run Instant Query",
      generateAction: "Generate Query",
      searchPlaceholder: "Search metrics or labels...",
      statementLanguage: "PromQL",
      slowQueriesEmptyState: "Prometheus exposes no query log over its HTTP API, so there are no slow queries to read.",
      sessionsEmptyState:
        "Prometheus exposes no session list over its HTTP API: every request is a separate, stateless call.",
      analyzeAction: "TSDB Statistics",
      vacuumAction: "Compact Blocks",
      analyzeGlobalLabel: "TSDB Statistics",
      analyzeGlobalTitle: "Statistics Are the Server's Own",
      analyzeGlobalDesc:
        "Prometheus maintains its TSDB statistics itself as samples are ingested, and its HTTP API offers no call that recomputes them. Nothing runs from here.",
      vacuumGlobalLabel: "Compact Blocks",
      vacuumGlobalTitle: "Compaction Is the Server's Own",
      vacuumGlobalDesc:
        "Prometheus compacts its TSDB blocks on its own schedule. Deleting series and cleaning tombstones are admin API calls this product never makes, so nothing runs from here.",
    });
  });

  test("prepareQuery hands the text on untouched, at the series cap and never at an offset", () => {
    const provider: DatabaseProvider = new PrometheusProvider(connection());

    expect(provider.prepareQuery("up", { limit: 50, offset: 50 })).toEqual({
      query: "up",
      wasLimited: false,
      limit: DEFAULT_QUERY_LIMIT,
      offset: 0,
    });
    expect(provider.prepareQuery("up")).toEqual({
      query: "up",
      wasLimited: false,
      limit: DEFAULT_QUERY_LIMIT,
      offset: 0,
    });
  });

  test("a connection with no host is refused when the provider is built", () => {
    expect(() => new PrometheusProvider(connection({ host: undefined }))).toThrow(DatabaseConfigError);
    // The control: the same connection with its host builds.
    expect(new PrometheusProvider(connection()).type).toBe("prometheus");
  });
});
