import "../setup-dom";

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";

// Shared mocks — process-wide singletons (no contamination)
import { mockToastDefault, mockToastDismiss } from "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { useTabManager, PREVIEW_PAGE_SIZE } from "@/hooks/use-tab-manager";
import type { DatabaseConnection } from "@/lib/types";
import type { DetailedObject } from "@/lib/db/detailed-object";
import type { DatabaseObject } from "@/lib/db/types";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import { EtcdProvider } from "@/lib/db/providers/keyvalue/etcd/index";
import { InfluxDB3Provider, InfluxDBProvider } from "@/lib/db/providers/timeseries/influxdb/index";
import { evaluateInfluxql } from "@/lib/db/providers/timeseries/influxdb/influxql-policy";

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

/**
 * The same labels over a Redis-shaped declaration.
 *
 * `queryDialect: "redis"` is what routes generation to the command grammar (#427); the labels are the
 * postgres ones because nothing under test reads them, and copying twenty strings would suggest it
 * does.
 */
const redisMetadata = {
  capabilities: {
    ...defaultMetadata.capabilities,
    queryLanguage: "json",
    queryDialect: "redis",
    defaultPort: 6379,
  },
  labels: defaultMetadata.labels,
} as ProviderMetadata;

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
      capabilities: {
        ...defaultMetadata.capabilities,
        queryLanguage: "json" as const,
        containerLevels: [{ id: "schema", label: "Database", labelPlural: "Databases" }] as const,
      },
    };
    const { result } = renderHook(() =>
      useTabManager({ activeConnection: makeConnection({ type: "mongodb" }), metadata, schema: [] }),
    );
    act(() => result.current.handleGenerateCount(["shop", "orders"]));
    expect(result.current.tabs[1].type).toBe("mongodb");
    // The database rides as its own key (#843), or the count answers for the connected one.
    expect(JSON.parse(result.current.tabs[1].query)).toEqual({
      database: "shop",
      collection: "orders",
      operation: "count",
      filter: {},
    });
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

  // X5: the shell hands `closeTab` to the memoized tab bar and `updateCurrentTab` to the
  // memoized mobile header, so a keystroke, which writes the query into the tabs, must not
  // mint either of them anew. `closeTab` must still close against the tabs as they are now.
  test("a query write keeps closeTab and updateCurrentTab, and closeTab reads the latest tabs", () => {
    const { result } = renderHook(() => useTabManager({ activeConnection: null, metadata: null, schema: [] }));
    act(() => {
      result.current.addTab();
    });
    const closeTab = result.current.closeTab;
    const updateCurrentTab = result.current.updateCurrentTab;

    act(() => {
      result.current.updateCurrentTab({ query: "SELECT 1" });
    });
    expect(result.current.closeTab).toBe(closeTab);
    expect(result.current.updateCurrentTab).toBe(updateCurrentTab);

    const secondTabId = result.current.tabs[1].id;
    act(() => {
      closeTab(secondTabId, { stopPropagation: () => {} } as React.MouseEvent);
    });
    expect(result.current.tabs.map((tab) => tab.id)).toEqual(["default"]);
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
    // No row bound in the TEXT (#816): the preview cap rides the execution option below,
    // so nothing downstream has to guess whether a bound in the statement was ours.
    expect(newTab.query).toBe("SELECT * FROM users;");
    expect(newTab.type).toBe("sql");

    // Active tab should be the new one
    expect(result.current.activeTabId).toBe(newTab.id);

    // executeQueryFn should be called via setTimeout — we need to advance timers
    // The hook uses setTimeout(..., 100), so we wait for it
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(executeFn).toHaveBeenCalledWith("SELECT * FROM users;", newTab.id, false, {
          limit: PREVIEW_PAGE_SIZE,
        });
        expect(PREVIEW_PAGE_SIZE).toBe(50);
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

  /**
   * A key activated in the key browser.
   *
   * A key is NOT a schema node — the cache this hook looks objects up in holds prefix groups — so its
   * type is handed in. The two tests below are the pair that makes the parameter load-bearing: the
   * same path, the same cache, and the only difference is whether the caller knew the type.
   */
  test("handleTableClick generates from columns the caller supplies", () => {
    const executeFn = mock(() => {});
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ type: "redis", port: 6379 }),
        metadata: redisMetadata,
        schema: testSchema,
      }),
    );

    act(() => {
      result.current.handleTableClick(["videobackend:login:refreshToken:1"], executeFn, [
        { name: "type", type: "hash", nullable: false, isPrimary: false },
      ]);
    });

    // A READ, because the type was known: `HGETALL` rather than a probe for what the value is.
    expect(result.current.tabs[1].query).toBe("HGETALL videobackend:login:refreshToken:1");
  });

  test("handleTableClick falls back to the type probe for a key nobody described", () => {
    const executeFn = mock(() => {});
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ type: "redis", port: 6379 }),
        metadata: redisMetadata,
        schema: testSchema,
      }),
    );

    act(() => {
      result.current.handleTableClick(["videobackend:login:refreshToken:1"], executeFn);
    });

    // The generator's own unknown branch (#427), reached because no schema node holds this key: the
    // editor opens on a command that FINDS OUT what the key is, which is the honest answer when
    // nobody knows — and it is exactly what the shell avoids by passing the type the page carried.
    expect(result.current.tabs[1].query).toBe("TYPE videobackend:login:refreshToken:1");
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
    // The fallback statement loses its bound with the generated ones (#816).
    expect(newTab.query).toBe("SELECT * FROM users;");
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
// PromQL: a metric opens by its selector (#1085)
// ============================================================================

describe("useTabManager on a PromQL connection (#1085)", () => {
  // The capabilities #1085 section 6.3 gives Prometheus, where they differ from the SQL default above.
  // The connection keeps the helper's own type: nothing on this path reads the type id, which is
  // the rule the generators keep.
  const promqlMetadata: ProviderMetadata = {
    capabilities: {
      ...defaultMetadata.capabilities,
      queryLanguage: "promql" as const,
      defaultPort: 9090,
      statementTerminator: "none" as const,
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsMaintenance: false,
      supportsConnectionString: false,
    },
    // The SQL labels as they are: nothing here reads them, and `ProviderMetadata.labels` is
    // optional, so spreading it would type every label optional.
    labels: defaultMetadata.labels,
  };

  // A metric as the inventory lists it: its label names, then timestamp and value (#1085, section 4.2).
  const metricSchema: DetailedObject[] = [
    {
      name: "http_requests_total",
      kind: "metric",
      path: ["http_requests_total"],
      columns: [
        { name: "job", type: "string", nullable: true, isPrimary: false },
        { name: "timestamp", type: "timestamp", nullable: false, isPrimary: false },
        { name: "value", type: "float", nullable: false, isPrimary: false },
      ],
      indexes: [],
    },
  ];

  beforeEach(() => {
    localStorage.clear();
  });

  test("a new tab on a PromQL connection is a promql tab", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ port: 9090 }),
        metadata: promqlMetadata,
        schema: metricSchema,
      }),
    );

    act(() => {
      result.current.addTab();
    });

    expect(result.current.tabs[1].type).toBe("promql");
  });

  test("a tree click on a metric opens a promql tab and runs its selector with the preview option", () => {
    const executeFn = mock(() => {});
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ port: 9090 }),
        metadata: promqlMetadata,
        schema: metricSchema,
      }),
    );

    act(() => {
      result.current.handleTableClick(["http_requests_total"], executeFn);
    });

    const newTab = result.current.tabs[1];
    expect(newTab.name).toBe("http_requests_total");
    expect(newTab.type).toBe("promql");
    expect(newTab.query).toBe("http_requests_total");

    // The hook runs a click's statement on a 100 ms timer, as the SQL test above measures.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(executeFn).toHaveBeenCalledWith("http_requests_total", newTab.id, false, { limit: PREVIEW_PAGE_SIZE });
        resolve();
      }, 150);
    });
  });

  test("Generate Query on a metric opens a promql tab whose one runnable line is its selector", () => {
    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ port: 9090 }),
        metadata: promqlMetadata,
        schema: metricSchema,
      }),
    );

    act(() => {
      result.current.handleGenerateSelect(["http_requests_total"]);
    });

    const newTab = result.current.tabs[1];
    expect(newTab.name).toBe("Query: http_requests_total");
    expect(newTab.type).toBe("promql");
    expect(newTab.query.split("\n").at(-1)).toBe("http_requests_total");
    expect(newTab.query).not.toContain("SELECT");
  });
});

// ============================================================================
// InfluxDB: a measurement opens an influxql tab, an InfluxDB 3 table an sql tab, both time-windowed (InfluxDB spec 6.6)
// ============================================================================

describe("useTabManager on the two InfluxDB types (InfluxDB spec 6.6, 6.7)", () => {
  // The real providers' declarations; nothing is connected, and neither constructor opens anything.
  const influxqlProvider = new InfluxDBProvider(makeConnection({ type: "influxdb", port: 8086, database: "home" }));
  const influxqlMetadata: ProviderMetadata = {
    capabilities: influxqlProvider.getCapabilities(),
    labels: influxqlProvider.getLabels(),
  };
  const sqlProvider = new InfluxDB3Provider(makeConnection({ type: "influxdb3", port: 8181, database: "home" }));
  const sqlMetadata: ProviderMetadata = {
    capabilities: sqlProvider.getCapabilities(),
    labels: sqlProvider.getLabels(),
  };

  // A hostile measurement name, as the tree lists it under its database.
  const hostile = 'we"ird name;x';
  const measurementSchema: DetailedObject[] = [
    {
      name: hostile,
      kind: "measurement",
      path: ["home", hostile],
      columns: [
        { name: "room", type: "tag", nullable: true, isPrimary: false },
        { name: "temp", type: "float", nullable: true, isPrimary: false },
      ],
      indexes: [],
    },
  ];
  const tableSchema: DetailedObject[] = [
    {
      name: "cpu",
      kind: "table",
      path: ["cpu"],
      columns: [
        { name: "time", type: "timestamp", nullable: false, isPrimary: false },
        { name: "usage", type: "float", nullable: true, isPrimary: false },
      ],
      indexes: [],
    },
  ];

  beforeEach(() => {
    localStorage.clear();
  });

  test("a new tab on an InfluxDB (InfluxQL) connection is an influxql tab, and on InfluxDB 3 an sql tab", () => {
    const influxql = renderHook(() =>
      useTabManager({ activeConnection: makeConnection(), metadata: influxqlMetadata, schema: measurementSchema }),
    );
    act(() => influxql.result.current.addTab());
    expect(influxql.result.current.tabs[1].type).toBe("influxql");

    localStorage.clear();
    const sql = renderHook(() =>
      useTabManager({ activeConnection: makeConnection(), metadata: sqlMetadata, schema: tableSchema }),
    );
    act(() => sql.result.current.addTab());
    expect(sql.result.current.tabs[1].type).toBe("sql");
  });

  test("a tree click on a hostile measurement opens an influxql tab whose text the read policy allows", () => {
    const executeFn = mock(() => {});
    const { result } = renderHook(() =>
      useTabManager({ activeConnection: makeConnection(), metadata: influxqlMetadata, schema: measurementSchema }),
    );

    act(() => {
      result.current.handleTableClick(["home", hostile], executeFn);
    });

    const newTab = result.current.tabs[1];
    expect(newTab.name).toBe(hostile);
    expect(newTab.type).toBe("influxql");
    expect(newTab.query).toContain(
      'SELECT * FROM "home".."we\\"ird name;x" WHERE time > now() - 1h ORDER BY time DESC',
    );
    expect(evaluateInfluxql(newTab.query)).toMatchObject({ allowed: true });

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(executeFn).toHaveBeenCalledWith(newTab.query, newTab.id, false, { limit: PREVIEW_PAGE_SIZE });
        resolve();
      }, 150);
    });
  });

  test("Generate Query on a measurement opens an influxql tab with its example lines as comments", () => {
    const { result } = renderHook(() =>
      useTabManager({ activeConnection: makeConnection(), metadata: influxqlMetadata, schema: measurementSchema }),
    );

    act(() => {
      result.current.handleGenerateSelect(["home", hostile]);
    });

    const newTab = result.current.tabs[1];
    expect(newTab.type).toBe("influxql");
    expect(newTab.query).toContain('mean("temp")');
    expect(newTab.query).not.toContain("LIMIT 100");
    expect(evaluateInfluxql(newTab.query)).toMatchObject({ allowed: true });
  });

  test("a tree click on an InfluxDB 3 table opens an sql tab on the newest hour, newest first, unqualified", () => {
    const executeFn = mock(() => {});
    const { result } = renderHook(() =>
      useTabManager({ activeConnection: makeConnection(), metadata: sqlMetadata, schema: tableSchema }),
    );

    act(() => {
      result.current.handleTableClick(["cpu"], executeFn);
    });

    const newTab = result.current.tabs[1];
    expect(newTab.type).toBe("sql");
    expect(newTab.query).toContain(
      'SELECT * FROM "cpu" WHERE "time" >= now() - INTERVAL \'1 hour\' ORDER BY "time" DESC',
    );
    expect(newTab.query).not.toContain("home");

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(executeFn).toHaveBeenCalledWith(newTab.query, newTab.id, false, { limit: PREVIEW_PAGE_SIZE });
        resolve();
      }, 150);
    });
  });
});

// ============================================================================
// etcd: a group's readable pieces and the connection's mode reach the generators (#1089 6.4)
// ============================================================================

describe("useTabManager on an etcd connection (#1089)", () => {
  // The real provider's declaration; nothing is connected, and its constructor opens nothing (#1089 3.1).
  const etcdProvider = new EtcdProvider(makeConnection({ type: "etcd", port: 2379, database: undefined }));
  const etcdMetadata: ProviderMetadata = {
    capabilities: etcdProvider.getCapabilities(),
    labels: etcdProvider.getLabels(),
  };

  // A group a reader who is not root may read only part of, as the tree lists it: its pieces ride on the entry.
  const etcdSchema: DetailedObject[] = [
    {
      name: "/config/*",
      kind: "prefix",
      path: ["/config/*"],
      columns: [{ name: "key", type: "bytes", nullable: false, isPrimary: true }],
      indexes: [],
      readRanges: [{ key: "/config/a" }, { prefix: "/config/b/" }],
    },
    { name: "/app/*", kind: "prefix", path: ["/app/*"], columns: [], indexes: [] },
  ];

  const hookFor = (connection: DatabaseConnection) =>
    renderHook(() => useTabManager({ activeConnection: connection, metadata: etcdMetadata, schema: etcdSchema }));

  beforeEach(() => {
    localStorage.clear();
  });

  test("a tree click reads the first piece this connection may read, and runs it with the preview option", () => {
    const executeFn = mock(() => {});
    const { result } = hookFor(makeConnection({ type: "etcd", port: 2379 }));

    act(() => {
      result.current.handleTableClick(["/config/*"], executeFn);
    });

    const newTab = result.current.tabs[1];
    expect(newTab.name).toBe("/config/*");
    expect(newTab.query).toBe(["get /config/a --limit=50", "", "# get /config/b/ --prefix --limit=50"].join("\n"));

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(executeFn).toHaveBeenCalledWith(newTab.query, newTab.id, false, { limit: PREVIEW_PAGE_SIZE });
        resolve();
      }, 150);
    });
  });

  test("a group this connection reads whole is read whole", () => {
    const { result } = hookFor(makeConnection({ type: "etcd", port: 2379 }));

    act(() => {
      result.current.handleTableClick(
        ["/app/*"],
        mock(() => {}),
      );
    });

    expect(result.current.tabs[1].query).toBe("get /app/ --prefix --limit=50");
  });

  test("Generate Command writes the read and, on a read-write connection, the other forms below it", () => {
    const { result } = hookFor(makeConnection({ type: "etcd", port: 2379 }));

    act(() => {
      result.current.handleGenerateSelect(["/config/*"]);
    });

    const query = result.current.tabs[1].query;
    expect(result.current.tabs[1].name).toBe("Query: /config/*");
    expect(query.split("\n")[0]).toBe("get /config/a --limit=50");
    expect(query).toContain("# get /config/b/ --prefix --limit=50");
    expect(query).toContain("# put /config/example value");
  });

  test("Generate Command on a read-only connection writes the read alone (#1089 E6)", () => {
    const { result } = hookFor(makeConnection({ type: "etcd", port: 2379, readOnly: true }));

    act(() => {
      result.current.handleGenerateSelect(["/config/*"]);
    });
    act(() => {
      result.current.handleTableClick(
        ["/config/*"],
        mock(() => {}),
      );
    });

    // The click's read and its pieces, and nothing that writes: the same text the click opens.
    expect(result.current.tabs[1].query).toBe(result.current.tabs[2].query);
    expect(result.current.tabs[1].query).not.toContain("put ");
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
    expect(newTab.query).toBe("SELECT * FROM libredb_objects.app.customers;");
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

    expect(result.current.tabs[1].query).toBe("SELECT * FROM app.customers;");
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

/**
 * The walked database, carried onto the tab (the #1095 review).
 *
 * A key activation happens in ONE numbered database, and the statement that reads the key cannot
 * name it: Redis has no database-qualified key syntax, so the database is a property of the
 * connection and `GET report:daily` reads whichever one the connection sits in. The number
 * therefore has to outlive the call that opened the tab - the Run after this one, a selection, an
 * inline edit and the next page are all about the same key - so it goes ON the tab. These tests pin
 * the fact landing there and the control that an ordinary activation carries nothing at all.
 */
describe("useTabManager carries the walked database", () => {
  /** A key activation: the key, its known type, and the database the panel walked. */
  const openKey = (handleTableClick: ReturnType<typeof useTabManager>["handleTableClick"], database?: number): void => {
    handleTableClick(
      ["report:daily"],
      () => {},
      [{ name: "type", type: "string", nullable: false, isPrimary: false }],
      database,
    );
  };

  test("puts the walked database on the tab it opens", () => {
    const { result } = renderHook(() =>
      useTabManager({ activeConnection: makeConnection(), metadata: redisMetadata, schema: [] }),
    );

    act(() => openKey(result.current.handleTableClick, 3));

    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.tabs[1].databaseOverride).toBe(3);
    // The statement itself is untouched: the database is not something Redis lets it say, which is
    // the whole reason the tab has to carry the fact.
    expect(result.current.tabs[1].query).toBe("GET report:daily");
  });

  test("an ordinary activation carries no override at all", () => {
    const executeFn = mock(() => {});
    const { result } = renderHook(() =>
      useTabManager({ activeConnection: makeConnection(), metadata: defaultMetadata, schema: testSchema }),
    );

    act(() => {
      result.current.handleTableClick(["users"], executeFn);
    });

    // Absent, not `undefined`: an ordinary tab is the record it has always been, so nothing
    // downstream can read a number nobody walked.
    expect("databaseOverride" in result.current.tabs[1]).toBe(false);
  });

  test("a key tab's override survives the persisted record, so a reload still reads its own database", async () => {
    /*
     * The gap the review left: the field landed on the tab, but a tab is restored from
     * `localStorage`, and this record did not carry the number. A reload therefore restored a
     * key tab with no override, and every run after it read the session's database - the
     * reviewer's `(nil)`, back in a form nobody would notice, because the tab looks and reads
     * exactly like the one that was working before the reload.
     *
     * The whole record is asserted rather than the one field, so the field's presence in
     * storage is pinned as an exact shape: it rides beside the four fields `PersistedTabState`
     * has always written and adds nothing else.
     */
    const storageKey = "libredb_workspace_tabs_v1:override-persist";
    const connection = makeConnection({ id: "override-persist" });
    const first = renderHook(() =>
      useTabManager({ activeConnection: connection, metadata: redisMetadata, schema: [], persistWorkspace: true }),
    );

    act(() => openKey(first.result.current.handleTableClick, 3));
    await waitFor(
      () => {
        expect(localStorage.getItem(storageKey)).toBeTruthy();
      },
      { timeout: 2000 },
    );

    const persisted = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as {
      tabs: Array<Record<string, unknown>>;
    };
    expect(persisted.tabs[1]).toEqual({
      id: first.result.current.tabs[1].id,
      name: "report:daily",
      query: "GET report:daily",
      type: "redis",
      databaseOverride: 3,
    });

    // The reload itself: the same stored record read by a fresh hook, which is what a page
    // reload is to this hook.
    first.unmount();
    const second = renderHook(() =>
      useTabManager({ activeConnection: connection, metadata: redisMetadata, schema: [], persistWorkspace: true }),
    );

    await waitFor(() => expect(second.result.current.tabs).toHaveLength(2));
    expect(second.result.current.tabs[1].databaseOverride).toBe(3);
  });

  test("a tab with no stored override restores with no key, which is not `null` and not `0`", async () => {
    /*
     * The absence half, and it is the one that costs a wrong ANSWER rather than an error:
     * `0` and `null` are both databases a restored tab would select, and the ordinary tab
     * beside the key tab is the case that makes the assertion non-vacuous - a restore that
     * invented a default would have to invent it here too.
     *
     * Both tabs in the record are key-looking (names and database-less statements) and both
     * carry no override, because the record a version before this field wrote is exactly this
     * shape and has to keep meaning "the connection's own database".
     */
    localStorage.setItem(
      "libredb_workspace_tabs_v1:override-absent",
      JSON.stringify({
        activeTabId: "key",
        tabs: [
          { id: "ordinary", name: "Query 1", query: "SELECT 1;", type: "sql" },
          { id: "key", name: "report:daily", query: "GET report:daily", type: "redis" },
        ],
      }),
    );

    const { result } = renderHook(() =>
      useTabManager({
        activeConnection: makeConnection({ id: "override-absent" }),
        metadata: redisMetadata,
        schema: [],
        persistWorkspace: true,
      }),
    );

    await waitFor(() => expect(result.current.tabs).toHaveLength(2));
    expect(result.current.tabs[1].databaseOverride).toBeUndefined();
    // Absent, not present-but-undefined: `"databaseOverride" in tab` is what the rest of the
    // shell would branch on, and a key holding `undefined` is a field somebody has to remember
    // to test for. The control is the tab beside it, which never had one either.
    expect(result.current.tabs.some((tab) => "databaseOverride" in tab)).toBe(false);
  });
});

// ─── A second activation of the same object focuses its tab ───

describe("useTabManager reuses an object's unedited data tab", () => {
  /** Long enough for the deferred run `handleTableClick` schedules. */
  const settle = () => new Promise((r) => setTimeout(r, 150));

  function renderManager(schema: DetailedObject[] = testSchema) {
    return renderHook(() => useTabManager({ activeConnection: makeConnection(), metadata: defaultMetadata, schema }));
  }

  beforeEach(() => {
    localStorage.clear();
  });

  test("two activations of the same object give one data tab, focused, run once", async () => {
    const executeFn = mock(() => {});
    const { result } = renderManager();

    act(() => result.current.handleTableClick(["users"], executeFn));
    const opened = result.current.activeTabId;
    // Away and back, so the second activation has something to focus.
    act(() => result.current.setActiveTabId("default"));
    act(() => result.current.handleTableClick(["users"], executeFn));
    await settle();

    expect(result.current.tabs.map((t) => t.name)).toEqual(["Query 1", "users"]);
    expect(result.current.activeTabId).toBe(opened);
    expect(executeFn).toHaveBeenCalledTimes(1);
  });

  test("a matched tab whose last run failed is focused and run again, in that tab", async () => {
    const executeFn = mock(() => {});
    const { result } = renderManager();

    act(() => result.current.handleTableClick(["users"], executeFn));
    const opened = result.current.activeTabId;
    await settle();
    // The shape a failed run leaves: no rows, and the reason in their place.
    act(() => result.current.updateTabById(opened, { runError: "connection reset" }));
    act(() => result.current.setActiveTabId("default"));
    executeFn.mockClear();
    act(() => result.current.handleTableClick(["users"], executeFn));
    await settle();

    expect(result.current.tabs.map((t) => t.name)).toEqual(["Query 1", "users"]);
    expect(result.current.activeTabId).toBe(opened);
    expect(executeFn).toHaveBeenCalledTimes(1);
    const query = result.current.tabs[1].query;
    expect(executeFn).toHaveBeenCalledWith(query, opened, false, { limit: PREVIEW_PAGE_SIZE });
  });

  test("a tab opened on one connection is not reused on another holding the same path", async () => {
    const executeFn = mock(() => {});
    const { result, rerender } = renderHook(
      ({ connectionId }: { connectionId: string }) =>
        useTabManager({
          activeConnection: makeConnection({ id: connectionId }),
          metadata: defaultMetadata,
          schema: testSchema,
        }),
      { initialProps: { connectionId: "conn-a" } },
    );

    act(() => result.current.handleTableClick(["users"], executeFn));
    const onA = result.current.activeTabId;
    // Same connection: the control, reused.
    act(() => result.current.handleTableClick(["users"], executeFn));
    expect(result.current.activeTabId).toBe(onA);
    expect(result.current.tabs).toHaveLength(2);

    rerender({ connectionId: "conn-b" });
    act(() => result.current.handleTableClick(["users"], executeFn));
    await settle();

    expect(result.current.tabs).toHaveLength(3);
    expect(result.current.activeTabId).not.toBe(onA);
    expect(executeFn).toHaveBeenCalledTimes(2);
  });

  test("a different object opens its own tab", async () => {
    const executeFn = mock(() => {});
    const { result } = renderManager();

    act(() => result.current.handleTableClick(["users"], executeFn));
    act(() => result.current.handleTableClick(["orders"], executeFn));
    await settle();

    expect(result.current.tabs.map((t) => t.name)).toEqual(["Query 1", "users", "orders"]);
    expect(executeFn).toHaveBeenCalledTimes(2);
  });

  test("a tab whose query the user edited is never captured", async () => {
    const executeFn = mock(() => {});
    const { result } = renderManager();

    act(() => result.current.handleTableClick(["users"], executeFn));
    const edited = result.current.activeTabId;
    act(() => result.current.updateTabById(edited, { query: "SELECT id FROM users WHERE id > 10;" }));
    act(() => result.current.handleTableClick(["users"], executeFn));
    await settle();

    expect(result.current.tabs).toHaveLength(3);
    expect(result.current.activeTabId).not.toBe(edited);
    expect(executeFn).toHaveBeenCalledTimes(2);
    // The edit is the reader's work, and it is left exactly as they wrote it.
    expect(result.current.tabs.find((t) => t.id === edited)?.query).toBe("SELECT id FROM users WHERE id > 10;");
  });

  test("the same key in another numbered database is another tab", async () => {
    const executeFn = mock(() => {});
    const { result } = renderManager([]);
    const type = [{ name: "type", type: "string", nullable: false, isPrimary: false }];

    act(() => result.current.handleTableClick(["report:daily"], executeFn, type, 3));
    act(() => result.current.handleTableClick(["report:daily"], executeFn, type, 4));
    act(() => result.current.handleTableClick(["report:daily"], executeFn, type, 3));
    await settle();

    expect(result.current.tabs.map((t) => t.databaseOverride)).toEqual([undefined, 3, 4]);
    expect(result.current.activeTabId).toBe(result.current.tabs[1].id);
    expect(executeFn).toHaveBeenCalledTimes(2);
  });

  test("a tab with the same name and query but no recorded origin is not captured", async () => {
    // The shape a tab restored from storage has: its origin is never persisted.
    const executeFn = mock(() => {});
    const { result } = renderManager();

    act(() =>
      result.current.setTabs((prev) => [
        ...prev,
        { id: "restored", name: "users", query: "SELECT * FROM users;", result: null, isExecuting: false, type: "sql" },
      ]),
    );
    act(() => result.current.handleTableClick(["users"], executeFn));
    await settle();

    expect(result.current.tabs).toHaveLength(3);
    expect(executeFn).toHaveBeenCalledTimes(1);
  });
});
