import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import React from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { RowDetailSheet } from "@/components/results-grid/RowDetailSheet";

// The insecure-context harness, as in tests/components/copy-button.test.tsx: an absent
// `navigator.clipboard` is what plain HTTP off loopback actually hands the page, and an
// editing command that answers false is what a browser that refuses the copy does.
const originalExecCommand = Object.getOwnPropertyDescriptor(globalThis.document, "execCommand");

function setExecCommand(execCommand: ((command: string) => boolean) | undefined): void {
  Object.defineProperty(globalThis.document, "execCommand", { value: execCommand, configurable: true });
}

function refuseEveryWritePath(): void {
  Object.defineProperty(globalThis.navigator, "clipboard", { value: undefined, configurable: true });
  setExecCommand(() => false);
}

mock.module("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? React.createElement("div", { "data-testid": "sheet" }, children) : null,
  // The className is forwarded because the panel's own height cap is asserted below:
  // a double that drops it makes the real element's sizing unobservable.
  SheetContent: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement("div", { "data-testid": "sheet-content", className }, children),
  SheetHeader: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
  SheetTitle: ({ children }: { children: React.ReactNode }) => React.createElement("h2", {}, children),
}));

mock.module("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => React.createElement("div", {}, children),
}));

mock.module("@/lib/data-masking", () => ({
  maskValueByPattern: (value: unknown) => {
    void value;
    return "***MASKED***";
  },
}));

describe("results-grid/RowDetailSheet", () => {
  const writeText = mock(async (text: string) => {
    void text;
  });

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    if (originalExecCommand === undefined) setExecCommand(undefined);
    else Object.defineProperty(globalThis.document, "execCommand", originalExecCommand);
  });

  test("does not render when closed", () => {
    const { queryByTestId } = render(
      <RowDetailSheet
        row={{ id: 1, email: "a@b.com" }}
        fields={["id", "email"]}
        isOpen={false}
        onClose={mock(() => {})}
        rowIndex={0}
      />,
    );
    expect(queryByTestId("sheet")).toBeNull();
  });

  test("copies raw json when masking is not active", () => {
    const { queryByText } = render(
      <RowDetailSheet
        row={{ id: 1, email: "alice@example.com" }}
        fields={["id", "email"]}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
      />,
    );

    fireEvent.click(queryByText("Copy JSON")!);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0]?.[0])).toContain("alice@example.com");
  });

  test("copies masked json when masking is active", () => {
    const sensitiveColumns = new Map<string, unknown>([["email", { type: "email" }]]);
    const { queryByText } = render(
      <RowDetailSheet
        row={{ id: 1, email: "alice@example.com" }}
        fields={["id", "email"]}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
        maskingActive
        sensitiveColumns={sensitiveColumns as never}
      />,
    );

    fireEvent.click(queryByText("Copy JSON")!);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0]?.[0])).toContain("***MASKED***");
  });

  test("shows masked value and reveals when reveal button is clicked", () => {
    const sensitiveColumns = new Map<string, unknown>([["email", { type: "email" }]]);
    const { queryByText, queryByTitle } = render(
      <RowDetailSheet
        row={{ id: 1, email: "alice@example.com" }}
        fields={["id", "email"]}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
        maskingActive
        sensitiveColumns={sensitiveColumns as never}
        allowReveal
      />,
    );

    expect(queryByText("***MASKED***")).not.toBeNull();

    fireEvent.click(queryByTitle("Reveal value (10s)")!);
    expect(queryByText("alice@example.com")).not.toBeNull();
  });

  test("displays Row #N header with correct 1-based index", () => {
    const { queryByText } = render(
      <RowDetailSheet row={{ id: 1 }} fields={["id"]} isOpen onClose={mock(() => {})} rowIndex={4} />,
    );
    expect(queryByText("Row #5")).not.toBeNull();
  });

  test("copies individual field value to clipboard", () => {
    const { container } = render(
      <RowDetailSheet
        row={{ id: 1, name: "Alice" }}
        fields={["id", "name"]}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
      />,
    );

    // Each field row has a copy button; get all ghost buttons (copy buttons)
    const buttons = Array.from(container.querySelectorAll("button"));
    // The last button per field row is the copy button; skip the "Copy JSON" button (first button)
    const copyButtons = buttons.filter(
      (b) => !b.textContent?.includes("Copy JSON") && !b.textContent?.includes("Copied"),
    );
    // Click the second copy button (for "name" field)
    fireEvent.click(copyButtons[1]!);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0]?.[0])).toBe("Alice");
  });

  test("shows check icon after copying a field value", async () => {
    const { container } = render(
      <RowDetailSheet
        row={{ id: 1, name: "Bob" }}
        fields={["id", "name"]}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
      />,
    );

    const buttons = Array.from(container.querySelectorAll("button"));
    const copyButtons = buttons.filter(
      (b) => !b.textContent?.includes("Copy JSON") && !b.textContent?.includes("Copied"),
    );
    // Click the first copy button (for "id" field)
    fireEvent.click(copyButtons[0]!);

    // After copy, the Check icon (success token) should replace the Copy icon
    await waitFor(() => expect(container.querySelector(".text-success")).not.toBeNull());
  });

  // B43: both of these labels used to flip in the same statement that started the write,
  // so on the plain-HTTP channels this product ships on they reported a copy that never
  // happened. The refusal below is the real one: no clipboard object at all, and an
  // editing command that answers false.
  test("field copy shows no check icon when both write paths refuse", async () => {
    refuseEveryWritePath();
    const { container } = render(
      <RowDetailSheet
        row={{ id: 1, name: "Bob" }}
        fields={["id", "name"]}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
      />,
    );

    const copyButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) => !b.textContent?.includes("Copy JSON"),
    );
    fireEvent.click(copyButtons[0]!);

    await waitFor(() => expect(container.querySelector(".text-warning")).not.toBeNull());
    expect(container.querySelector(".text-success")).toBeNull();
  });

  test("Copy JSON says Copied once the write has reported one", async () => {
    const { getByTestId, queryByText } = render(
      <RowDetailSheet
        row={{ id: 1, email: "alice@example.com" }}
        fields={["id", "email"]}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
      />,
    );

    fireEvent.click(queryByText("Copy JSON")!);

    await waitFor(() => expect(getByTestId("sheet-content").textContent).toContain("Copied"));
    expect(getByTestId("sheet-content").textContent).not.toContain("Copy failed");
  });

  test("Copy JSON does not say Copied when both write paths refuse", async () => {
    refuseEveryWritePath();
    const { getByTestId, queryByText } = render(
      <RowDetailSheet
        row={{ id: 1, email: "alice@example.com" }}
        fields={["id", "email"]}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
      />,
    );

    fireEvent.click(queryByText("Copy JSON")!);

    await waitFor(() => expect(getByTestId("sheet-content").textContent).toContain("Copy failed"));
    expect(queryByText("Copied")).toBeNull();
  });

  test("displays NULL for null and undefined values", () => {
    const { container } = render(
      <RowDetailSheet
        row={{ a: null, b: undefined }}
        fields={["a", "b"]}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
      />,
    );

    // null: typeof null === 'object' so JSON.stringify(null) => "null"
    // undefined: String(undefined ?? 'NULL') => "NULL"
    const valueElements = Array.from(container.querySelectorAll(".font-mono.break-all"));
    expect(valueElements.length).toBe(2);
    expect(valueElements[0]!.textContent).toBe("null");
    expect(valueElements[1]!.textContent).toBe("NULL");
  });

  // Replaces the old "displays JSON.stringify for object values" pin: #96
  // deliberately changes json-kind detail rendering from a compact one-liner
  // to a pretty-printed whitespace-preserving block.
  test("renders object values pretty-printed in a whitespace-preserving block", () => {
    const obj = { foo: "bar", nested: { n: 1 } };
    const { container } = render(
      <RowDetailSheet row={{ data: obj }} fields={["data"]} isOpen onClose={mock(() => {})} rowIndex={0} />,
    );

    const block = container.querySelector(".whitespace-pre-wrap");
    expect(block).not.toBeNull();
    expect(block!.textContent).toBe(JSON.stringify(obj, null, 2));
    // Newlines and indentation survive into the DOM text.
    expect(block!.textContent).toContain('{\n  "foo"');
    expect(block!.className).toContain("font-mono");
  });

  test("renders a JSON container string parsed and pretty-printed", () => {
    const raw = '{"id":"1","name":"Ada"}';
    const { container } = render(
      <RowDetailSheet row={{ value: raw }} fields={["value"]} isOpen onClose={mock(() => {})} rowIndex={0} />,
    );

    const block = container.querySelector(".whitespace-pre-wrap");
    expect(block).not.toBeNull();
    expect(block!.textContent).toBe(JSON.stringify(JSON.parse(raw), null, 2));
  });

  test("scalar fields keep the inline rendering without a whitespace-preserving block", () => {
    const { container, queryByText } = render(
      <RowDetailSheet
        row={{ id: 7, name: "Alice" }}
        fields={["id", "name"]}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
      />,
    );

    expect(queryByText("Alice")).not.toBeNull();
    expect(queryByText("7")).not.toBeNull();
    expect(container.querySelector(".whitespace-pre-wrap")).toBeNull();
  });

  test("masking short-circuits before renderer selection for json-kind fields", () => {
    const sensitiveColumns = new Map<string, unknown>([["payload", { type: "custom" }]]);
    const { container, queryByText } = render(
      <RowDetailSheet
        row={{ payload: { secret: "top" } }}
        fields={["payload"]}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
        maskingActive
        sensitiveColumns={sensitiveColumns as never}
      />,
    );

    expect(queryByText("***MASKED***")).not.toBeNull();
    // The masked field must not reach the json renderer's pretty block.
    expect(container.querySelector(".whitespace-pre-wrap")).toBeNull();
    expect(container.textContent).not.toContain("top");
  });

  test("copying a json field copies the pretty-printed text", () => {
    const obj = { foo: "bar" };
    const { container } = render(
      <RowDetailSheet row={{ data: obj }} fields={["data"]} isOpen onClose={mock(() => {})} rowIndex={0} />,
    );

    const buttons = Array.from(container.querySelectorAll("button"));
    const copyButtons = buttons.filter(
      (b) => !b.textContent?.includes("Copy JSON") && !b.textContent?.includes("Copied"),
    );
    fireEvent.click(copyButtons[0]!);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0]?.[0])).toBe(JSON.stringify(obj, null, 2));
  });

  test("renders long values (>50 chars) with smaller text class", () => {
    const longValue = "A".repeat(60);
    const { container } = render(
      <RowDetailSheet
        row={{ description: longValue }}
        fields={["description"]}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
      />,
    );

    // The value element should have both font-mono break-all (base) and text-xs (long value)
    const valueElement = container.querySelector(".font-mono.break-all.text-xs");
    expect(valueElement).not.toBeNull();
    expect(valueElement!.textContent).toBe(longValue);
  });

  test("reveal button auto-hides field after timeout", () => {
    const sensitiveColumns = new Map<string, unknown>([["email", { type: "email" }]]);
    const { queryByText, queryByTitle } = render(
      <RowDetailSheet
        row={{ email: "secret@example.com" }}
        fields={["email"]}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
        maskingActive
        sensitiveColumns={sensitiveColumns as never}
        allowReveal
      />,
    );

    // Initially masked
    expect(queryByText("***MASKED***")).not.toBeNull();

    // Mock setTimeout AFTER render to avoid breaking React internals
    const origSetTimeout = globalThis.setTimeout;
    let capturedCallback: (() => void) | null = null;
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
      if (ms === 10000) {
        capturedCallback = fn as () => void;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return origSetTimeout(fn, ms);
    }) as typeof setTimeout;

    // Reveal the field
    fireEvent.click(queryByTitle("Reveal value (10s)")!);
    expect(queryByText("secret@example.com")).not.toBeNull();

    // The timeout callback should have been captured
    expect(capturedCallback).not.toBeNull();

    // Execute the timeout callback to auto-hide
    act(() => {
      capturedCallback!();
    });

    // Field should be masked again
    expect(queryByText("***MASKED***")).not.toBeNull();

    globalThis.setTimeout = origSetTimeout;
  });

  test("renders all field name labels", () => {
    const fields = ["id", "username", "email", "created_at", "status"];
    const row: Record<string, unknown> = {};
    fields.forEach((f) => {
      row[f] = `val_${f}`;
    });

    const { queryByText } = render(
      <RowDetailSheet row={row} fields={fields} isOpen onClose={mock(() => {})} rowIndex={0} />,
    );

    for (const field of fields) {
      expect(queryByText(field)).not.toBeNull();
    }
  });

  test("raw JSON copy contains exact row data when no masking active", () => {
    const row = { id: 42, name: "Charlie", active: true, score: 99.5 };
    const { queryByText } = render(
      <RowDetailSheet
        row={row}
        fields={["id", "name", "active", "score"]}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
      />,
    );

    fireEvent.click(queryByText("Copy JSON")!);
    expect(writeText).toHaveBeenCalledTimes(1);
    const copiedJson = String(writeText.mock.calls[0]?.[0]);
    const parsed = JSON.parse(copiedJson);
    expect(parsed).toEqual(row);
  });

  // ── Layout on a wide window (#800) ────────────────────────────────────────

  describe("layout", () => {
    function fieldList(container: HTMLElement): HTMLElement {
      const label = Array.from(container.querySelectorAll("p")).find((el) => el.textContent === "col_01")!;
      return label.parentElement!.parentElement!;
    }

    /**
     * The list is read on a phone and on a 1440px window, and the single column that
     * suits the first wastes the second: a 40 field row scrolled for no reason. The
     * flow is asked for by column WIDTH, so the count follows the window with no
     * breakpoint deciding it - measured 2026-09-15 in the browser on a 40 field row as
     * 1 column at 390px and 768px, 2 at 834px and 1024px, 3 at 1280px and 1440px, 4 at
     * 1920px and 8 at 3840px. A breakpoint here is what the reported defect was made
     * of, so a class carrying one is a finding (#800).
     */
    test("the field list flows into as many columns as the window fits, without a breakpoint", () => {
      const { container } = render(
        <RowDetailSheet row={{ col_01: "a" }} fields={["col_01"]} isOpen onClose={mock(() => {})} rowIndex={0} />,
      );
      const classes = (fieldList(container).getAttribute("class") ?? "").split(/\s+/);
      expect(classes).toContain("columns-sm");
      expect(classes.filter((c) => /^(sm|md|lg|xl|2xl):/.test(c) || c === "hidden")).toEqual([]);

      // A flowed column would otherwise break between a field's name and its value,
      // leaving the two halves of one field in different columns.
      const label = Array.from(container.querySelectorAll("p")).find((el) => el.textContent === "col_01")!;
      expect((label.parentElement!.getAttribute("class") ?? "").split(/\s+/)).toContain("break-inside-avoid");
    });

    /**
     * Capped, not fixed. A six field row took 85% of the screen to show six lines and
     * hid the grid it came from behind it; a 200 field row still needs the whole cap.
     * Measured 2026-09-15 at 900px tall: 180px for six fields, 763px for 202 (#800).
     */
    test("the panel is capped at a share of the window rather than always filling it", () => {
      const { getByTestId } = render(
        <RowDetailSheet row={{ id: 1 }} fields={["id"]} isOpen onClose={mock(() => {})} rowIndex={0} />,
      );
      const classes = (getByTestId("sheet-content").getAttribute("class") ?? "").split(/\s+/);
      expect(classes).toContain("max-h-[85vh]");
      expect(classes.filter((c) => /^h-\[/.test(c))).toEqual([]);
    });

    test("the field name sits beside its value rather than above it", () => {
      const { container } = render(
        <RowDetailSheet row={{ col_01: "a" }} fields={["col_01"]} isOpen onClose={mock(() => {})} rowIndex={0} />,
      );
      const label = Array.from(container.querySelectorAll("p")).find((el) => el.textContent === "col_01")!;
      const value = Array.from(container.querySelectorAll("p")).find((el) => el.textContent === "a")!;
      // Same parent, and that parent lays its children out in a row.
      expect(value.parentElement).toBe(label.parentElement);
      expect((label.parentElement!.getAttribute("class") ?? "").split(/\s+/)).toContain("flex");
    });
  });
});
