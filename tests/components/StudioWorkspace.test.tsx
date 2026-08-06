import "../setup-dom";

import { mock } from "bun:test";
import { setupFramerMotionMock } from "../helpers/mock-monaco";

// Setup heavy library mocks before the component is imported
setupFramerMotionMock();

// ---- Module-level prop capture for child components ----
let capturedSidebarProps: Record<string, unknown> = {};
let capturedTabBarProps: Record<string, unknown> = {};
let capturedQueryToolbarProps: Record<string, unknown> = {};
let capturedQueryEditorProps: Record<string, unknown> = {};
let capturedBottomPanelProps: Record<string, unknown> = {};
let capturedSaveQueryModalProps: Record<string, unknown> = {};
let capturedDataImportModalProps: Record<string, unknown> = {};
let capturedSafetyDialogProps: Record<string, unknown> = {};
let capturedSchemaDiagramProps: Record<string, unknown> = {};
let capturedDataProfilerProps: Record<string, unknown> = {};
let capturedCodeGeneratorProps: Record<string, unknown> = {};
let capturedTestDataGeneratorProps: Record<string, unknown> = {};

// ---- Trackable mock functions (shared across mocks + assertions) ----

// Connection adapter
const mockSetConnections = mock(() => {});
const mockSetActiveConnection = mock(() => {});
const mockSetSchema = mock(() => {});
const mockFetchSchema = mock(() => {});
// Tab manager
const mockSetTabs = mock(() => {});
const mockUpdateCurrentTab = mock(() => {});
const mockUpdateTabById = mock(() => {});
const mockHandleTableClick = mock(() => {});
const mockHandleGenerateSelect = mock(() => {});
// Query adapter
const mockExecuteQuery = mock(() => {});
const mockForceExecuteQuery = mock(() => {});
const mockCancelQuery = mock(() => {});
const mockSetSafetyCheckQuery = mock(() => {});
const mockSetBottomPanelMode = mock(() => {});
const mockHandleUnlimitedQuery = mock(() => {});
const mockHandleLoadMore = mock(() => {});
const mockSetUnlimitedWarningOpen = mock(() => {});
// Toast
const mockToast = mock((_args?: unknown) => {});
// URL (for export tests)
const mockCreateObjectURL = mock((_blob?: unknown) => "blob:mock-url");
const mockRevokeObjectURL = mock(() => {});

// ---- Hook override objects (spread into mock returns per-test) ----
let connAdapterOverride: Record<string, unknown> = {};
let tabMgrOverride: Record<string, unknown> = {};
let queryAdapterOverride: Record<string, unknown> = {};

// ---- Shared test data used inside mock factories ----

const dbConn = {
  id: "c1",
  name: "TestPG",
  type: "postgres" as const,
  createdAt: new Date("2026-01-01"),
  managed: true,
};

const baseTab = {
  id: "tab-1",
  name: "Query 1",
  query: "SELECT 1",
  result: null,
  isExecuting: false,
  type: "sql" as const,
};

const usersTable = { name: "users", columns: [{ name: "id", type: "integer" }] };

// ---- Mock the workspace adapter hooks ----

mock.module("@/workspace/hooks/use-connection-adapter", () => ({
  useConnectionAdapter: mock(() => ({
    connections: [dbConn],
    setConnections: mockSetConnections,
    activeConnection: dbConn,
    setActiveConnection: mockSetActiveConnection,
    schema: [usersTable],
    setSchema: mockSetSchema,
    isLoadingSchema: false,
    connectionPulse: null,
    fetchSchema: mockFetchSchema,
    tableNames: ["users"],
    schemaContext: JSON.stringify([usersTable]),
    ...connAdapterOverride,
  })),
}));

mock.module("@/workspace/hooks/use-query-adapter", () => ({
  useQueryAdapter: mock(() => ({
    executeQuery: mockExecuteQuery,
    forceExecuteQuery: mockForceExecuteQuery,
    cancelQuery: mockCancelQuery,
    handleLoadMore: mockHandleLoadMore,
    handleUnlimitedQuery: mockHandleUnlimitedQuery,
    safetyCheckQuery: null,
    setSafetyCheckQuery: mockSetSafetyCheckQuery,
    unlimitedWarningOpen: false,
    setUnlimitedWarningOpen: mockSetUnlimitedWarningOpen,
    pendingUnlimitedQuery: null,
    setPendingUnlimitedQuery: mock(() => {}),
    historyKey: 0,
    bottomPanelMode: "results",
    setBottomPanelMode: mockSetBottomPanelMode,
    ...queryAdapterOverride,
  })),
}));

// ---- Mock shared studio hooks ----

mock.module("@/hooks/use-tab-manager", () => ({
  useTabManager: mock(() => ({
    tabs: [baseTab],
    activeTabId: "tab-1",
    currentTab: baseTab,
    setTabs: mockSetTabs,
    setActiveTabId: mock(() => {}),
    editingTabId: null,
    editingTabName: "",
    setEditingTabId: mock(() => {}),
    setEditingTabName: mock(() => {}),
    addTab: mock(() => {}),
    closeTab: mock(() => {}),
    updateCurrentTab: mockUpdateCurrentTab,
    updateTabById: mockUpdateTabById,
    handleTableClick: mockHandleTableClick,
    handleGenerateSelect: mockHandleGenerateSelect,
    ...tabMgrOverride,
  })),
}));

mock.module("@/hooks/use-toast", () => ({
  useToast: mock(() => ({
    toast: mockToast,
  })),
}));

// ---- Mock child components ----

mock.module("@/components/sidebar", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    Sidebar: (props: Record<string, unknown>) => {
      capturedSidebarProps = props;
      return React.createElement("div", { "data-testid": "sidebar" }, "Sidebar");
    },
    ConnectionsList: () => React.createElement("div", { "data-testid": "connections-list" }, "ConnectionsList"),
  };
});

mock.module("@/components/QueryEditor", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  const QueryEditor = React.forwardRef((props: Record<string, unknown>, ref: unknown) => {
    capturedQueryEditorProps = props;
    return React.createElement("div", { "data-testid": "query-editor", ref }, "QueryEditor");
  });
  QueryEditor.displayName = "QueryEditor";
  return { QueryEditor, QueryEditorRef: {} };
});

// Mock the studio sub-components barrel (same rationale as Studio.test.tsx:
// StudioWorkspace imports from '@/components/studio/index').
mock.module("@/components/studio/index", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    StudioMobileHeader: () => null,
    StudioDesktopHeader: () => null,
    StudioTabBar: (props: Record<string, unknown>) => {
      capturedTabBarProps = props;
      return React.createElement("div", { "data-testid": "tab-bar" }, "TabBar");
    },
    QueryToolbar: (props: Record<string, unknown>) => {
      capturedQueryToolbarProps = props;
      return React.createElement("div", { "data-testid": "query-toolbar" }, "QueryToolbar");
    },
    BottomPanel: (props: Record<string, unknown>) => {
      capturedBottomPanelProps = props;
      return React.createElement("div", { "data-testid": "bottom-panel" }, "BottomPanel");
    },
    BottomPanelMode: {},
  };
});

mock.module("@/components/SchemaDiagram", () => ({
  SchemaDiagram: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    capturedSchemaDiagramProps = props;
    return React.createElement("div", { "data-testid": "schemadiagram" }, "SchemaDiagram");
  },
}));

mock.module("@/components/SaveQueryModal", () => ({
  SaveQueryModal: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    capturedSaveQueryModalProps = props;
    return props.isOpen ? React.createElement("div", { "data-testid": "savequerymodal" }, "SaveQueryModal") : null;
  },
}));

mock.module("@/components/DataImportModal", () => ({
  DataImportModal: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    capturedDataImportModalProps = props;
    return props.isOpen ? React.createElement("div", { "data-testid": "dataimportmodal" }, "DataImportModal") : null;
  },
}));

mock.module("@/components/QuerySafetyDialog", () => ({
  QuerySafetyDialog: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    capturedSafetyDialogProps = props;
    return props.isOpen
      ? React.createElement("div", { "data-testid": "querysafetydialog" }, "QuerySafetyDialog")
      : null;
  },
  isDangerousQuery: mock(() => false),
}));

mock.module("@/components/DataProfiler", () => ({
  DataProfiler: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    capturedDataProfilerProps = props;
    return props.isOpen ? React.createElement("div", { "data-testid": "dataprofiler" }, "DataProfiler") : null;
  },
}));

mock.module("@/components/CodeGenerator", () => ({
  CodeGenerator: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    capturedCodeGeneratorProps = props;
    return props.isOpen ? React.createElement("div", { "data-testid": "codegenerator" }, "CodeGenerator") : null;
  },
}));

mock.module("@/components/TestDataGenerator", () => ({
  TestDataGenerator: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    capturedTestDataGeneratorProps = props;
    return props.isOpen
      ? React.createElement("div", { "data-testid": "testdatagenerator" }, "TestDataGenerator")
      : null;
  },
}));

mock.module("@/components/ui/resizable", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    ResizablePanelGroup: ({ children }: Record<string, unknown>) =>
      React.createElement("div", { "data-testid": "resizable-group" }, children),
    ResizablePanel: ({ children }: Record<string, unknown>) =>
      React.createElement("div", { "data-testid": "resizable-panel" }, children),
    ResizableHandle: () => React.createElement("div", { "data-testid": "resizable-handle" }),
  };
});

// ---- Now import bun:test, testing-library, and the component ----
// StudioWorkspace is loaded via dynamic import AFTER all mock.module calls so
// that no real heavy child module evaluates in this process.

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { render, cleanup, act } from "@testing-library/react";
import React from "react";
import type { SavedQueryInput, StudioWorkspaceProps } from "@/workspace/types";

const { StudioWorkspace } = await import("@/workspace/StudioWorkspace");

// =============================================================================
// Test data + helpers
// =============================================================================

const workspaceConnections = [{ id: "c1", name: "TestPG", type: "postgres" as const }];

const exportResult = {
  rows: [
    { id: 1, name: "Alice", ratio: 0.5, active: true, created: new Date("2026-01-01"), deleted: null },
    { id: 2, name: "Bob's", ratio: 2, active: false, created: new Date("2026-01-02"), deleted: "yes" },
  ],
  fields: ["id", "name", "ratio", "active", "created", "deleted"],
  rowCount: 2,
  executionTime: 5,
};

const mockOnQueryExecute = mock(async () => ({ rows: [], fields: [], rowCount: 0, executionTime: 1 }));
const mockOnSchemaFetch = mock(async () => []);
const mockOnSaveQuery = mock(async (_query: SavedQueryInput) => {});

function renderWorkspace(props: Partial<StudioWorkspaceProps> = {}) {
  return render(
    <StudioWorkspace
      connections={workspaceConnections}
      onQueryExecute={mockOnQueryExecute}
      onSchemaFetch={mockOnSchemaFetch}
      onSaveQuery={mockOnSaveQuery}
      {...props}
    />,
  );
}

const ALL_FEATURES_OFF = {
  ai: false,
  charts: false,
  codeGenerator: false,
  testDataGenerator: false,
  schemaDiagram: false,
  dataImport: false,
  inlineEditing: false,
  transactions: false,
  connectionManagement: false,
  dataMasking: false,
};

// =============================================================================
// StudioWorkspace Tests
// =============================================================================

describe("StudioWorkspace", () => {
  beforeEach(() => {
    // Reset prop captures
    capturedSidebarProps = {};
    capturedTabBarProps = {};
    capturedQueryToolbarProps = {};
    capturedQueryEditorProps = {};
    capturedBottomPanelProps = {};
    capturedSaveQueryModalProps = {};
    capturedDataImportModalProps = {};
    capturedSafetyDialogProps = {};
    capturedSchemaDiagramProps = {};
    capturedDataProfilerProps = {};
    capturedCodeGeneratorProps = {};
    capturedTestDataGeneratorProps = {};

    // Reset overrides
    connAdapterOverride = {};
    tabMgrOverride = {};
    queryAdapterOverride = {};

    // Clear trackable mocks
    mockSetConnections.mockClear();
    mockSetActiveConnection.mockClear();
    mockSetSchema.mockClear();
    mockFetchSchema.mockClear();
    mockSetTabs.mockClear();
    mockUpdateCurrentTab.mockClear();
    mockUpdateTabById.mockClear();
    mockHandleTableClick.mockClear();
    mockHandleGenerateSelect.mockClear();
    mockExecuteQuery.mockClear();
    mockForceExecuteQuery.mockClear();
    mockCancelQuery.mockClear();
    mockSetSafetyCheckQuery.mockClear();
    mockSetBottomPanelMode.mockClear();
    mockHandleUnlimitedQuery.mockClear();
    mockHandleLoadMore.mockClear();
    mockSetUnlimitedWarningOpen.mockClear();
    mockToast.mockClear();
    mockCreateObjectURL.mockClear();
    mockRevokeObjectURL.mockClear();
    mockOnQueryExecute.mockClear();
    mockOnSchemaFetch.mockClear();
    mockOnSaveQuery.mockClear();

    // URL mocks (may not exist in happy-dom)
    globalThis.URL.createObjectURL = mockCreateObjectURL as unknown as typeof URL.createObjectURL;
    globalThis.URL.revokeObjectURL = mockRevokeObjectURL as unknown as typeof URL.revokeObjectURL;
  });

  afterEach(() => {
    cleanup();
  });

  // =========================================================================
  // Rendering
  // =========================================================================

  test("renders shell with sidebar, tab bar, toolbar, editor and bottom panel", () => {
    const { getByTestId, queryByTestId } = renderWorkspace();
    expect(getByTestId("sidebar").textContent).toBe("Sidebar");
    expect(getByTestId("tab-bar").textContent).toBe("TabBar");
    expect(capturedTabBarProps.activeTabId).toBe("tab-1");
    expect(getByTestId("query-toolbar").textContent).toBe("QueryToolbar");
    expect(getByTestId("query-editor").textContent).toBe("QueryEditor");
    expect(getByTestId("bottom-panel").textContent).toBe("BottomPanel");
    // Overlays and modals hidden by default
    expect(queryByTestId("schemadiagram")).toBeNull();
    expect(queryByTestId("savequerymodal")).toBeNull();
    expect(queryByTestId("dataimportmodal")).toBeNull();
    expect(queryByTestId("querysafetydialog")).toBeNull();
    expect(queryByTestId("dataprofiler")).toBeNull();
    expect(queryByTestId("codegenerator")).toBeNull();
    expect(queryByTestId("testdatagenerator")).toBeNull();
  });

  test("applies data-studio-workspace attribute and custom className", () => {
    const { container } = renderWorkspace({ className: "my-custom-class" });
    const root = container.querySelector("[data-studio-workspace]");
    expect(root).not.toBeNull();
    expect(root?.className).toContain("my-custom-class");
  });

  test("multiple rerenders do not crash", () => {
    const { container, rerender } = renderWorkspace();
    rerender(
      <StudioWorkspace
        connections={workspaceConnections}
        onQueryExecute={mockOnQueryExecute}
        onSchemaFetch={mockOnSchemaFetch}
      />,
    );
    rerender(
      <StudioWorkspace connections={[]} onQueryExecute={mockOnQueryExecute} onSchemaFetch={mockOnSchemaFetch} />,
    );
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  // =========================================================================
  // Scoped theme injection (useStudioTheme)
  // =========================================================================

  test("injects scoped theme style on mount and removes it on unmount", () => {
    expect(document.getElementById("studio-workspace-theme")).toBeNull();
    const { unmount } = renderWorkspace();
    const style = document.getElementById("studio-workspace-theme");
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain("[data-studio-workspace]");
    expect(style?.textContent).toContain("--background: #09090b");
    unmount();
    expect(document.getElementById("studio-workspace-theme")).toBeNull();
  });

  test("does not duplicate theme style when one already exists", () => {
    const existing = document.createElement("style");
    existing.id = "studio-workspace-theme";
    document.head.appendChild(existing);
    const { unmount } = renderWorkspace();
    expect(document.querySelectorAll("#studio-workspace-theme").length).toBe(1);
    unmount();
    // Effect early-returned, so no cleanup was registered and the pre-existing style survives
    expect(document.getElementById("studio-workspace-theme")).not.toBeNull();
    existing.remove();
  });

  // =========================================================================
  // Connection-change effect
  // =========================================================================

  test("fetches schema when an active connection exists", () => {
    renderWorkspace();
    expect(mockFetchSchema).toHaveBeenCalledWith(dbConn);
    expect(mockSetSchema).not.toHaveBeenCalled();
  });

  test("clears schema when there is no active connection", () => {
    connAdapterOverride = { activeConnection: null, connections: [], schema: [], tableNames: [], schemaContext: "[]" };
    renderWorkspace({ connections: [] });
    expect(mockFetchSchema).not.toHaveBeenCalled();
    expect(mockSetSchema).toHaveBeenCalledWith([]);
  });

  // =========================================================================
  // handleSaveQuery
  // =========================================================================

  test("handleSaveQuery delegates to onSaveQuery and shows success toast", async () => {
    renderWorkspace();
    const onSave = capturedSaveQueryModalProps.onSave as (n: string, d: string, t: string[]) => Promise<void>;
    await act(async () => {
      await onSave("My Query", "A test query", ["tag1"]);
    });
    expect(mockOnSaveQuery).toHaveBeenCalledTimes(1);
    const saved = mockOnSaveQuery.mock.calls[0][0];
    expect(saved.name).toBe("My Query");
    expect(saved.query).toBe("SELECT 1");
    expect(saved.description).toBe("A test query");
    expect(saved.connectionType).toBe("postgres");
    expect(saved.tags).toEqual(["tag1"]);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Query Saved" }));
  });

  test("handleSaveQuery shows destructive toast when onSaveQuery rejects", async () => {
    mockOnSaveQuery.mockImplementationOnce(() => Promise.reject(new Error("save exploded")));
    renderWorkspace();
    const onSave = capturedSaveQueryModalProps.onSave as (n: string, d: string, t: string[]) => Promise<void>;
    await act(async () => {
      await onSave("Broken", "", []);
    });
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Save Failed",
        description: "save exploded",
        variant: "destructive",
      }),
    );
  });

  test("handleSaveQuery returns early without an active connection", async () => {
    connAdapterOverride = { activeConnection: null };
    renderWorkspace();
    const onSave = capturedSaveQueryModalProps.onSave as (n: string, d: string, t: string[]) => Promise<void>;
    await act(async () => {
      await onSave("Noop", "", []);
    });
    expect(mockOnSaveQuery).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
  });

  test("SaveQueryModal opens via toolbar and closes via onClose", () => {
    const { queryByTestId } = renderWorkspace();
    expect(queryByTestId("savequerymodal")).toBeNull();
    act(() => (capturedQueryToolbarProps.onSaveQuery as () => void)());
    expect(queryByTestId("savequerymodal")).not.toBeNull();
    act(() => (capturedSaveQueryModalProps.onClose as () => void)());
    expect(queryByTestId("savequerymodal")).toBeNull();
  });

  test("without onSaveQuery prop the modal never renders and toolbar save is a noop", () => {
    const { queryByTestId } = renderWorkspace({ onSaveQuery: undefined });
    act(() => (capturedQueryToolbarProps.onSaveQuery as () => void)());
    expect(queryByTestId("savequerymodal")).toBeNull();
  });

  // =========================================================================
  // exportResults
  // =========================================================================

  function withExportResult() {
    tabMgrOverride = {
      currentTab: { ...baseTab, name: "Query: users", result: exportResult },
      tabs: [{ ...baseTab, name: "Query: users", result: exportResult }],
    };
  }

  test("exportResults csv creates a text/csv blob", async () => {
    withExportResult();
    renderWorkspace();
    act(() => (capturedBottomPanelProps.onExportResults as (f: string) => void)("csv"));
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
    expect(mockRevokeObjectURL).toHaveBeenCalledTimes(1);
    const blob = mockCreateObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/csv");
    const text = await blob.text();
    expect(text).toContain("id,name,ratio,active,created,deleted");
    expect(text).toContain('"Alice"');
  });

  test("exportResults json creates an application/json blob", async () => {
    withExportResult();
    renderWorkspace();
    act(() => (capturedBottomPanelProps.onExportResults as (f: string) => void)("json"));
    const blob = mockCreateObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toContain("application/json");
    const text = await blob.text();
    expect(text).toContain('"name": "Alice"');
  });

  test("exportResults sql-insert escapes values and emits NULL", async () => {
    withExportResult();
    renderWorkspace();
    act(() => (capturedBottomPanelProps.onExportResults as (f: string) => void)("sql-insert"));
    const blob = mockCreateObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/sql");
    const text = await blob.text();
    expect(text).toContain("INSERT INTO users");
    expect(text).toContain("NULL");
    expect(text).toContain("'Bob''s'");
    expect(text).toContain("true");
  });

  // Same file, same hazard as the standalone export: the values are data the table
  // held, and the file is run later, usually unattended. On a dialect that escapes
  // with a backslash, a value ending in one would close its literal and have the
  // rest of the file read as statements (#290).
  test("exportResults sql-insert quotes a value for the connected dialect", async () => {
    connAdapterOverride = { activeConnection: { ...dbConn, type: "mysql" as const } };
    tabMgrOverride = {
      currentTab: {
        ...baseTab,
        name: "Query: users",
        result: {
          rows: [{ id: 1, path: "C:\\Users\\'); DROP TABLE users; --" }],
          fields: ["id", "path"],
          rowCount: 1,
          executionTime: 1,
        },
      },
    };
    renderWorkspace();
    act(() => (capturedBottomPanelProps.onExportResults as (f: string) => void)("sql-insert"));

    const blob = mockCreateObjectURL.mock.calls[0][0] as Blob;
    expect(await blob.text()).toBe(
      "INSERT INTO users (id, path) VALUES (1, 'C:\\\\Users\\\\''); DROP TABLE users; --');",
    );
  });

  test("exportResults sql-ddl infers column types from the first row", async () => {
    withExportResult();
    renderWorkspace();
    act(() => (capturedBottomPanelProps.onExportResults as (f: string) => void)("sql-ddl"));
    const blob = mockCreateObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/sql");
    const text = await blob.text();
    expect(text).toContain("CREATE TABLE users");
    expect(text).toContain("id INTEGER");
    expect(text).toContain("ratio NUMERIC");
    expect(text).toContain("active BOOLEAN");
    expect(text).toContain("created TIMESTAMP");
    expect(text).toContain("name TEXT");
  });

  test("exportResults does nothing without a result", () => {
    renderWorkspace();
    act(() => (capturedBottomPanelProps.onExportResults as (f: string) => void)("csv"));
    expect(mockCreateObjectURL).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Sidebar callbacks
  // =========================================================================

  test("onTableClick delegates to handleTableClick with executeQuery", () => {
    renderWorkspace();
    act(() => (capturedSidebarProps.onTableClick as (n: string) => void)("users"));
    expect(mockHandleTableClick).toHaveBeenCalledWith("users", mockExecuteQuery);
  });

  test("sidebar noop callbacks and references are wired", () => {
    renderWorkspace();
    expect(capturedSidebarProps.onSelectConnection).toBe(mockSetActiveConnection);
    expect(capturedSidebarProps.onGenerateSelect).toBe(mockHandleGenerateSelect);
    expect(capturedSidebarProps.isAdmin).toBe(false);
    // noop callbacks do not throw
    act(() => (capturedSidebarProps.onDeleteConnection as () => void)());
    act(() => (capturedSidebarProps.onEditConnection as () => void)());
    act(() => (capturedSidebarProps.onAddConnection as () => void)());
    act(() => (capturedSidebarProps.onOpenMaintenance as () => void)());
  });

  test("onShowDiagram opens the schema diagram and onClose closes it", () => {
    const { queryByTestId } = renderWorkspace();
    expect(queryByTestId("schemadiagram")).toBeNull();
    act(() => (capturedSidebarProps.onShowDiagram as () => void)());
    expect(queryByTestId("schemadiagram")).not.toBeNull();
    act(() => (capturedSchemaDiagramProps.onClose as () => void)());
    expect(queryByTestId("schemadiagram")).toBeNull();
  });

  test("onProfileTable opens the data profiler with the matching schema", () => {
    const { queryByTestId } = renderWorkspace();
    act(() => (capturedSidebarProps.onProfileTable as (n: string) => void)("users"));
    expect(queryByTestId("dataprofiler")).not.toBeNull();
    expect(capturedDataProfilerProps.tableName).toBe("users");
    expect(capturedDataProfilerProps.tableSchema).toEqual(usersTable);
    act(() => (capturedDataProfilerProps.onClose as () => void)());
    expect(queryByTestId("dataprofiler")).toBeNull();
  });

  test("onGenerateCode opens the code generator", () => {
    const { queryByTestId } = renderWorkspace();
    act(() => (capturedSidebarProps.onGenerateCode as (n: string) => void)("users"));
    expect(queryByTestId("codegenerator")).not.toBeNull();
    act(() => (capturedCodeGeneratorProps.onClose as () => void)());
    expect(queryByTestId("codegenerator")).toBeNull();
  });

  test("onGenerateTestData opens the test data generator which can execute queries", () => {
    const { queryByTestId } = renderWorkspace();
    act(() => (capturedSidebarProps.onGenerateTestData as (n: string) => void)("users"));
    expect(queryByTestId("testdatagenerator")).not.toBeNull();
    act(() => (capturedTestDataGeneratorProps.onExecuteQuery as (q: string) => void)("INSERT INTO users VALUES (1)"));
    expect(mockExecuteQuery).toHaveBeenCalledWith("INSERT INTO users VALUES (1)");
    act(() => (capturedTestDataGeneratorProps.onClose as () => void)());
    expect(queryByTestId("testdatagenerator")).toBeNull();
  });

  // =========================================================================
  // Feature flags
  // =========================================================================

  test("disabled features remove optional callbacks and modals", () => {
    const { queryByTestId } = renderWorkspace({ features: ALL_FEATURES_OFF, onSaveQuery: undefined });
    expect(capturedSidebarProps.onShowDiagram).toBeUndefined();
    expect(capturedSidebarProps.onProfileTable).toBeUndefined();
    expect(capturedSidebarProps.onGenerateCode).toBeUndefined();
    expect(capturedSidebarProps.onGenerateTestData).toBeUndefined();
    expect(capturedBottomPanelProps.isNL2SQLOpen).toBe(false);
    // Import and save become noops
    act(() => (capturedQueryToolbarProps.onImport as () => void)());
    expect(queryByTestId("dataimportmodal")).toBeNull();
    act(() => (capturedQueryToolbarProps.onSaveQuery as () => void)());
    expect(queryByTestId("savequerymodal")).toBeNull();
    // NL2SQL setter is a noop
    act(() => (capturedBottomPanelProps.onSetIsNL2SQLOpen as (v: boolean) => void)(true));
    expect(capturedBottomPanelProps.isNL2SQLOpen).toBe(false);
  });

  test("features.ai enables the NL2SQL open state round-trip", () => {
    renderWorkspace({ features: { ai: true } });
    expect(capturedBottomPanelProps.isNL2SQLOpen).toBe(false);
    act(() => (capturedBottomPanelProps.onSetIsNL2SQLOpen as (v: boolean) => void)(true));
    expect(capturedBottomPanelProps.isNL2SQLOpen).toBe(true);
  });

  // =========================================================================
  // QueryToolbar callbacks
  // =========================================================================

  test("toolbar onExecuteQuery triggers executeQuery", () => {
    renderWorkspace();
    act(() => (capturedQueryToolbarProps.onExecuteQuery as () => void)());
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
    expect(capturedQueryToolbarProps.onCancelQuery).toBe(mockCancelQuery);
    // Transaction and playground callbacks are noops in embedded mode
    act(() => (capturedQueryToolbarProps.onBeginTransaction as () => void)());
    act(() => (capturedQueryToolbarProps.onCommitTransaction as () => void)());
    act(() => (capturedQueryToolbarProps.onRollbackTransaction as () => void)());
    act(() => (capturedQueryToolbarProps.onTogglePlayground as () => void)());
    act(() => (capturedQueryToolbarProps.onToggleEditing as () => void)());
  });

  test("toolbar onImport opens the import modal which delegates and closes", () => {
    const { queryByTestId } = renderWorkspace();
    expect(queryByTestId("dataimportmodal")).toBeNull();
    act(() => (capturedQueryToolbarProps.onImport as () => void)());
    expect(queryByTestId("dataimportmodal")).not.toBeNull();
    act(() => (capturedDataImportModalProps.onImport as (sql: string) => void)("INSERT INTO t VALUES (1)"));
    expect(mockExecuteQuery).toHaveBeenCalledWith("INSERT INTO t VALUES (1)");
    act(() => (capturedDataImportModalProps.onClose as () => void)());
    expect(queryByTestId("dataimportmodal")).toBeNull();
  });

  // =========================================================================
  // QueryEditor
  // =========================================================================

  test("onContentChange updates the current tab by id", () => {
    renderWorkspace();
    act(() => (capturedQueryEditorProps.onContentChange as (v: string) => void)("SELECT 2"));
    expect(mockUpdateTabById).toHaveBeenCalledWith("tab-1", { query: "SELECT 2" });
  });

  test("editor language defaults to sql", () => {
    renderWorkspace();
    expect(capturedQueryEditorProps.language).toBe("sql");
    expect(capturedQueryEditorProps.tables).toEqual(["users"]);
  });

  test("editor language is libredb for libredb tabs", () => {
    tabMgrOverride = { currentTab: { ...baseTab, type: "libredb" } };
    renderWorkspace();
    expect(capturedQueryEditorProps.language).toBe("libredb");
  });

  test("editor language is json for mongodb tabs", () => {
    tabMgrOverride = { currentTab: { ...baseTab, type: "mongodb" } };
    renderWorkspace();
    expect(capturedQueryEditorProps.language).toBe("json");
  });

  // =========================================================================
  // BottomPanel callbacks
  // =========================================================================

  test("bottom panel onExecuteQuery and onLoadQuery delegate", () => {
    renderWorkspace();
    act(() => (capturedBottomPanelProps.onExecuteQuery as (q: string) => void)("SELECT 5"));
    expect(mockExecuteQuery).toHaveBeenCalledWith("SELECT 5");
    act(() => (capturedBottomPanelProps.onLoadQuery as (q: string) => void)("SELECT 6"));
    expect(mockUpdateCurrentTab).toHaveBeenCalledWith({ query: "SELECT 6" });
    expect(capturedBottomPanelProps.onSetMode).toBe(mockSetBottomPanelMode);
    // No-op editing callbacks do not throw
    act(() => (capturedBottomPanelProps.onCellChange as () => void)());
    act(() => (capturedBottomPanelProps.onApplyChanges as () => void)());
    act(() => (capturedBottomPanelProps.onDiscardChanges as () => void)());
  });

  test("onLoadMore is undefined without pagination and wired when hasMore", () => {
    renderWorkspace();
    expect(capturedBottomPanelProps.onLoadMore).toBeUndefined();
    cleanup();
    tabMgrOverride = {
      currentTab: {
        ...baseTab,
        result: {
          ...exportResult,
          pagination: { limit: 500, offset: 0, hasMore: true, totalReturned: 2, wasLimited: true },
        },
      },
    };
    renderWorkspace();
    expect(capturedBottomPanelProps.onLoadMore).toBe(mockHandleLoadMore);
  });

  test("passes the current user role to the bottom panel", () => {
    renderWorkspace({ currentUser: { id: "u1", name: "Admin", role: "admin" } });
    expect(capturedBottomPanelProps.userRole).toBe("admin");
    expect(capturedBottomPanelProps.maskingEnabled).toBe(false);
  });

  // =========================================================================
  // QuerySafetyDialog
  // =========================================================================

  test("safety dialog renders when a query is under review and proceeds", () => {
    queryAdapterOverride = { safetyCheckQuery: "DROP TABLE users" };
    const { queryByTestId } = renderWorkspace();
    expect(queryByTestId("querysafetydialog")).not.toBeNull();
    expect(capturedSafetyDialogProps.query).toBe("DROP TABLE users");
    act(() => (capturedSafetyDialogProps.onProceed as () => void)());
    expect(mockForceExecuteQuery).toHaveBeenCalledWith("DROP TABLE users");
    act(() => (capturedSafetyDialogProps.onClose as () => void)());
    expect(mockSetSafetyCheckQuery).toHaveBeenCalledWith(null);
  });

  test("safety dialog onProceed is a no-op without a pending query", () => {
    renderWorkspace();
    expect(capturedSafetyDialogProps.query).toBe("");
    act(() => (capturedSafetyDialogProps.onProceed as () => void)());
    expect(mockForceExecuteQuery).not.toHaveBeenCalled();
  });

  test("onAnalyzeSafety returns the embedded high-risk stub", async () => {
    renderWorkspace();
    const analyze = capturedSafetyDialogProps.onAnalyzeSafety as () => Promise<{
      riskLevel: string;
      warnings: { type: string }[];
      recommendation: string;
    }>;
    const result = await analyze();
    expect(result.riskLevel).toBe("high");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].type).toBe("destructive");
    expect(result.recommendation).toContain("Review this query");
  });

  // =========================================================================
  // Unlimited query warning dialog
  // =========================================================================

  test("unlimited warning dialog renders when open", () => {
    queryAdapterOverride = { unlimitedWarningOpen: true };
    const { baseElement } = renderWorkspace();
    expect(baseElement.textContent).toContain("Load all results?");
    expect(baseElement.textContent).toContain("Load All");
  });
});
