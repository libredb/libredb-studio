/**
 * The host core's teardown under fixed deadlines (src/lib/provider-host/core/teardown.ts; docs/providers/CONTRACT.md,
 * clause C-45): a rollback waited for at most its deadline, then a close waited for at most its own, an outcome per
 * step, never a rejection and no timer left behind.
 *
 * Every hang is held under bun's fake timers, so a regression fails by the file's per-test timeout within seconds;
 * `teardown-bounds.test.ts` holds the same deadlines with real timers in a bounded Node child. No test awaits a timer
 * and then asserts `.rejects` or `.resolves` on a promise a later timer settles.
 */
import { afterEach, describe, expect, jest, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CLEANUP_DEADLINE_MS } from "@libredb/provider-sdk/calls";
import {
  settleWithin,
  TEARDOWN_CLOSE_MS,
  TEARDOWN_ROLLBACK_MS,
  teardownWithin,
} from "@/lib/provider-host/core/teardown";

/** Lets every pending promise settle: bun's fake timers leave setImmediate real. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const hangs = (): Promise<void> => new Promise<void>(() => {});
const DEADLINES = { rollbackMs: 50, closeMs: 100 } as const;

afterEach(() => {
  jest.useRealTimers();
});

describe("teardownWithin", () => {
  test("the deadlines Studio tears a provider down under are 5 s for the rollback and 10 s for the close", () => {
    expect([TEARDOWN_ROLLBACK_MS, TEARDOWN_CLOSE_MS]).toEqual([5_000, 10_000]);
  });

  test("the close deadline is the SDK's cleanup deadline", () => {
    const source = readFileSync(
      path.join(import.meta.dir, "..", "..", "..", "..", "..", "src", "lib", "provider-host", "core", "teardown.ts"),
      "utf8",
    );
    expect(TEARDOWN_CLOSE_MS).toBe(CLEANUP_DEADLINE_MS);
    expect(source).toContain('import { CLEANUP_DEADLINE_MS } from "@libredb/provider-sdk/calls";');
    expect(source).toContain("export const TEARDOWN_CLOSE_MS = CLEANUP_DEADLINE_MS;");
  });

  test("a teardown without a rollback closes once", async () => {
    let closes = 0;
    const outcome = await teardownWithin(
      {
        close: async () => {
          closes += 1;
        },
      },
      DEADLINES,
    );
    expect(outcome).toEqual({ rollback: "none", close: "done" });
    expect(closes).toBe(1);
  });

  test("a rollback settles before the close starts", async () => {
    const events: string[] = [];
    let finishRollback: () => void = () => {};
    const teardown = teardownWithin(
      {
        rollback: () => {
          events.push("rollback started");
          return new Promise<void>((resolve) => {
            finishRollback = () => {
              events.push("rollback settled");
              resolve();
            };
          });
        },
        close: async () => {
          events.push("close started");
        },
      },
      DEADLINES,
    );
    await settle();
    expect(events).toEqual(["rollback started"]);
    finishRollback();
    expect(await teardown).toEqual({ rollback: "done", close: "done" });
    expect(events).toEqual(["rollback started", "rollback settled", "close started"]);
  });

  test("a rollback that never settles is cut at its deadline and the close still runs", async () => {
    jest.useFakeTimers();
    const events: string[] = [];
    let outcome: unknown;
    const teardown = teardownWithin(
      {
        rollback: hangs,
        close: async () => {
          events.push("close");
        },
      },
      DEADLINES,
    ).then((answer) => {
      outcome = answer;
    });
    await settle();
    jest.advanceTimersByTime(DEADLINES.rollbackMs - 1);
    await settle();
    expect(events).toEqual([]);
    jest.advanceTimersByTime(1);
    await teardown;
    expect(events).toEqual(["close"]);
    expect(outcome).toEqual({ rollback: "timed-out", close: "done" });
  });

  test("a close that never settles is cut at its deadline", async () => {
    jest.useFakeTimers();
    let outcome: unknown;
    const teardown = teardownWithin({ rollback: async () => {}, close: hangs }, DEADLINES).then((answer) => {
      outcome = answer;
    });
    await settle();
    jest.advanceTimersByTime(DEADLINES.closeMs - 1);
    await settle();
    expect(outcome).toBeUndefined();
    jest.advanceTimersByTime(1);
    await teardown;
    expect(outcome).toEqual({ rollback: "done", close: "timed-out" });
  });

  test("a step that fails is reported with its error and the next step still runs", async () => {
    const rollbackFailure = new Error("rollback failed");
    const closeFailure = new Error("close failed");
    let closes = 0;
    const outcome = await teardownWithin(
      {
        rollback: async () => {
          throw rollbackFailure;
        },
        close: async () => {
          closes += 1;
          throw closeFailure;
        },
      },
      DEADLINES,
    );
    expect(outcome).toEqual({
      rollback: "failed",
      rollbackError: rollbackFailure,
      close: "failed",
      closeError: closeFailure,
    });
    expect(outcome.rollbackError).toBe(rollbackFailure);
    expect(outcome.closeError).toBe(closeFailure);
    expect(closes).toBe(1);
  });

  test("a step that throws before it answers a promise is reported as failed", async () => {
    const failure = new Error("transaction state unreadable");
    const outcome = await teardownWithin(
      {
        rollback: () => {
          throw failure;
        },
        close: () => {
          throw failure;
        },
      },
      DEADLINES,
    );
    expect(outcome).toEqual({ rollback: "failed", rollbackError: failure, close: "failed", closeError: failure });
  });

  test("a step that fails after its cut changes nothing and is never a detached rejection", async () => {
    const detached: unknown[] = [];
    const onDetached = (reason: unknown): void => {
      detached.push(reason);
    };
    process.on("unhandledRejection", onDetached);
    try {
      jest.useFakeTimers();
      let failRollback: (error: Error) => void = () => {};
      let failClose: (error: Error) => void = () => {};
      let outcome: unknown;
      const teardown = teardownWithin(
        {
          rollback: () =>
            new Promise<void>((_, reject) => {
              failRollback = reject;
            }),
          close: () =>
            new Promise<void>((_, reject) => {
              failClose = reject;
            }),
        },
        DEADLINES,
      ).then((answer) => {
        outcome = answer;
      });
      await settle();
      jest.advanceTimersByTime(DEADLINES.rollbackMs);
      await settle();
      jest.advanceTimersByTime(DEADLINES.closeMs);
      await teardown;
      expect(outcome).toEqual({ rollback: "timed-out", close: "timed-out" });

      failRollback(new Error("late rollback failure"));
      failClose(new Error("late close failure"));
      await settle();
      await settle();
      expect(detached).toEqual([]);
      expect(outcome).toEqual({ rollback: "timed-out", close: "timed-out" });
    } finally {
      process.off("unhandledRejection", onDetached);
    }
  });

  test("the rollback's end is reported at its own cut, before the close starts", async () => {
    jest.useFakeTimers();
    const events: string[] = [];
    const teardown = teardownWithin(
      {
        rollback: hangs,
        rollbackEnded: (settled) => {
          events.push(`rollback ${settled.state}`);
        },
        close: () => {
          events.push("close started");
          return hangs();
        },
      },
      DEADLINES,
    );
    await settle();
    jest.advanceTimersByTime(DEADLINES.rollbackMs);
    await settle();
    expect(events).toEqual(["rollback timed-out", "close started"]);
    jest.advanceTimersByTime(DEADLINES.closeMs);
    expect(await teardown).toEqual({ rollback: "timed-out", close: "timed-out" });

    // Without a rollback there is nothing to report.
    const reported: unknown[] = [];
    await teardownWithin({ rollbackEnded: (settled) => reported.push(settled), close: async () => {} }, DEADLINES);
    expect(reported).toEqual([]);
  });

  test("a teardown leaves no timer pending once it answers", async () => {
    jest.useFakeTimers();
    const outcome = await teardownWithin({ rollback: async () => {}, close: async () => {} }, DEADLINES);
    expect(outcome).toEqual({ rollback: "done", close: "done" });
    expect(jest.getTimerCount()).toBe(0);

    let cut: unknown;
    const teardown = teardownWithin({ rollback: hangs, close: hangs }, DEADLINES).then((answer) => {
      cut = answer;
    });
    await settle();
    jest.advanceTimersByTime(DEADLINES.rollbackMs);
    await settle();
    jest.advanceTimersByTime(DEADLINES.closeMs);
    await teardown;
    expect(cut).toEqual({ rollback: "timed-out", close: "timed-out" });
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("settleWithin", () => {
  test("answers how a piece of work settled within a wait, its error by identity", async () => {
    const failure = new Error("failed");
    expect(await settleWithin(Promise.resolve("value"), 10)).toEqual({ state: "done" });
    const failed = await settleWithin(Promise.reject(failure), 10);
    expect(failed).toEqual({ state: "failed", error: failure });
    expect(failed.state === "failed" && failed.error).toBe(failure);

    jest.useFakeTimers();
    let answer: unknown;
    const waiting = settleWithin(hangs(), 10).then((settled) => {
      answer = settled;
    });
    await settle();
    jest.advanceTimersByTime(10);
    await waiting;
    expect(answer).toEqual({ state: "timed-out" });
    expect(jest.getTimerCount()).toBe(0);
  });
});
