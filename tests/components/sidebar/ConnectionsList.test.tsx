import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { mock } from "bun:test";

// Mock framer-motion with proper React elements
mock.module("framer-motion", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  const handler = {
    get(_target: unknown, prop: string) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const MotionComponent = React.forwardRef(
        (
          {
            children,
            initial,
            animate,
            exit,
            variants,
            whileHover,
            whileTap,
            layoutId,
            transition,
            ...rest
          }: Record<string, unknown>,
          ref: React.Ref<HTMLElement>,
        ) => {
          return React.createElement(prop, { ...rest, ref }, children);
        },
      );
      MotionComponent.displayName = `Motion${prop}`;
      return MotionComponent;
    },
  };
  const MockAnimatePresence = ({ children }: Record<string, unknown>) => children;
  MockAnimatePresence.displayName = "AnimatePresence";
  return {
    motion: new Proxy({}, handler),
    AnimatePresence: MockAnimatePresence,
    useAnimation: () => ({ start: mock(() => {}), stop: mock(() => {}) }),
    useInView: () => true,
  };
});

// Mock db-ui-config (ConnectionItem uses it)
mock.module("@/lib/db-ui-config", () => ({
  getDBIcon: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require("react");
    const MockDBIcon = (props: Record<string, unknown>) =>
      React.createElement("span", { ...props, "data-testid": "db-icon" });
    MockDBIcon.displayName = "MockDBIcon";
    return MockDBIcon;
  },
  getDBConfig: () => ({ icon: () => null, color: "text-blue-400", label: "PostgreSQL", defaultPort: "5432" }),
  getDBColor: () => "text-blue-400",
}));

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

import { ConnectionsList } from "@/components/sidebar/ConnectionsList";
import { mockPostgresConnection, mockMySQLConnection } from "../../fixtures/connections";

// =============================================================================
// ConnectionsList Tests
// =============================================================================

describe("ConnectionsList", () => {
  const defaultOnSelect = mock(() => {});
  const defaultOnDelete = mock(() => {});
  const defaultOnEdit = mock(() => {});
  const defaultOnAdd = mock(() => {});

  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    defaultOnSelect.mockClear();
    defaultOnDelete.mockClear();
    defaultOnEdit.mockClear();
    defaultOnAdd.mockClear();
  });

  test('renders "Connections" header', () => {
    const { queryByText } = render(
      <ConnectionsList
        connections={[]}
        activeConnection={null}
        onSelectConnection={defaultOnSelect}
        onDeleteConnection={defaultOnDelete}
        onAddConnection={defaultOnAdd}
      />,
    );

    expect(queryByText("Connections")).not.toBeNull();
  });

  test("shows empty state when no connections", () => {
    const { queryByText } = render(
      <ConnectionsList
        connections={[]}
        activeConnection={null}
        onSelectConnection={defaultOnSelect}
        onDeleteConnection={defaultOnDelete}
        onAddConnection={defaultOnAdd}
      />,
    );

    expect(queryByText("No database connections established yet.")).not.toBeNull();
    // Empty state has an "Add Connection" button
    expect(queryByText("Add Connection")).not.toBeNull();
  });

  test("renders ConnectionItem for each connection", () => {
    const connections = [mockPostgresConnection, mockMySQLConnection];

    const { queryByText } = render(
      <ConnectionsList
        connections={connections}
        activeConnection={null}
        onSelectConnection={defaultOnSelect}
        onDeleteConnection={defaultOnDelete}
        onEditConnection={defaultOnEdit}
        onAddConnection={defaultOnAdd}
      />,
    );

    // Each connection name should be rendered
    expect(queryByText("Test PostgreSQL")).not.toBeNull();
    expect(queryByText("Test MySQL")).not.toBeNull();
  });

  test("isActive prop passed correctly based on activeConnection", () => {
    const connections = [mockPostgresConnection, mockMySQLConnection];

    const { container } = render(
      <ConnectionsList
        connections={connections}
        activeConnection={mockPostgresConnection}
        onSelectConnection={defaultOnSelect}
        onDeleteConnection={defaultOnDelete}
        onEditConnection={defaultOnEdit}
        onAddConnection={defaultOnAdd}
      />,
    );

    // The active connection (PostgreSQL) should have active styling
    const items = container.querySelectorAll('[class*="cursor-pointer"]');
    const pgItem = Array.from(items).find((el) => el.textContent?.includes("Test PostgreSQL"));
    const mysqlItem = Array.from(items).find((el) => el.textContent?.includes("Test MySQL"));

    // Active item should have bg-blue-600/10 class
    expect(pgItem?.className.includes("bg-blue-600/10")).toBe(true);
    // Inactive item should not
    expect(mysqlItem?.className.includes("bg-blue-600/10")).toBeFalsy();
  });

  test("onAddConnection fires from empty state button", () => {
    const { getByText } = render(
      <ConnectionsList
        connections={[]}
        activeConnection={null}
        onSelectConnection={defaultOnSelect}
        onDeleteConnection={defaultOnDelete}
        onAddConnection={defaultOnAdd}
      />,
    );

    const addButton = getByText("Add Connection");
    fireEvent.click(addButton);

    expect(defaultOnAdd).toHaveBeenCalledTimes(1);
  });

  test("clicking a connection calls onSelectConnection with that connection", () => {
    const { container } = render(
      <ConnectionsList
        connections={[mockPostgresConnection, mockMySQLConnection]}
        activeConnection={null}
        onSelectConnection={defaultOnSelect}
        onDeleteConnection={defaultOnDelete}
        onEditConnection={defaultOnEdit}
        onAddConnection={defaultOnAdd}
      />,
    );

    const items = container.querySelectorAll('[class*="cursor-pointer"]');
    const mysqlItem = Array.from(items).find((el) => el.textContent?.includes("Test MySQL"));
    fireEvent.click(mysqlItem!);

    expect(defaultOnSelect).toHaveBeenCalledTimes(1);
    expect(defaultOnSelect).toHaveBeenCalledWith(mockMySQLConnection);
  });

  test("delete button click calls onDeleteConnection with the connection id", () => {
    const { container } = render(
      <ConnectionsList
        connections={[mockPostgresConnection]}
        activeConnection={null}
        onSelectConnection={defaultOnSelect}
        onDeleteConnection={defaultOnDelete}
        onEditConnection={defaultOnEdit}
        onAddConnection={defaultOnAdd}
      />,
    );

    // First button is edit (Pencil), second is delete (Trash2)
    const buttons = container.querySelectorAll("button");
    fireEvent.click(buttons[1]!);

    expect(defaultOnDelete).toHaveBeenCalledTimes(1);
    expect(defaultOnDelete).toHaveBeenCalledWith(mockPostgresConnection.id);
    // stopPropagation: the item itself must not be selected
    expect(defaultOnSelect).not.toHaveBeenCalled();
  });

  test("edit button click calls onEditConnection with the connection", () => {
    const { container } = render(
      <ConnectionsList
        connections={[mockPostgresConnection]}
        activeConnection={null}
        onSelectConnection={defaultOnSelect}
        onDeleteConnection={defaultOnDelete}
        onEditConnection={defaultOnEdit}
        onAddConnection={defaultOnAdd}
      />,
    );

    // First button is edit (Pencil), second is delete (Trash2)
    const buttons = container.querySelectorAll("button");
    fireEvent.click(buttons[0]!);

    expect(defaultOnEdit).toHaveBeenCalledTimes(1);
    expect(defaultOnEdit).toHaveBeenCalledWith(mockPostgresConnection);
    expect(defaultOnSelect).not.toHaveBeenCalled();
  });

  test("omitting onEditConnection renders no edit button", () => {
    const { container } = render(
      <ConnectionsList
        connections={[mockPostgresConnection]}
        activeConnection={null}
        onSelectConnection={defaultOnSelect}
        onDeleteConnection={defaultOnDelete}
        onAddConnection={defaultOnAdd}
      />,
    );

    // Only the delete button remains when onEdit is not passed down
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBe(1);
    fireEvent.click(buttons[0]!);
    expect(defaultOnDelete).toHaveBeenCalledTimes(1);
  });

  test("does not show empty state when connections exist", () => {
    const { queryByText } = render(
      <ConnectionsList
        connections={[mockPostgresConnection]}
        activeConnection={null}
        onSelectConnection={defaultOnSelect}
        onDeleteConnection={defaultOnDelete}
        onAddConnection={defaultOnAdd}
      />,
    );

    expect(queryByText("No database connections established yet.")).toBeNull();
  });
});
