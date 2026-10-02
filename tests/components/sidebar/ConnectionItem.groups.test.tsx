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
    DropdownMenuContent: ({ children, onClick }: { children: React.ReactNode; onClick?: React.MouseEventHandler }) =>
      React.createElement("div", { onClick }, children),
    DropdownMenuSeparator: () => React.createElement("hr"),
    DropdownMenuItem: ({ children, onSelect }: { children: React.ReactNode; onSelect?: () => void }) =>
      React.createElement("div", { role: "menuitem", onClick: onSelect }, children),
  };
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import React from "react";

import { ConnectionItem } from "@/components/sidebar/ConnectionItem";
import { mockPostgresConnection } from "../../fixtures/connections";

const conn = mockPostgresConnection;
const groups = [
  { id: "a", name: "Production" },
  { id: "b", name: "Staging" },
];

const onSelect = mock(() => {});
const onMoveToGroup = mock((_id: string, _groupId: string | null) => {});
const onMoveToNewGroup = mock((_id: string) => {});

function renderItem(props: Partial<React.ComponentProps<typeof ConnectionItem>> = {}) {
  return render(
    <ConnectionItem
      connection={conn}
      isActive={false}
      onSelect={onSelect}
      onDelete={mock(() => {})}
      groups={groups}
      onMoveToGroup={onMoveToGroup}
      onMoveToNewGroup={onMoveToNewGroup}
      {...props}
    />,
  );
}

describe("ConnectionItem Move to group (#1170)", () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    onSelect.mockClear();
    onMoveToGroup.mockClear();
    onMoveToNewGroup.mockClear();
  });

  test("has no Move to group control unless a parent wires one", () => {
    renderItem({ onMoveToGroup: undefined });
    expect(screen.queryByLabelText("Move to group")).toBeNull();
  });

  test("lists every group, Ungrouped, and New group...", () => {
    renderItem();
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toEqual(["Production", "Staging", "Ungrouped", "New group..."]);
  });

  test("choosing a group moves the connection into it", () => {
    renderItem();
    fireEvent.click(screen.getByRole("menuitem", { name: "Staging" }));
    expect(onMoveToGroup).toHaveBeenCalledWith(conn.id, "b");
  });

  test("choosing Ungrouped moves the connection out of its group", () => {
    renderItem({ currentGroupId: "a" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Ungrouped" }));
    expect(onMoveToGroup).toHaveBeenCalledWith(conn.id, null);
  });

  test("choosing New group... hands the connection to the new-group flow", () => {
    renderItem();
    fireEvent.click(screen.getByRole("menuitem", { name: "New group..." }));
    expect(onMoveToNewGroup).toHaveBeenCalledWith(conn.id);
  });

  test("omits New group... when no new-group flow is wired", () => {
    renderItem({ onMoveToNewGroup: undefined });
    expect(screen.queryByRole("menuitem", { name: "New group..." })).toBeNull();
  });

  test("marks the current group, or Ungrouped when it is in none", () => {
    const { unmount } = renderItem({ currentGroupId: "a" });
    const visible = () =>
      screen
        .getAllByRole("menuitem")
        .filter(
          (el) => el.querySelector("svg") && !el.querySelector("svg")!.getAttribute("class")!.includes("invisible"),
        )
        .map((el) => el.textContent);
    expect(visible()).toEqual(["Production"]);
    unmount();
    renderItem({ currentGroupId: null });
    expect(visible()).toEqual(["Ungrouped"]);
  });

  test("opening the menu does not select the row", () => {
    renderItem();
    fireEvent.click(screen.getByLabelText("Move to group"));
    fireEvent.keyDown(screen.getByLabelText("Move to group"), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Production" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("a managed (seeded) connection can be moved too, and keeps its lock", () => {
    renderItem({ connection: { ...conn, managed: true, seedId: "seed-1" } });
    expect(screen.getByLabelText("Move to group")).not.toBeNull();
    expect(screen.getByTestId("managed-lock-seed-1")).not.toBeNull();
  });
});
