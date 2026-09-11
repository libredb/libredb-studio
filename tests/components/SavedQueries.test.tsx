import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { SavedQuery } from "@/lib/types";
import { mockToastDefault, mockToastError, mockToastSuccess } from "../helpers/mock-sonner";

const mockSavedQueries: SavedQuery[] = [
  {
    id: "q1",
    name: "Active Users",
    description: "Get active users",
    query: "SELECT * FROM users WHERE active = true",
    connectionType: "postgres",
    tags: ["report"],
    createdAt: new Date("2026-01-15T10:00:00Z"),
    updatedAt: new Date("2026-01-15T10:00:00Z"),
  },
];

const mockGetSavedQueries = mock(() => [...mockSavedQueries]);
const mockDeleteSavedQuery = mock(() => {});
const mockImportSavedQueries = mock((_queries: SavedQuery[]) => ({ imported: 1, collisions: [] as string[] }));
const mockDownloadText = mock((_text: string, _type: string, _name: string) => {});
mock.module("@/lib/export/download", () => ({ downloadText: mockDownloadText }));

mock.module("@/lib/storage", () => ({
  storage: {
    getSavedQueries: mockGetSavedQueries,
    deleteSavedQuery: mockDeleteSavedQuery,
    importSavedQueries: mockImportSavedQueries,
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
    mockImportSavedQueries.mockClear();
    mockImportSavedQueries.mockImplementation(() => ({ imported: 1, collisions: [] }));
    mockDownloadText.mockClear();
    mockToastDefault.mockClear();
    mockToastError.mockClear();
    mockToastSuccess.mockClear();
    mockGetSavedQueries.mockClear();
    mockDeleteSavedQuery.mockClear();
    mockGetSavedQueries.mockImplementation(() => [...mockSavedQueries]);
  });

  function importFile(input: HTMLElement, text: string) {
    const file = new File([text], "saved_queries.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => text });
    fireEvent.change(input, { target: { files: [file] } });
  }

  test("exports the complete library as JSON even while search and connection filters hide it", () => {
    const library = [...mockSavedQueries, { ...mockSavedQueries[0], id: "mysql", connectionType: "mysql" as const }];
    mockGetSavedQueries.mockReturnValue(library);
    const onSelectQuery = mock(() => {});
    const view = render(<SavedQueries onSelectQuery={onSelectQuery} connectionType="postgres" />);
    fireEvent.change(view.getByPlaceholderText("Search saved queries..."), { target: { value: "missing" } });
    fireEvent.click(view.getByRole("button", { name: "Export all saved queries as JSON" }));
    expect(mockDownloadText).toHaveBeenCalledWith(
      JSON.stringify(library, null, 2),
      "application/json",
      expect.stringMatching(/^saved_queries_\d+\.json$/),
    );
    expect(onSelectQuery).not.toHaveBeenCalled();
  });

  test("imports valid saved queries, reloads the library and retains search without executing", async () => {
    const imported = { ...mockSavedQueries[0], id: "new", name: "Imported Query", query: "SELECT '你好';" };
    const onSelectQuery = mock(() => {});
    const view = render(<SavedQueries onSelectQuery={onSelectQuery} />);
    const search = view.getByPlaceholderText("Search saved queries...") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "Imported" } });
    mockGetSavedQueries.mockReturnValue([...mockSavedQueries, imported]);
    const input = view.getByLabelText("Import saved queries JSON") as HTMLInputElement;
    const setInputValue = mock((_value: string) => {});
    Object.defineProperty(input, "value", { configurable: true, set: setInputValue });
    importFile(input, JSON.stringify([imported]));
    await waitFor(() => expect(mockImportSavedQueries).toHaveBeenCalledWith([imported]));
    expect(view.getByRole("button", { name: "Imported Query" }) !== null).toBe(true);
    expect(mockToastSuccess).toHaveBeenCalledWith("Saved queries import finished", { description: "Added 1." });
    expect(search.value).toBe("Imported");
    expect(setInputValue).toHaveBeenCalledWith("");
    expect(onSelectQuery).not.toHaveBeenCalled();
  });

  test("reports colliding IDs instead of announcing an unconditional success", async () => {
    mockImportSavedQueries.mockReturnValue({ imported: 1, collisions: ["q1", "duplicate"] });
    const view = render(<SavedQueries onSelectQuery={mock(() => {})} />);
    importFile(view.getByLabelText("Import saved queries JSON"), JSON.stringify(mockSavedQueries));
    await waitFor(() =>
      expect(mockToastDefault).toHaveBeenCalledWith("Import finished with ID conflicts", {
        description: "Added 1; skipped duplicate IDs: q1, duplicate.",
      }),
    );
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  test.each(["{", JSON.stringify({ queries: [] }), JSON.stringify([{ ...mockSavedQueries[0], updatedAt: "invalid" }])])(
    "rejects an invalid import without writing any queries",
    async (text) => {
      const view = render(<SavedQueries onSelectQuery={mock(() => {})} />);
      importFile(view.getByLabelText("Import saved queries JSON"), text);
      await waitFor(() => expect(mockToastError).toHaveBeenCalled());
      expect(mockImportSavedQueries).not.toHaveBeenCalled();
      expect((view.getByRole("button", { name: "Import JSON" }) as HTMLButtonElement).disabled).toBe(false);
    },
  );

  test("opens the file picker, handles cancellation and disables export for an empty library", () => {
    mockGetSavedQueries.mockReturnValue([]);
    const view = render(<SavedQueries onSelectQuery={mock(() => {})} />);
    const input = view.getByLabelText("Import saved queries JSON") as HTMLInputElement;
    input.click = mock(() => {});
    fireEvent.click(view.getByRole("button", { name: "Import JSON" }));
    expect(input.click).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { files: [] } });
    expect(mockImportSavedQueries).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
    expect((view.getByRole("button", { name: "Export all saved queries as JSON" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("keeps the import control disabled until the file read settles and reports read failures", async () => {
    const view = render(<SavedQueries onSelectQuery={mock(() => {})} />);
    let rejectRead!: (error: Error) => void;
    const file = new File([], "queries.json");
    Object.defineProperty(file, "text", {
      value: () =>
        new Promise<string>((_resolve, reject) => {
          rejectRead = reject;
        }),
    });
    fireEvent.change(view.getByLabelText("Import saved queries JSON"), { target: { files: [file] } });
    const button = view.getByRole("button", { name: "Import JSON" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    rejectRead(new Error("Unreadable file"));
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(mockImportSavedQueries).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(
      "Could not import saved queries. Check the JSON file and available browser storage.",
    );
  });

  test("reports a storage failure without success or executing a query", async () => {
    mockImportSavedQueries.mockImplementation(() => {
      throw new Error("Storage full");
    });
    const onSelectQuery = mock(() => {});
    const view = render(<SavedQueries onSelectQuery={onSelectQuery} />);
    importFile(view.getByLabelText("Import saved queries JSON"), JSON.stringify(mockSavedQueries));
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(onSelectQuery).not.toHaveBeenCalled();
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
        createdAt: new Date("2026-01-16T10:00:00Z"),
        updatedAt: new Date("2026-01-16T10:00:00Z"),
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
