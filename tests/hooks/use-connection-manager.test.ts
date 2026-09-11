import "../setup-dom";
import { mockToastSuccess, mockToastError } from "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";

import { useConnectionManager } from "@/hooks/use-connection-manager";
import type { ManagedConnectionPayload } from "@/hooks/use-connection-payload";
import { logger } from "@/lib/logger";
import { storage } from "@/lib/storage";
import type { DatabaseConnection, TableSchema } from "@/lib/types";
import { rowWritableObjects } from "@/lib/db/detailed-object";
import type { ProviderCapabilities } from "@/lib/db/types";

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

const makeSchema = (): TableSchema[] => [
  {
    name: "users",
    columns: [
      { name: "id", type: "integer", nullable: false, isPrimary: true },
      { name: "email", type: "varchar", nullable: false, isPrimary: false },
    ],
    indexes: [{ name: "users_pkey", columns: ["id"], unique: true }],
    rowCount: 100,
  },
  {
    name: "orders",
    columns: [
      { name: "id", type: "integer", nullable: false, isPrimary: true },
      { name: "user_id", type: "integer", nullable: false, isPrimary: false },
    ],
    indexes: [{ name: "orders_pkey", columns: ["id"], unique: true }],
    rowCount: 500,
  },
];

// =============================================================================
// useConnectionManager Tests
// =============================================================================
describe("useConnectionManager", () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    localStorage.clear();
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  // ── Initial State ─────────────────────────────────────────────────────────

  test("starts with empty connections and null activeConnection", () => {
    mockGlobalFetch({});

    const { result } = renderHook(() => useConnectionManager(true));

    expect(result.current.connections).toEqual([]);
    expect(result.current.activeConnection).toBeNull();
    expect(result.current.schema).toEqual([]);
    expect(result.current.isLoadingSchema).toBe(false);
    expect(result.current.connectionPulse).toBeNull();
  });

  // ── Load from localStorage ────────────────────────────────────────────────

  test("loads connections from localStorage on mount", async () => {
    const conn = makeConnection();
    storage.saveConnection(conn);

    mockGlobalFetch({
      "/api/db/health": { ok: true, json: { status: "healthy" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => {
      expect(result.current.connections.length).toBe(1);
    });

    expect(result.current.connections[0].id).toBe("conn-1");
    expect(result.current.connections[0].name).toBe("Test DB");
  });

  // ── Active Connection from Persisted ID ───────────────────────────────────

  test("sets activeConnection from persisted active ID", async () => {
    const conn1 = makeConnection({ id: "conn-1", name: "DB One" });
    const conn2 = makeConnection({ id: "conn-2", name: "DB Two" });
    storage.saveConnection(conn1);
    storage.saveConnection(conn2);
    storage.setActiveConnectionId("conn-2");

    mockGlobalFetch({
      "/api/db/health": { ok: true, json: { status: "healthy" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => {
      expect(result.current.activeConnection).not.toBeNull();
    });

    expect(result.current.activeConnection!.id).toBe("conn-2");
    expect(result.current.activeConnection!.name).toBe("DB Two");
  });

  // ── First Connection as Fallback ──────────────────────────────────────────

  test("sets first connection as active if no persisted ID", async () => {
    const conn1 = makeConnection({ id: "conn-1", name: "DB One" });
    const conn2 = makeConnection({ id: "conn-2", name: "DB Two" });
    storage.saveConnection(conn1);
    storage.saveConnection(conn2);
    // No setActiveConnectionId call — no persisted ID

    mockGlobalFetch({
      "/api/db/health": { ok: true, json: { status: "healthy" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => {
      expect(result.current.activeConnection).not.toBeNull();
    });

    expect(result.current.activeConnection!.id).toBe("conn-1");
  });

  // ── fetchSchema success ───────────────────────────────────────────────────

  test("fetchSchema calls /api/db/schema POST and sets schema", async () => {
    const schemaData = makeSchema();

    const fetchMock = mockGlobalFetch({
      "/api/db/schema": { ok: true, json: schemaData },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    const conn = makeConnection();
    await act(async () => {
      await result.current.fetchSchema(conn);
    });

    expect(result.current.schema).toEqual(schemaData);
    expect(result.current.isLoadingSchema).toBe(false);

    // Verify fetch was called with POST and connection body
    const schemaCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/schema"),
    );
    expect(schemaCall).toBeDefined();
    expect(schemaCall![1]?.method).toBe("POST");
  });

  // ── fetchSchema error ─────────────────────────────────────────────────────

  test("fetchSchema shows toast on error", async () => {
    mockGlobalFetch({
      "/api/db/schema": { ok: false, status: 500, json: { error: "Connection refused" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    const conn = makeConnection();
    await act(async () => {
      await result.current.fetchSchema(conn);
    });

    expect(result.current.schema).toEqual([]);
    expect(result.current.isLoadingSchema).toBe(false);

    // useToast calls sonnerToast.error for destructive variant
    expect(mockToastError).toHaveBeenCalledWith("Schema Error", { description: "Connection refused" });
  });

  // A failing read must not leave the PREVIOUS connection's tables on screen (D31).
  // The assertion above is vacuous on its own — `schema` starts empty — so this one
  // loads a schema first and then fails the next read, which is the measured sequence.
  test("a failed read clears the schema loaded for the previous connection", async () => {
    mockGlobalFetch({
      "/api/db/schema/list": { ok: true, json: makeSchema() },
      "/api/db/schema/relations": { ok: false, status: 500, json: {} },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });
    expect(result.current.schema.map((t) => t.name)).toEqual(["users", "orders"]);
    expect(result.current.schemaError).toBeNull();

    restoreGlobalFetch();
    mockGlobalFetch({
      "/api/db/schema/list": { ok: false, status: 500, json: { error: "'(' expected" } },
    });

    await act(async () => {
      await result.current.fetchSchema(makeConnection({ id: "conn-2", name: "Other DB" }));
    });

    expect(result.current.schema).toEqual([]);
    // The engine's own words, so the empty tree can say why it is empty rather than
    // reading as "this database has no tables".
    expect(result.current.schemaError).toBe("'(' expected");
  });

  test("a read that succeeds after a failure drops the previous error", async () => {
    mockGlobalFetch({
      "/api/db/schema/list": { ok: false, status: 500, json: { error: "Prepare is not support in Databend" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });
    expect(result.current.schemaError).toBe("Prepare is not support in Databend");

    restoreGlobalFetch();
    mockGlobalFetch({
      "/api/db/schema/list": { ok: true, json: makeSchema() },
      "/api/db/schema/relations": { ok: false, status: 500, json: {} },
    });

    await act(async () => {
      await result.current.fetchSchema(makeConnection({ id: "conn-2" }));
    });

    expect(result.current.schemaError).toBeNull();
    expect(result.current.schema.map((t) => t.name)).toEqual(["users", "orders"]);
  });

  // ── Two-phase schema loading (list + relations) ───────────────────────────
  // The schema fetch was split so a slow/failing FK+index query can never block
  // (or wipe) the table list. These tests lock in that contract.

  // A list-phase payload: tables + columns + PKs, with relations intentionally
  // absent (indexes empty, no foreignKeys) — exactly what /schema/list returns.
  const makeListSchema = (): TableSchema[] => [
    {
      name: "users",
      columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
      indexes: [],
      foreignKeys: [],
      rowCount: 100,
    },
    {
      name: "orders",
      columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
      indexes: [],
      foreignKeys: [],
      rowCount: 500,
    },
  ];

  test("phase 1 renders the table list, phase 2 merges FKs/indexes by table name", async () => {
    const relations = [
      { name: "users", foreignKeys: [], indexes: [{ name: "users_pkey", columns: ["id"], unique: true }] },
      {
        name: "orders",
        foreignKeys: [{ columnName: "user_id", referencedTable: "users", referencedColumn: "id" }],
        indexes: [{ name: "orders_pkey", columns: ["id"], unique: true }],
      },
    ];

    mockGlobalFetch({
      "/api/db/schema/list": { ok: true, json: makeListSchema() },
      "/api/db/schema/relations": { ok: true, json: relations },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    const orders = result.current.schema.find((t) => t.name === "orders")!;
    expect(orders.foreignKeys).toEqual([{ columnName: "user_id", referencedTable: "users", referencedColumn: "id" }]);
    expect(orders.indexes).toEqual([{ name: "orders_pkey", columns: ["id"], unique: true }]);

    // Columns from phase 1 survive the merge.
    expect(orders.columns[0].name).toBe("id");
    expect(result.current.isLoadingSchema).toBe(false);
  });

  test("relations failure does NOT wipe the table list and shows no error toast", async () => {
    // This is the whole reason for the split: FK/index introspection is the slow,
    // timeout-prone query. If it fails the user must still see their tables.
    const listData = makeListSchema();

    mockGlobalFetch({
      "/api/db/schema/list": { ok: true, json: listData },
      "/api/db/schema/relations": { ok: false, status: 500, json: { error: "statement timeout" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    // Table list is fully intact (relations merge never ran).
    expect(result.current.schema).toEqual(listData);
    expect(result.current.isLoadingSchema).toBe(false);
    // Relations are best-effort — failure is logged, never surfaced as a toast.
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("phase 1 failure short-circuits — relations endpoint is never called", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/schema/list": { ok: false, status: 503, json: { error: "Connection refused" } },
      "/api/db/schema/relations": { ok: true, json: [] },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(result.current.schema).toEqual([]);
    expect(mockToastError).toHaveBeenCalledWith("Schema Error", { description: "Connection refused" });

    // The expensive phase 2 must be skipped entirely when the list fails.
    const relationsCalled = fetchMock.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/schema/relations"),
    );
    expect(relationsCalled).toBe(false);
  });

  test("tables absent from the relations payload are left unchanged", async () => {
    // Only 'orders' comes back from relations; 'users' must keep its list-phase shape.
    mockGlobalFetch({
      "/api/db/schema/list": { ok: true, json: makeListSchema() },
      "/api/db/schema/relations": {
        ok: true,
        json: [
          {
            name: "orders",
            foreignKeys: [{ columnName: "user_id", referencedTable: "users", referencedColumn: "id" }],
            indexes: [],
          },
        ],
      },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    const users = result.current.schema.find((t) => t.name === "users")!;
    expect(users.foreignKeys).toEqual([]);
    const orders = result.current.schema.find((t) => t.name === "orders")!;
    expect(orders.foreignKeys!.length).toBe(1);
  });

  // ── schemaContext derived value ────────────────────────────────────────────

  test("schemaContext is JSON string of schema", async () => {
    const schemaData = makeSchema();

    mockGlobalFetch({
      "/api/db/schema": { ok: true, json: schemaData },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(result.current.schemaContext).toBe(JSON.stringify(schemaData));
  });

  // ── isLoadingSchema during fetch ──────────────────────────────────────────

  test("isLoadingSchema is true during fetch, false after", async () => {
    let resolveSchema: ((value: Response) => void) | undefined;
    const schemaPromise = new Promise<Response>((resolve) => {
      resolveSchema = resolve;
    });

    mockGlobalFetch({});

    const originalMockedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/db/schema")) {
        return schemaPromise;
      }
      return originalMockedFetch(input, init);
    }) as typeof fetch;

    const { result } = renderHook(() => useConnectionManager(true));

    // Start fetching schema
    let fetchPromise: Promise<void>;
    act(() => {
      fetchPromise = result.current.fetchSchema(makeConnection());
    });

    // isLoadingSchema should be true while waiting
    expect(result.current.isLoadingSchema).toBe(true);

    // Resolve the schema request
    resolveSchema!(
      new Response(JSON.stringify(makeSchema()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await act(async () => {
      await fetchPromise!;
    });

    expect(result.current.isLoadingSchema).toBe(false);
  });

  // ── setActiveConnection persists to storage ───────────────────────────────

  test("setActiveConnection persists to storage", async () => {
    mockGlobalFetch({
      "/api/db/health": { ok: true, json: { status: "healthy" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    const conn = makeConnection({ id: "new-conn-42" });

    await act(async () => {
      result.current.setActiveConnection(conn);
    });

    await waitFor(() => {
      expect(storage.getActiveConnectionId()).toBe("new-conn-42");
    });
  });

  // ── setConnections updates array ──────────────────────────────────────────

  test("setConnections updates connections array", async () => {
    mockGlobalFetch({});

    const { result } = renderHook(() => useConnectionManager(true));

    const newConns = [makeConnection({ id: "a", name: "Alpha" }), makeConnection({ id: "b", name: "Beta" })];

    act(() => {
      result.current.setConnections(newConns);
    });

    expect(result.current.connections).toHaveLength(2);
    expect(result.current.connections[0].name).toBe("Alpha");
    expect(result.current.connections[1].name).toBe("Beta");
  });

  // ── connectionPulse healthy ───────────────────────────────────────────────

  test("connectionPulse is healthy when health check succeeds", async () => {
    const conn = makeConnection();
    storage.saveConnection(conn);

    mockGlobalFetch({
      "/api/db/health": { ok: true, json: { status: "healthy" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => {
      expect(result.current.connectionPulse).toBe("healthy");
    });
  });

  // ── Connection pulse degraded ──────────────────────────────────────────

  test("connectionPulse is degraded when health check returns non-ok", async () => {
    const conn = makeConnection();
    storage.saveConnection(conn);

    mockGlobalFetch({
      "/api/db/health": { ok: false, status: 503, json: { error: "Service Unavailable" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => {
      expect(result.current.connectionPulse).toBe("degraded");
    });
  });

  // ── Connection pulse error on fetch failure ────────────────────────────

  test("connectionPulse is error when health check throws", async () => {
    const conn = makeConnection();
    storage.saveConnection(conn);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/db/health")) {
        throw new Error("Network error");
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }) as typeof fetch;

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => {
      expect(result.current.connectionPulse).toBe("error");
    });

    globalThis.fetch = originalFetch;
  });

  // ── fetchSchema error with non-JSON response ──────────────────────────

  test("fetchSchema handles non-JSON error response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/db/schema")) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }) as typeof fetch;

    const { result } = renderHook(() => useConnectionManager(true));

    const conn = makeConnection();
    await act(async () => {
      await result.current.fetchSchema(conn);
    });

    expect(result.current.isLoadingSchema).toBe(false);
    expect(mockToastError).toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  // ── fetchSchema with non-Error exception → 'Unknown error' ────────────

  test("fetchSchema with non-Error exception shows Unknown error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/db/schema")) {
        throw "non-error string";
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const { result } = renderHook(() => useConnectionManager(true));

    const conn = makeConnection();
    await act(async () => {
      await result.current.fetchSchema(conn);
    });

    expect(result.current.isLoadingSchema).toBe(false);
    expect(mockToastError).toHaveBeenCalledWith("Schema Error", { description: "Unknown error" });

    globalThis.fetch = originalFetch;
  });

  // ── No activeConnection ID persistence when connection is null ─────────

  test("does not persist active connection ID when connection is null", async () => {
    mockGlobalFetch({});

    const { result } = renderHook(() => useConnectionManager(true));

    // activeConnection should be null (no saved connections)
    expect(result.current.activeConnection).toBeNull();

    // localStorage should not have active connection id for null
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // setActiveConnectionId is only called when activeConnection is truthy
    // so we verify no ID was persisted
    const savedId = storage.getActiveConnectionId();
    // It might be null or whatever was there before, but no new call should have been made
    expect(result.current.activeConnection).toBeNull();
    expect(savedId).toBeFalsy();
  });

  // ── Managed (seed) connection merging ────────────────────────────────────

  test("fetchSchema for regular connection success shows schema", async () => {
    const schemaData = makeSchema();

    mockGlobalFetch({
      "/api/db/schema": { ok: true, json: schemaData },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    const conn = makeConnection({ id: "pg-1" });
    await act(async () => {
      await result.current.fetchSchema(conn);
    });

    expect(result.current.schema).toEqual(schemaData);
    expect(result.current.isLoadingSchema).toBe(false);
  });

  // Server payloads are JSON — createdAt arrives as an ISO string, not a Date.
  const makeManagedConnection = (overrides: Partial<ManagedConnectionPayload> = {}): ManagedConnectionPayload => ({
    id: "srv-1",
    name: "Seeded DB",
    type: "postgres",
    host: "db.internal",
    port: 5432,
    database: "seeded",
    user: "svc",
    password: "pw",
    createdAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  });

  test("merges managed and seed connections from /api/connections/managed", async () => {
    // Existing editable user copy of seed "seed-copy" — must be kept, not re-created.
    storage.saveConnection(makeConnection({ id: "user-copy-1", name: "My Copy", seedId: "seed-copy", managed: false }));

    // Plain user connection unrelated to any seed — must survive the merge.
    storage.saveConnection(makeConnection({ id: "plain-1", name: "Plain" }));

    // Dismiss seed "seed-dismissed" through the public API (deleting a seed copy records the dismissal).
    storage.saveConnection(makeConnection({ id: "dismiss-me", seedId: "seed-dismissed" }));
    storage.deleteConnection("dismiss-me");

    storage.setActiveConnectionId("plain-1");

    mockGlobalFetch({
      "/api/connections/managed": {
        ok: true,
        json: {
          connections: [
            makeManagedConnection({ id: "managed-1", managed: true, seedId: "seed-managed" }),
            makeManagedConnection({ id: "seed-new-srv", managed: false, seedId: "seed-new" }),
            makeManagedConnection({ id: "seed-copy-srv", managed: false, seedId: "seed-copy" }),
            makeManagedConnection({ id: "seed-dismissed-srv", managed: false, seedId: "seed-dismissed" }),
          ],
        },
      },
      "/api/db/health": { ok: true, json: { status: "healthy" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => {
      expect(result.current.connections).toHaveLength(4);
    });

    const ids = result.current.connections.map((c) => c.id);

    // managed:true always comes from the server, createdAt revived as a Date.
    const managed = result.current.connections.find((c) => c.id === "managed-1")!;
    expect(managed.managed).toBe(true);
    expect(managed.createdAt).toBeInstanceOf(Date);

    // A new seed gets an editable local copy persisted to storage.
    const newCopy = result.current.connections.find((c) => c.seedId === "seed-new")!;
    expect(newCopy.managed).toBe(false);
    expect(storage.getConnections().some((c) => c.seedId === "seed-new")).toBe(true);

    // The existing user copy wins over the server version of the same seed.
    expect(ids).toContain("user-copy-1");
    expect(ids).not.toContain("seed-copy-srv");

    // Dismissed seeds are never re-added.
    expect(result.current.connections.some((c) => c.seedId === "seed-dismissed")).toBe(false);

    // The plain user connection survives, and the persisted active ID is honored.
    expect(ids).toContain("plain-1");
    expect(result.current.activeConnection!.id).toBe("plain-1");
  });

  // The rail needs the server's own descriptors, not just the merged list: an
  // editable seed copy is startable by id exactly while it still matches the
  // descriptor it came from, and the merged list has already lost that side.
  test("exposes the seed descriptors the server served, unmerged", async () => {
    const served = makeManagedConnection({ id: "seed-new-srv", managed: false, seedId: "seed-new" });
    mockGlobalFetch({
      "/api/connections/managed": { ok: true, json: { connections: [served] } },
      "/api/db/health": { ok: true, json: { status: "healthy" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => {
      expect(result.current.servedSeeds).toEqual({ loaded: true, seeds: [served] });
    });
    // The server's copy, not the user's: the merged entry is the one that may drift,
    // and it carries the raw `createdAt` string rather than a Date.
    expect(result.current.servedSeeds).toEqual({ loaded: true, seeds: [{ ...served, createdAt: served.createdAt }] });
  });

  // An answer that carries no connections is an answer: the server served none. That is
  // what a deployment with no seed file looks like, and it stays LOADED — the empty list
  // is a measurement, not a gap.
  test("serves no descriptors when the endpoint answers with no connections", async () => {
    mockGlobalFetch({
      "/api/connections/managed": { json: {} },
      "/api/db/health": { ok: true, json: { status: "healthy" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => {
      expect(result.current.connections).toEqual([]);
    });
    expect(result.current.servedSeeds).toEqual({ loaded: true, seeds: [] });
  });

  // B37. The endpoint failing is not the endpoint answering "none": one malformed
  // seed-connections.yaml used to reach the browser as an empty list, and everything
  // downstream then reported an absence it had never measured.
  test("holds the seed list as UNREAD when the server says it could not read its own configuration", async () => {
    mockGlobalFetch({
      "/api/connections/managed": {
        status: 500,
        json: { error: "Failed to load managed connections", reason: "seed-config-unreadable" },
      },
      "/api/db/health": { ok: true, json: { status: "healthy" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => {
      expect(result.current.servedSeeds).toEqual({ loaded: false });
    });
  });

  // The other arm: a failure the server did NOT attribute to its seed configuration
  // says nothing about that configuration, so it may not be recorded as one. This is
  // also the shape the platform embed produces, where the route does not exist at all.
  test("a failure the server did not attribute to its seed config leaves the list loaded", async () => {
    mockGlobalFetch({
      "/api/connections/managed": { status: 404, json: { error: "Not found" } },
      "/api/db/health": { ok: true, json: { status: "healthy" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => {
      expect(result.current.connections).toEqual([]);
    });
    expect(result.current.servedSeeds).toEqual({ loaded: true, seeds: [] });
  });

  // A gateway's HTML error page is not a server statement about anything: the body does
  // not parse, so no reason is read from it and the seed list stays a measured empty.
  test("a failure whose body is not JSON attributes nothing", async () => {
    mockGlobalFetch({
      "/api/connections/managed": {
        status: 502,
        text: "<html>Bad Gateway</html>",
        headers: { "content-type": "text/html" },
      },
      "/api/db/health": { ok: true, json: { status: "healthy" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => {
      expect(result.current.connections).toEqual([]);
    });
    expect(result.current.servedSeeds).toEqual({ loaded: true, seeds: [] });
  });

  test("managed merge falls back to the first merged connection when no active ID is persisted", async () => {
    mockGlobalFetch({
      "/api/connections/managed": {
        ok: true,
        json: { connections: [makeManagedConnection({ id: "managed-1", managed: true, seedId: "seed-managed" })] },
      },
      "/api/db/health": { ok: true, json: { status: "healthy" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await waitFor(() => {
      expect(result.current.activeConnection).not.toBeNull();
    });

    expect(result.current.connections).toHaveLength(1);
    expect(result.current.activeConnection!.id).toBe("managed-1");
  });

  // ── Async seed poll (pendingSeeds) ─────────────────────────────────────────

  const sampleSeed = () =>
    makeManagedConnection({
      id: "seed:sqlite-embedded-sample",
      managed: false,
      seedId: "sqlite-embedded-sample",
      name: "Sample (Employees)",
      type: "sqlite",
    });

  const managedCallCount = (fetchMock: ReturnType<typeof mockGlobalFetch>) =>
    fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/connections/managed")).length;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test("polls while a seed is pending and merges the sample when it appears, without a refresh", async () => {
    process.env.NEXT_PUBLIC_MANAGED_POLL_MS = "25";
    let managedCalls = 0;
    const fetchMock = mockGlobalFetch({
      "/api/connections/managed": () => {
        managedCalls += 1;
        return managedCalls === 1
          ? { ok: true, json: { connections: [], pendingSeeds: ["sqlite-embedded-sample"] } }
          : { ok: true, json: { connections: [sampleSeed()], pendingSeeds: [] } };
      },
      "/api/db/health": { ok: true, json: { status: "healthy" } },
    });
    try {
      const { result } = renderHook(() => useConnectionManager(true));

      await waitFor(
        () => {
          expect(result.current.connections.some((c) => c.seedId === "sqlite-embedded-sample")).toBe(true);
        },
        { timeout: 3000 },
      );
      expect(result.current.activeConnection?.seedId).toBe("sqlite-embedded-sample");

      // The poll must stop once nothing is pending.
      const callsWhenFound = managedCallCount(fetchMock);
      await sleep(150);
      expect(managedCallCount(fetchMock)).toBe(callsWhenFound);
    } finally {
      delete process.env.NEXT_PUBLIC_MANAGED_POLL_MS;
    }
  });

  test("a transient HTTP failure mid-poll does not stop the poll before the sample appears", async () => {
    process.env.NEXT_PUBLIC_MANAGED_POLL_MS = "25";
    let managedCalls = 0;
    mockGlobalFetch({
      "/api/connections/managed": () => {
        managedCalls += 1;
        if (managedCalls === 1)
          return { ok: true, json: { connections: [], pendingSeeds: ["sqlite-embedded-sample"] } };
        if (managedCalls === 2) return { status: 503, json: { error: "warming up" } };
        return { ok: true, json: { connections: [sampleSeed()], pendingSeeds: [] } };
      },
      "/api/db/health": { ok: true, json: { status: "healthy" } },
    });
    try {
      const { result } = renderHook(() => useConnectionManager(true));

      // The 503 on tick 1 must NOT be read as "nothing pending" — the poll
      // keeps going and the sample lands on the next successful tick.
      await waitFor(
        () => {
          expect(result.current.connections.some((c) => c.seedId === "sqlite-embedded-sample")).toBe(true);
        },
        { timeout: 3000 },
      );
      expect(managedCalls).toBeGreaterThanOrEqual(3);
    } finally {
      delete process.env.NEXT_PUBLIC_MANAGED_POLL_MS;
    }
  });

  test("does not poll when the managed response has no pending seeds", async () => {
    process.env.NEXT_PUBLIC_MANAGED_POLL_MS = "25";
    const fetchMock = mockGlobalFetch({
      "/api/connections/managed": {
        ok: true,
        json: { connections: [makeManagedConnection({ id: "managed-1", managed: true, seedId: "seed-managed" })] },
      },
      "/api/db/health": { ok: true, json: { status: "healthy" } },
    });
    try {
      const { result } = renderHook(() => useConnectionManager(true));
      await waitFor(() => {
        expect(result.current.connections).toHaveLength(1);
      });

      await sleep(150);
      expect(managedCallCount(fetchMock)).toBe(1);
    } finally {
      delete process.env.NEXT_PUBLIC_MANAGED_POLL_MS;
    }
  });

  test("does not poll for a seed the user has dismissed", async () => {
    process.env.NEXT_PUBLIC_MANAGED_POLL_MS = "25";
    // Deleting a seed copy records the dismissal.
    storage.saveConnection(makeConnection({ id: "dismiss-me", seedId: "sqlite-embedded-sample" }));
    storage.deleteConnection("dismiss-me");

    const fetchMock = mockGlobalFetch({
      "/api/connections/managed": {
        ok: true,
        json: { connections: [], pendingSeeds: ["sqlite-embedded-sample"] },
      },
      "/api/db/health": { ok: true, json: { status: "healthy" } },
    });
    try {
      renderHook(() => useConnectionManager(true));
      await waitFor(() => {
        expect(managedCallCount(fetchMock)).toBe(1);
      });

      await sleep(150);
      expect(managedCallCount(fetchMock)).toBe(1);
    } finally {
      delete process.env.NEXT_PUBLIC_MANAGED_POLL_MS;
    }
  });

  test("stops polling after the attempt budget even if the seed never appears", async () => {
    process.env.NEXT_PUBLIC_MANAGED_POLL_MS = "5";
    const fetchMock = mockGlobalFetch({
      "/api/connections/managed": {
        ok: true,
        json: { connections: [], pendingSeeds: ["sqlite-embedded-sample"] },
      },
      "/api/db/health": { ok: true, json: { status: "healthy" } },
    });
    try {
      renderHook(() => useConnectionManager(true));

      // 1 initial fetch + at most 30 poll attempts.
      await sleep(500);
      const after = managedCallCount(fetchMock);
      expect(after).toBeGreaterThan(1);
      expect(after).toBeLessThanOrEqual(31);
      await sleep(100);
      expect(managedCallCount(fetchMock)).toBe(after);
    } finally {
      delete process.env.NEXT_PUBLIC_MANAGED_POLL_MS;
    }
  });

  test("clears the seed poll on unmount", async () => {
    process.env.NEXT_PUBLIC_MANAGED_POLL_MS = "25";
    const fetchMock = mockGlobalFetch({
      "/api/connections/managed": {
        ok: true,
        json: { connections: [], pendingSeeds: ["sqlite-embedded-sample"] },
      },
      "/api/db/health": { ok: true, json: { status: "healthy" } },
    });
    try {
      const { unmount } = renderHook(() => useConnectionManager(true));
      await waitFor(() => {
        expect(managedCallCount(fetchMock)).toBeGreaterThanOrEqual(1);
      });
      unmount();

      const atUnmount = managedCallCount(fetchMock);
      await sleep(150);
      expect(managedCallCount(fetchMock)).toBe(atUnmount);
    } finally {
      delete process.env.NEXT_PUBLIC_MANAGED_POLL_MS;
    }
  });

  // ── Initialization failure is logged, never thrown ────────────────────────

  test("logs a warning when connection initialization fails", async () => {
    mockGlobalFetch({});

    const getConnectionsSpy = spyOn(storage, "getConnections").mockImplementation(() => {
      throw new Error("storage exploded");
    });
    const warnSpy = spyOn(logger, "warn");

    try {
      const { result } = renderHook(() => useConnectionManager(true));

      await waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith("Connection initialization failed", {
          route: "use-connection-manager",
          error: "storage exploded",
        });
      });

      // The hook stays usable with empty state — the rejection never escapes.
      expect(result.current.connections).toEqual([]);
      expect(result.current.activeConnection).toBeNull();
    } finally {
      getConnectionsSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

// =============================================================================
// The no-scan escape hatch (#765, #789)
// =============================================================================
//
// `skipObjectScan` on a connection means ZERO catalog reads when it opens. The
// reporter of #765 asked for exactly this, in their own words: "not preloading
// anything using command line option or at db connection level". A connection whose
// owner holds tens of thousands of objects froze the whole editor behind one
// `/api/db/schema/list`, and the tree's two cheap reads are worth deferring as well.
//
// Every assertion below COUNTS requests by path rather than checking that something
// rendered, and every zero is paired with a control that makes the same counter see
// the requests: an assertion that nothing was requested is vacuous while the reason
// might be that the counter cannot see requests at all.
describe("deferring the object scan", () => {
  // A sibling describe inherits nothing from the one above it, so the fetch mock and
  // the storage this block installs are restored here or they leak into the next file.
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  /** Catalog reads only. `/api/db/health` is the connection pulse and reads no catalog. */
  const catalogPaths = (fetchMock: ReturnType<typeof mockGlobalFetch>): string[] =>
    fetchMock.mock.calls
      .map((call) => new URL(String(call[0]), "http://localhost:3000").pathname)
      .filter((path) => path.startsWith("/api/db/schema") || path.startsWith("/api/db/objects"));

  const installSchemaRoutes = () =>
    mockGlobalFetch({
      "/api/db/provider-meta": {
        ok: true,
        json: {
          capabilities: {
            queryLanguage: "sql",
            objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
          },
          labels: {},
        },
      },
      "/api/db/schema/list": { ok: true, json: makeSchema() },
      "/api/db/objects/inventory": { ok: true, json: { objects: [] } },
      "/api/db/schema/relations": { ok: true, json: [] },
    });

  /**
   * What a connection that reads its catalog asks for, in order. `/api/db/provider-meta` is
   * not in the list because `catalogPaths` filters it out: it opens no connection and reads
   * no catalog, which is the whole reason the inventory's kinds can be resolved from it.
   */
  const FULL_READ = ["/api/db/schema/list", "/api/db/objects/inventory", "/api/db/schema/relations"];

  test("a connection that defers its scan reads no catalog at all", async () => {
    const fetchMock = installSchemaRoutes();

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection({ skipObjectScan: true }));
    });

    expect(catalogPaths(fetchMock)).toEqual([]);
    expect(result.current.isLoadingSchema).toBe(false);
  });

  /**
   * D31, which this file already states at the top: the previous connection's list is not
   * evidence about this one. A deferred connection reads nothing, so it has NO objects,
   * and the four surfaces fed from here - `schemaContext` into the AI panels and the agent
   * rail, the ER diagram, the mobile explorer, and the profiler/codegen/test-data lookups -
   * must not be handed the last connection's tables under this connection's name. Feeding
   * them to a model as grounding is the failure class #414 measured.
   *
   * The assertion this replaces was vacuous: `schema` is `[]` from mount, so asserting
   * emptiness after a deferred read proved nothing. The scan of A is the control.
   */
  test("deferring a connection drops the tables the PREVIOUS connection loaded", async () => {
    const fetchMock = installSchemaRoutes();

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection({ id: "conn-a" }));
    });
    expect(result.current.schema.map((table) => table.name)).toEqual(["users", "orders"]);

    await act(async () => {
      await result.current.fetchSchema(makeConnection({ id: "conn-b", skipObjectScan: true }));
    });

    expect(result.current.schema).toEqual([]);
    expect(result.current.schemaContext).toBe("[]");
    // Nothing failed either, so nothing may be reported as a failure: an empty panel that
    // blames the engine for a read nobody issued is worse than an empty panel.
    expect(result.current.schemaError).toBeNull();
    expect(catalogPaths(fetchMock)).toEqual(FULL_READ);
  });

  test("deferring a connection also drops the PREVIOUS connection's failure", async () => {
    mockGlobalFetch({ "/api/db/schema/list": { ok: false, status: 500, json: { error: "'(' expected" } } });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection({ id: "conn-a" }));
    });
    expect(result.current.schemaError).toBe("'(' expected");

    await act(async () => {
      await result.current.fetchSchema(makeConnection({ id: "conn-b", skipObjectScan: true }));
    });

    expect(result.current.schemaError).toBeNull();
  });

  // The control for the assertion above. Same hook, same routes, same counter, and
  // the ONLY difference is the flag.
  test("control: the same read without the flag issues both schema requests", async () => {
    const fetchMock = installSchemaRoutes();

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(catalogPaths(fetchMock)).toEqual(FULL_READ);
    expect(result.current.schema.map((table) => table.name)).toEqual(["users", "orders"]);
  });

  test("objectScanDeferred answers for the ACTIVE connection, and is null-safe", async () => {
    installSchemaRoutes();

    const { result } = renderHook(() => useConnectionManager(true));

    expect(result.current.objectScanDeferred).toBe(false);

    await act(async () => {
      result.current.setActiveConnection(makeConnection({ skipObjectScan: true }));
    });
    expect(result.current.objectScanDeferred).toBe(true);

    await act(async () => {
      result.current.setActiveConnection(makeConnection({ id: "conn-2" }));
    });
    expect(result.current.objectScanDeferred).toBe(false);
  });

  test("loadObjects performs the read the connection deferred, and stops deferring", async () => {
    const fetchMock = installSchemaRoutes();

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      result.current.setActiveConnection(makeConnection({ skipObjectScan: true }));
    });
    await act(async () => {
      await result.current.fetchSchema(makeConnection({ skipObjectScan: true }));
    });
    expect(catalogPaths(fetchMock)).toEqual([]);

    await act(async () => {
      result.current.loadObjects();
    });

    await waitFor(() => expect(result.current.objectScanDeferred).toBe(false));
    await waitFor(() => expect(result.current.schema.map((table) => table.name)).toEqual(["users", "orders"]));
    expect(catalogPaths(fetchMock)).toEqual(FULL_READ);
  });

  // The state is the connection the reader asked for BY ID, derived rather than reset
  // in an effect. A boolean would leave the next deferred connection already loaded.
  test("switching to another deferred connection defers again", async () => {
    installSchemaRoutes();

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      result.current.setActiveConnection(makeConnection({ skipObjectScan: true }));
    });
    await act(async () => {
      result.current.loadObjects();
    });
    await waitFor(() => expect(result.current.objectScanDeferred).toBe(false));

    await act(async () => {
      result.current.setActiveConnection(makeConnection({ id: "conn-9", skipObjectScan: true }));
    });

    expect(result.current.objectScanDeferred).toBe(true);
  });

  // A statement's own refresh goes through `fetchSchema` too (use-query-execution.ts),
  // so the guard has to hold for it: a reader who deferred the scan did not ask for a
  // full catalog read after every DDL statement either.
  test("a deferred connection stays deferred across a later fetchSchema", async () => {
    const fetchMock = installSchemaRoutes();

    const { result } = renderHook(() => useConnectionManager(true));

    const conn = makeConnection({ skipObjectScan: true });
    await act(async () => {
      await result.current.fetchSchema(conn);
      await result.current.fetchSchema(conn);
    });

    expect(catalogPaths(fetchMock)).toEqual([]);
  });

  test("loadObjects with no active connection reads nothing", async () => {
    const fetchMock = installSchemaRoutes();

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      result.current.loadObjects();
    });

    expect(catalogPaths(fetchMock)).toEqual([]);
    expect(result.current.objectScanDeferred).toBe(false);
  });
});

// =============================================================================
// The object surface's kinds and paths (#789, Task 25c)
// =============================================================================
//
// Every consumer filter Task 25a wrote reads `kind`, and the flat schema reading carries
// none, so until this hook asks the object surface for one the filters keep everything and
// the behaviour is byte-identical to the flat model. These tests are what make the
// difference observable: each one names the object that must NOT survive a filter, and the
// mutation that removes the tagging turns them red.
//
// The inventory fake below answers the way the ROUTE answers, kinds filter included, rather
// than replaying one fixed list. `resolveKinds` (`src/lib/api/object-route.ts:227`) returns
// EVERY declared kind when the body names none, so a fake that ignored the field would be
// green for a request that asks for all seven kinds and for one that asks for three, which
// is exactly the difference the fix round exists to make.
describe("tagging the schema with the object surface", () => {
  beforeEach(() => {
    localStorage.clear();
    // A sibling describe inherits no beforeEach, and a toast left over from the block above
    // would make the "no toast" assertion below report another test's call.
    mockToastError.mockClear();
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  /**
   * What PostgreSQL 18 really declares, copied from `provider.getCapabilities().objectKinds`
   * on the live container (libredb-postgres, measured 2026-09-12). Seven kinds, of which
   * three carry `role: "relation"` — the ratio the cost finding is about.
   */
  const PG_OBJECT_KINDS = [
    { id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true },
    { id: "view", role: "relation", label: "View", labelPlural: "Views" },
    { id: "materialized_view", role: "relation", label: "Materialized View", labelPlural: "Materialized Views" },
    { id: "sequence", role: "config", label: "Sequence", labelPlural: "Sequences" },
    { id: "function", role: "routine", label: "Function", labelPlural: "Functions" },
    { id: "procedure", role: "routine", label: "Procedure", labelPlural: "Procedures" },
    { id: "trigger", role: "attached", label: "Trigger", labelPlural: "Triggers", attachedTo: "table" },
  ];

  const PG_RELATION_KINDS = ["table", "view", "materialized_view"];

  /** MySQL 26.7.0, same source. Six kinds, two of them relations. */
  const MYSQL_OBJECT_KINDS = [
    { id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true },
    { id: "view", role: "relation", label: "View", labelPlural: "Views" },
    { id: "procedure", role: "routine", label: "Procedure", labelPlural: "Procedures" },
    { id: "function", role: "routine", label: "Function", labelPlural: "Functions" },
    { id: "trigger", role: "attached", label: "Trigger", labelPlural: "Triggers", attachedTo: "table" },
    { id: "event", role: "config", label: "Event", labelPlural: "Events" },
  ];

  const providerMeta = (objectKinds: unknown = PG_OBJECT_KINDS) => ({
    ok: true,
    json: { capabilities: { queryLanguage: "sql", containerLevels: [{ id: "schema" }], objectKinds }, labels: {} },
  });

  type InventoryObject = { name: string; kind: string; path: string[] };

  /**
   * The inventory route's own kind resolution, in four lines: an absent `kinds` means every
   * declared kind, and a named one is answered exactly. Bodies are recorded so a test can
   * assert WHAT was asked for as well as what came back.
   */
  const inventoryRoute =
    (
      objects: InventoryObject[],
      bodies: { kinds?: string[] }[] = [],
      truncated?: unknown,
      declared: { id: string }[] = PG_OBJECT_KINDS,
    ) =>
    async (req: Request) => {
      const body = (await req.json()) as { kinds?: string[] };
      bodies.push(body);
      const kinds = body.kinds ?? declared.map((kind) => kind.id);
      const answered = objects.filter((object) => kinds.includes(object.kind));
      return { ok: true, json: truncated === undefined ? { objects: answered } : { objects: answered, truncated } };
    };

  /** Catalog and metadata requests, in order, by path. */
  const requestPaths = (fetchMock: ReturnType<typeof mockGlobalFetch>): string[] =>
    fetchMock.mock.calls
      .map((call) => new URL(String(call[0]), "http://localhost:3000").pathname)
      .filter((path) => path.startsWith("/api/db/schema") || path.startsWith("/api/db/objects"));

  /** The flat reading: PostgreSQL drops the schema for `public` and keeps it otherwise. */
  const flatList = [
    { name: "users", columns: [], indexes: [], foreignKeys: [] },
    { name: "user_summary", columns: [], indexes: [], foreignKeys: [] },
    { name: "sales.orders", columns: [], indexes: [], foreignKeys: [] },
  ];

  const inventoryObjects: InventoryObject[] = [
    { name: "users", kind: "table", path: ["public", "users"] },
    { name: "user_summary", kind: "view", path: ["public", "user_summary"] },
    { name: "orders", kind: "table", path: ["sales", "orders"] },
  ];

  const inventory = { objects: inventoryObjects };

  test("every entry reaches the consumers carrying the kind and the segments", async () => {
    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/schema/list": { ok: true, json: flatList },
      "/api/db/objects/inventory": inventoryRoute(inventoryObjects),
      "/api/db/schema/relations": { ok: true, json: [] },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(result.current.schema.map((object) => [object.name, object.kind])).toEqual([
      ["users", "table"],
      ["user_summary", "view"],
      ["sales.orders", "table"],
    ]);
    // The bare `public` name joined its two segments, which is the case that would
    // otherwise leave every table on this engine untagged.
    expect(result.current.schema[0].path).toEqual(["public", "users"]);
    expect(result.current.schema[2].path).toEqual(["sales", "orders"]);
  });

  // ---------------------------------------------------------------------------
  // The inventory is asked for RELATION kinds only (review Important 2)
  // ---------------------------------------------------------------------------
  //
  // Measured on the live MySQL 26.7.0 container rather than invented, because standing
  // ruling 3 already records that a table, a procedure, a function, a trigger and an event
  // called `foo` coexist in one MySQL database. In `task25c_fix1_probe`, holding exactly
  // that, the provider answers:
  //   flat getSchema()      -> ["bar", "foo"]
  //   listObjects(all kinds) -> table foo     ["task25c_fix1_probe","foo"]
  //                             procedure foo ["task25c_fix1_probe","foo"]
  //                             event foo     ["task25c_fix1_probe","foo"]
  //                             trigger foo   ["task25c_fix1_probe","bar","foo"]
  //                             function foo_fn, table bar
  // The table, the procedure and the event carry the SAME address, so they answer the flat
  // name `foo` at the same rank and the join refuses to choose (`object-address.ts`). No
  // improvement to the matching rule can separate them: they really are spelled alike, and
  // the only reading in which `foo` is one object is the one that asks for relation kinds.
  // Tagged with every kind the table came back untagged (probe, 2026-09-12); tagged with
  // the relation kinds it came back `table`.
  test("a procedure and an event sharing a table's name do not blank the table's kind", async () => {
    const contestedFlat = [
      { name: "bar", columns: [], indexes: [], foreignKeys: [] },
      { name: "foo", columns: [], indexes: [], foreignKeys: [] },
    ];
    const contestedObjects: InventoryObject[] = [
      { name: "bar", kind: "table", path: ["task25c_fix1_probe", "bar"] },
      { name: "foo", kind: "table", path: ["task25c_fix1_probe", "foo"] },
      { name: "foo", kind: "procedure", path: ["task25c_fix1_probe", "foo"] },
      { name: "foo_fn", kind: "function", path: ["task25c_fix1_probe", "foo_fn"] },
      { name: "foo", kind: "trigger", path: ["task25c_fix1_probe", "bar", "foo"] },
      { name: "foo", kind: "event", path: ["task25c_fix1_probe", "foo"] },
    ];

    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(MYSQL_OBJECT_KINDS),
      "/api/db/schema/list": { ok: true, json: contestedFlat },
      "/api/db/objects/inventory": inventoryRoute(contestedObjects, [], undefined, MYSQL_OBJECT_KINDS),
      "/api/db/schema/relations": { ok: true, json: [] },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection({ type: "mysql" }));
    });

    expect(result.current.schema.map((object) => [object.name, object.kind])).toEqual([
      ["bar", "table"],
      ["foo", "table"],
    ]);
  });

  test("the inventory names the relation kinds, so the fan-out is three listings per container and not seven", async () => {
    // The cost half of the same finding. Every kind named here is one sequential
    // `listObjects` round trip per container inside the route, on every connection select
    // and on every DDL-triggered refresh. Measured against dvdrental on the live container:
    // 7 listings / 59 objects before, 3 listings / 22 objects after.
    const bodies: { kinds?: string[] }[] = [];
    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/schema/list": { ok: true, json: flatList },
      "/api/db/objects/inventory": inventoryRoute(inventoryObjects, bodies),
      "/api/db/schema/relations": { ok: true, json: [] },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(bodies.map((body) => body.kinds)).toEqual([PG_RELATION_KINDS]);
  });

  test("an engine whose capabilities cannot be read is not asked for an inventory at all", async () => {
    // Without the declaration there is no way to name the relation kinds, and asking for
    // every kind is the request this round removed. The flat list stands untagged, which is
    // the same degradation a 501 from the object surface produces.
    const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
    const fetchMock = mockGlobalFetch({
      "/api/db/provider-meta": { ok: false, status: 500, json: { error: "no metadata" } },
      "/api/db/schema/list": { ok: true, json: flatList },
      "/api/db/objects/inventory": inventoryRoute(inventoryObjects),
      "/api/db/schema/relations": { ok: true, json: [] },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    // The REFUSAL is what stopped the inventory, named in the engine's own terms. Without
    // this the same silence follows from a `capabilities` that is simply missing from the
    // body, and the two are different faults.
    expect(debugSpy).toHaveBeenCalledWith("Object inventory failed; the schema keeps no kinds", {
      route: "use-connection-manager",
      error: "provider metadata unavailable (500)",
    });
    debugSpy.mockRestore();
    expect(requestPaths(fetchMock)).toEqual(["/api/db/schema/list", "/api/db/schema/relations"]);
    expect(result.current.schema.map((object) => object.name)).toEqual(["users", "user_summary", "sales.orders"]);
    expect(result.current.schema.every((object) => object.kind === undefined)).toBe(true);
    expect(result.current.schemaError).toBeNull();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("an engine that declares no object kinds is not asked for an inventory either", async () => {
    // A provider that has not been migrated declares none. The request would be answered
    // with an empty object list after a round trip that could not have tagged anything.
    const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
    const fetchMock = mockGlobalFetch({
      // An engine that has not been migrated declares `objectKinds` not at all.
      "/api/db/provider-meta": { ok: true, json: { capabilities: { queryLanguage: "sql" }, labels: {} } },
      "/api/db/schema/list": { ok: true, json: flatList },
      "/api/db/objects/inventory": inventoryRoute(inventoryObjects),
      "/api/db/schema/relations": { ok: true, json: [] },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(debugSpy).toHaveBeenCalledWith("Object inventory failed; the schema keeps no kinds", {
      route: "use-connection-manager",
      error: "the provider declares no relation kinds",
    });
    debugSpy.mockRestore();
    expect(requestPaths(fetchMock)).toEqual(["/api/db/schema/list", "/api/db/schema/relations"]);
    expect(result.current.schema.every((object) => object.kind === undefined)).toBe(true);
  });

  test("a truncated inventory says so, rather than passing as a complete one", async () => {
    // A saturated inventory leaves its tail untagged, and untagged reads as "nothing was
    // declared about this object" everywhere downstream. Nothing on screen can distinguish
    // that from an engine with no object surface, so the incompleteness is reported.
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      mockGlobalFetch({
        "/api/db/provider-meta": providerMeta(),
        "/api/db/schema/list": { ok: true, json: flatList },
        "/api/db/objects/inventory": inventoryRoute(inventoryObjects, [], {
          limit: 5000,
          reason: "inventory limit reached",
        }),
        "/api/db/schema/relations": { ok: true, json: [] },
      });

      const { result } = renderHook(() => useConnectionManager(true));

      await act(async () => {
        await result.current.fetchSchema(makeConnection());
      });

      expect(warnSpy).toHaveBeenCalledWith("Object inventory truncated; objects beyond the limit keep no kind", {
        route: "use-connection-manager",
        limit: 5000,
        reason: "inventory limit reached",
      });
      // Everything that DID arrive is still tagged: an incomplete inventory is not a refused one.
      expect(result.current.schema[0].kind).toBe("table");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a complete inventory reports no truncation", async () => {
    // The control for the assertion above: the same spy must stay silent, or "it warned"
    // says nothing about `truncated` being read.
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      mockGlobalFetch({
        "/api/db/provider-meta": providerMeta(),
        "/api/db/schema/list": { ok: true, json: flatList },
        "/api/db/objects/inventory": inventoryRoute(inventoryObjects),
        "/api/db/schema/relations": { ok: true, json: [] },
      });

      const { result } = renderHook(() => useConnectionManager(true));

      await act(async () => {
        await result.current.fetchSchema(makeConnection());
      });

      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("the view is refused as an import target, which the untagged list could not do", async () => {
    // The consumer-level assertion this whole task exists for. `rowWritableObjects` is what
    // DataImportModal filters its targets with; with the kinds absent it keeps
    // `user_summary` because nothing declared anything about it.
    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/schema/list": { ok: true, json: flatList },
      "/api/db/objects/inventory": inventoryRoute(inventoryObjects),
      "/api/db/schema/relations": { ok: true, json: [] },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    const capabilities = {
      queryLanguage: "sql",
      objectKinds: [
        { id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true },
        { id: "view", role: "relation", label: "View", labelPlural: "Views" },
      ],
    } as unknown as ProviderCapabilities;

    expect(rowWritableObjects(result.current.schema, capabilities).map((object) => object.name)).toEqual([
      "users",
      "sales.orders",
    ]);
  });

  test("an engine whose object surface is not implemented keeps its whole flat list", async () => {
    // A 501 from the inventory route is the Phase 1 answer for a provider that has not been
    // migrated. It is a loss of DETAIL and never a loss of objects: nothing may disappear
    // from the explorer because a second read failed.
    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/schema/list": { ok: true, json: flatList },
      "/api/db/objects/inventory": { ok: false, status: 501, json: { error: "not implemented yet (#789)" } },
      "/api/db/schema/relations": { ok: true, json: [] },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(result.current.schema.map((object) => object.name)).toEqual(["users", "user_summary", "sales.orders"]);
    expect(result.current.schema.every((object) => object.kind === undefined)).toBe(true);
    // A failed inventory is not a schema failure: the explorer shows the tables, not an error.
    expect(result.current.schemaError).toBeNull();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("a transport failure on the inventory leaves the list exactly as phase 1 built it", async () => {
    // Not the same case as a refusal: an unreachable server rejects the promise rather than
    // answering a status, and the schema must survive that too.
    const routed = mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/schema/list": { ok: true, json: flatList },
      "/api/db/schema/relations": { ok: true, json: [] },
    });
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost:3000").pathname;
      if (path.includes("/api/db/objects/inventory")) return Promise.reject(new Error("fetch failed"));
      return routed(input, init);
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(result.current.schema.map((object) => object.name)).toEqual(["users", "user_summary", "sales.orders"]);
    expect(result.current.schema.every((object) => object.kind === undefined)).toBe(true);
    expect(result.current.schemaError).toBeNull();
  });

  test("a transport failure on the capabilities read leaves the list exactly as phase 1 built it", async () => {
    // The metadata read is one more request that can fail on an unreachable server, and it
    // runs between the two the explorer depends on.
    const routed = mockGlobalFetch({
      "/api/db/schema/list": { ok: true, json: flatList },
      "/api/db/schema/relations": { ok: true, json: [] },
    });
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost:3000").pathname;
      if (path.includes("/api/db/provider-meta")) return Promise.reject(new Error("fetch failed"));
      return routed(input, init);
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(result.current.schema.map((object) => object.name)).toEqual(["users", "user_summary", "sales.orders"]);
    expect(result.current.schema.every((object) => object.kind === undefined)).toBe(true);
    expect(result.current.schemaError).toBeNull();
  });

  test("the relations merge does not undo the tagging", async () => {
    // Two writers of one list, and they run in sequence. Phase 2 maps over the tagged list
    // by name, so a kind has to survive it or the tagging is undone one request later.
    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/schema/list": { ok: true, json: flatList },
      "/api/db/objects/inventory": inventoryRoute(inventoryObjects),
      "/api/db/schema/relations": {
        ok: true,
        json: [{ name: "users", foreignKeys: [], indexes: [{ name: "users_pkey", columns: ["id"], unique: true }] }],
      },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    const users = result.current.schema.find((object) => object.name === "users")!;
    expect(users.kind).toBe("table");
    expect(users.indexes).toEqual([{ name: "users_pkey", columns: ["id"], unique: true }]);
  });

  test("the inventory is addressed the way the object routes require, never as a bare body", async () => {
    // `/api/db/objects/*` refuses a body that names neither `connection` nor `connectionId`
    // with a 400, unlike the schema routes, which accept a bare connection AS the body. A
    // request built from the schema payload would therefore be refused on every connection.
    const bodies: unknown[] = [];
    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/schema/list": { ok: true, json: flatList },
      "/api/db/objects/inventory": async (req) => {
        bodies.push(await req.json());
        return { ok: true, json: inventory };
      },
      "/api/db/schema/relations": { ok: true, json: [] },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });
    await act(async () => {
      await result.current.fetchSchema(makeConnection({ managed: true, seedId: "sample" }));
    });

    expect(bodies).toEqual([
      {
        connection: { ...makeConnection(), createdAt: makeConnection().createdAt.toISOString() },
        kinds: PG_RELATION_KINDS,
      },
      { connectionId: "seed:sample", kinds: PG_RELATION_KINDS },
    ]);
  });

  // ---------------------------------------------------------------------------
  // A connection switch mid-read (review Minor 8)
  // ---------------------------------------------------------------------------
  //
  // `readSchema` writes the schema three times and used to write it under whichever
  // connection was on screen when each answer landed. Phase 1b is the first of the three
  // whose stale result HIDES objects rather than decorating them: connection A's kinds
  // applied to connection B's list tag nothing where the names differ, and tag WRONGLY
  // where they coincide, and both `relationObjects` and `rowWritableObjects` then drop
  // rows from B on the strength of a declaration about A.
  test("a connection switch mid-read leaves the newer connection's list alone", async () => {
    // Both connections hold an object called `orders`, which is what makes a stale write
    // VISIBLE rather than merely wasted: on A it is a table and on B it is a view, so A's
    // late inventory tags B's view as a table and `rowWritableObjects` then offers an import
    // into a view. Names that differ between the two would hide the defect entirely.
    let releaseFirstInventory: (() => void) | null = null;
    const firstInventory = new Promise<void>((resolve) => {
      releaseFirstInventory = resolve;
    });
    let inventoryCalls = 0;

    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/schema/list": { ok: true, json: [{ name: "orders", columns: [], indexes: [], foreignKeys: [] }] },
      "/api/db/objects/inventory": async () => {
        inventoryCalls += 1;
        if (inventoryCalls === 1) {
          await firstInventory;
          return { ok: true, json: { objects: [{ name: "orders", kind: "table", path: ["public", "orders"] }] } };
        }
        return { ok: true, json: { objects: [{ name: "orders", kind: "view", path: ["public", "orders"] }] } };
      },
      "/api/db/schema/relations": { ok: true, json: [] },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.fetchSchema(makeConnection({ id: "conn-a" }));
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.fetchSchema(makeConnection({ id: "conn-b", name: "B" }));
    });
    expect(result.current.schema.map((object) => [object.name, object.kind])).toEqual([["orders", "view"]]);

    await act(async () => {
      releaseFirstInventory?.();
      await first;
    });

    // A's answer landed after B's whole read. B's view stays a view.
    expect(result.current.schema.map((object) => [object.name, object.kind])).toEqual([["orders", "view"]]);

    const capabilities = {
      queryLanguage: "sql",
      objectKinds: [
        { id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true },
        { id: "view", role: "relation", label: "View", labelPlural: "Views" },
      ],
    } as unknown as ProviderCapabilities;
    expect(rowWritableObjects(result.current.schema, capabilities)).toEqual([]);
  });

  test("a deferred connection is not overwritten by the previous connection's read", async () => {
    // The same race, with the escape hatch (#765) on the other side: a connection that
    // defers its scan has read NOTHING, so an answer that arrives for the connection before
    // it must not put tables on screen under its name.
    let releaseList: (() => void) | null = null;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });

    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/schema/list": async () => {
        await listGate;
        return { ok: true, json: flatList };
      },
      "/api/db/objects/inventory": inventoryRoute(inventoryObjects),
      "/api/db/schema/relations": { ok: true, json: [] },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.fetchSchema(makeConnection({ id: "conn-a" }));
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.fetchSchema(makeConnection({ id: "conn-b", skipObjectScan: true }));
    });

    await act(async () => {
      releaseList?.();
      await first;
    });

    expect(result.current.schema).toEqual([]);
    expect(result.current.schemaContext).toBe("[]");
  });

  test("a stale relations merge does not put the old connection's indexes on the new list", async () => {
    // The third writer, guarded for the same reason as the other two. It is the oldest of the
    // three and the one whose staleness merely decorates rather than hides, so it is tested
    // rather than argued about: A's foreign keys and indexes describe A's `orders`.
    let releaseRelations: (() => void) | null = null;
    const relationsGate = new Promise<void>((resolve) => {
      releaseRelations = resolve;
    });
    let relationsCalls = 0;

    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/schema/list": { ok: true, json: [{ name: "orders", columns: [], indexes: [], foreignKeys: [] }] },
      "/api/db/objects/inventory": inventoryRoute([{ name: "orders", kind: "table", path: ["public", "orders"] }]),
      "/api/db/schema/relations": async () => {
        relationsCalls += 1;
        if (relationsCalls === 1) {
          await relationsGate;
          return {
            ok: true,
            json: [
              {
                name: "orders",
                foreignKeys: [],
                indexes: [{ name: "orders_from_connection_a", columns: ["id"], unique: true }],
              },
            ],
          };
        }
        return { ok: true, json: [] };
      },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.fetchSchema(makeConnection({ id: "conn-a" }));
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.fetchSchema(makeConnection({ id: "conn-b" }));
    });

    await act(async () => {
      releaseRelations?.();
      await first;
    });

    expect(result.current.schema[0].indexes).toEqual([]);
  });

  test("a superseded read does not report the newer one as finished", async () => {
    // `isLoadingSchema` draws the explorer's spinner. A read that has been superseded owns
    // nothing on screen, the flag included: clearing it says the CURRENT read is done while
    // its list request is still in flight, and the tree renders empty rather than loading.
    let releaseSecondList: (() => void) | null = null;
    const secondList = new Promise<void>((resolve) => {
      releaseSecondList = resolve;
    });
    let listCalls = 0;

    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/schema/list": async () => {
        listCalls += 1;
        if (listCalls === 2) await secondList;
        return { ok: true, json: flatList };
      },
      "/api/db/objects/inventory": inventoryRoute(inventoryObjects),
      "/api/db/schema/relations": { ok: true, json: [] },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.fetchSchema(makeConnection({ id: "conn-a" }));
      second = result.current.fetchSchema(makeConnection({ id: "conn-b" }));
      await first;
    });

    // A finished while B is still waiting for its list, so the explorer is still loading.
    expect(result.current.isLoadingSchema).toBe(true);

    await act(async () => {
      releaseSecondList?.();
      await second;
    });
    expect(result.current.isLoadingSchema).toBe(false);
  });

  test("a failed read for the connection left behind reports nothing under the new one", async () => {
    // The failure arm of the same race. A's phase 1 rejects after the reader has moved to B,
    // and B read its catalog successfully: an error toast and a cleared list here would
    // blame B's engine for a read that was never issued against it.
    let releaseList: (() => void) | null = null;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });

    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      // The two SCHEMA routes take the bare connection as the whole body, unlike the object
      // routes, so the id is at the top level here and not under `connection`.
      "/api/db/schema/list": async (req) => {
        const body = (await req.json()) as { id?: string };
        if (body.id !== "conn-a") return { ok: true, json: flatList };
        await listGate;
        return { ok: false, status: 500, json: { error: "connection A went away" } };
      },
      "/api/db/objects/inventory": inventoryRoute(inventoryObjects),
      "/api/db/schema/relations": { ok: true, json: [] },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.fetchSchema(makeConnection({ id: "conn-a" }));
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.fetchSchema(makeConnection({ id: "conn-b" }));
    });

    await act(async () => {
      releaseList?.();
      await first;
    });

    expect(result.current.schema.map((object) => object.name)).toEqual(["users", "user_summary", "sales.orders"]);
    expect(result.current.schemaError).toBeNull();
    expect(mockToastError).not.toHaveBeenCalled();
    expect(result.current.isLoadingSchema).toBe(false);
  });
});
