import "../setup-dom";

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";

// Shared mocks — process-wide singletons (no contamination)
import { mockToastDefault, mockToastDismiss } from "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { useTabManager } from "@/hooks/use-tab-manager";
import type { DatabaseConnection } from "@/lib/types";
import type { DetailedObject } from "@/lib/db/detailed-object";
import type { DatabaseObject } from "@/lib/db/types";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";

// Helper to create a minimal connection
function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "conn-1",
    name: "Test DB",
    type: "postgres",
    host: "localhost",
    port: 5432,
    database: "testdb",
    createdAt: new Date(),
    ...overrides,
  };
}

// Helper metadata
const defaultMetadata: ProviderMetadata = {
  capabilities: {
    queryLanguage: "sql" as const,
    supportsExplain: true,
    supportsExternalQueryLimiting: true,
    supportsCreateTable: true,
    supportsInlineRowEdit: true,
    supportsMaintenance: true,
    maintenanceOperations: [],
    supportsConnectionString: true,
    schemaRefreshPattern: "CREATE|ALTER|DROP",
    defaultPort: 5432,
  },
  labels: {
    entityName: "Table",
    entityNamePlural: "Tables",
    rowName: "Row",
    rowNamePlural: "Rows",
    selectAction: "SELECT",
    generateAction: "Generate SELECT",
    analyzeAction: "Analyze",
    vacuumAction: "Vacuum",
    searchPlaceholder: "Search tables...",
    analyzeGlobalLabel: "Analyze All",
    analyzeGlobalTitle: "Analyze All Tables",
    analyzeGlobalDesc: "Analyze all tables in the database",
    vacuumGlobalLabel: "Vacuum All",
    vacuumGlobalTitle: "Vacuum All Tables",
    vacuumGlobalDesc: "Vacuum all tables in the database",
  },
};

// Helper schema
const testSchema: DetailedObject[] = [
  {
    name: "users",
    kind: "table",
    path: ["users"],
    columns: [
      { name: "id", type: "integer", nullable: false, isPrimary: true },
      { name: "name", type: "varchar", nullable: true, isPrimary: false },
    ],
    indexes: [],
  },
];

type ToastOptions = { action: { label: string; onClick: () => void } };

function lastToastCall() {
  const call = mockToastDefault.mock.calls.at(-1) as unknown as [string, ToastOptions];
  return { message: call[0], options: call[1] };
}

describe("useTabManager", () => {
  beforeEach(() => {
    localStorage.clear();
    mockToastDefault.mockClear();
    mockToastDismiss.mockClear();
  });

  test("a count query opens and activates an editable tab without executing it", () => {
    const { result } = renderHook(() =>
      useTabManager({ activeConnection: makeConnection(), metadata: defaultMetadata, schema: [] }),
    );
    act(() => result.current.handleGenerateCount(["app", "Order.Items"]));
    const tab = result.current.tabs[1];
    expect(tab.name).toBe("Count: Order.Items");
    expect(tab.query).toBe('SELECT COUNT(*) AS row_count\nFROM app."Order.Items";');
    expect(tab.type).toBe("sql");
    expect(tab.isExecuting).toBe(false);
    expect(tab.result).toBeNull();
    expect(result.current.activeTabId).toBe(tab.id);
  });

  test("a MongoDB count opens in the correct editor language", () => {
    const metadata = {
      ...defaultMetadata,
      capabilities: { ...defaultMetadata.capabilities, queryLanguage: "json" as const },
    };
    const { result } = renderHook(() =>
      useTabManager({ activeConnection: makeConnection({ type: "mongodb" }), metadata, schema: [] }),
    );
    act(() => result.current.handleGenerateCount(["database", "orders"]));
    expect(result.current.tabs[1].type).toBe("mongodb");
    expect(JSON.parse(result.current.tabs[1].query)).toEqual({ collection: "orders", operation: "count", filter: {} });
  });

  test.each([
    null,
    { ...defaultMetadata, capabilities: { ...defaultMetadata.capabilities, queryDialect: "redis" as const } },
  ])("unresolved or unsupported metadata never creates a count tab (%#)", (metadata) => {
    const { result } = renderHook(() => useTabManager({ activeConnection: makeConnection(), metadata, schema: [] }));
    act(() => result.current.handleGenerateCount(["user:*"]));
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.activeTabId).toBe("default");
  });

  test("starts with one default tab", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
      }),
    );

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].id).toBe("default");
    expect(result.current.tabs[0].name).toBe("Query 1");
    expect(result.current.tabs[0].type).toBe("sql");
    expect(result.current.activeTabId).toBe("default");
  });

  test("currentTab returns the active tab", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
      }),
    );

    expect(result.current.currentTab).toBeDefined();
    expect(result.current.currentTab.id).toBe("default");
    expect(result.current.currentTab.id).toBe(result.current.activeTabId);
  });

  test("addTab creates a new tab and sets it active", () => {
    const connection = makeConnection();
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: connection,
        metadata: defaultMetadata,
        schema: [],
      }),
    );

    act(() => {
      result.current.addTab();
    });

    expect(result.current.tabs).toHaveLength(2);
    // The new tab should be the active one
    const newTab = result.current.tabs[1];
    expect(result.current.activeTabId).toBe(newTab.id);
    expect(newTab.name).toBe("Query 2");
    expect(newTab.query).toBe("");
    expect(newTab.result).toBeNull();
    expect(newTab.isExecuting).toBe(false);
  });

  test("closeTab removes a tab when more than 1 tab exists", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
      }),
    );

    // Add a second tab first
    act(() => {
      result.current.addTab();
    });
    expect(result.current.tabs).toHaveLength(2);

    const secondTabId = result.current.tabs[1].id;

    // Close the second tab (not the active one in this case; active is second tab)
    // Active is now the second tab, close the first
    act(() => {
      result.current.closeTab("default", { stopPropagation: () => {} } as React.MouseEvent);
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].id).toBe(secondTabId);
  });

  test("closeTab switches active tab if closing the active one", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
      }),
    );

    // Add a second tab
    act(() => {
      result.current.addTab();
    });

    const secondTabId = result.current.tabs[1].id;
    // Active is now the second tab
    expect(result.current.activeTabId).toBe(secondTabId);

    // Close the active (second) tab
    act(() => {
      result.current.closeTab(secondTabId, { stopPropagation: () => {} } as React.MouseEvent);
    });

    expect(result.current.tabs).toHaveLength(1);
    // Should switch to the remaining tab (the default one)
    expect(result.current.activeTabId).toBe("default");
  });

  test("closeTab does nothing when only 1 tab remains", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
      }),
    );

    expect(result.current.tabs).toHaveLength(1);

    act(() => {
      result.current.closeTab("default", { stopPropagation: () => {} } as React.MouseEvent);
    });

    // Still one tab, nothing changed
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].id).toBe("default");
  });

  test("closeTab does not toast when it can't close the only remaining tab", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
      }),
    );

    act(() => {
      result.current.closeTab("default", { stopPropagation: () => {} } as React.MouseEvent);
    });

    expect(mockToastDefault).not.toHaveBeenCalled();
  });

  test("closeTab offers an Undo toast naming the closed tab", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
      }),
    );

    act(() => {
      result.current.addTab();
    });

    act(() => {
      result.current.closeTab("default", { stopPropagation: () => {} } as React.MouseEvent);
    });

    const { message, options } = lastToastCall();
    expect(message).toContain("Query 1");
    expect(options.action.label).toBe("Undo");
  });

  test("Undo restores the closed tab's query, name and original position", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
      }),
    );

    act(() => {
      result.current.updateTabById("default", { query: "SELECT 1;" });
      result.current.addTab();
    });
    const secondTabId = result.current.tabs[1].id;

    act(() => {
      result.current.closeTab("default", { stopPropagation: () => {} } as React.MouseEvent);
    });
    expect(result.current.tabs).toHaveLength(1);

    act(() => {
      lastToastCall().options.action.onClick();
    });

    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.tabs[0].id).toBe("default");
    expect(result.current.tabs[0].query).toBe("SELECT 1;");
    expect(result.current.tabs[1].id).toBe(secondTabId);
    expect(result.current.activeTabId).toBe("default");
  });

  test("Undo re-activates the closed tab even if another tab is active by then", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
      }),
    );

    act(() => {
      result.current.addTab();
    });
    const secondTabId = result.current.tabs[1].id;

    act(() => {
      result.current.closeTab(secondTabId, { stopPropagation: () => {} } as React.MouseEvent);
    });
    // closeTab fell back to the only remaining tab.
    expect(result.current.activeTabId).toBe("default");

    act(() => {
      lastToastCall().options.action.onClick();
    });

    expect(result.current.activeTabId).toBe(secondTabId);
  });

  test("each Undo restores the tab its own toast names, whichever is clicked first", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
      }),
    );

    act(() => {
      result.current.updateTabById("default", { query: "SELECT 1;" });
      result.current.addTab();
      result.current.addTab();
    });
    const [first, second, third] = result.current.tabs.map((t) => t.id);

    act(() => {
      result.current.closeTab(first, { stopPropagation: () => {} } as React.MouseEvent);
    });
    const firstToast = lastToastCall();
    act(() => {
      result.current.closeTab(second, { stopPropagation: () => {} } as React.MouseEvent);
    });
    const secondToast = lastToastCall();
    expect(firstToast.message).toContain("Query 1");
    expect(secondToast.message).toContain("Query 2");

    // The OLDER toast, clicked while the newer one is still on screen, brings back Query 1.
    act(() => {
      firstToast.options.action.onClick();
    });
    expect(result.current.tabs.map((t) => t.id)).toEqual([first, third]);
    expect(result.current.tabs[0].query).toBe("SELECT 1;");
    expect(result.current.activeTabId).toBe(first);

    act(() => {
      secondToast.options.action.onClick();
    });
    expect(result.current.tabs.map((t) => t.id)).toEqual([first, second, third]);
    expect(result.current.activeTabId).toBe(second);
  });

  test("Undo clicked twice restores the tab once", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
      }),
    );

    act(() => {
      result.current.addTab();
    });
    act(() => {
      result.current.closeTab("default", { stopPropagation: () => {} } as React.MouseEvent);
    });
    const { options } = lastToastCall();

    act(() => {
      options.action.onClick();
    });
    act(() => {
      options.action.onClick();
    });

    expect(result.current.tabs.map((t) => t.id).filter((id) => id === "default")).toHaveLength(1);
    expect(result.current.tabs).toHaveLength(2);
  });

  test("Undo focuses a Source tab reopened since, rather than adding a second with its id", () => {
    const routine: DatabaseObject = { path: ["app", "order_total(integer)"], name: "order_total", kind: "function" };
    const { result } = renderHook(() =>
      useTabManager({ activeConnection: makeConnection(), metadata: defaultMetadata, schema: [] }),
    );

    act(() => {
      result.current.openSourceTab(routine);
    });
    const sourceId = result.current.activeTabId;
    act(() => {
      result.current.closeTab(sourceId, { stopPropagation: () => {} } as React.MouseEvent);
    });
    const { options } = lastToastCall();
    // A Source tab's id is derived from its address, so opening the object again mints the same id.
    act(() => {
      result.current.openSourceTab(routine);
    });
    act(() => {
      result.current.setActiveTabId("default");
    });

    act(() => {
      options.action.onClick();
    });

    expect(result.current.tabs.filter((t) => t.id === sourceId)).toHaveLength(1);
    expect(result.current.activeTabId).toBe(sourceId);
  });

  test("a connection switch dismisses outstanding Undo toasts, and a late click cannot cross", async () => {
    localStorage.setItem(
      "libredb_workspace_tabs_v1:conn-a",
      JSON.stringify({
        activeTabId: "a-1",
        tabs: [
          { id: "a-1", name: "A One", query: "SELECT alpha_only_secret;", type: "sql" },
          { id: "a-2", name: "A Two", query: "SELECT 2;", type: "sql" },
        ],
      }),
    );
    const connA = makeConnection({ id: "conn-a" });
    const connB = makeConnection({ id: "conn-b" });
    const { result, rerender } = renderHook(
      ({ conn }) => useTabManager({ activeConnection: conn, metadata: null, schema: [], persistWorkspace: true }),
      { initialProps: { conn: connA } },
    );
    await waitFor(() => {
      expect(result.current.tabs).toHaveLength(2);
    });

    mockToastDefault.mockImplementationOnce((() => "closed-a-1") as unknown as () => void);
    act(() => {
      result.current.closeTab("a-1", { stopPropagation: () => {} } as React.MouseEvent);
    });
    const { options } = lastToastCall();

    rerender({ conn: connB });
    await waitFor(() => {
      expect(result.current.tabs.map((t) => t.id)).toEqual(["default"]);
    });
    expect(mockToastDismiss).toHaveBeenCalledWith("closed-a-1");

    act(() => {
      options.action.onClick();
    });
    expect(result.current.tabs.map((t) => t.id)).toEqual(["default"]);

    await new Promise((r) => setTimeout(r, 700));
    const parsedB = JSON.parse(localStorage.getItem("libredb_workspace_tabs_v1:conn-b")!) as { tabs: unknown[] };
    expect(parsedB.tabs).toEqual([{ id: "default", name: "Query 1", query: "", type: "sql" }]);
  });

  test("two closes batched into one commit still leave the last tab open", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
      }),
    );

    act(() => {
      result.current.addTab();
    });
    const secondTabId = result.current.tabs[1].id;

    act(() => {
      result.current.closeTab("default", { stopPropagation: () => {} } as React.MouseEvent);
      result.current.closeTab(secondTabId, { stopPropagation: () => {} } as React.MouseEvent);
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.currentTab).toBeDefined();
  });

  test("updateCurrentTab updates the active tab properties", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
      }),
    );

    act(() => {
      result.current.updateCurrentTab({ query: "SELECT 1;", name: "Renamed Tab" });
    });

    expect(result.current.currentTab.query).toBe("SELECT 1;");
    expect(result.current.currentTab.name).toBe("Renamed Tab");
  });

  test("updateTabById updates only the targeted tab query", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
      }),
    );

    act(() => {
      result.current.updateCurrentTab({ query: "SELECT 1;" });
      result.current.addTab();
    });

    const [firstTab, secondTab] = result.current.tabs;
    expect(firstTab.query).toBe("SELECT 1;");
    expect(secondTab.query).toBe("");

    act(() => {
      result.current.updateTabById(firstTab.id, { query: "SELECT 42;" });
    });

    expect(result.current.tabs[0].query).toBe("SELECT 42;");
    expect(result.current.tabs[1].query).toBe("");
  });

  test("handleTableClick creates new tab with query and calls executeQueryFn", () => {
    const connection = makeConnection();
    const executeFn = mock(() => {});

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: connection,
        metadata: defaultMetadata,
        schema: testSchema,
      }),
    );

    act(() => {
      result.current.handleTableClick(["users"], executeFn);
    });

    // New tab should be added
    expect(result.current.tabs).toHaveLength(2);
    const newTab = result.current.tabs[1];
    expect(newTab.name).toBe("users");
    expect(newTab.query).toBe("SELECT * FROM users LIMIT 50;");
    expect(newTab.type).toBe("sql");

    // Active tab should be the new one
    expect(result.current.activeTabId).toBe(newTab.id);

    // executeQueryFn should be called via setTimeout — we need to advance timers
    // The hook uses setTimeout(..., 100), so we wait for it
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(executeFn).toHaveBeenCalledWith("SELECT * FROM users LIMIT 50;", newTab.id);
        resolve();
      }, 150);
    });
  });

  test("handleGenerateSelect creates new tab with SELECT query", () => {
    const connection = makeConnection();
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: connection,
        metadata: defaultMetadata,
        schema: testSchema,
      }),
    );

    act(() => {
      result.current.handleGenerateSelect(["users"]);
    });

    expect(result.current.tabs).toHaveLength(2);
    const newTab = result.current.tabs[1];
    expect(newTab.name).toBe("Query: users");
    expect(newTab.query).toContain("SELECT");
    expect(newTab.query).toContain("users");
    expect(newTab.query).toContain("LIMIT 100");
    expect(newTab.type).toBe("sql");
    expect(result.current.activeTabId).toBe(newTab.id);
  });

  test("setActiveTabId changes the active tab", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
      }),
    );

    // Add a second tab
    act(() => {
      result.current.addTab();
    });

    const secondTabId = result.current.tabs[1].id;
    expect(result.current.activeTabId).toBe(secondTabId);

    // Switch back to the default tab
    act(() => {
      result.current.setActiveTabId("default");
    });

    expect(result.current.activeTabId).toBe("default");
    expect(result.current.currentTab.id).toBe("default");
  });

  test("editingTabId and editingTabName work for tab rename", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
      }),
    );

    // Initially null / empty
    expect(result.current.editingTabId).toBeNull();
    expect(result.current.editingTabName).toBe("");

    // Set editing state
    act(() => {
      result.current.setEditingTabId("default");
      result.current.setEditingTabName("My Custom Query");
    });

    expect(result.current.editingTabId).toBe("default");
    expect(result.current.editingTabName).toBe("My Custom Query");

    // Clear editing state
    act(() => {
      result.current.setEditingTabId(null);
      result.current.setEditingTabName("");
    });

    expect(result.current.editingTabId).toBeNull();
    expect(result.current.editingTabName).toBe("");
  });

  test("addTab uses mongodb type when queryLanguage is json", () => {
    const connection = makeConnection({ type: "mongodb" });
    const mongoMetadata: ProviderMetadata = {
      capabilities: {
        ...defaultMetadata.capabilities,
        queryLanguage: "json" as const,
      },
      labels: defaultMetadata.labels,
    } as ProviderMetadata;

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: connection,
        metadata: mongoMetadata,
        schema: [],
      }),
    );

    act(() => {
      result.current.addTab();
    });

    const newTab = result.current.tabs[1];
    expect(newTab.type).toBe("mongodb");
  });

  // ─── Persistence: Load Effect ───

  test("load — empty storage with persistWorkspace defaults to DEFAULT_TAB", async () => {
    // No data in localStorage for this key
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
        persistWorkspace: true,
      }),
    );

    await waitFor(() => {
      expect(result.current.tabs).toHaveLength(1);
      expect(result.current.tabs[0].id).toBe("default");
      expect(result.current.activeTabId).toBe("default");
    });
  });

  test("load — corrupted JSON falls back to DEFAULT_TAB", async () => {
    localStorage.setItem("libredb_workspace_tabs_v1:default", "<<<INVALID JSON>>>");

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
        persistWorkspace: true,
      }),
    );

    await waitFor(() => {
      expect(result.current.tabs).toHaveLength(1);
      expect(result.current.tabs[0].id).toBe("default");
      expect(result.current.activeTabId).toBe("default");
    });
  });

  test("load — empty tabs array falls back to DEFAULT_TAB", async () => {
    localStorage.setItem("libredb_workspace_tabs_v1:default", JSON.stringify({ activeTabId: "x", tabs: [] }));

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
        persistWorkspace: true,
      }),
    );

    await waitFor(() => {
      expect(result.current.tabs).toHaveLength(1);
      expect(result.current.tabs[0].id).toBe("default");
    });
  });

  test("load — stored activeTabId not in tabs falls back to first tab", async () => {
    localStorage.setItem(
      "libredb_workspace_tabs_v1:default",
      JSON.stringify({
        activeTabId: "non-existent-id",
        tabs: [
          { id: "tab-a", name: "A", query: "SELECT 1;", type: "sql" },
          { id: "tab-b", name: "B", query: "SELECT 2;", type: "sql" },
        ],
      }),
    );

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
        persistWorkspace: true,
      }),
    );

    await waitFor(() => {
      expect(result.current.tabs).toHaveLength(2);
      expect(result.current.activeTabId).toBe("tab-a");
    });
  });

  test("restores tabs and active tab from workspace storage", async () => {
    localStorage.setItem(
      "libredb_workspace_tabs_v1:default",
      JSON.stringify({
        activeTabId: "tab-2",
        tabs: [
          { id: "tab-1", name: "Query 1", query: "SELECT 1;", type: "sql" },
          { id: "tab-2", name: "Query 2", query: "SELECT 2;", type: "sql" },
        ],
      }),
    );

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
        persistWorkspace: true,
      }),
    );

    await waitFor(() => {
      expect(result.current.tabs).toHaveLength(2);
      expect(result.current.activeTabId).toBe("tab-2");
      expect(result.current.currentTab.query).toBe("SELECT 2;");
    });
  });

  test("persists query updates into workspace storage after debounce", async () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ id: "persist-conn" }),
        metadata: null,
        schema: [],
        persistWorkspace: true,
      }),
    );

    act(() => {
      result.current.updateCurrentTab({ query: "SELECT now();" });
    });

    // Save is debounced by 500ms — wait for it to flush
    await waitFor(
      () => {
        const raw = localStorage.getItem("libredb_workspace_tabs_v1:persist-conn");
        expect(raw).toBeTruthy();

        const parsed = JSON.parse(raw || "{}") as {
          activeTabId: string;
          tabs: Array<{ query: string }>;
        };

        expect(parsed.activeTabId).toBe(result.current.activeTabId);
        expect(parsed.tabs[0].query).toBe("SELECT now();");
      },
      { timeout: 2000 },
    );
  });

  test("debounce — rapid updates only persist final state", async () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ id: "debounce-conn" }),
        metadata: null,
        schema: [],
        persistWorkspace: true,
      }),
    );

    // Rapid-fire 3 updates within debounce window
    act(() => {
      result.current.updateCurrentTab({ query: "first" });
    });
    act(() => {
      result.current.updateCurrentTab({ query: "second" });
    });
    act(() => {
      result.current.updateCurrentTab({ query: "third" });
    });

    await waitFor(
      () => {
        const raw = localStorage.getItem("libredb_workspace_tabs_v1:debounce-conn");
        expect(raw).toBeTruthy();
        const parsed = JSON.parse(raw!) as { tabs: Array<{ query: string }> };
        expect(parsed.tabs[0].query).toBe("third");
      },
      { timeout: 2000 },
    );
  });

  test("connection switch race — old tabs not saved to new connection key", async () => {
    // Seed connection A with tabs
    localStorage.setItem(
      "libredb_workspace_tabs_v1:conn-a",
      JSON.stringify({
        activeTabId: "a-tab",
        tabs: [{ id: "a-tab", name: "A Tab", query: "SELECT a;", type: "sql" }],
      }),
    );

    const connA = makeConnection({ id: "conn-a" });
    const connB = makeConnection({ id: "conn-b" });

    // Start with connection A
    const { result, rerender } = renderHook(
      ({ conn }) =>
        useTabManager({
          activeConnection: conn,
          metadata: null,
          schema: [],
          persistWorkspace: true,
        }),
      { initialProps: { conn: connA } },
    );

    // Wait for load to finish
    await waitFor(() => {
      expect(result.current.tabs).toHaveLength(1);
      expect(result.current.tabs[0].query).toBe("SELECT a;");
    });

    // Switch to connection B (which has no saved workspace)
    rerender({ conn: connB });

    // Wait for load to set defaults for B
    await waitFor(() => {
      expect(result.current.tabs[0].id).toBe("default");
    });

    // Wait for any potential debounced saves to flush
    await new Promise((r) => setTimeout(r, 700));

    // Connection B's storage should only have the default tab, not A's tabs
    const rawB = localStorage.getItem("libredb_workspace_tabs_v1:conn-b");
    expect(rawB).toBeTruthy();
    const parsedB = JSON.parse(rawB!) as { tabs: Array<{ query: string }> };
    expect(parsedB.tabs[0].query).toBe("");

    // Connection A's storage should still be intact
    const rawA = localStorage.getItem("libredb_workspace_tabs_v1:conn-a");
    expect(rawA).toBeTruthy();
    const parsedA = JSON.parse(rawA!) as { tabs: Array<{ query: string }> };
    expect(parsedA.tabs[0].query).toBe("SELECT a;");
  });

  // ─── Functionality: Fallback & Edge Cases ───

  test("currentTab falls back to tabs[0] when activeTabId is stale", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: null,
        metadata: null,
        schema: [],
      }),
    );

    // Force a stale activeTabId via setActiveTabId
    act(() => {
      result.current.setActiveTabId("non-existent-id");
    });

    // currentTab should fall back to tabs[0]
    expect(result.current.currentTab).toBeDefined();
    expect(result.current.currentTab.id).toBe("default");
  });

  test("handleTableClick without metadata uses fallback query", () => {
    const executeFn = mock(() => {});
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection(),
        metadata: null,
        schema: testSchema,
      }),
    );

    act(() => {
      result.current.handleTableClick(["users"], executeFn);
    });

    const newTab = result.current.tabs[1];
    expect(newTab.query).toBe("SELECT * FROM users LIMIT 50;");
    expect(newTab.type).toBe("sql");
    expect(newTab.name).toBe("users");
  });

  test("handleTableClick with MongoDB metadata creates mongodb tab", () => {
    const executeFn = mock(() => {});
    const mongoMetadata: ProviderMetadata = {
      capabilities: {
        ...defaultMetadata.capabilities,
        queryLanguage: "json" as const,
      },
      labels: defaultMetadata.labels,
    } as ProviderMetadata;

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ type: "mongodb" }),
        metadata: mongoMetadata,
        schema: [],
      }),
    );

    act(() => {
      result.current.handleTableClick(["users"], executeFn);
    });

    const newTab = result.current.tabs[1];
    expect(newTab.type).toBe("mongodb");
    expect(newTab.query).toContain('"collection": "users"');
    expect(newTab.query).toContain('"operation": "find"');
  });

  test("handleGenerateSelect without metadata uses fallback SELECT", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection(),
        metadata: null,
        schema: testSchema,
      }),
    );

    act(() => {
      result.current.handleGenerateSelect(["users"]);
    });

    const newTab = result.current.tabs[1];
    expect(newTab.query).toContain("SELECT");
    expect(newTab.query).toContain("id");
    expect(newTab.query).toContain("name");
    expect(newTab.query).toContain("LIMIT 100;");
    expect(newTab.type).toBe("sql");
  });

  test("handleGenerateSelect for unknown table uses * for columns", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection(),
        metadata: null,
        schema: [], // empty schema — table not found
      }),
    );

    act(() => {
      result.current.handleGenerateSelect(["unknown_table"]);
    });

    const newTab = result.current.tabs[1];
    expect(newTab.query).toContain("  *");
    expect(newTab.query).toContain("FROM unknown_table");
  });

  test("handleGenerateSelect with MongoDB metadata creates mongodb tab", () => {
    const mongoMetadata: ProviderMetadata = {
      capabilities: {
        ...defaultMetadata.capabilities,
        queryLanguage: "json" as const,
      },
      labels: defaultMetadata.labels,
    } as ProviderMetadata;

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ type: "mongodb" }),
        metadata: mongoMetadata,
        schema: testSchema,
      }),
    );

    act(() => {
      result.current.handleGenerateSelect(["users"]);
    });

    const newTab = result.current.tabs[1];
    expect(newTab.type).toBe("mongodb");
    expect(newTab.query).toContain('"collection": "users"');
    expect(newTab.query).toContain('"operation": "find"');
  });
});

// ─── Redis: dialect-aware tab type and type-aware generation (#427) ───

describe("useTabManager — Redis dialect", () => {
  const redisMetadata: ProviderMetadata = {
    capabilities: {
      ...defaultMetadata.capabilities,
      queryLanguage: "json" as const,
      queryDialect: "redis" as const,
      defaultPort: 6379,
    },
    labels: defaultMetadata.labels,
  } as ProviderMetadata;

  // The provider's schema nodes: a `:`-prefix grouping and a bare key, each
  // carrying the sampled Redis type on the `type` column (redis.ts getSchema).
  const redisSchema: DetailedObject[] = [
    {
      name: "session:*",
      kind: "table",
      path: ["session:*"],
      columns: [
        { name: "key", type: "string", nullable: false, isPrimary: true },
        { name: "type", type: "hash", nullable: false, isPrimary: false },
        { name: "value", type: "hash", nullable: true, isPrimary: false },
      ],
      indexes: [],
    },
    {
      name: "counter",
      kind: "table",
      path: ["counter"],
      columns: [
        { name: "key", type: "string", nullable: false, isPrimary: true },
        { name: "type", type: "hash", nullable: false, isPrimary: false },
        { name: "value", type: "hash", nullable: true, isPrimary: false },
      ],
      indexes: [],
    },
  ];

  beforeEach(() => {
    localStorage.clear();
  });

  test("addTab creates a redis tab type", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ type: "redis", port: 6379 }),
        metadata: redisMetadata,
        schema: redisSchema,
      }),
    );

    act(() => {
      result.current.addTab();
    });

    expect(result.current.tabs[1].type).toBe("redis");
  });

  test("handleTableClick creates a redis tab and passes the table's columns to the generator", () => {
    const executeFn = mock(() => {});
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ type: "redis", port: 6379 }),
        metadata: redisMetadata,
        schema: redisSchema,
      }),
    );

    act(() => {
      result.current.handleTableClick(["session:*"], executeFn);
    });

    const newTab = result.current.tabs[1];
    expect(newTab.type).toBe("redis");
    expect(newTab.query).toBe("SCAN 0 MATCH session:* COUNT 50");
  });

  test("handleTableClick on a bare key uses the sampled type from its columns", () => {
    const executeFn = mock(() => {});
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ type: "redis", port: 6379 }),
        metadata: redisMetadata,
        schema: redisSchema,
      }),
    );

    act(() => {
      result.current.handleTableClick(["counter"], executeFn);
    });

    expect(result.current.tabs[1].query).toBe("HGETALL counter");
  });

  test("handleGenerateSelect creates a redis tab", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ type: "redis", port: 6379 }),
        metadata: redisMetadata,
        schema: redisSchema,
      }),
    );

    act(() => {
      result.current.handleGenerateSelect(["session:*"]);
    });

    const newTab = result.current.tabs[1];
    expect(newTab.type).toBe("redis");
    expect(newTab.query).toContain("SCAN 0 MATCH session:* COUNT 50");
    expect(newTab.query).not.toContain('"collection"');
  });
});

// ============================================================================
// The click path is addressed by PATH (#789, Task 30)
// ============================================================================

describe("useTabManager addresses an object by its path", () => {
  /**
   * Two objects called `customers`, one in each schema, with DIFFERENT columns. A lookup
   * by name cannot tell them apart and takes the first; a lookup by path takes the one
   * that was clicked. The columns are what makes the two answers visibly different.
   */
  const twoSchemas: DetailedObject[] = [
    {
      name: "customers",
      kind: "table",
      path: ["dbo", "customers"],
      columns: [{ name: "dbo_only", type: "int", nullable: false, isPrimary: true }],
      indexes: [],
    },
    {
      name: "customers",
      kind: "table",
      path: ["app", "customers"],
      columns: [{ name: "app_only", type: "int", nullable: false, isPrimary: true }],
      indexes: [],
    },
  ];

  test("a table outside the default container generates a QUALIFIED statement", () => {
    const executeFn = mock(() => {});
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ type: "mssql", port: 1433 }),
        metadata: { ...defaultMetadata, capabilities: { ...defaultMetadata.capabilities, defaultPort: 1433 } },
        schema: twoSchemas,
      }),
    );

    act(() => {
      result.current.handleTableClick(["libredb_objects", "app", "customers"], executeFn);
    });

    const newTab = result.current.tabs[1];
    expect(newTab.query).toBe("SELECT TOP 50 * FROM libredb_objects.app.customers;");
    // The tab is still LABELLED with the object's own segment.
    expect(newTab.name).toBe("customers");
  });

  test("the columns are joined on the PATH, so two same-named tables do not collide", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection(),
        metadata: defaultMetadata,
        schema: twoSchemas,
      }),
    );

    act(() => {
      result.current.handleGenerateSelect(["app", "customers"]);
    });

    const newTab = result.current.tabs[1];
    expect(newTab.query).toContain("app_only");
    expect(newTab.query).not.toContain("dbo_only");
    expect(newTab.query).toContain("FROM app.customers");
  });

  /**
   * `handleTableClick` has a lookup of its own, and only the Redis dialect reads what it
   * finds: the reader a key gets comes from its SAMPLED TYPE, which lives on the schema
   * node's columns (#427). So this is the one shape that can tell the two joins apart in
   * that handler - two keys with one name, in two databases, with different types.
   */
  test("handleTableClick joins on the path too, so a same-named key gets ITS OWN reader", () => {
    const executeFn = mock(() => {});
    const redisTwoDatabases: DetailedObject[] = [
      {
        name: "counter",
        kind: "key",
        path: ["0", "counter"],
        columns: [{ name: "type", type: "string", nullable: false, isPrimary: false }],
        indexes: [],
      },
      {
        name: "counter",
        kind: "key",
        path: ["1", "counter"],
        columns: [{ name: "type", type: "hash", nullable: false, isPrimary: false }],
        indexes: [],
      },
    ];
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ type: "redis", port: 6379 }),
        metadata: {
          ...defaultMetadata,
          capabilities: {
            ...defaultMetadata.capabilities,
            queryLanguage: "json",
            queryDialect: "redis",
            defaultPort: 6379,
          },
        },
        schema: redisTwoDatabases,
      }),
    );

    act(() => {
      result.current.handleTableClick(["1", "counter"], executeFn);
    });

    expect(result.current.tabs[1].query).toBe("HGETALL counter");
  });

  test("without capabilities the fallback statement is qualified too", () => {
    const executeFn = mock(() => {});
    const { result } = renderHook(() =>
      useTabManager({ activeConnection: makeConnection(), metadata: null, schema: twoSchemas }),
    );

    act(() => {
      result.current.handleTableClick(["app", "customers"], executeFn);
    });

    expect(result.current.tabs[1].query).toBe("SELECT * FROM app.customers LIMIT 50;");
  });
});

/**
 * The Source tab (#789 Phase 2).
 *
 * A Source tab carries an ADDRESS and never the text. The reason is arithmetic rather than
 * taste: `PersistedTabState` is one `JSON.stringify` of the whole workspace written by a
 * `setItem` with no `try`/`catch` inside a 500 ms timer, against an origin quota of about
 * 5 MiB that ten other collections already share. A definition the user did not type, put
 * into a persisted text field, is a `QuotaExceededError` waiting for a large enough object,
 * and the observable symptom is not a broken Source tab: it is that tab persistence silently
 * stops for EVERYTHING. So a restored Source tab re-reads, and the assertions below pin the
 * address travelling and the document not.
 */
describe("useTabManager opens a Source tab", () => {
  const orderTotal: DatabaseObject = {
    path: ["app", "order_total(integer)"],
    name: "order_total",
    kind: "function",
  };

  test("opens a tab carrying the ADDRESS and nothing else, and activates it", () => {
    const { result } = renderHook(() =>
      useTabManager({ activeConnection: makeConnection(), metadata: defaultMetadata, schema: [] }),
    );

    act(() => {
      result.current.openSourceTab(orderTotal);
    });

    expect(result.current.tabs).toHaveLength(2);
    const tab = result.current.tabs[1];
    expect(result.current.activeTabId).toBe(tab.id);
    expect(tab.source).toEqual({ path: ["app", "order_total(integer)"], kind: "function" });
    // The whole address and the whole label: the tab is named after the QUALIFIED path,
    // because two containers may hold a routine of the same name and the tab strip is the
    // only place a reader can tell two open Source tabs apart.
    expect(tab.name).toBe("Source: app.order_total(integer)");
    // No document, no failure, no read token: the viewer is what reads, and it reads because
    // the tab carries neither a document nor a failure.
    expect(tab.source?.document).toBeUndefined();
    expect(tab.source?.failure).toBeUndefined();
    expect(tab.source?.readAtToken).toBeUndefined();
    expect(tab.query).toBe("");
    expect(tab.result).toBeNull();
  });

  test("a second View Source on the same object FOCUSES the open tab instead of minting one", () => {
    const { result } = renderHook(() =>
      useTabManager({ activeConnection: makeConnection(), metadata: defaultMetadata, schema: [] }),
    );

    act(() => {
      result.current.openSourceTab(orderTotal);
    });
    const first = result.current.tabs[1].id;
    act(() => {
      result.current.setActiveTabId("default");
    });
    act(() => {
      result.current.openSourceTab({ ...orderTotal, name: "a different label entirely" });
    });

    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.activeTabId).toBe(first);
  });

  test("the match is on the path and the KIND, so one name in two roles opens two tabs", () => {
    // Measured on MySQL, MariaDB and DuckDB: one name addresses more than one object of
    // different kinds in one container. Matching on the path alone would show a reader the
    // procedure's definition when they asked for the table's.
    const { result } = renderHook(() =>
      useTabManager({ activeConnection: makeConnection(), metadata: defaultMetadata, schema: [] }),
    );

    act(() => {
      result.current.openSourceTab({ path: ["app", "audit"], name: "audit", kind: "table" });
    });
    act(() => {
      result.current.openSourceTab({ path: ["app", "audit"], name: "audit", kind: "procedure" });
    });

    expect(result.current.tabs).toHaveLength(3);
    expect(result.current.tabs.map((tab) => tab.source?.kind)).toEqual([undefined, "table", "procedure"]);
  });

  test("the match is on pathKey and never on a joined string, so two depths cannot collide", () => {
    // Standing ruling 5g. `["a.b"]` and `["a", "b"]` are different objects on every engine
    // that admits a dot in an identifier, and a key built by joining on "." says they are one.
    const { result } = renderHook(() =>
      useTabManager({ activeConnection: makeConnection(), metadata: defaultMetadata, schema: [] }),
    );

    act(() => {
      result.current.openSourceTab({ path: ["a.b"], name: "a.b", kind: "view" });
    });
    act(() => {
      result.current.openSourceTab({ path: ["a", "b"], name: "b", kind: "view" });
    });

    expect(result.current.tabs).toHaveLength(3);
    expect(result.current.tabs[2].source?.path).toEqual(["a", "b"]);
  });

  test("a tab that is NOT a Source tab is never matched, whatever it is called", () => {
    const { result } = renderHook(() =>
      useTabManager({ activeConnection: makeConnection(), metadata: defaultMetadata, schema: [] }),
    );

    act(() => {
      result.current.updateCurrentTab({ name: "Source: app.order_total(integer)" });
    });
    act(() => {
      result.current.openSourceTab(orderTotal);
    });

    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.tabs[1].source).toBeDefined();
  });

  test("persists the ADDRESS and never the document", async () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ id: "source-persist" }),
        metadata: defaultMetadata,
        schema: [],
        persistWorkspace: true,
      }),
    );

    act(() => {
      result.current.openSourceTab(orderTotal);
    });
    const tabId = result.current.tabs[1].id;
    // A document the size of a real definition, put on the tab the way the viewer puts it.
    act(() => {
      result.current.updateTabById(tabId, {
        source: {
          path: orderTotal.path,
          kind: "function",
          activePartId: "definition",
          readAtToken: 3,
          document: {
            path: orderTotal.path,
            kind: "function",
            parts: [
              {
                id: "definition",
                label: "Function",
                text: "CREATE FUNCTION order_total(integer) RETURNS numeric AS $$ SELECT 1 $$;",
                language: "sql",
                form: "complete",
                origin: "regenerated",
              },
            ],
          },
        },
      });
    });

    await waitFor(
      () => {
        const raw = localStorage.getItem("libredb_workspace_tabs_v1:source-persist");
        expect(raw).toBeTruthy();
        const parsed = JSON.parse(raw ?? "{}") as { tabs: Array<Record<string, unknown>> };
        const persisted = parsed.tabs[1];
        expect(persisted.source).toEqual({ path: ["app", "order_total(integer)"], kind: "function" });
        // The whole record, so a field added to `SourceTabState` later cannot ride along
        // into storage unnoticed: the text is what the quota cannot take.
        expect(raw).not.toContain("CREATE FUNCTION");
        expect(raw).not.toContain("activePartId");
        expect(raw).not.toContain("readAtToken");
      },
      { timeout: 2000 },
    );
  });

  test("a restored Source tab carries the address and NO document, so it re-reads", async () => {
    localStorage.setItem(
      "libredb_workspace_tabs_v1:source-restore",
      JSON.stringify({
        activeTabId: "tab-src",
        tabs: [
          { id: "tab-1", name: "Query 1", query: "SELECT 1;", type: "sql" },
          {
            id: "tab-src",
            name: "Source: app.order_total(integer)",
            query: "",
            type: "sql",
            source: { path: ["app", "order_total(integer)"], kind: "function" },
          },
        ],
      }),
    );

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ id: "source-restore" }),
        metadata: defaultMetadata,
        schema: [],
        persistWorkspace: true,
      }),
    );

    await waitFor(() => {
      expect(result.current.tabs).toHaveLength(2);
      expect(result.current.currentTab.id).toBe("tab-src");
    });
    expect(result.current.currentTab.source).toEqual({ path: ["app", "order_total(integer)"], kind: "function" });
    expect(result.current.currentTab.source?.document).toBeUndefined();
    // The control: an ordinary tab beside it restores exactly as it always did, with no
    // `source` key invented for it.
    expect(result.current.tabs[0].source).toBeUndefined();
    expect(result.current.tabs[0].query).toBe("SELECT 1;");
  });

  test("two opens of the SAME object inside one batch mint one tab, not two", () => {
    // Round 1 finding 3. The dedup used to read the `tabs` of the render that installed the
    // callback and append with `setTabs(prev => ...)`, so two calls inside ONE React batch
    // both saw the pre-batch list, both missed, and both appended: the tab strip then held
    // two tabs with identical names, the first orphaned and read by nothing. Two separate
    // DOM events flush between them, which is why no gesture in the shell could reach it and
    // why the dedup test above, which switches tabs in between, cannot see it either. Task
    // 20's embedded adapter calls this same function from a host callback, where a batch of
    // two is not exotic.
    const { result } = renderHook(() =>
      useTabManager({ activeConnection: makeConnection(), metadata: defaultMetadata, schema: [] }),
    );

    act(() => {
      result.current.openSourceTab(orderTotal);
      result.current.openSourceTab(orderTotal);
    });

    expect(result.current.tabs.map((tab) => tab.name)).toEqual(["Query 1", "Source: app.order_total(integer)"]);
    expect(result.current.activeTabId).toBe(result.current.tabs[1].id);
  });

  test("two opens of two DIFFERENT objects inside one batch mint both, and the last is active", () => {
    // The control for the test above: the fix must not turn a batch into a single append.
    const { result } = renderHook(() =>
      useTabManager({ activeConnection: makeConnection(), metadata: defaultMetadata, schema: [] }),
    );

    act(() => {
      result.current.openSourceTab(orderTotal);
      result.current.openSourceTab({ path: ["app", "order_summary"], name: "order_summary", kind: "view" });
    });

    expect(result.current.tabs.map((tab) => tab.name)).toEqual([
      "Query 1",
      "Source: app.order_total(integer)",
      "Source: app.order_summary",
    ]);
    expect(result.current.activeTabId).toBe(result.current.tabs[2].id);
  });

  test("a stored tab whose source key is missing restores as an ordinary tab", async () => {
    // Every record written before this field existed is this case, and there is no migration:
    // the absence has to read as "not a Source tab" rather than as an empty address.
    localStorage.setItem(
      "libredb_workspace_tabs_v1:source-legacy",
      JSON.stringify({ activeTabId: "old", tabs: [{ id: "old", name: "Query 1", query: "SELECT 1;", type: "sql" }] }),
    );

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ id: "source-legacy" }),
        metadata: defaultMetadata,
        schema: [],
        persistWorkspace: true,
      }),
    );

    await waitFor(() => expect(result.current.currentTab.id).toBe("old"));
    expect(result.current.currentTab.source).toBeUndefined();
  });

  test("View Source on an object whose RESTORED tab is already open focuses it and mints nothing", async () => {
    /*
     * The id a Source tab gets from this hook is derived from its address, and this is the
     * one case where the open tab's id was NOT chosen by this hook: a workspace restored from
     * `localStorage` keeps whatever id the record carried, including one written before the
     * id was derived at all. Without the find against the committed list, the open tab is
     * matched by nothing, the derived id names no tab, and the reader lands on `tabs[0]`.
     */
    localStorage.setItem(
      "libredb_workspace_tabs_v1:source-focus",
      JSON.stringify({
        activeTabId: "tab-1",
        tabs: [
          { id: "tab-1", name: "Query 1", query: "", type: "sql" },
          {
            id: "a-minted-id-from-an-older-record",
            name: "Source: app.order_total(integer)",
            query: "",
            type: "sql",
            source: { path: ["app", "order_total(integer)"], kind: "function" },
          },
        ],
      }),
    );

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ id: "source-focus" }),
        metadata: defaultMetadata,
        schema: [],
        persistWorkspace: true,
      }),
    );

    await waitFor(() => expect(result.current.tabs).toHaveLength(2));
    act(() => {
      result.current.openSourceTab(orderTotal);
    });

    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.activeTabId).toBe("a-minted-id-from-an-older-record");
    expect(result.current.currentTab.id).toBe("a-minted-id-from-an-older-record");
  });

  test("a stored source that is not an ADDRESS is dropped, and the tab restores as an ordinary one", async () => {
    /*
     * Round 1 finding 2, and it is a crash class this field introduced rather than a
     * tightening of one that already existed.
     *
     * The other persisted fields are strings that nothing dereferences, so a hand-edited or
     * truncated `name` is at worst a wrong label. `source` is the first persisted field that
     * is DEREFERENCED: the shell branches its whole editor pane on it, and the viewer
     * computes `pathKey(path)` at the top of its body. MEASURED before the check existed: a
     * stored `source: {}` restored as a tab whose `source` was `{}`, the pane took the source
     * arm, and `pathKey(undefined)` threw "undefined is not an object (evaluating
     * path.join)". There is no error boundary around that pane, so the whole shell
     * white-screens and the reader cannot reach the tab strip to close the offending tab.
     *
     * `source: null` was safe only by accident: it throws inside the LOAD effect's own
     * try/catch and degrades to one empty tab, which loses every OTHER tab in the workspace.
     * All five shapes below are now dropped key by key, so the rest of the record survives.
     */
    localStorage.setItem(
      "libredb_workspace_tabs_v1:source-shapes",
      JSON.stringify({
        activeTabId: "keep",
        tabs: [
          { id: "empty", name: "A", query: "", type: "sql", source: {} },
          { id: "null", name: "B", query: "", type: "sql", source: null },
          { id: "string-path", name: "C", query: "", type: "sql", source: { path: "app.f", kind: "function" } },
          { id: "no-kind", name: "D", query: "", type: "sql", source: { path: ["app", "f"] } },
          { id: "kind-number", name: "E", query: "", type: "sql", source: { path: ["app", "f"], kind: 7 } },
          {
            id: "keep",
            name: "Source: app.order_total(integer)",
            query: "",
            type: "sql",
            source: { path: ["app", "order_total(integer)"], kind: "function" },
          },
        ],
      }),
    );

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ id: "source-shapes" }),
        metadata: defaultMetadata,
        schema: [],
        persistWorkspace: true,
      }),
    );

    await waitFor(() => expect(result.current.tabs).toHaveLength(6));
    // Every malformed address is gone, and the tab it was attached to is still here: a bad
    // key costs its own tab's source arm and nothing else in the workspace.
    expect(result.current.tabs.filter((tab) => tab.source !== undefined).map((tab) => tab.id)).toEqual(["keep"]);
    expect(result.current.tabs.map((tab) => tab.name)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "Source: app.order_total(integer)",
    ]);
    // The control, in the same record: a well-formed address survives untouched, so the
    // assertion above cannot pass by dropping every source key.
    expect(result.current.currentTab.source).toEqual({ path: ["app", "order_total(integer)"], kind: "function" });
  });

  test("a stored source carrying EXTRA keys restores as the address alone", async () => {
    // A record written by a future version, or hand-edited: the document is exactly what this
    // field refuses to carry, so restoring one would put a text nobody re-read back on screen
    // under a caption claiming it was read from the server.
    localStorage.setItem(
      "libredb_workspace_tabs_v1:source-extra",
      JSON.stringify({
        activeTabId: "t",
        tabs: [
          {
            id: "t",
            name: "Source: app.f",
            query: "",
            type: "sql",
            source: {
              path: ["app", "f"],
              kind: "function",
              document: { path: ["app", "f"], kind: "function", parts: [] },
              failure: "stale",
              activePartId: "definition",
              readAtToken: 3,
            },
          },
        ],
      }),
    );

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ id: "source-extra" }),
        metadata: defaultMetadata,
        schema: [],
        persistWorkspace: true,
      }),
    );

    await waitFor(() => expect(result.current.currentTab.id).toBe("t"));
    expect(result.current.currentTab.source).toEqual({ path: ["app", "f"], kind: "function" });
  });
});
