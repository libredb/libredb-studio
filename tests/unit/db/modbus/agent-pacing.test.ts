/**
 * The pacing of agent reads on one Modbus device: never two in flight, a gap after each measured from the moment the
 * read ended, a wait that counts against the read's own deadline, and a lane released however a read ends.
 */
import { describe, expect, test } from "bun:test";
import {
  deviceKey,
  MODBUS_AGENT_DEVICE_GAP_MS,
  MODBUS_AGENT_PACER,
  ModbusDevicePacer,
  ModbusPacingTimeout,
} from "@/lib/db/providers/industrial/modbus/agent-pacing";

// A pending promise is awaited and then matched, never matched with `.resolves` or `.rejects`: on Windows, bun 1.4.4
// left `await expect(pending).resolves` unsettled for good once a refused waiter's deadline timer had fired, while
// `expect(await pending)` settled (measured on windows-latest).
const GAP = 60;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const far = () => performance.now() + 5000;

/** A read that records when it held the device. */
function holder(log: Array<{ id: string; from: number; to: number }>, id: string, holdMs: number) {
  return async () => {
    const from = performance.now();
    await sleep(holdMs);
    const to = performance.now();
    log.push({ id, from, to });
    return id;
  };
}

describe("the gap the provider keeps", () => {
  test("is a fixed one second, and the agent path has one pacer", () => {
    expect(MODBUS_AGENT_DEVICE_GAP_MS).toBe(1000);
    expect(MODBUS_AGENT_PACER).toBeInstanceOf(ModbusDevicePacer);
  });

  test("a lane is the device's address, host compared without case, and never the unit", () => {
    expect(deviceKey("PLC-1.Local", 502)).toBe(deviceKey("plc-1.local", 502));
    expect(deviceKey("plc", 502)).not.toBe(deviceKey("plc", 503));
  });
});

describe("two reads of one device", () => {
  test("never overlap, and the second dials no sooner than the gap after the first ended", async () => {
    const pacer = new ModbusDevicePacer(GAP);
    const log: Array<{ id: string; from: number; to: number }> = [];
    const key = deviceKey("127.0.0.1", 1502);
    const [a, b] = await Promise.all([
      pacer.run(key, far(), holder(log, "a", 30)),
      pacer.run(key, far(), holder(log, "b", 30)),
    ]);
    expect([a, b]).toEqual(["a", "b"]);
    const [first, second] = log;
    expect(first?.id).toBe("a");
    expect((second?.from ?? 0) - (first?.to ?? 0)).toBeGreaterThanOrEqual(GAP - 2);
  });

  test("of two runs, three reads queue in the order they arrived", async () => {
    const pacer = new ModbusDevicePacer(5);
    const log: Array<{ id: string; from: number; to: number }> = [];
    const key = deviceKey("plc", 502);
    await Promise.all(["x", "y", "z"].map((id) => pacer.run(key, far(), holder(log, id, 5))));
    expect(log.map((entry) => entry.id)).toEqual(["x", "y", "z"]);
    for (let at = 1; at < log.length; at += 1) {
      expect((log[at]?.from ?? 0) >= (log[at - 1]?.to ?? 0)).toBe(true);
    }
  });

  test("two devices do not wait for each other", async () => {
    const pacer = new ModbusDevicePacer(1000);
    const log: Array<{ id: string; from: number; to: number }> = [];
    await pacer.run(deviceKey("a", 502), far(), holder(log, "a1", 1));
    const started = performance.now();
    await pacer.run(deviceKey("b", 502), far(), holder(log, "b1", 1));
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("a read that failed still frees the lane, and the gap still follows it", async () => {
    const pacer = new ModbusDevicePacer(GAP);
    const key = deviceKey("plc", 502);
    let failedAt = 0;
    const failing = pacer.run(key, far(), async () => {
      await sleep(10);
      failedAt = performance.now();
      throw new Error("device gone");
    });
    let dialledAt = 0;
    const next = pacer.run(key, far(), async () => {
      dialledAt = performance.now();
      return "ok";
    });
    expect(((await failing.catch((error: unknown) => error)) as Error).message).toBe("device gone");
    expect(await next).toBe("ok");
    expect(dialledAt - failedAt).toBeGreaterThanOrEqual(GAP - 2);
  });
});

describe("a wait counts against the read's own deadline", () => {
  test("a read whose turn comes after its deadline is refused and never runs", async () => {
    const pacer = new ModbusDevicePacer(GAP);
    const key = deviceKey("plc", 502);
    const first = pacer.run(key, far(), () => sleep(80).then(() => "first"));
    let ran = false;
    const late = pacer.run(key, performance.now() + 20, async () => {
      ran = true;
      return "late";
    });
    const refused = await late.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(ModbusPacingTimeout);
    expect((refused as ModbusPacingTimeout).waitedMs).toBeGreaterThanOrEqual(15);
    expect((refused as ModbusPacingTimeout).waitedMs).toBeLessThan(80);
    expect(ran).toBe(false);
    expect(await first).toBe("first");
  });

  test("a refused waiter keeps its place, so the read behind it still waits for the read in front", async () => {
    const pacer = new ModbusDevicePacer(1);
    const key = deviceKey("plc", 502);
    const log: Array<{ id: string; from: number; to: number }> = [];
    const first = pacer.run(key, far(), holder(log, "first", 60));
    const refused = pacer.run(key, performance.now() + 10, holder(log, "never", 1)).catch((error: unknown) => error);
    const third = pacer.run(key, far(), holder(log, "third", 1));
    expect(await refused).toBeInstanceOf(ModbusPacingTimeout);
    await Promise.all([first, third]);
    expect(log.map((entry) => entry.id)).toEqual(["first", "third"]);
    expect((log[1]?.from ?? 0) >= (log[0]?.to ?? 0)).toBe(true);
  });

  test("a gap that would end after the deadline refuses at once, without sleeping it", async () => {
    const pacer = new ModbusDevicePacer(500);
    const key = deviceKey("plc", 502);
    await pacer.run(key, far(), async () => "first");
    const started = performance.now();
    const refused = await pacer
      .run(key, performance.now() + 100, async () => "second")
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ModbusPacingTimeout);
    expect(performance.now() - started).toBeLessThan(90);
  });

  test("a deadline already past refuses before any wait", async () => {
    const pacer = new ModbusDevicePacer(GAP);
    const refused = await pacer
      .run(deviceKey("plc", 502), performance.now() - 1, async () => "never")
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ModbusPacingTimeout);
    expect((refused as ModbusPacingTimeout).waitedMs).toBe(0);
  });
});

describe("no state outlives its use", () => {
  test("an idle lane is dropped once its gap has passed", async () => {
    const pacer = new ModbusDevicePacer(10);
    await pacer.run(deviceKey("a", 502), far(), async () => "a");
    expect(pacer.laneCount).toBe(1);
    await sleep(20);
    await pacer.run(deviceKey("b", 502), far(), async () => "b");
    expect(pacer.laneCount).toBe(1);
  });

  test("a lane still inside its gap is kept, so the gap is not forgotten", async () => {
    const pacer = new ModbusDevicePacer(1000);
    await pacer.run(deviceKey("a", 502), far(), async () => "a");
    await pacer.run(deviceKey("b", 502), far(), async () => "b");
    expect(pacer.laneCount).toBe(2);
  });

  test("a lane whose only read was refused before its turn holds no gap", async () => {
    const pacer = new ModbusDevicePacer(10);
    await pacer.run(deviceKey("a", 502), performance.now() - 1, async () => "never").catch(() => undefined);
    await pacer.run(deviceKey("b", 502), far(), async () => "b");
    expect(pacer.laneCount).toBe(1);
  });
});

describe("one set of lanes for the whole process", () => {
  // Next.js loads this module more than once in one server process (the instrumentation bundle, which resumes agent
  // runs, apart from the route handlers). Each copy builds its pacer on the map registered on globalThis under one
  // Symbol.for key, so a pacer built on that map is what a second copy of the module would build.
  const processMap = () =>
    (globalThis as Record<symbol, unknown>)[Symbol.for("libredb-studio.modbus-agent-lanes")] as ConstructorParameters<
      typeof ModbusDevicePacer
    >[2];

  test("the agent path's pacer queues on the map registered on globalThis", async () => {
    const key = deviceKey("registered.test.invalid", 502);
    await MODBUS_AGENT_PACER.run(key, far(), async () => "read");
    expect(processMap()?.has(key)).toBe(true);
  });

  test("a pacer built on that map, as another copy of the module builds it, waits for the agent path's", async () => {
    const other = new ModbusDevicePacer(MODBUS_AGENT_DEVICE_GAP_MS, undefined, processMap());
    const log: Array<{ id: string; from: number; to: number }> = [];
    const key = deviceKey("copies.test.invalid", 502);
    await Promise.all([
      MODBUS_AGENT_PACER.run(key, far(), holder(log, "one", 30)),
      other.run(key, far(), holder(log, "two", 1)),
    ]);
    expect(log.map((entry) => entry.id)).toEqual(["one", "two"]);
    expect((log[1]?.from ?? 0) - (log[0]?.to ?? 0)).toBeGreaterThanOrEqual(MODBUS_AGENT_DEVICE_GAP_MS - 2);
  });

  test("a pacer made apart from the process's keeps lanes of its own", async () => {
    const own = new ModbusDevicePacer(1000);
    await own.run(deviceKey("own.test.invalid", 502), far(), async () => "own");
    expect(own.laneCount).toBe(1);
    expect(new ModbusDevicePacer(1000).laneCount).toBe(0);
  });
});

describe("the timers the pacer sets", () => {
  // A deadline on performance.now()'s clock leaves a fraction of a millisecond in every wait; timers are set in
  // whole milliseconds, rounded up so no wait ends before the moment it waits for.
  test("are whole milliseconds, for the deadline it races and the gap it sleeps", async () => {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return real(handler, ms);
    }) as typeof setTimeout;
    try {
      const pacer = new ModbusDevicePacer(GAP);
      const key = deviceKey("plc", 502);
      const first = pacer.run(key, far(), () => sleep(30).then(() => "first"));
      await pacer.run(key, performance.now() + 20.5, async () => "late").catch(() => undefined);
      await first;
      await pacer.run(key, performance.now() + 500.5, async () => "after the gap");
    } finally {
      globalThis.setTimeout = real;
    }
    expect(delays.length).toBeGreaterThan(0);
    for (const delay of delays) expect(Number.isInteger(delay)).toBe(true);
  });
});
