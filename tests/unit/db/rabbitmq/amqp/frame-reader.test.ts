/**
 * Frame boundaries and size checks before any buffering: method and body frames against the negotiated frame size,
 * content-header frames against their own limit and walked as they arrive, the body prefix, the no-copy skip and its
 * observer, the content sequence, and the first bytes of a peer that does not speak AMQP 0-9-1.
 */
import { describe, expect, test } from "bun:test";
import { type FrameEvent, FrameReader } from "@/lib/db/providers/stream/rabbitmq/amqp/frame-reader";
import type { ProtocolFact } from "@/lib/db/providers/stream/rabbitmq/errors";
import {
  RABBITMQ_BODY_PREFIX_BYTES,
  RABBITMQ_FRAME_MAX_CEILING,
  RABBITMQ_HEADER_FRAME_MAX_BYTES,
} from "@/lib/db/providers/stream/rabbitmq/limits";
import {
  bytesOf,
  frame,
  i64,
  longstr,
  message,
  methodFrame,
  rawTable,
  serverFrames,
  u16,
  u32,
  u64,
} from "../../../../helpers/rabbitmq-fake-peer";

function reader(frameMax?: number) {
  const events: FrameEvent[] = [];
  const skipped: Uint8Array[] = [];
  const instance = new FrameReader({
    onEvent: (event) => events.push(event),
    onSkippedBytes: (view) => skipped.push(view),
  });
  if (frameMax !== undefined) instance.setFrameMax(frameMax);
  return { instance, events, skipped, types: () => events.map((event) => event.type) };
}

/** A reader past the first frame, so the foreign-bytes check is behind it. */
function started(frameMax = RABBITMQ_FRAME_MAX_CEILING) {
  const r = reader(frameMax);
  r.instance.feed(serverFrames.openOk());
  r.events.length = 0;
  return r;
}

const violations = (events: readonly FrameEvent[]) => events.filter((event) => event.type === "violation");
const deliver = serverFrames.deliver({ deliveryTag: BigInt(1) });

describe("frames", () => {
  test("a method frame fed one byte at a time is one method event; every chunk is counted before it is read", () => {
    const r = reader();
    const bytes = serverFrames.tune({ frameMax: 131_072, heartbeat: 60 });
    for (const byte of bytes) r.instance.feed(Uint8Array.of(byte));
    const methods = r.events.filter((event) => event.type === "method");
    expect(methods).toHaveLength(1);
    expect(methods[0]).toMatchObject({ channel: 0, classId: 10, methodId: 30 });
    expect(r.events.filter((event) => event.type === "inbound")).toHaveLength(bytes.length);
    expect(r.events[0]).toEqual({ type: "inbound", bytes: 1 });
  });

  test("unreadInChunk answers the bytes of the chunk after the frame that raised the event", () => {
    const unread: number[] = [];
    const instance: FrameReader = new FrameReader({
      onEvent: (event) => {
        if (event.type === "method") unread.push(instance.unreadInChunk());
      },
    });
    const consumeOk = serverFrames.consumeOk();
    instance.feed(bytesOf(serverFrames.openOk(), consumeOk, 1, 2, 3));
    expect(unread).toEqual([consumeOk.length + 3, 3]);
  });

  test("a chunk of heartbeats only is heartbeat-only progress; any byte of another frame is not", () => {
    const r = started();
    r.instance.feed(bytesOf(serverFrames.heartbeat(), serverFrames.heartbeat()));
    expect(r.events.filter((event) => event.type === "heartbeat")).toHaveLength(2);
    expect(r.events.at(-1)).toEqual({ type: "progress", heartbeatOnly: true });
    r.instance.feed(serverFrames.qosOk().subarray(0, 1));
    expect(r.events.at(-1)).toEqual({ type: "progress", heartbeatOnly: false });
    r.instance.feed(serverFrames.qosOk().subarray(1));
    expect(r.events.at(-1)).toEqual({ type: "progress", heartbeatOnly: false });
  });

  test("a frame above the size is refused from its 7-byte header, before any payload byte", () => {
    const before = reader();
    before.instance.feed(bytesOf(1, u16(0), u32(0x7fff_fff0)));
    expect(violations(before.events)).toEqual([{ type: "violation", fact: "frame-too-large", replyCode: 501 }]);
    const exact = reader();
    exact.instance.feed(bytesOf(1, u16(0), u32(8_192 - 8 + 1)));
    expect(violations(exact.events)).toHaveLength(1);

    const after = started();
    after.instance.feed(
      bytesOf(deliver, serverFrames.contentHeader({ bodySize: BigInt(2_000_000) }), 3, u16(1), u32(1_048_576)),
    );
    expect(violations(after.events)).toEqual([{ type: "violation", fact: "frame-too-large", replyCode: 501 }]);
    after.instance.feed(serverFrames.heartbeat());
    expect(after.events.at(-1)?.type).toBe("violation");
  });

  test("a content-header frame above the frame size is accepted up to its own limit, and refused past it", () => {
    const r = started();
    const headers = rawTable([
      ["x-stream-offset", "l", i64(BigInt(3))],
      ["big", "x", longstr(new Uint8Array(1_048_576))],
    ]);
    r.instance.feed(
      bytesOf(deliver, serverFrames.contentHeader({ bodySize: BigInt(0), properties: { headersRaw: headers } })),
    );
    expect(violations(r.events)).toEqual([]);
    expect(r.types()).toContain("header");
    const begin = r.events.find((event) => event.type === "header-begin");
    expect(begin).toMatchObject({ frameSize: 14 + headers.length });

    const over = started();
    over.instance.feed(bytesOf(deliver, 2, u16(1), u32(RABBITMQ_HEADER_FRAME_MAX_BYTES + 1)));
    expect(violations(over.events)).toEqual([{ type: "violation", fact: "header-too-large", replyCode: 501 }]);
  });

  test("a 64 MiB header frame is walked chunk by chunk with nothing held but the retained table", () => {
    const r = started();
    const entry = 64 * 1024 * 1024;
    const table = bytesOf(u32(1 + 3 + 1 + 4 + entry + 1 + 15 + 1 + 8));
    const prefix = bytesOf(deliver, 2, u16(1));
    const payloadStart = bytesOf(
      u16(60),
      u16(0),
      u64(BigInt(0)),
      u16(1 << 13),
      table,
      shortName("big"),
      "x",
      u32(entry),
    );
    const size = payloadStart.length + entry + 1 + 15 + 1 + 8;
    r.instance.feed(bytesOf(prefix, u32(size), payloadStart));
    const zeros = new Uint8Array(65_536);
    for (let sent = 0; sent < entry; sent += zeros.length) r.instance.feed(zeros);
    r.instance.feed(bytesOf(shortName("x-stream-offset"), "l", i64(BigInt(9)), 0xce));
    expect(violations(r.events)).toEqual([]);
    expect(r.events.find((event) => event.type === "stream-offset")).toEqual({
      type: "stream-offset",
      offset: BigInt(9),
    });
    const header = r.events.find((event) => event.type === "header");
    expect(header?.type === "header" ? header.properties.headers?.[0]?.value : null).toEqual({
      tag: "omitted",
      bytes: entry,
    });
  });
});

function shortName(text: string): Uint8Array {
  return bytesOf(text.length, text);
}

describe("bodies", () => {
  test("a body keeps its prefix; the rest is stepped over and each span seen as a view of the chunk", () => {
    const r = started();
    const size = RABBITMQ_BODY_PREFIX_BYTES + 1000;
    const body = new Uint8Array(size).map((_, index) => index & 0xff);
    const bytes = message({ deliveryTag: BigInt(1), offset: BigInt(7), body, frameMax: 131_072 });
    const chunks: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += 40_000) chunks.push(bytes.subarray(at, at + 40_000));
    for (const chunk of chunks) r.instance.feed(chunk);
    const last = r.events.filter((event) => event.type === "body").at(-1);
    expect(last?.type === "body" && last.complete).toBe(true);
    const kept = last?.type === "body" ? last.kept : new Uint8Array(0);
    expect(kept.length).toBe(RABBITMQ_BODY_PREFIX_BYTES);
    expect(Buffer.from(kept).equals(Buffer.from(body.subarray(0, RABBITMQ_BODY_PREFIX_BYTES)))).toBe(true);
    expect(r.skipped.reduce((sum, view) => sum + view.length, 0)).toBe(1000);
    expect(Buffer.concat(r.skipped).equals(Buffer.from(body.subarray(RABBITMQ_BODY_PREFIX_BYTES)))).toBe(true);
    expect(r.skipped.every((view) => chunks.some((chunk) => chunk.buffer === view.buffer))).toBe(true);
  });

  test("events of one message come in order: method, header-begin, body-size, stream-offset, header, body", () => {
    const r = started();
    r.instance.feed(message({ deliveryTag: BigInt(1), offset: BigInt(4), body: bytesOf("hi") }));
    expect(r.types().filter((type) => type !== "inbound" && type !== "progress")).toEqual([
      "method",
      "header-begin",
      "body-size",
      "stream-offset",
      "header",
      "body",
    ]);
  });

  test("an empty body completes at its header, and heartbeats inside content are accepted", () => {
    const empty = started();
    empty.instance.feed(message({ deliveryTag: BigInt(1), offset: BigInt(0) }));
    expect(empty.events.find((event) => event.type === "body")).toMatchObject({ complete: true, frameBytes: 0 });

    const r = started();
    r.instance.feed(
      bytesOf(
        deliver,
        serverFrames.heartbeat(),
        serverFrames.contentHeader({
          bodySize: BigInt(4),
          properties: { headersRaw: rawTable([["x-stream-offset", "l", i64(BigInt(1))]]) },
        }),
        serverFrames.body(bytesOf("ab")),
        serverFrames.heartbeat(),
        serverFrames.body(bytesOf("cd")),
      ),
    );
    expect(violations(r.events)).toEqual([]);
    const last = r.events.filter((event) => event.type === "body").at(-1);
    expect(last?.type === "body" ? Buffer.from(last.kept).toString() : "").toBe("abcd");
  });

  test("a channel-0 method between a delivery's frames is passed on; the read channel's sequence holds", () => {
    const r = started();
    r.instance.feed(
      bytesOf(
        deliver,
        serverFrames.connectionClose(320, "CONNECTION_FORCED"),
        serverFrames.contentHeader({
          bodySize: BigInt(2),
          properties: { headersRaw: rawTable([["x-stream-offset", "l", i64(BigInt(1))]]) },
        }),
        serverFrames.connectionClose(320, "CONNECTION_FORCED"),
        serverFrames.body(bytesOf("ab")),
      ),
    );
    expect(violations(r.events)).toEqual([]);
    expect(r.types().filter((type) => type === "method" || type === "header" || type === "body")).toEqual([
      "method",
      "method",
      "header",
      "method",
      "body",
    ]);
  });

  test("a declared body above 512 MiB is refused before any body byte", () => {
    const r = started();
    r.instance.feed(bytesOf(deliver, serverFrames.contentHeader({ bodySize: BigInt(2) ** BigInt(40) })));
    expect(violations(r.events)).toEqual([{ type: "violation", fact: "body-ceiling", replyCode: 501 }]);
    expect(r.types()).not.toContain("header");
  });
});

describe("sequence and shape", () => {
  const cases: readonly (readonly [string, Uint8Array, ProtocolFact, 501 | 505 | null])[] = [
    ["an unknown frame type", bytesOf(4, u16(0), u32(0), 0xce), "unknown-frame-type", null],
    ["a bad frame end", frame(1, 0, bytesOf(u16(10), u16(41), 0), 0x00), "frame-end", null],
    ["a frame on channel 2", methodFrame(20, 11, longstr(""), 2), "unexpected-frame", 505],
    [
      "a content header without a delivery",
      serverFrames.contentHeader({ bodySize: BigInt(0) }),
      "unexpected-frame",
      505,
    ],
    ["a body without a header", serverFrames.body(bytesOf("x")), "unexpected-frame", 505],
    ["a method inside content", bytesOf(deliver, serverFrames.qosOk()), "unexpected-frame", 505],
    ["a heartbeat with a payload", frame(8, 0, bytesOf(1)), "malformed-frame", 501],
    ["a heartbeat on a channel", frame(8, 1, new Uint8Array(0)), "malformed-frame", 501],
    ["a method frame shorter than its ids", frame(1, 0, bytesOf(0, 10)), "malformed-frame", 501],
    [
      "a body frame past the declared size",
      bytesOf(deliver, serverFrames.contentHeader({ bodySize: BigInt(2) }), serverFrames.body(bytesOf("abc"))),
      "malformed-frame",
      501,
    ],
  ];
  for (const [name, bytes, fact, replyCode] of cases) {
    test(`${name} is a violation (${fact})`, () => {
      const r = started();
      r.instance.feed(bytes);
      expect(violations(r.events)).toEqual([{ type: "violation", fact, replyCode }]);
    });
  }

  test("the first bytes of another protocol, a TLS alert, or anything else are foreign", () => {
    const kinds = [
      [bytesOf("AMQP", 1, 1, 0, 10), "amqp"],
      [bytesOf(0x15, 0x03, 0x03, 0, 2, 2, 70), "tls"],
      [bytesOf("HTTP/1.1 400 Bad Request\r\n"), "other"],
    ] as const;
    for (const [bytes, kind] of kinds) {
      const r = reader();
      r.instance.feed(bytes);
      expect(r.events.filter((event) => event.type === "foreign")).toEqual([{ type: "foreign", kind }]);
      expect(r.types().at(-1)).toBe("foreign");
    }
  });

  test("halt stops every later event", () => {
    const r = started();
    r.instance.halt();
    r.instance.feed(serverFrames.qosOk());
    expect(r.events).toEqual([]);
  });

  test("an error thrown by a listener is not swallowed as a violation", () => {
    const instance = new FrameReader({
      onEvent: (event) => {
        if (event.type === "method") throw new TypeError("listener");
      },
    });
    expect(() => instance.feed(serverFrames.openOk())).toThrow(TypeError);
  });
});
