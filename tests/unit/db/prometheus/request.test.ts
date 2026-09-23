/**
 * How a Prometheus request leaves the process (#1085 sections 3.4 and 3.6; #1085 S2, #1085 S5 and #1085 S8)
 *
 * The tests that send talk to real servers they start on the loopback interface: `node:http`
 * for the plaintext path, which goes through the global `fetch`, and `node:https` with the
 * throwaway certificates of tests/fixtures/tls/ for the TLS path, so every handshake and every
 * verification below is a real one. A few tests replace `globalThis.fetch` instead, and restore
 * it in afterEach, for what no server can show: the options `fetch` was called with, and the
 * error shapes Node's `fetch` produces, which a Bun-run suite never meets. `mock.module()` is not
 * used: it is process-wide in bun.
 *
 * The codes asserted against real servers (ConnectionRefused, ECONNREFUSED, ECONNRESET,
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE, ERR_SSL_WRONG_VERSION_NUMBER, ERR_OSSL_PEM_NO_START_LINE,
 * ERR_INVALID_CHAR, ERR_INVALID_PROTOCOL) are what bun 1.4.2 reports, the runtime this suite runs on.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
  type ServerOptions as HttpsServerOptions,
} from "node:https";
import type { AddressInfo, Server as NetServer } from "node:net";
import type { TLSSocket } from "node:tls";
import { ConnectionError } from "@/lib/db/errors";
import {
  createSendRequest,
  type OutboundRequest,
  RequestFailure,
  type SendRequest,
  type TlsMaterial,
  tlsMaterialFor,
} from "@/lib/db/providers/timeseries/prometheus/request";
import type { SSLConfig } from "@/lib/types";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";

const TLS = loadTlsFixtures();

/** What verify-ca and verify-full hand node:https with the test CA pasted: the test server verifies. */
const VERIFYING: TlsMaterial = { rejectUnauthorized: true, ca: TLS.ca };

/**
 * Text a failure must never repeat. Readable and low in entropy on purpose: a realistic value
 * trips the Secret Scan's generic rule, and what these tests assert does not care what it looks
 * like (the reasoning of 3023c7e0).
 */
const PLANTED_HEADER = "planted-header-value";
const PLANTED_BODY = "planted-body-text";

const originalFetch = globalThis.fetch;
const running: (Server | HttpsServer)[] = [];

/** Stops a server and every connection it holds: several servers below never finish an answer. */
function stop(server: Server | HttpsServer): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(running.splice(0).map(stop));
});

/** Listens on an ephemeral port of `host` and answers with the port. */
async function listening(server: NetServer, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

interface Received {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
  readonly remoteAddress: string | undefined;
  /** TLS only: whether the client presented a certificate the server verified. */
  readonly authorized: boolean | undefined;
}

/** How a test server answers, once the request has arrived whole. */
type Answer = (response: ServerResponse, request: IncomingMessage) => void;

interface Served {
  /** For example `https://127.0.0.1:41267`, or `http://[::1]:41267`. */
  readonly origin: string;
  /** Every request that reached the answer, in arrival order. */
  readonly received: Received[];
}

interface ServeOptions {
  readonly host?: string;
  /** Added to the test server's certificate and key, on the https scheme. */
  readonly tls?: HttpsServerOptions;
}

async function serve(scheme: "http" | "https", answer: Answer, options: ServeOptions = {}): Promise<Served> {
  const host = options.host ?? "127.0.0.1";
  const received: Received[] = [];
  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
        remoteAddress: request.socket.remoteAddress,
        authorized: scheme === "https" ? (request.socket as TLSSocket).authorized : undefined,
      });
      answer(response, request);
    });
  };
  const server =
    scheme === "https"
      ? createHttpsServer({ cert: TLS.server.cert, key: TLS.server.key, ...options.tls }, listener)
      : createHttpServer(listener);
  running.push(server);
  const port = await listening(server, host);
  return { origin: `${scheme}://${host.includes(":") ? `[${host}]` : host}:${port}`, received };
}

/** The origin of a port that was listening a moment ago and no longer is. */
async function refusingOrigin(scheme: "http" | "https"): Promise<string> {
  const server = createHttpServer();
  const port = await listening(server, "127.0.0.1");
  await stop(server);
  return `${scheme}://127.0.0.1:${port}`;
}

/** A GET with a live signal and a limit no answer below comes near, varied field by field. */
function outbound(url: string, overrides: Partial<Omit<OutboundRequest, "url">> = {}): OutboundRequest {
  return {
    method: "GET",
    url: new URL(url),
    headers: {},
    signal: new AbortController().signal,
    maxBytes: 1_048_576,
    ...overrides,
  };
}

/** The RequestFailure a send rejected with; the test fails when it resolved, or rejected with anything else. */
async function failureOf(sending: Promise<unknown>): Promise<RequestFailure> {
  const outcome = await sending.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(RequestFailure);
  return outcome as RequestFailure;
}

/** The redirect refusal a send rejected with: the ConnectionError every HTTP transport has shared since #1086. */
async function refusalOf(sending: Promise<unknown>): Promise<ConnectionError> {
  const outcome = await sending.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(ConnectionError);
  return outcome as ConnectionError;
}

/** One of the two ways a request leaves the process, and the code it reports for a refused port. */
interface Path {
  readonly name: string;
  readonly scheme: "http" | "https";
  readonly send: SendRequest;
  /** Bun's fetch names a refusal in its own words; node:https reports the socket's errno. */
  readonly refusedCode: string;
}

// A mutable array: bun's describe.each takes a readonly table only when its rows are tuples.
const PATHS: Path[] = [
  { name: "plaintext through fetch", scheme: "http", send: createSendRequest(null), refusedCode: "ConnectionRefused" },
  { name: "TLS through node:https", scheme: "https", send: createSendRequest(VERIFYING), refusedCode: "ECONNREFUSED" },
];

/** The request function for a TLS panel, refusing to go on when the panel maps to plaintext. */
function sendFor(ssl: SSLConfig): SendRequest {
  const material = tlsMaterialFor(ssl);
  // A mapping that answered null would send through fetch, which refuses the test CA too, and a
  // TLS verdict below would then pass on the wrong path.
  expect(material).not.toBeNull();
  return createSendRequest(material);
}

describe("tlsMaterialFor", () => {
  test("no TLS panel, and mode disable, mean plaintext", () => {
    expect(tlsMaterialFor(undefined)).toBeNull();
    expect(tlsMaterialFor({ mode: "disable" })).toBeNull();
    // The control: the first mode that encrypts is material.
    expect(tlsMaterialFor({ mode: "require" })).not.toBeNull();
  });

  test("disable ignores whatever material the panel still holds", () => {
    const held = { caCert: "the CA", clientCert: "the cert", clientKey: "the key", rejectUnauthorized: true };
    expect(tlsMaterialFor({ mode: "disable", ...held })).toBeNull();
    // The control: the same fields under a mode that encrypts are material.
    expect(tlsMaterialFor({ mode: "verify-ca", ...held })).not.toBeNull();
  });

  test.each([
    ["require", false],
    ["verify-system", true],
    ["verify-ca", true],
    ["verify-full", true],
  ] as const)("%s sets rejectUnauthorized to %p", (mode, rejectUnauthorized) => {
    expect(tlsMaterialFor({ mode })).toStrictEqual({ rejectUnauthorized });
  });

  test("an explicit rejectUnauthorized wins over the mode, both ways", () => {
    expect(tlsMaterialFor({ mode: "verify-full", rejectUnauthorized: false })).toStrictEqual({
      rejectUnauthorized: false,
    });
    expect(tlsMaterialFor({ mode: "require", rejectUnauthorized: true })).toStrictEqual({ rejectUnauthorized: true });
  });

  test("the CA, the client certificate and its key are copied under node:https's names", () => {
    const panel = { mode: "verify-ca", caCert: "the CA", clientCert: "the cert", clientKey: "the key" } as const;
    expect(tlsMaterialFor(panel)).toStrictEqual({
      rejectUnauthorized: true,
      ca: "the CA",
      cert: "the cert",
      key: "the key",
    });
  });

  test("an empty field is no material, rather than empty material", () => {
    // A cleared form field arrives as "", which is not a certificate.
    expect(tlsMaterialFor({ mode: "verify-ca", caCert: "", clientCert: "", clientKey: "" })).toStrictEqual({
      rejectUnauthorized: true,
    });
    // The control: the same field with text in it is copied.
    expect(tlsMaterialFor({ mode: "verify-ca", caCert: "the CA" })).toStrictEqual({
      rejectUnauthorized: true,
      ca: "the CA",
    });
  });
});

describe("the TLS fixtures", () => {
  // Every TLS verdict below means something only if these hold, so they are checked rather than
  // assumed: a regenerated set that broke one would otherwise surface as a handshake failure
  // somewhere else, or as a refusal for the wrong reason.
  const ca = new X509Certificate(TLS.ca);
  const otherCa = new X509Certificate(TLS.otherCa);
  const clientCa = new X509Certificate(TLS.clientCa);
  const server = new X509Certificate(TLS.server.cert);
  const client = new X509Certificate(TLS.client.cert);

  test("the server certificate is the test CA's, for localhost, 127.0.0.1 and ::1, and its key matches", () => {
    expect(server.verify(ca.publicKey)).toBe(true);
    expect(server.subjectAltName).toBe("DNS:localhost, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1");
    expect(server.checkPrivateKey(createPrivateKey(TLS.server.key))).toBe(true);
  });

  test("the client certificate is the client CA's alone, and its key matches", () => {
    expect(client.verify(clientCa.publicKey)).toBe(true);
    expect(client.verify(ca.publicKey)).toBe(false);
    expect(client.checkPrivateKey(createPrivateKey(TLS.client.key))).toBe(true);
  });

  test("the unrelated CA signed neither leaf", () => {
    // The controls are the two checks above that answer true for the right issuer.
    expect(server.verify(otherCa.publicKey)).toBe(false);
    expect(client.verify(otherCa.publicKey)).toBe(false);
  });

  test("the three authorities are CAs with names of their own, and the two leaves are not CAs", () => {
    expect([ca.ca, otherCa.ca, clientCa.ca, server.ca, client.ca]).toEqual([true, true, true, false, false]);
    expect(new Set([ca.subject, otherCa.subject, clientCa.subject]).size).toBe(3);
  });

  test("no certificate expires within the life of this suite", () => {
    for (const certificate of [ca, otherCa, clientCa, server, client]) {
      expect(Number(/ (\d{4}) GMT$/.exec(certificate.validTo)?.[1])).toBeGreaterThan(2100);
    }
  });
});

describe("the plaintext path", () => {
  test("reads globalThis.fetch when it sends, not when it was built", async () => {
    const send = createSendRequest(null);
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response("stubbed", { status: 202, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;
    const signal = new AbortController().signal;
    const headers = { "content-type": "application/x-www-form-urlencoded" };

    const answer = await send(
      outbound("http://prometheus.test:9090/api/v1/query", { method: "POST", headers, body: "query=up", signal }),
    );

    expect(answer).toEqual({ status: 202, contentType: "text/plain", body: "stubbed" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://prometheus.test:9090/api/v1/query");
    expect(calls[0].init).toMatchObject({ method: "POST", headers, body: "query=up" });
    expect(calls[0].init?.signal).toBe(signal);
  });

  test("a header value fetch refuses never reaches the failure, though fetch's own message quotes it", async () => {
    const served = await serve("http", (response) => response.end("answered"));
    // The line feed sits inside the value: fetch strips a leading or trailing one, and then sends.
    const headers = { authorization: `Bearer ${PLANTED_HEADER}\ncontinued` };
    // The control: Bun's fetch refuses the value and quotes it whole in its own message.
    const raw = await originalFetch(served.origin, { headers }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(raw).toBeInstanceOf(TypeError);
    expect((raw as TypeError).message).toContain(PLANTED_HEADER);

    const failure = await failureOf(createSendRequest(null)(outbound(served.origin, { headers })));

    expect(failure.reason).toBe("network");
    expect(`${failure.message} ${JSON.stringify(failure.detail)}`).not.toContain(PLANTED_HEADER);
    expect(served.received).toHaveLength(0);
    // The control for the count: a request the runtime accepts is received.
    await createSendRequest(null)(outbound(served.origin));
    expect(served.received).toHaveLength(1);
  });
});

describe.each(PATHS)("$name: a request and its answer", ({ scheme, send, refusedCode }) => {
  test("the method, path, query, headers and body arrive unchanged, and the answer comes back whole", async () => {
    const served = await serve(scheme, (response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"success"}');
    });
    // Every byte PromQL gives meaning to, in a form body.
    const body = new URLSearchParams({ query: 'sum(rate(x[5m])) + 1 # a & b % c = "d"', timeout: "5s" }).toString();
    const headers = {
      authorization: "Bearer reader-bearer-value",
      "content-type": "application/x-www-form-urlencoded",
    };

    const answer = await send(outbound(`${served.origin}/api/v1/query?limit=500`, { method: "POST", headers, body }));

    expect(answer).toEqual({ status: 200, contentType: "application/json", body: '{"status":"success"}' });
    expect(served.received).toHaveLength(1);
    expect(served.received[0]).toMatchObject({ method: "POST", url: "/api/v1/query?limit=500", body });
    expect(served.received[0].headers).toMatchObject(headers);
  });

  test("a GET sends no body", async () => {
    // The control is the test above, where a body does arrive.
    const served = await serve(scheme, (response) => response.end("answered"));

    await send(outbound(`${served.origin}/api/v1/status/buildinfo`));

    expect(served.received[0]).toMatchObject({ method: "GET", url: "/api/v1/status/buildinfo", body: "" });
  });

  test("an answer with no body is an empty body, and no content type is null", async () => {
    const served = await serve(scheme, (response) => {
      response.writeHead(204);
      response.end();
    });

    expect(await send(outbound(served.origin))).toEqual({ status: 204, contentType: null, body: "" });
  });

  test("an error status is an answer to read, not a failure", async () => {
    const served = await serve(scheme, (response) => {
      response.writeHead(422, { "content-type": "application/json" });
      response.end('{"status":"error","errorType":"execution"}');
    });

    expect(await send(outbound(`${served.origin}/api/v1/query`))).toEqual({
      status: 422,
      contentType: "application/json",
      body: '{"status":"error","errorType":"execution"}',
    });
  });

  test("a character split across two chunks arrives whole", async () => {
    const served = await serve(scheme, (response) => {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      // The two bytes of "é", written apart, so the body arrives as two chunks.
      response.write(Buffer.from([0xc3]));
      setTimeout(() => response.end(Buffer.from([0xa9])), 20);
    });

    expect((await send(outbound(served.origin))).body).toBe("é");
  });

  test("a response that ends early is a network failure, never a short body", async () => {
    const served = await serve(scheme, (response) => {
      response.writeHead(200, { "content-length": "100" });
      response.write("0123456789");
      setTimeout(() => response.socket?.destroy(), 50);
    });

    const failure = await failureOf(send(outbound(served.origin)));

    expect(failure.reason).toBe("network");
    expect(failure.detail).toEqual({ code: "ECONNRESET" });
  });

  test("a refused connection is a network failure carrying the runtime's code, and nothing else", async () => {
    const failure = await failureOf(send(outbound(`${await refusingOrigin(scheme)}/api/v1/query`)));

    expect(failure.reason).toBe("network");
    expect(failure.detail).toEqual({ code: refusedCode });
    expect(failure.message).toBe(`The request failed before a complete response arrived (${refusedCode})`);
  });
});

describe("failure classification", () => {
  // Constructed, not captured. Node's fetch rejects with a TypeError whose cause carries the code,
  // a shape a Bun-run suite never meets against a real server, and each TLS code would otherwise
  // need a server misconfigured on purpose to produce it.
  const rejectWith = (error: unknown): void => {
    globalThis.fetch = (async () => {
      throw error;
    }) as unknown as typeof fetch;
  };
  /** A Node fetch failure: a TypeError, with the code on its cause. */
  const nodeFetchFailure = (code: string): TypeError =>
    new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code} 10.0.0.1:9090`), { code }) });
  const sendPlainly = () => createSendRequest(null)(outbound("http://prometheus.test:9090/api/v1/query"));

  test.each([
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "CERT_HAS_EXPIRED",
    "HOSTNAME_MISMATCH",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "ERR_SSL_WRONG_VERSION_NUMBER",
    "ERR_OSSL_PEM_NO_START_LINE",
    "ERR_BORINGSSL",
  ])("%s is a TLS failure naming the code", async (code) => {
    rejectWith(nodeFetchFailure(code));

    const failure = await failureOf(sendPlainly());

    expect(failure.reason).toBe("tls");
    expect(failure.detail).toEqual({ code });
    expect(failure.message).toBe(`The TLS connection failed (${code})`);
  });

  test.each(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET"])(
    "%s is a network failure naming the code",
    async (code) => {
      rejectWith(nodeFetchFailure(code));

      const failure = await failureOf(sendPlainly());

      expect(failure.reason).toBe("network");
      expect(failure.detail).toEqual({ code });
      expect(failure.message).toBe(`The request failed before a complete response arrived (${code})`);
    },
  );

  test("a code on the error itself is read too, where Bun's fetch puts it", async () => {
    const bunFailure = Object.assign(new TypeError("Unable to connect"), { code: "ConnectionRefused" });
    rejectWith(bunFailure);

    expect((await failureOf(sendPlainly())).detail).toEqual({ code: "ConnectionRefused" });
  });

  test("a failure with no code is a network failure, and the runtime's message is not copied", async () => {
    const quoting = new TypeError(`Header 'Authorization' has invalid value: 'Bearer ${PLANTED_HEADER}\ncontinued'`);
    rejectWith(quoting);

    const failure = await failureOf(sendPlainly());

    expect(failure.reason).toBe("network");
    expect(failure.detail).toEqual({});
    expect(failure.message).toBe("The request failed before a complete response arrived");
    // The control: the runtime's own message did carry the value.
    expect(quoting.message).toContain(PLANTED_HEADER);
  });

  test("a rejection that is not an Error is a network failure too", async () => {
    rejectWith("a string, not an Error");

    const failure = await failureOf(sendPlainly());

    expect(failure.reason).toBe("network");
    expect(failure.detail).toEqual({});
  });
});

describe.each(PATHS)("$name: an IPv6 literal", ({ scheme, send }) => {
  test("reaches [::1], and the server sees an IPv6 client", async () => {
    const served = await serve(scheme, (response) => response.end("over IPv6"), { host: "::1" });

    const answer = await send(outbound(`${served.origin}/api/v1/status/buildinfo`));

    expect(answer.body).toBe("over IPv6");
    expect(served.received[0]?.remoteAddress).toBe("::1");
  });
});

describe("TLS through node:https (#1085 S8)", () => {
  /** A TLS server with the test certificate, answering every request with "verified". */
  const verifiedServer = () => serve("https", (response) => response.end("verified"));

  test("verify-full with no CA refuses the test CA's server, naming the runtime's code", async () => {
    const served = await verifiedServer();

    const failure = await failureOf(sendFor({ mode: "verify-full" })(outbound(served.origin)));

    expect(failure.reason).toBe("tls");
    expect(failure.detail).toEqual({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
    expect(failure.message).toBe("The TLS connection failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)");
    expect(served.received).toHaveLength(0);
    // The control: the same server, checked against the CA that signed it, answers.
    expect((await sendFor({ mode: "verify-full", caCert: TLS.ca })(outbound(served.origin))).body).toBe("verified");
    expect(served.received).toHaveLength(1);
  });

  test("require encrypts without verifying, so it reaches the same server with no CA", async () => {
    const served = await verifiedServer();

    expect((await sendFor({ mode: "require" })(outbound(served.origin))).body).toBe("verified");
  });

  test("verify-ca refuses an unrelated CA and accepts the CA that signed the server", async () => {
    // The refusal is sent first on purpose: a connection verified a moment earlier must not be
    // what answers it, whatever the runtime pools.
    const served = await verifiedServer();

    const failure = await failureOf(sendFor({ mode: "verify-ca", caCert: TLS.otherCa })(outbound(served.origin)));

    expect(failure.reason).toBe("tls");
    expect(failure.detail).toEqual({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
    expect(served.received).toHaveLength(0);
    // The control: the CA that did sign it is accepted.
    expect((await sendFor({ mode: "verify-ca", caCert: TLS.ca })(outbound(served.origin))).body).toBe("verified");
    expect(served.received).toHaveLength(1);
  });

  test("rejectUnauthorized false overrides a verifying mode", async () => {
    const served = await verifiedServer();

    const answer = await sendFor({ mode: "verify-full", rejectUnauthorized: false })(outbound(served.origin));

    expect(answer.body).toBe("verified");
  });

  test("a client certificate reaches a server that asks for one", async () => {
    const served = await serve("https", (response) => response.end("client verified"), {
      tls: { requestCert: true, rejectUnauthorized: true, ca: TLS.clientCa },
    });

    // Without one the server ends the handshake. bun 1.4.2 reports that as a reset rather than a
    // TLS code, so only the refusal itself is asserted.
    await failureOf(sendFor({ mode: "verify-full", caCert: TLS.ca })(outbound(served.origin)));
    expect(served.received).toHaveLength(0);

    const withCertificate = sendFor({
      mode: "verify-full",
      caCert: TLS.ca,
      clientCert: TLS.client.cert,
      clientKey: TLS.client.key,
    });
    const answer = await withCertificate(outbound(served.origin));

    expect(answer.body).toBe("client verified");
    expect(served.received).toHaveLength(1);
    expect(served.received[0].authorized).toBe(true);
  });

  test("a TLS request to a plaintext server fails as TLS, and nothing is retried over plain HTTP", async () => {
    const plain = await serve("http", (response) => response.end("plaintext"));

    const failure = await failureOf(createSendRequest(VERIFYING)(outbound(plain.origin.replace("http:", "https:"))));

    expect(failure.reason).toBe("tls");
    expect(failure.detail).toEqual({ code: "ERR_SSL_WRONG_VERSION_NUMBER" });
    expect(plain.received).toHaveLength(0);
    // The control: the same server records a plaintext request when one arrives.
    await createSendRequest(null)(outbound(plain.origin));
    expect(plain.received).toHaveLength(1);
  });

  test("the TLS path sends nothing in plaintext, even for an http URL", async () => {
    const plain = await serve("http", (response) => response.end("plaintext"));

    const failure = await failureOf(createSendRequest(VERIFYING)(outbound(plain.origin)));

    expect(failure.reason).toBe("network");
    expect(failure.detail).toEqual({ code: "ERR_INVALID_PROTOCOL" });
    expect(plain.received).toHaveLength(0);
    // The control: the plaintext path reaches the same server.
    await createSendRequest(null)(outbound(plain.origin));
    expect(plain.received).toHaveLength(1);
  });

  test("TLS material the runtime cannot read is a TLS failure, and nothing is sent", async () => {
    const served = await verifiedServer();
    const unreadable: TlsMaterial = {
      rejectUnauthorized: true,
      ca: TLS.ca,
      cert: "not a certificate",
      key: "not a pem",
    };

    const failure = await failureOf(createSendRequest(unreadable)(outbound(served.origin)));

    expect(failure.reason).toBe("tls");
    expect(failure.detail).toEqual({ code: "ERR_OSSL_PEM_NO_START_LINE" });
    expect(served.received).toHaveLength(0);
    // The control: readable material reaches the same server.
    expect((await createSendRequest(VERIFYING)(outbound(served.origin))).body).toBe("verified");
  });

  test("a header value node:https refuses is never quoted", async () => {
    const served = await verifiedServer();
    const headers = { authorization: `Bearer ${PLANTED_HEADER}\ncontinued` };

    const failure = await failureOf(createSendRequest(VERIFYING)(outbound(served.origin, { headers })));

    expect(failure.reason).toBe("network");
    // The control that the header was what node:https refused: its code for exactly that.
    expect(failure.detail).toEqual({ code: "ERR_INVALID_CHAR" });
    // node:https names the header, never its value, so this check cannot fail on the runtime's words.
    // Its control is the plaintext test "a header value fetch refuses never reaches the failure, though
    // fetch's own message quotes it": both paths word a failure through failureFrom.
    expect(failure.message).not.toContain(PLANTED_HEADER);
    expect(served.received).toHaveLength(0);
    // The control for the count: a request with a header node:https accepts is received.
    expect((await createSendRequest(VERIFYING)(outbound(served.origin))).body).toBe("verified");
    expect(served.received).toHaveLength(1);
  });
});

describe("redirects on the plaintext path (#1085 S2)", () => {
  test("fetch is asked not to follow them", async () => {
    const calls: (RequestInit | undefined)[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init);
      return new Response("answered", { status: 200 });
    }) as unknown as typeof fetch;

    await createSendRequest(null)(outbound("http://prometheus.test:9090/api/v1/query"));

    expect(calls[0]?.redirect).toBe("manual");
  });

  test.each([300, 301, 302, 303, 304, 307, 308, 399])("HTTP %d is refused as a redirect", async (status) => {
    const served = await serve("http", (response) => {
      response.writeHead(status, { location: "/moved" });
      response.end();
    });

    const refusal = await refusalOf(createSendRequest(null)(outbound(served.origin)));

    expect(refusal.message).toBe(
      `The server answered HTTP ${status}, a redirect to ${served.origin}, and redirects are not followed`,
    );
    expect(served.received).toHaveLength(1);
  });

  test.each([200, 299, 400, 404])("HTTP %d is an answer, not a redirect", async (status) => {
    // The control for the table above: the same Location header on a status outside 3xx.
    const served = await serve("http", (response) => {
      response.writeHead(status, { location: "/moved" });
      response.end();
    });

    expect((await createSendRequest(null)(outbound(served.origin))).status).toBe(status);
  });

  test("a redirect whose body already failed is still refused, and the runtime's error does not replace it", async () => {
    // A server that answers 3xx and resets the connection at once can leave fetch a body that has
    // already failed, and cancelling such a body rejects with the runtime's own error: on bun 1.4.2,
    // 103 of 200 such answers from a loopback server did. That race is not deterministic, so the
    // body is constructed here in the state it leaves.
    const reset = new TypeError("The socket connection was closed unexpectedly");
    const failedBody = () => new ReadableStream({ start: (controller) => controller.error(reset) });
    // The control: cancelling a body in that state rejects, with the runtime's error.
    await expect(failedBody().cancel()).rejects.toBe(reset);
    globalThis.fetch = (async () =>
      new Response(failedBody(), { status: 302, headers: { location: "/moved" } })) as unknown as typeof fetch;

    const refusal = await refusalOf(createSendRequest(null)(outbound("http://prometheus.test:9090/api/v1/query")));

    expect(refusal.message).toBe(
      "The server answered HTTP 302, a redirect to http://prometheus.test:9090, and redirects are not followed",
    );
  });
});

describe.each(PATHS)("$name: redirects (#1085 S2)", ({ scheme, send }) => {
  test("a 307 is refused: its target receives nothing, and only the Location origin is named", async () => {
    const target = await serve(scheme, (response) => response.end("followed"));
    const location = `${target.origin}/landed?next=planted-query#planted-fragment`;
    const redirector = await serve(scheme, (response) => {
      response.writeHead(307, { location, "content-type": "text/plain" });
      response.end(PLANTED_BODY);
    });
    const headers = { authorization: `Bearer ${PLANTED_HEADER}`, "content-type": "application/x-www-form-urlencoded" };

    const refusal = await refusalOf(
      send(outbound(`${redirector.origin}/api/v1/query`, { method: "POST", headers, body: "query=up" })),
    );

    expect(refusal.message).toBe(
      `The server answered HTTP 307, a redirect to ${target.origin}, and redirects are not followed`,
    );
    expect(target.received).toHaveLength(0);
    // The control: the request did reach the server that redirected it, header and all.
    expect(redirector.received).toHaveLength(1);
    expect(redirector.received[0].headers.authorization).toBe(`Bearer ${PLANTED_HEADER}`);
    for (const marker of ["/landed", "planted-query", "planted-fragment", PLANTED_HEADER, PLANTED_BODY]) {
      expect(refusal.message).not.toContain(marker);
    }
  });

  test("a redirect with no Location header is refused all the same", async () => {
    const served = await serve(scheme, (response) => {
      response.writeHead(302);
      response.end();
    });

    const refusal = await refusalOf(send(outbound(served.origin)));

    expect(refusal.message).toBe(
      "The server answered HTTP 302, a redirect with no Location header, and redirects are not followed",
    );
    expect(served.received).toHaveLength(1);
  });

  test("a redirect whose body never ends is refused without being read, and its connection let go", async () => {
    const released = Promise.withResolvers<void>();
    const redirector = await serve(scheme, (response) => {
      response.writeHead(302, { location: "/elsewhere" });
      response.write("a redirect body that never ends ");
      response.on("close", () => released.resolve());
    });

    const refusal = await refusalOf(send(outbound(redirector.origin)));

    expect(refusal.message).toBe(
      `The server answered HTTP 302, a redirect to ${redirector.origin}, and redirects are not followed`,
    );
    // Resolves only when the connection closes: the answer itself never ends.
    await released.promise;
  });
});

describe.each(PATHS)("$name: the byte limit (#1085 S5)", ({ scheme, send }) => {
  test("an answer that keeps streaming is cut off at the limit, and its connection torn down", async () => {
    const released = Promise.withResolvers<void>();
    const served = await serve(scheme, (response) => {
      response.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(16_384, PLANTED_BODY);
      const timer = setInterval(() => response.write(chunk), 1);
      response.on("close", () => {
        clearInterval(timer);
        released.resolve();
      });
    });

    const failure = await failureOf(send(outbound(`${served.origin}/api/v1/query`, { maxBytes: 65_536 })));

    expect(failure.reason).toBe("too_large");
    expect(failure.detail).toEqual({ limitBytes: 65_536 });
    expect(failure.message).toBe(
      "The response exceeded the 65536-byte limit for one response, so it was not read to the end",
    );
    expect(failure.message).not.toContain(PLANTED_BODY);
    // Resolves only when the connection closes: the server never stops writing.
    await released.promise;
  });

  test("the limit counts bytes: exactly the limit is read, and one byte more is refused", async () => {
    let body = "é".repeat(512); // 1024 bytes of UTF-8 in 512 characters
    const served = await serve(scheme, (response) => response.end(body));

    expect((await send(outbound(served.origin, { maxBytes: 1024 }))).body).toBe(body);

    // 513 characters are still far under 1024, but 1025 bytes are not.
    body = `${body}!`;
    const failure = await failureOf(send(outbound(served.origin, { maxBytes: 1024 })));

    expect(failure.reason).toBe("too_large");
    expect(failure.detail).toEqual({ limitBytes: 1024 });
  });
});

describe.each(PATHS)("$name: cancellation", ({ scheme, send }) => {
  test("an already-aborted signal sends nothing", async () => {
    const served = await serve(scheme, (response) => response.end("answered"));
    const controller = new AbortController();
    controller.abort();

    const failure = await failureOf(send(outbound(served.origin, { signal: controller.signal })));

    expect(failure.reason).toBe("aborted");
    expect(failure.detail).toEqual({});
    expect(served.received).toHaveLength(0);
    // The control: the same request with a live signal is sent and answered.
    expect((await send(outbound(served.origin))).body).toBe("answered");
    expect(served.received).toHaveLength(1);
  });

  test("an abort while the server holds the answer is a cancellation", async () => {
    const arrived = Promise.withResolvers<void>();
    const served = await serve(scheme, () => arrived.resolve());
    const controller = new AbortController();

    const sending = send(outbound(served.origin, { signal: controller.signal }));
    await arrived.promise;
    controller.abort();
    const failure = await failureOf(sending);

    expect(failure.reason).toBe("aborted");
    expect(failure.message).toBe("The request was cancelled");
    expect(served.received).toHaveLength(1);
  });

  test("a caller's own abort reason is a cancellation too, whatever it says", async () => {
    const arrived = Promise.withResolvers<void>();
    const served = await serve(scheme, () => arrived.resolve());
    const controller = new AbortController();

    const sending = send(outbound(served.origin, { signal: controller.signal }));
    await arrived.promise;
    // Only AbortSignal.timeout's own reason is a deadline, not a reason that talks about time.
    controller.abort(new Error("the timeout the caller chose"));

    expect((await failureOf(sending)).reason).toBe("aborted");
  });

  test("a deadline that fires while the body streams is a deadline, not a cancellation", async () => {
    const served = await serve(scheme, (response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"status":"success","data":');
    });

    const failure = await failureOf(send(outbound(served.origin, { signal: AbortSignal.timeout(100) })));

    expect(failure.reason).toBe("deadline");
    expect(failure.detail).toEqual({});
    expect(failure.message).toBe("The request did not finish within its time limit");
  });
});
