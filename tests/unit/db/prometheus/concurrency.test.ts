/**
 * The per-connection limit on queries in flight (#1085 section 3.6 and #1085 S6)
 *
 * Every query below is a promise the test settles by hand, so each assertion reads the limiter
 * between two known events rather than racing a timer. `drained()` waits one macrotask, by which
 * time every continuation the limiter queued has run. The shipped limit is imported and never
 * repeated: M11 in tests/fixtures/prometheus/README.md decides its value.
 */
import { describe, expect, test } from "bun:test";
import { createQueryLimiter, QUERY_CONCURRENCY_LIMIT } from "@/lib/db/providers/timeseries/prometheus/concurrency";

/** A query that records when it starts, and settles when the test says so. */
function held<T>(name: string, started: string[]) {
  const outcome = Promise.withResolvers<T>();
  return {
    task: (): Promise<T> => {
      started.push(name);
      return outcome.promise;
    },
    finish: (value: T): void => outcome.resolve(value),
    fail: (error: unknown): void => outcome.reject(error),
  };
}

/** One macrotask: every continuation already queued has run by the time it resolves. */
const drained = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * What a promise rejected with (or its value, if it resolved instead), read by a plain await, so a
 * promise that never settles fails at bun's per-test timeout. A limiter holds promises pending by
 * design, which makes a promise that never settles the way a regression here shows. On bun 1.4.2
 * `await expect(promise).rejects` keeps spinning past that timeout until the runner kills the file,
 * which then reports none of its tests.
 */
const rejectionOf = (promise: Promise<unknown>): Promise<unknown> => promise.catch((raised: unknown) => raised);

describe("createQueryLimiter", () => {
  test("the query past the limit waits until one finishes", async () => {
    const limiter = createQueryLimiter(QUERY_CONCURRENCY_LIMIT);
    const started: string[] = [];
    const admitted = Array.from({ length: QUERY_CONCURRENCY_LIMIT }, (_, index) => held<string>(`q${index}`, started));
    const running = admitted.map((query) => limiter.run(query.task));
    const extra = held<string>("extra", started);
    const waiting = limiter.run(extra.task);
    await drained();

    expect(started).toEqual(admitted.map((_, index) => `q${index}`));
    expect(limiter.inFlight).toBe(QUERY_CONCURRENCY_LIMIT);
    expect(limiter.waiting).toBe(1);

    admitted[0].finish("q0 done");
    expect(await running[0]).toBe("q0 done");
    await drained();

    // The control: the query that waited starts as soon as a slot is free, and takes that slot.
    expect(started.at(-1)).toBe("extra");
    expect(limiter.inFlight).toBe(QUERY_CONCURRENCY_LIMIT);
    expect(limiter.waiting).toBe(0);

    for (const query of admitted.slice(1)) query.finish("done");
    extra.finish("extra done");
    expect(await waiting).toBe("extra done");
    await Promise.all(running);
    expect(limiter.inFlight).toBe(0);
  });

  test("waiting queries start first in first out", async () => {
    const limiter = createQueryLimiter(1);
    const started: string[] = [];
    const queries = ["first", "second", "third", "fourth"].map((name) => held<string>(name, started));
    const outcomes = queries.map((query) => limiter.run(query.task));
    await drained();
    expect(started).toEqual(["first"]);

    queries[0].finish("1");
    await drained();
    expect(started).toEqual(["first", "second"]);

    queries[1].finish("2");
    await drained();
    expect(started).toEqual(["first", "second", "third"]);

    queries[2].finish("3");
    await drained();
    expect(started).toEqual(["first", "second", "third", "fourth"]);

    queries[3].finish("4");
    expect(await Promise.all(outcomes)).toEqual(["1", "2", "3", "4"]);
  });

  test("inFlight and waiting count what runs and what waits", async () => {
    const limiter = createQueryLimiter(2);
    const started: string[] = [];
    const [a, b, c] = ["a", "b", "c"].map((name) => held<string>(name, started));
    expect([limiter.inFlight, limiter.waiting]).toEqual([0, 0]);

    const outcomes = [a, b, c].map((query) => limiter.run(query.task));
    await drained();
    expect([limiter.inFlight, limiter.waiting]).toEqual([2, 1]);

    a.finish("a");
    await drained();
    expect([limiter.inFlight, limiter.waiting]).toEqual([2, 0]);

    b.finish("b");
    await drained();
    expect([limiter.inFlight, limiter.waiting]).toEqual([1, 0]);

    c.finish("c");
    await Promise.all(outcomes);
    expect([limiter.inFlight, limiter.waiting]).toEqual([0, 0]);
  });

  test("a query that rejects frees its slot for the next", async () => {
    const limiter = createQueryLimiter(1);
    const started: string[] = [];
    const failing = held<string>("failing", started);
    const next = held<string>("next", started);
    const failed = limiter.run(failing.task);
    const after = limiter.run(next.task);
    await drained();
    expect(started).toEqual(["failing"]);

    const error = new Error("the server refused the query");
    failing.fail(error);
    expect(await rejectionOf(failed)).toBe(error);
    await drained();

    // The control: the slot it held is the one the next query now runs in.
    expect(started).toEqual(["failing", "next"]);
    next.finish("next done");
    expect(await after).toBe("next done");
    expect(limiter.inFlight).toBe(0);
  });

  test("a query that throws before it returns a promise frees its slot too", async () => {
    const limiter = createQueryLimiter(1);
    const error = new Error("thrown before any promise existed");

    expect(
      await rejectionOf(
        limiter.run(() => {
          throw error;
        }),
      ),
    ).toBe(error);

    // The control: the slot is free again, so the next query runs at once.
    expect(limiter.inFlight).toBe(0);
    expect(await limiter.run(async () => "ran")).toBe("ran");
  });

  test("two limiters share nothing, so one connection's queue never holds another's queries", async () => {
    const busy = createQueryLimiter(1);
    const idle = createQueryLimiter(1);
    const started: string[] = [];
    const blocker = held<string>("blocker", started);
    const blocked = busy.run(blocker.task);

    expect(await idle.run(async () => "ran elsewhere")).toBe("ran elsewhere");
    expect([busy.inFlight, idle.inFlight]).toEqual([1, 0]);

    blocker.finish("done");
    expect(await blocked).toBe("done");
  });
});

describe("createQueryLimiter and cancellation", () => {
  test("an abort while waiting rejects with the signal's reason, and the query never runs", async () => {
    const limiter = createQueryLimiter(1);
    const started: string[] = [];
    const holder = held<string>("holder", started);
    const cancelled = held<string>("cancelled", started);
    const behind = held<string>("behind", started);
    const controller = new AbortController();
    const holding = limiter.run(holder.task);
    const waiting = limiter.run(cancelled.task, controller.signal);
    const after = limiter.run(behind.task);
    await drained();
    expect(limiter.waiting).toBe(2);

    const reason = new Error("cancelled by the user");
    controller.abort(reason);

    expect(await rejectionOf(waiting)).toBe(reason);
    // It left the queue and took nothing, so the holder's slot is still the only one in use.
    expect([limiter.inFlight, limiter.waiting]).toEqual([1, 1]);

    holder.finish("held");
    await holding;
    await drained();
    // The control: the query behind it runs, and the cancelled one never did.
    expect(started).toEqual(["holder", "behind"]);
    behind.finish("behind done");
    expect(await after).toBe("behind done");
    expect(limiter.inFlight).toBe(0);
  });

  test("an already-aborted signal rejects at once, even with a slot free", async () => {
    const limiter = createQueryLimiter(1);
    const started: string[] = [];
    const controller = new AbortController();
    const reason = new Error("cancelled before it was sent");
    controller.abort(reason);

    expect(await rejectionOf(limiter.run(held<string>("never", started).task, controller.signal))).toBe(reason);

    expect(started).toEqual([]);
    expect([limiter.inFlight, limiter.waiting]).toEqual([0, 0]);
    // The control: the same limiter runs a query whose signal is live.
    const live = held<string>("live", started);
    const outcome = limiter.run(live.task, new AbortController().signal);
    await drained();
    expect(started).toEqual(["live"]);
    live.finish("ran");
    expect(await outcome).toBe("ran");
  });

  test("an abort after the query started is the query's own business", async () => {
    // The query holds the same signal and stops itself; the limiter's part ended when the slot was taken.
    const limiter = createQueryLimiter(1);
    const started: string[] = [];
    const query = held<string>("query", started);
    const controller = new AbortController();
    const outcome = limiter.run(query.task, controller.signal);
    await drained();

    controller.abort(new Error("too late to leave the queue"));
    query.finish("finished anyway");

    expect(await outcome).toBe("finished anyway");
    expect([limiter.inFlight, limiter.waiting]).toEqual([0, 0]);
  });

  test("a query cancelled in the middle of the queue leaves only its own place", async () => {
    const limiter = createQueryLimiter(1);
    const started: string[] = [];
    const holder = held<string>("holder", started);
    const ahead = held<string>("ahead", started);
    const cancelled = held<string>("cancelled", started);
    const behind = held<string>("behind", started);
    const controller = new AbortController();
    const holding = limiter.run(holder.task);
    const first = limiter.run(ahead.task);
    const waiting = limiter.run(cancelled.task, controller.signal);
    const last = limiter.run(behind.task);
    await drained();
    expect(limiter.waiting).toBe(3);

    const reason = new Error("cancelled by the user");
    controller.abort(reason);
    expect(await rejectionOf(waiting)).toBe(reason);
    expect([limiter.inFlight, limiter.waiting]).toEqual([1, 2]);

    holder.finish("held");
    await holding;
    await drained();
    // The control: the query ahead of the cancelled one keeps its turn, and the one behind it comes next.
    expect(started).toEqual(["holder", "ahead"]);
    ahead.finish("ahead done");
    expect(await first).toBe("ahead done");
    await drained();
    expect(started).toEqual(["holder", "ahead", "behind"]);
    behind.finish("behind done");
    expect(await last).toBe("behind done");
    expect(limiter.inFlight).toBe(0);
  });

  test("an abort after the queue handed a query its slot leaves the queries behind it in place", async () => {
    // Unlike the query two tests up, this one waited first, so the limiter once watched its signal.
    const limiter = createQueryLimiter(1);
    const started: string[] = [];
    const holder = held<string>("holder", started);
    const woken = held<string>("woken", started);
    const behind = held<string>("behind", started);
    const controller = new AbortController();
    const holding = limiter.run(holder.task);
    const running = limiter.run(woken.task, controller.signal);
    const after = limiter.run(behind.task);
    await drained();

    holder.finish("held");
    await holding;
    await drained();
    expect(started).toEqual(["holder", "woken"]);

    controller.abort(new Error("too late to leave the queue"));
    // The woken query holds the one slot, and the query behind it is still waiting for it.
    expect([limiter.inFlight, limiter.waiting]).toEqual([1, 1]);

    woken.finish("finished anyway");
    expect(await running).toBe("finished anyway");
    await drained();
    // The control: the query behind it takes the slot the woken one gave back.
    expect(started).toEqual(["holder", "woken", "behind"]);
    behind.finish("behind done");
    expect(await after).toBe("behind done");
    expect(limiter.inFlight).toBe(0);
  });
});

describe("createQueryLimiter's limit", () => {
  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("%p is refused", (limit) => {
    expect(() => createQueryLimiter(limit)).toThrow(RangeError);
  });

  test("the refusal says what a limit must be", () => {
    expect(() => createQueryLimiter(0)).toThrow("A query limit is a whole number of at least 1, not 0");
  });

  test("1 is accepted, and admits exactly one query", async () => {
    // The control for the refusals above: the smallest limit that still makes progress.
    const limiter = createQueryLimiter(1);
    const started: string[] = [];
    const first = held<string>("first", started);
    const second = held<string>("second", started);
    const outcomes = [limiter.run(first.task), limiter.run(second.task)];
    await drained();
    expect(started).toEqual(["first"]);

    first.finish("1");
    second.finish("2");
    expect(await Promise.all(outcomes)).toEqual(["1", "2"]);
  });
});
