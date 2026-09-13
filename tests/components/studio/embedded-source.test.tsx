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

/** Every request the workspace issues, by pathname, so a read that went to a route is visible. */
function installFetch(): void {
  requested = [];
  globalThis.fetch = mock(async (url: string | URL) => {
    requested.push(new URL(String(url), "http://localhost:3000").pathname);
    return Response.json({ error: "no route here" }, { status: 404 });
  }) as never;
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
}) {
  const declared = options.declared === undefined ? capabilities : options.declared;
  return (
    <StudioWorkspace
      connections={[
        {
          id: "host-conn-1",
          name: "Adopter DB",
          type: "postgres",
          ...(declared === null ? {} : { capabilities: declared }),
        },
      ]}
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

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
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
    expect(requested.filter((path) => path.startsWith("/api/db/objects"))).toEqual([]);
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
    expect(requested.filter((path) => path.startsWith("/api/db/objects"))).toEqual([]);
  });

  test("activating a source-bearing row opens nothing when the host implements nothing", async () => {
    renderWorkspace(treeReader());
    await openTree();
    await userEvent.click(row(/order_total/));

    // No second tab, and no read: the activation branch is gated on the same fact the menu is.
    expect(tabNames()).toEqual(["Query 1"]);
    expect(screen.queryByTestId("object-source-view")).toBeNull();
    expect(requested.filter((path) => path.startsWith("/api/db/objects"))).toEqual([]);
  });

  test("the tree's other rows are what they are today for a host that implements nothing", async () => {
    renderWorkspace(treeReader());
    await openTree();

    // The relation row keeps the menu it already had, so the absence above is the source item
    // alone rather than the row menu collapsing.
    fireEvent.contextMenu(row(/orders/));
    // MEASURED against the tree as it stands before this task: three items, and Generate Test
    // Data is absent because the declaration above gives `table` no `acceptsRowWrites`.
    expect(menuItems()).toEqual(["Generate Query", "Profile Table", "Generate Code"]);
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
    const view = render(workspace({ reader: { ...treeReader(), readObjectSource: async () => readableDocument } }));
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
     * OTHER tab. Withdrawing the host's read turns this same tab into an ordinary editor tab,
     * which is the one gesture in this shell that makes its statement visible.
     */
    view.rerender(workspace({ reader: treeReader() }));
    await waitFor(() => expect(screen.getByTestId("query-editor")).toBeTruthy());
    expect(screen.getByTestId("query-editor").getAttribute("data-value")).toBe("");
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

  test("a host that withdraws the read leaves the tab it already opened as an ordinary one", async () => {
    /*
     * Not defensive, and this is the gesture that reaches it without persistence: the host is
     * ordinary JavaScript and may hand a different reader object on any render, including one
     * that no longer declares `readObjectSource`. `use-tab-manager` also persists a Source
     * tab's ADDRESS across sessions, so the same state arrives on a reload.
     *
     * The pane, the toolbar and every statement entry point then have to agree about ONE fact,
     * because the viewer's own default reader is this application's route and this package
     * ships none. Reading the tab as an ordinary one is what makes them agree.
     */
    const withReader = { ...treeReader(), readObjectSource: async () => readableDocument };
    const view = render(workspace({ reader: withReader }));
    await openTree();
    await viewSource();
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());

    view.rerender(workspace({ reader: treeReader() }));

    // The tab is still there and still active, and it is now an ordinary editor tab.
    expect(tabNames()).toEqual(["Query 1", "Source: app.order_total(integer)"]);
    expect(screen.queryByTestId("source-editor")).toBeNull();
    expect(screen.getByTestId("query-editor")).toBeTruthy();
    expect(screen.getByRole("button", { name: "RUN" })).toBeTruthy();
    // The whole point: nothing fell through to a route, because there is none here.
    expect(requested.filter((path) => path.startsWith("/api/db/objects"))).toEqual([]);
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

  test("a refusal document carries its OWN identity, and it is the one that was asked for", async () => {
    renderWorkspace({
      ...treeReader(),
      readObjectSource: async (_id, path, kind) =>
        ({
          path,
          kind,
          parts: [{ id: "definition", label: "Function", unavailable: "The definition is wrapped." }],
        }) as unknown as ObjectSourceDocument,
    });
    await openTree();
    await viewSource();

    await waitFor(() => expect(screen.getByTestId("object-source-refused")).toBeTruthy());
    expect(screen.getByTestId("object-source-refused-message").textContent).toBe("The definition is wrapped.");
    // The pane is captioned by the object that was ASKED for, so a refusal cannot be attributed
    // to a different object than the row it was opened from.
    expect(screen.getByTestId("object-source-name").textContent).toBe("app.order_total(integer)");
    expect(screen.getByTestId("object-source-kind").textContent).toBe("Function");
    expect(screen.queryByTestId("source-editor")).toBeNull();
  });
});
