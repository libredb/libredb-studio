import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { mock } from "bun:test";
import { setupRechartssMock, setupFramerMotionMock } from "../../helpers/mock-monaco";
import { DEFAULT_THRESHOLDS } from "@/lib/monitoring-thresholds";

setupRechartssMock();
setupFramerMotionMock();

const mockSetAutoRefresh = mock(() => {});
const mockSetRefreshInterval = mock(() => {});
const mockRefresh = mock(() => {});
const mockKillSession = mock(async () => true);
const mockRunMaintenance = mock(async () => true);

type MonitoringHookState = Record<string, unknown>;

const monitoringDataDefaults = (): MonitoringHookState => ({
  data: {
    overview: {
      version: "15.4",
      uptime: 86400,
      connections: { active: 5, total: 15, max: 100 },
      databaseSize: "256 MB",
    },
    performance: {
      queriesPerSecond: 150,
      avgQueryTime: 2.5,
      cacheHitRatio: 99.1,
    },
    slowQueries: [],
    activeSessions: [],
  },
  loading: false,
  error: null,
  lastUpdated: new Date(),
  autoRefresh: true,
  refreshInterval: 10000,
  history: [],
  setAutoRefresh: mockSetAutoRefresh,
  setRefreshInterval: mockSetRefreshInterval,
  refresh: mockRefresh,
  killSession: mockKillSession,
  runMaintenance: mockRunMaintenance,
});

const mockUseMonitoringData = mock(monitoringDataDefaults);

mock.module("@/hooks/use-monitoring-data", () => ({
  useMonitoringData: mockUseMonitoringData,
}));

mock.module("@/lib/storage", () => ({
  storage: {
    getThresholdConfig: mock(() => DEFAULT_THRESHOLDS),
    getConnections: mock(() => [
      {
        id: "c1",
        name: "PG Dev",
        type: "postgres",
        host: "localhost",
        port: 5432,
        database: "dev",
        createdAt: new Date(),
      },
      {
        id: "c2",
        name: "PG Prod",
        type: "postgres",
        host: "prod",
        port: 5432,
        database: "prod",
        createdAt: new Date(),
      },
    ]),
    getActiveConnectionId: mock(() => "c1"),
    getDismissedSeeds: mock(() => []),
    // Read by the real useCatalogs on a server-level connection (#1530).
    getActiveCatalog: mock(() => null),
    setActiveCatalog: mock(() => {}),
  },
}));

// Mock ui/select: capture onValueChange keyed by the Select's current value so
// tests can drive selection changes (Radix Select portals do not open in happy-dom).
// SelectContent renders null so item labels do not duplicate the SelectValue text.
const selectCallbacks = new Map<string, (v: string) => void>();

mock.module("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children?: React.ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
  }) => {
    const key = value ?? "__empty__";
    if (onValueChange) selectCallbacks.set(key, onValueChange);
    return React.createElement("div", { "data-testid": `select-${key}` }, children);
  },
  SelectTrigger: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "select-trigger" }, children),
  SelectContent: () => null,
  SelectItem: ({ children, value }: { children?: React.ReactNode; value: string }) =>
    React.createElement("div", { "data-testid": `select-item-${value}` }, children),
  SelectValue: ({ children, placeholder }: { children?: React.ReactNode; placeholder?: string }) =>
    React.createElement("span", { "data-testid": "select-value" }, children ?? placeholder),
}));

// Mock all 7 monitoring tab sub-components
const overviewTabProps: Array<Record<string, unknown>> = [];
mock.module("@/components/monitoring/tabs/OverviewTab", () => ({
  OverviewTab: (props: Record<string, unknown>) => {
    overviewTabProps.push(props);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return React.createElement("div", { "data-testid": "monitoring-overviewtab" }, "OverviewTab");
  },
}));

mock.module("@/components/monitoring/tabs/PerformanceTab", () => ({
  PerformanceTab: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return React.createElement("div", { "data-testid": "monitoring-performancetab" }, "PerformanceTab");
  },
}));

// Captures the props the dashboard hands the queries tab, for the same reason as the
// tables tab below: the label wiring is the dashboard's job, the copy is the tab's.
const queriesTabProps: Array<Record<string, unknown>> = [];

mock.module("@/components/monitoring/tabs/QueriesTab", () => ({
  QueriesTab: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    queriesTabProps.push(props);
    return React.createElement("div", { "data-testid": "monitoring-queriestab" }, "QueriesTab");
  },
}));

// Captures the props the dashboard hands the sessions tab, for the Terminate wiring (#1424).
const sessionsTabProps: Array<Record<string, unknown>> = [];

mock.module("@/components/monitoring/tabs/SessionsTab", () => ({
  SessionsTab: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    sessionsTabProps.push(props);
    return React.createElement("div", { "data-testid": "monitoring-sessionstab" }, "SessionsTab");
  },
}));

// The signed-in role `useAuth` answers; beforeEach puts the admin back (#1424).
let currentRole = "admin";

mock.module("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { role: currentRole },
    isAdmin: currentRole === "admin",
    handleLogout: mock(async () => {}),
  }),
}));

// Captures the props the dashboard hands the tables tab, so the capability wiring
// can be asserted while the tab itself stays mocked out.
const tablesTabProps: Array<Record<string, unknown>> = [];

mock.module("@/components/monitoring/tabs/TablesTab", () => ({
  TablesTab: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    tablesTabProps.push(props);
    return React.createElement("div", { "data-testid": "monitoring-tablestab" }, "TablesTab");
  },
}));

const mockCapabilities = {
  queryLanguage: "sql",
  supportsExplain: true,
  supportsExternalQueryLimiting: true,
  supportsMaintenance: true,
  maintenanceOperations: ["vacuum", "analyze"],
  supportsConnectionString: true,
  defaultPort: 5432,
  schemaRefreshPattern: "^(CREATE|DROP)\\b",
};

const mockLabels = {
  entityName: "Table",
  entityNamePlural: "Tables",
  rowName: "Row",
  rowNamePlural: "Rows",
  slowQueriesEmptyState: "This engine keeps no aggregate of finished statements.",
};

// Records which connection the dashboard asks metadata for, so the wiring test can
// assert the lookup follows the selection rather than firing on null.
const providerMetadataCalls: Array<{ id?: string } | null> = [];

// The capabilities the metadata mock answers with; a test swaps in its own declaration and
// beforeEach puts the shared one back.
let currentCapabilities: Record<string, unknown> = mockCapabilities;
// While true the declaration is still being read, so the dashboard knows nothing of the connection yet.
let metadataPending = false;
// While set, the declaration read failed with this message.
let metadataFailure: string | null = null;

mock.module("@/hooks/use-provider-metadata", () => ({
  useProviderMetadata: mock((connection: { id?: string } | null) => {
    providerMetadataCalls.push(connection);
    if (metadataPending) return { metadata: null, isLoading: true, error: null };
    if (metadataFailure !== null) return { metadata: null, isLoading: false, error: metadataFailure };
    return {
      metadata: {
        capabilities: currentCapabilities,
        labels: mockLabels,
      },
      isLoading: false,
    };
  }),
}));

const storageTabProps: Array<Record<string, unknown>> = [];
mock.module("@/components/monitoring/tabs/StorageTab", () => ({
  StorageTab: (props: Record<string, unknown>) => {
    storageTabProps.push(props);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return React.createElement("div", { "data-testid": "monitoring-storagetab" }, "StorageTab");
  },
}));

mock.module("@/components/monitoring/tabs/PoolTab", () => ({
  PoolTab: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return React.createElement("div", { "data-testid": "monitoring-pooltab" }, "PoolTab");
  },
}));

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, act, cleanup, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

import { mockRouterPush } from "../../helpers/mock-navigation";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { ENGINE_FACETS } from "@/lib/db/engine-facets";
import type { MonitoringPanel } from "@/lib/db/engine-facets/types";
import type { DatabaseType } from "@/lib/types";

// Dynamic import AFTER the mock.module() calls above: a static import would be
// hoisted and evaluate the real tab modules, poisoning coverage with all-zero
// records for files this test never exercises.
const { MonitoringDashboard } = await import("@/components/monitoring/MonitoringDashboard");

// =============================================================================
// MonitoringDashboard Tests
// =============================================================================

describe("MonitoringDashboard", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockRouterPush.mockClear();
    mockRefresh.mockClear();
    mockSetAutoRefresh.mockClear();
    mockSetRefreshInterval.mockClear();
    mockUseMonitoringData.mockImplementation(monitoringDataDefaults);
    selectCallbacks.clear();
    currentCapabilities = mockCapabilities;
    currentRole = "admin";
  });

  test("renders monitoring title", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText("Monitoring")).not.toBeNull();
  });

  test("shows connection selector", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { queryByText } = renderResult!;

    // The connection selector shows the selected connection name
    expect(queryByText("PG Dev")).not.toBeNull();
  });

  test("falls back to the first connection when the saved active id is not in the list", async () => {
    // The stored active connection can name something that no longer exists -
    // it was deleted, or the seed that served it is gone. The dashboard must
    // still open on a connection rather than on the empty state.
    const storageModule = await import("@/lib/storage");
    const storageRecord = storageModule.storage as unknown as Record<string, unknown>;
    const originalGetActiveConnectionId = storageRecord.getActiveConnectionId;
    storageRecord.getActiveConnectionId = mock(() => "gone");

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText("PG Dev")).not.toBeNull();

    storageRecord.getActiveConnectionId = originalGetActiveConnectionId;
  });

  test("shows 7 tab triggers", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText("Overview")).not.toBeNull();
    expect(queryByText("Performance")).not.toBeNull();
    expect(queryByText("Queries")).not.toBeNull();
    expect(queryByText("Sessions")).not.toBeNull();
    expect(queryByText("Tables")).not.toBeNull();
    expect(queryByText("Storage")).not.toBeNull();
    expect(queryByText("Pool")).not.toBeNull();
  });

  test("refresh button present", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { container } = renderResult!;

    // Refresh button has title "Refresh now"
    const refreshButton = container.querySelector('[title="Refresh now"]');
    expect(refreshButton).not.toBeNull();
  });

  test("auto-refresh toggle present", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { container } = renderResult!;

    // Auto-refresh toggle button has title containing "auto-refresh"
    const autoRefreshButton = container.querySelector('[title="Pause auto-refresh"]');
    expect(autoRefreshButton).not.toBeNull();
  });

  test("shows the billing sentence beside auto-refresh when the capability is declared, and none otherwise", async () => {
    // A provider whose compute resumes on any statement and is billed until it suspends (a Databend
    // Cloud warehouse) declares `resumesBilledCompute`: every auto-refresh tick keeps it awake.
    const sentence = "Each refresh runs statements on this connection, which keeps its billed compute running.";

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    expect(renderResult!.queryByText(sentence)).toBeNull();
    expect(
      renderResult!.container.querySelector('[title="Pause auto-refresh"]')?.hasAttribute("aria-describedby"),
    ).toBe(false);
    cleanup();

    currentCapabilities = { ...mockCapabilities, resumesBilledCompute: true };
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const note = renderResult!.queryByText(sentence);
    expect(note).not.toBeNull();
    // The toggle names the sentence as its description, so a screen reader hears the cost on it.
    const toggle = renderResult!.container.querySelector('[title="Pause auto-refresh"]');
    expect(toggle?.getAttribute("aria-describedby")).toBe(note!.id);
  });

  test("no connection shows empty state", async () => {
    // Override storage to return empty connections
    const storageModule = await import("@/lib/storage");
    const originalGetConnections = (storageModule.storage as unknown as Record<string, unknown>).getConnections;
    (storageModule.storage as unknown as Record<string, unknown>).getConnections = mock(() => []);

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText("No Connection Selected")).not.toBeNull();
    expect(queryByText("Select a database connection to view monitoring data.")).not.toBeNull();

    // Restore
    (storageModule.storage as unknown as Record<string, unknown>).getConnections = originalGetConnections;
  });

  test("back button remains named when its responsive text is hidden", async () => {
    mockRouterPush.mockClear();
    let view: ReturnType<typeof render>;
    await act(async () => {
      view = render(<MonitoringDashboard />);
    });
    // Model the small-screen CSS state in the DOM test environment.
    view!.getByText("Back").style.display = "none";
    fireEvent.click(view!.getByRole("button", { name: "Back" }));
    expect(mockRouterPush).toHaveBeenCalledWith("/");
  });

  test("isEmbedded=true hides back button", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard isEmbedded={true} />);
    });
    const { queryByText } = renderResult!;

    // When embedded, the Back button should not be present
    expect(queryByText("Back")).toBeNull();
  });

  test("changing connection via selector selects the new connection", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { queryByText } = renderResult!;

    // Connection Select carries value "c1" after the initial selection effect
    const onConnectionChange = selectCallbacks.get("c1");
    expect(onConnectionChange).toBeDefined();

    await act(async () => {
      onConnectionChange!("c2");
    });

    expect(queryByText("PG Prod")).not.toBeNull();
  });

  test("selecting an unknown connection id clears the selection", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { queryByText } = renderResult!;

    const onConnectionChange = selectCallbacks.get("c1");
    expect(onConnectionChange).toBeDefined();

    await act(async () => {
      onConnectionChange!("missing-id");
    });

    expect(queryByText("No Connection Selected")).not.toBeNull();
  });

  test("shows connection error state when error and no data", async () => {
    const user = userEvent.setup();
    mockUseMonitoringData.mockImplementation(
      (): MonitoringHookState => ({
        data: null,
        loading: false,
        error: "Connection refused",
        lastUpdated: null,
        autoRefresh: false,
        refreshInterval: 10000,
        history: [],
        setAutoRefresh: mockSetAutoRefresh,
        setRefreshInterval: mockSetRefreshInterval,
        refresh: mockRefresh,
        killSession: mockKillSession,
        runMaintenance: mockRunMaintenance,
      }),
    );

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { queryByText, getByText } = renderResult!;

    expect(queryByText("Connection Error")).not.toBeNull();
    expect(queryByText("Connection refused")).not.toBeNull();

    await user.click(getByText("Try Again"));
    expect(mockRefresh).toHaveBeenCalled();
  });

  // A refresh that fails keeps the selection's earlier payload (useMonitoringData), so the failure must be drawn
  // beside those panels: without it the dashboard shows a reading that is no longer current as if it were.
  test("draws a failed read beside the panels the selection read before it", async () => {
    mockUseMonitoringData.mockImplementation(() => ({ ...monitoringDataDefaults(), error: "refresh refused" }));

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { queryByTestId, queryByText } = renderResult!;

    expect(queryByText("Connection Error")).toBeNull();
    expect(queryByTestId("monitoring-overviewtab")).not.toBeNull();
    expect(queryByTestId("monitoring-read-failed")?.textContent).toBe(
      "The last read failed, so the panels show the one before it: refresh refused",
    );
  });

  test("draws no failed-read line while the last read answered", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });

    expect(renderResult!.queryByTestId("monitoring-read-failed")).toBeNull();
  });

  test("tab switching works", async () => {
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { queryByTestId, container } = renderResult!;

    // Default tab is overview
    expect(queryByTestId("monitoring-overviewtab")).not.toBeNull();

    // Click on Performance tab (must use userEvent for Radix tabs in happy-dom)
    const allTriggers = container.querySelectorAll('[role="tab"]');
    const perfTrigger = Array.from(allTriggers).find((t) => t.textContent?.includes("Performance")) as HTMLElement;
    await user.click(perfTrigger);

    // Performance tab content should now be visible
    await waitFor(() => {
      expect(queryByTestId("monitoring-performancetab")).not.toBeNull();
    });
  });

  test("hands the selected connection's own labels to the queries tab", async () => {
    // Without this the "Slowest Queries" empty state can only be Postgres's: the tab
    // holds the copy, but only the dashboard has the provider metadata (#463).
    const user = userEvent.setup();
    queriesTabProps.length = 0;

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { queryByTestId, container } = renderResult!;

    const allTriggers = container.querySelectorAll('[role="tab"]');
    const queriesTrigger = Array.from(allTriggers).find((t) => t.textContent?.includes("Queries")) as HTMLElement;
    await user.click(queriesTrigger);

    await waitFor(() => {
      expect(queryByTestId("monitoring-queriestab")).not.toBeNull();
    });

    expect(queriesTabProps.length).toBeGreaterThan(0);
    expect(queriesTabProps[queriesTabProps.length - 1].labels).toEqual(mockLabels);
  });

  test("hands the selected connection's own labels to the tables tab", async () => {
    // Without them the tab cannot say that a provider's list is only part of the database, and
    // counts it as the database's tables (#1085 6.2): the caption is the tab's, the metadata the
    // dashboard's, as for the queries tab above.
    const user = userEvent.setup();
    tablesTabProps.length = 0;

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { queryByTestId, container } = renderResult!;

    const allTriggers = container.querySelectorAll('[role="tab"]');
    const tablesTrigger = Array.from(allTriggers).find((t) => t.textContent?.includes("Tables")) as HTMLElement;
    await user.click(tablesTrigger);

    await waitFor(() => {
      expect(queryByTestId("monitoring-tablestab")).not.toBeNull();
    });

    expect(tablesTabProps.length).toBeGreaterThan(0);
    expect(tablesTabProps[tablesTabProps.length - 1].labels).toEqual(mockLabels);
  });

  test("hands the selected connection's declared capabilities to the tables tab", async () => {
    const user = userEvent.setup();
    tablesTabProps.length = 0;
    providerMetadataCalls.length = 0;

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { queryByTestId, container } = renderResult!;

    const allTriggers = container.querySelectorAll('[role="tab"]');
    const tablesTrigger = Array.from(allTriggers).find((t) => t.textContent?.includes("Tables")) as HTMLElement;
    await user.click(tablesTrigger);

    await waitFor(() => {
      expect(queryByTestId("monitoring-tablestab")).not.toBeNull();
    });

    expect(tablesTabProps.length).toBeGreaterThan(0);
    expect(tablesTabProps[tablesTabProps.length - 1].capabilities).toEqual(mockCapabilities);
    expect(providerMetadataCalls[providerMetadataCalls.length - 1]?.id).toBe("c1");

    // ...and the lookup follows the selection rather than the first connection:
    // switching connections re-asks for the newly selected one.
    const onConnectionChange = selectCallbacks.get("c1");
    expect(onConnectionChange).toBeDefined();
    await act(async () => {
      onConnectionChange!("c2");
    });

    expect(providerMetadataCalls[providerMetadataCalls.length - 1]?.id).toBe("c2");
  });

  test("tells the tables tab whether the connection is read-only (#1418)", async () => {
    const openTables = async () => {
      const user = userEvent.setup();
      tablesTabProps.length = 0;
      let renderResult: ReturnType<typeof render>;
      await act(async () => {
        renderResult = render(<MonitoringDashboard />);
      });
      const { queryByTestId, container } = renderResult!;
      const tablesTrigger = Array.from(container.querySelectorAll('[role="tab"]')).find((t) =>
        t.textContent?.includes("Tables"),
      ) as HTMLElement;
      await user.click(tablesTrigger);
      await waitFor(() => {
        expect(queryByTestId("monitoring-tablestab")).not.toBeNull();
      });
      return tablesTabProps[tablesTabProps.length - 1].readOnly;
    };

    // The file's default connections carry no readOnly.
    expect(await openTables()).toBe(false);
    cleanup();

    const storageModule = await import("@/lib/storage");
    const storage = storageModule.storage as unknown as Record<string, unknown>;
    const originalGetConnections = storage.getConnections;
    storage.getConnections = mock(() => [
      { id: "c1", name: "Guarded", type: "postgres", host: "localhost", readOnly: true, createdAt: new Date() },
    ]);
    try {
      expect(await openTables()).toBe(true);
    } finally {
      storage.getConnections = originalGetConnections;
    }
  });

  test("hands the hook's previewMaintenance to the tables tab (spec 3.11)", async () => {
    const user = userEvent.setup();
    const previewMaintenance = mock(async () => ({ summary: "Loads users.", facts: [] }));
    const withPreview = { ...monitoringDataDefaults(), previewMaintenance };
    mockUseMonitoringData.mockImplementation(() => withPreview);
    tablesTabProps.length = 0;

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { queryByTestId, container } = renderResult!;
    const tablesTrigger = Array.from(container.querySelectorAll('[role="tab"]')).find((t) =>
      t.textContent?.includes("Tables"),
    ) as HTMLElement;
    await user.click(tablesTrigger);
    await waitFor(() => {
      expect(queryByTestId("monitoring-tablestab")).not.toBeNull();
    });

    expect(tablesTabProps[tablesTabProps.length - 1].onPreviewMaintenance).toBe(previewMaintenance);
  });

  // The route refuses maintenance and `kill` to a non-admin, so both tabs are told the signed-in role (#1424).
  test("tells the sessions and tables tabs whether the signed-in user is an admin", async () => {
    const openTab = async (name: string) => {
      const user = userEvent.setup();
      let renderResult: ReturnType<typeof render>;
      await act(async () => {
        renderResult = render(<MonitoringDashboard />);
      });
      const trigger = Array.from(renderResult!.container.querySelectorAll('[role="tab"]')).find((t) =>
        t.textContent?.includes(name),
      ) as HTMLElement;
      await user.click(trigger);
      cleanup();
    };
    const lastIsAdmin = async () => {
      sessionsTabProps.length = 0;
      tablesTabProps.length = 0;
      await openTab("Sessions");
      await openTab("Tables");
      return [sessionsTabProps.at(-1)?.isAdmin, tablesTabProps.at(-1)?.isAdmin];
    };

    expect(await lastIsAdmin()).toEqual([true, true]);
    currentRole = "user";
    expect(await lastIsAdmin()).toEqual([false, false]);
  });

  test("hands the sessions tab the declared capabilities with the connected maintenance over them (#1424)", async () => {
    const user = userEvent.setup();
    // The connected server refused `kill` where the type id declares it, as CockroachDB's narrowing can (#1387).
    currentCapabilities = { ...mockCapabilities, maintenanceOperations: ["analyze", "kill"] };
    const connected = { ...monitoringDataDefaults() };
    connected.data = {
      ...(connected.data as Record<string, unknown>),
      maintenance: { maintenanceOperations: ["analyze"] },
    };
    mockUseMonitoringData.mockImplementation(() => connected);
    sessionsTabProps.length = 0;

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const trigger = Array.from(renderResult!.container.querySelectorAll('[role="tab"]')).find((t) =>
      t.textContent?.includes("Sessions"),
    ) as HTMLElement;
    await user.click(trigger);

    const capabilities = sessionsTabProps.at(-1)?.capabilities as { maintenanceOperations: string[] };
    expect(capabilities.maintenanceOperations).toEqual(["analyze"]);
  });
});

/** The dashboard draws a tab only for a panel the connection's engine offers (FND-4). */
describe("MonitoringDashboard draws only the panels an engine offers", () => {
  const ofType = (id: string, type: string) => ({
    id,
    name: `${type} conn`,
    type,
    host: "localhost",
    port: 1,
    database: "dev",
    createdAt: new Date(),
  });
  let storageRecord: Record<string, unknown>;
  let originals: Record<string, unknown>;

  beforeEach(async () => {
    mockUseMonitoringData.mockClear();
    mockUseMonitoringData.mockImplementation(monitoringDataDefaults);
    selectCallbacks.clear();
    currentCapabilities = mockCapabilities;
    storageRecord = (await import("@/lib/storage")).storage as unknown as Record<string, unknown>;
    originals = {
      getConnections: storageRecord.getConnections,
      getActiveConnectionId: storageRecord.getActiveConnectionId,
    };
  });

  afterEach(() => {
    cleanup();
    Object.assign(storageRecord, originals);
  });

  const openOn = async (connections: ReturnType<typeof ofType>[], activeId: string) => {
    storageRecord.getConnections = mock(() => connections);
    storageRecord.getActiveConnectionId = mock(() => activeId);
    let view: ReturnType<typeof render>;
    await act(async () => {
      view = render(<MonitoringDashboard />);
    });
    return view!;
  };

  const tabTitles = (view: ReturnType<typeof render>): string[] =>
    Array.from(view.container.querySelectorAll('[role="tab"]')).map((tab) => tab.getAttribute("title") ?? "");

  test("draws a tab for each panel a Kafka connection's engine offers and Pool, and names the four it does not", async () => {
    const offer = ENGINE_FACETS.kafka.monitoring;
    expect([offer.overview, offer.storage]).toEqual(["offered", "offered"]);
    const view = await openOn([ofType("k1", "kafka")], "k1");

    expect(tabTitles(view)).toEqual(["Overview", "Storage", "Pool"]);
    expect(view.getByTestId("monitoring-not-offered").textContent).toBe(
      "Not offered by this engine: Performance, Queries, Sessions, Tables.",
    );
  });

  test("hands a Kafka connection's own offer to the Overview and Storage tabs", async () => {
    const user = userEvent.setup();
    overviewTabProps.length = 0;
    storageTabProps.length = 0;
    const view = await openOn([ofType("k1", "kafka")], "k1");
    expect(overviewTabProps.at(-1)?.offer).toEqual(ENGINE_FACETS.kafka.monitoring);

    const storage = Array.from(view.container.querySelectorAll('[role="tab"]')).find(
      (tab) => tab.getAttribute("title") === "Storage",
    ) as HTMLElement;
    await user.click(storage);
    await waitFor(() => {
      expect(view.queryByTestId("monitoring-storagetab")).not.toBeNull();
    });
    expect(storageTabProps.at(-1)?.offer).toEqual(ENGINE_FACETS.kafka.monitoring);
  });

  /** The panel each tab draws, written out here so a tab wired to another panel fails on the engines that tell them apart. */
  const PANEL_OF_TAB: readonly [string, MonitoringPanel][] = [
    ["Overview", "overview"],
    ["Performance", "performance"],
    ["Queries", "slowQueries"],
    ["Sessions", "activeSessions"],
    ["Tables", "tables"],
    ["Storage", "storage"],
  ];

  test.each(Object.keys(ENGINE_FACETS) as DatabaseType[])(
    "a %s connection draws a tab for exactly the panels its engine offers",
    async (type) => {
      const offer = ENGINE_FACETS[type].monitoring;
      const offered = PANEL_OF_TAB.filter(([, panel]) => offer[panel] === "offered").map(([title]) => title);
      const view = await openOn([ofType("e1", type)], "e1");

      expect(tabTitles(view)).toEqual(Object.values(offer).includes("offered") ? [...offered, "Pool"] : []);
    },
  );

  test("the engines above include Cassandra and Druid, whose offers tell the tabs apart", () => {
    const titles = (type: DatabaseType) =>
      PANEL_OF_TAB.filter(([, panel]) => ENGINE_FACETS[type].monitoring[panel] === "offered").map(([title]) => title);
    expect(titles("cassandra")).toEqual(["Overview", "Performance", "Sessions"]);
    expect(titles("druid")).toEqual(["Overview", "Sessions", "Tables", "Storage"]);
  });

  test("draws every tab and no not-offered line for an engine that offers every panel", async () => {
    const view = await openOn([ofType("p1", "postgres")], "p1");

    expect(tabTitles(view)).toEqual(["Overview", "Performance", "Queries", "Sessions", "Tables", "Storage", "Pool"]);
    expect(view.queryByTestId("monitoring-not-offered")).toBeNull();
  });

  test("an S3 connection draws that its engine offers no monitoring panel and requests no monitoring data", async () => {
    const view = await openOn([ofType("s1", "s3")], "s1");

    expect(view.queryByText("No Monitoring Panels")).not.toBeNull();
    expect(view.queryByText("This engine offers no monitoring panel in LibreDB Studio.")).not.toBeNull();
    expect(view.container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    const handed = mockUseMonitoringData.mock.calls.map((call) => (call as unknown[])[0]);
    expect(handed.length).toBeGreaterThan(0);
    expect(handed.filter((connection) => connection !== null)).toEqual([]);
  });

  test("a connection whose engine does not offer the open tab opens on the first tab it offers", async () => {
    const user = userEvent.setup();
    const view = await openOn([ofType("p1", "postgres"), ofType("k1", "kafka")], "p1");
    const sessions = Array.from(view.container.querySelectorAll('[role="tab"]')).find(
      (tab) => tab.getAttribute("title") === "Sessions",
    ) as HTMLElement;
    await user.click(sessions);
    await waitFor(() => {
      expect(view.queryByTestId("monitoring-sessionstab")).not.toBeNull();
    });

    await act(async () => {
      selectCallbacks.get("p1")!("k1");
    });

    expect(view.queryByTestId("monitoring-sessionstab")).toBeNull();
    expect(view.queryByTestId("monitoring-overviewtab")).not.toBeNull();
    const selected = view.container.querySelector('[role="tab"][aria-selected="true"]');
    expect(selected?.getAttribute("title")).toBe("Overview");
  });
});

/** A server-level connection's panels are one database's, and nothing is read before that database is known (#1530). */
describe("MonitoringDashboard on a server-level connection", () => {
  const SERVER_LEVEL = {
    ...mockCapabilities,
    catalogSessions: true,
    containerLevels: [{ id: "catalog" }, { id: "schema" }],
  };
  const databases = {
    json: [
      { path: ["analytics"], name: "analytics", level: 0 },
      { path: ["shop"], name: "shop", level: 0 },
    ],
  };
  /** The connection and database of every monitoring read the dashboard asked for, in order. */
  const reads = () =>
    (mockUseMonitoringData.mock.calls as unknown[][]).map((call) => ({ connection: call[0], catalog: call[2] }));

  beforeEach(() => {
    mockUseMonitoringData.mockClear();
    mockUseMonitoringData.mockImplementation(monitoringDataDefaults);
    currentCapabilities = mockCapabilities;
    metadataPending = false;
    metadataFailure = null;
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
    metadataPending = false;
    metadataFailure = null;
  });

  test("a declaration that failed to read does not hold the page: it reads the connection as before", async () => {
    metadataFailure = "provider-meta refused";
    await act(async () => {
      render(<MonitoringDashboard />);
    });
    await waitFor(() => expect(reads().some((read) => read.connection !== null)).toBe(true));
    expect(reads().find((read) => read.connection !== null)?.catalog).toBeUndefined();
  });

  test("nothing is read while the declaration is pending, and the first read names the database", async () => {
    metadataPending = true;
    await act(async () => {
      render(<MonitoringDashboard />);
    });
    expect(reads().length).toBeGreaterThan(0);
    expect(reads().every((read) => read.connection === null)).toBe(true);
    cleanup();

    metadataPending = false;
    currentCapabilities = SERVER_LEVEL;
    mockGlobalFetch({ "/api/db/objects/containers": databases });
    mockUseMonitoringData.mockClear();
    await act(async () => {
      render(<MonitoringDashboard />);
    });
    await waitFor(() => expect(reads().some((read) => read.connection !== null)).toBe(true));
    expect(reads().find((read) => read.connection !== null)?.catalog).toBe("analytics");
  });

  test("a database list the server refuses is the page's error, and Try Again reads it again", async () => {
    currentCapabilities = SERVER_LEVEL;
    // Held, the real hook has no data to show; the error panel stands in for it.
    mockUseMonitoringData.mockImplementation(() => ({ ...monitoringDataDefaults(), data: null }));
    mockGlobalFetch({ "/api/db/objects/containers": { ok: false, status: 500, text: "not json" } });
    let view: ReturnType<typeof render>;
    await act(async () => {
      view = render(<MonitoringDashboard />);
    });
    expect(await view!.findByText("Failed to list the server's databases")).toBeTruthy();
    expect(reads().every((read) => read.connection === null)).toBe(true);
    expect(mockRefresh).not.toHaveBeenCalled();

    mockGlobalFetch({ "/api/db/objects/containers": databases });
    await act(async () => {
      fireEvent.click(view!.getByText("Try Again"));
    });
    await waitFor(() => expect(reads().some((read) => read.connection !== null)).toBe(true));
    expect(reads().find((read) => read.connection !== null)?.catalog).toBe("analytics");
  });
});
