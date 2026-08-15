import "../setup-dom";
import "../helpers/mock-sonner";
import { mockRouterPush } from "../helpers/mock-navigation";

import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test";
import { render, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { setupMonacoMock, setupRechartssMock, setupXYFlowMock, setupFramerMotionMock } from "../helpers/mock-monaco";

// Setup heavy library mocks before any component imports
setupMonacoMock();
setupRechartssMock();
setupXYFlowMock();
setupFramerMotionMock();

// ---- Module-level prop capture for child components ----
let capturedSidebarProps: Record<string, unknown> = {};
let capturedBottomPanelProps: Record<string, unknown> = {};
let capturedQueryToolbarProps: Record<string, unknown> = {};
let capturedConnectionModalProps: Record<string, unknown> = {};
let capturedSaveQueryModalProps: Record<string, unknown> = {};
let capturedCommandPaletteProps: Record<string, unknown> = {};
let capturedSafetyDialogProps: Record<string, unknown> = {};
let capturedMobileHeaderProps: Record<string, unknown> = {};
let capturedSchemaExplorerProps: Record<string, unknown> = {};
let capturedConnectionsListProps: Record<string, unknown> = {};
let capturedQueryEditorProps: Record<string, unknown> = {};
let capturedMobileNavProps: Record<string, unknown> = {};
let capturedAgentRailProps: Record<string, unknown> = {};
let originalFetch: typeof globalThis.fetch;
let originalMatchMedia: typeof window.matchMedia;

// ---- Trackable mock functions (shared across mocks + assertions) ----

// Auth
const mockHandleLogout = mock(() => {});
// Connection Manager
const mockSetConnections = mock(() => {});
const mockSetActiveConnection = mock(() => {});
const mockSetSchema = mock(() => {});
const mockFetchSchema = mock(() => {});
// Tab Manager
const mockSetTabs = mock(() => {});
const mockUpdateCurrentTab = mock(() => {});
const mockUpdateTabById = mock(() => {});
const mockHandleTableClick = mock(() => {});
const mockHandleGenerateSelect = mock(() => {});
// Transaction Control
const mockResetTransactionState = mock(() => {});
const mockSetPlaygroundMode = mock(() => {});
// Query Execution
const mockExecuteQuery = mock(() => {});
const mockForceExecuteQuery = mock(() => {});
const mockExecuteHandedOverStatement = mock(() => {});
const mockCancelQuery = mock(() => {});
const mockSetSafetyCheckQuery = mock(() => {});
const mockSetBottomPanelMode = mock(() => {});
const mockHandleUnlimitedQuery = mock(() => {});
const mockHandleLoadMore = mock(() => {});
// Inline Editing
const mockSetEditingEnabled = mock(() => {});
const mockHandleCellChange = mock(() => {});
const mockHandleApplyChanges = mock(() => {});
const mockHandleDiscardChanges = mock(() => {});
// Toast
const mockToast = mock(() => {});
// Storage
const mockStorageSaveConnection = mock(() => {});
const mockStorageGetConnections = mock(() => [] as unknown[]);
const mockStorageDeleteConnection = mock(() => {});
const mockStorageSaveQuery = mock(() => {});
// Data Masking
const mockSaveMaskingConfig = mock(() => {});
// URL (for export tests)
const mockCreateObjectURL = mock(() => "blob:mock-url");
const mockRevokeObjectURL = mock(() => {});

// ---- Hook override objects (spread into mock returns per-test) ----
let connMgrOverride: Record<string, unknown> = {};
let tabMgrOverride: Record<string, unknown> = {};
let queryExecOverride: Record<string, unknown> = {};
let authOverride: Record<string, unknown> = {};
let editingOverride: Record<string, unknown> = {};
let capabilitiesOverride: Record<string, unknown> = {};
let metadataOverride: Record<string, unknown> = {};

// ---- Mock all hooks ----

mock.module("@/hooks/use-auth", () => ({
  useAuth: mock(() => ({
    user: { username: "admin", role: "admin" },
    isAdmin: true,
    handleLogout: mockHandleLogout,
    ...authOverride,
  })),
}));

mock.module("@/hooks/use-connection-manager", () => ({
  useConnectionManager: mock(() => ({
    connections: [],
    servedSeeds: [],
    activeConnection: null,
    schema: [],
    schemaContext: "[]",
    isLoadingSchema: false,
    connectionPulse: "none",
    setConnections: mockSetConnections,
    setActiveConnection: mockSetActiveConnection,
    setSchema: mockSetSchema,
    fetchSchema: mockFetchSchema,
    ...connMgrOverride,
  })),
}));

mock.module("@/hooks/use-provider-metadata", () => ({
  useProviderMetadata: mock(() => ({
    metadata: {
      capabilities: {
        queryLanguage: "sql",
        supportsExplain: true,
        supportsCreateTable: true,
        supportsTransactions: true,
        maintenanceOperations: ["vacuum"],
        schemaRefreshPattern: "^(CREATE|DROP)\\b",
        supportsInlineRowEdit: true,
        ...capabilitiesOverride,
      },
      labels: {
        entityName: "Table",
        entitiesName: "Tables",
        selectAction: "SELECT * FROM",
        searchPlaceholder: "Search...",
        editorLanguage: "sql",
      },
    },
    ...metadataOverride,
  })),
}));

mock.module("@/hooks/use-tab-manager", () => ({
  useTabManager: mock(() => ({
    tabs: [{ id: "tab-1", name: "Query 1", query: "SELECT 1", result: null, isExecuting: false, type: "sql" }],
    activeTabId: "tab-1",
    currentTab: { id: "tab-1", name: "Query 1", query: "SELECT 1", result: null, isExecuting: false, type: "sql" },
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

const mockHandleTransaction = mock(() => {});

mock.module("@/hooks/use-transaction-control", () => ({
  useTransactionControl: mock(() => ({
    transactionActive: false,
    playgroundMode: false,
    handleTransaction: mockHandleTransaction,
    setPlaygroundMode: mockSetPlaygroundMode,
    resetTransactionState: mockResetTransactionState,
  })),
}));

mock.module("@/hooks/use-query-execution", () => ({
  useQueryExecution: mock(() => ({
    bottomPanelMode: "results",
    setBottomPanelMode: mockSetBottomPanelMode,
    historyKey: 0,
    executeQuery: mockExecuteQuery,
    cancelQuery: mockCancelQuery,
    forceExecuteQuery: mockForceExecuteQuery,
    executeHandedOverStatement: mockExecuteHandedOverStatement,
    safetyCheckQuery: null,
    setSafetyCheckQuery: mockSetSafetyCheckQuery,
    unlimitedWarningOpen: false,
    setUnlimitedWarningOpen: mock(() => {}),
    handleUnlimitedQuery: mockHandleUnlimitedQuery,
    handleLoadMore: mockHandleLoadMore,
    ...queryExecOverride,
  })),
}));

mock.module("@/hooks/use-inline-editing", () => ({
  useInlineEditing: mock(() => ({
    editingEnabled: false,
    pendingChanges: [],
    setEditingEnabled: mockSetEditingEnabled,
    handleCellChange: mockHandleCellChange,
    handleApplyChanges: mockHandleApplyChanges,
    handleDiscardChanges: mockHandleDiscardChanges,
    ...editingOverride,
  })),
}));

mock.module("@/hooks/use-toast", () => ({
  useToast: mock(() => ({
    toast: mockToast,
  })),
}));

mock.module("@/hooks/use-storage-sync", () => ({
  useStorageSync: mock(() => ({
    isServerMode: false,
    isSyncing: false,
    isReady: true,
    lastSyncedAt: null,
    syncError: null,
  })),
}));

// ---- Mock utility modules ----

mock.module("@/lib/storage", () => ({
  storage: {
    saveConnection: mockStorageSaveConnection,
    getConnections: mockStorageGetConnections,
    deleteConnection: mockStorageDeleteConnection,
    saveQuery: mockStorageSaveQuery,
    getActiveConnectionId: mock(() => null),
  },
}));

mock.module("@/lib/data-masking", () => ({
  loadMaskingConfig: mock(() => ({
    enabled: false,
    patterns: [],
    roles: {
      admin: { canToggleMasking: true, canRevealValues: true },
      user: { canToggleMasking: false, canRevealValues: false },
    },
  })),
  saveMaskingConfig: mockSaveMaskingConfig,
  shouldMask: mock(() => false),
  canToggleMasking: mock(() => true),
  detectSensitiveColumnsFromConfig: mock(() => new Set()),
  applyMaskingToRows: mock((rows: unknown) => rows),
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
    ConnectionsList: (props: Record<string, unknown>) => {
      capturedConnectionsListProps = props;
      return React.createElement("div", { "data-testid": "connections-list" }, "ConnectionsList");
    },
  };
});

mock.module("@/components/MobileNav", () => ({
  MobileNav: (props: Record<string, unknown>) => {
    capturedMobileNavProps = props;
    return null;
  },
}));

mock.module("@/components/schema-explorer", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    SchemaExplorer: (props: Record<string, unknown>) => {
      capturedSchemaExplorerProps = props;
      return React.createElement("div", { "data-testid": "schema-explorer" }, "SchemaExplorer");
    },
  };
});

mock.module("@/components/ConnectionModal", () => ({
  ConnectionModal: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    capturedConnectionModalProps = props;
    return props.isOpen ? React.createElement("div", { "data-testid": "connection-modal" }, "ConnectionModal") : null;
  },
}));

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

// Mock the studio sub-components barrel.
// Studio.tsx imports from '@/components/studio/index' to avoid ambiguity with
// the Studio.tsx file itself (bun resolves '@/components/studio' to Studio.tsx).
mock.module("@/components/studio/index", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    StudioMobileHeader: (props: Record<string, unknown>) => {
      capturedMobileHeaderProps = props;
      return React.createElement("div", { "data-testid": "mobile-header" }, "MobileHeader");
    },
    StudioDesktopHeader: () => React.createElement("div", { "data-testid": "desktop-header" }, "DesktopHeader"),
    StudioTabBar: () => React.createElement("div", { "data-testid": "tab-bar" }, "TabBar"),
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

mock.module("@/components/CommandPalette", () => ({
  CommandPalette: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    capturedCommandPaletteProps = props;
    return React.createElement("div", { "data-testid": "command-palette" }, "CommandPalette");
  },
}));

mock.module("@/components/SchemaDiagram", () => ({
  SchemaDiagram: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return React.createElement("div", { "data-testid": "schemadiagram" }, "SchemaDiagram");
  },
}));

mock.module("@/components/DataImportModal", () => ({
  DataImportModal: (props: { isOpen?: boolean }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
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
}));

mock.module("@/components/DataProfiler", () => ({
  DataProfiler: (props: { isOpen?: boolean }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return props.isOpen ? React.createElement("div", { "data-testid": "dataprofiler" }, "DataProfiler") : null;
  },
}));

mock.module("@/components/CodeGenerator", () => ({
  CodeGenerator: (props: { isOpen?: boolean }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return props.isOpen ? React.createElement("div", { "data-testid": "codegenerator" }, "CodeGenerator") : null;
  },
}));

mock.module("@/components/TestDataGenerator", () => ({
  TestDataGenerator: (props: { isOpen?: boolean }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return props.isOpen
      ? React.createElement("div", { "data-testid": "testdatagenerator" }, "TestDataGenerator")
      : null;
  },
}));

mock.module("@/components/CreateTableModal", () => ({
  CreateTableModal: (props: { isOpen?: boolean }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    return props.isOpen ? React.createElement("div", { "data-testid": "createtablemodal" }, "CreateTableModal") : null;
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

// The agent rail (#329 T10a). Mocked like every other child so this file tests the
// SHELL's decisions — whether the rail exists at all, and what connection it is
// handed — while the rail's own behaviour is covered in
// tests/components/agent/AgentRail.test.tsx. The capability hook is deliberately NOT
// mocked: "the flag is off" has to be proven through the real discovery path.
mock.module("@/components/agent/AgentRail", () => ({
  AgentRail: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    capturedAgentRailProps = props;
    return React.createElement("div", { "data-testid": "agent-rail" }, "AgentRail");
  },
}));

/**
 * The prefill seam's shell half (#331 T1), stubbed to a value nothing else could
 * produce.
 *
 * The T1 adversarial review found the wiring untested: the test below asserted only
 * that the request starts null, which is also what a Studio that never called the hook
 * and hard-coded `prefill={null}` would report. So the hook is replaced by one that
 * always holds an ask, and what the rail is handed has to BE it. The hook's own
 * behaviour — that nothing is asked for until a shortcut asks, and what an ask
 * contains — is covered in tests/hooks/use-agent-prefill.test.ts, which runs in a
 * different process: `mock.module` is process-wide, and Studio.test.tsx is its own
 * isolation group (tests/run-components.sh Group 1), so no suite shares this stub.
 */
const PREFILL_SENTINEL = {
  id: 7,
  workflowType: "query-optimization",
  objective: "why is checkout slow",
} as const;

/**
 * Hoisted out of the factory (#331 T3) so what a shortcut ASKS FOR is observable.
 * Left inside, every render minted a fresh mock and the calls were unreachable.
 */
const mockRequestPrefill = mock((_workflowType: string, _objective: string) => {});

mock.module("@/components/agent/use-agent-prefill", () => ({
  useAgentPrefill: () => ({ request: PREFILL_SENTINEL, requestPrefill: mockRequestPrefill }),
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

// ---- Load the component under test AFTER all mock.module registrations ----
// A static import would be hoisted and evaluate the real module tree (QueryEditor,
// sidebar, schema-explorer, BottomPanel, monaco, ...) before the mocks apply,
// poisoning coverage with zero-hit phantom lines for modules that never execute.
// The dynamic import resolves against the mock registry instead.

const { default: Studio } = await import("@/components/Studio");

// =============================================================================
// Test data
// =============================================================================

const pgConn = {
  id: "c1",
  type: "postgres" as const,
  name: "TestPG",
  host: "localhost",
  port: 5432,
  database: "test",
  user: "admin",
  password: "pass",
};

const testResult = {
  rows: [
    { id: 1, name: "Alice", salary: 50000 },
    { id: 2, name: "Bob's", salary: 60000, active: true },
  ],
  fields: ["id", "name", "salary", "active"],
  rowCount: 2,
  executionTime: 10,
};

// =============================================================================
// Studio Tests
// =============================================================================

describe("Studio", () => {
  beforeEach(() => {
    // Reset prop captures
    capturedSidebarProps = {};
    capturedBottomPanelProps = {};
    capturedQueryToolbarProps = {};
    capturedConnectionModalProps = {};
    capturedSaveQueryModalProps = {};
    capturedCommandPaletteProps = {};
    capturedSafetyDialogProps = {};
    capturedMobileHeaderProps = {};
    capturedSchemaExplorerProps = {};
    capturedConnectionsListProps = {};
    capturedQueryEditorProps = {};
    capturedMobileNavProps = {};
    capturedAgentRailProps = {};

    // Reset overrides
    connMgrOverride = {};
    tabMgrOverride = {};
    queryExecOverride = {};
    authOverride = {};
    editingOverride = {};
    capabilitiesOverride = {};
    metadataOverride = {};

    // Clear trackable mocks
    mockHandleLogout.mockClear();
    mockSetConnections.mockClear();
    mockSetActiveConnection.mockClear();
    mockSetSchema.mockClear();
    mockFetchSchema.mockClear();
    mockSetTabs.mockClear();
    mockUpdateCurrentTab.mockClear();
    mockUpdateTabById.mockClear();
    mockHandleTableClick.mockClear();
    mockHandleGenerateSelect.mockClear();
    mockResetTransactionState.mockClear();
    mockHandleTransaction.mockClear();
    mockSetPlaygroundMode.mockClear();
    mockExecuteQuery.mockClear();
    mockForceExecuteQuery.mockClear();
    mockExecuteHandedOverStatement.mockClear();
    mockCancelQuery.mockClear();
    mockSetSafetyCheckQuery.mockClear();
    mockSetBottomPanelMode.mockClear();
    mockHandleUnlimitedQuery.mockClear();
    mockHandleLoadMore.mockClear();
    mockSetEditingEnabled.mockClear();
    mockHandleCellChange.mockClear();
    mockHandleApplyChanges.mockClear();
    mockHandleDiscardChanges.mockClear();
    mockToast.mockClear();
    mockStorageSaveConnection.mockClear();
    mockStorageGetConnections.mockClear();
    mockStorageGetConnections.mockReturnValue([]);
    mockStorageDeleteConnection.mockClear();
    mockStorageSaveQuery.mockClear();
    mockSaveMaskingConfig.mockClear();
    mockCreateObjectURL.mockClear();
    mockRevokeObjectURL.mockClear();
    mockRouterPush.mockClear();
    mockRequestPrefill.mockClear();

    // URL mocks (may not exist in happy-dom)
    originalFetch = globalThis.fetch;
    originalMatchMedia = window.matchMedia;
    globalThis.URL.createObjectURL = mockCreateObjectURL as unknown as typeof URL.createObjectURL;
    globalThis.URL.revokeObjectURL = mockRevokeObjectURL as unknown as typeof URL.revokeObjectURL;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    window.matchMedia = originalMatchMedia;
  });

  // =========================================================================
  // Rendering tests (existing)
  // =========================================================================

  test("renders without crashing", () => {
    const { container } = render(<Studio />);
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  test("shows sidebar", () => {
    const { getByTestId } = render(<Studio />);
    const sidebar = getByTestId("sidebar");
    expect(sidebar).not.toBeNull();
    expect(sidebar.textContent).toBe("Sidebar");
  });

  test("shows desktop header", () => {
    const { getByTestId } = render(<Studio />);
    const header = getByTestId("desktop-header");
    expect(header).not.toBeNull();
    expect(header.textContent).toBe("DesktopHeader");
  });

  test("shows tab bar", () => {
    const { getByTestId } = render(<Studio />);
    const tabBar = getByTestId("tab-bar");
    expect(tabBar).not.toBeNull();
    expect(tabBar.textContent).toBe("TabBar");
  });

  test("shows query editor", () => {
    const { getByTestId } = render(<Studio />);
    const editor = getByTestId("query-editor");
    expect(editor).not.toBeNull();
    expect(editor.textContent).toBe("QueryEditor");
  });

  test("shows query toolbar", () => {
    const { getByTestId } = render(<Studio />);
    const toolbar = getByTestId("query-toolbar");
    expect(toolbar).not.toBeNull();
    expect(toolbar.textContent).toBe("QueryToolbar");
  });

  test("shows bottom panel", () => {
    const { getByTestId } = render(<Studio />);
    const panel = getByTestId("bottom-panel");
    expect(panel).not.toBeNull();
    expect(panel.textContent).toBe("BottomPanel");
  });

  test("shows command palette", () => {
    const { getByTestId } = render(<Studio />);
    const palette = getByTestId("command-palette");
    expect(palette).not.toBeNull();
    expect(palette.textContent).toBe("CommandPalette");
  });

  test("connection modal hidden by default", () => {
    const { queryByTestId } = render(<Studio />);
    const modal = queryByTestId("connection-modal");
    expect(modal).toBeNull();
  });

  test("create table modal hidden by default", () => {
    const { queryByTestId } = render(<Studio />);
    const modal = queryByTestId("createtablemodal");
    expect(modal).toBeNull();
  });

  test("data import modal hidden by default", () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId("dataimportmodal")).toBeNull();
  });

  test("data profiler hidden by default", () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId("dataprofiler")).toBeNull();
  });

  test("code generator hidden by default", () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId("codegenerator")).toBeNull();
  });

  test("test data generator hidden by default", () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId("testdatagenerator")).toBeNull();
  });

  test("save query modal hidden by default", () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId("savequerymodal")).toBeNull();
  });

  test("schema diagram hidden by default", () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId("schemadiagram")).toBeNull();
  });

  test("query safety dialog hidden by default", () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId("querysafetydialog")).toBeNull();
  });

  test("resizable panels render", () => {
    const { container } = render(<Studio />);
    const groups = container.querySelectorAll('[data-testid="resizable-group"]');
    expect(groups.length).toBeGreaterThanOrEqual(1);
  });

  test("resizable handles render", () => {
    const { container } = render(<Studio />);
    const handles = container.querySelectorAll('[data-testid="resizable-handle"]');
    expect(handles.length).toBeGreaterThanOrEqual(1);
  });

  test("multiple renders do not crash", () => {
    const { container, rerender } = render(<Studio />);
    rerender(<Studio />);
    rerender(<Studio />);
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  // =========================================================================
  // Callback + logic tests
  // =========================================================================

  // --- openMaintenance ---
  test("openMaintenance navigates to admin operations when admin", () => {
    render(<Studio />);
    const fn = capturedSidebarProps.onOpenMaintenance as () => void;
    act(() => fn());
    expect(mockRouterPush).toHaveBeenCalledWith("/admin/operations");
  });

  test("openMaintenance navigates to monitoring when not admin", () => {
    authOverride = { isAdmin: false };
    render(<Studio />);
    const fn = capturedSidebarProps.onOpenMaintenance as () => void;
    act(() => fn());
    expect(mockRouterPush).toHaveBeenCalledWith("/monitoring");
  });

  // --- handleSaveQuery ---
  test("handleSaveQuery saves query and shows toast", () => {
    connMgrOverride = { activeConnection: pgConn };
    render(<Studio />);
    const onSave = capturedSaveQueryModalProps.onSave as (name: string, desc: string, tags: string[]) => void;
    act(() => onSave("My Query", "A test query", ["test"]));
    expect(mockStorageSaveQuery).toHaveBeenCalledTimes(1);
    const saved = (mockStorageSaveQuery.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(saved.name).toBe("My Query");
    expect(saved.connectionType).toBe("postgres");
    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  test("handleSaveQuery returns early without activeConnection", () => {
    render(<Studio />);
    const onSave = capturedSaveQueryModalProps.onSave as (name: string, desc: string, tags: string[]) => void;
    act(() => onSave("Noop", "", []));
    expect(mockStorageSaveQuery).not.toHaveBeenCalled();
  });

  // --- handleDeleteConnection ---
  test("handleDeleteConnection removes connection and updates list", () => {
    const remaining = [{ id: "c2", type: "mysql", name: "MySQL" }];
    mockStorageGetConnections.mockReturnValue(remaining);
    connMgrOverride = { activeConnection: pgConn, connections: [pgConn, remaining[0]] };
    render(<Studio />);
    const deleteFn = capturedSidebarProps.onDeleteConnection as (id: string) => void;
    act(() => deleteFn("c1"));
    expect(mockStorageDeleteConnection).toHaveBeenCalledWith("c1");
    expect(mockSetConnections).toHaveBeenCalledWith(remaining);
    expect(mockSetActiveConnection).toHaveBeenCalledWith(remaining[0]);
  });

  // --- onTableClick ---
  test("onTableClick delegates to handleTableClick with executeQuery", () => {
    render(<Studio />);
    const fn = capturedSidebarProps.onTableClick as (name: string) => void;
    act(() => fn("users"));
    expect(mockHandleTableClick).toHaveBeenCalledWith("users", mockExecuteQuery);
  });

  // --- onEditConnection ---
  test("onEditConnection opens connection modal with connection", () => {
    render(<Studio />);
    const fn = capturedSidebarProps.onEditConnection as (c: unknown) => void;
    act(() => fn(pgConn));
    expect(capturedConnectionModalProps.isOpen).toBe(true);
    expect(capturedConnectionModalProps.editConnection).toEqual(pgConn);
  });

  // --- onAddConnection ---
  test("onAddConnection opens connection modal", () => {
    render(<Studio />);
    const fn = capturedSidebarProps.onAddConnection as () => void;
    act(() => fn());
    expect(capturedConnectionModalProps.isOpen).toBe(true);
  });

  // --- ConnectionModal onConnect ---
  test("ConnectionModal onConnect saves and activates connection", () => {
    const newConns = [pgConn];
    mockStorageGetConnections.mockReturnValue(newConns);
    render(<Studio />);
    const onConnect = capturedConnectionModalProps.onConnect as (c: unknown) => void;
    act(() => onConnect(pgConn));
    expect(mockStorageSaveConnection).toHaveBeenCalledWith(pgConn);
    expect(mockSetConnections).toHaveBeenCalledWith(newConns);
    expect(mockSetActiveConnection).toHaveBeenCalledWith(pgConn);
  });

  // --- ConnectionModal onClose ---
  test("ConnectionModal onClose resets editing and closes modal", () => {
    render(<Studio />);
    // Open the modal
    const addFn = capturedSidebarProps.onAddConnection as () => void;
    act(() => addFn());
    expect(capturedConnectionModalProps.isOpen).toBe(true);
    // Close the modal
    const closeFn = capturedConnectionModalProps.onClose as () => void;
    act(() => closeFn());
    expect(capturedConnectionModalProps.isOpen).toBe(false);
  });

  // --- exportResults ---
  test("exportResults CSV creates text/csv blob", () => {
    tabMgrOverride = {
      currentTab: {
        id: "tab-1",
        name: "Users",
        query: "SELECT 1",
        result: testResult,
        isExecuting: false,
        type: "sql",
      },
    };
    render(<Studio />);
    const exportFn = capturedBottomPanelProps.onExportResults as (format: string) => void;
    act(() => exportFn("csv"));
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
    expect(mockRevokeObjectURL).toHaveBeenCalledTimes(1);
    const blob = (mockCreateObjectURL.mock.calls[0] as unknown[])[0] as Blob;
    expect(blob.type).toBe("text/csv");
  });

  test("exportResults JSON creates application/json blob", () => {
    tabMgrOverride = {
      currentTab: {
        id: "tab-1",
        name: "Users",
        query: "SELECT 1",
        result: testResult,
        isExecuting: false,
        type: "sql",
      },
    };
    render(<Studio />);
    const exportFn = capturedBottomPanelProps.onExportResults as (format: string) => void;
    act(() => exportFn("json"));
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
    const blob = (mockCreateObjectURL.mock.calls[0] as unknown[])[0] as Blob;
    expect(blob.type).toContain("application/json");
  });

  test("exportResults sql-insert creates text/sql blob", () => {
    tabMgrOverride = {
      currentTab: {
        id: "tab-1",
        name: "Users",
        query: "SELECT 1",
        result: testResult,
        isExecuting: false,
        type: "sql",
      },
    };
    render(<Studio />);
    const exportFn = capturedBottomPanelProps.onExportResults as (format: string) => void;
    act(() => exportFn("sql-insert"));
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
    const blob = (mockCreateObjectURL.mock.calls[0] as unknown[])[0] as Blob;
    expect(blob.type).toBe("text/sql");
  });

  // The exported file is SQL that will be run somewhere later, usually
  // unattended, and every value in it is data the table held. A cell ending in a
  // backslash would close its literal on a dialect that escapes with one and have
  // the rest of the file read as statements (#290).
  test("exportResults sql-insert quotes a cell for the connected dialect", async () => {
    connMgrOverride = { activeConnection: { ...pgConn, type: "mysql" as const } };
    tabMgrOverride = {
      currentTab: {
        id: "tab-1",
        name: "Users",
        query: "SELECT 1",
        result: {
          rows: [{ id: 1, path: "C:\\Users\\'); DROP TABLE users; --" }],
          fields: ["id", "path"],
          rowCount: 1,
          executionTime: 1,
        },
        isExecuting: false,
        type: "sql",
      },
    };
    render(<Studio />);
    const exportFn = capturedBottomPanelProps.onExportResults as (format: string) => void;
    act(() => exportFn("sql-insert"));

    const blob = (mockCreateObjectURL.mock.calls[0] as unknown[])[0] as Blob;
    expect(await blob.text()).toBe(
      "INSERT INTO Users (id, path) VALUES (1, 'C:\\\\Users\\\\''); DROP TABLE users; --');",
    );
  });

  test("exportResults sql-ddl creates text/sql blob", () => {
    tabMgrOverride = {
      currentTab: {
        id: "tab-1",
        name: "Users",
        query: "SELECT 1",
        result: testResult,
        isExecuting: false,
        type: "sql",
      },
    };
    render(<Studio />);
    const exportFn = capturedBottomPanelProps.onExportResults as (format: string) => void;
    act(() => exportFn("sql-ddl"));
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
    const blob = (mockCreateObjectURL.mock.calls[0] as unknown[])[0] as Blob;
    expect(blob.type).toBe("text/sql");
  });

  test("exportResults with no result does nothing", () => {
    render(<Studio />);
    const exportFn = capturedBottomPanelProps.onExportResults as (format: string) => void;
    act(() => exportFn("csv"));
    expect(mockCreateObjectURL).not.toHaveBeenCalled();
  });

  // --- CommandPalette callbacks ---
  test("CommandPalette onLoadSavedQuery loads query and switches to results", () => {
    render(<Studio />);
    const fn = capturedCommandPaletteProps.onLoadSavedQuery as (q: string) => void;
    act(() => fn("SELECT * FROM orders"));
    expect(mockUpdateCurrentTab).toHaveBeenCalledWith({ query: "SELECT * FROM orders" });
    expect(mockSetBottomPanelMode).toHaveBeenCalledWith("results");
  });

  test("CommandPalette onLoadHistoryQuery loads query and switches to results", () => {
    render(<Studio />);
    const fn = capturedCommandPaletteProps.onLoadHistoryQuery as (q: string) => void;
    act(() => fn("SELECT 1"));
    expect(mockUpdateCurrentTab).toHaveBeenCalledWith({ query: "SELECT 1" });
    expect(mockSetBottomPanelMode).toHaveBeenCalledWith("results");
  });

  test("CommandPalette onNavigateMonitoring pushes /monitoring", () => {
    render(<Studio />);
    const fn = capturedCommandPaletteProps.onNavigateMonitoring as () => void;
    act(() => fn());
    expect(mockRouterPush).toHaveBeenCalledWith("/monitoring");
  });

  test("CommandPalette onShowDiagram opens diagram", () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId("schemadiagram")).toBeNull();
    const fn = capturedCommandPaletteProps.onShowDiagram as () => void;
    act(() => fn());
    expect(queryByTestId("schemadiagram")).not.toBeNull();
  });

  // --- QueryToolbar callbacks ---
  test("QueryToolbar onToggleEditing enables editing", () => {
    render(<Studio />);
    const fn = capturedQueryToolbarProps.onToggleEditing as () => void;
    act(() => fn());
    // editingEnabled is false by default → setEditingEnabled(true)
    expect(mockSetEditingEnabled).toHaveBeenCalledWith(true);
    expect(mockHandleDiscardChanges).not.toHaveBeenCalled();
  });

  test("QueryToolbar onToggleEditing disables editing and discards changes", () => {
    editingOverride = { editingEnabled: true };
    render(<Studio />);
    const fn = capturedQueryToolbarProps.onToggleEditing as () => void;
    act(() => fn());
    expect(mockSetEditingEnabled).toHaveBeenCalledWith(false);
    expect(mockHandleDiscardChanges).toHaveBeenCalled();
  });

  // --- Inline-edit capability gate (#269) ---
  test("withholds every editing affordance when supportsInlineRowEdit is false", () => {
    capabilitiesOverride = { supportsInlineRowEdit: false };
    // Even with editing already switched on in the hook, no editable cell wiring
    // may reach the grid — the gate is not just the toggle.
    editingOverride = { editingEnabled: true };
    render(<Studio />);

    expect(capturedQueryToolbarProps.onToggleEditing).toBeUndefined();
    expect(capturedMobileHeaderProps.onToggleEditing).toBeUndefined();
    expect(capturedQueryToolbarProps.editingEnabled).toBe(false);
    expect(capturedMobileHeaderProps.editingEnabled).toBe(false);
    expect(capturedBottomPanelProps.editingEnabled).toBe(false);
  });

  test("withholds every editing affordance when the capability is absent entirely", () => {
    // The flag is optional on the published `ProviderCapabilities` (PR #289
    // review: making it required broke every external implementer of the type),
    // so a capability set that omits it must read as unsupported rather than
    // inheriting the base provider's default.
    capabilitiesOverride = { supportsInlineRowEdit: undefined };
    editingOverride = { editingEnabled: true };
    render(<Studio />);

    expect(capturedQueryToolbarProps.onToggleEditing).toBeUndefined();
    expect(capturedQueryToolbarProps.editingEnabled).toBe(false);
    expect(capturedBottomPanelProps.editingEnabled).toBe(false);
  });

  test("passes the editing affordance through when supportsInlineRowEdit is true", () => {
    editingOverride = { editingEnabled: true };
    render(<Studio />);

    expect(typeof capturedQueryToolbarProps.onToggleEditing).toBe("function");
    expect(typeof capturedMobileHeaderProps.onToggleEditing).toBe("function");
    expect(capturedQueryToolbarProps.editingEnabled).toBe(true);
    expect(capturedMobileHeaderProps.editingEnabled).toBe(true);
    expect(capturedBottomPanelProps.editingEnabled).toBe(true);
  });

  test("withholds the editing affordance while provider metadata is unresolved", () => {
    // metadata is also null when /api/db/provider-meta fails, so unknown must
    // hide the control rather than fall open (the T3 precedent).
    metadataOverride = { metadata: null };
    render(<Studio />);

    expect(capturedQueryToolbarProps.onToggleEditing).toBeUndefined();
    expect(capturedBottomPanelProps.editingEnabled).toBe(false);
  });

  test("QueryToolbar onImport opens import modal", () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId("dataimportmodal")).toBeNull();
    const fn = capturedQueryToolbarProps.onImport as () => void;
    act(() => fn());
    expect(queryByTestId("dataimportmodal")).not.toBeNull();
  });

  test("QueryToolbar onSaveQuery opens save query modal", () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId("savequerymodal")).toBeNull();
    const fn = capturedQueryToolbarProps.onSaveQuery as () => void;
    act(() => fn());
    expect(queryByTestId("savequerymodal")).not.toBeNull();
  });

  // --- BottomPanel callbacks ---
  test("BottomPanel onToggleMasking toggles masking config", () => {
    render(<Studio />);
    const fn = capturedBottomPanelProps.onToggleMasking as () => void;
    expect(fn).toBeDefined();
    act(() => fn());
    expect(mockSaveMaskingConfig).toHaveBeenCalledTimes(1);
  });

  test("BottomPanel onLoadQuery updates current tab query", () => {
    render(<Studio />);
    const fn = capturedBottomPanelProps.onLoadQuery as (q: string) => void;
    act(() => fn("SELECT * FROM products"));
    expect(mockUpdateCurrentTab).toHaveBeenCalledWith({ query: "SELECT * FROM products" });
  });

  // --- QuerySafetyDialog ---
  test("QuerySafetyDialog onProceed calls forceExecuteQuery", () => {
    queryExecOverride = { safetyCheckQuery: "DROP TABLE users" };
    render(<Studio />);
    const fn = capturedSafetyDialogProps.onProceed as () => void;
    act(() => fn());
    expect(mockForceExecuteQuery).toHaveBeenCalledWith("DROP TABLE users");
  });

  // --- Connection-change effect ---
  test("connection-change effect resets state and fetches schema", () => {
    connMgrOverride = { activeConnection: pgConn };
    render(<Studio />);
    expect(mockResetTransactionState).toHaveBeenCalled();
    expect(mockSetEditingEnabled).toHaveBeenCalledWith(false);
    expect(mockHandleDiscardChanges).toHaveBeenCalled();
    expect(mockFetchSchema).toHaveBeenCalledWith(pgConn);
    expect(mockSetTabs).toHaveBeenCalled();
  });

  test("connection-change effect clears schema when no active connection", () => {
    render(<Studio />);
    expect(mockSetSchema).toHaveBeenCalledWith([]);
  });

  // --- Sidebar profiler/codegen/testdata callbacks ---
  test("Sidebar onProfileTable opens profiler", () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId("dataprofiler")).toBeNull();
    const fn = capturedSidebarProps.onProfileTable as (name: string) => void;
    act(() => fn("users"));
    expect(queryByTestId("dataprofiler")).not.toBeNull();
  });

  test("Sidebar onGenerateCode opens code generator", () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId("codegenerator")).toBeNull();
    const fn = capturedSidebarProps.onGenerateCode as (name: string) => void;
    act(() => fn("users"));
    expect(queryByTestId("codegenerator")).not.toBeNull();
  });

  test("Sidebar onGenerateTestData opens test data generator", () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId("testdatagenerator")).toBeNull();
    const fn = capturedSidebarProps.onGenerateTestData as (name: string) => void;
    act(() => fn("users"));
    expect(queryByTestId("testdatagenerator")).not.toBeNull();
  });

  test("Sidebar onCreateTableClick opens create table modal", () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId("createtablemodal")).toBeNull();
    const fn = capturedSidebarProps.onCreateTableClick as () => void;
    act(() => fn());
    expect(queryByTestId("createtablemodal")).not.toBeNull();
  });

  test("Sidebar onShowDiagram opens schema diagram", () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId("schemadiagram")).toBeNull();
    const fn = capturedSidebarProps.onShowDiagram as () => void;
    act(() => fn());
    expect(queryByTestId("schemadiagram")).not.toBeNull();
  });

  // --- MobileHeader callbacks ---
  test("MobileHeader onSaveQuery opens save modal", () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId("savequerymodal")).toBeNull();
    const fn = capturedMobileHeaderProps.onSaveQuery as () => void;
    act(() => fn());
    expect(queryByTestId("savequerymodal")).not.toBeNull();
  });

  test("MobileHeader onClearQuery clears current tab query", () => {
    render(<Studio />);
    const fn = capturedMobileHeaderProps.onClearQuery as () => void;
    act(() => fn());
    expect(mockUpdateCurrentTab).toHaveBeenCalledWith({ query: "" });
  });

  test("MobileHeader onExecuteQuery delegates to executeQuery", () => {
    render(<Studio />);
    const fn = capturedMobileHeaderProps.onExecuteQuery as () => void;
    act(() => fn());
    expect(mockExecuteQuery).toHaveBeenCalled();
  });

  test('MobileHeader onBeginTransaction calls handleTransaction("begin")', () => {
    render(<Studio />);
    const fn = capturedMobileHeaderProps.onBeginTransaction as () => void;
    act(() => fn());
    expect(mockHandleTransaction).toHaveBeenCalledWith("begin");
  });

  test('MobileHeader onCommitTransaction calls handleTransaction("commit")', () => {
    render(<Studio />);
    const fn = capturedMobileHeaderProps.onCommitTransaction as () => void;
    act(() => fn());
    expect(mockHandleTransaction).toHaveBeenCalledWith("commit");
  });

  test('MobileHeader onRollbackTransaction calls handleTransaction("rollback")', () => {
    render(<Studio />);
    const fn = capturedMobileHeaderProps.onRollbackTransaction as () => void;
    act(() => fn());
    expect(mockHandleTransaction).toHaveBeenCalledWith("rollback");
  });

  test("MobileHeader onTogglePlayground toggles playground mode", () => {
    render(<Studio />);
    const fn = capturedMobileHeaderProps.onTogglePlayground as () => void;
    act(() => fn());
    // playgroundMode is false by default → setPlaygroundMode(!false) = setPlaygroundMode(true)
    expect(mockSetPlaygroundMode).toHaveBeenCalledWith(true);
  });

  test("MobileHeader onToggleEditing enables editing when disabled", () => {
    render(<Studio />);
    const fn = capturedMobileHeaderProps.onToggleEditing as () => void;
    act(() => fn());
    expect(mockSetEditingEnabled).toHaveBeenCalledWith(true);
    expect(mockHandleDiscardChanges).not.toHaveBeenCalled();
  });

  test("MobileHeader onToggleEditing disables editing and discards changes when enabled", () => {
    editingOverride = { editingEnabled: true };
    render(<Studio />);
    const fn = capturedMobileHeaderProps.onToggleEditing as () => void;
    act(() => fn());
    expect(mockSetEditingEnabled).toHaveBeenCalledWith(false);
    expect(mockHandleDiscardChanges).toHaveBeenCalled();
  });

  test("MobileHeader onImport opens import modal", () => {
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId("dataimportmodal")).toBeNull();
    const fn = capturedMobileHeaderProps.onImport as () => void;
    act(() => fn());
    expect(queryByTestId("dataimportmodal")).not.toBeNull();
  });

  test("MobileHeader onExplain calls executeQuery with explain flag", () => {
    render(<Studio />);
    const fn = capturedMobileHeaderProps.onExplain as () => void;
    act(() => fn());
    expect(mockExecuteQuery).toHaveBeenCalledWith(undefined, undefined, true);
  });

  // --- Connection-change effect: setTabs updater ---
  test("connection-change effect retypes existing tabs via setTabs updater", () => {
    connMgrOverride = { activeConnection: pgConn };
    render(<Studio />);
    expect(mockSetTabs).toHaveBeenCalled();
    const updater = (mockSetTabs.mock.calls[0] as unknown[])[0] as (prev: unknown[]) => Array<{ type: string }>;
    const result = updater([
      { id: "tab-1", name: "Query 1", query: "SELECT 1", result: null, isExecuting: false, type: "mongodb" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("sql");
  });

  // --- exportResults sql-ddl type mapping ---
  test("exportResults sql-ddl maps boolean and date sample values", async () => {
    tabMgrOverride = {
      currentTab: {
        id: "tab-1",
        name: "Users",
        query: "SELECT 1",
        result: {
          rows: [{ active: true, created: new Date("2026-01-01T00:00:00Z") }],
          fields: ["active", "created"],
          rowCount: 1,
          executionTime: 5,
        },
        isExecuting: false,
        type: "sql",
      },
    };
    render(<Studio />);
    const exportFn = capturedBottomPanelProps.onExportResults as (format: string) => void;
    act(() => exportFn("sql-ddl"));
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
    const blob = (mockCreateObjectURL.mock.calls[0] as unknown[])[0] as Blob;
    const content = await blob.text();
    expect(content).toContain("active BOOLEAN");
    expect(content).toContain("created TIMESTAMP");
  });

  // --- Mobile: database tab ---
  test("mobile database tab lists connections and selecting one returns to editor", () => {
    connMgrOverride = { connections: [pgConn] };
    const { queryByTestId } = render(<Studio />);
    expect(queryByTestId("connections-list")).toBeNull();
    const onTabChange = capturedMobileNavProps.onTabChange as (tab: string) => void;
    act(() => onTabChange("database"));
    expect(queryByTestId("connections-list")).not.toBeNull();
    const addFn = capturedConnectionsListProps.onAddConnection as () => void;
    act(() => addFn());
    expect(capturedConnectionModalProps.isOpen).toBe(true);
    const selectFn = capturedConnectionsListProps.onSelectConnection as (c: unknown) => void;
    act(() => selectFn(pgConn));
    expect(mockSetActiveConnection).toHaveBeenCalledWith(pgConn);
    expect(queryByTestId("connections-list")).toBeNull();
  });

  test("mobile database tab Add button opens connection modal", () => {
    const { getByText, queryByTestId } = render(<Studio />);
    const onTabChange = capturedMobileNavProps.onTabChange as (tab: string) => void;
    act(() => onTabChange("database"));
    fireEvent.click(getByText(/Add/));
    expect(queryByTestId("connection-modal")).not.toBeNull();
  });

  // --- Mobile: schema tab ---
  test("mobile schema tab shows empty state without a connection", () => {
    const { queryByTestId, getByText } = render(<Studio />);
    const onTabChange = capturedMobileNavProps.onTabChange as (tab: string) => void;
    act(() => onTabChange("schema"));
    expect(queryByTestId("schema-explorer")).toBeNull();
    expect(getByText("Select a connection first")).not.toBeNull();
  });

  test("mobile schema tab table click returns to editor", () => {
    connMgrOverride = { activeConnection: pgConn, connections: [pgConn] };
    const { queryByTestId } = render(<Studio />);
    const onTabChange = capturedMobileNavProps.onTabChange as (tab: string) => void;
    act(() => onTabChange("schema"));
    expect(queryByTestId("schema-explorer")).not.toBeNull();
    const tableClick = capturedSchemaExplorerProps.onTableClick as (name: string) => void;
    act(() => tableClick("users"));
    expect(mockHandleTableClick).toHaveBeenCalledWith("users", mockExecuteQuery);
    expect(queryByTestId("schema-explorer")).toBeNull();
  });

  test("mobile schema tab generate select returns to editor", () => {
    connMgrOverride = { activeConnection: pgConn };
    const { queryByTestId } = render(<Studio />);
    act(() => (capturedMobileNavProps.onTabChange as (tab: string) => void)("schema"));
    const genFn = capturedSchemaExplorerProps.onGenerateSelect as (name: string) => void;
    act(() => genFn("users"));
    expect(mockHandleGenerateSelect).toHaveBeenCalledWith("users");
    expect(queryByTestId("schema-explorer")).toBeNull();
  });

  test("mobile schema tab table tool callbacks open modals and maintenance", () => {
    connMgrOverride = { activeConnection: pgConn };
    const { queryByTestId } = render(<Studio />);
    act(() => (capturedMobileNavProps.onTabChange as (tab: string) => void)("schema"));
    act(() => (capturedSchemaExplorerProps.onCreateTableClick as () => void)());
    expect(queryByTestId("createtablemodal")).not.toBeNull();
    act(() => (capturedSchemaExplorerProps.onProfileTable as (n: string) => void)("users"));
    expect(queryByTestId("dataprofiler")).not.toBeNull();
    act(() => (capturedSchemaExplorerProps.onGenerateCode as (n: string) => void)("users"));
    expect(queryByTestId("codegenerator")).not.toBeNull();
    act(() => (capturedSchemaExplorerProps.onGenerateTestData as (n: string) => void)("users"));
    expect(queryByTestId("testdatagenerator")).not.toBeNull();
    act(() => (capturedSchemaExplorerProps.onOpenMaintenance as () => void)());
    expect(mockRouterPush).toHaveBeenCalledWith("/admin/operations");
  });

  // --- QueryToolbar execution/transaction callbacks ---
  test("QueryToolbar onExecuteQuery delegates to executeQuery", () => {
    render(<Studio />);
    const fn = capturedQueryToolbarProps.onExecuteQuery as () => void;
    act(() => fn());
    expect(mockExecuteQuery).toHaveBeenCalled();
  });

  test("QueryToolbar onCancelQuery delegates to cancelQuery", () => {
    render(<Studio />);
    const fn = capturedQueryToolbarProps.onCancelQuery as () => void;
    act(() => fn());
    expect(mockCancelQuery).toHaveBeenCalled();
  });

  test("QueryToolbar transaction callbacks delegate to handleTransaction", () => {
    render(<Studio />);
    act(() => (capturedQueryToolbarProps.onBeginTransaction as () => void)());
    expect(mockHandleTransaction).toHaveBeenCalledWith("begin");
    act(() => (capturedQueryToolbarProps.onCommitTransaction as () => void)());
    expect(mockHandleTransaction).toHaveBeenCalledWith("commit");
    act(() => (capturedQueryToolbarProps.onRollbackTransaction as () => void)());
    expect(mockHandleTransaction).toHaveBeenCalledWith("rollback");
  });

  test("QueryToolbar onTogglePlayground toggles playground mode", () => {
    render(<Studio />);
    const fn = capturedQueryToolbarProps.onTogglePlayground as () => void;
    act(() => fn());
    expect(mockSetPlaygroundMode).toHaveBeenCalledWith(true);
  });

  // --- QueryEditor callbacks ---
  test("QueryEditor onContentChange updates the owning tab by id", () => {
    render(<Studio />);
    const fn = capturedQueryEditorProps.onContentChange as (val: string) => void;
    act(() => fn("SELECT 2"));
    expect(mockUpdateTabById).toHaveBeenCalledWith("tab-1", { query: "SELECT 2" });
  });

  test("QueryEditor onExplain executes explain query", () => {
    render(<Studio />);
    const fn = capturedQueryEditorProps.onExplain as () => void;
    act(() => fn());
    expect(mockExecuteQuery).toHaveBeenCalledWith(undefined, undefined, true);
  });

  // =========================================================================
  // Agent rail (#329 T10a)
  // =========================================================================

  /**
   * The gate is the whole point of this group: with the runtime off — which is the
   * default, and what every existing deployment is — the shell must contain no agent
   * surface and must ask the agent routes for nothing. The capability hook is real
   * here; only the server's answer is stubbed.
   */
  function mockAgentConfig(enabled: boolean) {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/agent/config")) {
        return new Response(JSON.stringify({ enabled }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  const managedConn = { ...pgConn, id: "seed:sales", name: "Sales", managed: true, seedId: "sales" };

  test("with the agent runtime off there is no rail and no agent run is asked for", async () => {
    const fetchMock = mockAgentConfig(false);
    const { queryByTestId } = render(<Studio />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    expect(queryByTestId("agent-rail")).toBeNull();
    // Every agent URL, not just today's run routes: a leak to a route added later
    // would otherwise pass this test vacuously. The discovery probe is the one
    // agent request a disabled server is allowed to receive.
    const requested = fetchMock.mock.calls.map(([input]) => String(input));
    expect(requested.filter((url) => url.includes("/api/agent/") && !url.includes("/api/agent/config"))).toEqual([]);
    expect(capturedMobileNavProps.onOpenAgent).toBeUndefined();
  });

  test("with the agent runtime on the rail renders in the shell", async () => {
    mockAgentConfig(true);
    const { findByTestId } = render(<Studio />);

    expect(await findByTestId("agent-rail")).toBeTruthy();
  });

  test("the rail is handed the active connection as the id a resumed run can re-resolve", async () => {
    mockAgentConfig(true);
    connMgrOverride = { activeConnection: managedConn, connections: [managedConn] };
    const { findByTestId } = render(<Studio />);
    await findByTestId("agent-rail");

    expect(capturedAgentRailProps.connectionId).toBe("seed:sales");
    expect(capturedAgentRailProps.connectionName).toBe("Sales");
  });

  // A connection that exists only in this browser cannot be rebuilt by the process
  // that resumes a run, so the rail is told there is no id rather than being handed
  // one the server would refuse.
  test("a browser-only connection reaches the rail as unresolvable", async () => {
    mockAgentConfig(true);
    connMgrOverride = { activeConnection: pgConn, connections: [pgConn] };
    const { findByTestId } = render(<Studio />);
    await findByTestId("agent-rail");

    expect(capturedAgentRailProps.connectionId).toBeNull();
    expect(capturedAgentRailProps.connectionName).toBe("TestPG");
  });

  // The two connections a default deployment ships are editable seed copies, so this
  // is the path that decides whether the rail can start anything at all out of the
  // box.
  const servedSeed = {
    ...pgConn,
    id: "seed:sample",
    name: "Sample",
    managed: false,
    seedId: "sample",
    createdAt: "1970-01-01T00:00:00.000Z",
  };
  const seedCopy = { ...servedSeed, createdAt: new Date(0) };

  test("an untouched copy of an editable seed reaches the rail as startable", async () => {
    mockAgentConfig(true);
    connMgrOverride = { activeConnection: seedCopy, connections: [seedCopy], servedSeeds: [servedSeed] };
    const { findByTestId } = render(<Studio />);
    await findByTestId("agent-rail");

    expect(capturedAgentRailProps.connectionId).toBe("seed:sample");
  });

  test("a seed copy edited to reach another database reaches the rail as unresolvable", async () => {
    mockAgentConfig(true);
    const edited = { ...seedCopy, database: "somewhere-else" };
    connMgrOverride = { activeConnection: edited, connections: [edited], servedSeeds: [servedSeed] };
    const { findByTestId } = render(<Studio />);
    await findByTestId("agent-rail");

    expect(capturedAgentRailProps.connectionId).toBeNull();
  });

  test("with no connection selected the rail is told so", async () => {
    mockAgentConfig(true);
    connMgrOverride = { activeConnection: null, connections: [] };
    const { findByTestId } = render(<Studio />);
    await findByTestId("agent-rail");

    expect(capturedAgentRailProps.connectionId).toBeNull();
    expect(capturedAgentRailProps.connectionName).toBeNull();
  });

  // What a long read costs is not the same fact on every engine, and the rail says
  // SQLite's where a user consents to auto-execute — so the shell has to tell it
  // which engine this connection speaks.
  test("the rail is told which engine the connection speaks", async () => {
    mockAgentConfig(true);
    connMgrOverride = { activeConnection: managedConn, connections: [managedConn] };
    const { findByTestId } = render(<Studio />);
    await findByTestId("agent-rail");

    expect(capturedAgentRailProps.connectionType).toBe("postgres");
  });

  test("with no connection selected the rail is told there is no engine either", async () => {
    mockAgentConfig(true);
    connMgrOverride = { activeConnection: null, connections: [] };
    const { findByTestId } = render(<Studio />);
    await findByTestId("agent-rail");

    expect(capturedAgentRailProps.connectionType).toBeNull();
  });

  /**
   * The handover the answer's `auto-executed` outcome names (§2.1 of
   * `docs/AGENT_ANALYST_DESIGN.md`). The shell does both halves — the statement goes
   * into the editor AND is run there — through the hook's own capped entry point,
   * which is what keeps the run's answer off the tab's widened execution options.
   */
  test("a statement the run handed over is shown in the editor and run through the run's own route", async () => {
    mockAgentConfig(true);
    const { findByTestId } = render(<Studio />);
    await findByTestId("agent-rail");

    act(() => (capturedAgentRailProps.onRunStatement as (sql: string, runId: string) => void)("SELECT 1", "arun_1"));

    expect(mockUpdateCurrentTab).toHaveBeenCalledWith({ query: "SELECT 1" });
    // The RUN is what is executed against, not the text (#373 review): the text is
    // put in the editor so the user can read what is running.
    expect(mockExecuteHandedOverStatement).toHaveBeenCalledWith("arun_1", "SELECT 1");
    // Never the general entry point: that one posts to the editor's read-WRITE route,
    // which is the boundary this hand-over exists to keep.
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  test("a statement the user applies is placed and not run", async () => {
    mockAgentConfig(true);
    const { findByTestId } = render(<Studio />);
    await findByTestId("agent-rail");

    act(() => (capturedAgentRailProps.onApplyStatement as (sql: string) => void)("SELECT 2"));

    expect(mockUpdateCurrentTab).toHaveBeenCalledWith({ query: "SELECT 2" });
    expect(mockExecuteHandedOverStatement).not.toHaveBeenCalled();
  });

  test("below md the mobile nav opens the rail as a sheet", async () => {
    mockAgentConfig(true);
    const { findByTestId } = render(<Studio />);
    await findByTestId("agent-rail");

    expect(capturedAgentRailProps.sheetOpen).toBe(false);
    act(() => (capturedMobileNavProps.onOpenAgent as () => void)());
    expect(capturedAgentRailProps.sheetOpen).toBe(true);

    act(() => (capturedAgentRailProps.onSheetOpenChange as (open: boolean) => void)(false));
    expect(capturedAgentRailProps.sheetOpen).toBe(false);
  });

  /**
   * Who owns a prefill ask (#331 T1). The shell holds it because a shortcut can be
   * anywhere in the shell while the rail is ONE instance behind both presentations,
   * and the rail applies it as a prop — the direction `sheetOpen` already runs in.
   *
   * Asserted against the stubbed hook's sentinel rather than against null, because
   * null is what a Studio that dropped the hook entirely would also hand over — the
   * T1 adversarial review's point: deleting the import, the call and the prop kept
   * the old assertion green. T2 and T3 hand `requestPrefill` to the legacy AI entry
   * points; what this pins is that whatever the shell's holder says is what the one
   * rail instance is given.
   */
  test("the shell owns the prefill request and hands it to the one rail instance", async () => {
    mockAgentConfig(true);
    const { findByTestId } = render(<Studio />);
    await findByTestId("agent-rail");

    expect(capturedAgentRailProps.prefill).toBe(PREFILL_SENTINEL);
  });

  // =========================================================================
  // The two standalone AI entry points, rewired to the rail (#331 T3)
  // =========================================================================

  /**
   * The in-editor chat is gone, and the command palette item and mobile header
   * button that opened it now open the RAIL on the statement the editor holds.
   *
   * The statement is read from the tab the shell owns rather than from the editor
   * handle, and that tab is keystroke-current: "QueryEditor onContentChange updates
   * the owning tab by id" above pins the write, and `use-tab-manager` derives
   * `currentTab` from the tabs that write lands in.
   *
   * The breakpoint is driven through `window.matchMedia` rather than by mocking
   * `@/hooks/use-mobile`, because `isMobileViewport` reads the platform directly and
   * a module mock here would be process-wide.
   */
  function setViewportMobile(matches: boolean) {
    window.matchMedia = ((query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  }

  async function renderWithAgent(query: string) {
    mockAgentConfig(true);
    tabMgrOverride = {
      currentTab: { id: "tab-1", name: "Query 1", query, result: null, isExecuting: false, type: "sql" },
    };
    const view = render(<Studio />);
    await view.findByTestId("agent-rail");
    return view;
  }

  test("the palette's agent shortcut asks the rail about the statement the editor holds", async () => {
    await renderWithAgent("SELECT * FROM checkout");

    act(() => (capturedCommandPaletteProps.onAskAgent as () => void)());

    expect(mockRequestPrefill).toHaveBeenCalledTimes(1);
    expect(mockRequestPrefill.mock.calls[0]).toEqual(["investigation", "SELECT * FROM checkout"]);
  });

  /**
   * Investigation and NOT query-optimization, deliberately: the control being
   * replaced was a general assistant, and the optimizer's verifier requires a plan
   * comparison (`src/lib/agent/goal-verifier.ts`), so a run that perfectly explained
   * what the statement does would be recorded as not having answered.
   */
  test("the ask names the general workflow, not the optimizer", async () => {
    await renderWithAgent("SELECT 1");

    act(() => (capturedCommandPaletteProps.onAskAgent as () => void)());

    expect(mockRequestPrefill.mock.calls[0][0]).toBe("investigation");
  });

  test("the mobile header's agent shortcut makes the same ask", async () => {
    await renderWithAgent("SELECT * FROM checkout");

    act(() => (capturedMobileHeaderProps.onAskAgent as () => void)());

    expect(mockRequestPrefill.mock.calls[0]).toEqual(["investigation", "SELECT * FROM checkout"]);
  });

  /** Nothing is composed on the user's behalf — the objective is the statement. */
  test("the ask carries the statement and no prose invented around it", async () => {
    await renderWithAgent("  SELECT 1  ");

    act(() => (capturedMobileHeaderProps.onAskAgent as () => void)());

    expect(mockRequestPrefill.mock.calls[0][1]).toBe("SELECT 1");
  });

  test("an empty editor mints no ask", async () => {
    await renderWithAgent("   \n  ");

    act(() => (capturedCommandPaletteProps.onAskAgent as () => void)());
    act(() => (capturedMobileHeaderProps.onAskAgent as () => void)());

    expect(mockRequestPrefill).toHaveBeenCalledTimes(0);
  });

  test("below md an empty editor still opens the sheet", async () => {
    setViewportMobile(true);
    await renderWithAgent("");

    expect(capturedAgentRailProps.sheetOpen).toBe(false);
    act(() => (capturedCommandPaletteProps.onAskAgent as () => void)());

    expect(capturedAgentRailProps.sheetOpen).toBe(true);
  });

  test("below md the mobile header's shortcut opens the sheet too", async () => {
    setViewportMobile(true);
    await renderWithAgent("");

    act(() => (capturedMobileHeaderProps.onAskAgent as () => void)());

    expect(capturedAgentRailProps.sheetOpen).toBe(true);
  });

  /**
   * Above `md` the rail IS the panel, so there is nothing to open — and setting the
   * flag anyway would arm a sheet that pops open the first time the window narrows,
   * the R1 defect `AgentRail`'s prefill comment records.
   */
  test("above md an empty editor opens no sheet", async () => {
    setViewportMobile(false);
    await renderWithAgent("");

    act(() => (capturedCommandPaletteProps.onAskAgent as () => void)());

    expect(capturedAgentRailProps.sheetOpen).toBe(false);
  });

  /** With an ask to apply, opening the sheet is the seam's job, not the shell's. */
  test("an ask leaves the sheet to the seam that applies it", async () => {
    setViewportMobile(true);
    await renderWithAgent("SELECT 1");

    act(() => (capturedMobileHeaderProps.onAskAgent as () => void)());

    expect(mockRequestPrefill).toHaveBeenCalledTimes(1);
    expect(capturedAgentRailProps.sheetOpen).toBe(false);
  });

  test("with the agent runtime off neither shortcut is offered", async () => {
    const fetchMock = mockAgentConfig(false);
    render(<Studio />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    expect(capturedCommandPaletteProps.onAskAgent).toBeUndefined();
    expect(capturedMobileHeaderProps.onAskAgent).toBeUndefined();
  });

  // =========================================================================
  // Agent artifact hydration (#329 T11)
  // =========================================================================

  /**
   * What the shell does with what a run produced: it puts the rows into the bottom
   * panel that already renders rows, and a drafted statement into the editor that
   * already holds statements. Both only when the user asks — the rail hands over
   * identifiers, and nothing here reaches for a result on its own.
   */
  function mockAgentArtifactFetch(status: number, body: unknown) {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/agent/config")) return new Response(JSON.stringify({ enabled: true }), { status: 200 });
      if (url.includes("/artifacts/")) return new Response(JSON.stringify(body), { status });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  const ARTIFACT_BODY = {
    runId: "arun_1",
    correlationId: "corr_9",
    operationId: "sql.query.read",
    summary: { rowCount: 1, columnNames: ["id"], elapsedMs: 4 },
    result: { rows: [{ id: 7 }], fields: ["id"], rowCount: 1, executionTime: 4 },
  };

  test("nothing is hydrated until the user asks for a result", async () => {
    const fetchMock = mockAgentArtifactFetch(200, ARTIFACT_BODY);
    const { findByTestId } = render(<Studio />);
    await findByTestId("agent-rail");

    expect(capturedBottomPanelProps.agentArtifact ?? null).toBeNull();
    expect(fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("/artifacts/"))).toEqual(
      [],
    );
  });

  test("showing a result hydrates the bottom panel and switches to the surface it belongs in", async () => {
    const fetchMock = mockAgentArtifactFetch(200, ARTIFACT_BODY);
    const { findByTestId } = render(<Studio />);
    await findByTestId("agent-rail");

    await act(async () => {
      await (capturedAgentRailProps.onShowArtifact as (ref: { runId: string; correlationId: string }) => Promise<void>)(
        { runId: "arun_1", correlationId: "corr_9" },
      );
    });

    const requested = fetchMock.mock.calls.map(([input]) => String(input));
    expect(requested).toContain("/api/agent/runs/arun_1/artifacts/corr_9");
    const hydrated = capturedBottomPanelProps.agentArtifact as { result: { rows: unknown[] }; runId: string };
    expect(hydrated.runId).toBe("arun_1");
    expect(hydrated.result.rows).toEqual([{ id: 7 }]);
    expect(mockSetBottomPanelMode).toHaveBeenCalledWith("results");
  });

  test("an answer composed as a chart opens the charts surface, carrying the run's own chart", async () => {
    // The rail hands over the presentation the run RECORDED, and the shell switches
    // to the surface the hydration named. Nothing in this path looks at the rows to
    // decide that a chart would suit them.
    const spec = { type: "bar", x: "id", y: ["total"], caption: "Total by id." };
    mockAgentArtifactFetch(200, ARTIFACT_BODY);
    const { findByTestId } = render(<Studio />);
    await findByTestId("agent-rail");

    await act(async () => {
      await (
        capturedAgentRailProps.onShowArtifact as (ref: {
          runId: string;
          correlationId: string;
          chartSpec: unknown;
        }) => Promise<void>
      )({ runId: "arun_1", correlationId: "corr_9", chartSpec: spec });
    });

    expect(mockSetBottomPanelMode).toHaveBeenCalledWith("charts");
    const hydrated = capturedBottomPanelProps.agentArtifact as { surface: string; chartSpec: unknown };
    expect(hydrated.surface).toBe("charts");
    expect(hydrated.chartSpec).toEqual(spec);
  });

  test("a released result is reported to the user rather than hydrated as empty", async () => {
    mockAgentArtifactFetch(410, { error: "This result is no longer held.", reason: "released" });
    const { findByTestId } = render(<Studio />);
    await findByTestId("agent-rail");

    await act(async () => {
      await (capturedAgentRailProps.onShowArtifact as (ref: { runId: string; correlationId: string }) => Promise<void>)(
        { runId: "arun_1", correlationId: "corr_9" },
      );
    });

    expect(capturedBottomPanelProps.agentArtifact ?? null).toBeNull();
    expect(mockToast).toHaveBeenCalled();
    const reported = mockToast.mock.calls.at(-1) as unknown as [{ description?: string }] | undefined;
    expect(String(reported?.[0]?.description)).toContain("no longer held");
  });

  test("the result shown is the one asked for last, not the one that answered last", async () => {
    let releaseSlow: (() => void) | null = null;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/agent/config")) return new Response(JSON.stringify({ enabled: true }), { status: 200 });
      if (url.includes("corr_slow")) {
        await new Promise<void>((resolve) => {
          releaseSlow = resolve;
        });
        return new Response(JSON.stringify({ ...ARTIFACT_BODY, correlationId: "corr_slow" }), { status: 200 });
      }
      return new Response(JSON.stringify(ARTIFACT_BODY), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { findByTestId } = render(<Studio />);
    await findByTestId("agent-rail");
    const show = capturedAgentRailProps.onShowArtifact as (ref: {
      runId: string;
      correlationId: string;
    }) => Promise<void>;

    let slow: Promise<void> = Promise.resolve();
    await act(async () => {
      slow = show({ runId: "arun_1", correlationId: "corr_slow" });
      await show({ runId: "arun_1", correlationId: "corr_9" });
    });
    await act(async () => {
      (releaseSlow as unknown as () => void)();
      await slow;
    });

    expect((capturedBottomPanelProps.agentArtifact as { correlationId: string }).correlationId).toBe("corr_9");
  });

  test("a result dismissed while it was still being fetched does not arrive afterwards", async () => {
    // The ordinary sequence that produces this: click Show, then run a query. The
    // query's result dismisses, and the answer to the earlier click lands after it.
    let releaseSlow: (() => void) | null = null;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/agent/config")) return new Response(JSON.stringify({ enabled: true }), { status: 200 });
      await new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      return new Response(JSON.stringify(ARTIFACT_BODY), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { findByTestId } = render(<Studio />);
    await findByTestId("agent-rail");
    const show = capturedAgentRailProps.onShowArtifact as (ref: {
      runId: string;
      correlationId: string;
    }) => Promise<void>;

    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = show({ runId: "arun_1", correlationId: "corr_9" });
    });
    act(() => (capturedBottomPanelProps.onDismissAgentArtifact as () => void)());

    await act(async () => {
      (releaseSlow as unknown as () => void)();
      await pending;
    });

    expect(capturedBottomPanelProps.agentArtifact ?? null).toBeNull();
    // And the panel is not switched under the user by an answer they walked away from.
    expect(mockSetBottomPanelMode).not.toHaveBeenCalledWith("results");
  });

  test("running an explain takes the panel back too", async () => {
    // An explain run stores its plan and deliberately leaves `result` alone
    // (`use-query-execution.ts`), so the tab's result identity does not change and the
    // plan is the only thing that says the user has done something of their own.
    mockAgentArtifactFetch(200, ARTIFACT_BODY);
    const { findByTestId, rerender } = render(<Studio />);
    await findByTestId("agent-rail");

    await act(async () => {
      await (capturedAgentRailProps.onShowArtifact as (ref: { runId: string; correlationId: string }) => Promise<void>)(
        { runId: "arun_1", correlationId: "corr_9" },
      );
    });
    expect(capturedBottomPanelProps.agentArtifact).not.toBeNull();

    tabMgrOverride = {
      currentTab: {
        id: "tab-1",
        name: "Query 1",
        query: "SELECT 1",
        result: null,
        explainPlan: { format: "postgres-json", raw: [{ Plan: { "Node Type": "Seq Scan" } }] },
        isExecuting: false,
        type: "sql",
      },
    };
    await act(async () => {
      rerender(<Studio />);
    });

    expect(capturedBottomPanelProps.agentArtifact ?? null).toBeNull();
  });

  test("dismissing a hydrated result takes it away again", async () => {
    mockAgentArtifactFetch(200, ARTIFACT_BODY);
    const { findByTestId } = render(<Studio />);
    await findByTestId("agent-rail");

    await act(async () => {
      await (capturedAgentRailProps.onShowArtifact as (ref: { runId: string; correlationId: string }) => Promise<void>)(
        { runId: "arun_1", correlationId: "corr_9" },
      );
    });
    expect(capturedBottomPanelProps.agentArtifact).not.toBeNull();

    act(() => (capturedBottomPanelProps.onDismissAgentArtifact as () => void)());
    expect(capturedBottomPanelProps.agentArtifact ?? null).toBeNull();
  });

  /*
    A hydrated artifact is a view of somebody else's result, and it must not survive
    the user doing their own work: without this, running a query would store rows the
    panel never showed, because the agent's rows would still be what it renders.
  */
  test("the user's own result takes the panel back", async () => {
    mockAgentArtifactFetch(200, ARTIFACT_BODY);
    const { findByTestId, rerender } = render(<Studio />);
    await findByTestId("agent-rail");

    await act(async () => {
      await (capturedAgentRailProps.onShowArtifact as (ref: { runId: string; correlationId: string }) => Promise<void>)(
        { runId: "arun_1", correlationId: "corr_9" },
      );
    });
    expect(capturedBottomPanelProps.agentArtifact).not.toBeNull();

    // What the execution hook does when a query finishes: the tab carries a new result.
    tabMgrOverride = {
      currentTab: {
        id: "tab-1",
        name: "Query 1",
        query: "SELECT 1",
        result: { rows: [{ id: 1 }], fields: ["id"], rowCount: 1, executionTime: 3 },
        isExecuting: false,
        type: "sql",
      },
    };
    await act(async () => {
      rerender(<Studio />);
    });

    expect(capturedBottomPanelProps.agentArtifact ?? null).toBeNull();
  });

  test("switching tabs takes it away too", async () => {
    mockAgentArtifactFetch(200, ARTIFACT_BODY);
    const { findByTestId, rerender } = render(<Studio />);
    await findByTestId("agent-rail");

    await act(async () => {
      await (capturedAgentRailProps.onShowArtifact as (ref: { runId: string; correlationId: string }) => Promise<void>)(
        { runId: "arun_1", correlationId: "corr_9" },
      );
    });
    expect(capturedBottomPanelProps.agentArtifact).not.toBeNull();

    tabMgrOverride = { activeTabId: "tab-2" };
    await act(async () => {
      rerender(<Studio />);
    });

    expect(capturedBottomPanelProps.agentArtifact ?? null).toBeNull();
  });

  test("applying a drafted statement reaches the editor, and only the editor", async () => {
    mockAgentConfig(true);
    const { findByTestId } = render(<Studio />);
    await findByTestId("agent-rail");

    act(() => (capturedAgentRailProps.onApplyStatement as (sql: string) => void)("SELECT count(*) FROM orders"));

    expect(mockUpdateCurrentTab).toHaveBeenCalledWith({ query: "SELECT count(*) FROM orders" });
    // Applying is not executing: nothing runs until the user runs it.
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });
});
