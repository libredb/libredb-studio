/**
 * The connection state machine against a fake broker on loopback and the injected clock: negotiation and its clamps,
 * PLAIN only, the failures before consume-ok, heartbeats, the peer's endings after consume-ok, the normal close and
 * the hard drop, and the one write site.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AmqpFailure,
  type AmqpConnection,
  createAmqpConnection,
  type PeerClose,
} from "@/lib/db/providers/stream/rabbitmq/amqp/connection";
import { dialAmqp } from "@/lib/db/providers/stream/rabbitmq/amqp/dial";
import type { FrameEvent } from "@/lib/db/providers/stream/rabbitmq/amqp/frame-reader";
import type { AmqpEndpoint } from "@/lib/db/providers/stream/rabbitmq/connection-options";
import {
  bytesOf,
  closeSteps,
  createManualClock,
  type FakePeer,
  handshakeSteps,
  type ManualClock,
  message,
  type PeerStep,
  type ReceivedFrame,
  serverFrames,
  startFakePeer,
  until,
} from "../../../../helpers/rabbitmq-fake-peer";

const secret = ["pa", "ss"].join("");
const peers: FakePeer[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.stop();
});

interface Harness {
  readonly peer: FakePeer;
  readonly connection: AmqpConnection;
  readonly clock: ManualClock;
  readonly deliveries: FrameEvent[];
  readonly closes: PeerClose[];
  readonly controller: AbortController;
  readonly methods: () => string[];
}

async function connect(
  steps: readonly PeerStep[] | ((socket: import("node:net").Socket) => void),
  onDelivery?: (event: FrameEvent) => void,
): Promise<Harness> {
  const peer = await startFakePeer(steps);
  peers.push(peer);
  const endpoint: AmqpEndpoint = {
    host: "127.0.0.1",
    port: peer.port,
    tls: null,
    username: "studio-reader",
    password: secret,
    display: `127.0.0.1:${peer.port}`,
  };
  const controller = new AbortController();
  const socket = await dialAmqp(endpoint, controller.signal);
  const clock = createManualClock();
  const deliveries: FrameEvent[] = [];
  const closes: PeerClose[] = [];
  const connection = createAmqpConnection({
    socket,
    endpoint,
    vhost: "billing",
    clock,
    signal: controller.signal,
    studioVersion: "9.9.9",
    onDelivery: onDelivery ?? ((event) => deliveries.push(event)),
    onPeerClose: (close) => closes.push(close),
  });
  const methods = () =>
    peer.received.map((frame) =>
      frame.type === 0 ? "header" : frame.type === 8 ? "heartbeat" : `${frame.classId}.${frame.methodId}`,
    );
  return { peer, connection, clock, deliveries, closes, controller, methods };
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

const frameOf = (h: Harness, classId: number, methodId: number): ReceivedFrame =>
  h.peer.received.find((frame) => frame.classId === classId && frame.methodId === methodId) as ReceivedFrame;
const argsView = (frame: ReceivedFrame) => new DataView(frame.payload.buffer, frame.payload.byteOffset + 4);
const tuneOk = (h: Harness) => {
  const view = argsView(frameOf(h, 10, 31));
  return { channelMax: view.getUint16(0), frameMax: view.getUint32(2), heartbeat: view.getUint16(6) };
};

function upTo(name: "tune" | "open-ok" | "consume", tune: Parameters<typeof serverFrames.tune>[0] = {}): PeerStep[] {
  const steps: PeerStep[] = [
    { expect: "protocol-header" },
    { send: serverFrames.connectionStart() },
    { expect: { classId: 10, methodId: 11 } },
    { send: serverFrames.tune(tune) },
    { expect: { classId: 10, methodId: 31 } },
    { expect: { classId: 10, methodId: 40 } },
  ];
  if (name === "tune") return steps;
  steps.push({ send: serverFrames.openOk() }, { expect: { classId: 20, methodId: 10 } });
  if (name === "open-ok") return steps;
  return [...handshakeSteps(tune)];
}

describe("negotiation", () => {
  test("the handshake sends exactly the allowed frames, in order, with the prefetch asked for", async () => {
    const h = await connect([...handshakeSteps(), ...closeSteps]);
    await h.connection.open(5);
    await h.connection.consume("st-orders", { kind: "keyword", value: "first" });
    expect(h.methods()).toEqual(["header", "10.11", "10.31", "10.40", "20.10", "60.10", "60.20"]);
    expect(argsView(frameOf(h, 60, 10)).getUint16(4)).toBe(5);
    expect(Buffer.from(frameOf(h, 10, 40).payload).includes(Buffer.from("\u0007billing"))).toBe(true);
    expect(Buffer.from(frameOf(h, 10, 11).payload).includes(Buffer.from("9.9.9"))).toBe(true);
    await h.connection.close();
    expect(h.methods().at(-1)).toBe("10.50");
  });

  const clamps: readonly (readonly [string, Parameters<typeof serverFrames.tune>[0], number, number])[] = [
    ["frame-max 0 becomes the ceiling", { frameMax: 0 }, 131_072, 0],
    ["a larger frame-max is clamped", { frameMax: 1_000_000 }, 131_072, 0],
    ["a smaller frame-max is kept", { frameMax: 65_536 }, 65_536, 0],
    ["exactly 8,192 is accepted", { frameMax: 8_192 }, 8_192, 0],
    ["a heartbeat above 60 s is clamped", { heartbeat: 600 }, 131_072, 60],
    ["a heartbeat is never raised", { heartbeat: 1 }, 131_072, 1],
  ];
  for (const [name, tune, frameMax, heartbeat] of clamps) {
    test(name, async () => {
      const h = await connect(upTo("tune", tune));
      void h.connection.open(1).catch(() => {});
      await until(() => h.peer.received.some((frame) => frame.classId === 10 && frame.methodId === 40), "open");
      expect(tuneOk(h)).toEqual({ channelMax: 1, frameMax, heartbeat });
      h.connection.drop();
    });
  }

  test("a frame-max below 8,192 is refused before tune-ok", async () => {
    const h = await connect(upTo("tune", { frameMax: 4_096 }));
    const error = await failureOf(h.connection.open(1));
    expect(error).toBeInstanceOf(AmqpFailure);
    expect((error as AmqpFailure).failure).toEqual({ kind: "frame-max", bytes: 4_096 });
    expect(h.methods()).toEqual(["header", "10.11"]);
  });

  test("PLAIN only, the 0-9 version only, and the locale en_US when offered or when the first one is too long", async () => {
    const noPlain = await connect([
      { expect: "protocol-header" },
      { send: serverFrames.connectionStart({ mechanisms: "EXTERNAL AMQPLAIN ANONYMOUS" }) },
    ]);
    expect(((await failureOf(noPlain.connection.open(1))) as AmqpFailure).failure).toEqual({ kind: "no-plain" });
    expect(noPlain.methods()).toEqual(["header"]);

    const oldVersion = await connect([
      { expect: "protocol-header" },
      { send: serverFrames.connectionStart({ minor: 8 }) },
    ]);
    expect(((await failureOf(oldVersion.connection.open(1))) as AmqpFailure).failure).toEqual({
      kind: "other-version",
    });

    for (const [locales, chosen] of [
      ["de_DE en_US", "en_US"],
      ["fr_FR", "fr_FR"],
      ["", "en_US"],
      // A first locale longer than a short string holds falls back to en_US instead of failing to encode start-ok.
      [`${"x".repeat(256)} fr_FR`, "en_US"],
    ] as const) {
      const h = await connect([{ expect: "protocol-header" }, { send: serverFrames.connectionStart({ locales }) }]);
      void h.connection.open(1).catch(() => {});
      await until(() => h.peer.received.length === 2, "start-ok");
      const payload = Buffer.from(frameOf(h, 10, 11).payload);
      expect(payload.subarray(payload.length - chosen.length).toString()).toBe(chosen);
      h.connection.drop();
    }
  });

  test("the first bytes of another protocol, a TLS alert, or anything else", async () => {
    for (const [bytes, protocol] of [
      [bytesOf("AMQP", 0, 1, 0, 0), "amqp"],
      [bytesOf(0x15, 0x03, 0x03, 0, 2, 2, 70), "tls"],
      [bytesOf("HTTP/1.1 400 Bad Request\r\n\r\n"), "other"],
    ] as const) {
      const h = await connect([{ expect: "protocol-header" }, { send: bytes }]);
      expect(((await failureOf(h.connection.open(1))) as AmqpFailure).failure).toEqual({ kind: "foreign", protocol });
    }
  });
});

describe("failures before consume-ok", () => {
  test("connection.close 403 after start-ok is answered with close-ok and fails with its code", async () => {
    const h = await connect([
      { expect: "protocol-header" },
      { send: serverFrames.connectionStart() },
      { expect: { classId: 10, methodId: 11 } },
      { send: serverFrames.connectionClose(403, "ACCESS_REFUSED - Login was refused", 0, 0) },
    ]);
    const error = (await failureOf(h.connection.open(1))) as AmqpFailure;
    expect(error.failure).toEqual({
      kind: "close",
      info: {
        replyCode: 403,
        replyText: "ACCESS_REFUSED - Login was refused",
        classId: 0,
        methodId: 0,
        scope: "connection",
      },
    });
    await until(() => h.methods().includes("10.51"), "close-ok");
  });

  test("channel.close 404 at consume is answered with channel close-ok and connection.close", async () => {
    const h = await connect([
      ...handshakeSteps().slice(0, -1),
      { send: serverFrames.channelClose(404, "NOT_FOUND - no queue", 60, 20) },
    ]);
    await h.connection.open(1);
    const error = (await failureOf(h.connection.consume("gone", { kind: "keyword", value: "last" }))) as AmqpFailure;
    expect(error.failure).toMatchObject({
      kind: "close",
      info: { replyCode: 404, scope: "channel", classId: 60, methodId: 20 },
    });
    await until(() => h.methods().includes("10.50"), "connection.close");
    expect(h.methods().slice(-2)).toEqual(["20.41", "10.50"]);
  });

  test("a delivery before consume-ok is a violation answered with 505", async () => {
    const h = await connect([
      ...handshakeSteps().slice(0, -1),
      { send: message({ deliveryTag: BigInt(1), offset: BigInt(0) }) },
    ]);
    await h.connection.open(1);
    const error = (await failureOf(h.connection.consume("s", { kind: "keyword", value: "first" }))) as AmqpFailure;
    expect(error.failure).toEqual({ kind: "violation", fact: "unexpected-frame" });
    await until(() => h.methods().at(-1) === "10.50", "close 505");
    expect(argsView(h.peer.received.at(-1) as ReceivedFrame).getUint16(0)).toBe(505);
  });

  test("a socket end before start, and a consume after a failure, reject with the failure", async () => {
    const h = await connect([{ expect: "protocol-header" }, { end: "close" }]);
    // Silent: the peer sent no byte, which on a TLS socket is the broker refusing Studio's certificate.
    expect(((await failureOf(h.connection.open(1))) as AmqpFailure).failure).toEqual({
      kind: "socket-end",
      silent: true,
    });
    expect(
      ((await failureOf(h.connection.consume("s", { kind: "keyword", value: "next" }))) as AmqpFailure).failure.kind,
    ).toBe("socket-end");
  });

  test("a consume the encoder refuses rejects with its error and destroys the socket", async () => {
    const h = await connect([...handshakeSteps().slice(0, -2)]);
    await h.connection.open(1);
    await expect(h.connection.consume("s", undefined as never)).rejects.toThrow(TypeError);
    await until(() => h.peer.openSockets() === 0, "socket closed");
  });

  test("blocked and unblocked are ignored", async () => {
    const h = await connect([
      { expect: "protocol-header" },
      { send: methodOnly(10, 60) },
      { send: methodOnly(10, 61) },
      { send: serverFrames.connectionStart({ mechanisms: "AMQPLAIN" }) },
    ]);
    expect(((await failureOf(h.connection.open(1))) as AmqpFailure).failure).toEqual({ kind: "no-plain" });
  });
});

function methodOnly(classId: number, methodId: number): Uint8Array {
  return bytesOf(1, 0, 0, 0, 0, 0, 4, classId >> 8, classId & 0xff, methodId >> 8, methodId & 0xff, 0xce);
}

describe("heartbeats on the injected clock", () => {
  test("a heartbeat is sent after half an interval without output; two silent intervals after open-ok end it", async () => {
    const h = await connect(upTo("open-ok", { heartbeat: 2 }));
    const opened = failureOf(h.connection.open(1));
    await until(() => h.methods().includes("20.10"), "channel.open");
    h.clock.advance(1_000);
    await until(() => h.methods().includes("heartbeat"), "a heartbeat");
    h.clock.advance(2_999);
    expect(h.peer.openSockets()).toBe(1);
    h.clock.advance(1);
    expect(((await opened) as AmqpFailure).failure).toEqual({ kind: "heartbeat-timeout" });
  });

  test("a heartbeat of 0 arms no timer", async () => {
    const h = await connect(upTo("open-ok"));
    void h.connection.open(1).catch(() => {});
    await until(() => h.methods().includes("20.10"), "channel.open");
    expect(h.clock.pending()).toBe(0);
    h.connection.drop();
  });
});

describe("after consume-ok", () => {
  async function reading(after: readonly PeerStep[], onDelivery?: (event: FrameEvent) => void): Promise<Harness> {
    const h = await connect([...handshakeSteps(), ...after], onDelivery);
    await h.connection.open(10);
    await h.connection.consume("st", { kind: "offset", value: BigInt(0) });
    return h;
  }

  test("deliveries reach the read loop, and an ack goes out with its tag", async () => {
    const h = await reading([
      { send: message({ deliveryTag: BigInt(3), offset: BigInt(0), body: bytesOf("hi") }) },
      { expect: { classId: 60, methodId: 80 } },
    ]);
    await until(() => h.deliveries.some((event) => event.type === "body"), "the body");
    h.connection.ack(BigInt(3));
    await until(() => h.methods().includes("60.80"), "the ack");
    expect(argsView(frameOf(h, 60, 80)).getBigUint64(0)).toBe(BigInt(3));
    expect(h.deliveries.map((event) => event.type)).toContain("header");
  });

  test("a server basic.cancel is answered with cancel-ok and reported", async () => {
    const h = await reading([{ send: serverFrames.basicCancel() }, { expect: { classId: 60, methodId: 31 } }]);
    await until(() => h.closes.length === 1, "the cancel");
    expect(h.closes).toEqual([{ kind: "cancel" }]);
  });

  test("a server connection.close is answered with close-ok and reported with its code", async () => {
    const h = await reading([{ send: serverFrames.connectionClose(320, "CONNECTION_FORCED", 0, 0) }]);
    await until(() => h.closes.length === 1, "the close");
    expect(h.closes[0]).toMatchObject({ kind: "close", info: { replyCode: 320, scope: "connection" } });
    await until(() => h.methods().includes("10.51"), "close-ok");
  });

  test("a socket end and a violation are reported; the violation is answered with 501", async () => {
    const ended = await reading([{ end: "close" }]);
    await until(() => ended.closes.length === 1, "the end");
    expect(ended.closes).toEqual([{ kind: "socket-end" }]);

    const broken = await reading([{ send: bytesOf(1, 0, 1, 0x7f, 0xff, 0xff, 0xf0) }]);
    await until(() => broken.closes.length === 1, "the violation");
    expect(broken.closes).toEqual([{ kind: "violation", fact: "frame-too-large" }]);
    await until(() => broken.methods().at(-1) === "10.50", "close 501");
    expect(argsView(broken.peer.received.at(-1) as ReceivedFrame).getUint16(0)).toBe(501);
  });

  test("a read loop that throws ends the read as a socket error, never an uncaught exception", async () => {
    const h = await reading([{ send: message({ deliveryTag: BigInt(1), offset: BigInt(0) }) }], () => {
      throw new TypeError("read loop");
    });
    await until(() => h.closes.length === 1, "the failure");
    expect(h.closes).toEqual([{ kind: "socket-error" }]);
  });

  test("close() waits for close-ok, and discards what arrives meanwhile, telling the read loop only its size", async () => {
    const h = await reading([
      { expect: { classId: 10, methodId: 50 } },
      { send: message({ deliveryTag: BigInt(9), offset: BigInt(9), body: bytesOf("late") }) },
      { send: serverFrames.closeOk() },
    ]);
    const before = h.deliveries.length;
    await h.connection.close();
    const meanwhile = h.deliveries.slice(before);
    expect(meanwhile.length).toBeGreaterThan(0);
    expect(meanwhile.map((event) => event.type)).toEqual(meanwhile.map(() => "inbound"));
    expect(h.closes).toEqual([]);
    await until(() => h.peer.openSockets() === 0, "socket closed");
  });

  test("close() gives up at the wait limit, on the signal, and at once on a destroyed connection", async () => {
    const silent = await reading([]);
    const closed = silent.connection.close();
    await until(() => silent.methods().includes("10.50"), "close sent");
    silent.clock.advance(999);
    expect(silent.peer.openSockets()).toBe(1);
    silent.clock.advance(1);
    await closed;
    await until(() => silent.peer.openSockets() === 0, "socket closed");

    const aborted = await reading([]);
    const pending = aborted.connection.close();
    aborted.controller.abort();
    await pending;

    const early = await reading([]);
    early.controller.abort();
    await early.connection.close();
    await early.connection.close();
  });

  test("drop() writes connection.close and destroys without waiting; a second drop does nothing", async () => {
    const h = await reading([]);
    h.connection.drop();
    h.connection.drop();
    h.connection.ack(BigInt(1));
    await until(() => h.peer.openSockets() === 0, "socket closed");
    expect(h.methods().at(-1)).toBe("10.50");
    expect(h.closes).toEqual([]);
  });

  test("a close from the broker while closing ends the close", async () => {
    const h = await reading([
      { expect: { classId: 10, methodId: 50 } },
      { send: serverFrames.connectionClose(541, "INTERNAL_ERROR") },
    ]);
    await h.connection.close();
    expect(h.closes).toEqual([]);
  });
});

test("connection.ts holds the provider's one socket write", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../../../../src/lib/db/providers/stream/rabbitmq/amqp/connection.ts"),
    "utf8",
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  expect(code.match(/\.write\(/g)).toHaveLength(1);
  expect(code).toMatch(
    /if \(!isAllowedOutbound\(frame\)\) throw[^;]*;\n\s*if \(socket\.destroyed\) return;\n\s*socket\.write\(frame\);/,
  );
});
