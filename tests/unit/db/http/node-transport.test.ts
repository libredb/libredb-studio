/**
 * createNodeTransport over plaintext, against local listeners (vector-family spec 3.7).
 *
 * Each transport here is one connection: its own keep-alive Agent with at most `maxSockets` sockets, the connection's
 * headers plus `accept-encoding: identity` on every request, and nothing through the global agent. The listeners count
 * the connections they accept and record every request that reaches them, so "nothing was sent" is measured.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { join } from "node:path";
import { DatabaseConfigError } from "@/lib/db/errors";
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import {
  createNodeTransport,
  IDLE_SOCKET_MS,
  type NodeRequest,
  type NodeResponse,
  type NodeTransport,
  type NodeTransportOptions,
  TransportError,
} from "@/lib/db/http/node-transport";
import {
  closeAll,
  eventually,
  gzipOfZeros,
  httpListener,
  jsonAnswer,
  type Listener,
  silentListener,
  streamingAnswer,
} from "../../../helpers/node-transport-fixtures";

const SECRET = "node-transport-secret-key";
const MIB = 1024 * 1024;
const CLOSED = "The connection was closed, so the request did not complete";
const FOREIGN_URL = "Invalid host: the request URL would not address the configured host, so it was not sent";

const transports: NodeTransport[] = [];
afterEach(async () => {
  for (const transport of transports.splice(0)) transport.close();
  await closeAll();
});

function connect(listener: Listener, overrides: Partial<NodeTransportOptions> = {}) {
  const origin = httpOrigin("http", "127.0.0.1", listener.port);
  const transport = createNodeTransport({
    origin,
    tls: null,
    maxSockets: 4,
    headers: { "api-key": SECRET },
    ...overrides,
  });
  transports.push(transport);
  return { transport, url: (path: string, params?: URLSearchParams) => endpointUrl(origin, path, params) };
}

function get(url: string, extra: Partial<NodeRequest> = {}): NodeRequest {
  return { method: "GET", url, signal: AbortSignal.timeout(5000), maxResponseBytes: MIB, ...extra };
}

async function failure(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to reject");
}

/** An Agent with addRequest, the method every request through it calls, which @types/node leaves out. */
function withAddRequest(agent: http.Agent): http.Agent & { addRequest(...args: unknown[]): void } {
  return agent as http.Agent & { addRequest(...args: unknown[]): void };
}

function refusal(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw");
}

describe("a request and its answer", () => {
  test("a GET returns status, content type, Retry-After and text, with the connection's headers and accept-encoding identity", async () => {
    const listener = await httpListener(jsonAnswer(200, '{"result":{"collections":[]}}'));
    const { transport, url } = connect(listener);
    const answer: NodeResponse = await transport.request(get(url("/collections", new URLSearchParams({ limit: "1" }))));
    // The answer's contract, which a provider's own answer type mirrors: a renamed or added field fails typecheck here.
    const exactKeys: [keyof NodeResponse] extends ["status" | "contentType" | "retryAfter" | "text"]
      ? ["status" | "contentType" | "retryAfter" | "text"] extends [keyof NodeResponse]
        ? true
        : false
      : false = true;
    const noneOptional: {
      [field in keyof NodeResponse]-?: object extends Pick<NodeResponse, field> ? field : never;
    }[keyof NodeResponse] extends never
      ? true
      : false = true;
    expect([exactKeys, noneOptional]).toEqual([true, true]);
    expect(answer).toEqual({
      status: 200,
      contentType: "application/json",
      retryAfter: null,
      text: '{"result":{"collections":[]}}',
    });
    expect(listener.seen.map(({ method, url: path }) => ({ method, path }))).toEqual([
      { method: "GET", path: "/collections?limit=1" },
    ]);
    expect(listener.seen[0].headers["api-key"]).toBe(SECRET);
    expect(listener.seen[0].headers["accept-encoding"]).toBe("identity");
  });

  test("a POST sends its body as UTF-8 JSON with its byte length", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener);
    const body = '{"name":"çğış","limit":10}';
    await transport.request({ ...get(url("/collections/c/points/scroll")), method: "POST", body });
    const [seen] = listener.seen;
    expect(seen.body).toBe(body);
    expect(seen.headers["content-type"]).toBe("application/json");
    expect(seen.headers["content-length"]).toBe(String(Buffer.byteLength(body, "utf8")));
  });

  test("a caller's accept-encoding is replaced whatever its case, and the other headers arrive as set", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener, { headers: { "Accept-Encoding": "gzip, br", "API-Key": SECRET } });
    await transport.request(get(url("/")));
    expect(listener.seen[0].headers["accept-encoding"]).toBe("identity");
    expect(listener.seen[0].headers["api-key"]).toBe(SECRET);
  });

  test.each([
    ["10", "10"],
    ["Wed, 21 Oct 2026 07:28:00 GMT", "Wed, 21 Oct 2026 07:28:00 GMT"],
    ["9".repeat(200), "9".repeat(64)],
  ])("a 429 carrying Retry-After %p yields retryAfter %p", async (header, expected) => {
    const listener = await httpListener(
      jsonAnswer(429, '{"status":{"error":"rate limited"}}', { "retry-after": header }),
    );
    const { transport, url } = connect(listener);
    const answer = await transport.request(get(url("/collections")));
    expect(answer.status).toBe(429);
    expect(answer.retryAfter).toBe(expected);
  });

  test("a 429 with no Retry-After yields null", async () => {
    const listener = await httpListener(jsonAnswer(429, '{"status":{"error":"rate limited"}}'));
    const { transport, url } = connect(listener);
    expect((await transport.request(get(url("/collections")))).retryAfter).toBeNull();
  });
});

describe("one keep-alive Agent per connection", () => {
  test("at most maxSockets sockets, reused across requests", async () => {
    const listener = await httpListener((request, response, body) => {
      setTimeout(() => jsonAnswer(200, "{}")(request, response, body), 30);
    });
    const { transport, url } = connect(listener, { maxSockets: 2 });
    await Promise.all([1, 2, 3].map(() => transport.request(get(url("/")))));
    for (let i = 0; i < 5; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each reuses an idle socket.
      await transport.request(get(url("/")));
    }
    expect(listener.seen).toHaveLength(8);
    expect(listener.accepted()).toBe(2);
  });

  test("two connections are two Agents and share no socket", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const first = connect(listener);
    const second = connect(listener);
    await first.transport.request(get(first.url("/")));
    await second.transport.request(get(second.url("/")));
    await first.transport.request(get(first.url("/")));
    expect(listener.accepted()).toBe(2);
  });

  test("never the global agent: the spies on http.globalAgent and https.globalAgent see nothing, and do see a request that takes it", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const httpSpy = spyOn(withAddRequest(http.globalAgent), "addRequest");
    const httpsSpy = spyOn(withAddRequest(https.globalAgent), "addRequest");
    try {
      const { transport, url } = connect(listener);
      await transport.request(get(url("/")));
      expect(httpSpy).toHaveBeenCalledTimes(0);
      expect(httpsSpy).toHaveBeenCalledTimes(0);
      // The control: a request with no agent takes the global one, and the spy sees it.
      await new Promise<void>((resolve, reject) => {
        http
          .get({ hostname: "127.0.0.1", port: listener.port, path: "/control" }, (answer) => {
            answer.resume();
            answer.on("end", () => resolve());
          })
          .on("error", reject);
      });
      expect(httpSpy).toHaveBeenCalledTimes(1);
    } finally {
      httpSpy.mockRestore();
      httpsSpy.mockRestore();
    }
  });

  test("close() destroys the Agent: its idle socket closes, and a later request is refused with no socket", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener);
    await transport.request(get(url("/")));
    transport.close();
    await eventually(() => listener.open() === 0, "the idle socket to close");
    const error = await failure(() => transport.request(get(url("/"))));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).kind).toBe("aborted");
    expect(error.message).toBe(CLOSED);
    expect(listener.accepted()).toBe(1);
  });
});

describe("refused before any socket", () => {
  test.each([
    ["another port on the same host", (port: number) => `http://127.0.0.1:${port + 1}/`],
    ["another scheme", (port: number) => `https://127.0.0.1:${port}/`],
    [
      "userinfo, which would become an Authorization header",
      (port: number) => `http://user:${SECRET}@127.0.0.1:${port}/`,
    ],
    ["a text that is not a URL", () => `not a url ${SECRET}`],
  ])("a URL with %s", async (_label, build) => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport } = connect(listener);
    const error = await failure(() => transport.request(get(build(listener.port))));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(FOREIGN_URL);
    expect(listener.accepted()).toBe(0);
  });

  test.each([0, -1, 1.5, Number.NaN])("a maxResponseBytes of %p", async (maxResponseBytes) => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener);
    const error = await failure(() => transport.request(get(url("/"), { maxResponseBytes })));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe("Invalid maxResponseBytes: expected a positive integer");
    expect(listener.accepted()).toBe(0);
  });

  test.each([0, -1, 2.5, Number.POSITIVE_INFINITY])("a maxSockets of %p", (maxSockets) => {
    const error = refusal(() =>
      createNodeTransport({ origin: httpOrigin("http", "127.0.0.1", 6333), tls: null, maxSockets, headers: {} }),
    );
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe("Invalid maxSockets: expected a positive integer");
  });

  test.each([
    ["Content-Length", "content-length"],
    ["Transfer-Encoding", "transfer-encoding"],
    ["Host", "host"],
  ])("a connection header %p, which frames or addresses every request, is refused by name", (name, named) => {
    const error = refusal(() =>
      createNodeTransport({
        origin: httpOrigin("http", "127.0.0.1", 6333),
        tls: null,
        maxSockets: 1,
        headers: { [name]: "5-secret" },
      }),
    );
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(`Invalid headers: ${named} is set by the transport for each request`);
    expect(error.message).not.toContain("secret");
  });

  test.each([
    ["an https origin with no TLS material", "https" as const, null],
    ["an http origin with TLS material", "http" as const, { rejectUnauthorized: true, identity: "127.0.0.1" }],
  ])("%s", (_label, scheme, tls) => {
    const error = refusal(() =>
      createNodeTransport({ origin: httpOrigin(scheme, "127.0.0.1", 6333), tls, maxSockets: 1, headers: {} }),
    );
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(
      "Invalid TLS settings: an https origin needs TLS material, and an http origin takes none",
    );
  });
});

describe("bounded, stoppable and never resent", () => {
  test("a 16 MiB answer against an 8 MiB cap raises too-large with no partial text, and the socket is closed", async () => {
    const listener = await httpListener(streamingAnswer(16 * MIB));
    const { transport, url } = connect(listener);
    const error = await failure(() => transport.request(get(url("/big"), { maxResponseBytes: 8 * MIB })));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).kind).toBe("too-large");
    expect(error.message).toBe(
      "The response exceeded the 8388608-byte limit for one response, so it was not read to the end",
    );
    expect(Object.keys(error)).not.toContain("text");
    await eventually(() => listener.open() === 0, "the server to see its socket closed");
  });

  test("an answer of exactly maxResponseBytes is read whole, and one byte more is too-large", async () => {
    const listener = await httpListener((request, response) => {
      response.writeHead(200);
      response.end("x".repeat(request.url === "/over" ? 101 : 100));
    });
    const { transport, url } = connect(listener);
    expect((await transport.request(get(url("/exact"), { maxResponseBytes: 100 }))).text).toHaveLength(100);
    const error = await failure(() => transport.request(get(url("/over"), { maxResponseBytes: 100 })));
    expect((error as TransportError).kind).toBe("too-large");
  });

  test("a deadline destroys the socket and raises timeout", async () => {
    const listener = await httpListener(() => {});
    const { transport, url } = connect(listener);
    const error = await failure(() => transport.request(get(url("/hold"), { signal: AbortSignal.timeout(100) })));
    expect((error as TransportError).kind).toBe("timeout");
    expect(error.message).toBe("The request did not finish within its time limit");
    await eventually(() => listener.open() === 0, "the held socket to close");
  });

  test("a caller's cancel destroys the socket and raises aborted, also when it rides with a deadline", async () => {
    const listener = await httpListener(() => {});
    const { transport, url } = connect(listener);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
    const error = await failure(() => transport.request(get(url("/hold"), { signal })));
    expect((error as TransportError).kind).toBe("aborted");
    expect(error.message).toBe("The request was cancelled");
    await eventually(() => listener.open() === 0, "the held socket to close");
  });

  test("an already-aborted signal is refused before any socket", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener);
    const error = await failure(() => transport.request(get(url("/"), { signal: AbortSignal.abort() })));
    expect((error as TransportError).kind).toBe("aborted");
    expect(listener.accepted()).toBe(0);
  });

  test("close() stops every request in flight or queued: each raises aborted, no request reaches the server after it, and no socket stays open", async () => {
    const listener = await httpListener(() => {});
    const { transport, url } = connect(listener, { maxSockets: 1 });
    const pending = [1, 2, 3].map(() => failure(() => transport.request(get(url("/hold")))));
    await eventually(() => listener.seen.length === 1, "the first request to arrive");
    transport.close();
    const errors = await Promise.all(pending);
    expect(errors.map((error) => (error as TransportError).kind)).toEqual(["aborted", "aborted", "aborted"]);
    expect(errors.map((error) => error.message)).toEqual([CLOSED, CLOSED, CLOSED]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(listener.seen).toHaveLength(1);
    await eventually(() => listener.open() === 0, "every socket to close");
  });

  test("a request cancelled while queued behind maxSockets opens no socket, then or later", async () => {
    const listener = await silentListener();
    const { transport, url } = connect(listener, { maxSockets: 1 });
    const first = failure(() => transport.request(get(url("/first"), { signal: AbortSignal.timeout(400) })));
    const controller = new AbortController();
    const queued = failure(() =>
      transport.request({ ...get(url("/queued"), { signal: controller.signal }), method: "POST", body: "{}" }),
    );
    await eventually(() => listener.accepted() === 1, "the first request's socket");
    controller.abort();
    expect(((await queued) as TransportError).kind).toBe("aborted");
    expect(((await first) as TransportError).kind).toBe("timeout");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(listener.accepted()).toBe(1);
  });

  test("a request queued behind maxSockets goes out once a socket is free", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener, { maxSockets: 1 });
    const answers = await Promise.all([1, 2, 3].map((n) => transport.request(get(url(`/${n}`)))));
    expect(answers.map(({ status }) => status)).toEqual([200, 200, 200]);
    expect(listener.seen.map(({ url: path }) => path)).toEqual(["/1", "/2", "/3"]);
    expect(listener.accepted()).toBe(1);
  });

  test("an answer lost on a reused socket is reported once and never resent", async () => {
    const listener = await httpListener((request, response, body) => {
      if (request.method === "POST") {
        request.socket.destroy();
        return;
      }
      jsonAnswer(200, "{}")(request, response, body);
    });
    const { transport, url } = connect(listener);
    await transport.request(get(url("/collections")));
    const error = await failure(() =>
      transport.request({ ...get(url("/collections/c/points")), method: "POST", body: '{"points":[]}' }),
    );
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).kind).toBe("network");
    expect(error.message).toMatch(/^The request failed before a complete response arrived( \([A-Z][A-Z0-9_]*\))?$/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(listener.seen.filter(({ method }) => method === "POST")).toHaveLength(1);
    expect(listener.accepted()).toBe(1);
  });

  test.each([
    ["a content-length answer", { "content-length": "100" }],
    ["a chunked answer", {}],
  ])("%s cut off after 10 bytes of its body is reported as lost at once, never as text", async (_label, headers) => {
    const listener = await httpListener((request, response) => {
      response.writeHead(200, { "content-type": "application/json", ...headers });
      response.write("x".repeat(10), () => setTimeout(() => request.socket.destroy(), 20));
    });
    const { transport, url } = connect(listener);
    const started = Date.now();
    const error = await failure(() => transport.request(get(url("/collections"))));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).kind).toBe("network");
    // The status line arrived and the body did not finish: a truncation, which a provider can tell from a
    // connection that never answered (the InfluxDB providers word it as a failure after the query was accepted).
    expect((error as TransportError).truncated).toBe(true);
    expect(error.message).toBe("The server ended the response before it was complete");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(listener.seen).toHaveLength(1);
  });

  test("a request after the server closed an idle keep-alive socket goes out on a new socket and succeeds", async () => {
    const listener = await httpListener((request, response, body) => {
      jsonAnswer(200, "{}")(request, response, body);
      response.on("finish", () => setTimeout(() => request.socket.destroy(), 20));
    });
    const { transport, url } = connect(listener);
    await transport.request(get(url("/")));
    await eventually(() => listener.open() === 0, "the server to close the idle socket");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await transport.request(get(url("/")))).status).toBe(200);
    expect(listener.accepted()).toBe(2);
  });

  // Qdrant closes an idle keep-alive socket after 5 s, and a request written on one as it closed was reset (#1419). The
  // listener here keeps its sockets for 60 s, so the socket that closes is closed by the transport.
  test(
    "an idle pooled socket is closed by the transport after IDLE_SOCKET_MS, and the next request opens a new one",
    async () => {
      const listener = await httpListener((request, response, body) => {
        request.socket.setKeepAlive(true);
        jsonAnswer(200, "{}", { "keep-alive": "timeout=60" })(request, response, body);
      });
      const { transport, url } = connect(listener);
      await transport.request(get(url("/")));
      const answered = Date.now();
      expect(listener.open()).toBe(1);
      await eventually(() => listener.open() === 0, "the transport to close its idle socket", IDLE_SOCKET_MS + 2000);
      const idle = Date.now() - answered;
      expect(idle).toBeGreaterThanOrEqual(IDLE_SOCKET_MS - 100);
      expect(idle).toBeLessThan(IDLE_SOCKET_MS + 900);
      expect((await transport.request(get(url("/")))).status).toBe(200);
      expect(listener.accepted()).toBe(2);
    },
    IDLE_SOCKET_MS + 6000,
  );

  test(
    "an answer that takes longer than IDLE_SOCKET_MS still arrives: only an idle socket is closed",
    async () => {
      const listener = await httpListener((request, response, body) => {
        setTimeout(() => jsonAnswer(200, '{"late":true}')(request, response, body), IDLE_SOCKET_MS + 500);
      });
      const { transport, url } = connect(listener);
      const answer = await transport.request(get(url("/"), { signal: AbortSignal.timeout(IDLE_SOCKET_MS + 3000) }));
      expect(answer.text).toBe('{"late":true}');
    },
    IDLE_SOCKET_MS + 6000,
  );

  test("a refused connection is a network failure naming the runtime's code and no URL", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { port } = listener;
    await listener.close();
    const origin = httpOrigin("http", "127.0.0.1", port);
    const transport = createNodeTransport({ origin, tls: null, maxSockets: 1, headers: { "api-key": SECRET } });
    transports.push(transport);
    const error = await failure(() =>
      transport.request(get(endpointUrl(origin, "/collections", new URLSearchParams({ token: SECRET })))),
    );
    expect((error as TransportError).kind).toBe("network");
    expect(error.message).toBe("The request failed before a complete response arrived (ECONNREFUSED)");
  });

  test("a header value with a line feed is refused before anything is sent, and the message repeats no value", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener, { headers: { "api-key": `${SECRET}\nx-injected: 1` } });
    const error = await failure(() => transport.request(get(url("/"))));
    expect((error as TransportError).kind).toBe("network");
    expect(error.message).toBe("The request failed before a complete response arrived (ERR_INVALID_CHAR)");
    expect(error.message).not.toContain(SECRET);
    expect(listener.accepted()).toBe(0);
  });
});

describe("redirects and content-encoding", () => {
  const ENCODED = (named: string) =>
    `The server answered with content-encoding ${named}, and this transport reads identity only, so the response was not read`;

  test("a 307 to another port is refused naming only the target origin, and the second listener sees nothing", async () => {
    const target = await httpListener(jsonAnswer(200, '{"result":true}'));
    const listener = await httpListener((_request, response) => {
      response.writeHead(307, {
        location: `http://127.0.0.1:${target.port}/collections/c/points?api-key=${SECRET}`,
      });
      response.end("moved");
    });
    const { transport, url } = connect(listener);
    const error = await failure(() =>
      transport.request({ ...get(url("/collections/c/points")), method: "POST", body: '{"points":[]}' }),
    );
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).kind).toBe("redirect");
    expect(error.message).toBe(
      `The server answered HTTP 307, a redirect to http://127.0.0.1:${target.port}, and redirects are not followed`,
    );
    expect(target.accepted()).toBe(0);
    await eventually(() => listener.open() === 0, "the redirect's socket to be released");
  });

  test.each([301, 302, 303, 307, 308])(
    "HTTP %p to the same origin is refused too, and not followed",
    async (status) => {
      const listener = await httpListener((_request, response) => {
        response.writeHead(status, { location: "/elsewhere" });
        response.end();
      });
      const { transport, url } = connect(listener);
      const error = await failure(() => transport.request(get(url("/"))));
      expect((error as TransportError).kind).toBe("redirect");
      expect(error.message).toBe(
        `The server answered HTTP ${status}, a redirect to http://127.0.0.1:${listener.port}, and redirects are not followed`,
      );
      expect(listener.seen).toHaveLength(1);
    },
  );

  test("a 3xx with no Location is refused naming the absence", async () => {
    const listener = await httpListener((_request, response) => {
      response.writeHead(300);
      response.end();
    });
    const { transport, url } = connect(listener);
    const error = await failure(() => transport.request(get(url("/"))));
    expect(error.message).toBe(
      "The server answered HTTP 300, a redirect with no Location header, and redirects are not followed",
    );
  });

  test("a gzip answer that would inflate to 1 GiB, about 1 MB on the wire, is refused naming the encoding, with nothing inflated and the socket closed", async () => {
    const bomb = await gzipOfZeros(1024 * MIB);
    expect(bomb.length).toBeLessThan(2 * MIB);
    const listener = await httpListener((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      response.end(bomb);
    });
    const { transport, url } = connect(listener);
    const before = process.memoryUsage().rss;
    const error = await failure(() => transport.request(get(url("/"), { maxResponseBytes: 8 * MIB })));
    expect((error as TransportError).kind).toBe("encoding");
    expect(error.message).toBe(ENCODED("gzip"));
    expect(listener.seen[0].headers["accept-encoding"]).toBe("identity");
    expect(process.memoryUsage().rss - before).toBeLessThan(256 * MIB);
    await eventually(() => listener.open() === 0, "the encoded answer's socket to close");
  }, 30_000);

  test.each(["identity", "IDENTITY"])("content-encoding %p is read", async (encoding) => {
    const listener = await httpListener(jsonAnswer(200, "{}", { "content-encoding": encoding }));
    const { transport, url } = connect(listener);
    expect((await transport.request(get(url("/")))).text).toBe("{}");
  });

  test("an encoding that is not a single token is described, never echoed", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}", { "content-encoding": `x-${SECRET}, gzip` }));
    const { transport, url } = connect(listener);
    const error = await failure(() => transport.request(get(url("/"))));
    expect((error as TransportError).kind).toBe("encoding");
    expect(error.message).toBe(ENCODED("that is not a single token"));
    expect(error.message).not.toContain(SECRET);
  });

  test("the module never imports node:zlib, so nothing it reads is ever inflated", () => {
    const source = readFileSync(join(import.meta.dir, "../../../../src/lib/db/http/node-transport.ts"), "utf8");
    expect(source).not.toMatch(/from "(node:)?zlib"|require\("(node:)?zlib"\)/);
  });
});
