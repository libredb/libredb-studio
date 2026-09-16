import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setupFramerMotionMock, setupMonacoMock } from "../../helpers/mock-monaco";

setupMonacoMock();
setupFramerMotionMock();

// The editor and the panel library are the two things this file does NOT exercise, and both
// are hostile to happy-dom: `react-resizable-panels` 4 reaches for a global `DOMRect`, and
// the Monaco loader's promise has no `cancel` for the unmount path. Everything between the
// published prop and the tree's own request is the real code, adapter and sidebar included,
// because mounting the tree directly with props the embedded shell never supplies is what
// let this ship (#789, B76).
mock.module("@/components/QueryEditor", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return { QueryEditor: () => React.createElement("div", { "data-testid": "query-editor" }) };
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
import type { ProviderCapabilities } from "@/lib/db/types";

/**
 * `hasColumns` is declared on purpose, and the non-regression pin below is why (#789).
 *
 * The declaration and the seam are two independent gates on the twisty: `flattenTree` draws one
 * only where the KIND declares columns AND the source can answer a describe read. With a kind
 * that declared nothing, "a host that implements nothing sees no twisty" would pass for the
 * wrong reason and would keep passing if `readsColumns` were hard-coded true, which is precisely
 * the B76 shape this file exists to catch.
 */
const capabilities = {
  queryLanguage: "sql",
  containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
  objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true }],
} as unknown as ProviderCapabilities;

const realFetch = globalThis.fetch;

/** Every request the workspace issues, by pathname, so a read that went to a route is visible. */
function installFetch(): string[] {
  const paths: string[] = [];
  globalThis.fetch = mock(async (url: string | URL) => {
    paths.push(new URL(String(url), "http://localhost:3000").pathname);
    return Response.json({ error: "no route here" }, { status: 404 });
  }) as never;
  return paths;
}

function renderWorkspace(reader: WorkspaceObjectReader) {
  return render(
    <StudioWorkspace
      connections={[{ id: "host-conn-1", name: "Adopter DB", type: "clickhouse", capabilities }]}
      onQueryExecute={async () => ({ rows: [], fields: [], rowCount: 0, executionTime: 1 })}
      onSchemaFetch={async () => []}
      onObjectsFetch={reader}
    />,
  );
}

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

/**
 * The embedded shell reads its objects through the HOST (#789, B76).
 *
 * This package ships no API routes: `package.json`'s `exports` map carries components and types
 * only, so `/api/db/objects/*` is a path on the HOST's origin, which need not serve it. Measured
 * before the fix, on this exact mount: the tree posted
 * `{"connection":{"id","name","type","createdAt","managed"}}` to `/api/db/objects/containers`, and
 * that connection object was refused by name by the real provider factory on every engine tried
 * ("ClickHouse requires a host or a connection string", "Host is required for PostgreSQL",
 * "Database file path is required for SQLite"), leaving an adopter with the tree's failure panel
 * on every connection.
 *
 * Driven through `StudioWorkspace` rather than through `ObjectTree`, deliberately: every test of
 * the tree supplied props the embedded shell never supplies, which is how the regression shipped.
 */
describe("the embedded workspace's object tree", () => {
  test("lists what the host answered, and asks no route for it", async () => {
    const paths = installFetch();
    const asked: unknown[][] = [];
    const reader: WorkspaceObjectReader = {
      listContainers: async (connectionId, parent) => {
        asked.push(["listContainers", connectionId, parent]);
        return [{ path: ["app"], level: 0, name: "app", isSessionDefault: true }];
      },
      countObjects: async (connectionId, container) => {
        asked.push(["countObjects", connectionId, container]);
        return { table: { count: 1 } };
      },
      listObjects: async (connectionId, container, kind) => {
        asked.push(["listObjects", connectionId, container, kind]);
        return [{ path: ["app", "orders"], name: "orders", kind: "table" }];
      },
    };

    renderWorkspace(reader);

    // First paint: the host's container list, then the counts of the one it marked as the
    // session default, which is what opened the folder below without anybody clicking it.
    await waitFor(() => expect(screen.getByText("Tables")).toBeTruthy());
    expect(asked).toEqual([
      ["listContainers", "host-conn-1", undefined],
      ["countObjects", "host-conn-1", ["app"]],
    ]);

    // The third read is the LAZY one, and it is the reason the seam is per read rather than one
    // flat catalog: nothing named an object until a reader opened the folder.
    await userEvent.click(screen.getByText("Tables"));
    await waitFor(() => expect(screen.getByText("orders")).toBeTruthy());
    expect(asked[2]).toEqual(["listObjects", "host-conn-1", ["app"], "table"]);

    // The control for this negative is everything above: three reads answered and three sets of
    // rows are on screen, so a read that had gone to a route would have been counted here.
    expect(paths.filter((path) => path.startsWith("/api/db/objects"))).toEqual([]);
  });

  /*
   * THE NON-REGRESSION HALF of the optional `readObjectSource` member (#789 Phase 2).
   *
   * The member is optional so that an adopter who does nothing sees the tree exactly as it was,
   * and this file is the one that predates it: a host here declares three methods and no source
   * read. Pinned below is everything such an adopter can see, so a change that alters a container
   * row, a badge or a row menu for a host implementing nothing fails here rather than in the
   * source suite that was written alongside the feature. Every value was MEASURED against this
   * mount.
   */
  test("a host that declares no source read sees the tree it saw before the member existed", async () => {
    const paths = installFetch();
    renderWorkspace({
      listContainers: async () => [{ path: ["app"], level: 0, name: "app", isSessionDefault: true }],
      countObjects: async () => ({ table: { count: 2 } }),
      listObjects: async () => [
        { path: ["app", "orders"], name: "orders", kind: "table" },
        { path: ["app", "customers"], name: "customers", kind: "table" },
      ],
    });

    await waitFor(() => expect(screen.getByText("Tables")).toBeTruthy());
    await userEvent.click(screen.getByText("Tables"));
    await waitFor(() => expect(screen.getByText("orders")).toBeTruthy());

    // The container, its one badged folder and the two object rows, in the order drawn.
    expect(screen.getAllByRole("treeitem").map((item) => item.textContent)).toEqual([
      "app",
      "Tables2",
      "orders",
      "customers",
    ]);

    /*
     * THE SAME HALF FOR THE OPTIONAL `describeObject` MEMBER (#789, columns under an object row).
     *
     * The kind above DECLARES `hasColumns`, so the only thing withholding the twisty here is the
     * seam: this host answers no describe read, `readsColumns` is false, and `flattenTree` gives
     * the row no `expanded`. An object row made expandable unconditionally would send every table
     * in an adopter's tree to a method that is not there and draw a failure panel on each, which
     * is B76 with a different route. An absent affordance is not a regression; a read that cannot
     * succeed is.
     */
    const orders = screen.getByRole("treeitem", { name: /orders/ });
    expect(orders.hasAttribute("aria-expanded")).toBe(false);
    expect(within(orders).queryByTestId("tree-row-twisty")).toBeNull();

    // And the keyboard cannot open what the pointer cannot: ArrowRight on a row with no
    // `expanded` state has nothing to toggle and no child to move into. Driven rather than
    // rendered, because the gesture is the thing that would have issued the read. The click on
    // the folder left `Tables` active, so one ArrowDown is what lands on the object row.
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-row-id")).toBe("app/orders/table");
    await userEvent.keyboard("{ArrowRight}");

    expect(screen.getAllByRole("treeitem").map((item) => item.textContent)).toEqual([
      "app",
      "Tables2",
      "orders",
      "customers",
    ]);
    expect(screen.queryByTestId("tree-row-failure")).toBeNull();
    // The whole point of the seam: nothing reached a route this package does not ship.
    expect(paths.filter((path) => path.startsWith("/api/db/objects"))).toEqual([]);

    // And the relation row's menu, which is where a View Source item would appear if the
    // affordance were ever offered without a host method behind it.
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /orders/ }));
    const items = within(screen.getByRole("menu"))
      .getAllByRole("menuitem")
      .map((item) => item.textContent ?? "");
    expect(items).toEqual(["Generate Query", "Generate Count Query", "Profile Table", "Generate Code"]);
  });

  /**
   * THE OTHER HALF: a host that implements one method gets the columns (#789).
   *
   * Driven through `StudioWorkspace` and never through `ObjectTree`, for this file's own reason:
   * every test that mounted the tree with props the embedded shell never supplies is how B76
   * shipped. What is asserted is therefore the whole path, published prop to rendered row, with
   * the route count as the control.
   */
  test("a host that declares the describe read gets column rows, and no route is asked for them", async () => {
    const paths = installFetch();
    const asked: unknown[][] = [];
    renderWorkspace({
      listContainers: async () => [{ path: ["app"], level: 0, name: "app", isSessionDefault: true }],
      countObjects: async () => ({ table: { count: 1 } }),
      listObjects: async () => [{ path: ["app", "orders"], name: "orders", kind: "table" }],
      describeObject: async (connectionId, path, kind) => {
        asked.push([connectionId, path, kind]);
        return {
          path: ["app", "orders"],
          columns: [
            { name: "id", type: "integer", nullable: false, isPrimary: true },
            { name: "total", type: "numeric", nullable: true, isPrimary: false },
          ],
          indexes: [],
          foreignKeys: [],
        };
      },
    });

    await waitFor(() => expect(screen.getByText("Tables")).toBeTruthy());
    await userEvent.click(screen.getByText("Tables"));
    await waitFor(() => expect(screen.getByText("orders")).toBeTruthy());

    const orders = screen.getByRole("treeitem", { name: /orders/ });
    expect(orders.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(within(orders).getByTestId("tree-row-twisty"));
    await waitFor(() => expect(screen.getByText("total")).toBeTruthy());

    // The host's own connection id, the object's path and the kind the host itself listed.
    expect(asked).toEqual([["host-conn-1", ["app", "orders"], "table"]]);
    expect(screen.getByRole("treeitem", { name: /orders/ }).getAttribute("aria-expanded")).toBe("true");
    expect(
      screen
        .getAllByRole("treeitem")
        .filter((item) => item.getAttribute("aria-level") === "4")
        .map((item) => within(item).getByTestId("tree-row-label").textContent),
    ).toEqual(["id", "total"]);
    expect(paths.filter((path) => path.startsWith("/api/db/objects"))).toEqual([]);
  });

  test("a host answering a detail shape the tree cannot render fails that row and nothing else", async () => {
    installFetch();
    renderWorkspace({
      listContainers: async () => [{ path: ["app"], level: 0, name: "app", isSessionDefault: true }],
      countObjects: async () => ({ table: { count: 1 } }),
      listObjects: async () => [{ path: ["app", "orders"], name: "orders", kind: "table" }],
      // A host is ordinary JavaScript, so `ObjectDetail` is a declaration and not a runtime
      // guarantee. A numeric `type` reaches `.split("(")` in the row and a non-string `name`
      // reaches `replaceAll` inside the walk, so an unchecked answer throws in the render and
      // takes the adopter's whole page with it rather than one row.
      describeObject: async () => ({ columns: [{ name: "id", type: 7 }] }) as never,
    });

    await waitFor(() => expect(screen.getByText("Tables")).toBeTruthy());
    await userEvent.click(screen.getByText("Tables"));
    await waitFor(() => expect(screen.getByText("orders")).toBeTruthy());
    await userEvent.click(within(screen.getByRole("treeitem", { name: /orders/ })).getByTestId("tree-row-twisty"));

    await waitFor(() => expect(screen.getByTestId("tree-row-failure")).toBeTruthy());
    expect(screen.getByTestId("tree-row-failure").textContent).toContain(
      "The describe reading answered with a body this tree cannot render",
    );
    // The workspace is still mounted, which is the half a render-phase throw would have taken.
    expect(screen.getByText("Tables")).toBeTruthy();
  });

  test("a host that answers with no promise at all fails that row rather than the page", async () => {
    installFetch();
    renderWorkspace({
      listContainers: async () => [{ path: ["app"], level: 0, name: "app", isSessionDefault: true }],
      countObjects: async () => ({ table: { count: 1 } }),
      listObjects: async () => [{ path: ["app", "orders"], name: "orders", kind: "table" }],
      // The second half of the same distrust: `Promise<ObjectDetail>` is a declaration, and a
      // host can hand back a value that is not thenable at all. The tree AWAITS this seam, so the
      // non-promise arrives as a body and is refused by the shape check; the first form of this
      // seam called `.then` on the answer instead and took the adopter's page down with a
      // TypeError.
      describeObject: (() => undefined) as unknown as WorkspaceObjectReader["describeObject"],
    });

    await waitFor(() => expect(screen.getByText("Tables")).toBeTruthy());
    await userEvent.click(screen.getByText("Tables"));
    await waitFor(() => expect(screen.getByText("orders")).toBeTruthy());
    await userEvent.click(within(screen.getByRole("treeitem", { name: /orders/ })).getByTestId("tree-row-twisty"));

    await waitFor(() => expect(screen.getByTestId("tree-row-failure")).toBeTruthy());
    expect(screen.getByTestId("tree-row-failure").textContent).toContain(
      "The describe reading answered with a body this tree cannot render",
    );
    expect(screen.getByText("Tables")).toBeTruthy();
  });

  test("a host whose describe read throws before returning shows its own sentence on that row", async () => {
    installFetch();
    renderWorkspace({
      listContainers: async () => [{ path: ["app"], level: 0, name: "app", isSessionDefault: true }],
      countObjects: async () => ({ table: { count: 1 } }),
      listObjects: async () => [{ path: ["app", "orders"], name: "orders", kind: "table" }],
      // Synchronous, and not a rejected promise: a host method is ordinary JavaScript and this
      // is the shape that took the whole embedded workspace down on the first form of this seam.
      describeObject: (() => {
        throw new Error("The tenant's warehouse is asleep");
      }) as WorkspaceObjectReader["describeObject"],
    });

    await waitFor(() => expect(screen.getByText("Tables")).toBeTruthy());
    await userEvent.click(screen.getByText("Tables"));
    await waitFor(() => expect(screen.getByText("orders")).toBeTruthy());
    await userEvent.click(within(screen.getByRole("treeitem", { name: /orders/ })).getByTestId("tree-row-twisty"));

    await waitFor(() => expect(screen.getByTestId("tree-row-failure")).toBeTruthy());
    expect(screen.getByTestId("tree-row-failure").textContent).toContain("The tenant's warehouse is asleep");
    expect(screen.getByText("Tables")).toBeTruthy();
  });

  test("refuses a host answer the tree cannot render, rather than unmounting on it", async () => {
    installFetch();
    const reader: WorkspaceObjectReader = {
      // A host is ordinary JavaScript, so its declared return type is not a runtime guarantee.
      // `[null]` passes `Array.isArray`, and dereferencing it throws INSIDE the render, which
      // takes the whole workspace down with it.
      listContainers: async () => [null] as never,
      countObjects: async () => ({}),
      listObjects: async () => [],
    };

    renderWorkspace(reader);

    await waitFor(() => expect(screen.getByTestId("tree-failure")).toBeTruthy());
    expect(screen.getByTestId("tree-failure").textContent).toContain(
      "The containers reading answered with a body this tree cannot render",
    );
  });

  test("shows the host's own sentence when its reading fails", async () => {
    installFetch();
    const reader: WorkspaceObjectReader = {
      listContainers: async () => {
        throw new Error("The tenant's warehouse is asleep");
      },
      countObjects: async () => ({}),
      listObjects: async () => [],
    };

    renderWorkspace(reader);

    await waitFor(() => expect(screen.getByTestId("tree-failure")).toBeTruthy());
    expect(screen.getByTestId("tree-failure").textContent).toContain("The tenant's warehouse is asleep");
  });
});
