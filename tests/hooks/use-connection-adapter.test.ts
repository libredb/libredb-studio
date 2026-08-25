import "../setup-dom";

import { describe, test, expect, mock } from "bun:test";
import { renderHook, act } from "@testing-library/react";

import { useConnectionAdapter } from "@/workspace/hooks/use-connection-adapter";
import type { WorkspaceConnection } from "@/workspace/types";
import type { TableSchema } from "@/lib/types";

// ── Test Data ───────────────────────────────────────────────────────────────

const makeWorkspaceConnection = (overrides: Partial<WorkspaceConnection> = {}): WorkspaceConnection => ({
  id: "ws-conn-1",
  name: "Platform DB",
  type: "postgres",
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
// useConnectionAdapter Tests
// =============================================================================
describe("useConnectionAdapter", () => {
  // ── Initializes with first connection as active ─────────────────────────

  test("initializes with first connection as active", () => {
    const connections = [
      makeWorkspaceConnection({ id: "c1", name: "DB One" }),
      makeWorkspaceConnection({ id: "c2", name: "DB Two" }),
    ];
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result } = renderHook(() => useConnectionAdapter({ connections, onSchemaFetch }));

    expect(result.current.activeConnection).not.toBeNull();
    expect(result.current.activeConnection!.id).toBe("c1");
    expect(result.current.activeConnection!.name).toBe("DB One");
    expect(result.current.activeConnection!.managed).toBe(true);
  });

  // ── Returns null activeConnection when connections array is empty ───────

  test("returns null activeConnection when connections array is empty", () => {
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result } = renderHook(() => useConnectionAdapter({ connections: [], onSchemaFetch }));

    expect(result.current.connections).toEqual([]);
    expect(result.current.activeConnection).toBeNull();
    expect(result.current.schema).toEqual([]);
    expect(result.current.isLoadingSchema).toBe(false);
    expect(result.current.connectionPulse).toBeNull();
  });

  // ── setActiveConnection updates active connection ───────────────────────

  test("setActiveConnection updates active connection", () => {
    const connections = [
      makeWorkspaceConnection({ id: "c1", name: "DB One" }),
      makeWorkspaceConnection({ id: "c2", name: "DB Two" }),
    ];
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result } = renderHook(() => useConnectionAdapter({ connections, onSchemaFetch }));

    expect(result.current.activeConnection!.id).toBe("c1");

    act(() => {
      result.current.setActiveConnection(result.current.connections[1]);
    });

    expect(result.current.activeConnection!.id).toBe("c2");
    expect(result.current.activeConnection!.name).toBe("DB Two");
  });

  // ── fetchSchema calls onSchemaFetch and updates schema state ────────────

  test("fetchSchema calls onSchemaFetch and updates schema state", async () => {
    const schemaData = makeSchema();
    const onSchemaFetch = mock(() => Promise.resolve(schemaData));

    const connections = [makeWorkspaceConnection({ id: "c1" })];

    const { result } = renderHook(() => useConnectionAdapter({ connections, onSchemaFetch }));

    await act(async () => {
      await result.current.fetchSchema(result.current.connections[0]);
    });

    // Verify onSchemaFetch was called with the connection ID
    expect(onSchemaFetch).toHaveBeenCalledTimes(1);
    expect(onSchemaFetch).toHaveBeenCalledWith("c1");

    // Verify schema was set
    expect(result.current.schema).toEqual(schemaData);

    // Verify schemaContext derived value
    expect(result.current.schemaContext).toBe(JSON.stringify(schemaData));

    // Verify loading is done
    expect(result.current.isLoadingSchema).toBe(false);
  });

  // ── fetchSchema sets isLoadingSchema during fetch ───────────────────────

  test("fetchSchema sets isLoadingSchema during fetch", async () => {
    let resolveSchema: ((value: TableSchema[]) => void) | undefined;
    const schemaPromise = new Promise<TableSchema[]>((resolve) => {
      resolveSchema = resolve;
    });
    const onSchemaFetch = mock(() => schemaPromise);

    const connections = [makeWorkspaceConnection({ id: "c1" })];

    const { result } = renderHook(() => useConnectionAdapter({ connections, onSchemaFetch }));

    // Start fetching schema (don't await)
    let fetchPromise: Promise<void>;
    act(() => {
      fetchPromise = result.current.fetchSchema(result.current.connections[0]);
    });

    // isLoadingSchema should be true while waiting
    expect(result.current.isLoadingSchema).toBe(true);

    // Resolve the schema request
    resolveSchema!(makeSchema());

    await act(async () => {
      await fetchPromise!;
    });

    expect(result.current.isLoadingSchema).toBe(false);
    expect(result.current.schema).toHaveLength(2);
  });

  // ── fetchSchema error sets empty schema ─────────────────────────────────

  test("fetchSchema error sets empty schema", async () => {
    const onSchemaFetch = mock(() => Promise.reject(new Error("Connection refused")));

    const connections = [makeWorkspaceConnection({ id: "c1" })];

    const { result } = renderHook(() => useConnectionAdapter({ connections, onSchemaFetch }));

    await act(async () => {
      await result.current.fetchSchema(result.current.connections[0]);
    });

    expect(result.current.schema).toEqual([]);
    expect(result.current.isLoadingSchema).toBe(false);
  });

  // ── Updates connections when props change ───────────────────────────────

  test("updates connections when props change", () => {
    const initialConnections = [makeWorkspaceConnection({ id: "c1", name: "DB One" })];
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result, rerender } = renderHook(({ connections }) => useConnectionAdapter({ connections, onSchemaFetch }), {
      initialProps: { connections: initialConnections },
    });

    expect(result.current.connections).toHaveLength(1);
    expect(result.current.connections[0].id).toBe("c1");

    // Rerender with updated connections
    const updatedConnections = [
      makeWorkspaceConnection({ id: "c1", name: "DB One" }),
      makeWorkspaceConnection({ id: "c2", name: "DB Two" }),
      makeWorkspaceConnection({ id: "c3", name: "DB Three", type: "mysql" }),
    ];

    rerender({ connections: updatedConnections });

    expect(result.current.connections).toHaveLength(3);
    expect(result.current.connections[2].id).toBe("c3");
    expect(result.current.connections[2].type).toBe("mysql");
    expect(result.current.connections[2].managed).toBe(true);
  });

  // ── Resets activeConnection when it is removed from connections ─────────

  test("resets activeConnection when it is removed from connections", async () => {
    const initialConnections = [
      makeWorkspaceConnection({ id: "c1", name: "DB One" }),
      makeWorkspaceConnection({ id: "c2", name: "DB Two" }),
    ];
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result, rerender } = renderHook(({ connections }) => useConnectionAdapter({ connections, onSchemaFetch }), {
      initialProps: { connections: initialConnections },
    });

    // Set active to c2
    act(() => {
      result.current.setActiveConnection(result.current.connections[1]);
    });
    expect(result.current.activeConnection!.id).toBe("c2");

    // Remove c2 from connections
    const updatedConnections = [makeWorkspaceConnection({ id: "c1", name: "DB One" })];

    rerender({ connections: updatedConnections });

    // Synchronous on purpose: the fallback is committed DURING the render that
    // dropped c2 — adjusting state while rendering re-runs the hook before anything
    // commits — so it must already hold here. A `waitFor` would also pass against an
    // effect that repairs the selection one render late.
    expect(result.current.activeConnection!.id).toBe("c1");
  });

  // ── Resets activeConnection to null when all connections removed ─────────

  test("resets activeConnection to null when all connections removed", async () => {
    const initialConnections = [makeWorkspaceConnection({ id: "c1", name: "DB One" })];
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result, rerender } = renderHook(({ connections }) => useConnectionAdapter({ connections, onSchemaFetch }), {
      initialProps: { connections: initialConnections },
    });

    expect(result.current.activeConnection!.id).toBe("c1");

    // Remove all connections
    rerender({ connections: [] });

    // Synchronous for the same reason as the test above.
    expect(result.current.activeConnection).toBeNull();
  });

  // ── Clearing the selection falls back to the host's first connection ────

  /**
   * Documents a real change: while the selection was held as an object,
   * `setActiveConnection(null)` left `activeConnection` null even with a non-empty
   * list. It is now a request to clear the CHOICE, and the render-phase guard
   * immediately commits the host's first connection again — the same value a fresh
   * mount shows.
   *
   * Unreachable from the shipped shell: the adapter's setter is passed only to
   * `Sidebar`'s `onSelectConnection`, typed `(connection: DatabaseConnection) => void`,
   * so nothing hands it null. Pinned here so the semantic is a decision, not a
   * discovery.
   */
  test("clearing the selection falls back to the first connection, not null", () => {
    const connections = [
      makeWorkspaceConnection({ id: "c1", name: "DB One" }),
      makeWorkspaceConnection({ id: "c2", name: "DB Two" }),
    ];
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result } = renderHook(() => useConnectionAdapter({ connections, onSchemaFetch }));

    act(() => {
      result.current.setActiveConnection(result.current.connections[1]);
    });
    expect(result.current.activeConnection!.id).toBe("c2");

    act(() => {
      result.current.setActiveConnection(null);
    });

    expect(result.current.activeConnection!.id).toBe("c1");
  });

  // ── The active connection follows the host's latest object ──────────────

  /**
   * The selection is held by id, not by object. Holding the object meant that a
   * host renaming a connection in place kept serving the captured one: the
   * "is it still in the list?" check passed on id, so nothing ever re-synced.
   */
  test("the active connection follows the host's latest object for that id", () => {
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result, rerender } = renderHook(({ connections }) => useConnectionAdapter({ connections, onSchemaFetch }), {
      initialProps: { connections: [makeWorkspaceConnection({ id: "c1", name: "DB One" })] },
    });

    expect(result.current.activeConnection!.name).toBe("DB One");

    rerender({ connections: [makeWorkspaceConnection({ id: "c1", name: "DB One, renamed" })] });

    expect(result.current.activeConnection!.id).toBe("c1");
    expect(result.current.activeConnection!.name).toBe("DB One, renamed");
  });

  // ── The resolved fallback is sticky against host reordering ──────────

  /**
   * The fallback resolves ONCE and is then held by id. A positional
   * `?? connections[0]` re-resolved on every render, so a host that prepended or
   * reordered its list moved the selection to a database the user never picked --
   * and StudioWorkspace keys its schema fetch on `activeConnection?.id`, so the
   * editor silently changed database and re-fetched a schema.
   */
  test("keeps the implicitly selected connection when the host reorders its list", () => {
    const onSchemaFetch = mock(() => Promise.resolve([]));
    const a = makeWorkspaceConnection({ id: "c1", name: "DB One" });
    const b = makeWorkspaceConnection({ id: "c2", name: "DB Two" });

    const { result, rerender } = renderHook(({ connections }) => useConnectionAdapter({ connections, onSchemaFetch }), {
      initialProps: { connections: [a, b] },
    });

    expect(result.current.activeConnection!.id).toBe("c1");

    // Same two connections, host order flipped. Nothing was selected by the user,
    // so only the committed fallback can keep this on c1.
    rerender({ connections: [b, a] });

    expect(result.current.activeConnection!.id).toBe("c1");
    expect(result.current.activeConnection!.name).toBe("DB One");
  });

  test("the fallback chosen after a removal is itself sticky across a later reorder", () => {
    const onSchemaFetch = mock(() => Promise.resolve([]));
    const c1 = makeWorkspaceConnection({ id: "c1", name: "DB One" });
    const c2 = makeWorkspaceConnection({ id: "c2", name: "DB Two" });
    const c3 = makeWorkspaceConnection({ id: "c3", name: "DB Three" });

    const { result, rerender } = renderHook(({ connections }) => useConnectionAdapter({ connections, onSchemaFetch }), {
      initialProps: { connections: [c1, c2, c3] },
    });

    act(() => {
      result.current.setActiveConnection(result.current.connections[2]);
    });
    expect(result.current.activeConnection!.id).toBe("c3");

    // c3 is dropped by the host: the fallback takes over.
    rerender({ connections: [c1, c2] });
    expect(result.current.activeConnection!.id).toBe("c1");

    // ...and that replacement must be held too, not re-resolved positionally.
    rerender({ connections: [c2, c1] });
    expect(result.current.activeConnection!.id).toBe("c1");
  });

  // ── Maps WorkspaceConnection to DatabaseConnection correctly ────────────

  test("maps WorkspaceConnection to DatabaseConnection with managed flag", () => {
    const connections = [makeWorkspaceConnection({ id: "c1", name: "Platform DB", type: "mysql" })];
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result } = renderHook(() => useConnectionAdapter({ connections, onSchemaFetch }));

    const mapped = result.current.connections[0];
    expect(mapped.id).toBe("c1");
    expect(mapped.name).toBe("Platform DB");
    expect(mapped.type).toBe("mysql");
    expect(mapped.managed).toBe(true);
    expect(mapped.createdAt).toBeInstanceOf(Date);
  });

  // ── setConnections is a no-op ──────────────────────────────────────────

  test("setConnections is a no-op (connections are externally managed)", () => {
    const connections = [makeWorkspaceConnection({ id: "c1" })];
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result } = renderHook(() => useConnectionAdapter({ connections, onSchemaFetch }));

    // Calling setConnections should not throw and should not change connections
    act(() => {
      result.current.setConnections([]);
    });

    expect(result.current.connections).toHaveLength(1);
  });

  // ── connectionPulse is always null ─────────────────────────────────────

  test("connectionPulse is always null (no health check in adapter)", () => {
    const connections = [makeWorkspaceConnection({ id: "c1" })];
    const onSchemaFetch = mock(() => Promise.resolve([]));

    const { result } = renderHook(() => useConnectionAdapter({ connections, onSchemaFetch }));

    expect(result.current.connectionPulse).toBeNull();
  });

  // ── Provider metadata (#427) ───────────────────────────────────────────

  describe("provider metadata", () => {
    const redisCapabilities = {
      queryLanguage: "json",
      queryDialect: "redis",
      tablesAreDerivedGroupings: true,
      supportsMaintenance: true,
      maintenanceOperations: ["analyze"],
    } as unknown as NonNullable<WorkspaceConnection["capabilities"]>;

    test("is null when the host declares no capabilities", () => {
      const connections = [makeWorkspaceConnection({ id: "c1" })];
      const onSchemaFetch = mock(() => Promise.resolve([]));

      const { result } = renderHook(() => useConnectionAdapter({ connections, onSchemaFetch }));

      expect(result.current.metadata).toBeNull();
    });

    test("reports the active connection's declared capabilities", () => {
      const connections = [
        makeWorkspaceConnection({ id: "c1", type: "redis", capabilities: redisCapabilities }),
        makeWorkspaceConnection({ id: "c2" }),
      ];
      const onSchemaFetch = mock(() => Promise.resolve([]));

      const { result } = renderHook(() => useConnectionAdapter({ connections, onSchemaFetch }));

      expect(result.current.metadata?.capabilities.queryDialect).toBe("redis");
    });

    test("follows the active connection when it changes", () => {
      const connections = [
        makeWorkspaceConnection({ id: "c1", type: "redis", capabilities: redisCapabilities }),
        makeWorkspaceConnection({ id: "c2" }),
      ];
      const onSchemaFetch = mock(() => Promise.resolve([]));

      const { result } = renderHook(() => useConnectionAdapter({ connections, onSchemaFetch }));

      act(() => {
        result.current.setActiveConnection(result.current.connections[1]);
      });

      expect(result.current.metadata).toBeNull();
    });

    test("passes the host's labels through when it declares them", () => {
      const labels = { vacuumAction: "Memory Doctor" } as unknown as NonNullable<WorkspaceConnection["labels"]>;
      const connections = [
        makeWorkspaceConnection({ id: "c1", type: "redis", capabilities: redisCapabilities, labels }),
      ];
      const onSchemaFetch = mock(() => Promise.resolve([]));

      const { result } = renderHook(() => useConnectionAdapter({ connections, onSchemaFetch }));

      expect(result.current.metadata?.labels?.vacuumAction).toBe("Memory Doctor");
    });

    // `ProviderMetadata.labels` is optional precisely so this case needs no cast:
    // a host that knows only the capabilities leaves the wording to studio's own
    // fallbacks, and every consumer reads labels through `?.` (#427).
    test("leaves labels absent when the host declares only capabilities", () => {
      const connections = [makeWorkspaceConnection({ id: "c1", type: "redis", capabilities: redisCapabilities })];
      const onSchemaFetch = mock(() => Promise.resolve([]));

      const { result } = renderHook(() => useConnectionAdapter({ connections, onSchemaFetch }));

      expect(result.current.metadata?.labels).toBeUndefined();
    });
  });
});
