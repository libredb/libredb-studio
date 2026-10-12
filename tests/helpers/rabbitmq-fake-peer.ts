/**
 * Server-side AMQP 0-9-1 bytes for the RabbitMQ read client's tests, and a fake broker that plays them.
 *
 * The encoders here are the broker's half of the protocol, written for tests from the AMQP 0-9-1 specification, so a
 * test can build what a real broker sends and what a hostile one might: tables with any tag, frames of any size, and
 * frames out of sequence. Nothing under src/ imports this file.
 */
import type { BasicProperties, FieldEntry, FieldValue } from "@/lib/db/providers/stream/rabbitmq/amqp/field-table";

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
