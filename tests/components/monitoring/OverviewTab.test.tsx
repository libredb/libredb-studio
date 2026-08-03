import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { OverviewTab } from "@/components/monitoring/tabs/OverviewTab";
import type { MonitoringData } from "@/lib/db/types";
import type { TimeSeriesPoint } from "@/lib/time-series-buffer";

mock.module("@/components/monitoring/tabs/MetricChart", () => ({
  MetricChart: ({ title }: { title: string }) => React.createElement("div", { "data-testid": "metric-chart" }, title),
}));

function makeData(): MonitoringData {
  return {
    timestamp: new Date("2026-02-15T12:00:00Z"),
    overview: {
      version: "PostgreSQL 16.3",
      uptime: "2h 5m",
      activeConnections: 8,
      maxConnections: 100,
      databaseSize: "1.8 GB",
      databaseSizeBytes: 1932735283,
      tableCount: 24,
      indexCount: 61,
    },
    performance: {
      cacheHitRatio: 95.7,
      bufferPoolUsage: 62,
      deadlocks: 1,
      checkpointWriteTime: "18ms",
    },
    slowQueries: [{ query: "SELECT 1", calls: 10, totalTime: 100, avgTime: 10, rows: 10 }],
    activeSessions: [
      { pid: 1, user: "admin", database: "db", state: "active", query: "SELECT 1", duration: "1s", durationMs: 1000 },
      { pid: 2, user: "app", database: "db", state: "idle", query: "", duration: "2s", durationMs: 2000 },
    ],
  } as unknown as MonitoringData;
}

function makeHistory(): TimeSeriesPoint<MonitoringData>[] {
  return [
    { timestamp: new Date("2026-02-15T12:00:00Z"), data: makeData() },
    {
      timestamp: new Date("2026-02-15T12:01:00Z"),
      data: { ...makeData(), overview: { ...makeData().overview, activeConnections: 12 } } as MonitoringData,
    },
  ] as unknown as TimeSeriesPoint<MonitoringData>[];
}

describe("OverviewTab", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders skeleton while loading without data", () => {
    const { queryByText } = render(<OverviewTab data={null} loading />);
    expect(queryByText("Connections")).toBeNull();
  });

  test("renders key overview cards and quick stats", () => {
    const { queryByText, container } = render(<OverviewTab data={makeData()} loading={false} />);
    expect(queryByText("PostgreSQL 16.3")).not.toBeNull();
    expect(queryByText("2h 5m")).not.toBeNull();
    expect(container.textContent).toContain("8/100");
    expect(queryByText("8% used")).not.toBeNull();
    expect(queryByText("24")).not.toBeNull();
    expect(queryByText("61 indexes")).not.toBeNull();
    expect(queryByText("Quick Stats")).not.toBeNull();
  });

  // An engine with no connection pool reports maxConnections 0, which means "no
  // limit published" rather than "no capacity" - Apache Druid and, per its own
  // comment, SQL Server both do. Dividing by it used to render the literal
  // "NaN% used" and an NaN-width progress bar.
  test("reports no limit instead of NaN when the engine publishes no connection ceiling", () => {
    const base = makeData();
    const { queryByText, container } = render(
      <OverviewTab
        data={{ ...base, overview: { ...base.overview, activeConnections: 3, maxConnections: 0 } } as MonitoringData}
        loading={false}
      />,
    );

    expect(container.textContent).not.toContain("NaN");
    expect(queryByText("no limit published")).not.toBeNull();
    // The count is still shown; only the meaningless share is withheld.
    expect(container.textContent).toContain("3");
    expect(container.textContent).not.toContain("3/0");
  });

  // Absence must not be displayed as a measured 0%, and must not be scored as the
  // critical cache fault that a real 0 would be.
  test("withholds the cache ratio card's percentage and rating when the engine cannot measure one", () => {
    const base = makeData();
    const { queryByText, container } = render(
      <OverviewTab
        data={{ ...base, performance: { ...base.performance, cacheHitRatio: undefined } } as MonitoringData}
        loading={false}
      />,
    );

    expect(container.textContent).not.toContain("0.0%");
    expect(queryByText("Poor")).toBeNull();
  });

  test("renders connection trend when history has enough points", () => {
    const { queryByText, queryByTestId } = render(
      <OverviewTab data={makeData()} loading={false} history={makeHistory()} />,
    );
    expect(queryByText("Connection Trend")).not.toBeNull();
    expect(queryByTestId("metric-chart")).not.toBeNull();
  });

  test("labels cache hit ratio between 80 and 90 as Good", () => {
    const data = { ...makeData(), performance: { ...makeData().performance, cacheHitRatio: 85 } } as MonitoringData;
    const { queryByText } = render(<OverviewTab data={data} loading={false} />);
    expect(queryByText("Good")).not.toBeNull();
  });

  test("labels cache hit ratio below 80 as Needs tuning", () => {
    const data = { ...makeData(), performance: { ...makeData().performance, cacheHitRatio: 72 } } as MonitoringData;
    const { queryByText } = render(<OverviewTab data={data} loading={false} />);
    expect(queryByText("Needs tuning")).not.toBeNull();
  });

  test("renders the measured cache hit ratio with a bar and a rating", () => {
    const { queryByText } = render(<OverviewTab data={makeData()} loading={false} />);
    const card = queryByText("Cache Hit")!.closest('[data-slot="card"]')!;
    expect(card.textContent).toContain("95.7%");
    expect(card.querySelectorAll('[data-slot="progress"]').length).toBe(1);
    expect(queryByText("Excellent")).not.toBeNull();
  });

  test("reports an unmeasured cache hit ratio as unavailable instead of 0.0%", () => {
    const data = { ...makeData(), performance: { bufferPoolUsage: 62, deadlocks: 0 } } as MonitoringData;
    const { queryByText, container } = render(<OverviewTab data={data} loading={false} />);

    // The card, its title and the 4-card grid all stay put.
    expect(queryByText("Cache Hit")).not.toBeNull();
    expect(container.querySelectorAll('[data-slot="card"]').length).toBe(6);

    const card = queryByText("Cache Hit")!.closest('[data-slot="card"]')!;
    expect(card.textContent).toContain("N/A");
    expect(card.textContent).toContain("Not measured");
    // No fabricated measurement: no percentage, no bar, no rating.
    expect(card.textContent).not.toContain("%");
    expect(card.querySelectorAll('[data-slot="progress"]').length).toBe(0);
    expect(queryByText("Excellent")).toBeNull();
    expect(queryByText("Good")).toBeNull();
    expect(queryByText("Needs tuning")).toBeNull();
    // Absence is not a fault: nothing red or yellow on the card.
    expect(card.className).not.toContain("red");
    expect(card.className).not.toContain("yellow");
  });
});
