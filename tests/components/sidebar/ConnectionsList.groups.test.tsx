import "../../setup-dom";

import { mock } from "bun:test";

mock.module("@/lib/db-ui-config", () => ({
  getDBIcon: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    const MockDBIcon = (props: Record<string, unknown>) => React.createElement("span", { ...props });
    MockDBIcon.displayName = "MockDBIcon";
    return MockDBIcon;
  },
  getDBConfig: () => ({ icon: () => null, color: "text-hue-blue", label: "PostgreSQL", defaultPort: "5432" }),
  getDBColor: () => "text-hue-blue",
}));

// Radix's menu opens on pointer events, which happy-dom does not drive; render the items inline.
mock.module("@/components/ui/dropdown-menu", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
    DropdownMenuSeparator: () => React.createElement("hr"),
    DropdownMenuItem: ({ children, onSelect }: { children: React.ReactNode; onSelect?: () => void }) =>
      React.createElement("div", { role: "menuitem", onClick: onSelect }, children),
  };
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import React from "react";

import { ConnectionsList } from "@/components/sidebar/ConnectionsList";
import type { ConnectionGroup } from "@/lib/storage/types";
import { mockPostgresConnection, mockMySQLConnection, mockSQLiteConnection } from "../../fixtures/connections";

const pg = mockPostgresConnection;
const my = mockMySQLConnection;
const lite = mockSQLiteConnection;

const group = (id: string, connectionIds: string[], collapsed = false): ConnectionGroup => ({
  id,
  name: `Group ${id}`,
  collapsed,
  connectionIds,
});

const onSelect = mock(() => {});
const onDelete = mock(() => {});
const onAdd = mock(() => {});
const onCreateGroup = mock((_name: string): string | null => "new-id");
const onRenameGroup = mock((_id: string, _name: string) => {});
const onDeleteGroup = mock((_id: string) => {});
const onToggleGroupCollapsed = mock((_id: string) => {});
const onMoveConnectionToGroup = mock((_connectionId: string, _groupId: string | null) => {});
const onReorder = mock((_order: string[]) => {});

function renderList(
  props: Partial<React.ComponentProps<typeof ConnectionsList>> = {},
  { managed = true }: { managed?: boolean } = {},
) {
  return render(
    <ConnectionsList
      connections={[pg, my, lite]}
      activeConnection={null}
      onSelectConnection={onSelect}
      onDeleteConnection={onDelete}
      onAddConnection={onAdd}
      {...(managed
        ? { onCreateGroup, onRenameGroup, onDeleteGroup, onToggleGroupCollapsed, onMoveConnectionToGroup }
        : {})}
      {...props}
    />,
  );
}

/** Each section's header text (label plus count): the menus repeat group names, the headers do not. */
function headers(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("section")).map(
    (section) => section.firstElementChild!.querySelector("span")!.textContent ?? "",
  );
}

function typeName(name: string) {
  fireEvent.change(screen.getByLabelText("Group name"), { target: { value: name } });
}

describe("ConnectionsList groups (#1170)", () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    for (const fn of [
      onSelect,
      onDelete,
      onAdd,
      onCreateGroup,
      onRenameGroup,
      onDeleteGroup,
      onToggleGroupCollapsed,
      onMoveConnectionToGroup,
      onReorder,
    ]) {
      fn.mockClear();
    }
    onCreateGroup.mockReturnValue("new-id");
  });

  test("without group callbacks the panel is the flat list: no group chrome at all", () => {
    renderList({}, { managed: false });
    expect(screen.queryByLabelText("New group")).toBeNull();
    expect(screen.queryByLabelText("Move to group")).toBeNull();
    expect(screen.queryByText("Ungrouped")).toBeNull();
  });

  test("with no groups yet there is still one Connections section, with a New group button", () => {
    const { container } = renderList();
    expect(headers(container)).toEqual(["Connections"]);
    expect(screen.getByLabelText("New group")).not.toBeNull();
  });

  test("groups render with a count, the rest under Ungrouped, which carries no collapse button", () => {
    const { container } = renderList({ connectionGroups: [group("a", [pg.id, my.id])] });
    expect(headers(container)).toEqual(["Group a2", "Ungrouped1"]);
    expect(screen.getByLabelText("Group a group").getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByLabelText("Ungrouped group")).toBeNull();
  });

  test("a collapsed group hides its rows but keeps its header and count", () => {
    const { container } = renderList({ connectionGroups: [group("a", [pg.id], true)] });
    expect(headers(container)).toEqual(["Group a1", "Ungrouped2"]);
    expect(screen.getByLabelText("Group a group").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(pg.name)).toBeNull();
    expect(screen.queryByText(my.name)).not.toBeNull();
  });

  test("clicking a group header asks to toggle that group", () => {
    renderList({ connectionGroups: [group("a", [pg.id])] });
    fireEvent.click(screen.getByLabelText("Group a group"));
    expect(onToggleGroupCollapsed).toHaveBeenCalledWith("a");
  });

  test("a group header is not a button when no toggle callback is handed over", () => {
    const { container } = renderList({ connectionGroups: [group("a", [pg.id])], onToggleGroupCollapsed: undefined });
    expect(screen.queryByLabelText("Group a group")).toBeNull();
    expect(headers(container)[0]).toBe("Group a1");
  });

  test("an empty group still shows its header", () => {
    const { container } = renderList({ connectionGroups: [group("a", [])] });
    expect(headers(container)[0]).toBe("Group a0");
  });

  test("New group asks for a name and creates the group", () => {
    renderList();
    fireEvent.click(screen.getByLabelText("New group"));
    typeName("Production");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreateGroup).toHaveBeenCalledWith("Production");
    expect(onMoveConnectionToGroup).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Group name")).toBeNull();
  });

  test("Create is disabled while the name is blank", () => {
    renderList();
    fireEvent.click(screen.getByLabelText("New group"));
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    typeName("   ");
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByLabelText("Group name").closest("form")!);
    expect(onCreateGroup).not.toHaveBeenCalled();
  });

  test("Cancel closes the name dialog without creating anything", () => {
    renderList();
    fireEvent.click(screen.getByLabelText("New group"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Group name")).toBeNull();
    expect(onCreateGroup).not.toHaveBeenCalled();
  });

  test("the New group button sits on the first section that is not Favorites", () => {
    const { container } = renderList({
      favoriteConnectionIds: new Set([pg.id]),
      connectionGroups: [group("a", [pg.id])],
    });
    const buttons = screen.getAllByLabelText("New group");
    expect(buttons).toHaveLength(1);
    expect(headers(container)).toEqual(["Favorites1", "Group a1", "Ungrouped2"]);
    expect(buttons[0].closest("section")!.firstElementChild!.querySelector("span")!.textContent).toBe("Group a1");
  });

  test("there is no New group button when no create callback is handed over", () => {
    renderList({ onCreateGroup: undefined });
    expect(screen.queryByLabelText("New group")).toBeNull();
  });

  test("Rename opens the dialog with the current name and renames the group", () => {
    renderList({ connectionGroups: [group("a", [pg.id])] });
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect((screen.getByLabelText("Group name") as HTMLInputElement).value).toBe("Group a");
    typeName("Staging");
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(onRenameGroup).toHaveBeenCalledWith("a", "Staging");
    expect(screen.queryByLabelText("Group name")).toBeNull();
  });

  test("Delete group deletes that group", () => {
    renderList({ connectionGroups: [group("a", [pg.id])] });
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete group" }));
    expect(onDeleteGroup).toHaveBeenCalledWith("a");
  });

  test("the group menu offers only the actions that are wired", () => {
    renderList({ connectionGroups: [group("a", [pg.id])], onRenameGroup: undefined });
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    cleanup();
    renderList({ connectionGroups: [group("a", [pg.id])], onDeleteGroup: undefined });
    expect(screen.queryByRole("menuitem", { name: "Delete group" })).toBeNull();
    cleanup();
    renderList({ connectionGroups: [group("a", [pg.id])], onRenameGroup: undefined, onDeleteGroup: undefined });
    expect(screen.queryByLabelText("Options for Group a")).toBeNull();
  });

  test("a row's Move to group menu files the connection under the chosen group", () => {
    renderList({ connectionGroups: [group("a", []), group("b", [])], connections: [pg] });
    fireEvent.click(screen.getByRole("menuitem", { name: "Group b" }));
    expect(onMoveConnectionToGroup).toHaveBeenCalledWith(pg.id, "b");
  });

  test("a row's Move to group menu can return the connection to Ungrouped", () => {
    renderList({ connectionGroups: [group("a", [pg.id])], connections: [pg] });
    fireEvent.click(screen.getByRole("menuitem", { name: "Ungrouped" }));
    expect(onMoveConnectionToGroup).toHaveBeenCalledWith(pg.id, null);
  });

  test("New group... from a row creates the group and files that connection in it", () => {
    renderList({ connections: [pg] });
    fireEvent.click(screen.getByRole("menuitem", { name: "New group..." }));
    typeName("Production");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreateGroup).toHaveBeenCalledWith("Production");
    expect(onMoveConnectionToGroup).toHaveBeenCalledWith(pg.id, "new-id");
  });

  test("New group... from a row files nothing when the group was not created", () => {
    onCreateGroup.mockReturnValue(null);
    renderList({ connections: [pg] });
    fireEvent.click(screen.getByRole("menuitem", { name: "New group..." }));
    typeName("Production");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onMoveConnectionToGroup).not.toHaveBeenCalled();
  });

  test("a row has no New group... item when creating groups is not wired", () => {
    renderList({ connections: [pg], onCreateGroup: undefined });
    expect(screen.queryByRole("menuitem", { name: "New group..." })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Ungrouped" })).not.toBeNull();
  });

  test("a starred row in a group renders under Favorites and in its group", () => {
    renderList({ favoriteConnectionIds: new Set([pg.id]), connectionGroups: [group("a", [pg.id])] });
    expect(screen.getAllByText(pg.name)).toHaveLength(2);
  });

  test("dragging within a group persists the new order", () => {
    renderList({ connectionGroups: [group("a", [pg.id, my.id])], onReorderConnections: onReorder });
    const row = (name: string) => screen.getAllByText(name)[0].closest('[draggable="true"]') as HTMLElement;
    fireEvent.dragStart(row(my.name));
    fireEvent.dragEnter(row(pg.name));
    fireEvent.drop(row(pg.name));
    expect(onReorder).toHaveBeenCalledWith([my.id, pg.id, lite.id]);
  });

  test("dragging a starred row dims only the copy being dragged and highlights only its own section", () => {
    renderList({
      connections: [pg, my, lite],
      favoriteConnectionIds: new Set([pg.id, my.id]),
      onReorderConnections: onReorder,
    });
    const copies = screen.getAllByText(pg.name).map((el) => el.closest('[draggable="true"]') as HTMLElement);
    expect(copies).toHaveLength(2);
    fireEvent.dragStart(copies[0]);
    expect(copies[0].className).toContain("opacity-40");
    expect(copies[1].className).not.toContain("opacity-40");
    const mine = screen.getAllByText(my.name).map((el) => el.closest('[draggable="true"]') as HTMLElement);
    fireEvent.dragEnter(mine[0]);
    expect(mine[0].className).toContain("ring-brand-solid");
    expect(mine[1].className).not.toContain("ring-brand-solid");
  });

  test("a drop onto a row in another section is ignored", () => {
    renderList({
      connections: [pg, my, lite],
      favoriteConnectionIds: new Set([pg.id, my.id]),
      onReorderConnections: onReorder,
    });
    const favCopy = screen.getAllByText(pg.name)[0].closest('[draggable="true"]') as HTMLElement;
    const restCopy = screen.getAllByText(my.name)[1].closest('[draggable="true"]') as HTMLElement;
    fireEvent.dragStart(favCopy);
    fireEvent.dragEnter(restCopy);
    fireEvent.drop(restCopy);
    expect(onReorder).not.toHaveBeenCalled();
  });

  test("the empty state still shows when there are no connections and no groups", () => {
    renderList({ connections: [] });
    expect(screen.getByText("No database connections established yet.")).not.toBeNull();
  });
});
