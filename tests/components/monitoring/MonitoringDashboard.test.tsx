import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { mock } from "bun:test";
import { setupRechartssMock, setupFramerMotionMock } from "../../helpers/mock-monaco";

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
mock.module("@/components/monitoring/tabs/OverviewTab", () => ({
  OverviewTab: () => {
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

mock.module("@/components/monitoring/tabs/SessionsTab", () => ({
  SessionsTab: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return React.createElement("div", { "data-testid": "monitoring-sessionstab" }, "SessionsTab");
  },
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
  supportsCreateTable: true,
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

mock.module("@/hooks/use-provider-metadata", () => ({
  useProviderMetadata: mock((connection: { id?: string } | null) => {
    providerMetadataCalls.push(connection);
    return {
      metadata: {
        capabilities: mockCapabilities,
        labels: mockLabels,
      },
      isLoading: false,
    };
  }),
}));

mock.module("@/components/monitoring/tabs/StorageTab", () => ({
  StorageTab: () => {
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
import { render, act, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

import { mockRouterPush } from "../../helpers/mock-navigation";

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
});
