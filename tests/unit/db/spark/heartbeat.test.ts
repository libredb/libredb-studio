/**
 * The 15 s unary heartbeat: over injected timers, one timer per held session, shared by
 * a second hold and stopped by the last release; over the fake server, a Config get_option of spark.sql.ansi.enabled
 * on the run's own session at each interval while a silent call is open, and nothing after the release; a failing beat
 * ends nothing. The interval is 50 ms here, so no test waits on a real timer for more than one second.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { buildSparkConnectionOptions } from "@/lib/db/providers/sql/spark/connection-options";
import { SPARK_HEARTBEAT_DEADLINE_MS } from "@/lib/db/providers/sql/spark/constants";
import { grpcWireTransport, type SparkWireChannel, sparkCallMetadata } from "@/lib/db/providers/sql/spark/grpc-client";
import { SparkHeartbeat } from "@/lib/db/providers/sql/spark/heartbeat";
import { configGetOptionRequest, relationRequest, type SparkSessionRef } from "@/lib/db/providers/sql/spark/requests";
import type { DatabaseConnection } from "@/lib/types";
import { type SparkFakeServer, startSparkFake } from "../../../helpers/spark-connect-server";

/** Interval timers the test ticks by hand; each records the interval it was started with. */
function fakeTimers() {
  const live = new Map<number, () => void>();
  const intervals: number[] = [];
  let next = 1;
  return {
    live,
    intervals,
    tickAll: () => {
      for (const callback of [...live.values()]) callback();
    },
    timers: {
      setInterval: ((callback: () => void, ms: number) => {
        const id = next++;
        live.set(id, callback);
        intervals.push(ms);
        return id;
      }) as unknown as typeof setInterval,
      clearInterval: ((id: number) => {
        live.delete(id);
      }) as unknown as typeof clearInterval,
    },
  };
}

/** One macrotask turn: every promise a tick started has settled by its end. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const session = (): SparkSessionRef => ({ sessionId: randomUUID() });

describe("timers", () => {
  test("one timer per held session, shared by a second hold, stopped by the last release", async () => {
    const beats: string[] = [];
    const clock = fakeTimers();
    const heartbeat = new SparkHeartbeat(async (held) => void beats.push(held.sessionId), 50, clock.timers);
    const a = session();
    const b = session();
    const releaseA1 = heartbeat.hold(a);
    const releaseA2 = heartbeat.hold(a);
    const releaseB = heartbeat.hold(b);
    expect(clock.live.size).toBe(2);
    expect(clock.intervals).toStrictEqual([50, 50]);
    clock.tickAll();
    // A tick counts its beat at once and calls the beat one microtask later.
    expect(heartbeat.beatsSent()).toBe(2);
    await Promise.resolve();
    expect(beats.sort()).toStrictEqual([a.sessionId, b.sessionId].sort());
    // A release function called twice releases once, so a's second hold keeps its timer.
    releaseA1();
    releaseA1();
    expect(clock.live.size).toBe(2);
    releaseA2();
    expect(clock.live.size).toBe(1);
    releaseB();
    expect(clock.live.size).toBe(0);
    const again = heartbeat.hold(a);
    expect(clock.live.size).toBe(1);
    expect(clock.intervals).toStrictEqual([50, 50, 50]);
    // The earlier hold's release, called again, leaves the new hold's timer running.
    releaseA2();
    expect(clock.live.size).toBe(1);
    again();
    expect(clock.live.size).toBe(0);
  });

  test("holds are keyed by sessionId: a second object for one session shares the timer the first object beats with", async () => {
    const beats: SparkSessionRef[] = [];
    const clock = fakeTimers();
    const heartbeat = new SparkHeartbeat(async (held) => void beats.push(held), 50, clock.timers);
    const id = randomUUID();
    const first: SparkSessionRef = { sessionId: id, serverSideSessionId: "s1" };
    const second: SparkSessionRef = { sessionId: id };
    const releaseFirst = heartbeat.hold(first);
    const releaseSecond = heartbeat.hold(second);
    expect(clock.live.size).toBe(1);
    clock.tickAll();
    await Promise.resolve();
    expect(beats.length).toBe(1);
    expect(beats[0]).toBe(first);
    releaseFirst();
    expect(clock.live.size).toBe(1);
    clock.tickAll();
    await Promise.resolve();
    expect(beats.length).toBe(2);
    expect(beats[1]).toBe(first);
    releaseSecond();
    expect(clock.live.size).toBe(0);
  });

  test("a beat that rejects or throws ends nothing and is still counted", async () => {
    const clock = fakeTimers();
    const calls = { rejecting: 0, throwing: 0 };
    const rejecting = new SparkHeartbeat(
      () => {
        calls.rejecting += 1;
        return Promise.reject(new Error("refused"));
      },
      50,
      clock.timers,
    );
    const throwing = new SparkHeartbeat(
      () => {
        calls.throwing += 1;
        throw new Error("thrown");
      },
      50,
      clock.timers,
    );
    const releaseOne = rejecting.hold(session());
    const releaseTwo = throwing.hold(session());
    clock.tickAll();
    await settle();
    // Both failures have settled, and both timers still run.
    expect(clock.live.size).toBe(2);
    clock.tickAll();
    await settle();
    expect(calls).toStrictEqual({ rejecting: 2, throwing: 2 });
    expect(rejecting.beatsSent()).toBe(2);
    expect(throwing.beatsSent()).toBe(2);
    expect(clock.live.size).toBe(2);
    releaseOne();
    releaseTwo();
    expect(clock.live.size).toBe(0);
  });

  test("the defaults are the 15 s interval and the global timers", () => {
    const set = spyOn(globalThis, "setInterval");
    const cleared = spyOn(globalThis, "clearInterval");
    try {
      const heartbeat = new SparkHeartbeat(async () => undefined);
      const release = heartbeat.hold(session());
      release();
      expect(heartbeat.beatsSent()).toBe(0);
      expect(set).toHaveBeenCalledTimes(1);
      expect(set.mock.calls[0]?.[1]).toBe(15_000);
      const timer: unknown = set.mock.results[0]?.value;
      const clearedTimer: unknown = cleared.mock.calls[0]?.[0];
      expect(timer).toBeDefined();
      expect(cleared).toHaveBeenCalledTimes(1);
      expect(clearedTimer).toBe(timer);
    } finally {
      set.mockRestore();
      cleared.mockRestore();
    }
  });
});

describe("over the fake server", () => {
  let fake: SparkFakeServer;
  let channel: SparkWireChannel;
  beforeAll(async () => {
    fake = await startSparkFake({ statements: { "SELECT sleep": { kind: "silent" } } });
    const port = Number(fake.target.slice(fake.target.lastIndexOf(":") + 1));
    channel = grpcWireTransport(
      buildSparkConnectionOptions(
        { id: "c", name: "c", type: "spark", host: "127.0.0.1", port } as unknown as DatabaseConnection,
        { queryTimeout: 5_000 },
      ),
    );
  });
  afterAll(() => {
    channel.close();
    fake.close();
  });

  test("while a silent call is open, a Config get_option of spark.sql.ansi.enabled arrives on its session at each interval", async () => {
    const held = session();
    const answers: Promise<object>[] = [];
    const beat = async (target: SparkSessionRef) => {
      const answer = channel.unary("Config", configGetOptionRequest(target, ["spark.sql.ansi.enabled"]), {
        metadata: sparkCallMetadata(undefined),
        deadline: new Date(Date.now() + SPARK_HEARTBEAT_DEADLINE_MS),
        signal: new AbortController().signal,
      });
      answers.push(answer);
      await answer;
    };
    const heartbeat = new SparkHeartbeat(beat, 50);
    const controller = new AbortController();
    const stream = channel.executePlan(
      relationRequest(
        held,
        { sql: { query: "SELECT sleep" } },
        { operationId: randomUUID(), tag: `libredb-studio-${randomUUID()}` },
      ),
      { metadata: {}, deadline: new Date(Date.now() + 5_000), signal: controller.signal },
      { maxReceivedBytes: 33_554_432 },
    );
    fake.log.clear();
    const release = heartbeat.hold(held);
    await new Promise((resolve) => setTimeout(resolve, 330));
    release();
    // Each beat sent before the release has its answer, so the fake logged it before the log is read.
    await Promise.allSettled(answers);
    const beats = fake.log.entries.filter(
      (entry) =>
        entry.rpc === "Config" &&
        entry.sessionId === held.sessionId &&
        JSON.stringify((entry.request as { operation: unknown }).operation).includes("spark.sql.ansi.enabled"),
    );
    expect(beats.length).toBeGreaterThanOrEqual(4);
    expect(beats.length).toBe(heartbeat.beatsSent());
    const settled = fake.log.entries.length;
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect(fake.log.entries.length).toBe(settled);
    controller.abort();
    await stream.read().then(
      () => undefined,
      () => undefined,
    );
  });
});
