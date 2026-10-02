/**
 * The socket openGauss authentication needs (issue #815).
 *
 * Why the substitution happens on a socket and not above one: `pg-protocol`
 * parses each `R` frame into an event the moment it arrives, and the client's
 * handler for that event decides what to send back. openGauss's requests 10
 * (SHA256) and 11 (MD5_SHA256) collide with PostgreSQL's SASL family, so by the
 * time an event exists the driver is already answering the wrong handshake -
 * that is the "SASL: Only mechanism(s) SCRAM-SHA-256 are supported" failure,
 * raised before any query is sent. This Duplex sits between the server's bytes
 * and the parser: an `R` frame that is one of openGauss's two requests is
 * answered here with a `PasswordMessage` and never handed to `pg`; every other
 * frame is forwarded untouched. `pg` therefore completes authentication through
 * a frame sequence it understands (startup -> AuthenticationOk), and everything
 * behind the handshake is the stock PostgreSQL path.
 *
 * The socket also owns TLS when the connection asks for it. Returned from
 * `pg`'s `stream` option this socket is the BOTTOM of the stack, so if `pg`
 * performed the TLS wrap the plaintext frames would sit above it and this
 * filter would see ciphertext. Instead the socket performs the SSLRequest
 * exchange and the TLS handshake itself, and the provider tells `pg`
 * `ssl: false` so it neither negotiates nor wraps - see
 * `OpenGaussProvider.buildPoolConfig`, which is where the connection's own ssl
 * setting is handed to this class instead.
 *
 * The frame filter is deliberately shape-based, not type-based: a request is
 * answered only when its payload has the layout measured on
 * `opengauss/opengauss:5.0.0` (see `opengauss-auth.ts`), so a server that
 * answers REAL SASL on 10 still passes through to the driver handling it.
 */
import { Duplex } from "node:stream";
import net from "node:net";
import tls from "node:tls";
import { openGaussAuthResponse, passwordMessageFrame } from "./opengauss-auth";

/** The slice of the pg-shaped ssl config this socket needs, as `buildSSLConfig` computes it. */
export interface OpenGaussTlsConfig {
  readonly rejectUnauthorized: boolean;
  readonly ca?: string;
  readonly cert?: string;
  readonly key?: string;
}

export interface OpenGaussSocketOptions {
  readonly password: string;
  /** `undefined` opens a plain connection; otherwise the socket secures it itself. */
  readonly tls?: OpenGaussTlsConfig;
}

/** The 8-byte SSLRequest message, 80877103. */
const SSL_REQUEST = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]);
const SSL_ACCEPTED = 0x53; // "S"
/** A frame is a type byte, a 4-byte length that includes itself, then the payload. */
const FRAME_HEADER_LENGTH = 5;
const RESPONSE_FRAME_TYPE = 0x52; // "R"

export class OpenGaussSocket extends Duplex {
  private readonly password: string;
  private readonly tlsConfig?: OpenGaussTlsConfig;
  private inner?: net.Socket | tls.TLSSocket;
  private buffered: Buffer = Buffer.alloc(0);
  private noDelay = false;
  private backpressured = false;
  private started = false;

  constructor(options: OpenGaussSocketOptions) {
    super();
    this.password = options.password;
    this.tlsConfig = options.tls;
  }

  // ============================================================================
  // The socket surface `pg` calls
  // ----------------------------------------------------------------------------
  // `pg` drives a stream it is handed exactly like the `net.Socket` it would
  // have created itself: `setNoDelay` before `connect(port, host)`, then
  // `setKeepAlive` and `ref`/`unref`. Each of these forwards to the underlying
  // socket; the ones reachable before `connect()` record their argument and are
  // applied when the socket exists.
  // ============================================================================

  public connect(port: number, host: string): void {
    if (this.started) return;
    this.started = true;

    const socket = net.connect({ port, host });
    socket.setNoDelay(this.noDelay);
    socket.on("error", (error: Error) => this.destroy(error));
    socket.once("close", () => {
      if (!this.destroyed) this.destroy();
    });
    socket.once("connect", () => {
      if (this.tlsConfig) {
        this.startTls(socket, host);
      } else {
        this.attach(socket);
      }
    });
    this.inner = socket;
  }

  public setNoDelay(noDelay = true): this {
    this.noDelay = noDelay;
    this.inner?.setNoDelay(noDelay);
    return this;
  }

  public setKeepAlive(enable = false, initialDelay = 0): this {
    this.inner?.setKeepAlive(enable, initialDelay);
    return this;
  }

  public ref(): this {
    this.inner?.ref();
    return this;
  }

  public unref(): this {
    this.inner?.unref();
    return this;
  }

  // ============================================================================
  // TLS, negotiated here so the frame filter stays on the plaintext side
  // ============================================================================

  private startTls(socket: net.Socket, host: string): void {
    socket.once("data", (response: Buffer) => {
      if (response[0] !== SSL_ACCEPTED) {
        // The same message `pg` itself reports for a refused SSLRequest.
        this.destroy(new Error("The server does not support SSL connections"));
        return;
      }
      const secured = tls.connect({
        socket,
        rejectUnauthorized: this.tlsConfig?.rejectUnauthorized ?? true,
        ca: this.tlsConfig?.ca,
        cert: this.tlsConfig?.cert,
        key: this.tlsConfig?.key,
        servername: net.isIP(host) === 0 ? host : undefined,
      });
      secured.on("error", (error: Error) => this.destroy(error));
      secured.once("secureConnect", () => this.attach(secured));
      this.inner = secured;
    });
    socket.write(SSL_REQUEST);
  }

  // ============================================================================
  // Inbound frames: answer the two openGauss handshakes, forward the rest
  // ============================================================================

  private attach(socket: net.Socket | tls.TLSSocket): void {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.once("end", () => this.push(null));
    // `pg` waits for this before it writes the startup message; the TLS side
    // emits it only after the TLS handshake completed, which is what keeps the
    // driver from writing plaintext into a half-open TLS session.
    this.emit("connect");
  }

  private onData(chunk: Buffer): void {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    this.drainFrames();
  }

  private drainFrames(): void {
    let offset = 0;
    while (!this.backpressured && this.buffered.length - offset >= FRAME_HEADER_LENGTH) {
      const length = this.buffered.readInt32BE(offset + 1);
      const total = 1 + length;
      if (this.buffered.length - offset < total) break;
      const frame = this.buffered.subarray(offset, offset + total);
      offset += total;

      const consumed =
        (frame[0] ?? 0) === RESPONSE_FRAME_TYPE && this.answerAuthRequest(frame.subarray(FRAME_HEADER_LENGTH));
      if (consumed) continue;

      if (!this.push(frame)) {
        this.backpressured = true;
        this.inner?.pause();
      }
    }
    this.buffered = offset === 0 ? this.buffered : this.buffered.subarray(offset);
  }

  /**
   * Answers a frame when it is one of openGauss's two authentication requests.
   * The reply goes straight to the wire - the driver never sees the request, so
   * it has nothing to reply with - and `true` tells the caller to swallow the
   * frame.
   */
  private answerAuthRequest(payload: Buffer): boolean {
    const response = openGaussAuthResponse(payload, this.password);
    if (response === null) return false;
    this.inner?.write(passwordMessageFrame(response));
    return true;
  }

  // ============================================================================
  // The Duplex surface
  // ============================================================================

  override _read(): void {
    if (!this.backpressured) return;
    this.backpressured = false;
    this.inner?.resume();
    this.drainFrames();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const target = this.inner;
    if (!target || target.destroyed) {
      callback(new Error("openGauss connection is not open"));
      return;
    }
    target.write(chunk, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    const target = this.inner;
    if (!target || target.destroyed) {
      callback();
      return;
    }
    target.end(callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.inner?.destroy();
    this.buffered = Buffer.alloc(0);
    callback(error);
  }
}
