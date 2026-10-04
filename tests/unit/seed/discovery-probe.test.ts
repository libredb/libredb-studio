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
    const sockets: Socket[] = [];
    const probe = createProbe(
      {
        connect: () => {
          const socket = new Socket();
          sockets.push(socket);
          return socket;
        },
      },
      { timeoutMs: 50 },
    );

    expect(await probe.check("db.invalid", 5432)).toBe(false);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].destroyed).toBe(true);
    expect(await probe.check("db.invalid", 5432)).toBe(false);
    expect(sockets).toHaveLength(2);
  });

  it("caches a success per host:port for cacheMs and probes again once it lapses", async () => {
    const listener = await countingListener();
    const dial = countingConnect();
    let clock = 1_000;
    const probe = createProbe({ connect: dial.connect, now: () => clock }, { cacheMs: 30_000 });

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
    const sockets: Socket[] = [];
    const probe = createProbe({
      connect: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
    });

    const before = probe.check("db", 5432);
    probe.reset();
    const after = probe.check("db", 5432);
    expect(after).not.toBe(before);
    await eventually(() => sockets.length === 2, "both probes to dial");

    sockets[0].emit("error", new Error("connect ECONNREFUSED"));
    expect(await before).toBe(false);
    expect(probe.check("db", 5432)).toBe(after);

    sockets[1].emit("connect");
    expect(await after).toBe(true);
  });

  it("does not open more sockets than the concurrency cap and starts a waiting probe when a slot frees", async () => {
    const sockets: Socket[] = [];
    const probe = createProbe(
      {
        connect: () => {
          const socket = new Socket();
          sockets.push(socket);
          return socket;
        },
      },
      { concurrency: 2 },
    );

    const checks = ["a", "b", "c"].map((host) => probe.check(host, 6379));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sockets).toHaveLength(2);

    sockets[0].emit("connect");
    await eventually(() => sockets.length === 3, "the waiting probe to start");
    sockets[1].emit("connect");
    sockets[2].emit("connect");
    expect(await Promise.all(checks)).toEqual([true, true, true]);
  });

  // Review focus (Task 4), at probe level: 100 fallback candidates, at most 16 sockets open at once,
  // and a pass over them that takes one probe timeout per batch of 16, not one per candidate.
  it("probe level: probes 100 candidates with at most 16 sockets open and finishes within one timeout per batch", async () => {
    const timeoutMs = 200;
    const sockets: Socket[] = [];
    let peakOpen = 0;
    const probe = createProbe(
      {
        connect: () => {
          const socket = new Socket();
          sockets.push(socket);
          peakOpen = Math.max(peakOpen, sockets.filter((s) => !s.destroyed).length);
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
    expect(sockets).toHaveLength(100);
    expect(peakOpen).toBe(16);
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
    expect(elapsed).toBeLessThan((batches + 1) * timeoutMs);
  });
});
