import "../setup-dom";

import { describe, test, expect, beforeEach } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import React from "react";
import ReactDOMServer from "react-dom/server";

import { useFavoriteConnections } from "@/hooks/use-favorite-connections";
import { storage } from "@/lib/storage";

describe("useFavoriteConnections", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("starts with an empty set before storage is ready", () => {
    const { result } = renderHook(() => useFavoriteConnections(false));
    expect(result.current.favoriteIds.size).toBe(0);
  });

  test("does not read from storage before storage is ready", () => {
    storage.toggleFavoriteConnection("conn-1");
    const { result } = renderHook(() => useFavoriteConnections(false));
    expect(result.current.favoriteIds.has("conn-1")).toBe(false);
  });

  test("loads existing favorites once storage becomes ready", () => {
    storage.toggleFavoriteConnection("conn-1");
    storage.toggleFavoriteConnection("conn-2");

    const { result, rerender } = renderHook(({ ready }) => useFavoriteConnections(ready), {
      initialProps: { ready: false },
    });
    expect(result.current.favoriteIds.size).toBe(0);

    rerender({ ready: true });

    expect(result.current.favoriteIds.has("conn-1")).toBe(true);
    expect(result.current.favoriteIds.has("conn-2")).toBe(true);
  });

  test("toggleFavorite adds an id and updates favoriteIds", async () => {
    const { result } = renderHook(() => useFavoriteConnections(true));

    act(() => {
      result.current.toggleFavorite("conn-1");
    });

    await waitFor(() => {
      expect(result.current.favoriteIds.has("conn-1")).toBe(true);
    });
    expect(storage.getFavoriteConnectionIds()).toEqual(["conn-1"]);
  });

  test("toggleFavorite removes an id already favorited", async () => {
    const { result } = renderHook(() => useFavoriteConnections(true));

    act(() => {
      result.current.toggleFavorite("conn-1");
    });
    await waitFor(() => {
      expect(result.current.favoriteIds.has("conn-1")).toBe(true);
    });

    act(() => {
      result.current.toggleFavorite("conn-1");
    });
    await waitFor(() => {
      expect(result.current.favoriteIds.has("conn-1")).toBe(false);
    });
  });

  test("ignores libredb-storage-change events for other collections", () => {
    const { result } = renderHook(() => useFavoriteConnections(true));

    act(() => {
      window.dispatchEvent(
        new CustomEvent("libredb-storage-change", { detail: { collection: "connections", data: [] } }),
      );
    });

    expect(result.current.favoriteIds.size).toBe(0);
  });

  test("picks up a favorite_connections change dispatched by another consumer of the facade", async () => {
    const { result } = renderHook(() => useFavoriteConnections(true));

    act(() => {
      // Simulates a second mounted instance (or the storage-sync pull) writing through
      // the facade directly, rather than through this hook's own toggleFavorite.
      storage.toggleFavoriteConnection("conn-remote");
    });

    await waitFor(() => {
      expect(result.current.favoriteIds.has("conn-remote")).toBe(true);
    });
  });

  /**
   * There is no localStorage on the server, so `useSyncExternalStore` must take the
   * server snapshot rather than one that read the (jsdom-provided, in this suite)
   * localStorage. Seeding a real favorite first is what makes the assertion able to
   * tell the two snapshots apart: only `getSnapshot` would see it.
   */
  test("reports no favorites during server rendering, even with favorites already stored", () => {
    storage.toggleFavoriteConnection("conn-should-not-appear");

    function Probe() {
      const { favoriteIds } = useFavoriteConnections(true);
      return React.createElement("span", null, String(favoriteIds.has("conn-should-not-appear")));
    }

    expect(ReactDOMServer.renderToString(React.createElement(Probe))).toContain("false");
  });

  test("removes its event listener on unmount", () => {
    const originalRemove = window.removeEventListener.bind(window);
    let removedCollectionListener = false;
    window.removeEventListener = ((...args: Parameters<typeof window.removeEventListener>) => {
      if (args[0] === "libredb-storage-change") removedCollectionListener = true;
      return originalRemove(...args);
    }) as typeof window.removeEventListener;

    const { unmount } = renderHook(() => useFavoriteConnections(true));
    unmount();

    expect(removedCollectionListener).toBe(true);
    window.removeEventListener = originalRemove;
  });
});
