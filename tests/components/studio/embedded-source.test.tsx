import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setupFramerMotionMock } from "../../helpers/mock-monaco";

setupFramerMotionMock();

/*
 * The Monaco DOUBLE surfaces the value, the language and the read-only flag, so what a reader
 * would SEE is what is asserted. `setupMonacoMock` is not used here: it stubs the loader alone
 * and this file mounts the real `ObjectSourceView`, whose editor is the subject.
 */
mock.module("@monaco-editor/react", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    default: function MockEditor(props: { value?: string; language?: string; options?: Record<string, unknown> }) {
      return React.createElement("textarea", {
        "data-testid": "source-editor",
        "data-language": props.language,
        readOnly: (props.options as Record<string, unknown> | undefined)?.readOnly === true,
        value: props.value ?? "",
        onChange: () => {},
      });
    },
    loader: { init: () => Promise.resolve(), config: () => {}, __getMonacoInstance: () => null },
  };
});

// The query editor and the panel library are the two things this file does not exercise, and
// both are hostile to happy-dom, exactly as `embedded-object-tree.test.tsx` records. Everything
// between the published prop and the source viewer's own read is the real code: the adapter,
// the sidebar, the tree, the row menu, the tab manager, the tab bar and the viewer.
mock.module("@/components/QueryEditor", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  // The value is surfaced because the tab's statement is otherwise invisible: the source pane
  // deliberately never displays it, so this is the only place a test can see what a Source tab
  // is holding, and "the statement never arrived" is the assertion the load gate needs.
  return {
    QueryEditor: (props: { value?: string }) =>
      React.createElement("div", { "data-testid": "query-editor", "data-value": String(props.value ?? "") }),
  };
});

/**
 * The bottom panel is rendered REAL, and only its props are captured (#789 Phase 2).
 *
 * `BottomPanel.onLoadQuery` is the one statement entry point in this shell that lives OUTSIDE
 * the editor pane's branch, and `BottomPanel.tsx` wires it to both `QueryHistory`'s and
 * `SavedQueries`' `onSelectQuery`. Reaching it through the real panel would mean seeding a
 * history key and opening a sub-panel, so the prop is called the way the panel itself calls it,
 * exactly as the standalone shell's `source-tab.test.tsx` does. The real component is still
 * mounted underneath, so nothing else in this file changes shape.
 */
let capturedBottomPanelProps: Record<string, unknown> = {};
mock.module("@/components/studio/index", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { StudioTabBar } = require("@/components/studio/StudioTabBar");
  const { QueryToolbar } = require("@/components/studio/QueryToolbar");
  const { BottomPanel } = require("@/components/studio/BottomPanel");
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    StudioTabBar,
    QueryToolbar,
    BottomPanel: (props: Record<string, unknown>) => {
      capturedBottomPanelProps = props;
      return React.createElement(BottomPanel, props);
    },
  };
});

mock.module("@/components/ui/resizable", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    ResizablePanelGroup: ({ children }: Record<string, unknown>) => React.createElement("div", null, children),
    ResizablePanel: ({ children }: Record<string, unknown>) => React.createElement("div", null, children),
    ResizableHandle: () => React.createElement("div", null),
  };
});

import { StudioWorkspace } from "@/workspace/StudioWorkspace";
import type { WorkspaceObjectReader } from "@/workspace/types";
import type { ObjectSourceDocument, ProviderCapabilities } from "@/lib/db/types";
import type { QueryTab } from "@/lib/types";

const DEFINITION = "CREATE FUNCTION app.order_total(integer) RETURNS numeric AS $$ SELECT 1 $$;";

/** PostgreSQL-shaped: a table is a relation with no source, a function has source and no rows. */
const capabilities = {
  queryLanguage: "sql",
  containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
  objectKinds: [
    { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
    {
      id: "function",
      role: "routine",
      label: "Function",
      labelPlural: "Functions",
      hasSource: true,
      sourceLanguage: "sql",
    },
    // The third kind is what makes the activation gate an assertion about the DECLARATION
    // rather than about "not a relation": a sequence is neither, and it declares no source.
    { id: "sequence", role: "sequence", label: "Sequence", labelPlural: "Sequences" },
  ],
} as unknown as ProviderCapabilities;

const ROUTINE = { path: ["app", "order_total(integer)"], name: "order_total", kind: "function" };
const TABLE = { path: ["app", "orders"], name: "orders", kind: "table" };
const SEQUENCE = { path: ["app", "order_id_seq"], name: "order_id_seq", kind: "sequence" };
/** A second routine, so a patch aimed at one Source tab can be watched NOT to reach another. */
const ROUTINE2 = { path: ["app", "tax_rate(integer)"], name: "tax_rate", kind: "function" };

const readableDocument = {
  path: ROUTINE.path,
  kind: "function",
  parts: [
    { id: "definition", label: "Function", text: DEFINITION, language: "sql", form: "complete", origin: "stored" },
  ],
} as unknown as ObjectSourceDocument;

const realFetch = globalThis.fetch;
let requested: string[] = [];
let installedFetch: typeof globalThis.fetch | undefined;

/** Every request the workspace issues, by pathname, so a read that went to a route is visible. */
function installFetch(): void {
  requested = [];
  installedFetch = mock(async (url: string | URL) => {
    requested.push(new URL(String(url), "http://localhost:3000").pathname);
    return Response.json({ error: "no route here" }, { status: 404 });
  }) as never;
  globalThis.fetch = installedFetch;
}

/** The tree half every test needs, with no source method on it. */
function treeReader(): WorkspaceObjectReader {
  return {
    listContainers: async () => [{ path: ["app"], level: 0, name: "app", isSessionDefault: true }],
    countObjects: async () => ({ table: { count: 1 }, function: { count: 1 }, sequence: { count: 1 } }),
    listObjects: async (_id, _container, kind) => {
      if (kind === "table") return [TABLE];
      if (kind === "sequence") return [SEQUENCE];
      return [ROUTINE, ROUTINE2];
    },
  };
}

/**
 * Mounts the shell, and optionally collects every statement the host was asked to execute.
 *
 * The collector is what makes "activates as a query" an assertion about a QUERY rather than
 * about a tab name: this shell runs nothing itself, so the only observable that a statement ran
 * is the host callback it went out through.
 */
/**
 * The element, so a test can RE-RENDER it with a different host and watch the shell react.
 *
 * `declared: null` is a host that published no capabilities for the connection, which is the
 * state the adapter reports as `metadata === null`, and it is a real adopter shape rather than
 * an invented one: `capabilities` is optional on the published connection type.
 */
function workspace(options: {
  reader: WorkspaceObjectReader;
  executed?: string[];
  declared?: ProviderCapabilities | null;
  /**
   * An EMPTY host connection list, which is the one way this shell reaches a null active
   * connection: `use-connection-adapter.ts` auto-selects whenever the list is non-empty, so
   * `activeConnection === null` means exactly "the host handed no connections", which a host
   * does when a person deletes the last one in the host's own UI while a Source tab is open.
   */
  connections?: "none";
}) {
  const declared = options.declared === undefined ? capabilities : options.declared;
  return (
    <StudioWorkspace
      connections={
        options.connections === "none"
          ? []
          : [
              {
                id: "host-conn-1",
                name: "Adopter DB",
                type: "postgres",
                ...(declared === null ? {} : { capabilities: declared }),
              },
            ]
      }
      onQueryExecute={async (_connectionId, query) => {
        options.executed?.push(query);
        return { rows: [], fields: [], rowCount: 0, executionTime: 1 };
      }}
      onSchemaFetch={async () => []}
      onObjectsFetch={options.reader}
    />
  );
}

function renderWorkspace(reader: WorkspaceObjectReader, executed?: string[]) {
  return render(workspace({ reader, executed }));
}

function row(name: string | RegExp): HTMLElement {
  return screen.getByRole("treeitem", { name });
}

/** Opens all three folders of the one container the host marked as the session default. */
async function openTree(): Promise<void> {
  await screen.findByRole("treeitem", { name: /Functions/ });
  await userEvent.click(row(/Functions/));
  await waitFor(() => expect(screen.getByText("order_total")).toBeTruthy());
  await userEvent.click(row(/Tables/));
  await waitFor(() => expect(screen.getByText("orders")).toBeTruthy());
  await userEvent.click(row(/Sequences/));
  await waitFor(() => expect(screen.getByText("order_id_seq")).toBeTruthy());
}

function menuItems(): string[] {
  return within(screen.getByRole("menu"))
    .getAllByRole("menuitem")
    .map((item) => item.textContent ?? "");
}

function tabNames(): string[] {
  return screen.getAllByRole("tab").map((tab) => tab.textContent ?? "");
}

async function viewSource(name: RegExp = /order_total/): Promise<void> {
  fireEvent.contextMenu(row(name));
  await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "View Source" }));
}

/** The editor's current buffer, which is the ACTIVE part's text and nothing else. */
function shownText(): string {
  return (screen.getByTestId("source-editor") as HTMLTextAreaElement).value;
}

beforeEach(() => {
  localStorage.clear();
  installFetch();
});

/**
 * The B76 guard, and it runs after EVERY test rather than only in the four that named it.
 *
 * MEASURED before it was widened (fix round 1): `requested` was printed from this hook whenever
 * it was non-empty and the whole file ran 18 pass 0 fail with NOT ONE LINE printed, so
 * `globalThis.fetch` is never called at all here. The earlier per-test form filtered to
 * `/api/db/objects` and reported the earlier round's justification for the narrowing, that the
 * workspace legitimately fetches other things while a tree is on screen. It does not, and the
 * narrowing cost real cover: a Source read that went out under a base-path prefix, under a
 * renamed route, or as a provider-meta or storage-config read pulled in by the viewer would all
 * have passed the filtered form, which is the same shape as the regression this file exists to
 * prevent. The package ships NO API routes, so the honest assertion is that no route is asked at
 * all.
 *
 * The throw above it is what stops this from certifying nothing: an assertion over `requested`
 * is vacuously true for a test that never installed the probe, so the probe's own identity is
 * checked and named before the array is read.
 */
afterEach(() => {
  const probe = globalThis.fetch;
  cleanup();
  globalThis.fetch = realFetch;
  if (installedFetch === undefined || probe !== installedFetch) {
    throw new Error("the fetch probe was not installed for this test, so its no-route guard certified nothing");
  }
  installedFetch = undefined;
  expect(requested).toEqual([]);
});

/**
 * The embedded shell's half of the object source seam (#789 Phase 2).
 *
 * CLAUDE.md's rule is the reason this file exists beside `source-tab.test.tsx`: the two shells
 * render different chrome, so a UI change verified in one is not verified in the other. This
 * one ships NO API routes, so the seam is a host callback and `globalThis.fetch` is replaced in
 * every test to prove no route is asked.
 */
describe("the embedded workspace reads an object's source through the host", () => {
  test("builds a source reader from the host's method and passes the whole surface", async () => {
    const asked: unknown[][] = [];
    renderWorkspace({
      ...treeReader(),
      readObjectSource: async (connectionId, path, kind) => {
        asked.push([connectionId, path, kind]);
        return readableDocument;
      },
    });
    await openTree();
    await viewSource();

    await waitFor(() => expect(tabNames()).toEqual(["Query 1", "Source: app.order_total(integer)"]));
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    // The connection ID, the ADDRESS the row carried and the kind, which is the whole surface.
    expect(asked).toEqual([["host-conn-1", ["app", "order_total(integer)"], "function"]]);
    const editor = screen.getByTestId("source-editor") as HTMLTextAreaElement;
    expect(editor.value).toBe(DEFINITION);
    expect(editor.getAttribute("data-language")).toBe("sql");
    expect(editor.readOnly).toBe(true);
    // The kind's own word from the declaration, and the qualified address as the name.
    expect(screen.getByTestId("object-source-kind").textContent).toBe("Function");
    expect(screen.getByTestId("object-source-name").textContent).toBe("app.order_total(integer)");
    // The control for the negative below is everything above: a definition is on screen.
    expect(requested).toEqual([]);
  });

  test("passes NO source reader and NO onViewSource when the host implements nothing", async () => {
    renderWorkspace(treeReader());
    await openTree();

    // The B76 guard. A host that implements nothing gets no affordance at all rather than an
    // action that fails: the routine row has no menu, so nothing can open a tab that could not
    // be read, and no route is asked because this package ships none.
    const routine = row(/order_total/);
    expect(routine.getAttribute("aria-haspopup")).toBeNull();
    expect(within(routine).queryByTestId("tree-row-menu-trigger")).toBeNull();
    // `true` means the page did NOT take the gesture, so the browser's own menu stands.
    expect(fireEvent.contextMenu(routine)).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByText("View Source")).toBeNull();
    expect(requested).toEqual([]);
  });

  test("activating a source-bearing row opens nothing when the host implements nothing", async () => {
    renderWorkspace(treeReader());
    await openTree();
    await userEvent.click(row(/order_total/));

    // No second tab, and no read: the activation branch is gated on the same fact the menu is.
    expect(tabNames()).toEqual(["Query 1"]);
    expect(screen.queryByTestId("object-source-view")).toBeNull();
    expect(requested).toEqual([]);
  });

  /*
   * THE NON-REGRESSION HALF, and it is wider than the round-1 form (#789 Phase 2, fix round 1).
   *
   * The brief asked for "the tree is byte-for-byte what it is today for a host that implements
   * nothing". Round 1 shipped a single relation row's three menu labels, which exercised no
   * sequence row, no container row and no counts, so a regression that altered either would have
   * passed. Byte-for-byte over rendered HTML is not the right assertion either: it would pin
   * class names and break on any styling change. What is pinned instead is every fact a reader
   * can see: the full ordered row list with its badges, and the menu of all three row shapes the
   * declaration produces. Every value below was MEASURED against this tree with a host that
   * declares no `readObjectSource`.
   */
  test("the tree's rows and badges are exactly what they are today for a host that implements nothing", async () => {
    renderWorkspace(treeReader());
    await openTree();

    // The container, its three kind folders each badged from `countObjects`, and the four object
    // rows the host listed, in the order the tree draws them.
    expect(screen.getAllByRole("treeitem").map((item) => item.textContent)).toEqual([
      "app",
      "Tables1",
      "orders",
      "Functions1",
      "order_total",
      "tax_rate",
      "Sequences1",
      "order_id_seq",
    ]);
  });

  /*
   * ONE TEST PER ROW SHAPE, and that is forced rather than chosen. The row menu is a Radix
   * context menu and it does not reopen on a second row inside one mount: measured, both a
   * second `contextMenu` after an Escape and a fresh `render` after `cleanup()` within the same
   * test left no `role="menu"` in the document, the second one even after a full `waitFor`
   * timeout. So the three shapes get three mounts, which is what the runner gives them anyway.
   *
   * View Source is absent on ALL THREE because the host declared no read. Generate Test Data is
   * absent on the relation because the declaration gives `table` no `acceptsRowWrites`. Every
   * list below was MEASURED against this tree.
   */
  test("a relation row keeps the menu it has today for a host that implements nothing", async () => {
    renderWorkspace(treeReader());
    await openTree();
    fireEvent.contextMenu(row(/orders/));
    expect(menuItems()).toEqual(["Generate Query", "Profile Table", "Generate Code"]);
  });

  test("a source-bearing routine row draws NO menu at all for a host that implements nothing", async () => {
    renderWorkspace(treeReader());
    await openTree();
    /*
     * MEASURED: with no reader, View Source is the ONLY item this tree would have offered a
     * routine, so withholding it leaves the row with no menu trigger and no menu. That is the
     * before-this-task shape, and it is the row the feature turns on: the same row with a reader
     * declared offers View Source, which the activation test above drives.
     */
    const routine = row(/order_total/);
    expect(within(routine).queryByTestId("tree-row-menu-trigger")).toBeNull();
    expect(fireEvent.contextMenu(routine)).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("a row of a kind that declares no source draws NO menu at all, with or without a reader", async () => {
    renderWorkspace(treeReader());
    await openTree();
    const sequence = row(/order_id_seq/);
    expect(within(sequence).queryByTestId("tree-row-menu-trigger")).toBeNull();
    expect(fireEvent.contextMenu(sequence)).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("a relation activates as a query and a routine activates as its source", async () => {
    const asked: unknown[][] = [];
    const executed: string[] = [];
    renderWorkspace(
      {
        ...treeReader(),
        readObjectSource: async (connectionId, path, kind) => {
          asked.push([connectionId, path, kind]);
          return readableDocument;
        },
      },
      executed,
    );
    await openTree();

    /*
     * One gesture, one behaviour per row, and the relation half is MEASURED against this shell
     * rather than assumed from the other one. `use-tab-manager.handleTableClick` opens a NEW tab
     * named after the object and runs the generated statement in it; it has never written onto
     * the active query tab. So the relation branch is pinned by all three of its observable
     * facts: a second tab under the object's own name, an ordinary query editor in it, and a
     * statement that actually went out through the host.
     */
    await userEvent.click(row(/orders/));
    await waitFor(() => expect(tabNames()).toEqual(["Query 1", "orders"]));
    await waitFor(() => expect(executed).toEqual(["SELECT * FROM app.orders LIMIT 50;"]));
    expect(screen.getByTestId("query-editor")).toBeTruthy();
    expect(screen.queryByTestId("source-editor")).toBeNull();
    // The negative that matters: activating a relation asks the host for no definition.
    expect(asked).toEqual([]);

    await userEvent.click(row(/order_total/));
    await waitFor(() => expect(tabNames()).toEqual(["Query 1", "orders", "Source: app.order_total(integer)"]));
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    expect(asked).toEqual([["host-conn-1", ["app", "order_total(integer)"], "function"]]);
    // And the routine branch runs nothing: the statement list has not moved.
    expect(executed).toEqual(["SELECT * FROM app.orders LIMIT 50;"]);
  });

  test("a Source tab shows no Run toolbar and no query editor, rather than a disabled one", async () => {
    renderWorkspace({ ...treeReader(), readObjectSource: async () => readableDocument });
    await openTree();
    /*
     * The control, before anything is opened: the ordinary tab has both.
     *
     * The Run control is named as the SHIPPED button rather than through a double. This file
     * does not mock `QueryToolbar`, unlike the standalone shell's `source-tab.test.tsx`, so the
     * real one renders: MEASURED, it is a `<Button>` reading RUN, and no component in this
     * repository sets any `title` on it. An earlier draft of this test looked for
     * `title="Execute query"`, which exists nowhere in either shell, and it failed for that
     * reason and not because the branch below was wrong.
     */
    expect(screen.getByTestId("query-editor")).toBeTruthy();
    expect(screen.getByRole("button", { name: "RUN" })).toBeTruthy();

    await viewSource();
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    expect(screen.queryByTestId("query-editor")).toBeNull();
    // Absent, not disabled: there is nothing on a definition to run.
    expect(screen.queryByRole("button", { name: "RUN" })).toBeNull();
  });

  test("the bottom panel's query loaders write into a query tab and never into a Source tab", async () => {
    /*
     * The one statement entry point in this shell that the editor pane's branch cannot cover
     * (#789 Phase 2). `BottomPanel` is rendered OUTSIDE that branch and wires this single prop
     * to both `QueryHistory`'s and `SavedQueries`' `onSelectQuery`, so without the gate a reader
     * with a definition on screen who opened History and clicked a past query wrote that
     * statement onto a tab displaying nothing, and `use-tab-manager` persisted it.
     *
     * The CONTROL is written on the ordinary tab first, so a gate that simply broke the loader
     * for everybody could not pass this.
     */
    render(workspace({ reader: { ...treeReader(), readObjectSource: async () => readableDocument } }));
    await openTree();
    act(() => (capturedBottomPanelProps.onLoadQuery as (q: string) => void)("SELECT 4;"));
    await waitFor(() => expect(screen.getByTestId("query-editor").getAttribute("data-value")).toBe("SELECT 4;"));

    await viewSource();
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    act(() => (capturedBottomPanelProps.onLoadQuery as (q: string) => void)("DROP TABLE app.orders;"));

    // The pane is untouched by the attempt.
    expect((screen.getByTestId("source-editor") as HTMLTextAreaElement).value).toBe(DEFINITION);
    expect(screen.queryByTestId("query-editor")).toBeNull();
    /*
     * And the statement did not land on the SOURCE TAB'S OWN `query` either, which is the half
     * that matters and the half a tab switch cannot see: the pane deliberately never displays
     * it, so an ungated loader writes a statement onto a tab that shows nothing and
     * `use-tab-manager` persists it. MEASURED: without this, an assertion that only switched
     * back to the query tab passed against the ungated loader, because the write landed on the
     * OTHER tab.
     *
     * READ OFF THE PANEL'S OWN `currentTab` PROP, which is the active tab itself. The earlier
     * spelling withdrew the host's reader to turn this tab back into an ordinary editor and read
     * the statement out of it; that gesture no longer exists, because a tab whose address names
     * an object now stays a definition pane and refuses instead of becoming an editable one
     * (#789, external review of PR #820). This reads the same field directly, and it is checked
     * to BE the Source tab first, so it cannot be satisfied by some other tab's empty statement.
     */
    const shownTab = capturedBottomPanelProps.currentTab as QueryTab;
    expect(shownTab.source?.path).toEqual(ROUTINE.path);
    expect(shownTab.query).toBe("");
  });

  test("a kind that declares no source is offered nothing and activates nothing", async () => {
    /*
     * The gate is the DECLARATION and never the kind id, and a sequence is the row that proves
     * it: it is not a relation, so the relation branch does not claim it, and it declares no
     * source, so the source branch must not either. Without the `kindHasSource` conjunct this
     * row would open a Source tab and ask the host for a definition the engine does not have.
     */
    const asked: unknown[][] = [];
    renderWorkspace({
      ...treeReader(),
      readObjectSource: async (connectionId, path, kind) => {
        asked.push([connectionId, path, kind]);
        return readableDocument;
      },
    });
    await openTree();

    // The CONTROL, on the row that does declare one: the same host, the same menu code.
    fireEvent.contextMenu(row(/order_total/));
    expect(menuItems()).toContain("View Source");
    await userEvent.keyboard("{Escape}");

    // MEASURED: the sequence row draws no menu AT ALL, because every item this tree offers is
    // withheld for it and View Source is the one that would have appeared. `true` means the
    // page did not take the gesture, so nothing opened.
    const sequence = row(/order_id_seq/);
    expect(within(sequence).queryByTestId("tree-row-menu-trigger")).toBeNull();
    expect(fireEvent.contextMenu(sequence)).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();

    await userEvent.click(row(/order_id_seq/));
    expect(tabNames()).toEqual(["Query 1"]);
    expect(asked).toEqual([]);
  });

  /*
   * WHAT A HOST THAT STOPS READING DEFINITIONS LEAVES BEHIND, and the first answer was wrong
   * (#789 Phase 2, external review of PR #820).
   *
   * The shell used to read the tab as an ORDINARY one whenever `conn.sourceReader` was absent,
   * and this file pinned that as correct. The reasoning was sound as far as it went: the
   * viewer's own default reader posts to `/api/db/objects/source` and this package ships no
   * routes, so the pane must never fall through to it. What it missed is what a person then
   * SEES. A Source tab's TEXT is never persisted, only its address, so the tab came back named
   * `Source: app.order_total(integer)` holding an EMPTY, EDITABLE editor with a live Run button:
   * the empty-editor hazard this whole phase exists to prevent, reached through a door nobody
   * was watching. An empty editor reads as "there is no source", and a user who types over it
   * deletes the object.
   *
   * The remedy keeps BOTH facts: the pane stays, it refuses in the viewer's own failure grammar,
   * and it offers no Run and asks no route. The fear the old branch was written around is
   * checked by this file's `afterEach`, which fails if any request went out at all.
   */
  test("a host that withdraws the read refuses in the pane rather than opening an editable one", async () => {
    /*
     * The state is "a Source tab with no text and no way to get any", and this drives it with
     * the gesture a harness CAN reach: a host whose read is still in flight when it hands over a
     * reader object that no longer declares the method. The RELOAD reaches the identical state
     * and is the one a person actually meets, because `use-tab-manager` persists a Source tab's
     * ADDRESS and never its text. It cannot be driven from here and that is measured rather than
     * assumed: `use-tab-manager.ts` computes `shouldPersistWorkspace` from
     * `process.env.NODE_ENV !== "test"` and `StudioWorkspace` passes no override, so nothing is
     * written to `localStorage` in any test in this file.
     */
    const pending = { ...treeReader(), readObjectSource: () => new Promise<never>(() => {}) };
    const view = render(workspace({ reader: pending as unknown as WorkspaceObjectReader }));
    await openTree();
    await viewSource();
    await waitFor(() => expect(screen.getByTestId("object-source-loading")).toBeTruthy());

    view.rerender(workspace({ reader: treeReader() }));

    expect(tabNames()).toEqual(["Query 1", "Source: app.order_total(integer)"]);
    // The pane says what happened, in the grammar every other failed read uses.
    await waitFor(() => expect(screen.getByTestId("object-source-failure")).toBeTruthy());
    expect(screen.getByTestId("object-source-failure-message").textContent).toBe(
      "This host no longer reads object definitions, so this definition cannot be read here.",
    );
    // NOT an editor, and NOT a Run button: the two halves of the hazard, asserted separately.
    expect(screen.queryByTestId("query-editor")).toBeNull();
    expect(screen.queryByTestId("source-editor")).toBeNull();
    expect(screen.queryByRole("button", { name: "RUN" })).toBeNull();
    // And the statement loader still refuses to write onto this tab, which is the entry point
    // outside the pane's own branch.
    act(() => (capturedBottomPanelProps.onLoadQuery as (q: string) => void)("DROP TABLE app.orders;"));
    expect(screen.queryByTestId("query-editor")).toBeNull();
  });

  test("a host that drops its last connection refuses in the pane rather than opening an editable one", async () => {
    /*
     * THE THIRD DOOR onto the empty-editor hazard, named in round 1 and left open (#789 fix
     * round 1). The pane branch was `sourceTab === undefined || conn.activeConnection === null`,
     * so a Source tab that was active when the host's connection list went empty mounted
     * `QueryToolbar` plus `QueryEditor`: a tab labelled `Source: app.order_total(integer)` over
     * an EMPTY, EDITABLE buffer with a live Run button, which is exactly the composition the
     * host-withdrawal arm above closes through the other door.
     *
     * It is REACHED and not merely admitted by the type. `use-connection-adapter.ts` auto-selects
     * whenever the list is non-empty, so a null active connection is precisely "the host handed
     * an empty connections array", and a host hands one whenever a person deletes the last
     * connection in the host's own UI. This drives that gesture directly.
     */
    /*
     * NOTHING IN HAND is the state that matters, because a definition already read stays on
     * screen by design, and this drives it with the gesture a harness can reach: a read still
     * in flight when the host's list goes empty. The RELOAD reaches the identical state and is
     * the one a person meets, because `use-tab-manager` persists a Source tab's ADDRESS and
     * never its text; it cannot be driven here, measured, because `use-tab-manager.ts` computes
     * `shouldPersistWorkspace` from `process.env.NODE_ENV !== "test"`.
     */
    const pending = { ...treeReader(), readObjectSource: () => new Promise<never>(() => {}) };
    const view = render(workspace({ reader: pending as unknown as WorkspaceObjectReader }));
    await openTree();
    await viewSource();
    await waitFor(() => expect(screen.getByTestId("object-source-loading")).toBeTruthy());

    view.rerender(workspace({ reader: pending as unknown as WorkspaceObjectReader, connections: "none" }));

    expect(tabNames()).toEqual(["Query 1", "Source: app.order_total(integer)"]);
    // The pane is still a pane, and it says what happened in the viewer's failure grammar.
    await waitFor(() => expect(screen.getByTestId("object-source-failure")).toBeTruthy());
    expect(screen.getByTestId("object-source-failure-message").textContent).toBe(
      "This connection is no longer open, so this definition cannot be read here.",
    );
    // The two halves of the hazard, asserted separately, and the tab still names the object.
    expect(screen.queryByTestId("query-editor")).toBeNull();
    expect(screen.queryByTestId("source-editor")).toBeNull();
    expect(screen.queryByRole("button", { name: "RUN" })).toBeNull();
    expect(screen.getByTestId("object-source-name").textContent).toBe("app.order_total(integer)");
  });

  test("a definition already in hand survives the host withdrawing the read", async () => {
    /*
     * The IN-SESSION shape, and it is the reason the refusal is conditioned on there being
     * nothing to show rather than on the reader alone: the definition on screen was really read
     * from the engine a moment ago, and a host handing a new reader object on a render is not a
     * reason to throw it away. What it must not become is a Run button.
     */
    const withReader = { ...treeReader(), readObjectSource: async () => readableDocument };
    const view = render(workspace({ reader: withReader }));
    await openTree();
    await viewSource();
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    view.rerender(workspace({ reader: treeReader() }));

    expect(tabNames()).toEqual(["Query 1", "Source: app.order_total(integer)"]);
    expect(shownText()).toBe(DEFINITION);
    expect(screen.queryByTestId("query-editor")).toBeNull();
    expect(screen.queryByRole("button", { name: "RUN" })).toBeNull();
  });

  test("the kind's own word comes from the declaration, and falls back to the kind id", async () => {
    /*
     * The viewer never derives a label from an id, so the shell hands it one. Both fallback
     * arms are reachable in this shell and both are driven here, because the declaration is the
     * HOST's and per connection: it can stop carrying this tab's kind, and it can be absent
     * altogether while the source read is still declared.
     */
    const reader = { ...treeReader(), readObjectSource: async () => readableDocument };
    const view = render(workspace({ reader }));
    await openTree();
    await viewSource();
    // The CONTROL: while the declaration carries the kind, its own word is used.
    await waitFor(() => expect(screen.getByTestId("object-source-kind").textContent).toBe("Function"));

    const withoutTheKind = {
      ...capabilities,
      objectKinds: capabilities.objectKinds?.filter((kind) => kind.id !== "function"),
    } as ProviderCapabilities;
    view.rerender(workspace({ reader, declared: withoutTheKind }));
    await waitFor(() => expect(screen.getByTestId("object-source-kind").textContent).toBe("function"));

    view.rerender(workspace({ reader, declared: null }));
    await waitFor(() => expect(screen.getByTestId("object-source-kind").textContent).toBe("function"));
    // Still the definition, and still captioned by the object that was asked for.
    expect(screen.getByTestId("object-source-name").textContent).toBe("app.order_total(integer)");
  });

  test("an answer that lands after a tab switch never turns a query tab into a Source tab", async () => {
    /*
     * The viewer writes its answer through `onChange` even when a tab switch has already
     * unmounted it, and its own docblock says that is wanted: the read a reader started before
     * switching away is there when they switch back. So the shell's patch writer has to be able
     * to say NO. Without the `tab.source !== undefined` conjunct the late patch spreads a
     * `source` onto whichever tab is active, and an ordinary query tab silently becomes a
     * Source tab holding a definition nobody opened.
     */
    let land: ((document: ObjectSourceDocument) => void) | undefined;
    render(
      workspace({
        reader: {
          ...treeReader(),
          readObjectSource: () =>
            new Promise<ObjectSourceDocument>((resolve) => {
              land = resolve;
            }),
        },
      }),
    );
    await openTree();
    await viewSource();
    await waitFor(() => expect(tabNames()).toEqual(["Query 1", "Source: app.order_total(integer)"]));

    // Switch away while the read is still in flight, then let it answer.
    await userEvent.click(screen.getByRole("tab", { name: "Query 1" }));
    await waitFor(() => expect(screen.getByTestId("query-editor")).toBeTruthy());
    if (land === undefined) throw new Error("the host was never asked, so this test asserts nothing");
    await act(async () => {
      land?.(readableDocument);
      await Promise.resolve();
    });

    // The query tab is still a query tab.
    expect(screen.getByTestId("query-editor")).toBeTruthy();
    expect(screen.queryByTestId("source-editor")).toBeNull();
    expect(screen.getByRole("button", { name: "RUN" })).toBeTruthy();
    // And the answer did reach the tab that asked for it, so this is not a test about a read
    // that never landed: switching back shows the definition with no second read issued.
    await userEvent.click(screen.getByRole("tab", { name: "Source: app.order_total(integer)" }));
    await waitFor(() => expect((screen.getByTestId("source-editor") as HTMLTextAreaElement).value).toBe(DEFINITION));
  });

  test("selecting a part in one Source tab does not move the selection in another", async () => {
    /*
     * Two Source tabs, each with two parts, which is the only shape that can see the patch
     * writer address the WRONG tab. `onSourceChange` maps over every tab, so without the
     * `tab.id === activeTabId` conjunct a part click writes `activePartId` onto every Source
     * tab at once and the other one silently shows a different part of its own definition.
     */
    const twoParts = (path: readonly string[], object: string) =>
      ({
        path,
        kind: "function",
        parts: [
          {
            id: "header",
            label: "Header",
            text: `-- header of ${object}`,
            language: "sql",
            form: "partial",
            origin: "stored",
          },
          {
            id: "body",
            label: "Body",
            text: `-- body of ${object}`,
            language: "sql",
            form: "partial",
            origin: "stored",
          },
        ],
      }) as unknown as ObjectSourceDocument;

    renderWorkspace({
      ...treeReader(),
      readObjectSource: async (_id, path) => twoParts(path, path[path.length - 1]),
    });
    await openTree();

    await viewSource(/order_total/);
    await waitFor(() => expect(shownText()).toBe("-- header of order_total(integer)"));
    await viewSource(/tax_rate/);
    await waitFor(() => expect(shownText()).toBe("-- header of tax_rate(integer)"));

    // The CONTROL: the click does move the selection in the tab it was made in.
    await userEvent.click(screen.getByRole("tab", { name: "Body" }));
    await waitFor(() => expect(shownText()).toBe("-- body of tax_rate(integer)"));

    await userEvent.click(screen.getByRole("tab", { name: "Source: app.order_total(integer)" }));
    await waitFor(() => expect(screen.getByTestId("object-source-name").textContent).toBe("app.order_total(integer)"));
    expect(shownText()).toBe("-- header of order_total(integer)");
  });

  test("a definition read at token zero is never marked stale", async () => {
    renderWorkspace({ ...treeReader(), readObjectSource: async () => readableDocument });
    await openTree();
    await viewSource();
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    // This shell counts no DDL, so it reports the one token it has for the whole session and
    // the tab cannot go stale against itself.
    expect(screen.queryByTestId("object-source-stale")).toBeNull();
  });

  /*
   * A HOST IS NOT A PROMISE FACTORY, and the two shapes below are the ones a declared
   * `Promise<ObjectSourceDocument>` does not buy at runtime (#789 Phase 2, fix round 1).
   *
   * Both reach the viewer's read effect, which does `(reader ?? httpSourceReader)(...).then(...)`.
   * A reader that throws BEFORE returning throws inside the effect, and a reader that returns a
   * non-thenable makes `.then` a `TypeError` in the same place. Neither is a rejected promise, so
   * neither reaches the viewer's error arm: measured on the round-1 adapter, the first escaped as
   * an uncaught `Error` out of `commitHookEffectListMount` and the second as
   * `TypeError: undefined is not an object`, and in a real adopter that is a render-phase throw
   * taking the host's whole page down rather than one tab.
   *
   * The adopter shape that produces the first is ordinary: `readObjectSource(id, path, kind) {
   * return this.clients[id].readSource(path, kind); }` against a connection whose client has not
   * been built yet dereferences `undefined` before any await.
   */
  test("a host that throws BEFORE returning a promise is a failed read, not a crash", async () => {
    renderWorkspace({
      ...treeReader(),
      // Deliberately not `async`: an `async` method could not produce this shape at all.
      readObjectSource: (() => {
        throw new Error("The tenant's client was never built");
      }) as WorkspaceObjectReader["readObjectSource"],
    });
    await openTree();
    await viewSource();

    await waitFor(() => expect(screen.getByTestId("object-source-failure")).toBeTruthy());
    expect(screen.getByTestId("object-source-failure-message").textContent).toBe("The tenant's client was never built");
    expect(screen.queryByTestId("source-editor")).toBeNull();
    // The rest of the shell is still mounted, which is the half that says this was one tab's
    // failure rather than the workspace coming down.
    expect(screen.getByRole("treeitem", { name: /order_total/ })).toBeTruthy();
  });

  test("a host that returns something that is not a promise is a failed read, not a crash", async () => {
    renderWorkspace({
      ...treeReader(),
      readObjectSource: (() => undefined) as unknown as WorkspaceObjectReader["readObjectSource"],
    });
    await openTree();
    await viewSource();

    await waitFor(() => expect(screen.getByTestId("object-source-failure")).toBeTruthy());
    // Not the host's own sentence, because there is none: a non-thenable answer is a body the
    // viewer cannot render, and it is reported in that grammar.
    expect(screen.getByTestId("object-source-failure-message").textContent).toBe(
      "The source read answered with a body this viewer cannot render.",
    );
    expect(screen.queryByTestId("source-editor")).toBeNull();
    expect(screen.getByRole("treeitem", { name: /order_total/ })).toBeTruthy();
  });

  test("reports the host's own sentence when its read raises", async () => {
    renderWorkspace({
      ...treeReader(),
      readObjectSource: async () => {
        throw new Error("The tenant's warehouse is asleep");
      },
    });
    await openTree();
    await viewSource();

    await waitFor(() => expect(screen.getByTestId("object-source-failure")).toBeTruthy());
    expect(screen.getByTestId("object-source-failure-message").textContent).toBe("The tenant's warehouse is asleep");
    expect(screen.queryByTestId("source-editor")).toBeNull();
  });
});

/**
 * A host is ordinary JavaScript, so its declared return type is not a runtime guarantee.
 *
 * Three shapes are refused BY NAME here, and each one is a pair of facts collapsing into one
 * rather than a malformed value: a part carrying both a text and a refusal narrows to the
 * refusal and drops the definition; a refusal whose sentence says nothing draws the headline
 * over a blank line; an empty text is not a definition and an editor holding one is the shape
 * this whole surface exists to prevent. Nothing type-checks a host and the provider conformance
 * helper never runs against one, so this seam is where they are caught (#789 Phase 2).
 */
describe("a host document that fails the shape check is a failed read, not a render", () => {
  const UNRENDERABLE = "The source read answered with a body this viewer cannot render.";

  async function readAnswering(document: unknown): Promise<void> {
    renderWorkspace({ ...treeReader(), readObjectSource: async () => document as ObjectSourceDocument });
    await openTree();
    await viewSource();
    await waitFor(() => expect(screen.getByTestId("object-source-failure")).toBeTruthy());
  }

  test("a part carrying BOTH a text and a refusal", async () => {
    await readAnswering({
      path: ROUTINE.path,
      kind: "function",
      parts: [
        {
          id: "definition",
          label: "Function",
          text: DEFINITION,
          unavailable: "This user may not read the body.",
          language: "sql",
          form: "complete",
          origin: "stored",
        },
      ],
    });
    expect(screen.getByTestId("object-source-failure-message").textContent).toBe(UNRENDERABLE);
    // Neither half of the collapse is drawn: no editor holding the text, and no refusal pane
    // attributing a sentence to a definition the host also sent.
    expect(screen.queryByTestId("source-editor")).toBeNull();
    expect(screen.queryByTestId("object-source-refused")).toBeNull();
  });

  test("a refusal whose sentence is whitespace", async () => {
    await readAnswering({
      path: ROUTINE.path,
      kind: "function",
      parts: [{ id: "definition", label: "Function", unavailable: "   " }],
    });
    expect(screen.getByTestId("object-source-failure-message").textContent).toBe(UNRENDERABLE);
    expect(screen.queryByTestId("object-source-refused")).toBeNull();
  });

  test("a readable part whose text is empty", async () => {
    await readAnswering({
      path: ROUTINE.path,
      kind: "function",
      parts: [{ id: "definition", label: "Function", text: "", language: "sql", form: "complete", origin: "stored" }],
    });
    expect(screen.getByTestId("object-source-failure-message").textContent).toBe(UNRENDERABLE);
    // The one rule this surface exists for: an unreadable source never opens an empty editor.
    expect(screen.queryByTestId("source-editor")).toBeNull();
  });

  /*
   * RECIPE RULE 12 BINDS THIS SHELL DIFFERENTLY FROM A PROVIDER, and the answer moved once
   * (#789 Phase 2, external review of PR #820).
   *
   * The rule asks a provider to assert that a REFUSAL DOCUMENT carries its own identity, because
   * a refusal builder that hardcodes a path attributes the sentence to the wrong object. Here the
   * document comes from a HOST, so asserting the fixture's own identity would be circular.
   * MEASURED on the round-1 form of this test: a host answering `path: ["MUTANT"], kind:
   * "MUTANTKIND"` left it at 1 pass 0 fail with 8 expect calls, because `ObjectSourceView` never
   * dereferenced `document.path` or `document.kind` at all and `StudioWorkspace` captions from
   * the TAB ADDRESS. The conclusion drawn then was that the caption was the whole invariant.
   *
   * THAT WAS HALF OF IT. The caption being right is necessary and not sufficient: the pane was
   * still DRAWING another object's document under this object's name, with nothing on screen
   * saying so, which is the fault `search` and `mongodb` were fixed for one level down. The
   * viewer now checks the document's own address and reports a mismatch as a FAILED READ, and
   * both halves are driven here: the sentence says the read answered for another object, and the
   * caption still names the object the row asked for.
   */
  test("a document claiming another object is a failed read, captioned by the object ASKED for", async () => {
    const asked: unknown[][] = [];
    renderWorkspace({
      ...treeReader(),
      readObjectSource: async (id, path, kind) => {
        asked.push([id, path, kind]);
        return {
          // Deliberately NOT the request: a host is ordinary JavaScript and this is the shape
          // that attributes a definition or a refusal to the wrong object.
          path: ["other_schema", "somebody_elses_function(text)"],
          kind: "procedure",
          parts: [{ id: "definition", label: "Function", unavailable: "The definition is wrapped." }],
        } as unknown as ObjectSourceDocument;
      },
    });
    await openTree();
    await viewSource();

    await waitFor(() => expect(screen.getByTestId("object-source-failure")).toBeTruthy());
    expect(screen.getByTestId("object-source-failure-message").textContent).toBe(
      "The source read answered with a definition for another object.",
    );
    // The host's sentence is NOT drawn, because it is about an object nobody opened.
    expect(screen.queryByTestId("object-source-refused")).toBeNull();
    // The pane is still captioned by the object that was ASKED for.
    expect(screen.getByTestId("object-source-name").textContent).toBe("app.order_total(integer)");
    expect(screen.getByTestId("object-source-kind").textContent).toBe("Function");
    expect(screen.queryByTestId("source-editor")).toBeNull();
    // And the address the host was handed is that same object, so the caption is not right by
    // accident while the read went somewhere else.
    expect(asked).toEqual([["host-conn-1", ["app", "order_total(integer)"], "function"]]);
  });
});
