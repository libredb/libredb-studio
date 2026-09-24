import "../../setup-dom";
import "../../helpers/mock-navigation";

import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

// The SHARED sonner mock rather than a local `mock.module("sonner", ...)`: mock.module is
// process-wide and the last call wins, so a second declaration here would replace the one
// bunfig preloads for this process and hand the tests below a `toast` whose error mock
// nothing in this file holds a reference to.
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
import type { DetailedObject } from "@/lib/db/detailed-object";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";

// Capability fixtures are partial on purpose: TableItem reads a handful of fields, and
// spelling out every ProviderCapabilities key in each case would bury them (#427).
type Caps = ProviderMetadata["capabilities"];
const caps = (partial: Partial<Caps>): Caps => partial as Caps;

/**
 * The kinds the fixtures declare, written the way a provider writes them (#1085, D-M). A
 * `table` takes row writes and a `view` does not: the per-KIND half of the row-write rule the
 * desktop tree asks, which this menu asks too since #1085 (decision D-M).
 */
const tableKind = {
  id: "table",
  role: "relation",
  label: "Table",
  labelPlural: "Tables",
  acceptsRowWrites: true,
} as const;
const viewKind = { id: "view", role: "relation", label: "View", labelPlural: "Views" } as const;

/** Postgres-shaped: tables that take row writes, views that do not, both maintenance operations declared. */
const sqlCaps = caps({
  queryLanguage: "sql",
  objectKinds: [tableKind, viewKind],
  supportsInlineRowEdit: true,
  supportsMaintenance: true,
  maintenanceOperations: ["vacuum", "analyze"],
});
/**
 * Redis-shaped: rows are derived key-prefix groupings, the language is JSON in a dialect of
 * its own, the grid edits no row, and only ANALYZE is declared.
 */
const redisCaps = caps({
  queryLanguage: "json",
  queryDialect: "redis",
  supportsInlineRowEdit: false,
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
  queryLanguage: "json",
  queryDialect: "libredb",
  supportsInlineRowEdit: false,
  tablesAreDerivedGroupings: true,
  supportsMaintenance: false,
  maintenanceOperations: [],
});
/**
 * Search-shaped (Elasticsearch / OpenSearch, #424 Phase 1): an index is a real,
 * addressable object — so the `tablesAreDerivedGroupings` gate does NOT catch it —
 * and the engine still declares no maintenance of any kind.
 */
const searchCaps = caps({
  queryLanguage: "sql",
  // An index takes a bulk document write while the engine declares no grid row edit, which
  // is why Generate Test Data is withheld on it since D-M (#1085).
  objectKinds: [{ id: "index", role: "relation", label: "Index", labelPlural: "Indices", acceptsRowWrites: true }],
  supportsInlineRowEdit: false,
  supportsMaintenance: false,
  maintenanceOperations: [],
});
/**
 * SQLite-shaped (#496): `VACUUM` rewrites the whole file and takes no target, so the
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
 * MySQL-shaped (#496): no `vacuum` at all, and the vacuum SLOT names `optimize` —
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

const largeTable: DetailedObject = {
  name: "users",
  kind: "table",
  path: ["users"],
  rowCount: 1500,
  indexes: [{ name: "idx_users_email", columns: ["email"], unique: true }],
  columns: [
    { name: "id", type: "SERIAL", nullable: false, isPrimary: true },
    { name: "email", type: "VARCHAR(255)", nullable: true, isPrimary: false },
  ],
};

/**
 * The same object OUTSIDE the session default container, which is the only fixture the two
 * menu items below can be measured with: `name` is the label and `path` is the address
 * (standing ruling 2), and at path `["users"]` the two are the same string, so an
 * implementation still handing over the name would pass (#789).
 */
const qualifiedTable: DetailedObject = { ...largeTable, path: ["app", "users"] };

const smallTable: DetailedObject = {
  name: "settings",
  kind: "table",
  path: ["settings"],
  rowCount: 42,
  indexes: [],
  columns: [
    { name: "key", type: "TEXT", nullable: false, isPrimary: true },
    { name: "value", type: "TEXT", nullable: true, isPrimary: false },
  ],
};

const noRowCountTable: DetailedObject = {
  name: "logs",
  kind: "table",
  path: ["logs"],
  indexes: [],
  columns: [{ name: "id", type: "SERIAL", nullable: false, isPrimary: true }],
};

/** A view beside `largeTable`: a relation with columns whose kind declares no row writes (#1085, D-M). */
const viewObject: DetailedObject = { ...largeTable, name: "active_users", kind: "view", path: ["active_users"] };

/** An index on a search engine, the row `searchCaps` declares. */
const searchIndex: DetailedObject = { ...largeTable, name: "orders", kind: "index", path: ["orders"] };

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
    expect(queryByText("1.5K")).not.toBeNull();
  });

  test("compacts millions while the title carries the full reported count and its caveat", () => {
    const { getByText } = render(
      <TableItem
        table={{ ...largeTable, rowCount: 1553900 }}
        isExpanded={false}
        onToggle={mock(() => {})}
        isAdmin={false}
      />,
    );
    expect(getByText("1.6M").title).toContain("1,553,900");
    expect(getByText("1.6M").title).toContain("estimate");
    // The count itself ignores pointer events; the slot under its menu button must
    // carry the title too, otherwise a real pointer can never reach that tooltip.
    expect(getByText("1.6M").parentElement?.title).toBe(getByText("1.6M").title);
  });

  test.each(["dropdown", "context-menu"])(
    "the %s count action passes the address, without selecting rows",
    (surface) => {
      const onGenerateCount = mock(() => {});
      const onTableClick = mock(() => {});
      const { getByTestId } = render(
        <TableItem
          table={qualifiedTable}
          isExpanded={false}
          onToggle={mock(() => {})}
          isAdmin={false}
          capabilities={caps({ queryLanguage: "sql" })}
          onGenerateCount={onGenerateCount}
          onTableClick={onTableClick}
        />,
      );
      fireEvent.click(within(getByTestId(surface)).getByText("Generate Count Query"));
      expect(onGenerateCount).toHaveBeenCalledWith(["app", "users"]);
      expect(onTableClick).not.toHaveBeenCalled();
    },
  );

  test.each([undefined, redisCaps, libredbCaps, caps({ queryLanguage: "promql" })])(
    "withholds count for unresolved or unsupported capabilities (%#)",
    (capabilities) => {
      const { queryAllByText } = render(
        <TableItem
          table={largeTable}
          isExpanded={false}
          onToggle={mock(() => {})}
          isAdmin={false}
          capabilities={capabilities}
          onGenerateCount={mock(() => {})}
        />,
      );
      expect(queryAllByText("Generate Count Query")).toHaveLength(0);
    },
  );

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

  test('onTableClick fires with the object PATH on "Select Top 50" click', () => {
    const onTableClick = mock((path: readonly string[]) => {
      void path;
    });
    const { getByTestId } = render(
      <TableItem
        table={qualifiedTable}
        isExpanded={false}
        onToggle={mock(() => {})}
        isAdmin={false}
        onTableClick={onTableClick}
      />,
    );
    const dropdown = within(getByTestId("dropdown"));
    fireEvent.click(dropdown.getByText("Select Top 50"));
    expect(onTableClick).toHaveBeenCalledTimes(1);
    expect(onTableClick.mock.calls[0][0]).toEqual(["app", "users"]);
  });

  test('onGenerateSelect fires with the object PATH on "Generate Query" click', () => {
    const onGenerateSelect = mock((path: readonly string[]) => {
      void path;
    });
    const { getByTestId } = render(
      <TableItem
        table={qualifiedTable}
        isExpanded={false}
        onToggle={mock(() => {})}
        isAdmin={false}
        onGenerateSelect={onGenerateSelect}
      />,
    );
    const dropdown = within(getByTestId("dropdown"));
    fireEvent.click(dropdown.getByText("Generate Query"));
    expect(onGenerateSelect).toHaveBeenCalledTimes(1);
    expect(onGenerateSelect.mock.calls[0][0]).toEqual(["app", "users"]);
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

  test('onProfileTable fires with the table ADDRESS on "Profile Table" click', () => {
    const onProfileTable = mock((path: readonly string[]) => {
      void path;
    });
    const { getByTestId } = render(
      <TableItem
        table={qualifiedTable}
        isExpanded={false}
        onToggle={mock(() => {})}
        isAdmin={false}
        // Declared, because unknown capabilities offer none of the three row actions (#1085, D-M).
        capabilities={sqlCaps}
        onProfileTable={onProfileTable}
      />,
    );
    const dropdown = within(getByTestId("dropdown"));
    fireEvent.click(dropdown.getByText("Profile Table"));
    expect(onProfileTable).toHaveBeenCalledTimes(1);
    expect(onProfileTable.mock.calls[0][0]).toEqual(["app", "users"]);
  });

  test('onGenerateCode fires with the table ADDRESS on "Generate Code" click', () => {
    const onGenerateCode = mock((path: readonly string[]) => {
      void path;
    });
    const { getByTestId } = render(
      <TableItem
        table={qualifiedTable}
        isExpanded={false}
        onToggle={mock(() => {})}
        isAdmin={false}
        capabilities={sqlCaps}
        onGenerateCode={onGenerateCode}
      />,
    );
    const dropdown = within(getByTestId("dropdown"));
    fireEvent.click(dropdown.getByText("Generate Code"));
    expect(onGenerateCode).toHaveBeenCalledTimes(1);
    expect(onGenerateCode.mock.calls[0][0]).toEqual(["app", "users"]);
  });

  test('onGenerateTestData fires with the table ADDRESS on "Generate Test Data" click', () => {
    const onGenerateTestData = mock((path: readonly string[]) => {
      void path;
    });
    const { getByTestId } = render(
      <TableItem
        table={qualifiedTable}
        isExpanded={false}
        onToggle={mock(() => {})}
        isAdmin={false}
        capabilities={sqlCaps}
        onGenerateTestData={onGenerateTestData}
      />,
    );
    const dropdown = within(getByTestId("dropdown"));
    fireEvent.click(dropdown.getByText("Generate Test Data"));
    expect(onGenerateTestData).toHaveBeenCalledTimes(1);
    expect(onGenerateTestData.mock.calls[0][0]).toEqual(["app", "users"]);
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

  test('onOpenMaintenance fires with "tables" and the table ADDRESS on Analyze click', () => {
    const onOpenMaintenance = mock((tab?: "global" | "tables" | "sessions", path?: readonly string[]) => {
      void tab;
      void path;
    });
    const { getByTestId } = render(
      <TableItem
        table={qualifiedTable}
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
    expect(onOpenMaintenance.mock.calls[0][1]).toEqual(["app", "users"]);
  });

  test("onOpenMaintenance fires on Vacuum click", () => {
    const onOpenMaintenance = mock((tab?: "global" | "tables" | "sessions", path?: readonly string[]) => {
      void tab;
      void path;
    });
    const { getByTestId } = render(
      <TableItem
        table={qualifiedTable}
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
    expect(onOpenMaintenance.mock.calls[0][1]).toEqual(["app", "users"]);
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

    test("table actions button is named for the table and exposes the same tooltip", () => {
      const { getByRole } = render(
        <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />,
      );
      const actions = getByRole("button", { name: "Actions for users" });
      expect(actions.getAttribute("title")).toBe("Actions for users");
    });

    test("table actions button derives its aria-label from the table name", () => {
      const { getByRole } = render(
        <TableItem table={smallTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />,
      );
      const actions = getByRole("button", { name: "Actions for settings" });
      expect(actions.getAttribute("aria-label")).toBe("Actions for settings");
    });
  });
  // ── Derived-grouping rows and declared maintenance (#427) ─────────────────

  describe("capability gating (#427)", () => {
    test("a Redis-shaped declaration hides Profile Table (flag and language) and Generate Test Data (row-write rule)", () => {
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

    test("a Postgres-shaped table, which takes row writes, shows Profile Table and Generate Test Data", () => {
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
          table={searchIndex}
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
      // The row IS addressable here, so what the #427 gate removes for a derived grouping
      // stays: this gate is about maintenance and nothing else. Generate Test Data is withheld
      // here since D-M (#1085), by the row-write rule and not by this gate: the index kind takes
      // a bulk document write, and the engine declares no grid row edit, which is the half the
      // desktop tree has always asked. The describe below on the desktop tree's rule pins it on its own.
      expect(dropdown.queryByText("Profile Table")).not.toBeNull();
      expect(dropdown.queryByText("Generate Test Data")).toBeNull();
    });

    /*
      A THIRD surface renders the same wording (#496). This menu gated both items on
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

  /**
   * The three row actions ask exactly what the desktop tree asks (#1085, decision D-M).
   *
   * `src/components/object-tree/row-actions.ts` gates Profile on the derived-grouping flag and
   * on `offersColumnProfiling`, Generate Code on `offersCodeGeneration`, and Generate Test Data
   * on the row's kind accepting row writes AND the engine declaring the grid's row edit. This
   * menu asked only the grouping flag, so it offered the generator on every view and on every
   * engine the tree withholds it from. Each negative below is read from a menu that still
   * carries the actions that name the row, and each test carries its own control: a
   * declaration that differs in the field under test and is offered what the negative is not.
   */
  describe("the row actions ask what the desktop tree asks (#1085, D-M)", () => {
    const ROW_ACTIONS = ["Profile Table", "Generate Code", "Generate Test Data"] as const;

    /** MongoDB-shaped: a collection takes a document write, and the engine declares no grid row edit. */
    const collectionKind = {
      id: "collection",
      role: "relation",
      label: "Collection",
      labelPlural: "Collections",
      acceptsRowWrites: true,
    } as const;
    const mongoCaps = caps({ queryLanguage: "json", objectKinds: [collectionKind], supportsInlineRowEdit: false });
    const collection: DetailedObject = { ...largeTable, name: "orders", kind: "collection", path: ["shop", "orders"] };

    /** Prometheus-shaped: PromQL, a metric kind that takes no row write, no grid row edit, no maintenance. */
    const promqlCaps = caps({
      queryLanguage: "promql",
      objectKinds: [{ id: "metric", role: "relation", label: "Metric", labelPlural: "Metrics", hasColumns: true }],
      supportsInlineRowEdit: false,
      supportsMaintenance: false,
      maintenanceOperations: [],
    });
    const metricObject: DetailedObject = { name: "up", kind: "metric", path: ["up"], columns: [], indexes: [] };

    /** One non-admin row's dropdown, scoped to its own render so two renders in one test cannot collide. */
    const menuOf = (table: DetailedObject, capabilities?: Caps): HTMLElement => {
      const { container } = render(
        <TableItem
          table={table}
          isExpanded={false}
          onToggle={mock(() => {})}
          isAdmin={false}
          capabilities={capabilities}
        />,
      );
      return within(container).getByTestId("dropdown");
    };
    const offered = (menu: HTMLElement): string[] =>
      ROW_ACTIONS.filter((label) => within(menu).queryByText(label) !== null);

    test("a SQL table is offered all three", () => {
      expect(offered(menuOf(largeTable, sqlCaps))).toEqual(["Profile Table", "Generate Code", "Generate Test Data"]);
    });

    test("a view, whose kind declares no row writes, is offered everything but Generate Test Data", () => {
      expect(offered(menuOf(viewObject, sqlCaps))).toEqual(["Profile Table", "Generate Code"]);
      // The control: the same engine, and a kind that does take row writes.
      expect(offered(menuOf(largeTable, sqlCaps))).toContain("Generate Test Data");
    });

    test("a kind that takes row writes is not offered Generate Test Data on an engine with no grid row edit", () => {
      // MongoDB, Couchbase, Cassandra, ClickHouse, Druid, Trino and both search engines declare
      // `supportsInlineRowEdit: false`, and the desktop tree has always withheld the item there.
      expect(offered(menuOf(collection, mongoCaps))).toEqual(["Profile Table", "Generate Code"]);
      // The control: the same declaration with the engine half switched on.
      expect(offered(menuOf(collection, { ...mongoCaps, supportsInlineRowEdit: true }))).toEqual([
        "Profile Table",
        "Generate Code",
        "Generate Test Data",
      ]);
    });

    test("a Redis-shaped declaration keeps Generate Code and nothing else of the three", () => {
      expect(offered(menuOf(largeTable, redisCaps))).toEqual(["Generate Code"]);
      // The control: the same row on an ordinary SQL declaration is offered all three.
      expect(offered(menuOf(largeTable, sqlCaps))).toEqual(["Profile Table", "Generate Code", "Generate Test Data"]);
    });

    test("the grouping flag withholds Profile on its own, and no longer decides Generate Test Data", () => {
      // Redis and LibreDB also declare a JSON dialect, which the language gate refuses as well,
      // so this is the declaration that shows the flag still does its own work. The desktop
      // tree answers the same for it: its row-write rule has never read the flag.
      expect(offered(menuOf(largeTable, { ...sqlCaps, tablesAreDerivedGroupings: true }))).toEqual([
        "Generate Code",
        "Generate Test Data",
      ]);
      // The control: the same declaration without the flag.
      expect(offered(menuOf(largeTable, sqlCaps))).toContain("Profile Table");
    });

    test("a PromQL metric is offered none of the three, and no rule is drawn for them", () => {
      const menu = menuOf(metricObject, promqlCaps);
      expect(offered(menu)).toEqual([]);
      expect(menu.querySelectorAll("hr")).toHaveLength(0);
      // The actions that name the row are still there, so an empty list is the gate and not a
      // menu that failed to render.
      expect(within(menu).queryByText("Select Top 50")).not.toBeNull();
      expect(within(menu).queryByText("Copy Name")).not.toBeNull();
      // The control, in the one field under test: the same metric in SQL is offered the two
      // actions that ask the language, and draws the rule above them. Generate Test Data stays
      // withheld there too, because the metric kind declares no row writes.
      const sqlMenu = menuOf(metricObject, { ...promqlCaps, queryLanguage: "sql" });
      expect(offered(sqlMenu)).toEqual(["Profile Table", "Generate Code"]);
      expect(sqlMenu.querySelectorAll("hr")).toHaveLength(1);
    });

    test("unknown capabilities offer none of the three", () => {
      // `/api/db/provider-meta` answers with nothing both while it is in flight and when it
      // failed, and a menu that guessed "offer it" is how the dead buttons came back.
      const menu = menuOf(largeTable);
      expect(offered(menu)).toEqual([]);
      expect(menu.querySelectorAll("hr")).toHaveLength(0);
      expect(within(menu).queryByText("Select Top 50")).not.toBeNull();
      expect(within(menu).queryByText("Generate Query")).not.toBeNull();
      // The control: the same row once the declaration has arrived.
      expect(offered(menuOf(largeTable, sqlCaps))).toEqual(["Profile Table", "Generate Code", "Generate Test Data"]);
    });
  });
});
