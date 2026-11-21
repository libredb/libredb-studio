/**
 * A `101 Switching Protocols` that announces an upgrade, as a fake peer writes it.
 *
 * node:http hands a 101 carrying `Connection: Upgrade` and an `Upgrade` header to the request's `upgrade` event, never
 * to its response callback, so a client that settles only on the answer or on an error waits for it forever. A 101
 * without those headers is not an upgrade and reaches the response callback like any other status.
 */
import type { Duplex } from "node:stream";

/** The answer, written raw: an h2c upgrade, which no Studio client speaks. */
const UPGRADE_ANSWER = "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n";

/** How the peer answers: the upgrade with its socket kept open, or the upgrade and then a close of its side. */
export type UpgradeAnswer = "upgrade" | "upgrade-close";

/**
 * Writes UPGRADE_ANSWER on `socket`, below any node:http server response, ending the peer's side after it for
 * "upgrade-close", and resolves once the socket has closed, so a test waits on the close rather than on a clock.
 */
export function answerWithUpgrade(socket: Duplex, answer: UpgradeAnswer): Promise<void> {
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.write(UPGRADE_ANSWER);
  if (answer === "upgrade-close") socket.end();
  return closed;
}
