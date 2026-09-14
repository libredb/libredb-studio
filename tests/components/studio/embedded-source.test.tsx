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
/**
 * The pane's own `onChange`, captured from the double so a test can drive a KEYSTROKE.
 *
 * The round-1 double swallowed the change event, so nothing in this file could move the pane's
 * buffer, and the one prop that only a moved buffer can defend, `dirty`, went undefended (fix
 * round 1, finding 5). The real editor calls `props.onChange(nextText)`; the double forwards the
 * textarea's own change to it, which is the same call. `ObjectSourceView.test.tsx` captures the
 * callback the same way and for the same reason.
 */
const editorProbe: { change?: (value: string | undefined) => void } = {};

mock.module("@monaco-editor/react", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    default: function MockEditor(props: {
      value?: string;
      language?: string;
      options?: Record<string, unknown>;
      onChange?: (value: string | undefined) => void;
    }) {
      editorProbe.change = props.onChange;
      return React.createElement("textarea", {
        "data-testid": "source-editor",
        "data-language": props.language,
        readOnly: (props.options as Record<string, unknown> | undefined)?.readOnly === true,
        value: props.value ?? "",
        onChange: () => {},
      });
    },
    loader: { init: () => Promise.resolve(), config: () => {}, __getMonacoInstance: () => null },
    /*
     * `DiffEditor` is the apply preview's surface (#789 Phase 3). A double that omits an export
     * the real module HAS does not degrade, it throws: bun answers `SyntaxError: Export named
     * 'DiffEditor' not found` and fails the WHOLE FILE the moment the pane's module graph reaches
     * the preview, so this file would die without ever rendering a diff. Measured 2026-09-14 on
     * the standalone shell's suite, which carries the same double for the same reason.
     */
    DiffEditor: function MockDiffEditor(props: { original?: string; modified?: string; language?: string }) {
      return React.createElement("div", {
        "data-testid": "mock-monaco-diff-editor",
        "data-language": props.language,
        "data-original": props.original ?? "",
        "data-modified": props.modified ?? "",
      });
    },
  };
});

/**
 * The viewer's own props, captured while the REAL viewer still renders underneath (#789 Phase 3).
 *
 * `refreshToken` is the reason this exists. It is a number this shell hands the viewer and the
 * viewer turns into a stale banner or into nothing, so every indirect observation of it is an
 * observation of the banner instead, and the banner is absent both when the counter has not moved
 * and when the shell forgot to pass one at all. The brief asks for the value, so the value is what
 * is asserted, and the banner is asserted separately as the consequence a reader actually sees.
 *
 * The barrel is doubled rather than the module, because the shell imports `ObjectSourceView`
 * through `@/components/object-source`, and the two other value exports are spread back in from
 * their own modules so that anything else reaching this barrel gets the real thing.
 */
let capturedSourceViewProps: Record<string, unknown> = {};
mock.module("@/components/object-source", () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const React = require("react");
  const { ObjectSourceView } = require("@/components/object-source/ObjectSourceView");
  const applier = require("@/components/object-source/source-applier");
  const reader = require("@/components/object-source/source-reader");
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    ...applier,
    ...reader,
    ObjectSourceView: (props: Record<string, unknown>) => {
      capturedSourceViewProps = props;
      return React.createElement(ObjectSourceView, props);
    },
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
import type {
  ObjectEditBuild,
  ObjectEditConsequenceClass,
  ObjectEditOutcome,
  ObjectEditPlan,
  ObjectEditRequest,
  ObjectSourceDocument,
  ProviderCapabilities,
} from "@/lib/db/types";
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

/**
 * The embedded shell's half of the object APPLY seam (#789 Phase 3, from discussion #778).
 *
 * THE HOST'S ANSWER IS THE ONLY THING THERE IS on this shell. The standalone shell posts to two
 * routes of its own and every value it renders has been through a handler that bounded it; here
 * there is no route, no plan token and no server, and a `build` that answers a plan is a plain
 * JavaScript object an adopter constructed. So every test below drives the host's own object,
 * and this file's `afterEach` proves that no request went out while it did.
 *
 * What is REAL here: the adapter, the tab manager, the pane, the editability predicate, the draft
 * store and the preview dialog. Only the host is a double, which is what a host is.
 */
const EDITABLE_DOCUMENT = {
  path: ROUTINE.path,
  kind: "function",
  parts: [
    {
      id: "definition",
      label: "Function",
      text: DEFINITION,
      language: "sql",
      form: "complete",
      origin: "stored",
      // The affordance travels with the READ, from the party that answered it, which on this
      // shell is the host. Nothing here consults a declaration, and that is D57 by construction.
      edit: { offered: true },
    },
  ],
} as unknown as ObjectSourceDocument;

/**
 * A plan of the shape `isObjectEditPlanShape` accepts, and its single user segment spans the whole
 * step text on purpose: `spansTheText` in `src/lib/api/object-edit-wire.ts` refuses a plan whose
 * segments laid end to end fall short of `text.length`, so a short segment would make every
 * preview below silently exercise the pane's UNREADABLE arm while reading as the happy path.
 */
const STEP_TEXT = "CREATE FUNCTION app.order_total(integer) RETURNS numeric AS $$ SELECT 2 $$;";

const PLAN = {
  planVersion: 1,
  planId: "host-plan-1",
  issuedAt: "2026-09-14T00:00:00.000Z",
  connectionFingerprint: "host-fingerprint",
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
} as unknown as ObjectEditPlan;

/**
 * What the host answers a build with, and it is an `ObjectEditBuild` and NOT the route's
 * `ObjectEditBuildResponse`: a host holds no key, so there is no `planToken` on this path and the
 * published type it is declared against cannot name an unpublished wire type anyway.
 */
const BUILT = {
  built: true,
  plan: PLAN,
  preimage: { text: DEFINITION, language: "sql" },
} as unknown as ObjectEditBuild;
const APPLIED = { outcome: "applied", revision: PLAN.revision, duration: 3 } as unknown as ObjectEditOutcome;

type HostEditor = NonNullable<WorkspaceObjectReader["objectEditor"]>;

/** A host that reads definitions and, optionally, edits them. */
function editingReader(objectEditor?: HostEditor, document: ObjectSourceDocument = EDITABLE_DOCUMENT) {
  return {
    ...treeReader(),
    readObjectSource: async () => document,
    ...(objectEditor === undefined ? {} : { objectEditor }),
  } as WorkspaceObjectReader;
}

async function click(testId: string): Promise<void> {
  await act(async () => {
    (screen.getByTestId(testId) as HTMLElement).click();
    await Promise.resolve();
  });
}

/** Open the routine's Source tab and wait until its definition is on screen. */
async function openSourceTab(): Promise<void> {
  await openTree();
  await viewSource();
  await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
}

/** Mount a host, open the tab, and take the two gestures that reach the preview: Edit, Preview. */
async function previewThrough(objectEditor: HostEditor): Promise<void> {
  render(workspace({ reader: editingReader(objectEditor) }));
  await openSourceTab();
  await click("object-source-edit");
  await waitFor(() => expect(screen.getByTestId("object-source-preview")).toBeTruthy());
  await click("object-source-preview");
}

/** The whole reader-visible round trip: Edit, Preview, Confirm, and the dialog gone. */
async function applySuccessfullyThroughTheHost(objectEditor: HostEditor): Promise<void> {
  await previewThrough(objectEditor);
  await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());
  await click("object-source-apply-confirm");
  await waitFor(() => expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull());
}

function refreshTokenPassedToTheViewer(): unknown {
  return capturedSourceViewProps.refreshToken;
}

describe("the embedded workspace applies an object edit through the host", () => {
  test("AN EXISTING ADOPTER THAT DOES NOTHING SEES NO CHANGE", async () => {
    /*
     * The whole non-regression claim of this phase on this shell, and it is asserted rather than
     * argued. The document is the EDITABLE one, so the absence below is caused by the host having
     * declared no `objectEditor` and by nothing else: with a non-editable part the same assertions
     * would pass over a shell that always passes an applier.
     */
    render(workspace({ reader: editingReader(undefined) }));
    await openSourceTab();

    expect(screen.queryByTestId("object-source-edit-bar")).toBeNull();
    expect(screen.queryByTestId("object-source-edit")).toBeNull();
    expect((screen.getByTestId("source-editor") as HTMLTextAreaElement).readOnly).toBe(true);
    expect(refreshTokenPassedToTheViewer()).toBe(0);
    expect(screen.queryByTestId("object-source-stale")).toBeNull();
  });

  test("a host with an editor gets the bar, and both methods are called BOUND", async () => {
    /*
     * A method read off an object as a value and called with no receiver loses whatever it reaches
     * through `this`, which is the same fault `sourceReader`'s docblock already records for the
     * read seam. Both methods here answer through `this`, so an unbound call throws a TypeError
     * before returning and the dialog below is never drawn.
     */
    const asked: unknown[][] = [];
    const boundHost = {
      answer: BUILT,
      outcome: APPLIED,
      build(connectionId: string, request: ObjectEditRequest): Promise<ObjectEditBuild> {
        asked.push(["build", connectionId, request.path, request.kind, request.partId]);
        return Promise.resolve(this.answer);
      },
      apply(
        connectionId: string,
        plan: ObjectEditPlan,
        acknowledged: readonly ObjectEditConsequenceClass[],
      ): Promise<ObjectEditOutcome> {
        asked.push(["apply", connectionId, plan.planId, acknowledged]);
        return Promise.resolve(this.outcome);
      },
    };

    render(workspace({ reader: editingReader(boundHost) }));
    await openSourceTab();
    expect(screen.getByTestId("object-source-edit-bar")).toBeTruthy();

    await click("object-source-edit");
    await waitFor(() => expect(screen.getByTestId("object-source-preview")).toBeTruthy());
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-dialog")).toBeTruthy());
    await click("object-source-apply-confirm");
    await waitFor(() => expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull());

    // The connection ID, the address, the kind and the part: the whole surface, on both methods.
    expect(asked).toEqual([
      ["build", "host-conn-1", ["app", "order_total(integer)"], "function", "definition"],
      ["apply", "host-conn-1", "host-plan-1", []],
    ]);
  });

  test("a host that THROWS before returning costs ONE TAB and not the adopter's page", async () => {
    /*
     * MEASURED on the plain-arrow form of the READ seam: a host that threw gave an uncaught Error
     * out of `commitHookEffectListMount`, and a host that returned `undefined` gave
     * `TypeError: undefined is not an object (evaluating '...then')` at the same place. Both are
     * render-phase throws that take an adopter's whole page down rather than one tab, and the
     * apply seam is reached from an event handler rather than an effect, which is a different
     * call site with the same two shapes.
     */
    await previewThrough({
      build: (() => {
        throw new Error("host is broken");
      }) as unknown as HostEditor["build"],
      apply: async () => APPLIED,
    });

    await waitFor(() => expect(screen.getByTestId("object-source-edit-refused")).toBeTruthy());
    expect(screen.getByTestId("object-source-edit-refused").getAttribute("data-refusal")).toBe("request");
    expect(screen.getByTestId("object-source-edit-refused").textContent).toContain("host is broken");
    expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull();
    // The page is still rendered, which is the half that says this cost one tab.
    expect(screen.getByRole("treeitem", { name: /order_total/ })).toBeTruthy();
    expect(screen.getByTestId("source-editor")).toBeTruthy();
  });

  test("a host that returns a NON-THENABLE is a failed apply and not a crash", async () => {
    await previewThrough({
      build: (() => undefined) as unknown as HostEditor["build"],
      apply: async () => APPLIED,
    });

    await waitFor(() => expect(screen.getByTestId("object-source-edit-refused")).toBeTruthy());
    // Not the host's own sentence, because there is none: an answer that is not a build response
    // is refused in the pane's own grammar, and nothing was sent.
    expect(screen.getByTestId("object-source-edit-refused").getAttribute("data-refusal")).toBe("unreadable");
    expect(screen.getByTestId("object-source-edit-refused").textContent).toContain(
      "The apply preview could not be read, so nothing was previewed and nothing was sent.",
    );
    expect(screen.getByRole("treeitem", { name: /order_total/ })).toBeTruthy();
  });

  test("a host's malformed PLAN and malformed OUTCOME are both refused at the seam", async () => {
    /*
     * The browser probe made the trust boundary concrete: its own stub host declared `package` and
     * the shell drew a `Packages 1` folder for it, against the same MariaDB whose packages the
     * standalone shell could not see. NOTHING VERIFIES A HOST, so a host's plan is narrowed by
     * `isObjectEditPlanShape` and its outcome by `isObjectEditOutcomeShape` before either is drawn.
     *
     * Both halves are driven here because they fail in different places and produce different
     * sentences: a malformed plan never opens the dialog at all, and a malformed outcome opens it
     * and then cannot say whether the change landed.
     */
    const malformedPlan = { ...PLAN, revision: { check: "unavailable", reason: "none", token: "t1" } };
    render(
      workspace({
        reader: editingReader({
          build: async () =>
            ({
              built: true,
              plan: malformedPlan,
              preimage: { text: DEFINITION, language: "sql" },
            }) as unknown as ObjectEditBuild,
          apply: async () => APPLIED,
        }),
      }),
    );
    await openSourceTab();
    await click("object-source-edit");
    await waitFor(() => expect(screen.getByTestId("object-source-preview")).toBeTruthy());
    await click("object-source-preview");
    // A revision that says "no check was possible" while carrying a token is the two-state
    // collapse the predicate refuses, and the dialog is never drawn over it.
    await waitFor(() => expect(screen.getByTestId("object-source-edit-refused")).toBeTruthy());
    expect(screen.getByTestId("object-source-edit-refused").getAttribute("data-refusal")).toBe("unreadable");
    expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull();
    // A second host in one test, because the two halves are two different refusals.
    cleanup();

    await previewThrough({
      build: async () => BUILT,
      apply: async () => ({ outcome: "applied", revision: PLAN.revision }) as unknown as ObjectEditOutcome,
    });
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());
    await click("object-source-apply-confirm");
    // An outcome with no duration is not an outcome. The reader is told the answer could not be
    // read rather than that the change landed.
    await waitFor(() => expect(screen.getByTestId("object-source-apply-failure")).toBeTruthy());
    expect(screen.getByTestId("object-source-apply-failure").textContent).toContain(
      "The apply was sent and its answer could not be read",
    );
    expect(refreshTokenPassedToTheViewer()).toBe(0);
  });

  test("a host plan addressed to ANOTHER object is refused, and the host's apply is never called", async () => {
    /*
     * THE SECOND HALF OF THE EXTERNAL REVIEW OF PR #831, and this shell is where it bites hardest.
     * `isObjectEditPlanShape` answers whether a value IS a plan. It cannot answer whether the plan
     * is a plan for the object whose text the reader just edited, and on this seam there is nothing
     * else that could: the standalone shell has a server-minted token whose fingerprint and address
     * the apply route re-derives, and here there is no token, no route and no server. The host's
     * answer is the seal.
     *
     * So a host whose `build` is merely MISTAKEN, answering the previous tab's plan out of a cache
     * or losing a race between two open Source tabs, gets the reader's text for object A written
     * over object B, having shown them object A's diff the whole way. That is ruling 1a's own claim
     * failing on its own terms: the address is part of what was approved.
     *
     * THE READ SEAM ALREADY DOES THIS. `namesThisObject` in
     * `src/components/object-source/ObjectSourceView.tsx` refuses a DOCUMENT whose path and kind
     * are not the ones that were asked for, and its docblock records why: without it the wrong
     * object renders under the asked-for name with nothing on screen saying so. The BUILD seam has
     * no equivalent, which is the gap.
     *
     * Three cases and not one, because the address has three components and a predicate that
     * checked only the path would pass a one-case test while leaving two ways through. Each is a
     * separate mount with a `cleanup()` between, which is this file's own pattern.
     */
    const elsewhere: readonly { readonly label: string; readonly plan: ObjectEditPlan }[] = [
      { label: "another path", plan: { ...PLAN, path: ["app", "order_tax(integer)"] } as ObjectEditPlan },
      { label: "another kind", plan: { ...PLAN, kind: "procedure" } as unknown as ObjectEditPlan },
      { label: "another part", plan: { ...PLAN, partId: "header" } as unknown as ObjectEditPlan },
    ];

    for (const { label, plan } of elsewhere) {
      const applied: string[] = [];
      render(
        workspace({
          reader: editingReader({
            build: async () =>
              ({ built: true, plan, preimage: { text: DEFINITION, language: "sql" } }) as ObjectEditBuild,
            apply: async (_connectionId: string, sent: ObjectEditPlan) => {
              applied.push(sent.planId);
              return APPLIED;
            },
          }),
        }),
      );
      await openSourceTab();
      await click("object-source-edit");
      await waitFor(() => expect(screen.getByTestId("object-source-preview")).toBeTruthy());
      await click("object-source-preview");

      // The dialog is never drawn, so there is no confirm button to press and the reader is never
      // shown a diff for one object over a plan addressed to another. `${label}` is in the message
      // so a failure names which of the three components got through.
      await waitFor(() => expect(screen.getByTestId("object-source-edit-refused")).toBeTruthy());
      expect(screen.getByTestId("object-source-edit-refused").getAttribute("data-refusal")).toBe("unreadable");
      expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull();
      expect({ label, applied }).toEqual({ label, applied: [] });
      cleanup();
    }

    // THE CONTROL, and it is the reason the three cases above are not vacuous: the SAME gestures
    // over a plan that DOES address this pane reach the dialog and the host's apply. A pane that
    // refused every build, or a preview button that had stopped working, would pass every line
    // above and fail here.
    const reached: string[] = [];
    await applySuccessfullyThroughTheHost({
      build: async () => BUILT,
      apply: async (_connectionId: string, sent: ObjectEditPlan) => {
        reached.push(sent.planId);
        return APPLIED;
      },
    });
    expect(reached).toEqual(["host-plan-1"]);
  });

  test("this shell's refreshToken becomes a counter IT owns, and only its OWN apply moves it", async () => {
    /*
     * `refreshToken={0}` was a DECISION and not a stub, and an apply breaks its stated premise,
     * because an apply THIS shell issues IS a DDL this shell knows about. The counter is still
     * blind to a host's own DDL, which is why the tab that applied goes STALE rather than being
     * cleared and re-read: this shell knows something changed and does not know what the host did.
     */
    const seen: unknown[] = [];
    await previewThrough({ build: async () => BUILT, apply: async () => APPLIED });
    seen.push(refreshTokenPassedToTheViewer());
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());
    await click("object-source-apply-confirm");
    await waitFor(() => expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull());
    seen.push(refreshTokenPassedToTheViewer());

    expect(seen).toEqual([0, 1]);
    /*
     * What the reader SEES for it, and it is NOT the stale banner (X25, #789). The same handler
     * clears the tab, so the pane re-reads at the token the apply moved to and `readAtToken`
     * equals `refreshToken` again: the tab that applied knows exactly what happened and is not
     * asked to press anything. The banner is what every OTHER open Source tab gets, and it is
     * driven where it lives, in `tests/components/object-source/ObjectSourceView.test.tsx`.
     */
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    expect(screen.queryByTestId("object-source-stale")).toBeNull();
  });

  test("a FAILED apply does not move the counter", async () => {
    /*
     * The other half of "only its OWN apply moves it", and it is a separate test because the
     * increment site is a single call the pane makes only for an applied outcome: a shell that
     * bumped on every answer would pass the test above and mark a tab stale over a definition
     * nothing changed.
     */
    await previewThrough({
      build: async () => BUILT,
      apply: async () =>
        ({
          outcome: "refused",
          refusal: {
            refusal: "privilege",
            sentence: "must be owner of function order_total",
            at: { within: "none" },
          },
          duration: 2,
        }) as unknown as ObjectEditOutcome,
    });
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());
    await click("object-source-apply-confirm");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-failure")).toBeTruthy());

    /*
     * WHICH failure, and it is asserted because the first draft of this test did not: a refusal
     * whose `at` was `{ within: "object" }`, which is not one of the three arms `isPosition`
     * accepts, made the outcome unreadable, and an unreadable outcome returns from `landOutcome`
     * BEFORE the line the counter mutation moves. The test passed and the mutation killed nothing.
     * Pinning the engine's own sentence is what puts the refused arm in the population.
     */
    expect(screen.getByTestId("object-source-apply-failure").textContent).toContain(
      "must be owner of function order_total",
    );
    expect(refreshTokenPassedToTheViewer()).toBe(0);
    expect(screen.queryByTestId("object-source-stale")).toBeNull();
  });

  /*
   * THE BOUND, and this shell is the only place it can exist (#789 Phase 3).
   *
   * `src/lib/api/object-edit-wire.ts` bounds NO string in any of its four shape predicates, and it
   * does not because its brief specified none. Round 1 said here that the standalone shell does not
   * care because its two routes bound what they answer. MEASURED and false, and the docblock in
   * `use-connection-adapter.ts` now carries the grep: the two routes bound only what they RECEIVE,
   * so the hazard is on both shells and only its author differs. This is the shell where a test can
   * drive it, because here the answer is a plain object a test can construct. The dialog renders a
   * refusal sentence, a refusal hint, a revision reason and each consequence's observed fact
   * verbatim, with only the plan's executable text bounded by anything at all.
   *
   * Phase 2 measured the same hazard on the READ seam and closed it there: a part carrying a
   * five-million-character truncation reason passed `isSourceDocumentShape` and the whole of it
   * reached a div. This is that measurement applied to the seam that writes.
   */
  const HUGE = "x".repeat(5_000_000);

  test("a host BUILD answer larger than this shell can read is refused, and nothing is sent", async () => {
    let applied = 0;
    await previewThrough({
      build: async () =>
        ({
          built: true,
          plan: {
            ...PLAN,
            consequences: [
              { loses: "destroys-comment", fact: { source: "pg_description", observed: HUGE } },
              { loses: "destroys-index", fact: { source: "pg_index", observed: "one index" } },
            ],
          },
          preimage: { text: DEFINITION, language: "sql" },
        }) as unknown as ObjectEditBuild,
      apply: async () => {
        applied += 1;
        return APPLIED;
      },
    });

    await waitFor(() => expect(screen.getByTestId("object-source-edit-refused")).toBeTruthy());
    expect(screen.getByTestId("object-source-edit-refused").getAttribute("data-refusal")).toBe("request");
    expect(screen.getByTestId("object-source-edit-refused").textContent).toContain(
      "The host answered the apply preview with more text than LibreDB can read, so nothing was previewed and nothing was sent.",
    );
    expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull();
    // The sentence is a claim about the apply, so it is asserted rather than trusted.
    expect(applied).toBe(0);
  });

  /**
   * THE CONTROL for the test above, and without it that test certified the wrong thing (fix
   * round 1, finding 4).
   *
   * The round-1 fixture spelled its two consequence classes `comment` and `grants`, and NEITHER is
   * one of the eight names in `CONSEQUENCE_CLASSES`. MEASURED by the reviewer and reproduced here:
   * the identical fixture with the five-million-character string cut to ten characters is refused
   * with `data-refusal="unreadable"`, so the plan was malformed independently of its size and the
   * test above certified "the bound runs before the shape check" rather than the cost the report
   * states. This test is the population that makes the claim true: the SAME answer, well formed,
   * with the same two classes and only the size changed, is ACCEPTED and drawn. The two tests
   * differ in exactly one thing, which is the number of characters.
   */
  test("the same build answer with a short fact is ACCEPTED and drawn, which is the size claim's control", async () => {
    await previewThrough({
      build: async () =>
        ({
          built: true,
          plan: {
            ...PLAN,
            consequences: [
              { loses: "destroys-comment", fact: { source: "pg_description", observed: "0123456789" } },
              { loses: "destroys-index", fact: { source: "pg_index", observed: "one index" } },
            ],
          },
          preimage: { text: DEFINITION, language: "sql" },
        }) as unknown as ObjectEditBuild,
      apply: async () => APPLIED,
    });

    await waitFor(() => expect(screen.getByTestId("object-source-apply-dialog")).toBeTruthy());
    expect(screen.queryByTestId("object-source-edit-refused")).toBeNull();
    expect(screen.getAllByTestId("object-source-apply-consequence")).toHaveLength(2);
    expect(document.body.textContent).toContain("0123456789");
  });

  test("a host APPLY answer larger than this shell can read never claims the change landed", async () => {
    /*
     * The apply WAS sent, so the honest sentence is that LibreDB cannot say what happened, and the
     * pane renders a rejected apply as `interrupted` with `committed: "unknown"`, which is the
     * same fact in the outcome vocabulary. A sentence saying the apply failed would be a claim
     * about an engine nobody here has heard from.
     */
    await previewThrough({
      build: async () => BUILT,
      apply: async () =>
        ({
          outcome: "refused",
          refusal: { refusal: "privilege", sentence: HUGE, at: { within: "none" } },
          duration: 1,
        }) as unknown as ObjectEditOutcome,
    });
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());
    await click("object-source-apply-confirm");

    await waitFor(() => expect(screen.getByTestId("object-source-apply-failure")).toBeTruthy());
    expect(screen.getByTestId("object-source-apply-failure").textContent).toContain(
      "The apply was sent and the host answered with more text than LibreDB can read, so LibreDB cannot say whether this change landed.",
    );
    expect(refreshTokenPassedToTheViewer()).toBe(0);
  });

  test("a host answer that refers to itself is measured once rather than for ever", async () => {
    /*
     * A cycle is a host quirk and not an attack, so it is counted once and walked no further. What
     * this test is really about is TERMINATION: without the seen-set the walk recurses until the
     * stack runs out, and the pane would then report `request` with "Maximum call stack size
     * exceeded" instead of the shape refusal below. The two refusal ids are what tell the two
     * apart, so the assertion is on the id and not on the presence of a refusal.
     */
    const answer: Record<string, unknown> = {
      built: true,
      plan: PLAN,
      preimage: { text: DEFINITION, language: "sql" },
    };
    answer.self = answer;

    await previewThrough({
      build: async () => answer as unknown as ObjectEditBuild,
      apply: async () => APPLIED,
    });

    await waitFor(() => expect(screen.getByTestId("object-source-edit-refused")).toBeTruthy());
    // Refused on SHAPE, by `isObjectEditBuildResponseShape`'s exact-keys check, which is what the
    // walk having terminated normally looks like from here.
    expect(screen.getByTestId("object-source-edit-refused").getAttribute("data-refusal")).toBe("unreadable");
  });

  test("clearing a document while the host withdraws its reader still issues NO read", async () => {
    /*
     * The pane's read effect issues its read through `reader ?? httpSourceReader`, and this package
     * ships no `/api/db/objects/source`, so a CLEARED document plus a withdrawn host reader would
     * send the viewer's default reader at a route that does not exist. `sourceFailure` in
     * `StudioWorkspace.tsx` is non-undefined in the SAME render, so `needsRead` is false and no
     * read is issued at all.
     *
     * THE POPULATION MOVED AND THIS TEST MOVED WITH IT (X25, #789). It used to reach the clear
     * through the stale banner's own control, because until X25 the apply cleared nothing and the
     * banner was the only control that did. The apply clears now, so the clear and the withdrawal
     * are driven together, in ONE act, which is both the tighter race and the exact hazard the
     * old no-clear behaviour was defended with: apply, host withdraws `readObjectSource`, and the
     * question is whether anything goes out. Nothing does.
     */
    const withReader = editingReader({ build: async () => BUILT, apply: async () => APPLIED });
    const view = render(workspace({ reader: withReader }));
    await openSourceTab();
    await click("object-source-edit");
    await waitFor(() => expect(screen.getByTestId("object-source-preview")).toBeTruthy());
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());

    const before = requested.length;
    await act(async () => {
      (screen.getByTestId("object-source-apply-confirm") as HTMLElement).click();
      // The withdrawal, inside the same act as the answer landing: the host hands a reader object
      // with no `readObjectSource` on it, which is `conn.sourceReader === undefined` here.
      view.rerender(workspace({ reader: treeReader() }));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId("object-source-failure")).toBeTruthy());
    expect(screen.getByTestId("object-source-failure-message").textContent).toContain(
      "no longer reads object definitions",
    );
    expect(screen.queryByTestId("source-editor")).toBeNull();
    /*
     * The door the old reason was written about, named here at the moment it matters rather than
     * left to the `afterEach`, which would fail with no sentence saying why.
     */
    expect(requested.length).toBe(before);
  });

  /*
   * THE THREE WAYS A HOST DEFEATS A BOUND THAT COUNTS WHAT IT WALKS (fix round 1, findings 1, 2
   * and the third one this file found while repairing them).
   *
   * The round-1 walk counted DISTINCT objects: it carried one `seen` set across the whole answer,
   * so every occurrence of an object after the first cost zero, while `ApplyPreviewDialog` draws
   * `consequences.map` occurrence by occurrence. MEASURED by the reviewer inside this suite: six
   * consequences that are ONE object with a one-million-character `observed` were ACCEPTED and all
   * six were drawn, `PROBE consequence rows: 6 characters in the DOM: 6000456` against a bound of
   * 4,400,000. The second defeat is an enumerable GETTER: the walk read the value once and the
   * renderer read it again, so an answer measuring five characters drew two million of them, which
   * also makes the bytes previewed differ from the bytes a host later applies. The third is a
   * non-enumerable own property: `hasExactKeys` reads `Object.getOwnPropertyNames`, so a
   * non-enumerable `observed` is judged and rendered while an `Object.entries` walk never sees it.
   *
   * All three are closed the same way, and the way is the point: the seam SNAPSHOTS the answer
   * while it counts it, reading every property exactly once over the same key population the shape
   * predicates read, and everything downstream renders the snapshot. So the measured characters
   * are the drawn characters by construction, rather than by a claim about how many times a value
   * is read.
   */

  test("a host answer that reuses ONE object pays for EVERY occurrence, because the dialog draws every one", async () => {
    const shared = { loses: "destroys-comment", fact: { source: "pg_description", observed: "x".repeat(1_000_000) } };
    let applied = 0;
    await previewThrough({
      build: async () =>
        ({
          built: true,
          // Six references to ONE object: 6,000,000 characters on screen, over a 4,400,000 bound.
          plan: { ...PLAN, consequences: [shared, shared, shared, shared, shared, shared] },
          preimage: { text: DEFINITION, language: "sql" },
        }) as unknown as ObjectEditBuild,
      apply: async () => {
        applied += 1;
        return APPLIED;
      },
    });

    await waitFor(() => expect(screen.getByTestId("object-source-edit-refused")).toBeTruthy());
    expect(screen.getByTestId("object-source-edit-refused").getAttribute("data-refusal")).toBe("request");
    expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull();
    // The claim is about the DOM, so the DOM is what is asserted, not only the refusal.
    expect(document.body.textContent?.length ?? 0).toBeLessThan(100_000);
    expect(applied).toBe(0);
  });

  test("a host answer whose value CHANGES between reads is read ONCE, and the bytes drawn are the bytes measured", async () => {
    let reads = 0;
    const fact = {
      source: "pg_description",
      get observed(): string {
        reads += 1;
        return reads === 1 ? "small" : "y".repeat(2_000_000);
      },
    };

    await previewThrough({
      build: async () =>
        ({
          built: true,
          plan: { ...PLAN, consequences: [{ loses: "destroys-comment", fact }] },
          preimage: { text: DEFINITION, language: "sql" },
        }) as unknown as ObjectEditBuild,
      apply: async () => APPLIED,
    });

    await waitFor(() => expect(screen.getByTestId("object-source-apply-dialog")).toBeTruthy());
    // ONE read, by the seam, and the shape predicate and the renderer both read the snapshot.
    expect(reads).toBe(1);
    expect(document.body.textContent).toContain("small");
    expect(document.body.textContent?.length ?? 0).toBeLessThan(100_000);
  });

  test("a host answer's NON-ENUMERABLE own property is measured, because the shape check reads it", async () => {
    const fact: Record<string, unknown> = { source: "pg_description" };
    // `hasExactKeys` reads `Object.getOwnPropertyNames`, so this property is judged, and
    // `describeConsequence` renders it. An `Object.entries` walk never sees it at all.
    Object.defineProperty(fact, "observed", { value: HUGE, enumerable: false });

    await previewThrough({
      build: async () =>
        ({
          built: true,
          plan: { ...PLAN, consequences: [{ loses: "destroys-comment", fact }] },
          preimage: { text: DEFINITION, language: "sql" },
        }) as unknown as ObjectEditBuild,
      apply: async () => APPLIED,
    });

    await waitFor(() => expect(screen.getByTestId("object-source-edit-refused")).toBeTruthy());
    expect(screen.getByTestId("object-source-edit-refused").getAttribute("data-refusal")).toBe("request");
    expect(document.body.textContent?.length ?? 0).toBeLessThan(100_000);
  });

  test("a host answer whose KEY is larger than this shell can read is refused too", async () => {
    // A key is not rendered, but it is read, held and compared by everything downstream, and the
    // budget is spent on it for the same reason the round-1 walk charged for it.
    await previewThrough({
      build: async () =>
        ({
          built: true,
          plan: { ...PLAN, [HUGE]: true },
          preimage: { text: DEFINITION, language: "sql" },
        }) as unknown as ObjectEditBuild,
      apply: async () => APPLIED,
    });

    await waitFor(() => expect(screen.getByTestId("object-source-edit-refused")).toBeTruthy());
    expect(screen.getByTestId("object-source-edit-refused").getAttribute("data-refusal")).toBe("request");
  });

  test("a tab remounted inside an unsaved edit still clears its dirty mark when the buffer is reverted", async () => {
    /*
     * WHAT `dirty={sourceTab.dirty}` IS FOR, and until fix round 1 nothing in any suite drove it:
     * deleting the prop left this file at 36 pass 0 fail (mutation h), which is the finding.
     *
     * `ObjectSourceView` seeds `dirtyRef` from this prop and writes the flag to the tab only when
     * the boolean FLIPS. A tab switch unmounts the pane, so without the prop a pane remounted
     * inside an unsaved edit starts at `false`, and reverting the buffer to the engine's own text
     * then compares `false` against a `false` that was never true, no patch is written, and the
     * strip keeps a dirty dot over a tab holding exactly what the database holds.
     */
    render(workspace({ reader: editingReader({ build: async () => BUILT, apply: async () => APPLIED }) }));
    await openSourceTab();
    await click("object-source-edit");

    await act(async () => {
      editorProbe.change?.("CREATE FUNCTION app.order_total(integer) RETURNS numeric AS $$ SELECT 99 $$;");
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("tab-dirty-dot")).toBeTruthy());

    // The tab switch is the remount: the pane is rendered only for the tab that is active.
    await userEvent.click(screen.getByRole("tab", { name: /Query 1/ }));
    expect(screen.queryByTestId("source-editor")).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: /Source: app.order_total/ }));
    await waitFor(() => expect(screen.getByTestId("source-editor")).toBeTruthy());
    // The mark survives the remount, which is the state this test is about.
    expect(screen.getByTestId("tab-dirty-dot")).toBeTruthy();

    await act(async () => {
      editorProbe.change?.(DEFINITION);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByTestId("tab-dirty-dot")).toBeNull());
  });
  /**
   * WHAT THE READER IS LOOKING AT ONE RENDER AFTER A SUCCESSFUL APPLY (X25, #789).
   *
   * Filed as a residual with a reason, and the reason was checked by driving it rather than by
   * re-reading it, which is what the two tests below are. This one is the REPRODUCTION: the host
   * answers the OLD definition on the first read and the NEW one on every read after it, exactly
   * as an engine does, so a pane that re-read shows `SELECT 2` and a pane that did not shows
   * `SELECT 1`.
   *
   * It is an assertion about the BYTES ON SCREEN and not about the counter. The counter already has
   * its own test above and a moved counter is not a re-read: `needsRead` in `ObjectSourceView` is
   * `document === undefined && failure === undefined`, so a shell that moves the token and clears
   * nothing issues no read at all and only draws the stale banner over text the object no longer
   * holds.
   */
  test("a successful apply leaves the ENGINE'S OWN new text on screen, not the pre-apply text", async () => {
    const versions = [DEFINITION, STEP_TEXT];
    let read = 0;
    const reader = {
      ...treeReader(),
      readObjectSource: async () => {
        const text = versions[Math.min(read, versions.length - 1)] as string;
        read += 1;
        return { ...EDITABLE_DOCUMENT, parts: [{ ...EDITABLE_DOCUMENT.parts[0], text }] } as ObjectSourceDocument;
      },
      objectEditor: { build: async () => BUILT, apply: async () => APPLIED },
    } as unknown as WorkspaceObjectReader;

    render(workspace({ reader }));
    await openSourceTab();
    // The control for the two-version host: the FIRST read is the pre-apply definition, so a
    // failure below is about the apply and not about a host that answered the new text all along.
    expect(shownText()).toBe(DEFINITION);

    await click("object-source-edit");
    await waitFor(() => expect(screen.getByTestId("object-source-preview")).toBeTruthy());
    await click("object-source-preview");
    await waitFor(() => expect(screen.getByTestId("object-source-apply-confirm")).toBeTruthy());
    await click("object-source-apply-confirm");
    await waitFor(() => expect(screen.queryByTestId("object-source-apply-dialog")).toBeNull());

    // The pane asked the host again, which is the only way new text can reach the screen here.
    await waitFor(() => expect(read).toBe(2));
    await waitFor(() => expect(shownText()).toBe(STEP_TEXT));
    // And the tab that applied is NOT marked stale: it re-read at the token its own apply moved to,
    // which is what `src/components/Studio.tsx` already produces for the same gesture.
    expect(screen.queryByTestId("object-source-stale")).toBeNull();
  });
});
