/**
 * The one gRPC channel of the shared transport (src/lib/db/grpc/channel.ts), against a local grpc-js server built
 * from a two-method definition this file loads itself: a unary `Echo` and a bidirectional `Chat`.
 * The option set, exactly, as each provider opens it; a channel that dials nothing until a call; a unary call with
 * its metadata, its deadline and its own abort, before and after grpc-js picked a transport; a stream read in order,
 * to its end or its error; close(), which cancels every open stream first; and the receive cap.
 * The options test moved here from the etcd provider's transport tests, where it asserted etcd's shape; the Milvus
 * provider's copy asserted its own, which is the "none" case below.
 */
import { describe, expect, spyOn, test } from "bun:test";
import net, { type AddressInfo } from "node:net";
import {
  Client,
  type Metadata,
  Server,
  ServerCredentials,
  type ServerDuplexStream,
  type ServerUnaryCall,
  type ServiceDefinition,
  type sendUnaryData,
} from "@grpc/grpc-js";
import { fromJSON, type MethodDefinition } from "@grpc/proto-loader";
import { type GrpcCall, grpcChannelOptions, openGrpcChannel } from "@/lib/db/grpc/channel";
import { ClosingCredentials } from "@/lib/db/grpc/credentials";

/** The error a call rejects with; a call that answers fails the test. */
async function failure(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => {
      throw new Error("The call answered, though this test expects it to fail");
    },
    (error: unknown) => error,
  );
}

/** Waits, two seconds at most, until `condition` holds: a server's own events arrive after the client's answer. */
async function eventually(condition: () => boolean): Promise<void> {
  // oxlint-disable-next-line no-await-in-loop -- a poll: each check waits for the one before it.
  for (let waited = 0; waited < 2000 && !condition(); waited += 20) await Bun.sleep(20);
}

async function closedPort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address() as AddressInfo;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

const DEFINITION = fromJSON(
  {
    nested: {
      transport: {
        nested: {
          Note: { fields: { text: { type: "string", id: 1 } } },
          Test: {
            methods: {
              Echo: { requestType: "Note", responseType: "Note" },
              Chat: {
                requestType: "Note",
                responseType: "Note",
                requestStream: true,
                responseStream: true,
              },
            },
          },
        },
      },
    },
    // Asserted, not annotated: protobufjs's typings require a `comment` its own JSON omits.
  } as unknown as Parameters<typeof fromJSON>[0],
  { keepCase: true, defaults: true },
);
const SERVICE = DEFINITION["transport.Test"] as ServiceDefinition;
const ECHO = (DEFINITION["transport.Test"] as Record<string, MethodDefinition<object, object>>).Echo;
const CHAT = (DEFINITION["transport.Test"] as Record<string, MethodDefinition<object, object>>).Chat;

interface Note {
  readonly text: string;
}

/** What the server saw: each Echo's metadata, the calls it holds, and which of them were cancelled. */
interface Seen {
  readonly metadata: Metadata[];
  held: number;
  cancelled: number;
  chats: number;
}

/**
 * Echo answers "echo <text>"; "hold" never answers; "big" answers 2 KiB of text.
 * Chat answers its first message: "two" with two messages and the end, "none" with the end alone, "fail" with one
 * message and an error, "hold" with nothing.
 */
async function serve(): Promise<{ readonly server: Server; readonly target: string; readonly seen: Seen }> {
  const seen: Seen = { metadata: [], held: 0, cancelled: 0, chats: 0 };
  const server = new Server();
  server.addService(SERVICE, {
    Echo: (call: ServerUnaryCall<Note, Note>, callback: sendUnaryData<Note>) => {
      seen.metadata.push(call.metadata);
      if (call.request.text === "hold") {
        seen.held++;
        call.on("cancelled", () => {
          seen.cancelled++;
        });
        return;
      }
      if (call.request.text === "big") return callback(null, { text: "x".repeat(2048) });
      callback(null, { text: `echo ${call.request.text}` });
    },
    Chat: (call: ServerDuplexStream<Note, Note>) => {
      seen.chats++;
      call.on("cancelled", () => {
        seen.cancelled++;
      });
      call.once("data", (note: Note) => {
        if (note.text === "two") {
          call.write({ text: "one" });
          call.write({ text: "two" });
          call.end();
        } else if (note.text === "none") {
          call.end();
        } else if (note.text === "fail") {
          call.write({ text: "one" });
          call.emit("error", { code: 13, details: "the server failed the stream" });
        }
      });
    },
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, bound) =>
      error ? reject(error) : resolve(bound),
    ),
  );
  return { server, target: `dns:127.0.0.1:${port}`, seen };
}

const unsentNever = (): Error => {
  throw new Error("unsent was called, though this call left the client");
};

const callOf = (overrides: Partial<GrpcCall> = {}): GrpcCall => ({
  metadata: {},
  deadline: new Date(Date.now() + 5000),
  signal: new AbortController().signal,
  ...overrides,
});

describe("the channel's options", () => {
  const RECEIVE_CAP = 16 * 1024 * 1024;

  test("the options, exactly, plaintext: no service config from DNS, the receive cap, no environment proxy, the keepalive, and the retry stance the caller passes", () => {
    const base = {
      "grpc.service_config_disable_resolution": 1,
      "grpc.max_receive_message_length": RECEIVE_CAP,
      "grpc.enable_http_proxy": 0,
      // No grpc.keepalive_permit_without_calls: a server that enforces a ping minimum counts a ping with no call open as a strike.
      "grpc.keepalive_time_ms": 10_000,
      "grpc.keepalive_timeout_ms": 6_000,
    };
    // Transparent retries leave the key out, as grpc-js's own default does.
    expect(grpcChannelOptions({ receiveCapBytes: RECEIVE_CAP, retries: "transparent" })).toEqual(base);
    expect(grpcChannelOptions({ receiveCapBytes: RECEIVE_CAP, retries: "none" })).toEqual({
      ...base,
      "grpc.enable_retries": 0,
    });
  });

  test("TLS adds the override: a name, and the IP rule's server name", () => {
    const transparent = grpcChannelOptions({ receiveCapBytes: RECEIVE_CAP, retries: "transparent" });
    expect(
      grpcChannelOptions({
        receiveCapBytes: RECEIVE_CAP,
        retries: "transparent",
        serverNameOverride: "transport.test",
      }),
    ).toEqual({ ...transparent, "grpc.ssl_target_name_override": "transport.test" });
    const none = grpcChannelOptions({ receiveCapBytes: RECEIVE_CAP, retries: "none" });
    expect(
      grpcChannelOptions({ receiveCapBytes: RECEIVE_CAP, retries: "none", serverNameOverride: "server.invalid" }),
    ).toEqual({ ...none, "grpc.ssl_target_name_override": "server.invalid" });
  });
});

describe("over grpc-js: one channel, its calls and its close", () => {
  test("opening the channel dials nothing: only a call does", async () => {
    let accepted = 0;
    const listener = net.createServer((socket) => {
      accepted++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as AddressInfo).port;
    const channel = openGrpcChannel({
      target: `dns:127.0.0.1:${port}`,
      receiveCapBytes: 1024,
      retries: "none",
      unsent: unsentNever,
    });
    await Bun.sleep(100);
    expect(accepted).toBe(0);
    // The control: the same channel's first call is what dials.
    await failure(channel.unary(ECHO, { text: "a" }, callOf({ deadline: new Date(Date.now() + 2000) })));
    channel.close();
    listener.close();
    expect(accepted).toBeGreaterThan(0);
  }, 10_000);

  test("a unary call round-trips, with the call's metadata and nothing else", async () => {
    const { server, target, seen } = await serve();
    const channel = openGrpcChannel({ target, receiveCapBytes: 1024, retries: "transparent", unsent: unsentNever });
    try {
      const answer = await channel.unary(ECHO, { text: "a" }, callOf({ metadata: { token: "t1", hasleader: "true" } }));
      expect(answer).toEqual({ text: "echo a" });
      const received = seen.metadata[0].getMap();
      expect({ token: received.token, hasleader: received.hasleader }).toEqual({ token: "t1", hasleader: "true" });
      // The control: a call that attaches nothing sends neither key, so every other key is grpc-js's own.
      await channel.unary(ECHO, { text: "b" }, callOf());
      const own = Object.keys(seen.metadata[1].getMap());
      expect(Object.keys(received).filter((key) => !own.includes(key))).toEqual(["token", "hasleader"]);
    } finally {
      channel.close();
      server.forceShutdown();
    }
  }, 10_000);

  test("an abort before the pick is the provider's unsent error", async () => {
    const statuses: Array<{ readonly code: number }> = [];
    const unsent = new Error("never sent");
    const channel = openGrpcChannel({
      target: `dns:127.0.0.1:${await closedPort()}`,
      receiveCapBytes: 1024,
      retries: "none",
      unsent: (status) => {
        statuses.push(status);
        return unsent;
      },
    });
    const aborted = new AbortController();
    aborted.abort();
    try {
      expect(await failure(channel.unary(ECHO, { text: "a" }, callOf({ signal: aborted.signal })))).toBe(unsent);
      expect(statuses).toMatchObject([{ code: 1 }]);
    } finally {
      channel.close();
    }
  }, 10_000);

  test("an abort after the send is grpc-js's cancel, never unsent", async () => {
    const { server, target, seen } = await serve();
    const channel = openGrpcChannel({ target, receiveCapBytes: 1024, retries: "none", unsent: unsentNever });
    const controller = new AbortController();
    try {
      const pending = failure(channel.unary(ECHO, { text: "hold" }, callOf({ signal: controller.signal })));
      await eventually(() => seen.held === 1);
      controller.abort();
      expect(await pending).toMatchObject({ code: 1, details: "Cancelled on client" });
      await eventually(() => seen.cancelled === 1);
      expect(seen.cancelled).toBe(1);
    } finally {
      channel.close();
      server.forceShutdown();
    }
  }, 10_000);

  test("a deadline after the send is DEADLINE_EXCEEDED", async () => {
    const { server, target, seen } = await serve();
    const channel = openGrpcChannel({ target, receiveCapBytes: 1024, retries: "none", unsent: unsentNever });
    try {
      // The control call connects the channel, so the held call's deadline runs after its send.
      await channel.unary(ECHO, { text: "a" }, callOf());
      const error = await failure(
        channel.unary(ECHO, { text: "hold" }, callOf({ deadline: new Date(Date.now() + 300) })),
      );
      expect(error).toMatchObject({ code: 4 });
      expect(seen.held).toBe(1);
    } finally {
      channel.close();
      server.forceShutdown();
    }
  }, 10_000);

  test("a bidirectional stream reads its messages in order, then the end", async () => {
    const { server, target } = await serve();
    const channel = openGrpcChannel({ target, receiveCapBytes: 1024, retries: "none", unsent: unsentNever });
    try {
      const stream = channel.bidiStream(CHAT, callOf());
      stream.write({ text: "two" });
      // The first read waits for the message; the second finds it already arrived.
      expect(await stream.read()).toEqual({ text: "one" });
      await Bun.sleep(100);
      expect(await stream.read()).toEqual({ text: "two" });
      expect(await stream.read()).toBeUndefined();
      expect(await stream.read()).toBeUndefined();
      stream.cancel();
      // A reader that waits when the server ends reads the end.
      const ending = channel.bidiStream(CHAT, callOf());
      ending.write({ text: "none" });
      expect(await ending.read()).toBeUndefined();
      ending.cancel();
    } finally {
      channel.close();
      server.forceShutdown();
    }
  }, 10_000);

  test("a stream the server fails yields its messages, then the call's error, never a clean end", async () => {
    const { server, target } = await serve();
    const channel = openGrpcChannel({ target, receiveCapBytes: 1024, retries: "none", unsent: unsentNever });
    try {
      const stream = channel.bidiStream(CHAT, callOf());
      stream.write({ text: "fail" });
      expect(await stream.read()).toEqual({ text: "one" });
      // Every read after the message meets the call's error, never a clean end.
      expect(await failure(stream.read())).toMatchObject({ code: 13, details: "the server failed the stream" });
      expect(await failure(stream.read())).toMatchObject({ code: 13 });
      stream.cancel();
    } finally {
      channel.close();
      server.forceShutdown();
    }
  }, 10_000);

  test("close() cancels every open stream before it ends the sockets", async () => {
    const { server, target, seen } = await serve();
    const channel = openGrpcChannel({ target, receiveCapBytes: 1024, retries: "none", unsent: unsentNever });
    const stream = channel.bidiStream(CHAT, callOf());
    stream.write({ text: "hold" });
    await eventually(() => seen.chats === 1);
    const reading = failure(stream.read());
    channel.close();
    // Cancelled by the client, never a dropped connection's UNAVAILABLE.
    expect(await reading).toMatchObject({ code: 1, details: "Cancelled on client" });
    await eventually(() => seen.cancelled === 1);
    server.forceShutdown();
    expect(seen.cancelled).toBe(1);
  }, 10_000);

  test("close() runs its three steps in order: the open streams, then the client, then the sockets", async () => {
    const { server, target, seen } = await serve();
    const channel = openGrpcChannel({ target, receiveCapBytes: 1024, retries: "none", unsent: unsentNever });
    const stream = channel.bidiStream(CHAT, callOf());
    stream.write({ text: "hold" });
    await eventually(() => seen.chats === 1);
    const order: string[] = [];
    // close() ends each stream through the very object it handed out, so recording that object's method sees it.
    const cancelStream = stream.cancel.bind(stream);
    (stream as { cancel: () => void }).cancel = () => {
      order.push("stream");
      cancelStream();
    };
    const closeClient = Client.prototype.close;
    const clientClosed = spyOn(Client.prototype, "close").mockImplementation(function (this: Client) {
      order.push("client");
      closeClient.call(this);
    });
    const endSockets = ClosingCredentials.prototype.endEverySocket;
    const socketsEnded = spyOn(ClosingCredentials.prototype, "endEverySocket").mockImplementation(function (
      this: ClosingCredentials,
    ) {
      order.push("sockets");
      endSockets.call(this);
    });
    try {
      const reading = failure(stream.read());
      channel.close();
      await reading;
    } finally {
      clientClosed.mockRestore();
      socketsEnded.mockRestore();
      server.forceShutdown();
    }
    expect(order).toEqual(["stream", "client", "sockets"]);
  }, 10_000);

  test("a stream cancelled before close() is no longer the channel's", async () => {
    const channel = openGrpcChannel({
      target: `dns:127.0.0.1:${await closedPort()}`,
      receiveCapBytes: 1024,
      retries: "none",
      unsent: unsentNever,
    });
    const controller = new AbortController();
    const removed = spyOn(controller.signal, "removeEventListener");
    channel.bidiStream(CHAT, callOf({ signal: controller.signal })).cancel();
    expect(removed).toHaveBeenCalledTimes(1);
    channel.close();
    expect(removed).toHaveBeenCalledTimes(1);
  });

  test("an answer past the receive cap fails naming the cap and is never read", async () => {
    const { server, target } = await serve();
    const channel = openGrpcChannel({ target, receiveCapBytes: 1024, retries: "none", unsent: unsentNever });
    try {
      const error = await failure(channel.unary(ECHO, { text: "big" }, callOf()));
      expect(error).toMatchObject({ code: 8 });
      expect((error as { details: string }).details).toMatch(/^Received message larger than max \(\d+ vs 1024\)$/);
    } finally {
      channel.close();
      server.forceShutdown();
    }
  }, 10_000);
});
