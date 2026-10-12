/**
 * The AMQP 0-9-1 frames this reader may send, and the decoders of the server methods it reads.
 *
 * NO MESSAGE IS EVER TAKEN FROM A QUEUE (R-S1). `ENCODERS` holds one encoder per frame of the allowed set and nothing
 * else: there is no encoder for basic.get, basic.reject, basic.nack, basic.recover, recover-async, basic.publish, a
 * client basic.cancel, or any queue, exchange, tx or confirm method, so no code path can build one.
 * `isAllowedOutbound` re-reads every frame at the one write site in `connection.ts` against the same allowlist.
 *
 * Strings are encoded with TextEncoder only; nothing here writes into a buffer through a stream-like write method, so
 * the one socket write of the provider stays the only one.
 */
import type { ProtocolFact } from "../errors";

export const FRAME_METHOD = 1;
export const FRAME_HEADER = 2;
export const FRAME_BODY = 3;
export const FRAME_HEARTBEAT = 8;
export const FRAME_END = 0xce;
/** The bytes of a frame that are not payload: type, channel, size and the end marker. */
export const FRAME_OVERHEAD = 8;
/** "AMQP" 0 0 9 1. */
export const PROTOCOL_HEADER: Uint8Array = Uint8Array.of(0x41, 0x4d, 0x51, 0x50, 0, 0, 9, 1);
/** The one channel this reader opens; channel-max is sent as 1. */
export const READ_CHANNEL = 1;
const INT64_MAX = BigInt(2) ** BigInt(63) - BigInt(1);
const UINT64_MAX = BigInt(2) ** BigInt(64) - BigInt(1);
const AGE = /^[1-9][0-9]*[YMDhms]$/;
const PRODUCT = "LibreDB Studio";

/** A broken frame from the peer: the fact names it, and the reply code is what connection.close carries (null: none). */
export class ProtocolViolation extends Error {
  constructor(
    readonly fact: ProtocolFact,
    readonly replyCode: 501 | 505 | null,
  ) {
    super(fact);
    this.name = "ProtocolViolation";
  }
}

export type StreamOffset =
  | { readonly kind: "keyword"; readonly value: "first" | "last" | "next" }
  | { readonly kind: "offset"; readonly value: bigint }
  | { readonly kind: "timestamp"; readonly seconds: bigint }
  | { readonly kind: "age"; readonly value: string };

export type OutboundFrameName =
  | "protocol-header"
  | "connection.start-ok"
  | "connection.tune-ok"
  | "connection.open"
  | "connection.close"
  | "connection.close-ok"
  | "channel.open"
  | "channel.close-ok"
  | "basic.qos"
  | "basic.consume"
  | "basic.ack"
  | "basic.cancel-ok"
  | "heartbeat";

/** Class and method id of each allowed method frame. */
export const ALLOWED_METHODS: Readonly<
  Record<Exclude<OutboundFrameName, "protocol-header" | "heartbeat">, readonly [number, number]>
> = {
  "connection.start-ok": [10, 11],
  "connection.tune-ok": [10, 31],
  "connection.open": [10, 40],
  "connection.close": [10, 50],
  "connection.close-ok": [10, 51],
  "channel.open": [20, 10],
  "channel.close-ok": [20, 41],
  "basic.qos": [60, 10],
  "basic.consume": [60, 20],
  "basic.ack": [60, 80],
  "basic.cancel-ok": [60, 31],
};

const text = new TextEncoder();

/** A growing byte buffer with the big-endian writers AMQP needs. */
class FrameBuilder {
  private bytes = new Uint8Array(64);
  private view = new DataView(this.bytes.buffer);
  length = 0;

  private room(count: number): number {
    const at = this.length;
    if (at + count > this.bytes.length) {
      const grown = new Uint8Array(Math.max(this.bytes.length * 2, at + count));
      grown.set(this.bytes.subarray(0, at));
      this.bytes = grown;
      this.view = new DataView(grown.buffer);
    }
    this.length = at + count;
    return at;
  }
  u8(value: number): this {
    const at = this.room(1);
    this.view.setUint8(at, value);
    return this;
  }
  u16(value: number): this {
    const at = this.room(2);
    this.view.setUint16(at, value);
    return this;
  }
  u32(value: number): this {
    const at = this.room(4);
    this.view.setUint32(at, value);
    return this;
  }
  u64(value: bigint): this {
    if (value < BigInt(0) || value > UINT64_MAX) throw new RangeError("An unsigned 64-bit value is out of range.");
    const at = this.room(8);
    this.view.setBigUint64(at, value);
    return this;
  }
  i64(value: bigint): this {
    if (value < -INT64_MAX - BigInt(1) || value > INT64_MAX)
      throw new RangeError("A signed 64-bit value is out of range.");
    const at = this.room(8);
    this.view.setBigInt64(at, value);
    return this;
  }
  raw(value: Uint8Array): this {
    const at = this.room(value.length);
    this.bytes.set(value, at);
    return this;
  }
  shortstr(value: string | Uint8Array): this {
    const bytes = typeof value === "string" ? text.encode(value) : value;
    if (bytes.length > 255) throw new RangeError("A short string is longer than 255 bytes.");
    return this.u8(bytes.length).raw(bytes);
  }
  longstr(value: string | Uint8Array): this {
    const bytes = typeof value === "string" ? text.encode(value) : value;
    return this.u32(bytes.length).raw(bytes);
  }
  /** A field table whose body `fill` writes; the 4-byte length is patched in afterwards. */
  table(fill: (body: FrameBuilder) => void): this {
    const at = this.room(4);
    fill(this);
    this.view.setUint32(at, this.length - at - 4);
    return this;
  }
  done(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

function frame(type: number, channel: number, payload: Uint8Array): Uint8Array {
  return new FrameBuilder().u8(type).u16(channel).u32(payload.length).raw(payload).u8(FRAME_END).done();
}

function method(name: keyof typeof ALLOWED_METHODS, fill?: (args: FrameBuilder) => void): Uint8Array {
  const [classId, methodId] = ALLOWED_METHODS[name];
  const payload = new FrameBuilder().u16(classId).u16(methodId);
  fill?.(payload);
  return frame(FRAME_METHOD, classId === 10 ? 0 : READ_CHANNEL, payload.done());
}

/** What start-ok carries; the credentials are already validated by connection-options.ts. */
export interface StartOkInput {
  readonly username: string;
  readonly password: string;
  readonly locale: string;
  /** Studio's version, omitted from the client properties when null. */
  readonly studioVersion: string | null;
}

function streamOffsetField(body: FrameBuilder, from: StreamOffset): void {
  body.shortstr("x-stream-offset");
  switch (from?.kind) {
    case "keyword":
      body.u8(0x53).longstr(from.value);
      return;
    case "offset":
      if (from.value < BigInt(0)) throw new RangeError("A stream offset is negative.");
      body.u8(0x6c).i64(from.value);
      return;
    case "timestamp":
      body.u8(0x54).u64(from.seconds);
      return;
    case "age":
      if (!AGE.test(from.value)) throw new RangeError("A stream age is not <n><unit>.");
      body.u8(0x53).longstr(from.value);
      return;
    default:
      throw new TypeError("basic.consume needs an x-stream-offset argument.");
  }
}

/** One encoder per allowed frame; the keys are the allowlist, which the seam guard holds equal to the spec's set. */
export const ENCODERS = {
  "protocol-header": (): Uint8Array => PROTOCOL_HEADER.slice(),
  "connection.start-ok": (input: StartOkInput): Uint8Array => {
    if (input.username.includes("\u0000") || input.password.includes("\u0000")) {
      throw new RangeError("A PLAIN credential holds NUL.");
    }
    const response = new FrameBuilder().u8(0).raw(text.encode(input.username)).u8(0).raw(text.encode(input.password));
    return method("connection.start-ok", (args) =>
      args
        .table((props) => {
          props.shortstr("product").u8(0x53).longstr(PRODUCT);
          if (input.studioVersion !== null) props.shortstr("version").u8(0x53).longstr(input.studioVersion);
          props.shortstr("connection_name").u8(0x53).longstr(PRODUCT);
          props
            .shortstr("capabilities")
            .u8(0x46)
            .table((caps) => {
              caps.shortstr("authentication_failure_close").u8(0x74).u8(1);
              caps.shortstr("consumer_cancel_notify").u8(0x74).u8(1);
            });
        })
        .shortstr("PLAIN")
        .longstr(response.done())
        .shortstr(input.locale),
    );
  },
  "connection.tune-ok": (frameMax: number, heartbeat: number): Uint8Array =>
    method("connection.tune-ok", (args) => args.u16(1).u32(frameMax).u16(heartbeat)),
  "connection.open": (vhost: string): Uint8Array =>
    method("connection.open", (args) => args.shortstr(vhost).shortstr("").u8(0)),
  "connection.close": (replyCode: number): Uint8Array =>
    method("connection.close", (args) => args.u16(replyCode).shortstr("").u16(0).u16(0)),
  "connection.close-ok": (): Uint8Array => method("connection.close-ok"),
  "channel.open": (): Uint8Array => method("channel.open", (args) => args.shortstr("")),
  "channel.close-ok": (): Uint8Array => method("channel.close-ok"),
  "basic.qos": (prefetch: number): Uint8Array => method("basic.qos", (args) => args.u32(0).u16(prefetch).u8(0)),
  "basic.consume": (stream: string, from: StreamOffset): Uint8Array =>
    method("basic.consume", (args) =>
      args
        .u16(0)
        .shortstr(stream)
        .shortstr("")
        .u8(0)
        .table((table) => streamOffsetField(table, from)),
    ),
  "basic.ack": (deliveryTag: bigint): Uint8Array => method("basic.ack", (args) => args.u64(deliveryTag).u8(0)),
  "basic.cancel-ok": (consumerTag: Uint8Array): Uint8Array =>
    method("basic.cancel-ok", (args) => args.shortstr(consumerTag)),
  heartbeat: (): Uint8Array => frame(FRAME_HEARTBEAT, 0, new Uint8Array(0)),
} satisfies Readonly<Record<OutboundFrameName, (...args: never[]) => Uint8Array>>;

/**
 * Whether `bytes` is exactly one frame of the allowed set: the protocol header, an empty heartbeat on channel 0, or a
 * method frame whose class and method are allowed, on channel 0 for class 10 and the read channel otherwise, with an
 * ack's `multiple` bit clear.
 */
export function isAllowedOutbound(bytes: Uint8Array): boolean {
  if (bytes.length === PROTOCOL_HEADER.length && bytes.every((byte, index) => byte === PROTOCOL_HEADER[index])) {
    return true;
  }
  if (bytes.length < FRAME_OVERHEAD) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(0);
  const channel = view.getUint16(1);
  const size = view.getUint32(3);
  if (size + FRAME_OVERHEAD !== bytes.length || view.getUint8(bytes.length - 1) !== FRAME_END) return false;
  if (type === FRAME_HEARTBEAT) return channel === 0 && size === 0;
  if (type !== FRAME_METHOD || size < 4) return false;
  const classId = view.getUint16(7);
  const methodId = view.getUint16(9);
  if (channel !== (classId === 10 ? 0 : READ_CHANNEL)) return false;
  const allowed = Object.values(ALLOWED_METHODS).some(([c, m]) => c === classId && m === methodId);
  if (!allowed) return false;
  if (classId === 60 && methodId === 80) return view.getUint8(bytes.length - 2) === 0;
  return true;
}

const lenient = new TextDecoder("utf-8");

/** A bounds-checked reader over one method frame's arguments; an overrun is a malformed frame. */
class ArgumentReader {
  private readonly view: DataView;
  private at = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private take(count: number): number {
    if (count > this.bytes.length - this.at) throw new ProtocolViolation("malformed-frame", 501);
    const at = this.at;
    this.at += count;
    return at;
  }
  u8(): number {
    return this.view.getUint8(this.take(1));
  }
  u16(): number {
    return this.view.getUint16(this.take(2));
  }
  u32(): number {
    return this.view.getUint32(this.take(4));
  }
  u64(): bigint {
    return this.view.getBigUint64(this.take(8));
  }
  bytesOf(count: number): Uint8Array {
    const at = this.take(count);
    return this.bytes.slice(at, at + count);
  }
  shortstr(): Uint8Array {
    return this.bytesOf(this.u8());
  }
  longstr(): Uint8Array {
    return this.bytesOf(this.u32());
  }
  skipTable(): void {
    this.take(this.u32());
  }
  /** Every argument was read: a byte left over is a malformed frame too. */
  end(): void {
    if (this.at !== this.bytes.length) throw new ProtocolViolation("malformed-frame", 501);
  }
}

export interface ConnectionStartArgs {
  readonly versionMajor: number;
  readonly versionMinor: number;
  readonly mechanisms: readonly string[];
  readonly locales: readonly string[];
}

const words = (bytes: Uint8Array): string[] => lenient.decode(bytes).split(" ").filter(Boolean);

export function decodeConnectionStart(args: Uint8Array): ConnectionStartArgs {
  const reader = new ArgumentReader(args);
  const versionMajor = reader.u8();
  const versionMinor = reader.u8();
  reader.skipTable();
  const mechanisms = words(reader.longstr());
  const locales = words(reader.longstr());
  reader.end();
  return { versionMajor, versionMinor, mechanisms, locales };
}

export interface TuneArgs {
  readonly channelMax: number;
  readonly frameMax: number;
  readonly heartbeat: number;
}

export function decodeTune(args: Uint8Array): TuneArgs {
  const reader = new ArgumentReader(args);
  const tune = { channelMax: reader.u16(), frameMax: reader.u32(), heartbeat: reader.u16() };
  reader.end();
  return tune;
}

export interface CloseArgs {
  readonly replyCode: number;
  /** Matched only against fixed patterns by errors.ts; never quoted. */
  readonly replyText: string;
  readonly classId: number;
  readonly methodId: number;
}

export function decodeClose(args: Uint8Array): CloseArgs {
  const reader = new ArgumentReader(args);
  const close = {
    replyCode: reader.u16(),
    replyText: lenient.decode(reader.shortstr()),
    classId: reader.u16(),
    methodId: reader.u16(),
  };
  reader.end();
  return close;
}

export interface DeliverArgs {
  readonly consumerTag: Uint8Array;
  readonly deliveryTag: bigint;
  readonly redelivered: boolean;
  readonly exchange: Uint8Array;
  readonly routingKey: Uint8Array;
}

export function decodeDeliver(args: Uint8Array): DeliverArgs {
  const reader = new ArgumentReader(args);
  const deliver = {
    consumerTag: reader.shortstr(),
    deliveryTag: reader.u64(),
    redelivered: (reader.u8() & 1) === 1,
    exchange: reader.shortstr(),
    routingKey: reader.shortstr(),
  };
  reader.end();
  return deliver;
}

export interface CancelArgs {
  readonly consumerTag: Uint8Array;
  readonly noWait: boolean;
}

export function decodeCancel(args: Uint8Array): CancelArgs {
  const reader = new ArgumentReader(args);
  const cancel = { consumerTag: reader.shortstr(), noWait: (reader.u8() & 1) === 1 };
  reader.end();
  return cancel;
}

/** Server methods by class and method id, for readable checks. */
export const SERVER_METHOD = {
  connectionStart: [10, 10],
  connectionTune: [10, 30],
  connectionOpenOk: [10, 41],
  connectionClose: [10, 50],
  connectionCloseOk: [10, 51],
  connectionBlocked: [10, 60],
  connectionUnblocked: [10, 61],
  channelOpenOk: [20, 11],
  channelClose: [20, 40],
  basicQosOk: [60, 11],
  basicConsumeOk: [60, 21],
  basicCancel: [60, 30],
  basicDeliver: [60, 60],
} as const satisfies Readonly<Record<string, readonly [number, number]>>;
