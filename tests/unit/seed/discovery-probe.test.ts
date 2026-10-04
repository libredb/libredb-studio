import { afterEach, describe, expect, it } from "bun:test";
import { createConnection, Socket } from "node:net";
import { createProbe, defaultProbe } from "@/lib/seed/discovery-probe";
import { closeAll, countingListener, eventually, silentListener } from "../../helpers/node-transport-fixtures";

const HOST = "127.0.0.1";

/** A connect seam that dials for real and counts every dial. */
function countingConnect() {
  const counter = {
    calls: 0,
    connect: (port: number, host: string): Socket => {
      counter.calls += 1;
      return createConnection({ port, host });
    },
  };
  return counter;
}

/**
 * A connect seam whose sockets never connect by themselves: a test emits connect or error on one, or the
 * probe's timeout destroys it.
 */
function neverConnecting() {
  const sockets: Socket[] = [];
  return {
    sockets,
    connect: (): Socket => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
  };
}

/** A port nothing listens on: a listener's port after it closed. */
async function closedPort(): Promise<number> {
  const listener = await countingListener();
  await listener.close();
  return listener.port;
}

describe("discovery probe", () => {
  afterEach(async () => {
    defaultProbe.reset();
    await closeAll();
  });

  it("answers true for a listener that accepts and closes at once", async () => {
    const listener = await countingListener();
    const probe = createProbe();

    expect(await probe.check(HOST, listener.port)).toBe(true);
    await eventually(() => listener.accepted() === 1, "the probe connection");
  });

  it("answers true for a listener that holds the connection, and closes its own socket", async () => {
    const listener = await silentListener();
    // Task 6 spies on defaultProbe.check, which a frozen object would refuse.
    expect(Object.isFrozen(defaultProbe)).toBe(false);

    expect(await defaultProbe.check(HOST, listener.port)).toBe(true);
    await eventually(() => listener.accepted() === 1, "the probe connection");
    await eventually(() => listener.open() === 0, "the probe socket to close");
  });

  it("answers false for a refused port and never caches the failure", async () => {
    const port = await closedPort();
    const dial = countingConnect();
    const probe = createProbe({ connect: dial.connect });

    expect(await probe.check(HOST, port)).toBe(false);
    expect(await probe.check(HOST, port)).toBe(false);
    expect(dial.calls).toBe(2);
  });

  it("answers false when the socket never connects within the timeout, and destroys it", async () => {
    const never = neverConnecting();
    const probe = createProbe({ connect: never.connect }, { timeoutMs: 50 });

    expect(await probe.check("db.invalid", 5432)).toBe(false);
    expect(never.sockets).toHaveLength(1);
    expect(never.sockets[0].destroyed).toBe(true);
    expect(await probe.check("db.invalid", 5432)).toBe(false);
    expect(never.sockets).toHaveLength(2);
  });

  it("swallows a second error from a socket that already settled the probe", async () => {
    const never = neverConnecting();
    const probe = createProbe({ connect: never.connect });

    const check = probe.check("db", 5432);
    await eventually(() => never.sockets.length === 1, "the probe to dial");
    never.sockets[0].emit("error", new Error("connect ECONNREFUSED"));
    expect(await check).toBe(false);

    // An EventEmitter throws an "error" nobody listens for, so the probe's listener has to outlive the probe.
    expect(() => never.sockets[0].emit("error", new Error("read ECONNRESET"))).not.toThrow();
  });

  it("caches a success per host:port for 30 seconds and probes again once it lapses", async () => {
    const listener = await countingListener();
    const dial = countingConnect();
    let clock = 1_000;
    // No cacheMs option: the 29,999 ms and 1 ms steps below pin the default.
    const probe = createProbe({ connect: dial.connect, now: () => clock });

    expect(await probe.check(HOST, listener.port)).toBe(true);
    clock += 29_999;
    expect(await probe.check(HOST, listener.port)).toBe(true);
    expect(dial.calls).toBe(1);

    clock += 1;
    expect(await probe.check(HOST, listener.port)).toBe(true);
    expect(dial.calls).toBe(2);
  });

  it("keys the cache by host and port", async () => {
    const first = await countingListener();
    const second = await countingListener();
    const dial = countingConnect();
    const probe = createProbe({ connect: dial.connect });

    expect(await probe.check(HOST, first.port)).toBe(true);
    expect(await probe.check(HOST, second.port)).toBe(true);
    expect(dial.calls).toBe(2);
  });

  it("shares one pending promise between concurrent checks of one host:port", async () => {
    const listener = await countingListener();
    const dial = countingConnect();
    const probe = createProbe({ connect: dial.connect });

    const first = probe.check(HOST, listener.port);
    const second = probe.check(HOST, listener.port);

    expect(second).toBe(first);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(dial.calls).toBe(1);
  });

  it("reset drops a cached success", async () => {
    const listener = await countingListener();
    const dial = countingConnect();
    const probe = createProbe({ connect: dial.connect });

    expect(await probe.check(HOST, listener.port)).toBe(true);
    expect(await probe.check(HOST, listener.port)).toBe(true);
    expect(dial.calls).toBe(1);

    probe.reset();
    expect(await probe.check(HOST, listener.port)).toBe(true);
    expect(dial.calls).toBe(2);
  });

  it("a probe that settles after a reset leaves the newer pending probe shared", async () => {
    const never = neverConnecting();
    const probe = createProbe({ connect: never.connect });

    const before = probe.check("db", 5432);
    probe.reset();
    const after = probe.check("db", 5432);
    expect(after).not.toBe(before);
    await eventually(() => never.sockets.length === 2, "both probes to dial");

    never.sockets[0].emit("error", new Error("connect ECONNREFUSED"));
    expect(await before).toBe(false);
    expect(probe.check("db", 5432)).toBe(after);

    never.sockets[1].emit("connect");
    expect(await after).toBe(true);
  });

  it("does not open more sockets than the concurrency cap and starts a waiting probe when a slot frees", async () => {
    const never = neverConnecting();
    const probe = createProbe({ connect: never.connect }, { concurrency: 2 });

    const checks = ["a", "b", "c"].map((host) => probe.check(host, 6379));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(never.sockets).toHaveLength(2);

    never.sockets[0].emit("connect");
    await eventually(() => never.sockets.length === 3, "the waiting probe to start");
    never.sockets[1].emit("connect");
    never.sockets[2].emit("connect");
    expect(await Promise.all(checks)).toEqual([true, true, true]);
  });

  // A leaked slot leaves the second check waiting forever: the wait below then fails by name after 500 ms, and
  // the 1 s test timeout is the backstop.
  it("frees its slot when the connect seam throws, so the next check still runs", async () => {
    const boom = new Error("Port should be >= 0 and < 65536");
    const never = neverConnecting();
    let dials = 0;
    const probe = createProbe(
      {
        connect: () => {
          dials += 1;
          if (dials === 1) throw boom;
          return never.connect();
        },
      },
      { concurrency: 1 },
    );

    await expect(probe.check("db", 5432)).rejects.toBe(boom);

    const second = probe.check("other-db", 5432);
    await eventually(() => never.sockets.length === 1, "the second check to dial", 500);
    never.sockets[0].emit("connect");
    expect(await second).toBe(true);
  }, 1_000);

  // Review focus (Task 4), at probe level: 100 fallback candidates, at most 16 sockets open at once,
  // and a pass over them that takes one probe timeout per batch of 16, not one per candidate.
  it("probe level: probes 100 candidates with at most 16 sockets open and finishes within one timeout per batch plus three of slack", async () => {
    const timeoutMs = 200;
    const never = neverConnecting();
    let peakOpen = 0;
    const probe = createProbe(
      {
        connect: () => {
          const socket = never.connect();
          peakOpen = Math.max(peakOpen, never.sockets.filter((s) => !s.destroyed).length);
          return socket;
        },
      },
      { timeoutMs },
    );
    const hosts = Array.from({ length: 100 }, (_, i) => `srv-captain--client-${i}`);
    const batches = Math.ceil(hosts.length / 16);

    const started = performance.now();
    const results = await Promise.all(hosts.map((host) => probe.check(host, 5432)));
    const elapsed = performance.now() - started;

    expect(results.every((reachable) => reachable === false)).toBe(true);
    expect(never.sockets).toHaveLength(100);
    expect(peakOpen).toBe(16);
    expect(never.sockets.every((socket) => socket.destroyed)).toBe(true);
    // The ideal is batches * timeoutMs (1400 ms). Three timeouts of slack absorb timer granularity across the waves on
    // the Windows and macOS runners; a cap of 8 needs 13 waves (2600 ms) and still fails.
    expect(elapsed).toBeLessThan((batches + 3) * timeoutMs);
  });
});
