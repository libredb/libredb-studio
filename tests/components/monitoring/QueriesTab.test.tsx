import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { QueriesTab } from "@/components/monitoring/tabs/QueriesTab";
import type { MonitoringData, ProviderLabels } from "@/lib/db/types";

mock.module("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
}));

function makeData(): MonitoringData {
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
    performance: { cacheHitRatio: 98, queriesPerSecond: 10, avgQueryTime: 40 },
    slowQueries: [
      { queryId: "q1", query: "SELECT * FROM users", calls: 10, totalTime: 1200, avgTime: 120, rows: 300 },
      { queryId: "q2", query: "SELECT * FROM events", calls: 200, totalTime: 900, avgTime: 4.5, rows: 100000 },
      { queryId: "q3", query: "VACUUM users", calls: 2, totalTime: 3000, avgTime: 1500, rows: 0 },
    ],
    activeSessions: [],
  } as unknown as MonitoringData;
}

/**
 * A list saturated at the ceiling every provider applies: `slowQueryLimit` defaults to 10
 * in src/lib/db/base-provider.ts and the dashboard overrides nothing, so this is the shape
 * the panel receives from any server with ten or more recorded statements. Every figure is
 * uniform so that a sum (70 calls) and the list length (10) are both distinctive strings no
 * honest reading of these rows can produce.
 */
function atCap(): MonitoringData {
  return {
    ...makeData(),
    slowQueries: Array.from({ length: 10 }, (_, i) => ({
      queryId: `cap${i}`,
      query: `SELECT ${i} FROM t`,
      calls: 7,
      totalTime: 1750,
      avgTime: 250,
      rows: 5,
    })),
  } as unknown as MonitoringData;
}

/**
 * The stat-card grid of whichever state is rendered, loading or loaded: both lay their cards
 * out as the first child of the panel's root, so one accessor counts either. What the two
 * states must agree on is that count.
 */
function statGrid(container: HTMLElement): Element {
  return container.firstElementChild?.firstElementChild as Element;
}

function statCardCount(container: HTMLElement): number {
  return statGrid(container).querySelectorAll('[data-slot="card"]').length;
}

describe("QueriesTab", () => {
  afterEach(() => {
    cleanup();
  });

  test("the loading skeleton shows one placeholder card per stat card the loaded state renders", () => {
    // The predecessor of this test asserted that the skeleton does NOT render the string
    // "Slowest Queries" - a string the skeleton never rendered in any shape, so it would
    // have passed over an empty fragment, and it did pass when this round dropped a stat
    // card and left the skeleton's own `[...Array(3)]` behind. So count instead: the
    // skeleton owes the reader one placeholder per card the loaded state is about to show,
    // and both grids now read STAT_CARDS in QueriesTab.tsx, which is what keeps them equal.
    const loadingView = render(<QueriesTab data={null} loading />);
    const skeletonCards = statCardCount(loadingView.container);
    const skeletonGridClass = statGrid(loadingView.container).className;
    // Non-vacuity: placeholders actually rendered, so an empty skeleton cannot satisfy the
    // equality below by matching zero against zero.
    expect(loadingView.container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(skeletonCards).toBeGreaterThan(0);
    cleanup();

    const loadedView = render(<QueriesTab data={makeData()} loading={false} />);

    expect(statCardCount(loadedView.container)).toBe(2);
    expect(skeletonCards).toBe(statCardCount(loadedView.container));
    expect(skeletonGridClass).toBe(statGrid(loadedView.container).className);
  });

  test("shows empty state when no slow queries exist", () => {
    const { queryByText } = render(
      <QueriesTab data={{ ...makeData(), slowQueries: [] } as MonitoringData} loading={false} />,
    );
    expect(queryByText("No query statistics available.")).not.toBeNull();
    expect(queryByText("pg_stat_statements required")).not.toBeNull();
  });

  test("keeps the pg_stat_statements advice when the provider declares no wording of its own", () => {
    // The component default IS Postgres's sentence, so `postgres` - which declares no
    // label - renders exactly what it rendered before #U12. Labels can also be absent
    // because /api/db/provider-meta is still in flight or failed, and the extension
    // advice is the right guess for the engine the tab was written against.
    const { queryByText } = render(
      <QueriesTab data={{ ...makeData(), slowQueries: [] } as MonitoringData} loading={false} labels={undefined} />,
    );
    expect(queryByText("Enable pg_stat_statements extension to see query stats.")).not.toBeNull();
    expect(queryByText("pg_stat_statements required")).not.toBeNull();
  });

  test("an engine that declares its own empty-state wording gets that instead of Postgres's", () => {
    // The #427 defect in another panel: the copy was written for one engine and shown to
    // all fourteen. Measured 2026-08-19 in Chrome on an OpenSearch connection, this tab
    // told a search cluster to install a PostgreSQL extension. The wording is the
    // provider's, read off `ProviderLabels` exactly as the Operations tab reads the
    // analyze/vacuum triads.
    const labels = {
      slowQueriesEmptyState: "The slow log is a node log file that no API returns, so SQL cannot reach it.",
    } as ProviderLabels;

    const { queryByText } = render(
      <QueriesTab data={{ ...makeData(), slowQueries: [] } as MonitoringData} loading={false} labels={labels} />,
    );

    expect(queryByText("The slow log is a node log file that no API returns, so SQL cannot reach it.")).not.toBeNull();
    expect(queryByText("Enable pg_stat_statements extension to see query stats.")).toBeNull();
    // The badge names a PostgreSQL extension rather than a category, so it cannot be
    // re-worded from one label without a second one. It is dropped where the engine has
    // its own answer, and the sentence below carries that answer.
    expect(queryByText("pg_stat_statements required")).toBeNull();
  });

  test("the provider's wording is irrelevant once statistics exist", () => {
    // The label answers "why is this empty", so it must not leak into a populated panel.
    const labels = { slowQueriesEmptyState: "Cassandra keeps no aggregate of finished statements." } as ProviderLabels;
    const { queryByText } = render(<QueriesTab data={makeData()} loading={false} labels={labels} />);
    expect(queryByText("Cassandra keeps no aggregate of finished statements.")).toBeNull();
  });

  test("renders stats cards and slow query rows", () => {
    const { queryByText, queryAllByText } = render(<QueriesTab data={makeData()} loading={false} />);

    expect(queryByText("Slowest Queries")).not.toBeNull();
    expect(queryAllByText("SELECT * FROM users").length).toBeGreaterThan(0);
    expect(queryAllByText("SELECT * FROM events").length).toBeGreaterThan(0);
    expect(queryAllByText("VACUUM users").length).toBeGreaterThan(0);
    expect(queryByText("Listed queries over 1s")).not.toBeNull();
  });

  test("sorts by calls when Calls header is clicked", () => {
    const { container, queryByText } = render(<QueriesTab data={makeData()} loading={false} />);

    const callsSortButton = queryByText("Calls");
    expect(callsSortButton).not.toBeNull();
    fireEvent.click(callsSortButton!);

    const rows = container.querySelectorAll("tbody tr");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.textContent).toContain("SELECT * FROM events");
  });

  test("toggles sort direction when the same header is clicked twice", () => {
    const { container, queryByText } = render(<QueriesTab data={makeData()} loading={false} />);

    const callsSortButton = queryByText("Calls");
    fireEvent.click(callsSortButton!);
    fireEvent.click(callsSortButton!);

    const rows = container.querySelectorAll("tbody tr");
    expect(rows[0]?.textContent).toContain("VACUUM users");
  });

  test("formats call counts of a million or more with the M suffix", () => {
    const data = {
      ...makeData(),
      slowQueries: [
        ...makeData().slowQueries!,
        { queryId: "q4", query: "SELECT count(*) FROM logs", calls: 2500000, totalTime: 500000, avgTime: 0.2, rows: 1 },
      ],
    } as MonitoringData;
    const { queryAllByText } = render(<QueriesTab data={data} loading={false} />);
    expect(queryAllByText("2.5M").length).toBeGreaterThan(0);
  });

  test("an engine that keeps no query log gets absence, not statistics it never gathered", () => {
    // Measured 2026-08-21 in Chrome against Apache Cassandra 5.0.9: this tab read
    // "Queries 0 / Avg Time 0.00ms / Slow 0" while the list below correctly said no
    // statistics were available. Cassandra keeps no query log at all
    // (cassandra/index.ts:573-575), and neither do Druid (index.ts:486-488) or SQLite
    // (sqlite.ts:734-737) - they answer `[]` by design. An average over an empty set is
    // not 0.00ms, and "Queries 0" claims a call total against the database rather than
    // counting visible rows, so all three figures render as absence instead.
    const { queryAllByText, queryByText } = render(
      <QueriesTab data={{ ...makeData(), slowQueries: [] } as MonitoringData} loading={false} />,
    );

    expect(queryAllByText("0.00ms").length).toBe(0);
    expect(queryAllByText("0").length).toBe(0);
    expect(queryAllByText("N/A").length).toBe(2);
    expect(queryByText("No query statistics available.")).not.toBeNull();
  });

  test("a measured zero still renders as a zero, because absence is the only new input", () => {
    // The guard is on the presence of statistics, never on their value. A provider that
    // reports a query which has run zero times, or whose recorded average is 0, HAS
    // measured those figures, so the cards keep formatting them exactly as before -
    // otherwise a future reader could collapse the two inputs back together.
    const measuredZero = {
      ...makeData(),
      slowQueries: [{ queryId: "z1", query: "SELECT 1", calls: 0, totalTime: 0, avgTime: 0, rows: 0 }],
    } as MonitoringData;

    const { queryAllByText, queryByText } = render(<QueriesTab data={measuredZero} loading={false} />);

    expect(queryAllByText("N/A").length).toBe(0);
    expect(queryAllByText("0.00ms").length).toBe(3);
    expect(queryAllByText("0").length).toBe(3);
    expect(queryByText("No query statistics available.")).toBeNull();
  });

  test("no card publishes a call total, because the list it would total is a cap", () => {
    // #515. `MonitoringData.slowQueries` is capped - `slowQueryLimit = 10` in
    // src/lib/db/base-provider.ts, applied by every provider that fills the list and never
    // overridden by MonitoringDashboard - so summing `calls` over it is bounded by ten
    // digests however many the server recorded. The card labelled "Queries" published that
    // sum as the database's query count: 10 + 200 + 2 = 212 for this fixture, and on
    // MongoDB and Redis, which project `calls: 1` per row, the sum WAS the list length.
    // There is no honest label for it, so the card is gone rather than renamed.
    const { queryAllByText, queryByText } = render(<QueriesTab data={makeData()} loading={false} />);

    expect(queryAllByText("212").length).toBe(0);
    // The card's own title, not a tab or a table heading: the tab trigger lives in
    // MonitoringDashboard and is not rendered here, so a surviving "Queries" card is the
    // only thing this can match.
    expect(queryByText("Queries")).toBeNull();
  });

  test("the two remaining cards name the statements they summarise", () => {
    // Each label scopes its figure to the rows on screen, so a reader can recompute it by
    // looking: the mean of 120, 4.5 and 1500 is 541.5ms, and exactly one of the three
    // averages over a second. Neither sentence claims anything about the server.
    const { queryByText } = render(<QueriesTab data={makeData()} loading={false} />);

    expect(queryByText("Avg of listed queries")).not.toBeNull();
    expect(queryByText("541.50ms")).not.toBeNull();
    expect(queryByText("Listed queries over 1s")).not.toBeNull();
    expect(queryByText("Avg Time")).toBeNull();
    expect(queryByText("Slow")).toBeNull();
  });

  test("a list saturated at the cap prints neither the cap nor a sum over it", () => {
    // The saturating case #515 was measured on: MySQL 26.7.0 held 59 digests for one
    // connected schema, of which the panel receives ten. Every figure on screen must be a
    // property of those ten and nothing else, so neither the list length (10) nor the call
    // total (70) may appear anywhere.
    const { container, queryAllByText, queryByText } = render(<QueriesTab data={atCap()} loading={false} />);

    expect(container.querySelectorAll("tbody tr").length).toBe(10);
    expect(queryAllByText("10").length).toBe(0);
    expect(queryAllByText("70").length).toBe(0);
    // The control: the figures that ARE about these ten rows still render - the card's
    // average plus the ten per-row badges it was computed from.
    expect(queryAllByText("250.00ms").length).toBe(11);
    expect(queryByText("Avg of listed queries")).not.toBeNull();
  });
});

// A refused slowQueries read is not an empty list, so it must not be told to
// install a PostgreSQL extension.
describe("a refused slowQueries read", () => {
  // Scoped here as well as in the block above: bun:test registers a hook on the
  // enclosing describe only, so without this the first render in this block leaks into
  // the second and the control arm queries the previous test's DOM.
  afterEach(() => {
    cleanup();
  });

  const REFUSAL = "Unknown table 'information_schema.STATEMENTS_SUMMARY'.";

  function refused(): MonitoringData {
    const rest: MonitoringData = makeData();
    delete rest.slowQueries;
    return { ...rest, errors: { slowQueries: REFUSAL } };
  }

  test("shows the engine's own sentence and drops the extension advice", () => {
    const { getByTestId, queryByText } = render(<QueriesTab data={refused()} loading={false} />);

    expect(getByTestId("panel-unavailable-message").textContent).toBe(REFUSAL);
    expect(queryByText("pg_stat_statements required")).toBeNull();
    expect(queryByText("No query statistics available.")).toBeNull();
  });

  test("an empty list keeps the extension advice", () => {
    const data = { ...makeData(), slowQueries: [] };
    const { queryByTestId, queryByText } = render(<QueriesTab data={data} loading={false} />);

    expect(queryByTestId("panel-unavailable")).toBeNull();
    expect(queryByText("pg_stat_statements required")).not.toBeNull();
  });
});
