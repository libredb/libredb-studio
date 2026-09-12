import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, within, fireEvent, act, waitFor } from "@testing-library/react";
import { DataImportModal } from "@/components/DataImportModal";
import type { DetailedObject } from "@/lib/db/detailed-object";
import { pathKey } from "@/lib/db/object-path";
import type { ProviderCapabilities } from "@/lib/db/types";

// The insecure-context harness, as in tests/components/copy-button.test.tsx: an absent
// `navigator.clipboard` is what plain HTTP off loopback actually hands the page, and an
// editing command that answers false is what a browser that refuses the copy does.
const originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
const originalExecCommand = Object.getOwnPropertyDescriptor(globalThis.document, "execCommand");

function setClipboard(clipboard: { writeText: (text: string) => Promise<void> } | undefined): void {
  Object.defineProperty(globalThis.navigator, "clipboard", { value: clipboard, configurable: true });
}

function setExecCommand(execCommand: ((command: string) => boolean) | undefined): void {
  Object.defineProperty(globalThis.document, "execCommand", { value: execCommand, configurable: true });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const noop = mock(() => {});

const sampleTables: DetailedObject[] = [
  {
    name: "users",
    kind: "table",
    path: ["users"],
    columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
    indexes: [],
  },
  {
    name: "orders",
    kind: "table",
    path: ["orders"],
    columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
    indexes: [],
  },
];

/**
 * Simulate a file upload by creating a mock File and dispatching a change event,
 * then synchronously invoking the FileReader's onload callback.
 */
function simulateFileUpload(container: HTMLElement, content: string, filename: string) {
  const file = new File([content], filename, { type: filename.endsWith(".json") ? "application/json" : "text/csv" });

  // Capture FileReader.readAsText calls and synchronously fire onload
  const origFileReader = globalThis.FileReader;
  const mockReaderInstance = {
    readAsText: mock(function (this: { onload: ((e: { target: { result: string } }) => void) | null }) {
      // fire onload synchronously
      if (this.onload) {
        this.onload({ target: { result: content } });
      }
    }),
    onload: null as ((e: { target: { result: string } }) => void) | null,
  };
  globalThis.FileReader = class {
    onload = null as ((e: { target: { result: string } }) => void) | null;
    readAsText() {
      mockReaderInstance.onload = this.onload;
      mockReaderInstance.readAsText.call(this);
    }
  } as unknown as typeof FileReader;

  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], writable: false });
  fireEvent.change(input);

  globalThis.FileReader = origFileReader;
}

// =============================================================================
// DataImportModal Tests
// =============================================================================

describe("DataImportModal", () => {
  afterEach(() => {
    cleanup();
    if (originalClipboard === undefined) setClipboard(undefined);
    else Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
    if (originalExecCommand === undefined) setExecCommand(undefined);
    else Object.defineProperty(globalThis.document, "execCommand", originalExecCommand);
  });

  // ── Render basics ──────────────────────────────────────────────────────────

  test("renders nothing when not open", () => {
    const { baseElement } = render(<DataImportModal isOpen={false} onClose={noop} onImport={noop} tables={[]} />);
    expect(within(baseElement).queryByText("Import Data")).toBeNull();
  });

  test("renders upload step when open", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={[]} />);
    expect(within(baseElement).queryByText("Import Data")).not.toBeNull();
  });

  test("shows file upload zone and format icons", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={[]} />);
    const body = within(baseElement);
    expect(body.queryByText("CSV")).not.toBeNull();
    expect(body.queryByText("JSON")).not.toBeNull();
    expect(body.queryByText(/Drop a file here/)).not.toBeNull();
  });

  test("shows step indicators", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={[]} />);
    const text = baseElement.textContent || "";
    expect(text).toContain("Upload");
    expect(text).toContain("Preview");
    expect(text).toContain("Configure");
    expect(text).toContain("Import");
  });

  test("has hidden file input accepting csv, json, tsv", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={[]} />);
    const input = baseElement.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.accept).toContain(".csv");
    expect(input.accept).toContain(".json");
  });

  // ── CSV file upload → Preview step ─────────────────────────────────────────

  test.each([";", "\t"])("delimiter picker reparses preview and keeps headerless import (%s)", (delimiter) => {
    const onImport = mock((_sql: string) => {});
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={onImport} tables={[]} />);
    act(() => simulateFileUpload(baseElement, `Alice${delimiter}30\nBob${delimiter}25`, "data.csv"));
    const body = within(baseElement);
    fireEvent.change(body.getByRole("combobox", { name: "CSV delimiter" }), { target: { value: delimiter } });
    expect(body.getByText("1 rows, 2 columns").textContent).toBe("1 rows, 2 columns");
    fireEvent.click(body.getByRole("checkbox", { name: "First row is header" }));
    expect(body.getByText("2 rows, 2 columns").textContent).toBe("2 rows, 2 columns");
    expect(body.getByRole("cell", { name: "Alice" }).textContent).toBe("Alice");
    fireEvent.click(body.getByText("Configure Import"));
    fireEvent.click(body.getByText("New Table"));
    fireEvent.click(body.getByText("Review SQL"));
    fireEvent.click(body.getByText("Execute Import"));
    expect(onImport.mock.calls[0][0]).toContain("('Alice', 30)");
    expect(onImport.mock.calls[0][0]).toContain("('Bob', 25)");
  });

  test("reset restores the comma delimiter and JSON hides the picker", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={[]} />);
    const body = within(baseElement);
    act(() => simulateFileUpload(baseElement, "name;age\nAlice;30", "data.csv"));
    fireEvent.change(body.getByRole("combobox", { name: "CSV delimiter" }), { target: { value: ";" } });
    fireEvent.click(body.getByText("Reset"));
    act(() => simulateFileUpload(baseElement, "name,age\nBob,25", "next.csv"));
    expect((body.getByRole("combobox", { name: "CSV delimiter" }) as HTMLSelectElement).value).toBe(",");
    expect(body.getByRole("cell", { name: "Bob" }).textContent).toBe("Bob");
    fireEvent.click(body.getByText("Reset"));
    act(() => simulateFileUpload(baseElement, '[{"name":"Alice"}]', "data.json"));
    expect(body.queryByRole("combobox", { name: "CSV delimiter" }) === null).toBe(true);
  });

  test("advances to preview step after CSV file upload", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30\nBob,25", "test.csv");
    });

    const body = within(baseElement);
    // Preview step shows file name (appears in header + preview body)
    expect(body.queryAllByText("test.csv").length).toBeGreaterThanOrEqual(1);
    expect(body.queryByText(/2 rows/)).not.toBeNull();
    expect(body.queryByText(/2 columns/)).not.toBeNull();
  });

  test("parses CSV with quoted fields, escaped quotes, and embedded commas", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, 'name,notes\n"Alice ""The Ace""","loves, commas"', "quoted.csv");
    });

    const body = within(baseElement);
    expect(body.queryByText('Alice "The Ace"')).not.toBeNull();
    expect(body.queryByText("loves, commas")).not.toBeNull();
  });

  test("headerless CSV preserves the first row through preview, mapping, and SQL import", () => {
    const onImport = mock((sql: string) => sql);
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={onImport} tables={sampleTables} />);
    act(() => simulateFileUpload(baseElement, "Alice,30\nBob,25", "headerless.csv"));

    const body = within(baseElement);
    const checkbox = body.getByRole("checkbox", { name: "First row is header" }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(body.getByText("1 rows, 2 columns")).not.toBeNull();
    act(() => fireEvent.click(checkbox));

    expect(checkbox.checked).toBe(false);
    expect(body.getByRole("columnheader", { name: "column_1" })).not.toBeNull();
    expect(body.getByRole("columnheader", { name: "column_2" })).not.toBeNull();
    expect(body.getByRole("cell", { name: "Alice" })).not.toBeNull();
    expect(body.getByRole("cell", { name: "Bob" })).not.toBeNull();
    expect(body.getByText("2 rows, 2 columns")).not.toBeNull();

    act(() => fireEvent.click(body.getByText("Configure Import")));
    expect((body.getByLabelText("Target column for column_1") as HTMLInputElement).value).toBe("column_1");
    act(() => {
      fireEvent.click(body.getByText("New Table"));
      fireEvent.change(body.getByLabelText("Target column for column_1"), { target: { value: "name" } });
    });
    act(() => fireEvent.click(body.getByText("Review SQL")));
    act(() => fireEvent.click(body.getByText("Execute Import")));

    expect(onImport).toHaveBeenCalledTimes(1);
    const sql = onImport.mock.calls[0][0];
    expect(sql).toContain("CREATE TABLE imported_data");
    expect(sql).toContain("INSERT INTO imported_data (name, column_2)");
    expect(sql).toContain("('Alice', 30)");
    expect(sql).toContain("('Bob', 25)");
  });

  test("the header option can be toggled repeatedly for a single-row CSV", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={[]} />);
    act(() => simulateFileUpload(baseElement, "Alice,30", "single.csv"));
    const body = within(baseElement);
    const checkbox = body.getByRole("checkbox", { name: "First row is header" });

    act(() => fireEvent.click(checkbox));
    expect(body.getByText("1 rows, 2 columns")).not.toBeNull();
    expect(body.getByRole("cell", { name: "Alice" })).not.toBeNull();
    act(() => fireEvent.click(checkbox));
    expect(body.getByText("0 rows, 2 columns")).not.toBeNull();
    expect(body.getByRole("columnheader", { name: "Alice" })).not.toBeNull();
    act(() => fireEvent.click(checkbox));
    expect(body.getByText("1 rows, 2 columns")).not.toBeNull();
    expect(body.getAllByRole("cell")).toHaveLength(2);
  });

  test.each([
    ["name", "age"],
    ["column_1", "column_2"],
    ["name", "column_2"],
  ])("preserves target column mappings through header toggles for %s,%s", (firstHeader, secondHeader) => {
    const onImport = mock((sql: string) => sql);
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={onImport} tables={[]} />);
    act(() => simulateFileUpload(baseElement, `${firstHeader},${secondHeader}\nAlice,30`, "mapped.csv"));
    const body = within(baseElement);

    act(() => fireEvent.click(body.getByText("Configure Import")));
    act(() => {
      fireEvent.click(body.getByText("New Table"));
      fireEvent.change(body.getByLabelText(`Target column for ${firstHeader}`), { target: { value: "full_name" } });
      fireEvent.change(body.getByLabelText(`Target column for ${secondHeader}`), { target: { value: "user_age" } });
    });
    act(() => fireEvent.click(body.getByText("Back")));
    act(() => fireEvent.click(body.getByRole("checkbox", { name: "First row is header" })));
    act(() => fireEvent.click(body.getByText("Configure Import")));

    expect((body.getByLabelText("Target column for column_1") as HTMLInputElement).value).toBe(
      firstHeader === "column_1" ? "full_name" : "column_1",
    );
    expect((body.getByLabelText("Target column for column_2") as HTMLInputElement).value).toBe(
      secondHeader === "column_2" ? "user_age" : "column_2",
    );

    act(() => fireEvent.click(body.getByText("Back")));
    act(() => fireEvent.click(body.getByRole("checkbox", { name: "First row is header" })));
    act(() => fireEvent.click(body.getByText("Configure Import")));
    expect((body.getByLabelText(`Target column for ${firstHeader}`) as HTMLInputElement).value).toBe("full_name");
    expect((body.getByLabelText(`Target column for ${secondHeader}`) as HTMLInputElement).value).toBe("user_age");
    act(() => fireEvent.click(body.getByText("Review SQL")));
    act(() => fireEvent.click(body.getByText("Execute Import")));

    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onImport.mock.calls[0][0]).toContain("INSERT INTO imported_data (full_name, user_age)");
    expect(onImport.mock.calls[0][0]).toContain("('Alice', 30)");
  });

  test("Reset restores header handling for the next CSV upload", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={[]} />);
    act(() => simulateFileUpload(baseElement, "name,age\nAlice,30", "first.csv"));
    const body = within(baseElement);
    act(() => fireEvent.click(body.getByText("Configure Import")));
    act(() => fireEvent.change(body.getByLabelText("Target column for name"), { target: { value: "full_name" } }));
    act(() => fireEvent.click(body.getByText("Back")));
    act(() => fireEvent.click(body.getByRole("checkbox", { name: "First row is header" })));
    act(() => fireEvent.click(body.getByText("Reset")));
    act(() => simulateFileUpload(baseElement, "name,age\nBob,25", "second.csv"));

    expect((body.getByRole("checkbox", { name: "First row is header" }) as HTMLInputElement).checked).toBe(true);
    expect(body.getByRole("columnheader", { name: "name" })).not.toBeNull();
    expect(body.getByRole("cell", { name: "Bob" })).not.toBeNull();
    expect(body.getByText("1 rows, 2 columns")).not.toBeNull();
    act(() => fireEvent.click(body.getByText("Configure Import")));
    expect((body.getByLabelText("Target column for name") as HTMLInputElement).value).toBe("name");
  });

  test("shows preview table headers from CSV", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30\nBob,25", "data.csv");
    });

    const body = within(baseElement);
    expect(body.queryByText("name")).not.toBeNull();
    expect(body.queryByText("age")).not.toBeNull();
  });

  test("shows preview table data rows", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30\nBob,25", "data.csv");
    });

    const body = within(baseElement);
    expect(body.queryByText("Alice")).not.toBeNull();
    expect(body.queryByText("Bob")).not.toBeNull();
    expect(body.queryByText("30")).not.toBeNull();
  });

  test('shows "more rows" indicator when data has >10 rows', () => {
    const rows = Array.from({ length: 15 }, (_, i) => `user${i},${20 + i}`).join("\n");
    const csv = `name,age\n${rows}`;

    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, csv, "large.csv");
    });

    expect(baseElement.textContent).toContain("and 5 more rows");
  });

  test("shows Configure Import button in preview step", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30", "data.csv");
    });

    expect(within(baseElement).queryByText("Configure Import")).not.toBeNull();
  });

  test("Reset button returns to upload step", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30", "data.csv");
    });

    // Should be in preview step (filename appears in header + preview body)
    expect(within(baseElement).queryAllByText("data.csv").length).toBeGreaterThanOrEqual(1);

    // Click Reset
    const resetBtn = within(baseElement).getByText("Reset");
    act(() => {
      fireEvent.click(resetBtn);
    });

    // Should be back to upload step
    expect(within(baseElement).queryByText(/Drop a file here/)).not.toBeNull();
  });

  // ── JSON file upload ───────────────────────────────────────────────────────

  test("advances to preview step after JSON file upload", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, '[{"name":"Alice","age":30}]', "data.json");
    });

    const body = within(baseElement);
    // File name appears in header + preview body
    expect(body.queryAllByText("data.json").length).toBeGreaterThanOrEqual(1);
    expect(body.queryByText(/1 row/)).not.toBeNull();
    expect(body.queryByRole("checkbox", { name: "First row is header" })).toBeNull();
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  test("shows error for invalid JSON file", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={[]} />);

    act(() => {
      simulateFileUpload(baseElement, "not valid json", "bad.json");
    });

    expect(baseElement.textContent).toContain("Failed to parse file");
  });

  test("shows error for empty CSV file", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={[]} />);

    act(() => {
      simulateFileUpload(baseElement, "", "empty.csv");
    });

    expect(baseElement.textContent).toContain("No data found in file");
  });

  // ── Preview → Configure step ──────────────────────────────────────────────

  test("advances to configure step from preview", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30", "data.csv");
    });

    // Click Configure Import
    const configBtn = within(baseElement).getByText("Configure Import");
    act(() => {
      fireEvent.click(configBtn);
    });

    const body = within(baseElement);
    // Configure step shows target table options
    expect(body.queryByText("Target Table")).not.toBeNull();
    expect(body.queryByText("Existing Table")).not.toBeNull();
    expect(body.queryByText("New Table")).not.toBeNull();
  });

  test("configure step shows column mapping section", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30", "data.csv");
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });

    expect(within(baseElement).queryByText("Column Mapping")).not.toBeNull();
    expect(within(baseElement).queryByText("Source Column")).not.toBeNull();
    expect(within(baseElement).queryByText("Target Column")).not.toBeNull();
  });

  test("configure step shows existing tables in dropdown", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30", "data.csv");
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });

    const select = baseElement.querySelector("select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    const options = Array.from(select.querySelectorAll("option"));
    const optionTexts = options.map((o) => o.textContent);
    expect(optionTexts).toContain("users");
    expect(optionTexts).toContain("orders");
  });

  test("Review SQL button is disabled when no table is selected", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30", "data.csv");
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });

    const reviewBtn = within(baseElement).getByText("Review SQL");
    expect(reviewBtn.closest("button")?.disabled).toBe(true);
  });

  test("selecting existing table enables Review SQL button", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30", "data.csv");
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });

    // Select a table
    const select = baseElement.querySelector("select") as HTMLSelectElement;
    act(() => {
      fireEvent.change(select, { target: { value: "users" } });
    });

    const reviewBtn = within(baseElement).getByText("Review SQL");
    expect(reviewBtn.closest("button")?.disabled).toBe(false);
  });

  test('switching to "New Table" shows name input and enables Review SQL', () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30", "data.csv");
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });

    // Click "New Table"
    act(() => {
      fireEvent.click(within(baseElement).getByText("New Table"));
    });

    expect(within(baseElement).queryByText("New Table Name")).not.toBeNull();

    // Review SQL should be enabled for new tables (default name "imported_data")
    const reviewBtn = within(baseElement).getByText("Review SQL");
    expect(reviewBtn.closest("button")?.disabled).toBe(false);
  });

  test("Back button in configure goes to preview", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30", "data.csv");
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });

    // Back button
    act(() => {
      fireEvent.click(within(baseElement).getByText("Back"));
    });

    // Should be back in preview
    expect(within(baseElement).queryByText("Configure Import")).not.toBeNull();
  });

  // ── Configure → Ready step ────────────────────────────────────────────────

  test("advances to ready step after configuring new table", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30\nBob,25", "data.csv");
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("New Table"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Review SQL"));
    });

    const body = within(baseElement);
    expect(body.queryByText("Ready to Import")).not.toBeNull();
    expect(body.queryByText(/2 rows into/)).not.toBeNull();
  });

  test("ready step shows SQL preview with CREATE TABLE", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30\nBob,25", "data.csv");
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("New Table"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Review SQL"));
    });

    const preEl = baseElement.querySelector("pre");
    expect(preEl).not.toBeNull();
    expect(preEl!.textContent).toContain("CREATE TABLE");
    expect(preEl!.textContent).toContain("INSERT INTO");
  });

  test("ready step shows SQL preview for existing table", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30", "data.csv");
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });

    const select = baseElement.querySelector("select") as HTMLSelectElement;
    act(() => {
      fireEvent.change(select, { target: { value: "users" } });
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Review SQL"));
    });

    const preEl = baseElement.querySelector("pre");
    expect(preEl).not.toBeNull();
    expect(preEl!.textContent).toContain("INSERT INTO users");
    expect(preEl!.textContent).not.toContain("CREATE TABLE");
  });

  test("ready step shows databaseType badge when provided", () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} databaseType="postgres" />,
    );

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30", "data.csv");
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("New Table"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Review SQL"));
    });

    expect(within(baseElement).queryByText("postgres")).not.toBeNull();
  });

  test("ready step has Copy SQL and Execute Import buttons", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30", "data.csv");
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("New Table"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Review SQL"));
    });

    expect(within(baseElement).queryByText("Copy SQL")).not.toBeNull();
    expect(within(baseElement).queryByText("Execute Import")).not.toBeNull();
  });

  test("Execute Import calls onImport with generated SQL", () => {
    const mockImport = mock(() => {});
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={mockImport} tables={sampleTables} />,
    );

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30", "data.csv");
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("New Table"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Review SQL"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Execute Import"));
    });

    expect(mockImport).toHaveBeenCalledTimes(1);
    const sql = (mockImport.mock.calls[0] as unknown[])[0] as string;
    expect(sql).toContain("CREATE TABLE");
    expect(sql).toContain("INSERT INTO");
  });

  test("Execute Import closes the modal after the import delay", async () => {
    const mockClose = mock(() => {});
    const { baseElement } = render(
      <DataImportModal isOpen onClose={mockClose} onImport={noop} tables={sampleTables} />,
    );

    act(() => {
      simulateFileUpload(baseElement, "name\nAlice", "data.csv");
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("New Table"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Review SQL"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Execute Import"));
    });

    // The modal closes (resetState + onClose) after a 200ms delay
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(within(baseElement).queryByText(/Drop a file here/)).not.toBeNull();
  });

  test("Back button in ready step goes to configure", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30", "data.csv");
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("New Table"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Review SQL"));
    });

    // Back
    const backBtns = within(baseElement).getAllByText("Back");
    act(() => {
      fireEvent.click(backBtns[backBtns.length - 1]);
    });

    // Should be in configure step
    expect(within(baseElement).queryByText("Target Table")).not.toBeNull();
  });

  // ── Column mapping ─────────────────────────────────────────────────────────

  test("column mapping shows source column names", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "first_name,last_name\nAlice,Smith", "data.csv");
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });

    const text = baseElement.textContent || "";
    expect(text).toContain("first_name");
    expect(text).toContain("last_name");
  });

  // ── New table name input ───────────────────────────────────────────────────

  test("new table name input changes target", () => {
    const mockImport = mock(() => {});
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={mockImport} tables={sampleTables} />,
    );

    act(() => {
      simulateFileUpload(baseElement, "name\nAlice", "data.csv");
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("New Table"));
    });

    // Type a table name
    const nameInput = baseElement.querySelector('input[placeholder="imported_data"]') as HTMLInputElement;
    act(() => {
      fireEvent.change(nameInput, { target: { value: "my_custom_table" } });
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Review SQL"));
    });

    // The ready step should show the custom table name
    expect(baseElement.textContent).toContain("my_custom_table");

    act(() => {
      fireEvent.click(within(baseElement).getByText("Execute Import"));
    });

    const sql = (mockImport.mock.calls[0] as unknown[])[0] as string;
    expect(sql).toContain("my_custom_table");
  });

  // ── Drag and drop ─────────────────────────────────────────────────────────

  test("dropping a file on the drop zone parses it and advances to preview", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    const dropZone = baseElement.querySelector(".border-dashed") as HTMLElement;
    expect(dropZone).not.toBeNull();

    const content = "name,age\nAlice,30";
    const file = new File([content], "dropped.csv", { type: "text/csv" });

    // Mock FileReader so onload fires synchronously with the file content
    const origFileReader = globalThis.FileReader;
    globalThis.FileReader = class {
      onload = null as ((e: { target: { result: string } }) => void) | null;
      readAsText() {
        this.onload?.({ target: { result: content } });
      }
    } as unknown as typeof FileReader;

    act(() => {
      fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });
    });

    globalThis.FileReader = origFileReader;

    // Preview step shows the dropped file name
    expect(within(baseElement).queryAllByText("dropped.csv").length).toBeGreaterThanOrEqual(1);
  });

  test("drag over handler is attached to drop zone", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={[]} />);

    const dropZone = baseElement.querySelector(".border-dashed") as HTMLElement;
    expect(dropZone).not.toBeNull();

    // fireEvent.dragOver triggers React's synthetic onDragOver handler
    // which calls e.preventDefault() — this should not throw
    fireEvent.dragOver(dropZone);

    // Drop zone should still be visible after drag over
    expect(dropZone).not.toBeNull();
  });

  // ── File name display ─────────────────────────────────────────────────────

  test("shows file name in header after upload", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={[]} />);

    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30", "my_data_file.csv");
    });

    // File name appears in dialog title area
    expect(baseElement.textContent).toContain("my_data_file.csv");
  });

  // ── Copy SQL ──────────────────────────────────────────────────────────────

  test("Copy SQL button calls navigator.clipboard", () => {
    const mockWriteText = mock(async () => {});
    setClipboard({ writeText: mockWriteText });

    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name\nAlice", "data.csv");
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("New Table"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Review SQL"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Copy SQL"));
    });

    expect(mockWriteText).toHaveBeenCalledTimes(1);
  });

  // B43: this button said nothing at all on the plain-HTTP channels this product ships
  // on — `navigator.clipboard` is undefined there, so the write threw inside the handler
  // and the user was left with an empty clipboard and no sign of it.
  test("Copy SQL reports the failure when both write paths refuse", async () => {
    setClipboard(undefined);
    setExecCommand(() => false);

    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name\nAlice", "data.csv");
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("New Table"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Review SQL"));
    });

    act(() => {
      fireEvent.click(within(baseElement).getByTestId("import-copy-sql"));
    });

    await waitFor(() =>
      expect(within(baseElement).getByTestId("import-copy-sql").textContent).toContain("Copy failed"),
    );
    expect(within(baseElement).getByTestId("import-copy-sql").textContent).not.toContain("Copied");
  });

  // ── Switching between Existing / New ──────────────────────────────────────

  test("toggling between existing and new table modes", () => {
    const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);

    act(() => {
      simulateFileUpload(baseElement, "name\nAlice", "data.csv");
    });

    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });

    // Default is existing table — select dropdown visible
    expect(baseElement.querySelector("select")).not.toBeNull();

    // Switch to new table
    act(() => {
      fireEvent.click(within(baseElement).getByText("New Table"));
    });

    expect(baseElement.querySelector('input[placeholder="imported_data"]')).not.toBeNull();
    expect(baseElement.querySelector("select")).toBeNull();

    // Switch back to existing table
    act(() => {
      fireEvent.click(within(baseElement).getByText("Existing Table"));
    });

    expect(baseElement.querySelector("select")).not.toBeNull();
  });

  // ── A11y semantics (#100) ──────────────────────────────────────────────────

  describe("a11y semantics", () => {
    test("upload dropzone is an accessible button", () => {
      const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);
      expect(within(baseElement).getByRole("button", { name: /Drop a file here/ })).not.toBeNull();
    });

    test("configure fields are reachable by their labels", () => {
      const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);
      act(() => {
        simulateFileUpload(baseElement, "name,age\nAlice,30", "data.csv");
      });
      act(() => {
        fireEvent.click(within(baseElement).getByText("Configure Import"));
      });
      expect(within(baseElement).getByLabelText("Select Table")).not.toBeNull();
      act(() => {
        fireEvent.click(within(baseElement).getByText("New Table"));
      });
      expect(within(baseElement).getByLabelText("New Table Name")).not.toBeNull();
    });

    test("column-mapping inputs are named after their source column", () => {
      const { baseElement } = render(<DataImportModal isOpen onClose={noop} onImport={noop} tables={sampleTables} />);
      act(() => {
        simulateFileUpload(baseElement, "name,age\nAlice,30", "data.csv");
      });
      act(() => {
        fireEvent.click(within(baseElement).getByText("Configure Import"));
      });
      expect(within(baseElement).getByLabelText("Target column for name")).not.toBeNull();
      expect(within(baseElement).getByLabelText("Target column for age")).not.toBeNull();
    });
  });
});

// =============================================================================
// The object model: what an import may be pointed at (#789)
// =============================================================================

describe("DataImportModal target filtering", () => {
  // Its own cleanup: an afterEach declared in a sibling describe does not reach this one,
  // and a leaked modal would make every getByLabelText below ambiguous.
  afterEach(() => {
    cleanup();
  });

  const capabilities = {
    queryLanguage: "sql",
    objectKinds: [
      { id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true },
      { id: "view", role: "relation", label: "View", labelPlural: "Views" },
      { id: "function", role: "routine", label: "Function", labelPlural: "Functions" },
    ],
  } as unknown as ProviderCapabilities;

  const inventory: DetailedObject[] = [
    { name: "orders", kind: "table", path: ["orders"], columns: [], indexes: [] },
    { name: "order_summary", kind: "view", path: ["order_summary"], columns: [], indexes: [] },
    { name: "order_total", kind: "function", path: ["order_total"], columns: [], indexes: [] },
  ];

  // The option TEXT, which is the label a person picks from. Its `value` is the address
  // (#789, Task 36) and is asserted on its own below.
  function targetNames(capabilitiesProp?: ProviderCapabilities): string[] {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={inventory} capabilities={capabilitiesProp} />,
    );
    act(() => {
      simulateFileUpload(baseElement, "name,age\nAlice,30", "data.csv");
    });
    act(() => {
      fireEvent.click(within(baseElement).getByText("Configure Import"));
    });
    const select = within(baseElement).getByLabelText("Select Table") as HTMLSelectElement;
    return Array.from(select.options)
      .map((option) => option.textContent ?? "")
      .filter((text) => text !== "-- Select a table --");
  }

  test("a view has columns and is a relation, and is still not an import target", () => {
    expect(targetNames(capabilities)).toEqual(["orders"]);
  });

  test("the engine-wide inline-row-edit flag does not withhold a target", () => {
    // MongoDB, Couchbase and Cassandra declare it false while declaring a kind that takes
    // row writes, so conjoining the two would refuse an import all three engines support
    // (standing ruling 4).
    const noInlineEdit = { ...capabilities, supportsInlineRowEdit: false } as ProviderCapabilities;
    expect(targetNames(noInlineEdit)).toEqual(["orders"]);
  });

  test("with no declaration yet, every entry is still a target", () => {
    expect(targetNames(undefined)).toEqual(["orders", "order_summary", "order_total"]);
  });
});

// =============================================================================
// The target an import is pointed at is an ADDRESS (#789, Task 36)
// =============================================================================

describe("DataImportModal target addressing", () => {
  afterEach(() => {
    cleanup();
  });

  // The live SQL Server on 1433 holds both of these. Keyed on the label, the two options
  // carried one React key and one value, and the INSERT named a bare `customers` that the
  // session default container answers.
  const namesakes: DetailedObject[] = [
    { name: "customers", kind: "table", path: ["libredb_objects", "app", "customers"], columns: [], indexes: [] },
    { name: "customers", kind: "table", path: ["shop", "dbo", "customers"], columns: [], indexes: [] },
  ];
  const mssqlCapabilities = {
    queryLanguage: "sql",
    defaultPort: 1433,
    objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables", acceptsRowWrites: true }],
  } as unknown as ProviderCapabilities;

  function generatedFor(value: string): string {
    const onImport = mock((_sql: string) => {});
    const { baseElement } = render(
      <DataImportModal
        isOpen
        onClose={noop}
        onImport={onImport}
        tables={namesakes}
        databaseType="mssql"
        capabilities={mssqlCapabilities}
      />,
    );
    act(() => simulateFileUpload(baseElement, "id,email\n1,a@example.com", "data.csv"));
    act(() => fireEvent.click(within(baseElement).getByText("Configure Import")));
    const select = within(baseElement).getByLabelText("Select Table") as HTMLSelectElement;
    act(() => fireEvent.change(select, { target: { value } }));
    act(() => fireEvent.click(within(baseElement).getByText("Review SQL")));
    return baseElement.querySelector("pre")?.textContent ?? "";
  }

  test("each option is VALUED by its address and LABELLED by its name", () => {
    const { baseElement } = render(
      <DataImportModal isOpen onClose={noop} onImport={noop} tables={namesakes} capabilities={mssqlCapabilities} />,
    );
    act(() => simulateFileUpload(baseElement, "id,email\n1,a@example.com", "data.csv"));
    act(() => fireEvent.click(within(baseElement).getByText("Configure Import")));
    const select = within(baseElement).getByLabelText("Select Table") as HTMLSelectElement;
    const options = Array.from(select.options).filter((option) => option.value !== "");
    expect(options.map((option) => option.value)).toEqual([
      pathKey(["libredb_objects", "app", "customers"]),
      pathKey(["shop", "dbo", "customers"]),
    ]);
    expect(options.map((option) => option.textContent)).toEqual(["customers", "customers"]);
  });

  test("the SECOND namesake is the one written", () => {
    const sql = generatedFor(pathKey(["shop", "dbo", "customers"]));
    expect(sql).toContain("INSERT INTO shop.dbo.customers (id, email)");
    expect(sql).not.toContain("libredb_objects");
  });

  test("the FIRST namesake is still reachable, which is the control", () => {
    const sql = generatedFor(pathKey(["libredb_objects", "app", "customers"]));
    expect(sql).toContain("INSERT INTO libredb_objects.app.customers (id, email)");
    expect(sql).not.toContain("shop.dbo");
  });

  test("the ready step names the selected object by its address", () => {
    const { baseElement } = render(
      <DataImportModal
        isOpen
        onClose={noop}
        onImport={noop}
        tables={namesakes}
        databaseType="mssql"
        capabilities={mssqlCapabilities}
      />,
    );
    act(() => simulateFileUpload(baseElement, "id,email\n1,a@example.com", "data.csv"));
    act(() => fireEvent.click(within(baseElement).getByText("Configure Import")));
    const select = within(baseElement).getByLabelText("Select Table") as HTMLSelectElement;
    act(() => fireEvent.change(select, { target: { value: pathKey(["shop", "dbo", "customers"]) } }));
    act(() => fireEvent.click(within(baseElement).getByText("Review SQL")));
    expect(baseElement.textContent).toContain("1 rows into shop.dbo.customers");
  });
});
