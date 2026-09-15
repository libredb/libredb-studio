import "../setup-dom";

import { describe, test, expect, beforeEach } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import React from "react";
import ReactDOMServer from "react-dom/server";

import { useConnectionOrder } from "@/hooks/use-connection-order";
import { storage } from "@/lib/storage";

describe("useConnectionOrder", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("starts with an empty order before storage is ready", () => {
    const { result } = renderHook(() => useConnectionOrder(false));
    expect(result.current.order).toEqual([]);
  });

  test("does not read from storage before storage is ready", () => {
    storage.setConnectionOrder(["conn-1"]);
    const { result } = renderHook(() => useConnectionOrder(false));
    expect(result.current.order).toEqual([]);
  });

  test("loads the existing order once storage becomes ready", () => {
    storage.setConnectionOrder(["conn-2", "conn-1"]);

    const { result, rerender } = renderHook(({ ready }) => useConnectionOrder(ready), {
      initialProps: { ready: false },
    });
    expect(result.current.order).toEqual([]);

    rerender({ ready: true });

    expect(result.current.order).toEqual(["conn-2", "conn-1"]);
  });

  test("setOrder persists the new order and updates order", async () => {
    const { result } = renderHook(() => useConnectionOrder(true));

    act(() => {
      result.current.setOrder(["conn-2", "conn-1"]);
    });

    await waitFor(() => {
      expect(result.current.order).toEqual(["conn-2", "conn-1"]);
    });
    expect(storage.getConnectionOrder()).toEqual(["conn-2", "conn-1"]);
  });

  test("ignores libredb-storage-change events for other collections", () => {
    const { result } = renderHook(() => useConnectionOrder(true));

    act(() => {
      window.dispatchEvent(
        new CustomEvent("libredb-storage-change", { detail: { collection: "connections", data: [] } }),
      );
    });

    expect(result.current.order).toEqual([]);
  });

  test("picks up a connection_order change dispatched by another consumer of the facade", async () => {
    const { result } = renderHook(() => useConnectionOrder(true));

    act(() => {
      // Simulates a second mounted instance (or the storage-sync pull) writing through
      // the facade directly, rather than through this hook's own setOrder.
      storage.setConnectionOrder(["conn-remote"]);
    });

    await waitFor(() => {
      expect(result.current.order).toEqual(["conn-remote"]);
    });
  });

  /**
   * There is no localStorage on the server, so `useSyncExternalStore` must take the
   * server snapshot rather than one that read the (jsdom-provided, in this suite)
   * localStorage. Seeding a real order first is what makes the assertion able to tell
   * the two snapshots apart: only `getSnapshot` would see it.
   */
  test("reports an empty order during server rendering, even with an order already stored", () => {
    storage.setConnectionOrder(["conn-should-not-appear"]);

    function Probe() {
      const { order } = useConnectionOrder(true);
      return React.createElement("span", null, JSON.stringify(order));
    }

    expect(ReactDOMServer.renderToString(React.createElement(Probe))).toContain("[]");
  });

  test("removes its event listener on unmount", () => {
    const originalRemove = window.removeEventListener.bind(window);
    let removedCollectionListener = false;
    window.removeEventListener = ((...args: Parameters<typeof window.removeEventListener>) => {
      if (args[0] === "libredb-storage-change") removedCollectionListener = true;
      return originalRemove(...args);
    }) as typeof window.removeEventListener;

    const { unmount } = renderHook(() => useConnectionOrder(true));
    unmount();

    expect(removedCollectionListener).toBe(true);
    window.removeEventListener = originalRemove;
  });
});
