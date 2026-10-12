/**
 * The text transport's opt-in refusals. Each is off when absent, so a provider that does not ask keeps the behaviour
 * it had, and each, when asked, is the byte transport's rule. A name the resolver answers with a link-local address is
 * refused at the lookup in egress-policy-link-local.test.ts, the file that owns the resolver stand-in.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { BLOCKED_HOST } from "@/lib/db/http/egress-policy";
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import {
  createNodeByteTransport,
  createNodeTransport,
  type NodeTransport,
  type NodeTransportOptions,
  type TransportError,
} from "@/lib/db/http/node-transport";
import { closeAll, eventually, rawAnswer, rawHttpListener } from "../../../helpers/node-transport-fixtures";

const LINK_LOCAL =
  "Invalid host: this connection never reaches a link-local address or AWS's IPv6 instance metadata address, whatever DB_HTTP_BLOCK_PRIVATE_HOSTS says";
const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const original = process.env[FLAG];

const transports: NodeTransport[] = [];
afterEach(async () => {
  if (original === undefined) delete process.env[FLAG];
  else process.env[FLAG] = original;
  for (const transport of transports.splice(0)) transport.close();
  await closeAll();
});

function build(options: NodeTransportOptions): NodeTransport {
  const transport = createNodeTransport(options);
  transports.push(transport);
  return transport;
}

function refusal(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw");
}

/** A transport that would dial `host` on port 80, never sent a request here. */
function toHost(host: string, extra: Partial<NodeTransportOptions> = {}): NodeTransportOptions {
  return { origin: { scheme: "http", host, port: 80 }, tls: null, maxSockets: 1, headers: {}, ...extra };
}

describe("refusesLinkLocal", () => {
  test.each(["169.254.169.254", "[fe80::1]", "[fd00:ec2::254]", "[::ffff:169.254.169.254]"])(
    "%s is refused when the transport is built, with the guard off",
    (host) => {
      delete process.env[FLAG];
      const error = refusal(() => build(toHost(host, { refusesLinkLocal: true })));
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toBe(LINK_LOCAL);
    },
  );

  test("with the guard on, a link-local literal gets the guard's sentence, because the guard runs first", () => {
    process.env[FLAG] = "true";
    const error = refusal(() => build(toHost("169.254.169.254", { refusesLinkLocal: true })));
    expect(error.message).toBe(BLOCKED_HOST);
  });

  test.each([undefined, false])("set to %p, a link-local literal builds a transport as it always has", (value) => {
    delete process.env[FLAG];
    expect(() =>
      build(toHost("169.254.169.254", value === undefined ? {} : { refusesLinkLocal: value })),
    ).not.toThrow();
  });

  test("loopback stays reachable when it is set", async () => {
    delete process.env[FLAG];
    const listener = await rawHttpListener(() => rawAnswer("200 OK", ["content-length: 2"], "ok"));
    const origin = httpOrigin("http", "127.0.0.1", listener.port);
    const transport = build({ origin, tls: null, maxSockets: 1, headers: {}, refusesLinkLocal: true });
    const answer = await transport.request({
      method: "GET",
      url: endpointUrl(origin, "/ok"),
      signal: AbortSignal.timeout(5000),
      maxResponseBytes: 1024,
    });
    expect([answer.status, answer.text]).toEqual([200, "ok"]);
  });

  test.each([["true"], [1], [null]])("set to %p, which is not true or false, is refused by name", (value) => {
    const error = refusal(() =>
      build(toHost("127.0.0.1", { refusesLinkLocal: value } as unknown as Partial<NodeTransportOptions>)),
    );
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe("Invalid refusesLinkLocal: expected true or false");
  });

  test("the byte transport refuses a link-local literal whatever a caller passes for the text transport's option", () => {
    delete process.env[FLAG];
    const error = refusal(() =>
      createNodeByteTransport({ ...toHost("169.254.169.254"), ...({ refusesLinkLocal: false } as object) }),
    );
    expect(error.message).toBe(LINK_LOCAL);
  });
});

describe("refusesUpgrade", () => {
  const SWITCHED =
    "The server switched the connection to another protocol, and this transport reads HTTP only, so the response was not read";

  async function failure(run: () => Promise<unknown>): Promise<TransportError> {
    try {
      await run();
    } catch (error) {
      return error as TransportError;
    }
    throw new Error("expected the request to fail");
  }

  /** A listener whose first answer is a 101 with these header lines and every later one a 200 "ok". */
  function upgradeListener(headerLines: readonly string[]) {
    return rawHttpListener((_head, index) =>
      index === 0
        ? rawAnswer("101 Switching Protocols", headerLines)
        : rawAnswer("200 OK", ["content-length: 2"], "ok"),
    );
  }

  function get(origin: ReturnType<typeof httpOrigin>, path: string, ms = 5000) {
    return {
      method: "GET" as const,
      url: endpointUrl(origin, path),
      signal: AbortSignal.timeout(ms),
      maxResponseBytes: 1024,
    };
  }

  test.each([
    ["connection: upgrade and an upgrade header", ["connection: upgrade", "upgrade: websocket"]],
    ["no upgrade headers", ["content-length: 0"]],
  ] as const)(
    "a 101 with %s fails at once as a network failure, closes its socket and frees its slot",
    async (_label, headerLines) => {
      const listener = await upgradeListener(headerLines);
      const origin = httpOrigin("http", "127.0.0.1", listener.port);
      const transport = build({ origin, tls: null, maxSockets: 1, headers: {}, refusesUpgrade: true });
      const started = Date.now();
      const error = await failure(() => transport.request(get(origin, "/switch")));
      expect({ name: error.name, kind: error.kind, message: error.message }).toEqual({
        name: "TransportError",
        kind: "network",
        message: SWITCHED,
      });
      expect(Date.now() - started).toBeLessThan(1000);
      await eventually(() => listener.open() === 0, "the switched socket to close");
      expect((await transport.request(get(origin, "/next"))).text).toBe("ok");
    },
  );

  test("absent, a 101 with no upgrade headers is answered as a status, as it always was", async () => {
    const listener = await upgradeListener(["content-length: 0"]);
    const origin = httpOrigin("http", "127.0.0.1", listener.port);
    const transport = build({ origin, tls: null, maxSockets: 1, headers: {} });
    expect((await transport.request(get(origin, "/switch"))).status).toBe(101);
  });

  test("absent, a 101 with upgrade headers waits for the deadline, as it always did", async () => {
    const listener = await upgradeListener(["connection: upgrade", "upgrade: websocket"]);
    const origin = httpOrigin("http", "127.0.0.1", listener.port);
    const transport = build({ origin, tls: null, maxSockets: 1, headers: {} });
    expect((await failure(() => transport.request(get(origin, "/switch", 300)))).kind).toBe("timeout");
  });

  test.each([["false"], [0], [null]])("set to %p, which is not true or false, is refused by name", (value) => {
    const error = refusal(() =>
      build(toHost("127.0.0.1", { refusesUpgrade: value } as unknown as Partial<NodeTransportOptions>)),
    );
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe("Invalid refusesUpgrade: expected true or false");
  });
});
