import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { mock, describe, test, expect, afterEach } from "bun:test";
import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { SessionsTab } from "@/components/monitoring/tabs/SessionsTab";
import type { MonitoringData, ProviderLabels } from "@/lib/db/types";

mock.module("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
}));

mock.module("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? React.createElement("div", { "data-testid": "alert-dialog" }, children) : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => React.createElement("h2", {}, children),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => React.createElement("p", {}, children),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) =>
    React.createElement("button", { type: "button" }, children),
  AlertDialogAction: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) =>
    React.createElement("button", { type: "button", onClick }, children),
}));

function makeData(): MonitoringData {
  return {
    timestamp: new Date("2026-02-15T12:00:00Z"),
    overview: {
      version: "16.3",
      uptime: "1s",
      activeConnections: 3,
      maxConnections: 100,
      databaseSize: "1 GB",
      databaseSizeBytes: 1024 * 1024 * 1024,
      tableCount: 0,
      indexCount: 0,
    },
    performance: {
      queriesPerSecond: 12,
      avgQueryTime: 7,
      cacheHitRatio: 98,
      cpuUsage: 15,
      memoryUsage: 40,
      memoryTotal: 100,
      memoryUsed: 40,
      diskUsage: 33,
      diskTotal: 100,
      diskUsed: 33,
      swapUsage: 0,
      loadAverage: [0.2, 0.3, 0.4],
      networkRx: 1,
      networkTx: 2,
      transactionsPerSecond: 8,
      commitsPerSecond: 7,
      rollbacksPerSecond: 1,
      tempFilesPerSecond: 0,
      deadlocksPerSecond: 0,
      replicationLag: 0,
      checkpointWriteTime: 0,
    },
    slowQueries: [],
    activeSessions: [
      {
        pid: 101,
        user: "admin",
        database: "db",
        state: "active",
        query: "SELECT * FROM users",
        duration: "1.2s",
        durationMs: 1200,
      },
      {
        pid: 202,
        user: "app",
        database: "db",
        state: "idle in transaction",
        query: "UPDATE users SET active = true",
        duration: "65s",
        durationMs: 65000,
        waitEventType: "Lock",
      },
    ],
  } as unknown as MonitoringData;
}

describe("SessionsTab", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders skeleton when loading and data is null", () => {
    const { queryByText } = render(<SessionsTab data={null} loading onKillSession={mock(async () => true)} />);
    expect(queryByText("Sessions (")).toBeNull();
  });

  test("shows empty state when there are no active sessions", () => {
    const { queryByText } = render(
      <SessionsTab
        data={{ ...makeData(), activeSessions: [] } as MonitoringData}
        loading={false}
        onKillSession={mock(async () => true)}
      />,
    );
    expect(queryByText("No active sessions found.")).not.toBeNull();
  });

  test("renders stats and session state badges", () => {
    const { queryByText, queryAllByText } = render(
      <SessionsTab data={makeData()} loading={false} onKillSession={mock(async () => true)} />,
    );

    expect(queryByText("Sessions (2)")).not.toBeNull();
    expect(queryAllByText("Active").length).toBeGreaterThan(0);
    expect(queryByText("Idle in TX")).not.toBeNull();
    expect(queryByText("65s")).not.toBeNull();
  });

  test("renders badges for idle, aborted and unknown session states", () => {
    const data = {
      ...makeData(),
      activeSessions: [
        { pid: 301, user: "a", database: "db", state: "idle", query: "", duration: "3s", durationMs: 3000 },
        {
          pid: 302,
          user: "b",
          database: "db",
          state: "idle in transaction (aborted)",
          query: "",
          duration: "4s",
          durationMs: 4000,
        },
        { pid: 303, user: "c", database: "db", state: "starting", query: "", duration: "5s", durationMs: 5000 },
      ],
    } as MonitoringData;
    const { queryByText, queryAllByText } = render(
      <SessionsTab data={data} loading={false} onKillSession={mock(async () => true)} />,
    );

    // "Idle" appears both as a stats-card title and as the idle-state badge
    expect(queryAllByText("Idle").length).toBeGreaterThan(1);
    expect(queryByText("Aborted TX")).not.toBeNull();
    expect(queryByText("starting")).not.toBeNull();
  });

  test("calls onKillSession after confirming terminate action", async () => {
    const onKillSession = mock(async () => true);
    const { container, queryByText } = render(
      <SessionsTab data={makeData()} loading={false} onKillSession={onKillSession} isAdmin />,
    );

    const killButtons = Array.from(container.querySelectorAll("button")).filter((btn) =>
      btn.className.includes("text-destructive"),
    );
    expect(killButtons.length).toBeGreaterThan(0);
    fireEvent.click(killButtons[0]!);

    expect(queryByText("Terminate Session?")).not.toBeNull();
    const terminateButton = queryByText("Terminate");
    expect(terminateButton).not.toBeNull();
    fireEvent.click(terminateButton!);

    await waitFor(() => {
      expect(onKillSession).toHaveBeenCalledWith(101);
    });
  });

  test("hides admin actions when isAdmin is false", () => {
    const { queryAllByText } = render(
      <SessionsTab data={makeData()} loading={false} onKillSession={mock(async () => true)} isAdmin={false} />,
    );
    expect(queryAllByText("-").length).toBeGreaterThan(0);
  });
});

// One failing read costs its own panel, and the engine's own sentence reaches the user (2026-08-24).
describe("a refused activeSessions read", () => {
  // Scoped here as well as in the block above: bun:test registers a hook on the
  // enclosing describe only, so without this the first render in this block leaks into
  // the second and the control arm queries the previous test's DOM.
  afterEach(() => {
    cleanup();
  });

  const STARROCKS = "Unknown table 'information_schema.PROCESSLIST'.";

  function refused(): MonitoringData {
    const rest: MonitoringData = makeData();
    delete rest.activeSessions;
    return { ...rest, errors: { activeSessions: STARROCKS } };
  }

  test("shows the engine's own sentence instead of the empty-state copy", () => {
    const { getByTestId, queryByText } = render(
      <SessionsTab data={refused()} loading={false} onKillSession={mock(async () => true)} />,
    );

    expect(getByTestId("panel-unavailable-message").textContent).toBe(STARROCKS);
    expect(queryByText("No active sessions found.")).toBeNull();
  });

  test("an engine that answers no sessions still gets the empty state, not a failure", () => {
    const data = { ...makeData(), activeSessions: [] };
    const { queryByTestId, queryByText } = render(
      <SessionsTab data={data} loading={false} onKillSession={mock(async () => true)} />,
    );

    expect(queryByTestId("panel-unavailable")).toBeNull();
    expect(queryByText("No active sessions found.")).not.toBeNull();
  });
});

// #D48. "No active sessions found." reads as "nothing is running right now", which is
// false on an engine that publishes no session list and can never show a row. Both
// branches are pinned so the fallback cannot quietly become the only path again.
describe("an engine that publishes no session list says so in its own words", () => {
  const DUCKDB = "DuckDB publishes no session list - there is no duckdb_connections() table function.";

  afterEach(() => {
    cleanup();
  });

  test("prefers the provider's sessionsEmptyState over the default sentence", () => {
    const data = { ...makeData(), activeSessions: [] } as MonitoringData;
    const { queryByText } = render(
      <SessionsTab
        data={data}
        loading={false}
        onKillSession={mock(async () => true)}
        labels={{ sessionsEmptyState: DUCKDB } as ProviderLabels}
      />,
    );

    expect(queryByText(DUCKDB)).not.toBeNull();
    expect(queryByText("No active sessions found.")).toBeNull();
  });

  test("keeps the default sentence for a provider that declares no label", () => {
    const data = { ...makeData(), activeSessions: [] } as MonitoringData;
    const { queryByText } = render(
      <SessionsTab data={data} loading={false} onKillSession={mock(async () => true)} labels={{} as ProviderLabels} />,
    );

    expect(queryByText("No active sessions found.")).not.toBeNull();
  });

  test("a refused read still carries the failure reason, not the label", () => {
    // The label explains an absence; the failure branch explains a refusal. They are
    // different facts and the refusal wins where both could apply.
    const { getByTestId, queryByText } = render(
      <SessionsTab
        data={
          {
            ...makeData(),
            activeSessions: undefined,
            errors: { activeSessions: "permission denied" },
          } as unknown as MonitoringData
        }
        loading={false}
        onKillSession={mock(async () => true)}
        labels={{ sessionsEmptyState: DUCKDB } as ProviderLabels}
      />,
    );

    expect(getByTestId("panel-unavailable-message").textContent).toBe("permission denied");
    expect(queryByText(DUCKDB)).toBeNull();
  });
});

// Found in the browser on 2026-08-24 against StarRocks 3.3: the panel carried the
// engine's sentence while the four summary cards above it still read 0, and the card
// title still said "Sessions (0)". A refused read is not four zeros.
describe("the session summary never counts a refused read as zero", () => {
  afterEach(() => {
    cleanup();
  });

  const REFUSAL = "Getting analyzing error. Detail message: Unknown table 'information_schema.PROCESSLIST'.";

  function refusedData(): MonitoringData {
    const rest: MonitoringData = makeData();
    delete rest.activeSessions;
    return { ...rest, errors: { activeSessions: REFUSAL } } as MonitoringData;
  }

  test("the four summary cards read N/A", () => {
    const { getByTestId } = render(
      <SessionsTab data={refusedData()} loading={false} onKillSession={async () => true} />,
    );

    expect(getByTestId("session-stat-active").textContent).toBe("N/A");
    expect(getByTestId("session-stat-idle").textContent).toBe("N/A");
    expect(getByTestId("session-stat-in-tx").textContent).toBe("N/A");
    expect(getByTestId("session-stat-wait").textContent).toBe("N/A");
  });

  test("the card title names no count it does not have", () => {
    const { getByText } = render(<SessionsTab data={refusedData()} loading={false} onKillSession={async () => true} />);

    expect(getByText("Sessions")).not.toBeNull();
  });

  test("an answered empty list still reads 0, because no sessions is a measurement", () => {
    const data = { ...makeData(), activeSessions: [] } as MonitoringData;
    const { getByTestId, getByText } = render(
      <SessionsTab data={data} loading={false} onKillSession={async () => true} />,
    );

    expect(getByTestId("session-stat-active").textContent).toBe("0");
    expect(getByTestId("session-stat-wait").textContent).toBe("0");
    expect(getByText("Sessions (0)")).not.toBeNull();
  });
});
