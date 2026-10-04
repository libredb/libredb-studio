/**
 * createNodeTransport over TLS: the material of the SSL / TLS panel reaches the handshake, and the certificate is
 * checked against the connection's identity (vector-family spec 3.7, the TLS matrix of R32 9, etcd E5).
 *
 * The certificates are made with openssl when this file starts and never committed (makeCertificates in
 * tests/helpers/node-transport-fixtures.ts). A tunnel-shaped connection is the local forward, 127.0.0.1, dialled with
 * the far end as its identity, which is all the factory's SSH tunnel leaves of itself, so no SSH server is needed.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import { createNodeTransport, type NodeTransport, nodeTlsMaterial, TransportError } from "@/lib/db/http/node-transport";
import type { SSLConfig } from "@/lib/types";
import {
  closeAll,
  httpListener,
  httpsListener,
  jsonAnswer,
  type Listener,
  makeCertificates,
  type TransportCertificates,
} from "../../../helpers/node-transport-fixtures";

let certificates: TransportCertificates;
beforeAll(() => {
  certificates = makeCertificates();
}, 30_000);

const transports: NodeTransport[] = [];
afterEach(async () => {
  for (const transport of transports.splice(0)) transport.close();
  await closeAll();
});

const ok = jsonAnswer(200, "{}");
const KEY_HEADER = "tls-secret-key";

/** One GET through a new connection to `host` on the listener's port, with the panel `ssl` and the identity `identity`. */
async function call(host: string, listener: Listener, ssl: SSLConfig, identity = host, path = "/") {
  const origin = httpOrigin("https", host, listener.port);
  const transport = createNodeTransport({
    origin,
    tls: nodeTlsMaterial(ssl, identity),
    maxSockets: 2,
    headers: { "api-key": KEY_HEADER },
  });
  transports.push(transport);
  return transport.request({
    method: "GET",
    url: endpointUrl(origin, path),
    signal: AbortSignal.timeout(5000),
    maxResponseBytes: 65536,
  });
}

async function failure(run: () => Promise<unknown>): Promise<TransportError> {
  try {
    await run();
  } catch (error) {
    return error as TransportError;
  }
  throw new Error("expected the call to reject");
}

const verifyFull = (caCert?: string): SSLConfig => ({
  mode: "verify-full",
  ...(caCert === undefined ? {} : { caCert }),
});

describe("the panel's material reaches the handshake", () => {
  test("localhost, verified against the CA the panel carries", async () => {
    const listener = await httpsListener(certificates.local, ok);
    expect((await call("localhost", listener, verifyFull(certificates.ca))).status).toBe(200);
    expect(listener.seen[0].headers["accept-encoding"]).toBe("identity");
  });

  test("require encrypts and verifies nothing, so a server whose CA the panel lacks is reached", async () => {
    const listener = await httpsListener(certificates.local, ok);
    expect((await call("localhost", listener, { mode: "require" })).status).toBe(200);
  });

  test("verify-full with no CA does not reach a server the runtime's roots do not trust", async () => {
    const listener = await httpsListener(certificates.local, ok);
    const error = await failure(() => call("localhost", listener, verifyFull()));
    expect(error).toBeInstanceOf(TransportError);
    expect(listener.seen).toHaveLength(0);
  });

  test("a client certificate and key from the panel reach a server that requires one", async () => {
    const listener = await httpsListener({ ...certificates.local, clientCa: certificates.ca }, ok);
    const ssl: SSLConfig = {
      mode: "verify-full",
      caCert: certificates.ca,
      clientCert: certificates.client.cert,
      clientKey: certificates.client.key,
    };
    expect((await call("localhost", listener, ssl)).status).toBe(200);
    const without = await failure(() => call("localhost", listener, verifyFull(certificates.ca)));
    expect(without).toBeInstanceOf(TransportError);
    expect(listener.seen).toHaveLength(1);
  });
});

describe("the identity the certificate is checked against (R32 9, etcd E5)", () => {
  const TLS_FAILURE = /^The TLS connection failed \([A-Z][A-Z0-9_]*\)$/;

  async function refused(run: () => Promise<unknown>): Promise<TransportError> {
    const error = await failure(run);
    expect(error).toBeInstanceOf(TransportError);
    expect(error.kind).toBe("tls");
    expect(error.message).toMatch(TLS_FAILURE);
    expect(error.message).not.toContain(KEY_HEADER);
    return error;
  }

  test("a DNS identity is sent as the server name", async () => {
    const listener = await httpsListener(certificates.local, ok);
    await call("localhost", listener, verifyFull(certificates.ca));
    expect(listener.seen[0].servername).toBe("localhost");
  });

  test("127.0.0.1 is verified against the certificate's IP SAN with no server name sent", async () => {
    const listener = await httpsListener(certificates.local, ok);
    expect((await call("127.0.0.1", listener, verifyFull(certificates.ca))).status).toBe(200);
    expect(listener.seen[0].servername).toBe(false);
  });

  test("[::1] is verified against the IP SAN with no server name sent, the brackets never reaching TLS", async () => {
    const listener = await httpsListener(certificates.local, ok, "::1");
    expect((await call("[::1]", listener, verifyFull(certificates.ca))).status).toBe(200);
    expect(listener.seen[0].servername).toBe(false);
  });

  test("a server-name override: dialling 127.0.0.1 with the identity localhost sends and checks localhost", async () => {
    const listener = await httpsListener(certificates.local, ok);
    expect((await call("127.0.0.1", listener, verifyFull(certificates.ca), "localhost")).status).toBe(200);
    expect(listener.seen[0].servername).toBe("localhost");
  });

  test("a rogue CA is refused as a TLS failure, and nothing reaches the handler", async () => {
    const listener = await httpsListener(certificates.local, ok);
    await refused(() => call("localhost", listener, verifyFull(certificates.rogueCa)));
    expect(listener.seen).toHaveLength(0);
  });

  test("a TLS request answered by a plaintext listener is a TLS failure, and nothing reaches the handler", async () => {
    const listener = await httpListener(ok);
    await refused(() => call("127.0.0.1", listener, verifyFull(certificates.ca)));
    expect(listener.seen).toHaveLength(0);
  });

  test("a wrong name is refused as a TLS failure", async () => {
    const listener = await httpsListener(certificates.farName, ok);
    await refused(() => call("localhost", listener, verifyFull(certificates.ca)));
    expect(listener.seen).toHaveLength(0);
  });

  test("two CAs in one process: each connection trusts its own, good after bad and bad after good", async () => {
    const first = await httpsListener(certificates.local, ok);
    const second = await httpsListener(certificates.second, ok);
    expect((await call("localhost", first, verifyFull(certificates.ca))).status).toBe(200);
    expect((await call("localhost", second, verifyFull(certificates.secondCa))).status).toBe(200);
    await refused(() => call("localhost", first, verifyFull(certificates.secondCa)));
    expect((await call("localhost", first, verifyFull(certificates.ca))).status).toBe(200);
    await refused(() => call("localhost", second, verifyFull(certificates.ca)));
  });

  test("a tunnel to a far end by name verifies the far end's name, never 127.0.0.1", async () => {
    const listener = await httpsListener(certificates.farName, ok);
    expect((await call("127.0.0.1", listener, verifyFull(certificates.ca), "qdrant.test")).status).toBe(200);
    expect(listener.seen[0].servername).toBe("qdrant.test");
  });

  test("a tunnel to a far end by address verifies the far end's IP SAN with no server name", async () => {
    const listener = await httpsListener(certificates.farAddress, ok);
    expect((await call("127.0.0.1", listener, verifyFull(certificates.ca), "10.0.0.5")).status).toBe(200);
    expect(listener.seen[0].servername).toBe(false);
  });

  test("a tunnel is never checked against the local forward: the far end's certificate does not name 127.0.0.1", async () => {
    const listener = await httpsListener(certificates.farAddress, ok);
    await refused(() => call("127.0.0.1", listener, verifyFull(certificates.ca), "127.0.0.1"));
  });
});
