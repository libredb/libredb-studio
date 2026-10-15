/**
 * Shutdown hooks (src/lib/shutdown.ts): on SIGTERM or SIGINT the factory's handler runs every hook registered with
 * `onShutdown()` before it closes the cached providers, and waits for them at most 5 s, so a hook that hangs, such as
 * a close on a half-open connection, never holds the exit.
 *
 * The factory registers its signal handlers on import only outside tests, so this file registers them itself and
 * captures them by diffing the process listeners, as tests/isolated/factory.test.ts does. The provider in the cache is
 * a real SQLite database in memory, so the hooks' view of the cache shows what they ran before.
 */
import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import {
  clearProviderCache,
  getOrCreateProvider,
  getProviderCacheStats,
  registerShutdownHandlers,
} from "@/lib/db/factory";
import type { DatabaseConnection } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { onShutdown, resetShutdownHooks, runShutdownHooks } from "@/lib/shutdown";

const sigtermBefore = process.listeners("SIGTERM");
const sigintBefore = process.listeners("SIGINT");
registerShutdownHandlers();
const onSigterm = process.listeners("SIGTERM").find((listener) => !sigtermBefore.includes(listener));
const onSigint = process.listeners("SIGINT").find((listener) => !sigintBefore.includes(listener));
// The tests call the handlers directly; left attached, a real signal to this process would run them.
if (onSigterm) process.removeListener("SIGTERM", onSigterm);
if (onSigint) process.removeListener("SIGINT", onSigint);

const MEMORY_DATABASE = {
  id: "shutdown-hooks",
  name: "Shutdown hooks",
  type: "sqlite",
  database: ":memory:",
  createdAt: new Date(),
} as DatabaseConnection;

let spies: ReturnType<typeof spyOn>[] = [];

/** Replaces process.exit with a recorder whose promise settles on the first call. */
function stubProcessExit(): { exits: Array<number | undefined>; exited: Promise<void>; restore: () => void } {
  const realExit = process.exit;
  const exits: Array<number | undefined> = [];
  let resolveExited: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  process.exit = ((code?: number) => {
    exits.push(code);
    resolveExited();
  }) as typeof process.exit;
  return {
    exits,
    exited,
    restore: () => {
      process.exit = realExit;
    },
  };
}

/** Lets every pending promise settle: bun's fake timers leave setImmediate real. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  resetShutdownHooks();
  spies = (["error", "warn", "info"] as const).map((level) => spyOn(logger, level).mockImplementation(() => {}));
});

afterEach(async () => {
  jest.useRealTimers();
  resetShutdownHooks();
  await clearProviderCache();
  for (const spy of spies) spy.mockRestore();
});

describe("shutdown hooks", () => {
  test("hooks run before providers are cleared and are cut at the 5 s deadline", async () => {
    await getOrCreateProvider(MEMORY_DATABASE, {}, { allowExternalFileAccess: true });
    const seen: string[] = [];
    onShutdown("quick", async () => {
      seen.push(`quick saw ${getProviderCacheStats().size} provider`);
    });
    onShutdown("stuck", () => {
      seen.push(`stuck saw ${getProviderCacheStats().size} provider`);
      return new Promise<void>(() => {});
    });
    const { exits, exited, restore } = stubProcessExit();
    jest.useFakeTimers();

    try {
      expect(onSigterm).toBeDefined();
      onSigterm?.("SIGTERM");
      await settle();
      expect(seen).toEqual(["quick saw 1 provider", "stuck saw 1 provider"]);

      jest.advanceTimersByTime(4999);
      await settle();
      expect(exits).toEqual([]);
      expect(getProviderCacheStats().size).toBe(1);

      jest.advanceTimersByTime(1);
      await exited;
      expect(exits).toEqual([0]);
      expect(getProviderCacheStats().size).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith("Shutdown hooks cut at the deadline", {
        route: "shutdown",
        pending: ["stuck"],
      });
    } finally {
      restore();
    }
  });

  test("SIGINT runs the hooks too, and with every hook done the shutdown goes on at once", async () => {
    let closed = false;
    onShutdown("listener", async () => {
      closed = true;
    });
    const { exits, exited, restore } = stubProcessExit();

    try {
      expect(onSigint).toBeDefined();
      onSigint?.("SIGINT");
      await exited;
      expect(closed).toBe(true);
      expect(exits).toEqual([0]);
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

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
});
