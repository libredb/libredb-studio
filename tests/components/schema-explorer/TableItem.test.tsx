import "../../setup-dom";
import "../../helpers/mock-navigation";

import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

// The SHARED sonner mock rather than a local `mock.module("sonner", ...)`: mock.module is
// process-wide and the last call wins, so a second declaration here would hand
// StudioMobileHeader.test.tsx — same group in tests/run-components.sh — a `toast` whose
// error mock it holds no reference to.
import { mockToastError, mockToastSuccess } from "../../helpers/mock-sonner";

// The insecure-context harness, as in tests/components/copy-button.test.tsx: an absent
// `navigator.clipboard` is what plain HTTP off loopback actually hands the page, and an
// editing command that answers false is what a browser that refuses the copy does.
const originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
const originalExecCommand = Object.getOwnPropertyDescriptor(globalThis.document, "execCommand");

function setExecCommand(execCommand: ((command: string) => boolean) | undefined): void {
  Object.defineProperty(globalThis.document, "execCommand", { value: execCommand, configurable: true });
}

// ── Mocks ───────────────────────────────────────────────────────────────────

mock.module("framer-motion", () => ({
  motion: new Proxy(
    {},
    {
      get: () => (props: Record<string, unknown>) =>
        React.createElement("div", props, props.children as React.ReactNode),
    },
  ),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
}));

mock.module("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "dropdown" }, children),
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) =>
    React.createElement("div", { onClick, role: "menuitem" }, children),
  DropdownMenuSeparator: () => React.createElement("hr"),
}));

mock.module("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
  ContextMenuContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "context-menu" }, children),
  ContextMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) =>
    React.createElement("div", { onClick, role: "menuitem" }, children),
  ContextMenuSeparator: () => React.createElement("hr"),
}));

mock.module("@/components/schema-explorer/ColumnList", () => ({
  ColumnList: ({ columns, indexes }: { columns: unknown[]; indexes: unknown[] }) =>
    React.createElement("div", { "data-testid": "column-list" }, `${columns.length} cols, ${indexes.length} idx`),
}));

// ── Imports after mocks ─────────────────────────────────────────────────────

import { TableItem } from "@/components/schema-explorer/TableItem";
import type { TableSchema } from "@/lib/types";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";

// Capability fixtures are partial on purpose: TableItem reads three fields, and
// spelling out every ProviderCapabilities key in each case would bury them (#427).
type Caps = ProviderMetadata["capabilities"];
const caps = (partial: Partial<Caps>): Caps => partial as Caps;

/** Postgres-shaped: ordinary tables, both maintenance operations declared. */
const sqlCaps = caps({ supportsMaintenance: true, maintenanceOperations: ["vacuum", "analyze"] });
/** Redis-shaped: rows are derived key-prefix groupings, only ANALYZE declared. */
const redisCaps = caps({
  tablesAreDerivedGroupings: true,
  supportsMaintenance: true,
  maintenanceOperations: ["analyze"],
});
/**
 * LibreDB-shaped: the OTHER provider that declares `tablesAreDerivedGroupings`,
 * and the one the Redis fixture does not stand in for — it declares NO
 * maintenance at all, so its rows lose the same four items by two independent
 * gates rather than one (#427).
 */
const libredbCaps = caps({
  tablesAreDerivedGroupings: true,
  supportsMaintenance: false,
  maintenanceOperations: [],
});
/**
 * Search-shaped (Elasticsearch / OpenSearch, #424 Phase 1): an index is a real,
 * addressable object — so the `tablesAreDerivedGroupings` gate does NOT catch it —
 * and the engine still declares no maintenance of any kind.
 */
const searchCaps = caps({ supportsMaintenance: false, maintenanceOperations: [] });
/**
 * SQLite-shaped (#U9): `VACUUM` rewrites the whole file and takes no target, so the
 * provider declares `vacuum: { perEntity: false }` — and the monitoring Tables tab
 * already withholds that control while this menu still offered it for ONE table.
 */
const sqliteCaps = caps({
  supportsMaintenance: true,
  maintenanceOperations: ["vacuum", "analyze", "reindex", "check"],
  maintenanceOperationSpecs: {
    vacuum: { label: "Vacuum Database", perEntity: false, global: true },
    analyze: { label: "Analyze Table", perEntity: true, global: true },
  },
});
/**
 * MySQL-shaped (#U9): no `vacuum` at all, and the vacuum SLOT names `optimize` —
 * which is the operation whose `perEntity` decides whether the item may appear.
 */
const mysqlCaps = caps({
  supportsMaintenance: true,
  maintenanceOperations: ["analyze", "optimize", "check", "kill"],
  maintenanceOperationSpecs: {
    analyze: { label: "Analyze Table", perEntity: true, global: true },
    optimize: { label: "Optimize Table", perEntity: true, global: true },
  },
});

/**
 * Labels are partial for the same reason capabilities are: TableItem reads four
 * of the fifteen. The two defaults spelled out here are `BaseDatabaseProvider`'s
 * own, so a case that overrides one is visibly overriding it (#427).
 */
type Labels = ProviderMetadata["labels"];
const labelsFor = (partial: Partial<Labels>): Labels =>
  ({ analyzeAction: "Analyze Table", vacuumAction: "Vacuum Table", ...partial }) as Labels;

// ── Test data ───────────────────────────────────────────────────────────────

const largeTable: TableSchema = {
  name: "users",
  rowCount: 1500,
  indexes: [{ name: "idx_users_email", columns: ["email"], unique: true }],
  columns: [
    { name: "id", type: "SERIAL", nullable: false, isPrimary: true },
    { name: "email", type: "VARCHAR(255)", nullable: true, isPrimary: false },
  ],
};

const smallTable: TableSchema = {
  name: "settings",
  rowCount: 42,
  indexes: [],
  columns: [
    { name: "key", type: "TEXT", nullable: false, isPrimary: true },
    { name: "value", type: "TEXT", nullable: true, isPrimary: false },
  ],
};

const noRowCountTable: TableSchema = {
  name: "logs",
  indexes: [],
  columns: [{ name: "id", type: "SERIAL", nullable: false, isPrimary: true }],
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe("TableItem", () => {
  let mockWriteText: ReturnType<typeof mock>;

  beforeEach(() => {
    mockWriteText = mock(async (text: string) => {
      void text;
    });
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText: mockWriteText },
      configurable: true,
    });
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    cleanup();
    if (originalClipboard === undefined)
      Object.defineProperty(globalThis.navigator, "clipboard", { value: undefined, configurable: true });
    else Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
    if (originalExecCommand === undefined) setExecCommand(undefined);
    else Object.defineProperty(globalThis.document, "execCommand", originalExecCommand);
  });

  // ── Rendering ─────────────────────────────────────────────────────────────

  test("renders table name", () => {
    const { queryByText } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />,
    );
    expect(queryByText("users")).not.toBeNull();
  });

  test("renders row count formatted as K for >= 1000", () => {
    const { queryByText } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />,
    );
    expect(queryByText("1.5k")).not.toBeNull();
  });

  test("renders raw row count for < 1000", () => {
    const { queryByText } = render(
      <TableItem table={smallTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />,
    );
    expect(queryByText("42")).not.toBeNull();
  });

  test("does not render row count when undefined", () => {
    const { queryByText } = render(
      <TableItem table={noRowCountTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />,
    );
    // No row count text should be rendered
    expect(queryByText(/^\d/)).toBeNull();
  });

  // ── Expand / Collapse ─────────────────────────────────────────────────────

  test("hides ColumnList when collapsed", () => {
    const { queryByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />,
    );
    expect(queryByTestId("column-list")).toBeNull();
  });

  test("shows ColumnList with columns and indexes when expanded", () => {
    const { queryByTestId } = render(
      <TableItem table={largeTable} isExpanded onToggle={mock(() => {})} isAdmin={false} />,
    );
    const columnList = queryByTestId("column-list");
    expect(columnList).not.toBeNull();
    expect(columnList!.textContent).toContain("2 cols");
    expect(columnList!.textContent).toContain("1 idx");
  });

  test("applies bg-accent/50 class when expanded", () => {
    const { container } = render(<TableItem table={largeTable} isExpanded onToggle={mock(() => {})} isAdmin={false} />);
    const row = container.querySelector(".bg-accent\\/50");
    expect(row).not.toBeNull();
  });

  // ── onToggle ──────────────────────────────────────────────────────────────

  test("calls onToggle when row is clicked", () => {
    const onToggle = mock(() => {});
    const { queryByText } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={onToggle} isAdmin={false} />,
    );
    fireEvent.click(queryByText("users")!);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  // ── Dropdown action callbacks ─────────────────────────────────────────────

  test('onTableClick fires with table name on "Select Top 50" click', () => {
    const onTableClick = mock((name: string) => {
      void name;
    });
    const { getByTestId } = render(
      <TableItem
        table={largeTable}
        isExpanded={false}
        onToggle={mock(() => {})}
        isAdmin={false}
        onTableClick={onTableClick}
      />,
    );
    const dropdown = within(getByTestId("dropdown"));
    fireEvent.click(dropdown.getByText("Select Top 50"));
    expect(onTableClick).toHaveBeenCalledTimes(1);
    expect(onTableClick.mock.calls[0][0]).toBe("users");
  });

  test('onGenerateSelect fires with table name on "Generate Query" click', () => {
    const onGenerateSelect = mock((name: string) => {
      void name;
    });
    const { getByTestId } = render(
      <TableItem
        table={largeTable}
        isExpanded={false}
        onToggle={mock(() => {})}
        isAdmin={false}
        onGenerateSelect={onGenerateSelect}
      />,
    );
    const dropdown = within(getByTestId("dropdown"));
    fireEvent.click(dropdown.getByText("Generate Query"));
    expect(onGenerateSelect).toHaveBeenCalledTimes(1);
    expect(onGenerateSelect.mock.calls[0][0]).toBe("users");
  });

  test('copyToClipboard copies table name and shows toast on "Copy Name" click', async () => {
    const { getByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />,
    );
    const dropdown = within(getByTestId("dropdown"));
    fireEvent.click(dropdown.getByText("Copy Name"));
    expect(mockWriteText).toHaveBeenCalledTimes(1);
    expect(mockWriteText.mock.calls[0][0]).toBe("users");
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledTimes(1));
    expect(String((mockToastSuccess.mock.calls as unknown[][])[0][0])).toContain("copied to clipboard");
  });

  // B43: the success toast used to fire in the same statement that started the write, so
  // on the plain-HTTP channels this product ships on it announced a copy that never
  // happened. The refusal here is the real one: no clipboard object at all, and an
  // editing command that answers false.
  test('"Copy Name" says the copy failed when both write paths refuse', async () => {
    Object.defineProperty(globalThis.navigator, "clipboard", { value: undefined, configurable: true });
    setExecCommand(() => false);

    const { getByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />,
    );
    const dropdown = within(getByTestId("dropdown"));
    fireEvent.click(dropdown.getByText("Copy Name"));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
    expect(String((mockToastError.mock.calls as unknown[][])[0][0])).toContain("Could not copy");
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  test('onProfileTable fires with table name on "Profile Table" click', () => {
    const onProfileTable = mock((name: string) => {
      void name;
    });
    const { getByTestId } = render(
      <TableItem
        table={largeTable}
        isExpanded={false}
        onToggle={mock(() => {})}
        isAdmin={false}
        onProfileTable={onProfileTable}
      />,
    );
    const dropdown = within(getByTestId("dropdown"));
    fireEvent.click(dropdown.getByText("Profile Table"));
    expect(onProfileTable).toHaveBeenCalledTimes(1);
    expect(onProfileTable.mock.calls[0][0]).toBe("users");
  });

  test('onGenerateCode fires with table name on "Generate Code" click', () => {
    const onGenerateCode = mock((name: string) => {
      void name;
    });
    const { getByTestId } = render(
      <TableItem
        table={largeTable}
        isExpanded={false}
        onToggle={mock(() => {})}
        isAdmin={false}
        onGenerateCode={onGenerateCode}
      />,
    );
    const dropdown = within(getByTestId("dropdown"));
    fireEvent.click(dropdown.getByText("Generate Code"));
    expect(onGenerateCode).toHaveBeenCalledTimes(1);
    expect(onGenerateCode.mock.calls[0][0]).toBe("users");
  });

  test('onGenerateTestData fires with table name on "Generate Test Data" click', () => {
    const onGenerateTestData = mock((name: string) => {
      void name;
    });
    const { getByTestId } = render(
      <TableItem
        table={largeTable}
        isExpanded={false}
        onToggle={mock(() => {})}
        isAdmin={false}
        onGenerateTestData={onGenerateTestData}
      />,
    );
    const dropdown = within(getByTestId("dropdown"));
    fireEvent.click(dropdown.getByText("Generate Test Data"));
    expect(onGenerateTestData).toHaveBeenCalledTimes(1);
    expect(onGenerateTestData.mock.calls[0][0]).toBe("users");
  });

  // ── Admin-only actions ────────────────────────────────────────────────────

  test("shows Analyze and Vacuum actions for admin", () => {
    const { getByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin capabilities={sqlCaps} />,
    );
    const dropdown = within(getByTestId("dropdown"));
    expect(dropdown.queryByText("Analyze Table")).not.toBeNull();
    expect(dropdown.queryByText("Vacuum Table")).not.toBeNull();
  });

  test("hides Analyze and Vacuum actions for non-admin", () => {
    const { getByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />,
    );
    const dropdown = within(getByTestId("dropdown"));
    expect(dropdown.queryByText("Analyze Table")).toBeNull();
    expect(dropdown.queryByText("Vacuum Table")).toBeNull();
  });

  test('onOpenMaintenance fires with "tables" and table name on Analyze click', () => {
    const onOpenMaintenance = mock((tab?: string, tbl?: string) => {
      void tab;
      void tbl;
    });
    const { getByTestId } = render(
      <TableItem
        table={largeTable}
        isExpanded={false}
        onToggle={mock(() => {})}
        isAdmin
        capabilities={sqlCaps}
        onOpenMaintenance={onOpenMaintenance}
      />,
    );
    const dropdown = within(getByTestId("dropdown"));
    fireEvent.click(dropdown.getByText("Analyze Table"));
    expect(onOpenMaintenance).toHaveBeenCalledTimes(1);
    expect(onOpenMaintenance.mock.calls[0][0]).toBe("tables");
    expect(onOpenMaintenance.mock.calls[0][1]).toBe("users");
  });

  test("onOpenMaintenance fires on Vacuum click", () => {
    const onOpenMaintenance = mock((tab?: string, tbl?: string) => {
      void tab;
      void tbl;
    });
    const { getByTestId } = render(
      <TableItem
        table={largeTable}
        isExpanded={false}
        onToggle={mock(() => {})}
        isAdmin
        capabilities={sqlCaps}
        onOpenMaintenance={onOpenMaintenance}
      />,
    );
    const dropdown = within(getByTestId("dropdown"));
    fireEvent.click(dropdown.getByText("Vacuum Table"));
    expect(onOpenMaintenance).toHaveBeenCalledTimes(1);
    expect(onOpenMaintenance.mock.calls[0][0]).toBe("tables");
    expect(onOpenMaintenance.mock.calls[0][1]).toBe("users");
  });

  // ── Custom labels ─────────────────────────────────────────────────────────

  test("uses custom labels from provider metadata", () => {
    const labels = {
      selectAction: "Run db.find()",
      generateAction: "Build Aggregation",
      entityName: "Collection",
      entityNamePlural: "Collections",
      rowName: "document",
      rowNamePlural: "documents",
      analyzeAction: "Run Stats",
      vacuumAction: "Compact",
      searchPlaceholder: "Search collections...",
      analyzeGlobalLabel: "Analyze All",
      analyzeGlobalTitle: "Analyze",
      analyzeGlobalDesc: "Run stats on all",
      vacuumGlobalLabel: "Compact All",
      vacuumGlobalTitle: "Compact",
      vacuumGlobalDesc: "Compact all",
    };
    const { getByTestId } = render(
      <TableItem
        table={largeTable}
        isExpanded={false}
        onToggle={mock(() => {})}
        isAdmin
        capabilities={sqlCaps}
        labels={labels}
      />,
    );
    const dropdown = within(getByTestId("dropdown"));
    expect(dropdown.queryByText("Run db.find()")).not.toBeNull();
    expect(dropdown.queryByText("Build Aggregation")).not.toBeNull();
    expect(dropdown.queryByText("Run Stats")).not.toBeNull();
    expect(dropdown.queryByText("Compact")).not.toBeNull();
    // Default labels should not appear
    expect(dropdown.queryByText("Select Top 50")).toBeNull();
    expect(dropdown.queryByText("Generate Query")).toBeNull();
  });

  test("copyToClipboard uses custom entityName in toast", async () => {
    const labels = {
      entityName: "Collection",
      entityNamePlural: "Collections",
      rowName: "document",
      rowNamePlural: "documents",
      selectAction: "Select Top 100",
      generateAction: "Generate Query",
      analyzeAction: "Analyze Table",
      vacuumAction: "Vacuum Table",
      searchPlaceholder: "Search...",
      analyzeGlobalLabel: "Analyze All",
      analyzeGlobalTitle: "Analyze",
      analyzeGlobalDesc: "Run stats",
      vacuumGlobalLabel: "Compact All",
      vacuumGlobalTitle: "Compact",
      vacuumGlobalDesc: "Compact all",
    };
    const { getByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} labels={labels} />,
    );
    const dropdown = within(getByTestId("dropdown"));
    fireEvent.click(dropdown.getByText("Copy Name"));
    await waitFor(() => expect(String((mockToastSuccess.mock.calls as unknown[][])[0][0])).toContain("Collection"));
  });

  // ── Callbacks not provided (optional chaining safety) ─────────────────────

  test("does not crash when optional callbacks are not provided", () => {
    const { getByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin capabilities={sqlCaps} />,
    );
    const dropdown = within(getByTestId("dropdown"));
    // Click all menu items without providing callbacks - should not throw
    fireEvent.click(dropdown.getByText("Select Top 50"));
    fireEvent.click(dropdown.getByText("Generate Query"));
    fireEvent.click(dropdown.getByText("Profile Table"));
    fireEvent.click(dropdown.getByText("Generate Code"));
    fireEvent.click(dropdown.getByText("Generate Test Data"));
    fireEvent.click(dropdown.getByText("Analyze Table"));
    fireEvent.click(dropdown.getByText("Vacuum Table"));
    // If we got here, no crash occurred
    expect(true).toBe(true);
  });

  // ── Expanded state styling ────────────────────────────────────────────────

  test("table name has text-foreground class when expanded", () => {
    const { queryByText } = render(
      <TableItem table={largeTable} isExpanded onToggle={mock(() => {})} isAdmin={false} />,
    );
    const nameSpan = queryByText("users");
    expect(nameSpan).not.toBeNull();
    expect(nameSpan!.className).toContain("text-foreground");
  });

  test("table name has text-muted-foreground class when collapsed", () => {
    const { queryByText } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />,
    );
    const nameSpan = queryByText("users");
    expect(nameSpan).not.toBeNull();
    expect(nameSpan!.className).toContain("text-muted-foreground");
  });

  // ── Context menu ──────────────────────────────────────────────────────────

  test("renders context menu with same actions as dropdown", () => {
    const { queryAllByText } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin capabilities={sqlCaps} />,
    );
    // Each action should appear twice: once in dropdown, once in context menu
    expect(queryAllByText("Select Top 50").length).toBe(2);
    expect(queryAllByText("Generate Query").length).toBe(2);
    expect(queryAllByText("Copy Name").length).toBe(2);
    expect(queryAllByText("Profile Table").length).toBe(2);
    expect(queryAllByText("Generate Code").length).toBe(2);
    expect(queryAllByText("Generate Test Data").length).toBe(2);
    expect(queryAllByText("Analyze Table").length).toBe(2);
    expect(queryAllByText("Vacuum Table").length).toBe(2);
  });

  test("context menu actions are not duplicated for non-admin", () => {
    const { queryAllByText } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />,
    );
    // Standard actions appear twice (dropdown + context menu)
    expect(queryAllByText("Select Top 50").length).toBe(2);
    // Admin-only actions should not appear at all
    expect(queryAllByText("Analyze Table").length).toBe(0);
    expect(queryAllByText("Vacuum Table").length).toBe(0);
  });

  // ── A11y semantics (#100) ─────────────────────────────────────────────────

  describe("a11y semantics", () => {
    test("expand toggle is a button named after the table with aria-expanded", () => {
      const onToggle = mock(() => {});
      const { getByRole } = render(<TableItem table={largeTable} isExpanded={false} onToggle={onToggle} isAdmin />);
      const toggle = getByRole("button", { name: "users" });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(toggle);
      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    test("expanded state is reflected on the toggle button", () => {
      const { getByRole } = render(
        <TableItem table={largeTable} isExpanded={true} onToggle={mock(() => {})} isAdmin />,
      );
      expect(getByRole("button", { name: "users" }).getAttribute("aria-expanded")).toBe("true");
    });

    test("the toggle button owns the row's vertical padding (full-height hit target)", () => {
      const { getByRole } = render(
        <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin />,
      );
      const toggle = getByRole("button", { name: "users" });
      expect(toggle.className).toContain("py-1.5");
      expect(toggle.parentElement?.className).not.toContain("py-1.5");
    });
  });
  // ── Derived-grouping rows and declared maintenance (#427) ─────────────────

  describe("capability gating (#427)", () => {
    test("hides Profile Table and Generate Test Data when rows are derived groupings", () => {
      const { getByTestId } = render(
        <TableItem
          table={largeTable}
          isExpanded={false}
          onToggle={mock(() => {})}
          isAdmin={false}
          capabilities={redisCaps}
        />,
      );
      const dropdown = within(getByTestId("dropdown"));
      expect(dropdown.queryByText("Profile Table")).toBeNull();
      expect(dropdown.queryByText("Generate Test Data")).toBeNull();
    });

    test("keeps Generate Code visible when rows are derived groupings", () => {
      const { getByTestId } = render(
        <TableItem
          table={largeTable}
          isExpanded={false}
          onToggle={mock(() => {})}
          isAdmin={false}
          capabilities={redisCaps}
        />,
      );
      const dropdown = within(getByTestId("dropdown"));
      expect(dropdown.queryByText("Generate Code")).not.toBeNull();
    });

    test("shows Profile Table and Generate Test Data when rows are addressable objects", () => {
      const { getByTestId } = render(
        <TableItem
          table={largeTable}
          isExpanded={false}
          onToggle={mock(() => {})}
          isAdmin={false}
          capabilities={sqlCaps}
        />,
      );
      const dropdown = within(getByTestId("dropdown"));
      expect(dropdown.queryByText("Profile Table")).not.toBeNull();
      expect(dropdown.queryByText("Generate Test Data")).not.toBeNull();
    });

    test("offers no per-row maintenance at all when rows are derived groupings (#427)", () => {
      // The issue's own symptom: Redis declares `analyze`, so "Key Info" survived
      // a declared-operation gate and still called onOpenMaintenance("tables",
      // "user:*") — a row the maintenance page cannot name.
      const { getByTestId } = render(
        <TableItem
          table={largeTable}
          isExpanded={false}
          onToggle={mock(() => {})}
          isAdmin
          capabilities={redisCaps}
          labels={labelsFor({ analyzeAction: "Key Info", vacuumAction: "Memory Doctor" })}
        />,
      );
      const dropdown = within(getByTestId("dropdown"));
      expect(dropdown.queryByText("Key Info")).toBeNull();
      expect(dropdown.queryByText("Memory Doctor")).toBeNull();
    });

    // The embedded LibreDB provider declares the same flag as Redis, so the gate
    // reaches it too and its doc had to say so (docs/providers/libredb.md 5.3).
    // A Redis-shaped fixture alone would not have caught a regression here: its
    // labels and its maintenance list are both different (#427).
    test("hides the same four items for the embedded LibreDB provider (#427)", () => {
      const { getByTestId } = render(
        <TableItem
          table={largeTable}
          isExpanded={false}
          onToggle={mock(() => {})}
          isAdmin
          capabilities={libredbCaps}
          labels={labelsFor({ analyzeAction: "Key Info", vacuumAction: "Compact" })}
        />,
      );
      const dropdown = within(getByTestId("dropdown"));
      expect(dropdown.queryByText("Profile Table")).toBeNull();
      expect(dropdown.queryByText("Generate Test Data")).toBeNull();
      expect(dropdown.queryByText("Key Info")).toBeNull();
      expect(dropdown.queryByText("Compact")).toBeNull();
      // Naming the row is still fine; addressing it is not.
      expect(dropdown.queryByText("Generate Code")).not.toBeNull();
    });

    /*
      The #427 gate stopped one row short. Its rule was "a per-row maintenance action
      needs an addressable row", which is true and is not the whole test: an index on a
      search cluster IS addressable, so both items rendered — and the engine declares
      `supportsMaintenance: false`, so the page they open offers nothing at all.

      Measured in the browser on 2026-08-19 against Elasticsearch 9.1.4: clicking
      "Merge Segments" on an index navigated to /admin/operations, where the Global
      Operations card is itself gated on the same capability and so was absent. No
      error, no explanation, nothing about merging — the labels written for exactly
      this moment ("Merging is an index API rather than a statement this SQL surface
      can send, so nothing runs from here") are on the card that does not render.
    */
    test("hides both items on an engine that declares no maintenance, addressable rows or not", () => {
      const { getByTestId } = render(
        <TableItem
          table={largeTable}
          isExpanded={false}
          onToggle={mock(() => {})}
          isAdmin
          capabilities={searchCaps}
          labels={labelsFor({ analyzeAction: "Index Statistics", vacuumAction: "Merge Segments" })}
        />,
      );
      const dropdown = within(getByTestId("dropdown"));
      expect(dropdown.queryByText("Index Statistics")).toBeNull();
      expect(dropdown.queryByText("Merge Segments")).toBeNull();
      // The row IS addressable here, so everything the #427 gate removes for a
      // derived grouping stays: this gate is about maintenance and nothing else.
      expect(dropdown.queryByText("Profile Table")).not.toBeNull();
      expect(dropdown.queryByText("Generate Test Data")).not.toBeNull();
    });

    /*
      A THIRD surface renders the same wording (#U9). This menu gated both items on
      `supportsMaintenance` alone, so on SQLite it offered "Vacuum Table" for ONE table
      while the monitoring Tables tab correctly withheld that control — SQLite declares
      `vacuum: { perEntity: false }` because `VACUUM` rewrites the whole file and
      ignores a target. Clicking it deep-linked to a page with no such control: the
      exact dead end this file's own comment above records as fixed for Elasticsearch.
    */
    test("withholds the vacuum item where the provider says vacuum takes no table", () => {
      const { getByTestId } = render(
        <TableItem
          table={largeTable}
          isExpanded={false}
          onToggle={mock(() => {})}
          isAdmin
          capabilities={sqliteCaps}
          labels={labelsFor({})}
        />,
      );
      const dropdown = within(getByTestId("dropdown"));
      expect(dropdown.queryByText("Vacuum Table")).toBeNull();
      // Analyze DOES take a table here, so this is not the blanket withholding the
      // no-maintenance engines get.
      expect(dropdown.queryByText("Analyze Table")).not.toBeNull();
    });

    test("follows the vacuum slot to the operation it actually names", () => {
      // MySQL declares no `vacuum`; its vacuum slot says "Optimize Table" and
      // `vacuumActionOperation` says that is `optimize`, which IS per-table here.
      const { getByTestId } = render(
        <TableItem
          table={largeTable}
          isExpanded={false}
          onToggle={mock(() => {})}
          isAdmin
          capabilities={mysqlCaps}
          labels={labelsFor({ vacuumAction: "Optimize Table", vacuumActionOperation: "optimize" })}
        />,
      );
      const dropdown = within(getByTestId("dropdown"));
      expect(dropdown.queryByText("Optimize Table")).not.toBeNull();
      expect(dropdown.queryByText("Vacuum Table")).toBeNull();
    });

    test("takes the wording from the provider's own declaration, not from the label slot", () => {
      // `label` on the spec is the engine's own name for the control and it wins over
      // BOTH `labels.analyzeAction` and this component's generic fallback, exactly as
      // it does on the other two surfaces. All three strings are different here on
      // purpose: asserting the spec label while it reads the same as the fallback
      // ("Analyze Table") cannot fail, whichever branch the component took.
      const { getByTestId } = render(
        <TableItem
          table={largeTable}
          isExpanded={false}
          onToggle={mock(() => {})}
          isAdmin
          capabilities={caps({
            supportsMaintenance: true,
            maintenanceOperations: ["analyze"],
            maintenanceOperationSpecs: { analyze: { label: "Refresh Statistics", perEntity: true, global: true } },
          })}
          labels={labelsFor({ analyzeAction: "Gather Statistics" })}
        />,
      );
      const dropdown = within(getByTestId("dropdown"));
      expect(dropdown.queryByText("Refresh Statistics")).not.toBeNull();
      expect(dropdown.queryByText("Gather Statistics")).toBeNull();
      expect(dropdown.queryByText("Analyze Table")).toBeNull();
    });

    test("offers nothing while the capabilities are still unknown", () => {
      // `/api/db/provider-meta` answers with nothing both while it is in flight and
      // when it failed, and both maintenance surfaces read that as a denial. A menu
      // that guessed "offer it" is how the dead buttons came back.
      const { getByTestId } = render(
        <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin labels={labelsFor({})} />,
      );
      const dropdown = within(getByTestId("dropdown"));
      expect(dropdown.queryByText("Analyze Table")).toBeNull();
      expect(dropdown.queryByText("Vacuum Table")).toBeNull();
    });

    test("hides maintenance from a non-admin even when declared", () => {
      const { getByTestId } = render(
        <TableItem
          table={largeTable}
          isExpanded={false}
          onToggle={mock(() => {})}
          isAdmin={false}
          capabilities={sqlCaps}
        />,
      );
      const dropdown = within(getByTestId("dropdown"));
      expect(dropdown.queryByText("Analyze Table")).toBeNull();
      expect(dropdown.queryByText("Vacuum Table")).toBeNull();
    });
  });
});
