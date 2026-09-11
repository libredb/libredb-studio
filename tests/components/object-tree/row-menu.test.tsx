import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ObjectTree } from "@/components/object-tree";
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
  table: [{ path: ["app", "orders"], name: "orders", kind: "table" }],
  view: [{ path: ["app", "order_summary"], name: "order_summary", kind: "view" }],
  function: [{ path: ["app", "order_total(integer)"], name: "order_total", kind: "function" }],
};

function installFetch(): void {
  globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    const route = text.slice(text.lastIndexOf("/") + 1);
    const body = JSON.parse(String(init?.body ?? "{}")) as { kind?: string };
    if (route === "containers")
      return Response.json([{ path: ["app"], name: "app", level: 0, isSessionDefault: true }]);
    if (route === "counts") return Response.json({ table: { count: 1 }, view: { count: 1 }, function: { count: 1 } });
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
async function openTree(record: string[] = [], handlers?: TreeRowActionHandlers): Promise<void> {
  installFetch();
  render(<ObjectTree connection={connectionOf()} capabilities={oneLevel} actions={handlers ?? allHandlers(record)} />);
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
