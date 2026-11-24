/**
 * One open in flight per key (src/lib/provider-host/core/open-once.ts; docs/providers/CONTRACT.md, clause C-44):
 * concurrent callers of one key share one open, a caller's wait ends only by its own signal, an open with no caller
 * left is admitted by its own start, a failure no caller waits for reaches the table's `unclaimed` hook and is never a
 * detached rejection, and a discard aborts the matching flights' signals.
 *
 * Every promise here is settled by the test or by a caller-driven abort, never by a timer, so a hang fails by the
 * file's per-test timeout; `open-once-bounds.test.ts` holds the per-caller wait against an open that never settles in a
 * bounded Node child.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { createOpenFlights, discardFlights, type Flight, openOnce } from "@/lib/provider-host/core/open-once";

/** Lets every pending promise settle. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Meta {
  readonly connectionId: string;
}

/** An open the test settles: its promise, and the resolve and reject that settle it. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** A table whose `unclaimed` hook records what reached it. */
function table() {
  const unclaimed: { error: unknown; flight: Flight<Meta> }[] = [];
  const flights = createOpenFlights<object, Meta>((error, flight) => {
    unclaimed.push({ error, flight });
  });
  return { flights, unclaimed };
}

describe("openOnce", () => {
  test("concurrent callers of one key share one open", async () => {
    const { flights } = table();
    const open = deferred<object>();
    let starts = 0;
    const start = () => {
      starts += 1;
      return open.promise;
    };
    const first = openOnce(flights, "key", { connectionId: "a" }, start);
    const second = openOnce(flights, "key", { connectionId: "a" }, start);
    expect(starts).toBe(1);
    const value = {};
    open.resolve(value);
    const [one, two] = await Promise.all([first, second]);
    expect(one).toBe(value);
    expect(two).toBe(value);
  });

  test("an open per key, run concurrently", async () => {
    const { flights } = table();
    const opens = new Map<string, ReturnType<typeof deferred<object>>>();
    const start = (flight: Flight<Meta>) => {
      const open = deferred<object>();
      opens.set(flight.key, open);
      return open.promise;
    };
    const a = openOnce(flights, "a", { connectionId: "a" }, start);
    const b = openOnce(flights, "b", { connectionId: "b" }, start);
    // Both started before either settled.
    expect([...opens.keys()]).toEqual(["a", "b"]);
    const [valueA, valueB] = [{ key: "a" }, { key: "b" }];
    opens.get("b")?.resolve(valueB);
    opens.get("a")?.resolve(valueA);
    expect(await a).toBe(valueA);
    expect(await b).toBe(valueB);
  });

  test("a failed open reaches every caller and frees its key", async () => {
    const { flights, unclaimed } = table();
    const open = deferred<object>();
    let starts = 0;
    const failing = () => {
      starts += 1;
      return open.promise;
    };
    const failure = new Error("connect failed");
    const first = openOnce(flights, "key", { connectionId: "a" }, failing).catch((error: unknown) => error);
    const second = openOnce(flights, "key", { connectionId: "a" }, failing).catch((error: unknown) => error);
    open.reject(failure);
    expect(await first).toBe(failure);
    expect(await second).toBe(failure);
    expect(unclaimed).toEqual([]);

    // The key is free: the next call starts an open of its own.
    const value = {};
    expect(
      await openOnce(flights, "key", { connectionId: "a" }, async () => {
        starts += 1;
        return value;
      }),
    ).toBe(value);
    expect(starts).toBe(2);
  });

  test("a start that throws before it answers a promise fails its callers and frees its key", async () => {
    const { flights } = table();
    const failure = new Error("refused at once");
    const refused = await openOnce(flights, "key", { connectionId: "a" }, () => {
      throw failure;
    }).catch((error: unknown) => error);
    expect(refused).toBe(failure);
    const value = {};
    expect(await openOnce(flights, "key", { connectionId: "a" }, async () => value)).toBe(value);
  });

  test("a caller whose signal aborts stops waiting, and the others still get the open", async () => {
    const { flights, unclaimed } = table();
    const open = deferred<object>();
    const start = () => open.promise;
    const leaving = new AbortController();
    const reason = new Error("the caller left");
    const left = openOnce(flights, "key", { connectionId: "a" }, start, { signal: leaving.signal }).catch(
      (error: unknown) => error,
    );
    const stays = new AbortController();
    const removed = spyOn(stays.signal, "removeEventListener");
    const staying = openOnce(flights, "key", { connectionId: "a" }, start, { signal: stays.signal });

    leaving.abort(reason);
    expect(await left).toBe(reason);
    const value = {};
    open.resolve(value);
    expect(await staying).toBe(value);
    // The wait that settled first removed its listener from the caller's signal, so a long-lived signal gathers none.
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(unclaimed).toEqual([]);
  });

  test("a caller whose signal already aborted starts nothing and joins nothing", async () => {
    const { flights } = table();
    const reason = new Error("gone before it asked");
    let starts = 0;
    const start = async () => {
      starts += 1;
      return {};
    };
    const refused = await openOnce(flights, "key", { connectionId: "a" }, start, {
      signal: AbortSignal.abort(reason),
    }).catch((error: unknown) => error);
    expect(refused).toBe(reason);
    expect(starts).toBe(0);

    // With an open in flight it joins nothing either: the open's own callers are unaffected.
    const open = deferred<object>();
    const waiting = openOnce(flights, "key", { connectionId: "a" }, () => open.promise);
    const late = await openOnce(flights, "key", { connectionId: "a" }, start, {
      signal: AbortSignal.abort(reason),
    }).catch((error: unknown) => error);
    expect(late).toBe(reason);
    const value = {};
    open.resolve(value);
    expect(await waiting).toBe(value);
    expect(starts).toBe(0);
  });

  test("an open no caller waits for any more is admitted exactly once by its own start", async () => {
    const { flights, unclaimed } = table();
    const cache = new Map<string, object>();
    const open = deferred<object>();
    let admissions = 0;
    const start = async (flight: Flight<Meta>) => {
      const value = await open.promise;
      admissions += 1;
      cache.set(flight.key, value);
      return value;
    };
    const first = new AbortController();
    const second = new AbortController();
    const waits = [
      openOnce(flights, "key", { connectionId: "a" }, start, { signal: first.signal }).catch((error: unknown) => error),
      openOnce(flights, "key", { connectionId: "a" }, start, { signal: second.signal }).catch(
        (error: unknown) => error,
      ),
    ];
    first.abort(new Error("first left"));
    second.abort(new Error("second left"));
    await Promise.all(waits);

    const value = {};
    open.resolve(value);
    await settle();
    expect(admissions).toBe(1);
    expect(cache.get("key")).toBe(value);
    expect(unclaimed).toEqual([]);
  });

  test("an open that fails with no caller left reaches the unclaimed hook once, never as a detached rejection", async () => {
    const open = deferred<object>();
    const failure = new Error("connect failed after every caller left");
    let reached: (entry: { error: unknown; flight: Flight<Meta> }) => void = () => {};
    const hook = new Promise<{ error: unknown; flight: Flight<Meta> }>((resolve) => {
      reached = resolve;
    });
    let calls = 0;
    const flights = createOpenFlights<object, Meta>((error, flight) => {
      calls += 1;
      reached({ error, flight });
    });
    const leaving = new AbortController();
    const left = openOnce(flights, "key", { connectionId: "orders" }, () => open.promise, {
      signal: leaving.signal,
    }).catch((error: unknown) => error);
    leaving.abort(new Error("left"));
    await left;

    open.reject(failure);
    const { error, flight } = await hook;
    expect(error).toBe(failure);
    expect(flight.key).toBe("key");
    expect(flight.meta).toEqual({ connectionId: "orders" });
    await settle();
    expect(calls).toBe(1);
  });

  test("a discard aborts the matching flights' signals and answers them", async () => {
    const { flights } = table();
    const opens = new Map<string, ReturnType<typeof deferred<object>>>();
    const signals = new Map<string, AbortSignal>();
    const start = (flight: Flight<Meta>) => {
      const open = deferred<object>();
      opens.set(flight.key, open);
      signals.set(flight.key, flight.signal);
      return open.promise;
    };
    const orders = openOnce(flights, "orders-1", { connectionId: "orders" }, start);
    const ordersAgain = openOnce(flights, "orders-2", { connectionId: "orders" }, start);
    const users = openOnce(flights, "users-1", { connectionId: "users" }, start);
    const reason = new Error("the connection was removed");

    const discarded = discardFlights(flights, (flight) => flight.meta.connectionId === "orders", reason);

    expect(discarded.map((entry) => entry.flight.key)).toEqual(["orders-1", "orders-2"]);
    expect(signals.get("orders-1")?.aborted).toBe(true);
    expect(signals.get("orders-1")?.reason).toBe(reason);
    expect(signals.get("orders-2")?.reason).toBe(reason);
    expect(signals.get("users-1")?.aborted).toBe(false);

    // A discarded flight stays in the table until it settles: a caller arriving now joins it and gets its answer.
    let joinerStarts = 0;
    const joiner = openOnce(flights, "orders-1", { connectionId: "orders" }, async () => {
      joinerStarts += 1;
      return {};
    });
    expect(joinerStarts).toBe(0);

    let settledFirst = false;
    void discarded[0].settled.then(() => {
      settledFirst = true;
    });
    const refusal = new Error("closed while it was opening");
    opens.get("orders-1")?.reject(refusal);
    expect(await orders.catch((error: unknown) => error)).toBe(refusal);
    expect(await joiner.catch((error: unknown) => error)).toBe(refusal);
    await discarded[0].settled;
    expect(settledFirst).toBe(true);

    const value = {};
    opens.get("orders-2")?.resolve(value);
    await discarded[1].settled;
    expect(await ordersAgain).toBe(value);
    opens.get("users-1")?.resolve(value);
    expect(await users).toBe(value);
    expect(discardFlights(flights, () => true, reason)).toEqual([]);
  });
});

/** An error the owner's `expired` answers for a flight, naming its key. */
class Expired extends Error {
  constructor(readonly flight: Flight<Meta>) {
    super(`the open of ${flight.key} passed its deadline`);
  }
}

/**
 * A table with a deadline the test aborts itself: each flight's deadline signal is a controller of the test's, read
 * through `deadline.signal`, which records the meta it was read with; `expired` answers a new `Expired` each time.
 */
function tableWithDeadline() {
  const unclaimed: { error: unknown; flight: Flight<Meta> }[] = [];
  const deadlines: AbortController[] = [];
  const reads: Meta[] = [];
  const expiredErrors: Expired[] = [];
  let nextDeadline: AbortController | undefined;
  const flights = createOpenFlights<object, Meta>(
    (error, flight) => {
      unclaimed.push({ error, flight });
    },
    {
      signal: (meta) => {
        reads.push(meta);
        const controller = nextDeadline ?? new AbortController();
        nextDeadline = undefined;
        deadlines.push(controller);
        return controller.signal;
      },
      expired: (flight) => {
        const error = new Expired(flight);
        expiredErrors.push(error);
        return error;
      },
    },
  );
  const useDeadline = (controller: AbortController) => {
    nextDeadline = controller;
  };
  return { flights, unclaimed, deadlines, reads, expiredErrors, useDeadline };
}

describe("an open's own deadline", () => {
  test("an open still pending at its deadline fails every waiting caller with the owner's expired error, and leaves the table", async () => {
    const { flights, deadlines, expiredErrors } = tableWithDeadline();
    const open = deferred<object>();
    let flightSignal: AbortSignal | undefined;
    const start = (flight: Flight<Meta>) => {
      flightSignal = flight.signal;
      return open.promise;
    };
    const unbounded = openOnce(flights, "key", { connectionId: "a" }, start).catch((error: unknown) => error);
    const waiting = openOnce(flights, "key", { connectionId: "a" }, start, {
      signal: new AbortController().signal,
    }).catch((error: unknown) => error);
    expect(flights.entries.has("key")).toBe(true);

    deadlines[0].abort(new Error("deadline"));

    const [first, second] = await Promise.all([unbounded, waiting]);
    expect(expiredErrors).toHaveLength(1);
    expect(first).toBe(expiredErrors[0]);
    expect(second).toBe(expiredErrors[0]);
    expect(expiredErrors[0].flight.key).toBe("key");
    expect(flights.entries.has("key")).toBe(false);
    expect(flightSignal?.aborted).toBe(true);
    expect(flightSignal?.reason).toBe(expiredErrors[0]);
    open.resolve({});
  });

  test("the next caller after an open's deadline starts a new open", async () => {
    const { flights, deadlines } = tableWithDeadline();
    const opens: ReturnType<typeof deferred<object>>[] = [];
    const start = () => {
      const open = deferred<object>();
      opens.push(open);
      return open.promise;
    };
    const first = openOnce(flights, "key", { connectionId: "a" }, start).catch((error: unknown) => error);
    deadlines[0].abort(new Error("deadline"));
    await first;

    const second = openOnce(flights, "key", { connectionId: "a" }, start);
    expect(opens).toHaveLength(2);
    const value = {};
    opens[1].resolve(value);
    expect(await second).toBe(value);
    opens[0].resolve({});
  });

  test("a late settle of an expired open leaves the open that replaced it in the table", async () => {
    const { flights, deadlines } = tableWithDeadline();
    const opens: ReturnType<typeof deferred<object>>[] = [];
    const start = () => {
      const open = deferred<object>();
      opens.push(open);
      return open.promise;
    };
    const first = openOnce(flights, "key", { connectionId: "a" }, start).catch((error: unknown) => error);
    deadlines[0].abort(new Error("deadline"));
    await first;
    const second = openOnce(flights, "key", { connectionId: "a" }, start);
    const replacing = flights.entries.get("key");

    opens[0].resolve({});
    await settle();
    expect(flights.entries.get("key")).toBe(replacing);
    let joinerStarts = 0;
    const joiner = openOnce(flights, "key", { connectionId: "a" }, () => {
      joinerStarts += 1;
      return deferred<object>().promise;
    });
    expect(joinerStarts).toBe(0);

    const value = {};
    opens[1].resolve(value);
    expect(await second).toBe(value);
    expect(await joiner).toBe(value);
  });

  test("a late failure of an expired open reaches the unclaimed hook once, never as a detached rejection", async () => {
    const { flights, deadlines, unclaimed, expiredErrors } = tableWithDeadline();
    const open = deferred<object>();
    const first = openOnce(flights, "key", { connectionId: "orders" }, () => open.promise).catch(
      (error: unknown) => error,
    );
    deadlines[0].abort(new Error("deadline"));
    expect(await first).toBe(expiredErrors[0]);

    const failure = new Error("connect failed after its deadline");
    open.reject(failure);
    await settle();
    expect(unclaimed).toHaveLength(1);
    expect(unclaimed[0].error).toBe(failure);
    expect(unclaimed[0].flight.key).toBe("key");
    expect(unclaimed[0].flight.meta).toEqual({ connectionId: "orders" });
  });

  test("an open that settled before its deadline is not expired by it afterwards", async () => {
    const { flights, deadlines, expiredErrors, unclaimed } = tableWithDeadline();
    let flightSignal: AbortSignal | undefined;
    const value = {};
    const answer = await openOnce(flights, "key", { connectionId: "a" }, async (flight) => {
      flightSignal = flight.signal;
      return value;
    });
    expect(answer).toBe(value);
    await settle();

    deadlines[0].abort(new Error("deadline"));
    await settle();
    expect(expiredErrors).toEqual([]);
    expect(unclaimed).toEqual([]);
    expect(flightSignal?.aborted).toBe(false);
    expect(flights.entries.has("key")).toBe(false);
  });

  test("a deadline already passed when the open starts expires it at once", async () => {
    const { flights, expiredErrors, useDeadline } = tableWithDeadline();
    const passed = new AbortController();
    passed.abort(new Error("deadline"));
    useDeadline(passed);
    let starts = 0;
    const caught = await openOnce(flights, "key", { connectionId: "a" }, () => {
      starts += 1;
      return deferred<object>().promise;
    }).catch((error: unknown) => error);

    expect(expiredErrors).toHaveLength(1);
    expect(caught).toBe(expiredErrors[0]);
    expect(expiredErrors[0].flight.signal.aborted).toBe(true);
    expect(expiredErrors[0].flight.signal.reason).toBe(expiredErrors[0]);
    expect(starts).toBe(0);
    expect(flights.entries.has("key")).toBe(false);
  });

  test("a discard still reaches an open its deadline ended while that open is pending, and no longer once it settled", async () => {
    const { flights, deadlines, expiredErrors } = tableWithDeadline();
    const open = deferred<object>();
    let flightSignal: AbortSignal | undefined;
    const first = openOnce(flights, "key", { connectionId: "orders" }, (flight) => {
      flightSignal = flight.signal;
      return open.promise;
    }).catch((error: unknown) => error);
    deadlines[0].abort(new Error("deadline"));
    expect(await first).toBe(expiredErrors[0]);
    expect(flights.entries.has("key")).toBe(false);

    const discarded = discardFlights(flights, () => true, new Error("closed"));
    expect(discarded.map((entry) => entry.flight.key)).toEqual(["key"]);
    expect(discarded[0].flight.meta).toEqual({ connectionId: "orders" });
    // Its signal keeps the expired error it was aborted with first.
    expect(flightSignal?.reason).toBe(expiredErrors[0]);
    let settled = false;
    void discarded[0].settled.then(() => {
      settled = true;
    });
    await settle();
    expect(settled).toBe(false);

    open.resolve({});
    await discarded[0].settled;
    expect(discardFlights(flights, () => true, new Error("closed"))).toEqual([]);
  });

  test("a discard reaches an expired open beside the open that replaced it under its key", async () => {
    const { flights, deadlines, expiredErrors } = tableWithDeadline();
    const opens: ReturnType<typeof deferred<object>>[] = [];
    const signals: AbortSignal[] = [];
    const start = (flight: Flight<Meta>) => {
      const open = deferred<object>();
      opens.push(open);
      signals.push(flight.signal);
      return open.promise;
    };
    const first = openOnce(flights, "key", { connectionId: "a" }, start).catch((error: unknown) => error);
    deadlines[0].abort(new Error("deadline"));
    await first;
    const second = openOnce(flights, "key", { connectionId: "a" }, start).catch((error: unknown) => error);

    const reason = new Error("closed");
    const discarded = discardFlights(flights, () => true, reason);
    expect(discarded).toHaveLength(2);
    expect(signals.every((signal) => discarded.some((entry) => entry.flight.signal === signal))).toBe(true);
    expect(signals[0].reason).toBe(expiredErrors[0]);
    expect(signals[1].reason).toBe(reason);
    opens[0].resolve({});
    opens[1].resolve({});
    await Promise.all(discarded.map((entry) => entry.settled));
    await second;
  });

  test("the deadline signal is read once per open, with its meta", async () => {
    const { flights, reads } = tableWithDeadline();
    const open = deferred<object>();
    const start = () => open.promise;
    const first = openOnce(flights, "key", { connectionId: "a" }, start);
    const joiner = openOnce(flights, "key", { connectionId: "a" }, start);
    const other = openOnce(flights, "other", { connectionId: "b" }, async () => ({}));
    expect(reads).toEqual([{ connectionId: "a" }, { connectionId: "b" }]);
    const value = {};
    open.resolve(value);
    expect(await first).toBe(value);
    expect(await joiner).toBe(value);
    await other;
  });
});
