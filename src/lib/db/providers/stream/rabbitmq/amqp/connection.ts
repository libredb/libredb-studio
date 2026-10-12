/**
 * One AMQP 0-9-1 connection of one read: protocol header, start, tune, open, channel, qos, consume, heartbeats and
 * close, over the narrow socket interface `dial.ts` declares.
 *
 * THE PROVIDER'S ONE SOCKET WRITE IS HERE, in `send`, and every frame passes the allowlist of `codec.ts` on its way
 * out: the frames are built only by `ENCODERS`, and `isAllowedOutbound` re-reads each one before it is written, so a
 * frame outside the allowed set cannot leave whatever a caller asks for.
 *
 * Every socket listener here catches what it calls: a throw inside a node:net listener exits a Node process, where Bun
 * would turn it into a rejection no test running under Bun could see.
 */
import type { AmqpCloseInfo, ProtocolFact } from "../errors";
import {
  RABBITMQ_CLOSE_OK_WAIT_MS,
  RABBITMQ_FRAME_MAX_CEILING,
  RABBITMQ_FRAME_MIN_BYTES,
  RABBITMQ_HEARTBEAT_CEILING_S,
  RABBITMQ_NAME_MAX_BYTES,
  type RabbitMQClock,
} from "../limits";
import type { AmqpEndpoint } from "../connection-options";
import {
  decodeCancel,
  decodeClose,
  decodeConnectionStart,
  decodeTune,
  ENCODERS,
  isAllowedOutbound,
  ProtocolViolation,
  READ_CHANNEL,
  SERVER_METHOD,
  type StreamOffset,
} from "./codec";
import type { AmqpSocket } from "./dial";
import { type FrameEvent, FrameReader } from "./frame-reader";

/** How the connection ended after consume-ok, for the read loop. */
export type PeerClose =
  | { readonly kind: "close"; readonly info: AmqpCloseInfo }
  | { readonly kind: "cancel" }
  // `silent`: the socket ended before the peer sent one byte, which on a TLS socket is the broker refusing it.
  | { readonly kind: "socket-end"; readonly silent?: true }
  | { readonly kind: "socket-error"; readonly silent?: true }
  | { readonly kind: "heartbeat-timeout" }
  | { readonly kind: "violation"; readonly fact: ProtocolFact };

/** Why the connection failed before consume-ok; `read-loop.ts` turns each into its sentence. */
export type HandshakeFailure =
  | PeerClose
  | { readonly kind: "foreign"; readonly protocol: "amqp" | "tls" | "other" }
  | { readonly kind: "other-version" }
  | { readonly kind: "no-plain" }
  | { readonly kind: "frame-max"; readonly bytes: number };

export class AmqpFailure extends Error {
  constructor(readonly failure: HandshakeFailure) {
    super(`The AMQP connection failed (${failure.kind}).`);
    this.name = "AmqpFailure";
  }
}

export interface AmqpConnectionOptions {
  readonly socket: AmqpSocket;
  readonly endpoint: AmqpEndpoint;
  readonly vhost: string;
  readonly clock: RabbitMQClock;
  readonly signal: AbortSignal;
  readonly studioVersion: string | null;
  readonly onSkippedBytes?: (view: Uint8Array) => void;
  /** Every frame event after consume-ok, for the read loop. */
  readonly onDelivery: (event: FrameEvent) => void;
  readonly onPeerClose: (close: PeerClose) => void;
}

export interface AmqpConnection {
  /** Protocol header to open-ok and channel.open-ok, then basic.qos with `prefetch`. */
  open(prefetch: number): Promise<void>;
  /** basic.consume with x-stream-offset; resolves at consume-ok. */
  consume(stream: string, from: StreamOffset): Promise<void>;
  ack(deliveryTag: bigint): void;
  /** Normal end: connection.close, then close-ok, the wait limit, the signal or the socket's end, then destroy. */
  close(): Promise<void>;
  /** Hard drop: connection.close written, socket destroyed without waiting. Safe to call at any time, twice. */
  drop(): void;
}

type State = "start" | "tune" | "open" | "channel" | "qos" | "ready" | "consume" | "reading" | "closing" | "done";

const is = (event: { classId: number; methodId: number }, [classId, methodId]: readonly [number, number]): boolean =>
  event.classId === classId && event.methodId === methodId;

export function createAmqpConnection(options: AmqpConnectionOptions): AmqpConnection {
  const { socket, clock } = options;
  let state: State = "start";
  let pending: { resolve: () => void; reject: (error: AmqpFailure) => void } | null = null;
  let closing: (() => void) | null = null;
  let heartbeatSeconds = 0;
  let lastInbound = clock.now();
  let lastOutbound = clock.now();
  let missedClockFrom: number | null = null;
  let stopHeartbeat: (() => void) | null = null;
  let stopCloseWait: (() => void) | null = null;
  let prefetchCount = 1;
  /** Set once the read loop asked for close() or drop(): the end is its own, never reported back as a peer close. */
  let closingRequested = false;
  /** The failure that ended the connection, for a call made after it. */
  let failedWith: HandshakeFailure | null = null;

  const reader = new FrameReader({
    onEvent: (event) => onEvent(event),
    ...(options.onSkippedBytes ? { onSkippedBytes: options.onSkippedBytes } : {}),
  });

  /** THE ONE WRITE: only allowed frames, never after the socket is gone. */
  function send(frame: Uint8Array): void {
    if (!isAllowedOutbound(frame)) throw new RangeError("An outbound frame is outside the allowed set.");
    if (socket.destroyed) return;
    socket.write(frame);
    lastOutbound = clock.now();
  }

  /** Ends everything: reader, timers, socket; a caller still waiting on open() or consume() gets the failure. */
  function destroy(): void {
    state = "done";
    reader.halt();
    stopHeartbeat?.();
    stopHeartbeat = null;
    stopCloseWait?.();
    stopCloseWait = null;
    socket.destroy();
    const finished = closing;
    closing = null;
    finished?.();
    const waiting = pending;
    pending = null;
    waiting?.reject(new AmqpFailure(failedWith ?? { kind: "socket-end" }));
  }

  /** Ends the connection with `failure`: a rejection before consume-ok, the read loop's peer close after it. */
  function fail(failure: HandshakeFailure): void {
    if (state === "done") return;
    const wasReading = state === "reading" || state === "closing";
    const waited = pending !== null;
    failedWith = failure;
    destroy();
    if (!waited && wasReading && !closingRequested) options.onPeerClose(failure as PeerClose);
  }

  function settle(): void {
    const waiting = pending;
    pending = null;
    waiting?.resolve();
  }

  function heartbeatTick(): void {
    stopHeartbeat = null;
    if (state === "done") return;
    const now = clock.now();
    const interval = heartbeatSeconds * 1000;
    if (missedClockFrom !== null && now - Math.max(lastInbound, missedClockFrom) >= 2 * interval) {
      fail({ kind: "heartbeat-timeout" });
      return;
    }
    if (now - lastOutbound >= interval / 2) send(ENCODERS.heartbeat());
    stopHeartbeat = clock.setTimer(heartbeatTick, interval / 2);
  }

  function onMethod(event: Extract<FrameEvent, { type: "method" }>): void {
    const control = event.classId === 10;
    if (event.channel !== (control ? 0 : READ_CHANNEL)) throw new ProtocolViolation("unexpected-frame", 505);
    if (is(event, SERVER_METHOD.connectionClose) || is(event, SERVER_METHOD.channelClose)) {
      const close = decodeClose(event.args);
      const scope = control ? "connection" : "channel";
      send(control ? ENCODERS["connection.close-ok"]() : ENCODERS["channel.close-ok"]());
      if (state === "closing") {
        destroy();
        return;
      }
      if (!control) send(ENCODERS["connection.close"](200));
      fail({ kind: "close", info: { ...close, scope } });
      return;
    }
    if (is(event, SERVER_METHOD.connectionBlocked) || is(event, SERVER_METHOD.connectionUnblocked)) return;
    if (state === "closing") {
      if (is(event, SERVER_METHOD.connectionCloseOk)) destroy();
      return;
    }
    if (state === "start" && is(event, SERVER_METHOD.connectionStart)) {
      const start = decodeConnectionStart(event.args);
      if (start.versionMajor !== 0 || start.versionMinor !== 9) return fail({ kind: "other-version" });
      if (!start.mechanisms.includes("PLAIN")) return fail({ kind: "no-plain" });
      // start-ok carries the locale as a short string, so an offered one longer than 255 bytes falls back to en_US.
      const offered = start.locales[0];
      const locale =
        start.locales.includes("en_US") ||
        offered === undefined ||
        new TextEncoder().encode(offered).length > RABBITMQ_NAME_MAX_BYTES
          ? "en_US"
          : offered;
      const { username, password } = options.endpoint;
      send(ENCODERS["connection.start-ok"]({ username, password, locale, studioVersion: options.studioVersion }));
      state = "tune";
      return;
    }
    if (state === "tune" && is(event, SERVER_METHOD.connectionTune)) {
      const tune = decodeTune(event.args);
      if (tune.frameMax !== 0 && tune.frameMax < RABBITMQ_FRAME_MIN_BYTES) {
        return fail({ kind: "frame-max", bytes: tune.frameMax });
      }
      const frameMax =
        tune.frameMax === 0 ? RABBITMQ_FRAME_MAX_CEILING : Math.min(tune.frameMax, RABBITMQ_FRAME_MAX_CEILING);
      heartbeatSeconds = Math.min(tune.heartbeat, RABBITMQ_HEARTBEAT_CEILING_S);
      send(ENCODERS["connection.tune-ok"](frameMax, heartbeatSeconds));
      reader.setFrameMax(frameMax);
      if (heartbeatSeconds > 0) stopHeartbeat = clock.setTimer(heartbeatTick, (heartbeatSeconds * 1000) / 2);
      send(ENCODERS["connection.open"](options.vhost));
      state = "open";
      return;
    }
    if (state === "open" && is(event, SERVER_METHOD.connectionOpenOk)) {
      missedClockFrom = clock.now();
      send(ENCODERS["channel.open"]());
      state = "channel";
      return;
    }
    if (state === "channel" && is(event, SERVER_METHOD.channelOpenOk)) {
      send(ENCODERS["basic.qos"](prefetchCount));
      state = "qos";
      return;
    }
    if (state === "qos" && is(event, SERVER_METHOD.basicQosOk)) {
      state = "ready";
      settle();
      return;
    }
    if (state === "consume" && is(event, SERVER_METHOD.basicConsumeOk)) {
      state = "reading";
      settle();
      // The chunk's bytes after consume-ok were announced before it, so the wire cap is told of them here.
      const rest = reader.unreadInChunk();
      if (rest > 0) options.onDelivery({ type: "inbound", bytes: rest });
      return;
    }
    if (state === "reading" && is(event, SERVER_METHOD.basicDeliver)) {
      options.onDelivery(event);
      return;
    }
    if (state === "reading" && is(event, SERVER_METHOD.basicCancel)) {
      const cancel = decodeCancel(event.args);
      if (!cancel.noWait) send(ENCODERS["basic.cancel-ok"](cancel.consumerTag));
      options.onPeerClose({ kind: "cancel" });
      return;
    }
    throw new ProtocolViolation("unexpected-frame", 505);
  }

  function onEvent(event: FrameEvent): void {
    switch (event.type) {
      case "method":
        onMethod(event);
        return;
      case "foreign":
        fail({ kind: "foreign", protocol: event.kind });
        return;
      case "violation":
        if (event.replyCode !== null) send(ENCODERS["connection.close"](event.replyCode));
        fail({ kind: "violation", fact: event.fact });
        return;
      default:
        // The wire cap counts what arrives while the close waits too: deliveries keep coming until close-ok.
        if (state === "reading" || (state === "closing" && event.type === "inbound")) options.onDelivery(event);
    }
  }

  /** Whether the peer sent any byte: a TLS 1.3 broker refusing Studio's certificate ends the socket before one. */
  let heard = false;
  const silent = (): { readonly silent?: true } => (heard ? {} : { silent: true });
  socket.on("data", (chunk) => {
    heard = true;
    lastInbound = clock.now();
    try {
      reader.feed(chunk);
    } catch {
      // A listener failure is a broken read, never an uncaught exception: the socket goes, the read ends.
      fail({ kind: "socket-error" });
    }
  });
  socket.on("end", () => fail({ kind: "socket-end", ...silent() }));
  socket.on("close", () => fail({ kind: "socket-end", ...silent() }));
  socket.on("error", () => fail({ kind: "socket-error", ...silent() }));

  const waitFor = (next: () => void): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (state === "done") {
        reject(new AmqpFailure(failedWith ?? { kind: "socket-end" }));
        return;
      }
      pending = { resolve, reject };
      try {
        next();
      } catch (error) {
        pending = null;
        destroy();
        reject(error);
      }
    });

  return {
    open(prefetch) {
      prefetchCount = prefetch;
      return waitFor(() => send(ENCODERS["protocol-header"]()));
    },
    consume(stream, from) {
      return waitFor(() => {
        const frame = ENCODERS["basic.consume"](stream, from);
        state = "consume";
        send(frame);
      });
    },
    ack(deliveryTag) {
      if (state === "reading") send(ENCODERS["basic.ack"](deliveryTag));
    },
    close() {
      return new Promise<void>((resolve) => {
        if (state === "done") {
          resolve();
          return;
        }
        closingRequested = true;
        state = "closing";
        closing = resolve;
        send(ENCODERS["connection.close"](200));
        const onAbort = (): void => destroy();
        options.signal.addEventListener("abort", onAbort, { once: true });
        const stopTimer = clock.setTimer(destroy, RABBITMQ_CLOSE_OK_WAIT_MS);
        stopCloseWait = () => {
          stopTimer();
          options.signal.removeEventListener("abort", onAbort);
        };
        if (options.signal.aborted) destroy();
      });
    },
    drop() {
      if (state === "done") return;
      closingRequested = true;
      try {
        send(ENCODERS["connection.close"](200));
      } finally {
        destroy();
      }
    },
  };
}
