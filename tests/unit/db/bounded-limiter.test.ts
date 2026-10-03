/**
 * The in-flight bounds every client call of a provider passes through (vector family, PR 1v).
 *
 * Every case uses an engine key of its own, because the per-engine table is process-wide by design and this
 * file runs in a bun process of its own: no case can see another case's counters.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { QueryError } from "@/lib/db/errors";
import {
  type BoundedLimiterOptions,
  engineLimiter,
  LimiterFullError,
  type LimiterTicket,
  type ProviderLimiter,
} from "@/lib/db/utils/bounded-limiter";

const BOUNDS: BoundedLimiterOptions = { perProvider: 4, perEngine: 16, queueDepth: 64 };

let keys = 0;
/** A fresh engine key, so each case starts from an empty per-engine table. */
function freshKey(): string {
  keys += 1;
  return `test-engine-${keys}`;
}

/** Lets every settled promise run its continuations. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function never(): AbortSignal {
  return new AbortController().signal;
}

/** An acquire whose outcome a test reads without awaiting it. */
function track(limiter: ProviderLimiter, signal: AbortSignal = never()): { ticket?: LimiterTicket; error?: unknown } {
  const state: { ticket?: LimiterTicket; error?: unknown } = {};
  limiter.acquire(signal).then(
    (ticket) => {
      state.ticket = ticket;
    },
    (error: unknown) => {
      state.error = error;
    },
  );
  return state;
}

describe("engineLimiter: admission", () => {
  test("five providers of one engine key: the 17th call waits until a permit is released", async () => {
    const factory = engineLimiter(freshKey(), BOUNDS);
    const providers = Array.from({ length: 5 }, () => factory());
    const first16 = providers.slice(0, 4).flatMap((provider) => Array.from({ length: 4 }, () => track(provider)));
    await settle();
    expect(first16.every((state) => state.ticket !== undefined)).toBe(true);

    const seventeenth = track(providers[4]);
    await settle();
    expect(seventeenth.ticket).toBeUndefined();
    expect(seventeenth.error).toBeUndefined();

    first16[0].ticket?.release();
    await settle();
    expect(seventeenth.ticket).toBeDefined();
  });

  test("two engine keys do not share a bound", async () => {
    const a = engineLimiter(freshKey(), { perProvider: 1, perEngine: 1, queueDepth: 4 })();
    const b = engineLimiter(freshKey(), { perProvider: 1, perEngine: 1, queueDepth: 4 })();
    const heldA = track(a);
    const heldB = track(b);
    await settle();
    expect(heldA.ticket).toBeDefined();
    expect(heldB.ticket).toBeDefined();
  });

  test("one provider's waiting calls are admitted in the order they arrived", async () => {
    const provider = engineLimiter(freshKey(), { perProvider: 1, perEngine: 4, queueDepth: 8 })();
    const order: number[] = [];
    const held = await provider.acquire(never());
    const waiting = [1, 2, 3].map((n) =>
      provider.acquire(never()).then((ticket) => {
        order.push(n);
        return ticket;
      }),
    );
    held.release();
    (await waiting[0]).release();
    (await waiting[1]).release();
    (await waiting[2]).release();
    expect(order).toEqual([1, 2, 3]);
  });

  test("a provider at its own bound does not block a later call of another provider", async () => {
    const factory = engineLimiter(freshKey(), { perProvider: 1, perEngine: 2, queueDepth: 8 });
    const busy = factory();
    const other = factory();
    const held = await busy.acquire(never());
    const blocked = track(busy);
    const free = track(other);
    await settle();
    expect(blocked.ticket).toBeUndefined();
    expect(free.ticket).toBeDefined();
    held.release();
    await settle();
    expect(blocked.ticket).toBeDefined();
  });

  test("a release admits the earliest call whose provider is below its bound, skipping one whose provider is not", async () => {
    const factory = engineLimiter(freshKey(), { perProvider: 1, perEngine: 2, queueDepth: 8 });
    const busy = factory();
    const third = factory();
    const other = factory();
    const heldBusy = await busy.acquire(never());
    const heldThird = await third.acquire(never());
    const busyNext = track(busy);
    const otherNext = track(other);
    await settle();
    expect(busyNext.ticket).toBeUndefined();
    expect(otherNext.ticket).toBeUndefined();

    heldThird.release();
    await settle();
    expect(busyNext.ticket).toBeUndefined();
    expect(otherNext.ticket).toBeDefined();

    heldBusy.release();
    await settle();
    expect(busyNext.ticket).toBeDefined();
  });

  test("a ticket released twice frees one slot", async () => {
    const provider = engineLimiter(freshKey(), { perProvider: 2, perEngine: 2, queueDepth: 4 })();
    const first = await provider.acquire(never());
    const second = await provider.acquire(never());
    first.release();
    first.release();
    const third = track(provider);
    const fourth = track(provider);
    await settle();
    expect(third.ticket).toBeDefined();
    expect(fourth.ticket).toBeUndefined();
    second.release();
    await settle();
    expect(fourth.ticket).toBeDefined();
  });
});

describe("engineLimiter: the queue", () => {
  test("a full queue refuses at once with a sentence that names the bound", async () => {
    const provider = engineLimiter(freshKey(), { perProvider: 1, perEngine: 1, queueDepth: 2 })();
    await provider.acquire(never());
    track(provider);
    track(provider);
    const refused = provider.acquire(never());
    await expect(refused).rejects.toBeInstanceOf(LimiterFullError);
    await expect(refused).rejects.toBeInstanceOf(QueryError);
    await expect(refused).rejects.toThrow(
      "This engine already has 2 calls waiting for its 1 in-flight slots in this Studio process, so the call was refused before it was sent. Try again when the running calls finish.",
    );
  });

  test("a waiting call whose signal aborts leaves the queue with the signal's reason and is never admitted", async () => {
    const provider = engineLimiter(freshKey(), { perProvider: 1, perEngine: 1, queueDepth: 1 })();
    const held = await provider.acquire(never());
    const controller = new AbortController();
    const waiting = track(provider, controller.signal);
    const reason = new Error("the deadline passed");
    controller.abort(reason);
    await settle();
    expect(waiting.error).toBe(reason);

    const next = track(provider);
    await settle();
    expect(next.error).toBeUndefined();
    held.release();
    await settle();
    expect(next.ticket).toBeDefined();
    expect(waiting.ticket).toBeUndefined();
  });

  test("a signal already aborted is refused with its reason and takes no slot", async () => {
    const provider = engineLimiter(freshKey(), { perProvider: 1, perEngine: 1, queueDepth: 0 })();
    const controller = new AbortController();
    const reason = new Error("gone before it asked");
    controller.abort(reason);
    await expect(provider.acquire(controller.signal)).rejects.toBe(reason);
    const ticket = await provider.acquire(never());
    ticket.release();
  });
});

describe("engineLimiter: one engine key, one set of bounds", () => {
  test("a second call with other bounds throws, and one with the same bounds shares the table", async () => {
    const key = freshKey();
    const a = engineLimiter(key, { perProvider: 1, perEngine: 1, queueDepth: 1 })();
    expect(() => engineLimiter(key, { perProvider: 2, perEngine: 1, queueDepth: 1 })).toThrow(
      `engineLimiter("${key}") was already created with other bounds: one engine key has one set of bounds in a process`,
    );
    const b = engineLimiter(key, { perProvider: 1, perEngine: 1, queueDepth: 1 })();
    const held = await a.acquire(never());
    const waiting = track(b);
    await settle();
    expect(waiting.ticket).toBeUndefined();
    held.release();
    await settle();
    expect(waiting.ticket).toBeDefined();
  });

  test.each<[string, BoundedLimiterOptions]>([
    ["perProvider 0", { perProvider: 0, perEngine: 1, queueDepth: 1 }],
    ["perEngine 1.5", { perProvider: 1, perEngine: 1.5, queueDepth: 1 }],
    ["queueDepth -1", { perProvider: 1, perEngine: 1, queueDepth: -1 }],
  ])("refuses %s", (_label, options) => {
    expect(() => engineLimiter(freshKey(), options)).toThrow(
      "BoundedLimiterOptions takes whole numbers: perProvider and perEngine at least 1, and queueDepth at least 0",
    );
  });

  test("imports nothing but the error classes, so nothing in it is Node-only", () => {
    const source = readFileSync(path.resolve(import.meta.dir, "../../../src/lib/db/utils/bounded-limiter.ts"), "utf8");
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
    expect(imports).toEqual(["@/lib/db/errors"]);
  });
});
