/**
 * A cached expiring value: served until its early-refresh point, one shared refresh on its own deadline, a caller's
 * own abort that fails only that caller, nothing cached from a failure, and close(), over neutral fakes.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { authLaneOptions } from "@/lib/db/auth/lanes";
import {
  createRefreshingValue,
  type Expiring,
  type RefreshingValueOptions,
  type RefreshRun,
} from "@/lib/db/auth/refresh";
import type { HttpOrigin } from "@/lib/db/http/endpoint";
import { TransportError } from "@/lib/db/http/node-transport";
import { FIXED_NOW, fakeClock, fakeTransports, held, jsonAnswer } from "../../../helpers/auth-fakes";

const SAMPLE: HttpOrigin = { scheme: "https", host: "sample.test", port: 443 };
const CLOSED = "The sample source is closed";
const EARLY_MS = 60_000;
const signal = new AbortController().signal;

/** A refreshing value over a fake clock, whose refresh is `refresh` and whose every run is recorded. */
function valueOf<T>(refresh: (run: RefreshRun, count: number) => Promise<Expiring<T>>) {
  const clock = fakeClock();
  const runs: RefreshRun[] = [];
  const options: RefreshingValueOptions<T> = {
    refresh: (run) => {
      runs.push(run);
      return refresh(run, runs.length);
    },
    earlyMs: EARLY_MS,
    now: () => clock.now(),
    timeoutSignal: (ms) => clock.timeoutSignal(ms),
    sentences: { closed: CLOSED },
  };
  return { clock, runs, value: createRefreshingValue(options) };
}

/** A value that expires one hour after FIXED_NOW. */
function hourly(value: string): Expiring<string> {
  return { value, expiresAt: FIXED_NOW + 3_600_000 };
}

/** Lets queued microtasks run, so a refresh reaches the step it awaits. */
async function settle(): Promise<void> {
  // oxlint-disable-next-line no-await-in-loop -- each turn must drain before the next is queued.
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe("refreshing value cache", () => {
  test("a value is served until exactly expiresAt - earlyMs, and refreshed from that instant", async () => {
    const { clock, runs, value } = valueOf(async (_run, count) => hourly(`v${count}`));
    expect(await value.get(signal)).toBe("v1");
    clock.setClock(FIXED_NOW + 3_600_000 - EARLY_MS - 1);
    expect(await value.get(signal)).toBe("v1");
    clock.setClock(FIXED_NOW + 3_600_000 - EARLY_MS);
    expect(await value.get(signal)).toBe("v2");
    expect(runs).toHaveLength(2);
  });

  test("the early margin is the one given", async () => {
    const clock = fakeClock();
    let count = 0;
    const value = createRefreshingValue({
      refresh: async () => ({ value: ++count, expiresAt: FIXED_NOW + 1000 }),
      earlyMs: 10,
      now: () => clock.now(),
      timeoutSignal: (ms) => clock.timeoutSignal(ms),
      sentences: { closed: CLOSED },
    });
    expect(await value.get(signal)).toBe(1);
    clock.setClock(FIXED_NOW + 989);
    expect(await value.get(signal)).toBe(1);
    clock.setClock(FIXED_NOW + 990);
    expect(await value.get(signal)).toBe(2);
  });

  test("concurrent callers share one refresh and one deadline", async () => {
    const answer = held<Expiring<string>>();
    const { clock, runs, value } = valueOf(() => answer.promise);
    const calls = Promise.all([value.get(signal), value.get(signal), value.get(signal)]);
    await settle();
    expect(clock.deadlines).toHaveLength(1);
    answer.resolve(hourly("shared"));
    expect(await calls).toEqual(["shared", "shared", "shared"]);
    expect(runs).toHaveLength(1);
  });

  test("a failed refresh caches nothing, so the next call refreshes again", async () => {
    const { runs, value } = valueOf(async (_run, count) => {
      if (count === 1) throw new Error("refused");
      return hourly("v2");
    });
    await expect(Promise.all([value.get(signal), value.get(signal)])).rejects.toThrow("refused");
    expect(runs).toHaveLength(1);
    expect(await value.get(signal)).toBe("v2");
    expect(runs).toHaveLength(2);
  });

  test("two values never share a cache", async () => {
    const first = valueOf(async () => hourly("first"));
    const second = valueOf(async () => hourly("second"));
    expect(await first.value.get(signal)).toBe("first");
    expect(await second.value.get(signal)).toBe("second");
  });
});

describe("refreshing value deadline", () => {
  test("the shared refresh runs on its own 30-second deadline, not on a caller's signal", async () => {
    const { clock, runs, value } = valueOf<string>(() => new Promise(() => {}));
    const caller = new AbortController();
    const call = value.get(caller.signal).catch((error: unknown) => error);
    await settle();
    expect(clock.deadlines.map((deadline) => deadline.ms)).toEqual([30_000]);
    expect(runs[0].signal).not.toBe(caller.signal);
    expect(runs[0].signal.aborted).toBe(false);
    clock.fireDeadline(0);
    expect(runs[0].signal.aborted).toBe(true);
    caller.abort(new DOMException("late", "TimeoutError"));
    expect(await call).toMatchObject({ kind: "timeout" });
  });

  test("a deadline that fires during a step that takes no signal is reported as the timeout, never as closed", async () => {
    const step = held<void>();
    const transports = fakeTransports<"sample">(() => jsonAnswer({}));
    const transport = transports.createTransport(authLaneOptions({ origin: SAMPLE }), "sample");
    const { clock, value } = valueOf<string>(async (run) => {
      await step.promise;
      run.throwIfClosed();
      await transport.request({
        method: "GET",
        url: "https://sample.test/",
        signal: run.signal,
        maxResponseBytes: 1024,
      });
      return hourly("never");
    });
    const call = value.get(signal).catch((error: unknown) => error);
    await settle();
    clock.fireDeadline(0);
    step.resolve();
    const error = await call;
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ kind: "timeout" });
    expect((error as Error).message).not.toBe(CLOSED);
  });

  test("throwIfClosed does not throw after the deadline alone", async () => {
    const { clock, runs, value } = valueOf<string>(() => new Promise(() => {}));
    void value.get(signal).catch(() => {});
    await settle();
    clock.fireDeadline(0);
    expect(() => runs[0].throwIfClosed()).not.toThrow();
  });
});

describe("refreshing value callers", () => {
  test("a caller that aborts is rejected at once and does not fail a longer caller", async () => {
    const answer = held<Expiring<string>>();
    const { runs, value } = valueOf(() => answer.promise);
    const short = new AbortController();
    const shortCall = value.get(short.signal).catch((error: unknown) => error);
    const longCall = value.get(signal);
    await settle();
    short.abort();
    const error = await shortCall;
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ kind: "aborted", message: "The request was cancelled" });
    expect(runs[0].signal.aborted).toBe(false);
    answer.resolve(hourly("shared"));
    expect(await longCall).toBe("shared");
    expect(runs).toHaveLength(1);
  });

  test("a caller already past its deadline is rejected as a timeout, and the refresh still lands", async () => {
    const answer = held<Expiring<string>>();
    const { runs, value } = valueOf(() => answer.promise);
    const error = await value.get(AbortSignal.abort(new DOMException("late", "TimeoutError"))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ kind: "timeout", message: "The request did not finish within its time limit" });
    answer.resolve(hourly("later"));
    expect(await value.get(signal)).toBe("later");
    expect(runs).toHaveLength(1);
  });

  test("a settled wait removes its abort listener, on success and on failure", async () => {
    const { value } = valueOf(async () => hourly("v"));
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    expect(await value.get(controller.signal)).toBe("v");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));

    const failing = valueOf<string>(async () => {
      throw new Error("refused");
    });
    const other = new AbortController();
    const removeOther = spyOn(other.signal, "removeEventListener");
    await expect(failing.value.get(other.signal)).rejects.toThrow("refused");
    expect(removeOther).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("refreshing value close", () => {
  test("close during a refresh aborts it, and throwIfClosed then throws the closed sentence", async () => {
    const { runs, value } = valueOf<string>(() => new Promise(() => {}));
    void value.get(signal).catch(() => {});
    await settle();
    expect(() => runs[0].throwIfClosed()).not.toThrow();
    value.close();
    expect(runs[0].signal.aborted).toBe(true);
    let thrown: unknown;
    try {
      runs[0].throwIfClosed();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TransportError);
    expect(thrown).toMatchObject({ kind: "aborted", message: CLOSED });
  });

  test("a refresh closed while it signs reports the closed sentence to its caller", async () => {
    const step = held<void>();
    const { value } = valueOf<string>(async (run) => {
      await step.promise;
      run.throwIfClosed();
      return hourly("never");
    });
    const call = value.get(signal).catch((error: unknown) => error);
    await settle();
    value.close();
    step.resolve();
    const error = await call;
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ kind: "aborted", message: CLOSED });
  });

  test("get() after close() rejects with the closed sentence and starts no refresh", async () => {
    const { runs, value } = valueOf(async () => hourly("v"));
    value.close();
    const error = await value.get(signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ kind: "aborted", message: CLOSED });
    expect(runs).toHaveLength(0);
  });

  test("get() after close() rejects even while a value is cached, and starts no refresh", async () => {
    const { runs, value } = valueOf(async () => hourly("cached"));
    expect(await value.get(signal)).toBe("cached");
    value.close();
    await expect(value.get(signal)).rejects.toThrow(CLOSED);
    expect(runs).toHaveLength(1);
  });
});
