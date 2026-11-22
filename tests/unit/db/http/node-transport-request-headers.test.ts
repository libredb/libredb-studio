/**
 * Per-request headers on the shared transport, against a local listener (Databend design 3.1, PR A).
 *
 * A transport names the headers a request may carry in `requestHeaderNames`, a closed list of lower-case names; a name
 * the transport or the connection owns is refused when the transport is built. Per request, a name the list does not
 * hold, or a value outside visible ASCII and space or over 1024 bytes, is refused before any socket: the listener
 * counts the connections it accepts, so "no socket" is measured. A request with no headers sends exactly the header set
 * it sent before the option existed, so no shipped provider changes on the wire.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import {
  createNodeTransport,
  type NodeRequest,
  type NodeTransport,
  type NodeTransportOptions,
} from "@/lib/db/http/node-transport";
import {
  closeAll,
  type Handler,
  httpListener,
  jsonAnswer,
  type Listener,
} from "../../../helpers/node-transport-fixtures";
import { ALLOWS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";

const SECRET = "node-transport-request-headers-secret";
const MIB = 1024 * 1024;
const LISTED = ["x-databend-session", "x-databend-query-id"] as const;

const transports: NodeTransport[] = [];
afterEach(async () => {
  for (const transport of transports.splice(0)) transport.close();
  await closeAll();
});

function connect(listener: Listener, extra: Partial<NodeTransportOptions> = {}) {
  const origin = httpOrigin("http", "127.0.0.1", listener.port, ALLOWS_PRIVATE_HOSTS);
  const transport = createNodeTransport({
    origin,
    tls: null,
    maxSockets: 4,
    headers: { authorization: SECRET, accept: "application/json" },
    ...extra,
  });
  transports.push(transport);
  return { transport, url: (path: string) => endpointUrl(origin, path) };
}

function build(requestHeaderNames: readonly string[]): () => NodeTransport {
  return () =>
    createNodeTransport({
      origin: httpOrigin("http", "127.0.0.1", 1, ALLOWS_PRIVATE_HOSTS),
      tls: null,
      maxSockets: 1,
      headers: { accept: "application/json" },
      requestHeaderNames,
    });
}

function post(url: string, extra: Partial<NodeRequest> = {}): NodeRequest {
  return { method: "POST", url, signal: AbortSignal.timeout(5000), maxResponseBytes: MIB, ...extra };
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (caught) {
    return caught as Error;
  }
  throw new Error("expected a refusal");
}

/** Waits long enough for a socket the transport might have opened to reach the listener. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

/** A JSON answer that also records the header lines exactly as they arrived, names in their sent spelling. */
function rawRecorder(raw: string[][]): Handler {
  const answer = jsonAnswer(200, "{}");
  return (request, response, body) => {
    raw.push([...request.rawHeaders]);
    answer(request, response, body);
  };
}

const OWNED_NAMES = [
  "host",
  "content-length",
  "content-type",
  "content-encoding",
  "transfer-encoding",
  "accept-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "expect",
  "authorization",
  "proxy-authorization",
  "proxy-connection",
  // The connection's own header, set once in `headers` by build().
  "accept",
];

describe("requestHeaderNames at creation", () => {
  test.each(OWNED_NAMES)("refuses %s in requestHeaderNames at creation", (name) => {
    expect(build([...LISTED, name])).toThrow(DatabaseConfigError);
    expect(build([...LISTED, name])).toThrow(
      `Invalid requestHeaderNames: ${name} is set by the transport or the connection`,
    );
  });

  test("a connection header is refused whatever spelling the connection gave it", () => {
    const create = () =>
      createNodeTransport({
        origin: httpOrigin("http", "127.0.0.1", 1, ALLOWS_PRIVATE_HOSTS),
        tls: null,
        maxSockets: 1,
        headers: { "X-Databend-Warehouse": "default" },
        requestHeaderNames: ["x-databend-warehouse"],
      });
    expect(create).toThrow(
      "Invalid requestHeaderNames: x-databend-warehouse is set by the transport or the connection",
    );
  });

  test.each(["X-Databend-Session", "x databend", "", "x-databend-session\r\nx-evil", "x-é"])(
    "refuses %p, which is not a lower-case header name, without repeating it",
    (name) => {
      let error: unknown;
      try {
        build([name])();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect((error as Error).message).toBe("Invalid requestHeaderNames: expected lower-case header names");
    },
  );

  test.each([
    ["a string", "x-databend-session"],
    ["an array holding a number", ["x-databend-session", 7]],
    ["a sparse array", Object.assign(new Array(2), { 0: "x-databend-session" })],
  ])("refuses %s as requestHeaderNames at creation", (_label, names) => {
    const create = build(names as unknown as readonly string[]);
    expect(create).toThrow(DatabaseConfigError);
    expect(create).toThrow("Invalid requestHeaderNames: expected lower-case header names");
  });

  test("positive control: names the transport and the connection do not own are accepted", () => {
    expect(build([...LISTED, "x-databend-route-hint", "x-databend-sticky-node", "cookie"])).not.toThrow();
    expect(build([])).not.toThrow();
  });
});

describe("per-request headers", () => {
  test("refuses an unlisted per-request name before any socket", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener, { requestHeaderNames: LISTED });
    const unlisted: Record<string, string>[] = [
      { "x-other": "1" },
      { "X-Databend-Session": "abc" },
      { authorization: "Basic other" },
    ];
    const errors = await Promise.all(
      unlisted.map((headers) => refusal(transport.request(post(url("/v1/query"), { body: "{}", headers })))),
    );
    for (const error of errors) {
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toBe("Invalid request headers: a header this transport does not list was given");
      expect(error.message).not.toContain("other");
    }
    await settled();
    expect(listener.accepted()).toBe(0);
    // Positive control: the listed name in its listed spelling goes out.
    await transport.request(post(url("/v1/query"), { body: "{}", headers: { "x-databend-session": "abc" } }));
    expect(listener.accepted()).toBe(1);
    expect(listener.seen[0].headers["x-databend-session"]).toBe("abc");
  });

  test("refuses CR, LF, non-ASCII and over-1024-byte values before any socket", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener, { requestHeaderNames: LISTED });
    const values: unknown[] = [
      "a\rb",
      "a\nb",
      "a\r\nx-evil: 1",
      "tab\there",
      "nul\u0000",
      "del\u007f",
      "ü",
      "€",
      "x".repeat(1025),
      7,
    ];
    const errors = await Promise.all(
      values.map((value) => {
        const headers = { "x-databend-query-id": value } as unknown as Record<string, string>;
        return refusal(transport.request(post(url("/v1/query"), { body: "{}", headers })));
      }),
    );
    for (const error of errors) {
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toBe(
        "Invalid request headers: the value of x-databend-query-id must be visible ASCII or space, at most 1024 bytes",
      );
    }
    await settled();
    expect(listener.accepted()).toBe(0);
    // Positive control: a value of exactly 1024 visible characters, spaces included, and an empty one go out.
    const edge = `a ~!${"x".repeat(1020)}`;
    await transport.request(post(url("/v1/query"), { body: "{}", headers: { "x-databend-query-id": edge } }));
    await transport.request(post(url("/v1/query"), { body: "{}", headers: { "x-databend-query-id": "" } }));
    expect(listener.seen.map(({ headers }) => headers["x-databend-query-id"])).toEqual([edge, ""]);
  });

  test("sends listed headers and keeps accept-encoding identity and the transport's content-type", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener, { requestHeaderNames: LISTED });
    await transport.request(
      post(url("/v1/query"), {
        body: '{"sql":"SELECT 1"}',
        headers: { "x-databend-session": "c2Vzc2lvbg==", "x-databend-query-id": "0123456789abcdef0123456789abcdef" },
      }),
    );
    await transport.request(post(url("/v1/query"), { form: { q: "x" }, headers: { "x-databend-session": "s" } }));
    const [json, form] = listener.seen;
    expect(json.headers["x-databend-session"]).toBe("c2Vzc2lvbg==");
    expect(json.headers["x-databend-query-id"]).toBe("0123456789abcdef0123456789abcdef");
    expect(json.headers["accept-encoding"]).toBe("identity");
    expect(json.headers["content-type"]).toBe("application/json");
    expect(json.headers["content-length"]).toBe(String('{"sql":"SELECT 1"}'.length));
    expect(json.headers.authorization).toBe(SECRET);
    expect(json.headers.accept).toBe("application/json");
    expect(form.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(form.headers["accept-encoding"]).toBe("identity");
    expect(form.headers["x-databend-session"]).toBe("s");
  });

  test("a header of one request is absent from the next", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener, { requestHeaderNames: LISTED });
    await transport.request(post(url("/v1/query"), { body: "{}", headers: { "x-databend-query-id": "first" } }));
    await transport.request(post(url("/v1/query"), { body: "{}" }));
    await transport.request(post(url("/v1/query"), { body: "{}", headers: { "x-databend-session": "third" } }));
    const [first, second, third] = listener.seen;
    expect(first.headers["x-databend-query-id"]).toBe("first");
    expect(second.headers["x-databend-query-id"]).toBeUndefined();
    expect(second.headers["x-databend-session"]).toBeUndefined();
    expect(third.headers["x-databend-query-id"]).toBeUndefined();
    expect(third.headers["x-databend-session"]).toBe("third");
    // The three went over one pooled socket, so nothing per request stuck to the connection.
    expect(listener.accepted()).toBe(1);
  });

  test("a transport without requestHeaderNames refuses any per-request header", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener);
    const error = await refusal(
      transport.request(post(url("/v1/query"), { body: "{}", headers: { "x-databend-session": "abc" } })),
    );
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe("Invalid request headers: a header this transport does not list was given");
    await settled();
    expect(listener.accepted()).toBe(0);
    // Positive control: an empty header record lists nothing, so it is no header and the request goes out.
    await transport.request(post(url("/v1/query"), { body: "{}", headers: {} }));
    expect(listener.accepted()).toBe(1);
  });

  test("refuses a headers value that is not a plain record of its enumerable keys before any socket", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener, { requestHeaderNames: LISTED });
    const hidden = { "x-databend-session": "abc" };
    Object.defineProperty(hidden, "x-databend-query-id", { value: "hidden", enumerable: false });
    const values: unknown[] = [
      new Map([["x-databend-session", "abc"]]),
      ["abc"],
      { "x-databend-session": "abc", [Symbol("x-databend-query-id")]: "symbol" },
      hidden,
    ];
    const errors = await Promise.all(
      values.map((value) => {
        const headers = value as Record<string, string>;
        return refusal(transport.request(post(url("/v1/query"), { body: "{}", headers })));
      }),
    );
    for (const error of errors) {
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toBe("Invalid request headers: expected a plain record of header names and values");
    }
    await settled();
    expect(listener.accepted()).toBe(0);
    // Positive control: a plain record and one with no prototype go out with their listed header.
    const bare = Object.assign(Object.create(null) as Record<string, string>, { "x-databend-query-id": "bare" });
    await transport.request(post(url("/v1/query"), { body: "{}", headers: { "x-databend-session": "abc" } }));
    await transport.request(post(url("/v1/query"), { body: "{}", headers: bare }));
    expect(listener.seen[0].headers["x-databend-session"]).toBe("abc");
    expect(listener.seen[1].headers["x-databend-query-id"]).toBe("bare");
  });

  test("sends the headers it checked, from one read, whatever a later read would return", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener, { requestHeaderNames: LISTED });
    // Keys that change after the first read, as many each time: listed when checked, the credential afterwards.
    let keyReads = 0;
    const shifting = new Proxy(
      { "x-databend-session": "ok", authorization: "Basic other" },
      {
        ownKeys: () => (keyReads++ === 0 ? ["x-databend-session"] : ["authorization"]),
      },
    );
    // A value that changes after the first read: visible ASCII when checked, non-ASCII afterwards.
    let valueReads = 0;
    const turning = {} as Record<string, string>;
    Object.defineProperty(turning, "x-databend-query-id", {
      enumerable: true,
      get: () => (valueReads++ === 0 ? "ok" : "\u00e9t\u00e9"),
    });
    await transport.request(post(url("/v1/query"), { body: "{}", headers: shifting }));
    await transport.request(post(url("/v1/query"), { body: "{}", headers: turning }));
    const [keys, value] = listener.seen;
    expect(keys.headers.authorization).toBe(SECRET);
    expect(keys.headers.host).toBe(`127.0.0.1:${listener.port}`);
    expect(keys.headers["x-databend-session"]).toBe("ok");
    expect(value.headers["x-databend-query-id"]).toBe("ok");
    expect(valueReads).toBe(1);
  });

  test("a request without headers sends exactly today's header set", async () => {
    const raw: string[][] = [];
    const listener = await httpListener(rawRecorder(raw));
    const host = `127.0.0.1:${listener.port}`;
    const plain = connect(listener);
    const listing = connect(listener, { requestHeaderNames: LISTED });
    for (const { transport, url } of [plain, listing]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so the recorded order is the sent order.
      await transport.request(post(url("/v1/query"), { method: "GET" }));
      // oxlint-disable-next-line no-await-in-loop -- as above.
      await transport.request(post(url("/v1/query"), { body: '{"a":1}' }));
      // oxlint-disable-next-line no-await-in-loop -- as above.
      await transport.request(post(url("/v1/query"), { form: { q: "x" } }));
    }
    const base = ["authorization", SECRET, "accept", "application/json", "accept-encoding", "identity"];
    const get = [...base, "Host", host, "Connection", "keep-alive"];
    const json = [
      ...base,
      "content-type",
      "application/json",
      "content-length",
      "7",
      "Host",
      host,
      "Connection",
      "keep-alive",
    ];
    const form = [
      ...base,
      "content-type",
      "application/x-www-form-urlencoded",
      "content-length",
      "3",
      "Host",
      host,
      "Connection",
      "keep-alive",
    ];
    expect(raw).toEqual([get, json, form, get, json, form]);
  });
});
