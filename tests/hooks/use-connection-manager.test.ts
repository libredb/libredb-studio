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
import type { DatabaseConnection } from "@/lib/types";
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

/**
 * What PostgreSQL 18 really declares, copied from `provider.getCapabilities().objectKinds`
 * on the live container (libredb-postgres, measured 2026-09-12). Seven kinds, of which
 * three carry `role: "relation"` - the ratio the cost finding is about.
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

type InventoryObject = { name: string; kind: string; path: string[]; rowCount?: number };

/** The two tables every schema test below reads, as the object surface answers them. */
const OBJECTS: InventoryObject[] = [
  { name: "users", kind: "table", path: ["public", "users"], rowCount: 100 },
  { name: "orders", kind: "table", path: ["public", "orders"], rowCount: 500 },
];

const DETAILS = [
  {
    path: ["public", "users"],
    columns: [
      { name: "id", type: "integer", nullable: false, isPrimary: true },
      { name: "email", type: "varchar", nullable: false, isPrimary: false },
    ],
    indexes: [{ name: "users_pkey", columns: ["id"], unique: true }],
    foreignKeys: [],
  },
  {
    path: ["public", "orders"],
    columns: [
      { name: "id", type: "integer", nullable: false, isPrimary: true },
      { name: "user_id", type: "integer", nullable: false, isPrimary: false },
    ],
    indexes: [{ name: "orders_pkey", columns: ["id"], unique: true }],
    foreignKeys: [{ columnName: "user_id", referencedTable: "users", referencedColumn: "id" }],
  },
];

/** The same objects as the hook holds them once the two halves are joined on the path. */
const joined = (objects: InventoryObject[] = OBJECTS, details = DETAILS) =>
  objects.map((object) => {
    const detail = details.find((entry) => entry.path.join("/") === object.path.join("/"));
    return {
      name: object.name,
      kind: object.kind,
      path: object.path,
      columns: detail?.columns ?? [],
      indexes: detail?.indexes ?? [],
      foreignKeys: detail?.foreignKeys ?? [],
      ...(object.rowCount === undefined ? {} : { rowCount: object.rowCount }),
    };
  });

/**
 * The inventory route's own kind resolution, in four lines: an absent `kinds` means every
 * declared kind, and a named one is answered exactly. Bodies are recorded so a test can
 * assert WHAT was asked for as well as what came back.
 */
const inventoryRoute =
  (
    objects: InventoryObject[],
    bodies: { kinds?: string[]; includeColumns?: boolean }[] = [],
    extra: Record<string, unknown> = {},
    declared: { id: string }[] = PG_OBJECT_KINDS,
    details: unknown[] = DETAILS,
  ) =>
  async (req: Request) => {
    const body = (await req.json()) as { kinds?: string[]; includeColumns?: boolean };
    bodies.push(body);
    const kinds = body.kinds ?? declared.map((kind) => kind.id);
    const answered = objects.filter((object) => kinds.includes(object.kind));
    return {
      ok: true,
      json: { objects: answered, ...(body.includeColumns === true ? { details } : {}), ...extra },
    };
  };

/** The two requests a catalog read makes, answered so the join produces `joined()`. */
const catalogRoutes = (objects: InventoryObject[] = OBJECTS) => ({
  "/api/db/provider-meta": providerMeta(),
  "/api/db/objects/inventory": inventoryRoute(objects),
});

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

  /*
    ONE catalog read, not three (#789).

    It was `/api/db/schema/list` for names and columns, `/api/db/objects/inventory` for the
    kind and the address, and `/api/db/schema/relations` for foreign keys and indexes, held
    together by a join on the display NAME. The flat reading is deleted, so the inventory
    answers both halves and they are joined on the PATH inside the hook.
  */

  test("fetchSchema reads the object inventory with its columns, and holds the joined objects", async () => {
    const bodies: { kinds?: string[]; includeColumns?: boolean }[] = [];
    const fetchMock = mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/objects/inventory": inventoryRoute(OBJECTS, bodies),
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(result.current.schema).toEqual(joined());
    expect(result.current.isLoadingSchema).toBe(false);
    // The columns are asked for, and only the relation kinds are: a routine or a trigger in
    // this list is a row the diagram and the import target cannot use.
    expect(bodies[0].includeColumns).toBe(true);
    expect(bodies[0].kinds).toEqual(PG_RELATION_KINDS);

    const inventoryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/db/objects/inventory"),
    );
    expect(inventoryCall).toBeDefined();
    expect(inventoryCall![1]?.method).toBe("POST");
  });

  test("an object the read described nothing for keeps empty columns rather than vanishing", async () => {
    // A routine has no columns and a bounded read can stop before a folder: both reach the
    // hook as an object with no detail, and neither may cost the object its row.
    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/objects/inventory": inventoryRoute(OBJECTS, [], {}, PG_OBJECT_KINDS, [DETAILS[0]]),
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(result.current.schema.map((object) => [object.name, object.columns.length])).toEqual([
      ["users", 2],
      ["orders", 0],
    ]);
  });

  // ── fetchSchema error ─────────────────────────────────────────────────────

  test("fetchSchema shows toast on error", async () => {
    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/objects/inventory": { ok: false, status: 500, json: { error: "Connection refused" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(result.current.schema).toEqual([]);
    expect(result.current.isLoadingSchema).toBe(false);

    // useToast calls sonnerToast.error for destructive variant
    expect(mockToastError).toHaveBeenCalledWith("Schema Error", { description: "Connection refused" });
  });

  test("metadata that could not be read is the engine's own failure, and is reported as one", async () => {
    mockGlobalFetch({
      "/api/db/provider-meta": { ok: false, status: 503, json: { error: "Connection refused" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(result.current.schemaError).toBe("Connection refused");
  });

  test("an engine that declares no relation kind holds nothing, and that is not an error", async () => {
    // A true statement about the engine: nothing declared a kind whose rows this list
    // renders, so there is nothing to ask for. No reading failed, so nothing is reported
    // as a failure and no toast is raised.
    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta([{ id: "function", role: "routine", label: "F", labelPlural: "Fs" }]),
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(result.current.schema).toEqual([]);
    expect(result.current.schemaError).toBeNull();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test("an inventory body that is not a list of objects is refused rather than rendered", async () => {
    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/objects/inventory": { ok: true, json: { objects: "everything" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(result.current.schema).toEqual([]);
    expect(result.current.schemaError).toBe("The object inventory answered a body this list cannot render");
  });

  // A failing read must not leave the PREVIOUS connection's tables on screen (D31).
  // The assertion above is vacuous on its own — `schema` starts empty — so this one
  // loads a schema first and then fails the next read, which is the measured sequence.
  test("a failed read clears the schema loaded for the previous connection", async () => {
    mockGlobalFetch(catalogRoutes());

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });
    expect(result.current.schema.map((t) => t.name)).toEqual(["users", "orders"]);
    expect(result.current.schemaError).toBeNull();

    restoreGlobalFetch();
    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/objects/inventory": { ok: false, status: 500, json: { error: "'(' expected" } },
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
      "/api/db/provider-meta": providerMeta(),
      "/api/db/objects/inventory": { ok: false, status: 500, json: { error: "Prepare is not support in Databend" } },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });
    expect(result.current.schemaError).toBe("Prepare is not support in Databend");

    restoreGlobalFetch();
    mockGlobalFetch(catalogRoutes());

    await act(async () => {
      await result.current.fetchSchema(makeConnection({ id: "conn-2" }));
    });

    expect(result.current.schemaError).toBeNull();
    expect(result.current.schema.map((t) => t.name)).toEqual(["users", "orders"]);
  });

  test("a truncated inventory is logged, and the objects it did carry are still rendered", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/objects/inventory": inventoryRoute(OBJECTS, [], {
        truncated: { limit: 5000, reason: "inventory limit reached" },
      }),
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(result.current.schema.map((t) => t.name)).toEqual(["users", "orders"]);
    expect(warn).toHaveBeenCalledWith(
      "Object inventory truncated; objects beyond the limit are not listed",
      expect.objectContaining({ limit: 5000, reason: "inventory limit reached" }),
    );
    warn.mockRestore();
  });

  // ── schemaContext derived value ────────────────────────────────────────────

  test("schemaContext is JSON string of schema", async () => {
    mockGlobalFetch(catalogRoutes());

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(result.current.schemaContext).toBe(JSON.stringify(joined()));
  });

  // ── isLoadingSchema during fetch ──────────────────────────────────────────

  test("isLoadingSchema is true during fetch, false after", async () => {
    let resolveSchema: ((value: Response) => void) | undefined;
    const schemaPromise = new Promise<Response>((resolve) => {
      resolveSchema = resolve;
    });

    mockGlobalFetch({ "/api/db/provider-meta": providerMeta() });

    const originalMockedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/db/objects/inventory")) {
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
      new Response(JSON.stringify({ objects: OBJECTS, details: DETAILS }), {
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
      if (url.includes("/api/db/provider-meta")) {
        return new Response(JSON.stringify(providerMeta().json), { status: 200 });
      }
      if (url.includes("/api/db/objects/inventory")) {
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
      if (url.includes("/api/db/provider-meta")) {
        return new Response(JSON.stringify(providerMeta().json), { status: 200 });
      }
      if (url.includes("/api/db/objects/inventory")) {
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
    mockGlobalFetch(catalogRoutes());

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection({ id: "pg-1" }));
    });

    expect(result.current.schema).toEqual(joined());
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
// `/api/db/objects/inventory`, and the tree's two cheap reads are worth deferring as well.
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

  const installSchemaRoutes = () => mockGlobalFetch(catalogRoutes());

  /**
   * What a connection that reads its catalog asks for. `/api/db/provider-meta` is not in the
   * list because `catalogPaths` filters it out: it opens no connection and reads no catalog,
   * which is the whole reason the inventory's kinds can be resolved from it.
   */
  const FULL_READ = ["/api/db/objects/inventory"];

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
    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/objects/inventory": { ok: false, status: 500, json: { error: "'(' expected" } },
    });

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
describe("the object inventory the explorer reads", () => {
  beforeEach(() => {
    localStorage.clear();
    // A sibling describe inherits no beforeEach, and a toast left over from the block above
    // would make the "no toast" assertion below report another test's call.
    mockToastError.mockClear();
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  /** Catalog and metadata requests, in order, by path. */
  const requestPaths = (fetchMock: ReturnType<typeof mockGlobalFetch>): string[] =>
    fetchMock.mock.calls
      .map((call) => new URL(String(call[0]), "http://localhost:3000").pathname)
      .filter((path) => path.startsWith("/api/db/objects") || path.startsWith("/api/db/provider-meta"));

  /*
    THE INVENTORY IS ASKED FOR RELATION KINDS ONLY.

    Measured on the live MySQL 26.7.0 container rather than invented, because standing
    ruling 3 already records that a table, a procedure, a function, a trigger and an event
    called `foo` coexist in one MySQL database. Asking for every declared kind would put
    four objects this list cannot render beside the one it can, and each one costs a
    sequential `listObjects` round trip per container inside the route.
  */
  test("the inventory names the relation kinds, so the fan-out is three listings per container and not seven", async () => {
    const bodies: { kinds?: string[] }[] = [];
    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/objects/inventory": inventoryRoute(OBJECTS, bodies),
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].kinds).toEqual(PG_RELATION_KINDS);
    // Derived from the declaration rather than restated: a hardcoded list here would pass
    // while the hook asked for something else entirely.
    expect(PG_RELATION_KINDS).toEqual(
      PG_OBJECT_KINDS.filter((kind) => kind.role === "relation").map((kind) => kind.id),
    );
  });

  test("a routine declared beside a relation is never asked for", async () => {
    const bodies: { kinds?: string[] }[] = [];
    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(MYSQL_OBJECT_KINDS),
      "/api/db/objects/inventory": inventoryRoute(OBJECTS, bodies, {}, MYSQL_OBJECT_KINDS),
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    expect(bodies[0].kinds).toEqual(["table", "view"]);
  });

  test("an engine whose capabilities cannot be read is not asked for an inventory at all", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/provider-meta": { ok: false, status: 503, json: { error: "Connection refused" } },
      "/api/db/objects/inventory": inventoryRoute(OBJECTS),
    });

    const { result } = renderHook(() => useConnectionManager(true));

    await act(async () => {
      await result.current.fetchSchema(makeConnection());
    });

    // Asking for every kind is the defect the kind filter exists to prevent, so with no
    // declaration the request is not sent rather than sent unfiltered.
    expect(requestPaths(fetchMock)).toEqual(["/api/db/provider-meta"]);
  });

  test("the inventory is addressed the way the object routes require, never as a bare body", async () => {
    // `/api/db/objects/*` refuses a body that names neither `connection` nor `connectionId`
    // with a 400, so a request built as a bare connection object would be refused on every
    // connection.
    const bodies: unknown[] = [];
    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/objects/inventory": async (req: Request) => {
        bodies.push(await req.json());
        return { ok: true, json: { objects: OBJECTS, details: DETAILS } };
      },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    const conn = makeConnection();
    await act(async () => {
      await result.current.fetchSchema(conn);
    });
    await act(async () => {
      await result.current.fetchSchema(makeConnection({ id: "seeded", managed: true, seedId: "sample" }));
    });

    expect(bodies).toEqual([
      // `createdAt` arrives as the ISO string JSON carries, not as the Date the caller held.
      {
        connection: { ...conn, createdAt: conn.createdAt.toISOString() },
        kinds: PG_RELATION_KINDS,
        includeColumns: true,
      },
      { connectionId: "seed:sample", kinds: PG_RELATION_KINDS, includeColumns: true },
    ]);
  });

  // ---------------------------------------------------------------------------
  // A connection switch mid-read (review Minor 8)
  // ---------------------------------------------------------------------------
  //
  // A read used to write the schema under whichever connection was on screen when its
  // answer landed. Connection A's objects under connection B's name tag nothing where the
  // names differ and tag WRONGLY where they coincide, and `rowWritableObjects` then offers
  // an import into a view on the strength of a declaration about A.
  test("a connection switch mid-read leaves the newer connection's list alone", async () => {
    // Both connections hold an object called `orders`, which is what makes a stale write
    // VISIBLE rather than merely wasted: on A it is a table and on B it is a view.
    let releaseFirstInventory: (() => void) | null = null;
    const firstInventory = new Promise<void>((resolve) => {
      releaseFirstInventory = resolve;
    });
    let inventoryCalls = 0;

    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/objects/inventory": async () => {
        inventoryCalls += 1;
        if (inventoryCalls === 1) {
          await firstInventory;
          return { ok: true, json: { objects: [{ name: "orders", kind: "table", path: ["public", "orders"] }] } };
        }
        return { ok: true, json: { objects: [{ name: "orders", kind: "view", path: ["public", "orders"] }] } };
      },
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

  test("a superseded read does not report the newer one as finished", async () => {
    let releaseFirst: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;

    let releaseSecond: (() => void) | null = null;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/objects/inventory": async () => {
        calls += 1;
        await (calls === 1 ? gate : secondGate);
        return { ok: true, json: { objects: OBJECTS, details: DETAILS } };
      },
    });

    const { result } = renderHook(() => useConnectionManager(true));

    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.fetchSchema(makeConnection({ id: "conn-a" }));
      await Promise.resolve();
    });

    let second: Promise<void> = Promise.resolve();
    await act(async () => {
      second = result.current.fetchSchema(makeConnection({ id: "conn-b" }));
      await Promise.resolve();
    });
    expect(result.current.isLoadingSchema).toBe(true);

    // The superseded read finishes first. It owns no flag, so the newer read is still
    // reported as in flight.
    await act(async () => {
      releaseFirst?.();
      await first;
    });
    expect(result.current.isLoadingSchema).toBe(true);

    await act(async () => {
      releaseSecond?.();
      await second;
    });
    expect(result.current.isLoadingSchema).toBe(false);
  });

  test("a failed read for the connection left behind reports nothing under the new one", async () => {
    let releaseFirst: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;

    mockGlobalFetch({
      "/api/db/provider-meta": providerMeta(),
      "/api/db/objects/inventory": async () => {
        calls += 1;
        if (calls === 1) {
          await gate;
          return { ok: false, status: 500, json: { error: "Connection refused" } };
        }
        return { ok: true, json: { objects: OBJECTS, details: DETAILS } };
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
      releaseFirst?.();
      await first;
    });

    // The failure belongs to a connection nobody is looking at. Naming it would blame the
    // current connection for a read never issued against it.
    expect(result.current.schema.map((object) => object.name)).toEqual(["users", "orders"]);
    expect(result.current.schemaError).toBeNull();
    expect(mockToastError).not.toHaveBeenCalled();
  });
});
