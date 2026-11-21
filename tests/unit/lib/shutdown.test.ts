/**
 * Shutdown registry (src/lib/shutdown.ts): the hooks registered with `onShutdown()` and the provider cache closes
 * registered with `onProviderCacheClose()`, which the shutdown handler (src/lib/shutdown-handler.ts) runs on SIGTERM
 * or SIGINT, each step bounded by its own deadline. The handler's sequence and exit codes are held by
 * tests/unit/lib/shutdown-handler.test.ts; this file holds the two registries and what their runs answer.
 */
import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { logger } from "@/lib/logger";
import {
  closeProviderCaches,
  onProviderCacheClose,
  onShutdown,
  PROVIDER_CACHE_CLOSE_DEADLINE_MS,
  resetShutdownHooks,
  runShutdownHooks,
  SHUTDOWN_HOOKS_DEADLINE_MS,
  shutdownHooksRunning,
} from "@/lib/shutdown";

let spies: ReturnType<typeof spyOn>[] = [];
let unregister: Array<() => void> = [];

/** Lets every pending promise settle: bun's fake timers leave setImmediate real. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Registers `close` for this test only. */
function registerClose(close: () => Promise<void>): void {
  unregister.push(onProviderCacheClose(close));
}

beforeEach(() => {
  resetShutdownHooks();
  spies = (["error", "warn", "info"] as const).map((level) => spyOn(logger, level).mockImplementation(() => {}));
});

afterEach(() => {
  jest.useRealTimers();
  for (const remove of unregister) remove();
  unregister = [];
  resetShutdownHooks();
  for (const spy of spies) spy.mockRestore();
});

describe("shutdown hooks", () => {
  test("a hook that fails is logged by name, and the hooks beside it still run", async () => {
    const failure = new Error("close failed");
    const ran: string[] = [];
    onShutdown("fails", async () => {
      ran.push("fails");
      throw failure;
    });
    onShutdown("works", async () => {
      ran.push("works");
    });

    await runShutdownHooks();

    expect(ran).toEqual(["fails", "works"]);
    expect(logger.error).toHaveBeenCalledWith("Shutdown hook failed", failure, { route: "shutdown", hook: "fails" });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("the hooks run once per process: a second run joins the first", async () => {
    let runs = 0;
    onShutdown("once", async () => {
      runs += 1;
    });

    const first = runShutdownHooks();
    const second = runShutdownHooks();
    await Promise.all([first, second]);

    expect(second).toBe(first);
    expect(runs).toBe(1);
  });

  test("registering a name again replaces the hook registered under it", async () => {
    const ran: string[] = [];
    onShutdown("governance", async () => {
      ran.push("first");
    });
    onShutdown("governance", async () => {
      ran.push("second");
    });

    await runShutdownHooks();

    expect(ran).toEqual(["second"]);
  });

  test("runShutdownHooks answers the hooks it cut at the deadline and the hooks that failed", async () => {
    onShutdown("quick", async () => {});
    onShutdown("fails", async () => {
      throw new Error("close failed");
    });
    onShutdown("stuck", () => new Promise<void>(() => {}));
    jest.useFakeTimers();

    let outcome: Awaited<ReturnType<typeof runShutdownHooks>> | undefined;
    const run = runShutdownHooks().then((value) => {
      outcome = value;
    });
    await settle();
    jest.advanceTimersByTime(SHUTDOWN_HOOKS_DEADLINE_MS - 1);
    await settle();
    expect(outcome).toBeUndefined();

    jest.advanceTimersByTime(1);
    await run;

    expect(SHUTDOWN_HOOKS_DEADLINE_MS).toBe(5000);
    expect(outcome).toEqual({ cut: ["stuck"], failed: ["fails"] });
    expect(logger.warn).toHaveBeenCalledWith("Shutdown hooks cut at the deadline", {
      route: "shutdown",
      pending: ["stuck"],
    });
  });

  test("shutdownHooksRunning names the hooks of the run that have not ended, and none before a run", async () => {
    let release: () => void = () => {};
    onShutdown("quick", async () => {});
    onShutdown("slow", () => new Promise<void>((resolve) => (release = resolve)));
    expect(shutdownHooksRunning()).toEqual([]);

    const run = runShutdownHooks();
    await settle();
    expect(shutdownHooksRunning()).toEqual(["slow"]);

    release();
    await run;
    expect(shutdownHooksRunning()).toEqual([]);
  });

  test("runShutdownHooks answers nothing cut and nothing failed when every hook settled", async () => {
    onShutdown("quick", async () => {});

    expect(await runShutdownHooks()).toEqual({ cut: [], failed: [] });
  });
});

describe("provider cache closes", () => {
  test("closeProviderCaches runs every registered close at once, once per process, and answers whether one was cut or failed", async () => {
    const started: string[] = [];
    let finishSlow: () => void = () => {};
    registerClose(async () => {
      started.push("quick");
    });
    registerClose(() => {
      started.push("slow");
      return new Promise<void>((resolve) => {
        finishSlow = resolve;
      });
    });

    const first = closeProviderCaches();
    const second = closeProviderCaches();
    await settle();
    // Both started before either ended: they run at once.
    expect(started).toEqual(["quick", "slow"]);
    expect(second).toBe(first);

    finishSlow();
    expect(await first).toEqual({ cut: 0, failed: 0 });
    expect(started).toEqual(["quick", "slow"]);
  });

  test("a close that never settles is cut at the deadline and counted as cut", async () => {
    registerClose(() => new Promise<void>(() => {}));
    registerClose(async () => {});
    jest.useFakeTimers();

    let outcome: Awaited<ReturnType<typeof closeProviderCaches>> | undefined;
    const run = closeProviderCaches().then((value) => {
      outcome = value;
    });
    await settle();
    jest.advanceTimersByTime(PROVIDER_CACHE_CLOSE_DEADLINE_MS - 1);
    await settle();
    expect(outcome).toBeUndefined();

    jest.advanceTimersByTime(1);
    await run;

    expect(PROVIDER_CACHE_CLOSE_DEADLINE_MS).toBe(15_000);
    expect(outcome).toEqual({ cut: 1, failed: 0 });
    expect(logger.warn).toHaveBeenCalledWith("Provider cache closes cut at the deadline", {
      route: "shutdown",
      pending: 1,
    });
  });

  test("a close that rejects or throws is logged and counted as failed, and the others still run", async () => {
    const rejection = new Error("disconnect failed");
    const thrown = new Error("not a promise");
    let ran = false;
    registerClose(() => Promise.reject(rejection));
    registerClose(() => {
      throw thrown;
    });
    registerClose(async () => {
      ran = true;
    });

    expect(await closeProviderCaches()).toEqual({ cut: 0, failed: 2 });
    expect(ran).toBe(true);
    expect(logger.error).toHaveBeenCalledWith("Provider cache close failed", rejection, { route: "shutdown" });
    expect(logger.error).toHaveBeenCalledWith("Provider cache close failed", thrown, { route: "shutdown" });
  });

  test("the function onProviderCacheClose returns removes that close", async () => {
    let ran = false;
    const remove = onProviderCacheClose(async () => {
      ran = true;
    });
    remove();

    await closeProviderCaches();

    expect(ran).toBe(false);
  });

  test("resetShutdownHooks forgets the hooks and both runs but keeps the registered closes", async () => {
    let closes = 0;
    let hooks = 0;
    registerClose(async () => {
      closes += 1;
    });
    onShutdown("hook", async () => {
      hooks += 1;
    });
    await runShutdownHooks();
    await closeProviderCaches();

    resetShutdownHooks();
    await runShutdownHooks();
    await closeProviderCaches();

    expect(hooks).toBe(1);
    expect(closes).toBe(2);
  });
});
