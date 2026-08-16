import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { mock } from "bun:test";
import { setupRechartssMock, setupFramerMotionMock } from "../../helpers/mock-monaco";

setupRechartssMock();
setupFramerMotionMock();

// Mock date-fns to avoid complex date computations in tests
mock.module("date-fns", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  format: (date: Date, fmt: string) => "Mon",
  subDays: (date: Date, days: number) => new Date(date.getTime() - days * 86400000),
  startOfDay: (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()),
}));

const mockGetConnections = mock(() => [
  {
    id: "c1",
    name: "PG Dev",
    type: "postgres",
    host: "localhost",
    port: 5432,
    database: "dev",
    createdAt: new Date(),
  },
]);

const mockGetHistory = mock(() => [
  {
    id: "h1",
    query: "SELECT 1",
    executedAt: new Date(),
    executionTime: 10,
    rowCount: 1,
    status: "success",
    connectionId: "c1",
    connectionName: "PG Dev",
  },
]);

mock.module("@/lib/storage", () => ({
  storage: {
    getConnections: mockGetConnections,
    getHistory: mockGetHistory,
    getDismissedSeeds: mock(() => []),
  },
}));

mock.module("@/lib/db-ui-config", () => ({
  getDBIcon: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return (props: Record<string, unknown>) => React.createElement("span", { ...props, "data-testid": "db-icon" });
  },
  getDBColor: () => "text-blue-400",
  getDBConfig: () => ({ icon: () => null, color: "text-blue-400", label: "PostgreSQL", defaultPort: "5432" }),
}));

mock.module("next/link", () => ({
  default: ({ children, href, ...props }: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return React.createElement("a", { href, ...props }, children);
  },
}));

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, waitFor, act, cleanup } from "@testing-library/react";
import React from "react";

import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";

import { OverviewTab } from "@/components/admin/tabs/OverviewTab";

// =============================================================================
// OverviewTab Tests
// =============================================================================

describe("OverviewTab", () => {
  afterEach(() => {
    cleanup();
  });

  let fetchMock: ReturnType<typeof mockGlobalFetch>;

  beforeEach(() => {
    mockGetConnections.mockClear();
    mockGetHistory.mockClear();

    // Reset to default return values
    mockGetConnections.mockImplementation(() => [
      {
        id: "c1",
        name: "PG Dev",
        type: "postgres",
        host: "localhost",
        port: 5432,
        database: "dev",
        createdAt: new Date(),
      },
    ]);

    mockGetHistory.mockImplementation(() => [
      {
        id: "h1",
        query: "SELECT 1",
        executedAt: new Date(),
        executionTime: 10,
        rowCount: 1,
        status: "success",
        connectionId: "c1",
        connectionName: "PG Dev",
      },
    ]);

    fetchMock = mockGlobalFetch({
      "/api/admin/audit": {
        json: { events: [] },
      },
      "/api/admin/fleet-health": {
        json: {
          results: [
            {
              connectionId: "c1",
              connectionName: "PG Dev",
              type: "postgres",
              status: "healthy",
              latencyMs: 15,
              databaseSize: "256 MB",
              activeConnections: 5,
            },
          ],
        },
      },
    });
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  test("renders when user provided", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OverviewTab user={{ username: "admin", role: "admin" }} />);
    });
    const { queryByText } = renderResult!;

    // Should render content (not empty state) when connections exist
    await waitFor(() => {
      // Hero section should contain status text
      expect(queryByText("All Systems Operational")).not.toBeNull();
    });
  });

  test("shows empty state when no connections", async () => {
    mockGetConnections.mockImplementation(() => []);

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OverviewTab user={{ username: "admin", role: "admin" }} />);
    });
    const { queryByText } = renderResult!;

    // The empty state shows "Welcome to Command Center"
    expect(queryByText("Welcome to Command Center")).not.toBeNull();
  });

  test("shows hero section when connections exist", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OverviewTab user={{ username: "admin", role: "admin" }} />);
    });
    const { queryByText } = renderResult!;

    await waitFor(() => {
      // Hero section contains health label and status
      expect(queryByText("Health")).not.toBeNull();
      expect(queryByText("Live")).not.toBeNull();
    });
  });

  test("fleet health section renders", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OverviewTab user={{ username: "admin", role: "admin" }} />);
    });
    const { queryByText } = renderResult!;

    await waitFor(() => {
      expect(queryByText("Fleet Status")).not.toBeNull();
    });
  });

  test("quick actions section renders", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OverviewTab user={{ username: "admin", role: "admin" }} />);
    });
    const { queryByText } = renderResult!;

    await waitFor(() => {
      expect(queryByText("Quick Actions")).not.toBeNull();
      expect(queryByText("Maintenance")).not.toBeNull();
      expect(queryByText("Security & Masking")).not.toBeNull();
      expect(queryByText("Real-time Monitoring")).not.toBeNull();
    });
  });

  test("fetches fleet health on mount", async () => {
    await act(async () => {
      render(<OverviewTab user={{ username: "admin", role: "admin" }} />);
    });

    await waitFor(() => {
      const calls = fetchMock.mock.calls;
      const fleetCall = calls.find((c: unknown[]) => {
        const url = typeof c[0] === "string" ? c[0] : "";
        return url.includes("/api/admin/fleet-health");
      });
      expect(fleetCall).not.toBeUndefined();
    });
  });

  test("shows key metrics section", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OverviewTab user={{ username: "admin", role: "admin" }} />);
    });
    const { queryByText, queryAllByText } = renderResult!;

    await waitFor(() => {
      expect(queryByText("Key Metrics")).not.toBeNull();
      expect(queryByText("Query Success")).not.toBeNull();
      expect(queryByText("Fleet Health")).not.toBeNull();
      expect(queryByText("Avg Response")).not.toBeNull();
      expect(queryAllByText("Total Queries").length).toBeGreaterThan(0);
    });
  });

  test("shows user badge in hero section", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OverviewTab user={{ username: "admin", role: "admin" }} />);
    });
    const { queryByText } = renderResult!;

    await waitFor(() => {
      expect(queryByText("admin (admin)")).not.toBeNull();
    });
  });

  test("maps audit events into the activity feed and formats their relative times", async () => {
    const now = Date.now();
    fetchMock = mockGlobalFetch({
      "/api/admin/audit": {
        json: {
          events: [
            {
              id: "a1",
              timestamp: new Date(now - 5 * 60 * 1000).toISOString(),
              type: "query_execution",
              action: "Executed query",
              target: "orders",
              connectionName: "PG Dev",
              user: "admin",
              result: "success",
            },
            {
              id: "a2",
              timestamp: new Date(now - 5 * 60 * 60 * 1000).toISOString(),
              type: "maintenance",
              action: "Ran VACUUM",
              target: "orders",
              connectionName: "PG Dev",
              user: "admin",
              result: "success",
            },
            {
              id: "a3",
              timestamp: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
              type: "kill_session",
              action: "Killed session",
              target: "session-42",
              connectionName: "PG Dev",
              user: "admin",
              result: "failure",
            },
          ],
        },
      },
      "/api/admin/fleet-health": {
        json: {
          results: [
            {
              connectionId: "c1",
              connectionName: "PG Dev",
              type: "postgres",
              status: "healthy",
              latencyMs: 15,
              databaseSize: "256 MB",
              activeConnections: 5,
            },
          ],
        },
      },
    });

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OverviewTab user={{ username: "admin", role: "admin" }} />);
    });
    const { queryByText } = renderResult!;

    await waitFor(() => {
      // Audit events are mapped into the feed alongside query history
      expect(queryByText("Executed query orders")).not.toBeNull();
      expect(queryByText("Killed session session-42")).not.toBeNull();
      // formatRelativeTime: minutes / hours / days branches
      expect(queryByText("5m ago")).not.toBeNull();
      expect(queryByText("5h ago")).not.toBeNull();
      expect(queryByText("3d ago")).not.toBeNull();
    });
  });

  test("computes the good-range avg latency gauge color and the kb database size branch", async () => {
    fetchMock = mockGlobalFetch({
      "/api/admin/audit": { json: { events: [] } },
      "/api/admin/fleet-health": {
        json: {
          results: [
            {
              connectionId: "c1",
              connectionName: "PG Dev",
              type: "postgres",
              status: "healthy",
              latencyMs: 150,
              databaseSize: "512 kb",
              activeConnections: 5,
            },
          ],
        },
      },
    });

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OverviewTab user={{ username: "admin", role: "admin" }} />);
    });
    const { queryByText } = renderResult!;

    await waitFor(() => {
      // getGaugeColorReverse: value in (50, 200] -> "good" branch
      expect(queryByText("150")).not.toBeNull();
      // totalDBSize aggregation: "kb" branch
      expect(queryByText("512 KB")).not.toBeNull();
    });
  });

  test("computes the warning-range avg latency gauge color", async () => {
    fetchMock = mockGlobalFetch({
      "/api/admin/audit": { json: { events: [] } },
      "/api/admin/fleet-health": {
        json: {
          results: [
            {
              connectionId: "c1",
              connectionName: "PG Dev",
              type: "postgres",
              status: "healthy",
              latencyMs: 300,
              databaseSize: "10 MB",
              activeConnections: 5,
            },
          ],
        },
      },
    });

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OverviewTab user={{ username: "admin", role: "admin" }} />);
    });
    const { queryByText } = renderResult!;

    await waitFor(() => {
      // getGaugeColorReverse: value in (200, 500] -> "warning" branch
      expect(queryByText("300")).not.toBeNull();
    });
  });

  test("computes the critical-range avg latency gauge color", async () => {
    fetchMock = mockGlobalFetch({
      "/api/admin/audit": { json: { events: [] } },
      "/api/admin/fleet-health": {
        json: {
          results: [
            {
              connectionId: "c1",
              connectionName: "PG Dev",
              type: "postgres",
              status: "healthy",
              latencyMs: 600,
              databaseSize: "10 MB",
              activeConnections: 5,
            },
          ],
        },
      },
    });

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OverviewTab user={{ username: "admin", role: "admin" }} />);
    });
    const { queryByText } = renderResult!;

    await waitFor(() => {
      // getGaugeColorReverse: value > 500 -> "critical" branch
      expect(queryByText("600")).not.toBeNull();
    });
  });

  test("fleet health section styles degraded and error status cards", async () => {
    fetchMock = mockGlobalFetch({
      "/api/admin/audit": { json: { events: [] } },
      "/api/admin/fleet-health": {
        json: {
          results: [
            {
              connectionId: "c1",
              connectionName: "PG Staging",
              type: "postgres",
              status: "degraded",
              latencyMs: 120,
              databaseSize: "10 MB",
            },
            {
              connectionId: "c2",
              connectionName: "PG Prod",
              type: "postgres",
              status: "error",
              latencyMs: 999,
              error: "Connection refused",
            },
          ],
        },
      },
    });

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OverviewTab user={{ username: "admin", role: "admin" }} />);
    });
    const { queryByText } = renderResult!;

    await waitFor(() => {
      // "degraded" branch of getStatusColor
      expect(queryByText("PG Staging")).not.toBeNull();
      // default ("error") branch of getStatusColor
      expect(queryByText("PG Prod")).not.toBeNull();
      expect(queryByText("timeout")).not.toBeNull();
      expect(queryByText("Connection refused")).not.toBeNull();
    });
  });

  // ── Chart tooltip ──────────────────────────────────────────────────────────

  /**
   * Recharts inline-styles its tooltip, so it is one of the surfaces that cannot
   * read the CSS tokens and has to be handed a palette. Left hardcoded, the dark
   * card stayed dark on a light page — dark ink on a near-black box.
   */
  async function tooltipStyleUnderTheme(theme: "dark" | "light") {
    document.documentElement.classList.remove("dark", "light");
    document.documentElement.classList.add(theme);
    mockGlobalFetch({ "/api/admin/audit": { ok: true, json: { events: [] } } });

    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(<OverviewTab user={{ username: "admin", role: "admin" }} />);
    });
    const tooltip = result!.container.querySelector("[data-testid='mock-tooltip']");
    return { bg: tooltip?.getAttribute("data-bg"), color: tooltip?.getAttribute("data-color") };
  }

  test("the query-volume tooltip is dark-on-dark in the dark theme", async () => {
    const { bg, color } = await tooltipStyleUnderTheme("dark");
    expect(bg).toBe("#18181b");
    expect(color).toBe("#a1a1aa");
  });

  test("and light-on-white in the light theme", async () => {
    const { bg, color } = await tooltipStyleUnderTheme("light");
    expect(bg).toBe("#ffffff");
    expect(color).toBe("#3f3f46");
  });
});
