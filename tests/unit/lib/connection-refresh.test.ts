import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  MANAGED_REFRESH_DEFAULT_FLOOR_MS,
  MANAGED_REFRESH_MAX_MS,
  managedRefreshIntervalMs,
  shouldStartManagedRefresh,
  startManagedListRefresh,
} from "@/lib/connection-refresh";
import { logger } from "@/lib/logger";

let stopRefresh: (() => void) | undefined;

afterEach(() => {
  stopRefresh?.();
  stopRefresh = undefined;
  mock.restore();
  delete process.env.NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS;
  Reflect.deleteProperty(document, "visibilityState");
});

describe("managed refresh interval", () => {
  test("honors the hint, floor and cap", () => {
    expect(MANAGED_REFRESH_DEFAULT_FLOOR_MS).toBe(5000);
    expect(MANAGED_REFRESH_MAX_MS).toBe(60000);
    expect(managedRefreshIntervalMs(null)).toBe(5000);
    expect(managedRefreshIntervalMs(12000)).toBe(12000);
    expect(managedRefreshIntervalMs(1000)).toBe(5000);
    expect(managedRefreshIntervalMs(600000)).toBe(60000);
    process.env.NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS = "25";
    expect(managedRefreshIntervalMs(null)).toBe(25);
    expect(managedRefreshIntervalMs(60000)).toBe(60000);
    process.env.NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS = "90000";
    expect(managedRefreshIntervalMs(null)).toBe(60000);
    process.env.NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS = "soon";
    expect(managedRefreshIntervalMs(null)).toBe(5000);
  });
});

describe("shouldStartManagedRefresh", () => {
  test("starts only after an answer or a governance outage", () => {
    expect(shouldStartManagedRefresh(false, false)).toBe(false);
    expect(shouldStartManagedRefresh(true, false)).toBe(true);
    expect(shouldStartManagedRefresh(false, true)).toBe(true);
    expect(shouldStartManagedRefresh(true, true)).toBe(true);
  });
});

describe("startManagedListRefresh", () => {
  test("an unanswered first read installs nothing and still returns stop", () => {
    const intervalSpy = spyOn(globalThis, "setInterval");
    const focusSpy = spyOn(window, "addEventListener");
    const visibilitySpy = spyOn(document, "addEventListener");
    stopRefresh = startManagedListRefresh({
      answered: false,
      unavailable: false,
      cacheHint: null,
      refresh: async () => {},
    });

    expect(intervalSpy).not.toHaveBeenCalled();
    expect(focusSpy).not.toHaveBeenCalled();
    expect(visibilitySpy).not.toHaveBeenCalled();
    stopRefresh();
  });

  test("owns the interval, both event listeners, visibility guard and cleanup", async () => {
    const intervalSpy = spyOn(globalThis, "setInterval");
    const clearSpy = spyOn(globalThis, "clearInterval");
    const focusSpy = spyOn(window, "addEventListener");
    const visibilitySpy = spyOn(document, "addEventListener");
    const removeFocusSpy = spyOn(window, "removeEventListener");
    const removeVisibilitySpy = spyOn(document, "removeEventListener");
    const refresh = mock(async () => {});
    stopRefresh = startManagedListRefresh({ answered: true, unavailable: false, cacheHint: 60000, refresh });
    const tick = intervalSpy.mock.calls[0][0] as () => Promise<void>;

    expect(intervalSpy).toHaveBeenCalledWith(tick, 60000);
    expect(focusSpy).toHaveBeenCalledWith("focus", tick);
    expect(visibilitySpy).toHaveBeenCalledWith("visibilitychange", tick);
    expect(refresh).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    await tick();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).not.toHaveBeenCalled();

    Reflect.deleteProperty(document, "visibilityState");
    await tick();
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(3);

    stopRefresh();
    expect(clearSpy).toHaveBeenCalledWith(intervalSpy.mock.results[0].value);
    expect(removeFocusSpy).toHaveBeenCalledWith("focus", tick);
    expect(removeVisibilitySpy).toHaveBeenCalledWith("visibilitychange", tick);
    await tick();
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  test("a governance outage starts refreshes and in-flight reads absorb further triggers", async () => {
    const intervalSpy = spyOn(globalThis, "setInterval");
    let release: () => void = () => {};
    const refresh = mock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    stopRefresh = startManagedListRefresh({ answered: false, unavailable: true, cacheHint: 60000, refresh });
    const tick = intervalSpy.mock.calls[0][0] as () => Promise<void>;

    const pending = tick();
    await tick();
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(1);
    release();
    await pending;
    const next = tick();
    expect(refresh).toHaveBeenCalledTimes(2);
    stopRefresh();
    release();
    await next;
  });

  test("logs rejected reads and synchronous errors, then releases the in-flight guard", async () => {
    const intervalSpy = spyOn(globalThis, "setInterval");
    const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
    let calls = 0;
    const refresh = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("network down"));
      if (calls === 2) throw "offline";
      return Promise.resolve();
    };
    stopRefresh = startManagedListRefresh({ answered: true, unavailable: false, cacheHint: 60000, refresh });
    const tick = intervalSpy.mock.calls[0][0] as () => Promise<void>;

    await tick();
    expect(debugSpy).toHaveBeenCalledWith("Managed connection refresh failed", {
      route: "connection-refresh",
      error: "network down",
    });
    await tick();
    expect(debugSpy).toHaveBeenCalledWith("Managed connection refresh failed", {
      route: "connection-refresh",
      error: "offline",
    });
    await tick();
    expect(calls).toBe(3);
    expect(debugSpy).toHaveBeenCalledTimes(2);
  });
});
