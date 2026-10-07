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
  getFavoriteConnectionIds: mock(() => ["fav-1"]),
  getConnectionOrder: mock(() => ["c1"]),
  getConnectionGroups: mock(() => [{ id: "g1", name: "Prod", collapsed: false, connectionIds: ["c1"] }]),
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
  "favorite_connections",
  "connection_order",
  "connection_groups",
];

mock.module("@/lib/storage", () => ({
  storage: mockStorage,
  STORAGE_COLLECTIONS: ALL_COLLECTIONS,
}));

import { useStorageSync } from "@/hooks/use-storage-sync";
import { releaseAccountWorkspace } from "@/lib/storage/sign-out";
import { workspaceTabsKey } from "@/lib/storage/local-storage";

// ── Helpers ─────────────────────────────────────────────────────────────────

const USERNAME = "user@libredb.org";

/** GET /api/auth/me for the signed-in account; every server-mode route map carries it. */
const SIGNED_IN = {
  "/api/auth/me": { ok: true, status: 200, json: { authenticated: true, user: { username: USERNAME, role: "user" } } },
};

function setupLocalMode() {
  return mockGlobalFetch({
    "/api/storage/config": { ok: true, status: 200, json: { provider: "local", serverMode: false } },
  });
}

function setupServerMode(extraRoutes: Record<string, unknown> = {}) {
  return mockGlobalFetch({
    "/api/storage/config": { ok: true, status: 200, json: { provider: "postgres", serverMode: true } },
    ...SIGNED_IN,
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
        ...SIGNED_IN,
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
      expect(mockStorage.getFavoriteConnectionIds).toHaveBeenCalled();
      expect(mockStorage.getConnectionOrder).toHaveBeenCalled();
      expect(mockStorage.getConnectionGroups).toHaveBeenCalled();
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
        ...SIGNED_IN,
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
        ...SIGNED_IN,
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

    test("writes favorite_connections to localStorage on pull", async () => {
      localStorage.setItem("libredb_server_migrated", "true");
      setupServerMode({
        "/api/storage": { ok: true, status: 200, json: { favorite_connections: ["fav-1", "fav-2"] } },
      });

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.lastSyncedAt).not.toBeNull();
      });

      const stored = localStorage.getItem("libredb_favorite_connections");
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!)).toEqual(["fav-1", "fav-2"]);
    });

    test("writes connection_order to localStorage on pull", async () => {
      localStorage.setItem("libredb_server_migrated", "true");
      setupServerMode({
        "/api/storage": { ok: true, status: 200, json: { connection_order: ["c2", "c1"] } },
      });

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.lastSyncedAt).not.toBeNull();
      });

      const stored = localStorage.getItem("libredb_connection_order");
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!)).toEqual(["c2", "c1"]);
    });

    test("writes connection_groups to localStorage on pull", async () => {
      localStorage.setItem("libredb_server_migrated", "true");
      const groups = [{ id: "g1", name: "Prod", collapsed: true, connectionIds: ["c1"] }];
      setupServerMode({
        "/api/storage": { ok: true, status: 200, json: { connection_groups: groups } },
      });

      const { result } = renderHook(() => useStorageSync());

      await waitFor(() => {
        expect(result.current.lastSyncedAt).not.toBeNull();
      });

      const stored = localStorage.getItem("libredb_connection_groups");
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!)).toEqual(groups);
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
        ...SIGNED_IN,
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

    /**
     * A push is the ONLY thing that moves a local mutation to the server. Dropping
     * a failed one means the write survives in localStorage and nowhere else —
     * silently, until the user happens to touch that same collection again. The
     * queue must therefore outlive the failure.
     */
    test("retries a collection whose push failed instead of dropping it", async () => {
      localStorage.setItem("libredb_server_migrated", "true");
      let attempts = 0;
      const fetchMock = mockGlobalFetch({
        "/api/storage/config": { ok: true, status: 200, json: { provider: "postgres", serverMode: true } },
        ...SIGNED_IN,
        "/api/storage/migrate": { ok: true, status: 200, json: { ok: true, migrated: [] } },
        "/api/storage/connections": () => {
          attempts += 1;
          return attempts === 1
            ? { ok: false, status: 500, json: { error: "Write failed" } }
            : { ok: true, status: 200, json: { ok: true } };
        },
        "/api/storage": { ok: true, status: 200, json: {} },
      });

      const { result } = renderHook(() => useStorageSync());
      await waitFor(() => {
        expect(result.current.isServerMode).toBe(true);
      });

      act(() => {
        window.dispatchEvent(new CustomEvent("libredb-storage-change", { detail: { collection: "connections" } }));
      });

      await waitFor(
        () => {
          expect(result.current.syncError).not.toBeNull();
        },
        { timeout: 3000 },
      );

      // No further mutation is dispatched: the retry has to come from the hook.
      await waitFor(
        () => {
          expect(attempts).toBeGreaterThanOrEqual(2);
        },
        { timeout: 5000 },
      );
      await waitFor(
        () => {
          expect(result.current.syncError).toBeNull();
        },
        { timeout: 3000 },
      );
      expect(calledPaths(fetchMock).filter((p) => p === "/api/storage/connections").length).toBeGreaterThanOrEqual(2);
    });

    test("stops retrying once the push lands", async () => {
      localStorage.setItem("libredb_server_migrated", "true");
      let attempts = 0;
      mockGlobalFetch({
        "/api/storage/config": { ok: true, status: 200, json: { provider: "postgres", serverMode: true } },
        ...SIGNED_IN,
        "/api/storage/migrate": { ok: true, status: 200, json: { ok: true, migrated: [] } },
        "/api/storage/connections": () => {
          attempts += 1;
          return { ok: true, status: 200, json: { ok: true } };
        },
        "/api/storage": { ok: true, status: 200, json: {} },
      });

      const { result } = renderHook(() => useStorageSync());
      await waitFor(() => {
        expect(result.current.isServerMode).toBe(true);
      });

      act(() => {
        window.dispatchEvent(new CustomEvent("libredb-storage-change", { detail: { collection: "connections" } }));
      });

      await waitFor(
        () => {
          expect(attempts).toBe(1);
        },
        { timeout: 3000 },
      );

      // A successful push empties the queue: nothing schedules a second attempt.
      await act(async () => await new Promise((r) => setTimeout(r, 1600)));
      expect(attempts).toBe(1);
    });

    /**
     * The retry timer and the debounce timer are different clocks.
     *
     * A push takes as long as the network does, and the user keeps working while
     * it is in flight, so when a failure comes back, the debounce slot usually
     * holds a fresh timer for an edit that has nothing to do with it. Sharing one
     * ref meant the retry replaced that timer with its own backoff, and a single
     * failed push held a later, healthy write off the server for as long as the
     * backoff ran.
     *
     * The tell is WHEN that write lands. On its own debounce it goes out ~500ms
     * after the edit; hostage to the backoff it cannot go out before the first
     * retry step, which is a full second after the failure.
     *
     * HOW THAT IS WATCHED, and it is not the wall clock. This used to read
     * `historyAt - editedAt < 800`, two `Date.now()` samples and a budget, which
     * says "the machine got from here to there in under 800ms" and not "the write
     * kept its own debounce": a loaded box that spends 900ms of that window
     * descheduled reports a hook defect that is not there. The reference is now a
     * TIMER this test arms itself, due at 800ms, between the 500ms debounce and
     * the 1000ms first retry step, and the question is only which of the two fired
     * first. Timers fire in deadline order however slow the machine is, so a stall
     * delays both and can never swap them, and the fetch double records the answer
     * synchronously inside the flush the debounce fired, so nothing interleaves.
     *
     * The wait on the reference timer afterwards is the control. Without it,
     * `false` would also be the reading when the timer never ran at all.
     *
     * MEASURED, AND ONE OBVIOUS REFERENCE IS THE WRONG ONE. Comparing the history
     * write against the connections RETRY does not discriminate: the failed
     * collection is requeued, so the debounce flush at +500ms carries connections
     * too and IS connections attempt 2. Both landed at +500ms. Moving this
     * deadline to 200ms makes the test fail with the edit landing at +501ms, which
     * is what proves the 800ms reading is a measurement rather than a formality.
     */
    test("a failed push does not swallow a later edit's debounce", async () => {
      localStorage.setItem("libredb_server_migrated", "true");
      let connectionsAttempts = 0;
      /**
       * True when the history write went out before the reference timer, null until it goes out.
       *
       * Held on an object rather than in a bare `let` so the reads below keep the union: the
       * only assignment is inside the fetch double, and the compiler narrows a `let` that is
       * never assigned in this flow back to `null`, which makes `toBe(true)` a type error
       * rather than a question.
       */
      const race: { historyBeatReference: boolean | null } = { historyBeatReference: null };
      let referencePassed = false;

      mockGlobalFetch({
        "/api/storage/config": { ok: true, status: 200, json: { provider: "postgres", serverMode: true } },
        ...SIGNED_IN,
        "/api/storage/migrate": { ok: true, status: 200, json: { ok: true, migrated: [] } },
        "/api/storage/connections": async () => {
          connectionsAttempts += 1;
          // Long enough that the next edit is dispatched while this is in flight,
          // short enough that it fails BEFORE that edit's own debounce fires.
          await new Promise((r) => setTimeout(r, 100));
          return { ok: false, status: 500, json: { error: "Write failed" } };
        },
        "/api/storage/history": () => {
          race.historyBeatReference = !referencePassed;
          return { ok: true, status: 200, json: { ok: true } };
        },
        "/api/storage": { ok: true, status: 200, json: {} },
      });

      const { result } = renderHook(() => useStorageSync());
      await waitFor(() => {
        expect(result.current.isServerMode).toBe(true);
      });

      act(() => {
        window.dispatchEvent(new CustomEvent("libredb-storage-change", { detail: { collection: "connections" } }));
      });
      // The failing push has STARTED but not resolved: this is the window in which
      // the user's next edit arms the debounce the retry used to steal.
      await waitFor(() => {
        expect(connectionsAttempts).toBe(1);
      });
      // Armed with the edit, so the two deadlines start together.
      const reference = setTimeout(() => {
        referencePassed = true;
      }, 800);
      act(() => {
        window.dispatchEvent(new CustomEvent("libredb-storage-change", { detail: { collection: "history" } }));
      });

      await waitFor(
        () => {
          expect(race.historyBeatReference).not.toBeNull();
        },
        { timeout: 5000 },
      );
      // The control: the reference timer really does fire, so `false` above can only
      // mean the write lost the race and never "the timer was never scheduled".
      await waitFor(
        () => {
          expect(referencePassed).toBe(true);
        },
        { timeout: 5000 },
      );
      clearTimeout(reference);

      expect(race.historyBeatReference).toBe(true);
    });

    /**
     * A push in flight when the user navigates away resolves after teardown. Its
     * failure branch used to arm a retry then — a timer no cleanup could reach,
     * on a hook that no longer exists, backing off to one request every 30s for
     * the life of the page.
     */
    test("a push that fails after unmount does not leave a timer running", async () => {
      localStorage.setItem("libredb_server_migrated", "true");
      let attempts = 0;

      mockGlobalFetch({
        "/api/storage/config": { ok: true, status: 200, json: { provider: "postgres", serverMode: true } },
        ...SIGNED_IN,
        "/api/storage/migrate": { ok: true, status: 200, json: { ok: true, migrated: [] } },
        "/api/storage/connections": async () => {
          attempts += 1;
          await new Promise((r) => setTimeout(r, 150));
          return { ok: false, status: 500, json: { error: "Write failed" } };
        },
        "/api/storage": { ok: true, status: 200, json: {} },
      });

      const { result, unmount } = renderHook(() => useStorageSync());
      await waitFor(() => {
        expect(result.current.isServerMode).toBe(true);
      });

      act(() => {
        window.dispatchEvent(new CustomEvent("libredb-storage-change", { detail: { collection: "connections" } }));
      });
      await waitFor(() => {
        expect(attempts).toBe(1);
      });

      unmount();

      // Past the first backoff step (1s) with room to spare: a re-armed retry
      // would have fired by now.
      await new Promise((r) => setTimeout(r, 2000));
      expect(attempts).toBe(1);
    });

    test("sets syncError on push failure", async () => {
      localStorage.setItem("libredb_server_migrated", "true");

      // Use a request handler that returns 500 specifically for PUT /connections
      const fetchMock = mockGlobalFetch({
        "/api/storage/config": { ok: true, status: 200, json: { provider: "postgres", serverMode: true } },
        ...SIGNED_IN,
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

  // ── The browser copy belongs to the signed-in account ─────────────────

  describe("the browser copy belongs to the signed-in account", () => {
    const PREVIOUS = "admin@libredb.org";
    const FORM_CONNECTION = { id: "form-1", name: "Warehouse", password: "previous-account-password" };

    /** The previous account's browser copy, as a sign-in on this browser finds it. */
    function seedPreviousCopy(owner: string | null, migrated: boolean) {
      localStorage.setItem("libredb_connections", JSON.stringify([FORM_CONNECTION]));
      localStorage.setItem("libredb_history", JSON.stringify([{ id: "h1", query: "SELECT 1" }]));
      localStorage.setItem("libredb_active_connection_id", FORM_CONNECTION.id);
      localStorage.setItem(workspaceTabsKey(FORM_CONNECTION.id), JSON.stringify([{ id: "t1", query: "SELECT 2" }]));
      if (owner !== null) localStorage.setItem("libredb_workspace_owner", owner);
      if (migrated) localStorage.setItem("libredb_server_migrated", "2026-10-01");
    }

    /** Every request body the hook sent: PUT /api/storage/* and POST /api/storage/migrate. */
    function sentBodies(fetchMock: FetchMock): string[] {
      return (fetchMock.mock.calls as unknown[][])
        .map((c) => (c[1] as RequestInit | undefined)?.body)
        .filter((body): body is string => typeof body === "string");
    }

    beforeEach(() => {
      // The facade reads the browser copy itself, so a push carries exactly what is stored.
      mockStorage.getConnections.mockImplementation(() =>
        JSON.parse(localStorage.getItem("libredb_connections") ?? "[]"),
      );
    });

    afterEach(() => {
      mockStorage.getConnections.mockImplementation(() => [{ id: "c1" }]);
    });

    test("signing in as a different account starts from that account's server data", async () => {
      seedPreviousCopy(PREVIOUS, true);
      const fetchMock = setupServerMode({ "/api/storage": { ok: true, status: 200, json: {} } });

      const { result } = renderHook(() => useStorageSync());
      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      expect(localStorage.getItem("libredb_connections")).toBeNull();
      expect(localStorage.getItem("libredb_history")).toBeNull();
      expect(localStorage.getItem("libredb_active_connection_id")).toBeNull();
      expect(localStorage.getItem(workspaceTabsKey(FORM_CONNECTION.id))).toBeNull();
      expect(localStorage.getItem("libredb_workspace_owner")).toBe(USERNAME);
      expect(calledPaths(fetchMock)).not.toContain("/api/storage/migrate");

      // A change after the sign-in pushes this account's copy, never the previous one.
      act(() => {
        window.dispatchEvent(new CustomEvent("libredb-storage-change", { detail: { collection: "connections" } }));
      });
      await waitFor(
        () => {
          expect(calledPaths(fetchMock)).toContain("/api/storage/connections");
        },
        { timeout: 3000 },
      );
      expect(sentBodies(fetchMock).some((body) => body.includes(FORM_CONNECTION.password))).toBe(false);
    });

    test("a copy with no owner that was already handed to a server account is cleared", async () => {
      seedPreviousCopy(null, true);
      const fetchMock = setupServerMode({ "/api/storage": { ok: true, status: 200, json: {} } });

      const { result } = renderHook(() => useStorageSync());
      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      expect(localStorage.getItem("libredb_connections")).toBeNull();
      expect(localStorage.getItem("libredb_history")).toBeNull();
      expect(localStorage.getItem("libredb_active_connection_id")).toBeNull();
      expect(localStorage.getItem(workspaceTabsKey(FORM_CONNECTION.id))).toBeNull();
      expect(localStorage.getItem("libredb_workspace_owner")).toBe(USERNAME);
      expect(sentBodies(fetchMock).some((body) => body.includes(FORM_CONNECTION.password))).toBe(false);
    });

    test("a local-mode copy never handed to a server account is migrated into the signed-in account", async () => {
      seedPreviousCopy(null, false);
      const fetchMock = setupServerMode({ "/api/storage": { ok: true, status: 200, json: {} } });

      const { result } = renderHook(() => useStorageSync());
      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      expect(calledPaths(fetchMock)).toContain("/api/storage/migrate");
      expect(sentBodies(fetchMock).some((body) => body.includes(FORM_CONNECTION.id))).toBe(true);
      expect(JSON.parse(localStorage.getItem("libredb_connections")!)).toEqual([FORM_CONNECTION]);
      expect(localStorage.getItem(workspaceTabsKey(FORM_CONNECTION.id))).not.toBeNull();
      expect(localStorage.getItem("libredb_workspace_owner")).toBe(USERNAME);
    });

    test("the same account keeps its copy, and a collection the server lacks stays local", async () => {
      seedPreviousCopy(USERNAME, true);
      const fetchMock = setupServerMode({
        "/api/storage": { ok: true, status: 200, json: { history: [{ id: "server-h1", query: "SELECT 3" }] } },
      });

      const { result } = renderHook(() => useStorageSync());
      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      expect(JSON.parse(localStorage.getItem("libredb_connections")!)).toEqual([FORM_CONNECTION]);
      expect(JSON.parse(localStorage.getItem("libredb_history")!)).toEqual([{ id: "server-h1", query: "SELECT 3" }]);
      expect(localStorage.getItem("libredb_active_connection_id")).toBe(FORM_CONNECTION.id);
      expect(localStorage.getItem(workspaceTabsKey(FORM_CONNECTION.id))).not.toBeNull();
      expect(localStorage.getItem("libredb_workspace_owner")).toBe(USERNAME);
      expect(calledPaths(fetchMock)).not.toContain("/api/storage/migrate");
    });

    test("an unreadable signed-in account leaves the copy unused and unpushed", async () => {
      seedPreviousCopy(PREVIOUS, true);
      const fetchMock = mockGlobalFetch({
        "/api/storage/config": { ok: true, status: 200, json: { provider: "postgres", serverMode: true } },
        "/api/auth/me": { ok: false, status: 503, json: { error: "down" } },
        "/api/storage": { ok: true, status: 200, json: {} },
      });

      const { result } = renderHook(() => useStorageSync());
      await waitFor(() => {
        expect(result.current.syncError).not.toBeNull();
      });

      act(() => {
        window.dispatchEvent(new CustomEvent("libredb-storage-change", { detail: { collection: "connections" } }));
      });
      await act(async () => await new Promise((r) => setTimeout(r, 700)));

      expect(result.current.isReady).toBe(false);
      expect(result.current.isServerMode).toBe(false);
      expect(
        calledPaths(fetchMock).filter((p) => p.startsWith("/api/storage/") && p !== "/api/storage/config"),
      ).toEqual([]);
      expect(calledPaths(fetchMock)).not.toContain("/api/storage");
      expect(localStorage.getItem("libredb_workspace_owner")).toBe(PREVIOUS);
    });

    test("a signed-in answer without a username counts as unreadable", async () => {
      seedPreviousCopy(PREVIOUS, true);
      mockGlobalFetch({
        "/api/storage/config": { ok: true, status: 200, json: { provider: "postgres", serverMode: true } },
        "/api/auth/me": { ok: true, status: 200, json: { authenticated: true, user: {} } },
        "/api/storage": { ok: true, status: 200, json: {} },
      });

      const { result } = renderHook(() => useStorageSync());
      await waitFor(() => {
        expect(result.current.syncError).not.toBeNull();
      });
      expect(result.current.isReady).toBe(false);
    });

    test("local mode clears nothing and records no owner", async () => {
      seedPreviousCopy(PREVIOUS, true);
      setupLocalMode();

      const { result } = renderHook(() => useStorageSync());
      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      expect(JSON.parse(localStorage.getItem("libredb_connections")!)).toEqual([FORM_CONNECTION]);
      expect(localStorage.getItem(workspaceTabsKey(FORM_CONNECTION.id))).not.toBeNull();
      expect(localStorage.getItem("libredb_workspace_owner")).toBe(PREVIOUS);
    });

    test("local mode on a fresh browser writes no owner", async () => {
      setupLocalMode();

      const { result } = renderHook(() => useStorageSync());
      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      expect(localStorage.getItem("libredb_workspace_owner")).toBeNull();
    });
  });

  // ── Sign-out ──────────────────────────────────────────────────────────

  describe("sign-out", () => {
    /** Server mode with the collection routes ahead of the catch-all `/api/storage` pull. */
    function setupSignOut(collectionRoutes: Parameters<typeof mockGlobalFetch>[0]) {
      return mockGlobalFetch({
        "/api/storage/config": { ok: true, status: 200, json: { provider: "postgres", serverMode: true } },
        ...SIGNED_IN,
        ...collectionRoutes,
      });
    }

    test("pushes a pending change before the browser copy is cleared", async () => {
      localStorage.setItem("libredb_workspace_owner", USERNAME);
      localStorage.setItem("libredb_server_migrated", "2026-10-01");
      const order: string[] = [];
      setupSignOut({
        "/api/storage/history": () => {
          order.push(`push:${localStorage.getItem("libredb_workspace_owner")}`);
          return { ok: true, status: 200, json: { ok: true } };
        },
        "/api/storage": { ok: true, status: 200, json: {} },
      });

      const { result } = renderHook(() => useStorageSync());
      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      act(() => {
        window.dispatchEvent(new CustomEvent("libredb-storage-change", { detail: { collection: "history" } }));
      });
      // Inside the debounce window: the push is still pending when the sign-out starts.
      await act(async () => {
        await releaseAccountWorkspace();
      });
      order.push(`cleared:${localStorage.getItem("libredb_workspace_owner")}`);

      expect(order).toEqual([`push:${USERNAME}`, "cleared:null"]);
    });

    test("waits for a push already in flight before the browser copy is cleared", async () => {
      localStorage.setItem("libredb_workspace_owner", USERNAME);
      localStorage.setItem("libredb_server_migrated", "2026-10-01");
      let started = false;
      let landed = false;
      setupSignOut({
        "/api/storage/history": async () => {
          started = true;
          await new Promise((r) => setTimeout(r, 150));
          landed = true;
          return { ok: true, status: 200, json: { ok: true } };
        },
        "/api/storage": { ok: true, status: 200, json: {} },
      });

      const { result } = renderHook(() => useStorageSync());
      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      act(() => {
        window.dispatchEvent(new CustomEvent("libredb-storage-change", { detail: { collection: "history" } }));
      });
      await waitFor(() => {
        expect(started).toBe(true);
      });
      await act(async () => {
        await releaseAccountWorkspace();
      });

      expect(landed).toBe(true);
      expect(localStorage.getItem("libredb_workspace_owner")).toBeNull();
    });

    test("a pending push that does not land fails the sign-out and keeps the copy", async () => {
      localStorage.setItem("libredb_workspace_owner", USERNAME);
      localStorage.setItem("libredb_server_migrated", "2026-10-01");
      setupSignOut({
        "/api/storage/history": { ok: false, status: 500, json: { error: "Write failed" } },
        "/api/storage": { ok: true, status: 200, json: {} },
      });

      const { result } = renderHook(() => useStorageSync());
      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      act(() => {
        window.dispatchEvent(new CustomEvent("libredb-storage-change", { detail: { collection: "history" } }));
      });
      let failure: unknown = null;
      await act(async () => {
        await releaseAccountWorkspace().catch((err: unknown) => {
          failure = err;
        });
      });

      expect(failure).toBeInstanceOf(Error);
      expect(localStorage.getItem("libredb_workspace_owner")).toBe(USERNAME);
    });

    test("pushes nothing after the browser copy is cleared", async () => {
      localStorage.setItem("libredb_workspace_owner", USERNAME);
      localStorage.setItem("libredb_server_migrated", "2026-10-01");
      const fetchMock = setupServerMode({ "/api/storage": { ok: true, status: 200, json: {} } });

      const { result } = renderHook(() => useStorageSync());
      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      await act(async () => {
        await releaseAccountWorkspace();
      });
      act(() => {
        window.dispatchEvent(new CustomEvent("libredb-storage-change", { detail: { collection: "connections" } }));
      });
      await act(async () => await new Promise((r) => setTimeout(r, 700)));

      expect(calledPaths(fetchMock)).not.toContain("/api/storage/connections");
    });
  });
});
