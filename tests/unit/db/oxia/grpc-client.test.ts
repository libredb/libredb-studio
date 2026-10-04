/**
 * The Oxia gRPC adapter (SB1-1.3, SB1-2.3, SB1-2.4, SB1-4.7, SB1-4.9, SB1-5.1, SB1-5.5, SB1-5.5a, SB1-9.3, SB1-9.4).
 *
 * The adapter runs over in-process grpc-js servers built from the allowlisted service definitions themselves, through
 * `grpcOxiaWireTransport`, and over test-local `OxiaWireTransport`s where a path needs an answer no small server can
 * give (a message past the 16 MiB cap) or a channel config is the thing under test. Every server binds `[::]:0`, dual
 * stack, so 127.0.0.1, localhost and [::1] reach the same one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  type MethodDefinition,
  Server,
  ServerCredentials,
  type ServerUnaryCall,
  type ServerWritableStream,
  type ServiceDefinition,
  type ServiceError,
  type sendUnaryData,
} from "@grpc/grpc-js";
import { QueryError } from "@/lib/db/errors";
import {
  type GrpcCall,
  type GrpcChannel,
  type GrpcChannelConfig,
  type GrpcServerStream,
  type GrpcServerStreamLimits,
  grpcChannelOptions,
} from "@/lib/db/grpc/channel";
import {
  OXIA_ALLOWLISTED_RPCS,
  OXIA_HEALTH_RPCS,
  type OxiaCallOptions,
  type OxiaClient,
  type OxiaGet,
  type OxiaShard,
  type OxiaStream,
  type OxiaStreamOptions,
} from "@/lib/db/providers/keyvalue/oxia/client";
import {
  admitLeaders,
  buildOxiaConnectionOptions,
  type OxiaConnectionOptions,
  oxiaErrorConnection,
} from "@/lib/db/providers/keyvalue/oxia/connection-options";
import {
  OXIA_READ_BATCH_GETS,
  OXIA_RECEIVE_CAP_BYTES,
  OXIA_RUN_BYTE_BUDGET,
  OXIA_TYPE,
} from "@/lib/db/providers/keyvalue/oxia/constants";
import {
  OXIA_ADAPTER_INTERNAL_KEY_SENTENCE,
  OXIA_INDEX_NAME_SENTENCE,
  OXIA_LONE_SURROGATE_SENTENCE,
  OxiaError,
  type OxiaErrorCategory,
  OxiaUnsentStatus,
  toProviderError,
} from "@/lib/db/providers/keyvalue/oxia/errors";
import {
  allowlistedServices,
  allowlistFindings,
  createGrpcOxiaClient,
  grpcOxiaWireTransport,
  OXIA_LOADER_OPTIONS,
  type OxiaWireTransport,
  oxiaDefinition,
} from "@/lib/db/providers/keyvalue/oxia/grpc-client";
import type { DatabaseConnection } from "@/lib/types";
import { oxiaConnection } from "../../../helpers/oxia-connection";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";

/** A placeholder bearer token: it matches the bearer rule and is a stand-in, never a real one. */
const TEST_TOKEN = "test-token";
const CLIENT_SERVICE = "io.oxia.proto.v1.OxiaClient";
const HEALTH_SERVICE = "grpc.health.v1.Health";
const RECEIVE_CAP_FAILURE = { code: 8, details: "Received message larger than max (17000000 vs 16777216)" };
const VERSION_WIRE = {
  version_id: "7",
  modifications_count: "0",
  created_timestamp: "1759536000000",
  modified_timestamp: "1759536000000",
};
const VERSION = {
  versionId: "7",
  modificationsCount: "0",
  createdTimestamp: "1759536000000",
  modifiedTimestamp: "1759536000000",
};

// -- the in-process server -------------------------------------------------------------------------------------------

interface SeenCall {
  path: string;
  authority: string;
  authorization?: string;
  keys: string[];
  request: object;
}

interface Seen {
  /** Every call, in order: its path, its :authority (call.getHost()), its metadata keys and authorization, its request. */
  readonly calls: SeenCall[];
  cancelled: number;
}

type StreamHandler = (call: ServerWritableStream<object, object>) => void;

interface Script {
  assignments?: StreamHandler;
  read?: StreamHandler;
  list?: StreamHandler;
  rangeScan?: StreamHandler;
  check?: (call: ServerUnaryCall<object, object>, callback: sendUnaryData<object>) => void;
}

interface Served {
  readonly server: Server;
  readonly port: number;
  readonly seen: Seen;
}

const servers: Server[] = [];
const clients: OxiaClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) server.forceShutdown();
});

function record(seen: Seen, call: ServerWritableStream<object, object> | ServerUnaryCall<object, object>): void {
  const map = call.metadata.getMap();
  seen.calls.push({
    path: call.getPath(),
    authority: call.getHost(),
    ...(typeof map.authorization === "string" ? { authorization: map.authorization } : {}),
    keys: Object.keys(map).sort(),
    request: call.request,
  });
  // Both call kinds emit "cancelled"; the union of their `on` overloads is not callable as one.
  (call as ServerUnaryCall<object, object>).on("cancelled", () => {
    seen.cancelled++;
  });
}

function streaming(seen: Seen, handler: StreamHandler | undefined): StreamHandler {
  return (call) => {
    record(seen, call);
    if (handler === undefined) call.end();
    else handler(call);
  };
}

/** One server for the allowlisted services, bound to [::]:0 (dual stack: 127.0.0.1, localhost and [::1] reach it). */
async function serve(script: Script = {}): Promise<Served> {
  const seen: Seen = { calls: [], cancelled: 0 };
  const server = new Server();
  const services = allowlistedServices();
  server.addService(services.client as ServiceDefinition, {
    GetShardAssignments: streaming(seen, script.assignments),
    Read: streaming(seen, script.read),
    List: streaming(seen, script.list),
    RangeScan: streaming(seen, script.rangeScan),
  });
  server.addService(services.health as ServiceDefinition, {
    Check: (call: ServerUnaryCall<object, object>, callback: sendUnaryData<object>) => {
      record(seen, call);
      if (script.check === undefined) callback(null, { status: "SERVING" });
      else script.check(call, callback);
    },
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("[::]:0", ServerCredentials.createInsecure(), (error, bound) =>
      error ? reject(error) : resolve(bound),
    ),
  );
  servers.push(server);
  return { server, port, seen };
}

/** A server stream that answers one message and holds the stream open. */
const holdAfter =
  (message: object): StreamHandler =>
  (call) => {
    call.write(message);
  };

/** A server stream that answers each message, then ends. */
const answer =
  (...messages: object[]): StreamHandler =>
  (call) => {
    for (const message of messages) call.write(message);
    call.end();
  };

/** A server stream that fails with a gRPC status. */
const fail =
  (code: number): StreamHandler =>
  (call) => {
    call.emit("error", { code, details: "the server's own text" });
  };

// -- helpers ---------------------------------------------------------------------------------------------------------

/** An even split of the hash space into `leaders.length` shards, ids "0", "1", ..., router XXHASH3. */
function assignmentsMessage(
  leaders: readonly string[],
  namespace = "default",
): { namespaces: Record<string, WireNamespace> } {
  const width = Math.floor(0x1_0000_0000 / leaders.length);
  return {
    namespaces: {
      [namespace]: {
        assignments: leaders.map((leader, index) => ({
          shard: String(index),
          leader,
          int32_hash_range: {
            min_hash_inclusive: index * width,
            max_hash_inclusive: index === leaders.length - 1 ? 0xffffffff : (index + 1) * width - 1,
          },
        })),
        shard_key_router: "XXHASH3",
      },
    },
  };
}

function optionsFor(port: number, overrides: Partial<DatabaseConnection> = {}): OxiaConnectionOptions {
  return buildOxiaConnectionOptions(oxiaConnection({ host: "127.0.0.1", port, ...overrides }), {
    executionReadOnly: false,
    queryTimeout: 5_000,
  });
}

function callOf(ms = 3_000, signal = new AbortController().signal): OxiaCallOptions {
  return { signal, deadline: Date.now() + ms };
}

function streamOf(maxReceivedBytes = OXIA_RUN_BYTE_BUDGET, ms = 3_000, signal?: AbortSignal): OxiaStreamOptions {
  return { ...callOf(ms, signal), maxReceivedBytes };
}

function client(options: OxiaConnectionOptions, transport?: OxiaWireTransport): OxiaClient {
  const created = createGrpcOxiaClient(options, transport);
  clients.push(created);
  return created;
}

/** A shard on the bootstrap channel, for calls that need no snapshot. */
function bootstrapShard(options: OxiaConnectionOptions, id = "0"): OxiaShard {
  const colon = options.sentAuthority.lastIndexOf(":");
  return {
    id,
    minHash: 0,
    maxHash: 0xffffffff,
    leader: {
      host: options.sentAuthority.slice(0, colon),
      port: Number(options.sentAuthority.slice(colon + 1)),
      address: options.sentAuthority,
      bootstrap: true,
    },
  };
}

/** The error a promise rejects with; one that answers fails the test. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("The call answered, though this test expects it to fail");
    },
    (error: unknown) => error,
  );
}

/** The error a stream raises, synchronously at its call or on its first next(). */
async function streamFailure(open: () => OxiaStream<unknown>): Promise<unknown> {
  let stream: OxiaStream<unknown>;
  try {
    stream = open();
  } catch (error) {
    return error;
  }
  return failure(stream.next());
}

/** Waits, two seconds at most, until `condition` holds. */
async function eventually(condition: () => boolean): Promise<void> {
  // oxlint-disable-next-line no-await-in-loop -- a poll: each check waits for the one before it.
  for (let waited = 0; waited < 2000 && !condition(); waited += 20) await Bun.sleep(20);
}

function expectOxiaError(error: unknown, category: OxiaErrorCategory): OxiaError {
  expect(error).toBeInstanceOf(OxiaError);
  expect((error as OxiaError).category).toBe(category);
  return error as OxiaError;
}

function expectRefusal(error: unknown, sentence: string): void {
  expect(error).toBeInstanceOf(QueryError);
  expect((error as QueryError).message).toBe(sentence);
  expect((error as QueryError).provider).toBe(OXIA_TYPE);
}

interface ChannelCall {
  readonly address: string;
  readonly path: string;
  readonly request: object;
  readonly call: GrpcCall;
  readonly limits?: GrpcServerStreamLimits;
}

/** Records every channel the adapter opens, every close, and every call with its request, call and limits. */
function recordingTransport(inner: OxiaWireTransport = grpcOxiaWireTransport) {
  const opened: { address: string; config: GrpcChannelConfig }[] = [];
  const closed: string[] = [];
  const calls: ChannelCall[] = [];
  const transport: OxiaWireTransport = {
    channel: (address, config) => {
      opened.push({ address, config });
      const channel = inner.channel(address, config);
      return {
        unary: (method, request, call) => {
          calls.push({ address, path: method.path, request, call });
          return channel.unary(method, request, call);
        },
        bidiStream: (method, call) => channel.bidiStream(method, call),
        serverStream: (method, request, call, limits) => {
          calls.push({ address, path: method.path, request, call, limits });
          return channel.serverStream(method, request, call, limits);
        },
        close: () => {
          closed.push(address);
          channel.close();
        },
      };
    },
  };
  return { transport, opened, closed, calls };
}

type ServerStreamAnswer = (
  method: MethodDefinition<object, object>,
  request: object,
  call: GrpcCall,
  limits: GrpcServerStreamLimits,
) => GrpcServerStream;
type UnaryAnswer = (method: MethodDefinition<object, object>, request: object, call: GrpcCall) => Promise<object>;

/** A channel for answers no in-process server can give; members a test does not script throw. */
function fakeChannel(answers: { serverStream?: ServerStreamAnswer; unary?: UnaryAnswer }): GrpcChannel {
  const unused = () => {
    throw new Error("not used by this test");
  };
  return {
    unary: answers.unary ?? unused,
    bidiStream: unused,
    serverStream: answers.serverStream ?? unused,
    close: () => undefined,
  };
}

/** A transport stream that yields `messages`, then rejects with `end` when one is given, else ends. */
function scriptedStream(messages: readonly object[], end?: unknown): GrpcServerStream {
  const queue = [...messages];
  return {
    read: () => {
      const message = queue.shift();
      if (message !== undefined) return Promise.resolve(message);
      return end === undefined ? Promise.resolve(undefined) : Promise.reject(end);
    },
    receivedBytes: 0,
    truncated: false,
    cancel: () => undefined,
  };
}

/** The RPC name at the end of a method path. */
const methodOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

// -- the allowlist ---------------------------------------------------------------------------------------------------

describe("the allowlist and the filtered stubs (SB1-2.4)", () => {
  test("the loader options, and the descriptor and stubs built once", () => {
    expect(OXIA_LOADER_OPTIONS).toEqual({ keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
    expect(oxiaDefinition()).toBe(oxiaDefinition());
    expect(allowlistedServices()).toBe(allowlistedServices());
  });

  test("the stubs hold exactly the allowlisted RPCs, with their paths and stream shapes", () => {
    const { client: stub, health } = allowlistedServices();
    expect(Object.keys(stub)).toEqual([...OXIA_ALLOWLISTED_RPCS]);
    expect(Object.keys(health)).toEqual([...OXIA_HEALTH_RPCS]);
    for (const rpc of OXIA_ALLOWLISTED_RPCS) {
      const method = stub[rpc] as MethodDefinition<object, object>;
      expect(method.path).toBe(`/${CLIENT_SERVICE}/${rpc}`);
      expect(method.responseStream).toBe(true);
      expect(method.requestStream).toBe(false);
    }
    const check = health.Check as MethodDefinition<object, object>;
    expect(check.path).toBe(`/${HEALTH_SERVICE}/Check`);
    expect(check.responseStream).toBe(false);
    expect(check.requestStream).toBe(false);
  });

  test("allowlistFindings names every method off the allowlist and every allowlisted RPC missing", () => {
    const full = [
      ...Object.keys(oxiaDefinition()[CLIENT_SERVICE] as object),
      ...Object.keys(oxiaDefinition()[HEALTH_SERVICE] as object).map((name) => `Health/${name}`),
    ];
    const findings = allowlistFindings(full);
    for (const finding of [
      "Write is not on the allowlist",
      "WriteStream is not on the allowlist",
      "CreateSession is not on the allowlist",
      "Health/Watch is not on the allowlist",
    ]) {
      expect(findings).toContain(finding);
    }
    const partial = allowlistFindings(["Read"]);
    expect(partial).toContain("GetShardAssignments is missing");
    expect(partial).toContain("Health/Check is missing");
    const { client: stub, health } = allowlistedServices();
    expect(allowlistFindings([...Object.keys(stub), ...Object.keys(health).map((name) => `Health/${name}`)])).toEqual(
      [],
    );
  });
});

// -- the channel map -------------------------------------------------------------------------------------------------

describe("the channel map and the transport (SB1-5.5, SB1-5.5a)", () => {
  test("nothing is opened until a call", () => {
    const recording = recordingTransport();
    client(optionsFor(6648), recording.transport);
    expect(recording.opened).toEqual([]);
  });

  test("the bootstrap channel's config", async () => {
    const { port } = await serve();
    const options = optionsFor(port);
    const recording = recordingTransport();
    expect(await client(options, recording.transport).health(callOf())).toBe("SERVING");
    expect(recording.opened.map((entry) => entry.address)).toEqual([options.sentAuthority]);
    const { config } = recording.opened[0] as { config: GrpcChannelConfig };
    expect(config).toMatchObject({ target: options.target, receiveCapBytes: OXIA_RECEIVE_CAP_BYTES, retries: "none" });
    expect("tls" in config).toBe(false);
    const status = { code: 1, details: "Cancelled on client", message: "1 CANCELLED: Cancelled on client" };
    const unsent = config.unsent(status as ServiceError);
    expect(unsent).toBeInstanceOf(OxiaUnsentStatus);
    expect((unsent as OxiaUnsentStatus).code).toBe(1);
    expect((unsent as OxiaUnsentStatus).details).toBe("Cancelled on client");

    const tlsOptions = optionsFor(6648, { ssl: { mode: "verify-full", caCert: loadTlsFixtures().ca } });
    const tlsRecording = recordingTransport({
      channel: () => fakeChannel({ unary: () => Promise.resolve({ status: "SERVING" }) }),
    });
    expect(await client(tlsOptions, tlsRecording.transport).health(callOf())).toBe("SERVING");
    expect(tlsRecording.opened[0]?.config).toMatchObject({
      target: tlsOptions.target,
      tls: tlsOptions.tls as object,
      receiveCapBytes: OXIA_RECEIVE_CAP_BYTES,
      retries: "none",
    });
  });

  test("a bootstrap leader reuses the bootstrap channel; each listed leader gets one channel of its own", async () => {
    const { a, b, options, recording } = await cluster();
    expect(recording.opened.map((entry) => entry.address)).toEqual([`127.0.0.1:${a.port}`, `localhost:${b.port}`]);
    expect(recording.opened[0]?.config.target).toBe(options.target);
    expect(recording.opened[1]?.config.target).toBe(`dns:localhost:${b.port}`);
    const shardsRead = (served: Served) =>
      served.seen.calls
        .filter((call) => call.path.endsWith("/Read"))
        .map((call) => (call.request as { shard: string }).shard);
    expect(shardsRead(a)).toEqual(["0", "0"]);
    expect(shardsRead(b)).toEqual(["1", "1"]);
  });

  test("a listed leader's TLS identity is its own host", async () => {
    const assignments = assignmentsMessage(["oxia-1.example:6648", "10.0.0.7:6648", "[fd00::7]:6648"]);
    const recording = recordingTransport({
      channel: () =>
        fakeChannel({
          serverStream: (method) =>
            scriptedStream(
              methodOf(method.path) === "GetShardAssignments"
                ? [assignments]
                : [{ gets: [{ status: "KEY_NOT_FOUND" }] }],
            ),
        }),
    });
    const options = optionsFor(6648, {
      ssl: { mode: "verify-full", caCert: loadTlsFixtures().ca },
      dataServers: "oxia-1.example:6648, 10.0.0.7:6648, [fd00::7]:6648",
    });
    const oxia = client(options, recording.transport);
    const snapshot = await oxia.getSnapshot(callOf());
    for (const shard of snapshot.shards) {
      // oxlint-disable-next-line no-await-in-loop -- one shard at a time, so the channels open in shard order.
      await oxia.read(shard, [GET_A], callOf());
    }
    const config = (address: string) => recording.opened.find((entry) => entry.address === address)?.config;
    expect(config("oxia-1.example:6648")).toMatchObject({
      target: "dns:oxia-1.example:6648",
      tls: { identity: "oxia-1.example", serverNameOverride: "oxia-1.example" },
      receiveCapBytes: OXIA_RECEIVE_CAP_BYTES,
      retries: "none",
    });
    expect(config("10.0.0.7:6648")).toMatchObject({
      target: "dns:10.0.0.7:6648",
      tls: { identity: "10.0.0.7", serverNameOverride: "oxia.invalid" },
    });
    // An IPv6 leader's identity is its bare address, without the brackets it is written in (decision D6).
    expect(config("[fd00::7]:6648")).toMatchObject({
      target: "dns:[fd00::7]:6648",
      tls: { identity: "fd00::7", identityIsIp: true, serverNameOverride: "oxia.invalid" },
    });
    expect(recording.opened.map((entry) => entry.address)).toEqual([
      "127.0.0.1:6648",
      "oxia-1.example:6648",
      "10.0.0.7:6648",
      "[fd00::7]:6648",
    ]);
  });

  test("no channel option sets the authority (SB1-4.7)", () => {
    const keys = Object.keys(
      grpcChannelOptions({ receiveCapBytes: OXIA_RECEIVE_CAP_BYTES, retries: "none", serverNameOverride: "x" }),
    );
    expect(keys).not.toContain("grpc.default_authority");
  });

  test("close() closes every channel once, and every later call is closed", async () => {
    const { oxia, recording, snapshot } = await cluster();
    oxia.close();
    oxia.close();
    expect(recording.closed.length).toBe(2);
    const shard = snapshot.shards[0] as OxiaShard;
    expect(expectOxiaError(await failure(oxia.read(shard, [GET_A], callOf())), "closed").rpc).toBe("Read");
    expectOxiaError(await failure(oxia.getSnapshot(callOf())), "closed");
    expectOxiaError(await failure(oxia.health(callOf())), "closed");
    expectOxiaError(await streamFailure(() => oxia.list(shard, RANGE, streamOf())), "closed");
    expect(recording.opened.length).toBe(2);
  });

  test("a call pending when close() runs fails closed", async () => {
    const { port, seen } = await serve({ read: () => undefined });
    const options = optionsFor(port);
    const oxia = client(options);
    const pending = failure(oxia.read(bootstrapShard(options), [GET_A], callOf()));
    await eventually(() => seen.calls.length === 1);
    oxia.close();
    const error = expectOxiaError(await pending, "closed");
    expect(error.rpc).toBe("Read");
  });
});

const GET_A: OxiaGet = { key: "/a", includeValue: false, comparison: "EQUAL" };
const RANGE = { startInclusive: "a", endExclusive: "z" } as const;

/** A two-server cluster: A serves the snapshot and shard 0, B (listed under Data servers) shard 1; each shard read twice. */
async function cluster() {
  const b = await serve({ read: answer({ gets: [{ status: "KEY_NOT_FOUND" }] }) });
  let leaders: string[] = [];
  const a = await serve({
    assignments: (call) => holdAfter(assignmentsMessage(leaders))(call),
    read: answer({ gets: [{ status: "KEY_NOT_FOUND" }] }),
  });
  leaders = [`127.0.0.1:${a.port}`, `localhost:${b.port}`];
  const options = optionsFor(a.port, { dataServers: `localhost:${b.port}` });
  const recording = recordingTransport();
  const oxia = client(options, recording.transport);
  const snapshot = await oxia.getSnapshot(callOf());
  const [first, second] = snapshot.shards as [OxiaShard, OxiaShard];
  await oxia.read(first, [GET_A], callOf());
  await oxia.read(second, [GET_A], callOf());
  await oxia.read(first, [GET_A], callOf());
  await oxia.read(second, [GET_A], callOf());
  return { a, b, options, recording, oxia, snapshot };
}

/** A server whose snapshot names itself, by the address the script reads once the port is known. */
async function selfServing(
  script: Script = {},
  leadersOf: (port: number) => string[] = (port) => [`127.0.0.1:${port}`],
) {
  let leaders: string[] = [];
  const served = await serve({ assignments: (call) => holdAfter(assignmentsMessage(leaders))(call), ...script });
  leaders = leadersOf(served.port);
  return served;
}

// -- the authority ---------------------------------------------------------------------------------------------------

describe("the authority Studio sends (SB1-4.7)", () => {
  test("the recorded :authority is the sent authority, byte for byte", async () => {
    const { port, seen } = await serve();
    const expected: Record<string, string> = {
      "127.0.0.1": `127.0.0.1:${port}`,
      LOCALHOST: `localhost:${port}`,
      "[::1]": `[::1]:${port}`,
      "[0:0::1]": `[0:0::1]:${port}`,
    };
    for (const [host, authority] of Object.entries(expected)) {
      const options = optionsFor(port, { host });
      expect(options.sentAuthority).toBe(authority);
      // oxlint-disable-next-line no-await-in-loop -- one host at a time, so each recorded call is that host's.
      expect(await client(options).health(callOf())).toBe("SERVING");
      expect(seen.calls.at(-1)?.authority).toBe(options.sentAuthority);
    }
    expect(seen.calls.length).toBe(4);
  });
});

// -- metadata --------------------------------------------------------------------------------------------------------

describe("metadata (O7)", () => {
  test("every call carries the bearer token and nothing else; without a token, none does", async () => {
    const served = await selfServing({
      read: answer({ gets: [{ status: "KEY_NOT_FOUND" }] }),
      list: answer({ keys: ["a"] }),
      rangeScan: answer({ records: [] }),
    });
    const bare = client(optionsFor(served.port));
    expect(await bare.health(callOf())).toBe("SERVING");
    const baseline = served.seen.calls[0] as SeenCall;
    expect(baseline.authorization).toBeUndefined();

    const oxia = client(optionsFor(served.port, { password: TEST_TOKEN }));
    const snapshot = await oxia.getSnapshot(callOf());
    const shard = snapshot.shards[0] as OxiaShard;
    await oxia.read(shard, [GET_A], callOf());
    await oxia.list(shard, RANGE, streamOf()).next();
    await oxia.rangeScan(shard, RANGE, streamOf()).next();
    await oxia.health(callOf());
    const tokened = served.seen.calls.slice(1);
    expect(tokened.map((call) => methodOf(call.path))).toEqual([
      "GetShardAssignments",
      "Read",
      "List",
      "RangeScan",
      "Check",
    ]);
    for (const call of tokened) {
      expect(call.authorization).toBe(`Bearer ${TEST_TOKEN}`);
      expect(call.keys.filter((key) => !baseline.keys.includes(key))).toEqual(["authorization"]);
    }

    const plain = client(optionsFor(served.port));
    const plainShard = (await plain.getSnapshot(callOf())).shards[0] as OxiaShard;
    await plain.read(plainShard, [GET_A], callOf());
    await plain.list(plainShard, RANGE, streamOf()).next();
    await plain.rangeScan(plainShard, RANGE, streamOf()).next();
    for (const call of served.seen.calls.slice(6)) expect(call.authorization).toBeUndefined();
  });
});

// -- getSnapshot -----------------------------------------------------------------------------------------------------

describe("getSnapshot (SB1-2.3, SB1-5.1, SB1-9.4)", () => {
  test("the first message, then cancel", async () => {
    let leaders: string[] = [];
    const served = await serve({ assignments: (call) => holdAfter(assignmentsMessage(leaders))(call) });
    leaders = [`127.0.0.1:${served.port}`, `127.0.0.1:${served.port}`];
    const before = Date.now();
    const snapshot = await client(optionsFor(served.port)).getSnapshot(callOf());
    const after = Date.now();
    const leader = { host: "127.0.0.1", port: served.port, address: `127.0.0.1:${served.port}`, bootstrap: true };
    expect(snapshot.namespace).toBe("default");
    expect(snapshot.shards).toEqual([
      { id: "0", minHash: 0, maxHash: 0x7fffffff, leader },
      { id: "1", minHash: 0x80000000, maxHash: 0xffffffff, leader },
    ]);
    expect(snapshot.readAt).toBeGreaterThanOrEqual(before);
    expect(snapshot.readAt).toBeLessThanOrEqual(after);
    await eventually(() => served.seen.cancelled === 1);
    expect(served.seen.cancelled).toBe(1);
    expect(served.seen.calls[0]?.request).toMatchObject({ namespace: "default" });
  });

  test("the shards are sorted by minHash", async () => {
    const message = assignmentsMessage(["127.0.0.1:6648", "127.0.0.1:6648"]);
    const entry = message.namespaces.default as WireNamespace;
    entry.assignments.reverse();
    const recording = recordingTransport({
      channel: () => fakeChannel({ serverStream: () => scriptedStream([message]) }),
    });
    const snapshot = await client(optionsFor(6648), recording.transport).getSnapshot(callOf());
    expect(snapshot.shards.map((shard) => shard.id)).toEqual(["0", "1"]);
  });

  test("the namespace is the connection's", async () => {
    let leaders: string[] = [];
    const served = await serve({ assignments: (call) => holdAfter(assignmentsMessage(leaders, "Tenant"))(call) });
    leaders = [`127.0.0.1:${served.port}`];
    const recording = recordingTransport();
    const snapshot = await client(optionsFor(served.port, { database: "Tenant" }), recording.transport).getSnapshot(
      callOf(),
    );
    expect(snapshot.namespace).toBe("Tenant");
    expect(snapshot.shards.length).toBe(1);
    expect(recording.calls[0]?.request).toEqual({ namespace: "Tenant" });
  });

  test("a silent server is silent-assignments at the deadline", async () => {
    const { port } = await serve({ assignments: () => undefined });
    expectOxiaError(await failure(client(optionsFor(port)).getSnapshot(callOf(300))), "silent-assignments");
  });

  test("NotFound is namespace-not-found", async () => {
    const { port } = await serve({ assignments: fail(5) });
    expectOxiaError(await failure(client(optionsFor(port)).getSnapshot(callOf())), "namespace-not-found");
  });

  test("an invalid map is snapshot-invalid", async () => {
    const gap = assignmentsMessage(["127.0.0.1:6648", "127.0.0.1:6648"]);
    const range = (gap.namespaces.default as WireNamespace).assignments[1]?.int32_hash_range as WireRange;
    range.min_hash_inclusive += 1;
    const over = (message: object) =>
      recordingTransport({ channel: () => fakeChannel({ serverStream: () => scriptedStream([message]) }) }).transport;
    const gapError = expectOxiaError(
      await failure(client(optionsFor(6648), over(gap)).getSnapshot(callOf())),
      "snapshot-invalid",
    );
    expect(gapError.snapshotProblem).toBe("range-gap-or-overlap");
    const badLeader = expectOxiaError(
      await failure(client(optionsFor(6648), over(assignmentsMessage(["http://x:1"]))).getSnapshot(callOf())),
      "snapshot-invalid",
    );
    expect(badLeader.snapshotProblem).toBe("leader");
  });

  test("a leader the policy refuses is leader-refused, and is never dialled", async () => {
    const served = await selfServing({}, (port) => [`127.0.0.1:${port}`, "oxia-9.example:6648"]);
    const options = optionsFor(served.port);
    const recording = recordingTransport();
    const error = expectOxiaError(
      await failure(client(options, recording.transport).getSnapshot(callOf())),
      "leader-refused",
    );
    const refusal = admitLeaders(options, [`127.0.0.1:${served.port}`, "oxia-9.example:6648"]).refusal;
    expect(refusal).toBeDefined();
    expect(error.sentence).toBe(refusal as string);
    expect(recording.opened.map((entry) => entry.address)).toEqual([options.sentAuthority]);
  });

  test("a map past the receive cap is snapshot-invalid, too-large", async () => {
    const recording = recordingTransport({
      channel: () => fakeChannel({ serverStream: () => scriptedStream([], RECEIVE_CAP_FAILURE) }),
    });
    const error = expectOxiaError(
      await failure(client(optionsFor(6648), recording.transport).getSnapshot(callOf())),
      "snapshot-invalid",
    );
    expect(error.snapshotProblem).toBe("too-large");
  });

  test("any other stream failure is classified", async () => {
    const recording = recordingTransport({
      channel: () => fakeChannel({ serverStream: () => scriptedStream([], { code: 16, details: "empty token" }) }),
    });
    const error = expectOxiaError(
      await failure(client(optionsFor(6648), recording.transport).getSnapshot(callOf())),
      "unauthenticated",
    );
    expect(error.rpc).toBe("GetShardAssignments");
  });

  test("a stream that ends with no message is malformed", async () => {
    const { port } = await serve({ assignments: answer() });
    expectOxiaError(await failure(client(optionsFor(port)).getSnapshot(callOf())), "malformed");
  });

  test("the stream's limit is the receive cap", async () => {
    const recording = recordingTransport({
      channel: () => fakeChannel({ serverStream: () => scriptedStream([assignmentsMessage(["127.0.0.1:6648"])]) }),
    });
    const call = callOf();
    await client(optionsFor(6648), recording.transport).getSnapshot(call);
    const [sent] = recording.calls;
    expect(sent?.path).toBe(`/${CLIENT_SERVICE}/GetShardAssignments`);
    expect(sent?.limits).toEqual({ maxReceivedBytes: OXIA_RECEIVE_CAP_BYTES });
    expect(sent?.call.deadline).toEqual(new Date(call.deadline));
    expect(sent?.call.signal).toBe(call.signal);
  });
});

interface WireRange {
  min_hash_inclusive: number;
  max_hash_inclusive: number;
}
interface WireNamespace {
  assignments: { shard: string; leader: string; int32_hash_range: WireRange }[];
  shard_key_router: string;
}

// -- read ------------------------------------------------------------------------------------------------------------

/** A server whose Read answers the next script of `reads`, in order. */
async function readServer(reads: StreamHandler[]) {
  const served = await serve({
    read: (call) => (reads.shift() as StreamHandler)(call),
  });
  const options = optionsFor(served.port);
  const recording = recordingTransport();
  return { ...served, options, recording, oxia: client(options, recording.transport), shard: bootstrapShard(options) };
}

describe("read (SB1-2.3, F16, C13)", () => {
  test("an EQUAL answer has the asked key; a comparison answer keeps the server's", async () => {
    const { oxia, shard, recording } = await readServer([
      answer(
        {
          gets: [
            { status: "OK", version: VERSION_WIRE, value: Buffer.from("v") },
            { status: "OK", key: "/a/z", version: { ...VERSION_WIRE, session_id: "12", client_identity: "cli" } },
          ],
        },
        { gets: [{ status: "KEY_NOT_FOUND" }] },
      ),
    ]);
    const gets: OxiaGet[] = [
      { key: "/a", comparison: "EQUAL", includeValue: true },
      { key: "/b", comparison: "FLOOR", includeValue: false },
      { key: "/c", comparison: "EQUAL", includeValue: false },
    ];
    const records = await oxia.read(shard, gets, callOf());
    expect(records).toEqual([
      { status: "OK", key: "/a", version: VERSION, value: new Uint8Array([118]) },
      { status: "OK", key: "/a/z", version: { ...VERSION, sessionId: "12", clientIdentity: "cli" } },
      { status: "KEY_NOT_FOUND" },
    ]);
    const [first, second, third] = records as [object, object, object];
    expect(Object.keys(first).sort()).toEqual(["key", "status", "value", "version"]);
    expect(Object.keys(second).sort()).toEqual(["key", "status", "version"]);
    expect(Object.keys(third)).toEqual(["status"]);
    expect(Object.keys((first as { version: object }).version).sort()).toEqual(Object.keys(VERSION).sort());
    const value = (first as { value: Uint8Array }).value;
    expect(value).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(value)).toBe(false);
    expect(recording.calls[0]?.request).toEqual({
      shard: "0",
      gets: [
        { key: "/a", include_value: true, comparison_type: "EQUAL" },
        { key: "/b", include_value: false, comparison_type: "FLOOR" },
        { key: "/c", include_value: false, comparison_type: "EQUAL" },
      ],
    });
  });

  test("an index answer keeps its secondary key", async () => {
    const { oxia, shard, recording } = await readServer([
      answer({ gets: [{ status: "OK", key: "/p", secondary_index_key: "alice", version: VERSION_WIRE }] }),
    ]);
    const records = await oxia.read(
      shard,
      [{ key: "alice", comparison: "FLOOR", includeValue: false, secondaryIndexName: "by-name" }],
      callOf(),
    );
    expect(records).toEqual([{ status: "OK", key: "/p", version: VERSION, secondaryIndexKey: "alice" }]);
    expect(recording.calls[0]?.request).toEqual({
      shard: "0",
      gets: [{ key: "alice", include_value: false, comparison_type: "FLOOR", secondary_index_name: "by-name" }],
    });
  });

  test("what the client cannot read is malformed", async () => {
    const ok = { status: "OK", version: VERSION_WIRE };
    const { oxia, shard } = await readServer([
      answer({ gets: [{ status: 4, version: VERSION_WIRE }] }),
      answer({ gets: [ok] }),
      answer({ gets: [ok] }),
      answer({ gets: [ok, ok] }),
      answer({ gets: [{ status: "OK" }] }),
      answer({ gets: [ok] }),
    ]);
    const floor: OxiaGet = { key: "/b", comparison: "FLOOR", includeValue: false };
    // F16 supplies the asked key to an EQUAL get without an index only; an index answer must carry its primary key.
    const indexed: OxiaGet = { ...GET_A, secondaryIndexName: "by-name" };
    for (const gets of [[GET_A], [floor], [GET_A, GET_A], [GET_A], [GET_A], [indexed]]) {
      // oxlint-disable-next-line no-await-in-loop -- the server answers its scripts in order.
      const error = expectOxiaError(await failure(oxia.read(shard, gets, callOf())), "malformed");
      expect(error.rpc).toBe("Read");
    }
  });

  test("an answer that asked the value and carries none is the empty value; one that asked none has none (ruling R28)", async () => {
    // The server's own shape for an empty value: an OK answer whose `value` field is not on the wire.
    const { oxia, shard } = await readServer([
      answer({
        gets: [
          { status: "OK", version: VERSION_WIRE },
          { status: "OK", version: VERSION_WIRE, value: Buffer.from("v") },
          { status: "OK", key: "/c", version: VERSION_WIRE },
        ],
      }),
    ]);
    const records = await oxia.read(
      shard,
      [
        { key: "/a", comparison: "EQUAL", includeValue: true },
        { key: "/b", comparison: "EQUAL", includeValue: true },
        { key: "/c", comparison: "FLOOR", includeValue: false },
      ],
      callOf(),
    );
    expect(records).toEqual([
      { status: "OK", key: "/a", version: VERSION, value: new Uint8Array(0) },
      { status: "OK", key: "/b", version: VERSION, value: new Uint8Array([118]) },
      { status: "OK", key: "/c", version: VERSION },
    ]);
    const [empty, , unasked] = records as [{ value: Uint8Array }, object, object];
    expect(empty.value).toBeInstanceOf(Uint8Array);
    expect(empty.value.byteLength).toBe(0);
    expect(Object.keys(unasked).sort()).toEqual(["key", "status", "version"]);
  });

  test("a Read cut by its 8 MiB stream limit is receive-cap with answered", async () => {
    const big = { status: "OK", version: VERSION_WIRE, value: Buffer.alloc(3 * 1024 * 1024, 1) };
    const { oxia, shard, port } = await readServer([
      answer({ gets: [big] }, { gets: [big] }, { gets: [big] }, { gets: [big] }),
    ]);
    const withValue: OxiaGet = { ...GET_A, includeValue: true };
    const gets = [withValue, withValue, withValue, withValue];
    const error = expectOxiaError(await failure(oxia.read(shard, gets, callOf())), "receive-cap");
    expect(error.answered).toBe(3);
    expect(error.rpc).toBe("Read");
    expect(error.shardId).toBe("0");
    expect(error.leader).toBe(`127.0.0.1:${port}`);
  });

  test("a Read cut by the call's own received-bytes limit is receive-cap with answered (ruling R24)", async () => {
    const big = { status: "OK", version: VERSION_WIRE, value: Buffer.alloc(3 * 1024 * 1024, 1) };
    const { oxia, shard } = await readServer([
      answer({ gets: [big] }, { gets: [big] }, { gets: [big] }, { gets: [big] }),
    ]);
    const withValue: OxiaGet = { ...GET_A, includeValue: true };
    const call = { ...callOf(), maxReceivedBytes: 4 * 1024 * 1024 };
    const error = expectOxiaError(
      await failure(oxia.read(shard, [withValue, withValue, withValue], call)),
      "receive-cap",
    );
    expect(error.answered).toBe(2);
    expect(error.rpc).toBe("Read");
  });

  test("a Read whose last message crosses the stream limit answers every get", async () => {
    const big = { status: "OK", version: VERSION_WIRE, value: Buffer.alloc(3 * 1024 * 1024, 1) };
    const { oxia, shard } = await readServer([answer({ gets: [big] }, { gets: [big] }, { gets: [big] })]);
    const withValue: OxiaGet = { ...GET_A, includeValue: true };
    const records = await oxia.read(shard, [withValue, withValue, withValue], callOf());
    expect(records.length).toBe(3);
    for (const record of records) expect(record.value?.length).toBe(3 * 1024 * 1024);
  });

  test("a receive-cap failure from the channel carries answered", async () => {
    const ok = { gets: [{ status: "KEY_NOT_FOUND" }] };
    const recording = recordingTransport({
      channel: () => fakeChannel({ serverStream: () => scriptedStream([ok, ok], RECEIVE_CAP_FAILURE) }),
    });
    const options = optionsFor(6648);
    const oxia = client(options, recording.transport);
    const error = expectOxiaError(
      await failure(oxia.read(bootstrapShard(options), [GET_A, GET_A, GET_A], callOf())),
      "receive-cap",
    );
    expect(error.answered).toBe(2);
    expect(error.rpc).toBe("Read");
  });

  test("the batch bound", async () => {
    const { oxia, shard, recording, seen } = await readServer([]);
    for (const gets of [Array.from({ length: OXIA_READ_BATCH_GETS + 1 }, () => GET_A), []]) {
      // oxlint-disable-next-line no-await-in-loop -- each refusal is checked on its own.
      const error = await failure(oxia.read(shard, gets, callOf()));
      expect(error).toBeInstanceOf(RangeError);
      expect((error as RangeError).message).toBe("A Read sends 1 to 1,000 gets");
    }
    expect(recording.opened).toEqual([]);
    expect(seen.calls).toEqual([]);
  });

  test("a shard failure names its shard and leader", async () => {
    const { oxia, shard, options, port } = await readServer([fail(106)]);
    const error = expectOxiaError(await failure(oxia.read(shard, [GET_A], callOf())), "not-leader");
    expect(error.shardId).toBe("0");
    expect(error.leader).toBe(`127.0.0.1:${port}`);
    const worded = toProviderError(error, { operation: "get", connection: oxiaErrorConnection(options) });
    expect(worded.message).toBe(
      `The data server at 127.0.0.1:${port} is no longer the leader of shard 0, so the get stopped: run it again, and Studio reads the shard map afresh.`,
    );
  });

  test("the stream's limit is the run budget", async () => {
    const recording = recordingTransport({
      channel: () => fakeChannel({ serverStream: () => scriptedStream([{ gets: [{ status: "KEY_NOT_FOUND" }] }]) }),
    });
    const options = optionsFor(6648);
    await client(options, recording.transport).read(bootstrapShard(options), [GET_A], callOf());
    expect(recording.calls[0]?.path).toBe(`/${CLIENT_SERVICE}/Read`);
    expect(recording.calls[0]?.limits).toEqual({ maxReceivedBytes: OXIA_RUN_BYTE_BUDGET });
  });

  test("a call's received-bytes limit is the Read stream's (ruling R24)", async () => {
    const recording = recordingTransport({
      channel: () => fakeChannel({ serverStream: () => scriptedStream([{ gets: [{ status: "KEY_NOT_FOUND" }] }]) }),
    });
    const options = optionsFor(6648);
    const call = { ...callOf(), maxReceivedBytes: 4_096 };
    await client(options, recording.transport).read(bootstrapShard(options), [GET_A], call);
    expect(recording.calls[0]?.path).toBe(`/${CLIENT_SERVICE}/Read`);
    expect(recording.calls[0]?.limits).toEqual({ maxReceivedBytes: 4_096 });
  });
});

// -- refusals --------------------------------------------------------------------------------------------------------

describe("refusals before any request (SB1-4.9, C10)", () => {
  async function fresh() {
    const served = await serve();
    const options = optionsFor(served.port);
    const recording = recordingTransport();
    return { ...served, recording, oxia: client(options, recording.transport), shard: bootstrapShard(options) };
  }

  /** Runs `attempt` on a fresh client and returns its error, after checking that nothing was opened or sent. */
  async function refused(attempt: (oxia: OxiaClient, shard: OxiaShard) => Promise<unknown>): Promise<unknown> {
    const { oxia, shard, recording, seen } = await fresh();
    const error = await attempt(oxia, shard);
    expect(recording.opened).toEqual([]);
    expect(seen.calls).toEqual([]);
    return error;
  }

  const LONE = "a\ud800b";

  test("a Read key under __oxia/", async () => {
    expectRefusal(
      await refused((oxia, shard) => failure(oxia.read(shard, [{ ...GET_A, key: "__oxia/x" }], callOf()))),
      OXIA_ADAPTER_INTERNAL_KEY_SENTENCE,
    );
  });

  test("a List or RangeScan start under __oxia/; an end of __oxia/ is allowed", async () => {
    const range = { startInclusive: "__oxia/a", endExclusive: "z" };
    expectRefusal(
      await refused((oxia, shard) => streamFailure(() => oxia.list(shard, range, streamOf()))),
      OXIA_ADAPTER_INTERNAL_KEY_SENTENCE,
    );
    expectRefusal(
      await refused((oxia, shard) => streamFailure(() => oxia.rangeScan(shard, range, streamOf()))),
      OXIA_ADAPTER_INTERNAL_KEY_SENTENCE,
    );
    const { oxia, shard, seen } = await fresh();
    expect(await oxia.list(shard, { startInclusive: "", endExclusive: "__oxia/" }, streamOf()).next()).toBeUndefined();
    expect(seen.calls.length).toBe(1);
  });

  test("a lone surrogate in a key, a bound or an index name", async () => {
    const attempts: ((oxia: OxiaClient, shard: OxiaShard) => Promise<unknown>)[] = [
      (oxia, shard) => failure(oxia.read(shard, [{ ...GET_A, key: LONE }], callOf())),
      (oxia, shard) => failure(oxia.read(shard, [{ ...GET_A, secondaryIndexName: LONE }], callOf())),
      (oxia, shard) => streamFailure(() => oxia.list(shard, { startInclusive: LONE, endExclusive: "" }, streamOf())),
      (oxia, shard) => streamFailure(() => oxia.list(shard, { startInclusive: "", endExclusive: LONE }, streamOf())),
      (oxia, shard) =>
        streamFailure(() => oxia.rangeScan(shard, { startInclusive: LONE, endExclusive: "" }, streamOf())),
      (oxia, shard) =>
        streamFailure(() => oxia.rangeScan(shard, { startInclusive: "", endExclusive: LONE }, streamOf())),
      (oxia, shard) => streamFailure(() => oxia.list(shard, { ...RANGE, secondaryIndexName: LONE }, streamOf())),
    ];
    for (const attempt of attempts) {
      // oxlint-disable-next-line no-await-in-loop -- each refusal on its own fresh client.
      expectRefusal(await refused(attempt), OXIA_LONE_SURROGATE_SENTENCE);
    }
  });

  test("an index name that is not one word of at most 300 bytes", async () => {
    // "\u00e9" is two UTF-8 bytes: 151 of them are 302 bytes in 151 UTF-16 code units, so the bound counts bytes.
    for (const name of ["", "a/b", "__oxia", "__oxiaX", "a".repeat(301), "\u00e9".repeat(151)]) {
      // oxlint-disable-next-line no-await-in-loop -- each refusal on its own fresh client.
      const error = await refused((oxia, shard) =>
        failure(oxia.read(shard, [{ ...GET_A, comparison: "FLOOR", secondaryIndexName: name }], callOf())),
      );
      expectRefusal(error, OXIA_INDEX_NAME_SENTENCE);
    }
    expectRefusal(
      await refused((oxia, shard) =>
        streamFailure(() => oxia.rangeScan(shard, { ...RANGE, secondaryIndexName: "a/b" }, streamOf())),
      ),
      OXIA_INDEX_NAME_SENTENCE,
    );
    const { oxia, shard, seen } = await fresh();
    await expect(
      oxia.read(shard, [{ ...GET_A, comparison: "FLOOR", secondaryIndexName: "a".repeat(300) }], callOf()),
    ).rejects.toMatchObject({ category: "malformed" });
    expect(seen.calls.length).toBe(1);
  });

  test("a signal already aborted sends nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = expectOxiaError(
      await refused((oxia, shard) => failure(oxia.read(shard, [GET_A], callOf(3_000, controller.signal)))),
      "cancelled",
    );
    expect(error.unsent).toBe(true);
  });
});

// -- list and rangeScan ----------------------------------------------------------------------------------------------

describe("list and rangeScan (SB1-2.3)", () => {
  async function streamServer(script: Script) {
    const served = await serve(script);
    const options = optionsFor(served.port);
    const recording = recordingTransport();
    return { ...served, recording, oxia: client(options, recording.transport), shard: bootstrapShard(options) };
  }

  test("one message at a time, in order, then the end", async () => {
    const { oxia, shard, recording } = await streamServer({
      list: (call) =>
        (call.request as { secondary_index_name?: string }).secondary_index_name === undefined
          ? answer({ keys: ["a", "b"] }, { keys: ["c"] })(call)
          : answer({ keys: ["p"] })(call),
    });
    const stream = oxia.list(shard, RANGE, streamOf());
    expect(await stream.next()).toEqual(["a", "b"]);
    expect(await stream.next()).toEqual(["c"]);
    expect(await stream.next()).toBeUndefined();
    expect(stream.truncated).toBe(false);
    expect(stream.receivedBytes).toBeGreaterThan(0);
    expect(recording.calls[0]?.request).toEqual({
      shard: "0",
      start_inclusive: "a",
      end_exclusive: "z",
      include_internal_keys: false,
    });
    const indexed = oxia.list(shard, { ...RANGE, secondaryIndexName: "by-name" }, streamOf());
    expect(await indexed.next()).toEqual(["p"]);
    expect(recording.calls[1]?.request).toEqual({
      shard: "0",
      start_inclusive: "a",
      end_exclusive: "z",
      include_internal_keys: false,
      secondary_index_name: "by-name",
    });
  });

  test("every List and RangeScan asks for no internal key", async () => {
    const { oxia, shard, recording, seen } = await streamServer({});
    const ranges = [RANGE, { startInclusive: "", endExclusive: "" }, { startInclusive: "/x", endExclusive: "/y" }];
    for (const range of ranges) {
      // oxlint-disable-next-line no-await-in-loop -- one stream at a time.
      expect(await oxia.list(shard, range, streamOf()).next()).toBeUndefined();
      // oxlint-disable-next-line no-await-in-loop -- one stream at a time.
      expect(await oxia.rangeScan(shard, range, streamOf()).next()).toBeUndefined();
    }
    expect(recording.calls.length).toBe(6);
    for (const call of recording.calls) expect(call.request).toMatchObject({ include_internal_keys: false });
    for (const call of seen.calls) expect(call.request).toMatchObject({ include_internal_keys: false });
  });

  test("the caller's limit is the stream's", async () => {
    const { oxia, shard, recording } = await streamServer({
      list: (call) => {
        let stopped = false;
        call.on("cancelled", () => {
          stopped = true;
        });
        const pump = () => {
          for (;;) {
            if (stopped) return;
            if (!call.write({ keys: ["k".repeat(1024)] })) {
              call.once("drain", pump);
              return;
            }
          }
        };
        pump();
      },
    });
    const stream = oxia.list(shard, RANGE, streamOf(64 * 1024));
    expect(recording.calls[0]?.limits).toEqual({ maxReceivedBytes: 64 * 1024 });
    let messages = 0;
    // oxlint-disable-next-line no-await-in-loop -- one reader reads the stream to its end.
    while ((await stream.next()) !== undefined) messages++;
    expect(messages).toBeGreaterThan(0);
    expect(stream.truncated).toBe(true);
    expect(stream.receivedBytes).toBeGreaterThanOrEqual(64 * 1024);
    stream.cancel();
    stream.cancel();
    expect(await stream.next()).toBeUndefined();
  });

  test("rangeScan answers records", async () => {
    const record = { status: "OK", key: "k", version: VERSION_WIRE, value: Buffer.from("v") };
    const { oxia, shard } = await streamServer({
      rangeScan: answer({ records: [record] }, { records: [{ status: "OK", version: VERSION_WIRE }] }),
    });
    const stream = oxia.rangeScan(shard, RANGE, streamOf());
    expect(await stream.next()).toEqual([{ status: "OK", key: "k", version: VERSION, value: new Uint8Array([118]) }]);
    const error = expectOxiaError(await failure(stream.next()), "malformed");
    expect(error.rpc).toBe("RangeScan");
  });

  test("a RangeScan record that carries no value is the empty value (ruling R28)", async () => {
    // The server's own shape for an empty value: a record whose `value` field is not on the wire.
    const { oxia, shard } = await streamServer({
      rangeScan: answer({ records: [{ status: "OK", key: "/values/empty", version: VERSION_WIRE }] }),
    });
    const stream = oxia.rangeScan(shard, RANGE, streamOf());
    const records = await stream.next();
    expect(records).toEqual([{ status: "OK", key: "/values/empty", version: VERSION, value: new Uint8Array(0) }]);
    const [first] = records as readonly object[];
    const value = (first as { value: Uint8Array }).value;
    expect(value).toBeInstanceOf(Uint8Array);
    expect(value.byteLength).toBe(0);
  });

  test("a stream failure is classified", async () => {
    const { oxia, shard } = await streamServer({ list: fail(5) });
    const error = expectOxiaError(await failure(oxia.list(shard, RANGE, streamOf()).next()), "shard-not-found");
    expect(error.shardId).toBe("0");
  });

  test("an abort while reading cancels", async () => {
    const { oxia, shard, seen } = await streamServer({ list: holdAfter({ keys: ["a"] }) });
    const controller = new AbortController();
    const stream = oxia.list(shard, RANGE, streamOf(OXIA_RUN_BYTE_BUDGET, 3_000, controller.signal));
    expect(await stream.next()).toEqual(["a"]);
    const pending = failure(stream.next());
    controller.abort();
    expectOxiaError(await pending, "cancelled");
    await eventually(() => seen.cancelled === 1);
    expect(seen.cancelled).toBe(1);
  });
});

// -- health ----------------------------------------------------------------------------------------------------------

describe("health (SB1-2.3)", () => {
  test("SERVING and NOT_SERVING answer as themselves; an unknown status is malformed; a failure is classified", async () => {
    const answers: ((callback: sendUnaryData<object>) => void)[] = [
      (callback) => callback(null, { status: "SERVING" }),
      (callback) => callback(null, { status: "NOT_SERVING" }),
      (callback) => callback(null, { status: 9 }),
      (callback) => callback({ code: 12, details: "the server's own text" }, null),
    ];
    const { port } = await serve({
      check: (_call, callback) => (answers.shift() as (c: typeof callback) => void)(callback),
    });
    const recording = recordingTransport();
    const oxia = client(optionsFor(port), recording.transport);
    expect(await oxia.health(callOf())).toBe("SERVING");
    expect(await oxia.health(callOf())).toBe("NOT_SERVING");
    expect(expectOxiaError(await failure(oxia.health(callOf())), "malformed").rpc).toBe("Health/Check");
    expect(expectOxiaError(await failure(oxia.health(callOf())), "unimplemented").rpc).toBe("Health/Check");
    expect(recording.calls[0]?.path).toBe(`/${HEALTH_SERVICE}/Check`);
    expect(recording.calls[0]?.request).toEqual({ service: "" });
  });
});
