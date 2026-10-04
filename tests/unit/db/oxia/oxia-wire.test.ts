/**
 * The recorded wire below the Oxia adapter (SB3-5.5, SB1-5.5a, SB1-3.3 rule 1a, contract section 20.4).
 *
 * The replay half answers each call from a recorded or synthetic call and logs every open, call, cancel and close;
 * the recording half wraps a transport and writes what it carried in the same shape. The real adapter runs over the
 * replay in case 19. No gRPC package is imported here.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  GrpcCall,
  GrpcChannel,
  GrpcChannelConfig,
  GrpcServerStream,
  GrpcServerStreamLimits,
} from "@/lib/db/grpc/channel";
import type { GrpcTlsOptions } from "@/lib/db/grpc/tls";
import { buildOxiaConnectionOptions } from "@/lib/db/providers/keyvalue/oxia/connection-options";
import {
  allowlistedServices,
  createGrpcOxiaClient,
  type OxiaWireTransport,
} from "@/lib/db/providers/keyvalue/oxia/grpc-client";
import { oxiaConnection } from "../../../helpers/oxia-connection";
import {
  loadOxiaCapture,
  type OxiaCapture,
  type RecordedCall,
  recordedOxiaWire,
  recordingOxiaWire,
  serializeOxiaCapture,
  syntheticCall,
  syntheticCapture,
} from "../../../helpers/oxia-wire";

type WireMethod = Parameters<GrpcChannel["unary"]>[0];

const { client: CLIENT, health: HEALTH } = allowlistedServices();
const LIST = CLIENT.List as WireMethod;
const READ = CLIENT.Read as WireMethod;
const CHECK = HEALTH.Check as WireMethod;
const TARGET = "127.0.0.1:6648";
const OK_END: RecordedCall["end"] = { kind: "status", code: 0, details: "" };
const OPEN_END: RecordedCall["end"] = { kind: "open" };

const config = (overrides: Partial<GrpcChannelConfig> = {}): GrpcChannelConfig => ({
  target: `dns:${TARGET}`,
  receiveCapBytes: 16 * 1024 * 1024,
  retries: "none",
  unsent: (status) => status,
  ...overrides,
});
const call = (overrides: Partial<GrpcCall> = {}): GrpcCall => ({
  metadata: {},
  deadline: new Date(Date.now() + 5_000),
  signal: new AbortController().signal,
  ...overrides,
});
const LIMITS: GrpcServerStreamLimits = { maxReceivedBytes: 16 * 1024 * 1024 };
const listRequest = (shard: string) => ({
  shard,
  start_inclusive: "",
  end_exclusive: "",
  include_internal_keys: false,
});
const listed = (shard: string, keys: string[][], end: RecordedCall["end"] = OK_END) =>
  syntheticCall({
    target: TARGET,
    method: "io.oxia.proto.v1.OxiaClient/List",
    request: listRequest(shard),
    messages: keys.map((k) => ({ keys: k })),
    end,
  });
const tlsFor = (identity: string, extra: Partial<GrpcTlsOptions> = {}): GrpcTlsOptions => ({
  mode: "verify-full",
  verify: true,
  identity,
  identityIsIp: false,
  serverNameOverride: identity,
  ...extra,
});

/** Every message a stream answers until `undefined`. */
async function drain(stream: GrpcServerStream): Promise<object[]> {
  const messages: object[] = [];
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one reader takes the stream's messages in order.
    const message = await stream.read();
    if (message === undefined) return messages;
    messages.push(message);
  }
}

const PENDING = Symbol("pending");
/** The promise's outcome, or PENDING when it has not settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof PENDING> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<typeof PENDING>((resolve) => {
    timer = setTimeout(() => resolve(PENDING), ms);
  });
  try {
    return await Promise.race([promise, pending]);
  } finally {
    clearTimeout(timer);
  }
}

async function rejection(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error("expected a rejection");
}

/** One scripted answer of the hand-made inner transport: messages, then the end or an error. */
interface Scripted {
  readonly messages: readonly object[];
  readonly error?: Error;
}

/** A hand-made `OxiaWireTransport` whose n-th call answers the n-th script. */
function scriptedTransport(scripts: readonly Scripted[]): OxiaWireTransport {
  let next = 0;
  const take = (): Scripted => scripts[next++] as Scripted;
  return {
    channel: () => ({
      unary: async () => {
        const script = take();
        if (script.error !== undefined) throw script.error;
        return script.messages[0] as object;
      },
      bidiStream: () => {
        throw new Error("no bidi");
      },
      serverStream: () => {
        const script = take();
        let index = 0;
        let truncated = false;
        return {
          read: async () => {
            if (truncated) return undefined;
            if (index < script.messages.length) return script.messages[index++];
            if (script.error !== undefined) throw script.error;
            return undefined;
          },
          receivedBytes: 0,
          get truncated() {
            return truncated;
          },
          cancel: () => {
            truncated = true;
          },
        };
      },
      close: () => {},
    }),
  };
}

const notFound = () => Object.assign(new Error("x"), { code: 5, details: "not found", metadata: { get: () => [] } });

describe("recordedOxiaWire", () => {
  test("1: a call is answered by the recorded call of its target, method and request", async () => {
    const wire = recordedOxiaWire([syntheticCapture([listed("0", [["a"]]), listed("1", [["b", "c"], ["d"]])])]);
    const stream = wire.transport.channel(TARGET, config()).serverStream(LIST, listRequest("1"), call(), LIMITS);
    expect(await stream.read()).toEqual({ keys: ["b", "c"] });
    expect(await stream.read()).toEqual({ keys: ["d"] });
    expect(await stream.read()).toBeUndefined();
    expect(stream.truncated).toBe(false);
  });

  test("2: the request is matched canonically", async () => {
    const recorded = syntheticCall({
      target: TARGET,
      method: "io.oxia.proto.v1.OxiaClient/Read",
      request: {
        gets: [{ key: "/a", include_value: true, comparison_type: "EQUAL" }],
        blob: Buffer.from("ab"),
        shard: "0",
      },
      messages: [{ gets: [] }],
      end: OK_END,
    });
    const wire = recordedOxiaWire([syntheticCapture([recorded])]);
    const request = {
      shard: "0",
      blob: new Uint8Array([97, 98]),
      gets: [{ comparison_type: "EQUAL", include_value: true, key: "/a" }],
    };
    const stream = wire.transport.channel(TARGET, config()).serverStream(READ, request, call(), LIMITS);
    expect(await drain(stream)).toEqual([{ gets: [] }]);
    expect(wire.unmatched()).toEqual([]);
  });

  test("3: every open and every call is logged, with the TLS identity and whether the token went", async () => {
    const wire = recordedOxiaWire([syntheticCapture([listed("0", [["a"]])])]);
    const secure = wire.transport.channel(TARGET, config({ tls: tlsFor("oxia-1.internal", { ca: "CANARY-CA" }) }));
    wire.transport.channel(TARGET, config());
    await drain(
      secure.serverStream(LIST, listRequest("0"), call({ metadata: { authorization: "Bearer CANARY" } }), LIMITS),
    );
    await drain(secure.serverStream(LIST, listRequest("0"), call(), LIMITS));
    await drain(
      secure.serverStream(LIST, listRequest("0"), call({ metadata: { Authorization: "Bearer CANARY" } }), LIMITS),
    );
    expect(wire.log).toHaveLength(5);
    expect(wire.log[4]).toMatchObject({ kind: "call", token: true });
    expect(wire.log.slice(0, 4)).toEqual([
      { kind: "open", target: TARGET, tls: { mode: "verify-full", identity: "oxia-1.internal" } },
      { kind: "open", target: TARGET, tls: { mode: "disable" } },
      {
        kind: "call",
        target: TARGET,
        authority: TARGET,
        method: "io.oxia.proto.v1.OxiaClient/List",
        request: listRequest("0"),
        token: true,
      },
      {
        kind: "call",
        target: TARGET,
        authority: TARGET,
        method: "io.oxia.proto.v1.OxiaClient/List",
        request: listRequest("0"),
        token: false,
      },
    ]);
    expect(JSON.stringify(wire.log)).not.toContain("CANARY");
  });

  test("4: a call nothing matches fails and is listed", async () => {
    const wire = recordedOxiaWire([syntheticCapture([listed("0", [["a"]])])]);
    const stream = wire.transport.channel(TARGET, config()).serverStream(LIST, listRequest("9"), call(), LIMITS);
    const error = await rejection(stream.read());
    expect(error.message).toContain("io.oxia.proto.v1.OxiaClient/List");
    expect(error.message).toContain(TARGET);
    expect(error.message).toContain('"shard":"9"');
    expect(error.message.startsWith("oxia-wire: no recorded call for ")).toBe(true);
    expect(wire.unmatched()).toEqual([
      { target: TARGET, method: "io.oxia.proto.v1.OxiaClient/List", request: listRequest("9") },
    ]);
    expect(wire.log.at(-1)).toMatchObject({ kind: "call", request: listRequest("9") });
  });

  test("5: a method outside the allowlist is never answered", async () => {
    const write = { ...LIST, path: "/io.oxia.proto.v1.OxiaClient/Write" } as WireMethod;
    const recorded = {
      ...listed("0", [["a"]]),
      method: "io.oxia.proto.v1.OxiaClient/Write",
    } as unknown as RecordedCall;
    const wire = recordedOxiaWire([syntheticCapture([recorded])]);
    const stream = wire.transport.channel(TARGET, config()).serverStream(write, listRequest("0"), call(), LIMITS);
    await expect(stream.read()).rejects.toThrow("oxia-wire: no recorded call for io.oxia.proto.v1.OxiaClient/Write");
    expect(wire.unmatched()).toHaveLength(1);
  });

  test("6: unused lists the recorded calls nobody took", async () => {
    const first = listed("0", [["a"]]);
    const second = listed("1", [["b"]]);
    const wire = recordedOxiaWire([syntheticCapture([first]), syntheticCapture([second])]);
    const channel = wire.transport.channel(TARGET, config());
    await drain(channel.serverStream(LIST, listRequest("0"), call(), LIMITS));
    expect(wire.unused()).toEqual([second]);
    await drain(channel.serverStream(LIST, listRequest("1"), call(), LIMITS));
    expect(wire.unused()).toEqual([]);
  });

  test("7: recorded calls with one key answer in order, and the last one again", async () => {
    const wire = recordedOxiaWire([syntheticCapture([listed("0", [["first"]]), listed("0", [["second"]])])]);
    const channel = wire.transport.channel(TARGET, config());
    const read = () => drain(channel.serverStream(LIST, listRequest("0"), call(), LIMITS));
    expect(await read()).toEqual([{ keys: ["first"] }]);
    expect(await read()).toEqual([{ keys: ["second"] }]);
    expect(await read()).toEqual([{ keys: ["second"] }]);
    expect(wire.unused()).toEqual([]);
  });

  test("8: a stream honours its byte limit as the real one does", async () => {
    const recorded = syntheticCall({
      ...listed("0", [["a"], ["b"], ["c"], ["d"]]),
      messageBytes: [400, 400, 400, 400],
    });
    const wire = recordedOxiaWire([syntheticCapture([recorded])]);
    const stream = wire.transport
      .channel(TARGET, config())
      .serverStream(LIST, listRequest("0"), call(), { maxReceivedBytes: 1000 });
    expect(await drain(stream)).toEqual([{ keys: ["a"] }, { keys: ["b"] }, { keys: ["c"] }]);
    expect(stream.truncated).toBe(true);
    expect(stream.receivedBytes).toBe(1200);
    expect(wire.log.at(-1)).toEqual({
      kind: "cancel",
      target: TARGET,
      method: "io.oxia.proto.v1.OxiaClient/List",
      afterMessages: 3,
    });
  });

  test("8a: a message that reaches the byte limit exactly is the last one delivered", async () => {
    const recorded = syntheticCall({
      ...listed("0", [["a"], ["b"], ["c"]]),
      messageBytes: [400, 400, 400],
    });
    const wire = recordedOxiaWire([syntheticCapture([recorded])]);
    const stream = wire.transport
      .channel(TARGET, config())
      .serverStream(LIST, listRequest("0"), call(), { maxReceivedBytes: 800 });
    expect(await drain(stream)).toEqual([{ keys: ["a"] }, { keys: ["b"] }]);
    expect(stream.truncated).toBe(true);
    expect(stream.receivedBytes).toBe(800);
    expect(wire.log.at(-1)).toMatchObject({ kind: "cancel", afterMessages: 2 });
  });

  test("8b: a cancel after the server's end logs nothing and leaves truncated false", async () => {
    const wire = recordedOxiaWire([syntheticCapture([listed("0", [["a"]])])]);
    const stream = wire.transport.channel(TARGET, config()).serverStream(LIST, listRequest("0"), call(), LIMITS);
    expect(await drain(stream)).toEqual([{ keys: ["a"] }]);
    stream.cancel();
    expect(stream.truncated).toBe(false);
    expect(await stream.read()).toBeUndefined();
    expect(wire.log.map((event) => event.kind)).toEqual(["open", "call"]);
  });

  test("9: syntheticCall measures a message by its JSON length when none is given", () => {
    const made = syntheticCall({
      target: TARGET,
      method: "io.oxia.proto.v1.OxiaClient/List",
      request: listRequest("0"),
      messages: [{ keys: ["a", "bc"] }, { z: 1, a: "é" }],
      end: OK_END,
    });
    expect(made.messageBytes).toEqual([
      Buffer.byteLength(JSON.stringify({ keys: ["a", "bc"] })),
      Buffer.byteLength(JSON.stringify({ a: "é", z: 1 })),
    ]);
    expect(made.authority).toBe(TARGET);
    const given = syntheticCall({ ...made, authority: "other:1", messageBytes: [7, 9] });
    expect(given.messageBytes).toEqual([7, 9]);
    expect(given.authority).toBe("other:1");
  });

  test("10: cancel is logged with the count delivered, once", async () => {
    const wire = recordedOxiaWire([syntheticCapture([listed("0", [["a"], ["b"], ["c"]])])]);
    const stream = wire.transport.channel(TARGET, config()).serverStream(LIST, listRequest("0"), call(), LIMITS);
    expect(await stream.read()).toEqual({ keys: ["a"] });
    stream.cancel();
    stream.cancel();
    expect(await stream.read()).toBeUndefined();
    expect(await stream.read()).toBeUndefined();
    expect(stream.truncated).toBe(true);
    const cancels = wire.log.filter((event) => event.kind === "cancel");
    expect(cancels).toEqual([
      { kind: "cancel", target: TARGET, method: "io.oxia.proto.v1.OxiaClient/List", afterMessages: 1 },
    ]);
  });

  test("11: a status end rejects after its messages", async () => {
    const end: RecordedCall["end"] = { kind: "status", code: 8, details: "received message larger than max" };
    const wire = recordedOxiaWire([syntheticCapture([listed("0", [["a"]], end)])]);
    const stream = wire.transport.channel(TARGET, config()).serverStream(LIST, listRequest("0"), call(), LIMITS);
    expect(await stream.read()).toEqual({ keys: ["a"] });
    const error = await rejection(stream.read());
    expect(error.code).toBe(8);
    expect(error.details).toBe("received message larger than max");
    expect(error.message).toBe("received message larger than max");
    expect(stream.truncated).toBe(false);
  });

  test("12: errorInfo travels as the status details trailer", async () => {
    const errorInfo = Buffer.from("ei").toString("base64");
    const wire = recordedOxiaWire([
      syntheticCapture([
        listed("0", [], { kind: "status", code: 9, details: "x", errorInfo }),
        listed("1", [], { kind: "status", code: 9, details: "y" }),
      ]),
    ]);
    const channel = wire.transport.channel(TARGET, config());
    const error = await rejection(channel.serverStream(LIST, listRequest("0"), call(), LIMITS).read());
    const metadata = error.metadata as { get(key: string): unknown[] };
    expect(metadata.get("grpc-status-details-bin")[0]).toEqual(Buffer.from("ei"));
    expect(metadata.get("other")).toEqual([]);
    const bare = await rejection(channel.serverStream(LIST, listRequest("1"), call(), LIMITS).read());
    expect((bare.metadata as { get(key: string): unknown[] }).get("grpc-status-details-bin")).toEqual([]);
  });

  test("13: an open end never ends, until the deadline", async () => {
    const wire = recordedOxiaWire([syntheticCapture([listed("0", [], OPEN_END)])]);
    const stream = wire.transport
      .channel(TARGET, config())
      .serverStream(LIST, listRequest("0"), call({ deadline: new Date(Date.now() + 60) }), LIMITS);
    const read = stream.read();
    expect(await within(read, 20)).toBe(PENDING);
    const error = await rejection(read);
    expect(error.code).toBe(4);
    expect(error.details).toBe("Deadline exceeded");
    expect((await rejection(stream.read())).code).toBe(4);
  });

  test("14: an abort rejects a pending read", async () => {
    const wire = recordedOxiaWire([syntheticCapture([listed("0", [["a"]], OPEN_END)])]);
    const controller = new AbortController();
    const stream = wire.transport
      .channel(TARGET, config())
      .serverStream(LIST, listRequest("0"), call({ signal: controller.signal }), LIMITS);
    expect(await stream.read()).toEqual({ keys: ["a"] });
    const read = stream.read();
    controller.abort();
    expect((await rejection(read)).code).toBe(1);
    expect((await rejection(stream.read())).code).toBe(1);
    expect(wire.log.filter((event) => event.kind === "cancel")).toEqual([
      { kind: "cancel", target: TARGET, method: "io.oxia.proto.v1.OxiaClient/List", afterMessages: 1 },
    ]);
  });

  test("14a: a signal aborted before the call rejects its first read", async () => {
    const wire = recordedOxiaWire([syntheticCapture([listed("0", [["a"]])])]);
    const stream = wire.transport
      .channel(TARGET, config())
      .serverStream(LIST, listRequest("0"), call({ signal: AbortSignal.abort() }), LIMITS);
    expect((await rejection(stream.read())).code).toBe(1);
    expect(wire.log.at(-1)).toMatchObject({ kind: "cancel", afterMessages: 0 });
  });

  test("15: close ends the channel's streams and is logged", async () => {
    const wire = recordedOxiaWire([syntheticCapture([listed("0", [], OPEN_END)])]);
    const channel = wire.transport.channel(TARGET, config());
    const read = channel.serverStream(LIST, listRequest("0"), call(), LIMITS).read();
    channel.close();
    expect((await rejection(read)).code).toBe(1);
    expect(wire.log.at(-2)).toMatchObject({ kind: "cancel", afterMessages: 0 });
    expect(wire.log.at(-1)).toEqual({ kind: "close", target: TARGET });
  });

  test("16: a unary call resolves its one message", async () => {
    const check = (end: RecordedCall["end"], messages: unknown[] = []) =>
      syntheticCall({ target: TARGET, method: "grpc.health.v1.Health/Check", request: { service: "" }, messages, end });
    const serving = recordedOxiaWire([syntheticCapture([check(OK_END, [{ status: "SERVING" }])])]);
    expect(await serving.transport.channel(TARGET, config()).unary(CHECK, { service: "" }, call())).toEqual({
      status: "SERVING",
    });
    expect(serving.log.at(-1)).toMatchObject({ kind: "call", method: "grpc.health.v1.Health/Check" });

    const failing = recordedOxiaWire([syntheticCapture([check({ kind: "status", code: 16, details: "no" })])]);
    const error = await rejection(failing.transport.channel(TARGET, config()).unary(CHECK, { service: "" }, call()));
    expect(error.code).toBe(16);

    const unmatched = recordedOxiaWire([]);
    await expect(unmatched.transport.channel(TARGET, config()).unary(CHECK, { service: "" }, call())).rejects.toThrow(
      "oxia-wire: no recorded call for grpc.health.v1.Health/Check on 127.0.0.1:6648",
    );

    const silent = recordedOxiaWire([syntheticCapture([check(OPEN_END)])]);
    const controller = new AbortController();
    const pending = silent.transport
      .channel(TARGET, config())
      .unary(CHECK, { service: "" }, call({ signal: controller.signal }));
    expect(await within(pending, 10)).toBe(PENDING);
    controller.abort();
    expect((await rejection(pending)).code).toBe(1);
    expect(silent.log.at(-1)).toMatchObject({ kind: "cancel", afterMessages: 0 });

    const late = recordedOxiaWire([syntheticCapture([check(OPEN_END)])]);
    const timed = late.transport
      .channel(TARGET, config())
      .unary(CHECK, { service: "" }, call({ deadline: new Date(Date.now() + 10) }));
    expect((await rejection(timed)).code).toBe(4);
  });

  test("17: bidiStream throws", () => {
    const channel = recordedOxiaWire([]).transport.channel(TARGET, config());
    expect(() => channel.bidiStream(LIST, call())).toThrow("oxia-wire: the Oxia adapter opens no bidirectional stream");
  });

  test("18: a byte limit that is not a whole positive number throws", () => {
    const channel = recordedOxiaWire([syntheticCapture([listed("0", [])])]).transport.channel(TARGET, config());
    for (const maxReceivedBytes of [0, -1, 1.5, Number.NaN]) {
      expect(() => channel.serverStream(LIST, listRequest("0"), call(), { maxReceivedBytes })).toThrow(RangeError);
    }
  });

  test("19: the real adapter runs over the wire: one channel, the first message, then a cancel", async () => {
    const assignments = syntheticCall({
      target: "localhost:6648",
      method: "io.oxia.proto.v1.OxiaClient/GetShardAssignments",
      request: { namespace: "default" },
      messages: [
        {
          namespaces: {
            default: {
              assignments: [
                {
                  shard: "0",
                  leader: "localhost:6648",
                  int32_hash_range: { min_hash_inclusive: 0, max_hash_inclusive: 4294967295 },
                },
              ],
              shard_key_router: "XXHASH3",
            },
          },
        },
      ],
      end: { kind: "open" },
    });
    const wire = recordedOxiaWire([syntheticCapture([assignments])]);
    const options = buildOxiaConnectionOptions(oxiaConnection(), { executionReadOnly: false, queryTimeout: 5_000 });
    const client = createGrpcOxiaClient(options, wire.transport);
    const snapshot = await client.getSnapshot({ signal: new AbortController().signal, deadline: Date.now() + 5_000 });
    client.close();

    expect(snapshot.shards.map((shard) => shard.leader.address)).toEqual(["localhost:6648"]);
    expect(wire.log.map((event) => event.kind)).toEqual(["open", "call", "cancel", "close"]);
    expect(wire.log[1]).toMatchObject({ target: "localhost:6648", authority: "localhost:6648", token: false });
    expect(wire.log[2]).toMatchObject({ afterMessages: 1 });
    expect(wire.unmatched()).toEqual([]);
    expect(wire.unused()).toEqual([]);
  });
});

describe("recordingOxiaWire", () => {
  test("20: the recorder writes what a transport carried, and the replay answers from it", async () => {
    const first = [{ keys: ["a", "b"] }, { keys: ["c"] }];
    const recorder = recordingOxiaWire(
      scriptedTransport([
        { messages: first },
        { messages: [], error: notFound() },
        { messages: [{ keys: ["x"] }, { keys: ["y"] }] },
      ]),
    );
    const channel = recorder.transport.channel(TARGET, config());
    const one = channel.serverStream(LIST, listRequest("0"), call(), LIMITS);
    expect(await drain(one)).toEqual(first);
    expect(one.receivedBytes).toBe(0);
    expect(one.truncated).toBe(false);
    const two = channel.serverStream(LIST, listRequest("1"), call(), LIMITS);
    const error = await rejection(two.read());
    expect(error.details).toBe("not found");
    const three = channel.serverStream(LIST, listRequest("2"), call(), LIMITS);
    expect(await three.read()).toEqual({ keys: ["x"] });
    three.cancel();
    expect(() => channel.bidiStream(LIST, call())).toThrow("no bidi");
    channel.close();

    const capture = recorder.capture("0.16.10/list-test.json");
    expect(capture.file).toBe("0.16.10/list-test.json");
    expect(capture.calls).toHaveLength(3);
    expect(capture.calls[0]).toMatchObject({
      target: TARGET,
      authority: TARGET,
      method: "io.oxia.proto.v1.OxiaClient/List",
      request: listRequest("0"),
      messages: first,
      messageBytes: first.map((message) => LIST.responseSerialize(message).length),
      end: OK_END,
      token: false,
      tls: { mode: "disable" },
    });
    expect(capture.calls[1]?.end).toEqual({ kind: "status", code: 5, details: "not found" });
    expect(capture.calls[2]).toMatchObject({ messages: [{ keys: ["x"] }], end: OPEN_END });
    expect(capture.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(capture.sha256).toBe(
      createHash("sha256")
        .update(serializeOxiaCapture({ file: capture.file, calls: capture.calls }))
        .digest("hex"),
    );

    const wire = recordedOxiaWire([capture]);
    const replayed = wire.transport.channel(TARGET, config()).serverStream(LIST, listRequest("0"), call(), LIMITS);
    expect(await drain(replayed)).toEqual(first);
  });

  test("20a: a unary call, a truncated stream, a status details trailer and a call left open are recorded", async () => {
    const errorInfo = Buffer.from("info");
    const failed = Object.assign(new Error("y"), {
      code: 7,
      details: "denied",
      metadata: { get: (key: string) => (key === "grpc-status-details-bin" ? [errorInfo] : []) },
    });
    let truncated = false;
    const inner: OxiaWireTransport = {
      channel: () => ({
        unary: async (_method, request) => {
          if ((request as { service: string }).service === "") return { status: "SERVING" };
          throw failed;
        },
        bidiStream: () => {
          throw new Error("no bidi");
        },
        serverStream: () => ({
          read: async () => {
            if (truncated) return undefined;
            truncated = true;
            return { keys: ["only"] };
          },
          receivedBytes: 5,
          get truncated() {
            return truncated;
          },
          cancel: () => {},
        }),
        close: () => {},
      }),
    };
    const recorder = recordingOxiaWire(inner);
    const channel = recorder.transport.channel(TARGET, config({ tls: tlsFor("oxia-1.internal") }));
    expect(await channel.unary(CHECK, { service: "" }, call())).toEqual({ status: "SERVING" });
    expect((await rejection(channel.unary(CHECK, { service: "other" }, call()))) as unknown).toBe(failed);
    const stream = channel.serverStream(LIST, listRequest("0"), call(), LIMITS);
    expect(await drain(stream)).toEqual([{ keys: ["only"] }]);
    expect(stream.receivedBytes).toBe(5);
    channel.serverStream(LIST, listRequest("1"), call(), LIMITS);

    const capture = recorder.capture("x.json");
    expect(capture.calls.map((recorded) => recorded.end)).toEqual([
      OK_END,
      { kind: "status", code: 7, details: "denied", errorInfo: errorInfo.toString("base64") },
      OPEN_END,
      OPEN_END,
    ]);
    expect(capture.calls[0]).toMatchObject({
      method: "grpc.health.v1.Health/Check",
      messages: [{ status: "SERVING" }],
      messageBytes: [CHECK.responseSerialize({ status: "SERVING" }).length],
      tls: { mode: "verify-full", identity: "oxia-1.internal" },
    });
    expect(capture.calls[3]?.messages).toEqual([]);
  });

  test("21: serializeOxiaCapture is stable and carries no key material", async () => {
    const recorder = recordingOxiaWire(scriptedTransport([{ messages: [{ keys: ["a"] }] }]));
    const tls = tlsFor("oxia-1.internal", {
      ca: "CANARY-CA",
      clientCertificate: { cert: "CANARY-KEY", key: "CANARY-KEY" },
    });
    const channel = recorder.transport.channel(TARGET, config({ tls }));
    await drain(
      channel.serverStream(
        LIST,
        listRequest("0"),
        call({ metadata: { authorization: "Bearer CANARY-TOKEN" } }),
        LIMITS,
      ),
    );
    const capture = recorder.capture("tls.json");
    const text = serializeOxiaCapture(capture);
    expect(serializeOxiaCapture(capture)).toBe(text);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).not.toContain("\r");
    for (const canary of ["CANARY-CA", "CANARY-KEY", "CANARY-TOKEN"]) expect(text).not.toContain(canary);
    expect(text).toContain('"token": true');
    expect(JSON.parse(text).calls[0].tls).toEqual({ identity: "oxia-1.internal", mode: "verify-full" });
    expect(Object.keys(JSON.parse(text))).toEqual(["calls", "file"]);

    const withBytes = serializeOxiaCapture(
      syntheticCapture([{ ...listed("0", []), messages: [{ value: Buffer.from("hi") }] }]),
    );
    expect(withBytes).toContain(`"$bytes": "${Buffer.from("hi").toString("base64")}"`);
    expect(withBytes).toContain('"file": "synthetic"');
  });

  test("21a: filled bytes are written as their length and value, and revived", () => {
    const filled = Buffer.alloc(65_536, 0x78);
    const valueCall = (value: Uint8Array) =>
      syntheticCall({
        target: TARGET,
        method: "io.oxia.proto.v1.OxiaClient/RangeScan",
        request: listRequest("0"),
        messages: [{ records: [{ value }] }],
        end: OK_END,
      });
    const text = serializeOxiaCapture(syntheticCapture([valueCall(filled)]));
    expect(text).toContain('"$filled"');
    expect(text).not.toContain('"$bytes"');
    expect(JSON.stringify(JSON.parse(text).calls[0].messages[0]).length).toBeLessThan(400);
    expect(text.length).toBeLessThan(2_000);

    const short = serializeOxiaCapture(syntheticCapture([valueCall(Buffer.alloc(65_535, 0x78))]));
    expect(short).toContain('"$bytes"');
    expect(short).not.toContain('"$filled"');
    const mixed = Buffer.alloc(65_536, 0x78);
    mixed[65_535] = 0x79;
    const twoValues = serializeOxiaCapture(syntheticCapture([valueCall(mixed)]));
    expect(twoValues).toContain('"$bytes"');
    expect(twoValues).not.toContain('"$filled"');

    const directory = mkdtempSync(path.join(tmpdir(), "oxia-wire-"));
    try {
      writeFileSync(path.join(directory, "filled.json"), text);
      const digest = createHash("sha256").update(text).digest("hex");
      writeFileSync(path.join(directory, "README.md"), `| File | SHA-256 |\n|---|---|\n| filled.json | ${digest} |\n`);
      const loaded = loadOxiaCapture("filled.json", directory);
      const value = ((loaded.calls[0] as RecordedCall).messages[0] as { records: { value: Buffer }[] }).records[0]
        ?.value;
      expect(Buffer.isBuffer(value)).toBe(true);
      expect(value?.equals(filled)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("21b: the recorder drops a call it already recorded with the same answer, and keeps a capture's result", async () => {
    const same = recordingOxiaWire(
      scriptedTransport([{ messages: [{ keys: ["a"] }] }, { messages: [{ keys: ["a"] }] }]),
    );
    const sameChannel = same.transport.channel(TARGET, config());
    await drain(sameChannel.serverStream(LIST, listRequest("0"), call(), LIMITS));
    await drain(sameChannel.serverStream(LIST, listRequest("0"), call(), LIMITS));
    expect(same.capture("x.json").calls).toHaveLength(1);

    const differ = recordingOxiaWire(
      scriptedTransport([{ messages: [{ keys: ["a"] }] }, { messages: [{ keys: ["b"] }] }]),
    );
    const differChannel = differ.transport.channel(TARGET, config());
    await drain(differChannel.serverStream(LIST, listRequest("0"), call(), LIMITS));
    await drain(differChannel.serverStream(LIST, listRequest("0"), call(), LIMITS));
    const both = differ.capture("x.json", { rows: 1 });
    expect(both.calls.map((recorded) => recorded.messages)).toEqual([[{ keys: ["a"] }], [{ keys: ["b"] }]]);
    expect(both.result).toEqual({ rows: 1 });
    const text = serializeOxiaCapture(both);
    expect(JSON.parse(text).result).toEqual({ rows: 1 });
    expect(both.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect("result" in differ.capture("x.json")).toBe(false);
  });

  test("21c: the recorder keeps calls that differ only by request or only by end", async () => {
    const recorder = recordingOxiaWire(
      scriptedTransport([
        { messages: [{ keys: ["a"] }] },
        { messages: [{ keys: ["a"] }] },
        { messages: [{ keys: ["a"] }], error: notFound() },
      ]),
    );
    const channel = recorder.transport.channel(TARGET, config());
    await drain(channel.serverStream(LIST, listRequest("0"), call(), LIMITS));
    await drain(channel.serverStream(LIST, listRequest("1"), call(), LIMITS));
    const failing = channel.serverStream(LIST, listRequest("0"), call(), LIMITS);
    expect(await failing.read()).toEqual({ keys: ["a"] });
    expect((await rejection(failing.read())).code).toBe(5);
    const calls = recorder.capture("x.json").calls;
    expect(calls.map((recorded) => [recorded.request, recorded.end])).toEqual([
      [listRequest("0"), OK_END],
      [listRequest("1"), OK_END],
      [listRequest("0"), { kind: "status", code: 5, details: "not found" }],
    ]);
  });

  test("21d: a cancel after the server's end keeps the recorded status", async () => {
    const recorder = recordingOxiaWire(
      scriptedTransport([{ messages: [{ keys: ["a"] }] }, { messages: [], error: notFound() }]),
    );
    const channel = recorder.transport.channel(TARGET, config());
    const ended = channel.serverStream(LIST, listRequest("0"), call(), LIMITS);
    await drain(ended);
    ended.cancel();
    const failed = channel.serverStream(LIST, listRequest("1"), call(), LIMITS);
    await rejection(failed.read());
    failed.cancel();
    expect(recorder.capture("x.json").calls.map((recorded) => recorded.end)).toEqual([
      OK_END,
      { kind: "status", code: 5, details: "not found" },
    ]);
  });
});

describe("loadOxiaCapture", () => {
  test("22: loadOxiaCapture holds a capture to the digest its README records", () => {
    const capture: Omit<OxiaCapture, "sha256"> = {
      file: "0.16.10/list.json",
      calls: [{ ...listed("0", []), messages: [{ value: Buffer.from("hi") }] }],
    };
    const text = serializeOxiaCapture(capture);
    const digest = createHash("sha256").update(text).digest("hex");
    const directory = mkdtempSync(path.join(tmpdir(), "oxia-wire-"));
    const readme = path.join(directory, "README.md");
    try {
      const file = path.join(directory, "0.16.10", "list.json");
      mkdirSync(path.dirname(file));
      writeFileSync(file, text);
      writeFileSync(
        readme,
        `| File | SHA-256 |\n|---|---|\n| other.json | ${"0".repeat(64)} |\n| 0.16.10/list.json | ${digest} |\n`,
      );

      const loaded = loadOxiaCapture("0.16.10/list.json", directory);
      expect(loaded.sha256).toBe(digest);
      expect(loaded.file).toBe("0.16.10/list.json");
      const value = ((loaded.calls[0] as RecordedCall).messages[0] as { value: Buffer }).value;
      expect(Buffer.isBuffer(value)).toBe(true);
      expect(value.toString()).toBe("hi");
      expect(loaded.calls[0]?.request).toEqual(listRequest("0"));

      writeFileSync(file, text.replace('"hi"', '"ho"').replace("aGk=", "aG8="));
      expect(readFileSync(file, "utf8")).not.toBe(text);
      expect(() => loadOxiaCapture("0.16.10/list.json", directory)).toThrow(
        "oxia-wire: 0.16.10/list.json does not match the digest README.md records",
      );

      writeFileSync(readme, `| File | SHA-256 |\n|---|---|\n| other.json | ${digest} |\n`);
      expect(() => loadOxiaCapture("0.16.10/list.json", directory)).toThrow(
        "oxia-wire: 0.16.10/list.json is not in tests/fixtures/oxia/README.md",
      );
      rmSync(readme);
      expect(() => loadOxiaCapture("0.16.10/list.json", directory)).toThrow("is not in tests/fixtures/oxia/README.md");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("22a: the default directory is the repository's fixture directory", () => {
    const expected = path.join(import.meta.dirname, "..", "..", "..", "fixtures", "oxia", "no-such-capture.json");
    let error: (Error & { path?: string }) | undefined;
    try {
      loadOxiaCapture("no-such-capture.json");
    } catch (thrown) {
      error = thrown as Error & { path?: string };
    }
    expect(error?.path).toBe(expected);
  });
});
