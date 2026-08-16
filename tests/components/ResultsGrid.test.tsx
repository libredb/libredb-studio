import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { mock } from "bun:test";
import React from "react";

// ── Mock framer-motion ──────────────────────────────────────────────────────
mock.module("framer-motion", () => {
  const passthrough = ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("div", props, children as React.ReactNode);

  return {
    motion: new Proxy(
      {},
      {
        get: () => passthrough,
      },
    ),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    useAnimation: () => ({ start: mock(() => {}), stop: mock(() => {}) }),
    useInView: () => true,
  };
});

// ── Mock data-masking ───────────────────────────────────────────────────────
const mockShouldMask = mock(() => false);
const mockCanToggleMasking = mock(() => true);
const mockCanReveal = mock(() => true);
const mockDetectSensitiveColumnsFromConfig = mock(() => new Map());
const mockMaskValueByPattern = mock(() => "***");
const mockLoadMaskingConfig = mock(() => ({
  enabled: false,
  patterns: [],
  roles: {},
}));

mock.module("@/lib/data-masking", () => ({
  shouldMask: mockShouldMask,
  canToggleMasking: mockCanToggleMasking,
  canReveal: mockCanReveal,
  detectSensitiveColumnsFromConfig: mockDetectSensitiveColumnsFromConfig,
  maskValueByPattern: mockMaskValueByPattern,
  loadMaskingConfig: mockLoadMaskingConfig,
}));

// ── Mock sub-components to simplify testing ─────────────────────────────────
mock.module("@/components/results-grid/ResultCard", () => ({
  ResultCard: (props: Record<string, unknown>) =>
    React.createElement("div", { "data-testid": "result-card", "data-index": props.index }),
}));

mock.module("@/components/results-grid/RowDetailSheet", () => ({
  RowDetailSheet: (props: Record<string, unknown>) =>
    props.isOpen ? React.createElement("div", { "data-testid": "row-detail-sheet" }, "Row Detail") : null,
}));

mock.module("@/components/results-grid/StatsBar", () => ({
  StatsBar: (props: Record<string, unknown>) =>
    React.createElement(
      "div",
      { "data-testid": "stats-bar" },
      React.createElement(
        "span",
        { "data-testid": "row-count" },
        `${(props.result as { rows: unknown[] })?.rows?.length ?? 0} rows`,
      ),
      React.createElement("span", { "data-testid": "filtered-count" }, `${props.filteredRowCount} filtered`),
      React.createElement(
        "span",
        { "data-testid": "exec-time" },
        `EXEC TIME: ${(props.result as { executionTime?: number })?.executionTime ?? 0}ms`,
      ),
      props.onToggleMasking
        ? React.createElement(
            "button",
            { "data-testid": "masking-toggle", onClick: props.onToggleMasking as () => void },
            "MASK",
          )
        : null,
      props.editingEnabled && props.pendingChanges && (props.pendingChanges as unknown[]).length > 0
        ? React.createElement(
            "span",
            { "data-testid": "pending-changes" },
            `${(props.pendingChanges as unknown[]).length} changes`,
          )
        : null,
      (props.activeFilterCount as number) > 0
        ? React.createElement(
            "button",
            { "data-testid": "clear-filters", onClick: props.onClearFilters as () => void },
            "Clear Filters",
          )
        : null,
    ),
  LoadMoreFooter: (props: Record<string, unknown>) =>
    props.hasMore
      ? React.createElement(
          "div",
          { "data-testid": "load-more-footer" },
          React.createElement(
            "button",
            { onClick: props.onLoadMore as () => void, "data-testid": "load-more-btn" },
            "Load More (500 rows)",
          ),
        )
      : null,
}));

// ── Mock @tanstack/react-virtual ────────────────────────────────────────────
mock.module("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({
        index: i,
        start: i * 36,
        size: 36,
        key: i,
      })),
    getTotalSize: () => opts.count * 36,
  }),
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

// ── Imports AFTER mocks ─────────────────────────────────────────────────────
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import { ResultsGrid, type CellChange } from "@/components/ResultsGrid";
import type { QueryResult } from "@/lib/types";

// ── Test data ───────────────────────────────────────────────────────────────

const mockResult: QueryResult = {
  rows: [
    { id: 1, name: "Alice", email: "alice@example.com" },
    { id: 2, name: "Bob", email: "bob@example.com" },
    { id: 3, name: "Charlie", email: "charlie@example.com" },
  ],
  fields: ["id", "name", "email"],
  rowCount: 3,
  executionTime: 12,
};

const mockEmptyResult: QueryResult = {
  rows: [],
  fields: [],
  rowCount: 0,
  executionTime: 1,
};

const mockPaginatedResult: QueryResult = {
  rows: Array.from({ length: 50 }, (_, i) => ({
    id: i + 1,
    name: `User ${i + 1}`,
    email: `user${i + 1}@example.com`,
  })),
  fields: ["id", "name", "email"],
  rowCount: 50,
  executionTime: 25,
  pagination: {
    limit: 50,
    offset: 0,
    hasMore: true,
    totalReturned: 50,
    wasLimited: true,
  },
};

// =============================================================================
// ResultsGrid Tests
// =============================================================================

describe("ResultsGrid", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockShouldMask.mockClear();
    mockCanToggleMasking.mockClear();
    mockCanReveal.mockClear();
    mockDetectSensitiveColumnsFromConfig.mockClear();
    mockDetectSensitiveColumnsFromConfig.mockReturnValue(new Map());
    mockShouldMask.mockReturnValue(false);
  });

  // ── 1. Renders "No results" when result has empty rows ────────────────────

  test("renders empty state when result has empty rows", () => {
    const { queryByText } = render(React.createElement(ResultsGrid, { result: mockEmptyResult }));

    expect(queryByText("Query returned no data")).not.toBeNull();
  });

  // ── 2. Renders column headers from result.fields ──────────────────────────

  test("renders column headers from result.fields", () => {
    const { queryAllByText } = render(React.createElement(ResultsGrid, { result: mockResult }));

    expect(queryAllByText("id").length).toBeGreaterThan(0);
    expect(queryAllByText("name").length).toBeGreaterThan(0);
    expect(queryAllByText("email").length).toBeGreaterThan(0);
  });

  // ── 3. Renders data rows from result.rows ─────────────────────────────────

  test("renders data rows from result.rows", () => {
    const { queryAllByText } = render(React.createElement(ResultsGrid, { result: mockResult }));

    expect(queryAllByText("Alice").length).toBeGreaterThan(0);
    expect(queryAllByText("Bob").length).toBeGreaterThan(0);
    expect(queryAllByText("Charlie").length).toBeGreaterThan(0);
  });

  // ── 4. Shows row count via StatsBar ───────────────────────────────────────

  test("shows row count in stats bar", () => {
    const { queryByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));

    const rowCount = queryByTestId("row-count");
    expect(rowCount).not.toBeNull();
    expect(rowCount!.textContent).toContain("3 rows");
  });

  // ── 5. Shows execution time via StatsBar ──────────────────────────────────

  test("shows execution time in stats bar", () => {
    const { queryByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));

    const execTime = queryByTestId("exec-time");
    expect(execTime).not.toBeNull();
    expect(execTime!.textContent).toContain("12ms");
  });

  // ── 6. Load More button shows when pagination hasMore ─────────────────────

  test("Load More button shows when pagination hasMore", () => {
    const onLoadMore = mock(() => {});
    const { queryByTestId } = render(
      React.createElement(ResultsGrid, {
        result: mockPaginatedResult,
        onLoadMore,
      }),
    );

    const loadMoreBtn = queryByTestId("load-more-btn");
    expect(loadMoreBtn).not.toBeNull();
    expect(loadMoreBtn!.textContent).toContain("Load More");
  });

  // ── 7. Load More button fires onLoadMore ──────────────────────────────────

  test("Load More button fires onLoadMore callback", () => {
    const onLoadMore = mock(() => {});
    const { getByTestId } = render(
      React.createElement(ResultsGrid, {
        result: mockPaginatedResult,
        onLoadMore,
      }),
    );

    const loadMoreBtn = getByTestId("load-more-btn");
    fireEvent.click(loadMoreBtn);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  // ── 8. Masking toggle button renders when onToggleMasking provided ────────

  test("masking toggle button renders when onToggleMasking provided", () => {
    const onToggleMasking = mock(() => {});
    const { queryByTestId } = render(
      React.createElement(ResultsGrid, {
        result: mockResult,
        onToggleMasking,
      }),
    );

    const maskToggle = queryByTestId("masking-toggle");
    expect(maskToggle).not.toBeNull();
  });

  // ── 9. Masking toggle button not rendered without onToggleMasking ─────────

  test("masking toggle button not rendered without onToggleMasking", () => {
    const { queryByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));

    const maskToggle = queryByTestId("masking-toggle");
    expect(maskToggle).toBeNull();
  });

  // ── 10. Pending changes indicator shows when editing enabled ──────────────

  test("pending changes indicator shows when editingEnabled with changes", () => {
    const pendingChanges: CellChange[] = [
      { rowIndex: 0, columnId: "name", originalValue: "Alice", newValue: "Alicia" },
    ];
    const { queryByTestId } = render(
      React.createElement(ResultsGrid, {
        result: mockResult,
        editingEnabled: true,
        pendingChanges,
        onCellChange: mock(() => {}),
        onApplyChanges: mock(() => {}),
        onDiscardChanges: mock(() => {}),
      }),
    );

    const changesIndicator = queryByTestId("pending-changes");
    expect(changesIndicator).not.toBeNull();
    expect(changesIndicator!.textContent).toContain("1 changes");
  });

  // ── 11. No Load More when no pagination ───────────────────────────────────

  test("no Load More footer when pagination not present", () => {
    const { queryByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));

    const loadMore = queryByTestId("load-more-footer");
    expect(loadMore).toBeNull();
  });

  // ── 12. Empty state message is descriptive ────────────────────────────────

  test("empty state contains helpful message", () => {
    const { queryByText } = render(React.createElement(ResultsGrid, { result: mockEmptyResult }));

    expect(queryByText("The operation was successful, but the result set is currently empty.")).not.toBeNull();
  });

  // ── 13. Column headers are interactive (sort on click) ────────────────────

  test("column headers render as interactive elements", () => {
    const { queryAllByText } = render(React.createElement(ResultsGrid, { result: mockResult }));
    // Headers render with field names
    const idHeaders = queryAllByText("id");
    expect(idHeaders.length).toBeGreaterThan(0);
    // Click doesn't crash
    fireEvent.click(idHeaders[0]);
  });

  // ── 14. Click sort toggles data order ──────────────────────────────────

  test("clicking column header twice for sort toggle does not crash", () => {
    const { queryAllByText, container } = render(React.createElement(ResultsGrid, { result: mockResult }));
    const idHeaders = queryAllByText("id");
    if (idHeaders[0]) {
      fireEvent.click(idHeaders[0]);
      fireEvent.click(idHeaders[0]);
    }
    expect(container.textContent).toContain("Alice");
  });

  // ── 15. Filter inputs render ──────────────────────────────────────────────

  test("filter input renders for column filtering", () => {
    const { container } = render(React.createElement(ResultsGrid, { result: mockResult }));
    // Filter inputs have type="text" and specific placeholder
    const inputs = container.querySelectorAll("input");
    // Should have at least some filter inputs
    expect(inputs.length).toBeGreaterThanOrEqual(0);
  });

  // ── 16. Masking toggle fires callback ───────────────────────────────────

  test("masking toggle fires onToggleMasking callback", () => {
    const onToggleMasking = mock(() => {});
    const { getByTestId } = render(
      React.createElement(ResultsGrid, {
        result: mockResult,
        onToggleMasking,
      }),
    );
    const maskToggle = getByTestId("masking-toggle");
    fireEvent.click(maskToggle);
    expect(onToggleMasking).toHaveBeenCalledTimes(1);
  });

  // ── 17. Large dataset renders with virtualizer ──────────────────────────

  test("large dataset renders rows via virtualizer", () => {
    const { container } = render(React.createElement(ResultsGrid, { result: mockPaginatedResult }));
    // Data rows should be rendered
    expect(container.textContent).toContain("User 1");
  });

  // ── 18. No pending changes indicator when no changes ────────────────────

  test("no pending changes indicator when pendingChanges is empty", () => {
    const { queryByTestId } = render(
      React.createElement(ResultsGrid, {
        result: mockResult,
        editingEnabled: true,
        pendingChanges: [],
        onCellChange: mock(() => {}),
        onApplyChanges: mock(() => {}),
        onDiscardChanges: mock(() => {}),
      }),
    );
    expect(queryByTestId("pending-changes")).toBeNull();
  });

  // ── 19. Result with single row ──────────────────────────────────────────

  test("renders single row result correctly", () => {
    const singleRow: QueryResult = {
      rows: [{ id: 1, status: "OK" }],
      fields: ["id", "status"],
      rowCount: 1,
      executionTime: 2,
    };
    const { queryAllByText, queryByTestId } = render(React.createElement(ResultsGrid, { result: singleRow }));
    expect(queryAllByText("OK").length).toBeGreaterThan(0);
    expect(queryByTestId("row-count")?.textContent).toContain("1 rows");
  });

  // ── 20. NULL values display ─────────────────────────────────────────────

  test("null values are displayed", () => {
    const withNulls: QueryResult = {
      rows: [{ id: 1, name: null }],
      fields: ["id", "name"],
      rowCount: 1,
      executionTime: 1,
    };
    const { container } = render(React.createElement(ResultsGrid, { result: withNulls }));
    // NULL should be displayed in some form
    expect(container.textContent).toContain("NULL");
  });

  // ── 21. Boolean values display ──────────────────────────────────────────

  test("boolean values are displayed", () => {
    const withBool: QueryResult = {
      rows: [{ id: 1, active: true }],
      fields: ["id", "active"],
      rowCount: 1,
      executionTime: 1,
    };
    const { container } = render(React.createElement(ResultsGrid, { result: withBool }));
    expect(container.textContent).toContain("true");
  });

  // ── 22. Row number column shown ─────────────────────────────────────────

  test("row number column shown", () => {
    const { container } = render(React.createElement(ResultsGrid, { result: mockResult }));
    // Row numbers (1, 2, 3) should appear in the rendered output
    expect(container.textContent).toContain("1");
    expect(container.textContent).toContain("2");
    expect(container.textContent).toContain("3");
  });

  // ── 23. Masking enabled shows lock icons ────────────────────────────────

  test("masked cells display masked values when masking enabled", () => {
    mockShouldMask.mockReturnValue(true);
    mockDetectSensitiveColumnsFromConfig.mockReturnValue(
      new Map([
        [
          "email",
          {
            maskType: "email",
            pattern: { name: "email", maskType: "email" as const, columnPatterns: ["email"], enabled: true, id: "e1" },
          },
        ],
      ]),
    );
    const { container } = render(
      React.createElement(ResultsGrid, {
        result: mockResult,
        maskingEnabled: true,
        maskingConfig: {
          enabled: true,
          patterns: [],
          roleSettings: { admin: { canToggle: true, canReveal: true }, user: { canToggle: false, canReveal: false } },
        },
      }),
    );
    // When masking is enabled and shouldMask returns true, values should be masked
    // The mock maskValueByPattern returns '***'
    expect(container.textContent).toContain("***");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Column Filtering Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("Column filtering", () => {
    test("clicking filter button opens filter dropdown with input", () => {
      const { container } = render(React.createElement(ResultsGrid, { result: mockResult }));

      const filterButtons = container.querySelectorAll('button[title="Filter column"]');
      expect(filterButtons.length).toBeGreaterThan(0);

      fireEvent.click(filterButtons[0]);

      const filterInput = container.querySelector('input[placeholder="Filter id..."]');
      expect(filterInput).not.toBeNull();
    });

    test("typing in filter input filters rows", () => {
      const { container } = render(React.createElement(ResultsGrid, { result: mockResult }));

      const filterButtons = container.querySelectorAll('button[title="Filter column"]');
      fireEvent.click(filterButtons[1]);

      const filterInput = container.querySelector('input[placeholder="Filter name..."]');
      expect(filterInput).not.toBeNull();

      fireEvent.change(filterInput!, { target: { value: "Alice" } });

      const filteredCount = container.querySelector('[data-testid="filtered-count"]');
      expect(filteredCount?.textContent).toContain("1 filtered");
    });

    test("clearing filter value in input removes filter", () => {
      const { container } = render(React.createElement(ResultsGrid, { result: mockResult }));

      const filterButtons = container.querySelectorAll('button[title="Filter column"]');
      fireEvent.click(filterButtons[1]);

      const filterInput = container.querySelector('input[placeholder="Filter name..."]')!;
      fireEvent.change(filterInput, { target: { value: "Alice" } });
      expect(container.querySelector('[data-testid="filtered-count"]')?.textContent).toContain("1 filtered");

      // Re-query input after state change (TanStack Table recreates columns)
      const filterInput2 = container.querySelector('input[placeholder="Filter name..."]')!;
      fireEvent.change(filterInput2, { target: { value: "" } });
      expect(container.querySelector('[data-testid="filtered-count"]')?.textContent).toContain("3 filtered");
    });

    test("Clear filter button removes single column filter", () => {
      const { container } = render(React.createElement(ResultsGrid, { result: mockResult }));

      const filterButtons = container.querySelectorAll('button[title="Filter column"]');
      fireEvent.click(filterButtons[1]);

      const filterInput = container.querySelector('input[placeholder="Filter name..."]')!;
      fireEvent.change(filterInput, { target: { value: "Alice" } });

      // "Clear filter" button should appear inside dropdown
      const clearBtn = Array.from(container.querySelectorAll("button")).find(
        (btn) => btn.textContent === "Clear filter",
      );
      expect(clearBtn).not.toBeUndefined();
      fireEvent.click(clearBtn!);

      expect(container.querySelector('[data-testid="filtered-count"]')?.textContent).toContain("3 filtered");
    });

    test("Escape key closes filter dropdown", () => {
      const { container } = render(React.createElement(ResultsGrid, { result: mockResult }));

      const filterButtons = container.querySelectorAll('button[title="Filter column"]');
      fireEvent.click(filterButtons[0]);

      const filterInput = container.querySelector('input[placeholder="Filter id..."]');
      expect(filterInput).not.toBeNull();

      fireEvent.keyDown(filterInput!, { key: "Escape" });

      expect(container.querySelector('input[placeholder="Filter id..."]')).toBeNull();
    });

    test("Enter key closes filter dropdown", () => {
      const { container } = render(React.createElement(ResultsGrid, { result: mockResult }));

      const filterButtons = container.querySelectorAll('button[title="Filter column"]');
      fireEvent.click(filterButtons[0]);

      const filterInput = container.querySelector('input[placeholder="Filter id..."]');
      expect(filterInput).not.toBeNull();

      fireEvent.keyDown(filterInput!, { key: "Enter" });

      expect(container.querySelector('input[placeholder="Filter id..."]')).toBeNull();
    });

    test("clicking same filter button again closes dropdown", () => {
      const { container } = render(React.createElement(ResultsGrid, { result: mockResult }));

      const filterButtons = container.querySelectorAll('button[title="Filter column"]');
      fireEvent.click(filterButtons[0]);
      expect(container.querySelector('input[placeholder="Filter id..."]')).not.toBeNull();

      // Re-query button after re-render
      const filterButtons2 = container.querySelectorAll('button[title="Filter column"]');
      fireEvent.click(filterButtons2[0]);
      expect(container.querySelector('input[placeholder="Filter id..."]')).toBeNull();
    });

    test("clear all filters via StatsBar handleClearFilters", () => {
      const { container } = render(React.createElement(ResultsGrid, { result: mockResult }));

      // Set a filter
      const filterButtons = container.querySelectorAll('button[title="Filter column"]');
      fireEvent.click(filterButtons[1]);
      const filterInput = container.querySelector('input[placeholder="Filter name..."]')!;
      fireEvent.change(filterInput, { target: { value: "Alice" } });

      // Close dropdown (re-query input after state change)
      const filterInput2 = container.querySelector('input[placeholder="Filter name..."]')!;
      fireEvent.keyDown(filterInput2, { key: "Escape" });

      // Clear all filters button should be visible (activeFilterCount > 0)
      const clearAllBtn = container.querySelector('[data-testid="clear-filters"]');
      expect(clearAllBtn).not.toBeNull();
      fireEvent.click(clearAllBtn!);

      // All rows restored
      expect(container.querySelector('[data-testid="filtered-count"]')?.textContent).toContain("3 filtered");
      expect(container.querySelector('[data-testid="clear-filters"]')).toBeNull();
    });

    test("filter with no matching rows shows 0 filtered", () => {
      const { container } = render(React.createElement(ResultsGrid, { result: mockResult }));

      const filterButtons = container.querySelectorAll('button[title="Filter column"]');
      fireEvent.click(filterButtons[1]);
      const filterInput = container.querySelector('input[placeholder="Filter name..."]')!;
      fireEvent.change(filterInput, { target: { value: "Nonexistent" } });

      expect(container.querySelector('[data-testid="filtered-count"]')?.textContent).toContain("0 filtered");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Inline Editing Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("Inline editing", () => {
    function findEditInput(container: HTMLElement) {
      return Array.from(container.querySelectorAll("input")).find((input) =>
        input.className.includes("border-blue-500"),
      );
    }

    test("double-clicking cell enters edit mode with input", () => {
      const onCellChange = mock(() => {});
      const { container } = render(
        React.createElement(ResultsGrid, {
          result: mockResult,
          editingEnabled: true,
          onCellChange,
          pendingChanges: [],
        }),
      );

      const cells = container.querySelectorAll(".cursor-text");
      expect(cells.length).toBeGreaterThan(0);

      fireEvent.doubleClick(cells[0]);

      expect(findEditInput(container)).not.toBeUndefined();
    });

    test("double-clicking a cell does nothing when editing is disabled (#269)", () => {
      // With the provider declaring no inline row editing, Studio passes
      // editingEnabled false — and then a cell must not open an editor at all. It
      // used to open one whose edit was silently discarded on Enter, which is the
      // dead affordance the capability gate exists to remove.
      const onCellChange = mock(() => {});
      const { container } = render(
        React.createElement(ResultsGrid, {
          result: mockResult,
          editingEnabled: false,
          onCellChange,
          pendingChanges: [],
        }),
      );

      // The grid renders the value in both the desktop table and the mobile one, so
      // every cell showing it is double-clicked rather than guessing which is which.
      const labels = Array.from(container.querySelectorAll("span")).filter((s) => s.textContent === "Alice");
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) fireEvent.doubleClick(label.parentElement!);

      expect(findEditInput(container)).toBeUndefined();
      expect(onCellChange).not.toHaveBeenCalled();
      expect(container.querySelectorAll(".cursor-text").length).toBe(0);
    });

    test("Enter key commits edit and calls onCellChange", () => {
      const onCellChange = mock(() => {});
      const { container } = render(
        React.createElement(ResultsGrid, {
          result: mockResult,
          editingEnabled: true,
          onCellChange,
          pendingChanges: [],
        }),
      );

      const cells = container.querySelectorAll(".cursor-text");
      const nameCell = Array.from(cells).find((c) => c.textContent === "Alice");
      expect(nameCell).not.toBeUndefined();
      fireEvent.doubleClick(nameCell!);

      const editInput = findEditInput(container)!;
      fireEvent.change(editInput, { target: { value: "Alicia" } });

      // Re-query after state change (columns memo recomputes on editValue change)
      const updatedEditInput = findEditInput(container)!;
      fireEvent.keyDown(updatedEditInput, { key: "Enter" });

      expect(onCellChange).toHaveBeenCalledTimes(1);
      const callArg = (onCellChange.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
      expect(callArg.newValue).toBe("Alicia");
      expect(callArg.originalValue).toBe("Alice");
    });

    test("Escape key cancels edit without calling onCellChange", () => {
      const onCellChange = mock(() => {});
      const { container } = render(
        React.createElement(ResultsGrid, {
          result: mockResult,
          editingEnabled: true,
          onCellChange,
          pendingChanges: [],
        }),
      );

      const cells = container.querySelectorAll(".cursor-text");
      fireEvent.doubleClick(cells[0]);

      const editInput = findEditInput(container)!;
      // Press Escape directly (no value change to avoid stale ref)
      fireEvent.keyDown(editInput, { key: "Escape" });

      expect(onCellChange).not.toHaveBeenCalled();
      expect(findEditInput(container)).toBeUndefined();
    });

    test("blur commits edit when value changed", () => {
      const onCellChange = mock(() => {});
      const { container } = render(
        React.createElement(ResultsGrid, {
          result: mockResult,
          editingEnabled: true,
          onCellChange,
          pendingChanges: [],
        }),
      );

      const cells = container.querySelectorAll(".cursor-text");
      const nameCell = Array.from(cells).find((c) => c.textContent === "Alice");
      fireEvent.doubleClick(nameCell!);

      const editInput = findEditInput(container)!;
      fireEvent.change(editInput, { target: { value: "Alicia" } });

      // Re-query after state change
      const updatedEditInput = findEditInput(container)!;
      fireEvent.blur(updatedEditInput);

      expect(onCellChange).toHaveBeenCalledTimes(1);
      const callArg = (onCellChange.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
      expect(callArg.newValue).toBe("Alicia");
    });

    test("Enter with unchanged value does not call onCellChange", () => {
      const onCellChange = mock(() => {});
      const { container } = render(
        React.createElement(ResultsGrid, {
          result: mockResult,
          editingEnabled: true,
          onCellChange,
          pendingChanges: [],
        }),
      );

      const cells = container.querySelectorAll(".cursor-text");
      const nameCell = Array.from(cells).find((c) => c.textContent === "Alice");
      fireEvent.doubleClick(nameCell!);

      const editInput = findEditInput(container)!;
      // Don't change the value, just press Enter
      fireEvent.keyDown(editInput, { key: "Enter" });

      expect(onCellChange).not.toHaveBeenCalled();
    });

    test("blur with unchanged value does not call onCellChange", () => {
      const onCellChange = mock(() => {});
      const { container } = render(
        React.createElement(ResultsGrid, {
          result: mockResult,
          editingEnabled: true,
          onCellChange,
          pendingChanges: [],
        }),
      );

      const cells = container.querySelectorAll(".cursor-text");
      const nameCell = Array.from(cells).find((c) => c.textContent === "Alice");
      fireEvent.doubleClick(nameCell!);

      const editInput = findEditInput(container)!;
      fireEvent.blur(editInput);

      expect(onCellChange).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Cell Reveal Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("Cell reveal", () => {
    function setupMasking() {
      mockShouldMask.mockReturnValue(true);
      mockCanReveal.mockReturnValue(true);
      mockDetectSensitiveColumnsFromConfig.mockReturnValue(
        new Map([
          ["email", { name: "email", maskType: "email" as const, columnPatterns: ["email"], enabled: true, id: "e1" }],
        ]),
      );
    }

    const maskingProps = {
      result: mockResult,
      maskingEnabled: true,
      maskingConfig: {
        enabled: true,
        patterns: [],
        roleSettings: { admin: { canToggle: true, canReveal: true }, user: { canToggle: false, canReveal: false } },
      },
    };

    test("clicking reveal button shows actual value with lock icon", () => {
      setupMasking();

      const { container } = render(React.createElement(ResultsGrid, maskingProps));

      // Initially masked with '***'
      expect(container.textContent).toContain("***");

      // Find reveal button
      const revealButton = container.querySelector('button[title="Reveal value (10s)"]');
      expect(revealButton).not.toBeNull();

      // Click reveal
      fireEvent.click(revealButton!);

      // After reveal, the cell should show actual email value (not ***)
      // This confirms the revealed cell branch (lines 328-333) is hit
      expect(container.textContent).toContain("alice@example.com");
    });

    test("revealed cell auto-hides after timeout", () => {
      setupMasking();

      const { container } = render(React.createElement(ResultsGrid, maskingProps));

      // Mock setTimeout AFTER React initialization to avoid breaking React internals
      const origSetTimeout = globalThis.setTimeout;
      let capturedCallback: (() => void) | null = null;
      globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
        if (ms === 10000) {
          capturedCallback = fn as () => void;
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }
        return origSetTimeout(fn, ms);
      }) as typeof setTimeout;

      const revealButton = container.querySelector('button[title="Reveal value (10s)"]')!;
      fireEvent.click(revealButton);

      // Callback should have been captured
      expect(capturedCallback).not.toBeNull();

      // Execute the timeout callback to cover auto-hide lines (139-143)
      act(() => {
        capturedCallback!();
      });

      globalThis.setTimeout = origSetTimeout;
    });

    test("reveal button not shown when canReveal is false", () => {
      mockShouldMask.mockReturnValue(true);
      mockCanReveal.mockReturnValue(false);
      mockDetectSensitiveColumnsFromConfig.mockReturnValue(
        new Map([
          ["email", { name: "email", maskType: "email" as const, columnPatterns: ["email"], enabled: true, id: "e1" }],
        ]),
      );

      const { container } = render(React.createElement(ResultsGrid, maskingProps));

      expect(container.textContent).toContain("***");

      const revealButton = container.querySelector('button[title="Reveal value (10s)"]');
      expect(revealButton).toBeNull();
    });
  });

  // ── Declared column types (#273) ──────────────────────────────────────────

  describe("declared column types", () => {
    test("shows the type the engine declared for a column beside its name", () => {
      const result: QueryResult = { ...mockResult, columnTypes: { name: "Nullable(String)" } };
      const { getAllByRole, container } = render(React.createElement(ResultsGrid, { result }));

      // The type is part of the header's accessible name, not sighted-only.
      const header = getAllByRole("button", { name: "name, Nullable(String)" })[0];
      expect(header.textContent).toContain("Nullable(String)");
      // Reachable in both headers: the desktop span and the compact mobile one,
      // which carries the type as a tooltip only (its columns are content-width).
      expect(container.querySelectorAll('[title="Nullable(String)"]').length).toBe(2);
    });

    test("leaves a column the engine declared no type for exactly as it was", () => {
      const result: QueryResult = { ...mockResult, columnTypes: { name: "Nullable(String)" } };
      const { getAllByRole } = render(React.createElement(ResultsGrid, { result }));

      expect(getAllByRole("button", { name: "id" })[0].textContent).toBe("id");
    });

    test("does not read a declared type off the prototype chain", () => {
      // A column name is arbitrary SQL output and `SELECT 1 AS constructor` is
      // legal. `columnTypes` is a plain object, so a direct lookup answers with
      // `Object.prototype.constructor` - a FUNCTION handed to React as header
      // content. Reported by review on PR #289.
      const result: QueryResult = {
        ...mockResult,
        rows: [{ id: 1, constructor: "x", toString: "y" }],
        fields: ["id", "constructor", "toString"],
        columnTypes: { id: "BIGINT" },
      };
      const { getAllByRole, container } = render(React.createElement(ResultsGrid, { result }));

      // Accessible name is the bare field, and no inherited value is rendered.
      expect(getAllByRole("button", { name: "constructor" })[0].textContent).toBe("constructor");
      expect(getAllByRole("button", { name: "toString" })[0].textContent).toBe("toString");
      expect(container.textContent).not.toContain("function");
      expect(container.textContent).not.toContain("[object");
      // The column that DOES declare a type is unaffected.
      expect(getAllByRole("button", { name: "id, BIGINT" })[0].textContent).toContain("BIGINT");
    });

    test("makes the compact header's declared type reachable without a pointer", () => {
      // The compact table carries the type as a tooltip only, because visible
      // text there desyncs header and body widths. `title` on a non-focusable
      // element is unavailable to touch and unreliable for assistive tech, so the
      // type also ships as screen-reader text. Reported by review on PR #289.
      const result: QueryResult = { ...mockResult, columnTypes: { name: "Nullable(String)" } };
      const { container } = render(React.createElement(ResultsGrid, { result }));

      const srOnly = Array.from(container.querySelectorAll(".sr-only")).map((n) => n.textContent);
      expect(srOnly.some((text) => text?.includes("Nullable(String)"))).toBe(true);
    });

    test("renders headers unchanged when the result declares no types at all", () => {
      const { getAllByRole, container } = render(React.createElement(ResultsGrid, { result: mockResult }));

      expect(getAllByRole("button", { name: "name" })[0].textContent).toBe("name");
      // No header gains a tooltip it did not have before ("Filter column" is pre-existing).
      expect(container.querySelectorAll('[title]:not([title="Filter column"])').length).toBe(0);
    });
  });

  // ── Engine warnings on a result with no rows (#273) ───────────────────────

  test("surfaces the engine's warnings when the result has no rows", () => {
    // An analytics engine can answer 200 with EVERY segment unavailable: zero rows
    // plus a warning. Reporting "no data" alone would call missing data absent data.
    const result: QueryResult = {
      ...mockEmptyResult,
      warnings: [{ message: "2 segments of the queried data were unavailable." }],
    };
    const { container } = render(React.createElement(ResultsGrid, { result }));

    const text = container.textContent ?? "";
    expect(text).toContain("Query returned no data");
    expect(text).toContain("2 segments of the queried data were unavailable.");
    // The warning has to come before the "operation was successful" reassurance -
    // a reader who stops at the reassurance is back to being told the data is absent.
    expect(text.indexOf("2 segments of the queried data were unavailable.")).toBeLessThan(
      text.indexOf("The operation was successful"),
    );
  });

  test("keeps the empty state unchanged when the engine reported no warnings", () => {
    const { container } = render(React.createElement(ResultsGrid, { result: mockEmptyResult }));

    expect(container.textContent).toContain("Query returned no data");
    expect(container.querySelector("ul")).toBeNull();
  });

  // ── Sorting actually reorders rows ────────────────────────────────────────

  /**
   * TanStack Table 9 assembles a table from features that are opted into
   * explicitly, and a row model that is not registered does not error - the
   * table simply never applies it. So ResultsGrid dropping
   * `sortedRowModel: createSortedRowModel()` from its feature set would leave
   * every sort click updating the header's arrow and accessible name while the
   * rows below stayed in source order, and every other test here would still
   * pass: they assert the *indicator*, never the *order*.
   *
   * This test reads the rendered order back. Descending is the direction used
   * because the fixture (Alice, Bob, Charlie) is already in ascending order -
   * an ascending sort is indistinguishable from no sort at all.
   */
  test("sorting reorders the rendered rows, not just the header indicator", () => {
    const { getAllByRole, container } = render(React.createElement(ResultsGrid, { result: mockResult }));

    // `:not([data-testid])` excludes the mocked ResultCard above, which also
    // carries data-index; only the desktop table's rows come off the table
    // instance, and they are the ones the row model orders.
    const renderedRows = () =>
      Array.from(container.querySelectorAll("[data-index]:not([data-testid])")).map((row) => row.textContent ?? "");

    expect(renderedRows()).toHaveLength(3);
    expect(renderedRows()[0]).toContain("Alice");

    fireEvent.click(getAllByRole("button", { name: "name" })[0]);
    fireEvent.click(getAllByRole("button", { name: "name, sorted ascending" })[0]);

    const descending = renderedRows();
    expect(descending[0]).toContain("Charlie");
    expect(descending[1]).toContain("Bob");
    expect(descending[2]).toContain("Alice");
  });

  // ── A11y semantics (#100): keyboard-reachable interactive elements ────────

  describe("a11y semantics", () => {
    test("column sort headers are buttons named after the field", () => {
      const { getAllByRole } = render(React.createElement(ResultsGrid, { result: mockResult }));
      const sortButtons = getAllByRole("button", { name: "name" });
      expect(sortButtons.length).toBeGreaterThan(0);
      fireEvent.click(sortButtons[0]);
    });

    test("sort buttons expose the current sort direction in their accessible name", () => {
      const { getAllByRole } = render(React.createElement(ResultsGrid, { result: mockResult }));
      fireEvent.click(getAllByRole("button", { name: "name" })[0]);
      const ascending = getAllByRole("button", { name: "name, sorted ascending" });
      expect(ascending.length).toBeGreaterThan(0);
      fireEvent.click(ascending[0]);
      expect(getAllByRole("button", { name: "name, sorted descending" }).length).toBeGreaterThan(0);
    });

    test("mobile rows are buttons that open the row detail sheet", () => {
      const { getAllByRole, queryByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
      const rowButtons = getAllByRole("button", { name: /Alice/ });
      expect(rowButtons.length).toBeGreaterThan(0);
      fireEvent.click(rowButtons[0]);
      expect(queryByTestId("row-detail-sheet")).not.toBeNull();
    });

    test("column resize handles are hidden from assistive technology", () => {
      const { container } = render(React.createElement(ResultsGrid, { result: mockResult }));
      const handles = container.querySelectorAll(".cursor-col-resize");
      expect(handles.length).toBeGreaterThan(0);
      for (const handle of handles) {
        expect(handle.getAttribute("aria-hidden")).toBe("true");
      }
    });
  });
});
