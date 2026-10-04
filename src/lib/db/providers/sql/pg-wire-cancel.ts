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
 * ENCRYPTED WHEREVER THE SESSION IS. When the session's client was configured with `ssl`,
 * the cancel connection asks for TLS first (SSLRequest), upgrades with the same TLS options
 * and server name the `pg` driver uses for the session itself (`pg/lib/connection.js`
 * `upgradeToSSL`), and only then sends the CancelRequest, as `pg`'s own `Client.cancel` path
 * and libpq since PostgreSQL 17 do. A server that answers the SSLRequest with `N` gets
 * nothing: the session was configured to require TLS, so the key is not sent in the clear.
 * Without `ssl` the request goes in plaintext, as the session itself does.
 */
import { connect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";

/** CancelRequest's fixed code, `1234 << 16 | 5678`. */
const CANCEL_REQUEST_CODE = 80877102;
/** SSLRequest's fixed code, `1234 << 16 | 5679`. */
const SSL_REQUEST_CODE = 80877103;
/** The byte a server answers an SSLRequest with when it will speak TLS. */
const SSL_ACCEPTED = 0x53; // "S"

/** Where to send it, whom it names, and the session's own TLS setting (`pg`'s `ssl`). */
export interface PgCancelTarget {
  host: string;
  port: number;
  processID: number;
  secretKey: number;
  ssl?: boolean | ConnectionOptions;
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

/** The 8-byte SSLRequest message: length, code. */
export function sslRequestMessage(): Buffer {
  const message = Buffer.alloc(8);
  message.writeInt32BE(8, 0);
  message.writeInt32BE(SSL_REQUEST_CODE, 4);
  return message;
}

/**
 * The TLS options `pg` would use for the session: its `ssl` object (with `key`, which `pg`
 * makes non-enumerable, copied by name), and the host as the server name unless it is an IP.
 */
function tlsOptions(target: PgCancelTarget, socket: Socket): ConnectionOptions {
  const ssl = target.ssl;
  const options: ConnectionOptions = typeof ssl === "object" ? { ...ssl, key: ssl.key } : {};
  return { ...options, socket, ...(isIP(target.host) === 0 && { servername: target.host }) };
}

/**
 * Send one CancelRequest and resolve once the server has closed the connection: true when
 * the request was written, false when the connection failed, TLS was refused or failed, or
 * the connection did not close in `timeoutMs`. True says the server received it, not that
 * the statement stopped.
 *
 * `beforeSend` is asked once the socket is open, before anything goes out: the session's
 * statement may have finished while the socket was connecting, and a pooled session can by
 * then be running somebody else's, which the request would stop instead.
 */
export function sendPgCancelRequest(
  target: PgCancelTarget,
  timeoutMs: number,
  beforeSend: () => boolean = () => true,
): Promise<boolean> {
  return new Promise((resolve) => {
    let sent = false;
    let timedOut = false;
    const message = cancelRequestMessage(target.processID, target.secretKey);
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
      if (!target.ssl) {
        sent = true;
        socket.end(message);
        return;
      }
      socket.once("data", (answer: Buffer) => {
        if (answer[0] !== SSL_ACCEPTED) {
          socket.destroy();
          return;
        }
        const secure = tlsConnect(tlsOptions(target, socket));
        secure.once("secureConnect", () => {
          sent = true;
          secure.end(message);
        });
        secure.once("error", () => socket.destroy());
      });
      socket.write(sslRequestMessage());
    });
    socket.once("error", () => socket.destroy());
    socket.once("close", () => resolve(sent && !timedOut));
  });
}
