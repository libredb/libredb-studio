/**
 * The shutdown handler (src/lib/shutdown-handler.ts): one SIGTERM and one SIGINT listener per process, installed by
 * `register()` at boot, which runs the shutdown hooks and, where Studio owns the exit, closes every provider cache and
 * exits with 0 or with 128 plus the signal's number (docs/DISTRIBUTION.md#stopping-the-server).
 *
 * Every case installs the handler on a stand-in process (tests/helpers/shutdown-stand-in.ts), whose exit records the
 * code and resolves a promise the case awaits; no real signal is ever sent and the real `process.exit` is never bound.
 * Where Studio owns the exit the handler drains the requests in flight first: a case that needs a request in flight
 * hands it a stand-in source of request starts (tests/helpers/request-starts-stand-in.ts), and the others use
 * node:diagnostics_channel itself, on which Bun publishes nothing, so their drain sees no server and ends at once.
 * Deadlines run on fake timers, and a case waits on the stand-in's exit, never on a timer-settled promise assertion.
 * The provider in the cache is a real SQLite database in memory, so what a hook sees shows what ran before it.
 */
import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import diagnostics_channel from "node:diagnostics_channel";
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
import * as drainModule from "@/lib/shutdown-drain";
import { DRAIN_DEADLINE_MS, REQUEST_START_CHANNEL } from "@/lib/shutdown-drain";
import {
  exitOwnerAtBoot,
  installShutdownHandler,
  MANUAL_SIGNAL_HANDLING_VARIABLE,
  resetShutdownHandler,
} from "@/lib/shutdown-handler";
import { installUncaughtExceptionExit, resetUncaughtExceptionExit } from "@/lib/uncaught-exception";
import {
  requestStart,
  requestStartsStandIn,
  standInResponse,
  standInServer,
} from "../../helpers/request-starts-stand-in";
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

/** Studio's start line for `signal`, where it owns the exit. */
const studioStart = (signal: string): string =>
  `Received ${signal}: closing the HTTP server and waiting for the requests in flight, then running the shutdown hooks, then closing the providers, then exiting`;

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

  test("on SIGTERM where Studio owns the exit it drains the requests in flight, then runs the hooks, then closes every provider cache, then exits with 0 once all of it settled", async () => {
    const order: string[] = [];
    const source = requestStartsStandIn();
    const server = standInServer();
    const response = standInResponse();
    response.once("close", () => order.push("drain end"));
    onShutdown("hook", async () => {
      order.push("hook");
    });
    registerClose(async () => {
      order.push("close");
    });
    const proc = shutdownStandIn();
    installShutdownHandler(proc, "studio", source.starts);
    source.publish(requestStart(server, response));

    proc.signal("SIGTERM");
    await settle();
    expect(order).toEqual([]);
    expect(server.calls).toEqual(["close"]);
    response.end();

    expect(await proc.exited).toBe(0);
    expect(order).toEqual(["drain end", "hook", "close"]);
    expect(proc.exits).toEqual([0]);
    expect(lines("info")).toEqual([
      [studioStart("SIGTERM"), { route: "shutdown", owner: "studio", servers: 1, inFlight: 1 }],
      ["Shutdown complete, exiting with 0", { route: "shutdown", signal: "SIGTERM" }],
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("where Studio owns the exit it subscribes to http.server.request.start at install, before any signal, and a second install subscribes nothing", () => {
    const source = requestStartsStandIn();
    const proc = shutdownStandIn();

    installShutdownHandler(proc, "studio", source.starts);
    expect(source.subscriptions()).toBe(1);
    installShutdownHandler(proc, "studio", source.starts);
    expect(source.subscriptions()).toBe(1);
    expect(proc.exits).toEqual([]);
  });

  test("the hooks start only after the last response in flight has closed", async () => {
    const source = requestStartsStandIn();
    const server = standInServer();
    const first = standInResponse();
    const last = standInResponse();
    const openAtHook: number[] = [];
    let open = 2;
    first.once("close", () => {
      open -= 1;
    });
    last.once("close", () => {
      open -= 1;
    });
    onShutdown("observer", async () => {
      openAtHook.push(open);
    });
    const proc = shutdownStandIn();
    installShutdownHandler(proc, "studio", source.starts);
    source.publish(requestStart(server, first));
    source.publish(requestStart(server, last));

    proc.signal("SIGTERM");
    await settle();
    first.end();
    await settle();
    expect(openAtHook).toEqual([]);
    last.end();

    expect(await proc.exited).toBe(0);
    expect(openAtHook).toEqual([0]);
  });

  test("a response still in flight 5 s after the signal is cut, the hooks and the closes run after it, and the exit code is 143 with responsesCut in the end line", async () => {
    const order: string[] = [];
    const source = requestStartsStandIn();
    onShutdown("hook", async () => {
      order.push("hook");
    });
    registerClose(async () => {
      order.push("close");
    });
    const proc = shutdownStandIn();
    installShutdownHandler(proc, "studio", source.starts);
    source.publish(requestStart(standInServer(), standInResponse()));
    jest.useFakeTimers();

    proc.signal("SIGTERM");
    await settle();
    jest.advanceTimersByTime(DRAIN_DEADLINE_MS - 1);
    await settle();
    expect(order).toEqual([]);
    expect(proc.exits).toEqual([]);

    jest.advanceTimersByTime(1);
    expect(await proc.exited).toBe(143);
    expect(order).toEqual(["hook", "close"]);
    expect(logger.warn).toHaveBeenCalledWith("Requests in flight cut at the drain deadline", {
      route: "shutdown",
      pending: 1,
    });
    expect(logger.warn).toHaveBeenCalledWith("Shutdown incomplete, exiting with 143", {
      route: "shutdown",
      signal: "SIGTERM",
      responsesCut: 1,
      responsesInFlightAtExit: 1,
      hooksCut: undefined,
      hooksFailed: undefined,
      cacheClosesCut: undefined,
      cacheClosesFailed: undefined,
      stepsFailed: undefined,
      queryEventsLost: undefined,
    });
  });

  test("the start line names the servers the drain closes and the responses in flight", async () => {
    const source = requestStartsStandIn();
    const first = standInServer();
    const second = standInServer();
    const done = standInResponse();
    const open = standInResponse();
    const proc = shutdownStandIn();
    installShutdownHandler(proc, "studio", source.starts);
    source.publish(requestStart(first, done));
    source.publish(requestStart(second, open));
    done.end();

    proc.signal("SIGINT");
    expect(lines("info")[0]).toEqual([
      studioStart("SIGINT"),
      { route: "shutdown", owner: "studio", servers: 2, inFlight: 1 },
    ]);
    open.end();

    expect(await proc.exited).toBe(0);
    expect(first.calls).toEqual(["close"]);
    expect(second.calls).toEqual(["close", "closeIdleConnections"]);
  });

  test("where Next.js owns the exit it subscribes to nothing and closes no server", async () => {
    const source = requestStartsStandIn();
    const server = standInServer();
    let hookRan = false;
    onShutdown("hook", async () => {
      hookRan = true;
    });
    const proc = shutdownStandIn();
    installShutdownHandler(proc, "nextjs", source.starts);
    source.publish(requestStart(server, standInResponse()));

    proc.signal("SIGTERM");
    await settle();

    expect(source.subscriptions()).toBe(0);
    expect(hookRan).toBe(true);
    expect(server.calls).toEqual([]);
    expect(proc.exits).toEqual([]);
  });

  test("resetShutdownHandler unsubscribes the drain", () => {
    const source = requestStartsStandIn();
    installShutdownHandler(shutdownStandIn(), "studio", source.starts);
    resetShutdownHandler();
    expect(source.unsubscriptions()).toBe(1);

    // With the default source, node:diagnostics_channel itself.
    expect(diagnostics_channel.hasSubscribers(REQUEST_START_CHANNEL)).toBe(false);
    installShutdownHandler(shutdownStandIn(), "studio");
    expect(diagnostics_channel.hasSubscribers(REQUEST_START_CHANNEL)).toBe(true);
    resetShutdownHandler();
    expect(diagnostics_channel.hasSubscribers(REQUEST_START_CHANNEL)).toBe(false);

    // Where Next.js owns the exit there is nothing to unsubscribe.
    installShutdownHandler(shutdownStandIn(), "nextjs", source.starts);
    resetShutdownHandler();
    expect(source.unsubscriptions()).toBe(1);
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
      responsesCut: undefined,
      responsesInFlightAtExit: undefined,
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
      responsesCut: undefined,
      responsesInFlightAtExit: undefined,
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
      responsesCut: undefined,
      responsesInFlightAtExit: undefined,
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
      responsesCut: undefined,
      responsesInFlightAtExit: undefined,
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
      responsesCut: undefined,
      responsesInFlightAtExit: undefined,
      hooksCut: undefined,
      hooksFailed: undefined,
      cacheClosesCut: undefined,
      cacheClosesFailed: undefined,
      stepsFailed: undefined,
      queryEventsLost: 2,
    });
  });

  test("a request that starts after the drain answered and is still in flight at the exit makes the exit code 143 and the end line counts it", async () => {
    // A connection the drain could not end, such as one whose next request had begun, carries that request on.
    const source = requestStartsStandIn();
    const server = standInServer();
    const late = standInResponse();
    onShutdown("hook", async () => {
      source.publish(requestStart(server, late));
    });
    const proc = shutdownStandIn();
    installShutdownHandler(proc, "studio", source.starts);

    proc.signal("SIGTERM");

    expect(await proc.exited).toBe(143);
    expect(late.headers).toEqual({ Connection: "close" });
    expect(logger.warn).toHaveBeenCalledWith("Shutdown incomplete, exiting with 143", {
      route: "shutdown",
      signal: "SIGTERM",
      responsesCut: undefined,
      responsesInFlightAtExit: 1,
      hooksCut: undefined,
      hooksFailed: undefined,
      cacheClosesCut: undefined,
      cacheClosesFailed: undefined,
      stepsFailed: undefined,
      queryEventsLost: undefined,
    });
  });

  test("a request that starts after the drain answered and ends before the exit leaves the exit code 0", async () => {
    const source = requestStartsStandIn();
    const late = standInResponse();
    onShutdown("hook", async () => {
      source.publish(requestStart(standInServer(), late));
      late.end();
    });
    const proc = shutdownStandIn();
    installShutdownHandler(proc, "studio", source.starts);

    proc.signal("SIGTERM");

    expect(await proc.exited).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
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

    resetShutdownHooks();
    resetShutdownHandler();
    const source = requestStartsStandIn();
    const cut = shutdownStandIn();
    installShutdownHandler(cut, "studio", source.starts);
    source.publish(requestStart(standInServer(), standInResponse()));
    jest.useFakeTimers();
    cut.signal("SIGINT");
    await settle();
    jest.advanceTimersByTime(DRAIN_DEADLINE_MS);
    expect(await cut.exited).toBe(130);
    expect(logger.warn).toHaveBeenCalledWith(
      "Shutdown incomplete, exiting with 130",
      expect.objectContaining({ signal: "SIGINT", responsesCut: 1 }),
    );
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

  test("a drain, a hooks run or a cache close run that rejects is logged, counts as incomplete, and the exit still runs", async () => {
    const drainFailure = new Error("drain failed");
    const hooksFailure = new Error("hooks run failed");
    const closesFailure = new Error("closes run failed");
    const drain = spyOn(drainModule, "trackRequests").mockImplementation(() => ({
      tracked: () => ({ servers: 0, inFlight: 0 }),
      drain: () => Promise.reject(drainFailure),
      stop: () => {},
    }));
    const hooks = spyOn(shutdownRegistry, "runShutdownHooks").mockImplementation(() => Promise.reject(hooksFailure));
    const closes = spyOn(shutdownRegistry, "closeProviderCaches").mockImplementation(() =>
      Promise.reject(closesFailure),
    );
    try {
      const proc = shutdownStandIn();
      installShutdownHandler(proc, "studio");

      proc.signal("SIGTERM");

      expect(await proc.exited).toBe(143);
      expect(logger.error).toHaveBeenCalledWith("Shutdown step failed", drainFailure, {
        route: "shutdown",
        step: "drain",
      });
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
        responsesCut: undefined,
        responsesInFlightAtExit: undefined,
        hooksCut: undefined,
        hooksFailed: undefined,
        cacheClosesCut: undefined,
        cacheClosesFailed: undefined,
        stepsFailed: ["drain", "hooks", "provider cache closes"],
        queryEventsLost: undefined,
      });
    } finally {
      drain.mockRestore();
      hooks.mockRestore();
      closes.mockRestore();
    }
  });
});

describe("exitOwnerAtBoot", () => {
  /** The runtime versions of a Node.js process, which names no `bun`. */
  const NODE_VERSIONS = { node: "24.22.1" };

  /**
   * Runs exitOwnerAtBoot with the variable set to `value`, or unset for `undefined`, on `versions` (this process's by
   * default), recording exits and banners.
   */
  function ownerWith(
    value: string | undefined,
    versions?: { readonly node: string; readonly bun?: string },
  ): { owner: unknown; exits: Array<number | undefined>; banner: string } {
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
      const owner = versions === undefined ? exitOwnerAtBoot() : exitOwnerAtBoot(versions);
      return { owner, exits, banner: errorSpy.mock.calls.flat().join("\n") };
    } finally {
      process.exit = originalExit;
      errorSpy.mockRestore();
      if (saved === undefined) delete process.env[MANUAL_SIGNAL_HANDLING_VARIABLE];
      else process.env[MANUAL_SIGNAL_HANDLING_VARIABLE] = saved;
    }
  }

  test("NEXT_MANUAL_SIG_HANDLE true gives Studio the exit on Node.js, unset or empty leaves it to Next.js, and any other value refuses the boot naming the variable", () => {
    expect(MANUAL_SIGNAL_HANDLING_VARIABLE).toBe("NEXT_MANUAL_SIG_HANDLE");
    expect(ownerWith("true", NODE_VERSIONS)).toEqual({ owner: "studio", exits: [], banner: "" });
    expect(ownerWith(undefined, NODE_VERSIONS)).toEqual({ owner: "nextjs", exits: [], banner: "" });
    expect(ownerWith("", NODE_VERSIONS)).toEqual({ owner: "nextjs", exits: [], banner: "" });
    for (const value of ["1", "false", "TRUE"]) {
      const refused = ownerWith(value, NODE_VERSIONS);
      expect(refused.owner).toBeUndefined();
      expect(refused.exits).toEqual([1]);
      expect(refused.banner).toContain(`NEXT_MANUAL_SIG_HANDLE is set to "${value}"`);
      expect(refused.banner).toContain("docs/DISTRIBUTION.md#stopping-the-server");
    }
  });

  test("on Bun, NEXT_MANUAL_SIG_HANDLE true refuses the boot naming the variable and the runtime, since the drain sees no request there, and unset or empty leaves the exit to Next.js", () => {
    // This file runs under Bun, so the default reads Bun's own process.versions.
    expect(typeof process.versions.bun).toBe("string");
    const refused = ownerWith("true");
    expect(refused.owner).toBeUndefined();
    expect(refused.exits).toEqual([1]);
    expect(refused.banner).toContain(`NEXT_MANUAL_SIG_HANDLE is set to "true" on Bun ${process.versions.bun}`);
    expect(refused.banner).toContain("docs/DISTRIBUTION.md#stopping-the-server");
    expect(ownerWith(undefined)).toEqual({ owner: "nextjs", exits: [], banner: "" });
    expect(ownerWith("")).toEqual({ owner: "nextjs", exits: [], banner: "" });
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
