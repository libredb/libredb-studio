/**
 * The guard's lookup rides on the connection's own keep-alive Agent (vector-family spec 3.7, R44 QM1): one lookup per
 * socket, not one per request, and never guardedNodeOptions' `agent: false`.
 *
 * The real guard refuses every loopback answer, so this file stands in for guardedNodeOptions with one that returns a
 * lookup that counts and answers 127.0.0.1, as QM1's loopback-permitted copy of the guard did;
 * node-transport-guard.test.ts runs the real one. The runner gives this file its own process, so the module mock
 * reaches no other test file.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import type { TransportCertificates } from "../../../helpers/node-transport-fixtures";

const realPolicy = { ...(await import("@/lib/db/http/egress-policy")) };
const lookups: string[] = [];
const guardCalls: Array<string | null | undefined> = [];
const loopbackLookup: LookupFunction = (hostname, options, callback) => {
  lookups.push(hostname);
  const answer: LookupAddress = { address: "127.0.0.1", family: 4 };
  if (options.all) callback(null, [answer]);
  else callback(null, answer.address, answer.family);
};
mock.module("@/lib/db/http/egress-policy", () => ({
  ...realPolicy,
  guardedNodeOptions: (hostname: string | null | undefined) => {
    guardCalls.push(hostname);
    return { lookup: loopbackLookup, agent: false };
  },
}));

const { endpointUrl, httpOrigin } = await import("@/lib/db/http/endpoint");
const { createNodeTransport, nodeTlsMaterial } = await import("@/lib/db/http/node-transport");
const { closeAll, httpListener, httpsListener, jsonAnswer, makeCertificates } = await import(
  "../../../helpers/node-transport-fixtures"
);

let certificates: TransportCertificates;
beforeAll(() => {
  certificates = makeCertificates();
}, 30_000);

const transports: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const transport of transports.splice(0)) transport.close();
  await closeAll();
  lookups.length = 0;
  guardCalls.length = 0;
});

function connect(scheme: "http" | "https", port: number, maxSockets = 4) {
  const origin = httpOrigin(scheme, "guard.test", port);
  const tls =
    scheme === "https" ? nodeTlsMaterial({ mode: "verify-full", caCert: certificates.ca }, "guard.test") : null;
  const transport = createNodeTransport({ origin, tls, maxSockets, headers: {} });
  transports.push(transport);
  const request = () =>
    transport.request({
      method: "GET",
      url: endpointUrl(origin, "/"),
      signal: AbortSignal.timeout(5000),
      maxResponseBytes: 1024,
    });
  return { request };
}

describe("the guard's lookup on the Agent", () => {
  test("plaintext: five requests, one lookup, one socket, and guardedNodeOptions asked once for the host", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { request } = connect("http", listener.port);
    for (let i = 0; i < 5; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each reuses the pooled socket.
      expect((await request()).status).toBe(200);
    }
    expect(lookups).toEqual(["guard.test"]);
    expect(listener.accepted()).toBe(1);
    expect(guardCalls).toEqual(["guard.test"]);
  });

  test("TLS: five requests, one lookup, one socket", async () => {
    const listener = await httpsListener(certificates.guarded, jsonAnswer(200, "{}"));
    const { request } = connect("https", listener.port);
    for (let i = 0; i < 5; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each reuses the pooled socket.
      expect((await request()).status).toBe(200);
    }
    expect(lookups).toEqual(["guard.test"]);
    expect(listener.accepted()).toBe(1);
  });

  test("one lookup per socket: three at once with maxSockets 2 make two sockets and two lookups", async () => {
    const listener = await httpListener((request, response, body) => {
      setTimeout(() => jsonAnswer(200, "{}")(request, response, body), 30);
    });
    const { request } = connect("http", listener.port, 2);
    await Promise.all([request(), request(), request()]);
    expect(lookups).toEqual(["guard.test", "guard.test"]);
    expect(listener.accepted()).toBe(2);
  });

  test("two connections are two Agents, each opening its own socket through the lookup", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    await connect("http", listener.port).request();
    await connect("http", listener.port).request();
    expect(lookups).toEqual(["guard.test", "guard.test"]);
    expect(listener.accepted()).toBe(2);
  });
});
