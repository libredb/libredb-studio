/**
 * The in-flight bounds every client call of a provider passes through (vector family, PR 1v).
 *
 * Every case uses an engine key of its own, because the per-engine table is process-wide by design and this
 * file runs in a bun process of its own: no case can see another case's counters.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { QueryCancelledError, QueryError } from "@/lib/db/errors";
import {
  type BoundedLimiterOptions,
  createRunRegistry,
  DuplicateRunError,
  engineLimiter,
  LimiterFullError,
  type LimiterTicket,
  type ProviderLimiter,
  type RunHandle,
  type RunRegistry,
} from "@/lib/db/utils/bounded-limiter";
import { newLocalId } from "@/lib/ids";

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

describe("createRunRegistry", () => {
  const QUERY_ID_SENTENCE = 'queryId must be 1 to 128 characters of letters, digits, "_" and "-"';

  test("cancel aborts a run's signal with a cancellation and answers true", () => {
    const registry: RunRegistry = createRunRegistry();
    const handle: RunHandle = registry.begin("q-1", never());
    expect(registry.cancel("q-1")).toBe(true);
    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toBeInstanceOf(QueryCancelledError);
  });

  test("an unknown id answers false", () => {
    expect(createRunRegistry().cancel("q-unknown")).toBe(false);
  });

  test("a queryId already running is refused, and free again once its run ended", () => {
    const registry = createRunRegistry();
    const first = registry.begin("q-dup", never());
    expect(() => registry.begin("q-dup", never())).toThrow(DuplicateRunError);
    expect(() => registry.begin("q-dup", never())).toThrow(
      "A run with this queryId is already running or waiting on this connection. Start the next run with a new queryId.",
    );
    first.end();
    expect(() => registry.begin("q-dup", never()).end()).not.toThrow();
  });

  test("DuplicateRunError is a QueryError", () => {
    const registry = createRunRegistry();
    registry.begin("q-a", never());
    try {
      registry.begin("q-a", never());
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(QueryError);
      expect((error as Error).name).toBe("DuplicateRunError");
    }
  });

  test("a stale end of a reused id leaves the newer run cancellable", () => {
    const registry = createRunRegistry();
    const older = registry.begin("q-reused", never());
    older.end();
    const newer = registry.begin("q-reused", never());
    older.end();
    expect(registry.cancel("q-reused")).toBe(true);
    expect(newer.signal.aborted).toBe(true);
  });

  test("a run with no queryId takes the deadline as its signal and registers nothing", () => {
    const registry = createRunRegistry();
    const deadline = new AbortController();
    const handle = registry.begin(undefined, deadline.signal);
    expect(handle.signal).toBe(deadline.signal);
    handle.end();
  });

  test("the deadline aborts the run's signal with the deadline's reason", () => {
    const deadline = new AbortController();
    const handle = createRunRegistry().begin("q-deadline", deadline.signal);
    const reason = new Error("the 10 s deadline passed");
    deadline.abort(reason);
    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toBe(reason);
  });

  test.each<[string, string]>([
    ["129 characters", "a".repeat(129)],
    ["a space", "q 1"],
    ["an empty string", ""],
    ["a slash", "q/1"],
  ])("refuses a queryId of %s as a QueryError naming the field, and registers nothing", (_label, queryId) => {
    const registry = createRunRegistry();
    expect(() => registry.begin(queryId, never())).toThrow(QUERY_ID_SENTENCE);
    expect(() => registry.begin(queryId, never())).toThrow(QueryError);
    expect(registry.cancel(queryId)).toBe(false);
  });

  test("refuses a queryId that is not a string", () => {
    expect(() => createRunRegistry().begin(42 as unknown as string, never())).toThrow(QUERY_ID_SENTENCE);
  });

  test("accepts 128 characters and the browser's own id form", () => {
    const registry = createRunRegistry();
    registry.begin("a".repeat(128), never());
    const browserId = `q-${Date.now()}-${newLocalId()}`;
    registry.begin(browserId, never());
    expect(registry.cancel(browserId)).toBe(true);
  });
});

/** A client double: each call starts, records itself, and settles only when the test says so or its signal aborts. */
function recordingClient() {
  const log: string[] = [];
  const open = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>();
  let inFlight = 0;
  let peak = 0;
  return {
    log,
    inFlight: () => inFlight,
    peak: () => peak,
    started: (name: string) => log.includes(`start ${name}`),
    call(name: string, signal?: AbortSignal): Promise<void> {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      log.push(`start ${name}`);
      return new Promise<void>((resolve, reject) => {
        const finish = (outcome: () => void) => {
          open.delete(name);
          inFlight -= 1;
          log.push(`end ${name}`);
          outcome();
        };
        open.set(name, { resolve: () => finish(resolve), reject: (error) => finish(() => reject(error)) });
        signal?.addEventListener("abort", () => open.get(name)?.reject(signal.reason), { once: true });
      });
    },
    settleCall(name: string): void {
      const call = open.get(name);
      if (call === undefined) throw new Error(`no open call named ${name}`);
      call.resolve();
    },
  };
}

/** One permit per call: what every caller but the console does. */
async function permitted(limiter: ProviderLimiter, signal: AbortSignal, work: () => Promise<void>): Promise<void> {
  const ticket = await limiter.acquire(signal);
  try {
    await work();
  } finally {
    ticket.release();
  }
}

/** A console request: one permit, held across its phase 1 read and its phase 2 call, issued one after the other. */
async function consoleRun(
  limiter: ProviderLimiter,
  client: ReturnType<typeof recordingClient>,
  signal: AbortSignal,
): Promise<void> {
  const ticket = await limiter.acquire(signal);
  try {
    await client.call("console-phase-1", signal);
    await client.call("console-phase-2", signal);
  } finally {
    ticket.release();
  }
}

describe("one permit per call, on one provider", () => {
  test("the Tables panel at concurrency 4 and a console run never put five calls in flight, and the run starts when the first panel read settles", async () => {
    const limiter = engineLimiter(freshKey(), BOUNDS)();
    const client = recordingClient();
    const panel = ["t1", "t2", "t3", "t4"].map((name) => permitted(limiter, never(), () => client.call(name)));
    const run = consoleRun(limiter, client, never());
    await settle();
    expect(client.inFlight()).toBe(4);
    expect(client.started("console-phase-1")).toBe(false);

    client.settleCall("t1");
    await settle();
    expect(client.started("console-phase-1")).toBe(true);

    client.settleCall("console-phase-1");
    await settle();
    for (const name of ["t2", "t3", "t4", "console-phase-2"]) client.settleCall(name);
    await Promise.all([...panel, run]);
    expect(client.peak()).toBe(4);
  });

  test("a console request issues its phase 1 and phase 2 calls one after the other on one permit", async () => {
    const limiter = engineLimiter(freshKey(), BOUNDS)();
    const client = recordingClient();
    const run = consoleRun(limiter, client, never());
    await settle();
    expect(client.inFlight()).toBe(1);
    client.settleCall("console-phase-1");
    await settle();
    expect(client.inFlight()).toBe(1);
    expect(client.log.indexOf("end console-phase-1")).toBeLessThan(client.log.indexOf("start console-phase-2"));
    client.settleCall("console-phase-2");
    await run;
    const four = await Promise.all([1, 2, 3, 4].map(() => limiter.acquire(never())));
    for (const ticket of four) ticket.release();
  });

  test("the Load preview with one console run in flight holds at most three permits until that run settles", async () => {
    const limiter = engineLimiter(freshKey(), BOUNDS)();
    const client = recordingClient();
    const run = consoleRun(limiter, client, never());
    await settle();
    const preview = ["p1", "p2", "p3", "p4"].map((name) => permitted(limiter, never(), () => client.call(name)));
    await settle();
    expect(["p1", "p2", "p3"].every((name) => client.started(name))).toBe(true);
    expect(client.started("p4")).toBe(false);

    client.settleCall("console-phase-1");
    await settle();
    expect(client.started("p4")).toBe(false);

    client.settleCall("console-phase-2");
    await run;
    await settle();
    expect(client.started("p4")).toBe(true);
    for (const name of ["p1", "p2", "p3", "p4"]) client.settleCall(name);
    await Promise.all(preview);
    expect(client.peak()).toBe(4);
  });

  test("a queued panel read whose deadline passes leaves the queue having sent nothing", async () => {
    const limiter = engineLimiter(freshKey(), { perProvider: 1, perEngine: 16, queueDepth: 64 })();
    const client = recordingClient();
    const first = permitted(limiter, never(), () => client.call("first"));
    const deadline = new AbortController();
    const late = permitted(limiter, deadline.signal, () => client.call("late"));
    await settle();
    deadline.abort(new Error("the 10 s deadline passed"));
    await expect(late).rejects.toThrow("the 10 s deadline passed");
    client.settleCall("first");
    await first;
    await settle();
    expect(client.started("late")).toBe(false);
  });

  test("a queued run cancelled by its queryId sends nothing, and cancel answers true", async () => {
    const limiter = engineLimiter(freshKey(), { perProvider: 1, perEngine: 16, queueDepth: 64 })();
    const registry = createRunRegistry();
    const client = recordingClient();
    const first = permitted(limiter, never(), () => client.call("first"));
    const handle = registry.begin("q-queued", never());
    const queued = permitted(limiter, handle.signal, () => client.call("queued")).finally(() => handle.end());
    await settle();
    expect(registry.cancel("q-queued")).toBe(true);
    await expect(queued).rejects.toBeInstanceOf(QueryCancelledError);
    client.settleCall("first");
    await first;
    await settle();
    expect(client.started("queued")).toBe(false);
    expect(registry.cancel("q-queued")).toBe(false);
  });

  test("an abandoned run releases its permit when its deadline ends its call", async () => {
    const limiter = engineLimiter(freshKey(), { perProvider: 1, perEngine: 16, queueDepth: 64 })();
    const registry = createRunRegistry();
    const client = recordingClient();
    const deadline = new AbortController();
    const handle = registry.begin("q-abandoned", deadline.signal);
    const abandoned = permitted(limiter, handle.signal, () => client.call("abandoned", handle.signal)).finally(() =>
      handle.end(),
    );
    await settle();
    const next = permitted(limiter, never(), () => client.call("next"));
    await settle();
    expect(client.started("next")).toBe(false);

    deadline.abort(new Error("the 30 s deadline passed"));
    await expect(abandoned).rejects.toThrow("the 30 s deadline passed");
    await settle();
    expect(client.started("next")).toBe(true);
    client.settleCall("next");
    await next;
    expect(registry.cancel("q-abandoned")).toBe(false);
  });
});
