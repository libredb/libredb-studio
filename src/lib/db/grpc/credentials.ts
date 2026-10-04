/**
 * The channel credentials of the SSL / TLS mapping, with the IP-identity rule of docs/BACKLOG.md D132, and the closing
 * wrapper that lets nothing of a channel outlive its close (the measured record of grpc-js 1.14.5, kept whole).
 * Nothing here knows about an engine, and no provider is imported; server-only.
 */
import type { Socket } from "node:net";
import { checkServerIdentity } from "node:tls";
import {
  type CallCredentials,
  ChannelCredentials,
  type ChannelOptions,
  credentials,
  type experimental,
  type VerifyOptions,
} from "@grpc/grpc-js";
import type { GrpcTlsOptions } from "./tls";

/**
 * The credentials of the SSL / TLS mapping: undefined is `createInsecure()`; otherwise `createSsl` with the pasted CA
 * or the runtime's roots, the client pair when configured, and verify options:
 * `verify: false` is `{ rejectUnauthorized: false }` (the `require` mode, or an explicit `rejectUnauthorized: false`);
 * a name identity is `{ rejectUnauthorized: true }`, checked through the override name;
 * an IP identity adds a `checkServerIdentity` closed over the IP, which never reads its `host` argument, because
 * grpc-js hands it the override name (D132).
 * The channel wraps either kind in ClosingCredentials.
 */
export function grpcChannelCredentials(tls: GrpcTlsOptions | undefined): ChannelCredentials {
  if (tls === undefined) return credentials.createInsecure();
  const pair = tls.clientCertificate;
  return credentials.createSsl(
    tls.ca === undefined ? null : Buffer.from(tls.ca),
    pair === undefined ? null : Buffer.from(pair.key),
    pair === undefined ? null : Buffer.from(pair.cert),
    verifyOptions(tls),
  );
}

function verifyOptions(tls: GrpcTlsOptions): VerifyOptions {
  if (!tls.verify) return { rejectUnauthorized: false };
  if (!tls.identityIsIp) return { rejectUnauthorized: true };
  const ip = tls.identity;
  return {
    rejectUnauthorized: true,
    checkServerIdentity: (_override, certificate) => checkServerIdentity(ip, certificate),
  };
}

/** What a connector of a closed channel refuses with. */
const CHANNEL_CLOSED = "The channel closed before this connection was established";

/**
 * grpc-js's own credentials, plaintext or TLS, wrapped so that nothing of a channel outlives the channel's
 * close(). In grpc-js 1.14.5, `client.close()` reaches the credentials' connector only through its `destroy()`
 * (`Subchannel.unref`, subchannel.ts), which grpc-js's own connectors leave empty, and four things outlived it
 * (measured under Node 24.14.0 and Bun 1.4.2). A TLS handshake the peer never answers:
 * `Http2SubchannelConnector.connect` (transport.ts) hands the TCP socket it connected to the connector, whose
 * `connect` (`SecureConnectorImpl`, channel-credentials.ts) waits for the handshake with no bound, so the socket, and
 * the process, stayed alive. A dial after the close: `Subchannel.unref` moves only a CONNECTING or READY subchannel to
 * IDLE, and one in TRANSIENT_FAILURE dials the endpoint again when its backoff timer ends (`handleBackoffTimer`),
 * whatever its refcount, about a second after the attempt that failed. And an HTTP/2 session still waiting for the
 * peer's SETTINGS, plaintext or TLS: `createSession` (transport.ts) opens it over the connector's socket and unrefs it,
 * and only `Http2SubchannelConnector.shutdown()`, which nothing calls, would close it. And a subchannel built after
 * the close: the DNS resolver hands an IP target's address on in a setImmediate that its `destroy()` does not cancel
 * (`startResolution`, resolver-dns.ts), so a close in the event-loop iteration of the channel's first call, or of its
 * first after grpc-js's idle timeout, met a subchannel made after it, which dialled the endpoint and held the
 * connection; every connection through an SSH tunnel dials such a target, 127.0.0.1.
 * The connector below, the hook `experimental.SecureConnector` describes, ends on `destroy()` every socket still in
 * its handshake, and at once a socket handed over after it, whose TCP connect outlived the close, and fails that
 * connect itself, since Node never settles a handshake whose socket was destroyed (Bun reports ECONNRESET); and from
 * `destroy()` on it refuses `waitForReady()`, which grpc-js awaits before every TCP connect, so nothing is dialled.
 * It keeps every socket it was handed until that socket closes, and `endEverySocket()`, which the channel's close()
 * calls, ends them all and destroys every connector made after it as it is made, so a subchannel built after the close
 * only retries at grpc-js's backoff, each attempt refused before it dials. A `destroy()` alone ends no socket past its
 * handshake: grpc-js also destroys a connector when the load balancer releases a subchannel whose address left a
 * re-resolution, and then shuts its transport down gracefully, so that a call in flight, a write among them, finishes
 * with an answer.
 * The credentials equal only themselves, so no two clients share a subchannel: grpc-js's insecure credentials equal
 * any other, which would let two plaintext clients of one endpoint share one, and one client's close reach the other.
 */
export class ClosingCredentials extends ChannelCredentials {
  /** Every socket a connector of these credentials was handed, until it closes. */
  private readonly sockets = new Set<Socket>();
  /** Set by the channel's close(): a connector made after it is destroyed as it is made, so it dials nothing. */
  private closed = false;

  constructor(private readonly inner: ChannelCredentials) {
    super();
  }

  _isSecure(): boolean {
    return this.inner._isSecure();
  }

  /** Only themselves, so no client shares another's subchannel, plaintext or TLS. */
  _equals(other: ChannelCredentials): boolean {
    return other === this;
  }

  _createSecureConnector(
    channelTarget: experimental.GrpcUri,
    options: ChannelOptions,
    callCredentials?: CallCredentials,
  ): experimental.SecureConnector {
    const connector = closingConnector(
      this.inner._createSecureConnector(channelTarget, options, callCredentials),
      this.sockets,
    );
    if (this.closed) connector.destroy();
    return connector;
  }

  /**
   * The channel's close(): ends every socket its connectors still hold, in a handshake, a session or a call, and from
   * then on destroys every connector made, one for an address grpc-js hands on after the close among them.
   */
  endEverySocket(): void {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
  }
}

function closingConnector(inner: experimental.SecureConnector, sockets: Set<Socket>): experimental.SecureConnector {
  // Each socket still in its handshake, with the failure that ends its connect.
  const handshaking = new Map<Socket, (reason: Error) => void>();
  let destroyed = false;
  const end = (socket: Socket, fail: (reason: Error) => void) => {
    // Destroyed without an error: grpc-js listens for none on the TCP socket once it has connected.
    socket.destroy();
    fail(new Error(CHANNEL_CLOSED));
  };
  return {
    connect: (socket) =>
      new Promise<experimental.SecureConnectResult>((resolve, reject) => {
        if (destroyed) {
          end(socket, reject);
          return;
        }
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        handshaking.set(socket, reject);
        // Out of its handshake the moment that settles, before grpc-js hears of it, so a destroy() right after a
        // completed handshake leaves the established socket be.
        inner.connect(socket).then(
          (secured) => {
            handshaking.delete(socket);
            resolve(secured);
          },
          (failure: unknown) => {
            handshaking.delete(socket);
            reject(failure);
          },
        );
      }),
    // grpc-js awaits this before each TCP connect, the one a backoff timer that outlived the close starts included.
    waitForReady: () => (destroyed ? Promise.reject(new Error(CHANNEL_CLOSED)) : inner.waitForReady()),
    getCallCredentials: () => inner.getCallCredentials(),
    destroy: () => {
      destroyed = true;
      for (const [socket, fail] of handshaking) end(socket, fail);
      inner.destroy();
    },
  };
}
