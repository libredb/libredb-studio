/**
 * Frame boundaries for the bytes a broker sends, checked before anything is buffered.
 *
 * A method or body frame larger than the negotiated frame size is refused from its 7-byte header, before a byte of it
 * is kept; a content-header frame is limited by RABBITMQ_HEADER_FRAME_MAX_BYTES instead, because RabbitMQ sends header
 * frames above the frame size, and is walked as it arrives (`field-table.ts`). A body keeps at most
 * RABBITMQ_BODY_PREFIX_BYTES; the rest is stepped over in place, and an optional observer sees each stepped-over span
 * as a view of the socket chunk, never a copy.
 *
 * Feeding is synchronous and handles one socket chunk per call, so the walk always returns to the event loop between
 * chunks and a deadline timer can fire there.
 */
import type { ProtocolFact } from "../errors";
import {
  RABBITMQ_BODY_CEILING_BYTES,
  RABBITMQ_BODY_PREFIX_BYTES,
  RABBITMQ_FRAME_MIN_BYTES,
  RABBITMQ_HEADER_FRAME_MAX_BYTES,
} from "../limits";
import {
  FRAME_BODY,
  FRAME_END,
  FRAME_HEADER,
  FRAME_HEARTBEAT,
  FRAME_METHOD,
  FRAME_OVERHEAD,
  ProtocolViolation,
  READ_CHANNEL,
  SERVER_METHOD,
} from "./codec";
import { type BasicProperties, type ContentHeader, type Need, walkContentHeader } from "./field-table";

export type FrameEvent =
  | {
      readonly type: "method";
      readonly channel: number;
      readonly classId: number;
      readonly methodId: number;
      readonly args: Uint8Array;
    }
  | { readonly type: "header-begin"; readonly channel: number; readonly frameSize: number }
  | { readonly type: "body-size"; readonly channel: number; readonly bodySize: number }
  | { readonly type: "stream-offset"; readonly offset: bigint }
  | {
      readonly type: "header";
      readonly channel: number;
      readonly properties: BasicProperties;
      readonly retainedBytes: number;
    }
  /** At the end of each body frame; `kept` is the message's kept prefix so far, whole when `complete`. */
  | {
      readonly type: "body";
      readonly channel: number;
      readonly kept: Uint8Array;
      readonly frameBytes: number;
      readonly complete: boolean;
    }
  | { readonly type: "heartbeat" }
  /** Before a chunk is read, with its size: the wire count. */
  | { readonly type: "inbound"; readonly bytes: number }
  /** After a chunk is read: whether every byte of it belonged to heartbeat frames. */
  | { readonly type: "progress"; readonly heartbeatOnly: boolean }
  /** The first bytes are not an AMQP 0-9-1 frame: another AMQP version's header, a TLS alert, or anything else. */
  | { readonly type: "foreign"; readonly kind: "amqp" | "tls" | "other" }
  /** `replyCode` null: close silently. */
  | { readonly type: "violation"; readonly fact: ProtocolFact; readonly replyCode: 501 | 505 | null };

export interface FrameReaderOptions {
  readonly onEvent: (event: FrameEvent) => void;
  readonly onSkippedBytes?: (view: Uint8Array) => void;
}

/** One step the reader's own walk asks for, beyond the header walk's `take` and `skip`. */
type Step = Need | { readonly frameHeader: true } | { readonly body: number };

const EMPTY = new Uint8Array(0);
const FRAME_TYPES = new Set([FRAME_METHOD, FRAME_HEADER, FRAME_BODY, FRAME_HEARTBEAT]);
const [DELIVER_CLASS, DELIVER_METHOD] = SERVER_METHOD.basicDeliver;

export class FrameReader {
  private frameMax = RABBITMQ_FRAME_MIN_BYTES;
  private halted = false;
  private readonly walk: Generator<Step, void, Uint8Array>;
  private step: Step;
  /** Bytes of the current take gathered so far, and how many. */
  private gathered: Uint8Array | null = null;
  private filled = 0;
  /** Bytes of the current skip or body step consumed so far. */
  private passed = 0;
  /** Type of the frame being read, set from the first byte of its header. */
  private frameType = -1;
  private nonHeartbeat = false;
  /** The message whose body is being read: its declared size, its prefix and how much of it is filled. */
  private body: { size: number; received: number; prefix: Uint8Array; kept: number } | null = null;
  /** The chunk being fed: its length, and the end of the last step served from it. */
  private chunkLength = 0;
  private position = 0;

  constructor(private readonly options: FrameReaderOptions) {
    this.walk = this.frames();
    this.step = this.walk.next().value as Step;
  }

  /** Before tune the limit is RABBITMQ_FRAME_MIN_BYTES. */
  setFrameMax(bytes: number): void {
    this.frameMax = bytes;
  }

  /** Bytes of the chunk being fed after the step that raised the current event: read by the connection at consume-ok. */
  unreadInChunk(): number {
    return this.chunkLength - this.position;
  }

  /** Stops reading: nothing more is emitted, whatever is fed. */
  halt(): void {
    this.halted = true;
  }

  feed(chunk: Uint8Array): void {
    if (this.halted) return;
    this.options.onEvent({ type: "inbound", bytes: chunk.length });
    this.nonHeartbeat = false;
    this.chunkLength = chunk.length;
    this.position = 0;
    let at = 0;
    while (!this.halted && (at < chunk.length || this.stepLength() === 0)) {
      at = this.serve(chunk, at);
    }
    if (!this.halted) this.options.onEvent({ type: "progress", heartbeatOnly: !this.nonHeartbeat });
  }

  private stepLength(): number {
    const step = this.step;
    if ("frameHeader" in step) return 7;
    if ("body" in step) return step.body;
    return "take" in step ? step.take : step.skip;
  }

  /** Serves the current step from `chunk` at `at`; resumes the walk once it is satisfied. Answers the new position. */
  private serve(chunk: Uint8Array, at: number): number {
    const step = this.step;
    const want = this.stepLength();
    if ("frameHeader" in step || "take" in step) {
      if (this.gathered === null) this.gathered = new Uint8Array(want);
      const count = Math.min(want - this.filled, chunk.length - at);
      if (count > 0 && this.filled === 0 && "frameHeader" in step) this.frameType = chunk[at] as number;
      this.mark(count);
      this.gathered.set(chunk.subarray(at, at + count), this.filled);
      this.filled += count;
      if (this.filled < want) return at + count;
      const bytes = this.gathered;
      this.gathered = null;
      this.filled = 0;
      this.position = at + count;
      this.resume(bytes);
      return at + count;
    }
    const count = Math.min(want - this.passed, chunk.length - at);
    this.mark(count);
    if ("body" in step) this.bodyBytes(chunk.subarray(at, at + count));
    this.passed += count;
    if (this.passed < want) return at + count;
    this.passed = 0;
    this.position = at + count;
    this.resume(EMPTY);
    return at + count;
  }

  private mark(count: number): void {
    if (count > 0 && this.frameType !== FRAME_HEARTBEAT) this.nonHeartbeat = true;
  }

  private bodyBytes(span: Uint8Array): void {
    const body = this.body as NonNullable<FrameReader["body"]>;
    const room = Math.min(body.prefix.length - body.kept, span.length);
    if (room > 0) {
      body.prefix.set(span.subarray(0, room), body.kept);
      body.kept += room;
    }
    if (room < span.length) this.options.onSkippedBytes?.(span.subarray(room));
  }

  private resume(bytes: Uint8Array): void {
    try {
      const next = this.walk.next(bytes);
      if (!next.done) this.step = next.value;
    } catch (error) {
      if (!(error instanceof ProtocolViolation)) throw error;
      this.halted = true;
      this.options.onEvent({ type: "violation", fact: error.fact, replyCode: error.replyCode });
    }
  }

  private emit(event: FrameEvent): void {
    if (!this.halted) this.options.onEvent(event);
  }

  /** The whole frame sequence as one walk; it never returns, and a violation ends it by throwing. */
  private *frames(): Generator<Step, void, Uint8Array> {
    let first = true;
    /** What the next frame on the read channel must be: any method, a content header, or body. */
    let expect: "method" | "header" | "body" = "method";
    for (;;) {
      const head = yield { frameHeader: true };
      const view = new DataView(head.buffer, head.byteOffset, 7);
      const type = view.getUint8(0);
      const channel = view.getUint16(1);
      const size = view.getUint32(3);
      if (first && type !== FRAME_METHOD) {
        const amqp = head[0] === 0x41 && head[1] === 0x4d && head[2] === 0x51 && head[3] === 0x50;
        const tls = head[0] === 0x15 && head[1] === 0x03;
        this.halted = true;
        this.options.onEvent({ type: "foreign", kind: amqp ? "amqp" : tls ? "tls" : "other" });
        return;
      }
      first = false;
      if (!FRAME_TYPES.has(type)) throw new ProtocolViolation("unknown-frame-type", null);
      if (channel !== 0 && channel !== READ_CHANNEL) throw new ProtocolViolation("unexpected-frame", 505);
      if (type === FRAME_HEARTBEAT) {
        if (channel !== 0 || size !== 0) throw new ProtocolViolation("malformed-frame", 501);
        yield* this.frameEnd();
        this.emit({ type: "heartbeat" });
        continue;
      }
      if (type === FRAME_HEADER) {
        if (size > RABBITMQ_HEADER_FRAME_MAX_BYTES) throw new ProtocolViolation("header-too-large", 501);
        if (expect !== "header" || channel !== READ_CHANNEL) throw new ProtocolViolation("unexpected-frame", 505);
        this.emit({ type: "header-begin", channel, frameSize: size });
        const header: ContentHeader = yield* walkContentHeader(size, {
          bodySize: (declared) => {
            if (declared > BigInt(RABBITMQ_BODY_CEILING_BYTES)) throw new ProtocolViolation("body-ceiling", 501);
            this.emit({ type: "body-size", channel, bodySize: Number(declared) });
          },
          streamOffset: (offset) => this.emit({ type: "stream-offset", offset }),
        });
        yield* this.frameEnd();
        this.emit({ type: "header", channel, properties: header.properties, retainedBytes: header.retainedBytes });
        const bodySize = Number(header.bodySize);
        this.body = {
          size: bodySize,
          received: 0,
          prefix: new Uint8Array(Math.min(bodySize, RABBITMQ_BODY_PREFIX_BYTES)),
          kept: 0,
        };
        if (bodySize === 0) {
          this.body = null;
          expect = "method";
          this.emit({ type: "body", channel, kept: EMPTY, frameBytes: 0, complete: true });
        } else {
          expect = "body";
        }
        continue;
      }
      if (size + FRAME_OVERHEAD > this.frameMax) throw new ProtocolViolation("frame-too-large", 501);
      if (type === FRAME_BODY) {
        const body = this.body;
        if (expect !== "body" || body === null || channel !== READ_CHANNEL) {
          throw new ProtocolViolation("unexpected-frame", 505);
        }
        if (size > body.size - body.received) throw new ProtocolViolation("malformed-frame", 501);
        if (size > 0) yield { body: size };
        yield* this.frameEnd();
        body.received += size;
        const complete = body.received === body.size;
        if (complete) {
          this.body = null;
          expect = "method";
        }
        this.emit({ type: "body", channel, kept: body.prefix.subarray(0, body.kept), frameBytes: size, complete });
        continue;
      }
      // Content frames are sequential per channel only: a channel-0 method may come between a delivery's frames.
      if (channel === READ_CHANNEL && expect !== "method") throw new ProtocolViolation("unexpected-frame", 505);
      if (size < 4) throw new ProtocolViolation("malformed-frame", 501);
      const payload = yield { take: size };
      yield* this.frameEnd();
      const ids = new DataView(payload.buffer, payload.byteOffset, 4);
      const classId = ids.getUint16(0);
      const methodId = ids.getUint16(2);
      if (classId === DELIVER_CLASS && methodId === DELIVER_METHOD) expect = "header";
      this.emit({ type: "method", channel, classId, methodId, args: payload.subarray(4) });
    }
  }

  private *frameEnd(): Generator<Step, void, Uint8Array> {
    const end = yield { take: 1 };
    if (end[0] !== FRAME_END) throw new ProtocolViolation("frame-end", null);
  }
}
