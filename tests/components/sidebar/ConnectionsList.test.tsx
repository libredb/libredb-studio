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
  getDBConfig: () => ({ icon: () => null, color: "text-hue-blue", label: "PostgreSQL", defaultPort: "5432" }),
  getDBColor: () => "text-hue-blue",
}));

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup } from "@testing-library/react";
import React from "react";

import { ConnectionsList } from "@/components/sidebar/ConnectionsList";
import {
  mockPostgresConnection,
  mockMySQLConnection,
  mockSQLiteConnection,
  mockMongoDBConnection,
} from "../../fixtures/connections";

// =============================================================================
// ConnectionsList Tests
// =============================================================================

describe("ConnectionsList", () => {
  test("passes duplicate requests to the connection editor", () => {
    const onDuplicateConnection = mock(() => {});
    const view = render(
      <ConnectionsList
        connections={[mockPostgresConnection]}
        activeConnection={null}
        onSelectConnection={mock(() => {})}
        onDeleteConnection={mock(() => {})}
        onAddConnection={mock(() => {})}
        onDuplicateConnection={onDuplicateConnection}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: "Duplicate connection" }));
    expect(onDuplicateConnection).toHaveBeenCalledWith(mockPostgresConnection);
  });
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

    // Active item should have bg-brand-solid/10 class
    expect(pgItem?.className.includes("bg-brand-solid/10")).toBe(true);
    // Inactive item should not
    expect(mysqlItem?.className.includes("bg-brand-solid/10")).toBeFalsy();
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

  describe("favorites", () => {
    const defaultOnToggleFavorite = mock(() => {});

    beforeEach(() => {
      defaultOnToggleFavorite.mockClear();
    });

    test("no Favorites section when favoriteConnectionIds is not passed", () => {
      const { queryByText } = render(
        <ConnectionsList
          connections={[mockPostgresConnection, mockMySQLConnection]}
          activeConnection={null}
          onSelectConnection={defaultOnSelect}
          onDeleteConnection={defaultOnDelete}
          onAddConnection={defaultOnAdd}
        />,
      );

      expect(queryByText("Favorites")).toBeNull();
    });

    test("no Favorites section when favoriteConnectionIds is empty", () => {
      const { queryByText } = render(
        <ConnectionsList
          connections={[mockPostgresConnection, mockMySQLConnection]}
          activeConnection={null}
          onSelectConnection={defaultOnSelect}
          onDeleteConnection={defaultOnDelete}
          onAddConnection={defaultOnAdd}
          favoriteConnectionIds={new Set()}
        />,
      );

      expect(queryByText("Favorites")).toBeNull();
    });

    test("renders a Favorites section above Connections when a connection is favorited", () => {
      const { getByText } = render(
        <ConnectionsList
          connections={[mockPostgresConnection, mockMySQLConnection]}
          activeConnection={null}
          onSelectConnection={defaultOnSelect}
          onDeleteConnection={defaultOnDelete}
          onAddConnection={defaultOnAdd}
          favoriteConnectionIds={new Set([mockMySQLConnection.id])}
          onToggleFavoriteConnection={defaultOnToggleFavorite}
        />,
      );

      const favoritesHeader = getByText("Favorites");
      const connectionsHeader = getByText("Connections");
      // DOM order: Favorites section precedes the Connections section
      expect(
        favoritesHeader.compareDocumentPosition(connectionsHeader) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    test("a favorited connection renders once, under Favorites, not duplicated under Connections", () => {
      const { container } = render(
        <ConnectionsList
          connections={[mockPostgresConnection, mockMySQLConnection]}
          activeConnection={null}
          onSelectConnection={defaultOnSelect}
          onDeleteConnection={defaultOnDelete}
          onAddConnection={defaultOnAdd}
          favoriteConnectionIds={new Set([mockMySQLConnection.id])}
          onToggleFavoriteConnection={defaultOnToggleFavorite}
        />,
      );

      const matches = Array.from(container.querySelectorAll("span")).filter((el) => el.textContent === "Test MySQL");
      expect(matches.length).toBe(1);
    });

    test("non-favorited connections keep rendering under Connections", () => {
      const { queryByText } = render(
        <ConnectionsList
          connections={[mockPostgresConnection, mockMySQLConnection]}
          activeConnection={null}
          onSelectConnection={defaultOnSelect}
          onDeleteConnection={defaultOnDelete}
          onAddConnection={defaultOnAdd}
          favoriteConnectionIds={new Set([mockMySQLConnection.id])}
          onToggleFavoriteConnection={defaultOnToggleFavorite}
        />,
      );

      expect(queryByText("Test PostgreSQL")).not.toBeNull();
    });

    test("clicking the star toggle calls onToggleFavoriteConnection with the connection id", () => {
      const { getByLabelText } = render(
        <ConnectionsList
          connections={[mockPostgresConnection]}
          activeConnection={null}
          onSelectConnection={defaultOnSelect}
          onDeleteConnection={defaultOnDelete}
          onAddConnection={defaultOnAdd}
          favoriteConnectionIds={new Set()}
          onToggleFavoriteConnection={defaultOnToggleFavorite}
        />,
      );

      fireEvent.click(getByLabelText("Add to favorites"));

      expect(defaultOnToggleFavorite).toHaveBeenCalledTimes(1);
      expect(defaultOnToggleFavorite).toHaveBeenCalledWith(mockPostgresConnection.id);
      // stopPropagation: the item itself must not be selected
      expect(defaultOnSelect).not.toHaveBeenCalled();
    });

    test("a favorited connection's star toggle is labeled to remove it", () => {
      const { getByLabelText } = render(
        <ConnectionsList
          connections={[mockPostgresConnection]}
          activeConnection={null}
          onSelectConnection={defaultOnSelect}
          onDeleteConnection={defaultOnDelete}
          onAddConnection={defaultOnAdd}
          favoriteConnectionIds={new Set([mockPostgresConnection.id])}
          onToggleFavoriteConnection={defaultOnToggleFavorite}
        />,
      );

      fireEvent.click(getByLabelText("Remove from favorites"));

      expect(defaultOnToggleFavorite).toHaveBeenCalledWith(mockPostgresConnection.id);
    });

    test("shows the Connections empty state only when there are truly no connections, not when all are favorited", () => {
      const { queryByText } = render(
        <ConnectionsList
          connections={[mockPostgresConnection]}
          activeConnection={null}
          onSelectConnection={defaultOnSelect}
          onDeleteConnection={defaultOnDelete}
          onAddConnection={defaultOnAdd}
          favoriteConnectionIds={new Set([mockPostgresConnection.id])}
          onToggleFavoriteConnection={defaultOnToggleFavorite}
        />,
      );

      expect(queryByText("No database connections established yet.")).toBeNull();
    });

    test("hides the Connections section entirely when every connection is favorited", () => {
      const { queryByText } = render(
        <ConnectionsList
          connections={[mockPostgresConnection, mockMySQLConnection]}
          activeConnection={null}
          onSelectConnection={defaultOnSelect}
          onDeleteConnection={defaultOnDelete}
          onAddConnection={defaultOnAdd}
          favoriteConnectionIds={new Set([mockPostgresConnection.id, mockMySQLConnection.id])}
          onToggleFavoriteConnection={defaultOnToggleFavorite}
        />,
      );

      // Both are under Favorites; the "Connections" header has nothing left to sit above.
      expect(queryByText("Connections")).toBeNull();
    });

    test("keeps the Connections section when at least one connection is not favorited", () => {
      const { queryByText } = render(
        <ConnectionsList
          connections={[mockPostgresConnection, mockMySQLConnection]}
          activeConnection={null}
          onSelectConnection={defaultOnSelect}
          onDeleteConnection={defaultOnDelete}
          onAddConnection={defaultOnAdd}
          favoriteConnectionIds={new Set([mockPostgresConnection.id])}
          onToggleFavoriteConnection={defaultOnToggleFavorite}
        />,
      );

      expect(queryByText("Connections")).not.toBeNull();
    });
  });

  describe("reordering (#748)", () => {
    const defaultOnReorder = mock(() => {});

    beforeEach(() => {
      defaultOnReorder.mockClear();
    });

    function itemNames(container: HTMLElement): string[] {
      return Array.from(container.querySelectorAll('[class*="cursor-pointer"]')).map((el) => el.textContent ?? "");
    }

    /**
     * Re-queries by text on every call rather than returning a cached node: the
     * mocked `motion.div` (above) allocates a new component type on each property
     * access, so a state-driven re-render remounts the element and any reference
     * held across it goes stale. Every drag step in this group must re-find its
     * target immediately before firing, not reuse a node found before an earlier
     * step's re-render.
     */
    function findItem(container: HTMLElement, text: string): HTMLElement {
      return Array.from(container.querySelectorAll('[class*="cursor-pointer"]')).find((el) =>
        el.textContent?.includes(text),
      ) as HTMLElement;
    }

    test("renders connections in connectionOrder rather than array order", () => {
      const { container } = render(
        <ConnectionsList
          connections={[mockPostgresConnection, mockMySQLConnection]}
          activeConnection={null}
          onSelectConnection={defaultOnSelect}
          onDeleteConnection={defaultOnDelete}
          onAddConnection={defaultOnAdd}
          connectionOrder={[mockMySQLConnection.id, mockPostgresConnection.id]}
        />,
      );

      const names = itemNames(container);
      expect(names[0]).toContain("Test MySQL");
      expect(names[1]).toContain("Test PostgreSQL");
    });

    test("a connection absent from connectionOrder sorts after the ones it knows about", () => {
      const { container } = render(
        <ConnectionsList
          connections={[mockPostgresConnection, mockMySQLConnection, mockSQLiteConnection]}
          activeConnection={null}
          onSelectConnection={defaultOnSelect}
          onDeleteConnection={defaultOnDelete}
          onAddConnection={defaultOnAdd}
          connectionOrder={[mockMySQLConnection.id, mockPostgresConnection.id]}
        />,
      );

      const names = itemNames(container);
      expect(names[2]).toContain(mockSQLiteConnection.name);
    });

    test("no drag handle when onReorderConnections is not passed", () => {
      const { queryByTestId } = render(
        <ConnectionsList
          connections={[mockPostgresConnection, mockMySQLConnection]}
          activeConnection={null}
          onSelectConnection={defaultOnSelect}
          onDeleteConnection={defaultOnDelete}
          onAddConnection={defaultOnAdd}
        />,
      );

      expect(queryByTestId(`drag-handle-${mockPostgresConnection.id}`)).toBeNull();
    });

    test("no drag handle for exactly one connection", () => {
      const { queryByTestId } = render(
        <ConnectionsList
          connections={[mockPostgresConnection]}
          activeConnection={null}
          onSelectConnection={defaultOnSelect}
          onDeleteConnection={defaultOnDelete}
          onAddConnection={defaultOnAdd}
          onReorderConnections={defaultOnReorder}
        />,
      );

      expect(queryByTestId(`drag-handle-${mockPostgresConnection.id}`)).toBeNull();
    });

    test("dragging one connection onto another persists the swapped order", () => {
      const { container } = render(
        <ConnectionsList
          connections={[mockPostgresConnection, mockMySQLConnection]}
          activeConnection={null}
          onSelectConnection={defaultOnSelect}
          onDeleteConnection={defaultOnDelete}
          onAddConnection={defaultOnAdd}
          onReorderConnections={defaultOnReorder}
        />,
      );

      fireEvent.dragStart(findItem(container, "Test PostgreSQL"));
      fireEvent.dragEnter(findItem(container, "Test MySQL"));
      fireEvent.drop(findItem(container, "Test MySQL"));

      expect(defaultOnReorder).toHaveBeenCalledTimes(1);
      expect(defaultOnReorder).toHaveBeenCalledWith([mockMySQLConnection.id, mockPostgresConnection.id]);
      // Reordering is a drag concern, not a selection one.
      expect(defaultOnSelect).not.toHaveBeenCalled();
    });

    test("dragging a connection past a non-adjacent target inserts it there", () => {
      const { container } = render(
        <ConnectionsList
          connections={[mockPostgresConnection, mockMySQLConnection, mockSQLiteConnection]}
          activeConnection={null}
          onSelectConnection={defaultOnSelect}
          onDeleteConnection={defaultOnDelete}
          onAddConnection={defaultOnAdd}
          onReorderConnections={defaultOnReorder}
        />,
      );

      fireEvent.dragStart(findItem(container, "Test PostgreSQL"));
      fireEvent.dragEnter(findItem(container, mockSQLiteConnection.name));
      fireEvent.drop(findItem(container, mockSQLiteConnection.name));

      expect(defaultOnReorder).toHaveBeenCalledWith([
        mockMySQLConnection.id,
        mockSQLiteConnection.id,
        mockPostgresConnection.id,
      ]);
    });

    test("dragging over a connection highlights it as the drop target", () => {
      const { container } = render(
        <ConnectionsList
          connections={[mockPostgresConnection, mockMySQLConnection]}
          activeConnection={null}
          onSelectConnection={defaultOnSelect}
          onDeleteConnection={defaultOnDelete}
          onAddConnection={defaultOnAdd}
          onReorderConnections={defaultOnReorder}
        />,
      );

      fireEvent.dragStart(findItem(container, "Test PostgreSQL"));
      fireEvent.dragEnter(findItem(container, "Test MySQL"));

      expect(findItem(container, "Test MySQL").className).toContain("ring-brand-solid");
      expect(findItem(container, "Test PostgreSQL").className).toContain("opacity-40");

      fireEvent.dragEnd(findItem(container, "Test PostgreSQL"));

      expect(findItem(container, "Test MySQL").className).not.toContain("ring-brand-solid");
      expect(findItem(container, "Test PostgreSQL").className).not.toContain("opacity-40");
    });

    test("dropping a connection onto itself is a no-op", () => {
      const { container } = render(
        <ConnectionsList
          connections={[mockPostgresConnection, mockMySQLConnection]}
          activeConnection={null}
          onSelectConnection={defaultOnSelect}
          onDeleteConnection={defaultOnDelete}
          onAddConnection={defaultOnAdd}
          onReorderConnections={defaultOnReorder}
        />,
      );

      fireEvent.dragStart(findItem(container, "Test PostgreSQL"));
      fireEvent.drop(findItem(container, "Test PostgreSQL"));

      expect(defaultOnReorder).not.toHaveBeenCalled();
    });

    describe("with favorites", () => {
      // Four connections, so a test can give both sections two rows: a row alone in its
      // section is not draggable and carries no drop handlers at all.
      function renderWithFavorites(favoriteIds: string[], connectionOrder?: string[]) {
        return render(
          <ConnectionsList
            connections={[mockPostgresConnection, mockMySQLConnection, mockSQLiteConnection, mockMongoDBConnection]}
            activeConnection={null}
            onSelectConnection={defaultOnSelect}
            onDeleteConnection={defaultOnDelete}
            onAddConnection={defaultOnAdd}
            favoriteConnectionIds={new Set(favoriteIds)}
            onToggleFavoriteConnection={mock(() => {})}
            connectionOrder={connectionOrder}
            onReorderConnections={defaultOnReorder}
          />,
        );
      }

      test("each section follows connectionOrder within itself", () => {
        const { container } = renderWithFavorites(
          [mockPostgresConnection.id, mockSQLiteConnection.id],
          [mockSQLiteConnection.id, mockMySQLConnection.id, mockPostgresConnection.id],
        );

        const names = itemNames(container);
        expect(names[0]).toContain(mockSQLiteConnection.name);
        expect(names[1]).toContain("Test PostgreSQL");
        expect(names[2]).toContain("Test MySQL");
      });

      test("a drop inside the Favorites section persists the new order", () => {
        const { container } = renderWithFavorites([mockPostgresConnection.id, mockSQLiteConnection.id]);

        fireEvent.dragStart(findItem(container, mockSQLiteConnection.name));
        fireEvent.dragEnter(findItem(container, "Test PostgreSQL"));
        fireEvent.drop(findItem(container, "Test PostgreSQL"));

        expect(defaultOnReorder).toHaveBeenCalledWith([
          mockSQLiteConnection.id,
          mockPostgresConnection.id,
          mockMySQLConnection.id,
          mockMongoDBConnection.id,
        ]);
      });

      test("a drop onto a connection in the other section is ignored", () => {
        // The dragged row would stay in its own section, so the only effect of accepting the
        // drop would be a change to the saved order that nothing on screen shows.
        const { container, queryByTestId } = renderWithFavorites([mockMySQLConnection.id, mockSQLiteConnection.id]);
        // The target accepts drops: it shares its section with another row, so it is draggable.
        expect(queryByTestId(`drag-handle-${mockPostgresConnection.id}`)).not.toBeNull();

        fireEvent.dragStart(findItem(container, "Test MySQL"));
        fireEvent.dragEnter(findItem(container, "Test PostgreSQL"));
        fireEvent.drop(findItem(container, "Test PostgreSQL"));

        expect(defaultOnReorder).not.toHaveBeenCalled();
      });

      test("only a connection in the same section is highlighted as a drop target", () => {
        const { container } = renderWithFavorites([mockPostgresConnection.id, mockMongoDBConnection.id]);

        fireEvent.dragStart(findItem(container, "Test MySQL"));
        fireEvent.dragEnter(findItem(container, "Test PostgreSQL"));

        expect(findItem(container, "Test PostgreSQL").className).not.toContain("ring-brand-solid");

        fireEvent.dragEnter(findItem(container, mockSQLiteConnection.name));

        expect(findItem(container, mockSQLiteConnection.name).className).toContain("ring-brand-solid");
      });

      test("no drag handle on a connection that is alone in its section", () => {
        const { queryByTestId } = renderWithFavorites([mockPostgresConnection.id]);

        expect(queryByTestId(`drag-handle-${mockPostgresConnection.id}`)).toBeNull();
        expect(queryByTestId(`drag-handle-${mockMySQLConnection.id}`)).not.toBeNull();
        expect(queryByTestId(`drag-handle-${mockSQLiteConnection.id}`)).not.toBeNull();
      });
    });
  });
});
