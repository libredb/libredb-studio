/**
 * A test-only AMQP 0-9-1 client for the RabbitMQ fixture: it opens one connection with SASL PLAIN, publishes with
 * publisher confirms, and offers the raw frame helpers the `basic.get` control of the read-only check builds on.
 *
 * It exists because the provider's own client cannot publish: its encoder table has no `basic.publish`,
 * `basic.get` or declare (the seam guard holds that), and the seed adds no dependency. Nothing under `src/` may
 * import this file or `rabbitmq-basic-get.ts`; `tests/unit/db/rabbitmq/live-environment.test.ts` holds that.
 *
 * Every publish waits for its own `basic.ack`, so a stream's chunk boundaries are deterministic when the seed
 * publishes one message per call: a message that must sit alone in its chunk is published alone.
 */
import net from "node:net";

/** One AMQP 0-9-1 field value, by its RabbitMQ wire tag. */
export type TestFieldValue =
  | { readonly t: "S"; readonly v: string | Uint8Array }
  | { readonly t: "x"; readonly v: Uint8Array }
  | { readonly t: "t"; readonly v: boolean }
  | { readonly t: "b" | "B" | "s" | "u" | "I" | "i"; readonly v: number }
  | { readonly t: "l" | "T"; readonly v: bigint }
  | { readonly t: "f" | "d"; readonly v: number }
  | { readonly t: "V" }
  | { readonly t: "F"; readonly v: TestFieldTable }
  | { readonly t: "A"; readonly v: readonly TestFieldValue[] };

/** Pairs, not an object, so `__proto__`, an empty name, a repeated name and a name that is not UTF-8 can be sent. */
export type TestFieldTable = ReadonlyArray<readonly [name: string | Uint8Array, value: TestFieldValue]>;

export interface TestBasicProperties {
  readonly contentType?: string | Uint8Array;
  readonly contentEncoding?: string | Uint8Array;
  readonly headers?: TestFieldTable;
  readonly deliveryMode?: number;
  readonly priority?: number;
  readonly correlationId?: string;
  readonly replyTo?: string;
  readonly expiration?: string;
  readonly messageId?: string;
  readonly timestamp?: bigint;
  readonly type?: string;
  readonly userId?: string;
  readonly appId?: string;
}

export interface TestAmqpTarget {
  readonly host: string;
  readonly port: number;
  readonly vhost: string;
  readonly username: string;
  readonly password: string;
}

export interface InboundFrame {
  readonly type: number;
  readonly channel: number;
  readonly payload: Uint8Array;
}

const FRAME_METHOD = 1;
const FRAME_HEADER = 2;
const FRAME_BODY = 3;
const FRAME_END = 0xce;
const FRAME_MAX = 131_072;
const encoder = new TextEncoder();

const bytesOf = (value: string | Uint8Array): Uint8Array => (typeof value === "string" ? encoder.encode(value) : value);

/** A growable big-endian byte writer. */
export class ByteWriter {
  private chunks: Uint8Array[] = [];
  private length = 0;

  private push(bytes: Uint8Array): this {
    this.chunks.push(bytes);
    this.length += bytes.length;
    return this;
  }
  private fixed(size: number, write: (view: DataView) => void): this {
    const bytes = new Uint8Array(size);
    write(new DataView(bytes.buffer));
    return this.push(bytes);
  }
  raw(bytes: Uint8Array): this {
    return this.push(bytes);
  }
  u8(value: number): this {
    return this.fixed(1, (view) => view.setUint8(0, value));
  }
  i8(value: number): this {
    return this.fixed(1, (view) => view.setInt8(0, value));
  }
  u16(value: number): this {
    return this.fixed(2, (view) => view.setUint16(0, value));
  }
  i16(value: number): this {
    return this.fixed(2, (view) => view.setInt16(0, value));
  }
  u32(value: number): this {
    return this.fixed(4, (view) => view.setUint32(0, value));
  }
  i32(value: number): this {
    return this.fixed(4, (view) => view.setInt32(0, value));
  }
  u64(value: bigint): this {
    return this.fixed(8, (view) => view.setBigUint64(0, value));
  }
  i64(value: bigint): this {
    return this.fixed(8, (view) => view.setBigInt64(0, value));
  }
  f32(value: number): this {
    return this.fixed(4, (view) => view.setFloat32(0, value));
  }
  f64(value: number): this {
    return this.fixed(8, (view) => view.setFloat64(0, value));
  }
  shortstr(value: string | Uint8Array): this {
    const bytes = bytesOf(value);
    if (bytes.length > 255) throw new Error(`a short string holds at most 255 bytes, got ${bytes.length}`);
    return this.u8(bytes.length).raw(bytes);
  }
  longstr(value: string | Uint8Array): this {
    const bytes = bytesOf(value);
    return this.u32(bytes.length).raw(bytes);
  }
  table(entries: TestFieldTable): this {
    const inner = new ByteWriter();
    for (const [name, value] of entries) inner.shortstr(name).fieldValue(value);
    return this.longstr(inner.bytes());
  }
  fieldValue(value: TestFieldValue): this {
    this.u8(value.t.charCodeAt(0));
    switch (value.t) {
      case "S":
        return this.longstr(value.v);
      case "x":
        return this.longstr(value.v);
      case "t":
        return this.u8(value.v ? 1 : 0);
      case "b":
        return this.i8(value.v);
      case "B":
        return this.u8(value.v);
      case "s":
        return this.i16(value.v);
      case "u":
        return this.u16(value.v);
      case "I":
        return this.i32(value.v);
      case "i":
        return this.u32(value.v);
      case "l":
        return this.i64(value.v);
      case "T":
        return this.u64(value.v);
      case "f":
        return this.f32(value.v);
      case "d":
        return this.f64(value.v);
      case "V":
        return this;
      case "F":
        return this.table(value.v);
      case "A": {
        const inner = new ByteWriter();
        for (const item of value.v) inner.fieldValue(item);
        return this.longstr(inner.bytes());
      }
    }
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

/** One frame: type, channel, size, payload and the frame-end octet. */
export function frame(type: number, channel: number, payload: Uint8Array): Uint8Array {
  return new ByteWriter().u8(type).u16(channel).u32(payload.length).raw(payload).u8(FRAME_END).bytes();
}

/** A method frame whose arguments `args` writes. */
export function methodFrame(
  channel: number,
  classId: number,
  methodId: number,
  args?: (w: ByteWriter) => void,
): Uint8Array {
  const writer = new ByteWriter().u16(classId).u16(methodId);
  args?.(writer);
  return frame(FRAME_METHOD, channel, writer.bytes());
}

/** The content header frame and the body frames of one message, split at the negotiated frame size. */
export function contentFrames(
  channel: number,
  properties: TestBasicProperties,
  body: Uint8Array,
  frameMax: number,
): Uint8Array[] {
  const props = new ByteWriter();
  let flags = 0;
  const set = (bit: number, write: () => void) => {
    flags |= 1 << bit;
    write();
  };
  if (properties.contentType !== undefined) set(15, () => props.shortstr(properties.contentType as string));
  if (properties.contentEncoding !== undefined) set(14, () => props.shortstr(properties.contentEncoding as string));
  if (properties.headers !== undefined) set(13, () => props.table(properties.headers as TestFieldTable));
  if (properties.deliveryMode !== undefined) set(12, () => props.u8(properties.deliveryMode as number));
  if (properties.priority !== undefined) set(11, () => props.u8(properties.priority as number));
  if (properties.correlationId !== undefined) set(10, () => props.shortstr(properties.correlationId as string));
  if (properties.replyTo !== undefined) set(9, () => props.shortstr(properties.replyTo as string));
  if (properties.expiration !== undefined) set(8, () => props.shortstr(properties.expiration as string));
  if (properties.messageId !== undefined) set(7, () => props.shortstr(properties.messageId as string));
  if (properties.timestamp !== undefined) set(6, () => props.u64(properties.timestamp as bigint));
  if (properties.type !== undefined) set(5, () => props.shortstr(properties.type as string));
  if (properties.userId !== undefined) set(4, () => props.shortstr(properties.userId as string));
  if (properties.appId !== undefined) set(3, () => props.shortstr(properties.appId as string));
  const header = new ByteWriter().u16(60).u16(0).u64(BigInt(body.length)).u16(flags).raw(props.bytes()).bytes();
  const frames = [frame(FRAME_HEADER, channel, header)];
  const room = frameMax - 8;
  for (let at = 0; at < body.length; at += room) frames.push(frame(FRAME_BODY, channel, body.subarray(at, at + room)));
  return frames;
}

/** Splits a byte stream into frames; a frame that does not end in 0xCE throws. */
export class FrameSplitter {
  private pending = new Uint8Array(0);

  push(chunk: Uint8Array): InboundFrame[] {
    const joined = new Uint8Array(this.pending.length + chunk.length);
    joined.set(this.pending);
    joined.set(chunk, this.pending.length);
    const frames: InboundFrame[] = [];
    let at = 0;
    while (joined.length - at >= 7) {
      const view = new DataView(joined.buffer, joined.byteOffset + at);
      const size = view.getUint32(3);
      if (joined.length - at < 8 + size) break;
      if (joined[at + 7 + size] !== FRAME_END) throw new Error("a frame did not end in 0xCE");
      frames.push({ type: joined[at], channel: view.getUint16(1), payload: joined.slice(at + 7, at + 7 + size) });
      at += 8 + size;
    }
    this.pending = joined.slice(at);
    return frames;
  }
}

/** The class and method ids at the start of a method frame's payload. */
export function methodId(payload: Uint8Array): { readonly classId: number; readonly methodId: number } {
  const view = new DataView(payload.buffer, payload.byteOffset);
  return { classId: view.getUint16(0), methodId: view.getUint16(2) };
}

/** A big-endian reader over one frame payload. */
export class ByteReader {
  private at = 0;
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  skip(count: number): this {
    this.at += count;
    return this;
  }
  u8(): number {
    return this.view.getUint8(this.at++);
  }
  u16(): number {
    const value = this.view.getUint16(this.at);
    this.at += 2;
    return value;
  }
  u32(): number {
    const value = this.view.getUint32(this.at);
    this.at += 4;
    return value;
  }
  u64(): bigint {
    const value = this.view.getBigUint64(this.at);
    this.at += 8;
    return value;
  }
  shortstr(): Uint8Array {
    const length = this.u8();
    const value = this.bytes.slice(this.at, this.at + length);
    this.at += length;
    return value;
  }
  longstr(): Uint8Array {
    const length = this.u32();
    const value = this.bytes.slice(this.at, this.at + length);
    this.at += length;
    return value;
  }
}

const decoder = new TextDecoder();

/** A connection.close or channel.close the broker sent, as an Error naming its code and text. */
export function closeError(payload: Uint8Array, scope: string): Error {
  const reader = new ByteReader(payload).skip(4);
  const code = reader.u16();
  const text = decoder.decode(reader.shortstr());
  return Object.assign(new Error(`the broker closed the ${scope}: ${code} ${text}`), { replyCode: code });
}

/** One open AMQP 0-9-1 connection with one channel, frame by frame. */
export class TestAmqpConnection {
  readonly frameMax: number;
  private readonly waiting: Array<(frame: InboundFrame) => void> = [];
  private readonly inbox: InboundFrame[] = [];
  private failure: Error | null = null;

  private constructor(
    private readonly socket: net.Socket,
    frameMax: number,
  ) {
    this.frameMax = frameMax;
  }

  /**
   * Opens the socket, runs the handshake to `channel.open-ok` on channel 1, and returns the connection.
   * `connectionName` sets the `connection_name` client property, which the management API lists; the live check's
   * positive control names one "LibreDB Studio" to prove its connection listing would see the provider's.
   */
  static async open(
    target: TestAmqpTarget,
    connectionName = "libredb-studio-test-fixture",
  ): Promise<TestAmqpConnection> {
    const timeoutMs = 15_000;
    const socket = net.connect({ host: target.host, port: target.port, noDelay: true });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`no answer from ${target.host}:${target.port}`)));
    const splitter = new FrameSplitter();
    const early: InboundFrame[] = [];
    let connection: TestAmqpConnection | null = null;
    let earlyWaiter: ((frame: InboundFrame) => void) | null = null;
    let earlyFailure: ((error: Error) => void) | null = null;
    socket.on("data", (chunk: Buffer) => {
      for (const inbound of splitter.push(new Uint8Array(chunk))) {
        if (connection) connection.deliver(inbound);
        else if (earlyWaiter) {
          const waiter = earlyWaiter;
          earlyWaiter = null;
          waiter(inbound);
        } else early.push(inbound);
      }
    });
    const fail = (error: Error) => {
      if (connection) connection.fail(error);
      else earlyFailure?.(error);
    };
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("the broker closed the socket")));
    const next = (): Promise<InboundFrame> =>
      new Promise((resolve, reject) => {
        const queued = early.shift();
        if (queued) return resolve(queued);
        earlyWaiter = resolve;
        earlyFailure = reject;
      });
    const expectMethod = async (classId: number, method: number): Promise<InboundFrame> => {
      const inbound = await next();
      const id = methodId(inbound.payload);
      if (id.classId === 10 && id.methodId === 50) throw closeError(inbound.payload, "connection");
      if (id.classId !== classId || id.methodId !== method) {
        throw new Error(`expected ${classId}.${method}, got ${id.classId}.${id.methodId}`);
      }
      return inbound;
    };
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(new Uint8Array([0x41, 0x4d, 0x51, 0x50, 0, 0, 9, 1]));
    await expectMethod(10, 10);
    const response = new Uint8Array([0, ...encoder.encode(target.username), 0, ...encoder.encode(target.password)]);
    socket.write(
      methodFrame(0, 10, 11, (w) =>
        w
          .table([
            ["product", { t: "S", v: "libredb-studio-test-fixture" }],
            ["connection_name", { t: "S", v: connectionName }],
          ])
          .shortstr("PLAIN")
          .longstr(response)
          .shortstr("en_US"),
      ),
    );
    const tune = new ByteReader((await expectMethod(10, 30)).payload).skip(4);
    const channelMax = tune.u16();
    const serverFrameMax = tune.u32();
    const frameMax = serverFrameMax === 0 ? FRAME_MAX : Math.min(serverFrameMax, FRAME_MAX);
    socket.write(methodFrame(0, 10, 31, (w) => w.u16(channelMax).u32(frameMax).u16(0)));
    socket.write(methodFrame(0, 10, 40, (w) => w.shortstr(target.vhost).shortstr("").u8(0)));
    await expectMethod(10, 41);
    socket.write(methodFrame(1, 20, 10, (w) => w.shortstr("")));
    await expectMethod(20, 11);
    socket.setTimeout(0);
    connection = new TestAmqpConnection(socket, frameMax);
    for (const queued of early.splice(0)) connection.deliver(queued);
    return connection;
  }

  private deliver(inbound: InboundFrame): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter(inbound);
    else this.inbox.push(inbound);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const waiter of this.waiting.splice(0)) waiter({ type: -1, channel: 0, payload: new Uint8Array(0) });
  }

  /** The next frame from the broker; a connection.close or channel.close throws with its code. */
  async next(): Promise<InboundFrame> {
    const inbound =
      this.inbox.shift() ?? (this.failure ? null : await new Promise<InboundFrame>((r) => this.waiting.push(r)));
    if (!inbound || inbound.type === -1) throw this.failure ?? new Error("the connection failed");
    if (inbound.type === FRAME_METHOD) {
      const id = methodId(inbound.payload);
      if (id.classId === 10 && id.methodId === 50) throw closeError(inbound.payload, "connection");
      if (id.classId === 20 && id.methodId === 40) throw closeError(inbound.payload, "channel");
    }
    return inbound;
  }

  /** The next method frame, which must be `classId.methodId`. */
  async expect(classId: number, method: number): Promise<InboundFrame> {
    const inbound = await this.next();
    const id = methodId(inbound.payload);
    if (inbound.type !== FRAME_METHOD || id.classId !== classId || id.methodId !== method) {
      throw new Error(`expected ${classId}.${method}, got frame ${inbound.type} ${id.classId}.${id.methodId}`);
    }
    return inbound;
  }

  send(...frames: Uint8Array[]): void {
    for (const bytes of frames) this.socket.write(bytes);
  }

  /** connection.close, close-ok, and the socket ended. */
  async close(): Promise<void> {
    if (this.failure) {
      this.socket.destroy();
      return;
    }
    this.send(methodFrame(0, 10, 50, (w) => w.u16(200).shortstr("").u16(0).u16(0)));
    try {
      for (;;) {
        const inbound = await this.next();
        if (inbound.type !== FRAME_METHOD) continue;
        const id = methodId(inbound.payload);
        if (id.classId === 10 && id.methodId === 51) break;
      }
    } finally {
      this.socket.destroy();
    }
  }
}

/** A connection in confirm mode that publishes one message per call and waits for its own acknowledgement. */
export class TestPublisher {
  private deliveryTag = BigInt(0);

  private constructor(private readonly connection: TestAmqpConnection) {}

  static async open(target: TestAmqpTarget): Promise<TestPublisher> {
    const connection = await TestAmqpConnection.open(target);
    connection.send(methodFrame(1, 85, 10, (w) => w.u8(0)));
    await connection.expect(85, 11);
    return new TestPublisher(connection);
  }

  /** Publishes and waits for `basic.ack`; a nack, a return of a mandatory publish or a close throws. */
  async publish(
    exchange: string,
    routingKey: string,
    body: Uint8Array,
    properties: TestBasicProperties = {},
    mandatory = true,
  ): Promise<void> {
    this.deliveryTag += BigInt(1);
    this.connection.send(
      methodFrame(1, 60, 40, (w) =>
        w
          .u16(0)
          .shortstr(exchange)
          .shortstr(routingKey)
          .u8(mandatory ? 1 : 0),
      ),
      ...contentFrames(1, properties, body, this.connection.frameMax),
    );
    // A returned mandatory publish is still confirmed: basic.return and its content arrive first, then basic.ack.
    let returned = false;
    for (;;) {
      const inbound = await this.connection.next();
      if (inbound.type !== FRAME_METHOD) continue;
      const id = methodId(inbound.payload);
      if (id.classId === 60 && id.methodId === 50) returned = true;
      if (id.classId === 60 && id.methodId === 120) throw new Error(`the broker refused the publish to ${routingKey}`);
      if (id.classId === 60 && id.methodId === 80) {
        const tag = new ByteReader(inbound.payload).skip(4).u64();
        if (tag !== this.deliveryTag) throw new Error(`acknowledged ${tag}, expected ${this.deliveryTag}`);
        if (returned) throw new Error(`the broker returned the publish to ${routingKey}: no queue is bound to it`);
        return;
      }
    }
  }

  close(): Promise<void> {
    return this.connection.close();
  }
}
