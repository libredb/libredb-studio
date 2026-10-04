/**
 * The channel credentials of the shared gRPC transport (src/lib/db/grpc/credentials.ts): what the SSL / TLS mapping
 * hands grpc-js's `createSsl`, the IP-identity rule of docs/BACKLOG.md D132, and the closing wrapper that lets nothing
 * of a channel outlive its close, a TLS handshake a peer never answers, a socket handed over after the close and a
 * connector made after it among them.
 * The connector cases moved here from the etcd provider's transport tests, their bodies unchanged; the Milvus
 * provider's copies of them asserted nothing these do not.
 * Real handshakes under both runtimes stay in each provider's tls-handshake.test.ts.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import net, { type AddressInfo } from "node:net";
import { type ChannelCredentials, credentials, type experimental, type VerifyOptions } from "@grpc/grpc-js";
import { ClosingCredentials, grpcChannelCredentials } from "@/lib/db/grpc/credentials";
import type { GrpcTlsOptions } from "@/lib/db/grpc/tls";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";

/** The error a call rejects with; a call that answers fails the test. */
async function failure(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => {
      throw new Error("The call answered, though this test expects it to fail");
    },
    (error: unknown) => error,
  );
}

/** Waits, two seconds at most, until `condition` holds: a server's own events arrive after the client's answer. */
async function eventually(condition: () => boolean): Promise<void> {
  // oxlint-disable-next-line no-await-in-loop -- a poll: each check waits for the one before it.
  for (let waited = 0; waited < 2000 && !condition(); waited += 20) await Bun.sleep(20);
}

describe("nothing of a channel outlives close()", () => {
  /** What grpc-js hands a connector for the channel's target; the handshake's name is the host, never an IP. */
  const TARGET: experimental.GrpcUri = { scheme: "dns", path: "transport.test:443" };
  const CHANNEL_CLOSED = "The channel closed before this connection was established";

  /** TCP that reads what arrives and writes nothing, so a handshake never ends: what it holds, and who sent bytes. */
  async function silentListener() {
    const held = new Set<net.Socket>();
    const spoke = new Set<net.Socket>();
    const listener = net.createServer((socket) => {
      held.add(socket);
      socket.on("close", () => held.delete(socket));
      socket.on("error", () => undefined);
      socket.on("data", () => spoke.add(socket));
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    return { listener, held, spoke, port: (listener.address() as AddressInfo).port };
  }

  /**
   * A TCP socket connected to `port`, as grpc-js's own dial hands it to the credentials' connector: with no error
   * listener left on it, so a socket ended with an error would throw here as it would there.
   */
  const dialled = (port: number) =>
    new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.off("error", reject);
        resolve(socket);
      });
      socket.once("error", reject);
    });

  /** grpc-js's own TLS credentials, verifying against the runtime's roots: a peer that never answers shows no certificate. */
  const tlsCredentials = () => credentials.createSsl();

  /** grpc-js's insecure credentials around a connector that hands every socket straight back, as an established one. */
  function establishing(): ChannelCredentials {
    const inner = credentials.createInsecure();
    spyOn(inner, "_createSecureConnector").mockReturnValue({
      connect: (socket) => Promise.resolve({ socket, secure: false }),
      waitForReady: () => Promise.resolve(),
      getCallCredentials: () => credentials.createEmpty(),
      destroy: () => undefined,
    });
    return inner;
  }

  test("destroy() ends every socket still in its handshake and fails its connect, which Node never settles", async () => {
    const silent = await silentListener();
    const connector = new ClosingCredentials(tlsCredentials())._createSecureConnector(TARGET, {});
    const sockets = await Promise.all([dialled(silent.port), dialled(silent.port)]);
    const connecting = sockets.map((socket) => failure(connector.connect(socket)));
    // Both hellos have arrived, so both handshakes are under way.
    await eventually(() => silent.spoke.size === 2);
    expect(silent.spoke.size).toBe(2);
    connector.destroy();
    expect(await Promise.all(connecting)).toMatchObject([{ message: CHANNEL_CLOSED }, { message: CHANNEL_CLOSED }]);
    expect(sockets.map((socket) => socket.destroyed)).toEqual([true, true]);
    await eventually(() => silent.held.size === 0);
    silent.listener.close();
    expect(silent.held.size).toBe(0);
  }, 10_000);

  test("a socket handed over after destroy(), whose TCP connect outlived the close, is ended before any handshake", async () => {
    const silent = await silentListener();
    const connector = new ClosingCredentials(tlsCredentials())._createSecureConnector(TARGET, {});
    connector.destroy();
    const socket = await dialled(silent.port);
    expect(await failure(connector.connect(socket))).toMatchObject({ message: CHANNEL_CLOSED });
    expect(socket.destroyed).toBe(true);
    await eventually(() => silent.held.size === 0);
    silent.listener.close();
    // Nothing was read from it: no hello was ever sent.
    expect({ held: silent.held.size, spoke: silent.spoke.size }).toEqual({ held: 0, spoke: 0 });
  }, 10_000);

  test("everything else is grpc-js's own connector: the handshake's answer and failure, readiness, call credentials, destroy()", async () => {
    const inner = tlsCredentials();
    const handshake = { socket: new net.Socket(), secure: true };
    const refusal = new Error("the handshake failed");
    const ready = Promise.resolve();
    const callCredentials = credentials.createEmpty();
    const [answered, refused] = [new net.Socket(), new net.Socket()];
    const destroyed: string[] = [];
    const recording: experimental.SecureConnector = {
      connect: (socket) => (socket === answered ? Promise.resolve(handshake) : Promise.reject(refusal)),
      waitForReady: () => ready,
      getCallCredentials: () => callCredentials,
      destroy: () => {
        destroyed.push("inner");
      },
    };
    const created = spyOn(inner, "_createSecureConnector").mockReturnValue(recording);
    const connector = new ClosingCredentials(inner)._createSecureConnector(
      TARGET,
      { "grpc.enable_retries": 0 },
      callCredentials,
    );
    expect(created.mock.calls).toEqual([[TARGET, { "grpc.enable_retries": 0 }, callCredentials]]);
    expect(await connector.connect(answered)).toBe(handshake);
    expect(await failure(connector.connect(refused))).toBe(refusal);
    expect(connector.waitForReady()).toBe(ready);
    expect(connector.getCallCredentials()).toBe(callCredentials);
    connector.destroy();
    // No handshake was pending, so nothing was ended; the inner connector was destroyed too.
    expect({ destroyed, answered: answered.destroyed, refused: refused.destroyed }).toEqual({
      destroyed: ["inner"],
      answered: false,
      refused: false,
    });
  });

  test("the credentials keep grpc-js's security flag, and equal only themselves, plaintext or TLS, so no two clients share a subchannel", () => {
    const tls = new ClosingCredentials(tlsCredentials());
    const plaintext = new ClosingCredentials(credentials.createInsecure());
    expect({ tls: tls._isSecure(), plaintext: plaintext._isSecure() }).toEqual({ tls: true, plaintext: false });
    expect({ tls: tls._equals(tls), plaintext: plaintext._equals(plaintext) }).toEqual({ tls: true, plaintext: true });
    expect({
      tls: tls._equals(new ClosingCredentials(tlsCredentials())),
      plaintext: plaintext._equals(new ClosingCredentials(credentials.createInsecure())),
    }).toEqual({ tls: false, plaintext: false });
    // The controls: grpc-js's own TLS credentials, built twice as two clients build them, are not equal, while its
    // insecure credentials equal any other, which would let two plaintext clients of one endpoint share a subchannel,
    // and one client's close() reach the other's connection.
    expect({
      tls: tlsCredentials()._equals(tlsCredentials()),
      plaintext: credentials.createInsecure()._equals(credentials.createInsecure()),
    }).toEqual({ tls: false, plaintext: true });
  });

  test("from destroy() on, readiness is refused, naming the closed channel, so grpc-js dials nothing more and its own connector is not asked", async () => {
    const inner = credentials.createInsecure();
    const ready = Promise.resolve();
    let asked = 0;
    spyOn(inner, "_createSecureConnector").mockReturnValue({
      connect: (socket) => Promise.resolve({ socket, secure: false }),
      waitForReady: () => {
        asked++;
        return ready;
      },
      getCallCredentials: () => credentials.createEmpty(),
      destroy: () => undefined,
    });
    const connector = new ClosingCredentials(inner)._createSecureConnector(TARGET, {});
    // The control: before destroy(), readiness is grpc-js's own.
    expect(connector.waitForReady()).toBe(ready);
    connector.destroy();
    expect(await failure(connector.waitForReady())).toMatchObject({ message: CHANNEL_CLOSED });
    expect(asked).toBe(1);
  });

  test("a connector made after the channel's close, for an address grpc-js hands on late, refuses readiness and ends a socket handed to it", async () => {
    const silent = await silentListener();
    const inner = credentials.createInsecure();
    let asked = 0;
    spyOn(inner, "_createSecureConnector").mockReturnValue({
      connect: (socket) => Promise.resolve({ socket, secure: false }),
      waitForReady: () => {
        asked++;
        return Promise.resolve();
      },
      getCallCredentials: () => credentials.createEmpty(),
      destroy: () => undefined,
    });
    const closing = new ClosingCredentials(inner);
    // The control: a connector made before the close is ready as grpc-js's own is.
    await closing._createSecureConnector(TARGET, {}).waitForReady();
    closing.endEverySocket();
    const late = closing._createSecureConnector(TARGET, {});
    expect(await failure(late.waitForReady())).toMatchObject({ message: CHANNEL_CLOSED });
    const socket = await dialled(silent.port);
    expect(await failure(late.connect(socket))).toMatchObject({ message: CHANNEL_CLOSED });
    expect({ destroyed: socket.destroyed, asked }).toEqual({ destroyed: true, asked: 1 });
    await eventually(() => silent.held.size === 0);
    silent.listener.close();
    expect(silent.held.size).toBe(0);
  });

  test("a connector's destroy() alone leaves an established socket open, as a load balancer's release needs; the channel's close ends it", async () => {
    const silent = await silentListener();
    const closing = new ClosingCredentials(establishing());
    const connector = closing._createSecureConnector(TARGET, {});
    const socket = await dialled(silent.port);
    expect((await connector.connect(socket)).socket).toBe(socket);
    // A load balancer's release: grpc-js then shuts the transport down gracefully, so a call in flight finishes.
    connector.destroy();
    await Bun.sleep(100);
    expect({ destroyed: socket.destroyed, held: silent.held.size }).toEqual({ destroyed: false, held: 1 });
    // The adapter's close().
    closing.endEverySocket();
    expect(socket.destroyed).toBe(true);
    await eventually(() => silent.held.size === 0);
    silent.listener.close();
    expect(silent.held.size).toBe(0);
  });

  test("a socket that closed on its own, ended here or reset by its peer, is held no longer, so the channel's close leaves it be", async () => {
    const silent = await silentListener();
    const closing = new ClosingCredentials(establishing());
    const connector = closing._createSecureConnector(TARGET, {});
    const [ended, reset] = await Promise.all([dialled(silent.port), dialled(silent.port)]);
    // The session grpc-js builds on a socket listens for its errors, and a peer's reset is one.
    reset.on("error", () => undefined);
    await connector.connect(ended);
    await connector.connect(reset);
    await eventually(() => silent.held.size === 2);
    const peerOfReset = [...silent.held].find((peer) => peer.remotePort === reset.localPort);
    const closed = [ended, reset].map((socket) => new Promise((resolve) => socket.once("close", resolve)));
    ended.destroy();
    peerOfReset?.resetAndDestroy();
    await Promise.all(closed);
    const destroys = [spyOn(ended, "destroy"), spyOn(reset, "destroy")];
    closing.endEverySocket();
    silent.listener.close();
    expect({ peerOfReset: peerOfReset !== undefined, destroyed: destroys.map((spy) => spy.mock.calls.length) }).toEqual(
      { peerOfReset: true, destroyed: [0, 0] },
    );
  });
});

describe("grpcChannelCredentials: the SSL / TLS mapping's credentials", () => {
  const certificates = loadTlsFixtures();
  const TLS: GrpcTlsOptions = {
    mode: "verify-full",
    verify: true,
    identity: "transport.test",
    identityIsIp: false,
    serverNameOverride: "transport.test",
  };
  const IP_SERVER_NAME = "server.invalid";
  const atIp = (ip: string): GrpcTlsOptions => ({
    ...TLS,
    identity: ip,
    identityIsIp: true,
    serverNameOverride: IP_SERVER_NAME,
  });

  /** What each `createSsl` call received: the CA, the key and the certificate as text or null, and the verify options. */
  function recordedSsl(tls: GrpcTlsOptions) {
    const createSsl = spyOn(credentials, "createSsl");
    try {
      const made = grpcChannelCredentials(tls);
      expect(made._isSecure()).toBe(true);
      const [ca, key, cert, verify] = createSsl.mock.calls[0];
      const text = (buffer: Buffer | null | undefined) => (buffer == null ? null : buffer.toString("utf8"));
      return { calls: createSsl.mock.calls.length, ca: text(ca), key: text(key), cert: text(cert), verify };
    } finally {
      createSsl.mockRestore();
    }
  }

  test("no TLS is grpc-js's insecure credentials", () => {
    const createSsl = spyOn(credentials, "createSsl");
    try {
      expect(grpcChannelCredentials(undefined)._isSecure()).toBe(false);
      expect(createSsl).not.toHaveBeenCalled();
    } finally {
      createSsl.mockRestore();
    }
  });

  test("every verifying mode passes the CA, the pair and verify options to createSsl", () => {
    const pair = { cert: certificates.client.cert, key: certificates.client.key };
    expect(recordedSsl({ ...TLS, ca: certificates.ca, clientCertificate: pair })).toEqual({
      calls: 1,
      ca: certificates.ca,
      key: pair.key,
      cert: pair.cert,
      verify: { rejectUnauthorized: true },
    });
    // No CA is the runtime's roots, and no pair sends no client certificate.
    expect(recordedSsl({ ...TLS, mode: "verify-system" })).toEqual({
      calls: 1,
      ca: null,
      key: null,
      cert: null,
      verify: { rejectUnauthorized: true },
    });
    // `require`, or an explicit rejectUnauthorized false, checks nothing, an IP identity included.
    expect(recordedSsl({ ...atIp("10.0.0.5"), mode: "require", verify: false })).toEqual({
      calls: 1,
      ca: null,
      key: null,
      cert: null,
      verify: { rejectUnauthorized: false },
    });
    // A name identity is checked by grpc-js through the override name, so no checkServerIdentity of its own.
    expect(Object.keys(recordedSsl(TLS).verify as VerifyOptions)).toEqual(["rejectUnauthorized"]);
  });

  test("an IP identity checks the certificate against the IP, whatever host grpc-js passes", () => {
    // tests/fixtures/tls/server.crt names DNS:localhost, IP:127.0.0.1 and IP:::1.
    const certificate = new X509Certificate(certificates.server.cert).toLegacyObject();
    const check = (ip: string) => {
      const verify = recordedSsl(atIp(ip)).verify as VerifyOptions;
      expect(verify.rejectUnauthorized).toBe(true);
      // grpc-js hands the check the override name, never the dialled address (D132).
      return verify.checkServerIdentity?.(IP_SERVER_NAME, certificate);
    };
    expect(check("127.0.0.1")).toBeUndefined();
    const refused = check("10.0.0.5");
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain("IP: 10.0.0.5 is not in the cert's list");
  });
});
