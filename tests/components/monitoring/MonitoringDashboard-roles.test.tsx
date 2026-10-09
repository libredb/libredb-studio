import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { mock, describe, test, expect, afterEach, beforeEach } from "bun:test";
import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PostgresProvider } from "@/lib/db/providers/sql/postgres";

// /monitoring rendered with the REAL Sessions and Tables tabs, so what a signed-in user is offered is read off the
// page itself rather than off the props the dashboard hands down (#1424). The other five tabs are
// stubbed: none of them offers a maintenance or Terminate control, and the default Overview tab draws charts.

const postgresCaps = new PostgresProvider({
  id: "c1",
  name: "PG Dev",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "dev",
  createdAt: new Date(0),
}).getCapabilities();

let currentRole = "admin";

mock.module("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { role: currentRole },
    isAdmin: currentRole === "admin",
    handleLogout: mock(async () => {}),
  }),
}));

mock.module("@/hooks/use-provider-metadata", () => ({
  useProviderMetadata: () => ({ metadata: { capabilities: postgresCaps }, isLoading: false }),
}));

mock.module("@/hooks/use-monitoring-data", () => ({
  useMonitoringData: () => ({
    data: {
      timestamp: new Date(0),
      slowQueries: [],
      activeSessions: [
        {
          pid: 101,
          user: "app",
          database: "dev",
          state: "active",
          query: "SELECT 1",
          duration: "1s",
          durationMs: 1000,
        },
      ],
      tables: [
        {
          schemaName: "public",
          tableName: "users",
          rowCount: 1200,
          deadRowCount: 10,
          tableSize: "100 MB",
          tableSizeBytes: 104857600,
          indexSize: "20 MB",
          indexSizeBytes: 20971520,
          totalSize: "120 MB",
          totalSizeBytes: 125829120,
          bloatRatio: 5,
        },
      ],
    },
    loading: false,
    error: null,
    lastUpdated: new Date(0),
    autoRefresh: false,
    refreshInterval: 30000,
    history: [],
    setAutoRefresh: mock(() => {}),
    setRefreshInterval: mock(() => {}),
    refresh: mock(() => {}),
    killSession: mock(async () => true),
    runMaintenance: mock(async () => true),
    previewMaintenance: mock(async () => ({ summary: "", facts: [] })),
  }),
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
        createdAt: new Date(0),
      },
    ]),
    getActiveConnectionId: mock(() => "c1"),
    getDismissedSeeds: mock(() => []),
  },
}));

for (const [path, name] of [
  ["@/components/monitoring/tabs/OverviewTab", "OverviewTab"],
  ["@/components/monitoring/tabs/PerformanceTab", "PerformanceTab"],
  ["@/components/monitoring/tabs/QueriesTab", "QueriesTab"],
  ["@/components/monitoring/tabs/StorageTab", "StorageTab"],
  ["@/components/monitoring/tabs/PoolTab", "PoolTab"],
] as const) {
  mock.module(path, () => ({ [name]: () => React.createElement("div", {}, name) }));
}

// Dynamic import AFTER the mock.module() calls above, as in MonitoringDashboard.test.tsx.
const { MonitoringDashboard } = await import("@/components/monitoring/MonitoringDashboard");

/** Opens one tab of a fresh /monitoring render and returns its container. */
async function openTab(name: string): Promise<HTMLElement> {
  const user = userEvent.setup();
  let view: ReturnType<typeof render>;
  await act(async () => {
    view = render(<MonitoringDashboard />);
  });
  const trigger = Array.from(view!.container.querySelectorAll('[role="tab"]')).find((tab) =>
    tab.textContent?.includes(name),
  ) as HTMLElement;
  await user.click(trigger);
  await waitFor(() => expect(trigger.getAttribute("data-state")).toBe("active"));
  return view!.container;
}

const terminateButtons = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button")).filter((button) =>
    button.getAttribute("aria-label")?.startsWith("Terminate session"),
  );

// Every per-row maintenance control in the Tables tab is a titled icon button inside the table body.
const rowMaintenanceButtons = (container: HTMLElement) => Array.from(container.querySelectorAll("tbody button[title]"));

describe("/monitoring offers maintenance and Terminate only to an admin", () => {
  beforeEach(() => {
    currentRole = "admin";
  });

  afterEach(() => {
    cleanup();
  });

  test("an admin on PostgreSQL is offered Terminate and the per-row maintenance", async () => {
    expect(terminateButtons(await openTab("Sessions"))).toHaveLength(1);
    cleanup();
    expect(rowMaintenanceButtons(await openTab("Tables")).length).toBeGreaterThan(0);
  });

  test("a non-admin is offered neither", async () => {
    currentRole = "user";
    expect(terminateButtons(await openTab("Sessions"))).toHaveLength(0);
    cleanup();
    expect(rowMaintenanceButtons(await openTab("Tables"))).toHaveLength(0);
  });
});
