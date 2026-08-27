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

describe("tables that carry no per-table bytes", () => {
  // Scoped here as well as in the blocks above: bun:test registers a hook on the
  // enclosing describe only, so without this the first render in this block leaks into
  // the second and the control arm queries the previous test's DOM.
  afterEach(() => {
    cleanup();
  });

  /** Rows shaped the way LibreDB and bun:sqlite answer: real counts, no sizes. */
  function sizelessData(): MonitoringData {
    const data = makeData();
    return {
      ...data,
      tables: [
        { schemaName: "kv", tableName: "employees:*", rowCount: 25, totalSize: "N/A", totalSizeBytes: 0 },
        { schemaName: "document", tableName: "articles:*", rowCount: 7, totalSize: "N/A", totalSizeBytes: 0 },
      ],
    } as unknown as MonitoringData;
  }

  test("the Size card says N/A rather than summing the placeholder to 0 B", () => {
    const { getByTestId } = render(
      <TablesTab data={sizelessData()} loading={false} onRunMaintenance={mock(async () => true)} />,
    );

    // The rows are a measurement (25 keys really are 25 rows) so the Tables card counts
    // them, while `totalSizeBytes` is the placeholder a required field has to carry -
    // summing it drew "0 B" as the total size of a database with bytes on disk.
    expect(getByTestId("tables-stat-count").textContent).toBe("2");
    expect(getByTestId("tables-stat-size").textContent).toBe("N/A");
  });

  test("a table with no size of its own reads as unknown, not as an empty cell", () => {
    const { getAllByTestId } = render(
      <TablesTab data={sizelessData()} loading={false} onRunMaintenance={mock(async () => true)} />,
    );

    expect(getAllByTestId("table-row-size")[0]?.textContent).toBe("-");
  });

  test("an engine that publishes bytes still gets its total", () => {
    const { getByTestId } = render(
      <TablesTab data={makeData()} loading={false} onRunMaintenance={mock(async () => true)} />,
    );

    expect(getByTestId("tables-stat-size").textContent).toBe("820 MB");
  });

  // The Size card is this tab's only formatted figure, so it is where the formatter's own
  // refusals are visible. The cascade this tab used to carry drew all three of these as
  // figures: "-1 B", "NaN B" and, for an exabyte, "1073741824.00 GB" - a magnitude spelled
  // in the wrong unit because the ladder stopped at GB.
  test.each<[string, number, string]>([
    ["a negative total", -1, "N/A"],
    ["a non-finite total", Number.NaN, "N/A"],
    ["an infinite total", Number.POSITIVE_INFINITY, "N/A"],
    ["a PB-scale total", 1024 ** 5, "1 PB"],
    ["an EB-scale total", 1024 ** 6, "1 EB"],
  ])("the Size card refuses %s rather than drawing it as a reading", (_label, bytes, expected) => {
    // One table carrying the whole total, so the card's sum IS the input under test. A
    // negative and a NaN are not reachable from a provider in this tree today; the point of
    // the shared formatter is that they cannot be drawn as measurements if one ever sends one,
    // and the PB and EB arms are reachable now (ClickHouse sums bytes over every active part).
    const data = makeData();
    const [first] = data.tables ?? [];
    const single = {
      ...data,
      tables: [{ ...first, tableSizeBytes: bytes, totalSizeBytes: bytes }],
    } as MonitoringData;

    const { getByTestId, queryByText } = render(
      <TablesTab data={single} loading={false} onRunMaintenance={mock(async () => true)} />,
    );

    expect(getByTestId("tables-stat-size").textContent).toBe(expected);
    // And the "N/A" arms come from the FORMATTER, not from the card's own absence gate:
    // `tableSizeBytes` is present on the row, so `sizeAbsent` is false and the "Total"
    // caption below the figure is still drawn. Without this the two refusal arms would pass
    // against a card that had simply given up.
    expect(queryByText("Total")).not.toBeNull();
  });
});

describe("per-row controls follow the provider's own declaration", () => {
  // Scoped here as well as in the blocks above: bun:test registers a hook on the
  // enclosing describe only, so without this the first render in this block leaks into
  // the second and the control arm queries the previous test's DOM.
  afterEach(() => {
    cleanup();
  });

  const titlesFrom = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("button"))
      .map((b) => b.getAttribute("title"))
      .filter((t): t is string => t !== null);

  test("MySQL gets its own three verbs and no vacuum control at all", () => {
    // MySQL has no VACUUM: the generic list offered "Analyze" alone and named nothing
    // it could run for the OPTIMIZE and CHECK it does have (#496).
    const { container } = render(
      <TablesTab
        data={makeData()}
        loading={false}
        onRunMaintenance={mock(async () => true)}
        capabilities={makeCapabilities({
          maintenanceOperations: ["analyze", "optimize", "check", "kill"],
          maintenanceOperationSpecs: {
            analyze: { label: "Analyze Table", perEntity: true, global: true },
            optimize: { label: "Optimize Table", perEntity: true, global: true },
            check: { label: "Check Table", perEntity: true, global: true },
            kill: { label: "Kill Connection", perEntity: false, global: false },
          },
        })}
      />,
    );

    const titles = titlesFrom(container);
    expect(titles).toContain("Analyze Table");
    expect(titles).toContain("Optimize Table");
    expect(titles).toContain("Check Table");
    expect(titles).not.toContain("Vacuum");
    expect(titles).not.toContain("Vacuum Table");
    // A connection id comes from the Sessions panel, so no table row may offer it.
    expect(titles).not.toContain("Kill Connection");
  });

  test("an operation that ignores the target it is handed gets no per-row control", () => {
    // SQLite's VACUUM rewrites the whole database file and `runMaintenance` drops the
    // target, so this button named one table and acted on all of them.
    const { container } = render(
      <TablesTab
        data={makeData()}
        loading={false}
        onRunMaintenance={mock(async () => true)}
        capabilities={makeCapabilities({
          maintenanceOperations: ["vacuum", "analyze", "reindex", "check"],
          maintenanceOperationSpecs: {
            vacuum: { label: "Vacuum Database", perEntity: false, global: true },
            analyze: { label: "Analyze Table", perEntity: true, global: true },
            reindex: { label: "Reindex Table", perEntity: true, global: true },
            check: { label: "Integrity Check", perEntity: false, global: true },
          },
        })}
      />,
    );

    const titles = titlesFrom(container);
    expect(titles).toContain("Analyze Table");
    expect(titles).toContain("Reindex Table");
    expect(titles).not.toContain("Vacuum Database");
    expect(titles).not.toContain("Integrity Check");
  });

  test("the button sends the operation its label was declared for", async () => {
    const onRunMaintenance = mock(async () => true);
    const { container } = render(
      <TablesTab
        data={makeData()}
        loading={false}
        onRunMaintenance={onRunMaintenance}
        capabilities={makeCapabilities({
          maintenanceOperations: ["analyze", "optimize"],
          maintenanceOperationSpecs: {
            analyze: { label: "Gather Statistics", perEntity: true, global: true },
            optimize: { label: "Rebuild Indexes", perEntity: true, global: true },
          },
        })}
      />,
    );

    fireEvent.click(container.querySelector('button[title="Rebuild Indexes"]')!);

    // Oracle's "Rebuild Indexes" is `optimize`, and the target is the TABLE - the
    // shape that answered ORA-01418 for a table name before this change.
    await waitFor(() => expect(onRunMaintenance).toHaveBeenCalledWith("optimize", "users"));
  });

  test("a provider that declares no specs keeps the pre-#U9 three controls", () => {
    // `maintenanceOperationSpecs` is optional on the published interface: an
    // implementation that declares nothing must behave exactly as it did.
    const { container } = render(
      <TablesTab
        data={makeData()}
        loading={false}
        onRunMaintenance={mock(async () => true)}
        capabilities={makeCapabilities({ maintenanceOperations: ["vacuum", "analyze", "reindex", "optimize"] })}
      />,
    );

    const titles = titlesFrom(container);
    expect(titles).toContain("Analyze");
    expect(titles).toContain("Vacuum");
    expect(titles).toContain("Reindex");
    expect(titles).toContain("Optimize");
  });
});

// U22: the two per-table maintenance items in the schema explorer are DEEP LINKS - they
// navigate to a maintenance surface and nothing more. They are gated on what the OPERATION
// declares (`maintenanceControl(..., "perEntity")`), which is a different question from
// whether the destination has a ROW to hang the control on: this panel renders per-table
// buttons for rows in `data.tables` only, and both of its absence paths render none. So an
// operator who arrives from "Optimize Table" on an engine that publishes no table
// statistics reads an empty list and is told nothing about the operation they asked for.
describe("a per-table operation with no row to run it on (U22)", () => {
  // Scoped here as well as in the blocks above: bun:test registers a hook on the
  // enclosing describe only, so without this the first render in this block leaks into
  // the second and the control arm queries the previous test's DOM.
  afterEach(() => {
    cleanup();
  });

  /** MySQL's declaration: three per-table operations under the engine's own wording. */
  const perTableCapabilities = () =>
    makeCapabilities({
      maintenanceOperations: ["analyze", "optimize", "check", "kill"],
      maintenanceOperationSpecs: {
        analyze: { label: "Analyze Table", perEntity: true, global: true },
        optimize: { label: "Optimize Table", perEntity: true, global: true },
        check: { label: "Check Table", perEntity: true, global: true },
        kill: { label: "Kill Connection", perEntity: false, global: false },
      },
    });

  /** Statistics refused: tables absent from the payload, the engine's sentence under `errors`. */
  function refusedData(): MonitoringData {
    const rest: MonitoringData = makeData();
    delete rest.tables;
    return { ...rest, errors: { tables: "no table statistics for this catalog" } } as MonitoringData;
  }

  /** Statistics not published: an empty list while the overview counts six tables. */
  function statslessData(): MonitoringData {
    const base = makeData();
    return { ...base, overview: { ...base.overview, tableCount: 6 }, tables: [] } as MonitoringData;
  }

  // Rendered exactly as `MonitoringDashboard` renders it (src/.../MonitoringDashboard.tsx:305):
  // no `isAdmin` prop at all, so this arm pins the default-prop path every real caller
  // takes. /monitoring is also the route a non-admin is sent to, which is why the note
  // below names no page they cannot open.
  test("names the per-table operations it cannot start when no statistics were published", () => {
    const { getByTestId, queryByText } = render(
      <TablesTab
        data={statslessData()}
        loading={false}
        onRunMaintenance={mock(async () => true)}
        capabilities={perTableCapabilities()}
      />,
    );

    const note = getByTestId("tables-maintenance-unattachable").textContent ?? "";
    // The engine's own wording, the same strings the per-row buttons would carry.
    expect(note).toContain("Analyze Table");
    expect(note).toContain("Optimize Table");
    expect(note).toContain("Check Table");
    // A connection id comes from the Sessions panel, so it was never on offer here.
    expect(note).not.toContain("Kill Connection");
    // The existing absence sentence is still what explains the empty list.
    expect(queryByText("No table statistics available.")).not.toBeNull();
    // This branch DID get an answer - an empty list - so it may name the cause.
    expect(note).toContain("published no table statistics");
    // A non-admin is sent to /monitoring and denied /admin/* by src/proxy.ts, and this
    // component cannot tell the two apart (the prop defaults to true), so the note must
    // not send anyone to the admin Operations page.
    expect(note).not.toContain("Operations page");
  });

  test("words a refused read as a read, and leaves the cause to the engine", () => {
    const { getByTestId } = render(
      <TablesTab
        data={refusedData()}
        loading={false}
        onRunMaintenance={mock(async () => true)}
        capabilities={perTableCapabilities()}
      />,
    );

    // The engine's own refusal still carries the panel; the note adds what the refusal
    // costs the operator who came here to run one operation.
    expect(getByTestId("panel-unavailable-message").textContent).toBe("no table statistics for this catalog");
    const note = getByTestId("tables-maintenance-unattachable").textContent ?? "";
    expect(note).toContain("Optimize Table");
    // A refusal is not an absence of statistics: the engine's reason is already on the
    // panel above (it may be a permission or catalog failure), so this sentence states
    // only what it measured - that nothing could be read - and leaves the cause there.
    expect(note).toContain("no table statistics could be read");
    expect(note).not.toContain("published no table statistics");
    expect(note).not.toContain("Operations page");
  });

  test("stays silent on a database that genuinely holds no tables", () => {
    const base = makeData();
    const { queryByTestId, queryByText } = render(
      <TablesTab
        data={{ ...base, overview: { ...base.overview, tableCount: 0 }, tables: [] } as MonitoringData}
        loading={false}
        onRunMaintenance={mock(async () => true)}
        capabilities={perTableCapabilities()}
      />,
    );

    // Nothing to maintain is not a dead end, so the note would only be noise.
    expect(queryByText("No tables found.")).not.toBeNull();
    expect(queryByTestId("tables-maintenance-unattachable")).toBeNull();
  });

  test("stays silent while rows are there to carry the controls", () => {
    const { queryByTestId } = render(
      <TablesTab
        data={makeData()}
        loading={false}
        onRunMaintenance={mock(async () => true)}
        capabilities={perTableCapabilities()}
      />,
    );

    expect(queryByTestId("tables-maintenance-unattachable")).toBeNull();
  });

  test("stays silent where the engine declares no per-table maintenance", () => {
    const { queryByTestId } = render(
      <TablesTab
        data={statslessData()}
        loading={false}
        onRunMaintenance={mock(async () => true)}
        capabilities={makeCapabilities({
          maintenanceOperations: ["vacuum"],
          maintenanceOperationSpecs: { vacuum: { label: "Vacuum Database", perEntity: false, global: true } },
        })}
      />,
    );

    // Nothing was ever offered per table, so there is no per-table dead end to explain.
    expect(queryByTestId("tables-maintenance-unattachable")).toBeNull();
  });

  // `isAdmin={false}` is a configuration no caller in src/ produces today - the only
  // caller passes nothing and the prop defaults to true - so this arm pins the GATE
  // rather than a live path. The live path is the first test in this block.
  test("stays silent when a caller does declare a non-admin", () => {
    const { queryByTestId } = render(
      <TablesTab
        data={statslessData()}
        loading={false}
        onRunMaintenance={mock(async () => true)}
        isAdmin={false}
        capabilities={perTableCapabilities()}
      />,
    );

    expect(queryByTestId("tables-maintenance-unattachable")).toBeNull();
  });
});
