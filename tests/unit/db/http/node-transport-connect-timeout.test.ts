/**
 * A deadline that fires before the socket connected, told apart from one that fires after it.
 *
 * A host whose packets are dropped never completes the TCP connect, and the request's deadline is the first thing
 * that happens. That is not a slow answer: nothing reached a server, so the transport says so with the host, the port
 * and the seconds waited, as kind "unreachable", a ConnectionError, when the provider asked for it with
 * `reportsUnreachable`. A deadline that fires on a connected socket stays kind "timeout" with its own sentence, and so
 * does every deadline on a transport that did not ask, the byte transport among them.
 *
 * A connect that never completes is made without the network: this file stands in for the egress policy's lookups with
 * one that never answers for `never.test` and answers 127.0.0.1 for any other name, so the socket stays in its
 * connecting state exactly as it does for a dropped SYN (measured on Node 24 and Bun 1.4: `socket.connecting` is true
 * in both cases). The runner gives this file its own process, so the module mock reaches no other test file.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";

const realPolicy = { ...(await import("@/lib/db/http/egress-policy")) };
const NEVER = "never.test";
const lookup: LookupFunction = (hostname, options, callback) => {
  if (hostname === NEVER) return;
  const answer: LookupAddress = { address: "127.0.0.1", family: 4 };
  if (options.all) callback(null, [answer]);
  else callback(null, answer.address, answer.family);
};
mock.module("@/lib/db/http/egress-policy", () => ({
  ...realPolicy,
  guardedNodeOptions: () => ({ lookup, agent: false }),
  guardedLinkLocalRefusingLookup: lookup,
  linkLocalRefusingLookup: lookup,
}));

const { ConnectionError } = await import("@/lib/db/errors");
const { endpointUrl, httpOrigin } = await import("@/lib/db/http/endpoint");
const { createNodeByteTransport, createNodeTransport, nodeTlsMaterial, TransportError } = await import(
  "@/lib/db/http/node-transport"
);
const { closeAll, eventually, httpListener, silentListener } = await import("../../../helpers/node-transport-fixtures");

const transports: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const transport of transports.splice(0)) transport.close();
  await closeAll();
});

const SENTENCE =
  /^No answer from (\S+) after (\d+(?:\.\d)?) seconds?: check the address, the port and the network path\.$/;

function textTransport(
  scheme: "http" | "https",
  host: string,
  port: number,
  maxSockets = 4,
  reportsUnreachable = true,
) {
  const origin = httpOrigin(scheme, host, port);
  const tls = scheme === "https" ? nodeTlsMaterial({ mode: "verify-system" }, host) : null;
  const transport = createNodeTransport({ origin, tls, maxSockets, headers: {}, reportsUnreachable });
  transports.push(transport);
  return (signal: AbortSignal) =>
    transport.request({ method: "GET", url: endpointUrl(origin, "/"), signal, maxResponseBytes: 1024 });
}

async function failure(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to reject");
}

/** The host and port the sentence names, and the seconds it says it waited. */
function named(error: Error): { endpoint: string; seconds: number } {
  const match = SENTENCE.exec(error.message);
  if (match === null) throw new Error(`not the connect-phase sentence: ${error.message}`);
  return { endpoint: match[1], seconds: Number(match[2]) };
}

describe("a deadline before the socket connected", () => {
  test("plaintext: kind unreachable, a ConnectionError naming host, port and the seconds waited", async () => {
    const request = textTransport("http", NEVER, 6443);
    const error = await failure(() => request(AbortSignal.timeout(300)));
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as InstanceType<typeof TransportError>).kind).toBe("unreachable");
    const { endpoint, seconds } = named(error);
    expect(endpoint).toBe("never.test:6443");
    expect(seconds).toBeGreaterThanOrEqual(0.3);
    expect(seconds).toBeLessThan(5);
    expect(error.message).not.toContain("query");
  });

  test("TLS: the same sentence, since the handshake never began", async () => {
    const request = textTransport("https", NEVER, 6443);
    const error = await failure(() => request(AbortSignal.timeout(300)));
    expect((error as InstanceType<typeof TransportError>).kind).toBe("unreachable");
    expect(named(error).endpoint).toBe("never.test:6443");
  });

  test("the seconds are the wait this request made, never a limit it was not given", async () => {
    const request = textTransport("http", NEVER, 6443);
    const deadline = AbortSignal.timeout(700);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const error = await failure(() => request(deadline));
    const { seconds } = named(error);
    expect(seconds).toBeGreaterThanOrEqual(0.2);
    expect(seconds).toBeLessThanOrEqual(0.4);
    expect(error.message).not.toContain("within");
  });

  test("a deadline of a few milliseconds still names a wait above zero", async () => {
    const request = textTransport("http", NEVER, 6443);
    const error = await failure(() => request(AbortSignal.timeout(5)));
    expect(error.message).toContain(" after 0.1 seconds: ");
  });

  test("a default port is still named", async () => {
    const request = textTransport("https", NEVER, 443);
    const error = await failure(() => request(AbortSignal.timeout(200)));
    expect(named(error).endpoint).toBe("never.test:443");
  });

  test("a caller's cancel while connecting is still a cancel", async () => {
    const request = textTransport("http", NEVER, 6443);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const error = await failure(() => request(AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])));
    expect((error as InstanceType<typeof TransportError>).kind).toBe("aborted");
  });

  test("a request waiting behind maxSockets for a slot is a timeout, not an unreachable host", async () => {
    const request = textTransport("http", NEVER, 6443, 1);
    const first = failure(() => request(AbortSignal.timeout(600)));
    const queued = await failure(() => request(AbortSignal.timeout(200)));
    expect((queued as InstanceType<typeof TransportError>).kind).toBe("timeout");
    expect(((await first) as InstanceType<typeof TransportError>).kind).toBe("unreachable");
  });
});

describe("a transport that did not ask", () => {
  test("a text transport without reportsUnreachable keeps timeout", async () => {
    const request = textTransport("http", NEVER, 6443, 4, false);
    const error = await failure(() => request(AbortSignal.timeout(200)));
    expect((error as InstanceType<typeof TransportError>).kind).toBe("timeout");
    expect(error.message).toBe("The request did not finish within its time limit");
  });

  test("the byte transport keeps timeout", async () => {
    const origin = httpOrigin("http", NEVER, 9000);
    const transport = createNodeByteTransport({ origin, tls: null, maxSockets: 2, headers: {} });
    transports.push(transport);
    const error = await failure(() =>
      transport.request({
        method: "GET",
        target: { path: "/", query: "" },
        signal: AbortSignal.timeout(200),
        maxResponseBytes: 1024,
      }),
    );
    expect((error as InstanceType<typeof TransportError>).kind).toBe("timeout");
  });

  test("a value other than true or false is refused when the transport is built", () => {
    const origin = httpOrigin("http", NEVER, 6443);
    expect(() =>
      createNodeTransport({
        origin,
        tls: null,
        maxSockets: 1,
        headers: {},
        reportsUnreachable: "yes" as unknown as boolean,
      }),
    ).toThrow("Invalid reportsUnreachable: expected true or false");
  });
});

describe("a deadline after the socket connected", () => {
  test("a server that accepts and never answers is a timeout with its own sentence", async () => {
    const listener = await httpListener(() => {});
    const request = textTransport("http", "accepts.test", listener.port);
    const error = await failure(() => request(AbortSignal.timeout(300)));
    expect((error as InstanceType<typeof TransportError>).kind).toBe("timeout");
    expect(error.message).toBe("The request did not finish within its time limit");
    expect(listener.accepted()).toBe(1);
    await eventually(() => listener.open() === 0, "the held socket to close");
  });

  test("TLS: a server that accepts the connect and never answers the handshake is a timeout", async () => {
    const listener = await silentListener();
    const request = textTransport("https", "accepts.test", listener.port);
    const error = await failure(() => request(AbortSignal.timeout(300)));
    expect((error as InstanceType<typeof TransportError>).kind).toBe("timeout");
    expect(error.message).toBe("The request did not finish within its time limit");
    expect(listener.accepted()).toBe(1);
  });
});
