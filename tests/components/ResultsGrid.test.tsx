import "../setup-dom";
import { mockToastError, mockToastSuccess } from "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { mock } from "bun:test";
import React from "react";

const contextMenuContext = React.createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
} | null>(null);

const mockClipboardWriteText = mock((_text: string) => Promise.resolve());

const originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
const originalExecCommand = Object.getOwnPropertyDescriptor(globalThis.document, "execCommand");

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
const mockMaskValueByPattern = mock((_value?: unknown) => "***");
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

mock.module("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => {
    const [open, setOpen] = React.useState(false);
    return React.createElement(
      contextMenuContext.Provider,
      { value: { open, setOpen } },
      React.createElement("div", { "data-testid": "result-context-menu" }, children),
    );
  },
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => {
    const context = React.useContext(contextMenuContext);
    return context?.open ? React.createElement("div", { "data-testid": "context-menu-content" }, children) : null;
  },
  ContextMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) =>
    React.createElement("button", { type: "button", role: "menuitem", onClick }, children),
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => {
    const context = React.useContext(contextMenuContext);
    return React.createElement(
      "div",
      {
        "data-testid": "context-menu-trigger",
        onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => {
          event.preventDefault();
          context?.setOpen(true);
        },
      },
      children,
    );
  },
}));

// ── Mock sub-components to simplify testing ─────────────────────────────────
mock.module("@/components/results-grid/ResultCard", () => ({
  ResultCard: (props: Record<string, unknown>) =>
    React.createElement(
      "div",
      {
        "data-testid": "result-card",
        "data-index": props.index,
        // The card decides its own preview fields from this list, so what it is HANDED is
        // the whole of the question here (#870).
        "data-fields": (props.fields as string[]).join(","),
        // What the card is handed about vector columns, which it reads per preview field.
        "data-vector-columns": JSON.stringify(props.vectorColumns ?? null),
      },
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "result-card-content",
          onClick: props.onSelect as () => void,
        },
        "Card content",
      ),
    ),
}));

mock.module("@/components/results-grid/RowDetailSheet", () => ({
  RowDetailSheet: (props: Record<string, unknown>) =>
    props.isOpen
      ? React.createElement(
          "div",
          {
            "data-testid": "row-detail-sheet",
            "data-row-index": String(props.rowIndex),
            "data-vector-columns": JSON.stringify(props.vectorColumns ?? null),
          },
          "Row Detail",
        )
      : null,
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
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "view-card",
          onClick: () => (props.onSetViewMode as (mode: "card" | "table") => void)("card"),
        },
        "Card",
      ),
      React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "view-table",
          onClick: () => (props.onSetViewMode as (mode: "card" | "table") => void)("table"),
        },
        "Table",
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
      props.onToggleWrapText
        ? React.createElement(
            "button",
            { "data-testid": "wrap-toggle", onClick: props.onToggleWrapText as () => void },
            "WRAP",
          )
        : null,
      (props.activeFilterCount as number) > 0
        ? React.createElement(
            "button",
            { "data-testid": "clear-filters", onClick: props.onClearFilters as () => void },
            "Clear Filters",
          )
        : null,
      // The notice itself is rendered and worded in StatsBar; what this file is about is
      // the DECISION ResultsGrid makes, so the mock only reports the prop it was handed.
      props.orderAcrossPagesUnspecified
        ? React.createElement("span", { "data-testid": "order-notice" }, "order notice")
        : null,
      // Same for the load-more control. It used to be a separate `LoadMoreFooter` export
      // rendered BELOW the grid, and this file stubbed that too; the control now lives in
      // the stats strip, so the only thing left for ResultsGrid to get right is whether it
      // hands down an offer at all, and with what page size. Rendering it inside the
      // stats-bar stub is also what lets a test assert the grid grew no chrome below.
      // The menu is rendered and worded in StatsBar; what this file is about is whether
      // ResultsGrid hands down a writer and what that writer does to the table, so the
      // stub only reports the prop and flips one known field through it.
      props.onToggleColumn
        ? React.createElement(
            "button",
            {
              "data-testid": "toggle-column",
              "data-hidden": [...((props.hiddenColumns as Set<string>) ?? [])].join(","),
              onClick: () => (props.onToggleColumn as (f: string) => void)("name"),
            },
            "toggle name",
          )
        : null,
      props.pageOffer
        ? React.createElement(
            "button",
            {
              "data-testid": "page-offer",
              "data-loading": String(props.isLoadingMore === true),
              onClick: (props.pageOffer as { onLoadMore: () => void }).onLoadMore,
            },
            `offer ${(props.pageOffer as { pageSize: number }).pageSize}`,
          )
        : null,
    ),
}));

// ── Mock @tanstack/react-virtual ────────────────────────────────────────────
const mockVirtualizerMeasure = mock(() => {});
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
    measureElement: () => {},
    measure: mockVirtualizerMeasure,
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
import { render, fireEvent, cleanup, act, waitFor, within } from "@testing-library/react";
import { ResultsGrid, type CellChange } from "@/components/ResultsGrid";
import { getHeaderFitColumnSize } from "@/components/results-grid/column-sizing";
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

function findContextMenuForMode(
  container: HTMLElement,
  text: string,
  mode: "card" | "mobile" | "desktop",
): HTMLElement {
  const contextMenu = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="result-context-menu"]')).find(
    (candidate) => {
      const trigger = candidate.querySelector<HTMLElement>('[data-testid="context-menu-trigger"]');
      const triggerChild = trigger?.firstElementChild;
      const isMode =
        mode === "card"
          ? candidate.querySelector('[data-testid="result-card"]') !== null
          : mode === "mobile"
            ? triggerChild?.tagName === "BUTTON"
            : candidate.closest("[data-desktop-grid]") !== null;
      return isMode && candidate.textContent?.includes(text);
    },
  );

  if (!contextMenu) {
    throw new Error(`Could not find the ${mode} context menu containing ${text}`);
  }

  return contextMenu;
}

function findDesktopCell(container: HTMLElement, text: string): HTMLElement | undefined {
  const row = findDesktopRow(container, text);
  return row
    ? Array.from(row.querySelectorAll<HTMLElement>(".cursor-text")).find((cell) => cell.textContent === text)
    : undefined;
}

// Both tables key their rows by `data-index` now that the mobile one measures its own
// wrapped height, so the desktop grid has to be named to reach only its rows.
function findDesktopRow(container: HTMLElement, text: string): HTMLElement | undefined {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-desktop-grid] [data-index]:not([data-testid])"),
  ).find((row) => row.textContent?.includes(text));
}

function findDesktopHeader(container: HTMLElement, field: string): HTMLElement {
  const header = Array.from(container.querySelectorAll<HTMLElement>("[data-desktop-grid] .cursor-col-resize"))
    .map((handle) => handle.parentElement)
    .find((candidate) =>
      candidate?.querySelector<HTMLButtonElement>("button")?.getAttribute("aria-label")?.startsWith(field),
    );

  if (!header) throw new Error(`Could not find the desktop header for ${field}`);
  return header;
}

// =============================================================================
// ResultsGrid Tests
// =============================================================================

describe("ResultsGrid", () => {
  afterEach(() => {
    cleanup();
    mockClipboardWriteText.mockReset();
    mockToastError.mockClear();
    mockToastSuccess.mockClear();
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: originalClipboard?.value,
    });
    Object.defineProperty(globalThis.document, "execCommand", {
      configurable: true,
      value: originalExecCommand?.value,
    });
  });

  beforeEach(() => {
    mockShouldMask.mockClear();
    mockCanToggleMasking.mockClear();
    mockCanReveal.mockClear();
    mockDetectSensitiveColumnsFromConfig.mockClear();
    mockMaskValueByPattern.mockClear();
    mockDetectSensitiveColumnsFromConfig.mockReturnValue(new Map());
    mockMaskValueByPattern.mockReturnValue("***");
    mockShouldMask.mockReturnValue(false);
    mockClipboardWriteText.mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: mockClipboardWriteText },
    });
  });

  // ── 1. Renders "No results" when result has empty rows ────────────────────

  test("renders empty state when result has empty rows", () => {
    const { queryByText } = render(React.createElement(ResultsGrid, { result: mockEmptyResult }));

    expect(queryByText("Query returned no data")).not.toBeNull();
  });

  // ── A write's affected-row count (#1425) ──────────────────────────────────

  test("says how many rows a write affected instead of the empty state", () => {
    const { container } = render(React.createElement(ResultsGrid, { result: { ...mockEmptyResult, rowCount: 10 } }));

    expect(container.textContent).toContain("10 rows affected");
    expect(container.textContent).not.toContain("Query returned no data");
    expect(container.textContent).not.toContain("result set is currently empty");
  });

  test("uses the singular for a single affected row", () => {
    const { container } = render(React.createElement(ResultsGrid, { result: { ...mockEmptyResult, rowCount: 1 } }));

    expect(container.textContent).toContain("1 row affected");
    expect(container.textContent).not.toContain("1 rows");
  });

  test("says the count was rolled back when the run recorded a confirmed rollback", () => {
    const { container } = render(
      React.createElement(ResultsGrid, { result: { ...mockEmptyResult, rowCount: 3, rolledBack: true } }),
    );

    expect(container.textContent).toContain("3 rows affected, rolled back");
  });

  test("keeps the empty state for a SELECT that matched nothing", () => {
    const { container } = render(
      React.createElement(ResultsGrid, { result: { ...mockEmptyResult, fields: ["id"], rowCount: 0 } }),
    );

    expect(container.textContent).toContain("Query returned no data");
  });

  // ── 2. Renders column headers from result.fields ──────────────────────────

  test("renders desktop-table column headers from result.fields", () => {
    const { getAllByRole, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
    fireEvent.click(getByTestId("view-table"));

    expect(getAllByRole("button", { name: "id" }).length).toBeGreaterThan(0);
    expect(getAllByRole("button", { name: "name" }).length).toBeGreaterThan(0);
    expect(getAllByRole("button", { name: "email" }).length).toBeGreaterThan(0);
  });

  test("sizes desktop result columns from field names, not cell values", () => {
    const result: QueryResult = {
      rows: [{ id: "a very long value that must not affect the initial width", name: "x" }],
      fields: ["id", "name"],
      rowCount: 1,
      executionTime: 1,
    };
    const { container } = render(React.createElement(ResultsGrid, { result }));

    expect(findDesktopHeader(container, "id").style.width).toBe(`${getHeaderFitColumnSize("id")}px`);
    expect(findDesktopHeader(container, "name").style.width).toBe(`${getHeaderFitColumnSize("name")}px`);

    cleanup();

    const shortValueResult: QueryResult = {
      ...result,
      rows: [{ id: "1", name: "short" }],
    };
    const shortValueRender = render(React.createElement(ResultsGrid, { result: shortValueResult }));
    expect(findDesktopHeader(shortValueRender.container, "id").style.width).toBe(`${getHeaderFitColumnSize("id")}px`);
    expect(findDesktopHeader(shortValueRender.container, "name").style.width).toBe(
      `${getHeaderFitColumnSize("name")}px`,
    );

    const longField = "x".repeat(200);
    const longFieldRender = render(
      React.createElement(ResultsGrid, {
        result: { ...result, fields: [longField], rows: [{ [longField]: "short" }] },
      }),
    );
    expect(
      findDesktopHeader(longFieldRender.container, longField).querySelector("span.truncate")?.getAttribute("title"),
    ).toBe(longField);
  });

  // ── 3. Renders data rows from result.rows ─────────────────────────────────

  test("renders desktop-table data rows from result.rows", () => {
    const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
    fireEvent.click(getByTestId("view-table"));

    expect(findDesktopRow(container, "Alice")).not.toBeUndefined();
    expect(findDesktopRow(container, "Bob")).not.toBeUndefined();
    expect(findDesktopRow(container, "Charlie")).not.toBeUndefined();
  });

  test("renders cell and row actions for a right-clicked mobile-table cell", () => {
    const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
    fireEvent.click(getByTestId("view-table"));
    const contextMenu = findContextMenuForMode(container, "Alice", "mobile");

    fireEvent.contextMenu(within(contextMenu).getByText("Alice"));

    expect(within(contextMenu).getByRole("menuitem", { name: "Copy Cell" })).not.toBeNull();
    expect(within(contextMenu).getByRole("menuitem", { name: "Copy Row as JSON" })).not.toBeNull();
  });

  test("renders only the row action for card, mobile-table, and desktop-table row backgrounds", () => {
    const { container, getAllByTestId, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));

    fireEvent.click(getByTestId("view-card"));
    const cardContent = getAllByTestId("result-card-content")[0];
    const cardMenu = findContextMenuForMode(container, "Card content", "card");
    fireEvent.contextMenu(cardContent);
    expect(within(cardMenu!).queryByRole("menuitem", { name: "Copy Cell" })).toBeNull();
    expect(within(cardMenu!).getByRole("menuitem", { name: "Copy Row as JSON" })).not.toBeNull();

    fireEvent.click(getByTestId("view-table"));
    const mobileMenu = findContextMenuForMode(container, "Alice", "mobile");
    const mobileRow = mobileMenu.querySelector<HTMLElement>('[data-testid="context-menu-trigger"]')?.firstElementChild;
    expect(mobileRow).not.toBeNull();
    fireEvent.contextMenu(mobileRow!);
    expect(within(mobileMenu).queryByRole("menuitem", { name: "Copy Cell" })).toBeNull();
    expect(within(mobileMenu).getByRole("menuitem", { name: "Copy Row as JSON" })).not.toBeNull();

    fireEvent.click(getByTestId("view-table"));
    const desktopMenu = findContextMenuForMode(container, "Alice", "desktop");
    const desktopRow = desktopMenu.querySelector<HTMLElement>("[data-index]:not([data-testid])");
    expect(desktopRow).not.toBeNull();
    fireEvent.contextMenu(desktopRow!);
    expect(within(desktopMenu!).queryByRole("menuitem", { name: "Copy Cell" })).toBeNull();
    expect(within(desktopMenu!).getByRole("menuitem", { name: "Copy Row as JSON" })).not.toBeNull();
  });

  test("clears a stale mobile-table cell action after switching to card mode", () => {
    const { container, getAllByTestId, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
    fireEvent.click(getByTestId("view-table"));

    const mobileMenu = findContextMenuForMode(container, "Alice", "mobile");
    fireEvent.contextMenu(within(mobileMenu).getByText("Alice"));
    expect(within(mobileMenu).getByRole("menuitem", { name: "Copy Cell" })).not.toBeNull();

    fireEvent.click(getByTestId("view-card"));
    const cardContent = getAllByTestId("result-card-content")[0];
    const cardMenu = findContextMenuForMode(container, "Card content", "card");
    fireEvent.contextMenu(cardContent);
    expect(within(cardMenu).queryByRole("menuitem", { name: "Copy Cell" })).toBeNull();
    expect(within(cardMenu).getByRole("menuitem", { name: "Copy Row as JSON" })).not.toBeNull();
  });

  test("renders cell and row actions for a right-clicked desktop-table cell", () => {
    const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
    fireEvent.click(getByTestId("view-table"));
    const contextMenu = findContextMenuForMode(container, "Alice", "desktop");

    fireEvent.contextMenu(within(contextMenu).getByText("Alice"));

    expect(within(contextMenu).getByRole("menuitem", { name: "Copy Cell" })).not.toBeNull();
    expect(within(contextMenu).getByRole("menuitem", { name: "Copy Row as JSON" })).not.toBeNull();
  });

  test("copies the right-clicked mobile-table cell value", async () => {
    const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
    fireEvent.click(getByTestId("view-table"));
    const contextMenu = findContextMenuForMode(container, "Alice", "mobile");

    fireEvent.contextMenu(within(contextMenu).getByText("Alice"));
    fireEvent.click(within(contextMenu).getByRole("menuitem", { name: "Copy Cell" }));

    await waitFor(() => expect(mockClipboardWriteText).toHaveBeenCalledWith("Alice"));
    expect(mockToastSuccess).toHaveBeenCalledWith("Cell copied to clipboard");
  });

  test("copies the displayed mobile-table pending-edit value", async () => {
    const pendingChanges: CellChange[] = [
      { rowIndex: 0, columnId: "name", originalValue: "Alice", newValue: "Alicia" },
    ];
    const { container, getByTestId } = render(
      React.createElement(ResultsGrid, {
        result: mockResult,
        editingEnabled: true,
        pendingChanges,
      }),
    );
    fireEvent.click(getByTestId("view-table"));

    const contextMenu = findContextMenuForMode(container, "Alicia", "mobile");
    const displayedCell = within(contextMenu).getByText("Alicia");
    expect(displayedCell).not.toBeNull();
    fireEvent.contextMenu(displayedCell);
    fireEvent.click(within(contextMenu).getByRole("menuitem", { name: "Copy Cell" }));

    await waitFor(() => expect(mockClipboardWriteText).toHaveBeenCalledWith("Alicia"));
  });

  test("copies the pending value for the sorted desktop row, not its virtual position", async () => {
    const result: QueryResult = {
      rows: [
        { id: 1, name: "Alice" },
        { id: 2, name: "Charlie" },
      ],
      fields: ["id", "name"],
      rowCount: 2,
      executionTime: 1,
    };
    const pendingChanges: CellChange[] = [
      { rowIndex: 1, columnId: "name", originalValue: "Charlie", newValue: "Charles" },
    ];
    const { container, getAllByRole, getByTestId } = render(
      React.createElement(ResultsGrid, { result, editingEnabled: true, pendingChanges }),
    );

    fireEvent.click(getByTestId("view-table"));
    fireEvent.click(getAllByRole("button", { name: "name" })[0]);
    fireEvent.click(getAllByRole("button", { name: "name, sorted ascending" })[0]);

    const contextMenu = findContextMenuForMode(container, "Charles", "desktop");
    fireEvent.contextMenu(within(contextMenu).getByText("Charles"));
    fireEvent.click(within(contextMenu).getByRole("menuitem", { name: "Copy Cell" }));

    await waitFor(() => expect(mockClipboardWriteText).toHaveBeenCalledWith("Charles"));
  });

  test("copies the filtered desktop cell by its place in the result, not in the filter", async () => {
    // The desktop table is built over the FILTERED rows, so TanStack's `row.index` is a
    // position in that array, while a pending change and a reveal are both addressed by
    // the position in `result.rows`. Copy has to read the same number the cell drew, or
    // it puts a value on the clipboard that is not the one on screen.
    const result: QueryResult = {
      rows: [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
        { id: 3, name: "Charlie" },
      ],
      fields: ["id", "name"],
      rowCount: 3,
      executionTime: 1,
    };
    const pendingChanges: CellChange[] = [
      { rowIndex: 2, columnId: "name", originalValue: "Charlie", newValue: "Charles" },
    ];
    const { container, getByTestId } = render(
      React.createElement(ResultsGrid, { result, editingEnabled: true, pendingChanges }),
    );
    fireEvent.click(getByTestId("view-table"));

    fireEvent.click(container.querySelectorAll('button[title="Filter column"]')[1]);
    fireEvent.change(container.querySelector('input[placeholder="Filter name..."]')!, {
      target: { value: "Charl" },
    });

    const contextMenu = findContextMenuForMode(container, "Charles", "desktop");
    fireEvent.contextMenu(within(contextMenu).getByText("Charles"));
    fireEvent.click(within(contextMenu).getByRole("menuitem", { name: "Copy Cell" }));

    await waitFor(() => expect(mockClipboardWriteText).toHaveBeenCalledWith("Charles"));
  });

  test("Copy Cell on a bytea value copies the whole value, not the cell's preview", async () => {
    // Reproduces the defect first: the grid cell shows the first 32 bytes and the size, and Copy Cell used to
    // copy that preview, 77 characters for a 100-byte value, which no reader could paste back as the value.
    const bytes = Array.from({ length: 100 }, (_, index) => index);
    const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const preview = `\\x${hex.slice(0, 64)}... (100 B)`;
    const result: QueryResult = {
      rows: [{ id: 1, payload: { type: "Buffer", data: bytes } }],
      fields: ["id", "payload"],
      rowCount: 1,
      executionTime: 1,
      columnTypes: { id: "int4", payload: "bytea" },
    };
    expect(preview).toHaveLength(77);

    const { container, getByTestId } = render(React.createElement(ResultsGrid, { result }));
    fireEvent.click(getByTestId("view-table"));
    for (const mode of ["desktop", "mobile"] as const) {
      mockClipboardWriteText.mockClear();
      const contextMenu = findContextMenuForMode(container, preview, mode);
      fireEvent.contextMenu(within(contextMenu).getByText(preview));
      fireEvent.click(within(contextMenu).getByRole("menuitem", { name: "Copy Cell" }));
      // oxlint-disable-next-line no-await-in-loop -- one copy per table, each read from a cleared clipboard mock.
      await waitFor(() => expect(mockClipboardWriteText).toHaveBeenCalledWith(`\\x${hex}`));
    }
  });

  describe("vector columns (vector-family spec 3.10)", () => {
    const DIMENSION = 768;
    const embedding = Array.from({ length: DIMENSION }, (_, index) => ((index % 9) - 4) / 4);
    const DISPLAY = "[-1.0, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, …] 768 dims";
    const COPY = `[${embedding.map((value) => (Number.isInteger(value) ? value.toFixed(1) : String(value))).join(",")}]`;
    const vectorResult: QueryResult = {
      rows: [{ id: 1, embedding }],
      fields: ["id", "embedding"],
      rowCount: 1,
      executionTime: 1,
      vectorColumns: { embedding: { kind: "dense", dtype: "float32", dimension: DIMENSION } },
    };

    test("a declared vector column draws the vector cell in the desktop and the mobile table", () => {
      const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: vectorResult }));
      fireEvent.click(getByTestId("view-table"));
      expect(within(findContextMenuForMode(container, DISPLAY, "desktop")).getByText(DISPLAY)).not.toBeNull();
      expect(within(findContextMenuForMode(container, DISPLAY, "mobile")).getByText(DISPLAY)).not.toBeNull();
    });

    test("Copy Cell on a declared vector cell copies the whole value as compact JSON", async () => {
      const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: vectorResult }));
      fireEvent.click(getByTestId("view-table"));
      for (const mode of ["desktop", "mobile"] as const) {
        mockClipboardWriteText.mockClear();
        const contextMenu = findContextMenuForMode(container, DISPLAY, mode);
        fireEvent.contextMenu(within(contextMenu).getByText(DISPLAY));
        fireEvent.click(within(contextMenu).getByRole("menuitem", { name: "Copy Cell" }));
        // oxlint-disable-next-line no-await-in-loop -- one copy per table, each read from a cleared clipboard mock.
        await waitFor(() => expect(mockClipboardWriteText).toHaveBeenCalledWith(COPY));
      }
    });

    test("the same array in a column the result does not declare draws and copies as the JSON it was", async () => {
      const json = JSON.stringify(embedding);
      const { container, getByTestId } = render(
        React.createElement(ResultsGrid, { result: { ...vectorResult, vectorColumns: undefined } }),
      );
      fireEvent.click(getByTestId("view-table"));
      const contextMenu = findContextMenuForMode(container, json, "desktop");
      fireEvent.contextMenu(within(contextMenu).getByText(json));
      fireEvent.click(within(contextMenu).getByRole("menuitem", { name: "Copy Cell" }));
      await waitFor(() => expect(mockClipboardWriteText).toHaveBeenCalledWith(json));
    });

    test("a masked vector column shows and copies its mask, never the vector", async () => {
      mockShouldMask.mockReturnValue(true);
      mockDetectSensitiveColumnsFromConfig.mockReturnValue(new Map([["embedding", "custom"]]));
      const { container, getByTestId } = render(
        React.createElement(ResultsGrid, { result: vectorResult, maskingEnabled: true }),
      );
      fireEvent.click(getByTestId("view-table"));
      const contextMenu = findContextMenuForMode(container, "***", "desktop");
      expect(within(contextMenu).queryByText(DISPLAY)).toBeNull();
      fireEvent.contextMenu(within(contextMenu).getByText("***"));
      fireEvent.click(within(contextMenu).getByRole("menuitem", { name: "Copy Cell" }));
      await waitFor(() => expect(mockClipboardWriteText).toHaveBeenCalledWith("***"));
    });

    test("a column named like an Object.prototype member is not taken for a declared vector", () => {
      const result: QueryResult = {
        rows: [{ constructor: [1, 2] }],
        fields: ["constructor"],
        rowCount: 1,
        executionTime: 1,
        vectorColumns: vectorResult.vectorColumns,
      };
      const { container, getByTestId } = render(React.createElement(ResultsGrid, { result }));
      fireEvent.click(getByTestId("view-table"));
      expect(within(findContextMenuForMode(container, "[1,2]", "desktop")).getByText("[1,2]")).not.toBeNull();
    });

    test("the card view and the row detail are handed the result's vector columns", () => {
      const declared = JSON.stringify(vectorResult.vectorColumns);
      const { getAllByTestId, getByTestId } = render(React.createElement(ResultsGrid, { result: vectorResult }));
      expect(getAllByTestId("result-card")[0].getAttribute("data-vector-columns")).toBe(declared);
      fireEvent.click(getAllByTestId("result-card-content")[0]);
      expect(getByTestId("row-detail-sheet").getAttribute("data-vector-columns")).toBe(declared);
    });
  });

  test("offers no cell action for the row-detail column", () => {
    // That column holds a control, not a value, so there is nothing in it to copy.
    const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
    fireEvent.click(getByTestId("view-table"));
    const contextMenu = findContextMenuForMode(container, "Alice", "desktop");

    fireEvent.contextMenu(within(contextMenu).getByText("Alice"));
    expect(within(contextMenu).getByRole("menuitem", { name: "Copy Cell" })).not.toBeNull();

    fireEvent.contextMenu(contextMenu.querySelector("[data-row-detail]")!);

    expect(within(contextMenu).queryByRole("menuitem", { name: "Copy Cell" })).toBeNull();
    expect(within(contextMenu).getByRole("menuitem", { name: "Copy Row as JSON" })).not.toBeNull();
  });

  test("copies the right-clicked mobile-table row as formatted JSON", async () => {
    const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
    fireEvent.click(getByTestId("view-table"));
    const contextMenu = findContextMenuForMode(container, "Alice", "mobile");

    fireEvent.contextMenu(within(contextMenu).getByText("Alice"));
    fireEvent.click(within(contextMenu).getByRole("menuitem", { name: "Copy Row as JSON" }));

    await waitFor(() =>
      expect(mockClipboardWriteText).toHaveBeenCalledWith(JSON.stringify(mockResult.rows[0], null, 2)),
    );
    expect(mockToastSuccess).toHaveBeenCalledWith("Row copied to clipboard");
  });

  test("copies nested and null row values as exact JSON", async () => {
    const row = { id: 1, name: "Nested", metadata: { active: true }, tags: ["a", "b"], missing: null };
    const result: QueryResult = {
      rows: [row],
      fields: ["id", "name", "metadata", "tags", "missing"],
      rowCount: 1,
      executionTime: 1,
    };
    const { container, getByTestId } = render(React.createElement(ResultsGrid, { result }));
    fireEvent.click(getByTestId("view-table"));
    const contextMenu = findContextMenuForMode(container, "Nested", "mobile");

    fireEvent.contextMenu(within(contextMenu).getByText("Nested"));
    fireEvent.click(within(contextMenu).getByRole("menuitem", { name: "Copy Row as JSON" }));

    await waitFor(() => expect(mockClipboardWriteText).toHaveBeenCalledWith(JSON.stringify(row, null, 2)));
  });

  // The cell shows `\x` hex, and the copied row used to carry the Buffer form instead,
  // one number per byte (#1381). The row copies what the grid and the CSV show.
  test("copies a binary cell as the hex the grid shows, not as the Buffer form", async () => {
    const result: QueryResult = {
      rows: [{ name: "Blob", payload: { type: "Buffer", data: [0xde, 0xad, 0x00, 0xff] } }],
      fields: ["name", "payload"],
      rowCount: 1,
      executionTime: 1,
    };
    const { container, getByTestId } = render(React.createElement(ResultsGrid, { result }));
    fireEvent.click(getByTestId("view-table"));
    const contextMenu = findContextMenuForMode(container, "Blob", "mobile");

    fireEvent.contextMenu(within(contextMenu).getByText("Blob"));
    fireEvent.click(within(contextMenu).getByRole("menuitem", { name: "Copy Row as JSON" }));

    await waitFor(() =>
      expect(mockClipboardWriteText).toHaveBeenCalledWith(
        JSON.stringify({ name: "Blob", payload: "\\xdead00ff" }, null, 2),
      ),
    );
  });

  // `JSON.stringify` throws on a bigint, which took the copy down with no clipboard
  // write and no toast; the row now goes through `jsonText`, which writes the digits.
  test("copies a bigint cell as its digits instead of throwing", async () => {
    const result: QueryResult = {
      rows: [{ name: "Big", n: BigInt("9007199254740993") }],
      fields: ["name", "n"],
      rowCount: 1,
      executionTime: 1,
    };
    const { container, getByTestId } = render(React.createElement(ResultsGrid, { result }));
    fireEvent.click(getByTestId("view-table"));
    const contextMenu = findContextMenuForMode(container, "Big", "mobile");

    fireEvent.contextMenu(within(contextMenu).getByText("Big"));
    expect(() =>
      fireEvent.click(within(contextMenu).getByRole("menuitem", { name: "Copy Row as JSON" })),
    ).not.toThrow();

    await waitFor(() =>
      expect(mockClipboardWriteText).toHaveBeenCalledWith(
        JSON.stringify({ name: "Big", n: "9007199254740993" }, null, 2),
      ),
    );
  });

  test("copies an unmasked binary cell as hex when masking is active", async () => {
    mockShouldMask.mockReturnValue(true);
    mockDetectSensitiveColumnsFromConfig.mockReturnValue(new Map([["email", "email"]]));
    const result: QueryResult = {
      rows: [{ name: "Blob", email: "a@b.c", payload: { type: "Buffer", data: [0x00, 0xff] } }],
      fields: ["name", "email", "payload"],
      rowCount: 1,
      executionTime: 1,
    };
    const { container, getByTestId } = render(React.createElement(ResultsGrid, { result, maskingEnabled: true }));
    fireEvent.click(getByTestId("view-table"));
    const contextMenu = findContextMenuForMode(container, "Blob", "mobile");

    fireEvent.contextMenu(within(contextMenu).getByText("Blob"));
    fireEvent.click(within(contextMenu).getByRole("menuitem", { name: "Copy Row as JSON" }));

    await waitFor(() =>
      expect(mockClipboardWriteText).toHaveBeenCalledWith(
        JSON.stringify({ name: "Blob", email: "***", payload: "\\x00ff" }, null, 2),
      ),
    );
  });

  test("copies masked mobile-table cell and row values when masking is active", async () => {
    mockShouldMask.mockReturnValue(true);
    mockDetectSensitiveColumnsFromConfig.mockReturnValue(new Map([["email", "email"]]));

    const { container, getByTestId } = render(
      React.createElement(ResultsGrid, { result: mockResult, maskingEnabled: true }),
    );
    fireEvent.click(getByTestId("view-table"));
    const contextMenu = findContextMenuForMode(container, "Alice", "mobile");

    fireEvent.contextMenu(within(contextMenu).getByText("***"));
    fireEvent.click(within(contextMenu).getByRole("menuitem", { name: "Copy Cell" }));
    await waitFor(() => expect(mockClipboardWriteText).toHaveBeenCalledWith("***"));

    fireEvent.click(within(contextMenu).getByRole("menuitem", { name: "Copy Row as JSON" }));
    await waitFor(() =>
      expect(mockClipboardWriteText).toHaveBeenLastCalledWith(
        JSON.stringify({ id: 1, name: "Alice", email: "***" }, null, 2),
      ),
    );
  });

  test("reports mobile-table clipboard failures for cell actions", async () => {
    mockClipboardWriteText.mockRejectedValue(new Error("clipboard unavailable"));
    Object.defineProperty(globalThis.document, "execCommand", {
      configurable: true,
      value: () => false,
    });

    const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
    fireEvent.click(getByTestId("view-table"));
    const contextMenu = findContextMenuForMode(container, "Alice", "mobile");

    fireEvent.contextMenu(within(contextMenu).getByText("Alice"));
    fireEvent.click(within(contextMenu).getByRole("menuitem", { name: "Copy Cell" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Could not copy Cell — select the text and copy it yourself"),
    );
  });

  test("reports mobile-table clipboard failures for row-copy actions", async () => {
    mockClipboardWriteText.mockRejectedValue(new Error("clipboard unavailable"));
    Object.defineProperty(globalThis.document, "execCommand", {
      configurable: true,
      value: () => false,
    });

    const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
    fireEvent.click(getByTestId("view-table"));
    const contextMenu = findContextMenuForMode(container, "Alice", "mobile");

    fireEvent.contextMenu(within(contextMenu).getByText("Alice"));
    fireEvent.click(within(contextMenu).getByRole("menuitem", { name: "Copy Row as JSON" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Could not copy Row — select the text and copy it yourself"),
    );
  });

  /**
   * Hiding a column stops the grid emitting it (#870).
   *
   * `columnVisibilityFeature` was registered here with no writer, so the assertion that
   * matters is not that a menu exists but that the table state it writes reaches
   * `row.getVisibleCells()`. The header AND a cell value are both asserted: a column
   * dropped from the header while its cells still render would misalign every row.
   */
  test("stops rendering a column the stats strip hid", () => {
    const { getByTestId, queryAllByText } = render(React.createElement(ResultsGrid, { result: mockResult }));

    expect(queryAllByText("name").length).toBeGreaterThan(0);
    expect(queryAllByText("Alice").length).toBeGreaterThan(0);

    fireEvent.click(getByTestId("toggle-column"));

    expect(queryAllByText("name").length).toBe(0);
    expect(queryAllByText("Alice").length).toBe(0);
    expect(getByTestId("toggle-column").getAttribute("data-hidden")).toBe("name");
    // The control: a column nobody hid is untouched.
    expect(queryAllByText("email").length).toBeGreaterThan(0);
  });

  /**
   * The card view hides it too (#870).
   *
   * Cards are what this grid renders on a phone and what a desktop reader can switch to,
   * and they take their preview fields from the list they are handed. Handed
   * `result.fields` they show a column the reader hid a moment earlier in the table, which
   * is the same split the mobile table had: one hidden column, two answers on one result
   * depending on which view is open.
   */
  test("stops handing a hidden column to the card view", () => {
    const { getByTestId, getAllByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));

    expect(getAllByTestId("result-card")[0]!.getAttribute("data-fields")).toContain("name");

    fireEvent.click(getByTestId("toggle-column"));

    const fields = getAllByTestId("result-card")[0]!.getAttribute("data-fields")!;
    expect(fields.split(",")).not.toContain("name");
    // The control: the columns nobody hid are still handed over.
    expect(fields.split(",")).toContain("email");
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
        supportsResultPagination: true,
      }),
    );

    const offer = queryByTestId("page-offer");
    expect(offer).not.toBeNull();
    // The offer carries the page size the result reports, not a hardcoded 500: a 50-row
    // table preview used to promise "Load More (500 rows)" and then fetch 50.
    expect(offer!.textContent).toBe("offer 50");
  });

  // ── 6b. An offer adds nothing below the grid ──────────────────────────────

  test("an offer adds no chrome below the grid", () => {
    /*
      THE UI RULING'S FIRST CRITERION, measured as a DIFFERENCE rather than as a property
      of this file's stub.

      Asserting that the offer element sits inside the stats bar cannot fail here: the
      StatsBar stub above builds it as its own child, so it is a descendant whatever
      `ResultsGrid` does. What the ruling actually says is that the grid gains no chrome
      and keeps its height whether or not another page is available, and that is a
      comparison: the grid's own children must be the same set either way. A `LoadMoreFooter`
      restored below the table is a new sibling here and fails.
    */
    const shape = (root: Element) =>
      Array.from(root.children).map((child) => `${child.tagName}#${child.getAttribute("data-testid") ?? ""}`);

    const withoutOffer = render(React.createElement(ResultsGrid, { result: mockPaginatedResult }));
    expect(withoutOffer.queryByTestId("page-offer")).toBeNull();
    const plain = shape(withoutOffer.container.firstElementChild!);
    cleanup();

    const withOffer = render(
      React.createElement(ResultsGrid, {
        result: mockPaginatedResult,
        onLoadMore: mock(() => {}),
        supportsResultPagination: true,
      }),
    );
    expect(withOffer.queryByTestId("page-offer")).not.toBeNull();
    expect(shape(withOffer.container.firstElementChild!)).toEqual(plain);
  });

  // ── 7. Load More button fires onLoadMore ──────────────────────────────────

  test("Load More button fires onLoadMore callback", () => {
    const onLoadMore = mock(() => {});
    const { getByTestId } = render(
      React.createElement(ResultsGrid, {
        result: mockPaginatedResult,
        onLoadMore,
        supportsResultPagination: true,
      }),
    );

    // The callback reaches the strip intact, not just the decision to show a control.
    fireEvent.click(getByTestId("page-offer"));
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

  test("no Load More when the result carries no pagination at all", () => {
    const { queryByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));

    expect(queryByTestId("page-offer")).toBeNull();
  });

  // ── the capability gate and the order notice (#816) ───────────────────────

  /**
   * The control appears only where page two is REACHABLE.
   *
   * `supportsExternalQueryLimiting` is not this flag: Cassandra declares that one true
   * and throws on any positive offset. The five providers that cannot page declare
   * `supportsResultPagination: false`, and an ABSENT flag reads the same as false — the
   * #269 rule, so a host or a stale metadata read cannot open the control by omission.
   */
  test.each([
    ["the provider cannot page", { supportsResultPagination: false }],
    ["the flag is absent altogether", {}],
  ])("no Load More when %s, even with hasMore", (_label, capability) => {
    const { queryByTestId } = render(
      React.createElement(ResultsGrid, {
        result: mockPaginatedResult,
        onLoadMore: mock(() => {}),
        ...capability,
      }),
    );

    expect(queryByTestId("page-offer")).toBeNull();
  });

  test("hands the in-flight state to the strip that renders the control", () => {
    // Without this the control keeps its idle label and stays clickable while a page is
    // already on the wire, and a second click asks for the same offset twice.
    const { getByTestId } = render(
      React.createElement(ResultsGrid, {
        result: mockPaginatedResult,
        onLoadMore: mock(() => {}),
        supportsResultPagination: true,
        isLoadingMore: true,
      }),
    );

    expect(getByTestId("page-offer").getAttribute("data-loading")).toBe("true");
  });

  test("no Load More when the result reports no further page", () => {
    const { queryByTestId } = render(
      React.createElement(ResultsGrid, {
        result: { ...mockPaginatedResult, pagination: { ...mockPaginatedResult.pagination!, hasMore: false } },
        onLoadMore: mock(() => {}),
        supportsResultPagination: true,
      }),
    );

    expect(queryByTestId("page-offer")).toBeNull();
  });

  test("no Load More when the surface withholds the callback", () => {
    // A result hydrated from an agent run comes this way: BottomPanel passes no
    // `onLoadMore`, because there is no statement here to ask for another page of.
    const { queryByTestId } = render(
      React.createElement(ResultsGrid, {
        result: mockPaginatedResult,
        supportsResultPagination: true,
      }),
    );

    expect(queryByTestId("page-offer")).toBeNull();
  });

  /**
   * Criterion 7. Without an `ORDER BY` the engine may return pages that overlap or skip,
   * and Studio does not inject one to prevent it. It states the condition instead — once,
   * beside the existing AUTO-LIMITED badge, and only where a second page can actually be
   * asked for. A notice about pages the user cannot reach describes nothing.
   */
  test("says order across pages is not guaranteed for an unordered pageable result", () => {
    const { queryByTestId } = render(
      React.createElement(ResultsGrid, {
        result: mockPaginatedResult,
        onLoadMore: mock(() => {}),
        supportsResultPagination: true,
        resultQuery: "SELECT * FROM users",
      }),
    );

    expect(queryByTestId("page-offer")).not.toBeNull();
    expect(queryByTestId("order-notice")).not.toBeNull();
  });

  test("says nothing when the statement orders its own result", () => {
    const { queryByTestId } = render(
      React.createElement(ResultsGrid, {
        result: mockPaginatedResult,
        onLoadMore: mock(() => {}),
        supportsResultPagination: true,
        resultQuery: "SELECT * FROM users ORDER BY id",
      }),
    );

    expect(queryByTestId("page-offer")).not.toBeNull();
    expect(queryByTestId("order-notice")).toBeNull();
  });

  test("reads the statement under the connection's own dialect", () => {
    // `#` opens a comment in MySQL and is ordinary text in PostgreSQL (#292), so the
    // same statement is ordered under one dialect and not the other.
    const props = {
      result: mockPaginatedResult,
      onLoadMore: mock(() => {}),
      supportsResultPagination: true,
      resultQuery: "SELECT * FROM users # ORDER BY id",
    };

    expect(
      render(React.createElement(ResultsGrid, { ...props, databaseType: "mysql" })).queryByTestId("order-notice"),
    ).not.toBeNull();
    cleanup();
    expect(
      render(React.createElement(ResultsGrid, { ...props, databaseType: "postgres" })).queryByTestId("order-notice"),
    ).toBeNull();
  });

  /**
   * The gate that #933 got wrong and its own test could not see, because its fixture
   * always had `hasMore: true`. An auto-limited unordered result that fits in ONE page
   * printed "order across pages is not guaranteed" with no Load More anywhere and no
   * second page in existence.
   */
  test.each([
    ["no further page exists", { pagination: { ...mockPaginatedResult.pagination!, hasMore: false } }, {}],
    ["the provider cannot page", {}, { supportsResultPagination: false }],
    ["the surface withholds the callback", {}, { onLoadMore: undefined }],
  ])("says nothing about pages when %s", (_label, resultPatch, propPatch) => {
    const { queryByTestId } = render(
      React.createElement(ResultsGrid, {
        result: { ...mockPaginatedResult, ...resultPatch },
        onLoadMore: mock(() => {}),
        supportsResultPagination: true,
        resultQuery: "SELECT * FROM users",
        ...propPatch,
      }),
    );

    expect(queryByTestId("page-offer")).toBeNull();
    expect(queryByTestId("order-notice")).toBeNull();
  });

  test("says nothing when the statement that produced the rows is unknown", () => {
    // No `resultQuery` means the shell could not name the statement. Claiming its order
    // either way would be a guess, and the quieter guess is the one that does not
    // reassure.
    const { queryByTestId } = render(
      React.createElement(ResultsGrid, {
        result: mockPaginatedResult,
        onLoadMore: mock(() => {}),
        supportsResultPagination: true,
      }),
    );

    expect(queryByTestId("page-offer")).not.toBeNull();
    expect(queryByTestId("order-notice")).toBeNull();
  });

  // ── 12. Empty state message is descriptive ────────────────────────────────

  test("empty state contains helpful message", () => {
    const { queryByText } = render(React.createElement(ResultsGrid, { result: mockEmptyResult }));

    expect(queryByText("The operation was successful, but the result set is currently empty.")).not.toBeNull();
  });

  // ── 13. Column headers are interactive (sort on click) ────────────────────

  test("desktop-table column headers render as interactive elements", () => {
    const { getAllByRole, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
    fireEvent.click(getByTestId("view-table"));
    const idHeaders = getAllByRole("button", { name: "id" });
    expect(idHeaders.length).toBeGreaterThan(0);
    // Click doesn't crash
    fireEvent.click(idHeaders[0]);
  });

  // ── 14. Click sort toggles data order ──────────────────────────────────

  test("clicking a desktop-table column header twice for sort toggle does not crash", () => {
    const { getAllByRole, getByTestId, container } = render(React.createElement(ResultsGrid, { result: mockResult }));
    fireEvent.click(getByTestId("view-table"));
    const idHeaders = getAllByRole("button", { name: "id" });
    if (idHeaders[0]) {
      fireEvent.click(idHeaders[0]);
      fireEvent.click(idHeaders[0]);
    }
    expect(container.textContent).toContain("Alice");
  });

  // ── 15. Filter inputs render ──────────────────────────────────────────────

  test("desktop-table filter controls render in table mode", () => {
    const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
    fireEvent.click(getByTestId("view-table"));

    expect(container.querySelectorAll('button[title="Filter column"]').length).toBeGreaterThan(0);
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

  test("desktop-table large dataset renders rows via virtualizer", () => {
    const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockPaginatedResult }));
    fireEvent.click(getByTestId("view-table"));

    expect(findDesktopRow(container, "User 1")).not.toBeUndefined();
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
    const { container, getByTestId, queryByTestId } = render(React.createElement(ResultsGrid, { result: singleRow }));
    fireEvent.click(getByTestId("view-table"));
    expect(findDesktopRow(container, "OK")).not.toBeUndefined();
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
    const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: withNulls }));
    fireEvent.click(getByTestId("view-table"));
    expect(findDesktopRow(container, "NULL")).not.toBeUndefined();
  });

  // ── 21. Boolean values display ──────────────────────────────────────────

  test("boolean values are displayed", () => {
    const withBool: QueryResult = {
      rows: [{ id: 1, active: true }],
      fields: ["id", "active"],
      rowCount: 1,
      executionTime: 1,
    };
    const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: withBool }));
    fireEvent.click(getByTestId("view-table"));
    expect(findDesktopRow(container, "true")).not.toBeUndefined();
  });

  // ── 22. Row number column shown ─────────────────────────────────────────

  test("desktop-table rows retain their row values", () => {
    const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
    fireEvent.click(getByTestId("view-table"));

    expect(findDesktopRow(container, "Alice")?.textContent).toContain("1");
    expect(findDesktopRow(container, "Bob")?.textContent).toContain("2");
    expect(findDesktopRow(container, "Charlie")?.textContent).toContain("3");
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
    const { container, getByTestId } = render(
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
    fireEvent.click(getByTestId("view-table"));
    expect(findDesktopRow(container, "Alice")?.textContent).toContain("***");
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Column Filtering Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("Column filtering", () => {
    /**
     * The filter panel closes on a press outside it (#870).
     *
     * It sits over the rows it filters, and until this it was dismissed only by pressing
     * the same funnel again, which is the gesture the open panel covers. Escape already
     * closed it from inside the input; a reader who had moved the mouse on had neither.
     */
    test("closes the filter panel on a press outside it", () => {
      const { container, queryAllByPlaceholderText, queryAllByTitle } = render(
        React.createElement(ResultsGrid, { result: mockResult }),
      );

      fireEvent.click(queryAllByTitle("Filter column")[0]!);
      expect(queryAllByPlaceholderText(/^Filter /).length).toBeGreaterThan(0);

      fireEvent.mouseDown(container);
      expect(queryAllByPlaceholderText(/^Filter /).length).toBe(0);
    });

    /** The control: typing into the panel is a press inside it and must not close it. */
    test("keeps the filter panel open while pressing inside it", () => {
      const { queryAllByPlaceholderText, queryAllByTitle } = render(
        React.createElement(ResultsGrid, { result: mockResult }),
      );

      fireEvent.click(queryAllByTitle("Filter column")[0]!);
      const input = queryAllByPlaceholderText(/^Filter /)[0]!;
      fireEvent.mouseDown(input);
      expect(queryAllByPlaceholderText(/^Filter /).length).toBeGreaterThan(0);
    });

    /**
     * A filter belongs to the result it was typed against (#1409). A different query in the
     * same tab used to inherit it, and a column the new rows lack reads as "" so every row
     * was hidden while the strip still reported the real count.
     */
    test("a new result without the filtered column starts unfiltered", () => {
      const { container, getByTestId, rerender } = render(React.createElement(ResultsGrid, { result: mockResult }));
      fireEvent.click(getByTestId("view-table"));
      fireEvent.click(container.querySelectorAll('button[title="Filter column"]')[1]);
      fireEvent.change(container.querySelector('input[placeholder="Filter name..."]')!, { target: { value: "Alice" } });
      expect(container.querySelector('[data-testid="filtered-count"]')?.textContent).toContain("1 filtered");

      const other: QueryResult = {
        rows: [{ sku: "a" }, { sku: "b" }],
        fields: ["sku"],
        rowCount: 2,
        executionTime: 1,
      };
      rerender(React.createElement(ResultsGrid, { result: other }));

      expect(container.querySelector('[data-testid="filtered-count"]')?.textContent).toContain("2 filtered");
      expect(container.querySelector('[data-testid="clear-filters"]')).toBeNull();
    });

    test("filter matching folds the Turkish dotted and dotless I", () => {
      const turkish: QueryResult = {
        rows: [{ city: "İzmir" }, { city: "IZMIR" }, { city: "ızmir" }, { city: "Ankara" }],
        fields: ["city"],
        rowCount: 4,
        executionTime: 1,
      };
      const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: turkish }));
      fireEvent.click(getByTestId("view-table"));
      fireEvent.click(container.querySelector('button[title="Filter column"]')!);
      const input = () => container.querySelector('input[placeholder="Filter city..."]')!;
      const count = () => container.querySelector('[data-testid="filtered-count"]')?.textContent;

      fireEvent.change(input(), { target: { value: "izmir" } });
      expect(count()).toContain("3 filtered");
      fireEvent.change(input(), { target: { value: "İZMİR" } });
      expect(count()).toContain("3 filtered");
      fireEvent.change(input(), { target: { value: "ANK" } });
      expect(count()).toContain("1 filtered");
    });

    test("filter matching keeps other accents and scripts apart", () => {
      const mixed: QueryResult = {
        rows: [{ w: "caf\u00e9" }, { w: "cafe" }, { w: "\ud55c\uad6d" }, { w: "\u017caba" }],
        fields: ["w"],
        rowCount: 4,
        executionTime: 1,
      };
      const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mixed }));
      fireEvent.click(getByTestId("view-table"));
      fireEvent.click(container.querySelector('button[title="Filter column"]')!);
      const input = () => container.querySelector('input[placeholder="Filter w..."]')!;
      const count = () => container.querySelector('[data-testid="filtered-count"]')?.textContent;

      fireEvent.change(input(), { target: { value: "cafe" } });
      expect(count()).toContain("1 filtered");
      fireEvent.change(input(), { target: { value: "\ud558" } });
      expect(count()).toContain("0 filtered");
      fireEvent.change(input(), { target: { value: "zaba" } });
      expect(count()).toContain("0 filtered");
    });

    describe("filter lifetime (#1409)", () => {
      const resultA = (fields = ["id", "name", "email"]): QueryResult => ({
        rows: [
          { id: 1, name: "Alice", email: "a@x" },
          { id: 2, name: "Bob", email: "b@x" },
        ].map((r) => Object.fromEntries(fields.map((f) => [f, (r as Record<string, unknown>)[f]]))),
        fields,
        rowCount: 2,
        executionTime: 1,
      });
      const renderGrid = (result: QueryResult, resultQuery: string | undefined) =>
        React.createElement(ResultsGrid, { result, resultQuery });
      const typeNameFilter = (container: HTMLElement) => {
        fireEvent.click(container.querySelectorAll('button[title="Filter column"]')[1]);
        fireEvent.change(container.querySelector('input[placeholder="Filter name..."]')!, {
          target: { value: "Alice" },
        });
      };
      const count = (c: HTMLElement) => c.querySelector('[data-testid="filtered-count"]')?.textContent;

      test("A, then B without the column, then A again starts unfiltered", () => {
        const { container, getByTestId, rerender } = render(renderGrid(resultA(), "select * from a"));
        fireEvent.click(getByTestId("view-table"));
        typeNameFilter(container);
        expect(count(container)).toContain("1 filtered");
        rerender(renderGrid({ rows: [{ sku: "x" }], fields: ["sku"], rowCount: 1, executionTime: 1 }, "select sku"));
        rerender(renderGrid(resultA(), "select * from a"));
        expect(count(container)).toContain("2 filtered");
        expect(container.querySelector('[data-testid="clear-filters"]')).toBeNull();
      });

      test("a different query with the same columns starts unfiltered", () => {
        const { container, getByTestId, rerender } = render(renderGrid(resultA(), "select * from a"));
        fireEvent.click(getByTestId("view-table"));
        typeNameFilter(container);
        rerender(renderGrid(resultA(), "select * from b"));
        expect(count(container)).toContain("2 filtered");
      });

      test("the same run keeps its filter across a page that changes the columns", () => {
        const { container, getByTestId, rerender } = render(renderGrid(resultA(), "db.a.find()"));
        fireEvent.click(getByTestId("view-table"));
        typeNameFilter(container);
        rerender(renderGrid(resultA(["id", "name"]), "db.a.find()"));
        expect(count(container)).toContain("1 filtered");
        // a column that vanished takes its own filter with it, the others stay
        rerender(renderGrid(resultA(["id"]), "db.a.find()"));
        expect(count(container)).toContain("2 filtered");
      });

      test("an open filter panel closes when its column leaves the result", () => {
        const { container, getByTestId, rerender } = render(renderGrid(resultA(), "q"));
        fireEvent.click(getByTestId("view-table"));
        fireEvent.click(container.querySelectorAll('button[title="Filter column"]')[1]);
        expect(container.querySelector('input[placeholder="Filter name..."]')).not.toBeNull();
        rerender(renderGrid(resultA(["id"]), "q"));
        expect(container.querySelector('input[placeholder="Filter name..."]')).toBeNull();
      });
    });

    test("clicking filter button opens filter dropdown with input", () => {
      const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
      fireEvent.click(getByTestId("view-table"));

      const filterButtons = container.querySelectorAll('button[title="Filter column"]');
      expect(filterButtons.length).toBeGreaterThan(0);

      fireEvent.click(filterButtons[0]);

      const filterInput = container.querySelector('input[placeholder="Filter id..."]');
      expect(filterInput).not.toBeNull();
    });

    test("typing in filter input filters rows", () => {
      const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
      fireEvent.click(getByTestId("view-table"));

      const filterButtons = container.querySelectorAll('button[title="Filter column"]');
      fireEvent.click(filterButtons[1]);

      const filterInput = container.querySelector('input[placeholder="Filter name..."]');
      expect(filterInput).not.toBeNull();

      fireEvent.change(filterInput!, { target: { value: "Alice" } });

      const filteredCount = container.querySelector('[data-testid="filtered-count"]');
      expect(filteredCount?.textContent).toContain("1 filtered");
    });

    test("clearing filter value in input removes filter", () => {
      const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
      fireEvent.click(getByTestId("view-table"));

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
      const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
      fireEvent.click(getByTestId("view-table"));

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
      const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
      fireEvent.click(getByTestId("view-table"));

      const filterButtons = container.querySelectorAll('button[title="Filter column"]');
      fireEvent.click(filterButtons[0]);

      const filterInput = container.querySelector('input[placeholder="Filter id..."]');
      expect(filterInput).not.toBeNull();

      fireEvent.keyDown(filterInput!, { key: "Escape" });

      expect(container.querySelector('input[placeholder="Filter id..."]')).toBeNull();
    });

    test("Enter key closes filter dropdown", () => {
      const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
      fireEvent.click(getByTestId("view-table"));

      const filterButtons = container.querySelectorAll('button[title="Filter column"]');
      fireEvent.click(filterButtons[0]);

      const filterInput = container.querySelector('input[placeholder="Filter id..."]');
      expect(filterInput).not.toBeNull();

      fireEvent.keyDown(filterInput!, { key: "Enter" });

      expect(container.querySelector('input[placeholder="Filter id..."]')).toBeNull();
    });

    test("clicking same filter button again closes dropdown", () => {
      const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
      fireEvent.click(getByTestId("view-table"));

      const filterButtons = container.querySelectorAll('button[title="Filter column"]');
      fireEvent.click(filterButtons[0]);
      expect(container.querySelector('input[placeholder="Filter id..."]')).not.toBeNull();

      // Re-query button after re-render
      const filterButtons2 = container.querySelectorAll('button[title="Filter column"]');
      fireEvent.click(filterButtons2[0]);
      expect(container.querySelector('input[placeholder="Filter id..."]')).toBeNull();
    });

    test("clear all filters via StatsBar handleClearFilters", () => {
      const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
      fireEvent.click(getByTestId("view-table"));

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
      const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
      fireEvent.click(getByTestId("view-table"));

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
        input.classList.contains("border-brand-tint"),
      );
    }

    test("double-clicking a desktop-table cell enters edit mode with input", () => {
      const onCellChange = mock(() => {});
      const { container, getByTestId } = render(
        React.createElement(ResultsGrid, {
          result: mockResult,
          editingEnabled: true,
          onCellChange,
          pendingChanges: [],
        }),
      );
      fireEvent.click(getByTestId("view-table"));

      const cells = container.querySelectorAll("[data-index]:not([data-testid]) .cursor-text");
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
      const { container, getByTestId } = render(
        React.createElement(ResultsGrid, {
          result: mockResult,
          editingEnabled: false,
          onCellChange,
          pendingChanges: [],
        }),
      );
      fireEvent.click(getByTestId("view-table"));

      const desktopRow = findDesktopRow(container, "Alice");
      expect(desktopRow).not.toBeUndefined();
      fireEvent.doubleClick(within(desktopRow!).getByText("Alice"));

      expect(findEditInput(container)).toBeUndefined();
      expect(onCellChange).not.toHaveBeenCalled();
      expect(container.querySelectorAll(".cursor-text").length).toBe(0);
    });

    test("a column whose declared type the provider refuses opens no editor, and says why (K24)", () => {
      // Db2 declares a CLOB, DBCLOB or BLOB column by its bare name, and db2-node writes nothing
      // for a value bound to one declared 32768 bytes or longer, so its provider refuses the type.
      const onCellChange = mock(() => {});
      const reason = "db2-node writes nothing for a value bound to this column";
      const { container, getByTestId } = render(
        React.createElement(ResultsGrid, {
          result: {
            ...mockResult,
            rows: [{ id: 1, name: "Alice", email: "alice-notes" }],
            columnTypes: { id: "INTEGER", name: "VARCHAR(20)", email: "CLOB" },
          },
          editingEnabled: true,
          inlineEditRefusedColumns: { type: "^(CLOB|DBCLOB|BLOB)$", reason },
          onCellChange,
          pendingChanges: [],
        }),
      );
      fireEvent.click(getByTestId("view-table"));

      const row = findDesktopRow(container, "Alice")!;
      const refused = within(row).getByText("alice-notes").parentElement!;
      expect(refused.getAttribute("title")).toBe(reason);
      expect(refused.classList.contains("cursor-text")).toBe(false);
      fireEvent.doubleClick(refused);
      expect(findEditInput(container)).toBeUndefined();

      // The column beside it, whose type the rule does not match, still edits.
      fireEvent.doubleClick(findDesktopCell(container, "Alice")!);
      expect(findEditInput(container)).not.toBeUndefined();
    });

    test("Enter key commits a desktop-table edit and calls onCellChange", () => {
      const onCellChange = mock(() => {});
      const { container, getByTestId } = render(
        React.createElement(ResultsGrid, {
          result: mockResult,
          editingEnabled: true,
          onCellChange,
          pendingChanges: [],
        }),
      );
      fireEvent.click(getByTestId("view-table"));

      const nameCell = findDesktopCell(container, "Alice");
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
      const { container, getByTestId } = render(
        React.createElement(ResultsGrid, {
          result: mockResult,
          editingEnabled: true,
          onCellChange,
          pendingChanges: [],
        }),
      );
      fireEvent.click(getByTestId("view-table"));

      fireEvent.doubleClick(container.querySelector("[data-index]:not([data-testid]) .cursor-text")!);

      const editInput = findEditInput(container)!;
      // Press Escape directly (no value change to avoid stale ref)
      fireEvent.keyDown(editInput, { key: "Escape" });

      expect(onCellChange).not.toHaveBeenCalled();
      expect(findEditInput(container)).toBeUndefined();
    });

    test("a filtered row's edit is addressed to its place in the result, not in the filter", () => {
      // The table is built over the FILTERED rows, so TanStack's `row.index` is a position
      // in that array. `useInlineEditing` reads the row's primary key out of
      // `result.rows[rowIndex]`, so with a filter on, an edit used to be keyed to whatever
      // row happened to sit at the same position unfiltered — a silent write to the wrong
      // row, which is #881's harm reached through the grid instead of the tab title.
      const threeRows: QueryResult = {
        rows: [
          { id: 1, name: "Alice" },
          { id: 2, name: "Bob" },
          { id: 3, name: "Charlie" },
        ],
        fields: ["id", "name"],
        rowCount: 3,
        executionTime: 1,
      };
      const onCellChange = mock(() => {});
      const { container } = render(
        React.createElement(ResultsGrid, {
          result: threeRows,
          editingEnabled: true,
          onCellChange,
          pendingChanges: [],
        }),
      );

      // Filter down to Charlie, who is the only visible row and so sits at filtered index 0.
      const filterButton = Array.from(container.querySelectorAll("button")).find(
        (b) =>
          b.getAttribute("title") === "Filter column" && b.closest(".group\\/header")?.textContent?.includes("name"),
      );
      fireEvent.click(filterButton ?? container.querySelectorAll('button[title="Filter column"]')[1]);
      const filterInput = Array.from(container.querySelectorAll("input")).find((i) =>
        (i.getAttribute("placeholder") ?? "").startsWith("Filter"),
      )!;
      fireEvent.change(filterInput, { target: { value: "Charlie" } });

      const visible = Array.from(container.querySelectorAll(".cursor-text")).filter((c) => c.textContent === "Charlie");
      expect(visible).toHaveLength(1);
      fireEvent.doubleClick(visible[0]);

      const editInput = findEditInput(container)!;
      fireEvent.change(editInput, { target: { value: "Charlize" } });
      fireEvent.keyDown(findEditInput(container)!, { key: "Enter" });

      expect(onCellChange).toHaveBeenCalledTimes(1);
      const change = (onCellChange.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
      expect(change.rowIndex).toBe(2);
      expect(change.originalValue).toBe("Charlie");
      expect(change.newValue).toBe("Charlize");
    });

    test("blur commits a desktop-table edit when value changed", () => {
      const onCellChange = mock(() => {});
      const { container, getByTestId } = render(
        React.createElement(ResultsGrid, {
          result: mockResult,
          editingEnabled: true,
          onCellChange,
          pendingChanges: [],
        }),
      );
      fireEvent.click(getByTestId("view-table"));

      const nameCell = findDesktopCell(container, "Alice");
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

    test("Enter with unchanged desktop-table edit does not call onCellChange", () => {
      const onCellChange = mock(() => {});
      const { container, getByTestId } = render(
        React.createElement(ResultsGrid, {
          result: mockResult,
          editingEnabled: true,
          onCellChange,
          pendingChanges: [],
        }),
      );
      fireEvent.click(getByTestId("view-table"));

      const nameCell = findDesktopCell(container, "Alice");
      fireEvent.doubleClick(nameCell!);

      const editInput = findEditInput(container)!;
      // Don't change the value, just press Enter
      fireEvent.keyDown(editInput, { key: "Enter" });

      expect(onCellChange).not.toHaveBeenCalled();
    });

    test("blur with unchanged desktop-table edit does not call onCellChange", () => {
      const onCellChange = mock(() => {});
      const { container, getByTestId } = render(
        React.createElement(ResultsGrid, {
          result: mockResult,
          editingEnabled: true,
          onCellChange,
          pendingChanges: [],
        }),
      );
      fireEvent.click(getByTestId("view-table"));

      const nameCell = findDesktopCell(container, "Alice");
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

    test("clicking the desktop-table reveal button shows actual value with lock icon", () => {
      setupMasking();

      const { container, getByTestId } = render(React.createElement(ResultsGrid, maskingProps));
      fireEvent.click(getByTestId("view-table"));

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

    test("a reveal follows its row through a filter, not the position it sat at", () => {
      // A revealed cell is keyed by its position, and the table iterates the FILTERED
      // rows - so revealing Alice's email and then filtering down to Charlie handed
      // Charlie's row the key Alice's reveal wrote, and a sensitive value nobody asked
      // for was on screen unmasked. Same addressing defect as the pending-change one
      // above it, and this half of it crosses the masking boundary.
      setupMasking();

      const { container } = render(React.createElement(ResultsGrid, maskingProps));

      fireEvent.click(container.querySelectorAll('button[title="Reveal value (10s)"]')[0]);
      expect(container.textContent).toContain("alice@example.com");

      const filterButtons = container.querySelectorAll('button[title="Filter column"]');
      fireEvent.click(filterButtons[1]);
      fireEvent.change(container.querySelector('input[placeholder="Filter name..."]')!, {
        target: { value: "Charlie" },
      });

      expect(container.textContent).not.toContain("charlie@example.com");
      expect(container.textContent).toContain("***");
    });

    test("desktop-table revealed cell auto-hides after timeout", () => {
      setupMasking();

      const { container, getByTestId } = render(React.createElement(ResultsGrid, maskingProps));
      fireEvent.click(getByTestId("view-table"));

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

    test("desktop-table reveal button is not shown when canReveal is false", () => {
      mockShouldMask.mockReturnValue(true);
      mockCanReveal.mockReturnValue(false);
      mockDetectSensitiveColumnsFromConfig.mockReturnValue(
        new Map([
          ["email", { name: "email", maskType: "email" as const, columnPatterns: ["email"], enabled: true, id: "e1" }],
        ]),
      );

      const { container, getByTestId } = render(React.createElement(ResultsGrid, maskingProps));
      fireEvent.click(getByTestId("view-table"));

      expect(container.textContent).toContain("***");

      const revealButton = container.querySelector('button[title="Reveal value (10s)"]');
      expect(revealButton).toBeNull();
    });

    /**
     * The column filter reads what the grid shows (#1477). It matched the clear value under a
     * masked cell, so a user who may not lift masking could read a masked value one typed
     * prefix at a time off the row count.
     */
    describe("column filter on a masked column (#1477)", () => {
      function filterEmail(container: HTMLElement, value: string) {
        fireEvent.click(container.querySelectorAll('button[title="Filter column"]')[2]);
        fireEvent.change(container.querySelector('input[placeholder="Filter email..."]')!, { target: { value } });
      }
      const countText = (container: HTMLElement) =>
        container.querySelector('[data-testid="filtered-count"]')?.textContent ?? "";

      test("a prefix of the clear value does not narrow the rows while masking is in force", () => {
        setupMasking();
        // The masked text keeps the first character, like the email preset.
        mockMaskValueByPattern.mockImplementation((value: unknown) => `${String(value)[0]}***`);
        const { container, getByTestId } = render(React.createElement(ResultsGrid, maskingProps));
        fireEvent.click(getByTestId("view-table"));

        filterEmail(container, "al");
        expect(countText(container)).toContain("0 filtered");
        expect(container.textContent).not.toContain("alice@example.com");
      });

      test("matches the masked text the grid displays", () => {
        setupMasking();
        mockMaskValueByPattern.mockImplementation((value: unknown) => `${String(value)[0]}***`);
        const { container, getByTestId } = render(React.createElement(ResultsGrid, maskingProps));
        fireEvent.click(getByTestId("view-table"));

        filterEmail(container, "b***");
        expect(countText(container)).toContain("1 filtered");
      });

      test("with masking off the filter still matches the clear value", () => {
        setupMasking();
        mockShouldMask.mockReturnValue(false);
        const { container, getByTestId } = render(
          React.createElement(ResultsGrid, { ...maskingProps, maskingEnabled: false }),
        );
        fireEvent.click(getByTestId("view-table"));

        filterEmail(container, "alice@");
        expect(countText(container)).toContain("1 filtered");
      });
    });

    /**
     * Sorting reads what the grid shows too (#1491). It ordered a masked column by the clear
     * value under each cell, so a user who may not lift masking could read the rank of the
     * hidden values off the row order: whose email sorts first, which salary is the highest.
     */
    describe("sorting a masked column (#1491)", () => {
      /** The first name in each rendered desktop row, in the order the table iterates them. */
      const nameOrder = (container: HTMLElement) =>
        Array.from(container.querySelectorAll("[data-index]:not([data-testid]):not(button)")).map(
          (row) => /Alice|Bob|Charlie/.exec(row.textContent ?? "")?.[0],
        );
      const sortBy = (utils: ReturnType<typeof render>, name: string) =>
        fireEvent.click(utils.getAllByRole("button", { name })[0]);
      /** A mask whose order is not the clear order: clear alice < bob < charlie, masked b < c < a. */
      const scrambledMask = (value: unknown) =>
        ({ "alice@example.com": "c***", "bob@example.com": "a***", "charlie@example.com": "b***" })[String(value)] ??
        "***";

      test("orders the rows by the masked text the grid displays, not by the clear value", () => {
        setupMasking();
        mockMaskValueByPattern.mockImplementation(scrambledMask);
        const utils = render(React.createElement(ResultsGrid, maskingProps));
        fireEvent.click(utils.getByTestId("view-table"));

        sortBy(utils, "email");
        expect(nameOrder(utils.container)).toEqual(["Bob", "Charlie", "Alice"]);
        sortBy(utils, "email, sorted ascending");
        expect(nameOrder(utils.container)).toEqual(["Alice", "Charlie", "Bob"]);
        expect(utils.container.textContent).not.toContain("alice@example.com");
      });

      test("identical masks keep the source order both ways, so the rank of the hidden values stays hidden", () => {
        setupMasking();
        const utils = render(React.createElement(ResultsGrid, maskingProps));
        fireEvent.click(utils.getByTestId("view-table"));

        sortBy(utils, "email");
        sortBy(utils, "email, sorted ascending");
        expect(nameOrder(utils.container)).toEqual(["Alice", "Bob", "Charlie"]);
      });

      test("a masked numeric column does not sort by the numbers under the mask", () => {
        setupMasking();
        mockDetectSensitiveColumnsFromConfig.mockReturnValue(
          new Map([["id", { name: "id", maskType: "full" as const, columnPatterns: ["id"], enabled: true, id: "n1" }]]),
        );
        const result: QueryResult = { ...mockResult, columnTypes: { id: "bigint" } };
        const utils = render(React.createElement(ResultsGrid, { ...maskingProps, result }));
        fireEvent.click(utils.getByTestId("view-table"));

        sortBy(utils, "id, bigint");
        sortBy(utils, "id, bigint, sorted ascending");
        expect(nameOrder(utils.container)).toEqual(["Alice", "Bob", "Charlie"]);
      });

      test("a per-cell reveal does not bring the clear value back into the sort", () => {
        setupMasking();
        mockMaskValueByPattern.mockImplementation(scrambledMask);
        const utils = render(React.createElement(ResultsGrid, maskingProps));
        fireEvent.click(utils.getByTestId("view-table"));

        fireEvent.click(utils.container.querySelectorAll('button[title="Reveal value (10s)"]')[0]);
        expect(utils.container.textContent).toContain("alice@example.com");

        sortBy(utils, "email");
        expect(nameOrder(utils.container)).toEqual(["Bob", "Charlie", "Alice"]);
      });

      test("turning masking on or off under an active sort re-sorts the rows", () => {
        // The table caches its sorted rows on the sorting state and the rows it is given, so a
        // new comparator alone left the clear-value order on screen after masking came on.
        setupMasking();
        mockMaskValueByPattern.mockImplementation(scrambledMask);
        const utils = render(React.createElement(ResultsGrid, { ...maskingProps, maskingEnabled: false }));
        fireEvent.click(utils.getByTestId("view-table"));

        sortBy(utils, "email");
        expect(nameOrder(utils.container)).toEqual(["Alice", "Bob", "Charlie"]);

        utils.rerender(React.createElement(ResultsGrid, maskingProps));
        expect(nameOrder(utils.container)).toEqual(["Bob", "Charlie", "Alice"]);

        utils.rerender(React.createElement(ResultsGrid, { ...maskingProps, maskingEnabled: false }));
        expect(nameOrder(utils.container)).toEqual(["Alice", "Bob", "Charlie"]);
      });

      test("with masking off the column sorts by the clear value", () => {
        setupMasking();
        mockShouldMask.mockReturnValue(false);
        mockMaskValueByPattern.mockImplementation(scrambledMask);
        const utils = render(React.createElement(ResultsGrid, { ...maskingProps, maskingEnabled: false }));
        fireEvent.click(utils.getByTestId("view-table"));

        sortBy(utils, "email");
        sortBy(utils, "email, sorted ascending");
        expect(nameOrder(utils.container)).toEqual(["Charlie", "Bob", "Alice"]);
      });

      test("with masking off a numeric column still sorts as numbers", () => {
        setupMasking();
        mockShouldMask.mockReturnValue(false);
        mockDetectSensitiveColumnsFromConfig.mockReturnValue(
          new Map([["id", { name: "id", maskType: "full" as const, columnPatterns: ["id"], enabled: true, id: "n1" }]]),
        );
        const result: QueryResult = {
          ...mockResult,
          rows: [
            { id: "10", name: "Alice", email: "alice@example.com" },
            { id: "9", name: "Bob", email: "bob@example.com" },
            { id: "100", name: "Charlie", email: "charlie@example.com" },
          ],
          columnTypes: { id: "bigint" },
        };
        const utils = render(React.createElement(ResultsGrid, { ...maskingProps, maskingEnabled: false, result }));
        fireEvent.click(utils.getByTestId("view-table"));

        sortBy(utils, "id, bigint");
        expect(nameOrder(utils.container)).toEqual(["Bob", "Alice", "Charlie"]);
      });
    });
  });

  // ── Declared column types (#273) ──────────────────────────────────────────

  describe("declared column types", () => {
    test("shows the type the engine declared for a column beside its name", () => {
      const result: QueryResult = { ...mockResult, columnTypes: { name: "Nullable(String)" } };
      const { getAllByRole, getByTestId, container } = render(React.createElement(ResultsGrid, { result }));
      fireEvent.click(getByTestId("view-table"));

      // The type is part of the header's accessible name, not sighted-only.
      const header = getAllByRole("button", { name: "name, Nullable(String)" })[0];
      expect(header.textContent).toContain("Nullable(String)");
      // Reachable in both headers: the desktop span and the compact mobile one,
      // which carries the type as a tooltip only (its columns are content-width).
      expect(container.querySelectorAll('[title="Nullable(String)"]').length).toBe(2);
    });

    test("leaves a column the engine declared no type for exactly as it was", () => {
      const result: QueryResult = { ...mockResult, columnTypes: { name: "Nullable(String)" } };
      const { getAllByRole, getByTestId } = render(React.createElement(ResultsGrid, { result }));
      fireEvent.click(getByTestId("view-table"));

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
      const { getAllByRole, getByTestId, container } = render(React.createElement(ResultsGrid, { result }));
      fireEvent.click(getByTestId("view-table"));

      // Accessible name is the bare field, and no inherited value is rendered.
      expect(getAllByRole("button", { name: "constructor" })[0].textContent).toBe("constructor");
      expect(getAllByRole("button", { name: "toString" })[0].textContent).toBe("toString");
      expect(container.textContent).not.toContain("function");
      expect(container.textContent).not.toContain("[object");
      // The column that DOES declare a type is unaffected.
      expect(getAllByRole("button", { name: "id, BIGINT" })[0].textContent).toContain("BIGINT");
    });

    test("renders a dotted column name as one key, not as a path into the row", () => {
      // TanStack reads a dotted `accessorKey` as a DEEP PATH, so `shipping.city`
      // was looked up as `row.shipping.city` while the row carries the flat key
      // `"shipping.city"` - and the cell rendered NULL over a value that was
      // right there. Measured in the browser on 2026-08-19 against Elasticsearch
      // 9.1.4: `SELECT order_id, shipping.city FROM orders` answered
      // `{"order_id":"o-001","shipping.city":"İzmir"}` from the API and the grid
      // showed NULL, while the CSV export - which reads `row[column]` - wrote
      // İzmir. The screen was the only surface that lied.
      //
      // Not an Elasticsearch curiosity: every object field in a mapping flattens
      // to a dotted leaf, so on a search cluster this is most columns a user has.
      const result: QueryResult = {
        ...mockResult,
        rows: [{ order_id: "o-001", "shipping.city": "İzmir" }],
        fields: ["order_id", "shipping.city"],
        columnTypes: { "shipping.city": "keyword" },
      };
      const { container, getByTestId } = render(React.createElement(ResultsGrid, { result }));
      fireEvent.click(getByTestId("view-table"));

      expect(findDesktopRow(container, "İzmir")).not.toBeUndefined();
      expect(findDesktopRow(container, "NULL")).toBeUndefined();
    });

    test("prefers the flat key when a row carries BOTH it and a nested object", () => {
      // OpenSearch answers `SELECT *` with a nested `shipping` object while
      // Elasticsearch flattens the same mapping to `shipping.city` (both measured
      // 2026-08-19), so a row can hold either shape - and a hand-written
      // `SELECT shipping, shipping.city` holds both at once. The declared column
      // list is what the grid renders, and `"shipping.city"` names the flat key.
      const result: QueryResult = {
        ...mockResult,
        rows: [{ shipping: { city: "Ankara" }, "shipping.city": "İzmir" }],
        fields: ["shipping.city"],
        columnTypes: {},
      };
      const { container, getByTestId } = render(React.createElement(ResultsGrid, { result }));
      fireEvent.click(getByTestId("view-table"));

      expect(findDesktopRow(container, "İzmir")).not.toBeUndefined();
      expect(findDesktopRow(container, "Ankara")).toBeUndefined();
    });

    test("makes the compact header's declared type reachable without a pointer", () => {
      // The compact table carries the type as a tooltip only, because visible
      // text there desyncs header and body widths. `title` on a non-focusable
      // element is unavailable to touch and unreliable for assistive tech, so the
      // type also ships as screen-reader text. Reported by review on PR #289.
      const result: QueryResult = { ...mockResult, columnTypes: { name: "Nullable(String)" } };
      const { container, getByTestId } = render(React.createElement(ResultsGrid, { result }));
      fireEvent.click(getByTestId("view-table"));

      const srOnly = Array.from(container.querySelectorAll(".sr-only")).map((n) => n.textContent);
      expect(srOnly.some((text) => text?.includes("Nullable(String)"))).toBe(true);
    });

    test("renders headers unchanged when the result declares no types at all", () => {
      const { getAllByRole, getByTestId, container } = render(React.createElement(ResultsGrid, { result: mockResult }));
      fireEvent.click(getByTestId("view-table"));

      expect(getAllByRole("button", { name: "name" })[0].textContent).toBe("name");
      expect(container.querySelector('span.truncate[title="name"]')).not.toBeNull();
      const unexpectedTooltips = Array.from(container.querySelectorAll<HTMLElement>("[title]")).filter(
        (element) =>
          element.title !== "Filter column" &&
          !mockResult.fields.includes(element.title) &&
          !element.hasAttribute("data-row-detail"),
      );
      expect(unexpectedTooltips.length).toBe(0);
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
    const { getAllByRole, getByTestId, container } = render(React.createElement(ResultsGrid, { result: mockResult }));
    fireEvent.click(getByTestId("view-table"));

    // `:not([data-testid])` excludes the mocked ResultCard above and `:not(button)`
    // the mobile table's rows, which both carry data-index too; only the desktop
    // table's rows come off the table instance, and they are the ones the row model orders.
    const renderedRows = () =>
      Array.from(container.querySelectorAll("[data-index]:not([data-testid]):not(button)")).map(
        (row) => row.textContent ?? "",
      );

    expect(renderedRows()).toHaveLength(3);
    expect(renderedRows()[0]).toContain("Alice");

    fireEvent.click(getAllByRole("button", { name: "name" })[0]);
    fireEvent.click(getAllByRole("button", { name: "name, sorted ascending" })[0]);

    const descending = renderedRows();
    expect(descending[0]).toContain("Charlie");
    expect(descending[1]).toContain("Bob");
    expect(descending[2]).toContain("Alice");
  });

  /**
   * 64-bit integers and decimals reach the grid as digit strings (#1384), and the table's
   * default comparison orders a string lexicographically: 1, 10, 100, 9. The column's declared
   * type picks a numeric comparison, and a text column keeps the default.
   */
  describe("sorting numeric columns (#1384)", () => {
    const numericResult: QueryResult = {
      rows: [
        { id: "10", total: "100.00", label: "10", memo: "b" },
        { id: "9", total: "1.25", label: "9", memo: "a" },
        { id: "9007199254740993", total: "-5.5", label: "9007199254740993", memo: "d" },
        { id: null, total: null, label: "100", memo: "c" },
        { id: "-5", total: "1000.00", label: "-5", memo: "e" },
        { id: "9007199254740992", total: "10.00", label: "1", memo: "f" },
      ],
      fields: ["id", "total", "label", "memo"],
      columnTypes: { id: "bigint", total: "numeric(12,2)", label: "varchar(30)", memo: "text" },
      rowCount: 6,
      executionTime: 1,
    };

    /** The memo column names each row with one letter, so the order read back is unambiguous. */
    const memoOrder = (container: HTMLElement) =>
      Array.from(container.querySelectorAll("[data-index]:not([data-testid]):not(button)"))
        .map((row) => /[a-f]$/.exec(row.textContent ?? "")?.[0])
        .join("");

    const clickHeader = (utils: ReturnType<typeof render>, name: RegExp) =>
      fireEvent.click(utils.getAllByRole("button", { name })[0]);

    test("a bigint column sorts ascending and descending as numbers, NULL last both ways", () => {
      const utils = render(React.createElement(ResultsGrid, { result: numericResult }));
      fireEvent.click(utils.getByTestId("view-table"));
      clickHeader(utils, /^id, bigint$/);
      // -5, 9, 10, 2^53, 2^53 + 1, NULL
      expect(memoOrder(utils.container)).toBe("eabfdc");
      clickHeader(utils, /^id, bigint, sorted ascending$/);
      // 2^53 + 1, 2^53, 10, 9, -5, NULL
      expect(memoOrder(utils.container)).toBe("dfbaec");
    });

    test("a numeric(12,2) column sorts decimals of different magnitudes as numbers", () => {
      const utils = render(React.createElement(ResultsGrid, { result: numericResult }));
      fireEvent.click(utils.getByTestId("view-table"));
      clickHeader(utils, /^total, numeric\(12,2\)$/);
      // -5.5, 1.25, 10.00, 100.00, 1000.00, NULL
      expect(memoOrder(utils.container)).toBe("dafbec");
      clickHeader(utils, /^total, numeric\(12,2\), sorted ascending$/);
      expect(memoOrder(utils.container)).toBe("ebfadc");
    });

    test("a text column of digit strings keeps the text order", () => {
      const utils = render(React.createElement(ResultsGrid, { result: numericResult }));
      fireEvent.click(utils.getByTestId("view-table"));
      clickHeader(utils, /^label, varchar\(30\)$/);
      // "-5" < "1" < "10" < "100" < "9" < "9007199254740993" as text
      expect(memoOrder(utils.container)).toBe("efbcad");
    });
  });

  // ── A11y semantics (#100): keyboard-reachable interactive elements ────────

  describe("a11y semantics", () => {
    test("desktop-table column sort headers are buttons named after the field", () => {
      const { getAllByRole, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
      fireEvent.click(getByTestId("view-table"));
      const sortButtons = getAllByRole("button", { name: "name" });
      expect(sortButtons.length).toBeGreaterThan(0);
      fireEvent.click(sortButtons[0]);
    });

    test("desktop-table sort buttons expose the current sort direction in their accessible name", () => {
      const { getAllByRole, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
      fireEvent.click(getByTestId("view-table"));
      fireEvent.click(getAllByRole("button", { name: "name" })[0]);
      const ascending = getAllByRole("button", { name: "name, sorted ascending" });
      expect(ascending.length).toBeGreaterThan(0);
      fireEvent.click(ascending[0]);
      expect(getAllByRole("button", { name: "name, sorted descending" }).length).toBeGreaterThan(0);
    });

    test("mobile-table rows are buttons that open the row detail sheet", () => {
      const { container, getByTestId, queryByTestId } = render(
        React.createElement(ResultsGrid, { result: mockResult }),
      );
      fireEvent.click(getByTestId("view-table"));
      const mobileMenu = findContextMenuForMode(container, "Alice", "mobile");
      const rowButton = within(mobileMenu).getByRole("button", { name: /Alice/ });
      fireEvent.click(rowButton);
      expect(queryByTestId("row-detail-sheet")).not.toBeNull();
    });

    test("desktop-table column resize handles are hidden from assistive technology", () => {
      const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
      fireEvent.click(getByTestId("view-table"));
      const handles = container.querySelectorAll(".cursor-col-resize");
      expect(handles.length).toBeGreaterThan(0);
      for (const handle of handles) {
        expect(handle.getAttribute("aria-hidden")).toBe("true");
      }
    });
  });

  describe("column sizing", () => {
    test("keeps manual resizing and restores only the selected column on double-click", () => {
      const result: QueryResult = {
        rows: [{ name: "Ada", email: "ada@example.com" }],
        fields: ["name", "email"],
        rowCount: 1,
        executionTime: 1,
      };
      const { container } = render(React.createElement(ResultsGrid, { result }));
      const nameHeader = findDesktopHeader(container, "name");
      const emailHeader = findDesktopHeader(container, "email");
      const nameHandle = nameHeader.querySelector<HTMLElement>(".cursor-col-resize")!;
      const emailHandle = emailHeader.querySelector<HTMLElement>(".cursor-col-resize")!;

      fireEvent.mouseDown(nameHandle, { clientX: 100 });
      fireEvent.mouseMove(document, { clientX: 150 });
      fireEvent.mouseUp(document, { clientX: 150 });

      fireEvent.mouseDown(emailHandle, { clientX: 200 });
      fireEvent.mouseMove(document, { clientX: 260 });
      fireEvent.mouseUp(document, { clientX: 260 });

      expect(nameHeader.style.width).toBe(`${getHeaderFitColumnSize("name") + 50}px`);
      expect(emailHeader.style.width).toBe(`${getHeaderFitColumnSize("email") + 60}px`);

      fireEvent.doubleClick(nameHandle);

      expect(nameHeader.style.width).toBe(`${getHeaderFitColumnSize("name")}px`);
      expect(emailHeader.style.width).toBe(`${getHeaderFitColumnSize("email") + 60}px`);
    });

    test("sizes a typed masked header for all of its visible markers", () => {
      mockShouldMask.mockReturnValue(true);
      mockDetectSensitiveColumnsFromConfig.mockReturnValue(new Map([["name", "sensitive"]]));

      const result: QueryResult = {
        rows: [{ name: "Ada" }],
        fields: ["name"],
        columnTypes: { name: "VARCHAR(255)" },
        rowCount: 1,
        executionTime: 1,
      };
      const { container } = render(React.createElement(ResultsGrid, { result, maskingEnabled: true }));
      const header = findDesktopHeader(container, "name");

      expect(header.style.width).toBe(`${getHeaderFitColumnSize("name", "VARCHAR(255)", true)}px`);
      expect(header.querySelector("span.truncate")?.getAttribute("title")).toBe("name");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Text Wrapping Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("Text wrapping", () => {
    // Walks from every element showing `text` up to its virtual row (desktop and
    // mobile both render in the DOM), collecting what could hold the value to one line.
    function lineConstraints(container: HTMLElement, text: string) {
      const found = Array.from(container.querySelectorAll("span")).filter((el) => el.textContent === text);
      expect(found.length).toBeGreaterThan(0);
      return found.map((el) => {
        const classes: string[] = [];
        let node: HTMLElement | null = el;
        while (node && !node.style.transform) {
          classes.push(...Array.from(node.classList));
          node = node.parentElement;
        }
        expect(node).not.toBeNull();
        // measureElement files a row's height under this attribute; a row without it
        // grows on screen while the rows below it stay where the old height put them.
        expect(node!.dataset.index).toBeDefined();
        return { classes, rowHeight: node!.style.height, mobile: node!.tagName === "BUTTON" };
      });
    }

    function expectSingleLine(container: HTMLElement, text: string) {
      for (const { classes, rowHeight, mobile } of lineConstraints(container, text)) {
        expect(classes).toContain("whitespace-nowrap");
        // The desktop grid's ellipsis is part of the unchanged behaviour; the mobile table never had one.
        if (!mobile) expect(classes).toContain("truncate");
        expect(rowHeight).toBe("36px");
      }
    }

    function expectWrapped(container: HTMLElement, text: string) {
      for (const { classes, rowHeight } of lineConstraints(container, text)) {
        expect(classes).not.toContain("truncate");
        expect(classes).not.toContain("whitespace-nowrap");
        expect(classes).not.toContain("h-full");
        expect(rowHeight).toBe("");
      }
    }

    test("a plain cell wraps and its row sheds the fixed height, and turning it off restores both", () => {
      const { container, getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
      expectSingleLine(container, "alice@example.com");

      fireEvent.click(getByTestId("wrap-toggle"));
      expectWrapped(container, "alice@example.com");

      fireEvent.click(getByTestId("wrap-toggle"));
      expectSingleLine(container, "alice@example.com");
    });

    test("every toggle drops the measured row heights, so turning wrap off shrinks rows back", () => {
      // The virtualizer caches each measured row; without a reset, rows grown while
      // wrapping keep that height after the toggle is off again.
      const { getByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
      mockVirtualizerMeasure.mockClear();

      fireEvent.click(getByTestId("wrap-toggle"));
      expect(mockVirtualizerMeasure).toHaveBeenCalledTimes(2);

      fireEvent.click(getByTestId("wrap-toggle"));
      expect(mockVirtualizerMeasure).toHaveBeenCalledTimes(4);
    });

    test("an editable cell wraps too", () => {
      const { container, getByTestId } = render(
        React.createElement(ResultsGrid, {
          result: mockResult,
          editingEnabled: true,
          onCellChange: mock(() => {}),
          pendingChanges: [],
        }),
      );
      fireEvent.click(getByTestId("wrap-toggle"));
      expectWrapped(container, "alice@example.com");
    });

    test("masked and revealed cells wrap too", () => {
      mockShouldMask.mockReturnValue(true);
      mockCanReveal.mockReturnValue(true);
      mockDetectSensitiveColumnsFromConfig.mockReturnValue(
        new Map([
          ["email", { name: "email", maskType: "email" as const, columnPatterns: ["email"], enabled: true, id: "e1" }],
        ]),
      );
      const { container, getByTestId } = render(
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
      fireEvent.click(getByTestId("wrap-toggle"));
      expectWrapped(container, "***");

      fireEvent.click(container.querySelector('button[title="Reveal value (10s)"]')!);
      expectWrapped(container, "alice@example.com");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Row detail on the desktop grid (#800)
  // ═══════════════════════════════════════════════════════════════════════

  describe("Row detail on the desktop grid", () => {
    // The desktop table is the only place that renders through TanStack columns, so a
    // control that came from the column list is on the desktop row and nowhere else.
    function detailControls(container: HTMLElement): HTMLButtonElement[] {
      return Array.from(container.querySelectorAll<HTMLButtonElement>("button[data-row-detail]"));
    }

    test("every desktop row carries a control that opens the row detail sheet", () => {
      const { container, queryByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));
      const controls = detailControls(container);
      expect(controls.length).toBe(mockResult.rows.length);

      expect(queryByTestId("row-detail-sheet")).toBeNull();
      fireEvent.click(controls[1]);
      expect(queryByTestId("row-detail-sheet")).not.toBeNull();
      expect(queryByTestId("row-detail-sheet")!.getAttribute("data-row-index")).toBe("1");
    });

    test("the control names the row it opens, so its accessible name is not bare", () => {
      const { getByRole } = render(React.createElement(ResultsGrid, { result: mockResult }));
      expect(getByRole("button", { name: "Show row 3 field by field" })).not.toBeNull();
    });

    test("the control opens the row the reader sees after sorting, not the unsorted one", () => {
      const { container, getAllByRole, queryByTestId } = render(
        React.createElement(ResultsGrid, { result: mockResult }),
      );
      // Descending on `name` puts Charlie first, so the first control must open row 2.
      fireEvent.click(getAllByRole("button", { name: "name" })[0]);
      fireEvent.click(getAllByRole("button", { name: "name, sorted ascending" })[0]);
      fireEvent.click(detailControls(container)[0]);
      expect(queryByTestId("row-detail-sheet")!.getAttribute("data-row-index")).toBe("2");
    });

    /**
     * The reason this issue existed at all: the vertical view shipped behind `md:hidden`,
     * so it was absent on exactly the screens that meet a wide table (#800). A breakpoint
     * class on the control or on the cell holding it would put it back there, and a
     * narrowed desktop window or a tablet would lose it in silence.
     */
    test("no breakpoint hides the control or the cell holding it", () => {
      const { container } = render(React.createElement(ResultsGrid, { result: mockResult }));
      // Without this the loop below asserts nothing when no control was rendered at all.
      expect(detailControls(container).length).toBeGreaterThan(0);
      for (const control of detailControls(container)) {
        for (let el: HTMLElement | null = control; el !== null; el = el.parentElement) {
          // The desktop grid's own `hidden md:block` is the boundary, not a finding: below
          // that width the card and mobile table render, and both already open the sheet.
          if (el.hasAttribute("data-desktop-grid")) break;
          const classes = (el.getAttribute("class") ?? "").split(/\s+/);
          expect(classes.filter((c) => /^(sm|md|lg|xl|2xl):/.test(c) || c === "hidden")).toEqual([]);
        }
      }
    });

    test("the control column cannot be resized, so it keeps its width", () => {
      const { container } = render(React.createElement(ResultsGrid, { result: mockResult }));
      const headers = Array.from(container.querySelectorAll("[data-row-detail-header]"));
      expect(headers.length).toBe(1);
      expect(headers[0].querySelector(".cursor-col-resize")).toBeNull();
      // The field columns keep theirs: the guard is per column, not a removal.
      expect(container.querySelectorAll(".cursor-col-resize").length).toBe(mockResult.fields.length);
    });

    /**
     * `SELECT 1 AS "__libredb_row_detail__"` is legal, and a result set carrying that
     * column name must still render both it and the control, not one column swallowing
     * the other.
     */
    test("a field named like the control column still gets its own column", () => {
      const collidingResult: QueryResult = {
        rows: [{ __libredb_row_detail__: "value", id: 1 }],
        fields: ["__libredb_row_detail__", "id"],
        rowCount: 1,
        executionTime: 1,
      };
      const { container, getAllByRole } = render(React.createElement(ResultsGrid, { result: collidingResult }));
      expect(detailControls(container).length).toBe(1);
      expect(getAllByRole("button", { name: "__libredb_row_detail__" }).length).toBeGreaterThan(0);

      // Two columns under one id is what breaks: the grid keys header and body cells by
      // the column id, and every cell answering to it is then styled as the control -
      // the field's own value would be pinned to the left edge in the control's place.
      const desktop = container.querySelector("[data-desktop-grid]")!;
      const valueCell = Array.from(desktop.querySelectorAll("span")).find((el) => el.textContent === "value");
      expect(valueCell).toBeDefined();
      expect(valueCell!.closest("[style*='width']")!.getAttribute("class")).not.toContain("sticky");
    });
  });
});
