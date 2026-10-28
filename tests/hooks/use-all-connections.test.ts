import "../setup-dom";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { renderHook, waitFor, act } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";

import { useAllConnections } from "@/hooks/use-all-connections";
import { storage } from "@/lib/storage";
import type { DatabaseConnection } from "@/lib/types";

// ── Test Data ───────────────────────────────────────────────────────────────

const makeConnection = (overrides: Partial<DatabaseConnection> = {}): DatabaseConnection => ({
  id: "conn-1",
  name: "Test DB",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "testdb",
  user: "admin",
  password: "secret",
  createdAt: new Date("2026-01-01"),
  ...overrides,
});

/** Managed connection as returned by the API (createdAt serialized as string) */
const makeManagedConnection = (overrides: Record<string, unknown> = {}) => ({
  id: "managed-1",
  name: "Managed DB",
  type: "postgres",
  host: "db.internal",
  port: 5432,
  database: "proddb",
  createdAt: "2026-02-01T00:00:00.000Z",
  managed: true,
  ...overrides,
});

// =============================================================================
// useAllConnections Tests
// =============================================================================
describe("useAllConnections", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  // ── Empty state ─────────────────────────────────────────────────────────

  test("returns empty list when no user or managed connections exist", async () => {
    mockGlobalFetch({
      "/api/connections/managed": { json: { connections: [] } },
    });

    const { result } = renderHook(() => useAllConnections());

    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.connections).toEqual([]);
  });

  // ── Fallback to user connections ────────────────────────────────────────

  test("returns user connections when managed list is empty", async () => {
    storage.saveConnection(makeConnection());

    mockGlobalFetch({
      "/api/connections/managed": { json: { connections: [] } },
    });

    const { result } = renderHook(() => useAllConnections());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.connections.length).toBe(1);
    expect(result.current.connections[0].id).toBe("conn-1");
  });

  test("returns user connections when managed response has no connections field", async () => {
    storage.saveConnection(makeConnection());

    mockGlobalFetch({
      "/api/connections/managed": { json: {} },
    });

    const { result } = renderHook(() => useAllConnections());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.connections.length).toBe(1);
  });

  test("returns user connections when managed fetch responds non-ok", async () => {
    storage.saveConnection(makeConnection());

    mockGlobalFetch({
      "/api/connections/managed": { status: 500, json: { error: "Internal error" } },
    });

    const { result } = renderHook(() => useAllConnections());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.connections.length).toBe(1);
    expect(result.current.connections[0].id).toBe("conn-1");
  });

  test("returns user connections when managed fetch throws", async () => {
    storage.saveConnection(makeConnection());

    mockGlobalFetch({
      "/api/connections/managed": () => {
        throw new Error("network down");
      },
    });

    const { result } = renderHook(() => useAllConnections());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.connections.length).toBe(1);
    expect(result.current.connections[0].id).toBe("conn-1");
  });

  // ── Merge behaviour ─────────────────────────────────────────────────────

  test("merges managed connections first and converts createdAt to Date", async () => {
    storage.saveConnection(makeConnection({ id: "user-1", name: "User DB" }));

    mockGlobalFetch({
      "/api/connections/managed": { json: { connections: [makeManagedConnection()] } },
    });

    const { result } = renderHook(() => useAllConnections());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.connections.length).toBe(2);
    expect(result.current.connections[0].id).toBe("managed-1");
    expect(result.current.connections[0].createdAt).toBeInstanceOf(Date);
    expect(result.current.connections[1].id).toBe("user-1");
  });

  test("skips user connections duplicated by id", async () => {
    storage.saveConnection(makeConnection({ id: "managed-1", name: "Stale local copy" }));

    mockGlobalFetch({
      "/api/connections/managed": { json: { connections: [makeManagedConnection()] } },
    });

    const { result } = renderHook(() => useAllConnections());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.connections.length).toBe(1);
    expect(result.current.connections[0].name).toBe("Managed DB");
  });

  test("skips user connections whose seedId matches a managed seed", async () => {
    storage.saveConnection(makeConnection({ id: "user-seeded", seedId: "seed-1" }));

    mockGlobalFetch({
      "/api/connections/managed": {
        json: { connections: [makeManagedConnection({ id: "managed-seed", seedId: "seed-1" })] },
      },
    });

    const { result } = renderHook(() => useAllConnections());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.connections.length).toBe(1);
    expect(result.current.connections[0].id).toBe("managed-seed");
  });

  test("skips dismissed unmanaged seed connections", async () => {
    // Dismiss seed-1 via the real storage flow: delete a seeded user connection
    storage.saveConnection(makeConnection({ id: "seeded-conn", seedId: "seed-1" }));
    storage.deleteConnection("seeded-conn");

    mockGlobalFetch({
      "/api/connections/managed": {
        json: {
          connections: [
            makeManagedConnection({ id: "seed-a", managed: false, seedId: "seed-1" }),
            makeManagedConnection({ id: "seed-b", managed: false, seedId: "seed-2" }),
          ],
        },
      },
    });

    const { result } = renderHook(() => useAllConnections());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.connections.length).toBe(1);
    expect(result.current.connections[0].id).toBe("seed-b");
  });

  test("keeps managed connections even when their seedId is dismissed", async () => {
    storage.saveConnection(makeConnection({ id: "seeded-conn", seedId: "seed-1" }));
    storage.deleteConnection("seeded-conn");

    mockGlobalFetch({
      "/api/connections/managed": {
        json: { connections: [makeManagedConnection({ id: "managed-seed", managed: true, seedId: "seed-1" })] },
      },
    });

    const { result } = renderHook(() => useAllConnections());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.connections.length).toBe(1);
    expect(result.current.connections[0].id).toBe("managed-seed");
  });

  // ── Cancellation on unmount ─────────────────────────────────────────────

  test("does not update state when unmounted before fetch resolves", async () => {
    mockGlobalFetch({
      "/api/connections/managed": async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { json: { connections: [makeManagedConnection()] } };
      },
    });

    const { result, unmount } = renderHook(() => useAllConnections());

    expect(result.current.loading).toBe(true);
    unmount();

    // Let the pending fetch settle after unmount
    await new Promise((resolve) => setTimeout(resolve, 100));

    // State was never updated after cancellation
    expect(result.current.loading).toBe(true);
    expect(result.current.connections).toEqual([]);
  });
});

describe("useAllConnections under the custom connections policy", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  test("leaves out the user's own connections when the server refuses custom connections", async () => {
    storage.saveConnection(makeConnection({ id: "own-1", name: "Own" }));
    storage.saveConnection(
      makeConnection({ id: "seed:sandbox", seedId: "sandbox", name: "Sandbox copy", managed: false }),
    );
    mockGlobalFetch({
      "/api/connections/policy": { json: { customConnections: false } },
      "/api/connections/managed": {
        json: { connections: [makeManagedConnection({ id: "seed:orders", seedId: "orders" })] },
      },
    });

    const { result } = renderHook(() => useAllConnections());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.connections.map((c) => c.id)).toEqual(["seed:orders", "seed:sandbox"]);
  });

  test("leaves them out of the list it falls back to when the managed list cannot be read", async () => {
    storage.saveConnection(makeConnection({ id: "own-1", name: "Own" }));
    storage.saveConnection(
      makeConnection({ id: "seed:sandbox", seedId: "sandbox", name: "Sandbox copy", managed: false }),
    );
    mockGlobalFetch({
      "/api/connections/policy": { json: { customConnections: false } },
      "/api/connections/managed": { status: 500, json: { error: "Internal error" } },
    });

    const { result } = renderHook(() => useAllConnections());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.connections.map((c) => c.id)).toEqual(["seed:sandbox"]);
  });
});

// ── Managed connection refresh (#2020) ─────────────────────────────────────

describe("useAllConnections managed refresh", () => {
  const firstManaged = () =>
    makeManagedConnection({ id: "managed-1", managed: true, seedId: "seed-1", name: "First DB" });
  const secondManaged = () =>
    makeManagedConnection({ id: "managed-2", managed: true, seedId: "seed-2", name: "Second DB" });

  const managedCallCount = (fetchMock: ReturnType<typeof mockGlobalFetch>) =>
    fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/connections/managed")).length;

  const focusWindow = () => {
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
  };

  const announceVisibility = () => {
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  };

  /** happy-dom always reports "visible"; an own accessor shadows its prototype getter until removed. */
  const setVisibility = (state: DocumentVisibilityState) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  };

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    restoreGlobalFetch();
    delete process.env.NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS;
    Reflect.deleteProperty(document, "visibilityState");
  });

  test("a discovered connection appears when the window regains focus", async () => {
    process.env.NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS = "60000";
    let managedCalls = 0;
    mockGlobalFetch({
      "/api/connections/managed": () => {
        managedCalls += 1;
        return {
          ok: true,
          json: { connections: managedCalls === 1 ? [firstManaged()] : [firstManaged(), secondManaged()] },
        };
      },
    });

    const { result } = renderHook(() => useAllConnections());
    await waitFor(() => {
      expect(result.current.connections.map((c) => c.id)).toEqual(["managed-1"]);
    });

    focusWindow();
    await waitFor(() => {
      expect(result.current.connections.map((c) => c.id)).toEqual(["managed-1", "managed-2"]);
    });
  });

  test("a withdrawn connection disappears on the interval, with no event at all", async () => {
    process.env.NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS = "25";
    let managedCalls = 0;
    mockGlobalFetch({
      "/api/connections/managed": () => {
        managedCalls += 1;
        return {
          ok: true,
          json: { connections: managedCalls === 1 ? [firstManaged(), secondManaged()] : [firstManaged()] },
        };
      },
    });

    const { result } = renderHook(() => useAllConnections());
    // The initial answer holds both rows and the second withdraws one, so waiting for the
    // second answer (not for an intermediate state) avoids racing the 25 ms interval.
    await waitFor(
      () => {
        expect(managedCalls).toBeGreaterThanOrEqual(2);
      },
      { timeout: 5000 },
    );
    await waitFor(
      () => {
        expect(result.current.connections.map((c) => c.id)).toEqual(["managed-1"]);
      },
      { timeout: 5000 },
    );
    // The first answer did hold both rows: the list the hook first published.
    expect(result.current.loading).toBe(false);
  });

  test("a transient refresh failure keeps the last list", async () => {
    process.env.NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS = "60000";
    let managedCalls = 0;
    mockGlobalFetch({
      "/api/connections/managed": () => {
        managedCalls += 1;
        return managedCalls === 1
          ? { ok: true, json: { connections: [firstManaged()] } }
          : { status: 500, json: { error: "Internal error" } };
      },
    });

    const { result } = renderHook(() => useAllConnections());
    await waitFor(() => {
      expect(result.current.connections.map((c) => c.id)).toEqual(["managed-1"]);
    });

    focusWindow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(result.current.connections.map((c) => c.id)).toEqual(["managed-1"]);
  });

  test("the document becoming visible refreshes at once, and becoming hidden does not", async () => {
    process.env.NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS = "60000";
    let managedCalls = 0;
    const fetchMock = mockGlobalFetch({
      "/api/connections/managed": () => {
        managedCalls += 1;
        return {
          ok: true,
          json: { connections: managedCalls === 1 ? [firstManaged()] : [firstManaged(), secondManaged()] },
        };
      },
    });

    const { result } = renderHook(() => useAllConnections());
    await waitFor(() => {
      expect(result.current.connections.map((c) => c.id)).toEqual(["managed-1"]);
    });

    setVisibility("hidden");
    announceVisibility();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(managedCallCount(fetchMock)).toBe(1);

    setVisibility("visible");
    announceVisibility();
    await waitFor(() => {
      expect(result.current.connections.map((c) => c.id)).toEqual(["managed-1", "managed-2"]);
    });
  });

  test("an empty managed response withdraws the managed rows and keeps the user's own", async () => {
    process.env.NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS = "60000";
    storage.saveConnection(makeConnection({ id: "plain-1", name: "Plain" }));
    let managedCalls = 0;
    mockGlobalFetch({
      "/api/connections/managed": () => {
        managedCalls += 1;
        return { ok: true, json: { connections: managedCalls === 1 ? [firstManaged()] : [] } };
      },
    });

    const { result } = renderHook(() => useAllConnections());
    await waitFor(() => {
      expect(result.current.connections.map((c) => c.id)).toEqual(["managed-1", "plain-1"]);
    });

    focusWindow();
    await waitFor(() => {
      expect(result.current.connections.map((c) => c.id)).toEqual(["plain-1"]);
    });
    expect(managedCalls).toBe(2);
  });

  test("a refresh that repeats the same rows keeps the list's object identity", async () => {
    process.env.NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS = "60000";
    let managedCalls = 0;
    mockGlobalFetch({
      "/api/connections/managed": () => {
        managedCalls += 1;
        // The projection the route really answers with: a fresh createdAt and a fresh
        // roles array on every read, so shallow or timestamp-based comparison must fail.
        return {
          ok: true,
          json: {
            connections: [
              makeManagedConnection({
                id: "managed-1",
                managed: true,
                seedId: "seed-1",
                name: "First DB",
                roles: ["admin"],
                createdAt: new Date(`2026-03-0${managedCalls}T00:00:00.000Z`).toISOString(),
              }),
            ],
          },
        };
      },
    });

    const { result } = renderHook(() => useAllConnections());
    await waitFor(() => {
      expect(result.current.connections.map((c) => c.id)).toEqual(["managed-1"]);
    });
    const listAfterFirstLoad = result.current.connections;

    focusWindow();
    await waitFor(() => {
      expect(managedCalls).toBe(2);
    });
    expect(result.current.connections).toBe(listAfterFirstLoad);
  });

  test("a row keeps its identity when another connection is added or withdrawn", async () => {
    process.env.NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS = "60000";
    let managedCalls = 0;
    const managedRow = () =>
      makeManagedConnection({
        id: "managed-1",
        managed: true,
        seedId: "seed-1",
        name: "First DB",
        roles: ["admin"],
        createdAt: new Date().toISOString(),
      });
    mockGlobalFetch({
      "/api/connections/managed": () => {
        managedCalls += 1;
        return {
          ok: true,
          json: { connections: managedCalls === 1 ? [managedRow()] : [managedRow(), secondManaged()] },
        };
      },
    });

    const { result } = renderHook(() => useAllConnections());
    await waitFor(() => {
      expect(result.current.connections.map((c) => c.id)).toEqual(["managed-1"]);
    });
    const firstRowAfterLoad = result.current.connections[0];

    focusWindow();
    await waitFor(() => {
      expect(result.current.connections.map((c) => c.id)).toEqual(["managed-1", "managed-2"]);
    });
    expect(result.current.connections[0]).toBe(firstRowAfterLoad);
  });

  test("a nested settings object keeps the row's identity when it is carried unchanged", async () => {
    process.env.NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS = "60000";
    let managedCalls = 0;
    mockGlobalFetch({
      "/api/connections/managed": () => {
        managedCalls += 1;
        return {
          ok: true,
          json: {
            connections: [
              makeManagedConnection({
                id: "managed-1",
                managed: true,
                seedId: "seed-1",
                name: "Secure DB",
                roles: ["admin"],
                ssl: { rejectUnauthorized: true, ca: "cert-data" },
              }),
            ],
          },
        };
      },
    });

    const { result } = renderHook(() => useAllConnections());
    await waitFor(() => {
      expect(result.current.connections.map((c) => c.id)).toEqual(["managed-1"]);
    });
    const listAfterFirstLoad = result.current.connections;

    focusWindow();
    await waitFor(() => {
      expect(managedCalls).toBe(2);
    });
    // The fresh answer carries a fresh ssl object with the same fields, and the row
    // keeps its identity because the comparison reads objects field by field.
    expect(result.current.connections).toBe(listAfterFirstLoad);
  });

  test("a same-id row whose fields changed gets a new object", async () => {
    process.env.NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS = "60000";
    let managedCalls = 0;
    mockGlobalFetch({
      "/api/connections/managed": () => {
        managedCalls += 1;
        return {
          ok: true,
          json: {
            connections: [
              makeManagedConnection({
                id: "managed-1",
                managed: true,
                seedId: "seed-1",
                name: managedCalls === 1 ? "First DB" : "Renamed DB",
                roles: ["admin"],
              }),
            ],
          },
        };
      },
    });

    const { result } = renderHook(() => useAllConnections());
    await waitFor(() => {
      expect(result.current.connections.map((c) => c.name)).toEqual(["First DB"]);
    });
    const rowAfterLoad = result.current.connections[0];

    focusWindow();
    await waitFor(() => {
      expect(result.current.connections.map((c) => c.name)).toEqual(["Renamed DB"]);
    });
    expect(result.current.connections[0]).not.toBe(rowAfterLoad);
  });

  test("a failed refresh keeps the list, and the next one updates it", async () => {
    process.env.NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS = "60000";
    let managedCalls = 0;
    mockGlobalFetch({
      "/api/connections/managed": () => {
        managedCalls += 1;
        if (managedCalls === 2) return { status: 500, json: { error: "Internal error" } };
        return {
          ok: true,
          json: { connections: managedCalls === 1 ? [firstManaged()] : [firstManaged(), secondManaged()] },
        };
      },
    });

    const { result } = renderHook(() => useAllConnections());
    await waitFor(() => {
      expect(result.current.connections.map((c) => c.id)).toEqual(["managed-1"]);
    });

    focusWindow();
    await waitFor(() => {
      expect(managedCalls).toBe(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(result.current.connections.map((c) => c.id)).toEqual(["managed-1"]);

    focusWindow();
    await waitFor(() => {
      expect(result.current.connections.map((c) => c.id)).toEqual(["managed-1", "managed-2"]);
    });
  });

  test("an in-flight refresh absorbs further triggers", async () => {
    process.env.NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS = "60000";
    let managedCalls = 0;
    let releaseSecond: (() => void) | undefined;
    mockGlobalFetch({
      "/api/connections/managed": () => {
        managedCalls += 1;
        if (managedCalls === 1) return { ok: true, json: { connections: [firstManaged()] } };
        return new Promise((resolve) => {
          releaseSecond = () => resolve({ ok: true, json: { connections: [firstManaged(), secondManaged()] } });
        });
      },
    });

    const { result } = renderHook(() => useAllConnections());
    await waitFor(() => {
      expect(result.current.connections.map((c) => c.id)).toEqual(["managed-1"]);
    });

    focusWindow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    focusWindow();
    announceVisibility();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(managedCalls).toBe(2);

    releaseSecond?.();
    await waitFor(() => {
      expect(result.current.connections.map((c) => c.id)).toEqual(["managed-1", "managed-2"]);
    });
  });

  test("unmount stops the refresh: no further fetches after the listeners are gone", async () => {
    // A 25 ms floor proves the timer itself is cleaned up: an uncleaned interval would
    // fire several times inside the wait below, listener events aside.
    process.env.NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS = "25";
    const fetchMock = mockGlobalFetch({
      "/api/connections/managed": { ok: true, json: { connections: [firstManaged()] } },
    });

    const { result, unmount } = renderHook(() => useAllConnections());
    await waitFor(() => {
      expect(result.current.connections.map((c) => c.id)).toEqual(["managed-1"]);
    });
    // Let at least one interval refresh run while mounted, so the timer really started.
    await waitFor(() => {
      expect(managedCallCount(fetchMock)).toBeGreaterThanOrEqual(2);
    });

    unmount();
    const callsWhenUnmounted = managedCallCount(fetchMock);
    focusWindow();
    announceVisibility();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(managedCallCount(fetchMock)).toBe(callsWhenUnmounted);
  });
});
