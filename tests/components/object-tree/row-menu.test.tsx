import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ObjectTree } from "@/components/object-tree";
import { menuPlacement, RowMenu } from "@/components/object-tree/RowMenu";
import { Plus } from "lucide-react";
import type { TreeRowActionHandlers } from "@/components/object-tree/row-actions";
import type { DatabaseObject, ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The object tree's row menu (U22, #789).
 *
 * The six actions the flat explorer carried lost their only entry point on the desktop
 * sidebar when the tree replaced it. This is the surface that gives them one back, and the
 * three things it has to be are asserted here rather than argued: it is driven by the
 * DECLARATION, it opens from the KEYBOARD as well as the pointer, and it leaves the tree's
 * single tab stop where it found it.
 *
 * Nothing is mocked. The menu is hand-rolled rather than a Radix `ContextMenu` for the
 * reason `ObjectTree` is hand-windowed: every suite in this repo that renders a Radix menu
 * replaces it with `mock.module` first, and a mocked menu would make every assertion below
 * a statement about the stub.
 */

type ObjectModel = Pick<ProviderCapabilities, "containerLevels" | "objectKinds">;

function capabilitiesOf(model: ObjectModel): Partial<ProviderCapabilities> {
  return { queryLanguage: "sql", ...model };
}

/** PostgreSQL-shaped: a writable relation, a relation that takes no row writes, a routine. */
const oneLevel = {
  ...capabilitiesOf({
    containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
    objectKinds: [
      { id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true },
      { id: "view", role: "relation", label: "View", labelPlural: "Views" },
      { id: "function", role: "routine", label: "Function", labelPlural: "Functions" },
    ],
  }),
  supportsInlineRowEdit: true,
} as ProviderCapabilities;

function connectionOf(): DatabaseConnection {
  return { id: "pg", name: "conn pg", type: "postgres", createdAt: new Date("2026-01-01") };
}

const realFetch = globalThis.fetch;

const objects: Record<string, DatabaseObject[]> = {
  // A row count, because the trigger sits beside one: the defect the flat explorer's version
  // had was that reaching for the menu HID the number, and only a row that has one can pin it.
  //
  // `ZZ ARCHIVE` holds a SPACE, which a quoted identifier is allowed to and every engine here
  // permits. It is the row that decides whether the ids behind `aria-labelledby` survive a
  // real name: a space inside an IDREF splits the token in two, and both halves resolve to
  // nothing, so the row would silently fall back to naming itself from its contents.
  table: [
    { path: ["app", "orders"], name: "orders", kind: "table", rowCount: 1234 },
    { path: ["app", "ZZ ARCHIVE"], name: "ZZ ARCHIVE", kind: "table", rowCount: 7 },
  ],
  // A status, because the word the engine published is part of the row's name and the fix
  // that removes the button's name from it must not remove this one too.
  view: [{ path: ["app", "order_summary"], name: "order_summary", kind: "view", status: "INVALID" }],
  function: [{ path: ["app", "order_total(integer)"], name: "order_total", kind: "function" }],
};

function installFetch(): void {
  globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    const route = text.slice(text.lastIndexOf("/") + 1);
    const body = JSON.parse(String(init?.body ?? "{}")) as { kind?: string };
    if (route === "containers")
      return Response.json([{ path: ["app"], name: "app", level: 0, isSessionDefault: true }]);
    if (route === "counts") return Response.json({ table: { count: 2 }, view: { count: 1 }, function: { count: 1 } });
    return Response.json(objects[String(body.kind)] ?? []);
  }) as never;
}

/** Every handler, so an action that is missing is the declaration and never the shell. */
function allHandlers(record: string[]): TreeRowActionHandlers {
  return {
    onGenerateSelect: (object) => record.push(`select:${object.name}`),
    onProfileObject: (object) => record.push(`profile:${object.name}`),
    onGenerateCode: (object) => record.push(`code:${object.name}`),
    onGenerateTestData: (object) => record.push(`test-data:${object.name}`),
    onCreateObject: () => record.push("create"),
  };
}

function row(name: string | RegExp): HTMLElement {
  return screen.getByRole("treeitem", { name });
}

/** Opens the tree down to the three object rows, with every handler wired. */
async function openTree(
  record: string[] = [],
  handlers?: TreeRowActionHandlers,
  onObjectClick?: (object: DatabaseObject) => void,
): Promise<void> {
  installFetch();
  render(
    <ObjectTree
      connection={connectionOf()}
      capabilities={oneLevel}
      actions={handlers ?? allHandlers(record)}
      onObjectClick={onObjectClick}
    />,
  );
  await screen.findByRole("treeitem", { name: /Tables/ });
  await userEvent.click(row(/Tables/));
  await waitFor(() => expect(screen.getByText("orders")).toBeTruthy());
  await userEvent.click(row(/Views/));
  await waitFor(() => expect(screen.getByText("order_summary")).toBeTruthy());
  await userEvent.click(row(/Functions/));
  await waitFor(() => expect(screen.getByText("order_total")).toBeTruthy());
}

/**
 * Walks to the `orders` row with the keyboard alone, from the single tab stop Tab lands on.
 *
 * The setup above uses clicks to EXPAND, which is not what is under test; from here on
 * nothing is pointed at. It matters that this is the real path: the tree's key handler acts
 * on the row it considers active, not on whatever happens to hold DOM focus, so a test that
 * called `.focus()` on a row would be pressing keys at a row the tree never selected.
 */
async function keyboardToOrders(): Promise<void> {
  const tabStop = screen.getAllByRole("treeitem").find((item) => item.getAttribute("tabindex") === "0");
  tabStop?.focus();
  await userEvent.keyboard("{Home}{ArrowDown}{ArrowDown}");
  expect(document.activeElement?.getAttribute("data-row-id")).toBe("app/orders/table");
}

function menuItems(): string[] {
  return within(screen.getByRole("menu"))
    .getAllByRole("menuitem")
    .map((item) => item.textContent ?? "");
}

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("the row menu is driven by the declaration", () => {
  test("a writable relation is offered every action the shell handed over", async () => {
    await openTree();
    // `false` means the page took the gesture: the browser's own menu must not open on top
    // of this one. It is also the control for the routine case below, where the same call
    // has to answer `true`.
    expect(fireEvent.contextMenu(row(/orders/))).toBe(false);
    expect(menuItems()).toEqual(["Generate Query", "Profile Table", "Generate Code", "Generate Test Data"]);
  });

  test("a relation that declares no row writes is offered everything but the row writer", async () => {
    await openTree();
    fireEvent.contextMenu(row(/order_summary/));
    // The kind's own word, from the declaration: the same menu reads "Profile View" here.
    expect(menuItems()).toEqual(["Generate Query", "Profile View", "Generate Code"]);
  });

  test("a routine gets no menu at all, and the browser's own menu is left alone", async () => {
    await openTree();
    const event = fireEvent.contextMenu(row(/order_total/));
    expect(screen.queryByRole("menu")).toBeNull();
    // Not prevented: there is nothing to offer, so the page must not swallow the gesture.
    expect(event).toBe(true);
  });

  test("the folder of a writable kind offers creating one, and the others offer nothing", async () => {
    await openTree();
    fireEvent.contextMenu(row(/Tables/));
    expect(menuItems()).toEqual(["Create Table"]);

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.contextMenu(row(/Views/));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("a container is offered nothing", async () => {
    await openTree();
    fireEvent.contextMenu(row(/app/));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("a row that has a menu says so, and a row that has none does not", async () => {
    await openTree();
    expect(row(/orders/).getAttribute("aria-haspopup")).toBe("menu");
    expect(row(/order_total/).hasAttribute("aria-haspopup")).toBe(false);
    expect(row(/app/).hasAttribute("aria-haspopup")).toBe(false);
  });

  test("a shell that handed over nothing gets no menu anywhere", async () => {
    await openTree([], {});
    fireEvent.contextMenu(row(/orders/));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(row(/orders/).hasAttribute("aria-haspopup")).toBe(false);
  });
});

describe("the row menu runs its action", () => {
  test("an item hands the shell the object the row was built from, and closes", async () => {
    const record: string[] = [];
    await openTree(record);
    fireEvent.contextMenu(row(/orders/));

    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Profile Table" }));
    expect(record).toEqual(["profile:orders"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("creating an object is offered on the folder and takes no target", async () => {
    const record: string[] = [];
    await openTree(record);
    fireEvent.contextMenu(row(/Tables/));

    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Create Table" }));
    expect(record).toEqual(["create"]);
  });
});

describe("the row menu is reachable without a pointer", () => {
  test("the ContextMenu key opens the menu on the focused row", async () => {
    const record: string[] = [];
    await openTree(record);
    await keyboardToOrders();
    await userEvent.keyboard("{ContextMenu}");

    expect(menuItems()).toHaveLength(4);
    // Focus is INSIDE the menu, so the next key press goes to it rather than to the tree.
    expect(document.activeElement?.textContent).toBe("Generate Query");
  });

  test("Shift+F10 opens it too, which is what a keyboard without a menu key has", async () => {
    await openTree();
    await keyboardToOrders();
    fireEvent.keyDown(row(/orders/), { key: "F10", shiftKey: true });
    expect(screen.queryByRole("menu")).not.toBeNull();
  });

  test("plain F10 is left to the browser", async () => {
    await openTree();
    await keyboardToOrders();
    fireEvent.keyDown(row(/orders/), { key: "F10" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("Down and Up walk the items and wrap, and Enter runs the one that is focused", async () => {
    const record: string[] = [];
    await openTree(record);
    await keyboardToOrders();
    await userEvent.keyboard("{ContextMenu}");

    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("Profile Table");
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(document.activeElement?.textContent).toBe("Generate Test Data");
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("Generate Query");

    await userEvent.keyboard("{Enter}");
    expect(record).toEqual(["select:orders"]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("Home and End jump to the first and the last item", async () => {
    await openTree();
    await keyboardToOrders();
    await userEvent.keyboard("{ContextMenu}");

    await userEvent.keyboard("{End}");
    expect(document.activeElement?.textContent).toBe("Generate Test Data");
    await userEvent.keyboard("{Home}");
    expect(document.activeElement?.textContent).toBe("Generate Query");
  });

  test("Escape closes the menu and hands focus back to the row it was opened on", async () => {
    await openTree();
    await keyboardToOrders();
    await userEvent.keyboard("{ContextMenu}");

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement?.getAttribute("data-row-id")).toBe("app/orders/table"));
  });

  test("a key the menu does not claim is left alone, and the tree does not act on it either", async () => {
    await openTree();
    await keyboardToOrders();
    await userEvent.keyboard("{ContextMenu}");

    // ArrowLeft is the tree's collapse key. With the menu open it must not reach the tree,
    // or an open menu would be collapsing rows behind itself.
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.queryByRole("menu")).not.toBeNull();
    expect(row(/Tables/).getAttribute("aria-expanded")).toBe("true");
  });

  test("the tree keeps exactly one tab stop while the menu is open", async () => {
    await openTree();
    await keyboardToOrders();
    await userEvent.keyboard("{ContextMenu}");

    const tabbable = screen.getAllByRole("treeitem").filter((item) => item.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].getAttribute("data-row-id")).toBe("app/orders/table");
  });

  test("focus leaving the menu closes it", async () => {
    await openTree();
    await keyboardToOrders();
    await userEvent.keyboard("{ContextMenu}");

    await userEvent.tab();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  test("a click outside the menu closes it", async () => {
    // The other way out, and NOT the same code path as Tab: Tab is a key the menu handles,
    // while a pointer press elsewhere only ever reaches it as focus leaving.
    await openTree();
    fireEvent.contextMenu(row(/orders/));
    expect(screen.queryByRole("menu")).not.toBeNull();

    await userEvent.click(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});

/**
 * The viewport happy-dom renders into, read rather than assumed: every placement expectation
 * below is arithmetic on these two numbers, so a harness that changed them would change the
 * expectations rather than silently pass.
 */
const VIEWPORT = { width: window.innerWidth, height: window.innerHeight };

describe("the row menu stays inside the viewport", () => {
  test("a menu with room below opens below its anchor", () => {
    expect(menuPlacement({ x: 10, top: 100, bottom: 120 }, 4, VIEWPORT)).toEqual({ top: 120, left: 10 });
  });

  test("a menu with no room below opens ABOVE the anchor, not over it", () => {
    // The bottom edge of the menu lands on the anchor's TOP, which is why the anchor carries
    // two edges: on the keyboard path that is the row's top, so the row stays visible.
    const near = VIEWPORT.height - 10;
    expect(menuPlacement({ x: 10, top: near, bottom: near + 5 }, 4, VIEWPORT)).toEqual({
      bottom: VIEWPORT.height - near,
      left: 10,
    });
  });

  test("a menu that fits neither way is pinned to the top edge and scrolls", () => {
    const tall = Math.ceil(VIEWPORT.height / 28) + 4;
    expect(menuPlacement({ x: 10, top: 20, bottom: 30 }, tall, VIEWPORT)).toEqual({
      top: 0,
      maxHeight: VIEWPORT.height,
      left: 10,
    });
  });

  test("a menu with no room to the right opens leftward from its anchor", () => {
    const near = VIEWPORT.width - 10;
    expect(menuPlacement({ x: near, top: 100, bottom: 120 }, 4, VIEWPORT)).toEqual({
      top: 120,
      right: VIEWPORT.width - near,
    });
  });

  test("a menu with room on neither side is pinned to the left edge", () => {
    expect(menuPlacement({ x: 10, top: 100, bottom: 120 }, 4, { width: 200, height: VIEWPORT.height })).toEqual({
      top: 120,
      left: 0,
    });
  });

  test("the height counts the border as well as the padding", () => {
    // `p-1` is 4px top and bottom and the box carries a 1px border on each side, which
    // `getBoundingClientRect` includes: four items are 112 + 8 + 2 = 122 tall. Asserted one
    // pixel either side of the fold, so the arithmetic and the rendered box cannot drift
    // apart by even the two pixels the border contributes.
    const height = 4 * 28 + 10;
    const justFits = { x: 10, top: 0, bottom: VIEWPORT.height - height };
    expect(menuPlacement(justFits, 4, VIEWPORT)).toEqual({ top: justFits.bottom, left: 10 });

    const oneTooLow = { x: 10, top: 300, bottom: VIEWPORT.height - height + 1 };
    expect(menuPlacement(oneTooLow, 4, VIEWPORT)).toEqual({ bottom: VIEWPORT.height - 300, left: 10 });
  });

  test("a menu pinned under its cap can still be scrolled to the items the cap hides", () => {
    // The third vertical case is only usable if the box scrolls. Nothing else in this file
    // can reach it: the tree offers at most six actions, so the menu is rendered directly
    // with enough items to overflow the viewport, which is the state the cap exists for.
    const tall = Math.ceil(VIEWPORT.height / 28) + 4;
    const actions = Array.from({ length: tall }, (_, index) => ({
      id: `a${index}`,
      label: `Item ${index}`,
      icon: Plus,
      run: () => {},
    }));
    render(
      <RowMenu actions={actions} anchor={{ x: 10, top: 20, bottom: 30 }} label="Actions for x" onClose={() => {}} />,
    );

    const menu = screen.getByRole("menu");
    expect(menu.style.maxHeight).toBe(`${VIEWPORT.height}px`);
    // A capped box that cannot scroll hides the items it clipped with no way to reach them,
    // which is the same unreachable-item defect the placement exists to prevent.
    expect(menu.className).toContain("overflow-y-auto");
  });

  test("the keyboard path anchors on the row's BOX, so a flipped menu sits above the row", async () => {
    // happy-dom measures every element as zero, so the row's box is supplied here rather than
    // rendered. Without it both edges of the anchor read 0 and the two of them cannot be told
    // apart, which is exactly the confusion this asserts against: a menu flipped on
    // `box.bottom` would cover the row it belongs to.
    await openTree();
    const target = row(/orders/);
    const box = { x: 5, y: 700, top: 700, bottom: 728, left: 5, right: 200, width: 195, height: 28 };
    target.getBoundingClientRect = () => ({ ...box, toJSON: () => box }) as DOMRect;
    await keyboardToOrders();
    await userEvent.keyboard("{ContextMenu}");

    const menu = screen.getByRole("menu");
    expect(menu.style.bottom).toBe(`${VIEWPORT.height - box.top}px`);
    expect(menu.style.left).toBe(`${box.left}px`);
  });

  test("the last row in the sidebar gets a menu whose items are all on screen", async () => {
    // The regression this guards, end to end: the flat explorer's Radix menu flipped, so a
    // right click on the last table always produced a usable menu. A fixed element that
    // overflows the viewport cannot be scrolled to, so an item below the fold is unreachable.
    await openTree();
    const bottom = VIEWPORT.height - 30;
    fireEvent.contextMenu(row(/orders/), { clientX: 12, clientY: bottom });

    const menu = screen.getByRole("menu");
    expect(menu.style.top).toBe("");
    expect(menu.style.bottom).toBe(`${VIEWPORT.height - bottom}px`);

    // The control, same menu and same fixture, where there IS room below.
    fireEvent.keyDown(menu, { key: "Escape" });
    fireEvent.contextMenu(row(/orders/), { clientX: 12, clientY: 40 });
    expect(screen.getByRole("menu").style.top).toBe("40px");
    expect(screen.getByRole("menu").style.bottom).toBe("");
  });
});

describe("the row menu and the rows under it", () => {
  test("a menu opened on one row is replaced by a menu opened on another", async () => {
    await openTree();
    fireEvent.contextMenu(row(/orders/));
    expect(menuItems()).toHaveLength(4);

    fireEvent.contextMenu(row(/order_summary/));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(menuItems()).toEqual(["Generate Query", "Profile View", "Generate Code"]);
  });

  test("a row that stops existing under an open menu takes the menu with it", async () => {
    // The declaration can change while a menu is open - a host re-declares, or provider
    // metadata lands late - and the row the menu was opened on then stops existing without
    // anything having touched focus. Nothing here is clicked for that reason: a click would
    // close the menu through focus and the derivation would never be reached.
    installFetch();
    const { rerender } = render(
      <ObjectTree connection={connectionOf()} capabilities={oneLevel} actions={allHandlers([])} />,
    );
    await screen.findByRole("treeitem", { name: /Tables/ });
    await userEvent.click(row(/Tables/));
    await waitFor(() => expect(screen.getByText("orders")).toBeTruthy());
    fireEvent.contextMenu(row(/orders/));
    expect(screen.queryByRole("menu")).not.toBeNull();

    const withoutTables = { ...oneLevel, objectKinds: [] } as ProviderCapabilities;
    rerender(<ObjectTree connection={connectionOf()} capabilities={withoutTables} actions={allHandlers([])} />);

    // The container survives, so the tree is still rendering rows: this is the menu's own
    // row going away, not the whole tree being replaced by a panel.
    expect(screen.getByRole("treeitem", { name: /app/ })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("collapsing the row the menu belongs to closes the menu", async () => {
    await openTree();
    fireEvent.contextMenu(row(/orders/));
    expect(screen.queryByRole("menu")).not.toBeNull();

    await userEvent.click(row(/Tables/));
    await waitFor(() => expect(screen.queryByText("orders")).toBeNull());
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

/**
 * The visible trigger (Task 33).
 *
 * Right click, the ContextMenu key and Shift+F10 are all the menu had, and none of the three
 * is discoverable: a reader who does not try them never learns the six actions exist. The
 * flat explorer had an ellipsis button and the tree did not carry it over, with no recorded
 * decision behind dropping it.
 *
 * Two things are asserted here that the design turns on. The trigger appears EXACTLY where
 * the right click already opens something, because a visible control that opens nothing is
 * worse than no control at all. And the row count is still there while the trigger is
 * showing: the flat explorer's version shared one box with the count and swapped the two on
 * hover, so reaching for the menu hid the number, which is the regression this must not
 * reproduce.
 */
function trigger(name: string | RegExp): HTMLElement {
  return screen.getByRole("button", { name });
}

describe("the row menu has a visible trigger", () => {
  test("a row with actions carries one, and a row with nothing to offer carries none", async () => {
    await openTree();
    expect(within(row(/orders/)).getByTestId("tree-row-menu-trigger")).toBeTruthy();
    expect(within(row(/Tables/)).getByTestId("tree-row-menu-trigger")).toBeTruthy();
    // The three gate outcomes that have no action today. A trigger here would open an
    // empty menu, which is the one state worse than the undiscoverable one.
    expect(within(row(/order_total/)).queryByTestId("tree-row-menu-trigger")).toBeNull();
    expect(within(row(/order_summary/)).getByTestId("tree-row-menu-trigger")).toBeTruthy();
    expect(within(row(/app/)).queryByTestId("tree-row-menu-trigger")).toBeNull();
  });

  test("a shell that handed over nothing gets no trigger either", async () => {
    // The same predicate the right click reads: this is the case where the DECLARATION
    // offers plenty and the SHELL offers none.
    await openTree([], {});
    expect(screen.queryAllByTestId("tree-row-menu-trigger")).toHaveLength(0);
  });

  test("the trigger is named after its own row rather than a bare More", async () => {
    await openTree();
    expect(trigger("Actions for orders")).toBe(within(row(/orders/)).getByTestId("tree-row-menu-trigger"));
    expect(trigger("Actions for Tables")).toBe(within(row(/Tables/)).getByTestId("tree-row-menu-trigger"));
    expect(trigger("Actions for orders").getAttribute("aria-haspopup")).toBe("menu");
  });

  test("clicking it opens the same menu the right click opens", async () => {
    await openTree();
    fireEvent.contextMenu(row(/orders/));
    const byPointer = menuItems();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    await userEvent.click(trigger("Actions for orders"));
    expect(menuItems()).toEqual(byPointer);
  });

  test("clicking it opens the menu and NOT the row it sits in", async () => {
    // The tree delegates click at its root, so without the gesture stopping at the button a
    // press would open the table in a tab behind the menu it just opened.
    const opened: string[] = [];
    await openTree([], undefined, (object) => opened.push(object.name));
    await userEvent.click(trigger("Actions for orders"));
    expect(screen.queryByRole("menu")).not.toBeNull();
    expect(opened).toEqual([]);
  });

  test("it says whether the menu it owns is open", async () => {
    await openTree();
    expect(trigger("Actions for orders").getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(trigger("Actions for orders"));
    expect(trigger("Actions for orders").getAttribute("aria-expanded")).toBe("true");
  });

  test("Tab from the active row reaches the trigger, and Enter opens the menu there", async () => {
    // Reachable without a pointer, and without a second tab stop per mounted row: only the
    // row holding the tree's roving tabindex offers its trigger to Tab.
    const opened: string[] = [];
    await openTree([], undefined, (object) => opened.push(object.name));
    await keyboardToOrders();
    await userEvent.tab();
    expect(document.activeElement).toBe(trigger("Actions for orders"));

    await userEvent.keyboard("{Enter}");
    expect(menuItems()).toHaveLength(4);
    expect(document.activeElement?.textContent).toBe("Generate Query");
    // The keydown stopped at the button: the tree's own Enter would have opened the table.
    expect(opened).toEqual([]);
  });

  test("only the active row offers its trigger to Tab", async () => {
    await openTree();
    await keyboardToOrders();
    const tabbable = screen
      .getAllByTestId("tree-row-menu-trigger")
      .filter((button) => button.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toBe(trigger("Actions for orders"));
  });

  test("the row count is still there, and still where it was, while the trigger is showing", async () => {
    await openTree();
    const orders = row(/orders/);
    expect(within(orders).getByTestId("tree-row-count").textContent).toBe("1,234");
    // The flat explorer's defect, pinned: the count must not be tied to the hover state that
    // reveals the trigger, in either direction - hidden, or pushed leftward under the pointer.
    expect(within(orders).getByTestId("tree-row-count").className).not.toContain("group-hover");
    expect(within(orders).getByTestId("tree-row-menu-trigger")).toBeTruthy();
    // The slot is reserved by the ROW, on every row, so a row that has no trigger lines its
    // number up with a row that has one.
    expect(orders.className).toContain("pr-7");
    expect(row(/order_total/).className).toContain("pr-7");
  });

  test("the trigger is revealed by hover, by focus, and unconditionally where there is no hover", async () => {
    // happy-dom applies no stylesheet, so the reveal is asserted as the classes that carry
    // it. All three matter separately: hover is the pointer reader's, focus-within is what
    // makes a keyboard reader able to SEE the control they just tabbed to, and a touch
    // device can point at nothing, so there the trigger is simply always there.
    await openTree();
    const button = trigger("Actions for orders");
    expect(button.className).toContain("opacity-0");
    expect(button.className).toContain("group-hover:opacity-100");
    expect(button.className).toContain("group-focus-within:opacity-100");
    expect(button.className).toContain("[@media(hover:none)]:opacity-100");

    // While its own menu is open it stays put rather than fading as the pointer leaves.
    await userEvent.click(button);
    expect(trigger("Actions for orders").className).not.toContain("opacity-0");
  });

  test("a trigger on the last row opens its menu upward, anchored on the button's own box", async () => {
    // The button is an ELEMENT rather than a pointer position, so the anchor is its rect. In
    // a scrolled sidebar the bottom row's menu has to flip, and happy-dom measures every box
    // as zero, so the rect is supplied here.
    await openTree();
    const button = trigger("Actions for orders");
    const box = { x: 220, y: 700, top: 700, bottom: 720, left: 220, right: 240, width: 20, height: 20 };
    button.getBoundingClientRect = () => ({ ...box, toJSON: () => box }) as DOMRect;
    await userEvent.click(button);

    const menu = screen.getByRole("menu");
    expect(menu.style.top).toBe("");
    expect(menu.style.bottom).toBe(`${VIEWPORT.height - box.top}px`);
    expect(menu.style.left).toBe(`${box.left}px`);
  });
});

/**
 * The row's own name (Task 34).
 *
 * The trigger above is a DESCENDANT of the `treeitem`, so a row that names itself from its
 * contents folds the button's name into its own: Chrome computes `APP_ORDERS` as
 * `APP_ORDERS Actions for APP_ORDERS`, measured on the running app before this suite existed.
 * The fix names the row by REFERENCE instead: `aria-labelledby` points at the spans the row
 * already renders, which excludes the button while restating nothing in JavaScript.
 *
 * Why the assertions below are about the REFERENCES and not only about the string: the string
 * cannot see the defect here. `dom-accessibility-api`, which is what `getByRole(..., { name })`
 * computes with, deliberately departs from the spec at step 2C (`w3c/accname#64`) and drops a
 * CONTROL's `aria-label` during recursion, so the contaminated row and the fixed row compute
 * the same name under it. Asserting the string alone would be vacuous in both directions. The
 * string is still pinned, because it is what keeps the ORDER and the CONTENTS of the name
 * right, and the contamination itself is measured in Chrome and recorded in the report.
 */
function nameSources(item: HTMLElement): Element[] {
  const refs = (item.getAttribute("aria-labelledby") ?? "").split(" ").filter((id) => id !== "");
  return refs.map((id) => document.getElementById(id)).filter((element) => element !== null);
}

function nameSourceIds(item: HTMLElement): string[] {
  return nameSources(item).map((element) => element.getAttribute("data-testid") ?? element.tagName);
}

describe("the row names itself, and never the control inside it", () => {
  test("a relation row's name is its label and its count, with the trigger left out", async () => {
    await openTree();
    const orders = row(/orders/);
    // The control is present, which is what makes this non-vacuous: the row carries a button
    // and still does not carry its name.
    expect(within(orders).getByTestId("tree-row-menu-trigger")).toBeTruthy();
    expect(nameSourceIds(orders)).toEqual(["tree-row-label", "tree-row-count"]);
    expect(nameSources(orders).some((element) => element.tagName === "BUTTON")).toBe(false);
    expect(screen.getByRole("treeitem", { name: "orders 1,234" })).toBe(orders);
  });

  test("a folder row's name is its label and its badge, with the trigger left out", async () => {
    await openTree();
    const tables = row(/Tables/);
    expect(within(tables).getByTestId("tree-row-menu-trigger")).toBeTruthy();
    expect(nameSourceIds(tables)).toEqual(["tree-row-label", "tree-row-badge"]);
    expect(screen.getByRole("treeitem", { name: "Tables 2" })).toBe(tables);
  });

  test("the engine's own status word stays in the name of a row that has a trigger", async () => {
    // The reason an explicit `aria-label` was refused: it would have to restate this word,
    // which the renderer never wrote and the engine owns.
    await openTree();
    const summary = row(/order_summary/);
    expect(within(summary).getByTestId("tree-row-menu-trigger")).toBeTruthy();
    expect(nameSourceIds(summary)).toEqual(["tree-row-label", "tree-row-status"]);
    expect(screen.getByRole("treeitem", { name: "order_summary INVALID" })).toBe(summary);
  });

  test("a row with no trigger keeps exactly the name it had", async () => {
    // The control for the whole change: these three rows never carried a button, so nothing
    // about their names may move.
    await openTree();
    expect(within(row(/order_total/)).queryByTestId("tree-row-menu-trigger")).toBeNull();
    expect(screen.getByRole("treeitem", { name: "order_total" })).toBe(row(/order_total/));
    expect(screen.getByRole("treeitem", { name: "app" })).toBe(row(/app/));
    expect(screen.getByRole("treeitem", { name: "Views 1" })).toBe(row(/Views/));
    expect(nameSourceIds(row(/order_total/))).toEqual(["tree-row-label"]);
  });

  test("every reference resolves to a span inside its own row, whatever the object is named", async () => {
    // `ZZ ARCHIVE` is why this test exists. The ids are derived from the row id, which is
    // unique and may hold a space; an id carrying that space would split the IDREF list and
    // resolve to nothing, and the row would name itself from its contents again without a
    // single attribute looking wrong.
    await openTree();
    for (const item of screen.getAllByRole("treeitem")) {
      const refs = (item.getAttribute("aria-labelledby") ?? "").split(" ").filter((id) => id !== "");
      expect(refs.length).toBeGreaterThan(0);
      const resolved = nameSources(item);
      // At least the label, and every one of them inside THIS row: a collision between two
      // rows' ids would resolve to a span in the other one.
      expect(resolved.length).toBeGreaterThan(0);
      for (const element of resolved) expect(item.contains(element)).toBe(true);
    }
    const archive = row(/ZZ ARCHIVE/);
    expect(nameSourceIds(archive)).toEqual(["tree-row-label", "tree-row-count"]);
    expect(screen.getByRole("treeitem", { name: "ZZ ARCHIVE 7" })).toBe(archive);
  });
});
