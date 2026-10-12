import { describe, expect, mock, spyOn, test } from "bun:test";
import { bridgeAbortToCancel } from "@/lib/api/abort-cancel";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("bridgeAbortToCancel", () => {
  test("an abort cancels the bound id exactly once", async () => {
    const controller = new AbortController();
    const cancelQuery = mock(async (_id: string) => true);
    bridgeAbortToCancel(controller.signal, { cancelQuery }, "q-1-a", "api/db/query");
    controller.abort();
    controller.abort();
    await flush();
    expect(cancelQuery).toHaveBeenCalledTimes(1);
    expect(cancelQuery).toHaveBeenCalledWith("q-1-a");
  });

  test("no bound id, or a provider that cannot cancel, sends nothing", async () => {
    const controller = new AbortController();
    const cancelQuery = mock(async (_id: string) => true);
    bridgeAbortToCancel(controller.signal, { cancelQuery }, undefined, "api/db/query");
    bridgeAbortToCancel(controller.signal, {}, "q-1-b", "api/db/query");
    controller.abort();
    await flush();
    expect(cancelQuery).not.toHaveBeenCalled();
  });

  test("after the release an abort sends nothing", async () => {
    const controller = new AbortController();
    const cancelQuery = mock(async (_id: string) => true);
    const release = bridgeAbortToCancel(controller.signal, { cancelQuery }, "q-1-c", "api/db/query");
    release();
    release();
    controller.abort();
    await flush();
    expect(cancelQuery).not.toHaveBeenCalled();
  });

  test("a signal already aborted cancels at once", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelQuery = mock(async (_id: string) => true);
    bridgeAbortToCancel(controller.signal, { cancelQuery }, "q-1-d", "api/db/multi-query");
    await flush();
    expect(cancelQuery).toHaveBeenCalledTimes(1);
  });

  test("a rejected cancel is logged by route only, never with its text", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const controller = new AbortController();
      const cancelQuery = mock(async (_id: string): Promise<boolean> => {
        throw new Error("server said token sentinel-PAT-123");
      });
      bridgeAbortToCancel(controller.signal, { cancelQuery }, "q-1-e", "api/db/multi-query");
      controller.abort();
      await flush();
      const lines = warn.mock.calls.map((call) => call.join(" "));
      expect(lines.some((line) => line.includes("api/db/multi-query"))).toBe(true);
      expect(lines.some((line) => line.includes("sentinel-PAT-123"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("a cancel that never settles does not hold the caller", () => {
    const controller = new AbortController();
    const cancelQuery = mock((_id: string) => new Promise<boolean>(() => {}));
    const release = bridgeAbortToCancel(controller.signal, { cancelQuery }, "q-1-f", "api/db/query");
    controller.abort();
    expect(typeof release).toBe("function");
    expect(cancelQuery).toHaveBeenCalledTimes(1);
  });
});
