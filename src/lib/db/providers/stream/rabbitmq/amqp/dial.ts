/**
 * The one socket the read opens, and the only module of the provider that imports node:net or node:tls.
 *
 * The egress rule is the shared one (`socketEgress`): an IP literal is checked here before dialling, because a literal
 * never calls the lookup hook, and a DNS name dials through the checked lookup, so the address dialled is the address
 * checked. Its refusal is the shared guard's DatabaseConfigError, rethrown unchanged and classified before the connect
 * and TLS classes, so a refused TLS dial yields the egress sentence.
 *
 * The TLS options are built from the endpoint's material as given: `connection-options.ts` already took one trailing dot
 * off a DNS identity, for this endpoint and the management one alike, and the dialled host keeps it.
 *
 * A TLS failure is classified by `tlsFailureKind` from the runtime's code, as the management side does: a plain
 * listener, a certificate that fails verification for this host, or the broker refusing the connection, which is also
 * what a close or a reset after the TCP accept and before the handshake ends means.
 *
 * One attempt, no plain retry after a TLS failure, `noDelay` on every socket. The `connect` and `secureConnect` events
 * are recorded, so a dial stopped by its signal names the phase it was in from what happened, not from elapsed time.
 */
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { DatabaseConfigError } from "@/lib/db/errors";
import { socketEgress } from "@/lib/db/http/egress-policy";
import { isTlsFailureCode, nodeTlsConnectOptions } from "@/lib/db/http/node-transport";
import type { AmqpEndpoint } from "../connection-options";
import { type TlsFailureKind, tlsFailureKind } from "../errors";

/** The narrow socket interface: node's Socket and TLSSocket satisfy it structurally, so no wrapper calls write. */
export interface AmqpSocket {
  write(data: Uint8Array): boolean;
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  pause(): unknown;
  resume(): unknown;
  destroy(): unknown;
  readonly destroyed: boolean;
}

/** Rejected with when the signal aborts before the socket is ready; `phase` from the recorded events. */
export class DialAborted extends Error {
  constructor(readonly phase: "connecting" | "tls") {
    super(`The dial was stopped while ${phase === "tls" ? "the TLS handshake ran" : "connecting"}.`);
    this.name = "DialAborted";
  }
}

/**
 * A dial that failed before the socket was ready: nothing listened, the peer does not speak TLS ("tls"), its
 * certificate failed verification ("certificate"), the broker refused the TLS connection ("client-certificate"), or
 * the network failed.
 */
export class DialFailed extends Error {
  constructor(readonly kind: "refused" | "tls" | "certificate" | "client-certificate" | "network") {
    super(`The dial failed (${kind}).`);
    this.name = "DialFailed";
  }
}

export type AmqpDial = (endpoint: AmqpEndpoint, signal: AbortSignal) => Promise<AmqpSocket>;

/** The DialFailed kind of each TLS failure kind. */
const TLS_DIAL_KIND: Readonly<Record<TlsFailureKind, DialFailed["kind"]>> = {
  "not-tls": "tls",
  certificate: "certificate",
  "client-certificate": "client-certificate",
};

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

/** The egress refusal as the lookup raised it: every listed runtime hands the lookup's error to `error` itself. */
function egressRefusal(error: unknown): DatabaseConfigError | null {
  return error instanceof DatabaseConfigError ? error : null;
}

/** socketEgress(host, { refusesLinkLocal: true }) as the lookup, nodeTlsConnectOptions for TLS, noDelay, one attempt. */
export const dialAmqp: AmqpDial = (endpoint, signal) =>
  new Promise<AmqpSocket>((resolve, reject) => {
    let lookup: ReturnType<typeof socketEgress>;
    try {
      lookup = socketEgress(endpoint.host, { refusesLinkLocal: true });
    } catch (error) {
      reject(error);
      return;
    }
    if (signal.aborted) {
      reject(new DialAborted("connecting"));
      return;
    }
    const target = { host: endpoint.host, port: endpoint.port, noDelay: true, ...(lookup ? { lookup } : {}) };
    const tls = endpoint.tls;
    const socket: Socket = tls === null ? netConnect(target) : tlsConnect({ ...target, ...nodeTlsConnectOptions(tls) });
    socket.setNoDelay(true);
    let connected = false;
    let settled = false;
    const finish = (outcome: { socket: AmqpSocket } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      socket.removeListener("connect", onConnect);
      socket.removeListener("secureConnect", onReady);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      if ("socket" in outcome) {
        resolve(outcome.socket);
        return;
      }
      socket.destroy();
      reject(outcome.error);
    };
    const onConnect = (): void => {
      connected = true;
      if (tls === null) finish({ socket });
    };
    const onReady = (): void => finish({ socket });
    const onError = (error: Error): void => {
      const refusal = egressRefusal(error);
      if (refusal !== null) finish({ error: refusal });
      else if (tls !== null && (connected || isTlsFailureCode(codeOf(error))))
        finish({ error: new DialFailed(TLS_DIAL_KIND[tlsFailureKind(codeOf(error) || undefined)]) });
      else finish({ error: new DialFailed(codeOf(error) === "ECONNREFUSED" ? "refused" : "network") });
    };
    /** A close with no error: after the TCP accept of a TLS dial, the broker refusing the connection. */
    const closedKind = (): DialFailed["kind"] => (tls !== null && connected ? "client-certificate" : "network");
    const onClose = (): void => finish({ error: new DialFailed(closedKind()) });
    const onAbort = (): void => finish({ error: new DialAborted(tls !== null && connected ? "tls" : "connecting") });
    // A late error after the dial settled must never be unhandled: the connection adds its own listener next.
    socket.on("error", () => {});
    socket.on("connect", onConnect);
    if (tls !== null) socket.on("secureConnect", onReady);
    socket.on("error", onError);
    socket.on("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
