/**
 * createNodeByteTransport, the byte transport on the shared core (byte transport design 3).
 *
 * Byte-exact wire assertions read a raw node:net listener (rawHttpListener), never a node:http server; every listener
 * counts the connections it accepts, so "no socket" and "one socket" are measured on the server side.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { DatabaseConfigError } from "@/lib/db/errors";
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import {
  createNodeByteTransport,
  createNodeTransport,
  type NodeByteRequest,
  type NodeByteTransport,
  type NodeByteTransportOptions,
  nodeTlsMaterial,
  selectedHeaders,
  TransportError,
} from "@/lib/db/http/node-transport";
import {
  closeAll,
  eventually,
  httpListener,
  httpsListener,
  jsonAnswer,
  makeCertificates,
  rawAnswer,
  rawHttpListener,
  type TransportCertificates,
} from "../../../helpers/node-transport-fixtures";

const MIB = 1024 * 1024;
const CLOSED = "The connection was closed, so the request did not complete";
const INVALID_METHOD = "Invalid method: this transport sends GET and HEAD only";
const INVALID_TARGET = "Invalid request target: expected a path and a query";
const INVALID_PATH =
  "Invalid request path: expected an absolute path of unreserved characters, slashes and upper-case percent escapes";
const INVALID_QUERY =
  "Invalid request query: expected name=value pairs of unreserved characters and upper-case percent escapes, joined by &";
const TARGET_TOO_LONG = "Invalid request target: the path and query exceed 16384 bytes";

let certificates: TransportCertificates;
beforeAll(() => {
  certificates = makeCertificates();
}, 30_000);

const transports: NodeByteTransport[] = [];
afterEach(async () => {
  for (const transport of transports.splice(0)) transport.close();
  await closeAll();
});

function connect(
  listener: { readonly port: number },
  extra: Partial<NodeByteTransportOptions> = {},
  host = "127.0.0.1",
): NodeByteTransport {
  const origin = httpOrigin("http", host, listener.port);
  const transport = createNodeByteTransport({ origin, tls: null, maxSockets: 4, headers: {}, ...extra });
  transports.push(transport);
  return transport;
}

function get(path: string, extra: Partial<NodeByteRequest> = {}): NodeByteRequest {
  return {
    method: "GET",
    target: { path, query: "" },
    signal: AbortSignal.timeout(5000),
    maxResponseBytes: MIB,
    ...extra,
  };
}

/** The request line and the header lines of a recorded head. */
function lines(head: Buffer): string[] {
  return head.toString("latin1").split("\r\n");
}

const OK = (): Buffer => rawAnswer("200 OK", ["content-length: 2"], "ok");

async function failure(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the request to fail");
}

describe("refusals when the transport is built", () => {
  test.each([
    ["maxSockets 0", { maxSockets: 0 }, "Invalid maxSockets: expected a positive integer"],
    [
      "an http origin with TLS material",
      { tls: { rejectUnauthorized: true, identity: "127.0.0.1" } },
      "Invalid TLS settings: an https origin needs TLS material, and an http origin takes none",
    ],
    [
      "a connection host header",
      { headers: { Host: "elsewhere" } },
      "Invalid headers: host is set by the transport for each request",
    ],
    [
      "an owned per-request header name",
      { requestHeaderNames: ["authorization"] },
      "Invalid requestHeaderNames: authorization is set by the transport or the connection",
    ],
  ] as const)("%s", async (_label, extra, sentence) => {
    const listener = await rawHttpListener(OK);
    let error: Error | undefined;
    try {
      connect(listener, extra as Partial<NodeByteTransportOptions>);
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error?.message).toBe(sentence);
    expect(listener.accepted()).toBe(0);
  });
});

describe("request refusals before any socket", () => {
  test.each([
    ["a POST", { method: "POST" as unknown as "GET" }, INVALID_METHOD],
    ["maxResponseBytes 0", { maxResponseBytes: 0 }, "Invalid maxResponseBytes: expected a positive integer"],
    [
      "an unlisted request header",
      { headers: { "x-other": "1" } },
      "Invalid request headers: a header this transport does not list was given",
    ],
    ["a null target", { target: null as unknown as NodeByteRequest["target"] }, INVALID_TARGET],
    ["a target without a query", { target: { path: "/b" } as unknown as NodeByteRequest["target"] }, INVALID_TARGET],
    ["a relative path", { target: { path: "b", query: "" } }, INVALID_PATH],
    ["a path starting with two slashes", { target: { path: "//b", query: "" } }, INVALID_PATH],
    ["a space in the path", { target: { path: "/b k", query: "" } }, INVALID_PATH],
    ["a fragment in the path", { target: { path: "/b#f", query: "" } }, INVALID_PATH],
    ["a query mark in the path", { target: { path: "/b?x", query: "" } }, INVALID_PATH],
    ["a lower-case escape", { target: { path: "/b/%2f", query: "" } }, INVALID_PATH],
    ["a bare percent sign", { target: { path: "/b/%", query: "" } }, INVALID_PATH],
    ["a raw non-ASCII character", { target: { path: "/b/é", query: "" } }, INVALID_PATH],
    ["a query without =", { target: { path: "/b", query: "a" } }, INVALID_QUERY],
    ["a query with two =", { target: { path: "/b", query: "a=b=c" } }, INVALID_QUERY],
    ["a query starting with &", { target: { path: "/b", query: "&a=b" } }, INVALID_QUERY],
    ["a lower-case escape in the query", { target: { path: "/b", query: "a=%2f" } }, INVALID_QUERY],
    ["a plus in the query", { target: { path: "/b", query: "a=b+c" } }, INVALID_QUERY],
    ["a 16385-byte path-only target", { target: { path: `/${"a".repeat(16384)}`, query: "" } }, TARGET_TOO_LONG],
    ["a 16385-byte target with a query", { target: { path: "/b", query: `a=${"x".repeat(16380)}` } }, TARGET_TOO_LONG],
  ] as const)("%s", async (_label, override, sentence) => {
    const listener = await rawHttpListener(OK);
    const transport = connect(listener);
    const error = await failure(() => transport.request(get("/b", override as Partial<NodeByteRequest>)));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(sentence);
    expect(listener.accepted()).toBe(0);
  });

  test.each([
    ["an array", Object.assign([], { path: "/b", query: "" })],
    [
      "a class instance",
      new (class Target {
        readonly path = "/b";
        readonly query = "";
      })(),
    ],
    [
      "a Map",
      new Map([
        ["path", "/b"],
        ["query", ""],
      ]),
    ],
    ["a string", "/b"],
  ])("a target that is %s, not a plain object, is refused", async (_label, target) => {
    const listener = await rawHttpListener(OK);
    const transport = connect(listener);
    const error = await failure(() =>
      transport.request(get("/b", { target: target as unknown as NodeByteRequest["target"] })),
    );
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(INVALID_TARGET);
    expect(listener.accepted()).toBe(0);
  });

  test("a target with a null prototype is a plain object and is sent", async () => {
    const listener = await rawHttpListener(OK);
    const target = Object.assign(Object.create(null) as object, {
      path: "/b/k",
      query: "",
    }) as NodeByteRequest["target"];
    await expect(connect(listener).request(get("/b", { target }))).resolves.toMatchObject({ status: 200 });
    expect(lines(listener.heads[0])[0]).toBe("GET /b/k HTTP/1.1");
  });

  test("the checks run in order: a POST with a bad path names the method", async () => {
    const listener = await rawHttpListener(OK);
    const error = await failure(() => connect(listener).request(get("b", { method: "POST" as unknown as "GET" })));
    expect(error.message).toBe(INVALID_METHOD);
  });

  test("a closed transport refuses with the closed sentence", async () => {
    const listener = await rawHttpListener(OK);
    const transport = connect(listener);
    transport.close();
    const error = await failure(() => transport.request(get("/b")));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).kind).toBe("aborted");
    expect(error.message).toBe(CLOSED);
    expect(listener.accepted()).toBe(0);
  });

  test("an already-aborted signal is refused as a cancel", async () => {
    const listener = await rawHttpListener(OK);
    const controller = new AbortController();
    controller.abort();
    const error = await failure(() => connect(listener).request(get("/b", { signal: controller.signal })));
    expect((error as TransportError).kind).toBe("aborted");
    expect(error.message).toBe("The request was cancelled");
    expect(listener.accepted()).toBe(0);
  });

  test("a request node:http refuses as it is written fails alone and frees its socket slot for the next", async () => {
    const listener = await rawHttpListener(OK);
    const transport = connect(listener, { maxSockets: 1, headers: { "x-conn": "a\nx-injected: 1" } });
    const sentence = "The request failed before a complete response arrived (ERR_INVALID_CHAR)";
    const [first, second] = await Promise.all([
      failure(() => transport.request(get("/b/1"))),
      failure(() => transport.request(get("/b/2"))),
    ]);
    expect([first.message, second.message]).toEqual([sentence, sentence]);
    expect(listener.accepted()).toBe(0);
  });
});

describe("the exact request target", () => {
  test.each([
    ["/b/sp/./dot.txt", ""],
    ["/b/x/../y.txt", ""],
    ["/b/%2E%2E/k", ""],
    ["/b/a%2Fb", ""],
    ["/b//k", ""],
    ["/b", "list-type=2&prefix=a%20b&delimiter=%2F"],
    ["/b", "location="],
    ["/b", "list-type=2&prefix=&delimiter=%2F"],
  ])("%s ? %s arrives byte for byte", async (path, query) => {
    const listener = await rawHttpListener(OK);
    const answer = await connect(listener).request(get(path, { target: { path, query } }));
    expect(answer.status).toBe(200);
    expect(lines(listener.heads[0])[0]).toBe(`GET ${query === "" ? path : `${path}?${query}`} HTTP/1.1`);
  });

  test("a path-only target of exactly 16384 bytes is sent", async () => {
    const listener = await rawHttpListener(OK);
    const path = `/${"a".repeat(16383)}`;
    expect((await connect(listener).request(get(path))).status).toBe(200);
    expect(lines(listener.heads[0])[0]).toBe(`GET ${path} HTTP/1.1`);
  });

  test("a target with a query of exactly 16384 bytes, the ? counted, is sent", async () => {
    const listener = await rawHttpListener(OK);
    const query = `a=${"x".repeat(16379)}`;
    expect(`/b?${query}`).toHaveLength(16384);
    const answer = await connect(listener).request(get("/b", { target: { path: "/b", query } }));
    expect(answer.status).toBe(200);
    expect(lines(listener.heads[0])[0]).toBe(`GET /b?${query} HTTP/1.1`);
  });
});

describe("Host", () => {
  test("the transport sends host exactly once, with the connection and request headers before it", async () => {
    const listener = await rawHttpListener(OK);
    const transport = connect(listener, { headers: { "X-Conn": "c" }, requestHeaderNames: ["range"] });
    await transport.request(get("/b/k", { headers: { range: "bytes=0-9" } }));
    expect(lines(listener.heads[0])).toEqual([
      "GET /b/k HTTP/1.1",
      "x-conn: c",
      "range: bytes=0-9",
      `host: 127.0.0.1:${listener.port}`,
      "accept-encoding: identity",
      "Connection: keep-alive",
    ]);
  });

  test("an IPv6 literal origin dials ::1 and sends a bracketed host once", async () => {
    const listener = await rawHttpListener(OK, "::1");
    await connect(listener, {}, "[::1]").request(get("/b/k"));
    const hosts = lines(listener.heads[0]).filter((line) => line.toLowerCase().startsWith("host:"));
    expect(hosts).toEqual([`host: [::1]:${listener.port}`]);
  });
});

describe("HEAD and the byte answer", () => {
  test("a HEAD answered with content-length 1000 and no body resolves empty, and the next GET reuses its socket", async () => {
    const listener = await rawHttpListener((_head, index) =>
      index === 0 ? rawAnswer("200 OK", ["content-length: 1000"]) : OK(),
    );
    const transport = connect(listener);
    const head = await transport.request({ ...get("/b/k"), method: "HEAD" });
    expect({ status: head.status, length: head.bytes.length, truncated: head.truncated }).toEqual({
      status: 200,
      length: 0,
      truncated: false,
    });
    expect(lines(listener.heads[0])[0]).toBe("HEAD /b/k HTTP/1.1");
    expect((await transport.request(get("/b/k"))).bytes.toString()).toBe("ok");
    expect(listener.accepted()).toBe(1);
  });

  test("1 MiB of random bytes arrives unchanged, with the answer's fields", async () => {
    const body = randomBytes(MIB);
    const listener = await rawHttpListener(() =>
      rawAnswer("200 OK", [`content-length: ${MIB}`, "content-type: application/octet-stream"], body),
    );
    const answer = await connect(listener).request(get("/b/k", { maxResponseBytes: 2 * MIB }));
    const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    expect(sha(answer.bytes)).toBe(sha(body));
    expect({
      contentType: answer.contentType,
      contentEncoding: answer.contentEncoding,
      retryAfter: answer.retryAfter,
      headers: answer.headers,
      headersTruncated: answer.headersTruncated,
      truncated: answer.truncated,
    }).toEqual({
      contentType: "application/octet-stream",
      contentEncoding: null,
      retryAfter: null,
      headers: [],
      headersTruncated: false,
      truncated: false,
    });
  });

  test("content-type, content-encoding and retry-after are cut to 1024, 64 and 64 characters", async () => {
    const listener = await rawHttpListener(() =>
      rawAnswer("503 Slow Down", [
        `content-type: ${"t".repeat(1100)}`,
        `content-encoding: ${"e".repeat(100)}`,
        `retry-after: ${"9".repeat(100)}`,
        "content-length: 0",
      ]),
    );
    const answer = await connect(listener).request(get("/b/k"));
    expect({
      status: answer.status,
      contentType: answer.contentType,
      contentEncoding: answer.contentEncoding,
      retryAfter: answer.retryAfter,
    }).toEqual({
      status: 503,
      contentType: "t".repeat(1024),
      contentEncoding: "e".repeat(64),
      retryAfter: "9".repeat(64),
    });
  });

  test("a body over maxResponseBytes without truncateAt fails as too-large with today's message", async () => {
    const listener = await rawHttpListener(() =>
      rawAnswer("200 OK", ["content-length: 2048"], Buffer.alloc(2048, 0x61)),
    );
    const error = await failure(() => connect(listener).request(get("/b/k", { maxResponseBytes: 1024 })));
    expect((error as TransportError).kind).toBe("too-large");
    expect(error.message).toBe(
      "The response exceeded the 1024-byte limit for one response, so it was not read to the end",
    );
  });

  test("a stored gzip body comes back as the exact bytes sent, with contentEncoding, never decoded", async () => {
    const stored = gzipSync(
      Buffer.from(Array.from({ length: 2000 }, (_, index) => `{"line":${index}}\n`).join(""), "utf8"),
    );
    const answer = (): Buffer =>
      rawAnswer("200 OK", ["content-encoding: gzip", `content-length: ${stored.length}`], stored);
    const listener = await rawHttpListener(answer);
    const received = await connect(listener).request(get("/b/lines.ndjson.gz"));
    expect(received.contentEncoding).toBe("gzip");
    expect(received.bytes.equals(stored)).toBe(true);
  });

  test("the same gzip answer through createNodeTransport is still refused with today's encoding sentence", async () => {
    const stored = gzipSync(Buffer.from("{}\n", "utf8"));
    const listener = await rawHttpListener(() =>
      rawAnswer("200 OK", ["content-encoding: gzip", `content-length: ${stored.length}`], stored),
    );
    const origin = httpOrigin("http", "127.0.0.1", listener.port);
    const text = createNodeTransport({ origin, tls: null, maxSockets: 1, headers: {} });
    try {
      const error = await failure(() =>
        text.request({
          method: "GET",
          url: endpointUrl(origin, "/b/lines.ndjson.gz"),
          signal: AbortSignal.timeout(5000),
          maxResponseBytes: MIB,
        }),
      );
      expect(error.message).toBe(
        "The server answered with content-encoding gzip, and this transport reads identity only, so the response was not read",
      );
    } finally {
      text.close();
    }
  });
});

describe("deadline, cancel and close", () => {
  test("a deadline fails as timeout and destroys the socket", async () => {
    const held = await httpListener(() => {});
    const error = await failure(() => connect(held).request(get("/b/k", { signal: AbortSignal.timeout(100) })));
    expect((error as TransportError).kind).toBe("timeout");
    await eventually(() => held.open() === 0, "the timed-out socket to close");
  });

  test("a cancel fails as aborted and destroys the socket", async () => {
    const held = await httpListener(() => {});
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const error = await failure(() => connect(held).request(get("/b/k", { signal: controller.signal })));
    expect({ kind: (error as TransportError).kind, message: error.message }).toEqual({
      kind: "aborted",
      message: "The request was cancelled",
    });
    await eventually(() => held.open() === 0, "the cancelled socket to close");
  });

  test("close() stops a request in flight and the socket", async () => {
    const held = await httpListener(() => {});
    const transport = connect(held);
    const pending = failure(() => transport.request(get("/b/k")));
    await eventually(() => held.accepted() === 1, "the request to reach the listener");
    transport.close();
    const error = await pending;
    expect({ kind: (error as TransportError).kind, message: error.message }).toEqual({
      kind: "aborted",
      message: CLOSED,
    });
    await eventually(() => held.open() === 0, "the closed socket to close");
  });
});

describe("TLS", () => {
  test("a GET over https with a verify-full CA reaches the listener, and the explicit Host leaves the server name alone", async () => {
    const listener = await httpsListener(certificates.local, jsonAnswer(200, "{}"));
    const origin = httpOrigin("https", "localhost", listener.port);
    const transport = createNodeByteTransport({
      origin,
      tls: nodeTlsMaterial({ mode: "verify-full", caCert: certificates.ca }, "localhost"),
      maxSockets: 1,
      headers: {},
    });
    transports.push(transport);
    const answer = await transport.request(get("/b/k"));
    expect({ status: answer.status, body: answer.bytes.toString() }).toEqual({ status: 200, body: "{}" });
    expect({
      url: listener.seen[0].url,
      host: listener.seen[0].headers.host,
      servername: listener.seen[0].servername,
    }).toEqual({
      url: "/b/k",
      host: `localhost:${listener.port}`,
      servername: "localhost",
    });
  });
});

const INVALID_SELECTION =
  "Invalid responseHeaders: expected at most 32 lower-case names and 8 lower-case prefixes ending in a hyphen";
const NEVER_RETURNED = "Invalid responseHeaders: location and set-cookie are never returned";

function refusal(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw");
}

/** An answer with these header lines, a zero-length body and a 200. */
function headerAnswer(headerLines: readonly string[]): () => Buffer {
  return () => rawAnswer("200 OK", [...headerLines, "content-length: 0"]);
}

describe("the response-header selection, checked when the transport is built", () => {
  test.each([
    ["33 names", { names: Array.from({ length: 33 }, (_, index) => `x-h${index}`) }, INVALID_SELECTION],
    ["9 prefixes", { names: [], prefixes: Array.from({ length: 9 }, (_, index) => `x-p${index}-`) }, INVALID_SELECTION],
    ["an upper-case name", { names: ["X-Upper"] }, INVALID_SELECTION],
    ["a name with a space", { names: ["bad name"] }, INVALID_SELECTION],
    ["names that are not a list", { names: "etag" as unknown as string[] }, INVALID_SELECTION],
    ["prefixes that are not a list", { names: [], prefixes: "x-amz-" as unknown as string[] }, INVALID_SELECTION],
    ["a name that is not a string", { names: [7 as unknown as string] }, INVALID_SELECTION],
    ["a prefix that is not a string", { names: [], prefixes: [7 as unknown as string] }, INVALID_SELECTION],
    ["a two-character prefix", { names: [], prefixes: ["x-"] }, INVALID_SELECTION],
    ["a prefix without a closing hyphen", { names: [], prefixes: ["xamz"] }, INVALID_SELECTION],
    ["an upper-case prefix", { names: [], prefixes: ["X-Amz-"] }, INVALID_SELECTION],
    ["location", { names: ["location"] }, NEVER_RETURNED],
    ["set-cookie", { names: ["etag", "set-cookie"] }, NEVER_RETURNED],
  ] as const)("%s is refused before any socket", async (_label, responseHeaders, sentence) => {
    const listener = await rawHttpListener(OK);
    const origin = httpOrigin("http", "127.0.0.1", listener.port);
    const error = refusal(() =>
      createNodeByteTransport({ origin, tls: null, maxSockets: 1, headers: {}, responseHeaders }),
    );
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(sentence);
    expect(listener.accepted()).toBe(0);
  });

  test("32 names and 8 prefixes of three characters are accepted", () => {
    const origin = httpOrigin("http", "127.0.0.1", 9000);
    expect(() => {
      transports.push(
        createNodeByteTransport({
          origin,
          tls: null,
          maxSockets: 1,
          headers: {},
          responseHeaders: {
            names: Array.from({ length: 32 }, (_, index) => `x-h${index}`),
            prefixes: Array.from({ length: 8 }, (_, index) => `p${index}-`),
          },
        }),
      );
    }).not.toThrow();
  });
});

describe("the response headers returned", () => {
  test("received order and duplicates are kept, names lower-cased, and location and set-cookie never returned", async () => {
    const listener = await rawHttpListener(
      headerAnswer([
        "x-amz-meta-a: 1",
        'ETag: "e1"',
        "x-amz-meta-a: 2",
        'etag: "e2"',
        "x-other: z",
        "Location: http://127.0.0.1:1/b/k?token=secret",
        "Set-Cookie: session=1",
      ]),
    );
    const transport = connect(listener, { responseHeaders: { names: ["etag"], prefixes: ["x-amz-meta-", "set-"] } });
    const answer = await transport.request(get("/b/k"));
    expect(answer.headers).toEqual([
      ["x-amz-meta-a", "1"],
      ["etag", '"e1"'],
      ["x-amz-meta-a", "2"],
      ["etag", '"e2"'],
    ]);
    expect(answer.headersTruncated).toBe(false);
  });

  test("without a selection no header is returned", async () => {
    const listener = await rawHttpListener(headerAnswer(['etag: "e1"']));
    const answer = await connect(listener).request(get("/b/k"));
    expect({ headers: answer.headers, headersTruncated: answer.headersTruncated }).toEqual({
      headers: [],
      headersTruncated: false,
    });
  });

  test("65 selected headers give the first 64 and headersTruncated", async () => {
    const listener = await rawHttpListener(
      headerAnswer(Array.from({ length: 65 }, (_, index) => `x-amz-meta-h${index}: v`)),
    );
    const answer = await connect(listener, { responseHeaders: { names: [], prefixes: ["x-amz-meta-"] } }).request(
      get("/b/k"),
    );
    expect(answer.headers.length).toBe(64);
    expect(answer.headers[63]).toEqual(["x-amz-meta-h63", "v"]);
    expect(answer.headersTruncated).toBe(true);
  });

  test("exactly 64 selected headers come back whole with headersTruncated false", async () => {
    const listener = await rawHttpListener(
      headerAnswer(Array.from({ length: 64 }, (_, index) => `x-amz-meta-h${index}: v`)),
    );
    const answer = await connect(listener, { responseHeaders: { names: [], prefixes: ["x-amz-meta-"] } }).request(
      get("/b/k"),
    );
    expect({ count: answer.headers.length, headersTruncated: answer.headersTruncated }).toEqual({
      count: 64,
      headersTruncated: false,
    });
  });

  test("a 2000-character value is cut to 1024 with the flag, and a 1024-character value is kept whole", async () => {
    const listener = await rawHttpListener(headerAnswer([`x-amz-meta-long: ${"v".repeat(2000)}`]));
    const long = await connect(listener, { responseHeaders: { names: ["x-amz-meta-long"] } }).request(get("/b/k"));
    expect({ value: long.headers[0][1], headersTruncated: long.headersTruncated }).toEqual({
      value: "v".repeat(1024),
      headersTruncated: true,
    });
    const exact = await rawHttpListener(headerAnswer([`x-amz-meta-long: ${"v".repeat(1024)}`]));
    const whole = await connect(exact, { responseHeaders: { names: ["x-amz-meta-long"] } }).request(get("/b/k"));
    expect({ value: whole.headers[0][1], headersTruncated: whole.headersTruncated }).toEqual({
      value: "v".repeat(1024),
      headersTruncated: false,
    });
  });

  test("a UTF-8 value arrives as its latin1 reading", async () => {
    const listener = await rawHttpListener(headerAnswer(["x-amz-meta-city: café"]));
    const answer = await connect(listener, { responseHeaders: { names: ["x-amz-meta-city"] } }).request(get("/b/k"));
    expect(answer.headers).toEqual([["x-amz-meta-city", "cafÃ©"]]);
  });

  test("content-type is cut to 1024 characters, and of two content-type lines the first is read", async () => {
    const long = await rawHttpListener(headerAnswer([`content-type: text/${"x".repeat(2000)}`]));
    expect((await connect(long).request(get("/b/k"))).contentType?.length).toBe(1024);
    const twice = await rawHttpListener(headerAnswer(["content-type: text/plain", "content-type: application/json"]));
    expect((await connect(twice).request(get("/b/k"))).contentType).toBe("text/plain");
  });

  test("a 100-character retry-after is cut to 64", async () => {
    const listener = await rawHttpListener(headerAnswer([`retry-after: ${"7".repeat(100)}`]));
    expect((await connect(listener).request(get("/b/k"))).retryAfter).toBe("7".repeat(64));
  });

  test("a 206 of a stored gzip object returns its content-range and its bytes undecoded", async () => {
    const stored = gzipSync(
      Buffer.from(Array.from({ length: 2000 }, (_, index) => `{"line":${index}}\n`).join(""), "utf8"),
    );
    const part = stored.subarray(0, 100);
    expect(part.length).toBe(100);
    const listener = await rawHttpListener(() =>
      rawAnswer(
        "206 Partial Content",
        ["content-encoding: gzip", `content-range: bytes 0-99/${stored.length}`, "content-length: 100"],
        part,
      ),
    );
    const transport = connect(listener, {
      responseHeaders: { names: ["content-range"] },
      requestHeaderNames: ["range"],
    });
    const answer = await transport.request(get("/b/k.gz", { headers: { range: "bytes=0-99" } }));
    expect({
      status: answer.status,
      contentEncoding: answer.contentEncoding,
      headers: answer.headers,
      same: answer.bytes.equals(part),
    }).toEqual({
      status: 206,
      contentEncoding: "gzip",
      headers: [["content-range", `bytes 0-99/${stored.length}`]],
      same: true,
    });
  });
});

describe("the 16384-character total of the selected headers", () => {
  // A header block this large is refused by both runtimes' HTTP parsers before any transport sees it, so the total is
  // measured on the selection itself with a raw header list as the runtime would hand it over.
  const selection = { names: new Set<string>(), prefixes: ["x-amz-meta-"] };
  // Sixteen 13-character names with 1011-character values are 16 x 1024 = 16384 characters.
  const sixteen = Array.from({ length: 16 }, (_, index) => [
    `X-Amz-Meta-${String(index).padStart(2, "0")}`,
    "v".repeat(1011),
  ]).flat();

  test("names and values of exactly 16384 characters in all are kept", () => {
    const { headers, truncated } = selectedHeaders(sixteen, selection);
    expect({ count: headers.length, first: headers[0][0], truncated }).toEqual({
      count: 16,
      first: "x-amz-meta-00",
      truncated: false,
    });
  });

  test("one more selected header past the total is dropped with the flag", () => {
    const { headers, truncated } = selectedHeaders([...sixteen, "x-amz-meta-16", "v"], selection);
    expect({ count: headers.length, truncated }).toEqual({ count: 16, truncated: true });
  });

  test("an unselected header past the total costs nothing", () => {
    const { headers, truncated } = selectedHeaders([...sixteen, "x-other", "v"], selection);
    expect({ count: headers.length, truncated }).toEqual({ count: 16, truncated: false });
  });
});
