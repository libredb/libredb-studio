import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import React from "react";
import { describe, test, expect, mock, afterEach } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { TablesTab } from "@/components/monitoring/tabs/TablesTab";
import type { MonitoringData, ProviderCapabilities } from "@/lib/db/types";

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
      tableCount: 2,
      indexCount: 2,
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
    activeSessions: [],
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
        lastVacuum: new Date("2026-02-01T00:00:00Z"),
      },
      {
        schemaName: "public",
        tableName: "events",
        rowCount: 500000,
        deadRowCount: 30000,
        tableSize: "600 MB",
        tableSizeBytes: 629145600,
        indexSize: "100 MB",
        indexSizeBytes: 104857600,
        totalSize: "700 MB",
        totalSizeBytes: 734003200,
        bloatRatio: 25,
      },
    ],
  } as unknown as MonitoringData;
}

function makeCapabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    queryLanguage: "sql",
    supportsExplain: false,
    supportsExternalQueryLimiting: true,
    supportsCreateTable: true,
    supportsInlineRowEdit: true,
    supportsMaintenance: true,
    maintenanceOperations: ["vacuum", "analyze", "reindex", "kill"],
    supportsConnectionString: true,
    defaultPort: 5432,
    schemaRefreshPattern: "^(CREATE|DROP)\\b",
    ...overrides,
  };
}

describe("TablesTab", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders skeleton when loading and data is null", () => {
    const { queryByText } = render(<TablesTab data={null} loading onRunMaintenance={mock(async () => true)} />);
    expect(queryByText("Table Statistics")).toBeNull();
  });

  test("shows empty state when no tables match", () => {
    // `tableCount: 0` keeps this the genuine-empty-database case: with a non-zero
    // tableCount the same `tables: []` means the engine refused statistics, which the
    // absence tests below cover instead.
    const base = makeData();
    const { queryByText } = render(
      <TablesTab
        data={{ ...base, overview: { ...base.overview, tableCount: 0 }, tables: [] } as MonitoringData}
        loading={false}
        onRunMaintenance={mock(async () => true)}
      />,
    );
    expect(queryByText("No tables found.")).not.toBeNull();
  });

  test("updates search query input value", () => {
    const { queryByText, getByPlaceholderText } = render(
      <TablesTab data={makeData()} loading={false} onRunMaintenance={mock(async () => true)} />,
    );

    expect(queryByText("users")).not.toBeNull();
    expect(queryByText("events")).not.toBeNull();

    const input = getByPlaceholderText("Search...");
    fireEvent.change(input, { target: { value: "event" } });
    expect((input as HTMLInputElement).value).toBe("event");
  });

  test("runs maintenance actions when admin clicks action buttons", async () => {
    const onRunMaintenance = mock(async () => true);
    const { container } = render(
      <TablesTab
        data={makeData()}
        loading={false}
        onRunMaintenance={onRunMaintenance}
        isAdmin
        capabilities={makeCapabilities()}
      />,
    );

    const analyzeButton = container.querySelector('button[title="Analyze"]');
    const vacuumButton = container.querySelector('button[title="Vacuum"]');
    const reindexButton = container.querySelector('button[title="Reindex"]');

    expect(analyzeButton).not.toBeNull();
    expect(vacuumButton).not.toBeNull();
    expect(reindexButton).not.toBeNull();

    fireEvent.click(analyzeButton!);
    await waitFor(() => {
      expect(onRunMaintenance).toHaveBeenCalledWith("analyze", "users");
    });

    fireEvent.click(vacuumButton!);
    await waitFor(() => {
      expect(onRunMaintenance).toHaveBeenCalledWith("vacuum", "users");
    });

    fireEvent.click(reindexButton!);
    await waitFor(() => {
      expect(onRunMaintenance).toHaveBeenCalledWith("reindex", "users");
    });
  });

  test("shows non-admin placeholder for actions", () => {
    const { queryAllByText } = render(
      <TablesTab data={makeData()} loading={false} onRunMaintenance={mock(async () => true)} isAdmin={false} />,
    );
    expect(queryAllByText("-").length).toBeGreaterThan(0);
  });

  test("renders no maintenance control until the provider metadata has resolved", () => {
    // Undefined capabilities is also what a failed /api/db/provider-meta leaves
    // behind, so failing open here would restore the dead buttons #272 removes.
    const { container, queryByText } = render(
      <TablesTab data={makeData()} loading={false} onRunMaintenance={mock(async () => true)} isAdmin />,
    );

    expect(container.querySelector('button[title="Analyze"]')).toBeNull();
    expect(container.querySelector('button[title="Vacuum"]')).toBeNull();
    expect(container.querySelector('button[title="Reindex"]')).toBeNull();
    expect(queryByText("users")).not.toBeNull();
  });

  test("renders no maintenance control when the provider declares maintenance unsupported", () => {
    const { container, queryByText } = render(
      <TablesTab
        data={makeData()}
        loading={false}
        onRunMaintenance={mock(async () => true)}
        isAdmin
        capabilities={makeCapabilities({ supportsMaintenance: false, maintenanceOperations: [] })}
      />,
    );

    expect(container.querySelector('button[title="Analyze"]')).toBeNull();
    expect(container.querySelector('button[title="Vacuum"]')).toBeNull();
    expect(container.querySelector('button[title="Reindex"]')).toBeNull();

    // The row itself is untouched — only the controls are gated.
    expect(queryByText("users")).not.toBeNull();
    expect(queryByText("events")).not.toBeNull();
    expect(queryByText("20 MB")).not.toBeNull(); // the users row's index-size cell
  });

  test("renders only the maintenance operations the provider declares", () => {
    const { container, queryByText } = render(
      <TablesTab
        data={makeData()}
        loading={false}
        onRunMaintenance={mock(async () => true)}
        isAdmin
        capabilities={makeCapabilities({ maintenanceOperations: ["analyze", "kill"] })}
      />,
    );

    expect(container.querySelector('button[title="Analyze"]')).not.toBeNull();
    expect(container.querySelector('button[title="Vacuum"]')).toBeNull();
    expect(container.querySelector('button[title="Reindex"]')).toBeNull();
    expect(queryByText("users")).not.toBeNull();
  });

  test("renders every declared maintenance control and still runs it", async () => {
    const onRunMaintenance = mock(async () => true);
    const { container } = render(
      <TablesTab
        data={makeData()}
        loading={false}
        onRunMaintenance={onRunMaintenance}
        isAdmin
        capabilities={makeCapabilities({ maintenanceOperations: ["vacuum", "analyze", "reindex"] })}
      />,
    );

    const analyzeButton = container.querySelector('button[title="Analyze"]');
    const vacuumButton = container.querySelector('button[title="Vacuum"]');
    const reindexButton = container.querySelector('button[title="Reindex"]');

    expect(analyzeButton).not.toBeNull();
    expect(vacuumButton).not.toBeNull();
    expect(reindexButton).not.toBeNull();

    fireEvent.click(reindexButton!);
    await waitFor(() => {
      expect(onRunMaintenance).toHaveBeenCalledWith("reindex", "users");
    });
  });

  test("keeps the non-admin path unchanged whatever the provider declares", () => {
    const { container, queryAllByText } = render(
      <TablesTab
        data={makeData()}
        loading={false}
        onRunMaintenance={mock(async () => true)}
        isAdmin={false}
        capabilities={makeCapabilities({ maintenanceOperations: ["vacuum", "analyze", "reindex"] })}
      />,
    );

    expect(container.querySelector('button[title="Analyze"]')).toBeNull();
    expect(container.querySelector('button[title="Vacuum"]')).toBeNull();
    expect(container.querySelector('button[title="Reindex"]')).toBeNull();
    expect(queryAllByText("-").length).toBeGreaterThan(0);
  });
  // #448 settled the rule this panel broke one component over: absence and zero are
  // different inputs. Measured 2026-08-21 in Chrome against Apache Cassandra 5.0.9 —
  // Monitoring -> Tables read "Tables 0 / 0 rows", "Size 0 B" and a green "Vacuum 0 / OK"
  // while the Overview tab of the same session read 6 tables from `system_schema`.
  test("renders absence rather than zeros when the engine publishes no table statistics", () => {
    const base = makeData();
    const { queryByText, queryAllByText } = render(
      <TablesTab
        data={{ ...base, overview: { ...base.overview, tableCount: 6 }, tables: [] } as MonitoringData}
        loading={false}
        onRunMaintenance={mock(async () => true)}
        capabilities={makeCapabilities()}
      />,
    );

    // All three card figures decline to answer instead of reporting a measured zero.
    expect(queryAllByText("N/A").length).toBe(3);
    expect(queryByText("0 rows")).toBeNull();
    expect(queryByText("0 B")).toBeNull();
    expect(queryByText("Total")).toBeNull();
    expect(queryByText("OK")).toBeNull();
    // The engine does have vacuum here, so the card says nothing about it either way.
    expect(queryByText("Not supported")).toBeNull();
    // "No tables found." is a false claim when the overview counts six of them.
    expect(queryByText("No table statistics available.")).not.toBeNull();
    expect(queryByText("No tables found.")).toBeNull();
  });

  test("keeps the measured zero rendering exactly as it is today", () => {
    // A provider answering a real 0 has measured one. This test is the guard that stops
    // the two inputs being collapsed back together by a later simplification.
    const base = makeData();
    const { queryByText, queryAllByText } = render(
      <TablesTab
        data={{ ...base, overview: { ...base.overview, tableCount: 0 }, tables: [] } as MonitoringData}
        loading={false}
        onRunMaintenance={mock(async () => true)}
        capabilities={makeCapabilities()}
      />,
    );

    expect(queryAllByText("0").length).toBe(2); // the Tables and the Vacuum card figures
    expect(queryByText("0 rows")).not.toBeNull();
    expect(queryByText("0 B")).not.toBeNull();
    expect(queryByText("Total")).not.toBeNull();
    expect(queryByText("OK")).not.toBeNull();
    expect(queryAllByText("N/A").length).toBe(0);
    expect(queryByText("No tables found.")).not.toBeNull();
  });

  test("reports no vacuum state at all for an engine whose provider declares no maintenance", () => {
    // Apache Cassandra publishes `supportsMaintenance: false, maintenanceOperations: []`
    // and every maintenance action on it is a `nodetool` call the studio never makes, so
    // a green "OK" is a clean bill of health for an operation that does not exist.
    const { queryByText } = render(
      <TablesTab
        data={makeData()}
        loading={false}
        onRunMaintenance={mock(async () => true)}
        capabilities={makeCapabilities({ supportsMaintenance: false, maintenanceOperations: [] })}
      />,
    );

    expect(queryByText("Not supported")).not.toBeNull();
    expect(queryByText("OK")).toBeNull();
    expect(queryByText("Need")).toBeNull();
    // The statistics the engine did publish are untouched.
    expect(queryByText("users")).not.toBeNull();
    expect(queryByText("501.2K rows")).not.toBeNull(); // 1,200 + 500,000 across the two rows
  });

  test("renders no bloat badge and no vacuum history for per-row figures the engine never published", () => {
    const base = makeData();
    const data = {
      ...base,
      tables: [
        {
          schemaName: "ks",
          tableName: "sensors",
          rowCount: 12,
          tableSize: "1 MiB",
          tableSizeBytes: 1048576,
          indexSize: "",
          indexSizeBytes: 0,
          totalSize: "1 MiB",
          totalSizeBytes: 1048576,
        },
      ],
    } as unknown as MonitoringData;

    const { queryByText, container } = render(
      <TablesTab
        data={data}
        loading={false}
        onRunMaintenance={mock(async () => true)}
        capabilities={makeCapabilities({ supportsMaintenance: false, maintenanceOperations: [] })}
      />,
    );

    expect(container.querySelectorAll("tbody tr").length).toBe(1);
    expect(queryByText("sensors")).not.toBeNull();
    expect(queryByText("0.0%")).toBeNull();
    expect(queryByText("Never")).toBeNull();
  });

  test("still calls a missing vacuum history Never on an engine that has vacuum", () => {
    // PostgreSQL's NULL `last_vacuum` genuinely means never vacuumed, and the `events`
    // row carries no `lastVacuum`, so this rendering must survive the fix above.
    const { queryByText } = render(
      <TablesTab
        data={makeData()}
        loading={false}
        onRunMaintenance={mock(async () => true)}
        capabilities={makeCapabilities()}
      />,
    );

    expect(queryByText("Never")).not.toBeNull();
  });
});

// A refused getTableStats read costs the table list only (2026-08-24).
describe("a refused tables read", () => {
  // Scoped here as well as in the block above: bun:test registers a hook on the
  // enclosing describe only, so without this the first render in this block leaks into
  // the second and the control arm queries the previous test's DOM.
  afterEach(() => {
    cleanup();
  });

  const REFUSAL = "Getting analyzing error. Detail message: Unknown table 'information_schema.TABLES'.";

  test('shows the engine\'s own sentence instead of "No tables found."', () => {
    const rest: MonitoringData = makeData();
    delete rest.tables;
    const data = { ...rest, errors: { tables: REFUSAL } } as MonitoringData;
    const { getByTestId, queryByText } = render(
      <TablesTab data={data} loading={false} onRunMaintenance={mock(async () => true)} />,
    );

    expect(getByTestId("panel-unavailable-message").textContent).toBe(REFUSAL);
    expect(queryByText("No tables found.")).toBeNull();
  });

  test("an answered empty table list keeps the empty state", () => {
    const data = { ...makeData(), tables: [] } as MonitoringData;
    const { queryByTestId, queryByText } = render(
      <TablesTab data={data} loading={false} onRunMaintenance={mock(async () => true)} />,
    );

    expect(queryByTestId("panel-unavailable")).toBeNull();
    expect(queryByText("No table statistics available.")).not.toBeNull();
  });
});
