/**
 * What the Prometheus TLS path makes of a 101 that announces an upgrade, as data two runtimes can compare: the failure
 * the send rejects with and whether the peer saw its connection close. tests/unit/db/prometheus/upgrade-runtimes.test.ts
 * computes this under Bun and again in a Node child process from a bundle of this file, and the two must be equal.
 *
 * The peer keeps its side of the switched socket open, so the connection closes only if the client destroys the socket
 * node:https handed over. Bun also closes it when the request is destroyed; Node does not, so the Node run is the one
 * that tells whether the client closes it itself.
 */
import { createServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { createSendRequest, RequestFailure } from "@/lib/db/providers/timeseries/prometheus/request";
import { answerWithUpgrade } from "./upgrade-answer";
import { ALLOWS_PRIVATE_HOSTS } from "./egress-decisions";

export interface UpgradeMaterial {
  /** The CA that signed `cert`. */
  readonly ca: string;
  /** For 127.0.0.1. */
  readonly cert: string;
  readonly key: string;
}

export interface UpgradeOutcome {
  /** `<name> <reason>: <message>` of the failure the send rejected with, or "answered". */
  readonly failure: string;
  /** Whether the peer saw the connection close within a second of the send settling. */
  readonly peerClosed: boolean;
}

const CLOSE_BOUND_MS = 1000;

export async function prometheusUpgradeOutcome(material: UpgradeMaterial): Promise<UpgradeOutcome> {
  const peerSockets: Socket[] = [];
  let closed: Promise<void> | undefined;
  const server = createServer({ cert: material.cert, key: material.key }, (request) => {
    peerSockets.push(request.socket);
    closed = answerWithUpgrade(request.socket, "upgrade");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const send = createSendRequest({ rejectUnauthorized: true, ca: material.ca }, ALLOWS_PRIVATE_HOSTS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const failure = await send({
      method: "GET",
      url: new URL(`https://127.0.0.1:${port}/api/v1/query?query=up`),
      headers: {},
      // Well past the moment the 101 arrives, so a request left waiting fails as a deadline.
      signal: AbortSignal.timeout(3000),
      maxBytes: 1_048_576,
    }).then(
      () => "answered",
      (error: unknown) =>
        error instanceof RequestFailure ? `${error.name} ${error.reason}: ${error.message}` : String(error),
    );
    const late = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), CLOSE_BOUND_MS);
    });
    const peerClosed = closed === undefined ? false : await Promise.race([closed.then(() => true as const), late]);
    return { failure, peerClosed };
  } finally {
    clearTimeout(timer);
    for (const socket of peerSockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
