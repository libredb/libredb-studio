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
// The arguments StudioWorkspace hands the shared tab manager. `metadata` used to
// be hardcoded `null` here, which made the whole of #427 inert in this surface.
let capturedTabManagerArgs: Record<string, unknown> = {};

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
    schemaContext: JSON.stringify([usersTable]),
    metadata: null,
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
  useTabManager: mock((args: Record<string, unknown>) => {
    capturedTabManagerArgs = args;
    return {
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
    };
  }),
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
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import { generateTableQuery } from "@/lib/query-generators";

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
  const originalMatchMedia = window.matchMedia;

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
    capturedTabManagerArgs = {};

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
    window.matchMedia = originalMatchMedia;
  });

  /**
   * The breakpoint is driven through `window.matchMedia`, as in Studio.test.tsx: a
   * module mock of `@/hooks/use-mobile` would be process-wide.
   */
  function setViewportMobile(matches: boolean) {
    window.matchMedia = ((query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  }

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
    connAdapterOverride = { activeConnection: null, connections: [], schema: [], schemaContext: "[]" };
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

  test("without onSaveQuery prop the toolbar gets no save handler at all", () => {
    // Withheld, not `noop`: QueryToolbar renders no Save control without it, so
    // an unwired host gets no dead button (U7).
    const { queryByTestId } = renderWorkspace({ onSaveQuery: undefined });
    expect(capturedQueryToolbarProps.onSaveQuery).toBeUndefined();
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
    const blob = mockCreateObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/csv;charset=utf-8");
    const text = await blob.text();
    expect(text).toContain("id,name,ratio,active,created,deleted");
    // A value is quoted only where RFC 4180 requires it, and NULL is an empty
    // field rather than the four letters of the word.
    expect(text).toContain("1,Alice,0.5,true,");
    expect(text.split("\n")[1].endsWith(",")).toBe(true);
  });

  // The blob URL outlives the task that started the download: revoking it in the
  // same task can pull the data out from under a read that has not begun.
  test("exportResults does not revoke the blob URL before the download is handed off", async () => {
    withExportResult();
    renderWorkspace();
    act(() => (capturedBottomPanelProps.onExportResults as (f: string) => void)("csv"));

    expect(mockRevokeObjectURL).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockRevokeObjectURL).toHaveBeenCalled();
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
    // The column names are quoted the way the connected dialect spells an
    // identifier, so an aliased column cannot end the list it sits in either.
    expect(await blob.text()).toBe(
      "INSERT INTO users (`id`, `path`) VALUES (1, 'C:\\\\Users\\\\''); DROP TABLE users; --');",
    );
  });

  test("exportResults sql-ddl infers column types from the first row that carries a value", async () => {
    withExportResult();
    renderWorkspace();
    act(() => (capturedBottomPanelProps.onExportResults as (f: string) => void)("sql-ddl"));
    const blob = mockCreateObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/sql");
    const text = await blob.text();
    expect(text).toContain("CREATE TABLE users");
    expect(text).toContain('"id" BIGINT');
    // A JS non-integer is a double, and `NUMERIC` without a scale truncates it on
    // MySQL and SQL Server — so the inferred type is spelled per dialect now.
    expect(text).toContain('"ratio" DOUBLE PRECISION');
    expect(text).toContain('"active" BOOLEAN');
    expect(text).toContain('"created" TIMESTAMP');
    expect(text).toContain('"name" TEXT');
    // `deleted` is null in row 1 and a string in row 2: the type comes from the
    // row that actually carries a value, not from row 0.
    expect(text).toContain('"deleted" TEXT');
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

  // Awaited because the diagram is code-split: opening it resolves a dynamic import
  // before the component can mount.
  test("onShowDiagram opens the schema diagram and onClose closes it", async () => {
    const { queryByTestId } = renderWorkspace();
    expect(queryByTestId("schemadiagram")).toBeNull();
    await act(async () => (capturedSidebarProps.onShowDiagram as () => void)());
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
    // Import and save are withheld entirely, so the toolbar renders neither the
    // IMPORT (#427) nor the Save (U7) button.
    expect(capturedQueryToolbarProps.onImport).toBeUndefined();
    expect(capturedQueryToolbarProps.onSaveQuery).toBeUndefined();
    expect(queryByTestId("dataimportmodal")).toBeNull();
    expect(queryByTestId("savequerymodal")).toBeNull();
  });

  // =========================================================================
  // The agent boundary (#329 T12)
  // =========================================================================

  /**
   * Phase 1's agent runtime is standalone-only, so the embedded shell has no
   * surface to gate: there is no agent capability flag, which is why "with any
   * feature combination" is exhaustive here rather than a sample. Every flag on
   * and every flag off are both rendered anyway, because the claim being pinned
   * is about the shell, not about the flags it happens to read today.
   */
  const ALL_FEATURES_ON: typeof ALL_FEATURES_OFF = Object.fromEntries(
    Object.keys(ALL_FEATURES_OFF).map((name) => [name, true]),
  ) as typeof ALL_FEATURES_OFF;

  test("no feature combination gives the embedded shell an agent surface", () => {
    // The server is made to answer "the agent runtime is on" for anything asked,
    // so a passing test means the embedded shell asked nothing rather than that
    // it asked and was refused.
    const requested: string[] = [];
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      requested.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      return new Response(JSON.stringify({ enabled: true }), { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      for (const features of [undefined, ALL_FEATURES_OFF, ALL_FEATURES_ON]) {
        capturedBottomPanelProps = {};
        const { baseElement, unmount } = renderWorkspace(features === undefined ? {} : { features });

        // Prefix-matched, not a list of today's ids: a surface added later would
        // otherwise satisfy this test by being named something new.
        expect(baseElement.querySelectorAll('[data-testid^="agent"]')).toHaveLength(0);
        // The bottom panel is where a standalone run's artifact is hydrated
        // (#329 T11). The embedded shell never hands it one, so the panel's
        // provenance branch is unreachable there. The panel is a module mock in
        // this file, so the capture is cleared and then proved fresh — otherwise
        // a combination that stopped rendering it at all would satisfy the
        // `agentArtifact` assertion with nothing captured.
        expect(capturedBottomPanelProps.onSetMode).toBeDefined();
        expect(capturedBottomPanelProps.agentArtifact).toBeUndefined();

        unmount();
      }

      expect(requested.filter((url) => url.includes("/api/agent"))).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // =========================================================================
  // QueryToolbar callbacks
  // =========================================================================

  test("toolbar onExecuteQuery triggers executeQuery", () => {
    renderWorkspace();
    act(() => (capturedQueryToolbarProps.onExecuteQuery as () => void)());
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
    expect(capturedQueryToolbarProps.onCancelQuery).toBe(mockCancelQuery);
    // Transaction, playground and editing are withheld, not noops, in embedded
    // mode — see "withholds every control the embedded shell cannot serve" (#427).
    expect(capturedQueryToolbarProps.onBeginTransaction).toBeUndefined();
    expect(capturedQueryToolbarProps.onCommitTransaction).toBeUndefined();
    expect(capturedQueryToolbarProps.onRollbackTransaction).toBeUndefined();
    expect(capturedQueryToolbarProps.onTogglePlayground).toBeUndefined();
    expect(capturedQueryToolbarProps.onToggleEditing).toBeUndefined();
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

  test("editor language is redis for redis tabs (#427)", () => {
    tabMgrOverride = { currentTab: { ...baseTab, type: "redis" } };
    renderWorkspace();
    expect(capturedQueryEditorProps.language).toBe("redis");
  });

  // =========================================================================
  // Provider metadata wiring (#427)
  // =========================================================================
  //
  // This shell hardcoded `metadata: null` into the tab manager and `metadata={null}`
  // into every child that reads it, so a Redis connection here still generated
  // `SELECT * FROM user:* LIMIT 50;` and still offered per-row actions the provider
  // answers 400 to — the whole of #427 was inert in the published surface.
  describe("provider metadata wiring (#427)", () => {
    const redisMetadata = {
      capabilities: {
        queryLanguage: "json",
        queryDialect: "redis",
        tablesAreDerivedGroupings: true,
        supportsMaintenance: true,
        maintenanceOperations: ["analyze"],
      },
      labels: { selectAction: "Scan Keys" },
    } as unknown as ProviderMetadata;

    test("hands the connection adapter's metadata to the tab manager and every child that reads it", () => {
      connAdapterOverride = { activeConnection: { ...dbConn, type: "redis" as const }, metadata: redisMetadata };
      renderWorkspace();

      expect(capturedTabManagerArgs.metadata).toBe(redisMetadata);
      expect(capturedSidebarProps.metadata).toBe(redisMetadata);
      expect(capturedQueryToolbarProps.metadata).toBe(redisMetadata);
      expect(capturedBottomPanelProps.metadata).toBe(redisMetadata);
      expect(capturedQueryEditorProps.capabilities).toBe(redisMetadata.capabilities);
    });

    test("a redis connection here generates a redis command, not SQL", () => {
      connAdapterOverride = { activeConnection: { ...dbConn, type: "redis" as const }, metadata: redisMetadata };
      renderWorkspace();

      // The generator the tab manager runs, fed the metadata this shell actually
      // passed it: with `null` it fell through to `SELECT * FROM user:* LIMIT 50;`.
      const capabilities = (capturedTabManagerArgs.metadata as ProviderMetadata).capabilities;
      const query = generateTableQuery("user:*", capabilities, []);
      expect(query.startsWith("SCAN ")).toBe(true);
      expect(query).not.toContain("SELECT");
    });

    test("stays null when the host declares no capabilities", () => {
      renderWorkspace();
      expect(capturedTabManagerArgs.metadata).toBeNull();
      expect(capturedSidebarProps.metadata).toBeNull();
    });

    // Passing real metadata un-hides QueryToolbar's `queryLanguage === "sql"`
    // group, which this shell serves none of: `transactionActive` and
    // `editingEnabled` are hardcoded false here and nothing can change them, so a
    // `noop` callback is a button that silently does nothing. Withholding the
    // callback is how the toolbar is told not to render the control (#269, #427).
    test("withholds every control the embedded shell cannot serve", () => {
      const sqlMetadata = {
        capabilities: { queryLanguage: "sql", supportsMaintenance: false, maintenanceOperations: [] },
      } as unknown as ProviderMetadata;
      connAdapterOverride = { metadata: sqlMetadata };
      renderWorkspace();

      expect(capturedQueryToolbarProps.metadata).toBe(sqlMetadata);
      expect(capturedQueryToolbarProps.onBeginTransaction).toBeUndefined();
      expect(capturedQueryToolbarProps.onCommitTransaction).toBeUndefined();
      expect(capturedQueryToolbarProps.onRollbackTransaction).toBeUndefined();
      expect(capturedQueryToolbarProps.onTogglePlayground).toBeUndefined();
      expect(capturedQueryToolbarProps.onToggleEditing).toBeUndefined();
      // The controls it does serve stay wired.
      expect(typeof capturedQueryToolbarProps.onExecuteQuery).toBe("function");
      expect(typeof capturedQueryToolbarProps.onImport).toBe("function");
    });

    test("withholds onImport too when the host disables the data-import feature", () => {
      renderWorkspace({ features: ALL_FEATURES_OFF });
      expect(capturedQueryToolbarProps.onImport).toBeUndefined();
    });
  });

  // =========================================================================
  // BottomPanel callbacks
  // =========================================================================

  test("bottom panel onLoadQuery delegates", () => {
    renderWorkspace();
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

  // =========================================================================
  // What the panel group holds below the breakpoint
  // =========================================================================

  /**
   * The embedded surface carried the same defect as the standalone shell:
   * `react-resizable-panels` 4 applies a `Panel`'s `className` to a NESTED div, so
   * `hidden md:block` hid the sidebar's contents while the panel kept its 22% of the
   * row. The host's phone viewport got a 22% empty column and a squeezed body.
   */
  test("the phone renders no sidebar panel to take a share of the row", () => {
    setViewportMobile(true);
    const { queryByTestId } = renderWorkspace();
    expect(queryByTestId("sidebar")).toBeNull();
  });

  test("and the sidebar is back above the breakpoint", () => {
    setViewportMobile(false);
    const { queryByTestId } = renderWorkspace();
    expect(queryByTestId("sidebar")).not.toBeNull();
  });
});
