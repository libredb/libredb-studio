import "../setup-dom";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
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
