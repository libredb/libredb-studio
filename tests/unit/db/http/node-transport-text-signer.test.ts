/**
 * The text transport's signer, its JSON media types and its connection-header spellings, against local listeners.
 *
 * A text transport may take the byte transport's `RequestSigner`: it is checked when the transport is built, called
 * once per request just before the write with the exact method, Host, path, query, headers and body, and its headers
 * are added to what is sent. A signer's header values may be up to 8192 bytes, so a session token fits, while a
 * request's own headers keep 1024. `jsonContentType` picks one of three JSON media types, and a connection header
 * named in two spellings is refused. A transport that takes none of these sends exactly what it sent before they
 * existed: the raw listener records each head byte for byte, and every listener counts the connections it accepts, so
 * "no socket" is measured on the server side.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import {
  createNodeByteTransport,
  createNodeTransport,
  type NodeRequest,
  type NodeTransport,
  type NodeTransportOptions,
  type RequestSigner,
  type SigningInput,
  TransportError,
} from "@/lib/db/http/node-transport";
import {
  closeAll,
  httpListener,
  jsonAnswer,
  type Listener,
  rawAnswer,
  rawHttpListener,
} from "../../../helpers/node-transport-fixtures";

const MIB = 1024 * 1024;
const AUTHORIZATION = "AWS4-HMAC-SHA256 Credential=test/20261115/us-east-1/dynamodb/aws4_request";
const SIGNER_FAILED = "The request signer failed, so the request was not sent";
const SIGNATURE_VALUE = (name: string) =>
  `Invalid signature headers: the value of ${name} must be visible ASCII or space, at most 8192 bytes`;
const INVALID_JSON_CONTENT_TYPE =
  "Invalid jsonContentType: expected application/json, application/x-amz-json-1.0 or application/x-amz-json-1.1";

const transports: { close(): void }[] = [];
afterEach(async () => {
  for (const transport of transports.splice(0)) transport.close();
  await closeAll();
});

function connect(listener: { readonly port: number }, extra: Partial<NodeTransportOptions> = {}) {
  const origin = httpOrigin("http", "127.0.0.1", listener.port);
  const transport = createNodeTransport({ origin, tls: null, maxSockets: 4, headers: {}, ...extra });
  transports.push(transport);
  return { transport, url: (path: string) => endpointUrl(origin, path) };
}

function build(extra: Partial<NodeTransportOptions>): () => NodeTransport {
  return () => {
    const transport = createNodeTransport({
      origin: httpOrigin("http", "127.0.0.1", 1),
      tls: null,
      maxSockets: 1,
      headers: {},
      ...extra,
    });
    transports.push(transport);
    return transport;
  };
}

function post(url: string, extra: Partial<NodeRequest> = {}): NodeRequest {
  return { method: "POST", url, signal: AbortSignal.timeout(5000), maxResponseBytes: MIB, ...extra };
}

function get(url: string, extra: Partial<NodeRequest> = {}): NodeRequest {
  return { method: "GET", url, signal: AbortSignal.timeout(5000), maxResponseBytes: MIB, ...extra };
}

/** A signer listing authorization, x-amz-date and x-amz-security-token that runs `onSign`. */
function signer(
  onSign: (input: SigningInput) => Readonly<Record<string, string>> = () => ({
    authorization: AUTHORIZATION,
    "x-amz-date": "20261115T000000Z",
  }),
): RequestSigner {
  return { headerNames: ["authorization", "x-amz-date", "x-amz-security-token"], sign: onSign };
}

/** The request line and the header lines of a recorded head. */
function lines(head: Buffer): string[] {
  return head.toString("latin1").split("\r\n");
}

const OK = (): Buffer => rawAnswer("200 OK", ["content-type: application/json", "content-length: 2"], "{}");

async function failure(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the request to fail");
}

function thrownBy(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a refusal");
}

/** Waits long enough for a socket the transport might have opened to reach the listener. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

describe("a text transport without the new options sends what it sent before", () => {
  test("a GET with a query carries the same header lines in the same order", async () => {
    const listener = await rawHttpListener(OK);
    const { transport, url } = connect(listener, {
      headers: { Authorization: "Bearer t", accept: "application/json" },
    });
    await transport.request(get(`${url("/v1/items")}?limit=5&next=a%2Fb`));
    expect(lines(listener.heads[0])).toEqual([
      "GET /v1/items?limit=5&next=a%2Fb HTTP/1.1",
      "authorization: Bearer t",
      "accept: application/json",
      "accept-encoding: identity",
      `Host: 127.0.0.1:${listener.port}`,
      "Connection: keep-alive",
    ]);
  });

  test("a POST with a JSON body carries application/json, its length, and no explicit host", async () => {
    const listener = await rawHttpListener(OK);
    const { transport, url } = connect(listener, { headers: { "x-api-key": "k" }, requestHeaderNames: ["x-trace"] });
    await transport.request(post(url("/v1/query"), { body: '{"q":"é"}', headers: { "x-trace": "t1" } }));
    expect(lines(listener.heads[0])).toEqual([
      "POST /v1/query HTTP/1.1",
      "x-api-key: k",
      "x-trace: t1",
      "accept-encoding: identity",
      "content-type: application/json",
      "content-length: 10",
      `Host: 127.0.0.1:${listener.port}`,
      "Connection: keep-alive",
    ]);
  });

  test("a POST with form fields carries the form media type", async () => {
    const listener = await rawHttpListener(OK);
    const { transport, url } = connect(listener);
    await transport.request(post(url("/token"), { form: { grant_type: "password", scope: "a b" } }));
    expect(lines(listener.heads[0])).toEqual([
      "POST /token HTTP/1.1",
      "accept-encoding: identity",
      "content-type: application/x-www-form-urlencoded",
      "content-length: 29",
      `Host: 127.0.0.1:${listener.port}`,
      "Connection: keep-alive",
    ]);
  });
});

describe("the signer, checked when the transport is built", () => {
  test.each([
    ["no names", { headerNames: [], sign: () => ({}) }, "Invalid signer: expected at least one lower-case header name"],
    [
      "host",
      { headerNames: ["host"], sign: () => ({}) },
      "Invalid signer: host is set by the transport, the connection or the request",
    ],
    [
      "content-type",
      { headerNames: ["content-type"], sign: () => ({}) },
      "Invalid signer: content-type is set by the transport, the connection or the request",
    ],
    [
      "a connection header",
      { headerNames: ["authorization"], sign: () => ({}) },
      "Invalid signer: authorization is set by the transport, the connection or the request",
    ],
    [
      "a per-request name",
      { headerNames: ["x-amz-target"], sign: () => ({}) },
      "Invalid signer: x-amz-target is set by the transport, the connection or the request",
    ],
  ] as const)("a signer listing %s is refused", async (_label, given, sentence) => {
    const listener = await rawHttpListener(OK);
    const error = thrownBy(() =>
      connect(listener, {
        headers: { Authorization: "Bearer t" },
        requestHeaderNames: ["x-amz-target"],
        signer: given as unknown as RequestSigner,
      }),
    );
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(sentence);
    expect(listener.accepted()).toBe(0);
  });
});

describe("the signer at send time", () => {
  test("receives the method, Host, path, query, headers and body exactly as the server received them", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const inputs: SigningInput[] = [];
    const { transport, url } = connect(listener, {
      headers: { "X-Conn": "c" },
      requestHeaderNames: ["x-amz-target"],
      jsonContentType: "application/x-amz-json-1.0",
      signer: signer((input) => {
        inputs.push(input);
        return { authorization: AUTHORIZATION, "x-amz-date": "20261115T000000Z" };
      }),
    });
    const body = '{"TableName":"t","Key":{"id":{"S":"é"}}}';
    await transport.request(
      post(`${url("/a/b%20c")}?b=2&a=1`, { body, headers: { "x-amz-target": "DynamoDB_20120810.GetItem" } }),
    );
    const host = `127.0.0.1:${listener.port}`;
    expect(inputs).toEqual([
      {
        method: "POST",
        host,
        path: "/a/b%20c",
        query: "b=2&a=1",
        headers: {
          "x-conn": "c",
          "x-amz-target": "DynamoDB_20120810.GetItem",
          host,
          "accept-encoding": "identity",
          "content-type": "application/x-amz-json-1.0",
          "content-length": String(Buffer.byteLength(body, "utf8")),
        },
        body,
      },
    ]);
    expect(Object.isFrozen(inputs[0].headers)).toBe(true);
    const [seen] = listener.seen;
    expect(seen.method).toBe(inputs[0].method);
    expect(seen.url).toBe(`${inputs[0].path}?${inputs[0].query}`);
    expect(seen.body).toBe(inputs[0].body);
    for (const [name, value] of Object.entries(inputs[0].headers)) expect(seen.headers[name]).toBe(value);
    expect(seen.headers.authorization).toBe(AUTHORIZATION);
    expect(seen.headers["x-amz-date"]).toBe("20261115T000000Z");
  });

  test("a GET with no query and no body hands the signer an empty query and an empty body", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const inputs: SigningInput[] = [];
    const { transport, url } = connect(listener, {
      signer: signer((input) => {
        inputs.push(input);
        return { authorization: AUTHORIZATION };
      }),
    });
    await transport.request(get(url("/")));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ method: "GET", path: "/", query: "", body: "" });
    expect(Object.keys(inputs[0].headers)).toEqual(["host", "accept-encoding"]);
  });

  test("form fields reach the signer as the exact text written, under the form media type", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const inputs: SigningInput[] = [];
    const { transport, url } = connect(listener, {
      jsonContentType: "application/x-amz-json-1.1",
      signer: signer((input) => {
        inputs.push(input);
        return { authorization: AUTHORIZATION };
      }),
    });
    await transport.request(post(url("/"), { form: { Action: "GetClusterCredentials", DbUser: "a b" } }));
    expect(inputs[0].body).toBe("Action=GetClusterCredentials&DbUser=a+b");
    expect(inputs[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(listener.seen[0].body).toBe(inputs[0].body);
  });

  test("the signed Host is the Host sent, exactly once, and the signer's headers follow the transport's", async () => {
    const listener = await rawHttpListener(OK);
    const hosts: string[] = [];
    const { transport, url } = connect(listener, {
      signer: signer((input) => {
        hosts.push(input.host);
        return { authorization: AUTHORIZATION, "x-amz-date": "20261115T000000Z" };
      }),
    });
    await transport.request(post(url("/"), { body: "{}" }));
    expect(hosts).toEqual([`127.0.0.1:${listener.port}`]);
    expect(lines(listener.heads[0])).toEqual([
      "POST / HTTP/1.1",
      `host: 127.0.0.1:${listener.port}`,
      "accept-encoding: identity",
      "content-type: application/json",
      "content-length: 2",
      `authorization: ${AUTHORIZATION}`,
      "x-amz-date: 20261115T000000Z",
      "Connection: keep-alive",
    ]);
  });

  test("it is called once per request, at send time", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    let calls = 0;
    const { transport, url } = connect(listener, {
      signer: signer(() => {
        calls += 1;
        return { authorization: `${AUTHORIZATION}-${calls}` };
      }),
    });
    expect(calls).toBe(0);
    await transport.request(get(url("/one")));
    await transport.request(get(url("/two")));
    expect(calls).toBe(2);
    expect(listener.seen.map((seen) => seen.headers.authorization)).toEqual([
      `${AUTHORIZATION}-1`,
      `${AUTHORIZATION}-2`,
    ]);
  });

  test("a signer's own Error reaches the caller unchanged and nothing is sent", async () => {
    const listener = await rawHttpListener(OK);
    const own = new Error("signer exploded");
    const { transport, url } = connect(listener, {
      signer: signer(() => {
        throw own;
      }),
    });
    const error = await failure(() => transport.request(post(url("/"), { body: "{}" })));
    expect(error).toBe(own);
    await settled();
    expect(listener.accepted()).toBe(0);
  });

  test("a signer that throws something other than an Error rejects with the signer-failed sentence", async () => {
    const listener = await rawHttpListener(OK);
    const { transport, url } = connect(listener, {
      signer: signer(() => {
        throw "a secret-shaped string";
      }),
    });
    const error = await failure(() => transport.request(get(url("/"))));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TransportError);
    expect(error.message).toBe(SIGNER_FAILED);
    await settled();
    expect(listener.accepted()).toBe(0);
  });

  test("a signer that fails frees its socket slot, so the next request completes", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener, {
      maxSockets: 1,
      signer: signer((input) => {
        if (input.path === "/boom") throw new Error("boom");
        return { authorization: AUTHORIZATION };
      }),
    });
    const results = await Promise.allSettled([
      transport.request(get(url("/boom"))),
      transport.request(get(url("/boom"))),
      transport.request(get(url("/ok"))),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "fulfilled"]);
    expect(listener.seen.map((seen) => seen.url)).toEqual(["/ok"]);
  });

  test("a signer that cancels its own request sends nothing", async () => {
    const listener = await rawHttpListener(OK);
    const controller = new AbortController();
    const { transport, url } = connect(listener, {
      signer: signer(() => {
        controller.abort();
        return { authorization: AUTHORIZATION };
      }),
    });
    const error = await failure(() => transport.request(get(url("/"), { signal: controller.signal })));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).kind).toBe("aborted");
    await settled();
    expect(listener.accepted()).toBe(0);
  });

  test("a signer that returns an unlisted name or a line feed is refused and nothing is sent", async () => {
    const listener = await rawHttpListener(OK);
    const unlisted = connect(listener, { signer: signer(() => ({ authorization: AUTHORIZATION, "x-other": "1" })) });
    const split = connect(listener, { signer: signer(() => ({ authorization: "AWS4\nx-injected: 1" })) });
    const errors = [
      await failure(() => unlisted.transport.request(get(unlisted.url("/")))),
      await failure(() => split.transport.request(get(split.url("/")))),
    ];
    expect(errors.map((error) => error.message)).toEqual([
      "Invalid signature headers: the signer returned a header this transport does not list",
      SIGNATURE_VALUE("authorization"),
    ]);
    for (const error of errors) expect(error).toBeInstanceOf(DatabaseConfigError);
    await settled();
    expect(listener.accepted()).toBe(0);
  });
});

describe("header value caps", () => {
  test("an 8192-byte session token from the signer is sent whole", async () => {
    const listener = await rawHttpListener(OK);
    const token = "t".repeat(8192);
    const { transport, url } = connect(listener, {
      signer: signer(() => ({ authorization: AUTHORIZATION, "x-amz-security-token": token })),
    });
    await transport.request(post(url("/"), { body: "{}" }));
    expect(lines(listener.heads[0]).includes(`x-amz-security-token: ${token}`)).toBe(true);
  });

  test("an 8193-byte value from the signer is refused by its name and nothing is sent", async () => {
    const listener = await rawHttpListener(OK);
    const { transport, url } = connect(listener, {
      signer: signer(() => ({ authorization: AUTHORIZATION, "x-amz-security-token": "t".repeat(8193) })),
    });
    const error = await failure(() => transport.request(post(url("/"), { body: "{}" })));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(SIGNATURE_VALUE("x-amz-security-token"));
    await settled();
    expect(listener.accepted()).toBe(0);
  });

  test("the byte transport's signer takes the same 8192-byte cap", async () => {
    const listener = await rawHttpListener(() => rawAnswer("200 OK", ["content-length: 2"], "ok"));
    const origin = httpOrigin("http", "127.0.0.1", listener.port);
    const byteSigner = (token: string): RequestSigner => ({
      headerNames: ["authorization", "x-amz-security-token"],
      sign: () => ({ authorization: AUTHORIZATION, "x-amz-security-token": token }),
    });
    const fits = createNodeByteTransport({
      origin,
      tls: null,
      maxSockets: 1,
      headers: {},
      signer: byteSigner("t".repeat(8192)),
    });
    const over = createNodeByteTransport({
      origin,
      tls: null,
      maxSockets: 1,
      headers: {},
      signer: byteSigner("t".repeat(8193)),
    });
    transports.push(fits, over);
    const request = {
      method: "GET" as const,
      target: { path: "/b/k", query: "" },
      signal: AbortSignal.timeout(5000),
      maxResponseBytes: MIB,
    };
    const error = await failure(() => over.request(request));
    expect(error.message).toBe(SIGNATURE_VALUE("x-amz-security-token"));
    await settled();
    expect(listener.accepted()).toBe(0);
    await fits.request(request);
    expect(lines(listener.heads[0]).includes(`x-amz-security-token: ${"t".repeat(8192)}`)).toBe(true);
  });

  test("a request's own header over 1024 bytes is still refused on a signed transport", async () => {
    const listener = await rawHttpListener(OK);
    const { transport, url } = connect(listener, { requestHeaderNames: ["x-amz-target"], signer: signer() });
    const error = await failure(() =>
      transport.request(post(url("/"), { body: "{}", headers: { "x-amz-target": "x".repeat(1025) } })),
    );
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(
      "Invalid request headers: the value of x-amz-target must be visible ASCII or space, at most 1024 bytes",
    );
    await settled();
    expect(listener.accepted()).toBe(0);
  });
});

describe("jsonContentType", () => {
  test.each(["application/json", "application/x-amz-json-1.0", "application/x-amz-json-1.1"] as const)(
    "%s is sent as a JSON body's content type",
    async (type) => {
      const listener = await httpListener(jsonAnswer(200, "{}"));
      const { transport, url } = connect(listener, { jsonContentType: type });
      await transport.request(post(url("/"), { body: "{}" }));
      expect(listener.seen[0].headers["content-type"]).toBe(type);
    },
  );

  test("absent, a JSON body is sent as application/json", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener);
    await transport.request(post(url("/"), { body: "{}" }));
    expect(listener.seen[0].headers["content-type"]).toBe("application/json");
  });

  test.each([
    ["another media type", "text/plain"],
    ["a parameter", "application/json; charset=utf-8"],
    ["another case", "Application/JSON"],
    ["a CR LF", "application/json\r\nx-injected: 1"],
    ["a non-string", 1],
    ["null", null],
  ])("%s is refused when the transport is built, without repeating it", (_label, value) => {
    const error = thrownBy(build({ jsonContentType: value as unknown as NodeTransportOptions["jsonContentType"] }));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(INVALID_JSON_CONTENT_TYPE);
  });
});

describe("connection headers in two spellings", () => {
  test.each([
    [{ "X-Api": "a", "x-api": "b" }, "x-api"],
    [{ authorization: "Bearer a", Authorization: "Bearer b" }, "authorization"],
    [{ accept: "application/json", ACCEPT: "text/plain" }, "accept"],
  ])("%p is refused when the transport is built", (headers, name) => {
    const error = thrownBy(build({ headers }));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(`Invalid headers: ${name} is named twice`);
    expect(error.message).not.toContain("Bearer");
  });

  test("positive control: one spelling of each name is accepted", () => {
    expect(build({ headers: { "X-Api": "a", authorization: "Bearer a" } })).not.toThrow();
  });

  test("a header named __proto__ is sent, as it was before, and never dropped", async () => {
    const listener = await rawHttpListener(OK);
    const { transport, url } = connect(listener, { headers: JSON.parse('{"__proto__":"x","x-a":"1"}') });
    await transport.request(get(url("/")));
    expect(lines(listener.heads[0])).toEqual([
      "GET / HTTP/1.1",
      "__proto__: x",
      "x-a: 1",
      "accept-encoding: identity",
      `Host: 127.0.0.1:${listener.port}`,
      "Connection: keep-alive",
    ]);
  });

  test("__proto__ in two spellings is refused like any other name", () => {
    const error = thrownBy(build({ headers: JSON.parse('{"__proto__":"x","__PROTO__":"y"}') }));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe("Invalid headers: __proto__ is named twice");
  });
});

describe("refusals when the transport is built", () => {
  test("a duplicate spelling and an unknown jsonContentType open no socket", async () => {
    const listener: Listener = await rawHttpListener(OK);
    const origin = httpOrigin("http", "127.0.0.1", listener.port);
    expect(() => createNodeTransport({ origin, tls: null, maxSockets: 1, headers: { A: "1", a: "2" } })).toThrow(
      DatabaseConfigError,
    );
    expect(() =>
      createNodeTransport({
        origin,
        tls: null,
        maxSockets: 1,
        headers: {},
        jsonContentType: "text/plain" as unknown as NodeTransportOptions["jsonContentType"],
      }),
    ).toThrow(DatabaseConfigError);
    await settled();
    expect(listener.accepted()).toBe(0);
  });
});
