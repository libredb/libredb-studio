/**
 * The AMQP 0-9-1 encoders and method decoders of the read client: byte layouts of every allowed frame, the outbound
 * allowlist, the stream offset's wire types, and the bounds of every decoder.
 */
import { describe, expect, test } from "bun:test";
import {
  ALLOWED_METHODS,
  decodeCancel,
  decodeClose,
  decodeConnectionStart,
  decodeDeliver,
  decodeTune,
  ENCODERS,
  isAllowedOutbound,
  PROTOCOL_HEADER,
  ProtocolViolation,
  type StreamOffset,
} from "@/lib/db/providers/stream/rabbitmq/amqp/codec";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const ids = (bytes: Uint8Array) => [view(bytes).getUint16(7), view(bytes).getUint16(9)];
const secret = ["pa", "ss"].join("");

/** Every allowed encoder called with valid arguments, keyed by frame name. */
const SAMPLES: Record<keyof typeof ENCODERS, Uint8Array> = {
  "protocol-header": ENCODERS["protocol-header"](),
  "connection.start-ok": ENCODERS["connection.start-ok"]({
    username: "studio-reader",
    password: secret,
    locale: "en_US",
    studioVersion: "1.2.3",
  }),
  "connection.tune-ok": ENCODERS["connection.tune-ok"](131_072, 60),
  "connection.open": ENCODERS["connection.open"]("billing"),
  "connection.close": ENCODERS["connection.close"](200),
  "connection.close-ok": ENCODERS["connection.close-ok"](),
  "channel.open": ENCODERS["channel.open"](),
  "channel.close-ok": ENCODERS["channel.close-ok"](),
  "basic.qos": ENCODERS["basic.qos"](10),
  "basic.consume": ENCODERS["basic.consume"]("st-orders", { kind: "keyword", value: "last" }),
  "basic.ack": ENCODERS["basic.ack"](BigInt(7)),
  "basic.cancel-ok": ENCODERS["basic.cancel-ok"](new TextEncoder().encode("ctag")),
  heartbeat: ENCODERS.heartbeat(),
};

/** Methods no encoder may produce: get, reject, nack, recover, recover-async, publish, client cancel, and whole classes. */
const FORBIDDEN_METHODS: readonly (readonly [number, number])[] = [
  [60, 70],
  [60, 90],
  [60, 120],
  [60, 110],
  [60, 100],
  [60, 40],
  [60, 30],
];
const FORBIDDEN_CLASSES = [40, 50, 85, 90];

describe("the allowlist", () => {
  test("the encoder keys are exactly the allowed frames", () => {
    expect(Object.keys(ENCODERS).sort()).toEqual(
      [
        "protocol-header",
        "connection.start-ok",
        "connection.tune-ok",
        "connection.open",
        "connection.close",
        "connection.close-ok",
        "channel.open",
        "channel.close-ok",
        "basic.qos",
        "basic.consume",
        "basic.ack",
        "basic.cancel-ok",
        "heartbeat",
      ].sort(),
    );
  });

  test("no encoder output carries a forbidden class or method, and every one passes the outbound check", () => {
    for (const [name, bytes] of Object.entries(SAMPLES)) {
      expect({ name, allowed: isAllowedOutbound(bytes) }).toEqual({ name, allowed: true });
      if (name === "protocol-header" || name === "heartbeat") continue;
      const [classId, methodId] = ids(bytes);
      expect(FORBIDDEN_CLASSES).not.toContain(classId);
      expect(FORBIDDEN_METHODS.some(([c, m]) => c === classId && m === methodId)).toBe(false);
      expect(ALLOWED_METHODS[name as keyof typeof ALLOWED_METHODS]).toEqual([classId, methodId]);
    }
  });

  test("the outbound check refuses forbidden methods, wrong channels, bad sizes and a multiple ack", () => {
    const methodFrame = (channel: number, classId: number, methodId: number, args: number[] = []) => {
      const payload = [classId >> 8, classId & 0xff, methodId >> 8, methodId & 0xff, ...args];
      const size = payload.length;
      return Uint8Array.of(1, channel >> 8, channel & 0xff, 0, 0, 0, size, ...payload, 0xce);
    };
    expect(isAllowedOutbound(methodFrame(1, 60, 70, [0, 0, 0, 0]))).toBe(false);
    expect(isAllowedOutbound(methodFrame(1, 60, 40))).toBe(false);
    expect(isAllowedOutbound(methodFrame(1, 60, 30))).toBe(false);
    expect(isAllowedOutbound(methodFrame(1, 50, 10))).toBe(false);
    expect(isAllowedOutbound(methodFrame(0, 60, 10, [0, 0, 0, 0, 0, 1, 0]))).toBe(false);
    expect(isAllowedOutbound(methodFrame(1, 10, 51))).toBe(false);
    expect(isAllowedOutbound(methodFrame(1, 60, 80, [0, 0, 0, 0, 0, 0, 0, 1, 1]))).toBe(false);
    expect(isAllowedOutbound(methodFrame(1, 60, 80, [0, 0, 0, 0, 0, 0, 0, 1, 0]))).toBe(true);
    expect(isAllowedOutbound(Uint8Array.of(1, 0, 1, 0, 0, 0, 2, 0, 0, 0xce))).toBe(false);
    expect(isAllowedOutbound(Uint8Array.of(8, 0, 1, 0, 0, 0, 0, 0xce))).toBe(false);
    expect(isAllowedOutbound(Uint8Array.of(3, 0, 1, 0, 0, 0, 0, 0xce))).toBe(false);
    expect(isAllowedOutbound(Uint8Array.of(8, 0, 0, 0, 0, 0, 0, 0x00))).toBe(false);
    expect(isAllowedOutbound(Uint8Array.of(8, 0, 0, 0, 0, 0, 1, 0xce))).toBe(false);
    expect(isAllowedOutbound(Uint8Array.of(1, 0))).toBe(false);
  });
});

describe("byte layouts", () => {
  test("the protocol header and the heartbeat", () => {
    expect(hex(SAMPLES["protocol-header"])).toBe("414d515000000901");
    expect(hex(PROTOCOL_HEADER)).toBe("414d515000000901");
    expect(hex(SAMPLES.heartbeat)).toBe("08000000000000ce");
  });

  test("tune-ok sends channel-max 1, the frame size and the heartbeat", () => {
    expect(hex(SAMPLES["connection.tune-ok"])).toBe("0100000000000c000a001f000100020000003cce");
  });

  test("open, close, close-ok, channel open, channel close-ok, qos, ack and cancel-ok", () => {
    expect(hex(SAMPLES["connection.open"])).toBe(
      "0100000000000e000a002807" + hex(new TextEncoder().encode("billing")) + "0000ce",
    );
    expect(hex(SAMPLES["connection.close"])).toBe("0100000000000b000a003200c80000000000ce");
    expect(hex(SAMPLES["connection.close-ok"])).toBe("01000000000004000a0033ce");
    expect(hex(SAMPLES["channel.open"])).toBe("010001000000050014000a00ce");
    expect(hex(SAMPLES["channel.close-ok"])).toBe("0100010000000400140029ce");
    expect(hex(SAMPLES["basic.qos"])).toBe("0100010000000b003c000a00000000000a00ce");
    expect(hex(SAMPLES["basic.ack"])).toBe("0100010000000d003c0050000000000000000700ce");
    expect(hex(SAMPLES["basic.cancel-ok"])).toBe("01000100000009003c001f0463746167ce");
  });

  test("start-ok carries PLAIN, the response, the locale and the client properties without platform", () => {
    const bytes = SAMPLES["connection.start-ok"];
    const body = Buffer.from(bytes);
    expect(ids(bytes)).toEqual([10, 11]);
    expect(body.includes(Buffer.from("\u0005PLAIN"))).toBe(true);
    expect(body.includes(Buffer.from(`\u0000studio-reader\u0000${secret}`))).toBe(true);
    expect(body.includes(Buffer.from("\u0005en_US"))).toBe(true);
    for (const key of ["product", "version", "connection_name", "capabilities"]) {
      expect(body.includes(Buffer.from(key))).toBe(true);
    }
    expect(body.includes(Buffer.from("LibreDB Studio"))).toBe(true);
    expect(body.includes(Buffer.from("1.2.3"))).toBe(true);
    expect(body.includes(Buffer.from("\u001cauthentication_failure_closet\u0001"))).toBe(true);
    expect(body.includes(Buffer.from("\u0016consumer_cancel_notifyt\u0001"))).toBe(true);
    expect(body.includes(Buffer.from("platform"))).toBe(false);
    expect(body.includes(Buffer.from("connection.blocked"))).toBe(false);
  });

  test("start-ok omits version when Studio's version is unknown, and refuses NUL in a credential", () => {
    const bytes = ENCODERS["connection.start-ok"]({
      username: "u",
      password: secret,
      locale: "en_US",
      studioVersion: null,
    });
    expect(Buffer.from(bytes).includes(Buffer.from("\u0007versionS"))).toBe(false);
    expect(() =>
      ENCODERS["connection.start-ok"]({ username: "a\u0000b", password: secret, locale: "en_US", studioVersion: null }),
    ).toThrow(RangeError);
  });

  test("a vhost or stream longer than 255 bytes cannot be encoded", () => {
    expect(() => ENCODERS["connection.open"]("v".repeat(256))).toThrow(RangeError);
    expect(() => ENCODERS["basic.consume"]("s".repeat(256), { kind: "keyword", value: "first" })).toThrow(RangeError);
    expect(ENCODERS["connection.open"]("é".repeat(127)).length).toBeGreaterThan(0);
  });

  test("the vhost goes on the wire raw, %2F included", () => {
    expect(Buffer.from(ENCODERS["connection.open"]("%2F")).includes(Buffer.from("\u0003%2F"))).toBe(true);
    expect(Buffer.from(ENCODERS["connection.open"]("/")).includes(Buffer.from("\u0001/"))).toBe(true);
  });
});

describe("basic.consume and the stream offset", () => {
  const argument = (from: StreamOffset): string => {
    const bytes = ENCODERS["basic.consume"]("s", from);
    const marker = Buffer.from("\u000fx-stream-offset");
    const at = Buffer.from(bytes).indexOf(marker);
    return hex(bytes.subarray(at + marker.length, bytes.length - 1));
  };

  test("keywords and ages are longstr, offsets signed int64, timestamps an AMQP timestamp", () => {
    expect(argument({ kind: "keyword", value: "first" })).toBe("53000000056669727374");
    expect(argument({ kind: "keyword", value: "next" })).toBe("53000000046e657874");
    expect(argument({ kind: "offset", value: BigInt("9223372036854775807") })).toBe("6c7fffffffffffffff");
    expect(argument({ kind: "offset", value: BigInt(0) })).toBe("6c0000000000000000");
    expect(argument({ kind: "timestamp", seconds: BigInt(1_760_000_000) })).toBe("540000000068e77800");
    expect(argument({ kind: "age", value: "15m" })).toBe("530000000331356d");
  });

  test("consume sends no-ack false, an empty consumer tag and the queue name", () => {
    const bytes = ENCODERS["basic.consume"]("st-orders", { kind: "keyword", value: "last" });
    expect(ids(bytes)).toEqual([60, 20]);
    expect(hex(bytes.subarray(11, 13))).toBe("0000");
    expect(Buffer.from(bytes).includes(Buffer.from("\u0009st-orders\u0000\u0000"))).toBe(true);
  });

  test("the consume encoder throws without its argument, and for an offset or age out of range", () => {
    expect(() => ENCODERS["basic.consume"]("s", undefined as never)).toThrow(TypeError);
    expect(() => ENCODERS["basic.consume"]("s", { kind: "offset", value: -BigInt(1) })).toThrow(RangeError);
    expect(() => ENCODERS["basic.consume"]("s", { kind: "offset", value: BigInt(2) ** BigInt(63) })).toThrow(
      RangeError,
    );
    expect(() => ENCODERS["basic.consume"]("s", { kind: "timestamp", seconds: -BigInt(1) })).toThrow(RangeError);
    expect(() => ENCODERS["basic.consume"]("s", { kind: "age", value: "0h" })).toThrow(RangeError);
  });

  test("an ack's delivery tag is unsigned 64-bit", () => {
    expect(() => ENCODERS["basic.ack"](-BigInt(1))).toThrow(RangeError);
    expect(hex(ENCODERS["basic.ack"](BigInt(2) ** BigInt(64) - BigInt(1)).subarray(11, 19))).toBe("ffffffffffffffff");
  });
});

describe("method decoders", () => {
  const bytes = (...parts: (number[] | string)[]) =>
    Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? Array.from(Buffer.from(part)) : part)));

  test("connection.start: version, mechanisms and locales, server properties stepped over", () => {
    const start = decodeConnectionStart(
      bytes([0, 9], [0, 0, 0, 2, 0xaa, 0xbb], [0, 0, 0, 24], "PLAIN AMQPLAIN ANONYMOUS", [0, 0, 0, 5], "en_US"),
    );
    expect(start).toEqual({
      versionMajor: 0,
      versionMinor: 9,
      mechanisms: ["PLAIN", "AMQPLAIN", "ANONYMOUS"],
      locales: ["en_US"],
    });
  });

  test("connection.tune, close, deliver and cancel", () => {
    expect(decodeTune(bytes([0x07, 0xff, 0, 2, 0, 0, 0, 60]))).toEqual({
      channelMax: 2047,
      frameMax: 131_072,
      heartbeat: 60,
    });
    expect(decodeClose(bytes([0x02, 0x12, 7], "NOT_ALL", [0, 10, 0, 40]))).toEqual({
      replyCode: 530,
      replyText: "NOT_ALL",
      classId: 10,
      methodId: 40,
    });
    const deliver = decodeDeliver(bytes([4], "ctag", [0, 0, 0, 0, 0, 0, 0, 9, 1, 2], "ex", [3], "key"));
    expect(deliver.deliveryTag).toBe(BigInt(9));
    expect(deliver.redelivered).toBe(true);
    expect(Buffer.from(deliver.exchange).toString()).toBe("ex");
    expect(Buffer.from(deliver.routingKey).toString()).toBe("key");
    expect(Buffer.from(deliver.consumerTag).toString()).toBe("ctag");
    const cancel = decodeCancel(bytes([4], "ctag", [1]));
    expect(cancel.noWait).toBe(true);
    expect(Buffer.from(cancel.consumerTag).toString()).toBe("ctag");
  });

  test("every decoder refuses arguments that end early, as a malformed frame with 501", () => {
    for (const decode of [decodeConnectionStart, decodeTune, decodeClose, decodeDeliver, decodeCancel]) {
      let caught: unknown;
      try {
        decode(Uint8Array.of(0));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProtocolViolation);
      expect(caught).toMatchObject({ fact: "malformed-frame", replyCode: 501 });
    }
    expect(() => decodeConnectionStart(bytes([0, 9], [0, 0, 1, 0]))).toThrow(ProtocolViolation);
  });

  test("every decoder refuses a byte left over after its last argument, as a malformed frame with 501", () => {
    const valid: [(args: Uint8Array) => unknown, Uint8Array][] = [
      [decodeConnectionStart, bytes([0, 9], [0, 0, 0, 0], [0, 0, 0, 5], "PLAIN", [0, 0, 0, 5], "en_US")],
      [decodeTune, bytes([0, 0, 0, 2, 0, 0, 0, 60])],
      [decodeClose, bytes([0x01, 0x40, 0], [0, 0, 0, 0])],
      [decodeDeliver, bytes([4], "ctag", [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0])],
      [decodeCancel, bytes([4], "ctag", [0])],
    ];
    for (const [decode, args] of valid) {
      expect(() => decode(args)).not.toThrow();
      let caught: unknown;
      try {
        decode(bytes([...args], [0]));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProtocolViolation);
      expect(caught).toMatchObject({ fact: "malformed-frame", replyCode: 501 });
    }
  });
});
