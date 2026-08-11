import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { describe, test, expect, mock, afterEach } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";

import { useAgentCapability } from "@/hooks/use-agent-capability";

/**
 * Runtime discovery of the agent flag (#329 T10a).
 *
 * Every path that is not an explicit `enabled: true` resolves to off. That is not
 * defensive habit: the surface it gates starts model-driven database work, so a
 * server that cannot answer, answers something else, or answers nothing must leave
 * the rail absent rather than present-but-broken.
 *
 * The negative cases wait for the probe to have been made AND for its continuation
 * to run before asserting, so "still false" is a settled answer rather than the
 * initial value observed too early — the positive case proves the same wait is
 * enough to observe a flip to true.
 */

async function settleProbe(fetchMock: { mock: { calls: unknown[] } }): Promise<void> {
  await waitFor(() => {
    expect(fetchMock.mock.calls.length).toBe(1);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useAgentCapability", () => {
  afterEach(() => {
    restoreGlobalFetch();
  });

  test("starts disabled before the server has answered", () => {
    mockGlobalFetch({ "/api/agent/config": { json: { enabled: true } } });

    const { result } = renderHook(() => useAgentCapability());

    expect(result.current).toBe(false);
  });

  test("enables the surface once the server says the runtime is on", async () => {
    const fetchMock = mockGlobalFetch({ "/api/agent/config": { json: { enabled: true } } });

    const { result } = renderHook(() => useAgentCapability());

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/agent/config");
  });

  test("stays disabled when the server says the runtime is off", async () => {
    const fetchMock = mockGlobalFetch({ "/api/agent/config": { json: { enabled: false } } });

    const { result } = renderHook(() => useAgentCapability());
    await settleProbe(fetchMock);

    expect(result.current).toBe(false);
  });

  test("stays disabled when the probe is refused", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/agent/config": { status: 401, json: { error: "Authentication required" } },
    });

    const { result } = renderHook(() => useAgentCapability());
    await settleProbe(fetchMock);

    expect(result.current).toBe(false);
  });

  test("stays disabled when the server is unreachable", async () => {
    const fetchMock = mock(async () => {
      throw new Error("network down");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useAgentCapability());
    await settleProbe(fetchMock);

    expect(result.current).toBe(false);
  });

  // A body that is not the documented shape is a server this client does not
  // understand, which is exactly when it must not render a surface that drives one.
  test("stays disabled when the answer is not the documented shape", async () => {
    const fetchMock = mockGlobalFetch({ "/api/agent/config": { json: { enabled: "yes" } } });

    const { result } = renderHook(() => useAgentCapability());
    await settleProbe(fetchMock);

    expect(result.current).toBe(false);
  });

  test("an unmounted probe does not report back", async () => {
    let resolveResponse!: (value: Response) => void;
    globalThis.fetch = mock(
      async () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    ) as unknown as typeof fetch;

    const { result, unmount } = renderHook(() => useAgentCapability());
    unmount();
    await act(async () => {
      resolveResponse(new Response(JSON.stringify({ enabled: true }), { status: 200 }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current).toBe(false);
  });
});
