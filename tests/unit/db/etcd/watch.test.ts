/**
 * The bounded watch (spec 5.3), through the shared fake client (plan C12), whose `watch` behaves as
 * the adapter's does by the seam's contract (plan C1): it hands each batch to the loop's
 * callback, settles "stopped" when the callback answers stop, settles "aborted" when the call's
 * signal aborts, and otherwise settles with the end etcd sent or rejects with the stream's failure.
 * The window's clock is injected, so no test waits on a real timer.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { AuthenticationError, ConnectionError, QueryCancelledError, QueryError, TimeoutError } from "@/lib/db/errors";
import {
  type EtcdCallOptions,
  type EtcdClient,
  EtcdError,
  type EtcdKeyValue,
  type EtcdWatchBatch,
  type EtcdWatchEnd,
  type EtcdWatchEvent,
  type EtcdWatchRequest,
} from "@/lib/db/providers/keyvalue/etcd/client";
import type { EtcdErrorConnection } from "@/lib/db/providers/keyvalue/etcd/errors";
import { runBoundedWatch } from "@/lib/db/providers/keyvalue/etcd/watch";
import { createFakeEtcdClient } from "../../../helpers/etcd-fake-client";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

const CONNECTION: EtcdErrorConnection = {
  host: "etcd.test",
  port: 2379,
  runtimeReportsTlsCause: true,
  receiveCapBytes: 16 * 1024 * 1024,
  timeoutMs: 60_000,
};

/** A header whose ids are past 2^53, as a real cluster's are, so they can only travel as strings. */
const HEADER = { clusterId: "14841639068965178418", memberId: "10276657743932975437", revision: "88", raftTerm: "2" };

const REQUEST: EtcdWatchRequest = { key: enc("/apisix/routes/"), rangeEnd: enc("/apisix/routes0"), prevKv: false };
const LABEL = "/apisix/routes/ (prefix)";
const BOUNDS = { windowMs: 5_000, rowLimit: 3, byteBudget: 100, rangeLabel: LABEL };

function kv(key: string, value: string, modRevision: string): EtcdKeyValue {
  return { key: enc(key), value: enc(value), createRevision: "80", modRevision, version: "1", lease: "0" };
}
function put(key: string, value: string, modRevision = "81"): EtcdWatchEvent {
  return { type: "put", kv: kv(key, value, modRevision) };
}
const batch = (...events: EtcdWatchEvent[]): EtcdWatchBatch => ({ header: HEADER, events });

interface Timer {
  readonly ms: number;
  readonly fn: () => void;
  cancelled: boolean;
}

/** The loop's context: the caller's signal, an injected clock and timers the test fires by hand. */
function harness(readable?: { readonly user: string; readonly ranges: string }) {
  const controller = new AbortController();
  const timers: Timer[] = [];
  const clock = { now: 50_000 };
  const context = {
    signal: controller.signal,
    now: () => clock.now,
    setTimer: (ms: number, fn: () => void) => {
      const timer: Timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    errors: CONNECTION,
    ...(readable === undefined ? {} : { readable }),
  };
  return { controller, timers, clock, context };
}

/** The adapter's watch as the seam promises it (plan C1), driven by the test one batch or end at a time. */
function liveWatch() {
  let onBatch: ((batch: EtcdWatchBatch) => "continue" | "stop") | undefined;
  let settle: ((end: EtcdWatchEnd) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  let callSignal: AbortSignal | undefined;
  const watch: EtcdClient["watch"] = (_request, callback, options: EtcdCallOptions) =>
    new Promise<EtcdWatchEnd>((resolve, fail) => {
      onBatch = callback;
      settle = resolve;
      reject = fail;
      callSignal = options.signal;
      options.signal.addEventListener("abort", () => resolve({ reason: "aborted" }), { once: true });
    });
  return {
    watch,
    /** Hands one batch to the loop, and settles "stopped" when it answers stop, as the adapter does. */
    push(next: EtcdWatchBatch): "continue" | "stop" {
      const answer = (onBatch as (batch: EtcdWatchBatch) => "continue" | "stop")(next);
      if (answer === "stop") settle?.({ reason: "stopped" });
      return answer;
    },
    end(end: EtcdWatchEnd): void {
      settle?.(end);
    },
    fail(error: unknown): void {
      reject?.(error);
    },
    signal: (): AbortSignal => callSignal as AbortSignal,
  };
}

async function failure(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending;
  } catch (error) {
    return error as Error;
  }
  throw new Error("the watch was expected to fail");
}

describe("the window (spec 5.3)", () => {
  test("a quiet window ends when the injected timer fires, with no event and the window's own reason", async () => {
    const { context, timers } = harness();
    const live = liveWatch();
    const fake = createFakeEtcdClient({ watch: live.watch });
    const pending = runBoundedWatch(fake, REQUEST, BOUNDS, context);
    expect(timers.map((timer) => timer.ms)).toEqual([5_000]);
    expect(fake.calls.map((call) => [call.method, call.args[0]])).toEqual([["watch", REQUEST]]);
    timers[0].fn();
    expect(await pending).toEqual({ events: [], endedBy: "window", rangeLabel: LABEL, windowMs: 5_000 });
    // The window aborted the loop's own signal, never the caller's, so the call's deadline stays the query timeout.
    expect(live.signal().aborted).toBe(true);
    expect(context.signal.aborted).toBe(false);
  });

  test("events delivered inside the window are answered in order, a delete and a previous value kept", async () => {
    const { context, timers } = harness();
    const live = liveWatch();
    const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, BOUNDS, context);
    const created = put("/apisix/routes/1", '{"uri":"/a"}');
    const removed: EtcdWatchEvent = {
      type: "delete",
      kv: kv("/apisix/routes/2", "", "82"),
      prevKv: kv("/apisix/routes/2", "old", "70"),
    };
    expect(live.push(batch(created))).toBe("continue");
    expect(live.push(batch(removed))).toBe("continue");
    timers[0].fn();
    const outcome = await pending;
    expect(outcome.events).toEqual([created, removed]);
    expect(outcome.endedBy).toBe("window");
  });

  test("a batch that arrives once the window has run out is not held, though its timer has not fired yet", async () => {
    const { context, clock } = harness();
    const live = liveWatch();
    const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, BOUNDS, context);
    clock.now += 5_000;
    expect(live.push(batch(put("/apisix/routes/1", "late")))).toBe("stop");
    expect(await pending).toEqual({ events: [], endedBy: "window", rangeLabel: LABEL, windowMs: 5_000 });
  });

  test("a window that was capped says so, for results.ts's warning", async () => {
    const { context, timers } = harness();
    const live = liveWatch();
    const capped = { ...BOUNDS, windowMs: 4_000, capped: { queryTimeoutMs: 5_000 } };
    const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, capped, context);
    expect(timers.map((timer) => timer.ms)).toEqual([4_000]);
    timers[0].fn();
    expect(await pending).toEqual({
      events: [],
      endedBy: "window",
      rangeLabel: LABEL,
      windowMs: 4_000,
      capped: { queryTimeoutMs: 5_000 },
    });
  });

  test("the caller's cancel after the window closed changes nothing: the window's events are answered", async () => {
    const { context, timers, controller } = harness();
    const live = liveWatch();
    const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, BOUNDS, context);
    const created = put("/apisix/routes/1", "v");
    live.push(batch(created));
    timers[0].fn();
    controller.abort();
    expect(await pending).toMatchObject({ events: [created], endedBy: "window" });
  });
});

describe("the row limit and the byte budget (spec 5.3, 5.4)", () => {
  test("a batch that passes the row limit is cut at it, and the watch stops at once", async () => {
    const { context } = harness();
    const live = liveWatch();
    const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, BOUNDS, context);
    const events = ["1", "2", "3", "4"].map((id) => put(`/apisix/routes/${id}`, "v"));
    expect(live.push(batch(...events))).toBe("stop");
    const outcome = await pending;
    expect(outcome.events).toEqual(events.slice(0, 3));
    expect(outcome.endedBy).toBe("rows");
  });

  test("a batch that reaches the row limit exactly stops the watch without waiting for the next", async () => {
    const { context } = harness();
    const live = liveWatch();
    const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, BOUNDS, context);
    expect(live.push(batch(put("/apisix/routes/1", "v")))).toBe("continue");
    expect(live.push(batch(put("/apisix/routes/2", "v"), put("/apisix/routes/3", "v")))).toBe("stop");
    expect(await pending).toMatchObject({ endedBy: "rows" });
  });

  test("the window's timer firing after the row limit stopped the watch leaves the row limit as its end", async () => {
    const { context, timers } = harness();
    const live = liveWatch();
    const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, BOUNDS, context);
    const events = ["1", "2", "3"].map((id) => put(`/apisix/routes/${id}`, "v"));
    expect(live.push(batch(...events))).toBe("stop");
    // The adapter has settled "stopped", and the loop has not released its timer yet: the timer fires in between.
    timers[0].fn();
    expect(await pending).toMatchObject({ events, endedBy: "rows" });
  });

  test("an event that would take the events past the byte budget is not held, and ends the watch", async () => {
    const { context } = harness();
    const live = liveWatch();
    const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, BOUNDS, context);
    // Each event holds a 16-byte key and a 44-byte value: 60 bytes, so two pass the 100-byte budget.
    const first = put("/apisix/routes/1", "x".repeat(44));
    expect(live.push(batch(first, put("/apisix/routes/2", "y".repeat(44))))).toBe("stop");
    expect(await pending).toMatchObject({ events: [first], endedBy: "bytes" });
  });

  test("events that fill the budget exactly are held, and the watch ends there", async () => {
    const { context } = harness();
    const live = liveWatch();
    const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, BOUNDS, context);
    const first = put("/apisix/routes/1", "x".repeat(44)); // 60 bytes
    const second = put("/apisix/routes/2", "y".repeat(24)); // 40 bytes: 100, the whole budget
    expect(live.push(batch(first, second))).toBe("stop");
    expect(await pending).toMatchObject({ events: [first, second], endedBy: "bytes" });
  });

  test("a previous value counts toward the budget", async () => {
    const { context } = harness();
    const live = liveWatch();
    const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, BOUNDS, context);
    const first = put("/apisix/routes/1", "x".repeat(24)); // 40 bytes
    // 16 + 4 bytes of key and value, and a 50-byte previous value: 70, and 40 + 70 is past 100.
    const second: EtcdWatchEvent = {
      type: "put",
      kv: kv("/apisix/routes/2", "four", "83"),
      prevKv: kv("/apisix/routes/2", "p".repeat(50), "60"),
    };
    expect(live.push(batch(first, second))).toBe("stop");
    expect(await pending).toMatchObject({ events: [first], endedBy: "bytes" });
  });

  test("a first event larger than the budget is held, so its value still answers one row, and the watch ends", async () => {
    const { context } = harness();
    const live = liveWatch();
    const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, BOUNDS, context);
    const large = put("/apisix/routes/1", "z".repeat(200));
    expect(live.push(batch(large))).toBe("stop");
    expect(await pending).toMatchObject({ events: [large], endedBy: "bytes" });
  });
});

describe("how a watch ends as an error (spec 5.3, plan Review Focus 3)", () => {
  test("a compacted start revision is the compacted error with the compact revision, never a quiet window", async () => {
    const { context } = harness();
    const live = liveWatch();
    const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, BOUNDS, context);
    live.end({ reason: "compacted", compactRevision: "31" });
    const error = await failure(pending);
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(
      "The watch starts at a revision etcd has compacted: watch from revision 31 or later. (etcd: mvcc: required revision has been compacted)",
    );
  });

  test("an in-band PermissionDenied names the range and what the user may read (spec 5.6)", async () => {
    const { context } = harness({ user: "reader", ranges: "/app/ (prefix), /config/a" });
    const live = liveWatch();
    const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, BOUNDS, context);
    live.end({
      reason: "canceled",
      cancelReason: "rpc error: code = PermissionDenied desc = etcdserver: permission denied",
    });
    const error = await failure(pending);
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toContain(`etcd refused the watch on ${LABEL}`);
    expect(error.message).toContain("etcd user reader may read: /app/ (prefix), /config/a.");
  });

  test("a token that expired during the watch and was not renewed ends it with the sign-in error, the adapter's one renewal spent", async () => {
    const { context } = harness();
    const live = liveWatch();
    const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, BOUNDS, context);
    live.push(batch(put("/apisix/routes/1", "v")));
    live.end({
      reason: "canceled",
      cancelReason: "rpc error: code = Unauthenticated desc = etcdserver: invalid auth token",
    });
    const error = await failure(pending);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toContain("etcd did not accept this connection's sign-in for the watch");
  });

  test("a Canceled cancel_reason etcd sent is a QueryError, never the caller's own cancel", async () => {
    const { context } = harness();
    const live = liveWatch();
    const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, BOUNDS, context);
    live.end({ reason: "canceled", cancelReason: "rpc error: code = Canceled desc = context canceled" });
    const error = await failure(pending);
    expect(error).toBeInstanceOf(QueryError);
    expect(error).not.toBeInstanceOf(QueryCancelledError);
    expect(error.message).toBe("The watch was cancelled before etcd answered. (context canceled)");
  });

  test("the member stopping mid-watch ends it with the stream's failure, and the events read before it are not answered", async () => {
    const { context } = harness();
    const live = liveWatch();
    const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, BOUNDS, context);
    live.push(batch(put("/apisix/routes/1", "v")));
    live.fail(new EtcdError("unavailable", "Connection dropped", 14));
    const error = await failure(pending);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe("etcd did not answer the watch. (Connection dropped)");
  });

  test("a leader lost mid-watch ends it with the lost-quorum error", async () => {
    const { context } = harness();
    const live = liveWatch();
    const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, BOUNDS, context);
    live.fail(new EtcdError("no-leader", "etcdserver: no leader", 14));
    const error = await failure(pending);
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toContain("has no leader: the cluster has lost quorum");
  });

  test("the caller's cancelQuery ends the watch as a cancellation", async () => {
    const { context, controller } = harness();
    const live = liveWatch();
    const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, BOUNDS, context);
    controller.abort();
    const error = await failure(pending);
    expect(error).toBeInstanceOf(QueryCancelledError);
    expect(error.message).toBe("The watch was cancelled.");
    expect(live.signal().aborted).toBe(true);
  });

  test("the query timeout ends the watch as a deadline, which a window below the cap never meets", async () => {
    const { context, controller } = harness();
    const live = liveWatch();
    const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, BOUNDS, context);
    controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    const error = await failure(pending);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe("The watch reached its deadline of 60,000 ms. (The operation timed out.)");
  });

  test("a watch the caller already stopped opens no stream", async () => {
    const { context, controller, timers } = harness();
    controller.abort();
    const fake = createFakeEtcdClient({ watch: liveWatch().watch });
    const error = await failure(runBoundedWatch(fake, REQUEST, BOUNDS, context));
    expect(error).toBeInstanceOf(QueryCancelledError);
    expect(fake.calls).toEqual([]);
    expect(timers).toEqual([]);
  });
});

describe("the loop releases what it set on every end (spec 5.3)", () => {
  const ends: ReadonlyArray<readonly [string, (live: ReturnType<typeof liveWatch>, timers: Timer[]) => void]> = [
    ["the window", (_live, timers) => timers[0].fn()],
    ["the row limit", (live) => live.push(batch(put("/a/1", "v"), put("/a/2", "v"), put("/a/3", "v")))],
    ["an in-band cancellation", (live) => live.end({ reason: "compacted", compactRevision: "5" })],
    ["a failed stream", (live) => live.fail(new EtcdError("unavailable", "Connection dropped", 14))],
  ];
  for (const [name, finish] of ends) {
    test(`after ${name}, the window's timer is cancelled and the caller's signal no longer reaches the loop`, async () => {
      const { context, timers } = harness();
      const removed = spyOn(context.signal, "removeEventListener");
      const live = liveWatch();
      const pending = runBoundedWatch(createFakeEtcdClient({ watch: live.watch }), REQUEST, BOUNDS, context);
      finish(live, timers);
      await pending.catch(() => undefined);
      expect(timers[0].cancelled).toBe(true);
      expect(removed).toHaveBeenCalledTimes(1);
      expect(removed.mock.calls[0][0]).toBe("abort");
    });
  }
});
