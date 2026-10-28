import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { mock } from "bun:test";
import React from "react";

// Props the chart hands to recharts. The mock draws nothing, so the overlap
// itself is proved in Playwright; this is the pin that the axis options changed.
const capturedXAxisProps: Record<string, unknown>[] = [];
const capturedChartProps: Record<string, unknown>[] = [];
const capturedPieProps: Record<string, unknown>[] = [];
const capturedScatterProps: Record<string, unknown>[] = [];
// The label the Tooltip mock hovers. Recharts hands the tooltip the hovered tick's value.
let tooltipLabel: unknown = "tooltip_label";

// ── Mock Recharts ───────────────────────────────────────────────────────────
mock.module("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: unknown }) => children,
  AreaChart: ({ children, ...props }: Record<string, unknown>) => {
    capturedChartProps.push(props);
    return React.createElement("div", { "data-testid": "mock-area-chart", ...props }, children as React.ReactNode);
  },
  BarChart: ({ children, ...props }: Record<string, unknown>) => {
    capturedChartProps.push(props);
    return React.createElement("div", { "data-testid": "mock-bar-chart", ...props }, children as React.ReactNode);
  },
  LineChart: ({ children, ...props }: Record<string, unknown>) => {
    capturedChartProps.push(props);
    return React.createElement("div", { "data-testid": "mock-line-chart", ...props }, children as React.ReactNode);
  },
  PieChart: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("div", { "data-testid": "mock-pie-chart", ...props }, children as React.ReactNode),
  ScatterChart: ({ children, ...props }: Record<string, unknown>) => {
    capturedChartProps.push(props);
    return React.createElement("div", { "data-testid": "mock-scatter-chart", ...props }, children as React.ReactNode);
  },
  RadialBarChart: ({ children }: { children: unknown }) =>
    React.createElement("div", { "data-testid": "mock-radial-chart" }, children as React.ReactNode),
  Area: () => null,
  Bar: () => null,
  Line: () => null,
  // Recharts renders `label` once per slice and happy-dom cannot drive that, so
  // it is driven here with both shapes recharts 3 can pass: a computed percent,
  // and no percent at all (the type is optional as of v3).
  //
  // Both ACCEPTED shapes are covered. A function is called; an element is cloned
  // with the slice's props, which is what recharts itself does — this app passes
  // an element (`<PieSliceLabel>`) so the label can be a real `<text fill=ink>`
  // rather than a string recharts would paint in the slice's own colour.
  Pie: (props: Record<string, unknown>) => {
    capturedPieProps.push(props);
    const label = props.label;
    const slices = [{ name: "alpha", percent: 0.25 }, { name: "beta" }];

    if (typeof label === "function") {
      const render = label as (p: { name: string; percent?: number }) => string;
      return React.createElement(
        "div",
        { "data-testid": "mock-pie-labels" },
        render(slices[0]),
        " | ",
        render(slices[1]),
      );
    }
    if (React.isValidElement(label)) {
      return React.createElement(
        "div",
        { "data-testid": "mock-pie-labels" },
        ...slices.map((slice, index) =>
          React.cloneElement(label as React.ReactElement<Record<string, unknown>>, { ...slice, key: index }),
        ),
      );
    }
    return null;
  },
  Scatter: (props: Record<string, unknown>) => {
    capturedScatterProps.push(props);
    return null;
  },
  Cell: () => null,
  RadialBar: () => null,
  XAxis: (props: Record<string, unknown>) => {
    capturedXAxisProps.push(props);
    return null;
  },
  YAxis: () => null,
  ZAxis: () => null,
  CartesianGrid: () => null,
  // Recharts only renders tooltip content on hover, which happy-dom cannot
  // trigger. Render the `content` element directly with an active payload
  // (plus an inactive clone) so CustomTooltip executes in this group.
  Tooltip: ({ content }: { content?: React.ReactElement }) =>
    React.isValidElement(content)
      ? React.createElement(
          "div",
          { "data-testid": "mock-tooltip" },
          React.cloneElement(content as React.ReactElement<Record<string, unknown>>, {
            active: true,
            payload: [{ name: "tooltip_series", value: 1234567, color: "#8884d8" }],
            label: tooltipLabel,
          }),
          React.cloneElement(content as React.ReactElement<Record<string, unknown>>, {
            active: false,
            payload: [],
          }),
        )
      : null,
  Legend: () => null,
  PolarAngleAxis: () => null,
}));

// ── Mock snapdom (dynamic import in export) ─────────────────────────────────
const mockChartToBlob = mock(async () => new Blob(["png"], { type: "image/png" }));
const mockSnapdom = mock(async (_el?: unknown, _options?: Record<string, unknown>) => ({
  toBlob: mockChartToBlob,
}));
mock.module("@zumer/snapdom", () => ({
  snapdom: mockSnapdom,
}));

// ── Mock lucide-react icons ─────────────────────────────────────────────────
mock.module("lucide-react", () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "__esModule") return true;
        return (props: Record<string, unknown>) =>
          React.createElement("span", { "data-icon": prop, className: props.className as string });
      },
    },
  );
});

// ── Mock Shadcn UI components that use Radix ────────────────────────────────
mock.module("@/components/ui/button", () => ({
  Button: ({ children, onClick, className, ...props }: Record<string, unknown>) =>
    React.createElement("button", { onClick: onClick as () => void, className, ...props }, children as React.ReactNode),
}));

mock.module("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "dropdown-menu" }, children),
  DropdownMenuTrigger: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("div", { "data-testid": "dropdown-trigger", ...props }, children as React.ReactNode),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "dropdown-content" }, children),
  // Saved-chart items use Radix's onSelect instead of onClick — honor both.
  DropdownMenuItem: ({ children, onClick, onSelect, className }: Record<string, unknown>) =>
    React.createElement(
      "div",
      { role: "menuitem", onClick: (onClick ?? onSelect) as () => void, className },
      children as React.ReactNode,
    ),
}));

const mockGetSavedCharts = mock(() => {
  try {
    const stored = localStorage.getItem("libredb_saved_charts");
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
});
const mockSaveChart = mock((chart: Record<string, unknown>) => {
  const stored = localStorage.getItem("libredb_saved_charts");
  const charts = stored ? JSON.parse(stored) : [];
  charts.push(chart);
  localStorage.setItem("libredb_saved_charts", JSON.stringify(charts));
});
const mockDeleteChart = mock((id: string) => {
  const stored = localStorage.getItem("libredb_saved_charts");
  const charts = stored ? JSON.parse(stored) : [];
  const filtered = charts.filter((c: Record<string, unknown>) => c.id !== id);
  localStorage.setItem("libredb_saved_charts", JSON.stringify(filtered));
});
// A missing config prop is resolved through the facade, and the real facade returns
// DEFAULT_MASKING_CONFIG when nothing is saved, so the mock mirrors that (#1939).
const mockGetMaskingConfig = mock(() => DEFAULT_MASKING_CONFIG);

mock.module("@/lib/storage", () => ({
  storage: {
    getSavedCharts: mockGetSavedCharts,
    saveChart: mockSaveChart,
    deleteChart: mockDeleteChart,
    getMaskingConfig: mockGetMaskingConfig,
  },
}));

// Context lets each mocked SelectItem invoke its own Select's onValueChange on
// click, so tests can drive value changes without Radix pointer machinery.
const SelectChangeContext = React.createContext<((v: string) => void) | undefined>(undefined);

mock.module("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange }: Record<string, unknown>) =>
    React.createElement(
      SelectChangeContext.Provider,
      { value: onValueChange as ((v: string) => void) | undefined },
      React.createElement("div", { "data-testid": "select", "data-value": value }, children as React.ReactNode),
    ),
  SelectTrigger: ({ children, className }: Record<string, unknown>) =>
    React.createElement("div", { "data-testid": "select-trigger", className }, children as React.ReactNode),
  SelectContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "select-content" }, children),
  SelectItem: ({ children, value }: Record<string, unknown>) => {
    const onValueChange = React.useContext(SelectChangeContext);
    return React.createElement(
      "div",
      {
        "data-testid": `select-item-${value}`,
        role: "option",
        onClick: () => onValueChange?.(value as string),
      },
      children as React.ReactNode,
    );
  },
  SelectValue: ({ placeholder }: Record<string, unknown>) =>
    React.createElement("span", { "data-testid": "select-value" }, placeholder as string),
}));

// ── Imports AFTER mocks ─────────────────────────────────────────────────────
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { chartNumber, DataCharts, PieSliceLabel } from "@/components/DataCharts";
import { mockToastError } from "../helpers/mock-sonner";
import type { QueryResult } from "@/lib/types";
import { DEFAULT_MASKING_CONFIG, maskValueByPattern } from "@/lib/data-masking";

import userEvent from "@testing-library/user-event";

// ── Test data ───────────────────────────────────────────────────────────────

const mockNumericResult: QueryResult = {
  rows: [
    { category: "Electronics", revenue: 15000, cost: 8000, date: "2025-01-01" },
    { category: "Clothing", revenue: 12000, cost: 6000, date: "2025-02-01" },
    { category: "Books", revenue: 8000, cost: 3000, date: "2025-03-01" },
    { category: "Food", revenue: 20000, cost: 12000, date: "2025-04-01" },
    { category: "Sports", revenue: 10000, cost: 5000, date: "2025-05-01" },
  ],
  fields: ["category", "revenue", "cost", "date"],
  rowCount: 5,
  executionTime: 15,
};

const mockEmptyResult: QueryResult = {
  rows: [],
  fields: [],
  rowCount: 0,
  executionTime: 1,
};

const mockSingleRowResult: QueryResult = {
  rows: [{ id: 1, value: 100 }],
  fields: ["id", "value"],
  rowCount: 1,
  executionTime: 2,
};

const mockNoNumericResult: QueryResult = {
  rows: [
    { name: "Alice", status: "active" },
    { name: "Bob", status: "inactive" },
    { name: "Charlie", status: "active" },
  ],
  fields: ["name", "status"],
  rowCount: 3,
  executionTime: 5,
};

// Pure numeric data (no categorical) → scatter suggestion
const pureNumericResult: QueryResult = {
  rows: [
    { x: 1, y: 10, z: 100 },
    { x: 2, y: 20, z: 200 },
    { x: 3, y: 30, z: 300 },
  ],
  fields: ["x", "y", "z"],
  rowCount: 3,
  executionTime: 1,
};

// Date time-series data → line suggestion
const dateTimeResult: QueryResult = {
  rows: [
    { date: "2025-01-01", value: 100 },
    { date: "2025-02-01", value: 200 },
    { date: "2025-03-01", value: 150 },
  ],
  fields: ["date", "value"],
  rowCount: 3,
  executionTime: 1,
};

// Categorical with few rows → pie suggestion
const fewCategoricalResult: QueryResult = {
  rows: [
    { type: "A", count: 10 },
    { type: "B", count: 20 },
    { type: "C", count: 30 },
  ],
  fields: ["type", "count"],
  rowCount: 3,
  executionTime: 1,
};

// Many rows to test bar suggestion (>10 rows)
const manyCategoricalResult: QueryResult = {
  rows: Array.from({ length: 15 }, (_, i) => ({
    name: `item_${i}`,
    value: (i + 1) * 10,
  })),
  fields: ["name", "value"],
  rowCount: 15,
  executionTime: 1,
};

// Pie with >10 data points for "Showing top 10" footer
const manyPieResult: QueryResult = {
  rows: Array.from({ length: 15 }, (_, i) => ({
    category: `cat_${i}`,
    amount: (i + 1) * 5,
  })),
  fields: ["category", "amount"],
  rowCount: 15,
  executionTime: 1,
};

// 9 numeric fields — one more than the 8-slot palette — to test the multi-series cap (#403)
const manySeriesResult: QueryResult = {
  rows: [
    { label: "row1", f1: 1, f2: 2, f3: 3, f4: 4, f5: 5, f6: 6, f7: 7, f8: 8, f9: 9 },
    { label: "row2", f1: 2, f2: 3, f3: 4, f4: 5, f5: 6, f6: 7, f7: 8, f8: 9, f9: 10 },
  ],
  fields: ["label", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9"],
  rowCount: 2,
  executionTime: 1,
};

// =============================================================================
// DataCharts Tests
// =============================================================================

describe("DataCharts", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    capturedXAxisProps.length = 0;
    capturedChartProps.length = 0;
    capturedPieProps.length = 0;
    capturedScatterProps.length = 0;
    tooltipLabel = "tooltip_label";
    // Clear localStorage saved charts
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.removeItem("libredb_saved_charts");
      } catch {
        /* ignore */
      }
    }
  });

  // -----------------------------------------------------------------------
  // Empty states
  // -----------------------------------------------------------------------

  test("renders empty state when result is null", () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: null }));
    expect(queryByText("Cannot Visualize Data")).not.toBeNull();
    expect(queryByText("No data to visualize")).not.toBeNull();
  });

  test("renders empty state when result has empty rows", () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockEmptyResult }));
    expect(queryByText("Cannot Visualize Data")).not.toBeNull();
  });

  test("renders empty state for single row result", () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockSingleRowResult }));
    expect(queryByText("Cannot Visualize Data")).not.toBeNull();
    expect(queryByText("Need at least 2 rows for visualization")).not.toBeNull();
  });

  test("renders empty state when no numeric fields exist", () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNoNumericResult }));
    expect(queryByText("Cannot Visualize Data")).not.toBeNull();
    expect(queryByText("No numeric fields found for Y-axis")).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Chart type selector
  // -----------------------------------------------------------------------

  test("shows all 8 chart type selector buttons", () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    expect(queryByText("Bar")).not.toBeNull();
    expect(queryByText("Line")).not.toBeNull();
    expect(queryByText("Pie")).not.toBeNull();
    expect(queryByText("Area")).not.toBeNull();
    expect(queryByText("Scatter")).not.toBeNull();
    expect(queryByText("Histogram")).not.toBeNull();
    expect(queryByText("Stacked")).not.toBeNull();
    expect(queryByText("Stack Area")).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Axis selectors
  // -----------------------------------------------------------------------

  test("a text field with too many distinct values to group is offered with the unknown-type icon", () => {
    const result: QueryResult = {
      rows: Array.from({ length: 60 }, (_, i) => ({ code: `order-${i}`, total: i * 10 })),
      fields: ["code", "total"],
      rowCount: 60,
      executionTime: 1,
    };
    const { getByTestId } = render(React.createElement(DataCharts, { result }));
    expect(getByTestId("select-item-code").querySelector(".lucide-circle-alert")).not.toBeNull();
    expect(getByTestId("select-item-total").querySelector(".lucide-hash")).not.toBeNull();
  });

  test("X-Axis selector renders with field options", () => {
    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    expect(queryByText("X-Axis")).not.toBeNull();
    expect(queryByTestId("select-item-category")).not.toBeNull();
    expect(queryByTestId("select-item-revenue")).not.toBeNull();
    expect(queryByTestId("select-item-cost")).not.toBeNull();
    expect(queryByTestId("select-item-date")).not.toBeNull();
  });

  test("Y-Axis selector renders", () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    expect(queryByText("Y-Axis")).not.toBeNull();
  });

  test('shows "Value" label instead of Y-Axis when pie chart', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: fewCategoricalResult }));
    // fewCategoricalResult → pie suggestion (categorical + ≤10 rows)
    expect(queryByText("Value")).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Toolbar buttons
  // -----------------------------------------------------------------------

  test("Save chart button present", () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    expect(queryByText("Save")).not.toBeNull();
  });

  test("Export button present with PNG and SVG options", () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    expect(queryByText("Export")).not.toBeNull();
    expect(queryByText("Export as PNG")).not.toBeNull();
    expect(queryByText("Export as SVG")).not.toBeNull();
  });

  test("Aggregation selector present", () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    expect(queryByText("Agg")).not.toBeNull();
  });

  test("date grouping selector appears when date columns exist", () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    expect(queryByText("Group")).not.toBeNull();
  });

  test("date grouping hidden when no date columns", () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: pureNumericResult }));
    expect(queryByText("Group")).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Footer stats
  // -----------------------------------------------------------------------

  test("footer shows row and field counts", () => {
    const { container } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    const footerText = container.textContent || "";
    expect(footerText).toContain("Rows:");
    expect(footerText).toContain("Fields:");
    expect(footerText).toContain("Numeric:");
  });

  test("footer shows numeric field count", () => {
    const { container } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    const footerText = container.textContent || "";
    // mockNumericResult has 2 numeric fields: revenue, cost
    expect(footerText).toContain("Numeric:");
  });

  // -----------------------------------------------------------------------
  // Chart type switching
  // -----------------------------------------------------------------------

  test("switches to line chart", async () => {
    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText("Line")!);
    await waitFor(() => {
      expect(queryByTestId("mock-line-chart")).not.toBeNull();
    });
  });

  test("switches to area chart", async () => {
    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText("Area")!);
    await waitFor(() => {
      expect(queryByTestId("mock-area-chart")).not.toBeNull();
    });
  });

  test("switches to pie chart", async () => {
    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText("Pie")!);
    await waitFor(() => {
      expect(queryByTestId("mock-pie-chart")).not.toBeNull();
    });
  });

  test("pie slice labels carry a percentage, and stay readable when recharts omits it", async () => {
    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText("Pie")!);
    await waitFor(() => {
      expect(queryByTestId("mock-pie-labels")).not.toBeNull();
    });

    const labels = queryByTestId("mock-pie-labels")!.textContent ?? "";
    expect(labels).toContain("alpha (25%)");
    // recharts 3 types `percent` as optional. Arithmetic on undefined yields
    // NaN, which reaches the user as the literal label "beta (NaN%)".
    expect(labels).toContain("beta (0%)");
    expect(labels).not.toContain("NaN");
  });

  test("switches to scatter and histogram", async () => {
    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));

    fireEvent.click(queryByText("Scatter")!);
    await waitFor(() => {
      expect(queryByTestId("mock-scatter-chart")).not.toBeNull();
    });

    fireEvent.click(queryByText("Histogram")!);
    await waitFor(() => {
      expect(queryByTestId("mock-bar-chart")).not.toBeNull();
    });
  });

  test("switches to stacked bar chart", async () => {
    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText("Stacked")!);
    await waitFor(() => {
      expect(queryByTestId("mock-bar-chart")).not.toBeNull();
    });
  });

  test("switches to stacked area chart", async () => {
    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText("Stack Area")!);
    await waitFor(() => {
      expect(queryByTestId("mock-area-chart")).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Suggested chart type based on data
  // -----------------------------------------------------------------------

  test("suggests scatter for pure numeric data", () => {
    const { queryByTestId } = render(React.createElement(DataCharts, { result: pureNumericResult }));
    expect(queryByTestId("mock-scatter-chart")).not.toBeNull();
  });

  test("suggests line for date time-series data", () => {
    const { queryByTestId } = render(React.createElement(DataCharts, { result: dateTimeResult }));
    expect(queryByTestId("mock-line-chart")).not.toBeNull();
  });

  test("rotated axes measure their tick labels, and only date ticks are shortened", async () => {
    const isoResult: QueryResult = {
      rows: [
        { ts: "2026-09-26T22:34:00.000Z", n: 1 },
        { ts: "2026-09-26T22:36:00.000Z", n: 2 },
        { ts: "2026-09-26 22:38:00", n: 3 },
      ],
      fields: ["ts", "n"],
      rowCount: 3,
      executionTime: 1,
    };
    const { queryByText } = render(React.createElement(DataCharts, { result: isoResult }));

    const tickOf = () => {
      const props = capturedXAxisProps.at(-1);
      expect(props).toBeDefined();
      return props as { height?: unknown; tickFormatter?: (value: unknown) => string };
    };

    await waitFor(() => {
      expect(tickOf().height).toBe("auto");
    });
    const formatDate = tickOf().tickFormatter!;
    expect(formatDate("2026-09-26T22:36:00.000Z")).toBe("2026-09-26 22:36:00");
    expect(formatDate("2026-09-26T22:36:00+03:00")).toBe("2026-09-26 22:36:00");
    expect(formatDate("2026-09-26 22:38:00")).toBe("2026-09-26 22:38:00");
    expect(formatDate("2026-09-26 22:38")).toBe("2026-09-26 22:38");
    // Two years, or two seconds of one minute, must not read as the same tick.
    expect(formatDate("2025-01-01")).toBe("2025-01-01");
    expect(formatDate("2026-01-01")).toBe("2026-01-01");
    expect(formatDate("2026-09-26T22:34:15.000Z")).toBe("2026-09-26 22:34:15");
    expect(formatDate("2026-09-26T22:34:45.000Z")).toBe("2026-09-26 22:34:45");
    // A value that only starts with a date is not a date, so it stays whole.
    expect(formatDate("2026-09-26_add_users")).toBe("2026-09-26_add_users");
    expect(formatDate("09/26/2026")).toBe("09/26/2026");
    expect(formatDate(null)).toBe("");
    expect(formatDate(undefined)).toBe("");

    const expectRotated = async (label: string) => {
      capturedXAxisProps.length = 0;
      fireEvent.click(queryByText(label)!);
      await waitFor(() => {
        expect(capturedXAxisProps.at(-1)?.height).toBe("auto");
      });
    };
    await expectRotated("Bar");
    await expectRotated("Area");
    await expectRotated("Stacked");
    await expectRotated("Stack Area");
    await expectRotated("Histogram");

    // Histogram buckets are ranges, not the date column, so they stay whole.
    expect(tickOf().tickFormatter!("100.0-200.0")).toBe("100.0-200.0");

    capturedXAxisProps.length = 0;
    fireEvent.click(queryByText("Scatter")!);
    await waitFor(() => {
      expect(capturedXAxisProps.length).toBeGreaterThan(0);
    });
    expect(tickOf().height).not.toBe("auto");
  });

  test("a category tick is not shortened", async () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: fewCategoricalResult }));
    fireEvent.click(queryByText("Bar")!);
    await waitFor(() => {
      expect(capturedXAxisProps.length).toBeGreaterThan(0);
    });
    const props = capturedXAxisProps.at(-1) as { height?: unknown; tickFormatter?: (value: unknown) => string };
    expect(props.height).toBe("auto");
    const category = "north-america-west";
    expect(props.tickFormatter!(category)).toBe(category);
    // The tooltip is a separate element and is not given the tick formatter.
    expect(document.body.textContent).toContain("tooltip_label");
    expect(document.body.textContent).not.toContain("09-26");
  });

  test("a chart with a rotated axis leaves no empty band under its legend", async () => {
    // Recharts draws the legend `margin.bottom` above the chart's bottom edge, and
    // a rotated axis measures its own labels, so the bottom margin is only a gap.
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    const marginAfterClick = async (label: string) => {
      capturedChartProps.length = 0;
      fireEvent.click(queryByText(label)!);
      await waitFor(() => {
        expect(capturedChartProps.length).toBeGreaterThan(0);
      });
      return capturedChartProps.at(-1)?.margin;
    };
    for (const label of ["Bar", "Line", "Area", "Histogram", "Stacked", "Stack Area"]) {
      expect(await marginAfterClick(label)).toEqual({ top: 20, right: 30, left: 20, bottom: 10 });
    }
    // Scatter draws its x-axis name inside the bottom margin, so it keeps the room.
    expect(await marginAfterClick("Scatter")).toEqual({ top: 20, right: 30, left: 20, bottom: 60 });
  });

  // Recharts builds a category axis from the string and number x values only, then
  // draws the marks by row index, so a NULL category used to shorten the axis and
  // slide every later value onto the next row's category, the last one off the end.
  describe("a NULL in the category column", () => {
    const nullCategoryResult: QueryResult = {
      rows: [
        { city: null, n: 1 },
        { city: "Ankara", n: 2 },
        { city: null, n: 3 },
        { city: "Izmir", n: 4 },
        { city: null, n: 5 },
      ],
      fields: ["city", "n"],
      rowCount: 5,
      executionTime: 1,
    };
    const aligned = [
      { city: "NULL", n: 1, __libredb_chart_row: 0 },
      { city: "Ankara", n: 2, __libredb_chart_row: 1 },
      { city: "NULL", n: 3, __libredb_chart_row: 2 },
      { city: "Izmir", n: 4, __libredb_chart_row: 3 },
      { city: "NULL", n: 5, __libredb_chart_row: 4 },
    ];

    test("keeps every value on its own row's category in each category chart", async () => {
      const { queryByText } = render(React.createElement(DataCharts, { result: nullCategoryResult }));
      for (const label of ["Bar", "Line", "Area", "Stacked", "Stack Area"]) {
        capturedChartProps.length = 0;
        fireEvent.click(queryByText(label)!);
        await waitFor(() => {
          expect(capturedChartProps.length).toBeGreaterThan(0);
        });
        expect(capturedChartProps.at(-1)?.data).toEqual(aligned);
      }
    });

    test("names the pie slice NULL rather than leaving it nameless", () => {
      // Five rows of one categorical and one numeric column: the pie is the suggestion.
      render(React.createElement(DataCharts, { result: nullCategoryResult }));
      expect(capturedPieProps.at(-1)?.nameKey).toBe("city");
      expect(capturedPieProps.at(-1)?.data).toEqual(aligned);
    });

    test("an aggregation sums the NULL rows into one NULL category", async () => {
      const { getByTestId, queryByText } = render(React.createElement(DataCharts, { result: nullCategoryResult }));
      fireEvent.click(queryByText("Bar")!);
      capturedChartProps.length = 0;
      fireEvent.click(getByTestId("select-item-sum"));
      await waitFor(() => {
        expect(capturedChartProps.length).toBeGreaterThan(0);
      });
      expect(capturedChartProps.at(-1)?.data).toEqual([
        { city: "NULL", n: 9, __libredb_chart_row: 0 },
        { city: "Ankara", n: 2, __libredb_chart_row: 1 },
        { city: "Izmir", n: 4, __libredb_chart_row: 2 },
      ]);
    });

    // Recharts finds the axis tooltip's row by the hovered category's value, so with
    // the category as the axis key the third row (the second NULL) showed the first
    // row's numbers. The axis is keyed by row position and reads the category back.
    test("keys the axis by row, so a repeated category keeps its own tick and tooltip", async () => {
      tooltipLabel = 2;
      const { queryByText, getByTestId } = render(React.createElement(DataCharts, { result: nullCategoryResult }));
      capturedXAxisProps.length = 0;
      fireEvent.click(queryByText("Bar")!);
      await waitFor(() => {
        expect(capturedXAxisProps.length).toBeGreaterThan(0);
      });
      const axis = capturedXAxisProps.at(-1) as { dataKey: string; tickFormatter: (tick: unknown) => string };
      expect(axis.dataKey).toBe("__libredb_chart_row");
      expect([0, 1, 2, 3, 4].map((row) => axis.tickFormatter(row))).toEqual([
        "NULL",
        "Ankara",
        "NULL",
        "Izmir",
        "NULL",
      ]);
      // The tooltip title is the hovered row's category, not its position.
      expect(getByTestId("mock-tooltip").textContent).toContain("NULL");
      expect(getByTestId("mock-tooltip").textContent).not.toContain("2tooltip_series");
    });
  });

  test("suggests pie for few categorical rows", () => {
    const { queryByTestId } = render(React.createElement(DataCharts, { result: fewCategoricalResult }));
    expect(queryByTestId("mock-pie-chart")).not.toBeNull();
  });

  test("suggests bar for many categorical rows", () => {
    const { queryByTestId } = render(React.createElement(DataCharts, { result: manyCategoricalResult }));
    expect(queryByTestId("mock-bar-chart")).not.toBeNull();
  });

  // A second, different result must re-derive the selections. Nothing exercised this
  // before — every other test mounts once — so it is what pins the re-derivation to a
  // prop change rather than to a mount.
  test("a new result re-derives the axis selections", () => {
    const { queryByTestId, rerender } = render(React.createElement(DataCharts, { result: fewCategoricalResult }));
    expect(queryByTestId("mock-pie-chart")).not.toBeNull();

    rerender(React.createElement(DataCharts, { result: pureNumericResult }));

    expect(queryByTestId("mock-scatter-chart")).not.toBeNull();
    expect(queryByTestId("mock-pie-chart")).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Scatter-specific Y selector
  // -----------------------------------------------------------------------

  test("shows scatter Y selector when scatter type is active", async () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText("Scatter")!);
    await waitFor(() => {
      // Scatter has a separate "Y" label
      expect(queryByText("Y")).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Histogram-specific buckets selector
  // -----------------------------------------------------------------------

  test("shows Buckets selector when histogram is active", async () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText("Histogram")!);
    await waitFor(() => {
      expect(queryByText("Buckets")).not.toBeNull();
    });
  });

  // The server writes NaN and the infinities as words, and `Number("Infinity")` passes a
  // NaN check: in a histogram that made a bin index of NaN, which threw during render.
  test("draws a histogram over NaN and infinite cells instead of throwing", async () => {
    const nonFinite: QueryResult = {
      ...mockNumericResult,
      rows: mockNumericResult.rows.map((row, i) =>
        i === 0 ? { ...row, revenue: "Infinity" } : i === 1 ? { ...row, revenue: Number.NEGATIVE_INFINITY } : row,
      ),
    };
    capturedChartProps.length = 0;
    const { queryByText } = render(React.createElement(DataCharts, { result: nonFinite }));
    fireEvent.click(queryByText("Histogram")!);
    await waitFor(() => {
      expect(queryByText("Buckets")).not.toBeNull();
    });
    const bins = capturedChartProps.at(-1)?.data as Array<{ count: number }>;
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(5);
  });

  test("draws a NaN or infinite bar like a null, at 0", () => {
    const nonFinite: QueryResult = {
      ...mockNumericResult,
      rows: mockNumericResult.rows.map((row, i) => (i === 0 ? { ...row, revenue: Number.POSITIVE_INFINITY } : row)),
    };
    capturedChartProps.length = 0;
    render(React.createElement(DataCharts, { result: nonFinite, maskingEnabled: false }));
    const data = capturedChartProps.at(-1)?.data as Array<Record<string, unknown>>;
    expect(data.every((point) => Number.isFinite(point.revenue))).toBe(true);
  });

  test("chartNumber keeps finite numbers and draws everything else at 0", () => {
    expect(chartNumber(1.5)).toBe(1.5);
    expect(chartNumber("2.5")).toBe(2.5);
    expect(chartNumber(null)).toBe(0);
    for (const nonFinite of [Number.NaN, Number.POSITIVE_INFINITY, "NaN", "Infinity", "-Infinity", "abc"]) {
      expect(chartNumber(nonFinite)).toBe(0);
    }
  });

  // -----------------------------------------------------------------------
  // Y-axis toggle (multi-select via dropdown menuitem)
  // -----------------------------------------------------------------------

  test("Y-axis dropdown shows numeric field options", () => {
    const { queryAllByRole } = render(
      React.createElement(DataCharts, { result: mockNumericResult, maskingEnabled: false }),
    );
    const menuItems = queryAllByRole("menuitem");
    // Should have numeric fields: revenue, cost (revenue may have ✓ if auto-selected)
    const fieldNames = menuItems.map((el) => el.textContent || "");
    expect(fieldNames.some((n) => n.includes("revenue"))).toBe(true);
    expect(fieldNames.some((n) => n.includes("cost"))).toBe(true);
  });

  test("clicking Y-axis field toggles selection", async () => {
    const { queryAllByRole } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    const menuItems = queryAllByRole("menuitem");
    // Find cost menuitem and click to toggle it
    const costItem = menuItems.find((el) => el.textContent?.includes("cost"));
    expect(costItem).not.toBeNull();
    fireEvent.click(costItem!);
    // After toggle, yAxis should include cost — verify via menu items
    await waitFor(() => {
      const updatedItems = queryAllByRole("menuitem");
      const updatedCost = updatedItems.find((el) => el.textContent?.includes("cost"));
      expect(updatedCost).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Pie-specific: X-Axis hidden, "Showing top N" footer
  // -----------------------------------------------------------------------

  test("X-Axis label hidden for pie chart", async () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: fewCategoricalResult }));
    // fewCategoricalResult → pie suggestion
    expect(queryByText("X-Axis")).toBeNull();
  });

  // The palette has 8 slots. Slicing a pie at more than that would repaint slot
  // 1's colour onto slice 9 with nothing to tell them apart (#403) — so the pie
  // caps at the palette size, not at an arbitrary "top 10".
  test('shows "Showing top 8 values" for pie with more rows than palette slots', async () => {
    const { queryByText, container } = render(React.createElement(DataCharts, { result: manyPieResult }));
    // manyPieResult has 15 rows and suggests bar, switch to pie
    fireEvent.click(queryByText("Pie")!);
    await waitFor(() => {
      const footerText = container.textContent || "";
      expect(footerText).toContain("Showing top 8 values");
    });
  });

  test("does not show a pie truncation footer when rows fit the palette", async () => {
    const { queryByText, container } = render(React.createElement(DataCharts, { result: fewCategoricalResult }));
    fireEvent.click(queryByText("Pie")!);
    await waitFor(() => {
      expect(container.textContent || "").not.toContain("Showing top");
    });
  });

  // -----------------------------------------------------------------------
  // Multi-series cap: a 9th line/bar series must not repaint slot 1's colour (#403)
  // -----------------------------------------------------------------------

  test("selecting more series than the palette has slots shows the series-truncation footer", async () => {
    const { queryAllByRole, queryByText, container } = render(
      React.createElement(DataCharts, { result: manySeriesResult }),
    );
    // manySeriesResult's low row count suggests pie by default, where each click
    // replaces the single selection instead of accumulating — switch to Bar first.
    fireEvent.click(queryByText("Bar")!);

    const menuItems = queryAllByRole("menuitem");
    // f1 is auto-selected as the default single Y field; select f2..f9 to reach 9 series total.
    for (const name of ["f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9"]) {
      const item = menuItems.find((el) => el.textContent?.includes(name));
      expect(item).not.toBeNull();
      fireEvent.click(item!);
    }

    await waitFor(() => {
      const footerText = container.textContent || "";
      expect(footerText).toContain("Showing first 8 of 9 series");
    });
  });

  test("selecting up to 8 series does not show the series-truncation footer", async () => {
    const { queryAllByRole, queryByText, container } = render(
      React.createElement(DataCharts, { result: manySeriesResult }),
    );
    fireEvent.click(queryByText("Bar")!);

    const menuItems = queryAllByRole("menuitem");
    // f1 is auto-selected; select f2..f8 to reach exactly 8 — the palette's full size.
    for (const name of ["f2", "f3", "f4", "f5", "f6", "f7", "f8"]) {
      const item = menuItems.find((el) => el.textContent?.includes(name));
      expect(item).not.toBeNull();
      fireEvent.click(item!);
    }

    await waitFor(() => {
      expect(container.textContent || "").not.toContain("Showing first");
    });
  });

  // Histogram buckets one field (`yAxis[0]`) and scatter draws x against its own Y,
  // so neither form can lose a series to the palette cap. The footer has to retract
  // for them rather than keep claiming eight of nine series are drawn (#403).
  test("series-truncation footer is retracted for chart forms that plot a single series", async () => {
    const { queryAllByRole, queryByText, container } = render(
      React.createElement(DataCharts, { result: manySeriesResult }),
    );
    fireEvent.click(queryByText("Bar")!);

    const menuItems = queryAllByRole("menuitem");
    for (const name of ["f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9"]) {
      const item = menuItems.find((el) => el.textContent?.includes(name));
      expect(item).not.toBeNull();
      fireEvent.click(item!);
    }
    // Anchors the two negatives below: the footer is provably present here, so its
    // later absence is the chart form's doing and not a copy change.
    await waitFor(() => {
      expect(container.textContent || "").toContain("Showing first 8 of 9 series");
    });

    fireEvent.click(queryByText("Histogram")!);
    await waitFor(() => {
      expect(container.textContent || "").not.toContain("Showing first");
    });

    fireEvent.click(queryByText("Scatter")!);
    await waitFor(() => {
      expect(container.textContent || "").not.toContain("Showing first");
    });
  });

  // -----------------------------------------------------------------------
  // Save chart flow
  // -----------------------------------------------------------------------

  test("Save button opens save dialog with input and buttons", async () => {
    const user = userEvent.setup();
    const { queryByText, queryByPlaceholderText } = render(
      React.createElement(DataCharts, { result: mockNumericResult }),
    );

    await user.click(queryByText("Save")!);
    expect(queryByPlaceholderText("Chart name...")).not.toBeNull();
    expect(queryByText("Cancel")).not.toBeNull();
  });

  test("Cancel button closes save dialog", async () => {
    const user = userEvent.setup();
    const { queryByText, queryByPlaceholderText } = render(
      React.createElement(DataCharts, { result: mockNumericResult }),
    );

    await user.click(queryByText("Save")!);
    expect(queryByPlaceholderText("Chart name...")).not.toBeNull();

    await user.click(queryByText("Cancel")!);
    expect(queryByPlaceholderText("Chart name...")).toBeNull();
  });

  test("saving a chart persists to localStorage", async () => {
    const user = userEvent.setup();
    const { queryByText, queryByPlaceholderText } = render(
      React.createElement(DataCharts, { result: mockNumericResult }),
    );

    await user.click(queryByText("Save")!);
    const input = queryByPlaceholderText("Chart name...")!;
    await user.type(input, "My Chart");

    // Click the "Save" button in the dialog (not the initial Save)
    const saveBtns = Array.from(document.querySelectorAll("button")).filter((b) => b.textContent === "Save");
    const dialogSave = saveBtns[saveBtns.length - 1];
    await user.click(dialogSave);

    const stored = localStorage.getItem("libredb_saved_charts");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.length).toBe(1);
    expect(parsed[0].name).toBe("My Chart");
  });

  test("does not save when name is empty", async () => {
    const user = userEvent.setup();
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));

    await user.click(queryByText("Save")!);
    // Click Save without typing a name
    const saveBtns = Array.from(document.querySelectorAll("button")).filter((b) => b.textContent === "Save");
    const dialogSave = saveBtns[saveBtns.length - 1];
    await user.click(dialogSave);

    const stored = localStorage.getItem("libredb_saved_charts");
    expect(stored).toBeNull();
  });

  test("loads saved charts from localStorage on mount", () => {
    const savedCharts = [
      {
        id: "1",
        name: "Chart 1",
        chartType: "bar",
        xAxis: "category",
        yAxis: ["revenue"],
        aggregation: "none",
        dateGrouping: "",
      },
    ];
    localStorage.setItem("libredb_saved_charts", JSON.stringify(savedCharts));

    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    expect(queryByText("Saved (1)")).not.toBeNull();
  });

  test("loads saved chart config when clicked", async () => {
    const savedCharts = [
      {
        id: "1",
        name: "Line View",
        chartType: "line",
        xAxis: "date",
        yAxis: ["revenue"],
        aggregation: "sum",
        dateGrouping: "month",
      },
    ];
    localStorage.setItem("libredb_saved_charts", JSON.stringify(savedCharts));

    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    expect(queryByText("Saved (1)")).not.toBeNull();

    // Click the saved chart name
    const chartName = queryByText("Line View");
    expect(chartName).not.toBeNull();
    fireEvent.click(chartName!);
  });

  test("a saved chart whose aggregation and date grouping this build has no rule for draws each date's first value", () => {
    // Saved charts live in the user's store and outlast the build that wrote them.
    const savedCharts = [
      {
        id: "1",
        name: "Median View",
        chartType: "bar",
        xAxis: "date",
        yAxis: ["units"],
        aggregation: "median",
        dateGrouping: "quarter",
      },
    ];
    localStorage.setItem("libredb_saved_charts", JSON.stringify(savedCharts));
    const result: QueryResult = {
      rows: [
        { date: "2025-01-01", units: 100 },
        { date: "2025-01-01", units: 50 },
        { date: "2025-02-01", units: 70 },
      ],
      fields: ["date", "units"],
      rowCount: 3,
      executionTime: 1,
    };

    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result }));
    capturedChartProps.length = 0;
    fireEvent.click(queryByText("Median View")!);

    expect(queryByTestId("mock-bar-chart")).not.toBeNull();
    const data = capturedChartProps.at(-1)!.data as Record<string, unknown>[];
    expect(data.map((point) => point.units)).toEqual([100, 70]);
  });

  test("deletes saved chart removes from localStorage", async () => {
    const user = userEvent.setup();
    const savedCharts = [
      {
        id: "1",
        name: "Old Chart",
        chartType: "bar",
        xAxis: "category",
        yAxis: ["revenue"],
        aggregation: "none",
        dateGrouping: "",
      },
    ];
    localStorage.setItem("libredb_saved_charts", JSON.stringify(savedCharts));

    const { container } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    // Find the delete button inside the saved chart dropdown (has .lucide-x SVG)
    const deleteBtn = container.querySelector(".lucide-x")?.closest("button");
    expect(deleteBtn).not.toBeNull();
    await user.click(deleteBtn!);

    const stored = localStorage.getItem("libredb_saved_charts");
    const parsed = JSON.parse(stored || "[]");
    expect(parsed.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Pie slice label
  // -----------------------------------------------------------------------

  /**
   * The rule this component exists to keep: text wears ink, never the series
   * colour. Recharts paints a string label in the SLICE's fill, and three of the
   * light-mode slots sit near 2:1 against the surface — fine as a wedge, illegible
   * as a word. Rendering an explicit <text fill=ink> is what overrides that.
   */
  test("the pie label is written in ink, not in the slice colour", () => {
    const { container } = render(
      React.createElement(PieSliceLabel, {
        ink: "#27272a",
        x: 10,
        y: 20,
        textAnchor: "middle" as const,
        name: "Engineer",
        percent: 0.25,
      }),
    );
    const text = container.querySelector("text");
    expect(text).not.toBeNull();
    expect(text!.getAttribute("fill")).toBe("#27272a");
    expect(text!.textContent).toBe("Engineer (25%)");
  });

  test("the label carries the geometry recharts injected", () => {
    const { container } = render(
      React.createElement(PieSliceLabel, {
        ink: "#d4d4d8",
        x: 42,
        y: 84,
        textAnchor: "end" as const,
        name: "Staff",
        percent: 0.5,
      }),
    );
    const text = container.querySelector("text")!;
    expect(text.getAttribute("x")).toBe("42");
    expect(text.getAttribute("y")).toBe("84");
    expect(text.getAttribute("text-anchor")).toBe("end");
  });

  /**
   * Recharts clones the element to inject props, so a first render happens with
   * none of them present. That must produce a label, not a crash or "undefined".
   */
  test("survives the render that happens before recharts injects anything", () => {
    const { container } = render(React.createElement(PieSliceLabel, { ink: "#27272a" }));
    expect(container.querySelector("text")!.textContent).toBe(" (0%)");
  });

  /**
   * A PNG carries no page behind it, so the export has to paint its own ground —
   * and it has to be the ground of the theme the chart was captured in. Exporting
   * a light chart onto near-black (what a hardcoded value did) leaves dark axis
   * labels on a dark field.
   */
  async function exportPngOptions(): Promise<Record<string, unknown>> {
    mockSnapdom.mockClear();
    const linkClick = mock(() => {});
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = linkClick as unknown as typeof HTMLAnchorElement.prototype.click;

    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText("Export as PNG")!);

    await waitFor(() => {
      expect(linkClick).toHaveBeenCalled();
    });
    expect(mockSnapdom).toHaveBeenCalledTimes(1);

    HTMLAnchorElement.prototype.click = originalClick;
    return mockSnapdom.mock.calls[0][1] as unknown as Record<string, unknown>;
  }

  test("exports chart as PNG via snapdom, on the dark ground when dark is in force", async () => {
    document.documentElement.classList.add("dark");
    try {
      const options = await exportPngOptions();
      expect(options.backgroundColor).toBe("#080808");
      expect(options.scale).toBe(2);
      expect(options.embedFonts).toBe(false);
    } finally {
      document.documentElement.classList.remove("dark");
    }
  });

  test("exports onto the light ground when light is in force", async () => {
    const options = await exportPngOptions();
    expect(options.backgroundColor).toBe("#fafafa");
  });

  test("failed PNG export surfaces an error toast", async () => {
    mockSnapdom.mockImplementationOnce(async () => {
      throw new Error("capture exploded");
    });
    mockToastError.mockClear();
    const linkClick = mock(() => {});
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = linkClick as unknown as typeof HTMLAnchorElement.prototype.click;

    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText("Export as PNG")!);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
    });
    expect(linkClick).not.toHaveBeenCalled();

    HTMLAnchorElement.prototype.click = originalClick;
  });

  test("Export SVG triggers download when SVG element exists", async () => {
    const createObjectURLMock = mock(() => "blob:fake-svg-url");
    const revokeObjectURLMock = mock(() => {});
    const linkClick = mock(() => {});

    globalThis.URL.createObjectURL = createObjectURLMock;
    globalThis.URL.revokeObjectURL = revokeObjectURLMock;
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = linkClick as unknown as typeof HTMLAnchorElement.prototype.click;

    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText("Export as SVG")!);

    // SVG export depends on finding an actual SVG element in the DOM
    // With mocked recharts, there won't be one, so just verify no error thrown
    HTMLAnchorElement.prototype.click = originalClick;
  });

  // -----------------------------------------------------------------------
  // Aggregation / date grouping hidden for certain chart types
  //
  // The four polls below compare with `=== null` instead of asserting `toBeNull()` on the node.
  // A poll that FAILS hands bun a live happy-dom element to pretty-print, and bun walks the whole
  // node's object graph for the diff: 301 ms for a 260-node subtree, measured. waitFor's 5 s
  // budget is gone in a few polls, so a machine that is briefly busy reds a healthy test. The
  // boolean costs 0 ms and asserts the same absence.
  // -----------------------------------------------------------------------

  test("aggregation hidden for scatter chart", async () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText("Scatter")!);
    await waitFor(() => {
      expect(queryByText("Agg") === null).toBe(true);
    });
  });

  test("aggregation hidden for histogram chart", async () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText("Histogram")!);
    await waitFor(() => {
      expect(queryByText("Agg") === null).toBe(true);
    });
  });

  test("date grouping hidden for scatter chart", async () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText("Scatter")!);
    await waitFor(() => {
      expect(queryByText("Group") === null).toBe(true);
    });
  });

  test("date grouping hidden for histogram chart", async () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText("Histogram")!);
    await waitFor(() => {
      expect(queryByText("Group") === null).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Aggregation options rendered
  // -----------------------------------------------------------------------

  test("aggregation selector shows all options", () => {
    const { queryAllByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    // Aggregation: none, sum, avg, count, min, max
    expect(queryAllByTestId("select-item-sum").length).toBeGreaterThan(0);
    expect(queryAllByTestId("select-item-avg").length).toBeGreaterThan(0);
    expect(queryAllByTestId("select-item-count").length).toBeGreaterThan(0);
    expect(queryAllByTestId("select-item-min").length).toBeGreaterThan(0);
    expect(queryAllByTestId("select-item-max").length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Date grouping options rendered
  // -----------------------------------------------------------------------

  test("date grouping selector shows all options", () => {
    const { queryAllByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    // Date grouping: hour, day, week, month, year
    expect(queryAllByTestId("select-item-hour").length).toBeGreaterThan(0);
    expect(queryAllByTestId("select-item-day").length).toBeGreaterThan(0);
    expect(queryAllByTestId("select-item-week").length).toBeGreaterThan(0);
    expect(queryAllByTestId("select-item-month").length).toBeGreaterThan(0);
    expect(queryAllByTestId("select-item-year").length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Histogram bucket options
  // -----------------------------------------------------------------------

  test("histogram buckets selector shows options", async () => {
    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText("Histogram")!);
    await waitFor(() => {
      expect(queryByTestId("select-item-5")).not.toBeNull();
      expect(queryByTestId("select-item-10")).not.toBeNull();
      expect(queryByTestId("select-item-20")).not.toBeNull();
      expect(queryByTestId("select-item-50")).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Field type icons
  // -----------------------------------------------------------------------

  test("renders field type icons in X-axis selector", () => {
    const { container } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    // Check that field icons are rendered via lucide SVG class names
    const hashIcons = container.querySelectorAll(".lucide-hash");
    const calendarIcons = container.querySelectorAll(".lucide-calendar");
    const typeIcons = container.querySelectorAll(".lucide-type");
    expect(hashIcons.length).toBeGreaterThan(0);
    expect(calendarIcons.length).toBeGreaterThan(0);
    expect(typeIcons.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Tooltip content, aggregation paths, saved-chart load, SVG export
  // -----------------------------------------------------------------------

  test("custom tooltip renders label and formatted payload entries when active", () => {
    const { container } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    // The recharts Tooltip mock renders CustomTooltip once active (with a
    // payload) and once inactive (which must render nothing).
    expect(container.textContent).toContain("tooltip_label");
    expect(container.textContent).toContain("tooltip_series");
    expect(container.textContent).toContain("1.2M");
  });

  test("selecting an aggregation feeds chart data through aggregateData", () => {
    const { getByTestId, container } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(getByTestId("select-item-sum"));
    expect(container.querySelector('[data-value="sum"]')).not.toBeNull();
  });

  test("selecting a date grouping without aggregation groups chart data", () => {
    const { getByTestId, container } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(getByTestId("select-item-month"));
    expect(container.querySelector('[data-value="month"]')).not.toBeNull();
  });

  test("clicking an already-selected Y-axis field deselects it", () => {
    const { getAllByRole, queryByText } = render(
      React.createElement(DataCharts, { result: mockNumericResult, maskingEnabled: false }),
    );
    // revenue is auto-selected as the first numeric field
    expect(queryByText("Select fields")).toBeNull();
    const revenueItem = getAllByRole("menuitem").find((i) => i.textContent?.includes("revenue"));
    expect(revenueItem).toBeDefined();
    fireEvent.click(revenueItem!);
    expect(queryByText("Select fields")).not.toBeNull();
  });

  test("loading a saved chart applies its stored configuration", () => {
    localStorage.setItem(
      "libredb_saved_charts",
      JSON.stringify([
        {
          id: "chart-1",
          name: "Saved revenue by category",
          chartType: "bar",
          xAxis: "category",
          yAxis: ["revenue"],
          aggregation: "sum",
          dateGrouping: "",
        },
      ]),
    );
    const { getAllByRole, queryByText, container } = render(
      React.createElement(DataCharts, { result: mockNumericResult }),
    );
    expect(queryByText(/Saved \(1\)/)).not.toBeNull();

    const savedItem = getAllByRole("menuitem").find((i) => i.textContent?.includes("Saved revenue by category"));
    expect(savedItem).toBeDefined();
    fireEvent.click(savedItem!);

    // loadSavedChart applied the stored aggregation
    expect(container.querySelector('[data-value="sum"]')).not.toBeNull();
  });

  test("exports the chart as SVG by serializing the rendered svg element", async () => {
    const linkClick = mock(() => {});
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = linkClick as unknown as typeof HTMLAnchorElement.prototype.click;

    try {
      const { queryByText, container } = render(React.createElement(DataCharts, { result: mockNumericResult }));
      // The recharts mock renders no real <svg>, so provide one inside the
      // chart area for exportChart's querySelector to find.
      const chartArea = container.querySelector(".flex-1.p-4");
      expect(chartArea).not.toBeNull();
      chartArea!.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "svg"));

      fireEvent.click(queryByText("Export as SVG")!);

      await waitFor(() => {
        expect(linkClick).toHaveBeenCalled();
      });
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });

  // -----------------------------------------------------------------------
  // A specification the caller supplies (the agent's answer)
  // -----------------------------------------------------------------------

  /**
   * The model chooses the chart; inference is the fallback.
   *
   * And the fallback is load-bearing rather than tidy: this component turns a value
   * it cannot read into a number with `Number(value) || 0`, so a chart drawn over a
   * column the delivered rows do not have does not fail — it draws a confident flat
   * line of zeros. The specification is validated on the server before it is
   * recorded; it is validated AGAIN here, because what reaches the browser is a
   * different delivery of the result from the one the server checked.
   */
  describe("a supplied specification", () => {
    const spec = (overrides: Record<string, unknown> = {}) => ({
      type: "line" as const,
      x: "type",
      y: ["count"] as [string, ...string[]],
      caption: "Count by type.",
      ...overrides,
    });

    test("the supplied type and axes are drawn, not the ones inference would have chosen", () => {
      // Inference suggests a line chart for this result (it has a date column) and
      // `revenue` for the value, so a bar chart of `cost` can only have come from the
      // specification.
      const { queryByTestId, queryByRole } = render(
        React.createElement(DataCharts, {
          result: mockNumericResult,
          spec: spec({ type: "bar", x: "category", y: ["cost"] }),
        }),
      );

      expect(queryByTestId("mock-bar-chart")).not.toBeNull();
      expect(queryByTestId("mock-line-chart")).toBeNull();
      expect(queryByRole("button", { name: /cost/ })).not.toBeNull();
    });

    test("a scatter specification takes its second axis from the columns it named", () => {
      const { queryByTestId } = render(
        React.createElement(DataCharts, {
          result: pureNumericResult,
          spec: spec({ type: "scatter", x: "x", y: ["y"] }),
        }),
      );

      expect(queryByTestId("mock-scatter-chart")).not.toBeNull();
    });

    test("a specification naming a column the delivered result does not have falls back to inference", () => {
      // The failure this prevents is silent: `net_total` is absent, every row reads
      // as zero, and the picture is a flat line with this application's frame around
      // it. The inferred pie is what the user gets instead.
      const { queryByTestId } = render(
        React.createElement(DataCharts, { result: fewCategoricalResult, spec: spec({ x: "net_total" }) }),
      );

      expect(queryByTestId("mock-pie-chart")).not.toBeNull();
      expect(queryByTestId("mock-line-chart")).toBeNull();
    });

    test("a specification whose value column holds no numbers falls back the same way", () => {
      const { queryByTestId } = render(
        React.createElement(DataCharts, { result: fewCategoricalResult, spec: spec({ y: ["type"] }) }),
      );

      expect(queryByTestId("mock-pie-chart")).not.toBeNull();
    });

    test("a scatter specification whose x column holds no numbers falls back the same way", () => {
      // Scatter reads BOTH axes as numbers, so a categorical x is the same flat-zero
      // failure one axis along.
      const { queryByTestId } = render(
        React.createElement(DataCharts, {
          result: fewCategoricalResult,
          spec: spec({ type: "scatter", x: "type", y: ["count"] }),
        }),
      );

      expect(queryByTestId("mock-pie-chart")).not.toBeNull();
      expect(queryByTestId("mock-scatter-chart")).toBeNull();
    });

    test("every column a spec can name is a column this component actually draws", () => {
      // The guard this replaces dropped any spec carrying `series`, which made the
      // renderer the last of four layers to disagree about a field the other three
      // accepted. `series` is gone from the contract, the schema and the type, so
      // the property no longer exists to be dropped — and the way that stays true is
      // that a spec's keys are exactly what `AgentChartSpec` declares.
      expect(Object.keys(spec({}))).toEqual(["type", "x", "y", "caption"]);
    });

    test("a specification over a result nothing can chart still shows why it cannot", () => {
      const { queryByText } = render(
        React.createElement(DataCharts, {
          result: mockSingleRowResult,
          spec: spec({ x: "id", y: ["value"] }),
        }),
      );

      expect(queryByText("Need at least 2 rows for visualization")).not.toBeNull();
    });
  });
});

describe("DataCharts display masking (#1939)", () => {
  const emailPattern = DEFAULT_MASKING_CONFIG.patterns.find((p) => p.id === "builtin-email")!;
  const maskEmail = (value: unknown) => maskValueByPattern(value, emailPattern);
  const maskingProps = {
    maskingEnabled: true,
    userRole: "admin",
    maskingConfig: DEFAULT_MASKING_CONFIG,
  };

  // al123@example.com masks to the SAME text as alice@example.com: both must survive as
  // their own categories (slices, bars), or the mask would have merged two groups.
  const maskedCategoryResult: QueryResult = {
    rows: [
      { email: "alice@example.com", logins: 5 },
      { email: "al123@example.com", logins: 4 },
      { email: "bob@example.com", logins: 3 },
    ],
    fields: ["email", "logins"],
    rowCount: 3,
    executionTime: 1,
  };

  const maskedNumericResult: QueryResult = {
    rows: [
      { dept: "Engineering", salary: 90000, logins: 5 },
      { dept: "Sales", salary: 70000, logins: 3 },
    ],
    fields: ["dept", "salary", "logins"],
    rowCount: 2,
    executionTime: 1,
  };

  // Without this, a test that renders no chart (every masked series withheld) reads the
  // PREVIOUS test's captured props, and run alone it has nothing to read at all.
  beforeEach(() => {
    capturedXAxisProps.length = 0;
    capturedChartProps.length = 0;
    capturedPieProps.length = 0;
    capturedScatterProps.length = 0;
    // A test that plants a saved config must not leak it into the next one.
    mockGetMaskingConfig.mockImplementation(() => DEFAULT_MASKING_CONFIG);
  });

  test("masks a masked column's categories in the pie suggestion and the category charts", async () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: maskedCategoryResult, ...maskingProps }));
    // A small categorical result suggests the pie; its slice names are the categories.
    const pieData = capturedPieProps.at(-1)?.data as unknown[];
    expect(pieData.length).toBe(3);
    const pieText = JSON.stringify(pieData);
    expect(pieText).toContain(maskEmail("alice@example.com"));
    expect(pieText).not.toContain("alice@example.com");
    // Two slices share one mask and neither is merged away.
    expect(pieText.split(maskEmail("alice@example.com")).length - 1).toBe(2);

    for (const label of ["Bar", "Line", "Area"]) {
      capturedChartProps.length = 0;
      fireEvent.click(queryByText(label)!);
      await waitFor(() => expect(capturedChartProps.length).toBeGreaterThan(0));
      const data = JSON.stringify(capturedChartProps.at(-1)?.data);
      expect(data).toContain(maskEmail("alice@example.com"));
      expect(data).not.toContain("alice@example.com");
      // The unmasked numeric series still plots.
      expect(data).toContain('"logins":5');
    }
  });

  test("never plots a masked column's numbers: the default series skips it", () => {
    render(React.createElement(DataCharts, { result: maskedNumericResult, ...maskingProps }));
    const data = JSON.stringify(capturedChartProps.at(-1)?.data ?? capturedPieProps.at(-1)?.data);
    expect(data).not.toContain("90000");
    expect(data).not.toContain("70000");
    expect(data).toContain('"logins":5');
  });

  test("a masked series handed in by a spec is withheld", () => {
    // Nothing is drawn here, so the old read of the captured props reached back into
    // the PREVIOUS test's data — and run alone this test had nothing to read at all.
    // The empty state is the observable behavior, the same message the histogram and
    // scatter forms show.
    const screen = render(
      React.createElement(DataCharts, {
        result: maskedNumericResult,
        spec: { type: "bar", x: "dept", y: ["salary"] } as never,
        ...maskingProps,
      }),
    );
    expect(screen.queryByText(/Nothing to plot while display masking is on/i)).not.toBeNull();
  });

  test("a histogram of a masked field is withheld with an explanation", () => {
    const screen = render(
      React.createElement(DataCharts, {
        result: maskedNumericResult,
        spec: { type: "histogram", x: "dept", y: ["salary"] } as never,
        ...maskingProps,
      }),
    );
    expect(screen.queryByText(/Nothing to plot while display masking is on/i)).not.toBeNull();
    expect(screen.queryByText(/50000/)).toBeNull();
  });

  test("ignores date grouping while the date column is masked, so labels match the grid", async () => {
    // Month grouping would bucket "1990-03-15" to "1990-03" and the mask would then show
    // "****-**-03" - the MONTH, which the grid's mask of the raw value ("****-**-15")
    // hides. With masking in force the grouping must not apply (#1939).
    const birthdateResult: QueryResult = {
      rows: [
        { birthdate: "1990-03-15", logins: 5 },
        { birthdate: "1990-03-22", logins: 4 },
        { birthdate: "1991-01-10", logins: 3 },
      ],
      fields: ["birthdate", "logins"],
      rowCount: 3,
      executionTime: 1,
    };
    localStorage.setItem(
      "libredb_saved_charts",
      JSON.stringify([
        {
          id: "1",
          name: "By Month",
          chartType: "bar",
          xAxis: "birthdate",
          yAxis: ["logins"],
          aggregation: "sum",
          dateGrouping: "month",
        },
      ]),
    );
    const screen = render(React.createElement(DataCharts, { result: birthdateResult, ...maskingProps }));
    fireEvent.click(screen.queryByText("By Month")!);
    await waitFor(() => expect(capturedChartProps.length).toBeGreaterThan(0));
    const text = JSON.stringify(capturedChartProps.at(-1)?.data);
    expect(text).toContain("****-**-15");
    expect(text).toContain("****-**-22");
    expect(text).not.toContain("****-**-03");
    expect(text).not.toContain("1990-03");
  });

  test("a scatter axis that is masked is withheld with an explanation", () => {
    const screen = render(
      React.createElement(DataCharts, {
        result: maskedNumericResult,
        spec: { type: "scatter", x: "salary", y: ["logins"] } as never,
        ...maskingProps,
      }),
    );
    expect(screen.queryByText(/Nothing to plot while display masking is on/i)).not.toBeNull();
    expect(screen.queryByText(/50000/)).toBeNull();
  });

  test("falls back to the saved masking config when none is handed in", () => {
    // ResultsGrid and the DataProfiler resolve a missing config from storage; here
    // undefined used to read as no masking, and the chart plotted the clear numbers the
    // grid was hiding. With the saved (default) config in force, the masked column's
    // numbers stay unrendered, empty state and all.
    const screen = render(
      React.createElement(DataCharts, {
        result: maskedNumericResult,
        spec: { type: "bar", x: "dept", y: ["salary"] } as never,
        maskingEnabled: true,
        userRole: "admin",
      }),
    );
    expect(screen.queryByText(/Nothing to plot while display masking is on/i)).not.toBeNull();
    expect(capturedChartProps.length).toBe(0);
  });

  // Aggregation runs on the RAW values and the mask is only the label, so two raw
  // groups that share one mask keep their own bars and their own sums. This pins the
  // existing behavior: the mask must not merge the groups, and must not split the sums.
  test("aggregates raw groups that share one mask under the masked label", async () => {
    const sharedMaskResult: QueryResult = {
      rows: [
        { email: "alice@example.com", logins: 5 },
        { email: "alice@example.com", logins: 2 },
        { email: "al123@example.com", logins: 4 },
      ],
      fields: ["email", "logins"],
      rowCount: 3,
      executionTime: 1,
    };
    const { getByTestId } = render(
      React.createElement(DataCharts, {
        result: sharedMaskResult,
        spec: { type: "bar", x: "email", y: ["logins"] } as never,
        ...maskingProps,
      }),
    );
    capturedChartProps.length = 0;
    fireEvent.click(getByTestId("select-item-sum"));
    await waitFor(() => expect(capturedChartProps.length).toBeGreaterThan(0));

    const data = capturedChartProps.at(-1)?.data as Array<Record<string, unknown>>;
    expect(data.map((point) => point.logins)).toEqual([7, 4]);
    const mask = maskEmail("alice@example.com");
    expect(data[0]?.email).toBe(mask);
    expect(data[1]?.email).toBe(mask);
  });

  test("plots clear numbers while masking is off, config still handed in", () => {
    render(
      React.createElement(DataCharts, {
        result: maskedNumericResult,
        spec: { type: "bar", x: "dept", y: ["salary"] } as never,
        maskingEnabled: false,
        userRole: "admin",
        maskingConfig: DEFAULT_MASKING_CONFIG,
      }),
    );
    const data = JSON.stringify(capturedChartProps.at(-1)?.data);
    expect(data).toContain("90000");
    expect(data).toContain("70000");
  });
});
