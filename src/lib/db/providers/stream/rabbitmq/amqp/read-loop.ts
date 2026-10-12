/**
 * One stream read over AMQP 0-9-1: dial, handshake, consume, deliveries until the first stop, cleanup.
 *
 * Before consume-ok every failure is an error from `errors.ts` and nothing is returned. After it, every stop returns
 * the rows read so far with its reason; only a protocol violation is still an error, because the bytes after it cannot
 * be trusted. The stops, first reached: the row limit, the result budget, the wire cap, the deadline or a cancel (the
 * run signal), the broker's basic.cancel, its close or the socket's end, and RABBITMQ_IDLE_MS without a byte that is not
 * a heartbeat. A message in progress at a stop is not a row.
 *
 * A row limit, idle or a server cancel ends with connection.close and a short wait for close-ok; the budget, the wire
 * cap, the deadline and a cancel drop the socket without waiting, because close-ok would come only after the body the
 * read refuses to take. Every exit destroys the socket and clears every timer. There is no retry and no reconnect.
 */
import { QueryCancelledError } from "@/lib/db/errors";
import type { AmqpEndpoint } from "../connection-options";
import {
  amqpCloseError,
  amqpExpectsTls,
  amqpNoPlain,
  amqpNoSession,
  amqpNotTls,
  amqpOtherProtocol,
  amqpProtocolError,
  amqpUnreachable,
  cancelledError,
  conversionAtConsume,
  frameMaxTooSmall,
  heartbeatsMissed,
  isOwnError,
  READ_CANCELLED_BEFORE_START,
  type ReadFailureContext,
  readPhaseTimeout,
  tlsCertificateUntrusted,
  tlsClientCertificateRefused,
} from "../errors";
import {
  RABBITMQ_BODY_PREFIX_BYTES,
  RABBITMQ_IDLE_MS,
  RABBITMQ_PREFETCH_MAX,
  RABBITMQ_READ_WIRE_BYTES,
  RABBITMQ_RESULT_BUDGET_BYTES,
  type RabbitMQClock,
} from "../limits";
import { decodeDeliver, ProtocolViolation, type StreamOffset } from "./codec";
import {
  type AmqpConnection,
  AmqpFailure,
  createAmqpConnection,
  type HandshakeFailure,
  type PeerClose,
} from "./connection";
import { type AmqpDial, type AmqpSocket, DialAborted, DialFailed } from "./dial";
import type { BasicProperties } from "./field-table";
import type { FrameEvent } from "./frame-reader";

export interface StreamReadInput {
  readonly endpoint: AmqpEndpoint;
  readonly vhost: string;
  readonly stream: string;
  readonly from: StreamOffset;
  /** 1 to RABBITMQ_READ_MAX_ROWS, validated by request.ts. */
  readonly limit: number;
  /** The run signal: a QueryCancelledError reason is a cancel, any other a deadline. */
  readonly signal: AbortSignal;
  /** The deadline in seconds, for the sentences. */
  readonly deadlineSeconds: number;
  /** From the type check, for the no-replica sentences. */
  readonly replicas: { readonly online: readonly string[]; readonly members: readonly string[] };
  readonly dial: AmqpDial;
  readonly clock: RabbitMQClock;
  readonly studioVersion: string | null;
  readonly onSkippedBytes?: (view: Uint8Array) => void;
}

export interface RawMessage {
  readonly offset: bigint;
  readonly exchange: Uint8Array;
  readonly routingKey: Uint8Array;
  readonly properties: BasicProperties;
  /** The kept prefix, at most RABBITMQ_BODY_PREFIX_BYTES. */
  readonly body: Uint8Array;
  /** The declared size, at most RABBITMQ_BODY_CEILING_BYTES. */
  readonly bodySize: number;
  readonly retainedHeaderBytes: number;
}

export type StopReason =
  | { readonly kind: "limit" }
  | { readonly kind: "idle" }
  | { readonly kind: "budget" }
  | { readonly kind: "wire" }
  /** The message in progress is by itself larger than the wire cap; `offset` null when not decoded yet. */
  | { readonly kind: "wire-oversize"; readonly offset: bigint | null }
  | { readonly kind: "deadline" }
  | { readonly kind: "cancel" }
  | { readonly kind: "server-cancel" }
  | { readonly kind: "closed" }
  /** 541 after consume-ok. */
  | { readonly kind: "conversion" };

export interface StreamReadOutcome {
  readonly messages: readonly RawMessage[];
  readonly stop: StopReason;
  readonly prefetch: number;
}

/** The message whose frames are arriving. */
interface InProgress {
  readonly deliveryTag: bigint;
  readonly exchange: Uint8Array;
  readonly routingKey: Uint8Array;
  headerFrameSize: number;
  bodySize: number;
  offset: bigint | null;
  properties: BasicProperties | null;
  retainedHeaderBytes: number;
}

const HARD_STOPS = new Set<StopReason["kind"]>(["budget", "wire", "wire-oversize", "deadline", "cancel"]);

function cancelled(signal: AbortSignal): boolean {
  return signal.reason instanceof QueryCancelledError;
}

/**
 * Resolves with the outcome once consume-ok was reached; before it, rejects with an own error from errors.ts. Every
 * exit destroys the socket and clears every timer.
 */
export async function readStream(input: StreamReadInput): Promise<StreamReadOutcome> {
  const { signal, endpoint } = input;
  const context: ReadFailureContext = {
    endpoint: endpoint.display,
    vhost: input.vhost,
    stream: input.stream,
    online: input.replicas.online,
    members: input.replicas.members,
  };
  /**
   * Before consume-ok: a deadline names the phase; a cancel is "cancelled before it started", unless the reason is an
   * own error (the provider's own closing), which passes through as it is.
   */
  const phaseError = (phase: "connecting" | "tls" | "handshake"): Error => {
    if (!cancelled(signal)) {
      return readPhaseTimeout(phase, {
        seconds: input.deadlineSeconds,
        endpoint: endpoint.display,
        stream: input.stream,
      });
    }
    return isOwnError(signal.reason) ? (signal.reason as Error) : cancelledError(READ_CANCELLED_BEFORE_START);
  };

  if (signal.aborted) throw phaseError("connecting");
  let socket: AmqpSocket;
  try {
    socket = await input.dial(endpoint, signal);
  } catch (error) {
    if (error instanceof DialAborted) throw phaseError(error.phase);
    if (error instanceof DialFailed) throw dialError(error, endpoint.display);
    throw error;
  }

  const prefetch = Math.min(input.limit, RABBITMQ_PREFETCH_MAX);
  const messages: RawMessage[] = [];
  let current: InProgress | null = null;
  let budget = 0;
  let wire = 0;
  let consuming = false;
  let stopped: StopReason | null = null;
  let stopIdle: (() => void) | null = null;
  let finish: (outcome: StreamReadOutcome) => void = () => {};
  let abandon: (error: Error) => void = () => {};
  const ended = new Promise<StreamReadOutcome>((resolve, reject) => {
    finish = resolve;
    abandon = reject;
  });

  const clearIdle = (): void => {
    stopIdle?.();
    stopIdle = null;
  };
  const armIdle = (): void => {
    clearIdle();
    stopIdle = input.clock.setTimer(() => stop({ kind: "idle" }), RABBITMQ_IDLE_MS);
  };

  function stop(reason: StopReason): void {
    if (stopped !== null) return;
    stopped = reason;
    clearIdle();
    const outcome = { messages, stop: reason, prefetch };
    if (HARD_STOPS.has(reason.kind) || reason.kind === "closed" || reason.kind === "conversion") {
      connection.drop();
      finish(outcome);
      return;
    }
    void connection.close().then(() => finish(outcome));
  }

  /** The wire cap: the oversize form when the message in progress is by itself larger than the cap, or when no row was read. */
  function wireStop(): void {
    const oversize =
      current !== null &&
      (current.headerFrameSize > RABBITMQ_READ_WIRE_BYTES || current.bodySize > RABBITMQ_READ_WIRE_BYTES);
    if (oversize || messages.length === 0) stop({ kind: "wire-oversize", offset: current?.offset ?? null });
    else stop({ kind: "wire" });
  }

  function onDelivery(event: FrameEvent): void {
    if (event.type === "inbound") {
      wire += event.bytes;
      // After a graceful stop the close still reads until close-ok; the cap bounds those bytes as well.
      if (wire > RABBITMQ_READ_WIRE_BYTES) {
        if (stopped === null) wireStop();
        else connection.drop();
      }
      return;
    }
    if (stopped !== null) return;
    switch (event.type) {
      case "progress":
        if (!event.heartbeatOnly) armIdle();
        return;
      case "method": {
        const deliver = decodeDeliver(event.args);
        current = {
          deliveryTag: deliver.deliveryTag,
          exchange: deliver.exchange,
          routingKey: deliver.routingKey,
          headerFrameSize: 0,
          bodySize: 0,
          offset: null,
          properties: null,
          retainedHeaderBytes: 0,
        };
        return;
      }
      case "header-begin":
        (current as InProgress).headerFrameSize = event.frameSize;
        return;
      case "body-size":
        (current as InProgress).bodySize = event.bodySize;
        return;
      case "stream-offset":
        (current as InProgress).offset ??= event.offset;
        return;
      case "header": {
        const message = current as InProgress;
        if (message.offset === null) throw new ProtocolViolation("missing-offset", 505);
        const cost = event.retainedBytes + Math.min(message.bodySize, RABBITMQ_BODY_PREFIX_BYTES);
        if (budget + cost > RABBITMQ_RESULT_BUDGET_BYTES) {
          stop({ kind: "budget" });
          return;
        }
        budget += cost;
        message.properties = event.properties;
        message.retainedHeaderBytes = event.retainedBytes;
        return;
      }
      case "body": {
        if (!event.complete) return;
        const message = current as InProgress;
        current = null;
        messages.push({
          offset: message.offset as bigint,
          exchange: message.exchange,
          routingKey: message.routingKey,
          properties: message.properties as BasicProperties,
          body: event.kept,
          bodySize: message.bodySize,
          retainedHeaderBytes: message.retainedHeaderBytes,
        });
        connection.ack(message.deliveryTag);
        if (messages.length >= input.limit) stop({ kind: "limit" });
        return;
      }
      default:
        return;
    }
  }

  function onPeerClose(close: PeerClose): void {
    if (stopped !== null) return;
    if (close.kind === "violation") {
      stopped = { kind: "closed" };
      clearIdle();
      abandon(amqpProtocolError(endpoint.display, close.fact));
      return;
    }
    if (close.kind === "cancel") stop({ kind: "server-cancel" });
    else if (close.kind === "close" && close.info.replyCode === 541) {
      stop({ kind: "conversion" });
    } else stop({ kind: "closed" });
  }

  const connection: AmqpConnection = createAmqpConnection({
    socket,
    endpoint,
    vhost: input.vhost,
    clock: input.clock,
    signal,
    studioVersion: input.studioVersion,
    ...(input.onSkippedBytes ? { onSkippedBytes: input.onSkippedBytes } : {}),
    onDelivery,
    onPeerClose,
  });

  /** Read through a function: the checks below run after awaits, where the signal may have aborted meanwhile. */
  const aborted = (): boolean => signal.aborted;
  const onAbort = (): void => {
    if (consuming) stop({ kind: cancelled(signal) ? "cancel" : "deadline" });
    else connection.drop();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    try {
      if (aborted()) throw phaseError("handshake");
      await connection.open(prefetch);
      if (aborted()) throw phaseError("handshake");
      await connection.consume(input.stream, input.from);
    } catch (error) {
      connection.drop();
      if (aborted()) throw phaseError("handshake");
      if (error instanceof AmqpFailure) throw handshakeError(error.failure, input, context);
      throw error;
    }
    consuming = true;
    if (stopped === null) armIdle();
    if (aborted()) onAbort();
    return await ended;
  } finally {
    signal.removeEventListener("abort", onAbort);
    clearIdle();
    connection.drop();
  }
}

/** A failed dial's sentence: TLS failures by kind, anything else nothing listening. */
function dialError(error: DialFailed, endpoint: string): Error {
  switch (error.kind) {
    case "tls":
      return amqpNotTls(endpoint);
    case "certificate":
      return tlsCertificateUntrusted(endpoint);
    case "client-certificate":
      return tlsClientCertificateRefused(endpoint);
    default:
      return amqpUnreachable(endpoint);
  }
}

function handshakeError(failure: HandshakeFailure, input: StreamReadInput, context: ReadFailureContext): Error {
  const endpoint = input.endpoint.display;
  switch (failure.kind) {
    case "close":
      if (failure.info.replyCode === 541) return conversionAtConsume(input.stream);
      return amqpCloseError(failure.info, context);
    case "violation":
      return amqpProtocolError(endpoint, failure.fact);
    case "foreign":
      if (failure.protocol === "amqp") return amqpOtherProtocol(endpoint);
      return failure.protocol === "tls" ? amqpExpectsTls(endpoint) : amqpNoSession(endpoint);
    case "other-version":
      return amqpOtherProtocol(endpoint);
    case "no-plain":
      return amqpNoPlain(endpoint);
    case "frame-max":
      return frameMaxTooSmall(failure.bytes);
    case "heartbeat-timeout":
      return heartbeatsMissed(endpoint);
    default:
      // A TLS socket that ends before the broker sent a byte: a TLS 1.3 broker refusing Studio's client certificate
      // after the handshake (Bun ends it, Node raises an alert or a reset first, measured).
      if (input.endpoint.tls !== null && "silent" in failure && failure.silent === true) {
        return tlsClientCertificateRefused(endpoint);
      }
      return amqpNoSession(endpoint);
  }
}
