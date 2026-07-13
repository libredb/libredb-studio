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

  test("delete button removes query after confirm", () => {
    const originalConfirm = globalThis.confirm;
    globalThis.confirm = mock(() => true) as unknown as typeof confirm;
    try {
      const onSelectQuery = mock(() => {});
      const { container, queryByText } = render(<SavedQueries onSelectQuery={onSelectQuery} />);
      expect(queryByText("Active Users")).not.toBeNull();

      // After deletion, storage returns an empty list
      mockGetSavedQueries.mockImplementation(() => []);

      // Buttons per card: [0] edit, [1] delete
      const deleteButton = container.querySelectorAll("button")[1];
      expect(deleteButton).not.toBeNull();
      fireEvent.click(deleteButton!);

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
      const { container, queryByText } = render(<SavedQueries onSelectQuery={mock(() => {})} />);

      const deleteButton = container.querySelectorAll("button")[1];
      fireEvent.click(deleteButton!);

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
});
