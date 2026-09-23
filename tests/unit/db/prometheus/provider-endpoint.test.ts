/**
 * The endpoint a real Prometheus connection gets (#1085 S1, section 3.6).
 *
 * The provider is built here with no endpoint dependency, as the factory builds it, so it takes the
 * default endpoint `index.ts` composes from the shared validated builder of
 * `src/lib/db/http/endpoint.ts` (#1086), and #1085 S1 is held end to end: a host or a port carrying URL
 * syntax is refused before any request leaves the process, the refusal is that module's own
 * `DatabaseConfigError`, neither the error nor the log line it is written to repeats anything of the
 * value, and a valid host and port address exactly the configured server.
 *
 * "Before any request" is measured on a real local server rather than on a replaced `fetch`: a
 * replaced `fetch` sees only what the provider hands it, and a smuggled value is exactly the case
 * where what is handed over and where it lands differ. Each refused value is built so that a URL
 * assembled by string concatenation WOULD reach that server, because its authority is the server's
 * own `127.0.0.1:<port>`, and each refusal test measures that claim beside its zero: the same
 * connection, given an endpoint that concatenates, does reach the recorder. So a zero means refused
 * rather than misrouted, and the first test shows the same server records a valid connection.
 *
 * The refusal is compared with what the shared module itself answers for the same input, never with
 * a copied sentence, so this file fails the day the provider validates on its own.
 */
import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseConfigError } from "@/lib/db/errors";
import { httpOrigin } from "@/lib/db/http/endpoint";
import type { PrometheusEndpoint } from "@/lib/db/providers/timeseries/prometheus/http-transport";
import { PrometheusProvider } from "@/lib/db/providers/timeseries/prometheus/index";
import type { InboundResponse, OutboundRequest } from "@/lib/db/providers/timeseries/prometheus/request";
import type { DatabaseConnection } from "@/lib/types";
import { capture } from "../../../helpers/prometheus-fixtures";

/**
 * A capture of the compose `prometheus` service (`tests/fixtures/prometheus/v3.13.3/`), replayed as
 * the server sent it: its status, its content type and its own bytes.
 */
function replayed(name: string): InboundResponse {
  const answer = capture(name);
  return { status: answer.status, contentType: answer.headers["content-type"] ?? null, body: answer.text };
}

/** The one header the provider reads from an answer, when the server sent one. */
function contentTypeOf(answer: InboundResponse): Record<string, string> {
  return answer.contentType === null ? {} : { "content-type": answer.contentType };
}

/**
 * What the server answers on each path a connect and one query may call, each the capture of that
 * request. Any other path gets the server's own answer to a path it does not serve: the 404 it gave
 * for `GET /health` (`health-legacy`).
 */
const ANSWERS: ReadonlyMap<string, InboundResponse> = new Map([
  ["GET /-/healthy", replayed("health-healthy")],
  ["GET /-/ready", replayed("health-ready")],
  ["GET /api/v1/status/buildinfo", replayed("buildinfo")],
  ["GET /api/v1/status/runtimeinfo", replayed("runtimeinfo")],
  ["GET /api/v1/status/flags", replayed("flags")],
  ["GET /api/v1/status/tsdb", replayed("tsdb-status-50")],
  ["POST /api/v1/query", replayed("query-vector")],
]);
const NOT_FOUND: InboundResponse = replayed("health-legacy");

function answerFor(method: string, pathname: string): InboundResponse {
  return ANSWERS.get(`${method} ${pathname}`) ?? NOT_FOUND;
}

function connection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "prometheus-endpoint",
    name: "Endpoint probe",
    type: "prometheus",
    host: "127.0.0.1",
    port: 9090,
    createdAt: new Date("2026-09-23T00:00:00.000Z"),
    ...overrides,
  };
}

/** What the shared module itself says about this host and port; a failed test if it accepts them. */
function sharedRefusal(host: unknown, port: unknown): string {
  try {
    httpOrigin("http", host, port);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("the shared endpoint module accepted a value this test expects it to refuse");
}

/**
 * The endpoint #1085 S1 exists to rule out: every URL built by string concatenation. Only the controls use
 * it, to show where a refused host or port would have sent the request.
 */
function concatenatingEndpoint(config: DatabaseConnection, secure: boolean): PrometheusEndpoint {
  return {
    url: (pathname, query) =>
      new URL(`${secure ? "https" : "http"}://${config.host}:${config.port}${pathname}${query ? `?${query}` : ""}`),
  };
}

/** Where a string-concatenated URL would put each smuggled suffix: a path, a query, a fragment. */
const SMUGGLED: Readonly<Record<string, string>> = {
  "a path": "/api/v1/admin/tsdb/delete_series",
  "a query": "?match[]=up",
  "a fragment": "#smuggled",
};

interface Hit {
  readonly method: string;
  readonly url: string;
  readonly host: string;
}

let server: Server;
let port: number;
let hits: Hit[];
let errorSpy: Mock<typeof console.error>;

function record(request: IncomingMessage, response: ServerResponse): void {
  hits.push({ method: request.method ?? "", url: request.url ?? "", host: request.headers.host ?? "" });
  const answer = answerFor(request.method ?? "", new URL(request.url ?? "/", "http://recorder.invalid").pathname);
  request.resume();
  response.writeHead(answer.status, contentTypeOf(answer));
  response.end(answer.body);
}

const messageOf = (failure: Promise<unknown>): Promise<string> =>
  failure.then(
    () => "",
    (error: unknown) => (error as Error).message,
  );

/** Every line logged so far, one text: a failed connect writes its message there as well. */
const logged = (): string => errorSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");

/**
 * The refusal as the caller and the log receive it: the shared module's own sentence in both, and
 * nothing of the value in either. The log line is also the control for its own absence check, since
 * it is read only once it is known to carry the refusal.
 */
async function expectRefusedWithoutEcho(
  failure: Promise<void>,
  refusal: string,
  value: string,
  suffix: string,
): Promise<void> {
  await expect(failure).rejects.toBeInstanceOf(DatabaseConfigError);
  await expect(failure).rejects.toThrow(refusal);
  expect(logged()).toContain(`[DB:prometheus] connect failed: ${refusal}`);
  for (const surface of [await messageOf(failure), logged()]) {
    expect(surface).not.toContain(suffix);
    expect(surface).not.toContain(value);
  }
}

/**
 * The control beside each zero below, one that must match: the same connection, given the
 * concatenating endpoint, reaches this server and no other. Its connect fails on the server's 404,
 * and only whether its request arrived is read.
 */
async function expectConcatenationReachesThisServer(config: DatabaseConnection): Promise<void> {
  const naive = new PrometheusProvider(config, {}, { endpoint: concatenatingEndpoint });
  await naive.connect().catch(() => undefined);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.every((hit) => hit.host === `127.0.0.1:${port}`)).toBe(true);
}

beforeEach(async () => {
  hits = [];
  // A failed connect logs its message; the refusal tests read those lines, and nothing else should print them.
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  server = createServer(record);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  errorSpy.mockRestore();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the default endpoint, against a real server", () => {
  test("a valid host and port connect, and a query reaches that server's /api/v1/query", async () => {
    const provider = new PrometheusProvider(connection({ port }));
    await provider.connect();
    await provider.query("up");

    // The recorder's own control: it does see a connection that is let through.
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.host === `127.0.0.1:${port}`)).toBe(true);
    expect(hits.at(-1)).toEqual({ method: "POST", url: "/api/v1/query", host: `127.0.0.1:${port}` });
    await provider.disconnect();
  });

  test.each(Object.keys(SMUGGLED))(
    "refuses a host carrying %s before any request, and does not repeat it",
    async (carrying) => {
      const host = `127.0.0.1:${port}${SMUGGLED[carrying]}`;
      const config = connection({ host, port });
      const provider = new PrometheusProvider(config);

      await expectRefusedWithoutEcho(provider.connect(), sharedRefusal(host, port), host, SMUGGLED[carrying]);
      expect(hits).toEqual([]);
      expect(provider.isConnected()).toBe(false);
      await expectConcatenationReachesThisServer(config);
    },
  );

  test.each(Object.keys(SMUGGLED))(
    "refuses a port carrying %s before any request, and does not repeat it",
    async (carrying) => {
      const smuggled = `${port}${SMUGGLED[carrying]}`;
      // Typed as a number, but a connection arrives as JSON from the store, a seed or the API.
      const config = connection({ port: smuggled as unknown as number });
      const provider = new PrometheusProvider(config);

      await expectRefusedWithoutEcho(
        provider.connect(),
        sharedRefusal("127.0.0.1", smuggled),
        smuggled,
        SMUGGLED[carrying],
      );
      expect(hits).toEqual([]);
      expect(provider.isConnected()).toBe(false);
      await expectConcatenationReachesThisServer(config);
    },
  );
});

describe("the default endpoint builds the configured origin", () => {
  const originalFetch = globalThis.fetch;
  let urls: string[];

  beforeEach(() => {
    urls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      urls.push(url.href);
      const answer = answerFor(init?.method ?? "GET", url.pathname);
      return new Response(answer.body, { status: answer.status, headers: contentTypeOf(answer) });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("an absent port is the declared default, 9090", async () => {
    const provider = new PrometheusProvider(connection({ host: "prometheus.test", port: undefined }));
    await provider.connect();
    await provider.query("up");

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => new URL(url).origin === "http://prometheus.test:9090")).toBe(true);
    await provider.disconnect();
  });

  test.each(["::1", "[::1]"])("the IPv6 literal %p is addressed in brackets", async (host) => {
    const provider = new PrometheusProvider(connection({ host }));
    await provider.connect();
    await provider.query("up");

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => new URL(url).origin === "http://[::1]:9090")).toBe(true);
    await provider.disconnect();
  });
});

describe("the default endpoint takes its scheme from the TLS panel", () => {
  function recorder(seen: OutboundRequest[]): (request: OutboundRequest) => Promise<InboundResponse> {
    return async (request) => {
      seen.push(request);
      return answerFor(request.method, request.url.pathname);
    };
  }

  test.each([
    ["require", "https://prometheus.test:9443"],
    ["disable", "http://prometheus.test:9443"],
  ] as const)("ssl.mode %p addresses %p", async (mode, origin) => {
    const seen: OutboundRequest[] = [];
    // Only the request function is injected: the endpoint is still the default under test.
    const provider = new PrometheusProvider(
      connection({ host: "prometheus.test", port: 9443, ssl: { mode } }),
      {},
      { send: recorder(seen) },
    );
    await provider.connect();
    await provider.query("up");

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((request) => request.url.origin === origin)).toBe(true);
    await provider.disconnect();
  });
});
