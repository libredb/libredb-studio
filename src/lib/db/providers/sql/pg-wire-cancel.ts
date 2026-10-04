/**
 * The PostgreSQL wire protocol's own cancel: a CancelRequest on a fresh connection (#1364).
 *
 * `postgres.ts` cancels with `SELECT pg_cancel_backend(pid)`, which only an engine that
 * implements that function honours. Measured on 2026-10-03 and 2026-10-04, three engines
 * the provider connects to do not: CockroachDB v26.3.2 answers `unknown function:
 * pg_cancel_backend()`, Materialize 26.44.1 refuses it with a bound parameter, and
 * RisingWave 3.1.0 answers `f`. Each kept running the statement. The CancelRequest is the
 * protocol's own route, the one `psql` takes on Ctrl+C, and CockroachDB v26.3.2 stopped
 * `SELECT pg_sleep(20)` on it within a second.
 *
 * The request names the backend by the process id and secret key the server handed the
 * session at startup (BackendKeyData), so it reaches exactly that session's statement. The
 * server sends no reply: it closes the connection, and whether the statement stopped is
 * only visible on the session itself, which is why the caller watches the run settle.
 *
 * Sent without TLS, as libpq sent it before PostgreSQL 17. The server reads a CancelRequest
 * before any authentication and before `pg_hba.conf` applies, so a server reachable for the
 * session takes it; a proxy that refuses plaintext connections refuses it, and the caller
 * then reports the cancel as not confirmed.
 */
import { connect, type Socket } from "node:net";

/** CancelRequest's fixed code, `1234 << 16 | 5678`. */
const CANCEL_REQUEST_CODE = 80877102;

/** Where to send it and whom it names. */
export interface PgCancelTarget {
  host: string;
  port: number;
  processID: number;
  secretKey: number;
}

/** The 16-byte CancelRequest message: length, code, process id, secret key. */
export function cancelRequestMessage(processID: number, secretKey: number): Buffer {
  const message = Buffer.alloc(16);
  message.writeInt32BE(16, 0);
  message.writeInt32BE(CANCEL_REQUEST_CODE, 4);
  message.writeInt32BE(processID, 8);
  message.writeInt32BE(secretKey, 12);
  return message;
}

/**
 * Send one CancelRequest and resolve once the server has closed the connection: true when
 * the request was written, false when the connection failed or did not close in
 * `timeoutMs`. True says the server received it, not that the statement stopped.
 *
 * `beforeSend` is asked once the socket is open, immediately before the bytes go out: the
 * session's statement may have finished while the socket was connecting, and a pooled
 * session can by then be running somebody else's, which the request would stop instead.
 */
export function sendPgCancelRequest(
  target: PgCancelTarget,
  timeoutMs: number,
  beforeSend: () => boolean = () => true,
): Promise<boolean> {
  return new Promise((resolve) => {
    let sent = false;
    let timedOut = false;
    // A host starting with "/" is a Unix socket directory, which the server listens in
    // under `.s.PGSQL.<port>`, the way `pg` itself connects to it.
    const socket: Socket = target.host.startsWith("/")
      ? connect(`${target.host}/.s.PGSQL.${target.port}`)
      : connect(target.port, target.host);
    socket.setTimeout(timeoutMs, () => {
      timedOut = true;
      socket.destroy();
    });
    socket.once("connect", () => {
      if (!beforeSend()) {
        socket.destroy();
        return;
      }
      sent = true;
      socket.end(cancelRequestMessage(target.processID, target.secretKey));
    });
    socket.once("error", () => socket.destroy());
    socket.once("close", () => resolve(sent && !timedOut));
  });
}
