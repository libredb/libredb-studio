/**
 * One deadline and a signal that aborts at it, no call started after either ended, and the host's wait that ends at
 * the signal while the abandoned answer keeps its handler (docs/providers/CONTRACT.md, clauses C-26 to C-28).
 *
 * The only timers are the deadline signals of the first title, waited on through their abort event. Every other case
 * uses a deadline already past or one an hour ahead, and every answer is a promise the test settles itself, so no
 * assertion follows a timer. A late handler resolves a promise the test awaits, so an abandoned rejection with no
 * handler fires while the test runs and fails it.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import {
  awaitWithin,
  CallRefusalError,
  callRefusalSentence,
  checkCallStart,
  deadlineSignal,
  type LateOutcome,
} from "@libredb/provider-sdk/calls";

const HOUR = 3_600_000;

/** What `run` threw, or `undefined`; settled with a plain await, never after a timer. */
async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** What `run` threw synchronously, or `undefined`. */
function thrownNow(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** A promise that resolves when `signal` aborts. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/** A late handler that records each outcome and resolves `first` with the first one. */
function lateHandler<T>(): {
  readonly late: (outcome: LateOutcome<T>) => void;
  readonly calls: LateOutcome<T>[];
  readonly first: Promise<LateOutcome<T>>;
} {
  const calls: LateOutcome<T>[] = [];
  const { promise, resolve } = Promise.withResolvers<LateOutcome<T>>();
  return {
    late: (outcome) => {
      calls.push(outcome);
      resolve(outcome);
    },
    calls,
    first: promise,
  };
}

function isTimeout(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "TimeoutError";
}

describe("deadlineSignal", () => {
  test("a call signal aborts at its deadline with a TimeoutError", async () => {
    const alone = deadlineSignal(Date.now() + 20);
    const withCaller = deadlineSignal(Date.now() + 20, new AbortController().signal);

    expect(alone.aborted).toBe(false);
    expect(withCaller.aborted).toBe(false);
    await Promise.all([aborted(alone), aborted(withCaller)]);
    expect(isTimeout(alone.reason)).toBe(true);
    expect(isTimeout(withCaller.reason)).toBe(true);
  });

  test("a call signal aborts with the caller's reason when the caller goes first", () => {
    const controller = new AbortController();
    const signal = deadlineSignal(Date.now() + HOUR, controller.signal);
    const reason = new Error(randomUUID());

    expect(signal.aborted).toBe(false);
    controller.abort(reason);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);

    const before = new Error(randomUUID());
    const already = deadlineSignal(Date.now() + HOUR, AbortSignal.abort(before));
    expect(already.aborted).toBe(true);
    expect(already.reason).toBe(before);
  });

  test("a deadline already past answers a signal already aborted", () => {
    const now = Date.now();
    for (const deadline of [now - 1, now - HOUR, 0]) {
      const signal = deadlineSignal(deadline);
      expect(signal.aborted).toBe(true);
      expect(isTimeout(signal.reason)).toBe(true);
      const withCaller = deadlineSignal(deadline, new AbortController().signal);
      expect(withCaller.aborted).toBe(true);
      expect(isTimeout(withCaller.reason)).toBe(true);
    }
  });

  test("a deadline that is not a finite number is a host defect, refused before any signal is built", () => {
    const timeout = spyOn(AbortSignal, "timeout");
    const any = spyOn(AbortSignal, "any");
    try {
      for (const deadline of [
        Number.NaN,
        Infinity,
        -Infinity,
        "soon" as unknown as number,
        undefined as unknown as number,
      ]) {
        const error = thrownNow(() => deadlineSignal(deadline, new AbortController().signal));
        expect(error).toBeInstanceOf(RangeError);
        expect((error as RangeError).message).toBe("The call deadline must be a finite number of epoch milliseconds.");
      }
      expect(timeout).not.toHaveBeenCalled();
      expect(any).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
      any.mockRestore();
    }
  });

  test("a deadline further ahead than a timer can wait is refused before any signal is built", () => {
    const timeout = spyOn(AbortSignal, "timeout");
    try {
      const error = thrownNow(() => deadlineSignal(Date.now() + 2 ** 31 + HOUR));
      expect(error).toBeInstanceOf(RangeError);
      expect((error as RangeError).message).toBe(
        "The call deadline must be at most 2147483647 milliseconds ahead, the longest a timer waits.",
      );
      expect(timeout).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
    expect(deadlineSignal(Date.now() + 2 ** 31 - 1 - HOUR).aborted).toBe(false);
  });
});

describe("checkCallStart", () => {
  test("checkCallStart refuses a call whose deadline passed or whose signal aborted, naming each", () => {
    const live = new AbortController().signal;
    const gone = AbortSignal.abort(new Error(randomUUID()));
    const ahead = Date.now() + HOUR;
    const past = Date.now() - 1;

    expect(checkCallStart({ deadline: ahead, signal: live })).toEqual([]);
    expect(checkCallStart({ deadline: past, signal: live })).toEqual([
      { rule: "call-deadline-passed", pointer: "/deadline" },
    ]);
    expect(checkCallStart({ deadline: ahead, signal: gone })).toEqual([
      { rule: "call-signal-aborted", pointer: "/signal" },
    ]);
    expect(checkCallStart({ deadline: past, signal: gone })).toEqual([
      { rule: "call-deadline-passed", pointer: "/deadline" },
      { rule: "call-signal-aborted", pointer: "/signal" },
    ]);
    for (const deadline of [Number.NaN, Infinity, "soon" as unknown as number]) {
      const error = thrownNow(() => checkCallStart({ deadline, signal: live }));
      expect(error).toBeInstanceOf(RangeError);
      expect((error as RangeError).message).toBe("The call deadline must be a finite number of epoch milliseconds.");
    }
    expect(callRefusalSentence({ rule: "call-deadline-passed", pointer: "/deadline" })).toBe(
      'The call\'s deadline at "/deadline" had passed when the call was to start, so the provider was not called.',
    );
    expect(callRefusalSentence({ rule: "call-signal-aborted", pointer: "/signal" })).toBe(
      'The call\'s signal at "/signal" had aborted when the call was to start, so the provider was not called.',
    );
  });

  test("a CallRefusalError carries the signal's reason as its cause", () => {
    const reason = new Error(randomUUID());
    const refusals = checkCallStart({ deadline: Date.now() + HOUR, signal: AbortSignal.abort(reason) });

    const withCause = new CallRefusalError(refusals, { cause: reason });
    const without = new CallRefusalError(refusals);
    expect(withCause.cause).toBe(reason);
    expect(withCause.message).toBe(without.message);
    expect(withCause.message).not.toContain(reason.message);
    expect(without.cause).toBeUndefined();
    expect(withCause.refusals).toEqual(refusals);
  });
});

describe("awaitWithin", () => {
  test("the host's wait settles as the answer does when the answer comes first, and leaves no listener on the signal", async () => {
    const controller = new AbortController();
    const value = { marker: randomUUID() };
    const failure = new Error(randomUUID());
    const handler = lateHandler<unknown>();

    expect(await awaitWithin(Promise.resolve(value), controller.signal, handler.late)).toBe(value);
    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
    expect(await thrownBy(() => awaitWithin(Promise.reject(failure), controller.signal, handler.late))).toBe(failure);
    expect(getEventListeners(controller.signal, "abort").length).toBe(0);

    const pending = Promise.withResolvers<unknown>();
    const waiting = awaitWithin(pending.promise, controller.signal, handler.late);
    expect(getEventListeners(controller.signal, "abort").length).toBe(1);
    pending.resolve(value);
    expect(await waiting).toBe(value);
    expect(getEventListeners(controller.signal, "abort").length).toBe(0);

    controller.abort(new Error(randomUUID()));
    expect(handler.calls).toEqual([]);
  });

  test("the host's wait ends at the signal, and the abandoned answer's outcome reaches the late handler once", async () => {
    const answered = Promise.withResolvers<{ readonly marker: string }>();
    const answeredController = new AbortController();
    const answeredHandler = lateHandler<{ readonly marker: string }>();
    const answeredWait = awaitWithin(answered.promise, answeredController.signal, answeredHandler.late);
    const answeredReason = new Error(randomUUID());
    answeredController.abort(answeredReason);
    expect(await thrownBy(() => answeredWait)).toBe(answeredReason);
    expect(answeredHandler.calls).toEqual([]);
    const value = { marker: randomUUID() };
    answered.resolve(value);
    const answeredOutcome = await answeredHandler.first;
    expect(answeredOutcome.kind).toBe("answered");
    expect((answeredOutcome as { readonly value: unknown }).value).toBe(value);
    expect(answeredHandler.calls.length).toBe(1);

    const failed = Promise.withResolvers<unknown>();
    const failedController = new AbortController();
    const failedHandler = lateHandler<unknown>();
    const failedWait = awaitWithin(failed.promise, failedController.signal, failedHandler.late);
    const failedReason = new Error(randomUUID());
    failedController.abort(failedReason);
    expect(await thrownBy(() => failedWait)).toBe(failedReason);
    const error = new Error(randomUUID());
    failed.reject(error);
    const failedOutcome = await failedHandler.first;
    expect(failedOutcome.kind).toBe("failed");
    expect((failedOutcome as { readonly error: unknown }).error).toBe(error);
    expect(failedHandler.calls.length).toBe(1);
  });

  test("a signal aborted before the wait ends it at once, and the answer still reaches the late handler", async () => {
    const reason = new Error(randomUUID());
    const signal = AbortSignal.abort(reason);

    const answered = Promise.withResolvers<string>();
    const answeredHandler = lateHandler<string>();
    expect(await thrownBy(() => awaitWithin(answered.promise, signal, answeredHandler.late))).toBe(reason);
    const value = randomUUID();
    answered.resolve(value);
    expect(await answeredHandler.first).toEqual({ kind: "answered", value });

    const failed = Promise.withResolvers<string>();
    const failedHandler = lateHandler<string>();
    expect(await thrownBy(() => awaitWithin(failed.promise, signal, failedHandler.late))).toBe(reason);
    const error = new Error(randomUUID());
    failed.reject(error);
    const outcome = await failedHandler.first;
    expect(outcome.kind).toBe("failed");
    expect((outcome as { readonly error: unknown }).error).toBe(error);
    expect(answeredHandler.calls.length + failedHandler.calls.length).toBe(2);
    expect(getEventListeners(signal, "abort").length).toBe(0);
  });
});
