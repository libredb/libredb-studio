/**
 * The shutdown handler (src/lib/shutdown-handler.ts): one SIGTERM and one SIGINT listener per process, installed by
 * `register()` at boot, which runs the shutdown hooks and, where Studio owns the exit, closes every provider cache and
 * exits with 0 or with 128 plus the signal's number (docs/DISTRIBUTION.md#stopping-the-server).
 *
 * Every case installs the handler on a stand-in process (tests/helpers/shutdown-stand-in.ts), whose exit records the
 * code and resolves a promise the case awaits; no real signal is ever sent and the real `process.exit` is never bound.
 * Deadlines run on fake timers, and a case waits on the stand-in's exit, never on a timer-settled promise assertion.
 * The provider in the cache is a real SQLite database in memory, so what a hook sees shows what ran before it.
 */
import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { clearProviderCache, getOrCreateProvider, getProviderCacheStats } from "@/lib/db/factory";
import type { DatabaseConnection } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { QUERY_EVENT_SINK_KEY } from "@/lib/query-events/queued";
import * as shutdownRegistry from "@/lib/shutdown";
import {
  onProviderCacheClose,
  onShutdown,
  PROVIDER_CACHE_CLOSE_DEADLINE_MS,
  resetShutdownHooks,
  SHUTDOWN_HOOKS_DEADLINE_MS,
} from "@/lib/shutdown";
import {
  exitOwnerAtBoot,
  installShutdownHandler,
  MANUAL_SIGNAL_HANDLING_VARIABLE,
  resetShutdownHandler,
} from "@/lib/shutdown-handler";
import { installUncaughtExceptionExit, resetUncaughtExceptionExit } from "@/lib/uncaught-exception";
import { shutdownStandIn } from "../../helpers/shutdown-stand-in";
import { standInProcess } from "../../helpers/uncaught-exception-stand-in";

const MEMORY_DATABASE = {
  id: "shutdown-handler",
  name: "Shutdown handler",
  type: "sqlite",
  database: ":memory:",
  createdAt: new Date(),
} as DatabaseConnection;

let spies: ReturnType<typeof spyOn>[] = [];
let unregister: Array<() => void> = [];

/** Lets every pending promise settle, over a few turns: bun's fake timers leave setImmediate real. */
function settle(turns = 3): Promise<void> {
  return new Promise((resolve) => setImmediate(() => (turns > 1 ? settle(turns - 1).then(resolve) : resolve())));
}

/** Registers a provider cache close for this case only. */
function registerClose(close: () => Promise<void>): void {
  unregister.push(onProviderCacheClose(close));
}

/**
 * Leaves `count` query events in this process's sink queue, where `queuedQueryEventCount()` reads them, as events the
 * sink never sent do.
 */
function leaveQueryEvents(count: number): void {
  (globalThis as { [QUERY_EVENT_SINK_KEY]?: { queue: unknown[] } })[QUERY_EVENT_SINK_KEY] = {
    queue: Array.from({ length: count }, () => ({})),
  };
}

/** Every line the logger was asked for at `level`, as message and context. */
function lines(level: "info" | "warn"): unknown[][] {
  return (logger[level] as unknown as { mock: { calls: unknown[][] } }).mock.calls;
}

beforeEach(() => {
  resetShutdownHooks();
  resetShutdownHandler();
  spies = (["error", "warn", "info"] as const).map((level) => spyOn(logger, level).mockImplementation(() => {}));
});

afterEach(async () => {
  jest.useRealTimers();
  for (const remove of unregister) remove();
  unregister = [];
  resetShutdownHooks();
  resetShutdownHandler();
  delete (globalThis as { [QUERY_EVENT_SINK_KEY]?: unknown })[QUERY_EVENT_SINK_KEY];
  await clearProviderCache();
  for (const spy of spies) spy.mockRestore();
});

describe("installShutdownHandler", () => {
  test("registers one SIGTERM and one SIGINT listener, and a second install attaches nothing", () => {
    const proc = shutdownStandIn();
    const other = shutdownStandIn();

    installShutdownHandler(proc, "studio");
    installShutdownHandler(proc, "studio");
    installShutdownHandler(other, "nextjs");

    expect(proc.registrations.map((each) => each.event)).toEqual(["SIGTERM", "SIGINT"]);
    expect(other.registrations).toEqual([]);
  });

  test("on SIGTERM it runs the hooks, then closes every provider cache, then exits with 0 once all of it settled", async () => {
    const order: string[] = [];
    onShutdown("hook", async () => {
      order.push("hook");
    });
    registerClose(async () => {
      order.push("close");
    });
    const proc = shutdownStandIn();
    installShutdownHandler(proc, "studio");

    proc.signal("SIGTERM");

    expect(await proc.exited).toBe(0);
    expect(order).toEqual(["hook", "close"]);
    expect(proc.exits).toEqual([0]);
    expect(lines("info")).toEqual([
      [
        "Received SIGTERM: running the shutdown hooks, then closing the providers, then exiting",
        { route: "shutdown", owner: "studio" },
      ],
      ["Shutdown complete, exiting with 0", { route: "shutdown", signal: "SIGTERM" }],
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("the caches are closed only after the hooks: a hook sees every provider still open", async () => {
    await getOrCreateProvider(MEMORY_DATABASE, {}, { allowExternalFileAccess: true });
    const seen: number[] = [];
    onShutdown("observer", async () => {
      seen.push(getProviderCacheStats().size);
    });
    const proc = shutdownStandIn();
    installShutdownHandler(proc, "studio");

    proc.signal("SIGTERM");

    expect(await proc.exited).toBe(0);
    expect(seen).toEqual([1]);
    expect(getProviderCacheStats().size).toBe(0);
  });

  test("a hook that never settles is cut after 5 s, the caches are closed after it, and the exit code is 143", async () => {
    await getOrCreateProvider(MEMORY_DATABASE, {}, { allowExternalFileAccess: true });
    onShutdown("stuck", () => new Promise<void>(() => {}));
    const proc = shutdownStandIn();
    installShutdownHandler(proc, "studio");
    jest.useFakeTimers();

    proc.signal("SIGTERM");
    await settle();
    jest.advanceTimersByTime(SHUTDOWN_HOOKS_DEADLINE_MS - 1);
    await settle();
    expect(proc.exits).toEqual([]);
    expect(getProviderCacheStats().size).toBe(1);

    jest.advanceTimersByTime(1);
    expect(await proc.exited).toBe(143);
    expect(getProviderCacheStats().size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith("Shutdown incomplete, exiting with 143", {
      route: "shutdown",
      signal: "SIGTERM",
      hooksCut: ["stuck"],
      hooksFailed: undefined,
      cacheClosesCut: undefined,
      cacheClosesFailed: undefined,
      stepsFailed: undefined,
      queryEventsLost: undefined,
    });
  });

  test("a hook that fails makes the exit code 143 and the end line names it", async () => {
    onShutdown("fails", async () => {
      throw new Error("close failed");
    });
    const proc = shutdownStandIn();
    installShutdownHandler(proc, "studio");

    proc.signal("SIGTERM");

    expect(await proc.exited).toBe(143);
    expect(logger.warn).toHaveBeenCalledWith("Shutdown incomplete, exiting with 143", {
      route: "shutdown",
      signal: "SIGTERM",
      hooksCut: undefined,
      hooksFailed: ["fails"],
      cacheClosesCut: undefined,
      cacheClosesFailed: undefined,
      stepsFailed: undefined,
      queryEventsLost: undefined,
    });
  });

  test("a cache close that never settles is cut after 15 s and the exit code is 143", async () => {
    registerClose(() => new Promise<void>(() => {}));
    const proc = shutdownStandIn();
    installShutdownHandler(proc, "studio");
    jest.useFakeTimers();

    proc.signal("SIGTERM");
    await settle();
    jest.advanceTimersByTime(PROVIDER_CACHE_CLOSE_DEADLINE_MS - 1);
    await settle();
    expect(proc.exits).toEqual([]);

    jest.advanceTimersByTime(1);
    expect(await proc.exited).toBe(143);
    expect(logger.warn).toHaveBeenCalledWith("Shutdown incomplete, exiting with 143", {
      route: "shutdown",
      signal: "SIGTERM",
      hooksCut: undefined,
      hooksFailed: undefined,
      cacheClosesCut: 1,
      cacheClosesFailed: undefined,
      stepsFailed: undefined,
      queryEventsLost: undefined,
    });
  });

  test("a cache close that rejects or throws is logged, the other closes still run, and the exit code is 143", async () => {
    let otherRan = false;
    registerClose(() => Promise.reject(new Error("disconnect failed")));
    registerClose(() => {
      throw new Error("not a promise");
    });
    registerClose(async () => {
      otherRan = true;
    });
    const proc = shutdownStandIn();
    installShutdownHandler(proc, "studio");

    proc.signal("SIGTERM");

    expect(await proc.exited).toBe(143);
    expect(otherRan).toBe(true);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith("Shutdown incomplete, exiting with 143", {
      route: "shutdown",
      signal: "SIGTERM",
      hooksCut: undefined,
      hooksFailed: undefined,
      cacheClosesCut: undefined,
      cacheClosesFailed: 2,
      stepsFailed: undefined,
      queryEventsLost: undefined,
    });
  });

  test("a query event recorded after the hooks flushed the queue makes the exit code 143 and the end line counts it", async () => {
    // A request still running records its event once the flush has closed the sink, which then never sends it.
    registerClose(async () => {
      leaveQueryEvents(2);
    });
    const proc = shutdownStandIn();
    installShutdownHandler(proc, "studio");

    proc.signal("SIGTERM");

    expect(await proc.exited).toBe(143);
    expect(logger.warn).toHaveBeenCalledWith("Shutdown incomplete, exiting with 143", {
      route: "shutdown",
      signal: "SIGTERM",
      hooksCut: undefined,
      hooksFailed: undefined,
      cacheClosesCut: undefined,
      cacheClosesFailed: undefined,
      stepsFailed: undefined,
      queryEventsLost: 2,
    });
  });

  test("a cached provider whose disconnect rejects makes the exit code 143, through the factory's own close", async () => {
    const provider = await getOrCreateProvider(MEMORY_DATABASE, {}, { allowExternalFileAccess: true });
    const failure = new Error("disconnect failed");
    provider.disconnect = () => Promise.reject(failure);
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const proc = shutdownStandIn();
      installShutdownHandler(proc, "studio");

      proc.signal("SIGTERM");

      expect(await proc.exited).toBe(143);
      expect(consoleError).toHaveBeenCalledWith("[DB] Error disconnecting provider", "shutdown-handler", failure);
      expect(logger.error).toHaveBeenCalledWith(
        "Provider cache close failed",
        expect.objectContaining({ message: "Providers not closed: shutdown-handler" }),
        { route: "shutdown" },
      );
      expect(logger.warn).toHaveBeenCalledWith(
        "Shutdown incomplete, exiting with 143",
        expect.objectContaining({ cacheClosesFailed: 1 }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test("SIGINT exits with 0 when the shutdown completed and with 130 when it did not", async () => {
    const complete = shutdownStandIn();
    installShutdownHandler(complete, "studio");
    complete.signal("SIGINT");
    expect(await complete.exited).toBe(0);

    resetShutdownHooks();
    resetShutdownHandler();
    onShutdown("fails", async () => {
      throw new Error("close failed");
    });
    const incomplete = shutdownStandIn();
    installShutdownHandler(incomplete, "studio");
    incomplete.signal("SIGINT");
    expect(await incomplete.exited).toBe(130);
  });

  test("a second signal during the shutdown starts nothing and keeps the first signal's exit code", async () => {
    let hookRuns = 0;
    let release: () => void = () => {};
    onShutdown("slow", () => {
      hookRuns += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    onShutdown("fails", async () => {
      throw new Error("close failed");
    });
    const proc = shutdownStandIn();
    installShutdownHandler(proc, "studio");

    proc.signal("SIGTERM");
    await settle();
    proc.signal("SIGINT");
    proc.signal("SIGTERM");
    await settle();
    expect(proc.exits).toEqual([]);
    release();

    expect(await proc.exited).toBe(143);
    await settle();
    expect(proc.exits).toEqual([143]);
    expect(hookRuns).toBe(1);
    const repeats = lines("info").filter(([message]) => String(message).includes("already under way"));
    expect(repeats).toEqual([
      ["Received SIGINT during the shutdown already under way; it goes on", { route: "shutdown" }],
    ]);
  });

  test("where Next.js owns the exit it runs the hooks, closes no provider cache and never exits", async () => {
    await getOrCreateProvider(MEMORY_DATABASE, {}, { allowExternalFileAccess: true });
    let hookRan = false;
    let closed = false;
    onShutdown("hook", async () => {
      hookRan = true;
    });
    registerClose(async () => {
      closed = true;
    });
    const proc = shutdownStandIn();
    installShutdownHandler(proc, "nextjs");

    proc.signal("SIGTERM");
    await settle();

    expect(hookRan).toBe(true);
    expect(closed).toBe(false);
    expect(getProviderCacheStats().size).toBe(1);
    expect(proc.exits).toEqual([]);
    expect(lines("info")).toEqual([
      [
        "Received SIGTERM: running the shutdown hooks; Next.js's handler ends the process",
        { route: "shutdown", owner: "nextjs" },
      ],
    ]);
  });

  test("where Next.js owns the exit, its exit is logged once, with nothing lost when the hooks ended and nothing was left queued", async () => {
    onShutdown("hook", async () => {});
    const proc = shutdownStandIn();
    installShutdownHandler(proc, "nextjs");

    proc.signal("SIGTERM");
    await settle();
    // Next.js's handler ends the process, which runs the exit listeners.
    proc.exit(143);

    expect(lines("info").at(-1)).toEqual(["Exiting with 143 after SIGTERM", { route: "shutdown", signal: "SIGTERM" }]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("where Next.js owns the exit, its exit is logged with the query events left unsent and the hooks still running", async () => {
    onShutdown("slow", () => new Promise<void>(() => {}));
    const proc = shutdownStandIn();
    installShutdownHandler(proc, "nextjs");
    // The hook never settles, so the hooks' deadline is armed: on fake timers, so it does not fire in a later case.
    jest.useFakeTimers();

    proc.signal("SIGINT");
    await settle();
    leaveQueryEvents(3);
    proc.exit(130);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("Exiting with 130 after SIGINT", {
      route: "shutdown",
      signal: "SIGINT",
      queryEventsLost: 3,
      hooksRunning: ["slow"],
    });
  });

  test("a hooks run or a cache close run that rejects is logged, counts as incomplete, and the exit still runs", async () => {
    const hooksFailure = new Error("hooks run failed");
    const closesFailure = new Error("closes run failed");
    const hooks = spyOn(shutdownRegistry, "runShutdownHooks").mockImplementation(() => Promise.reject(hooksFailure));
    const closes = spyOn(shutdownRegistry, "closeProviderCaches").mockImplementation(() =>
      Promise.reject(closesFailure),
    );
    try {
      const proc = shutdownStandIn();
      installShutdownHandler(proc, "studio");

      proc.signal("SIGTERM");

      expect(await proc.exited).toBe(143);
      expect(logger.error).toHaveBeenCalledWith("Shutdown step failed", hooksFailure, {
        route: "shutdown",
        step: "hooks",
      });
      expect(logger.error).toHaveBeenCalledWith("Shutdown step failed", closesFailure, {
        route: "shutdown",
        step: "provider cache closes",
      });
      expect(logger.warn).toHaveBeenCalledWith("Shutdown incomplete, exiting with 143", {
        route: "shutdown",
        signal: "SIGTERM",
        hooksCut: undefined,
        hooksFailed: undefined,
        cacheClosesCut: undefined,
        cacheClosesFailed: undefined,
        stepsFailed: ["hooks", "provider cache closes"],
        queryEventsLost: undefined,
      });
    } finally {
      hooks.mockRestore();
      closes.mockRestore();
    }
  });
});

describe("exitOwnerAtBoot", () => {
  /** Runs exitOwnerAtBoot with the variable set to `value`, or unset for `undefined`, recording exits and banners. */
  function ownerWith(value: string | undefined): { owner: unknown; exits: Array<number | undefined>; banner: string } {
    const saved = process.env[MANUAL_SIGNAL_HANDLING_VARIABLE];
    if (value === undefined) delete process.env[MANUAL_SIGNAL_HANDLING_VARIABLE];
    else process.env[MANUAL_SIGNAL_HANDLING_VARIABLE] = value;
    const originalExit = process.exit;
    const exits: Array<number | undefined> = [];
    process.exit = ((code?: number) => {
      exits.push(code);
    }) as unknown as typeof process.exit;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const owner = exitOwnerAtBoot();
      return { owner, exits, banner: errorSpy.mock.calls.flat().join("\n") };
    } finally {
      process.exit = originalExit;
      errorSpy.mockRestore();
      if (saved === undefined) delete process.env[MANUAL_SIGNAL_HANDLING_VARIABLE];
      else process.env[MANUAL_SIGNAL_HANDLING_VARIABLE] = saved;
    }
  }

  test("NEXT_MANUAL_SIG_HANDLE true gives Studio the exit, unset or empty leaves it to Next.js, and any other value refuses the boot naming the variable", () => {
    expect(MANUAL_SIGNAL_HANDLING_VARIABLE).toBe("NEXT_MANUAL_SIG_HANDLE");
    expect(ownerWith("true")).toEqual({ owner: "studio", exits: [], banner: "" });
    expect(ownerWith(undefined)).toEqual({ owner: "nextjs", exits: [], banner: "" });
    expect(ownerWith("")).toEqual({ owner: "nextjs", exits: [], banner: "" });
    for (const value of ["1", "false", "TRUE"]) {
      const refused = ownerWith(value);
      expect(refused.owner).toBeUndefined();
      expect(refused.exits).toEqual([1]);
      expect(refused.banner).toContain(`NEXT_MANUAL_SIG_HANDLE is set to "${value}"`);
      expect(refused.banner).toContain("docs/DISTRIBUTION.md#stopping-the-server");
    }
  });
});

describe("with the uncaught-exception exit", () => {
  test("it adds no uncaughtException listener, and the uncaught exit adds no signal listener", () => {
    const signals = shutdownStandIn();
    const uncaught = standInProcess();
    resetUncaughtExceptionExit();
    try {
      installShutdownHandler(signals, "studio");
      installUncaughtExceptionExit(uncaught);
    } finally {
      resetUncaughtExceptionExit();
    }

    expect(signals.registrations.map((each) => each.event)).toEqual(["SIGTERM", "SIGINT"]);
    expect(uncaught.registrations.map((each) => each.event)).toEqual(["uncaughtException"]);
  });
});
