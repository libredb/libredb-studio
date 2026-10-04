/**
 * The server-streaming call of src/lib/db/grpc/channel.ts against a local grpc-js server, as both runtimes run it:
 * under Bun inside tests/unit/db/grpc/server-stream.test.ts, and under Node in a child that runs a bundle of this
 * module, so both run the same code against the same server. No bun:test and no Bun global: this module loads in Node.
 */
import { type MethodDefinition, Server, ServerCredentials, type ServerWritableStream } from "@grpc/grpc-js";
import { type GrpcCall, openGrpcChannel } from "@/lib/db/grpc/channel";

const identity = (value: Buffer): Buffer => value;

/** One server-streaming method with identity serializers: a message is the Buffer the server wrote. */
export const STREAM = {
  path: "/transport.Test/Stream",
  requestStream: false,
  responseStream: true,
  requestSerialize: identity,
  requestDeserialize: identity,
  responseSerialize: identity,
  responseDeserialize: identity,
} as unknown as MethodDefinition<object, object>;

/**
 * What the server writes for a request: "three" writes the bytes 0, 1 and 2 and ends; "kib-forever" writes 1 KiB
 * messages until the call is cancelled, with back-pressure; "large-then-forever" writes one 100 KiB message, then 1 KiB
 * messages forever; "hold" writes nothing and never ends; "one-then-hold" writes one message and never ends;
 * "status-106" ends with status 106 at once; "two-then-status-106" writes two messages, then ends with status 106.
 */
export type StreamScript =
  | "three"
  | "kib-forever"
  | "large-then-forever"
  | "hold"
  | "one-then-hold"
  | "status-106"
  | "two-then-status-106";

export interface StreamServer {
  readonly server: Server;
  readonly target: string;
  /** What the server saw: bytes it wrote, calls it received, calls the client cancelled. */
  readonly seen: { written: number; calls: number; cancelled: number };
}

export const scriptRequest = (script: StreamScript): Buffer => Buffer.from(script);

export async function serveStreams(): Promise<StreamServer> {
  const seen = { written: 0, calls: 0, cancelled: 0 };
  const server = new Server();
  server.register(
    STREAM.path,
    (call: ServerWritableStream<Buffer, Buffer>) => {
      seen.calls++;
      let cancelled = false;
      call.on("cancelled", () => {
        cancelled = true;
        seen.cancelled++;
      });
      const script = call.request.toString() as StreamScript;
      const forever = (size: number) => {
        const payload = Buffer.alloc(size, 1);
        // A cancel arrives between ticks, never inside the loop, so each pump checks it once: on entry, and on each drain.
        const pump = () => {
          if (cancelled) return;
          for (;;) {
            seen.written += size;
            if (!call.write(payload)) {
              call.once("drain", pump);
              return;
            }
          }
        };
        pump();
      };
      if (script === "three") {
        for (const byte of [0, 1, 2]) {
          call.write(Buffer.from([byte]));
          seen.written += 1;
        }
        call.end();
      } else if (script === "kib-forever") {
        forever(1024);
      } else if (script === "large-then-forever") {
        call.write(Buffer.alloc(100 * 1024, 2));
        seen.written += 100 * 1024;
        forever(1024);
      } else if (script === "one-then-hold") {
        call.write(Buffer.from([0]));
        seen.written += 1;
      } else if (script === "status-106") {
        call.emit("error", { code: 106, details: "a custom status" });
      } else if (script === "two-then-status-106") {
        call.write(Buffer.from([0]));
        call.write(Buffer.from([1]));
        call.emit("error", { code: 106, details: "a custom status" });
      }
      // "hold" writes nothing and never ends; "one-then-hold" never ends after its one message.
    },
    identity,
    identity,
    "serverStream",
  );
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, bound) =>
      error ? reject(error) : resolve(bound),
    ),
  );
  return { server, target: `dns:127.0.0.1:${port}`, seen };
}

export interface ServerStreamOutcome {
  readonly name: string;
  readonly facts: Readonly<Record<string, number | boolean | string | readonly number[]>>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits, two seconds at most, until `condition` holds, checking every 20 ms. */
async function until(condition: () => boolean): Promise<void> {
  // oxlint-disable-next-line no-await-in-loop -- a poll: each check waits for the one before it.
  for (let waited = 0; waited < 2000 && !condition(); waited += 20) await sleep(20);
}

const callOf = (): GrpcCall => ({
  metadata: {},
  deadline: new Date(Date.now() + 10_000),
  signal: new AbortController().signal,
});

/** One case on its own server and its own channel, both closed whatever the case does. */
async function onServer(
  name: string,
  body: (
    channel: ReturnType<typeof openGrpcChannel>,
    seen: StreamServer["seen"],
  ) => Promise<ServerStreamOutcome["facts"]>,
): Promise<ServerStreamOutcome> {
  const { server, target, seen } = await serveStreams();
  const channel = openGrpcChannel({
    target,
    receiveCapBytes: 1024 * 1024,
    retries: "none",
    unsent: () => {
      throw new Error("unsent was called, though this call left the client");
    },
  });
  try {
    return { name, facts: await body(channel, seen) };
  } finally {
    channel.close();
    server.forceShutdown();
  }
}

/** SB1-3.4 cases 1, 2, 3, 3a and 4, in this order. */
export async function runServerStreamCases(): Promise<ServerStreamOutcome[]> {
  const outcomes: ServerStreamOutcome[] = [];
  outcomes.push(
    await onServer("in-order", async (channel, seen) => {
      const stream = channel.serverStream(STREAM, scriptRequest("three"), callOf(), {
        maxReceivedBytes: 1024 * 1024,
      });
      const bytes: number[] = [];
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- one reader: each read waits for the one before it.
        const message = (await stream.read()) as Buffer | undefined;
        if (message === undefined) break;
        bytes.push(message[0] as number);
      }
      const again = (await stream.read()) === undefined ? "undefined" : "message";
      return {
        bytes,
        truncated: stream.truncated,
        receivedBytes: stream.receivedBytes,
        written: seen.written,
        again,
      };
    }),
  );
  outcomes.push(
    await onServer("paused", async (channel, seen) => {
      const stream = channel.serverStream(STREAM, scriptRequest("kib-forever"), callOf(), {
        maxReceivedBytes: 1024 * 1024,
      });
      // oxlint-disable-next-line no-await-in-loop -- one reader: each read waits for the one before it.
      for (let read = 0; read < 10; read++) await stream.read();
      await sleep(500);
      const firstSample = seen.written;
      await sleep(200);
      const secondSample = seen.written;
      const receivedBytes = stream.receivedBytes;
      // Read before the cancel: a server stopped by the limit, not by the paused reader, would show true here.
      const truncated = stream.truncated;
      stream.cancel();
      return { firstSample, secondSample, receivedBytes, truncated };
    }),
  );
  outcomes.push(
    await onServer("limit", async (channel, seen) => {
      const stream = channel.serverStream(STREAM, scriptRequest("kib-forever"), callOf(), {
        maxReceivedBytes: 64 * 1024,
      });
      const lengths: number[] = [];
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- one reader: each read waits for the one before it.
        const message = (await stream.read()) as Buffer | undefined;
        if (message === undefined) break;
        lengths.push(message.length);
      }
      await until(() => seen.cancelled === 1);
      const again = (await stream.read()) === undefined ? "undefined" : "message";
      return {
        messages: lengths.length,
        everyMessageIsOneKiB: lengths.every((length) => length === 1024),
        truncated: stream.truncated,
        receivedBytes: stream.receivedBytes,
        cancelled: seen.cancelled,
        again,
      };
    }),
  );
  outcomes.push(
    await onServer("one-large", async (channel) => {
      const stream = channel.serverStream(STREAM, scriptRequest("large-then-forever"), callOf(), {
        maxReceivedBytes: 64 * 1024,
      });
      const first = (await stream.read()) as Buffer | undefined;
      const second = (await stream.read()) === undefined ? "undefined" : "message";
      return {
        firstLength: first?.length ?? 0,
        second,
        truncated: stream.truncated,
        receivedBytes: stream.receivedBytes,
      };
    }),
  );
  outcomes.push(
    await onServer("cancel-pending", async (channel, seen) => {
      const stream = channel.serverStream(STREAM, scriptRequest("hold"), callOf(), { maxReceivedBytes: 1024 });
      const read = stream.read();
      await until(() => seen.calls === 1);
      stream.cancel();
      stream.cancel();
      const pending = await read.then(
        (message) => (message === undefined ? "undefined" : "message"),
        () => "rejected",
      );
      await until(() => seen.cancelled === 1);
      const later = (await stream.read()) === undefined ? "undefined" : "message";
      return { pending, later, truncated: stream.truncated, cancelled: seen.cancelled };
    }),
  );
  return outcomes;
}
