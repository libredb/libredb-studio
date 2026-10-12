/**
 * The read loop on an in-memory socket and the injected clock: every stop of the read with its rows and its cleanup,
 * the idle rule's heartbeat exception, the budget, the wire cap and its oversize forms, the 541 split, the phase
 * errors before consume-ok, the mapping of each handshake failure, and one dial per read.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryCancelledError } from "@/lib/db/errors";
import type { StreamOffset } from "@/lib/db/providers/stream/rabbitmq/amqp/codec";
import { DialAborted, DialFailed } from "@/lib/db/providers/stream/rabbitmq/amqp/dial";
import { readStream, type StreamReadOutcome } from "@/lib/db/providers/stream/rabbitmq/amqp/read-loop";
import type { AmqpEndpoint } from "@/lib/db/providers/stream/rabbitmq/connection-options";
import {
  amqpCloseError,
  amqpExpectsTls,
  amqpNoPlain,
  amqpNoSession,
  amqpNotTls,
  amqpOtherProtocol,
  amqpProtocolError,
  amqpUnreachable,
  cancelledError,
  conversionAtConsume,
  frameMaxTooSmall,
  heartbeatsMissed,
  PROVIDER_CLOSED,
  READ_CANCELLED_BEFORE_START,
  readPhaseTimeout,
  tlsCertificateUntrusted,
  tlsClientCertificateRefused,
} from "@/lib/db/providers/stream/rabbitmq/errors";
import {
  RABBITMQ_BODY_PREFIX_BYTES,
  RABBITMQ_READ_WIRE_BYTES,
  RABBITMQ_RESULT_BUDGET_BYTES,
} from "@/lib/db/providers/stream/rabbitmq/limits";
import {
  brokerAnswers,
  bytesOf,
  createManualClock,
  createMemorySocket,
  frame,
  frameNames,
  i64,
  longstr,
  type ManualClock,
  type MemorySocket,
  message,
  rawTable,
  serverFrames,
  settle,
  u16,
  u32,
  u64,
} from "../../../../helpers/rabbitmq-fake-peer";

const endpoint: AmqpEndpoint = {
  host: "127.0.0.1",
  port: 5672,
  tls: null,
  username: "studio-reader",
  password: ["pa", "ss"].join(""),
  display: "127.0.0.1:5672",
};
const replicas = { online: ["rabbit@a"], members: ["rabbit@a", "rabbit@b"] };
const context = { endpoint: endpoint.display, vhost: "billing", stream: "st-orders", ...replicas };

interface Run {
  readonly socket: MemorySocket;
  readonly clock: ManualClock;
  readonly controller: AbortController;
  readonly result: Promise<StreamReadOutcome>;
  readonly skipped: Uint8Array[];
  dials: number;
  settled: boolean;
  /** Advances the clock, then lets the pushed answers and continuations run. */
  advance(ms: number): Promise<void>;
  names(): string[];
}

async function start(
  options: {
    readonly answers?: Readonly<Record<string, Uint8Array | undefined>>;
    readonly tune?: Parameters<typeof serverFrames.tune>[0];
    readonly limit?: number;
    readonly from?: StreamOffset;
    readonly abortFirst?: unknown;
  } = {},
): Promise<Run> {
  const socket = createMemorySocket(brokerAnswers(options.answers, options.tune));
  const clock = createManualClock();
  const controller = new AbortController();
  if (options.abortFirst !== undefined) controller.abort(options.abortFirst);
  const skipped: Uint8Array[] = [];
  const run: Run = {
    socket,
    clock,
    controller,
    skipped,
    dials: 0,
    settled: false,
    result: Promise.resolve() as never,
    async advance(ms) {
      clock.advance(ms);
      await settle();
    },
    names: () => frameNames(socket.received),
  };
  const result = readStream({
    endpoint,
    vhost: "billing",
    stream: "st-orders",
    from: options.from ?? { kind: "keyword", value: "first" },
    limit: options.limit ?? 50,
    signal: controller.signal,
    deadlineSeconds: 30,
    replicas,
    dial: async () => {
      run.dials += 1;
      return socket;
    },
    clock,
    studioVersion: null,
    onSkippedBytes: (view) => skipped.push(view),
  });
  result.then(
    () => {
      run.settled = true;
    },
    () => {
      run.settled = true;
    },
  );
  (run as { result: Promise<StreamReadOutcome> }).result = result;
  await settle();
  return run;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

const messages = (count: number, from = 0, body = bytesOf("m")) =>
  bytesOf(
    ...Array.from({ length: count }, (_, index) =>
      message({ deliveryTag: BigInt(index + 1), offset: BigInt(from + index), body }),
    ),
  );
const ackTags = (run: Run) =>
  run.socket.received
    .filter((frame) => frame.classId === 60 && frame.methodId === 80)
    .map((frame) => new DataView(frame.payload.buffer).getBigUint64(4));

/** Pushes `bytes` in slices of `size`, stopping once the socket is gone. */
function pushSliced(socket: MemorySocket, bytes: Uint8Array, size = 65_536): void {
  for (let at = 0; at < bytes.length && !socket.destroyed; at += size) socket.push(bytes.subarray(at, at + size));
}

describe("rows and the normal end", () => {
  test("the row limit: rows in order, one ack per row, connection.close and nothing left behind", async () => {
    const run = await start({ limit: 3 });
    run.socket.push(messages(5, 10));
    const outcome = await run.result;
    expect(outcome.stop).toEqual({ kind: "limit" });
    expect(outcome.prefetch).toBe(3);
    expect(outcome.messages.map((m) => m.offset)).toEqual([BigInt(10), BigInt(11), BigInt(12)]);
    expect(Buffer.from(outcome.messages[0]?.body ?? []).toString()).toBe("m");
    expect(outcome.messages[0]?.bodySize).toBe(1);
    expect(Buffer.from(outcome.messages[0]?.routingKey ?? []).toString()).toBe("st");
    expect(outcome.messages[0]?.retainedHeaderBytes).toBeGreaterThan(0);
    expect(ackTags(run)).toEqual([BigInt(1), BigInt(2), BigInt(3)]);
    expect(run.names().slice(-1)).toEqual(["10.50"]);
    expect(run.socket.destroyed).toBe(true);
    expect(run.clock.pending()).toBe(0);
    expect(run.dials).toBe(1);
  });

  test("prefetch is the limit up to 10", async () => {
    for (const [limit, prefetch] of [
      [1, 1],
      [500, 10],
    ] as const) {
      const run = await start({ limit });
      const qos = run.socket.received.find((frame) => frame.classId === 60 && frame.methodId === 10);
      expect(qos === undefined ? null : new DataView(qos.payload.buffer).getUint16(8)).toBe(prefetch);
      run.controller.abort(new QueryCancelledError("stop"));
      expect((await run.result).prefetch).toBe(prefetch);
    }
  });

  test("a heartbeat-only peer has not stopped at 999 ms after consume-ok and stops idle at 1,000 ms", async () => {
    const run = await start({ tune: { heartbeat: 1 } });
    for (let elapsed = 0; elapsed < 999; elapsed += 333) {
      run.socket.push(serverFrames.heartbeat());
      await run.advance(Math.min(333, 999 - elapsed));
    }
    expect(run.settled).toBe(false);
    await run.advance(1);
    const outcome = await run.result;
    expect(outcome).toMatchObject({ stop: { kind: "idle" }, messages: [] });
    expect(run.clock.pending()).toBe(0);
  });

  test("one 4 MiB content-header frame trickled over 3.2 s is never an idle stop", async () => {
    const run = await start({ limit: 1 });
    const value = 4 * 1024 * 1024;
    const headers = rawTable([
      ["x-stream-offset", "l", i64(BigInt(4))],
      ["big", "x", longstr(new Uint8Array(value))],
    ]);
    const header = serverFrames.contentHeader({ bodySize: BigInt(1), properties: { headersRaw: headers } });
    run.socket.push(serverFrames.deliver({ deliveryTag: BigInt(1) }));
    const part = Math.ceil(header.length / 8);
    for (let at = 0; at < header.length; at += part) {
      run.socket.push(header.subarray(at, at + part));
      await run.advance(400);
      expect(run.settled).toBe(false);
    }
    run.socket.push(serverFrames.body(bytesOf("z")));
    const outcome = await run.result;
    expect(outcome.stop).toEqual({ kind: "limit" });
    expect(outcome.messages[0]?.offset).toBe(BigInt(4));
  });

  test("a server basic.cancel and a broker close end the read with the rows so far", async () => {
    const cancel = await start();
    cancel.socket.push(bytesOf(messages(2), serverFrames.basicCancel()));
    expect(await cancel.result).toMatchObject({ stop: { kind: "server-cancel" } });
    expect((await cancel.result).messages).toHaveLength(2);
    expect(cancel.names()).toContain("60.31");

    const closed = await start();
    closed.socket.push(bytesOf(messages(2), serverFrames.connectionClose(320, "CONNECTION_FORCED")));
    expect(await closed.result).toMatchObject({ stop: { kind: "closed" } });
    expect(closed.names().at(-1)).toBe("10.51");
    expect(closed.dials).toBe(1);

    const ended = await start();
    ended.socket.push(messages(1));
    ended.socket.end();
    expect(await ended.result).toMatchObject({ stop: { kind: "closed" } });
    expect((await ended.result).messages).toHaveLength(1);
  });

  test("a broker close on channel 0 between a delivery's frames ends the read with the rows before it", async () => {
    const run = await start();
    run.socket.push(
      bytesOf(
        messages(2),
        serverFrames.deliver({ deliveryTag: BigInt(3) }),
        serverFrames.contentHeader({
          bodySize: BigInt(10),
          properties: { headersRaw: rawTable([["x-stream-offset", "l", i64(BigInt(2))]]) },
        }),
        serverFrames.connectionClose(320, "CONNECTION_FORCED"),
      ),
    );
    expect(await run.result).toMatchObject({ stop: { kind: "closed" } });
    expect((await run.result).messages.map((row) => row.offset)).toEqual([BigInt(0), BigInt(1)]);
    expect(run.names().at(-1)).toBe("10.51");
  });

  test("a close-ok that never comes ends the close at its wait limit", async () => {
    const run = await start({ limit: 1, answers: { "10.50": undefined } });
    run.socket.push(messages(1));
    await settle();
    expect(run.settled).toBe(false);
    await run.advance(1_000);
    expect((await run.result).stop).toEqual({ kind: "limit" });
  });

  test("bytes that keep arriving while the close waits count against the wire cap, which drops the socket", async () => {
    const run = await start({ limit: 1, answers: { "10.50": undefined } });
    run.socket.push(messages(1));
    await settle();
    expect(run.settled).toBe(false);
    const body = new Uint8Array(4 * 1024 * 1024);
    let accepted = 0;
    for (let index = 0; index < 40 && !run.socket.destroyed; index++) {
      const bytes = message({ deliveryTag: BigInt(index + 2), offset: BigInt(index + 1), body });
      for (let at = 0; at < bytes.length && !run.socket.destroyed; at += 65_536) {
        const slice = bytes.subarray(at, at + 65_536);
        run.socket.push(slice);
        accepted += slice.length;
      }
    }
    expect(run.socket.destroyed).toBe(true);
    expect(accepted).toBeLessThanOrEqual(RABBITMQ_READ_WIRE_BYTES + 65_536);
    const outcome = await run.result;
    expect(outcome.stop).toEqual({ kind: "limit" });
    expect(outcome.messages.map((m) => m.offset)).toEqual([BigInt(0)]);
    expect(run.clock.pending()).toBe(0);
  });
});

describe("hard stops", () => {
  test("the budget: the first message that does not fit stops the read before its body", async () => {
    const run = await start({ limit: 500 });
    const body = new Uint8Array(300 * 1024);
    let rows = 0;
    for (let index = 0; index < 40 && !run.socket.destroyed; index++) {
      run.socket.push(message({ deliveryTag: BigInt(index + 1), offset: BigInt(index), body }));
      rows = index;
    }
    const outcome = await run.result;
    const cost = (outcome.messages[0]?.retainedHeaderBytes ?? 0) + RABBITMQ_BODY_PREFIX_BYTES;
    const fit = Math.floor(RABBITMQ_RESULT_BUDGET_BYTES / cost);
    expect(fit).toBeLessThan(33);
    expect(outcome.messages).toHaveLength(fit);
    expect(outcome.stop).toEqual({ kind: "budget" });
    expect(outcome.messages.at(-1)?.offset).toBe(BigInt(fit - 1));
    expect(rows).toBe(fit);
    expect(run.names().at(-1)).toBe("10.50");
    expect(ackTags(run)).toHaveLength(fit);
    expect(run.socket.destroyed).toBe(true);
  });

  test("300 MiB of cut bodies stop at the 64 MiB wire cap", async () => {
    const run = await start({ limit: 500 });
    const body = new Uint8Array(4 * 1024 * 1024);
    for (let index = 0; index < 75 && !run.socket.destroyed; index++) {
      pushSliced(run.socket, message({ deliveryTag: BigInt(index + 1), offset: BigInt(index), body }));
    }
    const outcome = await run.result;
    expect(outcome.stop).toEqual({ kind: "wire" });
    expect(outcome.messages).toHaveLength(15);
    const skipped = run.skipped.reduce((sum, view) => sum + view.length, 0);
    expect(skipped).toBeGreaterThan(15 * (body.length - RABBITMQ_BODY_PREFIX_BYTES));
  });

  test("one 70 MiB body at limit 1 ends with the oversize stop naming its offset", async () => {
    const run = await start({ limit: 1 });
    const size = 70 * 1024 * 1024;
    run.socket.push(
      bytesOf(
        serverFrames.deliver({ deliveryTag: BigInt(1) }),
        serverFrames.contentHeader({
          bodySize: BigInt(size),
          properties: { headersRaw: rawTable([["x-stream-offset", "l", i64(BigInt(812))]]) },
        }),
      ),
    );
    const piece = serverFrames.body(new Uint8Array(131_072 - 8));
    for (let sent = 0; sent < size && !run.socket.destroyed; sent += 131_064) run.socket.push(piece);
    const outcome = await run.result;
    expect(outcome).toMatchObject({ stop: { kind: "wire-oversize", offset: BigInt(812) }, messages: [] });
  });

  test("a 300 MiB header frame whose offset comes after the cap ends with the oversize stop and no offset", async () => {
    const run = await start({ limit: 1 });
    const value = 300 * 1024 * 1024;
    const table = bytesOf(u32(1 + 3 + 1 + 4 + value + 1 + 15 + 1 + 8));
    const opening = bytesOf(u16(60), u16(0), u64(BigInt(1)), u16(1 << 13), table, 3, "big", "x", u32(value));
    const size = opening.length + value + 1 + 15 + 1 + 8;
    run.socket.push(bytesOf(serverFrames.deliver({ deliveryTag: BigInt(1) }), 2, u16(1), u32(size), opening));
    const zeros = new Uint8Array(65_536);
    for (let sent = 0; sent < value && !run.socket.destroyed; sent += zeros.length) run.socket.push(zeros);
    const outcome = await run.result;
    expect(outcome).toMatchObject({ stop: { kind: "wire-oversize", offset: null }, messages: [] });
  });

  test("the wire cap after rows, inside a message whose offset is not decoded yet, is the plain wire stop", async () => {
    const run = await start({ limit: 500 });
    run.socket.push(messages(2, 40));
    // One chunk past the cap is counted before a byte of it is read, so its content never matters.
    run.socket.push(new Uint8Array(RABBITMQ_READ_WIRE_BYTES + 1));
    expect((await run.result).stop).toEqual({ kind: "wire" });
  });

  test("the bytes after consume-ok in consume-ok's own chunk count against the wire cap", async () => {
    // One chunk: consume-ok, then one byte more than the cap, which is counted before a byte of it is read.
    const run = await start({
      answers: { "60.20": bytesOf(serverFrames.consumeOk(), new Uint8Array(RABBITMQ_READ_WIRE_BYTES + 1)) },
    });
    expect(run.settled).toBe(true);
    expect(await run.result).toMatchObject({ stop: { kind: "wire-oversize", offset: null }, messages: [] });
  });

  test("the deadline and a cancel after consume-ok keep the rows and drop the socket", async () => {
    const deadline = await start();
    deadline.socket.push(messages(2));
    deadline.controller.abort(new DOMException("deadline", "TimeoutError"));
    expect(await deadline.result).toMatchObject({ stop: { kind: "deadline" } });
    expect((await deadline.result).messages).toHaveLength(2);
    expect(deadline.names().at(-1)).toBe("10.50");

    const cancel = await start();
    cancel.controller.abort(new QueryCancelledError("stopped"));
    expect(await cancel.result).toMatchObject({ stop: { kind: "cancel" }, messages: [] });
  });
});

describe("541", () => {
  test("after consume-ok it is the conversion stop, with rows or none", async () => {
    const rows = await start();
    rows.socket.push(bytesOf(messages(2), serverFrames.connectionClose(541, "INTERNAL_ERROR")));
    expect(await rows.result).toMatchObject({ stop: { kind: "conversion" } });
    expect((await rows.result).messages).toHaveLength(2);

    const none = await start();
    none.socket.push(serverFrames.connectionClose(541, "INTERNAL_ERROR"));
    expect(await none.result).toMatchObject({ stop: { kind: "conversion" }, messages: [] });

    // The reply code alone chooses: a 541 that closes only the channel is the same stop.
    const channel = await start();
    channel.socket.push(bytesOf(messages(1), serverFrames.channelClose(541, "INTERNAL_ERROR")));
    expect(await channel.result).toMatchObject({ stop: { kind: "conversion" } });
    expect((await channel.result).messages).toHaveLength(1);
  });

  test("before consume-ok it is the at-consume error", async () => {
    const run = await start({ answers: { "60.20": serverFrames.connectionClose(541, "INTERNAL_ERROR", 60, 20) } });
    const error = await rejection(run.result);
    expect(error.message).toBe(conversionAtConsume("st-orders").message);
  });

  test("a 541 only while closing after the row limit returns the complete rows", async () => {
    const run = await start({ limit: 1, answers: { "10.50": serverFrames.connectionClose(541, "INTERNAL_ERROR") } });
    run.socket.push(messages(1));
    expect(await run.result).toMatchObject({ stop: { kind: "limit" } });
  });
});

describe("before consume-ok", () => {
  test("the deadline and a cancel name the phase and return nothing", async () => {
    const deadline = await start({ answers: { "60.20": undefined } });
    deadline.controller.abort(new DOMException("deadline", "TimeoutError"));
    const timeout = await rejection(deadline.result);
    expect(timeout.message).toBe(
      readPhaseTimeout("handshake", { seconds: 30, endpoint: endpoint.display, stream: "st-orders" }).message,
    );
    expect(timeout.name).toBe("TimeoutError");

    const cancel = await start({ answers: { "60.20": undefined } });
    cancel.controller.abort(new QueryCancelledError("stop"));
    const cancelled = await rejection(cancel.result);
    expect(cancelled.message).toBe(READ_CANCELLED_BEFORE_START);
    expect(cancelled.name).toBe("QueryCancelledError");
  });

  test("the provider's own closing passes through as it is; any other cancel is the cancelled sentence", async () => {
    const closing = cancelledError(PROVIDER_CLOSED);
    const own = await start({ answers: { "60.20": undefined } });
    own.controller.abort(closing);
    expect(await rejection(own.result)).toBe(closing);

    const before = await start({ abortFirst: closing });
    expect(await rejection(before.result)).toBe(closing);
    expect(before.dials).toBe(0);
  });

  test("a signal aborted before the read starts dials nothing", async () => {
    const run = await start({ abortFirst: new DOMException("deadline", "TimeoutError") });
    expect((await rejection(run.result)).name).toBe("TimeoutError");
    expect(run.dials).toBe(0);
  });

  test("dial failures map to their sentences, and an egress refusal passes through unchanged, after one dial", async () => {
    const refusal = new DatabaseConfigError("Invalid host: refused");
    const cases: readonly (readonly [Error, string])[] = [
      [
        new DialAborted("connecting"),
        readPhaseTimeout("connecting", { seconds: 30, endpoint: endpoint.display, stream: "st-orders" }).message,
      ],
      [
        new DialAborted("tls"),
        readPhaseTimeout("tls", { seconds: 30, endpoint: endpoint.display, stream: "st-orders" }).message,
      ],
      [new DialFailed("tls"), amqpNotTls(endpoint.display).message],
      [new DialFailed("certificate"), tlsCertificateUntrusted(endpoint.display).message],
      [new DialFailed("client-certificate"), tlsClientCertificateRefused(endpoint.display).message],
      [new DialFailed("refused"), amqpUnreachable(endpoint.display).message],
      [new DialFailed("network"), amqpUnreachable(endpoint.display).message],
      [refusal, refusal.message],
    ];
    for (const [thrown, sentence] of cases) {
      let dials = 0;
      const error = await rejection(
        readStream({
          endpoint,
          vhost: "billing",
          stream: "st-orders",
          from: { kind: "keyword", value: "last" },
          limit: 1,
          signal: new AbortController().signal,
          deadlineSeconds: 30,
          replicas,
          dial: async () => {
            dials += 1;
            throw thrown;
          },
          clock: createManualClock(),
          studioVersion: null,
        }),
      );
      expect(error.message).toBe(sentence);
      expect(dials).toBe(1);
      if (thrown === refusal) expect(error).toBe(refusal);
    }
  });

  test("each handshake failure maps to its sentence, after exactly one dial", async () => {
    const cases: readonly (readonly [Readonly<Record<string, Uint8Array | undefined>>, string])[] = [
      [
        { "10.11": serverFrames.connectionClose(403, "ACCESS_REFUSED") },
        amqpCloseError(
          { replyCode: 403, replyText: "ACCESS_REFUSED", classId: 0, methodId: 0, scope: "connection" },
          context,
        ).message,
      ],
      [
        { "10.40": serverFrames.connectionClose(530, "NOT_ALLOWED - vhost billing not found", 10, 40) },
        amqpCloseError(
          {
            replyCode: 530,
            replyText: "NOT_ALLOWED - vhost billing not found",
            classId: 10,
            methodId: 40,
            scope: "connection",
          },
          context,
        ).message,
      ],
      [
        {
          "60.20": serverFrames.channelClose(
            406,
            "PRECONDITION_FAILED - does not have a running replica on the local node",
            60,
            20,
          ),
        },
        amqpCloseError(
          {
            replyCode: 406,
            replyText: "PRECONDITION_FAILED - does not have a running replica on the local node",
            classId: 60,
            methodId: 20,
            scope: "channel",
          },
          context,
        ).message,
      ],
      [{ header: serverFrames.connectionStart({ mechanisms: "AMQPLAIN" }) }, amqpNoPlain(endpoint.display).message],
      [{ header: serverFrames.connectionStart({ minor: 8 }) }, amqpOtherProtocol(endpoint.display).message],
      [{ header: bytesOf("AMQP", 1, 1, 0, 10) }, amqpOtherProtocol(endpoint.display).message],
      [{ header: bytesOf(0x15, 0x03, 0x03, 0, 2, 2, 70) }, amqpExpectsTls(endpoint.display).message],
      [{ header: bytesOf("HTTP/1.1 400 Bad\r\n") }, amqpNoSession(endpoint.display).message],
      [{ "10.11": serverFrames.tune({ frameMax: 4_096 }) }, frameMaxTooSmall(4_096).message],
      [
        { "10.40": frame(1, 0, bytesOf(u16(10), u16(41), 0), 0x00) },
        amqpProtocolError(endpoint.display, "frame-end").message,
      ],
    ];
    for (const [answers, sentence] of cases) {
      const run = await start({ answers });
      expect((await rejection(run.result)).message).toBe(sentence);
      expect(run.dials).toBe(1);
      expect(run.socket.destroyed).toBe(true);
      expect(run.clock.pending()).toBe(0);
    }
  });

  test("a consume refused with 406 records no ack", async () => {
    const run = await start({
      answers: { "60.20": serverFrames.channelClose(406, "PRECONDITION_FAILED - x-stream-offset", 60, 20) },
    });
    await rejection(run.result);
    expect(ackTags(run)).toEqual([]);
  });

  test("missed heartbeats during the handshake", async () => {
    const run = await start({ tune: { heartbeat: 1 }, answers: { "20.10": undefined } });
    await run.advance(2_000);
    expect((await rejection(run.result)).message).toBe(heartbeatsMissed(endpoint.display).message);
  });

  test("a socket that ends during the handshake", async () => {
    const run = await start({ answers: { "60.10": undefined } });
    run.socket.end();
    expect((await rejection(run.result)).message).toBe(amqpNoSession(endpoint.display).message);
  });

  test("a socket that ends before the broker sends a byte: no session in plain, the TLS connection refused over TLS", async () => {
    const silentEnd = async (tls: AmqpEndpoint["tls"]): Promise<string> => {
      const socket = createMemorySocket(brokerAnswers({ header: undefined }));
      const result = readStream({
        endpoint: { ...endpoint, tls },
        vhost: "billing",
        stream: "st-orders",
        from: { kind: "keyword", value: "last" },
        limit: 1,
        signal: new AbortController().signal,
        deadlineSeconds: 30,
        replicas,
        dial: async () => socket,
        clock: createManualClock(),
        studioVersion: null,
      });
      await settle();
      socket.end();
      return (await rejection(result)).message;
    };
    expect(await silentEnd(null)).toBe(amqpNoSession(endpoint.display).message);
    const tls = { rejectUnauthorized: true, identity: "127.0.0.1" };
    expect(await silentEnd(tls)).toBe(tlsClientCertificateRefused(endpoint.display).message);
  });
});

describe("R-S3 and R-S11 shapes", () => {
  test("a consume-ok that comes 9,500 ms late still starts the read: no client timer ends it before the deadline", async () => {
    const run = await start({ limit: 1, answers: { "60.20": undefined } });
    await run.advance(9_500);
    expect(run.settled).toBe(false);
    run.socket.push(bytesOf(serverFrames.consumeOk(), messages(1)));
    expect(await run.result).toMatchObject({ stop: { kind: "limit" } });
  });

  test("x-stream-offset after a 15 MiB entry gives a row with its offset and the omission marker", async () => {
    const run = await start({ limit: 1 });
    const big = 15 * 1024 * 1024;
    const headers = rawTable([
      ["big", "x", longstr(new Uint8Array(big))],
      ["x-stream-offset", "l", i64(BigInt(37))],
    ]);
    pushSliced(
      run.socket,
      message({ deliveryTag: BigInt(1), offset: BigInt(0), body: bytesOf("b"), properties: { headersRaw: headers } }),
    );
    const outcome = await run.result;
    expect(outcome.messages[0]?.offset).toBe(BigInt(37));
    expect(outcome.messages[0]?.properties.headers?.[0]?.value).toEqual({ tag: "omitted", bytes: big });
  });
});

describe("violations after consume-ok", () => {
  test("a broken frame, a delivery without its offset, and bad delivery arguments are errors, not partial results", async () => {
    const offsetless = bytesOf(
      serverFrames.deliver({ deliveryTag: BigInt(1) }),
      serverFrames.contentHeader({ bodySize: BigInt(0), properties: { headersRaw: rawTable([]) } }),
    );
    const cases: readonly (readonly [Uint8Array, string])[] = [
      [bytesOf(1, 0, 1, 0x7f, 0xff, 0xff, 0xf0), amqpProtocolError(endpoint.display, "frame-too-large").message],
      [offsetless, amqpProtocolError(endpoint.display, "missing-offset").message],
      [frame(1, 1, bytesOf(u16(60), u16(60), 1)), amqpProtocolError(endpoint.display, "malformed-frame").message],
    ];
    for (const [bytes, sentence] of cases) {
      const run = await start();
      run.socket.push(bytesOf(messages(1), bytes));
      expect((await rejection(run.result)).message).toBe(sentence);
      expect(run.socket.destroyed).toBe(true);
      expect(run.clock.pending()).toBe(0);
    }
  });
});
