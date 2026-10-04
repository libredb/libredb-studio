/**
 * The server-streaming call of the shared transport (src/lib/db/grpc/channel.ts), against a local grpc-js server with
 * one hand-made server-streaming method of identity serializers (tests/helpers/grpc-server-stream-cases.ts).
 * Paused reading, which stops the server; the received-byte limit, which ends the call from inside the deserializer
 * and delivers exactly the messages it counted; the caller's cancel, an abort before and after the pick, the deadline,
 * the receive cap, a custom status, close(), a limit that is not a whole number, and a message deserialized after the
 * limit's cancel.
 * The first five cases run under Bun here, and again in a Node child from a bundle of the same helper.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, type ClientReadableStream, type ServiceError } from "@grpc/grpc-js";
import { type GrpcCall, openGrpcChannel } from "@/lib/db/grpc/channel";
import {
  runServerStreamCases,
  STREAM,
  type ServerStreamOutcome,
  type StreamServer,
  scriptRequest,
  serveStreams,
} from "../../../helpers/grpc-server-stream-cases";

const HELPER = join(import.meta.dir, "../../../helpers/grpc-server-stream-cases.ts");

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

const unsentNever = (): Error => {
  throw new Error("unsent was called, though this call left the client");
};

const callOf = (overrides: Partial<GrpcCall> = {}): GrpcCall => ({
  metadata: {},
  deadline: new Date(Date.now() + 10_000),
  signal: new AbortController().signal,
  ...overrides,
});

/** A server and a channel to it, both closed after `body` whatever it does. */
async function withChannel(
  body: (channel: ReturnType<typeof openGrpcChannel>, served: StreamServer) => Promise<void>,
  receiveCapBytes = 1024 * 1024,
): Promise<void> {
  const served = await serveStreams();
  const channel = openGrpcChannel({ target: served.target, receiveCapBytes, retries: "none", unsent: unsentNever });
  try {
    await body(channel, served);
  } finally {
    channel.close();
    served.server.forceShutdown();
  }
}

function expectOutcomes(outcomes: readonly ServerStreamOutcome[]): void {
  const facts = Object.fromEntries(outcomes.map((outcome) => [outcome.name, outcome.facts]));
  // Case 1: in order, then the server's end, which is not a truncation.
  expect(facts["in-order"]).toEqual({
    bytes: [0, 1, 2],
    truncated: false,
    receivedBytes: 3,
    written: 3,
    again: "undefined",
  });
  // Case 2: the server stops writing while the reader is paused, and what was received is under the limit plus one message.
  expect(facts.paused.secondSample).toBe(facts.paused.firstSample);
  expect(facts.paused.receivedBytes as number).toBeLessThan(1024 * 1024 + 1024);
  expect(facts.paused.receivedBytes as number).toBeGreaterThanOrEqual(10 * 1024);
  // The server stopped because the reader paused, not because the stream reached its limit and cancelled.
  expect(facts.paused.truncated).toBe(false);
  // Case 3: exactly the counted messages, the last one the message that reached the limit.
  expect(facts.limit).toEqual({
    messages: 64,
    everyMessageIsOneKiB: true,
    truncated: true,
    receivedBytes: 64 * 1024,
    cancelled: 1,
    again: "undefined",
  });
  // Case 3a: one message larger than the limit still reaches the reader.
  expect(facts["one-large"]).toEqual({
    firstLength: 100 * 1024,
    second: "undefined",
    truncated: true,
    receivedBytes: 100 * 1024,
  });
  // Case 4: cancel() answers the pending read undefined, rejects nothing, and is idempotent.
  expect(facts["cancel-pending"]).toEqual({ pending: "undefined", later: "undefined", truncated: true, cancelled: 1 });
}

describe("a server stream, under Bun", () => {
  test("cases 1 to 4: order and end, paused reading, the limit, one large message, cancel with a read pending", async () => {
    expectOutcomes(await runServerStreamCases());
  }, 30_000);

  test("case 5: an abort after messages arrived rejects the pending read with grpc-js's cancel", async () => {
    await withChannel(async (channel, { seen }) => {
      const controller = new AbortController();
      const stream = channel.serverStream(
        STREAM,
        scriptRequest("one-then-hold"),
        callOf({ signal: controller.signal }),
        {
          maxReceivedBytes: 1024 * 1024,
        },
      );
      expect(await stream.read()).toEqual(Buffer.from([0]));
      const pending = stream.read();
      await Bun.sleep(100);
      controller.abort();
      const error = await failure(pending);
      expect(error).toMatchObject({ code: 1, details: "Cancelled on client" });
      expect(stream.truncated).toBe(false);
      expect(await failure(stream.read())).toBe(error);
      await eventually(() => seen.cancelled === 1);
      expect(seen.cancelled).toBe(1);
    });
  }, 10_000);

  test("case 6: an abort before the pick is the provider's unsent error", async () => {
    const statuses: Array<{ readonly code: number }> = [];
    const unsent = new Error("never sent");
    const channel = openGrpcChannel({
      target: `dns:127.0.0.1:${await closedPort()}`,
      receiveCapBytes: 1024 * 1024,
      retries: "none",
      unsent: (status: ServiceError) => {
        statuses.push(status);
        return unsent;
      },
    });
    const aborted = new AbortController();
    aborted.abort();
    try {
      const stream = channel.serverStream(STREAM, scriptRequest("three"), callOf({ signal: aborted.signal }), {
        maxReceivedBytes: 1024,
      });
      expect(await failure(stream.read())).toBe(unsent);
      expect(statuses).toMatchObject([{ code: 1 }]);
    } finally {
      channel.close();
    }
  }, 10_000);

  test("case 7: a server that never writes rejects the read with DEADLINE_EXCEEDED at the deadline", async () => {
    await withChannel(async (channel) => {
      const stream = channel.serverStream(
        STREAM,
        scriptRequest("hold"),
        callOf({ deadline: new Date(Date.now() + 300) }),
        { maxReceivedBytes: 1024 },
      );
      expect(await failure(stream.read())).toMatchObject({ code: 4 });
    });
  }, 10_000);

  test("case 8: a message past the receive cap rejects with RESOURCE_EXHAUSTED, counts nothing, and releases the stream", async () => {
    // close() cancels each stream of the open set through grpc-js's cancel, so counting that cancel on the call this
    // stream opened shows whether the stream was still in the set when the channel closed.
    let grpcCancels = 0;
    const makeRequest = Client.prototype.makeServerStreamRequest;
    const opened = spyOn(Client.prototype, "makeServerStreamRequest").mockImplementation(function (
      this: Client,
      ...args: Parameters<Client["makeServerStreamRequest"]>
    ) {
      const readable = (makeRequest as (...a: typeof args) => ClientReadableStream<object>).apply(this, args);
      const cancel = readable.cancel.bind(readable);
      readable.cancel = () => {
        grpcCancels++;
        cancel();
      };
      return readable;
    } as Client["makeServerStreamRequest"]);
    try {
      await withChannel(async (channel) => {
        const controller = new AbortController();
        const removed = spyOn(controller.signal, "removeEventListener");
        const stream = channel.serverStream(
          STREAM,
          scriptRequest("large-then-forever"),
          callOf({ signal: controller.signal }),
          { maxReceivedBytes: 1024 * 1024 },
        );
        const error = (await failure(stream.read())) as ServiceError;
        expect(error).toMatchObject({ code: 8 });
        expect(error.details).toMatch(/^Received message larger than max \(102400 vs 65536\)$/);
        expect(stream.receivedBytes).toBe(0);
        expect(removed).toHaveBeenCalledTimes(1);
        const cancelsBeforeClose = grpcCancels;
        channel.close();
        expect(grpcCancels).toBe(cancelsBeforeClose);
        expect(removed).toHaveBeenCalledTimes(1);
      }, 64 * 1024);
    } finally {
      opened.mockRestore();
    }
  }, 10_000);

  test("case 9: close() with an open stream cancels it, and its pending read rejects", async () => {
    await withChannel(async (channel, { seen }) => {
      const stream = channel.serverStream(STREAM, scriptRequest("hold"), callOf(), { maxReceivedBytes: 1024 });
      const pending = stream.read();
      await eventually(() => seen.calls === 1);
      channel.close();
      expect(await failure(pending)).toMatchObject({ code: 1, details: "Cancelled on client" });
      await eventually(() => seen.cancelled === 1);
      expect(seen.cancelled).toBe(1);
      expect(stream.truncated).toBe(false);
    });
  }, 10_000);

  test("case 10: a custom status code reaches the reader unchanged, and wins over messages not yet read", async () => {
    await withChannel(async (channel) => {
      const stream = channel.serverStream(STREAM, scriptRequest("status-106"), callOf(), { maxReceivedBytes: 1024 });
      expect(((await failure(stream.read())) as { readonly code: number }).code).toBe(106);
    });
    await withChannel(async (channel) => {
      const stream = channel.serverStream(STREAM, scriptRequest("two-then-status-106"), callOf(), {
        maxReceivedBytes: 1024,
      });
      await Bun.sleep(200);
      expect(((await failure(stream.read())) as { readonly code: number }).code).toBe(106);
    });
  }, 10_000);

  test("case 11: a limit that is not a whole number of at least 1 throws RangeError and opens no call", async () => {
    await withChannel(async (channel, { seen }) => {
      for (const maxReceivedBytes of [0, -1, 1.5, Number.NaN]) {
        expect(() => channel.serverStream(STREAM, scriptRequest("three"), callOf(), { maxReceivedBytes })).toThrow(
          RangeError,
        );
      }
      await Bun.sleep(100);
      expect(seen.calls).toBe(0);
    });
  }, 10_000);

  test("case 12: a message deserialized after the limit's cancel is neither counted nor kept (SB1-3.3 rule 1a)", async () => {
    // grpc-js 1.14.5 deserializes nothing after its own cancel, so no server reaches this rule. The stand-in hands the
    // stream's deserializer one more message as the cancel runs, the way a transport that kept reading would.
    const makeRequest = Client.prototype.makeServerStreamRequest;
    const opened = spyOn(Client.prototype, "makeServerStreamRequest").mockImplementation(function (
      this: Client,
      ...args: Parameters<Client["makeServerStreamRequest"]>
    ) {
      const readable = (makeRequest as (...a: typeof args) => ClientReadableStream<object>).apply(this, args);
      const deserialize = args[2] as (buffer: Buffer) => object;
      const cancel = readable.cancel.bind(readable);
      readable.cancel = () => {
        deserialize(Buffer.alloc(1024, 9));
        cancel();
      };
      return readable;
    } as Client["makeServerStreamRequest"]);
    try {
      await withChannel(async (channel) => {
        const stream = channel.serverStream(STREAM, scriptRequest("kib-forever"), callOf(), { maxReceivedBytes: 2048 });
        const read = [await stream.read(), await stream.read()];
        expect(await stream.read()).toBeUndefined();
        expect(read.map((message) => (message as Buffer).length)).toEqual([1024, 1024]);
        expect(stream.truncated).toBe(true);
        expect(stream.receivedBytes).toBe(2048);
      });
    } finally {
      opened.mockRestore();
    }
  }, 10_000);
});

describe("the same cases in a Node child, the production runtime", () => {
  let work = "";
  let version = "";
  let outcomes: ServerStreamOutcome[] = [];
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "grpc-server-stream-"));
    const node = Bun.which("node");
    if (node === null)
      throw new Error("No node on PATH: this block runs the cases under Node; install Node 24 or later");
    writeFileSync(
      join(work, "child.ts"),
      [
        `import { runServerStreamCases } from ${JSON.stringify(HELPER)};`,
        "const outcomes = await runServerStreamCases();",
        'process.stdout.write(JSON.stringify({ version: process.version, outcomes }) + "\\n");',
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    const build = await Bun.build({
      entrypoints: [join(work, "child.ts")],
      target: "node",
      format: "esm",
      outdir: work,
    });
    if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
    const child = Bun.spawn([node, join(work, "child.js")], { cwd: work, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`The Node child exited ${exitCode}: ${stderr}`);
    ({ version, outcomes } = JSON.parse(stdout.trim()) as { version: string; outcomes: ServerStreamOutcome[] });
  }, 150_000);

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  test("the child is Node and says which version ran the cases", () => {
    expect(version).toMatch(/^v\d+\.\d+\.\d+/);
  });

  test("cases 1 to 4 come to the same outcomes", () => {
    expectOutcomes(outcomes);
  });
});
