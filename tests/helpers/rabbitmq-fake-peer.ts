/**
 * Server-side AMQP 0-9-1 bytes for the RabbitMQ read client's tests, and a fake broker that plays them.
 *
 * The encoders here are the broker's half of the protocol, written for tests from the AMQP 0-9-1 specification, so a
 * test can build what a real broker sends and what a hostile one might: tables with any tag, frames of any size, and
 * frames out of sequence. Nothing under src/ imports this file.
 */
import { type AddressInfo, createServer, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import type { AmqpSocket } from "@/lib/db/providers/stream/rabbitmq/amqp/dial";
import type { BasicProperties, FieldEntry, FieldValue } from "@/lib/db/providers/stream/rabbitmq/amqp/field-table";
import type { RabbitMQClock } from "@/lib/db/providers/stream/rabbitmq/limits";

const utf8 = new TextEncoder();

/** Bytes from numbers, strings (UTF-8) and byte arrays, in order. */
export function bytesOf(...parts: readonly (number | string | Uint8Array | readonly number[])[]): Uint8Array {
  const chunks = parts.map((part) =>
    typeof part === "number"
      ? Uint8Array.of(part)
      : typeof part === "string"
        ? utf8.encode(part)
        : part instanceof Uint8Array
          ? part
          : Uint8Array.from(part),
  );
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export const u16 = (value: number): Uint8Array => {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
};
export const u32 = (value: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
};
export const u64 = (value: bigint): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value);
  return out;
};
export const i64 = (value: bigint): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, value);
  return out;
};
export const shortstr = (value: string | Uint8Array): Uint8Array => {
  const bytes = typeof value === "string" ? utf8.encode(value) : value;
  return bytesOf(bytes.length, bytes);
};
export const longstr = (value: string | Uint8Array): Uint8Array => {
  const bytes = typeof value === "string" ? utf8.encode(value) : value;
  return bytesOf(u32(bytes.length), bytes);
};

/** One frame: type, channel, size, payload and the end marker (or another `end` byte, for a broken peer). */
export function frame(type: number, channel: number, payload: Uint8Array, end = 0xce): Uint8Array {
  return bytesOf(type, u16(channel), u32(payload.length), payload, end);
}
/** A method frame on channel 0 for class 10, on channel 1 otherwise, unless `channel` says. */
export function methodFrame(classId: number, methodId: number, args: Uint8Array = new Uint8Array(0), channel?: number) {
  return frame(1, channel ?? (classId === 10 ? 0 : 1), bytesOf(u16(classId), u16(methodId), args));
}

/** A raw table: each entry's name, one tag byte and the value's bytes as given, so any tag or length can be sent. */
export function rawTable(entries: readonly (readonly [string | Uint8Array, string, Uint8Array])[]): Uint8Array {
  const body = bytesOf(...entries.flatMap(([name, tag, value]) => [shortstr(name), tag, value]));
  return bytesOf(u32(body.length), body);
}
/** A raw array: tag byte and value bytes per item. */
export function rawArray(items: readonly (readonly [string, Uint8Array])[]): Uint8Array {
  const body = bytesOf(...items.flatMap(([tag, value]) => [tag, value]));
  return bytesOf(u32(body.length), body);
}

/** A table nested `depth` levels deep (the outer table counts as 1) around one `leaf` string. */
export function nestedTable(depth: number): Uint8Array {
  let table = rawTable([["leaf", "S", longstr("x")]]);
  for (let level = 1; level < depth; level++) table = rawTable([["n", "F", table]]);
  return table;
}

function encodeValue(value: FieldValue): Uint8Array {
  switch (value.tag) {
    case "S":
    case "x":
      return bytesOf(value.tag, longstr(value.bytes));
    case "t":
      return bytesOf("t", value.value ? 1 : 0);
    case "b":
    case "B":
      return bytesOf(value.tag, value.value & 0xff);
    case "s":
    case "u": {
      const out = new Uint8Array(2);
      if (value.tag === "s") new DataView(out.buffer).setInt16(0, value.value);
      else new DataView(out.buffer).setUint16(0, value.value);
      return bytesOf(value.tag, out);
    }
    case "I":
    case "i": {
      const out = new Uint8Array(4);
      if (value.tag === "I") new DataView(out.buffer).setInt32(0, value.value);
      else new DataView(out.buffer).setUint32(0, value.value);
      return bytesOf(value.tag, out);
    }
    case "f": {
      const out = new Uint8Array(4);
      new DataView(out.buffer).setFloat32(0, value.value);
      return bytesOf("f", out);
    }
    case "d": {
      const out = new Uint8Array(8);
      new DataView(out.buffer).setFloat64(0, value.value);
      return bytesOf("d", out);
    }
    case "l":
    case "L":
      return bytesOf(value.tag, i64(value.value));
    case "T":
      return bytesOf("T", u64(value.value));
    case "D": {
      const out = new Uint8Array(4);
      new DataView(out.buffer).setInt32(0, value.value);
      return bytesOf("D", value.scale, out);
    }
    case "V":
      return bytesOf("V");
    case "F":
      return bytesOf("F", encodeTable(value.entries));
    case "A": {
      const body = bytesOf(...value.items.map(encodeValue));
      return bytesOf("A", u32(body.length), body);
    }
    default:
      throw new Error(`no wire form for ${value.tag}`);
  }
}

/** A table from decoded entries, the inverse of the client's walk. */
export function encodeTable(entries: readonly FieldEntry[]): Uint8Array {
  const body = bytesOf(...entries.flatMap((entry) => [shortstr(entry.name), encodeValue(entry.value)]));
  return bytesOf(u32(body.length), body);
}

/** The basic properties in flag order; `headersRaw` replaces `headers` with bytes as given. */
export function encodeProperties(properties: Partial<BasicProperties> & { readonly headersRaw?: Uint8Array }) {
  let flags = 0;
  const parts: Uint8Array[] = [];
  const short = (bit: number, value: Uint8Array | undefined) => {
    if (value === undefined) return;
    flags |= 1 << bit;
    parts.push(shortstr(value));
  };
  short(15, properties.contentType);
  short(14, properties.contentEncoding);
  if (properties.headersRaw !== undefined || properties.headers !== undefined) {
    flags |= 1 << 13;
    parts.push(properties.headersRaw ?? encodeTable(properties.headers ?? []));
  }
  if (properties.deliveryMode !== undefined) {
    flags |= 1 << 12;
    parts.push(Uint8Array.of(properties.deliveryMode));
  }
  if (properties.priority !== undefined) {
    flags |= 1 << 11;
    parts.push(Uint8Array.of(properties.priority));
  }
  short(10, properties.correlationId);
  short(9, properties.replyTo);
  short(8, properties.expiration);
  short(7, properties.messageId);
  if (properties.timestamp !== undefined) {
    flags |= 1 << 6;
    parts.push(u64(properties.timestamp));
  }
  short(5, properties.type);
  short(4, properties.userId);
  short(3, properties.appId);
  short(2, properties.clusterId);
  return bytesOf(u16(flags), ...parts);
}

/** The header table of a stream delivery: `x-stream-offset` first, then `extra`. */
export const offsetHeaders = (offset: bigint, extra: readonly FieldEntry[] = []): FieldEntry[] => [
  { name: utf8.encode("x-stream-offset"), value: { tag: "l", value: offset } },
  ...extra,
];

export const serverFrames = {
  connectionStart(
    options: {
      readonly mechanisms?: string;
      readonly locales?: string;
      readonly major?: number;
      readonly minor?: number;
    } = {},
  ): Uint8Array {
    return methodFrame(
      10,
      10,
      bytesOf(
        options.major ?? 0,
        options.minor ?? 9,
        rawTable([["product", "S", longstr("fake-broker")]]),
        longstr(options.mechanisms ?? "PLAIN AMQPLAIN"),
        longstr(options.locales ?? "en_US"),
      ),
    );
  },
  tune(options: { readonly channelMax?: number; readonly frameMax?: number; readonly heartbeat?: number } = {}) {
    return methodFrame(
      10,
      30,
      bytesOf(u16(options.channelMax ?? 2047), u32(options.frameMax ?? 131_072), u16(options.heartbeat ?? 0)),
    );
  },
  openOk: () => methodFrame(10, 41, shortstr("")),
  channelOpenOk: () => methodFrame(20, 11, longstr("")),
  qosOk: () => methodFrame(60, 11),
  consumeOk: (consumerTag = "ctag") => methodFrame(60, 21, shortstr(consumerTag)),
  deliver(options: {
    readonly deliveryTag: bigint;
    readonly exchange?: string | Uint8Array;
    readonly routingKey?: string | Uint8Array;
    readonly redelivered?: boolean;
  }): Uint8Array {
    return methodFrame(
      60,
      60,
      bytesOf(
        shortstr("ctag"),
        u64(options.deliveryTag),
        options.redelivered === true ? 1 : 0,
        shortstr(options.exchange ?? ""),
        shortstr(options.routingKey ?? "st"),
      ),
    );
  },
  contentHeader(options: {
    readonly bodySize: bigint;
    readonly properties?: Partial<BasicProperties> & { readonly headersRaw?: Uint8Array };
  }): Uint8Array {
    return frame(2, 1, bytesOf(u16(60), u16(0), u64(options.bodySize), encodeProperties(options.properties ?? {})));
  },
  body: (bytes: Uint8Array): Uint8Array => frame(3, 1, bytes),
  basicCancel: (consumerTag = "ctag") => methodFrame(60, 30, bytesOf(shortstr(consumerTag), 0)),
  connectionClose: (replyCode: number, replyText: string, classId = 0, methodId = 0) =>
    methodFrame(10, 50, bytesOf(u16(replyCode), shortstr(replyText), u16(classId), u16(methodId))),
  channelClose: (replyCode: number, replyText: string, classId = 0, methodId = 0) =>
    methodFrame(20, 40, bytesOf(u16(replyCode), shortstr(replyText), u16(classId), u16(methodId))),
  closeOk: () => methodFrame(10, 51),
  heartbeat: () => frame(8, 0, new Uint8Array(0)),
};

/**
 * One whole stream delivery: deliver, a content header whose headers start with `x-stream-offset` (unless
 * `headersRaw` or `properties.headers` says otherwise), and the body split at `frameMax`.
 */
export function message(options: {
  readonly deliveryTag: bigint;
  readonly offset: bigint;
  readonly body?: Uint8Array;
  readonly exchange?: string;
  readonly routingKey?: string;
  readonly properties?: Partial<BasicProperties> & { readonly headersRaw?: Uint8Array };
  readonly frameMax?: number;
}): Uint8Array {
  const body = options.body ?? new Uint8Array(0);
  const properties = { headers: offsetHeaders(options.offset), ...options.properties };
  const step = (options.frameMax ?? 131_072) - 8;
  const parts: Uint8Array[] = [
    serverFrames.deliver(options),
    serverFrames.contentHeader({ bodySize: BigInt(body.length), properties }),
  ];
  for (let at = 0; at < body.length; at += step) parts.push(serverFrames.body(body.subarray(at, at + step)));
  return bytesOf(...parts);
}

export const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A port nothing listens on: bound once, then closed. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Waits until `check` holds, polling every 5 ms, or fails naming `what` after `ms`. */
export async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

export type PeerStep =
  | { readonly send: Uint8Array }
  | { readonly expect: "protocol-header" | { readonly classId: number; readonly methodId: number } }
  | { readonly waitMs: number }
  | { readonly end: "close" | "destroy" | "half-close" }
  /** `bytes` written `times` times, waiting for drain between writes, so a flood never sits in memory. */
  | { readonly repeat: Uint8Array; readonly times: number }
  /** One byte of `bytes` every `everyMs`. */
  | { readonly trickle: Uint8Array; readonly everyMs: number };

export interface ReceivedFrame {
  /** The frame type, or 0 for the protocol header. */
  readonly type: number;
  readonly channel: number;
  readonly classId?: number;
  readonly methodId?: number;
  readonly payload: Uint8Array;
}

export interface FakePeer {
  readonly host: "127.0.0.1";
  readonly port: number;
  /** Connections accepted so far. */
  readonly dials: number;
  /** Every frame the client sent, across connections, in arrival order. */
  readonly received: readonly ReceivedFrame[];
  /** Accepted sockets not closed yet. */
  openSockets(): number;
  stop(): Promise<void>;
}

export interface FakePeerOptions {
  readonly tls?: { readonly key: string; readonly cert: string };
}

/** Splits what a client sends into the protocol header and frames, as they complete. */
function clientFrames(onFrame: (frame: ReceivedFrame) => void): (chunk: Uint8Array) => void {
  let pending: Uint8Array = new Uint8Array(0);
  let headerSeen = false;
  return (chunk) => {
    pending = bytesOf(pending, chunk);
    for (;;) {
      if (!headerSeen) {
        if (pending.length < 8) return;
        onFrame({ type: 0, channel: 0, payload: pending.slice(0, 8) });
        pending = pending.slice(8);
        headerSeen = true;
        continue;
      }
      if (pending.length < 7) return;
      const view = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
      const size = view.getUint32(3);
      if (pending.length < size + 8) return;
      const payload = pending.slice(7, 7 + size);
      const type = view.getUint8(0);
      const ids = type === 1 && size >= 4 ? new DataView(payload.buffer, 0, 4) : null;
      onFrame({
        type,
        channel: view.getUint16(1),
        payload,
        ...(ids ? { classId: ids.getUint16(0), methodId: ids.getUint16(2) } : {}),
      });
      pending = pending.slice(size + 8);
    }
  };
}

/**
 * A broker on 127.0.0.1 that plays `script` on every connection, or hands the raw socket to `script` when it is a
 * function. Every client frame is recorded in `received`.
 */
export async function startFakePeer(
  script: readonly PeerStep[] | ((socket: Socket) => void),
  options: FakePeerOptions = {},
): Promise<FakePeer> {
  const received: ReceivedFrame[] = [];
  const sockets = new Set<Socket>();
  let dials = 0;
  let stopped = false;
  const handle = (socket: Socket): void => {
    dials += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const own: ReceivedFrame[] = [];
    let wake: (() => void) | null = null;
    const parse = clientFrames((frame) => {
      own.push(frame);
      received.push(frame);
      wake?.();
    });
    socket.on("data", (chunk: Uint8Array) => parse(chunk));
    if (typeof script === "function") {
      script(socket);
      return;
    }
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    void (async () => {
      let cursor = 0;
      const arrived = (step: Extract<PeerStep, { expect: unknown }>): boolean => {
        for (; cursor < own.length; cursor++) {
          const frame = own[cursor] as ReceivedFrame;
          const match =
            step.expect === "protocol-header"
              ? frame.type === 0
              : frame.classId === step.expect.classId && frame.methodId === step.expect.methodId;
          if (match) {
            cursor += 1;
            return true;
          }
        }
        return false;
      };
      for (const step of script) {
        if (socket.destroyed || stopped) return;
        if ("send" in step) socket.write(step.send);
        else if ("expect" in step) {
          while (!arrived(step)) {
            if (socket.destroyed || stopped) return;
            await Promise.race([
              new Promise<void>((resolve) => {
                wake = resolve;
              }),
              closed,
            ]);
            wake = null;
          }
        } else if ("waitMs" in step) await sleep(step.waitMs);
        else if ("repeat" in step) {
          for (let sent = 0; sent < step.times && !socket.destroyed; sent++) {
            if (!socket.write(step.repeat)) {
              await Promise.race([new Promise<void>((resolve) => socket.once("drain", resolve)), closed]);
            }
          }
        } else if ("trickle" in step) {
          for (const byte of step.trickle) {
            if (socket.destroyed || stopped) return;
            socket.write(Uint8Array.of(byte));
            await sleep(step.everyMs);
          }
        } else if (step.end === "destroy") socket.destroy();
        else socket.end();
      }
    })();
  };
  const server = options.tls
    ? createTlsServer({ key: options.tls.key, cert: options.tls.cert }, handle)
    : createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    host: "127.0.0.1",
    port,
    get dials() {
      return dials;
    },
    received,
    openSockets: () => sockets.size,
    async stop() {
      stopped = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The steps from the protocol header to consume-ok. */
export function handshakeSteps(options: { readonly frameMax?: number; readonly heartbeat?: number } = {}): PeerStep[] {
  return [
    { expect: "protocol-header" },
    { send: serverFrames.connectionStart() },
    { expect: { classId: 10, methodId: 11 } },
    { send: serverFrames.tune(options) },
    { expect: { classId: 10, methodId: 31 } },
    { expect: { classId: 10, methodId: 40 } },
    { send: serverFrames.openOk() },
    { expect: { classId: 20, methodId: 10 } },
    { send: serverFrames.channelOpenOk() },
    { expect: { classId: 60, methodId: 10 } },
    { send: serverFrames.qosOk() },
    { expect: { classId: 60, methodId: 20 } },
    { send: serverFrames.consumeOk() },
  ];
}

/** After the handshake, answers the client's connection.close with close-ok and ends, as a broker does. */
export const closeSteps: readonly PeerStep[] = [
  { expect: { classId: 10, methodId: 50 } },
  { send: serverFrames.closeOk() },
  { end: "close" },
];

/** A peer that replays recorded server bytes after the handshake. */
export function startReplayPeer(serverBytes: Uint8Array, options: FakePeerOptions = {}): Promise<FakePeer> {
  return startFakePeer([...handshakeSteps(), { send: serverBytes }, ...closeSteps], options);
}

export interface ManualClock extends RabbitMQClock {
  /** Moves time forward by `ms`, running every timer due on the way, in order. */
  advance(ms: number): void;
  /** Timers armed and not yet run or cancelled. */
  pending(): number;
}

export function createManualClock(start = 0): ManualClock {
  let now = start;
  let sequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimer(callback, ms) {
      const id = sequence++;
      timers.set(id, { at: now + ms, callback });
      return () => {
        timers.delete(id);
      };
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let next: [number, { at: number; callback: () => void }] | undefined;
        for (const entry of timers)
          if (entry[1].at <= until && (next === undefined || entry[1].at < next[1].at)) next = entry;
        if (next === undefined) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
      }
      now = until;
    },
    pending: () => timers.size,
  };
}

/**
 * An AmqpSocket with no network under it, for tests on the injected clock: the test pushes server bytes with `push`,
 * which reaches the client synchronously, and every frame the client writes is parsed into `received`. A `respond`
 * function may answer a client frame; its bytes arrive in a microtask, never inside the client's own write.
 */
export interface MemorySocket extends AmqpSocket {
  readonly received: readonly ReceivedFrame[];
  push(bytes: Uint8Array): void;
  /** The peer ends the connection: `end` then `close`. */
  end(): void;
}

export function createMemorySocket(respond?: (frame: ReceivedFrame) => Uint8Array | undefined): MemorySocket {
  const listeners = new Map<string, ((...args: never[]) => void)[]>();
  const received: ReceivedFrame[] = [];
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) (listener as (...values: unknown[]) => void)(...args);
  };
  const parse = clientFrames((frame) => {
    received.push(frame);
    const answer = respond?.(frame);
    if (answer !== undefined) queueMicrotask(() => socket.push(answer));
  });
  let destroyed = false;
  const socket: MemorySocket = {
    received,
    get destroyed() {
      return destroyed;
    },
    write(data) {
      if (!destroyed) parse(data);
      return true;
    },
    on(event: string, listener: (...args: never[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return socket;
    },
    pause: () => socket,
    resume: () => socket,
    destroy() {
      if (destroyed) return socket;
      destroyed = true;
      queueMicrotask(() => emit("close"));
      return socket;
    },
    push(bytes) {
      if (!destroyed) emit("data", bytes);
    },
    end() {
      if (destroyed) return;
      emit("end");
      socket.destroy();
    },
  } as MemorySocket;
  return socket;
}

/**
 * A broker's answers to a client's handshake and close, frame by frame, with `overrides` keyed "class.method" (or
 * "header" for the protocol header) replacing or removing (undefined) an answer.
 */
export function brokerAnswers(
  overrides: Readonly<Record<string, Uint8Array | undefined>> = {},
  tune: Parameters<typeof serverFrames.tune>[0] = {},
): (frame: ReceivedFrame) => Uint8Array | undefined {
  const answers: Record<string, Uint8Array | undefined> = {
    header: serverFrames.connectionStart(),
    "10.11": serverFrames.tune(tune),
    "10.40": serverFrames.openOk(),
    "20.10": serverFrames.channelOpenOk(),
    "60.10": serverFrames.qosOk(),
    "60.20": serverFrames.consumeOk(),
    "10.50": serverFrames.closeOk(),
    ...overrides,
  };
  return (frame) => answers[frame.type === 0 ? "header" : `${frame.classId}.${frame.methodId}`];
}

/** "header", "heartbeat", or "class.method", per frame. */
export const frameNames = (frames: readonly ReceivedFrame[]): string[] =>
  frames.map((frame) =>
    frame.type === 0 ? "header" : frame.type === 8 ? "heartbeat" : `${frame.classId}.${frame.methodId}`,
  );

/** Lets queued microtasks and one macrotask run, so pushed answers and promise continuations settle. */
export const settle = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));
