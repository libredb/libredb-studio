import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

const mockSavedQueries = [
  {
    id: "q1",
    name: "Active Users",
    description: "Get active users",
    query: "SELECT * FROM users WHERE active = true",
    connectionType: "postgres",
    tags: ["report"],
    createdAt: "2026-01-15T10:00:00Z",
    updatedAt: "2026-01-15T10:00:00Z",
  },
];

const mockGetSavedQueries = mock(() => [...mockSavedQueries]);
const mockDeleteSavedQuery = mock(() => {});

mock.module("@/lib/storage", () => ({
  storage: {
    getSavedQueries: mockGetSavedQueries,
    deleteSavedQuery: mockDeleteSavedQuery,
  },
}));

mock.module("date-fns", () => ({
  format: (d: unknown) => {
    if (d instanceof Date) return d.toISOString().split("T")[0];
    return String(d).split("T")[0];
  },
}));

import { SavedQueries } from "@/components/SavedQueries";

describe("SavedQueries", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockGetSavedQueries.mockClear();
    mockDeleteSavedQuery.mockClear();
    mockGetSavedQueries.mockImplementation(() => [...mockSavedQueries]);
  });

  test("renders saved query items", () => {
    const { queryByText } = render(<SavedQueries onSelectQuery={mock(() => {})} />);
    expect(queryByText("Active Users")).not.toBeNull();
    expect(queryByText("Get active users")).not.toBeNull();
  });

  // ── A11y semantics (#100) ─────────────────────────────────────────────────

  test("query card is loaded via a button named after the query", () => {
    const onSelectQuery = mock(() => {});
    const { getByRole } = render(<SavedQueries onSelectQuery={onSelectQuery} />);
    fireEvent.click(getByRole("button", { name: "Active Users" }));
    expect(onSelectQuery).toHaveBeenCalledTimes(1);
    expect(onSelectQuery).toHaveBeenCalledWith("SELECT * FROM users WHERE active = true");
  });

  test("edit button loads the query for editing", () => {
    const onSelectQuery = mock(() => {});
    const { getByRole } = render(<SavedQueries onSelectQuery={onSelectQuery} />);
    fireEvent.click(getByRole("button", { name: "Edit Active Users" }));
    expect(onSelectQuery).toHaveBeenCalledTimes(1);
    expect(onSelectQuery).toHaveBeenCalledWith("SELECT * FROM users WHERE active = true");
  });

  test("card actions are revealed on keyboard focus and non-hover devices", () => {
    const { getByRole } = render(<SavedQueries onSelectQuery={mock(() => {})} />);
    const actions = getByRole("button", { name: "Delete Active Users" }).parentElement!;
    expect(actions.className).toContain("focus-within:opacity-100");
    expect(actions.className).toContain("[@media(hover:none)]:opacity-100");
  });

  test("delete button removes query after confirm", () => {
    const originalConfirm = globalThis.confirm;
    globalThis.confirm = mock(() => true) as unknown as typeof confirm;
    try {
      const onSelectQuery = mock(() => {});
      const { getByRole, queryByText } = render(<SavedQueries onSelectQuery={onSelectQuery} />);
      expect(queryByText("Active Users")).not.toBeNull();

      // After deletion, storage returns an empty list
      mockGetSavedQueries.mockImplementation(() => []);

      fireEvent.click(getByRole("button", { name: "Delete Active Users" }));

      expect(mockDeleteSavedQuery).toHaveBeenCalledTimes(1);
      expect(mockDeleteSavedQuery).toHaveBeenCalledWith("q1");
      // stopPropagation keeps the card onClick from firing
      expect(onSelectQuery).not.toHaveBeenCalled();
      expect(queryByText("Active Users")).toBeNull();
      expect(queryByText("No saved queries found")).not.toBeNull();
    } finally {
      globalThis.confirm = originalConfirm;
    }
  });

  test("delete cancelled by confirm keeps query", () => {
    const originalConfirm = globalThis.confirm;
    globalThis.confirm = mock(() => false) as unknown as typeof confirm;
    try {
      const { getByRole, queryByText } = render(<SavedQueries onSelectQuery={mock(() => {})} />);

      fireEvent.click(getByRole("button", { name: "Delete Active Users" }));

      expect(mockDeleteSavedQuery).not.toHaveBeenCalled();
      expect(queryByText("Active Users")).not.toBeNull();
    } finally {
      globalThis.confirm = originalConfirm;
    }
  });

  test("shows empty state when no queries match", () => {
    mockGetSavedQueries.mockImplementation(() => []);
    const { queryByText } = render(<SavedQueries onSelectQuery={mock(() => {})} />);
    expect(queryByText("No saved queries found")).not.toBeNull();
  });

  // ── refreshTrigger change reloads saved queries ────────────────────

  test("refreshTrigger change reloads saved queries from storage", () => {
    const { queryByText, rerender } = render(<SavedQueries onSelectQuery={mock(() => {})} refreshTrigger={0} />);
    expect(queryByText("Active Users")).not.toBeNull();

    mockGetSavedQueries.mockClear();
    mockGetSavedQueries.mockImplementation(() => [
      ...mockSavedQueries,
      {
        id: "q2",
        name: "Churned Users",
        description: "Get churned users",
        query: "SELECT * FROM users WHERE active = false",
        connectionType: "postgres",
        tags: ["report"],
        createdAt: "2026-01-16T10:00:00Z",
        updatedAt: "2026-01-16T10:00:00Z",
      },
    ]);

    rerender(<SavedQueries onSelectQuery={mock(() => {})} refreshTrigger={1} />);

    expect(mockGetSavedQueries).toHaveBeenCalled();
    expect(queryByText("Churned Users")).not.toBeNull();
  });

  // A refresh must not behave like a `key` re-mount: the search the user is typing
  // while a save lands has to survive it.
  test("a refresh keeps the search the user typed", () => {
    const { getByPlaceholderText, rerender } = render(
      <SavedQueries onSelectQuery={mock(() => {})} refreshTrigger={0} />,
    );
    const input = getByPlaceholderText("Search saved queries...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Active" } });
    expect(input.value).toBe("Active");

    rerender(<SavedQueries onSelectQuery={mock(() => {})} refreshTrigger={1} />);

    expect((getByPlaceholderText("Search saved queries...") as HTMLInputElement).value).toBe("Active");
  });
});
