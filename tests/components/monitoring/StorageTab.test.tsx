import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import React from "react";
import { describe, test, expect, afterEach } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { StorageTab } from "@/components/monitoring/tabs/StorageTab";
import type { MonitoringData } from "@/lib/db/types";

function makeMonitoringData(): MonitoringData {
  return {
    timestamp: new Date("2026-02-15T12:00:00Z"),
    overview: {
      version: "16.3",
      uptime: "1000s",
      activeConnections: 4,
      maxConnections: 100,
      databaseSize: "2.00 GB",
      databaseSizeBytes: 2 * 1024 * 1024 * 1024,
      tableCount: 2,
      indexCount: 1,
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
    storage: [
      { name: "pg_default", location: "/var/lib/postgres", size: "1.20 GB", sizeBytes: 1288490188, usagePercent: 60 },
      {
        name: "WAL",
        location: "/var/lib/postgres/pg_wal",
        size: "300 MB",
        sizeBytes: 314572800,
        usagePercent: 15,
        walSize: "300 MB",
        walSizeBytes: 314572800,
      },
    ],
    tables: [
      {
        schemaName: "public",
        tableName: "orders",
        rowCount: 10000,
        tableSize: "500 MB",
        tableSizeBytes: 524288000,
        indexSize: "120 MB",
        indexSizeBytes: 125829120,
        totalSize: "700 MB",
        totalSizeBytes: 734003200,
      },
      {
        schemaName: "public",
        tableName: "users",
        rowCount: 2500,
        tableSize: "200 MB",
        tableSizeBytes: 209715200,
        indexSize: "80 MB",
        indexSizeBytes: 83886080,
        totalSize: "300 MB",
        totalSizeBytes: 314572800,
      },
    ],
    // Deliberately larger than the whole database: the index total is taken from the per-table
    // figures above, never from these rows. See the double-count test below.
    indexes: [
      {
        schemaName: "public",
        tableName: "orders",
        indexName: "idx_orders_created_at",
        columns: ["created_at"],
        isUnique: false,
        isPrimary: false,
        indexSize: "2.00 GB",
        indexSizeBytes: 2 * 1024 * 1024 * 1024,
        scans: 100,
      },
    ],
  } as unknown as MonitoringData;
}

// A libSQL database as measured for #515: 64 KB total, of which the two tables account for
// 48 KB of data and 12 KB of indexes, leaving a 4.00 KB remainder. libSQL and SQLite have
// neither TOAST nor a free space map - their remainder is the schema, the freelist and page
// overhead - so this fixture is the non-PostgreSQL arm of the breakdown-label test.
function makeLibsqlMonitoringData(): MonitoringData {
  const base = makeMonitoringData();
  return {
    ...base,
    overview: { ...base.overview, version: "3.45.1", databaseSize: "64.00 KB", databaseSizeBytes: 65536 },
    storage: [],
    indexes: [],
    tables: [
      {
        schemaName: "main",
        tableName: "orders",
        rowCount: 120,
        tableSize: "32.00 KB",
        tableSizeBytes: 32768,
        indexSize: "8.00 KB",
        indexSizeBytes: 8192,
        totalSize: "40.00 KB",
        totalSizeBytes: 40960,
      },
      {
        schemaName: "main",
        tableName: "users",
        rowCount: 30,
        tableSize: "16.00 KB",
        tableSizeBytes: 16384,
        indexSize: "4.00 KB",
        indexSizeBytes: 4096,
        totalSize: "20.00 KB",
        totalSizeBytes: 20480,
      },
    ],
  } as unknown as MonitoringData;
}

describe("StorageTab", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders skeleton when loading without data", () => {
    const { queryByText } = render(<StorageTab data={null} loading />);
    expect(queryByText("Storage Breakdown")).toBeNull();
  });

  test("shows empty states when storage and table lists are missing", () => {
    const emptyData = {
      ...makeMonitoringData(),
      storage: [],
      tables: [],
      indexes: [],
    } as MonitoringData;
    const { queryByText } = render(<StorageTab data={emptyData} loading={false} />);

    expect(queryByText("No tablespace information available.")).not.toBeNull();
    expect(queryByText("No table information available.")).not.toBeNull();
  });

  test("an engine that reports no database size gets absence, not a zero it never measured", () => {
    // Apache Cassandra is the case (#424): `system_views.disk_usage` publishes whole
    // mebibytes - measured "1 MiB" for a 19,476-byte table - so the provider omits
    // `databaseSizeBytes` entirely and answers `[]` for the table, index and storage
    // panels. Read as `?? 0`, that absence rendered "0 B / 0.0%" on the Tables and
    // Indexes cards and a "0 B / 0 B / 0 B" breakdown, which is a measurement the
    // engine never made.
    const overview = { ...makeMonitoringData().overview };
    delete (overview as { databaseSizeBytes?: number }).databaseSizeBytes;
    const noSize = {
      ...makeMonitoringData(),
      overview: { ...overview, databaseSize: "N/A" },
      storage: [],
      tables: [],
      indexes: [],
    } as MonitoringData;

    const { queryByText, queryAllByText } = render(<StorageTab data={noSize} loading={false} />);

    expect(queryAllByText("0 B").length).toBe(0);
    expect(queryAllByText("0.0%").length).toBe(0);
    expect(queryByText("No storage size information available.")).not.toBeNull();
  });

  test("a measured zero still renders as a zero, because absence is the only new input", () => {
    // Trino (introspect.ts:615) and Druid send a real 0 for `databaseSizeBytes`. That is
    // a measurement, so it must keep formatting as "0 B" with a 0.0% share and a drawn
    // breakdown - only the ABSENT field switches to the unavailable copy.
    const measuredZero = {
      ...makeMonitoringData(),
      overview: { ...makeMonitoringData().overview, databaseSize: "0 bytes", databaseSizeBytes: 0 },
      storage: [],
      tables: [],
      indexes: [],
    } as MonitoringData;

    const { queryByText, queryAllByText } = render(<StorageTab data={measuredZero} loading={false} />);

    expect(queryAllByText("0 B").length).toBe(5);
    expect(queryAllByText("0.0%").length).toBe(2);
    expect(queryByText("No storage size information available.")).toBeNull();
  });

  test("renders storage cards, breakdown, badges and largest tables", () => {
    const { queryByText, queryAllByText } = render(<StorageTab data={makeMonitoringData()} loading={false} />);

    expect(queryByText("Storage Breakdown")).not.toBeNull();
    expect(queryByText("Tablespaces")).not.toBeNull();
    expect(queryByText("Largest Tables")).not.toBeNull();
    expect(queryByText("2.00 GB")).not.toBeNull();
    expect(queryAllByText("300 MB").length).toBeGreaterThan(0); // WAL card
    expect(queryByText("Default")).not.toBeNull();
    expect(queryAllByText("WAL").length).toBeGreaterThan(0);

    // largest tables are sorted by total size descending
    expect(queryByText("orders")).not.toBeNull();
    expect(queryByText("users")).not.toBeNull();
  });

  test("the index total is the per-table figure, not the sum of the index rows", () => {
    // InnoDB has no separate primary-key index: the clustered index IS the table, so
    // `mysql.innodb_index_stats` reports the PRIMARY row's size as the row data. Summing every
    // index row therefore counts the table data twice - measured against MySQL 26.7.0 on a 144 KB
    // database, the sum read 147,456 B (49,152 data + 98,304 indexes), which drew "Indexes" as
    // 100% of the database and a remainder of "-49152 B". The fixture's index row is 2 GB, the
    // whole database, so a regression to summing it is visible here rather than only on a server.
    const { queryByText, queryAllByText } = render(<StorageTab data={makeMonitoringData()} loading={false} />);

    // 120 MB + 80 MB from the two tables, on a 2 GB database.
    expect(queryAllByText("200.00 MB").length).toBe(2); // Indexes card and breakdown row
    expect(queryAllByText("9.8%").length).toBe(1);
    expect(queryByText("1.12 GB")).not.toBeNull(); // the remainder, still positive
    expect(queryAllByText("2.00 GB").length).toBe(1); // the DB Size card, and nothing else
  });

  test("a partial table-size sum is not published as the Data figure", () => {
    // SQLite used to answer `tableSizeBytes = rowCount * 100` ("Assume 100 bytes
    // average per row") and this tab summed that guess into the Tables/Data figure it
    // draws beside the measured database size. With the guess gone, a provider may
    // report a table it has no byte figure for, and summing the rest as 0 publishes a
    // number no engine reported. The fixture keeps `orders` at 500 MB and strips
    // `users`, so a regression to `?? 0` renders "500.00 MB" as the table total -
    // visible here rather than only against a server.
    const base = makeMonitoringData();
    const partial = {
      ...base,
      tables: (base.tables ?? []).map((t, i) => {
        if (i === 0) return { ...t };
        const copy = { ...t };
        delete (copy as { tableSizeBytes?: number }).tableSizeBytes;
        return copy;
      }),
    } as MonitoringData;

    const { queryAllByText } = render(<StorageTab data={partial} loading={false} />);

    expect(queryAllByText("500.00 MB").length).toBe(0);
    // Tables card, the breakdown's Tables row, and the remainder that cannot be
    // computed without them - plus the % under the card is not drawn at all.
    expect(queryAllByText("N/A").length).toBe(3);
    expect(queryAllByText("24.4%").length).toBe(0); // 500 MB of 2 GB
  });

  test("an engine with no per-table bytes at all keeps its table list and drops the figures", () => {
    // The sqlite provider under bun:sqlite: `dbstat` is compiled out there ("no such
    // table: dbstat", measured 2026-08-24 on Bun 1.3.14 / SQLite 3.53.0), so it omits
    // `tableSize`/`tableSizeBytes` and says "N/A" for the total. The table names and
    // row counts are still real, so the list must stay - only the byte columns go.
    const base = makeMonitoringData();
    const noBytes = {
      ...base,
      tables: (base.tables ?? []).map((t) => {
        const copy = { ...t, totalSize: "N/A", totalSizeBytes: 0 };
        delete (copy as { tableSize?: string }).tableSize;
        delete (copy as { tableSizeBytes?: number }).tableSizeBytes;
        return copy;
      }),
    } as MonitoringData;

    const { queryByText, queryAllByText } = render(<StorageTab data={noBytes} loading={false} />);

    expect(queryByText("orders")).not.toBeNull();
    expect(queryByText("users")).not.toBeNull();
    // No "0.0%" share is drawn for either table, and no "0 B" total.
    expect(queryAllByText("0.0%").length).toBe(0);
    expect(queryAllByText("0 B").length).toBe(0);
    expect(queryAllByText("-").length).toBe(2); // the two % cells
  });

  test("the breakdown remainder is labelled without naming any engine's storage layout", () => {
    // The remainder row is arithmetic: the database bytes the per-table data and index
    // figures do not account for. It was labelled "Other (TOAST, FSM)" unconditionally, and
    // TOAST and the free space map are PostgreSQL structures - so the wide label named one
    // engine's storage layout on all fifteen. Both breakpoint labels are asserted by value,
    // which is what keeps the "no PostgreSQL words" check below non-vacuous: a later rename
    // cannot satisfy it by moving the wording somewhere this test does not look.
    const { container, getByTestId } = render(<StorageTab data={makeMonitoringData()} loading={false} />);

    expect(getByTestId("storage-breakdown-other-label").textContent).toBe("Other (unattributed)");
    expect(getByTestId("storage-breakdown-other-label-compact").textContent).toBe("Other");
    expect(container.textContent).not.toMatch(/TOAST|FSM|free space map/i);
    // The PostgreSQL fixture's own remainder still renders: 2 GB less 700 MB of data and
    // 200 MB of indexes.
    expect(container.textContent).toContain("1.12 GB");
  });

  test("a libSQL database gets the same remainder label as PostgreSQL, not another engine's", () => {
    // Measured for #515: a real 64 KB libSQL database read "4.00 KB" under "Other (TOAST,
    // FSM)". The number is right and the words belong to PostgreSQL - libSQL has neither
    // structure. The label must be identical on both engines because this tab is given no
    // provider labels to vary it by.
    const { container, getByTestId, queryAllByText } = render(
      <StorageTab data={makeLibsqlMonitoringData()} loading={false} />,
    );

    expect(getByTestId("storage-breakdown-other-label").textContent).toBe("Other (unattributed)");
    expect(getByTestId("storage-breakdown-other-label-compact").textContent).toBe("Other");
    expect(container.textContent).not.toMatch(/TOAST|FSM|free space map/i);
    // 65536 bytes less 49152 of data and 12288 of indexes; no other figure in this fixture
    // formats to 4.00 KB, so the remainder is pinned as well as its label.
    expect(queryAllByText("4.00 KB").length).toBe(1);
  });

  test("a table reported without an index size does not turn the totals into a measurement", () => {
    // MySQL keeps per-index bytes in `mysql.innodb_index_stats`: a user granted only its own
    // database is denied that table, and a MyISAM table has no row there (both measured
    // 2026-08-23), so `indexSizeBytes` is absent. Summing it as 0 published an index total the
    // server never reported, and left the remainder ("Other") inflated by the unknown share.
    const base = makeMonitoringData();
    const unknownIndexSize = {
      ...base,
      tables: (base.tables ?? []).map((t) => {
        const copy = { ...t };
        delete (copy as { indexSizeBytes?: number }).indexSizeBytes;
        return copy;
      }),
    } as MonitoringData;

    const { queryAllByText } = render(<StorageTab data={unknownIndexSize} loading={false} />);

    // Indexes card, breakdown row and the now-uncomputable remainder.
    expect(queryAllByText("N/A").length).toBe(3);
    expect(queryAllByText("200.00 MB").length).toBe(0);
  });
});

// A refused getStorageStats read costs the tablespace list only (2026-08-24).
describe("a refused storage read", () => {
  // Scoped here as well as in the block above: bun:test registers a hook on the
  // enclosing describe only, so without this the first render in this block leaks into
  // the second and the control arm queries the previous test's DOM.
  afterEach(() => {
    cleanup();
  });

  const REFUSAL = "permission denied for function pg_tablespace_size";

  test("shows the engine's own sentence instead of the tablespace empty state", () => {
    const rest: MonitoringData = makeMonitoringData();
    delete rest.storage;
    const data = { ...rest, errors: { storage: REFUSAL } } as MonitoringData;
    const { getByTestId, queryByText } = render(<StorageTab data={data} loading={false} />);

    expect(getByTestId("panel-unavailable-message").textContent).toBe(REFUSAL);
    expect(queryByText("No tablespace information available.")).toBeNull();
  });

  test("an answered empty tablespace list keeps the empty state", () => {
    const data = { ...makeMonitoringData(), storage: [] } as MonitoringData;
    const { queryByTestId, queryByText } = render(<StorageTab data={data} loading={false} />);

    expect(queryByTestId("panel-unavailable")).toBeNull();
    expect(queryByText("No tablespace information available.")).not.toBeNull();
  });
});

// A refused getTableStats read costs every figure derived from the table rows, not just the
// list - the sibling failure mode of the block above, and the one this tab was still getting
// wrong while `storageUnavailable` handled the tablespace half correctly (2026-08-27).
describe("a refused table statistics read", () => {
  // Scoped here as well, for the same reason as the block above: bun:test registers a hook
  // on the enclosing describe only.
  afterEach(() => {
    cleanup();
  });

  // Whatever `getTableStats()` rejected with, recorded verbatim under `errors.tables` by
  // `BaseProvider.getMonitoringData` (src/lib/db/base-provider.ts). The two producers in the
  // tree today are `CASSANDRA_TABLE_STATS_REFUSAL` and Trino's per-catalog
  // `tableStatsRefusal()`; this stands in for either rather than quoting a PostgreSQL error
  // text taken from memory instead of from that engine's own documentation.
  const REFUSAL = "this connection has no source for table statistics";

  function refusedTables(): MonitoringData {
    const rest: MonitoringData = makeMonitoringData();
    delete rest.tables;
    return { ...rest, errors: { tables: REFUSAL } } as MonitoringData;
  }

  test("shows the engine's own sentence instead of the largest-tables empty state", () => {
    const { getByTestId, queryByText } = render(<StorageTab data={refusedTables()} loading={false} />);

    expect(getByTestId("panel-unavailable-message").textContent).toBe(REFUSAL);
    expect(queryByText("No table information available.")).toBeNull();
  });

  test("the figures derived from the refused rows read N/A, not a measured zero", () => {
    // `tables === []` after a refusal makes `every()` vacuously true, so both totals used to
    // read a measured "0 B" at "0.0%" of the database - a measurement the engine declined to
    // make. Five figures come off those rows: the Tables and Indexes cards, the breakdown's
    // Tables and Indexes rows, and the remainder computed from both.
    const { queryAllByText } = render(<StorageTab data={refusedTables()} loading={false} />);

    expect(queryAllByText("N/A").length).toBe(5);
    expect(queryAllByText("0 B").length).toBe(0);
    expect(queryAllByText("0.0%").length).toBe(0);
  });

  test("the remainder row does not absorb the whole database", () => {
    // With both totals at a fabricated 0, `100 - 0 - 0` handed the remainder every byte of
    // the database at 100% - the round's relabelled "Other (unattributed)" row asserting
    // confidently that all 2 GB is unattributed. "2.00 GB" must appear once, on the DB Size
    // card, which is the one panel that did answer.
    const { container, queryAllByText, getByTestId } = render(<StorageTab data={refusedTables()} loading={false} />);

    expect(queryAllByText("2.00 GB").length).toBe(1);
    // The label still renders - the row is drawn, only its figure is an absence.
    expect(getByTestId("storage-breakdown-other-label").textContent).toBe("Other (unattributed)");
    // And its bar with it: `Progress` draws its share as `translateX(-(100 - value)%)`, so an
    // empty remainder bar is "-100%". A full one - "-0%", which is what `100 - 0 - 0` used to
    // produce here - is the same overclaim in a shape no text assertion can see.
    const bars = [...container.querySelectorAll('[data-slot="progress-indicator"]')].map(
      (el) => (el as HTMLElement).style.transform,
    );
    expect(bars.slice(0, 3)).toEqual(["translateX(-100%)", "translateX(-100%)", "translateX(-100%)"]);
  });

  test("an answered empty table list still reads 0 B and 0.0%", () => {
    // The control arm: a database that genuinely holds no tables has measured every one of
    // them, so the zeros are real and the breakdown remainder is the whole database. Without
    // this the refusal fix could be a blanket "N/A whenever the list is empty".
    const data = { ...makeMonitoringData(), tables: [] } as MonitoringData;
    const { queryAllByText, queryByTestId, queryByText } = render(<StorageTab data={data} loading={false} />);

    expect(queryByTestId("panel-unavailable")).toBeNull();
    expect(queryByText("No table information available.")).not.toBeNull();
    // Tables and Indexes cards, plus the breakdown's two rows.
    expect(queryAllByText("0 B").length).toBe(4);
    expect(queryAllByText("0.0%").length).toBe(2);
    // The remainder is the entire database, and that is the arithmetic, not a fabrication.
    expect(queryAllByText("2.00 GB").length).toBe(2);
  });

  test("a populated table list keeps its measured figures", () => {
    const { queryAllByText, queryByTestId } = render(<StorageTab data={makeMonitoringData()} loading={false} />);

    expect(queryByTestId("panel-unavailable")).toBeNull();
    // 500 MB + 200 MB of table data, on the Tables card and the breakdown's Tables row.
    expect(queryAllByText("700.00 MB").length).toBe(2);
    expect(queryAllByText("N/A").length).toBe(0);
  });
});
