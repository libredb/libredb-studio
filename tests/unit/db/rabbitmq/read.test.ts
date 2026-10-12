/**
 * The read path of `query()` (R-S2, R-S9, R-S16): the refusals before any I/O, the type check, the deadline D and its
 * phases, the read limiter, and Stop or `disconnect()` at each point of a read.
 *
 * Seams only, no module mocks: the management stub answers the type check, the deadline-signal factory hands each D
 * to the test, and the dial is either a hanging one (a read that holds its slot without a peer) or the real dial to
 * the fake AMQP peer on 127.0.0.1.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createDatabaseProvider } from "@/lib/db";
import { QueryCancelledError, QueryError, TimeoutError } from "@/lib/db/errors";
import { type AmqpDial, type AmqpSocket, DialAborted, dialAmqp } from "@/lib/db/providers/stream/rabbitmq/amqp/dial";
import { readConnectionOptions } from "@/lib/db/providers/stream/rabbitmq/connection-options";
import { rabbitmqTableQuery } from "@/lib/db/providers/stream/rabbitmq/generators";
import { RabbitMQProvider, type RabbitMQSeams } from "@/lib/db/providers/stream/rabbitmq/index";
import {
  AMQP_PORT_REQUIRED,
  amqpCloseError,
  cancelledError,
  cancelWarning,
  conversionAfter,
  conversionNoRowNumeric,
  lastIdleWarning,
  managementTimeout,
  notAStream,
  PROVIDER_CLOSED,
  READ_CANCELLED_BEFORE_START,
  READ_SLOTS_FULL,
  readPhaseTimeout,
  REQUEST_EMPTY,
  REQUEST_PARAMS,
  unknownRequestKey,
} from "@/lib/db/providers/stream/rabbitmq/errors";
import { SYSTEM_CLOCK } from "@/lib/db/providers/stream/rabbitmq/limits";
import {
  createManagementClient,
  rabbitmqBindingsLimiter,
  rabbitmqManagementLimiter,
} from "@/lib/db/providers/stream/rabbitmq/management/client";
import { MANAGEMENT_ROUTES, routeTarget } from "@/lib/db/providers/stream/rabbitmq/management/routes";
import { type ReadDependencies, rabbitmqReadLimiter, runRead } from "@/lib/db/providers/stream/rabbitmq/read";
import { parseReadRequest } from "@/lib/db/providers/stream/rabbitmq/request";
import { createRunRegistry } from "@/lib/db/utils/bounded-limiter";
import type { DatabaseConnection } from "@/lib/types";
import { rabbitmqConnection } from "../../../helpers/rabbitmq-connection";
import {
  type FakePeer,
  handshakeSteps,
  type PeerStep,
  serverFrames,
  startFakePeer,
} from "../../../helpers/rabbitmq-fake-peer";
import { createManagementStub, type ManagementStub } from "../../../helpers/rabbitmq-management-stub";

const STREAM_ANSWER = JSON.stringify({ type: "stream", online: ["rabbit@a"], members: ["rabbit@a"] });

/** The stub's key for the type check of one stream, built by the route table so the test never spells a path. */
function typeCheckKey(vhost: string, name: string): string {
  const target = routeTarget("stream-type", { vhost, name }, "");
  const query = [...(target.params ?? new URLSearchParams())]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return `GET ${target.pathname}?${query}`;
}

/** Each D the read asks for, which the test fires; a reason that is not a QueryCancelledError, as AbortSignal.timeout's. */
interface Deadlines {
  readonly asked: { readonly ms: number; readonly controller: AbortController }[];
  readonly factory: (ms: number) => AbortSignal;
  fire(index: number): void;
}
function deadlines(): Deadlines {
  const asked: { ms: number; controller: AbortController }[] = [];
  return {
    asked,
    factory: (ms) => {
      const controller = new AbortController();
      asked.push({ ms, controller });
      return controller.signal;
    },
    fire(index) {
      asked[index].controller.abort(new DOMException("The deadline passed.", "TimeoutError"));
    },
  };
}

/** A dial that never connects: the read holds its slot until its signal aborts, as a peer that never accepts does. */
function hangingDial(): { readonly dial: AmqpDial; readonly calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    dial: (_endpoint, signal) => {
      calls += 1;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new DialAborted("connecting")), { once: true });
      });
    },
  };
}

interface Harness {
  readonly deps: ReadDependencies;
  readonly stub: ManagementStub;
  readonly deadlines: Deadlines;
  readonly lifetime: AbortController;
  readonly dials: () => number;
}

const opened: AbortController[] = [];
afterEach(() => {
  // Ends every read a case left holding a slot, so the process-wide read table starts empty for the next case.
  for (const lifetime of opened.splice(0)) lifetime.abort(cancelledError(PROVIDER_CLOSED));
});

function harness(overrides: Partial<ReadDependencies> = {}, connection: Partial<DatabaseConnection> = {}): Harness {
  const stub = createManagementStub();
  stub.answer(typeCheckKey("/", "orders"), { status: 200, body: STREAM_ANSWER });
  const clock = deadlines();
  const lifetime = new AbortController();
  opened.push(lifetime);
  const endpoints = readConnectionOptions(rabbitmqConnection(connection));
  const hanging = hangingDial();
  const queryTimeoutMs = overrides.queryTimeoutMs ?? 30_000;
  const deps: ReadDependencies = {
    endpoints,
    management: createManagementClient({
      endpoint: endpoints.management,
      transport: stub.factory,
      deadlineSignal: clock.factory,
      queryTimeoutMs,
      lifetime: lifetime.signal,
      limiters: { management: rabbitmqManagementLimiter(), bindings: rabbitmqBindingsLimiter() },
    }),
    readLimiter: rabbitmqReadLimiter(),
    runs: createRunRegistry(),
    lifetime: lifetime.signal,
    queryTimeoutMs,
    dial: hanging.dial,
    clock: SYSTEM_CLOCK,
    deadlineSignal: clock.factory,
    studioVersion: null,
    ...overrides,
  };
  return { deps, stub, deadlines: clock, lifetime, dials: hanging.calls };
}

const READ = JSON.stringify({ vhost: "/", stream: "orders" });

async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("the read answered");
}

/** Lets every settled promise run its callbacks, so a waiting read has reached its wait. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 500; tries++) {
    if (condition()) return;
    // oxlint-disable-next-line no-await-in-loop -- one poll at a time is the point.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("refused before any I/O", () => {
  test.each([
    ["", undefined, REQUEST_EMPTY],
    ["  \n ", undefined, REQUEST_EMPTY],
    [READ, [1], REQUEST_PARAMS],
    [JSON.stringify({ vhost: "/", stream: "orders", topic: "x" }), undefined, unknownRequestKey("topic")],
  ])("%p with params %p", async (text, params, sentence) => {
    const h = harness();
    const error = await refusal(runRead(text, params, undefined, h.deps));
    expect(error.message).toBe(sentence);
    expect(h.stub.requests).toHaveLength(0);
    expect(h.dials()).toBe(0);
  });

  test("an empty params list binds nothing and is not a refusal", async () => {
    const h = harness();
    const pending = runRead(READ, [], "q-empty", h.deps);
    await until(() => h.dials() === 1, "the dial");
    h.deps.runs.cancel("q-empty");
    expect((await refusal(pending)).message).toBe(READ_CANCELLED_BEFORE_START);
  });

  test("a connection without AMQP port refuses after the request is read, before the type check", async () => {
    const h = harness({}, { amqpPort: "" });
    const error = await refusal(runRead(READ, undefined, undefined, h.deps));
    expect(error.message).toBe(AMQP_PORT_REQUIRED);
    expect(h.stub.requests).toHaveLength(0);
  });

  test("after disconnect() a read is refused with the provider's closed sentence and sends nothing", async () => {
    const h = harness();
    h.lifetime.abort(cancelledError(PROVIDER_CLOSED));
    const error = await refusal(runRead(READ, undefined, undefined, h.deps));
    expect(error).toBeInstanceOf(QueryCancelledError);
    expect(error.message).toBe(PROVIDER_CLOSED);
    expect(h.stub.requests).toHaveLength(0);
  });

  test("a malformed or repeated queryId is refused with the registry's own sentence", async () => {
    const h = harness();
    const bad = await refusal(runRead(READ, undefined, "has space", h.deps));
    expect(bad).toBeInstanceOf(QueryError);
    expect(bad.message).toContain("queryId");
    const first = runRead(READ, undefined, "q-dup", h.deps);
    await until(() => h.dials() === 1, "the first read's dial");
    const duplicate = await refusal(runRead(READ, undefined, "q-dup", h.deps));
    expect(duplicate.message).toContain("already running");
    h.deps.runs.cancel("q-dup");
    await refusal(first);
  });
});

describe("the deadline D", () => {
  test.each([
    [2_000, 2_000],
    [30_000, 30_000],
    [60_000, 30_000],
  ])("queryTimeout %d gives D %d, asked once, before the type check", async (queryTimeoutMs, d) => {
    const h = harness({ queryTimeoutMs });
    const pending = runRead(READ, undefined, undefined, h.deps);
    await until(() => h.dials() === 1, "the dial");
    expect(h.deadlines.asked.map((each) => each.ms)).toEqual([d]);
    h.deadlines.fire(0);
    const error = await refusal(pending);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe(
      readPhaseTimeout("connecting", { seconds: d / 1000, endpoint: "127.0.0.1:5672", stream: "orders" }).message,
    );
  });
});

describe("the type check", () => {
  test.each([
    ["classic", notAStream("orders", "classic").message],
    ["quorum", notAStream("orders", "quorum").message],
    ["<script>", notAStream("orders", "<script>").message],
  ])("a %s queue is refused before any dial, after exactly one GET", async (type, sentence) => {
    const h = harness();
    h.stub.answer(typeCheckKey("/", "orders"), {
      status: 200,
      body: JSON.stringify({ type, online: [], members: [] }),
    });
    const error = await refusal(runRead(READ, undefined, undefined, h.deps));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(sentence);
    expect(error.message).not.toContain("<script>");
    expect(h.stub.requests).toHaveLength(1);
    expect(h.dials()).toBe(0);
  });

  test.each([
    ["/", "/api/queues/%2F/orders"],
    ["%2F", "/api/queues/%252F/orders"],
    ["a b", "/api/queues/a%20b/orders"],
  ])("vhost %p is addressed as %s", async (vhost, path) => {
    const h = harness();
    h.stub.answer(typeCheckKey(vhost, "orders"), {
      status: 200,
      body: JSON.stringify({ type: "classic", online: [], members: [] }),
    });
    await refusal(runRead(JSON.stringify({ vhost, stream: "orders" }), undefined, undefined, h.deps));
    expect(h.stub.requests.map((request) => request.path)).toEqual([path]);
  });

  describe("Stop, disconnect() and D while the type check is answering", () => {
    /** A type check that answers only by its signal's abort, rejecting with the reason as the client is given it. */
    function waitingTypeCheck(h: Harness): void {
      h.stub.answer(
        typeCheckKey("/", "orders"),
        (request) =>
          new Promise((_, reject) => {
            request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
          }),
      );
    }

    test("Stop gives the stop-before-start sentence, with no dial", async () => {
      const h = harness();
      waitingTypeCheck(h);
      const pending = runRead(READ, undefined, "q-check", h.deps);
      await until(() => h.stub.requests.length === 1, "the type check");
      h.deps.runs.cancel("q-check");
      const error = await refusal(pending);
      expect(error).toBeInstanceOf(QueryCancelledError);
      expect(error.message).toBe(READ_CANCELLED_BEFORE_START);
      expect(h.dials()).toBe(0);
    });

    test("disconnect() gives the provider's closed sentence, with no dial", async () => {
      const h = harness();
      waitingTypeCheck(h);
      const pending = runRead(READ, undefined, undefined, h.deps);
      await until(() => h.stub.requests.length === 1, "the type check");
      h.lifetime.abort(cancelledError(PROVIDER_CLOSED));
      const error = await refusal(pending);
      expect(error).toBeInstanceOf(QueryCancelledError);
      expect(error.message).toBe(PROVIDER_CLOSED);
      expect(h.dials()).toBe(0);
    });

    test("D gives the management timeout of the type check, with no dial", async () => {
      const h = harness({ queryTimeoutMs: 2_000 });
      waitingTypeCheck(h);
      const pending = runRead(READ, undefined, undefined, h.deps);
      await until(() => h.stub.requests.length === 1, "the type check");
      h.deadlines.fire(0);
      const error = await refusal(pending);
      expect(error).toBeInstanceOf(TimeoutError);
      expect(error.message).toBe(
        managementTimeout(
          {
            endpoint: "127.0.0.1:15672",
            route: MANAGEMENT_ROUTES["stream-type"].label,
            scope: "object",
            site: "read",
            vhost: "/",
            name: "orders",
          },
          2,
        ).message,
      );
      expect(h.dials()).toBe(0);
    });
  });
});

describe("the read limiter (R-S16)", () => {
  test("a second read on one provider waits for the first, and starts once the first ends", async () => {
    const h = harness();
    const first = runRead(READ, undefined, "q-1", h.deps);
    await until(() => h.dials() === 1, "the first dial");
    const second = runRead(READ, undefined, "q-2", h.deps);
    await until(() => h.stub.requests.length === 2, "the second type check");
    await settle();
    expect(h.dials()).toBe(1);
    h.deps.runs.cancel("q-1");
    expect((await refusal(first)).message).toBe(READ_CANCELLED_BEFORE_START);
    await until(() => h.dials() === 2, "the second dial");
    h.deps.runs.cancel("q-2");
    await refusal(second);
  });

  test("a fifth read in the process waits; with 4 running and 16 waiting the next is refused at once", async () => {
    const running = Array.from({ length: 4 }, () => harness());
    const pending = running.map((h, i) => runRead(READ, undefined, `run-${i}`, h.deps));
    await until(() => running.every((h) => h.dials() === 1), "four dials");
    const waiting = Array.from({ length: 16 }, () => harness());
    const queued = waiting.map((h, i) => runRead(READ, undefined, `wait-${i}`, h.deps));
    await until(() => waiting.every((h) => h.stub.requests.length === 1), "sixteen type checks");
    await settle();
    expect(waiting.every((h) => h.dials() === 0)).toBe(true);

    const refused = harness();
    const error = await refusal(runRead(READ, undefined, "over", refused.deps));
    expect(error.message).toBe(READ_SLOTS_FULL);
    expect(refused.dials()).toBe(0);
    expect(refused.stub.requests).toHaveLength(1);
    expect(refused.deadlines.asked).toHaveLength(1);

    running.forEach((h, i) => h.deps.runs.cancel(`run-${i}`));
    waiting.forEach((h, i) => h.deps.runs.cancel(`wait-${i}`));
    await Promise.allSettled([...pending, ...queued]);
  });

  test("a queued read whose D fires leaves the queue with the queued sentence, no dial and one GET", async () => {
    const holder = harness();
    const held = runRead(READ, undefined, "hold", holder.deps);
    await until(() => holder.dials() === 1, "the holder's dial");
    const h = harness({ queryTimeoutMs: 1_000, readLimiter: holder.deps.readLimiter });
    const queued = runRead(READ, undefined, undefined, h.deps);
    await until(() => h.stub.requests.length === 1, "the queued read's type check");
    await settle();
    h.deadlines.fire(0);
    const error = await refusal(queued);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe(
      readPhaseTimeout("queued", { seconds: 1, endpoint: "127.0.0.1:5672", stream: "orders" }).message,
    );
    expect(h.dials()).toBe(0);
    expect(h.stub.requests).toHaveLength(1);
    holder.deps.runs.cancel("hold");
    await refusal(held);
  });

  test("Stop and disconnect() while queued each end with their own sentence, and the slot passes on at once", async () => {
    const holder = harness();
    const held = runRead(READ, undefined, "hold", holder.deps);
    await until(() => holder.dials() === 1, "the holder's dial");

    const stopped = harness({ readLimiter: holder.deps.readLimiter });
    const stopping = runRead(READ, undefined, "stop-me", stopped.deps);
    await until(() => stopped.stub.requests.length === 1, "the type check");
    await settle();
    stopped.deps.runs.cancel("stop-me");
    const stopError = await refusal(stopping);
    expect(stopError).toBeInstanceOf(QueryCancelledError);
    expect(stopError.message).toBe(READ_CANCELLED_BEFORE_START);

    const closed = harness({ readLimiter: holder.deps.readLimiter });
    const closing = runRead(READ, undefined, undefined, closed.deps);
    await until(() => closed.stub.requests.length === 1, "the type check");
    await settle();
    closed.lifetime.abort(cancelledError(PROVIDER_CLOSED));
    expect((await refusal(closing)).message).toBe(PROVIDER_CLOSED);
    expect(stopped.dials() + closed.dials()).toBe(0);

    holder.deps.runs.cancel("hold");
    await refusal(held);
    const next = harness({ readLimiter: holder.deps.readLimiter });
    const nextRead = runRead(READ, undefined, "next", next.deps);
    await until(() => next.dials() === 1, "the next read's dial");
    next.deps.runs.cancel("next");
    await refusal(nextRead);
  });

  test("a read admitted late still ends when its own D fires", async () => {
    const holder = harness();
    const held = runRead(READ, undefined, "hold", holder.deps);
    await until(() => holder.dials() === 1, "the holder's dial");
    const h = harness({ queryTimeoutMs: 1_000, readLimiter: holder.deps.readLimiter });
    const late = runRead(READ, undefined, undefined, h.deps);
    await until(() => h.stub.requests.length === 1, "the type check");
    holder.deps.runs.cancel("hold");
    await refusal(held);
    await until(() => h.dials() === 1, "the late read's dial");
    h.deadlines.fire(0);
    const error = await refusal(late);
    expect(error.message).toBe(
      readPhaseTimeout("connecting", { seconds: 1, endpoint: "127.0.0.1:5672", stream: "orders" }).message,
    );
  });
});

describe("unexpected values end in the boundary", () => {
  test("a dial that throws its own error leaves no trace of it", async () => {
    const h = harness({
      dial: async () => {
        throw new TypeError("PEER-SENTINEL");
      },
    });
    const error = await refusal(runRead(READ, undefined, undefined, h.deps));
    expect(error.message).not.toContain("PEER-SENTINEL");
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("PEER-SENTINEL");
  });
});

const utf8 = (text: string) => new TextEncoder().encode(text);
const concat = (...parts: Uint8Array[]) => Uint8Array.from(Buffer.concat(parts));
const ACK = { classId: 60, methodId: 80 } as const;
const CONNECTION_CLOSE = { classId: 10, methodId: 50 } as const;
const CONNECTION_OPEN = { classId: 10, methodId: 40 } as const;

/** One delivery as RabbitMQ sends it from a stream: deliver, a content header carrying x-stream-offset, one body frame. */
function delivery(tag: number, offset: bigint, stream: string, body = utf8("hello")): Uint8Array {
  return concat(
    serverFrames.deliver({ deliveryTag: BigInt(tag), exchange: "", routingKey: stream }),
    serverFrames.contentHeader({
      bodySize: BigInt(body.length),
      properties: { headers: [{ name: utf8("x-stream-offset"), value: { tag: "l", value: offset } }] },
    }),
    serverFrames.body(body),
  );
}

const peers: FakePeer[] = [];
afterEach(async () => {
  await Promise.all(peers.splice(0).map((peer) => peer.stop()));
});

async function peer(steps: readonly PeerStep[]): Promise<FakePeer> {
  const started = await startFakePeer(steps);
  peers.push(started);
  return started;
}

/** The real dial, recording each socket it opens, so a test can ask whether any is still open. */
function recordingDial(): { readonly dial: AmqpDial; readonly sockets: AmqpSocket[] } {
  const sockets: AmqpSocket[] = [];
  return {
    sockets,
    dial: async (endpoint, signal) => {
      const socket = await dialAmqp(endpoint, signal);
      sockets.push(socket);
      return socket;
    },
  };
}

/** A harness whose AMQP port is the peer's, dialled for real, the type check of vhost and stream answered stream. */
function peerHarness(
  target: FakePeer,
  vhost = "/",
  stream = "orders",
): Harness & { readonly realDials: () => number; readonly sockets: readonly AmqpSocket[] } {
  let realDials = 0;
  const recording = recordingDial();
  const h = harness(
    {
      dial: (endpoint, signal) => {
        realDials += 1;
        return recording.dial(endpoint, signal);
      },
    },
    { amqpPort: String(target.port) },
  );
  h.stub.answer(typeCheckKey(vhost, stream), { status: 200, body: STREAM_ANSWER });
  return { ...h, realDials: () => realDials, sockets: recording.sockets };
}

const frames = (target: FakePeer, method: { readonly classId: number; readonly methodId: number }) =>
  target.received.filter((frame) => frame.classId === method.classId && frame.methodId === method.methodId);

describe("names that look like syntax, through the whole read", () => {
  const RLO = String.fromCodePoint(0x202e);
  const E_ACUTE = String.fromCodePoint(0xe9);
  test.each([
    ["/", "orders", "/api/queues/%2F/orders"],
    ["%2F", "a b", "/api/queues/%252F/a%20b"],
    ["a,b", 'say "hi"', undefined],
    ["line\nbreak", `${RLO}evil`, undefined],
    [`${E_ACUTE.repeat(127)}x`, `${E_ACUTE.repeat(127)}y`, undefined],
  ])("vhost %p, stream %p", async (vhost, stream, path) => {
    const target = await peer([
      ...handshakeSteps(),
      { send: delivery(1, BigInt(120), stream) },
      { expect: ACK },
      { expect: CONNECTION_CLOSE },
      { send: serverFrames.closeOk() },
      { end: "close" },
    ]);
    const h = peerHarness(target, vhost, stream);
    // The click writes a request the parser takes unchanged.
    const text = rabbitmqTableQuery([vhost, stream]);
    expect(parseReadRequest(text)).toMatchObject({
      vhost,
      stream,
      from: { kind: "keyword", value: "last" },
      limit: 50,
    });

    const result = await runRead(text, undefined, undefined, h.deps);

    // One management GET, the type check, at the encoded path; one AMQP connection.
    const expectedPath = path ?? routeTarget("stream-type", { vhost, name: stream }, "").pathname;
    expect(h.stub.requests.map((request) => request.path)).toEqual([expectedPath]);
    expect(h.realDials()).toBe(1);
    expect(target.dials).toBe(1);
    // connection.open carries the raw vhost as a short string: its length octet, then its UTF-8 bytes.
    const [open] = frames(target, CONNECTION_OPEN);
    const args = open.payload.subarray(4);
    expect(args.subarray(1, 1 + args[0])).toEqual(utf8(vhost));

    expect(result.rows.map((row) => row.offset)).toEqual(["120"]);
    const sentence = result.warnings?.[0]?.message ?? "";
    expect(sentence).toBe(lastIdleWarning(vhost, stream, 1, BigInt(120)));
    const quoted = sentence.slice(sentence.indexOf('{"vhost"'), sentence.lastIndexOf("}") + 1);
    expect(parseReadRequest(quoted)).toMatchObject({ vhost, stream, from: { kind: "offset", value: BigInt(70) } });
  });
});

describe("Stop and disconnect() during delivery", () => {
  const holding: readonly PeerStep[] = [
    ...handshakeSteps(),
    { send: delivery(1, BigInt(5), "orders") },
    { waitMs: 30_000 },
  ];

  test("Stop: the rows so far with the cancel warning, permits released, and the next read starts at once", async () => {
    const target = await peer(holding);
    const h = peerHarness(target);
    const pending = runRead(READ, undefined, "q-stop", h.deps);
    await until(() => frames(target, ACK).length === 1, "the ack");
    expect(h.deps.runs.cancel("q-stop")).toBe(true);
    const result = await pending;
    expect(result.rows.map((row) => row.offset)).toEqual(["5"]);
    expect(result.warnings?.map((each) => each.message)).toEqual([cancelWarning(BigInt(5))]);
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets.every((socket) => socket.destroyed)).toBe(true);
    await until(() => frames(target, CONNECTION_CLOSE).length === 1, "the hard drop's connection.close");
    expect(h.deps.runs.cancel("q-stop")).toBe(false);

    const next = runRead(READ, undefined, "q-next", h.deps);
    await until(() => target.dials === 2, "the next read's dial");
    expect(h.stub.requests).toHaveLength(2);
    h.deps.runs.cancel("q-next");
    await next.catch(() => undefined);
  });

  test("disconnect(): the rows so far with the cancel warning, later reads refused, a new instance reads at once", async () => {
    const target = await peer(holding);
    const h = peerHarness(target);
    const pending = runRead(READ, undefined, undefined, h.deps);
    await until(() => frames(target, ACK).length === 1, "the ack");
    h.lifetime.abort(cancelledError(PROVIDER_CLOSED));
    const result = await pending;
    expect(result.rows.map((row) => row.offset)).toEqual(["5"]);
    expect(result.warnings?.map((each) => each.message)).toEqual([cancelWarning(BigInt(5))]);
    expect(h.sockets.every((socket) => socket.destroyed)).toBe(true);
    expect((await refusal(runRead(READ, undefined, undefined, h.deps))).message).toBe(PROVIDER_CLOSED);

    const fresh = peerHarness(target);
    const next = runRead(READ, undefined, "q-fresh", fresh.deps);
    await until(() => target.dials === 2, "the new instance's dial");
    fresh.deps.runs.cancel("q-fresh");
    await next.catch(() => undefined);
  });
});

describe("the broker's answers to the consume (R-S2, R-S12, R-S17)", () => {
  /** The handshake written out up to the client's basic.consume, which the broker then answers. */
  const upToConsume: readonly PeerStep[] = [
    { expect: "protocol-header" },
    { send: serverFrames.connectionStart() },
    { expect: { classId: 10, methodId: 11 } },
    { send: serverFrames.tune() },
    { expect: { classId: 10, methodId: 31 } },
    { expect: CONNECTION_OPEN },
    { send: serverFrames.openOk() },
    { expect: { classId: 20, methodId: 10 } },
    { send: serverFrames.channelOpenOk() },
    { expect: { classId: 60, methodId: 10 } },
    { send: serverFrames.qosOk() },
    { expect: { classId: 60, methodId: 20 } },
  ];

  test("a 406 to the consume with every replica online: the replica-may-be-starting sentence, no ack, one dial", async () => {
    const replyText =
      "PRECONDITION_FAILED - stream queue 'orders' in vhost '/' does not have a running replica on the local node";
    const target = await peer([
      ...upToConsume,
      { send: serverFrames.channelClose(406, replyText, 60, 20) },
      { expect: { classId: 20, methodId: 41 } },
      { end: "close" },
    ]);
    const h = peerHarness(target);
    const error = await refusal(runRead(READ, undefined, undefined, h.deps));
    expect(error).toBeInstanceOf(QueryError);
    // The type check answered online equal to members, so the sentence says the replica may still be starting.
    expect(error.message).toBe(
      amqpCloseError(
        { replyCode: 406, replyText, classId: 60, methodId: 20, scope: "channel" },
        {
          endpoint: `127.0.0.1:${target.port}`,
          vhost: "/",
          stream: "orders",
          online: ["rabbit@a"],
          members: ["rabbit@a"],
        },
      ).message,
    );
    expect(error.message).not.toContain("PRECONDITION_FAILED");
    expect(frames(target, ACK)).toHaveLength(0);
    expect(h.realDials()).toBe(1);
  });

  test("a refused dial and a 320 close each record exactly one dial", async () => {
    const closed = await peer([
      ...handshakeSteps(),
      { send: serverFrames.connectionClose(320, "CONNECTION_FORCED - shutdown") },
    ]);
    const h = peerHarness(closed);
    const result = await runRead(READ, undefined, undefined, h.deps);
    expect(result.rows).toHaveLength(0);
    expect(h.realDials()).toBe(1);

    const gone = await peer([]);
    const port = gone.port;
    await gone.stop();
    const refused = harness({}, { amqpPort: String(port) });
    let dials = 0;
    const counted: ReadDependencies = {
      ...refused.deps,
      dial: (endpoint, signal) => {
        dials += 1;
        return dialAmqp(endpoint, signal);
      },
    };
    await refusal(runRead(READ, undefined, undefined, counted));
    expect(dials).toBe(1);
  });

  test("541 after rows, past an offset gap: the partial rows with the note naming the last offset", async () => {
    const target = await peer([
      ...handshakeSteps(),
      { send: concat(delivery(1, BigInt(10), "orders"), delivery(2, BigInt(14), "orders")) },
      { expect: ACK },
      { expect: ACK },
      { send: serverFrames.connectionClose(541, "INTERNAL_ERROR") },
    ]);
    const h = peerHarness(target);
    const result = await runRead(
      JSON.stringify({ vhost: "/", stream: "orders", from: "first" }),
      undefined,
      undefined,
      h.deps,
    );
    expect(result.rows.map((row) => row.offset)).toEqual(["10", "14"]);
    expect(result.warnings?.[0]?.message).toBe(conversionAfter(BigInt(14), 10, "/", "orders"));
  });

  test("541 on the first retained message: an error, never an empty result", async () => {
    const target = await peer([...handshakeSteps(), { send: serverFrames.connectionClose(541, "INTERNAL_ERROR") }]);
    const h = peerHarness(target);
    const text = JSON.stringify({ vhost: "/", stream: "orders", from: { offset: 0 }, limit: 1 });
    const error = await refusal(runRead(text, undefined, undefined, h.deps));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(conversionNoRowNumeric(BigInt(0), 1, "/", "orders"));
  });
});

describe("through RabbitMQProvider", () => {
  /** whoami and the version overview, which connect() reads, then the type check. */
  function connectedStub(): ManagementStub {
    const stub = createManagementStub();
    const key = (target: ReturnType<typeof routeTarget>) => {
      const query = [...(target.params ?? new URLSearchParams())]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => `${name}=${value}`)
        .join("&");
      return query === "" ? `GET ${target.pathname}` : `GET ${target.pathname}?${query}`;
    };
    stub.answer(key(routeTarget("whoami", {}, "")), {
      status: 200,
      body: '{"name":"studio-reader","tags":["management"]}',
    });
    stub.answer(key(routeTarget("overview-version", {}, "")), {
      status: 200,
      body: '{"rabbitmq_version":"4.3.6","product_name":"RabbitMQ"}',
    });
    stub.answer(typeCheckKey("/", "orders"), { status: 200, body: STREAM_ANSWER });
    return stub;
  }

  test("query() runs the read, cancelQuery() stops it by id, and an unknown id answers false", async () => {
    const stub = connectedStub();
    const hanging = hangingDial();
    const provider = new RabbitMQProvider(
      rabbitmqConnection(),
      {},
      { managementTransport: stub.factory, dial: hanging.dial },
    );
    await provider.connect();
    const pending = provider.query(READ, undefined, "q-provider");
    await until(() => hanging.calls() === 1, "the dial");
    expect(await provider.cancelQuery("unknown")).toBe(false);
    expect(await provider.cancelQuery("q-provider")).toBe(true);
    expect((await refusal(pending)).message).toBe(READ_CANCELLED_BEFORE_START);
    await provider.disconnect();
  });

  test("after disconnect() a query is refused before any request", async () => {
    const stub = connectedStub();
    const provider = new RabbitMQProvider(
      rabbitmqConnection(),
      {},
      { managementTransport: stub.factory, dial: hangingDial().dial },
    );
    await provider.connect();
    const before = stub.requests.length;
    await provider.disconnect();
    const error = await refusal(provider.query(READ));
    expect(error).toBeInstanceOf(QueryCancelledError);
    expect(error.message).toBe(PROVIDER_CLOSED);
    expect(stub.requests).toHaveLength(before);
  });

  test("disconnect() during delivery: no open socket once it is awaited, the close sent, and a query after it refused", async () => {
    const target = await peer([...handshakeSteps(), { send: delivery(1, BigInt(5), "orders") }, { waitMs: 30_000 }]);
    const recording = recordingDial();
    const provider = new RabbitMQProvider(
      rabbitmqConnection({ amqpPort: String(target.port) }),
      {},
      { managementTransport: connectedStub().factory, dial: recording.dial },
    );
    await provider.connect();
    const pending = provider.query(READ);
    await until(() => frames(target, ACK).length === 1, "the ack");
    await provider.disconnect();
    // No time window: the socket is destroyed by the time disconnect() resolves, not some time after it.
    expect(recording.sockets).toHaveLength(1);
    expect(recording.sockets.every((socket) => socket.destroyed)).toBe(true);
    await until(() => frames(target, CONNECTION_CLOSE).length === 1, "the hard drop's connection.close");
    const result = await pending;
    expect(result.warnings?.map((each) => each.message)).toEqual([cancelWarning(BigInt(5))]);
    const after = await refusal(provider.query(READ));
    expect(after).toBeInstanceOf(QueryCancelledError);
    expect(after.message).toBe(PROVIDER_CLOSED);
  });

  test("a provider built through the real factory dials with dialAmqp and has no skipped-bytes observer", async () => {
    const provider = await createDatabaseProvider(rabbitmqConnection(), {});
    const seams = (provider as unknown as { readonly seams: RabbitMQSeams }).seams;
    expect(seams.dial).toBe(dialAmqp);
    expect(seams.onSkippedBytes).toBeUndefined();
    expect(typeof (provider as RabbitMQProvider).cancelQuery).toBe("function");
  });
});
