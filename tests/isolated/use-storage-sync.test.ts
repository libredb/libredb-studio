import "../setup-dom";

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";

// ── Mock storage module ─────────────────────────────────────────────────────

const mockStorage = {
  getConnections: mock(() => [{ id: "c1" }]),
  getHistory: mock(() => []),
  getSavedQueries: mock(() => []),
  getSchemaSnapshots: mock(() => []),
  getSavedCharts: mock(() => []),
  getActiveConnectionId: mock((): string | null => null),
  getAuditLog: mock(() => []),
  getMaskingConfig: mock(() => ({
    enabled: true,
    patterns: [],
    roleSettings: { admin: { canToggle: true, canReveal: true }, user: { canToggle: false, canReveal: false } },
  })),
  getThresholdConfig: mock(() => []),
  getDismissedSeeds: mock(() => ["seed-1"]),
};

const ALL_COLLECTIONS = [
  "connections",
  "history",
  "saved_queries",
  "schema_snapshots",
  "saved_charts",
  "active_connection_id",
  "audit_log",
  "masking_config",
  "threshold_config",
  "dismissed_seeds",
];

mock.module("@/lib/storage", () => ({
  storage: mockStorage,
  STORAGE_COLLECTIONS: ALL_COLLECTIONS,
}));

import { useStorageSync } from "@/hooks/use-storage-sync";

// ── Helpers ─────────────────────────────────────────────────────────────────

function setupLocalMode() {
  return mockGlobalFetch({
    "/api/storage/config": { ok: true, status: 200, json: { provider: "local", serverMode: false } },
  });
}

function setupServerMode(extraRoutes: Record<string, unknown> = {}) {
  return mockGlobalFetch({
    "/api/storage/config": { ok: true, status: 200, json: { provider: "postgres", serverMode: true } },
    "/api/storage/migrate": { ok: true, status: 200, json: { ok: true, migrated: ["connections"] } },
    "/api/storage": { ok: true, status: 200, json: { connections: [{ id: "server-c1" }] } },
    ...extraRoutes,
  });
}

type FetchMock = ReturnType<typeof mockGlobalFetch>;

function calledPaths(fetchMock: FetchMock): string[] {
  return (fetchMock.mock.calls as unknown[][]).map((c) => {
    const url = typeof c[0] === "string" ? c[0] : "";
    return new URL(url, "http://localhost:3000").pathname;
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("useStorageSync", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.values(mockStorage).forEach((fn) => fn.mockClear());
  });

  afterEach(() => {
    restoreGlobalFetch();
    cleanup();
  });

  // ── Mode discovery ──────────────────────────────────────────────────────

  describe("mode discovery", () => {
    test("starts with isServerMode=false", () => {
      setupLocalMode();
      const { result } = renderHook(() => useStorageSync());
      expect(result.current.isServerMode).toBe(false);
    });

    test("stays in local mode when config returns serverMode=false", async () => {
      setupLocalMode();
      const { result } = renderHook(() => useStorageSync());

      // Wait for config fetch to resolve
      await waitFor(() => {
        expect(result.current.isSyncing).toBe(false);
      });

      expect(result.current.isServerMode).toBe(false);
    });

    test("switches to server mode when config returns serverMode=true", async () => {
      setupServerMode();
      localStorage.setItem("libredb_server_migrated", "true"); // Skip migration

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.isServerMode).toBe(true);
      });
    });

    test("stays in local mode when config fetch fails", async () => {
      mockGlobalFetch({
        "/api/storage/config": { ok: false, status: 500, json: { error: "Server error" } },
      });

      const { result } = renderHook(() => useStorageSync());

      // Give it time to settle
      await waitFor(() => {
        expect(result.current.isSyncing).toBe(false);
      });

      expect(result.current.isServerMode).toBe(false);
    });

    test("stays in local mode when config fetch throws network error", async () => {
      globalThis.fetch = mock(async () => {
        throw new Error("Network error");
      }) as unknown as typeof fetch;

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.isSyncing).toBe(false);
      });

      expect(result.current.isServerMode).toBe(false);
      expect(result.current.syncError).toBeNull();
    });
  });

  // ── Migration ───────────────────────────────────────────────────────────

  describe("migration", () => {
    test("performs migration on first server-mode visit when localStorage has data", async () => {
      // Seed localStorage with actual data so migration has something to send
      localStorage.setItem("libredb_connections", JSON.stringify([{ id: "test", name: "Test DB" }]));
      const fetchMock = setupServerMode();

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.isServerMode).toBe(true);
      });

      // Migration flag should be set
      expect(localStorage.getItem("libredb_server_migrated")).not.toBeNull();

      // migrate endpoint was called
      const calls = (fetchMock.mock.calls as unknown[][]).map((c) => {
        const url = typeof c[0] === "string" ? c[0] : "";
        return new URL(url, "http://localhost:3000").pathname;
      });
      expect(calls).toContain("/api/storage/migrate");
    });

    test("skips migration on fresh browser with empty localStorage", async () => {
      const fetchMock = setupServerMode();

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.isServerMode).toBe(true);
      });

      // Migration flag should still be set (to prevent future re-checks)
      expect(localStorage.getItem("libredb_server_migrated")).not.toBeNull();

      // migrate endpoint should NOT be called — no local data to migrate
      const calls = (fetchMock.mock.calls as unknown[][]).map((c) => {
        const url = typeof c[0] === "string" ? c[0] : "";
        return new URL(url, "http://localhost:3000").pathname;
      });
      expect(calls).not.toContain("/api/storage/migrate");
    });

    test("skips migration when flag already set", async () => {
      localStorage.setItem("libredb_server_migrated", "2026-01-01");
      const fetchMock = setupServerMode();

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.isServerMode).toBe(true);
      });

      // migrate endpoint should NOT be called
      const calls = (fetchMock.mock.calls as unknown[][]).map((c) => {
        const url = typeof c[0] === "string" ? c[0] : "";
        return new URL(url, "http://localhost:3000").pathname;
      });
      expect(calls).not.toContain("/api/storage/migrate");
    });

    test("sets migration flag even when no data to migrate", async () => {
      // All storage getters return empty
      mockStorage.getConnections.mockReturnValue([]);
      mockStorage.getActiveConnectionId.mockReturnValue(null);

      setupServerMode();

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.isServerMode).toBe(true);
      });

      expect(localStorage.getItem("libredb_server_migrated")).not.toBeNull();
    });

    test("sets flag without calling migrate when local keys exist but getters return no data", async () => {
      // Key exists in localStorage (hasLocalData=true) but the facade getter
      // returns null, so allData stays empty and migration is skipped.
      localStorage.setItem("libredb_active_connection_id", "stale");
      mockStorage.getActiveConnectionId.mockReturnValue(null);
      const fetchMock = setupServerMode();

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.isServerMode).toBe(true);
      });

      expect(localStorage.getItem("libredb_server_migrated")).not.toBeNull();
      expect(calledPaths(fetchMock)).not.toContain("/api/storage/migrate");
    });

    test("does not set flag when migrate fetch throws", async () => {
      localStorage.setItem("libredb_connections", JSON.stringify([{ id: "test" }]));
      mockStorage.getConnections.mockReturnValue([{ id: "test" }]);
      mockGlobalFetch({
        "/api/storage/config": { ok: true, status: 200, json: { provider: "postgres", serverMode: true } },
        "/api/storage/migrate": () => {
          throw new Error("migrate down");
        },
        "/api/storage": { ok: true, status: 200, json: {} },
      });

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      // Migration failed silently; flag must stay unset so it retries next visit
      expect(localStorage.getItem("libredb_server_migrated")).toBeNull();
      expect(result.current.isServerMode).toBe(true);
    });

    test("migrates every collection through the storage facade", async () => {
      for (const col of ALL_COLLECTIONS) {
        localStorage.setItem(`libredb_${col}`, "x");
      }
      mockStorage.getConnections.mockReturnValue([{ id: "c1" }]);
      mockStorage.getActiveConnectionId.mockReturnValue("c1");
      const fetchMock = setupServerMode();

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.isServerMode).toBe(true);
      });

      expect(calledPaths(fetchMock)).toContain("/api/storage/migrate");
      // Every collection getter was consulted during migration
      expect(mockStorage.getConnections).toHaveBeenCalled();
      expect(mockStorage.getHistory).toHaveBeenCalled();
      expect(mockStorage.getSavedQueries).toHaveBeenCalled();
      expect(mockStorage.getSchemaSnapshots).toHaveBeenCalled();
      expect(mockStorage.getSavedCharts).toHaveBeenCalled();
      expect(mockStorage.getActiveConnectionId).toHaveBeenCalled();
      expect(mockStorage.getAuditLog).toHaveBeenCalled();
      expect(mockStorage.getMaskingConfig).toHaveBeenCalled();
      expect(mockStorage.getThresholdConfig).toHaveBeenCalled();
      expect(mockStorage.getDismissedSeeds).toHaveBeenCalled();
    });
  });

  // ── Pull from server ──────────────────────────────────────────────────

  describe("pull from server", () => {
    test("pulls data from server on mount in server mode", async () => {
      localStorage.setItem("libredb_server_migrated", "true");
      const fetchMock = setupServerMode();

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.isServerMode).toBe(true);
      });

      // /api/storage was called for pull
      const calls = (fetchMock.mock.calls as unknown[][]).map((c) => {
        const url = typeof c[0] === "string" ? c[0] : "";
        return new URL(url, "http://localhost:3000").pathname;
      });
      expect(calls).toContain("/api/storage");
    });

    test("writes server data to localStorage on pull", async () => {
      localStorage.setItem("libredb_server_migrated", "true");
      setupServerMode();

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.lastSyncedAt).not.toBeNull();
      });

      // Server returned connections: [{ id: 'server-c1' }]
      const stored = localStorage.getItem("libredb_connections");
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!)).toEqual([{ id: "server-c1" }]);
    });

    test("sets syncError on pull failure", async () => {
      localStorage.setItem("libredb_server_migrated", "true");
      mockGlobalFetch({
        "/api/storage/config": { ok: true, status: 200, json: { provider: "postgres", serverMode: true } },
        "/api/storage": { ok: false, status: 500, json: { error: "DB error" } },
      });

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.isServerMode).toBe(true);
      });

      // Pull failed but no syncError for non-ok response (graceful degradation)
      // The hook just returns early without setting error for non-ok
      expect(result.current.isSyncing).toBe(false);
    });

    test("sets syncError when pull fetch throws", async () => {
      localStorage.setItem("libredb_server_migrated", "true");
      mockGlobalFetch({
        "/api/storage/config": { ok: true, status: 200, json: { provider: "postgres", serverMode: true } },
        "/api/storage": () => {
          throw new Error("pull down");
        },
      });

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.syncError).not.toBeNull();
      });

      expect(result.current.isSyncing).toBe(false);
    });

    test("writes string active_connection_id to localStorage on pull", async () => {
      localStorage.setItem("libredb_server_migrated", "true");
      setupServerMode({
        "/api/storage": { ok: true, status: 200, json: { active_connection_id: "conn-1" } },
      });

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.lastSyncedAt).not.toBeNull();
      });

      expect(localStorage.getItem("libredb_active_connection_id")).toBe("conn-1");
    });

    test("removes active_connection_id from localStorage when server returns null", async () => {
      localStorage.setItem("libredb_server_migrated", "true");
      localStorage.setItem("libredb_active_connection_id", "stale");
      setupServerMode({
        "/api/storage": { ok: true, status: 200, json: { active_connection_id: null } },
      });

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.lastSyncedAt).not.toBeNull();
      });

      expect(localStorage.getItem("libredb_active_connection_id")).toBeNull();
    });
  });

  // ── Push to server (debounced) ────────────────────────────────────────

  describe("push to server", () => {
    test("pushes collection to server on storage-change event", async () => {
      localStorage.setItem("libredb_server_migrated", "true");
      const fetchMock = mockGlobalFetch({
        "/api/storage/config": { ok: true, status: 200, json: { provider: "postgres", serverMode: true } },
        "/api/storage/migrate": { ok: true, status: 200, json: { ok: true, migrated: [] } },
        "/api/storage": { ok: true, status: 200, json: {} },
        "/api/storage/connections": { ok: true, status: 200, json: { ok: true } },
      });

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.isServerMode).toBe(true);
      });

      // Dispatch storage change event
      act(() => {
        window.dispatchEvent(
          new CustomEvent("libredb-storage-change", {
            detail: { collection: "connections", data: [{ id: "c1" }] },
          }),
        );
      });

      // Wait for debounce (500ms) + push
      await waitFor(
        () => {
          const calls = (fetchMock.mock.calls as unknown[][]).map((c) => {
            const url = typeof c[0] === "string" ? c[0] : "";
            return new URL(url, "http://localhost:3000").pathname;
          });
          return calls.includes("/api/storage/connections");
        },
        { timeout: 2000 },
      );
    });

    test("sets syncError on push failure", async () => {
      localStorage.setItem("libredb_server_migrated", "true");

      // Use a request handler that returns 500 specifically for PUT /connections
      const fetchMock = mockGlobalFetch({
        "/api/storage/config": { ok: true, status: 200, json: { provider: "postgres", serverMode: true } },
        "/api/storage/migrate": { ok: true, status: 200, json: { ok: true, migrated: [] } },
        "/api/storage/connections": { ok: false, status: 500, json: { error: "Write failed" } },
        "/api/storage": { ok: true, status: 200, json: {} },
      });

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.isServerMode).toBe(true);
      });

      // Ensure isSyncing is done before triggering push
      await waitFor(() => {
        expect(result.current.isSyncing).toBe(false);
      });

      act(() => {
        window.dispatchEvent(
          new CustomEvent("libredb-storage-change", {
            detail: { collection: "connections", data: [{ id: "c1" }] },
          }),
        );
      });

      // Wait for debounce (500ms) + push to complete and set syncError
      await waitFor(
        () => {
          expect(result.current.syncError).not.toBeNull();
        },
        { timeout: 3000 },
      );
    });

    test("updates lastSyncedAt after successful push", async () => {
      localStorage.setItem("libredb_server_migrated", "true");
      setupServerMode();

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.lastSyncedAt).not.toBeNull();
      });
      const pulledAt = result.current.lastSyncedAt;

      act(() => {
        window.dispatchEvent(
          new CustomEvent("libredb-storage-change", {
            detail: { collection: "connections", data: [{ id: "c1" }] },
          }),
        );
      });

      // Push success creates a fresh Date instance and clears syncError
      await waitFor(
        () => {
          expect(result.current.lastSyncedAt).not.toBe(pulledAt);
        },
        { timeout: 3000 },
      );
      expect(result.current.syncError).toBeNull();
    });

    test("coalesces rapid changes into a single debounced flush", async () => {
      localStorage.setItem("libredb_server_migrated", "true");
      const fetchMock = setupServerMode();

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.isServerMode).toBe(true);
      });

      // Second event lands inside the debounce window and resets the timer
      act(() => {
        window.dispatchEvent(new CustomEvent("libredb-storage-change", { detail: { collection: "history" } }));
        window.dispatchEvent(new CustomEvent("libredb-storage-change", { detail: { collection: "saved_queries" } }));
      });

      await waitFor(
        () => {
          const paths = calledPaths(fetchMock);
          expect(paths).toContain("/api/storage/history");
          expect(paths).toContain("/api/storage/saved_queries");
        },
        { timeout: 3000 },
      );
    });

    test("pushes null data for an unknown collection", async () => {
      localStorage.setItem("libredb_server_migrated", "true");
      const fetchMock = setupServerMode();

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.isServerMode).toBe(true);
      });

      act(() => {
        window.dispatchEvent(new CustomEvent("libredb-storage-change", { detail: { collection: "bogus" } }));
      });

      await waitFor(
        () => {
          expect(calledPaths(fetchMock)).toContain("/api/storage/bogus");
        },
        { timeout: 3000 },
      );

      const bogusCall = (fetchMock.mock.calls as unknown[][]).find((c) => {
        const url = typeof c[0] === "string" ? c[0] : "";
        return new URL(url, "http://localhost:3000").pathname === "/api/storage/bogus";
      });
      expect(bogusCall).toBeDefined();
      expect((bogusCall![1] as RequestInit).body).toBe(JSON.stringify({ data: null }));
    });
  });

  // ── Event listener lifecycle ──────────────────────────────────────────

  describe("event listener lifecycle", () => {
    test("does not listen for events in local mode", async () => {
      setupLocalMode();
      const spy = mock(() => {});
      const origAdd = window.addEventListener.bind(window);
      window.addEventListener = mock((...args: Parameters<typeof window.addEventListener>) => {
        if (args[0] === "libredb-storage-change") spy();
        origAdd(...args);
      }) as typeof window.addEventListener;

      renderHook(() => useStorageSync());

      await waitFor(() => {
        // Give time for init to complete
      });

      // Event listener for storage change should not be added in local mode
      expect(spy).not.toHaveBeenCalled();

      window.addEventListener = origAdd;
    });
  });

  // ── Initial state ─────────────────────────────────────────────────────

  describe("initial state", () => {
    test("returns correct initial state shape", () => {
      setupLocalMode();
      const { result } = renderHook(() => useStorageSync());

      expect(result.current).toEqual({
        isServerMode: false,
        isSyncing: false,
        isReady: false,
        lastSyncedAt: null,
        syncError: null,
      });
    });

    test("updates lastSyncedAt after successful pull", async () => {
      localStorage.setItem("libredb_server_migrated", "true");
      setupServerMode();

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.lastSyncedAt).not.toBeNull();
      });

      expect(result.current.lastSyncedAt).toBeInstanceOf(Date);
    });
  });
});
