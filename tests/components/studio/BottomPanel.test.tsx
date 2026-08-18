import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { mock } from "bun:test";
import { setupRechartssMock } from "../../helpers/mock-monaco";

// Setup recharts mock before component imports
setupRechartssMock();

// ---- Mock all child components rendered by BottomPanel ----

// Captured rather than merely rendered: the agent-hydration tests assert WHICH
// result the grid was handed, which a bare marker element cannot show.
let capturedResultsGridProps: Record<string, unknown> = {};

mock.module("@/components/ResultsGrid", () => ({
  ResultsGrid: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    capturedResultsGridProps = props;
    return React.createElement("div", { "data-testid": "resultsgrid" }, "ResultsGrid");
  },
}));

let capturedVisualExplainProps: Record<string, unknown> = {};

mock.module("@/components/VisualExplain", () => ({
  VisualExplain: ({ onLoadQuery, ...rest }: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    capturedVisualExplainProps = { onLoadQuery, ...rest };
    return React.createElement(
      "div",
      { "data-testid": "visualexplain" },
      "VisualExplain",
      React.createElement(
        "button",
        {
          "data-testid": "visualexplain-load-btn",
          onClick: () => (onLoadQuery as ((query: string) => void) | undefined)?.("SELECT 5"),
        },
        "Load",
      ),
    );
  },
}));

mock.module("@/components/QueryHistory", () => ({
  QueryHistory: ({ onSelectQuery }: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return React.createElement(
      "div",
      { "data-testid": "queryhistory" },
      "QueryHistory",
      React.createElement(
        "button",
        {
          "data-testid": "queryhistory-select-btn",
          onClick: () => (onSelectQuery as (query: string) => void)("SELECT 3"),
        },
        "Select",
      ),
    );
  },
}));

mock.module("@/components/SavedQueries", () => ({
  SavedQueries: ({ onSelectQuery }: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return React.createElement(
      "div",
      { "data-testid": "savedqueries" },
      "SavedQueries",
      React.createElement(
        "button",
        {
          "data-testid": "savedqueries-select-btn",
          onClick: () => (onSelectQuery as (query: string) => void)("SELECT 4"),
        },
        "Select",
      ),
    );
  },
}));

// Captured for the same reason the grid's props are: the charts view can be handed
// the tab's own result or a run's, with or without the chart the run composed, and
// only the props say which.
let capturedDataChartsProps: Record<string, unknown> = {};

mock.module("@/components/DataCharts", () => ({
  DataCharts: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    capturedDataChartsProps = props;
    return React.createElement("div", { "data-testid": "datacharts" }, "DataCharts");
  },
}));

mock.module("@/components/PivotTable", () => ({
  PivotTable: ({ onLoadQuery }: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return React.createElement(
      "div",
      { "data-testid": "pivottable" },
      "PivotTable",
      React.createElement(
        "button",
        {
          "data-testid": "pivottable-load-btn",
          onClick: () => (onLoadQuery as ((query: string) => void) | undefined)?.("SELECT 2"),
        },
        "Load",
      ),
    );
  },
}));

mock.module("@/components/DatabaseDocs", () => ({
  DatabaseDocs: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return React.createElement("div", { "data-testid": "databasedocs" }, "DatabaseDocs");
  },
}));

mock.module("@/components/SchemaDiff", () => ({
  SchemaDiff: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return React.createElement("div", { "data-testid": "schemadiff" }, "SchemaDiff");
  },
}));

// ---- Mock storage so the ChartDashboardLazy saved-charts grid is controllable ----

const mockGetSavedCharts = mock(() => [] as SavedChartConfig[]);

mock.module("@/lib/storage", () => ({
  storage: {
    getSavedCharts: mockGetSavedCharts,
  },
}));

// ---- Now import bun:test, testing-library, and the component ----

import { describe, test, expect, afterEach, beforeAll } from "bun:test";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import React from "react";

import { BottomPanel } from "@/components/studio/BottomPanel";
import type { BottomPanelMode } from "@/components/studio/BottomPanel";
import type { SavedChartConfig } from "@/lib/types";

// =============================================================================
// BottomPanel Tests
// =============================================================================

function makeSavedChart(overrides: Partial<SavedChartConfig> = {}): SavedChartConfig {
  return {
    id: "chart-1",
    name: "Revenue Chart",
    chartType: "bar",
    xAxis: "month",
    yAxis: ["revenue"],
    createdAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function createDefaultProps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    mode: "results" as BottomPanelMode,
    onSetMode: mock(() => {}),
    currentTab: {
      id: "tab-1",
      name: "Query 1",
      query: "SELECT 1",
      result: null,
      isExecuting: false,
      type: "sql" as const,
    },
    schema: [],
    schemaContext: "[]",
    activeConnection: null,
    metadata: null,
    historyKey: 0,
    savedKey: 0,
    maskingEnabled: false,
    onToggleMasking: undefined,
    userRole: "admin",
    maskingConfig: {
      enabled: false,
      patterns: [],
      roleSettings: {
        admin: { canToggle: true, canReveal: true },
        user: { canToggle: false, canReveal: false },
      },
    },
    editingEnabled: false,
    pendingChanges: [],
    onCellChange: mock(() => {}),
    onApplyChanges: mock(() => {}),
    onDiscardChanges: mock(() => {}),
    onLoadQuery: mock(() => {}),
    onLoadMore: undefined,
    isLoadingMore: false,
    onExportResults: mock(() => {}),
    ...overrides,
  };
}

describe("BottomPanel", () => {
  /*
    The panel's heavy views are code-split (`React.lazy` in BottomPanel.tsx), so the
    FIRST render of each one suspends while its dynamic import resolves. `React.lazy`
    caches that resolution on the lazy component itself, so mounting each one once here
    — inside an awaited `act` — is what lets the assertions below stay synchronous and,
    more importantly, stay independent of the order the tests happen to run in.
  */
  beforeAll(async () => {
    for (const mode of ["charts", "pivot", "docs", "schemadiff", "explain"] as const) {
      const props = createDefaultProps({ mode });
      await act(async () => {
        render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
      });
    }
    cleanup();
  });

  afterEach(() => {
    cleanup();
  });

  test("renders tab buttons for all modes", () => {
    const props = createDefaultProps({
      metadata: { capabilities: { explainFormat: "postgres-json", supportsExplain: true } },
    });
    const { getByText, queryByText } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);

    const expectedLabels = ["Results", "Explain", "History", "Saved", "Charts", "Pivot", "Docs", "Diff", "Dashboard"];
    for (const label of expectedLabels) {
      const btn = getByText(label);
      expect(btn).not.toBeNull();
    }

    /*
      The ABSENCE is the assertion, and it is why this test names labels that should
      never appear again (#331 T2). Listing only what survives passes just as well when
      a removed tab is left behind or added back, which is the one thing this test is
      here to catch — the milestone's gate asks for the removal to be asserted rather
      than eyeballed. Found by review on #349.
    */
    for (const removed of ["NL2SQL", "Autopilot"]) {
      expect(queryByText(removed)).toBeNull();
    }
  });

  test("Explain tab is hidden when provider metadata lacks explainFormat", () => {
    const props = createDefaultProps(); // metadata: null
    const { queryByText } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
    expect(queryByText("Explain")).toBeNull();
  });

  test("Explain tab is visible when provider declares explainFormat", () => {
    const props = createDefaultProps({
      metadata: { capabilities: { explainFormat: "postgres-json", supportsExplain: true } },
    });
    const { getByText } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
    expect(getByText("Explain")).not.toBeNull();
  });

  test('Results tab is active by default when mode="results"', () => {
    const props = createDefaultProps({ mode: "results" });
    const { getByText } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);

    const resultsButton = getByText("Results").closest("button");
    expect(resultsButton).not.toBeNull();
    // Active tab should have the active class (text-blue-400 for results)
    expect(resultsButton!.className).toContain("text-blue-400");
  });

  test("shows empty state placeholder when currentTab.result is null", () => {
    const props = createDefaultProps({ mode: "results" });
    const { getByText } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);

    // The empty state shows "Execute a query or check history"
    const emptyText = getByText("Execute a query or check history");
    expect(emptyText).not.toBeNull();
  });

  test("tab click fires onSetMode with correct mode", () => {
    const onSetMode = mock(() => {});
    const props = createDefaultProps({ onSetMode });
    const { getByText } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);

    // Click the History tab
    const historyButton = getByText("History").closest("button");
    expect(historyButton).not.toBeNull();
    fireEvent.click(historyButton!);

    expect(onSetMode).toHaveBeenCalledTimes(1);
    expect(onSetMode).toHaveBeenCalledWith("history");
  });

  test('ResultsGrid renders when mode="results" and result exists', () => {
    const props = createDefaultProps({
      mode: "results",
      currentTab: {
        id: "tab-1",
        name: "Query 1",
        query: "SELECT 1",
        result: {
          rows: [{ id: 1, name: "test" }],
          fields: ["id", "name"],
          rowCount: 1,
          executionTime: 42,
        },
        isExecuting: false,
        type: "sql" as const,
      },
    });
    const { queryByTestId } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);

    const grid = queryByTestId("resultsgrid");
    expect(grid).not.toBeNull();
    expect(grid!.textContent).toBe("ResultsGrid");
  });

  test('History tab renders QueryHistory component when mode="history"', () => {
    const props = createDefaultProps({ mode: "history" });
    const { queryByTestId } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);

    const history = queryByTestId("queryhistory");
    expect(history).not.toBeNull();
    expect(history!.textContent).toContain("QueryHistory");
  });

  test('Saved tab renders SavedQueries when mode="saved"', () => {
    const props = createDefaultProps({ mode: "saved" });
    const { queryByTestId } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
    expect(queryByTestId("savedqueries")).not.toBeNull();
  });

  test('Charts tab renders DataCharts when mode="charts"', () => {
    const props = createDefaultProps({ mode: "charts" });
    const { queryByTestId } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
    expect(queryByTestId("datacharts")).not.toBeNull();
  });

  test('Pivot tab renders PivotTable when mode="pivot"', () => {
    const props = createDefaultProps({ mode: "pivot" });
    const { queryByTestId } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
    expect(queryByTestId("pivottable")).not.toBeNull();
  });

  test('Docs tab renders DatabaseDocs when mode="docs"', () => {
    const props = createDefaultProps({ mode: "docs" });
    const { queryByTestId } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
    expect(queryByTestId("databasedocs")).not.toBeNull();
  });

  test('Diff tab renders SchemaDiff when mode="schemadiff"', () => {
    const props = createDefaultProps({ mode: "schemadiff" });
    const { queryByTestId } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
    expect(queryByTestId("schemadiff")).not.toBeNull();
  });

  test('Explain tab renders VisualExplain when mode="explain" even with result=null (real explain-run shape)', () => {
    const props = createDefaultProps({
      mode: "explain",
      currentTab: {
        id: "tab-1",
        name: "Q",
        query: "SELECT 1",
        result: null, // executeQuery(isExplain=true) always nulls result (bug B1 regression guard)
        isExecuting: false,
        type: "sql" as const,
        explainPlan: [{ Plan: { "Node Type": "Seq Scan" } }],
      },
    });
    const { queryByTestId } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
    expect(queryByTestId("visualexplain")).not.toBeNull();
  });

  test("Export dropdown shows when results exist and mode is results", () => {
    const props = createDefaultProps({
      mode: "results",
      currentTab: {
        id: "tab-1",
        name: "Q",
        query: "SELECT 1",
        result: { rows: [{ id: 1 }], fields: ["id"], rowCount: 1, executionTime: 42 },
        isExecuting: false,
        type: "sql" as const,
      },
    });
    const { queryByText } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
    expect(queryByText("Export")).not.toBeNull();
  });

  // An export writes the rows the grid HOLDS, and the grid holds one page. The count
  // is on the button because a file of 500 rows off a table of two million is
  // indistinguishable from a complete answer once it has left the product.
  test("Export button carries the number of rows the file will contain", () => {
    const props = createDefaultProps({
      mode: "results",
      currentTab: {
        id: "tab-1",
        name: "Q",
        query: "SELECT 1",
        result: {
          rows: Array.from({ length: 1234 }, (_, i) => ({ id: i })),
          fields: ["id"],
          rowCount: 1234,
          executionTime: 42,
        },
        isExecuting: false,
        type: "sql" as const,
      },
    });
    const { getByTestId } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
    expect(getByTestId("export-row-count").textContent).toBe("1,234");
  });

  test("Export button counts the loaded rows, not the number the run reported", () => {
    const props = createDefaultProps({
      mode: "results",
      currentTab: {
        id: "tab-1",
        name: "Q",
        query: "SELECT 1",
        result: {
          rows: [{ id: 1 }, { id: 2 }],
          fields: ["id"],
          // An engine can report a different count than the rows it handed back;
          // only the rows are written to the file.
          rowCount: 900,
          executionTime: 42,
          pagination: { limit: 2, offset: 0, hasMore: true, totalReturned: 2, wasLimited: true },
        },
        isExecuting: false,
        type: "sql" as const,
      },
    });
    const { getByTestId } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
    expect(getByTestId("export-row-count").textContent).toBe("2");
  });

  test("Export dropdown is hidden when result is null", () => {
    const props = createDefaultProps({ mode: "results" });
    const { queryByText } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
    expect(queryByText("Export")).toBeNull();
  });

  test("Export dropdown is hidden when mode is not results", () => {
    const props = createDefaultProps({
      mode: "charts",
      currentTab: {
        id: "tab-1",
        name: "Q",
        query: "SELECT 1",
        result: { rows: [{ id: 1 }], fields: ["id"], rowCount: 1, executionTime: 42 },
        isExecuting: false,
        type: "sql" as const,
      },
    });
    const { queryByText } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
    expect(queryByText("Export")).toBeNull();
  });

  test("row count and execution time shown in results mode with data", () => {
    const props = createDefaultProps({
      mode: "results",
      currentTab: {
        id: "tab-1",
        name: "Q",
        query: "SELECT 1",
        result: { rows: [{ id: 1 }], fields: ["id"], rowCount: 5, executionTime: 123 },
        isExecuting: false,
        type: "sql" as const,
      },
    });
    const { queryByText } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
    expect(queryByText(/5 rows/)).not.toBeNull();
    expect(queryByText(/123ms/)).not.toBeNull();
  });

  test('Dashboard tab renders chart dashboard when mode="dashboard"', () => {
    const props = createDefaultProps({ mode: "dashboard" });
    const { queryByText } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
    // ChartDashboardLazy shows empty state with no saved charts
    expect(queryByText("No saved charts yet")).not.toBeNull();
  });

  test("clicking Charts tab fires onSetMode with charts", () => {
    const onSetMode = mock(() => {});
    const props = createDefaultProps({ onSetMode });
    const { getByText } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
    fireEvent.click(getByText("Charts").closest("button")!);
    expect(onSetMode).toHaveBeenCalledWith("charts");
  });

  test("clicking Pivot tab fires onSetMode with pivot", () => {
    const onSetMode = mock(() => {});
    const props = createDefaultProps({ onSetMode });
    const { getByText } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
    fireEvent.click(getByText("Pivot").closest("button")!);
    expect(onSetMode).toHaveBeenCalledWith("pivot");
  });

  test("clicking Diff tab fires onSetMode with schemadiff", () => {
    const onSetMode = mock(() => {});
    const props = createDefaultProps({ onSetMode });
    const { getByText } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
    fireEvent.click(getByText("Diff").closest("button")!);
    expect(onSetMode).toHaveBeenCalledWith("schemadiff");
  });

  test("clicking Docs tab fires onSetMode with docs", () => {
    const onSetMode = mock(() => {});
    const props = createDefaultProps({ onSetMode });
    const { getByText } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);
    fireEvent.click(getByText("Docs").closest("button")!);
    expect(onSetMode).toHaveBeenCalledWith("docs");
  });

  test("Dashboard renders saved chart cards with DataCharts when result exists", () => {
    mockGetSavedCharts.mockReturnValueOnce([
      makeSavedChart({ id: "chart-1", name: "Revenue", chartType: "bar", xAxis: "month", yAxis: ["revenue"] }),
    ]);
    const props = createDefaultProps({
      mode: "dashboard",
      currentTab: {
        id: "tab-1",
        name: "Query 1",
        query: "SELECT 1",
        result: { rows: [{ id: 1 }], fields: ["id"], rowCount: 1, executionTime: 10 },
        isExecuting: false,
        type: "sql" as const,
      },
    });
    const { getByText, queryByTestId } = render(
      <BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />,
    );

    expect(getByText("Revenue")).not.toBeNull();
    expect(getByText("bar")).not.toBeNull();
    expect(getByText(/X: month/)).not.toBeNull();
    expect(getByText(/Y: revenue/)).not.toBeNull();
    expect(queryByTestId("datacharts")).not.toBeNull();
  });

  test("Dashboard shows placeholder on saved chart card when result is null", () => {
    mockGetSavedCharts.mockReturnValueOnce([makeSavedChart()]);
    const props = createDefaultProps({ mode: "dashboard" });
    const { getByText, queryByTestId } = render(
      <BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />,
    );

    expect(getByText("Execute a query to see chart")).not.toBeNull();
    expect(queryByTestId("datacharts")).toBeNull();
  });

  /*
    One wrapper, three panels. Each of these modes hands the panel a callback that
    loads a statement into the editor and then switches the bottom panel back to
    results, and the three differ only in which panel raises it. Written as one
    parameterized test so that a fourth panel gaining the same wrapper is a row here
    rather than a fourth near-identical copy — `explain` below stays separate because
    it needs a tab carrying a result, which is a different fixture and not a row.
  */
  test.each<[string, string, string]>([
    ["pivot", "pivottable-load-btn", "SELECT 2"],
    ["history", "queryhistory-select-btn", "SELECT 3"],
    ["saved", "savedqueries-select-btn", "SELECT 4"],
  ])("%s load wrapper loads the query and switches to results mode", (mode, testId, expectedQuery) => {
    const onLoadQuery = mock(() => {});
    const onSetMode = mock(() => {});
    const props = createDefaultProps({ mode, onLoadQuery, onSetMode });
    const { getByTestId } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);

    fireEvent.click(getByTestId(testId));

    expect(onLoadQuery).toHaveBeenCalledWith(expectedQuery);
    expect(onSetMode).toHaveBeenCalledWith("results");
  });

  test("Explain onLoadQuery wrapper loads the query and switches to results mode", () => {
    const onLoadQuery = mock(() => {});
    const onSetMode = mock(() => {});
    const props = createDefaultProps({
      mode: "explain",
      onLoadQuery,
      onSetMode,
      currentTab: {
        id: "tab-1",
        name: "Q",
        query: "SELECT 1",
        result: { rows: [{ id: 1 }], fields: ["id"], rowCount: 1, executionTime: 10 },
        isExecuting: false,
        type: "sql" as const,
      },
    });
    const { getByTestId } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);

    fireEvent.click(getByTestId("visualexplain-load-btn"));

    expect(onLoadQuery).toHaveBeenCalledWith("SELECT 5");
    expect(onSetMode).toHaveBeenCalledWith("results");
  });

  /**
   * Agent artifact hydration (#329 T11).
   *
   * A run's result is an ordinary result, so it is rendered by the surfaces that
   * already render results — with a badge saying where it came from, and without the
   * affordances that would write it back. The tab's own result is never replaced;
   * dismissing the artifact leaves it exactly as it was.
   */
  describe("agent artifact hydration", () => {
    const TAB_RESULT = { rows: [{ id: 1 }], fields: ["id"], rowCount: 1, executionTime: 10 };
    const ARTIFACT_RESULT = {
      rows: [
        { id: 7, total: 70 },
        { id: 8, total: 80 },
      ],
      fields: ["id", "total"],
      rowCount: 2,
      executionTime: 4,
    };

    function hydratedProps(overrides: Record<string, unknown> = {}) {
      return createDefaultProps({
        mode: "results",
        currentTab: {
          id: "tab-1",
          name: "Q",
          query: "SELECT 1",
          result: TAB_RESULT,
          isExecuting: false,
          type: "sql" as const,
        },
        agentArtifact: {
          runId: "arun_1",
          correlationId: "corr_9",
          operationId: "sql.query.read",
          surface: "results",
          result: ARTIFACT_RESULT,
          explainPlan: null,
        },
        onDismissAgentArtifact: mock(() => {}),
        ...overrides,
      });
    }

    test("the grid renders the run's rows behind a badge naming the run it came from", () => {
      const props = hydratedProps();
      const { getByTestId } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);

      const badge = getByTestId("agent-provenance");
      expect(badge.textContent).toContain("arun_1");
      expect(badge.textContent).toContain("sql.query.read");
      // The audit correlation id, so what is on screen can be joined to the audit
      // line for the statement that produced it.
      expect(badge.textContent).toContain("corr_9");
      expect(getByTestId("resultsgrid")).toBeTruthy();
      expect(capturedResultsGridProps.result).toEqual(ARTIFACT_RESULT);
    });

    test("a hydrated result is read-only: nothing offers to edit it or export it as the tab's own", () => {
      const props = hydratedProps({ editingEnabled: true });
      const { queryByText } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);

      expect(capturedResultsGridProps.editingEnabled).toBe(false);
      expect(capturedResultsGridProps.onLoadMore).toBeUndefined();
      expect(queryByText("Export")).toBeNull();
    });

    test("dismissing it is a user action, and the tab's own result is what returns", () => {
      const onDismissAgentArtifact = mock(() => {});
      const props = hydratedProps({ onDismissAgentArtifact });
      const { getByTestId, rerender } = render(
        <BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />,
      );

      fireEvent.click(getByTestId("agent-provenance-dismiss"));
      expect(onDismissAgentArtifact).toHaveBeenCalled();

      const cleared = hydratedProps({ agentArtifact: null });
      rerender(<BottomPanel {...(cleared as React.ComponentProps<typeof BottomPanel>)} />);
      expect(capturedResultsGridProps.result).toEqual(TAB_RESULT);
    });

    test("a plan artifact hydrates the explain view rather than the grid", () => {
      const props = hydratedProps({
        mode: "explain",
        metadata: { capabilities: { explainFormat: "postgres-json", supportsExplain: true } },
        agentArtifact: {
          runId: "arun_1",
          correlationId: "corr_plan",
          operationId: "sql.explain.estimate",
          surface: "explain",
          result: ARTIFACT_RESULT,
          explainPlan: { format: "postgres-json", raw: [{ Plan: { "Node Type": "Seq Scan" } }] },
        },
      });
      const { getByTestId } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);

      expect(getByTestId("agent-provenance").textContent).toContain("sql.explain.estimate");
      expect(capturedVisualExplainProps.plan).toEqual({
        kind: "postgres-json",
        plan: [{ Plan: { "Node Type": "Seq Scan" } }],
      });
      // The plan came from the run, so the editor's statement is NOT sent with it:
      // the explain view's AI analysis posts query + plan together, and pairing them
      // would attribute a run's plan to a statement that never produced it.
      expect(capturedVisualExplainProps.query).toBeUndefined();
    });

    test("a hydrated grid leaves the explain view's own statement alone", () => {
      const props = hydratedProps({
        mode: "explain",
        metadata: { capabilities: { explainFormat: "postgres-json", supportsExplain: true } },
      });
      render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);

      expect(capturedVisualExplainProps.query).toBe("SELECT 1");
    });

    test("an answer composed as a chart is drawn from the run's rows, as the run said to draw it", () => {
      const spec = { type: "bar", x: "id", y: ["total"], caption: "Total by id." };
      const props = hydratedProps({
        mode: "charts",
        agentArtifact: {
          runId: "arun_1",
          correlationId: "corr_answer",
          operationId: "sql.query.read",
          surface: "charts",
          result: ARTIFACT_RESULT,
          explainPlan: null,
          chartSpec: spec,
        },
      });
      const { getByTestId } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);

      // The same provenance the grid carries: these rows came from a run, not from
      // the statement in the editor above them.
      expect(getByTestId("agent-provenance").textContent).toContain("arun_1");
      expect(capturedDataChartsProps.result).toEqual(ARTIFACT_RESULT);
      expect(capturedDataChartsProps.spec).toEqual(spec);
    });

    test("a hydrated result reaches only the surface it was hydrated into", () => {
      // A result hydrated into the grid is not charted behind the user's back: the
      // charts view keeps showing the tab's own result, with no specification.
      const props = hydratedProps({ mode: "charts" });
      const { queryByTestId } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);

      expect(queryByTestId("agent-provenance")).toBeNull();
      expect(queryByTestId("datacharts")).toBeTruthy();
      expect(capturedDataChartsProps.result).toEqual(TAB_RESULT);
      expect(capturedDataChartsProps.spec).toBeNull();
    });

    test("without an artifact nothing about the panel changes", () => {
      const props = hydratedProps({ agentArtifact: null });
      const { queryByTestId } = render(<BottomPanel {...(props as React.ComponentProps<typeof BottomPanel>)} />);

      expect(queryByTestId("agent-provenance")).toBeNull();
      expect(capturedResultsGridProps.result).toEqual(TAB_RESULT);
    });
  });
});
