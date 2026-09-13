import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { mock } from "bun:test";
import React from "react";

/**
 * The standalone shell's half of the object source seam (#789 Phase 2).
 *
 * The contract, the route, the viewer and twelve providers landed before this, and none of
 * them was reachable by a person. This file drives the four things that make one: the row
 * menu's handler, the ACTIVATION split, the tab that carries the address, and the pane that
 * hands a document from the route to the viewer.
 *
 * What is REAL here and why. `useTabManager` is real, because the tab is the subject: a stub
 * would make every assertion below a statement about the stub, and Phase 1's own lesson is
 * that the seam between two mocked halves is exactly where a feature fails in a browser.
 * `StudioTabBar` is real for the same reason, reached by its own path so the mocked barrel
 * cannot replace it. `ObjectSourceView` is real, over a `@monaco-editor/react` double that
 * surfaces the value and the language, so the definition a reader would SEE is what is
 * asserted. And `globalThis.fetch` answers the source route, so the read is a real round trip
 * through `httpSourceReader` rather than an injected reader nothing in production uses.
 *
 * What is mocked is everything the shell mounts BESIDE this: the sidebar, the modals, the
 * bottom panel and the query editor. Their own suites cover them, and Studio's own suite
 * covers this shell's other decisions.
 */

let sourceReads: Array<{ path: unknown; kind: unknown }> = [];
let sourceAnswer: { status: number; body: unknown } = { status: 200, body: {} };
/** A source read that never settles, so a pane can be caught with NOTHING in hand. */
let sourceHangs = false;

const DEFINITION = "CREATE OR REPLACE FUNCTION app.order_total(integer)\n  RETURNS numeric AS $$ SELECT 1 $$;";

mock.module("@monaco-editor/react", () => ({
  default: function MockEditor(props: { value?: string; language?: string; options?: Record<string, unknown> }) {
    return (
      <textarea
        data-testid="source-editor"
        data-language={props.language}
        readOnly={props.options?.readOnly === true}
        value={props.value ?? ""}
        onChange={() => {}}
      />
    );
  },
  // `QueryEditor` configures the loader at module scope, and this file mocks that component
  // rather than the loader, so the export still has to exist for the module graph to resolve.
  loader: { init: () => Promise.resolve(), config: () => {}, __getMonacoInstance: () => null },
}));

let capturedSidebarProps: Record<string, unknown> = {};
let capturedPaletteProps: Record<string, unknown> = {};
let capturedMobileHeaderProps: Record<string, unknown> = {};
let capturedBottomPanelProps: Record<string, unknown> = {};
let capturedAgentRailProps: Record<string, unknown> = {};

/*
 * The agent rail is ABSENT unless the server says the runtime is on, so round 2's finding 1
 * cannot be reached at all with the real probe hook: `useAgentCapability` starts false and
 * this suite answers `{}` to every fetch it does not recognise. The rail's two statement
 * entry points are part of the same class as the palette's, so the flag is turned on for the
 * test that drives them and left off everywhere else, which keeps every other test in this
 * file mounting the shell it was written against.
 */
let agentCapabilityAnswer = false;
mock.module("@/hooks/use-agent-capability", () => ({ useAgentCapability: () => agentCapabilityAnswer }));

mock.module("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { username: "admin", role: "admin" }, isAdmin: true, handleLogout: () => {} }),
}));

let capabilitiesOverride: Record<string, unknown> = {};

/*
 * Every mocked hook answers ONE object for the whole test, rebuilt in `beforeEach` and never
 * per render. A fresh object per render is not a detail here: `Studio` and `useTabManager`
 * both hold effects and memos keyed on `metadata` and on `schema`, and a new identity every
 * render turns those into an update loop that never settles. Measured while writing this
 * file: returning a fresh capabilities object made React report "Maximum update depth
 * exceeded" and the suite never finished.
 */
let metadataAnswer: { metadata: unknown } = { metadata: null };

mock.module("@/hooks/use-provider-metadata", () => ({
  useProviderMetadata: () => metadataAnswer,
}));

function buildMetadata(): void {
  metadataAnswer = {
    metadata: {
      capabilities: {
        queryLanguage: "sql",
        supportsExplain: true,
        supportsInlineRowEdit: true,
        maintenanceOperations: [],
        containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
        ...capabilitiesOverride,
      },
      labels: { entityName: "Table", entityNamePlural: "Tables", selectAction: "SELECT", searchPlaceholder: "Search" },
    },
  };
}

const pgConn = { id: "c1", type: "postgres" as const, name: "TestPG", host: "localhost", port: 5432, database: "test" };

const connectionManagerAnswer = {
  connections: [pgConn],
  servedSeeds: { loaded: true, seeds: [] },
  /*
   * Typed nullable and RESET in `beforeEach`, because one test deletes the active connection
   * out from under an open Source tab. The object identity has to stay the same across renders
   * for the reason the file records above, so the field is mutated rather than the object
   * replaced.
   */
  activeConnection: pgConn as typeof pgConn | null,
  schema: [],
  schemaContext: "[]",
  isLoadingSchema: false,
  connectionPulse: "none",
  setConnections: () => {},
  setActiveConnection: () => {},
  setSchema: () => {},
  fetchSchema: () => {},
  objectScanDeferred: false,
  loadObjects: () => {},
};

mock.module("@/hooks/use-connection-manager", () => ({
  useConnectionManager: () => connectionManagerAnswer,
}));

const mockExecuteQuery = mock(() => {});
const mockExecuteHandedOverStatement = mock((...args: unknown[]) => args);

const queryExecutionAnswer = {
  bottomPanelMode: "results",
  setBottomPanelMode: () => {},
  historyKey: 0,
  executeQuery: mockExecuteQuery,
  cancelQuery: () => {},
  forceExecuteQuery: () => {},
  executeHandedOverStatement: mockExecuteHandedOverStatement,
  safetyCheckQuery: null,
  setSafetyCheckQuery: () => {},
  unlimitedWarningOpen: false,
  setUnlimitedWarningOpen: () => {},
  handleUnlimitedQuery: () => {},
  handleLoadMore: () => {},
};

mock.module("@/hooks/use-query-execution", () => ({ useQueryExecution: () => queryExecutionAnswer }));

const transactionAnswer = {
  transactionActive: false,
  playgroundMode: false,
  handleTransaction: () => {},
  setPlaygroundMode: () => {},
  resetTransactionState: () => {},
};

mock.module("@/hooks/use-transaction-control", () => ({ useTransactionControl: () => transactionAnswer }));

const inlineEditingAnswer = {
  editingEnabled: false,
  pendingChanges: [],
  setEditingEnabled: () => {},
  handleCellChange: () => {},
  handleApplyChanges: () => {},
  handleDiscardChanges: () => {},
};

mock.module("@/hooks/use-inline-editing", () => ({ useInlineEditing: () => inlineEditingAnswer }));

const toastAnswer = { toast: () => {} };
mock.module("@/hooks/use-toast", () => ({ useToast: () => toastAnswer }));

const storageSyncAnswer = {
  isServerMode: false,
  isSyncing: false,
  isReady: true,
  lastSyncedAt: null,
  syncError: null,
};
mock.module("@/hooks/use-storage-sync", () => ({ useStorageSync: () => storageSyncAnswer }));

mock.module("@/lib/storage", () => ({
  storage: {
    saveConnection: () => {},
    getConnections: () => [],
    deleteConnection: () => {},
    saveQuery: () => {},
    getActiveConnectionId: () => null,
  },
}));

mock.module("@/lib/data-masking", () => ({
  loadMaskingConfig: () => ({
    enabled: false,
    patterns: [],
    roles: { admin: { canToggleMasking: true, canRevealValues: true } },
  }),
  saveMaskingConfig: () => {},
  shouldMask: () => false,
  canToggleMasking: () => true,
  detectSensitiveColumnsFromConfig: () => new Set(),
  applyMaskingToRows: (rows: unknown) => rows,
}));

mock.module("@/components/sidebar", () => ({
  Sidebar: (props: Record<string, unknown>) => {
    capturedSidebarProps = props;
    return <div data-testid="sidebar">Sidebar</div>;
  },
  ConnectionsList: () => <div data-testid="connections-list" />,
}));

mock.module("@/components/MobileNav", () => ({ MobileNav: () => null }));
mock.module("@/components/schema-explorer", () => ({ SchemaExplorer: () => <div data-testid="schema-explorer" /> }));
mock.module("@/components/ConnectionModal", () => ({ ConnectionModal: () => null }));
/*
 * The palette and the mobile header are captured rather than stubbed away, because round 1's
 * finding 1 is about the props this shell hands them: both hold a Run entry point that is
 * live over the ACTIVE TAB, and neither is inside the editor pane the Source branch replaces.
 */
mock.module("@/components/CommandPalette", () => ({
  CommandPalette: (props: Record<string, unknown>) => {
    capturedPaletteProps = props;
    return null;
  },
}));
mock.module("@/components/SchemaDiagram", () => ({ SchemaDiagram: () => null }));
mock.module("@/components/DataImportModal", () => ({ DataImportModal: () => null }));
mock.module("@/components/QuerySafetyDialog", () => ({ QuerySafetyDialog: () => null }));
mock.module("@/components/DataProfiler", () => ({ DataProfiler: () => null }));
mock.module("@/components/CodeGenerator", () => ({ CodeGenerator: () => null }));
mock.module("@/components/TestDataGenerator", () => ({ TestDataGenerator: () => null }));
mock.module("@/components/CreateTableModal", () => ({ CreateTableModal: () => null }));
mock.module("@/components/SaveQueryModal", () => ({ SaveQueryModal: () => null }));
mock.module("@/components/agent/AgentRail", () => ({
  AgentRail: (props: Record<string, unknown>) => {
    capturedAgentRailProps = props;
    return null;
  },
}));

mock.module("@/components/QueryEditor", () => {
  const Editor = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<HTMLDivElement>) => (
    <div data-testid="query-editor" data-value={String(props.value ?? "")} ref={ref}>
      QueryEditor
    </div>
  ));
  Editor.displayName = "QueryEditor";
  return { QueryEditor: Editor, QueryEditorRef: {} };
});

// The barrel, with the REAL tab bar in it. Everything else in it is a stub, but the icon
// ladder is one of the four things this file exists to check, and a stubbed tab bar draws no
// icon at all: the mutation that removes the Source arm would then kill nothing.
mock.module("@/components/studio/index", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { StudioTabBar } = require("@/components/studio/StudioTabBar");
  return {
    StudioMobileHeader: (props: Record<string, unknown>) => {
      capturedMobileHeaderProps = props;
      return <div data-testid="mobile-header" />;
    },
    StudioDesktopHeader: () => <div data-testid="desktop-header" />,
    StudioTabBar,
    QueryToolbar: () => <div data-testid="query-toolbar">QueryToolbar</div>,
    /*
     * Captured, not stubbed away: `onLoadQuery` is wired to QueryHistory's and SavedQueries'
     * `onSelectQuery` inside this panel, and the panel is rendered OUTSIDE the branch the
     * Source pane replaces, so it is a statement entry point that survives a Source tab.
     */
    BottomPanel: (props: Record<string, unknown>) => {
      capturedBottomPanelProps = props;
      return <div data-testid="bottom-panel" />;
    },
    BottomPanelMode: {},
  };
});

mock.module("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}));

const { default: Studio } = await import("@/components/Studio");

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DatabaseObject } from "@/lib/db/types";
import type { QueryTab } from "@/lib/types";
import { StudioTabBar } from "@/components/studio/StudioTabBar";
import type { TreeRowActionHandlers } from "@/components/object-tree/row-actions";

const ROUTINE: DatabaseObject = { path: ["app", "order_total(integer)"], name: "order_total", kind: "function" };
const TABLE: DatabaseObject = { path: ["app", "orders"], name: "orders", kind: "table" };

/** PostgreSQL-shaped: a view has BOTH a data preview and a source, a function has source only. */
const KINDS = [
  { id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true },
  { id: "view", role: "relation", label: "View", labelPlural: "Views", hasSource: true, sourceLanguage: "sql" },
  {
    id: "function",
    role: "routine",
    label: "Function",
    labelPlural: "Functions",
    hasSource: true,
    sourceLanguage: "sql",
  },
  { id: "sequence", role: "group", label: "Sequence", labelPlural: "Sequences" },
];

const readableDocument = {
  path: ROUTINE.path,
  kind: "function",
  parts: [
    {
      id: "definition",
      label: "Function",
      text: DEFINITION,
      language: "sql",
      form: "complete",
      origin: "regenerated",
    },
  ],
};

const realFetch = globalThis.fetch;

function installFetch(): void {
  globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    if (text.includes("/api/db/objects/source")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { path?: unknown; kind?: unknown };
      sourceReads.push({ path: body.path, kind: body.kind });
      if (sourceHangs) return new Promise<Response>(() => {});
      return new Response(JSON.stringify(sourceAnswer.body), {
        status: sourceAnswer.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return Response.json({});
  }) as never;
}

function sidebarActions(): TreeRowActionHandlers {
  return capturedSidebarProps.objectActions as TreeRowActionHandlers;
}

function activate(object: DatabaseObject): void {
  (capturedSidebarProps.onObjectClick as (target: DatabaseObject) => void)(object);
}

/** The lucide icon a tab (or the row holding the rename input) is drawing, by its own class. */
function iconOf(element: HTMLElement): string {
  const svg = element.querySelector("svg");
  return [...(svg?.classList ?? [])].find((name) => name.startsWith("lucide-")) ?? "none";
}

function tabNames(): string[] {
  return screen.getAllByRole("tab").map((tab) => tab.textContent ?? "");
}

beforeEach(() => {
  localStorage.clear();
  capturedSidebarProps = {};
  capturedPaletteProps = {};
  capturedMobileHeaderProps = {};
  capturedBottomPanelProps = {};
  capturedAgentRailProps = {};
  agentCapabilityAnswer = false;
  capabilitiesOverride = { objectKinds: KINDS };
  buildMetadata();
  sourceReads = [];
  sourceAnswer = { status: 200, body: readableDocument };
  sourceHangs = false;
  connectionManagerAnswer.activeConnection = pgConn;
  mockExecuteQuery.mockClear();
  mockExecuteHandedOverStatement.mockClear();
  installFetch();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("View Source opens a tab that reads the definition", () => {
  test("the row menu's handler opens a Source tab and the pane shows what the route answered", async () => {
    render(<Studio />);
    act(() => sidebarActions().onViewSource?.(ROUTINE));

    // The tab, named after the QUALIFIED path.
    await waitFor(() => expect(tabNames()).toEqual(["Query 1", "Source: app.order_total(integer)"]));
    // The read went out with the ADDRESS the row carried, and came back into the editor.
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    expect(sourceReads).toEqual([{ path: ["app", "order_total(integer)"], kind: "function" }]);
    expect((screen.getByTestId("source-editor") as HTMLTextAreaElement).value).toBe(DEFINITION);
    expect(screen.getByTestId("source-editor").getAttribute("data-language")).toBe("sql");
    expect((screen.getByTestId("source-editor") as HTMLTextAreaElement).readOnly).toBe(true);
  });

  test("a Source tab shows no Run toolbar and no query editor, rather than a disabled one", async () => {
    render(<Studio />);
    // The control, before anything is opened: the ordinary tab has both.
    expect(screen.getByTestId("query-toolbar")).toBeTruthy();
    expect(screen.getByTestId("query-editor")).toBeTruthy();

    act(() => sidebarActions().onViewSource?.(ROUTINE));
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    expect(screen.queryByTestId("query-toolbar")).toBeNull();
    expect(screen.queryByTestId("query-editor")).toBeNull();
  });

  test("deleting the last connection refuses in the pane rather than opening an editable one", async () => {
    /*
     * THE THIRD DOOR onto the empty-editor hazard, named in round 1 and left open (#789 fix
     * round 1). This shell's pane branch was `sourceTab === undefined || conn.activeConnection
     * === null`, on a docblock arguing the second half was a state the type admits and the
     * product does not reach. It reaches it: a Source tab outlives the connection that opened
     * it, and a person who deletes the active connection with one open got a tab still labelled
     * `Source: app.order_total(integer)` holding an EMPTY, EDITABLE query editor with a live Run
     * toolbar, which is the composition this whole surface exists to prevent.
     *
     * NOTHING IN HAND is the state that matters, because a definition already read stays on
     * screen by design, so the route's answer is held in flight while the connection goes.
     */
    sourceHangs = true;
    const view = render(<Studio />);
    act(() => sidebarActions().onViewSource?.(ROUTINE));
    await waitFor(() => expect(screen.getByTestId("object-source-loading")).toBeTruthy());

    connectionManagerAnswer.activeConnection = null;
    view.rerender(<Studio />);

    expect(tabNames()).toEqual(["Query 1", "Source: app.order_total(integer)"]);
    await waitFor(() => expect(screen.getByTestId("object-source-failure")).toBeTruthy());
    expect(screen.getByTestId("object-source-failure-message").textContent).toBe(
      "This connection is no longer open, so this definition cannot be read here.",
    );
    // The two halves of the hazard, asserted separately, and the tab still names the object.
    expect(screen.queryByTestId("query-editor")).toBeNull();
    expect(screen.queryByTestId("query-toolbar")).toBeNull();
    expect(screen.queryByTestId("source-editor")).toBeNull();
    expect(screen.getByTestId("object-source-name").textContent).toBe("app.order_total(integer)");
    // And no second read went out for a connection that is gone.
    expect(sourceReads).toHaveLength(1);
  });

  test("switching back to the query tab brings the toolbar and the editor back", async () => {
    render(<Studio />);
    act(() => sidebarActions().onViewSource?.(ROUTINE));
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    act(() => {
      screen.getAllByRole("tab")[0].click();
    });
    await waitFor(() => expect(screen.getByTestId("query-toolbar")).toBeTruthy());
    expect(screen.queryByTestId("source-editor")).toBeNull();
  });

  test("a second View Source on the same object focuses the open tab instead of reading again", async () => {
    render(<Studio />);
    act(() => sidebarActions().onViewSource?.(ROUTINE));
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    act(() => {
      screen.getAllByRole("tab")[0].click();
    });
    act(() => sidebarActions().onViewSource?.(ROUTINE));
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    expect(tabNames()).toEqual(["Query 1", "Source: app.order_total(integer)"]);
    // The document is still on the tab, so nothing was re-read: the address did not move.
    expect(sourceReads).toHaveLength(1);
  });

  test("three further renders of the shell issue no second read", async () => {
    /*
     * What this pins, and what it does NOT, measured rather than claimed.
     *
     * The shell hands the viewer an `onChange` built with `useCallback`, because the viewer's
     * read effect lists it among its dependencies and a fresh identity every render re-runs
     * that effect. MEASURED: dropping the `useCallback` and handing over a fresh closure every
     * render leaves this file at 14 pass 0 fail, because the guard that actually stops a
     * second read is the viewer's own address ref, which returns early when the effect re-runs
     * against an address it has already asked for. So the memo is defence in depth and this
     * test cannot tell it from a fresh closure; what it does pin is the property a reader
     * would notice, that re-rendering the shell does not hammer the route.
     */
    const { rerender } = render(<Studio />);
    act(() => sidebarActions().onViewSource?.(ROUTINE));
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    rerender(<Studio />);
    rerender(<Studio />);
    rerender(<Studio />);
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    expect(sourceReads).toHaveLength(1);
  });

  test("two different objects get two tabs, each reading its own address", async () => {
    render(<Studio />);
    act(() => sidebarActions().onViewSource?.(ROUTINE));
    await waitFor(() => expect(sourceReads).toHaveLength(1));
    sourceAnswer = {
      status: 200,
      body: {
        path: ["app", "order_summary"],
        kind: "view",
        parts: [
          {
            id: "definition",
            label: "View",
            text: "CREATE VIEW app.order_summary AS SELECT 1;",
            language: "sql",
            form: "complete",
            origin: "regenerated",
          },
        ],
      },
    };
    act(() => sidebarActions().onViewSource?.({ path: ["app", "order_summary"], name: "order_summary", kind: "view" }));

    await waitFor(() => expect(tabNames()).toHaveLength(3));
    await waitFor(() =>
      expect((screen.getByTestId("source-editor") as HTMLTextAreaElement).value).toContain("order_summary"),
    );
    expect(sourceReads.map((read) => read.kind)).toEqual(["function", "view"]);

    // Back to the FIRST Source tab, which still holds its own definition. This is the half a
    // count cannot see: a patch handler that wrote to every Source tab rather than to the one
    // that asked would have put the view's text under the function's name here, which is one
    // object's definition attributed to another - the failure this whole phase exists around -
    // and every count and length assertion above would still pass.
    act(() => {
      screen.getAllByRole("tab")[1].click();
    });
    await waitFor(() => expect((screen.getByTestId("source-editor") as HTMLTextAreaElement).value).toBe(DEFINITION));
    expect(sourceReads).toHaveLength(2);
  });

  test("a refused read draws the route's own sentence and NO editor to type into", async () => {
    // The rule this whole phase exists for, at the seam that could break it: an unreadable
    // source must never open an empty editor, because an empty editor reads as "there is no
    // source" and a reader who types over it deletes the object. The viewer refuses that
    // shape; what is asserted here is that this shell hands it the failure rather than
    // inventing a second way into the editor that skips its checks.
    sourceAnswer = { status: 400, body: { error: "This engine cannot read a definition for that kind." } };
    render(<Studio />);
    act(() => sidebarActions().onViewSource?.(ROUTINE));

    await waitFor(() => expect(screen.getByText("This engine cannot read a definition for that kind.")).toBeTruthy());
    expect(screen.queryByTestId("source-editor")).toBeNull();
    expect(screen.queryByTestId("query-editor")).toBeNull();
  });
});

/**
 * Every OTHER way to run a statement, while the tab on screen is a definition (#789 Phase 2,
 * round 1 finding 1).
 *
 * The editor pane branches, so a Source tab draws no Run button. Three entry points are
 * outside that pane and every one of them addressed `currentTab` and stayed live over a
 * Source tab: the command palette's "Run Query", its two query loaders, and the mobile
 * header's RUN. MEASURED before the gate existed: `updateCurrentTab({ query })` leaves a
 * Source tab a Source tab, so the pane still showed the read-only definition while the tab
 * held a statement nothing on screen displayed, and Run then executed it. With no statement
 * loaded the same Run executed the empty string, because `use-query-execution` has no
 * empty-query guard and `queryEditorRef.current` is null while the editor is unmounted.
 *
 * Every test here writes its CONTROL on the ordinary tab first, so a gate that simply broke
 * the entry point for everyone could not pass.
 */
describe("no statement runs while the tab on screen is a definition", () => {
  /** One captured prop, called the way its own component calls it. */
  function fire(props: Record<string, unknown>, name: string, argument?: string): void {
    act(() => (props[name] as (value?: string) => void)(argument));
  }

  async function openSourceTab(): Promise<void> {
    act(() => sidebarActions().onViewSource?.(ROUTINE));
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
  }

  test("the palette's Run Query executes on a query tab and does nothing on a Source tab", async () => {
    render(<Studio />);
    fire(capturedPaletteProps, "onExecuteQuery");
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);

    await openSourceTab();
    fire(capturedPaletteProps, "onExecuteQuery");
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);

    // And the pane is untouched by the attempt: still the definition, still no query editor.
    expect((screen.getByTestId("source-editor") as HTMLTextAreaElement).value).toBe(DEFINITION);
    expect(screen.queryByTestId("query-editor")).toBeNull();
  });

  test("the palette's saved and history loaders write into a query tab and never into a Source tab", async () => {
    render(<Studio />);
    // The control, on the ordinary tab: both loaders reach the editor.
    fire(capturedPaletteProps, "onLoadSavedQuery", "SELECT 1;");
    await waitFor(() => expect(screen.getByTestId("query-editor").getAttribute("data-value")).toBe("SELECT 1;"));
    fire(capturedPaletteProps, "onLoadHistoryQuery", "SELECT 2;");
    await waitFor(() => expect(screen.getByTestId("query-editor").getAttribute("data-value")).toBe("SELECT 2;"));

    await openSourceTab();
    fire(capturedPaletteProps, "onLoadSavedQuery", "DROP TABLE app.orders;");
    fire(capturedPaletteProps, "onLoadHistoryQuery", "DROP TABLE app.customers;");

    /*
     * `currentQuery` is the mobile header's own prop and it is the active tab's query, which
     * is the only place a reader of this suite can see what a Source tab is holding: the pane
     * deliberately does not display it. An empty string here is the statement never arriving,
     * which is the half that makes the Run assertion below more than a statement about Run.
     */
    expect(capturedMobileHeaderProps.currentQuery).toBe("");
    fire(capturedPaletteProps, "onExecuteQuery");
    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect((screen.getByTestId("source-editor") as HTMLTextAreaElement).value).toBe(DEFINITION);
  });

  test("the mobile header's RUN executes on a query tab and does nothing on a Source tab", async () => {
    render(<Studio />);
    fire(capturedMobileHeaderProps, "onExecuteQuery");
    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);
    // EXPLAIN is the same execution by another name, and the same header draws it.
    fire(capturedMobileHeaderProps, "onExplain");
    expect(mockExecuteQuery).toHaveBeenCalledTimes(2);

    await openSourceTab();
    fire(capturedMobileHeaderProps, "onExecuteQuery");
    fire(capturedMobileHeaderProps, "onExplain");
    expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
  });

  test("the bottom panel's history and saved loaders write into a query tab and never into a Source tab", async () => {
    /*
     * The plainest desktop gesture in this whole class, and the one the editor pane's branch
     * cannot cover: `BottomPanel` is rendered OUTSIDE it, and `BottomPanel.tsx` wires this one
     * prop to `QueryHistory`'s and `SavedQueries`' `onSelectQuery`. So a reader with a Source
     * tab on screen who opens History in the bottom panel and clicks a past query wrote that
     * statement onto a tab that displays nothing, and the tab persistence then stored it.
     */
    render(<Studio />);
    // The control, on the ordinary tab: the loader reaches the editor.
    fire(capturedBottomPanelProps, "onLoadQuery", "SELECT 4;");
    await waitFor(() => expect(screen.getByTestId("query-editor").getAttribute("data-value")).toBe("SELECT 4;"));

    await openSourceTab();
    fire(capturedBottomPanelProps, "onLoadQuery", "DROP TABLE app.orders;");

    expect(capturedMobileHeaderProps.currentQuery).toBe("");
    expect((screen.getByTestId("source-editor") as HTMLTextAreaElement).value).toBe(DEFINITION);
    expect(screen.queryByTestId("query-editor")).toBeNull();
  });

  test("the agent rail's Apply and Run write into a query tab and never into a Source tab", async () => {
    /*
     * The rail is the one entry point in this class that both WRITES and EXECUTES: `onRunStatement`
     * puts the statement on the active tab and then sends it to the hand-over route. Over a Source
     * tab that is a statement running while the pane shows a read-only definition, with nothing on
     * screen saying what ran.
     */
    agentCapabilityAnswer = true;
    render(<Studio />);
    // The control, on the ordinary tab: both reach the editor, and Run also runs.
    fire(capturedAgentRailProps, "onApplyStatement", "SELECT 5;");
    await waitFor(() => expect(screen.getByTestId("query-editor").getAttribute("data-value")).toBe("SELECT 5;"));
    act(() => (capturedAgentRailProps.onRunStatement as (sql: string, runId: string) => void)("SELECT 6;", "run-1"));
    await waitFor(() => expect(screen.getByTestId("query-editor").getAttribute("data-value")).toBe("SELECT 6;"));
    expect(mockExecuteHandedOverStatement).toHaveBeenCalledTimes(1);
    // The run's own id and the run's own statement, in the order the hand-over entry point takes.
    expect(mockExecuteHandedOverStatement).toHaveBeenLastCalledWith("run-1", "SELECT 6;");

    await openSourceTab();
    fire(capturedAgentRailProps, "onApplyStatement", "DROP TABLE app.orders;");
    expect(capturedMobileHeaderProps.currentQuery).toBe("");

    act(() =>
      (capturedAgentRailProps.onRunStatement as (sql: string, runId: string) => void)(
        "DROP TABLE app.customers;",
        "run-2",
      ),
    );
    expect(capturedMobileHeaderProps.currentQuery).toBe("");
    expect(mockExecuteHandedOverStatement).toHaveBeenCalledTimes(1);
    expect(mockExecuteHandedOverStatement).toHaveBeenLastCalledWith("run-1", "SELECT 6;");
    expect((screen.getByTestId("source-editor") as HTMLTextAreaElement).value).toBe(DEFINITION);
  });

  test("switching back to the query tab makes every one of them live again", async () => {
    // The gate is on the ACTIVE TAB and not on the session: a shell that latched would take
    // the Run button away for the rest of the session and no assertion above would notice.
    render(<Studio />);
    await openSourceTab();
    act(() => {
      screen.getAllByRole("tab")[0].click();
    });
    await waitFor(() => expect(screen.getByTestId("query-toolbar")).toBeTruthy());

    fire(capturedPaletteProps, "onLoadSavedQuery", "SELECT 3;");
    await waitFor(() => expect(screen.getByTestId("query-editor").getAttribute("data-value")).toBe("SELECT 3;"));
    fire(capturedBottomPanelProps, "onLoadQuery", "SELECT 4;");
    await waitFor(() => expect(screen.getByTestId("query-editor").getAttribute("data-value")).toBe("SELECT 4;"));
    fire(capturedPaletteProps, "onExecuteQuery");
    fire(capturedMobileHeaderProps, "onExecuteQuery");
    expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
  });

  test("switching back makes the agent rail's two entry points live again as well", async () => {
    // Same control as above for the rail, which needs its own render because the capability
    // flag is read once per mount.
    agentCapabilityAnswer = true;
    render(<Studio />);
    await openSourceTab();
    act(() => {
      screen.getAllByRole("tab")[0].click();
    });
    await waitFor(() => expect(screen.getByTestId("query-toolbar")).toBeTruthy());

    fire(capturedAgentRailProps, "onApplyStatement", "SELECT 7;");
    await waitFor(() => expect(screen.getByTestId("query-editor").getAttribute("data-value")).toBe("SELECT 7;"));
    act(() => (capturedAgentRailProps.onRunStatement as (sql: string, runId: string) => void)("SELECT 8;", "run-3"));
    await waitFor(() => expect(screen.getByTestId("query-editor").getAttribute("data-value")).toBe("SELECT 8;"));
    expect(mockExecuteHandedOverStatement).toHaveBeenCalledTimes(1);
  });
});

/**
 * The tab STRIP's keyboard, over a Source tab whose id is derived from the object's address.
 */
describe("the tab strip's arrow keys work over a Source tab", () => {
  test("an object whose name carries a double quote still hands the strip a usable id", async () => {
    /*
     * `StudioTabBar.activateTabAt` moves focus with
     * `querySelector('[role="tab"][data-tab-id="<id>"]')`, so a tab id carrying a double
     * quote or a backslash is not a wrong selector, it is an INVALID one: `querySelector`
     * throws a SyntaxError and the arrow key takes the whole strip down. Tab ids used to be
     * random, and a Source tab's id is now derived from its address, so an object name is
     * suddenly inside that selector. Oracle quotes reserved-word routine names, which is the
     * measured case standing ruling 2 already records (`"char"(integer)`).
     */
    render(<Studio />);
    act(() => sidebarActions().onViewSource?.({ path: ["app", '"char"(integer)'], name: "char", kind: "function" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));

    const [query, source] = screen.getAllByRole("tab");
    act(() => {
      query.focus();
      fireEvent.keyDown(query, { key: "ArrowLeft" });
    });

    // ArrowLeft from the first tab wraps onto the LAST, which is the Source tab: the id being
    // moved to is the one that goes into the selector, so this is the direction that reaches
    // it. Measured in this environment: happy-dom's `querySelector` throws a DOMException on
    // an invalid selector exactly as a browser does.
    expect(document.activeElement).toBe(source);
    expect(source.getAttribute("aria-selected")).toBe("true");
  });
});

/**
 * The kind's LABEL, which comes from the declaration and falls back to the id.
 */
describe("the pane captions a Source tab with the kind's own word", () => {
  test("the declaration's label is what is shown", async () => {
    render(<Studio />);
    act(() => sidebarActions().onViewSource?.(ROUTINE));
    await waitFor(() => expect(screen.getByTestId("object-source-kind").textContent).toBe("Function"));
  });

  test("a kind the declaration does not carry falls back to the kind id, never to a blank", async () => {
    // The row menu cannot produce this row, and a persisted tab can: a workspace restored
    // against a provider whose declaration has since lost the kind, or a connection edited to
    // a different engine, reaches the pane with a kind nothing declares. A blank caption over
    // a definition is the one thing this surface refuses to draw.
    render(<Studio />);
    act(() =>
      sidebarActions().onViewSource?.({ path: ["app", "mystery"], name: "mystery", kind: "materialized-view" }),
    );
    await waitFor(() => expect(screen.getByTestId("object-source-kind").textContent).toBe("materialized-view"));
  });

  test("before the metadata read answers, the caption is the kind id rather than a crash", async () => {
    // `metadata` is null until the provider answers, and a restored Source tab mounts the
    // pane before then. Reading `metadata.capabilities` here without the null arm throws.
    metadataAnswer = { metadata: null };
    render(<Studio />);
    act(() => sidebarActions().onViewSource?.(ROUTINE));
    await waitFor(() => expect(screen.getByTestId("object-source-kind").textContent).toBe("function"));
  });
});

/**
 * The ACTIVATION split, which is one gesture and one behaviour per row.
 *
 * A relation keeps opening its data preview, because that is what a click on a table has
 * always done and taking it away to show text would be a regression a reader did not ask for.
 * A non-relation that declares source opens its Source tab, because the alternative is the
 * state Phase 1 left every routine in: a row that does nothing at all on click, Enter or
 * Space. A relation that ALSO has source keeps the preview and reaches its source through the
 * menu; two behaviours on one row is worse than one behaviour per row.
 */
describe("activation splits by what the row IS", () => {
  test("a routine that declares source opens its Source tab", async () => {
    render(<Studio />);
    act(() => activate(ROUTINE));
    await waitFor(() => expect(tabNames()).toEqual(["Query 1", "Source: app.order_total(integer)"]));
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  test("a relation keeps opening and running its data preview, source or no source", async () => {
    render(<Studio />);
    act(() => activate(TABLE));
    await waitFor(() => expect(tabNames()).toEqual(["Query 1", "orders"]));

    // The view is the case that decides the split: it is a relation AND it declares source.
    act(() => activate({ path: ["app", "order_summary"], name: "order_summary", kind: "view" }));
    await waitFor(() => expect(tabNames()).toEqual(["Query 1", "orders", "order_summary"]));
    // Neither opened a Source tab, and neither read the source route.
    expect(sourceReads).toEqual([]);
  });

  test("a kind with neither a data preview nor a source still does nothing", async () => {
    render(<Studio />);
    act(() => activate({ path: ["app", "order_seq"], name: "order_seq", kind: "sequence" }));
    expect(tabNames()).toEqual(["Query 1"]);
    expect(sourceReads).toEqual([]);
  });

  test("a kind the provider never declared does nothing either", async () => {
    render(<Studio />);
    act(() => activate({ path: ["app", "mystery"], name: "mystery", kind: "not-declared" }));
    expect(tabNames()).toEqual(["Query 1"]);
    expect(sourceReads).toEqual([]);
  });
});

/**
 * The tab bar's icon ladder.
 *
 * Nothing errors if the Source arm is missing: a Source tab silently takes `FileBraces` and
 * becomes indistinguishable from a MongoDB or a Redis tab in the one place a reader picks a
 * tab from. That is exactly why it is written down and pinned here, in both the rendered
 * shell and the component on its own, where all three arms can be driven at once.
 */
describe("the tab bar tells a Source tab apart", () => {
  test("the Source tab the shell opened carries the source icon, and the query tab does not", async () => {
    render(<Studio />);
    act(() => sidebarActions().onViewSource?.(ROUTINE));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));

    const [query, source] = screen.getAllByRole("tab");
    expect(source.querySelector("svg.lucide-file-code")).not.toBeNull();
    expect(query.querySelector("svg.lucide-hash")).not.toBeNull();
  });

  test("all three arms, driven at once: source, sql, and every other dialect", () => {
    const base: QueryTab = { id: "t", name: "n", query: "", result: null, isExecuting: false, type: "sql" };
    render(
      <StudioTabBar
        tabs={[
          { ...base, id: "sql", name: "A query" },
          { ...base, id: "json", name: "A document query", type: "mongodb" },
          { ...base, id: "src", name: "Source: app.f", source: { path: ["app", "f"], kind: "function" } },
          // A Source tab whose dialect is NOT sql: the first arm has to win over the second,
          // or a Redis or MongoDB connection's Source tab takes the document icon.
          {
            ...base,
            id: "src-json",
            name: "Source: db.view",
            type: "mongodb",
            source: { path: ["db", "view"], kind: "view" },
          },
        ]}
        activeTabId="sql"
        editingTabId={null}
        editingTabName=""
        onSetActiveTabId={() => {}}
        onSetEditingTabId={() => {}}
        onSetEditingTabName={() => {}}
        onSetTabs={() => {}}
        onCloseTab={() => {}}
        onAddTab={() => {}}
      />,
    );

    const icons = screen.getAllByRole("tab").map((tab) => iconOf(tab));
    expect(icons).toEqual(["lucide-hash", "lucide-file-braces", "lucide-file-code", "lucide-file-code"]);
  });

  test("the ladder is the same one the rename input draws, so the icon does not change under a rename", () => {
    const base: QueryTab = { id: "t", name: "n", query: "", result: null, isExecuting: false, type: "sql" };
    render(
      <StudioTabBar
        tabs={[{ ...base, id: "src", name: "Source: app.f", source: { path: ["app", "f"], kind: "function" } }]}
        activeTabId="src"
        editingTabId="src"
        editingTabName="Source: app.f"
        onSetActiveTabId={() => {}}
        onSetEditingTabId={() => {}}
        onSetEditingTabName={() => {}}
        onSetTabs={() => {}}
        onCloseTab={() => {}}
        onAddTab={() => {}}
      />,
    );
    const row = screen.getByRole("textbox").parentElement as HTMLElement;
    expect(iconOf(row)).toBe("lucide-file-code");
  });
});
