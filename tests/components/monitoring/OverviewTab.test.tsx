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

  // `DatabaseOverview.activeConnections` is optional: ScyllaDB has no
  // `system_views` keyspace to read it from, and a Cassandra role denied that grant
  // has nothing to report either. The fixture DELETES the key rather than setting it
  // to `undefined` in place, so a rendering check that only tested "unknown" would
  // still fail here if it read the key some other way.
  test("reports unmeasured active connections as not published instead of a fabricated 0", () => {
    const base = makeData();
    const overview = { ...base.overview } as Record<string, unknown>;
    delete overview.activeConnections;
    const data = { ...base, overview } as unknown as MonitoringData;

    const { queryByText } = render(<OverviewTab data={data} loading={false} />);
    const card = queryByText("Connections")!.closest('[data-slot="card"]')!;

    expect(card.textContent).toContain("N/A");
    expect(card.textContent).toContain("not published");
    // No fabricated measurement: no denominator, no bar, no usage percentage.
    expect(card.textContent).not.toContain("/100");
    expect(card.textContent).not.toContain("% used");
    expect(card.querySelectorAll('[data-slot="progress"]').length).toBe(0);
    // Absence is not a fault: nothing red or yellow on the card.
    expect(card.className).not.toContain("red");
    expect(card.className).not.toContain("yellow");
  });

  // The other half of the same distinction, pinned so the two inputs cannot be
  // collapsed again: an engine that measured zero open connections keeps today's
  // rendering, denominator and usage share included.
  test("keeps a measured zero active connection count rendering as a real zero", () => {
    const base = makeData();
    const data = { ...base, overview: { ...base.overview, activeConnections: 0 } } as MonitoringData;

    const { queryByText } = render(<OverviewTab data={data} loading={false} />);
    const card = queryByText("Connections")!.closest('[data-slot="card"]')!;

    expect(card.textContent).toContain("0/100");
    expect(card.textContent).toContain("0% used");
    expect(card.textContent).not.toContain("not published");
  });

  // Same rule as the cache/buffer/deadlock trends in PerformanceTab: a missing
  // reading is dropped from the series rather than plotted as a floor of zero.
  test("drops a history sample with no published connection count from the trend", () => {
    const base = makeData();
    const overview = { ...base.overview } as Record<string, unknown>;
    delete overview.activeConnections;
    const history = [
      { timestamp: new Date("2026-02-15T12:00:00Z"), data: { ...base, overview } },
      { timestamp: new Date("2026-02-15T12:01:00Z"), data: { ...base, overview } },
    ] as unknown as TimeSeriesPoint<MonitoringData>[];

    const { queryByText } = render(<OverviewTab data={base} loading={false} history={history} />);

    // Both samples were dropped, so there is nothing to chart.
    expect(queryByText("Connection Trend")).toBeNull();
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
  // Trino publishes no `bufferPoolUsage` because it holds no buffer pool ("it holds no
  // pages", trino/introspect.ts), Cassandra and SQLite omit it too. Rendering that
  // absence as "0%" with an empty bar claimed a measurement none of them made.
  test("reports an unmeasured buffer pool as unavailable instead of 0%", () => {
    const base = makeData();
    const data = {
      ...base,
      performance: { ...base.performance, bufferPoolUsage: undefined },
    } as MonitoringData;
    const { queryByText } = render(<OverviewTab data={data} loading={false} />);
    const card = queryByText("Performance")!.closest('[data-slot="card"]')!;

    expect(card.textContent).toContain("N/A");
    expect(card.textContent).toContain("Not measured");
    // No fabricated reading: no percentage and no bar for a pool that does not exist.
    expect(card.textContent).not.toContain("0%");
    expect(card.querySelectorAll('[data-slot="progress"]').length).toBe(0);
  });

  // The other half of the same distinction, pinned so the two inputs cannot be
  // collapsed again: an engine that measured its pool at 0 keeps today's rendering.
  test("keeps a measured zero buffer pool rendering as 0% with its bar", () => {
    const base = makeData();
    const data = { ...base, performance: { ...base.performance, bufferPoolUsage: 0 } } as MonitoringData;
    const { queryByText } = render(<OverviewTab data={data} loading={false} />);
    const card = queryByText("Performance")!.closest('[data-slot="card"]')!;

    expect(card.textContent).toContain("0%");
    expect(card.textContent).not.toContain("Not measured");
    expect(card.querySelectorAll('[data-slot="progress"]').length).toBe(1);
  });

  // An engine that takes no locks has no deadlocks to count - Trino says so in as
  // many words. The badge 0 in the healthy `secondary` variant read as a clean bill
  // of health for a counter nobody kept.
  test("reports unmeasured deadlocks as unavailable instead of a healthy zero", () => {
    const base = makeData();
    const data = { ...base, performance: { ...base.performance, deadlocks: undefined } } as MonitoringData;
    const { queryByText } = render(<OverviewTab data={data} loading={false} />);
    const row = queryByText("Deadlocks")!.parentElement!;

    expect(row.textContent).toContain("N/A");
    expect(row.textContent).not.toContain("0");
    // Absence is not health: the badge must not wear the healthy fill.
    expect(row.querySelector('[data-slot="badge"]')!.className).not.toContain("bg-secondary");
  });

  test("keeps a measured zero deadlock count rendering as a healthy 0", () => {
    const base = makeData();
    const data = { ...base, performance: { ...base.performance, deadlocks: 0 } } as MonitoringData;
    const { queryByText } = render(<OverviewTab data={data} loading={false} />);
    const row = queryByText("Deadlocks")!.parentElement!;

    const badge = row.querySelector('[data-slot="badge"]')!;
    expect(badge.textContent).toBe("0");
    expect(badge.className).toContain("bg-secondary");
  });
});

// A refused overview read replaces this panel only; the other tabs still render (2026-08-24).
describe("a refused overview read", () => {
  // Scoped here as well as in the block above: bun:test registers a hook on the
  // enclosing describe only, so without this the first render in this block leaks into
  // the second and the control arm queries the previous test's DOM.
  afterEach(() => {
    cleanup();
  });

  const REFUSAL = "SELECT command denied to user 'reader' for table 'global_status'";

  test("shows the engine's own sentence in place of the cards", () => {
    const rest: MonitoringData = makeData();
    delete rest.overview;
    const data = { ...rest, errors: { overview: REFUSAL } } as MonitoringData;
    const { getByTestId, queryByText } = render(<OverviewTab data={data} loading={false} />);

    expect(getByTestId("panel-unavailable-message").textContent).toBe(REFUSAL);
    expect(queryByText("Connections")).toBeNull();
  });

  test("an overview that answered renders the cards, with no failure panel", () => {
    const { queryByTestId, queryByText } = render(<OverviewTab data={makeData()} loading={false} />);

    expect(queryByTestId("panel-unavailable")).toBeNull();
    expect(queryByText("Connections")).not.toBeNull();
  });
});

// Found in the browser on 2026-08-24 against StarRocks 3.3, on the build that made a
// failing read cost its own panel: the Overview tab rendered, and Quick Stats claimed
// "Active 0 / Idle 0" for an `activeSessions` read the engine had REFUSED. That is the
// fabricated zero D17 removed from the connection count, in a second place.
describe("Quick Stats never counts a refused read as zero", () => {
  afterEach(() => {
    cleanup();
  });

  const REFUSAL = "Getting analyzing error. Detail message: Unknown table 'information_schema.PROCESSLIST'.";

  test("a refused activeSessions read reads N/A rather than 0", () => {
    const rest: MonitoringData = makeData();
    delete rest.activeSessions;
    const data = { ...rest, errors: { activeSessions: REFUSAL } } as MonitoringData;
    const { getByTestId } = render(<OverviewTab data={data} loading={false} />);

    expect(getByTestId("quick-stat-active").textContent).toBe("N/A");
    expect(getByTestId("quick-stat-idle").textContent).toBe("N/A");
  });

  test("a refused slowQueries read reads N/A rather than 0", () => {
    const rest: MonitoringData = makeData();
    delete rest.slowQueries;
    const data = { ...rest, errors: { slowQueries: "SLOWLOG is disabled" } } as MonitoringData;
    const { getByTestId } = render(<OverviewTab data={data} loading={false} />);

    expect(getByTestId("quick-stat-slow-queries").textContent).toBe("N/A");
  });

  test("an answered empty list still reads 0, because zero sessions is a measurement", () => {
    const data = { ...makeData(), activeSessions: [], slowQueries: [] } as MonitoringData;
    const { getByTestId } = render(<OverviewTab data={data} loading={false} />);

    expect(getByTestId("quick-stat-active").textContent).toBe("0");
    expect(getByTestId("quick-stat-idle").textContent).toBe("0");
    expect(getByTestId("quick-stat-slow-queries").textContent).toBe("0");
  });
});
