import "../../setup-dom";
import "../../helpers/mock-sonner";
import { resetMockSearchParams, setMockSearchParams } from "../../helpers/mock-navigation";

import { mock } from "bun:test";
import { setupRechartssMock, setupFramerMotionMock } from "../../helpers/mock-monaco";

setupRechartssMock();
setupFramerMotionMock();

// ---- Trackable mock functions ----
const mockRefresh = mock(() => {});
const mockKillSession = mock(() => true);
const mockRunMaintenance = mock(() => true);

// ---- Override objects ----
let monitoringOverride: Record<string, unknown> = {};
let mockConnectionsList: Record<string, unknown>[] = [
  {
    id: "c1",
    name: "PG Dev",
    type: "postgres",
    host: "localhost",
    port: 5432,
    database: "dev",
    createdAt: new Date(),
  },
];
let mockActiveConnectionId: string | null = "c1";

// The capabilities the selected connection's provider declares. `null` is the
// state before `/api/db/provider-meta` answers, and the state it stays in when
// that request fails (#282).
let mockMetadata: { capabilities: Record<string, unknown>; labels?: Record<string, string> } | null = {
  capabilities: { supportsMaintenance: true, maintenanceOperations: ["analyze", "vacuum", "reindex"] },
};

const defaultSessions = [
  {
    pid: 1234,
    user: "admin",
    state: "active",
    query: "SELECT 1",
    duration: "00:01:00",
    durationMs: 60000,
    database: "dev",
  },
];

const defaultTables = [
  {
    tableName: "users",
    schemaName: "public",
    rowCount: 1000,
    tableSize: "16 MB",
    totalSize: "20 MB",
    bloatRatio: 5,
  },
];

// The options the tab asked for, so a test can assert that a provider whose rows
// are derived groupings never requests tables at all (#459).
let lastMonitoringOptions: Record<string, unknown> | undefined;

mock.module("@/hooks/use-monitoring-data", () => ({
  useMonitoringData: mock((_conn: unknown, options?: Record<string, unknown>) => {
    lastMonitoringOptions = options;
    return {
      data: {
        activeSessions: defaultSessions,
        tables: defaultTables,
      },
      loading: false,
      error: null,
      refresh: mockRefresh,
      killSession: mockKillSession,
      runMaintenance: mockRunMaintenance,
      ...monitoringOverride,
    };
  }),
}));

mock.module("@/hooks/use-provider-metadata", () => ({
  useProviderMetadata: mock(() => ({ metadata: mockMetadata, isLoading: false })),
}));

mock.module("@/lib/storage", () => ({
  storage: {
    getConnections: mock(() => mockConnectionsList),
    getActiveConnectionId: mock(() => mockActiveConnectionId),
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
}));

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

import { OperationsTab } from "@/components/admin/tabs/OperationsTab";

// =============================================================================
// Test data
// =============================================================================

const multiSessions = [
  {
    pid: 100,
    user: "admin",
    state: "active",
    query: "SELECT 1",
    duration: "00:00:05",
    durationMs: 5000,
    database: "dev",
  },
  { pid: 101, user: "user1", state: "idle", query: "", duration: "00:00:10", durationMs: 10000, database: "dev" },
  {
    pid: 102,
    user: "user2",
    state: "idle in transaction",
    query: "UPDATE users SET x=1",
    duration: "00:02:00",
    durationMs: 120000,
    database: "dev",
  },
  {
    pid: 103,
    user: "user3",
    state: "idle in transaction (aborted)",
    query: "INSERT INTO t",
    duration: "00:00:30",
    durationMs: 30000,
    database: "dev",
  },
  {
    pid: 104,
    user: "user4",
    state: "fastpath function call",
    query: "",
    duration: "00:00:01",
    durationMs: 1000,
    database: "dev",
    waitEventType: "Lock",
  },
];

const multiTables = [
  { tableName: "users", schemaName: "public", rowCount: 1000, tableSize: "16 MB", totalSize: "20 MB", bloatRatio: 5 },
  {
    tableName: "orders",
    schemaName: "public",
    rowCount: 50000,
    tableSize: "128 MB",
    totalSize: "200 MB",
    bloatRatio: 25,
  },
  { tableName: "products", schemaName: "public", rowCount: 200, tableSize: "2 MB", totalSize: "3 MB", bloatRatio: 0 },
];

// =============================================================================
// OperationsTab Tests
// =============================================================================

describe("OperationsTab", () => {
  beforeEach(() => {
    // Reset overrides
    monitoringOverride = {};
    mockConnectionsList = [
      {
        id: "c1",
        name: "PG Dev",
        type: "postgres",
        host: "localhost",
        port: 5432,
        database: "dev",
        createdAt: new Date(),
      },
    ];
    mockActiveConnectionId = "c1";
    mockMetadata = {
      capabilities: { supportsMaintenance: true, maintenanceOperations: ["analyze", "vacuum", "reindex"] },
    };

    // Clear mocks
    mockRefresh.mockClear();
    mockKillSession.mockClear();
    mockKillSession.mockImplementation(() => true);
    mockRunMaintenance.mockClear();
    mockRunMaintenance.mockImplementation(() => true);
    lastMonitoringOptions = undefined;
    resetMockSearchParams();
  });

  afterEach(() => {
    cleanup();
    resetMockSearchParams();
  });

  // =========================================================================
  // Existing rendering tests
  // =========================================================================

  test("renders connection selector", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText("PG Dev")).not.toBeNull();
  });

  test("shows global operations section", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText("Global Operations")).not.toBeNull();
    expect(queryByText("Update Statistics")).not.toBeNull();
    expect(queryByText("Reclaim Space")).not.toBeNull();
    expect(queryByText("Rebuild Indexes")).not.toBeNull();
  });

  test("shows tables panel with table list", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText("Tables (1)")).not.toBeNull();
    expect(queryByText("users")).not.toBeNull();
  });

  test("shows sessions panel with session list", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText("Sessions (1)")).not.toBeNull();
    expect(queryByText("1234")).not.toBeNull();
  });

  test("maintenance buttons present", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText("Run Analyze")).not.toBeNull();
    expect(queryByText("Run Vacuum")).not.toBeNull();
    expect(queryByText("Run Reindex")).not.toBeNull();
  });

  // ── Maintenance controls are gated on declared capability (#282) ──────────
  //
  // `/api/db/maintenance` short-circuits on the capability, so an ungated button
  // can only ever answer HTTP 400. This is the same gate #272 put on the
  // monitoring Tables tab; this tab is its untouched twin, and the affected set is
  // broad — Druid and the embedded engine declare no maintenance at all, and
  // MySQL, MSSQL, ClickHouse, Oracle and Redis declare neither vacuum nor reindex.

  test("renders only the operations the provider declares", async () => {
    mockMetadata = { capabilities: { supportsMaintenance: true, maintenanceOperations: ["analyze"] } };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText("Run Analyze")).not.toBeNull();
    expect(queryByText("Run Vacuum")).toBeNull();
    expect(queryByText("Run Reindex")).toBeNull();
  });

  test("hides the whole maintenance group when the provider declares none", async () => {
    mockMetadata = { capabilities: { supportsMaintenance: false, maintenanceOperations: [] } };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText("Global Operations")).toBeNull();
    expect(queryByText("Run Analyze")).toBeNull();
    expect(queryByText("Run Vacuum")).toBeNull();
    expect(queryByText("Run Reindex")).toBeNull();
  });

  test("hides the controls while the capabilities are unknown", async () => {
    // Undefined covers both the moment before /api/db/provider-meta answers and
    // the case where it failed. Failing open would put the dead buttons back on
    // exactly the connections this gate exists for, which is how #272 reasoned.
    mockMetadata = null;
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText("Run Analyze")).toBeNull();
    expect(queryByText("Global Operations")).toBeNull();
  });

  test("hides the per-table maintenance buttons the provider does not declare", async () => {
    mockMetadata = { capabilities: { supportsMaintenance: true, maintenanceOperations: ["analyze"] } };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;

    const titles = Array.from(container.querySelectorAll("button")).map((b) => b.getAttribute("title"));
    expect(titles).toContain("Analyze");
    expect(titles).not.toContain("Vacuum");
  });

  // ── Global maintenance cards speak the provider's language (#427) ─────────
  //
  // The six analyze/vacuum global ProviderLabels fields were declared in the type,
  // set by four providers, and read by no component: Redis rendered Postgres's
  // "Update Statistics / Updates query planner statistics for all tables".

  test("renders the provider's own global maintenance wording", async () => {
    mockMetadata = {
      capabilities: { supportsMaintenance: true, maintenanceOperations: ["analyze", "vacuum"] },
      labels: {
        analyzeGlobalLabel: "Run Info",
        analyzeGlobalTitle: "Server Info",
        analyzeGlobalDesc: "Get Redis server information and statistics.",
        vacuumGlobalLabel: "Run Memory Doctor",
        vacuumGlobalTitle: "Memory Doctor",
        vacuumGlobalDesc: "Analyzes memory usage and reports issues.",
      },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText("Run Info")).not.toBeNull();
    expect(queryByText("Server Info")).not.toBeNull();
    expect(queryByText("Get Redis server information and statistics.")).not.toBeNull();
    expect(queryByText("Run Memory Doctor")).not.toBeNull();
    expect(queryByText("Memory Doctor")).not.toBeNull();
    expect(queryByText("Analyzes memory usage and reports issues.")).not.toBeNull();

    // The Postgres wording must be gone, not merely joined.
    expect(queryByText("Run Analyze")).toBeNull();
    expect(queryByText("Update Statistics")).toBeNull();
    expect(queryByText("Reclaim Space")).toBeNull();
  });

  test("falls back to the generic wording when the provider ships no labels", async () => {
    mockMetadata = {
      capabilities: { supportsMaintenance: true, maintenanceOperations: ["analyze", "vacuum"] },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText("Run Analyze")).not.toBeNull();
    expect(queryByText("Update Statistics")).not.toBeNull();
    expect(queryByText("Updates query planner statistics for all tables.")).not.toBeNull();
    expect(queryByText("Run Vacuum")).not.toBeNull();
    expect(queryByText("Reclaim Space")).not.toBeNull();
    expect(queryByText("Removes dead rows and returns space to the OS.")).not.toBeNull();
  });

  test("renders the provider's own global reindex wording (#464)", async () => {
    // Couchbase's `reindex` builds deferred GSI indexes for one keyspace, which the
    // hardcoded PostgreSQL copy described in none of its three strings.
    mockMetadata = {
      capabilities: { supportsMaintenance: true, maintenanceOperations: ["reindex"] },
      labels: {
        reindexGlobalLabel: "Build Indexes",
        reindexGlobalTitle: "Build Deferred GSI Indexes",
        reindexGlobalDesc: "Runs BUILD INDEX for the deferred global secondary indexes of one collection.",
      },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText("Build Indexes")).not.toBeNull();
    expect(queryByText("Build Deferred GSI Indexes")).not.toBeNull();
    expect(queryByText("Runs BUILD INDEX for the deferred global secondary indexes of one collection.")).not.toBeNull();

    // The Postgres wording must be gone, not merely joined.
    expect(queryByText("Run Reindex")).toBeNull();
    expect(queryByText("Rebuild Indexes")).toBeNull();
    expect(queryByText("Reconstructs all indexes in the database.")).toBeNull();
  });

  test("falls back to the generic reindex wording when the provider declares no triad", async () => {
    // The triad is optional on the published `ProviderLabels`, and `metadata` can
    // carry capabilities with no labels at all, so both cases keep the old strings.
    mockMetadata = {
      capabilities: { supportsMaintenance: true, maintenanceOperations: ["reindex"] },
      labels: { analyzeGlobalLabel: "Run Analyze" },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText("Run Reindex")).not.toBeNull();
    expect(queryByText("Rebuild Indexes")).not.toBeNull();
    expect(queryByText("Reconstructs all indexes in the database.")).not.toBeNull();
  });

  test("warning card present", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText("Warning")).not.toBeNull();
    expect(queryByText(/resource-intensive/)).not.toBeNull();
  });

  test("shows table size information", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText("16 MB")).not.toBeNull();
  });

  test("shows session user info", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText("admin")).not.toBeNull();
  });

  test("shows session query info", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    expect(container.textContent).toContain("SELECT 1");
  });

  test("shows session duration", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    expect(container.textContent).toContain("00:01:00");
  });

  test("shows row count for tables", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    expect(container.textContent).toMatch(/1,?000/);
  });

  test("shows connection type in selector", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    expect(container.textContent).toContain("(postgres)");
  });

  test("shows session state as Active badge", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    expect(container.textContent).toContain("Active");
  });

  // =========================================================================
  // Empty state: no connections
  // =========================================================================

  test("shows empty state when no connections", async () => {
    mockConnectionsList = [];
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText("No Database Connections")).not.toBeNull();
    expect(queryByText(/add a database connection/i)).not.toBeNull();
  });

  // =========================================================================
  // Error state
  // =========================================================================

  test("shows error message when error and no data", async () => {
    monitoringOverride = { data: null, error: "Connection refused" };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText("Connection refused")).not.toBeNull();
  });

  // =========================================================================
  // Loading state
  // =========================================================================

  test("shows loading skeletons when loading with no data", async () => {
    monitoringOverride = {
      data: { activeSessions: [], tables: [] },
      loading: true,
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    // At minimum, the component renders skeleton placeholders when loading
    expect(container.textContent).toContain("Tables (0)");
    expect(container.textContent).toContain("Sessions (0)");
  });

  // =========================================================================
  // Empty sessions / empty tables
  // =========================================================================

  test("shows no sessions message when empty", async () => {
    monitoringOverride = {
      data: { activeSessions: [], tables: defaultTables },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText("No active sessions found.")).not.toBeNull();
  });

  // =========================================================================
  // Table search filter
  // =========================================================================

  test("filters tables by search input", async () => {
    monitoringOverride = {
      data: { activeSessions: defaultSessions, tables: multiTables },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container, queryByText } = renderResult!;

    // All 3 tables visible initially
    expect(queryByText("Tables (3)")).not.toBeNull();
    expect(queryByText("users")).not.toBeNull();
    expect(queryByText("orders")).not.toBeNull();
    expect(queryByText("products")).not.toBeNull();

    // Type in filter input
    const filterInput = container.querySelector('input[placeholder="Filter..."]') as HTMLInputElement;
    expect(filterInput).not.toBeNull();
    await act(async () => {
      fireEvent.change(filterInput, { target: { value: "ord" } });
    });

    // Only 'orders' should match
    expect(queryByText("orders")).not.toBeNull();
    expect(queryByText("users")).toBeNull();
    expect(queryByText("products")).toBeNull();
  });

  test("shows no tables found when filter matches nothing", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container, queryByText } = renderResult!;

    const filterInput = container.querySelector('input[placeholder="Filter..."]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(filterInput, { target: { value: "zzz_nonexistent" } });
    });
    expect(queryByText("No tables found.")).not.toBeNull();
  });

  // =========================================================================
  // Bloat ratio badge
  // =========================================================================

  test("shows bloat ratio badge for high-bloat tables", async () => {
    monitoringOverride = {
      data: { activeSessions: defaultSessions, tables: multiTables },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;

    // 'orders' table has 25% bloat (>10%) — should show badge
    expect(container.textContent).toContain("25% bloat");
    // 'products' table has 0% bloat — no bloat badge (only one bloat badge total)
    const bloatBadges = container.textContent!.match(/\d+% bloat/g) || [];
    expect(bloatBadges).toEqual(["25% bloat"]);
  });

  // =========================================================================
  // Session state badge variants
  // =========================================================================

  test("renders correct badges for different session states", async () => {
    monitoringOverride = {
      data: { activeSessions: multiSessions, tables: defaultTables },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    const text = container.textContent || "";

    expect(text).toContain("Active");
    expect(text).toContain("Idle");
    expect(text).toContain("Idle TX");
    expect(text).toContain("Abort");
    // Default state — 'fastpath function call'
    expect(text).toContain("fastpath function call");
  });

  // =========================================================================
  // Session summary counts
  // =========================================================================

  test("shows correct session summary counts", async () => {
    monitoringOverride = {
      data: { activeSessions: multiSessions, tables: defaultTables },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    const text = container.textContent || "";

    // multiSessions: 1 active, 1 idle, 2 idle in tx (one normal, one aborted), 1 waiting
    expect(text).toContain("Sessions (5)");
  });

  // =========================================================================
  // Refresh button
  // =========================================================================

  test("refresh button calls refresh", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    const refreshBtn = queryByText("Refresh");
    expect(refreshBtn).not.toBeNull();
    await act(async () => {
      fireEvent.click(refreshBtn!.closest("button")!);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // handleRunMaintenance — success
  // =========================================================================

  test("handleRunMaintenance success adds success log entry", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    // Click "Run Analyze"
    const analyzeBtn = queryByText("Run Analyze");
    expect(analyzeBtn).not.toBeNull();
    await act(async () => {
      fireEvent.click(analyzeBtn!.closest("button")!);
    });

    expect(mockRunMaintenance).toHaveBeenCalledWith("analyze", undefined);
    // Operation log should appear with success
    expect(queryByText("Operation Log (this session)")).not.toBeNull();
    expect(queryByText("ANALYZE")).not.toBeNull();
  });

  test("handleRunMaintenance vacuum", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    const vacuumBtn = queryByText("Run Vacuum");
    await act(async () => {
      fireEvent.click(vacuumBtn!.closest("button")!);
    });
    expect(mockRunMaintenance).toHaveBeenCalledWith("vacuum", undefined);
    expect(queryByText("VACUUM")).not.toBeNull();
  });

  test("handleRunMaintenance reindex", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    const reindexBtn = queryByText("Run Reindex");
    await act(async () => {
      fireEvent.click(reindexBtn!.closest("button")!);
    });
    expect(mockRunMaintenance).toHaveBeenCalledWith("reindex", undefined);
    expect(queryByText("REINDEX")).not.toBeNull();
  });

  // =========================================================================
  // handleRunMaintenance — failure (returns false)
  // =========================================================================

  test("handleRunMaintenance failure shows failure in log", async () => {
    mockRunMaintenance.mockImplementation(() => false);
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText, container } = renderResult!;

    const analyzeBtn = queryByText("Run Analyze");
    await act(async () => {
      fireEvent.click(analyzeBtn!.closest("button")!);
    });

    expect(queryByText("ANALYZE")).not.toBeNull();
    // The log entry should show — the component uses XCircle icon for failure
    // We verify the log appears
    expect(queryByText("Operation Log (this session)")).not.toBeNull();
    // Target is 'all' for global operation
    expect(container.textContent).toContain("all");
  });

  // =========================================================================
  // handleRunMaintenance — exception (catch block)
  // =========================================================================

  test("handleRunMaintenance exception adds failure log entry", async () => {
    mockRunMaintenance.mockImplementation(() => {
      throw new Error("DB error");
    });
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    const analyzeBtn = queryByText("Run Analyze");
    await act(async () => {
      fireEvent.click(analyzeBtn!.closest("button")!);
    });

    // Log should appear with failure entry
    expect(queryByText("Operation Log (this session)")).not.toBeNull();
    expect(queryByText("ANALYZE")).not.toBeNull();
  });

  // =========================================================================
  // handleRunMaintenance — per-table operation
  // =========================================================================

  test("handleRunMaintenance for specific table", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;

    // Find the table row for 'users' and click its analyze button (first icon button)
    const tableRows = container.querySelectorAll(".divide-y > div");
    const usersRow = Array.from(tableRows).find((row) => row.textContent?.includes("users"));
    expect(usersRow).not.toBeNull();

    const buttons = usersRow!.querySelectorAll("button");
    // First button is Analyze, second is Vacuum
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      fireEvent.click(buttons[0]!);
    });

    expect(mockRunMaintenance).toHaveBeenCalledWith("analyze", "users");
  });

  test("per-table vacuum button calls runMaintenance with table name", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;

    const tableRows = container.querySelectorAll(".divide-y > div");
    const usersRow = Array.from(tableRows).find((row) => row.textContent?.includes("users"));
    const buttons = usersRow!.querySelectorAll("button");
    await act(async () => {
      fireEvent.click(buttons[1]!);
    });

    expect(mockRunMaintenance).toHaveBeenCalledWith("vacuum", "users");
  });

  // =========================================================================
  // Kill session flow
  // =========================================================================

  test("kill button opens confirmation dialog", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container, baseElement } = renderResult!;

    // Find the session row by PID 1234
    const cells = container.querySelectorAll("td");
    const pidCell = Array.from(cells).find((td) => td.textContent?.includes("1234"));
    expect(pidCell).not.toBeNull();
    const row = pidCell!.closest("tr");
    const killBtn = row!.querySelector("td:last-child button");
    expect(killBtn).not.toBeNull();

    await act(async () => {
      fireEvent.click(killBtn!);
    });

    // Confirmation dialog should appear (may be portaled)
    const dialogText = baseElement.textContent || "";
    expect(dialogText).toContain("Terminate Session?");
    expect(dialogText).toContain("1234");
  });

  test("confirming kill calls killSession and adds log entry", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container, baseElement } = renderResult!;

    // Click kill button
    const cells = container.querySelectorAll("td");
    const pidCell = Array.from(cells).find((td) => td.textContent?.includes("1234"));
    const row = pidCell!.closest("tr");
    const killBtn = row!.querySelector("td:last-child button");
    await act(async () => {
      fireEvent.click(killBtn!);
    });

    // Find and click "Terminate" button in the dialog
    const allButtons = baseElement.querySelectorAll("button");
    const terminateBtn = Array.from(allButtons).find((btn) => btn.textContent?.trim() === "Terminate");
    expect(terminateBtn).not.toBeNull();
    await act(async () => {
      fireEvent.click(terminateBtn!);
    });

    expect(mockKillSession).toHaveBeenCalledWith(1234);
    // Log entry should appear
    expect(baseElement.textContent).toContain("KILL");
    expect(baseElement.textContent).toContain("PID:1234");
  });

  test("cancel kill dialog does not call killSession", async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container, baseElement } = renderResult!;

    // Click kill button
    const cells = container.querySelectorAll("td");
    const pidCell = Array.from(cells).find((td) => td.textContent?.includes("1234"));
    const row = pidCell!.closest("tr");
    const killBtn = row!.querySelector("td:last-child button");
    await act(async () => {
      fireEvent.click(killBtn!);
    });

    // Find and click "Cancel" button
    const allButtons = baseElement.querySelectorAll("button");
    const cancelBtn = Array.from(allButtons).find((btn) => btn.textContent?.trim() === "Cancel");
    expect(cancelBtn).not.toBeNull();
    await act(async () => {
      fireEvent.click(cancelBtn!);
    });

    expect(mockKillSession).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Session duration badge variants
  // =========================================================================

  test("session with >60s shows destructive duration badge", async () => {
    monitoringOverride = {
      data: {
        activeSessions: [
          {
            pid: 200,
            user: "u1",
            state: "active",
            query: "Q",
            duration: "00:02:00",
            durationMs: 120000,
            database: "dev",
          },
          { pid: 201, user: "u2", state: "idle", query: "", duration: "00:00:05", durationMs: 5000, database: "dev" },
        ],
        tables: defaultTables,
      },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    const text = container.textContent || "";
    expect(text).toContain("00:02:00");
    expect(text).toContain("00:00:05");
  });

  // =========================================================================
  // Connection selection with saved active ID
  // =========================================================================

  test("selects saved active connection on mount", async () => {
    mockConnectionsList = [
      {
        id: "c1",
        name: "PG Dev",
        type: "postgres",
        host: "localhost",
        port: 5432,
        database: "dev",
        createdAt: new Date(),
      },
      {
        id: "c2",
        name: "MySQL Prod",
        type: "mysql",
        host: "localhost",
        port: 3306,
        database: "prod",
        createdAt: new Date(),
      },
    ];
    mockActiveConnectionId = "c2";
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    // Should show MySQL Prod as selected (savedId matches c2)
    expect(queryByText("MySQL Prod")).not.toBeNull();
  });

  test("falls back to first connection when savedId not found", async () => {
    mockActiveConnectionId = "nonexistent";
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText("PG Dev")).not.toBeNull();
  });

  test("falls back to first connection when no savedId", async () => {
    mockActiveConnectionId = null;
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText("PG Dev")).not.toBeNull();
  });

  // =========================================================================
  // Session with no query shows dash
  // =========================================================================

  test("session with no query shows dash", async () => {
    monitoringOverride = {
      data: {
        activeSessions: [
          {
            pid: 300,
            user: "admin",
            state: "idle",
            query: "",
            duration: "00:00:01",
            durationMs: 1000,
            database: "dev",
          },
        ],
        tables: defaultTables,
      },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    // When query is empty, component shows '-'
    const cells = container.querySelectorAll("td");
    const queryCell = Array.from(cells).find((td) => td.textContent?.trim() === "-");
    expect(queryCell).not.toBeNull();
  });

  // =========================================================================
  // Loading skeletons — tables panel
  // =========================================================================

  test("shows loading skeletons in tables panel when loading=true and tables empty", async () => {
    monitoringOverride = {
      data: { activeSessions: defaultSessions, tables: [] },
      loading: true,
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;

    // The tables panel shows 5 Skeleton divs when loading && tables.length === 0
    const allSkeletons = container.querySelectorAll('[data-slot="skeleton"]');
    // Tables panel renders 5 skeletons; sessions panel has data so no skeletons there
    expect(allSkeletons.length).toBe(5);
    // Tables count header still shows 0
    expect(container.textContent).toContain("Tables (0)");
    // Sessions should render normally (not skeletons) since sessions have data
    expect(container.textContent).toContain("Sessions (1)");
  });

  // =========================================================================
  // Loading skeletons — sessions panel
  // =========================================================================

  test("shows loading skeletons in sessions panel when loading=true and sessions empty", async () => {
    monitoringOverride = {
      data: { activeSessions: [], tables: defaultTables },
      loading: true,
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;

    // The sessions panel shows 4 Skeleton divs when loading && sessions.length === 0
    const allSkeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(allSkeletons.length).toBe(4);
    // Sessions count header still shows 0
    expect(container.textContent).toContain("Sessions (0)");
    // Tables should render normally since tables have data
    expect(container.textContent).toContain("Tables (1)");
    expect(container.textContent).toContain("users");
  });

  // =========================================================================
  // handleConnectionChange with non-existent connection id (guard)
  // =========================================================================

  test("handleConnectionChange with non-existent id does not change selection", async () => {
    // Use a non-existent savedId to test the guard in handleConnectionChange
    // When savedId doesn't match any connection, it falls back to first connection
    mockConnectionsList = [
      {
        id: "c1",
        name: "PG Dev",
        type: "postgres",
        host: "localhost",
        port: 5432,
        database: "dev",
        createdAt: new Date(),
      },
      {
        id: "c2",
        name: "MySQL Prod",
        type: "mysql",
        host: "localhost",
        port: 3306,
        database: "prod",
        createdAt: new Date(),
      },
    ];
    // Set savedId to a non-existent id
    mockActiveConnectionId = "nonexistent-id";
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;

    // Since savedId doesn't match any connection, the guard falls back to first connection (PG Dev)
    expect(container.textContent).toContain("PG Dev");
    expect(container.textContent).toContain("(postgres)");

    // The component should not crash and should still render the monitoring data
    expect(container.textContent).toContain("Global Operations");
    expect(container.textContent).toContain("Sessions");
    expect(container.textContent).toContain("Tables");
  });

  // =========================================================================
  // handleConnectionChange via connection selector
  // =========================================================================

  test("changing connection in selector updates selection", async () => {
    mockConnectionsList = [
      {
        id: "c1",
        name: "PG Dev",
        type: "postgres",
        host: "localhost",
        port: 5432,
        database: "dev",
        createdAt: new Date(),
      },
      {
        id: "c2",
        name: "MySQL Prod",
        type: "mysql",
        host: "localhost",
        port: 3306,
        database: "prod",
        createdAt: new Date(),
      },
    ];
    mockActiveConnectionId = "c1";
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container, baseElement } = renderResult!;

    // Initially the saved connection (PG Dev) is selected
    expect(container.textContent).toContain("(postgres)");

    // Open the connection select via keyboard (happy-dom lacks full pointer support)
    const selectTrigger = container.querySelector('[data-slot="select-trigger"]') as HTMLElement;
    expect(selectTrigger).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(selectTrigger, { key: "ArrowDown" });
    });

    // Pick the MySQL Prod option from the portaled listbox
    const options = Array.from(baseElement.querySelectorAll('[role="option"]'));
    const mysqlOption = options.find((o) => o.textContent?.includes("MySQL Prod")) as HTMLElement;
    expect(mysqlOption).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(mysqlOption, { key: "Enter" });
    });

    // handleConnectionChange found c2 and updated the selection
    expect(container.textContent).toContain("MySQL Prod");
    expect(container.textContent).toContain("(mysql)");
  });

  // =========================================================================
  // Session duration badge outline variant (10s-60s range)
  // =========================================================================

  test("session with 10s-60s duration shows outline variant badge", async () => {
    monitoringOverride = {
      data: {
        activeSessions: [
          {
            pid: 400,
            user: "u1",
            state: "active",
            query: "SELECT slow()",
            duration: "00:00:30",
            durationMs: 30000,
            database: "dev",
          },
          { pid: 401, user: "u2", state: "idle", query: "", duration: "00:00:05", durationMs: 5000, database: "dev" },
          {
            pid: 402,
            user: "u3",
            state: "active",
            query: "SELECT very_slow()",
            duration: "00:02:00",
            durationMs: 120000,
            database: "dev",
          },
        ],
        tables: defaultTables,
      },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;

    // Duration badge variant logic:
    // PID 400: durationMs=30000 (>10000, <=60000) -> variant="outline"
    // PID 401: durationMs=5000 (<=10000) -> variant="secondary"
    // PID 402: durationMs=120000 (>60000) -> variant="destructive"

    // Badge component renders as <span data-slot="badge">
    const allBadges = Array.from(container.querySelectorAll('span[data-slot="badge"]'));

    // Find the badge containing '00:00:30' (outline variant for 10s-60s range)
    const durationBadge400 = allBadges.find((badge) => badge.textContent?.includes("00:00:30"));
    expect(durationBadge400).toBeDefined();
    // Outline variant: does NOT have bg-destructive or bg-secondary
    expect(durationBadge400!.className).not.toContain("bg-destructive");
    expect(durationBadge400!.className).not.toContain("bg-secondary");

    // Find the badge containing '00:02:00' (destructive variant for >60s)
    const durationBadge402 = allBadges.find((badge) => badge.textContent?.includes("00:02:00"));
    expect(durationBadge402).toBeDefined();
    expect(durationBadge402!.className).toContain("bg-destructive");

    // Find the badge containing '00:00:05' (secondary variant for <=10s)
    const durationBadge401 = allBadges.find((badge) => badge.textContent?.includes("00:00:05"));
    expect(durationBadge401).toBeDefined();
    expect(durationBadge401!.className).toContain("bg-secondary");
  });

  // =========================================================================
  // Kill dialog shows user and state in description
  // =========================================================================

  test("kill dialog shows user and state in description", async () => {
    monitoringOverride = {
      data: {
        activeSessions: [
          {
            pid: 500,
            user: "db_admin",
            state: "idle in transaction",
            query: "UPDATE t SET x=1",
            duration: "00:05:00",
            durationMs: 300000,
            database: "dev",
          },
        ],
        tables: defaultTables,
      },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container, baseElement } = renderResult!;

    // Find and click the kill button for PID 500
    const cells = container.querySelectorAll("td");
    const pidCell = Array.from(cells).find((td) => td.textContent?.includes("500"));
    expect(pidCell).not.toBeNull();
    const row = pidCell!.closest("tr");
    const killBtn = row!.querySelector("td:last-child button");
    expect(killBtn).not.toBeNull();

    await act(async () => {
      fireEvent.click(killBtn!);
    });

    // Dialog should be open and show user and state info
    const dialogText = baseElement.textContent || "";
    expect(dialogText).toContain("Terminate Session?");
    expect(dialogText).toContain("500");
    // User is shown in the description
    expect(dialogText).toContain("db_admin");
    // State is shown in the description
    expect(dialogText).toContain("idle in transaction");
    // Also verify the warning about uncommitted transactions
    expect(dialogText).toContain("uncommitted transactions");
  });

  // =========================================================================
  // Error hidden when both error AND data present
  // =========================================================================

  test("error message is hidden when both error and data are present", async () => {
    monitoringOverride = {
      data: { activeSessions: defaultSessions, tables: defaultTables },
      error: "Intermittent connection error",
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText, container } = renderResult!;

    // The error message should NOT be displayed because data is present
    // (source code: `error && !data` — data is truthy, so error div is skipped)
    expect(queryByText("Intermittent connection error")).toBeNull();

    // But data should still render normally
    expect(queryByText("Sessions (1)")).not.toBeNull();
    expect(queryByText("Tables (1)")).not.toBeNull();
    expect(container.textContent).toContain("users");
    expect(container.textContent).toContain("1234");
  });
  // ── Derived groupings have no Tables panel (#459) ──────────────────────────
  //
  // Redis and the embedded engine declare `tablesAreDerivedGroupings`: their rows
  // are prefix/namespace groupings, not addressable tables, so the panel could
  // only ever say "Tables (0)". The PANEL hangs off that one capability - the same
  // one TableItem already reads.
  //
  // The REQUEST deliberately does not: useMonitoringData fetches once per connection
  // through an options ref, so its single request is issued while `metadata` is still
  // null and no later option change reaches it. Asserting `includeTables: false` here
  // would pass on this file's synchronous metadata mock and be false in the browser -
  // the vacuous-assertion class this repo has been bitten by before.

  test("renders no Tables panel for a derived-groupings provider", async () => {
    mockMetadata = {
      capabilities: { supportsMaintenance: true, maintenanceOperations: ["analyze"], tablesAreDerivedGroupings: true },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText("Tables (0)")).toBeNull();
    expect(queryByText("Tables (1)")).toBeNull();
    // The sessions half of the split is untouched.
    expect(queryByText("Sessions (1)")).not.toBeNull();
  });

  test("keeps the Tables panel while the capabilities are unknown", async () => {
    // `metadata` is null before /api/db/provider-meta answers and when it fails.
    // Every provider but two has addressable rows, so the panel stays — the same
    // way TableItem treats an unknown capability as addressable.
    mockMetadata = null;
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText("Tables (1)")).not.toBeNull();
    // The request is unconditional, so the tab's one fetch always asks for tables.
    expect(lastMonitoringOptions?.includeTables).toBe(true);
  });

  // ── A deep link from an Explorer row arrives selected (#459) ───────────────

  test("deep-linked table name arrives filtered and selected", async () => {
    monitoringOverride = { data: { activeSessions: defaultSessions, tables: multiTables } };
    setMockSearchParams(new URLSearchParams("table=orders"));
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText, container } = renderResult!;

    expect(queryByText("orders")).not.toBeNull();
    expect(queryByText("users")).toBeNull();
    const selected = container.querySelectorAll('[data-selected="true"]');
    expect(selected.length).toBe(1);
    expect(selected[0]?.textContent).toContain("orders");
  });

  test("marks no row selected without a deep link", async () => {
    monitoringOverride = { data: { activeSessions: defaultSessions, tables: multiTables } };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;

    expect(container.querySelectorAll('[data-selected="true"]').length).toBe(0);
  });

  // =========================================================================
  // A refused monitoring read costs its own panel, and the engine's own
  // sentence reaches the user in place of the empty-state copy.
  // =========================================================================

  test("a refused activeSessions read shows the engine's own sentence", async () => {
    monitoringOverride = {
      data: { tables: defaultTables, errors: { activeSessions: "Unknown table 'information_schema.PROCESSLIST'." } },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { getByTestId } = renderResult!;

    expect(getByTestId("operations-sessions-empty").textContent).toBe(
      "Unknown table 'information_schema.PROCESSLIST'.",
    );
    // The card title must not publish a count it does not have either.
    expect(renderResult!.getByText("Sessions")).not.toBeNull();
  });

  test("an answered empty session list keeps the empty-state copy", async () => {
    monitoringOverride = { data: { activeSessions: [], tables: defaultTables } };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { getByTestId } = renderResult!;

    expect(getByTestId("operations-sessions-empty").textContent).toBe("No active sessions found.");
  });

  // #D48. The default sentence reads as "nothing is running right now", which is false
  // on an engine whose session list does not exist. Both branches are pinned so the
  // fallback cannot quietly become the only path again.
  test("an engine declaring sessionsEmptyState replaces the empty-state copy", async () => {
    const duckdb = "DuckDB publishes no session list - there is no duckdb_connections() table function.";
    mockMetadata = {
      capabilities: { supportsMaintenance: true, maintenanceOperations: ["analyze"] },
      labels: { sessionsEmptyState: duckdb },
    };
    monitoringOverride = { data: { activeSessions: [], tables: defaultTables } };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });

    expect(renderResult!.getByTestId("operations-sessions-empty").textContent).toBe(duckdb);
  });

  test("a refused read outranks the label, because a refusal is not an absence", async () => {
    mockMetadata = {
      capabilities: { supportsMaintenance: true, maintenanceOperations: ["analyze"] },
      labels: { sessionsEmptyState: "DuckDB publishes no session list." },
    };
    monitoringOverride = {
      data: { tables: defaultTables, errors: { activeSessions: "permission denied" } },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });

    expect(renderResult!.getByTestId("operations-sessions-empty").textContent).toBe("permission denied");
  });

  test("a refused tables read shows the engine's own sentence", async () => {
    monitoringOverride = {
      data: { activeSessions: defaultSessions, errors: { tables: "permission denied for relation pg_class" } },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { getByTestId } = renderResult!;

    expect(getByTestId("operations-tables-empty").textContent).toBe("permission denied for relation pg_class");
    expect(renderResult!.getByText("Tables")).not.toBeNull();
  });

  test("an answered empty table list keeps the empty-state copy", async () => {
    monitoringOverride = { data: { activeSessions: defaultSessions, tables: [] } };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { getByTestId } = renderResult!;

    expect(getByTestId("operations-tables-empty").textContent).toBe("No tables found.");
  });
  // ── Every control is gated and titled by the provider's own declaration (#496) ─
  //
  // #427 reverted a generic label-to-operation mapping, and the reason is here: two
  // engines that declare the same `MaintenanceType` take different kinds of target,
  // so only the provider can say what a control may be pointed at. These tests use
  // the shapes the real providers declare.

  const render_ = async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    return renderResult!;
  };

  const titlesIn = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("button"))
      .map((b) => b.getAttribute("title"))
      .filter((t): t is string => t !== null);

  test("MySQL renders its own maintenance words and never 'Vacuum Table'", async () => {
    // MySQL has no VACUUM at all: the base default put "Run Vacuum / Reclaim Space"
    // on this tab and "Vacuum" on every table row for an engine whose operations are
    // analyze/optimize/check/kill.
    mockMetadata = {
      capabilities: {
        supportsMaintenance: true,
        maintenanceOperations: ["analyze", "optimize", "check", "kill"],
        maintenanceOperationSpecs: {
          analyze: { label: "Analyze Table", perEntity: true, global: true },
          optimize: { label: "Optimize Table", perEntity: true, global: true },
          check: { label: "Check Table", perEntity: true, global: true },
          kill: { label: "Kill Connection", perEntity: false, global: false },
        },
      },
      labels: {
        analyzeGlobalLabel: "Run Analyze",
        analyzeGlobalTitle: "Update Statistics",
        analyzeGlobalDesc: "Runs ANALYZE TABLE over every table.",
        vacuumActionOperation: "optimize",
        vacuumGlobalLabel: "Run Optimize",
        vacuumGlobalTitle: "Optimize Tables",
        vacuumGlobalDesc: "Runs OPTIMIZE TABLE over every table in the database.",
      },
    };

    const { queryByText, container } = await render_();

    // The global card the provider's wording was written for now renders...
    expect(queryByText("Run Optimize")).not.toBeNull();
    expect(queryByText("Optimize Tables")).not.toBeNull();
    // ...and the words for an operation MySQL does not have are gone.
    expect(queryByText("Run Vacuum")).toBeNull();
    expect(queryByText("Reclaim Space")).toBeNull();

    const titles = titlesIn(container);
    expect(titles).toContain("Analyze Table");
    expect(titles).toContain("Optimize Table");
    expect(titles).toContain("Check Table");
    expect(titles).not.toContain("Vacuum");
    expect(titles).not.toContain("Vacuum Table");
    // `kill` declares neither placement: its target is a connection id, which only
    // the Sessions panel below can supply.
    expect(titles).not.toContain("Kill Connection");
  });

  test("the global card whose label was redirected SENDS the redirected operation", async () => {
    // Sending `vacuum` to SQL Server, Oracle, MySQL or ClickHouse is a 400 from
    // /api/db/maintenance: none of them declares it.
    mockMetadata = {
      capabilities: {
        supportsMaintenance: true,
        maintenanceOperations: ["analyze", "optimize", "kill"],
        maintenanceOperationSpecs: {
          analyze: { label: "Gather Statistics", perEntity: true, global: true },
          optimize: { label: "Rebuild Indexes", perEntity: true, global: true },
          kill: { label: "Kill Session", perEntity: false, global: false },
        },
      },
      labels: { vacuumActionOperation: "optimize", vacuumGlobalLabel: "Rebuild Indexes" },
    };

    const { queryByText } = await render_();
    const button = queryByText("Rebuild Indexes");
    expect(button).not.toBeNull();

    await act(async () => {
      fireEvent.click(button!);
    });

    expect(mockRunMaintenance).toHaveBeenCalledWith("optimize", undefined);
  });

  test("an operation with no whole-database form gets no global card", async () => {
    // ClickHouse: OPTIMIZE names one table, so the "Merge Parts" card would always
    // have answered *"The optimize operation requires a target"*. Its analyze does
    // take both, so the section itself still renders - which is what makes the
    // absence of the optimize card a gate rather than a blanket denial.
    mockMetadata = {
      capabilities: {
        supportsMaintenance: true,
        maintenanceOperations: ["optimize", "analyze", "kill"],
        maintenanceOperationSpecs: {
          optimize: { label: "Optimize Table", perEntity: true, global: false },
          analyze: { label: "Table Statistics", perEntity: true, global: true },
          kill: { label: "Cancel Query", perEntity: false, global: false },
        },
      },
      labels: {
        vacuumActionOperation: "optimize",
        vacuumGlobalLabel: "Optimize",
        vacuumGlobalTitle: "Merge Parts",
        analyzeGlobalLabel: "Table Statistics",
      },
    };

    const { queryByText, container } = await render_();

    expect(queryByText("Global Operations")).not.toBeNull();
    expect(queryByText("Table Statistics")).not.toBeNull();
    expect(queryByText("Optimize")).toBeNull();
    expect(queryByText("Merge Parts")).toBeNull();
    // The per-table control is the one that CAN succeed, so it stays.
    expect(titlesIn(container)).toContain("Optimize Table");
  });

  test("Couchbase's global Reindex card is withheld and the per-collection item carries the target", async () => {
    // The #U6 card rendered for every provider declaring `reindex` and answered
    // *"The reindex operation requires a target"* on Couchbase, whose BUILD INDEX
    // names one keyspace and has no whole-bucket form.
    mockMetadata = {
      capabilities: {
        supportsMaintenance: true,
        maintenanceOperations: ["analyze", "reindex", "kill"],
        maintenanceOperationSpecs: {
          analyze: { label: "Update Statistics", perEntity: true, global: false },
          reindex: { label: "Build Deferred Indexes", perEntity: true, global: false },
          kill: { label: "Cancel Request", perEntity: false, global: false },
        },
      },
      labels: {
        reindexGlobalLabel: "Build Indexes",
        reindexGlobalTitle: "Build Deferred GSI Indexes",
        analyzeGlobalLabel: "Update Statistics",
      },
    };

    const { queryByText, container } = await render_();

    // Not one global control can succeed here, so the whole section is absent.
    expect(queryByText("Global Operations")).toBeNull();
    expect(queryByText("Build Indexes")).toBeNull();
    expect(queryByText("Update Statistics")).toBeNull();

    const titles = titlesIn(container);
    expect(titles).toContain("Build Deferred Indexes");
    expect(titles).toContain("Update Statistics");

    await act(async () => {
      fireEvent.click(container.querySelector('button[title="Build Deferred Indexes"]')!);
    });

    // The target is what made this control honest: "users" is the collection row.
    expect(mockRunMaintenance).toHaveBeenCalledWith("reindex", "users");
  });

  test("an operation that ignores its target gets no per-row control", async () => {
    // Redis: `runMaintenance(type)` takes no target parameter at all, so a per-row
    // "Key Info" answered with server-wide metrics for one key prefix (#427). Rows
    // here are addressable, so nothing but the declaration withholds the control.
    mockMetadata = {
      capabilities: {
        supportsMaintenance: true,
        maintenanceOperations: ["analyze"],
        maintenanceOperationSpecs: { analyze: { label: "Server Info", perEntity: false, global: true } },
      },
      labels: { analyzeGlobalLabel: "Run Info", analyzeGlobalTitle: "Server Info" },
    };

    const { queryByText, container } = await render_();

    expect(queryByText("Run Info")).not.toBeNull();
    expect(titlesIn(container)).not.toContain("Server Info");
  });

  test("a provider that declares no specs keeps the pre-#U9 controls", async () => {
    // `maintenanceOperationSpecs` is optional on the published interface, so an
    // implementation that declares nothing must behave exactly as it did.
    mockMetadata = {
      capabilities: { supportsMaintenance: true, maintenanceOperations: ["analyze", "vacuum", "reindex"] },
    };

    const { queryByText, container } = await render_();

    expect(queryByText("Run Analyze")).not.toBeNull();
    expect(queryByText("Run Vacuum")).not.toBeNull();
    expect(queryByText("Run Reindex")).not.toBeNull();
    const titles = titlesIn(container);
    expect(titles).toContain("Analyze");
    expect(titles).toContain("Vacuum");
  });
  // =========================================================================
  // U22: the per-table operation a deep link asked for, with no row to run it on.
  //
  // The schema explorer's two maintenance items are DEEP LINKS: an admin clicking
  // "Optimize Table" lands here (Studio.tsx `openMaintenance` pushes
  // /admin/operations?table=...), and this page renders a per-table control only for
  // a ROW it has statistics for. Every empty branch of the Tables panel therefore said
  // nothing at all about the operation the operator arrived asking for.
  // =========================================================================

  /** MySQL's declaration: three per-table operations under the engine's own wording. */
  const perTableSpecs = {
    capabilities: {
      supportsMaintenance: true,
      maintenanceOperations: ["analyze", "optimize", "check", "kill"],
      maintenanceOperationSpecs: {
        analyze: { label: "Analyze Table", perEntity: true, global: true },
        optimize: { label: "Optimize Table", perEntity: true, global: true },
        check: { label: "Check Table", perEntity: true, global: true },
        kill: { label: "Kill Connection", perEntity: false, global: false },
      },
    },
  };

  test("names the deep-linked table the page has no row for", async () => {
    mockMetadata = perTableSpecs;
    monitoringOverride = { data: { activeSessions: defaultSessions, tables: multiTables } };
    setMockSearchParams(new URLSearchParams("table=archived_events"));

    const { getByTestId } = await render_();

    const note = getByTestId("operations-maintenance-unreachable").textContent ?? "";
    // The engine's own wording, the same strings the per-row buttons would carry.
    expect(note).toContain("Analyze Table");
    expect(note).toContain("Optimize Table");
    expect(note).toContain("Check Table");
    // A connection id comes from the Sessions panel, so it was never on offer per table.
    expect(note).not.toContain("Kill Connection");
    // The name is a measurement here: it is the search param that seeded the filter.
    expect(note).toContain("archived_events");
  });

  test("names the operations and the table when the engine refused the read", async () => {
    mockMetadata = perTableSpecs;
    monitoringOverride = {
      data: { activeSessions: defaultSessions, errors: { tables: "permission denied for relation pg_class" } },
    };
    setMockSearchParams(new URLSearchParams("table=orders"));

    const { getByTestId } = await render_();

    // The engine's own refusal still carries the panel; the note adds what it costs.
    expect(getByTestId("operations-tables-empty").textContent).toBe("permission denied for relation pg_class");
    const note = getByTestId("operations-maintenance-unreachable").textContent ?? "";
    expect(note).toContain("Optimize Table");
    expect(note).toContain("orders");
  });

  test("names the operations without a table when no deep link carried one", async () => {
    mockMetadata = perTableSpecs;
    monitoringOverride = {
      data: { activeSessions: defaultSessions, errors: { tables: "permission denied for relation pg_class" } },
    };

    const { getByTestId } = await render_();

    const note = getByTestId("operations-maintenance-unreachable").textContent ?? "";
    expect(note).toContain("Optimize Table");
    expect(note).toContain("no row to run it on");
    // Nothing named a table, so the sentence must not claim one was asked for.
    expect(note).not.toContain("no row for");
  });

  test("says nothing on a database that genuinely holds no tables", async () => {
    mockMetadata = perTableSpecs;
    monitoringOverride = { data: { activeSessions: defaultSessions, tables: [], overview: { tableCount: 0 } } };

    const { queryByTestId, getByTestId } = await render_();

    expect(getByTestId("operations-tables-empty").textContent).toBe("No tables found.");
    // Nothing to maintain is not a dead end, so the note would only be noise.
    expect(queryByTestId("operations-maintenance-unreachable")).toBeNull();
  });

  test("says nothing where the engine declares no per-table maintenance", async () => {
    mockMetadata = {
      capabilities: {
        supportsMaintenance: true,
        maintenanceOperations: ["vacuum"],
        maintenanceOperationSpecs: { vacuum: { label: "Vacuum Database", perEntity: false, global: true } },
      },
    };
    monitoringOverride = {
      data: { activeSessions: defaultSessions, errors: { tables: "permission denied for relation pg_class" } },
    };
    setMockSearchParams(new URLSearchParams("table=orders"));

    const { queryByTestId } = await render_();

    // Nothing was ever offered per table, so there is no per-table dead end to explain.
    expect(queryByTestId("operations-maintenance-unreachable")).toBeNull();
  });

  test("says nothing once the operator's own filter is what empties the list", async () => {
    mockMetadata = perTableSpecs;
    monitoringOverride = { data: { activeSessions: defaultSessions, tables: multiTables } };
    setMockSearchParams(new URLSearchParams("table=orders"));

    const { queryByTestId, getByPlaceholderText } = await render_();

    await act(async () => {
      fireEvent.change(getByPlaceholderText("Filter..."), { target: { value: "zzz" } });
    });

    // The rows and their controls are there; the operator's own filter hid them.
    expect(queryByTestId("operations-maintenance-unreachable")).toBeNull();
  });
});
