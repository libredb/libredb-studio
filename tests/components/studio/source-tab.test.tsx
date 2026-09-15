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
/** Every render of the active tab's source state, in order, for the clear the apply writes. */
let sourceStates: Array<{ id: string; source: SourceTabState }> = [];

const DEFINITION = "CREATE OR REPLACE FUNCTION app.order_total(integer)\n  RETURNS numeric AS $$ SELECT 1 $$;";

/**
 * The editor's own `onChange`, captured so a test can move the buffer.
 *
 * The textarea below is `readOnly` whenever the pane is, and jsdom's own change on a controlled
 * textarea does not reach a handler this double installs, so a test that wants to type calls
 * `editorProbe.change` instead. That is the same call Monaco makes. `ObjectSourceView.test.tsx`
 * and `tests/components/studio/embedded-source.test.tsx` capture it the same way and for the same
 * reason: without it nothing in this file could move the buffer, which is how `dirty` went
 * undefended here (#789 Phase 3).
 */
const editorProbe: { change?: (value: string | undefined) => void } = {};

mock.module("@monaco-editor/react", () => ({
  default: function MockEditor(props: {
    value?: string;
    language?: string;
    options?: Record<string, unknown>;
    onChange?: (value: string | undefined) => void;
  }) {
    editorProbe.change = props.onChange;
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
  // `DiffEditor` is the apply preview's surface (#789 Phase 3). A double that omits an export the
  // real module HAS does not degrade, it throws: bun answers `SyntaxError: Export named 'DiffEditor'
  // not found` and fails the WHOLE FILE, so this suite dies the moment the pane's module graph
  // reaches the preview, without this suite rendering a diff at all. Measured 2026-09-14.
  DiffEditor: function MockDiffEditor(props: { original?: string; modified?: string; language?: string }) {
    return (
      <div
        data-testid="mock-monaco-diff-editor"
        data-language={props.language}
        data-original={props.original ?? ""}
        data-modified={props.modified ?? ""}
      />
    );
  },
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

const mockToast = mock((_argument: unknown) => {});
const toastAnswer = { toast: mockToast };
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
      /*
       * The ACTIVE tab's source state, recorded once per render (#789 Phase 3).
       *
       * `currentTab` is a prop this shell already hands out, so recording it introduces no seam
       * the product does not have: the apply's clear is a write onto the tab, and this is where
       * a test can watch the tab from outside the component that owns it.
       */
      const tab = props.currentTab as QueryTab | undefined;
      if (tab?.source !== undefined) sourceStates.push({ id: tab.id, source: tab.source });
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
import type { QueryTab, SourceTabState } from "@/lib/types";
import { StudioTabBar } from "@/components/studio/StudioTabBar";
import type { TreeRowActionHandlers } from "@/components/object-tree/row-actions";
import { pathKey } from "@/lib/db/object-path";

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

/**
 * The APPLY fixtures (#789 Phase 3).
 *
 * The plan is what a provider issues and what `isObjectEditPlanShape` accepts. Its single user
 * segment spans the whole of the step's text on purpose: `spansTheText` in
 * `src/lib/api/object-edit-wire.ts` refuses a plan whose segments laid end to end fall short of
 * `text.length`, and a short segment makes every preview test below silently exercise the pane's
 * UNREADABLE arm while reading as if it drove the happy path. Measured against the shipped
 * predicate while wave 8 was written, and repeated here because the same fixture is being built
 * a second time in a second suite.
 */
const STEP_TEXT = "CREATE OR REPLACE FUNCTION app.order_total(integer)\n  RETURNS numeric AS $$ SELECT 2 $$;";

const PLAN = {
  planVersion: 1,
  planId: "plan-1",
  issuedAt: "2026-09-14T00:00:00.000Z",
  connectionFingerprint: "fingerprint",
  type: "postgres",
  path: [...ROUTINE.path],
  kind: "function",
  partId: "definition",
  strategy: "guarded-atomic-batch",
  unit: {
    medium: "statement",
    steps: [{ text: STEP_TEXT, language: "sql", segments: [{ from: "user", start: 0, end: STEP_TEXT.length }] }],
  },
  session: [],
  revision: { check: "compared", token: "t1", basis: "pg_proc.xmin", scope: "connection" },
  consequences: [],
};

const BUILT = { built: true, plan: PLAN, preimage: { text: DEFINITION, language: "sql" }, planToken: "token-1" };
const APPLIED = { outcome: "applied", revision: PLAN.revision, duration: 3 };

/** The two edit routes' request bodies, in the order the pane sent them. */
let editRequests: Array<{ url: string; body: unknown }> = [];
let applyAnswer: { status: number; body: unknown } = { status: 200, body: APPLIED };
/**
 * Whether the apply route HOLDS its answer, so a test can act with the statement already sent
 * and nothing back yet (D82).
 *
 * That window is the whole of D82 and it cannot be reached with a route that answers at once:
 * the pane leaves `applying` in the same promise continuation the answer arrives in, so there is
 * no frame in between for a keystroke to land in. `releaseApply` hands the answer over when the
 * test is ready.
 */
let applyHangs = false;
let releaseApply: (() => void) | undefined;

const realFetch = globalThis.fetch;

function installFetch(): void {
  globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    if (text.includes("/api/db/objects/edit-plan")) {
      editRequests.push({ url: text, body: JSON.parse(String(init?.body ?? "{}")) });
      return Response.json(BUILT);
    }
    if (text.includes("/api/db/objects/edit-apply")) {
      editRequests.push({ url: text, body: JSON.parse(String(init?.body ?? "{}")) });
      const answer = () =>
        new Response(JSON.stringify(applyAnswer.body), {
          status: applyAnswer.status,
          headers: { "Content-Type": "application/json" },
        });
      if (!applyHangs) return answer();
      return new Promise<Response>((resolve) => {
        releaseApply = () => resolve(answer());
      });
    }
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
  sourceStates = [];
  editRequests = [];
  applyAnswer = { status: 200, body: APPLIED };
  applyHangs = false;
  releaseApply = undefined;
  mockToast.mockClear();
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

/**
 * The APPLY, wired into the standalone shell (#789 Phase 3, discussion #778).
 *
 * MEASURED before this task existed: the Source pane NEVER re-reads after a change made
 * elsewhere in the same app. A new body was applied to `p3probe.order_total` through
 * `POST /api/db/query` while its Source tab was open, and the tab kept showing the old text with
 * no stale banner. This shell's `objectRefreshToken` is a counter it increments for what IT ran,
 * and a raw query is not one of them, so the pane had nothing to notice.
 *
 * What is REAL here: the pane, the preview dialog, `httpSourceApplier`, `useTabManager` and the
 * tab strip. `globalThis.fetch` answers the two edit routes, so the apply is a round trip through
 * the shipped applier rather than an injected double, which is the half `ObjectSourceView`'s own
 * suite cannot reach: it hands the pane an applier object and never the URL.
 */
const EDITABLE_PART = { ...readableDocument.parts[0], edit: { offered: true } };
const EDITABLE_DOCUMENT = { ...readableDocument, parts: [EDITABLE_PART] };

const OTHER_VIEW = {
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
};

/** The kind list WITHOUT the shell-side declaration, which is what a real `provider-meta` sends. */
const WITHOUT_EDIT_DECLARATION = KINDS;
/** The same list with the function kind declared editable, for the negative half's control. */
const WITH_EDIT_DECLARATION = KINDS.map((kind) =>
  kind.id === "function" ? { ...kind, acceptsSourceEdits: true } : kind,
);

const SOURCE_TAB_ID = `source:function:${encodeURIComponent(pathKey([...ROUTINE.path]))}`;

async function click(testId: string): Promise<void> {
  await act(async () => {
    (screen.getByTestId(testId) as HTMLElement).click();
    await Promise.resolve();
  });
}

/** The states the named tab's `source` passed through, in render order. */
function statesFor(tabId: string): SourceTabState[] {
  return sourceStates.filter((entry) => entry.id === tabId).map((entry) => entry.source);
}

/** Open the function's Source tab and wait for the definition to be on screen. */
async function openFunctionTab(): Promise<void> {
  act(() => sidebarActions().onViewSource?.(ROUTINE));
  await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
}

/** Edit, Preview, confirm. Every step is the gesture a reader makes, in that order. */
async function applySuccessfully(): Promise<void> {
  await click("object-source-edit");
  await waitFor(() => expect(screen.getByTestId("object-source-preview")).toBeTruthy());
  await click("object-source-preview");
  await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());
  await click("object-source-apply-confirm");
  await waitFor(() => expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull());
}

describe("a successful apply in the standalone shell", () => {
  test("moves the catalog token, clears THIS tab and drops the draft, in ONE commit", async () => {
    /*
     * The order is safe and it is TRACED rather than asserted: both writes batch into ONE commit,
     * so the viewer re-renders with `refreshToken = n+1` and `document === undefined`;
     * `needsRead` in `ObjectSourceView` becomes true; the address was removed from `asked.current`
     * when the previous read landed; so the effect issues a fresh read with `tokenAtRead = n+1`
     * and the landed read writes `readAtToken = n+1`, which EQUALS `refreshToken`.
     *
     * WHAT THIS ASSERTS AND WHY IT IS NOT THE BRIEF'S `patchesFor`. The clear is a write this
     * shell makes onto its own tab through the same callback the pane holds, so there is no
     * boundary a test can watch a PATCH cross without a seam the product does not have. The tab's
     * STATE is watchable, through `currentTab`, and the clear's whole content is the state it
     * produces. Non-vacuity is the reason the two indices are separate assertions: the tab's
     * source state is ALSO all-undefined before the first read has landed, so an assertion that
     * merely found a cleared state would pass over a shell that cleared nothing.
     */
    sourceAnswer = { status: 200, body: EDITABLE_DOCUMENT };
    render(<Studio />);
    await openFunctionTab();

    // The second Source tab, read at token 0, so it is a real other tab and not a hypothetical.
    sourceAnswer = { status: 200, body: OTHER_VIEW };
    act(() => sidebarActions().onViewSource?.({ path: ["app", "order_summary"], name: "order_summary", kind: "view" }));
    await waitFor(() => expect(sourceReads).toHaveLength(2));
    await waitFor(() =>
      expect((screen.getByTestId("source-editor") as HTMLTextAreaElement).value).toContain("order_summary"),
    );

    act(() => {
      screen.getAllByRole("tab")[1].click();
    });
    await waitFor(() => expect((screen.getByTestId("source-editor") as HTMLTextAreaElement).value).toBe(DEFINITION));

    sourceAnswer = { status: 200, body: EDITABLE_DOCUMENT };
    await applySuccessfully();

    // The clear landed on the tab, AFTER that tab had a document in hand.
    const states = statesFor(SOURCE_TAB_ID);
    const held = states.findIndex((state) => state.document !== undefined && state.readAtToken !== undefined);
    expect(held).toBeGreaterThanOrEqual(0);
    const cleared = states.findIndex(
      (state, index) =>
        index > held && state.document === undefined && state.failure === undefined && state.readAtToken === undefined,
    );
    expect(cleared).toBeGreaterThan(held);

    // The token moved, so the pane re-read: a third read for the SAME address.
    await waitFor(() => expect(sourceReads).toHaveLength(3));
    expect(sourceReads[2]).toEqual({ path: [...ROUTINE.path], kind: "function" });
    await waitFor(() => expect((screen.getByTestId("source-editor") as HTMLTextAreaElement).value).toBe(DEFINITION));

    /*
     * The tab that applied is NOT marked stale while every OTHER open Source tab is, which is the
     * honest split: the tab that applied knows exactly what happened, the others know only that
     * something did.
     */
    expect(screen.queryByTestId("object-source-stale")).toBeNull();

    act(() => {
      screen.getAllByRole("tab")[2].click();
    });
    await waitFor(() => expect(screen.getByTestId("object-source-stale")).toBeTruthy());
  });

  test("the pane falls to its loading state for one round trip and SAYS so", async () => {
    // The region the reader was looking at is replaced, so the loading line plus a success toast
    // carry the fact. The re-read is held in flight here, which is the only way the loading state
    // is observable at all: with a route that answers at once it is one render wide.
    sourceAnswer = { status: 200, body: EDITABLE_DOCUMENT };
    render(<Studio />);
    await openFunctionTab();

    sourceHangs = true;
    await applySuccessfully();

    await waitFor(() => expect(screen.getByTestId("object-source-loading")).toBeTruthy());
    expect(screen.getByTestId("object-source-loading").textContent).toContain("Reading the definition...");
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Applied. Reading the definition again." }),
    );
  });

  test("the apply goes out over THIS application's own two routes, with the plan it was given", async () => {
    // What the pane's own suite cannot see: it is handed an applier object and never a URL, so
    // the standalone shell is the only place the wiring of `httpSourceApplier` to the mount is
    // observable. Both bodies are asserted, because a build that reached the route and an apply
    // that did not is a preview nothing can act on.
    sourceAnswer = { status: 200, body: EDITABLE_DOCUMENT };
    render(<Studio />);
    await openFunctionTab();
    await applySuccessfully();

    expect(editRequests.map((request) => request.url)).toEqual([
      "/api/db/objects/edit-plan",
      "/api/db/objects/edit-apply",
    ]);
    expect(editRequests[0].body).toMatchObject({
      path: [...ROUTINE.path],
      kind: "function",
      partId: "definition",
      text: DEFINITION,
    });
    expect(editRequests[1].body).toMatchObject({ plan: PLAN, planToken: "token-1", acknowledged: [] });
  });

  test("an apply that FAILED moves nothing: no token, no clear, no re-read", async () => {
    /*
     * The control for the three assertions above, over the population the shell must not act on.
     * `onApplied` is called by the pane only for an outcome in `APPLIED_OUTCOMES`, so a shell that
     * moved the token on every dialog close would throw away a definition the reader is still
     * looking at and send them round a read they did not need.
     */
    sourceAnswer = { status: 200, body: EDITABLE_DOCUMENT };
    applyAnswer = {
      status: 200,
      body: {
        outcome: "failed",
        committed: "no",
        sentence: 'ERROR: syntax error at or near "SELCT"',
        duration: 2,
      },
    };
    render(<Studio />);
    await openFunctionTab();

    await click("object-source-edit");
    await waitFor(() => expect(screen.getByTestId("object-source-preview")).toBeTruthy());
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());
    await click("object-source-apply-confirm");

    await waitFor(() => expect(screen.getByTestId("object-source-apply-outcome")).toBeTruthy());
    expect(sourceReads).toHaveLength(1);
    expect(mockToast).not.toHaveBeenCalled();
    expect(statesFor(SOURCE_TAB_ID).at(-1)?.document).toBeDefined();
  });
});

/**
 * D57, closed by construction rather than by a comment.
 *
 * MEASURED end to end on a live MariaDB 12.3.2: `provider-meta` answered the MySQL six for a
 * server whose connected provider serves `package` in full. This shell's copy of a declaration is
 * therefore a statement about SOME server and not necessarily the connected one, so it may decide
 * a label and it may not decide whether a definition can be replaced. Editability comes from the
 * PART, which travelled with the read from the connected provider.
 *
 * DRIVEN, and not asserted over a source string. An earlier draft of this test was
 * `expect(source(Studio)).not.toContain("acceptsSourceEdits")` over a helper the plan never
 * defined, which passes when `source()` answers `""` and is therefore an uncontrolled negative
 * over a population it cannot prove non-empty.
 */
describe("the kind lookup does NOT grow a writable arm, and the edit gate reads the PART", () => {
  test("a part that offers the edit shows the control even where the shell's copy withholds it", async () => {
    capabilitiesOverride = { objectKinds: WITHOUT_EDIT_DECLARATION };
    buildMetadata();
    sourceAnswer = { status: 200, body: EDITABLE_DOCUMENT };
    render(<Studio />);
    await openFunctionTab();

    // The label still comes from the declaration, which is the ONE thing this copy decides.
    expect(screen.getByTestId("object-source-kind").textContent).toBe("Function");
    expect(screen.queryByTestId("object-source-edit")).not.toBeNull();
  });

  test("a part with no edit shows no control even where the shell's copy declares the kind editable", async () => {
    // The declaration flipped the other way. If the shell consulted its own copy, exactly one of
    // these two tests would fail, which is what makes the pair a control rather than two halves
    // of the same assertion.
    capabilitiesOverride = { objectKinds: WITH_EDIT_DECLARATION };
    buildMetadata();
    sourceAnswer = { status: 200, body: readableDocument };
    render(<Studio />);
    await openFunctionTab();

    expect(screen.getByTestId("object-source-kind").textContent).toBe("Function");
    expect(screen.queryByTestId("object-source-edit")).toBeNull();
    // And the pane says WHY, in the words the predicate owns, rather than drawing nothing.
    expect(screen.getByTestId("object-source-edit-refusal").getAttribute("data-refusal")).toBe("not-offered");
  });
});

describe("the tab strip's dirty mark survives a remount and still clears", () => {
  test("a tab remounted inside an unsaved edit still clears its dirty mark when the buffer is reverted", async () => {
    /*
     * WHAT `dirty={sourceTab.dirty}` IN `Studio.tsx` IS FOR (#789 Phase 3, discussion #778).
     *
     * `ObjectSourceView` seeds `dirtyRef` from that prop and writes the flag onto the tab only
     * when the boolean FLIPS. A tab switch unmounts the pane, because the pane is rendered for
     * the active tab alone. So without the prop a pane remounted inside an unsaved edit starts
     * from `false`, reverting the buffer to the engine's own text compares `false` against a
     * `false` that was never true, the flip guard returns early, no patch is written, and the
     * strip keeps a dirty dot over a tab holding exactly what the database holds.
     *
     * MEASURED: this file is 32 pass 0 fail without this test and 33 pass 0 fail with it, and
     * deleting the prop from `Studio.tsx` takes it to 32 pass 1 fail, the one failure being this
     * test. Before this test existed the same deletion left all 46 component groups green.
     *
     * `tests/components/studio/embedded-source.test.tsx` carries the same test for the embedded
     * shell. A tab RESTORED from `localStorage`, which is the production population, cannot be
     * built in a component test at all: `use-tab-manager.ts` computes `shouldPersistWorkspace`
     * from `process.env.NODE_ENV !== "test"`. A tab SWITCH unmounts the pane the same way, and
     * that is the population this drives.
     */
    sourceAnswer = { status: 200, body: EDITABLE_DOCUMENT };
    render(<Studio />);
    await openFunctionTab();
    await click("object-source-edit");

    await act(async () => {
      editorProbe.change?.(
        "CREATE OR REPLACE FUNCTION app.order_total(integer)\n  RETURNS numeric AS $$ SELECT 99 $$;",
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("tab-dirty-dot")).toBeTruthy());

    // The tab switch is the remount: the pane is mounted for the active tab only.
    act(() => {
      screen.getAllByRole("tab")[0].click();
    });
    await waitFor(() => expect(screen.queryByTestId("source-editor")).toBeNull());
    act(() => {
      screen.getAllByRole("tab")[1].click();
    });
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    // The mark survived the remount, which is the state this test is about.
    expect(screen.getByTestId("tab-dirty-dot")).toBeTruthy();

    await act(async () => {
      editorProbe.change?.(DEFINITION);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByTestId("tab-dirty-dot")).toBeNull());
  });
});

/**
 * D82: the new-tab shortcut, pressed between Confirm and the answer.
 *
 * MEASURED before this suite existed, and the comment in `Studio.tsx` said the opposite. The
 * strip is aria-hidden and covered while the dialog is open, not REMOVED, and `StudioTabBar`
 * registers the new-tab shortcut on `document` on purpose (#745), so the keystroke reaches the
 * handler from a control inside the dialog. `addTab` ends with `setActiveTabId(newId)`, the shell
 * renders the Source pane only for an active Source tab, and the pane took the dialog down with
 * it mid apply: the statement was already sent and the reader was never told what it answered.
 *
 * Each test drives the shortcut from the DIALOG's own element, which is the population the entry
 * is about: an event dispatched from inside the modal, bubbling to the document listener.
 *
 * The shortcut is not the only document-level listener that reaches this window. `CommandPalette`
 * registers a second one for Cmd/Ctrl+K, and its table items call this shell's `onTableClick`,
 * which opens and activates a Query tab exactly as `addTab` does. The last two tests drive that
 * second door through the captured palette prop; the palette itself is stubbed in this file, so
 * the reachability of the keystroke was measured against the REAL palette outside the suite and
 * is recorded in `Studio.tsx`.
 */
describe("the new-tab shortcut cannot unmount an apply that is in flight", () => {
  const CONFLICT = {
    outcome: "conflict",
    conflict: "object-changed",
    current: { text: `${DEFINITION}\n-- somebody else got there first`, language: "sql" },
    duration: 5,
  };

  /** Edit, Preview, Confirm, and STOP with the apply in flight and the dialog on `applying`. */
  async function confirmAndHold(): Promise<void> {
    sourceAnswer = { status: 200, body: EDITABLE_DOCUMENT };
    applyHangs = true;
    render(<Studio />);
    await openFunctionTab();
    await click("object-source-edit");
    await waitFor(() => expect(screen.getByTestId("object-source-preview")).toBeTruthy());
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());
    await click("object-source-apply-confirm");
    await waitFor(() =>
      expect(screen.getByTestId("object-source-apply-dialog").textContent).toContain("Applying this definition"),
    );
  }

  /**
   * The tab strip read from the DOM, which is the only way to read it while the dialog is open.
   *
   * `getAllByRole` applies the accessibility filter, and Radix aria-hides everything outside the
   * modal, so the role query answers NOTHING here. That is the entry's first measurement in one
   * line: the strip is aria-hidden and covered, and it is still in the tree.
   */
  function tabNamesInDom(): string[] {
    return [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent ?? "");
  }

  /** The shortcut as a reader presses it, from the control the dialog has focus in. */
  function pressNewTab(target: HTMLElement): void {
    act(() => {
      fireEvent.keyDown(target, { key: "X", code: "KeyX", ctrlKey: true, shiftKey: true });
    });
  }

  test("the shortcut is refused while the apply is in flight, and the answer still reaches the reader", async () => {
    applyAnswer = { status: 200, body: CONFLICT };
    await confirmAndHold();

    pressNewTab(screen.getByTestId("object-source-apply-dialog"));

    // No tab was opened, so nothing moved the active tab off the Source tab that is applying.
    expect(tabNamesInDom()).toEqual(["Query 1", "Source: app.order_total(integer)"]);
    expect(screen.getByTestId("object-source-apply-dialog")).toBeTruthy();
    // And the keystroke is ANSWERED rather than swallowed: the reader is told why.
    expect(mockToast).toHaveBeenCalledWith({
      title: "Waiting for the apply to answer",
      description:
        "Opening a tab would close this dialog before the apply reports. Try again once you have read the answer.",
    });

    await act(async () => {
      releaseApply?.();
      await Promise.resolve();
    });

    // The half the reader lost before: the conflict lands on a dialog that is still mounted.
    await waitFor(() => expect(screen.getByTestId("object-source-apply-conflict")).toBeTruthy());
    expect(screen.getByTestId("mock-monaco-diff-editor").getAttribute("data-original")).toContain(
      "somebody else got there first",
    );
  });

  test("the refusal lasts exactly as long as the apply: the shortcut opens a tab once the answer is on screen", async () => {
    /*
     * The control for the test above. Without it the refusal could be "the shortcut never works
     * over a Source tab", which would close D82 by breaking #745 instead of by guarding it.
     */
    applyAnswer = { status: 200, body: CONFLICT };
    await confirmAndHold();
    await act(async () => {
      releaseApply?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("object-source-apply-conflict")).toBeTruthy());

    pressNewTab(screen.getByTestId("object-source-apply-dialog"));

    await waitFor(() => expect(tabNames()).toEqual(["Query 1", "Source: app.order_total(integer)", "Query 3"]));
  });

  test("the refusal does not outlive the pane that raised it", async () => {
    /*
     * The latch is the pane's state and the shell only mirrors it, so a pane that goes away with
     * an apply still in flight has to take the refusal with it. Otherwise the shortcut would be
     * dead for the rest of the session, which is a worse defect than the one D82 reports.
     *
     * The tab click is a DIRECT DOM click, which is how the strip is reachable under an aria-hidden
     * modal at all. It is not a gesture a reader can make; it is the one path that can still
     * unmount the pane mid apply, and it is here to prove the flag is released rather than held.
     */
    applyAnswer = { status: 200, body: CONFLICT };
    await confirmAndHold();

    act(() => {
      (document.querySelectorAll('[role="tab"]')[0] as HTMLElement).click();
    });
    await waitFor(() => expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull());

    pressNewTab(document.body);

    await waitFor(() => expect(tabNames()).toEqual(["Query 1", "Source: app.order_total(integer)", "Query 3"]));
  });

  /** A table opened from the palette, addressed the way the palette addresses it (#789). */
  function openTableFromPalette(): void {
    act(() => {
      (capturedPaletteProps.onTableClick as (path: readonly string[]) => void)(["app", "orders"]);
    });
  }

  test("the palette's table item is refused in the same window, and the answer still reaches the reader", async () => {
    /*
     * The second door into this window, and the reason the handler above cannot be the whole
     * answer. Cmd/Ctrl+K is a document listener too, so it fires from inside the modal, the
     * palette takes focus, and selecting a table runs `handleTableClick`, which ends with
     * `setActiveTabId(newId)` and unmounts the pane the dialog lives in. Measured against the
     * real palette before this test was written: the dialog went away and the conflict never
     * rendered.
     */
    applyAnswer = { status: 200, body: CONFLICT };
    await confirmAndHold();

    openTableFromPalette();

    expect(tabNamesInDom()).toEqual(["Query 1", "Source: app.order_total(integer)"]);
    expect(screen.getByTestId("object-source-apply-dialog")).toBeTruthy();
    expect(mockToast).toHaveBeenCalledWith({
      title: "Waiting for the apply to answer",
      description:
        "Opening a tab would close this dialog before the apply reports. Try again once you have read the answer.",
    });

    await act(async () => {
      releaseApply?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId("object-source-apply-conflict")).toBeTruthy());
  });

  test("the palette's table item works again once the answer is on screen", async () => {
    /*
     * The control for the test above, on the same argument: the refusal has to be the apply
     * window and not "a table cannot be opened from a Source tab", which would break #789 to
     * close D82.
     */
    applyAnswer = { status: 200, body: CONFLICT };
    await confirmAndHold();
    await act(async () => {
      releaseApply?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("object-source-apply-conflict")).toBeTruthy());

    openTableFromPalette();

    await waitFor(() => expect(tabNames()).toEqual(["Query 1", "Source: app.order_total(integer)", "orders"]));
  });
});
