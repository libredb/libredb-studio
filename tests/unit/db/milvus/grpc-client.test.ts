/**
 * The Milvus gRPC adapter (vector-family spec 5.1, E1, E2, E3, E7, E13, E14, E15, E16).
 *
 * The transport half runs over local servers this file starts from the allowlisted service definition, through
 * `grpcWireTransport` and the installed @grpc/grpc-js: the allowlist and the filtered stub, the exact channel options,
 * a channel that dials nothing until a call, a TXT service config that would install a retry policy, proxy variables,
 * a GetMetrics answer naming other addresses, deadlines before and after the send, the call's own abort, the receive
 * cap on a plain and on a compressed answer, a compressed answer flagged as identity, and what a closed channel still
 * did. The adapter half (Task 11) runs over the recorded wire of tests/helpers/milvus-wire.ts, so only the server is
 * fake. No grpc-js tracing runs here: its server-side tracer prints request headers (R41 F14).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import dns from "node:dns";
import http2 from "node:http2";
import net, { type AddressInfo } from "node:net";
import zlib from "node:zlib";
import {
  type ChannelCredentials,
  Client,
  credentials,
  type experimental,
  Metadata,
  Server,
  ServerCredentials,
  type ServerUnaryCall,
  type sendUnaryData,
} from "@grpc/grpc-js";
import type { MethodDefinition, ServiceDefinition } from "@grpc/proto-loader";
import {
  type CallOptions,
  type MilvusClient,
  type MilvusClientFactory,
  MilvusError,
} from "@/lib/db/providers/vector/milvus/client";
import type { MilvusConnectionOptions } from "@/lib/db/providers/vector/milvus/connection-options";
import { toMilvusError, toProviderError } from "@/lib/db/providers/vector/milvus/errors";
import {
  allowlistedService,
  allowlistFindings,
  ClosingCredentials,
  channelOptions,
  createGrpcMilvusClient,
  deadlineMs,
  grpcWireTransport,
  MILVUS_ALLOWLISTED_RPCS,
  MILVUS_LOADER_OPTIONS,
  type MilvusRpc,
  type MilvusWireCall,
  milvusDefinition,
  SYSTEM_INFO_REQUEST,
} from "@/lib/db/providers/vector/milvus/grpc-client";
import { expectCalls } from "../../../helpers/call-log";
import { okStatus, type RecordedMilvusAnswer, recordedMilvusWire, statusError } from "../../../helpers/milvus-wire";

const OK = { code: 0, error_code: "Success", reason: "", retriable: false, detail: "", extra_info: {} };
const VERSION_ANSWER = { status: OK, version: "3.0.2" };
const CAP = 16 * 1024 * 1024;

const PLAINTEXT: MilvusConnectionOptions = {
  target: "dns:milvus.test:19530",
  endpoint: { host: "milvus.test", port: 19530 },
  auth: { kind: "none" },
  database: "default",
  callTimeoutMs: 5000,
  receiveCapBytes: CAP,
  secretForms: [],
};

const at = (port: number, overrides: Partial<MilvusConnectionOptions> = {}): MilvusConnectionOptions => ({
  ...PLAINTEXT,
  target: `dns:127.0.0.1:${port}`,
  endpoint: { host: "127.0.0.1", port },
  ...overrides,
});

const wireCall = (deadlineMs = 2000, signal = new AbortController().signal): MilvusWireCall => ({
  metadata: {},
  deadline: new Date(Date.now() + deadlineMs),
  signal,
});

type Unary = (call: ServerUnaryCall<Record<string, unknown>, object>, callback: sendUnaryData<object>) => void;

async function serve(
  implementation: Readonly<Record<string, Unary>>,
): Promise<{ readonly server: Server; readonly port: number }> {
  const server = new Server();
  server.addService(allowlistedService(), implementation);
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, bound) =>
      error ? reject(error) : resolve(bound),
    ),
  );
  return { server, port };
}

/** The error a call rejects with; a call that answers fails the test. */
async function failure(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => {
      throw new Error("The call answered, though this test expects it to fail");
    },
    (error: unknown) => error,
  );
}

/** Waits, two seconds at most, until `condition` holds. */
async function eventually(condition: () => boolean): Promise<void> {
  // oxlint-disable-next-line no-await-in-loop -- a poll: each check waits for the one before it.
  for (let waited = 0; waited < 2000 && !condition(); waited += 20) await Bun.sleep(20);
}

/** A TCP listener that counts what it accepts; `onAccept` decides what each connection meets. */
async function counting(onAccept: (socket: net.Socket) => void = (socket) => socket.destroy()) {
  const accepted: net.Socket[] = [];
  const listener = net.createServer((socket) => {
    accepted.push(socket);
    socket.on("error", () => undefined);
    onAccept(socket);
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  return { listener, accepted, port: (listener.address() as AddressInfo).port };
}

/** A bare HTTP/2 server answering every call with `answer`; it speaks no protobuf, so its frames are what it says. */
async function http2Server(answer: (stream: http2.ServerHttp2Stream) => void) {
  const server = http2.createServer();
  server.on("stream", (stream) => {
    stream.on("error", () => undefined);
    // @types/node types a server's "stream" event as an Http2Stream; a server only ever emits ServerHttp2Streams.
    answer(stream as http2.ServerHttp2Stream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

/** One gRPC message frame: the compressed flag, the length, the bytes. */
function grpcFrame(payload: Buffer, compressed: boolean): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt8(compressed ? 1 : 0, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

function respondWith(stream: http2.ServerHttp2Stream, encoding: string, frame: Buffer): void {
  stream.respond(
    { ":status": 200, "content-type": "application/grpc", "grpc-encoding": encoding },
    { waitForTrailers: true },
  );
  stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
  stream.end(frame);
}

/**
 * About 1 GiB of zeros as 61 concatenated gzip members of 17 MiB each, about 1 MB on the wire (R41 M25); each member
 * alone inflates past the 16 MiB cap, so the test holds whether a runtime's gunzip reads one member or all.
 */
function gzipBomb(): Buffer {
  const member = zlib.gzipSync(Buffer.alloc(17 * 1024 * 1024));
  return Buffer.concat(Array.from({ length: 61 }, () => member));
}

describe("the allowlist and the filtered stub (E3, E15)", () => {
  test("the descriptor is read with the loader options the descriptor test loads it with, and built once per process (R47 M5)", () => {
    expect(MILVUS_LOADER_OPTIONS).toEqual({
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    expect(milvusDefinition()).toBe(milvusDefinition());
    expect(allowlistedService()).toBe(allowlistedService());
  });

  test("the stub's method set equals the allowlist, and holds no Connect and no telemetry method", () => {
    const methods = Object.keys(allowlistedService());
    expect(methods).toEqual([...MILVUS_ALLOWLISTED_RPCS]);
    expect(allowlistFindings(methods)).toEqual([]);
    for (const rpc of MILVUS_ALLOWLISTED_RPCS) {
      expect((allowlistedService()[rpc] as MethodDefinition<object, object>).path).toBe(
        `/milvus.proto.milvus.MilvusService/${rpc}`,
      );
    }
  });

  test("a stub built from the full descriptor fails the same check, by name", () => {
    const full = Object.keys(milvusDefinition()["milvus.proto.milvus.MilvusService"] as ServiceDefinition);
    expect(allowlistFindings(full)).toContain("Connect is not on the allowlist");
    const telemetry = Object.keys(
      milvusDefinition()["milvus.proto.milvus.ClientTelemetryService"] as ServiceDefinition,
    );
    expect(allowlistFindings(telemetry)).toContain("ClientHeartbeat is not on the allowlist");
    expect(allowlistFindings(telemetry)).toContain("GetVersion is missing");
  });
});

describe("E7: the channel options, exactly", () => {
  const base = {
    "grpc.service_config_disable_resolution": 1,
    "grpc.max_receive_message_length": CAP,
    "grpc.enable_http_proxy": 0,
    "grpc.enable_retries": 0,
    "grpc.keepalive_time_ms": 10_000,
    "grpc.keepalive_timeout_ms": 6_000,
  };

  test("plaintext: five options copied from etcd and enable_retries 0, and nothing else", () => {
    expect(channelOptions(PLAINTEXT)).toEqual(base);
  });

  test("TLS adds the override by the IP rule", () => {
    const tls = {
      mode: "verify-full",
      verify: true,
      identity: "10.0.0.5",
      identityIsIp: true,
      serverNameOverride: "milvus.invalid",
    } as const;
    expect(channelOptions({ ...PLAINTEXT, tls })).toEqual({
      ...base,
      "grpc.ssl_target_name_override": "milvus.invalid",
    });
  });
});

describe("over grpc-js: the channel dials only the configured endpoint (E1, E2, E7)", () => {
  test("opening the channel dials nothing: only a call does", async () => {
    const listener = await counting();
    const channel = grpcWireTransport(at(listener.port));
    await Bun.sleep(100);
    expect(listener.accepted.length).toBe(0);
    await failure(channel.unary("GetVersion", {}, wireCall()));
    channel.close();
    listener.listener.close();
    expect(listener.accepted.length).toBeGreaterThan(0);
  }, 10_000);

  test("a call answers through the filtered stub", async () => {
    const { server, port } = await serve({ GetVersion: (_call, callback) => callback(null, VERSION_ANSWER) });
    const channel = grpcWireTransport(at(port));
    expect(await channel.unary("GetVersion", {}, wireCall())).toMatchObject({ version: "3.0.2", status: { code: 0 } });
    channel.close();
    server.forceShutdown();
  });

  test("a grpc_config TXT record installs no retry policy and is never read, so nothing is sent twice", async () => {
    let attempts = 0;
    const { server, port } = await serve({
      LoadCollection: (_call, callback) => {
        attempts++;
        callback({ code: 14, details: "unavailable" });
      },
    });
    const retryPolicy = {
      methodConfig: [
        {
          name: [{ service: "milvus.proto.milvus.MilvusService" }],
          retryPolicy: {
            maxAttempts: 4,
            initialBackoff: "0.01s",
            maxBackoff: "0.01s",
            backoffMultiplier: 1,
            retryableStatusCodes: ["UNAVAILABLE"],
          },
        },
      ],
    };
    const lookup = spyOn(dns.promises, "lookup").mockImplementation((async () => [
      { address: "127.0.0.1", family: 4 },
    ]) as never);
    const txt = spyOn(dns.promises, "resolveTxt").mockImplementation((async () => [
      [`grpc_config=${JSON.stringify([{ serviceConfig: retryPolicy }])}`],
    ]) as never);
    try {
      const target = `dns:milvus-txt.test:${port}`;
      const channel = grpcWireTransport({ ...PLAINTEXT, target });
      const load = { collection_name: "c", db_name: "default" };
      await failure(channel.unary("LoadCollection", load, wireCall()));
      await Bun.sleep(50);
      attempts = 0;
      await failure(channel.unary("LoadCollection", load, wireCall()));
      channel.close();
      expect({ attempts, txtLookups: txt.mock.calls.length }).toEqual({ attempts: 1, txtLookups: 0 });
      // The control: a channel that reads the record resends the call.
      const control = new Client(target, credentials.createInsecure());
      const method = allowlistedService().LoadCollection as MethodDefinition<object, object>;
      const once = () =>
        new Promise<void>((resolve) =>
          control.makeUnaryRequest(
            method.path,
            method.requestSerialize,
            method.responseDeserialize,
            load,
            new Metadata(),
            { deadline: Date.now() + 3000 },
            () => resolve(),
          ),
        );
      await once();
      await Bun.sleep(50);
      attempts = 0;
      await once();
      control.close();
      expect({ attempts, txtLookups: txt.mock.calls.length > 0 }).toEqual({ attempts: 4, txtLookups: true });
    } finally {
      lookup.mockRestore();
      txt.mockRestore();
      server.forceShutdown();
    }
  }, 20_000);

  test("a proxy the environment names is never used: the endpoint is dialled itself (E2)", async () => {
    const proxy = await counting();
    const { server, port } = await serve({ GetVersion: (_call, callback) => callback(null, VERSION_ANSWER) });
    const read = ["grpc_proxy", "https_proxy", "http_proxy", "no_grpc_proxy", "no_proxy"] as const;
    const saved = new Map(read.map((name) => [name, process.env[name]]));
    try {
      for (const name of ["grpc_proxy", "https_proxy", "http_proxy"] as const) {
        for (const other of read) delete process.env[other];
        process.env[name] = `http://127.0.0.1:${proxy.port}`;
        const channel = grpcWireTransport(at(port));
        // oxlint-disable-next-line no-await-in-loop -- one variable after another, each with its own channel.
        const answer = (await channel.unary("GetVersion", {}, wireCall())) as { version: string };
        channel.close();
        expect({ name, version: answer.version, proxied: proxy.accepted.length }).toEqual({
          name,
          version: "3.0.2",
          proxied: 0,
        });
      }
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      proxy.listener.close();
      server.forceShutdown();
    }
  }, 20_000);

  test("addresses a GetMetrics answer names, and a stand-in for port 9091, are never dialled (E2, E29)", async () => {
    const management = await counting();
    const node = await counting();
    const response = JSON.stringify({
      nodes_info: [{ identifier: 1, infos: { name: "querynode1", hardware_infos: { ip: `127.0.0.1:${node.port}` } } }],
      management: `127.0.0.1:${management.port}`,
    });
    const { server, port } = await serve({
      GetMetrics: (_call, callback) => callback(null, { status: OK, response, component_name: "proxy" }),
    });
    const channel = grpcWireTransport(at(port));
    await channel.unary("GetMetrics", { request: '{"metric_type": "system_info"}' }, wireCall());
    await Bun.sleep(200);
    channel.close();
    expect({ management: management.accepted.length, node: node.accepted.length }).toEqual({ management: 0, node: 0 });
    management.listener.close();
    node.listener.close();
    server.forceShutdown();
  });

  test("after close() a channel whose endpoint reset it dials nothing more, within twice grpc-js's initial backoff", async () => {
    const resetting = await counting((socket) => socket.resetAndDestroy());
    const channel = grpcWireTransport(at(resetting.port));
    await failure(channel.unary("GetVersion", {}, wireCall(500)));
    channel.close();
    const before = resetting.accepted.length;
    await Bun.sleep(2500);
    expect(resetting.accepted.length).toBe(before);
    resetting.listener.close();
  }, 10_000);
});

describe("over grpc-js: deadlines, aborts and the receive cap (E13, E14)", () => {
  let cancelledOnServer = 0;
  let server: Server;
  let port: number;
  beforeAll(async () => {
    ({ server, port } = await serve({
      Query: (call) => {
        call.on("cancelled", () => {
          cancelledOnServer++;
        });
      },
      GetVersion: (_call, callback) => callback(null, VERSION_ANSWER),
    }));
  });
  afterAll(() => server.forceShutdown());

  test("the call's own abort cancels it on the server and reads as a cancel; a timeout reads as a deadline", async () => {
    const channel = grpcWireTransport(at(port));
    const controller = new AbortController();
    const pending = failure(channel.unary("Query", {}, wireCall(5000, controller.signal)));
    await Bun.sleep(100);
    controller.abort();
    expect(toMilvusError(await pending, controller.signal).category).toBe("cancelled");
    await eventually(() => cancelledOnServer === 1);
    expect(cancelledOnServer).toBe(1);
    const timeout = AbortSignal.timeout(100);
    expect(toMilvusError(await failure(channel.unary("Query", {}, wireCall(5000, timeout))), timeout).category).toBe(
      "deadline-exceeded",
    );
    channel.close();
  });

  test("a signal that already aborted cancels at once and never waits for the server", async () => {
    const channel = grpcWireTransport(at(port));
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    expect(
      toMilvusError(
        await failure(channel.unary("GetVersion", {}, wireCall(5000, controller.signal))),
        controller.signal,
      ).category,
    ).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(1000);
    channel.close();
  });

  test("a deadline after the send is a deadline; a deadline before any transport is a failure to connect", async () => {
    const silentHttp2 = await http2Server(() => undefined);
    const afterSend = grpcWireTransport(at(silentHttp2.port));
    expect(toMilvusError(await failure(afterSend.unary("GetVersion", {}, wireCall(300)))).category).toBe(
      "deadline-exceeded",
    );
    afterSend.close();
    silentHttp2.server.close();
    const silentTcp = await counting((socket) => socket.resume());
    const beforeSend = grpcWireTransport(at(silentTcp.port));
    expect(toMilvusError(await failure(beforeSend.unary("GetVersion", {}, wireCall(300)))).category).toBe(
      "not-connected",
    );
    beforeSend.close();
    for (const socket of silentTcp.accepted) socket.destroy();
    silentTcp.listener.close();
  }, 10_000);

  test("an answer past the receive cap fails naming the cap and is never read", async () => {
    const plain = await http2Server((stream) => respondWith(stream, "identity", grpcFrame(Buffer.alloc(2000), false)));
    const channel = grpcWireTransport(at(plain.port, { receiveCapBytes: 1024 }));
    const error = toMilvusError(await failure(channel.unary("GetVersion", {}, wireCall())));
    expect({ category: error.category, detail: error.detail }).toEqual({
      category: "receive-cap",
      detail: "Received message larger than max (2000 vs 1024)",
    });
    channel.close();
    plain.server.close();
  });

  test("a gzip answer that inflates to 1 GiB fails naming the cap with a bounded memory rise (E13, R41 M25)", async () => {
    const bomb = gzipBomb();
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    const hostile = await http2Server((stream) => respondWith(stream, "gzip", grpcFrame(bomb, true)));
    const channel = grpcWireTransport(at(hostile.port));
    const before = process.memoryUsage().rss;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 5);
    const error = toMilvusError(await failure(channel.unary("GetVersion", {}, wireCall(10_000))));
    clearInterval(sampler);
    peak = Math.max(peak, process.memoryUsage().rss);
    expect(error.category).toBe("receive-cap");
    expect(error.detail).toContain("decompresses to a size larger than 16777216");
    expect(peak - before).toBeLessThan(64 * 1024 * 1024);
    channel.close();
    hostile.server.close();
  }, 30_000);

  test("a compressed answer flagged under the identity encoding is a transport failure (E13, R41 F12)", async () => {
    const hostile = await http2Server((stream) =>
      respondWith(stream, "identity", grpcFrame(zlib.gzipSync(Buffer.alloc(64)), true)),
    );
    const channel = grpcWireTransport(at(hostile.port));
    expect(toMilvusError(await failure(channel.unary("GetVersion", {}, wireCall()))).category).toBe("transport");
    channel.close();
    hostile.server.close();
  });
});

describe("over grpc-js: nothing of a channel outlives close() (E16, copied from etcd's tests)", () => {
  const TARGET: experimental.GrpcUri = { scheme: "dns", path: "milvus.test:19530" };
  const CHANNEL_CLOSED = "The channel closed before this connection was established";

  async function silentListener() {
    const held = new Set<net.Socket>();
    const spoke = new Set<net.Socket>();
    const listener = net.createServer((socket) => {
      held.add(socket);
      socket.on("close", () => held.delete(socket));
      socket.on("error", () => undefined);
      socket.on("data", () => spoke.add(socket));
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    return { listener, held, spoke, port: (listener.address() as AddressInfo).port };
  }

  const dialled = (port: number) =>
    new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.off("error", reject);
        resolve(socket);
      });
      socket.once("error", reject);
    });

  function establishing(): ChannelCredentials {
    const inner = credentials.createInsecure();
    spyOn(inner, "_createSecureConnector").mockReturnValue({
      connect: (socket) => Promise.resolve({ socket, secure: false }),
      waitForReady: () => Promise.resolve(),
      getCallCredentials: () => credentials.createEmpty(),
      destroy: () => undefined,
    });
    return inner;
  }

  test("destroy() ends every socket still in its handshake and fails its connect", async () => {
    const silent = await silentListener();
    const connector = new ClosingCredentials(credentials.createSsl())._createSecureConnector(TARGET, {});
    const sockets = await Promise.all([dialled(silent.port), dialled(silent.port)]);
    const connecting = sockets.map((socket) => failure(connector.connect(socket)));
    await eventually(() => silent.spoke.size === 2);
    connector.destroy();
    expect(await Promise.all(connecting)).toMatchObject([{ message: CHANNEL_CLOSED }, { message: CHANNEL_CLOSED }]);
    expect(sockets.map((socket) => socket.destroyed)).toEqual([true, true]);
    await eventually(() => silent.held.size === 0);
    silent.listener.close();
    expect(silent.held.size).toBe(0);
  }, 10_000);

  test("a socket handed over after destroy() is ended before any handshake", async () => {
    const silent = await silentListener();
    const connector = new ClosingCredentials(credentials.createSsl())._createSecureConnector(TARGET, {});
    connector.destroy();
    const socket = await dialled(silent.port);
    expect(await failure(connector.connect(socket))).toMatchObject({ message: CHANNEL_CLOSED });
    expect(socket.destroyed).toBe(true);
    await eventually(() => silent.held.size === 0);
    silent.listener.close();
    expect({ held: silent.held.size, spoke: silent.spoke.size }).toEqual({ held: 0, spoke: 0 });
  }, 10_000);

  test("everything else is grpc-js's own connector: the answer, the failure, readiness, call credentials, destroy()", async () => {
    const inner = credentials.createSsl();
    const handshake = { socket: new net.Socket(), secure: true };
    const refusal = new Error("the handshake failed");
    const ready = Promise.resolve();
    const callCredentials = credentials.createEmpty();
    const [answered, refused] = [new net.Socket(), new net.Socket()];
    const destroyed: string[] = [];
    spyOn(inner, "_createSecureConnector").mockReturnValue({
      connect: (socket) => (socket === answered ? Promise.resolve(handshake) : Promise.reject(refusal)),
      waitForReady: () => ready,
      getCallCredentials: () => callCredentials,
      destroy: () => {
        destroyed.push("inner");
      },
    });
    const connector = new ClosingCredentials(inner)._createSecureConnector(TARGET, {}, callCredentials);
    expect(await connector.connect(answered)).toBe(handshake);
    expect(await failure(connector.connect(refused))).toBe(refusal);
    expect(connector.waitForReady()).toBe(ready);
    expect(connector.getCallCredentials()).toBe(callCredentials);
    connector.destroy();
    expect({ destroyed, answered: answered.destroyed, refused: refused.destroyed }).toEqual({
      destroyed: ["inner"],
      answered: false,
      refused: false,
    });
    expect(await failure(connector.waitForReady())).toMatchObject({ message: CHANNEL_CLOSED });
  });

  test("the credentials keep grpc-js's security flag and equal only themselves, so no two clients share a subchannel", () => {
    const tls = new ClosingCredentials(credentials.createSsl());
    const plaintext = new ClosingCredentials(credentials.createInsecure());
    expect({ tls: tls._isSecure(), plaintext: plaintext._isSecure() }).toEqual({ tls: true, plaintext: false });
    expect({ tls: tls._equals(tls), plaintext: plaintext._equals(plaintext) }).toEqual({ tls: true, plaintext: true });
    expect(plaintext._equals(new ClosingCredentials(credentials.createInsecure()))).toBe(false);
    // The control: grpc-js's insecure credentials equal any other.
    expect(credentials.createInsecure()._equals(credentials.createInsecure())).toBe(true);
  });

  test("a connector made after the adapter's close refuses readiness and ends a socket handed to it", async () => {
    const silent = await silentListener();
    const closing = new ClosingCredentials(establishing());
    closing.endEverySocket();
    const late = closing._createSecureConnector(TARGET, {});
    expect(await failure(late.waitForReady())).toMatchObject({ message: CHANNEL_CLOSED });
    const socket = await dialled(silent.port);
    expect(await failure(late.connect(socket))).toMatchObject({ message: CHANNEL_CLOSED });
    expect(socket.destroyed).toBe(true);
    silent.listener.close();
  });

  test("a connector's destroy() alone leaves an established socket open; the adapter's close ends it", async () => {
    const silent = await silentListener();
    const closing = new ClosingCredentials(establishing());
    const connector = closing._createSecureConnector(TARGET, {});
    const socket = await dialled(silent.port);
    await connector.connect(socket);
    connector.destroy();
    expect(socket.destroyed).toBe(false);
    closing.endEverySocket();
    expect(socket.destroyed).toBe(true);
    await eventually(() => silent.held.size === 0);
    silent.listener.close();
    expect(silent.held.size).toBe(0);
  });
});

// A named placeholder, never a realistic value: a credential in a test fixture is a stand-in.
const TEST_PASSWORD = "password";
const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
const call = (db = "default", signal = new AbortController().signal): CallOptions => ({ db, signal });

/** One call of each seam method, with the request the RPC carries on the wire, `db_name` added where the message has it. */
const INVOKE: ReadonlyArray<
  readonly [MilvusRpc, (client: MilvusClient, options: CallOptions) => Promise<unknown>, object]
> = [
  ["GetVersion", (c, o) => c.getVersion(o), {}],
  ["CheckHealth", (c, o) => c.checkHealth(o), {}],
  ["GetMetrics", (c, o) => c.getMetricsSystemInfo(o), { request: SYSTEM_INFO_REQUEST }],
  ["ListDatabases", (c, o) => c.listDatabases(o), {}],
  ["DescribeDatabase", (c, o) => c.describeDatabase({}, o), { db_name: "probe_db" }],
  ["ShowCollections", (c, o) => c.showCollections(o), { db_name: "probe_db" }],
  [
    "DescribeCollection",
    (c, o) => c.describeCollection({ collection_name: "notes" }, o),
    { collection_name: "notes", db_name: "probe_db" },
  ],
  [
    "BatchDescribeCollection",
    (c, o) => c.batchDescribeCollection({ collection_name: ["a", "b"] }, o),
    { collection_name: ["a", "b"], db_name: "probe_db" },
  ],
  [
    "DescribeIndex",
    (c, o) => c.describeIndex({ collection_name: "notes" }, o),
    { collection_name: "notes", db_name: "probe_db" },
  ],
  [
    "GetLoadState",
    (c, o) => c.getLoadState({ collection_name: "notes" }, o),
    { collection_name: "notes", db_name: "probe_db" },
  ],
  [
    "GetLoadingProgress",
    (c, o) => c.getLoadingProgress({ collection_name: "notes" }, o),
    { collection_name: "notes", db_name: "probe_db" },
  ],
  [
    "GetCollectionStatistics",
    (c, o) => c.getCollectionStatistics({ collection_name: "notes" }, o),
    { collection_name: "notes", db_name: "probe_db" },
  ],
  [
    "ShowPartitions",
    (c, o) => c.showPartitions({ collection_name: "notes" }, o),
    { collection_name: "notes", db_name: "probe_db" },
  ],
  ["ListAliases", (c, o) => c.listAliases({}, o), { db_name: "probe_db" }],
  ["DescribeAlias", (c, o) => c.describeAlias({ alias: "al" }, o), { alias: "al", db_name: "probe_db" }],
  [
    "Query",
    (c, o) => c.query({ collection_name: "notes", expr: "id > 0", output_fields: ["id"], query_params: [] }, o),
    { collection_name: "notes", expr: "id > 0", output_fields: ["id"], query_params: [], db_name: "probe_db" },
  ],
  [
    "Search",
    (c, o) =>
      c.search(
        { collection_name: "notes", dsl: "", dsl_type: "BoolExprV1", output_fields: [], search_params: [], nq: "1" },
        o,
      ),
    {
      collection_name: "notes",
      dsl: "",
      dsl_type: "BoolExprV1",
      output_fields: [],
      search_params: [],
      nq: "1",
      db_name: "probe_db",
    },
  ],
  [
    "HybridSearch",
    (c, o) => c.hybridSearch({ collection_name: "notes", requests: [], rank_params: [], output_fields: [] }, o),
    { collection_name: "notes", requests: [], rank_params: [], output_fields: [], db_name: "probe_db" },
  ],
  [
    "LoadCollection",
    (c, o) => c.loadCollection({ collection_name: "notes" }, o),
    { collection_name: "notes", db_name: "probe_db" },
  ],
  [
    "ReleaseCollection",
    (c, o) => c.releaseCollection({ collection_name: "notes" }, o),
    { collection_name: "notes", db_name: "probe_db" },
  ],
];

/** The smallest successful answer of every RPC: a status of its own, or, for Load and Release, the status itself. */
const minimal = (rpc: MilvusRpc) => () =>
  rpc === "LoadCollection" || rpc === "ReleaseCollection" ? okStatus : { status: okStatus };
const EVERY_ANSWER = Object.fromEntries(INVOKE.map(([rpc]) => [rpc, minimal(rpc)]));

async function recorded(
  options: MilvusConnectionOptions = PLAINTEXT,
  answers: Partial<Record<MilvusRpc, RecordedMilvusAnswer>> = EVERY_ANSWER,
) {
  const wire = recordedMilvusWire(answers);
  const client = await createGrpcMilvusClient(options, wire.transport);
  return { wire, client };
}

describe("the adapter over the recorded wire (5.1, E15, E16)", () => {
  test("the factory opens one channel with the options and sends nothing, and binds as a MilvusClientFactory", async () => {
    const { wire } = await recorded();
    expect(wire.opened).toEqual([PLAINTEXT]);
    expectCalls(wire, []);
    const factory: MilvusClientFactory<MilvusConnectionOptions> = (options) =>
      createGrpcMilvusClient(options, wire.transport);
    (await factory(PLAINTEXT)).close();
    expect(wire.opened).toHaveLength(2);
  });

  test.each(INVOKE.map(([rpc, invoke, request]) => [rpc, invoke, request] as const))(
    "%s sends exactly its request, with db_name from CallOptions where the message carries it",
    async (rpc, invoke, request) => {
      const { wire, client } = await recorded();
      await invoke(client, call("probe_db"));
      expectCalls(wire, [{ method: rpc, args: [request, {}] }]);
    },
  );

  test("getMetricsSystemInfo always writes the fixed system_info request (E29)", () => {
    expect(SYSTEM_INFO_REQUEST).toBe('{"metric_type": "system_info"}');
  });

  test("the credential travels only as authorization: base64 of user:password, or of the token (E4)", async () => {
    const pair = await recorded({ ...PLAINTEXT, auth: { kind: "password", user: "root", password: TEST_PASSWORD } });
    await pair.client.getVersion(call());
    expectCalls(pair.wire, [{ method: "GetVersion", args: [{}, { authorization: base64(`root:${TEST_PASSWORD}`) }] }]);
    const token = await recorded({ ...PLAINTEXT, auth: { kind: "token", token: TEST_PASSWORD } });
    await token.client.getVersion(call());
    expectCalls(token.wire, [{ method: "GetVersion", args: [{}, { authorization: base64(TEST_PASSWORD) }] }]);
  });

  test("a db_name written into a request is replaced by CallOptions.db, and two concurrent calls each reach their own (E16)", async () => {
    const { wire, client } = await recorded();
    const smuggled = { collection_name: "notes", db_name: "other" } as unknown as { collection_name: string };
    await Promise.all([
      client.describeCollection(smuggled, call("probe_db")),
      client.describeCollection({ collection_name: "notes" }, call("default")),
    ]);
    expect(wire.calls.map((logged) => (logged.args?.[0] as { db_name?: string } | undefined)?.db_name)).toEqual([
      "probe_db",
      "default",
    ]);
  });

  test("each call's deadline is its class's, 30 s for queries and searches and 10 s for the rest, capped by the query timeout (E14)", async () => {
    expect(INVOKE.map(([rpc]) => [rpc, deadlineMs(rpc, 60_000)])).toEqual(
      INVOKE.map(([rpc]) => [rpc, rpc === "Query" || rpc === "Search" || rpc === "HybridSearch" ? 30_000 : 10_000]),
    );
    expect(deadlineMs("Query", 5000)).toBe(5000);
    const { wire, client } = await recorded({ ...PLAINTEXT, callTimeoutMs: 60_000 });
    await client.search(
      { collection_name: "c", dsl: "", dsl_type: "BoolExprV1", output_fields: [], search_params: [], nq: "1" },
      call(),
    );
    await client.getLoadState({ collection_name: "c" }, call());
    expect(wire.deadlines[0]).toBeGreaterThan(29_900);
    expect(wire.deadlines[0]).toBeLessThanOrEqual(30_000);
    expect(wire.deadlines[1]).toBeGreaterThan(9_900);
    expect(wire.deadlines[1]).toBeLessThanOrEqual(10_000);
  });

  test("every common.Status is checked: code 0 with CollectionNotExists, a non-zero code and no status are errors (E20)", async () => {
    const answers = {
      DescribeCollection: () => ({
        status: { ...okStatus, error_code: "CollectionNotExists", reason: "collection not found" },
      }),
      Query: () => ({
        status: { ...okStatus, code: 101, error_code: "UnexpectedError", reason: "collection not loaded" },
      }),
      GetVersion: () => ({ status: null, version: "3.0.2" }),
      LoadCollection: () => ({ ...okStatus, code: 65535, error_code: "UnexpectedError", reason: "no index" }),
    };
    const { client } = await recorded(PLAINTEXT, answers);
    expect(await failure(client.describeCollection({ collection_name: "x" }, call()))).toMatchObject({
      category: "status",
      status: { code: 0, errorCode: "CollectionNotExists" },
    });
    expect(
      await failure(client.query({ collection_name: "x", expr: "", output_fields: [], query_params: [] }, call())),
    ).toMatchObject({
      category: "status",
      status: { code: 101 },
    });
    expect(await failure(client.getVersion(call()))).toMatchObject({ category: "malformed" });
    expect(await failure(client.loadCollection({ collection_name: "x" }, call()))).toMatchObject({
      category: "status",
      status: { code: 65535 },
    });
  });

  test("a transport failure is classified by the error table", async () => {
    const { client } = await recorded(PLAINTEXT, {
      ListDatabases: () => {
        throw statusError(16, "auth check failure, please check username and password are correct");
      },
    });
    expect(await failure(client.listDatabases(call()))).toMatchObject({ category: "unauthenticated", grpcCode: 16 });
  });

  test("a signal aborted before the call sends nothing, and reads as a cancel, or as a deadline for a timeout", async () => {
    const { wire, client } = await recorded();
    const cancel = new AbortController();
    cancel.abort();
    expect(await failure(client.getVersion(call("default", cancel.signal)))).toMatchObject({ category: "cancelled" });
    const timeout = new AbortController();
    timeout.abort(new DOMException("The operation timed out.", "TimeoutError"));
    expect(await failure(client.getVersion(call("default", timeout.signal)))).toMatchObject({
      category: "deadline-exceeded",
    });
    expectCalls(wire, []);
  });

  test("a call's own abort while it waits cancels it (E14)", async () => {
    const { client } = await recorded(PLAINTEXT, { Search: () => new Promise(() => undefined) });
    const controller = new AbortController();
    const pending = failure(
      client.search(
        { collection_name: "c", dsl: "", dsl_type: "BoolExprV1", output_fields: [], search_params: [], nq: "1" },
        call("default", controller.signal),
      ),
    );
    controller.abort();
    expect(await pending).toMatchObject({ category: "cancelled" });
  });

  test("close() closes the channel once; every later call rejects as closed and sends nothing", async () => {
    const { wire, client } = await recorded();
    client.close();
    client.close();
    expect(wire.closes()).toBe(1);
    const error = await failure(client.getVersion(call()));
    expect(error).toBeInstanceOf(MilvusError);
    expect(error).toMatchObject({ category: "closed" });
    expectCalls(wire, []);
  });
});

describe("the adapter over grpc-js: the wire both ways", () => {
  test("a request reaches the server with its db_name and authorization, and the answer decodes", async () => {
    const seen: Array<{ readonly db: unknown; readonly authorization: unknown }> = [];
    const { server, port } = await serve({
      DescribeCollection: (serverCall, callback) => {
        seen.push({ db: serverCall.request.db_name, authorization: serverCall.metadata.get("authorization")[0] });
        callback(null, { status: OK, collection_name: "notes", collectionID: "469489107428444006", shards_num: 1 });
      },
    });
    const client = await createGrpcMilvusClient(
      at(port, { auth: { kind: "password", user: "root", password: TEST_PASSWORD } }),
    );
    const answer = await client.describeCollection({ collection_name: "notes" }, call("probe_db"));
    client.close();
    server.forceShutdown();
    expect(seen).toEqual([{ db: "probe_db", authorization: base64(`root:${TEST_PASSWORD}`) }]);
    expect(answer).toMatchObject({
      collection_name: "notes",
      collectionID: "469489107428444006",
      shards_num: 1,
      schema: null,
    });
  });

  test("a LoadCollection whose answer is lost is sent once and reads may have been applied (E7, Review Focus 3)", async () => {
    let received = 0;
    const dropping = await http2Server((stream) => {
      stream.on("data", () => {
        received++;
        stream.session?.destroy();
      });
    });
    const client = await createGrpcMilvusClient(at(dropping.port));
    const error = await failure(client.loadCollection({ collection_name: "docs_int64" }, call()));
    await Bun.sleep(1000);
    client.close();
    dropping.server.close();
    expect(received).toBe(1);
    const mapped = toProviderError(error, {
      operation: "Load of docs_int64",
      write: true,
      collection: "docs_int64",
      connection: {
        host: "127.0.0.1",
        port: dropping.port,
        runtimeReportsTlsCause: true,
        receiveCapBytes: CAP,
        timeoutMs: 10_000,
      },
      secretForms: [],
    });
    expect(mapped.message).toContain(
      "It may have been applied: read the collection's load state before you run it again.",
    );
  }, 10_000);
});
