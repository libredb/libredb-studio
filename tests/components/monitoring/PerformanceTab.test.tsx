import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { PerformanceTab } from "@/components/monitoring/tabs/PerformanceTab";
import type { MonitoringData } from "@/lib/db/types";
import type { TimeSeriesPoint } from "@/lib/time-series-buffer";

mock.module("@/components/monitoring/tabs/MetricChart", () => ({
  MetricChart: ({ title }: { title: string }) => React.createElement("div", { "data-testid": "metric-chart" }, title),
}));

function makeData(overrides: Partial<MonitoringData["performance"]> = {}): MonitoringData {
  return {
    timestamp: new Date("2026-02-15T12:00:00Z"),
    overview: {
      version: "16.3",
      uptime: "2h",
      activeConnections: 3,
      maxConnections: 100,
      databaseSize: "1 GB",
      databaseSizeBytes: 1024 * 1024 * 1024,
      tableCount: 2,
      indexCount: 3,
    },
    performance: {
      cacheHitRatio: 98.2,
      bufferPoolUsage: 65,
      deadlocks: 0,
      checkpointWriteTime: "12ms",
      ...overrides,
    },
    slowQueries: [],
    activeSessions: [],
  } as unknown as MonitoringData;
}

function makeHistory(): TimeSeriesPoint<MonitoringData>[] {
  return [
    { timestamp: new Date("2026-02-15T12:00:00Z"), data: makeData() },
    {
      timestamp: new Date("2026-02-15T12:01:00Z"),
      data: makeData({ cacheHitRatio: 96.1, bufferPoolUsage: 72, deadlocks: 1 }),
    },
  ] as unknown as TimeSeriesPoint<MonitoringData>[];
}

describe("PerformanceTab", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders skeleton while loading without data", () => {
    const { queryByText } = render(<PerformanceTab data={null} loading />);
    expect(queryByText("Cache Hit")).toBeNull();
  });

  test("renders healthy metrics and positive tip", () => {
    const { queryByText } = render(<PerformanceTab data={makeData()} loading={false} />);
    expect(queryByText("Cache Hit")).not.toBeNull();
    expect(queryByText("Buffer")).not.toBeNull();
    expect(queryByText("Deadlocks")).not.toBeNull();
    expect(queryByText("Performing well!")).not.toBeNull();
  });

  test("renders warning tips for low cache and deadlocks", () => {
    const { queryByText, queryAllByText } = render(
      <PerformanceTab data={makeData({ cacheHitRatio: 72, deadlocks: 3, bufferPoolUsage: 88 })} loading={false} />,
    );
    expect(queryByText("Low Cache Hit")).not.toBeNull();
    expect(queryAllByText("Deadlocks").length).toBeGreaterThan(0);
    expect(queryByText("Attention")).not.toBeNull();
  });

  test("renders the measured cache hit ratio with a bar and a rating", () => {
    const { queryByText } = render(<PerformanceTab data={makeData()} loading={false} />);
    const card = queryByText("Cache Hit")!.closest('[data-slot="card"]')!;
    expect(card.textContent).toContain("98.2");
    expect(card.textContent).toContain("%");
    expect(card.querySelectorAll('[data-slot="progress"]').length).toBe(1);
    expect(card.textContent).toContain("Excellent");
    expect(card.querySelector("svg")?.getAttribute("class")).toContain("text-green-500");
  });

  test("reports an unmeasured cache hit ratio as unavailable instead of 0%", () => {
    const data = {
      ...makeData(),
      performance: { bufferPoolUsage: 65, deadlocks: 0, checkpointWriteTime: "12ms" },
    } as MonitoringData;
    const { queryByText, container } = render(<PerformanceTab data={data} loading={false} />);

    // The card, its title and the 3-card grid all stay put.
    expect(queryByText("Cache Hit")).not.toBeNull();
    expect(container.querySelectorAll('[data-slot="card"]').length).toBe(5);

    const card = queryByText("Cache Hit")!.closest('[data-slot="card"]')!;
    expect(card.textContent).toContain("N/A");
    expect(card.textContent).toContain("Not measured");
    // No fabricated measurement: no percentage, no bar, no rating.
    expect(card.textContent).not.toContain("%");
    expect(card.querySelectorAll('[data-slot="progress"]').length).toBe(0);
    for (const rating of ["Excellent", "Good", "Fair", "Poor"]) {
      expect(card.textContent).not.toContain(rating);
    }
    // Absence is not a fault: no red icon, no red or yellow border, no advice.
    expect(card.querySelector("svg")?.getAttribute("class")).toContain("text-muted-foreground");
    expect(card.className).not.toContain("red");
    expect(card.className).not.toContain("yellow");
    expect(queryByText("Low Cache Hit")).toBeNull();
    expect(queryByText("Performing well!")).toBeNull();
  });

  test("shows trend charts when history has at least 2 points", () => {
    const { queryByText, queryAllByTestId } = render(
      <PerformanceTab data={makeData()} loading={false} history={makeHistory()} />,
    );
    expect(queryByText("Cache Hit Trend")).not.toBeNull();
    expect(queryByText("Buffer Pool Trend")).not.toBeNull();
    expect(queryByText("Deadlock Trend")).not.toBeNull();
    expect(queryAllByTestId("metric-chart").length).toBeGreaterThanOrEqual(3);
  });

  // An engine that cannot measure a cache hit ratio (Druid) reports none on every
  // sample. Mapping those to 0 plotted a measured 0% trend - the same fabricated
  // metric the current-value card withholds - so missing samples are dropped and the
  // card says so instead of drawing a floor.
  test("renders the cache trend as not measured when no history sample carries a ratio", () => {
    const history = [
      { timestamp: new Date("2026-02-15T12:00:00Z"), data: makeData({ cacheHitRatio: undefined }) },
      { timestamp: new Date("2026-02-15T12:01:00Z"), data: makeData({ cacheHitRatio: undefined }) },
    ] as unknown as TimeSeriesPoint<MonitoringData>[];

    const { queryByText, queryAllByText, queryAllByTestId, container } = render(
      <PerformanceTab data={makeData({ cacheHitRatio: undefined })} loading={false} history={history} />,
    );

    expect(queryByText("Cache Hit Trend")).not.toBeNull();
    // Twice: the current-value card and the trend card both decline to show a number.
    expect(queryAllByText("Not measured")).toHaveLength(2);
    // The other two trends still draw, so only the unmeasurable one is withheld.
    expect(queryAllByTestId("metric-chart").length).toBe(2);
    // And nothing anywhere claims a measured zero.
    expect(container.textContent).not.toContain("0.0%");
  });

  test("still plots the cache trend from the samples that do carry a ratio", () => {
    const history = [
      { timestamp: new Date("2026-02-15T12:00:00Z"), data: makeData({ cacheHitRatio: undefined }) },
      { timestamp: new Date("2026-02-15T12:01:00Z"), data: makeData({ cacheHitRatio: 96.1 }) },
    ] as unknown as TimeSeriesPoint<MonitoringData>[];

    const { queryAllByTestId } = render(<PerformanceTab data={makeData()} loading={false} history={history} />);

    expect(queryAllByTestId("metric-chart").length).toBe(3);
  });

  // Trino "holds no buffer pool" and "takes no locks, so there are no deadlocks to
  // count" (providers/sql/trino/introspect.ts:622-639), Cassandra and Druid omit the
  // same two fields, and sqlite.ts:729 sets bufferPoolUsage undefined outright. The
  // panel used to answer those absences with "0 %"/"Poor" and "0"/"None
  // detected"/"Healthy" - a rating and a clean bill of health for measurements nobody
  // made. Same rule as the cache hit ratio card three lines above it.
  test("reports an unmeasured buffer pool as unavailable instead of 0% and a rating", () => {
    const { queryByText } = render(<PerformanceTab data={makeData({ bufferPoolUsage: undefined })} loading={false} />);

    expect(queryByText("Buffer")).not.toBeNull();
    const card = queryByText("Buffer")!.closest('[data-slot="card"]')!;
    expect(card.textContent).toContain("N/A");
    expect(card.textContent).toContain("Not measured");
    // No fabricated measurement: no percentage, no bar, no rating.
    expect(card.textContent).not.toContain("%");
    expect(card.querySelectorAll('[data-slot="progress"]').length).toBe(0);
    for (const rating of ["Excellent", "Good", "Fair", "Poor"]) {
      expect(card.textContent).not.toContain(rating);
    }
    // Absence is not a fault: no red icon, no red or yellow border.
    expect(card.querySelector("svg")?.getAttribute("class")).toContain("text-muted-foreground");
    expect(card.className).not.toContain("red");
    expect(card.className).not.toContain("yellow");
  });

  test("reports unmeasured deadlocks as unavailable instead of a healthy zero", () => {
    const { queryByText } = render(<PerformanceTab data={makeData({ deadlocks: undefined })} loading={false} />);

    expect(queryByText("Deadlocks")).not.toBeNull();
    const card = queryByText("Deadlocks")!.closest('[data-slot="card"]')!;
    expect(card.textContent).toContain("N/A");
    expect(card.textContent).toContain("Not measured");
    // An engine that takes no locks has not detected zero deadlocks - it counted none.
    expect(card.textContent).not.toContain("None detected");
    expect(card.textContent).not.toContain("Healthy");
    expect(card.textContent).not.toContain("Attention");
    // A green icon is a verdict too.
    expect(card.querySelector("svg")?.getAttribute("class")).toContain("text-muted-foreground");
    expect(card.className).not.toContain("red");
    expect(card.className).not.toContain("yellow");
  });

  // The pin that keeps absence and zero from being collapsed back together: mongodb.ts:856,
  // mysql.ts:855 and sqlite.ts:729 report a real measured 0, and that measurement must keep
  // exactly the rendering it has today.
  test("keeps a measured zero rendering as a measured zero", () => {
    const { queryByText } = render(
      <PerformanceTab data={makeData({ bufferPoolUsage: 0, deadlocks: 0 })} loading={false} />,
    );

    const buffer = queryByText("Buffer")!.closest('[data-slot="card"]')!;
    expect(buffer.textContent).toContain("0");
    expect(buffer.textContent).toContain("%");
    expect(buffer.textContent).toContain("Poor");
    expect(buffer.querySelectorAll('[data-slot="progress"]').length).toBe(1);
    expect(buffer.textContent).not.toContain("Not measured");

    const deadlocks = queryByText("Deadlocks")!.closest('[data-slot="card"]')!;
    expect(deadlocks.textContent).toContain("0");
    expect(deadlocks.textContent).toContain("None detected");
    expect(deadlocks.textContent).toContain("Healthy");
    expect(deadlocks.textContent).not.toContain("N/A");
    expect(deadlocks.querySelector("svg")?.getAttribute("class")).toContain("text-green-500");
  });

  test("renders the buffer and deadlock trends as not measured when no sample carries them", () => {
    const history = [
      {
        timestamp: new Date("2026-02-15T12:00:00Z"),
        data: makeData({ bufferPoolUsage: undefined, deadlocks: undefined }),
      },
      {
        timestamp: new Date("2026-02-15T12:01:00Z"),
        data: makeData({ bufferPoolUsage: undefined, deadlocks: undefined }),
      },
    ] as unknown as TimeSeriesPoint<MonitoringData>[];

    const { queryByText, queryAllByText, queryAllByTestId } = render(
      <PerformanceTab
        data={makeData({ bufferPoolUsage: undefined, deadlocks: undefined })}
        loading={false}
        history={history}
      />,
    );

    expect(queryByText("Buffer Pool Trend")).not.toBeNull();
    expect(queryByText("Deadlock Trend")).not.toBeNull();
    // Only the cache trend, which every sample does carry, is still drawn.
    expect(queryAllByTestId("metric-chart").length).toBe(1);
    // Two cards and two trends decline to show a number.
    expect(queryAllByText("Not measured")).toHaveLength(4);
  });

  test("still plots the buffer and deadlock trends from the samples that do carry them", () => {
    const history = [
      {
        timestamp: new Date("2026-02-15T12:00:00Z"),
        data: makeData({ bufferPoolUsage: undefined, deadlocks: undefined }),
      },
      { timestamp: new Date("2026-02-15T12:01:00Z"), data: makeData({ bufferPoolUsage: 72, deadlocks: 1 }) },
    ] as unknown as TimeSeriesPoint<MonitoringData>[];

    const { queryAllByTestId } = render(<PerformanceTab data={makeData()} loading={false} history={history} />);

    expect(queryAllByTestId("metric-chart").length).toBe(3);
  });
});

// A refused performance read replaces this panel only (2026-08-24).
describe("a refused performance read", () => {
  // Scoped here as well as in the block above: bun:test registers a hook on the
  // enclosing describe only, so without this the first render in this block leaks into
  // the second and the control arm queries the previous test's DOM.
  afterEach(() => {
    cleanup();
  });

  const REFUSAL = "Unknown table 'information_schema.GLOBAL_STATUS'.";

  test("shows the engine's own sentence in place of the cards", () => {
    const rest: MonitoringData = makeData();
    delete rest.performance;
    const data = { ...rest, errors: { performance: REFUSAL } } as MonitoringData;
    const { getByTestId } = render(<PerformanceTab data={data} loading={false} />);

    expect(getByTestId("panel-unavailable-message").textContent).toBe(REFUSAL);
  });

  test("a performance panel that answered renders no failure panel", () => {
    const { queryByTestId } = render(<PerformanceTab data={makeData()} loading={false} />);

    expect(queryByTestId("panel-unavailable")).toBeNull();
  });
});
