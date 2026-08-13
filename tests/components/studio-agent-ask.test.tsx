import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test";
import { render, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

/**
 * The composed claim behind #331 T3: selecting the palette's agent item puts THE
 * STATEMENT THE EDITOR HOLDS into the rail, as an investigation.
 *
 * Every link in that path already had a test and the path itself had none.
 * tests/components/Studio.test.tsx cannot host this one: it stubs
 * `@/components/agent/use-agent-prefill` with a sentinel (deliberately — that stub is
 * what proves the rail is handed the HOOK's ask rather than a hard-coded null), it
 * stubs `@/components/CommandPalette`, and it overrides `use-tab-manager`. `mock.module`
 * is process-wide and those stubs are registered at module scope, so a test in that
 * file cannot see the real hook, the real palette item, or the real tab. Hence a second
 * file, in its own isolation group (tests/run-components.sh), which mocks LESS:
 *
 *   real: the command palette and its item, `use-tab-manager`, `use-agent-prefill`
 *         (so the id minting and the objective clamp actually run), and Studio's own
 *         wiring between them
 *   mocked: `AgentRail`, so what the rail is handed can be read; `QueryEditor`, whose
 *         Monaco instance no test drives — its `onContentChange` prop is the same seam
 *         a keystroke arrives on; and the shell's other children and data hooks, which
 *         this path does not involve.
 *
 * What is still assumed rather than proven: that Monaco calls `onContentChange`, which
 * tests/components/QueryEditor.test.tsx owns, and that the rail applies the prefill it
 * is handed, which tests/components/agent/AgentRail.test.tsx owns.
 */

// ---- Prop capture ----
let capturedQueryEditorProps: Record<string, unknown> = {};
let capturedAgentRailProps: Record<string, unknown> = {};
let originalFetch: typeof globalThis.fetch;

// ---- The cmdk primitive, mocked as tests/components/CommandPalette.test.tsx mocks it:
//      a library that needs a real layout engine, not a decision of ours. ----
mock.module("cmdk", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  const Command = React.forwardRef(({ children, ...props }: Record<string, unknown>, ref: React.Ref<HTMLElement>) =>
    React.createElement("div", { ...props, ref, "data-testid": "command" }, children),
  );
  Command.displayName = "Command";

  const CommandInput = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<HTMLElement>) =>
    React.createElement("input", { ...props, ref, "data-testid": "command-input" }),
  );
  CommandInput.displayName = "CommandInput";
  Command.Input = CommandInput;

  const CommandList = ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("div", { ...props, "data-testid": "command-list" }, children);
  CommandList.displayName = "CommandList";
  Command.List = CommandList;

  const CommandEmpty = ({ children }: Record<string, unknown>) =>
    React.createElement("div", { "data-testid": "command-empty" }, children);
  CommandEmpty.displayName = "CommandEmpty";
  Command.Empty = CommandEmpty;

  const CommandGroup = ({ children, heading, ...props }: Record<string, unknown>) =>
    React.createElement(
      "div",
      { ...props, "data-testid": `command-group-${heading}` },
      React.createElement("div", null, heading),
      children,
    );
  CommandGroup.displayName = "CommandGroup";
  Command.Group = CommandGroup;

  const CommandItem = ({ children, onSelect, ...props }: Record<string, unknown>) =>
    React.createElement(
      "div",
      { ...props, onClick: onSelect, role: "option", "data-testid": "command-item" },
      children,
    );
  CommandItem.displayName = "CommandItem";
  Command.Item = CommandItem;

  const CommandSeparator = () => null;
  CommandSeparator.displayName = "CommandSeparator";
  Command.Separator = CommandSeparator;

  return { Command };
});

// ---- Data hooks this path does not involve ----

mock.module("@/hooks/use-auth", () => ({
  useAuth: mock(() => ({
    user: { username: "admin", role: "admin" },
    isAdmin: true,
    handleLogout: mock(() => {}),
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
    setConnections: mock(() => {}),
    setActiveConnection: mock(() => {}),
    setSchema: mock(() => {}),
    fetchSchema: mock(() => {}),
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
      },
      labels: {
        entityName: "Table",
        entitiesName: "Tables",
        selectAction: "SELECT * FROM",
        searchPlaceholder: "Search...",
        editorLanguage: "sql",
      },
    },
  })),
}));

mock.module("@/hooks/use-transaction-control", () => ({
  useTransactionControl: mock(() => ({
    transactionActive: false,
    playgroundMode: false,
    handleTransaction: mock(() => {}),
    setPlaygroundMode: mock(() => {}),
    resetTransactionState: mock(() => {}),
  })),
}));

mock.module("@/hooks/use-query-execution", () => ({
  useQueryExecution: mock(() => ({
    bottomPanelMode: "results",
    setBottomPanelMode: mock(() => {}),
    historyKey: 0,
    executeQuery: mock(() => {}),
    cancelQuery: mock(() => {}),
    forceExecuteQuery: mock(() => {}),
    safetyCheckQuery: null,
    setSafetyCheckQuery: mock(() => {}),
    unlimitedWarningOpen: false,
    setUnlimitedWarningOpen: mock(() => {}),
    handleUnlimitedQuery: mock(() => {}),
    handleLoadMore: mock(() => {}),
  })),
}));

mock.module("@/hooks/use-inline-editing", () => ({
  useInlineEditing: mock(() => ({
    editingEnabled: false,
    pendingChanges: [],
    setEditingEnabled: mock(() => {}),
    handleCellChange: mock(() => {}),
    handleApplyChanges: mock(() => {}),
    handleDiscardChanges: mock(() => {}),
  })),
}));

mock.module("@/hooks/use-toast", () => ({
  useToast: mock(() => ({ toast: mock(() => {}) })),
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

mock.module("@/lib/storage", () => ({
  storage: {
    saveConnection: mock(() => {}),
    getConnections: mock(() => [] as unknown[]),
    deleteConnection: mock(() => {}),
    saveQuery: mock(() => {}),
    getActiveConnectionId: mock(() => null),
    // Read by the REAL command palette when it opens.
    getSavedQueries: mock(() => [] as unknown[]),
    getHistory: mock(() => [] as unknown[]),
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
  saveMaskingConfig: mock(() => {}),
  shouldMask: mock(() => false),
  canToggleMasking: mock(() => true),
  detectSensitiveColumnsFromConfig: mock(() => new Set()),
  applyMaskingToRows: mock((rows: unknown) => rows),
}));

// ---- Children this path does not involve ----

mock.module("@/components/sidebar", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    Sidebar: () => React.createElement("div", { "data-testid": "sidebar" }),
    ConnectionsList: () => React.createElement("div", { "data-testid": "connections-list" }),
  };
});

mock.module("@/components/MobileNav", () => ({
  MobileNav: () => null,
}));

mock.module("@/components/schema-explorer", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return { SchemaExplorer: () => React.createElement("div", { "data-testid": "schema-explorer" }) };
});

mock.module("@/components/ConnectionModal", () => ({ ConnectionModal: () => null }));
mock.module("@/components/SchemaDiagram", () => ({ SchemaDiagram: () => null }));
mock.module("@/components/DataImportModal", () => ({ DataImportModal: () => null }));
mock.module("@/components/QuerySafetyDialog", () => ({ QuerySafetyDialog: () => null }));
mock.module("@/components/DataProfiler", () => ({ DataProfiler: () => null }));
mock.module("@/components/CodeGenerator", () => ({ CodeGenerator: () => null }));
mock.module("@/components/TestDataGenerator", () => ({ TestDataGenerator: () => null }));
mock.module("@/components/CreateTableModal", () => ({ CreateTableModal: () => null }));
mock.module("@/components/SaveQueryModal", () => ({ SaveQueryModal: () => null }));

mock.module("@/components/studio/index", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    StudioMobileHeader: () => React.createElement("div", { "data-testid": "mobile-header" }),
    StudioDesktopHeader: () => React.createElement("div", { "data-testid": "desktop-header" }),
    StudioTabBar: () => React.createElement("div", { "data-testid": "tab-bar" }),
    QueryToolbar: () => React.createElement("div", { "data-testid": "query-toolbar" }),
    BottomPanel: () => React.createElement("div", { "data-testid": "bottom-panel" }),
    BottomPanelMode: {},
  };
});

/**
 * Monaco is not driven by any test, so the editor is a stub — but its
 * `onContentChange` prop is captured, because that is the seam a keystroke arrives on
 * and the one this path reads the statement through.
 */
mock.module("@/components/QueryEditor", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  const QueryEditor = React.forwardRef((props: Record<string, unknown>, ref: unknown) => {
    capturedQueryEditorProps = props;
    return React.createElement("div", { "data-testid": "query-editor", ref });
  });
  QueryEditor.displayName = "QueryEditor";
  return { QueryEditor, QueryEditorRef: {} };
});

/** The one child whose props are the assertion. */
mock.module("@/components/agent/AgentRail", () => ({
  AgentRail: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    capturedAgentRailProps = props;
    return React.createElement("div", { "data-testid": "agent-rail" });
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

// Loaded after the registrations above, for the reason Studio.test.tsx records: a
// static import is hoisted and would resolve the real module tree first.
const { default: Studio } = await import("@/components/Studio");

const AGENT_ITEM = "Ask the agent about this query";

describe("Studio: the palette's agent item asks about the editor's statement (#331 T3)", () => {
  beforeEach(() => {
    capturedQueryEditorProps = {};
    capturedAgentRailProps = {};
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/agent/config")) {
        return new Response(JSON.stringify({ enabled: true }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  test("selecting it hands the rail the editor's statement as an investigation", async () => {
    const view = render(<Studio />);
    // The rail exists only once the runtime flag has been discovered.
    await view.findByTestId("agent-rail");
    expect(capturedAgentRailProps.prefill).toBeNull();

    // What the user typed, arriving the way Monaco delivers it.
    act(() => {
      (capturedQueryEditorProps.onContentChange as (value: string) => void)("SELECT * FROM checkout WHERE id = 1");
    });

    // The entry point: the palette, opened by its shortcut, and its item selected.
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    const item = await view.findByText(AGENT_ITEM);
    fireEvent.click(item.closest('[role="option"]')!);

    // The palette defers the action past its own close animation, so the ask lands a
    // turn later than the click.
    await waitFor(() => {
      expect(capturedAgentRailProps.prefill).not.toBeNull();
    });

    expect(capturedAgentRailProps.prefill).toEqual({
      id: 1,
      workflowType: "investigation",
      objective: "SELECT * FROM checkout WHERE id = 1",
    });
  });
});
