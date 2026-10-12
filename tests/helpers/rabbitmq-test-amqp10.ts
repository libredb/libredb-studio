/**
 * A test-only AMQP 1.0 sender for the RabbitMQ fixture: SASL PLAIN, one session, one sending link to
 * `/queues/<name>`, and one transfer per message, each waiting for its own `accepted` disposition.
 *
 * The fixture needs messages that only an AMQP 1.0 publisher can make, the ones a reader over AMQP 0-9-1 sees after
 * the broker's conversion: `amqp-value` and `amqp-sequence` bodies, several `data` sections, a footer, typed
 * application properties, and the values the conversion cannot carry (a uuid or a char, a content type over 255
 * bytes), which end a 0-9-1 read with `connection.close 541` on the pinned releases. No dependency is added for
 * it, so the few performatives and types it needs are encoded here by hand, from the OASIS AMQP 1.0 standard,
 * parts 1.6 (types), 2.7 (performatives), 3.2 (message format) and 5.3 (SASL).
 * Nothing under `src/` may import this file; `tests/unit/db/rabbitmq/live-environment.test.ts` holds that.
 */
import net from "node:net";

export type Amqp10Value =
  | { readonly type: "null" }
  | { readonly type: "boolean"; readonly value: boolean }
  | { readonly type: "ubyte" | "ushort" | "uint" | "byte" | "short" | "int"; readonly value: number }
  | { readonly type: "ulong" | "long" | "timestamp"; readonly value: bigint }
  | { readonly type: "float" | "double"; readonly value: number }
  | { readonly type: "char"; readonly value: number }
  | { readonly type: "uuid"; readonly value: Uint8Array }
  | { readonly type: "binary"; readonly value: Uint8Array }
  | { readonly type: "string" | "symbol"; readonly value: string }
  | { readonly type: "list"; readonly value: readonly Amqp10Value[] }
  | { readonly type: "map"; readonly value: ReadonlyArray<readonly [Amqp10Value, Amqp10Value]> }
  | { readonly type: "described"; readonly descriptor: Amqp10Value; readonly value: Amqp10Value };

/** Shorthands for the values the seed writes. */
export const v = {
  null: (): Amqp10Value => ({ type: "null" }),
  bool: (value: boolean): Amqp10Value => ({ type: "boolean", value }),
  uint: (value: number): Amqp10Value => ({ type: "uint", value }),
  int: (value: number): Amqp10Value => ({ type: "int", value }),
  ulong: (value: bigint): Amqp10Value => ({ type: "ulong", value }),
  long: (value: bigint): Amqp10Value => ({ type: "long", value }),
  timestamp: (ms: bigint): Amqp10Value => ({ type: "timestamp", value: ms }),
  double: (value: number): Amqp10Value => ({ type: "double", value }),
  char: (codePoint: number): Amqp10Value => ({ type: "char", value: codePoint }),
  uuid: (bytes: Uint8Array): Amqp10Value => ({ type: "uuid", value: bytes }),
  bin: (value: Uint8Array): Amqp10Value => ({ type: "binary", value }),
  str: (value: string): Amqp10Value => ({ type: "string", value }),
  sym: (value: string): Amqp10Value => ({ type: "symbol", value }),
  list: (...items: Amqp10Value[]): Amqp10Value => ({ type: "list", value: items }),
  map: (...entries: Array<readonly [Amqp10Value, Amqp10Value]>): Amqp10Value => ({ type: "map", value: entries }),
  described: (code: number, value: Amqp10Value): Amqp10Value => ({
    type: "described",
    descriptor: { type: "ulong", value: BigInt(code) },
    value,
  }),
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function fixed(code: number, size: number, write: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(1 + size);
  bytes[0] = code;
  write(new DataView(bytes.buffer, 1));
  return bytes;
}

function variable(code: number, payload: Uint8Array): Uint8Array {
  return concat([fixed(code, 4, (view) => view.setUint32(0, payload.length)), payload]);
}

/** One value in its widest constructor, which every AMQP 1.0 decoder must accept. */
export function encodeValue(value: Amqp10Value): Uint8Array {
  switch (value.type) {
    case "null":
      return new Uint8Array([0x40]);
    case "boolean":
      return new Uint8Array([value.value ? 0x41 : 0x42]);
    case "ubyte":
      return fixed(0x50, 1, (view) => view.setUint8(0, value.value));
    case "ushort":
      return fixed(0x60, 2, (view) => view.setUint16(0, value.value));
    case "uint":
      return fixed(0x70, 4, (view) => view.setUint32(0, value.value));
    case "byte":
      return fixed(0x51, 1, (view) => view.setInt8(0, value.value));
    case "short":
      return fixed(0x61, 2, (view) => view.setInt16(0, value.value));
    case "int":
      return fixed(0x71, 4, (view) => view.setInt32(0, value.value));
    case "ulong":
      return fixed(0x80, 8, (view) => view.setBigUint64(0, value.value));
    case "long":
      return fixed(0x81, 8, (view) => view.setBigInt64(0, value.value));
    case "timestamp":
      return fixed(0x83, 8, (view) => view.setBigInt64(0, value.value));
    case "float":
      return fixed(0x72, 4, (view) => view.setFloat32(0, value.value));
    case "double":
      return fixed(0x82, 8, (view) => view.setFloat64(0, value.value));
    case "char":
      return fixed(0x73, 4, (view) => view.setUint32(0, value.value));
    case "uuid":
      if (value.value.length !== 16) throw new Error("a uuid is 16 bytes");
      return concat([new Uint8Array([0x98]), value.value]);
    case "binary":
      return variable(0xb0, value.value);
    case "string":
      return variable(0xb1, encoder.encode(value.value));
    case "symbol":
      return variable(0xb3, encoder.encode(value.value));
    case "list": {
      const items = value.value.map(encodeValue);
      const body = concat([fixed(0, 4, (view) => view.setUint32(0, items.length)).subarray(1), ...items]);
      return variable(0xd0, body);
    }
    case "map": {
      const items = value.value.flatMap(([key, item]) => [encodeValue(key), encodeValue(item)]);
      const body = concat([fixed(0, 4, (view) => view.setUint32(0, items.length)).subarray(1), ...items]);
      return variable(0xd1, body);
    }
    case "described":
      return concat([new Uint8Array([0x00]), encodeValue(value.descriptor), encodeValue(value.value)]);
  }
}

/** A message to send; sections are written in the standard's order, each only when given. */
export interface Amqp10MessageInput {
  /** The properties section's fields by position: message-id, user-id, to, subject, reply-to, correlation-id, content-type, content-encoding. */
  readonly properties?: {
    readonly messageId?: Amqp10Value;
    readonly subject?: string;
    readonly contentType?: string;
    readonly contentEncoding?: string;
  };
  readonly messageAnnotations?: ReadonlyArray<readonly [string, Amqp10Value]>;
  readonly applicationProperties?: ReadonlyArray<readonly [string, Amqp10Value]>;
  readonly body:
    | { readonly kind: "data"; readonly sections: readonly Uint8Array[] }
    | { readonly kind: "value"; readonly value: Amqp10Value }
    | { readonly kind: "sequence"; readonly items: readonly Amqp10Value[] };
  readonly footer?: ReadonlyArray<readonly [string, Amqp10Value]>;
}

const symbolMap = (entries: ReadonlyArray<readonly [string, Amqp10Value]>): Amqp10Value =>
  v.map(...entries.map(([key, item]) => [v.sym(key), item] as const));

const stringMap = (entries: ReadonlyArray<readonly [string, Amqp10Value]>): Amqp10Value =>
  v.map(...entries.map(([key, item]) => [v.str(key), item] as const));

/** The message's bare and annotated sections, encoded. */
export function encodeMessage(message: Amqp10MessageInput): Uint8Array {
  const sections: Uint8Array[] = [];
  if (message.messageAnnotations) sections.push(encodeValue(v.described(0x72, symbolMap(message.messageAnnotations))));
  if (message.properties) {
    const p = message.properties;
    const fields: Amqp10Value[] = [
      p.messageId ?? v.null(),
      v.null(),
      v.null(),
      p.subject === undefined ? v.null() : v.str(p.subject),
      v.null(),
      v.null(),
      p.contentType === undefined ? v.null() : v.sym(p.contentType),
      p.contentEncoding === undefined ? v.null() : v.sym(p.contentEncoding),
    ];
    while (fields.length > 0 && fields[fields.length - 1].type === "null") fields.pop();
    sections.push(encodeValue(v.described(0x73, v.list(...fields))));
  }
  if (message.applicationProperties) {
    sections.push(encodeValue(v.described(0x74, stringMap(message.applicationProperties))));
  }
  const body = message.body;
  if (body.kind === "data")
    for (const section of body.sections) sections.push(encodeValue(v.described(0x75, v.bin(section))));
  if (body.kind === "sequence") sections.push(encodeValue(v.described(0x76, v.list(...body.items))));
  if (body.kind === "value") sections.push(encodeValue(v.described(0x77, body.value)));
  if (message.footer) sections.push(encodeValue(v.described(0x78, symbolMap(message.footer))));
  return concat(sections);
}

/** A decoded value: numbers as number or bigint, strings and symbols as string, described as { descriptor, value }. */
export type Decoded =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | Decoded[]
  | { readonly descriptor: Decoded; readonly value: Decoded };

/** Decodes one value at `at`; enough of part 1.6 to read the performatives and outcomes a broker sends. */
export function decodeValue(bytes: Uint8Array, at: number): { readonly value: Decoded; readonly next: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const code = bytes[at];
  const sized = (width: 1 | 4): { size: number; start: number } =>
    width === 1 ? { size: bytes[at + 1], start: at + 2 } : { size: view.getUint32(at + 1), start: at + 5 };
  const compound = (width: 1 | 4) => {
    const { size, start } = sized(width);
    const count = width === 1 ? bytes[start] : view.getUint32(start);
    const items: Decoded[] = [];
    let next = start + width;
    for (let index = 0; index < count; index++) {
      const item = decodeValue(bytes, next);
      items.push(item.value);
      next = item.next;
    }
    return { value: items, next: start + size };
  };
  switch (code) {
    case 0x00: {
      const descriptor = decodeValue(bytes, at + 1);
      const value = decodeValue(bytes, descriptor.next);
      return { value: { descriptor: descriptor.value, value: value.value }, next: value.next };
    }
    case 0x40:
      return { value: null, next: at + 1 };
    case 0x41:
      return { value: true, next: at + 1 };
    case 0x42:
      return { value: false, next: at + 1 };
    case 0x56:
      return { value: bytes[at + 1] === 1, next: at + 2 };
    case 0x43:
    case 0x44:
      return { value: 0, next: at + 1 };
    case 0x45:
      return { value: [], next: at + 1 };
    case 0x50:
    case 0x52:
      return { value: bytes[at + 1], next: at + 2 };
    case 0x53:
      return { value: BigInt(bytes[at + 1]), next: at + 2 };
    case 0x51:
    case 0x54:
      return { value: view.getInt8(at + 1), next: at + 2 };
    case 0x55:
      return { value: BigInt(view.getInt8(at + 1)), next: at + 2 };
    case 0x60:
      return { value: view.getUint16(at + 1), next: at + 3 };
    case 0x61:
      return { value: view.getInt16(at + 1), next: at + 3 };
    case 0x70:
      return { value: view.getUint32(at + 1), next: at + 5 };
    case 0x71:
      return { value: view.getInt32(at + 1), next: at + 5 };
    case 0x72:
      return { value: view.getFloat32(at + 1), next: at + 5 };
    case 0x73:
      return { value: view.getUint32(at + 1), next: at + 5 };
    case 0x80:
      return { value: view.getBigUint64(at + 1), next: at + 9 };
    case 0x81:
    case 0x83:
      return { value: view.getBigInt64(at + 1), next: at + 9 };
    case 0x82:
      return { value: view.getFloat64(at + 1), next: at + 9 };
    case 0x84:
      return { value: bytes.slice(at + 1, at + 9), next: at + 9 };
    case 0x94:
    case 0x98:
      return { value: bytes.slice(at + 1, at + 17), next: at + 17 };
    case 0xa0:
    case 0xb0: {
      const { size, start } = sized(code === 0xa0 ? 1 : 4);
      return { value: bytes.slice(start, start + size), next: start + size };
    }
    case 0xa1:
    case 0xa3:
    case 0xb1:
    case 0xb3: {
      const { size, start } = sized(code === 0xa1 || code === 0xa3 ? 1 : 4);
      return { value: decoder.decode(bytes.subarray(start, start + size)), next: start + size };
    }
    case 0xc0:
    case 0xc1:
      return compound(1);
    case 0xd0:
    case 0xd1:
      return compound(4);
    case 0xe0:
    case 0xf0: {
      const width = code === 0xe0 ? 1 : 4;
      const { size, start } = sized(width);
      const count = width === 1 ? bytes[start] : view.getUint32(start);
      const constructorAt = start + width;
      const items: Decoded[] = [];
      let next = constructorAt + 1;
      for (let index = 0; index < count; index++) {
        const scratch = new Uint8Array([bytes[constructorAt], ...bytes.subarray(next)]);
        const item = decodeValue(scratch, 0);
        items.push(item.value);
        next += item.next - 1;
      }
      return { value: items, next: start + size };
    }
    default:
      throw new Error(`AMQP 1.0 constructor 0x${code.toString(16)} is not decoded by this helper`);
  }
}

export interface Amqp10Target {
  readonly host: string;
  readonly port: number;
  readonly vhost: string;
  readonly username: string;
  readonly password: string;
}

interface Amqp10Frame {
  readonly type: number;
  readonly channel: number;
  readonly performative: number;
  readonly fields: Decoded[];
}

const descriptorCode = (value: Decoded): number => Number(value as bigint);

function amqpFrame(type: 0 | 1, channel: number, body: Uint8Array): Uint8Array {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint32(0, 8 + body.length);
  header[4] = 2;
  header[5] = type;
  view.setUint16(6, channel);
  return concat([header, body]);
}

const performative = (code: number, ...fields: Amqp10Value[]): Uint8Array =>
  encodeValue(v.described(code, v.list(...fields)));

/** One connection, session and sending link; `send` writes one message and waits for `accepted`. */
export class Amqp10Sender {
  private nextDeliveryId = 0;
  private readonly frames: Amqp10Frame[] = [];
  private readonly waiting: Array<() => void> = [];
  private failure: Error | null = null;
  private maxFrameSize = 65_536;

  private constructor(private readonly socket: net.Socket) {}

  static async open(target: Amqp10Target, queue: string): Promise<Amqp10Sender> {
    const socket = net.connect({ host: target.host, port: target.port, noDelay: true });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const sender = new Amqp10Sender(socket);
    sender.listen();
    await sender.handshake(target, queue);
    return sender;
  }

  private listen(): void {
    let pending: Uint8Array = new Uint8Array(0);
    this.socket.on("data", (chunk: Buffer) => {
      pending = concat([pending, new Uint8Array(chunk)]);
      for (;;) {
        if (pending.length >= 8 && pending[0] === 0x41 && pending[1] === 0x4d) {
          // A protocol header: AMQP 3 1 0 0 for SASL, AMQP 0 1 0 0 after it.
          pending = pending.slice(8);
          continue;
        }
        if (pending.length < 8) break;
        const view = new DataView(pending.buffer, pending.byteOffset);
        const size = view.getUint32(0);
        if (pending.length < size) break;
        const body = pending.subarray(pending[4] * 4, size);
        if (body.length > 0) {
          const decoded = decodeValue(body, 0).value as { descriptor: Decoded; value: Decoded[] };
          this.frames.push({
            type: pending[5],
            channel: view.getUint16(6),
            performative: descriptorCode(decoded.descriptor),
            fields: decoded.value,
          });
        }
        pending = pending.slice(size);
      }
      for (const waiter of this.waiting.splice(0)) waiter();
    });
    const fail = (error: Error) => {
      this.failure ??= error;
      for (const waiter of this.waiting.splice(0)) waiter();
    };
    this.socket.on("error", fail);
    this.socket.on("close", () => fail(new Error("the broker closed the socket")));
  }

  /** Waits for the next frame with one of `codes`; a close or detach with an error throws its condition. */
  private async next(...codes: number[]): Promise<Amqp10Frame> {
    for (;;) {
      const index = this.frames.findIndex(
        (f) => codes.includes(f.performative) || [0x16, 0x17, 0x18].includes(f.performative),
      );
      if (index >= 0) {
        const found = this.frames.splice(index, 1)[0];
        if (!codes.includes(found.performative)) {
          const error = found.fields.find((field) => field && typeof field === "object" && "descriptor" in field) as
            | { value: Decoded[] }
            | undefined;
          throw new Error(
            `the broker ended the ${found.performative === 0x18 ? "connection" : "link"}: ${String(error?.value?.[0])} ${String(error?.value?.[1] ?? "")}`,
          );
        }
        return found;
      }
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }

  private async handshake(target: Amqp10Target, queue: string): Promise<void> {
    this.socket.write(new Uint8Array([0x41, 0x4d, 0x51, 0x50, 3, 1, 0, 0]));
    await this.next(0x40);
    const response = new Uint8Array([0, ...encoder.encode(target.username), 0, ...encoder.encode(target.password)]);
    this.socket.write(amqpFrame(1, 0, performative(0x41, v.sym("PLAIN"), v.bin(response))));
    const outcome = await this.next(0x44);
    if (Number(outcome.fields[0]) !== 0) throw new Error(`SASL refused with code ${String(outcome.fields[0])}`);
    this.socket.write(new Uint8Array([0x41, 0x4d, 0x51, 0x50, 0, 1, 0, 0]));
    this.socket.write(
      amqpFrame(0, 0, performative(0x10, v.str("libredb-studio-test-fixture"), v.str(`vhost:${target.vhost}`))),
    );
    const open = await this.next(0x10);
    if (typeof open.fields[2] === "number") this.maxFrameSize = Math.min(open.fields[2], 131_072);
    this.socket.write(amqpFrame(0, 0, performative(0x11, v.null(), v.uint(0), v.uint(2048), v.uint(2048))));
    await this.next(0x11);
    const address = `/queues/${encodeURIComponent(queue)}`;
    this.socket.write(
      amqpFrame(
        0,
        0,
        performative(
          0x12,
          v.str(`fixture-${queue}`),
          v.uint(0),
          v.bool(false),
          { type: "ubyte", value: 0 },
          { type: "ubyte", value: 0 },
          v.described(0x28, v.list()),
          v.described(0x29, v.list(v.str(address))),
          v.null(),
          v.bool(false),
          v.uint(0),
        ),
      ),
    );
    const attach = await this.next(0x12);
    if (attach.fields[6] === null) throw new Error(`the broker refused a link to ${address}`);
    await this.next(0x13);
  }

  /** Sends one message unsettled and waits for its disposition; anything but `accepted` throws. */
  async send(message: Amqp10MessageInput): Promise<void> {
    const deliveryId = this.nextDeliveryId++;
    const payload = encodeMessage(message);
    const tag = new Uint8Array(4);
    new DataView(tag.buffer).setUint32(0, deliveryId);
    // A transfer frame carries the performative, at most 40 bytes here, then the payload.
    const room = this.maxFrameSize - 8 - 64;
    let at = 0;
    do {
      const piece = payload.subarray(at, at + room);
      const opening = at === 0;
      at += piece.length;
      const more = at < payload.length;
      const head = opening
        ? performative(0x14, v.uint(0), v.uint(deliveryId), v.bin(tag), v.uint(0), v.bool(false), v.bool(more))
        : performative(0x14, v.uint(0), v.null(), v.null(), v.null(), v.null(), v.bool(more));
      this.socket.write(amqpFrame(0, 0, concat([head, piece])));
    } while (at < payload.length);
    for (;;) {
      const disposition = await this.next(0x15, 0x13);
      if (disposition.performative === 0x13) continue;
      const firstId = Number(disposition.fields[1]);
      const lastId =
        disposition.fields[2] === null || disposition.fields[2] === undefined ? firstId : Number(disposition.fields[2]);
      if (deliveryId < firstId || deliveryId > lastId) continue;
      const state = disposition.fields[4] as { descriptor: Decoded } | null;
      const code = state ? descriptorCode(state.descriptor) : -1;
      if (code !== 0x24) throw new Error(`the broker did not accept the message (outcome 0x${code.toString(16)})`);
      return;
    }
  }

  /** detach, end and close, each answered in kind, then the socket ended. */
  async close(): Promise<void> {
    this.socket.write(amqpFrame(0, 0, performative(0x16, v.uint(0), v.bool(true))));
    this.socket.write(amqpFrame(0, 0, performative(0x17)));
    this.socket.write(amqpFrame(0, 0, performative(0x18)));
    try {
      while ((await this.next(0x16, 0x17, 0x18)).performative !== 0x18);
    } finally {
      this.socket.destroy();
    }
  }
}
